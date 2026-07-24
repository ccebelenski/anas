import type { AhrPool, AhrPreviewBand } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import { clearGhostMdSignatures } from './ahr-create.js'
import { addSpareSlice, ensureDiskPartitions, projectExistingBands, readDiskTree, removeDetachedFaultySlots, resolveAhrArrays } from './ahr-expand-exec.js'
import { floorToGranularity } from './ahr-layout.js'

/**
 * AHR hot spares (story 11.11, docs/AHR-DESIGN.md §11) — pool-level spares.
 *
 * Model: a spare must cover EVERY band — its §2.5-rounded usable size must
 * reach the pool's top array boundary; a partial spare is REFUSED with the
 * exact shortfall (a spare that can't absorb every failure is a false
 * promise). Attach = wipe + partition with the pool's full band-slice
 * geometry (§2.6 rules, ghost-clearing pass included — the create/expand code
 * paths, reused, never duplicated), then `mdadm --add-spare` each slice to
 * its band array. From there MD OWNS THE FAILOVER: a member failure triggers
 * the rebuild onto the spare slice immediately — no operator, no daemon, no
 * polling (Principle 7). mdmonitor's SpareActive/RebuildFinished events flow
 * through the existing PROGRAM hook; nothing here watches anything.
 *
 * Slot hygiene: attaching a spare first `--remove detached`s any faulty slot
 * whose device is ABSENT (md's own definition of detached). A faulty disk
 * that is still PRESENT is left untouched — that is Re-add's (11.9) or
 * Replace's job, never a side effect.
 *
 * OUT of v1 (deliberately, §11): promote-spare-to-member, shared spares
 * across pools.
 */

const WIPEFS = '/usr/sbin/wipefs'
const SGDISK = '/usr/sbin/sgdisk'
const MDADM = '/usr/sbin/mdadm'
const UDEVADM = '/usr/bin/udevadm'

const GIB = 1024 ** 3

/** Human-readable byte count (GiB / TiB, matching the layout warnings). */
function fmtBytes(bytes: number): string {
  const gib = bytes / GIB
  if (gib >= 1024)
    return `${Math.round((gib / 1024) * 100) / 100} TiB`
  return `${Math.round(gib * 100) / 100} GiB`
}

/** Run a command, throwing a stderr-carrying error on non-zero exit. */
async function run(executor: CommandExecutor, command: string, args: string[]): Promise<ExecResult> {
  const r = await executor.exec(command, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `${command} ${args[0] ?? ''} exited ${r.exitCode}`)
  return r
}

function byIdPath(diskId: string): string {
  return `/dev/disk/by-id/${diskId}`
}

// ---- Coverage (the §11 full-coverage rule) ----------------------------------

export interface SpareCoverage {
  /** Whether the disk covers every band. */
  ok: boolean
  /** The disk's §2.5-rounded usable bytes. */
  usableBytes: number
  /** The pool's top array boundary in bytes. */
  topBoundaryBytes: number
  /** How short the disk falls (0 when ok). */
  shortfallBytes: number
}

/**
 * The §11 full-coverage check: a spare's rounded usable size must reach the
 * pool's top ARRAY boundary (usable ≥ every band's upper edge). Pure.
 */
export function spareCoverage(topBoundaryBytes: number, rawSizeBytes: number): SpareCoverage {
  const usableBytes = floorToGranularity(rawSizeBytes)
  const shortfallBytes = Math.max(0, topBoundaryBytes - usableBytes)
  return { ok: shortfallBytes === 0, usableBytes, topBoundaryBytes, shortfallBytes }
}

/** The refusal message for a partial spare — states the EXACT shortfall (§11). */
export function spareShortfallMessage(diskId: string, c: SpareCoverage): string {
  return `disk '${diskId}' cannot serve as a hot spare for this pool: a spare must cover every band `
    + `(usable size ≥ ${fmtBytes(c.topBoundaryBytes)}, the pool's top array boundary), but it has `
    + `${fmtBytes(c.usableBytes)} usable after §2.5 rounding — ${fmtBytes(c.shortfallBytes)} short. `
    + `A partial spare is a false promise and is refused (§11)`
}

/**
 * §11 expansion-coupling warnings for the PLAN response: every attached spare
 * that cannot reach the post-expansion top band is named BEFORE the confirm —
 * it keeps covering the existing bands, but a failure in the new top band
 * will not auto-rebuild onto it. Pure.
 */
export function spareCoverageWarnings(
  spares: { id: string, usableBytes: number }[],
  bands: AhrPreviewBand[],
): string[] {
  const protectedEnds = bands.filter(b => b.protected).map(b => b.range.endBytes)
  if (protectedEnds.length === 0 || spares.length === 0)
    return []
  const top = Math.max(...protectedEnds)
  const warnings: string[] = []
  for (const s of spares) {
    if (s.usableBytes >= top)
      continue
    const covered = Math.max(0, ...protectedEnds.filter(e => e <= s.usableBytes))
    warnings.push(
      `hot spare '${s.id}' cannot cover the new top band — it needs ${fmtBytes(top)} but has `
      + `${fmtBytes(s.usableBytes)} usable (${fmtBytes(top - s.usableBytes)} short). It keeps covering `
      + `the existing bands up to ${fmtBytes(covered)}; a failure in the new top band will NOT rebuild `
      + `onto this spare automatically`,
    )
  }
  return warnings
}

/**
 * The pool's existing protected bands as preview-band shapes — the geometry
 * input the shared partitioning path (ensureDiskPartitions) consumes. Derived
 * from the live pool via the same projection the expansion planner uses.
 */
export function poolPreviewBands(pool: AhrPool): AhrPreviewBand[] {
  return projectExistingBands(pool).map(b => ({
    band: b.band,
    range: { startBytes: b.startBytes, endBytes: b.endBytes },
    memberCount: b.members.length,
    level: b.level,
    heightBytes: b.endBytes - b.startBytes,
    usableBytes: 0, // not consumed by the partitioning path
    protected: true,
  }))
}

// ---- Attach (POST /v1/ahr/:name/spare) ---------------------------------------

export interface SpareAttachInput {
  pool: AhrPool
  diskId: string
  /** Raw device size from the inventory (route-resolved). */
  diskSizeBytes: number
}

export interface SpareOptions {
  /** Structured log sink (default console — journald, §7.1). */
  log?: (line: string) => void
}

/**
 * Attach a hot spare (§11). The route has already validated availability and
 * coverage; both are re-checked here (validate at every boundary). Sequence:
 *
 *   slot hygiene (`--remove detached` on arrays with a faulty ABSENT slot)
 *     → wipe (wipefs + sgdisk --zap-all — the disk was confirm-gated as wiped)
 *     → partition the full band-slice geometry (ensureDiskPartitions — the
 *       §2.6 create/expand path) → ghost-superblock clearing pass
 *     → `mdadm --add-spare` each slice to its band array, bands ascending.
 *
 * md owns everything after that — there is deliberately NO watcher here.
 */
export async function attachSpare(
  executor: CommandExecutor,
  input: SpareAttachInput,
  updateProgress: (message: string) => void,
  opts: SpareOptions = {},
): Promise<{ attached: string, bands: number[] }> {
  const { pool, diskId } = input
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const bands = poolPreviewBands(pool)
  if (bands.length === 0)
    throw new Error(`pool '${pool.name}' has no band arrays — nothing for a spare to cover`)

  // Coverage re-check (§11 — the route checked too; defense in depth).
  const coverage = spareCoverage(bands.at(-1)!.range.endBytes, input.diskSizeBytes)
  if (!coverage.ok)
    throw new Error(spareShortfallMessage(diskId, coverage))

  const arrays = await resolveAhrArrays(executor, pool.name)
  for (const band of bands) {
    if (!arrays.has(band.band))
      throw new Error(`array ${pool.name}-r${band.band} not found — refusing to attach a spare to a partially assembled pool`)
  }

  // --- Slot hygiene (§11): faulty slots whose device is ABSENT are removed.
  // `--remove detached` is md's own "absent" test — a faulty-but-PRESENT disk
  // is deliberately left alone (Re-add 11.9 / Replace territory). The shared
  // helper (ahr-expand-exec) is the single implementation, reused by Re-add.
  for (const [band, arr] of [...arrays.entries()].sort((a, b) => a[0] - b[0])) {
    if (await removeDetachedFaultySlots(executor, arr.dev, arr.md.members)) {
      updateProgress(`removed detached faulty slot(s) from ${pool.name}-r${band}`)
      log(`ahr.spare pool=${pool.name} band=${band} hygiene=remove-detached`)
    }
  }

  // --- Wipe + full band-slice geometry (§2.6 — the shared code paths).
  const dev = byIdPath(diskId)
  updateProgress(`Wiping ${diskId}`)
  await run(executor, WIPEFS, ['-a', dev])
  await run(executor, SGDISK, ['--zap-all', dev])
  await run(executor, UDEVADM, ['settle'])

  updateProgress(`Partitioning ${diskId} (${bands.length} band slice${bands.length === 1 ? '' : 's'})`)
  await ensureDiskPartitions(executor, pool.name, diskId, bands)

  const tree = await readDiskTree(executor, dev)
  if (!tree)
    throw new Error(`disk '${diskId}' disappeared during the spare attach`)
  updateProgress('Clearing stale md signatures on new partitions')
  await clearGhostMdSignatures(
    executor,
    tree.parts.filter(p => p.number !== null).map(p => ({ diskId, partNumber: p.number! })),
  )

  // --- One --add-spare per band array, ascending. md owns failover from here.
  const attached: number[] = []
  for (const band of bands) {
    const arr = arrays.get(band.band)!
    updateProgress(`Adding spare slice to ${pool.name}-r${band.band}`)
    const memberKernels = new Set(arr.md.members.map(m => m.device))
    if (await addSpareSlice(executor, pool.name, diskId, band.band, arr.dev, memberKernels))
      log(`ahr.spare pool=${pool.name} band=${band.band} disk=${diskId} status=attached`)
    attached.push(band.band)
  }

  return { attached: diskId, bands: attached }
}

// ---- Remove (DELETE /v1/ahr/:name/spare/:id) ---------------------------------

/**
 * Remove a hot spare (§11): detach its slice from every band array
 * (`--remove`, with a `--fail` first when md insists), zero its md
 * superblocks, and zap its GPT — the disk returns to the available pool.
 * When the spare device itself is ABSENT (died/pulled), its stale `(S)`
 * slots are cleared with `--remove detached` and there is nothing to zap.
 */
export async function removeSpare(
  executor: CommandExecutor,
  input: { pool: AhrPool, diskId: string },
  updateProgress: (message: string) => void,
  opts: SpareOptions = {},
): Promise<{ removed: string }> {
  const { pool, diskId } = input
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`))

  const arrays = await resolveAhrArrays(executor, pool.name)
  const tree = await readDiskTree(executor, byIdPath(diskId))

  if (!tree) {
    // Device gone: clear its stale (S) slots wherever the pool topology saw it.
    const bands = pool.arrays
      .filter(a => a.members.some(m => m.disk === diskId))
      .map(a => a.band)
      .sort((a, b) => a - b)
    for (const band of bands) {
      const arr = arrays.get(band)
      if (!arr)
        continue
      updateProgress(`clearing detached spare slot from ${pool.name}-r${band}`)
      const r = await executor.exec(MDADM, [arr.dev, '--remove', 'detached'])
      log(`ahr.spare pool=${pool.name} band=${band} remove=detached result=${r.exitCode === 0 ? 'ok' : `failed detail=${r.stderr.trim()}`}`)
    }
    log(`ahr.spare pool=${pool.name} disk=${diskId} status=absent-slots-cleared`)
    return { removed: diskId }
  }

  const partNumbers = new Map(tree.parts.filter(p => p.number !== null).map(p => [p.name, p.number!]))
  for (const [band, arr] of [...arrays.entries()].sort((a, b) => a[0] - b[0])) {
    const member = arr.md.members.find(m => partNumbers.has(m.device))
    if (!member)
      continue
    const partPath = `${byIdPath(diskId)}-part${partNumbers.get(member.device)}`
    updateProgress(`Removing spare slice from ${pool.name}-r${band}`)
    const removed = await executor.exec(MDADM, [arr.dev, '--remove', partPath])
    if (removed.exitCode !== 0) {
      // md wants the slot failed first (§11: --remove after --fail as needed).
      await executor.exec(MDADM, [arr.dev, '--fail', partPath])
      await run(executor, MDADM, [arr.dev, '--remove', partPath])
    }
    log(`ahr.spare pool=${pool.name} band=${band} disk=${diskId} status=removed`)
  }

  // Zap: superblocks first (tolerated — a clean slice has none), then GPT.
  updateProgress(`Zapping ${diskId} (zero superblocks, zap GPT)`)
  for (const [, number] of partNumbers)
    await executor.exec(MDADM, ['--zero-superblock', `${byIdPath(diskId)}-part${number}`])
  await run(executor, SGDISK, ['--zap-all', byIdPath(diskId)])
  log(`ahr.spare pool=${pool.name} disk=${diskId} status=zapped`)

  return { removed: diskId }
}
