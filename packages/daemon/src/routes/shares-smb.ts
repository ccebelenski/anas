import type { ShareAccessGrantRequest, ShareAccessGrantResult, SmbConnection, SmbShare, SmbShareDetail } from '@anas/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { SelfServiceKeys } from '../parsers/smb-conf.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AccessService } from '../services/access.js'
import { statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { CreateSmbShareRequest, ShareName, UpdateSmbGlobalConfigRequest, UpdateSmbShareRequest } from '@anas/shared'
import { addShare, customVfsRefusal, getShare, hasCustomVfsObjects, hasShare, parseSmbConf, removeShare, updateGlobal, updateShare } from '../parsers/smb-conf.js'
import { parseSmbStatusJson, parseSmbStatusText } from '../parsers/smbstatus.js'
import { confirmGate } from '../safety/gate.js'
import { createAccessService, sharePrincipals } from '../services/access.js'
import { ConfigConflictError, editConfig, readConfig } from '../services/config-writer.js'
import { loadPveFootprint } from '../services/pve-footprint.js'
import { enablingSelfService, ensureAhrSnapshotsMount, resolveSelfService, shareAvailableBytes, touchesSelfService } from '../services/share-selfservice.js'
import { requireIdentity } from './identity.js'
import { shareAccessHandlers } from './share-access.js'

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
  /** The ONE permissions writer (access.1) — the share-path grant and the row's editor. */
  accessService?: AccessService
}

/**
 * Did an edit change anything the share-path grant answers to (access.1)?
 * The principal SET (order is not a change), the guest flag, the read-only
 * flag (it sets the level), or the path itself.
 */
export function grantRelevantChange(before: SmbShare, after: SmbShare): boolean {
  const a = new Set(before.validUsers)
  const b = new Set(after.validUsers)
  const samePrincipals = a.size === b.size && [...a].every(v => b.has(v))
  return !samePrincipals
    || before.guestOk !== after.guestOk
    || before.readOnly !== after.readOnly
    || before.path !== after.path
}

export async function smbShareRoutes(
  server: FastifyInstance,
  opts: SmbShareRouteOptions,
) {
  const { executor, jobQueue, confirmStore, smbConfPath, fstabPath, systemdDir } = opts
  const access = opts.accessService ?? createAccessService({ executor })
  const shareAccess = shareAccessHandlers({ access, jobQueue, confirmStore })

  /**
   * The share-path grant inside a share job (access.1): the editor with the
   * form pre-filled from the share's EFFECTIVE stanza (read back after the
   * write, so defaults are what smb.conf says, not what the request omitted).
   * Never fails the job — the outcome rides on the result.
   */
  async function grantFor(share: SmbShare, grant: ShareAccessGrantRequest, updateProgress: (msg: string) => void): Promise<ShareAccessGrantResult> {
    return access.grantOnSharePath(share.path, share, grant.applyToExisting === true, updateProgress)
  }

  /**
   * The grant's "apply to existing files" is the editor's recursive apply and
   * carries the same 409 + X-Anas-Confirm-Code (ruling 2026-10-11), with the
   * same headline and warnings for the share's path. True = confirmed (or
   * nothing to confirm); false = the 409 was sent.
   */
  async function confirmRecursiveGrant(path: string, validUsers: string[], request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const target = await access.resolveShareTarget(path)
    const named = sharePrincipals(validUsers).principals.length > 0
    return confirmGate(confirmStore, request, reply, await access.recursiveConfirm(target, { named }))
  }

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
    // The storage's free space (smbsvc.3, additive, fail-open): the input for
    // the Time Machine cap suggestion — present when the path resolves onto a
    // ZFS dataset or an AHR pool, absent otherwise.
    const availableBytes = await shareAvailableBytes(executor, share.path)
    if (availableBytes !== undefined)
      detail.capacity = { availableBytes }
    return { data: detail }
  })

  // --- GET/PUT /shares/smb/:name/access — the share row's Permissions -------
  // (access.1) The shared editor on the share's path, resolved from smb.conf.
  async function sharePathOr404(raw: string, reply: FastifyReply): Promise<{ name: string, path: string } | null> {
    const nameParsed = ShareName.safeParse(raw)
    if (!nameParsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid share name: ${nameParsed.error.issues[0]?.message}` } })
      return null
    }
    const share = getShare(await readSmbConf(), nameParsed.data)
    if (!share) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `SMB share '${nameParsed.data}' not found` } })
      return null
    }
    return { name: share.name, path: share.path }
  }

  server.get<{ Params: { name: string } }>('/shares/smb/:name/access', async (request, reply) => {
    const share = await sharePathOr404(request.params.name, reply)
    if (!share)
      return reply
    return shareAccess.get(share.path, reply)
  })

  server.put<{ Params: { name: string } }>('/shares/smb/:name/access', async (request, reply) => {
    const share = await sharePathOr404(request.params.name, reply)
    if (!share)
      return reply
    return shareAccess.put(share.path, { share: share.name }, request, reply)
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

    if (req.grantAccess?.applyToExisting === true && !(await confirmRecursiveGrant(req.path, req.validUsers ?? [], request, reply)))
      return reply

    const job = jobQueue.submit(
      'smb.share.add',
      { ...identity, params: { share: req.name, path: req.path } },
      async (updateProgress) => {
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
        // access.1: the share exists now; the grant (when asked for) runs on
        // the stanza as written and reports its own outcome.
        if (req.grantAccess) {
          const created = getShare(await readSmbConf(), req.name)
          const grant = created
            ? await grantFor(created, req.grantAccess, updateProgress)
            : { status: 'failed' as const, message: `SMB share '${req.name}' could not be read back after the write`, path: req.path, granted: [], skipped: [], applyToExisting: req.grantAccess.applyToExisting === true }
          return { created: req.name, grant }
        }
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

    if (req.grantAccess?.applyToExisting === true && currentShare
      && !(await confirmRecursiveGrant(req.path ?? currentShare.path, req.validUsers ?? currentShare.validUsers, request, reply))) {
      return reply
    }

    const job = jobQueue.submit(
      'smb.config.set',
      { ...identity, params: { share: name, config: req } },
      async (updateProgress) => {
        // access.1: the stanza BEFORE the edit, so the grant runs only when
        // something it answers to actually changed.
        const before = req.grantAccess ? getShare(await readSmbConf(), name) : null
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
        if (req.grantAccess) {
          const after = getShare(await readSmbConf(), name)
          if (!after)
            return { updated: name, grant: { status: 'failed' as const, message: `SMB share '${name}' could not be read back after the write`, path: req.path ?? '', granted: [], skipped: [], applyToExisting: req.grantAccess.applyToExisting === true } }
          // An explicit "apply to existing files" is its own reason to run.
          if (before && !grantRelevantChange(before, after) && req.grantAccess.applyToExisting !== true)
            return { updated: name, grant: { status: 'nothing' as const, path: after.path, granted: [], skipped: [], applyToExisting: false } }
          return { updated: name, grant: await grantFor(after, req.grantAccess, updateProgress) }
        }
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
