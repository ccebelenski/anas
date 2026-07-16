import type { ReplicatePlan, Snapshot } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import { ReplicatePlanRequest, ReplicateRequest } from '@anas/shared'
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
 * is created `readonly=on`. A `zfs hold` (tag `anas-repl`) pins the replicated
 * base on BOTH sides so cleanup cannot sever the chain, and older holds are
 * released so exactly the newest base stays held. journald is forensics.
 */

const ZFS = '/usr/sbin/zfs'
const HOLD_TAG = 'anas-repl'

/** Dependencies handed in from datasetRoutes — its executor, queue, and the
 *  small dataset helper closures we reuse rather than duplicate. */
export interface ReplicationDeps {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** Resolve pool + wildcard tail → full dataset name (empty tail = pool root);
   *  sends a 400 and returns null on an invalid path. */
  resolveDatasetName: (poolName: string, datasetPath: string, reply: FastifyReply) => string | null
  poolExists: (poolName: string) => Promise<boolean>
  datasetExists: (poolName: string, fullName: string) => Promise<boolean>
  /** A dataset's snapshots, newest-first (empty when it has none). */
  listSnapshotsDetail: (fullName: string) => Promise<Snapshot[]>
  /** Story 3.25 boundary guard: is the pool PVE-managed (referenced by
   *  /etc/pve/storage.cfg)? Replicating INTO PVE territory would create a
   *  dataset there, which ANAS never does. Fail-open: detection failure /
   *  non-PVE host → false. */
  isPveManagedPool: (poolName: string) => Promise<boolean>
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
    const n = Number.parseInt(parts[parts.length - 1], 10)
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
  const targetRel = target.dataset ?? (sourceRel || sourcePool)
  return `${target.pool}/${targetRel}`
}

/** The base part of a discovered replication plan (shared by plan + run). */
interface Discovered {
  mode: 'full' | 'incremental'
  snapshot: string
  baseSnapshot?: string
  targetExists: boolean
  targetDiverged: boolean
}

/**
 * Decide full vs incremental from live ZFS state. The base is the NEWEST source
 * snapshot older than `snapshot` (in creation order) that also exists on the
 * target. Target absent → full. Target present but no common base → diverged
 * (reported as a full send whose bytes we still estimate; stage 1 cannot run it).
 */
function discover(sourceSnaps: Snapshot[], targetSnaps: Snapshot[] | null, snapshot: string): Discovered {
  if (targetSnaps === null)
    return { mode: 'full', snapshot, targetExists: false, targetDiverged: false }

  const targetNames = new Set(targetSnaps.map(s => s.snapshotName))
  // sourceSnaps is newest-first; snapshots OLDER than `snapshot` are the ones
  // after it in the list — a valid `-i` base must be older than what we send.
  const snapIdx = sourceSnaps.findIndex(s => s.snapshotName === snapshot)
  const older = snapIdx === -1 ? [] : sourceSnaps.slice(snapIdx + 1)
  const common = older.find(s => targetNames.has(s.snapshotName))
  if (common)
    return { mode: 'incremental', snapshot, baseSnapshot: common.snapshotName, targetExists: true, targetDiverged: false }
  // Target exists but shares no common base → divergence (out of stage-1 scope).
  return { mode: 'full', snapshot, targetExists: true, targetDiverged: true }
}

/** Sortable, ZFS-legal default snapshot name for the snapshot-first convenience. */
function defaultSnapName(): string {
  return `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}`
}

/** `zfs holds -H <snap>` → the set of tag names currently held (fail-open). */
async function heldTags(executor: CommandExecutor, snapFull: string): Promise<string[]> {
  const r = await executor.exec(ZFS, ['holds', '-H', snapFull])
  if (r.exitCode !== 0 || !r.stdout.trim())
    return []
  // Tab-separated: <snapshot>\t<tag>\t<timestamp>.
  return r.stdout.split('\n').filter(Boolean).map(l => l.split('\t')[1]).filter(Boolean)
}

export function createReplicationHandlers(deps: ReplicationDeps) {
  const { executor, jobQueue, resolveDatasetName, poolExists, datasetExists, listSnapshotsDetail } = deps

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

    // Source must exist (system is the source of truth).
    if (!(await datasetExists(poolName, source))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${source}' not found` } }
    }

    // The target POOL must exist — we replicate into an existing pool, never create one.
    if (!(await poolExists(target.pool))) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' does not exist` } }
    }
    // Story 3.25: never create datasets on a PVE-managed pool — reject it as a
    // replication target at the API boundary too (the UI already excludes it).
    if (await deps.isPveManagedPool(target.pool)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' is PVE-managed — ANAS does not create datasets there` } }
    }

    const targetFull = resolveTarget(source, poolName, target)

    // Pick the snapshot to send: explicit (must exist) or the newest source snapshot.
    const sourceSnaps = await listSnapshotsDetail(source)
    if (sourceSnaps.length === 0) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Dataset '${source}' has no snapshots — create a snapshot first` } }
    }
    const snapName = snapshot ?? sourceSnaps[0].snapshotName
    if (snapshot && !sourceSnaps.some(s => s.snapshotName === snapshot)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${source}@${snapshot}' not found` } }
    }

    const targetSnaps = (await datasetExists(target.pool, targetFull))
      ? await listSnapshotsDetail(targetFull)
      : null
    const d = discover(sourceSnaps, targetSnaps, snapName)

    // Estimate the stream size for the resolved mode (full when diverged, so the
    // UI can show the honest byte cost even though it must not offer the run).
    const dryArgs = ['send', '-nvP']
    if (d.mode === 'incremental' && d.baseSnapshot)
      dryArgs.push('-i', `@${d.baseSnapshot}`)
    dryArgs.push(`${source}@${snapName}`)
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
    const { target, snapshot, snapshotFirst } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await datasetExists(poolName, source))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${source}' not found` } }
    }
    if (!(await poolExists(target.pool))) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' does not exist` } }
    }
    // Story 3.25: never create datasets on a PVE-managed pool — reject it as a
    // replication target at the API boundary too (the UI already excludes it).
    if (await deps.isPveManagedPool(target.pool)) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' is PVE-managed — ANAS does not create datasets there` } }
    }

    const targetFull = resolveTarget(source, poolName, target)

    const job = jobQueue.submit(
      'zfs.replicate',
      { ...identity, params: { source, target: targetFull } },
      async (updateProgress) => {
        // 1) Optional snapshot-first — create a fresh, sortable snapshot to send up to.
        let snapName = snapshot
        if (snapshotFirst) {
          const name = defaultSnapName()
          updateProgress(`zfs snapshot ${source}@${name}`)
          const snapR = await executor.exec(ZFS, ['snapshot', `${source}@${name}`])
          if (snapR.exitCode !== 0)
            throw new Error(snapR.stderr.trim() || `zfs snapshot exited with code ${snapR.exitCode}`)
          snapName = name
        }

        // 2) Recompute the plan INSIDE the job — state may have changed since planning.
        const sourceSnaps = await listSnapshotsDetail(source)
        if (sourceSnaps.length === 0)
          throw new Error(`Dataset '${source}' has no snapshots — create a snapshot first`)
        if (!snapName)
          snapName = sourceSnaps[0].snapshotName
        else if (!sourceSnaps.some(s => s.snapshotName === snapName))
          throw new Error(`Snapshot '${source}@${snapName}' does not exist on source`)

        const targetSnaps = (await datasetExists(target.pool, targetFull))
          ? await listSnapshotsDetail(targetFull)
          : null
        const d = discover(sourceSnaps, targetSnaps, snapName)
        if (d.targetDiverged)
          throw new Error(`Target '${targetFull}' has diverged — no common snapshot; remove the target dataset or replicate to a new path`)

        const srcSnapFull = `${source}@${snapName}`

        // 3) Estimate bytes (best-effort) for the job result.
        const dryArgs = ['send', '-nvP']
        if (d.mode === 'incremental' && d.baseSnapshot)
          dryArgs.push('-i', `@${d.baseSnapshot}`)
        dryArgs.push(srcSnapFull)
        const dry = await executor.exec(ZFS, dryArgs)
        const bytesEstimated = parseSendDryRun(dry.stdout)

        // 4) Run the send|recv pipeline. readonly=on only on CREATE (full send);
        //    an incremental recv into the existing (already-readonly) target
        //    must not re-set the property, which -o would reject.
        const sendArgs = d.mode === 'incremental' && d.baseSnapshot
          ? ['send', '-i', `@${d.baseSnapshot}`, srcSnapFull]
          : ['send', srcSnapFull]
        const recvArgs = d.mode === 'full'
          ? ['recv', '-o', 'readonly=on', targetFull]
          : ['recv', targetFull]

        updateProgress(`zfs send ${srcSnapFull} | zfs recv ${targetFull}`)
        const pipe = await executor.pipeline(ZFS, sendArgs, ZFS, recvArgs)
        if (pipe.leftExitCode !== 0 || pipe.rightExitCode !== 0) {
          const detail = pipe.rightStderr.trim()
            ? `recv: ${pipe.rightStderr.trim()}`
            : pipe.leftStderr.trim()
              ? `send: ${pipe.leftStderr.trim()}`
              : `send exited ${pipe.leftExitCode}, recv exited ${pipe.rightExitCode}`
          throw new Error(`Replication failed — ${detail}`)
        }

        // 5) Hold the newest replicated base on BOTH sides, then release the
        //    older anas-repl holds so exactly the newest base stays pinned.
        //    Fail-open: hold/release hiccups are warnings, not job failures.
        const warnings: string[] = []
        const targetSnapFull = `${targetFull}@${snapName}`
        for (const snapFull of [srcSnapFull, targetSnapFull]) {
          const holdR = await executor.exec(ZFS, ['hold', HOLD_TAG, snapFull])
          if (holdR.exitCode !== 0)
            warnings.push(`Could not place ${HOLD_TAG} hold on ${snapFull}: ${holdR.stderr.trim() || `exit ${holdR.exitCode}`}`)
        }

        // Release stale holds on OLDER snapshots of both datasets (keep only snapName).
        const releaseOlder = async (datasetFull: string, snaps: Snapshot[]): Promise<void> => {
          for (const s of snaps) {
            if (s.snapshotName === snapName)
              continue
            const full = `${datasetFull}@${s.snapshotName}`
            if (!(await heldTags(executor, full)).includes(HOLD_TAG))
              continue
            const rel = await executor.exec(ZFS, ['release', HOLD_TAG, full])
            if (rel.exitCode !== 0)
              warnings.push(`Could not release ${HOLD_TAG} hold on ${full}: ${rel.stderr.trim() || `exit ${rel.exitCode}`}`)
          }
        }
        await releaseOlder(source, sourceSnaps)
        // Re-read the target's snapshots — the recv just added snapName there.
        await releaseOlder(targetFull, await listSnapshotsDetail(targetFull))

        return {
          mode: d.mode,
          snapshot: snapName,
          ...(d.baseSnapshot ? { baseSnapshot: d.baseSnapshot } : {}),
          bytesEstimated,
          target: targetFull,
          ...(warnings.length ? { warnings } : {}),
        }
      },
    )

    reply.code(202)
    return { job }
  }

  return { planReplication, runReplication }
}
