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

import type { IscsiHealth, IscsiHoleRepair, IscsiTargetDetail } from '@anas/shared'
import type { IscsiMutateOptions, IscsiRefusal } from './iscsi-mutate.js'
import type { IscsiBackstoreAttributes } from './iscsi-rules.js'
import type { IscsiReadContext } from './iscsi.js'
import { foreignHolesSentence, holeReplayRecord } from './iscsi-hole.js'
import { grantLunsToAcl, runTargetcli, saveIscsiConfig } from './iscsi-mutate.js'
import { attributeTokens, backstorePath, tpgPath } from './iscsi-rules.js'
import { clearMarkCommand, isFileMark, unreadableMarkWay } from './restore-mark.js'

/**
 * The replay record of one hole: everything a `create` line needs to bring the
 * same disk back, read off the PERSISTED config.
 */
export interface HoleReplayRecord {
  targetIqn: string
  tpgTag: number
  lunIndex: number
  backstoreName: string
  /** `block` | `fileio`. */
  plugin: string
  backingPath: string
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

/**
 * One hole: its replay record plus Repair's verdict on it.
 *
 * The verdict is the health read's (`holeRepairVerdict`), never Repair's own. It
 * is absent only when that read judged nothing about the hole — it gathered no
 * I/O facts for it — and a hole with no verdict is never repaired.
 */
export type IscsiRepairItem = HoleReplayRecord & { verdict?: IscsiHoleRepair }

/** What a repair would do, before anything is run. */
export interface IscsiRepairPlan {
  /** Holes the verdict calls `ready` — these are what a repair repairs. */
  repairable: IscsiRepairItem[]
  /** Every other hole — reported from its verdict, never touched. */
  blocked: IscsiRepairItem[]
}

/**
 * Repair's view of a health diff: the holes whose verdict is `ready` are the
 * plan, every other hole is blocked. Nothing is decided here — each hole
 * carries the verdict its health read gave it.
 */
export function planIscsiRepair(
  ctx: IscsiReadContext,
  health: IscsiHealth,
  targets: IscsiTargetDetail[],
): IscsiRepairPlan {
  const repairable: IscsiRepairItem[] = []
  const blocked: IscsiRepairItem[] = []
  for (const missing of health.missingLuns) {
    const item: IscsiRepairItem = {
      ...holeReplayRecord(ctx, missing, targets),
      ...(missing.repair ? { verdict: missing.repair } : {}),
    }
    if (missing.repair?.state === 'ready')
      repairable.push(item)
    else
      blocked.push(item)
  }
  return { repairable, blocked }
}

/**
 * The extra sentence a BLOCKED hole gets when its path holds a placeholder
 * rather than nothing at all (story `iscsi.8`). "Still not on this node" is
 * confusing when the operator can see a file sitting right there.
 */
function stubClause(stubs: number): string {
  return ` ${stubs === 1 ? 'One path holds' : `${stubs} paths hold`} a 0-byte placeholder the restore `
    + `service created on the wrong filesystem: it is NOT the image, and repairing over it would `
    + `serve an empty disk with the right serial (story iscsi.8).`
}

/**
 * The sentence for holes a restore mark holds back (cr3.lunrestore, review2
 * E), with the ways out that exist for a hole: accept the image (clear the
 * mark, Repair again), or drop the LUN from the saved configuration by hand
 * and restore the image as a new LUN; for an unreadable mark or a running
 * restore, wait. '' when there are none.
 */
function restoreMarkClause(marked: IscsiRepairItem[]): string {
  if (marked.length === 0)
    return ''
  const named = marked.map(b => `LUN ${b.lunIndex} of ${b.targetIqn} (backstore '${b.backstoreName}', ${b.backingPath}): ${b.verdict!.detail}`).join('; ')
  const ways: string[] = []
  const settled = marked.filter(b => b.verdict!.restoreMark === 'interrupted' || b.verdict!.restoreMark === 'unverified')
  if (settled.length > 0) {
    // cr3.lunrestore.filemark: the mark is on the volume, or on the image
    // file itself; review S3: or there is none, and a restore job's record
    // holds the hole back (no mark to clear).
    const marked = settled.filter(b => b.verdict!.markOn)
    const recorded = settled.length - marked.length
    const clear = marked.map(b => `'${clearMarkCommand(b.verdict!.markOn!)}'`)
    const onFiles = marked.filter(b => isFileMark(b.verdict!.markOn!)).length
    const keeper = onFiles === 0 ? 'the volume keeps' : onFiles === marked.length ? 'the image file keeps' : 'each volume or image file keeps'
    const accept = marked.length > 0
      ? `If you accept ${marked.length === 1 ? 'the image' : 'an image'} as it is, clear its restore mark (${clear.join(', ')}) and run Repair again. `
      : ''
    const record = recorded > 0
      ? 'An image file known only from a restore job\'s record has no mark to clear: the record stands until a later restore onto that file, or an Enable of its target, completes. '
      : ''
    const drop = `${marked.length > 0 ? 'If you do not, saving' : 'Saving'} the iSCSI configuration by hand ('targetcli saveconfig') removes `
      + `the LUN from the saved configuration for good, together with every other missing LUN${marked.length > 0 ? `; ${keeper} its mark,` : ','} `
      + `and the image can then be restored as a new LUN.`
    ways.push(`Repair would map ${settled.length === 1 ? 'that image' : 'those images'} into the target again, so it does not. ${accept}${record}${drop}`)
  }
  if (marked.some(b => b.verdict!.restoreMark === 'unreadable')) {
    // review S4: for an image file, the command that shows it.
    const see = marked.filter(b => b.verdict!.restoreMark === 'unreadable' && b.verdict!.markOn).map(b => unreadableMarkWay(b.verdict!.markOn!, 'Repair')).join('')
    ways.push(`Repair is refused for a LUN whose restore mark could not be read until it can be read.${see}`)
  }
  if (marked.some(b => b.verdict!.restoreMark === 'in-progress'))
    ways.push('Repair is refused for a LUN a restore is writing until the restore ends.')
  return ` ${marked.length === 1 ? 'One hole is' : `${marked.length} holes are`} held back by a restore mark on the backing: ${named}. ${ways.join(' ')}`
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
    // cr3 (ISCSI-L7): holes in foreign targets are never Repair's. When they
    // are ALL there is, the refusal says so — and that the node stays
    // degraded, and why — instead of an instruction to run Repair again.
    const foreign = plan.blocked.filter(b => b.verdict?.state === 'foreign-target')
    // cr3 review 2: holes of a target ANAS will not write to, named with that
    // target's own refusal.
    const handsOff = plan.blocked.filter(b => b.verdict?.state === 'target-hands-off')
    const foreignClause = (foreign.length > 0 ? ` ${foreignHolesSentence(foreign)}` : '')
      + (handsOff.length > 0
        ? ` ${handsOff.map(b => `LUN ${b.lunIndex} of ${b.targetIqn}`).join(', ')} ${handsOff.length === 1 ? 'is' : 'are'} not repaired: `
        + `${[...new Set(handsOff.map(b => b.verdict!.detail))].join(' ')}`
        : '')
    const own = plan.blocked.filter(b => b.verdict?.state !== 'foreign-target' && b.verdict?.state !== 'target-hands-off')
    // cr3.lunrestore (review2 E): holes held back by a restore mark are their
    // own kind — a modelled state on the item, never a sentence match — with
    // their own sentence and ways out that exist for a HOLE (an in-place
    // restore needs a live LUN, so "restore again" is not one of them).
    const marked = own.filter(b => b.verdict?.state === 'restore-mark')
    const markedClause = restoreMarkClause(marked)
    if (own.length === 0) {
      return {
        reason: handsOff.length > 0 ? 'target-hands-off' : 'foreign-holes-only',
        message: `Nothing here is ANAS's to repair.${foreignClause}`,
      }
    }
    // Each blocked hole is named from its verdict's own sentence, grouped by
    // the reason it was refused for: a backing that is not on the node yet
    // (bring it back), a saved record the replay cannot be built from (C3 —
    // nothing the operator does to the storage will help), a read that could
    // not tell, a backstore that is still live (Repair must not create it a
    // second time), and a path that names another backstore's device.
    const unmarked = own.filter(b => b.verdict?.state !== 'restore-mark')
    const absent = unmarked.filter(b => b.verdict?.state === 'backing-absent' || b.verdict?.state === 'placeholder')
    const incomplete = unmarked.filter(b => b.verdict?.state === 'record-incomplete')
    const unreadable = unmarked.filter(b => b.verdict?.state === 'backing-unreadable')
    const live = unmarked.filter(b => b.verdict?.state === 'backstore-live')
    const served = unmarked.filter(b => b.verdict?.state === 'device-served-elsewhere')
    // A hole the health read judged nothing about cannot happen through the
    // Repair door (both its reads carry the job view), and it is never
    // repaired when it does: it leads as "could not be checked".
    const unjudged = unmarked.filter(b => b.verdict === undefined)
    if (unmarked.length === 0) {
      return {
        reason: 'restore-mark',
        message: `None of the missing LUNs can be repaired.${markedClause}${foreignClause}`,
      }
    }
    const offend = (items: IscsiRepairItem[]) => items.map(b => `LUN ${b.lunIndex} of ${b.targetIqn} — ${b.verdict!.detail}`).join('; ')
    const incompleteClause = (incomplete.length === 0
      ? ''
      : ` ${incomplete.length === 1 ? 'One hole' : `${incomplete.length} holes`} cannot be repaired from the saved `
        + `configuration at all: ${offend(incomplete)}.`)
      + (unreadable.length === 0
        ? ''
        : ` ${unreadable.length === 1 ? 'One hole' : `${unreadable.length} holes`} could not be checked: ${offend(unreadable)}.`)
      + (live.length === 0
        ? ''
        : ` ${live.length === 1 ? 'One hole is refused because its backstore is' : `${live.length} holes are refused because their backstores are`} still live: ${offend(live)}.`)
      + (served.length === 0
        ? ''
        : ` ${served.length === 1 ? 'One hole is' : `${served.length} holes are`} refused because the path names a `
          + `different device: ${offend(served)}.`)
    if (absent.length === 0 && incomplete.length === 0) {
      // The first group that holds leads the reason, in the order the clauses
      // print; a hole no read judged leads only when nothing else does.
      const reason = unreadable.length + unjudged.length > 0
        ? 'backing-unreadable'
        : live.length > 0
          ? 'backstore-live'
          : 'served-device-mismatch'
      return {
        reason,
        message: `None of the missing LUNs can be repaired.${incompleteClause}${markedClause}${foreignClause}`,
      }
    }
    if (absent.length === 0) {
      return {
        reason: 'record-incomplete',
        message: `None of the missing LUNs can be repaired — the saved configuration does not describe `
          + `${incomplete.length === 1 ? 'it' : 'them'} completely.${incompleteClause}${markedClause}${foreignClause}`,
      }
    }
    const named = absent
      .map(b => `LUN ${b.lunIndex} of ${b.targetIqn} (backstore '${b.backstoreName}', ${b.backingPath}${b.verdict?.state === 'placeholder' ? ' — a placeholder, not the image' : ''})`)
      .join('; ')
    const stubs = absent.filter(b => b.verdict?.state === 'placeholder').length
    return {
      reason: 'backing-absent',
      message: `None of the missing LUNs can be repaired yet — their backing objects are still not on `
        + `this node: ${named}. Bring the storage back first (import the pool, restore the image, mount `
        + `the filesystem) and run Repair again. Recreating a backstore over an absent device is what `
        + `produced the hole.${stubs > 0 ? stubClause(stubs) : ''}${incompleteClause}${markedClause}${foreignClause}`,
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
  /** cr3 (ISCSI-L7): the holes left alone because their target is not ANAS's. */
  foreignUntouched: IscsiRepairOutcome[]
  /** cr3 (ISCSI-L7): why the node is still degraded after this Repair, when it is. */
  stillDegraded?: string
}> {
  const { executor } = opts
  const repaired: IscsiRepairOutcome[] = []

  // Every item is checked before the first create, so a plan that holds one
  // bad item changes nothing. C3: a fileio create must never carry `size=0` —
  // targetcli CREATES a 0-byte file at the image's path and serves it with the
  // right serial, the placeholder story `iscsi.8` takes away. A `ready` verdict
  // already means the record carries a size (a sizeless one is
  // `record-incomplete`), so this asserts the state each item must carry rather
  // than re-checking the record: only a hand-built plan can reach it, and it
  // fails loudly.
  for (const item of plan.repairable) {
    if (item.verdict?.state !== 'ready' || (item.plugin === 'fileio' && item.size === null)) {
      throw new Error(
        `Cannot repair LUN ${item.lunIndex} of ${item.targetIqn}: its verdict is '${item.verdict?.state ?? 'none'}', `
        + `not a ready hole whose create line has everything it needs`,
      )
    }
  }

  for (const item of plan.repairable) {
    const store = backstorePath(item.plugin, item.backstoreName)

    opts.progress?.(`Recreating ${item.plugin} backstore ${item.backstoreName} from the saved configuration`)
    if (item.plugin === 'fileio') {
      const args = [
        '/backstores/fileio',
        'create',
        `name=${item.backstoreName}`,
        `file_or_dev=${item.backingPath}`,
        `size=${item.size}`,
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

    // The ONE grant helper (single-source rule): it reads the ACL's live mapped
    // set from configfs first, because targetcli's `auto_add_mapped_luns`
    // preference (GT-7) has already re-mapped the LUN we just recreated into
    // every ACL — a blind `create n n` here dies with `This MappedLUN already
    // exists in configFS` and fails the whole repair.
    for (const initiator of item.aclInitiators)
      await grantLunsToAcl(opts, item.targetIqn, item.tpgTag, initiator, [item.lunIndex])

    repaired.push(outcome(item))
  }

  const stillMissing = plan.blocked.map(outcome)

  // GT-22: the save is the last step, and only when the tree is whole again.
  // Saving with a hole left in it writes the hole into saveconfig.json forever.
  let saved = false
  // cr3: a Repair that repaired NOTHING saves nothing. A save is a node-wide
  // write of the live tree, and with nothing put back there is nothing to
  // persist — the job used to save on an empty plan (a hole that healed
  // between the request and the job, say), writing whatever the live tree
  // held at that moment for no reason of its own.
  if (repaired.length === 0) {
    opts.progress?.('Nothing was repaired — the saved configuration is left as it is')
  }
  else if (stillMissing.length === 0) {
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

  const foreign = plan.blocked.filter(b => b.verdict?.state === 'foreign-target')
  const foreignUntouched = foreign.map(outcome)
  // cr3 review 2: holes of an ANAS target ANAS will not write to, named.
  const handsOffItems = plan.blocked.filter(b => b.verdict?.state === 'target-hands-off')
  const handsOffClause = handsOffItems.length === 0
    ? ''
    : ` ${handsOffItems.map(b => `LUN ${b.lunIndex} of ${b.targetIqn}`).join(', ')} ${handsOffItems.length === 1 ? 'is' : 'are'} not repaired: `
      + `${[...new Set(handsOffItems.map(b => b.verdict!.detail))].join(' ')}`
  // review3 6: holes a restore mark held back are named, with their way out —
  // a mixed result used to count them as "still missing" and say no more.
  const markedClause = restoreMarkClause(plan.blocked.filter(b => b.verdict?.state === 'restore-mark'))
  const stillDegraded = stillMissing.length === 0
    ? undefined
    : foreign.length === stillMissing.length
      ? `This node stays degraded, and ANAS makes no iSCSI change: ${foreignHolesSentence(foreign)}`
      : `This node stays degraded: ${stillMissing.length} LUN${stillMissing.length === 1 ? ' is' : 's are'} still missing, `
        + `so nothing was saved.${foreign.length > 0 ? ` ${foreignHolesSentence(foreign)}` : ''}${handsOffClause}${markedClause}`
  return { repaired, stillMissing, saved, foreignUntouched, ...(stillDegraded ? { stillDegraded } : {}) }
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
