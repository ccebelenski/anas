import type { ReplicationLocation, ReplicationRemote } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../executor/types.js'
import type { RemotesPaths } from './replication-remotes.js'
import { readFile } from 'node:fs/promises'
import { PoolName, RemoteHost } from '@anas/shared'
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

/**
 * The answer to "list this peer/remote's pools" (repl.r2).
 *
 * EXIT CODE decides, never stderr text: exit 0 is the host's answer, even when
 * it prints nothing (`pools: []` — a host with no pools). Any non-zero exit is
 * the host NOT ANSWERING — a refused key, a dead host, no `zpool` — and carries
 * the first non-empty line of its stderr (trimmed), or `ssh exited <n>` when
 * ssh said nothing. Before this, both cases collapsed into `[]`, and the target
 * guard told the operator a pool was missing when the truth was that nobody had
 * been asked (EPICS §2, "Guide, don't just warn").
 */
export type RemotePoolList
  = | { ok: true, pools: string[] }
    | { ok: false, error: string }

/** The answer to "does this peer/remote have that pool": yes, no, or why it could not say. */
export type PoolExistence
  = | {
    ok: true
    exists: boolean
    /**
     * cr3.followup: the pool is absent because ZFS is not available on the
     * node at all (the plain statement, `zfsUnavailableReason`). Local only.
     */
    zfsUnavailable?: string
  }
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
 * The liveness options every ssh carries (cr.35, WAVE3-DESIGN §6.3).
 *
 * - `ConnectTimeout=10`: a host that never answers the SYN (down, firewalled,
 *   partitioned) ends the ssh at 10 s with exit 255 — the caller's
 *   "unreachable" — instead of at the kernel's TCP retry limit (minutes).
 * - `ServerAliveInterval=15` + `ServerAliveCountMax=4`: a peer that dies MID
 *   STREAM (the `zfs send | ssh zfs recv` pipeline, which has no deadline of
 *   its own — `null-sites.test.ts`) ends the ssh after a minute of unanswered
 *   keepalives, so the pipe breaks and the job fails instead of waiting on a
 *   dead socket for ever. Keepalives ride the encrypted channel, so an idle
 *   but healthy remote (a long `zfs recv` write) answers them and is never cut.
 */
export const SSH_LIVENESS_OPTIONS: readonly string[] = Object.freeze([
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
])

/**
 * A word the remote shell splits on nothing: ASCII letters, digits and
 * `_ @ % + = : , . / -`. JS `\w` is ASCII-only (`[A-Za-z0-9_]`) without the `u`
 * flag, which this regex does not carry — say it here so nobody adds `u`.
 */
const SHELL_PLAIN_WORD_RE = /^[\w@%+=:,./-]+$/

const SINGLE_QUOTE_RE = /'/g

/** An embedded single quote as a shell needs it: close the quote, escape one, reopen. */
const SHELL_ESCAPED_QUOTE = `'\\''`

/**
 * One word for the REMOTE login shell (repl.r1).
 *
 * ssh does not pass an argv to the remote: it joins the words after the
 * destination with single spaces and hands that ONE string to the remote
 * user's shell, which splits it again. A plain word can go through unchanged;
 * any other word (a space, an empty string, anything outside the plain set)
 * must be single-quoted so the shell reads it as the one word ANAS meant,
 * whatever characters a later ZFS starts accepting in a name. An embedded
 * single quote is written `'\''` (close, escaped quote, reopen).
 *
 * What was run (review of repl.r1: sh, bash, csh, tcsh on the dev box): every
 * character ZFS accepts in a name round-trips byte for byte in all four. csh
 * and tcsh do NOT keep `!` or a raw newline literal inside single quotes
 * (history expansion; "Unmatched"), so this quoting is not a general-purpose
 * one for a csh login shell — ZFS refuses both characters in a name, and no
 * word ANAS sends can carry them.
 *
 * The empty string becomes `''`, never nothing: a dropped word would shift
 * every operand after it onto the wrong one.
 */
export function remoteShellWord(word: string): string {
  if (SHELL_PLAIN_WORD_RE.test(word))
    return word
  return `'${word.replace(SINGLE_QUOTE_RE, SHELL_ESCAPED_QUOTE)}'`
}

/**
 * The exact ssh argv for a resolved location + remote command (argv[0] is the
 * ssh binary; callers split for exec/pipeline). Pure — the unit tests assert it.
 * The remote words are quoted for the remote shell ({@link remoteShellWord});
 * every plain word is unchanged, so today's commands are byte-identical.
 */
export function buildSshArgv(resolved: ResolvedLocation, remoteCmd: string[]): string[] {
  const words = remoteCmd.map(remoteShellWord)
  // `--` ends ssh OPTION parsing (C1, review 2026-10-14): a hostile user/host
  // (e.g. `-oProxyCommand=<cmd>`) can then never be read as an ssh flag —
  // `ssh [options] -- destination command`. ssh-keyscan does the same
  // (services/replication-remotes.ts); the shared schemas additionally narrow
  // user/host on every write path.
  if (resolved.kind === 'peer')
    return [SSH, '-o', 'BatchMode=yes', ...SSH_LIVENESS_OPTIONS, '--', `root@${resolved.host}`, ...words]
  return [
    SSH,
    '-o',
    'BatchMode=yes',
    ...SSH_LIVENESS_OPTIONS,
    '-p',
    String(resolved.port),
    '-i',
    resolved.keyPath,
    '-o',
    `UserKnownHostsFile=${resolved.knownHostsFile}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '--',
    `${resolved.user}@${resolved.host}`,
    ...words,
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

/** ssh's exit status for its own failures (could not connect, refused the key, host key mismatch). */
const SSH_OWN_EXIT = 255

/** The longest failure line a sentence carries; the rest is the journal's. */
const FAILURE_LINE_MAX = 300

/** C0 control characters and DEL: a line bound for a JSON body, a job error and a mail body carries none. */
// eslint-disable-next-line no-control-regex
const FAILURE_CONTROL_RE = /[\x00-\x1F\x7F]/g

/**
 * What a FAILED ssh said, as one line for a sentence (repl.r2). Quoted, never
 * matched on. WHICH line depends on who failed:
 *
 *   - exit 255 is ssh itself, and OpenSSH puts its decoration FIRST and the
 *     reason LAST: a changed host key prints a box of `@@@@` and ends with
 *     `Host key verification failed.`; a key file with open permissions does
 *     the same and ends with `Permission denied (publickey).`; a remote sshd
 *     Banner comes before the refusal. So for 255 it is the LAST non-empty
 *     line (review of repl.r2: the first line was the `@@@@` row).
 *   - any other exit is the remote command, whose first line names the
 *     failure (`bash: line 1: zpool: command not found`).
 *
 * `ssh exited <n>` when stderr is empty. The line is stripped of control
 * characters and cut at {@link FAILURE_LINE_MAX}: it is text the far side
 * controls.
 */
function sshFailureLine(r: ExecResult): string {
  const lines = r.stderr.split('\n').map(l => l.replace(FAILURE_CONTROL_RE, ' ').trim()).filter(Boolean)
  const line = r.exitCode === SSH_OWN_EXIT ? lines.at(-1) : lines[0]
  if (line === undefined)
    return `ssh exited ${r.exitCode}`
  return line.length > FAILURE_LINE_MAX ? `${line.slice(0, FAILURE_LINE_MAX)}...` : line
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
  remotePoolNames: (resolved: ResolvedLocation) => Promise<RemotePoolList>
  remotePoolExists: (resolved: ResolvedLocation, pool: string) => Promise<PoolExistence>
  /**
   * @deprecated cr3: fail-open — a failed ssh reads as "absent". No caller is
   * left; use `readRemoteSnapshotNames` (services/replication-snapshots.ts),
   * which answers list / absent / could not read. Kept on the interface only
   * because a test double outside this area's fence still supplies it.
   */
  remoteDatasetExists: (resolved: ResolvedLocation, ds: string) => Promise<boolean>
  /**
   * @deprecated cr3: fail-open — a failed listing reads as `[]` ("nothing
   * replicated", "diverged"). No caller is left; use
   * `readRemoteSnapshotNames` (services/replication-snapshots.ts). Kept on
   * the interface only because a test double outside this area's fence still
   * supplies it.
   */
  remoteSnapshotNames: (resolved: ResolvedLocation, ds: string) => Promise<string[]>
  remoteHold: (resolved: ResolvedLocation, snapFull: string, tag: string) => Promise<ExecResult>
  remoteRelease: (resolved: ResolvedLocation, snapFull: string, tag: string) => Promise<ExecResult>
  remoteHeldTags: (resolved: ResolvedLocation, snapFull: string) => Promise<string[]>
}

/**
 * The transport bound to an executor + config. Reads do NOT all fail open, and
 * a caller must know which shape it holds: `remotePoolNames` and
 * `remotePoolExists` answer `{ ok: false, error }` on a failed listing (the
 * caller refuses), while `listPeers`, `remoteSnapshotNames` and
 * `remoteHeldTags` answer an empty list and `remoteDatasetExists` answers
 * false — an empty answer a caller cannot tell from "there are none".
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
    // cr3: a name read from a config file is validated where it enters the
    // daemon — the picker renders it. A PVE node name is a host name; one
    // that is not (RemoteHost's charset) is not offered.
    return members.nodes.filter(n => n !== members.nodename && RemoteHost.safeParse(n).success)
  }

  async function remotePoolNames(resolved: ResolvedLocation): Promise<RemotePoolList> {
    const r = await sshExec(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    // repl.r2: the exit code alone separates "answered" from "did not answer".
    // An exit 0 with empty stdout is a host with no pools — an answer.
    if (r.exitCode !== 0)
      return { ok: false, error: sshFailureLine(r) }
    // cr3 REPLICATION-M3: a line is a pool only when it passes the shared
    // PoolName — the far side's text enters the daemon here and is rendered
    // in the admin's PVE session (a pool picker), so a compromised target
    // must not get markup through. A line that fails is DROPPED, not made
    // a "could not list": such a name can never be a replication target
    // anyway (ReplicationTarget.pool is PoolName), a login banner printed
    // to stdout by the remote's shell rc must not take every real pool
    // with it, and an answer that did arrive is still an answer.
    return { ok: true, pools: r.stdout.split('\n').map(l => l.trim()).filter(l => PoolName.safeParse(l).success) }
  }

  async function remotePoolExists(resolved: ResolvedLocation, pool: string): Promise<PoolExistence> {
    const listed = await remotePoolNames(resolved)
    if (!listed.ok)
      return listed
    return { ok: true, exists: listed.pools.includes(pool) }
  }

  async function remoteDatasetExists(resolved: ResolvedLocation, ds: string): Promise<boolean> {
    // cr.21: `--` before the ds operand, on the REMOTE zfs too.
    const r = await sshExec(resolved, ['zfs', 'list', '-H', '-o', 'name', '--', ds])
    return r.exitCode === 0
  }

  async function remoteSnapshotNames(resolved: ResolvedLocation, ds: string): Promise<string[]> {
    const r = await sshExec(resolved, ['zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name,creation', '--', ds])
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
    // cr.21: `--` ends option parsing for the remote hold too.
    return sshExec(resolved, ['zfs', 'hold', '--', tag, snapFull])
  }

  async function remoteRelease(resolved: ResolvedLocation, snapFull: string, tag: string): Promise<ExecResult> {
    return sshExec(resolved, ['zfs', 'release', '--', tag, snapFull])
  }

  async function remoteHeldTags(resolved: ResolvedLocation, snapFull: string): Promise<string[]> {
    const r = await sshExec(resolved, ['zfs', 'holds', '-H', '--', snapFull])
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
