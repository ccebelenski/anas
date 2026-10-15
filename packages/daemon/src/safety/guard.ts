import type { ErrorCode } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { LockClaim, LockMode } from '../jobs/locks.js'
import type { JobContext, JobHandler } from '../jobs/queue.js'
import type { BoundId, ConfirmMismatch, ConfirmStore } from './confirm.js'
import { describeBound, IDENTITY_MISMATCH, IdentityMismatchError, identityMismatchMessage, sameBound } from './stable-id.js'

/**
 * The guard (story cr.32, docs/WAVE3-DESIGN.md §3, EPICS §2 ruling (j): jobs
 * re-read and re-gate through the one `safety/` helper).
 *
 * A verb that changes an object describes itself ONCE as a {@link GuardSpec}:
 * how to read the object, its stable id (is it the same object?), optionally
 * its revision (is it still in the state the request was computed from?) and
 * its scope (the derived set that decides the blast radius), the list of gate
 * functions, and the warn-only advisories. Both doors run that one spec:
 *
 *  - the ROUTE runs {@link guardCheck} (read → gates → id → revision → scope →
 *    advisories), answers a gate's refusal as its 4xx, and binds the whole
 *    validated request plus id, revision and scope into the confirm code
 *    ({@link guardConfirm});
 *  - the JOB runs {@link guarded}: read → id → revision → scope → every gate →
 *    advisories → body, each step against facts read NOW (a fresh
 *    {@link GuardReads}; nothing read at the request reaches the job's gates).
 *    A refusal fails the job with the gate's own error code and sentence.
 *
 * A gate is written once and called from both doors; nothing else may
 * re-implement it.
 *
 * Locks (cr.33, §4): the spec names the object's lock claims, computed by the
 * route door from what it read (so the keys are stable ids, never names that
 * a rename or a namesake could alias). `guardCheck` returns them on the pass
 * and the route hands them to `jobQueue.submit(…, { locks: pre.locks })`; the
 * queue starts the job only when it holds every one, and the job door's
 * re-read then sees whatever ran before it. The key builders are at the end
 * of this file.
 */

/** What a gate answers when it refuses: the route's 4xx and the job's error, one object. */
export interface Refusal {
  status: 400 | 403 | 404 | 409 | 503
  code: ErrorCode
  /** The sentence the operator reads; names the object. */
  message: string
  /** A machine-readable cause the panel keys on (`system-pool`, `held-by-lun`). */
  reason?: string
}

/** The `{ error }` envelope a refusal answers at the route door. */
export function refusalBody(refusal: Refusal): { error: { code: ErrorCode, message: string, reason?: string } } {
  return { error: { code: refusal.code, message: refusal.message, ...(refusal.reason ? { reason: refusal.reason } : {}) } }
}

/** Set the refusal's status on the reply and return its body (`return sendRefusal(reply, r)`). */
export function sendRefusal(reply: FastifyReply, refusal: Refusal): ReturnType<typeof refusalBody> {
  reply.code(refusal.status)
  return refusalBody(refusal)
}

/**
 * A job refused by a gate (or by a revision/scope change). The queue reads
 * `jobErrorCode` (`jobs/queue.ts`), so the job's `error.code` is the refusal's
 * code — the UI reads a job refusal like the 409 it would have got.
 */
export class GuardRefusalError extends Error {
  readonly jobErrorCode: string
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
    this.name = 'GuardRefusalError'
    this.jobErrorCode = refusal.code
  }
}

/**
 * One guard run's read cache: gates that need the same fact (one `zpool list`,
 * one PVE footprint, one LIO claims read) share it. Created fresh for every
 * run — the route's run and the job's run never share one.
 */
export class GuardReads {
  private memo = new Map<string, Promise<unknown>>()

  once<T>(key: string, read: () => Promise<T>): Promise<T> {
    let pending = this.memo.get(key) as Promise<T> | undefined
    if (!pending) {
      pending = read()
      this.memo.set(key, pending)
    }
    return pending
  }
}

/**
 * A gate reads what it needs (through `reads`) and refuses or passes. Fail
 * closed: a fact it cannot read is a refusal, never a pass.
 */
export type Gate<O> = (object: O, reads: GuardReads) => Promise<Refusal | null>

/** A warn-only fact (cr.24 references): listed in the confirm, re-read in the job, never a refusal. */
export interface Advisory {
  /** Stable key: the job reports an advisory whose key the confirm did not list. */
  key: string
  warning: string
}

/** Which part of the object view could not be read. */
export type BoundPart = 'id' | 'revision' | 'scope'

export interface ObjectView<O> {
  /** How a message names the object: `Pool 'tank'`. */
  what: string
  /** Read the object now; null = it does not exist. */
  read: (reads: GuardReads) => Promise<O | null>
  /** The route's answer when `read` finds nothing. Default: 404 NOT_FOUND "<what> not found". */
  notFound?: () => Refusal
  /** Same object? (pool/dataset guid, VG UUID, LUN serial, uid …); null = unreadable. */
  id: (object: O, reads: GuardReads) => Promise<BoundId | null>
  /** Same state? (edit-shaped verbs: a hash of the facts the request was computed from.) */
  revision?: (object: O, reads: GuardReads) => Promise<string | null>
  /** The bound blast radius (the leaves a cleanup wipes, a recursive destroy's children). */
  scope?: (object: O, reads: GuardReads) => Promise<BoundId | null>
  /** How a scope key reads in a message (`leaves` → `the disks to wipe`). */
  scopeLabels?: Record<string, string>
  /** The route's sentence when id, revision or scope cannot be read (the operation is refused). */
  unbound: (part: BoundPart) => string
}

export interface GuardSpec<O> {
  /** The job's operation name, also the confirm operation. */
  operation: string
  object: ObjectView<O>
  /** Every gate, in order — the SAME list at both doors. */
  gates: Gate<O>[]
  /** Warn-only facts; never refuse. */
  advisories?: (object: O, reads: GuardReads) => Promise<Advisory[]>
  /**
   * The object locks the job takes (cr.33, §4.2), from what the route door
   * read and bound: the stable id is in `bound.id`. Built with the key
   * builders below. Absent = the job takes no lock.
   */
  locks?: (object: O, bound: GuardBound, reads: GuardReads) => Promise<LockClaim[]>
}

/** What the confirm binds beside the request, and what the job compares. */
export interface GuardBound {
  id: BoundId
  revision?: string
  scope?: BoundId
}

/** The route door passed: the object, what it was bound to, and the advisories it listed. */
export interface GuardPass<O> {
  object: O
  bound: GuardBound
  advisories: Advisory[]
  /** The claims the job is submitted with: `jobQueue.submit(…, { locks: pre.locks })`. */
  locks: LockClaim[]
}

async function runGates<O>(gates: Gate<O>[], object: O, reads: GuardReads): Promise<Refusal | null> {
  for (const gate of gates) {
    const refused = await gate(object, reads)
    if (refused)
      return refused
  }
  return null
}

function unboundRefusal<O>(view: ObjectView<O>, part: BoundPart): Refusal {
  return { status: 409, code: 'CONFLICT', message: view.unbound(part) }
}

/**
 * The route door: read the object, run every gate, read what the confirm
 * binds, read the advisories. A refusal is answered with {@link sendRefusal};
 * a pass goes to {@link guardConfirm} and then {@link guarded}.
 */
export async function guardCheck<O>(spec: GuardSpec<O>): Promise<GuardPass<O> | { refusal: Refusal }> {
  const view = spec.object
  const reads = new GuardReads()
  const object = await view.read(reads)
  if (object === null)
    return { refusal: view.notFound?.() ?? { status: 404, code: 'NOT_FOUND', message: `${view.what} not found` } }

  const refused = await runGates(spec.gates, object, reads)
  if (refused)
    return { refusal: refused }

  const id = await view.id(object, reads)
  if (!id)
    return { refusal: unboundRefusal(view, 'id') }
  const bound: GuardBound = { id }
  if (view.revision) {
    const revision = await view.revision(object, reads)
    if (revision === null)
      return { refusal: unboundRefusal(view, 'revision') }
    bound.revision = revision
  }
  if (view.scope) {
    const scope = await view.scope(object, reads)
    if (!scope)
      return { refusal: unboundRefusal(view, 'scope') }
    bound.scope = scope
  }

  const advisories = spec.advisories ? await spec.advisories(object, reads) : []
  const locks = spec.locks ? await spec.locks(object, bound, reads) : []
  return { object, bound, advisories, locks }
}

/** `the disks to wipe: a, b` — a scope as a message names it. */
function describeScope(scope: BoundId | undefined, labels: Record<string, string> = {}): string {
  if (!scope)
    return 'nothing'
  return Object.keys(scope).sort().map(k => `${labels[k] ?? k}: ${scope[k] || 'none'}`).join('; ')
}

/** The job-time sentence when the bound scope moved. */
function scopeChangedMessage<O>(view: ObjectView<O>, confirmed: BoundId | undefined, now: BoundId | null): string {
  return `${view.what} changed since you confirmed (${describeScope(confirmed, view.scopeLabels)} at the confirmation, `
    + `${now ? describeScope(now, view.scopeLabels) : 'unreadable'} now) — nothing was done; confirm again`
}

/**
 * Re-read the object and re-run every check of the spec against facts read
 * now. Throws {@link IdentityMismatchError} (gone or a different object) or
 * {@link GuardRefusalError} (state or scope changed, or a gate refused).
 *
 * Exported for a job that binds a SECOND spec (cr.43 step 5: the SMB verbs
 * bind their ACL grant's spec beside the share's own): the job door runs the
 * verb's spec, and the body re-runs the second spec's checks here before its
 * first act.
 */
export async function reverify<O>(spec: GuardSpec<O>, confirmed: GuardBound): Promise<{ object: O, reads: GuardReads }> {
  const view = spec.object
  const reads = new GuardReads()
  const object = await view.read(reads)
  if (object === null)
    throw new IdentityMismatchError(view.what, confirmed.id, null)

  const id = await view.id(object, reads)
  if (!id || !sameBound(confirmed.id, id))
    throw new IdentityMismatchError(view.what, confirmed.id, id)

  if (view.revision) {
    const revision = await view.revision(object, reads)
    if (revision === null || revision !== confirmed.revision) {
      throw new GuardRefusalError({
        status: 409,
        code: 'STATE_CHANGED',
        message: `${view.what} changed since you confirmed — nothing was done; reload and confirm again`,
      })
    }
  }

  if (view.scope) {
    const scope = await view.scope(object, reads)
    if (!scope || !confirmed.scope || !sameBound(confirmed.scope, scope)) {
      throw new GuardRefusalError({ status: 409, code: 'STATE_CHANGED', message: scopeChangedMessage(view, confirmed.scope, scope) })
    }
  }

  const refused = await runGates(spec.gates, object, reads)
  if (refused)
    throw new GuardRefusalError(refused)
  return { object, reads }
}

/** What a guarded job body receives beside the object. */
export interface GuardedContext<O> extends JobContext {
  updateProgress: (message: string) => void
  /** The id, revision and scope the confirm was bound to. */
  bound: GuardBound
  /** The job run's read cache — the body reuses what the checks just read. */
  reads: GuardReads
  /** Advisories the job found that the confirm did not list (their warnings). */
  newAdvisories: string[]
  /**
   * Re-acquire the job's locks if it released them (cr.38), then re-run read →
   * id → revision → scope → gates now (a long job calls it before each act
   * step). Returns the fresh object; throws like the first run does.
   */
  reguard: () => Promise<O>
}

export type GuardedBody<O> = (object: O, ctx: GuardedContext<O>) => Promise<unknown>

/**
 * The job door: the handler `jobQueue.submit` runs. Every check of the spec
 * runs again before the body; the body runs only when all pass.
 */
export function guarded<O>(spec: GuardSpec<O>, pass: GuardPass<O>, body: GuardedBody<O>): JobHandler {
  return async (updateProgress, jobCtx) => {
    const { object, reads } = await reverify(spec, pass.bound)
    const listed = new Set(pass.advisories.map(a => a.key))
    const fresh = spec.advisories ? await spec.advisories(object, reads) : []
    const newAdvisories = fresh.filter(a => !listed.has(a.key)).map(a => a.warning)
    return body(object, {
      ...jobCtx,
      updateProgress,
      bound: pass.bound,
      reads,
      newAdvisories,
      // cr.38: a job that gave its locks back (`release()`) takes them again
      // through the queue's FIFO before anything is re-read.
      reguard: async () => {
        await jobCtx.reacquire()
        return (await reverify(spec, pass.bound)).object
      },
    })
  }
}

// ---------------------------------------------------------------------------
// The bound confirm (M3, docs/WAVE3-DESIGN.md §5.2)
// ---------------------------------------------------------------------------

/** Bound keys for revision and scope carry a prefix no id key has. */
const REVISION_KEY = '@revision'
const SCOPE_PREFIX = '@scope:'

/** The id, revision and scope as the one flat record the confirm store signs. */
function boundSignature(bound: GuardBound): BoundId {
  const out: BoundId = { ...bound.id }
  if (bound.revision !== undefined)
    out[REVISION_KEY] = bound.revision
  for (const [k, v] of Object.entries(bound.scope ?? {}))
    out[`${SCOPE_PREFIX}${k}`] = v
  return out
}

/** The id part of a signed bound record. */
function idPart(bound: BoundId): BoundId {
  return Object.fromEntries(Object.entries(bound).filter(([k]) => !k.startsWith('@')))
}

/** The scope part of a signed bound record, prefix stripped. */
function scopePart(bound: BoundId): BoundId {
  return Object.fromEntries(Object.entries(bound)
    .filter(([k]) => k.startsWith(SCOPE_PREFIX))
    .map(([k, v]) => [k.slice(SCOPE_PREFIX.length), v]))
}

/** `cleanup on` / `force off` / `mode "x"` — one request field as a message names it. */
function describeField(field: string, value: unknown): string {
  if (value === true)
    return `${field} on`
  if (value === false || value === undefined)
    return `${field} off`
  return `${field} ${JSON.stringify(value)}`
}

/** The validated request with the presentation-only fields left out. */
export function signedRequest(validated: Record<string, unknown>, presentationOnly: Record<string, string> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validated).filter(([k]) => !(k in presentationOnly)))
}

export interface GuardConfirmOpts {
  /**
   * The WHOLE validated request: path params, the Zod-parsed body with its
   * defaults applied, and the normalised query flags. Every field is signed.
   */
  validated: Record<string, unknown>
  /** The fields of `validated` that address the object (path params). */
  address: string[]
  /**
   * The only way to leave a field out of the signature: name it here with a
   * one-line reason. A test lists every route's entries.
   */
  presentationOnly?: Record<string, string>
  message: string
  warnings: string[]
}

/** Mint a fresh code and answer the 409 with `error`. */
function challenge(
  store: ConfirmStore,
  reply: FastifyReply,
  operation: string,
  params: Record<string, unknown>,
  bound: BoundId,
  error: Record<string, unknown>,
): false {
  const { code, expiresAt } = store.generateCode(operation, params, bound)
  reply.code(409)
  reply.header('X-Anas-Confirm-Code', code)
  reply.header('X-Anas-Confirm-Expires', expiresAt)
  reply.send({ error })
  return false
}

/** The 409 a resend gets when its code was minted for another request or another object. */
function mismatchError<O>(
  spec: GuardSpec<O>,
  pass: GuardPass<O>,
  params: Record<string, unknown>,
  mismatch: ConfirmMismatch,
  opts: GuardConfirmOpts,
): Record<string, unknown> {
  const view = spec.object
  // A different object outranks everything: the request may even be identical.
  const wasId = idPart(mismatch.was.bound)
  if (mismatch.bound.some(k => !k.startsWith('@'))) {
    return {
      code: IDENTITY_MISMATCH,
      message: identityMismatchMessage(view.what, wasId, pass.bound.id),
      warnings: [
        `${view.what} changed since you confirmed (${describeBound(wasId)} then, ${describeBound(pass.bound.id)} now). Confirm again only if this is the one you mean.`,
        ...opts.warnings,
      ],
      confirmed: wasId,
      current: pass.bound.id,
    }
  }
  // A scope present on one side only follows from a changed flag (cleanup on
  // binds the leaves, cleanup off binds none) — the flag is the change to name.
  const nowBound = boundSignature(pass.bound)
  const scopeKeys = mismatch.bound
    .filter(k => k.startsWith(SCOPE_PREFIX) && k in mismatch.was.bound && k in nowBound)
    .map(k => k.slice(SCOPE_PREFIX.length))
  if (mismatch.params.length > 0 || scopeKeys.length > 0) {
    const parts: string[] = []
    if (mismatch.params.length > 0) {
      const then = mismatch.params.map(f => describeField(f, mismatch.was.params[f])).join(', ')
      const now = mismatch.params.map(f => describeField(f, params[f])).join(', ')
      parts.push(`You confirmed with ${then}; this request has ${now}`)
    }
    if (scopeKeys.length > 0) {
      const was = scopePart(mismatch.was.bound)
      const labels = view.scopeLabels ?? {}
      parts.push(scopeKeys.map(k => `${labels[k] ?? k} changed since you confirmed (${was[k] || 'none'} then, ${pass.bound.scope?.[k] || 'none'} now)`).join('; '))
    }
    const sentence = `${parts.join('; ')} — confirm again`
    return {
      code: 'CONFIRM_SCOPE_CHANGED',
      message: sentence,
      warnings: [sentence, ...opts.warnings],
      changed: [...mismatch.params, ...scopeKeys],
    }
  }
  const sentence = `${view.what} changed since you confirmed — confirm again`
  return { code: 'STATE_CHANGED', message: sentence, warnings: [sentence, ...opts.warnings] }
}

/**
 * The confirm door (successor of `confirmGateBound`): the code signs the
 * operation, the whole validated request (minus named presentation-only
 * fields), the id, the revision and the scope.
 *
 *  - a code minted for exactly this → true (consumed); the caller submits;
 *  - a code minted for this object under a different id → 409 IDENTITY_MISMATCH;
 *  - a code minted for this object with a different request field or scope →
 *    409 CONFIRM_SCOPE_CHANGED naming the fields; a different revision → 409
 *    STATE_CHANGED — each with a fresh code, the old one consumed;
 *  - anything else (no code, unknown, expired, another object) → 409
 *    CONFIRMATION_REQUIRED with a fresh code.
 *
 * Returns false when it answered; the caller must `return reply`.
 */
export function guardConfirm<O>(
  store: ConfirmStore,
  request: FastifyRequest,
  reply: FastifyReply,
  spec: GuardSpec<O>,
  pass: GuardPass<O>,
  opts: GuardConfirmOpts,
): boolean {
  const params = signedRequest(opts.validated, opts.presentationOnly)
  const bound = boundSignature(pass.bound)
  const provided = request.headers['x-anas-confirm']
  if (typeof provided === 'string') {
    if (store.verifyCode(provided, spec.operation, params, bound))
      return true
    const mismatch = store.explainMismatch(provided, spec.operation, params, bound, { sameKeys: opts.address })
    if (mismatch)
      return challenge(store, reply, spec.operation, params, bound, mismatchError(spec, pass, params, mismatch, opts))
  }
  return challenge(store, reply, spec.operation, params, bound, {
    code: 'CONFIRMATION_REQUIRED',
    message: opts.message,
    warnings: opts.warnings,
  })
}

// ---------------------------------------------------------------------------
// Lock keys (cr.33, docs/WAVE3-DESIGN.md §4.2)
//
// Keys are STABLE ids where the object exists (a pool's guid, an AHR pool's VG
// UUID, a disk's by-id, a LUN's serial, a uid), so a rename or a namesake can
// never alias two objects; a NAME key (`zname:`, `ahrname:`, `idname:`) is
// added by every verb that changes a namespace (create, import, export,
// destroy, rename), so an export of `tank` and an import of another pool
// called `tank` serialise although their guids differ. `what` is how a
// waiting job's progress line names the object.
// ---------------------------------------------------------------------------

function claim(key: string, mode: LockMode, what: string): LockClaim {
  return { key, mode, what }
}

/**
 * `zpool:<guid>` — every ZFS verb on the pool or on anything in it: exclusive
 * for the pool-structural verbs (destroy, export, upgrade, mountpoint, add or
 * remove a vdev, attach, replace, raidz expand, cleanup), shared for
 * everything inside.
 */
export function zpoolClaim(guid: string, mode: LockMode, pool: string): LockClaim {
  return claim(`zpool:${guid}`, mode, `Pool '${pool}'`)
}

/** `zname:<pool name>` — exclusive; ZFS create, import, export, destroy. */
export function znameClaim(pool: string): LockClaim {
  return claim(`zname:${pool}`, 'exclusive', `the pool name '${pool}'`)
}

/**
 * A pool-level verb's claims: the guid key in `mode`, plus the name key when
 * the verb changes the namespace. A pool whose guid could not be read is
 * locked by its name key only, exclusive (§4.2's conservative fallback; its
 * gates refuse anyway when they cannot read their facts).
 */
export function poolClaims(pool: string, guid: string | null | undefined, mode: LockMode, opts: { namespace?: boolean } = {}): LockClaim[] {
  if (!guid)
    return [znameClaim(pool)]
  return [zpoolClaim(guid, mode, pool), ...(opts.namespace ? [znameClaim(pool)] : [])]
}

const SNAPSHOT_OR_BOOKMARK = /[@#]/

/** The dataset a snapshot (`@`) or bookmark (`#`) name belongs to. */
function datasetOf(name: string): string {
  const cut = name.search(SNAPSHOT_OR_BOOKMARK)
  return cut === -1 ? name : name.slice(0, cut)
}

/**
 * `zfs:<poolGuid>/<dataset path>` in `mode`, every ancestor dataset's key
 * shared, and the pool's `zpool:<guid>` shared — dataset and snapshot verbs,
 * a replication's source or target, a backup or cloud run on a path in the
 * pool, a schedule fire. The path is the dataset's name BELOW the pool (the
 * pool is the guid already; the root dataset's key is `zfs:<guid>`), so a pool
 * imported under another name keeps its keys. A snapshot or bookmark name
 * locks its dataset.
 *
 * So a recursive destroy of `tank/a` (exclusive on `tank/a`) excludes a
 * snapshot of `tank/a/b` (shared on `tank/a` as its ancestor), while two
 * snapshots under `tank/a` run together.
 */
export function zfsClaims(poolGuid: string, dataset: string, mode: LockMode): LockClaim[] {
  const name = datasetOf(dataset)
  const parts = name.split('/')
  const key = (depth: number): string => {
    const rel = parts.slice(1, depth).join('/')
    return rel ? `zfs:${poolGuid}/${rel}` : `zfs:${poolGuid}`
  }
  const claims: LockClaim[] = [claim(key(parts.length), mode, `Dataset '${name}'`)]
  for (let depth = parts.length - 1; depth >= 1; depth--)
    claims.push(claim(key(depth), 'shared', `Dataset '${parts.slice(0, depth).join('/')}'`))
  claims.push(zpoolClaim(poolGuid, 'shared', parts[0]))
  return claims
}

/**
 * `ahr:<vg uuid>` — every AHR verb: exclusive for destroy, mountpoint, remount,
 * an expand/replace/readd step, cache attach/detach, spare add/remove,
 * snapshot rollback; shared for scrub, repair, snapshot create/delete, access
 * and the runs that read the pool.
 */
export function ahrClaim(vgUuid: string, mode: LockMode, pool: string): LockClaim {
  return claim(`ahr:${vgUuid}`, mode, `AHR pool '${pool}'`)
}

/** `ahrname:<name>` — exclusive; AHR create and destroy. */
export function ahrnameClaim(pool: string): LockClaim {
  return claim(`ahrname:${pool}`, 'exclusive', `the AHR pool name '${pool}'`)
}

/**
 * `disk:<inventory by-id>` — exclusive; every verb that writes a disk (ZFS
 * create, add, attach, replace, the destroy cleanup; AHR create, expand,
 * replace, spare, cache). The key is the WHOLE disk's by-id as the inventory
 * lists it (`ata-…`, `scsi-…`), never a partition's.
 */
export function diskClaim(byId: string): LockClaim {
  return claim(`disk:${byId}`, 'exclusive', `disk ${byId}`)
}

/** `iscsi-target:<iqn>` — exclusive; target verbs (the `withIscsiLock` section stays inside). */
export function iscsiTargetClaim(iqn: string): LockClaim {
  return claim(`iscsi-target:${iqn}`, 'exclusive', `iSCSI target ${iqn}`)
}

/** `iscsi-lun:<serial>` — exclusive; LUN verbs and an image restore onto a LUN. */
export function iscsiLunClaim(serial: string): LockClaim {
  return claim(`iscsi-lun:${serial}`, 'exclusive', `iSCSI LUN ${serial}`)
}

/** `mount:<target path>` — exclusive; mount verbs. */
export function mountClaim(target: string): LockClaim {
  return claim(`mount:${target}`, 'exclusive', `the mount at ${target}`)
}

/** `share:smb:<section>` — exclusive; Samba matches section names case-insensitively, so the key is case-folded. */
export function smbShareClaim(section: string): LockClaim {
  return claim(`share:smb:${section.toLowerCase()}`, 'exclusive', `SMB share '${section}'`)
}

/** `share:nfs:<path>` — exclusive; NFS export verbs. */
export function nfsShareClaim(path: string): LockClaim {
  return claim(`share:nfs:${path}`, 'exclusive', `NFS export ${path}`)
}

/** `uid:<n>` — exclusive; user verbs (the id, never the name: a re-created user is another user). */
export function uidClaim(uid: number, name: string): LockClaim {
  return claim(`uid:${uid}`, 'exclusive', `user '${name}' (uid ${uid})`)
}

/** `gid:<n>` — exclusive; group verbs. */
export function gidClaim(gid: number, name: string): LockClaim {
  return claim(`gid:${gid}`, 'exclusive', `group '${name}' (gid ${gid})`)
}

/** `idname:<name>` — exclusive; user and group create (the name has no id yet). */
export function idnameClaim(name: string): LockClaim {
  return claim(`idname:${name}`, 'exclusive', `the user or group name '${name}'`)
}

/** `task:<kind>:<name>` — exclusive for create, update, delete; shared for a run. */
export function taskClaim(kind: string, name: string, mode: LockMode): LockClaim {
  return claim(`task:${kind}:${name}`, mode, `${kind} task '${name}'`)
}

/** `schedule:<id>` — exclusive for create, update, delete; shared for a run. */
export function scheduleClaim(id: string, mode: LockMode): LockClaim {
  return claim(`schedule:${id}`, mode, `schedule '${id}'`)
}

/**
 * An AHR pool verb's claims (story cr.38, §4.2), the AHR twin of
 * {@link poolClaims}: `ahr:<vg uuid>` in `mode`, plus `ahrname:<name>` when the
 * verb changes the namespace (create, destroy). A pool whose VG UUID could
 * not be read (no VG, or a `vgs` that does not report the column) is locked by
 * its name key only, exclusive — §4.2's conservative fallback; an AHR pool's
 * name IS its VG name, so the name key still serialises every verb on it.
 */
export function ahrPoolClaims(pool: string, vgUuid: string | null | undefined, mode: LockMode, opts: { namespace?: boolean } = {}): LockClaim[] {
  if (!vgUuid)
    return [ahrnameClaim(pool)]
  return [ahrClaim(vgUuid, mode, pool), ...(opts.namespace ? [ahrnameClaim(pool)] : [])]
}
