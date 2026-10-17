import type { ErrorCode } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { LockClaim, LockMode } from '../jobs/locks.js'
import type { JobContext, JobHandler } from '../jobs/queue.js'
import type { BoundId, ConfirmMismatch, ConfirmStore } from './confirm.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { covers } from '../jobs/locks.js'
import { otherJobsClaims } from '../jobs/queue.js'
import { AhrTopologyUnreadableError } from '../services/ahr-topology.js'
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
 *    the lock recompute (cr.64a: the claims recomputed from the job's own
 *    re-read must be COVERED by the keys the queue granted — the lock table's
 *    own rule, cr.64b1 (A); the same re-check runs again for `reguard` and
 *    for a second spec's {@link reverify}, cr.64b1 (D)) → advisories → body,
 *    each step against facts read NOW (a fresh {@link GuardReads}; nothing
 *    read at the request reaches the job's gates). A refusal fails the job
 *    with the gate's own error code and sentence.
 *
 * Both doors' checks run inside the guard door ({@link insideGuardDoor},
 * cr.64b1 (B)): a lock-claim reader that cannot read the fact its keys derive
 * from refuses 503 UNAVAILABLE naming the read instead of locking nothing.
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
 * A lock-claim builder could not read the fact its keys derive from (cr.64b1
 * (B)): the mount table or the AHR topology a source path is resolved
 * through. Thrown by the claim readers (services/source-claims.ts) only INSIDE
 * a guard door ({@link insideGuardDoor}); the door answers it as a 503
 * UNAVAILABLE refusal naming the read. The message names the read and what it
 * would have locked.
 */
export class LockClaimsUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockClaimsUnreadableError'
  }
}

/**
 * The guard's doors run their checks inside this context (cr.64b1 (B)): a
 * claim reader that fails OPEN elsewhere — a data mover's run door, which must
 * not turn into a 503 over a lock key (cr.33b) — fails CLOSED here, because a
 * mutation that cannot read what its keys derive from cannot lock what it is
 * about to change (the Gate contract: a fact it cannot read is a refusal,
 * never a pass). Without it the route locked nothing for the object, the job
 * read it fine, and the recompute refused with "changed while this run
 * waited" — a false sentence (the cr.64a review's possible).
 */
const guardDoor = new AsyncLocalStorage<true>()

/** True while a guard door's checks run (route or job): a claim reader must not fail open here. */
export function insideGuardDoor(): boolean {
  return guardDoor.getStore() === true
}

/** The 503 a guard door answers when a claim reader could not read its fact. */
function claimsUnreadableRefusal(what: string, err: Error): Refusal {
  return { status: 503, code: 'UNAVAILABLE', message: `${what}: ${err.message} — nothing was done; try again` }
}

/**
 * The job door's lock recompute (cr.64b1r (2)): the spec's claim builder run
 * on the job's own re-read. A builder that THROWS the AHR topology's typed
 * unreadable error ({@link AhrTopologyUnreadableError}: `cat /proc/mdstat`
 * or an `mdadm --detail --export` that exited non-zero — a schedule fire's
 * AHR target resolved to its VG UUID) is a guard refusal, 503 UNAVAILABLE
 * naming the read, so it fails the job with that code and the door's
 * `refused` hook hears it (a scheduled fire notifies). Before cr.64a that read
 * sat inside the fire's body, whose notify wrapper caught it; since the
 * recompute moved into the guard it escaped both as a bare JOB_FAILED. At the
 * ROUTE the same throw leaves `guardCheck` and the server's error handler
 * answers it 503 UNAVAILABLE with the error's own sentence (cr.64c), as every
 * AHR mutation route's topology read does.
 */
async function recomputedClaims<O>(spec: GuardSpec<O>, object: O, confirmed: GuardBound, reads: GuardReads): Promise<LockClaim[]> {
  try {
    return await spec.locks!(object, confirmed, reads)
  }
  catch (err) {
    if (err instanceof AhrTopologyUnreadableError)
      throw new GuardRefusalError(claimsUnreadableRefusal(spec.object.what, err))
    throw err
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
  /**
   * The sentence naming what moved for the job door's lock recompute
   * ({@link guarded}, {@link reverify}, `reguard`; cr.64a): called ONLY when
   * the claims recomputed from the job's own re-read are not covered by the
   * ones the run was granted — the comparison runs first, on every job, and
   * this runs on a STATE_CHANGED refusal (cr.64b1 (G)), never on one whose
   * cause is a read that failed (cr.64b1r (3)) — with the re-read object, the run's
   * read cache (the spec's own reads, so the facts the `locks` builder just
   * used are memoised) and, from the job door, the object the ROUTE read
   * (`was`; absent for a {@link reverify} of a second spec). A door whose
   * claim-bearing field has a name the operator knows (a backing, a source, a
   * schedule's target) gives one naming it; absent, the recompute names the
   * two claim-key sets, or only the modes when only a mode moved.
   */
  locksMoved?: (object: O, reads: GuardReads, was?: O) => Promise<string> | string
}

/** What the confirm binds beside the request, and what the job compares. */
export interface GuardBound {
  id: BoundId
  revision?: string
  scope?: BoundId
  /**
   * The lock claims the route door computed with this bound (cr.64b1 (D)) —
   * what the job is submitted with. Never signed into the confirm; the job
   * door's lock recompute compares against it, so a {@link reverify} of a
   * SECOND spec (the SMB grant binding) checks its keys as the job door does.
   * Absent when the spec takes no lock.
   */
  locks?: readonly LockClaim[]
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
  try {
    return await guardDoor.run(true, () => routeDoor(spec))
  }
  catch (err) {
    if (err instanceof LockClaimsUnreadableError)
      return { refusal: claimsUnreadableRefusal(spec.object.what, err) }
    throw err
  }
}

async function routeDoor<O>(spec: GuardSpec<O>): Promise<GuardPass<O> | { refusal: Refusal }> {
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
  if (spec.locks)
    bound.locks = locks
  return { object, bound, advisories, locks }
}

/**
 * A scope as a message names it. ONE key (today's scopes all have one) reads
 * as its bare set — `the members to wipe` is the lead-in of the sentence, so
 * the label would only repeat it (D7: `was: disk-a, disk-b; now: …`); several
 * keys keep their labels so the two sets cannot blur together.
 */
function describeScope(scope: BoundId | undefined, labels: Record<string, string> = {}): string {
  if (!scope)
    return 'nothing'
  const keys = Object.keys(scope).sort()
  if (keys.length === 1)
    return String(scope[keys[0]] || 'none')
  return keys.map(k => `${labels[k] ?? k}: ${scope[k] || 'none'}`).join('; ')
}

/**
 * The job-time sentence when the bound scope moved — the two sets SEPARATED
 * as `was: …; now: …`, so a grown child set reads as two lists, not one
 * run-together string (D7).
 */
function scopeChangedMessage<O>(view: ObjectView<O>, confirmed: BoundId | undefined, now: BoundId | null): string {
  return `${view.what} changed since you confirmed (was: ${describeScope(confirmed, view.scopeLabels)}; `
    + `now: ${now ? describeScope(now, view.scopeLabels) : 'unreadable'}) — nothing was done; confirm again`
}

/**
 * Re-read the object and re-run every check of the spec against facts read
 * now. Throws {@link IdentityMismatchError} (gone or a different object) or
 * {@link GuardRefusalError} (state or scope changed, a gate refused, or the
 * claims recomputed from this read need a key the route's did not cover).
 *
 * Exported for a job that binds a SECOND spec (cr.43 step 5: the SMB verbs
 * bind their ACL grant's spec beside the share's own): the job door runs the
 * verb's spec, and the body re-runs the second spec's checks here before its
 * first act. cr.64b1 (D): the lock recompute runs here too, against the
 * claims the route computed with this bound ({@link GuardBound.locks}), so a
 * second spec whose keys moved while the job waited refuses as the first
 * spec would.
 */
export async function reverify<O>(spec: GuardSpec<O>, confirmed: GuardBound): Promise<{ object: O, reads: GuardReads }> {
  return jobDoor(spec, () => recheck(spec, confirmed, confirmed.locks))
}

/**
 * Run job-door checks inside the guard door (cr.64b1 (B)): a claim reader
 * that cannot read its fact refuses the job 503 UNAVAILABLE naming the read.
 */
async function jobDoor<O, T>(spec: GuardSpec<O>, checks: () => Promise<T>): Promise<T> {
  try {
    return await guardDoor.run(true, checks)
  }
  catch (err) {
    if (err instanceof LockClaimsUnreadableError)
      throw new GuardRefusalError(claimsUnreadableRefusal(spec.object.what, err))
    throw err
  }
}

/**
 * Every job-door check, in order: read → id → revision → scope → every gate →
 * the lock recompute (cr.64a; cr.64b1 (D): for EVERY re-check — the first
 * run, a `reguard` after a release, a second spec's `reverify` — so a re-read
 * never acts on keys it was not granted). `held` is what the job was granted
 * for this spec (absent: a bound built without the route door, which has no
 * claims to compare); `was` is the route's object, for `locksMoved`;
 * `found` hears the re-read object as soon as there is one.
 */
async function recheck<O>(
  spec: GuardSpec<O>,
  confirmed: GuardBound,
  held: readonly LockClaim[] | undefined,
  was?: O,
  found?: (object: O) => void,
): Promise<{ object: O, reads: GuardReads }> {
  const view = spec.object
  const reads = new GuardReads()
  const object = await view.read(reads)
  if (object === null)
    throw new IdentityMismatchError(view.what, confirmed.id, null)
  found?.(object)

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

  // cr.64a: the guard's own lock recompute — cr.56's rule at its three mover
  // doors, the guard's rule for EVERY spec. The queue granted exactly the
  // claims the ROUTE computed from the ROUTE's read; the job acts on what its
  // OWN re-read says, so every key the re-read needs must be covered by the
  // ones granted ({@link unheldClaimsRefusal}: the lock table's own rule,
  // cr.64b1 (A)) — else a destroy, rollback, rename or mount accepted in
  // between is not serialised against this run. Needing FEWER keys than held
  // is fine (the extra keys only make other verbs wait). `locksMoved` names
  // what moved in the operator's own terms when the spec knows; the refusal
  // names the objects it holds no key (or only a shared key) for.
  if (spec.locks && held) {
    const needed = await recomputedClaims(spec, object, confirmed, reads)
    const others = otherJobsClaims()
    const refusal = unheldClaimsRefusal(view.what, '', held, needed, others)
    if (refusal) {
      // cr.64b1r (3): a read that failed is not a move — `locksMoved` names
      // what moved, so it runs only for a STATE_CHANGED refusal.
      if (refusal.code !== 'STATE_CHANGED')
        throw new GuardRefusalError(refusal)
      const moved = spec.locksMoved ? await spec.locksMoved(object, reads, was) : claimsMoved(held, needed)
      throw new GuardRefusalError(unheldClaimsRefusal(view.what, moved, held, needed, others) ?? refusal)
    }
  }
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
   * id → revision → scope → gates → the lock recompute now (a long job calls
   * it before each act step). Returns the fresh object; throws like the first
   * run does.
   */
  reguard: () => Promise<O>
}

export type GuardedBody<O> = (object: O, ctx: GuardedContext<O>) => Promise<unknown>

/** The job door's options. */
export interface GuardedOpts<O> {
  /**
   * Called when the job door's FIRST run refuses after its re-read found the
   * object, with the refusal and the re-read object, before the job fails
   * with it. It hears every {@link GuardRefusalError}: a gate, a revision or
   * scope change, the lock recompute (STATE_CHANGED, or cr.64b1r (3)'s 503
   * UNAVAILABLE when a claim fact could not be read), and a claim builder
   * that could not read its fact — the claim readers'
   * {@link LockClaimsUnreadableError} and (cr.64b1r (2)) the AHR topology's
   * typed {@link AhrTopologyUnreadableError}, both turned into 503
   * UNAVAILABLE refusals naming the read before this runs. (cr.64b1 said
   * "an unreadable claim fact" here while only GuardRefusalError reached
   * it, so an AHR fire whose topology read failed in the job ended
   * JOB_FAILED and was never reported.) Any OTHER throw is not a refusal —
   * the job fails with it and this is not called. A door whose body reports
   * its own outcome (the schedule fire's notify, cr.64b1 (F)) reports the
   * guard's refusal here, since it happens before any body runs. A refusal
   * before the read found anything (the object gone or another one) is an
   * identity question and is not reported here; nor is a `reguard`'s (the
   * body is running then, and reports its own failure).
   */
  refused?: (refusal: Refusal, object: O) => Promise<void>
}

/**
 * The job door: the handler `jobQueue.submit` runs. Every check of the spec
 * runs again before the body; the body runs only when all pass.
 */
export function guarded<O>(spec: GuardSpec<O>, pass: GuardPass<O>, body: GuardedBody<O>, opts: GuardedOpts<O> = {}): JobHandler {
  return async (updateProgress, jobCtx) => {
    let seen: { object: O } | undefined
    let checked: { object: O, reads: GuardReads }
    try {
      checked = await jobDoor(spec, () => recheck(spec, pass.bound, pass.locks, pass.object, (o) => {
        seen = { object: o }
      }))
    }
    catch (err) {
      if (err instanceof GuardRefusalError && seen && opts.refused)
        await opts.refused(err.refusal, seen.object)
      throw err
    }
    const { object, reads } = checked
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
      // through the queue's FIFO before anything is re-read — and (cr.64b1
      // (D)) the re-read's claims are recomputed against the ones it holds.
      reguard: async () => {
        await jobCtx.reacquire()
        return (await jobDoor(spec, () => recheck(spec, pass.bound, pass.locks, pass.object))).object
      },
    })
  }
}

/**
 * The claims a run needs NOW that its job does not hold (cr.56, review M2).
 *
 * A data mover's or a schedule fire's lock claims are computed by its route
 * from the route's read of the task or schedule, and the queue grants exactly
 * those; the job then re-reads the object and acts on what IT read. An edit
 * (or a pool re-created under the same name, or a mount appearing over a
 * source path) landing between the two leaves the job working on an object it
 * holds no key for — a destroy, rollback, rename or unmount accepted meanwhile
 * is not serialised against it. So the job recomputes the claims from its own
 * re-read, with the route's builder, and this compares them with the set it
 * holds: every claim it needs must be COVERED by the held set — the lock
 * table's own rule ({@link covers}, jobs/locks.ts, cr.64b1 (A)): the same key
 * in a mode that excludes as much (a held exclusive covers a needed shared),
 * or the pool's name key held exclusive for any guid-keyed claim of that pool
 * (cr.33b's fallback) while no other job holds that guid key without the name
 * key (cr.64b1r (1): `others`, the queue's {@link otherJobsClaims} by default
 * — every other job it knows, so the cover is checked against the real
 * table). A run that now needs FEWER keys (an archive removed)
 * holds everything it acts on and proceeds — the extra keys only make other
 * verbs wait for it. `moved` names the claim-bearing field that moved, as the
 * door reads it; the refusal names the objects it holds no lock on, and those
 * it holds only a shared lock on where it now needs exclusive (cr.64b1 (C)).
 *
 * cr.64b1r (3): when the sets differ because a READ failed — a needed claim
 * is a fallback ({@link LockClaim.unread}: the job could not read the pool's
 * guid or VG UUID), or the route's fallback no longer covers because another
 * job holds the guid key without the name key — and EVERY claim the run
 * lacks is so explained, the refusal is 503 UNAVAILABLE "<the read> could not
 * be read …", since nothing is known to have moved. A claim lacked for no
 * failed read is a move, and the refusal stays STATE_CHANGED.
 *
 * Returns the STATE_CHANGED (or UNAVAILABLE) refusal, or null when every
 * needed claim is held.
 */
export function unheldClaimsRefusal(
  what: string,
  moved: string,
  held: readonly LockClaim[],
  needed: readonly LockClaim[],
  others: readonly (readonly LockClaim[])[] = otherJobsClaims(),
): Refusal | null {
  // cr.64b1 (A): the lock table's own rule (`covers`, jobs/locks.ts), never
  // a key-by-key comparison of its own — so a held exclusive name key (the
  // cr.33b fallback a route took when the pool's guid could not be read)
  // covers every guid-keyed claim of that pool the job's re-read now needs,
  // unless another job holds that key without the name key (cr.64b1r (1)).
  const missing = needed.filter(c => !covers(held, c, others))
  if (missing.length === 0)
    return null
  const objects = (claims: LockClaim[]): string => [...new Set(claims.map(c => c.what))].join(', ')
  const reads = (claims: LockClaim[]): string => [...new Set(claims.map(c => c.unread!))].join(' and ')
  // cr.64b1r (3): the sentence says WHY the two sets differ. A needed claim
  // that is a FALLBACK (`unread`: the job's own read of the guid or VG UUID
  // failed) did not move — the job could not see — and a held fallback whose
  // cover another job voided (the ROUTE's read failed; cr.64b1r (1)) did not
  // move either. Both are 503 UNAVAILABLE "could not be read", never
  // STATE_CHANGED "changed while this run waited", which a scheduled fire
  // would mail. Only when EVERY missing claim is so explained: a claim that
  // is missing for no failed read (a mount that appeared under the path, a
  // pool re-created under the name) is a move, and the move is the sentence.
  const routeUnread = held.filter(h => h.unread !== undefined && missing.some(c => c.within === h.key))
  const jobUnread = missing.filter(c => c.unread !== undefined)
  const explained = (c: LockClaim): boolean => c.unread !== undefined || routeUnread.some(h => h.key === c.within)
  if (missing.every(explained)) {
    const why: string[] = []
    if (jobUnread.length > 0)
      why.push(`${reads(jobUnread)} could not be read in the job, so the run cannot tell which locks it needs`)
    if (routeUnread.length > 0) {
      const uncovered = missing.filter(c => routeUnread.some(h => h.key === c.within))
      why.push(`${reads(routeUnread)} could not be read when the run was requested, so the run holds a lock on ${objects(routeUnread)} instead, `
        + `which does not cover ${objects(uncovered)} while another job holds or waits for ${uncovered.length === 1 ? 'it' : 'them'} without that name`)
    }
    return { status: 503, code: 'UNAVAILABLE', message: `${what}: ${why.join('; ')} — nothing was done; try again` }
  }
  // cr.64b1 (C): a needed claim whose KEY is held (shared, where exclusive is
  // needed now) is not "no lock" — the sentence says which it is.
  const heldKeys = new Set(held.map(c => c.key))
  const none = missing.filter(c => !heldKeys.has(c.key))
  const weak = missing.filter(c => heldKeys.has(c.key))
  const holds = [
    ...(none.length ? [`no lock on ${objects(none)}`] : []),
    ...(weak.length ? [`only a shared lock on ${objects(weak)}`] : []),
  ].join(' and ')
  return {
    status: 409,
    code: 'STATE_CHANGED',
    message: `${what} changed while this run waited (${moved}) — the run holds ${holds}, so nothing was done; run it again`,
  }
}

/**
 * The generic `moved` for the guard's lock recompute ({@link guarded},
 * cr.64a), when the spec does not name the field that moved: the two claim-key
 * sets as keys — precise and machine-readable, the sentence's tail names the
 * objects in the operator's words.
 */
function claimsMoved(held: readonly LockClaim[], needed: readonly LockClaim[]): string {
  const keys = (claims: readonly LockClaim[]): string =>
    claims.length ? claims.map(c => c.key).join(', ') : 'none'
  // cr.64b1 (C): the same keys, so only a MODE moved — name the keys whose
  // mode did, in both modes (the two key lists alone would read identical).
  const modes = (claims: readonly LockClaim[]): Map<string, LockMode> => {
    const out = new Map<string, LockMode>()
    for (const c of claims) {
      if (out.get(c.key) !== 'exclusive')
        out.set(c.key, c.mode)
    }
    return out
  }
  const was = modes(held)
  const now = modes(needed)
  if (was.size === now.size && [...now.keys()].every(k => was.has(k))) {
    const moved = [...now].filter(([k, m]) => was.get(k) !== m).map(([k]) => k)
    if (moved.length > 0)
      return `lock modes were ${moved.map(k => `${k} ${was.get(k)}`).join(', ')}; now ${moved.map(k => `${k} ${now.get(k)}`).join(', ')}`
  }
  return `lock claims were ${keys(held)}; now ${keys(needed)}`
}

/** A list of source paths as a refusal names it. */
function pathList(paths: readonly string[]): string {
  return paths.length ? paths.join(', ') : 'none'
}

/**
 * What moved between a run's route read and its job read, for a door whose
 * claim-bearing field is a list of source PATHS (the backup run's archive
 * paths, the cloud run's source): the field itself when it changed, else the
 * filesystems the same paths resolve to (a mount, dataset or pool that moved
 * under them).
 */
export function sourcePathsMoved(field: { name: string, plural: boolean }, was: readonly string[], now: readonly string[]): string {
  if (was.join('\n') !== now.join('\n'))
    return `${field.name} ${field.plural ? 'were' : 'was'} ${pathList(was)}; now ${pathList(now)}`
  return `${field.name} ${pathList(now)} now ${field.plural ? 'resolve' : 'resolves'} to a different filesystem`
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
  /**
   * A scope ONLY the confirm binds (nf.3 D10), beside the spec's own scope:
   * a fact the operator was shown that the job compares its own way, so the
   * job door's exact scope re-read ({@link reverify}) must not see it. The
   * busy unmount's holders are the case — the confirm binds the set it named
   * (a different set at the resend is 409 CONFIRM_SCOPE_CHANGED), while in the
   * job a holder that has gone is no reason to stop and only a NEW one refuses.
   * Its keys read through the spec's `scopeLabels` like any scope key.
   */
  confirmScope?: Record<string, string>
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
      // D7: the two sets are separated (`was: a, b; now: a, b, c`), never
      // written as one run-together string with a suffix marker each.
      parts.push(scopeKeys.map(k => `${labels[k] ?? k} changed since you confirmed (was: ${was[k] || 'none'}; now: ${pass.bound.scope?.[k] || 'none'})`).join('; '))
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
  const signed: GuardPass<O> = opts.confirmScope
    ? { ...pass, bound: { ...pass.bound, scope: { ...pass.bound.scope, ...opts.confirmScope } } }
    : pass
  const bound = boundSignature(signed.bound)
  const provided = request.headers['x-anas-confirm']
  if (typeof provided === 'string') {
    if (store.verifyCode(provided, spec.operation, params, bound))
      return true
    const mismatch = store.explainMismatch(provided, spec.operation, params, bound, { sameKeys: opts.address })
    if (mismatch)
      return challenge(store, reply, spec.operation, params, bound, mismatchError(spec, signed, params, mismatch, opts))
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
//
// cr.33b (the guid-fallback split): every guid-keyed ZFS or AHR claim set ALSO
// carries the pool's name key SHARED, and the fallback for a pool whose guid
// or VG UUID could not be read is that name key EXCLUSIVE. Without the shared
// name key a verb that read the guid (`zpool:<guid>`, `zfs:<guid>/…`) and a
// verb on the same pool whose read failed (`zname:<pool>` only) share no key
// and ran together. The name key in shared mode costs the in-pool verbs
// nothing (shared claims coexist); it conflicts only with the fallback and
// with the namespace verbs (create, import, export, destroy), which take it
// exclusive and already exclude every in-pool verb through the guid key.
// ---------------------------------------------------------------------------

function claim(key: string, mode: LockMode, what: string): LockClaim {
  return { key, mode, what }
}

/**
 * A guid- or VG-UUID-keyed claim that rides with its pool's name key (cr.33b),
 * saying so (`within`, jobs/locks.ts): the lock recompute's {@link covers}
 * then knows a held exclusive name key covers it (cr.64b1 (A)).
 */
function within(c: LockClaim, nameKey: LockClaim): LockClaim {
  return { ...c, within: nameKey.key }
}

/**
 * The §4.2 fallback for a pool whose stable id could not be read: its name
 * key exclusive, saying WHAT could not be read (`unread`, jobs/locks.ts), so
 * the lock recompute can tell a read that failed from an object that moved
 * (cr.64b1r (3)).
 */
function fallback(nameKey: LockClaim, unread: string): LockClaim {
  return { ...nameKey, unread }
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

/**
 * `zname:<pool name>` — exclusive for ZFS create, import, export, destroy and
 * for the guid fallback; shared beside every guid-keyed claim (cr.33b).
 */
export function znameClaim(pool: string, mode: LockMode = 'exclusive'): LockClaim {
  return claim(`zname:${pool}`, mode, `the pool name '${pool}'`)
}

/**
 * A pool-level verb's claims: the guid key in `mode`, plus the name key —
 * exclusive when the verb changes the namespace, shared otherwise (cr.33b). A
 * pool whose guid could not be read is locked by its name key only, exclusive
 * (§4.2's conservative fallback; its gates refuse anyway when they cannot read
 * their facts), which the shared name key of every guid-keyed verb meets.
 */
export function poolClaims(pool: string, guid: string | null | undefined, mode: LockMode, opts: { namespace?: boolean } = {}): LockClaim[] {
  if (!guid)
    return [fallback(znameClaim(pool), `the guid of pool '${pool}'`)]
  const name = znameClaim(pool, opts.namespace ? 'exclusive' : 'shared')
  return [within(zpoolClaim(guid, mode, pool), name), name]
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
 *
 * The pool's name key rides last, shared (cr.33b), so a verb on the same pool
 * whose guid read failed ({@link zfsDatasetClaims}' fallback, the name key
 * exclusive) waits for this one and this one for it.
 */
export function zfsClaims(poolGuid: string, dataset: string, mode: LockMode): LockClaim[] {
  const name = datasetOf(dataset)
  const parts = name.split('/')
  const key = (depth: number): string => {
    const rel = parts.slice(1, depth).join('/')
    return rel ? `zfs:${poolGuid}/${rel}` : `zfs:${poolGuid}`
  }
  const poolName = znameClaim(parts[0], 'shared')
  const claims: LockClaim[] = [within(claim(key(parts.length), mode, `Dataset '${name}'`), poolName)]
  for (let depth = parts.length - 1; depth >= 1; depth--)
    claims.push(within(claim(key(depth), 'shared', `Dataset '${parts.slice(0, depth).join('/')}'`), poolName))
  claims.push(within(zpoolClaim(poolGuid, 'shared', parts[0]), poolName))
  claims.push(poolName)
  return claims
}

/**
 * The claims of a dataset verb whose pool guid was read at the route (cr.33b:
 * the ONE fallback rule for every dataset door — the dataset verbs, set access,
 * the data movers): {@link zfsClaims} when the guid is known, else the pool's
 * name key exclusive (§4.2's conservative fallback).
 */
export function zfsDatasetClaims(poolGuid: string | null | undefined, dataset: string, mode: LockMode): LockClaim[] {
  if (poolGuid)
    return zfsClaims(poolGuid, dataset, mode)
  const pool = datasetOf(dataset).split('/')[0]
  return [fallback(znameClaim(pool), `the guid of pool '${pool}'`)]
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

/**
 * `ahrname:<name>` — exclusive for AHR create and destroy and for the VG UUID
 * fallback; shared beside every `ahr:<vg uuid>` claim (cr.33b).
 */
export function ahrnameClaim(pool: string, mode: LockMode = 'exclusive'): LockClaim {
  return claim(`ahrname:${pool}`, mode, `the AHR pool name '${pool}'`)
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

/**
 * `mount:<target path>` — exclusive for mount verbs; shared for a data mover
 * whose source sits on that mount (cr.33b), so an unmount waits for the run.
 */
export function mountClaim(target: string, mode: LockMode = 'exclusive'): LockClaim {
  return claim(`mount:${target}`, mode, `the mount at ${target}`)
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
 * {@link poolClaims}: `ahr:<vg uuid>` in `mode`, plus `ahrname:<name>` —
 * exclusive when the verb changes the namespace (create, destroy), shared
 * otherwise (cr.33b). A pool whose VG UUID could not be read (no VG, or a
 * `vgs` that does not report the column) is locked by its name key only,
 * exclusive — §4.2's conservative fallback; an AHR pool's name IS its VG name,
 * and every UUID-keyed claim set carries that name key shared, so the
 * fallback serialises with every verb on the pool.
 */
export function ahrPoolClaims(pool: string, vgUuid: string | null | undefined, mode: LockMode, opts: { namespace?: boolean } = {}): LockClaim[] {
  if (!vgUuid)
    return [fallback(ahrnameClaim(pool), `the VG UUID of AHR pool '${pool}'`)]
  const name = ahrnameClaim(pool, opts.namespace ? 'exclusive' : 'shared')
  return [within(ahrClaim(vgUuid, mode, pool), name), name]
}
