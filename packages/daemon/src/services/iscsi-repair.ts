/**
 * The repair door: put a boot-restore hole back (story `iscsi.5`).
 *
 * ## Why this is not `targetctl restore`
 *
 * The obvious repair is "re-run the thing that failed". It is not available, and
 * the reason is in rtslib's own source rather than in any documentation:
 *
 *     # /usr/bin/targetctl
 *     def restore(from_file):
 *         errors = RTSRoot().restore_from_file(restore_file=from_file)
 *
 *     # rtslib_fb.RTSRoot
 *     def restore_from_file(self, restore_file=None, clear_existing=True, …)
 *     def restore(self, config, …, clear_existing=False, …):
 *         if clear_existing:
 *             self.clear_existing(target, storage_object, confirm=True)
 *         elif any(self.storage_objects) or any(self.targets):
 *             … raise RTSLibError("target with wwn %s exist, not restoring")
 *
 * `targetctl restore` takes `restore_from_file`'s default, which is
 * `clear_existing=True`, so it **wipes the entire live tree first** — every
 * target, every backstore, every logged-in initiator on the node — and then
 * rebuilds. Repairing one hole that way would drop the sessions of every healthy
 * LUN beside it. And there is no CLI form that passes `clear_existing=False`;
 * even if there were, rtslib refuses outright when a target in the file already
 * exists live, which after a partial restore is always the case. (`systemctl
 * restart rtslib-fb-targetctl` is the same call plus an `ExecStop=targetctl
 * clear` in front of it, which is why DESIGN.md says ANAS never issues it.)
 *
 * So repair is SURGICAL and it is ANAS's own: for each missing LUN, recreate the
 * backstore from the PERSISTED record and re-map it at its stored index, using
 * exactly the identity contract every other recreate path uses —
 * `{serial, attributes}` replayed together, because `wwn` is create-only with no
 * `set` verb (GT-16) and attributes come back at stock defaults on every
 * recreate (GT-18). A repaired LUN is the SAME disk to its initiator, to ESXi,
 * to Windows and to any PVE volid built on its serial (GT-14/GT-45).
 *
 * ## Two rules that are not negotiable
 *
 *  1. **A hole is only repairable when its backing device is back.** Recreating
 *     a backstore over an absent device is what produced the hole in the first
 *     place. The preflight refuses with a 409 naming every path that is still
 *     missing, so the operator knows what to bring back.
 *  2. **Never `saveconfig` while anything is still missing** (GT-22). A save
 *     over an incomplete restore writes the truncated config over
 *     `saveconfig.json` and the LUN is gone for good. So the save happens only
 *     after a repair that left NO holes, and a partial repair says so instead.
 */

import type { IscsiHealth, IscsiLunAttributes, IscsiMissingLun, IscsiTargetDetail } from '@anas/shared'
import type { SaveconfigStorageObject } from '../parsers/lio-saveconfig.js'
import type { IscsiBackstoreAttributes, IscsiMutateOptions, IscsiRefusal } from './iscsi-mutate.js'
import type { IscsiReadContext } from './iscsi.js'
import { storageObjectsByName } from '../parsers/lio-saveconfig.js'
import {
  attributeTokens,
  backstorePath,
  ISCSI_DEFAULT_WRITE_BACK,
  replayAttributes,
  runTargetcli,
  saveIscsiConfig,
  tpgPath,
} from './iscsi-mutate.js'
import { attributesFromPersisted, normalizePlugin } from './iscsi.js'

/** One hole, with everything the replay needs, read off the PERSISTED config. */
export interface IscsiRepairItem {
  targetIqn: string
  tpgTag: number
  lunIndex: number
  backstoreName: string
  /** `block` | `fileio`. */
  plugin: string
  backingPath: string
  /** Is the backing device present RIGHT NOW? Only `true` is repairable. */
  backingPresent: boolean
  /** The stored unit serial, replayed as `wwn=`. Null when the record has none. */
  serial: string | null
  /** fileio only: the persisted size, which `create` needs. */
  size: number | null
  /** The persisted write-cache posture, replayed on the fileio create line. */
  writeBack: boolean
  /** The attribute set to replay after create, before the map. */
  attributes: IscsiBackstoreAttributes
  /** Initiator IQNs whose persisted ACL maps this LUN index. */
  aclInitiators: string[]
}

/** What a repair would do, before anything is run. */
export interface IscsiRepairPlan {
  /** Holes whose backing device is present — these are what a repair repairs. */
  repairable: IscsiRepairItem[]
  /** Holes whose backing device is still absent — reported, never touched. */
  blocked: IscsiRepairItem[]
}

/**
 * Turn the health diff into a repair plan, entirely from the PERSISTED config.
 *
 * The persisted record is the only honest source here: the live tree does not
 * have these objects (that is what makes them holes), and the built
 * `IscsiTargetDetail` for a missing LUN is itself derived from the same
 * persisted record. Reading `saveconfig.json` directly keeps the size, the
 * `write_back` flag and the raw attribute map — all three of which a create line
 * needs — in one place.
 */
export function planIscsiRepair(
  ctx: IscsiReadContext,
  health: IscsiHealth,
  targets: IscsiTargetDetail[],
): IscsiRepairPlan {
  const persistedStorage = ctx.persisted ? storageObjectsByName(ctx.persisted) : new Map<string, SaveconfigStorageObject>()
  const targetByIqn = new Map(targets.map(t => [t.iqn, t]))
  const repairable: IscsiRepairItem[] = []
  const blocked: IscsiRepairItem[] = []

  for (const missing of health.missingLuns) {
    const store = persistedStorage.get(missing.backstoreName)
    const plugin = normalizePlugin(store?.plugin ?? missing.plugin)
    const backingPath = store?.dev || missing.backingPath
    const attributes: IscsiLunAttributes = store
      ? attributesFromPersisted(store)
      : targetByIqn.get(missing.targetIqn)?.luns.find(l => l.index === missing.lunIndex)?.attributes ?? {}

    const item: IscsiRepairItem = {
      targetIqn: missing.targetIqn,
      tpgTag: missing.tpgTag,
      lunIndex: missing.lunIndex,
      backstoreName: missing.backstoreName,
      plugin,
      backingPath,
      // Only a checked, positive answer counts. `null` ("we could not tell")
      // is treated as absent: recreating over a device we cannot even stat is
      // how the hole was made.
      backingPresent: missing.backingExists === true,
      serial: store?.wwn ?? null,
      size: store?.size ?? null,
      writeBack: store?.writeBack ?? ISCSI_DEFAULT_WRITE_BACK,
      attributes: replayAttributes({ attributes }, plugin),
      aclInitiators: persistedAclsMapping(ctx, missing),
    }
    ;(item.backingPresent ? repairable : blocked).push(item)
  }

  return { repairable, blocked }
}

/** The initiators whose PERSISTED ACL maps this LUN index. */
function persistedAclsMapping(ctx: IscsiReadContext, missing: IscsiMissingLun): string[] {
  const target = (ctx.persisted?.targets ?? []).find(t => t.iqn === missing.targetIqn)
  const tpg = target?.tpgs.find(p => p.tag === missing.tpgTag)
  const acls = (tpg?.acls ?? []).filter(a => a.mappedLuns.includes(missing.lunIndex))
  return acls.map(a => a.initiatorIqn)
}

/** Nothing to repair — the live tree already matches the saved configuration. */
export function assertRepairable(plan: IscsiRepairPlan): IscsiRefusal | null {
  if (plan.repairable.length + plan.blocked.length === 0) {
    return {
      reason: 'nothing-to-repair',
      message: 'The live iSCSI configuration already matches the saved one — there is no restore hole to repair.',
    }
  }
  if (plan.repairable.length === 0) {
    const named = plan.blocked
      .map(b => `LUN ${b.lunIndex} of ${b.targetIqn} (backstore '${b.backstoreName}', ${b.backingPath})`)
      .join('; ')
    return {
      reason: 'backing-absent',
      message: `None of the missing LUNs can be repaired yet — their backing objects are still not on `
        + `this node: ${named}. Bring the storage back first (import the pool, restore the image, mount `
        + `the filesystem) and run Repair again. Recreating a backstore over an absent device is what `
        + `produced the hole.`,
    }
  }
  return null
}

/** One repaired LUN, or one that could not be. */
export interface IscsiRepairOutcome {
  targetIqn: string
  lunIndex: number
  backstoreName: string
  backingPath: string
  /** True when the stored serial was replayed — i.e. it is the same disk. */
  serialReplayed: boolean
}

/**
 * Execute a repair plan.
 *
 * Per hole, the order is the same contract `addIscsiLun` and `resizeFileLun`
 * use, and for the same reasons:
 *
 *   create backstore with `wwn=` → replay EVERY attribute → map at the STORED
 *   index → re-grant to every ACL that mapped it
 *
 * `block_size` leads the attribute list and the whole set is applied before the
 * map, because `set attribute block_size=` fails `[Errno 22]` once a backstore
 * is activated (GT-27).
 *
 * `saveconfig` runs ONLY if nothing is left missing (GT-22). The caller runs
 * this under the daemon-wide iSCSI mutex.
 */
export async function repairIscsiHoles(
  opts: IscsiMutateOptions,
  plan: IscsiRepairPlan,
): Promise<{
  repaired: IscsiRepairOutcome[]
  stillMissing: IscsiRepairOutcome[]
  saved: boolean
}> {
  const { executor } = opts
  const repaired: IscsiRepairOutcome[] = []

  for (const item of plan.repairable) {
    const store = backstorePath(item.plugin, item.backstoreName)

    opts.progress?.(`Recreating ${item.plugin} backstore ${item.backstoreName} from the saved configuration`)
    if (item.plugin === 'fileio') {
      const args = [
        '/backstores/fileio',
        'create',
        `name=${item.backstoreName}`,
        `file_or_dev=${item.backingPath}`,
        `size=${item.size ?? 0}`,
        `write_back=${item.writeBack}`,
      ]
      // A record with no stored serial is the one case where identity cannot be
      // replayed. It is recreated without `wwn=` and the result says so rather
      // than pretending the disk came back the same.
      if (item.serial)
        args.push(`wwn=${item.serial}`)
      await runTargetcli(executor, args)
    }
    else {
      const args = [
        `/backstores/${item.plugin}`,
        'create',
        `name=${item.backstoreName}`,
        `dev=${item.backingPath}`,
      ]
      if (item.serial)
        args.push(`wwn=${item.serial}`)
      await runTargetcli(executor, args)
    }

    for (const token of attributeTokens(item.attributes)) {
      opts.progress?.(`Replaying ${token} on ${item.backstoreName}`)
      await runTargetcli(executor, [store, 'set', 'attribute', token])
    }

    opts.progress?.(`Re-mapping ${item.backstoreName} as LUN ${item.lunIndex} of ${item.targetIqn}`)
    await runTargetcli(executor, [
      `${tpgPath(item.targetIqn, item.tpgTag)}/luns`,
      'create',
      `storage_object=${store}`,
      `lun=${item.lunIndex}`,
    ])

    for (const initiator of item.aclInitiators) {
      opts.progress?.(`Granting LUN ${item.lunIndex} to ${initiator}`)
      await runTargetcli(executor, [
        `${tpgPath(item.targetIqn, item.tpgTag)}/acls/${initiator}`,
        'create',
        String(item.lunIndex),
        String(item.lunIndex),
      ])
    }

    repaired.push(outcome(item))
  }

  const stillMissing = plan.blocked.map(outcome)

  // GT-22: the save is the last step, and only when the tree is whole again.
  // Saving with a hole left in it writes the hole into saveconfig.json forever.
  let saved = false
  if (stillMissing.length === 0) {
    opts.progress?.('Saving the LIO configuration')
    await saveIscsiConfig(executor)
    saved = true
  }
  else {
    opts.progress?.(
      `Not saving: ${stillMissing.length} LUN${stillMissing.length === 1 ? '' : 's'} still missing — `
      + 'a save now would write the remaining hole into saveconfig.json permanently',
    )
  }

  return { repaired, stillMissing, saved }
}

function outcome(item: IscsiRepairItem): IscsiRepairOutcome {
  return {
    targetIqn: item.targetIqn,
    lunIndex: item.lunIndex,
    backstoreName: item.backstoreName,
    backingPath: item.backingPath,
    serialReplayed: item.serial !== null,
  }
}
