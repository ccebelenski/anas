#!/usr/bin/env node
/*
 * ANAS — gfx.capSegments harness (dshero.1, GitHub #70).
 *
 * Same shape as gfx-timechart.harness.mjs: the PVE injection scripts are
 * browser ES5 with no unit-test wiring, so the PURE helper's behaviour is
 * proven by loading the real 15-gfx.js into a node:vm sandbox and asserting
 * on returned data. capSegments bounds the Datasets hero's legend height —
 * the pinned contract:
 *
 *   - the `max` largest positive non-free segments survive, value-descending
 *   - everything else (the remainder AND zero-value segments) folds into ONE
 *     "{n} more" roll-up whose value is the remaining sum and whose `names`
 *     lists the folded labels
 *   - free:true segments pass through last, unchanged, never counted toward
 *     max
 *   - at or under max there is no roll-up
 *   - the legend renders the roll-up's names as the row's tooltip, so donut
 *     and legend drawn from the SAME capped array agree
 *
 *   node packages/pve-integration/test/gfx-cap-segments.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const GFX = join(HERE, '..', 'src', '15-gfx.js')

// ---- Minimal DOM + ANAS stub (copied from gfx-timechart.harness.mjs) --------

function makeEl() {
  return {
    id: '',
    type: '',
    className: '',
    style: {},
    childNodes: [],
    firstChild: null,
    set innerHTML(_v) { this.firstChild = makeEl() },
    appendChild(c) { this.childNodes.push(c); return c },
    setAttribute() {},
  }
}

function loadGfx() {
  const doc = {
    cookie: '',
    head: makeEl(),
    body: makeEl(),
    documentElement: makeEl(),
    createElement: () => makeEl(),
    createTextNode: t => ({ text: t }),
    getElementById: () => null,
    getElementsByTagName: () => [],
  }
  const win = {
    document: doc,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  }
  win.ANAS = {
    enc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    formatBytes(bytes) {
      if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes))) { return '' }
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
      let order = 0
      let size = Number(bytes)
      while (size >= 1024 && order < units.length - 1) { size = size / 1024; order++ }
      return `${size.toFixed(order === 0 ? 0 : 2)} ${units[order]}`
    },
    warn(m) { throw new Error(`gfx warned: ${m}`) },
    // Marks translated strings so the harness can see they went through t().
    t: s => (s === 'more' ? '[more]' : s),
  }
  const sandbox = { window: win, document: doc, console }
  vm.runInNewContext(readFileSync(GFX, 'utf8'), sandbox, { filename: '15-gfx.js' })
  return win.ANAS.gfx
}

const gfx = loadGfx()

// ---- Assertions -------------------------------------------------------------

const failures = []
let checks = 0

function ok(label, cond, detail) {
  checks++
  if (!cond) { failures.push(`${label}${detail ? ` — ${detail}` : ''}`) }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const MiB = 1024 * 1024
const GiB = 1024 * 1024 * 1024

// `n` synthetic guest-volume-shaped segments, values 1..n GiB, plus Free.
function synthetic(n) {
  const out = []
  for (let i = 1; i <= n; i++) { out.push({ label: `vm-${i}-disk-0`, value: i * GiB }) }
  out.push({ label: 'Free', value: 500 * GiB, free: true })
  return out
}

// --- 1. The 60-segment case: max 8 named + one roll-up + Free last -----------

{
  const capped = gfx.capSegments(synthetic(60))
  eq('60 in → 10 out (8 + roll-up + Free)', capped.length, 10)

  const named = capped.slice(0, 8)
  ok('the 8 largest survive', named.every(s => !s.free && !s.more))
  eq('largest is #60', named[0].label, 'vm-60-disk-0')
  eq('8th largest is #53', named[7].label, 'vm-53-disk-0')
  for (let i = 1; i < named.length; i++) {
    ok(`descending order at ${i}`, named[i - 1].value > named[i].value,
      `${named[i - 1].value} then ${named[i].value}`)
  }

  const roll = capped[8]
  ok('roll-up is flagged', !!roll.more)
  eq('roll-up label', roll.label, '52 [more]')
  eq('roll-up value is the remaining sum',
    roll.value, [...Array(52).keys()].map(i => (i + 1) * GiB).reduce((a, b) => a + b))
  eq('roll-up names carry every folded label', roll.names.length, 52)
  ok('roll-up names start just below the cap', roll.names[0] === 'vm-52-disk-0')
  ok('roll-up names end at the smallest', roll.names[51] === 'vm-1-disk-0')

  const free = capped[9]
  ok('Free passes through last, unchanged', free.free === true && free.label === 'Free'
    && free.value === 500 * GiB)

  // The caller feeds the SAME capped array to donut and legend — their row
  // counts must agree (the #70 invariant: ring and list never disagree).
  const legend = gfx.legend(capped, { format: v => gfx.rungLabel(v) })
  const donut = gfx.donut(capped, { total: 1000 * GiB })
  eq('legend rows match segments', (legend.match(/anas-gfx-legend-row/g) || []).length, 10)
  eq('donut arcs match segments', (donut.match(/<circle/g) || []).length, 10)
  // The roll-up row carries the folded names as its tooltip.
  ok('roll-up row tooltip lists the folded names',
    legend.includes('title="vm-52-disk-0, vm-51-disk-0'))
  ok('named rows carry no tooltip', !legend.includes('title="vm-60-disk-0'))
}

// --- 2. At or under max: no roll-up -------------------------------------------

{
  const capped = gfx.capSegments(synthetic(5))
  eq('5 in (under max) → 6 out', capped.length, 6)
  ok('no roll-up under max', capped.every(s => !s.more))
  eq('under max: sorted value-descending, Free last',
    capped.map(s => s.label).join(','), 'vm-5-disk-0,vm-4-disk-0,vm-3-disk-0,vm-2-disk-0,vm-1-disk-0,Free')

  const exact = gfx.capSegments(synthetic(8))
  eq('exactly max → 9 out (8 + Free)', exact.length, 9)
  ok('no roll-up at exactly max', exact.every(s => !s.more))
}

// --- 3. Free is never counted toward max --------------------------------------

{
  // 8 positive segments AND two free-shaped rows: all 8 named survive.
  const segs = synthetic(8)
  segs.push({ label: 'Free (2nd)', value: 1 * GiB, free: true })
  const capped = gfx.capSegments(segs)
  eq('free rows never crowd out named ones', capped.length, 10)
  ok('both free rows pass through at the tail',
    capped[8].free === true && capped[9].free === true && capped[9].label === 'Free (2nd)')
}

// --- 4. Zero-value segments always count as "the rest" ------------------------

{
  const segs = [
    { label: 'a', value: 3 * GiB },
    { label: 'b', value: 2 * GiB },
    { label: 'c', value: 1 * GiB },
    { label: 'empty-1', value: 0 },
    { label: 'empty-2', value: undefined },
    { label: 'Free', value: 9 * GiB, free: true },
  ]
  const capped = gfx.capSegments(segs)
  eq('zeros fold even when there is room', capped.length, 5)
  const roll = capped[3]
  ok('zero roll-up is flagged', !!roll.more)
  eq('zero roll-up label', roll.label, '2 [more]')
  eq('zero roll-up value', roll.value, 0)
  eq('zero roll-up names', roll.names.join(','), 'empty-1,empty-2')
  ok('Free still last', capped[4].free === true)
}

// --- 5. Degenerate inputs stay pure and total ---------------------------------

eq('no segments → empty list', gfx.capSegments([]).length, 0)
eq('undefined segments → empty list', gfx.capSegments(undefined).length, 0)
eq('free only → passes through', gfx.capSegments([{ label: 'Free', value: 1, free: true }]).length, 1)
ok('input array is never mutated', (() => {
  const segs = synthetic(12)
  const before = segs.map(s => s.label).join(',')
  gfx.capSegments(segs)
  return segs.map(s => s.label).join(',') === before
})())
ok('custom max honoured', gfx.capSegments(synthetic(10), { max: 3 }).length === 5)
ok('bogus max falls back to 8', gfx.capSegments(synthetic(10), { max: -1 }).length === 10)

// --- 6. Malformed entries: null never throws, negatives never shrink ---------

{
  let capped
  let threw = null
  try {
    capped = gfx.capSegments([{ label: 'a', value: 2 * GiB }, null, { label: 'Free', value: GiB, free: true }])
  } catch (e) { threw = e }
  ok('a null entry does not throw', threw === null, threw && threw.message)
  if (capped) {
    eq('null entry → a + roll-up + Free', capped.length, 3)
    ok('null entry rolls up with value 0', capped[1].more === true && capped[1].value === 0,
      JSON.stringify(capped[1]))
    eq('null entry folds as an empty name', capped[1].names.join('|'), '')
  }

  const neg = gfx.capSegments([
    { label: 'a', value: 5 * GiB },
    { label: 'b', value: -3 * GiB },
    { label: 'c', value: 0 },
  ])
  eq('negative entry → a + roll-up', neg.length, 2)
  eq('negative value counts as 0 in the roll-up', neg[1].value, 0)
  eq('negative entry still named in the roll-up', neg[1].names.join(','), 'b,c')
  const ring = gfx.donut(neg, { total: 10 * GiB })
  ok('no negative arc in the ring', !/stroke-dasharray="-/.test(ring))
}

// --- 7. The roll-up word goes through ANAS.t ----------------------------------

eq('roll-up word translated', gfx.capSegments(synthetic(10))[8].label, '2 [more]')

// ---- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} gfx.capSegments checks passed`)
