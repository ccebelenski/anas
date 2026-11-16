#!/usr/bin/env node
/*
 * ANAS — cr3 pools-panel harness (the 2026-11-14 review, area pools-panel).
 *
 * Every check loads the REAL panel files (00-core.js, 15-gfx.js and the file
 * under test) in node:vm with a stub Ext, drives the code path a finding
 * named, and asserts on what the operator would see or what the panel sends.
 * Each block names its finding id; each was RED before its fix.
 *
 *   node packages/pve-integration/test/cr3-pools-panel.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

// ---- Assertions -------------------------------------------------------------

const failures = []
let checks = 0
function ok(label, cond, detail) {
  checks++
  if (!cond) { failures.push(`${label}${detail ? ` — ${detail}` : ''}`) }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}
const settle = () => new Promise(r => setImmediate(r))

// ---- A stub DOM element (enough for gfx's injected styles and the composer) --

function fakeEl(id) {
  return {
    id, value: '', innerHTML: '', textContent: '', disabled: false, placeholder: '',
    style: {}, childNodes: [], handlers: {}, attrs: {},
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn) },
    fire(ev) { (this.handlers[ev] || []).forEach(f => f({ stopPropagation() {} })) },
    getAttribute(a) { return this.attrs[a] === undefined ? null : this.attrs[a] },
    setAttribute(a, v) { this.attrs[a] = v },
    appendChild(c) { this.childNodes.push(c); return c },
  }
}

// The encoder the real Ext provides (Ext.String.htmlEncode): & < > " '.
function htmlEncode(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Load 00-core.js + 15-gfx.js + `files` into one fresh context. `extra` adds
// sandbox globals (Ext, timers); `api` replaces ANAS.api after core loads.
function loadPanels(files, extra = {}) {
  const document = {
    cookie: '', hidden: false,
    head: fakeEl('head'), body: fakeEl('body'), documentElement: fakeEl('html'),
    createElement: () => fakeEl('el'),
    createTextNode: t => ({ text: t }),
    getElementById: () => null,
    getElementsByTagName: () => [fakeEl('head')],
    addEventListener() {}, removeEventListener() {},
  }
  const window = { document, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }) }
  const Ext = extra.Ext || {
    String: { htmlEncode },
    create: () => ({}),
    on() {}, un() {},
    Msg: { alert() {}, confirm() {} },
  }
  if (!Ext.String) { Ext.String = { htmlEncode } }
  const sandbox = {
    window, document, Ext, console, Promise, Date, Math, JSON,
    setTimeout: extra.setTimeout || setTimeout,
    clearTimeout,
    setInterval: extra.setInterval || (() => 0),
    clearInterval: () => {},
    gettext: s => s,
  }
  window.window = window
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(SRC, '00-core.js'), 'utf8'), sandbox, { filename: '00-core.js' })
  const ANAS = window.ANAS
  ANAS.warn = extra.warn || (() => {})
  if (extra.before) { extra.before(ANAS) }
  for (const f of ['15-gfx.js', ...files]) {
    vm.runInContext(readFileSync(join(SRC, f), 'utf8'), sandbox, { filename: f })
  }
  return { ANAS, sandbox }
}

// =============================================================================
// DASHBOARD (50-dashboard.js)
// =============================================================================

function dashView(status, telemetry) {
  const cmps = {}
  return {
    destroyed: false, destroying: false,
    _anasStatus: status, _anasTelemetry: telemetry,
    down(sel) {
      const id = sel.replace('#', '')
      if (!cmps[id]) { cmps[id] = { html: '', setHtml(h) { this.html = h }, getWidth: () => 900 } }
      return cmps[id]
    },
    up() { return null },
    getEl() { return { on() {} } },
    getWidth() { return 932 },
    isVisible() { return true },
    _cmps: cmps,
  }
}

function io() {
  return { readBytesPerSec: 0, writeBytesPerSec: 0, readIops: 0, writeIops: 0, readLatencyNs: null, writeLatencyNs: null }
}

// The status dots a rendered composite draws, per disk tile.
function tileDots(html) {
  return html.split('class="anas-dash-disk"').slice(1).map((tile) => {
    const id = (tile.match(/anas-dash-disk-id" title="([^"]+)"/) || [])[1]
    const dot = (tile.match(/anas-gfx-status anas-gfx-status-(\w+)"/) || [])[1] || null
    return { id, dot }
  })
}

// --- POOLS-PANEL-M2: member disk tiles draw no invented health dot -----------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const view = dashView(
    {
      pools: [{ name: 'tank', state: 'DEGRADED', size: 1e12, allocated: 1e11, free: 9e11, capacity: 10, scanRunning: false }],
      ahrPools: [{
        name: 'hyb', state: 'degraded', usableBytes: 8e12, usedBytes: 1e12, mountpoint: '/mnt/hyb', mounted: true,
        bands: [{ band: 1, level: 'raid5', memberCount: 2, state: 'degraded', members: [{ id: 'ata-AHR_A', sizeBytes: 4e12 }, { id: 'ata-AHR_B', sizeBytes: 4e12 }] }],
        spares: [{ id: 'ata-AHR_SPARE', sizeBytes: 4e12 }],
      }],
    },
    {
      pools: [{
        name: 'tank', ...io(),
        vdevs: [{ name: 'mirror-0', type: 'mirror', role: 'data', state: 'DEGRADED', ...io(), disks: [{ id: 'ata-GOOD_DISK', ...io() }, { id: 'ata-FAULTED_DISK', ...io() }] }],
      }],
      ahrPools: [],
    },
  )
  const html = ANAS.dash.renderPoolsComposite(view)
  const dots = tileDots(html)
  const byId = Object.fromEntries(dots.map(d => [d.id, d.dot]))
  eq('M2: ZFS member of a DEGRADED mirror draws no status dot', byId['ata-FAULTED_DISK'], null)
  eq('M2: every ZFS member draws no status dot', byId['ata-GOOD_DISK'], null)
  eq('M2: AHR band member draws no status dot', byId['ata-AHR_A'], null)
  eq('M2: AHR spare keeps its role dot (from spares[])', byId['ata-AHR_SPARE'], 'spare')
  ok('M2: no tile in the composite draws the green tick', !/anas-gfx-status-online/.test(html))
  ok('M2: the vdev pill still says DEGRADED', /anas-gfx-pill-degraded/.test(html))
}

// --- INVENTED-STATE-H2: vdev state / role unknown -----------------------------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const tel = (vdev) => ({ pools: [{ name: 'tank', ...io(), vdevs: [vdev, { name: 'mirror-1', type: 'mirror', role: 'data', state: 'ONLINE', ...io(), disks: [] }] }], ahrPools: [] })
  const status = { pools: [{ name: 'tank', state: 'ONLINE', size: 1e12, allocated: 1e11, free: 9e11, capacity: 10, scanRunning: false }], ahrPools: [] }
  for (const [label, vdev] of [
    ['absent', { name: 'mirror-0', type: 'mirror', ...io(), disks: [] }],
    ['null', { name: 'mirror-0', type: 'mirror', state: null, role: null, ...io(), disks: [] }],
  ]) {
    const html = ANAS.dash.renderPoolsComposite(dashView(status, tel(vdev)))
    const first = html.split(/class="anas-dash-vdev(?=["\s])/)[1] || ''
    ok(`H2: vdev state ${label} renders an "unknown" pill`, /anas-gfx-pill"[^>]*>.*unknown/.test(first), first.slice(0, 400))
    ok(`H2: vdev state ${label} never renders a green pill`, !/anas-gfx-pill-online/.test(first))
    ok(`H2: vdev role ${label} says "role unknown"`, first.includes('role unknown'))
  }
  const html = ANAS.dash.renderPoolsComposite(dashView(status, tel({ name: 'mirror-0', type: 'mirror', role: 'log', state: 'FAULTED', ...io(), disks: [] })))
  ok('H2: a known FAULTED state still renders its pill', /anas-gfx-pill-faulted/.test(html))
  ok('H2: a known log role still renders its label', html.includes('Log (SLOG)'))
}

// --- INVENTED-STATE-L11: ARC unavailable --------------------------------------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const status = { pools: [], ahrPools: [], disks: { total: 0, healthy: 0, warning: 0, critical: 0, unknown: 0 }, warnings: [], jobs: [] }
  for (const [label, arc] of [['null', null], ['absent', undefined], ['missing hitRatio', { size: 1, target: 1, max: 1, l2: null }]]) {
    const view = dashView(status, null)
    let teled = 0
    ANAS.api = {
      get(_n, path) {
        if (path === '/status') { return Promise.resolve(status) }
        if (path === '/telemetry') {
          teled++
          const tel = { sampledAt: new Date().toISOString(), windowMs: 1000, pools: [], ahrPools: [], net: { interfaces: [], totalRxBytesPerSec: 0, totalTxBytesPerSec: 0 } }
          if (arc !== undefined) { tel.arc = arc }
          return Promise.resolve(tel)
        }
        return Promise.reject(new Error(path))
      },
    }
    const cfg = ANAS.views.dashboard.factory('n')
    cfg.listeners.afterrender(view)
    await settle(); await settle()
    const arcHtml = view.down('#anasDashArc').html
    ok(`L11: ARC ${label} renders "ARC unavailable"`, arcHtml.includes('ARC unavailable'), arcHtml)
    ok(`L11: ARC ${label} draws no gauge and no 0 B figure`, !arcHtml.includes('anas-gfx-gauge') && !arcHtml.includes('0 B'), arcHtml)
    ok(`L11: telemetry was polled (${label})`, teled >= 1)
  }
}

// --- cr3 sweep: disk health counts and pool scan state unknown ----------------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const fleet = ANAS.dash.renderFleet({ disks: { total: null, healthy: 3, warning: null, critical: null, unknown: 0 }, jobs: [] })
  const tiles = fleet.split('class="anas-dash-stat"').slice(1)
  const tile = label => tiles.find(t => t.includes(`>${label}<`)) || ''
  ok('sweep: an unread Critical count shows a dash, not 0', tile('Critical').includes('>—<') && !tile('Critical').includes('>0<'), tile('Critical'))
  ok('sweep: an unread count tile is muted, not the danger colour', !tile('Critical').includes('--anas-danger'))
  ok('sweep: a read count still shows its number', tile('Healthy').includes('>3<'))
  ok('sweep: an unread total says unknown', fleet.includes('Disk count unknown'))
  const html = ANAS.dash.renderPoolsComposite(dashView(
    { pools: [{ name: 'tank', state: 'ONLINE', size: 1e12, allocated: 1e11, free: 9e11, capacity: 10, scanRunning: null }], ahrPools: [] }, null))
  ok('sweep: an unread scanRunning says "Scan state unknown"', html.includes('Scan state unknown'))
  const idle = ANAS.dash.renderPoolsComposite(dashView(
    { pools: [{ name: 'tank', state: 'ONLINE', size: 1e12, allocated: 1e11, free: 9e11, capacity: 10, scanRunning: false }], ahrPools: [] }, null))
  ok('sweep: a read scanRunning:false renders no scan line', !idle.includes('Scan state unknown') && !idle.includes('anas-gfx-activity'))
}

// --- cr3 sweep: the recent-activity strip never invents a job outcome ----------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const html = ANAS.dash.jobsStrip({ jobs: [
    { id: 'a', kind: 'k.none', startedAt: '2026-11-14T10:00:00Z', finishedAt: '2026-11-14T10:01:00Z' },
    { id: 'b', kind: 'k.nofinish', startedAt: '2026-11-14T10:00:00Z' },
    { id: 'c', kind: 'k.queued', status: 'queued' },
    { id: 'd', kind: 'k.done', status: 'completed', startedAt: '2026-11-14T10:00:00Z', finishedAt: '2026-11-14T10:01:00Z' },
  ] })
  const row = k => html.split('anas-dash-job"').find(r => r.includes(k)) || ''
  ok('sweep: a finished job with no status reads unknown, not a green "done"', /anas-dash-job-cancel">unknown</.test(row('k.none')), row('k.none'))
  ok('sweep: an unfinished job with no status reads unknown, not "running"', /anas-dash-job-cancel">unknown</.test(row('k.nofinish')), row('k.nofinish'))
  ok('sweep: a queued job is not green', /anas-dash-job-run">queued</.test(row('k.queued')), row('k.queued'))
  ok('sweep: a completed job keeps the ok class', /anas-dash-job-ok">completed</.test(row('k.done')), row('k.done'))
}

// --- cr3 sweep: AHR and ZFS pool blocks with fields the payload did not carry ---
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const html = ANAS.dash.renderPoolsComposite(dashView({
    pools: [{ name: 'tank', state: 'ONLINE', size: 1e12, allocated: 1e11, free: 9e11, scanRunning: false }],
    ahrPools: [{
      name: 'hyb', mountpoint: '/mnt/hyb', bands: [{ band: 1, level: 'raid5', memberCount: 3, state: 'recovering', sync: { action: 'recover' }, members: [] }], spares: [],
    }],
  }, null))
  const ahr = html.split('anas-dash-pool-ahr')[1] || ''
  ok('sweep: an AHR sync with no percent never says 0.0%', !ahr.includes('0.0%'), ahr)
  ok('sweep: an AHR pool with no state labels its pill "unknown"', /anas-gfx-pill[^>]*><span class="anas-gfx-pill-dot"><\/span>unknown/.test(ahr), ahr.slice(0, 600))
  ok('sweep: an AHR pool with no usable size shows a dash, not 0 B', !ahr.includes('>0 B<'), ahr.slice(0, 600))
  ok('sweep: an AHR pool with no mounted flag says the mount state is unknown', ahr.includes('mount state unknown'))
  const zfs = html.split('anas-dash-pool-ahr')[0]
  ok('sweep: a ZFS pool with no capacity never says 0%', !zfs.includes('>0%<'), zfs.slice(0, 800))
}

// --- POOLS-PANEL-L9: a failed /v1/status --------------------------------------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const status = {
    pools: [{ name: 'tank', state: 'DEGRADED', size: 1e12, allocated: 1e11, free: 9e11, capacity: 10, scanRunning: false }],
    ahrPools: [], disks: { total: 2, healthy: 1, warning: 0, critical: 1, unknown: 0 }, jobs: [],
    warnings: [{ level: 'critical', category: 'pool', message: 'Pool tank is DEGRADED', ref: 'tank' }],
  }
  let failStatus = false
  ANAS.api = {
    get(_n, path) {
      if (path === '/status') { return failStatus ? Promise.reject(new Error('gateway timeout')) : Promise.resolve(status) }
      if (path === '/telemetry') {
        return Promise.resolve({ sampledAt: new Date().toISOString(), windowMs: 1000, arc: { hitRatio: 0.9, size: 1, target: 1, max: 2, l2: null }, pools: [], ahrPools: [], net: { interfaces: [], totalRxBytesPerSec: 0, totalTxBytesPerSec: 0 } })
      }
      return Promise.reject(new Error(path))
    },
  }
  const view = dashView(undefined, undefined)
  const cfg = ANAS.views.dashboard.factory('n')
  cfg.listeners.afterrender(view)
  await settle(); await settle()
  ok('L9: a good status shows its critical warning', view.down('#anasDashWarnings').html.includes('Pool tank is DEGRADED'))
  ok('L9: a good status line says just now with no stale note', view.down('#anasDashStatus').html.includes('just now') && !view.down('#anasDashStatus').html.includes('status unavailable'))
  failStatus = true
  cfg.listeners.activate(view) // the next status read fails
  await settle(); await settle()
  const warn = view.down('#anasDashWarnings').html
  ok('L9: a failed status keeps the last critical warning', warn.includes('Pool tank is DEGRADED'), warn)
  ok('L9: a failed status shows a "status unavailable" card', warn.includes('Status unavailable') && warn.includes('gateway timeout'), warn)
  const line = view.down('#anasDashStatus').html
  ok('L9: the toolbar says the status is unavailable', line.includes('status unavailable'), line)
  ok('L9: the toolbar dot is not the fresh green one', !line.includes('--anas-ok'), line)
  ok('L9: the pools composite says its states are from the last good read', view.down('#anasDashPools').html.includes('last good status read'))
  failStatus = false
  cfg.listeners.activate(view)
  await settle(); await settle()
  ok('L9: a recovered status clears the card', !view.down('#anasDashWarnings').html.includes('Status unavailable'))
  ok('L9: a recovered status clears the toolbar note', !view.down('#anasDashStatus').html.includes('status unavailable'))
}

// --- review (1): before the first telemetry answer the toolbar is neutral ------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  ANAS.api = {
    get(_n, path) {
      if (path === '/status') { return Promise.reject(new Error('gateway timeout')) }
      return new Promise(() => {}) // /telemetry has not answered yet
    },
  }
  const view = dashView(undefined, undefined)
  ANAS.views.dashboard.factory('n').listeners.afterrender(view)
  await settle(); await settle()
  const line = view.down('#anasDashStatus').html
  ok('review(1): no "just now" before a telemetry sample', !line.includes('just now'), line)
  ok('review(1): the line says it waits for the first sample, and the status failure', line.includes('waiting for the first sample') && line.includes('status unavailable'), line)
}

// --- review (4): the dashboard never invents a kind, a size or a count ---------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const html = ANAS.dash.renderPoolsComposite(dashView({
    pools: [{ name: 'tank', state: 'ONLINE', capacity: 10, scanRunning: false }],
    ahrPools: [{
      name: 'hyb', state: 'healthy', usableBytes: 8e12, usedBytes: 1e12, mountpoint: '/mnt/hyb', mounted: true,
      bands: [{ band: 1, level: 'raid5', state: 'clean', members: [{ id: 'ata-M' }] }], spares: [],
    }],
  }, { pools: [{ name: 'tank', ...io(), vdevs: [{ name: 'mirror-0', type: 'mirror', role: 'data', state: 'ONLINE', ...io(), disks: [{ id: 'nvme-X', ...io() }] }] }], ahrPools: [] }))
  ok('review(4): no tile draws the HDD platter (the payload carries no kind)', !html.includes('anas-gfx-icon-hdd') && html.includes('anas-gfx-icon-disk'))
  ok('review(4): an AHR member with no size never reads "0 B"', !/Size 0 B/.test(html) && html.includes('Size unknown'))
  ok('review(4): an AHR band with no member count reads "× ?"', html.includes('× ?') && !html.includes('× 0'))
  ok('review(4): a ZFS pool with no allocated/size never reads "0 B / 0 B"', !html.includes('0 B / 0 B'))
  const v = dashView({ pools: [], ahrPools: [] }, null)
  ANAS.api = { get: (_n, p) => (p === '/telemetry' ? Promise.resolve({ arc: { hitRatio: 0.5, size: 1, target: 1, max: 1, l2: {} }, pools: [], ahrPools: [] }) : new Promise(() => {})) }
  ANAS.views.dashboard.factory('n').listeners.afterrender(v)
  await settle(); await settle()
  const arcHtml = v.down('#anasDashArc').html
  ok('review(4): an L2ARC with no figures never reads "0% hit"', !arcHtml.includes('0% hit') && arcHtml.includes('hit ratio unknown'), arcHtml)
}

// =============================================================================
// COMPOSER (38-pool-composer.js)
// =============================================================================

// Open the real composer over a stub window; returns a driver. `disks` is the
// GET /disks answer; `jobs` decides each confirmAndRun's outcome in order
// ('complete' | 'fail' | 'lost'); every request body is recorded.
async function composer({ mode = 'create', disks, poolName = 'tank', jobs = [], topology = { vdevGroups: [] } }) {
  const els = {}
  for (const s of ['#anasc-mount', '#anasc-poolname', '#anasc-role', '#anasc-type', '#anasc-addvdev',
    '#anasc-avail', '#anasc-availcount', '#anasc-racks', '#anasc-summary', '#anasc-advisor']) {
    els[s] = fakeEl(s)
  }
  els['#anasc-role'].value = 'data'
  els['#anasc-type'].value = 'stripe'
  const root = {
    querySelector: s => els[s] || null,
    querySelectorAll: s => (s === '.anas-composer-disk' ? [fakeEl('card')] : []),
  }
  let winCfg = null
  const createBtn = { disabled: true, setDisabled(v) { this.disabled = v } }
  const win = {
    destroyed: false, destroying: false,
    down(q) {
      if (q === '#composerBody') { return { getEl: () => ({ dom: root }) } }
      if (q === '#composerCreateBtn') { return createBtn }
      return null
    },
    show() {}, setLoading() {}, on() {}, close() { this.destroyed = true },
  }
  const requests = []
  const reloads = []
  const dragOpts = []
  let currentDisks = disks
  const confirms = []
  const toasts = []
  const Ext = {
    String: { htmlEncode },
    create: (_c, cfg) => { winCfg = cfg; return win },
    on() {}, un() {},
    toast: m => toasts.push(m),
    Msg: { alert() {}, confirm: (title, msg, cb) => confirms.push({ title, msg, cb }) },
  }
  const held = []
  const grid = { itemId: 'poolsGrid' }
  const { ANAS } = loadPanels(['38-pool-composer.js'], { Ext })
  ANAS.api = {
    get(_n, path) {
      if (path === '/disks') { return Promise.resolve({ data: currentDisks }) }
      if (path.startsWith('/pools/')) { return Promise.resolve({ data: topology }) }
      return Promise.reject(new Error(path))
    },
  }
  ANAS.gfx.ready = () => true
  ANAS.gfx.drag = (_el, o) => { dragOpts.push(o) }
  ANAS.gfx.warnGate.clientConfirm = spec => spec.onProceed()
  ANAS.pools = { reload: (g, n) => reloads.push(n) }
  ANAS.confirmAndRun = (o) => {
    requests.push({ path: o.path, body: o.body })
    const outcome = jobs.shift() || 'complete'
    if (outcome === 'complete') { o.onComplete({ status: 'completed' }) }
    else if (outcome === 'fail') { o.onFailed({ status: 'failed' }) }
    else if (outcome === 'lost') { (o.onLost || o.onFailed)(null) }
    else if (outcome === 'hold') { held.push(o) }
  }
  ANAS.composer.open({ node: 'n', mode, poolName, grid: mode === 'expand' ? grid : null })
  winCfg.listeners.afterrender(win)
  await settle(); await settle(); await settle()
  return {
    ANAS, els, createBtn, win, requests, reloads, winCfg, confirms, toasts, held, grid,
    setDisks(d) { currentDisks = d },
    type(sel, v) { els[sel].value = v; els[sel].fire('input') },
    addVdev(role, type) {
      els['#anasc-role'].value = role
      els['#anasc-role'].fire('change')
      if (type) { els['#anasc-type'].value = type }
      els['#anasc-addvdev'].fire('click')
    },
    drop(diskId, vdevId) { dragOpts[dragOpts.length - 1].onDrop(diskId, { getAttribute: () => `vdev:${vdevId}` }) },
    commit() { winCfg.buttons[1].handler() },
    summary: () => els['#anasc-summary'].innerHTML,
    avail: () => els['#anasc-avail'].innerHTML,
    racks: () => els['#anasc-racks'].innerHTML,
    typeOptions: () => (els['#anasc-type'].innerHTML.match(/value="(\w+)"/g) || []).map(s => s.slice(7, -1)),
  }
}

const DISK = (id, extra = {}) => ({ id, status: 'available', size: 1e12, rotational: true, model: 'X', ...extra })

// --- POOLS-PANEL-M1: the mountpoint is sent as typed, trimmed at the ends ----
{
  const c = await composer({ disks: [DISK('ata-DISK_A')] })
  c.type('#anasc-poolname', 'tank')
  c.type('#anasc-mount', '  /srv/my pool  ')
  c.addVdev('data', 'stripe')
  c.drop('ata-DISK_A', 'v1')
  ok('M1: Create is enabled', !c.createBtn.disabled)
  c.commit()
  eq('M1: the mountpoint keeps its inner space', c.requests[0] && c.requests[0].body.mountpoint, '/srv/my pool')
  const c2 = await composer({ disks: [DISK('ata-DISK_A')] })
  c2.type('#anasc-poolname', 'tank')
  c2.type('#anasc-mount', '   ')
  c2.addVdev('data', 'stripe')
  c2.drop('ata-DISK_A', 'v1')
  c2.commit()
  ok('M1: an all-blank mountpoint sends no mountpoint (the ZFS default)', c2.requests[0] && !('mountpoint' in c2.requests[0].body))
}

// --- POOLS-PANEL-L5: the name rule is the shared PoolName, exactly -------------
{
  const PoolName = /^[a-z][\w-]*$/i
  for (const name of ['tank', 'Tank_2', 'a-b', 'tank.v2', 'tank:1', '1tank', '_x', 'a b', 'x'.repeat(255), 'x'.repeat(256)]) {
    const c = await composer({ disks: [DISK('ata-DISK_A')] })
    c.type('#anasc-poolname', name)
    c.addVdev('data', 'stripe')
    c.drop('ata-DISK_A', 'v1')
    const shared = PoolName.test(name) && name.length >= 1 && name.length <= 255
    eq(`L5: composer accepts ${JSON.stringify(name.length > 20 ? `${name.length} chars` : name)} iff PoolName does`, !c.createBtn.disabled, shared)
  }
  const c = await composer({ disks: [DISK('ata-DISK_A')] })
  c.type('#anasc-poolname', 'tank.v2')
  ok('L5: the hint no longer offers . or :', !c.summary().includes('. : -') && c.summary().includes('letters, digits, - _'), c.summary())
}

// --- POOLS-PANEL-M4: the picker offers only isComposableDisk disks -------------
{
  const lun = DISK('scsi-360014051a2b3c4d5e6f', { handsOff: 'iscsi-served-here', handsOffReason: 'served here' })
  const c = await composer({ disks: [DISK('ata-DISK_A'), lun, DISK('ata-USED', { status: 'zfs-member' })] })
  ok('M4: composer offers an available disk', c.avail().includes('ata-DISK_A'))
  ok('M4: composer does not offer a hands-off disk', !c.avail().includes('scsi-360014051a2b3c4d5e6f'), c.avail())
  ok('M4: composer does not offer a non-available disk', !c.avail().includes('ata-USED'))
  c.type('#anasc-poolname', 'tank')
  c.addVdev('data', 'stripe')
  c.drop('scsi-360014051a2b3c4d5e6f', 'v1')
  ok('M4: a hands-off disk dropped anyway never enables Create', c.createBtn.disabled)
}

// --- POOLS-PANEL-L6: the log role never offers raidz ---------------------------
{
  const c = await composer({ disks: [DISK('a'), DISK('b'), DISK('c')] })
  c.els['#anasc-role'].value = 'log'
  c.els['#anasc-role'].fire('change')
  eq('L6: the log role offers mirror and an unmirrored log, never raidz', c.typeOptions(), ['mirror', 'stripe'])
  for (const role of ['special', 'dedup']) {
    c.els['#anasc-role'].value = role
    c.els['#anasc-role'].fire('change')
    eq(`L6: the ${role} role keeps its raidz choices`, c.typeOptions(), ['mirror', 'raidz1', 'raidz2', 'raidz3'])
  }
  c.type('#anasc-poolname', 'tank')
  c.addVdev('data', 'stripe')
  c.drop('a', 'v1')
  c.addVdev('log', 'raidz1') // a stale select value: the draft must refuse it
  c.drop('b', 'v2')
  ok('L6: a raidz log in the draft blocks Create', c.createBtn.disabled, c.summary())
  ok('L6: the bay type select never offers the log role raidz', !/data-vtype="v2"[^]*?raidz1/.test(c.racks().split('data-vdev="v2"')[1] || ''))
}
{
  // Operator ruling (L6): a single-disk log is "not a recommended thing, but
  // allowable if ZFS allows it" — it passes with an amber warning.
  const RISK = 'An unmirrored log device: if it fails at the same moment as a crash or power loss, the last few seconds of synchronous writes are lost; the pool itself is not at risk.'
  const base = async (n) => {
    const c = await composer({ disks: ['d1', 'd2', 'l1', 'l2'].slice(0, n).map(id => DISK(id)) })
    c.type('#anasc-poolname', 'tank')
    c.addVdev('data', 'mirror')
    c.drop('d1', 'v1')
    c.drop('d2', 'v1')
    return c
  }
  const s = await base(3)
  s.addVdev('log', 'stripe')
  s.drop('l1', 'v2')
  ok('L6 ruling: a single-disk log passes validation (Create enabled)', !s.createBtn.disabled, s.summary())
  ok('L6 ruling: a single-disk log shows the risk warning', s.els['#anasc-advisor'].innerHTML.includes(RISK), s.els['#anasc-advisor'].innerHTML)
  ok('L6 ruling: the warning is amber, not blocking', /anas-gfx-warngate-chip/.test(s.summary()) && !s.summary().includes('Blocking'))
  s.commit()
  eq('L6 ruling: a single-disk log is sent as a bare log device', s.requests[0] && s.requests[0].body.logVdevs, [{ type: 'stripe', disks: ['l1'] }])
  const m = await base(4)
  m.addVdev('log', 'mirror')
  m.drop('l1', 'v2')
  m.drop('l2', 'v2')
  ok('L6 ruling: a mirror log passes', !m.createBtn.disabled)
  ok('L6 ruling: a mirror log shows no warning', !m.els['#anasc-advisor'].innerHTML.includes(RISK) && !/review to continue/.test(m.summary()), m.summary())
  for (const type of ['mirror', 'stripe']) {
    const sp = await base(3)
    sp.addVdev('special', type)
    sp.drop('l1', 'v2')
    ok(`L6 ruling: a single-disk special (${type} bay) is still blocked`, sp.createBtn.disabled, sp.summary())
  }
}

// --- POOLS-PANEL-M3: multi-vdev "Add vdevs" stops cleanly on a failure ----------
{
  const c = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A'), DISK('ata-DISK_B'), DISK('ata-DISK_C')], jobs: ['complete', 'fail'] })
  c.addVdev('data', 'stripe') // v1
  c.addVdev('data', 'stripe') // v2
  c.addVdev('data', 'stripe') // v3
  c.drop('ata-DISK_A', 'v1')
  c.drop('ata-DISK_B', 'v2')
  c.drop('ata-DISK_C', 'v3')
  ok('M3: Add vdevs is enabled', !c.createBtn.disabled)
  // After the first add completes, the inventory no longer offers DISK_A.
  c.setDisks([DISK('ata-DISK_B'), DISK('ata-DISK_C')])
  c.commit()
  await settle(); await settle(); await settle()
  eq('M3: two requests went out (the second failed)', c.requests.length, 2)
  ok('M3: the window stays open on a failure', !c.win.destroyed)
  ok('M3: the pool grid was reloaded after the failure', c.reloads.length >= 1)
  const note = c.summary()
  ok('M3: the composer says vdev 1 was added', /Added: Data stripe \(ata-DISK_A\)/.test(note), note)
  ok('M3: the composer says vdev 2 failed', /Not added \(the add failed\): Data stripe \(ata-DISK_B\)/.test(note), note)
  ok('M3: the composer says vdev 3 was not attempted', /Not added \(not attempted\): Data stripe \(ata-DISK_C\)/.test(note), note)
  ok('M3: the added vdev left the draft', !c.racks().includes('ata-DISK_A'))
  c.commit()
  await settle()
  const resent = c.requests.slice(2).map(r => JSON.stringify(r.body))
  ok('M3: a retry never resends the added vdev', !resent.some(b => b.includes('ata-DISK_A')), resent.join(' | '))
  ok('M3: a retry sends the vdevs that were not added', resent.some(b => b.includes('ata-DISK_B')) && resent.some(b => b.includes('ata-DISK_C')), resent.join(' | '))
}
{
  // Every staged vdev is checked BEFORE the first add: a staged disk the
  // panel's own record no longer calls composable stops the whole commit.
  const diskB = DISK('ata-DISK_B')
  const c = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A'), diskB] })
  c.addVdev('data', 'stripe')
  c.addVdev('data', 'stripe')
  c.drop('ata-DISK_A', 'v1')
  c.drop('ata-DISK_B', 'v2')
  diskB.handsOff = 'iscsi-served-here'
  c.commit()
  await settle()
  eq('M3: precheck — nothing is sent when a staged disk is not composable', c.requests.length, 0)
  ok('M3: precheck — the composer says nothing was added and why', /Nothing was added/.test(c.summary()) && c.summary().includes('ata-DISK_B'), c.summary())
}
{
  // An add whose outcome is unknown stops the sequence too, and says so.
  const c = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A'), DISK('ata-DISK_B')], jobs: ['lost'] })
  c.addVdev('data', 'stripe')
  c.addVdev('data', 'stripe')
  c.drop('ata-DISK_A', 'v1')
  c.drop('ata-DISK_B', 'v2')
  c.setDisks([DISK('ata-DISK_B')]) // DISK_A went into the pool after all
  c.commit()
  await settle(); await settle(); await settle()
  eq('M3: lost — one request went out', c.requests.length, 1)
  ok('M3: lost — the composer says the outcome is unknown', /Outcome unknown \(check the pool\): Data stripe \(ata-DISK_A\)/.test(c.summary()), c.summary())
  ok('M3: lost — a vdev whose disks the inventory no longer offers leaves the draft', !c.racks().includes('ata-DISK_A'))
}

// --- review (2): expand mode never applies the create-name rule ----------------
{
  const c = await composer({ mode: 'expand', poolName: 'tank.v2', disks: [DISK('ata-DISK_A')] })
  c.addVdev('data', 'stripe')
  c.drop('ata-DISK_A', 'v1')
  ok('review(2): expand on an existing tank.v2 says nothing about the name', !c.summary().includes('valid pool name'), c.summary())
  ok('review(2): expand on an existing tank.v2 enables Add vdevs', !c.createBtn.disabled)
}

// --- review (3): closing the composer mid-sequence is asked, never silent ------
{
  const c = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A'), DISK('ata-DISK_B')], jobs: ['hold'] })
  c.addVdev('data', 'stripe')
  c.addVdev('data', 'stripe')
  c.drop('ata-DISK_A', 'v1')
  c.drop('ata-DISK_B', 'v2')
  c.commit()
  eq('review(3): one add is in flight', c.held.length, 1)
  const pv = c.held[0] && c.held[0].view
  ok('review(3): the add polls on a liveness view, alive while the composer is', !!pv && pv.destroyed === false)
  ok('review(3): Add vdevs is off while the sequence runs', c.createBtn.disabled)
  const beforeClose = (d) => (d.winCfg.listeners.beforeclose ? d.winCfg.listeners.beforeclose(d.win) : true)
  const kept = beforeClose(c)
  ok('review(3): a close while adding is held and asked', kept === false && c.confirms.length === 1, JSON.stringify(c.confirms.map(x => x.msg)))
  if (c.confirms[0]) { c.confirms[0].cb('no') }
  ok('review(3): answering No keeps the composer open', !c.win.destroyed)
  beforeClose(c)
  if (c.confirms[1]) { c.confirms[1].cb('yes') } else { c.win.close() }
  ok('review(3): answering Yes closes it', c.win.destroyed)
  c.held[0].onComplete({ status: 'completed' })
  await settle()
  eq('review(3): nothing more is sent after the close', c.requests.length, 1)
  const note = c.toasts.join(' | ')
  ok('review(3): the outcome is said: vdev 1 added', /Added: Data stripe \(ata-DISK_A\)/.test(note), note)
  ok('review(3): the outcome is said: vdev 2 not added because of the close', /Not added \(the composer was closed\): Data stripe \(ata-DISK_B\)/.test(note), note)
  ok('review(3): the grid was reloaded', c.reloads.length >= 1)
  const idle = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A')] })
  eq('review(3): an idle composer closes without asking', beforeClose(idle), true)
}

// --- review (4): the composer's existing leaves and the kind mapping -----------
{
  const c = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A')], topology: { vdevGroups: [{ role: 'data', vdevs: [{ name: 'mirror-0', type: 'mirror', disks: [{ id: 'nvme-OLD', state: 'ONLINE' }] }] }] } })
  ok('review(4): an existing leaf (no kind in PoolDetail) draws the neutral shape', c.racks().includes('anas-gfx-icon-disk') && !c.racks().includes('anas-gfx-icon-hdd'), c.racks().slice(0, 300))
  const k = c.ANAS.gfx.diskKindOf
  eq('review(4): kind — rotational true is hdd', k({ rotational: true }), 'hdd')
  eq('review(4): kind — rotational false is ssd', k({ rotational: false }), 'ssd')
  eq('review(4): kind — nvme transport is nvme', k({ transport: 'nvme' }), 'nvme')
  eq('review(4): kind — nvmeN kernel name is nvme', k({ name: 'nvme0n1' }), 'nvme')
  eq('review(4): kind — unknown rotational is the neutral disk', k({ rotational: null }), 'disk')
}

// =============================================================================
// EXPAND / REPLACE (35-pool-attach.js)
// =============================================================================

async function attachWindow({ disks, targets }) {
  const els = {}
  const el = id => (els[id] = els[id] || { ...fakeEl(id), querySelectorAll: () => [], querySelector: q => el(q) })
  const body = { setHtml(h) { el('#shell').innerHTML = h }, getEl: () => ({ dom: el('#root') }) }
  const win = { destroyed: false, destroying: false, show() {}, setLoading() {}, close() { this.destroyed = true }, down: q => (q === '#pexBody' ? body : null) }
  const Ext = { String: { htmlEncode }, create: () => win, on() {}, un() {}, Msg: { alert() {} } }
  const { ANAS } = loadPanels(['30-pools.js', '35-pool-attach.js'], { Ext })
  const dragDisks = []
  ANAS.gfx.makeDragSelect = (o) => { dragDisks.push(o.disks.map(d => d.id)); return { render() {} } }
  ANAS.api = {
    get(_n, path) {
      if (path.endsWith('/expansion')) { return Promise.resolve({ data: { targets, busy: { busy: false }, capability: {} } }) }
      if (path === '/disks') { return Promise.resolve({ data: disks }) }
      return Promise.resolve({ data: { vdevGroups: [{ role: 'data', vdevs: [{ name: 'mirror-0', type: 'mirror', disks: [{ id: 'ata-OLD', state: 'ONLINE' }] }] }] } })
    },
  }
  ANAS.pools.actions.find(a => a.itemId === 'attachDisk').handler('n', {}, 'tank')
  for (let i = 0; i < 6; i++) { await settle() }
  return { area: () => el('#pexArea').innerHTML, dragDisks }
}

// --- POOLS-PANEL-M4 (Expand / Replace picker) ----------------------------------
{
  const lun = DISK('scsi-36001405aa', { handsOff: 'iscsi-served-here', handsOffReason: 'served here' })
  const w = await attachWindow({ disks: [DISK('ata-NEW'), lun, DISK('ata-USED', { status: 'zfs-member' })], targets: [{ vdevName: 'mirror-0', vdevType: 'mirror', kind: 'attach-leg', allowed: true }] })
  eq('M4: Expand / Replace offers only the composable disk', w.dragDisks[0], ['ata-NEW'])
}

// --- cr3 sweep: an expansion target with no `allowed` refuses, and says why -----
{
  const w = await attachWindow({ disks: [DISK('ata-NEW')], targets: [{ vdevName: 'mirror-0', vdevType: 'mirror', kind: 'attach-leg' }] })
  ok('sweep: a target with no allowed flag is not a live drop zone', w.area().includes('could not be read'), w.area().slice(0, 300))
  const w2 = await attachWindow({ disks: [DISK('ata-NEW')], targets: [{ vdevName: 'mirror-0', vdevType: 'mirror', kind: 'attach-leg', allowed: true }] })
  ok('sweep: an allowed target is a live drop zone', !w2.area().includes('could not be read') && !w2.area().includes('not eligible'))
}

// =============================================================================
// POOLS GRID (30-pools.js)
// =============================================================================

// A record stand-in (ExtJS model .get) and a grid with the base toolbar.
function rec(data) { return { data, get: k => data[k] } }
function poolsGrid(row) {
  const btns = {}
  for (const id of ['scrub', 'detail', 'trim', 'upgrade', 'exportPool', 'destroyPool']) {
    btns[id] = {
      disabled: false, text: '', tip: '',
      setDisabled(v) { this.disabled = !!v }, setText(v) { this.text = v }, setTooltip(v) { this.tip = v },
    }
  }
  return { btns, getSelection: () => (row ? [rec(row)] : []), down: q => btns[q.replace('#', '')] || null }
}
const POOL = (extra = {}) => ({ name: 'tank', state: 'ONLINE', scanRunning: false, trimSupported: true, upgradeAvailable: true, pveStorages: [], ...extra })

// --- POOLS-PANEL-L7: the Scan column names the scan ------------------------------
{
  const { ANAS } = loadPanels(['30-pools.js', '36-pool-export.js', '37-pool-destroy.js'])
  const r = ANAS.pools.renderScan
  eq('L7: a resilver reads "Resilvering"', r(true, {}, rec({ scanFunction: 'RESILVER' })), 'Resilvering')
  eq('L7: a scrub reads "Scrubbing"', r(true, {}, rec({ scanFunction: 'SCRUB' })), 'Scrubbing')
  eq('L7: a scan of no stated kind reads "Scanning"', r(true, {}, rec({})), 'Scanning')
  eq('L7: no scan reads "Idle"', r(false, {}, rec({})), 'Idle')
  ok('L12: an unread scan state reads "Unknown", never "Idle"', r(null, {}, rec({})).includes('Unknown') && r(undefined, {}, rec({})).includes('Unknown'))
}

// --- INVENTED-STATE-L12: unread flags never read as false -----------------------
{
  const { ANAS } = loadPanels(['30-pools.js', '36-pool-export.js', '37-pool-destroy.js'])
  const up = row => { const g = poolsGrid(row); ANAS.pools.updateButtons(g); return g.btns }
  let b = up(POOL())
  ok('L12: read flags — Scrub, Trim, Upgrade offered', !b.scrub.disabled && !b.trim.disabled && !b.upgrade.disabled)
  b = up(POOL({ trimSupported: false, upgradeAvailable: false }))
  ok('L12: read false — Trim and Upgrade not offered, with the old reasons', b.trim.disabled && /support TRIM/.test(b.trim.tip) && b.upgrade.disabled && /already enabled/.test(b.upgrade.tip))
  for (const v of [null, undefined]) {
    const row = POOL({ scanRunning: v, trimSupported: v, upgradeAvailable: v })
    b = up(row)
    ok(`L12: scanRunning ${v} — Scrub not offered, and said`, b.scrub.disabled && /could not be read/.test(b.scrub.tip), b.scrub.tip)
    ok(`L12: trimSupported ${v} — Trim not offered, and said`, b.trim.disabled && /could not be read/.test(b.trim.tip), b.trim.tip)
    ok(`L12: upgradeAvailable ${v} — Upgrade not offered, and said`, b.upgrade.disabled && /could not be read/.test(b.upgrade.tip), b.upgrade.tip)
  }
}

// --- cr3 sweep: the shared Mount column never says "not mounted" by default -----
{
  const { ANAS } = loadPanels([])
  const col = ANAS.gfx.mountColumn()
  ok('sweep: mounted true shows the path', col.renderer('/tank', {}, rec({ mounted: true })) === '/tank')
  ok('sweep: mounted false says not mounted', col.renderer('/tank', {}, rec({ mounted: false })).includes('not mounted'))
  const unk = col.renderer('/tank', {}, rec({}))
  ok('sweep: an absent mounted flag never says "not mounted"', !unk.includes('(not mounted)') && unk.includes('mount state unknown'), unk)
  eq('sweep: no path and no flag renders nothing', col.renderer(undefined, {}, rec({})), '')
}

// --- cr3 sweep: derived disk health is never a healthy default ------------------
{
  const { ANAS } = loadPanels(['30-pools.js'])
  const h = ANAS.pools.diskHealthLevel
  eq('sweep: ONLINE with no errors is healthy', h('ONLINE', 0, 0, 0), 'healthy')
  eq('sweep: an AVAIL spare is healthy', h('AVAIL', 0, 0, 0), 'healthy')
  eq('sweep: an absent state is unknown, not healthy', h(undefined, 0, 0, 0), 'unknown')
  eq('sweep: an unrecognised state is unknown, not healthy', h('SOMETHING', 0, 0, 0), 'unknown')
  eq('sweep: FAULTED is critical', h('FAULTED', 0, 0, 0), 'critical')
  const html = ANAS.pools.topologyGfxHtml({
    name: 'tank', state: 'ONLINE', capacity: 1, size: 1, allocated: 0,
    vdevGroups: [{ role: 'data', vdevs: [{ name: 'mirror-0', state: 'ONLINE', disks: [{ id: 'ata-A', state: 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0 }, { id: 'ata-B' }] }] }],
  })
  ok('sweep: a member with no state draws no green tick', (html.match(/anas-gfx-status-online/g) || []).length === 1, html)
  ok('sweep: the topology never says "healthy" over an unknown member', !html.includes('Pool is healthy') && html.includes('State unknown'))
  const sum = ANAS.pools.summaryHtml({ state: 'ONLINE', size: 1, allocated: 0, free: 1, capacity: 0, fragmentation: 0, errorCount: 0, guid: '1' })
  ok('sweep: an absent dedup ratio is a dash, not 0.00x', !sum.includes('0.00x') && /Dedup ratio<\/td><td[^>]*>—/.test(sum), sum)
}

// --- cr4 P-3: a pool cell the zpool read did not return is a dash --------------
// `zpool list -j` pool whose `properties` bag missed a field (or had no bag at
// all) reads null in a real daemon answer; the panels must show the dash the
// grid shows, never "0 B" / "0%" / a 0% gauge.
{
  const { ANAS } = loadPanels(['30-pools.js'])
  const sum = ANAS.pools.summaryHtml({
    state: 'ONLINE', size: null, allocated: null, free: null,
    capacity: null, fragmentation: null, dedupRatio: null, errorCount: 0, guid: '1',
  })
  ok('P-3: an unread size says dash, never 0 B', /Size<\/td><td[^>]*>—/.test(sum) && !/Size<\/td><td[^>]*>0 B/.test(sum), sum)
  ok('P-3: an unread allocated says dash, never 0 B', /Allocated<\/td><td[^>]*>—/.test(sum) && !/Allocated<\/td><td[^>]*>0 B/.test(sum), sum)
  ok('P-3: an unread capacity says dash, never 0%', /Capacity<\/td><td[^>]*>—/.test(sum) && !/Capacity<\/td><td[^>]*>0%/.test(sum), sum)
  ok('P-3: an unread fragmentation says dash', /Fragmentation<\/td><td[^>]*>—/.test(sum), sum)
  const topo = ANAS.pools.topologyGfxHtml({
    name: 'tank', state: 'ONLINE', capacity: null, size: null, allocated: null, vdevGroups: [],
  })
  ok('P-3: an unread capacity draws no 0% gauge', !topo.includes('anas-gfx-gauge'), topo)
}

// --- POOLS-PANEL-L8: every data value into a title, tooltip or intro is encoded --
{
  const EVIL = '<img src=x onerror=alert(1)>'
  const created = []
  const msgs = []
  const Ext = {
    String: { htmlEncode },
    create: (_c, cfg) => { created.push(cfg); return { show() {}, setLoading() {}, down() { return null }, on() {} } },
    on() {}, un() {}, ComponentQuery: { query: () => [] },
    Msg: { alert() {}, confirm(title, msg) { msgs.push({ title, msg }) } },
  }
  const { ANAS } = loadPanels(['30-pools.js', '31-pool-props.js', '34-pool-vdev-remove.js', '35-pool-attach.js', '36-pool-export.js', '37-pool-destroy.js', '38-pool-composer.js', '40-disks.js'], { Ext })
  ANAS.api = { get: () => new Promise(() => {}), post: () => new Promise(() => {}) }
  ANAS.gfx.ready = () => true
  // Held-by-LUN tooltip: daemon text into setTooltip (the tip renders HTML).
  const g = poolsGrid(POOL({ heldByLun: { targetIqn: 'iqn.x', detail: EVIL } }))
  ANAS.pools.updateButtons(g)
  ok('L8: held.detail is encoded in the Destroy tooltip', g.btns.destroyPool.tip.includes('&lt;img') && !g.btns.destroyPool.tip.includes('<img'), g.btns.destroyPool.tip)
  // Upgrade confirm intro: the 409 path renders it as HTML.
  ANAS.confirmAndRun = (o) => { msgs.push({ title: o.confirmTitle, msg: o.confirmIntro }) }
  const ug = poolsGrid(POOL({ name: EVIL }))
  ug.btns.upgrade.up = () => ug
  // The base-toolbar handler reads the grid selection: drive it the way a click does.
  const action = { handler: null }
  // upgradePool is private; reach it through the registered base toolbar config.
  const cfgGrid = ANAS.views.pools.factory('n')
  const tbItems = (cfgGrid.tbar && (cfgGrid.tbar.items || cfgGrid.tbar)) || []
  const upgradeCfg = tbItems.find(i => i && i.itemId === 'upgrade')
  action.handler = upgradeCfg && upgradeCfg.handler
  if (action.handler) { action.handler({ up: () => ug }) }
  const intro = msgs.map(m => m.msg).join(' | ')
  ok('L8: the upgrade confirm intro encodes the pool name', intro.includes('&lt;img') && !intro.includes('<img'), intro)
  // Window titles: open each window with a hostile pool / disk name.
  created.length = 0
  const opened = []
  for (const a of ANAS.pools.actions) {
    try { a.handler('n', { getEl: () => null }, EVIL); opened.push(a.itemId) } catch (e) { /* recorded below */ }
  }
  ANAS.composer.open({ node: 'n', mode: 'expand', poolName: EVIL, grid: null })
  // The pool detail window (double-click on a row).
  cfgGrid.listeners.itemdblclick(null, rec({ name: EVIL }))
  ok('L8: the pool detail window opened', created.some(c => c && c.cls === 'anas-view-pool-detail'))
  // The disks view: the S.M.A.R.T. window title and the group header template.
  const disksCfg = ANAS.views.disks.factory('n')
  const disksGrid = disksCfg.items[0]
  disksGrid.listeners.itemdblclick(null, rec({ id: EVIL, name: EVIL }))
  const tpl = (disksGrid.features[0] || {}).groupHeaderTpl || ''
  ok('L8: the disks group header encodes the pool / vdev label', /\{name:htmlEncode\}/.test(tpl), tpl)
  const titles = created.map(c => c && c.title).filter(Boolean)
  ok('L8: windows were opened for the check', titles.length >= 3, `${titles.length} titles from ${opened.join(',')}`)
  for (const title of titles) {
    ok(`L8: window title "${String(title).slice(0, 40)}" carries no raw markup`, !String(title).includes('<img'), title)
  }
}

// --- cr3 sweep: Edit Pool shows the pool's real properties or does not open ------
{
  for (const [label, props, opens] of [
    ['complete', { ashift: 12, autoexpand: true, autoreplace: false, autotrim: true, failmode: 'continue' }, true],
    ['missing', { ashift: 12 }, false],
    ['bad failmode', { ashift: 12, autoexpand: true, autoreplace: false, autotrim: true, failmode: 'toString' }, false],
  ]) {
    const set = []
    let closed = false
    const alerts = []
    const form = { setValues(v) { set.push(v) } }
    const win = { destroyed: false, destroying: false, show() {}, setLoading() {}, close() { closed = true }, down: () => ({ getForm: () => form }) }
    const Ext = { String: { htmlEncode }, create: () => win, on() {}, un() {}, Msg: { alert(_t, m) { alerts.push(m) } } }
    const { ANAS } = loadPanels(['30-pools.js', '31-pool-props.js'], { Ext })
    ANAS.api = { get: () => Promise.resolve({ data: { properties: props } }) }
    ANAS.pools.actions.find(a => a.itemId === 'modifyProps').handler('n', {}, 'tank')
    await settle(); await settle()
    if (opens) {
      eq(`sweep: Edit Pool (${label}) shows the real values`, set[0], { ashift: 12, autoexpand: true, autoreplace: false, autotrim: true, failmode: 'continue' })
    } else {
      ok(`sweep: Edit Pool (${label}) shows no invented off / wait`, set.length === 0, JSON.stringify(set))
      ok(`sweep: Edit Pool (${label}) says the properties could not be read and closes`, closed && alerts.some(m => /could not be read/.test(m)), alerts.join(' | '))
    }
  }
}

// --- cr3 sweep: the disks view never shows a fallback as a fact ------------------
{
  const added = []
  const content = { removeAll() {}, setLoading() {}, add(c) { added.push(c) } }
  const Ext = {
    String: { htmlEncode },
    create: (cls, cfg) => (cls === 'Ext.data.Store' ? cfg : { show() {}, close() {}, down: () => content, destroyed: false }),
    on() {}, un() {}, Msg: { alert() {} },
  }
  const { ANAS } = loadPanels(['40-disks.js'], { Ext })
  ANAS.api = { get: () => Promise.resolve({ data: { attributes: [] } }) }
  const cfg = ANAS.views.disks.factory('n')
  cfg.items[0].listeners.itemdblclick(null, rec({ id: 'ata-X', name: 'sdx' }))
  await settle(); await settle()
  const body = added[0] && added[0].items
  const grid = body && body.find(i => i.itemId === 'smartGrid')
  const rows = (grid && grid.store && grid.store.data) || []
  const row = n => (rows.find(r => r.name === n) || {}).value
  eq('sweep: an absent SMART "supported" reads Unknown, not No', row('Supported'), 'Unknown')
  eq('sweep: an absent SMART "enabled" reads Unknown, not No', row('Enabled'), 'Unknown')
  eq('sweep: an absent overall health reads Unknown, not "undefined"', row('Overall Health'), 'Unknown')
  const fields = (cfg.items[0].store && cfg.items[0].store.fields) || []
  const field = n => fields.find(f => f && f.name === n) || {}
  ok('sweep: an absent disk size stays null (never coerced to 0 B)', field('size').allowNull === true)
  ok('sweep: an absent rotational flag stays null (never coerced to an SSD)', field('rotational').allowNull === true)
}

// --- review (4): typed fields and counters never coerce an absent value -------
{
  const { ANAS } = loadPanels(['30-pools.js'])
  const h = ANAS.pools.diskHealthLevel
  eq('review(4): ONLINE with absent counters is unknown, not healthy', h('ONLINE', undefined, undefined, undefined), 'unknown')
  eq('review(4): ONLINE with zero counters is healthy', h('ONLINE', 0, 0, 0), 'healthy')
  eq('review(4): an absent counter does not hide a read error', h('ONLINE', 3, undefined, undefined), 'critical')
}
{
  const stores = []
  const Ext = {
    String: { htmlEncode },
    create: (cls, cfg) => { if (cls === 'Ext.data.Store') { stores.push(cfg); return cfg } return { show() {}, close() {}, down: () => null } },
    on() {}, un() {}, Msg: { alert() {} },
  }
  const { ANAS } = loadPanels(['30-pools.js'], { Ext })
  const cfg = ANAS.views.pools.factory('n')
  const fields = (stores[0] && stores[0].fields) || []
  for (const n of ['size', 'allocated', 'free', 'capacity', 'fragmentation', 'dedupRatio']) {
    ok(`review(4): pools grid field ${n} keeps an absent value null`, (fields.find(f => f && f.name === n) || {}).allowNull === true)
  }
  for (const n of ['size', 'allocated', 'free', 'capacity', 'fragmentation']) {
    const col = cfg.columns.find(c => c.dataIndex === n)
    const out = col && col.renderer(null, {}, rec({}))
    ok(`review(4): pools grid ${n} renders null as unknown`, /anas-cell-unknown/.test(out || ''), out)
  }
}
{
  const added = []
  const stores = []
  const content = { removeAll() {}, setLoading() {}, add(c) { added.push(c) } }
  const Ext = {
    String: { htmlEncode },
    create: (cls, cfg) => { if (cls === 'Ext.data.Store') { stores.push(cfg); return cfg } return { show() {}, close() {}, down: () => content, destroyed: false } },
    on() {}, un() {}, Msg: { alert() {} },
  }
  const { ANAS } = loadPanels(['40-disks.js'], { Ext })
  ANAS.api = { get: () => Promise.resolve({ data: { attributes: [{ name: 'Reallocated_Sector_Ct' }] } }) }
  const cfg = ANAS.views.disks.factory('n')
  const diskCol = cfg.items[0].columns.find(c => c.dataIndex === 'name')
  const cell = diskCol.renderer('sdx', {}, rec({ id: 'ata-X', name: 'sdx' }))
  ok('review(4): a disk with an unknown rotational flag draws the neutral shape in the Disks view', cell.includes('anas-gfx-icon-disk'), cell.slice(0, 200))
  cfg.items[0].listeners.itemdblclick(null, rec({ id: 'ata-X', name: 'sdx' }))
  await settle(); await settle()
  const attrStore = stores.find(s => s && s.fields && s.fields.some(f => f && f.name === 'failing'))
  for (const n of ['id', 'value', 'worst', 'threshold', 'rawValue', 'failing']) {
    ok(`review(4): SMART attribute field ${n} keeps an absent value null`, !!attrStore && (attrStore.fields.find(f => f.name === n) || {}).allowNull === true)
  }
  const grid = added[0] && added[0].items && added[0].items.find(i => i.itemId === 'smartGrid')
  const col = n => grid && grid.columns.find(c => c.dataIndex === n)
  ok('review(4): an absent "failing" reads Unknown, not No', /Unknown/.test(col('failing').renderer(null)), col('failing').renderer(null))
  for (const n of ['value', 'worst', 'threshold', 'rawValue']) {
    const c = col(n)
    const out = c && c.renderer ? String(c.renderer(null)) : String(null)
    ok(`review(4): an absent SMART ${n} reads a dash, not 0 or "null"`, out.includes('&mdash;') && !out.includes('null'), out)
  }
}

// --- review (5): every file in the fence parses as ES5 ---------------------------
{
  const acorn = await import('acorn')
  for (const f of ['15-gfx.js', '30-pools.js', '31-pool-props.js', '32-pool-create.js', '33-pool-import.js', '34-pool-vdev-remove.js',
    '35-pool-attach.js', '36-pool-export.js', '37-pool-destroy.js', '38-pool-composer.js', '40-disks.js', '50-dashboard.js']) {
    let err = ''
    try { acorn.parse(readFileSync(join(SRC, f), 'utf8'), { ecmaVersion: 5 }) } catch (e) { err = e.message }
    ok(`review(5): ${f} parses as ES5`, err === '', err)
  }
}

// --- daemon contracts (cr3-pools-disks) --------------------------------------
{
  // (1) unmanaged pool row: listed, marked, no verb.
  const NAME = 'tank <b>v2</b> x.y'
  const MSG = `Pool '${NAME}' has a name ANAS does not manage <i>here</i>`
  const created = []
  const alerts = []
  const Ext = {
    String: { htmlEncode },
    create: (cls, cfg) => { created.push({ cls, cfg }); return cls === 'Ext.data.Store' ? cfg : { show() {}, setLoading() {}, down() { return null }, on() {} } },
    on() {}, un() {}, ComponentQuery: { query: () => [] },
    Msg: { alert(_t, m) { alerts.push(m) }, confirm() {} },
  }
  const { ANAS } = loadPanels(['30-pools.js', '31-pool-props.js', '34-pool-vdev-remove.js', '35-pool-attach.js', '36-pool-export.js', '37-pool-destroy.js', '38-pool-composer.js'], { Ext })
  ANAS.gfx.ready = () => true
  ANAS.api = { get: () => new Promise(() => {}), post: () => new Promise(() => {}) }
  let composerOpened = 0
  const realOpen = ANAS.composer.open
  ANAS.composer.open = (o) => { composerOpened++; return realOpen(o) }
  const row = POOL({ name: NAME, unmanaged: { reason: 'pool-name', message: MSG } })
  const g = poolsGrid(row)
  const extra = {}
  for (const a of ANAS.pools.actions) {
    if (a.needsSelection && !g.btns[a.itemId]) {
      extra[a.itemId] = { disabled: false, tip: '', setDisabled(v) { this.disabled = !!v }, setText() {}, setTooltip(v) { this.tip = v } }
    }
  }
  const down = g.down
  g.down = q => extra[q.replace('#', '')] || down(q)
  ANAS.pools.updateButtons(g)
  const all = { ...g.btns, ...extra }
  for (const [id, b] of Object.entries(all)) {
    ok(`contract(1): ${id} is off on a not-managed pool`, b.disabled === true)
    ok(`contract(1): ${id} carries the encoded sentence`, b.tip.includes('&lt;i&gt;here') && !b.tip.includes('<i>'), b.tip)
  }
  const cfg = ANAS.views.pools.factory('n')
  const nameCol = cfg.columns.find(c => c.dataIndex === 'name')
  const cell = nameCol.renderer(NAME, {}, rec(row))
  ok('contract(1): the row is marked NOT MANAGED', cell.includes('NOT MANAGED') && cell.includes('anas-pool-unmanaged'), cell)
  ok('contract(1): the name and the sentence are encoded in the cell', cell.includes('tank &lt;b&gt;v2&lt;/b&gt;') && !cell.includes('<b>v2') && !cell.includes('<i>here'), cell)
  created.length = 0
  cfg.listeners.itemdblclick(null, rec(row))
  ok('contract(1): double-click opens no window on a not-managed pool', !created.some(c => c.cls === 'Ext.window.Window'))
  ok('contract(1): double-click says why', alerts.some(m => m.includes('&lt;i&gt;here')), alerts.join(' | '))
  // A stale button press (an action handler reached anyway) refuses too.
  const tbItems = (cfg.tbar && (cfg.tbar.items || cfg.tbar)) || []
  const addCfg = tbItems.find(i => i && i.itemId === 'addVdevs')
  const gridForBtn = { getSelection: () => [rec(row)] }
  if (addCfg) { addCfg.handler({ up: () => gridForBtn }) }
  eq('contract(1): the composer expand mode is not reachable for it', composerOpened, 0)
  for (const id of ['scrub', 'trim', 'upgrade', 'detail']) {
    const c = tbItems.find(i => i && i.itemId === id)
    created.length = 0
    let sent = 0
    ANAS.runJob = () => { sent++ }
    ANAS.confirmAndRun = () => { sent++ }
    if (c) { c.handler({ up: () => gridForBtn }) }
    ok(`contract(1): a stale ${id} press sends nothing and opens nothing`, sent === 0 && !created.some(x => x.cls === 'Ext.window.Window'))
  }
  // A managed row is untouched by the marker.
  const g2 = poolsGrid(POOL())
  ANAS.pools.updateButtons(g2)
  ok('contract(1): a managed pool keeps its verbs', !g2.btns.scrub.disabled && !g2.btns.detail.disabled)
}
{
  // (1) on the dashboard.
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const html = ANAS.dash.renderPoolsComposite(dashView({
    pools: [{ name: 'tank v2', state: 'ONLINE', capacity: 1, size: 1, allocated: 0, free: 1, scanRunning: false, unmanaged: { reason: 'pool-name', message: 'a <i>name</i> ANAS does not manage' } }], ahrPools: [],
  }, null))
  ok('contract(1): the dashboard block says the pool is not managed, encoded', html.includes('Not managed by ANAS: a &lt;i&gt;name') && !html.includes('<i>name'), html.slice(0, 500))
}
{
  // (4) Telemetry.net null.
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const v = dashView({ pools: [], ahrPools: [] }, null)
  ANAS.api = { get: (_n, p) => (p === '/telemetry' ? Promise.resolve({ arc: { hitRatio: 0.5, size: 1, target: 1, max: 1, l2: null }, pools: [], ahrPools: [], net: null }) : new Promise(() => {})) }
  ANAS.views.dashboard.factory('n').listeners.afterrender(v)
  await settle(); await settle()
  const net = v.down('#anasDashNet').html
  ok('contract(4): a null net reads unavailable, no chart, no zeros', net.includes('Network unavailable') && !net.includes('anas-gfx-timechart') && !net.includes('0 B/s'), net)
}
{
  // (2) disk status 'unknown' and (3) hands-off 'iscsi-unverified'.
  const stores = []
  const Ext = { String: { htmlEncode }, create: (cls, cfg) => { if (cls === 'Ext.data.Store') { stores.push(cfg) } return cfg }, on() {}, un() {}, Msg: { alert() {} } }
  const { ANAS } = loadPanels(['40-disks.js'], { Ext })
  const cfg = ANAS.views.disks.factory('n')
  const groupField = stores[0].fields.find(f => f && f.name === 'groupKey')
  eq('contract(2): status unknown groups under Unknown', groupField.convert(null, rec({ status: 'unknown' })), 'Unknown')
  const usage = cfg.items[0].columns.find(c => c.dataIndex === 'status')
  const u = usage.renderer('unknown', {}, rec({ status: 'unknown' }))
  ok('contract(2): the Usage cell says pool membership could not be read', u.includes('pool membership could not be read') && !u.includes('Available'), u)
  ok('contract(2): the shared picker predicate excludes it', ANAS.gfx.isComposableDisk({ status: 'unknown' }) === false)
  const REASON = 'iSCSI disk; this node\'s LUN serials <could not> be read'
  const h = usage.renderer('available', {}, rec({ status: 'available', handsOff: 'iscsi-unverified', handsOffReason: REASON }))
  ok('contract(3): iscsi-unverified shows the hands-off badge', h.includes('HANDS-OFF') && h.includes('anas-disk-handsoff-badge'), h)
  ok('contract(3): the badge carries the daemon\'s reason, encoded', h.includes('&lt;could not&gt;') && !h.includes('<could not>'), h)
  ok('contract(3): the shared picker predicate excludes it', ANAS.gfx.isComposableDisk({ status: 'available', handsOff: 'iscsi-unverified' }) === false)
}

// --- review2 (1): the grid going away while the composer is open stops nothing --
{
  const c = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A'), DISK('ata-DISK_B')], jobs: ['hold', 'complete'] })
  c.addVdev('data', 'stripe')
  c.addVdev('data', 'stripe')
  c.drop('ata-DISK_A', 'v1')
  c.drop('ata-DISK_B', 'v2')
  c.commit()
  const pv = c.held[0].view
  c.grid.destroyed = true // browser Back/Forward under the modal
  ok('review2(1): the poll view stays alive while the composer is open', pv.destroyed === false)
  c.held[0].onComplete({ status: 'completed' })
  await settle()
  eq('review2(1): the second vdev is still sent', c.requests.length, 2)
  ok('review2(1): the sequence finishes and closes the composer', c.win.destroyed)
  ok('review2(1): no "still being added" prompt is left behind', (c.winCfg.listeners.beforeclose ? c.winCfg.listeners.beforeclose(c.win) : true) === true)
  ok('review2(1): the poll view is dead once both are gone', pv.destroyed === true)
}
{
  // The composer closed (Yes), the grid still alive: the poll lives on.
  const c = await composer({ mode: 'expand', disks: [DISK('ata-DISK_A')], jobs: ['hold'] })
  c.addVdev('data', 'stripe')
  c.drop('ata-DISK_A', 'v1')
  c.commit()
  c.win.destroyed = true
  ok('review2(1): the poll view stays alive while the grid is', c.held[0].view.destroyed === false)
}

// --- review2 (2): Telemetry.poolsUnavailable --------------------------------------
{
  const { ANAS } = loadPanels(['50-dashboard.js'])
  const html = ANAS.dash.renderPoolsComposite(dashView(
    { pools: [{ name: 'tank', state: 'ONLINE', capacity: 1, size: 1, allocated: 0, free: 1, scanRunning: false }], ahrPools: [] },
    { pools: [{ name: 'tank', ...io(), vdevs: [{ name: 'mirror-0', type: 'mirror', role: 'data', state: 'ONLINE', ...io(), disks: [] }] }], ahrPools: [], poolsUnavailable: 'zpool iostat <timed out>' }))
  ok('review2(2): the pool says live I/O is unavailable, with the reason encoded', html.includes('Live I/O unavailable: zpool iostat &lt;timed out&gt;') && !html.includes('<timed out>'), html.slice(0, 600))
  ok('review2(2): never "collecting" when the sample could not be read', !html.includes('collecting'))
  ok('review2(2): no vdev rendered from a sample that is not an observation', !html.includes('anas-dash-vdev-head'))
  const ok2 = ANAS.dash.renderPoolsComposite(dashView(
    { pools: [{ name: 'tank', state: 'ONLINE', capacity: 1, size: 1, allocated: 0, free: 1, scanRunning: false }], ahrPools: [] }, { pools: [], ahrPools: [] }))
  ok('review2(2): without the field a pool with no sample still says collecting', ok2.includes('collecting'))
}

// --- review2 (3): null pool properties and the read-only unmanaged detail -------
{
  const { ANAS } = loadPanels(['30-pools.js'])
  const props = ANAS.pools.propsHtml({ ashift: null, autoexpand: null, autoreplace: false, autotrim: null, failmode: null })
  ok('review2(3): a null property reads unknown in the detail', (props.match(/unknown/g) || []).length === 4 && !props.includes('null'), props)
  ok('review2(3): a read false still reads No', props.includes('>No<'))
}
{
  const set = []
  let closed = false
  const alerts = []
  const form = { setValues(v) { set.push(v) } }
  const win = { destroyed: false, destroying: false, show() {}, setLoading() {}, close() { closed = true }, down: () => ({ getForm: () => form }) }
  const Ext = { String: { htmlEncode }, create: () => win, on() {}, un() {}, Msg: { alert(_t, m) { alerts.push(m) } } }
  const { ANAS } = loadPanels(['30-pools.js', '31-pool-props.js'], { Ext })
  ANAS.api = { get: () => Promise.resolve({ data: { properties: { ashift: 12, autoexpand: true, autoreplace: null, autotrim: true, failmode: 'wait' } } }) }
  ANAS.pools.actions.find(a => a.itemId === 'modifyProps').handler('n', {}, 'tank')
  await settle(); await settle()
  ok('review2(3): Edit Pool refuses to open when a property it edits is null', set.length === 0 && closed && alerts.some(m => /could not be read/.test(m)), JSON.stringify({ set, alerts }))
}
{
  const MSG = 'name <i>tank v2</i> is not managed'
  const btn = { disabled: false, tip: '', setDisabled(v) { this.disabled = !!v }, setTooltip(v) { this.tip = v }, handler: null }
  const content = { removeAll() {}, add() {} }
  let winCfg = null
  const win = { destroyed: false, destroying: false, show() {}, setLoading() {}, down: q => (q === '#changeMount' ? btn : (q === '#content' ? content : null)) }
  const alerts = []
  const Ext = {
    String: { htmlEncode },
    create: (cls, cfg) => { if (cls === 'Ext.window.Window') { winCfg = cfg; return win } return cfg },
    on() {}, un() {}, ComponentQuery: { query: () => [] },
    Msg: { alert(_t, m) { alerts.push(m) } },
  }
  const { ANAS } = loadPanels(['30-pools.js'], { Ext })
  let changed = 0
  ANAS.changeMountpointFlow = () => { changed++ }
  ANAS.errorPanel = m => ({ html: m })
  ANAS.api = { get: () => Promise.resolve({ data: { name: 'tank v2', state: 'ONLINE', mountpoint: '/tank v2', mounted: true, vdevGroups: [], properties: {}, unmanaged: { reason: 'pool-name', message: MSG } } }) }
  ANAS.pools.showPoolDetail('n', 'tank v2')
  await settle(); await settle()
  ok('review2(3): the unmanaged detail offers no Change mount', btn.disabled === true, JSON.stringify(btn))
  ok('review2(3): its tooltip is the daemon sentence, encoded', btn.tip.includes('&lt;i&gt;tank v2') && !btn.tip.includes('<i>'), btn.tip)
  const tb = (winCfg.tbar && (winCfg.tbar.items || winCfg.tbar)) || []
  const cm = tb.find(i => i && i.itemId === 'changeMount')
  if (cm) { cm.handler() }
  eq('review2(3): a stale Change mount press does nothing', changed, 0)
}

// --- review2 (4): one kind mapping in the composer ------------------------------
{
  const c = await composer({ disks: [DISK('nvme0n1', { name: 'nvme0n1', rotational: undefined, transport: '' })] })
  ok('review2(4): the composer draws an nvmeN disk as NVMe (the shared mapping)', c.avail().includes('anas-gfx-icon-nvme'), c.avail().slice(0, 200))
}

// --- daemon contract: zfsUnavailable (the list envelope and the status summary) ---
{
  const SENT = 'ZFS is not available on this node: The ZFS modules <cannot> be auto-loaded.'
  for (const [label, envelope] of [['present', { data: [], zfsUnavailable: SENT }], ['absent', { data: [] }]]) {
    const view = { emptyText: '', refresh() {} }
    const Ext = { String: { htmlEncode }, create: (cls, cfg) => cfg, on() {}, un() {}, Msg: { alert() {} } }
    const { ANAS } = loadPanels(['30-pools.js', '32-pool-create.js', '33-pool-import.js'], { Ext })
    ANAS.api = { get: () => Promise.resolve(envelope) }
    const g = poolsGrid(null)
    const btns = { createPool: { disabled: false, tip: '', setDisabled(v) { this.disabled = !!v }, setTooltip(v) { this.tip = v } }, importPool: { disabled: false, tip: '', setDisabled(v) { this.disabled = !!v }, setTooltip(v) { this.tip = v } } }
    const down = g.down
    g.down = q => btns[q.replace('#', '')] || down(q)
    g.setLoading = () => {}
    g.getStore = () => ({ loadData() {} })
    g.getView = () => view
    ANAS.pools.reload(g, 'n')
    await settle(); await settle()
    if (label === 'present') {
      ok('zfsUnavailable: the Pools view says the sentence, encoded, in place of an empty grid', view.emptyText.includes('&lt;cannot&gt;') && !view.emptyText.includes('<cannot>'), view.emptyText)
      ok('zfsUnavailable: Create is not offered, with the sentence', btns.createPool.disabled && btns.createPool.tip.includes('&lt;cannot&gt;'), JSON.stringify(btns.createPool))
      ok('zfsUnavailable: Import is not offered, with the sentence', btns.importPool.disabled && btns.importPool.tip.includes('&lt;cannot&gt;'))
    } else {
      ok('zfsUnavailable absent: the grid says No pools', view.emptyText.includes('No pools'), view.emptyText)
      ok('zfsUnavailable absent: Create and Import stay offered', !btns.createPool.disabled && !btns.importPool.disabled && btns.createPool.tip === '')
    }
  }
  // The import window, if reached.
  const igView = { emptyText: '' }
  const igrid = { setLoading() {}, getStore: () => ({ loadData() {} }), getView: () => igView }
  const win = { destroyed: false, destroying: false, show() {}, down: q => (q === '#importGrid' ? igrid : null) }
  const Ext = { String: { htmlEncode }, create: (cls, cfg) => (cls === 'Ext.window.Window' ? win : cfg), on() {}, un() {}, Msg: { alert() {} } }
  const { ANAS } = loadPanels(['30-pools.js', '33-pool-import.js'], { Ext })
  ANAS.api = { get: () => Promise.resolve({ data: [], zfsUnavailable: SENT }) }
  ANAS.pools.actions.find(a => a.itemId === 'importPool').handler('n', {})
  await settle(); await settle()
  ok('zfsUnavailable: the import window says the sentence instead of "No importable pools found"', igView.emptyText.includes('&lt;cannot&gt;') && !igView.emptyText.includes('No importable'), igView.emptyText)
  // The dashboard: a plain statement, AHR pools as usual.
  const D = loadPanels(['50-dashboard.js']).ANAS
  const html = D.dash.renderPoolsComposite(dashView({
    pools: [], zfsUnavailable: SENT,
    ahrPools: [{ name: 'hyb', state: 'healthy', usableBytes: 8e12, usedBytes: 1e12, mountpoint: '/mnt/hyb', mounted: true, bands: [], spares: [] }],
  }, null))
  ok('zfsUnavailable: the dashboard states it, encoded', html.includes('ZFS is not available on this node: The ZFS modules &lt;cannot&gt;'), html.slice(0, 400))
  ok('zfsUnavailable: not an error card, not "unavailable", not "No pools"', !html.includes('anas-gfx-callout') && !html.includes('status is unavailable') && !html.includes('No pools.'))
  ok('zfsUnavailable: AHR pools still render', html.includes('anas-dash-pool-ahr'))
  const only = D.dash.renderPoolsComposite(dashView({ pools: [], ahrPools: [], zfsUnavailable: SENT }, null))
  ok('zfsUnavailable: with no AHR pools the statement replaces "No pools."', only.includes('ZFS is not available') && !only.includes('No pools.'))
}

// =============================================================================

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} cr3 pools-panel checks failed:`)
  for (const f of failures) { console.error(`  - ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} cr3 pools-panel checks passed`)
