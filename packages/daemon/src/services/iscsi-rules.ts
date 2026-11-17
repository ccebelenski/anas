/**
 * The rules the iSCSI write doors and the read side share: what a token may
 * look like on a targetcli line, the attribute set a backstore is created and
 * replayed with, the configshell path of a TPG and of a backstore, and the
 * refusals asked before the first act. Constants and pure functions — nothing
 * here reads or writes the node.
 */
import type { IscsiLun, IscsiTargetDetail } from '@anas/shared'
import type { ConfigfsBackstore, LioLiveState } from './iscsi-configfs.js'
import type { IscsiRefusal } from './iscsi-mutate.js'
import type { DeviceStat } from './iscsi-served.js'
import { IscsiIqn } from '@anas/shared'
import { normalizePlugin } from './iscsi-configfs.js'
import { targetTpgs } from './iscsi.js'

/**
 * The attribute set ANAS puts on EVERY backstore it creates, and replays on
 * every recreate. Not defaults — deliberate departures from them:
 *
 *  - `emulate_tpu` / `emulate_tpws` ship OFF on both kinds (GT-26), so a
 *    `blkdiscard` from the initiator fails `Operation not supported` and a
 *    sparse zvol or image never gets its blocks back.
 *  - `emulate_write_cache` (targetcli's `write_back`) ships **ON for fileio**
 *    (GT-26) — an unflushed write is lost on a crash. ANAS ships it OFF and
 *    only an explicit, warned choice turns it back on.
 *  - `max_unmap_lba_count` is the fileio trap: the default 8192 (4 MiB) makes a
 *    whole-device discard fail outright with `Invalid field in parameter list`
 *    (GT-30). Raised to the value the ground-truth run proved end to end
 *    (GT-47). The block default is already higher and is set explicitly rather
 *    than left implicit, so the replayed set is the same shape for both kinds.
 *
 * Honest caveat the UI carries (GT-30): whether a given initiator actually
 * reclaims depends on which SCSI command it chooses, and Linux's default choice
 * (WRITE SAME 16) is REJECTED by LIO fileio. This is the correct target-side
 * configuration; it is not a promise of thin behaviour.
 */
export const ISCSI_MAX_UNMAP_LBA_COUNT: Record<string, number> = {
  block: 524288,
  fileio: 262144,
}

/** The default write-cache posture ANAS creates every LUN with. */
export const ISCSI_DEFAULT_WRITE_BACK = false

/**
 * The attributes ANAS sets on a backstore, in the order it sets them.
 *
 * `block_size` comes FIRST and the whole set is applied BEFORE the backstore is
 * mapped, because `set attribute block_size=` on an activated backstore fails
 * with `[Errno 22] Invalid argument` (GT-27) — it is a create-time choice and
 * read-only thereafter.
 */
export interface IscsiBackstoreAttributes {
  /** Present only when the caller chose one; omitted keeps LIO's 512. */
  blockSize?: number
  emulateTpu: boolean
  emulateTpws: boolean
  maxUnmapLbaCount: number
  writeBack: boolean
}

/** `set attribute` argument tokens for one attribute set, in application order. */
export function attributeTokens(attrs: IscsiBackstoreAttributes): string[] {
  const out: string[] = []
  // block_size FIRST: it is the one that stops working once the LUN is mapped.
  if (attrs.blockSize !== undefined)
    out.push(`block_size=${attrs.blockSize}`)
  out.push(`emulate_tpu=${attrs.emulateTpu ? 1 : 0}`)
  out.push(`emulate_tpws=${attrs.emulateTpws ? 1 : 0}`)
  out.push(`max_unmap_lba_count=${attrs.maxUnmapLbaCount}`)
  out.push(`emulate_write_cache=${attrs.writeBack ? 1 : 0}`)
  return out
}

/**
 * Characters that change how configshell splits the line targetcli rebuilds
 * from its argv: whitespace separates tokens, and a quote opens a quoted one.
 */
const CONFIGSHELL_UNSAFE_RE = /[\s"']/

/**
 * The keyword parameters ANAS puts on a targetcli line (create lines, `set
 * attribute`). Any other token is POSITIONAL, and configshell reads a
 * positional token containing `=` as a keyword argument (cr3 review 2, L5: a
 * hand-made backstore named `gt=vol1`) — refused, fail closed.
 */
const CONFIGSHELL_KEYWORDS = new Set([
  'name',
  'dev',
  'file_or_dev',
  'size',
  'write_back',
  'wwn',
  'storage_object',
  'lun',
  'block_size',
  'emulate_tpu',
  'emulate_tpws',
  'max_unmap_lba_count',
  'emulate_write_cache',
  'authentication',
  'generate_node_acls',
  'demo_mode_discovery',
  'cache_dynamic_acls',
])

/**
 * Would `token` reach configshell as itself? Whitespace, a quote, a second
 * `=`, or an `=` in a token that is not one of ANAS's keyword parameters would
 * not.
 */
export function configshellSafe(token: string): boolean {
  if (CONFIGSHELL_UNSAFE_RE.test(token))
    return false
  const eq = token.indexOf('=')
  if (eq === -1)
    return true
  return token.split('=').length === 2 && CONFIGSHELL_KEYWORDS.has(token.slice(0, eq))
}

/**
 * cr3 review 2 (L1): every ACL the sequence will touch must be an iSCSI name
 * BEFORE the first act — `aclDirPath` refuses anything else, and it used to
 * be reached only after the LUN was unmapped, deleted, recreated and mapped.
 */
export function aclNamesRefusal(targetIqn: string, acls: { initiatorIqn: string }[]): IscsiRefusal | null {
  const bad = acls.find(a => !IscsiIqn.safeParse(a.initiatorIqn).success || !configshellSafe(a.initiatorIqn))
  if (!bad)
    return null
  return {
    reason: 'acl-name-unsafe',
    message: `The initiator ACL ${JSON.stringify(bad.initiatorIqn)} of target '${targetIqn}' is not an iSCSI name ANAS can `
      + `address (configfs path, targetcli line), so this change cannot re-grant the LUN to it. Nothing was changed. `
      + `Remove or recreate that ACL with targetcli, then retry.`,
  }
}

/**
 * The refusal for a backing PATH targetcli cannot be handed (cr3, ISCSI-L10
 * follow-up) — asked BEFORE the first act of any sequence that would put the
 * path on a `create` line, so a refusal never leaves a LUN half done.
 */
export function backingPathRefusal(path: string): IscsiRefusal | null {
  if (configshellSafe(`dev=${path}`))
    return null
  return {
    reason: 'backing-path-unsafe',
    message: `The backing path ${JSON.stringify(path)} contains a space, a quote or an '=', and targetcli re-joins its `
      + `arguments with spaces and parses the line again, so it would read the path as something else. ANAS cannot create `
      + `a backstore on it; nothing was changed. Use a path without those characters (rename the dataset or move the mountpoint).`,
  }
}

/** The sentence every mismatch starts with — one phrasing, every door. */
export const SERVED_DEVICE_MISMATCH = 'LUN serves a different device than its path names'

/** The live backstore a LUN maps, by name AND plugin (names are per plugin). */
export function liveBackstoreOf(
  live: LioLiveState,
  lun: Pick<IscsiLun, 'name' | 'plugin'>,
): ConfigfsBackstore | undefined {
  return live.backstores.find(b => b.name === lun.name && normalizePlugin(b.plugin) === normalizePlugin(lun.plugin))
}

/** The verdict of one served-device comparison. */
export interface ServedDeviceVerdict {
  /**
   * `block:<major>:<minor>` or `file:<dev>:<ino>` when the comparison held;
   * null when it did not (the refusal says why).
   */
  device: string | null
  refusal: IscsiRefusal | null
}

/**
 * THE comparison: is the object at the LUN's path the one LIO is serving?
 *
 * Pure over its inputs (the live backstore and one `stat` of the path) so it is
 * the same answer at the request and inside the job. A caller that is about to
 * act on the backing object refuses on a non-null `refusal`; a caller that only
 * unmaps (a LUN delete that keeps the backing) may proceed and still binds the
 * device when there is one.
 */
export function servedDevice(
  lun: Pick<IscsiLun, 'index' | 'name' | 'plugin' | 'backingPath'>,
  backstore: ConfigfsBackstore | undefined,
  st: DeviceStat | null,
): ServedDeviceVerdict {
  const path = lun.backingPath
  const plugin = normalizePlugin(lun.plugin)
  if (!backstore) {
    return {
      device: null,
      refusal: {
        reason: 'served-device-unknown',
        message: `LUN ${lun.index} ('${lun.name}') is not live in the kernel, so there is no served device to compare `
          + `with ${path || '(no path)'} — ANAS will not act on the backing object of a LUN whose device it cannot see.`,
      },
    }
  }
  if (plugin === 'block') {
    if (backstore.devMajor === null || backstore.devMinor === null) {
      return {
        device: null,
        refusal: {
          reason: 'served-device-unknown',
          message: `The kernel does not report which device LUN ${lun.index} ('${lun.name}') opened (no Major/Minor in `
            + `its configfs info), so ANAS cannot prove ${path} is the device it serves and will not act on it.`,
        },
      }
    }
    const served = `${backstore.devMajor}:${backstore.devMinor}`
    if (!st || st.type !== 'block') {
      return {
        device: null,
        refusal: {
          reason: 'served-device-mismatch',
          message: `${SERVED_DEVICE_MISMATCH}: LUN ${lun.index} ('${lun.name}') serves device ${served}, and ${path} `
            + `${st ? 'is not a block device' : 'no longer resolves'} — the volume was renamed or destroyed under the live LUN. `
            + `ANAS will not run a ZFS verb on what the path names now. Delete the LUN without "Also destroy" to drop it.`,
        },
      }
    }
    const named = `${st.rdevMajor}:${st.rdevMinor}`
    if (named !== served) {
      return {
        device: null,
        refusal: {
          reason: 'served-device-mismatch',
          message: `${SERVED_DEVICE_MISMATCH}: LUN ${lun.index} ('${lun.name}') serves device ${served}`
            + `${backstore.kernelDevice ? ` (${backstore.kernelDevice})` : ''}, but ${path} is device ${named} — the volume `
            + `was renamed or re-created under the live LUN. ANAS will not run a ZFS verb on the volume the path names now. `
            + `Delete the LUN without "Also destroy" to drop it, then export the volume you mean.`,
        },
      }
    }
    return { device: `block:${served}`, refusal: null }
  }
  // fileio: the kernel keeps the file open and names no inode, so the path's
  // own identity is what a request binds and a job compares.
  if (!st || st.type !== 'file') {
    return {
      device: null,
      refusal: {
        reason: 'served-device-unknown',
        message: `${path} ${st ? 'is not a regular file' : 'no longer resolves'}, so it is not the image LUN ${lun.index} `
          + `('${lun.name}') was created on — ANAS will not act on it.`,
      },
    }
  }
  return { device: `file:${st.dev}:${st.ino}`, refusal: null }
}

/** `/iscsi/<iqn>/tpg<tag>` — the configshell path of one TPG. */
export function tpgPath(iqn: string, tag: number): string {
  return `/iscsi/${iqn}/tpg${tag}`
}

/** `/backstores/<plugin>/<name>` — the configshell path of one backstore. */
export function backstorePath(plugin: string, name: string): string {
  return `/backstores/${plugin}/${name}`
}

/**
 * Is this target ANAS's to change? The ONE answer every target and LUN verb
 * asks — the guard's `foreignGate` and the LUN-update route alike.
 *
 *  - a foreign target is hands-off (3.25): the read layer says why;
 *  - a target with more than one TPG (cr3, ISCSI-H2) is refused too. ANAS
 *    creates exactly one TPG per target and every sequence addresses that one
 *    (`tpgPath(iqn, target.tpgTag)`), so a second TPG — added by hand — would
 *    be invisible to an ACL edit, deleted with its sessions by a target delete,
 *    and left out of every per-TPG check a LUN verb makes. Rather than act
 *    correctly on half the target, ANAS does not act on it at all;
 *  - a target with an existing LUN whose backing's OWNER could not be judged
 *    (cr3 review 2: the ZFS mountpoint table was unreadable) is refused. That
 *    unknown never makes the target foreign — the quarantine and the degraded
 *    mark keep working (the H1 rule) — and never makes it ANAS's own for a
 *    write either: a good read may call it foreign.
 */
export function handsOffRefusal(target: IscsiTargetDetail): IscsiRefusal | null {
  if (target.ownership !== 'anas') {
    return {
      reason: 'foreign-target',
      message: `Target '${target.iqn}' is not managed by ANAS and is hands-off: ${target.ownershipDetail}`,
    }
  }
  const others = target.otherTpgs ?? []
  if (others.length > 0) {
    const tags = [target.tpgTag, ...others.map(t => t.tpgTag)].join(', ')
    return {
      reason: 'multiple-tpgs',
      message: `Target '${target.iqn}' has ${others.length + 1} target portal groups (TPG ${tags}). ANAS creates one TPG per `
        + `target and changes only that one, so it does not change a target that was given more by hand — use targetcli `
        + `for this target. This refusal has no confirm bypass.`,
    }
  }
  const unknown = targetTpgs(target).flatMap(g => g.luns).find(l => l.backingOwnershipUnknown === true)
  if (unknown)
    return ownershipUnknownRefusal(unknown.backingPath)
  return null
}

/**
 * cr3: the ZFS mountpoint table could not be read, so a file backing's dataset
 * — and whether PVE owns it — is unknown. Unknown never reads as "not PVE's"
 * for a change to the backing.
 */
export function ownershipUnknownRefusal(path: string): { reason: string, message: string } {
  return {
    reason: 'backing-ownership-unknown',
    message: `ANAS could not read the ZFS mountpoint table ('zfs list' failed), so it cannot tell whether '${path}' is inside `
      + `PVE's footprint — refusing the change while its owner is unknown. Nothing was changed; retry once 'zfs list' answers.`,
  }
}

/**
 * The attribute set to REPLAY when a backstore is recreated.
 *
 * Read off the live LUN rather than reconstructed from defaults, because the
 * point of the replay is that the recreated disk is the SAME disk: LIO brings a
 * recreated backstore back with stock defaults (`emulate_tpu=0`,
 * `emulate_tpws=0`, `max_unmap_lba_count` back to the plugin's own), so anything
 * not replayed is silently lost (GT-18).
 */
export function replayAttributes(
  lun: { attributes: { emulateTpu?: boolean, emulateTpws?: boolean, blockSize?: number, writeBack?: boolean, maxUnmapLbaCount?: number } },
  plugin: string,
  override?: { writeBack?: boolean },
): IscsiBackstoreAttributes {
  const a = lun.attributes
  const attrs: IscsiBackstoreAttributes = {
    emulateTpu: a.emulateTpu ?? true,
    emulateTpws: a.emulateTpws ?? true,
    maxUnmapLbaCount: a.maxUnmapLbaCount ?? ISCSI_MAX_UNMAP_LBA_COUNT[plugin] ?? ISCSI_MAX_UNMAP_LBA_COUNT.fileio,
    writeBack: override?.writeBack ?? a.writeBack ?? ISCSI_DEFAULT_WRITE_BACK,
  }
  if (a.blockSize !== undefined)
    attrs.blockSize = a.blockSize
  return attrs
}
