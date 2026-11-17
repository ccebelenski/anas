/**
 * The facts of an iSCSI hole — a LUN the saved configuration holds and the live
 * tree does not. Everything here is derived from the PERSISTED record and the
 * health diff: the record a repair replays, what a restore mark says about a
 * hole's backing, whether a device is already served elsewhere, and how a hole
 * is named in a sentence. Nothing here reads or writes the live tree.
 */
import type { IscsiHoleRepair, IscsiLunAttributes, IscsiMissingLun, IscsiRestoreMarkState, IscsiTargetDetail } from '@anas/shared'
import type { SaveconfigStorageObject } from '../parsers/lio-saveconfig.js'
import type { LioLiveState } from './iscsi-configfs.js'
import type { IscsiRepairItem } from './iscsi-repair.js'
import type { DeviceStat } from './iscsi-served.js'
import type { IscsiReadContext } from './iscsi.js'
import type { RestoreJobRecord, RestoreMarkRead } from './restore-mark.js'
import { storageObjectsByName } from '../parsers/lio-saveconfig.js'
import { lunsMappingBackstore, normalizePlugin } from './iscsi-configfs.js'
import { aclNamesRefusal, attributeTokens, backingPathRefusal, backstorePath, configshellSafe, handsOffRefusal, ISCSI_DEFAULT_WRITE_BACK, replayAttributes, tpgPath } from './iscsi-rules.js'
import { attributesFromPersisted, targetTpgs } from './iscsi.js'
import { describeRestoreMark, jobRecordOnly, restoreVerdict } from './restore-mark.js'

/**
 * Name a LUN in a refusal message — `LUN 0 of <iqn> (backstore 'x', /path)`.
 *
 * cr4 (D-11): a LUN whose backing path could not be read has NO path. Printing
 * `(backstore 'x', )` reads as an empty path; name only the backstore in that
 * case.
 */
export function namedLun(h: { lunIndex: number, targetIqn: string, backstoreName: string, backingPath: string }): string {
  const where = h.backingPath.length > 0 ? `, ${h.backingPath}` : ''
  return `LUN ${h.lunIndex} of ${h.targetIqn} (backstore '${h.backstoreName}'${where})`
}

/**
 * cr3 (ISCSI-L7, operator ruling 2026-11-14 "best practice prevails"): the one
 * sentence for restore holes in targets ANAS does NOT manage. They keep the
 * node degraded — a save is node-wide and would erase their saved LUNs — but
 * Repair never writes to a foreign target. The hand restore is the proven one
 * (GT-23: device back, then a restart of the restore service restores the
 * whole saved configuration with the serial intact); it drops every session
 * on the node, hence the maintenance window.
 */
export function foreignHolesSentence(holes: Pick<IscsiMissingLun, 'targetIqn' | 'lunIndex' | 'backstoreName' | 'backingPath'>[]): string {
  const named = holes.map(namedLun).join('; ')
  const one = holes.length === 1
  return `${named} ${one ? 'is' : 'are'} missing from ${one ? 'a target' : 'targets'} ANAS does not manage. ANAS never `
    + `writes to a target it does not own, so Repair leaves ${one ? 'it' : 'them'} alone. Restore ${one ? 'it' : 'them'} by hand: `
    + `bring the backing device back, then run 'systemctl restart rtslib-fb-targetctl' in a maintenance window — it `
    + `restores the whole saved configuration with the same serials, and drops every iSCSI session on this node while it `
    + `does. Until then this node stays degraded and ANAS makes no iSCSI change: any save would erase ${one ? 'that LUN' : 'those LUNs'} `
    + `from /etc/rtslib-fb-target/saveconfig.json. If ${one ? 'its device is' : 'a device is'} gone for good, the way out is your own `
    + `'targetcli saveconfig', which writes the live configuration over the saved one and so ERASES ${one ? 'that LUN\'s' : 'those LUNs\''} `
    + `record — a deliberate act, and not one ANAS takes.`
}

/** The hole's own TPG of a built target (cr3, ISCSI-H2: never the first by default). */
export function tpgOf(target: IscsiTargetDetail | undefined, tag: number) {
  return target ? targetTpgs(target).find(t => t.tpgTag === tag) : undefined
}

/**
 * Why a hole's SAVED record cannot be replayed through targetcli (cr3 review
 * 2): a backstore name, a serial or an attribute token configshell would
 * re-split or read as a keyword, or an ACL name ANAS cannot address. Null when
 * every one of them can be run.
 */
export function repairTokensRefusal(item: Pick<IscsiRepairItem, 'targetIqn' | 'backstoreName' | 'serial' | 'attributes' | 'aclInitiators'>): string | null {
  const tokens = [
    `name=${item.backstoreName}`,
    item.backstoreName,
    ...(item.serial ? [`wwn=${item.serial}`] : []),
    ...attributeTokens(item.attributes),
  ]
  const bad = tokens.find(t => !configshellSafe(t))
  if (bad !== undefined) {
    return `the saved record's ${JSON.stringify(bad)} cannot be handed to targetcli (a space, a quote or an '=' it would `
      + `read as something else) — restore it by hand (bring the device back, then restart rtslib-fb-targetctl in a maintenance window)`
  }
  const acl = aclNamesRefusal(item.targetIqn, item.aclInitiators.map(initiatorIqn => ({ initiatorIqn })))
  return acl ? acl.message : null
}

/** The initiators whose PERSISTED ACL maps this LUN index. */
export function persistedAclsMapping(ctx: IscsiReadContext, missing: IscsiMissingLun): string[] {
  const target = (ctx.persisted?.targets ?? []).find(t => t.iqn === missing.targetIqn)
  const tpg = target?.tpgs.find(p => p.tag === missing.tpgTag)
  const acls = (tpg?.acls ?? []).filter(a => a.mappedLuns.includes(missing.lunIndex))
  return acls.map(a => a.initiatorIqn)
}

/**
 * Which live block backstore, if any, already serves the device `st` names.
 * The repair half of the rule: a hole is recreated only over a device no other
 * backstore serves.
 */
export function servedElsewhere(
  live: LioLiveState,
  st: DeviceStat | null,
): { name: string, device: string } | null {
  if (!st || st.type !== 'block')
    return null
  const device = `${st.rdevMajor}:${st.rdevMinor}`
  for (const b of live.backstores) {
    if (normalizePlugin(b.plugin) === 'block' && b.devMajor !== null && b.devMinor !== null
      && `${b.devMajor}:${b.devMinor}` === device) {
      return { name: b.name, device }
    }
  }
  return null
}

/**
 * The replay record of one hole, derived entirely from the PERSISTED config.
 *
 * The persisted record is the only honest source: the live tree does not have
 * these objects (that is what makes them a hole), and the built
 * `IscsiTargetDetail` for a missing LUN is itself derived from the same
 * persisted record. Reading `saveconfig.json` directly keeps the size, the
 * `write_back` flag and the raw attribute map — all three of which a create line
 * needs — in one place.
 */
export function holeReplayRecord(
  ctx: IscsiReadContext,
  missing: IscsiMissingLun,
  targets: IscsiTargetDetail[],
): Omit<IscsiRepairItem, 'backingPresent' | 'stubBacking'> {
  const persistedStorage = ctx.persisted ? storageObjectsByName(ctx.persisted) : new Map<string, SaveconfigStorageObject>()
  const targetByIqn = new Map(targets.map(t => [t.iqn, t]))

  const store = persistedStorage.get(missing.backstoreName)
  const plugin = normalizePlugin(store?.plugin ?? missing.plugin)
  const backingPath = store?.dev || missing.backingPath
  const attributes: IscsiLunAttributes = store
    ? attributesFromPersisted(store)
    : tpgOf(targetByIqn.get(missing.targetIqn), missing.tpgTag)?.luns.find(l => l.index === missing.lunIndex)?.attributes ?? {}

  return {
    targetIqn: missing.targetIqn,
    tpgTag: missing.tpgTag,
    lunIndex: missing.lunIndex,
    backstoreName: missing.backstoreName,
    plugin,
    backingPath,
    serial: store?.wwn ?? null,
    size: store?.size ?? null,
    writeBack: store?.writeBack ?? ISCSI_DEFAULT_WRITE_BACK,
    attributes: replayAttributes({ attributes }, plugin),
    aclInitiators: persistedAclsMapping(ctx, missing),
  }
}

/**
 * What a restore mark says about a hole's backing, as a clause for the Repair
 * refusal (cr3.lunrestore, review2 E): no leading capital, no stop.
 */
export function repairMarkClause(read: RestoreMarkRead, state: IscsiRestoreMarkState, running: string | undefined, record?: RestoreJobRecord): string {
  if (read.state === 'unknown')
    return `ANAS could not read the restore mark on ${read.dataset} (${read.reason}), so it cannot tell whether it holds a partially restored image`
  if (state === 'in-progress')
    return `a whole-image restore is writing it right now (job ${running})`
  if (read.state !== 'present') {
    // review S3: an image file with no mark whose failed restore record stands.
    if (record) {
      const how = record.outcome === 'unverified'
        ? 'wrote it, and the client reported the image complete, but ANAS could not verify it'
        : 'did not finish, so it may hold a partial image'
      return `the whole-image restore job ${record.job} onto it ${how}. ${jobRecordOnly(read)}`
    }
    return 'it carries a restore mark'
  }
  const what = `${describeRestoreMark(read)}${record ? ` (job ${record.job})` : ''}`
  return state === 'unverified'
    ? `${what} wrote ${read.dataset}, and the client reported the image complete, but its size was not verified${read.mark?.reason ? ` (${read.mark.reason})` : ''}`
    : `${what} onto ${read.dataset} did not finish, so it holds a partial image`
}

// ---------------------------------------------------------------------------
// The verdict: what Repair can do with a hole, and if nothing, why
// ---------------------------------------------------------------------------

// The sentences a hole shares with its health card (services/iscsi-warnings.ts),
// quoted verbatim so the two doors say the same thing about the same hole.
const READY_DETAIL = 'That path is available again — use Repair on the iSCSI screen to put the LUN back.'
const ABSENT_DETAIL = 'That path is still missing — bring the storage back (import the pool, restore the image) first.'
const PLACEHOLDER_DETAIL = 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is '
  + 'not the image, which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use '
  + 'Repair on the iSCSI screen to put the LUN back with its own serial.'

/** The address a hole has inside its target: the TPG path plus its LUN index. */
export function holeKey(h: Pick<IscsiMissingLun, 'targetIqn' | 'tpgTag' | 'lunIndex'>): string {
  return `${tpgPath(h.targetIqn, h.tpgTag)}/lun${h.lunIndex}`
}

/**
 * The I/O facts one hole's verdict needs, gathered by the caller (the health
 * read) — per HOLE, not per path: the job record depends on the hole's target.
 */
export interface HoleIoFacts {
  /** block holes only: one stat of the backing (statDeviceFrom(paths)); null = the stat failed. Absent for fileio. */
  device?: DeviceStat | null
  /** readRestoreMarksBatch's read of the backing; `unknown` is a failed read. */
  mark: RestoreMarkRead
  /** restoreJobs.restoreRunning(path) */
  running: string | undefined
  /** restoreJobs.restoreFailed(path, hole.targetIqn), asked only where consultsJobRecord(mark) (as the Repair route does) */
  record: RestoreJobRecord | undefined
}

/**
 * What Repair can do with one hole — THE one decision, from facts
 * already gathered: the persisted record, the live tree, and (when the caller
 * has a job view) the backing's I/O facts. The first rung that holds wins.
 *
 * A fact that could not be read is UNKNOWN, never "absent", "not served" or
 * "no mark". `io === null` means the caller gathered no I/O facts: the pure
 * rungs are still decided, and a hole that would need I/O facts to be called
 * `ready` is not judged at all (null), never ready.
 */
export function holeRepairVerdict(
  ctx: IscsiReadContext,
  target: IscsiTargetDetail,
  hole: IscsiMissingLun,
  io: HoleIoFacts | null,
): IscsiHoleRepair | null {
  const rec = holeReplayRecord(ctx, hole, [target])
  const path = rec.backingPath

  if (hole.targetOwnership === 'foreign')
    return { state: 'foreign-target', detail: foreignHolesSentence([hole]) }

  const handsOff = handsOffRefusal(target)
  if (handsOff)
    return { state: 'target-hands-off', detail: handsOff.message }

  const unsafeToken = repairTokensRefusal(rec)
  if (unsafeToken)
    return { state: 'record-incomplete', detail: unsafeToken }
  if (backingPathRefusal(path)) {
    return {
      state: 'record-incomplete',
      detail: `the saved backing path ${JSON.stringify(path)} contains a space, a quote or an '=', which targetcli `
        + `cannot be handed — restore it by hand (bring the device back, then restart rtslib-fb-targetctl in a maintenance window)`,
    }
  }
  if (rec.plugin === 'fileio' && rec.size === null) {
    return {
      state: 'record-incomplete',
      detail: `the saved configuration records no size for fileio backstore '${rec.backstoreName}' (${path}) — `
        + `recreating it without one would serve a 0-byte disk with the right serial`,
    }
  }

  // A placeholder is a ZERO-BYTE file: a full-size image on an unexpected mount
  // holds data and is not one (the quarantine acts on the same signal).
  if (ctx.stubs.get(hole.backingPath)?.zeroSized === true)
    return { state: 'placeholder', detail: PLACEHOLDER_DETAIL }

  if (hole.backingExists === false)
    return { state: 'backing-absent', detail: ABSENT_DETAIL }

  if (hole.backingExists === null) {
    return {
      state: 'backing-unreadable',
      detail: `ANAS could not tell whether ${path} is on this node (its stat failed with an error other than `
        + `"not found"), and Repair never recreates a backstore over a device it cannot see`,
    }
  }

  // A live backstore of this name and plugin: Repair's create would collide with
  // it. Sits after the placeholder and absence rungs so nobody is told to map
  // a placeholder or a dead path by hand.
  const live = ctx.live.backstores.find(b => b.name === rec.backstoreName && normalizePlugin(b.plugin) === rec.plugin)
  if (live) {
    const mapped = lunsMappingBackstore(ctx.live, rec.plugin, rec.backstoreName)
    const detail = `backstore '${rec.backstoreName}' (${rec.plugin}, ${live.udevPath}) is still live`
      + `${mapped.length > 0 ? ` and serves ${mapped.map(m => `LUN ${m.lunIndex} of ${m.targetIqn}`).join(', ')}` : ' and no LUN maps it'}, `
      + `so Repair does not create it a second time — check that it is this LUN's disk (live serial ${live.serial ?? 'unreadable'}, `
      + `saved serial ${rec.serial ?? 'not recorded'}), then map it back by hand: 'targetcli `
      + `${tpgPath(rec.targetIqn, rec.tpgTag)}/luns create storage_object=${backstorePath(rec.plugin, rec.backstoreName)} `
      + `lun=${rec.lunIndex}'`
    // A backing held by a restore mark keeps that fact where it was said before,
    // rather than losing it to the backstore sentence.
    const verdict = io ? restoreVerdict(io.mark, io.running, io.record) : null
    return {
      state: 'backstore-live',
      detail: verdict && io
        ? `${detail}; its backing is held by a restore mark: ${repairMarkClause(io.mark, verdict.state, io.running, io.record)}`
        : detail,
    }
  }

  if (io === null)
    return null

  if (rec.plugin === 'block' && io.device == null) {
    return {
      state: 'backing-unreadable',
      detail: `ANAS could not stat ${path}, so it cannot tell which device the path names, and Repair never `
        + `recreates a backstore over a device it cannot identify`,
    }
  }

  const holder = servedElsewhere(ctx.live, io.device ?? null)
  if (holder) {
    return {
      state: 'device-served-elsewhere',
      detail: `${path} names device ${holder.device}, which LIO already serves as backstore '${holder.name}' — the `
        + `path no longer names the volume this LUN was created on, and recreating it would serve one device under two serials`,
    }
  }

  const verdict = restoreVerdict(io.mark, io.running, io.record)
  if (verdict) {
    return {
      state: 'restore-mark',
      detail: repairMarkClause(io.mark, verdict.state, io.running, io.record),
      restoreMark: verdict.state,
      markOn: io.mark.state === 'present' || io.mark.state === 'unknown' ? io.mark.dataset : null,
    }
  }

  return { state: 'ready', detail: READY_DETAIL }
}
