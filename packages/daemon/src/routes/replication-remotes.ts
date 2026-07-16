import type { RemoteTestResult } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { RemotesPaths } from '../services/replication-remotes.js'
import type { ResolvedRemote, Transport } from '../services/replication-transport.js'
import { ReplicationTaskName, UpsertRemoteRequest } from '@anas/shared'
import {
  ensureKeypair,
  fingerprintOf,
  pinHostKey,
  readRemotes,
  scanHostKeys,
  writeRemotes,
} from '../services/replication-remotes.js'
import { resolvedRemoteFields } from '../services/replication-transport.js'
import { readAllTasks } from '../services/replication-units.js'
import { requireIdentity } from './identity.js'

/**
 * Stage-3 remotes registry routes (Epic 5.5.2) — the corosync-store CRUD +
 * connection diagnostics + target-picker feeds.
 *
 *   GET    /v1/replication/remotes            → { version, remotes, publicKey }
 *   POST   /v1/replication/remotes            → register (CAS; 409 on stale/dup)
 *   PUT    /v1/replication/remotes/:name      → upsert (CAS)
 *   DELETE /v1/replication/remotes/:name      → remove (CAS; 400 if a task uses it)
 *   POST   /v1/replication/remotes/test       → PRE-registration probe (host/port/user)
 *   POST   /v1/replication/remotes/:name/test → registered-remote probe (?pin=true)
 *   GET    /v1/replication/locations          → { peers, remotes } for the picker
 *   GET    /v1/replication/remotes/:name/pools→ remote zpool names (fail-open [])
 *   GET    /v1/replication/peers/:name/pools  → peer zpool names (fail-open [])
 *
 * Registry writes are COMPARE-AND-SWAP: the pre-check 409s on a stale version or
 * a duplicate name, and the write itself (inside the quick audit job, matching
 * the stage-2 pattern) re-CASes so a concurrent writer can never be clobbered.
 * Mutations are identity-gated and journald-audited via the job queue.
 */
export interface ReplicationRemotesRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** The corosync-store paths (registry / keypair / known_hosts). */
  paths: RemotesPaths
  /** Remote/peer SSH transport (resolution + remote zfs ops). */
  transport: Transport
  /** systemd unit dir — to check whether a TASK references a remote before delete. */
  systemdDir: string
}

/** ssh stderr that indicates an AUTH failure (vs an unreachable host). */
const AUTH_FAIL_RE = /permission denied|publickey|password|authentication/

function CONFLICT(version: number) {
  return {
    error: { code: 'CONFLICT', message: `remotes registry changed (version ${version}) — reload and retry` },
  }
}

export async function replicationRemotesRoutes(
  server: FastifyInstance,
  opts: ReplicationRemotesRouteOptions,
) {
  const { executor, jobQueue, paths, transport, systemdDir } = opts

  // --- GET /replication/remotes — registry + public key ---------------------
  server.get('/replication/remotes', async () => {
    const [reg, publicKey] = await Promise.all([
      readRemotes(paths),
      ensureKeypair(executor, paths),
    ])
    return { data: { version: reg.version, remotes: reg.remotes, publicKey } }
  })

  // --- POST /replication/remotes — register (CAS) ---------------------------
  server.post('/replication/remotes', async (request, reply) => {
    const parsed = UpsertRemoteRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote request: ${parsed.error.issues[0]?.message}` } }
    }
    const { remote, expectedVersion } = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const current = await readRemotes(paths)
    if (current.version !== expectedVersion) {
      reply.code(409)
      return CONFLICT(current.version)
    }
    if (current.remotes.some(r => r.name === remote.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Remote '${remote.name}' already exists` } }
    }

    const job = jobQueue.submit(
      'replication.remote.create',
      { ...identity, params: { remote: remote.name } },
      async () => {
        const written = await writeRemotes(paths, expectedVersion, [...current.remotes, remote])
        return { created: remote.name, version: written.version }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /replication/remotes/:name — upsert (CAS) ------------------------
  server.put<{ Params: { name: string } }>('/replication/remotes/:name', async (request, reply) => {
    const nameParsed = ReplicationTaskName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const parsed = UpsertRemoteRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote request: ${parsed.error.issues[0]?.message}` } }
    }
    const { remote, expectedVersion } = parsed.data
    if (remote.name !== name) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Remote name in body ('${remote.name}') does not match URL ('${name}')` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const current = await readRemotes(paths)
    if (current.version !== expectedVersion) {
      reply.code(409)
      return CONFLICT(current.version)
    }

    const next = current.remotes.some(r => r.name === name)
      ? current.remotes.map(r => (r.name === name ? remote : r))
      : [...current.remotes, remote]

    const job = jobQueue.submit(
      'replication.remote.update',
      { ...identity, params: { remote: name } },
      async () => {
        const written = await writeRemotes(paths, expectedVersion, next)
        return { updated: name, version: written.version }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /replication/remotes/:name?expectedVersion=N — remove (CAS) ----
  server.delete<{ Params: { name: string }, Querystring: { expectedVersion?: string } }>(
    '/replication/remotes/:name',
    async (request, reply) => {
      const nameParsed = ReplicationTaskName.safeParse(request.params.name)
      if (!nameParsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote name: ${nameParsed.error.issues[0]?.message}` } }
      }
      const name = nameParsed.data

      const rawVersion = request.query.expectedVersion
      const expectedVersion = rawVersion === undefined ? Number.NaN : Number(rawVersion)
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: 'DELETE requires a non-negative integer ?expectedVersion=N (the registry version you read)' } }
      }

      const identity = requireIdentity(request, reply)
      if (!identity)
        return

      const current = await readRemotes(paths)
      if (current.version !== expectedVersion) {
        reply.code(409)
        return CONFLICT(current.version)
      }
      if (!current.remotes.some(r => r.name === name)) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Remote '${name}' not found` } }
      }

      // Refuse while a replication TASK still targets this remote — deleting it
      // would strand the task's units pointing at an unknown remote.
      const tasks = await readAllTasks(systemdDir)
      const referencing = tasks.filter(
        t => t.target.location?.kind === 'remote' && t.target.location?.name === name,
      )
      if (referencing.length) {
        reply.code(400)
        return {
          error: {
            code: 'VALIDATION_ERROR',
            message: `Remote '${name}' is still used by replication task(s): ${referencing.map(t => t.name).join(', ')} — remove them first`,
          },
        }
      }

      const job = jobQueue.submit(
        'replication.remote.remove',
        { ...identity, params: { remote: name } },
        async () => {
          const written = await writeRemotes(paths, expectedVersion, current.remotes.filter(r => r.name !== name))
          return { removed: name, version: written.version }
        },
      )
      reply.code(202)
      return { job }
    },
  )

  // --- Test-connection: staged diagnosis ------------------------------------
  /**
   * Probe a remote in three stages, reporting WHAT failed (RemoteTestResult):
   *   1) host key known to our known_hosts? if not → keyscan → 'hostkey-unknown'
   *      + fingerprint (the UI confirms → re-run with pin to trust it).
   *   2) `ssh … true` → 'auth-failed' vs 'unreachable' (from stderr / exit).
   *   3) `ssh … zfs --version` → 'no-zfs' vs 'ok' + zfsVersion.
   */
  async function diagnose(host: string, port: number, resolved: ResolvedRemote, pin: boolean): Promise<RemoteTestResult> {
    let known = await fingerprintOf(paths, host, port)
    if (!known) {
      if (pin) {
        const fp = await pinHostKey(executor, paths, host, port)
        if (!fp)
          return { stage: 'unreachable', detail: 'ssh-keyscan returned no host key (host unreachable or port closed)' }
        known = fp
      }
      else {
        const keys = await scanHostKeys(executor, host, port)
        const chosen = keys.find(k => k.keyType === 'ssh-ed25519') ?? keys[0]
        if (!chosen)
          return { stage: 'unreachable', detail: 'ssh-keyscan returned no host key (host unreachable or port closed)' }
        return { stage: 'hostkey-unknown', fingerprint: chosen.fingerprint }
      }
    }

    const auth = await transport.sshExec(resolved, ['true'])
    if (auth.exitCode !== 0) {
      const err = (auth.stderr || '').toLowerCase()
      const authFailed = AUTH_FAIL_RE.test(err)
      return {
        stage: authFailed ? 'auth-failed' : 'unreachable',
        detail: auth.stderr.trim() || `ssh exited ${auth.exitCode}`,
        ...(known ? { fingerprint: known } : {}),
      }
    }

    const ver = await transport.sshExec(resolved, ['zfs', '--version'])
    if (ver.exitCode !== 0) {
      return {
        stage: 'no-zfs',
        detail: ver.stderr.trim() || `zfs --version exited ${ver.exitCode}`,
        ...(known ? { fingerprint: known } : {}),
      }
    }
    const zfsVersion = (ver.stdout.split('\n').find(l => l.trim()) ?? '').trim()
    return { stage: 'ok', zfsVersion, ...(known ? { fingerprint: known } : {}) }
  }

  /** Fire-and-forget audit job for a test-connection probe (journald record). */
  function auditTest(identity: NonNullable<ReturnType<typeof requireIdentity>>, params: Record<string, unknown>, result: RemoteTestResult): void {
    jobQueue.submit(
      'replication.remote.test',
      { ...identity, params },
      async () => ({ stage: result.stage }),
    )
  }

  // --- POST /replication/remotes/test — PRE-registration probe ---------------
  server.post<{ Querystring: { pin?: string } }>('/replication/remotes/test', async (request, reply) => {
    const body = (request.body ?? {}) as { host?: unknown, port?: unknown, user?: unknown }
    if (typeof body.host !== 'string' || !body.host) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: 'host is required' } }
    }
    const port = body.port === undefined ? 22 : Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: 'port must be an integer 1–65535' } }
    }
    const user = typeof body.user === 'string' && body.user ? body.user : 'root'

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const pin = request.query.pin === 'true'
    const resolved = resolvedRemoteFields(paths, body.host, port, user)
    const result = await diagnose(body.host, port, resolved, pin)
    auditTest(identity, { host: body.host, port, user, pin }, result)
    return { data: result }
  })

  // --- POST /replication/remotes/:name/test — registered-remote probe --------
  server.post<{ Params: { name: string }, Querystring: { pin?: string } }>(
    '/replication/remotes/:name/test',
    async (request, reply) => {
      const nameParsed = ReplicationTaskName.safeParse(request.params.name)
      if (!nameParsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote name: ${nameParsed.error.issues[0]?.message}` } }
      }
      const name = nameParsed.data

      const identity = requireIdentity(request, reply)
      if (!identity)
        return

      const reg = await readRemotes(paths)
      const remote = reg.remotes.find(r => r.name === name)
      if (!remote) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Remote '${name}' not found` } }
      }

      const pin = request.query.pin === 'true'
      const resolved = resolvedRemoteFields(paths, remote.host, remote.port, remote.user)
      const result = await diagnose(remote.host, remote.port, resolved, pin)
      auditTest(identity, { remote: name, pin }, result)
      return { data: result }
    },
  )

  // --- GET /replication/locations — target picker feed ----------------------
  server.get('/replication/locations', async () => {
    const [peers, reg] = await Promise.all([transport.listPeers(), readRemotes(paths)])
    return { data: { peers, remotes: reg.remotes.map(r => r.name) } }
  })

  // --- GET /replication/remotes/:name/pools — remote zpool names ------------
  server.get<{ Params: { name: string } }>('/replication/remotes/:name/pools', async (request, reply) => {
    const nameParsed = ReplicationTaskName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const reg = await readRemotes(paths)
    const remote = reg.remotes.find(r => r.name === nameParsed.data)
    if (!remote) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Remote '${nameParsed.data}' not found` } }
    }
    const resolved = resolvedRemoteFields(paths, remote.host, remote.port, remote.user)
    return { data: await transport.remotePoolNames(resolved) }
  })

  // --- GET /replication/peers/:name/pools — peer zpool names ----------------
  server.get<{ Params: { name: string } }>('/replication/peers/:name/pools', async (request, reply) => {
    const name = request.params.name
    const res = await transport.resolveLocation({ kind: 'peer', name })
    if (!res.ok) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: res.error } }
    }
    return { data: await transport.remotePoolNames(res.resolved) }
  })
}
