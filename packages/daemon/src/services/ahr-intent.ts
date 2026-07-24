import type { AhrExpansionState } from '@anas/shared'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AhrExpansionIntent, PoolName } from '@anas/shared'

/**
 * AhrExpansionIntent persistence (Epic 11.6, docs/AHR-DESIGN.md §5.3) — the
 * ONLY persisted expansion state.
 *
 * Per the guest philosophy, pool topology is always reconstructed live from
 * md/LVM/btrfs — the one fact NOT derivable from the system is what the
 * operator intended (the approved disk set), because a stateless reconciler
 * cannot distinguish "disk failed" from "disk deliberately removed". A missing
 * disk is NEVER treated as intent. So exactly one small record per pool is
 * persisted: the intent. Steps are never persisted — the §2.3 planner
 * recomputes them from (existing bands + approved disks) on every run/resume.
 *
 * Storage: one JSON file per pool under a root-owned directory (default
 * /etc/anas/ahr, overridable via ANAS_AHR_INTENT_DIR — tests point it at a
 * temp dir). Same discipline as the replication-remotes registry: per-file
 * in-process lock, expectation-checked (CAS-style) writes so two racing
 * mutation requests can never both persist an intent, zod-validation on read,
 * atomic write-temp-then-rename so a torn write is never visible.
 */

/** The default intent directory (env-overridable). */
export function defaultAhrIntentDir(): string {
  return process.env.ANAS_AHR_INTENT_DIR ?? '/etc/anas/ahr'
}

/**
 * Thrown when a write's expectation (`absent`, or a specific current state)
 * does not hold under the lock — the caller maps this to a 409.
 */
export class AhrIntentConflictError extends Error {
  constructor(pool: string, public readonly currentState: AhrExpansionState | null) {
    super(currentState === null
      ? `no expansion intent exists for pool '${pool}'`
      : `pool '${pool}' already has an expansion intent (state '${currentState}')`)
    this.name = 'AhrIntentConflictError'
  }
}

/** Intent file path for a pool. The name is schema-validated before joining. */
function intentFile(dir: string, pool: string): string {
  return join(dir, `${PoolName.parse(pool)}.json`)
}

/** Per-path promise chain — serializes writes to the same file in-process. */
const locks = new Map<string, Promise<unknown>>()
function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(path, next.catch(() => {}))
  return next
}

/**
 * Read + zod-validate a pool's intent. An absent (or empty) file is null — no
 * expansion in flight. A present-but-invalid file throws: we never silently
 * discard a record whose loss would strand a half-driven expansion.
 */
export async function readIntent(pool: string, dir: string = defaultAhrIntentDir()): Promise<AhrExpansionIntent | null> {
  let text: string
  try {
    text = await readFile(intentFile(dir, pool), 'utf-8')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw err
  }
  if (!text.trim())
    return null
  const parsed = AhrExpansionIntent.safeParse(JSON.parse(text))
  if (!parsed.success)
    throw new Error(`AHR intent file for pool '${pool}' is invalid: ${parsed.error.issues[0]?.message}`)
  return parsed.data
}

/**
 * Persist a pool's intent (atomic replace, 0600). `expect` guards the write
 * under the per-file lock: `'absent'` refuses when any intent already exists
 * (the double-expand race), a state refuses unless the current intent is in
 * exactly that state (e.g. resume flips only a 'halted' intent to 'running').
 * Omitted → unconditional overwrite (the executor's own state transitions).
 */
export async function writeIntent(
  pool: string,
  intent: AhrExpansionIntent,
  opts: { dir?: string, expect?: 'absent' | AhrExpansionState } = {},
): Promise<void> {
  const dir = opts.dir ?? defaultAhrIntentDir()
  const path = intentFile(dir, pool)
  const validated = AhrExpansionIntent.parse(intent)
  await withFileLock(path, async () => {
    if (opts.expect !== undefined) {
      const current = await readIntent(pool, dir)
      if (opts.expect === 'absent' && current !== null)
        throw new AhrIntentConflictError(pool, current.state)
      if (opts.expect !== 'absent' && current?.state !== opts.expect)
        throw new AhrIntentConflictError(pool, current?.state ?? null)
    }
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${pool}.json.anas.tmp`)
    await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    await rename(tmp, path)
  })
}

/** Remove a pool's intent (done/abandoned). Absent is a no-op. */
export async function clearIntent(pool: string, dir: string = defaultAhrIntentDir()): Promise<void> {
  const path = intentFile(dir, pool)
  await withFileLock(path, async () => {
    await rm(path, { force: true })
  })
}

/**
 * Every persisted intent, keyed by pool (from the file name). Used by the
 * daemon boot scan to find expansions orphaned by a daemon death. An absent
 * directory is an empty list; an unreadable single file is skipped with the
 * rest still returned (boot must not die on one bad record — it is reported
 * by readIntent when that pool is next touched).
 */
export async function listIntents(dir: string = defaultAhrIntentDir()): Promise<{ pool: string, intent: AhrExpansionIntent }[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return []
    throw err
  }
  const out: { pool: string, intent: AhrExpansionIntent }[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.'))
      continue
    const pool = entry.slice(0, -'.json'.length)
    if (!PoolName.safeParse(pool).success)
      continue
    try {
      const intent = await readIntent(pool, dir)
      if (intent)
        out.push({ pool, intent })
    }
    catch {
      // Skip the unreadable record; surfaced when the pool is next touched.
    }
  }
  return out
}
