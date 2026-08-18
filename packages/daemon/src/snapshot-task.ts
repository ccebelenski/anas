import type { Job, JobRef } from '@anas/shared'
import type { Requester, RunLoopOptions } from './runner-poll.js'
import { defaultSocket, errorMessage, identityHeaders, pollJobToTerminal, socketRequester } from './runner-poll.js'

/**
 * Snapshot schedule RUNNER (Epic 17.4) — the entrypoint each `anas-snap-<id>`
 * timer fires (via `node dist/snapshot-task.js --id <id>`). It is a thin,
 * shell-free client of the daemon's fire endpoint: it POSTs the take+prune job
 * over the daemon's unix socket with SYSTEM identity headers, polls the job to a
 * terminal state, prints the result JSON to stdout (→ journald), and exits 0 on
 * completion / nonzero on failure — so systemd's own last-result stays truthful.
 *
 * No custom scheduling, no state, no zfs/btrfs invocation here: the timer
 * schedules, the daemon takes the snapshot and prunes. Everything here is I/O
 * plumbing — the same shape as replicate-task.ts / backup-task.ts, with the
 * shared poll loop (interval, 24h backstop) in runner-poll.ts.
 */

export type { Requester, RunLoopOptions, RunnerResponse } from './runner-poll.js'
export { socketRequester } from './runner-poll.js'

export interface RunnerOptions {
  id: string
  socket: string
}

/** Parse the runner's argv (already sliced past `node script`). */
export function parseRunnerArgs(argv: string[]): RunnerOptions {
  const opts: Partial<RunnerOptions> = { socket: defaultSocket() }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[++i]
    if (value === undefined)
      throw new Error(`Missing value for ${flag}`)
    if (flag === '--id')
      opts.id = value
    else if (flag === '--socket')
      opts.socket = value
    else
      throw new Error(`Unknown argument: ${flag}`)
  }
  if (!opts.id)
    throw new Error('Missing required --id')
  return { id: opts.id, socket: opts.socket ?? defaultSocket() }
}

/**
 * Submit the fire job and poll it to a terminal state. Resolves with the finished
 * Job (completed OR failed); rejects only on transport/protocol failures.
 */
export async function runSnapshotSchedule(
  requester: Requester,
  id: string,
  loop: RunLoopOptions = {},
): Promise<Job> {
  const submit = await requester({
    method: 'POST',
    path: `/v1/schedules/${encodeURIComponent(id)}/run`,
    headers: identityHeaders(),
    body: {},
  })
  if (submit.statusCode !== 202) {
    const detail = errorMessage(submit.body) ?? JSON.stringify(submit.body)
    throw new Error(`snapshot fire submit failed (HTTP ${submit.statusCode}): ${detail}`)
  }
  const jobRef = (submit.body as { job?: JobRef }).job
  if (!jobRef?.id)
    throw new Error(`snapshot fire submit returned no job id: ${JSON.stringify(submit.body)}`)

  return pollJobToTerminal(requester, jobRef, 'snapshot', loop)
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
    const job = await runSnapshotSchedule(socketRequester(opts.socket), opts.id)
    if (job.status === 'completed') {
      process.stdout.write(`${JSON.stringify({ schedule: opts.id, result: job.result })}\n`)
      return 0
    }
    process.stderr.write(`${job.error?.message ?? 'snapshot schedule job failed'}\n`)
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
