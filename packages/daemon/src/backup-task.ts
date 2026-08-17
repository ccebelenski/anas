import type { Job, JobRef } from '@anas/shared'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { BACKUP_SKIP_EXIT_CODE, BACKUP_SKIPPED_OFF_WEEK } from '@anas/shared'

/**
 * Backup task RUNNER (Epic 16) — the entrypoint each `anas-backup-<name>` timer
 * fires (via `node dist/backup-task.js --name <name>`). It is a thin, shell-free
 * client of the daemon's Run-Now endpoint: it POSTs the run job over the daemon's
 * unix socket with SYSTEM identity headers, polls the job to a terminal state,
 * prints the result JSON to stdout (→ journald), and exits 0 on completion /
 * nonzero on failure — so systemd's own last-result stays truthful.
 *
 * No custom scheduling, no state, no pbc invocation here: the timer schedules,
 * the daemon runs pbc and classifies. Everything here is I/O plumbing. It POSTs
 * with `direct:true` — the daemon then runs pbc in-process (this IS the unit's
 * work) rather than starting the unit again. A UI Run-Now instead starts THIS
 * unit and supervises it, so scheduled and manual runs converge on one unit and
 * one systemd/journald history.
 */

const DEFAULT_SOCKET = process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock'

export interface RunnerOptions {
  name: string
  socket: string
}

/** Parse the runner's argv (already sliced past `node script`). */
export function parseRunnerArgs(argv: string[]): RunnerOptions {
  const opts: Partial<RunnerOptions> = { socket: DEFAULT_SOCKET }
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
  return { name: opts.name, socket: opts.socket ?? DEFAULT_SOCKET }
}

export interface RunnerResponse {
  statusCode: number
  body: unknown
}

/** A single JSON request over the daemon socket (abstracted for tests). */
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
  /** Poll interval in ms (default 2000). */
  intervalMs?: number
  /** Max poll attempts before giving up (default 2700 ≈ 90 min at 2s). */
  maxAttempts?: number
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Submit the run job and poll it to a terminal state. Resolves with the finished
 * Job (completed OR failed); rejects only on transport/protocol failures.
 */
export async function runBackupTask(
  requester: Requester,
  name: string,
  loop: RunLoopOptions = {},
): Promise<Job> {
  const intervalMs = loop.intervalMs ?? 2000
  const maxAttempts = loop.maxAttempts ?? 2700
  const sleep = loop.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))

  const headers = identityHeaders()
  // `direct:true` — THIS is the unit's own execution (the timer / systemctl start
  // fired us). It runs pbc in the daemon and must NOT make the daemon start the
  // unit again (that is the recursion guard); a UI Run-Now omits the flag and the
  // daemon starts+supervises this same unit instead.
  const submit = await requester({
    method: 'POST',
    path: `/v1/backup/tasks/${encodeURIComponent(name)}/run`,
    headers,
    body: { direct: true },
  })
  if (submit.statusCode !== 202) {
    const detail = errorMessage(submit.body) ?? JSON.stringify(submit.body)
    throw new Error(`backup run submit failed (HTTP ${submit.statusCode}): ${detail}`)
  }
  const jobRef = (submit.body as { job?: JobRef }).job
  if (!jobRef?.id)
    throw new Error(`backup run submit returned no job id: ${JSON.stringify(submit.body)}`)

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
  throw new Error(`backup job ${jobRef.id} did not reach a terminal state after ${maxAttempts} polls`)
}

/**
 * The exit status a completed job should produce. A gated off-week fire exits
 * with the deliberate-skip code, which the generated unit declares as
 * `SuccessExitStatus=`: systemd counts the run as a success (nothing went wrong)
 * while `ExecMainStatus` still says plainly that no backup was taken, so the task
 * status can show "skipped" from one `systemctl show` (16.10). Everything else
 * that completed exits 0.
 */
export function exitCodeForResult(result: unknown): number {
  const status = (result as { status?: string } | undefined)?.status
  return status === BACKUP_SKIPPED_OFF_WEEK ? BACKUP_SKIP_EXIT_CODE : 0
}

/** Pull an error message out of a `{ error: { message } }` body if present. */
function errorMessage(body: unknown): string | undefined {
  return (body as { error?: { message?: string } } | undefined)?.error?.message
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

/**
 * CLI entrypoint. Exits 0 on completed, {@link BACKUP_SKIP_EXIT_CODE} on a
 * deliberate off-week skip (a success as far as systemd is concerned — the unit
 * declares it), 1 on job failure, 2 on bad args/transport.
 */
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
    const job = await runBackupTask(socketRequester(opts.socket), opts.name)
    if (job.status === 'completed') {
      process.stdout.write(`${JSON.stringify({ task: opts.name, result: job.result })}\n`)
      return exitCodeForResult(job.result)
    }
    process.stderr.write(`${job.error?.message ?? 'backup job failed'}\n`)
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
