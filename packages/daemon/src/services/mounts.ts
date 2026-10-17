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
import type { CommandExecutor, ExecOptions, ExecResult } from '../executor/types.js'
import type { FindmntNode } from '../parsers/findmnt.js'
import type { Gate, Refusal } from '../safety/guard.js'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { constants as FS_CONSTANTS } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { CIFS_CREDENTIAL_OPTION_KEYS, MountCifsSec, MountExtraOptions, MountNfsSec, normalizeMountTarget, unescapeFstabField } from '@anas/shared'
import { classifyKind, effectiveMountAt, effectiveMounts, isIgnoredMount, optionsReadOnly, parseFindmnt, readFindmntTable } from '../parsers/findmnt.js'
import { cifsAuthToken, getMount, inlineCommentIndex, parseFstab, parseFstabDoc } from '../parsers/fstab.js'
import { getArrays, parseMdadmConfDoc } from '../parsers/mdadm-conf.js'
import { matchAhrArrayName } from '../parsers/mdadm-detail.js'
import { readPveMountPaths } from '../parsers/pve-storage.js'
import { zodIssue } from '../validation.js'
import { ahrLvPath } from './ahr-paths.js'
import { readConfig, writeFileAtomic } from './config-writer.js'
import { liveAtTarget } from './mount-match.js'
import { execSystemctlShow } from './unit-run-status.js'

/** `timeout` binary — wraps the probe so a dead NFS server can never hang us. */
const TIMEOUT = '/usr/bin/timeout'
/** `stat -f` in a child, guarded by timeout — THE hang-safe liveness probe. */
const STAT = 'stat'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
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
/** Kernel "malformed UNC" marker (a malformed server/share devname). */
const MALFORMED_UNC_RE = /malformed unc/i
/** Leading slashes on a mountpoint (creds-filename derivation, mountpoint normalization). */
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
  // cr.60 (review L26): the ONE stacked-mount rule (parsers/findmnt) — the
  // top real filesystem at a target is its row, an autofs placeholder only
  // when nothing real sits there; a placeholder anywhere in the stack is what
  // makes the row an automount.
  const armedAt = new Set(nodes.filter(n => n.fstype === 'autofs').map(n => n.target))
  for (const node of effectiveMounts(nodes).values()) {
    const isAutofs = node.fstype === 'autofs'
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
      automount: armedAt.has(node.target),
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
    // reliable identity; a mounted pool's findmnt `source` carries the btrfs
    // fsroot suffix (`[/@data]`) and, since cr.52r's direct mount, is the LV
    // path for a daemon-mounted pool and the /dev/mapper name for a boot-time
    // one — so the source-side test rarely hits and the configured spec is
    // the match that counts.
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

/**
 * `findmnt --json` for the DISPLAY readers (inventory, detail, dashboard, the
 * fail-open source guard) — '' when the table is unreadable (cr.60: a
 * non-zero exit or a wrong shape included, never its stdout), which those
 * readers already take as "no live facts". A GATE reads the table through
 * {@link readFindmntTable} instead, where unreadable is `null` and refuses.
 */
export async function readFindmnt(executor: CommandExecutor): Promise<string> {
  return (await readFindmntTable(executor)) ?? ''
}

/**
 * The REAL (non-autofs) findmnt node for a mountpoint — the TOP one when
 * mounts are stacked (cr.60, review L26: this used to answer the BOTTOM row,
 * so an edit's delivery check read options the kernel was not serving while
 * the inventory showed the top). An automount target's `autofs` placeholder
 * is never the filesystem itself, so the caller asking "what is actually
 * mounted, with which options" is never answered with it.
 */
export function effectiveMountNode(findmntText: string, mountpoint: string): FindmntNode | undefined {
  return effectiveMountAt(parseFindmnt(findmntText), mountpoint)
}

/**
 * The LIVE (kernel) option string for a mountpoint, or undefined when nothing is
 * mounted there. The kernel mount table is the only honest answer to "did the
 * change land" — `mount` exits 0 on an already-mounted target. An UNREADABLE
 * table THROWS (cr.60): "could not read" must never read as "nothing mounted",
 * which sent an edit down the mount-over path and reported it delivered.
 */
export async function readEffectiveOptions(executor: CommandExecutor, mountpoint: string): Promise<string | undefined> {
  const text = await readFindmntTable(executor)
  if (text === null)
    throw new Error(`The kernel mount table could not be read (findmnt failed), so whether '${mountpoint}' is mounted and with which options is unknown — the /etc/fstab line carries the change; check the live mount on the node`)
  return effectiveMountNode(text, mountpoint)?.options
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

/**
 * Map `mount.cifs` `mount error(N)` errno (all failures exit 32) to a verdict.
 *
 * `mount error(22)` (EINVAL) is the kernel's "CIFS: VFS: Malformed UNC in
 * devname" — a bad SERVER or SHARE string, decided before any connection was
 * attempted. It must come back `invalid`, never `unreachable`: the old table
 * folded it into the default case, so an empty share read as "no route to the
 * server" and sent the operator hunting the network for a typo.
 */
export function mapCifsFailure(stderr: string): MountTestVerdict {
  const m = MOUNT_ERRNO_RE.exec(stderr)
  const errno = m ? Number.parseInt(m[1], 10) : Number.NaN
  if (errno === 22 || MALFORMED_UNC_RE.test(stderr))
    return 'invalid' // EINVAL — malformed UNC (empty share, stray slashes, …)
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

/**
 * Build the fs_spec for a create/test request — ALWAYS from the normalised
 * target (the shared `normalizeMountTarget`), so whatever the operator typed
 * (`//10.0.0.212`, `10.0.0.212/`, `/pictures`, `smb://host/share`) lands in
 * fstab as the canonical `//host/share` / `host:/export`. The routes refuse a
 * target with `problems` (an empty CIFS share) BEFORE this is reached; a
 * problem-free target normalises to exactly the parts the spec is built from.
 */
export function buildSpec(type: MountType, req: { server?: string, remotePath?: string }): string {
  const { server, remotePath } = normalizeMountTarget(type, req)
  if (type === 'nfs')
    return `${server}:${remotePath}`
  return `//${server}/${remotePath}`
}

/** Leading path separators on a CIFS spec (`//` or `\\`, mixed). */
const CIFS_LEAD_RE = /^[/\\]+/
/** Any run of forward- or back-slashes (CIFS segment splitter). */
const CIFS_SEP_RE = /[/\\]+/

/**
 * Reverse of `buildSpec` (single source of truth for the spec<->parts mapping):
 * split an fstab fs_spec / findmnt source back into `{ server, remotePath }` so
 * the edit dialog can round-trip an existing entry. The exact inverse of the
 * write-side device builder: `parseSpec(kind, buildSpec(type, { server, remotePath }))`
 * recovers the parts for any input — for a dirty one the NORMALISED parts
 * (buildSpec normalises first), for a clean one the original parts.
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
 * The one writer-side re-check for a REQUEST-supplied `extraOptions` value
 * (cr.2, review C2 — defence in depth, Principle 6): where the flat request
 * turns into the verbatim passthrough a fstab line will carry, the value is
 * re-validated with the SAME schema that gates the request boundary, so a
 * caller that bypasses the route schema still cannot hand a raw option string
 * (a newline forges an extra fstab line) to the writer. A refusal throws a
 * 400-carrying message; the routes catch it. PRESERVED passthrough from an
 * existing hand-written entry is NOT re-checked — the read side stays lenient
 * (never refuse to read the system's own file), and an edit to an unrelated
 * field keeps a human's exotic token byte-identical.
 */
/** Thrown by {@link validatedExtraOptions}; the routes turn it into a 400. */
export class InvalidExtraOptionsError extends Error {}

export function validatedExtraOptions(extraOptions: string | null | undefined): string {
  if (extraOptions === undefined || extraOptions === null)
    return ''
  const parsed = MountExtraOptions.safeParse(extraOptions)
  if (!parsed.success)
    throw new InvalidExtraOptionsError(zodIssue(parsed.error))
  return extraOptions
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

  const options: MountOptions = { common, passthrough: validatedExtraOptions(extraOptions) }

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

/**
 * Deterministic credentials filename for a mountpoint: `mnt-<12 hex of
 * sha256(mountpoint)>.cred` (story ident.4 (d), audit #17). The name before
 * ident.4 flattened the path (`/mnt/nas-media` and `/mnt/nas/media` both became
 * `mnt-nas-media.cred`), so two mounts could share — and one Remove delete —
 * the other's secret. The hash of the FULL mountpoint is injective for every
 * practical purpose. New files are written under this name; a file written
 * under the old one keeps working, because the fstab line names its file and
 * that is what is read ({@link legacyCredsFileName} is the fallback for a line
 * that names none).
 */
export function credsFileName(mountpoint: string): string {
  return `mnt-${createHash('sha256').update(mountpoint).digest('hex').slice(0, 12)}.cred`
}

/** The pre-ident.4 flattened name — read as a fallback only, never written. */
export function legacyCredsFileName(mountpoint: string): string {
  const base = mountpoint.replace(LEADING_SLASHES_RE, '').replace(SLASH_RE, '-').replace(UNSAFE_CHARS_RE, '_')
  return `${base || 'root'}.cred`
}

/** Full credentials-file path for a mountpoint under `dir`. */
export function credsFilePath(dir: string, mountpoint: string): string {
  return join(dir, credsFileName(mountpoint))
}

/**
 * Remove a credentials file ANAS no longer needs — ONLY when it is a regular
 * file directly inside the ANAS creds directory (both sides resolved, so a
 * symlinked path cannot lead outside) and nothing in `fstabText` (the fstab
 * AFTER the edit) still references it (ident.4 (d)). Never throws. Returns
 * undefined when the file is gone (or was never there), else the sentence
 * naming why it stayed.
 */
export async function removeCredentialsFileIfUnreferenced(
  credsDir: string,
  path: string,
  fstabText: string,
): Promise<string | undefined> {
  const target = resolve(path)
  let realDir: string
  let realParent: string
  try {
    realDir = await realpath(credsDir)
    realParent = await realpath(dirname(target))
  }
  catch {
    return dirname(target) === resolve(credsDir)
      ? undefined // the creds dir itself is absent — nothing to remove
      : `Credentials file '${path}' was left in place — it is not in the ANAS credentials directory ${credsDir}.`
  }
  if (realParent !== realDir)
    return `Credentials file '${path}' was left in place — it is not in the ANAS credentials directory ${credsDir}.`
  const referenced = fstabText.includes(target) || fstabText.includes(path)
    || parseFstab(fstabText).some(e => e.credentialsFile !== undefined && resolve(e.credentialsFile) === target)
  if (referenced)
    return `Credentials file '${path}' was left in place — another /etc/fstab line still references it.`
  try {
    const st = await lstat(target)
    if (!st.isFile())
      return `Credentials file '${path}' was left in place — it is not a regular file.`
    await rm(target, { force: true })
    return undefined
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    return `Could not remove credentials file '${path}' (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`
  }
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
 * Ensure the creds dir exists, 0700 root (an existing dir is only ever
 * tightened, never created wider). Shared by the atomic write and the
 * validate-then-commit rotation's candidate staging.
 */
async function ensureCredsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
}

/**
 * Stage a credentials file (the rotation's CANDIDATE): ensure `dir`, write
 * `path` 0600. A plain write, NOT the atomic swap — the candidate is a fresh
 * sibling file and its rename (after the probe passes) is the commit point.
 */
async function writeCredsFileAt(
  dir: string,
  path: string,
  creds: { username: string, password: string, domain?: string },
): Promise<void> {
  await ensureCredsDir(dir)
  await writeFile(path, formatCredentials(creds), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Write a per-mount credentials file atomically: ensure `dir` (0700 root), write
 * `<dir>/<name>.cred` 0600 via the shared atomic helper (the secret never
 * touches argv/logs; the temp is exclusive, unpredictable and fsynced).
 * Returns the file path (referenced from fstab as `credentials=<path>`).
 */
export async function writeCredentialsFile(
  dir: string,
  mountpoint: string,
  creds: { username: string, password: string, domain?: string },
): Promise<string> {
  const path = credsFilePath(dir, mountpoint)
  await ensureCredsDir(dir)
  await writeFileAtomic(path, formatCredentials(creds), { mode: 0o600 })
  // Secrets are root-only (EPICS §2) — force 0600 even onto a pre-existing
  // looser-mode target.
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
 * The network stages of the preflight test, as a seam (see `MountTestStages`):
 * a test host has no share server on 2049/445, so without an override the
 * mount stage — and its verdict mapping — can never be reached from a test.
 */
export interface MountTestStages {
  /** DNS resolvable? Defaults to the real `node:dns` lookup. */
  resolves?: (host: string) => Promise<boolean>
  /** TCP connect within 3s? Defaults to the real `node:net` connect. */
  tcpReachable?: (host: string, port: number) => Promise<boolean>
}

/**
 * Diagnose a remote mount before commit: DNS → TCP(2049/445) → short-lived
 * `timeout`-guarded probe mount into a private temp dir → a distinct verdict
 * (NOTES §6). Never blocks longer than the guards; never leaves a probe mounted;
 * the secret goes via a temp 0600 creds file, never argv.
 *
 * The target is normalised BEFORE the first stage (the shared normaliser): a
 * dirty typed host (`//10.0.0.212`) is resolved and probed as the clean one,
 * so a failure detail quotes what the spec actually carries. Targets with
 * `problems` (an empty CIFS share) are refused by the routes as a 400 with the
 * guiding sentence — they never reach a stage here.
 */
export async function runMountTest(
  executor: CommandExecutor,
  req: MountTestRequest,
  stages: MountTestStages = {},
): Promise<MountTestResult> {
  const port = req.type === 'nfs' ? PORT_NFS : PORT_CIFS
  const { server } = normalizeMountTarget(req.type, req)

  const dnsResolved = await (stages.resolves ?? resolves)(server)
  if (!dnsResolved)
    return { verdict: 'unreachable', stage: 'dns', dnsResolved: false, portReachable: false, detail: `Could not resolve host '${server}'` }

  const portReachable = await (stages.tcpReachable ?? tcpReachable)(server, port)
  if (!portReachable)
    return { verdict: 'unreachable', stage: 'tcp', dnsResolved: true, portReachable: false, detail: `No answer on ${server}:${port}` }

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

/**
 * The CIFS probe's `-o` list: the version plus the SAME auth token the write
 * path carries (`cifsAuthToken`, parsers/fstab.js) — the creds file for an
 * auth probe, `guest` for a no-credentials probe. Without one of the two,
 * `mount.cifs` PROMPTS for a password on stdin ("Password for root@//host/
 * share:") — a probe with no terminal then hangs until the timeout and reports
 * "unreachable" for what is really "no credentials supplied". `guest` makes
 * the request anonymous instead: an auth-requiring share answers EACCES, which
 * maps to the `auth-failed` verdict with its advice.
 */
function cifsProbeOptions(probe: ProbeMountSpec): string {
  return `vers=${probe.vers ?? '3.1.1'},${cifsAuthToken(probe.credentialsFile)}`
}

/**
 * Where an UNSAVED test's probe credentials live (cr.60, review L8): anasd's
 * own runtime directory — tmpfs, root-only, made by the unit's
 * `ExecStartPre` — never `os.tmpdir()`, where a daemon that died mid-probe
 * left the plaintext on whatever `/tmp` is. `ANAS_MOUNT_PROBE_RUNTIME_DIR`
 * points a test at its own directory. There is no fallback: a probe that
 * cannot make its private directory here refuses rather than writing the
 * secret anywhere else.
 */
export const MOUNT_PROBE_RUNTIME_DIR = '/run/anas'

/** The mkdtemp prefix of an unsaved probe's private credentials directory. */
export const MOUNT_PROBE_CREDS_PREFIX = 'anas-mount-probe-creds-'

function mountProbeRuntimeDir(): string {
  return process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR ?? MOUNT_PROBE_RUNTIME_DIR
}

/**
 * The preflight probe for a test request: build the spec the write path would
 * write (`buildSpec`) and prove it. CIFS credentials ride a 0600 file in a
 * private 0700 dir under the daemon's runtime directory (never argv, never
 * `/tmp` — cr.60, review L8), removed with the dir on every path out.
 */
async function probeMountAttempt(executor: CommandExecutor, req: MountTestRequest): Promise<ProbeOutcome> {
  const spec = buildSpec(req.type, req)
  if (req.type === 'nfs' || !req.credentials)
    return probeMountSpec(executor, { type: req.type, spec, ...(req.vers !== undefined ? { vers: req.vers } : {}) })

  const base = mountProbeRuntimeDir()
  await mkdir(base, { recursive: true, mode: 0o700 })
  const credsDir = await mkdtemp(join(base, MOUNT_PROBE_CREDS_PREFIX))
  const credentialsFile = join(credsDir, 'probe.cred')
  try {
    await chmod(credsDir, 0o700)
    await writeFile(credentialsFile, formatCredentials(req.credentials), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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
  if (verdict === 'invalid')
    return 'The server or share is malformed — server is a host or address, share is the share\'s name.'
  return stderr || verdict
}

// ============================================================================
// systemd unit state (supplementary detail)
// ============================================================================

/**
 * The systemd unit name for a mountpoint's `.mount` / `.automount` unit, via
 * `systemd-escape -p --suffix=<suffix>` (never hand-built: hyphens become
 * `\x2d`, NOTES.md §7). Undefined when the escape fails or prints nothing.
 * Throws only if the binary cannot be started (the executor's contract).
 */
async function escapeMountUnitName(executor: CommandExecutor, mountpoint: string, suffix: 'mount' | 'automount'): Promise<string | undefined> {
  const esc = await executor.exec(SYSTEMD_ESCAPE, ['-p', `--suffix=${suffix}`, mountpoint])
  const name = esc.stdout.trim()
  return esc.exitCode !== 0 || !name ? undefined : name
}

/** Health detail of a disabled mount whose automount placeholder is still armed (cr.19). */
export const DISABLED_PLACEHOLDER_DETAIL
  = 'Disabled in /etc/fstab — will not mount at boot. An automount placeholder is still armed at this path, so the first access mounts the share until its .automount unit is stopped.'

/** `systemctl` exit status for a unit the manager has not loaded ("Unit … not loaded."). */
const SYSTEMCTL_UNIT_NOT_LOADED = 5

/**
 * cr.19 (§2 Mounts automount ruling; node pass R1-D2/D3) — stop the
 * `.automount` unit of an automount line that Disable or Remove is taking out
 * of service. The daemon-reload alone leaves an ARMED automount armed (D2: the
 * first access then mounts the disabled share) and, for a removed line, leaves
 * an orphaned autofs placeholder that answers "Host is down" (D3), so the
 * routes call this after the fstab edit and before the daemon-reload.
 *
 * Best-effort side effect of the mutation: the fstab edit has already
 * happened, so a failure never fails the job — it comes back as the warning
 * sentence to put on the job result (never swallowed). A unit the manager has
 * not loaded (exit 5 — e.g. a line disabled earlier whose automount the
 * generator no longer makes) is not armed, so there is nothing to stop and no
 * warning.
 */
export async function stopAutomountUnit(executor: CommandExecutor, mountpoint: string): Promise<string | undefined> {
  const failed = (why: string): string =>
    `Could not stop the automount unit for '${mountpoint}' (${why}) — it may still be armed and mount the share on first access until it is stopped.`
  try {
    const unit = await escapeMountUnitName(executor, mountpoint, 'automount')
    if (!unit)
      return failed('systemd-escape gave no unit name')
    const r = await executor.exec(SYSTEMCTL, ['stop', unit])
    if (r.exitCode === 0 || r.exitCode === SYSTEMCTL_UNIT_NOT_LOADED)
      return undefined
    return failed(r.stderr.trim() || `systemctl stop ${unit} exited ${r.exitCode}`)
  }
  catch (err) {
    return failed(err instanceof Error ? err.message : String(err))
  }
}

/**
 * The systemd mount-unit state for a mountpoint (supplementary — NEVER the
 * health verdict; a `failed` nofail unit is EXPECTED, SURPRISE A). Derives the
 * unit name via `systemd-escape -p --suffix=mount` (never hand-built), then
 * `systemctl show`. Fail-open: returns undefined on any error.
 */
export async function readUnitState(executor: CommandExecutor, mountpoint: string): Promise<MountUnit | undefined> {
  try {
    const name = await escapeMountUnitName(executor, mountpoint, 'mount')
    if (!name)
      return undefined
    const show = await execSystemctlShow(executor, name, 'LoadState,ActiveState,SubState,Result')
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
/**
 * A SECRET option token — `<key>=<value>` for every secret key of the ONE
 * shared list (`CIFS_CREDENTIAL_OPTION_KEYS.secret`: `password`, `pass`,
 * `password2`; cr.60, review M7) — at a token boundary (line start,
 * whitespace or comma), any case, its value up to the next comma or
 * whitespace. Built from the list, never a second copy of it; the `=` right
 * after the key means `password2=` is never read as `password` + `2`.
 */
const SECRET_OPTION_RE = new RegExp(
  `(^|[\\s,])((?:${CIFS_CREDENTIAL_OPTION_KEYS.secret.join('|')})=)[^,\\s]*`,
  'gi',
)
/** Advisory shown when a mount still carries inline plaintext credentials. */
export const INLINE_CREDS_WARNING
  = 'Credentials are stored inline in /etc/fstab (plaintext); saving migrates them to a protected root-only file.'
/** Advisory shown when a line carries a secret option ANAS does not migrate (cr.60). */
export const INLINE_SECRET_OPTION_WARNING
  = 'A password option ANAS does not migrate (password2=, or a password on a line that is not read as CIFS) is stored inline in /etc/fstab (plaintext). ANAS never shows it and writes it back unchanged when it rewrites the line.'

/**
 * Redact every inline plaintext secret from an fstab line so it can be
 * returned as `MountDetail.fstabLine` without leaking it: each secret option
 * of the shared list, in any case (`password=`, `pass=`, `password2=`,
 * `PASSWORD=`…), keeps its key and has its value replaced with `*****`;
 * everything else — incl. `username=` (already surfaced via credentials) —
 * stays byte-for-byte.
 */
export function redactFstabLine(line: string): string {
  return line.replace(SECRET_OPTION_RE, `$1$2${REDACTED_SECRET}`)
}

/**
 * A response-safe copy of an entry: the transient `inlineCredentials` channel
 * (which carries the plaintext password) and the `secretOptions` tokens are
 * DROPPED entirely — their information is conveyed instead via
 * `MountDetail.credentials` (presence + username/domain, never the secret)
 * and a warning. Everything else is preserved.
 */
export function entryForResponse(entry: MountEntry): MountEntry {
  if (!entry.inlineCredentials && !entry.secretOptions)
    return entry
  const { inlineCredentials: _drop, secretOptions: _secrets, ...rest } = entry
  return rest
}

/**
 * True when an entry carries inline credentials in the transient channel — a
 * lifted username, a password, or both. The reader fills the channel for a
 * username-only line too, so this is NOT the migration test: the detail uses
 * it to show the username/domain, and the save migrates only a line that
 * carries a PASSWORD (cr.60r — routes/mounts.ts tests `password` directly; a
 * username-only line keeps its token on the line).
 */
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
    // cr.6: a disabled line carries `noauto` (+ an `x-anas.disabled` token) or
    // a legacy `#ANAS ` comment — either way it is not mounted at boot. The
    // STATE stays 'disabled' even over a leftover autofs placeholder (cr.19:
    // the line's automount is parked; the placeholder is what a failed stop,
    // or a disable from before cr.19, left behind) — but the detail says so,
    // because that placeholder still mounts the share on first access.
    const placeholder = liveAtTarget(parseFindmnt(findmntText), mountpoint).armed
    health = { state: 'disabled', detail: placeholder ? DISABLED_PLACEHOLDER_DETAIL : 'Disabled in /etc/fstab — will not mount at boot.' }
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

  if (entry?.secretOptions)
    detail.warnings.push(INLINE_SECRET_OPTION_WARNING)
  if (row.type === 'cifs') {
    if (hasInlineCredentials(entry)) {
      // Inline plaintext credentials found (18.5 anti-pattern): reflect their
      // presence + non-secret metadata (username/domain), NEVER the password, and
      // guide the operator that a save migrates them to the protected creds file.
      // cr.60r: the migration advisory belongs to the SECRET only — a line with
      // a username and no password migrates nothing (the username stays on the
      // line by design), so it earns no "saving migrates them" hint.
      const inline = entry!.inlineCredentials!
      detail.credentials = {
        set: true,
        ...(inline.username ? { username: inline.username } : {}),
        ...(inline.domain ? { domain: inline.domain } : {}),
      }
      if (inline.password !== undefined)
        detail.warnings.push(INLINE_CREDS_WARNING)
    }
    else {
      // The fstab line names its file; a line that names none falls back to
      // the hashed name, then the pre-ident.4 flattened one (read both, write new).
      let meta = await readCredentialsMeta(entry?.credentialsFile ?? credsFilePath(opts.credsDir, mountpoint))
      if (!meta.set && !entry?.credentialsFile)
        meta = await readCredentialsMeta(join(opts.credsDir, legacyCredsFileName(mountpoint)))
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
    // The field is octal-escaped (`\040` for a space, cr.2); compare decoded.
    if (fields.length >= 2 && unescapeFstabField(fields[1]) === mountpoint)
      return raw
  }
  return undefined
}

// ============================================================================
// Mount entry from a create request (for the write path)
// ============================================================================

/**
 * Build the structured fstab entry ANAS will write for a create request, with
 * server-side defaults applied. A CIFS WITH credentials gets its
 * `credentialsFile` pointing at the per-mount creds path (the secret itself
 * lives only in that 0600 file); a credential-less CIFS carries NO
 * credentialsFile, so the serializer writes `guest` (cifsAuthToken) and the
 * mount never prompts.
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
  if (req.type === 'cifs' && req.credentials)
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

/**
 * The system mount targets (cr.18, review M7.3) — the ONE list the mount
 * refusal is computed from. Mounting a remote share OVER one of these (or
 * over an ancestor of one — `mount` hides the entire subtree below it, and
 * an ancestor of `/etc` hides all of `/etc`) breaks the node the way the
 * PVE-territory and ZFS guards keep it from being broken by accident.
 *
 * The rule, applied to the NORMALIZED path (`normalizeMountpointPath`):
 *  - EQUAL to a list entry                → refused (`/etc`, `/srv`, `/`…)
 *  - a strict directory PREFIX of an entry → refused (`/us` would hide the
 *    `/usr` subtree when the list entry is created under it later; `/srv`
 *    with a trailing component below is fine — see "allowed" below)
 *  - INSIDE one of the NEVER_MOUNT_UNDER
 *    subtrees, at any depth                 → refused (`/usr/local`,
 *    `/etc/x`, `/lib64/y`…)
 *
 * Allowed: UNDER `/srv`, `/home`, `/opt` and `/var` — `/srv/backup`,
 * `/var/lib/remote`, `/home/shares/nas` are ordinary remote-mount
 * shapes. `/opt` is deliberately NOT in the list: nothing ships there that a
 * mount could hide, and it is the conventional third-party mount root.
 *
 * The cr.52r refinements narrow the two broad "allowed under" trees:
 *  - under `/home`, a mountpoint at or above a `<user>/.ssh` directory is
 *    refused (the protected root) AND any mountpoint that is an ANCESTOR of
 *    one is refused (a mount at `/home` or at `/home/alice` hides the `.ssh`
 *    directory below it). A mount at least two segments below the home root
 *    that is not itself `.ssh` (`/home/alice/Documents`, `/home/shares/nas`)
 *    is still allowed.
 *  - under `/var`, the protected roots at or under which a mount is refused
 *    (`/var/spool/cron`, `/var/lib/pve*`, `/var/lib/vz`, `/var/lib/ceph`,
 *    `/var/lib/dpkg`, `/var/log`) have the same ancestor rule: `/var/spool`,
 *    `/var/lib` and `/var/log`'s parents are refused, while an unrelated
 *    `/var/lib/remote` or `/var/x` stays allowed.
 */
export const SYSTEM_MOUNT_TARGETS = [
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
] as const

/**
 * The list entries whose ENTIRE subtree is off-limits, at any depth. Derived
 * from SYSTEM_MOUNT_TARGETS: drop `/` (everything is under it), the roots
 * that are legitimate remote-mount parents (`/home`, `/srv`, `/var`, `/tmp`)
 * and `/root` (nothing below it matters to the OS — it is a home directory),
 * keep the boot-critical and virtual-filesystem roots. `/lib*` covers
 * `/lib` and `/lib64` (the distro usrmerge layouts).
 */
const NEVER_MOUNT_UNDER: readonly string[] = SYSTEM_MOUNT_TARGETS.filter(entry =>
  entry !== '/'
  && entry !== '/home'
  && entry !== '/root'
  && entry !== '/srv'
  && entry !== '/tmp'
  && entry !== '/var',
)

/**
 * The shape the system-target rule is matched against: POSIX-normalized
 * (collapses `//`, `/./` and `..` — the schema already refuses `..`), with
 * the leading slashes collapsed (Node's `normalize` keeps a leading `//`,
 * which POSIX says is implementation-defined — ANAS treats it as `/`) and
 * the trailing slash stripped (`/` itself stays `/`). The routes pass mount
 * points through as given (`AbsolutePath` validates the shape but never
 * rewrites it), so this is the normalization the guard defines and uses.
 */
const TRAILING_SLASHES_RE = /\/+$/

export function normalizeMountpointPath(mountpoint: string): string {
  const n = normalize(mountpoint).replace(LEADING_SLASHES_RE, '/')
  return n.length > 1 ? n.replace(TRAILING_SLASHES_RE, '') : n
}

/** The machine-readable cause every system- or protected-mount-target refusal carries. */
export const MOUNT_TARGET_REFUSAL_REASON = 'system-mount-target' as const

/**
 * One protected mount-target rule (cr.52, review H1): the paths a mountpoint
 * must not be at or under, among the credential and login trees cr.18's list
 * deliberately left open. cr.18 refused a remote share equal to a system root
 * and anything under the boot-critical/virtual roots ({@link NEVER_MOUNT_UNDER})
 * but ALLOWED everything under `/root`, `/home`, `/srv`, `/opt`, `/var` and
 * `/tmp` — so `/root/.ssh` and `/var/spool/cron/crontabs` passed — and a ZFS
 * pool, a dataset or an AHR pool had no such list at all. Every entry here is
 * refused at the path itself and at any depth below it. A trailing `*` matches
 * any suffix (`/var/lib/pve*`); a lone `*` matches exactly one segment (the
 * `/home`-`.ssh` rule, e.g. `/home/<user>/.ssh`).
 */
export interface MountTargetRefusalRule {
  /** The protected root, matched at `/` boundaries. */
  root: string
  /** The reason clause the refusal's sentence prints (constants only — user input never reaches it). */
  reason: string
}

export const MOUNT_TARGET_REFUSALS: ReadonlyArray<MountTargetRefusalRule> = [
  { root: '/root', reason: 'root\'s home holds SSH keys, dotfiles and shell state' },
  { root: '/home/*/.ssh', reason: 'an SSH key directory (authorized_keys and any private keys)' },
  { root: '/var/spool/cron', reason: 'the system cron jobs' },
  { root: '/var/lib/pve*', reason: 'PVE\'s cluster filesystem and state under /var/lib/pve' },
  // cr.52r P1: four more state trees a mount can hide in the way pve* already
  // could — a guest rootfs tree, Ceph's local state, dpkg's ledger and the logs.
  { root: '/var/lib/vz', reason: 'PVE\'s container and VM rootfs trees (vz)' },
  { root: '/var/lib/ceph', reason: 'Ceph\'s local cluster state on a node' },
  { root: '/var/lib/dpkg', reason: 'dpkg\'s installed-package database' },
  { root: '/var/log', reason: 'the system logs' },
  { root: '/mnt/pve', reason: 'PVE territory — the §2 Mounts ruling reserves /mnt/pve' },
  { root: '/etc/pve', reason: 'PVE territory — /etc/pve is PVE\'s cluster filesystem (pmxcfs)' },
]

/** Escape one literal path segment for the protected-root matcher's regex. */
const SEGMENT_ESC_RE = /[.*+?^${}()|[\]\\]/g

/** Does `mp` sit at or under a protected root, at `/` boundaries? */
function atOrUnderProtectedRoot(mp: string, root: string): boolean {
  if (root.endsWith('*')) {
    // `/var/lib/pve*`: the prefix itself and any suffix of it.
    const prefix = root.slice(0, -1)
    return mp === prefix || mp.startsWith(prefix)
  }
  if (root.includes('*')) {
    // `/home/*/.ssh`: `*` is EXACTLY one segment (`/home/a/b/.ssh` does not match).
    const escaped = root.split('/').map(seg => seg === '*' ? '[^/]+' : seg.replace(SEGMENT_ESC_RE, '\\$&')).join('/')
    return new RegExp(`^${escaped}(/|$)`).test(mp)
  }
  return mp === root || mp.startsWith(`${root}/`)
}

/**
 * Is `mp` an ANCESTOR of a protected root (cr.52r D1)? A mount at an ancestor
 * hides the protected path below it: a mount at `/home` or `/home/alice` hides
 * any `/home/<user>/.ssh`, at `/var/spool` it hides `cron`, at `/var/lib` the
 * `pve*`/`vz`/`ceph`/`dpkg` roots, at `/mnt` the `pve` ruling's territory.
 * `mp` is an ancestor when the protected root's pattern is STRICTLY longer
 * than `mp` and `mp`'s segments match the pattern's leading segments (a `*`
 * matches exactly one segment, as it does at/under). A trailing `*` is
 * ignored here — the at-or-under rule already covers everything at or under
 * its fixed prefix, so only strict prefixes of it are discovered by this walk.
 */
function ancestorOfProtectedRoot(mp: string, root: string): boolean {
  const pattern = root.endsWith('*') ? root.slice(0, -1) : root
  const m = mp.split('/').filter(Boolean)
  const p = pattern.split('/').filter(Boolean)
  if (m.length >= p.length)
    return false
  for (let i = 0; i < m.length; i++) {
    if (p[i] !== '*' && p[i] !== m[i])
      return false
  }
  return true
}

/**
 * The sentence's reason clause for a NORMALIZED mountpoint the lexical rules
 * refuse, or null. The three shapes cr.18 defines (equal to a system target,
 * a strict `/`-boundary ancestor of one, inside a never-mount-under subtree)
 * plus the cr.52 protected rules, at/under a protected root OR at an ancestor
 * of one (cr.52r D1 — a mount that would sit above the protected path and hide
 * it is refused with the protected path named). Named the same path resolution
 * the refusal applies to the resolved mountpoint after a symlinked parent.
 */
export function lexicalMountTargetReason(mp: string): string | null {
  for (const entry of SYSTEM_MOUNT_TARGETS) {
    if (mp === entry)
      return `the system path '${entry}'`
    // Ancestor of a list entry: a strict '/'-boundary directory prefix
    // (`/us` is not an ancestor of `/usr`; `/et` neither; `/et/c`… no).
    if (entry.startsWith(`${mp}/`))
      return `an ancestor of the system path '${entry}'`
  }
  // The protected rules run BEFORE the never-mount-under loop so a path inside
  // BOTH (only `/etc/pve`: `/etc` is never-mount-under AND its own protected
  // root) answers with the PVE-territory sentence (cr.52r doc ruling: `/mnt/pve`
  // and `/etc/pve` answer one code — 409 system-mount-target — with the PVE
  // reason kept in the sentence).
  for (const rule of MOUNT_TARGET_REFUSALS) {
    if (atOrUnderProtectedRoot(mp, rule.root))
      return `at or under the protected '${rule.root}' tree (${rule.reason})`
    // cr.52r D1: an ancestor hides the protected path it would sit above —
    // the existing at-or-under rule only named paths AT or BELOW the root.
    if (ancestorOfProtectedRoot(mp, rule.root))
      return `an ancestor of the protected '${rule.root}' tree (${rule.reason})`
  }
  for (const entry of NEVER_MOUNT_UNDER) {
    if (mp.startsWith(`${entry}/`))
      return `inside the system path '${entry}'`
  }
  return null
}

/** The filesystem answers {@link mountTargetRefusal} needs: real fs in production, injected in tests. */
export interface MountTargetRefusalDeps {
  /**
   * The LONGEST ancestor of `path` that exists (lstat-based walk up, never
   * skipping on an intermediate ENOENT — cr.52r D2). `/` when nothing below
   * it exists.
   */
  longestExistingAncestor: (path: string) => Promise<string>
  /** Is `path` a symlink (lstat — intermediates followed, the leaf not)? false when it does not exist. */
  pathIsSymlink: (path: string) => Promise<boolean>
  /** The real path of `path`, resolved through symlinks; null when any component is missing. */
  realpath: (path: string) => Promise<string | null>
}

/** The real `longestExistingAncestor` — a plain lstat walk to `/` (cr.52r D2). */
async function realLongestExistingAncestor(path: string): Promise<string> {
  let p = path
  for (;;) {
    try {
      await lstat(p)
      return p
    }
    catch {
      /* fall through to the parent */
    }
    const parent = dirname(p)
    if (parent === p)
      return '/' // reached the root
    p = parent
  }
}

const REAL_FS_DEPS: MountTargetRefusalDeps = {
  longestExistingAncestor: realLongestExistingAncestor,
  async pathIsSymlink(path) {
    try {
      return (await lstat(path)).isSymbolicLink()
    }
    catch {
      return false
    }
  },
  async realpath(path) {
    try {
      return await realpath(path)
    }
    catch {
      return null
    }
  },
}

/** Every `/`-separated descendant prefix of `path` (`/a/b` → `/a`, `/a/b`); none for `/`. */
function descendantPrefixes(path: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const seg of path.split('/').filter(Boolean)) {
    cur += `/${seg}`
    out.push(cur)
  }
  return out
}

/**
 * The ONE wiring every door that sets a mountpoint uses (cr.52): a guard gate
 * that asks {@link mountTargetRefusal} when a mountpoint is set, or passes when
 * the request set none. A gate runs at the route AND in the job (ruling (j)), so
 * the verdict the job re-applies is the same object the route answered.
 */
export function mountTargetGate<O>(mountpoint: string | undefined): Gate<O> {
  return async () => (mountpoint === undefined ? null : mountTargetRefusal(mountpoint))
}

/**
 * Why a mountpoint is refused, asked at every door that sets one (cr.52,
 * review H1; cr.52r D1/D2):
 *
 *  1. the typed path against cr.18's system targets (equal, a strict ancestor
 *     of one, inside a never-mount-under subtree) and the protected roots,
 *     at/under them AND at an ANCESTOR of one (D1 — a mount at `/home/alice`
 *     hides that user's `.ssh`, at `/var/spool` the cron tree, ...);
 *  2. the mountpoint RESOLVED against the longest EXISTING ancestor (D2): walk
 *     up until a component exists — an ENOENT on an intermediate never skips
 *     the step — lstat every existing component and refuse ANY symlink in it
 *     (a planted link must not launder the target past the lexical list), then
 *     realpath the existing ancestor and re-run the lexical list at the
 *     mountpoint as resolved.
 *
 * ONE code and ONE sentence shape everywhere: the caller returns this object
 * straight off a gate, so the route's 409 and the job's failure carry the same
 * code, reason and phrasing (a gate the job re-runs re-examines the filesystem
 * as it is when the job starts — a review flip between the doors is caught).
 */
export async function mountTargetRefusal(
  mountpoint: string,
  deps: MountTargetRefusalDeps = REAL_FS_DEPS,
): Promise<Refusal | null> {
  const mp = normalizeMountpointPath(mountpoint)
  const say = (message: string): Refusal => ({
    status: 409,
    code: 'CONFLICT',
    reason: MOUNT_TARGET_REFUSAL_REASON,
    message,
  })

  // (1) The typed path, as typed.
  const typed = lexicalMountTargetReason(mp)
  if (typed)
    return say(`Mountpoint '${mp}' is ${typed} — a mount there is refused`)

  // (2) Resolved against the LONGEST EXISTING ancestor (cr.52r D2). The empty
  // segments an intermediate ENOENT would once have skipped are walked now:
  // every component that EXISTS below `/` is lstat'd, and a symlink anywhere
  // in the existing part is refused outright (the same rule the mount-side
  // fd-pin enforces, cr.52r D3) — a symlinked parent `l -> /etc` is refused
  // whether or not `l/newdir` exists yet. Then the existing ancestor is
  // realpath'd and the resolved mountpoint gets the lexical list again.
  const ancestor = await deps.longestExistingAncestor(mp)
  // The leaf check has its own sentence; the walk here covers everything above
  // it (when the whole path exists, that is exactly its parents).
  const existingParents = ancestor === mp ? dirname(ancestor) : ancestor
  for (const comp of descendantPrefixes(existingParents)) {
    if (await deps.pathIsSymlink(comp))
      return say(`Mountpoint '${mp}' is refused — '${comp}' in its parent path is a symlink (a planted symlink must not redirect the mount)`)
  }
  // The FINAL component: a symlink is refused outright, whether or not it
  // resolves somewhere protected — the mount would land at the link's target,
  // not where the operator typed (lstat: the component itself is not followed).
  if (ancestor === mp && await deps.pathIsSymlink(mp))
    return say(`Mountpoint '${mp}' ends in a symlink — a mount over a symlinked directory is refused`)

  // The compare: an existing ancestor that RESOLVES somewhere different must
  // not slip the resolved mountpoint past the lexical list (with every symlink
  // already refused above this only ever confirms, but an ENOENT intermediate
  // can no longer skip it — the no-symlink check and the resolve share the
  // walk to the same ancestor).
  const resolvedAncestor = await deps.realpath(ancestor)
  if (resolvedAncestor !== null && resolvedAncestor !== ancestor) {
    const resolved = normalizeMountpointPath(resolvedAncestor + mp.slice(ancestor.length))
    const laundered = lexicalMountTargetReason(resolved)
    if (laundered)
      return say(`Mountpoint '${mp}' resolves via '${ancestor}' to '${resolved}', ${laundered} — a mount there is refused`)
  }

  return null
}

// ============================================================================
// Mountpoint-tree swapping: where ZFS mounts for itself (cr.52r D3)
// ============================================================================

/** The machine-readable reason of a refusal for a mountpoint tree a non-root writer could swap. */
export const SWAP_STAGE_REFUSAL_REASON = 'mount-target-swap-unsafe' as const

/** The filesystem answers {@link swapStageRefusal}: real fs in production, injected in tests. */
export interface SwapStageRefusalDeps {
  /** The LONGEST existing ancestor of `path` (as {@link MountTargetRefusalDeps}). */
  longestExistingAncestor: (path: string) => Promise<string>
  /** lstat attributes of `path`; null when it does not exist. */
  dirAttr: (path: string) => Promise<{ uid: number, mode: number } | null>
}

/** The mode bits that let someone OTHER than the owner rename a directory in place. */
export const GROUP_OTHER_WRITE_MODE = 0o022
/** The sticky bit — a 1777-style tree where only the owner of a name may rename or unlink it. */
export const STICKY_MODE = 0o1000

/** The file-type bits of an lstat mode, and the symlink type (S_IFMT / S_IFLNK). */
const S_IFMT_MODE = 0o170000
const S_IFLNK_MODE = 0o120000

/**
 * cr.52r D3's ZFS half. The daemon cannot fd-pin a mountpoint ZFS mounts by
 * itself (`zpool create -m`, `zpool import`, `zfs create -o mountpoint`, a
 * `zfs set mountpoint`): the window between the gate and ZFS's own `mount` is
 * ZFS's, and a swap (rename a directory away, plant a symlink) inside it
 * would redirect the kernel mount at a tree the gate never re-checked. The
 * residual cannot be eliminated — document it, and close the avenue that makes
 * it practical: nobody but root may be able to rename, replace or CREATE any
 * name on the mountpoint's path. Concretely (cr.52s-a, review defect 5):
 *
 *  - every EXISTING component, the LEAF included, is root-owned (the owner of a
 *    name can always rename it, even inside a sticky directory);
 *  - every existing component that is the PARENT of another existing component
 *    is not group/other-writable — unless it is sticky (1777 — `/tmp`,
 *    `/var/tmp`): there only a name's owner can rename it away, and the child
 *    is root-owned by the rule above;
 *  - when the mountpoint does not fully exist, the deepest existing component
 *    is the would-be parent of a name ZFS will create: it must be root-owned
 *    and not group/other-writable, with NO sticky exception — in a sticky
 *    directory anyone can create (squat) a missing name first.
 *
 * So `/tmp/alice` (user-owned) and `/tmp/newpool` (missing under 1777) refuse,
 * `/tmp/rootdir` (existing, root-owned) passes, `/srv/newpool` (missing under a
 * root-owned 0755) passes. A symlink component is refused here too (the
 * mount-target refusal that runs first names it more precisely). Refuses
 * naming the offending directory; null when the path is safe.
 *
 * The residual this leaves (documented for the operator): a ROOT-authorized
 * actor still can swap the tree after this check, and a swap in the instant
 * between the check and ZFS's mount resolves to wherever the new path points.
 * Both are outside ANAS's reach — the daemon does not own ZFS's mount window.
 */
export async function swapStageRefusal(
  mountpoint: string,
  deps: SwapStageRefusalDeps = { longestExistingAncestor: realLongestExistingAncestor, dirAttr: realDirAttr },
): Promise<Refusal | null> {
  const mp = normalizeMountpointPath(mountpoint)
  const existing = await deps.longestExistingAncestor(mp)
  const missing = existing !== mp
  const chain = descendantPrefixes(existing)
  const say = (comp: string, why: string): Refusal => ({
    status: 409,
    code: 'CONFLICT',
    reason: SWAP_STAGE_REFUSAL_REASON,
    message: `Mountpoint '${mp}' is refused — ${comp === mp ? 'the mountpoint directory itself' : `its ancestor directory '${comp}'`} ${why}. `
      + 'ZFS mounts there by itself, and a path on which a non-root user could rename, replace or create a name would let that mount be redirected.'
      + ` Make '${comp}' root-owned and not group/other-writable, or choose another mountpoint`,
  })
  for (let i = 0; i < chain.length; i++) {
    const comp = chain[i]!
    const attr = await deps.dirAttr(comp)
    // Gone since the walk found it: the path is changing under the check —
    // fail closed rather than pass a chain that was never fully seen.
    if (attr === null)
      return say(comp, 'vanished while it was being checked')
    if ((attr.mode & S_IFMT_MODE) === S_IFLNK_MODE)
      return say(comp, 'is a symlink')
    const writableByOthers = (attr.mode & GROUP_OTHER_WRITE_MODE) !== 0
    const sticky = (attr.mode & STICKY_MODE) !== 0
    const notRoot = attr.uid !== 0
    const isLast = i === chain.length - 1
    // The would-be parent of a name ZFS will create: no sticky exception.
    if (isLast && missing) {
      if (notRoot || writableByOthers) {
        const why = [
          notRoot ? 'not root-owned' : '',
          writableByOthers ? `group/other-writable${sticky ? ' (sticky does not stop another user creating the missing name first)' : ''}` : '',
        ].filter(Boolean).join(' and ')
        return say(comp, `is ${why}`)
      }
      continue
    }
    if (notRoot)
      return say(comp, 'is not root-owned')
    // A parent of an existing (root-owned) component: writable only if sticky.
    if (!isLast && writableByOthers && !sticky)
      return say(comp, 'is group/other-writable')
  }
  return null
}

/** lstat mode + owner of `path` for {@link swapStageRefusal}; null when absent. */
async function realDirAttr(path: string): Promise<{ uid: number, mode: number } | null> {
  try {
    const st = await lstat(path)
    return { uid: st.uid, mode: st.mode }
  }
  catch {
    return null
  }
}

/** The swap-stage refusal as a guard gate (cr.52r D3's ZFS half) — a gate, so it re-runs in the job. */
export function swapStageGate<O>(mountpoint: string | undefined): Gate<O> {
  return async () => (mountpoint === undefined ? null : swapStageRefusal(mountpoint))
}

// ============================================================================
// Mounting through a directory the daemon itself opened (cr.52r D3)
// ============================================================================

/**
 * The target every daemon-run `mount(8)` gets: the kernel resolves it to the
 * opened directory. The trailing `/.` is load-bearing (stunt node, util-linux
 * 2.41.5 / kernel 7.0, 2026-10-17): libmount's new-API path ends in
 * `move_mount(fs, "", AT_FDCWD, target, MOVE_MOUNT_F_EMPTY_PATH)`, and
 * `move_mount` does NOT follow a trailing symlink — a bare `/proc/self/fd/3`
 * IS the magic link, so the kernel answered EINVAL ("wrong fs type, bad
 * option, bad superblock") for every fd-pinned mount, btrfs and ext4 alike,
 * while the classic `mount(2)` path (LIBMOUNT_FORCE_MOUNT2) accepted it. With
 * `/.` the magic link is a middle component, which every path walk follows,
 * and the final `.` is the opened directory itself: proven on the node with
 * `-c` for btrfs and ext4, and still race-free (the walk goes through the fd,
 * never through a textual path).
 */
export const FD_MOUNT_TARGET = '/proc/self/fd/3/.' as const
/** The child's fd the daemon-opened directory is handed at (the first inherited fd). */
export const FD_MOUNT_SLOT = 3

/** A mount-target directory the daemon opened O_PATH — a pin the kernel resolves, not a path string. */
export interface OpenedMountTarget {
  /** The child's fd number (its `/proc/self/fd/<n>` path). */
  fd: number
  /** Close the descriptor, once the mount child has exited. */
  close: () => Promise<void>
}

/**
 * Open `mountpoint` as a mount target the DAEMON pinned (cr.52r D3): lstat
 * every component (a symlink anywhere in the existing part refuses), then open
 * the final directory `O_PATH | O_DIRECTORY | O_NOFOLLOW` so a parent swapped
 * AFTER the open cannot move what mount(8) will land on (`/proc/self/fd/N`
 * resolves in the child to exactly this directory). Throws when a component is
 * a symlink or the final directory is missing — callers MKDIR the mountpoint
 * first, and the re-mount verbs' job refuses before they get here.
 */
export async function openMountTarget(mountpoint: string): Promise<OpenedMountTarget> {
  const mp = normalizeMountpointPath(mountpoint)
  // The symlink walk mirrors the refusal's step (2), run again HERE — the
  // instant of the mount — so a link planted between the gate and the argv
  // cannot launder the target past the check that just passed.
  const ancestor = await realLongestExistingAncestor(mp)
  const existingParents = ancestor === mp ? dirname(ancestor) : ancestor
  for (const comp of descendantPrefixes(existingParents)) {
    const st = await lstat(comp).catch(() => null)
    if (st?.isSymbolicLink())
      throw new Error(`Mountpoint '${mp}' is refused — '${comp}' in its parent path is a symlink (a planted symlink must not redirect the mount)`)
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_PATH|O_DIRECTORY|O_NOFOLLOW: an O_PATH descriptor pins the directory
    // for the kernel, O_DIRECTORY refuses non-dirs, O_NOFOLLOW refuses a final
    // symlink (the lstat walk above already covered the parents). Some @types
    // fail to list O_PATH in `constants`' union — it exists at runtime on Linux.
    const O_PATH = (FS_CONSTANTS as Record<string, number>).O_PATH
    handle = await open(mp, O_PATH | FS_CONSTANTS.O_DIRECTORY | FS_CONSTANTS.O_NOFOLLOW)
  }
  catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOTDIR' || e.code === 'ENOENT') {
      // O_DIRECTORY|O_NOFOLLOW on a symlinked LEAF answers ENOTDIR on Linux,
      // not ELOOP — name the symlink rather than "does not exist".
      const leaf = await lstat(mp).catch(() => null)
      if (leaf?.isSymbolicLink())
        throw new Error(`Mountpoint '${mp}' is a symlink — a mount over a symlinked directory is refused; nothing was mounted`)
      throw new Error(`Mountpoint '${mp}' does not exist as a directory — the component above it is missing or the path is broken; nothing was mounted`)
    }
    if (e.code === 'ELOOP')
      throw new Error(`Mountpoint '${mp}' is a symlink (or its chain loops) — a mount over a symlinked directory is refused`)
    throw err
  }
  const fd = handle.fd
  if (fd === undefined) {
    await handle.close()
    throw new Error(`Could not open mountpoint '${mp}' as a mount target`)
  }
  // cr.52s-a (review defect 4): the lstat walk above and the open are separate
  // syscalls, and O_NOFOLLOW guards only the LAST component — an intermediate
  // exchanged for a symlink between the two is followed by the open (measured:
  // 19,596 of 70,972 opens under a renameat2 flip loop landed on the victim).
  // So prove, AFTER the open, that the inode the descriptor pins IS the
  // checked path: the kernel's own name for it (`/proc/self/fd/N`, the
  // dentry's path at this instant) must equal the normalised mountpoint.
  // Why this closes the race: a descriptor that landed on `/etc/<leaf>` reads
  // back as `/etc/<leaf>`, and only someone who can write `/etc` could move
  // that directory to the checked name — a non-root writer on the mountpoint's
  // parent chain cannot. What it does NOT close: a root-owned path re-pointed by
  // root itself (the operator's own act), and a swap that renames the CHECKED
  // directory away after the open — that one only refuses here (the name no
  // longer matches) or, after this check, moves a pin that still names the
  // directory the walk checked.
  let pinned: string | null
  try {
    pinned = await readlink(`/proc/self/fd/${fd}`)
  }
  catch {
    pinned = null
  }
  if (pinned !== mp) {
    await handle.close()
    throw new Error(`Mountpoint '${mp}' is refused — the directory opened for the mount is ${pinned === null ? 'unnamed' : `'${pinned}'`}, not the checked path: `
      + 'a component of the path was swapped between the symlink check and the open (a planted symlink must not redirect the mount); nothing was mounted')
  }
  return {
    fd,
    close: () => handle.close(),
  }
}

/**
 * Run `mount <...argv> /proc/self/fd/3/.` through a directory the daemon opened
 * (cr.52r D3): open the final directory O_PATH, hand its fd to the mount child
 * (`exec`'s {@link ExecOptions.inheritedFds}), target the fd path, close the
 * fd when the child has exited. `-c` (--no-canonicalize) is REQUIRED on every
 * fd-pinned mount: without it util-linux canonicalises `/proc/self/fd/3` to a
 * real path string and mounts onto THAT — the very redirect the pin exists to
 * stop (the fd path resolves in the kernel, a path string does not). The
 * callers pass `-c` as their first token; this helper also guarantees it
 * (cr.52s-a: the comment used to say so while the helper did not), adding it
 * in front when an argv lacks it.
 */
export async function mountThroughOpenedDir(
  executor: CommandExecutor,
  mountpoint: string,
  argv: readonly string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  const args = argv.includes('-c') || argv.includes('--no-canonicalize') ? [...argv] : ['-c', ...argv]
  const open = await openMountTarget(mountpoint)
  try {
    return await executor.exec(MOUNT, [...args, FD_MOUNT_TARGET], { ...opts, inheritedFds: [open.fd] })
  }
  finally {
    await open.close()
  }
}

/**
 * Create the mountpoint directory of a remote-mount create THROUGH ITS OPENED
 * PARENT (cr.52s-c): the parent is opened exactly the way {@link
 * openMountTarget} opens a target (`O_PATH | O_DIRECTORY | O_NOFOLLOW` plus the
 * readlink proof that the pinned inode IS the checked path), and the leaf is
 * created at `/proc/self/fd/<parentFd>/<leaf>` — node has no mkdirat(2), but an
 * O_PATH descriptor is resolvable THROUGH `/proc/self/fd` by the kernel, so the
 * mkdir lands IN the pinned directory however the textual path moves
 * afterwards. `mkdir(path, { recursive: true })` on the textual path is exactly
 * what this replaces: it follows every symlink it meets, so a parent swapped
 * for a link between the job's re-gate and the mkdir used to create directories
 * THROUGH the link as root.
 *
 * The parent must EXIST: no recursive creation of a chain a non-root user could
 * re-point (a missing parent is refused naming it). An existing leaf directory
 * is success (what `mkdir(recursive)` treated as success still is); an existing
 * non-directory is refused. Throws with the state named — "nothing was
 * created" — on every refusal; the caller has nothing to roll back.
 */
export async function createMountpointThroughOpenedParent(mountpoint: string): Promise<void> {
  const mp = normalizeMountpointPath(mountpoint)
  const parent = dirname(mp)
  const leaf = basename(mp)
  // The parent must already exist. (The remote-create door's gates never
  // create chains — unlike the ZFS doors, swapStageRefusal is not one of them,
  // so no existing rule answers this case; the refusal is this function's.)
  const parentExists = await lstat(parent).then(() => true, () => false)
  if (!parentExists)
    throw new Error(`Mountpoint '${mp}' cannot be created — its parent '${parent}' does not exist (ANAS creates the mountpoint only inside an existing parent; it never creates a chain of directories a user could re-point); nothing was created`)
  let open: OpenedMountTarget
  try {
    // The same pin + proof the mount itself will use — a parent swapped for a
    // symlink (or a component swapped under the open) refuses HERE, naming the
    // swapped path, before a leaf is created anywhere.
    open = await openMountTarget(parent)
  }
  catch (err) {
    throw new Error(`Mountpoint '${mp}' cannot be created — ${err instanceof Error ? err.message : String(err)}; nothing was created`)
  }
  try {
    // The fd path, not the textual path: the kernel resolves it to the pinned
    // inode, so this mkdir cannot land through a swapped link.
    await mkdir(`/proc/self/fd/${open.fd}/${leaf}`)
  }
  catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EEXIST') {
      // mkdir(recursive) treated an existing DIRECTORY as success — keep that,
      // but prove it (a leaf swapped for a symlink must NOT become success; the
      // fd-pinned mount that follows refuses it, and the operator hears why).
      const leafSt = await lstat(join(parent, leaf)).catch(() => null)
      if (leafSt !== null && !leafSt.isSymbolicLink() && leafSt.isDirectory())
        return
      throw new Error(`Mountpoint '${mp}' already exists and is not a directory — refused; nothing was created`)
    }
    throw new Error(`Mountpoint '${mp}' cannot be created — ${e.code ?? String(err)}; nothing was created`)
  }
  finally {
    await open.close()
  }
}

/** Does the fstab already define this mountpoint? */
export function fstabHasMount(fstabText: string, mountpoint: string): boolean {
  return parseFstab(fstabText).some(e => e.mountpoint === mountpoint)
}

/**
 * Story cr.39 (WAVE3-DESIGN §3.3, Mount row): the REVISION of a mount's
 * fstab line — a sha256 of its raw bytes, whichever form it is in (active, the
 * new-form disabled line, an old `#ANAS ` line). An edit is computed from the
 * line as the request read it; the job compares this before it writes the
 * merged line, so a line changed in between is never overwritten with a merge
 * of its old self. Null when the file has no line for the mountpoint.
 */
export function fstabLineRevision(fstabText: string, mountpoint: string): string | null {
  const line = parseFstabDoc(fstabText).find(l => l.kind === 'entry' && l.entry.mountpoint === mountpoint)
  return line ? createHash('sha256').update(line.raw).digest('hex') : null
}
