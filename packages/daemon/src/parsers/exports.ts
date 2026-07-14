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
 * one line for a given path; every other line's `raw` is emitted unchanged.
 */

/** Whitespace matcher (path/client boundaries). */
const WHITESPACE = /\s/
/** Whitespace splitter for the client region. */
const WHITESPACE_SPLIT = /\s+/

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
  return text.split('\n').map((raw): DocLine => {
    const parsed = parseExportLine(raw)
    return parsed
      ? { kind: 'export', raw, path: parsed.path, clients: parsed.clients }
      : { kind: 'other', raw }
  })
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
      line.raw = serializeExportLine(exp)
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
 * Parse one raw line into an export, or null for comments, blanks, and lines
 * that are not recognizable as an export (which are preserved verbatim as
 * `other`).
 */
function parseExportLine(raw: string): { path: string, clients: NfsClient[] } | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#'))
    return null

  let path: string
  let rest: string
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    if (end === -1)
      return null // unterminated quote — leave the line untouched
    path = trimmed.slice(1, end)
    rest = trimmed.slice(end + 1)
  }
  else {
    const sp = trimmed.search(WHITESPACE)
    if (sp === -1) {
      path = trimmed
      rest = ''
    }
    else {
      path = trimmed.slice(0, sp)
      rest = trimmed.slice(sp)
    }
  }

  // Exports are absolute paths; anything else is not an export line we manage.
  if (!path.startsWith('/'))
    return null

  return { path, clients: parseClients(rest) }
}

/** Parse the whitespace-separated client region into specs + option lists. */
function parseClients(rest: string): NfsClient[] {
  const clients: NfsClient[] = []
  for (const token of rest.trim().split(WHITESPACE_SPLIT)) {
    if (!token)
      continue
    const open = token.indexOf('(')
    if (open !== -1 && token.endsWith(')')) {
      const spec = token.slice(0, open)
      const optStr = token.slice(open + 1, -1)
      const options = optStr === '' ? [] : optStr.split(',').map(o => o.trim()).filter(Boolean)
      clients.push({ spec, options })
    }
    else {
      clients.push({ spec: token, options: [] })
    }
  }
  return clients
}
