/**
 * Parser for `/proc/mdstat` (Epic 11 + AHR).
 *
 * /proc/mdstat is the ONLY source for live md sync/reshape progress — percent,
 * speed, and finish ETA have no structured alternative (ground truth GT-13:
 * this text format is the sanctioned exception to the structured-output rule).
 * Everything identity-shaped that mdstat also shows (level, member roles) is
 * cross-checked against `mdadm --detail --export` by the topology layer;
 * kernel `mdNNN` names are transient handles for the current snapshot only,
 * never stored identities (GT-2).
 *
 * Shapes proven in the stage-0 fixtures (fixtures/ahr/mdstat-*.txt):
 *  - active arrays with and without a sync line (recovery/reshape captured live)
 *  - member flags: `(F)` faulty, `(S)` spare, `(R)` replacement target
 *  - the tab-indented `resync=DELAYED` marker (queued behind another sync)
 *  - `[n/m] [UU_]` raid-devices/active counts + per-slot status string
 *  - inactive all-spares arrays (the GT-8 post-power-loss state)
 *  - `(auto-read-only)` — the NORMAL post-assembly state, not a fault (GT-9)
 */

/** /proc path — read via the executor (`cat`) so mock/dev mode can fixture it. */
export const MDSTAT_PATH = '/proc/mdstat'

/** Args for `/usr/bin/cat` to read mdstat through the CommandExecutor. */
export const MDSTAT_CAT_ARGS = [MDSTAT_PATH]

/**
 * What the sync thread reports it is doing (mdstat's own verb — note
 *  `recovery`, which the shared AhrSyncAction schema spells `recover`).
 */
export type MdstatSyncAction = 'resync' | 'recovery' | 'reshape' | 'check'

/** One member device of an array as mdstat lists it. */
export interface MdstatMember {
  /** Kernel device name, e.g. "sdc1". Transient — join to by-id upstream. */
  device: string
  /** md device number (the `[N]` suffix — NOT the raid slot). */
  number: number
  /** `(F)` — faulted out of the array. */
  faulty: boolean
  /** `(S)` — spare (also every member of an inactive array, GT-8). */
  spare: boolean
  /** `(R)` — replacement target of an in-flight `mdadm --replace`. */
  replacement: boolean
}

/** The progress line of a running sync/recovery/reshape/check. */
export interface MdstatSync {
  action: MdstatSyncAction
  /** Percent complete (0–100). */
  percent: number
  /** Blocks done / total from the `(done/total)` pair, when present. */
  doneBlocks: number | null
  totalBlocks: number | null
  /** `finish=X.Ymin` — estimated minutes remaining. */
  finishMinutes: number | null
  /** `speed=NK/sec` — KiB per second. */
  speedKibPerSec: number | null
}

/** One md array block from /proc/mdstat. */
export interface MdstatArray {
  /** Kernel name, e.g. "md127" — a transient handle, never an identity (GT-2). */
  kernelName: string
  /** false = `inactive` (GT-8: udev's conservative degraded-reshape assembly). */
  active: boolean
  /** `(read-only)` or `(auto-read-only)` marker present. */
  readOnly: boolean
  /** Specifically `(auto-read-only)` — normal until first write (GT-9). */
  autoReadOnly: boolean
  /** Personality, e.g. "raid5". null for inactive arrays (kernel omits it). */
  personality: string | null
  members: MdstatMember[]
  /** Size in 1 KiB blocks from the status line. */
  blocks: number | null
  /** `[n/m]` — n: configured raid devices. */
  raidDevices: number | null
  /** `[n/m]` — m: currently active devices (m < n ⇒ degraded). */
  activeDevices: number | null
  /** Per-slot status string, e.g. "UU_" (underscore = missing/failed slot). */
  statusFlags: string | null
  /** Present while a sync thread runs on this array. */
  sync: MdstatSync | null
  /** `resync=DELAYED` — queued behind another array's sync. */
  syncDelayed: boolean
  /** `resync=PENDING` — waiting (e.g. read-only array). */
  syncPending: boolean
}

/** `mdNNN : active|inactive [(...)] ...` header. */
const HEADER_RE = /^(md\d+)\s*:\s*(active|inactive)\b(.*)$/

/** `sdc1[1]`, `sdb1[0](F)`, `sdg1[7](R)` — device + number + flag list. */
const MEMBER_RE = /^([^\s[]+)\[(\d+)\]((?:\([A-Z]\))*)$/

/** `2089984 blocks super 1.2 ... [3/2] [UU_]` (bracket groups optional). */
const BLOCKS_RE = /^(\d+)\s+blocks\b/
const COUNTS_RE = /\[(\d+)\/(\d+)\]\s+\[([U_]+)\]\s*$/

/** `[>....................]  recovery =  1.9% (20472/1044992) finish=0.8min speed=20472K/sec` */
const SYNC_RE = /\[[=>.]+\]\s+(resync|recovery|reshape|check)\s*=\s*([\d.]+)%(?:\s+\((\d+)\/(\d+)\))?(?:\s+finish=([\d.]+)min)?(?:\s+speed=(\d+)K\/sec)?/

const WHITESPACE_RE = /\s+/

/**
 * Parse /proc/mdstat into one record per array. Total and fail-safe: lines it
 * does not recognize (Personalities, bitmap, unused devices, future drift) are
 * skipped; malformed input yields an empty list rather than throwing.
 */
export function parseMdstat(text: string): MdstatArray[] {
  const arrays: MdstatArray[] = []
  let current: MdstatArray | null = null

  for (const rawLine of text.split('\n')) {
    const header = rawLine.match(HEADER_RE)
    if (header) {
      current = {
        kernelName: header[1],
        active: header[2] === 'active',
        readOnly: false,
        autoReadOnly: false,
        personality: null,
        members: [],
        blocks: null,
        raidDevices: null,
        activeDevices: null,
        statusFlags: null,
        sync: null,
        syncDelayed: false,
        syncPending: false,
      }
      arrays.push(current)
      // Rest of the header: optional (read-only)/(auto-read-only), optional
      // personality (inactive arrays have none), then member tokens.
      for (const token of header[3].trim().split(WHITESPACE_RE).filter(t => t.length > 0)) {
        if (token === '(auto-read-only)') {
          current.readOnly = true
          current.autoReadOnly = true
          continue
        }
        if (token === '(read-only)') {
          current.readOnly = true
          continue
        }
        const member = token.match(MEMBER_RE)
        if (member) {
          const flags = member[3]
          current.members.push({
            device: member[1],
            number: Number.parseInt(member[2], 10),
            faulty: flags.includes('(F)'),
            spare: flags.includes('(S)'),
            replacement: flags.includes('(R)'),
          })
        }
        else if (current.personality === null && current.members.length === 0) {
          current.personality = token
        }
      }
      continue
    }

    if (!current)
      continue
    const line = rawLine.trim()
    if (line.length === 0)
      continue

    const blocks = line.match(BLOCKS_RE)
    if (blocks) {
      current.blocks = Number.parseInt(blocks[1], 10)
      const counts = line.match(COUNTS_RE)
      if (counts) {
        current.raidDevices = Number.parseInt(counts[1], 10)
        current.activeDevices = Number.parseInt(counts[2], 10)
        current.statusFlags = counts[3]
      }
      continue
    }

    const sync = line.match(SYNC_RE)
    if (sync) {
      current.sync = {
        action: sync[1] as MdstatSyncAction,
        percent: Number.parseFloat(sync[2]),
        doneBlocks: sync[3] ? Number.parseInt(sync[3], 10) : null,
        totalBlocks: sync[4] ? Number.parseInt(sync[4], 10) : null,
        finishMinutes: sync[5] ? Number.parseFloat(sync[5]) : null,
        speedKibPerSec: sync[6] ? Number.parseInt(sync[6], 10) : null,
      }
      continue
    }

    if (line.startsWith('resync=DELAYED'))
      current.syncDelayed = true
    else if (line.startsWith('resync=PENDING'))
      current.syncPending = true
  }

  return arrays
}
