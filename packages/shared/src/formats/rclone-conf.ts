import { z } from 'zod'
import { hasControlChars } from '../schemas/common.js'

/**
 * The per-format validation layer for rclone.conf (0.4.3 retrospective ruling
 * (i) — one validator per file format, in `shared/`).
 *
 * rclone.conf is plain INI: `[section]` headers, `key = value` lines, and full-
 * line comments. A written line is `${key} = ${value}`, so BOTH halves are
 * gated (cr.13, review H3(c)):
 *
 *  - a KEY is a config option or field name — rclone's own vocabulary is
 *    letters, digits and underscores (rclone maps `--flag-name` to the config
 *    key `flag_name`). A key carrying anything else — a space, a newline, a
 *    `]` — names no real option and can forge a line or a `[section]` header.
 *  - a VALUE is the rest of the line, verbatim (it may contain `=`, spaces,
 *    `;`, `#` or JSON), but it must NOT carry a control character: a newline
 *    or CR forges extra lines — a newline in a secret non-password option
 *    value can smuggle a whole `[section]` (review H3(c)). The one legitimate
 *    multi-line text a user pastes — the OAuth token JSON block — is
 *    collapsed to a single line by `normalizeOAuthToken` (whose JSON is
 *    whitespace-insensitive), so no written value ever needs a literal
 *    newline.
 *
 * Like the fstab layer, these validators gate ANAS's WRITE side. Reading the
 * system's own file stays lenient: a hand-written line parses and round-trips
 * byte-identically even when it would not satisfy these rules.
 */

/** One rclone option / field KEY: letters, digits, underscores only (`\w`). */
const RCLONE_OPTION_KEY_RE = /^\w+$/

/** The refusal sentence for a value written into rclone.conf (one phrasing). */
export const RCLONE_OPTION_VALUE_MSG
  = 'a value written into rclone.conf must not contain control characters (a newline would forge another line or a section header)'

/** Is `s` a safe rclone option key (letters, digits, `_`)? */
export function isRcloneOptionKey(s: string): boolean {
  return s.length <= 128 && RCLONE_OPTION_KEY_RE.test(s)
}

/**
 * One rclone option / field key. `^[A-Za-z0-9_]+$` — letters, digits and
 * underscores only (rclone's config keys; a `]`, `=` or space would change
 * the line's or the section's parse).
 */
export const RcloneOptionKey = z
  .string()
  .refine(isRcloneOptionKey, 'an rclone option key is letters, digits and underscores only')

/** Is `s` a safe rclone option VALUE — no control characters (newline, CR)? */
export function isRcloneOptionValue(s: string): boolean {
  return s.length <= 65536 && !hasControlChars(s)
}

/**
 * One rclone option value. No control characters — a newline or CR would forge
 * an extra `key = value` line (and, in a secret option that the post-write
 * gate does not compare, a whole `[section]`). Spaces, `=`, `;`, `#` and JSON
 * inside a value are literal to rclone and stay legal.
 */
export const RcloneOptionValue = z.string().refine(isRcloneOptionValue, RCLONE_OPTION_VALUE_MSG)
