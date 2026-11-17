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

import type { IscsiHealth, IscsiRestoreMarkState, IscsiTargetDetail } from '@anas/shared'
import type { LioLiveState } from './iscsi-configfs.js'
import type { IscsiMutateOptions, IscsiRefusal } from './iscsi-mutate.js'
import type { IscsiBackstoreAttributes } from './iscsi-rules.js'
import type { StatDevice } from './iscsi-served.js'
import type { IscsiReadContext } from './iscsi.js'
import { foreignHolesSentence, holeReplayRecord, repairTokensRefusal, servedElsewhere } from './iscsi-hole.js'
import { grantLunsToAcl, runTargetcli, saveIscsiConfig } from './iscsi-mutate.js'
import {
  attributeTokens,
  backingPathRefusal,
  backstorePath,
  handsOffRefusal,
  tpgPath,
} from './iscsi-rules.js'
import { clearMarkCommand, isFileMark, unreadableMarkWay } from './restore-mark.js'

/** One hole, with everything the replay needs, read off the PERSISTED config. */
export interface IscsiRepairItem {
  targetIqn: string
  tpgTag: number
  lunIndex: number
  backstoreName: string
  /** `block` | `fileio`. */
  plugin: string
  backingPath: string
  /**
   * Is the backing device present RIGHT NOW? Only `true` is repairable.
   *
   * A PLACEHOLDER does not count as present (story `iscsi.8`). `backingExists`
   * on a stub LUN is already `false` — the read layer answers the question the
   * flag is actually asking ("is the LUN's data here?"), not the one a bare
   * `stat` answers — so this stays a single comparison and cannot drift from the
   * detector.
   */
  backingPresent: boolean
  /**
   * Was the absence a placeholder rather than a plain missing file? Only changes
   * what the refusal SAYS: "still not on this node" is wrong and confusing when
   * the operator can see a file sitting right there.
   */
  stubBacking: boolean
  /** The stored unit serial, replayed as `wwn=`. Null when the record has none. */
  serial: string | null
  /** fileio only: the persisted size, which `create` needs. */
  size: number | null
  /**
   * Why this hole is BLOCKED for a reason other than an absent backing (C3).
   *
   * Absence is the ordinary case and needs no sentence — `assertRepairable`
   * already tells that story. This carries the other kind: a persisted record
   * the replay cannot be built from, which must be named rather than papered
   * over with a default.
   */
  blockedReason?: string
  /**
   * The hole's path names a device LIO already serves through another
   * backstore (ident.2). Blocked, with `blockedReason` saying which.
   */
  deviceServed?: boolean
  /**
   * cr3 (ISCSI-L7): the hole is in a target ANAS does not manage. Never
   * repaired — ANAS does not write to a foreign target — and named, with the
   * hand restore, wherever Repair reports.
   */
  foreignTarget?: boolean
  /**
   * cr3 review 2: the hole is in an ANAS target ANAS will not write to — a
   * hand-added TPG, or an existing LUN whose backing's owner could not be
   * judged. `blockedReason` is that target's own refusal (`handsOffRefusal`):
   * one rule at the verbs' door and at Repair's.
   */
  handsOff?: boolean
  /**
   * cr3.lunrestore (review2 E): the hole's backing carries a restore mark — or
   * its mark could not be read, or a restore is writing it now. Blocked:
   * re-creating the LUN would map that image into its target again.
   * `blockedReason` is then a clause saying what the mark says (no stop), and
   * `restoreMarkDataset` where it is — the volume, or the image file's path
   * (null when it could not be read off the path).
   */
  restoreMark?: IscsiRestoreMarkState
  restoreMarkDataset?: string | null
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
 * Each hole's replay record comes from {@link holeReplayRecord}; the ladder
 * below marks the holes whose record cannot be replayed and says why.
 */
export function planIscsiRepair(
  ctx: IscsiReadContext,
  health: IscsiHealth,
  targets: IscsiTargetDetail[],
): IscsiRepairPlan {
  const targetByIqn = new Map(targets.map(t => [t.iqn, t]))
  const repairable: IscsiRepairItem[] = []
  const blocked: IscsiRepairItem[] = []

  const handsOffOf = (iqn: string) => {
    const t = targetByIqn.get(iqn)
    return t ? handsOffRefusal(t) : null
  }
  for (const missing of health.missingLuns) {
    const record = holeReplayRecord(ctx, missing, targets)
    const item: IscsiRepairItem = {
      ...record,
      // Only a checked, positive answer counts. `null` ("we could not tell")
      // is treated as absent: recreating over a device we cannot even stat is
      // how the hole was made.
      backingPresent: missing.backingExists === true,
      stubBacking: ctx.stubs.has(record.backingPath),
    }
    // C3: a fileio create line needs a size, and the persisted record is the
    // only place an honest one can come from. A record without one used to be
    // repaired with `size=0`, which does not fail — `targetcli` CREATES a
    // 0-byte file at the path and serves it: the very placeholder story
    // `iscsi.8` exists to take away, made this time by ANAS itself. So the hole
    // is BLOCKED and says what is missing.
    // cr3 (ISCSI-L7, operator ruling 2026-11-14): a hole in a FOREIGN target
    // is never repaired by ANAS — hands-off holds for Repair as for every
    // other write. It stays blocked (and the node degraded: a save would
    // erase its saved record), and the sentence says how to restore it by hand.
    if (missing.targetOwnership === 'foreign') {
      item.foreignTarget = true
      item.blockedReason = `target ${missing.targetIqn} is not managed by ANAS — ANAS never writes to it`
    }
    // cr3 (ISCSI-L10): a saved path targetcli would re-split cannot be put
    // back by ANAS; blocked with the reason, before anything is created.
    else if (handsOffOf(missing.targetIqn)) {
      item.handsOff = true
      item.blockedReason = handsOffOf(missing.targetIqn)!.message
    }
    // cr3 review 2 (L4/L5): every saved token that reaches a targetcli word
    // (the name, the serial, the attributes) and every saved ACL name the
    // re-grant addresses is checked here, before anything is created.
    else if (repairTokensRefusal(item)) {
      item.blockedReason = repairTokensRefusal(item)!
    }
    else if (backingPathRefusal(item.backingPath)) {
      item.blockedReason = `the saved backing path ${JSON.stringify(item.backingPath)} contains a space, a quote or an '=', which `
        + `targetcli cannot be handed — restore it by hand (bring the device back, then restart rtslib-fb-targetctl in a maintenance window)`
    }
    else if (item.plugin === 'fileio' && item.size === null) {
      item.blockedReason = `the saved configuration records no size for fileio backstore '${item.backstoreName}' `
        + `(${item.backingPath}) — recreating it without one would serve a 0-byte disk with the right serial`
    }
    ;(item.backingPresent && item.blockedReason === undefined ? repairable : blocked).push(item)
  }

  return { repairable, blocked }
}

/**
 * The served-device guard on a repair plan (story `ident.2`, audit #8).
 *
 * A hole has no live backstore, so there is no served device of its own to
 * compare with its path; what CAN be proven is that the path does not name a
 * device LIO is already serving through another backstore — a volume renamed
 * into the hole's old name while it is exported elsewhere. Recreating the hole
 * over it would serve one device under two serials (and iblock's exclusive
 * claim would fail the create half-way through the repair). Such a hole moves
 * to `blocked` with the reason; everything else passes through unchanged.
 */
export async function guardRepairPlan(
  plan: IscsiRepairPlan,
  live: LioLiveState,
  statFn: StatDevice,
): Promise<IscsiRepairPlan> {
  const repairable: IscsiRepairItem[] = []
  const blocked = [...plan.blocked]
  for (const item of plan.repairable) {
    const holder = item.plugin === 'block'
      ? servedElsewhere(live, await statFn(item.backingPath))
      : null
    if (holder) {
      blocked.push({
        ...item,
        deviceServed: true,
        blockedReason: `${item.backingPath} names device ${holder.device}, which LIO already serves as backstore `
          + `'${holder.name}' — the path no longer names the volume this LUN was created on, and recreating it would `
          + `serve one device under two serials`,
      })
      continue
    }
    repairable.push(item)
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
  const named = marked.map(b => `LUN ${b.lunIndex} of ${b.targetIqn} (backstore '${b.backstoreName}', ${b.backingPath}): ${b.blockedReason}`).join('; ')
  const ways: string[] = []
  const settled = marked.filter(b => b.restoreMark === 'interrupted' || b.restoreMark === 'unverified')
  if (settled.length > 0) {
    // cr3.lunrestore.filemark: the mark is on the volume, or on the image
    // file itself; review S3: or there is none, and a restore job's record
    // holds the hole back (no mark to clear).
    const marked = settled.filter(b => b.restoreMarkDataset)
    const recorded = settled.length - marked.length
    const clear = marked.map(b => `'${clearMarkCommand(b.restoreMarkDataset!)}'`)
    const onFiles = marked.filter(b => isFileMark(b.restoreMarkDataset!)).length
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
  if (marked.some(b => b.restoreMark === 'unreadable')) {
    // review S4: for an image file, the command that shows it.
    const see = marked.filter(b => b.restoreMark === 'unreadable' && b.restoreMarkDataset).map(b => unreadableMarkWay(b.restoreMarkDataset!, 'Repair')).join('')
    ways.push(`Repair is refused for a LUN whose restore mark could not be read until it can be read.${see}`)
  }
  if (marked.some(b => b.restoreMark === 'in-progress'))
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
    const foreign = plan.blocked.filter(b => b.foreignTarget)
    // cr3 review 2: holes of a target ANAS will not write to, named with that
    // target's own refusal.
    const handsOff = plan.blocked.filter(b => b.handsOff)
    const foreignClause = (foreign.length > 0 ? ` ${foreignHolesSentence(foreign)}` : '')
      + (handsOff.length > 0
        ? ` ${handsOff.map(b => `LUN ${b.lunIndex} of ${b.targetIqn}`).join(', ')} ${handsOff.length === 1 ? 'is' : 'are'} not repaired: `
        + `${[...new Set(handsOff.map(b => b.blockedReason))].join(' ')}`
        : '')
    const own = plan.blocked.filter(b => !b.foreignTarget && !b.handsOff)
    // cr3.lunrestore (review2 E): holes held back by a restore mark are their
    // own kind — a modelled state on the item, never a sentence match — with
    // their own sentence and ways out that exist for a HOLE (an in-place
    // restore needs a live LUN, so "restore again" is not one of them).
    const marked = own.filter(b => b.restoreMark !== undefined)
    const markedClause = restoreMarkClause(marked)
    if (own.length === 0) {
      return {
        reason: handsOff.length > 0 ? 'target-hands-off' : 'foreign-holes-only',
        message: `Nothing here is ANAS's to repair.${foreignClause}`,
      }
    }
    // Two kinds of blocked hole, and they need different sentences: a backing
    // that is not on the node yet (bring it back), and a persisted record the
    // replay cannot be built from (C3 — nothing the operator does to the
    // storage will help, so "import the pool" would be a wrong instruction).
    const unmarked = own.filter(b => b.restoreMark === undefined)
    const absent = unmarked.filter(b => b.blockedReason === undefined)
    const incomplete = unmarked.filter(b => b.blockedReason !== undefined && !b.deviceServed)
    const served = unmarked.filter(b => b.deviceServed)
    if (unmarked.length === 0) {
      return {
        reason: 'restore-mark',
        message: `None of the missing LUNs can be repaired.${markedClause}${foreignClause}`,
      }
    }
    const incompleteClause = (incomplete.length === 0
      ? ''
      : ` ${incomplete.length === 1 ? 'One hole' : `${incomplete.length} holes`} cannot be repaired from the saved `
        + `configuration at all: ${incomplete.map(b => `LUN ${b.lunIndex} of ${b.targetIqn} — ${b.blockedReason}`).join('; ')}.`)
      + (served.length === 0
        ? ''
        : ` ${served.length === 1 ? 'One hole is' : `${served.length} holes are`} refused because the path names a `
          + `different device: ${served.map(b => `LUN ${b.lunIndex} of ${b.targetIqn} — ${b.blockedReason}`).join('; ')}.`)
    if (absent.length === 0 && incomplete.length === 0) {
      return {
        reason: 'served-device-mismatch',
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
      .map(b => `LUN ${b.lunIndex} of ${b.targetIqn} (backstore '${b.backstoreName}', ${b.backingPath}${b.stubBacking ? ' — a placeholder, not the image' : ''})`)
      .join('; ')
    const stubs = absent.filter(b => b.stubBacking).length
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

  for (const item of plan.repairable) {
    const store = backstorePath(item.plugin, item.backstoreName)

    opts.progress?.(`Recreating ${item.plugin} backstore ${item.backstoreName} from the saved configuration`)
    if (item.plugin === 'fileio') {
      // C3: never `size=0`. `planIscsiRepair` blocks a size-less fileio record
      // before it can reach here, so this is the belt to that braces — a plan
      // built by hand must fail loudly rather than have targetcli create a
      // 0-byte file at the image's path and serve it with the right serial.
      if (item.size === null) {
        throw new Error(
          `Cannot repair LUN ${item.lunIndex} of ${item.targetIqn}: the saved configuration records no size `
          + `for fileio backstore '${item.backstoreName}' (${item.backingPath})`,
        )
      }
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

  const foreign = plan.blocked.filter(b => b.foreignTarget)
  const foreignUntouched = foreign.map(outcome)
  // cr3 review 2: holes of an ANAS target ANAS will not write to, named.
  const handsOffItems = plan.blocked.filter(b => b.handsOff)
  const handsOffClause = handsOffItems.length === 0
    ? ''
    : ` ${handsOffItems.map(b => `LUN ${b.lunIndex} of ${b.targetIqn}`).join(', ')} ${handsOffItems.length === 1 ? 'is' : 'are'} not repaired: `
      + `${[...new Set(handsOffItems.map(b => b.blockedReason))].join(' ')}`
  // review3 6: holes a restore mark held back are named, with their way out —
  // a mixed result used to count them as "still missing" and say no more.
  const markedClause = restoreMarkClause(plan.blocked.filter(b => !b.foreignTarget && !b.handsOff && b.restoreMark !== undefined))
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
