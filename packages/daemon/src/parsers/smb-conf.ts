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

import type { CreateSmbShareRequest, RecyclePurgeDays, SmbGlobalConfig, SmbShare, UpdateSmbGlobalConfigRequest, UpdateSmbShareRequest } from '@anas/shared'
import { RetentionBucket } from '@anas/shared'

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
  return { lines, sections: computeSections(lines) }
}

/**
 * Build the section overlay for a line array.
 *
 * Spans are INDEXES into `lines`, so they go stale the moment the array is
 * spliced. Any editor that adds or removes lines must recompute them (see
 * `reindexSections`) before using a span again — a stale `end` is how an insert
 * lands in the NEXT stanza (issue #36).
 */
function computeSections(lines: string[]): SectionSpan[] {
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
    // `''.split('\n')` is `['']` — an empty file has no section at all.
    if (lines.length > 1 || lines[0] !== '')
      sections.push({ name: null, key: null, headerIndex: null, start: 0, end: lines.length })
    return sections
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

  return sections
}

/** Recompute the section overlay after `doc.lines` has been spliced. */
function reindexSections(doc: SmbConfDoc): void {
  doc.sections = computeSections(doc.lines)
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

/** One `key = value` definition inside a section (continuation lines folded in). */
interface KeyDef {
  /** Normalised parameter name (case- and space-folded). */
  key: string
  /** Value, with trailing-backslash continuation lines joined in. */
  value: string
  /** Index of the `key =` line. */
  first: number
  /** Index of its last continuation line (=== `first` when there is none). */
  last: number
}

/**
 * Every parameter definition in a section, IN FILE ORDER, with continuation
 * lines folded into the value (and skipped by the scan, so a continuation that
 * happens to contain `=` is never mistaken for a parameter).
 *
 * This is the one place lines are interpreted: both the read-models and the
 * surgical editor work from it, so what ANAS shows and what ANAS edits can
 * never disagree.
 */
function sectionDefs(doc: SmbConfDoc, span: SectionSpan): KeyDef[] {
  const defs: KeyDef[] = []
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    const parsed = parseKeyLine(doc.lines[i])
    if (!parsed)
      continue
    let value = parsed.value
    let last = i
    // Absorb continuation lines (value ends in `\`).
    while (isContinued(doc.lines[last]) && last + 1 < span.end) {
      value = `${value.slice(0, -1)} ${content(doc.lines[last + 1]).trim()}`
      last++
    }
    defs.push({ key: parsed.key, value: value.trim(), first: i, last })
    i = last
  }
  return defs
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
// The parameter table — Samba's documented synonyms, in ONE place.
//
// Samba parameter names are case- and space-insensitive AND several have
// documented synonyms ("hosts allow" ≡ "allow hosts") or inverted synonyms
// ("read only" ≡ NOT "writeable"). Reading and editing consult this same table,
// so a stanza spelled the alternate way is read correctly AND edited in place —
// never shadowed by a second, canonically-spelled line (issue #42).
// ============================================================================

/** A managed parameter: how ANAS writes it, and every spelling Samba accepts. */
interface SmbParam {
  /** Canonical spelling used when a new line is inserted. */
  canonical: string
  /** Normalised spellings that mean this parameter. */
  norms: string[]
  /** Normalised spellings whose value is the INVERSE of this parameter. */
  inverse?: string[]
  /**
   * What Samba does when the parameter is absent. It is the read fallback, and
   * it also means an edit that asks for exactly this need not write a line: a
   * stanza that relies on the default keeps relying on it.
   */
  unset?: string
}

const PARAM = {
  // `directory` is a documented synonym of `path`.
  path: { canonical: 'path', norms: ['path', 'directory'] },
  comment: { canonical: 'comment', norms: ['comment'] },
  // `browsable` is the alternate spelling of `browseable`.
  browseable: { canonical: 'browseable', norms: ['browseable', 'browsable'], unset: 'yes' },
  // `writeable`/`writable`/`write ok` are inverted synonyms of `read only`.
  readOnly: { canonical: 'read only', norms: ['readonly'], inverse: ['writeable', 'writable', 'writeok'], unset: 'yes' },
  // `public` is a synonym of `guest ok`.
  guestOk: { canonical: 'guest ok', norms: ['guestok', 'public'], unset: 'no' },
  validUsers: { canonical: 'valid users', norms: ['validusers'] },
  // `allow hosts` / `deny hosts` are synonyms of `hosts allow` / `hosts deny`.
  hostsAllow: { canonical: 'hosts allow', norms: ['hostsallow', 'allowhosts'] },
  hostsDeny: { canonical: 'hosts deny', norms: ['hostsdeny', 'denyhosts'] },
  workgroup: { canonical: 'workgroup', norms: ['workgroup'] },
  serverString: { canonical: 'server string', norms: ['serverstring'] },
  interfaces: { canonical: 'interfaces', norms: ['interfaces'] },
  bindInterfacesOnly: { canonical: 'bind interfaces only', norms: ['bindinterfacesonly'], unset: 'no' },
  // ── Self-service features (smbsvc.1–3). The `vfs objects` line is COMPOSED
  // from the enabled feature set (composeVfsObjects below) — never hand-merged.
  // Keys are case- and space-insensitive like every parameter ("fruit:time
  // machine" ≡ "fruit:timemachine"), so the norms fold the spaces out.
  // Deliberately NO `unset` defaults: enabling writes the complete key set
  // even where a value equals Samba's default (the stanza is the proof of
  // ownership, and "relying on the default" would leave a half-written shape).
  vfsObjects: { canonical: 'vfs objects', norms: ['vfsobjects'] },
  shadowSnapdir: { canonical: 'shadow:snapdir', norms: ['shadow:snapdir'] },
  shadowSnapdirseverywhere: { canonical: 'shadow:snapdirseverywhere', norms: ['shadow:snapdirseverywhere'] },
  shadowLocaltime: { canonical: 'shadow:localtime', norms: ['shadow:localtime'] },
  shadowSort: { canonical: 'shadow:sort', norms: ['shadow:sort'] },
  shadowFormat: { canonical: 'shadow:format', norms: ['shadow:format'] },
  recycleRepository: { canonical: 'recycle:repository', norms: ['recycle:repository'] },
  recycleKeeptree: { canonical: 'recycle:keeptree', norms: ['recycle:keeptree'] },
  recycleVersions: { canonical: 'recycle:versions', norms: ['recycle:versions'] },
  recycleTouch: { canonical: 'recycle:touch', norms: ['recycle:touch'] },
  fruitTimeMachine: { canonical: 'fruit:time machine', norms: ['fruit:timemachine'] },
  fruitTimeMachineMaxSize: { canonical: 'fruit:time machine max size', norms: ['fruit:timemachinemaxsize'] },
} as const satisfies Record<string, SmbParam>

/** One definition of a parameter, flagged when it uses an inverted spelling. */
interface ParamHit {
  def: KeyDef
  /** The line spells the INVERSE parameter (`writeable` for `read only`). */
  inverted: boolean
}

/** Every definition of a parameter in a section, any spelling, in file order. */
function paramHits(defs: KeyDef[], param: SmbParam): ParamHit[] {
  const hits: ParamHit[] = []
  for (const def of defs) {
    if (param.norms.includes(def.key))
      hits.push({ def, inverted: false })
    else if (param.inverse?.includes(def.key))
      hits.push({ def, inverted: true })
  }
  return hits
}

/** Flip a boolean value string (for inverted synonyms). */
function invertBool(value: string): string {
  return boolStr(!parseBool(value, false))
}

/**
 * The EFFECTIVE value of a parameter, in this parameter's own sense: Samba
 * takes the LAST definition in the section whatever spelling it used, so we do
 * too. `undefined` = the section never sets it.
 */
function paramValue(defs: KeyDef[], param: SmbParam): string | undefined {
  const hit = paramHits(defs, param).at(-1)
  if (!hit)
    return undefined
  return hit.inverted ? invertBool(hit.def.value) : hit.def.value
}

/** A boolean parameter's value, falling back to what Samba does when it is unset. */
function paramBool(defs: KeyDef[], param: SmbParam): boolean {
  const fallback = parseBool(param.unset, false)
  return parseBool(paramValue(defs, param) ?? param.unset, fallback)
}

// ============================================================================
// Self-service features (smbsvc.1–3) — the `vfs objects` COMPOSER + managed
// feature keys + the recycle purge marker. DESIGN "Self-service on SMB shares".
// ============================================================================

/** `recycle:repository` — the bin name users know, visible at the share root. */
export const RECYCLE_REPOSITORY = '#recycle'

/**
 * The `# anas:recycle-purge-days = <n>` marker (the fstab `#ANAS` pattern): the
 * purge age lives IN the stanza — the config file stays the one store (P.11).
 */
const PURGE_MARKER_RE = /^#\s*anas:recycle-purge-days\s*=(.*)$/
const SHADOW_FORMAT_RE = /^anas-([a-z]+)-%Y-%m-%dT%H%M%SZ$/
const DIGITS_RE = /^\d+$/
/** `fruit:time machine max size`: `<n>[M|G|T]` (Samba's size suffixes; bare = bytes). */
const MAX_SIZE_RE = /^(\d+)([MGT])?$/i

/**
 * The enabled-features → `vfs objects` module list. ONE composer for all
 * three features (smbsvc.2/.3 reuse it); the order is ground-truthed on
 * Samba 4.22 (catia/fruit/streams_xattr ride together for Time Machine).
 * `null` = no feature on → the line is REMOVED, never left empty.
 */
export function composeVfsObjects(features: {
  previousVersions?: boolean
  recycle?: boolean
  timeMachine?: boolean
}): string | null {
  const modules: string[] = []
  if (features.timeMachine)
    modules.push('catia', 'fruit', 'streams_xattr')
  if (features.previousVersions)
    modules.push('shadow_copy2')
  if (features.recycle)
    modules.push('recycle')
  return modules.length > 0 ? modules.join(' ') : null
}

/** `shadow:format` for a schedule bucket: `anas-<bucket>-%Y-%m-%dT%H%M%SZ`. */
export function shadowFormatFor(bucket: string): string {
  return `anas-${bucket}-%Y-%m-%dT%H%M%SZ`
}

// ── `fruit:time machine max size` (smbsvc.3) ──
// Samba reads the value as a byte count with a size suffix; its units are
// binary (M = MiB, G = GiB, T = TiB), and a value of 0 means UNLIMITED —
// which is exactly what the cap exists to prevent, so neither direction ever
// produces a zero.

const MIB = 1024 ** 2
const GIB = 1024 ** 3
const TIB = 1024 ** 4

/**
 * A byte cap → the stanza value: the LARGEST unit that divides it exactly,
 * else MiB rounded down. A positive cap that rounds below one MiB writes
 * `1M` rather than `0M` — `0M` would lift the cap (Samba reads 0 as
 * unlimited), the one direction rounding must never drift into.
 */
export function formatMaxSize(bytes: number): string {
  if (bytes % TIB === 0)
    return `${bytes / TIB}T`
  if (bytes % GIB === 0)
    return `${bytes / GIB}G`
  if (bytes % MIB === 0)
    return `${bytes / MIB}M`
  return `${Math.max(1, Math.floor(bytes / MIB))}M`
}

/**
 * A stanza's max-size value → bytes, or null when it is not a positive cap
 * (`0` = unlimited is NOT a cap; garbage is a hand-written line).
 */
export function parseMaxSize(raw: string): number | null {
  const m = MAX_SIZE_RE.exec(raw.trim())
  if (!m)
    return null
  const n = Number(m[1])
  if (n <= 0)
    return null
  switch ((m[2] ?? '').toUpperCase()) {
    case 'T': return n * TIB
    case 'G': return n * GIB
    case 'M': return n * MIB
    default: return n // a bare byte count (e.g. a hand-written stanza)
  }
}

/**
 * The ANAS-written `shadow:format` → its schedule bucket, or null when the
 * value is not one of ours (a custom format means the line is not ANAS's).
 * The bucket must be a real retention bucket — `shadow:snapprefix` is broken
 * on Samba 4.22, so a share exposes exactly ONE bucket through this format.
 */
export function parseShadowFormatBucket(value: string): string | null {
  const m = SHADOW_FORMAT_RE.exec(value.trim())
  if (!m)
    return null
  return (RetentionBucket.options as readonly string[]).includes(m[1]) ? m[1] : null
}

/** Marker text for a purge age (`null` inside = never purge). */
function purgeMarkerValue(purgeDays: RecyclePurgeDays): string {
  return purgeDays === null ? 'never' : String(purgeDays)
}

/**
 * A marker value → its purge age; `undefined` when it is not a policy value
 * (`null` = `never`; a number = days).
 */
function parseMarkerDays(raw: string): RecyclePurgeDays | undefined {
  const v = raw.trim().toLowerCase()
  if (v === 'never')
    return null
  if (!DIGITS_RE.test(v))
    return undefined
  const n = Number(v)
  return (n === 7 || n === 14 || n === 30 || n === 90) ? (n as RecyclePurgeDays) : undefined
}

/** The verbatim marker line (rewritten whole — never reformatted) for a value. */
function purgeMarkerLine(indent: string, value: string): string {
  return `${indent}# anas:recycle-purge-days = ${value}`
}

/**
 * Find the recycle purge marker inside a section. Returns the raw value text
 * (e.g. `30` or `never`) and its line index, or null when the section has no
 * marker. The marker is a COMMENT line, so it is invisible to `sectionDefs`
 * and handled by its own scan.
 */
function findPurgeMarker(doc: SmbConfDoc, span: SectionSpan): { value: string, line: number } | null {
  for (let i = span.start; i < span.end; i++) {
    if (i === span.headerIndex)
      continue
    const m = PURGE_MARKER_RE.exec(content(doc.lines[i]).trim())
    if (m)
      return { value: m[1].trim(), line: i }
  }
  return null
}

/**
 * Set or remove the purge marker in one section, splicing `doc.lines`. The
 * existing line is preserved VERBATIM and rewritten only when the value
 * changes (the line's own indent kept); `wanted === null` removes it. A new
 * marker is inserted after the section's last content line at `indent` — the
 * same anchor applyEditsToSection uses for new keys. Recomputes the section
 * overlay first — earlier inserts/ removals shifted the spans.
 */
function applyPurgeMarkerEdit(doc: SmbConfDoc, sectionName: string, wanted: string | null, indent: string): void {
  reindexSections(doc)
  const span = findSection(doc, sectionName)
  if (!span)
    return
  const existing = findPurgeMarker(doc, span)
  if (wanted === null) {
    if (existing)
      doc.lines.splice(existing.line, 1)
    return
  }
  if (existing) {
    if (existing.value !== wanted) {
      const m = LEADING_WS_RE.exec(content(doc.lines[existing.line]))
      doc.lines[existing.line] = purgeMarkerLine(m?.[0] ?? indent, wanted)
    }
    return
  }
  // Insert after the section's last content line, before trailing blanks —
  // the same anchor applyEditsToSection uses for new keys.
  const fresh = findSection(doc, sectionName)
  if (!fresh)
    return
  let insertAt = fresh.headerIndex !== null ? fresh.headerIndex + 1 : fresh.start
  for (let i = fresh.start; i < fresh.end; i++) {
    if (i === fresh.headerIndex)
      continue
    if (content(doc.lines[i]).trim() !== '')
      insertAt = i + 1
  }
  doc.lines.splice(insertAt, 0, purgeMarkerLine(indent, wanted))
}

/**
 * Is a feature's managed-key set COMPLETE — i.e. written the way the composer
 * writes it? A stanza carrying the module but a foreign/absent key set is a
 * hand-made line: the feature does not read as on, and the share reads custom.
 */
function previousVersionsKeysComplete(defs: KeyDef[]): boolean {
  return parseShadowFormatBucket(paramValue(defs, PARAM.shadowFormat) ?? '') !== null
    && paramValue(defs, PARAM.shadowSnapdir) !== undefined
    && paramValue(defs, PARAM.shadowLocaltime) !== undefined
    && paramValue(defs, PARAM.shadowSort) !== undefined
}

function recycleKeysComplete(defs: KeyDef[], marker: string | null): boolean {
  return paramValue(defs, PARAM.recycleRepository) === RECYCLE_REPOSITORY
    && paramValue(defs, PARAM.recycleKeeptree) !== undefined
    && paramValue(defs, PARAM.recycleVersions) !== undefined
    && paramValue(defs, PARAM.recycleTouch) !== undefined
    && marker !== null
    && parseMarkerDays(marker) !== undefined
}

function timeMachineKeysComplete(defs: KeyDef[]): boolean {
  const maxSize = paramValue(defs, PARAM.fruitTimeMachineMaxSize)
  return parseBool(paramValue(defs, PARAM.fruitTimeMachine), false)
    && maxSize !== undefined && parseMaxSize(maxSize) !== null
}

// ============================================================================
// Typed read-models (SmbShare / SmbGlobalConfig) built from a section's defs.
// ============================================================================

/**
 * Is this stanza's `vfs objects` line ANAS-composed? A line is CUSTOM — and
 * no self-service feature may be enabled on the share — when it carries any
 * module outside the composer's set, or a module set that does not exactly
 * match the composer's output for the features that read as on (a feature
 * reads as on only with its COMPLETE managed-key set above). A share with no
 * `vfs objects` line is never custom. Pure over the read-model.
 */
export function hasCustomVfsObjects(share: SmbShare): boolean {
  if (!share.vfsObjects || share.vfsObjects.length === 0)
    return false
  const composed = composeVfsObjects({
    previousVersions: share.previousVersions !== undefined,
    recycle: share.recycle !== undefined,
    timeMachine: share.timeMachine !== undefined,
  })
  if (composed === null)
    return true
  return share.vfsObjects.join(' ') !== composed
}

/**
 * The custom-`vfs objects` refusal sentence, stated ONCE — the route's 400
 * fast path and the parser's in-job guard both quote it.
 */
export function customVfsRefusal(share: string): string {
  return `share '${share}' has a custom vfs objects line — remove it before enabling self-service features`
}

/**
 * Build an SmbShare from a section's definitions, or null if it has no path —
 * such sections (e.g. `[homes]`, `[printers]`) are not path-based file shares
 * ANAS manages, and would not satisfy the schema's AbsolutePath.
 *
 * `marker` is the section's recycle purge marker value (null when absent).
 * The self-service feature states are DERIVED from the stanza — the module
 * list plus each feature's complete managed-key set — so list/detail read
 * them straight from the config with no shadow copy (Principle 11).
 */
function toSmbShare(name: string, defs: KeyDef[], marker: string | null): SmbShare | null {
  const path = paramValue(defs, PARAM.path)
  if (!path)
    return null

  const vfsModules = parseList(paramValue(defs, PARAM.vfsObjects))
  const previousVersionsOn = vfsModules.includes('shadow_copy2') && previousVersionsKeysComplete(defs)
  const recycleOn = vfsModules.includes('recycle') && recycleKeysComplete(defs, marker)
  const timeMachineOn = vfsModules.includes('fruit') && vfsModules.includes('catia') && timeMachineKeysComplete(defs)
  const maxSizeBytes = parseMaxSize(paramValue(defs, PARAM.fruitTimeMachineMaxSize) ?? '')
  const bucket = parseShadowFormatBucket(paramValue(defs, PARAM.shadowFormat) ?? '')

  return {
    name,
    path,
    comment: paramValue(defs, PARAM.comment) ?? null,
    browseable: paramBool(defs, PARAM.browseable),
    readOnly: paramBool(defs, PARAM.readOnly),
    guestOk: paramBool(defs, PARAM.guestOk),
    validUsers: parseList(paramValue(defs, PARAM.validUsers)),
    hostsAllow: parseList(paramValue(defs, PARAM.hostsAllow)),
    hostsDeny: parseList(paramValue(defs, PARAM.hostsDeny)),
    ...(vfsModules.length > 0 ? { vfsObjects: vfsModules } : {}),
    ...(previousVersionsOn && bucket ? { previousVersions: { bucket } } : {}),
    ...(recycleOn && marker !== null ? { recycle: { purgeDays: parseMarkerDays(marker) as RecyclePurgeDays } } : {}),
    ...(timeMachineOn && maxSizeBytes !== null ? { timeMachine: { maxSize: maxSizeBytes } } : {}),
  }
}

/** Build the SmbGlobalConfig read-model from the `[global]` definitions. */
function toGlobalConfig(defs: KeyDef[]): SmbGlobalConfig {
  return {
    workgroup: paramValue(defs, PARAM.workgroup) ?? '',
    serverString: paramValue(defs, PARAM.serverString) ?? '',
    interfaces: parseList(paramValue(defs, PARAM.interfaces)),
    bindInterfacesOnly: paramBool(defs, PARAM.bindInterfacesOnly),
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
  let global: SmbGlobalConfig = toGlobalConfig([])
  const shares: SmbShare[] = []

  for (const span of doc.sections) {
    if (span.key === null)
      continue // preamble
    const defs = sectionDefs(doc, span)
    if (span.key === 'global') {
      global = toGlobalConfig(defs)
      continue
    }
    const share = toSmbShare(span.name as string, defs, findPurgeMarker(doc, span)?.value ?? null)
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
  return toSmbShare(span.name as string, sectionDefs(doc, span), findPurgeMarker(doc, span)?.value ?? null)
}

/** Does a share section by this name exist? (case-insensitive). */
export function hasShare(text: string, name: string): boolean {
  const span = findSection(parseDoc(text), name)
  return span !== null && span.key !== 'global'
}

/**
 * One stanza the recycle purge runner acts on (smbsvc.2): any share section
 * carrying a `recycle:repository` (that IS the bin — the runner needs nothing
 * else from the stanza) plus whatever purge policy its marker states.
 */
export interface RecyclePurgeTarget {
  /** Section (share) name. */
  share: string
  /**
   * The stanza's `path`, or null when it sets none — the runner skips such a
   * stanza (it cannot locate the bin) without error.
   */
  path: string | null
  /** The stanza's `recycle:repository` value (present by construction). */
  repository: string
  /**
   * The purge age in days, or null when the marker is absent, `never`, or not
   * a policy value — the runner skips those and never deletes anything.
   */
  days: number | null
}

/**
 * Every recycle-purge candidate in an smb.conf, for the `anas-recycle` runner.
 * The SAME parser that reads and writes the config answers the runner — one
 * copy of the marker/repository semantics, never a second hand-rolled scan of
 * smb.conf (single-source-of-truth rule). `[global]` and pathless sections are
 * skipped like any non-share stanza.
 */
export function recyclePurgeTargets(text: string): RecyclePurgeTarget[] {
  const doc = parseDoc(text)
  const targets: RecyclePurgeTarget[] = []
  for (const span of doc.sections) {
    if (span.key === null || span.key === 'global')
      continue
    const defs = sectionDefs(doc, span)
    const repository = paramValue(defs, PARAM.recycleRepository)
    if (!repository)
      continue
    const marker = findPurgeMarker(doc, span)?.value ?? null
    targets.push({
      share: span.name as string,
      path: paramValue(defs, PARAM.path) ?? null,
      repository,
      // `never` and a non-policy marker both read as "no purge age" — the same
      // parseMarkerDays the read-model uses, so the runner and ANAS can never
      // disagree about which stanza purges.
      days: marker !== null ? parseMarkerDays(marker) ?? null : null,
    })
  }
  return targets
}

// ============================================================================
// Surgical editors — each returns new text, changing ONLY the target section
// (and, within it, only the target keys). All other bytes pass through verbatim.
// ============================================================================

/** The desired end-state of ONE parameter in a section. */
interface KeyEdit {
  /** Which parameter (with its synonym spellings) to write. */
  param: SmbParam
  /** How an existing value is compared, so a no-op save rewrites nothing. */
  kind: 'text' | 'bool' | 'list'
  /** New value, or null to REMOVE every definition of the parameter. */
  value: string | null
}

/** Does the config already say this? (Compared in the value's own dialect.) */
function sameValue(kind: KeyEdit['kind'], existing: string, wanted: string): boolean {
  if (kind === 'bool')
    return parseBool(existing, false) === parseBool(wanted, false)
  if (kind === 'list') {
    const a = parseList(existing)
    const b = parseList(wanted)
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  return existing === wanted
}

/** Blank is not a value: '' (or whitespace) means REMOVE the directive. */
function blankIsRemoval(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value
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
 * Apply a set of parameter edits to one section, splicing `doc.lines` in place.
 *
 * Per parameter, and honouring every synonym spelling:
 *  - already says this   → nothing is written (an untouched save is byte-identical),
 *  - defined, changed    → only the value on the EFFECTIVE (last) line is rewritten,
 *                          in that line's own spelling and sense,
 *  - remove (value null) → EVERY definition goes; leaving an earlier one would
 *                          silently keep the parameter set,
 *  - not defined         → a canonical line is inserted after the section's last
 *                          content line.
 *
 * Line indexes go stale the moment a removal splices the array, so the section
 * overlay is recomputed before the insert scan — the insert must land inside
 * THIS section, never in the next stanza (issue #36).
 */
function applyEditsToSection(doc: SmbConfDoc, sectionName: string, edits: KeyEdit[], indent: string): void {
  const span = findSection(doc, sectionName)
  if (!span)
    return
  const defs = sectionDefs(doc, span)

  const toInsert: string[] = []
  const removals: { first: number, last: number }[] = []
  const replacements: { line: number, value: string }[] = []

  for (const edit of edits) {
    const hits = paramHits(defs, edit.param)

    if (edit.value === null) {
      for (const hit of hits)
        removals.push({ first: hit.def.first, last: hit.def.last })
      continue
    }

    const effective = hits.at(-1)
    if (!effective) {
      // Absent means Samba's own default. If that is already what was asked
      // for, write nothing: a stanza that relies on the default keeps relying
      // on it, and an untouched save stays byte-identical.
      if (edit.param.unset !== undefined && sameValue(edit.kind, edit.param.unset, edit.value))
        continue
      toInsert.push(`${indent}${edit.param.canonical} = ${edit.value}`)
      continue
    }

    // Compare in this parameter's sense (`writeable = no` already says read-only).
    const current = effective.inverted ? invertBool(effective.def.value) : effective.def.value
    if (sameValue(edit.kind, current, edit.value))
      continue

    // Write in the line's own sense so the existing spelling keeps its meaning.
    const written = effective.inverted ? invertBool(edit.value) : edit.value
    replacements.push({ line: effective.def.first, value: written })
    if (effective.def.last > effective.def.first)
      removals.push({ first: effective.def.first + 1, last: effective.def.last })
  }

  // Apply value replacements (single-line, index-stable).
  for (const r of replacements)
    doc.lines[r.line] = replaceValue(doc.lines[r.line], r.value)

  // Apply removals bottom-up so indices stay valid.
  if (removals.length > 0) {
    removals.sort((a, b) => b.first - a.first)
    for (const r of removals)
      doc.lines.splice(r.first, r.last - r.first + 1)
    reindexSections(doc) // every span past a removal moved
  }

  // Insert new keys after the section's last content line (before trailing blanks).
  if (toInsert.length > 0) {
    const fresh = findSection(doc, sectionName)
    if (!fresh)
      return // unreachable: a header line is never removed
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
 * The RESOLVED self-service edits for one share: the desired state of each
 * feature per the §2 dialog↔daemon contract (value = set, `null` = clear,
 * omitted = keep), with the values the ROUTE resolved from the system — the
 * schedule bucket and the ZFS-vs-AHR snapdir shape are system facts, not
 * parser inputs. The parser composes the `vfs objects` line from the FINAL
 * feature set (current stanza state overridden by these) and writes the
 * managed keys around it.
 */
export interface SelfServiceKeys {
  previousVersions?: { bucket: string, snapdir: string, snapdirseverywhere: boolean } | null
  recycle?: { purgeDays: RecyclePurgeDays } | null
  timeMachine?: { maxSize: number } | null
}

/**
 * The self-service key/marker edits for one share stanza. Throws when a
 * feature is being ENABLED on a share whose `vfs objects` line is custom
 * (the route's 400 fast path re-checks the same rule in the job). The marker
 * edit is returned separately — it is a COMMENT line, invisible to the
 * `KeyEdit` machinery, and applied after the key edits splice the lines.
 */
function selfServiceEdits(doc: SmbConfDoc, sectionName: string, keys: SelfServiceKeys): {
  edits: KeyEdit[]
  /** Marker value to write/rewrite; null = leave alone (unless markerRemove). */
  markerWanted: string | null
  /** Remove the marker (recycle turned off while it read as on). */
  markerRemove: boolean
} {
  const span = findSection(doc, sectionName)
  const defs = span ? sectionDefs(doc, span) : []
  const marker = span ? findPurgeMarker(doc, span)?.value ?? null : null
  const current = toSmbShare(sectionName, defs, marker)

  // Enabling on a custom line would silently adopt (and later rewrite) a
  // stanza ANAS did not compose — refused in the route as a 400; here the same
  // rule fails the job (the state may have changed between the two reads).
  const enabling = Object.values(keys).some(v => v !== undefined && v !== null)
  if (enabling && current && hasCustomVfsObjects(current))
    throw new Error(customVfsRefusal(sectionName))

  const final = {
    previousVersions: current?.previousVersions !== undefined,
    recycle: current?.recycle !== undefined,
    timeMachine: current?.timeMachine !== undefined,
  }
  const edits: KeyEdit[] = []
  // Only REMOVE a feature's keys when the feature currently reads as ON: a
  // clear request against a hand-made stanza must not strip a foreign key set.
  const removeKeys = (params: SmbParam[]): void =>
    params.forEach(p => edits.push({ param: p, kind: 'text', value: null }))
  // The composed line is ANAS's only when a feature turned ON here or a
  // formerly-on feature turned OFF here. A request that only clears a feature
  // which never read as on leaves the line — and the stanza — alone.
  let lineTouched = false

  const pv = keys.previousVersions
  if (pv === null) {
    if (final.previousVersions) {
      removeKeys([PARAM.shadowSnapdir, PARAM.shadowSnapdirseverywhere, PARAM.shadowLocaltime, PARAM.shadowSort, PARAM.shadowFormat])
      lineTouched = true
    }
    final.previousVersions = false
  }
  else if (pv !== undefined) {
    final.previousVersions = true
    lineTouched = true
    edits.push({ param: PARAM.shadowFormat, kind: 'text', value: shadowFormatFor(pv.bucket) })
    edits.push({ param: PARAM.shadowSnapdir, kind: 'text', value: pv.snapdir })
    edits.push({ param: PARAM.shadowSnapdirseverywhere, kind: 'bool', value: boolStr(pv.snapdirseverywhere) })
    edits.push({ param: PARAM.shadowLocaltime, kind: 'bool', value: 'no' })
    edits.push({ param: PARAM.shadowSort, kind: 'text', value: 'desc' })
  }

  const rc = keys.recycle
  if (rc === null) {
    if (final.recycle) {
      removeKeys([PARAM.recycleRepository, PARAM.recycleKeeptree, PARAM.recycleVersions, PARAM.recycleTouch])
      lineTouched = true
    }
    final.recycle = false
  }
  else if (rc !== undefined) {
    final.recycle = true
    lineTouched = true
    edits.push({ param: PARAM.recycleRepository, kind: 'text', value: RECYCLE_REPOSITORY })
    edits.push({ param: PARAM.recycleKeeptree, kind: 'bool', value: 'yes' })
    edits.push({ param: PARAM.recycleVersions, kind: 'bool', value: 'yes' })
    edits.push({ param: PARAM.recycleTouch, kind: 'bool', value: 'yes' })
  }

  const tm = keys.timeMachine
  if (tm === null) {
    if (final.timeMachine) {
      removeKeys([PARAM.fruitTimeMachine, PARAM.fruitTimeMachineMaxSize])
      lineTouched = true
    }
    final.timeMachine = false
  }
  else if (tm !== undefined) {
    final.timeMachine = true
    lineTouched = true
    edits.push({ param: PARAM.fruitTimeMachine, kind: 'bool', value: 'yes' })
    edits.push({ param: PARAM.fruitTimeMachineMaxSize, kind: 'text', value: formatMaxSize(tm.maxSize) })
  }

  // The composed line: written (in canonical order) whenever any feature ends
  // up on, REMOVED when the last feature turns off. `kind: 'text'` on purpose —
  // the composer's order is canonical, so a reordered-but-equal set is
  // rewritten rather than left as a near-miss.
  if (lineTouched)
    edits.push({ param: PARAM.vfsObjects, kind: 'text', value: composeVfsObjects(final) })

  // The recycle marker follows the recycle feature: set/rewritten on enable or
  // purge-age change, removed when the feature turns off. `rc === null` with
  // recycle already off must NOT strip a foreign marker — hence the `current`
  // guard mirrors the key removals above.
  let markerWanted: string | null = null
  let markerRemove = false
  if (rc === null && current?.recycle !== undefined) {
    markerRemove = true
  }
  else if (rc !== undefined && rc !== null) {
    markerWanted = purgeMarkerValue(rc.purgeDays)
  }
  return { edits, markerWanted, markerRemove }
}

/** Build the ordered key edits for the mutable SMB share fields present in `req`. */
function shareEdits(req: UpdateSmbShareRequest | CreateSmbShareRequest): KeyEdit[] {
  const edits: KeyEdit[] = []
  const push = (param: SmbParam, kind: KeyEdit['kind'], value: string | null) => edits.push({ param, kind, value })

  if ('path' in req && req.path !== undefined)
    push(PARAM.path, 'text', req.path)
  // A blank comment is not a comment: remove the directive rather than litter
  // the stanza with `comment = ` (the UI always sends the field — issue #42).
  if (req.comment !== undefined)
    push(PARAM.comment, 'text', blankIsRemoval(req.comment))
  if (req.browseable !== undefined)
    push(PARAM.browseable, 'bool', boolStr(req.browseable))
  if (req.readOnly !== undefined)
    push(PARAM.readOnly, 'bool', boolStr(req.readOnly))
  if (req.guestOk !== undefined)
    push(PARAM.guestOk, 'bool', boolStr(req.guestOk))
  if (req.validUsers !== undefined)
    push(PARAM.validUsers, 'list', req.validUsers.length ? req.validUsers.join(' ') : null)
  if (req.hostsAllow !== undefined)
    push(PARAM.hostsAllow, 'list', req.hostsAllow.length ? req.hostsAllow.join(' ') : null)
  if (req.hostsDeny !== undefined)
    push(PARAM.hostsDeny, 'list', req.hostsDeny.length ? req.hostsDeny.join(' ') : null)

  return edits
}

/**
 * Render a brand-new share stanza (no surrounding blank lines). `selfService`
 * carries the RESOLVED features to enable at create time (value = set; a
 * `null`/omitted feature is simply not written).
 */
function renderStanza(req: CreateSmbShareRequest, indent: string, selfService?: SelfServiceKeys): string {
  const lines = [`[${req.name}]`]
  const add = (param: SmbParam, value: string) => lines.push(`${indent}${param.canonical} = ${value}`)

  add(PARAM.path, req.path)
  const comment = blankIsRemoval(req.comment)
  if (comment !== null)
    add(PARAM.comment, comment)
  // Near-zero-typing defaults (DESIGN 5d): browseable=yes, read-only=no, guest=no.
  add(PARAM.browseable, boolStr(req.browseable ?? true))
  add(PARAM.readOnly, boolStr(req.readOnly ?? false))
  add(PARAM.guestOk, boolStr(req.guestOk ?? false))
  if (req.validUsers && req.validUsers.length)
    add(PARAM.validUsers, req.validUsers.join(' '))
  if (req.hostsAllow && req.hostsAllow.length)
    add(PARAM.hostsAllow, req.hostsAllow.join(' '))
  if (req.hostsDeny && req.hostsDeny.length)
    add(PARAM.hostsDeny, req.hostsDeny.join(' '))

  if (selfService) {
    const pv = selfService.previousVersions ?? undefined
    const rc = selfService.recycle ?? undefined
    const tm = selfService.timeMachine ?? undefined
    const composed = composeVfsObjects({
      previousVersions: pv != null,
      recycle: rc != null,
      timeMachine: tm != null,
    })
    if (composed !== null)
      add(PARAM.vfsObjects, composed)
    if (pv != null) {
      add(PARAM.shadowFormat, shadowFormatFor(pv.bucket))
      add(PARAM.shadowSnapdir, pv.snapdir)
      add(PARAM.shadowSnapdirseverywhere, boolStr(pv.snapdirseverywhere))
      add(PARAM.shadowLocaltime, 'no')
      add(PARAM.shadowSort, 'desc')
    }
    if (rc != null) {
      add(PARAM.recycleRepository, RECYCLE_REPOSITORY)
      add(PARAM.recycleKeeptree, 'yes')
      add(PARAM.recycleVersions, 'yes')
      add(PARAM.recycleTouch, 'yes')
      lines.push(purgeMarkerLine(indent, purgeMarkerValue(rc.purgeDays)))
    }
    if (tm != null) {
      add(PARAM.fruitTimeMachine, 'yes')
      add(PARAM.fruitTimeMachineMaxSize, formatMaxSize(tm.maxSize))
    }
  }

  return lines.join('\n')
}

/**
 * Add a new share stanza to the file. Appends at the end so every existing byte
 * is preserved verbatim; a blank separator line precedes the stanza. Assumes the
 * caller has already checked the share does not exist (409 otherwise).
 */
export function addShare(text: string, req: CreateSmbShareRequest, selfService?: SelfServiceKeys): string {
  const stanza = renderStanza(req, '\t', selfService)
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
 * share is absent. `selfService` (smbsvc.1–3) carries the RESOLVED feature
 * states: set / clear / keep per feature, with the route-resolved bucket and
 * snapdir shape.
 */
export function updateShare(text: string, name: string, req: UpdateSmbShareRequest, selfService?: SelfServiceKeys): string {
  const doc = parseDoc(text)
  const span = findSection(doc, name)
  if (!span || span.key === 'global')
    return text
  const indent = sectionIndent(doc, span)
  const edits = shareEdits(req)
  if (selfService) {
    const ss = selfServiceEdits(doc, name, selfService)
    edits.push(...ss.edits)
    applyEditsToSection(doc, name, edits, indent)
    if (ss.markerRemove)
      applyPurgeMarkerEdit(doc, name, null, indent)
    else if (ss.markerWanted !== null)
      applyPurgeMarkerEdit(doc, name, ss.markerWanted, indent)
    return serializeDoc(doc)
  }
  applyEditsToSection(doc, name, edits, indent)
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
  const push = (param: SmbParam, kind: KeyEdit['kind'], value: string | null) => edits.push({ param, kind, value })

  // Blank means "not set" — remove the directive instead of writing an empty
  // one, so saving an untouched stock config adds nothing (issue #42).
  if (req.workgroup !== undefined)
    push(PARAM.workgroup, 'text', blankIsRemoval(req.workgroup))
  if (req.serverString !== undefined)
    push(PARAM.serverString, 'text', blankIsRemoval(req.serverString))
  if (req.interfaces !== undefined)
    push(PARAM.interfaces, 'list', req.interfaces.length ? req.interfaces.join(' ') : null)
  if (req.bindInterfacesOnly !== undefined)
    push(PARAM.bindInterfacesOnly, 'bool', boolStr(req.bindInterfacesOnly))

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
    // Nothing to write (every field blank/empty) — do not conjure a [global]
    // section just to delete directives that were never there.
    if (edits.every(e => e.value === null))
      return text
    // Prepend a [global] header (with a blank separator before existing content)
    // so the new keys have a home. Existing lines shift down, unchanged.
    workingText = text === '' ? '[global]\n' : `[global]\n\n${text}`
    doc = parseDoc(workingText)
  }
  const span = findSection(doc, 'global')!
  applyEditsToSection(doc, 'global', edits, sectionIndent(doc, span))
  return serializeDoc(doc)
}
