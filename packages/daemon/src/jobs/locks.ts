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
}

/** Two claims on the same key conflict unless both are shared. */
export function conflicts(a: LockMode, b: LockMode): boolean {
  return a === 'exclusive' || b === 'exclusive'
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
