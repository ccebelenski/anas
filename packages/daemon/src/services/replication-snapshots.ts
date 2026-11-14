import type { Snapshot } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import { parseSnapshotList, zfsSnapshotDetailArgs } from '../parsers/zfs-list.js'
import { isTransientRunSnapshot } from './snapshot-naming.js'

/**
 * The snapshot READS replication decides on (cr3), local and remote, each
 * answering one of three things: the dataset's snapshots, "the dataset does
 * not exist", or "could not read". Before, both listings answered `[]` on any
 * failure, so a listing that failed read as "nothing replicated" — every
 * source snapshot "behind" on the task grid (REPLICATION-L6, INVENTED-STATE-M5)
 * and, in a run, a target "diverged — remove the target dataset" (the EPICS
 * bug candidate): an operator told to destroy a replica because a read failed.
 *
 * "Does not exist" is ZFS's own sentence — `cannot open '<ds>': dataset does
 * not exist` — the one fact a non-zero `zfs list` exit can carry that is not a
 * failure (the datasets routes read it the same way, `DATASET_ABSENT_RE`). Any
 * other non-zero exit, a thrown spawn, an ssh failure (exit 255) or output the
 * parser refuses is "could not read".
 *
 * ORDER (cr3, from the datasets review): "newer than" in the base search,
 * the newest-common search and the task lag means "taken later", i.e. by
 * `createtxg` — the transaction group the snapshot was taken in, which only
 * grows — never the `creation` TIME a stepped clock or a received snapshot
 * makes disagree with it. `parseSnapshotList` itself orders by `createtxg`
 * (cr3 DATASETS-SCHEDULES-H1; cr3.followup: this paragraph used to say it
 * ordered by creation time), and the local read here re-orders by it again
 * whenever every row carries one.
 */

/** ZFS's own "the dataset is not there" (stderr of a non-zero `zfs list`). */
const DATASET_ABSENT_RE = /dataset does not exist/i

/** ssh's exit status for its own failures (never the remote command's answer). */
const SSH_OWN_EXIT = 255

/** Every C0 control character and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F]/g

/** The longest failure line a sentence carries. */
const LINE_MAX = 300

export type SnapshotRead<T>
  = | { ok: true, exists: true, snapshots: T[] }
    | { ok: true, exists: false }
    | { ok: false, error: string }

/** One line of a failed command's stderr for a sentence (control characters stripped, cut). */
function failureLine(r: ExecResult, lastLine: boolean): string {
  const lines = r.stderr.split('\n').map(l => l.replace(CONTROL_RE, ' ').trim()).filter(Boolean)
  const line = lastLine ? lines.at(-1) : lines[0]
  if (line === undefined)
    return `exit ${r.exitCode}`
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}...` : line
}

/**
 * `Snapshot[]` newest-first by `createtxg` (taken-later first), when every row
 * of the `zfs list -j` answer carries one; otherwise the parser's order.
 */
export function orderByCreateTxg(snaps: Snapshot[], stdout: string): Snapshot[] {
  let datasets: Record<string, { createtxg?: unknown }> = {}
  try {
    const parsed = JSON.parse(stdout) as { datasets?: Record<string, { createtxg?: unknown }> }
    datasets = parsed.datasets ?? {}
  }
  catch {
    return snaps
  }
  const txg = new Map<string, number>()
  for (const [name, row] of Object.entries(datasets)) {
    const n = typeof row?.createtxg === 'string' || typeof row?.createtxg === 'number' ? Number(row.createtxg) : Number.NaN
    if (Number.isFinite(n))
      txg.set(name, n)
  }
  if (!snaps.every(s => txg.has(s.name)))
    return snaps
  // eslint-disable-next-line e18e/prefer-array-to-sorted -- toSorted() is ES2023; this package targets ES2022 (no such lib member)
  return [...snaps].sort((a, b) => txg.get(b.name)! - txg.get(a.name)!)
}

/** A LOCAL dataset's snapshots (newest first by createtxg), absent, or unreadable. */
export async function readLocalSnapshots(executor: CommandExecutor, dataset: string): Promise<SnapshotRead<Snapshot>> {
  let r: ExecResult
  try {
    r = await executor.exec('/usr/sbin/zfs', zfsSnapshotDetailArgs(dataset))
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (r.exitCode !== 0) {
    if (DATASET_ABSENT_RE.test(r.stderr))
      return { ok: true, exists: false }
    return { ok: false, error: failureLine(r, false) }
  }
  if (!r.stdout.trim())
    return { ok: true, exists: true, snapshots: [] }
  try {
    // `Snapshot.name` is the full `<ds>@<snap>`, the key `zfs list -j` uses.
    return { ok: true, exists: true, snapshots: orderByCreateTxg(parseSnapshotList(r.stdout), r.stdout) }
  }
  catch (err) {
    return { ok: false, error: `unreadable snapshot listing: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** How a remote command is run: the transport's own `sshExec` (the argv is the transport's). */
export type RemoteExec = (cmd: string[]) => Promise<ExecResult>

/**
 * A PEER/REMOTE dataset's snapshot NAMES (the target's own order matters: the
 * base rule asks for its newest), absent, or unreadable, NEWEST first. Two commands:
 * `zfs list -H -o name -- <ds>` (does it exist), then
 * `zfs list -H -t snapshot -o name,creation -s createtxg -- <ds>` (review of
 * cr3: `-s createtxg` added, the order ZFS took them in, never the clock).
 * ssh's own failure (exit 255) is never "absent".
 */
export async function readRemoteSnapshotNames(sshExec: RemoteExec, dataset: string, opts: { afterReceive?: boolean } = {}): Promise<SnapshotRead<string>> {
  // `afterReceive`: the re-read after a receive into the dataset, which has
  // only ever been the snapshot listing — the existence question was answered
  // by the receive itself.
  if (opts.afterReceive !== true) {
    let exists: ExecResult
    try {
      exists = await sshExec(['zfs', 'list', '-H', '-o', 'name', '--', dataset])
    }
    catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (exists.exitCode !== 0) {
      if (exists.exitCode !== SSH_OWN_EXIT && DATASET_ABSENT_RE.test(exists.stderr))
        return { ok: true, exists: false }
      return { ok: false, error: failureLine(exists, exists.exitCode === SSH_OWN_EXIT) }
    }
  }
  let r: ExecResult
  try {
    r = await sshExec(['zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name,creation', '-s', 'createtxg', '--', dataset])
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (r.exitCode !== 0)
    return { ok: false, error: failureLine(r, r.exitCode === SSH_OWN_EXIT) }
  // A line is a snapshot row only when it names THIS dataset
  // (`<dataset>@<name>`). Other lines (a login banner on stdout) are
  // skipped, but an answer that HAS lines and not one row of this dataset is
  // not "no snapshots" (review of cr3: it read as "diverged — remove the
  // target dataset"): it is a listing this reader could not read.
  const prefix = `${dataset}@`
  const names: string[] = []
  let contentLines = 0
  let firstOther = ''
  for (const line of r.stdout.split('\n')) {
    if (!line.trim())
      continue
    contentLines++
    const full = line.split('\t')[0]
    if (full.startsWith(prefix) && full.length > prefix.length)
      names.push(full.slice(prefix.length))
    else if (!firstOther)
      firstOther = line.replace(CONTROL_RE, ' ').trim()
  }
  if (contentLines > 0 && names.length === 0) {
    const shown = firstOther.length > LINE_MAX ? `${firstOther.slice(0, LINE_MAX)}...` : firstOther
    return { ok: false, error: `unreadable snapshot listing (no row of '${dataset}'): '${shown}'` }
  }
  // `-s createtxg` lists oldest first; every reader of this list wants the
  // order ZFS took the snapshots in, NEWEST first (review of cr3: the base
  // rule asks for the target's newest snapshot).
  names.reverse()
  return { ok: true, exists: true, snapshots: names }
}

/**
 * The snapshot a run sends when none is named: the source's newest that is
 * not a backup or cloud run's transient (`anas-backup-*`, `anas-cloud-*`).
 * Before (the EPICS bug candidate at `routes/replication.ts` ~:432) it was the
 * newest of all — a transient taken by a backup run in flight was sent, then
 * held on both sides under the chain's tag, so the backup run's own cleanup
 * could not destroy it. The recursive run's S has always been filtered (R4).
 */
export function newestReplicable(snaps: Snapshot[]): Snapshot | undefined {
  return snaps.find(s => !isTransientRunSnapshot(s.snapshotName))
}
