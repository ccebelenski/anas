/**
 * iSCSI mutations — the write half of the LIO stack (story `iscsi.4`).
 *
 * Everything here exists because `targetcli` is not transactional and LIO is not
 * honest about failure. Four ground-truth facts shape every line of it:
 *
 *  1. **One command per invocation.** `targetcli` has three call forms and they
 *     differ dangerously (GT-5). Only `targetcli <one command>` reports a real
 *     exit code; reading commands from stdin CONTINUES past a failure, still
 *     exits 0, and then `auto_save_on_exit=true` PERSISTS the half-applied
 *     state. At 0.1–0.4 s per call (GT-6) there is no cost argument for
 *     anything else, so every step below is its own process with its own
 *     checked exit code. {@link runTargetcli} is the only door.
 *  2. **Secrets never ride argv.** `targetcli "… set auth password=X"` puts the
 *     CHAP secret in the process command line for anyone with `ps` to read. A
 *     direct configfs write avoids argv entirely and round-trips through both
 *     `targetcli get auth` and `saveconfig` (GT-35). {@link writeAclAuth} is
 *     that write, and {@link assertNoSecretArgs} makes the rule structural: an
 *     argv carrying a password never reaches the executor at all.
 *  3. **A `saveconfig` over a degraded restore destroys data.** After a boot
 *     restore whose backing device was missing — which reports systemd SUCCESS
 *     (GT-20/GT-21) — LIO's in-memory config no longer contains the LUN, so any
 *     save writes the truncated config over the file and the LUN is gone for
 *     good (GT-22). {@link assertSaveable} is the guard, and it runs against a
 *     snapshot taken BEFORE the sequence starts: "degraded" is a property of the
 *     restore, not of the deletions this code is itself in the middle of making.
 *  4. **Identity is `{serial, attributes}`, replayed together.** `wwn` is a
 *     CREATE-ONLY parameter with no `set` verb (GT-16), attributes are dropped
 *     on every recreate (GT-18), and initiators, ESXi, Windows and **PVE's own
 *     volids** key on the serial (GT-14/GT-45). Every path that recreates a
 *     backstore — here, that is the fileio resize — replays both.
 *
 * Serialization: every sequence runs under ONE daemon-wide mutex
 * ({@link withIscsiLock}). Two concurrent `targetcli` invocations against the
 * same tree are exactly the half-applied state that has no rollback.
 */

import type {
  AddIscsiLunRequest,
  CreateIscsiTargetRequest,
  IscsiAclRequest,
  IscsiAuthMode,
  IscsiClaim,
  IscsiTargetDetail,
  UpdateIscsiTargetRequest,
} from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { IscsiPaths, IscsiReadContext } from './iscsi.js'
import { randomUUID } from 'node:crypto'
import { open, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { anasIqn, IscsiIqn } from '@anas/shared'
import { readAhrPools } from './ahr-topology.js'
import { CONFIGFS_TARGET_ROOT } from './iscsi-configfs.js'
import { computeIscsiHealth } from './iscsi-health.js'
import { classifyBacking } from './iscsi-ownership.js'
import { buildIscsiTargets, iscsiAvailability, readIscsiContext } from './iscsi.js'

/** `/usr/bin/targetcli` — the real binary on Debian/PVE. */
export const TARGETCLI = '/usr/bin/targetcli'

/** `/usr/sbin/zfs` — a zvol LUN's grow and destroy go through it. */
export const ZFS = '/usr/sbin/zfs'

/** The packages a node needs before it can serve block storage (GT-1). */
export const ISCSI_PACKAGES = 'targetcli-fb python3-rtslib-fb'

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

/** The attribute set for a fresh backstore of `plugin`. */
export function defaultBackstoreAttributes(
  plugin: string,
  opts?: { blockSize?: number, writeBack?: boolean },
): IscsiBackstoreAttributes {
  const attrs: IscsiBackstoreAttributes = {
    emulateTpu: true,
    emulateTpws: true,
    maxUnmapLbaCount: ISCSI_MAX_UNMAP_LBA_COUNT[plugin] ?? ISCSI_MAX_UNMAP_LBA_COUNT.fileio,
    writeBack: opts?.writeBack ?? ISCSI_DEFAULT_WRITE_BACK,
  }
  if (opts?.blockSize !== undefined)
    attrs.blockSize = opts.blockSize
  return attrs
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

// ---------------------------------------------------------------------------
// The daemon-wide iSCSI mutex
// ---------------------------------------------------------------------------

/**
 * One promise chain for the whole LIO tree. `targetcli` reads configfs, decides,
 * and writes — two of those interleaved is the half-applied state GT-5 warns
 * about, and there is no rollback for it.
 *
 * The chain swallows a prior failure so one failed sequence cannot wedge the
 * lock (the `config-writer.ts` idiom).
 */
let iscsiChain: Promise<unknown> = Promise.resolve()

export function withIscsiLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = iscsiChain.catch(() => {}).then(fn)
  iscsiChain = next.catch(() => {})
  return next
}

// ---------------------------------------------------------------------------
// Driving targetcli
// ---------------------------------------------------------------------------

/**
 * An argv token that would put a CHAP secret on the command line.
 *
 * `targetcli "/iscsi/…/acls/… set auth password=X"` is the obvious call and it
 * is forbidden: the secret shows up in `ps` for every local user (GT-35). The
 * check is structural rather than a comment, so a future edit that reaches for
 * the convenient call fails loudly here instead of leaking quietly.
 */
const SECRET_ARG_RE = /^(?:password|password_mutual|mutual_password)=/i

/** Thrown when a targetcli invocation would carry a secret on argv. */
export class SecretOnArgvError extends Error {
  constructor(token: string) {
    super(
      `Refusing to run targetcli with '${token.split('=')[0]}=' on the command line — `
      + 'CHAP secrets are written straight to configfs (docs/ISCSI-GROUND-TRUTH.md GT-35)',
    )
    this.name = 'SecretOnArgvError'
  }
}

/** Throw if any argv token would leak a secret. Exported so tests assert it. */
export function assertNoSecretArgs(args: string[]): void {
  for (const a of args) {
    if (SECRET_ARG_RE.test(a))
      throw new SecretOnArgvError(a)
  }
}

/** A targetcli invocation that exited non-zero. */
export class TargetcliError extends Error {
  constructor(
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`)
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .join('; ')
    super(`targetcli ${args.join(' ')} failed: ${detail}`)
    this.name = 'TargetcliError'
  }
}

/**
 * Run ONE targetcli command.
 *
 * `targetcli` joins its argv with spaces and parses the result as a single
 * configshell command line (`[path] command [params…]`), which is why the
 * arguments arrive here as an array and are never shell-quoted: `['/iscsi',
 * 'create', iqn]` becomes `/iscsi create <iqn>`. Two commands in one invocation
 * are rejected by configshell itself (`Got 2 positionnal parameters, expected at
 * most 1`), which is the behaviour we want — there is no way to accidentally
 * batch.
 *
 * A non-zero exit throws. That is the entire point of using this form (GT-5).
 */
export async function runTargetcli(executor: CommandExecutor, args: string[]): Promise<ExecResult> {
  assertNoSecretArgs(args)
  const result = await executor.exec(TARGETCLI, args)
  if (result.exitCode !== 0)
    throw new TargetcliError(args, result)
  return result
}

/** `/iscsi/<iqn>/tpg<tag>` — the configshell path of one TPG. */
export function tpgPath(iqn: string, tag: number): string {
  return `/iscsi/${iqn}/tpg${tag}`
}

/** `/backstores/<plugin>/<name>` — the configshell path of one backstore. */
export function backstorePath(plugin: string, name: string): string {
  return `/backstores/${plugin}/${name}`
}

// ---------------------------------------------------------------------------
// CHAP secrets — configfs, never argv
// ---------------------------------------------------------------------------

/** The four ACL auth value files, and nothing else, may be written. */
export const ACL_AUTH_FILES = ['userid', 'password', 'userid_mutual', 'password_mutual'] as const
export type AclAuthFile = (typeof ACL_AUTH_FILES)[number]

/**
 * LIO's sentinel for "this credential is not set".
 *
 * The kernel's node-ACL auth store treats the literal string `NULL` as a clear
 * (it drops the corresponding `NAF_*_IN_SET` flag); a zero-length write would
 * instead store an EMPTY credential and mark it as set. So clearing a CHAP
 * secret means writing `NULL`, not writing nothing.
 */
export const ACL_AUTH_NULL = 'NULL'

/**
 * The configfs path of one ACL auth value.
 *
 * Both IQNs are validated before they are spliced into a path — they arrive
 * from a request body and land in a filesystem path, so `..` or a slash would be
 * a traversal. `IscsiIqn` admits none of those characters, and the file name
 * comes from a closed list.
 */
export function aclAuthPath(
  root: string,
  targetIqn: string,
  tag: number,
  initiatorIqn: string,
  file: AclAuthFile,
): string {
  for (const iqn of [targetIqn, initiatorIqn]) {
    if (!IscsiIqn.safeParse(iqn).success)
      throw new Error(`Refusing to build a configfs path from '${iqn}': not an iSCSI name`)
  }
  if (!(ACL_AUTH_FILES as readonly string[]).includes(file))
    throw new Error(`Refusing to write configfs auth file '${file}'`)
  return join(root, 'iscsi', targetIqn, `tpgt_${tag}`, 'acls', initiatorIqn, 'auth', file)
}

/**
 * Write one ACL auth value straight into configfs.
 *
 * This is the whole reason CHAP works at all under the standing "secrets never
 * in argv" ruling: the obvious `targetcli … set auth password=X` puts the secret
 * on the command line, while this write is argv-free and is picked up by both
 * `targetcli get auth` and `saveconfig` — proven end to end (GT-35).
 *
 * The VALUE never appears in a log line, an error message or a job result.
 * Failures are re-thrown naming the FILE, never its content.
 */
export async function writeAclAuth(path: string, value: string): Promise<void> {
  try {
    await writeFile(path, value, { encoding: 'utf8' })
  }
  catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    // Deliberately naming the path and the errno only — never `value`.
    throw new Error(`Could not write the iSCSI credential file ${path} (${code})`)
  }
}

/**
 * Apply one ACL's credential fields under the value / null / omitted contract.
 *
 * - a **value** is written,
 * - **null** writes LIO's `NULL` sentinel, which clears the credential,
 * - an **omitted** field is not touched at all — which is what lets an edit
 *   dialog leave the password box blank and keep the stored secret (the mounts
 *   precedent).
 *
 * Setting `password_mutual` makes LIO flip `authenticate_target` to 1 by itself
 * (GT-32); ANAS never writes that flag.
 */
export async function applyAclCredentials(
  configfsRoot: string,
  targetIqn: string,
  tag: number,
  acl: IscsiAclRequest,
): Promise<AclAuthFile[]> {
  const pairs: [AclAuthFile, string | null | undefined][] = [
    ['userid', acl.chapUserid],
    ['password', acl.chapSecret],
    ['userid_mutual', acl.mutualUserid],
    ['password_mutual', acl.mutualSecret],
  ]
  const written: AclAuthFile[] = []
  for (const [file, value] of pairs) {
    if (value === undefined)
      continue
    const path = aclAuthPath(configfsRoot, targetIqn, tag, acl.initiatorIqn, file)
    await writeAclAuth(path, value === null ? ACL_AUTH_NULL : value)
    written.push(file)
  }
  return written
}

// ---------------------------------------------------------------------------
// Availability + the saveconfig guard
// ---------------------------------------------------------------------------

/** A refusal a route turns into a 409 with no confirm bypass. */
export interface IscsiRefusal {
  reason: string
  message: string
}

/** LIO not installed — a guiding refusal naming the packages, not a stack trace. */
export function assertInstalled(ctx: IscsiReadContext): IscsiRefusal | null {
  const availability = iscsiAvailability(ctx)
  if (availability.installed)
    return null
  return {
    reason: 'lio-not-installed',
    message: `The LIO iSCSI target stack is not present on this node, so nothing can be created: `
      + `install '${ISCSI_PACKAGES}' first. The packages enable and start the restore service themselves.`,
  }
}

/**
 * The GT-22 guard: refuse every mutation while the live config is a KNOWN
 * incomplete restore.
 *
 * Any mutation ends in `saveconfig`, and a save over a degraded restore writes
 * the truncated config over `saveconfig.json` — the LUN whose backing device was
 * missing at boot is then gone for good. So the refusal is not "the save
 * failed", it is "we will not touch this tree until the hole is healed", and it
 * NAMES the holes so the operator knows what to bring back.
 */
export function assertSaveable(ctx: IscsiReadContext, targets: IscsiTargetDetail[]): IscsiRefusal | null {
  const health = computeIscsiHealth(ctx, targets)
  if (!health.degraded)
    return null
  const missing = health.missingLuns
    .map(l => `LUN ${l.lunIndex} of ${l.targetIqn} (backstore '${l.backstoreName}', ${l.backingPath})`)
    .join('; ')
  return {
    reason: 'degraded-restore',
    message: `The live iSCSI configuration is an INCOMPLETE restore — the saved configuration has `
      + `${health.missingLuns.length} LUN${health.missingLuns.length === 1 ? '' : 's'} the kernel does not: ${missing}. `
      + `Every mutation ends in 'targetcli saveconfig', and saving now would write the hole into `
      + `/etc/rtslib-fb-target/saveconfig.json permanently. Bring the backing storage back (import the pool, `
      + `restore the image) and restart rtslib-fb-targetctl, then retry.`,
  }
}

/** Gather + build in one call — every mutation's pre-flight snapshot. */
export async function readIscsiState(
  executor: CommandExecutor,
  paths: IscsiPaths,
): Promise<{ ctx: IscsiReadContext, targets: IscsiTargetDetail[] }> {
  const ctx = await readIscsiContext(executor, paths)
  const targets = await buildIscsiTargets(ctx)
  return { ctx, targets }
}

/**
 * `targetcli saveconfig` — the last step of every successful sequence.
 *
 * ANAS adds no rotation of its own: LIO already keeps 10 rotating gzipped copies
 * under `/etc/rtslib-fb-target/backup/` on every save, capped by its own
 * `max_backup_files` (GT-9). Building a second rotator would be undifferentiated
 * code.
 */
export async function saveIscsiConfig(executor: CommandExecutor): Promise<void> {
  await runTargetcli(executor, ['saveconfig'])
}

// ---------------------------------------------------------------------------
// IQN generation
// ---------------------------------------------------------------------------

/**
 * This node's own name, as the IQN naming authority is built from.
 *
 * The WHOLE name goes in, short or fully qualified: `anasIqnAuthority` reverses
 * it and appends `anas`, so `nas` becomes `nas.anas` and `nas.example.com`
 * becomes `com.example.nas.anas`. Stripping a short hostname down to "no domain"
 * would leave the single-label authority `anas`, which rtslib refuses to create
 * — the hostname is what makes a domainless node's IQN legal at all.
 *
 * `ANAS_NODENAME` overrides it, the same way it does for the backup registry.
 */
export function iscsiNodeName(): string {
  return (process.env.ANAS_NODENAME ?? hostname()).trim().toLowerCase()
}

/** The IQN a new target gets. Immutable afterwards — LIO has no rename (GT-10). */
export function newTargetIqn(name: string, opts?: { nodeName?: string | null, date?: Date }): string {
  return anasIqn(name, {
    nodeName: opts?.nodeName !== undefined ? opts.nodeName : iscsiNodeName(),
    ...(opts?.date ? { date: opts.date } : {}),
  })
}

// ---------------------------------------------------------------------------
// Target create
// ---------------------------------------------------------------------------

/** What a create sequence needs beyond the request. */
export interface IscsiMutateOptions {
  executor: CommandExecutor
  /** configfs target root; defaults to the real one. Injectable for tests. */
  configfsRoot?: string
  /** Progress sink — the job's `updateProgress`. */
  progress?: (message: string) => void
}

function report(opts: IscsiMutateOptions, message: string): void {
  opts.progress?.(message)
}

/** The `np/` directory names a TPG currently has, from a fresh configfs read. */
async function livePortals(
  executor: CommandExecutor,
  paths: IscsiPaths,
  iqn: string,
  tag: number,
): Promise<{ address: string, port: number }[]> {
  const ctx = await readIscsiContext(executor, paths)
  const tpg = ctx.live.targets.find(t => t.iqn === iqn)?.tpgs.find(p => p.tag === tag)
  return (tpg?.portals ?? []).map(p => ({ address: p.address, port: p.port }))
}

/**
 * Create a target, end to end.
 *
 * Order is deliberate and is not the order the request lists things in:
 *
 *   1. `/iscsi create <iqn>` — makes the target AND tpg1, and (conditionally)
 *      an unrequested `0.0.0.0:3260` portal.
 *   2. Read configfs back and DELETE that wildcard portal if it is there. It is
 *      conditional — on a second target LIO skips it with "Default portal not
 *      created, TPGs within a target cannot share ip:port" (GT-8) — so this
 *      verifies rather than assumes.
 *   3. TPG attributes: `authentication` per the choice, and the three that close
 *      the doors LIO leaves open — `generate_node_acls=0` (demo mode; already
 *      the default, set explicitly so it cannot drift), `demo_mode_discovery=0`
 *      (SendTargets is open to anyone by default, GT-31) and
 *      `cache_dynamic_acls=0`.
 *   4. ACLs, then their credentials — written to configfs, never argv.
 *   5. **Portals last.** Steps 2–4 leave the target with no listener at all, so
 *      the socket only appears once the security posture is in place.
 *   6. `saveconfig`.
 *
 * Each step is its own `targetcli` process with its own checked exit code.
 */
export async function createIscsiTarget(
  opts: IscsiMutateOptions,
  req: CreateIscsiTargetRequest,
  iqn: string,
): Promise<{ iqn: string, portals: number, acls: number, removedDefaultPortal: boolean }> {
  const { executor } = opts
  const configfsRoot = opts.configfsRoot ?? CONFIGFS_TARGET_ROOT
  const paths: IscsiPaths = { configfsRoot }
  const tag = 1
  const tpg = tpgPath(iqn, tag)

  report(opts, `Creating iSCSI target ${iqn}`)
  await runTargetcli(executor, ['/iscsi', 'create', iqn])

  // GT-8: `auto_add_default_portal` may or may not have bound 0.0.0.0:3260.
  // Read the tree back rather than assuming either way.
  report(opts, 'Checking for an auto-added wildcard portal')
  const auto = await livePortals(executor, paths, iqn, tag)
  let removedDefaultPortal = false
  for (const p of auto) {
    const requested = req.portals.some(r => r.address.toLowerCase() === p.address.toLowerCase() && r.port === p.port)
    if (requested)
      continue
    report(opts, `Removing the auto-added portal ${p.address}:${p.port}`)
    await runTargetcli(executor, [`${tpg}/portals`, 'delete', p.address, String(p.port)])
    removedDefaultPortal = true
  }

  report(opts, 'Setting TPG attributes')
  for (const token of tpgAttributeTokens(req.auth))
    await runTargetcli(executor, [tpg, 'set', 'attribute', token])

  for (const acl of req.acls) {
    report(opts, `Adding initiator ${acl.initiatorIqn}`)
    await runTargetcli(executor, [`${tpg}/acls`, 'create', acl.initiatorIqn])
    // The secret goes straight to configfs — never argv, never logged (GT-35).
    const written = await applyAclCredentials(configfsRoot, iqn, tag, acl)
    if (written.length > 0)
      report(opts, `Writing credentials for ${acl.initiatorIqn}`)
  }

  for (const portal of req.portals) {
    report(opts, `Creating portal ${portal.address}:${portal.port}`)
    await runTargetcli(executor, [`${tpg}/portals`, 'create', portal.address, String(portal.port)])
  }

  report(opts, 'Saving the LIO configuration')
  await saveIscsiConfig(executor)

  return { iqn, portals: req.portals.length, acls: req.acls.length, removedDefaultPortal }
}

/**
 * The TPG attributes ANAS sets, in order.
 *
 * `generate_node_acls=0` is already LIO's default (GT-31) and is set anyway: the
 * one setting that would let ANY initiator in is not something to leave to a
 * default that a future package could change. `demo_mode_discovery=0` is a real
 * change — SendTargets discovery is open by default, and a non-ACLed initiator
 * successfully enumerated the target IQN and every portal before being refused
 * at login (GT-31).
 */
export function tpgAttributeTokens(auth: IscsiAuthMode): string[] {
  return [
    `authentication=${auth === 'none' ? 0 : 1}`,
    'generate_node_acls=0',
    'demo_mode_discovery=0',
    'cache_dynamic_acls=0',
  ]
}

// ---------------------------------------------------------------------------
// Target edit
// ---------------------------------------------------------------------------

/** Compare two portals the way LIO does: address case-insensitively, port exactly. */
function portalKey(address: string, port: number): string {
  return `${address.toLowerCase()}:${port}`
}

/**
 * Edit a target: portals, ACLs, auth, secret rotation.
 *
 * A present collection is the COMPLETE desired set and is diffed against the
 * live one, so an untouched edit issues no commands at all. That matters more
 * for ACLs than it looks: deleting an ACL drops its session instantly and
 * silently AND destroys its CHAP credentials (GT-36), so "rewrite them all" is
 * not a harmless way to apply a change.
 */
export async function updateIscsiTarget(
  opts: IscsiMutateOptions,
  target: IscsiTargetDetail,
  req: UpdateIscsiTargetRequest,
): Promise<{ iqn: string, portalsAdded: number, portalsRemoved: number, aclsAdded: number, aclsRemoved: number, credentialsUpdated: number, authChanged: boolean }> {
  const { executor } = opts
  const configfsRoot = opts.configfsRoot ?? CONFIGFS_TARGET_ROOT
  const iqn = target.iqn
  const tag = target.tpgTag
  const tpg = tpgPath(iqn, tag)

  let authChanged = false
  if (req.auth !== undefined) {
    const wanted = req.auth !== 'none'
    if (wanted !== target.security.authentication) {
      report(opts, `Setting CHAP ${wanted ? 'on' : 'off'}`)
      await runTargetcli(executor, [tpg, 'set', 'attribute', `authentication=${wanted ? 1 : 0}`])
      authChanged = true
    }
  }

  let portalsAdded = 0
  let portalsRemoved = 0
  if (req.portals !== undefined) {
    const wanted = new Map(req.portals.map(p => [portalKey(p.address, p.port), p]))
    const have = new Map(target.portals.map(p => [portalKey(p.address, p.port), p]))
    for (const [key, p] of have) {
      if (wanted.has(key))
        continue
      report(opts, `Removing portal ${p.address}:${p.port}`)
      await runTargetcli(executor, [`${tpg}/portals`, 'delete', p.address, String(p.port)])
      portalsRemoved++
    }
    for (const [key, p] of wanted) {
      if (have.has(key))
        continue
      report(opts, `Creating portal ${p.address}:${p.port}`)
      await runTargetcli(executor, [`${tpg}/portals`, 'create', p.address, String(p.port)])
      portalsAdded++
    }
  }

  let aclsAdded = 0
  let aclsRemoved = 0
  let credentialsUpdated = 0
  if (req.acls !== undefined) {
    const wanted = new Map(req.acls.map(a => [a.initiatorIqn, a]))
    const have = new Map(target.acls.map(a => [a.initiatorIqn, a]))
    for (const initiator of have.keys()) {
      if (wanted.has(initiator))
        continue
      report(opts, `Removing initiator ${initiator}`)
      await runTargetcli(executor, [`${tpg}/acls`, 'delete', initiator])
      aclsRemoved++
    }
    for (const [initiator, acl] of wanted) {
      if (!have.has(initiator)) {
        report(opts, `Adding initiator ${initiator}`)
        await runTargetcli(executor, [`${tpg}/acls`, 'create', initiator])
        aclsAdded++
        // Every LUN already in the TPG has to reach a brand-new ACL. targetcli's
        // `auto_add_mapped_luns` preference usually does this, but it is a
        // preference in /root/.targetcli/prefs.bin (GT-7) — verified, not assumed.
        await grantLunsToAcl(opts, iqn, tag, initiator, target.luns.map(l => l.index))
      }
      const written = await applyAclCredentials(configfsRoot, iqn, tag, acl)
      if (written.length > 0) {
        report(opts, `Updating credentials for ${initiator}`)
        credentialsUpdated++
      }
    }
  }

  report(opts, 'Saving the LIO configuration')
  await saveIscsiConfig(executor)

  return { iqn, portalsAdded, portalsRemoved, aclsAdded, aclsRemoved, credentialsUpdated, authChanged }
}

/**
 * Map a set of TPG LUNs into one ACL, skipping the ones already there.
 *
 * The mapped-LUN index is deliberately the SAME number as the TPG LUN index:
 * an initiator that sees `LUN 3` and an operator reading `LUN 3` in the UI must
 * be talking about the same disk.
 */
async function grantLunsToAcl(
  opts: IscsiMutateOptions,
  iqn: string,
  tag: number,
  initiatorIqn: string,
  lunIndexes: number[],
  alreadyMapped: number[] = [],
): Promise<number> {
  const have = new Set(alreadyMapped)
  let granted = 0
  for (const index of lunIndexes) {
    if (have.has(index))
      continue
    report(opts, `Granting LUN ${index} to ${initiatorIqn}`)
    await runTargetcli(opts.executor, [
      `${tpgPath(iqn, tag)}/acls/${initiatorIqn}`,
      'create',
      String(index),
      String(index),
    ])
    granted++
  }
  return granted
}

// ---------------------------------------------------------------------------
// Target state + delete
// ---------------------------------------------------------------------------

/**
 * Flip the TPG `enable` flag.
 *
 * `disable` refuses new logins and makes discovery return nothing, but the
 * portal socket stays open and an established session keeps running (GT-37) —
 * which is why this is not a substitute for deleting a target.
 */
export async function setIscsiTargetState(
  opts: IscsiMutateOptions,
  target: IscsiTargetDetail,
  action: 'enable' | 'disable',
): Promise<{ iqn: string, enabled: boolean }> {
  report(opts, `${action === 'enable' ? 'Enabling' : 'Disabling'} ${target.iqn}`)
  await runTargetcli(opts.executor, [tpgPath(target.iqn, target.tpgTag), action])
  report(opts, 'Saving the LIO configuration')
  await saveIscsiConfig(opts.executor)
  return { iqn: target.iqn, enabled: action === 'enable' }
}

/**
 * Delete a target and the backstores only it referenced.
 *
 * The BACKING objects — the zvol, the image file — are never touched here; that
 * is what `?destroyBacking=true` on a LUN delete is for. The LIO backstores are,
 * because an orphaned backstore keeps holding its zvol open with nothing in the
 * UI to explain it: `zfs destroy` would fail `dataset is busy` while `fuser`,
 * `lsof` and `holders/` all report nothing (GT-40/GT-41). A backstore still
 * mapped into ANOTHER target is left alone.
 */
export async function deleteIscsiTarget(
  opts: IscsiMutateOptions,
  target: IscsiTargetDetail,
  allTargets: IscsiTargetDetail[],
): Promise<{ iqn: string, backstoresDeleted: string[], backingKept: string[] }> {
  const { executor } = opts

  const sharedNames = new Set<string>()
  for (const other of allTargets) {
    if (other.iqn === target.iqn)
      continue
    for (const lun of other.luns)
      sharedNames.add(lun.name)
  }

  report(opts, `Deleting iSCSI target ${target.iqn}`)
  await runTargetcli(executor, ['/iscsi', 'delete', target.iqn])

  const backstoresDeleted: string[] = []
  const backingKept: string[] = []
  for (const lun of target.luns) {
    if (!lun.name || sharedNames.has(lun.name))
      continue
    report(opts, `Deleting backstore ${lun.name}`)
    await runTargetcli(executor, [`/backstores/${lun.plugin}`, 'delete', lun.name])
    backstoresDeleted.push(lun.name)
    if (lun.backingPath)
      backingKept.push(lun.backingPath)
  }

  report(opts, 'Saving the LIO configuration')
  await saveIscsiConfig(executor)
  return { iqn: target.iqn, backstoresDeleted, backingKept }
}

// ---------------------------------------------------------------------------
// LUN backing resolution
// ---------------------------------------------------------------------------

/** A resolved backing object for a new LUN. */
export interface ResolvedBacking {
  /** The path LIO will store — `/dev/zvol/<pool>/<vol>` or the image file. */
  path: string
  /** LIO backstore plugin. */
  plugin: 'block' | 'fileio'
  /** The ZFS dataset behind it (the zvol, or the image's dataset). */
  dataset?: string
  pool?: string
}

/** A refusal to use a backing object, with the reason spelled out. */
export interface BackingRefusal {
  reason: string
  message: string
}

/**
 * `/dev/zvol/<pool>/<vol>` from a dataset name, or an absolute path unchanged.
 *
 * An ABSOLUTE path is never prefixed: `/dev/sdb` must stay `/dev/sdb` so that
 * `classifyBacking` can call it what it is (a raw block device, not a zvol)
 * rather than being handed the nonsense path `/dev/zvol//dev/sdb`, which would
 * pattern-match as a zvol and sail through the ownership check.
 */
export function zvolDevicePath(backing: string): string {
  return backing.startsWith('/') ? backing : `/dev/zvol/${backing}`
}

/** The dataset name behind a zvol device path. */
export function zvolDataset(devPath: string): string {
  return devPath.startsWith('/dev/zvol/') ? devPath.slice('/dev/zvol/'.length) : devPath
}

/**
 * Resolve a `zvol` backing request onto a device path, refusing everything that
 * is not an ANAS-managed volume.
 *
 * `classifyBacking` is `iscsi.2`'s, reused rather than reimplemented: a PVE
 * guest volume (`vm-101-disk-0`, `base-…`, `subvol-…`), a zvol on a PVE-managed
 * pool and anything that resolves onto storage ANAS does not manage are all
 * already decidable from `storage.cfg` plus the ZFS mountpoint list, and the
 * ownership badge in the grid comes from the same call.
 */
export function resolveZvolBacking(
  backing: string,
  ctx: IscsiReadContext,
): { ok: ResolvedBacking } | { refusal: BackingRefusal } {
  const path = zvolDevicePath(backing)
  const c = classifyBacking(path, ctx.inputs)
  if (c.kind !== 'zvol') {
    return {
      refusal: {
        reason: 'not-a-zvol',
        message: `'${backing}' does not name a ZFS volume — a zvol LUN is backed by /dev/zvol/<pool>/<volume>`,
      },
    }
  }
  if (c.pveGuestVolume) {
    return {
      refusal: {
        reason: 'pve-guest-volume',
        message: `'${c.dataset ?? backing}' is a PVE guest volume — PVE's territory is read-only and hands-off, and its disks are never ANAS's to export`,
      },
    }
  }
  if (c.pveManaged) {
    const names = (c.pool ? ctx.inputs.pveStorages.get(c.pool) ?? [] : []).map(r => r.storage).join(', ')
    return {
      refusal: {
        reason: 'pve-managed-pool',
        message: `'${c.dataset ?? backing}' is on pool '${c.pool}', which PVE manages${names ? ` (${names})` : ''} — hands-off`,
      },
    }
  }
  const resolved: ResolvedBacking = { path, plugin: 'block' }
  if (c.dataset)
    resolved.dataset = c.dataset
  if (c.pool)
    resolved.pool = c.pool
  return { ok: resolved }
}

/**
 * Resolve a `file` backing request onto the DIRECTORY the image will live in.
 *
 * `backing` may be a ZFS dataset (`tank/images`), an AHR pool name, or an
 * absolute directory. AHR is not an afterthought here: a file on the btrfs
 * volume IS the AHR block object, the parallel of a zvol on ZFS, and it is
 * AHR's only kind.
 */
export async function resolveFileBackingDir(
  executor: CommandExecutor,
  backing: string,
  ctx: IscsiReadContext,
): Promise<{ ok: { dir: string, dataset?: string, pool?: string } } | { refusal: BackingRefusal }> {
  if (backing.startsWith('/')) {
    const c = classifyBacking(backing, ctx.inputs)
    if (c.kind === 'foreign') {
      const ahr = await ahrMountpointFor(executor, backing)
      if (ahr)
        return { ok: { dir: backing, pool: ahr } }
      return {
        refusal: {
          reason: 'backing-not-anas-storage',
          message: `'${backing}' is not on storage ANAS manages — an image LUN lives on a ZFS dataset or an AHR pool`,
        },
      }
    }
    if (c.pveManaged) {
      return {
        refusal: {
          reason: 'pve-managed-pool',
          message: `'${backing}' is on pool '${c.pool}', which PVE manages — hands-off`,
        },
      }
    }
    const ok: { dir: string, dataset?: string, pool?: string } = { dir: backing }
    if (c.dataset)
      ok.dataset = c.dataset
    if (c.pool)
      ok.pool = c.pool
    return { ok }
  }

  // A ZFS dataset name: its mountpoint is the directory.
  const mp = ctx.inputs.zfsMountpoints.find(m => m.dataset === backing)
  if (mp) {
    if ((ctx.inputs.pveStorages.get(mp.pool)?.length ?? 0) > 0) {
      return {
        refusal: {
          reason: 'pve-managed-pool',
          message: `Dataset '${backing}' is on pool '${mp.pool}', which PVE manages — hands-off`,
        },
      }
    }
    return { ok: { dir: mp.mountpoint, dataset: mp.dataset, pool: mp.pool } }
  }

  // An AHR pool name.
  const ahrDir = await ahrMountpointByName(executor, backing)
  if (ahrDir)
    return { ok: { dir: ahrDir, pool: backing } }

  return {
    refusal: {
      reason: 'backing-not-found',
      message: `'${backing}' is neither a mounted ZFS dataset nor an AHR pool on this node`,
    },
  }
}

/** The AHR pool whose mountpoint contains `path`, or null. */
async function ahrMountpointFor(executor: CommandExecutor, path: string): Promise<string | null> {
  try {
    for (const pool of await readAhrPools(executor)) {
      if (!pool.mountpoint)
        continue
      if (path === pool.mountpoint || path.startsWith(`${pool.mountpoint}/`))
        return pool.name
    }
  }
  catch {
    // Fail-open: without AHR topology a file on an AHR pool simply reads as
    // unknown storage, which is a refusal with a reason, not a broken screen.
  }
  return null
}

/** The mountpoint of the AHR pool named `name`, or null. */
async function ahrMountpointByName(executor: CommandExecutor, name: string): Promise<string | null> {
  try {
    const pool = (await readAhrPools(executor)).find(p => p.name === name)
    return pool?.mountpoint || null
  }
  catch {
    return null
  }
}

/** The image file a `file` LUN gets: `<dir>/<name>.raw`. */
export function imageFilePath(dir: string, name: string): string {
  return join(dir, `${name}.raw`)
}

/**
 * Create the sparse raw image, NEVER overwriting an existing file.
 *
 * `wx` fails with EEXIST rather than truncating, which matters more here than
 * usual: the file IS the LUN's data, and `size=` is ignored by LIO when the file
 * already exists (GT-29), so a silent overwrite would destroy a disk and then
 * present it at the wrong size.
 */
export async function createSparseImage(path: string, size: number): Promise<void> {
  let fh
  try {
    fh = await open(path, 'wx', 0o600)
  }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`'${path}' already exists — refusing to overwrite it; pick another LUN name`)
    throw err
  }
  try {
    await fh.truncate(size)
  }
  finally {
    await fh.close()
  }
}

/** Grow an existing image file. Never shrinks — the caller has already refused that. */
export async function growImageFile(path: string, size: number): Promise<void> {
  const fh = await open(path, 'r+')
  try {
    await fh.truncate(size)
  }
  finally {
    await fh.close()
  }
}

// ---------------------------------------------------------------------------
// LUN add
// ---------------------------------------------------------------------------

/** The LUN index a new LUN takes: the lowest free one in the TPG. */
export function nextLunIndex(target: IscsiTargetDetail): number {
  const used = new Set(target.luns.map(l => l.index))
  let n = 0
  while (used.has(n))
    n++
  return n
}

/**
 * Create a backstore and map it as a LUN.
 *
 * The order is the contract, not a preference:
 *
 *   create backstore (with `wwn=`) → set EVERY attribute → map → grant to ACLs
 *
 * `wwn=` is create-only, has no `set` verb and no format validation at all
 * (GT-16), so it is generated here and passed at create; everything an initiator
 * identifies the disk by — the unit serial, the NAA WWN, both `/dev/disk/by-id`
 * links and any PVE volid built on them (GT-14/GT-45) — follows from it.
 * `block_size` has to precede the mapping because it stops being settable the
 * moment the backstore is activated (GT-27), and the rest of the attributes ride
 * along in the same window so the recreate path has exactly one list to replay.
 */
export async function addIscsiLun(
  opts: IscsiMutateOptions,
  target: IscsiTargetDetail,
  req: AddIscsiLunRequest,
  backing: ResolvedBacking,
  size: number | null,
  serial: string,
): Promise<{ index: number, name: string, serial: string, backingPath: string, attributes: IscsiBackstoreAttributes }> {
  const { executor } = opts
  const tag = target.tpgTag
  const index = nextLunIndex(target)
  const attrs = defaultBackstoreAttributes(backing.plugin, req.blockSize !== undefined ? { blockSize: req.blockSize } : {})
  const store = backstorePath(backing.plugin, req.name)

  report(opts, `Creating ${backing.plugin} backstore ${req.name}`)
  if (backing.plugin === 'block') {
    await runTargetcli(executor, [
      '/backstores/block',
      'create',
      `name=${req.name}`,
      `dev=${backing.path}`,
      `wwn=${serial}`,
    ])
  }
  else {
    await runTargetcli(executor, [
      '/backstores/fileio',
      'create',
      `name=${req.name}`,
      `file_or_dev=${backing.path}`,
      `size=${size ?? 0}`,
      `write_back=${ISCSI_DEFAULT_WRITE_BACK}`,
      `wwn=${serial}`,
    ])
  }

  // BEFORE the map — block_size is refused on an activated backstore (GT-27).
  for (const token of attributeTokens(attrs)) {
    report(opts, `Setting ${token} on ${req.name}`)
    await runTargetcli(executor, [store, 'set', 'attribute', token])
  }

  report(opts, `Mapping ${req.name} as LUN ${index}`)
  await runTargetcli(executor, [`${tpgPath(target.iqn, tag)}/luns`, 'create', `storage_object=${store}`, `lun=${index}`])

  for (const acl of target.acls)
    await grantLunsToAcl(opts, target.iqn, tag, acl.initiatorIqn, [index], acl.mappedLuns)

  report(opts, 'Saving the LIO configuration')
  await saveIscsiConfig(executor)

  return { index, name: req.name, serial, backingPath: backing.path, attributes: attrs }
}

/** A fresh unit serial. LIO's own convention is a UUID (GT-16); ANAS keeps it. */
export function newSerial(): string {
  return randomUUID()
}

// ---------------------------------------------------------------------------
// LUN resize / attribute change
// ---------------------------------------------------------------------------

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

/**
 * Grow a zvol-backed LUN: `zfs set volsize=`, and nothing on the LIO side.
 *
 * A zvol grow is live end to end — `targetcli ls` and configfs report the new
 * size immediately and the initiator picks it up on a rescan (GT-28). There is
 * no backstore to touch, so the serial and the attributes are never at risk.
 */
export async function growZvolLun(
  opts: IscsiMutateOptions,
  dataset: string,
  size: number,
): Promise<void> {
  report(opts, `Growing volume ${dataset} to ${size} bytes`)
  const r = await opts.executor.exec(ZFS, ['set', `volsize=${size}`, dataset])
  if (r.exitCode !== 0)
    throw new Error(r.stderr.trim() || `zfs set volsize=${size} ${dataset} exited with code ${r.exitCode}`)
}

/**
 * Resize a fileio-backed LUN — the replay path, in full.
 *
 * A fileio backstore's size is FIXED at creation: `truncate` on the backing file
 * changes nothing LIO reports, and there is no resize command in the fileio
 * backstore's command set (GT-29). The only path is delete + recreate, and a
 * naive one changes the disk's identity: without `wwn=` the initiator gets a new
 * serial, a new NAA and new `/dev/disk/by-id` links — a DIFFERENT disk as far as
 * Windows, ESXi and every PVE volid are concerned (GT-17/GT-45) — and the
 * attributes come back at stock defaults (GT-18).
 *
 * So the sequence replays both, and re-maps at the SAME LUN index:
 *
 *   unmap → delete backstore → grow the file → create with the SAME `wwn=` →
 *   replay every attribute → map at the same index → re-grant to every ACL
 */
export async function resizeFileLun(
  opts: IscsiMutateOptions,
  target: IscsiTargetDetail,
  lun: { index: number, name: string, backingPath: string, serial: string | null, attributes: IscsiBackstoreAttributes },
  size: number,
): Promise<void> {
  const { executor } = opts
  const tag = target.tpgTag
  const tpg = tpgPath(target.iqn, tag)
  const store = backstorePath('fileio', lun.name)

  report(opts, `Unmapping LUN ${lun.index}`)
  await runTargetcli(executor, [`${tpg}/luns`, 'delete', `lun${lun.index}`])

  report(opts, `Deleting backstore ${lun.name}`)
  await runTargetcli(executor, ['/backstores/fileio', 'delete', lun.name])

  report(opts, `Growing ${lun.backingPath} to ${size} bytes`)
  await growImageFile(lun.backingPath, size)

  report(opts, `Recreating backstore ${lun.name} with its original serial`)
  const createArgs = [
    '/backstores/fileio',
    'create',
    `name=${lun.name}`,
    `file_or_dev=${lun.backingPath}`,
    `size=${size}`,
    `write_back=${lun.attributes.writeBack}`,
  ]
  // A LUN with no readable serial is the one case where identity cannot be
  // replayed; it is recreated without `wwn=` and the job result says so rather
  // than pretending the disk came back the same.
  if (lun.serial)
    createArgs.push(`wwn=${lun.serial}`)
  await runTargetcli(executor, createArgs)

  for (const token of attributeTokens(lun.attributes)) {
    report(opts, `Replaying ${token} on ${lun.name}`)
    await runTargetcli(executor, [store, 'set', 'attribute', token])
  }

  report(opts, `Re-mapping ${lun.name} as LUN ${lun.index}`)
  await runTargetcli(executor, [`${tpg}/luns`, 'create', `storage_object=${store}`, `lun=${lun.index}`])

  for (const acl of target.acls)
    await grantLunsToAcl(opts, target.iqn, tag, acl.initiatorIqn, [lun.index])
}

/** Change `emulate_write_cache` on a mapped backstore (no recreate needed). */
export async function setLunWriteBack(
  opts: IscsiMutateOptions,
  plugin: string,
  name: string,
  writeBack: boolean,
): Promise<void> {
  report(opts, `Setting emulate_write_cache=${writeBack ? 1 : 0} on ${name}`)
  await runTargetcli(opts.executor, [
    backstorePath(plugin, name),
    'set',
    'attribute',
    `emulate_write_cache=${writeBack ? 1 : 0}`,
  ])
}

// ---------------------------------------------------------------------------
// LUN delete
// ---------------------------------------------------------------------------

/**
 * Unmap a LUN, delete its backstore, and — only behind the confirm gate —
 * destroy the object underneath.
 *
 * The two halves are genuinely different operations. Unmapping and deleting the
 * backstore is reversible: the zvol or image still holds the data and can be
 * exported again with the same serial. Destroying the backing object is not.
 */
export async function deleteIscsiLun(
  opts: IscsiMutateOptions,
  target: IscsiTargetDetail,
  lun: { index: number, name: string, plugin: string, kind: string, backingPath: string, dataset?: string },
  destroyBacking: boolean,
): Promise<{ index: number, backstoreDeleted: string, backingDestroyed: string | null }> {
  const { executor } = opts
  const tpg = tpgPath(target.iqn, target.tpgTag)

  report(opts, `Unmapping LUN ${lun.index}`)
  await runTargetcli(executor, [`${tpg}/luns`, 'delete', `lun${lun.index}`])

  report(opts, `Deleting backstore ${lun.name}`)
  await runTargetcli(executor, [`/backstores/${lun.plugin}`, 'delete', lun.name])

  let backingDestroyed: string | null = null
  if (destroyBacking) {
    if (lun.kind === 'zvol') {
      const dataset = lun.dataset ?? zvolDataset(lun.backingPath)
      report(opts, `Destroying volume ${dataset}`)
      const r = await executor.exec(ZFS, ['destroy', dataset])
      if (r.exitCode !== 0)
        throw new Error(r.stderr.trim() || `zfs destroy ${dataset} exited with code ${r.exitCode}`)
      backingDestroyed = dataset
    }
    else if (lun.kind === 'file') {
      report(opts, `Removing image file ${lun.backingPath}`)
      await unlink(lun.backingPath)
      backingDestroyed = lun.backingPath
    }
  }

  report(opts, 'Saving the LIO configuration')
  await saveIscsiConfig(executor)
  return { index: lun.index, backstoreDeleted: lun.name, backingDestroyed }
}

// ---------------------------------------------------------------------------
// The cross-feature seam (story iscsi.6)
// ---------------------------------------------------------------------------

/**
 * Every backing object currently mapped into a LUN on this node.
 *
 * The ONE call Pools, Datasets, AHR and Mounts make before they destroy, rename,
 * roll back, shrink or unmount anything. It exists because nothing else in
 * userspace can answer the question: `fuser`, `lsof` and a device's sysfs
 * `holders/` all report nothing for a device LIO is serving (GT-41), and ZFS
 * itself refuses only `destroy` and `export` — `rollback`, `rename`, a `volsize`
 * shrink and an `rm` of a backing image all succeed SILENTLY under a live
 * session (GT-40).
 *
 * `iscsi.6` turns these into refusals; `iscsi.4` only has to make sure there is
 * exactly one place to ask.
 */
export function claimsFromTargets(targets: IscsiTargetDetail[]): IscsiClaim[] {
  const claims: IscsiClaim[] = []
  for (const target of targets) {
    for (const lun of target.luns) {
      if (!lun.backingPath)
        continue
      const claim: IscsiClaim = {
        backingPath: lun.backingPath,
        kind: lun.kind,
        targetIqn: target.iqn,
        tpgTag: target.tpgTag,
        lunIndex: lun.index,
        backstoreName: lun.name,
        connectedInitiators: lun.connectedInitiators,
        detail: `held by LUN ${lun.index} of iSCSI target ${target.iqn} (backstore '${lun.name}', ${lun.backingPath})${
          lun.connectedInitiators.length > 0
            ? ` with ${lun.connectedInitiators.length} live session${lun.connectedInitiators.length === 1 ? '' : 's'}`
            : ''}`,
      }
      if (lun.pool !== undefined)
        claim.pool = lun.pool
      if (lun.dataset !== undefined)
        claim.dataset = lun.dataset
      claims.push(claim)
    }
  }
  return claims
}

/** `claimsFromTargets` with the read done for you — the seam's public form. */
export async function iscsiClaims(
  executor: CommandExecutor,
  paths: IscsiPaths = {},
): Promise<{ installed: boolean, claims: IscsiClaim[] }> {
  const { ctx, targets } = await readIscsiState(executor, paths)
  return { installed: iscsiAvailability(ctx).installed, claims: claimsFromTargets(targets) }
}
