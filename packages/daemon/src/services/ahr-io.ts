import type { AhrPool, AhrPoolTelemetry, DiskTelemetry } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { DiskstatsCounters } from '../parsers/diskstats.js'
import { diskstatsToIoStats, parseDiskstats } from '../parsers/diskstats.js'
import { dmName, readAhrPools } from './ahr-topology.js'

/**
 * AHR I/O telemetry sampler (story 11.15, AHR-DESIGN §10).
 *
 * Turns two /proc/diskstats snapshots + the live AHR topology into the
 * pool → band → member I/O tree the dashboard renders — the AHR analog of the
 * ZFS pool → vdev → disk telemetry.
 *
 * DEVICE NAMES ARE RESOLVED AT SAMPLE TIME (point-of-use kernel-name rule,
 * §5.3 / GT-2): the pool's LV from its `/dev/mapper/<dmName>` path, each band
 * from its `/dev/md/<pool>-r<N>` pin, and each member from its partition path —
 * all via `readlink -f`, never persisted, never compared across reads. A kernel
 * name (`md127`, `dm-0`, `sdd1`) is only ever the diskstats lookup key for THIS
 * sample.
 *
 * Fail-open at every level: no diskstats, no topology, or an unresolvable LV
 * omits that pool (the dashboard then renders its block WITHOUT an I/O strip,
 * exactly as before telemetry landed — never a fabricated zero). A band or
 * member whose device is unresolvable / absent from diskstats is simply left
 * out; an idle device that IS present reports honest zeros.
 */

const READLINK = '/usr/bin/readlink'

/** One band's resolved kernel names, ready for the diskstats lookup. */
interface ResolvedBand {
  band: number
  level: AhrPool['arrays'][number]['level']
  /** md kernel name (e.g. `md127`), or null when the pin did not resolve. */
  md: string | null
  members: { id: string, part: string | null }[]
}

/** A pool's resolved device kernel names for the current sample. */
interface ResolvedDevices {
  /** LV dm kernel name (e.g. `dm-0`), or null when the mapper path is absent. */
  lv: string | null
  bands: ResolvedBand[]
}

/**
 * Resolve a device path to its bare kernel name via `readlink -f`
 * (`/dev/md/tank-r1` → `md127`, `/dev/mapper/tank-tank--vol` → `dm-0`,
 * `/dev/disk/by-id/…-part1` → `sdb1`). Null on any failure — fail-open.
 */
async function resolveKernel(executor: CommandExecutor, path: string): Promise<string | null> {
  try {
    const r = await executor.exec(READLINK, ['-f', path])
    if (r.exitCode !== 0)
      return null
    const resolved = r.stdout.trim()
    if (!resolved)
      return null
    const base = resolved.slice(resolved.lastIndexOf('/') + 1)
    return base || null
  }
  catch {
    return null
  }
}

/**
 * Resolve every device path an AHR pool's I/O tree needs, at sample time.
 *  Hot-spare members carry no band I/O (only rebuild writes) and are excluded,
 *  matching the /v1/status band briefs.
 */
async function resolveDevices(executor: CommandExecutor, pool: AhrPool): Promise<ResolvedDevices> {
  const lv = await resolveKernel(executor, `/dev/mapper/${dmName(pool.name, pool.lv.name)}`)
  const bands = await Promise.all(pool.arrays.map(async (array): Promise<ResolvedBand> => {
    const md = await resolveKernel(executor, `/dev/md/${pool.name}-r${array.band}`)
    const members = await Promise.all(
      array.members
        .filter(m => m.memberState !== 'spare')
        .map(async m => ({ id: m.disk, part: await resolveKernel(executor, m.partition) })),
    )
    return { band: array.band, level: array.level, md, members }
  }))
  return { lv, bands }
}

/**
 * Build one pool's I/O telemetry from resolved device names + two diskstats
 * snapshots. Returns null when the LV is unresolvable or absent from the sample
 * (the pool is then omitted — the dashboard block renders without an I/O strip
 * rather than showing fabricated numbers). A band/member device that did not
 * resolve or is missing from diskstats is dropped; an idle-but-present device
 * reports real zeros.
 */
export function buildAhrPoolTelemetry(
  name: string,
  resolved: ResolvedDevices,
  prev: Map<string, DiskstatsCounters>,
  cur: Map<string, DiskstatsCounters>,
  windowMs: number,
): AhrPoolTelemetry | null {
  if (!resolved.lv)
    return null
  const lvCur = cur.get(resolved.lv)
  if (!lvCur)
    return null

  const bands = []
  for (const band of resolved.bands) {
    if (!band.md)
      continue
    const mdCur = cur.get(band.md)
    if (!mdCur)
      continue
    const disks: DiskTelemetry[] = []
    for (const member of band.members) {
      if (!member.part)
        continue
      const partCur = cur.get(member.part)
      if (!partCur)
        continue
      disks.push({ id: member.id, ...diskstatsToIoStats(prev.get(member.part), partCur, windowMs) })
    }
    bands.push({
      band: band.band,
      level: band.level,
      ...diskstatsToIoStats(prev.get(band.md), mdCur, windowMs),
      disks,
    })
  }

  return { name, ...diskstatsToIoStats(prev.get(resolved.lv), lvCur, windowMs), bands }
}

/**
 * Collect AHR pool I/O telemetry from two /proc/diskstats texts over a window.
 * Reads the live topology (the SAME reader /v1/ahr and the §10 briefs use) and
 * resolves device names at sample time. Fully fail-open: any error (or missing
 * diskstats) yields `[]`, never disturbing the rest of the telemetry payload.
 */
export async function collectAhrTelemetry(
  executor: CommandExecutor,
  prevText: string | null,
  curText: string | null,
  windowMs: number,
  mdadmConfPath?: string,
): Promise<AhrPoolTelemetry[]> {
  try {
    if (!prevText || !curText)
      return []
    const prev = parseDiskstats(prevText)
    const cur = parseDiskstats(curText)
    const pools = await readAhrPools(executor, mdadmConfPath)
    if (pools.length === 0)
      return []
    const out: AhrPoolTelemetry[] = []
    for (const pool of pools) {
      const resolved = await resolveDevices(executor, pool)
      const tel = buildAhrPoolTelemetry(pool.name, resolved, prev, cur, windowMs)
      if (tel)
        out.push(tel)
    }
    return out
  }
  catch {
    return []
  }
}
