/**
 * Parser for `pdbedit -L` output — the Samba passdb user list.
 *
 * Each line is `username:uid:gecos`. We only need the set of usernames that
 * have an SMB passdb entry (i.e. can authenticate to SMB shares); the uid and
 * gecos are redundant with getent.
 */

/**
 * Parse `pdbedit -L` into a Set of SMB-enabled usernames (first colon field).
 * Blank and nameless lines are skipped.
 */
export function parsePdbeditNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split('\n')) {
    if (!line.trim())
      continue
    const name = line.split(':')[0]
    if (name)
      names.add(name)
  }
  return names
}
