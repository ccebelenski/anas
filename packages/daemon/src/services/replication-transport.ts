import type { ReplicationLocation, ReplicationRemote } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { RemotesPaths } from './replication-remotes.js'
import { readFile } from 'node:fs/promises'
import { readRemotes } from './replication-remotes.js'

/**
 * Stage-3 remote SSH transport (Epic 5.5.2).
 *
 * Push-only: the remote needs sshd + ZFS ONLY — never ANAS. Every remote op is
 * `ssh <target> zfs …` (list for base-discovery/lag, recv, hold). Two tiers:
 *  - peer  : a PVE cluster node — plain `ssh root@<node>` (PVE already shares
 *            root SSH trust + manages known_hosts; no -i, no custom known_hosts).
 *  - remote: an explicitly registered external host — `ssh -i <our key>
 *            -o UserKnownHostsFile=<our known_hosts> -o StrictHostKeyChecking=yes
 *            <user>@<host>` on the registered port.
 *
 * Remote `zfs`/`zpool` are invoked UNQUALIFIED (rely on the remote login PATH) —
 * we do not own the remote and cannot assume its binary layout (TrueNAS, plain
 * Linux, …).
 */

const SSH = '/usr/bin/ssh'

/** Where to find the cluster members file — overridable for tests. */
export function defaultMembersFile(): string {
  return process.env.ANAS_PVE_MEMBERS ?? '/etc/pve/.members'
}

export interface TransportConfig {
  paths: RemotesPaths
  membersFile: string
}

/** A resolved external remote — everything ssh needs to reach it. */
export interface ResolvedRemote {
  kind: 'remote'
  host: string
  port: number
  user: string
  keyPath: string
  knownHostsFile: string
}
/** A resolved cluster peer — reached as root over PVE-managed trust. */
export interface ResolvedPeer {
  kind: 'peer'
  /** The peer nodename (resolvable via PVE's /etc/hosts). */
  host: string
}
export type ResolvedLocation = ResolvedRemote | ResolvedPeer

export type ResolveResult
  = | { ok: true, resolved: ResolvedLocation }
    | { ok: false, error: string }

/** PVE cluster membership: this node's name + every node in the cluster. */
export interface PveMembers {
  nodename: string
  nodes: string[]
}

/** Parse `/etc/pve/.members` (JSON). Fail-open to null on any error. */
export async function readMembers(membersFile: string): Promise<PveMembers | null> {
  try {
    const j = JSON.parse(await readFile(membersFile, 'utf-8')) as {
      nodename?: unknown
      nodelist?: Record<string, unknown>
    }
    if (typeof j.nodename !== 'string' || !j.nodename)
      return null
    const nodes = j.nodelist && typeof j.nodelist === 'object' ? Object.keys(j.nodelist) : []
    return { nodename: j.nodename, nodes }
  }
  catch {
    return null
  }
}

/**
 * The exact ssh argv for a resolved location + remote command (argv[0] is the
 * ssh binary; callers split for exec/pipeline). Pure — the unit tests assert it.
 */
export function buildSshArgv(resolved: ResolvedLocation, remoteCmd: string[]): string[] {
  if (resolved.kind === 'peer')
    return [SSH, '-o', 'BatchMode=yes', `root@${resolved.host}`, ...remoteCmd]
  return [
    SSH,
    '-o',
    'BatchMode=yes',
    '-p',
    String(resolved.port),
    '-i',
    resolved.keyPath,
    '-o',
    `UserKnownHostsFile=${resolved.knownHostsFile}`,
    '-o',
    'StrictHostKeyChecking=yes',
    `${resolved.user}@${resolved.host}`,
    ...remoteCmd,
  ]
}

/** A ResolvedRemote from a registry entry. */
function resolvedFromRemote(remote: ReplicationRemote, paths: RemotesPaths): ResolvedRemote {
  return {
    kind: 'remote',
    host: remote.host,
    port: remote.port,
    user: remote.user,
    keyPath: paths.keyPath,
    knownHostsFile: paths.knownHostsFile,
  }
}

/** A ResolvedRemote from raw fields (the pre-registration test-connection probe). */
export function resolvedRemoteFields(
  paths: RemotesPaths,
  host: string,
  port: number,
  user: string,
): ResolvedRemote {
  return { kind: 'remote', host, port, user, keyPath: paths.keyPath, knownHostsFile: paths.knownHostsFile }
}

/** One snapshot name after the '@' of a `pool/ds@snap` line (or null). */
function snapNameOf(fullSnap: string): string | null {
  const at = fullSnap.indexOf('@')
  return at >= 0 ? fullSnap.slice(at + 1) : null
}

export interface Transport {
  resolveLocation: (location: ReplicationLocation) => Promise<ResolveResult>
  listPeers: () => Promise<string[]>
  sshExec: (resolved: ResolvedLocation, cmd: string[]) => Promise<ExecResult>
  buildSshArgv: (resolved: ResolvedLocation, cmd: string[]) => string[]
  remotePoolNames: (resolved: ResolvedLocation) => Promise<string[]>
  remotePoolExists: (resolved: ResolvedLocation, pool: string) => Promise<boolean>
  remoteDatasetExists: (resolved: ResolvedLocation, ds: string) => Promise<boolean>
  /** Snapshot NAMES (after the '@') present on a remote dataset (fail-open []). */
  remoteSnapshotNames: (resolved: ResolvedLocation, ds: string) => Promise<string[]>
  remoteHold: (resolved: ResolvedLocation, snapFull: string, tag: string) => Promise<ExecResult>
  remoteRelease: (resolved: ResolvedLocation, snapFull: string, tag: string) => Promise<ExecResult>
  remoteHeldTags: (resolved: ResolvedLocation, snapFull: string) => Promise<string[]>
}

/**
 * The transport bound to an executor + config. All remote reads fail open
 * (empty/false) so a probe failure never masquerades as data.
 */
export function createTransport(executor: CommandExecutor, config: TransportConfig): Transport {
  async function sshExec(resolved: ResolvedLocation, cmd: string[]): Promise<ExecResult> {
    const argv = buildSshArgv(resolved, cmd)
    return executor.exec(argv[0], argv.slice(1))
  }

  async function resolveLocation(location: ReplicationLocation): Promise<ResolveResult> {
    const { kind, name } = location
    if (kind === 'peer') {
      if (!name)
        return { ok: false, error: 'peer target requires a node name' }
      const members = await readMembers(config.membersFile)
      if (!members)
        return { ok: false, error: 'cannot read PVE cluster members (/etc/pve/.members) — not a cluster node?' }
      if (name === members.nodename)
        return { ok: false, error: `'${name}' is THIS node — use a local target, not a peer` }
      if (!members.nodes.includes(name))
        return { ok: false, error: `peer '${name}' is not a known cluster node` }
      return { ok: true, resolved: { kind: 'peer', host: name } }
    }
    if (kind === 'remote') {
      if (!name)
        return { ok: false, error: 'remote target requires a name' }
      const reg = await readRemotes(config.paths)
      const remote = reg.remotes.find(r => r.name === name)
      if (!remote)
        return { ok: false, error: `remote '${name}' is not registered` }
      return { ok: true, resolved: resolvedFromRemote(remote, config.paths) }
    }
    return { ok: false, error: `unsupported location kind '${kind}'` }
  }

  async function listPeers(): Promise<string[]> {
    const members = await readMembers(config.membersFile)
    if (!members)
      return []
    return members.nodes.filter(n => n !== members.nodename)
  }

  async function remotePoolNames(resolved: ResolvedLocation): Promise<string[]> {
    const r = await sshExec(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  }

  async function remotePoolExists(resolved: ResolvedLocation, pool: string): Promise<boolean> {
    return (await remotePoolNames(resolved)).includes(pool)
  }

  async function remoteDatasetExists(resolved: ResolvedLocation, ds: string): Promise<boolean> {
    const r = await sshExec(resolved, ['zfs', 'list', '-H', '-o', 'name', ds])
    return r.exitCode === 0
  }

  async function remoteSnapshotNames(resolved: ResolvedLocation, ds: string): Promise<string[]> {
    const r = await sshExec(resolved, ['zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name,creation', ds])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    const names: string[] = []
    for (const line of r.stdout.split('\n')) {
      if (!line.trim())
        continue
      const full = line.split('\t')[0]
      const n = snapNameOf(full)
      if (n)
        names.push(n)
    }
    return names
  }

  async function remoteHold(resolved: ResolvedLocation, snapFull: string, tag: string): Promise<ExecResult> {
    return sshExec(resolved, ['zfs', 'hold', tag, snapFull])
  }

  async function remoteRelease(resolved: ResolvedLocation, snapFull: string, tag: string): Promise<ExecResult> {
    return sshExec(resolved, ['zfs', 'release', tag, snapFull])
  }

  async function remoteHeldTags(resolved: ResolvedLocation, snapFull: string): Promise<string[]> {
    const r = await sshExec(resolved, ['zfs', 'holds', '-H', snapFull])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return r.stdout.split('\n').filter(Boolean).map(l => l.split('\t')[1]).filter(Boolean)
  }

  return {
    resolveLocation,
    listPeers,
    sshExec,
    buildSshArgv,
    remotePoolNames,
    remotePoolExists,
    remoteDatasetExists,
    remoteSnapshotNames,
    remoteHold,
    remoteRelease,
    remoteHeldTags,
  }
}
