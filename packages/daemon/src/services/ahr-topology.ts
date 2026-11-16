import type {
  AhrArray,
  AhrArrayMember,
  AhrArraySync,
  AhrBandBrief,
  AhrDisk,
  AhrDiskPartition,
  AhrExpansionIntent,
  AhrPoolCapacity,
  AhrPoolState,
  ArrayLevel,
  ArrayState,
  DashboardWarning,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { DmStatusLine } from '../parsers/dmsetup.js'
import type { MdadmDetailExport } from '../parsers/mdadm-detail.js'
import type { MdstatArray } from '../parsers/mdstat.js'
import { AhrPool, AhrPoolBrief } from '@anas/shared'
import { btrfsUsageArgs, parseBtrfsScrubStatusWord, parseBtrfsUsage } from '../parsers/btrfs-usage.js'
import { parseDiskByIdListing, wholeDiskKernel } from '../parsers/disk-by-id.js'
import { dmsetupStatusArgs, parseDmsetupStatus } from '../parsers/dmsetup.js'
import { optionsReadOnly, parseFindmnt, parseFindmntTable } from '../parsers/findmnt.js'
import { isLvmReport, lvIsActive, lvIsCacheTarget, LVS_ARGS, parseLvsReport, parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { matchAhrArrayName, mdadmDetailExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { buildAhrCacheState, cacheFailedAdvisory, foreignVgPvAdvisory } from './ahr-cache-state.js'
import { matchPartitionLabel } from './ahr-geometry.js'
import { canonicalMdUuid, isOwnedArray, pinnedUuids, poolBandCount, poolPvNames, readMdadmConfDoc, readMdadmConfDocStrict } from './ahr-identity.js'
import { readPoolIntent } from './ahr-intent.js'
import { AHR_MIN_DISKS, floorToGranularity, isPvUnderSized } from './ahr-layout.js'
import { isSubvolLayoutMount } from './ahr-snapshots.js'
import { UDEVADM } from './udev-settle.js'

/**
 * AHR pool topology reader (Epic 11 + AHR, docs/AHR-DESIGN.md §3/§5.3).
 *
 * Reconstructs every AHR pool from the LIVE system — /proc/mdstat,
 * `mdadm --detail --export`, lsblk, /dev/disk/by-id, vgs/lvs, findmnt,
 * `btrfs filesystem usage` — because the system is the source of truth: ANAS
 * keeps no registry of what a pool IS (Principle 11, §5.3).
 *
 * Identity discipline (GT-2/GT-3): kernel `sdX`/`mdNNN` names are used only as
 * transient handles WITHIN one collection pass; everything reported is keyed
 * by by-id disk identities and superblock array names/UUIDs. Arrays are
 * discovered from /proc/mdstat (needed anyway for sync progress — GT-13's
 * sanctioned text exception) and identified via `--detail --export`
 * KEY=VALUE, tolerating both the bare and homehost-prefixed name forms.
 *
 * Fail-open per pool: a missing layer below a discovered pool (VG, LV, mount)
 * degrades that pool's report with advisories and never throws the read away.
 * The one read that DOES fail the whole pass is the enumeration itself — a
 * `cat /proc/mdstat` / `mdadm --detail --export` that could not see (D12) —
 * except an ABSENT `/proc/mdstat`, which honestly means "no md arrays" (see
 * {@link readAhrPools}).
 */

const CAT = '/usr/bin/cat'
const MDADM = '/usr/sbin/mdadm'
const LSBLK = '/usr/bin/lsblk'
const LS = '/usr/bin/ls'
const VGS = '/usr/sbin/vgs'
const LVS = '/usr/sbin/lvs'
const PVS = '/usr/sbin/pvs'
const BTRFS = '/usr/bin/btrfs'
const FINDMNT = '/usr/bin/findmnt'
const DMSETUP = '/usr/sbin/dmsetup'
/** The short settle before the by-id listing's one retry (cr3 review 10). */
const BY_ID_RETRY_SETTLE_ARGS = ['settle', '--timeout=5']
const BY_ID_RETRY_SETTLE_BUDGET_MS = 10_000

const MIB = 1024 ** 2

/** coreutils `cat`'s stderr line for an ABSENT file — the md-stack-less /proc/mdstat shape (F1). */
const CAT_MISSING_RE = /No such file or directory/
/**
 * The mdstat read runs in the C locale (cr3.followup): {@link CAT_MISSING_RE}
 * reads `cat`'s English strerror text, and a daemon started under a localized
 * LANG (systemd hands the unit the system locale) would otherwise turn "no md
 * stack" into an unreadable topology on every node without md.
 */
const MDSTAT_READ_OPTS = { env: { LC_ALL: 'C' } }

/**
 * lsblk args for the AHR stack view: the FULL device tree (partitions → md →
 * LVM), bytes, with partition labels. Distinct from the disks route's
 * LSBLK_ARGS (which flattens to physical disks).
 */
export const AHR_LSBLK_ARGS = ['-Jb', '-o', 'NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,PARTLABEL,MODEL,SERIAL']

/** findmnt args: real filesystems only (drops kernel pseudo-fs). */
export const AHR_FINDMNT_ARGS = ['--json', '--real']

/**
 * Is ONE pool's filesystem mounted READ-ONLY right now (ahrcache.1 slice 2)?
 *
 * The SAME reader the full topology read uses, asked about one mountpoint:
 * `findmnt --json` reads `/proc/self/mountinfo`, so it never touches the
 * mountpoint and never hangs. The effective options string it returns is the
 * same comma list `/proc/mounts` prints in its fourth field — after a btrfs
 * abort on a pool with the §12 subvolume layout, verbatim in shape:
 *
 *   /dev/mapper/gtcache-gtcache--vol /mnt/anas-ahr/gtcache btrfs \
 *     ro,relatime,space_cache=v2,subvolid=256,subvol=/@data 0 0
 *
 * It exists as its own function because the recovery rung and the Remount verb
 * both need the answer at a moment a full `readAhrPools()` has already passed:
 * btrfs flips to forced-readonly on the first WRITE after the cache dies
 * (GT-19), so the flag can arrive between loading the pool and finishing the
 * uncache, and it is the fact that decides what the operator is told.
 *
 * Three-valued (cr3, 2026-11-14 review): `null` when the mount table could
 * not be read — never `false`, which told the Remount verb a pool it could
 * not see was writable again. Each caller says what unknown means for it.
 */
export async function isAhrMountReadOnly(executor: CommandExecutor, mountpoint: string): Promise<boolean | null> {
  const res = await executor.exec(FINDMNT, AHR_FINDMNT_ARGS)
  if (res.exitCode !== 0 || parseFindmntTable(res.stdout) === null)
    return null
  const mount = parseFindmnt(res.stdout).find(m => m.target === mountpoint)
  return mount ? optionsReadOnly(mount.options) : false
}

/** `btrfs scrub status <mountpoint>` — the btrfs half of "is a scrub running". */
export function btrfsScrubStatusArgs(mountpoint: string): string[] {
  return ['scrub', 'status', mountpoint]
}

/** The scrub-status read's own deadline: far above its real cost, well under a panel poll. */
const BTRFS_SCRUB_STATUS_BUDGET_MS = 3000

/**
 * Is a btrfs scrub RUNNING on this mounted filesystem (cr3, handed by the
 * AHR-panel review)? `true` / `false` from a status read that answered;
 * `null` when it did not (non-zero exit, a throw) — unknown, never idle. A
 * filesystem never scrubbed answers exit 0 with no `Status:` line: not
 * running.
 */
async function readBtrfsScrubRunning(executor: CommandExecutor, mountpoint: string): Promise<boolean | null> {
  try {
    const r = await executor.exec(BTRFS, btrfsScrubStatusArgs(mountpoint), { timeoutMs: BTRFS_SCRUB_STATUS_BUDGET_MS })
    if (r.exitCode !== 0)
      return null
    return parseBtrfsScrubStatusWord(r.stdout) === 'running'
  }
  catch {
    return null
  }
}

// ---- lsblk tree (raw) ------------------------------------------------------

interface LsblkNode {
  name?: string
  type?: string
  size?: number
  fstype?: string | null
  mountpoint?: string | null
  partlabel?: string | null
  model?: string | null
  serial?: string | null
  children?: LsblkNode[]
}

export interface DiskInfo {
  name: string
  size: number
  model: string | null
  serial: string | null
}

export interface PartInfo {
  name: string
  size: number
  partlabel: string | null
  /** udev's signature verdict (`linux_raid_member`, `LVM2_member`, …), null when it saw none. */
  fstype: string | null
  disk: DiskInfo
  partNumber: number | null
}

interface LvmInfo {
  /** device-mapper name, e.g. "ahr0-ahr0--vol". */
  name: string
  mountpoint: string | null
}

export interface LsblkIndex {
  partsByKernel: Map<string, PartInfo>
  lvmByDmName: Map<string, LvmInfo>
}

const PART_NUMBER_RE = /(\d+)$/

/**
 * Index one `lsblk AHR_LSBLK_ARGS` tree by kernel name: every partition (with
 * its label and its parent disk) and every LVM node. Exported as the single
 * home of this walk — destroy's partlabel sweep (issue #16) reads the SAME tree
 * this reader does, so the two can never disagree about which partitions of
 * which disk carry a pool's labels.
 */
/**
 * Did lsblk answer in its JSON tree shape (cr3)? `indexLsblk` reads garbage as
 * an empty tree — zero partitions — so the topology checks the shape first.
 */
export function isLsblkTree(json: string): boolean {
  try {
    return Array.isArray((JSON.parse(json) as { blockdevices?: unknown }).blockdevices)
  }
  catch {
    return false
  }
}

export function indexLsblk(json: string): LsblkIndex {
  const index: LsblkIndex = { partsByKernel: new Map(), lvmByDmName: new Map() }
  let root: { blockdevices?: LsblkNode[] }
  try {
    root = JSON.parse(json)
  }
  catch {
    return index
  }

  const walk = (node: LsblkNode, disk: DiskInfo | null): void => {
    if (node.type === 'disk' && node.name) {
      disk = {
        name: node.name,
        size: node.size ?? 0,
        model: node.model?.trim() || null,
        serial: node.serial?.trim() || null,
      }
    }
    else if (node.type === 'part' && node.name && disk && !index.partsByKernel.has(node.name)) {
      const num = node.name.match(PART_NUMBER_RE)
      index.partsByKernel.set(node.name, {
        name: node.name,
        size: node.size ?? 0,
        partlabel: node.partlabel ?? null,
        fstype: node.fstype || null,
        disk,
        partNumber: num ? Number.parseInt(num[1], 10) : null,
      })
    }
    else if (node.type === 'lvm' && node.name && !index.lvmByDmName.has(node.name)) {
      index.lvmByDmName.set(node.name, { name: node.name, mountpoint: node.mountpoint ?? null })
    }
    for (const child of node.children ?? [])
      walk(child, disk)
  }
  for (const dev of root.blockdevices ?? [])
    walk(dev, null)
  return index
}

// ---- Assembly --------------------------------------------------------------

interface DiscoveredArray {
  pool: string
  band: number
  level: ArrayLevel
  mdstat: MdstatArray
  detail: MdadmDetailExport
}

const AHR_LEVELS = new Set<string>(['raid1', 'raid5', 'raid6'])

/** mdstat's sync verb → the shared schema's (only `recovery` differs). */
function toSyncAction(action: 'resync' | 'recovery' | 'reshape' | 'check'): AhrArraySync['action'] {
  return action === 'recovery' ? 'recover' : action
}

/**
 * dm name of `<vg>/<lv>` (device-mapper escapes `-` as `--`). Exported so the
 *  telemetry sampler (11.15) resolves the SAME `/dev/mapper/<dmName>` path this
 *  topology reader uses to find the pool's LV.
 */
export function dmName(vg: string, lv: string): string {
  return `${vg.replaceAll('-', '--')}-${lv.replaceAll('-', '--')}`
}

/** Trailing `[/subvol]` findmnt appends to a btrfs subvolume mount's source. */
const SUBVOL_SOURCE_SUFFIX_RE = /\[[^\]]*\]$/

/**
 * A findmnt mount source with any trailing btrfs-subvolume suffix removed:
 * `/dev/mapper/tank-tank--vol[/@data]` → `/dev/mapper/tank-tank--vol`. A source
 * with no suffix (a flat `subvol=/` mount, or a non-btrfs source) is unchanged.
 * Exported as the single home of this normalization: every findmnt-source
 * comparison against a mapper path (topology here, fs-grow in ahr-expand-exec)
 * MUST run through it — a raw `source === mapperPath` MISSES every §12
 * subvol-layout pool.
 */
export function stripSubvolSuffix(source: string): string {
  return source.replace(SUBVOL_SOURCE_SUFFIX_RE, '')
}

/**
 * The three MISSING-LAYER advisories, as functions rather than inline strings
 * so the create-status overlay can recognise and drop them (issue #7): while a
 * pool is being built — or after a create job died partway — "volume group not
 * found" is the expected consequence of where the job got to, not an
 * independent diagnosis, and repeating it alongside the job's real error buries
 * the one line the operator needs.
 */
export function missingVgAdvisory(pool: string): string {
  return `volume group '${pool}' not found — the LVM layer of this pool is missing or inactive`
}

/** @see missingVgAdvisory */
export function missingLvAdvisory(pool: string): string {
  return `logical volume '${pool}-vol' not found — the pool's filesystem volume is missing`
}

/** @see missingVgAdvisory */
export function notMountedAdvisory(pool: string): string {
  return `pool '${pool}' filesystem is not mounted`
}

/**
 * The `pool '<name>' ` subject the offline advisory opens with — defined once
 * because the dashboard card strips exactly this prefix to reuse the sentence
 * (a card supplies its own subject). Not a general advisory helper.
 */
function advisorySubject(pool: string): string {
  return `pool '${pool}' `
}

/**
 * The verdict clause that opens the offline advisory — the marker the dashboard
 * card matches on to lift the SAME sentence (see {@link buildAhrWarnings}), so
 * the two altitudes share one string instead of two that can drift.
 */
const OFFLINE_VERDICT = 'is OFFLINE — '

/**
 * The read-only clause, in ONE place — the pool advisory and the dashboard
 * card both say it, and two copies of a sentence are two sentences that drift
 * (they already had, by a full clause, before ahrcache.1 slice 2 named the
 * recovery verb).
 *
 * It names Remount because a read-only btrfs cannot be talked out of it:
 * `mount -o remount,rw` is REFUSED after an error ("remounting read-write
 * after error is not allowed", GT-20) and only umount + mount restores writes.
 * Saying "diagnose before any remount" and stopping there left the operator at
 * a screen with no way forward.
 */
export const AHR_READONLY_CLAUSE
  = 'is mounted READ-ONLY — btrfs is protecting itself after an I/O error; '
    + 'writes are stopped until the pool is remounted (Remount, in the Hybrid RAID view). '
    + 'Diagnose the cause first — a read-only pool is a symptom, not the fault'

/** The evidence behind an `offline` verdict, as {@link readAhrPools} found it. */
interface OfflineDetail {
  /** Names of the band arrays that could not start, bands ascending. */
  cannotStart: string[]
  /** How many band arrays the pool has in total (the "N of M" denominator). */
  arrayCount: number
  lvName: string
  /** The LV is listed but its state field is not `a` (parsers/lvm-report). */
  lvInactive: boolean
}

/**
 * The `offline` advisory (issue #18) — WHY the volume is unreachable, stated as
 * evidence rather than diagnosis: which of the pool's band arrays cannot start
 * (named in full, never counted anonymously or truncated) and whether the LV
 * itself is inactive, then the consequence the badge alone cannot carry.
 *
 * It deliberately does NOT guess a cause. An inactive band array can be the GT-8
 * assemble-as-all-spares state (recoverable with `mdadm --run`) or genuinely
 * missing members; the per-array advisories say which, and inventing "missing
 * members" here would be a diagnosis we have not earned.
 */
function offlineAdvisory(pool: string, detail: OfflineDetail): string {
  const causes: string[] = []
  if (detail.cannotStart.length > 0) {
    causes.push(
      `${detail.cannotStart.length} of ${detail.arrayCount} band array${detail.arrayCount === 1 ? '' : 's'} `
      + `cannot start (${detail.cannotStart.join(', ')})`,
    )
  }
  if (detail.lvInactive)
    causes.push(`the logical volume '${detail.lvName}' is not active`)
  return `${advisorySubject(pool)}${OFFLINE_VERDICT}${causes.join(' and ')}; `
    + `the filesystem cannot be mounted and its data is unavailable`
}

/**
 * Whether an array's MEMBERSHIP is that of a build/rebuild rather than a fault:
 * no member is faulty, and there are at least as many member devices as raid
 * slots (the extra/high-numbered device is the spare md is rebuilding INTO).
 *
 * This is the one honest way to tell "redundancy is still being built" from
 * "a disk failed" when no progress line is present — a queued sync (issue #9)
 * or a slot count alone cannot. A removed disk shows FEWER members than slots;
 * a failed-but-attached disk shows `(F)`. Either way this returns false and the
 * array keeps its degraded verdict.
 *
 * THE SAME RULE IS IMPLEMENTED ONCE MORE, in sysfs, as `initial_build_shape()`
 * in packaging/anas-md-event.sh (issue #14): mdadm fires `DegradedArray` for
 * every array that STARTS degraded, which is every fresh RAID5/6 band, so the
 * monitor hook needs this discrimination too. It cannot import this function —
 * it runs from mdadm's monitor loop with no daemon and no node — so the two are
 * deliberately parallel and MUST be kept in step. Change one, change the other.
 */
function isBuildingMembership(md: MdstatArray): boolean {
  if (md.members.some(m => m.faulty))
    return false
  return md.raidDevices !== null && md.members.length >= md.raidDevices
}

/**
 * Index (into `md.members`) of the member md is syncing ONTO, when the array's
 * shape identifies exactly one: the extra device beyond the raid slots — the
 * unique highest `[n]` with `n >= raidDevices`, which is the spare a build or a
 * rebuild is laying down (live ground truth: pve5's building bands are
 * `sdd1[5] sdl1[3] sdb1[2] sdo1[1] sdc1[0]` on `[5/4]`).
 *
 * Returns null whenever that member cannot be picked out unambiguously — a tied
 * maximum, no device beyond the slots, or an unknown slot count. The advisory
 * then names no disk at all: mdstat is the only evidence here, and a WRONG disk
 * id in an advisory is worse than no disk id (issue #15).
 */
function syncTargetIndex(md: MdstatArray): number | null {
  const slots = md.raidDevices
  if (slots === null)
    return null
  let best: number | null = null
  let tied = false
  md.members.forEach((m, i) => {
    if (m.faulty || m.number < slots)
      return
    if (best === null || m.number > md.members[best].number) {
      best = i
      tied = false
    }
    else if (m.number === md.members[best].number) {
      tied = true
    }
  })
  return tied ? null : best
}

/**
 * One band array's state, fused from mdstat (GT-8/GT-9 aware):
 *  - an array that CANNOT START (mdstat `inactive`, the GT-8 all-spares shape)
 *    → 'inactive', checked first and reported as what mdstat says it is. This
 *    is the same `md.active === false` the pool-state fusion below reads for its
 *    `offline` verdict, so the two levels cannot disagree: a band with this
 *    state always sits in an offline pool. It used to return 'degraded' (issue
 *    #18 widened the POOL state and left the band as it was), which flattened
 *    two different facts into one amber word — a band down a member still
 *    serves its stripe, a band that cannot start serves nothing and pulls its
 *    PV out of the VG. Naming the difference is what tells the operator which
 *    bands the recovery ladder (§5.1) actually has to address.
 *  - a running `recovery` → 'recovering', checked BEFORE the degraded
 *    verdict: recovery is md actively (re)building redundancy — the initial
 *    RAID5/6 build ("building — pool usable now", §3), a §11 spare
 *    auto-failover, or a re-add/replace rebuild. It must NOT card as a
 *    degraded failure (§10); pool state fuses to 'rebuilding'.
 *  - a QUEUED sync (`resync=DELAYED`/`PENDING`) on an array with every slot
 *    populated and no faulty member → 'recovering' too (issue #9). The kernel
 *    serializes syncs across arrays that share physical disks, and a queued one
 *    prints NO progress line — so a mixed-media pool's second and third RAID5/6
 *    bands sit at `[n/n-1]` with `sync === null` and used to read as a DEGRADED
 *    ARRAY WITH A FAILED DISK on a pool minutes old. Live ground truth (pve5,
 *    issue #7): sysfs `sync_action` reads `recover` for the delayed arrays too,
 *    `mdadm --detail` says "clean, degraded, resyncing (DELAYED)" with
 *    `Failed Devices : 0` and a spare rebuilding.
 *  - only after ruling out a running OR queued recovery does reduced redundancy
 *    read as 'degraded' — the §8 disk-fault-during-reshape case stays degraded
 *    (its sync is a `reshape`, not a `recovery`) and DOES card.
 *  - a lingering faulty slot with EVERY raid slot in sync (the consumed-spare
 *    §11 shape) is NOT degraded: redundancy is intact; the consumed-spare
 *    advisory carries the "remove/replace the failed disk" message.
 *  - auto-read-only is NOT a fault (GT-9) — it maps to clean.
 *  - a running `check` keeps state clean/degraded; sync{} carries it.
 */
function arrayState(md: MdstatArray): ArrayState {
  if (!md.active)
    return 'inactive'
  if (md.sync?.action === 'recovery')
    return 'recovering'
  // A sync the kernel has QUEUED behind another array's (they share physical
  // disks) prints no progress line, so an initial RAID5/6 build reads `[n/n-1]`
  // with no sync — indistinguishable from a failed member by slot counts alone.
  // The discriminator is the membership: an initial build (or any rebuild) has
  // every slot populated and NO faulty member, while a real fault always leaves
  // an `(F)` member or one fewer member than raid slots (issue #9).
  if ((md.syncDelayed || md.syncPending) && isBuildingMembership(md))
    return 'recovering'
  const degraded = md.raidDevices !== null && md.activeDevices !== null
    ? md.activeDevices < md.raidDevices
    : md.members.some(m => m.faulty && !m.spare)
  if (degraded)
    return 'degraded'
  if (md.sync) {
    switch (md.sync.action) {
      // 'recovery' is handled above (it wins over the degraded verdict).
      case 'resync': return 'resyncing'
      case 'reshape': return 'reshaping'
      case 'check': return 'clean'
    }
  }
  return 'clean'
}

/**
 * The AHR topology read FAILED: `cat /proc/mdstat` or one `mdadm --detail
 * --export` answered with a non-zero exit, so the node's md arrays could not
 * be enumerated and "there are no ANAS pools" cannot be asserted (D12). This
 * is the shape the throw already had for a spawn failure (mode B) — a failed
 * READ (mode A) is the same fact and now rides the same typed error, so every
 * existing fail-open caller keeps working and the readers answer a sentence.
 * It is deliberately NOT thrown for a topology that IS readable but names no
 * AHR array (a foreign md): that is honestly "no pools", an empty list. An
 * ABSENT `/proc/mdstat` (coreutils cat's ENOENT line, exit 1) is also NOT this
 * error — no md stack is honestly "no arrays"; only a read that could not SEE
 * throws.
 */
export class AhrTopologyUnreadableError extends Error {
  constructor(
    /** The command whose non-zero exit made the topology unreadable — names what could not be read. */
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`the AHR topology could not be read (${command} exited ${exitCode}: ${stderr.trim().split('\n')[0] || 'no stderr'})`)
    this.name = 'AhrTopologyUnreadableError'
  }
}

/**
 * Read every AHR pool from the live system. Returns schema-validated
 * {@link AhrPool} records; an empty list when no AHR arrays exist, when the
 * readable topology names none (a foreign md — not ours), and when
 * `/proc/mdstat` is ABSENT: the node has no md stack, honestly "no arrays".
 * Throws {@link AhrTopologyUnreadableError} on every OTHER failed read — a
 * non-zero exit of `cat /proc/mdstat` (Permission denied, an I/O error) or of
 * `mdadm --detail --export` for any array (D12): a read that cannot see
 * cannot assert "no ANAS pools"; only a FAILED read is unreadable. The absent
 * case is belt-and-braces — PVE kernels build md in, so `/proc/mdstat`
 * exists and reads exit 0 with "unused devices: <none>" when there are no
 * arrays (coordinator-proven on the stunt node and the dev box).
 */
export async function readAhrPools(executor: CommandExecutor, mdadmConfPath?: string): Promise<AhrPool[]> {
  const mdstatRes = await executor.exec(CAT, MDSTAT_CAT_ARGS, MDSTAT_READ_OPTS)
  if (mdstatRes.exitCode !== 0) {
    // An ABSENT /proc/mdstat — coreutils cat exits 1 printing
    // `cat: /proc/mdstat: No such file or directory`, nothing else — is
    // honestly "no md arrays": the node has no md stack, and a guest with no
    // arrays reports none. PVE kernels build md IN, so on a real node the file
    // exists and reads exit 0 with "unused devices: <none>" when there are no
    // arrays (coordinator-proven on the stunt node and the dev box); this
    // branch is belt-and-braces. EVERY other failed read — Permission denied,
    // an I/O error — is a topology that could not be seen: it must not read
    // as "no pools" either (D12).
    if (CAT_MISSING_RE.test(mdstatRes.stderr))
      return []
    throw new AhrTopologyUnreadableError('cat /proc/mdstat', mdstatRes.exitCode, mdstatRes.stderr)
  }
  const mdArrays = parseMdstat(mdstatRes.stdout)
  if (mdArrays.length === 0)
    return []

  // Identify each array via --detail --export (superblock name/UUID — the
  // stable identities). A --detail that EXITS NON-ZERO is a failed read (the
  // array could not be detailed): the topology is unreadable, not a pool that
  // is "not ours" — an empty detail would silently match no AHR name and a
  // LIVE pool would read as "no AHR pools" (D12). Non-AHR-named arrays whose
  // detail DID answer are foreign: not ours to report.
  const discovered: DiscoveredArray[] = []
  for (const md of mdArrays) {
    const res = await executor.exec(MDADM, mdadmDetailExportArgs(`/dev/${md.kernelName}`))
    if (res.exitCode !== 0)
      throw new AhrTopologyUnreadableError(`mdadm --detail --export /dev/${md.kernelName}`, res.exitCode, res.stderr)
    const detail = parseMdadmDetailExport(res.stdout)
    const named = matchAhrArrayName(detail.name ?? detail.devName ?? '')
    if (!named)
      continue
    // Level: prefer the superblock's (export); mdstat's personality backs it
    // up for inactive arrays (which export may still report).
    const level = detail.level ?? md.personality ?? ''
    if (!AHR_LEVELS.has(level))
      continue
    discovered.push({ ...named, level: level as ArrayLevel, mdstat: md, detail })
  }
  if (discovered.length === 0)
    return []

  const [lsblkRes, byIdFirst, vgsRes, lvsRes, pvsRes, findmntRes] = await Promise.all([
    executor.exec(LSBLK, AHR_LSBLK_ARGS),
    executor.exec(LS, ['-la', '/dev/disk/by-id/']),
    executor.exec(VGS, VGS_ARGS),
    executor.exec(LVS, LVS_ARGS),
    // pvs joins the SAME parallel batch, so the extra truth costs no latency.
    // It is what tells array capacity that LVM has not picked up (issue #13)
    // from capacity that is genuinely unprotected.
    executor.exec(PVS, PVS_ARGS),
    executor.exec(FINDMNT, AHR_FINDMNT_ARGS),
  ])
  // cr3 review 10: `ls -la` exits 1 when a link vanishes between its readdir
  // and its lstat — udev churn while a disk is (re)partitioned, the very
  // moment an expansion re-reads the topology at its reguard. One retry after
  // a short settle; a second failure is unreadable like every other read.
  let byIdRes = byIdFirst
  if (byIdRes.exitCode !== 0) {
    await executor.exec(UDEVADM, BY_ID_RETRY_SETTLE_ARGS, { timeoutMs: BY_ID_RETRY_SETTLE_BUDGET_MS }).catch(() => null)
    byIdRes = await executor.exec(LS, ['-la', '/dev/disk/by-id/'])
  }

  // cr3 AHR-CORE-M5 / INVENTED-STATE-M4: every read the pools are built from
  // is checked. A failed vgs read as "no VG" and fused the pool to `failed`
  // ("LVM layer missing", a critical card) — or, with no mdadm.conf pin, made
  // the pool VANISH; a failed by-id listing put kernel names where disk ids
  // belong (destroy's disk locks); a failed lsblk read as zero partitions. A
  // read that could not see raises the same unreadable error the md layer
  // raises: the whole read is unavailable, never a pool built from it.
  for (const [read, res, shapeOk] of [
    [`lsblk ${AHR_LSBLK_ARGS.join(' ')}`, lsblkRes, () => isLsblkTree(lsblkRes.stdout)],
    ['ls -la /dev/disk/by-id/', byIdRes, () => true],
    ['vgs', vgsRes, () => isLvmReport(vgsRes.stdout, 'vg')],
    ['lvs', lvsRes, () => isLvmReport(lvsRes.stdout, 'lv')],
    ['pvs', pvsRes, () => isLvmReport(pvsRes.stdout, 'pv')],
  ] as const) {
    if (res.exitCode !== 0)
      throw new AhrTopologyUnreadableError(read, res.exitCode, res.stderr)
    if (!shapeOk())
      throw new AhrTopologyUnreadableError(read, res.exitCode, 'the output is not in the expected shape')
  }
  const lsblk = indexLsblk(lsblkRes.stdout)
  const byIdMap = parseDiskByIdListing(byIdRes.stdout)
  const vgs = parseVgsReport(vgsRes.stdout)
  const lvs = parseLvsReport(lvsRes.stdout)
  const pvs = parsePvsReport(pvsRes.stdout)
  // INVENTED-STATE-H3: the mount table is the one read a pool can be described
  // without — but then whether btrfs forced it READ-ONLY is unknown, and the
  // pool never fuses to a verdict below that rung (state `unknown`,
  // `mountedReadOnly` absent, an advisory naming the read).
  const mountsKnown = findmntRes.exitCode === 0 && parseFindmntTable(findmntRes.stdout) !== null
  const mounts = mountsKnown ? parseFindmnt(findmntRes.stdout) : []

  // The ANAS-managed mdadm.conf — an ARRAY pin (by UUID) is the ANAS-authored
  // ownership marker (§2.6, config-is-the-API). Read fail-open: an unreadable
  // conf means "no pins", which only ever makes ownership STRICTER (a pool
  // then needs its VG to be claimed) — never looser.
  const strictConfDoc = await readMdadmConfDocStrict(mdadmConfPath)
  const mdadmConfDoc = strictConfDoc ?? await readMdadmConfDoc(mdadmConfPath)

  // Group arrays by pool, bands ascending.
  const byPool = new Map<string, DiscoveredArray[]>()
  for (const d of discovered) {
    const list = byPool.get(d.pool) ?? []
    list.push(d)
    byPool.set(d.pool, list)
  }

  const poolEntries = [...byPool.entries()]
  poolEntries.sort(([a], [b]) => a.localeCompare(b))
  const pools: AhrPool[] = []
  for (const [poolName, arrayEntries] of poolEntries) {
    arrayEntries.sort((a, b) => a.band - b.band)

    // ---- Ownership gate (guest philosophy, §12) -----------------------------
    // A `<pool>-r<N>`-NAMED md array is claimed as an AHR pool ONLY with
    // evidence ANAS built (or can adopt) the full stack — otherwise a
    // hand-built `media-r1` would be seized as pool "media", card critical,
    // and offer to zero its superblocks + zap its disks. The evidence is
    // either:
    //   (a) the matching LVM VG exists — the adoptable mdadm→LVM→btrfs shape
    //       (stateless adoption stays intact, §5.3), OR
    //   (b) at least one of the pool's arrays is pinned by UUID in the
    //       ANAS-managed mdadm.conf — the ANAS-authored marker that keeps a
    //       genuinely FAILED ANAS pool (VG gone) still visible/reportable.
    // A name-collision array with NEITHER is foreign: ignored (a log line at
    // most), never reported.
    //
    // And the evidence is per ARRAY, not per name (story ident.3, identity
    // audit #4): a same-named array from another pool — a foreign `media-r1`
    // beside an ANAS pool `media`, or a disk moved in from another node — used
    // to MERGE into this pool as a second band 1, and every verb downstream
    // then acted on its members. Only arrays whose UUID is pinned for the pool,
    // or that are PVs of its VG, are the pool's ({@link isOwnedArray}, the ONE
    // rule destroy, the boot ladder and the expansion executor also use).
    const vg = vgs.find(v => v.name === poolName)
    const pinnedSet = pinnedUuids(mdadmConfDoc, poolName)
    const vgPvs = poolPvNames(pvs, poolName)
    const ownedEntries = arrayEntries.filter(e => isOwnedArray(
      { pool: poolName, band: e.band, uuid: e.detail.uuid, kernelName: e.mdstat.kernelName },
      pinnedSet,
      vgPvs,
      vg !== undefined,
    ))
    const foreignCount = arrayEntries.length - ownedEntries.length
    if (foreignCount > 0) {
      process.stderr.write(
        `ahr.topology: ignoring ${foreignCount} md array(s) named '${poolName}-r*' — not pinned for the pool in mdadm.conf and not a PV of its VG; not this pool's\n`,
      )
    }
    if (ownedEntries.length === 0)
      continue
    arrayEntries.length = 0
    arrayEntries.push(...ownedEntries)

    const advisories: string[] = []

    // ---- Arrays + membership ------------------------------------------------
    interface Membership { diskKernel: string, band: number, partSize: number, spare: boolean }
    const memberships: Membership[] = []
    const arrays: AhrArray[] = arrayEntries.map((entry) => {
      const members: AhrArrayMember[] = entry.mdstat.members.map((m) => {
        const part = lsblk.partsByKernel.get(m.device)
        const diskKernel = part?.disk.name ?? wholeDiskKernel(m.device)
        const diskId = byIdMap.get(diskKernel) ?? diskKernel
        const partNumber = part?.partNumber
          ?? (PART_NUMBER_RE.test(m.device) ? Number.parseInt(m.device.match(PART_NUMBER_RE)![1], 10) : null)
        // Partition identity: the by-id form when the disk resolved, else the
        // kernel path (defensive fallback — GT-2 keying is by-id first).
        const partition = byIdMap.has(diskKernel) && partNumber !== null
          ? `/dev/disk/by-id/${diskId}-part${partNumber}`
          : `/dev/${m.device}`
        memberships.push({
          diskKernel,
          band: entry.band,
          partSize: part?.size ?? 0,
          // Spare only counts on an ACTIVE array: an inactive array lists
          // EVERY member as (S) (GT-8) and must not relabel real members as
          // pool-level hot spares (§11 role fusion below).
          spare: m.spare && entry.mdstat.active,
        })
        return {
          disk: diskId,
          partition: partition as AhrArrayMember['partition'],
          memberState: m.faulty
            ? 'faulty' as const
            : m.spare
              ? 'spare' as const
              : m.replacement ? 'rebuilding' as const : 'in_sync' as const,
        }
      })

      const state = arrayState(entry.mdstat)
      // Consumed-spare detection (§11): a faulty slot alongside a rebuild
      // already running (md's automatic failover) or already finished (every
      // raid slot back in sync) means a spare was consumed by this band. The
      // advisory is view-level only — it deliberately does NOT card (§10).
      const slotsFull = entry.mdstat.raidDevices !== null && entry.mdstat.activeDevices !== null
        && entry.mdstat.activeDevices >= entry.mdstat.raidDevices
      const spareConsumed = entry.mdstat.active
        && entry.mdstat.members.some(m => m.faulty)
        && (slotsFull || entry.mdstat.sync?.action === 'recovery')
      if (!entry.mdstat.active) {
        advisories.push(`array ${poolName}-r${entry.band} is INACTIVE (assembled with all members as spares — the GT-8 post-power-loss state); the recovery ladder (mdadm --run, then --readwrite) is required`)
      }
      else if (spareConsumed) {
        const failed = members.filter(m => m.memberState === 'faulty').map(m => m.disk)
        advisories.push(`spare consumed by band ${entry.band} — add a new spare; remove/replace the failed disk${failed.length ? ` (${failed.join(', ')})` : ''}`)
      }
      else if (state === 'recovering' && (entry.mdstat.syncDelayed || entry.mdstat.syncPending)) {
        // Queued behind another band's sync (issue #9). Slot counts look
        // degraded and there is no progress line — say what it IS, and no more.
        // NEVER the replace-the-failed-disk line: no fault is recorded here.
        advisories.push(`array ${poolName}-r${entry.band}: sync queued behind another band — no fault recorded`)
      }
      else if (state === 'recovering' && isBuildingMembership(entry.mdstat)) {
        // A sync is running with zero faulty members and every raid slot
        // accounted for. THAT IS ALL THE SYSTEM KNOWS (issue #15): mdstat is
        // byte-identical between a fresh array's first build and a rebuild onto
        // a spare whose dead disk was PULLED rather than failed in place —
        //   fresh build   md127 : active raid5 sdd1[3] sdc1[1] sdb1[0]  [3/2] [UU_]
        //   pulled+spare  md127 : active raid5 sde1[4] sdd1[3] sdc1[1]  [3/2] [_UU]
        // no (F) in either, and the superblock records no "has ever been
        // optimal". So the advisory states the observation — which member is
        // being synced onto, and that no fault is recorded — and makes NO claim
        // about which of the two situations this is, and never that there is
        // nothing to do. If a disk really was pulled, the operator's own
        // knowledge (and the mdadm monitor notification fired at the moment of
        // the pull) completes the picture; a confident "no action needed" would
        // actively contradict it.
        const target = syncTargetIndex(entry.mdstat)
        const onto = target !== null ? ` onto ${members[target].disk}` : ''
        advisories.push(`array ${poolName}-r${entry.band}: syncing${onto} — no fault recorded`)
      }
      else if (state === 'degraded') {
        advisories.push(`array ${poolName}-r${entry.band} is degraded — replace the failed disk before a second failure`)
      }

      const sync: AhrArraySync | undefined = entry.mdstat.sync
        ? {
            action: toSyncAction(entry.mdstat.sync.action),
            percent: entry.mdstat.sync.percent,
            speedBytesSec: (entry.mdstat.sync.speedKibPerSec ?? 0) * 1024,
            etaSeconds: (entry.mdstat.sync.finishMinutes ?? 0) * 60,
          }
        : undefined

      // md semantics: the SMALLEST member slice defines the band — a member
      // whose topmost partition spilled past the boundary (geometry clamp on
      // a raw tail) must not inflate the band height and push derived
      // boundaries past every disk.
      const memberSizes = entry.mdstat.members
        .map(m => lsblk.partsByKernel.get(m.device)?.size ?? 0)
        .filter(s => s > 0)
      const heightBytes = memberSizes.length ? Math.min(...memberSizes) : 0
      return {
        device: `/dev/md/${poolName}-r${entry.band}` as AhrArray['device'],
        band: entry.band,
        level: entry.level,
        heightBytes,
        members,
        state,
        ...(sync ? { sync } : {}),
        // Transient convenience only — never persisted or keyed on (GT-2).
        kernelName: entry.mdstat.kernelName,
        // The identity the pool is matched on (story ident.3) — what an
        // expansion intent records and a destroy confirm is bound to.
        ...(canonicalMdUuid(entry.detail.uuid) ? { uuid: canonicalMdUuid(entry.detail.uuid)! } : {}),
        // md's own slot count (cr3): the rows above include spares, replace
        // targets and failed members, so they are never the slot count.
        ...(entry.mdstat.raidDevices !== null && entry.mdstat.raidDevices > 0 ? { raidDevices: entry.mdstat.raidDevices } : {}),
      }
    })

    // ---- Disks --------------------------------------------------------------
    // Band of each member partition, from live array membership.
    const bandByPartKernel = new Map<string, number>()
    for (const entry of arrayEntries) {
      for (const m of entry.mdstat.members)
        bandByPartKernel.set(m.device, entry.band)
    }
    const diskKernels = [...new Set(memberships.map(m => m.diskKernel))]
    diskKernels.sort()
    const disks: AhrDisk[] = diskKernels.map((kernel) => {
      const id = byIdMap.get(kernel) ?? kernel
      const mine = memberships.filter(m => m.diskKernel === kernel)
      // Every AHR partition on this disk, banded via array membership first,
      // then its member LABEL (covers not-yet-arrayed slices). The label is
      // read through matchPartitionLabel — the inverse of the function CREATE
      // writes labels with, and the same recognizer destroy's sweep uses
      // (issue #16), so no two AHR paths can disagree about what a member
      // partition of this pool looks like on disk.
      const partitions: AhrDiskPartition[] = []
      for (const [partKernel, part] of lsblk.partsByKernel) {
        if (part.disk.name !== kernel)
          continue
        const labeled = part.partlabel !== null ? matchPartitionLabel(poolName, part.partlabel) : null
        const band = bandByPartKernel.get(partKernel) ?? labeled?.band ?? null
        if (band === null)
          continue
        const device = byIdMap.has(kernel) && part.partNumber !== null
          ? `/dev/disk/by-id/${id}-part${part.partNumber}`
          : `/dev/${partKernel}`
        partitions.push({ device: device as AhrDiskPartition['device'], band, sizeBytes: part.size })
      }
      partitions.sort((a, b) => a.band - b.band)
      const info = [...lsblk.partsByKernel.values()].find(p => p.disk.name === kernel)?.disk
      const sizeBytes = info?.size ?? 0
      return {
        id,
        sizeBytes,
        usableBytes: floorToGranularity(sizeBytes),
        model: info?.model ?? null,
        serial: info?.serial ?? null,
        role: mine.length > 0 && mine.every(m => m.spare) ? 'spare' as const : 'member' as const,
        partitions,
      }
    })

    // ---- VG / LV ------------------------------------------------------------
    // `vg` resolved at the ownership gate above; a missing VG here means a
    // pinned-but-failed pool (state fuses to 'failed', §3).
    if (!vg)
      advisories.push(missingVgAdvisory(poolName))
    // The design's one-LV convention is `<pool>-vol`; tolerate a foreign-named
    // single LV in the VG rather than reporting nothing.
    const lv = lvs.find(l => l.vgName === poolName && l.name === `${poolName}-vol`)
      ?? lvs.find(l => l.vgName === poolName)
    if (!lv)
      advisories.push(missingLvAdvisory(poolName))

    // ---- Read cache (§13, story ahrcache.1) ---------------------------------
    // `dmsetup status` is asked ONLY when the LV is a cache target: on an
    // uncached pool — every pool before this story — the read costs nothing.
    // It is asked on EVERY read of a cached one, because `lvs` cannot tell a
    // warm cache from a dead one: its counters go STALE rather than absent
    // (GT-23), and the pool then reports healthy while serving EIO to every
    // read (GT-19). dmsetup answers with one token.
    //
    // NOT asked for an INACTIVE volume: it has no dm table, dmsetup answers
    // "Device does not exist", and that answer says nothing about the cache —
    // the usual cause is a band array that did not assemble. The cache-state
    // builder reads the inactive LV as `inactive` (or `failed` when the cache
    // PV's device is itself gone), never from a dm answer that cannot exist.
    const lvName = lv?.name ?? `${poolName}-vol`
    let dmStatus: DmStatusLine | null = null
    if (lv && lvIsCacheTarget(lv.attr) && lvIsActive(lv.attr) !== false) {
      const res = await executor.exec(DMSETUP, dmsetupStatusArgs(dmName(poolName, lvName)))
      if (res.exitCode === 0)
        dmStatus = parseDmsetupStatus(res.stdout)
    }
    const cacheFacts = buildAhrCacheState({
      poolName,
      lv,
      pvs,
      bandCount: poolBandCount(poolName, arrayEntries.length, strictConfDoc),
      partsByKernel: lsblk.partsByKernel,
      byIdMap,
      dmStatus,
    })
    // The cache disks join the pool's disk set with role 'cache'. That single
    // fact is what /v1/disks reads to attribute the disk to this pool (GT-22:
    // it reported `other`, unattributed) and what puts the slice on destroy's
    // wipe list. `partitions: []` is deliberate — the slice backs no band, and
    // every band-math consumer here filters on role 'member' anyway.
    for (const cacheId of cacheFacts.diskIds) {
      const kernel = [...byIdMap.entries()].find(([, id]) => id === cacheId)?.[0]
      const info = kernel !== undefined
        ? [...lsblk.partsByKernel.values()].find(p => p.disk.name === kernel)?.disk
        : undefined
      const sizeBytes = info?.size ?? 0
      disks.push({
        id: cacheId,
        sizeBytes,
        usableBytes: floorToGranularity(sizeBytes),
        model: info?.model ?? null,
        serial: info?.serial ?? null,
        role: 'cache',
        partitions: [],
      })
    }
    if (cacheFacts.cache.state === 'failed')
      advisories.push(cacheFailedAdvisory(poolName))
    // A PV an operator put in the VG by hand: not a pool disk (so not on
    // destroy's wipe list), but never invisible either.
    if (cacheFacts.foreignPvs.length > 0)
      advisories.push(foreignVgPvAdvisory(poolName, cacheFacts.foreignPvs))

    // ---- Mount + btrfs ------------------------------------------------------
    const mapperPath = `/dev/mapper/${dmName(poolName, lvName)}`
    // findmnt appends the mounted subvolume to a btrfs source
    // (`…-vol[/@data]`) — an exact `source === mapperPath` match MISSES every
    // §12 subvol-layout pool and falls through to the options-less lsblk
    // fallback below, which reads subvolLayout false. Strip the suffix so the
    // real mount (carrying subvol=@data) is found and its options preserved.
    // A daemon-run `mount -c` (cr.52r's fd-pinned direct mount) records the LV
    // path AS GIVEN — `/dev/<vg>/<lv>`, never canonicalised to the mapper name
    // (stunt node, 2026-10-17) — so both spellings name the pool's mount.
    const mount = mounts.find(m => [mapperPath, `/dev/${poolName}/${lvName}`].includes(stripSubvolSuffix(m.source)))
      ?? (lsblk.lvmByDmName.get(dmName(poolName, lvName))?.mountpoint
        ? { target: lsblk.lvmByDmName.get(dmName(poolName, lvName))!.mountpoint!, source: mapperPath, fstype: 'btrfs', options: '' }
        : null)
    // null = unknown: an unreadable mount table cannot say whether a mount is
    // read-only, and lsblk (the fallback source of a mount) carries no options
    // (INVENTED-STATE-H3). With NO mount either, `false` would claim the pool
    // is writable on a read that never happened.
    const readonly: boolean | null = !mountsKnown ? null : mount ? optionsReadOnly(mount.options) : false
    // §12 subvolume layout: read live from the mount's `subvol=` option — a
    // pool mounted `subvol=@data` carries the snapshot layout; a flat pool
    // (subvol=/, subvolid=5) does not. The mount is the source of truth;
    // nothing is precomputed or persisted (§5.3).
    // null (unknown) in the two shapes that read nothing:
    //  - the mount table could not be read (and lsblk carries no options, so
    //    `false` would tell the operator a snapshot-layout pool was a flat one
    //    to destroy — cr3 review 3);
    //  - the pool is NOT MOUNTED (cr4 D-30): a flat pool and an unmounted one
    //    are indistinguishable without a mount, and `false` sent a snapshot
    //    create to advise destroying a pool it had never looked at. Consumers
    //    refuse an unmounted pool and say so.
    const subvolLayout: boolean | null = mount === null || !mountsKnown ? null : isSubvolLayoutMount(mount.options)
    if (!mount)
      advisories.push(notMountedAdvisory(poolName))
    if (!mountsKnown) {
      advisories.push(`the kernel mount table could not be read (findmnt exited ${findmntRes.exitCode}) — whether '${poolName}' is mounted read-only is unknown`)
    }

    // The filesystem's usage — only a MOUNTED filesystem has one to read. A
    // failed read is unknown (null), never 0 used / 0 free (cr3).
    let btrfs = null
    let btrfsScrubRunning: boolean | null = false
    if (mount) {
      const usageRes = await executor.exec(BTRFS, btrfsUsageArgs(mount.target))
      if (usageRes.exitCode === 0)
        btrfs = parseBtrfsUsage(usageRes.stdout)
      else
        advisories.push(`the filesystem usage of '${poolName}' could not be read (btrfs filesystem usage exited ${usageRes.exitCode}) — used and free space are unknown`)
      // Not asked while a band is CHECKING: the pool already fuses to
      // `scrubbing` on md's own word, and the scrub route reads the btrfs pass
      // only when no band checks (scrub.r2). Not read = null, never `false`.
      btrfsScrubRunning = arrayEntries.some(e => e.mdstat.sync?.action === 'check')
        ? null
        : await readBtrfsScrubRunning(executor, mount.target)
    }

    // ---- Capacity (§3 — report what IS, GT-14: free space is READ) ----------
    const memberDisks = disks.filter(d => d.role === 'member')
    const rawBytes = memberDisks.reduce((sum, d) => sum + d.usableBytes, 0)
    // usable = the actual block capacity the filesystem sits on (LV size; the
    // btrfs device size equals it when mounted) — never the band-math ideal.
    // cr3: null when there is nothing to measure — no LV and no readable
    // filesystem; used/free null when not mounted or the usage read failed.
    // Never a placeholder 0.
    const usableBytes = lv?.sizeBytes ?? btrfs?.deviceSizeBytes ?? null
    const usedBytes = btrfs?.usedBytes ?? null
    const freeBytes = btrfs?.freeEstimatedBytes ?? null
    // Redundancy overhead: what the member slices carry beyond each array's
    // net size (parity/mirror copies + md metadata) — from observed sizes.
    let redundancyOverheadBytes = 0
    for (const entry of arrayEntries) {
      const arraySize = (entry.mdstat.blocks ?? 0) * 1024
      const memberBytes = entry.mdstat.members
        .filter(m => !m.spare && !m.replacement)
        .reduce((sum, m) => sum + (lsblk.partsByKernel.get(m.device)?.size ?? 0), 0)
      redundancyOverheadBytes += Math.max(0, memberBytes - arraySize)
    }
    // Pending (§5.2): member-disk capacity above the top array boundary —
    // physically present, not yet usable. Derived per disk from what is
    // actually partitioned, floored to the layout granularity.
    const tier = arrayEntries.some(e => e.level === 'raid6') ? 'ahr2' as const : 'ahr1' as const
    let pendingBytes = 0
    let pendingDisks = 0
    for (const d of memberDisks) {
      const covered = d.partitions.reduce((sum, p) => sum + p.sizeBytes, 0)
      const pend = floorToGranularity(Math.max(0, d.sizeBytes - MIB - covered))
      if (pend > 0) {
        pendingBytes += pend
        pendingDisks++
      }
    }
    if (pendingBytes > 0) {
      const needed = AHR_MIN_DISKS[tier] - pendingDisks
      advisories.push(needed <= 0
        ? `${(pendingBytes / 1024 ** 3).toFixed(0)} GiB of capacity is present but not yet part of the pool — run an expansion to add it`
        : `${(pendingBytes / 1024 ** 3).toFixed(0)} GiB of capacity is pending — no new usable space until ${needed} more disk${needed === 1 ? '' : 's'} with capacity above the top band ${needed === 1 ? 'is' : 'are'} added`)
    }
    // Capacity that IS inside a protected array but that LVM has not picked up:
    // the array grew and its PV was never resized (issue #13). It is emphatically
    // not `unprotectedWasted` — it sits under full RAID redundancy — so it is
    // reported as PENDING, the bucket that means "present, not yet usable", with
    // the concrete verb that reclaims it.
    let belowLvmBytes = 0
    for (const entry of arrayEntries) {
      const pv = pvs.find(p => p.name === `/dev/${entry.mdstat.kernelName}` || p.name === `/dev/md/${poolName}-r${entry.band}`)
      // Compared against dev_size — the same basis LVM itself reports, and the
      // same predicate the resume planner uses, so the advisory and the plan
      // can never disagree. The structural margin is what keeps a HEALTHY pool
      // quiet: every fully-resized PV is a few MiB under its device (metadata
      // + PE rounding), which a bare `<` comparison read as stranded capacity
      // and rendered as the nonsensical "0 GiB is grown into the RAID arrays".
      if (!pv || pv.sizeBytes === null || pv.devSizeBytes === null || !isPvUnderSized(pv.sizeBytes, pv.devSizeBytes))
        continue
      belowLvmBytes += pv.devSizeBytes - pv.sizeBytes
    }
    if (belowLvmBytes > 0) {
      pendingBytes += belowLvmBytes
      advisories.push(
        `${(belowLvmBytes / 1024 ** 3).toFixed(0)} GiB is grown into the RAID arrays but not yet handed up to LVM — `
        + `resume or re-run the expansion to deliver it (the capacity is protected, just not yet usable)`,
      )
    }
    // With usable unknown the wasted remainder cannot be derived; it is not
    // invented either — 0 claims nothing is wasted only when usable was read.
    const unprotectedWastedBytes = usableBytes === null ? 0 : Math.max(0, rawBytes - usableBytes - redundancyOverheadBytes - pendingBytes)
    const capacity: AhrPoolCapacity = {
      rawBytes,
      usableBytes,
      usedBytes,
      freeBytes,
      redundancyOverheadBytes,
      unprotectedWastedBytes,
      pendingBytes,
    }

    // ---- Pool state fusion --------------------------------------------------
    // 'inactive' bands are deliberately NOT counted here: they are the evidence
    // for `offline`, which is decided below and outranks degraded outright. The
    // two tests read the same `md.active` flag, so a band that cannot start can
    // never fall between them and go unbadged.
    // A FAILED cache degrades the pool (§13's ruling). The bands are intact and
    // every byte is still there — writethrough never held an only copy — so
    // this is emphatically not `failed` or `offline`, which describe data that
    // is missing. One `lvconvert --uncache` restores full service.
    const anyDegraded = arrays.some(a => a.state === 'degraded') || cacheFacts.cache.state === 'failed'
    const anyReshape = arrayEntries.some(e => e.mdstat.sync?.action === 'reshape')
    const anySync = arrayEntries.some(e => e.mdstat.sync?.action === 'resync' || e.mdstat.sync?.action === 'recovery')
    const anyCheck = arrayEntries.some(e => e.mdstat.sync?.action === 'check')
    // First-build (issue #7): EVERY band is laying down redundancy — each one
    // running or queued for a resync/recovery, with intact membership (no
    // faulty, no absent member) — which is exactly a freshly created pool. A
    // reshaping band fails this test (its action is 'reshape'), so an expansion
    // still fuses to 'expanding'; a single band syncing while others are clean
    // fails it too and stays 'rebuilding'.
    const allBuilding = arrayEntries.length > 0 && arrayEntries.every((e) => {
      const md = e.mdstat
      if (!md.active || !isBuildingMembership(md))
        return false
      if (md.syncDelayed || md.syncPending)
        return true
      return md.sync?.action === 'resync' || md.sync?.action === 'recovery'
    })
    // OFFLINE (issue #18): a band array that cannot START takes its PV with it,
    // so the VG comes up partial and the concatenated LV cannot be activated —
    // no data is reachable through ANY band, not even the bands that DID start.
    // That is categorically not `degraded` (reduced redundancy, still serving),
    // and the pve5 post-lockup shape proved why the distinction has to exist:
    // r1 active-degraded (4/5), r2 and r3 "active, FAILED, Not Started", VG
    // missing 2 of 3 PVs, LV not active — the volume was unreachable while the
    // badge said "degraded", which reads as reduced-redundancy-but-functioning.
    //
    // Two independent pieces of evidence, either one sufficient:
    //  - an INACTIVE band array (mdstat's `inactive`, the GT-8 shape);
    //  - the LV present but not active (lv_attr state field ≠ 'a').
    // A `null` from lvIsActive (attr column absent) reads as active — fail-safe:
    // an offline verdict is never manufactured from evidence we do not have.
    const cannotStart = arrayEntries.filter(e => !e.mdstat.active).map(e => `${poolName}-r${e.band}`)
    const lvInactive = lv !== undefined && lvIsActive(lv.attr) === false
    const offline = cannotStart.length > 0 || lvInactive

    let state: AhrPoolState
    if (!vg || !lv)
      state = 'failed'
    // Total unavailability OUTRANKS every other verdict below it: a pool that
    // serves nothing must not wear a reduced-redundancy (`degraded`), an
    // in-progress (`building`/`expanding`/`rebuilding`/`scrubbing`) or a
    // still-readable (`readonly`) badge. Only `failed` — the LVM layer gone
    // outright — ranks above it.
    else if (offline)
      state = 'offline'
    // INVENTED-STATE-H3: read-only is unknown — every verdict below this
    // rung would be fused from a read that could not see.
    else if (readonly === null)
      state = 'unknown'
    else if (readonly)
      state = 'readonly'
    else if (anyDegraded)
      state = 'degraded'
    else if (anyReshape)
      state = 'expanding'
    else if (allBuilding)
      state = 'building'
    else if (anySync)
      state = 'rebuilding'
    // The btrfs phase of a scrub (or one started outside ANAS): md says
    // nothing about it, so the bands read idle (cr3, AHR-panel M3).
    else if (anyCheck || btrfsScrubRunning === true)
      state = 'scrubbing'
    else state = 'healthy'
    // Keyed off the FUSED state, so the advisory exists exactly when the badge
    // says offline. It leads the list: the pool-level verdict comes before the
    // per-band detail (a missing VG/LV reads `failed`, whose own advisories
    // already say the LVM layer is gone).
    if (state === 'offline')
      advisories.unshift(offlineAdvisory(poolName, { cannotStart, arrayCount: arrayEntries.length, lvName, lvInactive }))
    if (readonly)
      advisories.push(`${advisorySubject(poolName)}${AHR_READONLY_CLAUSE}`)

    pools.push(AhrPool.parse({
      name: poolName,
      ahrType: tier,
      // When unmounted there is no mountpoint to report; the LV device path is
      // the honest "where the filesystem lives" answer (never fabricated).
      mountpoint: mount?.target ?? `/dev/${poolName}/${lvName}`,
      mounted: mount != null,
      // The narrow question the Remount verb asks (slice 2). Separate from
      // `state`, whose precedence ladder lets `failed`/`offline` outrank
      // `readonly` — a UI gating the verb on the badge would hide it exactly
      // when a pool is read-only AND something else.
      // Absent when the mount table could not be read (INVENTED-STATE-H3):
      // the schema's "this daemon cannot tell me", never "writable".
      ...(readonly !== null ? { mountedReadOnly: readonly } : {}),
      disks,
      arrays,
      vg: {
        name: poolName,
        // null when the VG is not present (cr3) — never a placeholder 0.
        sizeBytes: vg?.sizeBytes ?? null,
        freeBytes: vg?.freeBytes ?? null,
        ...(vg?.uuid ? { uuid: vg.uuid } : {}),
      },
      lv: {
        name: lvName,
        sizeBytes: lv?.sizeBytes ?? null,
      },
      capacity,
      state,
      subvolLayout,
      cache: cacheFacts.cache,
      advisories,
      btrfsScrubRunning,
    }))
  }

  return pools
}

// --- Dashboard warnings (story 11.10, AHR-DESIGN §10) ------------------------

/**
 * A per-pool decoration applied between the live read and the dashboard
 * projections — how the create-job status overlay (issue #7) reaches the
 * /v1/status sources without this module importing it. Injected as a function
 * ON PURPOSE: the topology reader is pure system truth and must not grow a
 * dependency on the job queue (nor a cycle through the overlay that consumes
 * its advisories). Default is identity, so every existing caller is unchanged.
 */
export type AhrPoolDecorator = (pool: AhrPool) => AhrPool

/**
 * Attach a pool's expansion intent AND mirror it into `advisories[]`.
 *
 * The ONE place the intent is fused onto a pool read, because the two consumers
 * disagreed before: a halted expansion raised a dashboard card while the pool's
 * own `advisories[]` came back EMPTY, so the Hybrid RAID view showed a pool with
 * a stalled expansion and nothing to say about it. Anything worth a card is
 * worth an advisory — they are the same fact at two altitudes.
 *
 * Only `halted` advises: 'running' is an in-progress operation that rides the
 * jobs strip (§10 — in-progress states deliberately do not card), and 'done' /
 * 'abandoned' intents are cleared rather than displayed.
 */
export function withExpansionIntent(pool: AhrPool, intent: AhrExpansionIntent | null): AhrPool {
  if (!intent)
    return pool
  const advisories = intent.state === 'halted'
    ? [
        ...pool.advisories,
        `expansion is HALTED — Resume (recompute and continue) or Abandon it; no new capacity is delivered until one of the two runs`,
      ]
    : pool.advisories
  return { ...pool, expansion: intent, advisories }
}

/**
 * Which array/band + which member, for the degraded card. Every degraded
 * array in the pool is named (the card stays ONE per pool); a degraded array
 * with no faulty member listed (a member gone entirely) reads "missing a
 * member". Disk ids are never truncated.
 *
 * A band that cannot start never reaches here twice over: it carries state
 * 'inactive', and its pool is `offline`, which cards through its own branch
 * naming the unstartable bands.
 *
 * Bands merely BUILDING redundancy never reach here: {@link arrayState} resolves
 * a running or queued recovery with intact membership to 'recovering' (issue
 * #9), so this function only ever describes a real fault.
 */
function degradedDetail(pool: AhrPool): string {
  const parts: string[] = []
  for (const array of pool.arrays) {
    if (array.state !== 'degraded')
      continue
    const name = `${pool.name}-r${array.band} (band ${array.band})`
    const faulty = array.members.filter(m => m.memberState === 'faulty')
    if (faulty.length > 0)
      parts.push(`array ${name} member ${faulty.map(m => `'${m.disk}'`).join(', ')} ${faulty.length === 1 ? 'is' : 'are'} faulty`)
    else
      parts.push(`array ${name} is missing a member`)
  }
  return parts.length > 0 ? parts.join('; ') : 'an array is degraded'
}

/**
 * Dashboard warning cards for AHR pools (story 11.10, AHR-DESIGN §10 — the
 * replication "only failures card" policy): ONE target-first card per pool in
 * a bad state — `offline` (naming which band arrays cannot start), `degraded`
 * (naming which array/band + which member), `failed`, `readonly`, or a HALTED
 * expansion (naming the Resume/Abandon verbs). Levels follow the §7.2 severity
 * table: offline/failed/readonly critical, degraded/halted warning. In-progress
 * expanding/rebuilding/scrubbing states ride the shared jobs strip — no card;
 * healthy/idle pools add NOTHING. View-level advisories (consumed spare,
 * flat-layout snapshots) deliberately do not card.
 */
export function buildAhrWarnings(pools: AhrPool[]): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const pool of pools) {
    const clauses: string[] = []
    let level: DashboardWarning['level'] = 'warning'
    if (pool.state === 'offline') {
      level = 'critical'
      // Reuse the pool's OWN offline advisory (readAhrPools built it where the
      // evidence is) minus the `pool '<name>' ` subject the card supplies
      // itself — so the card names the same arrays the Hybrid RAID view does
      // and the two can never disagree. The fallback covers a record that
      // reached here with the state but not the advisory (a decorated pool).
      const subject = advisorySubject(pool.name)
      const advisory = pool.advisories.find(a => a.startsWith(`${subject}${OFFLINE_VERDICT}`))
      clauses.push(advisory
        ? `${advisory.slice(subject.length)}; see the Hybrid RAID view`
        : `${OFFLINE_VERDICT}a band array cannot start or the volume is not active; its data is unavailable — see the Hybrid RAID view`)
    }
    else if (pool.state === 'failed') {
      level = 'critical'
      clauses.push('has FAILED — its LVM/filesystem layer is missing or inactive; see the Hybrid RAID view')
    }
    else if (pool.state === 'readonly') {
      level = 'critical'
      clauses.push(AHR_READONLY_CLAUSE)
    }
    // cr3 (INVENTED-STATE-H3): a pool whose state could not be decided is
    // never silently healthy on the dashboard either.
    else if (pool.state === 'unknown') {
      clauses.push('is in an unknown state — the kernel mount table could not be read, so whether its filesystem is read-only is not known; see the Hybrid RAID view')
    }
    else if (pool.state === 'degraded' && pool.arrays.some(a => a.state === 'degraded')) {
      clauses.push(`is degraded — ${degradedDetail(pool)}; replace the failed disk before a second failure`)
    }
    // A failed read cache (§13, ahrcache.1) cards on its own, whether or not a
    // band is also degraded. CRITICAL, unlike the degraded-band card, because
    // the consequence is different in kind: a degraded band still serves every
    // read, while a dead cache device makes EVERY read on the pool fail with
    // EIO — dm-cache does not fall through to the origin (GT-19). The pool's
    // BADGE stays `degraded` (§13's ruling: the data is all there and one
    // command restores service), which is why this is its own clause and not a
    // re-use of the degraded one.
    if (pool.cache?.state === 'failed') {
      level = 'critical'
      clauses.push(`has a FAILED read cache — every read returns an I/O error until the cache is detached; no data is lost (writethrough holds no only copy)`)
    }
    if (pool.expansion?.state === 'halted')
      clauses.push('has a HALTED expansion — Resume (recompute-and-continue) or Abandon it in the Hybrid RAID view')
    if (clauses.length === 0)
      continue
    warnings.push({
      level,
      category: 'ahr',
      message: `AHR pool '${pool.name}' ${clauses.join('; ')}`,
      ref: pool.name,
    })
  }
  return warnings
}

/**
 * Collect the dashboard 'ahr' warnings from the live topology + the per-pool
 * expansion intent. Fail-open per pool: an unreadable intent file degrades
 * only that pool's halted-expansion card. The D12 topology-read failure — an
 * unreadable mdstat / `--detail` — PROPAGATES as
 * {@link AhrTopologyUnreadableError} so the route marks the 'ahr' section
 * unavailable: a topology that could not be seen is never "no warnings"
 * (cr.35). Since cr3 every other error propagates too (the section reads
 * unavailable, never "no warnings"); the dashboard stays a 200 either way.
 */
export async function collectAhrWarnings(
  executor: CommandExecutor,
  intentDir?: string,
  decorate: AhrPoolDecorator = p => p,
): Promise<DashboardWarning[]> {
  // cr3 review2 1: no error reads as "no warnings" — a node whose AHR read
  // failed is not a healthy one. Every topology error propagates; the route
  // marks the 'ahr' section unavailable. Only an intent file that cannot be
  // read degrades — that one pool's halted-expansion card.
  const pools = await readAhrPools(executor)
  const withIntents = await Promise.all(pools.map(async (pool): Promise<AhrPool> => {
    try {
      const { intent } = await readPoolIntent(pool, intentDir)
      return decorate(withExpansionIntent(pool, intent))
    }
    catch {
      return decorate(pool)
    }
  }))
  return buildAhrWarnings(withIntents)
}

// --- Dashboard pool briefs (story 11.13, AHR-DESIGN §10 revision) ------------

/**
 * Derive the dashboard's per-pool briefs from the live topology — the §10
 * revision that puts healthy AHR pools in the headline Pools section with the
 * same structural presence ZFS pools get. Purely a projection of
 * {@link readAhrPools}' output (no re-parse, no extra system reads):
 *  - bands: each band array's index + RAID level + its REDUNDANT members
 *    (hot spares are excluded here — they are reported once at pool level so a
 *    "RAID5 × 4" reads as four data/parity members, not five);
 *  - spares: the pool's hot-spare disk(s), rendered in a labeled spare bay;
 *  - usedBytes: only when the pool is mounted (an unmounted pool has no btrfs
 *    usage read — capacity.usedBytes would be a placeholder 0, so it is OMITTED
 *    rather than reported as a wrong number).
 * Member/spare sizes are the raw DISK sizes (from the pool's disk list), the
 * value the UI tiles present.
 */
export function buildAhrPoolBriefs(pools: AhrPool[]): AhrPoolBrief[] {
  return pools.map((pool) => {
    const sizeById = new Map(pool.disks.map(d => [d.id, d.sizeBytes]))
    const bands: AhrBandBrief[] = pool.arrays.map((array) => {
      // Redundant members only — a hot spare rides as a member row (memberState
      // 'spare') but is not one of the array's data/parity slots, and neither
      // is an `mdadm --replace` target (`rebuilding`, mdstat `(R)`): the same
      // rows the capacity math leaves out (cr3, handed by the AHR-panel review).
      const members = array.members.filter(m => m.memberState !== 'spare' && m.memberState !== 'rebuilding')
      return {
        band: array.band,
        level: array.level,
        // md's own slot count when mdstat carried it (cr3): during a spare
        // failover the failed row and the row being rebuilt onto are both
        // listed, and counting rows would read a raid5×4 as ×5.
        memberCount: array.raidDevices ?? members.length,
        // cr3.followup: a member the disk list does not carry has an unknown
        // size (null), never an invented 0.
        members: members.map(m => ({ id: m.disk, sizeBytes: sizeById.get(m.disk) ?? null })),
        // 11.19 — PURE PROJECTION: heightBytes/state/sync are already in hand on
        // the AhrArray this brief is derived from; they were simply dropped.
        // No extra system read, no extra command, no new truth.
        heightBytes: array.heightBytes,
        state: array.state,
        ...(array.sync ? { sync: array.sync } : {}),
      }
    })
    const spares = pool.disks
      .filter(d => d.role === 'spare')
      .map(d => ({ id: d.id, sizeBytes: d.sizeBytes }))
    return AhrPoolBrief.parse({
      name: pool.name,
      state: pool.state,
      // cr3.followup: unknown is null here as it is in GET /v1/ahr (a pool
      // with no LV and no readable filesystem), never an invented 0; the
      // capacity card below makes no percentage from it.
      usableBytes: pool.capacity.usableBytes,
      // Used bytes only when the pool is mounted and btrfs usage was READ
      // (cr3: null = unknown).
      ...(pool.mounted && pool.capacity.usedBytes !== null ? { usedBytes: pool.capacity.usedBytes } : {}),
      mountpoint: pool.mountpoint,
      mounted: pool.mounted,
      subvolLayout: pool.subvolLayout,
      bands,
      spares,
    })
  })
}

/**
 * Capacity warning cards for AHR pools — PARALLEL CONSTRUCTION with ZFS pools
 * (the dashboard's `buildWarnings` 'capacity' category). Identical thresholds
 * (≥95% critical, ≥90% warning), identical wording shape ("AHR pool 'tank' is
 * 94% full"), same 'capacity' category, same ref-is-pool-name navigation the
 * AHR failure cards use — a filling AHR pool now warns exactly like a filling
 * ZFS pool.
 *
 * Percent is derived from the brief's usedBytes/usableBytes. An unmounted pool
 * (or one with no usedBytes read) carries NO usedBytes and produces NO card —
 * never a wrong number (11.13's omission discipline). A pool with no usable
 * capacity (usableBytes 0) likewise produces no card (no division by zero).
 */
export function buildAhrCapacityWarnings(briefs: AhrPoolBrief[]): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const pool of briefs) {
    // No usage read (unmounted) or no capacity → no honest percentage to card.
    if (pool.usedBytes === undefined || pool.usableBytes === null || pool.usableBytes <= 0)
      continue
    const capacity = Math.round((pool.usedBytes / pool.usableBytes) * 100)
    if (capacity >= 95) {
      warnings.push({
        level: 'critical',
        category: 'capacity',
        message: `AHR pool '${pool.name}' is ${capacity}% full`,
        ref: pool.name,
      })
    }
    else if (capacity >= 90) {
      warnings.push({
        level: 'warning',
        category: 'capacity',
        message: `AHR pool '${pool.name}' is ${capacity}% full`,
        ref: pool.name,
      })
    }
  }
  return warnings
}

/**
 * Collect the dashboard AHR pool briefs from the live topology. EVERY error
 * propagates (cr3 review2 1): the route marks the 'ahrPools' section
 * unavailable for any throw, and an empty Pools section must never read as
 * "no AHR pools" when the read failed — the typed
 * {@link AhrTopologyUnreadableError} (cr.35) and any error this function does
 * not specifically understand alike (a schema refusal, a failed read). Only
 * a READABLE topology with no AHR arrays answers `[]`.
 */
export async function collectAhrPoolBriefs(
  executor: CommandExecutor,
  mdadmConfPath?: string,
  decorate: AhrPoolDecorator = p => p,
): Promise<AhrPoolBrief[]> {
  return buildAhrPoolBriefs((await readAhrPools(executor, mdadmConfPath)).map(decorate))
}
