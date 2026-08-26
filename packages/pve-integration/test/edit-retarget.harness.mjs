#!/usr/bin/env node
/*
 * ANAS — Edit-guard (silent-retarget) harness.
 *
 * The never-substitute rule lives in the UI, so this proves it there: it stubs
 * the ExtJS surface the two edit dialogs touch (windows, forms, combo stores,
 * buttons, Ext.Msg.confirm), opens a REAL edit against inventory that is missing
 * the stored value, presses Save, and asserts that NO request left the dialog.
 *
 * Covers issues #39 (replication task) and #40 (snapshot schedule):
 *   • a stored source/target pool the pool list no longer carries stays selected,
 *     marked "(unavailable)", and blocks Save with a named reason;
 *   • a stored peer/remote location that is no longer registered does the same,
 *     and never resolves to "This node";
 *   • Save is held shut while the location picker is still in flight (the async
 *     window a Save used to slip through);
 *   • a schedule's stored KIND survives an inventory that came back empty (the
 *     AHR branch now reads exactly like the ZFS one — parallel construction);
 *   • a deliberate retarget still works, and declares itself with ?retarget=true;
 *   • CREATE is unchanged: it still defaults to the first available pool.
 *
 *   node packages/pve-integration/test/edit-retarget.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

// ---- Harness-controlled state ----------------------------------------------

const state = {
  /** GET path → response object (or a function of the path). */
  get: {},
  /** POST path → response. */
  post: {},
  /** Every mutation a dialog attempted: { method, path, body }. */
  requests: [],
  alerts: [],
  toasts: [],
  /** Every ANAS.api.post a dialog issued (the test-connection probes). */
  posts: [],
  warnings: [],
  confirms: [],
  /** What Ext.Msg.confirm answers ('yes' | 'no'). */
  confirmAnswer: 'yes',
  /** Paths whose promise is held open until release() is called. */
  hold: null,
}

function reset() {
  state.requests = []
  state.posts = []
  state.alerts = []
  state.toasts = []
  state.warnings = []
  state.confirms = []
  state.confirmAnswer = 'yes'
  state.hold = null
}

// ---- ExtJS stub -------------------------------------------------------------
//
// Only what the dialogs actually use: an itemId-addressable component tree, a
// store with loadData/add/findRecord, value + change events on fields, and the
// confirm dialog. Everything visual is a no-op.

function makeRecord(data) {
  const d = Object.assign({}, data)
  return { get: k => d[k], set: (k, v) => { d[k] = v }, data: d }
}

function makeStore(cfg) {
  let rows = (cfg.data || []).map(makeRecord)
  return {
    isStore: true,
    getCount: () => rows.length,
    getRange: () => rows,
    rows: () => rows.map(r => r.data),
    loadData(arr) { rows = (arr || []).map(makeRecord) },
    add(r) { rows.push(makeRecord(r)) },
    each(fn) { rows.forEach(fn) },
    findRecord(field, value) {
      return rows.find(r => r.get(field) === value) || null
    },
  }
}

function makeComponent(cfg, registry) {
  const c = Object.assign({}, cfg)
  const listeners = {}
  c._children = []
  c.hidden = !!cfg.hidden
  c.disabled = !!cfg.disabled
  c._value = cfg.value !== undefined ? cfg.value
    : (cfg.checked !== undefined ? !!cfg.checked : undefined)

  c.getValue = () => c._value
  c.setValue = (v) => {
    const old = c._value
    c._value = v
    if (old !== v && listeners.change) {
      for (const fn of listeners.change.slice()) { fn(c, v, old) }
    }
  }
  c.on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) }
  c.setHidden = (v) => { c.hidden = !!v }
  c.setDisabled = (v) => { c.disabled = !!v }
  c.setHtml = (h) => { c.html = h }
  c.setText = (v) => { c.text = v }
  c.setIconCls = (v) => { c.iconCls = v }
  c.setTooltip = (v) => { c.tooltip = v }
  c.setEmptyText = (v) => { c.emptyText = v }
  c.setEditable = (v) => { c.editable = v }
  c.setLoading = () => {}
  c.expand = () => { c.collapsed = false }
  c.collapse = () => { c.collapsed = true }
  c.removeAll = () => { c._children = [] }
  c.add = items => [].concat(items).forEach(i => c._children.push(makeComponent(i, registry)))
  c.getStore = () => c.store
  c.getForm = () => ({ isValid: () => true })
  c.getSelection = () => c._selection || []
  c.down = sel => byItemId(c, String(sel).replace('#', ''))
  c.destroyed = false
  c.destroying = false

  if (cfg.store && !cfg.store.isStore) { c.store = makeStore(cfg.store) }
  if (cfg.itemId) { registry[cfg.itemId] = c }
  for (const child of [].concat(cfg.items || [], cfg.buttons || [], cfg.tbar || [])) {
    if (child && typeof child === 'object') {
      const built = makeComponent(child, registry)
      built._parent = c
      c._children.push(built)
    }
  }
  return c
}

/** Depth-first search for a descendant (or self) by itemId. */
function byItemId(root, id) {
  if (!root) { return null }
  if (root.itemId === id) { return root }
  for (const child of root._children || []) {
    const hit = byItemId(child, id)
    if (hit) { return hit }
  }
  return null
}

/** Depth-first search for the one component carrying this cls (or null). */
function byCls(root, cls) {
  if (!root) { return null }
  if (root.cls === cls) { return root }
  for (const child of root._children || []) {
    const hit = byCls(child, cls)
    if (hit) { return hit }
  }
  return null
}

// Press a button found by its cls — the operator's own click path. A missing
// control is a reported failure, not a crash: the run must still print the rest.
function click(root, cls) {
  const btn = byCls(root, cls)
  const live = !!(btn && typeof btn.handler === 'function')
  ok(`the "${cls}" control is there to click`, live)
  if (live) { btn.handler(btn) }
  return btn
}

function makeWindow(cfg) {
  const registry = {}
  const win = makeComponent(cfg, registry)
  win.down = sel => registry[String(sel).replace('#', '')] || null
  win.show = () => { win.shown = true }
  win.close = () => { win.destroyed = true }
  win.up = () => null
  return win
}

const Ext = {
  create(cls, cfg) {
    if (cls === 'Ext.data.Store') { return makeStore(cfg || {}) }
    if (cls === 'Ext.window.Window') { return makeWindow(cfg || {}) }
    throw new Error(`stub Ext.create: unexpected class ${cls}`)
  },
  String: { htmlEncode: s => String(s == null ? '' : s) },
  Date: { format: (d, f) => `${d}${f}` },
  Msg: {
    confirm(title, msg, fn) {
      state.confirms.push({ title, msg })
      fn(state.confirmAnswer)
    },
  },
}

// ---- ANAS stub --------------------------------------------------------------

function apiAnswer(table, path) {
  if (!(path in table)) {
    return Promise.reject(new Error(`no fixture for ${path}`))
  }
  const v = table[path]
  const value = typeof v === 'function' ? v() : v
  if (state.hold && state.hold.path === path) {
    return new Promise((resolve) => { state.hold.release = () => resolve(value) })
  }
  return Promise.resolve(value)
}

function loadUi() {
  const doc = {
    cookie: '',
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  const win = { document: doc, Ext }
  const sandbox = {
    window: win,
    document: doc,
    Ext,
    console,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  }
  // 10-api.js first, exactly as the real page loads it: the dialogs' save gate
  // is the shared ANAS.editGuard it defines, and this harness wants to prove the
  // REAL helper, not a re-stub of it. It also installs the fetch-based
  // ANAS.api / runJob / pollJob / casWrite — the stub fields below are applied
  // OVER those afterwards, so the recording doubles win, as before.
  vm.runInNewContext(readFileSync(join(SRC, '10-api.js'), 'utf8'), sandbox, { filename: '10-api.js' })
  Object.assign(win.ANAS, {
    views: {},
    t: s => s,
    enc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    errText: e => String((e && e.message) || e),
    formatBytes: b => `${b}`,
    warn: m => state.warnings.push(m),
    toast: m => state.toasts.push(m),
    alertMsg: (title, msg) => state.alerts.push({ title, msg }),
    errorPanel: m => ({ html: m }),
    tbar: items => ({ xtype: 'toolbar', items }), // real 00-core.js helper
    pollJob: () => Promise.resolve({}),
    gfx: { ready: () => false },
    sched: { absTime: v => String(v || '') },
    notifyMode: {
      field: cfg => Object.assign({ xtype: 'combobox' }, cfg),
      of: (v, d) => v || d,
      hintHtml: () => '',
    },
    api: {
      get: (_node, path) => apiAnswer(state.get, path),
      post: (_node, path, body) => {
        state.posts.push({ path, body })
        return apiAnswer(state.post, path)
      },
    },
    runJob(opts) {
      state.requests.push({ method: opts.method, path: opts.path, body: opts.body })
    },
    casWrite(opts) {
      state.requests.push({ method: opts.method, path: opts.path, body: opts.body })
    },
  })
  vm.runInNewContext(readFileSync(join(SRC, '65-replication.js'), 'utf8'), sandbox, { filename: '65-replication.js' })
  vm.runInNewContext(readFileSync(join(SRC, '69-snapshots.js'), 'utf8'), sandbox, { filename: '69-snapshots.js' })
  return win.ANAS
}

const ANAS = loadUi()

/** Let every pending promise chain settle. */
async function settle(n = 8) {
  for (let i = 0; i < n; i++) { await new Promise(r => setImmediate(r)) }
}

/** A grid stand-in — the dialogs only check destroyed/destroying. */
function fakeGrid() {
  return { destroyed: false, destroying: false, down: () => null, getSelection: () => [] }
}

/** Open the replication task dialog and return its window. */
async function openTask(existing) {
  const grid = fakeGrid()
  ANAS.replication.openTaskDialog('n1', grid, existing)
  await settle()
  return lastWindow
}

/** Open the snapshot schedule dialog and return its window. */
async function openSchedule(existing) {
  const grid = fakeGrid()
  ANAS.schedules.openDialog('n1', grid, existing)
  await settle()
  return lastWindow
}

// Ext.create hands back the window; remember the newest so the openers can
// return it without the dialogs having to expose anything.
let lastWindow = null
const realCreate = Ext.create
Ext.create = function (cls, cfg) {
  const out = realCreate.call(Ext, cls, cfg)
  if (cls === 'Ext.window.Window') { lastWindow = out }
  return out
}

/** Press a window's Save/Create button (its handler, exactly as ExtJS would). */
function pressSave(win) {
  const btn = win.down('#submit')
  if (!btn) { throw new Error('no #submit button on this window') }
  btn.handler(btn)
}

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

/** The first alert's message, or '' — a check must never crash the run. */
function alertMsg() {
  return state.alerts.length ? state.alerts[0].msg : ''
}

/** A window's guard-note HTML, or '' if the dialog has none. */
function noteHtml(win) {
  const note = win.down('#guardNote')
  return (note && note.html) || ''
}

// ---- Fixtures ---------------------------------------------------------------

const POOLS = { data: [{ name: 'tank' }, { name: 'backup' }] }
const DATASETS = { data: [{ name: 'tank' }, { name: 'tank/media' }] }

function baseGets(extra) {
  return Object.assign({
    '/pools': POOLS,
    '/pools/tank/datasets': DATASETS,
    '/pools/backup/datasets': { data: [{ name: 'backup' }] },
    '/pools/vanished/datasets': { data: [] },
    '/replication/locations': { data: { peers: [], remotes: [] } },
  }, extra || {})
}

const TASK = {
  name: 'nightly-media',
  source: { pool: 'tank', dataset: 'media' },
  target: { pool: 'backup', dataset: 'media' },
  schedule: 'daily',
  snapshotFirst: true,
  notify: 'on-failure',
  enabled: true,
}

// =============================================================================
//  #39 — replication task edit
// =============================================================================

// --- 1. A stored SOURCE pool the inventory lost --------------------------------
{
  reset()
  state.get = baseGets()
  const win = await openTask(Object.assign({}, TASK, { source: { pool: 'vanished', dataset: 'media' } }))

  eq('source pool keeps the STORED value, not the first pool', win.down('#sourcePool').getValue(), 'vanished')
  const srcRows = win.down('#sourcePool').getStore().rows()
  ok('the missing source pool is offered as an "(unavailable)" row',
    srcRows.some(r => r.name === 'vanished' && r.unavailable && /unavailable/.test(r.label)),
    JSON.stringify(srcRows))
  eq('Save is disabled', win.down('#submit').disabled, true)
  ok('the reason names the pool', /vanished/.test(noteHtml(win)), noteHtml(win))
  ok('the guard note is visible', win.down('#guardNote').hidden === false)

  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
  eq('and says why', state.alerts.length, 1)
  ok('the alert names the pool', /vanished/.test(alertMsg()), alertMsg())
}

// --- 2. A stored TARGET pool the inventory lost --------------------------------
{
  reset()
  state.get = baseGets()
  const win = await openTask(Object.assign({}, TASK, { target: { pool: 'vanished', dataset: 'media' } }))

  eq('target pool keeps the STORED value', win.down('#targetPool').getValue(), 'vanished')
  eq('Save is disabled', win.down('#submit').disabled, true)
  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
}

// --- 3. A stored REMOTE location that is no longer registered ------------------
{
  reset()
  state.get = baseGets({ '/replication/locations': { data: { peers: [], remotes: [] } } })
  const win = await openTask(Object.assign({}, TASK, {
    target: { pool: 'backup', dataset: 'media', location: { kind: 'remote', name: 'offsite' } },
  }))

  eq('the location combo still holds the stored remote', win.down('#targetLocation').getValue(), 'remote:offsite')
  const locRows = win.down('#targetLocation').getStore().rows()
  ok('the lost remote is offered as an "(unavailable)" row',
    locRows.some(r => r.value === 'remote:offsite' && /unavailable/.test(r.label)),
    JSON.stringify(locRows))
  ok('it did NOT silently become "This node"', win.down('#targetLocation').getValue() !== 'local')
  eq('Save is disabled', win.down('#submit').disabled, true)
  ok('the reason names the remote', /offsite/.test(noteHtml(win)), noteHtml(win))

  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
}

// --- 4. The async window: Save is shut until the locations answer ---------------
{
  reset()
  state.get = baseGets()
  state.hold = { path: '/replication/locations' }
  const grid = fakeGrid()
  ANAS.replication.openTaskDialog('n1', grid, TASK)
  await settle()
  const win = lastWindow
  eq('Save is disabled while the location picker is in flight', win.down('#submit').disabled, true)
  pressSave(win)
  eq('a Save inside that window sends NOTHING', state.requests.length, 0)

  state.hold.release()
  state.hold = null
  await settle()
  eq('Save opens once the picker has resolved', win.down('#submit').disabled, false)
}

// --- 5. An unchanged edit saves — with no retarget flag -------------------------
{
  reset()
  state.get = baseGets()
  const win = await openTask(TASK)
  eq('Save is enabled for a healthy edit', win.down('#submit').disabled, false)
  win.down('#schedule').setValue('weekly')
  pressSave(win)
  eq('one request went out', state.requests.length, 1)
  const sent = state.requests[0] || { path: '', body: { source: {}, target: {} } }
  eq('as a PUT on the task', sent.path, '/replication/tasks/nightly-media')
  ok('with no ?retarget flag', !/retarget/.test(sent.path))
  eq('and the stored source is preserved verbatim', sent.body.source.pool, 'tank')
  eq('as is the stored target', sent.body.target.pool, 'backup')
  eq('no confirmation was demanded', state.confirms.length, 0)
}

// --- 6. A DELIBERATE retarget: confirmed, flagged, sent -------------------------
{
  reset()
  state.get = baseGets()
  const win = await openTask(TASK)
  win.down('#targetPool').setValue('tank')
  pressSave(win)
  eq('the move is put to the operator', state.confirms.length, 1)
  const confirmMsg = state.confirms.length ? state.confirms[0].msg : ''
  ok('naming both ends', /backup\/media/.test(confirmMsg) && /tank\/media/.test(confirmMsg), confirmMsg)
  eq('and on yes it is sent', state.requests.length, 1)
  ok('declaring itself with ?retarget=true',
    state.requests.length === 1 && /\?retarget=true$/.test(state.requests[0].path),
    JSON.stringify(state.requests))

  // On no, nothing happens at all.
  reset()
  state.get = baseGets()
  state.confirmAnswer = 'no'
  const win2 = await openTask(TASK)
  win2.down('#targetPool').setValue('tank')
  pressSave(win2)
  eq('a declined retarget sends nothing', state.requests.length, 0)
}

// --- 6b. A pool list that came back EMPTY still opens the edit ------------------
{
  reset()
  state.get = baseGets({ '/pools': { data: [] } })
  const win = await openTask(TASK)
  ok('the dialog opens instead of vanishing', !!win && !!win.down('#submit'))
  eq('holding both stored endpoints', win.down('#sourcePool').getValue(), 'tank')
  eq('Save is disabled', win.down('#submit').disabled, true)
  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
}

// --- 7. CREATE is unchanged: it still defaults ---------------------------------
{
  reset()
  state.get = baseGets()
  const win = await openTask(null)
  eq('a new task defaults to the first pool', win.down('#sourcePool').getValue(), 'tank')
  eq('and the same for the target', win.down('#targetPool').getValue(), 'tank')
  eq('Save is open', win.down('#submit').disabled, false)
  eq('no guard note', win.down('#guardNote').hidden, true)
}

// =============================================================================
//  #40 — snapshot schedule edit
// =============================================================================

const AHR_SCHED = {
  id: 'vault-daily',
  name: 'Vault daily',
  target: { kind: 'ahr', pool: 'vault' },
  cadence: 'daily',
  retention: { daily: 7 },
  notify: 'on-failure',
  enabled: true,
}

function schedGets(extra) {
  return Object.assign({
    '/pools': POOLS,
    '/pools/tank/datasets': DATASETS,
    '/ahr': { data: [{ name: 'vault', subvolLayout: true }, { name: 'attic', subvolLayout: true }] },
  }, extra || {})
}

// --- 8. AHR inventory came back EMPTY (the fail-open [] of #40) -----------------
{
  reset()
  state.get = schedGets({ '/ahr': { data: [] } })
  const win = await openSchedule(AHR_SCHED)

  eq('the stored KIND stands — no flip to the only inventory that answered',
    win.down('#targetKind').getValue(), 'ahr')
  eq('the stored AHR pool stands', win.down('#ahrPool').getValue(), 'vault')
  ok('the kind combo offers the stored kind, marked',
    win.down('#targetKind').getStore().rows().some(r => r.kind === 'ahr' && /unavailable/.test(r.label)),
    JSON.stringify(win.down('#targetKind').getStore().rows()))
  eq('Save is disabled', win.down('#submit').disabled, true)
  ok('the reason is named', /AHR/.test(noteHtml(win)), noteHtml(win))

  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
  eq('and says why', state.alerts.length, 1)
}

// --- 9. An AHR pool missing from a NON-empty list -------------------------------
{
  reset()
  state.get = schedGets({ '/ahr': { data: [{ name: 'attic', subvolLayout: true }] } })
  const win = await openSchedule(AHR_SCHED)
  eq('the stored pool is not swapped for the first one listed', win.down('#ahrPool').getValue(), 'vault')
  eq('Save is disabled', win.down('#submit').disabled, true)
  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
}

// --- 10. The ZFS branch reads identically (parallel construction) ---------------
{
  reset()
  state.get = schedGets({ '/pools': { data: [{ name: 'backup' }] } })
  const win = await openSchedule({
    id: 'media-daily',
    name: 'Media daily',
    target: { kind: 'zfs', dataset: 'tank/media' },
    cadence: 'daily',
    retention: { daily: 7 },
    enabled: true,
  })
  eq('the stored ZFS pool stands', win.down('#zfsPool').getValue(), 'tank')
  eq('Save is disabled', win.down('#submit').disabled, true)
  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
}

// --- 11. A healthy schedule edit still saves its stored target ------------------
{
  reset()
  state.get = schedGets()
  const win = await openSchedule(AHR_SCHED)
  eq('Save is open', win.down('#submit').disabled, false)
  win.down('#cadence').setValue('hourly')
  pressSave(win)
  eq('one request went out', state.requests.length, 1)
  const put = state.requests[0] || { path: '', body: { target: {} } }
  eq('as a PUT on the schedule', put.path, '/schedules/vault-daily')
  eq('carrying the stored kind', put.body.target.kind, 'ahr')
  eq('and the stored pool', put.body.target.pool, 'vault')
}

// --- 11b. Both inventories empty: the edit still opens, blocked ----------------
{
  reset()
  state.get = schedGets({ '/pools': { data: [] }, '/ahr': { data: [] } })
  const win = await openSchedule(AHR_SCHED)
  ok('the dialog opens instead of vanishing', !!win && !!win.down('#submit'))
  eq('the stored kind stands', win.down('#targetKind').getValue(), 'ahr')
  eq('Save is disabled', win.down('#submit').disabled, true)
  pressSave(win)
  eq('pressing Save sends NOTHING', state.requests.length, 0)
}

// --- 12. Creating a schedule is unchanged --------------------------------------
{
  reset()
  state.get = schedGets()
  const win = await openSchedule(null)
  eq('a new schedule defaults to a kind that exists', win.down('#targetKind').getValue(), 'zfs')
  eq('Save is open', win.down('#submit').disabled, false)
  eq('no guard note', win.down('#guardNote').hidden, true)
}

// =============================================================================
//  #39 companion — the rekeyed remote is repairable, and the key is recorded
// =============================================================================
// 'hostkey-changed' used to be reported as a permanent 'unreachable' whose only
// cure was hand-editing known_hosts, and hostKeyFingerprint was never written by
// anything, so the Host key column read "not pinned" forever.

const OLD_FP = 'SHA256:oldoldoldoldoldoldoldoldoldoldoldoldold01'
const NEW_FP = 'SHA256:newnewnewnewnewnewnewnewnewnewnewnewnew02'

const REGISTRY = {
  data: {
    version: 3,
    remotes: [{ name: 'nas1', host: '10.0.0.9', port: 22, user: 'root', hostKeyFingerprint: OLD_FP }],
    publicKey: 'ssh-ed25519 AAAAPUB anas-replication',
  },
}

/** Open the Remotes manager and hand back its window. */
async function openRemotes() {
  ANAS.replication.openRemotes('n1')
  await settle()
  return lastWindow
}

// --- 13. A changed host key shows BOTH fingerprints and offers re-trust ---------
{
  reset()
  state.get = { '/replication/remotes': REGISTRY }
  state.post = {
    '/replication/remotes/test': { data: { stage: 'hostkey-changed', knownFingerprint: OLD_FP, fingerprint: NEW_FP, detail: 'Host key verification failed.' } },
    '/replication/remotes/test?retrust=true': { data: { stage: 'ok', fingerprint: NEW_FP, zfsVersion: 'zfs-2.2.3' } },
  }
  const mgr = await openRemotes()
  click(mgr, 'anas-btn-remote-add')
  const wizard = lastWindow
  wizard.down('#name').setValue('nas1')
  wizard.down('#host').setValue('10.0.0.9')

  click(wizard, 'anas-btn-remote-testconn')
  await settle()
  const result = wizard.down('#testResult')
  const shown = result._children.map(c => c.html || '').join('')
  ok('the pinned fingerprint is shown', shown.includes(OLD_FP), shown)
  ok('so is the one the host presents now', shown.includes(NEW_FP), shown)
  ok('and the two are labelled, not merged', /Pinned:/.test(shown) && /Presented now:/.test(shown), shown)
  ok('the wording names the innocent explanation', /rebuilt|regenerated/.test(shown), shown)
  ok('and the other one, without theatrics', /something else is/.test(shown), shown)
  ok('the connection is not treated as usable', wizard._tested !== true)

  // Re-trust is a SECOND, explicit decision.
  eq('the probe carried no pin flag', (state.posts[0] || {}).path, '/replication/remotes/test')
  click(result, 'anas-btn-remote-retrust')
  eq('replacing a pinned key asks first', state.confirms.length, 1)
  const question = state.confirms.length ? state.confirms[0].msg : ''
  ok('and repeats both fingerprints in the question',
    question.includes(OLD_FP) && question.includes(NEW_FP), question)
  await settle()
  eq('the confirmed re-trust is the only request that asks to replace',
    state.posts.filter(p => /retrust=true/.test(p.path)).length, 1)

  // ...and the newly pinned key rides along when the remote is saved, so the
  // Host key column stops saying "not pinned".
  click(wizard, 'anas-btn-remote-save')
  eq('the save went out', state.requests.length, 1)
  const saved = state.requests[0] || { body: { remote: {} } }
  eq('carrying the pinned fingerprint', saved.body.remote.hostKeyFingerprint, NEW_FP)
}

// --- 14. A declined re-trust replaces nothing ----------------------------------
{
  reset()
  state.get = { '/replication/remotes': REGISTRY }
  state.post = {
    '/replication/remotes/test': { data: { stage: 'hostkey-changed', knownFingerprint: OLD_FP, fingerprint: NEW_FP } },
  }
  state.confirmAnswer = 'no'
  const mgr = await openRemotes()
  click(mgr, 'anas-btn-remote-add')
  const wizard = lastWindow
  wizard.down('#host').setValue('10.0.0.9')
  click(wizard, 'anas-btn-remote-testconn')
  await settle()
  click(wizard.down('#testResult'), 'anas-btn-remote-retrust')
  await settle()
  eq('nothing asked to replace the pin', state.posts.filter(p => /retrust/.test(p.path)).length, 0)
}

// --- 15. Editing a remote never blanks its pinned key --------------------------
{
  reset()
  state.get = { '/replication/remotes': REGISTRY }
  const mgr = await openRemotes()
  const grid = mgr.down('#remotesGrid')
  grid.listeners.itemdblclick(grid, makeRecord({ raw: REGISTRY.data.remotes[0] }))
  const wizard = lastWindow
  wizard.down('#user').setValue('backup')
  click(wizard, 'anas-btn-remote-save')
  eq('the edit went out', state.requests.length, 1)
  const edited = state.requests[0] || { body: { remote: {} } }
  eq('with the stored fingerprint intact', edited.body.remote.hostKeyFingerprint, OLD_FP)
  eq('and the edited field applied', edited.body.remote.user, 'backup')
}

// ---- Report -----------------------------------------------------------------

ok('no view warned unexpectedly', state.warnings.length === 0, state.warnings.join(' | '))

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} edit-guard checks passed`)
