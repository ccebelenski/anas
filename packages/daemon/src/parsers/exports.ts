import type { NfsClient, NfsExport } from '@anas/shared'

/**
 * Round-trip parser and surgical editor for /etc/exports (see exports(5)).
 *
 * /etc/exports is line-based. Each non-comment, non-blank line is:
 *
 *   <path> <client>(<opts>) <client2>(<opts>) …
 *
 * where a client is a host / IP / subnet / wildcard and <opts> is a
 * comma-separated option list (rw, sync, no_subtree_check, root_squash, …).
 * A client may appear with no parens (NFS defaults). Comments start with `#`.
 * A path containing whitespace is double-quoted.
 *
 * ANAS is a guest on the system (Principle 12): it makes surgical, line-level
 * edits and preserves everything it does not touch — comments, ordering,
 * whitespace, blank lines, and unknown/hand-maintained lines — BYTE-FOR-BYTE.
 *
 * The document model below keeps every line's original text verbatim in `raw`
 * and only interprets export lines. `serializeExportsDoc(parseExportsDoc(t))`
 * reproduces `t` exactly. Surgical edits (add/replace/remove) rewrite only the
 * one entry for a given path; every other line's `raw` is emitted unchanged.
 *
 * ── Read the way exportfs reads (cr3.shares M5) ──
 * exports(5), verbatim: "A pound sign ("#") introduces a comment to the end
 * of the line. Entries may be continued across newlines using a backslash. If
 * an export name contains spaces it should be quoted using double quotes. You
 * can also specify spaces or other unusual character in the export name using
 * a backslash followed by the character code as three octal digits." and
 * "each line may have one or more specifications for default options after
 * the path name, in the form of a dash ("-") followed by an option list. The
 * option list is used for all subsequent exports on that line only."
 * So: a physical line ending in `\` joins the next (nfs-utils' reader turns
 * the backslash-newline into one blank and skips the next line's leading
 * blanks) and the whole entry is ONE document line — removed or replaced
 * whole, never leaving an orphaned continuation; a `#` at the start of a
 * token ends the entry; a double quote toggles quoting anywhere in a token;
 * `\ooo` in the export name is the byte it names; a `-opts` token sets the
 * defaults every later client on the entry starts from. Separators are
 * C `isspace` (ASCII), never `\s`'s Unicode set.
 */

/** C `isspace` in the C locale: exportfs's separators (never U+00A0). */
const EXPORTS_WS = ' \t\n\v\f\r'
/** Path needs quoting on write: any exportfs separator in it. */
const WHITESPACE = /[\t\n\v\f\r ]/
/** The blanks nfs-utils skips at the start of a continued line. */
const CONTINUATION_LEAD_RE = /^[\t ]*/
/** A carriage return at the end of a CRLF line. */
const TRAILING_CR_RE = /\r$/

/**
 * Where a physical line's comment starts: a `#` at the start of a token (the
 * line's start or after a blank), outside a quoted span — or -1.
 */
function commentAt(line: string): number {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"')
      quoted = !quoted
    else if (c === '#' && !quoted && (i === 0 || EXPORTS_WS.includes(line[i - 1])))
      return i
  }
  return -1
}

/** `\ooo` — an octal escape in the export name. */
const OCTAL_DIGIT_RE = /^[0-7]{3}$/

/** One line of an /etc/exports document, tagged by whether it is an export. */
export type DocLine
  = | { kind: 'export', raw: string, path: string, clients: NfsClient[] }
    | { kind: 'other', raw: string }

/**
 * Split the file into lines, preserving newline structure exactly.
 *
 * `text.split('\n')` is losslessly reversible with `join('\n')`: a trailing
 * newline shows up as a final empty element, and a file with no trailing
 * newline has a non-empty final element. We never mutate that structure except
 * where an edit intends to.
 */
export function parseExportsDoc(text: string): DocLine[] {
  const lines = text.split('\n')
  const doc: DocLine[] = []
  for (let i = 0; i < lines.length;) {
    // One ENTRY: this physical line and every line a trailing backslash
    // continues it onto (`raw` keeps them joined by '\n', byte-exact).
    // A backslash inside a comment continues nothing: a comment runs to the
    // PHYSICAL end of its line (exports(5); cr3.shares review — a `# ... \`
    // line must never swallow the export after it).
    let last = i
    while (lines[last].endsWith('\\') && commentAt(lines[last]) === -1 && last + 1 < lines.length)
      last++
    const raw = lines.slice(i, last + 1).join('\n')
    let logical = ''
    for (let k = i; k <= last; k++) {
      const part = k > i ? lines[k].replace(CONTINUATION_LEAD_RE, '') : lines[k]
      logical += k < last ? `${part.slice(0, -1)} ` : part
    }
    const parsed = parseExportLine(logical)
    doc.push(parsed
      ? { kind: 'export', raw, path: parsed.path, clients: parsed.clients }
      : { kind: 'other', raw })
    i = last + 1
  }
  return doc
}

/** Reassemble a document into text, byte-for-byte for untouched lines. */
export function serializeExportsDoc(doc: DocLine[]): string {
  return doc.map(line => line.raw).join('\n')
}

/** All exports in the file (in file order), for the API list/detail views. */
export function parseExports(text: string): NfsExport[] {
  const exports: NfsExport[] = []
  for (const line of parseExportsDoc(text)) {
    if (line.kind === 'export')
      exports.push({ path: line.path, clients: line.clients })
  }
  return exports
}

/** The export for `path`, or undefined if the file does not export it. */
export function getExport(text: string, path: string): NfsExport | undefined {
  return parseExports(text).find(e => e.path === path)
}

/** Is `path` currently exported? */
export function hasExport(text: string, path: string): boolean {
  return parseExportsDoc(text).some(l => l.kind === 'export' && l.path === path)
}

/**
 * Append a new export as a single line, preserving the rest of the file
 * byte-for-byte. Inserts before the trailing-newline sentinel so the file
 * stays newline-terminated.
 */
export function addExport(text: string, exp: NfsExport): string {
  const doc = parseExportsDoc(text)
  const line: DocLine = { kind: 'export', raw: serializeExportLine(exp), path: exp.path, clients: exp.clients }
  const last = doc.at(-1)
  if (last && last.kind === 'other' && last.raw === '')
    doc.splice(doc.length - 1, 0, line) // keep the trailing newline last
  else
    doc.push(line)
  return serializeExportsDoc(doc)
}

/**
 * Replace ONLY the line for `path` with a freshly serialized line (new client
 * list). Every other line is emitted unchanged. No-op if `path` is absent.
 */
export function replaceExport(text: string, path: string, exp: NfsExport): string {
  const doc = parseExportsDoc(text)
  for (const line of doc) {
    if (line.kind === 'export' && line.path === path) {
      // cr3.shares (review): a client list that is what the entry already
      // says is no edit — the entry keeps its bytes (its continuations and
      // comments included). A real edit writes one line and keeps the
      // entry's trailing `# note`.
      if (JSON.stringify(line.clients) === JSON.stringify(exp.clients))
        break
      const lastLine = line.raw.slice(line.raw.lastIndexOf('\n') + 1)
      const at = commentAt(lastLine)
      const note = at === -1 ? '' : ` ${lastLine.slice(at).replace(TRAILING_CR_RE, '')}`
      line.raw = serializeExportLine(exp) + note + (lastLine.endsWith('\r') ? '\r' : '')
      line.clients = exp.clients
      // path is unchanged (it is the key); only the client list is replaced.
      break
    }
  }
  return serializeExportsDoc(doc)
}

/** Remove ONLY the line for `path`. No-op if `path` is absent. */
export function removeExport(text: string, path: string): string {
  const doc = parseExportsDoc(text)
  const idx = doc.findIndex(l => l.kind === 'export' && l.path === path)
  if (idx !== -1)
    doc.splice(idx, 1)
  return serializeExportsDoc(doc)
}

/** Serialize one export to a single /etc/exports line. */
export function serializeExportLine(exp: NfsExport): string {
  const path = WHITESPACE.test(exp.path) ? `"${exp.path}"` : exp.path
  const clients = exp.clients
    .map(c => (c.options.length > 0 ? `${c.spec}(${c.options.join(',')})` : c.spec))
    .join(' ')
  return clients ? `${path} ${clients}` : path
}

// --- Internals --------------------------------------------------------------

/**
 * An entry's tokens the way exportfs reads them: separated by ASCII blanks, a
 * double quote toggling quoting (and dropped), a `#` at the start of a token
 * ending the entry. Null for an unterminated quote — the line is not one ANAS
 * can read, and stays untouched as `other`.
 */
function tokens(logical: string): string[] | null {
  const out: string[] = []
  let i = 0
  while (i < logical.length) {
    while (i < logical.length && EXPORTS_WS.includes(logical[i]))
      i++
    if (i >= logical.length || logical[i] === '#')
      break
    let tok = ''
    let quoted = false
    while (i < logical.length && (quoted || !EXPORTS_WS.includes(logical[i]))) {
      if (logical[i] === '"')
        quoted = !quoted
      else
        tok += logical[i]
      i++
    }
    if (quoted)
      return null
    out.push(tok)
  }
  return out
}

/** The export name with each `\ooo` octal escape replaced by the byte it names. */
function unescapeExportName(name: string): string {
  if (!name.includes('\\'))
    return name
  const bytes: number[] = []
  for (let i = 0; i < name.length;) {
    const oct = name.slice(i + 1, i + 4)
    if (name[i] === '\\' && OCTAL_DIGIT_RE.test(oct)) {
      bytes.push(Number.parseInt(oct, 8) & 0xFF)
      i += 4
      continue
    }
    const cp = name.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    bytes.push(...Buffer.from(ch, 'utf8'))
    i += ch.length
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Parse one logical entry into an export, or null for comments, blanks, and
 * lines that are not recognizable as an export (which are preserved verbatim
 * as `other`).
 */
function parseExportLine(logical: string): { path: string, clients: NfsClient[] } | null {
  const toks = tokens(logical)
  if (!toks || toks.length === 0)
    return null
  const path = unescapeExportName(toks[0])
  // Exports are absolute paths; anything else is not an export line we manage.
  if (!path.startsWith('/'))
    return null
  return { path, clients: parseClients(toks.slice(1)) }
}

/** The option list inside `(...)` or after a `-`. */
function optionList(s: string): string[] {
  return s === '' ? [] : s.split(',').map(o => o.trim()).filter(Boolean)
}

/**
 * The client tokens into specs + option lists. A `-opts` token is the
 * defaults every LATER client on the entry starts from; a client's own
 * `(opts)` follow them (exportfs applies the defaults first).
 */
function parseClients(toks: string[]): NfsClient[] {
  const clients: NfsClient[] = []
  let defaults: string[] = []
  for (const token of toks) {
    if (token.startsWith('-')) {
      defaults = optionList(token.slice(1))
      continue
    }
    const open = token.indexOf('(')
    if (open !== -1 && token.endsWith(')'))
      clients.push({ spec: token.slice(0, open), options: [...defaults, ...optionList(token.slice(open + 1, -1))] })
    else
      clients.push({ spec: token, options: [...defaults] })
  }
  return clients
}
