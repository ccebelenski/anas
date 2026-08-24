import type {
  CreateMountRequest,
  DashboardWarning,
  MountCapacity,
  MountDetail,
  MountEntry,
  MountOptions,
  MountRequestOptions,
  MountState,
  MountSummary,
  MountTestRequest,
  MountTestResult,
  MountTestVerdict,
  MountType,
  MountUnit,
} from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import { lookup } from 'node:dns/promises'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MountCifsSec, MountNfsSec } from '@anas/shared'
import { classifyKind, isIgnoredMount, optionsReadOnly, parseFindmnt } from '../parsers/findmnt.js'
import { getMount, inlineCommentIndex, parseFstab } from '../parsers/fstab.js'
import { getArrays, parseMdadmConfDoc } from '../parsers/mdadm-conf.js'
import { matchAhrArrayName } from '../parsers/mdadm-detail.js'
import { readPveMountPaths } from '../parsers/pve-storage.js'
import { ahrLvPath } from './ahr-paths.js'
import { readConfig } from './config-writer.js'

/** `timeout` binary — wraps the probe so a dead NFS server can never hang us. */
const TIMEOUT = '/usr/bin/timeout'
/** `stat -f` in a child, guarded by timeout — THE hang-safe liveness probe. */
const STAT = 'stat'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const FINDMNT = '/usr/bin/findmnt'
const SYSTEMD_ESCAPE = '/usr/bin/systemd-escape'
const SYSTEMCTL = '/usr/bin/systemctl'

/** Default credentials directory (per-mount 0600 root-only files, 18.5). */
export const DEFAULT_CREDS_DIR = '/etc/anas/creds'

const PORT_NFS = 2049
const PORT_CIFS = 445

/** ESTALE marker in `stat` stderr. */
const STALE_RE = /stale file handle/i
/** Whitespace splitter (stat capacity fields / fstab fields). */
const WHITESPACE_RE = /\s+/
/** `mount error(N)` errno extractor (mount.cifs). */
const MOUNT_ERRNO_RE = /mount error\((\d+)\)/
/** Leading slashes on a mountpoint (creds-filename derivation). */
const LEADING_SLASHES_RE = /^\/+/
/** Path separators (creds-filename derivation). */
const SLASH_RE = /\//g
/** Non-filename-safe characters (creds-filename derivation). */
const UNSAFE_CHARS_RE = /[^\w.-]/g
/** `/dev/md/` prefix on an mdadm ARRAY device path (AHR pin → pool derivation). */
const DEV_MD_PREFIX_RE = /^\/dev\/md\//

/** Is this kind a remote (network) filesystem? */
export function isRemoteKind(kind: string): boolean {
  return kind === 'nfs' || kind === 'cifs'
}

// ============================================================================
// Inventory (GET /v1/mounts)
// ============================================================================

/**
 * Merge findmnt (actual) with /etc/fstab (configured) and the read-only PVE
 * storage.cfg parse (hands-off tags) into inventory rows — PURE (no probes).
 * `state` is provisional: 'armed' for an automount placeholder, 'unmounted' for
 * a configured-but-absent mount, and 'unknown' for a live mount awaiting the
 * guarded `stat -f` probe. Pseudo-filesystems are filtered out.
 */
export function buildBaseInventory(
  findmntText: string,
  fstabText: string,
  pveMountPaths: Map<string, string>,
  ahrSpecs: Set<string> = new Set(),
): MountSummary[] {
  const nodes = parseFindmnt(findmntText).filter(n => !isIgnoredMount(n.fstype, n.target))
  const entries = parseFstab(fstabText)
  const entryByMount = new Map(entries.map(e => [e.mountpoint, e]))

  const byTarget = new Map<string, MountSummary>()
  for (const node of nodes) {
    const isAutofs = node.fstype === 'autofs'
    const existing = byTarget.get(node.target)
    if (existing) {
      // A real fs stacked on an existing autofs placeholder: prefer the real fs.
      if (!isAutofs) {
        existing.source = node.source
        existing.fstype = node.fstype
        existing.type = classifyKind(node.fstype, node.source)
        existing.remote = isRemoteKind(existing.type)
        existing.mounted = true
        existing.readOnly = optionsReadOnly(node.options)
        existing.state = 'unknown'
      }
      continue
    }
    const kind = classifyKind(node.fstype, node.source)
    byTarget.set(node.target, {
      mountpoint: node.target,
      source: node.source,
      type: kind,
      fstype: node.fstype,
      state: isAutofs ? 'armed' : 'unknown',
      mounted: !isAutofs,
      persistent: false,
      remote: isRemoteKind(kind),
      automount: isAutofs,
      disabled: false,
      pveManaged: false,
      ahrManaged: false,
      readOnly: optionsReadOnly(node.options),
    })
  }

  // Overlay fstab: mark persistent / automount / disabled, add unmounted rows.
  for (const entry of entries) {
    // Same ignore filter as the active-mount path above (shared predicate): an
    // fstab `proc`/`sys`/`swap`/`tmpfs` line is OS plumbing, not a user mount —
    // without this it reappears here as a ghost unmounted row + dashboard warning.
    if (isIgnoredMount(entry.fstype, entry.mountpoint))
      continue
    const row = byTarget.get(entry.mountpoint)
    if (row) {
      row.persistent = true
      row.automount = row.automount || entry.options.common.automount
      // An ARMED automount is a PLACEHOLDER, not an identity (issue #35). The
      // live autofs record says `systemd-1` / `autofs` / not-remote, which is
      // true of the placeholder and false of the mount: an idled-out CIFS share
      // arrived in the UI as local storage and lost Edit/Unmount/Remove with it.
      // The fstab entry IS the identity here — the only thing the placeholder
      // gets to say is the STATE ('armed', set above and left untouched).
      if (row.state === 'armed') {
        const kind = classifyKind(entry.fstype, entry.spec)
        row.source = entry.spec
        row.fstype = entry.fstype
        row.type = kind
        row.remote = isRemoteKind(kind)
        row.readOnly = entry.options.common.readOnly
      }
      if (entry.disabled) {
        row.disabled = true
        row.state = 'disabled'
      }
    }
    else {
      const kind = classifyKind(entry.fstype, entry.spec)
      byTarget.set(entry.mountpoint, {
        mountpoint: entry.mountpoint,
        source: entry.spec,
        type: kind,
        fstype: entry.fstype,
        state: entry.disabled ? 'disabled' : 'unmounted',
        mounted: false,
        persistent: true,
        remote: isRemoteKind(kind),
        automount: entry.options.common.automount,
        disabled: entry.disabled ?? false,
        pveManaged: false,
        ahrManaged: false,
        readOnly: entry.options.common.readOnly,
      })
    }
  }

  // Tag PVE-owned mounts hands-off.
  for (const row of byTarget.values()) {
    const pve = pveStorageFor(row.mountpoint, pveMountPaths)
    if (pve) {
      row.pveManaged = true
      row.pveStorage = pve
    }
    const entry = entryByMount.get(row.mountpoint)
    // Tag AHR pool persistence hands-off — match on the LV SPEC (never the
    // mountpoint, which is operator-configurable). The fstab entry spec is the
    // reliable identity; a mounted pool's findmnt `source` is the /dev/mapper
    // name, so consult the configured spec too.
    if (ahrSpecs.size > 0 && (ahrSpecs.has(row.source) || (entry && ahrSpecs.has(entry.spec))))
      row.ahrManaged = true
    // Reflect fstab automount even where findmnt shows a plain nfs4 (already
    // handled), and keep automount truthful for configured rows.
    if (entry)
      row.automount = row.automount || entry.options.common.automount
    // Parse the spec back into server + remotePath for the remote kinds (nfs/cifs)
    // — the edit dialog round-trips these. Prefer the configured fstab spec (the
    // canonical identity); fall back to the findmnt source for a session mount.
    if (isRemoteKind(row.type)) {
      const { server, remotePath } = parseSpec(row.type, entry ? entry.spec : row.source)
      if (server !== undefined)
        row.server = server
      if (remotePath !== undefined)
        row.remotePath = remotePath
    }
  }

  const rows = [...byTarget.values()]
  rows.sort((a, b) => a.mountpoint.localeCompare(b.mountpoint))
  return rows
}

/**
 * The set of AHR pool LV specs pinned in the ANAS-managed mdadm.conf — the
 * ownership marker mirrored from AHR (§2.6, config-is-the-API). Each ANAS ARRAY
 * pin names a band `<pool>-r<band>`; the pool's fstab entry references the LV
 * spec `/dev/<pool>/<pool>-vol`. The Mounts feature matches on this spec (never
 * the mountpoint) so a pool's persistence stays hands-off even after a custom
 * mountpoint move. Reuses the round-trip mdadm-conf parser AHR writes with;
 * fail-open (an unreadable/empty conf → no pins → no AHR rows flagged, which
 * only ever makes Mounts LESS restrictive, never wrongly seizes a foreign LV).
 */
export function ahrPinnedSpecs(mdadmConfText: string): Set<string> {
  const specs = new Set<string>()
  for (const array of getArrays(parseMdadmConfDoc(mdadmConfText))) {
    // ANAS writes no `name=` token, so derive the pool from the device basename;
    // matchAhrArrayName tolerates a homehost prefix and rejects foreign arrays.
    const bandName = array.name ?? array.device.replace(DEV_MD_PREFIX_RE, '')
    const named = matchAhrArrayName(bandName)
    if (named)
      specs.add(ahrLvPath(named.pool))
  }
  return specs
}

/** Read the ANAS-managed mdadm.conf for AHR pin derivation; '' on any failure. */
export async function readMdadmConfText(path: string): Promise<string> {
  try {
    return await readConfig(path)
  }
  catch {
    return ''
  }
}

/** The PVE storage id owning `mountpoint`, or undefined (NOTES §3 tagging). */
export function pveStorageFor(mountpoint: string, pveMountPaths: Map<string, string>): string | undefined {
  const direct = pveMountPaths.get(mountpoint)
  if (direct)
    return direct
  if (mountpoint === '/mnt/pve' || mountpoint.startsWith('/mnt/pve/'))
    return pveMountPaths.get(mountpoint) ?? 'pve'
  return undefined
}

/**
 * Fill state + capacity for every live inventory row via the guarded probe.
 * Armed (automount placeholder) and unmounted rows are left as-is — `stat -f` on
 * an empty mountpoint lies (SURPRISE #1), so mounted state comes from findmnt.
 * Runs per-mount so one dead server never poisons the others.
 */
export async function probeInventoryHealth(executor: CommandExecutor, rows: MountSummary[]): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      if (!row.mounted || row.state === 'armed' || row.disabled)
        return
      const probe = await probeMount(executor, row.mountpoint)
      row.state = probe.state
      row.size = probe.capacity ? probe.capacity.size : null
      row.used = probe.capacity ? probe.capacity.used : null
    }),
  )
}

/** A single guarded `stat -f` liveness + capacity probe of one mountpoint. */
export async function probeMount(
  executor: CommandExecutor,
  mountpoint: string,
): Promise<{ state: MountState, detail?: string, capacity: MountCapacity | null }> {
  const r = await executor.exec(TIMEOUT, ['2', STAT, '-f', '-c', '%S %b %f %a', mountpoint])
  const state = classifyStatHealth(r.exitCode, r.stderr)
  if (state === 'ok') {
    const cap = parseStatCapacity(r.stdout)
    if (cap)
      return { state, capacity: cap }
  }
  const detail = state === 'unreachable'
    ? 'Server did not answer within 2s (probe timed out) — network gone or server down.'
    : state === 'stale'
      ? 'Stale file handle — the server-side object was removed.'
      : undefined
  return { state, detail, capacity: null }
}

/**
 * Classify a `timeout 2 stat -f` result into a liveness state (NOTES §4). Decides
 * ok/stale/unreachable for a mount findmnt already confirms is present;
 * `unmounted` is NEVER decided here (that comes from findmnt).
 */
export function classifyStatHealth(exitCode: number, stderr: string): MountState {
  if (exitCode === 124)
    return 'unreachable' // timeout fired — dead server / network gone (the hang)
  if (exitCode === 0)
    return 'ok'
  if (STALE_RE.test(stderr))
    return 'stale'
  return 'unknown' // exit 1 "No such file", or anything unexpected
}

/** Parse `stat -f -c '%S %b %f %a'` into a capacity object, or null. */
export function parseStatCapacity(stdout: string): MountCapacity | null {
  const parts = stdout.trim().split(WHITESPACE_RE).map(Number)
  if (parts.length < 4 || parts.some(n => !Number.isFinite(n)))
    return null
  const [blockSize, total, free, avail] = parts
  const size = blockSize * total
  const used = blockSize * (total - free)
  const available = blockSize * avail
  const percent = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0
  return { size, used, available, percent }
}

// ============================================================================
// Dashboard warnings (Epic 2 — 'mount' category)
// ============================================================================

/**
 * Dashboard warnings for persisted mounts that are failing. Warns ONLY on a
 * PERSISTED, non-PVE mount that is unreachable/stale, or a boot mount (no
 * noauto, no automount) that should be mounted but isn't. Healthy, armed, or
 * intentionally `noauto` mounts contribute nothing — an absent `nofail` server
 * is healthy-by-policy (SURPRISE A). Ephemeral mounts never warn.
 */
export function buildMountWarnings(
  summaries: MountSummary[],
  entriesByMount: Map<string, MountEntry>,
): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  for (const s of summaries) {
    // AHR pools have their own Hybrid RAID dashboard warnings — never
    // double-warn from the Mounts category (hands-off, §2.6).
    if (!s.persistent || s.pveManaged || s.ahrManaged)
      continue
    if (s.state === 'unreachable' || s.state === 'stale') {
      warnings.push({
        level: 'warning',
        category: 'mount',
        message: `Mount '${s.mountpoint}' is ${s.state === 'stale' ? 'stale' : 'unreachable'}`,
        ref: s.mountpoint,
      })
      continue
    }
    if (s.state === 'unmounted') {
      const entry = entriesByMount.get(s.mountpoint)
      const bootMount = entry && !entry.options.common.noauto && !entry.options.common.automount
      if (bootMount) {
        warnings.push({
          level: 'warning',
          category: 'mount',
          message: `Mount '${s.mountpoint}' is configured but not mounted`,
          ref: s.mountpoint,
        })
      }
    }
  }
  return warnings
}

/**
 * Build the inventory (with health probes) and derive the dashboard mount
 * warnings, FAIL-OPEN. Mirrors how replication warnings are wired.
 */
export async function collectMountWarnings(
  executor: CommandExecutor,
  opts: { fstabPath: string, storagePath?: string, mdadmConfPath?: string },
): Promise<DashboardWarning[]> {
  try {
    const [findmntText, fstabText, pveMountPaths, mdadmConfText] = await Promise.all([
      readFindmnt(executor),
      readConfig(opts.fstabPath),
      readPveMountPaths(opts.storagePath),
      opts.mdadmConfPath ? readMdadmConfText(opts.mdadmConfPath) : Promise.resolve(''),
    ])
    const rows = buildBaseInventory(findmntText, fstabText, pveMountPaths, ahrPinnedSpecs(mdadmConfText))
    await probeInventoryHealth(executor, rows)
    const entriesByMount = new Map(parseFstab(fstabText).map(e => [e.mountpoint, e]))
    return buildMountWarnings(rows, entriesByMount)
  }
  catch {
    return []
  }
}

/** `findmnt --json` — the safe backbone. Returns '' on any failure. */
export async function readFindmnt(executor: CommandExecutor): Promise<string> {
  try {
    const r = await executor.exec(FINDMNT, ['--json'])
    return r.stdout
  }
  catch {
    return ''
  }
}

/**
 * The REAL (non-autofs) findmnt node for a mountpoint. An automount target
 * carries a stacked `autofs` placeholder that is never the filesystem itself,
 * so it is skipped here — the caller asking "what is actually mounted, with
 * which options" must not be answered with the placeholder.
 */
export function effectiveMountNode(findmntText: string, mountpoint: string): FindmntNode | undefined {
  return parseFindmnt(findmntText).find(n => n.target === mountpoint && n.fstype !== 'autofs')
}

/**
 * The LIVE (kernel) option string for a mountpoint, or undefined when nothing is
 * mounted there. The kernel mount table is the only honest answer to "did the
 * change land" — `mount` exits 0 on an already-mounted target.
 */
export async function readEffectiveOptions(executor: CommandExecutor, mountpoint: string): Promise<string | undefined> {
  return effectiveMountNode(await readFindmnt(executor), mountpoint)?.options
}

/**
 * Does the live option string deliver the entry's intent? Narrow BY DESIGN:
 * `ro`/`rw` only — the one flag findmnt reports verbatim for every filesystem
 * and the one an in-place remount can silently fail to apply. The rest of the
 * tier is negotiated (the server answers with options of its own), so it can
 * never be a pass/fail signal.
 */
export function deliveredMatchesIntent(effectiveOptions: string, entry: MountEntry): boolean {
  return optionsReadOnly(effectiveOptions) === entry.options.common.readOnly
}

// ============================================================================
// Failure taxonomy → POST /v1/mounts/test verdicts (NOTES §6)
// ============================================================================

/** Map `mount.nfs` stderr (all failures exit 32) to a verdict. */
export function mapNfsFailure(stderr: string): MountTestVerdict {
  const s = stderr.toLowerCase()
  if (s.includes('reason given by server: no such file or directory'))
    return 'not-found'
  if (s.includes('protocol not supported') || s.includes('requested nfs version or transport protocol is not supported'))
    return 'protocol-mismatch'
  // "Connection timed out" (no route / wrong service) and "Connection refused"
  // (host up, port closed) both fold into unreachable.
  return 'unreachable'
}

/** Map `mount.cifs` `mount error(N)` errno (all failures exit 32) to a verdict. */
export function mapCifsFailure(stderr: string): MountTestVerdict {
  const m = MOUNT_ERRNO_RE.exec(stderr)
  const errno = m ? Number.parseInt(m[1], 10) : Number.NaN
  switch (errno) {
    case 13: return 'auth-failed' // cannot distinguish bad user from bad password
    case 2: return 'not-found'
    case 95: return 'protocol-mismatch'
    case 115: // EHOSTUNREACH
    case 111: // ECONNREFUSED (reported as unreachable, with detail)
      return 'unreachable'
    default: return 'unreachable'
  }
}

/**
 * The CIFS auth advice, worded ONCE (the UI's test verdicts mirror it): a wrong
 * username and a wrong password come back as the same EACCES, so the message can
 * never name which one is wrong. Used by the preflight verdict and by a rejected
 * credential rotation alike.
 */
const CIFS_AUTH_ADVICE = 'check the username or password (CIFS cannot tell the two apart)'

/** Strip the boilerplate `Refer to the mount.cifs(8)…` tail from stderr. */
export function cleanMountStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter(l => !l.startsWith('Refer to the mount.cifs'))
    .join('\n')
    .trim()
}

// ============================================================================
// Server-side option defaults (18.5)
// ============================================================================

/** The remote fstype ANAS writes for a given mount type. */
export function fstypeForType(type: MountType): string {
  return type === 'nfs' ? 'nfs4' : 'cifs'
}

/** Build the fs_spec for a create/test request. */
export function buildSpec(type: MountType, req: { server?: string, remotePath?: string }): string {
  if (type === 'nfs')
    return `${req.server ?? ''}:${req.remotePath ?? '/'}`
  return `//${req.server ?? ''}/${req.remotePath ?? ''}`
}

/** Leading path separators on a CIFS spec (`//` or `\\`, mixed). */
const CIFS_LEAD_RE = /^[/\\]+/
/** Any run of forward- or back-slashes (CIFS segment splitter). */
const CIFS_SEP_RE = /[/\\]+/

/**
 * Reverse of `buildSpec` (single source of truth for the spec<->parts mapping):
 * split an fstab fs_spec / findmnt source back into `{ server, remotePath }` so
 * the edit dialog can round-trip an existing entry. The exact inverse of the
 * write-side device builder; `parseSpec(kind, buildSpec(type, { server, remotePath }))`
 * recovers the original parts across cifs / nfs / ipv6.
 *
 * NOTE: the UI's `fstabDevice` (67-mounts.js) is a client-side PREVIEW mirror of
 * `buildSpec` — the daemon owns the authoritative mapping in both directions;
 * the UI write path is left intact (it only previews; the daemon rewrites fstab).
 *
 *  - CIFS `//server/share`, `\\server\share`, `//server/share/sub` — the first
 *    segment is the server, the remainder (joined with `/`) is the share.
 *  - NFS `server:/export`, bracketed IPv6 `[2001:db8::1]:/export`, and even a
 *    bare IPv6 `2001:db8::1:/export` — the server ends at the colon that precedes
 *    the absolute export path (`:/`), so embedded IPv6 colons never mis-split.
 *
 * Fields are omitted when absent; a malformed spec yields `{}` (never throws).
 */
export function parseSpec(kind: string, spec: string): { server?: string, remotePath?: string } {
  const s = (spec ?? '').trim()
  if (!s)
    return {}

  if (kind === 'cifs') {
    const body = s.replace(CIFS_LEAD_RE, '')
    const parts = body.split(CIFS_SEP_RE).filter(Boolean)
    if (parts.length === 0)
      return {}
    const server = parts[0]
    const remotePath = parts.slice(1).join('/')
    return remotePath ? { server, remotePath } : { server }
  }

  if (kind === 'nfs') {
    // Bracketed IPv6 literal: `[addr]:/export` (or `[addr]`).
    if (s.startsWith('[')) {
      const close = s.indexOf(']')
      if (close !== -1) {
        const server = s.slice(1, close)
        let rest = s.slice(close + 1)
        if (rest.startsWith(':'))
          rest = rest.slice(1)
        const out: { server?: string, remotePath?: string } = {}
        if (server)
          out.server = server
        if (rest)
          out.remotePath = rest
        return out
      }
    }
    // Split at the colon that precedes the absolute export path — this survives
    // an unbracketed IPv6 server (whose own colons never precede a `/`).
    let idx = s.indexOf(':/')
    if (idx === -1)
      idx = s.indexOf(':')
    if (idx === -1)
      return {} // no `host:` boundary — malformed, fail graceful
    const server = s.slice(0, idx)
    const remotePath = s.slice(idx + 1)
    const out: { server?: string, remotePath?: string } = {}
    if (server)
      out.server = server
    if (remotePath)
      out.remotePath = remotePath
    return out
  }

  return {}
}

/**
 * Apply ONE flat request option onto a structured option tier, under the clear
 * contract (issue #34): a value SETS the option, `null` CLEARS it (the key
 * leaves the object, so the fstab renderer emits no token for it), `undefined`
 * KEEPS whatever is already there.
 *
 * The single implementation both write paths share — create
 * (`applyMountDefaults`, onto a fresh tier) and edit (`mergeEntry`, onto the
 * parsed entry) — so a newly added option cannot gain clear semantics on one
 * path and quietly lack them on the other.
 */
export function applyOption<T extends object, K extends keyof T>(
  tier: T,
  key: K,
  value: T[K] | null | undefined,
): void {
  if (value === null)
    delete (tier as Partial<T>)[key]
  else if (value !== undefined)
    tier[key] = value
}

/**
 * `sec=` is a UNION at the flat request boundary (the NFS and CIFS flavours
 * share one field), so it is narrowed to the tier's own vocabulary before it is
 * applied — an out-of-tier value is dropped rather than mis-applied. `null`
 * clears, exactly like every other option.
 */
export function applySecOption<S extends string>(
  tier: { sec?: S },
  value: string | null | undefined,
  flavours: readonly S[],
): void {
  if (value === null) {
    delete tier.sec
    return
  }
  if (value === undefined)
    return
  if ((flavours as readonly string[]).includes(value))
    tier.sec = value as S
}

/**
 * Apply the server-enforced option defaults (18.5), returning the resolved
 * structured options + advisory warnings:
 *  - `nofail` FORCED on every ANAS-written entry.
 *  - `_netdev`, `nosuid`, `nodev` default-on for nfs/cifs (respecting explicit off).
 *  - NFS `vers=4.2` + `hard` default; `soft` surfaces a corruption warning.
 *  - CIFS `vers=3.1.1` default; explicit `vers=1.0` surfaces a loud warning.
 *
 * A `null` option (the clear contract, #34) means "no such option": on this
 * create path there is nothing to remove, so it simply declines the default
 * where one exists (`vers`/`hard`) and is otherwise a no-op.
 */
export function applyMountDefaults(
  type: MountType,
  input: MountRequestOptions | undefined,
  automount: boolean,
  extraOptions?: string | null,
): { options: MountOptions, warnings: string[] } {
  const warnings: string[] = []
  const remote = type === 'nfs' || type === 'cifs'
  const o = input ?? {}

  const common: MountOptions['common'] = {
    readOnly: o.ro ?? false,
    nofail: true, // FORCED
    noauto: false,
    automount,
    noatime: o.noatime ?? false,
    nosuid: o.nosuid ?? remote,
    nodev: o.nodev ?? remote,
    noexec: o.noexec ?? false,
    netdev: o.netdev ?? remote,
  }
  applyOption(common, 'automountIdleTimeout', o.idleTimeout)
  // An idle timeout is an AUTOMOUNT setting: without x-systemd.automount the
  // token is inert clutter, so it never survives an un-automounted entry.
  if (!automount)
    delete common.automountIdleTimeout

  const options: MountOptions = { common, passthrough: extraOptions ?? '' }

  if (type === 'nfs') {
    const nfs: NonNullable<MountOptions['nfs']> = {}
    // vers/hard carry a server default; `null` (the operator blanked the field)
    // declines it — the mount then uses the kernel/mount.nfs default.
    applyOption(nfs, 'vers', o.vers === undefined ? '4.2' : o.vers)
    applyOption(nfs, 'hard', o.hard === undefined ? true : o.hard)
    applyOption(nfs, 'timeo', o.timeo)
    applyOption(nfs, 'retrans', o.retrans)
    applyOption(nfs, 'rsize', o.rsize)
    applyOption(nfs, 'wsize', o.wsize)
    applyOption(nfs, 'proto', o.proto)
    applyOption(nfs, 'noac', o.noac)
    applyOption(nfs, 'actimeo', o.actimeo)
    applyOption(nfs, 'nconnect', o.nconnect)
    applyOption(nfs, 'bg', o.bg)
    applyOption(nfs, 'lookupcache', o.lookupcache)
    applySecOption(nfs, o.sec, MountNfsSec.options)
    if (nfs.hard === false)
      warnings.push('Soft NFS mounts can silently corrupt data on a timeout — prefer hard,nofail unless you understand the risk.')
    options.nfs = nfs
  }
  else if (type === 'cifs') {
    const cifs: NonNullable<MountOptions['cifs']> = {}
    applyOption(cifs, 'vers', o.vers === undefined ? '3.1.1' : o.vers)
    applyOption(cifs, 'domain', o.domain)
    applyOption(cifs, 'uid', o.uid)
    applyOption(cifs, 'gid', o.gid)
    applyOption(cifs, 'fileMode', o.fileMode)
    applyOption(cifs, 'dirMode', o.dirMode)
    applyOption(cifs, 'cache', o.cache)
    applyOption(cifs, 'mfsymlinks', o.mfsymlinks)
    applyOption(cifs, 'forceuid', o.forceuid)
    applyOption(cifs, 'forcegid', o.forcegid)
    applyOption(cifs, 'noserverino', o.noserverino)
    applyOption(cifs, 'nobrl', o.nobrl)
    applyOption(cifs, 'actimeo', o.actimeo)
    applyOption(cifs, 'rsize', o.rsize)
    applyOption(cifs, 'wsize', o.wsize)
    applyOption(cifs, 'iocharset', o.iocharset)
    applySecOption(cifs, o.sec, MountCifsSec.options)
    if (cifs.vers === '1.0')
      warnings.push('SMB 1.0 (vers=1.0) is insecure and deprecated — use it only for very old servers that require it.')
    options.cifs = cifs
  }

  return { options, warnings }
}

// ============================================================================
// Credentials (per-mount 0600 root-only files, NOTES §7)
// ============================================================================

/** Deterministic credentials filename for a mountpoint (e.g. `mnt-anas-cifs.cred`). */
export function credsFileName(mountpoint: string): string {
  const base = mountpoint.replace(LEADING_SLASHES_RE, '').replace(SLASH_RE, '-').replace(UNSAFE_CHARS_RE, '_')
  return `${base || 'root'}.cred`
}

/** Full credentials-file path for a mountpoint under `dir`. */
export function credsFilePath(dir: string, mountpoint: string): string {
  return join(dir, credsFileName(mountpoint))
}

/** Render a credentials file exactly as `mount.cifs` accepts (NOTES §7). */
export function formatCredentials(creds: { username: string, password: string, domain?: string }): string {
  const lines = [`username=${creds.username}`, `password=${creds.password}`]
  if (creds.domain)
    lines.push(`domain=${creds.domain}`)
  return `${lines.join('\n')}\n`
}

/** Parse a credentials file's non-secret metadata (username/domain only). */
export function parseCredentialsMeta(text: string): { username?: string, domain?: string } {
  const meta: { username?: string, domain?: string } = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1)
      continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'username')
      meta.username = value
    else if (key === 'domain')
      meta.domain = value
    // password is deliberately ignored — never surfaced.
  }
  return meta
}

/**
 * Write ONE credentials file: ensure `dir` (0700 root) and write `path` 0600.
 * The single place the creds-file format and permissions are applied — the
 * atomic write and the validate-then-commit rotation both go through it.
 */
async function writeCredsFileAt(
  dir: string,
  path: string,
  creds: { username: string, password: string, domain?: string },
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  await writeFile(path, formatCredentials(creds), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Write a per-mount credentials file atomically: ensure `dir` (0700 root), write
 * `<dir>/<name>.cred` 0600. The secret never touches argv/logs. Returns the file
 * path (referenced from fstab as `credentials=<path>`).
 */
export async function writeCredentialsFile(
  dir: string,
  mountpoint: string,
  creds: { username: string, password: string, domain?: string },
): Promise<string> {
  const path = credsFilePath(dir, mountpoint)
  const tmp = join(dirname(path), `.${credsFileName(mountpoint)}.anas.tmp`)
  await writeCredsFileAt(dir, tmp, creds)
  await rename(tmp, path)
  await chmod(path, 0o600).catch(() => {})
  return path
}

/**
 * Rotate a CIFS credentials file VALIDATE-THEN-COMMIT (issue #24). The candidate
 * secret goes to a sibling 0600 `.<name>.validating` file and is PROVEN by a
 * probe mount of the entry's OWN spec before it replaces the live file; only
 * then is it renamed into place. A rejected secret used to be written first and
 * survive on disk while the failed remount left the mount alive on its stale
 * kernel session — the mount then died at the next automount cycle or reboot,
 * where `nofail` hid it. The probe needs the server: an unreachable server means
 * the new secret cannot be proven, and nothing is committed.
 *
 * A non-CIFS entry has nothing to prove a secret against (`mount.nfs` reads no
 * credentials file), so it keeps the plain atomic write.
 */
export async function rotateCredentialsFile(
  executor: CommandExecutor,
  dir: string,
  entry: MountEntry,
  creds: { username: string, password: string, domain?: string },
): Promise<string> {
  if (classifyKind(entry.fstype, entry.spec) !== 'cifs')
    return writeCredentialsFile(dir, entry.mountpoint, creds)

  const live = credsFilePath(dir, entry.mountpoint)
  const candidate = join(dir, `.${credsFileName(entry.mountpoint)}.validating`)
  await writeCredsFileAt(dir, candidate, creds)
  try {
    const probe = await probeMountSpec(executor, {
      type: 'cifs',
      spec: entry.spec,
      ...(entry.options.cifs?.vers !== undefined ? { vers: entry.options.cifs.vers } : {}),
      credentialsFile: candidate,
    })
    if (probe.verdict !== 'ok')
      throw new Error(credentialProbeError(entry.mountpoint, probe))
    await rename(candidate, live)
    await chmod(live, 0o600).catch(() => {})
    return live
  }
  catch (err) {
    await rm(candidate, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * The failure a rejected candidate secret reports: the established auth wording
 * (CIFS returns the same EACCES for a wrong user and a wrong password — the UI
 * verdict says so in the same words) plus the underlying mount error, and the
 * fact that NOTHING was committed.
 */
function credentialProbeError(mountpoint: string, probe: ProbeOutcome): string {
  const underlying = probe.stderr || probe.detail || probe.verdict
  const lead = probe.verdict === 'auth-failed'
    ? `The new credentials for '${mountpoint}' were rejected — ${CIFS_AUTH_ADVICE}`
    : `The new credentials for '${mountpoint}' could not be proven (${probe.verdict})`
  return `${lead}: ${underlying}. Nothing was changed — the saved credentials and /etc/fstab are untouched.`
}

/** Read a credentials file's non-secret metadata; { set:false } if absent. */
export async function readCredentialsMeta(
  path: string,
): Promise<{ set: boolean, username?: string, domain?: string }> {
  try {
    const text = await readFile(path, 'utf8')
    return { set: true, ...parseCredentialsMeta(text) }
  }
  catch {
    return { set: false }
  }
}

/** Remove a per-mount credentials file (best-effort). */
export async function removeCredentialsFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * Remove a deleted mount's OWN mountpoint directory (18.5 refinement, opt-in
 * via `?removeMountpointDir=true`). The only path ever touched is the
 * mountpoint the delete was addressed to.
 *
 * RMDIR SEMANTICS ONLY — `rmdir(2)`, never recursive, never `rm -rf`: the
 * kernel itself refuses a directory with anything in it (ENOTEMPTY) and a
 * directory that is still a mountpoint (EBUSY), so the destructive case cannot
 * be reached even by mistake. `stillMounted` is the belt to that braces: a lazy
 * unmount can leave the mount in the table until its holders let go, and a live
 * mountpoint is never rmdir'd. Guest philosophy: ANAS tidies up the empty
 * directory its own mount lifecycle created and nothing else.
 *
 * NEVER THROWS. A leftover directory is not worth failing the delete the user
 * asked for, so every refusal comes back as a warning string naming why the
 * directory stayed; `undefined` means it is gone (or was never there).
 */
export async function removeEmptyMountpointDir(
  mountpoint: string,
  stillMounted: boolean,
): Promise<string | undefined> {
  if (stillMounted)
    return `'${mountpoint}' is still mounted — the directory was left in place.`
  try {
    await rmdir(mountpoint)
    return undefined
  }
  catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      return undefined // nothing there — the outcome the caller asked for
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST')
      return `'${mountpoint}' is not empty — the directory was left in place (only an empty directory is removed).`
    if (e.code === 'EBUSY')
      return `'${mountpoint}' is still in use — the directory was left in place.`
    return `Could not remove the directory '${mountpoint}' (${e.code ?? e.message}) — it was left in place.`
  }
}

// ============================================================================
// Preflight test (POST /v1/mounts/test)
// ============================================================================

/**
 * Diagnose a remote mount before commit: DNS → TCP(2049/445) → short-lived
 * `timeout`-guarded probe mount into a private temp dir → a distinct verdict
 * (NOTES §6). Never blocks longer than the guards; never leaves a probe mounted;
 * the secret goes via a temp 0600 creds file, never argv.
 */
export async function runMountTest(
  executor: CommandExecutor,
  req: MountTestRequest,
): Promise<MountTestResult> {
  const port = req.type === 'nfs' ? PORT_NFS : PORT_CIFS

  const dnsResolved = await resolves(req.server)
  if (!dnsResolved)
    return { verdict: 'unreachable', stage: 'dns', dnsResolved: false, portReachable: false, detail: `Could not resolve host '${req.server}'` }

  const portReachable = await tcpReachable(req.server, port)
  if (!portReachable)
    return { verdict: 'unreachable', stage: 'tcp', dnsResolved: true, portReachable: false, detail: `No answer on ${req.server}:${port}` }

  const { verdict, detail } = await probeMountAttempt(executor, req)
  // `stderr` stays daemon-side: the wire result carries the curated detail only.
  return { verdict, ...(detail !== undefined ? { detail } : {}), stage: 'mount', dnsResolved: true, portReachable: true }
}

/** DNS resolvable? */
async function resolves(host: string): Promise<boolean> {
  try {
    await lookup(host)
    return true
  }
  catch {
    return false
  }
}

/** TCP connect within 3s (no shell, node net). */
function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(3000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** What a probe mount is asked to prove: one spec, at one version, one secret. */
interface ProbeMountSpec {
  type: MountType
  /** fs_spec to mount (`//host/share`, `host:/export`). */
  spec: string
  /** Version to request (NFS 4.2 / CIFS 3.1.1 default). */
  vers?: string
  /** CIFS credentials FILE to authenticate with — path only, never argv. */
  credentialsFile?: string
}

/**
 * A probe outcome. `stderr` is the cleaned mount error kept for daemon-side
 * messages (a failed credential rotation quotes it); it never crosses the API
 * boundary — the wire result carries `detail`.
 */
interface ProbeOutcome {
  verdict: MountTestVerdict
  detail?: string
  stderr?: string
}

/**
 * A guarded probe mount of `spec` into a throwaway private dir, then unmount —
 * the ONE probe both the preflight test and the credential rotation use, so the
 * two can never diagnose the same server differently. The mount is always
 * cleaned up; the caller owns the credentials file's lifetime.
 */
async function probeMountSpec(executor: CommandExecutor, probe: ProbeMountSpec): Promise<ProbeOutcome> {
  const probeDir = await mkdtemp(join(tmpdir(), 'anas-mount-probe-'))
  try {
    const args = probe.type === 'nfs'
      ? ['15', MOUNT, '-t', 'nfs4', '-o', `vers=${probe.vers ?? '4.2'},soft,timeo=10,retrans=1,retry=0`, probe.spec, probeDir]
      : ['15', MOUNT, '-t', 'cifs', '-o', cifsProbeOptions(probe), probe.spec, probeDir]

    const r = await executor.exec(TIMEOUT, args)
    if (r.exitCode === 0) {
      await executor.exec(UMOUNT, [probeDir]).catch(() => {})
      return { verdict: 'ok' }
    }
    const stderr = cleanMountStderr(r.stderr)
    const verdict = probe.type === 'nfs' ? mapNfsFailure(stderr) : mapCifsFailure(stderr)
    return { verdict, detail: verdictDetail(probe.type, verdict, stderr), stderr }
  }
  finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The CIFS probe's `-o` list: the version, plus the creds file when there is one. */
function cifsProbeOptions(probe: ProbeMountSpec): string {
  const opts = `vers=${probe.vers ?? '3.1.1'}`
  return probe.credentialsFile ? `${opts},credentials=${probe.credentialsFile}` : opts
}

/**
 * The preflight probe for a test request: build the spec the write path would
 * write (`buildSpec`) and prove it. CIFS credentials ride a temp 0600 file in a
 * private dir (never argv), removed with the dir.
 */
async function probeMountAttempt(executor: CommandExecutor, req: MountTestRequest): Promise<ProbeOutcome> {
  const spec = buildSpec(req.type, req)
  if (req.type === 'nfs' || !req.credentials)
    return probeMountSpec(executor, { type: req.type, spec, ...(req.vers !== undefined ? { vers: req.vers } : {}) })

  const credsDir = await mkdtemp(join(tmpdir(), 'anas-mount-probe-creds-'))
  const credentialsFile = join(credsDir, 'probe.cred')
  try {
    await writeFile(credentialsFile, formatCredentials(req.credentials), { encoding: 'utf8', mode: 0o600 })
    return await probeMountSpec(executor, { type: req.type, spec, ...(req.vers !== undefined ? { vers: req.vers } : {}), credentialsFile })
  }
  finally {
    await rm(credsDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** A human detail line for a verdict — never contains the secret. */
function verdictDetail(type: 'nfs' | 'cifs', verdict: MountTestVerdict, stderr: string): string {
  if (type === 'cifs' && verdict === 'auth-failed')
    return `Authentication failed — ${CIFS_AUTH_ADVICE}.`
  return stderr || verdict
}

// ============================================================================
// systemd unit state (supplementary detail)
// ============================================================================

/**
 * The systemd mount-unit state for a mountpoint (supplementary — NEVER the
 * health verdict; a `failed` nofail unit is EXPECTED, SURPRISE A). Derives the
 * unit name via `systemd-escape -p --suffix=mount` (never hand-built), then
 * `systemctl show`. Fail-open: returns undefined on any error.
 */
export async function readUnitState(executor: CommandExecutor, mountpoint: string): Promise<MountUnit | undefined> {
  try {
    const esc = await executor.exec(SYSTEMD_ESCAPE, ['-p', '--suffix=mount', mountpoint])
    const name = esc.stdout.trim()
    if (esc.exitCode !== 0 || !name)
      return undefined
    const show = await executor.exec(SYSTEMCTL, ['show', name, '--property=LoadState,ActiveState,SubState,Result'])
    if (show.exitCode !== 0 && !show.stdout.trim())
      return { name }
    const props = new Map<string, string>()
    for (const line of show.stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0)
        props.set(line.slice(0, eq), line.slice(eq + 1))
    }
    const unit: MountUnit = { name }
    if (props.get('LoadState'))
      unit.loadState = props.get('LoadState')
    if (props.get('ActiveState'))
      unit.activeState = props.get('ActiveState')
    if (props.get('SubState'))
      unit.subState = props.get('SubState')
    if (props.get('Result'))
      unit.result = props.get('Result')
    return unit
  }
  catch {
    return undefined
  }
}

// ============================================================================
// Inline-credential redaction (SECURITY — the secret never crosses the boundary)
// ============================================================================

/** Placeholder the plaintext password is replaced with in any client-facing string. */
export const REDACTED_SECRET = '*****'
/** `password=<value>` up to the next option separator (comma) or whitespace. */
const INLINE_PASSWORD_RE = /(password=)[^,\s]*/gi
/** Advisory shown when a mount still carries inline plaintext credentials. */
export const INLINE_CREDS_WARNING
  = 'Credentials are stored inline in /etc/fstab (plaintext); saving migrates them to a protected root-only file.'

/**
 * Redact the inline plaintext CIFS password from an fstab line so it can be
 * returned as `MountDetail.fstabLine` without leaking the secret. Replaces the
 * `password=<value>` token with `password=*****`; leaves everything else — incl.
 * `username=` (already surfaced via credentials) — byte-for-byte.
 */
export function redactFstabLine(line: string): string {
  return line.replace(INLINE_PASSWORD_RE, `$1${REDACTED_SECRET}`)
}

/**
 * A response-safe copy of an entry: the transient `inlineCredentials` channel
 * (which carries the plaintext password) is DROPPED entirely — its information
 * is conveyed instead via `MountDetail.credentials` (presence + username/domain,
 * never the secret) and a warning. Everything else is preserved.
 */
export function entryForResponse(entry: MountEntry): MountEntry {
  if (!entry.inlineCredentials)
    return entry
  const { inlineCredentials: _drop, ...rest } = entry
  return rest
}

/** True when an entry carries inline plaintext credentials (username or password inline). */
export function hasInlineCredentials(entry: MountEntry | undefined): boolean {
  const inline = entry?.inlineCredentials
  return !!inline && (inline.username !== undefined || inline.password !== undefined)
}

// ============================================================================
// Detail assembly (GET /v1/mounts/:mountpoint)
// ============================================================================

/**
 * Assemble a MountDetail for `mountpoint`: the inventory row + the fstab line as
 * written + configured/effective options + systemd unit state + CIFS creds
 * presence (never the secret) + capacity. Returns null when the mountpoint is
 * neither in findmnt nor fstab.
 */
export async function buildMountDetail(
  executor: CommandExecutor,
  mountpoint: string,
  opts: { fstabPath: string, credsDir: string, storagePath?: string, mdadmConfPath?: string },
): Promise<MountDetail | null> {
  const [findmntText, fstabText, pveMountPaths, mdadmConfText] = await Promise.all([
    readFindmnt(executor),
    readConfig(opts.fstabPath),
    readPveMountPaths(opts.storagePath),
    opts.mdadmConfPath ? readMdadmConfText(opts.mdadmConfPath) : Promise.resolve(''),
  ])
  const rows = buildBaseInventory(findmntText, fstabText, pveMountPaths, ahrPinnedSpecs(mdadmConfText))
  const row = rows.find(r => r.mountpoint === mountpoint)
  if (!row)
    return null

  let health: MountDetail['health'] = { state: row.state }
  let capacity: MountCapacity | undefined
  if (row.disabled) {
    health = { state: 'disabled', detail: 'Disabled in /etc/fstab (marker-commented) — will not mount.' }
  }
  else if (row.mounted && row.state !== 'armed') {
    const probe = await probeMount(executor, mountpoint)
    row.state = probe.state
    health = probe.detail ? { state: probe.state, detail: probe.detail } : { state: probe.state }
    if (probe.capacity) {
      capacity = probe.capacity
      row.size = probe.capacity.size
      row.used = probe.capacity.used
    }
  }
  else if (row.state === 'unmounted') {
    health = { state: 'unmounted', detail: 'Configured in /etc/fstab but not currently mounted.' }
  }
  else if (row.state === 'armed') {
    health = { state: 'armed', detail: 'Automount armed — mounts on first access.' }
  }

  const entry = getMount(fstabText, mountpoint)
  const effective = effectiveMountNode(findmntText, mountpoint)

  const detail: MountDetail = { ...row, health, warnings: [] }
  if (capacity)
    detail.capacity = capacity
  if (entry) {
    // SECURITY: never let the transient inline-credential channel (plaintext
    // password) cross the boundary, and REDACT the password in the raw fstab line.
    detail.entry = entryForResponse(entry)
    detail.configuredOptions = detail.entry.options
    const raw = fstabLineFor(fstabText, mountpoint)
    if (raw !== undefined)
      detail.fstabLine = redactFstabLine(raw)
  }
  if (effective)
    detail.effectiveOptions = effective.options

  const unit = await readUnitState(executor, mountpoint)
  if (unit)
    detail.unit = unit

  if (row.type === 'cifs') {
    if (hasInlineCredentials(entry)) {
      // Inline plaintext credentials found (18.5 anti-pattern): reflect their
      // presence + non-secret metadata (username/domain), NEVER the password, and
      // guide the operator that a save migrates them to the protected creds file.
      const inline = entry!.inlineCredentials!
      detail.credentials = {
        set: true,
        ...(inline.username ? { username: inline.username } : {}),
        ...(inline.domain ? { domain: inline.domain } : {}),
      }
      detail.warnings.push(INLINE_CREDS_WARNING)
    }
    else {
      const credPath = entry?.credentialsFile ?? credsFilePath(opts.credsDir, mountpoint)
      const meta = await readCredentialsMeta(credPath)
      detail.credentials = {
        set: meta.set,
        ...(meta.username ? { username: meta.username } : {}),
        ...(meta.domain ? { domain: meta.domain } : {}),
      }
    }
  }

  return detail
}

/** The exact fstab line for `mountpoint`, or undefined. */
export function fstabLineFor(fstabText: string, mountpoint: string): string | undefined {
  for (const raw of fstabText.split('\n')) {
    if (raw.trim().startsWith('#') || raw.trim() === '')
      continue
    // Only a token-starting `#` is a trailing comment — a `#` inside a field (an
    // option value such as a password) is data, never truncate on it (BUG-2).
    const hashIdx = inlineCommentIndex(raw)
    const fieldsPart = hashIdx === -1 ? raw : raw.slice(0, hashIdx)
    const fields = fieldsPart.trim().split(WHITESPACE_RE)
    if (fields.length >= 2 && fields[1] === mountpoint)
      return raw
  }
  return undefined
}

// ============================================================================
// Mount entry from a create request (for the write path)
// ============================================================================

/**
 * Build the structured fstab entry ANAS will write for a create request, with
 * server-side defaults applied. For CIFS, `credentialsFile` points at the
 * per-mount creds path (the secret itself lives only in that 0600 file).
 */
export function entryFromRequest(
  req: CreateMountRequest,
  credsDir: string,
): { entry: MountEntry, warnings: string[] } {
  const { options, warnings } = applyMountDefaults(req.type, req.options, req.automount, req.extraOptions)
  const entry: MountEntry = {
    spec: buildSpec(req.type, req),
    mountpoint: req.mountpoint,
    fstype: fstypeForType(req.type),
    options,
    dump: 0,
    pass: 0,
  }
  if (req.type === 'cifs')
    entry.credentialsFile = credsFilePath(credsDir, req.mountpoint)
  return { entry, warnings }
}

/** True when `mountpoint` is PVE territory (never ANAS-managed). */
export function mountpointReservedByPve(mountpoint: string): boolean {
  return mountpoint === '/mnt/pve'
    || mountpoint.startsWith('/mnt/pve/')
    || mountpoint === '/etc/pve'
    || mountpoint.startsWith('/etc/pve/')
}

/** Does the fstab already define this mountpoint? */
export function fstabHasMount(fstabText: string, mountpoint: string): boolean {
  return parseFstab(fstabText).some(e => e.mountpoint === mountpoint)
}
