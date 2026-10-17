import type { Job } from '@anas/shared'

/**
 * Per-object locks (story cr.33, docs/WAVE3-DESIGN.md §4).
 *
 * The lock lives in the QUEUE, not in the job body (§4.1 option c): a job
 * names its claims at `submit`, and `drain` starts it only when every claim
 * can be granted at once. A job waiting for a lock therefore never holds one
 * of the queue's slots, and since grants are all-or-nothing no job ever waits
 * while holding a key — there is no deadlock to detect.
 *
 * This module is the table: which key is held, in which mode, by which jobs.
 * The order rules (per-key FIFO, the long lane) are the queue's.
 */

/** Shared claims coexist; an exclusive claim excludes every other claim on its key. */
export type LockMode = 'shared' | 'exclusive'

/**
 * One key a job needs, and how. Keys are stable ids (`zpool:<guid>`,
 * `ahr:<vg uuid>`, `disk:<by-id>`) plus name keys for namespace verbs
 * (`zname:<pool>`); the builders live in `safety/guard.ts`.
 */
export interface LockClaim {
  key: string
  mode: LockMode
  /** How a waiting job's progress line names the object: `Pool 'tank'`. */
  what: string
  /**
   * The key of the claim THIS claim set carries beside this one (cr.33b: the
   * guard's builders put every guid-keyed `zpool:`/`zfs:` claim beside its
   * pool's `zname:` key, every `ahr:` claim beside its `ahrname:` key). The
   * builders in `safety/guard.ts` set it, {@link normaliseClaims} refuses a
   * set that names it without carrying it, and {@link covers} reads it: a
   * held exclusive `zname:<pool>` covers that pool's guid keys only while no
   * OTHER job holds them without the name key (cr.64b1r (1)). It is a fact
   * about the set it is in, not a promise about every set: the import by
   * guid holds a bare `zpool:<guid>` (pools.ts), with no name key.
   */
  within?: string
  /**
   * Set on a FALLBACK claim (cr.64b1r (3)): the fact this claim stands in for
   * could not be read (`the guid of pool 'tank'`), so the builder locked the
   * pool's name key exclusive instead (§4.2's conservative fallback). The
   * job door's lock recompute reads it to say WHY two claim sets differ: a
   * read that failed is "could not be read", never "changed while this run
   * waited".
   */
  unread?: string
}

/** Two claims on the same key conflict unless both are shared. */
export function conflicts(a: LockMode, b: LockMode): boolean {
  return a === 'exclusive' || b === 'exclusive'
}

const MODES: readonly LockMode[] = ['shared', 'exclusive']

/** Holding a key in `held` excludes every claim on it that holding it in `needed` would exclude ({@link conflicts}, per mode). */
function excludesAsMuch(held: LockMode, needed: LockMode): boolean {
  return MODES.every(other => !conflicts(needed, other) || conflicts(held, other))
}

/**
 * Does holding `held` exclude every job that holding `needed` would exclude?
 * The lock table's own rule ({@link conflicts}) asked of a whole held set
 * (cr.64b1 (A)) — the job door's lock recompute (`unheldClaimsRefusal`,
 * safety/guard.ts) asks it instead of comparing key by key. (cr.64b1 said the
 * two "cannot disagree"; they did, wherever a set broke the `within`
 * promise — cr.64b1r (1). The property sweep in safety/__tests__ now checks
 * this function against {@link conflicts} over every builder shape.)
 *
 *  - a claim on the SAME key whose mode excludes at least as much — the same
 *    mode, or exclusive held for a needed shared;
 *  - a held claim on the needed claim's {@link LockClaim.within} key whose
 *    mode excludes EVERY mode (exclusive) — the cr.33b fallback
 *    (`zname:<pool>` exclusive, taken when the pool's guid could not be read)
 *    for a `zpool:<guid>` or `zfs:<guid>/…` claim of that pool — but only
 *    while no job in `others` holds the needed key, in a mode that conflicts
 *    with it, WITHOUT the `within` key (cr.64b1r (1)). The held name key
 *    excludes exactly the jobs holding the name key; a job holding the guid
 *    key alone (the import by guid: a bare `zpool:<guid>` exclusive) is not
 *    excluded by it, and is exactly the job the needed claim would have made
 *    wait. `others` is every OTHER job the queue knows — holding, released
 *    or waiting (`otherJobsClaims`, jobs/queue.ts) — so the cover is decided
 *    against the real table, never against a promise.
 *
 * A job in `others` that holds the `within` key too conflicts with the held
 * exclusive name key, so it cannot run beside this one and voids nothing; a
 * shared claim on the needed key beside a needed shared conflicts with
 * nothing and voids nothing either (the needed claim would not have excluded
 * it).
 */
export function covers(held: readonly LockClaim[], needed: LockClaim, others: readonly (readonly LockClaim[])[] = []): boolean {
  if (held.some(h => h.key === needed.key && excludesAsMuch(h.mode, needed.mode)))
    return true
  const within = needed.within
  if (within === undefined || !held.some(h => h.key === within && excludesAsMuch(h.mode, 'exclusive')))
    return false
  return !others.some(set => !set.some(c => c.key === within)
    && set.some(c => c.key === needed.key && conflicts(c.mode, needed.mode)))
}

/**
 * One claim per key: a job that names a key twice (a dataset's own key and the
 * same key as another dataset's ancestor) gets the stronger mode, so a grant
 * never counts the job twice and a shared + exclusive pair is exclusive.
 * Order is first appearance.
 */
export function normaliseClaims(claims: readonly LockClaim[]): LockClaim[] {
  const byKey = new Map<string, LockClaim>()
  for (const claim of claims) {
    const seen = byKey.get(claim.key)
    if (!seen)
      byKey.set(claim.key, { ...claim })
    else if (claim.mode === 'exclusive')
      byKey.set(claim.key, { ...seen, mode: 'exclusive', ...(seen.unread ?? claim.unread ? { unread: seen.unread ?? claim.unread } : {}) })
  }
  // cr.64b1 (A): `within` is a promise {@link covers} relies on — a set that
  // names it must carry that key. A programming error, refused before the
  // job is recorded (as a conflicting grant is).
  for (const claim of byKey.values()) {
    if (claim.within !== undefined && !byKey.has(claim.within))
      throw new TypeError(`lock claim '${claim.key}' rides with '${claim.within}', which its claim set does not carry`)
  }
  return [...byKey.values()]
}

interface Entry {
  mode: LockMode
  /** The jobs holding the key, by id (several only when the mode is shared). */
  holders: Map<string, Job>
}

/** What a held key looks like from outside (tests, diagnostics). */
export interface HeldLock {
  key: string
  mode: LockMode
  holders: string[]
}

export class LockTable {
  private readonly entries = new Map<string, Entry>()

  /** A job that holds `claim.key` in a mode that conflicts with `claim`, or null. */
  blocker(claim: LockClaim): Job | null {
    const entry = this.entries.get(claim.key)
    if (!entry || !conflicts(entry.mode, claim.mode))
      return null
    return entry.holders.values().next().value ?? null
  }

  /** True when no claim is blocked by a holder. */
  grantable(claims: readonly LockClaim[]): boolean {
    return claims.every(c => this.blocker(c) === null)
  }

  /**
   * Grant every claim to `job`. The caller has checked {@link grantable}; a
   * conflicting grant is a programming error and throws before anything is
   * recorded, so the table never holds a half-granted job.
   */
  grant(job: Job, claims: readonly LockClaim[]): void {
    if (!this.grantable(claims))
      throw new Error(`lock grant for job ${job.id} conflicts with a holder`)
    for (const claim of claims) {
      const entry = this.entries.get(claim.key)
      if (entry)
        entry.holders.set(job.id, job)
      else
        this.entries.set(claim.key, { mode: claim.mode, holders: new Map([[job.id, job]]) })
    }
  }

  /** Release `job`'s claims. A key nobody holds any more is DELETED (§8.4: the table never grows). */
  release(jobId: string, claims: readonly LockClaim[]): void {
    for (const claim of claims) {
      const entry = this.entries.get(claim.key)
      if (!entry)
        continue
      entry.holders.delete(jobId)
      if (entry.holders.size === 0)
        this.entries.delete(claim.key)
    }
  }

  /** Every key held now, in grant order. */
  held(): HeldLock[] {
    return Array.from(this.entries, ([key, e]) => ({ key, mode: e.mode, holders: [...e.holders.keys()] }))
  }

  get size(): number {
    return this.entries.size
  }
}
