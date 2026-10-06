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

/** `zfs hold` stderr when this tag already pins the snapshot. */
const TAG_EXISTS_RE = /tag already exists/i

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
  const r = await executor.exec('/usr/sbin/zfs', ['holds', '-H', ...snapFulls])
  return parseHolds(r.stdout)
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

  // 1) The own holds — new base, both sides.
  const srcHold = await executor.exec('/usr/sbin/zfs', ['hold', tag, srcSnapFull])
  const srcHeld = srcHold.exitCode === 0 || alreadyHeld(srcHold.stderr)
  if (!srcHeld) {
    warnings.push(`Could not place ${tag} hold on ${srcSnapFull}: ${failText(srcHold)}`)
    warnings.push(`Kept every hold on ${source.dataset}: its new base is not held, so the previous base stays pinned`)
  }
  const tgtHold = remote
    ? await transport.remoteHold(remote, tgtSnapFull, tag)
    : await executor.exec('/usr/sbin/zfs', ['hold', tag, tgtSnapFull])
  const tgtHeld = tgtHold.exitCode === 0 || alreadyHeld(tgtHold.stderr)
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
        await releaseLocal(executor, tag, full, warnings)
      if (input.releaseLegacyOnSource && ownBase.has(name) && tags.includes(LEGACY_REPLICATION_HOLD_TAG))
        await releaseLocal(executor, LEGACY_REPLICATION_HOLD_TAG, full, warnings)
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
      }
    }
  }
  else if (tgtHeld) {
    const tgtFulls = target.snapshotNames.map(n => `${target.dataset}@${n}`)
    const tgtHolds = await readLocalHolds(executor, tgtFulls)
    for (const name of target.snapshotNames) {
      const full = `${target.dataset}@${name}`
      for (const t of releasableTargetTags(tgtHolds.get(full) ?? [], name, snapName, tag))
        await releaseLocal(executor, t, full, warnings)
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

/** `zfs hold` of a tag already present answers EEXIST — the hold is there. */
function alreadyHeld(stderr: string): boolean {
  return TAG_EXISTS_RE.test(stderr)
}

async function releaseLocal(executor: CommandExecutor, tag: string, full: string, warnings: string[]): Promise<void> {
  const rel = await executor.exec('/usr/sbin/zfs', ['release', tag, full])
  if (rel.exitCode !== 0)
    warnings.push(`Could not release ${tag} hold on ${full}: ${failText(rel)}`)
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
