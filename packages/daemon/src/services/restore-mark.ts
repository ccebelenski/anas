/**
 * The restore mark — a breadcrumb on the object a whole-image restore writes
 * (cr3.lunrestore, operator ruling 2026-11-14: "The failed restore should leave
 * some kind of breadcrumb, even if that's 'Restore in progress...' which would
 * allow us to be suspicious if the job doesn't exist anymore.").
 *
 * The mark is a ZFS user property (`anas:restore`, the `anas:schedule` stamp's
 * family) on the VOLUME being restored. It is set before the first byte is
 * written and removed only when the image is complete and its size verified,
 * by the Enable confirm that accepts a partial image, or replaced by the next
 * restore onto the object. It is a fact on the object, read from the object:
 * no marker file, no state directory (Principle 11).
 *
 * Ground truth (ZFS 2.4.2, `scratchpad/fullreview/captures/restore-mark.zfs2.4.2.txt`):
 * a user property on a zvol survives a full overwrite of the device; a rollback
 * does not revert it; a plain `zfs send` (ANAS replication) and a clone do not
 * carry it; `zfs inherit <prop> <vol>` clears it.
 *
 * FILE-backed LUNs (an image on a dataset or an AHR pool) carry NO mark: the
 * mark there would be an extended attribute, and setting one needs the `attr`
 * package (`setfattr`/`getfattr`), which ANAS does not install and Node's fs
 * cannot do. Held for the operator's word; until then a file backing reads
 * `unsupported` — never "absent", never "unknown" — and the doors treat it as
 * they did before this story.
 */

import type { IscsiRestoreMarkState, Job, RestoreMark as RestoreMarkType } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { EndedRun } from '../jobs/queue.js'
import { createHash } from 'node:crypto'
import { ImageRestoreFailureCode, RESTORE_MARK_PROPERTY, RestoreMark, zvolDatasetFromPath } from '@anas/shared'
import { DEFAULT_MAX_PINNED, DEFAULT_MAX_RETAINED } from '../jobs/queue.js'
import { ZFS } from './iscsi-mutate.js'

/** The article `describeRestoreMark` leads with. */
const LEADING_A_RE = /^a /

/** zfs's stderr for a named dataset that is not there. */
const ZFS_ABSENT_RE = /dataset does not exist/

/** What one read of an object's mark found — tri-state plus "this kind carries none". */
export type RestoreMarkRead
  = | { state: 'present', mark: RestoreMarkType | null, raw: string, dataset: string }
    | { state: 'absent', dataset: string }
    | { state: 'unknown', reason: string, dataset: string }
    | { state: 'unsupported' }

/** The backing an image restore writes, as far as the mark is concerned. */
export interface MarkableBacking {
  /** `/dev/zvol/<pool>/<vol>` or an image file path. */
  path: string
}

/**
 * The volume a mark lives on, or null for a backing that carries none (a
 * file). THE one derivation (review2 (9)): the writer (both restore paths) and
 * every reader (health, status, Enable, ACL, add-LUN, Repair) name the volume
 * from the backing PATH through this, so a mark is always written where it is
 * read — a caller's own idea of "the dataset" never enters.
 */
export function markDataset(path: string): string | null {
  return zvolDatasetFromPath(path)
}

/** The property value, bounded by the schema. */
export function encodeRestoreMark(mark: RestoreMarkType): string {
  return JSON.stringify(RestoreMark.parse(mark))
}

/** A value read back: the mark, or null when it does not parse (still a mark). */
export function decodeRestoreMark(raw: string): RestoreMarkType | null {
  try {
    const r = RestoreMark.safeParse(JSON.parse(raw))
    return r.success ? r.data : null
  }
  catch {
    return null
  }
}

/** `zfs get -Hp -o value,source anas:restore -- <volume>`. */
export function restoreMarkGetArgs(dataset: string): string[] {
  return ['get', '-Hp', '-o', 'value,source', RESTORE_MARK_PROPERTY, '--', dataset]
}

/**
 * `zfs get -Hp -o name,value,source anas:restore -- <ds>...` — the marks of
 * several volumes in ONE command (cr3.lunrestore, review2 (7)).
 */
export function restoreMarksGetArgs(datasets: string[]): string[] {
  return ['get', '-Hp', '-o', 'name,value,source', RESTORE_MARK_PROPERTY, '--', ...datasets]
}

/** One `value<TAB>source` pair, as a read. Only a value set ON the volume counts. */
function readOfRow(dataset: string, value: string, source: string): RestoreMarkRead {
  if (source !== 'local' && source !== 'received')
    return { state: 'absent', dataset }
  return { state: 'present', dataset, raw: value, mark: decodeRestoreMark(value) }
}

/** The lines a `zfs get -H` printed, without the final newline. */
function outputLines(stdout: string): string[] {
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  return body.length === 0 ? [] : body.split('\n')
}

/** One volume's read, from its own `zfs get` (the single form, and the batch's fallback). */
async function readOne(executor: CommandExecutor, dataset: string): Promise<RestoreMarkRead> {
  let r
  try {
    r = await executor.exec(ZFS, restoreMarkGetArgs(dataset))
  }
  catch (err) {
    return { state: 'unknown', dataset, reason: err instanceof Error ? err.message : String(err) }
  }
  if (r.exitCode !== 0) {
    const line = r.stderr.trim().split('\n')[0] ?? ''
    if (ZFS_ABSENT_RE.test(line))
      return { state: 'absent', dataset }
    return { state: 'unknown', dataset, reason: line || `zfs get exited with code ${r.exitCode}` }
  }
  const lines = outputLines(r.stdout)
  if (lines.length === 0)
    return { state: 'unknown', dataset, reason: 'zfs get printed nothing' }
  // review2 (7): a value with a newline in it spans lines — never parsed as
  // whatever its first line looks like.
  if (lines.length > 1)
    return { state: 'unknown', dataset, reason: 'zfs get printed a value that spans lines' }
  const row = lines[0]
  const tab = row.lastIndexOf('\t')
  if (tab < 0)
    return { state: 'unknown', dataset, reason: `zfs get printed '${row}'` }
  return readOfRow(dataset, row.slice(0, tab), row.slice(tab + 1).trim())
}

/**
 * Read the mark on a backing. Only a value set ON the volume counts (`local`,
 * or `received` from a `zfs send -p` that ANAS itself never runs): a value
 * inherited from an ancestor was not set on this object. A volume that does
 * not exist carries nothing (`absent`); any other failed read is `unknown`,
 * never "absent".
 */
export async function readRestoreMark(executor: CommandExecutor, backing: MarkableBacking): Promise<RestoreMarkRead> {
  const dataset = markDataset(backing.path)
  if (dataset === null)
    return { state: 'unsupported' }
  return readOne(executor, dataset)
}

/**
 * The marks of many backings, keyed by backing path (cr3.lunrestore, review2
 * (7)): every volume in ONE `zfs get` — the health read, the status read and
 * the Enable door used to run one per LUN. An image file reads `unsupported`
 * with no command; a single volume uses the single form.
 *
 * Fail-closed per row: a dataset whose row is missing, repeated, or whose
 * value runs on past a newline reads `unknown`, never "absent", and a row it
 * cannot place makes every dataset it might belong to unknown.
 *
 * ASSUMPTION (no capture exists): given an operand that does not exist, `zfs
 * get` prints the rows of the others, names the missing one on stderr, and
 * exits non-zero. So ANY non-zero exit falls back to one read per volume,
 * where a missing volume reads `absent` and the others stand on their own —
 * one missing dataset never turns the others unknown. The node command that
 * settles it: `zfs create -V 1M <pool>/mk1 && zfs get -Hp -o name,value,source
 * anas:restore -- <pool>/mk1 <pool>/no-such; echo "exit=$?"`.
 */
export async function readRestoreMarksBatch(executor: CommandExecutor, paths: string[]): Promise<Map<string, RestoreMarkRead>> {
  const out = new Map<string, RestoreMarkRead>()
  const byDataset = new Map<string, string[]>()
  for (const path of new Set(paths)) {
    const dataset = markDataset(path)
    if (dataset === null) {
      out.set(path, { state: 'unsupported' })
      continue
    }
    byDataset.set(dataset, [...(byDataset.get(dataset) ?? []), path])
  }
  const datasets = [...byDataset.keys()]
  const reads = new Map<string, RestoreMarkRead>()
  if (datasets.length === 1) {
    reads.set(datasets[0], await readOne(executor, datasets[0]))
  }
  else if (datasets.length > 1) {
    let r
    try {
      r = await executor.exec(ZFS, restoreMarksGetArgs(datasets))
    }
    catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      for (const d of datasets)
        reads.set(d, { state: 'unknown', dataset: d, reason })
    }
    if (r && r.exitCode !== 0) {
      for (const [d, read] of await Promise.all(datasets.map(async d => [d, await readOne(executor, d)] as const)))
        reads.set(d, read)
    }
    else if (r) {
      const wanted = new Set(datasets)
      const rows = new Map<string, { value: string, source: string }>()
      const bad = new Map<string, string>()
      let current: string | null = null
      let stray = false
      for (const line of outputLines(r.stdout)) {
        const tab = line.indexOf('\t')
        const name = tab >= 0 ? line.slice(0, tab) : null
        if (name !== null && wanted.has(name)) {
          current = name
          if (rows.has(name) || bad.has(name)) {
            rows.delete(name)
            bad.set(name, 'zfs get printed its row twice')
            continue
          }
          const rest = line.slice(tab + 1)
          const tab2 = rest.lastIndexOf('\t')
          if (tab2 < 0)
            bad.set(name, `zfs get printed '${line}'`)
          else
            rows.set(name, { value: rest.slice(0, tab2), source: rest.slice(tab2 + 1).trim() })
          continue
        }
        // Not a fresh row of a volume asked about: the previous row's value
        // ran on past a newline — or, before any row, output nobody can place.
        if (current === null) {
          stray = true
        }
        else {
          rows.delete(current)
          bad.set(current, 'zfs get printed a value that spans lines')
        }
      }
      for (const d of datasets) {
        const row = rows.get(d)
        if (stray)
          reads.set(d, { state: 'unknown', dataset: d, reason: 'zfs get printed a line that names no volume asked about' })
        else if (bad.has(d))
          reads.set(d, { state: 'unknown', dataset: d, reason: bad.get(d)! })
        else if (!row)
          reads.set(d, { state: 'unknown', dataset: d, reason: 'zfs get printed no row for it' })
        else
          reads.set(d, readOfRow(d, row.value, row.source))
      }
    }
  }
  for (const [d, ps] of byDataset) {
    for (const p of ps)
      out.set(p, reads.get(d)!)
  }
  return out
}

/** Set (or replace) the mark. Throws a sentence when zfs refuses. */
export async function setRestoreMark(executor: CommandExecutor, dataset: string, mark: RestoreMarkType): Promise<void> {
  const r = await executor.exec(ZFS, ['set', `${RESTORE_MARK_PROPERTY}=${encodeRestoreMark(mark)}`, '--', dataset])
  if (r.exitCode !== 0)
    throw new Error(`could not set the restore mark ${RESTORE_MARK_PROPERTY} on ${dataset}: ${r.stderr.trim() || `zfs set exited with code ${r.exitCode}`}`)
}

/**
 * Put back a value read off the volume EXACTLY as it was (cr3.lunrestore,
 * review2 A): the mark an earlier restore left, after a run that wrote nothing.
 * The raw value is written as read — never re-encoded, so a mark that did not
 * parse comes back as the same unparsed mark. Throws a sentence when zfs refuses.
 */
export async function putBackRestoreMark(executor: CommandExecutor, dataset: string, raw: string): Promise<void> {
  const r = await executor.exec(ZFS, ['set', `${RESTORE_MARK_PROPERTY}=${raw}`, '--', dataset])
  if (r.exitCode !== 0)
    throw new Error(`could not put back the restore mark ${RESTORE_MARK_PROPERTY} on ${dataset}: ${r.stderr.trim() || `zfs set exited with code ${r.exitCode}`}`)
}

/** The one command that clears a mark by hand. */
export function clearMarkCommand(dataset: string): string {
  return `zfs inherit ${RESTORE_MARK_PROPERTY} ${dataset}`
}

/** Clear the mark (`zfs inherit`, capture F). Throws a sentence when zfs refuses. */
export async function clearRestoreMark(executor: CommandExecutor, dataset: string): Promise<void> {
  const r = await executor.exec(ZFS, ['inherit', RESTORE_MARK_PROPERTY, '--', dataset])
  if (r.exitCode !== 0)
    throw new Error(`could not remove the restore mark ${RESTORE_MARK_PROPERTY} from ${dataset}: ${r.stderr.trim() || `zfs inherit exited with code ${r.exitCode}`}`)
}

/** "vol.img from host/x/2026-01-01T00:00:00Z (repository pbs-main), started 2026-11-14T10:00:00Z" — or the unreadable form. */
export function describeRestoreMark(read: { mark: RestoreMarkType | null }): string {
  const m = read.mark
  if (!m)
    return 'a whole-image restore (its details could not be read)'
  return `a whole-image restore of ${m.archive} from ${m.snapshot} (repository ${m.repo}${m.ns ? `, namespace ${m.ns}` : ''}) started ${m.started}`
}

/** A fresh `writing` mark for a restore that starts now. */
export function writingMark(r: { repo: string, namespace?: string, snapshot: string, archive: string }, now = new Date()): RestoreMarkType {
  return {
    v: 1,
    repo: r.repo,
    ...(r.namespace ? { ns: r.namespace } : {}),
    snapshot: r.snapshot,
    archive: r.archive,
    started: now.toISOString(),
    state: 'writing',
  }
}

/** The mark of an image the client reported complete whose size could not be confirmed. */
export function unverifiedMark(writing: RestoreMarkType, reason: string): RestoreMarkType {
  return { ...writing, state: 'unverified', reason: reason.slice(0, 512) }
}

// ---------------------------------------------------------------------------
// What this daemon's job records know (cr3.lunrestore, review2 D)
// ---------------------------------------------------------------------------

/** The operation both whole-image restore doors run as; its params name the `backing`. */
export const IMAGE_RESTORE_OPERATION = 'backup.restore.image'

/**
 * A retained restore job that failed in a way that may have left the backing
 * holding an image that is not proven whole (its `ImageRestoreFailureCode`).
 */
export interface RestoreJobRecord {
  job: string
  outcome: 'partial' | 'unverified'
  /** The image's size in bytes, as the job was submitted with it (`imageBytes`). */
  imageBytes?: number
}

/** The slice of the job queue the restore facts read (the `JobQueue` satisfies it). */
export interface ImageRestoreJobView {
  findRunning: (operation: string, target: string, paramKey?: string) => Job | undefined
  findEndedRuns: (operation: string, target: string, paramKey?: string) => EndedRun[]
  findLastCompleted: (operation: string, target: string, paramKey?: string) => Job | undefined
}

/** What the job records say about a backing — the two questions every door asks. */
export interface RestoreJobFacts {
  /** The id of a whole-image restore RUNNING onto this backing now (a queued one has written nothing). */
  restoreRunning: (backingPath: string) => string | undefined
  /**
   * The restore onto this backing that STANDS (review3 1): the most recent one
   * that failed with an `ImageRestoreFailureCode` (an image not proven whole),
   * unless a LATER restore onto the backing completed (a complete, verified
   * image) or an Enable of `targetIqn` completed after it (the operator's
   * confirm accepted that image). A failure without a code — a refusal, a
   * run that wrote nothing — never supersedes it. Consulted only for a
   * backing that carries no mark (an image file).
   */
  restoreFailed: (backingPath: string, targetIqn?: string) => RestoreJobRecord | undefined
}

/**
 * The job-record answers for one daemon (one queue). THE GAP, stated where
 * the knowledge lives: for an image FILE this is the ONLY record that a
 * restore left a partial or unverified image, and it is in memory — a restart
 * of the ANAS daemon (or the job's eviction from the queue) forgets it, and the
 * LUN then reads as any other. That stays until a file can carry a mark of its
 * own (an extended attribute, held for the operator's word). A zvol's mark is
 * on the object and does not depend on this.
 */
export function restoreJobsOf(jobs: ImageRestoreJobView): RestoreJobFacts {
  return {
    restoreRunning: p => jobs.findRunning(IMAGE_RESTORE_OPERATION, p, 'backing')?.id,
    restoreFailed: (p, targetIqn) => {
      // Submission order: a later completed restore clears what stands; a
      // later coded failure replaces it; an uncoded failure (it wrote nothing,
      // or was refused before it wrote) or a cancel changes nothing.
      let standing: EndedRun | undefined
      let outcome: RestoreJobRecord['outcome'] = 'partial'
      for (const run of jobs.findEndedRuns(IMAGE_RESTORE_OPERATION, p, 'backing')) {
        if (run.job.status === 'completed') {
          standing = undefined
          continue
        }
        if (run.job.status !== 'failed')
          continue
        const code = ImageRestoreFailureCode.safeParse(run.job.error?.code)
        if (!code.success)
          continue
        standing = run
        outcome = code.data === 'IMAGE_UNVERIFIED' ? 'unverified' : 'partial'
      }
      if (!standing)
        return undefined
      if (targetIqn !== undefined) {
        // An Enable of the target that completed AFTER the failure went
        // through the confirm that accepted this image.
        const enabled = jobs.findLastCompleted('iscsi.target.enable', targetIqn, 'target')
        if (enabled?.completedAt && standing.job.completedAt && enabled.completedAt > standing.job.completedAt)
          return undefined
      }
      const bytes = standing.params.imageBytes
      return { job: standing.job.id, outcome, ...(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? { imageBytes: bytes } : {}) }
    },
  }
}

/**
 * The queue's pin for an image FILE's standing restore failure (review3 1):
 * the record a gate depends on (`restoreFailed`) is kept past the queue's
 * `maxRetained`, up to its `maxPinned` (the bound: past it the oldest pinned
 * job is evicted, and its file LUN then reads as any other). A zvol's failure
 * is not pinned: its mark is on the object.
 */
export function imageRestorePin(jobs: ImageRestoreJobView): (job: Job, params: Readonly<Record<string, unknown>>) => boolean {
  const facts = restoreJobsOf(jobs)
  return (job, params) => {
    if (job.operation !== IMAGE_RESTORE_OPERATION || job.status !== 'failed' || !ImageRestoreFailureCode.safeParse(job.error?.code).success)
      return false
    const backing = params.backing
    if (typeof backing !== 'string' || markDataset(backing) !== null)
      return false
    const target = typeof params.target === 'string' ? params.target : undefined
    return facts.restoreFailed(backing, target)?.job === job.id
  }
}

/**
 * When the job record of a failed restore onto an image file is lost — said
 * wherever such a record is relied on (review3 1).
 */
export const JOB_RECORD_LIFETIME = 'an image file carries no restore mark, so the record is lost when the ANAS daemon restarts, '
  + `or when the daemon holds more than ${DEFAULT_MAX_PINNED} such records and more than ${DEFAULT_MAX_RETAINED} jobs (the oldest record goes first)`

/**
 * How to restore an image FILE again in place (review3 2), lower-case, no
 * final stop: the in-place door refuses a target whose size is not the
 * image's, and the stream's open truncates the file, so after a failure the
 * file can be shorter and "restore again" alone would be refused. True in every
 * state the file can be in: setting a file of the right length to that length
 * changes nothing.
 */
export function fileRestoreAgain(path: string, imageBytes: number | undefined): string {
  const size = imageBytes === undefined ? 'the image\'s exact size' : `the image's ${imageBytes} bytes`
  return `to restore the image again in place, first set ${path} to ${size} with 'truncate -s ${imageBytes ?? '<bytes>'} ${path}' `
    + `(the in-place restore refuses a file of any other size, and a failed restore can leave the file shorter); `
    + `deleting this LUN and restoring the image as a new LUN is the other way out`
}

/**
 * What an in-place restore does with a target it disabled when it ends (review3
 * 4): the three outcomes, true per backing kind. Complete and verified: enabled
 * again. Failed before anything was written: as it was — except a volume left
 * with a restore mark (an earlier restore's, put back, or this run's that
 * could not be removed), and an image file the restore opened (the open
 * empties it). Anything else: disabled, and the job says why.
 */
export function restoreEndSentence(kind: 'zvol' | 'file', subject: string): string {
  const asItWas = kind === 'zvol'
    ? 'put back as it was if the restore fails before writing anything and leaves the volume with no restore mark (an earlier restore\'s mark, put back, keeps it disabled)'
    : 'put back as it was if the restore fails before it opens the image file and the file is still the image\'s size (opening it for the restore empties it)'
  return `When the restore ends, ${subject} is enabled again only if the image is complete and its size verified, and ${asItWas}; `
    + `in every other case it stays disabled and the restore job says why.`
}

/** The sentence every verdict drawn from a job record carries (never from a mark). */
export const JOB_RECORD_ONLY = `ANAS knows this only from that job's record in this run of the ANAS daemon: ${JOB_RECORD_LIFETIME}`

/**
 * The state a backing's restore facts mean now. `null` = nothing to say.
 * Precedence: a mark that could not be read; a restore running; the mark on
 * the volume; for a backing that carries no mark, the job record.
 */
export function restoreMarkState(read: RestoreMarkRead | undefined, running: string | undefined, record?: RestoreJobRecord): IscsiRestoreMarkState | null {
  if (!read)
    return null
  if (read.state === 'unknown')
    return 'unreadable'
  if (running)
    return 'in-progress'
  if (read.state === 'present')
    return read.mark?.state === 'unverified' ? 'unverified' : 'interrupted'
  if (read.state === 'unsupported' && record)
    return record.outcome === 'unverified' ? 'unverified' : 'interrupted'
  return null
}

/**
 * The one sentence a health row carries, true for where it comes from. `again`
 * (review3 2): for a job record of a failed restore onto a LUN's image file,
 * how restoring it again in place is possible ({@link fileRestoreAgain}).
 */
export function restoreMarkDetail(row: { state: IscsiRestoreMarkState, source: 'mark' | 'job', mark: RestoreMarkType | null, job?: string, what: string, dataset: string | null, again?: string }): string {
  const what = capitalize(describeRestoreMark({ mark: row.mark }))
  if (row.source === 'job') {
    const again = row.again ? ` ${capitalize(row.again)}.` : ''
    switch (row.state) {
      case 'in-progress':
        return `A whole-image restore (job ${row.job}) is writing ${row.what} right now.`
      case 'unverified':
        return `The whole-image restore job ${row.job} wrote ${row.what}, and the client reported the image complete, but ANAS could not `
          + `verify it: treat its content as unproven. ${JOB_RECORD_ONLY}.${again}`
      default:
        return `The whole-image restore job ${row.job} onto ${row.what} did not finish, so it may hold a partial image. ${JOB_RECORD_ONLY}.${again}`
    }
  }
  switch (row.state) {
    case 'unreadable':
      return `ANAS could not read the restore mark on ${row.dataset}, so it cannot tell whether ${row.what} holds a partially restored image.`
    case 'in-progress':
      return `${what} is writing ${row.what} right now (job ${row.job}).`
    case 'unverified':
      return `${what} wrote ${row.what}, and the client reported the image complete, but its size was not verified${row.mark?.reason ? ` (${row.mark.reason})` : ''}: treat its content as unproven.`
    default:
      return `${what} onto ${row.what} did not finish: it holds a partial image.`
  }
}

/** The ways out a refusal names, per where its verdict comes from. */
export interface RefusalWays {
  /** After a mark's sentence (the mark can be cleared, or the image restored again). */
  mark: string
  /** After a job record's sentence (an image file: no mark to clear). */
  job: string
}

/**
 * The refusal a door that would SERVE a backing answers with (cr3.lunrestore):
 * a mark that could not be read refuses ("could not check" — never served on
 * unknown); a restore running onto it refuses until it ends; a mark that is
 * there, or (for an image file) a retained failed restore, refuses with what
 * it says and the ways out. `null` = nothing to refuse. The Enable door has its
 * own confirm path; every other door that would expose the LUN (add-LUN on the
 * volume, an ACL added to its target) uses this.
 */
export function restoreMarkRefusal(
  read: RestoreMarkRead,
  what: string,
  action: string,
  ways: RefusalWays | string,
  jobs: { running?: string, record?: RestoreJobRecord, backingPath?: string } = {},
): { reason: string, message: string } | null {
  const way = typeof ways === 'string' ? { mark: ways, job: ways } : ways
  if (read.state === 'unknown') {
    return {
      reason: 'restore-mark-unreadable',
      message: `ANAS could not read the restore mark on ${read.dataset} (${read.reason}), so it cannot tell whether ${what} holds a `
        + `partially restored image. ${action} is refused until the mark can be read.`,
    }
  }
  if (jobs.running) {
    return {
      reason: 'restore-in-progress',
      message: `A whole-image restore is writing ${what} right now (job ${jobs.running}). ${action} is refused until the restore ends.`,
    }
  }
  if (read.state === 'unsupported' && jobs.record) {
    const how = jobs.record.outcome === 'unverified'
      ? `wrote ${what}, and the client reported the image complete, but ANAS could not verify it`
      : `onto ${what} did not finish, so it may hold a partial image`
    return {
      reason: 'restore-mark',
      message: `The whole-image restore job ${jobs.record.job} ${how}. ${JOB_RECORD_ONLY}. `
        + `${action} would serve that image to initiators and is refused. ${way.job}`
        + `${jobs.backingPath ? ` ${capitalize(fileRestoreAgain(jobs.backingPath, jobs.record.imageBytes))}.` : ''}`,
    }
  }
  if (read.state !== 'present')
    return null
  const how = read.mark?.state === 'unverified'
    ? `wrote ${what}, and the client reported the image complete, but its size was not verified${read.mark.reason ? ` (${read.mark.reason})` : ''}`
    : `onto ${what} did not finish: it holds a partial image`
  return {
    reason: 'restore-mark',
    message: `${capitalize(describeRestoreMark(read))} ${how} (the restore mark ${RESTORE_MARK_PROPERTY} on ${read.dataset}). `
      + `${action} would serve that image to initiators and is refused. ${way.mark}`,
  }
}

/** The text with its first letter upper-case (a clause that starts a sentence). */
export function capitalize(s: string): string {
  return s.length ? `${s[0].toUpperCase()}${s.slice(1)}` : s
}

/** One LUN of a target, the mark on its backing, and what the job records say. */
export interface LunMarkFact {
  index: number
  name: string
  backingPath: string
  read: RestoreMarkRead
  /** A restore running onto the backing now. */
  running?: string
  /** For a backing that carries no mark: the retained failed restore onto it. */
  record?: RestoreJobRecord
}

/**
 * Read the restore facts of every present LUN of a target: the mark on each
 * backing, and — given the job records — a restore running onto it and, for an
 * image file, the retained failed restore.
 */
export async function readLunMarks(
  executor: CommandExecutor,
  luns: { index: number, name: string, backingPath: string, present?: boolean }[],
  jobs?: RestoreJobFacts & { targetIqn: string },
): Promise<LunMarkFact[]> {
  const present = luns.filter(l => l.present !== false && l.backingPath)
  // review2 (7): every LUN's mark in one command.
  const reads = await readRestoreMarksBatch(executor, present.map(l => l.backingPath))
  return present
    .map((l) => {
      const read = reads.get(l.backingPath)!
      const running = jobs?.restoreRunning(l.backingPath)
      const record = read.state === 'unsupported' ? jobs?.restoreFailed(l.backingPath, jobs.targetIqn) : undefined
      return { index: l.index, name: l.name, backingPath: l.backingPath, read, ...(running ? { running } : {}), ...(record ? { record } : {}) }
    })
}

/** The state of one LUN's facts (`restoreMarkState`). */
export function lunMarkState(f: LunMarkFact): IscsiRestoreMarkState | null {
  return restoreMarkState(f.read, f.running, f.record)
}

/**
 * What an Enable confirm binds (stable order): `<dataset>=<value>` for each
 * mark, `<backing>=job:<id>:<outcome>` for each job record.
 */
export function markSignature(facts: LunMarkFact[]): string[] {
  return facts
    .flatMap(f => (f.read.state === 'present'
      ? [`${f.read.dataset}=${f.read.raw}`]
      : f.record ? [`${f.backingPath}=job:${f.record.job}:${f.record.outcome}`] : []))
    .sort()
}

/**
 * The same facts in words, for the CONFIRM_SCOPE_CHANGED sentence (review2
 * F): never the raw JSON. Injective on what the signature binds — a mark that
 * does not parse is named by a fingerprint of its value.
 */
export function describeMarkSet(facts: LunMarkFact[]): string {
  const parts = facts.flatMap((f) => {
    if (f.read.state === 'present') {
      const m = f.read.mark
      if (!m)
        return [`${f.read.dataset}: a restore mark whose details could not be read (value fingerprint ${createHash('sha256').update(f.read.raw).digest('hex').slice(0, 12)})`]
      return [`${f.read.dataset}: ${m.state === 'unverified' ? 'an unverified' : 'an unfinished'} ${describeRestoreMark({ mark: m }).replace(LEADING_A_RE, '')}`
        + `${m.state === 'unverified' && m.reason ? ` (not verified: ${m.reason})` : ''}`]
    }
    if (f.record)
      return [`${f.backingPath}: restore job ${f.record.job} ${f.record.outcome === 'unverified' ? 'ended unverified' : 'did not finish'}`]
    return []
  })
  return parts.sort().join('; ')
}

/** The Enable door's verdict on a target's restore facts (cr3.lunrestore, D5 b). */
export type EnableMarkVerdict
  = | { kind: 'clear' }
    | { kind: 'refuse', reason: string, message: string }
    | { kind: 'confirm', message: string, warnings: string[], marks: LunMarkFact[] }

/**
 * What Enable may do with these facts:
 *  - a mark that could not be READ: refused — never enable on unknown;
 *  - a restore RUNNING onto any LUN's backing (an image file too): refused,
 *    naming the job;
 *  - a mark with no running restore (interrupted, or unverified), or — for an
 *    image file — a retained failed restore: a confirm. The operator accepts
 *    serving that image; the confirm removes the marks (a job record needs no
 *    removing: the completed Enable is what accepts it).
 */
export function enableMarkVerdict(iqn: string, facts: LunMarkFact[]): EnableMarkVerdict {
  const unreadable = facts.filter(f => f.read.state === 'unknown')
  if (unreadable.length > 0) {
    return {
      kind: 'refuse',
      reason: 'restore-mark-unreadable',
      message: `ANAS could not check whether ${unreadable.map(f => `LUN ${f.index} ('${f.name}')`).join(', ')} of ${iqn} `
        + `holds a partially restored image: the restore mark could not be read (${unreadable.map(f => (f.read.state === 'unknown' ? `${f.read.dataset}: ${f.read.reason}` : '')).join('; ')}). `
        + `Enabling is refused until it can be read.`,
    }
  }
  // review2 D/F1: a running restore onto ANY backing of the target — including
  // an image file, whose mark read is `unsupported` — refuses; and the
  // sentence promises nothing about what the restore does after.
  const running = facts.find(f => f.running !== undefined)
  if (running) {
    return {
      kind: 'refuse',
      reason: 'restore-in-progress',
      message: `A whole-image restore is writing LUN ${running.index} ('${running.name}') of ${iqn} right now (job ${running.running}). `
        + `Enabling the target is refused until the restore ends: it would serve a partly written disk.`,
    }
  }
  const unproven = facts.filter(f => lunMarkState(f) === 'interrupted' || lunMarkState(f) === 'unverified')
  if (unproven.length === 0)
    return { kind: 'clear' }
  const warnings = unproven.map((f) => {
    const head = `LUN ${f.index} ('${f.name}'): `
    if (f.read.state === 'present') {
      const read = f.read
      const how = read.mark?.state === 'unverified'
        ? `ended with the client reporting the image complete, but its size was not verified${read.mark.reason ? ` (${read.mark.reason})` : ''}. `
        + `An initiator will be served an image ANAS could not verify.`
        : `did not finish, so the LUN holds a partial image. An initiator will be served that partial image.`
      return `${head}${describeRestoreMark(read)} onto ${read.dataset} ${how} Confirming removes the restore mark; restoring the image again is the other way out.`
    }
    const rec = f.record!
    const how = rec.outcome === 'unverified'
      ? `ended with the client reporting the image complete, but ANAS could not verify it. An initiator will be served an image ANAS could not verify.`
      : `did not finish, so the LUN may hold a partial image. An initiator will be served that image.`
    return `${head}the whole-image restore job ${rec.job} onto ${f.backingPath} ${how} ${JOB_RECORD_ONLY}. ${capitalize(fileRestoreAgain(f.backingPath, rec.imageBytes))}.`
  })
  const partial = unproven.filter(f => lunMarkState(f) === 'interrupted').length
  const lead = `Enabling ${iqn} serves ${unproven.length === 1 ? 'a LUN' : `${unproven.length} LUNs`}`
  const message = partial === unproven.length
    ? `${lead} whose whole-image restore did not finish`
    : partial === 0
      ? `${lead} whose restored image is not verified`
      : `${lead} whose whole-image restore did not finish or whose restored image is not verified`
  return { kind: 'confirm', message, warnings, marks: unproven }
}
