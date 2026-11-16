import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The /etc/fstab owners, enforced on the source itself: services/fstab-file.ts
 * owns which file is the fstab and what a failed read means, parsers/fstab.ts
 * owns what the text means (including which line is a mountpoint's), and no
 * other file may re-derive an owned fact even while its derivation agrees.
 * A second path to the same fact drifts the moment the owner changes, so each
 * rule below fails the suite when a line outside the owner asks the owner's
 * question, and every failure names the owner to ask instead.
 *
 * The allow-list is the whole record of survivors: an entry no longer matching
 * anything fails the test too, so the list cannot rot.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

interface OwnerRule {
  /** Short name shared with the allow-list entries. */
  name: string
  /** A line that re-derives the owned fact, right there outside the owner. */
  re: RegExp
  /** The file allowed to derive this fact; hits inside it are the owner's work. */
  home: string
  /** What was found and where to ask instead — said on every failure. */
  message: string
}

const RULES: OwnerRule[] = [
  { name: 'read', re: /(readFile|readFileSync|readConfig|readConfigOr)\([^)]*fstab/i, home: 'services/fstab-file.ts', message: 'reads the fstab itself: use readFstab or readFstabAbsentAsEmpty (services/fstab-file.ts)' },
  { name: 'path', re: /(\?\?|\|\||=) '\/etc\/fstab'|process\.env\.ANAS_FSTAB_PATH/, home: 'services/fstab-file.ts', message: 'decides the fstab path: use configuredFstabPath()' },
  { name: 'text', re: /serializeFstabDoc/, home: 'parsers/fstab.ts', message: 'edits the fstab document by hand: add or use a text-in, text-out function in parsers/fstab.ts' },
  { name: 'line', re: /parseFstabDoc\(/, home: 'parsers/fstab.ts', message: 'scans the fstab document for a line: use mountLine / linesFor (parsers/fstab.ts)' },
]

/**
 * One survivor: a file holding `max` allowed calls of `rule`'s question. A
 * `pattern` narrows which lines the entry covers; without one, the rule's own
 * pattern does. `reason` says why the survivor stays.
 */
interface AllowEntry {
  rule: string
  file: string
  pattern?: RegExp
  max: number
  reason: string
}

const ALLOW: AllowEntry[] = [
  { rule: 'path', file: 'server.ts', pattern: /const envFstabPath = process\.env\.ANAS_FSTAB_PATH/, max: 1, reason: 'server.ts asks whether the operator set a path, for mock seeding' },
  { rule: 'line', file: 'services/mounts.ts', max: 1, reason: 'fstabLineFor returns the display line, the first that is not a `#` comment line — a different question from `mountLine`' },
]

interface ScanHit {
  file: string
  line: number
  rule: string
  text: string
}

function isComment(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'fixtures')
        continue
      out.push(...sources(path))
    }
    else if (entry.name.endsWith('.ts')) {
      out.push(path)
    }
  }
  return out
}

function describeHit(h: ScanHit): string {
  const rule = RULES.find(r => r.name === h.rule)!
  return `${h.file}:${h.line}: ${h.text.trim()} — ${rule.message}`
}

function describeGone(a: AllowEntry): string {
  return `${a.rule} in ${a.file} (${a.reason}) — allowed survivor is gone: remove it from the list`
}

/**
 * Scan every *.ts under `root` (excluding `__tests__` directories and
 * `fixtures`, comment lines ignored) for the owned facts; an allow entry
 * covers its file's hits up to `max`. Returns the reported hits and the allow
 * entries that match nothing any more (both are failures on the real tree).
 */
function scanFstabOwners(root: string, allows: AllowEntry[]): { hits: ScanHit[], gone: AllowEntry[] } {
  const hits: ScanHit[] = []
  const spent = new Map<AllowEntry, number>()
  for (const path of sources(root)) {
    const file = relative(root, path)
    readFileSync(path, 'utf8').split('\n').forEach((text, i) => {
      if (isComment(text))
        return
      for (const rule of RULES) {
        if (file === rule.home || !rule.re.test(text))
          continue
        const spare = allows.find(a =>
          a.rule === rule.name && a.file === file
          && (a.pattern === undefined || a.pattern.test(text))
          && (spent.get(a) ?? 0) < a.max)
        if (spare)
          spent.set(spare, (spent.get(spare) ?? 0) + 1)
        else
          hits.push({ file, line: i + 1, rule: rule.name, text })
      }
    })
  }
  const gone = allows.filter((a) => {
    const path = join(root, a.file)
    const re = a.pattern ?? RULES.find(r => r.name === a.rule)!.re
    try {
      return !readFileSync(path, 'utf8').split('\n').some(l => !isComment(l) && re.test(l))
    }
    catch {
      return true
    }
  })
  return { hits, gone }
}

describe('the fstab owners: no owned fact derived outside its owner', () => {
  const scan = scanFstabOwners(SRC, ALLOW)

  it('the daemon tree holds no second path to an fstab fact', () => {
    assert.deepEqual(scan.hits.map(describeHit), [])
  })

  it('every allow entry still allows something real', () => {
    assert.deepEqual(scan.gone.map(describeGone), [])
  })
})

describe('the scan proves each rule (and the comment fence) on planted files', () => {
  const root = mkdtempSync(join(tmpdir(), 'fstab-owners-'))
  writeFileSync(join(root, 'breaks-read.ts'), 'const text = await readFile(fstabPath, \'utf8\')\n')
  writeFileSync(join(root, 'breaks-path.ts'), 'const fallback = opts.path ?? \'/etc/fstab\'\n')
  writeFileSync(join(root, 'breaks-text.ts'), 'const out = serializeFstabDoc(doc)\n')
  writeFileSync(join(root, 'breaks-line.ts'), 'const doc = parseFstabDoc(text)\n')
  writeFileSync(join(root, 'commented.ts'), [
    '// const text = await readFile(fstabPath, \'utf8\')',
    '// const fallback = opts.path ?? \'/etc/fstab\'',
    '// const out = serializeFstabDoc(doc)',
    '/* const doc = parseFstabDoc(text) */',
    'const nothing = 1',
    '',
  ].join('\n'))

  const scan = scanFstabOwners(root, [])

  it('each planted file is reported once, under its own rule; the commented file is not reported', () => {
    assert.deepEqual(scan.hits.map(h => `${h.file} ${h.rule}`).sort(), [
      'breaks-line.ts line',
      'breaks-path.ts path',
      'breaks-read.ts read',
      'breaks-text.ts text',
    ])
  })

  it('a hit names the file and line and says which owner to ask', () => {
    const hit = scan.hits.find(h => h.file === 'breaks-text.ts')!
    assert.equal(hit.line, 1)
    assert.match(describeHit(hit), /^breaks-text\.ts:1: .*edits the fstab document by hand: add or use a text-in, text-out function in parsers\/fstab\.ts$/)
  })
})
