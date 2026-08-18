import type { Job, JobRef } from '@anas/shared'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

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
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Poll a submitted job to a terminal state. Resolves with the finished Job
 * (completed OR failed); rejects only on transport/protocol failures — or on
 * the 24h backstop, `kind` naming the caller in the error.
 */
export async function pollJobToTerminal(
  requester: Requester,
  jobRef: JobRef,
  kind: string,
  loop: RunLoopOptions = {},
): Promise<Job> {
  const intervalMs = loop.intervalMs ?? RUNNER_POLL_INTERVAL_MS
  const maxAttempts = loop.maxAttempts ?? RUNNER_POLL_MAX_ATTEMPTS
  const sleep = loop.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const headers = identityHeaders()

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
  throw new Error(`${kind} job ${jobRef.id} did not reach a terminal state after ${maxAttempts} polls`)
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
