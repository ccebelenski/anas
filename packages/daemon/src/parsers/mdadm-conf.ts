/**
 * Round-trip parser and surgical editor for /etc/mdadm/mdadm.conf (see
 * mdadm.conf(5)).
 *
 * mdadm.conf is line-based. Blank lines and lines whose first non-blank
 * character is `#` are comments; a line starting with whitespace continues the
 * previous line. Keywords (ARRAY, PROGRAM, MAILADDR, HOMEHOST, DEVICE, …) are
 * case-insensitive and may be abbreviated to three characters. ANAS cares
 * about exactly two of them:
 *
 *   ARRAY <devname> metadata=1.2 UUID=<uuid> [name=… …]   — pins a stable
 *     /dev/md/<name> across assembly paths (AHR-DESIGN §2.6, GT-3);
 *   PROGRAM <path>   — the mdadm --monitor event hook (AHR-DESIGN §7.2,
 *     GT-11). mdadm allows AT MOST ONE PROGRAM line.
 *
 * ANAS is a guest on the system (Principle 12): it makes surgical, line-level
 * edits and preserves everything it does not touch — comments, MAILADDR,
 * HOMEHOST, foreign ARRAY lines, continuation lines, ordering, whitespace —
 * BYTE-FOR-BYTE. The document model keeps every line's original text verbatim
 * in `raw` and only interprets ARRAY/PROGRAM lines;
 * `serializeMdadmConfDoc(parseMdadmConfDoc(t))` reproduces `t` exactly.
 *
 * Because mdadm permits only one PROGRAM line, an existing PROGRAM that is not
 * the one being installed is NEVER overwritten — `upsertProgram` refuses with
 * a typed error and the operator decides (guest philosophy: we don't silently
 * steal a hook someone else configured).
 *
 * Known simplification: continuation lines (leading whitespace) are preserved
 * verbatim but not interpreted — an ARRAY whose UUID lives on a continuation
 * line is treated as foreign and left alone. ANAS always writes single-line
 * entries, so everything ANAS manages round-trips fully.
 */

/** Whitespace splitter for conf-line tokens. */
const TOKEN_SPLIT = /\s+/

/** md superblock name charset (`<pool>-r<band>` and friends) — conf-safe. */
const ARRAY_NAME_RE = /^[a-z0-9][\w.-]*$/i

/** mdadm UUID: four colon-separated groups of eight hex digits. */
const MD_UUID_RE = /^[0-9a-f]{8}:[0-9a-f]{8}:[0-9a-f]{8}:[0-9a-f]{8}$/i

/** Absolute path with a conf-safe charset (no whitespace — one-token field). */
const PROGRAM_PATH_RE = /^\/[\w./-]+$/

/** A line starting with whitespace continues the previous line (mdadm.conf(5)). */
const CONTINUATION_RE = /^\s/

/** An ARRAY pin ANAS manages: `ARRAY /dev/md/<name> metadata=1.2 UUID=<uuid>`. */
export interface MdadmArrayPin {
  /** md superblock name (becomes /dev/md/<name>), e.g. `tank-r1`. */
  name: string
  /** md array UUID (`aaaaaaaa:bbbbbbbb:cccccccc:dddddddd`) — the identity. */
  uuid: string
}

/** One line of an mdadm.conf document, tagged by whether ANAS interprets it. */
export type MdadmConfLine
  = | { kind: 'array', raw: string, device: string, uuid?: string, name?: string }
    | { kind: 'program', raw: string, program: string }
    | { kind: 'other', raw: string }

export type MdadmConfDoc = MdadmConfLine[]

/** Thrown for a name/uuid/path that cannot be safely written to the conf. */
export class MdadmConfValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MdadmConfValueError'
  }
}

/**
 * Thrown when a PROGRAM line already points somewhere other than the hook
 * being installed. mdadm allows exactly one PROGRAM; overwriting a foreign one
 * would silently break someone else's monitoring (guest philosophy — refuse).
 */
export class MdadmForeignProgramError extends Error {
  constructor(public readonly existingProgram: string) {
    super(`mdadm.conf already has a PROGRAM line pointing at '${existingProgram}' — refusing to overwrite a foreign monitor hook`)
    this.name = 'MdadmForeignProgramError'
  }
}

/**
 * Split the file into lines, preserving newline structure exactly.
 * `text.split('\n')` is losslessly reversible with `join('\n')`.
 */
export function parseMdadmConfDoc(text: string): MdadmConfDoc {
  return text.split('\n').map((raw): MdadmConfLine => parseLine(raw))
}

/** Reassemble a document into text, byte-for-byte for untouched lines. */
export function serializeMdadmConfDoc(doc: MdadmConfDoc): string {
  return doc.map(line => line.raw).join('\n')
}

// --- Read accessors ---------------------------------------------------------

/** Every ARRAY line in the file (file order), foreign ones included. */
export function getArrays(doc: MdadmConfDoc): Array<{ device: string, uuid?: string, name?: string }> {
  const out: Array<{ device: string, uuid?: string, name?: string }> = []
  for (const line of doc) {
    if (line.kind === 'array')
      out.push({ device: line.device, uuid: line.uuid, name: line.name })
  }
  return out
}

/** Is there an ARRAY line for `uuid` (case-insensitive match)? */
export function hasArray(doc: MdadmConfDoc, uuid: string): boolean {
  const want = normalizeUuid(uuid)
  return doc.some(l => l.kind === 'array' && l.uuid !== undefined && normalizeUuid(l.uuid) === want)
}

/** The PROGRAM hook path, or undefined if the file has none. */
export function getProgram(doc: MdadmConfDoc): string | undefined {
  for (const line of doc) {
    if (line.kind === 'program')
      return line.program
  }
  return undefined
}

// --- Surgical edits ---------------------------------------------------------

/**
 * Add or update-by-UUID one ANAS ARRAY pin as a single canonical line
 * (`ARRAY /dev/md/<name> metadata=1.2 UUID=<uuid>`). Every other line is
 * preserved byte-for-byte; an ARRAY line with a different UUID (foreign or
 * another band) is never touched. Mutates and returns `doc`.
 */
export function upsertArray(doc: MdadmConfDoc, pin: MdadmArrayPin): MdadmConfDoc {
  if (!ARRAY_NAME_RE.test(pin.name))
    throw new MdadmConfValueError(`invalid md array name '${pin.name}'`)
  if (!MD_UUID_RE.test(pin.uuid))
    throw new MdadmConfValueError(`invalid md array UUID '${pin.uuid}'`)

  const uuid = normalizeUuid(pin.uuid)
  const line: MdadmConfLine = {
    kind: 'array',
    raw: `ARRAY /dev/md/${pin.name} metadata=1.2 UUID=${uuid}`,
    device: `/dev/md/${pin.name}`,
    uuid,
    name: pin.name,
  }

  const existing = doc.find(l => l.kind === 'array' && l.uuid !== undefined && normalizeUuid(l.uuid) === uuid)
  if (existing)
    Object.assign(existing, line)
  else
    appendLine(doc, line)
  return doc
}

/** Remove ONLY the ARRAY line for `uuid` (case-insensitive). No-op if absent. */
export function removeArray(doc: MdadmConfDoc, uuid: string): MdadmConfDoc {
  const want = normalizeUuid(uuid)
  const idx = doc.findIndex(l => l.kind === 'array' && l.uuid !== undefined && normalizeUuid(l.uuid) === want)
  if (idx !== -1)
    doc.splice(idx, 1)
  return doc
}

/**
 * Install the single PROGRAM hook line. No PROGRAM present → append
 * `PROGRAM <path>`. Already pointing at `path` → byte-identical no-op.
 * Pointing anywhere else → throw MdadmForeignProgramError (never overwrite a
 * hook ANAS does not own). Mutates and returns `doc`.
 */
export function upsertProgram(doc: MdadmConfDoc, path: string): MdadmConfDoc {
  if (!PROGRAM_PATH_RE.test(path))
    throw new MdadmConfValueError(`invalid PROGRAM hook path '${path}'`)

  const existing = doc.find(l => l.kind === 'program')
  if (existing && existing.kind === 'program') {
    if (existing.program === path)
      return doc // already ours — leave the line's bytes alone
    throw new MdadmForeignProgramError(existing.program)
  }

  appendLine(doc, { kind: 'program', raw: `PROGRAM ${path}`, program: path })
  return doc
}

/**
 * Remove the PROGRAM line. With `path` given, removes it ONLY if it points at
 * `path` (a foreign hook is left untouched — no-op, so uninstall stays
 * idempotent). Without `path`, removes whatever PROGRAM line exists.
 */
export function removeProgram(doc: MdadmConfDoc, path?: string): MdadmConfDoc {
  const idx = doc.findIndex(l => l.kind === 'program' && (path === undefined || l.program === path))
  if (idx !== -1)
    doc.splice(idx, 1)
  return doc
}

// --- Internals --------------------------------------------------------------

/** Lowercase a UUID for identity comparison (mdadm hex is case-insensitive). */
function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase()
}

/**
 * Classify one raw line. Comments, blanks, continuation lines, unknown
 * keywords, and malformed ARRAY/PROGRAM lines are all `other` (preserved
 * verbatim, never interpreted — fail-open).
 */
function parseLine(raw: string): MdadmConfLine {
  // Continuation of the previous line — preserved verbatim, not interpreted.
  if (CONTINUATION_RE.test(raw))
    return { kind: 'other', raw }

  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#'))
    return { kind: 'other', raw }

  const tokens = trimmed.split(TOKEN_SPLIT)
  const keyword = tokens[0]

  if (keywordIs(keyword, 'ARRAY') && tokens.length >= 2) {
    const device = tokens[1]
    let uuid: string | undefined
    let name: string | undefined
    for (const token of tokens.slice(2)) {
      const eq = token.indexOf('=')
      if (eq === -1)
        continue
      const key = token.slice(0, eq).toLowerCase()
      const value = token.slice(eq + 1)
      if (key === 'uuid' && MD_UUID_RE.test(value))
        uuid = normalizeUuid(value)
      else if (key === 'name')
        name = value
    }
    return { kind: 'array', raw, device, uuid, name }
  }

  if (keywordIs(keyword, 'PROGRAM') && tokens.length >= 2)
    return { kind: 'program', raw, program: tokens[1] }

  return { kind: 'other', raw }
}

/**
 * mdadm.conf keywords are case-insensitive and may be abbreviated to three or
 * more characters (`ARR`, `prog`, …) — match accordingly.
 */
function keywordIs(token: string, keyword: string): boolean {
  const upper = token.toUpperCase()
  return upper.length >= 3 && keyword.startsWith(upper)
}

/**
 * Append a new line, inserting before the trailing-newline sentinel so the
 * file stays newline-terminated (same idiom as the fstab editor).
 */
function appendLine(doc: MdadmConfDoc, line: MdadmConfLine): void {
  const last = doc.at(-1)
  if (last && last.kind === 'other' && last.raw === '')
    doc.splice(doc.length - 1, 0, line) // keep the trailing newline last
  else
    doc.push(line)
}
