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
   * The key of a claim EVERY claim set holding this key also holds, at least
   * shared (cr.33b: every guid-keyed `zpool:`/`zfs:` claim rides with its
   * pool's `zname:` key, every `ahr:` claim with its `ahrname:` key). The
   * builders in `safety/guard.ts` set it, {@link normaliseClaims} refuses a
   * set that names it without carrying it, and {@link covers} reads it: a
   * held exclusive `zname:<pool>` excludes every job holding a claim on that
   * pool's guid keys, so it covers them (cr.64b1 (A)).
   */
  within?: string
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
 * safety/guard.ts) asks it, so the recompute and the table cannot disagree:
 *
 *  - a claim on the SAME key whose mode excludes at least as much — the same
 *    mode, or exclusive held for a needed shared;
 *  - a held claim on the needed claim's {@link LockClaim.within} key whose
 *    mode excludes EVERY mode (exclusive): every job holding the needed key
 *    holds the `within` key too (shared or exclusive), so none can run beside
 *    it — the cr.33b fallback (`zname:<pool>` exclusive, taken when the pool's
 *    guid could not be read) covers every `zpool:<guid>` and `zfs:<guid>/…`
 *    claim of that pool.
 */
export function covers(held: readonly LockClaim[], needed: LockClaim): boolean {
  return held.some(h => (h.key === needed.key && excludesAsMuch(h.mode, needed.mode))
    || (needed.within !== undefined && h.key === needed.within && excludesAsMuch(h.mode, 'exclusive')))
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
      byKey.set(claim.key, { ...seen, mode: 'exclusive' })
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
