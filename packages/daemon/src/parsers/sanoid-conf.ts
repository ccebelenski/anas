/**
 * Round-trip parser + surgical editor for sanoid's `/etc/sanoid/sanoid.conf`
 * (Epic 17; SCHEDULES-GT-5..9). sanoid.conf is an INI file:
 *
 *   [version]              — `version = 2`
 *   [template_<name>]      — a named retention/behaviour template
 *   [pool/dataset]         — a per-dataset stanza (path has NO leading slash)
 *
 * with `key = value` settings (tab OR space indent — cosmetic), `#` full-line
 * and trailing comments, `use_template = a,b` comma-lists (order-significant),
 * inline per-stanza overrides, and `recursive = yes | zfs`.
 *
 * ── Round-trip fidelity (Principle 12: we are a guest, never reformat) ──
 * The file is held as its ORIGINAL array of lines; nothing is regenerated from
 * the model. Every mutation splices the line array and carries untouched lines
 * through verbatim, so `serializeSanoidDoc(parseSanoidDoc(text)) === text`
 * byte-for-byte for ANY input — comments, ordering, whitespace, tabs, stanza
 * order, and UNKNOWN directives are preserved automatically. (sanoid rejects an
 * unknown key FATALLY at runtime — SCHEDULES-GT-9 — but a config we do not own
 * may legitimately carry one; we preserve it on read and refuse to EMIT one on
 * write. Same guest idiom as fstab.ts / smb-conf.ts / exports.ts.)
 *
 * The typed helpers layer on top: `parseSanoidConf` builds the shared
 * SanoidConfig read-model; `resolveEffectivePolicy` resolves a dataset's
 * effective values through the defaults/template/override chain (GT-8); the
 * `sanoidKeyWhitelist` / `validateSettingsForWrite` pair enforces GT-9 on write;
 * and the surgical editors touch only the target stanza/key.
 */

import type {
  SanoidConfig,
  SanoidDataset,
  SanoidEffectivePolicy,
  SanoidRecursive,
  SanoidRetention,
  SanoidSettings,
  SanoidTemplate,
  SanoidUnknownSetting,
} from '@anas/shared'

/** `[stanza]` header (whole trimmed line). */
const STANZA_HEADER_RE = /^\[(.+)\]\s*$/
/** Leading whitespace of a line (the stanza's indent). */
const LEADING_WS_RE = /^\s*/
/** Single whitespace char — the token boundary before an inline `#` comment. */
const WS_CHAR = /\s/
/** The `template_` prefix that marks a template stanza. */
const TEMPLATE_PREFIX = 'template_'

/**
 * Thrown by the write path when a setting key is not in sanoid's whitelist
 * (SCHEDULES-GT-9). Emitting it would make sanoid exit 255 and break every
 * dataset's snapshots, so ANAS refuses before serializing. `keys` lists every
 * offending setting.
 */
export class SanoidUnknownKeyError extends Error {
  constructor(public readonly keys: string[]) {
    super(`sanoid would reject unknown setting(s): ${keys.join(', ')} (not in sanoid.defaults.conf whitelist)`)
    this.name = 'SanoidUnknownKeyError'
  }
}

// ============================================================================
// Low-level line model — the round-trip substrate.
// ============================================================================

/** What class of stanza a header names. */
export type StanzaKind = 'preamble' | 'version' | 'template' | 'dataset'

/** A parsed stanza span over the original `lines` array. */
export interface StanzaSpan {
  kind: StanzaKind
  /** Raw header text inside the brackets, or null for the preamble. */
  header: string | null
  /** Template name (after `template_`) or dataset path; null for version/preamble. */
  name: string | null
  /** Index of the `[header]` line, or null for the preamble. */
  headerIndex: number | null
  /** First line index of the stanza (the header line, or 0 for the preamble). */
  start: number
  /** One past the last line index of the stanza (exclusive). */
  end: number
}

/** The whole file as its original lines plus the stanza overlay. */
export interface SanoidConfDoc {
  lines: string[]
  stanzas: StanzaSpan[]
}

/** Strip a single trailing CR so CRLF files interpret cleanly (kept on write). */
function content(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** Does the trimmed line begin a full-line comment? */
function isComment(trimmed: string): boolean {
  return trimmed.startsWith('#')
}

/** A `[stanza]` header line → the raw header text, else null. */
function stanzaHeader(line: string): string | null {
  const trimmed = content(line).trim()
  if (!trimmed || isComment(trimmed))
    return null
  const m = STANZA_HEADER_RE.exec(trimmed)
  return m ? m[1].trim() : null
}

/** Classify a header into its stanza kind + name. */
function classifyHeader(header: string): { kind: StanzaKind, name: string | null } {
  if (header === 'version')
    return { kind: 'version', name: null }
  if (header.startsWith(TEMPLATE_PREFIX))
    return { kind: 'template', name: header.slice(TEMPLATE_PREFIX.length) }
  return { kind: 'dataset', name: header }
}

/**
 * The index of a `#` that BEGINS an inline trailing comment — one at column 0 or
 * immediately preceded by whitespace (so it starts its own token). A `#` inside
 * a value token is data, not a comment. Returns -1 when there is no trailing
 * comment. (Same rule as fstab's inlineCommentIndex.)
 */
function inlineCommentIndex(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || WS_CHAR.test(s[i - 1])))
      return i
  }
  return -1
}

/**
 * Split a `key = value` line into its parts, or null if it is not one. The
 * value has any inline trailing comment stripped and is trimmed; the key is
 * trimmed (sanoid keys are lower-case as shipped — not case-folded here).
 */
function parseSettingLine(line: string): { key: string, value: string } | null {
  const body = content(line)
  const trimmed = body.trim()
  if (!trimmed || isComment(trimmed) || trimmed.startsWith('['))
    return null
  const eq = trimmed.indexOf('=')
  if (eq === -1)
    return null
  const key = trimmed.slice(0, eq).trim()
  if (!key)
    return null
  let value = trimmed.slice(eq + 1)
  const hash = inlineCommentIndex(value)
  if (hash !== -1)
    value = value.slice(0, hash)
  return { key, value: value.trim() }
}

/**
 * Parse the file text into the round-trip document model. Never loses data:
 * `lines` is exactly `text.split('\n')`, so `join('\n')` reconstructs `text`.
 */
export function parseSanoidDoc(text: string): SanoidConfDoc {
  const lines = text.split('\n')

  const headers: { index: number, header: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const header = stanzaHeader(lines[i])
    if (header !== null)
      headers.push({ index: i, header })
  }

  const stanzas: StanzaSpan[] = []
  if (headers.length === 0) {
    if (text.length > 0)
      stanzas.push({ kind: 'preamble', header: null, name: null, headerIndex: null, start: 0, end: lines.length })
    return { lines, stanzas }
  }

  // Leading preamble before the first header.
  if (headers[0].index > 0)
    stanzas.push({ kind: 'preamble', header: null, name: null, headerIndex: null, start: 0, end: headers[0].index })

  for (let h = 0; h < headers.length; h++) {
    const start = headers[h].index
    const end = h + 1 < headers.length ? headers[h + 1].index : lines.length
    const { kind, name } = classifyHeader(headers[h].header)
    stanzas.push({ kind, header: headers[h].header, name, headerIndex: start, start, end })
  }

  return { lines, stanzas }
}

/** Reconstruct the file text from the document model (byte-for-byte on no-op). */
export function serializeSanoidDoc(doc: SanoidConfDoc): string {
  return doc.lines.join('\n')
}

/** Find a stanza span by its exact header text, or null. */
function findStanza(doc: SanoidConfDoc, header: string): StanzaSpan | null {
  return doc.stanzas.find(s => s.header === header) ?? null
}

/**
 * Collect a stanza's effective `key → value` map (last definition wins, joining
 * nothing — sanoid has no continuation lines). Comments/blanks are skipped.
 */
export function stanzaSettings(doc: SanoidConfDoc, span: StanzaSpan): SanoidSettings {
  const out: Record<string, string> = {}
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    const parsed = parseSettingLine(doc.lines[i])
    if (parsed)
      out[parsed.key] = parsed.value
  }
  return out
}

// ============================================================================
// Value <-> sanoid.conf coercion helpers.
// ============================================================================

/** Parse a retention/count value; non-numeric or absent → 0 (sanoid's off/prune). */
function toCount(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

/** Parse a sanoid boolean: `yes`/`true`/`on`/`1` → true; anything else → false. */
function toBool(value: string | undefined): boolean {
  if (value === undefined)
    return false
  const v = value.trim().toLowerCase()
  return v === 'yes' || v === 'true' || v === 'on' || v === '1'
}

/** Interpret a `recursive =` value: `yes` or `zfs`, else undefined. */
function toRecursive(value: string | undefined): SanoidRecursive | undefined {
  if (value === 'yes' || value === 'zfs')
    return value
  return undefined
}

/** Split a `use_template = a, b` value into template names, in listed order. */
function parseUseTemplate(value: string | undefined): string[] {
  if (!value)
    return []
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

// ============================================================================
// Typed read-model (SanoidConfig) built from the document.
// ============================================================================

/** Build a SanoidTemplate from a template stanza span. */
function toTemplate(doc: SanoidConfDoc, span: StanzaSpan): SanoidTemplate {
  return { name: span.name as string, settings: stanzaSettings(doc, span) }
}

/** Build a SanoidDataset from a dataset stanza span. */
function toDataset(doc: SanoidConfDoc, span: StanzaSpan): SanoidDataset {
  const settings = stanzaSettings(doc, span)
  const dataset: SanoidDataset = {
    dataset: span.name as string,
    useTemplate: parseUseTemplate(settings.use_template),
    settings,
  }
  const recursive = toRecursive(settings.recursive)
  if (recursive !== undefined)
    dataset.recursive = recursive
  return dataset
}

/** Parse sanoid.conf text into the typed version + templates + datasets model. */
export function parseSanoidConf(text: string): SanoidConfig {
  const doc = parseSanoidDoc(text)
  const templates: SanoidTemplate[] = []
  const datasets: SanoidDataset[] = []
  let version: string | undefined

  for (const span of doc.stanzas) {
    if (span.kind === 'version')
      version = stanzaSettings(doc, span).version
    else if (span.kind === 'template')
      templates.push(toTemplate(doc, span))
    else if (span.kind === 'dataset')
      datasets.push(toDataset(doc, span))
  }

  const config: SanoidConfig = { templates, datasets }
  if (version !== undefined)
    config.version = version
  return config
}

/** Return one template by name, or null. */
export function getTemplate(text: string, name: string): SanoidTemplate | null {
  const doc = parseSanoidDoc(text)
  const span = findStanza(doc, `${TEMPLATE_PREFIX}${name}`)
  return span && span.kind === 'template' ? toTemplate(doc, span) : null
}

/** Return one dataset stanza by path, or null. */
export function getDataset(text: string, dataset: string): SanoidDataset | null {
  const doc = parseSanoidDoc(text)
  const span = findStanza(doc, dataset)
  return span && span.kind === 'dataset' ? toDataset(doc, span) : null
}

/** Is there a `[template_<name>]` stanza? */
export function hasTemplate(text: string, name: string): boolean {
  const span = findStanza(parseSanoidDoc(text), `${TEMPLATE_PREFIX}${name}`)
  return span !== null && span.kind === 'template'
}

/** Is there a `[pool/dataset]` stanza for this path? */
export function hasDataset(text: string, dataset: string): boolean {
  const span = findStanza(parseSanoidDoc(text), dataset)
  return span !== null && span.kind === 'dataset'
}

// ============================================================================
// Whitelist (SCHEDULES-GT-9) — sourced from the shipped sanoid.defaults.conf.
// ============================================================================

/**
 * Derive sanoid's legal setting keys from the shipped `sanoid.defaults.conf`:
 * its `[template_default]` stanza IS the whitelist (the file says so — "we use
 * the defaults file as our list of allowable settings"). Sourcing it from the
 * fixture rather than a hand-maintained list means the whitelist tracks the
 * installed package and never drifts.
 */
export function sanoidKeyWhitelist(defaultsConfText: string): Set<string> {
  const doc = parseSanoidDoc(defaultsConfText)
  const span = doc.stanzas.find(s => s.kind === 'template' && s.name === 'default')
  return new Set(span ? Object.keys(stanzaSettings(doc, span)) : [])
}

/** The `[template_default]` settings shipped in sanoid.defaults.conf. */
function defaultSettings(defaultsConfText: string): SanoidSettings {
  const doc = parseSanoidDoc(defaultsConfText)
  const span = doc.stanzas.find(s => s.kind === 'template' && s.name === 'default')
  return span ? stanzaSettings(doc, span) : {}
}

/**
 * Every setting key in `text` (across template + dataset stanzas) that is NOT in
 * the whitelist. On READ the parser preserves these verbatim; this surfaces them
 * so the screen can WARN rather than silently drop them (GT-9). Ordered by file
 * appearance.
 */
export function findUnrecognizedKeys(text: string, whitelist: Set<string>): SanoidUnknownSetting[] {
  const doc = parseSanoidDoc(text)
  const out: SanoidUnknownSetting[] = []
  for (const span of doc.stanzas) {
    if (span.kind !== 'template' && span.kind !== 'dataset')
      continue
    for (const key of Object.keys(stanzaSettings(doc, span))) {
      if (!whitelist.has(key))
        out.push({ stanza: span.header as string, key })
    }
  }
  return out
}

/**
 * Refuse to write any setting sanoid would reject (GT-9). Throws
 * SanoidUnknownKeyError listing every key not in the whitelist. `use_template`
 * and `recursive` are legitimate keys (present in sanoid.defaults.conf), so they
 * pass.
 */
export function validateSettingsForWrite(settings: SanoidSettings, whitelist: Set<string>): void {
  const bad = Object.keys(settings).filter(k => !whitelist.has(k))
  if (bad.length > 0)
    throw new SanoidUnknownKeyError(bad)
}

// ============================================================================
// Effective-value resolution (SCHEDULES-GT-8).
// ============================================================================

/**
 * Resolve a dataset's effective policy through the full chain, in ascending
 * precedence (later overrides earlier):
 *
 *   1. shipped `sanoid.defaults.conf` `[template_default]`
 *   2. local `[template_default]` in this config (if present)
 *   3. each template named in `use_template =`, IN LISTED ORDER (later wins —
 *      confirmed by the shipped example: `use_template = production,demo` has
 *      demo's `daily` override production's)
 *   4. inline stanza overrides (highest precedence)
 *
 * Returns both the fully merged raw settings and the typed projections
 * (retention counts, autosnap/autoprune, recursive) the policy grid needs.
 */
export function resolveEffectivePolicy(
  text: string,
  dataset: string,
  defaultsConfText: string,
): SanoidEffectivePolicy {
  const doc = parseSanoidDoc(text)

  // 1. shipped defaults.
  const merged: Record<string, string> = { ...defaultSettings(defaultsConfText) }

  // 2. local [template_default].
  const localDefault = findStanza(doc, `${TEMPLATE_PREFIX}default`)
  if (localDefault)
    Object.assign(merged, stanzaSettings(doc, localDefault))

  // The dataset stanza (may be absent — then only defaults apply).
  const dsSpan = findStanza(doc, dataset)
  const dsSettings = dsSpan && dsSpan.kind === 'dataset' ? stanzaSettings(doc, dsSpan) : {}
  const templates = parseUseTemplate(dsSettings.use_template)

  // 3. use_template chain, in listed order (later wins).
  for (const name of templates) {
    const tSpan = findStanza(doc, `${TEMPLATE_PREFIX}${name}`)
    if (tSpan && tSpan.kind === 'template')
      Object.assign(merged, stanzaSettings(doc, tSpan))
  }

  // 4. inline overrides (excluding the structural `use_template`, which is not a
  // policy value — it drove the chain above).
  for (const [key, value] of Object.entries(dsSettings)) {
    if (key !== 'use_template')
      merged[key] = value
  }

  const retention: SanoidRetention = {
    frequently: toCount(merged.frequently),
    hourly: toCount(merged.hourly),
    daily: toCount(merged.daily),
    weekly: toCount(merged.weekly),
    monthly: toCount(merged.monthly),
    yearly: toCount(merged.yearly),
  }

  const policy: SanoidEffectivePolicy = {
    dataset,
    templates,
    retention,
    autosnap: toBool(merged.autosnap),
    autoprune: toBool(merged.autoprune),
    settings: merged,
  }
  const recursive = toRecursive(merged.recursive)
  if (recursive !== undefined)
    policy.recursive = recursive
  return policy
}

// ============================================================================
// Surgical editors — each returns new text, changing ONLY the target stanza
// (and, within it, only the target keys). All other bytes pass through verbatim.
// ============================================================================

/** A single key edit within a stanza. `value: null` REMOVES the key. */
interface KeyEdit {
  key: string
  value: string | null
}

/** Detect the leading whitespace used by a stanza's settings (default a tab). */
function stanzaIndent(doc: SanoidConfDoc, span: StanzaSpan): string {
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    if (parseSettingLine(doc.lines[i])) {
      const m = LEADING_WS_RE.exec(content(doc.lines[i]))
      return m ? m[0] : '\t'
    }
  }
  return '\t'
}

/** The LAST line index defining `key` in a stanza (sanoid precedence), or -1. */
function findKeyLine(doc: SanoidConfDoc, span: StanzaSpan, key: string): number {
  let found = -1
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    const parsed = parseSettingLine(doc.lines[i])
    if (parsed && parsed.key === key)
      found = i
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
  let i = eq + 1
  while (i < body.length && (body[i] === ' ' || body[i] === '\t'))
    i++
  return `${body.slice(0, i)}${value}${cr}`
}

/**
 * Apply key edits to one stanza, splicing `doc.lines` in place. Existing keys
 * have only their value line rewritten; removed keys drop their line; new keys
 * are inserted after the stanza's last content line.
 */
function applyEditsToStanza(doc: SanoidConfDoc, header: string, edits: KeyEdit[], indent: string): void {
  const span = findStanza(doc, header)
  if (!span)
    return

  const toInsert: string[] = []
  const removals: number[] = []
  const replacements: { line: number, value: string }[] = []

  for (const edit of edits) {
    const loc = findKeyLine(doc, span, edit.key)
    if (edit.value === null) {
      if (loc !== -1)
        removals.push(loc)
      continue
    }
    if (loc !== -1)
      replacements.push({ line: loc, value: edit.value })
    else
      toInsert.push(`${indent}${edit.key} = ${edit.value}`)
  }

  for (const r of replacements)
    doc.lines[r.line] = replaceValue(doc.lines[r.line], r.value)

  removals.sort((a, b) => b - a)
  for (const line of removals)
    doc.lines.splice(line, 1)

  if (toInsert.length > 0) {
    const fresh = findStanza(doc, header)! // indices shifted by removals
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

/**
 * Set (or, with `value: null`, remove) ONE setting in an existing stanza,
 * leaving every other line byte-identical. `header` is the exact stanza header
 * (`tank/media` or `template_foo`). A whitelist may be supplied to refuse a key
 * sanoid would reject (GT-9). Returns the text unchanged if the stanza is
 * absent.
 */
export function setSetting(
  text: string,
  header: string,
  key: string,
  value: string | null,
  whitelist?: Set<string>,
): string {
  if (whitelist && value !== null)
    validateSettingsForWrite({ [key]: value }, whitelist)
  const doc = parseSanoidDoc(text)
  const span = findStanza(doc, header)
  if (!span)
    return text
  applyEditsToStanza(doc, header, [{ key, value }], stanzaIndent(doc, span))
  return serializeSanoidDoc(doc)
}

/** Render a brand-new stanza (`[header]` + indented settings), no surrounding blanks. */
function renderStanza(header: string, settings: SanoidSettings, indent: string): string {
  const lines = [`[${header}]`]
  for (const [key, value] of Object.entries(settings))
    lines.push(`${indent}${key} = ${value}`)
  return lines.join('\n')
}

/**
 * Append a new stanza to the file, preserving every existing byte verbatim; a
 * blank separator line precedes it. Assumes the caller has checked it does not
 * already exist.
 */
function addStanza(text: string, header: string, settings: SanoidSettings, whitelist?: Set<string>): string {
  if (whitelist)
    validateSettingsForWrite(settings, whitelist)
  const stanza = renderStanza(header, settings, '\t')
  if (text === '')
    return `${stanza}\n`
  let prefix = text
  if (!prefix.endsWith('\n'))
    prefix += '\n'
  return `${prefix}\n${stanza}\n`
}

/**
 * Add a new `[pool/dataset]` stanza. `settings` may include `use_template`,
 * `recursive`, and inline overrides. A whitelist (if given) refuses keys sanoid
 * would reject before writing (GT-9).
 */
export function addDataset(text: string, dataset: string, settings: SanoidSettings, whitelist?: Set<string>): string {
  return addStanza(text, dataset, settings, whitelist)
}

/** Add a new `[template_<name>]` stanza (whitelist-guarded when supplied). */
export function addTemplate(text: string, name: string, settings: SanoidSettings, whitelist?: Set<string>): string {
  return addStanza(text, `${TEMPLATE_PREFIX}${name}`, settings, whitelist)
}

/**
 * Remove a stanza (header + its body + trailing blank lines up to the next
 * stanza). Every other stanza is preserved verbatim. No-op if absent.
 */
function removeStanza(text: string, header: string): string {
  const doc = parseSanoidDoc(text)
  const span = findStanza(doc, header)
  if (!span || span.kind === 'preamble')
    return text
  doc.lines.splice(span.start, span.end - span.start)
  return serializeSanoidDoc(doc)
}

/** Remove a `[pool/dataset]` stanza. No-op if absent. */
export function removeDataset(text: string, dataset: string): string {
  return removeStanza(text, dataset)
}

/** Remove a `[template_<name>]` stanza. No-op if absent. */
export function removeTemplate(text: string, name: string): string {
  return removeStanza(text, `${TEMPLATE_PREFIX}${name}`)
}
