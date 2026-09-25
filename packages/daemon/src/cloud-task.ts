import type { Job, JobRef } from '@anas/shared'
import type { Requester, RunLoopOptions } from './runner-poll.js'
import { BACKUP_SKIP_EXIT_CODE, BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'
import { cancelledRunnerExit, defaultSocket, errorMessage, identityHeaders, pollJobToTerminal, socketRequester } from './runner-poll.js'

/**
 * Cloud sync task RUNNER (story rclone.2) — the entrypoint each
 * `anas-cloud-<name>` timer fires (via `node dist/cloud-task.js --name <name>`).
 * The backup runner's twin, on the same shared poll loop: a thin, shell-free
 * client of the daemon's Run-Now endpoint that POSTs the run job over the
 * daemon's unix socket with SYSTEM identity headers, polls the job to a
 * terminal state, prints the result JSON to stdout (→ journald), and exits
 * truthfully — so systemd's own last-result stays honest.
 *
 * No scheduling, no state, no rclone invocation here: the timer schedules, the
 * daemon runs rclone and classifies. It POSTs with `direct:true` — the daemon
 * then runs rclone in-process (this IS the unit's work) rather than starting
 * the unit again. A UI Run Now instead starts THIS unit and supervises it, so
 * scheduled and manual runs converge on one unit and one journald history.
 *
 * Poll loop (interval, 24h backstop) lives in runner-poll.ts, shared with the
 * backup, snapshot and replicate runners.
 */

export type { Requester, RunLoopOptions, RunnerResponse } from './runner-poll.js'
export { socketRequester } from './runner-poll.js'

export interface RunnerOptions {
  name: string
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
    if (flag === '--name')
      opts.name = value
    else if (flag === '--socket')
      opts.socket = value
    else
      throw new Error(`Unknown argument: ${flag}`)
  }
  if (!opts.name)
    throw new Error('Missing required --name')
  return { name: opts.name, socket: opts.socket ?? defaultSocket() }
}

/**
 * Submit the run job and poll it to a terminal state. Resolves with the
 * finished Job (completed OR failed); rejects only on transport/protocol
 * failures.
 */
export async function runCloudTask(
  requester: Requester,
  name: string,
  loop: RunLoopOptions = {},
): Promise<Job> {
  // `direct:true` — THIS is the unit's own execution (the timer / systemctl
  // start fired us). It runs rclone in the daemon and must NOT make the daemon
  // start the unit again (that is the recursion guard); a UI Run Now omits the
  // flag and the daemon starts+supervises this same unit instead.
  const submit = await requester({
    method: 'POST',
    path: `/v1/cloud/tasks/${encodeURIComponent(name)}/run`,
    headers: identityHeaders(),
    body: { direct: true },
  })
  if (submit.statusCode !== 202) {
    const detail = errorMessage(submit.body) ?? JSON.stringify(submit.body)
    throw new Error(`cloud sync run submit failed (HTTP ${submit.statusCode}): ${detail}`)
  }
  const jobRef = (submit.body as { job?: JobRef }).job
  if (!jobRef?.id)
    throw new Error(`cloud sync run submit returned no job id: ${JSON.stringify(submit.body)}`)

  return pollJobToTerminal(requester, jobRef, 'cloud sync', loop)
}

/**
 * The exit status a completed job should produce. A gated off-week fire exits
 * with the deliberate-skip code, which the generated unit declares as
 * `SuccessExitStatus=`: systemd counts the run as a success (nothing went
 * wrong) while `ExecMainStatus` still says plainly that no sync ran, so the
 * task status shows "skipped" from one `systemctl show`. Everything else that
 * completed exits 0.
 */
export function exitCodeForResult(result: unknown): number {
  const status = (result as { status?: string } | undefined)?.status
  return status === BACKUP_SKIPPED_OFF_WEEK ? BACKUP_SKIP_EXIT_CODE : 0
}

/**
 * CLI entrypoint. Exits 0 on completed, {@link BACKUP_SKIP_EXIT_CODE} on a
 * deliberate off-week skip (a success as far as systemd is concerned — the unit
 * declares it), 130 (`TASK_CANCELLED_EXIT_CODE`) when the job was
 * cancelled (rclone.5), 1 on job failure, 2 on bad args/transport.
 */
export async function main(
  argv: string[],
  /** The transport, from the parsed `--socket` (tests hand a scripted one). */
  requesterFor: (socket: string) => Requester = socketRequester,
): Promise<number> {
  let opts: RunnerOptions
  try {
    opts = parseRunnerArgs(argv)
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  try {
    const job = await runCloudTask(requesterFor(opts.socket), opts.name)
    if (job.status === 'completed') {
      process.stdout.write(`${JSON.stringify({ task: opts.name, result: job.result })}\n`)
      return exitCodeForResult(job.result)
    }
    // rclone.5: an operator cancelled the run — exit with the cancel code the
    // status derivation reads as `cancelled`, never as a failure.
    if (job.status === 'cancelled')
      return cancelledRunnerExit(job, opts.name)
    process.stderr.write(`${job.error?.message ?? 'cloud sync job failed'}\n`)
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
