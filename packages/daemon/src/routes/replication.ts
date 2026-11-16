import type { ReplicatePlan, ReplicateRequest as ReplicateRequestBody, Snapshot } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor, ExecResult, PipelineResult } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { PveFootprint } from '../services/pve-footprint.js'
import type { BaseHeld, ZfsRunner } from '../services/replication-drift.js'
import type { SettleActs } from '../services/replication-holds.js'
import type { ReplicationNotifyContext } from '../services/replication-notify.js'
import type { TargetPlacement } from '../services/replication-target.js'
import type { PoolExistence, Transport } from '../services/replication-transport.js'
import type { TreeGateRefusal } from '../services/replication-tree-gate.js'
import { ReplicatePlanRequest, ReplicateRequest } from '@anas/shared'
import { GuardRefusalError, sendRefusal, zfsDatasetClaims } from '../safety/guard.js'
import { readPoolGuid } from '../safety/stable-id.js'
import { ownershipRefusal } from '../services/pve-footprint.js'
import { checkTargetDrift, nextIncrementalBase, readBaseHeld, recordOf } from '../services/replication-drift.js'
import { legacyReleasableOnSource, readLocalHoldsChecked, replicationHoldTag, settleReplicationHolds } from '../services/replication-holds.js'
import { notifyReplicationRun, singleLine } from '../services/replication-notify.js'
import { newestReplicable, readLocalSnapshots, readRemoteSnapshotNames } from '../services/replication-snapshots.js'
import { guardReplicationTarget, readLocalPoolExistence } from '../services/replication-target.js'
import { gateTreeRun } from '../services/replication-tree-gate.js'
import { readTreeFacts } from '../services/replication-tree-read.js'
import { decideBase, divergedMessage, modifiedTargetHint, treeTargetName } from '../services/replication-tree.js'
import { isTransientRunSnapshot } from '../services/snapshot-naming.js'
import { datasetSourceClaims } from '../services/source-claims.js'
import { createZfsSnapshot, ZFS_REMOTE } from '../services/zfs-snapshot.js'
import { requireIdentity } from './identity.js'

/**
 * Replication (Epic 5.5.1) — LOCAL one-shot `zfs send | zfs recv`.
 *
 * These handlers hang off the dataset `*` wildcard in datasets.ts (find-my-way
 * allows only ONE wildcard route per method+path, so replication cannot be its
 * own plugin) — the datasets POST wildcard detects the `/replicate` and
 * `/replicate/plan` suffixes and dispatches here. The seams stay clean: this
 * module owns all of the send/recv reasoning, sharing only the small dataset
 * helper closures it is handed.
 *
 * Stateless (Principle): the incremental base is DISCOVERED at run time as the
 * newest snapshot common to source and target (never bookkept). The destination
 * is created `readonly=on`, and every later receive re-asserts it (repl.drift
 * ruling 1). A `zfs hold` pins the replicated base on BOTH sides
 * so cleanup cannot sever the chain; the tag is per chain
 * (`anas-repl-<hash(location, target)>`, story ident.4) and a run releases only
 * its own tag on older snapshots, so exactly this chain's newest base stays
 * held and another target of the same source is never unpinned. journald is
 * forensics.
 */

const ZFS = '/usr/sbin/zfs'

/**
 * Dependencies handed in from datasetRoutes — its executor, queue, and the
 *  small dataset helper closures we reuse rather than duplicate.
 */
export interface ReplicationDeps {
  executor: CommandExecutor
  jobQueue: JobQueue
  /**
   * Resolve pool + wildcard tail → full dataset name (empty tail = pool root);
   *  sends a 400 and returns null on an invalid path.
   */
  resolveDatasetName: (poolName: string, datasetPath: string, reply: FastifyReply) => string | null
  /**
   * The datasets wiring's boolean pool probe (false on a failed read). Kept
   * for that wiring; replication asks `readLocalPoolExistence` instead (cr3).
   */
  poolExists: (poolName: string) => Promise<boolean>
  datasetExists: (poolName: string, fullName: string) => Promise<boolean>
  /**
   * A dataset's snapshots, newest-first (empty when it has none). The
   * datasets wiring still hands it in; the replication runs no longer read
   * through it (cr3): it answers `[]` on a failed listing and orders by
   * creation time, and replication reads its snapshots through
   * services/replication-snapshots.ts, which says "could not read" and
   * orders by createtxg.
   */
  listSnapshotsDetail: (fullName: string) => Promise<Snapshot[]>
  /**
   * PVE footprint ownership (story pvepool.1): the ONE service that answers
   * "is this dataset PVE's?" — the target guard asks it per request, judging
   * the target DATASET rather than the pool.
   */
  pveFootprint: () => Promise<PveFootprint>
  /** Stage-3 remote/peer SSH transport (location resolution + remote zfs ops). */
  transport: Transport
  /**
   * Where the `anas-repl-*` task units live — read by the legacy hold
   * migration to learn the source's other chains (ident.4). Defaults to the
   * ANAS_SYSTEMD_DIR / `/etc/systemd/system` every unit store uses.
   */
  systemdDir?: string
}

/**
 * Parse the byte count from `zfs send -nvP` dry-run output. The stream is
 * tab-separated; the authoritative figure is the `size\t<bytes>` line. Fallback:
 * the trailing byte count on the first (`full`/`incremental`) line. Fail-open to
 * 0 when neither is parseable.
 *
 *   full\ttestpool/share1@repl-base\t13424
 *   size\t13424
 */
export function parseSendDryRun(stdout: string): number {
  const lines = stdout.split('\n')
  for (const line of lines) {
    const parts = line.split('\t')
    if (parts[0] === 'size' && parts[1] !== undefined) {
      const n = Number.parseInt(parts[1].trim(), 10)
      if (Number.isFinite(n))
        return n
    }
  }
  // Fallback: the first non-empty line's last tab field is the byte count.
  const first = lines.find(l => l.trim())
  if (first) {
    const parts = first.trim().split('\t')
    const n = Number.parseInt(parts.at(-1) ?? '', 10)
    if (Number.isFinite(n))
      return n
  }
  return 0
}

/** A source dataset's path relative to its pool ('' for the pool-root dataset). */
function relativePath(fullName: string): string {
  const slash = fullName.indexOf('/')
  return slash === -1 ? '' : fullName.slice(slash + 1)
}

/**
 * Resolve where a replication lands. The target dataset path defaults to the
 * source's own relative path; for a POOL-ROOT source (no relative path) we
 * instead default to the SOURCE POOL'S NAME as the child path — a `zfs recv`
 * into a bare pool root is never what we want, so `testpool` → `<targetpool>/testpool`.
 */
function resolveTarget(sourceFull: string, sourcePool: string, target: { pool: string, dataset?: string }): string {
  const sourceRel = relativePath(sourceFull)
  // rrep.2 fold D2: '' is the schema's "default" (ReplicationTarget.dataset),
  // the same instruction as absent — never the pool root `<pool>/`.
  const targetRel = target.dataset || (sourceRel || sourcePool)
  return `${target.pool}/${targetRel}`
}

/** The base part of a discovered replication plan (shared by plan + run). */
interface Discovered {
  mode: 'full' | 'incremental'
  snapshot: string
  baseSnapshot?: string
  targetExists: boolean
  targetDiverged: boolean
  /**
   * cr3 REPLICATION-M1: the target already has `snapshot` — nothing is sent
   * (the planner's `upToDate`, replication-tree.ts). Before, the base search
   * ran anyway, an incremental from an older base was "received" (ZFS: "snap
   * ... already exists; ignoring", exit 0) and the holds were settled on
   * `snapshot` — for a Replicate Once of an OLDER snapshot that moved the
   * chain's hold BACK and released the real base on both sides.
   */
  upToDate: boolean
  /**
   * The newest non-transient source snapshot NEWER than `snapshot` that the
   * target also has, when there is one: the chain's base is already past
   * `snapshot`, so its holds are never moved onto `snapshot`.
   */
  newerCommon?: string
  /**
   * Review of cr3: up to date, and the target's newest snapshot is this
   * backup/cloud transient the source still has — the next send starts from
   * it, so no hold is settled (decideBase rule 1).
   */
  keepHoldsOn?: string
  /** A sentence the run refuses with before sending (decideBase rules 2–4, 6). */
  refusal?: string
}

/**
 * Decide full vs incremental from live ZFS state: target absent → full;
 * otherwise the ONE base rule the recursive planner also asks
 * ({@link decideBase}, services/replication-tree.ts — review of cr3: the two
 * paths must agree). Both lists are newest-first by createtxg; the target's is
 * its OWN order. ZFS (no -F) receives `-i @B` when @B is on the target and the
 * target is unmodified since its newest snapshot; where it was modified, ZFS
 * refuses and the failure sentence names the rollback (`modifiedTargetHint`).
 *
 * ⚠ TRANSIENT BACKUP SNAPSHOTS (backup2.3). A snapshot-consistent backup run
 * takes `anas-backup-<task>-<ts>` on the source and destroys it in a
 * `finally`; one is never chosen as an ordinary base and the chain's hold is
 * never settled onto one. The single exception is decideBase's rule 2: when
 * the target's NEWEST snapshot is a transient the source still has (an older
 * build sent one), it is the base for that one send — the stream ZFS receives
 * whether or not that transient carried changes — and the hold is then
 * settled on S, releasing the transient.
 */
function discover(sourceSnaps: Snapshot[], targetSnaps: Snapshot[] | null, snapshot: string, ctx: { target: string, where: string }): Discovered {
  if (targetSnaps === null)
    return { mode: 'full', snapshot, targetExists: false, targetDiverged: false, upToDate: false }
  const d = decideBase(sourceSnaps.map(s => s.snapshotName), targetSnaps.map(s => s.snapshotName), snapshot, ctx)
  switch (d.kind) {
    case 'upToDate':
      return {
        mode: 'incremental',
        snapshot,
        targetExists: true,
        targetDiverged: false,
        upToDate: true,
        ...(d.newerCommon ? { newerCommon: d.newerCommon } : {}),
        ...(d.keepHoldsOn ? { keepHoldsOn: d.keepHoldsOn } : {}),
      }
    case 'incremental':
      return { mode: 'incremental', snapshot, baseSnapshot: d.base, targetExists: true, targetDiverged: false, upToDate: false }
    case 'refuse':
      return { mode: 'incremental', snapshot, targetExists: true, targetDiverged: false, upToDate: false, refusal: d.message }
    case 'diverged':
      // Nothing in common at all (reported as a full send whose bytes the
      // plan still estimates; the run refuses it).
      return { mode: 'full', snapshot, targetExists: true, targetDiverged: true, upToDate: false }
  }
}

/**
 * The refusal of a NAMED backup or cloud transient (review of cr3). Such a
 * snapshot (`anas-backup-*`, `anas-cloud-*`, `isTransientRunSnapshot`) is
 * destroyed by the run that took it, so it can never be a replication base:
 * sent, the settle would move the chain's hold onto it (and keep the run's
 * own cleanup from destroying it), and once the hold's old base was pruned
 * the next run would read "diverged". Refused at the request, before any job,
 * rather than sent without moving the hold: a replica whose newest snapshot
 * is a transient breaks the next incremental anyway (ZFS refuses a stream
 * whose base is not the target's newest snapshot).
 */
function namedTransientMessage(source: string, snapshot: string): string {
  return `'${source}@${snapshot}': snapshot names beginning with 'anas-backup-' or 'anas-cloud-' are reserved for backup and cloud runs and are never replicated by name — name another snapshot, or none for the newest`
}

/**
 * What a failed `zfs send | zfs recv` said, for the job error and the mail
 * body: the receive's stderr, else the send's, else both exit codes. The
 * stderr is text the far side writes (a remote `zfs recv` over ssh), so it is
 * made ONE line with no control characters (cr3 REPLICATION-L5): verbatim, a
 * newline in it wrote lines of its own into the notification body.
 */
function pipelineFailureDetail(pipe: PipelineResult): string {
  if (pipe.rightStderr.trim())
    return `recv: ${singleLine(pipe.rightStderr)}`
  if (pipe.leftStderr.trim())
    return `send: ${singleLine(pipe.leftStderr)}`
  return `send exited ${pipe.leftExitCode}, recv exited ${pipe.rightExitCode}`
}

const ISO_PUNCT_RE = /[:.]/g

/** Two notes of one run as one sentence pair (either may be absent). */
function joinNotes(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined)
    return b
  return b === undefined ? a : `${a}. ${b}`
}

/** Sortable, ZFS-legal default snapshot name for the snapshot-first convenience. */
function defaultSnapName(): string {
  return `snapshot-${new Date().toISOString().replace(ISO_PUNCT_RE, '-')}`
}

export function createReplicationHandlers(deps: ReplicationDeps) {
  const { executor, jobQueue, resolveDatasetName, datasetExists, transport } = deps

  /**
   * The target-side guards — location resolution, pool existence WHERE THE
   * TARGET LIVES, the PVE-footprint exclusion (pvepool.1) and the onto-itself
   * check — all live in services/replication-target.ts, shared verbatim with
   * the recurring-task routes (issue #46).
   */
  // cr3: the LOCAL probe is three-valued like the remote one (repl.r2): a
  // failing `zpool list` on this node is "could not list the pools on this
  // node", never "does not exist". It reads `zpool list -j` itself — the
  // datasets wiring's `poolExists` dep is a boolean that answers false on a
  // failed read, so it is no longer asked here.
  const localPoolExists = (pool: string): Promise<PoolExistence> => readLocalPoolExistence(executor, pool)
  const guardDeps = { transport, poolExists: localPoolExists, pveFootprint: deps.pveFootprint }

  /** `<kind> '<name>'` for a sentence about a peer/remote target. */
  function whereLabel(target: { location?: { kind: string, name?: string } }): string {
    const loc = target.location
    return loc && loc.kind !== 'local' ? ` on ${loc.kind} '${loc.name ?? ''}'` : ''
  }

  /**
   * repl.drift: `zfs <args>` where the target lives — a second local `zfs`, or
   * the SAME ssh argv every other target read uses (`ZFS_REMOTE` unqualified,
   * the transport's `buildSshArgv`, `--` before the destination).
   */
  function targetZfs(loc: TargetPlacement): ZfsRunner {
    if (loc.isRemote) {
      const resolved = loc.resolved
      return (args: string[]): Promise<ExecResult> => transport.sshExec(resolved, [ZFS_REMOTE, ...args])
    }
    return (args: string[]): Promise<ExecResult> => executor.exec(ZFS, args)
  }

  /** repl.drift: does `@base` carry this chain's hold, on each side (asked only for a `modified` target). */
  function baseHeld(loc: TargetPlacement, sourceDs: string, targetDs: string, base: string, tag: string): () => Promise<BaseHeld> {
    return () => readBaseHeld(args => executor.exec(ZFS, args), targetZfs(loc), `${sourceDs}@${base}`, `${targetDs}@${base}`, tag)
  }

  /**
   * The SOURCE's snapshots, newest first by createtxg (cr3): a listing that
   * failed is an error naming the read, never "no snapshots" (before, the
   * datasets helper answered `[]` and the run said "create a snapshot first").
   */
  async function sourceSnapshots(source: string): Promise<{ ok: true, snaps: Snapshot[] } | { ok: false, status: 404 | 503, message: string }> {
    const r = await readLocalSnapshots(executor, source)
    if (!r.ok)
      return { ok: false, status: 503, message: `Could not list the snapshots of '${source}': ${r.error} — refusing the replication` }
    if (!r.exists)
      return { ok: false, status: 404, message: `Dataset '${source}' not found` }
    return { ok: true, snaps: r.snapshots }
  }

  /**
   * The target dataset's snapshots (as minimal Snapshot records — only
   * snapshotName is read downstream), null when the target dataset is absent,
   * or the sentence of a read that failed (cr3). A failed listing used to read
   * as `[]` — an existing target with no snapshots — and the run then said
   * "has diverged ... remove the target dataset": a replica the operator was
   * told to destroy because a read had failed. Remote targets go over ssh
   * (the same two commands as before); the zfs -H list yields names only.
   */
  async function targetSnapshots(loc: TargetPlacement, target: ReplicateRequestBody['target'], targetFull: string): Promise<{ ok: true, snaps: Snapshot[] | null } | { ok: false, error: string, message: string }> {
    const failed = (error: string) => ({ ok: false as const, error, message: `Could not list the snapshots of target '${targetFull}'${whereLabel(target)}: ${error} — refusing the replication; nothing was sent` })
    if (loc.isRemote) {
      const resolved = loc.resolved
      const r = await readRemoteSnapshotNames(cmd => transport.sshExec(resolved, cmd), targetFull)
      if (!r.ok)
        return failed(r.error)
      return { ok: true, snaps: r.exists ? r.snapshots.map(n => ({ snapshotName: n }) as Snapshot) : null }
    }
    // Absent is ZFS's own answer ("dataset does not exist", the read's
    // `exists: false`); the datasets helper's boolean read a failed pool
    // listing as "absent" too and is not asked here (review of cr3).
    const r = await readLocalSnapshots(executor, targetFull)
    if (!r.ok)
      return failed(r.error)
    return { ok: true, snaps: r.exists ? r.snapshots : null }
  }

  /**
   * A target's snapshot NAMES re-read after a receive into it, for the hold
   * settle: ONE listing, as it always was (the receive answered whether the
   * dataset exists). cr3: a listing that failed says so — the callers carry it
   * as a warning — instead of reading as "no snapshots".
   */
  async function snapshotNamesAfterReceive(loc: TargetPlacement, targetFull: string) {
    if (loc.isRemote) {
      const resolved = loc.resolved
      return readRemoteSnapshotNames(cmd => transport.sshExec(resolved, cmd), targetFull, { afterReceive: true })
    }
    const r = await readLocalSnapshots(executor, targetFull)
    return r.ok && r.exists ? { ...r, snapshots: r.snapshots.map(x => x.snapshotName) } : r
  }

  // --- POST …/datasets/*path/replicate/plan — dry-run (read-only, 200) -----
  async function planReplication(poolName: string, path: string, request: FastifyRequest, reply: FastifyReply) {
    const source = resolveDatasetName(poolName, path, reply)
    if (!source)
      return reply

    const bodyParsed = ReplicatePlanRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid replicate plan request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { target, snapshot } = bodyParsed.data
    if (snapshot !== undefined && isTransientRunSnapshot(snapshot)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: namedTransientMessage(source, snapshot) } }
    }

    // Source must exist (system is the source of truth).
    if (!(await datasetExists(poolName, source))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${source}' not found` } }
    }

    // Stage 3: resolve where the target lives (local / peer / remote) and run
    // every target-side guard in THAT context.
    const targetFull = resolveTarget(source, poolName, target)
    const guard = await guardReplicationTarget(guardDeps, { target, sourceFull: source, targetFull })
    if (!guard.ok) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: guard.message } }
    }
    const loc = guard.placement

    // Pick the snapshot to send: explicit (must exist) or the newest source
    // snapshot that is not a backup/cloud run's transient (cr3).
    const src = await sourceSnapshots(source)
    if (!src.ok) {
      reply.code(src.status)
      return { error: { code: src.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE', message: src.message } }
    }
    const sourceSnaps = src.snaps
    const newest = newestReplicable(sourceSnaps)
    if (!newest && !snapshot) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Dataset '${source}' has no snapshots — create a snapshot first` } }
    }
    const snapName = snapshot ?? newest!.snapshotName
    if (snapshot && !sourceSnaps.some(s => s.snapshotName === snapshot)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${source}@${snapshot}' not found` } }
    }

    const tgt = await targetSnapshots(loc, target, targetFull)
    if (!tgt.ok) {
      reply.code(503)
      return { error: { code: 'UNAVAILABLE', message: tgt.message } }
    }
    const d = discover(sourceSnaps, tgt.snaps, snapName, { target: targetFull, where: whereLabel(target) })
    if (d.refusal !== undefined) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: d.refusal } }
    }

    // cr3 REPLICATION-M1: the target already has the snapshot — nothing would
    // be sent, so there is nothing to estimate. `mode` stays the schema's
    // required field ('incremental': nothing full is implied); `upToDate`
    // is the additive fact a panel reads.
    if (d.upToDate) {
      const plan: ReplicatePlan = {
        mode: 'incremental',
        snapshot: snapName,
        estimatedBytes: 0,
        targetExists: true,
        targetDiverged: false,
        upToDate: true,
      }
      return { data: plan }
    }

    // Estimate the stream size for the resolved mode (full when diverged, so the
    // UI can show the honest byte cost even though it must not offer the run).
    // The dry-run is always LOCAL — `zfs send -nvP` on the source side. cr.21:
    // `--` ends option parsing, so the snapshot operand (derived) can never be
    // read as a flag.
    const dryArgs = ['send', '-nvP']
    if (d.mode === 'incremental' && d.baseSnapshot)
      dryArgs.push('-i', `@${d.baseSnapshot}`)
    dryArgs.push('--', `${source}@${snapName}`)
    const dry = await executor.exec(ZFS, dryArgs)
    const estimatedBytes = parseSendDryRun(dry.stdout)

    const plan: ReplicatePlan = {
      mode: d.mode,
      snapshot: snapName,
      ...(d.baseSnapshot ? { baseSnapshot: d.baseSnapshot } : {}),
      estimatedBytes,
      targetExists: d.targetExists,
      targetDiverged: d.targetDiverged,
    }
    return { data: plan }
  }

  // --- POST …/datasets/*path/replicate — run (mutation, 202 job) -----------
  async function runReplication(poolName: string, path: string, request: FastifyRequest, reply: FastifyReply) {
    const source = resolveDatasetName(poolName, path, reply)
    if (!source)
      return reply

    const bodyParsed = ReplicateRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid replicate request: ${bodyParsed.error.issues[0]?.message}` } }
    }

    // R0: a request WITHOUT `recursive: true` falls straight through to the
    // single-dataset path below, untouched. The recursive branch is its own
    // function, so no line of today's run is shared with it.
    if (bodyParsed.data.recursive === true)
      return runRecursiveReplication(poolName, source, bodyParsed.data, request, reply)

    const { target, snapshot, snapshotFirst, notify: notifyMode } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // cr3 (the EPICS candidate "the single-dataset run's route-level refusals
    // send no notification"): a refusal AT THE ROUTE is a failed run to the
    // operator — a nightly task's runner meets it before any job exists — so
    // it notifies exactly as the job's catch does, as the recursive branch has
    // since rrep.2 (the request's mode decides, through notifyReplicationRun).
    // Before the guard the location is the one the request named.
    const requestedTarget = resolveTarget(source, poolName, target)
    const requestedRemote = target.location !== undefined && target.location.kind !== 'local'
    const notifyRefusal = (message: string): Promise<void> => notifyReplicationRun(executor, {
      source,
      target: requestedTarget,
      ...(requestedRemote && target.location ? { location: target.location } : {}),
      notify: notifyMode,
      error: message,
    })

    if (snapshot !== undefined && isTransientRunSnapshot(snapshot)) {
      const message = namedTransientMessage(source, snapshot)
      await notifyRefusal(message)
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message } }
    }

    if (!(await datasetExists(poolName, source))) {
      const message = `Dataset '${source}' not found`
      await notifyRefusal(message)
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message } }
    }

    // pvepool.1 review fixes: `snapshotFirst` creates a NEW snapshot on the
    // SOURCE before sending — a mutation, so an OWNED source refuses. The 400
    // here is the FAST PATH only (dialog feedback before a job exists); the
    // gate is the IN-JOB re-check immediately before `zfs snapshot` (the
    // fireSchedule pattern — review fix 4): the snapshot is taken in the job,
    // so the source is judged in the job, on a FRESH footprint with the
    // storage.cfg of THAT moment — a source PVE claimed after the request
    // fails the job with the reason (the 9.4 notification carries it), never
    // a snapshot. This is ALSO the run-time re-check for a recurring task:
    // the timer's runner (replicate-task.js) POSTs this same endpoint, so the
    // guard re-asks on every run. Sending PVE's own EXISTING snapshots (no
    // snapshotFirst) is a read and stays allowed. The target side is
    // re-asked on every run by guardReplicationTarget below.
    // ONE footprint load per request (review fix 4): this load feeds the 400
    // AND is passed to the guard, instead of the guard loading its own.
    const pve = snapshotFirst ? await deps.pveFootprint() : undefined
    if (pve) {
      const owned = pve.ownershipOf(source)
      if (owned) {
        // cr.47b: a snapshot door — the ownership fact answers 409 PVE_MANAGED
        // here as at every dataset door (a config-unreadable verdict keeps 400).
        const refusal = ownershipRefusal(owned, `Snapshot-first replication would snapshot '${source}' — ${owned.reason}`)
        await notifyRefusal(refusal.message)
        return sendRefusal(reply, refusal)
      }
    }

    // Stage 3: resolve where the target lives (local / peer / remote) and run
    // every target-side guard in THAT context.
    const targetFull = requestedTarget
    const guard = await guardReplicationTarget(
      pve ? { ...guardDeps, pveFootprintPreloaded: pve } : guardDeps,
      { target, sourceFull: source, targetFull },
    )
    if (!guard.ok) {
      await notifyRefusal(guard.message)
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: guard.message } }
    }
    const loc = guard.placement

    // 9.4 notification context. Built BEFORE the job so a run that dies early
    // still names source → target (and the peer/remote it was going to); the
    // run records the snapshot it settles on as soon as it knows it. The MODE
    // rides the request (a task's runner forwards its stored one; an interactive
    // replicate omits it and the schema defaults to 'on-failure').
    const notify: ReplicationNotifyContext = {
      source,
      target: targetFull,
      ...(loc.isRemote && target.location ? { location: target.location } : {}),
      notify: notifyMode,
    }

    // cr.33b (§4.3): the run holds a SHARED claim on its source dataset, so a
    // destroy, rename or rollback of the source accepted meanwhile waits for
    // the send ("waiting for zfs.replicate (job …)") and re-gates after it,
    // instead of pulling the dataset out from under the stream. Shared, so
    // snapshots of the source (and other sends from it) still run beside it.
    // cr.64b2-ii step 5 (§4.2): a LOCAL target holds its `zfs:` claim too —
    // the receive WRITES the target dataset, so the claim is EXCLUSIVE (the
    // table's write-side entry is "clone target": a full recv creates the
    // dataset, an incremental recv rewrites it). A destroy, rollback, rename
    // or snapshot of the target accepted meanwhile waits for the stream
    // ("waiting for zfs.replicate (job …)") instead of racing the recv, and
    // two replications into one target serialise. A peer/remote target is
    // not ours to lock — the key table is this node's. The guid read is the
    // dataset verbs' own fallback: an unread guid locks the pool's name key,
    // exclusive.
    const locks = await datasetSourceClaims(executor, [source])
    if (!loc.isRemote) {
      let targetGuid: string | null = null
      try {
        targetGuid = (await readPoolGuid(executor, target.pool))?.guid ?? null
      }
      catch {
        targetGuid = null
      }
      locks.push(...zfsDatasetClaims(targetGuid, targetFull, 'exclusive'))
    }

    const job = jobQueue.submit(
      'zfs.replicate',
      { ...identity, params: { source, target: targetFull, ...(loc.isRemote ? { location: target.location } : {}) } },
      async (updateProgress, ctx) => {
        // 9.4: this job is the ONE place every replication converges (a task
        // timer's runner and a UI replicate both submit it), so it is also the
        // one place a run notification is emitted — success, warning or failure,
        // gated by the run's own mode. Best-effort by contract:
        // notifyReplicationRun never throws, so a broken mail target cannot turn
        // a good replication into a failed job.
        const startedAt = Date.now()
        try {
          // cr.64b2-ii step 5: the TARGET guard runs again at the job's turn
          // (the same fireSchedule pattern as the snapshotFirst source check
          // below): the location may have been deregistered, the target pool
          // exported, or a LOCAL target moved under PVE — storage.cfg is live
          // — while the job waited behind the queue or the locks. The refusal
          // is the guard's own sentence, carried as a job failure (the 9.4
          // notification below reports it); nothing is sent and no snapshot
          // is taken. ONE fresh footprint load feeds this guard and the
          // snapshotFirst check (pvepool.1 review fix 4's rule, job-side).
          const pveNow = snapshotFirst || !loc.isRemote ? await deps.pveFootprint() : undefined
          const guardNow = await guardReplicationTarget(
            pveNow ? { ...guardDeps, pveFootprintPreloaded: pveNow } : guardDeps,
            { target, sourceFull: source, targetFull },
          )
          if (!guardNow.ok)
            throw new GuardRefusalError({ status: 409, code: 'STATE_CHANGED', message: guardNow.message })

          // 1) Optional snapshot-first — a fresh, sortable snapshot to send up
          //    to. repl.drift review D1 (rule: no precondition that can refuse
          //    runs after the first act): its NAME is chosen here and the
          //    snapshot is TAKEN only after every refusal below (the plan's
          //    own, the drift gate's), so a refused run leaves no snapshot
          //    behind. The plan is reasoned over the source listing with the
          //    new name in front: it is the newest by createtxg once taken,
          //    and decideBase picks the base among the snapshots OLDER than
          //    S, so the base does not depend on it.
          let snapName = snapshot
          let pendingSnapshot: string | undefined
          if (snapshotFirst) {
            // pvepool.1 review fix 4: the ownership gate moves WITH the
            // mutation. The snapshot is taken HERE, so the source is judged
            // HERE, on a FRESH footprint — storage.cfg is live and PVE can
            // claim the source between the request and now. An owned source
            // FAILS the job with the reason (the 9.4 notification carries
            // it); the request-level 400 is the fast path only, exactly the
            // fireSchedule pattern.
            // The job's fresh footprint — the SAME load the target-guard
            // re-check above just took (one fresh load per job run).
            const owned = pveNow!.ownershipOf(source)
            if (owned)
              throw new GuardRefusalError(ownershipRefusal(owned, `Snapshot-first replication refused: '${source}' is PVE-owned — ${owned.reason}`))
            pendingSnapshot = defaultSnapName()
            snapName = pendingSnapshot
          }

          // 2) Recompute the plan INSIDE the job — state may have changed since
          //    planning. Every read here fails CLOSED (cr3): a listing that did
          //    not answer stops the run with its own sentence.
          const src = await sourceSnapshots(source)
          if (!src.ok)
            throw new Error(src.message)
          const sourceSnaps = pendingSnapshot === undefined
            ? src.snaps
            : [{ snapshotName: pendingSnapshot } as Snapshot, ...src.snaps]
          if (!snapName) {
            // The newest snapshot that is not a backup/cloud run's transient
            // (cr3; the recursive run's S has always been filtered, R4).
            const newest = newestReplicable(sourceSnaps)
            if (!newest)
              throw new Error(`Dataset '${source}' has no snapshots — create a snapshot first`)
            snapName = newest.snapshotName
          }
          else if (!sourceSnaps.some(s => s.snapshotName === snapName)) {
            throw new Error(`Snapshot '${source}@${snapName}' does not exist on source`)
          }
          // A snapshot-first run names its snapshot in the notification only
          // once it exists (below): a refused run took none.
          if (pendingSnapshot === undefined)
            notify.snapshot = snapName
          // The chain's hold is never settled onto a transient: S here is
          // never one (the request refused a named one, the default skips
          // them, snapshot-first names its own) — said again where the hold
          // is decided, so no later path can make it one.
          if (isTransientRunSnapshot(snapName))
            throw new Error(namedTransientMessage(source, snapName))

          const tgt = await targetSnapshots(loc, target, targetFull)
          if (!tgt.ok)
            throw new Error(tgt.message)
          const d = discover(sourceSnaps, tgt.snaps, snapName, { target: targetFull, where: whereLabel(target) })
          // review of cr3: "diverged" only when NOTHING is in common; any
          // other no-base state refuses with a sentence naming what is.
          if (d.targetDiverged)
            throw new Error(divergedMessage(targetFull))
          if (d.refusal !== undefined)
            throw new Error(d.refusal)
          // The new name already on the target (a millisecond-resolution
          // name, so only by hand): the run would have nothing to send from a
          // snapshot it has not taken. Refused before anything is taken.
          if (pendingSnapshot !== undefined && d.upToDate)
            throw new Error(`Target '${targetFull}'${whereLabel(target)} already has a snapshot named '@${pendingSnapshot}', the name this run gives its new snapshot of '${source}': no snapshot was taken and nothing was sent; run it again`)

          const holdTag = replicationHoldTag(target.location, targetFull)
          const sourceNames = sourceSnaps.map(s => s.snapshotName)
          const targetNamesBefore = (tgt.snaps ?? []).map(s => s.snapshotName)

          // repl.drift: has the target been changed since the snapshot the
          // receive starts from (`written@<base>`), and is it still
          // read-only? ONE read, before anything is sent. The base is the one
          // decideBase picked (for an up-to-date target, the one the next
          // incremental starts from) — a transient base included, so the
          // rule-2 exception is judged against what ZFS will actually check.
          const driftBase = d.upToDate
            ? nextIncrementalBase(sourceNames, targetNamesBefore)
            : d.mode === 'incremental' ? d.baseSnapshot : undefined
          const checkDrift = driftBase === undefined
            ? undefined
            : (holdActs?: SettleActs) => checkTargetDrift(targetZfs(loc), {
                target: targetFull,
                where: whereLabel(target),
                base: driftBase,
                targetSnaps: targetNamesBefore,
                sends: !d.upToDate,
                readHeld: baseHeld(loc, source, targetFull, driftBase, holdTag),
                ...(holdActs ? { holdActs } : {}),
              })

          // cr3 REPLICATION-M1: the target already has S — nothing is sent.
          // When S is the newest snapshot the two sides share, its holds are
          // settled exactly as the recursive run settles a copy already at S
          // (a stopped earlier run may have received it and not held it); when
          // the target already has a NEWER one, nothing is touched — the
          // chain's hold never moves back.
          if (d.upToDate) {
            const warnings: string[] = []
            let note: string | undefined
            // Review D2: what the settle below changes, so a drift sentence
            // read after it says what this run did to the holds.
            const holdActs: SettleActs = { placed: [], released: [] }
            if (d.keepHoldsOn !== undefined) {
              // review of cr3 (decideBase rule 1): the target's newest
              // snapshot is a transient the source still has; the next new
              // snapshot is sent from it, so the holds stay as they are.
              // review 3 of cr3: "sent from it" is only true while the source
              // keeps it — when no hold of this chain pins it there, the run
              // that took it may destroy it first, and the next run then
              // sends from '@S' (ZFS accepts that while the target is
              // unmodified since its newest snapshot).
              // cr4: `readLocalHoldsChecked` never rejects (it answers null on
              // a failed read), so there is no `.catch` — and null is NOT "not
              // held": a read that could not see must not say the source may
              // lose the snapshot, nor that it may not.
              const pinnedSnap = `${source}@${d.keepHoldsOn}`
              const pinned = await readLocalHoldsChecked(executor, [pinnedSnap])
              const isHeld = pinned?.get(pinnedSnap)?.includes(holdTag) === true
              const lead = `The target's newest snapshot is '@${d.keepHoldsOn}', a backup or cloud run's snapshot the source still has: nothing was sent and the holds were left as they are`
              if (pinned === null)
                note = `${lead}. The holds on '${pinnedSnap}' could not be read, so ANAS cannot say whether it is protected; check with: zfs holds ${pinnedSnap}`
              else if (isHeld)
                note = `${lead}, and the next new snapshot is sent from it`
              else
                note = `${lead}; the next new snapshot is sent from it only while the source still has it — it is not held there, so the run that took it may destroy it first, and the run then sends from '@${snapName}'`
            }
            else if (d.newerCommon === undefined) {
              try {
                warnings.push(...await settleReplicationHolds({ executor, transport }, {
                  tag: holdTag,
                  snapName,
                  source: { dataset: source, snapshotNames: sourceNames },
                  target: { dataset: targetFull, snapshotNames: (tgt.snaps ?? []).map(s => s.snapshotName) },
                  ...(loc.isRemote ? { remote: loc.resolved } : {}),
                  releaseLegacyOnSource: false,
                  done: holdActs,
                }))
              }
              catch (err) {
                warnings.push(`holds could not be settled — ${err instanceof Error ? err.message : String(err)}`)
              }
            }
            else {
              note = `The target already has '@${d.newerCommon}', which is newer than '@${snapName}': nothing was sent and no hold was moved`
            }
            // repl.drift, the proactive case: nothing to send today, but the
            // NEXT send would be refused (`modified`) or is one touch away
            // from it (`exposed`): said now, as a warning, so the run's
            // notification carries it. Asked after the settle above, so the
            // sentence states the holds as they now are, and (review D2) its
            // first clause says what the settle moved, when it moved any.
            const drift = checkDrift ? await checkDrift(holdActs) : undefined
            if (drift && (drift.state === 'modified' || drift.state === 'exposed'))
              warnings.push(drift.message!)
            if (drift?.state === 'unknown')
              note = joinNotes(note, drift.message)
            const upRecord = drift ? recordOf(drift) : null
            const result = {
              snapshot: snapName,
              bytesEstimated: 0,
              target: targetFull,
              holdTag,
              upToDate: [source],
              ...(note ? { note } : {}),
              ...(warnings.length ? { warnings } : {}),
              // repl.drift: recorded for the dashboard (the runner's result line).
              ...(upRecord ? { targetDrift: [upRecord] } : {}),
            }
            await notifyReplicationRun(executor, { ...notify, result, elapsedMs: Date.now() - startedAt })
            return result
          }

          // repl.drift: a target changed since the base is refused by ZFS —
          // the run does not send; it fails with the drift sentence (the
          // catch below notifies once). Nothing is held or released. An
          // `exposed` target is sent to (ZFS accepts: nothing changed) and
          // the run warns; `unknown` goes ahead and ZFS decides.
          const drift = checkDrift ? await checkDrift() : undefined
          if (drift?.state === 'modified') {
            // Recorded on the job (its detail), so the runner's journal line
            // carries it for the dashboard, which never reads a remote.
            ctx?.updateDetail({ targetDrift: [recordOf(drift)] })
            throw new Error(drift.message)
          }

          // D1: every refusal is behind us — the snapshot-first snapshot is
          // taken now, the run's first act. The ONE zfs-snapshot verb
          // (backup2.3's extraction) — same argv, same error text.
          if (pendingSnapshot !== undefined) {
            updateProgress(`zfs snapshot ${source}@${pendingSnapshot}`)
            await createZfsSnapshot(executor, { dataset: source, name: pendingSnapshot })
            notify.snapshot = pendingSnapshot
          }
          // An exposed target is sealed by this run's receive (ruling 1): not recorded.
          const sentRecord = drift ? recordOf(drift, { sealed: true }) : null
          const driftWarning = drift?.state === 'exposed' ? drift.message : undefined
          const driftNote = drift?.state === 'unknown'
            ? `${drift.message}; the send went ahead, and ZFS refuses it if the target was changed`
            : undefined

          const srcSnapFull = `${source}@${snapName}`

          // 3) Estimate bytes (best-effort) for the job result — always a LOCAL dry-run.
          const dryArgs = ['send', '-nvP']
          if (d.mode === 'incremental' && d.baseSnapshot)
            dryArgs.push('-i', `@${d.baseSnapshot}`)
          dryArgs.push('--', srcSnapFull)
          const dry = await executor.exec(ZFS, dryArgs)
          const bytesEstimated = parseSendDryRun(dry.stdout)

          // 4) Run the send|recv pipeline. EVERY receive, full or incremental,
          //    passes `-o readonly=on` (ruling 1, operator 2026-11-15: a
          //    replication task keeps its target read-only; to use the copy as
          //    a live dataset, remove the task). Ground truth 2026-11-15 (ZFS
          //    2.4.2, fixtures/zfs/zfs-written-replica.zfs2.4.2.txt, third
          //    capture B and C): `zfs recv -o readonly=on` on an incremental
          //    stream exits 0 and sets the property `local`, so a replica made
          //    writable by hand (repl.drift's `exposed`) is sealed by the next
          //    send. A ZFS that refuses `-o` there fails the run with its own
          //    line (`pipelineFailureDetail`). For a remote/
          //    peer target the recv side runs over ssh (`… | ssh <host> zfs recv`);
          //    for a local target it is a second local `zfs` process.
          // cr.21: `--` ends zfs option parsing so srcSnapFull (derived) is
          // always the positional source, never mistaken for a flag.
          const sendArgs = d.mode === 'incremental' && d.baseSnapshot
            ? ['send', '-i', `@${d.baseSnapshot}`, '--', srcSnapFull]
            : ['send', '--', srcSnapFull]
          // `--` ends zfs option parsing so `targetFull` is always the positional
          // filesystem, never mistaken for a flag (defence in depth; the schema
          // already restricts the dataset charset).
          const recvArgs = ['recv', '-o', 'readonly=on', '--', targetFull]

          let recvCmd = ZFS
          let recvArgv = recvArgs
          if (loc.isRemote) {
            const argv = transport.buildSshArgv(loc.resolved, [ZFS_REMOTE, ...recvArgs])
            recvCmd = argv[0]
            recvArgv = argv.slice(1)
          }

          updateProgress(`zfs send ${srcSnapFull} | zfs recv ${targetFull}`)
          // cr.34: a data mover — hours for a large send; no deadline. A dead
          // ssh peer is cr.35's (ServerAlive*/ConnectTimeout on the argv).
          const pipe = await executor.pipeline(ZFS, sendArgs, recvCmd, recvArgv, { timeoutMs: null, longRunning: 'zfs send | zfs recv: a data mover, hours for a large send' })
          if (pipe.leftExitCode !== 0 || pipe.rightExitCode !== 0) {
            // review 3 of cr3: ZFS's "has been modified since most recent
            // snapshot" gets the rollback hint ADDED; the raw stderr stays.
            const hint = modifiedTargetHint(pipe.rightStderr, targetFull, d.baseSnapshot, (tgt.snaps ?? []).map(s => s.snapshotName))
            throw new Error(`Replication failed — ${pipelineFailureDetail(pipe)}${hint ? ` — ${hint}` : ''}`)
          }

          // 5) Hold the new base on BOTH sides under THIS chain's tag, release
          //    this chain's tag on older snapshots, and migrate the legacy
          //    global tag (story ident.4 (a), audit #13 — services/
          //    replication-holds.ts). The SOURCE is always local; the TARGET
          //    side goes over ssh for a peer/remote. Fail-open: hiccups are
          //    warnings, not job failures.
          // Re-read the target's snapshots — the recv just added snapName
          // there. A re-read that fails is a warning (cr3), never "the target
          // has no snapshots": the settle then holds S and releases nothing
          // on the target, so its older holds stay.
          const targetRead = await snapshotNamesAfterReceive(loc, targetFull)
          const reReadWarning = targetRead.ok ? null : `Could not list the snapshots of target '${targetFull}'${whereLabel(target)} after the receive: ${targetRead.error} — the chain's older holds on the target were kept`
          const targetNames = targetRead.ok && targetRead.exists ? targetRead.snapshots : []
          const legacy = await legacyReleasableOnSource(executor, {
            sourceFull: source,
            ownTag: holdTag,
            sourceSnapshotNames: sourceNames,
            ...(deps.systemdDir ? { systemdDir: deps.systemdDir } : {}),
          })
          const holdWarnings = await settleReplicationHolds({ executor, transport }, {
            tag: holdTag,
            snapName,
            ...(d.baseSnapshot ? { baseSnapshot: d.baseSnapshot } : {}),
            source: { dataset: source, snapshotNames: sourceNames },
            target: { dataset: targetFull, snapshotNames: targetNames },
            ...(loc.isRemote ? { remote: loc.resolved } : {}),
            releaseLegacyOnSource: legacy.releasable,
          })
          const warnings = [
            ...(driftWarning ? [driftWarning] : []),
            ...holdWarnings,
            ...(legacy.warning ? [legacy.warning] : []),
            ...(reReadWarning ? [reReadWarning] : []),
          ]

          const result = {
            mode: d.mode,
            snapshot: snapName,
            ...(d.baseSnapshot ? { baseSnapshot: d.baseSnapshot } : {}),
            bytesEstimated,
            target: targetFull,
            holdTag,
            ...(driftNote ? { note: driftNote } : {}),
            ...(warnings.length ? { warnings } : {}),
            ...(sentRecord ? { targetDrift: [sentRecord] } : {}),
          }
          await notifyReplicationRun(executor, { ...notify, result, elapsedMs: Date.now() - startedAt })
          return result
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await notifyReplicationRun(executor, { ...notify, error: message, elapsedMs: Date.now() - startedAt })
          throw err
        }
      },
      // cr.33 (§4.3): a data mover rides the long lane (at most 3 of the 4 slots).
      { lane: 'long', locks },
    )

    reply.code(202)
    return { job }
  }

  /**
   * repl.drift: the recursive gate's access to the target — the same runner
   * as the single run, and the holds of a copy's base under the run's ONE tag
   * (R7: derived from the target root).
   */
  function treeDriftDeps(loc: TargetPlacement, target: ReplicateRequestBody['target'], targetRoot: string) {
    const tag = replicationHoldTag(target.location, targetRoot)
    return {
      runTarget: targetZfs(loc),
      where: whereLabel(target),
      readHeld: (dataset: string, targetDs: string, base: string) => baseHeld(loc, dataset, targetDs, base, tag)(),
    }
  }

  /**
   * The gate's refusals as the route answers them: joined into ONE sentence;
   * an ownership verdict answers through the single-dataset door's own shape
   * (409 PVE_MANAGED, or 400 when storage.cfg is unreadable), because the fact
   * stated is PVE's territory, not a malformed request.
   */
  function refuseTreeGate(reply: FastifyReply, refusals: TreeGateRefusal[]): ReturnType<typeof sendRefusal> | { error: { code: 'VALIDATION_ERROR', message: string } } {
    const message = refusals.map(r => r.message).join('; ')
    const ownership = refusals.find(r => r.ownership !== undefined)?.ownership
    if (ownership)
      return sendRefusal(reply, ownershipRefusal(ownership, message))
    reply.code(400)
    return { error: { code: 'VALIDATION_ERROR', message } }
  }

  /**
   * The RECURSIVE run (rrep.1b, #84, R1/R5–R9): read the tree, gate it, then
   * one today's-shape `zfs send | zfs recv` per planned dataset in sweep order.
   *
   * Nothing here is shared with the single-dataset path (R0): the reads, the
   * gates, the loop and the result are this function's. What it does reuse are
   * the ONE helpers — the planner, the fact reader, the target guard, the hold
   * settle — so the two paths cannot drift.
   */
  async function runRecursiveReplication(
    poolName: string,
    source: string,
    body: ReplicateRequestBody,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const { target, snapshot, notify: notifyMode } = body
    const exclude = body.exclude ?? []

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // 1. The source exists, and the ROOT target pair passes today's guard
    //    (location resolution, target pool exists, PVE ownership of the root,
    //    onto-itself).
    // rrep.2 fold N1 (ruled): a refusal AT THE ROUTE is a failed run to the
    // operator — a nightly task's runner meets it before any job exists, so
    // it notifies exactly as the job's catch does (the request's mode
    // decides, through notifyReplicationRun), then answers as before. That
    // covers the two refusals below too: a source that was destroyed, and a
    // root target guard that refuses (a deregistered remote, an exported
    // target pool) are the commonest ways a nightly task stops working, and
    // they come before the placement is known — the notification then names
    // the location as the request gave it.
    const targetRoot = resolveTarget(source, poolName, target)
    const requestedRemote = target.location !== undefined && target.location.kind !== 'local'
    let notify: ReplicationNotifyContext = {
      source,
      target: targetRoot,
      ...(requestedRemote && target.location ? { location: target.location } : {}),
      notify: notifyMode,
    }
    const notifyRefusal = (message: string): Promise<void> =>
      notifyReplicationRun(executor, { ...notify, error: message })

    if (!(await datasetExists(poolName, source))) {
      const message = `Dataset '${source}' not found`
      await notifyRefusal(message)
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message } }
    }
    const guard = await guardReplicationTarget(guardDeps, { target, sourceFull: source, targetFull: targetRoot })
    if (!guard.ok) {
      await notifyRefusal(guard.message)
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: guard.message } }
    }
    const loc = guard.placement
    notify = {
      source,
      target: targetRoot,
      ...(loc.isRemote && target.location ? { location: target.location } : {}),
      notify: notifyMode,
    }

    // 2. R4: one snapshot name across the tree — the root's newest, chosen by
    //    the planner. A named snapshot is a single-dataset concept.
    if (snapshot !== undefined) {
      const message = 'Recursive replication sends the newest snapshot of the source across the tree — it cannot be combined with a named snapshot'
      await notifyRefusal(message)
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message } }
    }

    // 3. Every fact first, then every gate, on ONE fresh footprint. A read that
    //    did not answer refuses here (fail-closed); nothing has been sent.
    const pve = await deps.pveFootprint()
    const read = await readTreeFacts({ executor, transport }, { sourceRoot: source, targetRoot, exclude, placement: loc })
    if (!read.ok) {
      await notifyRefusal(read.message)
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: read.message } }
    }
    // repl.drift: the drift is judged in the JOB only (a changed copy fails
    // the job, which records it for the dashboard); the request's pass skips
    // those reads.
    const gate = await gateTreeRun({ pve, guard: guardDeps }, { facts: read.facts, target })
    if (!gate.ok) {
      await notifyRefusal(gate.refusals.map(r => r.message).join('; '))
      return refuseTreeGate(reply, gate.refusals)
    }

    // 4. R9: a shared claim on EVERY swept dataset (the run reads them all),
    //    plus today's EXCLUSIVE claim on a LOCAL target root (the recv writes
    //    the tree below it). A peer/remote target is not ours to lock.
    const sweepAtRoute = gate.sweep
    const locks = await datasetSourceClaims(executor, sweepAtRoute)
    if (!loc.isRemote) {
      let targetGuid: string | null = null
      try {
        targetGuid = (await readPoolGuid(executor, target.pool))?.guid ?? null
      }
      catch {
        targetGuid = null
      }
      locks.push(...zfsDatasetClaims(targetGuid, targetRoot, 'exclusive'))
    }

    const job = jobQueue.submit(
      'zfs.replicate',
      { ...identity, params: { source, target: targetRoot, recursive: true, ...(loc.isRemote ? { location: target.location } : {}) } },
      async (updateProgress, ctx) => {
        const startedAt = Date.now()
        // R7: ONE tag for the whole run, derived from the ROOT's target name —
        // so a refused destroy of any child names the task that owns the tree.
        const holdTag = replicationHoldTag(target.location, targetRoot)
        try {
          // 1. Re-run the ROOT guard, the reads and every gate on a FRESH
          //    footprint (ruling (j): the route's listing is not trusted). A
          //    refusal fails the job as STATE_CHANGED and NOTHING is sent.
          const pveNow = await deps.pveFootprint()
          const guardNow = await guardReplicationTarget(
            { ...guardDeps, pveFootprintPreloaded: pveNow },
            { target, sourceFull: source, targetFull: targetRoot },
          )
          if (!guardNow.ok)
            throw new GuardRefusalError({ status: 409, code: 'STATE_CHANGED', message: guardNow.message })
          const jobLoc = guardNow.placement

          const factsNow = await readTreeFacts({ executor, transport }, { sourceRoot: source, targetRoot, exclude, placement: jobLoc })
          if (!factsNow.ok)
            throw new GuardRefusalError({ status: 409, code: 'STATE_CHANGED', message: factsNow.message })
          const gateNow = await gateTreeRun({ pve: pveNow, guard: guardDeps, drift: treeDriftDeps(jobLoc, target, targetRoot) }, { facts: factsNow.facts, target })
          if (!gateNow.ok) {
            const message = gateNow.refusals.map(r => r.message).join('; ')
            // repl.drift: a changed copy is a failed run (recorded on the
            // job for the dashboard), not a state that changed under it.
            if (gateNow.driftRecords?.length) {
              ctx?.updateDetail({ targetDrift: gateNow.driftRecords })
              throw new Error(message)
            }
            throw new GuardRefusalError({ status: 409, code: 'STATE_CHANGED', message })
          }
          // cr3 REPLICATION-L4 (R9): the claims were taken on the ROUTE's
          // sweep. A dataset the job's fresh sweep finds that the route's did
          // not (a child created while the run waited) is not claimed by this
          // run — a destroy or rename of it would not wait for the send — so
          // the run refuses before the first send; the next run claims it.
          const claimed = new Set(sweepAtRoute)
          const unclaimed = gateNow.sweep.filter(dataset => !claimed.has(dataset))
          if (unclaimed.length > 0) {
            throw new GuardRefusalError({
              status: 409,
              code: 'STATE_CHANGED',
              message: `The tree under '${source}' changed after the run was accepted: ${unclaimed.map(d => `'${d}'`).join(', ')} ${unclaimed.length === 1 ? 'is' : 'are'} not claimed by this run — nothing was sent; run it again`,
            })
          }

          const plan = gateNow.plan
          const facts = factsNow.facts
          notify.snapshot = plan.snapshot
          const targetFor = (dataset: string): string => treeTargetName(source, targetRoot, dataset)
          const warnings: string[] = []

          // 2. Copies already AT S get their holds settled first, with no
          //    base: a stopped earlier run may have received a dataset and
          //    failed to hold it. `settleReplicationHolds` tolerates a hold
          //    already present, and it is asked for no legacy release here —
          //    nothing was sent for this dataset this run.
          for (const dataset of plan.upToDate) {
            // review of cr3 (decideBase rule 1, the single-dataset run's
            // rule): a copy whose newest snapshot is a transient the source
            // still has keeps its holds; the next send starts from it.
            if (plan.holdsKept?.includes(dataset))
              continue
            const tgt = targetFor(dataset)
            // A settle that THROWS (a spawn failure, a deadline) is a warning
            // here as it is after a receive: nothing was sent for this
            // dataset, its copy is intact, and failing the whole run on it
            // would stop every dataset behind it on every retry (verification
            // of the rrep.1b fold).
            try {
              const holdWarnings = await settleReplicationHolds({ executor, transport }, {
                tag: holdTag,
                snapName: plan.snapshot,
                source: { dataset, snapshotNames: facts.sourceSnaps.get(dataset) ?? [] },
                target: { dataset: tgt, snapshotNames: facts.targetSnaps.get(tgt) ?? [] },
                ...(jobLoc.isRemote ? { remote: jobLoc.resolved } : {}),
                releaseLegacyOnSource: false,
              })
              warnings.push(...holdWarnings.map(w => `${dataset}: ${w}`))
            }
            catch (err) {
              warnings.push(`${dataset}: holds could not be settled — ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          // 3. R6: sends in sweep order, stopping at the first failure. Nothing
          //    is rolled back; the next run continues from each dataset's own
          //    base (a copy that already holds S is up to date).
          const sent: string[] = []
          const datasets: { dataset: string, target: string, mode: 'full' | 'incremental', baseSnapshot?: string, bytesEstimated: number }[] = []
          let bytesEstimated = 0
          let anyFull = false
          let legacySettled = false
          for (const planned of plan.datasets) {
            const srcSnapFull = `${planned.dataset}@${plan.snapshot}`

            // The estimate is best-effort, exactly as the single-dataset run's.
            const dryArgs = ['send', '-nvP']
            if (planned.mode === 'incremental' && planned.baseSnapshot)
              dryArgs.push('-i', `@${planned.baseSnapshot}`)
            dryArgs.push('--', srcSnapFull)
            // Best-effort means a THROW too (a spawn failure, a deadline):
            // the estimate is 0 and the send decides. It must never end the
            // run with a bare error that names no dataset (verification of
            // the rrep.1b fold; R6's sentence belongs to the send).
            let datasetBytes = 0
            try {
              const dry = await executor.exec(ZFS, dryArgs)
              datasetBytes = parseSendDryRun(dry.stdout)
            }
            catch {
              datasetBytes = 0
            }
            bytesEstimated += datasetBytes
            if (planned.mode === 'full')
              anyFull = true

            // R1: today's argv, per dataset — never -R, -p, -F, -w, -I.
            const sendArgs = planned.mode === 'incremental' && planned.baseSnapshot
              ? ['send', '-i', `@${planned.baseSnapshot}`, '--', srcSnapFull]
              : ['send', '--', srcSnapFull]
            // Ruling 1: every receive, full or incremental, re-asserts read-only.
            const recvArgs = ['recv', '-o', 'readonly=on', '--', planned.target]
            let recvCmd = ZFS
            let recvArgv = recvArgs
            if (jobLoc.isRemote) {
              const argv = transport.buildSshArgv(jobLoc.resolved, [ZFS_REMOTE, ...recvArgs])
              recvCmd = argv[0]
              recvArgv = argv.slice(1)
            }

            updateProgress(`zfs send ${srcSnapFull} | zfs recv ${planned.target}`)
            // R6's sentence covers BOTH failure shapes (fold 4, review B8):
            // the executor REJECTS on a spawn failure (ENOENT/EACCES/EAGAIN)
            // and RESOLVES with a non-zero exit otherwise — a throw used to
            // escape as a bare `spawn EAGAIN`, naming no dataset and no
            // already-sent list. One sentence builder for both branches.
            const r6Sentence = (detail: string): string =>
              `Replication failed at '${planned.dataset}' — ${detail}; already sent this run: ${sent.join(', ') || 'nothing'}; the next run continues from each dataset's own base`
            let pipe: PipelineResult
            try {
              pipe = await executor.pipeline(ZFS, sendArgs, recvCmd, recvArgv, { timeoutMs: null, longRunning: 'zfs send | zfs recv: a data mover, hours for a large send' })
            }
            catch (err) {
              throw new Error(r6Sentence(err instanceof Error ? err.message : String(err)))
            }
            if (pipe.leftExitCode !== 0 || pipe.rightExitCode !== 0) {
              // review 3 of cr3: the same rollback hint as the single path.
              const hint = modifiedTargetHint(pipe.rightStderr, planned.target, planned.baseSnapshot, facts.targetSnaps.get(planned.target) ?? [])
              throw new Error(r6Sentence(`${pipelineFailureDetail(pipe)}${hint ? ` — ${hint}` : ''}`))
            }
            sent.push(planned.dataset)
            datasets.push({
              dataset: planned.dataset,
              target: planned.target,
              mode: planned.mode,
              ...(planned.baseSnapshot ? { baseSnapshot: planned.baseSnapshot } : {}),
              bytesEstimated: datasetBytes,
            })

            // 4. R7: settle THIS dataset's holds under the run's one tag. The
            //    target's snapshot names are re-read after the receive, as the
            //    single-dataset run does (that read stays fail-open, as today).
            //    Nothing in this block is a SEND (fold 4, review B8): the
            //    stream already landed, so a throw here — settleReplicationHolds
            //    runs unguarded exec, which rejects on a spawn failure — is a
            //    warning, never R6's sentence. The next run re-settles the
            //    holds and continues from each dataset's own base regardless.
            try {
              // cr3: a re-read that fails is a warning, never "the copy has
              // no snapshots" — the settle then holds S and releases nothing
              // on the target, so its older holds stay.
              const reRead = await snapshotNamesAfterReceive(jobLoc, planned.target)
              const targetNames = reRead.ok && reRead.exists ? reRead.snapshots : []
              if (!reRead.ok)
                warnings.push(`${planned.dataset}: could not list the snapshots of '${planned.target}' after the receive: ${reRead.error} — the chain's older holds on it were kept`)
              let releaseLegacy = false
              if (planned.dataset === source && !legacySettled) {
                legacySettled = true
                const legacy = await legacyReleasableOnSource(executor, {
                  sourceFull: source,
                  ownTag: holdTag,
                  sourceSnapshotNames: facts.sourceSnaps.get(source) ?? [],
                  ...(deps.systemdDir ? { systemdDir: deps.systemdDir } : {}),
                })
                releaseLegacy = legacy.releasable
                if (legacy.warning)
                  warnings.push(legacy.warning)
              }
              const holdWarnings = await settleReplicationHolds({ executor, transport }, {
                tag: holdTag,
                snapName: plan.snapshot,
                ...(planned.baseSnapshot ? { baseSnapshot: planned.baseSnapshot } : {}),
                source: { dataset: planned.dataset, snapshotNames: facts.sourceSnaps.get(planned.dataset) ?? [] },
                target: { dataset: planned.target, snapshotNames: targetNames },
                ...(jobLoc.isRemote ? { remote: jobLoc.resolved } : {}),
                releaseLegacyOnSource: releaseLegacy,
              })
              warnings.push(...holdWarnings.map(w => `${planned.dataset}: ${w}`))
            }
            catch (err) {
              warnings.push(`${planned.dataset}: holds could not be settled — ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          // 5. A skipped dataset is a warning (the operator must know it was
          //    left out), never a refusal — R5d's "no entry, no plan" case.
          for (const skipped of plan.skipped)
            warnings.push(skipped.message)
          // repl.drift: a copy that is not read-only was sent to (ZFS
          // accepted it: nothing had changed) and the run warns, every run
          // while it lasts; a copy whose state could not be read is noted.
          warnings.push(...gateNow.driftWarnings)
          const driftNote = gateNow.driftNotes.length > 0 ? gateNow.driftNotes.join('; ') : undefined

          const result = {
            recursive: true as const,
            // The run's mode: full if ANY dataset needed a full send, else
            // incremental. With NOTHING sent the field is omitted (fold 5,
            // review J) — a mode would describe a send that never happened,
            // and the notification's Mode line follows the field.
            ...(datasets.length > 0 ? { mode: anyFull ? 'full' as const : 'incremental' as const } : {}),
            snapshot: plan.snapshot,
            target: targetRoot,
            holdTag,
            datasets,
            upToDate: plan.upToDate,
            ...(plan.holdsKept ? { holdsKept: plan.holdsKept } : {}),
            skipped: plan.skipped.map(s => s.dataset),
            targetOnly: plan.targetOnly,
            // Fold E1: exclude entries the source no longer holds are inert —
            // listed as a NOTE (never a warning, no notification change), and
            // only when there is one.
            ...(gateNow.excludeMissing.length > 0 ? { excludeMissing: gateNow.excludeMissing } : {}),
            bytesEstimated,
            ...(driftNote ? { note: driftNote } : {}),
            ...(gateNow.driftRecords.length > 0 ? { targetDrift: gateNow.driftRecords } : {}),
            ...(warnings.length ? { warnings } : {}),
          }
          await notifyReplicationRun(executor, { ...notify, result, elapsedMs: Date.now() - startedAt })
          return result
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await notifyReplicationRun(executor, { ...notify, error: message, elapsedMs: Date.now() - startedAt })
          throw err
        }
      },
      { lane: 'long', locks },
    )

    reply.code(202)
    return { job }
  }

  return { planReplication, runReplication }
}
