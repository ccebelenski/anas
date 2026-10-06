import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { BoundId, ConfirmStore } from './confirm.js'
import { confirmGate } from './gate.js'

/**
 * Stable-id confirms (story ident.1, audit #11, P1). A confirm code used to be
 * bound to names only (`{ pool }`, `{ dataset }`, `{ snapshot }`), and the job
 * it unlocked acted on whatever carried that name when it was dequeued — a
 * pool exported and another imported under the same name, a dataset destroyed
 * and recreated, a snapshot taken after the rollback challenge listed the
 * newer ones. This is the ONE helper that closes it, in three steps:
 *
 *   1. the route reads the object's stable id (a pool or dataset `guid`; for a
 *      rollback, the target snapshot's `createtxg` AND the newest snapshot's)
 *      and binds it into the confirm signature ({@link confirmGateBound});
 *   2. a resend whose code was minted under a DIFFERENT id is answered 409
 *      `IDENTITY_MISMATCH` naming both ids, with a fresh code — the client's
 *      ordinary confirm flow prompts again, never a silent act on a namesake;
 *   3. the job re-reads the id before it acts and fails `IDENTITY_MISMATCH`
 *      when it changed while the job sat in the queue ({@link requireStableId}).
 *
 * The ids are read from the system each time (Principle 11) — nothing is kept
 * but the in-memory confirm code, which already existed.
 */

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const TXG_RE = /^\d+$/

/** The 409 / job error code for "the object under that name is not the one confirmed". */
export const IDENTITY_MISMATCH = 'IDENTITY_MISMATCH'

/** How each bound fact reads in a message. */
const LABELS: Record<string, string> = {
  guid: 'guid',
  snapshotTxg: 'snapshot createtxg',
  newestTxg: 'newest snapshot createtxg',
}

/** `guid 123` / `snapshot createtxg 5, newest snapshot createtxg 9`. */
export function describeBound(bound: BoundId | null): string {
  if (!bound)
    return 'unreadable'
  return Object.keys(bound).map(k => `${LABELS[k] ?? k} ${bound[k]}`).join(', ')
}

/** Do two bound ids carry the same facts? */
export function sameBound(a: BoundId, b: BoundId): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/** The sentence both the 409 and the failed job carry. */
export function identityMismatchMessage(what: string, confirmed: BoundId, now: BoundId | null): string {
  return `${what} is not the one that was confirmed (${describeBound(confirmed)} at the confirmation, `
    + `${describeBound(now)} now) — nothing was done; confirm again`
}

/**
 * A destructive job found a different object under the confirmed name. The
 * job queue reports it with {@link IDENTITY_MISMATCH} as the error code
 * (`jobErrorCode`), so the failure reads like the 409 a resend would get.
 */
export class IdentityMismatchError extends Error {
  readonly jobErrorCode = IDENTITY_MISMATCH
  constructor(readonly what: string, readonly confirmed: BoundId, readonly now: BoundId | null) {
    super(identityMismatchMessage(what, confirmed, now))
    this.name = 'IdentityMismatchError'
  }
}

/** One `-H -o value` read, trimmed; null on failure or an empty/`-` value. */
async function readValue(executor: CommandExecutor, command: string, args: string[]): Promise<string | null> {
  const r = await executor.exec(command, args)
  if (r.exitCode !== 0)
    return null
  const v = r.stdout.trim()
  return v && v !== '-' ? v : null
}

/** A pool's stable id: `zpool get -H -o value guid <pool>`. */
export async function readPoolGuid(executor: CommandExecutor, pool: string): Promise<BoundId | null> {
  const guid = await readValue(executor, ZPOOL, ['get', '-H', '-o', 'value', 'guid', pool])
  return guid ? { guid } : null
}

/** A dataset's stable id: `zfs get -H -o value guid <dataset>`. */
export async function readDatasetGuid(executor: CommandExecutor, dataset: string): Promise<BoundId | null> {
  const guid = await readValue(executor, ZFS, ['get', '-H', '-o', 'value', 'guid', dataset])
  return guid ? { guid } : null
}

/**
 * A rollback's stable id: the target snapshot's `createtxg` and the NEWEST
 * snapshot's (`zfs list -t snapshot -Hp -o name,createtxg -d 1 <dataset>`). A
 * snapshot taken after the challenge moves `newestTxg` — `rollback -r` would
 * destroy a snapshot the operator was never shown, so it is a mismatch. Null
 * when the list fails or the target is gone.
 */
export async function readRollbackIds(executor: CommandExecutor, dataset: string, snapshot: string): Promise<BoundId | null> {
  const r = await executor.exec(ZFS, ['list', '-t', 'snapshot', '-Hp', '-o', 'name,createtxg', '-d', '1', dataset])
  if (r.exitCode !== 0)
    return null
  let snapshotTxg: string | null = null
  let newest: bigint | null = null
  for (const line of r.stdout.split('\n')) {
    const [name, txg] = line.trim().split('\t')
    if (!name || !txg || !TXG_RE.test(txg))
      continue
    if (name === snapshot)
      snapshotTxg = txg
    const n = BigInt(txg)
    if (newest === null || n > newest)
      newest = n
  }
  if (snapshotTxg === null || newest === null)
    return null
  return { snapshotTxg, newestTxg: newest.toString() }
}

/**
 * The job-side check: re-read the id and throw {@link IdentityMismatchError}
 * when it is gone or differs from the one the confirm was bound to.
 */
export async function requireStableId(what: string, confirmed: BoundId, read: () => Promise<BoundId | null>): Promise<void> {
  const now = await read()
  if (!now || !sameBound(confirmed, now))
    throw new IdentityMismatchError(what, confirmed, now)
}

/**
 * {@link confirmGate} with the stable id bound into the signature. A resend
 * whose code was minted for the same operation and params under a different
 * id gets 409 {@link IDENTITY_MISMATCH} — the message names both ids, the
 * first warning says so, and a fresh `X-Anas-Confirm-Code` lets the client's
 * ordinary confirm flow prompt again. Everything else is confirmGate as-is.
 */
export function confirmGateBound(
  store: ConfirmStore,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: {
    operation: string
    params: Record<string, unknown>
    /** The id read just now ({@link readPoolGuid}, {@link readDatasetGuid}, {@link readRollbackIds}). */
    bound: BoundId
    /** The object, as a message names it (`Pool 'tank'`). */
    what: string
    message: string
    warnings: string[]
  },
): boolean {
  const provided = request.headers['x-anas-confirm']
  if (typeof provided === 'string') {
    const was = store.takeBoundMismatch(provided, opts.operation, opts.params, opts.bound)
    if (was) {
      const { code, expiresAt } = store.generateCode(opts.operation, opts.params, opts.bound)
      reply.code(409)
      reply.header('X-Anas-Confirm-Code', code)
      reply.header('X-Anas-Confirm-Expires', expiresAt)
      reply.send({
        error: {
          code: IDENTITY_MISMATCH,
          message: identityMismatchMessage(opts.what, was, opts.bound),
          warnings: [
            `${opts.what} changed since you confirmed (${describeBound(was)} then, ${describeBound(opts.bound)} now). Confirm again only if this is the one you mean.`,
            ...opts.warnings,
          ],
          confirmed: was,
          current: opts.bound,
        },
      })
      return false
    }
  }
  return confirmGate(store, request, reply, opts)
}
