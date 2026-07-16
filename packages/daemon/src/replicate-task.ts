import type { Job, JobRef } from '@anas/shared'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

/**
 * Replication task RUNNER (Epic 5.5.3) — the entrypoint each `anas-repl-<name>`
 * timer fires (via `node dist/replicate-task.js …`). It is a thin, shell-free
 * client of the stage-1 replicate endpoint: it POSTs the one-shot replicate job
 * over the daemon's unix socket with SYSTEM identity headers, polls the job to a
 * terminal state, prints the result JSON to stdout (→ journald), and exits 0 on
 * completion / nonzero on failure (so systemd's own last-result is truthful).
 *
 * No custom scheduling, no state: the timer schedules, the daemon does the work,
 * ZFS + systemd hold the truth. Everything here is I/O plumbing.
 */

const DEFAULT_SOCKET = process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock'

export interface RunnerOptions {
  pool: string
  /** Source dataset path relative to the pool ('' = the pool root). */
  dataset: string
  targetPool: string
  targetDataset?: string
  snapshotFirst: boolean
  socket: string
}

/**
 * Parse the runner's argv (already sliced past `node script`). Throws on a
 *  missing required flag or a value-less flag.
 */
export function parseRunnerArgs(argv: string[]): RunnerOptions {
  const opts: Partial<RunnerOptions> & { snapshotFirst: boolean } = { snapshotFirst: false, socket: DEFAULT_SOCKET }
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
  return {
    pool: opts.pool,
    dataset: opts.dataset,
    targetPool: opts.targetPool,
    ...(opts.targetDataset !== undefined ? { targetDataset: opts.targetDataset } : {}),
    snapshotFirst: opts.snapshotFirst,
    socket: opts.socket ?? DEFAULT_SOCKET,
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
    },
    snapshotFirst: opts.snapshotFirst,
  }
}

export interface RunnerResponse {
  statusCode: number
  body: unknown
}

/**
 * A single JSON request over the daemon socket. Abstracted so the run loop is
 *  unit-testable with a fake requester.
 */
export type Requester = (req: {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
}) => Promise<RunnerResponse>

/** System identity headers the daemon's requireIdentity expects for a mutation. */
function identityHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-anas-user': 'root@pam',
    'x-anas-user-uid': '0',
    'x-anas-request-id': randomUUID(),
  }
}

export interface RunLoopOptions {
  /** Poll interval in ms (default 1000). */
  intervalMs?: number
  /** Max poll attempts before giving up (default 3600 ≈ 1h at 1s). */
  maxAttempts?: number
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
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
  const intervalMs = loop.intervalMs ?? 1000
  const maxAttempts = loop.maxAttempts ?? 3600
  const sleep = loop.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))

  const headers = identityHeaders()
  const submit = await requester({
    method: 'POST',
    path: replicatePath(opts.pool, opts.dataset),
    headers,
    body: replicateBody(opts),
  })
  if (submit.statusCode !== 202) {
    const detail = errorMessage(submit.body) ?? JSON.stringify(submit.body)
    throw new Error(`replicate submit failed (HTTP ${submit.statusCode}): ${detail}`)
  }
  const jobRef = (submit.body as { job?: JobRef }).job
  if (!jobRef?.id)
    throw new Error(`replicate submit returned no job id: ${JSON.stringify(submit.body)}`)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const poll = await requester({
      method: 'GET',
      path: `/v1/jobs/${jobRef.id}`,
      headers,
    })
    if (poll.statusCode === 200) {
      const job = (poll.body as { job?: Job }).job
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
    }
    await sleep(intervalMs)
  }
  throw new Error(`replicate job ${jobRef.id} did not reach a terminal state after ${maxAttempts} polls`)
}

/** Pull an error message out of a `{ error: { message } }` body if present. */
function errorMessage(body: unknown): string | undefined {
  const err = (body as { error?: { message?: string } } | undefined)?.error
  return err?.message
}

/** Real requester: one JSON round-trip over the daemon's unix socket. */
export function socketRequester(socketPath: string): Requester {
  return req => new Promise<RunnerResponse>((resolve, reject) => {
    const payload = req.body !== undefined ? JSON.stringify(req.body) : undefined
    const clientReq = httpRequest(
      {
        socketPath,
        method: req.method,
        path: req.path,
        headers: {
          ...req.headers,
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          let body: unknown = data
          try {
            body = data ? JSON.parse(data) : undefined
          }
          catch {
            // Non-JSON body: hand back the raw text.
          }
          resolve({ statusCode: res.statusCode ?? 0, body })
        })
      },
    )
    clientReq.on('error', reject)
    if (payload !== undefined)
      clientReq.write(payload)
    clientReq.end()
  })
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
