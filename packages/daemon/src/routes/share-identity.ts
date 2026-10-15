import type { ShareGroup, ShareUser } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor, ExecOptions, ExecResult } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { GroupEntry, PasswdEntry } from '../parsers/getent.js'
import type { PassdbEntry } from '../parsers/pdbedit.js'
import type { IdentityRefHit } from '../parsers/smb-conf.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { Advisory, Gate, GuardReads, GuardSpec, Refusal } from '../safety/guard.js'
import type { IdKind, OwnershipReadOpts } from '../services/identity-ids.js'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import {
  CreateGroupRequest,
  CreateShareUserRequest,
  LookupName,
  SetSmbPasswordRequest,
  SetUserEnabledRequest,
  UpdateGroupMembersRequest,
} from '@anas/shared'
import {
  isExpired,
  isMutableShareId,
  isShareRelevant,
  parseGroups,
  parsePasswd,
  parseShadowExpiry,
  primaryGroupName,
  toSystemGroup,
  userGroups,
} from '../parsers/getent.js'
import {
  parsePdbeditEntries,
  passdbEntry,
  passdbOwnedByOther,
  passdbServes,
} from '../parsers/pdbedit.js'
import { findIdentityReferences } from '../parsers/smb-conf.js'
import { gidClaim, guardCheck, guardConfirm, guarded, GuardRefusalError, idnameClaim, sendRefusal, uidClaim } from '../safety/guard.js'
import { readConfig } from '../services/config-writer.js'
import { ID_PICK_TRIES, idHolder, idOwnership, pickId } from '../services/identity-ids.js'
import { requireIdentity } from './identity.js'

// Command whitelist (Principle 5). Debian/PVE paths: user/group admin tools
// live in /usr/sbin; getent/gpasswd/smbpasswd/pdbedit in /usr/bin.
const GETENT = '/usr/bin/getent'
const USERADD = '/usr/sbin/useradd'
const USERMOD = '/usr/sbin/usermod'
const USERDEL = '/usr/sbin/userdel'
const GROUPADD = '/usr/sbin/groupadd'
const GROUPDEL = '/usr/sbin/groupdel'
const GPASSWD = '/usr/bin/gpasswd'
const SMBPASSWD = '/usr/bin/smbpasswd'
const PDBEDIT = '/usr/bin/pdbedit'

const NOLOGIN = '/usr/sbin/nologin'

/**
 * The actionable "no samba on this node" sentence (issue #6). smbpasswd lives in
 * `samba-common-bin`, which the `samba` package pulls in — naming the package
 * the operator actually installs keeps the fix one apt command. The installer
 * now guarantees samba, so this only fires on a node where it was removed.
 */
const SMB_NOT_INSTALLED
  = `Samba is not installed on this node — ${SMBPASSWD} is missing. Install it with: apt install samba`

/** The "useradd landed, smbpasswd didn't" wording, in one place. */
function halfCreated(name: string, reason: string): string {
  return `User '${name}' was created, but setting the SMB password failed: ${reason}`
}

/**
 * Default samba probe: is the whitelisted smbpasswd there and executable?
 * Stateless — asked fresh every time, never cached (Principle 11).
 */
async function smbpasswdIsInstalled(): Promise<boolean> {
  try {
    await access(SMBPASSWD, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

export interface ShareIdentityRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** Used by the delete routes' confirm gate (Principle 14). */
  confirmStore: ConfirmStore
  /**
   * Absolute path to smb.conf — the delete routes read it to refuse an
   * identity a share still names in any user-list parameter (identity.1d,
   * extended to the full cr.30 parameter set).
   */
  smbConfPath: string
  /**
   * Absolute path to /etc/exports — a create reads its export paths (with
   * smb.conf's share paths) as the share roots a picked uid/gid must own
   * nothing under (cr.29).
   */
  exportsPath: string
  /**
   * The cr.29 ownership check's clock and budget (default: `Date.now`, 10 s
   * per guard run); tests shorten them.
   */
  idCheck?: Pick<OwnershipReadOpts, 'now' | 'budgetMs'>
  /**
   * Is `smbpasswd` present and executable on this node? Defaults to a real
   * access(X_OK) probe. The dev mock overrides it to `true` (nothing is ever
   * really spawned there), and tests override it to `false` to prove the
   * missing-samba path.
   */
  smbpasswdAvailable?: () => Promise<boolean>
}

export async function shareIdentityRoutes(
  server: FastifyInstance,
  opts: ShareIdentityRouteOptions,
) {
  const { executor, jobQueue, confirmStore, smbConfPath, exportsPath } = opts
  const smbAvailable = opts.smbpasswdAvailable ?? smbpasswdIsInstalled

  /**
   * Run smbpasswd, turning a spawn failure into an actionable message. execFile
   * REJECTS on ENOENT/EACCES instead of returning an exit code (see
   * executor/prod.ts), so the `exitCode !== 0` guards at the call sites below
   * never fire on a node without samba — the operator got Node's raw
   * `spawn /usr/bin/smbpasswd ENOENT` instead (issue #6). The routes preflight
   * with `smbAvailable()`; this is the belt-and-braces for samba going away
   * between that check and the queued job actually running.
   */
  async function execSmbpasswd(args: string[], execOpts?: ExecOptions): Promise<ExecResult> {
    try {
      return await executor.exec(SMBPASSWD, args, execOpts)
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(SMB_NOT_INSTALLED)
      throw err
    }
  }

  // --- getent-backed reads (source-agnostic — the Epic 8 seam) --------------

  /** All passwd entries (getent passwd). */
  async function allUsers(): Promise<PasswdEntry[]> {
    const r = await executor.exec(GETENT, ['passwd'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return []
    return parsePasswd(r.stdout)
  }

  /** All group entries (getent group). */
  async function allGroups(): Promise<GroupEntry[]> {
    const r = await executor.exec(GETENT, ['group'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return []
    return parseGroups(r.stdout)
  }

  /**
   * The Samba passdb entries (pdbedit -L), STRICT: throws a sentence when the
   * passdb cannot be read. The post-smbpasswd verify (identity.3) uses this —
   * an unreadable passdb must not pass for "no entry" there.
   */
  async function readPassdb(): Promise<PassdbEntry[]> {
    let r: ExecResult
    try {
      r = await executor.exec(PDBEDIT, ['-L'])
    }
    catch (err) {
      throw new Error(`Could not read Samba's password database (pdbedit -L): ${err instanceof Error ? err.message : String(err)}`)
    }
    if (r.exitCode !== 0 && !r.stdout.trim())
      throw new Error(`Could not read Samba's password database (pdbedit -L): ${r.stderr.trim() || `exit code ${r.exitCode}`}`)
    return parsePdbeditEntries(r.stdout)
  }

  /**
   * The Samba passdb entries (pdbedit -L), FAIL-OPEN: never throws. pdbedit
   * ships in the `samba` package, and execFile REJECTS (rather than returning
   * an exit code) when the binary is missing, so on a node without samba this
   * would otherwise 500 the whole Share Users list (issue #6). No passdb means
   * nobody holds an SMB password, and `smbEnabled: false` for everyone is the
   * honest answer.
   */
  async function smbEntries(): Promise<PassdbEntry[]> {
    try {
      return await readPassdb()
    }
    catch {
      return []
    }
  }

  /**
   * Run `smbpasswd -a -s <name>` with the password on stdin (never argv —
   * never logged). Throws the smbpasswd message on a non-zero exit.
   */
  async function smbpasswdAdd(name: string, password: string): Promise<void> {
    const r = await execSmbpasswd(['-a', '-s', name], { stdin: `${password}\n${password}\n` })
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `smbpasswd exited with code ${r.exitCode}`)
  }

  /**
   * Set an SMB password and PROVE it landed on an entry that serves the account
   * (identity.3, #68). tdbsam keys entries by the lowercased name but stores the
   * name as first written, and `smbpasswd -a Alice` on an orphan stored as
   * `alice` exits 0 while leaving the stored name — and so the logon mapping —
   * broken: Samba accepts the password, `getpwnam(alice)` fails, the session
   * becomes a guest. So after smbpasswd, `pdbedit -L` must show the name
   * EXACTLY, with the uid `getent passwd <name>` gives. On a mismatch the
   * stale entry is dropped (`pdbedit -x -u <stored>` — the fix an operator
   * does by hand) and the password set again, then re-verified. An entry that
   * belongs to ANOTHER live account is never removed (the routes refuse that
   * case before the job runs). Returns the replaced stored name, if any.
   */
  async function setSmbPasswordVerified(
    name: string,
    password: string,
    updateProgress: (message: string) => void,
  ): Promise<string | undefined> {
    await smbpasswdAdd(name, password)
    const account = await resolveUser(name)
    if (!account)
      throw new Error(`User '${name}' does not resolve (getent passwd), so its SMB entry cannot be checked against it`)
    const entry = passdbEntry(await readPassdb(), name)
    if (passdbServes(entry, name, account.uid))
      return undefined
    if (!entry)
      throw new Error(`smbpasswd reported success, but Samba's password database has no entry for '${name}'`)
    if (passdbOwnedByOther(entry, account.uid))
      throw new Error(`Samba's password database entry for '${name}' is stored as '${entry.stored}', which belongs to another account (uid ${entry.uid}); Samba matches user names case-insensitively, so '${name}' cannot hold its own SMB password. ANAS did not remove that entry.`)

    const stale = entry.stored
    updateProgress(`Replacing the SMB entry stored as '${stale}' for '${name}'`)
    const dropped = await executor.exec(PDBEDIT, ['-x', '-u', stale])
    if (dropped.exitCode !== 0)
      throw new Error(`Samba's password database stores the entry for '${name}' as '${stale}', and removing it failed: ${dropped.stderr.trim() || `pdbedit exited with code ${dropped.exitCode}`}`)
    server.log.info(`identity: SMB passdb entry stored as '${stale}' did not match account '${name}' (uid ${account.uid}); replaced it (pdbedit -x -u ${stale}, then smbpasswd -a ${name})`)

    await smbpasswdAdd(name, password)
    const again = passdbEntry(await readPassdb(), name)
    if (!passdbServes(again, name, account.uid)) {
      const shown = again ? `'${again.stored}' (uid ${again.uid ?? 'unmapped'})` : 'no entry at all'
      throw new Error(`Samba's password database still does not hold '${name}' exactly after replacing the entry stored as '${stale}': it shows ${shown}. Remove it with 'pdbedit -x -u ${again?.stored ?? name}' and set the SMB password again.`)
    }
    return stale
  }

  /** Names present in the LOCAL files DB → ANAS can manage them. */
  async function localUserNames(): Promise<Set<string>> {
    const r = await executor.exec(GETENT, ['-s', 'files', 'passwd'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return new Set()
    return new Set(parsePasswd(r.stdout).map(u => u.name))
  }

  /** Group names present in the LOCAL files DB. */
  async function localGroupNames(): Promise<Set<string>> {
    const r = await executor.exec(GETENT, ['-s', 'files', 'group'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return new Set()
    return new Set(parseGroups(r.stdout).map(g => g.name))
  }

  /** name → shadow expire-days (getent shadow), for the `locked` flag. */
  async function shadowExpiry(): Promise<Map<string, string>> {
    const r = await executor.exec(GETENT, ['shadow'])
    if (r.exitCode !== 0 && !r.stdout.trim())
      return new Map()
    return parseShadowExpiry(r.stdout)
  }

  /** Resolve a single user by name (getent passwd <name>), or null. */
  async function resolveUser(name: string): Promise<PasswdEntry | null> {
    const r = await executor.exec(GETENT, ['passwd', name])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return null
    return parsePasswd(r.stdout)[0] ?? null
  }

  /** Resolve a single group by name (getent group <name>), or null. */
  async function resolveGroup(name: string): Promise<GroupEntry | null> {
    const r = await executor.exec(GETENT, ['group', name])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return null
    return parseGroups(r.stdout)[0] ?? null
  }

  /** Is the user resolvable from the LOCAL files DB (manageable, not directory)? */
  async function isLocalUser(name: string): Promise<boolean> {
    const r = await executor.exec(GETENT, ['-s', 'files', 'passwd', name])
    return r.exitCode === 0 && !!r.stdout.trim()
  }

  /** Is the group resolvable from the LOCAL files DB? */
  async function isLocalGroup(name: string): Promise<boolean> {
    const r = await executor.exec(GETENT, ['-s', 'files', 'group', name])
    return r.exitCode === 0 && !!r.stdout.trim()
  }

  /** Assemble the enriched ShareUser from an entry and the joined lookups. */
  function toShareUser(
    entry: PasswdEntry,
    groups: GroupEntry[],
    passdb: PassdbEntry[],
    local: boolean,
    expire: string,
  ): ShareUser {
    // identity.3: the entry Samba would use is found case-folded, but only an
    // exact-case entry mapped to this account's uid lets it log in. A folded
    // match that is nobody's (an orphan) is reported by its stored name so the
    // panel can say what to repair; one that belongs to another live account
    // is that account's, not a mismatch of this one.
    const smb = passdbEntry(passdb, entry.name)
    const serves = passdbServes(smb, entry.name, entry.uid)
    const mismatch = smb && !serves && !passdbOwnedByOther(smb, entry.uid) ? smb.stored : undefined
    return {
      name: entry.name,
      uid: entry.uid,
      fullName: entry.gecos || null,
      primaryGroup: primaryGroupName(entry, groups),
      groups: userGroups(entry, groups),
      smbEnabled: serves,
      ...(mismatch !== undefined ? { smbEntryMismatch: mismatch } : {}),
      locked: isExpired(expire),
      local,
    }
  }

  // --- the guard (story cr.42, WAVE3-DESIGN §2.5 identity row, §3.3) -------
  //
  // Every identity verb is a guard spec: the route runs its gates, the job
  // runs the SAME gates again against facts read when it starts, and the queue
  // starts it only while it holds the object's keys. The object's id is its
  // uid / gid, never its name: a user deleted and re-created under the same
  // name between the request and the job is another user (IDENTITY_MISMATCH),
  // and the job acts on what it read, never on the request-time entry.

  /** The per-run reads the identity gates share (one per guard run, never across doors). */
  const idReads = {
    user: (reads: GuardReads, name: string) => reads.once(`passwd:${name}`, () => resolveUser(name)),
    group: (reads: GuardReads, name: string) => reads.once(`group:${name}`, () => resolveGroup(name)),
    /**
     * Every account (`getent passwd`), STRICT: null when the database could
     * not be read. The list GETs fail open (`allUsers`); a gate never does.
     */
    users: (reads: GuardReads) => reads.once('passwd', async (): Promise<PasswdEntry[] | null> => {
      const r = await executor.exec(GETENT, ['passwd'])
      return r.exitCode !== 0 && !r.stdout.trim() ? null : parsePasswd(r.stdout)
    }),
    groups: (reads: GuardReads) => reads.once('group', () => allGroups()),
    /** Every group (`getent group`), STRICT: null when the database could not be read. */
    groupsStrict: (reads: GuardReads) => reads.once('group:strict', async (): Promise<GroupEntry[] | null> => {
      const r = await executor.exec(GETENT, ['group'])
      return r.exitCode !== 0 && !r.stdout.trim() ? null : parseGroups(r.stdout)
    }),
    passdb: (reads: GuardReads) => reads.once('passdb', () => smbEntries()),
    /** smb.conf's text; null when it could not be read (an ABSENT file reads as ''). */
    smbConf: (reads: GuardReads) => reads.once('smb.conf', async (): Promise<string | null> => {
      try {
        return await readConfig(smbConfPath)
      }
      catch {
        return null
      }
    }),
    /** /etc/exports' text; null when it could not be read (an ABSENT file reads as ''). */
    exports: (reads: GuardReads) => reads.once('exports', async (): Promise<string | null> => {
      try {
        return await readConfig(exportsPath)
      }
      catch {
        return null
      }
    }),
  }

  interface UserObject { name: string, entry: PasswdEntry, local: boolean }
  interface GroupObject { name: string, entry: GroupEntry, local: boolean }
  /** A create's object: the name it claims (no id exists yet). */
  interface NameSlot { name: string }

  /**
   * The name key of a verb that changes the account namespace (create,
   * delete). Case-FOLDED: Samba finds a passdb entry case-insensitively
   * (identity.3), so a create of `Alice` and one of `alice` must not run side
   * by side — each job's passdb gate would pass before the other's smbpasswd
   * landed.
   */
  function nameClaim(name: string) {
    return idnameClaim(name.toLowerCase())
  }

  /**
   * The (share, parameter) pairs that reference an identity (identity.1d,
   * extended by cr.30 to every user-list parameter of WAVE2-DESIGN §6 C4:
   * `valid users`, `invalid users`, `read list`, `write list`, `admin users`,
   * `force user`, `force group`; quoted entries, `[global]`, `%S` and `+&`
   * read the way Samba reads them). A user matches bare entries; a group
   * matches the `@`/`+`/`&` forms and `force group` (any spelling); the match
   * is case-folded (Samba is case-insensitive in smb.conf too).
   *
   * Returns `{ refs, unknown }`: `unknown` is true when smb.conf could not
   * be read (a read error, not an absent file) — the route then discloses it
   * at the confirm door instead of failing open silently (the ahr-mutate D3
   * pattern), and the job refuses when it cannot read what the confirm could.
   * An ABSENT file (samba removed) genuinely means no references.
   */
  async function sharesReferencing(
    reads: GuardReads,
    name: string,
    isGroup: boolean,
  ): Promise<{ refs: IdentityRefHit[], unknown: boolean }> {
    const text = await idReads.smbConf(reads)
    if (text === null)
      return { refs: [], unknown: true }
    return { refs: findIdentityReferences(text, name, isGroup), unknown: false }
  }

  /** The hard-409 refusal for a referenced identity — ONE shape for both verbs and both doors. */
  function referencedRefusal(kind: 'user' | 'group', name: string, refs: IdentityRefHit[]): Refusal {
    // One line per share, naming every parameter of it that holds the name:
    // `media (valid users, write list), archive (force user)`.
    const byShare = new Map<string, string[]>()
    for (const ref of refs) {
      const params = byShare.get(ref.share) ?? []
      if (!params.includes(ref.parameter))
        params.push(ref.parameter)
      byShare.set(ref.share, params)
    }
    const listed = Array.from(byShare, ([share, params]) => `${share} (${params.join(', ')})`)
    return {
      status: 409,
      code: 'CONFLICT',
      reason: 'referenced-by-share',
      message: `${kind === 'user' ? 'User' : 'Group'} '${name}' is referenced by share(s): ${listed.join(', ')}. Remove it from those share parameters first. This refusal has no confirm bypass.`,
    }
  }

  /** 409 for a mutation aimed at a directory-provided (read-only) identity. */
  function directoryRefusal(kind: 'user' | 'group', name: string): Refusal {
    return {
      status: 409,
      code: 'CONFLICT',
      message: `${kind === 'user' ? 'User' : 'Group'} '${name}' is directory-provided (not in the local files DB) and is read-only here`,
    }
  }

  /**
   * The cr.3 hard-409 (Principle 14 "blocked" — like the reference refusal, no
   * confirm code is minted): the target's uid/gid is outside the share band,
   * so it is a system account and ANAS never changes it (review C3).
   */
  function systemAccountRefusal(kind: 'user' | 'group', name: string, id: number): Refusal {
    const what = kind === 'user' ? 'User' : 'Group'
    return {
      status: 409,
      code: 'SYSTEM_ACCOUNT',
      message: `${what} '${name}' (${kind === 'user' ? 'uid' : 'gid'} ${id}) is a system account. System accounts (uid/gid below 1000 or from 60000) are managed outside ANAS.`,
    }
  }

  /** The Samba preflight (issue #6) as a gate: the sentence names what was NOT done. */
  function sambaInstalledGate<O>(notDone: string): Gate<O> {
    return async () => (await smbAvailable())
      ? null
      : { status: 400, code: 'VALIDATION_ERROR', message: `${SMB_NOT_INSTALLED}. ${notDone}` }
  }

  // User gates (each one function, run by both doors).

  const localUserGate: Gate<UserObject> = async o => o.local ? null : directoryRefusal('user', o.name)

  /** cr.3: the uid must be in the mutable share band (`isMutableShareId`). */
  const mutableUserGate: Gate<UserObject> = async o =>
    isMutableShareId(o.entry.uid) ? null : systemAccountRefusal('user', o.name, o.entry.uid)

  /**
   * identity.3: smbpasswd lands on the entry Samba finds case-folded — when
   * that entry is ANOTHER live account's, setting this password would change
   * that account's. Re-run in the job: an entry that appears while the job
   * waits would otherwise take the password.
   */
  const passdbNotOwnedGate: Gate<UserObject> = async (o, reads) => {
    const existing = passdbEntry(await idReads.passdb(reads), o.name)
    if (!existing || !passdbOwnedByOther(existing, o.entry.uid))
      return null
    return {
      status: 409,
      code: 'CONFLICT',
      reason: 'passdb-entry-owned',
      message: `Samba's password database entry for '${o.name}' is stored as '${existing.stored}', which belongs to another account (uid ${existing.uid}). Samba matches user names case-insensitively, so '${o.name}' cannot hold its own SMB password. The password was NOT changed.`,
    }
  }

  /** identity.1d / cr.30: a name a share still carries in any user-list parameter (hard, no bypass). */
  const userNotReferencedGate: Gate<UserObject> = async (o, reads) => {
    const { refs } = await sharesReferencing(reads, o.name, false)
    return refs.length > 0 ? referencedRefusal('user', o.name, refs) : null
  }

  // Group gates.

  const localGroupGate: Gate<GroupObject> = async o => o.local ? null : directoryRefusal('group', o.name)

  const mutableGroupGate: Gate<GroupObject> = async o =>
    isMutableShareId(o.entry.gid) ? null : systemAccountRefusal('group', o.name, o.entry.gid)

  /**
   * groupdel cannot run while the group is ANY account's primary group (the
   * account would be left with an unresolvable primary gid). Every resolvable
   * account is checked, not only local ones: a directory user pinned to this
   * gid would be broken the same way.
   */
  const notPrimaryGroupGate: Gate<GroupObject> = async (o, reads) => {
    const users = await idReads.users(reads)
    if (users === null)
      return accountsUnreadable(`that group '${o.name}' is nobody's primary group`)
    const primaries = users.filter(u => u.gid === o.entry.gid).map(u => u.name)
    if (primaries.length === 0)
      return null
    return {
      status: 409,
      code: 'CONFLICT',
      reason: 'primary-group-in-use',
      message: `Group '${o.name}' is the primary group of: ${primaries.join(', ')}. Change their primary group (or remove the users) first. This refusal has no confirm bypass.`,
    }
  }

  const groupNotReferencedGate: Gate<GroupObject> = async (o, reads) => {
    const { refs } = await sharesReferencing(reads, o.name, true)
    return refs.length > 0 ? referencedRefusal('group', o.name, refs) : null
  }

  /** A gate that could not read the account database refuses (fail closed, §3.2). */
  function accountsUnreadable(check: string): Refusal {
    return { status: 503, code: 'UNAVAILABLE', message: `ANAS could not read the account database (getent passwd), so it cannot check ${check} — nothing was done` }
  }

  /** Members being ADDED must resolve (getent); removals need not. */
  function membersResolveGate(add: string[]): Gate<GroupObject> {
    return async (_o, reads) => {
      if (add.length === 0)
        return null
      const users = await idReads.users(reads)
      if (users === null)
        return accountsUnreadable(`that ${add.join(', ')} exist`)
      const known = new Set(users.map(u => u.name))
      const missing = add.filter(u => !known.has(u))
      return missing.length > 0 ? { status: 400, code: 'VALIDATION_ERROR', message: `Unknown user(s): ${missing.join(', ')}` } : null
    }
  }

  /** The delete's one advisory: smb.conf could not be read, so the reference gate saw nothing. */
  async function smbConfAdvisories(reads: GuardReads, name: string, isGroup: boolean): Promise<Advisory[]> {
    const { unknown } = await sharesReferencing(reads, name, isGroup)
    return unknown
      ? [{ key: 'unreadable:smb.conf', warning: `ANAS could not read smb.conf to check for share references. If this node has SMB shares, verify none of them names this ${isGroup ? 'group' : 'user'} before confirming.` }]
      : []
  }

  /**
   * The reference gate passes on an unreadable smb.conf (the route discloses
   * it in the confirm instead). When the job cannot read the file the confirm
   * DID read, the operator confirmed a check the job cannot repeat: fail
   * closed, nothing done.
   */
  function refuseNewlyUnreadable(newAdvisories: string[], whom: string): void {
    if (newAdvisories.length === 0)
      return
    throw new GuardRefusalError({
      status: 409,
      code: 'STATE_CHANGED',
      message: `ANAS could not read smb.conf when the job ran, so it cannot check that no share names ${whom} (it could at the confirmation) — nothing was done; confirm again`,
    })
  }

  /** The verbs on an existing user. */
  type UserVerb = 'smb-password' | 'enable' | 'disable' | 'delete'

  /**
   * The guard spec of a verb on an existing user (WAVE3-DESIGN §3.3 User row):
   *  - id: the uid (`getent passwd <name>`), compared by the job — a user
   *    deleted and re-created under the name is another user;
   *  - gates: local, band, then per verb — the SMB password re-checks Samba
   *    and the passdb entry's owner, the delete re-runs the share references;
   *  - advisories (delete): an smb.conf that could not be read;
   *  - locks: `uid:<n>` exclusive; the delete also takes the name key.
   */
  function userGuardSpec(name: string, verb: UserVerb): GuardSpec<UserObject> {
    const gates: Gate<UserObject>[] = [localUserGate, mutableUserGate]
    if (verb === 'smb-password')
      gates.push(sambaInstalledGate('The password was NOT changed.'), passdbNotOwnedGate)
    if (verb === 'delete')
      gates.push(userNotReferencedGate)
    return {
      operation: verb === 'smb-password' ? 'identity.smbpasswd.set' : `identity.user.${verb}`,
      object: {
        what: `User '${name}'`,
        read: async (reads) => {
          const entry = await idReads.user(reads, name)
          return entry ? { name, entry, local: await isLocalUser(name) } : null
        },
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `User '${name}' not found` }),
        id: async o => ({ uid: String(o.entry.uid) }),
        unbound: () => `Could not read the uid of user '${name}' — refusing`,
      },
      gates,
      ...(verb === 'delete' ? { advisories: async (o: UserObject, reads: GuardReads) => smbConfAdvisories(reads, o.name, false) } : {}),
      locks: async o => [uidClaim(o.entry.uid, name), ...(verb === 'delete' ? [nameClaim(name)] : [])],
    }
  }

  /** The verbs on an existing group. */
  type GroupVerb = 'members' | 'delete'

  /**
   * The guard spec of a verb on an existing group: id the gid; gates local,
   * band, then the added members resolve (members) or the primary-group use
   * and the share references (delete); locks `gid:<n>`, the delete also the
   * name key.
   */
  function groupGuardSpec(name: string, verb: GroupVerb, add: string[] = []): GuardSpec<GroupObject> {
    const gates: Gate<GroupObject>[] = [localGroupGate, mutableGroupGate]
    if (verb === 'members')
      gates.push(membersResolveGate(add))
    if (verb === 'delete')
      gates.push(notPrimaryGroupGate, groupNotReferencedGate)
    return {
      operation: `identity.group.${verb}`,
      object: {
        what: `Group '${name}'`,
        read: async (reads) => {
          const entry = await idReads.group(reads, name)
          return entry ? { name, entry, local: await isLocalGroup(name) } : null
        },
        notFound: () => ({ status: 404, code: 'NOT_FOUND', message: `Group '${name}' not found` }),
        id: async o => ({ gid: String(o.entry.gid) }),
        unbound: () => `Could not read the gid of group '${name}' — refusing`,
      },
      gates,
      ...(verb === 'delete' ? { advisories: async (o: GroupObject, reads: GuardReads) => smbConfAdvisories(reads, o.name, true) } : {}),
      locks: async o => [gidClaim(o.entry.gid, name), ...(verb === 'delete' ? [nameClaim(name)] : [])],
    }
  }

  // --- cr.29: the uid / gid a create passes to useradd / groupadd ----------
  //
  // Ruled 2026-10-15 (WAVE2-DESIGN §6; no tombstones): every create passes an
  // explicit `-u`/`-g`. The operator's own id is used as given (refused only
  // when an account holds it — the band is the schema's), never checked for
  // files; otherwise ANAS picks one that owns nothing under the paths it
  // manages (services/identity-ids.ts). The id is decided at the route door,
  // promised to the request, and the create's guard takes its `uid:`/`gid:`
  // key; the job re-checks it.

  /**
   * Ids promised to creates that have not finished: `uid:<n>` / `gid:<n>` →
   * the job that will use it (no job yet while the route is still deciding).
   * Two creates at once must not pick the same id, and the job queue's lock
   * keys only order jobs that already have one, so the pick consults this.
   * Runtime state of the job queue's own kind — once the job ends the account
   * database is the answer again — so a promise lapses when its job is no
   * longer queued or running, or (never submitted) after a minute.
   */
  const promisedIds = new Map<string, { jobId?: string, at: number }>()
  const PROMISE_UNSUBMITTED_MS = 60_000

  function promisedTo(key: string): boolean {
    const p = promisedIds.get(key)
    if (!p)
      return false
    const status = p.jobId !== undefined ? jobQueue.get(p.jobId)?.status : undefined
    const live = p.jobId !== undefined
      ? status === 'queued' || status === 'running'
      : Date.now() - p.at < PROMISE_UNSUBMITTED_MS
    if (!live)
      promisedIds.delete(key)
    return live
  }

  /** Promise `key` to this request — synchronously; false when another create holds it. */
  function promiseId(key: string): boolean {
    if (promisedTo(key))
      return false
    promisedIds.set(key, { at: Date.now() })
    return true
  }

  /** What a create decides about its id; the route door fills `id` and `key`, the job door reads them. */
  interface CreateId {
    kind: IdKind
    /** The operator gave it (never checked for files). */
    explicit: boolean
    id: number | null
    /** The promise this request holds (`uid:<n>`); null until the route door decided. */
    key: string | null
    /** Ids the pick moved past because they own something. */
    skipped: { id: number, where: string }[]
  }

  function createId(kind: IdKind, explicit: number | undefined): CreateId {
    return { kind, explicit: explicit !== undefined, id: explicit ?? null, key: null, skipped: [] }
  }

  /** The progress line's tail naming the ids a pick moved past (empty when none). */
  function skippedNote(state: CreateId): string {
    if (state.skipped.length === 0)
      return ''
    return ` (${state.skipped.map(s => `${state.kind} ${s.id} still owns ${s.where}`).join('; ')})`
  }

  /**
   * The delete confirm's one sentence about the number (cr.29): it stays on
   * the files; a create skips it while ANAS can still see it owning
   * something, but ids seen only in exported pools or backups cannot be
   * checked; re-creating with the same id is how the files come back.
   */
  function leftOnFiles(kind: IdKind, id: number): string {
    const whom = kind === 'uid' ? 'user' : 'group'
    return `Files owned by this ${whom} keep ${kind} ${id}. ANAS will not give ${kind} ${id} to a new ${whom} while it still owns files on an imported ZFS filesystem or under a share, but it cannot check ids seen only in exported pools, on disconnected disks or in backups. To give the files back later, re-create the ${whom} with ${idField(kind)} ${id}.`
  }

  /** `User ID` / `Group ID` — what the Add dialog calls the field. */
  function idField(kind: IdKind): string {
    return kind === 'uid' ? 'User ID' : 'Group ID'
  }

  function idWhom(kind: IdKind): string {
    return kind === 'uid' ? 'user' : 'group'
  }

  /** The 409 when a source of the check could not be read (fail closed, never a guess). */
  function idCheckUnreadable(state: CreateId, unreadable: string, id: number | null): Refusal {
    const what = id === null ? `which ${state.kind} is free` : `that ${state.kind} ${id} ${state.explicit ? 'is free' : 'owns no files'}`
    const out = state.explicit ? '' : ` To create the ${idWhom(state.kind)} without this check, give its ${idField(state.kind)} explicitly (an id you give is not checked for files).`
    return {
      status: 409,
      code: 'CONFLICT',
      reason: 'id-check-unreadable',
      message: `ANAS could not check ${what}: it could not read ${unreadable}. Nothing was created.${out}`,
    }
  }

  /** The 409 when an account already holds the id. */
  function idInUse(state: CreateId, id: number, holder: string, verb: string): Refusal {
    const next = state.explicit
      ? ` Give another ${idField(state.kind)}, or leave it empty and ANAS picks a free one.`
      : ' Create it again and ANAS picks another.'
    return {
      status: 409,
      code: 'CONFLICT',
      reason: 'id-in-use',
      message: `${state.kind} ${id} ${verb} ${idWhom(state.kind)} '${holder}'. Nothing was created.${next}`,
    }
  }

  /**
   * The create's id gate, run by both doors (the LAST gate, so a pass at the
   * route goes straight to the submit that binds its promise):
   *  - route door (`key` null): an explicit id must be held by no account and
   *    promised to no other create; otherwise one is picked (`pickId`) —
   *    either way the id is promised to this request;
   *  - job door: the promised id is still held by no account, and a PICKED id
   *    still owns nothing (ruling (j); nothing is re-picked — the job's lock
   *    is that id's key).
   */
  function createIdGate(state: CreateId): Gate<NameSlot> {
    return async (_slot, reads) => {
      const own: OwnershipReadOpts = {
        executor,
        reads,
        smbConf: () => idReads.smbConf(reads),
        exports: () => idReads.exports(reads),
        ...opts.idCheck,
      }
      const keyOf = (n: number): string => `${state.kind}:${n}`

      if (state.key === null && state.explicit) {
        const id = state.id!
        const held = await idHolder(executor, state.kind, id)
        if ('unreadable' in held)
          return idCheckUnreadable(state, held.unreadable, id)
        if (held.holder !== null)
          return idInUse(state, id, held.holder, 'already belongs to')
        if (!promiseId(keyOf(id))) {
          return {
            status: 409,
            code: 'CONFLICT',
            reason: 'id-in-use',
            message: `${state.kind} ${id} is being given to another ${idWhom(state.kind)} by a create that has not finished. Nothing was created.`,
          }
        }
        state.key = keyOf(id)
        return null
      }

      if (state.key === null) {
        const accounts = state.kind === 'uid'
          ? (await idReads.users(reads))?.map(u => u.uid)
          : (await idReads.groupsStrict(reads))?.map(g => g.gid)
        if (accounts === undefined) {
          return state.kind === 'uid'
            ? accountsUnreadable('which uid is free')
            : { status: 503, code: 'UNAVAILABLE', message: 'ANAS could not read the group database (getent group), so it cannot check which gid is free — nothing was done' }
        }
        const picked = await pickId(state.kind, accounts, { held: n => promisedTo(keyOf(n)), take: n => promiseId(keyOf(n)) }, own)
        if ('id' in picked) {
          state.id = picked.id
          state.key = keyOf(picked.id)
          state.skipped = picked.skipped
          return null
        }
        if (picked.refusal === 'unreadable')
          return idCheckUnreadable(state, picked.unreadable, null)
        const field = `${idWhom(state.kind)}'s ${idField(state.kind)}`
        const message = picked.refusal === 'tries'
          ? `The next ${ID_PICK_TRIES} free ${state.kind}s from ${picked.from} all still own files (${state.kind} ${picked.skipped[0].id} owns ${picked.skipped[0].where}, …), so ANAS did not pick one. Nothing was created. Give the ${field} explicitly.`
          : `No ${state.kind} from ${picked.from} to 59999 is free. Nothing was created. Give the ${field} explicitly (any free id from 1000).`
        return { status: 409, code: 'CONFLICT', reason: 'no-free-id', message }
      }

      // The job door.
      const id = state.id!
      const held = await idHolder(executor, state.kind, id)
      if ('unreadable' in held)
        return idCheckUnreadable(state, held.unreadable, id)
      if (held.holder !== null)
        return idInUse(state, id, held.holder, 'was given meanwhile to')
      if (!state.explicit) {
        const owned = await idOwnership(state.kind, id, own)
        if ('unreadable' in owned)
          return idCheckUnreadable(state, owned.unreadable, id)
        if (owned.owns) {
          return {
            status: 409,
            code: 'STATE_CHANGED',
            reason: 'id-owns-files',
            message: `${state.kind} ${id} owns ${owned.where} now (it owned nothing when the request was checked). Nothing was created. Create it again and ANAS picks another.`,
          }
        }
      }
      return null
    }
  }

  /** The route door of a create: guardCheck, dropping the id promise on any refusal or throw. */
  async function createCheck(spec: GuardSpec<NameSlot>, state: CreateId): ReturnType<typeof guardCheck<NameSlot>> {
    const drop = (): void => {
      if (state.key !== null)
        promisedIds.delete(state.key)
    }
    try {
      const pre = await guardCheck(spec)
      if ('refusal' in pre)
        drop()
      return pre
    }
    catch (err) {
      drop()
      throw err
    }
  }

  /**
   * Submit a create's job with its id promise bound to it: the promise is
   * dropped as soon as the body ends (the account database answers from then
   * on), and lapses if the job is cancelled before it ever starts.
   */
  function submitCreate(state: CreateId, ...[operation, submitter, handler, submitOpts]: Parameters<JobQueue['submit']>): ReturnType<JobQueue['submit']> {
    const key = state.key!
    const job = jobQueue.submit(operation, submitter, async (...args) => {
      try {
        return await handler(...args)
      }
      finally {
        promisedIds.delete(key)
      }
    }, submitOpts)
    const p = promisedIds.get(key)
    if (p && p.jobId === undefined)
      p.jobId = job.id
    return job
  }

  /**
   * The guard spec of a create: the object is the name slot, the gates are
   * the request's with the id gate last. A create takes the case-folded name
   * key and its id's `uid:`/`gid:` key (cr.29); a user created into
   * supplementary groups changes those groups too, so it also takes their
   * `gid:` keys.
   */
  function createGuardSpec(kind: 'user' | 'group', name: string, gates: Gate<NameSlot>[], state: CreateId, groups: string[] = []): GuardSpec<NameSlot> {
    return {
      operation: kind === 'user' ? 'identity.user.add' : 'identity.group.add',
      object: {
        what: `${kind === 'user' ? 'User' : 'Group'} name '${name}'`,
        read: async () => ({ name }),
        id: async () => ({ name }),
        unbound: () => `Could not read the name '${name}' — refusing`,
      },
      gates: [...gates, createIdGate(state)],
      locks: async (_slot, _bound, reads) => {
        const byName = new Map((groups.length > 0 ? await idReads.groups(reads) : []).map(g => [g.name, g]))
        const gids = groups.map(g => byName.get(g)).filter((g): g is GroupEntry => g !== undefined)
        const idKey = state.kind === 'uid' ? uidClaim(state.id!, name) : gidClaim(state.id!, name)
        return [nameClaim(name), idKey, ...gids.map(g => gidClaim(g.gid, g.name))]
      },
    }
  }

  // --- GET /identity/users — enriched ShareUser list ------------------------
  server.get('/identity/users', async () => {
    const [users, groups, smb, local, shadow] = await Promise.all([
      allUsers(),
      allGroups(),
      smbEntries(),
      localUserNames(),
      shadowExpiry(),
    ])
    const data = users
      .filter(u => isShareRelevant(u.uid))
      .map(u => toShareUser(u, groups, smb, local.has(u.name), shadow.get(u.name) ?? ''))
    return { data }
  })

  // --- GET /identity/groups — enriched ShareGroup list ----------------------
  server.get('/identity/groups', async () => {
    const [groups, users, local] = await Promise.all([allGroups(), allUsers(), localGroupNames()])
    const data: ShareGroup[] = groups
      .filter(g => isShareRelevant(g.gid))
      .map((g) => {
        // identity.1c: explain an existing user-private group — a user with
        // the SAME NAME whose PRIMARY gid is this group. Exact match: both
        // sides come from the same (case-sensitive) account database.
        const owner = users.find(u => u.name === g.name && u.gid === g.gid)
        return {
          ...toSystemGroup(g),
          members: g.members,
          local: local.has(g.name),
          ...(owner ? { privateGroupOf: owner.name } : {}),
        }
      })
    return { data }
  })

  // --- GET /identity/users/:name — single ShareUser ------------------------
  server.get<{ Params: { name: string } }>('/identity/users/:name', async (request, reply) => {
    const nameParsed = LookupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid user name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const entry = await resolveUser(name)
    if (!entry) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `User '${name}' not found` } }
    }

    const [groups, smb, local, shadow] = await Promise.all([
      allGroups(),
      smbEntries(),
      isLocalUser(name),
      shadowExpiry(),
    ])
    return { data: toShareUser(entry, groups, smb, local, shadow.get(name) ?? '') }
  })

  // --- POST /identity/users — create a local share user --------------------
  server.post('/identity/users', async (request, reply) => {
    const bodyParsed = CreateShareUserRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create user request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const groups = req.groups ?? []
    const gates: Gate<NameSlot>[] = [
      // 409 if the name already resolves anywhere (local OR directory) —
      // getent is the source of truth, and useradd would collide.
      async (s, reads) => (await idReads.user(reads, s.name))
        ? { status: 409, code: 'CONFLICT', message: `User '${s.name}' already exists` }
        : null,
      // Referenced supplementary groups must exist.
      async (_s, reads) => {
        if (groups.length === 0)
          return null
        const known = new Set((await idReads.groups(reads)).map(g => g.name))
        const missing = groups.filter(g => !known.has(g))
        return missing.length > 0 ? { status: 400, code: 'VALIDATION_ERROR', message: `Unknown group(s): ${missing.join(', ')}` } : null
      },
      // cr.3 (review C3): existing ≠ mutable. `useradd -G sudo` would hand the
      // new account the sudo group; membership of anything outside the share
      // band is system management, so name the group and refuse.
      async (_s, reads) => {
        if (groups.length === 0)
          return null
        const byName = new Map((await idReads.groups(reads)).map(g => [g.name, g]))
        const systemGroups = groups.filter((g) => {
          const entry = byName.get(g)
          return entry !== undefined && !isMutableShareId(entry.gid)
        })
        return systemGroups.length > 0
          ? {
              status: 409,
              code: 'SYSTEM_ACCOUNT',
              message: `Group(s) ${systemGroups.map(g => `'${g}' (gid ${byName.get(g)?.gid})`).join(', ')} are system groups. System accounts (uid/gid below 1000 or from 60000) are managed outside ANAS.`,
            }
          : null
      },
      // Samba preflight (issue #6). Refuse BEFORE the job runs useradd, so a
      // node without samba never ends up with a half-created user whose SMB
      // password silently never landed. The API is the authority on what is
      // possible (Principle 14) — the client just gets a 400 that says what
      // to install.
      ...(req.smbPassword !== undefined ? [sambaInstalledGate<NameSlot>('The user was NOT created.')] : []),
      // identity.3 (#68): Samba looks passdb entries up case-FOLDED, so an
      // entry left under another case would be the one this account logs in
      // with — and it can never map to it. An orphan (its account gone) is
      // replaced by the job when this create sets an SMB password; without
      // one there is nothing to replace it with, and an entry that belongs to
      // another live account is never touched. Re-run in the job (cr.42): an
      // entry that appears while the job waits refuses before useradd.
      async (s, reads) => {
        const existing = passdbEntry(await idReads.passdb(reads), s.name)
        if (existing && passdbOwnedByOther(existing, null)) {
          return {
            status: 409,
            code: 'CONFLICT',
            reason: 'passdb-entry-owned',
            message: `Samba's password database already holds an entry stored as '${existing.stored}', which belongs to another account (uid ${existing.uid}). Samba matches user names case-insensitively, so '${s.name}' could never hold its own SMB password. Pick a different name. The user was NOT created.`,
          }
        }
        if (existing && existing.stored !== s.name && req.smbPassword === undefined) {
          return {
            status: 409,
            code: 'CONFLICT',
            reason: 'passdb-orphan',
            message: `Samba's password database holds an orphan entry stored as '${existing.stored}' (its account no longer exists), which Samba would match to '${s.name}' and turn into a guest session. Set an SMB password in this dialog to replace it, or remove it first with: pdbedit -x -u ${existing.stored}. The user was NOT created.`,
          }
        }
        return null
      },
    ]
    const idState = createId('uid', req.uid)
    const spec = createGuardSpec('user', req.name, gates, idState, groups)
    const pre = await createCheck(spec, idState)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const uid = idState.id!

    // useradd -N -M -s /usr/sbin/nologin -u <uid> [-c <fullName>] [-G <groups>] <name>
    // -N (identity.1c): NO user-private group — the account takes the default
    // group from /etc/default/useradd, so creating 'Alice' does not conjure a
    // phantom group 'alice' into the Groups list. Pre-existing users keep
    // whatever group they already had. -u (cr.29): the uid decided above,
    // never useradd's own highest-plus-one.
    const args = ['-N', '-M', '-s', NOLOGIN, '-u', String(uid)]
    if (req.fullName !== undefined)
      args.push('-c', req.fullName)
    if (groups.length > 0)
      args.push('-G', groups.join(','))
    args.push(req.name)

    const smbPassword = req.smbPassword

    const job = submitCreate(
      idState,
      'identity.user.add',
      { ...identity, params: { user: req.name, uid, uidGiven: idState.explicit, groups: req.groups, smbEnabled: smbPassword !== undefined } },
      // Ruling (j): the name is still free, the groups still exist and are
      // in band, Samba is still there, no passdb entry claims the name, and
      // the uid is still free (a picked one still owns nothing).
      guarded(spec, pre, async (_slot, { updateProgress }) => {
        updateProgress(`Creating share user '${req.name}' with uid ${uid}${skippedNote(idState)}`)
        const created = await executor.exec(USERADD, args)
        if (created.exitCode !== 0)
          throw new Error(created.stderr.trim() || `useradd exited with code ${created.exitCode}`)

        let replaced: string | undefined
        if (smbPassword !== undefined) {
          updateProgress(`Setting SMB password for '${req.name}'`)
          try {
            // Password on stdin (smbpasswd -s), never argv — never logged;
            // verified exact-case afterwards, a stale entry replaced.
            replaced = await setSmbPasswordVerified(req.name, smbPassword, updateProgress)
          }
          catch (err) {
            // Any failure here (a spawn failure because samba went away since
            // the route preflight, a passdb that will not verify) leaves the
            // account without a working password — say so in one wording.
            throw new Error(halfCreated(req.name, err instanceof Error ? err.message : String(err)))
          }
        }
        return {
          created: req.name,
          uid,
          smbEnabled: smbPassword !== undefined,
          ...(replaced !== undefined ? { smbEntryReplaced: replaced } : {}),
        }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- POST /identity/users/:name/smb-password — set/replace SMB password ---
  server.post<{ Params: { name: string } }>('/identity/users/:name/smb-password', async (request, reply) => {
    const nameParsed = LookupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid user name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = SetSmbPasswordRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid SMB password request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { password } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // exists → local → band (cr.3: system accounts never take an SMB password;
    // root's would ride the same PAM/ssh surface ANAS must not touch) → Samba
    // installed (issue #6) → the case-folded passdb entry is not another live
    // account's (identity.3) — at the route and again in the job.
    const spec = userGuardSpec(name, 'smb-password')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'identity.smbpasswd.set',
      { ...identity, params: { user: name } },
      // Ruling (j): the same uid, every gate again, before the first smbpasswd.
      guarded(spec, pre, async (_o, { updateProgress }) => {
        // Password on stdin (smbpasswd -s), never argv — never logged;
        // verified exact-case afterwards, a stale entry replaced (identity.3).
        const replaced = await setSmbPasswordVerified(name, password, updateProgress)
        return { user: name, smbEnabled: true, ...(replaced !== undefined ? { smbEntryReplaced: replaced } : {}) }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- PUT /identity/users/:name — enable / disable (no deletion) ------------
  server.put<{ Params: { name: string } }>('/identity/users/:name', async (request, reply) => {
    const nameParsed = LookupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid user name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = SetUserEnabledRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid enable request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { enabled } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // exists → local → band (cr.3: `usermod --expiredate 1` on root or a
    // service account locks the node — PVE @pam login and sshd honour expiry)
    // — at the route and again in the job.
    const spec = userGuardSpec(name, enabled ? 'enable' : 'disable')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // enable → clear expiry; disable → expire immediately. Share users have no
    // Unix password, so `--lock`/`--unlock` is redundant (it warns on a
    // passwordless account and is fragile across OSes); the `locked` flag is
    // derived from shadow EXPIRY, not the password field, so expiry alone is
    // the whole toggle. The SMB smbpasswd -d/-e side is handled below.
    const usermodArgs = enabled
      ? ['--expiredate', '', name]
      : ['--expiredate', '1', name]

    const job = jobQueue.submit(
      enabled ? 'identity.user.enable' : 'identity.user.disable',
      { ...identity, params: { user: name, enabled } },
      // Ruling (j): the same uid, every gate again, before the first usermod.
      guarded(spec, pre, async (o, { updateProgress }) => {
        updateProgress(`${enabled ? 'Enabling' : 'Disabling'} account '${name}'`)
        const r = await executor.exec(USERMOD, usermodArgs)
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `usermod exited with code ${r.exitCode}`)

        // Toggle the SMB side only if the user actually has a passdb entry —
        // smbpasswd -d/-e errors on users with no entry, which is normal for a
        // share user that never had an SMB password. On a node without samba
        // smbEntries() fails open to empty, so this is skipped entirely.
        // Found case-FOLDED (identity.1b) the way smbpasswd finds it — but an
        // entry that belongs to another live account is that account's to
        // toggle, never this one's (identity.3). The uid is the one the job
        // read (cr.42), never the request's.
        const smb = passdbEntry(await smbEntries(), name)
        if (smb && !passdbOwnedByOther(smb, o.entry.uid)) {
          updateProgress(`${enabled ? 'Enabling' : 'Disabling'} SMB access for '${name}'`)
          const smb = await execSmbpasswd([enabled ? '-e' : '-d', name])
          if (smb.exitCode !== 0)
            throw new Error(smb.stderr.trim() || `smbpasswd exited with code ${smb.exitCode}`)
        }
        return { user: name, enabled }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- POST /identity/groups — create a local group ------------------------
  server.post('/identity/groups', async (request, reply) => {
    const bodyParsed = CreateGroupRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create group request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const idState = createId('gid', req.gid)
    const spec = createGuardSpec('group', req.name, [
      async (s, reads) => (await idReads.group(reads, s.name))
        ? { status: 409, code: 'CONFLICT', message: `Group '${s.name}' already exists` }
        : null,
    ], idState)
    const pre = await createCheck(spec, idState)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const gid = idState.id!

    const job = submitCreate(
      idState,
      'identity.group.add',
      { ...identity, params: { group: req.name, gid, gidGiven: idState.explicit } },
      // Ruling (j): the name and the gid are still free (a picked gid still
      // owns nothing) when groupadd runs.
      guarded(spec, pre, async (_slot, { updateProgress }) => {
        updateProgress(`Creating group '${req.name}' with gid ${gid}${skippedNote(idState)}`)
        // groupadd -g <gid> <name> (cr.29): never groupadd's own highest-plus-one.
        const r = await executor.exec(GROUPADD, ['-g', String(gid), req.name])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `groupadd exited with code ${r.exitCode}`)
        return { created: req.name, gid }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- PUT /identity/groups/:name/members — add / remove members ------------
  server.put<{ Params: { name: string } }>('/identity/groups/:name/members', async (request, reply) => {
    const nameParsed = LookupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid group name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = UpdateGroupMembersRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid members update: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data
    const add = req.add ?? []
    const remove = req.remove ?? []

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // exists → local → band (cr.3: `gpasswd -a <u> sudo` hands `u` the sudo
    // group — membership edits of system groups are system management,
    // outside ANAS) → the members being added resolve — at the route and
    // again in the job.
    const spec = groupGuardSpec(name, 'members', add)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'identity.group.members',
      { ...identity, params: { group: name, add, remove } },
      // Ruling (j): the same gid, every gate again, before the first gpasswd.
      guarded(spec, pre, async (_o, { updateProgress }) => {
        for (const user of add) {
          updateProgress(`Adding '${user}' to '${name}'`)
          const r = await executor.exec(GPASSWD, ['-a', user, name])
          if (r.exitCode !== 0)
            throw new Error(r.stderr.trim() || `gpasswd -a ${user} exited with code ${r.exitCode}`)
        }
        for (const user of remove) {
          updateProgress(`Removing '${user}' from '${name}'`)
          const r = await executor.exec(GPASSWD, ['-d', user, name])
          if (r.exitCode !== 0)
            throw new Error(r.stderr.trim() || `gpasswd -d ${user} exited with code ${r.exitCode}`)
        }
        return { group: name, added: add, removed: remove }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /identity/users/:name — delete a local share user -------------
  //
  // Identity.1d. The same local-identity gate the update routes use (LookupName
  // → exists → local), then the HARD refusals (no confirm bypass): a name a
  // share still carries in any user-list parameter (cr.30). What remains is confirm-gated
  // (Principle 14): the account is gone from the system, and the files it owns
  // keep their uid — `userdel` without `-r`, by design.
  server.delete<{ Params: { name: string } }>('/identity/users/:name', async (request, reply) => {
    const nameParsed = LookupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid user name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // exists → local → band (cr.3: userdel has no uid floor — without the band
    // gate this route could delete root or any service account, review C3) →
    // no share names the user (cr.30) — at the route and again in the job.
    const spec = userGuardSpec(name, 'delete')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const { entry } = pre.object

    // The passdb check is route-time for the WARNING (it describes what will
    // happen); the job re-checks live so the `pdbedit -x` side stays honest
    // if the passdb moves between the two.
    const routeSmb = passdbEntry(await smbEntries(), name)
    const hasSmb = routeSmb !== null && !passdbOwnedByOther(routeSmb, entry.uid)
    const warnings = [
      `User '${name}' (uid ${entry.uid}) will be removed from the system`,
      leftOnFiles('uid', entry.uid),
    ]
    if (hasSmb)
      warnings.push(`Its SMB password entry will be removed`)
    warnings.push(...pre.advisories.map(a => a.warning))
    // TODO(cr.30): ACL-root references as a confirm WARNING naming the roots
    // (WAVE2-DESIGN §6 C4: `getfacl -n -p` of every share root for a named
    // entry). cr.29 as ruled (2026-10-15) reads OWNERSHIP (`zfs userspace`,
    // `find -uid`), not ACL entries, so no scan exists for this to ride yet.

    // cr.42 (WAVE3-DESIGN §5.1 "User / group delete"): the code signs the
    // request AND the uid, so a resend after the name was re-created for
    // another account is 409 IDENTITY_MISMATCH, never a delete of the
    // namesake.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name },
      address: ['name'],
      message: `Deleting share user '${name}' removes the account`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'identity.user.delete',
      { ...identity, params: { user: name } },
      // Ruling (j): the confirmed uid, local, band and the share references
      // run again against what the node has now.
      guarded(spec, pre, async (o, { updateProgress, newAdvisories }) => {
        refuseNewlyUnreadable(newAdvisories, `user '${name}'`)
        // Order kept from identity.2: the SMB entry is dropped FIRST, so a
        // failed SMB step destroys nothing. identity.3: by its STORED name
        // with `pdbedit -x -u` — `smbpasswd -x` resolves the entry through a
        // Unix account and fails on an orphan or case-mismatched entry, which
        // then blocked the delete. The entry is found case-folded (the one
        // Samba would use for this account); an absent one is skipped, and one
        // that belongs to another live account is left alone. On a node
        // without samba smbEntries() fails open to empty, so this is skipped.
        let smbEntryRemoved = false
        const smb = passdbEntry(await smbEntries(), name)
        if (smb && !passdbOwnedByOther(smb, o.entry.uid)) {
          updateProgress(`Removing SMB password entry for '${name}' (stored as '${smb.stored}')`)
          const dropped = await executor.exec(PDBEDIT, ['-x', '-u', smb.stored])
          if (dropped.exitCode !== 0)
            throw new Error(dropped.stderr.trim() || `pdbedit exited with code ${dropped.exitCode}`)
          smbEntryRemoved = true
        }

        updateProgress(`Deleting share user '${name}'`)
        // Without `-r`: the files keep their uid, and nothing is swept from
        // disk. A later create skips the uid while it still owns files ANAS
        // can see (cr.29); re-creating with the same uid gives them back.
        const r = await executor.exec(USERDEL, [name])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `userdel exited with code ${r.exitCode}`)
        return { deleted: name, smbEntryRemoved }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /identity/groups/:name — delete a local group ------------------
  //
  // Identity.1d. Same gates as the user delete, plus the group's own hard
  // refusal: groupdel cannot run while the group is ANY account's primary
  // group (the account would be left with an unresolvable primary gid).
  server.delete<{ Params: { name: string } }>('/identity/groups/:name', async (request, reply) => {
    const nameParsed = LookupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid group name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // exists → local → band (cr.3: groupdel has no gid floor — without the
    // band gate this route could delete `sudo` (gid 27), `root`, or any system
    // group, review C3) → nobody's primary group → no share names the group
    // (cr.30) — at the route and again in the job.
    const spec = groupGuardSpec(name, 'delete')
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)
    const { entry } = pre.object

    const warnings = [
      `Group '${name}' (gid ${entry.gid}) will be removed from the system`,
      leftOnFiles('gid', entry.gid),
    ]
    warnings.push(...pre.advisories.map(a => a.warning))
    // TODO(cr.30): ACL-root confirm warning here too — see the user delete route.

    // cr.42: the code signs the request and the gid (see the user delete).
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { name },
      address: ['name'],
      message: `Deleting group '${name}' removes the group`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'identity.group.delete',
      { ...identity, params: { group: name } },
      // Ruling (j): the confirmed gid, local, band, the primary-group use and
      // the share references run again before groupdel.
      guarded(spec, pre, async (_o, { updateProgress, newAdvisories }) => {
        refuseNewlyUnreadable(newAdvisories, `group '${name}'`)
        updateProgress(`Deleting group '${name}'`)
        const r = await executor.exec(GROUPDEL, [name])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `groupdel exited with code ${r.exitCode}`)
        return { deleted: name }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })
}
