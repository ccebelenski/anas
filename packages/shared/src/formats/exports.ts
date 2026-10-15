import { z } from 'zod'
import { hasControlChars } from '../schemas/common.js'

/**
 * The per-format validation layer for /etc/exports (0.4.3 retrospective
 * ruling (i) — one validator per file format, in `shared/`).
 *
 * An export line is `<path> <client>(<opts>) <client2>(<opts>) …`, so the
 * three user-supplied pieces of a line are validated rather than escaped
 * (exportfs(5) has no escape; a comma, space, quote, `\` or `#` in one of
 * them changes the PARSE, hides a client, or continues the line):
 *
 *  - a CLIENT SPEC is one whitespace-delimited token: a hostname, a wildcard
 *    host (`*.lan`), an IPv4/IPv6 address or CIDR, a `@netgroup`, or `*`.
 *    Refused: whitespace, `(`, `)`, `,`, `"`, `\`, `#` — a space adds a
 *    client, `(…)` starts an option list, `,` splits options, `"` breaks the
 *    path quoting, a trailing `\` continues the line, and `#` hides a token.
 *  - an OPTION is a token: a name of letters/digits/`_`, optionally `=` and a
 *    value of letters/digits/`_ . : / -`. Options are joined with `,`, so an
 *    option that carries a comma, whitespace or any of the paren/quote/`\`/
 *    `#` set changes which options the kernel reads.
 *  - a PATH is double-quoted by the writer only when it contains whitespace
 *    (`/mnt/My Data` stays legal) — so a path must not carry `"` (breaks the
 *    quoting and sidesteps the path's own checks), `\` (a line-continuation),
 *    `#`, or a control character.
 *
 * Like the fstab layer, these validators gate ANAS's WRITE side. Reading the
 * system's own file stays lenient — a hand-written line parses and round-trips
 * byte-identically even when it would not satisfy these rules.
 */

// ── Client specs ─────────────────────────────────────────────────────────────

const EXPORT_CLIENT_SPEC_RE = /^\S+$/

/** A legal client charset: no whitespace and none of the exports delimiters. */
const EXPORT_CLIENT_SPEC_CHARS_RE = /[() ,"\\#]/

/**
 * Is `s` one client spec — a whitespace-delimited token free of the exports
 * delimiters `() , " \ #`? A hostname (`host1`, `host.example.com`), wildcard
 * host (`*.lan`), IP/CIDR (`192.168.1.0/24`, `2001:db8::1/64`), `@netgroup`,
 * or `*`. The veto is the review's: any of the structural characters changes
 * how exportfs splits the line, so a spec that needs one is refused rather
 * than written.
 */
export function isExportClientSpec(s: string): boolean {
  if (s.length > 255)
    return false
  if (!EXPORT_CLIENT_SPEC_RE.test(s))
    return false
  // A leading `-` makes exportfs read the token as a default-options block
  // (`-x(rw)` → `unknown keyword "x(rw)"`, node pass 2026-10-14).
  if (s.startsWith('-'))
    return false
  return !EXPORT_CLIENT_SPEC_CHARS_RE.test(s)
}

/** One client spec (see {@link isExportClientSpec}). */
export const ExportClientSpec = z
  .string()
  .refine(isExportClientSpec, 'a client spec is a single host, wildcard host (*.lan), IP/CIDR, @netgroup or `*` — no leading dash, whitespace, parentheses, comma, quote, backslash or hash')

// ── Options ──────────────────────────────────────────────────────────────────

/** One option token: a name of `\w`, optionally `= value` of `\w . : / -`. */
const EXPORT_OPTION_RE = /^\w+(?:=[\w.:/-]+)?$/

/**
 * Is `t` one exports option token? A name of letters, digits, `_`, optionally
 * `=` and a value of letters, digits, `_ . : / -` — no whitespace, `,`, `(`,
 * `)`, `"`, `\` or `#`. `rw`, `sync`, `no_subtree_check`, `sec=sys`,
 * `fsid=0` and `anonuid=65534` all pass; any option that would need one of
 * the refused characters is refused, never written.
 */
export function isExportOption(t: string): boolean {
  return t.length <= 512 && EXPORT_OPTION_RE.test(t)
}

/** One exports option token (see {@link isExportOption}). */
export const ExportOption = z
  .string()
  .refine(isExportOption, 'an export option is one token: a name of letters, digits, `_`, optionally `=` and a value of letters, digits, `_ . : / -`')

/** Split a comma-joined option list into its tokens (`''` resolves to none). */
export function exportOptionTokens(s: string): string[] {
  return s === '' ? [] : s.split(',')
}

/**
 * A comma-separated exports option list — every token an {@link ExportOption}
 * and no empty token (`''` itself is allowed: a client may carry no options).
 */
export const ExportOptionList = z
  .string()
  .max(8192)
  .refine(
    s => s === '' || exportOptionTokens(s).every(t => ExportOption.safeParse(t).success),
    'export options must be a comma-separated list of option tokens, with no empty or whitespace-bearing token',
  )

// ── Paths ────────────────────────────────────────────────────────────────────

const EXPORT_PATH_BAD_CHAR_RE = /["\\#]/

/** The refusal sentence for an export path (used by the request schemas). */
export const EXPORT_PATH_MSG
  = 'an export path must not contain a double quote, backslash, hash, or control character — the writer double-quotes only whitespace paths'

/**
 * Is `p` a path that can be written into /etc/exports? Space is legal (the
 * writer double-quotes a whitespace path and the reader parses it back), but
 * `"`, `\`, `#` and control characters are refused: `"` breaks the writer's
 * own quoting, `\` is exportfs's line continuation, `#` and control
 * characters gate the line. (Absolute-ness and traversal are the request
 * schema's `AbsolutePath`'s job — composed with this predicate there.)
 */
export function isExportPath(p: string): boolean {
  if (hasControlChars(p))
    return false
  return !EXPORT_PATH_BAD_CHAR_RE.test(p)
}
