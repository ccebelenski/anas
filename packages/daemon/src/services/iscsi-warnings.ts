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

import type { DashboardWarning, IscsiHealth, IscsiTargetDetail } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { IscsiPaths } from './iscsi.js'
import { readIscsiHealthWithQuarantine } from './iscsi-quarantine.js'

/**
 * Build the `iscsi` dashboard cards from a health diff. Pure — the caller has
 * already paid for the read.
 *
 * Six card shapes, in the order an operator needs them:
 *
 *  1. **A target serving nothing** (`critical`) — the target is up and enabled
 *     with none of its saved LUNs. It is accepting logins and handing out an
 *     empty disk list.
 *  1b. **A LUN over a PLACEHOLDER** (`critical`, story `iscsi.8`) — the worst of
 *     the family, because it is the only one an initiator cannot see: the disk is
 *     present, the right size and the right serial, and empty. Names both signals
 *     and says whether ANAS managed to take it offline.
 *  3b. **An ANAS target that is DISABLED** (`warning`) — serving nothing on
 *     purpose, most often after a partial image restore, with the reason when a
 *     retained job still has it.
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

  // 1b. A LUN being served over a PLACEHOLDER (story `iscsi.8`, live-proof F2).
  //     Critical, and above the missing-LUN cards on purpose: a hole is visible
  //     to the initiator (the disk is gone), a stub is not (the disk is there,
  //     the right size, the right serial, and empty). This is the only card that
  //     can tell an operator their data was never being served.
  for (const stub of health.stubLuns) {
    const why = stub.zeroSized && stub.wrongMount
      ? `it is 0 bytes where the saved configuration says ${stub.persistedSize}, and it is on ${stub.containingMount} instead of ${stub.expectedMount}`
      : stub.zeroSized
        ? `it is 0 bytes where the saved configuration says ${stub.persistedSize}`
        : `it is on ${stub.containingMount} instead of ${stub.expectedMount}`
    const action = stub.quarantined
      ? `ANAS has taken it offline${stub.fileRemoved ? ' and removed the placeholder' : ''}; mount the filesystem and use Repair on the iSCSI menu to put the LUN back with its own serial.`
      : `ANAS could NOT take it offline — it is still being served. Log initiators out and delete LUN ${stub.lunIndex} by hand, then mount the filesystem and use Repair.`
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `LUN ${stub.lunIndex} '${stub.backstoreName}' of target ${stub.targetIqn} is a placeholder created by `
        + `the restore service — its filesystem was not mounted, so ${stub.backingPath} holds no data (${why}). `
        + `An initiator reading it sees an empty disk of the right size with the right serial. ${action}`,
      ref: stub.targetIqn,
    })
  }

  for (const lun of health.missingLuns) {
    // A hole ANAS made itself, by taking a placeholder off the network, must
    // keep saying so: "that path is still missing" is confusing when there is
    // visibly a file at it (story `iscsi.8`).
    const placeholderClause = ' That path holds a PLACEHOLDER the restore service created — a file of the right name '
      + 'that is not the image, which is why ANAS took the LUN offline. Mount the filesystem that should hold the '
      + 'image, then use Repair on the iSCSI menu to put the LUN back with its own serial.'
    const backNow = lun.stubBacking
      ? placeholderClause
      : lun.backingExists === true
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
    const stubs = health.stubLuns.length
    // The `incomplete restore (N LUN…)` phrasing is the one an operator has seen
    // since `iscsi.5`; a stub gets its own headline because it is a different
    // fact (nothing is missing — something wrong is being served) and reading it
    // as "incomplete restore" would send the operator looking for an absence.
    const incomplete = `is an incomplete restore (${n} LUN${n === 1 ? '' : 's'} in the saved configuration that the kernel does not have)`
    const placeholders = `is serving ${stubs} LUN${stubs === 1 ? '' : 's'} over a placeholder file the restore service created`
    const headline = stubs > 0 && n > 0
      ? `${incomplete} AND ${placeholders}`
      : stubs > 0 ? placeholders : incomplete
    warnings.push({
      level: 'critical',
      category: 'iscsi',
      message: `The live iSCSI configuration ${headline}. Saving now would `
        + `write the hole into /etc/rtslib-fb-target/saveconfig.json permanently, so iSCSI mutations are `
        + `refused until this is repaired.`,
    })
  }

  // A target ANAS owns that is switched off is serving nothing, and the decision
  // that switched it off lives in a job that is gone (live-proof F12).
  for (const t of health.disabledTargets) {
    warnings.push({
      level: 'warning',
      category: 'iscsi',
      message: `iSCSI target ${t.targetIqn} is disabled — it is serving nothing, and its `
        + `${t.lunCount} LUN${t.lunCount === 1 ? '' : 's'} ${t.lunCount === 1 ? 'is' : 'are'} unreachable `
        + `(LIO's enable flag is per target, not per LUN). ${t.detail ? `${t.detail} ` : ''}`
        + `Enable it from the iSCSI menu when you are ready.`,
      ref: t.targetIqn,
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
  opts: { disabledDetail?: (target: IscsiTargetDetail) => string | undefined } = {},
): Promise<DashboardWarning[]> {
  try {
    // The dashboard read is one of the two moments ANAS looks at the iSCSI tree,
    // so it is one of the two that QUARANTINES a stub (story `iscsi.8`). A node
    // with no placeholder pays exactly what it paid before: one gather, no lock,
    // no second read.
    const { ctx, health } = await readIscsiHealthWithQuarantine(executor, paths, opts)
    if (!ctx.live.present && ctx.persisted === null)
      return []
    return buildIscsiWarnings(health)
  }
  catch {
    return []
  }
}
