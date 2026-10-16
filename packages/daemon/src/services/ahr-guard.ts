import type { AhrPool, IscsiHeldByLun } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { JobQueue, LockClaim, LockMode } from '../jobs/queue.js'
import type { Gate, GuardBound, GuardReads, ObjectView, Refusal } from '../safety/guard.js'
import type { PoolIntent } from './ahr-intent.js'
import type { IscsiClaimCache } from './iscsi-held.js'
import type { IscsiPaths } from './iscsi.js'
import { currentLane } from '../executor/deadline.js'
import { ahrPoolClaims, diskClaim } from '../safety/guard.js'
import { readPoolIntent } from './ahr-intent.js'
import { AHR_FINDMNT_ARGS, readAhrPools } from './ahr-topology.js'
import { createIscsiClaimCache, heldByLun, heldByLunRefusal } from './iscsi-held.js'
import { ahrSystemMountRefusal, systemMountPoolsFromJson } from './system-mounts.js'

/**
 * The AHR verbs' shared guard pieces (story cr.38 session A, WAVE3-DESIGN §2.3,
 * §3, §4.2; ruling (j)). Every short AHR verb describes itself as a
 * `GuardSpec<AhrPool>` built from these: the pool `readAhrPools` names now,
 * bound to its identity, the gates both doors run, and the pool's lock keys.
 *
 * One fact, one gate: the system-pool question, the LUN-held question and
 * the expansion-intent question are each answered here once, and every verb
 * that asks them asks this module.
 */

const FINDMNT = '/usr/bin/findmnt'

/**
 * Is an iSCSI LUN's image file living on this AHR pool (story iscsi.6)?
 *
 * A file on the btrfs volume IS the AHR block object — AHR's only backing kind
 * — so it is matched two ways: by the pool NAME (`classifyBacking` resolves an
 * AHR-hosted file onto its pool) and by the MOUNTPOINT (which still answers
 * when the pool could not be classified). `rm` of a backing file succeeds
 * silently and LIO keeps serving the unlinked inode (GT-40), so an unmount, a
 * destroy — or a rollback swapping `@data` out from under the file (issue #51)
 * — is data loss with no error anywhere.
 *
 * Moved here from routes/ahr-mutate.ts (cr.38) so the guard's LUN gate and the
 * routes that still ask it directly (parity rewrite, mirror reconcile) run the
 * SAME check — one source, one phrasing. ahr-mutate re-exports it.
 */
export async function ahrPoolHeldByLun(
  executor: CommandExecutor,
  iscsiPaths: IscsiPaths,
  pool: { name: string, mountpoint: string, mounted: boolean },
  cache: IscsiClaimCache = createIscsiClaimCache(executor, iscsiPaths),
): Promise<IscsiHeldByLun | null> {
  const subject: { pool: string, path?: string } = { pool: pool.name }
  if (pool.mounted && pool.mountpoint.startsWith('/'))
    subject.path = pool.mountpoint
  return heldByLun(cache, subject)
}

/**
 * The hard-409 body for a held pool — ONE shape (`CONFLICT` /
 * `reason: 'held-by-lun'`, no confirm bypass in the text) for every caller.
 * `heldByLunRefusal` writes the message; this shapes the response.
 */
export function ahrHeldByLunConflict(what: string, action: string, held: IscsiHeldByLun) {
  const refusal = heldByLunRefusal(what, action, held)
  return { error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } }
}

/** The pool's array UUIDs, sorted — part of every AHR verb's bound identity. */
export function poolArrayUuids(pool: Pick<AhrPool, 'arrays'>): string[] {
  return pool.arrays.map(a => a.uuid ?? `unknown:${a.band}`).sort()
}

/**
 * The §4 pre-check of an expansion, as one function for both doors (story
 * cr.38 session B; the expand route's `refuseDegraded` since Epic 11.6): never
 * start a reshape on a degraded, inactive, failed, read-only or offline pool.
 * `inactive` and `offline` are named for their own reason — an unassembled
 * volume has no double-failure window, it has nothing to reshape. A hard 409,
 * no confirm bypass.
 */
export function expansionStateRefusal(pool: Pick<AhrPool, 'name' | 'state' | 'arrays'>): Refusal | null {
  const badArray = pool.arrays.find(a => a.state === 'degraded' || a.state === 'inactive' || a.state === 'failed')
  if (!badArray && pool.state !== 'offline' && pool.state !== 'failed' && pool.state !== 'readonly')
    return null
  const unreachable = pool.state === 'offline' || badArray?.state === 'inactive'
  const what = badArray
    ? `array ${pool.name}-r${badArray.band} is ${badArray.state}`
    : `pool '${pool.name}' is ${pool.state}`
  const why = unreachable
    ? `The volume is not assembled, so there is nothing to reshape — bring the pool back online first.`
    : `Reshaping a degraded pool voluntarily enters the double-failure window (§4) — replace/rebuild first.`
  return { status: 409, code: 'CONFLICT', message: `Cannot expand: ${what}. ${why} This refusal has no confirm bypass.` }
}

/**
 * The LIO-unreadable disclosure advisory, shared by every AHR verb and the
 * ZFS doors — the key, the sentence and the read-failed test live in ONE place
 * (`services/iscsi-held.ts`), so a new door cannot drift the wording.
 */
export { lioUnreadableAdvisory } from './iscsi-held.js'

export interface AhrGuardDeps {
  executor: CommandExecutor
  /** AhrExpansionIntent store directory. */
  intentDir: string
  /**
   * The iSCSI read-layer paths (a function: the snapshot routes read the
   * server's decorated object lazily, after registration).
   */
  iscsiPaths: () => IscsiPaths
  /** The queue — only the destroy's in-flight gate reads it. */
  jobQueue?: JobQueue
  /** mdadm.conf override for the topology read (routes that never passed one leave it out). */
  mdadmConfPath?: string
}

/** The shared reads, gates, object view and lock claims of the AHR verbs. */
export function ahrGuard(deps: AhrGuardDeps) {
  const { executor, intentDir } = deps

  /** One guard run's reads (never shared between the route's run and the job's). */
  const reads = {
    /** The AHR topology — every pool `readAhrPools` names now. */
    pools: (r: GuardReads): Promise<AhrPool[]> => r.once('ahr-pools', () => readAhrPools(executor, deps.mdadmConfPath)),
    /** `findmnt` in the AHR table shape — the system-pool gate and the mountpoint collision gate share it. */
    findmnt: (r: GuardReads): Promise<ExecResult> => r.once('ahr-findmnt', () => executor.exec(FINDMNT, AHR_FINDMNT_ARGS)),
    /** The LIO claims, read once per run (the gate and the LIO-unreadable advisory share it). */
    claims: (r: GuardReads): Promise<IscsiClaimCache> => r.once('iscsi-claims', async () => createIscsiClaimCache(executor, deps.iscsiPaths())),
    /** This pool's expansion intent (a stale one, an earlier namesake's, reads as none — ident.3). */
    intent: (r: GuardReads, pool: AhrPool): Promise<PoolIntent> => r.once(`ahr-intent:${pool.name}`, () => readPoolIntent(pool, intentDir)),
  }

  /**
   * An existing AHR pool as a guard object: the pool the topology names now,
   * bound to its identity — the sorted band array UUIDs (what destroy bound
   * since ident.3) plus the VG UUID when `vgs` reports it (§3.3). A pool
   * destroyed and re-created under the same name between the confirm and the
   * job is another pool: the job fails IDENTITY_MISMATCH and nothing runs.
   */
  function poolView(name: string, noun: string): ObjectView<AhrPool> {
    return {
      what: `AHR pool '${name}'`,
      read: async r => (await reads.pools(r)).find(p => p.name === name) ?? null,
      id: async pool => ({
        arrays: poolArrayUuids(pool).join(','),
        ...(pool.vg.uuid ? { vgUuid: pool.vg.uuid } : {}),
      }),
      unbound: () => `Could not read the identity of AHR pool '${name}' — refusing ${noun} that cannot be bound to it`,
    }
  }

  /**
   * The SYSTEM-POOL gate (story cr.23, a gate at both doors since cr.38): an
   * AHR pool has no boot facts, so the live mount table is its whole answer —
   * one of its own filesystems at a system path, or an UNREADABLE table (fail
   * closed: a missing fact may only tighten the gate), is a hard 409, no
   * confirm bypass.
   */
  const systemPoolGate: Gate<AhrPool> = async (pool, r) => {
    const res = await reads.findmnt(r)
    const refusal = ahrSystemMountRefusal(pool.name, res.exitCode === 0 ? systemMountPoolsFromJson(res.stdout) : null)
    return refusal ? { status: 409, code: 'CONFLICT', reason: refusal.reason, message: refusal.message } : null
  }

  /**
   * The HELD-BY-LUN gate (story iscsi.6, re-run in the job since cr.38): a
   * LUN's image file on the pool makes the verb unsafe NOW — a hard 409, no
   * confirm bypass. `what` names the object in the sentence (`the mountpoint
   * of AHR pool 'x'`), `action` the verb (`Destroying`).
   */
  function lunGate(action: string, what?: (pool: AhrPool) => string): Gate<AhrPool> {
    return async (pool, r) => {
      const held = await ahrPoolHeldByLun(executor, deps.iscsiPaths(), pool, await reads.claims(r))
      if (!held)
        return null
      const refusal = heldByLunRefusal(what ? what(pool) : `AHR pool '${pool.name}'`, action, held)
      return { status: 409, code: 'CONFLICT', reason: refusal.reason, message: refusal.message }
    }
  }

  /**
   * The EXPANSION-INTENT gate (spare, cache and snapshot verbs; re-run in the
   * job since cr.38): while this pool has an expansion intent its band
   * geometry and VG shape are in flight, so the verb waits. `consequence`
   * completes the sentence for the verb.
   */
  function intentGate(consequence: string): Gate<AhrPool> {
    return async (pool, r) => {
      const existing = (await reads.intent(r, pool)).intent
      return existing
        ? { status: 409, code: 'CONFLICT', message: `Pool '${pool.name}' has an expansion intent (state '${existing.state}') — ${consequence}.` }
        : null
    }
  }

  /**
   * Every AHR job in flight on the pool, by operation family: destroy refuses
   * while any of them is queued or running (story ident.3 (d)) — at the route
   * and, since cr.38, again in its own job.
   *
   * In the job only a job submitted BEFORE it counts (cr.63, review L18): the
   * queue's own submission order (`findActive`'s `before:` option, cr.38 —
   * the order the queue grants in, never wall time), the question the repair
   * family's re-check already asks. A job submitted AFTER the destroy passed
   * its route — a timer's scrub while the confirmed destroy waits for a slot —
   * is not in the destroy's way: it queues behind the destroy's exclusive key
   * and its own re-check finds the pool gone. Counting it refused a confirmed
   * destroy for a job that could not have run first. The job's own record is
   * never the answer either: the scan stops at it. At the route there is no
   * job yet, so every job in flight counts.
   */
  function inFlightGate(operations: readonly string[]): Gate<AhrPool> {
    return async (pool) => {
      const queue = deps.jobQueue
      if (!queue)
        return null
      const self = currentLane().jobId
      for (const operation of operations) {
        for (const key of ['name', 'pool']) {
          const busy = queue.findActive(operation, pool.name, key, undefined, self ? { before: self } : {})
          if (busy) {
            return {
              status: 409,
              code: 'CONFLICT',
              message: `AHR pool '${pool.name}' has a ${busy.operation} job in flight (job ${busy.id}). Wait for it to finish (or cancel it) before destroying the pool`,
            }
          }
        }
      }
      return null
    }
  }

  /**
   * The pool's lock claims (§4.2): `ahr:<vg uuid>` in `mode` (the name key
   * alone when the VG UUID is unreadable), `ahrname:<name>` for a namespace
   * verb, and one `disk:` key per whole disk the verb writes.
   */
  function claims(pool: AhrPool, _bound: GuardBound, mode: LockMode, opts: { namespace?: boolean, disks?: string[], extra?: LockClaim[] } = {}): LockClaim[] {
    const disks = [...new Set(opts.disks ?? [])]
    disks.sort()
    return [...ahrPoolClaims(pool.name, pool.vg.uuid, mode, { namespace: opts.namespace }), ...disks.map(id => diskClaim(id)), ...(opts.extra ?? [])]
  }

  return { reads, poolView, systemPoolGate, lunGate, intentGate, inFlightGate, claims }
}

export type AhrGuard = ReturnType<typeof ahrGuard>
