/**
 * The facts of an iSCSI hole — a LUN the saved configuration holds and the live
 * tree does not. Everything here is derived from the PERSISTED record and the
 * health diff: the record a repair replays, what a restore mark says about a
 * hole's backing, whether a device is already served elsewhere, and how a hole
 * is named in a sentence. Nothing here reads or writes the live tree.
 */
import type { IscsiHoleRepair, IscsiHoleRepairState, IscsiLunAttributes, IscsiMissingLun, IscsiRestoreMarkState, IscsiTargetDetail } from '@anas/shared'
import type { SaveconfigStorageObject } from '../parsers/lio-saveconfig.js'
import type { ConfigfsBackstore, LioLiveState } from './iscsi-configfs.js'
import type { HoleReplayRecord } from './iscsi-repair.js'
import type { DeviceStat } from './iscsi-served.js'
import type { IscsiReadContext } from './iscsi.js'
import type { RestoreJobRecord, RestoreMarkRead } from './restore-mark.js'
import { storageObjectsByName } from '../parsers/lio-saveconfig.js'
import { lunsMappingBackstore, normalizePlugin } from './iscsi-configfs.js'
import { aclNamesRefusal, attributeTokens, backingPathRefusal, backstorePath, configshellSafe, handsOffRefusal, ISCSI_DEFAULT_WRITE_BACK, liveBackstoreOf, replayAttributes, servedDevice, tpgPath } from './iscsi-rules.js'
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
function repairTokensRefusal(item: Pick<HoleReplayRecord, 'targetIqn' | 'backstoreName' | 'serial' | 'attributes' | 'aclInitiators'>): string | null {
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
function servedElsewhere(
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
): HoleReplayRecord {
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
function repairMarkClause(read: RestoreMarkRead, state: IscsiRestoreMarkState, running: string | undefined, record?: RestoreJobRecord): string {
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
  /** One stat of the backing, for every hole whose backing is present (statDeviceFrom(paths)); null = the stat failed or the caller gathered none. */
  device?: DeviceStat | null
  /** readRestoreMarksBatch's read of the backing; `unknown` is a failed read. */
  mark: RestoreMarkRead
  /** restoreJobs.restoreRunning(path) */
  running: string | undefined
  /** restoreJobs.restoreFailed(path, hole.targetIqn), asked only where consultsJobRecord(mark) (as the Repair route does) */
  record: RestoreJobRecord | undefined
}

/**
 * The restore-mark verdict rung 11 and a matched live backstore (7f) share: the
 * mark, the running restore or the standing record, as one verdict, or null
 * when none holds. `savedBackstoreLive` travels with it from 7f — the mark is
 * on the matched backstore's own backing.
 */
function restoreMarkVerdict(io: HoleIoFacts, savedBackstoreLive?: true): IscsiHoleRepair | null {
  const verdict = restoreVerdict(io.mark, io.running, io.record)
  if (!verdict)
    return null
  const detail = repairMarkClause(io.mark, verdict.state, io.running, io.record)
  return {
    state: 'restore-mark',
    detail,
    advice: repairAdvice('restore-mark', detail),
    restoreMark: verdict.state,
    markOn: io.mark.state === 'present' || io.mark.state === 'unknown' ? io.mark.dataset : null,
    ...(savedBackstoreLive ? { savedBackstoreLive } : {}),
  }
}

/**
 * A `backstore-live` verdict: the live backstore, why Repair does not map it
 * back, and the by-hand map. A restore mark on the backing is still said (the
 * one case where the operator has a way out that is not by hand).
 */
function backstoreLiveVerdict(
  rec: HoleReplayRecord,
  live: ConfigfsBackstore,
  mapped: { targetIqn: string, tpgTag: number, lunIndex: number }[],
  why: string,
  io: HoleIoFacts | null,
): IscsiHoleRepair {
  const detail = `backstore '${rec.backstoreName}' (${rec.plugin}, ${live.udevPath}) is still live`
    + `${mapped.length > 0 ? ` and serves ${mapped.map(m => `LUN ${m.lunIndex} of ${m.targetIqn}`).join(', ')}` : ' and no LUN maps it'}, `
    + `so Repair does not create it a second time, and it does not map it back because ${why} — check that it is this LUN's disk `
    + `(live serial ${live.serial ?? 'unreadable'}, saved serial ${rec.serial ?? 'not recorded'}), then map it back by hand: 'targetcli `
    + `${tpgPath(rec.targetIqn, rec.tpgTag)}/luns create storage_object=${backstorePath(rec.plugin, rec.backstoreName)} `
    + `lun=${rec.lunIndex}'`
  // A backing held by a restore mark keeps that fact where it was said before,
  // rather than losing it to the backstore sentence.
  const verdict = io ? restoreVerdict(io.mark, io.running, io.record) : null
  const full = verdict && io
    ? `${detail}; its backing is held by a restore mark: ${repairMarkClause(io.mark, verdict.state, io.running, io.record)}`
    : detail
  return { state: 'backstore-live', detail: full, advice: repairAdvice('backstore-live', full) }
}

/** The `ready` detail for a hole whose still-live backstore ANAS showed is the saved one. */
function savedBackstoreLiveDetail(rec: HoleReplayRecord): string {
  return `Backstore '${rec.backstoreName}' (${rec.plugin}, ${rec.backingPath}) is still live and is the saved one `
    + `(serial ${rec.serial}). Use Repair on the iSCSI screen to map it back as the LUN.`
}

/**
 * The verdict as one whole sentence for whoever prints it — the warnings card
 * and the iSCSI screen both do, and neither frames a state itself. The detail's
 * form is fixed per state (a clause for the five refusals that state a reason, a
 * full sentence otherwise), so only the opening frame differs.
 */
export function repairAdvice(state: IscsiHoleRepairState, detail: string): string {
  if (state === 'target-hands-off')
    return `Repair does not write to this target: ${detail}`
  if (state === 'record-incomplete' || state === 'backing-unreadable' || state === 'backstore-live'
    || state === 'device-served-elsewhere' || state === 'restore-mark') {
    return `Repair cannot put it back: ${detail}${detail.endsWith('.') ? '' : '.'}`
  }
  return detail
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

  if (hole.targetOwnership === 'foreign') {
    const detail = foreignHolesSentence([hole])
    return { state: 'foreign-target', detail, advice: repairAdvice('foreign-target', detail) }
  }

  const handsOff = handsOffRefusal(target)
  if (handsOff)
    return { state: 'target-hands-off', detail: handsOff.message, advice: repairAdvice('target-hands-off', handsOff.message) }

  const unsafeToken = repairTokensRefusal(rec)
  if (unsafeToken)
    return { state: 'record-incomplete', detail: unsafeToken, advice: repairAdvice('record-incomplete', unsafeToken) }
  if (backingPathRefusal(path)) {
    const detail = `the saved backing path ${JSON.stringify(path)} contains a space, a quote or an '=', which targetcli `
      + `cannot be handed — restore it by hand (bring the device back, then restart rtslib-fb-targetctl in a maintenance window)`
    return { state: 'record-incomplete', detail, advice: repairAdvice('record-incomplete', detail) }
  }
  if (rec.plugin === 'fileio' && rec.size === null) {
    const detail = `the saved configuration records no size for fileio backstore '${rec.backstoreName}' (${path}) — `
      + `recreating it without one would serve a 0-byte disk with the right serial`
    return { state: 'record-incomplete', detail, advice: repairAdvice('record-incomplete', detail) }
  }

  // A placeholder is a ZERO-BYTE file: a full-size image on an unexpected mount
  // holds data and is not one (the quarantine acts on the same signal).
  if (ctx.stubs.get(hole.backingPath)?.zeroSized === true)
    return { state: 'placeholder', detail: PLACEHOLDER_DETAIL, advice: repairAdvice('placeholder', PLACEHOLDER_DETAIL) }

  if (hole.backingExists === false)
    return { state: 'backing-absent', detail: ABSENT_DETAIL, advice: repairAdvice('backing-absent', ABSENT_DETAIL) }

  if (hole.backingExists === null) {
    const detail = `ANAS could not tell whether ${path} is on this node (its stat failed with an error other than `
      + `"not found"), and Repair never recreates a backstore over a device it cannot see`
    return { state: 'backing-unreadable', detail, advice: repairAdvice('backing-unreadable', detail) }
  }

  // A live backstore of this name and plugin: Repair's create would collide with
  // it, and if ANAS can show it is the SAVED one (same path, same serial, and
  // the path names the object LIO holds) then the LUN is mapped back onto it
  // instead. Sits after the placeholder and absence rungs so nobody is told to
  // map a placeholder or a dead path by hand.
  const live = liveBackstoreOf(ctx.live, { name: rec.backstoreName, plugin: rec.plugin })
  if (live) {
    const mapped = lunsMappingBackstore(ctx.live, rec.plugin, rec.backstoreName)
    // 7a-7c: the facts that say this live backstore is NOT provably the saved
    // one. A fact that could not be read (a null serial, an empty udev_path) is
    // never "the same".
    const why = mapped.length > 0
      ? 'a live LUN already maps it'
      : live.udevPath !== rec.backingPath
        ? `it holds ${live.udevPath || 'a path ANAS could not read'}, and the saved record names ${rec.backingPath}`
        : live.serial === null || rec.serial === null || live.serial !== rec.serial
          ? 'ANAS cannot show its serial is the saved one'
          : null
    // 7d: no I/O facts were gathered (the save gate, the boot scan) — a match is
    // NOT judged ready for a caller that cannot see the device and the mark.
    if (why === null && io === null)
      return null
    // 7e: the path must name the object the live backstore holds. For a block
    // backstore that is `info`'s Major/Minor against the stat; a null stat, a
    // null Major/Minor or another device all refuse (unknown is never "same").
    // LIO's exclusive claim means no second backstore can hold the device, so
    // this replaces the served-elsewhere and unreadable-device rungs here.
    if (why === null && io) {
      const proof = servedDevice(
        { index: rec.lunIndex, name: rec.backstoreName, plugin: rec.plugin, backingPath: rec.backingPath },
        live,
        io.device ?? null,
      )
      if (proof.refusal !== null) {
        const kind = rec.plugin === 'block' ? 'device' : 'file'
        return backstoreLiveVerdict(rec, live, mapped, `ANAS could not show that ${rec.backingPath} names the ${kind} it holds`, io)
      }
    }
    if (why !== null)
      return backstoreLiveVerdict(rec, live, mapped, why, io)
    // 7f: the matched backstore's backing still carries a restore mark.
    if (io) {
      const marked = restoreMarkVerdict(io, true)
      if (marked)
        return marked
    }
    // 7g: the live backstore IS the saved one — map it, create nothing.
    const detail = savedBackstoreLiveDetail(rec)
    return { state: 'ready', savedBackstoreLive: true, detail, advice: repairAdvice('ready', detail) }
  }

  if (io === null)
    return null

  if (rec.plugin === 'block' && io.device == null) {
    const detail = `ANAS could not stat ${path}, so it cannot tell which device the path names, and Repair never `
      + `recreates a backstore over a device it cannot identify`
    return { state: 'backing-unreadable', detail, advice: repairAdvice('backing-unreadable', detail) }
  }

  const holder = servedElsewhere(ctx.live, io.device ?? null)
  if (holder) {
    const detail = `${path} names device ${holder.device}, which LIO already serves as backstore '${holder.name}' — the `
      + `path no longer names the volume this LUN was created on, and recreating it would serve one device under two serials`
    return { state: 'device-served-elsewhere', detail, advice: repairAdvice('device-served-elsewhere', detail) }
  }

  const marked = restoreMarkVerdict(io)
  if (marked)
    return marked

  return { state: 'ready', detail: READY_DETAIL, advice: repairAdvice('ready', READY_DETAIL) }
}
