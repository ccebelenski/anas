#!/usr/bin/env node
/*
 * ANAS — gfx.timeChart render harness.
 *
 * The PVE injection scripts are browser ES5 loaded by pveproxy — they are not
 * part of the Node build and carry no unit-test wiring (see eslint.config.js).
 * This harness is how the chart's PURE, headless-checkable behaviour gets
 * proven anyway: it stubs just enough DOM for 15-gfx.js's IIFE, renders real
 * SVG through the real gfx.timeChart, and asserts on the markup.
 *
 * Grown from the throwaway harness that verified story 11.15's y-axis margin
 * fix (long labels spilling past the SVG's left edge); now also covers the
 * 2026-08-19 telemetry-legibility work: the 1-2-5 scale ladder, the ratchet and
 * its manual re-fit control, the unsampled-region hatch, and the average
 * overlay.
 *
 *   node packages/pve-integration/test/gfx-timechart.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const GFX = join(HERE, '..', 'src', '15-gfx.js')

const KiB = 1024
const MiB = 1024 * 1024
const GiB = 1024 * 1024 * 1024

// ---- Minimal DOM + ANAS stub ------------------------------------------------
// gfx only needs: an element factory, a head/body to append to, a cookie string,
// documentElement.setAttribute, and matchMedia. Everything it appends is
// discarded — we assert on returned markup, never on the injected DOM.

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
    // The real shared formatter (00-core.js): 1024-based, 2 decimals above bytes.
    formatBytes(bytes) {
      if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes))) { return '' }
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
      let order = 0
      let size = Number(bytes)
      while (size >= 1024 && order < units.length - 1) { size = size / 1024; order++ }
      return `${size.toFixed(order === 0 ? 0 : 2)} ${units[order]}`
    },
    warn(m) { throw new Error(`gfx warned: ${m}`) },
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

// Y-axis labels in render order: [max, mid, 0].
function yLabels(svg) {
  return [...svg.matchAll(/class="anas-gfx-tc-ylab"[^>]*>([^<]*)</g)].map(m => m[1])
}

function yLabelX(svg) {
  const m = svg.match(/class="anas-gfx-tc-ylab" x="(-?[\d.]+)"/)
  return m ? Number(m[1]) : Number.NaN
}

// A window's worth of samples with `peak` as the high-water mark.
function ramp(peak, n) {
  const out = []
  for (let i = 0; i < n; i++) { out.push(i === n - 1 ? peak : peak * (i / n) * 0.4) }
  return out
}

const WIN = { width: 620, height: 160, windowMs: 300000, sampleMs: 2500 }
const SLOTS = Math.round(WIN.windowMs / WIN.sampleMs) // 120

// --- 1. Ladder rung selection across magnitudes ------------------------------

const LADDER_CASES = [
  { peak: 37 * KiB, max: '50 KiB/s', mid: '25 KiB/s' },
  { peak: 4.77 * MiB, max: '5 MiB/s', mid: '2.5 MiB/s' },
  { peak: 966 * MiB, max: '1 GiB/s', mid: '512 MiB/s' },
  { peak: 1 * KiB, max: '1 KiB/s', mid: '512 B/s' }, // an exact rung stays put
  { peak: 1.1 * KiB, max: '2 KiB/s', mid: '1 KiB/s' },
  { peak: 501 * MiB, max: '1 GiB/s', mid: '512 MiB/s' }, // 500 MiB → 1 GiB, not 1000 MiB
  { peak: 0, max: '1 KiB/s', mid: '512 B/s' }, // idle floor
  { peak: 3.4 * GiB, max: '5 GiB/s', mid: '2.5 GiB/s' },
]

for (const c of LADDER_CASES) {
  const svg = gfx.timeChart(
    [{ label: 'Read', values: ramp(c.peak, SLOTS) }],
    WIN,
  )
  const labs = yLabels(svg)
  eq(`ladder ${c.peak} B/s → max`, labs[0], c.max)
  eq(`ladder ${c.peak} B/s → mid`, labs[1], c.mid)
  eq(`ladder ${c.peak} B/s → zero`, labs[2], '0 B/s')
}

// Direct ladder probe: every rung is 1/2/5 × 10ⁿ inside its binary family.
eq('rungCeil(37 KiB)', gfx.scaleRung(37 * KiB), 50 * KiB)
eq('rungCeil(4.77 MiB)', gfx.scaleRung(4.77 * MiB), 5 * MiB)
eq('rungCeil(966 MiB)', gfx.scaleRung(966 * MiB), 1 * GiB)
eq('rungCeil(exact rung)', gfx.scaleRung(200 * MiB), 200 * MiB)
ok('rung halves stay clean', [1, 2, 5, 10, 20, 50, 100, 200, 500].every((m) => {
  const half = gfx.rungLabel((m * MiB) / 2)
  return !/\.\d\d/.test(half)
}), 'a rung half rendered with two decimals')

// --- 2. Ratchet: up immediately, never down on its own -----------------------

{
  const scale = {}
  const opts = { ...WIN, scale, fitId: 'harness.pool' }

  // Quiet window first.
  let svg = gfx.timeChart([{ label: 'Read', values: ramp(3 * MiB, SLOTS) }], opts)
  eq('ratchet: initial fit', yLabels(svg)[0], '5 MiB/s')
  ok('ratchet: no re-fit button at fit', !svg.includes('data-anas-tcfit'))

  // A burst lands — scale up IMMEDIATELY (clipping is worse than jumping).
  svg = gfx.timeChart([{ label: 'Read', values: ramp(240 * MiB, SLOTS) }], opts)
  eq('ratchet: rises with the peak', yLabels(svg)[0], '500 MiB/s')
  ok('ratchet: still no button while fit', !svg.includes('data-anas-tcfit'))

  // The burst ages out of the window. The scale MUST hold.
  svg = gfx.timeChart([{ label: 'Read', values: ramp(3 * MiB, SLOTS) }], opts)
  eq('ratchet: holds after peak expiry', yLabels(svg)[0], '500 MiB/s')
  eq('ratchet: state kept on the caller object', scale.max, 500 * MiB)

  // ...and NOW the re-fit control earns its place.
  ok('re-fit button appears while held above fit', svg.includes('data-anas-tcfit="harness.pool"'))
  ok('re-fit button is one control', (svg.match(/data-anas-tcfit/g) || []).length === 1)
  ok('re-fit button carries its tooltip', svg.includes('Fit scale to current data'))
  ok('interactive chart drops aria-hidden', !svg.includes('aria-hidden="true"'))

  // Operator clicks it: the caller clears scale.max, the ratchet resumes.
  scale.max = 0
  svg = gfx.timeChart([{ label: 'Read', values: ramp(3 * MiB, SLOTS) }], opts)
  eq('re-fit drops to the window rung', yLabels(svg)[0], '5 MiB/s')
  ok('re-fit button gone once re-fitted', !svg.includes('data-anas-tcfit'))
  svg = gfx.timeChart([{ label: 'Read', values: ramp(600 * MiB, SLOTS) }], opts)
  eq('ratchet resumes after a re-fit', yLabels(svg)[0], '1 GiB/s')
}

// A pinned max disables both the ladder and the ratchet (contract unchanged).
{
  const scale = {}
  const svg = gfx.timeChart(
    [{ label: 'Read', values: ramp(3 * MiB, SLOTS) }],
    { ...WIN, max: 7 * MiB, scale, fitId: 'harness.pinned' },
  )
  eq('pinned max wins', yLabels(svg)[0], '7 MiB/s')
  ok('pinned max shows no re-fit control', !svg.includes('data-anas-tcfit'))
}

// No scale object → no ratchet, no button (charts opt in).
{
  const svg = gfx.timeChart([{ label: 'Read', values: ramp(3 * MiB, SLOTS) }],
    { ...WIN, fitId: 'harness.nostate' })
  ok('no scale state → no re-fit control', !svg.includes('data-anas-tcfit'))
}

// --- 3. Y-label width stability ----------------------------------------------
//
// 11.15's bug: a wide label right-anchored at a FIXED 52px margin spilled past
// x=0 and lost its leading digits. The margin is derived from the widest label;
// the ladder additionally keeps those labels short and their width stable.

{
  const xs = new Set()
  let minX = Infinity
  let widest = 0
  for (let p = 1; p < 4 * GiB; p *= 1.37) {
    const svg = gfx.timeChart([{ label: 'Read', values: ramp(p, SLOTS) }], WIN)
    const x = yLabelX(svg)
    ok(`y-label anchored inside the SVG (peak ${Math.round(p)})`, x > 0, `x=${x}`)
    minX = Math.min(minX, x)
    xs.add(x)
    for (const l of yLabels(svg)) { widest = Math.max(widest, l.length) }
  }
  ok('y-label anchor never leaves room for clipping', minX >= 40, `min x=${minX}`)
  ok('ladder keeps y labels short', widest <= 11, `widest label ${widest} chars`)
  // Exactly one anchor: the plot's left edge must not shift by a few px every
  // time the ratchet moves the scale under a live series.
  ok('y-label anchor is stable across magnitudes', xs.size === 1,
    `${xs.size} distinct anchors: ${[...xs].join(',')}`)
}

// A caller-supplied format still owns the units AND still drives the margin.
{
  const svg = gfx.timeChart(
    [{ label: 'Hits', values: ramp(1200, SLOTS) }],
    { ...WIN, format: v => `${Math.round(v)} enormously long unit` },
  )
  ok('custom format used for the axis', yLabels(svg)[0].includes('enormously long unit'))
  ok('custom format widens the margin', yLabelX(svg) > 52, `x=${yLabelX(svg)}`)
}

// --- 4. Unsampled region -----------------------------------------------------

{
  const partial = gfx.timeChart([{ label: 'Read', values: ramp(2 * MiB, 12) }], WIN)
  const m = partial.match(/class="anas-gfx-tc-nodata"[^>]*width="([\d.]+)"/)
  ok('partial buffer hatches the unsampled region', !!m)
  const hatchW = m ? Number(m[1]) : 0
  ok('hatch covers most of a barely-started window', hatchW > 400, `width=${hatchW}`)
  ok('hatch is labelled', partial.includes('no samples yet'))

  const full = gfx.timeChart([{ label: 'Read', values: ramp(2 * MiB, SLOTS) }], WIN)
  ok('full buffer has no hatch', !full.includes('anas-gfx-tc-nodata'))

  const empty = gfx.timeChart([{ label: 'Read', values: [] }], WIN)
  ok('empty buffer still says collecting', empty.includes('collecting'))
  ok('empty buffer hatches the whole plot', empty.includes('anas-gfx-tc-nodata'))
}

// --- 5. Average overlay + legend readout -------------------------------------

{
  // A txg-cadence shape: a big flush every 4th sample, zero in between. The raw
  // newest sample is 0 — the average must not be.
  const bursty = []
  for (let i = 0; i < SLOTS; i++) { bursty.push(i % 4 === 1 ? 400 * MiB : 0) }

  const plain = gfx.timeChart([{ label: 'Read', values: bursty }], WIN)
  ok('no overlay unless asked', !plain.includes('anas-gfx-tc-avg'))
  ok('raw legend reads the newest sample', plain.includes('Read 0 B/s'))

  const avg = gfx.timeChart([{ label: 'Read', values: bursty }], { ...WIN, avgSamples: 4 })
  ok('average overlay drawn', avg.includes('class="anas-gfx-tc-avg"'))
  ok('raw line kept alongside the overlay',
    (avg.match(/<polyline/g) || []).length === 2)
  ok('average window is tagged', avg.includes('avg 10s'))
  ok('legend leads with the average, not the idle sample', avg.includes('Read 100.00 MiB/s'),
    avg.match(/Read [^<]*/)?.[0])
}

// --- 6. Fail-open contract ---------------------------------------------------

eq('no width → empty string', gfx.timeChart([{ values: [1] }], { height: 100 }), '')
ok('no series → still a framed chart', gfx.timeChart([], WIN).includes('anas-gfx-timechart'))

// ---- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} gfx.timeChart checks passed`)
