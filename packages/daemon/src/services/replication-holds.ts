import type { ReplicationLocation } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { ResolvedLocation, Transport } from './replication-transport.js'
import { createHash } from 'node:crypto'
import { DEFAULT_SYSTEMD_DIR, readAllTasksChecked, resolveTaskDatasets } from './replication-units.js'

/**
 * Replication hold tags (story ident.4 (a), audit #13).
 *
 * A replication pins its incremental base with a `zfs hold` on BOTH sides so
 * retention cannot destroy it and sever the chain. Until ident.4 the tag was
 * one global `anas-repl`, and every run released it on every older snapshot of
 * the source — so two tasks replicating one source to two targets unpinned
 * each other's base, retention destroyed it, and the other task failed
 * "diverged" on its next run.
 *
 * The tag is now PER CHAIN: `anas-repl-<12 hex of sha256(location, target)>`.
 * A chain is a (where, target dataset) pair, so a task and an interactive
 * replicate to the same target share one tag (they share the chain), and two
 * targets of one source never touch each other's hold. A run releases only its
 * own tag.
 *
 * Nothing is stored: the tag is derived from the task's own target, and which
 * snapshots carry it is read from ZFS (`zfs holds`) on every run.
 */

/** The pre-ident.4 global tag, released only by the migration below. */
export const LEGACY_REPLICATION_HOLD_TAG = 'anas-repl'

/** The prefix every per-chain tag starts with. */
export const REPLICATION_HOLD_TAG_PREFIX = 'anas-repl-'

const HASH_LEN = 12

/**
 * `zfs hold` stderr when this tag already pins the snapshot, as OpenZFS 2.4
 * writes it — `cannot hold snapshot '<snap>': tag already exists on this
 * dataset`. Group 1 is the snapshot the message NAMES, which repl.r1 showed is
 * not always the snapshot that was asked for: a name with a space split by the
 * remote shell acts on the part before the space.
 */
const TAG_EXISTS_RE = /cannot hold snapshot '(.*)': tag already exists/i

/**
 * ssh's exit status for its OWN failures (could not connect, lost the peer):
 * an answer that arrives with it is the transport's, never zfs's, whatever
 * the stderr carries (review of repl.r1).
 */
const SSH_OWN_FAILURE = 255

/** The location half of the chain identity — `local` or `<kind>:<name>`. */
function locationKey(location: ReplicationLocation | undefined): string {
  const kind = location?.kind ?? 'local'
  return kind === 'local' ? 'local' : `${kind}:${location?.name ?? ''}`
}

/**
 * The hold tag of the chain that replicates into `targetFull` at `location`.
 * Deterministic, so a task's next run (and the live proof) derives the same
 * tag without anything recorded.
 */
export function replicationHoldTag(location: ReplicationLocation | undefined, targetFull: string): string {
  const digest = createHash('sha256').update(`${locationKey(location)}\n${targetFull}`).digest('hex')
  return `${REPLICATION_HOLD_TAG_PREFIX}${digest.slice(0, HASH_LEN)}`
}

/**
 * `zfs holds -H <snap…>` → snapshot full name → tags held. Tab-separated
 * `<snapshot>\t<tag>\t<timestamp>`. Total: an unparseable line is skipped.
 */
export function parseHolds(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of stdout.split('\n')) {
    if (!line.trim())
      continue
    const [snap, tag] = line.split('\t')
    if (!snap || !tag)
      continue
    const tags = out.get(snap) ?? []
    tags.push(tag)
    out.set(snap, tags)
  }
  return out
}

/**
 * The holds on a set of LOCAL snapshots, in one `zfs holds` call. Fail-open to
 * whatever stdout carried: a snapshot whose holds cannot be read shows none,
 * and every caller below treats "none" as "do not release".
 */
export async function readLocalHolds(executor: CommandExecutor, snapFulls: string[]): Promise<Map<string, string[]>> {
  if (snapFulls.length === 0)
    return new Map()
  // cr.21: `--` ends option parsing; every snapshot operand is derived.
  const r = await executor.exec('/usr/sbin/zfs', ['holds', '-H', '--', ...snapFulls])
  return parseHolds(r.stdout)
}

/**
 * The holds on a set of LOCAL snapshots, FAIL-CLOSED (nf.3 D11): null when
 * `zfs holds` did not answer — a non-zero exit (one of the snapshots went, the
 * pool is suspended) or an exec that threw. {@link readLocalHolds} reads an
 * unanswered call as "no holds", which is safe for its callers (they only
 * RELEASE what they saw) and wrong for a gate that DESTROYS what it did not
 * see held. `zfs-hold(8)`: `zfs holds -H` prints one tab-delimited
 * `<snapshot>\t<tag>\t<timestamp>` row per hold and no header.
 */
export async function readLocalHoldsChecked(executor: CommandExecutor, snapFulls: string[]): Promise<Map<string, string[]> | null> {
  if (snapFulls.length === 0)
    return new Map()
  try {
    const r = await executor.exec('/usr/sbin/zfs', ['holds', '-H', '--', ...snapFulls])
    return r.exitCode === 0 ? parseHolds(r.stdout) : null
  }
  catch {
    return null
  }
}

/**
 * Who holds a snapshot, as a refusal names it (nf.3 D11): `held by
 * replication task 'nightly': anas-repl-…` for a per-chain tag a task derives,
 * `held by a replication no task names (an interactive replicate, or a removed
 * task): anas-repl-…` for one none does, `held by replication (the shared tag
 * from before per-chain tags): anas-repl` for the legacy tag, and `held by
 * '<tag>'` for anyone else's. The task list is read best-effort — it only
 * names the holder; the hold refuses whether or not a task is found.
 *
 * `here` (repl.guard review): the snapshot's dataset and this node's cluster
 * name. A tag that equals the one a PEER derives for a replication into that
 * dataset (or an ancestor, for a recursive one) belongs to a task that lives
 * on the sending node, so "no task names" would be false of it: it reads
 * `held by a replication sent here from another cluster node (its task is on
 * that node)`.
 */
export async function describeHolds(tags: string[], systemdDir: string = DEFAULT_SYSTEMD_DIR, here?: { dataset: string, nodename: string | null }): Promise<string[]> {
  const fromPeer = new Set<string>()
  if (here?.nodename) {
    for (const name of selfAndAncestors(here.dataset))
      fromPeer.add(replicationHoldTag({ kind: 'peer', name: here.nodename }, name))
  }
  const byTag = new Map<string, string>()
  if (tags.some(t => t.startsWith(REPLICATION_HOLD_TAG_PREFIX))) {
    const { tasks } = await readAllTasksChecked(systemdDir).catch(() => ({ tasks: [] }))
    for (const task of tasks)
      byTag.set(replicationHoldTag(task.target.location, resolveTaskDatasets(task).targetFull), task.name)
  }
  return tags.map((tag) => {
    if (tag === LEGACY_REPLICATION_HOLD_TAG)
      return `held by replication (the shared tag from before per-chain tags): ${tag}`
    if (!tag.startsWith(REPLICATION_HOLD_TAG_PREFIX))
      return `held by '${tag}'`
    const task = byTag.get(tag)
    if (!task && fromPeer.has(tag))
      return `held by a replication sent here from another cluster node (its task is on that node): ${tag}`
    return task
      ? `held by replication task '${task}': ${tag}`
      : `held by a replication no task names (an interactive replicate, or a removed task): ${tag}`
  })
}

/** Is this one of ANAS's replication hold tags (a per-chain tag, or the legacy global one)? */
export function isReplicationHoldTag(tag: string): boolean {
  return tag === LEGACY_REPLICATION_HOLD_TAG || tag.startsWith(REPLICATION_HOLD_TAG_PREFIX)
}

// ---------------------------------------------------------------------------
// repl.guard: "is this dataset a replication TARGET?" (stateless)
// ---------------------------------------------------------------------------

/**
 * How many of a dataset's held snapshots the predicate reads the tags of,
 * newest first. A chain's hold sits on its newest replicated snapshot (the
 * settle step releases the older ones), so the newest held snapshots are where
 * a replication tag is. The cap keeps a dataset with thousands of held
 * snapshots (a backup tool's own holds) from making a property edit slow: one
 * `zfs holds` over at most this many operands.
 */
export const REPLICA_HELD_SNAPSHOT_CAP = 64

/**
 * `zfs list` argv for the predicate's first read: the dataset's OWN snapshots
 * (`-d 1`) with their user-hold count, newest first by createtxg (ZFS's own
 * order). `-Hp`: tab-separated, `userrefs` an exact integer — the columns the
 * snapshot schedule inventory reads live (services/snapshot-schedules.ts).
 */
export function heldCountListArgs(dataset: string): string[] {
  return ['list', '-t', 'snapshot', '-Hp', '-o', 'name,userrefs', '-S', 'createtxg', '-d', '1', '--', dataset]
}

/**
 * A replication hold says the dataset is a target. `via` is how the tag was
 * attributed: `local` / `peer` (this node computes the tag of a chain whose
 * target is this dataset or a recursive root above it), `unattributed` (a
 * chain this node cannot compute, a registered remote's or the legacy tag, on
 * a read-only dataset no replication task on this node sends from with it).
 */
export interface ReplicaTargetFound {
  replica: true
  snapshot: string
  tag: string
  via: 'local' | 'peer' | 'unattributed'
}

/**
 * What the replica-target predicate found: not a target (no replication hold
 * says so), a target, or a read that failed (the sentence says which; never
 * "not a target").
 */
export type ReplicaTargetRead = { replica: false } | ReplicaTargetFound | { unreadable: string }

export interface ReplicaTargetInput {
  /** The dataset (`pool/path`). */
  dataset: string
  /** Is the dataset read-only NOW (the fallback for a chain this node cannot compute)? */
  readonly: boolean
  /** This node's PVE name (`/etc/pve/.members`), read only when a replication tag is found; null off a cluster. */
  nodename: () => Promise<string | null>
  /** The replication task units (`anas-repl-*`), read only for a tag this node cannot compute. */
  systemdDir?: string
}

/** `pool/a/b` → `['pool/a/b', 'pool/a', 'pool']`: the dataset and every ancestor. */
function selfAndAncestors(dataset: string): string[] {
  const out: string[] = []
  const parts = dataset.split('/')
  for (let i = parts.length; i > 0; i--)
    out.push(parts.slice(0, i).join('/'))
  return out
}

/**
 * Is `dataset` the TARGET of a replication chain (repl.guard)? Stateless:
 * read from ZFS holds and, only when needed, the cluster members file and the
 * task units.
 *
 * A replication holds its base on BOTH sides (settleReplicationHolds), so a
 * hold alone does not say "target". The tag does: `anas-repl-<hash(location,
 * targetFull)>`. This node can compute the tag of every chain whose target is
 * HERE — `local` (a replication within this node) and `peer:<this node>` (a
 * peer in the cluster sending here) — for the dataset itself and for each
 * ancestor (a recursive replication tags every child with its ROOT's tag,
 * routes/replication.ts R7). A tag that matches is a target, whatever the
 * dataset's state.
 *
 * A registered remote's chain is keyed by the name the SENDING node gave the
 * remote, which this node cannot know; the legacy `anas-repl` tag names no
 * chain at all. For those the fallback is: the dataset is read-only now (every
 * first receive creates it `readonly=on`) AND no replication task on this node
 * sends from it (or from a recursive root above it) with that tag (for the
 * legacy tag: no task on this node sends from it at all) — a task here that
 * derives the tag makes this the SOURCE side of that chain.
 *
 * Cost: one `zfs list` of the dataset's own snapshots (names and hold counts),
 * then — only when some are held — ONE `zfs holds -H` over the newest
 * {@link REPLICA_HELD_SNAPSHOT_CAP} held ones; the members file and the task
 * list only when a replication tag is found that needs them.
 *
 * Known wrong answers: a SOURCE that is read-only and carries a replication
 * hold no task on this node derives (an interactive one-shot replicate to any
 * location, local, peer or remote; or the hold a removed or re-pointed task
 * left behind) reads as a target, `via: 'unattributed'`, and the confirm says
 * "looks like" for it; a target whose replication hold is on a
 * snapshot older than the newest {@link REPLICA_HELD_SNAPSHOT_CAP} held ones,
 * or whose fallback chain is also sent onward from here with the legacy tag,
 * reads as not a target.
 */
export async function readReplicaTarget(executor: CommandExecutor, input: ReplicaTargetInput): Promise<ReplicaTargetRead> {
  const { dataset } = input
  let listed: { stdout: string, stderr: string, exitCode: number }
  try {
    listed = await executor.exec('/usr/sbin/zfs', heldCountListArgs(dataset))
  }
  catch (err) {
    return { unreadable: `the snapshots of '${dataset}' could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (listed.exitCode !== 0)
    return { unreadable: `the snapshots of '${dataset}' could not be read: ${listed.stderr.trim() || `exit ${listed.exitCode}`}` }
  const held: string[] = []
  for (const line of listed.stdout.split('\n')) {
    const [name, userrefs] = line.trim().split('\t')
    if (name?.startsWith(`${dataset}@`) && Number.parseInt(userrefs ?? '', 10) > 0)
      held.push(name)
  }
  if (held.length === 0)
    return { replica: false }
  const read = held.slice(0, REPLICA_HELD_SNAPSHOT_CAP)
  const holds = await readLocalHoldsChecked(executor, read)
  if (!holds)
    return { unreadable: `the holds on the snapshots of '${dataset}' could not be read` }
  // Newest first, as listed: the first replication hold found is the one named.
  const found: { snapshot: string, tag: string }[] = []
  for (const snapshot of read) {
    for (const tag of holds.get(snapshot) ?? []) {
      if (isReplicationHoldTag(tag))
        found.push({ snapshot, tag })
    }
  }
  if (found.length === 0)
    return { replica: false }

  // 1) A tag this node computes for a chain whose target is here.
  const nodename = await input.nodename()
  const computed = new Map<string, 'local' | 'peer'>()
  for (const name of selfAndAncestors(dataset)) {
    computed.set(replicationHoldTag({ kind: 'local' }, name), 'local')
    if (nodename)
      computed.set(replicationHoldTag({ kind: 'peer', name: nodename }, name), 'peer')
  }
  for (const f of found) {
    const via = computed.get(f.tag)
    if (via)
      return { replica: true, snapshot: f.snapshot, tag: f.tag, via }
  }

  // 2) The fallback, for a tag this node cannot compute: read-only now, and
  //    no task on this node sends from here with it. A task list that could
  //    not be read in full cannot say "no task" — unreadable, not a guess.
  if (!input.readonly)
    return { replica: false }
  const { tasks, complete } = await readAllTasksChecked(input.systemdDir ?? DEFAULT_SYSTEMD_DIR)
    .catch(() => ({ tasks: [], complete: false }))
  if (!complete)
    return { unreadable: 'the replication task list could not be read in full' }
  const lineage = new Set(selfAndAncestors(dataset))
  const sendsFromHere = tasks
    .map(task => ({ task, ds: resolveTaskDatasets(task) }))
    .filter(({ task, ds }) => ds.sourceFull === dataset || (task.recursive === true && lineage.has(ds.sourceFull)))
  for (const f of found) {
    const sent = f.tag === LEGACY_REPLICATION_HOLD_TAG
      ? sendsFromHere.length > 0
      : sendsFromHere.some(({ task, ds }) => replicationHoldTag(task.target.location, ds.targetFull) === f.tag)
    if (!sent)
      return { replica: true, snapshot: f.snapshot, tag: f.tag, via: 'unattributed' }
  }
  return { replica: false }
}

/** One side of a replication, for the hold settle step. */
export interface HoldSide {
  /** The dataset the snapshots belong to. */
  dataset: string
  /** Every snapshot NAME (the part after `@`) on this side. */
  snapshotNames: string[]
}

export interface SettleHoldsInput {
  /** This chain's tag ({@link replicationHoldTag}). */
  tag: string
  /** The snapshot just replicated — the new base, held on both sides. */
  snapName: string
  /** The incremental base this run used (absent on a full send). */
  baseSnapshot?: string
  source: HoldSide
  target: HoldSide
  /** Remote/peer target: the resolved location (holds go over ssh). */
  remote?: ResolvedLocation
  /**
   * May the legacy `anas-repl` hold come off this source's previous base? False
   * while another chain of the same source has not yet placed its own tag (its
   * base may be the very snapshot the legacy hold pins).
   */
  releaseLegacyOnSource: boolean
  /**
   * repl.drift review D2: when given, the settle records what it CHANGED —
   * every hold it placed (a `zfs hold` that exited 0; one answered "tag
   * already exists" changed nothing) and every hold it released (a `zfs
   * release` that exited 0), as full snapshot names — so a sentence about
   * the run can say what happened to its holds.
   */
  done?: SettleActs
}

/** What a settle changed (review D2): full snapshot names, in command order. */
export interface SettleActs {
  placed: string[]
  released: string[]
}

export interface HoldDeps {
  executor: CommandExecutor
  transport: Transport
}

function failText(r: { exitCode: number, stderr: string }): string {
  return r.stderr.trim() || `exit ${r.exitCode}`
}

/**
 * Hold the new base under this chain's tag on both sides, release this chain's
 * tag on every older snapshot, and migrate the legacy global tag. Fail-open: a
 * hiccup is a warning, never a job failure (the data is already replicated).
 *
 * ORDER IS THE SAFETY: the own hold goes on first, and NOTHING comes off a
 * side unless the own hold on that side succeeded — neither this chain's tag on
 * older snapshots nor the legacy tag. A side whose new base could not be held
 * keeps every hold it had (the previous base stays pinned, so retention cannot
 * sever the chain) and the run carries a warning saying so. The legacy hold
 * comes off a held side:
 *   - TARGET: every snapshot carrying it (the target dataset is this chain's);
 *   - SOURCE: only this chain's own base (the snapshot just sent and the base
 *     it was sent from), and only when `releaseLegacyOnSource` — another chain
 *     of the same source that has not yet migrated may be relying on it.
 */
export async function settleReplicationHolds(deps: HoldDeps, input: SettleHoldsInput): Promise<string[]> {
  const { executor, transport } = deps
  const { tag, snapName, source, target, remote } = input
  const warnings: string[] = []

  const srcSnapFull = `${source.dataset}@${snapName}`
  const tgtSnapFull = `${target.dataset}@${snapName}`

  // 1) The own holds — new base, both sides. cr.21: `--` before the hold-tag
  //    and snapshot operands (both derived).
  const done = input.done
  const srcHold = await executor.exec('/usr/sbin/zfs', ['hold', '--', tag, srcSnapFull])
  if (srcHold.exitCode === 0)
    done?.placed.push(srcSnapFull)
  const srcHeld = srcHold.exitCode === 0 || (srcHold.exitCode !== SSH_OWN_FAILURE && alreadyHeld(srcHold.stderr, srcSnapFull))
  if (!srcHeld) {
    warnings.push(`Could not place ${tag} hold on ${srcSnapFull}: ${failText(srcHold)}`)
    warnings.push(`Kept every hold on ${source.dataset}: its new base is not held, so the previous base stays pinned`)
  }
  const tgtHold = remote
    ? await transport.remoteHold(remote, tgtSnapFull, tag)
    : await executor.exec('/usr/sbin/zfs', ['hold', '--', tag, tgtSnapFull])
  if (tgtHold.exitCode === 0)
    done?.placed.push(tgtSnapFull)
  const tgtHeld = tgtHold.exitCode === 0 || (tgtHold.exitCode !== SSH_OWN_FAILURE && alreadyHeld(tgtHold.stderr, tgtSnapFull))
  if (!tgtHeld) {
    warnings.push(`Could not place ${tag} hold on ${tgtSnapFull}: ${failText(tgtHold)}`)
    warnings.push(`Kept every hold on ${target.dataset}: its new base is not held, so the previous base stays pinned`)
  }

  // 2) Source: release this chain's tag on older snapshots; migrate legacy —
  //    only once the new base is held here.
  if (srcHeld) {
    const srcFulls = source.snapshotNames.map(n => `${source.dataset}@${n}`)
    const srcHolds = await readLocalHolds(executor, srcFulls)
    const ownBase = new Set([snapName, ...(input.baseSnapshot ? [input.baseSnapshot] : [])])
    for (const name of source.snapshotNames) {
      const full = `${source.dataset}@${name}`
      const tags = srcHolds.get(full) ?? []
      if (name !== snapName && tags.includes(tag))
        await releaseLocal(executor, tag, full, warnings, done)
      if (input.releaseLegacyOnSource && ownBase.has(name) && tags.includes(LEGACY_REPLICATION_HOLD_TAG))
        await releaseLocal(executor, LEGACY_REPLICATION_HOLD_TAG, full, warnings, done)
    }
  }

  // 3) Target: the same, local or over ssh, and again only once the new base
  //    is held there. The target dataset is this chain's, so the legacy hold
  //    comes off wherever it sits.
  if (tgtHeld && remote) {
    for (const name of target.snapshotNames) {
      const full = `${target.dataset}@${name}`
      const tags = await transport.remoteHeldTags(remote, full)
      for (const t of releasableTargetTags(tags, name, snapName, tag)) {
        const rel = await transport.remoteRelease(remote, full, t)
        if (rel.exitCode !== 0)
          warnings.push(`Could not release ${t} hold on ${full}: ${failText(rel)}`)
        else
          done?.released.push(full)
      }
    }
  }
  else if (tgtHeld) {
    const tgtFulls = target.snapshotNames.map(n => `${target.dataset}@${n}`)
    const tgtHolds = await readLocalHolds(executor, tgtFulls)
    for (const name of target.snapshotNames) {
      const full = `${target.dataset}@${name}`
      for (const t of releasableTargetTags(tgtHolds.get(full) ?? [], name, snapName, tag))
        await releaseLocal(executor, t, full, warnings, done)
    }
  }
  return warnings
}

/** The tags to release on one target snapshot (the new base is held there). */
function releasableTargetTags(tags: string[], name: string, snapName: string, tag: string): string[] {
  const out: string[] = []
  if (name !== snapName && tags.includes(tag))
    out.push(tag)
  if (tags.includes(LEGACY_REPLICATION_HOLD_TAG))
    out.push(LEGACY_REPLICATION_HOLD_TAG)
  return out
}

/**
 * Did `zfs hold` answer "this tag already pins the snapshot I was ASKED about"?
 *
 * The snapshot named in the message must be exactly the one we asked to hold.
 * repl.r1: a snap name with a space handed to a remote shell unquoted split
 * there, and the hold of `p/ds@nightly 2` answered `cannot hold snapshot
 * 'p/ds@nightly': tag already exists on this dataset` plus `'2' is not a
 * snapshot`, exit 1 — the spaced snapshot was NOT held, and reading that as
 * held let the settle release the chain's tag from the snapshot that was. A
 * tag-exists line about any OTHER snapshot is therefore not an answer about
 * ours. Other lines on stderr (an ssh notice) do not change the answer: were
 * they to, a chatty ssh would stop every release and old bases would stay
 * pinned for good.
 */
function alreadyHeld(stderr: string, snapshot: string): boolean {
  for (const line of stderr.split('\n')) {
    const m = TAG_EXISTS_RE.exec(line.trim())
    if (m !== null && m[1] === snapshot)
      return true
  }
  return false
}

async function releaseLocal(executor: CommandExecutor, tag: string, full: string, warnings: string[], done?: SettleActs): Promise<void> {
  const rel = await executor.exec('/usr/sbin/zfs', ['release', '--', tag, full])
  if (rel.exitCode !== 0)
    warnings.push(`Could not release ${tag} hold on ${full}: ${failText(rel)}`)
  else
    done?.released.push(full)
}

/** Whether the legacy hold may come off this source, and why not when it may not. */
export interface LegacyReleaseVerdict {
  releasable: boolean
  /** Set when the verdict is "keep" for a reason the run should report. */
  warning?: string
}

/**
 * May the legacy hold come off THIS source's base? Only when every OTHER
 * replication task of the same source dataset has already placed its own tag
 * somewhere on the source — a task that has not run since the upgrade may be
 * relying on the legacy hold for its base. Tasks are read from their units
 * (the store is the units). A store that cannot be read IN FULL (unit dir
 * unreadable, a task file unreadable or unparseable) is not "no other tasks":
 * the legacy hold stays and the run says why.
 */
export async function legacyReleasableOnSource(
  executor: CommandExecutor,
  input: { sourceFull: string, ownTag: string, sourceSnapshotNames: string[], systemdDir?: string },
): Promise<LegacyReleaseVerdict> {
  const { tasks, complete } = await readAllTasksChecked(input.systemdDir ?? DEFAULT_SYSTEMD_DIR)
    .catch(() => ({ tasks: [], complete: false }))
  if (!complete) {
    return {
      releasable: false,
      warning: `Kept the legacy ${LEGACY_REPLICATION_HOLD_TAG} hold on ${input.sourceFull}: the replication task list could not be read in full, so another task may still rely on it`,
    }
  }
  const otherTags = new Set<string>()
  for (const task of tasks) {
    const { sourceFull, targetFull } = resolveTaskDatasets(task)
    if (sourceFull !== input.sourceFull)
      continue
    const t = replicationHoldTag(task.target.location, targetFull)
    if (t !== input.ownTag)
      otherTags.add(t)
  }
  if (otherTags.size === 0)
    return { releasable: true }
  const holds = await readLocalHolds(executor, input.sourceSnapshotNames.map(n => `${input.sourceFull}@${n}`))
  const present = new Set<string>()
  for (const tags of holds.values()) {
    for (const t of tags)
      present.add(t)
  }
  return { releasable: [...otherTags].every(t => present.has(t)) }
}
