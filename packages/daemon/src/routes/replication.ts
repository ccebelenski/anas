import type { ReplicatePlan, ReplicationTarget, Snapshot } from '@anas/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ResolvedLocation, Transport } from '../services/replication-transport.js'
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
/** The remote-side zfs — UNQUALIFIED (rely on the remote login PATH; we don't
 *  own the remote and can't assume /usr/sbin). Used inside `ssh … zfs …`. */
const ZFS_REMOTE = 'zfs'
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
  /** Stage-3 remote/peer SSH transport (location resolution + remote zfs ops). */
  transport: Transport
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

/** Resolved target location: local, or a resolved peer/remote (isRemote true). */
type TargetLocation
  = | { isRemote: false }
    | { isRemote: true, resolved: ResolvedLocation }
    | { error: string }

export function createReplicationHandlers(deps: ReplicationDeps) {
  const { executor, jobQueue, resolveDatasetName, poolExists, datasetExists, listSnapshotsDetail, transport } = deps

  /**
   * Resolve where the target pool lives. `local` (absent location) → { isRemote:
   * false }. A peer/remote is looked up (members / registry); an unresolvable one
   * is a 400-worthy { error }.
   */
  async function resolveTargetLocation(target: ReplicationTarget): Promise<TargetLocation> {
    const kind = target.location?.kind ?? 'local'
    if (kind === 'local')
      return { isRemote: false }
    const res = await transport.resolveLocation(target.location!)
    if (!res.ok)
      return { error: res.error }
    return { isRemote: true, resolved: res.resolved }
  }

  /** Does the target pool exist — locally (`zpool list`) or on the peer/remote (`ssh zpool list`)? */
  async function targetPoolExists(loc: TargetLocation, pool: string): Promise<boolean> {
    if ('error' in loc)
      return false
    return loc.isRemote ? transport.remotePoolExists(loc.resolved, pool) : poolExists(pool)
  }

  /**
   * The target dataset's snapshots (as minimal Snapshot records — only
   * snapshotName is read downstream), or null when the target dataset is absent.
   * Remote targets go over ssh; the zfs -H list yields names only.
   */
  async function targetSnapshots(loc: TargetLocation, targetPool: string, targetFull: string): Promise<Snapshot[] | null> {
    if ('error' in loc)
      return null
    if (loc.isRemote) {
      if (!(await transport.remoteDatasetExists(loc.resolved, targetFull)))
        return null
      const names = await transport.remoteSnapshotNames(loc.resolved, targetFull)
      return names.map(n => ({ snapshotName: n }) as Snapshot)
    }
    return (await datasetExists(targetPool, targetFull)) ? listSnapshotsDetail(targetFull) : null
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

    // Source must exist (system is the source of truth).
    if (!(await datasetExists(poolName, source))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${source}' not found` } }
    }

    // Stage 3: resolve where the target lives (local / peer / remote).
    const loc = await resolveTargetLocation(target)
    if ('error' in loc) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: loc.error } }
    }

    // The target POOL must exist — we replicate into an existing pool, never
    // create one. Locally via `zpool list`; on a peer/remote via `ssh zpool list`.
    if (!(await targetPoolExists(loc, target.pool))) {
      const where = loc.isRemote ? ` on ${target.location?.kind} '${target.location?.name}'` : ''
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' does not exist${where}` } }
    }
    // Story 3.25: never create datasets on a PVE-managed pool. This guard applies
    // ONLY to LOCAL targets — we cannot and must not read a remote's storage.cfg,
    // so a peer/remote pool is never subject to the PVE-managed exclusion.
    if (!loc.isRemote && (await deps.isPveManagedPool(target.pool))) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' is PVE-managed — ANAS does not create datasets there` } }
    }

    const targetFull = resolveTarget(source, poolName, target)

    // Replicating a dataset onto itself is meaningless — give the honest answer.
    // Only meaningful for LOCAL targets: a peer/remote dataset of the same name
    // lives on a different machine and is never the source.
    if (!loc.isRemote && targetFull === source) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Cannot replicate '${source}' onto itself — choose a different target dataset` } }
    }

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

    const targetSnaps = await targetSnapshots(loc, target.pool, targetFull)
    const d = discover(sourceSnaps, targetSnaps, snapName)

    // Estimate the stream size for the resolved mode (full when diverged, so the
    // UI can show the honest byte cost even though it must not offer the run).
    // The dry-run is always LOCAL — `zfs send -nvP` on the source side.
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

    // Stage 3: resolve where the target lives (local / peer / remote).
    const loc = await resolveTargetLocation(target)
    if ('error' in loc) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: loc.error } }
    }

    if (!(await targetPoolExists(loc, target.pool))) {
      const where = loc.isRemote ? ` on ${target.location?.kind} '${target.location?.name}'` : ''
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' does not exist${where}` } }
    }
    // Story 3.25: never create datasets on a PVE-managed pool — LOCAL targets
    // only (we cannot and must not read a remote's storage.cfg).
    if (!loc.isRemote && (await deps.isPveManagedPool(target.pool))) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target pool '${target.pool}' is PVE-managed — ANAS does not create datasets there` } }
    }

    const targetFull = resolveTarget(source, poolName, target)

    // Replicating a dataset onto itself is meaningless — LOCAL targets only.
    if (!loc.isRemote && targetFull === source) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Cannot replicate '${source}' onto itself — choose a different target dataset` } }
    }

    const job = jobQueue.submit(
      'zfs.replicate',
      { ...identity, params: { source, target: targetFull, ...(loc.isRemote ? { location: target.location } : {}) } },
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

        const targetSnaps = await targetSnapshots(loc, target.pool, targetFull)
        const d = discover(sourceSnaps, targetSnaps, snapName)
        if (d.targetDiverged)
          throw new Error(`Target '${targetFull}' has diverged — no common snapshot; remove the target dataset or replicate to a new path`)

        const srcSnapFull = `${source}@${snapName}`

        // 3) Estimate bytes (best-effort) for the job result — always a LOCAL dry-run.
        const dryArgs = ['send', '-nvP']
        if (d.mode === 'incremental' && d.baseSnapshot)
          dryArgs.push('-i', `@${d.baseSnapshot}`)
        dryArgs.push(srcSnapFull)
        const dry = await executor.exec(ZFS, dryArgs)
        const bytesEstimated = parseSendDryRun(dry.stdout)

        // 4) Run the send|recv pipeline. readonly=on only on CREATE (full send);
        //    an incremental recv into the existing (already-readonly) target
        //    must not re-set the property, which -o would reject. For a remote/
        //    peer target the recv side runs over ssh (`… | ssh <host> zfs recv`);
        //    for a local target it is a second local `zfs` process.
        const sendArgs = d.mode === 'incremental' && d.baseSnapshot
          ? ['send', '-i', `@${d.baseSnapshot}`, srcSnapFull]
          : ['send', srcSnapFull]
        // `--` ends zfs option parsing so `targetFull` is always the positional
        // filesystem, never mistaken for a flag (defence in depth; the schema
        // already restricts the dataset charset).
        const recvArgs = d.mode === 'full'
          ? ['recv', '-o', 'readonly=on', '--', targetFull]
          : ['recv', '--', targetFull]

        let recvCmd = ZFS
        let recvArgv = recvArgs
        if (loc.isRemote) {
          const argv = transport.buildSshArgv(loc.resolved, [ZFS_REMOTE, ...recvArgs])
          recvCmd = argv[0]
          recvArgv = argv.slice(1)
        }

        updateProgress(`zfs send ${srcSnapFull} | zfs recv ${targetFull}`)
        const pipe = await executor.pipeline(ZFS, sendArgs, recvCmd, recvArgv)
        if (pipe.leftExitCode !== 0 || pipe.rightExitCode !== 0) {
          const detail = pipe.rightStderr.trim()
            ? `recv: ${pipe.rightStderr.trim()}`
            : pipe.leftStderr.trim()
              ? `send: ${pipe.leftStderr.trim()}`
              : `send exited ${pipe.leftExitCode}, recv exited ${pipe.rightExitCode}`
          throw new Error(`Replication failed — ${detail}`)
        }

        // 5) Hold the newest replicated base on BOTH sides, then release the
        //    older anas-repl holds so exactly the newest base stays pinned. The
        //    SOURCE is always local; the TARGET hold/release goes over ssh for a
        //    peer/remote. Fail-open: hiccups are warnings, not job failures.
        const warnings: string[] = []
        const targetSnapFull = `${targetFull}@${snapName}`

        const srcHold = await executor.exec(ZFS, ['hold', HOLD_TAG, srcSnapFull])
        if (srcHold.exitCode !== 0)
          warnings.push(`Could not place ${HOLD_TAG} hold on ${srcSnapFull}: ${srcHold.stderr.trim() || `exit ${srcHold.exitCode}`}`)

        const tgtHold = loc.isRemote
          ? await transport.remoteHold(loc.resolved, targetSnapFull, HOLD_TAG)
          : await executor.exec(ZFS, ['hold', HOLD_TAG, targetSnapFull])
        if (tgtHold.exitCode !== 0)
          warnings.push(`Could not place ${HOLD_TAG} hold on ${targetSnapFull}: ${tgtHold.stderr.trim() || `exit ${tgtHold.exitCode}`}`)

        // Release stale holds on OLDER source snapshots (keep only snapName).
        const releaseOlderLocal = async (datasetFull: string, snaps: Snapshot[]): Promise<void> => {
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
        await releaseOlderLocal(source, sourceSnaps)

        // Release stale holds on OLDER target snapshots — local or over ssh.
        if (loc.isRemote) {
          const resolved = loc.resolved
          for (const name of await transport.remoteSnapshotNames(resolved, targetFull)) {
            if (name === snapName)
              continue
            const full = `${targetFull}@${name}`
            if (!(await transport.remoteHeldTags(resolved, full)).includes(HOLD_TAG))
              continue
            const rel = await transport.remoteRelease(resolved, full, HOLD_TAG)
            if (rel.exitCode !== 0)
              warnings.push(`Could not release ${HOLD_TAG} hold on ${full}: ${rel.stderr.trim() || `exit ${rel.exitCode}`}`)
          }
        }
        else {
          // Re-read the target's snapshots — the recv just added snapName there.
          await releaseOlderLocal(targetFull, await listSnapshotsDetail(targetFull))
        }

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
