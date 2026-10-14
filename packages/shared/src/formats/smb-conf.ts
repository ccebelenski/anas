import { z } from 'zod'
import { hasControlChars } from '../schemas/common.js'

/**
 * The per-format validation layer for smb.conf (0.4.3 retrospective ruling
 * (i) — one validator per file format, in `shared/`).
 *
 * Samba's own parser (`lib/param/params.c`) reads a parameter as everything
 * after the FIRST `=` on a line, whitespace-trimmed, with two structural
 * facts that matter for anything ANAS writes:
 *
 *  - a `\` as the line's LAST character (after trailing whitespace has been
 *    trimmed) makes the parameter CONTINUE on the next line — a value ending
 *    in `\` swallows whatever line follows it. This is exactly how the
 *    parsers/smb-conf.ts reader folds continuations, and how the review's
 *    H3 attack writes a final `valid users` entry `bob\` that absorbs the
 *    next stanza line (e.g. `hosts allow`).
 *  - `;` and `#` begin a comment ONLY at the START of a line (after optional
 *    whitespace). ANAS always writes a value after `key = `, so a value that
 *    begins with `;` or `#` never starts the line and is not a comment; and
 *    one that contains them mid-string is literal. Neither is refused.
 *
 * Leading/trailing whitespace around a value is trimmed by Samba (and by the
 * ANAS reader), so it never needs to be written faithfully and is not a
 * refusal. It also means the continuation check is on the value with trailing
 * whitespace stripped: `bob\ ` (backslash then spaces) still lands the `\`
 * at the line end once Samba trims it.
 *
 * These validators gate ANAS's WRITE side. Reading the system's own file is
 * deliberately lenient (never refuse to read smb.conf): a hand-written entry
 * Samba accepts parses and round-trips even when it would not satisfy
 * {@link SmbConfListEntry} (single-source-of-truth rule — the parser's
 * round-trip is byte-identical by construction, and these rules only narrow
 * what ANAS itself writes).
 */

/** The one structural hazard: a `\` at the line end is a Samba continuation. */
function hasContinuationBackslash(s: string): boolean {
  return s.trimEnd().endsWith('\\')
}

/** The refusal sentence every smb.conf value door uses (one phrasing). */
export const SMB_CONF_VALUE_MSG
  = 'a value written into smb.conf must not contain control characters or end with a backslash (Samba reads a trailing `\\` as a line continuation)'

/** The refusal sentence for one ENTRY of a joined list (adds the separator rule). */
export const SMB_CONF_LIST_ENTRY_MSG
  = `${SMB_CONF_VALUE_MSG}, and it must not contain a space, comma or tab (Samba list separators — the writer joins entries with spaces)`

/** Is `s` a safe single smb.conf value? (see the file head for why). */
export function isSmbConfValue(s: string): boolean {
  if (s.length > 4096)
    return false
  if (hasControlChars(s))
    return false
  return !hasContinuationBackslash(s)
}

/**
 * One smb.conf parameter value (a `path`, `comment`, `workgroup`,
 * `server string`, …). Control characters are refused (a newline would forge
 * extra parameters) and a trailing `\` after whitespace trim is refused (a
 * line continuation that swallows the next line). Spaces, `=`, `;`, `#` and a
 * MID-STRING `\` (a Windows-style `DOMAIN\user` name) are literal to Samba
 * and stay legal.
 */
export const SmbConfValue = z.string().refine(isSmbConfValue, SMB_CONF_VALUE_MSG)

// Samba joins list-style parameters (valid users, hosts allow, interfaces)
// on whitespace and/or commas and reads them back the same way.
const SMB_LIST_SEPARATOR_RE = /[,\s]/

/**
 * One ENTRY of a whitespace/comma-joined smb.conf list. The entry must be a
 * safe {@link isSmbConfValue} value AND carry no separator: the writer joins
 * entries with spaces and the reader splits them on whitespace/commas, so an
 * entry containing either is a different list on read than it was on write
 * (and an entry that merely ENDS in `\` would — as the final entry — sit at
 * the line end and continue it). `@group`, `+netgroup` and `%U` are legitimate
 * entries (the request tests carry them); `DOMAIN\user` is legitimate mid-
 * string, only a trailing `\` is refused.
 */
export function isSmbConfListEntry(s: string): boolean {
  if (!isSmbConfValue(s))
    return false
  return !SMB_LIST_SEPARATOR_RE.test(s)
}

/** One smb.conf list entry (see {@link isSmbConfListEntry}). */
export const SmbConfListEntry = z.string().refine(isSmbConfListEntry, SMB_CONF_LIST_ENTRY_MSG)
