/**
 * iSCSI verbs on the guard (story cr.40, docs/WAVE3-DESIGN.md §2.4, §3.3).
 *
 * Every target and LUN verb describes itself ONCE as a guard spec — how to
 * read the target (or the LUN), its identity, the revision an edit-shaped verb
 * was computed from, and the gate list — and both doors run that one spec:
 * the route answers a gate's refusal as its 4xx, the job re-reads under
 * `withIscsiLock` and re-runs every check before a single `targetcli` runs.
 *
 * Identity and revision, per object:
 *
 *  - a TARGET is its IQN (LIO has no rename, GT-10); its REVISION is a hash of
 *    the facts every target verb is computed from — the TPG tag, `enable`, the
 *    TPG `authentication` flag, the ACLs (initiator, CHAP user ids, whether
 *    credentials are set, mapped LUNs), the portals and the LUN list. Sessions
 *    are NOT in it: an initiator logging in changes no configuration, and the
 *    verbs whose answer depends on sessions gate on them by name.
 *  - a LUN is its unit serial, backstore and backing path (the index is only
 *    its address: indexes are reused lowest-free, ident.2); a delete that
 *    destroys the backing also binds the SERVED device as its scope (§3.3:
 *    the object it destroys).
 *
 * Why the target update binds a revision rather than re-diffing in the job
 * (F4): the update is a DIFF between the request's desired ACL/portal sets and
 * the target as it was when the request was computed. Re-diffing against a
 * fresh read would silently delete an ACL another operator added in between —
 * the review's "drops ACLs added since" — and diffing against the request-time
 * object without checking would send `acls delete` for an ACL someone else
 * already removed, which fails half-way through the sequence with no
 * `saveconfig` (GT-5). With the revision bound, the fresh target IS the
 * request-time target whenever the job acts, and any move refuses with
 * STATE_CHANGED before anything runs.
 */

import type { IscsiLun, IscsiTargetDetail, UpdateIscsiTargetRequest } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { LockClaim } from '../jobs/locks.js'
import type { JobHandler } from '../jobs/queue.js'
import type { Gate, GuardedBody, GuardPass, GuardReads, GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { IscsiRefusal } from './iscsi-mutate.js'
import type { IscsiPaths, IscsiReadContext } from './iscsi.js'
import { createHash } from 'node:crypto'
import { parseSnapshotNames, zfsSnapshotListArgs } from '../parsers/zfs-list.js'
import { guardCheck, guarded, GuardRefusalError, iscsiLunClaim, iscsiTargetClaim } from '../safety/guard.js'
import { lunsMappingBackstore } from './iscsi-configfs.js'
import { assertInstalled, assertSaveable, readIscsiState, withIscsiLock, ZFS, zvolDataset } from './iscsi-mutate.js'
import { handsOffRefusal, ownershipUnknownRefusal } from './iscsi-rules.js'
import { checkServedDevice, statDeviceFrom } from './iscsi-served.js'
import { targetTpgs } from './iscsi.js'

/** One whole read of the LIO tree: the context and the targets built from it. */
export interface IscsiState {
  ctx: IscsiReadContext
  targets: IscsiTargetDetail[]
}

/** What a target verb's guard reads: the state, and the target in it. */
export interface TargetObject {
  state: IscsiState
  target: IscsiTargetDetail
}

/** What a LUN verb's guard reads: the target, and the LUN at the index (absent = gone). */
export interface LunObject extends TargetObject {
  lun: IscsiLun | undefined
}

export interface IscsiGuardDeps {
  executor: CommandExecutor
  paths: IscsiPaths
}

/** An `IscsiRefusal` (the services' shape) as the guard's 409 CONFLICT. */
export function conflict(refusal: IscsiRefusal): Refusal {
  return { status: 409, code: 'CONFLICT', reason: refusal.reason, message: refusal.message }
}

/**
 * The state reader of one guard run. The route has ALREADY read the state for
 * its pre-flight (LIO installed, not degraded), so the route door's run takes
 * that read once (`seed`) instead of a second one; every later run — the job's,
 * a `reguard` — reads afresh. Nothing read at the request reaches the job: the
 * seed is consumed by the first run, which is always the route's `guardCheck`.
 */
export function iscsiStateReader(deps: IscsiGuardDeps, seed?: IscsiState): (reads: GuardReads) => Promise<IscsiState> {
  let pending = seed
  return reads => reads.once('iscsi:state', async () => {
    if (pending) {
      const first = pending
      pending = undefined
      return first
    }
    return readIscsiState(deps.executor, deps.paths)
  })
}

/** Stable JSON (sorted keys), so a revision does not depend on read order. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map(stable).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`
}

/** Sorted copy (the package targets ES2022, so no `toSorted`). */
function sorted<T>(items: T[], key: (item: T) => string): T[] {
  const out = [...items]
  out.sort((a, b) => key(a).localeCompare(key(b)))
  return out
}

/** `address:port` the way LIO compares portals: address case-insensitive, port exact. */
export function portalKey(p: { address: string, port: number }): string {
  return `${p.address.toLowerCase()}:${p.port}`
}

/**
 * The target's revision: a sha256 over the configuration every target verb is
 * computed from. Credentials enter only as "set or not", as the own.4(e)
 * "could not be read" mark, and never as a secret; sessions not at all (see
 * the module comment).
 */
export function targetRevision(target: IscsiTargetDetail): string {
  const facts = {
    tpgTag: target.tpgTag,
    enabled: target.enabled,
    authentication: target.security.authentication,
    acls: sorted(target.acls, a => a.initiatorIqn).map(a => ({
      initiator: a.initiatorIqn,
      chapUserid: a.chapUserid,
      chapCredentialsSet: a.chapCredentialsSet,
      mutualUserid: a.mutualUserid,
      mutualCredentialsSet: a.mutualCredentialsSet,
      // own.4(e): an ACL whose auth could not be READ is a different fact than
      // one that read as unset — a job must not bind against a revision that
      // was computed while the credentials were unknown.
      ...(a.authUnreadable === true ? { authUnreadable: true } : {}),
      mappedLuns: sorted(a.mappedLuns, n => String(n).padStart(6, '0')),
    })),
    portals: target.portals.map(portalKey).sort(),
    luns: sorted(target.luns, l => String(l.index).padStart(6, '0')).map(l => ({
      index: l.index,
      serial: l.serial,
      backstore: l.name,
      backingPath: l.backingPath,
    })),
  }
  return createHash('sha256').update(stable(facts)).digest('hex')
}

// ---------------------------------------------------------------------------
// Gates — each is the route's refusal, written once, run at both doors
// ---------------------------------------------------------------------------

/** LIO present, and the live tree is not a degraded restore (every sequence ends in `saveconfig`, GT-22). */
export const saveableGate: Gate<TargetObject> = async ({ state }) => {
  const refused = assertInstalled(state.ctx) ?? assertSaveable(state.ctx, state.targets)
  return refused ? conflict(refused) : null
}

/**
 * Is this target ANAS's to change? — {@link handsOffRefusal}, defined beside
 * `assertSaveable` in `iscsi-mutate.ts` (Repair's plan and the degraded
 * refusal ask it too) and re-exported here for the verbs that import it.
 */
export { handsOffRefusal }

/** A foreign or multi-TPG target is hands-off: {@link handsOffRefusal}. */
export const foreignGate: Gate<TargetObject> = async ({ target }) => {
  const refused = handsOffRefusal(target)
  return refused ? conflict(refused) : null
}

/**
 * cr3 (sessionCount): a session gate whose read did not see. An ACL whose
 * configfs `info` could not be read is not "nobody logged in" — the verb that
 * would drop such a session refuses until the read answers.
 */
export function sessionsUnreadableRefusal(what: string, action: string): IscsiRefusal {
  return {
    reason: 'sessions-unknown',
    message: `The session state of ${what} could not be read (an initiator ACL's configfs 'info' was unreadable), so ANAS `
      + `cannot tell whether an initiator is logged in. ${action} is refused until it reads back — a live initiator is never `
      + `yanked on a guess. Refresh the iSCSI screen and retry.`,
  }
}

/**
 * A target with a live session is never deleted: every session drops and each
 * host keeps a stale device with no kernel message (GT-42). A session that
 * could not be read refuses as well (cr3).
 */
export const targetSessionsGate: Gate<TargetObject> = async ({ target }) => {
  if (target.sessionsUnknown === true)
    return conflict(sessionsUnreadableRefusal(`target '${target.iqn}'`, 'Deleting it'))
  if (target.sessions.length === 0)
    return null
  const initiators = target.sessions.map(s => s.initiatorIqn)
  return conflict({
    reason: 'live-sessions',
    message: `Target '${target.iqn}' has ${initiators.length} live session${initiators.length === 1 ? '' : 's'} `
      + `(${initiators.join(', ')}). Deleting it drops ${initiators.length === 1 ? 'it' : 'them'} and leaves a stale device `
      + `on each host with no kernel message. Log the initiators out first. This refusal has no confirm bypass.`,
  })
}

/** A target with LUNs is never deleted: the LUNs go through their own door, where destroyBacking is the per-LUN choice. */
export const targetLunsGate: Gate<TargetObject> = async ({ target }) => {
  // Every TPG's LUNs (cr3, ISCSI-H2): `/iscsi delete` takes them all.
  const luns = targetTpgs(target).flatMap(t => t.luns)
  if (luns.length === 0)
    return null
  return conflict({
    reason: 'target-has-luns',
    message: `Target '${target.iqn}' still has ${luns.length} LUN${luns.length === 1 ? '' : 's'} `
      + `(${luns.map(l => l.name).join(', ')}). Delete the LUNs first `
      + `(their backing zvols/images are kept unless you choose destroyBacking on each). This refusal has no confirm bypass.`,
  })
}

/**
 * A new LUN's name is free NODE-WIDE: the backstore name is a global namespace
 * in LIO, not per-target, and it is the SCSI model string every initiator sees
 * (GT-15). The add-LUN door and the restore-as-a-new-LUN door both ask it.
 *
 * `restoreRunning` (cr3.lunrestore, review2 F): the caller's job view — a
 * backstore a whole-image restore is writing into right now is named as such,
 * and the operator is never told to remove it.
 */
export function lunNameFreeGate(name: string, restoreRunning?: (backingPath: string) => string | undefined): Gate<TargetObject> {
  return async ({ state }) => {
    if (state.targets.some(t => targetTpgs(t).some(g => g.luns.some(l => l.name === name)))) {
      return conflict({
        reason: 'name-taken',
        message: `A LUN named '${name}' already exists on this node. The name is the SCSI model string initiators see, so it has to be unique.`,
      })
    }
    // cr3 (ISCSI-M5): a BACKSTORE of that name that no LUN maps — live, or in
    // the saved configuration — takes the name too. The create would fail
    // ("exists") or, worse, the add's undo would delete a backstore this job
    // never made; and a persisted one comes back at the next boot.
    const live = state.ctx.live.backstores.find(b => b.name === name)
    const persisted = (state.ctx.persisted?.storageObjects ?? []).some(o => o.name === name)
    if (live || persisted) {
      const job = live?.udevPath ? restoreRunning?.(live.udevPath) : undefined
      const unique = 'The name is the SCSI model string initiators see, so it has to be unique'
      return conflict({
        reason: 'name-taken',
        message: live
          ? job
            ? `A backstore named '${name}' exists on this node and no LUN maps it: a whole-image restore is writing its image `
            + `right now (job ${job}). ${unique}: pick another name.`
            : `A backstore named '${name}' exists on this node and no LUN maps it. ${unique}: pick another name, or remove `
              + `that backstore with targetcli.`
          : `A backstore named '${name}' is in the saved configuration of this node (not in the live one), and no LUN maps it. `
            + `${unique}: pick another name. The next iSCSI change in ANAS saves the configuration without it.`,
      })
    }
    return null
  }
}

/** Enable/disable refuses a no-op rather than pretending it did something. */
export function notAlreadyGate(action: 'enable' | 'disable'): Gate<TargetObject> {
  return async ({ target }) => target.enabled === (action === 'enable')
    ? { status: 400, code: 'VALIDATION_ERROR', message: `Target '${target.iqn}' is already ${action}d` }
    : null
}

/**
 * The sentence a LUN verb refuses with while an initiator is logged in on it
 * (GT-42: LIO itself refuses nothing). `why` is the verb's own clause.
 */
export function lunSessionsMessage(iqn: string, index: number, initiators: string[], why: string): string {
  return `LUN ${index} of '${iqn}' has ${initiators.length} live session${initiators.length === 1 ? '' : 's'} `
    + `(${initiators.join(', ')}). ${why} Log the initiator out first. This refusal has no confirm bypass.`
}

/** The LUN-delete clause of {@link lunSessionsMessage} (the route's sentence since iscsi.4). */
export const LUN_DELETE_SESSIONS_WHY = 'LIO would delete it anyway and leave a stale device on the initiator with no kernel message — so ANAS refuses.'

// ---------------------------------------------------------------------------
// The target views and specs
// ---------------------------------------------------------------------------

/** `iSCSI target '<iqn>'` — how a target's messages name it. */
export function targetWhat(iqn: string): string {
  return `iSCSI target '${iqn}'`
}

/** The target as a guard object: IQN identity, configuration revision. */
export function targetView(
  deps: IscsiGuardDeps,
  iqn: string,
  opts: { seed?: IscsiState, revision?: boolean, scope?: ObjectView<TargetObject>['scope'], scopeLabels?: Record<string, string> } = {},
): ObjectView<TargetObject> {
  const readState = iscsiStateReader(deps, opts.seed)
  return {
    what: targetWhat(iqn),
    read: async (reads) => {
      const state = await readState(reads)
      const target = state.targets.find(t => t.iqn === iqn)
      return target ? { state, target } : null
    },
    notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `iSCSI target '${iqn}' not found` }),
    id: async ({ target }) => ({ iqn: target.iqn }),
    ...(opts.revision === false ? {} : { revision: async ({ target }: TargetObject) => targetRevision(target) }),
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.scopeLabels ? { scopeLabels: opts.scopeLabels } : {}),
    unbound: part => `Could not read the ${part === 'scope' ? 'live sessions' : 'configuration'} of ${targetWhat(iqn)} — refusing a change that cannot be bound to it`,
  }
}

/**
 * What a target edit does to the sessions that are live NOW: the initiators
 * whose ACL it removes (their session drops at once, GT-36) and the
 * connections that came in on a portal it removes (the session keeps running,
 * the next reconnect through that address fails, LP6). The SAME diff
 * `updateIscsiTarget` applies.
 */
export function updateSessionImpact(
  target: IscsiTargetDetail,
  req: Pick<UpdateIscsiTargetRequest, 'acls' | 'portals'>,
): { dropped: string[], stranded: { initiator: string, address: string, port: number }[] } {
  const dropped = req.acls === undefined
    ? []
    : target.sessions
        .filter(s => !req.acls?.some(a => a.initiatorIqn === s.initiatorIqn))
        .map(s => s.initiatorIqn)
  const removedPortals = req.portals === undefined
    ? []
    : target.portals.filter(p => !req.portals?.some(w => portalKey(w) === portalKey(p)))
  const stranded: { initiator: string, address: string, port: number }[] = []
  for (const p of removedPortals) {
    // A connection reports an address and no port (LP6), so a session is
    // matched to a removed portal by address.
    for (const s of target.sessions) {
      if (s.connections.some(c => c.address.toLowerCase() === p.address.toLowerCase()))
        stranded.push({ initiator: s.initiatorIqn, address: p.address, port: p.port })
    }
  }
  return { dropped, stranded }
}

/**
 * The scope a target edit binds: the sessions it affects. A session that logs
 * in on an ACL the edit removes AFTER the request (no confirm was asked, or the
 * confirm named other initiators) fails the job STATE_CHANGED — the operator
 * never agreed to drop it.
 */
export function updateSessionScope(req: Pick<UpdateIscsiTargetRequest, 'acls' | 'portals'>): NonNullable<ObjectView<TargetObject>['scope']> {
  return async ({ target }) => {
    const impact = updateSessionImpact(target, req)
    return {
      dropped: sorted(impact.dropped, s => s).join(', '),
      stranded: impact.stranded.map(s => `${s.initiator} via ${s.address}:${s.port}`).sort().join(', '),
    }
  }
}

/**
 * cr3 (sessionCount): a target edit that removes an ACL or a portal is
 * confirmed by the sessions it drops or strands — and with a session that
 * could not be read, that list is not known to be complete. Refused until the
 * read answers; an edit that removes nothing (a secret rotation, an added ACL)
 * touches no session and passes.
 */
export function updateSessionsReadableGate(req: Pick<UpdateIscsiTargetRequest, 'acls' | 'portals'>): Gate<TargetObject> {
  return async ({ target }) => {
    if (target.sessionsUnknown !== true)
      return null
    const removesAcl = req.acls !== undefined && target.acls.some(a => !req.acls?.some(w => w.initiatorIqn === a.initiatorIqn))
    const removesPortal = req.portals !== undefined && target.portals.some(p => !req.portals?.some(w => portalKey(w) === portalKey(p)))
    if (!removesAcl && !removesPortal)
      return null
    return conflict(sessionsUnreadableRefusal(`target '${target.iqn}'`, `An edit that removes ${removesAcl ? 'an initiator ACL' : 'a portal'}`))
  }
}

export const UPDATE_SESSION_SCOPE_LABELS: Record<string, string> = {
  dropped: 'live sessions this edit drops',
  stranded: 'live connections on portals this edit removes',
}

/**
 * The job door for every iSCSI verb: `guarded` (re-read → id → revision →
 * scope → every gate → body) UNDER the daemon-wide iSCSI mutex, so the re-read
 * and the `targetcli` sequence it decides are one step no other LIO mutation
 * can interleave with. The body must not take `withIscsiLock` itself (the
 * mutex is not reentrant).
 */
export function iscsiGuarded<O>(spec: GuardSpec<O>, pass: GuardPass<O>, body: GuardedBody<O>): JobHandler {
  const handler = guarded(spec, pass, body)
  return (updateProgress, ctx) => withIscsiLock(() => handler(updateProgress, ctx))
}

/**
 * A LUN verb's lock claims (WAVE3-DESIGN §4.2): the target's key — the verb
 * changes the target's LUN set or a mapping in it — and the LUN's own by unit
 * serial, both exclusive. A LUN whose serial cannot be read is locked by its
 * target alone (every LUN verb on that target serialises behind it anyway).
 */
export function lunClaims(iqn: string, serial: string | null): LockClaim[] {
  return [iscsiTargetClaim(iqn), ...(serial ? [iscsiLunClaim(serial)] : [])]
}

/**
 * The repair door's claims: one target key per target its plan touches and one
 * LUN key per repaired LUN that has a serial (the queue folds duplicates).
 */
export function repairClaims(items: { targetIqn: string, serial: string | null }[]): LockClaim[] {
  return items.flatMap(i => lunClaims(i.targetIqn, i.serial))
}

/**
 * Re-read a target NOW and run `gates` on it, for a job that owns its own
 * locking sections (the image restores, which must not hold the iSCSI mutex
 * across an hours-long stream): returns the fresh target, or throws the first
 * gate's refusal as a {@link GuardRefusalError} — the job's error code is the
 * route's.
 */
export async function refreshTarget(deps: IscsiGuardDeps, iqn: string, gates: Gate<TargetObject>[]): Promise<IscsiTargetDetail> {
  const view = targetView(deps, iqn, { revision: false })
  const pre = await guardCheck({ operation: 'iscsi.target.refresh', object: view, gates })
  if ('refusal' in pre)
    throw new GuardRefusalError(pre.refusal)
  return pre.object.target
}

// ---------------------------------------------------------------------------
// The LUN view (delete)
// ---------------------------------------------------------------------------

/** `LUN <n> of '<iqn>'` — how a LUN's messages name it. */
export function lunWhat(iqn: string, index: number): string {
  return `LUN ${index} of '${iqn}'`
}

/** `zfs list` on a dataset that is not there (captured: zfs-list-t-volume-absent.stderr.txt). */
const ZFS_DATASET_ABSENT_RE = /dataset does not exist/

/**
 * A zvol's OWN snapshots, by name (story `iscsi.4`, M5) — the same argument
 * builder and parser the Datasets door uses, direct children only.
 *
 * cr3 (ISCSI-M3): FAIL-CLOSED. This used to answer `[]` for a `zfs list` that
 * failed, so the gate passed and the plain `zfs destroy` was left to refuse
 * inside the job. `null` now means "could not read" and the gate refuses with
 * the reason. A volume that is not there has no snapshots (`[]`): what happens
 * to an absent backing is the served-device gate's and the job's to say.
 */
export async function zvolSnapshotNames(executor: CommandExecutor, dataset: string): Promise<string[] | null> {
  const r = await executor.exec(ZFS, zfsSnapshotListArgs(dataset))
  if (r.exitCode !== 0)
    return ZFS_DATASET_ABSENT_RE.test(r.stderr) ? [] : null
  if (!r.stdout.trim())
    return []
  try {
    return parseSnapshotNames(r.stdout)
  }
  catch {
    return null
  }
}

/** The served-device verdict of one guard run, read once and shared by the gate and the scope. */
function servedVerdict(deps: IscsiGuardDeps, reads: GuardReads, lun: IscsiLun, live: IscsiReadContext['live']): ReturnType<typeof checkServedDevice> {
  return reads.once(`iscsi:served:${lun.index}`, () => checkServedDevice(live, lun, statDeviceFrom(deps.paths)))
}

/**
 * The LUN delete's guard spec. `destroyBacking` adds the two gates that are
 * about the backing object (the path must name the device LIO serves, ident.2;
 * a zvol with snapshots is refused before anything is unmapped, M5) and binds
 * the served device as the scope — the object the operator agreed to destroy.
 */
export function lunDeleteSpec(
  deps: IscsiGuardDeps,
  iqn: string,
  index: number,
  destroyBacking: boolean,
  opts: { seed?: IscsiState, locks: GuardSpec<LunObject>['locks'] },
): GuardSpec<LunObject> {
  const readState = iscsiStateReader(deps, opts.seed)
  const what = lunWhat(iqn, index)

  const exists: Gate<LunObject> = async ({ target, lun }) => lun
    ? null
    : { status: 404, code: 'NOT_FOUND', message: `Target '${target.iqn}' has no LUN ${index}` }

  const sessions: Gate<LunObject> = async ({ target, lun }) => {
    if (lun?.connectedInitiatorsUnknown === true)
      return conflict(sessionsUnreadableRefusal(lunWhat(target.iqn, index), 'Deleting it'))
    if (!lun || lun.connectedInitiators.length === 0)
      return null
    return conflict({
      reason: 'session-open',
      message: lunSessionsMessage(target.iqn, index, lun.connectedInitiators, LUN_DELETE_SESSIONS_WHY),
    })
  }

  // ident.2 (audit #8): destroyBacking runs `zfs destroy` on the volume the
  // PATH names (or unlinks the file at it), so that object must be the one
  // LIO serves.
  const served: Gate<LunObject> = async ({ state, lun }, reads) => {
    if (!lun)
      return null
    const verdict = await servedVerdict(deps, reads, lun, state.ctx.live)
    return verdict.refusal ? conflict(verdict.refusal) : null
  }

  // M5: the job destroys a zvol with a PLAIN `zfs destroy` — never `-r` — and
  // that refuses a volume that has snapshots INSIDE the job, after the LUN is
  // unmapped and its backstore deleted, before `saveconfig`. So the snapshots
  // are a gate, named in the refusal, at both doors.
  const snapshots: Gate<LunObject> = async ({ lun }) => {
    if (!lun || lun.kind !== 'zvol')
      return null
    const dataset = lun.dataset ?? zvolDataset(lun.backingPath)
    const names = await zvolSnapshotNames(deps.executor, dataset)
    if (names === null) {
      return conflict({
        reason: 'snapshots-unreadable',
        message: `The snapshots of the volume ${dataset} could not be listed, so ANAS cannot prove destroying it would `
          + `not fail half-way (a volume with snapshots is never destroyed). Retry, or delete the LUN without "Also destroy" `
          + `and keep the volume.`,
      })
    }
    if (names.length === 0)
      return null
    const shown = names.slice(0, 10).join(', ')
    const more = names.length > 10 ? `, and ${names.length - 10} more` : ''
    return conflict({
      reason: 'zvol-has-snapshots',
      message: `The volume ${dataset} has ${names.length} snapshot${names.length === 1 ? '' : 's'} `
        + `(${shown}${more}). Destroying the backing destroys the VOLUME only — ANAS never sweeps snapshots away as a `
        + `side effect, and 'zfs destroy' refuses a volume that still has any. Remove them on the Datasets screen first, `
        + `or delete the LUN without "Also destroy" and keep the volume. This refusal has no confirm bypass.`,
    })
  }

  // cr3 (ISCSI-M6): destroying the backing of a backstore another LUN still
  // maps would pull it from under that LUN (and any session on it).
  const shared: Gate<LunObject> = async ({ state, target, lun }) => {
    if (!lun)
      return null
    const others = lunsMappingBackstore(state.ctx.live, lun.plugin, lun.name, { targetIqn: target.iqn, tpgTag: target.tpgTag, lunIndex: lun.index })
    if (others.length === 0)
      return null
    return conflict({
      reason: 'backstore-shared',
      message: `The backstore '${lun.name}' is also mapped as ${others.map(o => `LUN ${o.lunIndex} of '${o.targetIqn}'${o.tpgTag === 1 ? '' : ` (TPG ${o.tpgTag})`}`).join(', ')}. `
        + `Destroying its backing would pull it from under that LUN too. Delete the LUN without "Also destroy" — ANAS then unmaps this LUN only and keeps the backstore. This refusal has no confirm bypass.`,
    })
  }

  // cr3: an image whose dataset could not be judged (the mountpoint table was
  // unreadable) is never destroyed — it may be inside PVE's footprint.
  const ownerKnown: Gate<LunObject> = async ({ lun }) => lun?.backingOwnershipUnknown === true
    ? conflict(ownershipUnknownRefusal(lun.backingPath))
    : null

  return {
    operation: 'iscsi.lun.delete',
    object: {
      what,
      read: async (reads) => {
        const state = await readState(reads)
        const target = state.targets.find(t => t.iqn === iqn)
        return target ? { state, target, lun: target.luns.find(l => l.index === index) } : null
      },
      notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `iSCSI target '${iqn}' not found` }),
      // ident.2 (audit #9): the serial and the backstore, never the index —
      // a LUN re-created at the index is a different LUN.
      id: async ({ lun }) => lun ? { serial: lun.serial ?? '(unknown)', backstore: lun.name, path: lun.backingPath } : null,
      ...(destroyBacking
        ? {
            scope: async ({ state, lun }: LunObject, reads: GuardReads) => {
              if (!lun)
                return null
              const verdict = await servedVerdict(deps, reads, lun, state.ctx.live)
              return verdict.device ? { backing: verdict.device } : null
            },
          }
        : {}),
      scopeLabels: { backing: 'the backing device to destroy' },
      unbound: part => part === 'scope'
        ? `Could not verify which device ${what} serves — refusing to destroy a backing that cannot be bound to it`
        : `Could not read the identity of ${what} — refusing a delete that cannot be bound to it`,
    },
    gates: [
      saveableGate,
      foreignGate,
      exists,
      sessions,
      ...(destroyBacking ? [ownerKnown, shared, served, snapshots] : []),
    ],
    ...(opts.locks ? { locks: opts.locks } : {}),
  }
}
