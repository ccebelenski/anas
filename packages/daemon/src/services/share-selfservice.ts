import type { CreateSmbShareRequest, MountEntry, SnapshotSchedule } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { SelfServiceKeys } from '../parsers/smb-conf.js'
import { isPathWithin, RetentionBucket } from '@anas/shared'
import { addMount, hasMount } from '../parsers/fstab.js'
import { ahrLvPath } from './ahr-paths.js'
import { SUBVOL_SNAPSHOTS } from './ahr-snapshots.js'
import { readAhrPools } from './ahr-topology.js'
import { editConfig } from './config-writer.js'
import { loadPveFootprint } from './pve-footprint.js'
import { readAllSchedules } from './snapshot-schedule-units.js'

/**
 * Self-service on SMB shares (smbsvc.1–3) — the ONE service holding the
 * DECISIONS behind the feature checkboxes (DESIGN "Self-service on SMB
 * shares"); `parsers/smb-conf.ts` holds only the composer + managed keys.
 *
 * The decisions:
 *   - WHERE the share lives: ZFS dataset (the ONE longest-prefix mountpoint
 *     resolver, `datasetOfPath` from the pvepool.1 footprint service) or AHR
 *     pool (longest match over the pools' `@data` mountpoints) — never a new
 *     resolver.
 *   - WHICH bucket Previous Versions exposes: the finest cadence among the
 *     ENABLED snapshot schedules targeting that dataset/pool (a disabled
 *     schedule takes nothing, so it exposes nothing); `daily` when none —
 *     never a refusal (the dialog says Previous Versions stays empty until a
 *     schedule runs).
 *   - HOW the AHR variant mounts its snapshots: ONE read-only `@snapshots`
 *     fstab line per pool at `/mnt/anas-ahr-snapshots/<pool>` (added on first
 *     enable, never removed on disable — no enable/disable counting), mounted
 *     immediately, idempotently.
 *
 * Everything here fails with a SENTENCE: the route's 400 fast path and the
 * in-job guard both surface it verbatim.
 */

const FINDMNT = '/usr/bin/findmnt'
const MOUNT = '/usr/bin/mount'
const ZFS = '/usr/sbin/zfs'

/**
 * Base for the per-pool read-only `@snapshots` mounts (a SIBLING of the pool
 * mount base — never inside the data tree). Env-overridable for tests.
 */
const DEFAULT_AHR_SNAPSHOTS_MOUNT_BASE = '/mnt/anas-ahr-snapshots'

export function ahrSnapshotsMountBase(override?: string): string {
  return override ?? process.env.ANAS_AHR_SNAPSHOTS_MOUNT_BASE ?? DEFAULT_AHR_SNAPSHOTS_MOUNT_BASE
}

/** The read-only mountpoint where pool `<name>`'s `@snapshots` subvolume lives. */
export function ahrSnapshotsMountpoint(poolName: string, override?: string): string {
  return `${ahrSnapshotsMountBase(override)}/${poolName}`
}

/** Where a share's path lives, for the self-service decisions. */
export type SelfServiceTarget
  = | { kind: 'zfs', dataset: string }
    | { kind: 'ahr', pool: string }

/**
 * Resolve a share path to its snapshot-bearing home. ZFS first (the ONE
 * mountpoint table the footprint service loads), then AHR (longest
 * mountpoint match over the live pools). `null` = neither — nothing here is
 * snapshotted, and Previous Versions has nothing to expose.
 */
export async function resolveSelfServiceTarget(executor: CommandExecutor, path: string): Promise<SelfServiceTarget | null> {
  const pve = await loadPveFootprint(executor)
  const dataset = pve.datasetOfPath(path)
  if (dataset)
    return { kind: 'zfs', dataset }

  const pools = await readAhrPools(executor)
  let best: { pool: string, mountpoint: string } | undefined
  for (const pool of pools) {
    if (!isPathWithin(pool.mountpoint, path))
      continue
    if (!best || pool.mountpoint.length > best.mountpoint.length)
      best = { pool: pool.name, mountpoint: pool.mountpoint }
  }
  return best ? { kind: 'ahr', pool: best.pool } : null
}

/**
 * The free space of the storage `path` sits on, in bytes — the input for the
 * Time Machine cap suggestion (smbsvc.3): the ZFS dataset's `available`, or
 * the AHR pool's free bytes (reusing the SAME target resolver and pool read
 * everything else here uses — no second resolver). FAIL-OPEN `undefined`: an
 * unresolvable path, a failed read or an unparseable value is a missing
 * suggestion, never a detail-view failure.
 */
export async function shareAvailableBytes(executor: CommandExecutor, path: string): Promise<number | undefined> {
  try {
    const target = await resolveSelfServiceTarget(executor, path)
    if (!target)
      return undefined
    if (target.kind === 'zfs') {
      const r = await executor.exec(ZFS, ['get', '-Hp', '-o', 'value', 'available', target.dataset])
      if (r.exitCode !== 0)
        return undefined
      const n = Number(r.stdout.trim())
      return Number.isInteger(n) && n >= 0 ? n : undefined
    }
    const pools = await readAhrPools(executor)
    const pool = pools.find(p => p.name === target.pool)
    return pool ? pool.capacity.freeBytes : undefined
  }
  catch {
    return undefined
  }
}

/** Does a schedule target exactly this dataset/pool? */
function scheduleHitsTarget(schedule: SnapshotSchedule, target: SelfServiceTarget): boolean {
  if (target.kind === 'zfs')
    return schedule.target.kind === 'zfs' && schedule.target.dataset === target.dataset
  return schedule.target.kind === 'ahr' && schedule.target.pool === target.pool
}

/**
 * The finest ENABLED cadence among the schedules targeting `target`, or
 * `daily` when none. Fineness order comes straight from the shared
 * `RetentionBucket` enum (`frequently` … `yearly` — the same order the naming
 * convention and the cadence→OnCalendar table use).
 */
export function pickBucket(schedules: SnapshotSchedule[], target: SelfServiceTarget): RetentionBucket {
  for (const bucket of RetentionBucket.options) {
    if (schedules.some(s => s.enabled && s.cadence === bucket && scheduleHitsTarget(s, target)))
      return bucket
  }
  return 'daily'
}

/**
 * What one request's worth of decisions produces: the resolved keys the
 * parser edits with, plus the AHR pool whose `@snapshots` mount the job must
 * ensure (ZFS needs no mount — `.zfs/snapshot` is already there).
 */
export interface SelfServiceResolution {
  keys: SelfServiceKeys
  /** Set when Previous Versions resolved onto an AHR pool. */
  ahrPool?: string
}

/**
 * The shape the self-service decision reads: an SMB share request body with
 * every field optional (both the create and the update body satisfy it —
 * `UpdateSmbShareRequest` is `CreateSmbShareRequest` partial'd and name-omit'd).
 */
export type SelfServiceRequest = Partial<Omit<CreateSmbShareRequest, 'name'>>

/** Does the request touch ANY self-service feature at all (set or clear)? */
export function touchesSelfService(req: SelfServiceRequest): boolean {
  return req.previousVersions !== undefined || req.recycle !== undefined || req.timeMachine !== undefined
}

/** Is any feature being ENABLED (as opposed to only cleared)? */
export function enablingSelfService(req: SelfServiceRequest): boolean {
  return (req.previousVersions?.enabled ?? false)
    || (req.recycle !== undefined && req.recycle !== null)
    || (req.timeMachine !== undefined && req.timeMachine !== null)
}

/**
 * The recycle bin's slice of the resolved keys: a value sets the feature with
 * its purge age (`null` inside = never), a `null` request clears it, an
 * omitted field keeps whatever the stanza says. Recycle needs NO system
 * resolution — no bucket to pick, no snapshots to find, no mount to ensure:
 * the bin lives on the share's own filesystem (DESIGN smbsvc.2), so it works
 * on any path a share may sit on, ZFS, AHR or plain disk.
 */
function recycleKeysFrom(req: SelfServiceRequest): SelfServiceKeys {
  if (req.recycle === null)
    return { recycle: null }
  if (req.recycle !== undefined)
    return { recycle: { purgeDays: req.recycle.purgeDays } }
  return {}
}

/**
 * Resolve the request's feature fields into {@link SelfServiceKeys} — the
 * route calls this as its 400 fast path (throwing the refusal sentence) and
 * AGAIN inside the job, so the decision is made against fresh state where it
 * matters (the same fast-path + in-job re-check pattern the ownership guards
 * use). `undefined` when the request touches no feature (a plain field edit).
 *
 * Time Machine (smbsvc.3, BETA) needs NO system resolution — unlike Previous
 * Versions there is nothing to pick or mount: the fruit cap is the quota on
 * BOTH stacks (on AHR the only one), and the feature works on any path a
 * share may sit on. The cap arrives validated (integer > 0, the shared
 * schema); a `null` request clears it.
 */
export async function resolveSelfService(
  executor: CommandExecutor,
  path: string,
  req: SelfServiceRequest,
  opts: { systemdDir: string },
): Promise<SelfServiceResolution | undefined> {
  if (!touchesSelfService(req))
    return undefined

  const resolved: SelfServiceKeys = {
    ...recycleKeysFrom(req),
    ...(req.timeMachine !== undefined
      ? { timeMachine: req.timeMachine === null ? null : { maxSize: req.timeMachine.maxSize } }
      : {}),
  }

  const pv = req.previousVersions
  if (pv === undefined || pv === null || !pv.enabled)
    return { keys: { ...(pv !== undefined ? { previousVersions: null as SelfServiceKeys['previousVersions'] } : {}), ...resolved } }

  // Enabling: the path must sit on a snapshot-bearing stack.
  const target = await resolveSelfServiceTarget(executor, path)
  if (!target)
    throw new Error(`'${path}' is not on a ZFS dataset or an AHR pool — there are no snapshots to expose`)
  if (target.kind === 'ahr') {
    const pools = await readAhrPools(executor)
    const pool = pools.find(p => p.name === target.pool)
    if (!pool || !pool.subvolLayout)
      throw new Error(`pool '${target.pool}' predates the snapshot layout — Previous Versions needs @snapshots`)
  }

  const schedules = await readAllSchedules(opts.systemdDir)
  const bucket = pickBucket(schedules, target)
  const keys: SelfServiceKeys = target.kind === 'zfs'
    ? { previousVersions: { bucket, snapdir: '.zfs/snapshot', snapdirseverywhere: true }, ...resolved }
    : { previousVersions: { bucket, snapdir: ahrSnapshotsMountpoint(target.pool), snapdirseverywhere: false }, ...resolved }
  return target.kind === 'ahr' ? { keys, ahrPool: target.pool } : { keys }
}

/**
 * The fstab entry for a pool's read-only `@snapshots` mount: the pool's LV
 * device, btrfs, `subvol=@snapshots`, read-only, `nofail` (an absent pool
 * must never hold the boot hostage — the same rule the pool's own line
 * follows; no iSCSI ordering options here, nothing restores from it).
 */
function ahrSnapshotsFstabEntry(poolName: string): MountEntry {
  return {
    spec: ahrLvPath(poolName),
    mountpoint: ahrSnapshotsMountpoint(poolName),
    fstype: 'btrfs',
    options: {
      common: {
        readOnly: true,
        nofail: true,
        noauto: false,
        automount: false,
        noatime: false,
        nosuid: false,
        nodev: false,
        noexec: false,
        netdev: false,
      },
      passthrough: `subvol=${SUBVOL_SNAPSHOTS}`,
    },
    dump: 0,
    pass: 0,
  }
}

const MKDIR = '/usr/bin/mkdir'

/**
 * Ensure the pool's ONE read-only `@snapshots` fstab mount exists and is
 * mounted — idempotent (a second enable on the same pool rewrites nothing:
 * `hasMount` answers, and an already-mounted point is not mounted again).
 * The mount STAYS when the feature is later turned off: it is read-only,
 * harmless, and enable/disable must not count mounts (DESIGN ruling).
 *
 * The mountpoint directory is created before mounting: `mount` does not
 * create it, the snapshots base is a SIBLING of the pool mount base (nothing
 * else makes it), and a mount that silently failed would leave the feature
 * enabled against a snapdir that does not exist — so a failed mount fails the
 * job with mount's own stderr instead of completing (live-proof finding,
 * 2026-09-23: the unit mock answered exit 0 where the real node said
 * "mount point does not exist").
 */
export async function ensureAhrSnapshotsMount(
  executor: CommandExecutor,
  fstabPath: string,
  poolName: string,
): Promise<void> {
  const mountpoint = ahrSnapshotsMountpoint(poolName)
  await editConfig(fstabPath, (current) => {
    if (hasMount(current, mountpoint))
      return current
    return addMount(current, ahrSnapshotsFstabEntry(poolName))
  })
  const probe = await executor.exec(FINDMNT, ['-n', '-o', 'TARGET', mountpoint])
  if (probe.exitCode !== 0) {
    await executor.exec(MKDIR, ['-p', mountpoint])
    const mounted = await executor.exec(MOUNT, [mountpoint])
    if (mounted.exitCode !== 0) {
      throw new Error(`the Previous Versions snapshots mount at '${mountpoint}' failed to mount: `
        + `${mounted.stderr.trim() || `mount exited ${mounted.exitCode}`}`)
    }
  }
}
