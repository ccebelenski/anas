#!/usr/bin/env node
/*
 * ANAS — Dashboard telemetry-render harness.
 *
 * Companion to gfx-timechart.harness.mjs: that one proves the shared chart, this
 * one proves what the Pools composite does WITH it. It stubs the ExtJS surface
 * 50-dashboard.js touches (a view with down()/setHtml(), a poll timer, an
 * ANAS.api that answers /status and /telemetry from fixtures), drives real poll
 * ticks, and asserts on the rendered HTML.
 *
 * Covers the 2026-08-19 telemetry-legibility work end to end:
 *   • a pool's SOLE vdev / SOLE band collapses (header + member tiles kept,
 *     duplicated readouts and chart dropped); two or more render in full;
 *   • ZFS and AHR come out identically — the same shared component, no forks;
 *   • every figure leads with a labelled short-window average and names its
 *     direction (R/W); no unlabelled ▼/▲ survives;
 *   • one sample per telemetry tick no matter how often we re-render;
 *   • the scale ratchet holds across ticks and surfaces its re-fit control.
 *
 *   node packages/pve-integration/test/dashboard-telemetry.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const MiB = 1024 * 1024

// ---- Fixtures ---------------------------------------------------------------
// alpha: ONE raidz1 vdev (the collapse case). beta: TWO mirrors (the full case).
// gamma: ONE AHR band (collapse). delta: TWO AHR bands (full).

const STATUS = {
  node: 'harness',
  pools: [
    { name: 'alpha', state: 'ONLINE', capacity: 41, allocated: 41e10, size: 1e12, free: 59e10 },
    { name: 'beta', state: 'ONLINE', capacity: 12, allocated: 12e10, size: 1e12, free: 88e10 },
  ],
  ahrPools: [
    {
      name: 'gamma',
      state: 'healthy',
      usableBytes: 8e12,
      usedBytes: 3e12,
      mountpoint: '/mnt/gamma',
      mounted: true,
      bands: [{
        band: 0,
        level: 'raid5',
        memberCount: 3,
        state: 'clean',
        heightBytes: 4e12,
        members: [{ id: 'ata-DISK-A', sizeBytes: 4e12 }, { id: 'ata-DISK-B', sizeBytes: 4e12 }],
      }],
      spares: [],
    },
    {
      name: 'delta',
      state: 'healthy',
      usableBytes: 16e12,
      usedBytes: 4e12,
      mountpoint: '/mnt/delta',
      mounted: true,
      bands: [
        {
          band: 0,
          level: 'raid5',
          memberCount: 3,
          state: 'clean',
          heightBytes: 4e12,
          members: [{ id: 'ata-DISK-C', sizeBytes: 4e12 }],
        },
        {
          band: 1,
          level: 'raid5',
          memberCount: 3,
          state: 'clean',
          heightBytes: 4e12,
          members: [{ id: 'ata-DISK-D', sizeBytes: 4e12 }],
        },
      ],
      spares: [],
    },
  ],
  disks: { healthy: 8, warning: 0, critical: 0, unknown: 0, total: 8 },
  shares: {},
  jobs: [],
  warnings: [],
}

function io(r, w) {
  return {
    readBytesPerSec: r,
    writeBytesPerSec: w,
    readIops: Math.round(r / 4096),
    writeIops: Math.round(w / 4096),
    readLatencyNs: r > 0 ? 420000 : null,
    writeLatencyNs: w > 0 ? 810000 : null,
  }
}

// `burst` scales the whole sample so a tick can be made a txg flush.
function telemetry(burst) {
  const b = burst || 1
  return {
    sampledAt: Date.now(),
    windowMs: 1000,
    arc: { hitRatio: 0.97, size: 8e9, target: 8e9, max: 16e9 },
    net: {
      totalRxBytesPerSec: 10 * MiB * b,
      totalTxBytesPerSec: 2 * MiB * b,
      interfaces: [{ name: 'vmbr0', rxBytesPerSec: 10 * MiB * b, txBytesPerSec: 2 * MiB * b }],
    },
    pools: [
      {
        name: 'alpha',
        ...io(200 * MiB * b, 30 * MiB * b),
        vdevs: [{
          name: 'raidz1-0',
          type: 'raidz1',
          role: 'data',
          state: 'ONLINE',
          ...io(200 * MiB * b, 30 * MiB * b),
          disks: [
            { id: 'ata-ALPHA-1', ...io(70 * MiB * b, 10 * MiB * b) },
            { id: 'ata-ALPHA-2', ...io(65 * MiB * b, 10 * MiB * b) },
            { id: 'ata-ALPHA-3', ...io(65 * MiB * b, 10 * MiB * b) },
          ],
        }],
      },
      {
        name: 'beta',
        ...io(40 * MiB * b, 5 * MiB * b),
        vdevs: [
          {
            name: 'mirror-0',
            type: 'mirror',
            role: 'data',
            state: 'ONLINE',
            ...io(20 * MiB * b, 3 * MiB * b),
            disks: [{ id: 'ata-BETA-1', ...io(20 * MiB * b, 3 * MiB * b) }],
          },
          {
            name: 'mirror-1',
            type: 'mirror',
            role: 'data',
            state: 'ONLINE',
            ...io(20 * MiB * b, 2 * MiB * b),
            disks: [{ id: 'ata-BETA-2', ...io(20 * MiB * b, 2 * MiB * b) }],
          },
        ],
      },
    ],
    ahrPools: [
      {
        name: 'gamma',
        ...io(150 * MiB * b, 25 * MiB * b),
        bands: [{
          band: 0,
          level: 'raid5',
          ...io(150 * MiB * b, 25 * MiB * b),
          disks: [
            { id: 'ata-DISK-A', ...io(75 * MiB * b, 12 * MiB * b) },
            { id: 'ata-DISK-B', ...io(75 * MiB * b, 13 * MiB * b) },
          ],
        }],
      },
      {
        name: 'delta',
        ...io(60 * MiB * b, 8 * MiB * b),
        bands: [
          {
            band: 0,
            level: 'raid5',
            ...io(30 * MiB * b, 4 * MiB * b),
            disks: [{ id: 'ata-DISK-C', ...io(30 * MiB * b, 4 * MiB * b) }],
          },
          {
            band: 1,
            level: 'raid5',
            ...io(30 * MiB * b, 4 * MiB * b),
            disks: [{ id: 'ata-DISK-D', ...io(30 * MiB * b, 4 * MiB * b) }],
          },
        ],
      },
    ],
  }
}

// ---- Stubs ------------------------------------------------------------------

function makeEl() {
  const el = {
    id: '',
    type: '',
    className: '',
    style: {},
    childNodes: [],
    firstChild: null,
    set innerHTML(_v) { this.firstChild = makeEl() },
    appendChild(c) { this.childNodes.push(c); return c },
    setAttribute() {},
    on() {},
  }
  return el
}

const state = {
  burst: 1,
  timers: [],
  sections: {},
}

function loadUi() {
  const doc = {
    cookie: '',
    hidden: false,
    head: makeEl(),
    body: makeEl(),
    documentElement: makeEl(),
    createElement: () => makeEl(),
    createTextNode: t => ({ text: t }),
    getElementById: () => null,
    getElementsByTagName: () => [makeEl()],
    addEventListener() {},
    removeEventListener() {},
  }
  const win = {
    document: doc,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  }
  win.ANAS = {
    views: {},
    t: s => s,
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
    warn(m) { throw new Error(`dashboard warned: ${m}`) },
    errText: e => String((e && e.message) || e),
    api: {
      get(_node, path) {
        if (path === '/status') { return Promise.resolve(STATUS) }
        if (path === '/telemetry') { return Promise.resolve(telemetry(state.burst)) }
        return Promise.reject(new Error(`unexpected path ${path}`))
      },
    },
  }
  const sandbox = {
    window: win,
    document: doc,
    console,
    Promise,
    Date,
    // The view restarts its interval on activate/show; only the newest one is
    // ever live in a browser, so the harness keeps exactly one too — otherwise a
    // single tick() would fire several polls and bank several samples.
    setInterval: (fn) => { state.timers = [fn]; return state.timers.length },
    clearInterval: () => { state.timers = [] },
  }
  vm.runInNewContext(readFileSync(join(SRC, '15-gfx.js'), 'utf8'), sandbox, { filename: '15-gfx.js' })
  vm.runInNewContext(readFileSync(join(SRC, '50-dashboard.js'), 'utf8'), sandbox, { filename: '50-dashboard.js' })
  return win.ANAS
}

// A view stand-in: down('#itemId') hands back a component whose setHtml we keep.
function makeView() {
  const cmps = {}
  return {
    destroyed: false,
    destroying: false,
    _cmps: cmps,
    down(sel) {
      const id = sel.replace('#', '')
      if (!cmps[id]) { cmps[id] = { itemId: id, html: '', setHtml(h) { this.html = h }, getWidth: () => 900 } }
      return cmps[id]
    },
    up() { return null },
    getEl() { return { on() {} } },
    getWidth() { return 932 },
    isVisible() { return true },
  }
}

const ANAS = loadUi()

// ---- Drive the view ---------------------------------------------------------

const view = makeView()
const cfg = ANAS.views.dashboard.factory('harness')
cfg.listeners.afterrender(view)

// Let the /status + first /telemetry promises settle, then run more poll ticks.
async function tick() {
  for (const fn of state.timers) { fn() }
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
}

const pools = () => view.down('#anasDashPools').html
const net = () => view.down('#anasDashNet').html

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

// Slice one pool block out of the composite by its name. The lookahead keeps
// the split off nested classes that merely start with the same prefix
// (.anas-dash-pool-io, .anas-dash-pool-head, …).
function poolBlock(html, name) {
  const blocks = html.split(/<div class="anas-dash-pool(?=["\s])/)
  for (const b of blocks) {
    if (b.includes(`<span>${name}</span>`)) { return b }
  }
  return ''
}
function count(hay, needle) {
  return hay.split(needle).length - 1
}
// Opening tags of the vdev/band tier only — the lookahead skips the nested
// .anas-dash-vdev-head / -io / -lat / -chart elements inside one.
function countVdevs(hay) {
  return (hay.match(/class="anas-dash-vdev(?=["\s])/g) || []).length
}

await new Promise(r => setImmediate(r))
await new Promise(r => setImmediate(r))
await tick()
await tick()

const html = pools()

// --- 1. Solo vdev / solo band collapse ---------------------------------------

{
  const alpha = poolBlock(html, 'alpha')
  const beta = poolBlock(html, 'beta')
  const gamma = poolBlock(html, 'gamma')
  const delta = poolBlock(html, 'delta')
  ok('fixtures render all four pools', alpha && beta && gamma && delta)

  eq('alpha has one vdev', countVdevs(alpha), 1)
  ok('alpha vdev is marked solo', alpha.includes('anas-dash-vdev-solo'))
  eq('alpha renders exactly one chart (the pool\'s)', count(alpha, 'anas-gfx-timechart'), 1)
  ok('alpha keeps its vdev identity row', alpha.includes('VDEV') && alpha.includes('RAIDZ1'))
  ok('alpha keeps its vdev device count', alpha.includes('3 devices'))
  ok('alpha keeps its vdev state pill', alpha.includes('anas-gfx-pill'))
  ok('collapsed vdev drops its duplicated IOPS', count(alpha, 'anas-dash-vdev-io') === 0)
  ok('collapsed vdev drops its duplicated I/O row', count(alpha, 'anas-dash-vdev-lat') === 0)
  // The member layer is NEVER reduced — a failing disk diverges exactly here.
  eq('alpha keeps every member tile', count(alpha, 'class="anas-dash-disk"'), 3)
  ok('alpha member tiles keep their numbers', alpha.includes('ata-ALPHA-1') && count(alpha, 'avg 10s R') >= 3)

  eq('beta has two vdevs', countVdevs(beta), 2)
  ok('beta vdevs are not collapsed', !beta.includes('anas-dash-vdev-solo'))
  eq('beta renders pool + both vdev charts', count(beta, 'anas-gfx-timechart'), 3)
  eq('beta keeps both vdev IOPS lines', count(beta, 'anas-dash-vdev-io'), 2)

  // AHR takes the SAME rule — it is the same shared component, not a fork.
  eq('gamma has one band', countVdevs(gamma), 1)
  ok('gamma band is marked solo', gamma.includes('anas-dash-vdev-solo'))
  eq('gamma renders exactly one chart', count(gamma, 'anas-gfx-timechart'), 1)
  ok('gamma keeps its band identity row', gamma.includes('BAND') && gamma.includes('RAID5'))
  eq('gamma keeps every member tile', count(gamma, 'class="anas-dash-disk"'), 2)

  eq('delta has two bands', countVdevs(delta), 2)
  ok('delta bands are not collapsed', !delta.includes('anas-dash-vdev-solo'))
  eq('delta renders pool + both band charts', count(delta, 'anas-gfx-timechart'), 3)
}

// --- 2. Labelled figures, no bare glyphs -------------------------------------

ok('no unlabelled read glyph survives', !html.includes('▼'))
ok('no unlabelled write glyph survives', !html.includes('▲'))
ok('no unlabelled glyph in the network section', !net().includes('▼') && !net().includes('▲'))
ok('I/O rows lead with the short average', html.includes('avg 10s R '))
ok('IOPS lines lead with the short average', /avg 10s R [\d.k]+ · W [\d.k]+ IOPS/.test(html))
ok('window peaks name their window', html.includes('peak 5m R '))
ok('window averages name their window', html.includes('avg 5m R '))
ok('latency rows are labelled per direction', /latency<\/span><span[^>]*>avg 10s R /.test(html))
ok('charts tag their average window', html.includes('avg 10s'))
ok('charts carry the average overlay', html.includes('anas-gfx-tc-avg'))

// --- 3. One sample per tick, however many renders ----------------------------

{
  const before = view._anasSpark['pool.alpha.read'].length
  // A /status load re-renders the whole composite without a new measurement.
  cfg.listeners.activate(view)
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  const after = view._anasSpark['pool.alpha.read'].length
  ok('a re-render without a new telemetry tick adds no sample',
    after === before || after === before + 1, `${before} → ${after}`)
  const seq = view._anasSampleSeq
  await tick()
  eq('a telemetry tick bumps the sequence once', view._anasSampleSeq, seq + 1)
}

// --- 4. The scale ratchet holds across ticks, then offers its re-fit ---------

{
  const key = 'pool.alpha'
  const quiet = view._anasScale[key].max
  ok('a scale is held for the pool chart', quiet > 0, `max=${quiet}`)
  ok('no re-fit control while the scale fits', !poolBlock(pools(), 'alpha').includes('data-anas-tcfit'))

  state.burst = 6 // a burst 6× the quiet rate
  await tick()
  const raised = view._anasScale[key].max
  ok('the scale rises with the burst', raised > quiet, `${quiet} → ${raised}`)

  // ...and the burst ages all the way out of the 5-minute window. The scale
  // must NOT follow it down on its own — that is the whole point of the ratchet.
  state.burst = 1
  for (let i = 0; i < 125; i++) { await tick() }
  eq('the scale holds after the peak expires', view._anasScale[key].max, raised)
  ok('the burst really did leave the window',
    Math.max(...view._anasSpark['pool.alpha.read']) < raised / 2)
  ok('the re-fit control appears once the scale is held above fit',
    poolBlock(pools(), 'alpha').includes(`data-anas-tcfit="${key}"`))

  // The operator takes the offer.
  view._anasScale[key].max = 0
  await tick()
  ok('re-fitting drops the scale', view._anasScale[key].max < raised,
    `still ${view._anasScale[key].max}`)
  ok('the control retires once re-fitted',
    !poolBlock(pools(), 'alpha').includes('data-anas-tcfit'))
}

// --- 5. ZFS and AHR are rendered by the same code ----------------------------

{
  const h = pools()
  const gamma = poolBlock(h, 'gamma')
  const alpha = poolBlock(h, 'alpha')
  for (const marker of ['avg 10s R ', 'peak 5m R ', 'anas-gfx-tc-avg', 'anas-dash-vdev-solo']) {
    ok(`ZFS and AHR agree on "${marker}"`,
      alpha.includes(marker) === gamma.includes(marker),
      `zfs=${alpha.includes(marker)} ahr=${gamma.includes(marker)}`)
  }
}

// ---- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} dashboard telemetry checks passed`)
