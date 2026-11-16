import type { Refusal } from '../safety/guard.js'

/**
 * The ONE rule for a key on more than one config line (cr4.conf D-2 / D-21),
 * shared by /etc/exports and /etc/fstab.
 *
 * An edit in both parsers is first-match: it rewrites the FIRST line for the
 * key, reports success, and the second line still exports the path or still
 * mounts it at boot. That is a change the operator did not ask for and cannot
 * see. So an edit REFUSES — at the route door, before any change and before a
 * confirm is minted, and again in the job's last-moment transform — while the
 * reads keep working and carry the same sentence with the same line numbers.
 * The numbers always come from the file's own parser (`linesFor` in each
 * parser), never from a second scan.
 *
 * /etc/fstab refuses every verb: two lines for one mountpoint are not a layout
 * mount reads. /etc/exports allows the same path on several lines with
 * different clients, so a DELETE there removes every line (pinned by
 * `removeExport`); only an edit refuses.
 */

/** What ANAS does with a duplicated key, and what the operator can do about it. */
export interface DuplicateRule {
  /** The rule sentence's middle clause. */
  edit: string
  /** The sentence's closing instruction. */
  remedy: string
}

/** /etc/fstab: no verb may touch a mountpoint on more than one line. */
export const FSTAB_DUPLICATE: DuplicateRule = {
  edit: 'ANAS changes one line for a path.',
  remedy: 'Remove the line you do not want, then try again.',
}

/**
 * /etc/exports: an edit acts on one line, and a path on several lines is edited
 * by hand. The DELETE verb is not refused — it removes every line.
 */
export const EXPORT_DUPLICATE: DuplicateRule = {
  edit: 'ANAS edits an export that is on one line.',
  remedy: 'Merge those lines into one by hand, then try again.',
}

/** Line numbers as one prose list: `3 and 4`; `2, 5 and 9`. */
function lineList(lines: number[]): string {
  if (lines.length <= 2)
    return lines.join(' and ')
  return `${lines.slice(0, -1).join(', ')} and ${lines.at(-1)}`
}

/**
 * The sentence the operator reads. `file` is the REAL path the node reads
 * (`/etc/exports`, `/etc/fstab`) even when a test redirects the file — the
 * house convention for every config sentence.
 */
export function duplicateKeySentence(key: string, lines: number[], file: string, rule: DuplicateRule = FSTAB_DUPLICATE): string {
  return `${key} is on lines ${lineList(lines)} of ${file}. ${rule.edit} ${rule.remedy}`
}

/** The door refusal for a duplicated key — 409, the sentence above. */
export function duplicateKeyRefusal(key: string, lines: number[], file: string, rule: DuplicateRule = FSTAB_DUPLICATE): Refusal {
  return { status: 409, code: 'CONFLICT', message: duplicateKeySentence(key, lines, file, rule) }
}

/**
 * The warning a read carries for a duplicated key, spreadable into the row
 * (`...duplicateKeyWarning(...)`); nothing when the key is on one line.
 */
export function duplicateKeyWarning(key: string, lines: number[], file: string, rule: DuplicateRule = FSTAB_DUPLICATE): { warnings?: string[] } {
  return lines.length > 1 ? { warnings: [duplicateKeySentence(key, lines, file, rule)] } : {}
}
