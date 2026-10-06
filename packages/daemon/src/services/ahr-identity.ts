import type { AhrExpansionIntent, AhrPool } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { LvmPv, LvmVg } from '../parsers/lvm-report.js'
import type { MdadmConfDoc } from '../parsers/mdadm-conf.js'
import type { MdadmDetailExport } from '../parsers/mdadm-detail.js'
import type { MdstatArray } from '../parsers/mdstat.js'
import { parsePvsReport, parseVgsReport, PVS_ARGS, VGS_ARGS } from '../parsers/lvm-report.js'
import { getArrays, parseMdadmConfDoc } from '../parsers/mdadm-conf.js'
import { matchAhrArrayName, mdadmDetailExportArgs, mdadmExamineExportArgs, parseMdadmDetailExport } from '../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS, parseMdstat } from '../parsers/mdstat.js'
import { matchCachePartitionLabel } from './ahr-cache-state.js'
import { matchPartitionLabel } from './ahr-geometry.js'
import { DEFAULT_MDADM_CONF } from './ahr-mdadm-conf.js'
import { readConfig } from './config-writer.js'

/**
 * "Is this array / partition / slice OURS?" — the ONE answer every AHR verb
 * asks before it acts (story ident.3, identity audit #3–#7).
 *
 * A NAME is a convention anyone can reuse: `<pool>-r<N>` md arrays,
 * `<pool>-d<n>-b<band>` and `<pool>-cache<n>` GPT labels. A hand-built
 * `media-r1` mirror, an ANAS pool moved in from another node, or the residue of
 * a pool destroyed last year all carry the same names as a live pool `media`.
 * Acting on the name — stopping, zeroing, zapping, force-starting — is how one
 * pool's verb reaches another's disks. So identity is decided by what the
 * system records that a name cannot fake:
 *
 *  - an md array is this pool's when its UUID is PINNED for the pool in
 *    mdadm.conf (the ARRAY line ANAS writes at create/expand — config is the
 *    API), or when the array is a PV of the pool's VG (the adoptable
 *    mdadm→LVM shape, and the one fact that survives a failed pin);
 *  - a member partition is this pool's when the md UUID INSIDE it
 *    (`mdadm --examine --export`) is one of the pool's array UUIDs;
 *  - a cache slice is this pool's when it is a PV of the pool's VG (a VG name
 *    is unique on a host at any instant, so "PV whose VG is <pool>" and "PV of
 *    the VG with this UUID" are the same set within one read).
 *
 * Every reader fails CLOSED toward "not ours": an unreadable mdadm.conf is no
 * pins, an unreadable `pvs` is no PVs, an unreadable superblock is no UUID.
 * Destroy, cache detach, the boot recovery ladder and the topology merge all
 * go through here; create asks {@link ahrNameOccupancy} so a name that is
 * already in use on the node is never handed out twice.
 *
 * Stateless: everything here is read live from md, LVM and mdadm.conf. The
 * expansion intent (the one persisted AHR record) carries the UUIDs it was
 * written for, and {@link isIntentStale} compares them — nothing new is stored.
 */

const CAT = '/usr/bin/cat'
const MDADM = '/usr/sbin/mdadm'
const PVS = '/usr/sbin/pvs'
const VGS = '/usr/sbin/vgs'
const LSBLK = '/usr/bin/lsblk'

/** Labels only — the occupancy check needs nothing else from the tree. */
const LSBLK_LABEL_ARGS = ['-J', '-o', 'NAME,PARTLABEL']

/** ARRAY-pin device path of one band array (`/dev/md/<pool>-r<N>`). */
const PIN_DEVICE_RE = /^\/dev\/md\/(.+)$/

/** mdadm UUID: four colon-separated groups of eight hex digits. */
const MD_UUID_RE = /^[0-9a-f]{8}(?::[0-9a-f]{8}){3}$/i

/** mdadm UUIDs compare case-insensitively; the canonical form is lowercase. */
export function normalizeMdUuid(uuid: string): string {
  return uuid.trim().toLowerCase()
}

/** The canonical (lowercase) form of a well-formed md UUID, else null. */
export function canonicalMdUuid(uuid: string | null | undefined): string | null {
  if (typeof uuid !== 'string')
    return null
  const u = normalizeMdUuid(uuid)
  return MD_UUID_RE.test(u) ? u : null
}

/** The mdadm.conf the daemon edits (explicit > ANAS_MDADM_CONF > Debian default). */
export function resolveMdadmConfPath(override?: string): string {
  return override ?? process.env.ANAS_MDADM_CONF ?? DEFAULT_MDADM_CONF
}

/** Read + parse mdadm.conf, fail-closed: unreadable reads as "no pins". */
export async function readMdadmConfDoc(path?: string): Promise<MdadmConfDoc> {
  return parseMdadmConfDoc(await readConfig(resolveMdadmConfPath(path)).catch(() => ''))
}

/**
 * The md UUIDs pinned for `pool` — every ARRAY line whose device is
 * `/dev/md/<pool>-r<N>` (the form ANAS writes) or whose `name=` is
 * `<pool>-r<N>` (homehost-tolerant). Foreign ARRAY lines are never counted.
 */
export function pinnedUuids(doc: MdadmConfDoc, pool: string): Set<string> {
  const out = new Set<string>()
  for (const a of getArrays(doc)) {
    if (a.uuid === undefined)
      continue
    const byDevice = a.device.match(PIN_DEVICE_RE)
    const named = (byDevice ? matchAhrArrayName(byDevice[1]) : null) ?? (a.name ? matchAhrArrayName(a.name) : null)
    if (named?.pool === pool)
      out.add(normalizeMdUuid(a.uuid))
  }
  return out
}

/** Names (as LVM reports them) of every PV in the VG named `pool`. */
export function poolPvNames(pvs: LvmPv[], pool: string): Set<string> {
  return new Set(pvs.filter(p => p.vgName === pool).map(p => p.name))
}

/** The facts the ownership rule reads about one live `<pool>-r<N>`-named array. */
export interface ArrayIdentityFacts {
  pool: string
  band: number
  /** MD_UUID from `--detail --export`, or null when it could not be read. */
  uuid: string | null
  /** Transient kernel name (`md127`) — matched against LVM's PV path only. */
  kernelName: string
}

/**
 * THE ownership rule for a live md array (identity audit #4/#5):
 *
 *  - its UUID is pinned for the pool → the pool's;
 *  - it is a PV of the pool's VG → the pool's (the one fact that survives a
 *    pin an expansion could not write);
 *  - the pool has NO pins at all but its VG exists → the pool's: an adopted
 *    mdadm→LVM→btrfs stack (§5.3) carries no ANAS marker, and its name plus
 *    its VG is all the evidence there is — exactly the pre-ident.3 rule.
 *
 * Once a pool is pinned, only its pinned UUIDs (and its VG's PVs) are
 * admitted: a same-named array with neither is someone else's — never merged
 * into the pool, never stopped, never started, never zeroed.
 */
export function isOwnedArray(a: ArrayIdentityFacts, pinned: Set<string>, pvNames: Set<string>, vgExists: boolean): boolean {
  if (a.uuid !== null && pinned.has(normalizeMdUuid(a.uuid)))
    return true
  if (pvNames.has(`/dev/${a.kernelName}`) || pvNames.has(`/dev/md/${a.pool}-r${a.band}`))
    return true
  return pinned.size === 0 && vgExists
}

/** One live md array whose superblock name follows the AHR convention. */
export interface NamedMdArray {
  pool: string
  band: number
  kernelName: string
  uuid: string | null
  mdstat: MdstatArray
  detail: MdadmDetailExport
}

/**
 * Every live md array (mdstat discovers, `--detail --export` identifies —
 * GT-2/GT-3) whose superblock name matches `<pool>-r<N>`, foreign ones
 * included: callers filter with {@link isOwnedArray}. An unreadable mdstat is
 * an empty list.
 */
export async function readNamedMdArrays(executor: CommandExecutor, mdstatText?: string): Promise<NamedMdArray[]> {
  let text = mdstatText
  if (text === undefined) {
    const mdstatRes = await executor.exec(CAT, MDSTAT_CAT_ARGS)
    if (mdstatRes.exitCode !== 0)
      return []
    text = mdstatRes.stdout
  }
  const out: NamedMdArray[] = []
  for (const md of parseMdstat(text)) {
    const res = await executor.exec(MDADM, mdadmDetailExportArgs(`/dev/${md.kernelName}`))
    const detail = parseMdadmDetailExport(res.stdout)
    const named = matchAhrArrayName(detail.name ?? detail.devName ?? '')
    if (!named)
      continue
    out.push({ ...named, kernelName: md.kernelName, uuid: detail.uuid, mdstat: md, detail })
  }
  return out
}

/** One live array the pool owns. Kernel handles are valid for THIS pass only (GT-2). */
export interface OwnedMdArray extends NamedMdArray {
  /** `/dev/md127` — the handle commands run against. */
  dev: string
}

/** A pool's identity as the system records it right now. */
export interface AhrPoolIdentity {
  pool: string
  /** UUIDs pinned for the pool in mdadm.conf. */
  pinned: Set<string>
  /** Live arrays the pool owns (pinned, or a PV of its VG). */
  arrays: OwnedMdArray[]
  /** Live `<pool>-r<N>`-named arrays that are NOT the pool's — reported, never touched. */
  foreign: NamedMdArray[]
  /** Every UUID that is the pool's: pinned ∪ owned-live ∪ the caller's extras. */
  uuids: Set<string>
  /** The VG's LVM UUID, or null when the VG is absent or the column unreadable. */
  vgUuid: string | null
  /** PV names (as LVM reports them) of the pool's VG — md bands AND cache slices. */
  pvNames: Set<string>
}

export interface PoolIdentityOptions {
  /** mdadm.conf override (else ANAS_MDADM_CONF / the Debian default). */
  mdadmConfPath?: string
  /**
   * UUIDs the CALLER created in this same job (a failed create's rollback runs
   * before anything is pinned) — the pool's by construction.
   */
  extraUuids?: Iterable<string>
  /** /proc/mdstat as the caller already read it this pass (one read, one view). */
  mdstatText?: string
  /**
   * Read the VG's UUID even when the pool is pinned. `vgs` is otherwise asked
   * only for an UNPINNED pool, whose ownership rests on its VG existing.
   */
  withVgUuid?: boolean
}

/** Read a pool's identity live: pins, owned/foreign arrays, VG UUID, VG PVs. */
export async function readAhrPoolIdentity(
  executor: CommandExecutor,
  pool: string,
  opts: PoolIdentityOptions = {},
): Promise<AhrPoolIdentity> {
  const pinned = pinnedUuids(await readMdadmConfDoc(opts.mdadmConfPath), pool)
  const named = (await readNamedMdArrays(executor, opts.mdstatText)).filter(a => a.pool === pool)
  const pvsRes = await executor.exec(PVS, PVS_ARGS)
  const pvNames = pvsRes.exitCode === 0 ? poolPvNames(parsePvsReport(pvsRes.stdout), pool) : new Set<string>()
  let vg: LvmVg | undefined
  if (pinned.size === 0 || opts.withVgUuid) {
    const vgsRes = await executor.exec(VGS, VGS_ARGS)
    vg = vgsRes.exitCode === 0 ? parseVgsReport(vgsRes.stdout).find(v => v.name === pool) : undefined
  }

  const extras = new Set(Array.from(opts.extraUuids ?? [], normalizeMdUuid))
  const arrays: OwnedMdArray[] = []
  const foreign: NamedMdArray[] = []
  for (const a of named) {
    const owned = isOwnedArray(a, pinned, pvNames, vg !== undefined) || (a.uuid !== null && extras.has(normalizeMdUuid(a.uuid)))
    if (owned)
      arrays.push({ ...a, dev: `/dev/${a.kernelName}` })
    else
      foreign.push(a)
  }
  const uuids = new Set([...pinned, ...extras])
  for (const a of arrays) {
    if (a.uuid !== null)
      uuids.add(normalizeMdUuid(a.uuid))
  }
  return { pool, pinned, arrays, foreign, uuids, vgUuid: vg?.uuid ?? null, pvNames }
}

/** Does this UUID belong to the pool? (null/absent never does.) */
export function ownsUuid(identity: Pick<AhrPoolIdentity, 'uuids'>, uuid: string | null | undefined): boolean {
  return uuid !== null && uuid !== undefined && identity.uuids.has(normalizeMdUuid(uuid))
}

/**
 * The md identity INSIDE one partition (`mdadm --examine --export`): the array
 * UUID and superblock name, or nulls when the partition carries no md
 * superblock (or could not be read — the same answer, and the closed one).
 */
export async function examineMember(executor: CommandExecutor, device: string): Promise<{ uuid: string | null, name: string | null }> {
  const res = await executor.exec(MDADM, mdadmExamineExportArgs(device))
  if (res.exitCode !== 0)
    return { uuid: null, name: null }
  const parsed = parseMdadmDetailExport(res.stdout)
  return { uuid: parsed.uuid ? normalizeMdUuid(parsed.uuid) : null, name: parsed.name }
}

/** What one partition is, relative to a pool. */
export type PartitionVerdict = 'ours' | 'foreign' | 'blank'

/**
 * Classify one partition: `ours` when its md superblock's UUID is the pool's,
 * `foreign` when it carries a superblock of any other array, `blank` when it
 * carries none. `blank` is not ownership — a destroy zeroes nothing on it.
 */
export async function classifyPartition(
  executor: CommandExecutor,
  identity: Pick<AhrPoolIdentity, 'uuids'>,
  device: string,
): Promise<PartitionVerdict> {
  const { uuid } = await examineMember(executor, device)
  if (uuid === null)
    return 'blank'
  return ownsUuid(identity, uuid) ? 'ours' : 'foreign'
}

// ---- Create: is the name free? --------------------------------------------

/** Every GPT partition label in an `lsblk -J` tree (any depth). */
function collectPartLabels(json: string): string[] {
  let root: { blockdevices?: LabelNode[] }
  try {
    root = JSON.parse(json)
  }
  catch {
    return []
  }
  const out: string[] = []
  const walk = (node: LabelNode): void => {
    if (typeof node.partlabel === 'string' && node.partlabel !== '')
      out.push(node.partlabel)
    for (const child of node.children ?? [])
      walk(child)
  }
  for (const node of root.blockdevices ?? [])
    walk(node)
  return out
}

interface LabelNode {
  partlabel?: string | null
  children?: LabelNode[]
}

/**
 * Why `name` cannot be given to a NEW pool, or an empty list when it is free
 * (identity audit #4: create did not refuse an occupied name). A name is
 * occupied when the node already has, under it:
 *
 *  - a live md array named `<name>-r<N>` — ours or anyone's;
 *  - an ARRAY pin for `/dev/md/<name>-r<N>` in mdadm.conf;
 *  - a partition labelled `<name>-d<n>-b<band>` or `<name>-cache<n>`.
 *
 * Any one of them would make the new pool's identity ambiguous from its first
 * minute — exactly the merge every other check in this module exists to stop.
 * Fail-open per source (an unreadable listing adds no reason): the disks the
 * create wipes were each verified available, and this check guards the NAME.
 */
export async function ahrNameOccupancy(
  executor: CommandExecutor,
  name: string,
  opts: { mdadmConfPath?: string } = {},
): Promise<string[]> {
  const reasons: string[] = []
  const arrays = (await readNamedMdArrays(executor)).filter(a => a.pool === name)
  if (arrays.length > 0) {
    const list = arrays.map(a => `${a.pool}-r${a.band} (/dev/${a.kernelName})`).join(', ')
    reasons.push(`md array${arrays.length === 1 ? '' : 's'} ${list} already ${arrays.length === 1 ? 'uses' : 'use'} the name`)
  }
  if (pinnedUuids(await readMdadmConfDoc(opts.mdadmConfPath), name).size > 0)
    reasons.push(`mdadm.conf already pins arrays named '${name}-r<N>'`)
  const lsblk = await executor.exec(LSBLK, LSBLK_LABEL_ARGS)
  if (lsblk.exitCode === 0) {
    const labels = collectPartLabels(lsblk.stdout)
      .filter(l => matchPartitionLabel(name, l) !== null || matchCachePartitionLabel(name, l) !== null)
    if (labels.length > 0)
      reasons.push(`partition${labels.length === 1 ? '' : 's'} labelled ${[...new Set(labels)].join(', ')} already carry the name`)
  }
  return reasons
}

// ---- The expansion intent: whose is it? -----------------------------------

/** The identity an intent records when it is written (story ident.3). */
export function poolIntentIdentity(pool: Pick<AhrPool, 'arrays' | 'vg'>): Pick<AhrExpansionIntent, 'arrayUuids' | 'vgUuid'> {
  const arrayUuids = pool.arrays.map(a => canonicalMdUuid(a.uuid)).filter((u): u is string => u !== null)
  return {
    ...(arrayUuids.length > 0 ? { arrayUuids } : {}),
    ...(pool.vg.uuid ? { vgUuid: pool.vg.uuid } : {}),
  }
}

/**
 * Is `intent` an earlier pool's? True when the identity it recorded cannot be
 * this pool's: a different VG UUID, or array UUIDs none of which the pool
 * knows. An intent written before ident.3 records nothing and is never stale
 * by this test (there is nothing to compare); neither is one compared against
 * a pool whose identity could not be read.
 */
export function isIntentStale(
  intent: Pick<AhrExpansionIntent, 'arrayUuids' | 'vgUuid'>,
  known: { uuids: Iterable<string>, vgUuid: string | null | undefined },
): boolean {
  if (intent.vgUuid && known.vgUuid && intent.vgUuid !== known.vgUuid)
    return true
  const recorded = (intent.arrayUuids ?? []).map(normalizeMdUuid)
  const live = new Set(Array.from(known.uuids, normalizeMdUuid))
  if (recorded.length === 0 || live.size === 0)
    return false
  return !recorded.some(u => live.has(u))
}

/** {@link isIntentStale} against a topology read of the pool. */
export function isIntentStaleForPool(intent: Pick<AhrExpansionIntent, 'arrayUuids' | 'vgUuid'>, pool: Pick<AhrPool, 'arrays' | 'vg'>): boolean {
  return isIntentStale(intent, {
    uuids: pool.arrays.map(a => a.uuid).filter((u): u is string => typeof u === 'string'),
    vgUuid: pool.vg.uuid,
  })
}
