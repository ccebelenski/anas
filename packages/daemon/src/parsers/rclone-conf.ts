/**
 * Round-trip parser + surgical section writer for `rclone.conf` (story rclone.1).
 *
 * rclone.conf is plain INI: `[section]` headers (remote names — exact,
 * case-SENSITIVE: `myremote` and `MyRemote` are different remotes to rclone),
 * `key = value` lines, full-line comments starting with `#` or `;`, and blank
 * lines. rclone writes exactly one space each side of `=`; values are VERBATIM
 * to end of line and may themselves contain `=`, spaces, `;`, `#` or JSON (a
 * `{"access_token":"x"}` token value) — a `;`/`#` INSIDE a value is never a
 * comment.
 *
 * ── Round-trip fidelity (Principle 12: we are a guest, never reformat) ──
 * Like `smb-conf.ts`, the file is held as its ORIGINAL array of lines and
 * nothing is ever regenerated from a value model: every mutation splices the
 * line array and carries every untouched line through verbatim, so
 * `serializeRcloneConf(parseRcloneConf(text)) === text` byte-for-byte for ANY
 * input (odd spacing, comments, trailing whitespace, missing final newline).
 *
 * The section writer (`upsertSection` / `removeSection`) is what makes the
 * remotes store possible at all: rclone's own config verbs would carry a
 * secret on argv, so ANAS edits the section itself and lets `rclone config
 * dump` read the file back as the gate (the `testparm` pattern).
 */

/** A `[section]` header (whole trimmed line) — the remote name inside. */
const SECTION_HEADER_RE = /^\[(.+)\]\s*$/
/** Trailing newlines at the end of a file (normalised away on append). */
const TRAILING_NEWLINES_RE = /\n+$/

// ============================================================================
// Low-level line model — the round-trip substrate.
// ============================================================================

/** A parsed section span over the original `lines` array. */
export interface RcloneSectionSpan {
  /** The remote name exactly as written (null = preamble before the first header). */
  name: string | null
  /** Index of the `[name]` header line, or null for the preamble. */
  headerIndex: number | null
  /** First line index of the section (the header line, or 0 for the preamble). */
  start: number
  /** One past the last line index of the section (exclusive). */
  end: number
}

/** The whole file as its original lines plus the section overlay. */
export interface RcloneConfDoc {
  lines: string[]
  sections: RcloneSectionSpan[]
}

/** A trimmed line that is a full-line comment (`#` or `;`)? */
function isComment(trimmed: string): boolean {
  return trimmed.startsWith('#') || trimmed.startsWith(';')
}

/** A `[section]` header line → the raw section name, else null. */
function sectionHeader(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || isComment(trimmed))
    return null
  const m = SECTION_HEADER_RE.exec(trimmed)
  return m ? m[1].trim() : null
}

/**
 * Split a `key = value` line into its parts, or null if it is not one.
 *
 * The key is trimmed on both sides (a hand-indented stanza still reads); the
 * value is everything after the FIRST `=` with ONE leading space stripped if
 * present, otherwise VERBATIM to end of line — `endpoint = https://x y=z ;q`
 * keeps its spaces, `=` and `;`.
 */
function parseKeyLine(line: string): { key: string, value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || isComment(trimmed) || trimmed.startsWith('['))
    return null
  const eq = line.indexOf('=')
  if (eq === -1)
    return null
  const key = line.slice(0, eq).trim()
  if (!key)
    return null
  let value = line.slice(eq + 1)
  if (value.startsWith(' '))
    value = value.slice(1)
  return { key, value }
}

/**
 * Parse the file text into the round-trip document model. Never loses data:
 * `lines` is exactly `text.split('\n')`, so `join('\n')` reconstructs `text`.
 */
export function parseRcloneConf(text: string): RcloneConfDoc {
  const lines = text.split('\n')
  return { lines, sections: computeSections(lines) }
}

/**
 * Build the section overlay for a line array: the preamble (before the first
 * header) plus one span per header, each running to the next header or EOF.
 * A trailing blank line is INSIDE the last section's span — that is what lets
 * a removal of the last section leave the file clean.
 */
function computeSections(lines: string[]): RcloneSectionSpan[] {
  const headers: { index: number, name: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const name = sectionHeader(lines[i])
    if (name !== null)
      headers.push({ index: i, name })
  }

  const sections: RcloneSectionSpan[] = []
  if (headers.length === 0) {
    // Whole file is a headerless preamble (comments / blanks / stray keys).
    // `''.split('\n')` is `['']` — an empty file has no section at all.
    if (lines.length > 1 || lines[0] !== '')
      sections.push({ name: null, headerIndex: null, start: 0, end: lines.length })
    return sections
  }

  if (headers[0].index > 0)
    sections.push({ name: null, headerIndex: null, start: 0, end: headers[0].index })

  for (let h = 0; h < headers.length; h++) {
    const start = headers[h].index
    const end = h + 1 < headers.length ? headers[h + 1].index : lines.length
    sections.push({
      name: headers[h].name,
      headerIndex: start,
      start,
      end,
    })
  }

  return sections
}

/** Reconstruct the file text from the document model (byte-for-byte on no-op). */
export function serializeRcloneConf(doc: RcloneConfDoc): string {
  return doc.lines.join('\n')
}

/** Find a section span by EXACT name (rclone remote names are case-sensitive). */
function findSection(doc: RcloneConfDoc, name: string): RcloneSectionSpan | null {
  return doc.sections.find(s => s.name === name) ?? null
}

// ============================================================================
// Read-side: the sections and their key values.
// ============================================================================

/** One section as a name → value table. */
export interface RcloneConfSection {
  name: string
  /** Key → value, last definition winning (rclone's own behaviour). */
  values: Record<string, string>
}

/**
 * The named sections of the document with their key values (preamble
 * skipped). Values follow the `parseKeyLine` contract: verbatim to end of
 * line, one leading space after `=` stripped.
 */
export function listSections(doc: RcloneConfDoc): RcloneConfSection[] {
  const out: RcloneConfSection[] = []
  for (const span of doc.sections) {
    if (span.name === null)
      continue
    const values: Record<string, string> = {}
    for (let i = span.start; i < span.end; i++) {
      if (i === span.headerIndex)
        continue
      const parsed = parseKeyLine(doc.lines[i])
      if (!parsed)
        continue
      values[parsed.key] = parsed.value // duplicate key: the LAST value wins
    }
    out.push({ name: span.name, values })
  }
  return out
}

// ============================================================================
// Write-side: the surgical section editor. Every byte outside the target
// section (comments, other sections, blank lines) passes through verbatim.
// ============================================================================

/**
 * Replace the whole `[name]` section's key lines with `key = value` lines
 * (rclone's own spelling: one space each side of `=`) in `values`' insertion
 * order.
 *
 * What survives an in-place rewrite:
 *  - the section's ORIGINAL HEADER LINE, verbatim,
 *  - every NON-KEY line that was inside the section (full-line comments,
 *    unrecognised lines) — kept in their original order at the TOP of the
 *    section. A key is replaced, a comment is never touched,
 *  - the blank line that separated the section from the NEXT section, when
 *    there was one (normalised to exactly one).
 *
 * Blank lines INSIDE the section body are formatting and do not survive — the
 * rewritten section is compact, the way rclone writes it.
 *
 * When the section is ABSENT it is appended at the end in rclone's own
 * format — `[name]` + the key lines, each newline-terminated — separated from
 * what precedes it by exactly one blank line, and the file is made to end
 * with a newline.
 */
export function upsertSection(text: string, name: string, values: Record<string, string>): string {
  const keyLines = Object.entries(values).map(([k, v]) => `${k} = ${v}`)
  const doc = parseRcloneConf(text)
  const span = findSection(doc, name)

  if (!span) {
    // Strip any trailing newlines, then add exactly one terminator + one
    // blank line of separation, so the result has exactly one blank line
    // between the old content and the new section whatever the file ended
    // with. The block itself is newline-terminated (the file ends with a
    // newline).
    const prefix = text.replace(TRAILING_NEWLINES_RE, '')
    const separator = prefix === '' ? '' : '\n\n'
    return `${prefix}${separator}[${name}]\n${keyLines.join('\n')}\n`
  }

  const body = doc.lines.slice(span.start + 1, span.end)
  const followed = doc.sections.some(s => s.name !== null && s.start > span.start)
  const hadBlank = body.some(l => l.trim() === '')
  // Non-key lines: full-line comments (and unrecognised lines) — never dropped.
  const preserved = body.filter(l => l.trim() !== '' && parseKeyLine(l) === null)
  // The file's final newline is the split's trailing `''` element — it sits
  // INSIDE the last span's body, and the splice would drop it. When the
  // original file ended with a newline, the rewritten section must too.
  const trailingNewline = span.end === doc.lines.length && doc.lines[span.end - 1] === ''

  const sectionLines: string[] = [doc.lines[span.headerIndex!], ...preserved, ...keyLines]
  if (hadBlank && followed)
    sectionLines.push('') // keep the blank separator before the next section
  if (trailingNewline)
    sectionLines.push('')

  doc.lines.splice(span.start, span.end - span.start, ...sectionLines)
  return serializeRcloneConf(doc)
}

/**
 * Remove the `[name]` section: its header, its lines, and the blank line that
 * separated it from the next section (the span's tail). Everything else is
 * byte-identical — including the preceding section's own trailing blank line,
 * which then serves as the separator. A file whose only section is removed
 * becomes empty. Returns the text unchanged when the section is absent.
 */
export function removeSection(text: string, name: string): string {
  const doc = parseRcloneConf(text)
  const span = findSection(doc, name)
  if (!span)
    return text
  doc.lines.splice(span.start, span.end - span.start)
  return serializeRcloneConf(doc)
}
