import type { PveOwnership, PveStorageRef, SystemPoolFacts } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import { pveOwnership, wouldBeClaimedByPve } from '@anas/shared'
import { PVE_STORAGE_CFG, readPveStorages, readZfsMountpoints } from '../parsers/pve-storage.js'

/**
 * PVE footprint ownership — the ONE daemon service that answers "does PVE own
 * this dataset?" (story pvepool.1, GitHub #61; DESIGN.md "PVE footprint
 * ownership").
 *
 * The decision itself is the shared PURE predicate `pveOwnership()` in
 * `@anas/shared`; this module wraps it with the two I/O reads the predicate
 * needs and nothing else:
 *
 *   1. `readPveStorages()` — /etc/pve/storage.cfg parsed into
 *      `poolRoot -> PveStorageRef[]`, ALWAYS with the ZFS mountpoint list so a
 *      `dir` storage's `path` resolves onto its dataset;
 *   2. `readSystemPoolFacts()` — `zpool get -H -o name,value bootfs` per
 *      imported pool plus the dataset `findmnt` reports mounted at `/`, the
 *      boot tree the relaxation would otherwise expose.
 *
 * Every consumer (datasets tree/detail, the naming guard, snapshot schedules,
 * replication, iSCSI, backup) loads ONE footprint per request and asks it —
 * there is no second copy of the pool-level "is this PVE's?" helper anywhere
 * in the daemon (the four `isPveManagedPool` copies this replaces were the
 * single-source-of-truth lesson repeating itself). Both reads FAIL OPEN: an
 * unreadable storage.cfg yields no storages and a failed boot probe yields no
 * system facts, which derives to "outside PVE's footprint" — the same posture
 * GET /pools has always had off-PVE.
 */

const ZPOOL = '/usr/sbin/zpool'
const FINDMNT = '/usr/bin/findmnt'

/** `zpool get -H -o name,value bootfs` — tab-separated `<pool>\t<value>` rows. */
const BOOTFS_ROW_RE = /^(\S+)\t(.*)$/
const TRAILING_CR_RE = /\r$/
const WHITESPACE_RUN_RE = /\s+/

/**
 * Parse `zpool get -H -o name,value bootfs` output into one row per imported
 * pool. A value of `-` means bootfs is UNSET (the field is omitted). Pure and
 * total: malformed rows are skipped, never throws.
 */
export function parseBootfsGet(text: string): { pool: string, bootfs?: string }[] {
  const out: { pool: string, bootfs?: string }[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    if (line.trim() === '')
      continue
    const m = BOOTFS_ROW_RE.exec(line)
    if (!m)
      continue
    const pool = m[1]
    const value = m[2].trim()
    out.push(value === '-' || value === '' ? { pool } : { pool, bootfs: value })
  }
  return out
}

/**
 * Parse `findmnt -n -o SOURCE,FSTYPE /` — the dataset mounted at the node's
 * root, WHEN that filesystem is zfs (any other fstype, or an unreadable
 * answer, is no boot dataset at all). Pure and total: returns null for
 * anything that is not a zfs root mount.
 */
export function parseRootMount(text: string): { dataset: string, fstype: string } | null {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(TRAILING_CR_RE, '')
    if (line.trim() === '')
      continue
    const parts = line.trim().split(WHITESPACE_RUN_RE)
    if (parts.length < 2)
      continue
    const [dataset, fstype] = parts
    if (!dataset || fstype !== 'zfs')
      return null
    return { dataset, fstype }
  }
  return null
}

/**
 * Combine the bootfs rows and the root mount into {@link SystemPoolFacts} —
 * one entry per imported pool, `bootfs` omitted when unset, `rootDataset`
 * added to the pool that actually hosts `/`. Pure.
 */
export function buildSystemPoolFacts(
  bootfsRows: { pool: string, bootfs?: string }[],
  rootMount: { dataset: string, fstype: string } | null,
): SystemPoolFacts[] {
  return bootfsRows.map((row) => {
    const rootDataset = rootMount && row.pool === rootMount.dataset.split('/')[0]
      ? rootMount.dataset
      : undefined
    return {
      pool: row.pool,
      ...(row.bootfs !== undefined ? { bootfs: row.bootfs } : {}),
      ...(rootDataset !== undefined ? { rootDataset } : {}),
    }
  })
}

/**
 * Read the boot facts for every imported pool, FAIL-OPEN: on any error the
 * answer is `[]` (no pool is system-owned — the per-dataset relaxation then
 * applies unchecked) and the failure is logged ONCE per process, not once per
 * request — a system pool whose facts went dark must not flood journald, and
 * the destroy route's `isRootPool` name/proc-mounts block is still there
 * behind it for the common shapes.
 */
let systemFactsWarned = false

export async function readSystemPoolFacts(exec: CommandExecutor): Promise<SystemPoolFacts[]> {
  try {
    const [bootfsResult, findmntResult] = await Promise.all([
      exec.exec(ZPOOL, ['get', '-H', '-o', 'name,value', 'bootfs']),
      exec.exec(FINDMNT, ['-n', '-o', 'SOURCE,FSTYPE', '/']),
    ])
    if (bootfsResult.exitCode !== 0)
      throw new Error(`zpool get bootfs exited ${bootfsResult.exitCode}: ${bootfsResult.stderr.trim()}`)
    // findmnt exits non-zero when / is not a mountpoint entry it can find —
    // that is "no root dataset", not a failure of the probe.
    const rootMount = findmntResult.exitCode === 0 ? parseRootMount(findmntResult.stdout) : null
    return buildSystemPoolFacts(parseBootfsGet(bootfsResult.stdout), rootMount)
  }
  catch (err: unknown) {
    if (!systemFactsWarned) {
      systemFactsWarned = true
      console.warn('anasd: could not read system-pool boot facts (zpool get bootfs / findmnt /); '
        + 'system-pool protection is inactive this process lifetime:', err)
    }
    return []
  }
}

/**
 * The pure half of {@link PveFootprint.ownershipOf}, exported so a caller that
 * already HOLDS the two maps (the iSCSI read context builds them once per
 * read) can ask the same question without a second service load — one
 * predicate assembly, never two.
 */
export function ownershipFromFootprintData(
  storagesByPool: Map<string, PveStorageRef[]>,
  systemFacts: SystemPoolFacts[],
  dataset: string,
): PveOwnership | null {
  const poolRoot = dataset.split('/')[0]
  const refs = storagesByPool.get(poolRoot) ?? []
  const system = systemFacts.find(f => f.pool === poolRoot)
  return pveOwnership(refs, dataset, system)
}

/** What one request's worth of PVE-footprint reads can answer. */
export interface PveFootprint {
  /** `poolRoot -> PveStorageRef[]` from storage.cfg (dir refs resolved). */
  storagesByPool: Map<string, PveStorageRef[]>
  /** Boot facts per imported pool (empty when the probe failed — fail-open). */
  systemFacts: SystemPoolFacts[]
  /**
   * PVE's ownership claim on one full dataset name, or null when it is
   * outside PVE's footprint and ANAS may manage it. Pool-level PVE refusals
   * are separate and unchanged.
   */
  ownershipOf: (dataset: string) => PveOwnership | null
  /**
   * The naming guard for dataset create/rename/clone: non-null when PVE would
   * inventory the dataset as a guest disk on its next scan.
   */
  claimedByPve: (dataset: string) => { storage: string } | null
  /** Does this pool hold this node's boot filesystem (bootfs set or hosting /)? */
  isSystemPool: (pool: string) => boolean
  /** The pool's boot facts when it is a system pool, else null. */
  systemPoolFacts: (pool: string) => SystemPoolFacts | null
}

/**
 * Load the footprint ONCE per request. Every consumer calls this at the top of
 * its handler and asks the returned object — the reads are not cached across
 * requests, so a storage added in PVE's UI is reflected on the next load
 * (stateless; the system is the source of truth).
 */
export async function loadPveFootprint(
  executor: CommandExecutor,
  opts: { pveStorageCfg?: string } = {},
): Promise<PveFootprint> {
  const [storagesByPool, systemFacts] = await Promise.all([
    // Explicit override, then the daemon-wide env override, then the real path
    // — the same resolution server.ts hands the route-level consumers.
    readPveStorages(opts.pveStorageCfg ?? process.env.ANAS_STORAGE_CFG ?? PVE_STORAGE_CFG, await readZfsMountpoints()),
    readSystemPoolFacts(executor),
  ])

  const factsFor = (pool: string): SystemPoolFacts | null =>
    systemFacts.find(f => f.pool === pool) ?? null

  return {
    storagesByPool,
    systemFacts,
    ownershipOf: (dataset: string) => ownershipFromFootprintData(storagesByPool, systemFacts, dataset),
    claimedByPve: (dataset: string) => wouldBeClaimedByPve(storagesByPool.get(dataset.split('/')[0]) ?? [], dataset),
    isSystemPool: (pool: string) => {
      const f = factsFor(pool)
      return f !== null && (f.bootfs !== undefined || f.rootDataset !== undefined)
    },
    systemPoolFacts: factsFor,
  }
}

/**
 * The naming-guard refusal sentence, stated ONCE (it is the daemon backstop
 * behind the dialog's field-level validator, and replication + dataset create
 * + clone all quote it). Names the storage AND the dataset; `<name>` is the
 * full dataset name the operator picked.
 */
export function pveNamingGuardMessage(storage: string, name: string): string {
  return `PVE storage '${storage}' would inventory '${name}' as a guest disk on its next scan — `
    + `pick a name that does not start with vm-/base-/subvol-/basevol-<number>-`
}

/**
 * The hard system-pool refusal (no confirm bypass) for the three pool-level
 * verbs that would take the boot filesystem away — destroy, export, change
 * mount. Stated once; pools.ts quotes it at all three doors.
 */
export function systemPoolRefusal(pool: string, facts: SystemPoolFacts | null): { reason: 'system-pool', message: string } {
  const boot = facts?.bootfs ?? facts?.rootDataset ?? pool
  return {
    reason: 'system-pool',
    message: `Pool '${pool}' holds this node's boot filesystem (${boot}) — ANAS never destroys, exports or remounts a system pool`,
  }
}
