import type { CifsCredentialKeyKind, MountCifsOptions, MountCommonOptions, MountEntry, MountInlineCredentials, MountNfsOptions, MountOptions } from '@anas/shared'
import { cifsCredentialKeyKind, escapeFstabField, escapeFstabOptionValue, MountCifsCache, MountCifsSec, MountLookupCache, MountNfsProto, MountNfsSec, sameConfigPath, unescapeFstabField, X_ANAS_DISABLED_AUTOMOUNT_TOKEN, X_ANAS_DISABLED_KEPT_TOKEN, X_ANAS_DISABLED_TOKEN, X_SYSTEMD_AUTOMOUNT_TOKEN } from '@anas/shared'

/** Recognized enum-value sets, mirrored from the shared schema (never drift). */
const CIFS_CACHE_VALUES = new Set<string>(MountCifsCache.options)
const CIFS_SEC_VALUES = new Set<string>(MountCifsSec.options)
const NFS_PROTO_VALUES = new Set<string>(MountNfsProto.options)
const NFS_SEC_VALUES = new Set<string>(MountNfsSec.options)
const NFS_LOOKUPCACHE_VALUES = new Set<string>(MountLookupCache.options)
/** A plain charset token (mirrors MountCharset) — else the option round-trips raw. */
const CHARSET_RE = /^[\w.-]+$/

/**
 * The option-token spellings mount.cifs honours for each credential (cr3.mounts
 * review 3, from cifs-utils 7.4 `parse_opt_token`: EXACT, case-sensitive).
 */
const HONOURED_CREDENTIAL_KEYS: Record<CifsCredentialKeyKind, ReadonlySet<string>> = {
  username: new Set(['user', 'username']),
  secret: new Set(['pass', 'password', 'pass2', 'password2']),
  domain: new Set(['dom', 'domain', 'workgroup']),
  file: new Set(['cred', 'credentials']),
}

/**
 * An fstab octal escape that libmount turns into an option SEPARATOR before
 * mount.cifs sees the option (cr3.mounts review 4, D4): `\054` is `,` and
 * `\075` is `=`. A token carrying one does not say what its raw text says
 * (`user=bob\054password=S` is a username AND a password to mount.cifs).
 */
const ESCAPED_SEPARATOR_RE = /\\0(?:54|75)/

/**
 * Round-trip parser and surgical editor for /etc/fstab (see fstab(5)).
 *
 * /etc/fstab is line-based. Each non-comment, non-blank line is six
 * whitespace-separated fields:
 *
 *   <fs_spec> <fs_file> <fs_vfstype> <fs_mntopts> <fs_freq> <fs_passno>
 *
 * where fs_spec is a device / `UUID=` / `//host/share` / `host:/export`,
 * fs_file is the mountpoint (our IDENTITY), fs_vfstype is the fstype, and
 * fs_mntopts is a comma-separated option list. fs_freq/fs_passno default to 0.
 * A `#` begins a comment (whole-line when leading, inline otherwise).
 *
 * Fields are related to the real world through the per-format layer in
 * `shared/` (review C2, ruling (i)): the spec and mountpoint are escaped on
 * WRITE — space `\040`, tab `\011`, newline `\012`, backslash `\134`, and a
 * field-leading `#` as `\043` — and unescaped on READ as libmount does. The parser sees
 * the real paths; a `#`- or space-bearing mountpoint stays ONE field and can
 * neither shift the six-field shape nor drop the forced `nofail`. A line a
 * human wrote with an escape (a spaced CIFS share name `//nas/My\040Share`)
 * therefore parses to the real `//nas/My Share`, and a re-serialized entry
 * re-escapes the same way.
 *
 * ANAS is a guest on the system (Principle 12): it makes surgical, line-level
 * edits and preserves everything it does not touch — comments (whole-line AND
 * inline), ordering, whitespace, blank lines, commented-out entries, bind/tmpfs
 * lines, and unknown/exotic options — BYTE-FOR-BYTE. The document model keeps
 * every line's original text verbatim in `raw` and only interprets entry lines;
 * `serializeFstabDoc(parseFstabDoc(t))` reproduces `t` exactly. Surgical edits
 * (add/replace/remove) rewrite ONLY the one line for a given mountpoint.
 *
 * Options are split into a STRUCTURED KNOWN TIER (common / NFS / CIFS) plus a
 * verbatim `passthrough` string carrying everything unrecognized — so a
 * hand-edited entry's exotica survive an edit to an unrelated field.
 */

/**
 * The field separator libmount reads (cr3.mounts M3): ASCII SPACE and TAB,
 * nothing else. JavaScript's `\s` also matches every Unicode space (NBSP,
 * U+2003, U+3000, ...) and VT/FF/CR, all of which libmount reads as DATA inside
 * a field; splitting on them made a line ANAS wrote for a mountpoint or CIFS
 * share carrying one unreadable to ANAS while mount and systemd read it fine.
 * Proven with util-linux's own reader on a scratch file:
 * `fixtures/mounts/fstab-libmount-split` and its
 * `findmnt --fstab -F <file> --json` answer beside it. The writer escapes
 * exactly these two (plus newline and backslash), so reader and writer agree.
 */
const FIELD_SPLIT = /[ \t]+/
/** Leading/trailing field separators (the {@link FIELD_SPLIT} set). */
const EDGE_BLANKS_RE = /^[ \t]+|[ \t]+$/g
/** A CRLF file's line ending: libmount drops a trailing CR, nothing else. */
const TRAILING_CR_RE = /\r+$/

/** Trim the libmount field separators (space, tab) off both ends; every other byte is data. */
function trimBlanks(s: string): string {
  return s.replace(EDGE_BLANKS_RE, '')
}

/**
 * The four mandatory fstab fields with their ORIGINAL separators, plus whatever
 * follows (dump/pass, and any spacing a human chose). Separators are the
 * {@link FIELD_SPLIT} set (space, tab) — cr3.mounts M3.
 *
 * The tail is `(?:[ \t][\s\S]*)?` rather than `[\s\S]*` on purpose: a field
 * followed by "anything" can split the same text in many ways, and the
 * regex engine will try them all on a long malformed line. Requiring the tail to
 * start with a separator makes the split unambiguous, because a field can
 * never absorb one. The caller strips a CRLF line's trailing CR first.
 */
const FSTAB_FOUR_FIELDS = /^([ \t]*)([^ \t]+)([ \t]+)([^ \t]+)([ \t]+)([^ \t]+)([ \t]+)([^ \t]+)((?:[ \t][\s\S]*)?)$/

/** Single field separator — the token boundary before an inline `#` comment (libmount's, cr3.mounts M3). */
const WS_CHAR = /[ \t]/

/**
 * The index of a `#` that BEGINS an inline trailing comment — a `#` at column 0
 * OR one immediately preceded by whitespace (i.e. it starts its own token). A
 * `#` embedded WITHIN a field (e.g. a `password=Xy#zzy` option value) is NOT a
 * comment: fstab fields are whitespace-separated, so libmount only treats a
 * whitespace-preceded `#` as the start of a comment (ground-truth verified —
 * `mount` receives the full option value when the `#` is mid-field). Returns -1
 * when the line carries no trailing comment.
 */
export function inlineCommentIndex(raw: string): number {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '#' && (i === 0 || WS_CHAR.test(raw[i - 1])))
      return i
  }
  return -1
}

/**
 * LEGACY disable-without-delete marker: a disabled ANAS entry used to be its
 * original line VERBATIM, prefixed with `#ANAS `. Since the 2026-10-14 ruling
 * (§2 Mounts) disabling is the OPTION form — `noauto,x-anas.disabled`, or
 * `x-anas.disabled=kept-noauto` when the operator's own `noauto` was already on
 * the line — and the marker is only a marker comment (Principle 12), so it is
 * still READ as disabled but never WRITTEN again: an `#ANAS ` line is converted
 * to the option form when ANAS next changes that line (enable, edit, disable
 * again). No bulk migration.
 */
export const ANAS_MARKER = '#ANAS '

/** One line of an /etc/fstab document, tagged by whether it is a mount entry. */
export type FstabDocLine
  = | { kind: 'entry', raw: string, entry: MountEntry, trailingComment: string, disabled: boolean }
    | { kind: 'other', raw: string }

/**
 * Split the file into lines, preserving newline structure exactly.
 * `text.split('\n')` is losslessly reversible with `join('\n')`.
 */
export function parseFstabDoc(text: string): FstabDocLine[] {
  return text.split('\n').map((raw): FstabDocLine => {
    const parsed = parseEntryLine(raw)
    return parsed
      ? { kind: 'entry', raw, entry: parsed.entry, trailingComment: parsed.trailingComment, disabled: parsed.disabled }
      : { kind: 'other', raw }
  })
}

/** Reassemble a document into text, byte-for-byte for untouched lines. */
export function serializeFstabDoc(doc: FstabDocLine[]): string {
  return doc.map(line => line.raw).join('\n')
}

/** Every mount entry in the file (file order), for the API list/detail views. */
export function parseFstab(text: string): MountEntry[] {
  const entries: MountEntry[] = []
  for (const line of parseFstabDoc(text)) {
    if (line.kind === 'entry')
      entries.push(line.entry)
  }
  return entries
}

/** One entry line of the document. */
export type FstabEntryLine = Extract<FstabDocLine, { kind: 'entry' }>

/**
 * The line for `mountpoint`: the FIRST entry line whose mountpoint names the
 * same path (`sameConfigPath`), a disabled or legacy `#ANAS ` line included,
 * or undefined when the file has none. Its `raw` is the line's exact text.
 */
export function mountLine(text: string, mountpoint: string): FstabEntryLine | undefined {
  return parseFstabDoc(text).find((l): l is FstabEntryLine => l.kind === 'entry' && sameConfigPath(l.entry.mountpoint, mountpoint))
}

/** The entry for `mountpoint`, or undefined if the file has none. */
export function getMount(text: string, mountpoint: string): MountEntry | undefined {
  return mountLine(text, mountpoint)?.entry
}

/** Is `mountpoint` present in the file as an entry line? */
export function hasMount(text: string, mountpoint: string): boolean {
  return mountLine(text, mountpoint) !== undefined
}

/**
 * The line numbers (1-based, the number `grep -n` prints) of every entry line
 * for `mountpoint` — a DISABLED line counts too, because the enable/disable/
 * remove verbs act on it like any entry. cr4.conf D-21: the verbs that change
 * or remove a line refuse when this returns more than one number, and the
 * reads show these same numbers, so the count comes from the file's own
 * parser and never from a second scan of the text. A trailing-slash spelling
 * names the same mountpoint (`sameConfigPath`), so `/mnt/x` and `/mnt/x/` are
 * two lines for one mount.
 */
export function linesFor(text: string, mountpoint: string): number[] {
  const out: number[] = []
  let line = 0
  for (const entry of parseFstabDoc(text)) {
    line++
    if (entry.kind === 'entry' && sameConfigPath(entry.entry.mountpoint, mountpoint))
      out.push(line)
  }
  return out
}

/**
 * Append a new entry as a single line, preserving the rest of the file
 * byte-for-byte. Inserts before the trailing-newline sentinel so the file stays
 * newline-terminated.
 */
export function addMount(text: string, entry: MountEntry): string {
  const doc = parseFstabDoc(text)
  const line: FstabDocLine = { kind: 'entry', raw: serializeMountLine(entry), entry, trailingComment: '', disabled: false }
  const last = doc.at(-1)
  if (last && last.kind === 'other' && last.raw === '')
    doc.splice(doc.length - 1, 0, line) // keep the trailing newline last
  else
    doc.push(line)
  return serializeFstabDoc(doc)
}

/**
 * Replace ONLY the line for `mountpoint` with a freshly serialized line. Every
 * other line is emitted unchanged. The line's inline trailing comment (if any)
 * is preserved, and a DISABLED line stays disabled — re-written in the option
 * form (which is also how an `#ANAS ` line is converted to it: this is one of
 * the three places ANAS writes that line). No-op if `mountpoint` is absent.
 */
export function replaceMount(text: string, mountpoint: string, entry: MountEntry): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind === 'entry' && sameConfigPath(line.entry.mountpoint, mountpoint)) {
      const comment = line.trailingComment ? `   ${line.trailingComment}` : ''
      line.raw = line.disabled
        ? disabledSerialization(entry, comment)
        : serializeMountLine(entry) + comment
      line.entry = entry
      break
    }
  }
  return serializeFstabDoc(doc)
}

/**
 * The OPTIONS column of one raw entry line, carved out byte-surgically: the
 * bytes after any (legacy) `#ANAS ` marker, the fields before any inline `#`
 * comment, and the markers/separators that keep the rest of the line
 * byte-identical. Returns null when the line does not parse as a six-field
 * fstab entry. Every surgical OPTIONS writer below goes through this ONE
 * extraction, so the spec, the mountpoint, the column alignment a human chose,
 * the dump/pass columns and the inline comment can never be disturbed.
 */
function entryOptionsOps(line: { disabled: boolean, raw: string }):
  { marker: string, comment: string, head: string, opts: string, tail: string } | null {
  // Work on the bytes AFTER the (legacy) disabled marker and BEFORE any inline
  // comment, so neither is disturbed and neither can be mistaken for a field.
  const marker = line.disabled && line.raw.startsWith(ANAS_MARKER) ? ANAS_MARKER : ''
  const body = line.raw.slice(marker.length)
  const hashIdx = inlineCommentIndex(body)
  const rawFields = hashIdx === -1 ? body : body.slice(0, hashIdx)
  const comment = hashIdx === -1 ? '' : body.slice(hashIdx)
  // A CRLF line's CR is the line ending, not part of the last field (libmount
  // drops it): carved off here and put back after the tail, byte-identical.
  const cr = TRAILING_CR_RE.exec(rawFields)?.[0] ?? ''
  const fieldsPart = rawFields.slice(0, rawFields.length - cr.length)

  // Leading whitespace, then four fields with their ORIGINAL separators. The
  // fourth is the options column; everything after it is left untouched.
  const m = fieldsPart.match(FSTAB_FOUR_FIELDS)
  if (!m)
    return null
  const [, lead, spec, s1, mp, s2, fstype, s3, opts, tail] = m
  return {
    marker,
    comment,
    head: `${lead}${spec}${s1}${mp}${s2}${fstype}${s3}`,
    opts,
    tail: `${tail}${cr}`,
  }
}

/** Rewrite the OPTIONS column of one entry line, in place; every other byte stays. */
function rewriteEntryOptions(
  line: { disabled: boolean, raw: string },
  rewrite: (opts: string) => string,
): void {
  const ops = entryOptionsOps(line)
  if (!ops)
    return
  const rewritten = rewrite(ops.opts)
  if (rewritten === ops.opts)
    return // no change — leave the byte-identical line alone
  line.raw = `${ops.marker}${ops.head}${rewritten}${ops.tail}${ops.comment}`
}

/** Reparse a mutated entry line's raw bytes back into its structured entry. */
function refreshEntry(line: FstabDocLine & { kind: 'entry' }): void {
  const reparsed = parseFstabDoc(line.raw)[0]
  if (reparsed?.kind === 'entry')
    line.entry = reparsed.entry
}

/**
 * Add ONE option token to the line for `mountpoint`, in place, byte-surgically.
 *
 * Not `replaceMount`: that re-serializes the whole line from the parsed entry,
 * which canonicalises spacing and drops the long tail of anything the structured
 * tiers do not model. This one rewrites the OPTIONS FIELD of the raw line and
 * nothing else — the spec, the mountpoint, the column alignment a human chose,
 * the dump/pass columns, the inline comment and the `#ANAS ` marker all come out
 * byte-identical (Principle 12: ANAS is a guest in this file).
 *
 * A no-op — byte-identical output — when the token is already there or the
 * mountpoint has no line. That is what makes it safe to call on every LUN
 * placement rather than only the first (story `iscsi.8`).
 *
 * Comparison is on the whole token, so `x-systemd.before=a.service` and
 * `x-systemd.before=b.service` are different options and both may stand; fstab
 * allows repeated `x-systemd.before=` and systemd honours each.
 */
export function addMountOption(text: string, mountpoint: string, token: string): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind !== 'entry' || !sameConfigPath(line.entry.mountpoint, mountpoint))
      continue
    const ops = entryOptionsOps(line)
    if (!ops)
      return text
    if (ops.opts.split(',').map(trimBlanks).includes(token))
      return text
    rewriteEntryOptions(line, opts => (opts ? `${opts},${token}` : token))
    refreshEntry(line)
    break
  }
  return serializeFstabDoc(doc)
}

/**
 * Does the line for `mountpoint` carry an automount — a LIVE
 * `x-systemd.automount` (or its legacy `comment=systemd.automount` spelling,
 * cr.70) or a PARKED `x-anas.disabled-automount[=comment]` (cr.19)? Read
 * from the raw option tokens, not the structured entry, so a parked token on a
 * line whose disable token a hand edit removed still counts: the routes use
 * this to decide whether the line's `.automount` unit may be armed and must be
 * stopped before the daemon-reload (node pass R1-D2/D3).
 */
export function carriesAutomount(text: string, mountpoint: string): boolean {
  for (const line of parseFstabDoc(text)) {
    if (line.kind !== 'entry' || !sameConfigPath(line.entry.mountpoint, mountpoint))
      continue
    const ops = entryOptionsOps(line)
    return ops !== null && ops.opts.split(',').some(t => isLiveAutomountToken(t) || isParkedAutomountToken(t))
  }
  return false
}

/** What {@link cifsCredentialTokenScan} reports about one line. */
export interface CifsCredentialTokens {
  /** Index of the LAST honoured user token. */
  user?: number
  /** Index of the LAST honoured domain token. */
  domain?: number
  /** Index of the LAST honoured credentials-file token. */
  file?: number
  /** How many honoured credentials-file tokens the line carries (review 4, D5). */
  files: number
  /** The honoured secret keys present, as decoded (`password`, `pass2`, ...) — names, never values. */
  secretKeys: string[]
  /** Keys (as written) spelled in a way mount.cifs does not honour. */
  unhonoured: string[]
}

/**
 * Where the credential tokens of a CIFS line sit, and which are spelled in a
 * way mount.cifs does not honour (cr3.mounts review 3). mount.cifs takes the
 * LAST user and domain on the option line, a credentials file counting at the
 * position of its `credentials=` token — so a migration needs the order to
 * write the account the mount actually used. Positions are token indexes in
 * the OPTIONS column (keys decoded as libmount decodes them); `unhonoured`
 * lists the keys (as written, never a value) whose spelling mount.cifs does
 * not read as that option. Undefined when the line is absent or unparseable.
 */
export function cifsCredentialTokenScan(text: string, mountpoint: string): CifsCredentialTokens | undefined {
  for (const line of parseFstabDoc(text)) {
    if (line.kind !== 'entry' || !sameConfigPath(line.entry.mountpoint, mountpoint))
      continue
    const ops = entryOptionsOps(line)
    if (!ops)
      return undefined
    const out: CifsCredentialTokens = { unhonoured: [], files: 0, secretKeys: [] }
    ops.opts.split(',').map(trimBlanks).forEach((token, i) => {
      const eq = token.indexOf('=')
      if (eq === -1 || ESCAPED_SEPARATOR_RE.test(token))
        return
      const rawKey = token.slice(0, eq)
      const key = unescapeFstabField(rawKey)
      const kind = cifsCredentialKeyKind(key)
      if (kind === null)
        return
      if (!HONOURED_CREDENTIAL_KEYS[kind].has(key)) {
        out.unhonoured.push(`${rawKey}=`)
        return
      }
      if (kind === 'username') {
        out.user = i
      }
      else if (kind === 'domain') {
        out.domain = i
      }
      else if (kind === 'file') {
        out.file = i
        out.files++
      }
      else if (!out.secretKeys.includes(key)) {
        out.secretKeys.push(key)
      }
    })
    return out
  }
  return undefined
}

/**
 * Does the entry carry a secret ON its line — an inline password or alternate
 * password (lifted, migrated only by the Save), or a verbatim secret token?
 * cr3.mounts review 3 (4): the one test every door that re-serialises a line
 * asks; only the migrating Save may move such a secret, nothing else may lose it.
 */
export function carriesInlineSecret(entry: MountEntry): boolean {
  return entry.inlineCredentials?.password !== undefined
    || entry.inlineCredentials?.password2 !== undefined
    || (entry.secretOptions?.length ?? 0) > 0
}

/** Remove ONLY the line for `mountpoint` (active or disabled). No-op if absent. */
export function removeMount(text: string, mountpoint: string): string {
  const doc = parseFstabDoc(text)
  const idx = doc.findIndex(l => l.kind === 'entry' && sameConfigPath(l.entry.mountpoint, mountpoint))
  if (idx !== -1)
    doc.splice(idx, 1)
  return serializeFstabDoc(doc)
}

/**
 * The disable token(s) for an entry, per the 2026-10-14 ruling (§2 Mounts): a
 * line WITHOUT the operator's `noauto` gains `noauto,` + the token (the `noauto`
 * IS the disable — it keeps the mount from coming up at boot); a line that
 * already carries the operator's `noauto` gains only the kept-noauto token, so
 * the operator's own "enabled, not at boot" choice survives a round trip.
 */
function disabledTokens(entry: MountEntry): string[] {
  return entry.options.common.noauto ? [X_ANAS_DISABLED_KEPT_TOKEN] : ['noauto', X_ANAS_DISABLED_TOKEN]
}

/** The key of one option token (before any `=`), whitespace-trimmed. */
function optionKey(token: string): string {
  const t = trimBlanks(token)
  const eq = t.indexOf('=')
  return eq === -1 ? t : t.slice(0, eq)
}

/**
 * The LEGACY automount spelling (cr.70). systemd-fstab-generator still honours
 * `comment=systemd.automount` beside `x-systemd.automount` — the string is in
 * the PVE 9 generator binary (stunt-node check 2026-10-17) — so it arms the
 * line's `.automount` at boot exactly like the modern spelling: a hand-written
 * legacy line ANAS merely disabled would keep arming (the cr.19 D1 class).
 * Matched EXACTLY, as the generator matches it.
 */
const LEGACY_AUTOMOUNT_TOKEN = 'comment=systemd.automount'

/**
 * The parked form of a LEGACY live token: the bare parked token keeps meaning
 * `x-systemd.automount` (so every existing park round trip stays byte-
 * identical), so the legacy spelling parks with a value naming which spelling
 * it replaced. The reader matches the parked token by KEY (cr.19), so the
 * value rides through the read untouched.
 */
const PARKED_LEGACY_AUTOMOUNT_TOKEN = `${X_ANAS_DISABLED_AUTOMOUNT_TOKEN}=comment`

/** Is `token` a LIVE automount — `x-systemd.automount` or the legacy `comment=systemd.automount` (cr.70)? Exact, as the generator matches each. */
function isLiveAutomountToken(token: string): boolean {
  const t = trimBlanks(token)
  return t === X_SYSTEMD_AUTOMOUNT_TOKEN || t === LEGACY_AUTOMOUNT_TOKEN
}

/**
 * Is `token` the PARKED automount (cr.19)? By key and case-insensitively —
 * the same way the reader matches the `x-anas.disabled` tokens, so whatever
 * the reader honours as parked, enable un-parks.
 */
function isParkedAutomountToken(token: string): boolean {
  return optionKey(token).toLowerCase() === X_ANAS_DISABLED_AUTOMOUNT_TOKEN
}

/** Replace a token's trimmed text, keeping any surrounding whitespace byte-for-byte. */
function swapTokenText(token: string, to: string): string {
  const core = trimBlanks(token)
  const at = token.indexOf(core)
  return `${token.slice(0, at)}${to}${token.slice(at + core.length)}`
}

/**
 * Park every live automount in an OPTIONS column IN PLACE (cr.19, §2 Mounts
 * automount ruling; cr.70 adds the legacy spelling): the token keeps its
 * position, every other token keeps its exact bytes. The parked form records
 * which spelling it replaced — `x-systemd.automount` parks bare, the legacy
 * `comment=systemd.automount` parks as `x-anas.disabled-automount=comment` —
 * so Enable restores the spelling the operator wrote. Returns the column
 * unchanged when it carries no live automount.
 */
function parkAutomount(opts: string): string {
  return opts.split(',')
    .map(t => (isLiveAutomountToken(t)
      ? swapTokenText(t, trimBlanks(t) === LEGACY_AUTOMOUNT_TOKEN ? PARKED_LEGACY_AUTOMOUNT_TOKEN : X_ANAS_DISABLED_AUTOMOUNT_TOKEN)
      : t))
    .join(',')
}

/** Does a parked automount token carry the legacy spelling (the `=comment` value)? */
function parkedAutomountIsLegacy(token: string): boolean {
  const t = trimBlanks(token)
  const eq = t.indexOf('=')
  return eq !== -1 && t.slice(eq + 1).toLowerCase() === 'comment'
}

/**
 * The inverse of {@link parkAutomount}: every parked token back to the spelling
 * it replaced, in place — bare parked ⇒ `x-systemd.automount`, `=comment` ⇒
 * the legacy `comment=systemd.automount` (cr.70). A hand-written value on the
 * parked key other than `comment` restores the canonical spelling.
 */
function unparkAutomount(opts: string): string {
  return opts.split(',')
    .map(t => (isParkedAutomountToken(t)
      ? swapTokenText(t, parkedAutomountIsLegacy(t) ? LEGACY_AUTOMOUNT_TOKEN : X_SYSTEMD_AUTOMOUNT_TOKEN)
      : t))
    .join(',')
}

/** An OPTIONS column without any parked automount token (every other token byte-identical). */
function dropParkedAutomount(opts: string): string {
  const kept = opts.split(',').filter(t => !isParkedAutomountToken(t))
  return kept.join(',')
}

/**
 * The OPTIONS column of a line being disabled: any live automount parked in
 * place, then the disable token(s) appended. The one rule for both disable
 * writers (the byte-surgical one and the canonical serialization), so the
 * two can never disagree about what a disabled line carries.
 */
function disabledOptions(opts: string, tokens: string[]): string {
  const parked = parkAutomount(opts)
  const added = tokens.join(',')
  return parked ? `${parked},${added}` : added
}

/** Apply the disable rewrite to the OPTIONS column of a canonical serialized line. */
function injectDisableTokens(serialized: string, tokens: string[]): string {
  const m = serialized.match(FSTAB_FOUR_FIELDS)
  if (!m)
    return serialized // cannot happen for our own serialization — fail open
  const [, lead, spec, s1, mp, s2, fstype, s3, opts, tail] = m
  return `${lead}${spec}${s1}${mp}${s2}${fstype}${s3}${disabledOptions(opts, tokens)}${tail}`
}

/**
 * The DISABLED (option-form) rendering of an entry: its canonical ACTIVE line
 * with its `x-systemd.automount` (if any) parked in place, plus exactly the
 * disable token(s) the entry's own `noauto` calls for. `comment` is the inline
 * trailing comment to re-attach (after the options, where it always was).
 * This is the one writer for a disabled line — the convert-an-`#ANAS`-line and
 * keep-a-disabled-line-stays-disabled paths share it, so the two produce
 * identical bytes.
 */
function disabledSerialization(entry: MountEntry, comment: string): string {
  return injectDisableTokens(serializeMountLine(entry), disabledTokens(entry)) + comment
}

/**
 * Disable ONLY the line for `mountpoint` without deleting it. Since the
 * 2026-10-14 ruling the disable is OPTION-form, not a marker comment
 * (Principle 12): the options column gains `noauto,x-anas.disabled` (or only
 * `x-anas.disabled=kept-noauto` when the operator's own `noauto` is already on
 * the line), byte-surgically, so enabling later removes exactly these and the
 * line returns BYTE-IDENTICAL. An `x-systemd.automount` on the line is swapped
 * IN PLACE for `x-anas.disabled-automount`, and the legacy
 * `comment=systemd.automount` for `x-anas.disabled-automount=comment` (cr.19,
 * cr.70, §2 Mounts automount ruling):
 * `noauto` alone does not stop systemd-fstab-generator arming the line's
 * `.automount` at boot (node pass R1-D1). A line already disabled in the
 * option form is left alone — except that a live `x-systemd.automount` still
 * on it (a cr.6-era disable, or a hand edit) is parked, which repairs it; a
 * legacy `#ANAS ` line is CONVERTED to the option form (automount parked the
 * same way) — this is one of the three places ANAS writes that line, and the
 * ruling says such a line is rewritten to the new form when ANAS changes it.
 */
export function disableMount(text: string, mountpoint: string): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind !== 'entry' || !sameConfigPath(line.entry.mountpoint, mountpoint))
      continue
    if (!line.disabled) {
      const tokens = disabledTokens(line.entry)
      // A parked token on an ENABLED line is an orphan (a hand edit took the
      // disable token off): inert to systemd and read as automount=false, so
      // it is dropped here — kept, it would read as the operator's automount
      // once disabled and come back LIVE on enable.
      rewriteEntryOptions(line, opts => disabledOptions(dropParkedAutomount(opts), tokens))
      refreshEntry(line)
    }
    else if (line.raw.startsWith(ANAS_MARKER)) {
      // Legacy marker — convert to the option form (writes THAT line).
      // cr3.mounts review 3 (4): the conversion RE-SERIALISES the entry, and
      // the serializer never writes an inline password or alternate password
      // back (those leave a line only through the migrating Save). A line
      // carrying one is left byte-identical — it is already disabled — and
      // the route refuses the verb before it gets here.
      if (carriesInlineSecret(line.entry))
        break
      const comment = line.trailingComment ? `   ${line.trailingComment}` : ''
      line.raw = disabledSerialization(line.entry, comment)
      refreshEntry(line)
    }
    else {
      // Already in the option form: only a still-live automount is touched
      // (the repair); otherwise the line stays byte-identical.
      rewriteEntryOptions(line, parkAutomount)
      refreshEntry(line)
    }
    break
  }
  return serializeFstabDoc(doc)
}

/**
 * Enable ONLY the disabled line for `mountpoint`, removing exactly what disable
 * added so the line comes back BYTE-IDENTICAL. A legacy `#ANAS ` line is
 * un-marked as before (the marker comes off, the original active line returns).
 * An option-form line loses its disable token — and, when the token is the bare
 * `x-anas.disabled` (meaning disable also added the `noauto`), the `noauto`
 * too. The kept-noauto form removes only its own token, leaving the operator's
 * `noauto` alone. A parked `x-anas.disabled-automount` goes back IN PLACE to
 * `x-systemd.automount`, and a parked `x-anas.disabled-automount=comment` to
 * the legacy `comment=systemd.automount` it replaced (cr.19, cr.70).
 */
export function enableMount(text: string, mountpoint: string): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind !== 'entry' || !sameConfigPath(line.entry.mountpoint, mountpoint) || !line.disabled)
      continue
    if (line.raw.startsWith(ANAS_MARKER)) {
      line.raw = line.raw.slice(ANAS_MARKER.length)
    }
    else {
      const ops = entryOptionsOps(line)
      if (!ops)
        break
      // The reader takes the token case-insensitively and by KEY (any
      // `x-anas.disabled[=…]` reads disabled), so enable must clear exactly
      // what the reader honours, or a hand-typed `X-ANAS.DISABLED` would read
      // disabled forever (cr.6 review). bare form ⇒ disable added `noauto` too;
      // kept-noauto ⇒ the operator's own `noauto` stays.
      const tokens = ops.opts.split(',').filter(o => o !== '')
      const isDisableToken = (t: string): boolean =>
        trimBlanks(t).split('=')[0].toLowerCase() === X_ANAS_DISABLED_TOKEN
      // Same rule as classifyOptions: any disable token that is not the
      // kept-noauto form is the bare form.
      const hasBare = tokens.some(t => isDisableToken(t) && trimBlanks(t).toLowerCase() !== X_ANAS_DISABLED_KEPT_TOKEN)
      // Removal matches the TRIMMED token so a hand-typed token still goes,
      // and every SURVIVING token keeps its exact bytes: a line ANAS disabled
      // itself comes back byte-identical. A blank INSIDE the options field is
      // a limit of that promise. libmount ends the options field at the first
      // blank, so a hand-written `defaults, nofail` parses as options
      // `defaults` with `nofail` shifted into the next field (and a hand
      // disable token written past the blank is never read as a disable
      // token at all); a rewrite that then touches the line drops the empty
      // token the cut leaves behind — measured on the parser,
      // `defaults, nofail 0 0` comes back `defaults nofail 0 0`.
      rewriteEntryOptions(line, (opts) => {
        const out: string[] = []
        for (const t of opts.split(',').filter(o => o !== '')) {
          if (!isDisableToken(t) && !(hasBare && trimBlanks(t) === 'noauto'))
            out.push(t)
        }
        return unparkAutomount(out.join(','))
      })
    }
    line.disabled = false
    refreshEntry(line)
    break
  }
  return serializeFstabDoc(doc)
}

/**
 * Serialize one entry to a canonical single /etc/fstab line (no inline
 * comment). The spec and mountpoint are octal-escaped as libmount and
 * getmntent(3) read them (shared per-format layer, review C2): space `\040`,
 * tab `\011`, newline `\012`, backslash `\134`, and `\043` for a `#` that
 * would start the field (a `#` inside a field is data to both readers). Escaping keeps a field carrying one of those characters a
 * single whitespace-delimited field, so a mountpoint like
 * `/usr nfs4 rw 0 0 #` cannot shift the six-field shape (or drop the forced
 * `nofail`) the way writing it raw would.
 */
export function serializeMountLine(entry: MountEntry): string {
  const opts = buildOptionTokens(entry).join(',')
  return `${escapeFstabField(entry.spec)} ${escapeFstabField(entry.mountpoint)} ${entry.fstype} ${opts} ${entry.dump} ${entry.pass}`
}

/**
 * The option string to mount an entry DIRECTLY with `mount(8)` (cr.52r D3):
 * exactly the token list the fstab serializer would write, so a mount the
 * daemon runs through an opened directory (`/proc/self/fd/3`) carries the same
 * spec and options the entry's fstab line configures — the single source of
 * the option columns both writers share.
 */
export function mountOptionTokens(entry: MountEntry): string {
  return buildOptionTokens(entry).join(',')
}

/**
 * The option string for a DIRECT `mount(8)` of an entry (cr.52s-e): the
 * kernel/helper tokens of {@link mountOptionTokens} with the userspace-only
 * ones dropped — every `x-*` token (`x-systemd.*`, `x-anas.*`, `x-initrd.*`),
 * `_netdev`, `nofail`, `noauto`, `auto`, `comment=*`. mount(8) ignores them,
 * but with `-c` libmount records them in `/run/mount/utab` under the fd
 * target (cr.52s-d's node fact), one stale entry per mount. The fstab LINE
 * keeps every token — only the direct mount's argv is stripped. Surviving
 * tokens keep their exact bytes and order. Empty when nothing survives: the
 * caller then passes NO `-o` at all (`mount -o ''` is not the same as none).
 */
export function directMountOptionTokens(entry: MountEntry): string {
  // cr3.mounts follow-up (2): a hand-written secret token (`password2=`, a
  // password on a line not read as CIFS) stays on the LINE but never reaches
  // a direct mount's argv, where every process on the node can read it. The
  // routes refuse to mount such a line at all; this is the belt to that.
  const secrets = new Set(entry.secretOptions ?? [])
  return buildOptionTokens(entry)
    .filter(t => !isUserspaceOnlyOption(t) && !secrets.has(t))
    .join(',')
}

/**
 * The `-o` argv fragment for a direct mount: `['-o', tokens]`, or NOTHING
 * when every token is userspace-only (cr.52s-e) — so the three direct-mount
 * argv builders share the empty-means-no-`-o` rule instead of each
 * re-deciding it.
 */
export function directMountOptionArgs(entry: MountEntry): string[] {
  const opts = directMountOptionTokens(entry)
  return opts === '' ? [] : ['-o', opts]
}

// --- Internals --------------------------------------------------------------

/**
 * Whole-token test for the userspace-only options cr.52s-e drops from a
 * direct mount. Matched on the TRIMMED, lower-cased key (the same shape as
 * the disable-token test in the ops above) so a hand-spaced passthrough
 * token still goes; every SURVIVING token keeps its exact bytes.
 */
function isUserspaceOnlyOption(token: string): boolean {
  const key = trimBlanks(token).split('=')[0].toLowerCase()
  return key.startsWith('x-')
    || key === '_netdev'
    || key === 'nofail'
    || key === 'noauto'
    || key === 'auto'
    || key === 'comment'
}

/**
 * Parse one raw line into a structured entry, or null for comments, blanks, and
 * lines that are not recognizable as a manageable mount entry (preserved
 * verbatim as `other`).
 *
 * A line is a DISABLED mount (disabled=true) when it EITHER carries the legacy
 * `#ANAS ` marker whose REMAINDER parses as a valid entry, OR (since cr.6) its
 * options carry an `x-anas.disabled` token. In the marker case a remainder that
 * does not parse makes the line an ordinary comment (fail-open — never mangle a
 * human's prose comment that happens to start with `#ANAS `); in the option
 * case the disable token is what says so, no matter what else the line carries.
 */
function parseEntryLine(raw: string): { entry: MountEntry, trailingComment: string, disabled: boolean } | null {
  if (raw.startsWith(ANAS_MARKER)) {
    const parsed = parseActiveEntry(raw.slice(ANAS_MARKER.length))
    if (!parsed)
      return null // not an entry under the marker → an ordinary comment
    parsed.entry.disabled = true
    // A parked automount is the operator's automount on ANY disabled line
    // (cr.19); the option-form case is settled in classifyOptions.
    if (parsed.parkedAutomount)
      parsed.entry.options.common.automount = true
    return { entry: parsed.entry, trailingComment: parsed.trailingComment, disabled: true }
  }

  const trimmed = trimBlanks(raw.replace(TRAILING_CR_RE, ''))
  if (trimmed === '' || trimmed.startsWith('#'))
    return null // blank line or whole-line (incl. commented-out) entry

  const parsed = parseActiveEntry(raw)
  if (!parsed)
    return null
  // The option-form disable is carried by the entry itself — the parser sets
  // `disabled` when the options carry an `x-anas.disabled` token; the `#ANAS `
  // form was set in the branch above. No other line is ever disabled.
  return { entry: parsed.entry, trailingComment: parsed.trailingComment, disabled: parsed.entry.disabled === true }
}

/** Parse an ACTIVE (uncommented) fstab data line into an entry, or null. */
function parseActiveEntry(raw: string): { entry: MountEntry, trailingComment: string, parkedAutomount: boolean } | null {
  const trimmed = trimBlanks(raw.replace(TRAILING_CR_RE, ''))
  if (trimmed === '' || trimmed.startsWith('#'))
    return null

  // Split off an inline trailing comment — a `#` that STARTS a token (column 0 or
  // whitespace-preceded), never a `#` embedded inside a field (a `#` in an option
  // value such as a password is data, not a comment: BUG-2 was truncating there).
  const hashIdx = inlineCommentIndex(raw)
  const fieldsPart = hashIdx === -1 ? raw : raw.slice(0, hashIdx)
  const trailingComment = hashIdx === -1 ? '' : raw.slice(hashIdx)

  // cr3.mounts M3: libmount's separators only (space, tab), a CRLF line's CR
  // dropped as libmount drops it — every other byte is data in its field.
  const fields = trimBlanks(fieldsPart.replace(TRAILING_CR_RE, '')).split(FIELD_SPLIT)
  // Need at least spec, mountpoint, fstype, options; dump/pass default to 0.
  if (fields.length < 4)
    return null

  const [rawSpec, rawMountpoint, fstype, optStr, dumpStr, passStr] = fields
  // Spec and mountpoint are unescaped EXACTLY as getmntent(3) reads them
  // (`\040` → a real space, `\043` → `#`, …; shared per-format layer, review
  // C2) — the parser sees the real paths, so identity, guards and mounts all
  // run on what the line actually names. An untouched line still round-trips
  // byte-identically: the document keeps the raw text; only THIS interpreted
  // view unescapes, and serialization re-escapes.
  const spec = unescapeFstabField(rawSpec)
  const mountpoint = unescapeFstabField(rawMountpoint)
  // The mountpoint is our identity and must be an absolute path.
  if (!mountpoint.startsWith('/'))
    return null

  const tokens = optStr.split(',').map(trimBlanks).filter(Boolean)
  const { options, credentialsFile, credentialsKey, inlineCredentials, disable, parkedAutomount, secretOptions, escapedSeparatorTokens } = classifyOptions(fstype, tokens)

  const entry: MountEntry = {
    spec,
    mountpoint,
    fstype,
    options,
    dump: toInt(dumpStr),
    pass: toInt(passStr),
  }
  if (credentialsFile !== undefined)
    entry.credentialsFile = credentialsFile
  if (credentialsKey !== undefined)
    entry.credentialsKey = credentialsKey
  if (inlineCredentials !== undefined)
    entry.inlineCredentials = inlineCredentials
  if (secretOptions !== undefined)
    entry.secretOptions = secretOptions
  if (escapedSeparatorTokens !== undefined)
    entry.escapedSeparatorTokens = escapedSeparatorTokens
  // The option-form disable: carried by the line's own tokens, so a disabled
  // entry is `disabled: true` exactly like a legacy `#ANAS ` one.
  if (disable)
    entry.disabled = true

  return { entry, trailingComment, parkedAutomount: parkedAutomount === true }
}

/** Parse an integer field, defaulting to 0 (fstab fs_freq/fs_passno). */
function toInt(s: string | undefined): number {
  const n = Number.parseInt(s ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

/** True for NFS fstypes (`nfs`, `nfs4`). */
export function isNfs(fstype: string): boolean {
  return fstype === 'nfs' || fstype === 'nfs4'
}

/**
 * True for the CIFS fstypes: `cifs` and `smb3` — mount.cifs' own alias
 * (`mount.smb3`), which the kernel also registers. cr3.mounts M5: the
 * inventory already read `smb3` as CIFS (so every Mounts verb accepted it)
 * while this reader and the serializer did not — a credential rotation on an
 * `smb3` line "completed" with the old file still named on the line, the
 * detail said no credentials were set, and an inline password stayed out of
 * the migration. One rule now: what the inventory calls CIFS, the reader, the
 * serializer and the edit merge treat as CIFS.
 */
export function isCifs(fstype: string): boolean {
  return fstype === 'cifs' || fstype === 'smb3'
}

/**
 * Split a comma-separated option list into the structured known tiers plus a
 * verbatim passthrough string for everything unrecognized. NFS/CIFS tiers apply
 * only for the matching fstype; every other token round-trips in `passthrough`
 * in its original order.
 */
export function classifyOptions(
  fstype: string,
  tokens: string[],
): { options: MountOptions, credentialsFile?: string, credentialsKey?: string, inlineCredentials?: MountInlineCredentials, disable?: 'bare' | 'kept-noauto', parkedAutomount?: true, secretOptions?: string[], escapedSeparatorTokens?: number[] } {
  const common: MountCommonOptions = {
    readOnly: false,
    nofail: false,
    noauto: false,
    automount: false,
    noatime: false,
    nosuid: false,
    nodev: false,
    noexec: false,
    netdev: false,
  }
  const nfs: MountNfsOptions = {}
  const cifs: MountCifsOptions = {}
  const passthrough: string[] = []
  let credentialsFile: string | undefined
  let credentialsKey: string | undefined
  const inline: MountInlineCredentials = {}
  /** Hand-written secret tokens kept verbatim, never passthrough (cr.60). */
  const secretOptions: string[] = []
  /** 1-based positions of tokens carrying an escaped separator (review 4, D4). */
  const escapedSeparatorTokens: number[] = []
  const nfsFs = isNfs(fstype)
  const cifsFs = isCifs(fstype)
  /** How (if at all) the line is disabled: the form of its `x-anas.disabled` token. */
  let disable: 'bare' | 'kept-noauto' | undefined
  /** Did the line carry a parked `x-anas.disabled-automount` (cr.19)? */
  let parkedAutomount = false

  for (const [index, token] of tokens.entries()) {
    const eq = token.indexOf('=')
    const key = eq === -1 ? token : token.slice(0, eq)
    const value = eq === -1 ? '' : token.slice(eq + 1)

    // --- an escaped separator (cr3.mounts review 4, D4) — FAIL CLOSED, on
    // any line: ANAS cannot tell what the token says once libmount splits
    // it, so it is hidden whole (a secret may be inside), written back as it
    // was, never put on an argv, and the verbs that act on the line refuse
    // naming its POSITION (1-based) — never its content.
    if (ESCAPED_SEPARATOR_RE.test(token)) {
      secretOptions.push(token)
      escapedSeparatorTokens.push(index + 1)
      continue
    }

    // --- ANAS disable token (cr.6, §2 Mounts ruling) ---
    // CONSUMED — never passthrough, never shown to the UI as an extra option:
    // it is ANAS disable bookkeeping, not an operator-set option. The bare
    // form means ANAS FORCED the `noauto` (the operator's own value is FALSE);
    // the kept-noauto form means the operator's `noauto` was already on the
    // line (left TRUE). The noauto adjustment is applied after the whole list
    // is seen, so a hand-edited token order cannot resurrect a bare form's
    // forced `noauto`.
    if (key.toLowerCase() === 'x-anas.disabled') {
      disable = token.toLowerCase() === X_ANAS_DISABLED_KEPT_TOKEN ? 'kept-noauto' : 'bare'
      continue
    }
    // --- ANAS parked automount (cr.19, §2 Mounts automount ruling) ---
    // CONSUMED like the disable token — bookkeeping, never passthrough, never
    // an extra option. It stands for the operator's `x-systemd.automount`
    // while the line is disabled (applied after the pass, below). Matched by
    // key, case-insensitively, the same way as the disable token.
    if (key.toLowerCase() === X_ANAS_DISABLED_AUTOMOUNT_TOKEN) {
      parkedAutomount = true
      continue
    }

    // --- credential tokens (cr.60, review M7): the ONE shared, case-insensitive
    // list. A credential is `key=value` — a bare `user` is mount(8)'s own
    // "users may mount" flag, never a username. A SECRET never rides the
    // passthrough a response carries, whatever the fstype: on a line ANAS
    // does not read as CIFS (`smb3`, …) it is kept verbatim in secretOptions.
    // cr3.mounts review 3 (11): the key is classified as libmount hands it to
    // mount.cifs — fstab octal escapes DECODED (`\160assword=` is
    // `password=`), so an escaped spelling is redacted, refused and migrated
    // like the plain one.
    const credKey = eq === -1 ? key : unescapeFstabField(key)
    const credKind = cifsCredentialKeyKind(credKey)
    // cr3.mounts review 4: mount.cifs reads credential OPTION tokens by an
    // exact, case-sensitive match. A username / domain / credentials token in
    // another spelling (`USERNAME=`, `Domain=`, `CREDENTIALS=`) is not that
    // credential to mount.cifs, so it is not one here either: it rides the
    // passthrough as the ordinary option it is (a migrating Save refuses the
    // line, naming it). A SECRET in any spelling stays hidden (below).
    const honoured = credKind !== null && HONOURED_CREDENTIAL_KEYS[credKind].has(credKey)
    if (credKind === 'secret' && eq !== -1 && !cifsFs) {
      secretOptions.push(token)
      continue
    }

    // --- common (any fstype) ---
    if (applyCommonToken(common, token, key, value, passthrough))
      continue

    // --- NFS tier ---
    if (nfsFs && applyNfsToken(nfs, token, key, value, passthrough))
      continue

    // --- CIFS tier ---
    if (cifsFs) {
      if (eq !== -1 && credKind === 'file' && honoured) {
        credentialsFile = value
        // cr3.mounts review 2: `cred=` is mount.cifs' alias — the spelling is
        // the operator's and the serializer re-emits it.
        if (key !== 'credentials')
          credentialsKey = key
        continue
      }
      // `guest` is STRUCTURAL, like `credentials=`: the serializer re-derives
      // the auth token from the entry (cifsAuthToken — file, else the lifted
      // username, else `guest`), so a credential-less line round-trips exactly
      // one `guest` — consumed here, never parked in passthrough (where it
      // would come back a second time). A `guest` on a line that also carries
      // a username loses to the username (cr.60r).
      if (key === 'guest')
        continue
      // SECURITY (BUG-1, cr.60 M7): inline credential tokens are NOT
      // passthrough — lifting them into the structured `inlineCredentials`
      // channel keeps the plaintext password out of `passthrough` (which is
      // returned to clients and round-tripped into fstab verbatim). They are
      // migrated to the protected 0600 creds file on the next save. Every
      // spelling of the shared list counts, in any case: `pass=` and
      // `PASSWORD=` are `password=`, `user=` is `username=`.
      // cr.60r (the review's DEFECT): a lifted username with NO password is
      // not migratable (an empty `password=` in a creds file is a real
      // credential shape and would change the mount), and it must never be
      // replaced by `guest` — the serializer re-emits the username token from
      // the channel (cifsAuthToken) under its ORIGINAL key (item 1b), so the
      // account the operator named survives every rewrite of the line spelled
      // the way they spelled it.
      // cr.60r (review possible 2): the lifted VALUE decodes as getmntent(3)
      // reads it — a hand-written `pass=wo\054rds` is the secret `wo,rds`, and
      // the creds file must hold the real characters, not the escape. The
      // decoded value leaves the fstab line only through the serializer's
      // `user=` token (buildOptionTokens), which re-encodes it; passthrough
      // and secretOptions tokens were never decoded, so they stay verbatim.
      if (eq !== -1 && credKind === 'username' && honoured) {
        // The LAST user token wins (mount.cifs parse_options), as here.
        inline.username = unescapeFstabField(value)
        // cr.60r item 1b: keep the operator's SPELLING. `username=bob` and
        // `user=bob` are the same account to mount.cifs but different bytes on
        // the line, and config files are the API — the line was hand-written,
        // the spelling is theirs. The serializer re-emits this exact key.
        if (value !== '')
          inline.usernameKey = key
        continue
      }
      if (eq !== -1 && credKind === 'secret') {
        // cr3.mounts review 2: `password2=`/`pass2=` (the ALTERNATE password a
        // server-side rotation uses) is lifted into its own channel — never
        // read as the main password — and migrated to the credentials file
        // (a `password2=value` line, cifs-utils 7.4) on the next save.
        // cr3.mounts review 3 (1): mount.cifs reads these option tokens by an
        // EXACT, case-sensitive match (`parse_opt_token`: pass|password,
        // pass2|password2). Another spelling (`PASSWORD=`, `Pass2=`) is still
        // a secret HERE — hidden, redacted and refused, the safe side — but
        // it is not what mount.cifs used, so it is never migrated: it stays
        // verbatim in secretOptions, and Mount and Save refuse the line
        // naming the token. Of two honoured password tokens the FIRST counts
        // ("password specified twice, ignoring second").
        if (credKey === 'password2' || credKey === 'pass2') {
          if (inline.password2 === undefined)
            inline.password2 = unescapeFstabField(value)
        }
        else if (credKey === 'password' || credKey === 'pass') {
          if (inline.password === undefined)
            inline.password = unescapeFstabField(value)
        }
        else {
          secretOptions.push(token)
        }
        continue
      }
      // `domain=` (and `dom=`/`workgroup=`) is a credential-set token too;
      // record it in the credentials channel (surfaced in the UI credentials
      // section) while STILL classifying it into the cifs tier so a
      // non-inline `domain=` option round-trips as before. Only when
      // username/password are ALSO present is it treated as an inline-
      // credential domain (migrated to the creds file, stripped inline).
      if (eq !== -1 && credKind === 'domain' && honoured) {
        inline.domain = unescapeFstabField(value)
        applyCifsToken(cifs, 'domain', value, passthrough)
        continue
      }
      if (applyCifsToken(cifs, key, value, passthrough))
        continue
    }

    // --- everything else round-trips verbatim ---
    passthrough.push(token)
  }

  const options: MountOptions = { common, passthrough: passthrough.join(',') }
  if (Object.keys(nfs).length > 0)
    options.nfs = nfs
  if (Object.keys(cifs).length > 0)
    options.cifs = cifs

  // The bare disable form forced a `noauto` onto the line, so the operator's own
  // `noauto` is FALSE — decided after the full pass (see the consume above).
  if (disable === 'bare')
    common.noauto = false
  // A parked automount IS the operator's automount on a disabled line. On a
  // line that is no longer disabled (a hand edit took the disable token off)
  // the parked token is inert to systemd, so the line is honestly read as
  // not automounted; the token is still consumed, and ANAS's next write of
  // the line drops it.
  if (parkedAutomount && disable !== undefined)
    common.automount = true

  const result: { options: MountOptions, credentialsFile?: string, credentialsKey?: string, inlineCredentials?: MountInlineCredentials, disable?: 'bare' | 'kept-noauto', parkedAutomount?: true, secretOptions?: string[], escapedSeparatorTokens?: number[] } = { options }
  if (credentialsFile !== undefined)
    result.credentialsFile = credentialsFile
  if (credentialsKey !== undefined)
    result.credentialsKey = credentialsKey
  if (Object.keys(inline).length > 0)
    result.inlineCredentials = inline
  if (disable !== undefined)
    result.disable = disable
  if (parkedAutomount)
    result.parkedAutomount = true
  if (secretOptions.length > 0)
    result.secretOptions = secretOptions
  if (escapedSeparatorTokens.length > 0)
    result.escapedSeparatorTokens = escapedSeparatorTokens
  return result
}

/** Parse a numeric option value; push the raw token to passthrough if not a number. */
function numOr(value: string, passthrough: string[], token: string): number | undefined {
  const n = Number.parseInt(value, 10)
  if (Number.isFinite(n))
    return n
  passthrough.push(token)
  return undefined
}

/**
 * Recognize an enum-valued option: return the value when it is a member of
 * `allowed`, else round-trip the raw token in passthrough (an exotic/malformed
 * value survives verbatim and never violates the schema on the way back out).
 */
function enumOr(allowed: Set<string>, value: string, passthrough: string[], token: string): string | undefined {
  if (allowed.has(value))
    return value
  passthrough.push(token)
  return undefined
}

/** Common boolean flags → the field they set true (rw/idle-timeout handled separately). */
const COMMON_TRUE_FLAGS: Record<string, keyof MountCommonOptions> = {
  'ro': 'readOnly',
  'nofail': 'nofail',
  'noauto': 'noauto',
  'noatime': 'noatime',
  'nosuid': 'nosuid',
  'nodev': 'nodev',
  'noexec': 'noexec',
  '_netdev': 'netdev',
  'x-systemd.automount': 'automount',
  // cr.70: systemd-fstab-generator still honours the LEGACY spelling of the same
  // option (the string is in the PVE 9 generator binary, stunt-node check
  // 2026-10-17), so the reader reads it as the operator's automount too —
  // consumed here exactly like the modern token, never shown in the
  // passthrough. Matched EXACTLY, as the generator matches it; any other
  // `comment=` value is the operator's own and stays passthrough. ANAS's next
  // write of the line emits the canonical `x-systemd.automount`.
  'comment=systemd.automount': 'automount',
}

/** Apply a common-tier token; returns true when consumed. */
function applyCommonToken(common: MountCommonOptions, token: string, key: string, value: string, passthrough: string[]): boolean {
  if (token === 'rw') {
    common.readOnly = false
    return true
  }
  const flag = COMMON_TRUE_FLAGS[token]
  if (flag) {
    (common[flag] as boolean) = true
    return true
  }
  if (key === 'x-systemd.idle-timeout') {
    const n = numOr(value, passthrough, token)
    if (n !== undefined)
      common.automountIdleTimeout = n
    return true
  }
  return false
}

/** Apply an NFS-tier token (fstype nfs/nfs4); returns true when consumed. */
function applyNfsToken(nfs: MountNfsOptions, token: string, key: string, value: string, passthrough: string[]): boolean {
  if (token === 'hard') {
    nfs.hard = true
    return true
  }
  if (token === 'soft') {
    nfs.hard = false
    return true
  }
  if (key === 'vers' || key === 'nfsvers') {
    nfs.vers = value
    return true
  }
  if (key === 'timeo') {
    nfs.timeo = numOr(value, passthrough, token)
    return true
  }
  if (key === 'retrans') {
    nfs.retrans = numOr(value, passthrough, token)
    return true
  }
  if (key === 'rsize') {
    nfs.rsize = numOr(value, passthrough, token)
    return true
  }
  if (key === 'wsize') {
    nfs.wsize = numOr(value, passthrough, token)
    return true
  }
  if (token === 'noac') {
    nfs.noac = true
    return true
  }
  if (token === 'bg') {
    nfs.bg = true
    return true
  }
  if (key === 'proto') {
    nfs.proto = enumOr(NFS_PROTO_VALUES, value, passthrough, token) as MountNfsOptions['proto']
    return true
  }
  if (key === 'sec') {
    nfs.sec = enumOr(NFS_SEC_VALUES, value, passthrough, token) as MountNfsOptions['sec']
    return true
  }
  if (key === 'lookupcache') {
    nfs.lookupcache = enumOr(NFS_LOOKUPCACHE_VALUES, value, passthrough, token) as MountNfsOptions['lookupcache']
    return true
  }
  if (key === 'actimeo') {
    nfs.actimeo = numOr(value, passthrough, token)
    return true
  }
  if (key === 'nconnect') {
    nfs.nconnect = numOr(value, passthrough, token)
    return true
  }
  return false
}

/** Apply a CIFS-tier token (excluding credentials); returns true when consumed. */
function applyCifsToken(cifs: MountCifsOptions, key: string, value: string, passthrough: string[]): boolean {
  if (key === 'vers') {
    cifs.vers = value
    return true
  }
  if (key === 'domain') {
    cifs.domain = value
    return true
  }
  if (key === 'uid') {
    cifs.uid = numOr(value, passthrough, `uid=${value}`)
    return true
  }
  if (key === 'gid') {
    cifs.gid = numOr(value, passthrough, `gid=${value}`)
    return true
  }
  if (key === 'file_mode') {
    cifs.fileMode = value
    return true
  }
  if (key === 'dir_mode') {
    cifs.dirMode = value
    return true
  }
  if (key === 'mfsymlinks') {
    cifs.mfsymlinks = true
    return true
  }
  if (key === 'forceuid') {
    cifs.forceuid = true
    return true
  }
  if (key === 'forcegid') {
    cifs.forcegid = true
    return true
  }
  if (key === 'noserverino') {
    cifs.noserverino = true
    return true
  }
  if (key === 'nobrl') {
    cifs.nobrl = true
    return true
  }
  if (key === 'cache') {
    cifs.cache = enumOr(CIFS_CACHE_VALUES, value, passthrough, `cache=${value}`) as MountCifsOptions['cache']
    return true
  }
  if (key === 'sec') {
    cifs.sec = enumOr(CIFS_SEC_VALUES, value, passthrough, `sec=${value}`) as MountCifsOptions['sec']
    return true
  }
  if (key === 'rsize') {
    cifs.rsize = numOr(value, passthrough, `rsize=${value}`)
    return true
  }
  if (key === 'wsize') {
    cifs.wsize = numOr(value, passthrough, `wsize=${value}`)
    return true
  }
  if (key === 'actimeo') {
    cifs.actimeo = numOr(value, passthrough, `actimeo=${value}`)
    return true
  }
  if (key === 'iocharset') {
    if (CHARSET_RE.test(value))
      cifs.iocharset = value
    else
      passthrough.push(`iocharset=${value}`)
    return true
  }
  return false
}

/**
 * The auth token a CIFS entry carries in its option list: its credentials
 * FILE when there is one; else the entry's lifted `username=` (cr.60r — a
 * hand-written username with NO password, re-encoded for the line) so the
 * operator's named user survives a rewrite instead of silently becoming an
 * anonymous mount; else `guest`. Stated ONCE and taken by every writer of a
 * CIFS option list — the fstab serializer (below), the daemon's immediate
 * non-fstab mount (routes/mounts.js), and the preflight probe
 * (services/mounts.js) — so the three can never drift apart. Without one of
 * the three, `mount.cifs` PROMPTS for a password on stdin ("Password for
 * root@//host/share:"); a boot mount (or a `mountNow` with no terminal) then
 * hangs until `nofail` hides it. `guest` makes the request anonymous instead:
 * an auth-requiring share answers EACCES, which is honest.
 */
export function cifsAuthToken(credentialsFile: string | undefined, username?: string, usernameTokenKey?: string, credentialsTokenKey?: string): string {
  // cr3.mounts review 2: a line written `cred=` keeps that spelling.
  if (credentialsFile)
    return `${credentialsTokenKey ?? 'credentials'}=${credentialsFile}`
  // cr.60r (the review's DEFECT): a username is NEVER lost and NEVER replaced
  // by `guest`. An empty username is no username — the line is credential-less
  // and `guest` is right. cr.60r item 1b: the fstab serializer passes the
  // token's ORIGINAL key (a hand-written `username=bob` stays spelled
  // `username=bob`); the mount-argument callers have no line to be faithful
  // to and get mount.cifs' short alias.
  if (username)
    return `${usernameTokenKey ?? 'user'}=${escapeFstabOptionValue(username)}`
  return 'guest'
}

/** Build the canonical, ordered option-token list for a serialized entry. */
function buildOptionTokens(entry: MountEntry): string[] {
  const t: string[] = []
  const c = entry.options.common
  if (c.readOnly)
    t.push('ro')

  if (isNfs(entry.fstype) && entry.options.nfs) {
    const n = entry.options.nfs
    if (n.vers !== undefined)
      t.push(`vers=${n.vers}`)
    if (n.hard === true)
      t.push('hard')
    else if (n.hard === false)
      t.push('soft')
    if (n.timeo !== undefined)
      t.push(`timeo=${n.timeo}`)
    if (n.retrans !== undefined)
      t.push(`retrans=${n.retrans}`)
    if (n.rsize !== undefined)
      t.push(`rsize=${n.rsize}`)
    if (n.wsize !== undefined)
      t.push(`wsize=${n.wsize}`)
    if (n.proto !== undefined)
      t.push(`proto=${n.proto}`)
    if (n.sec !== undefined)
      t.push(`sec=${n.sec}`)
    if (n.actimeo !== undefined)
      t.push(`actimeo=${n.actimeo}`)
    if (n.nconnect !== undefined)
      t.push(`nconnect=${n.nconnect}`)
    if (n.lookupcache !== undefined)
      t.push(`lookupcache=${n.lookupcache}`)
    if (n.noac === true)
      t.push('noac')
    if (n.bg === true)
      t.push('bg')
  }

  if (isCifs(entry.fstype)) {
    const cifs = entry.options.cifs
    if (cifs?.vers !== undefined)
      t.push(`vers=${cifs.vers}`)
    t.push(cifsAuthToken(entry.credentialsFile, entry.inlineCredentials?.username, entry.inlineCredentials?.usernameKey, entry.credentialsKey))
    // A hand-written line carrying BOTH a credentials file and a bare
    // `user=`/`username=` keeps both (cr.60r: the username is never lost),
    // spelled as it was written (item 1b); with no file the auth token above
    // already carries the username.
    if (entry.credentialsFile && entry.inlineCredentials?.username)
      t.push(`${entry.inlineCredentials.usernameKey ?? 'user'}=${escapeFstabOptionValue(entry.inlineCredentials.username)}`)
    if (cifs?.domain !== undefined)
      t.push(`domain=${cifs.domain}`)
    if (cifs?.uid !== undefined)
      t.push(`uid=${cifs.uid}`)
    if (cifs?.gid !== undefined)
      t.push(`gid=${cifs.gid}`)
    if (cifs?.fileMode !== undefined)
      t.push(`file_mode=${cifs.fileMode}`)
    if (cifs?.dirMode !== undefined)
      t.push(`dir_mode=${cifs.dirMode}`)
    if (cifs?.cache !== undefined)
      t.push(`cache=${cifs.cache}`)
    if (cifs?.sec !== undefined)
      t.push(`sec=${cifs.sec}`)
    if (cifs?.rsize !== undefined)
      t.push(`rsize=${cifs.rsize}`)
    if (cifs?.wsize !== undefined)
      t.push(`wsize=${cifs.wsize}`)
    if (cifs?.actimeo !== undefined)
      t.push(`actimeo=${cifs.actimeo}`)
    if (cifs?.iocharset !== undefined)
      t.push(`iocharset=${cifs.iocharset}`)
    if (cifs?.mfsymlinks === true)
      t.push('mfsymlinks')
    if (cifs?.forceuid === true)
      t.push('forceuid')
    if (cifs?.forcegid === true)
      t.push('forcegid')
    if (cifs?.noserverino === true)
      t.push('noserverino')
    if (cifs?.nobrl === true)
      t.push('nobrl')
  }

  if (c.noatime)
    t.push('noatime')
  if (c.nosuid)
    t.push('nosuid')
  if (c.nodev)
    t.push('nodev')
  if (c.noexec)
    t.push('noexec')
  if (c.noauto)
    t.push('noauto')
  if (c.nofail)
    t.push('nofail')
  if (c.netdev)
    t.push('_netdev')
  if (c.automount)
    t.push('x-systemd.automount')
  if (c.automountIdleTimeout !== undefined)
    t.push(`x-systemd.idle-timeout=${c.automountIdleTimeout}`)

  if (entry.options.passthrough)
    t.push(...entry.options.passthrough.split(','))
  // cr.60 (M7): the hand-written secrets ANAS does not migrate (a password on
  // a line that is not CIFS — cr3 review 2 migrates a CIFS `password2=`)
  // go back on the line as they were — out of every response, never dropped.
  if (entry.secretOptions)
    t.push(...entry.secretOptions)

  if (t.length === 0)
    t.push('defaults')
  return t
}
