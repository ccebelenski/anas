import type { IscsiHealth, IscsiSessionList, IscsiTargetDetail, IscsiTargetList } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { IscsiPaths } from '../services/iscsi.js'
import { IscsiIqn } from '@anas/shared'
import { readNodeInitiatorName } from '../parsers/iscsi-initiator.js'
import { readIscsiHealthWithQuarantine } from '../services/iscsi-quarantine.js'
import { buildIscsiTargets, collectIscsiSessions, iscsiAvailability, readIscsiContext, toTargetSummary } from '../services/iscsi.js'
import { readPveFirewallAdvisory } from '../services/pve-firewall.js'

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
  /** `/etc/pve/firewall` override (story iscsi.6) — read-only, tests only. */
  firewallDir?: string
}

export async function iscsiRoutes(server: FastifyInstance, opts: IscsiRouteOptions) {
  const { executor, firewallDir, ...paths } = opts

  // --- GET /iscsi/targets --------------------------------------------------
  server.get('/iscsi/targets', async () => {
    const ctx = await readIscsiContext(executor, paths)
    const targets = await buildIscsiTargets(ctx)
    // The node's own initiator IQN rides the LIST envelope (not the detail):
    // it is a property of the node, not of any target, and the create dialog —
    // the one that needs it — reads the list. Deliberately NOT folded into
    // readIscsiContext, which bails out early on a node with no targets: a
    // fresh install with zero targets is exactly when the field is needed.
    const nodeInitiatorIqn = await readNodeInitiatorName(paths.initiatorNamePath)
    const result: IscsiTargetList = {
      ...iscsiAvailability(ctx),
      targets: targets.map(toTargetSummary),
      nodeInitiatorIqn,
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
  // The one read that is allowed to CHANGE something (story `iscsi.8`): a fileio
  // LUN found to be serving a placeholder is unmapped before the answer is sent,
  // because the alternative is reporting the problem while the empty disk stays
  // on the network. Everything else here is still strictly read-only, and a node
  // with no stub takes no lock and does no extra work.
  server.get('/iscsi/health', async () => {
    const { health } = await readIscsiHealthWithQuarantine(executor, paths)
    const result: IscsiHealth = health
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
    // Story iscsi.6: a portal can be perfectly healthy and still unreachable
    // because PVE's firewall drops 3260/tcp — LIO will never say so, and neither
    // will `ss`. Read-only, fail-open, and NEVER a rule ANAS writes: the advisory
    // points at PVE. Absent (not null-filled) when there is nothing to say.
    const firewall = await readPveFirewallAdvisory(executor, firewallDir === undefined ? {} : { firewallDir })
    return { data: { ...target, firewall } }
  })
}
