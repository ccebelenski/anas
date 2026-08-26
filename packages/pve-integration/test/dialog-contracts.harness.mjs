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
 *   3. `includeNested` (backup2.2) has set / clear / keep semantics: an explicit
 *      choice round-trips, clearing to None sends NO key, and an archive that
 *      never chose one still sends nothing after an untouched edit — which is
 *      what keeps a pre-backup2.2 unit byte-identical on save.
 *   3b. `kind` (backup2.4) has the same set / clear / keep semantics, and an
 *      `img` row hides AND DISABLES the controls that cannot apply to a block
 *      image — a stale exclude read back off a hidden field would be refused by
 *      the daemon with nothing on screen to explain it. The LUN record follows
 *      the PATH: retype the path and the record is not sent.
 *   4. Import Pool sends the GUID it displays — duplicate-name imports are the
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
    setTimeout: (fn) => { fn(); return 1 },
    clearTimeout: () => {},
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
  // Three archives so backup2.2's three `includeNested` states are all present:
  // an explicit `all`, an explicit path list, and — the one that matters most —
  // an archive that never chose, whose field must stay ABSENT through a save.
  archives: [
    { name: 'pictures', path: '/mnt/pictures', excludes: ['**/*.tmp', '**/cache'], includeNested: 'all' },
    { name: 'etc', path: '/etc', excludes: [], includeNested: ['/etc/pve'] },
    { name: 'srv', path: '/srv', excludes: [] },
    // backup2.4 — a BLOCK IMAGE with the LUN record it was picked at. Its
    // excludes/nested controls must be hidden AND disabled, and an untouched
    // edit must send `kind` and `lun` back verbatim.
    { name: 'lun0', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img', lun: { targetIqn: 'iqn.2026-08.anas:vmstore', index: 0 } },
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

/**
 * The wizard's LOCAL boundary scan (backup2.2). Real shape, real product-level
 * example: `/etc` has `/etc/pve` (pmxcfs) nested under it — the case that is
 * silently stored as an empty directory today.
 */
const NESTED_BY_PATH = {
  '/etc': [{ path: '/etc/pve', relativePath: 'pve', kind: 'pmxcfs', fstype: 'fuse' }],
  '/mnt/pictures': [{ path: '/mnt/pictures/raw', relativePath: 'raw', kind: 'dataset', fstype: 'zfs' }],
  '/srv': [{ path: '/srv/nfs', relativePath: 'nfs', kind: 'nfs', fstype: 'nfs4' }],
}

/**
 * backup2.3 — the DERIVED consistency the daemon attaches to the SAME scan.
 * READ-ONLY: it appears in the response, never in a request body. `/mnt/pictures`
 * is a ZFS dataset (snapshot-capable); `/etc` sits on the ext4 root and `/srv`
 * likewise, so both are honestly live.
 */
const CONSISTENCY_BY_PATH = {
  '/mnt/pictures': {
    consistency: 'snapshot',
    reason: '/mnt/pictures is on the ZFS dataset tank/pictures; the run takes a recursive snapshot',
    backend: 'zfs',
    target: 'tank/pictures',
    mountpoint: '/mnt/pictures',
    relativePath: '',
  },
  '/etc': {
    consistency: 'live',
    reason: '/etc is on /dev/sda1 (ext4), which has no snapshot mechanism ANAS can drive - the backup is live',
  },
  '/srv': {
    consistency: 'live',
    reason: '/srv is on /dev/sda1 (ext4), which has no snapshot mechanism ANAS can drive - the backup is live',
  },
  // backup2.4 — a zvol answers through its snapshot DEVICE, not a `.zfs` path.
  '/dev/zvol/tank/vol1': {
    consistency: 'snapshot',
    reason: '/dev/zvol/tank/vol1 is the ZFS volume tank/vol1; the run snapshots the volume and reads the snapshot device (snapdev is published for the run and restored afterwards)',
    backend: 'zfs',
    target: 'tank/vol1',
    zvolDevice: '/dev/zvol/tank/vol1',
  },
}

/**
 * backup2.4 — what `GET /backup/lun-sources` returns: the read layer's
 * backup-eligible LUNs, already filtered (nothing foreign, nothing PVE-owned)
 * and carrying each one's derived consistency.
 */
const LUN_SOURCES = [
  {
    targetIqn: 'iqn.2026-08.anas:vmstore',
    index: 0,
    name: 'tank_vol1',
    kind: 'zvol',
    path: '/dev/zvol/tank/vol1',
    serial: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
    size: 2147483648,
    backingExists: true,
    consistency: CONSISTENCY_BY_PATH['/dev/zvol/tank/vol1'],
  },
  {
    targetIqn: 'iqn.2026-08.anas:vmstore',
    index: 1,
    name: 'tank_lun2',
    kind: 'file',
    path: '/tank/images/lun2.raw',
    serial: '689844a4-1d20-4cba-8516-bdc52a402645',
    size: 1073741824,
    backingExists: true,
  },
]

/** Every preview-nested body the dialog sent (the endpoint must be user-driven). */
const nestedPreviews = []

function nestedPreviewRoute(body) {
  nestedPreviews.push(body)
  const choice = (body && body.includeNested) || 'none'
  const found = NESTED_BY_PATH[body && body.path] || []
  const covers = p => choice === 'all' || (Array.isArray(choice) && choice.indexOf(p) >= 0)
  const consistency = CONSISTENCY_BY_PATH[body && body.path]
  return {
    data: {
      archives: [{
        path: body && body.path,
        exists: true,
        includeNested: choice,
        nested: found.map(n => ({ ...n, included: covers(n.path) })),
        truncated: false,
        warnings: [],
        ...(consistency ? { consistency } : {}),
      }],
    },
  }
}

const BACKUP_ROUTES = {
  'GET /backup/repos': { data: { version: 1, repos: [{ name: 'pbs-main', datastore: 'store1', source: 'anas' }] } },
  'GET /backup/tasks': { data: [{ task: TASK, lastRunResult: 'success', enabled: true }] },
  'GET /mounts': { data: [] },
  'GET /pools': { data: [] },
  'POST /backup/tasks/preview-nested': nestedPreviewRoute,
  'GET /backup/lun-sources': { data: { installed: true, luns: LUN_SOURCES } },
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
//  1b. backup2.2 — includeNested: set / clear / keep, and the untouched edit
// ============================================================================

/** The archive editor rows of an open task dialog, in order. */
function archiveRows(dlg) {
  const cont = dlg.down('#archivesContainer')
  return cont ? cont.items.getRange() : []
}

/** Open the task dialog fresh from the grid's Edit button. */
async function openEdit(grid) {
  const editBtn = grid.down('#backupEdit')
  editBtn.handler(editBtn)
  await settle()
  return openWindow()
}

/** Press Save and hand back the body the dialog sent. */
async function save(dlg) {
  jobs.length = 0
  const btn = dlg.down('#taskSubmitBtn')
  btn.handler(btn)
  await settle()
  return jobs.length ? jobs[0].body : null
}

async function nestedChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  // --- KEEP: an untouched edit rewrites every archive exactly as stored ---
  nestedPreviews.length = 0
  let dlg = await openEdit(grid)
  let rows = archiveRows(dlg)
  eq('nested: the dialog built one row per archive', rows.length, TASK.archives.length)
  eq('nested: the stored `all` prefills as All', rows[0].down('#archNested').getValue(), 'all')
  eq('nested: a stored path list prefills as Choose…', rows[1].down('#archNested').getValue(), 'choose')
  eq('nested: the stored paths prefill verbatim', rows[1].down('#archNestedPaths').getValue(), '/etc/pve')
  eq('nested: an ABSENT choice prefills as None', rows[2].down('#archNested').getValue(), 'none')
  ok('nested: the path list is hidden unless Choose… is picked', rows[2].down('#archNestedPaths').hidden === true)

  // The preview is user-driven and LOCAL: one call per row, carrying that row's
  // own path and its own choice. It is never a PBS contact.
  ok('nested: the wizard previewed every row', nestedPreviews.length >= TASK.archives.length,
    `${nestedPreviews.length} previews`)
  ok('nested: a preview carries the row path and choice',
    nestedPreviews.some(b => b.path === '/srv' && b.includeNested === 'none'),
    JSON.stringify(nestedPreviews))

  // The alert names what the current choice would silently omit.
  ok('nested: the None row alerts about the filesystem it would skip',
    /\/srv\/nfs/.test(rows[2].down('#archNestedAlert').html || '')
    && /empty directories/.test(rows[2].down('#archNestedAlert').html || ''),
    rows[2].down('#archNestedAlert').html)
  ok('nested: the alert names the KIND, not just the path',
    /NFS mount/.test(rows[2].down('#archNestedAlert').html || ''),
    rows[2].down('#archNestedAlert').html)
  ok('nested: a covered row does NOT alert',
    !/empty directories/.test(rows[0].down('#archNestedAlert').html || ''),
    rows[0].down('#archNestedAlert').html)
  ok('nested: a covered row still LISTS what is nested, with its kind',
    /\/mnt\/pictures\/raw/.test(rows[0].down('#archNestedAlert').html || '')
    && /child dataset/.test(rows[0].down('#archNestedAlert').html || ''),
    rows[0].down('#archNestedAlert').html)

  let body = await save(dlg)
  ok('nested: the untouched edit saved', !!body)
  eq('nested (keep): `all` survives untouched', body.archives[0].includeNested, 'all')
  eq('nested (keep): the path list survives untouched', body.archives[1].includeNested, ['/etc/pve'])
  ok('nested (keep): an archive that never chose sends NO key at all',
    !('includeNested' in body.archives[2]), JSON.stringify(body.archives[2]))

  // --- SET: None → All, and None → Choose… with a path ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[2].down('#archNested').setValue('all')
  await settle()
  body = await save(dlg)
  eq('nested (set): choosing All sends `all`', body.archives[2].includeNested, 'all')

  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[2].down('#archNested').setValue('choose')
  await settle()
  ok('nested (set): Choose… reveals the path list', rows[2].down('#archNestedPaths').hidden === false)
  rows[2].down('#archNestedPaths').setValue('/srv/nfs\n')
  await settle()
  body = await save(dlg)
  eq('nested (set): the typed paths are sent as a list', body.archives[2].includeNested, ['/srv/nfs'])

  // --- CLEAR: All → None sends NOTHING (archives are replaced wholesale, so an
  // omitted field IS the clear — and it is the same on-disk shape as absent) ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[0].down('#archNested').setValue('none')
  await settle()
  body = await save(dlg)
  ok('nested (clear): clearing to None sends no key',
    !('includeNested' in body.archives[0]), JSON.stringify(body.archives[0]))
  eq('nested (clear): the OTHER archives are untouched', body.archives[1].includeNested, ['/etc/pve'])

  // --- Choose… with an empty list is None, not an empty array ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[1].down('#archNestedPaths').setValue('')
  await settle()
  body = await save(dlg)
  ok('nested: an emptied Choose… list is None, never []',
    !('includeNested' in body.archives[1]), JSON.stringify(body.archives[1]))

  ok('nested: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1c. backup2.3 — the consistency chip is READ-ONLY, and nothing new is writable
// ============================================================================

async function consistencyChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  nestedPreviews.length = 0
  const dlg = await openEdit(grid)
  const rows = archiveRows(dlg)

  // --- The chip renders the DERIVED verdict, with the daemon's own reason ---
  const picturesAlert = rows[0].down('#archNestedAlert').html || ''
  ok('consistency: a ZFS source shows the `snapshot` chip',
    />snapshot</.test(picturesAlert), picturesAlert)
  ok('consistency: the chip carries the daemon\'s reason as its tooltip',
    picturesAlert.includes('recursive snapshot'), picturesAlert)

  const etcAlert = rows[1].down('#archNestedAlert').html || ''
  ok('consistency: a non-snapshottable source shows the `live` chip',
    />live</.test(etcAlert), etcAlert)
  ok('consistency: the live chip explains WHY, verbatim from the daemon',
    etcAlert.includes('no snapshot mechanism'), etcAlert)

  // --- The expansion preview line: N nested filesystems -> N+1 archives ---
  // Archive 0 is `all` over a ZFS source with one nested child dataset.
  ok('consistency: a snapshot source with an included child previews the expansion',
    /1 nested filesystem → 2 archives/.test(picturesAlert), picturesAlert)
  // A LIVE source expands into nothing, whatever its choice — the line is absent.
  ok('consistency: a live source shows NO expansion preview',
    !/→ \d+ archives/.test(etcAlert), etcAlert)

  // --- READ-ONLY: no control exists for it, and no save carries it ---
  ok('consistency: the archive row has no consistency control at all',
    !rows[0].down('#archConsistency'), 'a control would make a derived fact editable')

  const body = await save(dlg)
  ok('consistency: an untouched save still produced a body', !!body)
  for (let i = 0; i < body.archives.length; i++) {
    ok(`consistency: archive ${i} sends no consistency key`,
      !('consistency' in body.archives[i]), JSON.stringify(body.archives[i]))
    ok(`consistency: archive ${i} sends no snapshot/expansion key`,
      !('snapshots' in body.archives[i]) && !('expansion' in body.archives[i]),
      JSON.stringify(body.archives[i]))
  }
  ok('consistency: the task body itself carries no derived key',
    !('consistency' in body) && !('snapshots' in body) && !('expansion' in body),
    Object.keys(body).join(','))
  // The class guard: an untouched edit is still byte-for-byte the stored task.
  sweepFields('consistency: untouched edit', body, TASK)

  ok('consistency: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1d. backup2.4 — archive kind: what an `img` row shows, disables and SENDS
// ============================================================================

async function imageKindChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  nestedPreviews.length = 0
  let dlg = await openEdit(grid)
  let rows = archiveRows(dlg)
  eq('kind: the dialog built one row per archive', rows.length, TASK.archives.length)

  // --- The stored kind prefills, and absent prefills as Files ---
  eq('kind: a stored `img` prefills as Block image', rows[3].down('#archKind').getValue(), 'img')
  eq('kind: an ABSENT kind prefills as Files', rows[0].down('#archKind').getValue(), 'pxar')
  eq('kind: the archive-name suffix follows the kind', rows[3].down('#archSuffix').html, '.img')
  eq('kind: a file archive still shows .pxar', rows[0].down('#archSuffix').html, '.pxar')

  // --- The controls that do not apply are hidden AND disabled ---
  ok('kind(img): excludes are hidden', rows[3].down('#archExcludes').hidden === true)
  ok('kind(img): excludes are DISABLED, so a stale value cannot be read back',
    rows[3].down('#archExcludes').disabled === true)
  ok('kind(img): the nested choice is hidden', rows[3].down('#archNested').hidden === true)
  ok('kind(img): the nested choice is DISABLED', rows[3].down('#archNested').disabled === true)
  ok('kind(img): the nested path list is hidden', rows[3].down('#archNestedPaths').hidden === true)
  ok('kind(img): the LUN button is shown', rows[3].down('#archLun').hidden === false)
  ok('kind(img): the directory Browse button is hidden', rows[3].down('#archBrowse').hidden === true)
  ok('kind(pxar): the LUN button is hidden', rows[0].down('#archLun').hidden === true)
  ok('kind(pxar): excludes stay enabled', rows[0].down('#archExcludes').disabled === false)

  // --- The two honest statements, and the LUN identity ---
  const note = rows[3].down('#archImageNote').html || ''
  ok('kind(img): the row states that every run reads the full image',
    /every run reads the full image/i.test(note), note)
  ok('kind(img): and that the change-detection mode does not apply',
    /change-detection mode does not apply/i.test(note), note)
  ok('kind(img): and that a live LUN backup is crash-consistent',
    /crash-consistent/i.test(note), note)
  ok('kind(img): the LUN identity is shown in full, never truncated',
    note.includes('iqn.2026-08.anas:vmstore') && /LUN 0/.test(note), note)
  eq('kind(pxar): a file archive shows no image note', rows[0].down('#archImageNote').html || '', '')

  // --- The preview for an image row says `img` and asks for no walk ---
  ok('kind(img): the preview carries kind:img for the image row',
    nestedPreviews.some(b => b.path === '/dev/zvol/tank/vol1' && b.kind === 'img'),
    JSON.stringify(nestedPreviews))
  ok('kind(pxar): a file row still sends NO kind at all',
    nestedPreviews.filter(b => b.path === '/srv').every(b => !('kind' in b)),
    JSON.stringify(nestedPreviews))
  const imgAlert = rows[3].down('#archNestedAlert').html || ''
  ok('kind(img): the consistency chip is shown for an image source',
    />snapshot</.test(imgAlert), imgAlert)
  ok('kind(img): an image row never claims a nested filesystem',
    !/empty directories/.test(imgAlert), imgAlert)

  // --- KEEP: an untouched edit round-trips kind AND lun verbatim ---
  let body = await save(dlg)
  ok('kind: the untouched edit saved', !!body)
  eq('kind (keep): `img` survives untouched', body.archives[3].kind, 'img')
  eq('kind (keep): the LUN record survives untouched', body.archives[3].lun,
    { targetIqn: 'iqn.2026-08.anas:vmstore', index: 0 })
  ok('kind (keep): a file archive sends NO kind key at all',
    !('kind' in body.archives[0]), JSON.stringify(body.archives[0]))
  ok('kind (keep): a file archive sends NO lun key at all',
    !('lun' in body.archives[0]), JSON.stringify(body.archives[0]))
  // The class guard: an untouched edit is still byte-for-byte the stored task.
  sweepFields('kind: untouched edit', body, TASK)

  // --- SET: Files → Block image sends `kind`, and nothing that cannot apply ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[0].down('#archKind').setValue('img')
  await settle()
  ok('kind (set): switching to Block image disables the nested choice',
    rows[0].down('#archNested').disabled === true)
  body = await save(dlg)
  eq('kind (set): the switched archive sends kind:img', body.archives[0].kind, 'img')
  eq('kind (set): its excludes are dropped — they do not apply to an image',
    body.archives[0].excludes, [])
  ok('kind (set): and its nested choice is dropped too',
    !('includeNested' in body.archives[0]), JSON.stringify(body.archives[0]))
  ok('kind (set): no LUN is invented for a hand-typed path',
    !('lun' in body.archives[0]), JSON.stringify(body.archives[0]))

  // --- CLEAR: Block image → Files sends NO kind, and drops the LUN record ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[3].down('#archKind').setValue('pxar')
  await settle()
  body = await save(dlg)
  ok('kind (clear): switching back to Files sends no kind key',
    !('kind' in body.archives[3]), JSON.stringify(body.archives[3]))
  ok('kind (clear): the LUN record goes with it',
    !('lun' in body.archives[3]), JSON.stringify(body.archives[3]))
  eq('kind (clear): the OTHER archives are untouched', body.archives[1].includeNested, ['/etc/pve'])

  // --- The LUN record follows the PATH: retype it and the record is dropped ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[3].down('#archPath').setValue('/dev/zvol/tank/other')
  await settle()
  body = await save(dlg)
  eq('kind: a retyped path keeps the image kind', body.archives[3].kind, 'img')
  ok('kind: but the stale LUN record is NOT sent (the path is a different source)',
    !('lun' in body.archives[3]), JSON.stringify(body.archives[3]))

  // --- A typed `.img` suffix is stripped, exactly as `.pxar` always was ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[3].down('#archName').setValue('lun0.img')
  await settle()
  body = await save(dlg)
  eq('kind: a typed .img suffix is stripped, never doubled', body.archives[3].name, 'lun0')

  ok('kind: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1e. backup2.4 — the LUN picker fills the path and records the LUN
// ============================================================================

async function lunPickerChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  const dlg = await openEdit(grid)
  const rows = archiveRows(dlg)

  // Open the picker from the image row's LUN button.
  const lunBtn = rows[3].down('#archLun')
  lunBtn.handler(lunBtn)
  await settle()
  const picker = openWindow()
  ok('picker: the LUN picker window opened', !!picker && !!picker.down('#lunGrid'))
  if (!picker) { return }

  const lunGrid = picker.down('#lunGrid')
  eq('picker: it listed the daemon\'s LUN sources', lunGrid.getStore().getCount(), LUN_SOURCES.length)
  ok('picker: the IQN column is present and never truncated',
    (lunGrid.columns || []).some(col => col.dataIndex === 'targetIqn'))
  ok('picker: the serial is on screen', (lunGrid.columns || []).some(col => col.dataIndex === 'serial'))
  ok('picker: the derived consistency is on screen',
    (lunGrid.columns || []).some(col => col.dataIndex === 'consistency'))

  // Pick the FILE-backed LUN: a different path AND a different LUN number, so
  // neither can round-trip by accident.
  lunGrid.selectRow(1)
  const select = picker.buttonCmps.find(b => b.cls === 'anas-btn-backup-lun-select')
  ok('picker: the Select button exists', !!select)
  select.handler(select)
  await settle()

  eq('picker: it filled the path field', rows[3].down('#archPath').getValue(), '/tank/images/lun2.raw')
  const body = await save(dlg)
  eq('picker: the saved path is the picked one', body.archives[3].path, '/tank/images/lun2.raw')
  eq('picker: and the LUN record is the picked one', body.archives[3].lun,
    { targetIqn: 'iqn.2026-08.anas:vmstore', index: 1 })
  eq('picker: the archive is still a block image', body.archives[3].kind, 'img')

  ok('picker: nothing warned', warnings.length === 0, warnings.join(' | '))
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
await nestedChecks()
warnings.length = 0
await consistencyChecks()
warnings.length = 0
await imageKindChecks()
warnings.length = 0
await lunPickerChecks()
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
