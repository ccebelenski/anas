import type { MountCifsOptions, MountCommonOptions, MountEntry, MountInlineCredentials, MountNfsOptions, MountOptions } from '@anas/shared'
import { cifsCredentialKeyKind, escapeFstabField, MountCifsCache, MountCifsSec, MountLookupCache, MountNfsProto, MountNfsSec, unescapeFstabField, X_ANAS_DISABLED_AUTOMOUNT_TOKEN, X_ANAS_DISABLED_KEPT_TOKEN, X_ANAS_DISABLED_TOKEN, X_SYSTEMD_AUTOMOUNT_TOKEN } from '@anas/shared'

/** Recognized enum-value sets, mirrored from the shared schema (never drift). */
const CIFS_CACHE_VALUES = new Set<string>(MountCifsCache.options)
const CIFS_SEC_VALUES = new Set<string>(MountCifsSec.options)
const NFS_PROTO_VALUES = new Set<string>(MountNfsProto.options)
const NFS_SEC_VALUES = new Set<string>(MountNfsSec.options)
const NFS_LOOKUPCACHE_VALUES = new Set<string>(MountLookupCache.options)
/** A plain charset token (mirrors MountCharset) — else the option round-trips raw. */
const CHARSET_RE = /^[\w.-]+$/

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

/** Whitespace splitter for the six fstab fields. */
const FIELD_SPLIT = /\s+/

/**
 * The four mandatory fstab fields with their ORIGINAL separators, plus whatever
 * follows (dump/pass, and any spacing a human chose).
 *
 * The tail is `(?:\s[\s\S]*)?` rather than `[\s\S]*` on purpose: a `\S+`
 * field followed by "anything" can split the same text in many ways, and the
 * regex engine will try them all on a long malformed line. Requiring the tail to
 * start with whitespace makes the split unambiguous, because a non-space field
 * can never absorb it.
 */
const FSTAB_FOUR_FIELDS = /^(\s*)(\S+)(\s+)(\S+)(\s+)(\S+)(\s+)(\S+)((?:\s[\s\S]*)?)$/

/** Single whitespace char — the token boundary before an inline `#` comment. */
const WS_CHAR = /\s/

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

/** The entry for `mountpoint`, or undefined if the file has none. */
export function getMount(text: string, mountpoint: string): MountEntry | undefined {
  return parseFstab(text).find(e => e.mountpoint === mountpoint)
}

/** Is `mountpoint` present in the file as an entry line? */
export function hasMount(text: string, mountpoint: string): boolean {
  return parseFstabDoc(text).some(l => l.kind === 'entry' && l.entry.mountpoint === mountpoint)
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
    if (line.kind === 'entry' && line.entry.mountpoint === mountpoint) {
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
  const fieldsPart = hashIdx === -1 ? body : body.slice(0, hashIdx)
  const comment = hashIdx === -1 ? '' : body.slice(hashIdx)

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
    tail,
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
    if (line.kind !== 'entry' || line.entry.mountpoint !== mountpoint)
      continue
    const ops = entryOptionsOps(line)
    if (!ops)
      return text
    if (ops.opts.split(',').map(o => o.trim()).includes(token))
      return text
    rewriteEntryOptions(line, opts => (opts ? `${opts},${token}` : token))
    refreshEntry(line)
    break
  }
  return serializeFstabDoc(doc)
}

/**
 * Does the line for `mountpoint` carry an automount — a LIVE
 * `x-systemd.automount` or a PARKED `x-anas.disabled-automount` (cr.19)? Read
 * from the raw option tokens, not the structured entry, so a parked token on a
 * line whose disable token a hand edit removed still counts: the routes use
 * this to decide whether the line's `.automount` unit may be armed and must be
 * stopped before the daemon-reload (node pass R1-D2/D3).
 */
export function carriesAutomount(text: string, mountpoint: string): boolean {
  for (const line of parseFstabDoc(text)) {
    if (line.kind !== 'entry' || line.entry.mountpoint !== mountpoint)
      continue
    const ops = entryOptionsOps(line)
    return ops !== null && ops.opts.split(',').some(t => isLiveAutomountToken(t) || isParkedAutomountToken(t))
  }
  return false
}

/** Remove ONLY the line for `mountpoint` (active or disabled). No-op if absent. */
export function removeMount(text: string, mountpoint: string): string {
  const doc = parseFstabDoc(text)
  const idx = doc.findIndex(l => l.kind === 'entry' && l.entry.mountpoint === mountpoint)
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
  const t = token.trim()
  const eq = t.indexOf('=')
  return eq === -1 ? t : t.slice(0, eq)
}

/** Is `token` the LIVE `x-systemd.automount` (exact, as the generator matches it)? */
function isLiveAutomountToken(token: string): boolean {
  return token.trim() === X_SYSTEMD_AUTOMOUNT_TOKEN
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
  const core = token.trim()
  const at = token.indexOf(core)
  return `${token.slice(0, at)}${to}${token.slice(at + core.length)}`
}

/**
 * Park every live `x-systemd.automount` in an OPTIONS column IN PLACE (cr.19,
 * §2 Mounts automount ruling): the token keeps its position, every other
 * token keeps its exact bytes. Returns the column unchanged when it carries
 * no live automount.
 */
function parkAutomount(opts: string): string {
  return opts.split(',').map(t => (isLiveAutomountToken(t) ? swapTokenText(t, X_ANAS_DISABLED_AUTOMOUNT_TOKEN) : t)).join(',')
}

/** The inverse of {@link parkAutomount}: every parked token back to `x-systemd.automount`, in place. */
function unparkAutomount(opts: string): string {
  return opts.split(',').map(t => (isParkedAutomountToken(t) ? swapTokenText(t, X_SYSTEMD_AUTOMOUNT_TOKEN) : t)).join(',')
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
 * IN PLACE for `x-anas.disabled-automount` (cr.19, §2 Mounts automount ruling):
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
    if (line.kind !== 'entry' || line.entry.mountpoint !== mountpoint)
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
 * `x-systemd.automount` (cr.19).
 */
export function enableMount(text: string, mountpoint: string): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind !== 'entry' || line.entry.mountpoint !== mountpoint || !line.disabled)
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
        t.trim().split('=')[0].toLowerCase() === X_ANAS_DISABLED_TOKEN
      // Same rule as classifyOptions: any disable token that is not the
      // kept-noauto form is the bare form.
      const hasBare = tokens.some(t => isDisableToken(t) && t.trim().toLowerCase() !== X_ANAS_DISABLED_KEPT_TOKEN)
      // Removal matches the TRIMMED token so a hand-spaced token still goes, but
      // every SURVIVING token keeps its exact bytes — a comma-separated
      // `defaults, nofail` the operator wrote stays `defaults, nofail`, so the
      // round trip is byte-identical even with hand spacing.
      rewriteEntryOptions(line, (opts) => {
        const out: string[] = []
        for (const t of opts.split(',').filter(o => o !== '')) {
          if (!isDisableToken(t) && !(hasBare && t.trim() === 'noauto'))
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

// --- Internals --------------------------------------------------------------

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

  const trimmed = raw.trim()
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
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#'))
    return null

  // Split off an inline trailing comment — a `#` that STARTS a token (column 0 or
  // whitespace-preceded), never a `#` embedded inside a field (a `#` in an option
  // value such as a password is data, not a comment: BUG-2 was truncating there).
  const hashIdx = inlineCommentIndex(raw)
  const fieldsPart = hashIdx === -1 ? raw : raw.slice(0, hashIdx)
  const trailingComment = hashIdx === -1 ? '' : raw.slice(hashIdx)

  const fields = fieldsPart.trim().split(FIELD_SPLIT)
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

  const tokens = optStr.split(',').map(o => o.trim()).filter(Boolean)
  const { options, credentialsFile, inlineCredentials, disable, parkedAutomount, secretOptions } = classifyOptions(fstype, tokens)

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
  if (inlineCredentials !== undefined)
    entry.inlineCredentials = inlineCredentials
  if (secretOptions !== undefined)
    entry.secretOptions = secretOptions
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
function isNfs(fstype: string): boolean {
  return fstype === 'nfs' || fstype === 'nfs4'
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
): { options: MountOptions, credentialsFile?: string, inlineCredentials?: MountInlineCredentials, disable?: 'bare' | 'kept-noauto', parkedAutomount?: true, secretOptions?: string[] } {
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
  const inline: MountInlineCredentials = {}
  /** Hand-written secret tokens kept verbatim, never passthrough (cr.60). */
  const secretOptions: string[] = []
  const nfsFs = isNfs(fstype)
  const cifsFs = fstype === 'cifs'
  /** How (if at all) the line is disabled: the form of its `x-anas.disabled` token. */
  let disable: 'bare' | 'kept-noauto' | undefined
  /** Did the line carry a parked `x-anas.disabled-automount` (cr.19)? */
  let parkedAutomount = false

  for (const token of tokens) {
    const eq = token.indexOf('=')
    const key = eq === -1 ? token : token.slice(0, eq)
    const value = eq === -1 ? '' : token.slice(eq + 1)

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
    const credKind = cifsCredentialKeyKind(key)
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
      if (credKind === 'file') {
        credentialsFile = value
        continue
      }
      // `guest` is STRUCTURAL, like `credentials=`: the serializer re-derives
      // it from the ABSENCE of a credentials file (cifsAuthToken), so a
      // credential-less line round-trips exactly one `guest` — consumed here,
      // never parked in passthrough (where it would come back a second time).
      if (key === 'guest')
        continue
      // SECURITY (BUG-1, cr.60 M7): inline credential tokens are NOT
      // passthrough — lifting them into the structured `inlineCredentials`
      // channel keeps the plaintext password out of `passthrough` (which is
      // returned to clients and round-tripped into fstab verbatim). They are
      // migrated to the protected 0600 creds file on the next save. Every
      // spelling of the shared list counts, in any case: `pass=` and
      // `PASSWORD=` are `password=`, `user=` is `username=`.
      if (eq !== -1 && credKind === 'username') {
        inline.username = value
        continue
      }
      if (eq !== -1 && credKind === 'secret') {
        // `password2=` (the rotation password) is not part of the creds file
        // ANAS writes: hidden the same, kept verbatim on the line.
        if (key.toLowerCase() === 'password2')
          secretOptions.push(token)
        else
          inline.password = value
        continue
      }
      // `domain=` (and `dom=`/`workgroup=`) is a credential-set token too;
      // record it in the credentials channel (surfaced in the UI credentials
      // section) while STILL classifying it into the cifs tier so a
      // non-inline `domain=` option round-trips as before. Only when
      // username/password are ALSO present is it treated as an inline-
      // credential domain (migrated to the creds file, stripped inline).
      if (eq !== -1 && credKind === 'domain') {
        inline.domain = value
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

  const result: { options: MountOptions, credentialsFile?: string, inlineCredentials?: MountInlineCredentials, disable?: 'bare' | 'kept-noauto', parkedAutomount?: true, secretOptions?: string[] } = { options }
  if (credentialsFile !== undefined)
    result.credentialsFile = credentialsFile
  if (Object.keys(inline).length > 0)
    result.inlineCredentials = inline
  if (disable !== undefined)
    result.disable = disable
  if (parkedAutomount)
    result.parkedAutomount = true
  if (secretOptions.length > 0)
    result.secretOptions = secretOptions
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
 * FILE when there is one, `guest` when there is not. Stated ONCE and taken by
 * every writer of a CIFS option list — the fstab serializer (below), the
 * daemon's immediate non-fstab mount (routes/mounts.js), and the preflight
 * probe (services/mounts.js) — so the three can never drift apart. Without
 * one of the two, `mount.cifs` PROMPTS for a password on stdin ("Password for
 * root@//host/share:"); a boot mount (or a `mountNow` with no terminal) then
 * hangs until `nofail` hides it. `guest` makes the request anonymous instead:
 * an auth-requiring share answers EACCES, which is honest.
 */
export function cifsAuthToken(credentialsFile: string | undefined): string {
  return credentialsFile ? `credentials=${credentialsFile}` : 'guest'
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

  if (entry.fstype === 'cifs') {
    const cifs = entry.options.cifs
    if (cifs?.vers !== undefined)
      t.push(`vers=${cifs.vers}`)
    t.push(cifsAuthToken(entry.credentialsFile))
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
  // cr.60 (M7): the hand-written secrets ANAS does not migrate (`password2=`)
  // go back on the line as they were — out of every response, never dropped.
  if (entry.secretOptions)
    t.push(...entry.secretOptions)

  if (t.length === 0)
    t.push('defaults')
  return t
}
