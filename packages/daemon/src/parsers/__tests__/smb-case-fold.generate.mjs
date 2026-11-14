#!/usr/bin/env node
/*
 * Generates fixtures/samba/smb-case-fold.json — Samba's OWN answer to "are
 * these two section names one service?" for every case pair a JavaScript
 * engine knows (cr3.shares, fourth review D-F).
 *
 * How: every code point's simple upper and lower case mappings (single code
 * point results only) are edges; each connected group of two or more code
 * points is a case class (1499 classes on node 26 / Unicode 17). Every PAIR
 * inside a class is asked of testparm: a conf with the sections `[q<a>]` and
 * `[q<b>]` (the `q` keeps every name an ordinary share). testparm serves the
 * first; the second is served too when Samba keeps them apart, and is merged
 * into the first when it does not. Pairs of different classes share a conf
 * (they never interact), so the whole table is one conf per pair index.
 *
 * The verdicts are an equivalence (checked here: no pair kept apart may sit
 * in a class the merges joined); the fold maps each code point to the LOWEST
 * code point of its merged class, and the runs are that map compressed:
 * `[first, count, step, delta]` — `first + i*step` (i < count) folds to
 * itself + delta. parsers/smb-conf.ts carries the runs verbatim; its test
 * checks them against the verdicts in both directions.
 *
 * Run (needs Samba's testparm; writes nothing but the fixture, works in a
 * scratch directory under the worktree's t/):
 *   node packages/daemon/src/parsers/__tests__/smb-case-fold.generate.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'fixtures', 'samba', 'smb-case-fold.json')
const SCRATCH_PARENT = join(HERE, '..', '..', '..', '..', '..', 't')
const HEADER_RE = /^\[(.*)\]\s*$/gm

const adj = new Map()
function edge(a, b) {
  if (a === b)
    return
  for (const [x, y] of [[a, b], [b, a]]) {
    if (!adj.has(x))
      adj.set(x, new Set())
    adj.get(x).add(y)
  }
}
for (let cp = 0; cp <= 0x10FFFF; cp++) {
  if (cp >= 0xD800 && cp <= 0xDFFF)
    continue
  const c = String.fromCodePoint(cp)
  for (const m of [c.toUpperCase(), c.toLowerCase()]) {
    const one = [...m]
    if (one.length === 1)
      edge(cp, one[0].codePointAt(0))
  }
}

const seen = new Set()
const classes = []
for (const k of [...adj.keys()].toSorted((a, b) => a - b)) {
  if (seen.has(k))
    continue
  const stack = [k]
  const members = []
  seen.add(k)
  while (stack.length > 0) {
    const x = stack.pop()
    members.push(x)
    for (const y of adj.get(x)) {
      if (!seen.has(y)) {
        seen.add(y)
        stack.push(y)
      }
    }
  }
  classes.push(members.sort((a, b) => a - b))
}

function pairsOf(c) {
  const out = []
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++)
      out.push([c[i], c[j]])
  }
  return out
}
const perClass = classes.map(pairsOf)
const rounds = Math.max(...perClass.map(p => p.length))
const heads = text => new Set(Array.from(text.matchAll(HEADER_RE), m => m[1]))

mkdirSync(SCRATCH_PARENT, { recursive: true })
const work = mkdtempSync(join(SCRATCH_PARENT, 'smb-case-fold-'))
const verdicts = []
let version
try {
  version = execFileSync('testparm', ['--version'], { encoding: 'utf8' }).trim()
  for (let r = 0; r < rounds; r++) {
    const pairs = perClass.map(p => p[r]).filter(Boolean)
    const lines = ['[global]', '\tworkgroup = W']
    let n = 0
    for (const pair of pairs) {
      for (const x of pair)
        lines.push(`[q${String.fromCodePoint(x)}]`, `\tpath = /srv/${n++}`)
    }
    const conf = join(work, `round${r}.conf`)
    writeFileSync(conf, `${lines.join('\n')}\n`)
    const served = heads(execFileSync('testparm', ['-s', conf], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    for (const [a, b] of pairs) {
      if (!served.has(`q${String.fromCodePoint(a)}`))
        throw new Error(`testparm did not serve the first of the pair U+${a.toString(16)} / U+${b.toString(16)}`)
      verdicts.push([a, b, !served.has(`q${String.fromCodePoint(b)}`)])
    }
  }
}
finally {
  rmSync(work, { recursive: true, force: true })
}

const parent = new Map()
function find(x) {
  while (parent.has(x) && parent.get(x) !== x)
    x = parent.get(x)
  return x
}
for (const [a, b, merged] of verdicts) {
  if (!merged)
    continue
  const ra = find(a)
  const rb = find(b)
  if (ra !== rb) {
    parent.set(Math.max(ra, rb), Math.min(ra, rb))
    parent.set(Math.min(ra, rb), Math.min(ra, rb))
  }
}
for (const [a, b, merged] of verdicts) {
  if (!merged && find(a) === find(b))
    throw new Error(`testparm's verdicts are not an equivalence: U+${a.toString(16)} / U+${b.toString(16)}`)
}
const map = Array.from(parent.keys(), k => [k, find(k)]).filter(([k, r]) => k !== r).sort((a, b) => a[0] - b[0])
const runs = []
for (const [c, r] of map) {
  const d = r - c
  const last = runs.at(-1)
  if (last && last[3] === d && (last[1] === 1 ? c - last[0] <= 2 : c === last[0] + last[1] * last[2])) {
    if (last[1] === 1)
      last[2] = c - last[0]
    last[1]++
  }
  else {
    runs.push([c, 1, 1, d])
  }
}

writeFileSync(OUT, `${JSON.stringify({
  producedBy: 'packages/daemon/src/parsers/__tests__/smb-case-fold.generate.mjs (testparm -s over every pair of every JavaScript simple-case class)',
  testparm: version,
  node: process.version,
  classes: classes.length,
  verdicts,
  runs,
})}\n`)
process.stdout.write(`${verdicts.length} pairs (${verdicts.filter(v => v[2]).length} merged by Samba), ${map.length} folds in ${runs.length} runs -> ${OUT}\n`)
