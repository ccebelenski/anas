import type { ShareGroup, ShareUser } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor, ExecOptions, ExecResult } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { GroupEntry, PasswdEntry } from '../parsers/getent.js'
import type { PassdbEntry } from '../parsers/pdbedit.js'
import type { ConfirmStore } from '../safety/confirm.js'
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
  sameIdentityName,
} from '../parsers/pdbedit.js'
import { parseSmbConf } from '../parsers/smb-conf.js'
import { confirmGate } from '../safety/gate.js'
import { readConfig } from '../services/config-writer.js'
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
   * identity a share still names in `valid users` (identity.1d).
   */
  smbConfPath: string
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
  const { executor, jobQueue, confirmStore, smbConfPath } = opts
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

  /**
   * The share names (SMB `valid users`) that reference an identity (identity.1d).
   * A user is referenced by a bare entry, a group by an `@`-prefixed one; the
   * match is case-folded (Samba is case-insensitive in smb.conf too).
   *
   * Returns `{ shares, unknown }`: `unknown` is true when smb.conf could not
   * be read (a read error, not an absent file) — the caller then discloses it
   * at the confirm door instead of failing open silently (the ahr-mutate D3
   * pattern). An ABSENT file (samba removed) genuinely means no references.
   */
  async function sharesReferencing(
    name: string,
    isGroup: boolean,
  ): Promise<{ shares: string[], unknown: boolean }> {
    let text: string
    try {
      text = await readConfig(smbConfPath)
    }
    catch {
      return { shares: [], unknown: true }
    }
    const shares = parseSmbConf(text).shares
    const refs = shares
      .filter(s => s.validUsers.some(entry => (isGroup
        ? entry.startsWith('@') && sameIdentityName(entry.slice(1), name)
        : sameIdentityName(entry, name))))
      .map(s => s.name)
    return { shares: refs, unknown: false }
  }

  /** The hard-409 body for a referenced identity — ONE shape for both verbs. */
  function referencedConflict(kind: 'user' | 'group', name: string, shares: string[]) {
    return {
      error: {
        code: 'CONFLICT',
        reason: 'referenced-by-share',
        message: `${kind === 'user' ? 'User' : 'Group'} '${name}' is referenced by share(s): ${shares.join(', ')}. Remove it from their 'valid users' first. This refusal has no confirm bypass.`,
      },
    }
  }

  /** 409 for a mutation aimed at a directory-provided (read-only) identity. */
  function rejectDirectory(reply: FastifyReply, kind: 'user' | 'group', name: string) {
    reply.code(409)
    return {
      error: {
        code: 'CONFLICT',
        message: `${kind === 'user' ? 'User' : 'Group'} '${name}' is directory-provided (not in the local files DB) and is read-only here`,
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

    // 409 if the name already resolves anywhere (local OR directory) — getent is
    // the source of truth, and useradd would collide.
    if (await resolveUser(req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `User '${req.name}' already exists` } }
    }

    // Referenced supplementary groups must exist.
    if (req.groups && req.groups.length > 0) {
      const groups = await allGroups()
      const known = new Set(groups.map(g => g.name))
      const missing = req.groups.filter(g => !known.has(g))
      if (missing.length > 0) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Unknown group(s): ${missing.join(', ')}` } }
      }
    }

    // Samba preflight (issue #6). Refuse BEFORE the job runs useradd, so a node
    // without samba never ends up with a half-created user whose SMB password
    // silently never landed. The API is the authority on what is possible
    // (Principle 14) — the client just gets a 400 that says what to install.
    if (req.smbPassword !== undefined && !(await smbAvailable())) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `${SMB_NOT_INSTALLED}. The user was NOT created.` } }
    }

    // useradd -N -M -s /usr/sbin/nologin [-c <fullName>] [-G <groups>] <name>
    // -N (identity.1c): NO user-private group — the account takes the default
    // group from /etc/default/useradd, so creating 'Alice' does not conjure a
    // phantom group 'alice' into the Groups list. Pre-existing users keep
    // whatever group they already had.
    const args = ['-N', '-M', '-s', NOLOGIN]
    if (req.fullName !== undefined)
      args.push('-c', req.fullName)
    if (req.groups && req.groups.length > 0)
      args.push('-G', req.groups.join(','))
    args.push(req.name)

    // identity.3 (#68): Samba looks passdb entries up case-FOLDED, so an entry
    // left under another case would be the one this account logs in with —
    // and it can never map to it. An orphan (its account gone) is replaced by
    // the job when this create sets an SMB password; without one there is
    // nothing to replace it with, and an entry that belongs to another live
    // account is never touched. Checked before the job runs useradd.
    const existing = passdbEntry(await smbEntries(), req.name)
    if (existing && passdbOwnedByOther(existing, null)) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'passdb-entry-owned',
          message: `Samba's password database already holds an entry stored as '${existing.stored}', which belongs to another account (uid ${existing.uid}). Samba matches user names case-insensitively, so '${req.name}' could never hold its own SMB password. Pick a different name. The user was NOT created.`,
        },
      }
    }
    if (existing && existing.stored !== req.name && req.smbPassword === undefined) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'passdb-orphan',
          message: `Samba's password database holds an orphan entry stored as '${existing.stored}' (its account no longer exists), which Samba would match to '${req.name}' and turn into a guest session. Set an SMB password in this dialog to replace it, or remove it first with: pdbedit -x -u ${existing.stored}. The user was NOT created.`,
        },
      }
    }

    const smbPassword = req.smbPassword

    const job = jobQueue.submit(
      'identity.user.add',
      { ...identity, params: { user: req.name, groups: req.groups, smbEnabled: smbPassword !== undefined } },
      async (updateProgress) => {
        updateProgress(`Creating share user '${req.name}'`)
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
          smbEnabled: smbPassword !== undefined,
          ...(replaced !== undefined ? { smbEntryReplaced: replaced } : {}),
        }
      },
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

    const account = await resolveUser(name)
    if (!account) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `User '${name}' not found` } }
    }
    if (!(await isLocalUser(name)))
      return rejectDirectory(reply, 'user', name)

    // Samba preflight (issue #6) — same reasoning as the create route above.
    if (!(await smbAvailable())) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `${SMB_NOT_INSTALLED}. The password was NOT changed.` } }
    }

    // identity.3: smbpasswd lands on the entry Samba finds case-folded — when
    // that entry is ANOTHER live account's, setting this password would change
    // that account's. Refuse before anything runs.
    const existing = passdbEntry(await smbEntries(), name)
    if (existing && passdbOwnedByOther(existing, account.uid)) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'passdb-entry-owned',
          message: `Samba's password database entry for '${name}' is stored as '${existing.stored}', which belongs to another account (uid ${existing.uid}). Samba matches user names case-insensitively, so '${name}' cannot hold its own SMB password. The password was NOT changed.`,
        },
      }
    }

    const job = jobQueue.submit(
      'identity.smbpasswd.set',
      { ...identity, params: { user: name } },
      async (updateProgress) => {
        // Password on stdin (smbpasswd -s), never argv — never logged;
        // verified exact-case afterwards, a stale entry replaced (identity.3).
        const replaced = await setSmbPasswordVerified(name, password, updateProgress)
        return { user: name, smbEnabled: true, ...(replaced !== undefined ? { smbEntryReplaced: replaced } : {}) }
      },
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

    const account = await resolveUser(name)
    if (!account) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `User '${name}' not found` } }
    }
    if (!(await isLocalUser(name)))
      return rejectDirectory(reply, 'user', name)

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
      async (updateProgress) => {
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
        // toggle, never this one's (identity.3).
        const smb = passdbEntry(await smbEntries(), name)
        if (smb && !passdbOwnedByOther(smb, account.uid)) {
          updateProgress(`${enabled ? 'Enabling' : 'Disabling'} SMB access for '${name}'`)
          const smb = await execSmbpasswd([enabled ? '-e' : '-d', name])
          if (smb.exitCode !== 0)
            throw new Error(smb.stderr.trim() || `smbpasswd exited with code ${smb.exitCode}`)
        }
        return { user: name, enabled }
      },
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

    if (await resolveGroup(req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Group '${req.name}' already exists` } }
    }

    const job = jobQueue.submit(
      'identity.group.add',
      { ...identity, params: { group: req.name } },
      async () => {
        const r = await executor.exec(GROUPADD, [req.name])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `groupadd exited with code ${r.exitCode}`)
        return { created: req.name }
      },
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

    if (!(await resolveGroup(name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Group '${name}' not found` } }
    }
    if (!(await isLocalGroup(name)))
      return rejectDirectory(reply, 'group', name)

    // Members being ADDED must resolve (getent); removals need not.
    if (add.length > 0) {
      const users = await allUsers()
      const known = new Set(users.map(u => u.name))
      const missing = add.filter(u => !known.has(u))
      if (missing.length > 0) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Unknown user(s): ${missing.join(', ')}` } }
      }
    }

    const job = jobQueue.submit(
      'identity.group.members',
      { ...identity, params: { group: name, add, remove } },
      async (updateProgress) => {
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
      },
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /identity/users/:name — delete a local share user -------------
  //
  // Identity.1d. The same local-identity gate the update routes use (LookupName
  // → exists → local), then the HARD refusals (no confirm bypass): a name a
  // share still carries in `valid users`. What remains is confirm-gated
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

    const entry = await resolveUser(name)
    if (!entry) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `User '${name}' not found` } }
    }
    if (!(await isLocalUser(name)))
      return rejectDirectory(reply, 'user', name)

    const refs = await sharesReferencing(name, false)
    if (refs.shares.length > 0) {
      reply.code(409)
      return referencedConflict('user', name, refs.shares)
    }

    // The passdb check is route-time for the WARNING (it describes what will
    // happen); the job re-checks live so the `pdbedit -x` side stays honest
    // if the passdb moves between the two.
    const routeSmb = passdbEntry(await smbEntries(), name)
    const hasSmb = routeSmb !== null && !passdbOwnedByOther(routeSmb, entry.uid)
    const warnings = [
      `User '${name}' (uid ${entry.uid}) will be removed from the system`,
      `Files owned by the user keep their uid (${entry.uid}) — ownership is not changed, and a later user with the same uid would own them`,
    ]
    if (hasSmb)
      warnings.push(`Its SMB password entry will be removed`)
    if (refs.unknown)
      warnings.push('ANAS could not read smb.conf to check for share references. If this node has SMB shares, verify none of them names this user before confirming.')

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'identity.user.delete',
      params: { name },
      message: `Deleting share user '${name}' removes the account`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'identity.user.delete',
      { ...identity, params: { user: name } },
      async (updateProgress) => {
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
        if (smb && !passdbOwnedByOther(smb, entry.uid)) {
          updateProgress(`Removing SMB password entry for '${name}' (stored as '${smb.stored}')`)
          const dropped = await executor.exec(PDBEDIT, ['-x', '-u', smb.stored])
          if (dropped.exitCode !== 0)
            throw new Error(dropped.stderr.trim() || `pdbedit exited with code ${dropped.exitCode}`)
          smbEntryRemoved = true
        }

        updateProgress(`Deleting share user '${name}'`)
        // Without `-r`: the files keep their uid, and nothing is swept from
        // disk — a later user with the same uid would own them.
        const r = await executor.exec(USERDEL, [name])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `userdel exited with code ${r.exitCode}`)
        return { deleted: name, smbEntryRemoved }
      },
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

    const entry = await resolveGroup(name)
    if (!entry) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Group '${name}' not found` } }
    }
    if (!(await isLocalGroup(name)))
      return rejectDirectory(reply, 'group', name)

    // Every resolvable account is checked, not only local ones: a directory
    // user pinned to this gid would be broken the same way.
    const primaries = (await allUsers()).filter(u => u.gid === entry.gid).map(u => u.name)
    if (primaries.length > 0) {
      reply.code(409)
      return {
        error: {
          code: 'CONFLICT',
          reason: 'primary-group-in-use',
          message: `Group '${name}' is the primary group of: ${primaries.join(', ')}. Change their primary group (or remove the users) first. This refusal has no confirm bypass.`,
        },
      }
    }

    const refs = await sharesReferencing(name, true)
    if (refs.shares.length > 0) {
      reply.code(409)
      return referencedConflict('group', name, refs.shares)
    }

    const warnings = [
      `Group '${name}' (gid ${entry.gid}) will be removed from the system`,
      `Files owned by the group keep their gid (${entry.gid}) — ownership is not changed, and a later group with the same gid would own them`,
    ]
    if (refs.unknown)
      warnings.push('ANAS could not read smb.conf to check for share references. If this node has SMB shares, verify none of them names this group before confirming.')

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'identity.group.delete',
      params: { name },
      message: `Deleting group '${name}' removes the group`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'identity.group.delete',
      { ...identity, params: { group: name } },
      async (updateProgress) => {
        updateProgress(`Deleting group '${name}'`)
        const r = await executor.exec(GROUPDEL, [name])
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `groupdel exited with code ${r.exitCode}`)
        return { deleted: name }
      },
    )

    reply.code(202)
    return { job }
  })
}
