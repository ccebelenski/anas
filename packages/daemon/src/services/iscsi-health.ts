/**
 * `/v1/iscsi/health` — the persisted ⟷ live diff (story `iscsi.2`).
 *
 * This endpoint exists because of one ground-truth finding: **a boot restore
 * whose backing device was missing reports systemd SUCCESS** and comes up with a
 * hole in it (GT-20/GT-21). `targetctl` collects the per-object errors and
 * prints them without ever turning one into an exit code, so `Restart=` and
 * `OnFailure=` can never catch it; with a whole pool late, the target comes up
 * enabled, listening, and serving ZERO LUNs while an initiator logs in happily
 * and sees no disks.
 *
 * The only detector is to compare what `saveconfig.json` says should exist
 * against what configfs actually has. That comparison is this file.
 *
 * Two other things LIO will never tell anyone:
 *
 *  - **A portal on an address that does not exist.** Creating one succeeds,
 *    `targetcli ls` shows `[OK]`, `ss` shows the listener, and deleting the
 *    interface produces no error and no log line — ever (GT-24). So ANAS diffs
 *    the configured portal addresses against the node's own addresses itself.
 *  - **Live changes nobody persisted.** Anything created outside ANAS and never
 *    saved simply disappears at the next boot.
 *
 * And one thing this diff GUARDS: `degraded` is the flag that must stop any
 * `saveconfig` (stories `iscsi.4`/`iscsi.5`). After a degraded restore, LIO's
 * in-memory config no longer contains the missing LUN, so a save — including the
 * AUTOMATIC one when a stdin-mode targetcli session exits — writes the truncated
 * config over the file and the LUN is gone for good (GT-22).
 *
 * `iscsi.2` deliberately stops at the shape: the dashboard warning category and
 * a `collectIscsiWarnings` belong to `iscsi.5`. Every element here already
 * carries its target reference and a rendered sentence so that consumer needs no
 * second read.
 */

import type { IscsiForeignChange, IscsiHealth, IscsiMissingLun, IscsiPortalWithoutInterface, IscsiTargetDetail } from '@anas/shared'
import type { IscsiReadContext } from './iscsi.js'
import { iscsiAvailability, normalizePlugin } from './iscsi.js'

/**
 * Compute the health diff from a gathered context and the targets already built
 * from it. Pure — no reads of its own, so the routes pay for one gather.
 */
export function computeIscsiHealth(
  ctx: IscsiReadContext,
  targets: IscsiTargetDetail[],
  now: Date = new Date(),
): IscsiHealth {
  const missingLuns: IscsiMissingLun[] = []
  const portalsWithoutInterface: IscsiPortalWithoutInterface[] = []
  const foreignChanges: IscsiForeignChange[] = []

  const liveByIqn = new Map(ctx.live.targets.map(t => [t.iqn, t]))
  const persistedByIqn = new Map((ctx.persisted?.targets ?? []).map(t => [t.iqn, t]))
  const liveBackstoreNames = new Set(ctx.live.backstores.map(b => b.name))
  const persistedBackstores = new Map((ctx.persisted?.storageObjects ?? []).map(s => [s.name, s]))

  for (const target of targets) {
    // --- LUNs in saveconfig with no configfs counterpart: the restore hole ---
    for (const lun of target.luns) {
      if (lun.present)
        continue
      // Only a PERSISTED LUN can be a restore hole. A LUN that is in neither
      // source cannot exist, and one that is live-only is a different finding.
      const persistedTpg = persistedByIqn.get(target.iqn)?.tpgs.find(t => t.tag === target.tpgTag)
      const persistedLun = persistedTpg?.luns.find(l => l.index === lun.index)
      if (!persistedLun)
        continue
      const backstore = persistedLun.backstoreName ? persistedBackstores.get(persistedLun.backstoreName) : undefined
      missingLuns.push({
        targetIqn: target.iqn,
        tpgTag: target.tpgTag,
        lunIndex: lun.index,
        backstoreName: persistedLun.backstoreName ?? lun.name,
        plugin: normalizePlugin(backstore?.plugin ?? persistedLun.plugin ?? lun.plugin),
        backingPath: backstore?.dev ?? lun.backingPath,
        backingExists: lun.backingExists,
      })
    }

    // --- portals bound to addresses no interface carries --------------------
    if (ctx.nodeAddresses !== null) {
      for (const portal of target.portals) {
        if (portal.carriedByInterface === false) {
          portalsWithoutInterface.push({
            targetIqn: target.iqn,
            tpgTag: target.tpgTag,
            address: portal.address,
            port: portal.port,
          })
        }
      }
    }

    // --- live/persisted divergences that are not a restore hole -------------
    if (!target.persisted && target.present) {
      foreignChanges.push({
        kind: 'target-not-persisted',
        targetIqn: target.iqn,
        detail: `Target ${target.iqn} is live but absent from the saved configuration — it will not come back after a reboot`,
      })
    }
    else if (target.persisted && !target.present) {
      foreignChanges.push({
        kind: 'target-not-restored',
        targetIqn: target.iqn,
        detail: `Target ${target.iqn} is in the saved configuration but is not live — the restore did not bring it up`,
      })
    }

    const persistedTpg = persistedByIqn.get(target.iqn)?.tpgs.find(t => t.tag === target.tpgTag)
    const liveTpg = liveByIqn.get(target.iqn)?.tpgs.find(t => t.tag === target.tpgTag)

    if (persistedTpg && liveTpg) {
      const persistedLunIndexes = new Set(persistedTpg.luns.map(l => l.index))
      for (const lun of liveTpg.luns) {
        if (!persistedLunIndexes.has(lun.index)) {
          foreignChanges.push({
            kind: 'lun-not-persisted',
            targetIqn: target.iqn,
            detail: `LUN ${lun.index} (${lun.backstoreName ?? 'unnamed'}) of ${target.iqn} is live but not in the saved configuration — it will not come back after a reboot`,
          })
        }
      }

      const persistedPortals = new Set(persistedTpg.portals.map(p => `${p.address.toLowerCase()}:${p.port}`))
      const livePortals = new Set(liveTpg.portals.map(p => `${p.address.toLowerCase()}:${p.port}`))
      for (const p of liveTpg.portals) {
        if (!persistedPortals.has(`${p.address.toLowerCase()}:${p.port}`)) {
          foreignChanges.push({
            kind: 'portal-not-persisted',
            targetIqn: target.iqn,
            detail: `Portal ${p.address}:${p.port} of ${target.iqn} is live but not in the saved configuration`,
          })
        }
      }
      for (const p of persistedTpg.portals) {
        if (!livePortals.has(`${p.address.toLowerCase()}:${p.port}`)) {
          foreignChanges.push({
            kind: 'portal-not-restored',
            targetIqn: target.iqn,
            detail: `Portal ${p.address}:${p.port} of ${target.iqn} is in the saved configuration but is not live`,
          })
        }
      }
    }

    // --- a backstore whose live backing path no longer matches the saved one -
    for (const lun of target.luns) {
      if (!lun.name || !liveBackstoreNames.has(lun.name))
        continue
      const persisted = persistedBackstores.get(lun.name)
      if (persisted && persisted.dev !== lun.backingPath) {
        foreignChanges.push({
          kind: 'backing-path-changed',
          targetIqn: target.iqn,
          detail: `LUN ${lun.index} (${lun.name}) is serving ${lun.backingPath} but the saved configuration says ${persisted.dev} — the next restore would use the saved path`,
        })
      }
    }
  }

  return {
    ...iscsiAvailability(ctx),
    missingLuns,
    portalsWithoutInterface,
    foreignChanges,
    // A hole in the live config makes every `saveconfig` destructive (GT-22).
    degraded: missingLuns.length > 0,
    interfacesUnknown: ctx.nodeAddresses === null,
    checkedAt: now.toISOString(),
  }
}
