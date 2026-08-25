import type { IscsiHealth, IscsiSessionList, IscsiTargetDetail, IscsiTargetList } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { IscsiIqn } from '@anas/shared'
import { computeIscsiHealth } from '../services/iscsi-health.js'
import { buildIscsiTargets, collectIscsiSessions, iscsiAvailability, readIscsiContext, toTargetSummary } from '../services/iscsi.js'

/**
 * iSCSI — the READ layer (story `iscsi.2`).
 *
 *   GET /v1/iscsi/targets       → every target on the node, ANAS-owned + foreign
 *   GET /v1/iscsi/targets/:iqn  → one target in full (IQN is URL-encoded)
 *   GET /v1/iscsi/sessions      → every live session on the node
 *   GET /v1/iscsi/health        → the saveconfig ⟷ configfs diff
 *
 * Read-only, all of it. Every mutation in the epic is a job and belongs to
 * `iscsi.4`; nothing here writes, execs `targetcli`, or touches configfs.
 *
 * FAIL-OPEN is the contract, not a nicety: a node without `targetcli-fb` has no
 * configfs target tree and no `saveconfig.json`, and these routes report that as
 * `installed: false` with empty collections and a 200. Most PVE nodes serve no
 * block storage, and an iSCSI read must never be the reason a screen breaks.
 *
 * The gateway needs nothing for the new prefix: it forwards
 * `/api/nodes/<node>/v1/*` to `/v1/*` generically and deliberately preserves the
 * path's percent-encoding, which is what keeps a URL-encoded IQN intact.
 */
export interface IscsiRouteOptions extends IscsiPaths {
  executor: CommandExecutor
}

export async function iscsiRoutes(server: FastifyInstance, opts: IscsiRouteOptions) {
  const { executor, ...paths } = opts

  // --- GET /iscsi/targets --------------------------------------------------
  server.get('/iscsi/targets', async () => {
    const ctx = await readIscsiContext(executor, paths)
    const targets = await buildIscsiTargets(ctx)
    const result: IscsiTargetList = {
      ...iscsiAvailability(ctx),
      targets: targets.map(toTargetSummary),
    }
    return { data: result }
  })

  // --- GET /iscsi/sessions -------------------------------------------------
  // Registered BEFORE the /:iqn route so `sessions` is never taken for an IQN.
  server.get('/iscsi/sessions', async () => {
    const ctx = await readIscsiContext(executor, paths)
    const targets = await buildIscsiTargets(ctx)
    const result: IscsiSessionList = {
      ...iscsiAvailability(ctx),
      sessions: collectIscsiSessions(targets),
    }
    return { data: result }
  })

  // --- GET /iscsi/health ---------------------------------------------------
  server.get('/iscsi/health', async () => {
    const ctx = await readIscsiContext(executor, paths)
    const targets = await buildIscsiTargets(ctx)
    const result: IscsiHealth = computeIscsiHealth(ctx, targets)
    return { data: result }
  })

  // --- GET /iscsi/targets/:iqn ---------------------------------------------
  // A target's identity is its IQN, URL-encoded in the path (Fastify decodes the
  // param; the gateway hands the encoded form through untouched).
  server.get<{ Params: { iqn: string } }>('/iscsi/targets/:iqn', async (request, reply) => {
    const parsed = IscsiIqn.safeParse(request.params.iqn)
    if (!parsed.success) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Invalid iSCSI target name: ${parsed.error.issues[0]?.message ?? 'not an iSCSI name'}`,
        },
      }
    }
    const iqn = parsed.data

    const ctx = await readIscsiContext(executor, paths)
    const targets = await buildIscsiTargets(ctx)
    const target: IscsiTargetDetail | undefined = targets.find(t => t.iqn === iqn)
    if (!target) {
      reply.code(404)
      const availability = iscsiAvailability(ctx)
      return {
        error: {
          code: 'NOT_FOUND',
          message: availability.installed
            ? `iSCSI target '${iqn}' not found`
            : `iSCSI target '${iqn}' not found: the LIO target stack is not present on this node`,
        },
      }
    }
    return { data: target }
  })
}
