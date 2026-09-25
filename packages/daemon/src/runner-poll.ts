import type { Job, JobRef } from '@anas/shared'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { TASK_CANCELLED_EXIT_CODE } from '@anas/shared'

/**
 * Shared plumbing for the systemd task RUNNERS (backup-task / snapshot-task /
 * replicate-task): the socket requester, identity headers, and the ONE poll
 * loop that follows a submitted job to its terminal state.
 *
 * The daemon's job is the source of truth and always terminates, so the loop's
 * job is to MIRROR it — the cap exists only as a runaway backstop, never as a
 * judgment about how long the work should take. Lesson learned the hard way:
 * the original 90-minute backup cap declared a healthy 6½-hour pbc run failed
 * while the job (and its success notification) completed hours later (#30).
 * 24h is deliberately far beyond any sane run. The 10s interval is about
 * journald noise, not CPU — every poll logs an anasd "incoming request" line,
 * so a day-long run writes ~8.6k lines instead of the ~43k a 2s poll would.
 */

/** Poll interval: 10s — cheap on the socket, quiet in the journal. */
export const RUNNER_POLL_INTERVAL_MS = 10_000
/** Runaway backstop: 8640 polls ≈ 24h at 10s. NOT an expected-duration guess. */
export const RUNNER_POLL_MAX_ATTEMPTS = 8640
/**
 * Consecutive unanswered polls (refused connection, missing socket, 401/500)
 * tolerated before the run is declared interrupted: 30 × 10s ≈ 5 min — long
 * enough for anasd to restart, never long enough to hold a systemd unit
 * `activating` for hours. A 200 resets the count; a 404 never gets here (it is
 * terminal on the first sight — see the loop).
 */
export const RUNNER_POLL_RECONNECT_ATTEMPTS = 30

const DEFAULT_SOCKET = process.env.ANASD_SOCKET ?? '/run/anas/anasd.sock'

/** The runner's socket path: `--socket` override, else the daemon default. */
export function defaultSocket(): string {
  return DEFAULT_SOCKET
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
export function identityHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-anas-user': 'root@pam',
    'x-anas-user-uid': '0',
    'x-anas-request-id': randomUUID(),
  }
}

export interface RunLoopOptions {
  /** Poll interval in ms (default {@link RUNNER_POLL_INTERVAL_MS}). */
  intervalMs?: number
  /** Runaway backstop (default {@link RUNNER_POLL_MAX_ATTEMPTS} ≈ 24h). */
  maxAttempts?: number
  /**
   * Consecutive unanswered polls before the run is declared interrupted
   * (default {@link RUNNER_POLL_RECONNECT_ATTEMPTS}).
   */
  reconnectAttempts?: number
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

/** The bound-reached error: the daemon went silent mid-run for `failures` polls. */
function interruptedError(kind: string, id: string, failures: number, intervalMs: number): Error {
  return new Error(
    `${kind} job ${id}: the daemon did not answer for ${Math.round(failures * intervalMs / 1000)} s — the run was interrupted`,
  )
}

/**
 * Poll a submitted job to a terminal state. Resolves with the finished Job
 * (completed OR failed); rejects, with `kind` naming the caller in the error,
 * when the mirror breaks: a vanished job (404 — the in-memory queue lost it to
 * a daemon restart mid-run), a daemon that stayed silent for the reconnect
 * bound, or the 24h backstop.
 */
export async function pollJobToTerminal(
  requester: Requester,
  jobRef: JobRef,
  kind: string,
  loop: RunLoopOptions = {},
): Promise<Job> {
  const intervalMs = loop.intervalMs ?? RUNNER_POLL_INTERVAL_MS
  const maxAttempts = loop.maxAttempts ?? RUNNER_POLL_MAX_ATTEMPTS
  const reconnectAttempts = loop.reconnectAttempts ?? RUNNER_POLL_RECONNECT_ATTEMPTS
  const sleep = loop.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const headers = identityHeaders()

  let unanswered = 0
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let poll: RunnerResponse
    try {
      poll = await requester({
        method: 'GET',
        path: `/v1/jobs/${jobRef.id}`,
        headers,
      })
    }
    catch {
      // Transport failure — connection refused / socket missing while anasd
      // restarts. Retryable, but bounded: a silent daemon past the reconnect
      // bound means the run died with the restart.
      unanswered += 1
      if (unanswered >= reconnectAttempts)
        throw interruptedError(kind, jobRef.id, unanswered, intervalMs)
      await sleep(intervalMs)
      continue
    }
    if (poll.statusCode === 200) {
      // A live answer ends any silent streak — the counter counts CONSECUTIVE
      // failures only.
      unanswered = 0
      const job = (poll.body as { job?: Job }).job
      if (job && isTerminalJob(job))
        return job
    }
    else if (poll.statusCode === 404) {
      // The job queue is in-memory: a 404 means anasd restarted mid-run, the
      // child (rclone / proxmox-backup-client) died with it, and the id can
      // never come back. Terminal on the first sight — polling on held the
      // unit `activating` for the 24h backstop (found live 2026-09-25).
      throw new Error(`${kind} job ${jobRef.id} no longer exists: the daemon restarted while the run was in progress, so the run was interrupted and must be started again`)
    }
    else {
      // Any other non-200 (401/500; socketRequester also answers statusCode 0
      // when no status came back) is a daemon problem, not a missing job —
      // the reconnect bound's territory, and it counts toward it.
      unanswered += 1
      if (unanswered >= reconnectAttempts)
        throw interruptedError(kind, jobRef.id, unanswered, intervalMs)
    }
    await sleep(intervalMs)
  }
  throw new Error(`${kind} job ${jobRef.id} did not reach a terminal state after ${maxAttempts} polls`)
}

/** Has the job ended? `cancelled` (rclone.5) is as terminal as completed/failed. */
export function isTerminalJob(job: Pick<Job, 'status'>): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
}

/**
 * A runner whose job ended `cancelled` (rclone.5): print the result line
 * (`{ task, result }` — the result says who cancelled and when, and the status
 * derivation's `lastRunNote` reads it back from the journal) and answer the
 * cancel exit code, which the task status maps to `cancelled`, never failed.
 */
export function cancelledRunnerExit(
  job: Job,
  task: string,
  write: (line: string) => void = line => process.stdout.write(line),
): number {
  write(`${JSON.stringify({ task, result: job.result })}\n`)
  return TASK_CANCELLED_EXIT_CODE
}

/** Pull an error message out of a `{ error: { message } }` body if present. */
export function errorMessage(body: unknown): string | undefined {
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
