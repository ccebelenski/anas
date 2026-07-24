import type { AhrPool } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { pveNotify } from './pve-notify.js'

/**
 * AHR pool scrub (Epic 11 + AHR, docs/AHR-DESIGN.md §4) — behind
 * POST /v1/ahr/:name/scrub. Two phases, strictly SEQUENTIAL — both are
 * full-device reads and would thrash each other concurrently (§4):
 *
 *   1. btrfs scrub (start + poll `btrfs scrub status`) — checksums the
 *      filesystem's view of the data.
 *   2. per-array `mdadm --action=check`, one band at a time, waiting on
 *      /proc/mdstat between arrays — verifies parity/mirror consistency
 *      underneath the filesystem.
 *
 * `btrfs scrub status` text is parsed minimally (Status / Bytes scrubbed % /
 * Error summary): like /proc/mdstat it has no structured alternative on the
 * shipped btrfs-progs, so it joins GT-13's sanctioned text exceptions.
 *
 * Findings notify at `warning` via PVE (§7.2); a clean scrub is silent —
 * healthy/idle shows nothing (dashboard policy §7.3).
 */

const BTRFS = '/usr/bin/btrfs'
const MDADM = '/usr/sbin/mdadm'
const CAT = '/usr/bin/cat'
const REALPATH = '/usr/bin/realpath'

/** Default poll interval while waiting on scrub/check progress. */
export const AHR_SCRUB_POLL_MS = 5000

export interface AhrScrubOptions {
  /** Poll interval override (tests use 1). */
  pollIntervalMs?: number
}

export interface AhrScrubResult {
  scrubbed: string
  /** btrfs `Error summary:` line when errors were found, else null. */
  btrfsErrors: string | null
  /** Number of md arrays checked. */
  checkedArrays: number
}

/** Minimal structured view of `btrfs scrub status`. */
interface BtrfsScrubStatus {
  /** `Status:` value (running/finished/aborted/…), or null when absent. */
  status: string | null
  /** Percent from the `Bytes scrubbed: … (N%)` line, when present. */
  percent: number | null
  /** `Error summary:` value, or null when absent. */
  errorSummary: string | null
}

const STATUS_RE = /^Status:\s+(\S+)/m
const PERCENT_RE = /^Bytes scrubbed:.*\(([\d.]+)%\)/m
const ERROR_SUMMARY_RE = /^Error summary:\s+(\S.*)$/m
const DEV_PREFIX_RE = /^\/dev\//

/** Parse the human-readable `btrfs scrub status` output (fail-open nulls). */
export function parseBtrfsScrubStatus(text: string): BtrfsScrubStatus {
  return {
    status: text.match(STATUS_RE)?.[1] ?? null,
    percent: PERCENT_RE.test(text) ? Number.parseFloat(text.match(PERCENT_RE)![1]) : null,
    errorSummary: text.match(ERROR_SUMMARY_RE)?.[1].trim() ?? null,
  }
}

/** A clean btrfs error summary (`no errors found`). */
function isCleanSummary(summary: string | null): boolean {
  return summary === null || summary === 'no errors found'
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Run a command, throwing a stderr-carrying error on non-zero exit. */
async function run(executor: CommandExecutor, command: string, args: string[]): Promise<ExecResult> {
  const r = await executor.exec(command, args)
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `${command} ${args[0] ?? ''} exited ${r.exitCode}`)
  return r
}

/**
 * Scrub an AHR pool: btrfs first, THEN each md array's check — never
 * concurrent. Progress is reported on every poll (never an unbounded silent
 * wait); scrub duration itself is unbounded by design (hours on real disks).
 */
export async function scrubAhrPool(
  executor: CommandExecutor,
  pool: AhrPool,
  updateProgress: (message: string) => void,
  opts?: AhrScrubOptions,
): Promise<AhrScrubResult> {
  const { name } = pool
  const interval = opts?.pollIntervalMs ?? AHR_SCRUB_POLL_MS
  if (!pool.mounted)
    throw new Error(`pool '${name}' is not mounted — btrfs scrub needs the filesystem online`)

  // --- Phase 1: btrfs scrub ---------------------------------------------------
  updateProgress('Starting btrfs scrub')
  await run(executor, BTRFS, ['scrub', 'start', pool.mountpoint])
  let btrfsErrors: string | null = null
  for (;;) {
    const st = parseBtrfsScrubStatus((await run(executor, BTRFS, ['scrub', 'status', pool.mountpoint])).stdout)
    if (st.status === 'running') {
      updateProgress(`btrfs scrub running${st.percent !== null ? ` (${st.percent.toFixed(1)}%)` : ''}`)
      await sleep(interval)
      continue
    }
    if (st.status === 'aborted')
      throw new Error(`btrfs scrub on '${name}' was aborted${isCleanSummary(st.errorSummary) ? '' : ` (${st.errorSummary})`}`)
    // finished — or no Status line at all (nothing to report): done either way.
    if (!isCleanSummary(st.errorSummary))
      btrfsErrors = st.errorSummary
    break
  }

  // --- Phase 2: md checks, one array at a time (sequenced, §4) ----------------
  // Band-ascending order without copying the pool's array list.
  const order = pool.arrays.map((_, i) => i)
  order.sort((x, y) => pool.arrays[x].band - pool.arrays[y].band)
  for (const i of order) {
    const array = pool.arrays[i]
    const label = `${name}-r${array.band}`
    updateProgress(`Starting md check on ${label}`)
    await run(executor, MDADM, ['--action=check', array.device])

    // /proc/mdstat keys arrays by transient kernel names (GT-2) — the topology
    // read already resolved one; fall back to realpath when absent.
    let kernelName = array.kernelName ?? null
    if (!kernelName) {
      const rp = await executor.exec(REALPATH, [array.device])
      kernelName = rp.exitCode === 0 ? rp.stdout.trim().replace(DEV_PREFIX_RE, '') : null
    }
    if (!kernelName) {
      updateProgress(`Cannot resolve ${array.device} to a kernel device — not waiting on its check`)
      continue
    }
    for (;;) {
      const md = parseMdstat((await run(executor, CAT, MDSTAT_CAT_ARGS)).stdout)
        .find(a => a.kernelName === kernelName)
      // Array gone from mdstat, or its check finished (and is not queued
      // behind another sync): move to the next band.
      if (!md || (md.sync?.action !== 'check' && !md.syncDelayed))
        break
      updateProgress(`md check on ${label}${md.sync ? ` (${md.sync.percent.toFixed(1)}%)` : ' (queued)'}`)
      await sleep(interval)
    }
  }

  // --- Findings: warn on errors, stay silent when clean (§7.3) ----------------
  if (btrfsErrors !== null) {
    await pveNotify(
      executor,
      'warning',
      'AHR scrub found errors',
      `btrfs scrub on pool '${name}' reported: ${btrfsErrors}. Latent corruption was surfaced — check 'btrfs scrub status ${pool.mountpoint}' and the pool's disks.`,
    )
  }

  return { scrubbed: name, btrfsErrors, checkedArrays: pool.arrays.length }
}
