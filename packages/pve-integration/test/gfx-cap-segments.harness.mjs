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
 *   - over `max` named segments, the `max` largest positive ones survive,
 *     value-descending, and everything else (the remainder AND zero-value
 *     segments) folds into ONE "{n} more" roll-up whose value is the
 *     remaining sum and whose `names` lists the folded labels
 *   - at or under max there is no roll-up and the named rows keep the
 *     caller's order (a small pool's legend is byte-identical to the uncapped
 *     one); a missing/NaN/negative value reads 0 there, in place
 *   - pinned:true segments ("Proxmox storage") always keep their own row,
 *     after the named rows and before Free, never folded; each takes one of
 *     the max row slots, so the legend never exceeds max + 2 rows
 *   - free:true segments pass through last, unchanged, never counted toward
 *     max
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

// --- 1. The 60-segment case: max 6 named + one roll-up + Free last -----------

{
  const capped = gfx.capSegments(synthetic(60))
  eq('60 in → 8 out (6 + roll-up + Free)', capped.length, 8)

  const named = capped.slice(0, 6)
  ok('the 6 largest survive', named.every(s => !s.free && !s.more))
  eq('largest is #60', named[0].label, 'vm-60-disk-0')
  eq('6th largest is #55', named[5].label, 'vm-55-disk-0')
  for (let i = 1; i < named.length; i++) {
    ok(`descending order at ${i}`, named[i - 1].value > named[i].value,
      `${named[i - 1].value} then ${named[i].value}`)
  }

  const roll = capped[6]
  ok('roll-up is flagged', !!roll.more)
  eq('roll-up label', roll.label, '54 [more]')
  eq('roll-up value is the remaining sum',
    roll.value, [...Array(54).keys()].map(i => (i + 1) * GiB).reduce((a, b) => a + b))
  eq('roll-up names carry every folded label', roll.names.length, 54)
  ok('roll-up names start just below the cap', roll.names[0] === 'vm-54-disk-0')
  ok('roll-up names end at the smallest', roll.names[53] === 'vm-1-disk-0')

  const free = capped[7]
  ok('Free passes through last, unchanged', free.free === true && free.label === 'Free'
    && free.value === 500 * GiB)

  // The caller feeds the SAME capped array to donut and legend — their row
  // counts must agree (the #70 invariant: ring and list never disagree).
  const legend = gfx.legend(capped, { format: v => gfx.rungLabel(v) })
  const donut = gfx.donut(capped, { total: 1000 * GiB })
  eq('legend rows match segments', (legend.match(/anas-gfx-legend-row/g) || []).length, 8)
  eq('donut arcs match segments', (donut.match(/<circle/g) || []).length, 8)
  // The roll-up row carries the folded names as its tooltip.
  ok('roll-up row tooltip lists the folded names',
    legend.includes('title="vm-54-disk-0, vm-53-disk-0'))
  ok('named rows carry no tooltip', !legend.includes('title="vm-60-disk-0'))
}

// --- 2. At or under max: no roll-up -------------------------------------------

{
  const capped = gfx.capSegments(synthetic(5))
  eq('5 in (under max) → 6 out', capped.length, 6)
  ok('no roll-up under max', capped.every(s => !s.more))
  eq('under max: the caller\'s order is kept, Free last',
    capped.map(s => s.label).join(','), 'vm-1-disk-0,vm-2-disk-0,vm-3-disk-0,vm-4-disk-0,vm-5-disk-0,Free')
  const input = synthetic(5)
  ok('under max: the same segment objects come back', gfx.capSegments(input).every((s, i) => s === input[i]))
  eq('under max: the legend is byte-identical to the uncapped one',
    gfx.legend(gfx.capSegments(input), { format: v => gfx.rungLabel(v) }),
    gfx.legend(input, { format: v => gfx.rungLabel(v) }))

  const exact = gfx.capSegments(synthetic(6))
  eq('exactly max → 7 out (6 + Free)', exact.length, 7)
  ok('no roll-up at exactly max', exact.every(s => !s.more))
  eq('exactly max: caller order kept', exact[0].label, 'vm-1-disk-0')

  const over = gfx.capSegments(synthetic(7))
  eq('one over max → sorted, 6 + roll-up + Free', over.map(s => s.label).join(','),
    'vm-7-disk-0,vm-6-disk-0,vm-5-disk-0,vm-4-disk-0,vm-3-disk-0,vm-2-disk-0,1 [more],Free')
}

// --- 3. Free is never counted toward max --------------------------------------

{
  // 6 positive segments AND two free-shaped rows: all 6 named survive.
  const segs = synthetic(6)
  segs.push({ label: 'Free (2nd)', value: 1 * GiB, free: true })
  const capped = gfx.capSegments(segs)
  eq('free rows never crowd out named ones', capped.length, 8)
  ok('both free rows pass through at the tail',
    capped[6].free === true && capped[7].free === true && capped[7].label === 'Free (2nd)')
}

// --- 4. Zero-value segments: in place under the cap, "the rest" over it ------

{
  const segs = [
    { label: 'a', value: 3 * GiB },
    { label: 'empty-1', value: 0 },
    { label: 'b', value: 2 * GiB },
    { label: 'empty-2', value: undefined },
    { label: 'c', value: 1 * GiB },
    { label: 'Free', value: 9 * GiB, free: true },
  ]
  const capped = gfx.capSegments(segs)
  eq('under the cap zeros keep their place, no roll-up', capped.map(s => s.label).join(','),
    'a,empty-1,b,empty-2,c,Free')
  ok('under the cap: no roll-up', capped.every(s => !s.more))
  ok('a real 0 is returned as is', capped[1] === segs[1])
  eq('a missing value reads 0', capped[3].value, 0)
  eq('NaN reads 0', gfx.capSegments([{ label: 'n', value: Number.NaN }])[0].value, 0)
  ok('the input segment is not mutated', segs[3].value === undefined)

  const many = synthetic(6)
  many.splice(2, 0, { label: 'empty-1', value: 0 }, { label: 'empty-2', value: undefined })
  const folded = gfx.capSegments(many)
  eq('over the cap: 6 + roll-up + Free', folded.length, 8)
  const roll = folded[6]
  ok('zero roll-up is flagged', !!roll.more)
  eq('over the cap zeros fold', roll.label, '2 [more]')
  eq('zero roll-up value', roll.value, 0)
  eq('zero roll-up names', roll.names.join(','), 'empty-1,empty-2')
  ok('Free still last', folded[7].free === true)
}

// --- 4b. Pinned ("Proxmox storage") is never folded, and takes a row slot ----

{
  const pve = { label: 'Proxmox storage', value: 2 * GiB, pinned: true }
  const big = synthetic(60)
  big.splice(30, 0, pve)
  const capped = gfx.capSegments(big)
  eq('60 named + pinned → 8 out (5 + roll-up + pinned + Free = max + 2)', capped.length, 8)
  ok('pinned keeps its own row after the roll-up', capped[5].more === true && capped[6] === pve)
  ok('pinned is not among the folded names', !capped[5].names.includes('Proxmox storage'))
  eq('the roll-up folds 55', capped[5].label, '55 [more]')
  eq('largest kept is #60', capped[0].label, 'vm-60-disk-0')
  ok('Free last', capped[7].free === true)

  const small = [{ label: 'media', value: GiB }, pve, { label: 'Free', value: GiB, free: true }]
  eq('under the cap: named, pinned, Free', gfx.capSegments(small).map(s => s.label).join(','),
    'media,Proxmox storage,Free')
  const five = synthetic(5)
  five.splice(0, 0, pve)
  eq('5 named + pinned fit in 6 slots: no roll-up, caller order',
    gfx.capSegments(five).map(s => s.label).join(','),
    'vm-1-disk-0,vm-2-disk-0,vm-3-disk-0,vm-4-disk-0,vm-5-disk-0,Proxmox storage,Free')
  const six = synthetic(6)
  six.splice(0, 0, pve)
  const sixCapped = gfx.capSegments(six)
  eq('6 named + pinned overflow: 5 kept + roll-up + pinned + Free', sixCapped.length, 8)
  ok('…and the pinned row is still its own', sixCapped[6] === pve && sixCapped[5].names.join(',') === 'vm-1-disk-0')
  ok('pinned rows never squeeze the named rows to zero',
    gfx.capSegments(synthetic(3).concat([pve, pve]), { max: 2 }).filter(s => !s.more && !s.free && !s.pinned).length === 1)
  const zero = gfx.capSegments([{ label: 'Proxmox storage', value: 0, pinned: true }])
  ok('a zero pinned segment still keeps its row', zero.length === 1 && zero[0].label === 'Proxmox storage')
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
ok('bogus max falls back to 6', gfx.capSegments(synthetic(10), { max: -1 }).length === 8)

// --- 6. Malformed entries: null never throws, negatives never shrink ---------

{
  let capped
  let threw = null
  try {
    capped = gfx.capSegments([{ label: 'a', value: 2 * GiB }, null, { label: 'Free', value: GiB, free: true }])
  } catch (e) { threw = e }
  ok('a null entry does not throw', threw === null, threw && threw.message)
  if (capped) {
    eq('a null entry is not a segment → a + Free', capped.map(s => s.label).join(','), 'a,Free')
  }

  const neg = gfx.capSegments([
    { label: 'a', value: 5 * GiB },
    { label: 'b', value: -3 * GiB },
    { label: 'c', value: 0 },
  ])
  eq('under the cap a negative entry keeps its row', neg.map(s => s.label).join(','), 'a,b,c')
  eq('…reading 0', neg[1].value, 0)
  const ring = gfx.donut(neg, { total: 10 * GiB })
  ok('no negative arc in the ring', !/stroke-dasharray="-/.test(ring))

  const negOver = synthetic(6)
  negOver.push({ label: 'neg', value: -3 * GiB })
  const foldedNeg = gfx.capSegments(negOver)
  eq('over the cap a negative folds, counting 0', foldedNeg[6].value, 0)
  eq('…still named in the roll-up', foldedNeg[6].names.join(','), 'neg')
  ok('no negative arc over the cap either', !/stroke-dasharray="-/.test(gfx.donut(foldedNeg, { total: 100 * GiB })))
}

// --- 7. The roll-up word goes through ANAS.t ----------------------------------

eq('roll-up word translated', gfx.capSegments(synthetic(10))[6].label, '4 [more]')

// --- 8. The compact hero (dshero.1 short screens): max 3 → legend <= 5 rows ---

{
  const capped = gfx.capSegments(synthetic(60), { max: 3 })
  eq('max 3: 60 in → 5 out (3 + roll-up + Free)', capped.length, 5)
  eq('max 3: largest kept', capped[0].label, 'vm-60-disk-0')
  ok('max 3: the roll-up is 4th', !!capped[3].more)
  eq('max 3: it folds the other 57', capped[3].names.length, 57)
  ok('max 3: Free is last', !!capped[4].free)

  // The Proxmox storage segment is pinned: one of the 3, never folded.
  const withPinned = synthetic(18)
  withPinned.splice(withPinned.length - 1, 0, { label: 'Proxmox storage', value: 0.5 * GiB, pinned: true })
  const pinned = gfx.capSegments(withPinned, { max: 3 })
  eq('max 3 + pinned: still 5 rows', pinned.length, 5)
  ok('max 3 + pinned: the pinned row survives', pinned.some(s => s.label === 'Proxmox storage' && !s.more))
  eq('max 3 + pinned: two named + pinned before the roll-up', pinned.filter(s => !s.more && !s.free).length, 3)
  ok('max 3 + pinned: Free last', !!pinned[pinned.length - 1].free)

  // At or under 3 named nothing folds.
  eq('max 3: three named + Free fold nothing', gfx.capSegments(synthetic(3), { max: 3 }).length, 4)
}

// ---- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} gfx.capSegments checks passed`)
