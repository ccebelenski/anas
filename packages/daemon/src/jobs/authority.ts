import type { Privilege } from '@anas/shared'
import type { JobSubmitter } from './queue.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { forbiddenMessage, RequestHeaders } from '@anas/shared'
import { isReadOnlyOperation } from './read-jobs.js'

/**
 * The job queue's backstop (cr.28, docs/WAVE2-DESIGN.md A3.1): all mutations
 * are jobs (Principle 4), so `JobQueue.submit` is the one place every change
 * passes, and it refuses work the requester's privileges do not cover. The
 * gateway's method rule (cr.27) stays the primary gate; this catches a GET
 * that submits a job, a gateway policy bug, and a gateway that stopped
 * sending the header — without a second copy of the method rule.
 *
 * THE RULE. A job needs `Sys.Modify` on `/`; a job that only reads (a `read.*`
 * operation, cr.48) needs `Sys.Audit` (operator ruling 2026-10-15, EPICS
 * cr.28); the cancel of a read job needs `Sys.Audit`, any other cancel
 * `Sys.Modify`. {@link requiredPrivilege} is the whole rule.
 *
 * WHOSE PRIVILEGES. Not the submitter object a route passes — a route could
 * build one by hand, or spread a narrower type and drop a field. The daemon's
 * first `onRequest` hooks (server.ts) read `x-anas-privileges` from EVERY
 * request into an async-local {@link RequestAuthority} before any handler
 * runs, and `submit` asks that store. Whatever code an HTTP request reaches —
 * gateway-forwarded or a root client on the socket — submits under that
 * request's privileges; a missing or unreadable header is a refusal, never a
 * pass (fail closed, logged with the reason).
 *
 * THE DAEMON'S OWN WORK. Code that no request started (the boot work in
 * index.ts: the AHR boot scan, its cache rung and re-attach) runs with no store
 * and is not checked: no HTTP caller can put code there. A job's body runs
 * with the store cleared ({@link runAsDaemon}, entered by the queue): it was
 * authorised at its own submit, and without the clear a body started by
 * `drain` would carry whichever request happened to trigger the drain.
 * Everything that reaches the daemon over HTTP — the systemd task runners
 * (timers and Run-Now direct runs, `runner-poll.ts` identity) and the udev
 * cache-event script — is a request and names its privileges like the gateway.
 */

/** The cancel job's operation (routes/jobs.ts). */
export const CANCEL_OPERATION = 'job.cancel'

/** What a request may submit: who it says it is and what PVE granted it on `/`. */
export interface RequestAuthority {
  /** `x-anas-user` as sent (for the sentence and the log); undefined when absent. */
  user: string | undefined
  /** The privileges the request carries, or null when it carries no readable list. */
  privileges: readonly Privilege[] | null
  /** Why `privileges` is null — the log line's reason. */
  problem: string | null
}

/** `null` = the daemon's own work inside a job body (see {@link runAsDaemon}). */
const storage = new AsyncLocalStorage<RequestAuthority | null>()

/** Longest header excerpt a refusal line quotes. */
const QUOTE_MAX = 80

/** Read a request's authority from its headers, with the shared RequestHeaders rule. */
export function readRequestAuthority(headers: Record<string, string | string[] | undefined>): RequestAuthority {
  const userHeader = headers['x-anas-user']
  const user = typeof userHeader === 'string' ? userHeader : undefined
  const raw = headers['x-anas-privileges']
  if (raw === undefined)
    return { user, privileges: null, problem: 'the request carries no x-anas-privileges header' }
  const parsed = RequestHeaders.shape['x-anas-privileges'].safeParse(raw)
  if (!parsed.success) {
    const quoted = JSON.stringify(raw)
    const excerpt = quoted.length > QUOTE_MAX ? `${quoted.slice(0, QUOTE_MAX)}…` : quoted
    return { user, privileges: null, problem: `x-anas-privileges ${excerpt} is not a privilege list` }
  }
  return { user, privileges: parsed.data, problem: null }
}

/** Run `fn` (and everything it awaits or schedules) as the request `authority`. */
export function runAsRequest<T>(authority: RequestAuthority, fn: () => T): T {
  return storage.run(authority, fn)
}

/** Run `fn` as the daemon's own work, whatever request context it was reached from. */
export function runAsDaemon<T>(fn: () => T): T {
  return storage.run(null, fn)
}

/** The request this code runs for, or null when it is the daemon's own work. */
export function currentRequestAuthority(): RequestAuthority | null {
  return storage.getStore() ?? null
}

/** The privilege a job needs on `/`: the one rule. */
export function requiredPrivilege(operation: string, params?: Record<string, unknown>): Privilege {
  if (isReadOnlyOperation(operation))
    return 'Sys.Audit'
  // The cancel route names the target's operation from the queue's own record.
  if (operation === CANCEL_OPERATION && typeof params?.operation === 'string' && isReadOnlyOperation(params.operation))
    return 'Sys.Audit'
  return 'Sys.Modify'
}

/** A submit the requester's privileges do not cover. The message is the 403 sentence. */
export class JobForbiddenError extends Error {
  constructor(
    readonly user: string,
    readonly privilege: Privilege,
    readonly operation: string,
    /** For the log, never the client. */
    readonly reason: string,
  ) {
    super(forbiddenMessage(user, privilege))
    this.name = 'JobForbiddenError'
  }
}

/** Why the current request may not submit `operation`, or null when it may (or no request is asking). */
export function submitRefusal(operation: string, submitter: Pick<JobSubmitter, 'user' | 'params'>): JobForbiddenError | null {
  const authority = currentRequestAuthority()
  if (authority === null)
    return null
  const need = requiredPrivilege(operation, submitter.params)
  const user = authority.user ?? submitter.user
  if (authority.privileges === null)
    return new JobForbiddenError(user, need, operation, authority.problem ?? 'no privileges')
  if (!authority.privileges.includes(need)) {
    const held = authority.privileges.length > 0 ? authority.privileges.join(',') : 'no privilege'
    return new JobForbiddenError(user, need, operation, `holds ${held} on /`)
  }
  return null
}
