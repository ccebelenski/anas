import type { SmbConnection, SmbShareDetail } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { SelfServiceKeys } from '../parsers/smb-conf.js'
import type { ConfirmStore } from '../safety/confirm.js'
import { statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { CreateSmbShareRequest, ShareName, UpdateSmbGlobalConfigRequest, UpdateSmbShareRequest } from '@anas/shared'
import { addShare, customVfsRefusal, getShare, hasCustomVfsObjects, hasShare, parseSmbConf, removeShare, updateGlobal, updateShare } from '../parsers/smb-conf.js'
import { parseSmbStatusJson, parseSmbStatusText } from '../parsers/smbstatus.js'
import { confirmGate } from '../safety/gate.js'
import { ConfigConflictError, editConfig, readConfig } from '../services/config-writer.js'
import { loadPveFootprint } from '../services/pve-footprint.js'
import { enablingSelfService, ensureAhrSnapshotsMount, resolveSelfService, touchesSelfService } from '../services/share-selfservice.js'
import { requireIdentity } from './identity.js'

const SMBSTATUS = '/usr/bin/smbstatus'
const SYSTEMCTL = '/usr/bin/systemctl'
const TESTPARM = '/usr/bin/testparm'

/**
 * Read-time staleness check for a share's backing path (Principle 7 — the
 * filesystem is the source of truth; nothing is cached). Returns:
 *   true      — the path exists,
 *   false     — the path is confirmed missing (ENOENT / ENOTDIR): the share is
 *               stale, its storage is gone,
 *   undefined — unknown: any other stat failure (EACCES, EIO, …) FAILS OPEN so
 *               a healthy share is never mislabelled stale.
 */
export function pathExists(path: string): boolean | undefined {
  try {
    statSync(path)
    return true
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return false
    return undefined
  }
}

export interface SmbShareRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  /** Absolute path to smb.conf (config IS the API — Principle 13). */
  smbConfPath: string
  /** /etc/fstab — the AHR `@snapshots` mounts Previous Versions writes (smbsvc.1). */
  fstabPath: string
  /** systemd unit dir — the snapshot schedule store the bucket is picked from. */
  systemdDir: string
}

export async function smbShareRoutes(
  server: FastifyInstance,
  opts: SmbShareRouteOptions,
) {
  const { executor, jobQueue, confirmStore, smbConfPath, fstabPath, systemdDir } = opts

  /** Read smb.conf fresh every time — the file is the source of truth (P.11). */
  async function readSmbConf(): Promise<string> {
    return readConfig(smbConfPath)
  }

  /**
   * The testparm gate (smbsvc.1): every smb.conf write this route makes is
   * validated with `testparm -s` BEFORE the file is touched — the candidate
   * text is parsed from a temp copy, and a failure throws inside
   * `editConfig`'s transform, so nothing is ever written and the previous
   * bytes stand (byte-identical rollback by construction, not by restore).
   * Runs inside the per-file lock.
   */
  async function testparmGate(candidate: string): Promise<void> {
    const tmp = `${smbConfPath}.anas-testparm.tmp`
    await writeFile(tmp, candidate, 'utf8')
    try {
      const r = await executor.exec(TESTPARM, ['-s', tmp])
      if (r.exitCode !== 0) {
        throw new Error(`smb.conf failed testparm validation — the change was not applied: `
          + `${r.stderr.trim() || `testparm exited with code ${r.exitCode}`}`)
      }
    }
    finally {
      await rm(tmp, { force: true })
    }
  }

  /** Edit smb.conf under the lock, testparm-validating the candidate first. */
  async function editSmbConf(transform: (current: string) => string): Promise<void> {
    await editConfig(smbConfPath, async (current) => {
      const next = transform(current)
      await testparmGate(next)
      return next
    })
  }

  /**
   * Live connections keyed by share (service), from smbstatus (JSON first).
   *
   * FAIL-OPEN, never throws: smbstatus ships in the `samba` package, and
   * execFile REJECTS (rather than returning an exit code) when the binary is
   * missing, so on a node without samba this would otherwise 500 the share
   * detail view (issue #6). No smbstatus means no reportable connections.
   */
  async function connectionsByShare(): Promise<Record<string, SmbConnection[]>> {
    try {
      const json = await executor.exec(SMBSTATUS, ['--json'])
      if (json.exitCode === 0 && json.stdout.trim().startsWith('{')) {
        try {
          return parseSmbStatusJson(json.stdout)
        }
        catch {
          // Fall through to the text parser below.
        }
      }
      const text = await executor.exec(SMBSTATUS, ['-S'])
      if (text.exitCode === 0 && text.stdout.trim())
        return parseSmbStatusText(text.stdout)
      return {}
    }
    catch {
      return {}
    }
  }

  /** Live connections for a given share, from smbstatus (JSON preferred). */
  async function connectionsFor(shareName: string): Promise<SmbConnection[]> {
    return (await connectionsByShare())[shareName] ?? []
  }

  /** Every live connection across all shares (for global-change impact). */
  async function allConnections(): Promise<SmbConnection[]> {
    const byShare = await connectionsByShare()
    return Object.values(byShare).flat()
  }

  /** Reload smbd so the config change takes effect (side effect of the job). */
  async function reloadSmbd(): Promise<void> {
    const r = await executor.exec(SYSTEMCTL, ['reload', 'smbd'])
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `systemctl reload smbd exited with code ${r.exitCode}`)
  }

  /** Order-insensitive equality for the interface list (a reorder is a no-op). */
  function sameStringList(a: string[], b: string[]): boolean {
    if (a.length !== b.length)
      return false
    const setB = new Set(b)
    return a.every(v => setB.has(v))
  }

  /** Map a ConfigConflictError raised in a job into a clear job error. */
  function asJobError(err: unknown): Error {
    if (err instanceof ConfigConflictError)
      return new Error(`smb.conf changed on disk during the operation — retry against the current state`)
    return err instanceof Error ? err : new Error(String(err))
  }

  /**
   * The self-service fast path (smbsvc.1): refuse 400 with the sentence when
   * the request cannot be honoured against the CURRENT state — a custom
   * `vfs objects` line on the share being enabled onto, a path that is
   * neither ZFS nor AHR, a flat-layout AHR pool. The JOB re-resolves (the
   * same fast-path + in-job re-check pattern the ownership guards use), so
   * this is the zero-cost UI-explained refusal, not the only gate.
   */
  async function refuseSelfService(
    name: string,
    path: string,
    req: CreateSmbShareRequest | UpdateSmbShareRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    if (!touchesSelfService(req))
      return false
    if (enablingSelfService(req)) {
      const share = getShare(await readSmbConf(), name)
      if (share && hasCustomVfsObjects(share)) {
        reply.code(400)
        reply.send({ error: { code: 'VALIDATION_ERROR', message: customVfsRefusal(name) } })
        return true
      }
    }
    try {
      await resolveSelfService(executor, path, req, { systemdDir })
      return false
    }
    catch (err) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } })
      return true
    }
  }

  /**
   * Run the self-service side of a share mutation inside the job: resolve
   * against fresh state (a refusal here FAILS the job with the same
   * sentence), ensure the AHR `@snapshots` mount BEFORE the stanza lands
   * (a mount failure must not leave a stanza pointing at nothing), and edit
   * smb.conf through the composer with the resolved keys.
   */
  async function applySelfServiceAndEdit(
    name: string,
    path: string,
    req: CreateSmbShareRequest | UpdateSmbShareRequest,
    edit: (current: string, keys: SelfServiceKeys | undefined) => string,
  ): Promise<void> {
    if (!touchesSelfService(req)) {
      await editSmbConf(current => edit(current, undefined))
      return
    }
    const resolution = await resolveSelfService(executor, path, req, { systemdDir })
    if (resolution?.ahrPool)
      await ensureAhrSnapshotsMount(executor, fstabPath, resolution.ahrPool)
    await editSmbConf(current => edit(current, resolution?.keys))
  }

  /**
   * The share-path backstop (pvepool.1 review fixes): refuse a share whose
   * `path` is PVE's. The ONE footprint service answers {@link sharePathClaim}:
   * the path resolves onto an OWNED dataset (a storage root, a guest volume,
   * a dir-storage tree or the boot tree — refused 400 with the reason, which
   * names the storage AND the dataset), or it sits under a `dir` storage's
   * CONFIGURED path on a ZFS filesystem whose dataset could not be resolved (a
   * `legacy`/`none` dataset with no live mount — refused against the path
   * itself, the same rule mounts and restore use; pvepool.1 review fix 5). A
   * dir-storage path on a NON-ZFS filesystem (e.g. `/var/lib/vz` on the ext4
   * root) is allowed — caveat emptor (EPICS §2, ruled 2026-09-22). A path on a
   * SIBLING dataset's mountpoint (or a subdirectory of one) is ordinary ANAS
   * storage and passes untouched.
   */
  async function refuseOwnedSharePath(path: string, reply: FastifyReply): Promise<boolean> {
    const pve = await loadPveFootprint(executor)
    const claim = pve.sharePathClaim(path)
    if (!claim)
      return false
    reply.code(400)
    if (claim.kind === 'dataset')
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Share path '${path}' is on '${claim.dataset}', which is PVE-owned — ${claim.ownership.reason}` } })
    else
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Share path '${path}' is inside '${claim.path}', a path PVE storage '${claim.storage}' claims — shares cannot serve PVE territory` } })
    return true
  }

  // --- GET /shares/smb — ALL shares (incl. admin-created, Principle 11) -----
  server.get('/shares/smb', async () => {
    const text = await readSmbConf()
    // Stat each share's path at read time to surface stale definitions whose
    // storage no longer exists (pathExists=false). Fail-open per share.
    const shares = parseSmbConf(text).shares.map(share => ({
      ...share,
      pathExists: pathExists(share.path),
    }))
    return { data: shares }
  })

  // --- GET /shares/smb/global — SMB global config ---------------------------
  // Registered before the `:name` route; Fastify prioritises static paths anyway.
  server.get('/shares/smb/global', async () => {
    const text = await readSmbConf()
    return { data: parseSmbConf(text).global }
  })

  // --- PUT /shares/smb/global — update [global] -----------------------------
  server.put('/shares/smb/global', async (request, reply) => {
    const bodyParsed = UpdateSmbGlobalConfigRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid global config update: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Guard only the disruptive change: retargeting which interfaces/addresses
    // smbd binds to can cut off clients when smbd rebinds on reload. Cosmetic
    // edits (workgroup, server string) reload without dropping sessions, so they
    // stay unguarded. Gate only when the binding actually changes AND there are
    // live connections that could be dropped.
    const current = parseSmbConf(await readSmbConf()).global
    const interfacesChanged = req.interfaces !== undefined
      && !sameStringList(req.interfaces, current.interfaces)
    const bindChanged = req.bindInterfacesOnly !== undefined
      && req.bindInterfacesOnly !== current.bindInterfacesOnly

    if (interfacesChanged || bindChanged) {
      const conns = await allConnections()
      if (conns.length > 0) {
        const warnings = [
          `${conns.length} active SMB connection(s) may be dropped when smbd rebinds to the new interface list.`,
        ]
        const machines = [...new Set(conns.map(c => c.machine).filter(Boolean))]
        if (machines.length > 0)
          warnings.push(`Connected clients: ${machines.join(', ')}.`)

        // Signature is the resource identity only (section: 'global') — never
        // the changed values, so the confirm code stays valid on resend.
        if (!confirmGate(confirmStore, request, reply, {
          operation: 'smb.config.set',
          params: { section: 'global' },
          message: `Changing the SMB interface binding reloads smbd and may disconnect active clients`,
          warnings,
        })) {
          return reply
        }
      }
    }

    const job = jobQueue.submit(
      'smb.config.set',
      { ...identity, params: { section: 'global', config: req } },
      async () => {
        try {
          await editSmbConf(current => updateGlobal(current, req))
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { updated: 'global' }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- GET /shares/smb/:name — share detail + active connections ------------
  server.get<{ Params: { name: string } }>('/shares/smb/:name', async (request, reply) => {
    const nameParsed = ShareName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid share name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const text = await readSmbConf()
    const share = getShare(text, name)
    if (!share) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `SMB share '${name}' not found` } }
    }

    const detail: SmbShareDetail = {
      ...share,
      pathExists: pathExists(share.path),
      connections: await connectionsFor(share.name),
    }
    return { data: detail }
  })

  // --- POST /shares/smb — create a share ------------------------------------
  server.post('/shares/smb', async (request, reply) => {
    const bodyParsed = CreateSmbShareRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create share request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (await refuseOwnedSharePath(req.path, reply))
      return reply

    // The self-service fast path (smbsvc.1): 400 with the sentence when the
    // features cannot be enabled on this path/state.
    if (await refuseSelfService(req.name, req.path, req, reply))
      return reply

    // 409 if the share already exists — the config file is the source of truth.
    const text = await readSmbConf()
    if (hasShare(text, req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `SMB share '${req.name}' already exists` } }
    }

    const job = jobQueue.submit(
      'smb.share.add',
      { ...identity, params: { share: req.name, path: req.path } },
      async () => {
        try {
          await applySelfServiceAndEdit(
            req.name,
            req.path,
            req,
            (current, keys) => addShare(current, req, keys),
          )
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { created: req.name }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- PUT /shares/smb/:name — update a share -------------------------------
  server.put<{ Params: { name: string } }>('/shares/smb/:name', async (request, reply) => {
    const nameParsed = ShareName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid share name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = UpdateSmbShareRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update share request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const text = await readSmbConf()
    if (!hasShare(text, name)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `SMB share '${name}' not found` } }
    }

    // The edit CAN move the path (UpdateSmbShareRequest carries an optional
    // one) — the same backstop as create applies when it does (pvepool.1
    // review fixes). An edit that leaves the path alone is untouched.
    if (req.path !== undefined && await refuseOwnedSharePath(req.path, reply))
      return reply

    // The self-service fast path (smbsvc.1) judges the EFFECTIVE path — the
    // moved one when the edit carries it, the stanza's own path otherwise.
    const currentShare = getShare(text, name)
    if (currentShare && await refuseSelfService(name, req.path ?? currentShare.path, req, reply))
      return reply

    const job = jobQueue.submit(
      'smb.config.set',
      { ...identity, params: { share: name, config: req } },
      async () => {
        try {
          await applySelfServiceAndEdit(
            name,
            // The effective path AGAIN, resolved in the job from fresh state.
            req.path ?? getShare(await readSmbConf(), name)?.path ?? '',
            req,
            (current, keys) => updateShare(current, name, req, keys),
          )
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { updated: name }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /shares/smb/:name — remove a share (confirmation-gated) -------
  server.delete<{ Params: { name: string } }>('/shares/smb/:name', async (request, reply) => {
    const nameParsed = ShareName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid share name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const text = await readSmbConf()
    const share = getShare(text, name)
    if (!share) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `SMB share '${name}' not found` } }
    }

    const connections = await connectionsFor(share.name)

    const warnings = [
      `Removing SMB share '${name}' makes the shared path '${share.path}' inaccessible over SMB.`,
    ]
    if (connections.length > 0)
      warnings.push(`${connections.length} active connection(s) to '${name}' will be terminated on reload.`)

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'smb.share.remove',
      params: { share: name },
      message: `Removing SMB share '${name}' stops sharing '${share.path}'`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'smb.share.remove',
      { ...identity, params: { share: name } },
      async () => {
        try {
          await editSmbConf(current => removeShare(current, name))
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { removed: name }
      },
    )

    reply.code(202)
    return { job }
  })
}
