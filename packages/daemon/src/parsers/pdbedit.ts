/**
 * Parser for `pdbedit -L` output — the Samba passdb user list.
 *
 * Each line is `username:uid:fullname`. The username is the one STORED in the
 * passdb (as first written — tdbsam keys entries by the lowercased name but
 * keeps the case it was given); the uid is what Samba resolves for that stored
 * name at listing time, `4294967295` ((uid_t)-1) when no Unix account answers
 * to it (identity.3, #68).
 */

/** The uid `pdbedit -L` prints when the stored name maps to no Unix account. */
export const PDBEDIT_UNMAPPED_UID = 4294967295

/** A uid field: decimal digits only. */
const UID_FIELD = /^\d+$/

/** One passdb entry as `pdbedit -L` lists it. */
export interface PassdbEntry {
  /** The username exactly as the passdb stores it. */
  stored: string
  /** The uid Samba resolves for `stored`; null when unmapped or unparseable. */
  uid: number | null
}

/**
 * Parse `pdbedit -L` into its entries, in listing order. Blank and nameless
 * lines are skipped; the fullname (which may itself contain colons) is ignored.
 */
export function parsePdbeditEntries(stdout: string): PassdbEntry[] {
  const entries: PassdbEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim())
      continue
    const [stored, uidField] = line.split(':')
    if (!stored)
      continue
    const uid = uidField !== undefined && UID_FIELD.test(uidField) ? Number(uidField) : null
    entries.push({ stored, uid: uid === PDBEDIT_UNMAPPED_UID ? null : uid })
  }
  return entries
}

/**
 * Compare two identity names the way the system does: CASE-INSENSITIVELY
 * (identity.1b). Samba matches account names case-insensitively and may store
 * the passdb entry under a different case than the account database holds —
 * `Alice` in passwd, `alice` in pdbedit. Every comparison of a passwd name
 * against a passdb (or smb.conf) name goes through this one fold.
 */
export function sameIdentityName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The passdb entry Samba would use for `name` — found case-FOLDED (the
 * identity.1b fold; this replaces the name-set `passdbHas`), because
 * tdbsam looks entries up by the lowercased name, so `smbpasswd`/logon for
 * `Alice` land on an entry stored as `alice` (identity.3). An exact-case entry
 * wins if a backend ever lists more than one. Null when there is none.
 */
export function passdbEntry(entries: PassdbEntry[], name: string): PassdbEntry | null {
  return entries.find(e => e.stored === name)
    ?? entries.find(e => sameIdentityName(e.stored, name))
    ?? null
}

/**
 * Does `entry` really serve the account `name` (uid `uid`)? Only an EXACT-case
 * stored name whose uid Samba resolves to the account's own uid does
 * (identity.3): a case-different entry resolves `getpwnam(<stored>)`, which
 * fails for a mixed-case account, and the session becomes a guest.
 */
export function passdbServes(entry: PassdbEntry | null, name: string, uid: number): boolean {
  return entry !== null && entry.stored === name && entry.uid === uid
}

/**
 * Does `entry` belong to a DIFFERENT live account than the one with uid `uid`
 * (null = an account that does not exist yet)? Samba resolved its stored name
 * to some other uid, so it is that account's SMB password — never replace or
 * drop it on this account's behalf. An unmapped entry is an orphan: nobody's.
 */
export function passdbOwnedByOther(entry: PassdbEntry | null, uid: number | null): boolean {
  return entry !== null && entry.uid !== null && entry.uid !== uid
}
