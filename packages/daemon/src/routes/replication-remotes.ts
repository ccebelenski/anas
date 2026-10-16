import type { RemoteTestResult } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { RemotesPaths } from '../services/replication-remotes.js'
import type { ResolvedRemote, Transport } from '../services/replication-transport.js'
import { readFile } from 'node:fs/promises'
import { ReplicationTaskName, TestRemoteRequest, UpsertRemoteRequest } from '@anas/shared'
import { GuardRefusalError } from '../safety/guard.js'
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
 *                                                (publicKey '' until one exists)
 *   POST   /v1/replication/remotes/keypair    → create the cluster key (202 job, cr.62)
 *   POST   /v1/replication/remotes            → register (CAS; 409 on stale/dup)
 *   PUT    /v1/replication/remotes/:name      → upsert (CAS)
 *   DELETE /v1/replication/remotes/:name      → remove (CAS; 400 if a task uses it)
 *   POST   /v1/replication/remotes/test       → PRE-registration probe (host/port/user)
 *   POST   /v1/replication/remotes/:name/test → registered-remote probe (?pin=true)
 *   GET    /v1/replication/locations          → { peers, remotes } for the picker
 *   GET    /v1/replication/remotes/:name/pools→ remote zpool names (fail-open [])
 *   GET    /v1/replication/peers/:name/pools  → peer zpool names (fail-open [])
 *
 * Both probes take ?pin=true (trust a first-contact key) and ?retrust=true
 * (REPLACE the pinned key of a host whose key changed — the rebuilt/rekeyed
 * remote). They are separate flags on purpose: an ordinary pin can never
 * overwrite an existing pin, and a re-trust is only ever sent after the operator
 * has been shown the old and the new fingerprint.
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

/**
 * ssh stderr that means THE PINNED KEY NO LONGER MATCHES — the host answered,
 * presented a host key, and it is not the one we trust. OpenSSH says this two
 * ways depending on the key type and options; both are the same fact.
 */
const HOSTKEY_CHANGED_RE = /remote host identification has changed|host key verification failed/

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
  // A pure read (cr.62, review L9). It used to CREATE the cluster keypair
  // (`ssh-keygen` → /etc/pve/priv/anas/replication_key) when none existed, so a
  // Sys.Audit login — or a cross-site navigation riding PVE's Lax cookie, which
  // needs no CSRF token — picked the moment a private key was written. The key
  // is now read if it is there and '' when it is not; creating it is the POST
  // below (Sys.Modify, CSRF, a job).
  server.get('/replication/remotes', async () => {
    const [reg, publicKey] = await Promise.all([
      readRemotes(paths),
      readFile(`${paths.keyPath}.pub`, 'utf-8').then(t => t.trim(), () => ''),
    ])
    return { data: { version: reg.version, remotes: reg.remotes, publicKey } }
  })

  // --- POST /replication/remotes/keypair — create the cluster key (cr.62) ----
  // The act the GET above used to perform, as a mutation: idempotent (an
  // existing key is never regenerated — ensureKeypair checks first, again in
  // the job), journald-audited through the queue, and the job's result is the
  // public key. The Remotes window offers it when the GET answered no key.
  server.post('/replication/remotes/keypair', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return
    const job = jobQueue.submit(
      'replication.keypair.create',
      { ...identity, params: {} },
      async () => ({ publicKey: await ensureKeypair(executor, paths) }),
    )
    reply.code(202)
    return { job }
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
          // cr.41: the referencing-task check re-runs in the job — a task
          // created after the route's check must not be stranded on a removed
          // remote. Same sentence and code as the route, so the job fails like
          // the 400 the route would have answered.
          const tasks = await readAllTasks(systemdDir)
          const referencing = tasks.filter(
            t => t.target.location?.kind === 'remote' && t.target.location?.name === name,
          )
          if (referencing.length) {
            throw new GuardRefusalError({
              status: 400,
              code: 'VALIDATION_ERROR',
              message: `Remote '${name}' is still used by replication task(s): ${referencing.map(t => t.name).join(', ')} — remove them first`,
            })
          }
          const written = await writeRemotes(paths, expectedVersion, current.remotes.filter(r => r.name !== name))
          return { removed: name, version: written.version }
        },
      )
      reply.code(202)
      return { job }
    },
  )

  // --- Test-connection: staged diagnosis ------------------------------------
  /** How a probe is allowed to touch the pinned host key. */
  interface PinIntent {
    /** Trust a host we have NOTHING pinned for yet (first contact). */
    pin: boolean
    /**
     * REPLACE the pinned key for a host whose key CHANGED. Deliberate and
     * separate from `pin`: the client asks for it only after the operator has
     * been shown the old and the new fingerprint and confirmed. Never implied.
     */
    retrust: boolean
  }

  /**
   * Probe a remote in three stages, reporting WHAT failed (RemoteTestResult):
   *   1) host key known to our known_hosts? if not → keyscan → 'hostkey-unknown'
   *      + fingerprint (the UI confirms → re-run with pin to trust it).
   *   2) `ssh … true` → 'auth-failed' vs 'unreachable' (from stderr / exit), or
   *      'hostkey-changed' when ssh says the presented key is not the pinned one
   *      (rebuilt/rekeyed remote — repairable through the explicit re-trust flow
   *      rather than by hand-editing known_hosts).
   *   3) `ssh … zfs --version` → 'no-zfs' vs 'ok' + zfsVersion.
   */
  async function diagnose(host: string, port: number, resolved: ResolvedRemote, intent: PinIntent): Promise<RemoteTestResult> {
    let known = await fingerprintOf(paths, host, port)
    if (known && intent.retrust) {
      // Deliberate re-trust: swap the stale pin for what the host presents now.
      // A scan that comes back empty changes nothing (pinHostKey leaves the file
      // alone), so a flaky network cannot silently un-trust a good remote.
      const fp = await pinHostKey(executor, paths, host, port, { replace: true })
      if (!fp)
        return { stage: 'unreachable', detail: 'ssh-keyscan returned no host key (host unreachable or port closed)', knownFingerprint: known }
      known = fp
    }
    if (!known) {
      if (intent.pin || intent.retrust) {
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
      const detail = auth.stderr.trim() || `ssh exited ${auth.exitCode}`
      if (HOSTKEY_CHANGED_RE.test(err)) {
        // The host answered with a key that is not ours. Report it as its own
        // stage carrying BOTH fingerprints — pinned and presented — so the UI
        // can ask for a real decision instead of showing a permanent
        // 'unreachable' whose only cure is editing known_hosts by hand.
        const keys = await scanHostKeys(executor, host, port)
        const chosen = keys.find(k => k.keyType === 'ssh-ed25519') ?? keys[0]
        return {
          stage: 'hostkey-changed',
          detail,
          knownFingerprint: known,
          ...(chosen ? { fingerprint: chosen.fingerprint } : {}),
        }
      }
      const authFailed = AUTH_FAIL_RE.test(err)
      return {
        stage: authFailed ? 'auth-failed' : 'unreachable',
        detail,
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

  /** The pin intent a test request carries (?pin=true / ?retrust=true). */
  function pinIntent(query: { pin?: string, retrust?: string }): PinIntent {
    return { pin: query.pin === 'true', retrust: query.retrust === 'true' }
  }

  /**
   * Mirror the PINNED fingerprint onto the registry row so the Remotes grid can
   * show the real key. known_hosts stays the source of truth; this is the
   * readable copy, refreshed whenever a probe resolved what is actually pinned
   * (the stages that report a not-yet-trusted key are excluded — nothing is
   * pinned then). Best-effort by contract: a CAS conflict or write failure is
   * swallowed, because a diagnostic probe must never fail on bookkeeping.
   */
  async function mirrorFingerprint(name: string, result: RemoteTestResult): Promise<void> {
    if (!result.fingerprint || result.stage === 'hostkey-unknown' || result.stage === 'hostkey-changed')
      return
    try {
      const reg = await readRemotes(paths)
      const row = reg.remotes.find(r => r.name === name)
      if (!row || row.hostKeyFingerprint === result.fingerprint)
        return
      await writeRemotes(
        paths,
        reg.version,
        reg.remotes.map(r => (r.name === name ? { ...r, hostKeyFingerprint: result.fingerprint } : r)),
      )
    }
    catch {
      // Another node moved the registry, or the store is unwritable — the probe
      // result is still correct and known_hosts is still authoritative.
    }
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
  // Body parsed by the shared TestRemoteRequest (C1, review 2026-10-14): the
  // old hand-rolled typeof checks accepted a user of `-oProxyCommand=<cmd>`,
  // which the ssh transport then handed to ssh as an OPTION — root command
  // execution. RemoteUser/RemoteHost refuse it; buildSshArgv's `--` is the
  // second line of defence.
  server.post<{ Querystring: { pin?: string, retrust?: string } }>('/replication/remotes/test', async (request, reply) => {
    const parsed = TestRemoteRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid test request: ${parsed.error.issues[0]?.message}` } }
    }
    const { host, port, user } = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const intent = pinIntent(request.query)
    const resolved = resolvedRemoteFields(paths, host, port, user)
    const result = await diagnose(host, port, resolved, intent)
    auditTest(identity, { host, port, user, ...intent }, result)
    return { data: result }
  })

  // --- POST /replication/remotes/:name/test — registered-remote probe --------
  server.post<{ Params: { name: string }, Querystring: { pin?: string, retrust?: string } }>(
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

      const intent = pinIntent(request.query)
      const resolved = resolvedRemoteFields(paths, remote.host, remote.port, remote.user)
      const result = await diagnose(remote.host, remote.port, resolved, intent)
      await mirrorFingerprint(name, result)
      auditTest(identity, { remote: name, ...intent }, result)
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
