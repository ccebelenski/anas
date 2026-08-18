import type { Job, JobRef } from '@anas/shared'
import type { Requester, RunLoopOptions } from './runner-poll.js'
import { defaultSocket, errorMessage, identityHeaders, pollJobToTerminal, socketRequester } from './runner-poll.js'

/**
 * Replication task RUNNER (Epic 5.5.3) — the entrypoint each `anas-repl-<name>`
 * timer fires (via `node dist/replicate-task.js …`). It is a thin, shell-free
 * client of the stage-1 replicate endpoint: it POSTs the one-shot replicate job
 * over the daemon's unix socket with SYSTEM identity headers, polls the job to a
 * terminal state, prints the result JSON to stdout (→ journald), and exits 0 on
 * completion / nonzero on failure (so systemd's own last-result is truthful).
 *
 * No custom scheduling, no state: the timer schedules, the daemon does the work,
 * ZFS + systemd hold the truth. Everything here is I/O plumbing, with the shared
 * poll loop (interval, 24h backstop) in runner-poll.ts.
 */

export type { Requester, RunLoopOptions, RunnerResponse } from './runner-poll.js'
export { socketRequester } from './runner-poll.js'

export interface RunnerOptions {
  pool: string
  /** Source dataset path relative to the pool ('' = the pool root). */
  dataset: string
  targetPool: string
  targetDataset?: string
  /** Stage-3: where the target pool lives (absent / 'local' = same node). */
  locationKind?: 'local' | 'peer' | 'remote'
  /** Peer nodename or registered remote name (with a non-local kind). */
  locationName?: string
  snapshotFirst: boolean
  socket: string
}

/**
 * Parse the runner's argv (already sliced past `node script`). Throws on a
 *  missing required flag or a value-less flag.
 */
export function parseRunnerArgs(argv: string[]): RunnerOptions {
  const opts: Partial<RunnerOptions> & { snapshotFirst: boolean } = { snapshotFirst: false, socket: defaultSocket() }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const takesValue = flag !== '--snapshot-first'
    const value = takesValue ? argv[++i] : undefined
    if (takesValue && value === undefined)
      throw new Error(`Missing value for ${flag}`)
    if (flag === '--pool')
      opts.pool = value
    else if (flag === '--dataset')
      opts.dataset = value
    else if (flag === '--target-pool')
      opts.targetPool = value
    else if (flag === '--target-dataset')
      opts.targetDataset = value
    else if (flag === '--location-kind')
      opts.locationKind = value as RunnerOptions['locationKind']
    else if (flag === '--location-name')
      opts.locationName = value
    else if (flag === '--socket')
      opts.socket = value
    else if (flag === '--snapshot-first')
      opts.snapshotFirst = true
    else
      throw new Error(`Unknown argument: ${flag}`)
  }
  if (opts.pool === undefined)
    throw new Error('Missing required --pool')
  if (opts.dataset === undefined)
    throw new Error('Missing required --dataset (use --dataset "" for the pool root)')
  if (!opts.targetPool)
    throw new Error('Missing required --target-pool')
  if (opts.locationKind && opts.locationKind !== 'local' && !opts.locationName)
    throw new Error(`Missing --location-name for --location-kind ${opts.locationKind}`)
  return {
    pool: opts.pool,
    dataset: opts.dataset,
    targetPool: opts.targetPool,
    ...(opts.targetDataset !== undefined ? { targetDataset: opts.targetDataset } : {}),
    ...(opts.locationKind !== undefined ? { locationKind: opts.locationKind } : {}),
    ...(opts.locationName !== undefined ? { locationName: opts.locationName } : {}),
    snapshotFirst: opts.snapshotFirst,
    socket: opts.socket ?? defaultSocket(),
  }
}

/**
 * The stage-1 replicate URL for a source dataset (pool-root → no path segment,
 *  matching the wildcard route's empty-tail case).
 */
export function replicatePath(pool: string, dataset: string): string {
  return dataset === ''
    ? `/v1/pools/${pool}/datasets/replicate`
    : `/v1/pools/${pool}/datasets/${dataset}/replicate`
}

/** The replicate request body (newest source snapshot; optional snapshot-first). */
export function replicateBody(opts: RunnerOptions): Record<string, unknown> {
  return {
    target: {
      pool: opts.targetPool,
      ...(opts.targetDataset !== undefined && opts.targetDataset !== '' ? { dataset: opts.targetDataset } : {}),
      // Stage 3: pass the target LOCATION through so the endpoint replicates to a
      // peer/remote. Absent or 'local' → the endpoint's default (same node).
      ...(opts.locationKind && opts.locationKind !== 'local'
        ? { location: { kind: opts.locationKind, ...(opts.locationName ? { name: opts.locationName } : {}) } }
        : {}),
    },
    snapshotFirst: opts.snapshotFirst,
  }
}

/**
 * Submit the replicate job and poll it to a terminal state. Resolves with the
 * finished Job (completed OR failed); rejects only on transport/protocol
 * failures (non-202 submit, missing job id, poll exhaustion).
 */
export async function runReplication(
  requester: Requester,
  opts: RunnerOptions,
  loop: RunLoopOptions = {},
): Promise<Job> {
  const submit = await requester({
    method: 'POST',
    path: replicatePath(opts.pool, opts.dataset),
    headers: identityHeaders(),
    body: replicateBody(opts),
  })
  if (submit.statusCode !== 202) {
    const detail = errorMessage(submit.body) ?? JSON.stringify(submit.body)
    throw new Error(`replicate submit failed (HTTP ${submit.statusCode}): ${detail}`)
  }
  const jobRef = (submit.body as { job?: JobRef }).job
  if (!jobRef?.id)
    throw new Error(`replicate submit returned no job id: ${JSON.stringify(submit.body)}`)

  return pollJobToTerminal(requester, jobRef, 'replicate', loop)
}

/** CLI entrypoint. Exits 0 on completed, 1 on job failure, 2 on bad args/transport. */
export async function main(argv: string[]): Promise<number> {
  let opts: RunnerOptions
  try {
    opts = parseRunnerArgs(argv)
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  try {
    const job = await runReplication(socketRequester(opts.socket), opts)
    if (job.status === 'completed') {
      process.stdout.write(`${JSON.stringify({ task: `${opts.pool}/${opts.dataset}`, result: job.result })}\n`)
      return 0
    }
    process.stderr.write(`${job.error?.message ?? 'replication job failed'}\n`)
    return 1
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}
