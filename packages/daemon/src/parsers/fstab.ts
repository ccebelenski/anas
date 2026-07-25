import type { MountCifsOptions, MountCommonOptions, MountEntry, MountInlineCredentials, MountNfsOptions, MountOptions } from '@anas/shared'
import { MountCifsCache, MountCifsSec, MountLookupCache, MountNfsProto, MountNfsSec } from '@anas/shared'

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
 * Disable-without-delete marker (operator decision): a disabled ANAS entry is
 * its original line VERBATIM, prefixed with `#ANAS `. One prefix, byte-identical
 * remainder — enabling strips exactly this and restores the original bytes.
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
 * and its disabled marker are preserved. No-op if `mountpoint` is absent.
 */
export function replaceMount(text: string, mountpoint: string, entry: MountEntry): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind === 'entry' && line.entry.mountpoint === mountpoint) {
      const comment = line.trailingComment ? `   ${line.trailingComment}` : ''
      const base = serializeMountLine(entry) + comment
      line.raw = line.disabled ? ANAS_MARKER + base : base
      line.entry = entry
      break
    }
  }
  return serializeFstabDoc(doc)
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
 * Disable ONLY the line for `mountpoint` without deleting it: prefix its raw
 * bytes with the `#ANAS ` marker (byte-identical remainder). No-op if absent or
 * already disabled. Enabling later restores the original bytes exactly.
 */
export function disableMount(text: string, mountpoint: string): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind === 'entry' && line.entry.mountpoint === mountpoint && !line.disabled) {
      line.raw = ANAS_MARKER + line.raw
      line.disabled = true
      break
    }
  }
  return serializeFstabDoc(doc)
}

/**
 * Enable ONLY the disabled line for `mountpoint`: strip exactly the `#ANAS `
 * marker, restoring the original bytes. No-op if absent or not disabled.
 */
export function enableMount(text: string, mountpoint: string): string {
  const doc = parseFstabDoc(text)
  for (const line of doc) {
    if (line.kind === 'entry' && line.entry.mountpoint === mountpoint && line.disabled && line.raw.startsWith(ANAS_MARKER)) {
      line.raw = line.raw.slice(ANAS_MARKER.length)
      line.disabled = false
      break
    }
  }
  return serializeFstabDoc(doc)
}

/** Serialize one entry to a canonical single /etc/fstab line (no inline comment). */
export function serializeMountLine(entry: MountEntry): string {
  const opts = buildOptionTokens(entry).join(',')
  return `${entry.spec} ${entry.mountpoint} ${entry.fstype} ${opts} ${entry.dump} ${entry.pass}`
}

// --- Internals --------------------------------------------------------------

/**
 * Parse one raw line into a structured entry, or null for comments, blanks, and
 * lines that are not recognizable as a manageable mount entry (preserved
 * verbatim as `other`).
 *
 * A line prefixed with the `#ANAS ` marker whose REMAINDER parses as a valid
 * entry is a DISABLED mount (disabled=true). If the remainder does not parse,
 * the line is an ordinary comment (fail-open — never mangle a human's prose
 * comment that happens to start with `#ANAS `).
 */
function parseEntryLine(raw: string): { entry: MountEntry, trailingComment: string, disabled: boolean } | null {
  if (raw.startsWith(ANAS_MARKER)) {
    const parsed = parseActiveEntry(raw.slice(ANAS_MARKER.length))
    if (!parsed)
      return null // not an entry under the marker → an ordinary comment
    parsed.entry.disabled = true
    return { ...parsed, disabled: true }
  }

  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#'))
    return null // blank line or whole-line (incl. commented-out) entry

  const parsed = parseActiveEntry(raw)
  return parsed ? { ...parsed, disabled: false } : null
}

/** Parse an ACTIVE (uncommented) fstab data line into an entry, or null. */
function parseActiveEntry(raw: string): { entry: MountEntry, trailingComment: string } | null {
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

  const [spec, mountpoint, fstype, optStr, dumpStr, passStr] = fields
  // The mountpoint is our identity and must be an absolute path.
  if (!mountpoint.startsWith('/'))
    return null

  const tokens = optStr.split(',').map(o => o.trim()).filter(Boolean)
  const { options, credentialsFile, inlineCredentials } = classifyOptions(fstype, tokens)

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

  return { entry, trailingComment }
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
): { options: MountOptions, credentialsFile?: string, inlineCredentials?: MountInlineCredentials } {
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
  const nfsFs = isNfs(fstype)
  const cifsFs = fstype === 'cifs'

  for (const token of tokens) {
    const eq = token.indexOf('=')
    const key = eq === -1 ? token : token.slice(0, eq)
    const value = eq === -1 ? '' : token.slice(eq + 1)

    // --- common (any fstype) ---
    if (applyCommonToken(common, token, key, value, passthrough))
      continue

    // --- NFS tier ---
    if (nfsFs && applyNfsToken(nfs, token, key, value, passthrough))
      continue

    // --- CIFS tier ---
    if (cifsFs) {
      if (key === 'credentials') {
        credentialsFile = value
        continue
      }
      // SECURITY (BUG-1): inline `username=`/`password=` are credential tokens,
      // NOT passthrough — lifting them into the structured `inlineCredentials`
      // channel keeps the plaintext password out of `passthrough` (which is
      // returned to clients and round-tripped into fstab verbatim). They are
      // migrated to the protected 0600 creds file on the next save.
      if (key === 'username') {
        inline.username = value
        continue
      }
      if (key === 'password') {
        inline.password = value
        continue
      }
      // `domain=` is a credential-set token too; record it in the credentials
      // channel (surfaced in the UI credentials section) while STILL classifying
      // it into the cifs tier so a non-inline `domain=` option round-trips as
      // before. Only when username/password are ALSO present is it treated as an
      // inline-credential domain (migrated to the creds file, stripped inline).
      if (key === 'domain')
        inline.domain = value
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

  const result: { options: MountOptions, credentialsFile?: string, inlineCredentials?: MountInlineCredentials } = { options }
  if (credentialsFile !== undefined)
    result.credentialsFile = credentialsFile
  if (Object.keys(inline).length > 0)
    result.inlineCredentials = inline
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
    if (entry.credentialsFile !== undefined)
      t.push(`credentials=${entry.credentialsFile}`)
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

  if (t.length === 0)
    t.push('defaults')
  return t
}
