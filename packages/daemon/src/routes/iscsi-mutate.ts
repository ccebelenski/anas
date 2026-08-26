import type { IscsiClaimList, IscsiLun, IscsiTargetDetail } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { IscsiBackstoreAttributes, IscsiMutateOptions, IscsiRefusal, ResolvedAhrPool } from '../services/iscsi-mutate.js'
import type { IscsiPaths } from '../services/iscsi.js'
import {
  aclAuthRequirement,
  aclSatisfiesAuth,
  AddIscsiLunRequest,
  CreateIscsiTargetRequest,
  DeleteIscsiLunQuery,
  IscsiIqn,
  IscsiTargetStateRequest,
  UpdateIscsiLunRequest,
  UpdateIscsiTargetRequest,
} from '@anas/shared'
import { confirmGate } from '../safety/gate.js'
import { ensureAhrTargetOrdering } from '../services/ahr-create.js'
import { CONFIGFS_TARGET_ROOT } from '../services/iscsi-configfs.js'
import {
  addIscsiLun,
  assertInstalled,
  assertSaveable,
  claimsFromTargets,
  createIscsiTarget,
  createSparseImage,
  deleteIscsiLun,
  deleteIscsiTarget,
  growZvolLun,
  imageFilePath,
  newSerial,
  newTargetIqn,
  readIscsiState,
  replayAttributes,
  resizeFileLun,
  resolveFileBackingDir,
  resolveZvolBacking,
  saveIscsiConfig,
  setIscsiTargetState,
  setLunWriteBack,
  updateIscsiTarget,
  withIscsiLock,
  zvolDataset,
} from '../services/iscsi-mutate.js'
import { readIscsiHealthWithQuarantine } from '../services/iscsi-quarantine.js'
import { assertRepairable, planIscsiRepair, repairIscsiHoles } from '../services/iscsi-repair.js'
import { iscsiAvailability } from '../services/iscsi.js'
import { requireIdentity } from './identity.js'

/**
 * iSCSI — the MUTATION layer (story `iscsi.4`).
 *
 *   POST   /v1/iscsi/targets                      create a target
 *   PUT    /v1/iscsi/targets/:iqn                 portals / ACLs / auth / secrets
 *   POST   /v1/iscsi/targets/:iqn/state           enable | disable
 *   DELETE /v1/iscsi/targets/:iqn                 delete (sessions → 409 + confirm)
 *   POST   /v1/iscsi/targets/:iqn/luns            add a LUN (zvol | file)
 *   PUT    /v1/iscsi/targets/:iqn/luns/:n         grow / write-cache
 *   DELETE /v1/iscsi/targets/:iqn/luns/:n         unmap + delete backstore
 *   POST   /v1/iscsi/health/repair                put a boot-restore hole back
 *   GET    /v1/iscsi/claims                       the iscsi.6 seam
 *
 * Every mutation is a job (202) with a journald audit line through the queue,
 * and every one of them runs its whole `targetcli` sequence under the single
 * daemon-wide iSCSI mutex — `targetcli` is not transactional and a half-applied
 * sequence has no rollback (GT-5).
 *
 * Three pre-flight refusals happen HERE rather than inside the job, because a
 * refusal the operator can act on is worth more than a failed job:
 *
 *  - **LIO not installed** — a guiding 409 naming the two packages. `install.sh`
 *    installs them like samba/nfs since `iscsi.5`; this refusal is what a node
 *    that predates that (or had them removed) gets.
 *  - **A degraded restore** — a 409 naming the missing LUNs. Every sequence ends
 *    in `saveconfig`, and saving over an incomplete restore writes the hole into
 *    `saveconfig.json` permanently (GT-22). `POST /iscsi/health/repair` is the
 *    ONE route exempt from this gate, because it is the way out of it.
 *  - **A live session**, on the operations where one makes the result silently
 *    wrong. LIO offers no protection at all here: a LUN delete or backstore
 *    delete with a live session returns exit 0, leaves a stale device on the
 *    initiator and produces no kernel message until the next rescan (GT-42).
 *    Every session gate is ANAS's own.
 *
 * The gates differ in altitude on purpose. Deleting a TARGET is confirm-gated —
 * the operator may well mean it, and the consequence (every session drops) is
 * describable. Resizing or deleting a LUN with a live session is a hard 409 with
 * no bypass: the initiator has the device open and its filesystem mounted, and
 * there is no confirmation that makes that safe from this side.
 */
export interface IscsiMutateRouteOptions extends IscsiPaths {
  executor: CommandExecutor
  jobQueue: JobQueue
  confirmStore: ConfirmStore
  /**
   * `/etc/fstab` — written surgically, and for exactly one reason: an image LUN
   * placed on an AHR pool adds `x-systemd.before=rtslib-fb-targetctl.service` to
   * that pool's line so the pool is mounted before LIO restores (story
   * `iscsi.8`). Defaults to the real file; the tests point it at a temp copy.
   */
  fstabPath?: string
}

/**
 * Send an `IscsiRefusal` as a 409 with no confirm code (Principle 14, Level 1).
 *
 * It SENDS rather than returning a body, because two of its callers sit inside a
 * helper whose own return value is a null sentinel — a refusal that only built a
 * body there would leave the request hanging forever with a status and no
 * payload. Returning `reply` keeps `return sendRefusal(...)` working at the
 * call sites that are already inside a handler.
 */
function sendRefusal(reply: FastifyReply, refusal: IscsiRefusal): FastifyReply {
  reply.code(409)
  reply.send({ error: { code: 'CONFLICT', reason: refusal.reason, message: refusal.message } })
  return reply
}

export async function iscsiMutationRoutes(server: FastifyInstance, opts: IscsiMutateRouteOptions) {
  const { executor, jobQueue, confirmStore, fstabPath = '/etc/fstab', ...paths } = opts
  const configfsRoot = paths.configfsRoot ?? CONFIGFS_TARGET_ROOT

  /** The mutation context every sequence gets: executor, configfs root, progress. */
  function mutateOptions(progress?: (m: string) => void): IscsiMutateOptions {
    return progress ? { executor, configfsRoot, progress } : { executor, configfsRoot }
  }

  /**
   * The pre-flight every mutation shares: read the whole state ONCE, then refuse
   * if LIO is absent or the live tree is a known incomplete restore.
   *
   * The degraded snapshot is deliberately taken before the sequence starts and
   * never recomputed mid-flight: a fileio resize deletes its own backstore and
   * would look "degraded" to a naive re-check, when in fact the only thing
   * missing is the one this code is in the middle of putting back.
   */
  async function preflight(reply: FastifyReply): Promise<
    { ctx: Awaited<ReturnType<typeof readIscsiState>>['ctx'], targets: IscsiTargetDetail[] } | null
  > {
    const state = await readIscsiState(executor, paths)
    const notInstalled = assertInstalled(state.ctx)
    if (notInstalled) {
      sendRefusal(reply, notInstalled)
      return null
    }
    const degraded = assertSaveable(state.ctx, state.targets)
    if (degraded) {
      sendRefusal(reply, degraded)
      return null
    }
    return state
  }

  /** Parse + validate the `:iqn` path parameter. */
  function parseIqn(raw: string, reply: FastifyReply): string | null {
    const parsed = IscsiIqn.safeParse(raw)
    if (!parsed.success) {
      reply.code(400)
      reply.send({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Invalid iSCSI target name: ${parsed.error.issues[0]?.message ?? 'not an iSCSI name'}`,
        },
      })
      return null
    }
    return parsed.data
  }

  /** Find a target, 404 with a sentence when it is not there. */
  function findTarget(targets: IscsiTargetDetail[], iqn: string, reply: FastifyReply): IscsiTargetDetail | null {
    const target = targets.find(t => t.iqn === iqn)
    if (!target) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `iSCSI target '${iqn}' not found` } })
      return null
    }
    return target
  }

  /**
   * A foreign target is hands-off, the same way a PVE-managed pool is (3.25).
   * The verdict and the reason both come from the read layer, so the refusal
   * says WHY rather than merely saying no.
   */
  function rejectForeign(target: IscsiTargetDetail, reply: FastifyReply): boolean {
    if (target.ownership === 'anas')
      return false
    reply.code(409)
    reply.send({
      error: {
        code: 'CONFLICT',
        reason: 'foreign-target',
        message: `Target '${target.iqn}' is not managed by ANAS and is hands-off: ${target.ownershipDetail}`,
      },
    })
    return true
  }

  /** The LUN at index `n`, or a 404. */
  function findLun(target: IscsiTargetDetail, index: number, reply: FastifyReply): IscsiLun | null {
    const lun = target.luns.find(l => l.index === index)
    if (!lun) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `Target '${target.iqn}' has no LUN ${index}` } })
      return null
    }
    return lun
  }

  // --- POST /iscsi/targets -------------------------------------------------
  server.post('/iscsi/targets', async (request, reply) => {
    const parsed = CreateIscsiTargetRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create target request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const state = await preflight(reply)
    if (!state)
      return reply

    // The IQN is GENERATED, never supplied: LIO has no rename (GT-10), so it is
    // the target's identity for life and must follow the one convention the read
    // layer recognises.
    const iqn = newTargetIqn(req.name)
    if (state.targets.some(t => t.iqn === iqn)) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'target-exists',
          message: `A target named '${req.name}' already exists on this node (${iqn}). There is no rename in LIO — pick another name.`,
        },
      }
    }

    // A portal on an address no interface carries binds happily, shows [OK] and
    // never logs a word (GT-24), so the warning has to come from ANAS or from
    // nowhere. It is a warning, not a refusal: an address that is about to exist
    // is a legitimate thing to configure.
    const warnings = portalAddressWarnings(state.ctx.nodeAddresses, req.portals)

    const job = jobQueue.submit(
      'iscsi.target.create',
      { ...identity, params: { target: iqn, portals: req.portals.length, acls: req.acls.length, auth: req.auth } },
      async updateProgress => withIscsiLock(async () => {
        const result = await createIscsiTarget(mutateOptions(updateProgress), req, iqn)
        return { ...result, warnings }
      }),
    )

    reply.code(202)
    return { job }
  })

  // --- PUT /iscsi/targets/:iqn ---------------------------------------------
  server.put<{ Params: { iqn: string } }>('/iscsi/targets/:iqn', async (request, reply) => {
    const iqn = parseIqn(request.params.iqn, reply)
    if (!iqn)
      return reply

    const parsed = UpdateIscsiTargetRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update target request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const state = await preflight(reply)
    if (!state)
      return reply
    const target = findTarget(state.targets, iqn, reply)
    if (!target)
      return reply
    if (rejectForeign(target, reply))
      return reply

    // "CHAP is on but this initiator can never log in" is checked against the
    // MERGED state, not the request: an edit that only rotates one secret leaves
    // every other credential alone, and the stored ones still count.
    const auth = req.auth ?? (target.security.authentication ? 'chap' : 'none')
    if (auth !== 'none' && req.acls !== undefined) {
      for (const acl of req.acls) {
        const stored = target.acls.find(a => a.initiatorIqn === acl.initiatorIqn)
        const merged = {
          chapUserid: acl.chapUserid !== undefined ? acl.chapUserid : stored?.chapUserid ?? null,
          chapSecret: acl.chapSecret !== undefined ? acl.chapSecret : (stored?.chapCredentialsSet ? 'stored' : null),
          mutualUserid: acl.mutualUserid !== undefined ? acl.mutualUserid : stored?.mutualUserid ?? null,
          mutualSecret: acl.mutualSecret !== undefined ? acl.mutualSecret : (stored?.mutualCredentialsSet ? 'stored' : null),
        }
        if (!aclSatisfiesAuth(merged, auth)) {
          reply.code(400)
          return {
            error: {
              code: 'VALIDATION_ERROR',
              message: `Initiator ${acl.initiatorIqn} would never be able to log in: ${aclAuthRequirement(auth)}`,
            },
          }
        }
      }
    }

    // Removing an ACL is not a metadata edit: it drops that initiator's session
    // instantly and destroys its CHAP credentials (GT-36). Say so, and gate it.
    const removedWithSessions = req.acls === undefined
      ? []
      : target.sessions
          .filter(s => !req.acls?.some(a => a.initiatorIqn === s.initiatorIqn))
          .map(s => s.initiatorIqn)
    if (removedWithSessions.length > 0) {
      if (!confirmGate(confirmStore, request, reply, {
        operation: 'iscsi.target.update',
        params: { target: iqn },
        message: `Removing ${removedWithSessions.length} initiator ACL${removedWithSessions.length === 1 ? '' : 's'} will drop ${removedWithSessions.length === 1 ? 'its' : 'their'} live session immediately`,
        warnings: removedWithSessions.map(i => `${i} is logged in now — its session drops the moment the ACL is removed, and its device on that host goes stale with no kernel message`),
      })) {
        return reply
      }
    }

    const warnings = req.portals ? portalAddressWarnings(state.ctx.nodeAddresses, req.portals) : []

    const job = jobQueue.submit(
      'iscsi.target.update',
      // The SHAPE of the change rides the audit line; no secret ever does.
      {
        ...identity,
        params: {
          target: iqn,
          ...(req.auth !== undefined ? { auth: req.auth } : {}),
          ...(req.portals !== undefined ? { portals: req.portals.length } : {}),
          ...(req.acls !== undefined ? { acls: req.acls.length } : {}),
        },
      },
      async updateProgress => withIscsiLock(async () => {
        const result = await updateIscsiTarget(mutateOptions(updateProgress), target, req)
        return { ...result, warnings }
      }),
    )

    reply.code(202)
    return { job }
  })

  // --- POST /iscsi/targets/:iqn/state --------------------------------------
  server.post<{ Params: { iqn: string } }>('/iscsi/targets/:iqn/state', async (request, reply) => {
    const iqn = parseIqn(request.params.iqn, reply)
    if (!iqn)
      return reply

    const parsed = IscsiTargetStateRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid state request: ${parsed.error.issues[0]?.message}` } }
    }
    const { action } = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const state = await preflight(reply)
    if (!state)
      return reply
    const target = findTarget(state.targets, iqn, reply)
    if (!target)
      return reply
    if (rejectForeign(target, reply))
      return reply

    if (target.enabled === (action === 'enable')) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Target '${iqn}' is already ${action}d` } }
    }

    // `disable` refuses NEW logins; the portal socket stays open and an
    // established session keeps running (GT-37). Saying so is the difference
    // between a control that works and a control that lies.
    const warnings = action === 'disable' && target.sessionCount > 0
      ? [`${target.sessionCount} session${target.sessionCount === 1 ? '' : 's'} stay connected — disabling a TPG refuses new logins and hides the target from discovery, but it does not close the portal or drop an established session`]
      : []

    const job = jobQueue.submit(
      `iscsi.target.${action}`,
      { ...identity, params: { target: iqn } },
      async updateProgress => withIscsiLock(async () => {
        const result = await setIscsiTargetState(mutateOptions(updateProgress), target, action)
        return { ...result, warnings }
      }),
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /iscsi/targets/:iqn ------------------------------------------
  server.delete<{ Params: { iqn: string } }>('/iscsi/targets/:iqn', async (request, reply) => {
    const iqn = parseIqn(request.params.iqn, reply)
    if (!iqn)
      return reply

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const state = await preflight(reply)
    if (!state)
      return reply
    const target = findTarget(state.targets, iqn, reply)
    if (!target)
      return reply
    if (rejectForeign(target, reply))
      return reply

    const initiators = target.sessions.map(s => s.initiatorIqn)
    const warnings: string[] = []
    if (initiators.length > 0) {
      warnings.push(
        ...initiators.map(i => `${i} is logged in now — deleting the target drops its session immediately and its device on that host goes stale with no kernel message`),
      )
    }
    if (target.luns.length > 0) {
      warnings.push(
        `${target.luns.length} LUN${target.luns.length === 1 ? '' : 's'} will be unmapped and their backstores deleted. The data is NOT destroyed — `
        + `the volumes and image files stay: ${target.luns.map(l => l.backingPath).filter(Boolean).join(', ')}`,
      )
    }
    warnings.push(`The IQN ${iqn} goes with it — an initiator configured against it must be repointed, and there is no way to recreate a target under the same IQN with the same LUN identities except by adding the same LUNs back`)

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'iscsi.target.delete',
      params: { target: iqn },
      message: initiators.length > 0
        ? `Target '${iqn}' has ${initiators.length} live session${initiators.length === 1 ? '' : 's'}; deleting it drops ${initiators.length === 1 ? 'it' : 'them'}`
        : `Deleting target '${iqn}' unmaps its LUNs and removes the target`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'iscsi.target.delete',
      { ...identity, params: { target: iqn, sessions: initiators.length } },
      async updateProgress => withIscsiLock(async () => {
        const result = await deleteIscsiTarget(mutateOptions(updateProgress), target, state.targets)
        return { ...result, droppedSessions: initiators }
      }),
    )

    reply.code(202)
    return { job }
  })

  // --- POST /iscsi/targets/:iqn/luns ---------------------------------------
  server.post<{ Params: { iqn: string } }>('/iscsi/targets/:iqn/luns', async (request, reply) => {
    const iqn = parseIqn(request.params.iqn, reply)
    if (!iqn)
      return reply

    const parsed = AddIscsiLunRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid add LUN request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const state = await preflight(reply)
    if (!state)
      return reply
    const target = findTarget(state.targets, iqn, reply)
    if (!target)
      return reply
    if (rejectForeign(target, reply))
      return reply

    // The backstore name is a GLOBAL namespace in LIO, not per-target, and it is
    // the SCSI model string every initiator sees (GT-15) — a collision is a
    // create failure at best and a confusing duplicate model string at worst.
    const nameTaken = state.targets.some(t => t.luns.some(l => l.name === req.name))
    if (nameTaken) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'name-taken',
          message: `A LUN named '${req.name}' already exists on this node. The name is the SCSI model string initiators see, so it has to be unique.`,
        },
      }
    }

    // Resolve the backing object — the one place a PVE guest disk or a
    // foreign pool is turned away (reusing iscsi.2's classifyBacking).
    let backingPath: string
    let plugin: 'block' | 'fileio'
    let dataset: string | undefined
    let size: number | null = null
    /** Set when the image lands on an AHR pool — the boot-ordering half. */
    let ahrPool: ResolvedAhrPool | undefined
    if (req.kind === 'zvol') {
      const resolved = resolveZvolBacking(req.backing, state.ctx)
      if ('refusal' in resolved)
        return sendRefusal(reply, resolved.refusal)
      backingPath = resolved.ok.path
      plugin = 'block'
      dataset = resolved.ok.dataset
      const claimed = state.targets.some(t => t.luns.some(l => l.backingPath === backingPath))
      if (claimed) {
        reply.code(409)
        return {
          error: {
            code: 'CONFLICT',
            reason: 'backing-already-mapped',
            message: `${backingPath} is already exported as a LUN on this node — exporting one block device through two LUNs invites two initiators to write to it at once`,
          },
        }
      }
    }
    else {
      const dir = await resolveFileBackingDir(executor, req.backing, state.ctx)
      if ('refusal' in dir)
        return sendRefusal(reply, dir.refusal)
      backingPath = imageFilePath(dir.ok.dir, req.name)
      plugin = 'fileio'
      dataset = dir.ok.dataset
      size = req.size ?? null
      ahrPool = dir.ok.ahr
    }

    const serial = newSerial()
    const job = jobQueue.submit(
      'iscsi.lun.add',
      { ...identity, params: { target: iqn, lun: req.name, kind: req.kind, backing: backingPath, ...(size !== null ? { size } : {}) } },
      async updateProgress => withIscsiLock(async () => {
        if (req.kind === 'file' && size !== null) {
          updateProgress(`Creating sparse image ${backingPath}`)
          await createSparseImage(backingPath, size)
        }
        // The moment an image LUN lands on an AHR pool, that pool's boot
        // ordering starts to matter: a `nofail` fstab mount has no static anchor
        // any drop-in can name, so without this the pool can lose the race to
        // `rtslib-fb-targetctl` and LIO CREATES a 0-byte placeholder at the
        // image's path — an empty disk with the right serial (live-proof F2).
        // Surgical, byte-identical when already present, never fatal.
        if (ahrPool) {
          const added = await ensureAhrTargetOrdering(executor, fstabPath, ahrPool)
          if (added)
            updateProgress(`Ordered the mount of AHR pool '${ahrPool.name}' before the iSCSI restore service`)
        }
        const result = await addIscsiLun(
          mutateOptions(updateProgress),
          target,
          req,
          { path: backingPath, plugin, ...(dataset ? { dataset } : {}) },
          size,
          serial,
        )
        return { ...result, warnings: lunAttributeWarnings(plugin) }
      }),
    )

    reply.code(202)
    return { job }
  })

  // --- PUT /iscsi/targets/:iqn/luns/:n -------------------------------------
  server.put<{ Params: { iqn: string, n: string } }>('/iscsi/targets/:iqn/luns/:n', async (request, reply) => {
    const iqn = parseIqn(request.params.iqn, reply)
    if (!iqn)
      return reply
    const index = parseLunIndex(request.params.n, reply)
    if (index === null)
      return reply

    const parsed = UpdateIscsiLunRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update LUN request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const state = await preflight(reply)
    if (!state)
      return reply
    const target = findTarget(state.targets, iqn, reply)
    if (!target)
      return reply
    if (rejectForeign(target, reply))
      return reply
    const lun = findLun(target, index, reply)
    if (!lun)
      return reply

    // The size checks come FIRST so a shrink is refused as a SHRINK even when a
    // session is also open: "this would destroy data past the new end" is the
    // fact the operator needs, and "log the initiator out" would be misleading
    // advice — logging out would not make the shrink safe.
    if (req.size !== undefined) {
      if (lun.size !== null && req.size < lun.size) {
        reply.code(409)
        return {
          error: {
            code: 'CONFLICT',
            reason: 'shrink',
            message: `LUN ${index} is ${lun.size} bytes; ${req.size} bytes would SHRINK it. `
              + `Anything written past the new end — a partition table, a filesystem, a database — would be gone, `
              + `and neither ZFS nor LIO would refuse or warn. This refusal has no confirm bypass.`,
          },
        }
      }
      if (lun.kind === 'foreign') {
        reply.code(409)
        return {
          error: {
            code: 'CONFLICT',
            reason: 'foreign-backing',
            message: `LUN ${index} is backed by ${lun.backingPath}, which is not storage ANAS manages — it cannot be resized from here`,
          },
        }
      }
    }

    // GT-42: LIO offers NO protection here, so every session gate is ANAS's own.
    //
    // ONE exception, and it is not a softening: **growing a zvol is live**
    // (GT-28). Nothing is unmapped, no backstore is recreated, the LUN keeps its
    // identity and the initiator picks the new size up on its next rescan. That
    // is exactly what `iscsi.3` already allows through the Datasets door on the
    // same held zvol — and live-proof F13 caught the two doors disagreeing about
    // the same safe operation, which is worse than either rule alone: a user who
    // meets this refusal first concludes it cannot be done.
    //
    // A FILE resize stays refused, because it is a different operation wearing
    // the same name: the size of a fileio backing is fixed at creation (GT-29),
    // so ANAS unmaps the LUN, deletes the backstore, grows the file and recreates
    // it — under a mounted filesystem, with no kernel message either side.
    // A write-cache change also stays refused: it is a live attribute write on a
    // backstore an initiator has open.
    const zvolGrow = lun.kind === 'zvol'
      && req.size !== undefined
      && req.writeBack === undefined
      && (lun.size === null || req.size > lun.size)
    if (lun.connectedInitiators.length > 0 && !zvolGrow) {
      // The zvol clause is part of the sentence rather than appended to it: a
      // refusal that ends in "…and by the way this is allowed" reads as an
      // afterthought, and it is the half the operator most needs.
      const zvolNote = lun.kind === 'zvol'
        ? ' (GROWING a zvol-backed LUN is allowed under a live session: it is live end to end and the initiator rescans.)'
        : ''
      const why = req.writeBack !== undefined
        ? `Changing the write cache under a live session is refused`
        : lun.kind === 'zvol'
          ? `Resizing a LUN under a live session is refused`
          : `A file-backed LUN is resized by recreating its backstore (its size is fixed at creation), so it is refused under a live session`
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'session-open',
          message: `LUN ${index} of '${iqn}' has ${lun.connectedInitiators.length} live session${lun.connectedInitiators.length === 1 ? '' : 's'} `
            + `(${lun.connectedInitiators.join(', ')}). ${why} — LIO would do it anyway and leave a stale device on the `
            + `other host with no kernel message. Log the initiator out first. This refusal has no confirm bypass.${zvolNote}`,
        },
      }
    }

    const attributes: IscsiBackstoreAttributes = replayAttributes(
      lun,
      lun.plugin,
      req.writeBack !== undefined ? { writeBack: req.writeBack } : {},
    )
    const warnings: string[] = []
    // A grow that happens under a live session is safe and INVISIBLE until the
    // initiator looks again — measured on the stunt node: the disk stayed at its
    // old size until `iscsiadm -m node -R`, then reported the new one (F13).
    // Saying so is the difference between "it did not work" and "rescan".
    if (zvolGrow && lun.connectedInitiators.length > 0) {
      warnings.push(
        `${lun.connectedInitiators.length} initiator${lun.connectedInitiators.length === 1 ? ' is' : 's are'} logged in. `
        + 'The volume grows live, but an initiator keeps showing the OLD size until it rescans '
        + '(open-iscsi: `iscsiadm -m node -R`); the filesystem on top then has to be grown separately.',
      )
    }
    if (req.writeBack === true) {
      warnings.push(
        'Write-back caching is ON for this LUN: the target acknowledges a write before it reaches stable storage, '
        + 'so a node crash or power loss loses whatever the initiator believed was already written. '
        + 'LIO ships fileio this way; ANAS does not.',
      )
    }

    const job = jobQueue.submit(
      'iscsi.lun.update',
      { ...identity, params: { target: iqn, lun: index, ...(req.size !== undefined ? { size: req.size } : {}), ...(req.writeBack !== undefined ? { writeBack: req.writeBack } : {}) } },
      async updateProgress => withIscsiLock(async () => {
        if (req.size !== undefined && (lun.size === null || req.size > lun.size)) {
          if (lun.kind === 'zvol') {
            // A zvol grow is live end to end — no LIO action at all (GT-28).
            await growZvolLun(mutateOptions(updateProgress), lun.dataset ?? zvolDataset(lun.backingPath), req.size)
          }
          else {
            // fileio: the size is fixed at creation, so this is the replay path
            // — same serial, same attributes, same LUN index (GT-18/GT-29).
            await resizeFileLun(
              mutateOptions(updateProgress),
              target,
              { index: lun.index, name: lun.name, backingPath: lun.backingPath, serial: lun.serial, attributes },
              req.size,
            )
          }
        }
        else if (req.writeBack !== undefined) {
          await setLunWriteBack(mutateOptions(updateProgress), lun.plugin, lun.name, req.writeBack)
        }
        // The resize helpers deliberately stop before the save so that the whole
        // update — resize AND a write-cache change — is persisted exactly once.
        updateProgress('Saving the LIO configuration')
        await saveIscsiConfig(executor)
        return {
          target: iqn,
          lun: index,
          ...(req.size !== undefined ? { size: req.size } : {}),
          serial: lun.serial,
          recreated: lun.kind === 'file' && req.size !== undefined,
          warnings,
        }
      }),
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /iscsi/targets/:iqn/luns/:n ----------------------------------
  server.delete<{ Params: { iqn: string, n: string }, Querystring: unknown }>('/iscsi/targets/:iqn/luns/:n', async (request, reply) => {
    const iqn = parseIqn(request.params.iqn, reply)
    if (!iqn)
      return reply
    const index = parseLunIndex(request.params.n, reply)
    if (index === null)
      return reply

    const query = DeleteIscsiLunQuery.safeParse(request.query ?? {})
    if (!query.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid query: ${query.error.issues[0]?.message}` } }
    }
    const destroyBacking = query.data.destroyBacking

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const state = await preflight(reply)
    if (!state)
      return reply
    const target = findTarget(state.targets, iqn, reply)
    if (!target)
      return reply
    if (rejectForeign(target, reply))
      return reply
    const lun = findLun(target, index, reply)
    if (!lun)
      return reply

    if (lun.connectedInitiators.length > 0) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'session-open',
          message: `LUN ${index} of '${iqn}' has ${lun.connectedInitiators.length} live session${lun.connectedInitiators.length === 1 ? '' : 's'} `
            + `(${lun.connectedInitiators.join(', ')}). LIO would delete it anyway and leave a stale device on the initiator with no kernel message — `
            + `so ANAS refuses. Log the initiator out first. This refusal has no confirm bypass.`,
        },
      }
    }

    if (destroyBacking) {
      if (!confirmGate(confirmStore, request, reply, {
        operation: 'iscsi.lun.delete',
        params: { target: iqn, lun: index, destroyBacking: true },
        message: `Deleting LUN ${index} and destroying ${lun.backingPath} erases its data permanently`,
        warnings: [
          lun.kind === 'zvol'
            ? `The volume ${lun.dataset ?? zvolDataset(lun.backingPath)} and every snapshot under it will be destroyed`
            : `The image file ${lun.backingPath} will be removed`,
          `The unit serial ${lun.serial ?? '(unknown)'} goes with it — any PVE volid or initiator configuration built on it breaks`,
        ],
      })) {
        return reply
      }
    }

    const job = jobQueue.submit(
      'iscsi.lun.delete',
      { ...identity, params: { target: iqn, lun: index, destroyBacking } },
      async updateProgress => withIscsiLock(async () => deleteIscsiLun(
        mutateOptions(updateProgress),
        target,
        {
          index: lun.index,
          name: lun.name,
          plugin: lun.plugin,
          kind: lun.kind,
          backingPath: lun.backingPath,
          ...(lun.dataset ? { dataset: lun.dataset } : {}),
        },
        destroyBacking,
      )),
    )

    reply.code(202)
    return { job }
  })

  // --- POST /iscsi/health/repair — the restore-hole repair door (iscsi.5) ---
  //
  // The ONE mutation that is allowed to run while the tree is degraded, because
  // it is the thing that ends the degradation. So it deliberately does NOT use
  // `preflight()` — that refuses exactly this state.
  //
  // What it does NOT do is `targetctl restore`: that call takes rtslib's
  // `clear_existing=True` default, which wipes the whole live tree — every
  // healthy target and every logged-in initiator on the node — before rebuilding
  // (and there is no CLI form that passes `False`; rtslib would refuse anyway
  // because the surviving targets are already there). `services/iscsi-repair.ts`
  // carries the source that proves it. Repair is a surgical replay of the
  // PERSISTED record instead: create with `wwn=`, replay every attribute, map at
  // the stored index — the same `{serial, attributes}` contract every other
  // recreate path uses, so the disk comes back as the SAME disk.
  server.post('/iscsi/health/repair', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Story `iscsi.8`: this read quarantines too. A LUN serving a PLACEHOLDER is
    // not yet a hole — it is a live LUN with an empty file behind it — so the
    // tear-down has to happen before the plan is built, or Repair would answer
    // "nothing to repair" about the very thing it exists to fix.
    const state = await readIscsiHealthWithQuarantine(executor, paths)
    const notInstalled = assertInstalled(state.ctx)
    if (notInstalled)
      return sendRefusal(reply, notInstalled)

    const plan = planIscsiRepair(state.ctx, state.health, state.targets)
    const refusal = assertRepairable(plan)
    if (refusal)
      return sendRefusal(reply, refusal)

    const job = jobQueue.submit(
      'iscsi.health.repair',
      {
        ...identity,
        params: {
          repairable: plan.repairable.length,
          blocked: plan.blocked.length,
          targets: [...new Set(plan.repairable.map(r => r.targetIqn))].join(', '),
        },
      },
      async updateProgress => withIscsiLock(async () => repairIscsiHoles(mutateOptions(updateProgress), plan)),
    )

    reply.code(202)
    return { job }
  })

  // --- GET /iscsi/claims — the iscsi.6 seam --------------------------------
  //
  // "Is this zvol / image / dataset held by a LUN?" in ONE call. Nothing else in
  // userspace can answer it: `fuser`, `lsof` and sysfs `holders/` all report
  // nothing for a device LIO is serving (GT-41).
  server.get('/iscsi/claims', async () => {
    const state = await readIscsiState(executor, paths)
    const result: IscsiClaimList = {
      ...iscsiAvailability(state.ctx),
      claims: claimsFromTargets(state.targets),
    }
    return { data: result }
  })
}

/** A LUN index path parameter: a plain non-negative integer. */
function parseLunIndex(raw: string, reply: FastifyReply): number | null {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    reply.code(400)
    reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid LUN index '${raw}' — a LUN is identified by its non-negative index within the target` } })
    return null
  }
  return n
}

/**
 * Warn about a portal whose address no interface on this node carries.
 *
 * Not a refusal: an address that is about to be configured is a legitimate thing
 * to set up ahead of time. But LIO will bind it, report `[OK]`, keep it across a
 * service restart and never log a word (GT-24) — so if ANAS does not say it,
 * nothing will. `null` node addresses means "could not read", which is not the
 * same as "none", and produces no warning at all.
 */
export function portalAddressWarnings(
  nodeAddresses: Set<string> | null,
  portals: { address: string, port: number }[],
): string[] {
  if (nodeAddresses === null)
    return []
  return portals
    .filter(p => !nodeAddresses.has(p.address.toLowerCase()))
    .map(p => `No interface on this node currently carries ${p.address} — LIO will bind the portal and report it healthy anyway, and it will never tell you otherwise`)
}

/**
 * The honest caveat that rides every new LUN.
 *
 * ANAS turns thin reclaim on (`emulate_tpu=1`, `emulate_tpws=1`) and raises
 * `max_unmap_lba_count`, which is the correct target-side configuration. It is
 * not a promise: whether reclaim actually happens depends on which SCSI command
 * the INITIATOR chooses, and Linux's default choice (WRITE SAME 16) is rejected
 * outright by LIO's fileio backend (GT-30).
 */
export function lunAttributeWarnings(plugin: string): string[] {
  if (plugin !== 'fileio')
    return []
  return [
    'Thin reclaim is enabled on the target side, but an image-file LUN only reclaims when the initiator issues a real UNMAP: '
    + 'Linux\'s default choice (WRITE SAME 16) is rejected by LIO for this backend, so a plain blkdiscard will fail. '
    + 'A zvol-backed LUN reclaims out of the box.',
  ]
}
