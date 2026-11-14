import type { ShareAccessGrantRequest, ShareAccessGrantResult, SmbConnection, SmbGlobalConfig, SmbShare, SmbShareDetail } from '@anas/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobContext, JobQueue } from '../jobs/queue.js'
import type { SelfServiceKeys } from '../parsers/smb-conf.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { GuardPass, GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { AccessObject, AccessService, GrantShare } from '../services/access.js'
import { createHash } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { CreateSmbShareRequest, isSmbSharePath, ShareName, SMB_SHARE_PATH_MSG, UpdateSmbGlobalConfigRequest, UpdateSmbShareRequest } from '@anas/shared'
import { addMissingGrantParams, addShare, customVfsRefusal, getShare, hasCustomVfsObjects, hasShare, parseSmbConf, removeShare, serviceLineRanges, smbSectionKey, updateGlobal, updateShare } from '../parsers/smb-conf.js'
import { parseSmbStatusJson, parseSmbStatusText } from '../parsers/smbstatus.js'
import { guardCheck, guardConfirm, guarded, GuardRefusalError, reverify, sendRefusal, smbShareClaim } from '../safety/guard.js'
import { createAccessService, SET_ACCESS_PRESENTATION_ONLY, signedAccessRequest } from '../services/access.js'
import { ConfigConflictError, editConfig, readConfig } from '../services/config-writer.js'
import { loadPveFootprint } from '../services/pve-footprint.js'
import { isSambaTemplatedPath, probeSharePath, probeSharePaths, sharePathFields, sharePathVerdictRefusal } from '../services/share-path.js'
import { enablingSelfService, ensureAhrSnapshotsMount, resolveSelfService, shareAvailableBytes, touchesSelfService } from '../services/share-selfservice.js'
import { requireIdentity } from './identity.js'
import { shareAccessHandlers } from './share-access.js'

const SMBSTATUS = '/usr/bin/smbstatus'
const SYSTEMCTL = '/usr/bin/systemctl'
const TESTPARM = '/usr/bin/testparm'

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

/**
 * Does an edit run the share-path grant? Only when it asks for one, and then
 * only when something the grant answers to changed or "apply to existing
 * files" was asked for (an unreadable stanza before the write runs it). The
 * same rule decides the companion edit (`inherit acls`, `create mask`,
 * `directory mask`), so a stanza gains those lines exactly when a grant runs
 * on it.
 */
export function editRunsGrant(grant: ShareAccessGrantRequest | undefined, before: SmbShare | null, after: SmbShare | null): boolean {
  if (!grant)
    return false
  if (grant.applyToExisting === true || !before || !after)
    return true
  return grantRelevantChange(before, after)
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
  async function grantFor(share: SmbShare, grant: ShareAccessGrantRequest, updateProgress: (msg: string) => void, recursiveConfirmed: boolean, ctx?: JobContext): Promise<ShareAccessGrantResult> {
    return access.grantOnSharePath(share.path, share, grant.applyToExisting === true, updateProgress, { recursiveConfirmed, ctx })
  }

  /**
   * A share grant bound (cr.43 step 5) to cr.37's revision-bound access spec:
   * the plan the job will run is prepared HERE, the spec carries the ACL
   * revision the composition read, the recursive confirm signs the whole
   * normalised grant request plus that revision (guardConfirm's bound
   * signature), and the job re-verifies it before its first write — a moved
   * ACL fails the job STATE_CHANGED with no setfacl, chown or chmod argv run.
   * The access spec's lock claims ride on the job beside the share's own.
   */
  interface BoundGrant {
    spec: GuardSpec<AccessObject>
    pass: GuardPass<AccessObject>
    /** The plan would rewrite the tree, and the recursive confirm passed. */
    recursive: boolean
  }

  /**
   * Bind the grant at the route: prepare it (the same gates, composition and
   * plan the job runs) and pass it through the access spec's route door.
   * The recursive confirm — when the plan rewrites the tree — is asked AFTER
   * every refusal, as on the editor's door: a grant that would be refused or
   * would do nothing has nothing to confirm. `sent` = the confirm's 409 went
   * out. `bound` is null when the grant is NOT bound to a revision: it will
   * not run (the preparation finished refused/nothing), or its door refused
   * in the instant after the prepare — either way the job's own re-prepare
   * carries that outcome on the share's result, because a grant refusal
   * never refuses the share (the share-door contract, access.1).
   */
  async function bindGrant(
    path: string,
    share: GrantShare,
    applyToExisting: boolean,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ sent: true } | { bound: BoundGrant | null }> {
    const prepared = await access.prepareShareGrant(path, share, applyToExisting)
    if ('done' in prepared)
      return { bound: null }
    const spec = access.setAccessGuardSpec({
      what: `Share path '${path}'`,
      address: { path },
      req: prepared.plan.req,
      resolve: async () => ({ ok: true, value: await access.resolveShareTarget(path) }),
    })
    const pass = await guardCheck(spec)
    if ('refusal' in pass)
      return { bound: null }
    if (prepared.plan.recursive) {
      const confirm = await access.recursiveConfirm(prepared.plan.target, { named: prepared.plan.hasNamed, walk: prepared.plan.walk })
      if (!guardConfirm(confirmStore, request, reply, spec, pass, {
        validated: { path, ...signedAccessRequest(prepared.plan.req) },
        address: ['path'],
        presentationOnly: SET_ACCESS_PRESENTATION_ONLY,
        message: confirm.message,
        warnings: confirm.warnings,
      })) {
        return { sent: true }
      }
    }
    return { bound: { spec, pass, recursive: prepared.plan.recursive } }
  }

  /** Read smb.conf fresh every time — the file is the source of truth (P.11). */
  async function readSmbConf(): Promise<string> {
    return readConfig(smbConfPath)
  }

  // --- The share guard specs (story cr.43, WAVE3-DESIGN §2.5/§3.3, ruling (j))
  //
  // One spec per verb, both doors: the route answers a refusal in the request,
  // the job re-reads smb.conf and refuses again before it writes — item 1
  // (vanished share) included. The reads never return null: absence lives in
  // the per-verb existence gate carrying the routes' existing sentence, which
  // keeps the hasShare-vs-getShare asymmetry exactly where it is (PUT answers
  // 404 when the stanza is gone, DELETE when it has no path to remove).
  //
  // A vanished update fails the JOB with NOT_FOUND, not success and not a
  // false STATE_CHANGED: reverify checks the revision BEFORE the gates, and a
  // throwing revision getter is the settled mechanism — so the update spec's
  // revision throws the gate's own NOT_FOUND when the stanza is gone. (The
  // route door never reaches it: guardCheck runs the gates first.)

  interface SmbShareObject { name: string, text: string }

  const shareNotFound = (name: string): Refusal =>
    ({ status: 404, code: 'NOT_FOUND', message: `SMB share '${name}' not found` })

  /**
   * sha256 of the stanza's own lines (header through one-before-next) — every
   * section Samba reads under the name, merged or left unavailable (H1) — or
   * null when gone.
   */
  function stanzaRevision(text: string, name: string): string | null {
    const ranges = name.toLowerCase() === 'global' ? null : serviceLineRanges(text, name)
    if (!ranges)
      return null
    const lines = text.split('\n')
    return createHash('sha256').update(ranges.map(r => lines.slice(r.start, r.end).join('\n')).join('\n')).digest('hex')
  }

  function smbShareView(name: string): ObjectView<SmbShareObject> {
    return {
      what: `SMB share '${name}'`,
      read: async reads => ({ name, text: await reads.once('smbConf', () => readSmbConf()) }),
      id: async () => ({ share: name }),
      unbound: part => part === 'revision'
        ? `Could not read SMB share '${name}' from smb.conf — refusing an edit that cannot be bound to it`
        : `Could not read SMB share '${name}' — refusing`,
    }
  }

  /**
   * cr3.shares L7 (ruling (j)): the PVE share-path claim as a guard gate, so
   * the job asks it again before it writes — a storage that came to claim
   * the path while the job waited refuses there, not only at the route.
   */
  const sharePathGate = (path: string) => async (): Promise<Refusal | null> => sharePathRefusal(path)

  function smbUpdateGuardSpec(name: string, movedPath?: string): GuardSpec<SmbShareObject> {
    return {
      operation: 'smb.config.set',
      object: {
        ...smbShareView(name),
        revision: async (o) => {
          const revision = stanzaRevision(o.text, name)
          // Vanished between confirmation and job: the job fails with the same
          // NOT_FOUND the route answers, not with STATE_CHANGED for a line the
          // request was never computed from.
          if (revision === null)
            throw new GuardRefusalError(shareNotFound(name))
          return revision
        },
      },
      gates: [
        async o => (hasShare(o.text, name) ? null : shareNotFound(name)),
        // An edit that MOVES the path re-asks the claim on the new one; the
        // stanza's own path sent back unchanged is no move (cr3.shares L6).
        ...(movedPath !== undefined
          ? [async (o: SmbShareObject) => (getShare(o.text, name)?.path === movedPath ? null : sharePathRefusal(movedPath))]
          : []),
      ],
      locks: async () => [smbShareClaim(name)],
    }
  }

  function smbRemoveGuardSpec(name: string): GuardSpec<SmbShareObject> {
    return {
      operation: 'smb.share.remove',
      // A remove deletes the whole stanza — nothing survives to bind a
      // revision to (the mounts precedent); the gate re-answers the 404.
      object: smbShareView(name),
      gates: [async o => (getShare(o.text, name) ? null : shareNotFound(name))],
      locks: async () => [smbShareClaim(name)],
    }
  }

  const shareExists = (name: string): Refusal =>
    ({ status: 409, code: 'CONFLICT', message: `SMB share '${name}' already exists` })

  function smbCreateGuardSpec(name: string, path: string): GuardSpec<SmbShareObject> {
    return {
      operation: 'smb.share.add',
      // The object is the share-name SLOT (the mounts create precedent): a
      // stanza there answers CONFLICT at the route, and item 2 runs the same
      // gate again inside the job under the share's lock — a stanza added
      // while the create waits refuses there, so no duplicate stanza is ever
      // written. The job's transform carries the last-moment backstop.
      object: smbShareView(name),
      gates: [async o => (hasShare(o.text, name) ? shareExists(name) : null), sharePathGate(path)],
      locks: async () => [smbShareClaim(name)],
    }
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
   * Live connections keyed by share (service), from smbstatus (JSON first),
   * keyed the way Samba names a service (case- and whitespace-blind).
   *
   * Never throws. smbstatus ships in the `samba` package and execFile
   * REJECTS with ENOENT when the binary is missing — a node without samba
   * runs no smbd, so nothing is connected (issue #6: never a 500). Every
   * other failure — a non-zero exit, output neither parser reads, a timeout —
   * is UNKNOWN (cr3.shares L8 / INVENTED-STATE-M6): `null`, never "no
   * connections", so a binding change still confirms and a count reads
   * unknown, not 0.
   */
  async function connectionsByShare(): Promise<Map<string, SmbConnection[]> | null> {
    const keyed = (byService: Record<string, SmbConnection[]>): Map<string, SmbConnection[]> => {
      const out = new Map<string, SmbConnection[]>()
      for (const [service, conns] of Object.entries(byService)) {
        const key = smbSectionKey(service)
        out.set(key, [...(out.get(key) ?? []), ...conns])
      }
      return out
    }
    try {
      const json = await executor.exec(SMBSTATUS, ['--json'])
      if (json.exitCode === 0 && json.stdout.trim().startsWith('{')) {
        try {
          return keyed(parseSmbStatusJson(json.stdout))
        }
        catch {
          // Fall through to the text parser below.
        }
      }
      const text = await executor.exec(SMBSTATUS, ['-S'])
      if (text.exitCode === 0)
        return keyed(parseSmbStatusText(text.stdout))
      return null
    }
    catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? new Map() : null
    }
  }

  /** Live connections for a given share, or null when smbstatus could not be read. */
  async function connectionsFor(shareName: string): Promise<SmbConnection[] | null> {
    const byShare = await connectionsByShare()
    return byShare === null ? null : byShare.get(smbSectionKey(shareName)) ?? []
  }

  /** Every live connection across all shares, or null when unreadable. */
  async function allConnections(): Promise<SmbConnection[] | null> {
    const byShare = await connectionsByShare()
    return byShare === null ? null : [...byShare.values()].flat()
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

  /** Does the edit change which interfaces smbd binds to (a reorder is not a change)? */
  function bindingChanges(current: SmbGlobalConfig, req: UpdateSmbGlobalConfigRequest): boolean {
    const interfacesChanged = req.interfaces !== undefined && !sameStringList(req.interfaces, current.interfaces)
    const bindChanged = req.bindInterfacesOnly !== undefined && req.bindInterfacesOnly !== current.bindInterfacesOnly
    return interfacesChanged || bindChanged
  }

  /** The binding confirm's warnings: the clients it may drop, or that nobody could see. */
  function bindingWarnings(conns: SmbConnection[] | null): string[] {
    if (conns === null)
      return ['Active SMB connections could not be read (smbstatus failed) — any connected client may be dropped when smbd rebinds to the new interface list.']
    const warnings = [`${conns.length} active SMB connection(s) may be dropped when smbd rebinds to the new interface list.`]
    const machines = [...new Set(conns.map(c => c.machine).filter(Boolean))]
    if (machines.length > 0)
      warnings.push(`Connected clients: ${machines.join(', ')}.`)
    return warnings
  }

  /**
   * The `[global]` guard spec (the last legacy confirmGate door, moved onto
   * the guard — EPICS §3 rider): the object is the `[global]` stanza (every
   * section Samba merges into it), its revision binds the confirm and the
   * job, and the job holds the section's lock.
   */
  function smbGlobalGuardSpec(): GuardSpec<SmbShareObject> {
    return {
      operation: 'smb.config.set',
      object: {
        ...smbShareView('global'),
        what: 'SMB global configuration',
        revision: async (o) => {
          const ranges = serviceLineRanges(o.text, 'global')
          const lines = o.text.split('\n')
          const body = ranges ? ranges.map(r => lines.slice(r.start, r.end).join('\n')).join('\n') : '<no [global]>'
          return createHash('sha256').update(body).digest('hex')
        },
      },
      gates: [],
      locks: async () => [smbShareClaim('global')],
    }
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
   * a dir-storage tree or the boot tree — refused 409 PVE_MANAGED with the
   * reason (cr.47b), which names the storage AND the dataset), or it sits
   * under a `dir` storage's
   * CONFIGURED path on a ZFS filesystem whose dataset could not be resolved (a
   * `legacy`/`none` dataset with no live mount — refused against the path
   * itself, the same rule mounts and restore use; pvepool.1 review fix 5). A
   * dir-storage path on a NON-ZFS filesystem (e.g. `/var/lib/vz` on the ext4
   * root) is allowed — caveat emptor (EPICS §2, ruled 2026-09-22). A path on a
   * SIBLING dataset's mountpoint (or a subdirectory of one) is ordinary ANAS
   * storage and passes untouched.
   */
  async function refuseOwnedSharePath(path: string, reply: FastifyReply): Promise<boolean> {
    const refusal = await sharePathRefusal(path)
    if (!refusal)
      return false
    reply.send(sendRefusal(reply, refusal))
    return true
  }

  /**
   * The footprint's answer for a share path as a refusal, or null for a
   * positive "no claim" only (cr.47b: the ownership fact is 409
   * PVE_MANAGED, the config-unreadable verdict keeps its 400; cr3.shares
   * M4: a footprint that could not see refuses, never reads as no claim).
   */
  async function sharePathRefusal(path: string): Promise<Refusal | null> {
    const pve = await loadPveFootprint(executor)
    return sharePathVerdictRefusal(pve.sharePathVerdict(path), 'Share path', path)
  }

  // --- GET /shares/smb — ALL shares (incl. admin-created, Principle 11) -----
  server.get('/shares/smb', async () => {
    const text = await readSmbConf()
    // Check each share's path at read time (Principle 7 — nothing is cached):
    // a missing path is a stale definition, a path that does not answer is a
    // hung mount under the share (cr.35: through the executor, never a stat
    // on the event loop). Each share gets its own verdict.
    const parsed = parseSmbConf(text).shares
    // cr3.shares L6: a path with a Samba `%` macro names no one directory —
    // never probed, no path state (unknown), never "missing".
    const [probes, byShare] = await Promise.all([
      probeSharePaths(executor, parsed.map(s => s.path).filter(p => !isSambaTemplatedPath(p))),
      // INVENTED-STATE-M6: ONE smbstatus read for the whole list; a failed
      // read is null for every row (unknown), never 0.
      connectionsByShare(),
    ])
    const shares = parsed.map(share => ({
      ...share,
      ...(isSambaTemplatedPath(share.path) ? {} : sharePathFields(probes.get(share.path)!)),
      activeConnections: byShare === null ? null : (byShare.get(smbSectionKey(share.name)) ?? []).length,
      // cr3.shares (review): a name ANAS cannot address is listed, not managed.
      ...(ShareName.safeParse(share.name).success ? {} : { unmanagedName: true }),
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
    // stay unguarded. Gate when the binding actually changes AND clients are
    // connected — or when nobody can tell (cr3.shares L8: a failed smbstatus
    // read is unknown, and unknown confirms).
    const spec = smbGlobalGuardSpec()
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    let confirmed = false
    if (bindingChanges(parseSmbConf(pre.object.text).global, req)) {
      const conns = await allConnections()
      if (conns === null || conns.length > 0) {
        // The confirm signs every field the edit writes, values included
        // (EPICS §2, ruling 2026-10-17; none is secret): a code minted for
        // one interface list never confirms another (core review handoff).
        if (!guardConfirm(confirmStore, request, reply, spec, pre, {
          validated: { section: 'global', ...req },
          address: ['section'],
          message: `Changing the SMB interface binding reloads smbd and may disconnect active clients`,
          warnings: bindingWarnings(conns),
        })) {
          return reply
        }
        confirmed = true
      }
    }

    const job = jobQueue.submit(
      'smb.config.set',
      { ...identity, params: { section: 'global', config: req } },
      // Ruling (j): the [global] stanza's revision is re-read here, and a
      // binding change that went unconfirmed at the route asks the clients
      // gate again — clients that connected while the job waited (or a
      // smbstatus that no longer answers) refuse it rather than drop them.
      guarded(spec, pre, async (o) => {
        if (!confirmed && bindingChanges(parseSmbConf(o.text).global, req)) {
          const conns = await allConnections()
          if (conns === null || conns.length > 0) {
            throw new GuardRefusalError({
              status: 409,
              code: 'STATE_CHANGED',
              message: conns === null
                ? 'Active SMB connections could not be read when the job ran — the interface binding change was not applied; send it again to confirm it'
                : `${conns.length} SMB client connection(s) appeared after the request was accepted — the interface binding change was not applied; send it again to confirm it`,
            })
          }
        }
        try {
          await editSmbConf(current => updateGlobal(current, req))
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { updated: 'global' }
      }),
      { locks: pre.locks },
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

    const connections = await connectionsFor(share.name)
    const detail: SmbShareDetail = {
      ...share,
      ...(isSambaTemplatedPath(share.path) ? {} : sharePathFields(await probeSharePath(executor, share.path))),
      connections: connections ?? [],
      ...(connections === null ? { connectionsUnknown: true } : {}),
      activeConnections: connections === null ? null : connections.length,
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

    // Story cr.43 item 2: existence answers 409 CONFLICT at the route, and
    // the same gate runs again in the job under the share's lock — a stanza
    // that appears while the create waits refuses there, so no duplicate
    // stanza is ever written.
    const spec = smbCreateGuardSpec(req.name, req.path)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // cr.43 step 5: the grant is prepared here and bound to its ACL revision
    // (cr.37's spec); the recursive confirm signs it. A grant that will not
    // run, or whose door refused just now, stays unbound and the job's own
    // re-prepare reports it on the result.
    let grantBinding: BoundGrant | null = null
    if (req.grantAccess) {
      const gate = await bindGrant(req.path, { validUsers: req.validUsers ?? [], guestOk: req.guestOk ?? false, readOnly: req.readOnly ?? false }, req.grantAccess.applyToExisting === true, request, reply)
      if ('sent' in gate)
        return reply
      grantBinding = gate.bound
    }

    const job = jobQueue.submit(
      'smb.share.add',
      { ...identity, params: { share: req.name, path: req.path } },
      // Ruling (j): the slot gate runs again here and the whole job holds the
      // share's lock — a stanza that appeared while the create waited arrives
      // as CONFLICT, before a line of smb.conf moves.
      guarded(spec, pre, async (_share, ctx) => {
        const { updateProgress } = ctx
        // cr.43 step 5: the grant's revision is re-verified FIRST — an ACL
        // that moved while this job waited fails STATE_CHANGED before a line
        // of smb.conf is written and before any setfacl, chown or chmod argv
        // runs ("nothing was done" means nothing).
        if (grantBinding)
          await reverify(grantBinding.spec, grantBinding.pass.bound)
        try {
          await applySelfServiceAndEdit(
            req.name,
            req.path,
            req,
            (current, keys) => {
              // The last-moment backstop (the mounts pattern): between the
              // reverify read and this transform's own read a [name] stanza
              // can still appear — the create refuses with the CONFLICT
              // sentence and smb.conf keeps its bytes.
              if (hasShare(current, req.name))
                throw new GuardRefusalError(shareExists(req.name))
              return addShare(current, req, keys)
            },
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
            ? await grantFor(created, req.grantAccess, updateProgress, grantBinding?.recursive === true, ctx)
            : { status: 'failed' as const, message: `SMB share '${req.name}' could not be read back after the write`, path: req.path, granted: [], skipped: [], applyToExisting: req.grantAccess.applyToExisting === true }
          return { created: req.name, grant }
        }
        return { created: req.name }
      }),
      // The share's lock still covers the whole job; the bound grant's access
      // claims (the dataset, its ancestors, the pool — cr.33) ride along.
      { locks: [...pre.locks, ...(grantBinding?.pass.locks ?? [])] },
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

    // Story cr.43: the stanza's existence answers 404 at the route, and the
    // route's edit is bound to the stanza's revision — the job writes a merge
    // of THIS stanza or refuses (NOT_FOUND when it vanished, STATE_CHANGED
    // when a hand edit moved it under the request).
    const spec = smbUpdateGuardSpec(name, req.path)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const text = pre.object.text

    // The edit CAN move the path (UpdateSmbShareRequest carries an optional
    // one) — the same backstop as create applies when it does (pvepool.1
    // review fixes). An edit that leaves the path alone is untouched: the
    // stanza's own path sent back (the panel always sends it) is no move, and
    // is kept verbatim whatever it holds (cr3.shares L6, review). A path that
    // DOES move must be exactly what Samba serves.
    const pathMoves = req.path !== undefined && req.path !== getShare(text, name)?.path
    if (pathMoves && !isSmbSharePath(req.path!)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update share request: ${SMB_SHARE_PATH_MSG}` } }
    }
    if (pathMoves && await refuseOwnedSharePath(req.path!, reply))
      return reply

    // The self-service fast path (smbsvc.1) judges the EFFECTIVE path — the
    // moved one when the edit carries it, the stanza's own path otherwise.
    const currentShare = getShare(text, name)
    if (currentShare && await refuseSelfService(name, req.path ?? currentShare.path, req, reply))
      return reply

    // The edit's fields laid over the stanza: what the grant will answer to.
    // cr.43 step 5: the grant is bound whenever it will RUN — the same rule
    // the job applies, and the stanza's revision is bound to the share's own
    // door, so the before/after the job compares are the ones predicted here.
    let grantBinding: BoundGrant | null = null
    if (req.grantAccess && currentShare && editRunsGrant(req.grantAccess, currentShare, getShare(updateShare(text, name, req), name))) {
      const gate = await bindGrant(req.path ?? currentShare.path, {
        validUsers: req.validUsers ?? currentShare.validUsers,
        guestOk: req.guestOk ?? currentShare.guestOk,
        readOnly: req.readOnly ?? currentShare.readOnly,
      }, req.grantAccess.applyToExisting === true, request, reply)
      if ('sent' in gate)
        return reply
      grantBinding = gate.bound
    }

    const job = jobQueue.submit(
      'smb.config.set',
      { ...identity, params: { share: name, config: req } },
      // Ruling (j): id, the stanza's revision and the existence gate run again
      // here, and the whole job holds the share's lock — a hand edit while the
      // job waited arrives as STATE_CHANGED, a vanished stanza as NOT_FOUND.
      guarded(spec, pre, async (_share, ctx) => {
        const { updateProgress } = ctx
        // cr.43 step 5: the grant's revision is re-verified FIRST — an ACL
        // that moved while this job waited fails STATE_CHANGED before a line
        // of smb.conf is written and before any setfacl, chown or chmod argv
        // runs ("nothing was done" means nothing).
        if (grantBinding)
          await reverify(grantBinding.spec, grantBinding.pass.bound)
        // access.1: the stanza BEFORE the edit, so the grant runs only when
        // something it answers to actually changed.
        const before = req.grantAccess ? getShare(await readSmbConf(), name) : null
        try {
          await applySelfServiceAndEdit(
            name,
            // The effective path AGAIN, resolved in the job from fresh state.
            req.path ?? getShare(await readSmbConf(), name)?.path ?? '',
            req,
            (current, keys) => {
              // The last-moment backstop (the mounts pattern): between the
              // reverify read and this transform's own read the stanza can
              // still go — the edit then refuses with the 404 sentence and
              // smb.conf keeps its bytes.
              if (!hasShare(current, name))
                throw new GuardRefusalError(shareNotFound(name))
              const next = updateShare(current, name, req, keys)
              // live proof 0.4.3 F2, re-proof RF1: an edit that runs a grant
              // also writes `inherit acls`, `create mask` and `directory mask`,
              // each only when the stanza does not set it under any spelling
              // (an operator's value stands).
              return editRunsGrant(req.grantAccess, getShare(current, name), getShare(next, name))
                ? addMissingGrantParams(next, name)
                : next
            },
          )
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        if (req.grantAccess) {
          const after = getShare(await readSmbConf(), name)
          if (!after)
            return { updated: name, grant: { status: 'failed' as const, message: `SMB share '${name}' could not be read back after the write`, path: req.path ?? before?.path ?? '', granted: [], skipped: [], applyToExisting: req.grantAccess.applyToExisting === true } }
          // An explicit "apply to existing files" is its own reason to run.
          if (!editRunsGrant(req.grantAccess, before, after))
            return { updated: name, grant: { status: 'nothing' as const, path: after.path, granted: [], skipped: [], applyToExisting: false } }
          return { updated: name, grant: await grantFor(after, req.grantAccess, updateProgress, grantBinding?.recursive === true, ctx) }
        }
        return { updated: name }
      }),
      // The share's lock still covers the whole job; the bound grant's access
      // claims (the dataset, its ancestors, the pool — cr.33) ride along.
      { locks: [...pre.locks, ...(grantBinding?.pass.locks ?? [])] },
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

    // Story cr.43: the gate answers the 404 at the route; the job re-runs it
    // under the share's lock, so removing a share that vanished while the job
    // waited fails NOT_FOUND instead of reporting success. (The gate is
    // getShare, matching the route's historical 404 — a stanza without a
    // shareable path is nothing to remove.)
    const spec = smbRemoveGuardSpec(name)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const share = getShare(pre.object.text, name)
    if (!share)
      return sendRefusal(reply, shareNotFound(name)) // the gate passed; TS narrowing

    const connections = await connectionsFor(share.name)

    const warnings = [
      `Removing SMB share '${name}' makes the shared path '${share.path}' inaccessible over SMB.`,
      ...pre.advisories.map(a => a.warning),
    ]
    if (connections === null)
      warnings.push(`Active connections to '${name}' could not be read (smbstatus failed) — any client connected now will be disconnected on reload.`)
    else if (connections.length > 0)
      warnings.push(`${connections.length} active connection(s) to '${name}' will be terminated on reload.`)

    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name },
      address: ['name'],
      message: `Removing SMB share '${name}' stops sharing '${share.path}'`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'smb.share.remove',
      { ...identity, params: { share: name } },
      guarded(spec, pre, async () => {
        try {
          await editSmbConf((current) => {
            // Last-moment backstop: gone since the reverify read — refuse with
            // the 404 sentence, the file keeps its bytes.
            if (!getShare(current, name))
              throw new GuardRefusalError(shareNotFound(name))
            return removeShare(current, name)
          })
        }
        catch (err) {
          throw asJobError(err)
        }
        await reloadSmbd()
        return { removed: name }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })
}
