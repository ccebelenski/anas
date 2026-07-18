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
import { lookup } from 'node:dns/promises'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { classifyKind, isPseudoFstype, isSystemMountTarget, optionsReadOnly, parseFindmnt } from '../parsers/findmnt.js'
import { getMount, parseFstab } from '../parsers/fstab.js'
import { readPveMountPaths } from '../parsers/pve-storage.js'
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
): MountSummary[] {
  const nodes = parseFindmnt(findmntText).filter(n => !isPseudoFstype(n.fstype) && !isSystemMountTarget(n.target))
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
      readOnly: optionsReadOnly(node.options),
    })
  }

  // Overlay fstab: mark persistent / automount / disabled, add unmounted rows.
  for (const entry of entries) {
    const row = byTarget.get(entry.mountpoint)
    if (row) {
      row.persistent = true
      row.automount = row.automount || entry.options.common.automount
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
    // Reflect fstab automount even where findmnt shows a plain nfs4 (already
    // handled), and keep automount truthful for configured rows.
    const entry = entryByMount.get(row.mountpoint)
    if (entry)
      row.automount = row.automount || entry.options.common.automount
  }

  const rows = [...byTarget.values()]
  rows.sort((a, b) => a.mountpoint.localeCompare(b.mountpoint))
  return rows
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
    if (!s.persistent || s.pveManaged)
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
  opts: { fstabPath: string, storagePath?: string },
): Promise<DashboardWarning[]> {
  try {
    const [findmntText, fstabText, pveMountPaths] = await Promise.all([
      readFindmnt(executor),
      readConfig(opts.fstabPath),
      readPveMountPaths(opts.storagePath),
    ])
    const rows = buildBaseInventory(findmntText, fstabText, pveMountPaths)
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

/**
 * Apply the server-enforced option defaults (18.5), returning the resolved
 * structured options + advisory warnings:
 *  - `nofail` FORCED on every ANAS-written entry.
 *  - `_netdev`, `nosuid`, `nodev` default-on for nfs/cifs (respecting explicit off).
 *  - NFS `vers=4.2` + `hard` default; `soft` surfaces a corruption warning.
 *  - CIFS `vers=3.1.1` default; explicit `vers=1.0` surfaces a loud warning.
 */
export function applyMountDefaults(
  type: MountType,
  input: MountRequestOptions | undefined,
  automount: boolean,
  extraOptions?: string,
): { options: MountOptions, warnings: string[] } {
  const warnings: string[] = []
  const remote = type === 'nfs' || type === 'cifs'
  const o = input ?? {}

  const common = {
    readOnly: o.ro ?? false,
    nofail: true, // FORCED
    noauto: false,
    automount,
    noatime: o.noatime ?? false,
    nosuid: o.nosuid ?? remote,
    nodev: o.nodev ?? remote,
    netdev: remote,
    ...(o.idleTimeout !== undefined ? { automountIdleTimeout: o.idleTimeout } : {}),
  }

  const options: MountOptions = { common, passthrough: extraOptions ?? '' }

  if (type === 'nfs') {
    const nfs: NonNullable<MountOptions['nfs']> = {
      vers: o.vers ?? '4.2',
      hard: o.hard ?? true,
    }
    if (o.timeo !== undefined)
      nfs.timeo = o.timeo
    if (o.retrans !== undefined)
      nfs.retrans = o.retrans
    if (o.rsize !== undefined)
      nfs.rsize = o.rsize
    if (o.wsize !== undefined)
      nfs.wsize = o.wsize
    if (nfs.hard === false)
      warnings.push('Soft NFS mounts can silently corrupt data on a timeout — prefer hard,nofail unless you understand the risk.')
    options.nfs = nfs
  }
  else if (type === 'cifs') {
    const cifs: NonNullable<MountOptions['cifs']> = { vers: o.vers ?? '3.1.1' }
    if (o.domain !== undefined)
      cifs.domain = o.domain
    if (o.uid !== undefined)
      cifs.uid = o.uid
    if (o.gid !== undefined)
      cifs.gid = o.gid
    if (o.fileMode !== undefined)
      cifs.fileMode = o.fileMode
    if (o.dirMode !== undefined)
      cifs.dirMode = o.dirMode
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
 * Write a per-mount credentials file atomically: ensure `dir` (0700 root), write
 * `<dir>/<name>.cred` 0600. The secret never touches argv/logs. Returns the file
 * path (referenced from fstab as `credentials=<path>`).
 */
export async function writeCredentialsFile(
  dir: string,
  mountpoint: string,
  creds: { username: string, password: string, domain?: string },
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  const path = credsFilePath(dir, mountpoint)
  const tmp = join(dirname(path), `.${credsFileName(mountpoint)}.anas.tmp`)
  await writeFile(tmp, formatCredentials(creds), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600).catch(() => {})
  return path
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

  const probe = await probeMountAttempt(executor, req)
  return { ...probe, stage: 'mount', dnsResolved: true, portReachable: true }
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

/**
 * A guarded probe mount into a throwaway private dir, then unmount. Returns the
 * verdict + detail; the mount is always cleaned up. CIFS credentials ride a temp
 * 0600 file (never argv).
 */
async function probeMountAttempt(
  executor: CommandExecutor,
  req: MountTestRequest,
): Promise<{ verdict: MountTestVerdict, detail?: string }> {
  const probeDir = await mkdtemp(join(tmpdir(), 'anas-mount-probe-'))
  let credsPath: string | undefined
  try {
    let args: string[]
    if (req.type === 'nfs') {
      const vers = req.vers ?? '4.2'
      const spec = `${req.server}:${req.remotePath ?? '/'}`
      args = ['15', MOUNT, '-t', 'nfs4', '-o', `vers=${vers},soft,timeo=10,retrans=1,retry=0`, spec, probeDir]
    }
    else {
      const vers = req.vers ?? '3.1.1'
      const spec = `//${req.server}/${req.remotePath ?? ''}`
      let opts = `vers=${vers}`
      if (req.credentials) {
        credsPath = join(probeDir, '.probe.cred')
        await writeFile(credsPath, formatCredentials(req.credentials), { encoding: 'utf8', mode: 0o600 })
        opts += `,credentials=${credsPath}`
      }
      args = ['15', MOUNT, '-t', 'cifs', '-o', opts, spec, probeDir]
    }

    const r = await executor.exec(TIMEOUT, args)
    if (r.exitCode === 0) {
      await executor.exec(UMOUNT, [probeDir]).catch(() => {})
      return { verdict: 'ok' }
    }
    const stderr = cleanMountStderr(r.stderr)
    const verdict = req.type === 'nfs' ? mapNfsFailure(stderr) : mapCifsFailure(stderr)
    return { verdict, detail: verdictDetail(req.type, verdict, stderr) }
  }
  finally {
    if (credsPath)
      await rm(credsPath, { force: true }).catch(() => {})
    await rm(probeDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** A human detail line for a verdict — never contains the secret. */
function verdictDetail(type: 'nfs' | 'cifs', verdict: MountTestVerdict, stderr: string): string {
  if (type === 'cifs' && verdict === 'auth-failed')
    return 'Authentication failed — check the username or password (SMB cannot tell which is wrong).'
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
  opts: { fstabPath: string, credsDir: string, storagePath?: string },
): Promise<MountDetail | null> {
  const [findmntText, fstabText, pveMountPaths] = await Promise.all([
    readFindmnt(executor),
    readConfig(opts.fstabPath),
    readPveMountPaths(opts.storagePath),
  ])
  const rows = buildBaseInventory(findmntText, fstabText, pveMountPaths)
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
  const effective = parseFindmnt(findmntText).find(n => n.target === mountpoint && n.fstype !== 'autofs')

  const detail: MountDetail = { ...row, health, warnings: [] }
  if (capacity)
    detail.capacity = capacity
  if (entry) {
    detail.entry = entry
    detail.configuredOptions = entry.options
    detail.fstabLine = fstabLineFor(fstabText, mountpoint)
  }
  if (effective)
    detail.effectiveOptions = effective.options

  const unit = await readUnitState(executor, mountpoint)
  if (unit)
    detail.unit = unit

  if (row.type === 'cifs') {
    const credPath = entry?.credentialsFile ?? credsFilePath(opts.credsDir, mountpoint)
    const meta = await readCredentialsMeta(credPath)
    detail.credentials = {
      set: meta.set,
      ...(meta.username ? { username: meta.username } : {}),
      ...(meta.domain ? { domain: meta.domain } : {}),
    }
  }

  return detail
}

/** The exact fstab line for `mountpoint`, or undefined. */
export function fstabLineFor(fstabText: string, mountpoint: string): string | undefined {
  for (const raw of fstabText.split('\n')) {
    if (raw.trim().startsWith('#') || raw.trim() === '')
      continue
    const hashIdx = raw.indexOf('#')
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
