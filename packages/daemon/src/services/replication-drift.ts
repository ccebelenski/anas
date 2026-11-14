import type { ReplicationTargetDrift } from '@anas/shared'
import type { ExecResult } from '../executor/types.js'
import { SnapshotName } from '@anas/shared'
import { isTransientRunSnapshot } from './snapshot-naming.js'

/**
 * repl.drift: would the replica still accept the next incremental? ONE
 * detection, asked by every run (single and recursive, timer-fired and
 * manual), by the task status read and by the dashboard collector.
 *
 * Ground truth (`fixtures/zfs/zfs-written-replica.zfs2.4.2.txt`, ZFS 2.4.2):
 * `written@<snap>` on the dataset is the bytes written since `<snap>`: 0 on an
 * unmodified replica, still 0 when only EMPTY target-only snapshots were added
 * after it, non-zero after a write, and non-zero after a mere file READ when
 * `readonly=off` with access-time updates on. ZFS refuses an incremental from
 * `@<snap>` ("destination has been modified since most recent snapshot")
 * exactly then. A `readonly=on` replica is not changed by reading, listing,
 * checksumming, browsing `.zfs`, a snapshot, a refused write or a remount;
 * setting `readonly` back to on does not undo a change already made.
 *
 * Four states, read fresh every time (no state is kept between reads):
 * `clean` (0, read-only), `exposed` (0, not read-only: nothing has diverged
 * yet), `modified` (> 0) and `unknown` (the read failed, timed out or did not
 * parse: never read as clean).
 */

export type ZfsRunner = (args: string[]) => Promise<ExecResult>

/** Every C0 control character and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F]/g
const DIGITS_RE = /^\d+$/
/** The longest failure line a sentence carries. */
const LINE_MAX = 300
/** Newer snapshots named in a sentence; the rest are "...". */
const NAMED_MAX = 5
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']

/**
 * The ONE read: `zfs get -Hp -o property,value,source written@<base>,readonly
 * -- <dataset>`. The property list comes before `--` (the idiom of every
 * `zfs get` here, `zfsTreeGetArgs`); the dataset after it. The caller has
 * already validated `<base>` with the shared `SnapshotName`.
 */
export function targetStateArgs(dataset: string, base: string): string[] {
  return ['get', '-Hp', '-o', 'property,value,source', `written@${base},readonly`, '--', dataset]
}

/**
 * `zfs get -Hp -o property,value,source` rows of ONE dataset → property →
 * {value, source}, or null for an answer that is not that listing (a line
 * without three fields, a repeated property, a carriage return).
 */
export function parsePropertyRows(stdout: string): Map<string, { value: string, source: string }> | null {
  const out = new Map<string, { value: string, source: string }>()
  for (const line of stdout.split('\n')) {
    if (line.length === 0)
      continue
    if (line.includes('\r'))
      return null
    const fields = line.split('\t')
    if (fields.length !== 3 || fields[0].length === 0 || out.has(fields[0]))
      return null
    out.set(fields[0], { value: fields[1], source: fields[2] })
  }
  return out
}

/**
 * A `written` value as `zfs get -Hp` prints it (an exact integer), or null
 * for anything else (`-`, empty, junk, a value past 2^53).
 */
export function parseWrittenValue(value: string): number | null {
  const v = value.trim()
  if (!DIGITS_RE.test(v))
    return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}

/** What one read of a target said, before any sentence is made of it. */
export type TargetStateRead
  = | { ok: true, written: number, readonly: string, readonlySource?: string }
    | { ok: false, reason: string }

/** The four-state verdict of a read (pure). */
export function classifyTargetState(written: number, readonly: string): 'clean' | 'exposed' | 'modified' {
  if (written > 0)
    return 'modified'
  return readonly === 'on' ? 'clean' : 'exposed'
}

/** One line of a failed command's stderr for a sentence. */
function failureLine(r: ExecResult): string {
  const lines = r.stderr.split('\n').map(l => l.replace(CONTROL_RE, ' ').trim()).filter(Boolean)
  const line = lines.at(-1)
  if (line === undefined)
    return `exit ${r.exitCode}`
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}...` : line
}

/** Run the one read and parse it; every failure is a reason, never a value. */
export async function readTargetState(run: ZfsRunner, dataset: string, base: string): Promise<TargetStateRead> {
  if (!SnapshotName.safeParse(base).success)
    return { ok: false, reason: `the snapshot name '@${base}' has characters ANAS does not pass to a command` }
  let r: ExecResult
  try {
    r = await run(targetStateArgs(dataset, base))
  }
  catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  if (r.exitCode !== 0)
    return { ok: false, reason: failureLine(r) }
  const rows = parsePropertyRows(r.stdout)
  const writtenRow = rows?.get(`written@${base}`)
  const readonlyRow = rows?.get('readonly')
  const written = writtenRow === undefined ? null : parseWrittenValue(writtenRow.value)
  if (rows === null || written === null || readonlyRow === undefined || readonlyRow.value.length === 0 || rows.size !== 2)
    return { ok: false, reason: 'the answer could not be read' }
  return { ok: true, written, readonly: readonlyRow.value, ...(readonlyRow.source && readonlyRow.source !== '-' ? { readonlySource: readonlyRow.source } : {}) }
}

/**
 * The snapshot the NEXT incremental into a target starts from, both lists
 * newest first in ZFS's own order: the target's newest snapshot when it is a
 * backup or cloud run's transient the source still has (decideBase rule 2:
 * that send is accepted whatever an older base says), otherwise the newest
 * non-transient snapshot both sides have. Undefined when they share none (no
 * base: a diverged target, not this condition).
 */
export function nextIncrementalBase(sourceNames: string[], targetNames: string[]): string | undefined {
  const newest = targetNames[0]
  if (newest !== undefined && isTransientRunSnapshot(newest) && sourceNames.includes(newest))
    return newest
  const onTarget = new Set(targetNames)
  return sourceNames.find(n => !isTransientRunSnapshot(n) && onTarget.has(n))
}

/** The target's snapshots taken after `base`, newest first (a rollback to `base` destroys them). */
export function snapshotsNewerThan(targetNames: string[], base: string): string[] {
  const i = targetNames.indexOf(base)
  return i <= 0 ? [] : targetNames.slice(0, i)
}

/**
 * A size as the panels show one (`ANAS.formatBytes`'s IEC form: two decimals
 * from KiB up), so the sentence and the grid agree.
 */
export function formatSize(bytes: number): string {
  let size = bytes
  let order = 0
  while (size >= 1024 && order < SIZE_UNITS.length - 1) {
    size /= 1024
    order++
  }
  return `${size.toFixed(order === 0 ? 0 : 2)} ${SIZE_UNITS[order]}`
}

/** `'@a', '@b', ...` — at most five names. */
export function namedSnapshots(names: string[]): string {
  return names.slice(0, NAMED_MAX).map(n => `'@${n}'`).join(', ') + (names.length > NAMED_MAX ? ', ...' : '')
}

/**
 * The way back for a target changed after `@base` — the ONE wording, used by
 * the drift sentence below and by `modifiedTargetHint` (when ZFS itself
 * refuses the receive): release any hold on the newer snapshots, then roll
 * back to the base (ground truth 2026-11-14: destroying the newer snapshot
 * does not make the receive succeed, the rollback does).
 */
export function chainRemedy(target: string, base: string, newer: string[]): string {
  const holds = newer.length > 0
    ? `release any hold on ${newer.length === 1 ? 'that snapshot' : 'those snapshots'} ('zfs holds ${target}@${newer[0]}' lists them; 'zfs release <tag> <snapshot>' for each), then `
    : ''
  return `to continue the chain, on the target ${holds}roll it back to '@${base}' ('zfs rollback -r ${target}@${base}', which destroys the snapshots newer than it there and anything written since)`
}

/** Whether `@base` carries this chain's hold, per side: true, false, or null (could not be read). */
export interface BaseHeld {
  source: boolean | null
  target: boolean | null
  /**
   * Review N7: a hold under ANOTHER tag is on `@base` on that side. ZFS does
   * not destroy a held snapshot, and ANAS retention skips one, so such a
   * base is not exposed to retention. Absent: none was seen.
   */
  sourceOther?: boolean
  targetOther?: boolean
}

/** What the run did to its holds before the sentence was made (review D2): full snapshot names. */
export interface HoldActs {
  placed: string[]
  released: string[]
}

/** `'a', 'b'` — at most five full names. */
function namedFull(names: string[]): string {
  return names.slice(0, NAMED_MAX).map(n => `'${n}'`).join(', ') + (names.length > NAMED_MAX ? ', ...' : '')
}

/**
 * The sentence's first clause says what the run did (review D2: a run that is
 * up to date settles its holds BEFORE it reads the target, and with the
 * chain's hold still on an older snapshot that settle moves it). No act, or
 * none recorded: the run touched nothing.
 */
function leadClause(acts: HoldActs | undefined): string {
  if (acts === undefined || (acts.placed.length === 0 && acts.released.length === 0))
    return 'Nothing was sent and no hold was moved or released: the source and its snapshots are untouched'
  const placed = acts.placed.length > 0 ? `placed this replication's hold on ${namedFull(acts.placed)}` : ''
  const released = acts.released.length > 0 ? `released a replication hold from ${namedFull(acts.released)}` : ''
  return `Nothing was sent; this run ${placed}${placed && released ? ' and ' : ''}${released}`
}

function heldClause(base: string, held: BaseHeld | undefined, acts?: HoldActs): string {
  const lead = leadClause(acts)
  if (held === undefined || held.source === null || held.target === null)
    return `${lead}; whether '@${base}' is held by this replication could not be read.`
  if (held.source && held.target)
    return `${lead}, and '@${base}' stays held on both sides.`
  const notOurs = [...(held.source ? [] : ['source' as const]), ...(held.target ? [] : ['target' as const])]
  const otherOn = (side: 'source' | 'target'): boolean => (side === 'source' ? held.sourceOther : held.targetOther) === true
  const bare = notOurs.filter(side => !otherOn(side))
  const kept = notOurs.filter(otherOn)
  const sides = (list: ('source' | 'target')[]): string => (list.length === 2 ? 'on either side' : `on the ${list[0]}`)
  // Review N7: retention can remove the base only where NO hold is on it.
  const exposedTo = bare.length === 0
    ? ''
    : `, so retention ${bare.length === notOurs.length ? 'there' : sides(bare)} can remove it`
  const keptBy = kept.length === 0
    ? ''
    : `; another hold keeps it ${kept.length === notOurs.length ? 'there' : sides(kept)} (ZFS does not destroy a held snapshot)`
  return `${lead}; '@${base}' is not held by this replication ${sides(notOurs)}${exposedTo}${keptBy}.`
}

function readonlyShown(readonly: string, source: string | undefined): string {
  return `readonly=${readonly}${source ? `, ${source}` : ''}`
}

export interface DriftSentenceInput {
  target: string
  /** ` on remote 'x'` / ` on peer 'y'`, or '' for this node. */
  where: string
  base: string
}

/**
 * What changes a copy that is not read-only (the ground truth above), said
 * one way wherever a sentence states it as a clause (review 2, note c): any
 * write, and a read only while access-time updates are on.
 */
export function writeOrAtimeRead(effect: string): string {
  return `a write there, or a read with access-time updates on, ${effect}`
}

/** The `modified` sentence. */
export function modifiedSentence(input: DriftSentenceInput & { writtenBytes: number, newer: string[], readonly: string, readonlySource?: string, held?: BaseHeld, holdActs?: HoldActs }): string {
  const { target, where, base, writtenBytes, newer } = input
  const what = newer.length > 0
    ? `${formatSize(writtenBytes)} written and newer snapshot(s) ${namedSnapshots(newer)}`
    : `${formatSize(writtenBytes)} written with no new snapshot (a dataset that is not read-only also changes when a file on it is only read, while access-time updates are on)`
  // Ruling 1: every receive re-asserts read-only, so the next successful one
  // seals it; until then a write, or a read with atime on, changes it again.
  const readonlyLine = input.readonly === 'on'
    ? ''
    : ` It is not read-only (${readonlyShown(input.readonly, input.readonlySource)}): the next successful receive sets it read-only again; until then, after the rollback, ${writeOrAtimeRead('changes it again')} ('zfs set readonly=on ${target}' on the target prevents that).`
  return `Target '${target}'${where} has been changed since '@${base}': ${what}. Replication into it stops until those changes are discarded: ${chainRemedy(target, base, newer)}.${readonlyLine} ${heldClause(base, input.held, input.holdActs)}`
}

/** The operator's way to stop ANAS keeping a copy read-only (ruling 1, 2026-11-15). */
const KEEPS_READ_ONLY = 'A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.'

/**
 * The `exposed` sentence. `sealed`: this run's receive set it read-only
 * again (ruling 1: every receive passes `-o readonly=on`); otherwise nothing
 * was received, and the next run that completes sets it (review 2, P3: its
 * receive when the copy is behind, the run itself when it is up to date).
 */
export function exposedSentence(input: DriftSentenceInput & { readonly: string, readonlySource?: string, sealed?: boolean }): string {
  const { target, where } = input
  const shown = readonlyShown(input.readonly, input.readonlySource)
  if (input.sealed)
    return `Target '${target}'${where} was not read-only (${shown}); this run's receive set it read-only again. ${KEEPS_READ_ONLY}`
  return `Target '${target}'${where} is not read-only (${shown}): ${writeOrAtimeRead('stops the next send')}. The next replication run that completes sets it read-only again: its receive does when the copy is behind, and the run itself when the copy is up to date. 'zfs set readonly=on ${target}' on the target does it now, and neither undoes a change already made. ${KEEPS_READ_ONLY}`
}

/** What setting a target read-only answered (review P3). */
export type SealResult = { ok: true } | { ok: false, reason: string }

/**
 * Review P3: the argv that sets a target read-only — the same property every
 * receive sets with `-o readonly=on` (ruling 1), set by the run itself when
 * it finds the target up to date and not read-only (nothing is received, so
 * no receive would). `--` before the operands, the idiom of every `zfs set`
 * here.
 */
export function sealTargetArgs(dataset: string): string[] {
  return ['set', '--', 'readonly=on', dataset]
}

/** Set the target read-only where it lives; a failure is its reason, never a throw. */
export async function sealTarget(run: ZfsRunner, dataset: string): Promise<SealResult> {
  try {
    const r = await run(sealTargetArgs(dataset))
    return r.exitCode === 0 ? { ok: true } : { ok: false, reason: failureLine(r) }
  }
  catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** `zfs get`'s source column for an inherited value: `inherited from <parent>`. */
const INHERITED_FROM_RE = /^inherited from (\S+)$/

/**
 * The sentence of an up-to-date `exposed` target after the run tried to set it
 * read-only (review P3). Review 2: `zfs set` sets the property ON the dataset,
 * so a value it inherited before (the read's source column) is now its own,
 * and every dataset below it that inherits the property becomes read-only too.
 * A recursive run judges its copies from the tree read, which has no source
 * column: then only the always-true part is said.
 */
export function exposedSetSentence(input: DriftSentenceInput & { readonly: string, readonlySource?: string, seal: SealResult }): string {
  const { target, where } = input
  const shown = readonlyShown(input.readonly, input.readonlySource)
  if (input.seal.ok) {
    const parent = INHERITED_FROM_RE.exec(input.readonlySource ?? '')?.[1]
    const inherited = parent ? `, where the property was inherited from '${parent}' before` : ''
    return `Target '${target}'${where} was not read-only (${shown}); this run set it read-only on '${target}' itself ('zfs set readonly=on ${target}')${inherited}; datasets below it that inherit the property are read-only too. ${KEEPS_READ_ONLY}`
  }
  return `Target '${target}'${where} is not read-only (${shown}), and this run could not set it read-only: ${input.seal.reason}. Until it is read-only, ${writeOrAtimeRead('stops the next send')}; 'zfs set readonly=on ${target}' on the target sets it now, and does not undo a change already made. ${KEEPS_READ_ONLY}`
}

/** The `unknown` sentence. */
export function unknownSentence(input: DriftSentenceInput & { reason: string }): string {
  return `Could not check whether target '${input.target}'${input.where} was changed since '@${input.base}': ${input.reason}`
}

/** A sentence that opens on a capitalised word. */
const CAPITALISED_RE = /^[A-Z][a-z]/

/** A sentence another reader wrote, as the clause after a colon ("Could not" becomes "could not"). */
function asClause(sentence: string): string {
  return CAPITALISED_RE.test(sentence) ? `${sentence[0].toLowerCase()}${sentence.slice(1)}` : sentence
}

/**
 * Why a recursive task's copies could not be checked (review 2, defect 1):
 * the tree read's own sentence, or the refusals a run would give the tree as
 * it stands. A read that could not see never says clean.
 */
export type TreeUnchecked = { read: string } | { refusals: string[] }

function treeUncheckedReason(why: TreeUnchecked): string {
  return 'read' in why
    ? asClause(why.read)
    : `a run would refuse this tree as it stands: ${why.refusals.join('; ')}`
}

/** The `unknown` sentence of a recursive task whose copies could not be checked. */
export function treeUncheckedSentence(input: { target: string, where: string, why: TreeUnchecked }): string {
  return `Could not check whether the copies under target '${input.target}'${input.where} were changed since their last replication: ${treeUncheckedReason(input.why)}`
}

/** What a `modified` root's sentence adds when its copies could not be checked. */
export function treeUncheckedClause(input: { target: string, why: TreeUnchecked }): string {
  return `Whether the copies below '${input.target}' were changed could not be checked: ${treeUncheckedReason(input.why)}.`
}

export interface DriftCheckInput extends DriftSentenceInput {
  /** The target's snapshot names, newest first. */
  targetSnaps: string[]
  /** This run receives into the target (its receive seals an `exposed` one, ruling 1). */
  sends?: boolean
  /**
   * Reads the holds of `@base` on both sides — asked only when the target is
   * `modified` (the rare case), so the sentence says what is true of them.
   */
  readHeld?: () => Promise<BaseHeld>
  /** What this run did to its holds before this judgement (review D2); absent: nothing. */
  holdActs?: HoldActs
  /**
   * Review P3: an `exposed` target this run does NOT receive into (it is up
   * to date) is set read-only by the run: this sets it, and the sentence says
   * what it answered. Asked for `exposed` only — never for `modified` or
   * `unknown`, and never when `sends` (the receive does it).
   */
  seal?: () => Promise<SealResult>
}

/** Turn one read into the four-state answer with its sentence. */
export async function judgeTargetState(read: TargetStateRead, input: DriftCheckInput): Promise<ReplicationTargetDrift> {
  const { target, base } = input
  if (!read.ok)
    return { state: 'unknown', dataset: target, base, message: unknownSentence({ ...input, reason: read.reason }) }
  const state = classifyTargetState(read.written, read.readonly)
  const common = { dataset: target, base, writtenBytes: read.written, readonly: read.readonly }
  if (state === 'clean')
    return { state, ...common }
  if (state === 'exposed' && input.sends !== true && input.seal) {
    const seal = await input.seal()
    return { state, ...common, message: exposedSetSentence({ ...input, readonly: read.readonly, ...(read.readonlySource ? { readonlySource: read.readonlySource } : {}), seal }) }
  }
  if (state === 'exposed')
    return { state, ...common, message: exposedSentence({ ...input, readonly: read.readonly, ...(read.readonlySource ? { readonlySource: read.readonlySource } : {}), sealed: input.sends === true }) }
  const newer = snapshotsNewerThan(input.targetSnaps, base)
  const held = input.readHeld ? await input.readHeld().catch(() => ({ source: null, target: null })) : undefined
  return {
    state,
    ...common,
    newerSnapshots: newer,
    message: modifiedSentence({
      ...input,
      writtenBytes: read.written,
      newer,
      readonly: read.readonly,
      ...(read.readonlySource ? { readonlySource: read.readonlySource } : {}),
      ...(held ? { held } : {}),
    }),
  }
}

/** How much each state says is wrong, for picking one row out of a tree's copies. */
const STATE_RANK: Record<ReplicationTargetDrift['state'], number> = { modified: 3, unknown: 2, exposed: 1, clean: 0 }

/**
 * repl.drift P1: a recursive task's ONE target state out of its copies'
 * (the task row has one): the worst state wins (changed, then could not be
 * read, then not read-only, then clean); its fields are the first such copy's
 * in sweep order, and its sentence is every such copy's sentence, so an alert
 * names each changed copy. Undefined for no copies.
 */
export function worstTargetDrift(drifts: ReplicationTargetDrift[]): ReplicationTargetDrift | undefined {
  if (drifts.length === 0)
    return undefined
  const top = Math.max(...drifts.map(d => STATE_RANK[d.state]))
  const same = drifts.filter(d => STATE_RANK[d.state] === top)
  const messages = same.flatMap(d => (d.message ? [d.message] : []))
  return messages.length > 1 ? { ...same[0], message: messages.join(' ') } : same[0]
}

/** Read and judge one target: the whole detection for one dataset. */
export async function checkTargetDrift(run: ZfsRunner, input: DriftCheckInput): Promise<ReplicationTargetDrift> {
  return judgeTargetState(await readTargetState(run, input.target, input.base), input)
}

/**
 * What a run RECORDS about a target it found changed or writable (repl.drift):
 * on its result when it completes, on its job detail when it fails, and so in
 * the runner's result line in the unit's journal — the record the dashboard
 * reads for a peer or remote target instead of opening ssh.
 */
export interface RecordedDrift {
  state: 'modified' | 'exposed'
  dataset: string
  base: string
}

/**
 * The record of one judged target, or null for a state that is not recorded:
 * clean, unknown, and an `exposed` target this run sealed — by its receive
 * (ruling 1) or, up to date, by setting it read-only (review P3): it is
 * read-only again, so the dashboard has nothing to say about it.
 */
export function recordOf(d: ReplicationTargetDrift, opts: { sealed?: boolean } = {}): RecordedDrift | null {
  if (d.state === 'exposed' && opts.sealed === true)
    return null
  return d.state === 'modified' || d.state === 'exposed' ? { state: d.state, dataset: d.dataset, base: d.base } : null
}

/**
 * `zfs holds -H -- <snap>` answered: the tags on it, or null when the read
 * did not answer. The answer is no line (no hold) or one
 * `<snapshot>\t<tag>\t<timestamp>` row per hold for the snapshot asked (the
 * captured `fixtures/zfs/zfs-holds-cr47e.txt`); review 2 (R4): an exit 0
 * with any other line did not answer either, so it is null ("could not be
 * read"), never "not held".
 */
export async function snapshotHoldTags(run: ZfsRunner, snapFull: string): Promise<string[] | null> {
  try {
    const r = await run(['holds', '-H', '--', snapFull])
    if (r.exitCode !== 0)
      return null
    const tags: string[] = []
    for (const line of r.stdout.split('\n')) {
      if (line.length === 0)
        continue
      const f = line.split('\t')
      if (f.length !== 3 || f[0] !== snapFull || f[1].length === 0 || f[2].length === 0 || line.includes('\r'))
        return null
      tags.push(f[1])
    }
    return tags
  }
  catch {
    return null
  }
}

/** `zfs holds -H -- <snap>` answered: does it carry `tag`? null when the read did not answer. */
export async function snapshotHeldBy(run: ZfsRunner, snapFull: string, tag: string): Promise<boolean | null> {
  const tags = await snapshotHoldTags(run, snapFull)
  return tags === null ? null : tags.includes(tag)
}

/**
 * The ONE read of `@base`'s holds on both sides (asked only for a `modified`
 * target): this chain's tag per side, and (review N7) whether another hold
 * is on it there. Shared by the run, the recursive gate and the status read.
 */
export async function readBaseHeld(runSource: ZfsRunner, runTarget: ZfsRunner, sourceSnap: string, targetSnap: string, tag: string): Promise<BaseHeld> {
  const source = await snapshotHoldTags(runSource, sourceSnap)
  const target = await snapshotHoldTags(runTarget, targetSnap)
  return {
    source: source === null ? null : source.includes(tag),
    target: target === null ? null : target.includes(tag),
    ...(source?.some(t => t !== tag) ? { sourceOther: true } : {}),
    ...(target?.some(t => t !== tag) ? { targetOther: true } : {}),
  }
}
