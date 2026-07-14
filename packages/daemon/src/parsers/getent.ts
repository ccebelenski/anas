/**
 * Parsers for `getent` output (passwd / group / shadow).
 *
 * Identity is resolved ONLY through getent/nsswitch — never by reading
 * /etc/passwd or /etc/group directly (DESIGN Epic 8 seam). This keeps the
 * source of truth abstract: local files, LDAP, and AD users all surface here
 * identically once the box is configured.
 */

import type { SystemGroup, SystemUser } from '@anas/shared'

/** One `getent passwd` line, all seven colon-separated fields. */
export interface PasswdEntry {
  name: string
  uid: number
  gid: number
  /** GECOS / full-name field (may contain commas and spaces). */
  gecos: string
  home: string
  shell: string
}

/** One `getent group` line: name, gid, and comma-split members. */
export interface GroupEntry {
  name: string
  gid: number
  members: string[]
}

/**
 * Share-relevant ids: root (0) plus the regular-user band [1000, 60000)
 * (Debian login.defs UID_MIN..UID_MAX). Filters out both the 1..999 service
 * range AND high dynamically-allocated system accounts (e.g. `ceph` 64045,
 * `nobody` 65534) so pickers/lists show a clean access landscape (story 8.1).
 * Reused for both uids and gids.
 */
export function isShareRelevant(id: number): boolean {
  return id === 0 || (id >= 1000 && id < 60000)
}

/**
 * Parse `getent passwd` into entries. Lines are
 * `name:passwd:uid:gid:gecos:home:shell`; blank lines and malformed lines
 * (missing name / non-numeric uid or gid) are skipped. The gecos field is kept
 * verbatim — colon is the only delimiter, so embedded commas/spaces survive.
 */
export function parsePasswd(stdout: string): PasswdEntry[] {
  const entries: PasswdEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim())
      continue
    const parts = line.split(':')
    const name = parts[0]
    const uid = Number.parseInt(parts[2], 10)
    const gid = Number.parseInt(parts[3], 10)
    if (!name || Number.isNaN(uid) || Number.isNaN(gid))
      continue
    entries.push({
      name,
      uid,
      gid,
      gecos: parts[4] ?? '',
      home: parts[5] ?? '',
      shell: parts[6] ?? '',
    })
  }
  return entries
}

/**
 * Parse `getent group` into entries. Lines are `name:passwd:gid:members`,
 * where members is a comma-separated list (empty when there are none).
 */
export function parseGroups(stdout: string): GroupEntry[] {
  const groups: GroupEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim())
      continue
    const parts = line.split(':')
    const name = parts[0]
    const gid = Number.parseInt(parts[2], 10)
    if (!name || Number.isNaN(gid))
      continue
    const members = (parts[3] ?? '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean)
    groups.push({ name, gid, members })
  }
  return groups
}

/**
 * Parse `getent shadow` into a name → expire-days map (8th field). Used only to
 * derive the `locked` flag: our disable op sets `--expiredate 1`, enable clears
 * it. Share users have no Unix password (`!` in the pw field) by design, so the
 * password-lock field is meaningless here — expiry is the real signal.
 */
export function parseShadowExpiry(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    if (!line.trim())
      continue
    const parts = line.split(':')
    const name = parts[0]
    if (!name)
      continue
    map.set(name, parts[7] ?? '')
  }
  return map
}

/**
 * Is an account expired (hence disabled) given its shadow expire field?
 * Empty or `-1` means "never expires" → not locked. A non-negative day count
 * at or before today means the account has expired → locked. `--expiredate 1`
 * (day 1, 1970) is always in the past, so it reads as locked.
 */
export function isExpired(expire: string): boolean {
  if (expire === '' || expire === '-1')
    return false
  const days = Number(expire)
  if (!Number.isFinite(days) || days < 0)
    return false
  const todayDays = Math.floor(Date.now() / 86_400_000)
  return days <= todayDays
}

/** Project a passwd entry to the lean pickable SystemUser. */
export function toSystemUser(entry: PasswdEntry): SystemUser {
  return { name: entry.name, uid: entry.uid }
}

/** Project a group entry to the lean pickable SystemGroup. */
export function toSystemGroup(entry: GroupEntry): SystemGroup {
  return { name: entry.name, gid: entry.gid }
}

/** The user's primary group name (resolved from the passwd gid), or null. */
export function primaryGroupName(entry: PasswdEntry, groups: GroupEntry[]): string | null {
  return groups.find(g => g.gid === entry.gid)?.name ?? null
}

/**
 * All groups a user belongs to: the primary group (from the passwd gid) plus
 * every group whose member list names the user. Primary first, de-duplicated.
 */
export function userGroups(entry: PasswdEntry, groups: GroupEntry[]): string[] {
  const names: string[] = []
  const primary = primaryGroupName(entry, groups)
  if (primary)
    names.push(primary)
  for (const g of groups) {
    if (g.members.includes(entry.name) && !names.includes(g.name))
      names.push(g.name)
  }
  return names
}
