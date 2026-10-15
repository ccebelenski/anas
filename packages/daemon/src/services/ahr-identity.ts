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
import { isMdPvName, matchCachePartitionLabel, UNKNOWN_PV_NAME } from './ahr-cache-state.js'
import { matchPartitionLabel } from './ahr-geometry.js'
import { ahrArrayLinePool, DEFAULT_MDADM_CONF } from './ahr-mdadm-conf.js'
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
    if (ahrArrayLinePool(a) === pool)
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
 *  - the pool has NO pins at all, its VG exists AND the PV list gives no
 *    answer about this array → the pool's: an adopted mdadm→LVM→btrfs stack
 *    (§5.3) carries no ANAS marker, and its name plus its VG is all the
 *    evidence there is — the pre-ident.3 rule. The `pvNames` guard is the
 *    identity-audit-H6 narrowing: a VG whose JOINED PVs are NAMED (`pvs`
 *    resolved them) puts that array's ownership on record — an array that is
 *    not among them is someone else's (a hand-built `<pool>-r<N>`, another
 *    pool's array beside an unrelated VG of the same name), and the VG's name
 *    alone must not promote it to a pool Destroy could reach. The fallback
 *    survives EXACTLY the case it is needed: an unreadable `pvs` (every reader
 *    degrades it to no PVs) or a VG whose every PV is an `[unknown]` device —
 *    a dead cache slice or an unassembled band, devices that were the pool's
 *    (the ahrcache.1 'bandsdown' shape) — gives no named membership to
 *    contradict the array, so adoption by VG name stands. Adoption is a
 *    DISPLAY verdict; it is not enough to tear the VG down: the LVM gates
 *    ({@link requireOwnedVgPvs}, {@link requirePoolVg}) refuse a VG with no
 *    named PV of the pool's (cr.22), which is exactly this shape.
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
  const pvAnswerUnknown = pvNames.size === 0 || [...pvNames].every(n => n === UNKNOWN_PV_NAME)
  return pinned.size === 0 && vgExists && pvAnswerUnknown
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

// ---- The LVM gates: is the VG the pool's, ON THE DISKS? (H6, cr.22) --------

/** The lsblk partition view the LVM gates read (kernel name → GPT label). */
export interface VgGatePartition {
  partlabel: string | null
}

/** The evidence the LVM gates check a VG's PVs against. */
export interface RequireOwnedVgPvsOptions {
  /**
   * The pool's OWNED live md arrays — `readAhrPoolIdentity().arrays` (or a
   * topology read's `pool.arrays`), the ident.3 machinery ({@link
   * isOwnedArray}: pinned UUID, a PV of the pool's VG, or an adopted unpinned
   * array). A PV named after one of these (kernel path when known, or
   * `/dev/md/<pool>-r<N>`) is a pool band.
   */
  arrays: Array<{ pool: string, band: number, kernelName?: string }>
  /**
   * The lsblk partition index (kernel name → label), for recognizing a named,
   * non-md PV of the VG as this pool's CACHE slice (ahrcache.1: a
   * `<pool>-cache<n>` GPT label). Absent/empty when no tree was read: a
   * non-md PV is then never provably a cache slice, and reads FOREIGN (fail
   * closed).
   */
  partsByKernel?: ReadonlyMap<string, VgGatePartition>
}

/** What one live read says about the PVs of the VG named like the pool. */
export interface VgPvAssessment {
  /** The VG as `vgs` lists it, or undefined when the node has no VG of that name. */
  vg: LvmVg | undefined
  /** NAMED PVs of the VG that are provably the pool's (an owned band array or its labelled cache slice). */
  owned: string[]
  /** NAMED PVs of the VG that are not provably the pool's. */
  foreign: string[]
  /** `[unknown]` rows — PVs the VG's metadata records whose device is gone. */
  missing: number
  /** Every `pvs` row of the VG, `[unknown]` included. */
  rows: number
}

/**
 * Is NAMED `pvName` (never `[unknown]` — the caller splits those out) a device
 * of `pool`'s?
 */
function ownedNamedVgPv(pool: string, pvName: string, opts: RequireOwnedVgPvsOptions): boolean {
  if (isMdPvName(pvName)) {
    // A band array — owned by the SAME identity the ident.3 machinery decided
    // is the pool's (pinned UUID, a PV of its VG, or an adopted unpinned array).
    return opts.arrays.some(a =>
      (a.kernelName !== undefined && pvName === `/dev/${a.kernelName}`) || pvName === `/dev/md/${a.pool}-r${a.band}`)
  }
  // A named non-md PV is the pool's ONLY on one of its cache slices
  // (ahrcache.1): a `<pool>-cache<n>` GPT label. Without a readable label it
  // is someone else's — fail closed.
  const kernel = pvName.startsWith('/dev/') ? pvName.slice('/dev/'.length) : pvName
  const label = opts.partsByKernel?.get(kernel)?.partlabel ?? null
  return label !== null && matchCachePartitionLabel(pool, label) !== null
}

/**
 * Sort the VG's `pvs` rows into owned / foreign / missing — pure, so the
 * captures can drive it directly.
 */
export function assessVgPvs(pool: string, pvs: LvmPv[], vgs: LvmVg[], opts: RequireOwnedVgPvsOptions): VgPvAssessment {
  const vg = vgs.find(v => v.name === pool)
  const inVg = pvs.filter(pv => pv.vgName === pool)
  const owned: string[] = []
  const foreign: string[] = []
  let missing = 0
  for (const pv of inVg) {
    if (pv.name === UNKNOWN_PV_NAME)
      missing++
    else if (ownedNamedVgPv(pool, pv.name, opts))
      owned.push(pv.name)
    else
      foreign.push(pv.name)
  }
  return { vg, owned, foreign, missing, rows: inVg.length }
}

/** The first line of a command's stderr, for a refusal message. */
function firstLine(stderr: string): string {
  return stderr.trim().split('\n')[0] || '(no stderr)'
}

/**
 * Read `pvs` + `vgs` and decide whether the VG named `pool` is PROVABLY this
 * pool's — the part both gates share. Throws (fail closed) on:
 *
 *  - an unreadable `pvs` or `vgs`;
 *  - a VG `vgs` lists whose PVs `pvs` does not account for (cr.22 finding 2):
 *    ZERO rows, or fewer rows than the VG's own `pv_count`, means some PV of
 *    the VG went unreported, and the gate cannot vouch for a PV it was not
 *    shown;
 *  - a VG with NO named PV that is provably the pool's (cr.22 finding 1). An
 *    `[unknown]` row is the VG's own metadata saying "a member of mine is
 *    missing" — it is the POOL's missing device only when the VG is the
 *    pool's, and the only proof of that is a named PV of the VG that IS the
 *    pool's: a band array the ident.3 machinery owns, or its labelled cache
 *    slice — a device carrying this VG's metadata on the pool's own disk. A
 *    VG of nothing but `[unknown]` rows proves nothing: it is exactly what a
 *    foreign VG with dead devices looks like beside a hand-built `<vg>-r1`.
 *    (Real LVM lists a VG only through a PV it can read, so a listed VG has a
 *    named row; an all-`[unknown]` answer is a contradiction the gate refuses
 *    rather than interprets.)
 *
 * No VG of that name on the node returns an assessment with `vg` undefined:
 * there is then no LV, VG or PV of it for any LVM verb to reach.
 */
async function readVgPvAssessment(
  executor: CommandExecutor,
  pool: string,
  opts: RequireOwnedVgPvsOptions,
  verb: string,
  /** The teardown gate: a named PV that is not the pool's refuses outright. */
  refuseForeign: boolean,
): Promise<VgPvAssessment> {
  const pvsRes = await executor.exec(PVS, PVS_ARGS)
  if (pvsRes.exitCode !== 0) {
    throw new Error(
      `cannot read LVM physical volumes (pvs: ${firstLine(pvsRes.stderr)}) — refusing any ${verb} of volume group '${pool}': its PVs cannot be proven to be this pool's`,
    )
  }
  const vgsRes = await executor.exec(VGS, VGS_ARGS)
  if (vgsRes.exitCode !== 0) {
    throw new Error(
      `cannot read LVM volume groups (vgs: ${firstLine(vgsRes.stderr)}) — refusing any ${verb} of volume group '${pool}': it cannot be proven to be this pool's`,
    )
  }
  const a = assessVgPvs(pool, parsePvsReport(pvsRes.stdout), parseVgsReport(vgsRes.stdout), opts)
  if (!a.vg)
    return a
  // `pv_count` is a default `vgs` column; 0 means the report did not carry it
  // (a VG always has at least one PV), and then only the zero-row test applies.
  if (a.rows === 0 || (a.vg.pvCount > 0 && a.rows < a.vg.pvCount)) {
    const recorded = a.vg.pvCount > 0 ? `records ${a.vg.pvCount} physical volume${a.vg.pvCount === 1 ? '' : 's'}` : 'is listed by vgs'
    throw new Error(
      `volume group '${pool}' ${recorded} but pvs reported ${a.rows === 0 ? 'none' : `only ${a.rows}`} — `
      + `refusing any ${verb}: a physical volume that was not shown cannot be proven to be this pool's`,
    )
  }
  if (refuseForeign && a.foreign.length > 0) {
    throw new Error(
      `volume group '${pool}' contains physical volume${a.foreign.length === 1 ? '' : 's'} ${a.foreign.join(', ')} — `
      + `not this pool's arrays or cache slices. Refusing any LVM or md teardown: ANAS only removes a volume group whose every PV is its own`,
    )
  }
  if (a.owned.length === 0) {
    const shown = [...a.foreign, ...(a.missing > 0 ? [`${a.missing} missing device${a.missing === 1 ? '' : 's'} (${UNKNOWN_PV_NAME})`] : [])]
    throw new Error(
      `volume group '${pool}' has no physical volume that is this pool's own array or cache slice (it shows ${shown.join(', ')}) — `
      + `refusing any ${verb}: a missing device counts as the pool's only when the same volume group shows at least one of the pool's own devices`,
    )
  }
  return a
}

/**
 * THE gate every LVM teardown must pass before it may run (code review H6,
 * cr.22). Destroy's `lvconvert --uncache`, `lvremove`, `vgreduce
 * --removemissing`, `vgremove` and `pvremove` against the VG named `pool` — an
 * AHR pool's name IS its VG name — may act
 * only when the VG is PROVABLY this pool's and EVERY PV of it is either:
 *
 *  - a NAMED device the pool owns: a band array the ident.3 machinery owns
 *    (pinned, a PV of the VG, an adopted unpinned array) or its own cache
 *    slice (ahrcache.1: a named non-md PV on a `<pool>-cache<n>` labelled
 *    partition) — and at least one such named PV must be present; or
 *  - an `[unknown]` PV — a device the VG's metadata records that is gone now —
 *    admitted ONLY under that anchor ({@link readVgPvAssessment}): the named
 *    owned PV carries the VG's metadata on the pool's own disk, so the VG is
 *    the pool's, and its missing members are the pool's missing devices.
 *
 * Anything else — PVE's root `pve` VG (with named PVs or with every PV
 * missing), a same-named pool moved in from another node, an operator's
 * hand-added PV, a PV `pvs` did not report — REFUSES the whole teardown by
 * throwing, naming the VG and what it found. FAIL CLOSED: an unreadable
 * `pvs`/`vgs` is a refusal, never an admission — and because destroy tears
 * top-down (LVM before md), the md-layer teardown that follows never runs.
 *
 * Why the anchor and not the pin: an mdadm.conf ARRAY line is no proof the
 * array is ANAS's (`mdadm --detail --scan >> mdadm.conf` writes the same line
 * for a hand-built `pve-r1`), and a pinned array that is not a PV of the VG
 * says nothing about the VG at all.
 *
 * Stateless (Principle 11): the evidence is read live from the system — lvm's
 * PV/VG reports and the GPT labels on the disks. Nothing new is stored.
 *
 * Returns the assessment so the teardown acts on exactly what was proven:
 * `pvremove` names only the owned PVs, never `[unknown]` (cr.22 finding 4).
 * The cache verbs, which change the VG without removing it, use the weaker
 * {@link requirePoolVg}.
 */
export async function requireOwnedVgPvs(
  executor: CommandExecutor,
  pool: string,
  opts: RequireOwnedVgPvsOptions,
): Promise<VgPvAssessment> {
  return readVgPvAssessment(executor, pool, opts, 'LVM teardown', true)
}

/**
 * The gate for the cache verbs (cr.22 finding 3): `lvconvert --uncache`, the
 * orphan `lvremove -f <pool>/<pool>-cache` and `vgreduce` change the VG named
 * `pool` without removing it, so they need the VG to be PROVABLY the pool's —
 * the anchor {@link requireOwnedVgPvs} requires (a named PV that is an owned
 * band array or the pool's labelled cache slice; every PV reported) — but NOT
 * that every PV is the pool's: a PV an operator added to the pool's VG by hand
 * is left where it is (detach ejects only the pool's own slices), and refusing
 * over it would leave a dead cache in front of the pool. Whether an
 * `[unknown]` PV may be dropped is decided later, by `dropMissingCachePv`'s
 * band guard. Throws (fail closed) exactly as the teardown gate does.
 */
export async function requirePoolVg(
  executor: CommandExecutor,
  pool: string,
  opts: RequireOwnedVgPvsOptions,
): Promise<VgPvAssessment> {
  return readVgPvAssessment(executor, pool, opts, 'cache change', false)
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
 *  - a partition labelled `<name>-d<n>-b<band>` or `<name>-cache<n>`;
 *  - an LVM volume group named `<name>` (code review H6) — the pool name
 *    BECOMES its VG name, and `vgcreate` runs only after the disks are wiped.
 *
 * Any one of them would make the new pool's identity ambiguous from its first
 * minute — exactly the merge every other check in this module exists to stop.
 *
 * FAIL-CLOSED per source (code review H6): an unreadable read cannot confirm
 * the name free, and a create that proceeds on guesswork could wipe disks
 * under a name an array, pin, label or volume group already carries. Each
 * source is answered with a reason the callers surface verbatim in their 409/
 * pre-wipe refusal.
 */
export async function ahrNameOccupancy(
  executor: CommandExecutor,
  name: string,
  opts: { mdadmConfPath?: string } = {},
): Promise<string[]> {
  const reasons: string[] = []
  const mdstatRes = await executor.exec(CAT, MDSTAT_CAT_ARGS)
  if (mdstatRes.exitCode !== 0) {
    reasons.push('cannot read /proc/mdstat — the name cannot be confirmed free')
  }
  else {
    const arrays = (await readNamedMdArrays(executor, mdstatRes.stdout)).filter(a => a.pool === name)
    if (arrays.length > 0) {
      const list = arrays.map(a => `${a.pool}-r${a.band} (/dev/${a.kernelName})`).join(', ')
      reasons.push(`md array${arrays.length === 1 ? '' : 's'} ${list} already ${arrays.length === 1 ? 'uses' : 'use'} the name`)
    }
  }
  // ENOENT reads as '' (no pins — a fresh node); a real read failure refuses.
  const confText = await readConfig(resolveMdadmConfPath(opts.mdadmConfPath)).catch(() => null)
  if (confText === null) {
    reasons.push('mdadm.conf is not readable — the name cannot be confirmed free')
  }
  else if (pinnedUuids(parseMdadmConfDoc(confText), name).size > 0) {
    reasons.push(`mdadm.conf already pins arrays named '${name}-r<N>'`)
  }
  const lsblk = await executor.exec(LSBLK, LSBLK_LABEL_ARGS)
  if (lsblk.exitCode === 0) {
    const labels = collectPartLabels(lsblk.stdout)
      .filter(l => matchPartitionLabel(name, l) !== null || matchCachePartitionLabel(name, l) !== null)
    if (labels.length > 0)
      reasons.push(`partition${labels.length === 1 ? '' : 's'} labelled ${[...new Set(labels)].join(', ')} already carry the name`)
  }
  else {
    reasons.push('cannot read the partition labels (lsblk failed) — the name cannot be confirmed free')
  }
  const vgsRes = await executor.exec(VGS, VGS_ARGS)
  if (vgsRes.exitCode !== 0) {
    reasons.push('LVM volume groups could not be read (vgs failed) — the name cannot be confirmed free')
  }
  else if (parseVgsReport(vgsRes.stdout).some(v => v.name === name)) {
    reasons.push(`an LVM volume group named '${name}' already exists`)
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
