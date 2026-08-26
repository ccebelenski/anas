import { readFile } from 'node:fs/promises'
import { IscsiIqn } from '@anas/shared'

/**
 * The node's own initiator IQN, from open-iscsi's identity file.
 *
 * ANAS is the TARGET side of iSCSI, but the node is also an ordinary
 * initiator, and its own IQN is the value an operator is most likely to want
 * in a new target's ACL list. open-iscsi keeps it in
 * `/etc/iscsi/initiatorname.iscsi` as `InitiatorName=<iqn>`; the file may be
 * absent (open-iscsi not installed), unreadable, or hold no legal name — the
 * read is FAIL-OPEN to `null` in every one of those cases, because a null is
 * the UI's "hide the button" and never an error.
 */

/** open-iscsi's node identity file. */
export const INITIATOR_NAME_PATH = '/etc/iscsi/initiatorname.iscsi'

/** The one line the file carries; everything else is comment or blank. */
const INITIATOR_LINE = /^InitiatorName=(\S.*)$/

/**
 * The `InitiatorName` value of an `initiatorname.iscsi` body, or null.
 *
 * `#` lines are open-iscsi's comments and are skipped, as are blanks. The
 * first `InitiatorName=` line wins; its value must parse as a legal iSCSI
 * name — anything else (a hand-edit, a foreign format ANAS cannot validate)
 * reads as "none", so the UI never offers a row the daemon would refuse.
 */
export function parseInitiatorName(content: string): string | null {
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#'))
      continue
    const m = INITIATOR_LINE.exec(line)
    if (!m)
      continue
    const value = m[1].trim()
    return IscsiIqn.safeParse(value).success ? value : null
  }
  return null
}

/**
 * Read the node's own initiator IQN, FAIL-OPEN to null.
 *
 * `path` defaults to the real file; the iSCSI read layer's `IscsiPaths`
 * carries a seam for it, so no test host ever reads the machine's own
 * open-iscsi state.
 */
export async function readNodeInitiatorName(path?: string): Promise<string | null> {
  try {
    const content = await readFile(path ?? INITIATOR_NAME_PATH, 'utf-8')
    return parseInitiatorName(content)
  }
  catch {
    return null
  }
}
