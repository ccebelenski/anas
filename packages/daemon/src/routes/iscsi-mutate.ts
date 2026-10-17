import type { IscsiClaimList, IscsiLun, IscsiTargetDetail } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Gate, GuardReads } from '../safety/guard.js'
import type { IscsiState, TargetObject } from '../services/iscsi-guard.js'
import type { IscsiBackstoreAttributes, IscsiMutateOptions, IscsiRefusal, ResolvedAhrPool } from '../services/iscsi-mutate.js'
import type { IscsiPaths } from '../services/iscsi.js'
import {
  aclAuthRequirement,
  aclSatisfiesAuth,
  AddIscsiLunRequest,
  CreateIscsiTargetRequest,
  DeleteIscsiLunQuery,
  emptyAclsSentence,
  IscsiIqn,
  IscsiTargetStateRequest,
  lunGrowGuidance,
  UpdateIscsiLunRequest,
  UpdateIscsiTargetRequest,
} from '@anas/shared'
import { readNodeInitiatorName } from '../parsers/iscsi-initiator.js'
import { guardCheck, guardConfirm, GuardRefusalError, iscsiTargetClaim, sendRefusal as sendGuardRefusal } from '../safety/guard.js'
import { ensureAhrTargetOrdering } from '../services/ahr-create.js'
import { CONFIGFS_TARGET_ROOT } from '../services/iscsi-configfs.js'
import {
  conflict,
  foreignGate,
  iscsiGuarded,
  lunClaims,
  lunDeleteSpec,
  lunNameFreeGate,
  notAlreadyGate,
  portalKey,
  repairClaims,
  saveableGate,
  targetLunsGate,
  targetSessionsGate,
  targetView,
  UPDATE_SESSION_SCOPE_LABELS,
  updateSessionImpact,
  updateSessionScope,
} from '../services/iscsi-guard.js'
import { computeIscsiHealth } from '../services/iscsi-health.js'
import {
  addIscsiLun,
  assertInstalled,
  assertSaveable,
  backstorePath,
  claimsFromTargets,
  createIscsiTarget,
  createSparseImage,
  deleteIscsiLun,
  deleteIscsiTarget,
  growZvolLun,
  imageFilePath,
  lunBackingClaims,
  newSerial,
  newTargetIqn,
  proveZvolBacking,
  readIscsiState,
  replayAttributes,
  resizeFileLun,
  resolveFileBackingDir,
  resolveZvolBacking,
  runTargetcli,
  saveIscsiConfig,
  setIscsiTargetState,
  setLunWriteBack,
  updateIscsiTarget,
  withIscsiLock,
  zvolDataset,
} from '../services/iscsi-mutate.js'
import { readIscsiHealthWithQuarantine } from '../services/iscsi-quarantine.js'
import { assertRepairable, guardRepairPlan, planIscsiRepair, repairIscsiHoles } from '../services/iscsi-repair.js'
import { checkServedDevice, reverifyServedLun, servedLunIdentity, statDeviceFrom } from '../services/iscsi-served.js'
import { iscsiAvailability } from '../services/iscsi.js'
import { requireIdentity } from './identity.js'

/**
 * iSCSI — the MUTATION layer (story `iscsi.4`).
 *
 *   POST   /v1/iscsi/targets                      create a target
 *   PUT    /v1/iscsi/targets/:iqn                 portals / ACLs / auth / secrets
 *   POST   /v1/iscsi/targets/:iqn/state           enable | disable
 *   DELETE /v1/iscsi/targets/:iqn                 delete an EMPTY target (sessions → 409, LUNs → 409, both without bypass)
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
 *    initiator and produces no kernel message until the next rescan, and a
 *    target delete drops every session the same way (GT-42). Every session gate
 *    is ANAS's own.
 *
 * The gates differ in altitude on purpose. Deleting a TARGET is REFUSED while
 * it has a live session (the sessions drop and the devices go stale with no
 * kernel message — no confirmation makes that safe) or a single LUN (delete the
 * LUNs first, where `destroyBacking` is the per-LUN choice about the data). Only
 * an empty, session-free target is deleted — and that is not data-destroying, so
 * the route carries no confirm gate at all. Resizing or deleting a LUN with a
 * live session is likewise a hard 409 with no bypass: the initiator has the
 * device open and its filesystem mounted.
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
 * Story cr.40 (WAVE3-DESIGN §5.2 rule 1): the fields of the target-update
 * confirm left out of the signature, each with its reason. A test lists them.
 *
 * cr.66r (§2 Safety altitudes): what is unsigned are the credential VALUES —
 * they never enter the signed record at all, only their NAMES do, per ACL, as
 * `credentialFields` (a confirm signs the NAMES of every field it writes and
 * never a secret value, because describeField JSON-echoes a signed field
 * whose value changed into the CONFIRM_SCOPE_CHANGED sentence).
 */
export const ISCSI_TARGET_UPDATE_PRESENTATION_ONLY: Record<string, string> = {
  credentials: 'CHAP credential VALUES (chapUserid/chapSecret/mutualUserid/mutualSecret) are never signed or echoed — the code signs the per-ACL field NAMES (`credentialFields`), so a rotation with the same fields is the same request and a changed field set re-challenges',
}

/** Story cr.40: the LUN-delete confirm signs everything — `destroyBacking` included. */
export const ISCSI_LUN_DELETE_PRESENTATION_ONLY: Record<string, string> = {}

/** The credential fields an ACL edit can carry (cr.66r: signed by NAME, never by value). */
const ACL_CREDENTIAL_FIELDS = ['chapUserid', 'chapSecret', 'mutualUserid', 'mutualSecret'] as const

/**
 * The target-update request as the confirm signs it: the desired portal and
 * ACL sets in canonical order (a reordered list is the same edit), the auth
 * mode, `unchanged` for a field the edit leaves alone — and no secret.
 *
 * cr.66r (§2 Safety altitudes): the credential fields ride as NAMES, per ACL
 * — for each initiator in canonical (sorted) order, the sorted names of the
 * credential fields this update writes (`null` counts: it writes the field
 * off). cr.40 signed this as a single `credentials` boolean and then dropped
 * it as presentation-only, so nothing about the credentials was signed at
 * all; the NAMES are what the ruling demands, the VALUES stay unsigned (a
 * rotation with the same fields is the same request).
 */
export function targetUpdateSignature(iqn: string, req: UpdateIscsiTargetRequest): Record<string, unknown> {
  const canon = (items: string[]): string => {
    const out = [...new Set(items)]
    out.sort()
    return out.join(', ')
  }
  return {
    target: iqn,
    auth: req.auth ?? 'unchanged',
    portals: req.portals ? canon(req.portals.map(portalKey)) : 'unchanged',
    acls: req.acls ? canon(req.acls.map(a => a.initiatorIqn)) : 'unchanged',
    // Per-ACL credential NAMES, in the same canonical initiator order as
    // `acls`; presence only, never a value (the values never enter this
    // record — describeField would echo a changed signed value into the 409).
    credentialFields: req.acls
      ? Object.fromEntries(
          // eslint-disable-next-line e18e/prefer-array-to-sorted -- Set → sorted list
          [...new Set(req.acls.map(a => a.initiatorIqn))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .map(initiator => [
              initiator,
              ACL_CREDENTIAL_FIELDS.filter(f => req.acls!.some(a => a.initiatorIqn === initiator && a[f] !== undefined)).sort(),
            ]),
        )
      : 'unchanged',
  }
}

/**
 * targetcli's stderr for a delete that found no object — the backstore was
 * never created (the first targetcli of the create-and-map sequence is the one
 * that died). The new-LUN restore's cleanup matches the same line.
 */
const BACKSTORE_GONE_RE = /no such object/i

/**
 * Delete a backstore an add-LUN job may have half-created when `createAndMapLun`
 * died mid-sequence, WITHOUT saving the configuration (cr.40r, DEFECT-1): a
 * half-created LUN must never be persisted as if it were healthy, and the state
 * it would otherwise leave — live in the LIO tree, absent from
 * `saveconfig.json` — is exactly the health diff's `lun-not-persisted`, with no
 * job left to own it. Mirrors the new-LUN restore's cleanup
 * (`services/backup-restore.ts` `removeNewLun`): the caller sets its flag
 * BEFORE the create-and-map call, and a delete that finds nothing has left
 * nothing behind. The job body runs under the iSCSI mutex the route's
 * `iscsiGuarded` takes, so there is no lock to take here. Returns the sentence
 * to append to the job's failure, or '' when nothing was left behind (already
 * gone, or a delete that found no object).
 */
async function removeOrphanedBackstore(executor: CommandExecutor, plugin: string, name: string): Promise<string> {
  try {
    await runTargetcli(executor, [backstorePath(plugin, name), 'delete'])
    return `deleted the half-created backstore '${name}'`
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (BACKSTORE_GONE_RE.test(msg))
      return ''
    return `the half-created backstore '${name}' could not be deleted (${msg})`
  }
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

  /** What the cr.40 guard specs read through (services/iscsi-guard.ts). */
  const guardDeps = { executor, paths }

  /**
   * The pre-flight every mutation shares: read the whole state ONCE, then refuse
   * if LIO is absent or the live tree is a known incomplete restore.
   *
   * The degraded snapshot is deliberately taken before the sequence starts and
   * never recomputed mid-flight: a fileio resize deletes its own backstore and
   * would look "degraded" to a naive re-check, when in fact the only thing
   * missing is the one this code is in the middle of putting back.
   */
  async function preflight(reply: FastifyReply): Promise<IscsiState | null> {
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

    // A target with ZERO ACLs is invisible to every initiator: ANAS creates
    // every target with demo_mode_discovery=0 and generate_node_acls=0, so
    // discovery answers nothing for one nobody is listed on — the operator
    // would get "No portals found" and nothing on the node to say why.
    // Refuse with the sentence rather than create the mystery.
    if (req.acls.length === 0) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: emptyAclsSentence(await readNodeInitiatorName(paths.initiatorNamePath)),
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
      // cr.40 (§4.2): the IQN it creates is the target's key — two creates of
      // one name serialise, and the second's `/iscsi create` refuses with
      // nothing done.
      { locks: [iscsiTargetClaim(iqn)] },
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

    // Story cr.40 (WAVE3-DESIGN §2.4 "target update", F4): the one guard spec
    // both doors run. The edit is a DIFF against the target as read now, so
    // the target's REVISION (ACLs, portals, LUNs, enabled, auth) is bound: the
    // job acts only when the target is still in exactly that state, so it can
    // neither delete an ACL someone added in between nor send `acls delete`
    // for one someone already removed (a targetcli failure half-way through
    // the sequence, with no saveconfig). The SCOPE is the sessions the edit
    // affects — a session that logs in on an ACL this edit removes after the
    // request fails the job; nobody agreed to drop it.
    const spec = {
      operation: 'iscsi.target.update',
      object: targetView(guardDeps, iqn, {
        seed: state,
        scope: updateSessionScope(req),
        scopeLabels: UPDATE_SESSION_SCOPE_LABELS,
      }),
      gates: [saveableGate, foreignGate],
      locks: async () => [iscsiTargetClaim(iqn)],
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendGuardRefusal(reply, pre.refusal)
    const target = pre.object.target

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

    // Two things in one edit can touch a LIVE session — dropping an ACL and
    // removing a portal — and each needs the SAME confirm challenge (same
    // operation, same `{target}` signature). So their sentences and warnings are
    // gathered and issued through ONE gate: an edit that both removes an ACL and
    // removes a portal must not make the operator answer two challenges in a row.
    const gateMessages: string[] = []
    const gateWarnings: string[] = []

    // Removing an ACL is not a metadata edit: it drops that initiator's session
    // instantly and destroys its CHAP credentials (GT-36). Say so, and gate it.
    // The same diff the scope above binds (one helper, cr.40).
    const impact = updateSessionImpact(target, req)
    const removedWithSessions = impact.dropped
    if (removedWithSessions.length > 0) {
      gateMessages.push(`Removing ${removedWithSessions.length} initiator ACL${removedWithSessions.length === 1 ? '' : 's'} will drop ${removedWithSessions.length === 1 ? 'its' : 'their'} live session immediately`)
      gateWarnings.push(...removedWithSessions.map(i => `${i} is logged in now — its session drops the moment the ACL is removed, and its device on that host goes stale with no kernel message`))
    }

    // M3: removing a portal an initiator's session came in through does NOT drop
    // the session. LIO tears down only the listening socket — the accepted TCP
    // connection, the mapped LUN and I/O all keep running with no kernel message
    // on either side (live-proof LP6). What breaks is the NEXT reconnect: a login
    // or discovery through that address fails (iscsiadm error 8) while the
    // initiator's own node record still points at it. So this is a confirm with
    // warnings, not a refusal — the operator may proceed, but the affected
    // initiators are named and told exactly what happens. The removed set is the
    // SAME diff the service applies: a live portal (address case-insensitive,
    // port exact) that the desired set no longer contains.
    //
    // `IscsiSession.connections[].address` is the only fidelity LIO reports for
    // an established connection — an address, no port — so a session is matched
    // to a removed portal by address. A session that came in on a DIFFERENT
    // address is untouched: that initiator can still re-login through its own
    // surviving portal (LP6), so it earns no warning.
    const portalSessionWarnings = impact.stranded.map(s =>
      `${s.initiator} has a live connection on ${s.address}:${s.port} — its current session keeps running, `
      + `but once that portal is removed it cannot re-login or discover through ${s.address}:${s.port} `
      + `(iscsiadm error 8) until its own node record is pointed at a surviving portal`)
    if (portalSessionWarnings.length > 0) {
      gateMessages.push('Removing a portal a live connection came in on will not drop that session, but its next reconnect through that address will fail until the initiator\'s node record is updated')
      gateWarnings.push(...portalSessionWarnings)
    }

    if (gateWarnings.length > 0) {
      // Story cr.40 (M3): the code signs the whole edit — the desired ACL and
      // portal sets and the auth mode — plus the target's revision and the
      // sessions it drops, so a resend with another edit is 409
      // CONFIRM_SCOPE_CHANGED and a target that moved is 409 STATE_CHANGED.
      // cr.66r (§2 Safety altitudes): the CHAP credential fields ride by
      // NAME per ACL (`credentialFields`); their VALUES are the
      // presentation-only thing — a signed field is echoed in the 409 that
      // names a changed one, so a secret must never be a signed field.
      if (!guardConfirm(confirmStore, request, reply, spec, pre, {
        validated: targetUpdateSignature(iqn, req),
        address: ['target'],
        presentationOnly: ISCSI_TARGET_UPDATE_PRESENTATION_ONLY,
        message: gateMessages.join('; '),
        warnings: gateWarnings,
      })) {
        return reply
      }
    }

    let warnings = req.portals ? portalAddressWarnings(state.ctx.nodeAddresses, req.portals) : []

    // Removing the LAST initiator ACL is the operator's call — they may be
    // mid-reconfigure — so the edit is NOT refused. But the same sentence a
    // create would be refused with rides the job result as a warning: the
    // target is now invisible to every initiator, and nothing else on the node
    // will ever say so.
    if (req.acls !== undefined && req.acls.length === 0 && target.acls.length > 0) {
      warnings = [...warnings, emptyAclsSentence(await readNodeInitiatorName(paths.initiatorNamePath))]
    }

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
      // Ruling (j): under the iSCSI mutex the job re-reads the target, compares
      // its revision and the sessions it affects, re-runs every gate, and only
      // then diffs — against the fresh target, which the revision just proved
      // IS the request-time one.
      iscsiGuarded(spec, pre, async ({ target: now }, ctx) => {
        const result = await updateIscsiTarget(mutateOptions(ctx.updateProgress), now, req)
        return { ...result, warnings }
      }),
      { locks: pre.locks },
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

    // Story cr.40 (§2.4 "target enable/disable"): the job acts on the target
    // as read under the lock, bound to the revision the request saw (an
    // enable/disable made in between, or any other edit, fails it
    // STATE_CHANGED), and the "already in that state" gate runs at both doors.
    const spec = {
      operation: `iscsi.target.${action}`,
      object: targetView(guardDeps, iqn, { seed: state }),
      gates: [saveableGate, foreignGate, notAlreadyGate(action)],
      locks: async () => [iscsiTargetClaim(iqn)],
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendGuardRefusal(reply, pre.refusal)
    const target = pre.object.target

    // `disable` refuses NEW logins; the portal socket stays open and an
    // established session keeps running (GT-37). Saying so is the difference
    // between a control that works and a control that lies.
    const warnings = action === 'disable' && target.sessionCount > 0
      ? [`${target.sessionCount} session${target.sessionCount === 1 ? '' : 's'} stay connected — disabling a TPG refuses new logins and hides the target from discovery, but it does not close the portal or drop an established session`]
      : []

    const job = jobQueue.submit(
      `iscsi.target.${action}`,
      { ...identity, params: { target: iqn } },
      iscsiGuarded(spec, pre, async ({ target: now }, ctx) => {
        const result = await setIscsiTargetState(mutateOptions(ctx.updateProgress), now, action)
        return { ...result, warnings }
      }),
      { locks: pre.locks },
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

    // A target with live sessions is REFUSED, not confirmed: deleting it drops
    // every session and leaves a stale device on each host with no kernel
    // message (GT-42) — there is no confirmation that makes that safe. Logging
    // the initiators out first is the only way out, so the refusal says it.
    //
    // A target with LUNs is refused too: the LUNs are deleted through their own
    // door, where the operator chooses per LUN whether the backing zvol/image is
    // destroyed. Only what is left after — an empty, session-free target — is
    // safe to delete, and that is not data-destroying, so it is not
    // confirm-gated either.
    //
    // Story cr.40 (§2.4 "target delete"): both refusals are gates the job runs
    // again under the lock — an initiator that logs in, or a LUN mapped, while
    // the delete waits in the queue refuses it — and the job is bound to the
    // target's revision.
    const spec = {
      operation: 'iscsi.target.delete',
      object: targetView(guardDeps, iqn, { seed: state }),
      gates: [saveableGate, foreignGate, targetSessionsGate, targetLunsGate],
      locks: async () => [iscsiTargetClaim(iqn)],
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendGuardRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'iscsi.target.delete',
      { ...identity, params: { target: iqn } },
      iscsiGuarded(spec, pre, async ({ target: now }, ctx) => deleteIscsiTarget(mutateOptions(ctx.updateProgress), now)),
      { locks: pre.locks },
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

    /** The resolved backing of one guard run (the route's, then the job's). */
    interface AddBacking {
      path: string
      plugin: 'block' | 'fileio'
      dataset?: string
      size: number | null
      /** Set when the image lands on an AHR pool — the boot-ordering half. */
      ahrPool?: ResolvedAhrPool
    }
    // Resolve the backing object — the one place a PVE guest disk or a
    // foreign pool is turned away (reusing iscsi.2's classifyBacking) — and,
    // for a zvol, refuse a device another LUN already exports. Read once per
    // guard run (the gate and the job body share it).
    let routeBacking: AddBacking | undefined
    const backingOf = (o: TargetObject, reads: GuardReads): Promise<{ ok: AddBacking } | { refusal: IscsiRefusal }> =>
      reads.once('iscsi:lun-add:backing', async () => {
        if (req.kind === 'zvol') {
          const resolved = resolveZvolBacking(req.backing, o.state.ctx)
          if ('refusal' in resolved)
            return { refusal: resolved.refusal }
          const path = resolved.ok.path
          if (o.state.targets.some(t => t.luns.some(l => l.backingPath === path))) {
            return {
              refusal: {
                reason: 'backing-already-mapped',
                message: `${path} is already exported as a LUN on this node — exporting one block device through two LUNs invites two initiators to write to it at once`,
              },
            }
          }
          return { ok: { path, plugin: 'block' as const, ...(resolved.ok.dataset ? { dataset: resolved.ok.dataset } : {}), size: null } }
        }
        const dir = await resolveFileBackingDir(executor, req.backing, o.state.ctx)
        if ('refusal' in dir)
          return { refusal: dir.refusal }
        return {
          ok: {
            path: imageFilePath(dir.ok.dir, req.name),
            plugin: 'fileio' as const,
            ...(dir.ok.dataset ? { dataset: dir.ok.dataset } : {}),
            size: req.size ?? null,
            ...(dir.ok.ahr ? { ahrPool: dir.ok.ahr } : {}),
          },
        }
      })
    const backingGate: Gate<TargetObject> = async (o, reads) => {
      const b = await backingOf(o, reads)
      if ('refusal' in b)
        return conflict(b.refusal)
      routeBacking ??= b.ok
      return null
    }

    // Story cr.40 (§2.4 "LUN add", audit #34): the gates — target exists and
    // is ANAS's, the name is free node-wide (GT-15), the backing resolves onto
    // ANAS storage and is not already exported — run at both doors, and the
    // job maps the LUN at the next free index of the target as read UNDER the
    // lock and grants it to the ACLs that target has THEN. The request-time
    // target decides neither: a LUN added, or an ACL added, while the job
    // waited is seen. No revision: an add is not a diff, it is placed into
    // whatever the target is when it runs.
    const spec = {
      operation: 'iscsi.lun.add',
      object: targetView(guardDeps, iqn, { seed: state, revision: false }),
      gates: [saveableGate, foreignGate, lunNameFreeGate(req.name), backingGate],
      // §4.2 + cr.63 (review L17): the target's key, and the BACKING's keys
      // shared — the zvol's dataset keys, or the keys of the filesystem the
      // image lands on — so a dataset destroy, a pool export or destroy, an
      // unmount of that filesystem waits for the add (and re-gates on a LUN
      // that now holds it), and the add waits for any of them already running.
      locks: async (o: TargetObject, _bound: unknown, reads: GuardReads) => {
        const b = await backingOf(o, reads)
        return [
          iscsiTargetClaim(iqn),
          ...('refusal' in b ? [] : await lunBackingClaims(executor, { kind: req.kind, backingPath: b.ok.path, ...(b.ok.dataset ? { dataset: b.ok.dataset } : {}) }, 'shared')),
        ]
      },
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendGuardRefusal(reply, pre.refusal)
    const accepted = routeBacking as AddBacking

    const serial = newSerial()
    const job = jobQueue.submit(
      'iscsi.lun.add',
      { ...identity, params: { target: iqn, lun: req.name, kind: req.kind, backing: accepted.path, ...(accepted.size !== null ? { size: accepted.size } : {}) } },
      iscsiGuarded(spec, pre, async (now, ctx) => {
        const { updateProgress } = ctx
        const resolved = await backingOf(now, ctx.reads)
        // Unreachable (cr.40r): `backingOf` memoises on the run's GuardReads,
        // and `backingGate` resolved the SAME cached read when the job door ran
        // — a refusal already threw the gate's own 409 before this line. It
        // STAYS as the type-narrower, throwing the GATE's refusal if the memo
        // invariant ever breaks: a plain Error would mislabel one as JOB_FAILED,
        // and the route and the job must refuse a backing with the same code.
        if ('refusal' in resolved)
          throw new GuardRefusalError(conflict(resolved.refusal))
        const { path: backingPath, plugin, dataset, size, ahrPool } = resolved.ok
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
        // DEFECT-1 (cr.40r): the backstore this sequence creates is persisted
        // only when addIscsiLun finishes with a saveconfig. A targetcli that
        // dies after the backstore exists — the map, an ACL grant — used to
        // leave it live-only: present in the LIO tree, absent from
        // `saveconfig.json`, owned by no job, and the state the health diff
        // would name `lun-not-persisted` for as long as it sat there. The undo
        // mirrors the new-LUN restore's cleanup (backup-restore.ts): the flag
        // is set BEFORE the create-and-map sequence, a failure deletes the
        // backstore WITHOUT saving (a half-created LUN must never be
        // persisted), a delete that finds nothing — the first targetcli may
        // itself be the one that died — is tolerated, and the job still fails
        // with the original error.
        //
        // cr.64cr: the zvol's existence (and that it IS a volume) is proved
        // HERE, before the undo's flag goes up — a refusal from inside the try
        // fired `removeOrphanedBackstore`, a targetcli delete of a namesake
        // backstore this job never created (review of cr.64c, P8a).
        await proveZvolBacking(executor, { path: backingPath, plugin, ...(dataset ? { dataset } : {}) })
        let backstoreTouched = false
        try {
          backstoreTouched = true
          const result = await addIscsiLun(
            mutateOptions(updateProgress),
            now.target,
            req,
            { path: backingPath, plugin, ...(dataset ? { dataset } : {}) },
            size,
            serial,
          )
          return { ...result, warnings: lunAttributeWarnings(plugin) }
        }
        catch (err) {
          const base = err instanceof Error ? err.message : String(err)
          const cleanup = backstoreTouched ? await removeOrphanedBackstore(executor, plugin, req.name) : ''
          if (cleanup)
            throw new Error(`${base} ${cleanup}`)
          throw err
        }
      }),
      { locks: pre.locks },
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
      // M2 (#53): an unreadable current size used to fall through every gate
      // below as "this is a grow" — and both resize helpers are direction-blind
      // (`zfs set volsize=`, a bare truncate), so a smaller request was a silent
      // truncation even under a live session. If the current size cannot be
      // read, no direction can be proven, so no size change is accepted.
      if (lun.size === null) {
        reply.code(409)
        return {
          error: {
            code: 'CONFLICT',
            reason: 'size-unknown',
            message: `LUN ${index}'s current size could not be read, so ANAS cannot prove a change to ${req.size} bytes `
              + `is a GROW rather than a SHRINK — and the resize is applied unchecked. Re-read the target's size `
              + `(refresh the iSCSI view) and retry once it reads back. This refusal has no confirm bypass.`,
          },
        }
      }
      if (req.size < lun.size) {
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

    // ident.2 (audit #8): a size change acts on the backing object — a `zfs set
    // volsize=` on the volume the PATH names, or a grow of the file at it — so
    // the object at the path must be the one LIO is serving. After a rename +
    // re-create under the live LUN the size read above is the SERVED device's,
    // and a "grow" computed from it would shrink the new volume.
    const served = await checkServedDevice(state.ctx.live, lun, statDeviceFrom(paths))
    if (req.size !== undefined && served.refusal)
      return sendRefusal(reply, served.refusal)
    const bound = servedLunIdentity(iqn, lun, served.device)

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
    // A zvol size change that is provably a grow. The `lun.size === null` arm is
    // unreachable since M2 (#53) — a null size is 409'd above for any size
    // change — but the type cannot narrow that far, so the arm stays.
    const zvolSizeGrow = lun.kind === 'zvol'
      && req.size !== undefined
      && (lun.size === null || req.size > lun.size)
    const zvolGrow = zvolSizeGrow && req.writeBack === undefined
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
    // A zvol grow — with or without a session — is INVISIBLE to a running
    // guest: the LUN and the initiators see the new size, but a RUNNING VM
    // keeps the old one until QEMU reopens the disk (verified on a real node
    // 2026-08-26). The sentence is the shared one — `lunGrowGuidance` —
    // because the Datasets door's grow of the SAME volume carries it too:
    // one definition, two doors.
    // M1: the combined {size, writeBack} request IS a grow too, so it carries
    // the same guidance the grow-only request does — the session gate above
    // still refuses it under a session (the cache half is a live attribute
    // write), but session-free it must not lose the sentence.
    if (zvolSizeGrow && req.size !== undefined)
      warnings.push(lunGrowGuidance(req.size))
    if (req.writeBack === true) {
      warnings.push(
        'Write-back caching is ON for this LUN: the target acknowledges a write before it reaches stable storage, '
        + 'so a node crash or power loss loses whatever the initiator believed was already written. '
        + 'LIO ships fileio this way; ANAS does not.',
      )
    }

    // cr.64b2-iii (N, cr.64b1 report): the backing's keys move onto a guard
    // spec's `locks` derivation — the LUN delete/add doors' idiom — instead of
    // being computed here and passed outside any spec. Before, the guard's
    // job-time recompute never covered them, and a mount-table (findmnt)
    // failure at the route locked NOTHING for the backing: the job read the
    // table fine and its recompute then refused "changed while this run
    // waited" — a sentence that was false. Now the route door answers 503
    // UNAVAILABLE naming the read (cr.64b1 (B)), and the job re-derives the
    // claims at its own turn through the same spec.
    const spec = {
      operation: 'iscsi.lun.update',
      object: targetView(guardDeps, iqn, { seed: state, revision: false }),
      // The door's own gates (size direction, foreign backing, served device,
      // sessions) stay where they are — the route asks them in its order, and
      // the job asks them again under the mutex in its body (`reverifyServed-
      // Lun`, the session rule re-asked); this spec exists for the identity
      // re-read and the claim derivation.
      gates: [],
      // cr.40 (§4.2) + cr.63 (review L17): the target's key, the LUN's by
      // serial, and the backing's — a zvol grow EXCLUSIVE (a `zfs set
      // volsize`, as the Datasets door's grow of the same volume), anything
      // else SHARED. Read from the object, so the job's recompute sees the
      // LUN as it is when the job runs.
      locks: async (o: TargetObject) => {
        const now = o.target.luns.find(l => l.index === index)
        return [
          ...lunClaims(iqn, now?.serial ?? null),
          ...(now ? await lunBackingClaims(executor, now, zvolSizeGrow ? 'exclusive' : 'shared') : []),
        ]
      },
    }
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendGuardRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'iscsi.lun.update',
      { ...identity, params: { target: iqn, lun: index, serial: lun.serial, backstore: lun.name, ...(req.size !== undefined ? { size: req.size } : {}), ...(req.writeBack !== undefined ? { writeBack: req.writeBack } : {}) } },
      iscsiGuarded(spec, pre, async (_now, ctx) => {
        const { updateProgress } = ctx
        // ident.2 (audit #8/#9): the job may run long after the request. Under
        // the lock, the LUN at this index must still be the same serial, the
        // same backstore, the same path and — for a size change — the same
        // served device; and the size is re-read from what is served NOW, so a
        // grow can never become a shrink in the queue.
        //
        // cr.40 (§2.4 "LUN update"): the same session rule as the route, asked
        // again — only a pure zvol grow is allowed under a live session.
        const fresh = await reverifyServedLun(executor, paths, bound, { requireDevice: req.size !== undefined, refuseSessions: !zvolGrow })
        const now = fresh.lun
        if (req.size !== undefined) {
          if (now.size === null)
            throw new Error(`LUN ${index}'s current size could not be re-read inside the job, so the change to ${req.size} bytes cannot be proven a grow. Nothing was changed.`)
          if (req.size < now.size)
            throw new Error(`LUN ${index} is now ${now.size} bytes; ${req.size} bytes would SHRINK it. Nothing was changed.`)
        }
        // O1: a zvol grow rounds the requested size up to a volblocksize
        // multiple (the create door does the same silently). The applied size
        // may therefore exceed `req.size`, so the result reports what actually
        // landed on the volume rather than what was asked for.
        let appliedSize = req.size
        if (req.size !== undefined && now.size !== null && req.size > now.size) {
          if (lun.kind === 'zvol') {
            // A zvol grow is live end to end — no LIO action at all (GT-28).
            appliedSize = await growZvolLun(mutateOptions(updateProgress), now.dataset ?? zvolDataset(now.backingPath), req.size)
            // M1: a combined {size, writeBack} must do BOTH. The fileio branch
            // carries writeBack inside the replay (the create's `write_back=`
            // plus its attribute token), but growZvolLun is a bare
            // `zfs set volsize=` — without this the audit params and the ON
            // warning claim a change the job never made.
            if (req.writeBack !== undefined)
              await setLunWriteBack(mutateOptions(updateProgress), lun.plugin, lun.name, req.writeBack)
          }
          else {
            // fileio: the size is fixed at creation, so this is the replay path
            // — same serial, same attributes, same LUN index (GT-18/GT-29).
            await resizeFileLun(
              mutateOptions(updateProgress),
              fresh.target,
              { index: now.index, name: now.name, backingPath: now.backingPath, serial: now.serial, attributes },
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
          ...(req.size !== undefined ? { size: appliedSize } : {}),
          serial: lun.serial,
          recreated: lun.kind === 'file' && req.size !== undefined,
          warnings,
        }
      }),
      // The claims the spec derived at the route door; the job's recompute
      // (cr.64b1 (D)) checks its own re-read against exactly these.
      { locks: pre.locks },
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

    // Story cr.40 (§2.4 "LUN delete"): the one guard spec both doors run.
    // Gates: LIO saveable, the target ANAS's, the LUN there, NO live session on
    // it (GT-42: LIO would delete it anyway and leave a stale device), and —
    // with destroyBacking — the path naming the device LIO serves (ident.2)
    // and a zvol with no snapshots (M5: a plain `zfs destroy` refuses one
    // INSIDE the job, after the unmap, before `saveconfig`). The job re-runs
    // every one of them under the iSCSI mutex before the first `targetcli`.
    //
    // Identity (ident.2, audit #9): the LUN's SERIAL, backstore and path,
    // never its index — indexes are reused lowest-free, so a LUN re-created
    // at the index is a different LUN. With destroyBacking the served device
    // is bound as the scope: the object the operator agreed to destroy.
    const spec = lunDeleteSpec(guardDeps, iqn, index, destroyBacking, {
      seed: state,
      // cr.63 (review L17): beside the target's and the LUN's keys, the
      // backing's — EXCLUSIVE on the zvol for `destroyBacking` (it is a `zfs
      // destroy` of the volume, as `zfs.destroy` takes it), shared otherwise.
      locks: async ({ lun }) => [
        ...lunClaims(iqn, lun?.serial ?? null),
        ...(lun ? await lunBackingClaims(executor, lun, destroyBacking && lun.kind === 'zvol' ? 'exclusive' : 'shared') : []),
      ],
    })
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendGuardRefusal(reply, pre.refusal)
    const lun = pre.object.lun as IscsiLun

    // Story cr.40 (M3): `destroyBacking` is BOUND. The confirm window
    // re-challenges in place when "Also destroy" is ticked (cr.44's
    // `confirmBind`), so the code always matches the request it confirms and
    // the warnings are about THIS request; a resend whose code was minted with
    // the other value is 409 CONFIRM_SCOPE_CHANGED naming `destroyBacking`.
    // The flag arrives normalised (absent ≡ false, DeleteIscsiLunQuery's
    // default), so an omitted flag and an explicit `false` sign the same.
    const dataset = lun.dataset ?? zvolDataset(lun.backingPath)
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { target: iqn, lun: index, destroyBacking },
      address: ['target', 'lun'],
      presentationOnly: ISCSI_LUN_DELETE_PRESENTATION_ONLY,
      message: destroyBacking
        ? `Deleting LUN ${index} of '${iqn}' is irreversible — the unit serial goes with it, and so does its backing object`
        : `Deleting LUN ${index} of '${iqn}' is irreversible — the unit serial goes with it; the backing object is kept`,
      warnings: [
        `The unit serial ${lun.serial ?? '(unknown)'} goes with it — any PVE volid or initiator configuration built on it breaks`,
        ...(destroyBacking
          ? [
              // M5: the volume, and ONLY the volume — a volume that still has
              // snapshots is refused by the gate above, never swept.
              lun.kind === 'zvol'
                ? `The volume ${dataset} WILL be destroyed. Its snapshots are NOT destroyed with it — a volume that still has any is refused.`
                : `The image file ${lun.backingPath} WILL be removed.`,
            ]
          : [
              `The backing object ${lun.backingPath} is kept unless you tick "Also destroy" (re-send with ?destroyBacking=true)`,
              lun.kind === 'zvol'
                ? `If the backing is destroyed: the volume ${dataset} will be destroyed. `
                + `Its snapshots are NOT destroyed with it — a volume that still has any is refused, so remove them on the Datasets screen first.`
                : `If the backing is destroyed: the image file ${lun.backingPath} will be removed`,
            ]),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'iscsi.lun.delete',
      { ...identity, params: { target: iqn, lun: index, serial: lun.serial, backstore: lun.name, destroyBacking } },
      // Ruling (j): act on what was just re-read and re-gated, never on the
      // request-time snapshot.
      iscsiGuarded(spec, pre, async ({ target: now, lun: fresh }, ctx) => {
        const l = fresh as IscsiLun
        return deleteIscsiLun(
          mutateOptions(ctx.updateProgress),
          now,
          {
            index: l.index,
            name: l.name,
            plugin: l.plugin,
            kind: l.kind,
            backingPath: l.backingPath,
            ...(l.dataset ? { dataset: l.dataset } : {}),
          },
          destroyBacking,
        )
      }),
      { locks: pre.locks },
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

    const plan = await guardRepairPlan(
      planIscsiRepair(state.ctx, state.health, state.targets),
      state.ctx.live,
      statDeviceFrom(paths),
    )
    const refusal = assertRepairable(plan)
    if (refusal) {
      // cr.64b2-iii (I): when THIS request's read just quarantined a
      // placeholder, the plain "backing still absent" sentence reads as if
      // nothing happened — but something did: the stub was taken offline and
      // the persisted record kept (the quarantine never saves). Say what the
      // code did, so the operator knows the hole they see now is the one the
      // placeholder became, and the next Repair will replay the record.
      const tookOffline = state.outcomes.filter(o => o.quarantined)
      if (tookOffline.length > 0 && refusal.reason === 'backing-absent') {
        refusal.message += ` This request took ${tookOffline.length === 1 ? 'the 0-byte placeholder' : `${tookOffline.length} 0-byte placeholders`} the restore service had left behind offline — the LUN${tookOffline.length === 1 ? '' : 's'} no longer served by LIO — and kept the persisted record, so run Repair again once the real backing is back.`
      }
      return sendRefusal(reply, refusal)
    }

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
      async updateProgress => withIscsiLock(async () => {
        // ident.2: the plan above is the request's; the job may run later. It
        // is rebuilt from a fresh read under the lock, and a hole whose path
        // now names a device LIO already serves through another backstore is
        // blocked rather than given a second identity.
        const fresh = await readIscsiState(executor, paths)
        const freshPlan = await guardRepairPlan(
          planIscsiRepair(fresh.ctx, computeIscsiHealth(fresh.ctx, fresh.targets), fresh.targets),
          fresh.ctx.live,
          statDeviceFrom(paths),
        )
        return repairIscsiHoles(mutateOptions(updateProgress), freshPlan)
      }),
      // cr.40 (§4.2): the keys of every target and LUN the request's plan
      // repairs. The job re-plans under the mutex; a hole that appeared on
      // another target meanwhile is still serialised against every other
      // targetcli sequence by `withIscsiLock`.
      { locks: repairClaims(plan.repairable) },
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
