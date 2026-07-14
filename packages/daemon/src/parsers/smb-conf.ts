/**
 * Round-trip parser + surgical editor for `smb.conf` (Samba).
 *
 * smb.conf is an INI-like file: `[section]` headers, `key = value` lines,
 * `#`/`;` comments, blank lines, trailing-backslash line continuations, and an
 * `include = ` directive. Parameter names are case- AND space-insensitive:
 * "read only", "readonly" and "Read Only" are the same key.
 *
 * ── Round-trip fidelity (Principle 12: we are a guest, never reformat) ──
 * The file is held as its ORIGINAL array of lines. Nothing is ever regenerated
 * from the model: every mutation splices the line array (or concatenates onto
 * the original text) and carries every untouched line through verbatim.
 * `serializeDoc(parseDoc(text)) === text` byte-for-byte for ANY input, because
 * `text.split('\n')` then `.join('\n')` is the identity, and unchanged lines are
 * never rewritten. Comments, ordering, whitespace, blank lines, continuations
 * and unknown directives are preserved automatically.
 *
 * The typed helpers (parseSmbConf / getShare / update*) read the model to build
 * the shared SmbShare / SmbGlobalConfig read-models and to perform surgical
 * edits; they never touch lines outside the section (and key) being changed.
 */

import type { CreateSmbShareRequest, SmbGlobalConfig, SmbShare, UpdateSmbGlobalConfigRequest, UpdateSmbShareRequest } from '@anas/shared'

/** `[section]` header (whole trimmed line). */
const SECTION_HEADER_RE = /^\[(.+)\]\s*$/
/** Runs of whitespace, for folding parameter names. */
const KEY_WS_RE = /\s+/g
/** Leading whitespace of a line. */
const LEADING_WS_RE = /^\s*/
/** Samba list separator: whitespace and/or commas. */
const LIST_SEP_RE = /[,\s]+/

// ============================================================================
// Low-level line model — the round-trip substrate.
// ============================================================================

/** A parsed section span over the original `lines` array. */
export interface SectionSpan {
  /** Display name exactly as written (null = preamble before the first header). */
  name: string | null
  /** Lower-cased name for case-insensitive lookup (Samba matches this way). */
  key: string | null
  /** Index of the `[name]` header line, or null for the preamble. */
  headerIndex: number | null
  /** First line index of the section (the header line, or 0 for the preamble). */
  start: number
  /** One past the last line index of the section (exclusive). */
  end: number
}

/** The whole file as its original lines plus the section overlay. */
export interface SmbConfDoc {
  lines: string[]
  sections: SectionSpan[]
}

/** Strip a single trailing CR so CRLF files interpret cleanly (kept on write). */
function content(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** Does the trimmed line begin a comment (`#` or `;`)? */
function isComment(trimmed: string): boolean {
  return trimmed.startsWith('#') || trimmed.startsWith(';')
}

/** A `[section]` header line → the raw section name, else null. */
function sectionHeader(line: string): string | null {
  const trimmed = content(line).trim()
  if (!trimmed || isComment(trimmed))
    return null
  const m = SECTION_HEADER_RE.exec(trimmed)
  return m ? m[1].trim() : null
}

/**
 * Split a `key = value` line into its parts, or null if it is not one. Keys are
 * normalised (lower-cased, spaces removed) so "Read Only" === "readonly".
 */
function parseKeyLine(line: string): { key: string, value: string } | null {
  const trimmed = content(line).trim()
  if (!trimmed || isComment(trimmed) || trimmed.startsWith('['))
    return null
  const eq = trimmed.indexOf('=')
  if (eq === -1)
    return null
  const rawKey = trimmed.slice(0, eq).trim()
  if (!rawKey)
    return null
  return { key: normalizeKey(rawKey), value: trimmed.slice(eq + 1).trim() }
}

/** Normalise a parameter name: case- and space-insensitive (Samba semantics). */
export function normalizeKey(name: string): string {
  return name.toLowerCase().replace(KEY_WS_RE, '')
}

/** Does the (content of the) line end in an unescaped continuation backslash? */
function isContinued(line: string): boolean {
  return content(line).endsWith('\\')
}

/**
 * Parse the file text into the round-trip document model. Never loses data:
 * `lines` is exactly `text.split('\n')`, so `join('\n')` reconstructs `text`.
 */
export function parseDoc(text: string): SmbConfDoc {
  const lines = text.split('\n')

  // Collect header line indices (skipping comments) to build section spans.
  const headers: { index: number, name: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const name = sectionHeader(lines[i])
    if (name !== null)
      headers.push({ index: i, name })
  }

  const sections: SectionSpan[] = []
  if (headers.length === 0) {
    // Whole file is a headerless preamble (comments / blanks / stray keys).
    if (text.length > 0)
      sections.push({ name: null, key: null, headerIndex: null, start: 0, end: lines.length })
    return { lines, sections }
  }

  // Leading preamble before the first header.
  if (headers[0].index > 0)
    sections.push({ name: null, key: null, headerIndex: null, start: 0, end: headers[0].index })

  for (let h = 0; h < headers.length; h++) {
    const start = headers[h].index
    const end = h + 1 < headers.length ? headers[h + 1].index : lines.length
    sections.push({
      name: headers[h].name,
      key: headers[h].name.toLowerCase(),
      headerIndex: start,
      start,
      end,
    })
  }

  return { lines, sections }
}

/** Reconstruct the file text from the document model (byte-for-byte on no-op). */
export function serializeDoc(doc: SmbConfDoc): string {
  return doc.lines.join('\n')
}

/** Find a section span by name (case-insensitive), or null. */
function findSection(doc: SmbConfDoc, name: string): SectionSpan | null {
  const key = name.toLowerCase()
  return doc.sections.find(s => s.key === key) ?? null
}

/**
 * Collect a section's effective key → value map (last definition wins, as
 * Samba does), joining trailing-backslash continuation lines.
 */
function sectionKeys(doc: SmbConfDoc, span: SectionSpan): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    const parsed = parseKeyLine(doc.lines[i])
    if (!parsed)
      continue
    let value = parsed.value
    // Absorb continuation lines (value ends in `\`).
    while (isContinued(doc.lines[i]) && i + 1 < span.end) {
      value = `${value.slice(0, -1)} ${content(doc.lines[i + 1]).trim()}`
      i++
    }
    out[parsed.key] = value.trim()
  }
  return out
}

// ============================================================================
// Value <-> smb.conf coercion helpers.
// ============================================================================

/** Parse a Samba boolean (yes/true/1 → true; else false). */
function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined)
    return fallback
  const v = value.trim().toLowerCase()
  if (v === 'yes' || v === 'true' || v === '1')
    return true
  if (v === 'no' || v === 'false' || v === '0')
    return false
  return fallback
}

/** Serialise a boolean to Samba's canonical `yes`/`no`. */
function boolStr(value: boolean): string {
  return value ? 'yes' : 'no'
}

/** Split a Samba list value (space- and/or comma-separated) into entries. */
function parseList(value: string | undefined): string[] {
  if (!value)
    return []
  return value.split(LIST_SEP_RE).map(s => s.trim()).filter(Boolean)
}

// ============================================================================
// Typed read-models (SmbShare / SmbGlobalConfig) built from key maps.
// ============================================================================

/**
 * Build an SmbShare from a section's key map, or null if it has no path — such
 * sections (e.g. `[homes]`, `[printers]`) are not path-based file shares ANAS
 * manages, and would not satisfy the schema's AbsolutePath.
 */
function toSmbShare(name: string, keys: Record<string, string>): SmbShare | null {
  // `path` and `directory` are Samba synonyms.
  const path = keys.path ?? keys.directory
  if (!path)
    return null

  // read only ↔ writeable/writable/write ok (inverse). read only defaults to
  // Samba's own default (yes) when neither form is present.
  let readOnly: boolean
  if (keys.readonly !== undefined)
    readOnly = parseBool(keys.readonly, true)
  else if (keys.writeable !== undefined)
    readOnly = !parseBool(keys.writeable, false)
  else if (keys.writable !== undefined)
    readOnly = !parseBool(keys.writable, false)
  else if (keys.writeok !== undefined)
    readOnly = !parseBool(keys.writeok, false)
  else
    readOnly = true

  return {
    name,
    path,
    comment: keys.comment ?? null,
    // `browsable` is the alternate spelling; Samba default is yes.
    browseable: parseBool(keys.browseable ?? keys.browsable, true),
    readOnly,
    // `public` is a synonym for `guest ok`; default no.
    guestOk: parseBool(keys.guestok ?? keys.public, false),
    validUsers: parseList(keys.validusers),
    // `allow hosts` / `deny hosts` are synonyms.
    hostsAllow: parseList(keys.hostsallow ?? keys.allowhosts),
    hostsDeny: parseList(keys.hostsdeny ?? keys.denyhosts),
  }
}

/** Build the SmbGlobalConfig read-model from the `[global]` key map. */
function toGlobalConfig(keys: Record<string, string>): SmbGlobalConfig {
  return {
    workgroup: keys.workgroup ?? '',
    serverString: keys.serverstring ?? '',
    interfaces: parseList(keys.interfaces),
    bindInterfacesOnly: parseBool(keys.bindinterfacesonly, false),
  }
}

/** The parsed view of a whole smb.conf: global config + all path-based shares. */
export interface SmbConfView {
  global: SmbGlobalConfig
  shares: SmbShare[]
}

/** Parse smb.conf text into the typed global config + share list. */
export function parseSmbConf(text: string): SmbConfView {
  const doc = parseDoc(text)
  let global: SmbGlobalConfig = toGlobalConfig({})
  const shares: SmbShare[] = []

  for (const span of doc.sections) {
    if (span.key === null)
      continue // preamble
    const keys = sectionKeys(doc, span)
    if (span.key === 'global') {
      global = toGlobalConfig(keys)
      continue
    }
    const share = toSmbShare(span.name as string, keys)
    if (share)
      shares.push(share)
  }

  return { global, shares }
}

/** Return one share by name (case-insensitive), or null. */
export function getShare(text: string, name: string): SmbShare | null {
  const doc = parseDoc(text)
  const span = findSection(doc, name)
  if (!span || span.key === 'global')
    return null
  return toSmbShare(span.name as string, sectionKeys(doc, span))
}

/** Does a share section by this name exist? (case-insensitive). */
export function hasShare(text: string, name: string): boolean {
  const span = findSection(parseDoc(text), name)
  return span !== null && span.key !== 'global'
}

// ============================================================================
// Surgical editors — each returns new text, changing ONLY the target section
// (and, within it, only the target keys). All other bytes pass through verbatim.
// ============================================================================

/** The canonical smb.conf key + serialised value for a share field. */
interface KeyEdit {
  /** Normalised key used to locate an existing line. */
  norm: string
  /** Canonical key spelling written when inserting a new line. */
  canonical: string
  /** New value, or null to REMOVE the key. */
  value: string | null
}

/** Detect the leading whitespace used by entries in a section (default a tab). */
function sectionIndent(doc: SmbConfDoc, span: SectionSpan): string {
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    if (parseKeyLine(doc.lines[i])) {
      const m = LEADING_WS_RE.exec(content(doc.lines[i]))
      return m ? m[0] : '\t'
    }
  }
  return '\t'
}

/**
 * Find the line index (and its last continuation line) of a normalised key in
 * a section, or null. Only the LAST definition is returned (Samba precedence),
 * so an edit changes the effective value.
 */
function findKeyLine(doc: SmbConfDoc, span: SectionSpan, norm: string): { first: number, last: number } | null {
  let found: { first: number, last: number } | null = null
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    const parsed = parseKeyLine(doc.lines[i])
    if (!parsed || parsed.key !== norm)
      continue
    let last = i
    while (isContinued(doc.lines[last]) && last + 1 < span.end)
      last++
    found = { first: i, last }
  }
  return found
}

/** Replace ONLY the value portion of a `key = value` line, preserving prefix. */
function replaceValue(line: string, value: string): string {
  const cr = line.endsWith('\r') ? '\r' : ''
  const body = content(line)
  const eq = body.indexOf('=')
  if (eq === -1)
    return `${body} = ${value}${cr}`
  // Keep the prefix up to `=` plus its trailing spaces/tabs; swap only the value.
  let i = eq + 1
  while (i < body.length && (body[i] === ' ' || body[i] === '\t'))
    i++
  return `${body.slice(0, i)}${value}${cr}`
}

/**
 * Apply a set of key edits to one section, splicing `doc.lines` in place.
 * Existing keys have only their value line rewritten; removed keys drop their
 * line(s); new keys are inserted after the section's last content line.
 */
function applyEditsToSection(doc: SmbConfDoc, sectionName: string, edits: KeyEdit[], indent: string): void {
  const span = findSection(doc, sectionName)
  if (!span)
    return

  const toInsert: string[] = []
  const removals: { first: number, last: number }[] = []
  const replacements: { line: number, value: string }[] = []

  for (const edit of edits) {
    const loc = findKeyLine(doc, span, edit.norm)
    if (edit.value === null) {
      if (loc)
        removals.push(loc)
      continue
    }
    if (loc) {
      // Rewrite the value on the key's first line; drop any continuation lines.
      replacements.push({ line: loc.first, value: edit.value })
      if (loc.last > loc.first)
        removals.push({ first: loc.first + 1, last: loc.last })
    }
    else {
      toInsert.push(`${indent}${edit.canonical} = ${edit.value}`)
    }
  }

  // Apply value replacements (single-line, index-stable).
  for (const r of replacements)
    doc.lines[r.line] = replaceValue(doc.lines[r.line], r.value)

  // Apply removals bottom-up so indices stay valid.
  removals.sort((a, b) => b.first - a.first)
  for (const r of removals)
    doc.lines.splice(r.first, r.last - r.first + 1)

  // Insert new keys after the section's last content line (before trailing blanks).
  if (toInsert.length > 0) {
    const fresh = findSection(doc, sectionName)! // indices shifted by removals
    let insertAt = fresh.headerIndex !== null ? fresh.headerIndex + 1 : fresh.start
    for (let i = fresh.start; i < fresh.end; i++) {
      if (i === fresh.headerIndex)
        continue
      if (content(doc.lines[i]).trim() !== '')
        insertAt = i + 1
    }
    doc.lines.splice(insertAt, 0, ...toInsert)
  }
}

/** Build the ordered key edits for the mutable SMB share fields present in `req`. */
function shareEdits(req: UpdateSmbShareRequest | CreateSmbShareRequest): KeyEdit[] {
  const edits: KeyEdit[] = []
  const push = (norm: string, canonical: string, value: string | null) => edits.push({ norm, canonical, value })

  if ('path' in req && req.path !== undefined)
    push('path', 'path', req.path)
  if (req.comment !== undefined)
    push('comment', 'comment', req.comment === null ? null : req.comment)
  if (req.browseable !== undefined)
    push('browseable', 'browseable', boolStr(req.browseable))
  if (req.readOnly !== undefined)
    push('readonly', 'read only', boolStr(req.readOnly))
  if (req.guestOk !== undefined)
    push('guestok', 'guest ok', boolStr(req.guestOk))
  if (req.validUsers !== undefined)
    push('validusers', 'valid users', req.validUsers.length ? req.validUsers.join(' ') : null)
  if (req.hostsAllow !== undefined)
    push('hostsallow', 'hosts allow', req.hostsAllow.length ? req.hostsAllow.join(' ') : null)
  if (req.hostsDeny !== undefined)
    push('hostsdeny', 'hosts deny', req.hostsDeny.length ? req.hostsDeny.join(' ') : null)

  return edits
}

/** Render a brand-new share stanza (no surrounding blank lines). */
function renderStanza(req: CreateSmbShareRequest, indent: string): string {
  const lines = [`[${req.name}]`]
  const add = (canonical: string, value: string) => lines.push(`${indent}${canonical} = ${value}`)

  add('path', req.path)
  if (req.comment !== undefined && req.comment !== null && req.comment !== '')
    add('comment', req.comment)
  // Near-zero-typing defaults (DESIGN 5d): browseable=yes, read-only=no, guest=no.
  add('browseable', boolStr(req.browseable ?? true))
  add('read only', boolStr(req.readOnly ?? false))
  add('guest ok', boolStr(req.guestOk ?? false))
  if (req.validUsers && req.validUsers.length)
    add('valid users', req.validUsers.join(' '))
  if (req.hostsAllow && req.hostsAllow.length)
    add('hosts allow', req.hostsAllow.join(' '))
  if (req.hostsDeny && req.hostsDeny.length)
    add('hosts deny', req.hostsDeny.join(' '))

  return lines.join('\n')
}

/**
 * Add a new share stanza to the file. Appends at the end so every existing byte
 * is preserved verbatim; a blank separator line precedes the stanza. Assumes the
 * caller has already checked the share does not exist (409 otherwise).
 */
export function addShare(text: string, req: CreateSmbShareRequest): string {
  const stanza = renderStanza(req, '\t')
  if (text === '')
    return `${stanza}\n`

  let prefix = text
  if (!prefix.endsWith('\n'))
    prefix += '\n'
  return `${prefix}\n${stanza}\n`
}

/**
 * Update only the changed keys of an existing share, leaving every other line
 * (and every other section) byte-identical. Returns the text unchanged if the
 * share is absent.
 */
export function updateShare(text: string, name: string, req: UpdateSmbShareRequest): string {
  const doc = parseDoc(text)
  const span = findSection(doc, name)
  if (!span || span.key === 'global')
    return text
  applyEditsToSection(doc, name, shareEdits(req), sectionIndent(doc, span))
  return serializeDoc(doc)
}

/**
 * Remove a share stanza (header + its body + its trailing blank lines up to the
 * next section). Every other section is preserved verbatim.
 */
export function removeShare(text: string, name: string): string {
  const doc = parseDoc(text)
  const span = findSection(doc, name)
  if (!span || span.key === 'global')
    return text
  doc.lines.splice(span.start, span.end - span.start)
  return serializeDoc(doc)
}

/** Build the ordered key edits for the mutable `[global]` fields present in `req`. */
function globalEdits(req: UpdateSmbGlobalConfigRequest): KeyEdit[] {
  const edits: KeyEdit[] = []
  const push = (norm: string, canonical: string, value: string | null) => edits.push({ norm, canonical, value })

  if (req.workgroup !== undefined)
    push('workgroup', 'workgroup', req.workgroup)
  if (req.serverString !== undefined)
    push('serverstring', 'server string', req.serverString)
  if (req.interfaces !== undefined)
    push('interfaces', 'interfaces', req.interfaces.length ? req.interfaces.join(' ') : null)
  if (req.bindInterfacesOnly !== undefined)
    push('bindinterfacesonly', 'bind interfaces only', boolStr(req.bindInterfacesOnly))

  return edits
}

/**
 * Update only the changed keys of the `[global]` section, creating the section
 * (prepended) if it does not yet exist. Everything else is preserved verbatim.
 */
export function updateGlobal(text: string, req: UpdateSmbGlobalConfigRequest): string {
  const edits = globalEdits(req)
  if (edits.length === 0)
    return text

  let workingText = text
  let doc = parseDoc(workingText)
  if (!findSection(doc, 'global')) {
    // Prepend a [global] header (with a blank separator before existing content)
    // so the new keys have a home. Existing lines shift down, unchanged.
    workingText = text === '' ? '[global]\n' : `[global]\n\n${text}`
    doc = parseDoc(workingText)
  }
  const span = findSection(doc, 'global')!
  applyEditsToSection(doc, 'global', edits, sectionIndent(doc, span))
  return serializeDoc(doc)
}
