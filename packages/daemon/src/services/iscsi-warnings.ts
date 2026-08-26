/**
 * iSCSI → dashboard warning cards (story `iscsi.5`).
 *
 * The whole reason the `iscsi` category exists is that **nothing else on this
 * node will ever tell anyone**:
 *
 *  - a boot restore whose backing device was missing exits 0 and is logged by
 *    systemd as `Result=success`; `targetctl` collects the per-object errors and
 *    prints them without turning one into an exit code, so no `Restart=` and no
 *    `OnFailure=` can catch it (GT-20). With a whole pool late, the target comes
 *    up enabled and listening with ZERO LUNs and an initiator logs in happily
 *    and sees no disks (GT-21).
 *  - a portal bound to an address no interface carries reports `[OK]`, survives
 *    the interface being deleted and a service restart, and never logs a word
 *    (GT-24).
 *
 * So this is a PULL, computed from the saveconfig ⟷ configfs diff the health
 * endpoint already produces — no poller, no push, no state file (the standing
 * dashboard ruling). It renders TARGET-FIRST, because the operator's question is
 * "which of my targets is lying to its initiators", not "how many LUNs are
 * missing".
 *
 * Healthy adds NOTHING, LIO-not-installed adds NOTHING, and every failure is
 * swallowed to `[]` — a node that serves no block storage must never see an
 * iSCSI card, and a broken iSCSI read must never blank the dashboard.
 */

import type { DashboardWarning, IscsiHealth } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { IscsiPaths } from './iscsi.js'
import { computeIscsiHealth } from './iscsi-health.js'
import { buildIscsiTargets, readIscsiContext } from './iscsi.js'

/**
 * Build the `iscsi` dashboard cards from a health diff. Pure — the caller has
 * already paid for the read.
 *
 * Four card shapes, in the order an operator needs them:
 *
 *  1. **A target serving nothing** (`critical`) — the target is up and enabled
 *     with none of its saved LUNs. It is accepting logins and handing out an
 *     empty disk list.
 *  2. **A LUN that did not restore** (`warning`) — one disk vanished out of a
 *     target that is otherwise serving. Names the LUN, the target and the
 *     backing path the restore could not open, and says whether that path is
 *     back now (which is what makes the repair door usable).
 *  3. **The degraded verdict** (`critical`) — the consequence that spans the
 *     whole node: while a restore is known incomplete NOTHING may run
 *     `saveconfig`, because a save writes the truncated config over
 *     `saveconfig.json` and the LUN is gone for good (GT-22). So every iSCSI
 *     mutation is refused until it is repaired, and the card says so.
 *  4. **A portal on an address no interface carries** (`warning`).
 *
 * 1 and 2 overlap on purpose: a target serving nothing also has missing LUNs,
 * and both facts are worth a line — one says which disks, one says the target is
 * not actually ready.
 */
export function buildIscsiWarnings(health: IscsiHealth): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  if (!health.installed)
    return warnings

  for (const t of health.targetsServingNothing) {
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `iSCSI target ${t.targetIqn} restored with none of its ${t.persistedLunCount} `
        + `LUN${t.persistedLunCount === 1 ? '' : 's'} — the backing storage was not available. `
        + `${t.enabled ? 'It is enabled and accepting logins with no disks behind it' : 'It is disabled'}.`,
      ref: t.targetIqn,
    })
  }

  for (const lun of health.missingLuns) {
    const backNow = lun.backingExists === true
      ? ' That path is available again — use Repair on the iSCSI menu to put the LUN back.'
      : lun.backingExists === false
        ? ' That path is still missing — bring the storage back (import the pool, restore the image) first.'
        : ''
    warnings.push({
      level: 'warning',
      category: 'iscsi',
      message: `LUN ${lun.lunIndex} '${lun.backstoreName}' of target ${lun.targetIqn} did not restore — `
        + `its backing ${lun.backingPath} was not available; the target is serving without it.${backNow}`,
      ref: lun.targetIqn,
    })
  }

  if (health.degraded) {
    const n = health.missingLuns.length
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `The live iSCSI configuration is an incomplete restore (${n} LUN${n === 1 ? '' : 's'} `
        + `in the saved configuration that the kernel does not have). Saving now would write the `
        + `hole into /etc/rtslib-fb-target/saveconfig.json permanently, so iSCSI mutations are `
        + `refused until this is repaired.`,
    })
  }

  for (const p of health.portalsWithoutInterface) {
    warnings.push({
      level: 'warning',
      category: 'iscsi',
      message: `Portal ${p.address}:${p.port} of target ${p.targetIqn} is bound to an address no `
        + `interface on this node carries — LIO binds it anyway, reports it healthy and never logs `
        + `a word, so initiators simply cannot reach it.`,
      ref: p.targetIqn,
    })
  }

  return warnings
}

/**
 * Collect the dashboard `iscsi` warnings, FAIL-OPEN — the same shape as
 * `collectScheduleWarnings` / `collectBackupWarnings` / `collectMountWarnings`.
 *
 * Cost on a node that serves no block storage is two `stat` calls: with neither
 * a configfs target tree nor a `saveconfig.json`, `readIscsiContext` returns
 * before it reads `storage.cfg`, `zfs list`, `ip addr` or AHR topology.
 */
export async function collectIscsiWarnings(
  executor: CommandExecutor,
  paths: IscsiPaths = {},
): Promise<DashboardWarning[]> {
  try {
    const ctx = await readIscsiContext(executor, paths)
    if (!ctx.live.present && ctx.persisted === null)
      return []
    const targets = await buildIscsiTargets(ctx)
    return buildIscsiWarnings(computeIscsiHealth(ctx, targets))
  }
  catch {
    return []
  }
}
