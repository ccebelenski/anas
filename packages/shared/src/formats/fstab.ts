import { z } from 'zod'

/**
 * The per-format validation layer for /etc/fstab (0.4.3 retrospective ruling
 * (i): ONE validator per file format, in `shared/`).
 *
 * /etc/fstab is a whitespace-separated six-field format:
 *
 *   <fs_spec> <fs_file> <fs_vfstype> <fs_mntopts> <fs_freq> <fs_passno>
 *
 * A field that must carry one of the field-breaking characters is written as
 * its octal escape, exactly as getmntent(3) decodes it on read:
 *
 *   space `\040`, tab `\011`, newline `\012`, backslash `\134`
 *
 * and `\043` for a `#` that is a field's FIRST character. Both readers
 * (util-linux libmount, used by mount and systemd's generator, and glibc
 * getmntent) treat a `#` at column 0 or after whitespace as a comment and a
 * `#` inside a field as data; glibc does NOT decode `\043` (libmount does).
 * So only a leading `#` is escaped, and one inside a field is written raw,
 * which both readers then read the same way (cr.2 review, 2026-10-14). The parser escapes the SPEC and MOUNTPOINT
 * on write and unescapes on read; those two are the fields an operator or a
 * share name can legitimately put spaces in (CIFS `//nas/My Share` is real).
 *
 * The OPTIONS column is a comma-separated list of option TOKENS, not a free
 * field, so it is validated rather than escaped: talk to `mount`, systemd's
 * generator or the kernel as a list, and refuse any token that would need an
 * escape (one token = a name of letters / digits / `_ . -`, optionally `=`
 * and a value free of whitespace, `,`, `#`, `"`, `\` and control characters).
 * A token list that passes needs no escaping and can never break its line —
 * this is what closes the raw-`extraOptions` fstab-line injection.
 *
 * These validators gate ANAS's WRITE side. Reading the system's own file is
 * deliberately lenient (never refuse to read fstab): a hand-written token a
 * human put there parses and round-trips even when it would not satisfy
 * {@link FstabOptionList}.
 */

/** Octal escapes for the fstab field-breaking characters (getmntent(3) order). */
const FSTAB_FIELD_ESCAPES: Record<string, string> = {
  '\\': '\\134', // backslash first — its escape must never be re-escaped
  ' ': '\\040',
  '\t': '\\011',
  '\n': '\\012',
}

const FSTAB_FIELD_ESCAPE_RE = /[\\ \t\n]/g

/** A `\` followed by exactly three octal digits — the escape getmntent(3) decodes. */
const FSTAB_OCTAL_ESCAPE_RE = /\\([0-7]{3})/g

/**
 * Escape one fstab field (fs_spec or fs_file) for writing.
 *
 * A single pass over the string: every `\`, space, tab and newline becomes
 * its three-digit octal escape, and a LEADING `#` becomes `\043`. Ordering is safe because String
 * .prototype.replace never rescans a replacement — the `\` of an emitted
 * `\134` is not re-escaped. A field carrying none of the five characters
 * comes back byte-identical.
 */
export function escapeFstabField(s: string): string {
  const escaped = s.replace(FSTAB_FIELD_ESCAPE_RE, c => FSTAB_FIELD_ESCAPES[c] ?? c)
  return escaped.startsWith('#') ? `\\043${escaped.slice(1)}` : escaped
}

/**
 * Decode one fstab field as getmntent(3) reads it: any `\NNN` with three
 * octal digits becomes that character; every other backslash is literal and
 * left alone (a bare `\`, a two-digit `\40`, a non-octal `\8…`).
 */
export function unescapeFstabField(s: string): string {
  // The regex is `g`-flagged and shared; String.replace resets its lastIndex
  // to 0 on every call, so reuse across calls is stateless in practice.
  return s.replace(FSTAB_OCTAL_ESCAPE_RE, (_m, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))
}

/** A single fstab option token name: letters, digits, `_ . -` (the word set). */
const FSTAB_OPTION_NAME_RE = /^[\w.-]+$/

/** Is `c` a character an option VALUE must never carry? */
function invalidFstabOptionValueChar(c: string): boolean {
  const code = c.charCodeAt(0)
  return code <= 0x20 || code === 0x7F || c === ',' || c === '#' || c === '"' || c === '\\'
}

/**
 * Is `t` one fstab option token — a name of letters, digits, `_ . -`, optionally
 * `=` and a value containing no whitespace, `,`, `#`, `"`, `\` or control
 * characters? A value may contain everything else (`/ : . – = ?` …), so
 * `nofail`, `vers=4.2`, `x-systemd.requires=/opt` and `_netdev` all pass and
 * can be written into an option list verbatim with no escaping needed.
 *
 * Empty string is not a token, and neither is a name or a `key=` value that is
 * empty: a token names an option and (when present) carries a real value.
 */
export function isFstabOptionToken(t: string): boolean {
  if (t === '' || t.length > 1024)
    return false
  const eq = t.indexOf('=')
  if (eq === -1)
    return FSTAB_OPTION_NAME_RE.test(t)
  const name = t.slice(0, eq)
  const value = t.slice(eq + 1)
  if (!FSTAB_OPTION_NAME_RE.test(name) || value.length === 0)
    return false
  for (let i = 0; i < value.length; i++) {
    if (invalidFstabOptionValueChar(value[i]))
      return false
  }
  return true
}

/**
 * cr.6 — the disable-without-delete signaling (EPICS §2 "Mounts", rulings
 * 2026-10-14). ANAS disables a line by appending tokens to its OPTIONS column,
 * never a marker comment (Principle 12): a line WITHOUT `noauto` gains
 * `noauto,x-anas.disabled`, a line that already carries the operator's `noauto`
 * gains only `x-anas.disabled=kept-noauto`. Re-enable removes exactly the
 * token(s) disable added, so the line comes back byte-identical.
 *
 * `x-` is fstab's documented application-option namespace — systemd and mount
 * ignore the token; the `noauto` keeps the mount from coming up at boot, and a
 * hand edit that removes the token leaves `noauto` behind. The token is thus
 * NEVER an operator-set option: the request schemas refuse it as an extra
 * option and the parser consumes it (never passthrough). Both spellings are
 * valid {@link FstabOptionToken}s, so the OPTIONS column stays token-clean.
 */
export const X_ANAS_DISABLED_TOKEN = 'x-anas.disabled'
export const X_ANAS_DISABLED_KEPT_TOKEN = 'x-anas.disabled=kept-noauto'

/**
 * systemd-fstab-generator's automount option. Matched EXACTLY (the generator
 * tests the option by its exact name), so a differently-cased token is inert
 * and is not treated as an automount.
 */
export const X_SYSTEMD_AUTOMOUNT_TOKEN = 'x-systemd.automount'

/**
 * cr.19 — the PARKED automount (EPICS §2 Mounts, automount ruling 2026-10-14,
 * node pass R1-D1). `noauto` stops the generator starting a line's `.mount` at
 * boot but NOT wiring its `.automount` into `remote-fs.target.wants`, so a
 * disabled `x-systemd.automount` line would still arm at every boot. Disable
 * therefore also swaps `x-systemd.automount` IN PLACE for this token (same
 * position in the option list), and Enable swaps it back, so the line still
 * comes back byte-identical. Like the disable tokens it lives in the `x-`
 * application namespace (systemd and mount ignore it), it is consumed by the
 * reader as the operator's `automount=true` on a disabled line (never
 * passthrough), and the request schemas refuse it as an extra option.
 */
export const X_ANAS_DISABLED_AUTOMOUNT_TOKEN = 'x-anas.disabled-automount'

/**
 * The mount.cifs(8) option keys that carry a credential (story cr.60, review
 * M7) — the ONE list three users share: the daemon's fstab reader (lifts them
 * out of the passthrough a response carries), `redactFstabLine` (masks the
 * secret values in the raw line a response carries) and cr.2's
 * `MountExtraOptions` refusal (never written into a line). The names are
 * mount.cifs(8)'s on Debian 13 (cifs-utils 7.4): `password`/`pass` and
 * `password2` (the second password a server-side rotation uses) carry a
 * SECRET; `username`/`user` and `domain`/`dom`/`workgroup` are the account
 * METADATA (shown, never secret); `credentials` names the file holding them.
 * Keys compare case-insensitively ({@link cifsCredentialKeyKind}): the reader
 * hides `PASSWORD=` exactly as it hides `password=`.
 */
export const CIFS_CREDENTIAL_OPTION_KEYS = {
  secret: ['password', 'pass', 'password2'],
  username: ['username', 'user'],
  domain: ['domain', 'dom', 'workgroup'],
  file: ['credentials'],
} as const

/** Which credential an option key carries ({@link CIFS_CREDENTIAL_OPTION_KEYS}). */
export type CifsCredentialKeyKind = keyof typeof CIFS_CREDENTIAL_OPTION_KEYS

/**
 * The credential kind of an option KEY (the part before `=`), compared
 * case-insensitively against {@link CIFS_CREDENTIAL_OPTION_KEYS}; null for
 * any other key.
 */
export function cifsCredentialKeyKind(key: string): CifsCredentialKeyKind | null {
  const k = key.toLowerCase()
  for (const kind of Object.keys(CIFS_CREDENTIAL_OPTION_KEYS) as CifsCredentialKeyKind[]) {
    if ((CIFS_CREDENTIAL_OPTION_KEYS[kind] as readonly string[]).includes(k))
      return kind
  }
  return null
}

/** One fstab option token (see {@link isFstabOptionToken}). */
export const FstabOptionToken = z
  .string()
  .refine(isFstabOptionToken, 'a mount option is one token: a name of letters, digits, `_ . -`, optionally `=` and a value with no whitespace, comma, `#`, `"` or `\\`')

/**
 * Split a comma-joined fstab option list into its tokens. `''` is the empty
 * list. A hand-written list always splits; validation is the caller's.
 */
export function fstabOptionTokens(s: string): string[] {
  return s === '' ? [] : s.split(',')
}

/**
 * A comma-separated fstab option list: `FstabOptionToken`s with no empty
 * tokens (`''` itself is allowed — it is the empty list, the state of "no
 * extra options"). A token that needs an fstab escape (whitespace, `,`, `#`,
 * `"`, `\`, a control character) is refused rather than written.
 */
export const FstabOptionList = z
  .string()
  .max(8192)
  .refine(
    s => s === '' || fstabOptionTokens(s).every(t => FstabOptionToken.safeParse(t).success),
    'additional options must be a comma-separated list of option tokens, with no empty or whitespace-bearing token (see the token rule)',
  )
