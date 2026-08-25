#!/usr/bin/env node
/*
 * ANAS — Dialog-contract harness: what the PVE-UI dialogs actually SEND.
 *
 * A companion to the render harnesses (dashboard-telemetry, gfx-timechart):
 * those prove what a view DRAWS, this one proves what a dialog POSTs/PUTs. It
 * stubs the slice of ExtJS the ES5 sources touch (a component tree with
 * down()/up()/getValue(), a store, a grid selection model), loads the real
 * sources in a vm sandbox, drives the real toolbar handlers, and asserts on the
 * captured request bodies.
 *
 * What it guards:
 *
 *   1. Backup task edit → Save round-trips EVERY field of the BackupTask schema.
 *      The keys are read from the shared Zod schema itself, so a field added to
 *      BackupTask that the dialog does not carry FAILS here rather than being
 *      silently reset to its schema default on the next save. (That is exactly
 *      how `limitNofile` — a real prlimit --nofile on the generated unit — was
 *      lost, after `cadence` before it.)
 *   2. The enable/disable toggle round-trips every field too: a toggle is a PUT
 *      of the WHOLE task, so it drops fields just as easily as the dialog.
 *   3. Import Pool sends the GUID it displays — duplicate-name imports are the
 *      whole reason the scan reports a GUID.
 *   4. Datasets: a VOLUME (zvol) and a FILESYSTEM are the same dialog sending
 *      two different bodies (story iscsi.3). Guards that a filesystem create is
 *      still byte-identical to what it was before volumes existed (version
 *      skew), that a volume create carries the zvol keys and NO filesystem
 *      ones, that Resize Volume grows only — an untouched edit sends nothing, a
 *      shrink sends nothing — and the toolbar gating matrix for a volume row,
 *      including the tooltip reason on each disabled control.
 *
 *   node packages/pve-integration/test/dialog-contracts.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { BackupTask, cadenceToOnCalendar } from '@anas/shared'

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
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ============================================================================
//  A minimal ExtJS: component tree, fields, stores, grid selection
// ============================================================================

function makeRecord(data) {
  const d = { ...data }
  return { data: d, get: k => d[k], set: (k, v) => { d[k] = v } }
}

/**
 * A tree node as the ES5 sources use one: get()/set(), childNodes, isExpanded().
 * Built from the plain `{ …fields, children: [] }` objects buildPoolNode emits.
 */
function makeNode(cfg, parent) {
  const data = { ...cfg }
  const kids = data.children || []
  delete data.children
  const node = {
    data,
    parentNode: parent || null,
    get: k => data[k],
    set: (k, v) => { data[k] = v },
    isExpanded: () => !!data.expanded,
    childNodes: [],
  }
  for (const kid of kids) { node.childNodes.push(makeNode(kid, node)) }
  return node
}

function makeTreeStore(cfg) {
  const store = {
    isStore: true,
    isTreeStore: true,
    fields: (cfg.fields || []).map(f => (typeof f === 'string' ? f : f.name)),
    root: makeNode(cfg.root || { children: [] }, null),
    getRootNode() { return this.root },
    setRootNode(rootCfg) { this.root = makeNode(rootCfg, null); return this.root },
  }
  return store
}

function makeStore(cfg) {
  const rows = []
  const store = {
    isStore: true,
    fields: (cfg.fields || []).map(f => (typeof f === 'string' ? f : f.name)),
    loadData(list) { rows.length = 0; for (const r of list || []) rows.push(makeRecord(r)) },
    getRange: () => rows.slice(),
    getCount: () => rows.length,
    getAt: i => rows[i],
    each(fn) { rows.slice().forEach(fn) },
    findExact(field, value) { return rows.findIndex(r => r.get(field) === value) },
    findRecord(field, value) { return rows.find(r => r.get(field) === value) || null },
    add(r) { rows.push(r.get ? r : makeRecord(r)) },
    removeAll() { rows.length = 0 },
  }
  if (cfg.data) { store.loadData(cfg.data) }
  return store
}

const CHECKBOXES = ['checkbox', 'checkboxfield', 'radiofield', 'radio']

function makeComponent(cfg, parent) {
  const c = { ...(cfg && typeof cfg === 'object' ? cfg : { xtype: 'tbseparator' }) }
  c.parent = parent || null
  c.destroyed = false
  c.destroying = false
  c.hidden = !!c.hidden
  c.disabled = !!c.disabled
  c._on = {}
  c._selection = []

  const kids = []
  const build = list => (list || [])
    .filter(x => x && typeof x === 'object')
    .map((k) => { const kc = makeComponent(k, c); kids.push(kc); return kc })

  const own = build(cfg && cfg.items)
  c.buttonCmps = build(cfg && cfg.buttons)
  c.tbarCmps = build(cfg && cfg.tbar)

  // The `items` collection Ext hands back: each()/add()/remove() are all the
  // ES5 sources use of it (readArchives walks it).
  const items = own.slice()
  c.items = {
    each(fn) { items.slice().forEach(fn) },
    getCount: () => items.length,
    getAt: i => items[i],
    getRange: () => items.slice(),
    indexOf: x => items.indexOf(x),
  }
  c.childCmps = () => items.concat(c.buttonCmps, c.tbarCmps)

  c.add = function (what) {
    const list = Array.isArray(what) ? what : [what]
    let last = null
    for (const one of list) {
      const kc = makeComponent(one, c)
      items.push(kc)
      last = kc
    }
    return Array.isArray(what) ? items.slice(-list.length) : last
  }
  c.remove = function (cmp) {
    const i = items.indexOf(cmp)
    if (i >= 0) { items.splice(i, 1) }
    if (cmp) { cmp.destroyed = true }
  }
  c.removeAll = function () { items.length = 0 }

  function matches(cmp, sel) {
    return sel.charAt(0) === '#' ? cmp.itemId === sel.slice(1) : cmp.xtype === sel
  }
  c.down = function (sel) {
    for (const kid of c.childCmps()) {
      if (matches(kid, sel)) { return kid }
      const deep = kid.down(sel)
      if (deep) { return deep }
    }
    return null
  }
  c.up = function (sel) {
    let p = c.parent
    while (p) {
      if (!sel || matches(p, sel)) { return p }
      p = p.parent
    }
    return null
  }

  // --- field value semantics, per xtype ---
  const isCheckbox = CHECKBOXES.indexOf(c.xtype) >= 0
  const isRadioGroup = c.xtype === 'radiogroup'
  c.getValue = function () {
    if (isCheckbox) { return !!c.checked }
    if (isRadioGroup) {
      for (const kid of c.childCmps()) {
        if (kid.checked) { return { [kid.name]: kid.inputValue } }
      }
      return null
    }
    if (c.xtype === 'numberfield') {
      return (c.value === undefined || c.value === null || c.value === '') ? null : Number(c.value)
    }
    return c.value === undefined || c.value === null ? '' : c.value
  }
  c.setValue = function (v) {
    if (isCheckbox) { c.checked = !!v }
    else if (isRadioGroup) {
      const want = v && typeof v === 'object' ? v[Object.keys(v)[0]] : v
      for (const kid of c.childCmps()) { kid.checked = kid.inputValue === want }
    }
    else { c.value = v }
    c.fireEvent('change', c, v)
    return c
  }

  c.on = function (ev, fn) { (c._on[ev] = c._on[ev] || []).push(fn) }
  c.fireEvent = function (ev, ...args) {
    for (const fn of c._on[ev] || []) { fn(...args) }
    const l = cfg && cfg.listeners && cfg.listeners[ev]
    if (typeof l === 'function') { l.apply(c, args) }
  }

  c.getStore = () => c.store
  c.getSelection = () => c._selection.slice()
  // Tree panels delegate the root to their store (the ES5 sources call both).
  c.getRootNode = () => (c.store && c.store.getRootNode ? c.store.getRootNode() : null)
  c.setRootNode = function (rootCfg) {
    return c.store && c.store.setRootNode ? c.store.setRootNode(rootCfg) : null
  }
  /** Select a TREE node (as opposed to a grid row) and fire selectionchange. */
  c.selectNode = function (node) {
    c._selection = node ? [node] : []
    c.fireEvent('selectionchange', {}, c._selection)
    return node
  }
  c.getSelectionModel = () => ({
    select(idx) {
      const rec = c.store.getAt(idx)
      c._selection = rec ? [rec] : []
    },
  })
  /** What a click on a row does: set the selection and fire the grid's listener. */
  c.selectRow = function (idx) {
    const rec = c.store.getAt(idx)
    c._selection = rec ? [rec] : []
    c.fireEvent('selectionchange', {}, c._selection)
    return rec
  }

  c.setLoading = () => c
  c.setHidden = function (v) { c.hidden = !!v; return c }
  c.setVisible = function (v) { c.hidden = !v; return c }
  c.isVisible = () => !c.hidden
  c.setDisabled = function (v) { c.disabled = !!v; return c }
  c.setText = function (v) { c.text = v; return c }
  c.setIconCls = function (v) { c.iconCls = v; return c }
  c.update = function (h) { c.html = h; return c }
  c.setHtml = function (h) { c.html = h; return c }
  c.getForm = () => ({ isValid: () => true, getValues: () => ({}) })
  c.getEl = () => ({ on() {}, dom: {} })
  c.getWidth = () => 900
  c.show = function () { c.hidden = false; return c }
  c.close = function () { c.destroyed = true; return c }
  c.destroy = function () { c.destroyed = true; return c }
  c.focus = () => c
  c.query = () => []

  return c
}

/** Everything Ext.create() handed out, so a harness can find the open window. */
const created = { windows: [] }

const Ext = {
  ComponentQuery: { query: () => [] },
  create(cls, cfg) {
    if (cls === 'Ext.data.TreeStore') { return makeTreeStore(cfg || {}) }
    if (cls === 'Ext.data.Store') { return makeStore(cfg || {}) }
    const cmp = makeComponent({ xtype: 'window', ...(cfg || {}) }, null)
    if (cls === 'Ext.window.Window') { created.windows.push(cmp) }
    return cmp
  },
  String: { htmlEncode: s => String(s == null ? '' : s) },
  Date: { format: d => String(d) },
  Msg: {
    confirm(_title, _msg, fn) { if (fn) { fn('yes') } },
    alert() {},
  },
}

/** The most recently opened, still-open window. */
function openWindow() {
  for (let i = created.windows.length - 1; i >= 0; i--) {
    if (!created.windows[i].destroyed) { return created.windows[i] }
  }
  return null
}

// ============================================================================
//  The ANAS surface the sources call
// ============================================================================

const warnings = []
/** Every job the UI submitted: method, path and the exact body. */
const jobs = []

function makeAnas(routes) {
  return {
    views: {},
    pools: { registerAction(a) { this._actions = (this._actions || []).concat([a]) }, reload() {} },
    datasets: {},
    // The Datasets view degrades gracefully without the gfx layer (every call
    // site checks gfxReady first), and this harness is about what the dialogs
    // SEND, not what they draw — so gfx stays absent here on purpose.
    formatBytes: n => `${Number(n) || 0} B`,
    formatBool: b => (b ? 'on' : 'off'),
    editWindow: () => null,
    t: s => s,
    enc: s => String(s == null ? '' : s),
    warn(m) { warnings.push(m) },
    errText: e => String((e && e.message) || e),
    toast() {},
    alertMsg(title, msg) { warnings.push(`alert: ${title}: ${msg}`) },
    errorPanel: msg => ({ xtype: 'component', html: msg }),
    warningsHtml: () => '',
    renderState: s => String(s),
    notifyMode: {
      of(value, dflt) {
        const s = String(value == null ? '' : value).toLowerCase()
        if (s === 'always') { return 'always' }
        if (s === 'on-failure') { return 'on-failure' }
        return dflt === 'always' ? 'always' : 'on-failure'
      },
      field: cfg => ({ xtype: 'combobox', itemId: cfg.itemId, cls: cfg.cls, value: cfg.value }),
      hintHtml: () => '',
      rowHtml: () => '',
    },
    api: {
      get(_node, path) {
        const key = `GET ${path.split('?')[0]}`
        return key in routes ? Promise.resolve(routes[key]) : Promise.reject(new Error(`unexpected ${key}`))
      },
      post(_node, path, body) {
        const key = `POST ${path}`
        if (!(key in routes)) { return Promise.reject(new Error(`unexpected ${key}`)) }
        return Promise.resolve(typeof routes[key] === 'function' ? routes[key](body) : routes[key])
      },
    },
    runJob(cfg) {
      jobs.push({ method: cfg.method, path: cfg.path, body: cfg.body })
      if (cfg.onComplete) { cfg.onComplete({}) }
    },
    confirmAndRun(cfg) { if (cfg && cfg.run) { cfg.run() } },
    casWrite(cfg) { jobs.push({ method: 'cas', path: cfg && cfg.path, body: cfg && cfg.body }) },
  }
}

function loadSource(file, routes) {
  const head = { appendChild() {} }
  const doc = {
    hidden: false,
    head,
    documentElement: head,
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    getElementsByTagName: () => [head],
    createTextNode: text => ({ text }),
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  }
  const win = { document: doc, ANAS: makeAnas(routes) }
  const sandbox = {
    window: win,
    document: doc,
    console,
    Promise,
    Date,
    Ext,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: fn => fn(),
  }
  vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  return win.ANAS
}

/** Let the sources' promise chains settle. */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) { await new Promise(r => setImmediate(r)) }
}

// ============================================================================
//  1 + 2. Backup task: edit → Save, and the enable/disable toggle
// ============================================================================

// One task with EVERY BackupTask field set to a distinctive, non-default value:
// a default-valued field would round-trip by accident.
const CADENCE = { kind: 'biweekly', days: ['Sun'], time: '02:30', parity: 'odd' }
const TASK = {
  name: 'nightly-pictures',
  repository: 'pbs-main',
  namespace: 'anas/pictures',
  backupId: 'pictures',
  archives: [
    { name: 'pictures', path: '/mnt/pictures', excludes: ['**/*.tmp', '**/cache'] },
    { name: 'etc', path: '/etc', excludes: [] },
  ],
  changeDetectionMode: 'metadata',
  retention: { keepLast: 3, keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 2 },
  notify: 'on-failure',
  // The cadence is authoritative; the schedule is what the daemon generates FROM
  // it, so the two agree exactly as a stored task's do.
  schedule: cadenceToOnCalendar(CADENCE),
  cadence: CADENCE,
  enabled: true,
  // Raised by hand on a node where metadata mode hoards descriptors — the field
  // no dialog control edits, and therefore the easiest one to drop.
  limitNofile: 65536,
}

const BACKUP_ROUTES = {
  'GET /backup/repos': { data: { version: 1, repos: [{ name: 'pbs-main', datastore: 'store1', source: 'anas' }] } },
  'GET /backup/tasks': { data: [{ task: TASK, lastRunResult: 'success', enabled: true }] },
  'GET /mounts': { data: [] },
  'GET /pools': { data: [] },
}

/**
 * Per-key check of a captured body against TASK. The DEFAULT is a deep compare,
 * so a NEW BackupTask field the dialogs do not carry fails automatically — that
 * is the class guard. Only the two keys with a documented wire alias override it.
 */
const FIELD_CHECKS = {
  // The UI sends `changeDetectionMode` AND the legacy `mode` alias; the daemon
  // prefers the former.
  changeDetectionMode: (body, want) => (body.changeDetectionMode || body.mode) === want,
  // A structured cadence is authoritative: the daemon GENERATES the OnCalendar
  // from it, so a body carrying the cadence need not carry the expression.
  schedule: (body, want) => body.schedule === want
    || (body.cadence ? cadenceToOnCalendar(body.cadence) === want : false),
}

function sweepFields(label, body, want) {
  const keys = Object.keys(BackupTask.shape)
  ok(`${label}: the schema still has fields to sweep`, keys.length > 5, `${keys.length} keys`)
  for (const key of keys) {
    const check = FIELD_CHECKS[key]
    if (check) {
      ok(`${label}: ${key} survives`, check(body, want[key]), `body ${JSON.stringify(body[key])}`)
    }
    else {
      eq(`${label}: ${key} survives`, body[key], want[key])
    }
  }
}

async function backupChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  // afterrender is what the PVE UI fires on the real view; it loads the grid.
  view.fireEvent('afterrender', view)
  await settle()

  const grid = view.down('#backupGrid')
  ok('backup: the grid loaded the task', grid && grid.getStore().getCount() === 1)
  const rec = grid.selectRow(0)
  ok('backup: the row carries the raw task', rec && rec.get('raw') && rec.get('raw').name === TASK.name)
  ok('backup: selecting a row enables Edit', grid.down('#backupEdit').disabled === false)

  // --- 1. Edit → Save ---
  jobs.length = 0
  const editBtn = grid.down('#backupEdit')
  editBtn.handler(editBtn)
  await settle()
  const dlg = openWindow()
  ok('backup: the edit dialog opened', !!dlg)
  ok('backup: the dialog opened on the task', dlg && dlg.down('#name').getValue() === TASK.name)
  const save = dlg.down('#taskSubmitBtn')
  save.handler(save)
  await settle()

  eq('backup: Save is a PUT of the whole task', jobs.length && jobs[0].method, 'put')
  eq('backup: Save targets the task', jobs.length && jobs[0].path, `/backup/tasks/${TASK.name}`)
  if (jobs.length) { sweepFields('edit→save', jobs[0].body, TASK) }

  // --- 2. Enable / disable ---
  jobs.length = 0
  const toggle = grid.down('#backupToggle')
  toggle.handler(toggle)
  await settle()
  eq('backup: the toggle is a PUT of the whole task', jobs.length && jobs[0].method, 'put')
  if (jobs.length) {
    sweepFields('toggle', jobs[0].body, { ...TASK, enabled: !TASK.enabled })
  }

  ok('backup: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  3. Import Pool sends the GUID it shows
// ============================================================================

const IMPORTABLE = [
  { name: 'tank', guid: '2371539348432104789', state: 'ONLINE' },
  // The case GUIDs exist for: a second exported pool with the SAME name.
  { name: 'tank', guid: '9911223344556677889', state: 'ONLINE' },
]

async function poolImportChecks() {
  const ANAS = loadSource('33-pool-import.js', {
    'GET /pools/import': { data: IMPORTABLE },
  })
  const action = (ANAS.pools._actions || []).find(a => a.itemId === 'importPool')
  ok('import: the Import action registered', !!action)
  if (!action) { return }

  jobs.length = 0
  action.handler('harness', makeComponent({ xtype: 'gridpanel' }, null))
  await settle()
  const win = openWindow()
  ok('import: the window opened', !!win)
  const grid = win.down('#importGrid')
  ok('import: the scan filled the grid', grid && grid.getStore().getCount() === 2)
  ok('import: the GUID is on screen', (grid.columns || []).some(col => col.dataIndex === 'guid'))

  // Pick the SECOND same-named pool — by name alone this import is ambiguous.
  grid.selectRow(1)
  const btn = win.buttonCmps.find(b => b.cls === 'anas-btn-import-submit')
  ok('import: the Import button exists', !!btn)
  btn.handler(btn)
  await settle()

  eq('import: one import job was submitted', jobs.length, 1)
  if (jobs.length) {
    eq('import: it posts to /pools/import', jobs[0].path, '/pools/import')
    eq('import: it carries the selected row\'s GUID', jobs[0].body.guid, IMPORTABLE[1].guid)
    // Name AND guid would import the NAME (the daemon prefers it), which is the
    // ambiguous identifier this whole column exists to replace.
    ok('import: it does not fall back to the ambiguous name', jobs[0].body.name === undefined,
      `body ${JSON.stringify(jobs[0].body)}`)
  }
  ok('import: nothing warned', warnings.length === 0, warnings.join(' | '))
}


// ============================================================================
//  4. Datasets: filesystem vs volume — what each one sends, and what a volume
//     row does to the toolbar (story iscsi.3)
// ============================================================================

const GiB = 1024 * 1024 * 1024

// One ANAS-managed pool with a filesystem and a real-shaped zvol, and one
// PVE-managed pool whose zvol must stay hands-off (story 3.25 — the SAME
// pool-level tag as its datasets, not a second check).
const DS_POOLS = [
  { name: 'tank', size: 8 * GiB, pveStorages: [] },
  { name: 'pvepool', size: 8 * GiB, pveStorages: [{ id: 'local-zfs', type: 'zfspool' }] },
]

const TANK_DATASETS = [
  { name: 'tank', pool: 'tank', type: 'filesystem', used: 1, available: 1, referenced: 1, mountpoint: '/tank', compression: 'lz4', compressratio: 1, quota: 0 },
  { name: 'tank/media', pool: 'tank', type: 'filesystem', used: 1, available: 1, referenced: 1, mountpoint: '/tank/media', compression: 'lz4', compressratio: 1, quota: 0 },
  { name: 'tank/vol1', pool: 'tank', type: 'volume', used: 2 * GiB, available: 1, referenced: 1, mountpoint: null, compression: 'on', compressratio: 1, quota: 0, volsize: 2 * GiB, volblocksize: 16384, sparse: false },
]

const PVE_DATASETS = [
  { name: 'pvepool', pool: 'pvepool', type: 'filesystem', used: 1, available: 1, referenced: 1, mountpoint: '/pvepool', compression: 'on', compressratio: 1, quota: 0 },
  { name: 'pvepool/vm-100-disk-0', pool: 'pvepool', type: 'volume', used: GiB, available: 1, referenced: 1, mountpoint: null, compression: 'on', compressratio: 1, quota: 0, volsize: GiB, volblocksize: 8192, sparse: true },
]

const DATASET_ROUTES = {
  'GET /pools': { data: DS_POOLS },
  // `defaults` is the ZFS-observed volblocksize the Create dialog must QUOTE
  // rather than hard-code.
  'GET /pools/tank/datasets': { data: TANK_DATASETS, defaults: { volblocksize: 16384 } },
  'GET /pools/pvepool/datasets': { data: PVE_DATASETS, defaults: { volblocksize: 16384 } },
}

/** Find a node in the loaded tree by its full ZFS name. */
function findNode(tree, fullName) {
  const walk = (node) => {
    if (node.get && node.get('fullName') === fullName) { return node }
    for (const kid of node.childNodes || []) {
      const hit = walk(kid)
      if (hit) { return hit }
    }
    return null
  }
  return walk(tree.getRootNode())
}

/** The toolbar's disabled/tooltip state, keyed by itemId. */
function toolbarState(tree, ids) {
  const out = {}
  for (const id of ids) {
    const btn = tree.down(`#${id}`)
    out[id] = btn ? { disabled: !!btn.disabled, tip: btn.tooltip || '' } : null
  }
  return out
}

async function datasetsChecks() {
  const ANAS = loadSource('60-datasets.js', DATASET_ROUTES)
  const view = makeComponent(ANAS.views.datasets.factory('harness'), null)
  const tree = view.down('#dsTree')
  ok('datasets: the tree panel exists', !!tree)
  tree.fireEvent('afterrender', tree)
  await settle()

  const fsNode = findNode(tree, 'tank/media')
  const volNode = findNode(tree, 'tank/vol1')
  const pveVolNode = findNode(tree, 'pvepool/vm-100-disk-0')
  ok('datasets: the filesystem row loaded', !!fsNode)
  ok('datasets: the volume row loaded', !!volNode)
  ok('datasets: the PVE-owned zvol loaded', !!pveVolNode)
  if (!fsNode || !volNode || !pveVolNode) { return }

  eq('datasets: the volume row carries volsize', volNode.get('volsize'), 2 * GiB)
  eq('datasets: the volume row carries volblocksize', volNode.get('volblocksize'), 16384)
  eq('datasets: the volume row carries sparse', volNode.get('sparse'), false)
  eq('datasets: a filesystem row carries NO volsize', fsNode.get('volsize'), undefined)
  eq('datasets: the observed ZFS default reached the tree', tree.anasVolblocksizeDefault, 16384)

  // --- 4a. The gating matrix -------------------------------------------------
  const GATED = ['dsEdit', 'dsPerms', 'dsShare', 'dsResize', 'dsDestroy', 'dsDetail']

  tree.selectNode(fsNode)
  let state = toolbarState(tree, GATED)
  ok('gating(filesystem): Edit Properties enabled', state.dsEdit.disabled === false)
  ok('gating(filesystem): Permissions enabled', state.dsPerms.disabled === false)
  ok('gating(filesystem): Share… enabled', state.dsShare.disabled === false)
  ok('gating(filesystem): Destroy enabled', state.dsDestroy.disabled === false)
  ok('gating(filesystem): Resize Volume DISABLED', state.dsResize.disabled === true)
  ok('gating(filesystem): Resize says why it is off', /volume/i.test(state.dsResize.tip), state.dsResize.tip)
  ok('gating(filesystem): Edit carries no volume excuse', state.dsEdit.tip === '', state.dsEdit.tip)

  tree.selectNode(volNode)
  state = toolbarState(tree, GATED)
  ok('gating(volume): Edit Properties DISABLED', state.dsEdit.disabled === true)
  ok('gating(volume): Permissions DISABLED', state.dsPerms.disabled === true)
  ok('gating(volume): Share… DISABLED', state.dsShare.disabled === true)
  ok('gating(volume): Resize Volume ENABLED', state.dsResize.disabled === false)
  ok('gating(volume): Destroy stays enabled', state.dsDestroy.disabled === false)
  ok('gating(volume): Detail stays enabled', state.dsDetail.disabled === false)
  // Every disabled control explains ITSELF — a greyed button with no reason
  // reads as a bug rather than as a rule.
  ok('gating(volume): Edit says filesystem properties do not exist', /Resize Volume/.test(state.dsEdit.tip), state.dsEdit.tip)
  ok('gating(volume): Permissions says there is no mountpoint', /mountpoint/.test(state.dsPerms.tip), state.dsPerms.tip)
  ok('gating(volume): Share says a volume has no path', /iSCSI/.test(state.dsShare.tip), state.dsShare.tip)

  tree.selectNode(pveVolNode)
  state = toolbarState(tree, GATED)
  ok('gating(PVE volume): Resize DISABLED (3.25 hands-off)', state.dsResize.disabled === true)
  ok('gating(PVE volume): Destroy DISABLED', state.dsDestroy.disabled === true)
  ok('gating(PVE volume): Edit DISABLED', state.dsEdit.disabled === true)
  ok('gating(PVE volume): Detail still enabled (read-only is allowed)', state.dsDetail.disabled === false)

  // --- 4b. Create: filesystem body is unchanged, volume body is new ----------
  tree.selectNode(fsNode)
  jobs.length = 0
  let btn = tree.down('#dsCreate')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('create: the dialog opened', !!dlg && !!dlg.down('#dsType'))
  if (!dlg) { return }
  eq('create: it defaults to Filesystem', dlg.down('#dsType').getValue(), 'filesystem')
  ok('create: the volume fields start hidden', dlg.down('#size').hidden === true)
  ok('create: the filesystem fields start visible', dlg.down('#recordsize').hidden === false)

  dlg.down('#path').setValue('media/movies')
  dlg.down('#recordsize').setValue(131072)
  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-dataset-create-submit')
  submit.handler(submit)
  await settle()
  eq('create(filesystem): one job', jobs.length, 1)
  eq('create(filesystem): posts to the pool', jobs[0].path, '/pools/tank/datasets')
  // The body must be EXACTLY what it was before volumes existed: no `type`, no
  // zvol keys. An older daemon has to keep understanding it (version skew).
  eq('create(filesystem): the body is unchanged by this story',
    jobs[0].body, { path: 'media/movies', properties: { recordsize: 131072 } })

  // Now the volume branch of the same dialog.
  jobs.length = 0
  btn = tree.down('#dsCreate')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#dsType').setValue('volume')
  await settle()
  ok('create(volume): the volume fields appear', dlg.down('#size').hidden === false)
  ok('create(volume): the block-size picker appears', dlg.down('#volblocksize').hidden === false)
  ok('create(volume): the filesystem fields go away', dlg.down('#recordsize').hidden === true)
  ok('create(volume): and are disabled, so a stale value cannot be read back',
    dlg.down('#recordsize').disabled === true)
  // The blank block-size row STATES the observed ZFS default rather than
  // hard-coding one.
  const blankRow = dlg.down('#volblocksize').getStore().getAt(0)
  eq('create(volume): the blank block-size row means "send nothing"', blankRow.get('value'), '')
  ok('create(volume): it names the observed ZFS default', /ZFS default/.test(blankRow.get('label')), blankRow.get('label'))

  dlg.down('#path').setValue('vol2')
  dlg.down('#size').setValue(4)
  dlg.down('#unit').setValue(GiB)
  dlg.down('#volblocksize').setValue(8192)
  dlg.down('#sparse').setValue(true)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-dataset-create-submit')
  submit.handler(submit)
  await settle()
  eq('create(volume): one job', jobs.length, 1)
  eq('create(volume): the body carries type + the zvol trio, and no filesystem keys',
    jobs[0].body, { path: 'vol2', type: 'volume', volsize: 4 * GiB, volblocksize: 8192, sparse: true })

  // Blank block size ⇒ the key is ABSENT, so ZFS applies its own default.
  jobs.length = 0
  btn = tree.down('#dsCreate')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#dsType').setValue('volume')
  dlg.down('#path').setValue('vol3')
  dlg.down('#size').setValue(512)
  dlg.down('#unit').setValue(1024 * 1024)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-dataset-create-submit')
  submit.handler(submit)
  await settle()
  eq('create(volume): a default block size sends no volblocksize at all',
    jobs[0].body, { path: 'vol3', type: 'volume', volsize: 512 * 1024 * 1024 })

  // --- 4c. Resize Volume: grow only -----------------------------------------
  tree.selectNode(volNode)

  // (i) An UNTOUCHED edit sends nothing — the dialog↔daemon contract.
  jobs.length = 0
  btn = tree.down('#dsResize')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  ok('resize: the window opened', !!dlg && !!dlg.down('#size'))
  eq('resize: it pre-fills the CURRENT size, in the largest exact unit',
    [dlg.down('#size').getValue(), dlg.down('#unit').getValue()], [2, GiB])
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-volume-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: an untouched edit sends NOTHING', jobs.length, 0)
  ok('resize: an untouched edit closes the window', dlg.destroyed === true)

  // (ii) A SHRINK is refused before it can reach the daemon.
  jobs.length = 0
  warnings.length = 0
  btn = tree.down('#dsResize')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#size').setValue(1)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-volume-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: a shrink sends NOTHING', jobs.length, 0)
  ok('resize: a shrink says why', warnings.some(w => /Cannot shrink/.test(w)), warnings.join(' | '))
  ok('resize: a shrink leaves the window open to fix', dlg.destroyed === false)

  // (iii) A GROW is a PUT of volsize alone.
  jobs.length = 0
  warnings.length = 0
  dlg.down('#size').setValue(8)
  submit.handler(submit)
  await settle()
  eq('resize: one job', jobs.length, 1)
  eq('resize: it is a PUT', jobs[0].method, 'put')
  eq('resize: it targets the volume', jobs[0].path, '/pools/tank/datasets/vol1')
  eq('resize: it sends volsize and nothing else',
    jobs[0].body, { properties: { volsize: 8 * GiB } })

  ok('datasets: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================

await backupChecks()
warnings.length = 0
await poolImportChecks()
warnings.length = 0
await datasetsChecks()

if (failures.length) {
  console.error(`\n✖ ${failures.length} of ${checks} checks failed:\n`)
  for (const f of failures) { console.error(`  • ${f}`) }
  process.exit(1)
}
console.log(`✔ dialog contracts: ${checks} checks passed`)
