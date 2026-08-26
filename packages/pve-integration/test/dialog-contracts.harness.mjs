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
 *   5. iSCSI (story iscsi.4): a CHAP secret is WRITE-ONLY, so a blank box means
 *      KEEP and never "clear" — a dialog that got that backwards would strip
 *      every stored secret on the next unrelated save. Also: an untouched target
 *      edit sends an EMPTY body, the Add LUN pickers never offer PVE territory,
 *      a resize grows only, destroying a LUN's backing object is a separate
 *      ticked choice that becomes a query flag, and a foreign target or a live
 *      session greys the right controls with the reason attached.
 *   6. iSCSI boot lifecycle (story iscsi.5): the Repair button is live ONLY when
 *      a restore hole's backing object is BACK, and says what is still missing
 *      otherwise — a boot restore with a missing device exits 0 and systemd
 *      calls it a success, so this button is the operator's only handle on it.
 *      And an `unresolved` LUN does NOT make its target hands-off: "not on this
 *      node right now" is not "somebody else's", and reading it that way would
 *      take away the very tools that fix it.
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
  c.setStore = function (st) { c.store = st; return c }
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
  // PVE's own /nodes/<node>/network, which the portal picker reads (the same
  // endpoint the SMB "how to connect" strings use). `ajax.responses` lets a
  // check choose success-with-addresses or outright failure.
  Ajax: {
    request(cfg) {
      const hit = Object.keys(ajax.responses).find(k => String(cfg.url).includes(k))
      if (hit === undefined) { if (cfg.failure) { cfg.failure({}) } return }
      const body = ajax.responses[hit]
      if (body === null) { if (cfg.failure) { cfg.failure({}) } return }
      if (cfg.success) { cfg.success({ responseText: JSON.stringify(body) }) }
    },
  },
  decode: t => JSON.parse(t),
}

/** What Ext.Ajax hands back, keyed by a substring of the URL. */
const ajax = { responses: {} }

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
      put(_node, path, body) {
        const key = `PUT ${path}`
        if (!(key in routes)) { return Promise.reject(new Error(`unexpected ${key}`)) }
        return Promise.resolve(typeof routes[key] === 'function' ? routes[key](body) : routes[key])
      },
      del(_node, path) {
        const key = `DELETE ${path}`
        if (!(key in routes)) { return Promise.reject(new Error(`unexpected ${key}`)) }
        return Promise.resolve(routes[key])
      },
    },
    runJob(cfg) {
      jobs.push({ method: cfg.method, path: cfg.path, body: cfg.body })
      if (cfg.onComplete) { cfg.onComplete({}) }
    },
    // A confirm-gated mutation. The real one only shows its window after the
    // daemon answers 409 with a code; here the SHAPE is what matters, so the
    // request is recorded along with the widget hooks a destructive dialog adds.
    confirmAndRun(cfg) {
      jobs.push({
        method: cfg.method,
        path: cfg.path,
        body: cfg.body,
        confirmWindow: !!cfg.confirmWindow,
        extraItems: cfg.extraItems,
        mapConfirm: cfg.mapConfirm,
      })
      if (cfg.onComplete) { cfg.onComplete({}) }
    },
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
//  5. iSCSI: targets, ACLs/CHAP and LUNs — what each dialog SENDS (story iscsi.4)
// ============================================================================
//
// The three things this section exists to hold down:
//
//   * a CHAP secret is WRITE-ONLY, so the box always opens empty — which makes
//     "blank" mean KEEP, not clear. A dialog that sent `chapSecret: null` for an
//     untouched box would silently strip every stored secret on the next save.
//   * an untouched target edit must send an EMPTY body, and a resize that
//     changes nothing must send no request at all.
//   * destroying the backing object is a SEPARATE, ticked choice that becomes a
//     query flag — not something a Delete button does on its own.

const ISCSI_IQN = 'iqn.2026-08.nas.anas:vmstore'
const ISCSI_FOREIGN = 'iqn.2026-08.dev.anas.gtiscsi:target1'
const ISCSI_INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
const ISCSI_SECRET = 'correcthorseba' // 14 bytes — inside the 12–16 range

const ISCSI_TARGETS = {
  installed: true,
  configfsPresent: true,
  saveconfigPresent: true,
  targets: [
    {
      iqn: ISCSI_IQN,
      name: 'vmstore',
      ownership: 'anas',
      ownershipReason: 'anas-managed',
      ownershipDetail: 'IQN follows the ANAS naming convention and all 2 LUNs are backed by ANAS-managed storage',
      tpgTag: 1,
      enabled: true,
      portals: [{ address: '192.168.200.50', port: 3260, family: 'inet', carriedByInterface: true }],
      lunCount: 2,
      aclCount: 1,
      sessionCount: 0,
      security: { authentication: false, generateNodeAcls: false, demoModeDiscovery: false },
      present: true,
      persisted: true,
      missingLunCount: 0,
      portalsWithoutInterfaceCount: 0,
    },
    {
      iqn: ISCSI_FOREIGN,
      name: null,
      ownership: 'foreign',
      ownershipReason: 'iqn-not-anas',
      ownershipDetail: `IQN '${ISCSI_FOREIGN}' was not generated by ANAS (an ANAS target's naming authority ends in '.anas')`,
      tpgTag: 1,
      enabled: true,
      portals: [{ address: '10.9.9.9', port: 3260, family: 'inet', carriedByInterface: false }],
      lunCount: 1,
      aclCount: 0,
      sessionCount: 1,
      security: { authentication: true, generateNodeAcls: false, demoModeDiscovery: true },
      present: true,
      persisted: true,
      missingLunCount: 0,
      portalsWithoutInterfaceCount: 1,
    },
  ],
}

const GiB_ = 1024 * 1024 * 1024

/** The ANAS target in full: two LUNs, one ACL with a STORED CHAP secret. */
function iscsiDetail(opts = {}) {
  return {
    ...ISCSI_TARGETS.targets[0],
    security: { authentication: true, generateNodeAcls: false, demoModeDiscovery: false },
    sessions: opts.session
      ? [{ initiatorIqn: ISCSI_INITIATOR, initiatorAlias: 'anas-pve', targetIqn: ISCSI_IQN, tpgTag: 1, sessionId: 1, state: 'TARG_SESS_STATE_LOGGED_IN', connections: [{ cid: 0, address: '192.168.200.60', state: 'TARG_CONN_STATE_LOGGED_IN' }], mappedLuns: [0] }]
      : [],
    acls: [{
      initiatorIqn: ISCSI_INITIATOR,
      chapUserid: 'alice',
      chapCredentialsSet: true,
      mutualUserid: null,
      mutualCredentialsSet: false,
      authenticateTarget: false,
      mappedLuns: [0, 1],
    }],
    luns: [
      {
        index: 0,
        name: 'vmdisk1',
        kind: 'zvol',
        plugin: 'block',
        backingPath: '/dev/zvol/tank/vol1',
        size: 2 * GiB_,
        serial: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
        attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 524288 },
        connectedInitiators: opts.session ? [ISCSI_INITIATOR] : [],
        present: true,
        backingExists: true,
        pool: 'tank',
        dataset: 'tank/vol1',
      },
      {
        index: 1,
        name: 'vmdisk2',
        kind: 'file',
        plugin: 'fileio',
        backingPath: '/tank/images/vmdisk2.raw',
        size: GiB_,
        serial: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 262144 },
        connectedInitiators: [],
        present: true,
        backingExists: true,
        pool: 'tank',
        dataset: 'tank/images',
      },
    ],
  }
}

/** The pools/datasets the Add LUN pickers read. */
const ISCSI_POOL_ROUTES = {
  'GET /pools': { data: [
    { name: 'tank', size: 8 * GiB_, pveStorages: [] },
    // PVE territory: never a candidate, and never even enumerated.
    { name: 'pvepool', size: 8 * GiB_, pveStorages: [{ id: 'local-zfs', type: 'zfspool' }] },
  ] },
  'GET /pools/tank/datasets': { data: [
    { name: 'tank', type: 'filesystem', mountpoint: '/tank' },
    { name: 'tank/images', type: 'filesystem', mountpoint: '/tank/images' },
    { name: 'tank/vol1', type: 'volume', volsize: 2 * GiB_ },
    { name: 'tank/vol2', type: 'volume', volsize: 4 * GiB_ },
    // A PVE guest disk that happens to sit on an ANAS pool: still never a
    // candidate — the same three prefixes the daemon refuses.
    { name: 'tank/vm-101-disk-0', type: 'volume', volsize: GiB_ },
  ] },
  'GET /ahr/pools': { data: [{ name: 'ahrpool', mountpoint: '/ahrpool' }] },
}

/** The saveconfig ⟷ configfs diff behind the Repair button (story iscsi.5). */
function iscsiHealth(opts = {}) {
  const missing = opts.missing || []
  return {
    data: {
      installed: true,
      configfsPresent: true,
      saveconfigPresent: true,
      missingLuns: missing,
      targetsServingNothing: opts.servingNothing || [],
      portalsWithoutInterface: [],
      foreignChanges: [],
      degraded: missing.length > 0,
      interfacesUnknown: false,
      checkedAt: '2026-08-25T20:00:00.000Z',
    },
  }
}

/** One restore hole; `backingExists` is the whole gate on Repair. */
function iscsiHole(backingExists) {
  return {
    targetIqn: ISCSI_IQN,
    tpgTag: 1,
    lunIndex: 0,
    backstoreName: 'vmdisk1',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/vol1',
    backingExists,
  }
}

const ISCSI_ROUTES = {
  'GET /iscsi/targets': { data: ISCSI_TARGETS },
  'GET /iscsi/health': iscsiHealth(),
  [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: iscsiDetail() },
  [`GET /iscsi/targets/${encodeURIComponent(ISCSI_FOREIGN)}`]: { data: { ...ISCSI_TARGETS.targets[1], luns: [], acls: [], sessions: [] } },
  ...ISCSI_POOL_ROUTES,
}

/** The node's real addresses, as PVE's own /nodes/<node>/network reports them. */
const PVE_NETWORK = {
  data: [
    { iface: 'lo', address: '127.0.0.1', active: 1 },
    { iface: 'vmbr0', address: '192.168.200.50', active: 1 },
    { iface: 'vmbr1', address: '10.0.0.5', active: 0 },
  ],
}

/** Open the view and wait for its first load. */
async function openIscsiView(routes) {
  const ANAS = loadSource('75-iscsi.js', routes)
  const view = makeComponent(ANAS.views.iscsi.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  return { ANAS, view, grid: view.down('#iscsiGrid') }
}

/** Row index of a target by IQN. */
function iscsiRowOf(grid, iqn) {
  return grid.getStore().findExact('iqn', iqn)
}

function toolbar(grid, ids) {
  const out = {}
  for (const id of ids) {
    const btn = grid.down(`#${id}`)
    out[id] = btn ? { disabled: !!btn.disabled, tip: btn.tooltip || '', text: btn.text } : null
  }
  return out
}

async function iscsiGridChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)

  ok('iscsi: the grid loaded both targets', grid && grid.getStore().getCount() === 2)
  ok('iscsi: the view registered under its own menu key', !!view.down('#iscsiGrid'))

  const GATED = ['iscsiCreate', 'iscsiEdit', 'iscsiToggle', 'iscsiDelete', 'iscsiLuns']

  // Nothing selected: only Create is live.
  let state = toolbar(grid, GATED)
  ok('gating(none): Create is enabled', state.iscsiCreate.disabled === false)
  ok('gating(none): Edit is disabled', state.iscsiEdit.disabled === true)
  ok('gating(none): LUNs… is disabled', state.iscsiLuns.disabled === true)

  // An ANAS target: everything is live and the toggle reads Disable.
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))
  state = toolbar(grid, GATED)
  ok('gating(anas): Edit enabled', state.iscsiEdit.disabled === false)
  ok('gating(anas): Delete enabled', state.iscsiDelete.disabled === false)
  ok('gating(anas): LUNs… enabled', state.iscsiLuns.disabled === false)
  ok('gating(anas): an enabled target offers Disable', state.iscsiToggle.text === 'Disable')
  ok('gating(anas): no hands-off excuse on an ANAS row', state.iscsiEdit.tip === '', state.iscsiEdit.tip)

  // A FOREIGN target: hands-off, and every disabled control explains itself.
  grid.selectRow(iscsiRowOf(grid, ISCSI_FOREIGN))
  state = toolbar(grid, GATED)
  ok('gating(foreign): Edit DISABLED', state.iscsiEdit.disabled === true)
  ok('gating(foreign): Enable/Disable DISABLED', state.iscsiToggle.disabled === true)
  ok('gating(foreign): Delete DISABLED', state.iscsiDelete.disabled === true)
  ok('gating(foreign): reading its LUNs is still allowed', state.iscsiLuns.disabled === false)
  ok('gating(foreign): the tooltip carries the DERIVATION, not just a refusal',
    /not generated by ANAS/.test(state.iscsiEdit.tip), state.iscsiEdit.tip)

  // A double-click on a foreign row must not open the edit dialog either.
  const before = created.windows.length
  grid.fireEvent('itemdblclick', grid, grid.getStore().getAt(iscsiRowOf(grid, ISCSI_FOREIGN)))
  await settle()
  eq('gating(foreign): a double-click opens nothing', created.windows.length, before)

  ok('iscsi: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiNotInstalledChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  // Verbatim from `iscsiAvailability` — including the modules half (GT-4): there
  // is no load-on-first-use to arrange, so the envelope says so instead of
  // implying a knob exists.
  const reason = 'The LIO iSCSI target stack is not present on this node (no configfs target tree and no saved configuration) '
    + '— install targetcli-fb and python3-rtslib-fb to serve block storage. Installing them costs nothing at rest: '
    + 'the target kernel modules arrive with the first real targetcli call, and rtslib loads every backstore plugin '
    + 'at once — there is no load-on-first-use to arrange, and ANAS never loads one itself.'
  const { view, grid } = await openIscsiView({
    'GET /iscsi/targets': {
      data: {
        installed: false,
        configfsPresent: false,
        saveconfigPresent: false,
        reason,
        targets: [],
      },
    },
  })

  const banner = view.down('#iscsiEnvelope')
  ok('not-installed: the panel renders the envelope\'s OWN reason', banner && banner.hidden === false
    && String(banner.html).includes('install targetcli-fb'), banner && banner.html)
  const state = toolbar(grid, ['iscsiCreate', 'iscsiEdit', 'iscsiToggle', 'iscsiDelete', 'iscsiLuns'])
  ok('not-installed: even Create is disabled', state.iscsiCreate.disabled === true)
  ok('not-installed: Create says what is missing', /targetcli-fb/.test(state.iscsiCreate.tip), state.iscsiCreate.tip)
  ok('not-installed: the rest of the toolbar is disabled too',
    state.iscsiEdit.disabled === true && state.iscsiLuns.disabled === true)
  ok('not-installed: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiCreateChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)

  jobs.length = 0
  const btn = grid.down('#iscsiCreate')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('create: the dialog opened', !!dlg && !!dlg.down('#name'))
  if (!dlg) { return }

  // The portal picker is filled from PVE's OWN network API — the addresses this
  // node actually carries, because LIO will bind one it does not and say nothing.
  const picker = dlg.down('#portalAddress')
  const addrs = picker.getStore().getRange().map(r => r.get('address'))
  ok('create: the portal picker offers this node\'s ACTIVE addresses',
    addrs.includes('192.168.200.50') && addrs.includes('127.0.0.1'), JSON.stringify(addrs))
  ok('create: an inactive interface is not offered', !addrs.includes('10.0.0.5'), JSON.stringify(addrs))
  ok('create: the picker stays editable — an address about to exist is legitimate',
    picker.editable === true)

  // The PVE-CHAP note is hidden until auth is not none, then it appears.
  ok('create: the PVE no-CHAP-field note starts hidden', dlg.down('#pveChapNote').hidden === true)

  dlg.down('#name').setValue('vmstore2')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()

  eq('create: one job', jobs.length, 1)
  eq('create: it POSTs to the collection', [jobs[0].method, jobs[0].path], ['post', '/iscsi/targets'])
  eq('create: the body carries the name, the portal and an explicit auth',
    jobs[0].body, { name: 'vmstore2', portals: [{ address: '192.168.200.50', port: 3260 }], auth: 'none', acls: [] })

  // --- with CHAP ---
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('vmstore3')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#authGroup').setValue({ authMode: 'chap' })
  await settle()
  ok('create: choosing CHAP reveals the PVE no-CHAP-field note',
    dlg.down('#pveChapNote').hidden === false)
  ok('create: the note names the PVE plugin limitation exactly',
    /iscsi: storage plugin has no CHAP field/.test(dlg.down('#pveChapNote').html),
    dlg.down('#pveChapNote').html)
  ok('create: the 12–16 byte rule is stated, since LIO does not enforce it',
    /12–16 bytes/.test(dlg.down('#chapLengthNote').html), dlg.down('#chapLengthNote').html)

  const addAcl = dlg.down('#aclAdd')
  addAcl.handler(addAcl)
  await settle()
  let row = dlg.down('#aclsContainer').items.getAt(0)
  row.down('#aclIqn').setValue(ISCSI_INITIATOR)
  row.down('#aclUserid').setValue('alice')
  row.down('#aclSecret').setValue(ISCSI_SECRET)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('create(chap): the ACL carries the username and the secret',
    jobs[0].body.acls, [{ initiatorIqn: ISCSI_INITIATOR, chapUserid: 'alice', chapSecret: ISCSI_SECRET }])
  eq('create(chap): the auth mode travels', jobs[0].body.auth, 'chap')

  // --- a too-short secret never reaches the daemon ---
  jobs.length = 0
  warnings.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('vmstore4')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#authGroup').setValue({ authMode: 'chap' })
  const addAcl2 = dlg.down('#aclAdd')
  addAcl2.handler(addAcl2)
  await settle()
  row = dlg.down('#aclsContainer').items.getAt(0)
  row.down('#aclIqn').setValue(ISCSI_INITIATOR)
  row.down('#aclUserid').setValue('alice')
  row.down('#aclSecret').setValue('short')
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('create: a too-short CHAP secret sends NOTHING', jobs.length, 0)
  ok('create: and it says why', warnings.some(w => /12–16/.test(w)), warnings.join(' | '))
  warnings.length = 0

  // --- a portal-less target is refused client-side too ---
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('vmstore5')
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('create: a target with no portal sends nothing', jobs.length, 0)
  ok('create: and says a portal is needed', warnings.some(w => /portal/.test(w)), warnings.join(' | '))
  warnings.length = 0
}

async function iscsiEditChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))

  const openEdit = async () => {
    const btn = grid.down('#iscsiEdit')
    btn.handler(btn)
    await settle()
    return openWindow()
  }
  const save = async (dlg) => {
    jobs.length = 0
    const b = dlg.buttonCmps.find(x => x.cls === 'anas-btn-iscsi-target-submit')
    b.handler(b)
    await settle()
    return jobs.length ? jobs[0] : null
  }

  // The dialog opens on the DETAIL read, never on the grid row's summary.
  let dlg = await openEdit()
  ok('edit: the dialog opened on the stored entry', !!dlg && !!dlg.down('#iqn'))
  eq('edit: the IQN is shown read-only — there is no rename in LIO',
    dlg.down('#iqn').value.includes(ISCSI_IQN), true)
  eq('edit: the stored auth mode pre-fills', dlg.down('#authGroup').getValue(), { authMode: 'chap' })
  const aclRow = dlg.down('#aclsContainer').items.getAt(0)
  eq('edit: the stored initiator pre-fills', aclRow.down('#aclIqn').getValue(), ISCSI_INITIATOR)
  eq('edit: the stored CHAP username pre-fills', aclRow.down('#aclUserid').getValue(), 'alice')
  eq('edit: the secret box is EMPTY — a secret is never returned', aclRow.down('#aclSecret').getValue(), '')
  ok('edit: and the label says one is stored', /stored/.test(aclRow.down('#aclSecret').fieldLabel),
    aclRow.down('#aclSecret').fieldLabel)
  eq('edit: the stored portal pre-fills', dlg.down('#portalAddress').getValue(), '192.168.200.50')

  // (i) An UNTOUCHED edit sends NOTHING.
  let job = await save(dlg)
  eq('edit: an untouched edit sends NOTHING', job, null)

  // (ii) Changing only the auth mode sends only `auth`.
  dlg = await openEdit()
  dlg.down('#authGroup').setValue({ authMode: 'none' })
  await settle()
  job = await save(dlg)
  eq('edit(auth): it is a PUT at the target', [job.method, job.path],
    ['put', `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`])
  eq('edit(auth): the body carries auth and nothing else', job.body, { auth: 'none' })

  // (iii) A blank secret box KEEPS the stored secret — it does not clear it.
  dlg = await openEdit()
  dlg.down('#portalPort').setValue(3261)
  await settle()
  job = await save(dlg)
  eq('edit(portal): the portal set travels complete', job.body.portals,
    [{ address: '192.168.200.50', port: 3261 }])
  ok('edit(portal): an untouched ACL sends no acls key at all',
    !('acls' in job.body), JSON.stringify(job.body))

  // (iv) A TYPED secret rotates it.
  dlg = await openEdit()
  dlg.down('#aclsContainer').items.getAt(0).down('#aclSecret').setValue('newsecret1234')
  await settle()
  job = await save(dlg)
  eq('edit(rotate): the new secret travels', job.body.acls,
    [{ initiatorIqn: ISCSI_INITIATOR, chapSecret: 'newsecret1234' }])

  // (v) Clearing the CHAP USERNAME clears the credential pair.
  dlg = await openEdit()
  dlg.down('#aclsContainer').items.getAt(0).down('#aclUserid').setValue('')
  await settle()
  job = await save(dlg)
  eq('edit(clear): a blanked username sends null, and takes the secret with it',
    job.body.acls, [{ initiatorIqn: ISCSI_INITIATOR, chapUserid: null, chapSecret: null }])

  // (vi) Removing an initiator sends the SHORTER complete list.
  dlg = await openEdit()
  const remove = dlg.down('#aclsContainer').items.getAt(0).down('#aclRemove')
  remove.handler(remove)
  await settle()
  job = await save(dlg)
  eq('edit(remove): the ACL list travels complete and shorter', job.body.acls, [])

  ok('edit: nothing warned', warnings.length === 0, warnings.join(' | '))
}

/** Open the LUNs window on the ANAS target. */
async function openLuns(grid, routes) {
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))
  const btn = grid.down('#iscsiLuns')
  btn.handler(btn)
  await settle()
  return openWindow()
}

async function iscsiLunChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)
  const lunsWin = await openLuns(grid, ISCSI_ROUTES)
  ok('luns: the window opened', !!lunsWin && !!lunsWin.down('#lunsGrid'))
  if (!lunsWin) { return }
  const lunsGrid = lunsWin.down('#lunsGrid')
  eq('luns: both LUNs loaded', lunsGrid.getStore().getCount(), 2)

  const LUN_BTNS = ['lunAdd', 'lunResize', 'lunDelete']
  let state = toolbar(lunsGrid, LUN_BTNS)
  ok('luns: Add is enabled on an ANAS target', state.lunAdd.disabled === false)
  ok('luns: Resize needs a selection', state.lunResize.disabled === true)

  lunsGrid.selectRow(0)
  state = toolbar(lunsGrid, LUN_BTNS)
  ok('luns(selected): Resize enabled', state.lunResize.disabled === false)
  ok('luns(selected): Delete enabled', state.lunDelete.disabled === false)

  // --- Add LUN: the zvol branch --------------------------------------------
  jobs.length = 0
  let btn = lunsGrid.down('#lunAdd')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('addlun: the dialog opened', !!dlg && !!dlg.down('#lunName'))
  if (!dlg) { return }
  eq('addlun: it defaults to a zvol', dlg.down('#kindGroup').getValue(), { lunKind: 'zvol' })
  ok('addlun: the image fields start hidden AND disabled', dlg.down('#size').hidden === true
    && dlg.down('#size').disabled === true)
  ok('addlun: the zvol picker is visible', dlg.down('#zvolPicker').hidden === false)

  const zvols = dlg.down('#zvolPicker').getStore().getRange().map(r => r.get('name'))
  ok('addlun: the picker offers ANAS-managed volumes', zvols.includes('tank/vol1') && zvols.includes('tank/vol2'),
    JSON.stringify(zvols))
  ok('addlun: a PVE guest disk is NEVER a candidate', !zvols.includes('tank/vm-101-disk-0'), JSON.stringify(zvols))
  ok('addlun: a PVE-managed pool is not even enumerated',
    !zvols.some(z => z.startsWith('pvepool')), JSON.stringify(zvols))
  ok('addlun: filesystems are not offered as zvols', !zvols.includes('tank/images'), JSON.stringify(zvols))

  const dirs = dlg.down('#filePicker').getStore().getRange().map(r => r.get('name'))
  ok('addlun: the image-file picker offers datasets AND the AHR pool',
    dirs.includes('tank/images') && dirs.includes('ahrpool'), JSON.stringify(dirs))
  ok('addlun: it does not offer a zvol as a place to put a file',
    !dirs.includes('tank/vol1'), JSON.stringify(dirs))

  ok('addlun: the attribute summary states what ANAS sets',
    /Thin reclaim on/.test(dlg.down('#lunAttrSummary').html)
    && /Write-through/.test(dlg.down('#lunAttrSummary').html),
    dlg.down('#lunAttrSummary').html)
  ok('addlun: and that the serial survives a recreate',
    /unit serial that survives every recreate/.test(dlg.down('#lunAttrSummary').html),
    dlg.down('#lunAttrSummary').html)

  dlg.down('#lunName').setValue('vmdisk3')
  dlg.down('#zvolPicker').setValue('tank/vol2')
  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-submit')
  submit.handler(submit)
  await settle()
  eq('addlun(zvol): one job', jobs.length, 1)
  eq('addlun(zvol): it POSTs to the target\'s LUN collection', jobs[0].path,
    `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}/luns`)
  eq('addlun(zvol): the body names the volume and carries NO size and NO block size',
    jobs[0].body, { name: 'vmdisk3', kind: 'zvol', backing: 'tank/vol2' })

  // --- Add LUN: the file branch --------------------------------------------
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#kindGroup').setValue({ lunKind: 'file' })
  await settle()
  ok('addlun(file): the image fields appear', dlg.down('#size').hidden === false
    && dlg.down('#filePicker').hidden === false)
  ok('addlun(file): the zvol picker goes away AND is disabled, so a stale value cannot be read back',
    dlg.down('#zvolPicker').hidden === true && dlg.down('#zvolPicker').disabled === true)
  ok('addlun(file): the honest reclaim caveat appears for an image file',
    /rejected by LIO for this backend/.test(dlg.down('#lunAttrSummary').html),
    dlg.down('#lunAttrSummary').html)
  ok('addlun(file): and that its size is fixed at creation',
    /fixed at creation/.test(dlg.down('#lunAttrSummary').html), dlg.down('#lunAttrSummary').html)

  dlg.down('#lunName').setValue('vmdisk4')
  dlg.down('#filePicker').setValue('tank/images')
  dlg.down('#size').setValue(4)
  dlg.down('#unit').setValue(GiB_)
  dlg.down('#blockSize').setValue(4096)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-submit')
  submit.handler(submit)
  await settle()
  eq('addlun(file): the body carries the host, the size in BYTES and the block size',
    jobs[0].body, { name: 'vmdisk4', kind: 'file', backing: 'tank/images', size: 4 * GiB_, blockSize: 4096 })

  // A blank block size sends NO key — LIO then applies its own 512.
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#lunName').setValue('vmdisk5')
  dlg.down('#zvolPicker').setValue('tank/vol2')
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-submit')
  submit.handler(submit)
  await settle()
  ok('addlun: a default block size sends no blockSize at all',
    !('blockSize' in jobs[0].body), JSON.stringify(jobs[0].body))

  ok('addlun: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiResizeAndDeleteChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { grid } = await openIscsiView(ISCSI_ROUTES)
  const lunsWin = await openLuns(grid, ISCSI_ROUTES)
  const lunsGrid = lunsWin.down('#lunsGrid')

  // --- Resize the ZVOL LUN (index 0, 2 GiB) --------------------------------
  lunsGrid.selectRow(0)
  jobs.length = 0
  let btn = lunsGrid.down('#lunResize')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('resize: the window opened', !!dlg && !!dlg.down('#size'))
  eq('resize: it pre-fills the CURRENT size in the largest exact unit',
    [dlg.down('#size').getValue(), dlg.down('#unit').getValue()], [2, GiB_])
  ok('resize: the serial is shown — it is the identity the initiator keys on',
    String(dlg.down('#currentSerial').value).includes('9bc6e907'), dlg.down('#currentSerial').value)
  ok('resize(zvol): the note says a volume grows LIVE',
    /grows live/.test(dlg.down('#resizeNote').html), dlg.down('#resizeNote').html)

  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: an untouched edit sends NOTHING', jobs.length, 0)
  ok('resize: and closes', dlg.destroyed === true)

  // A shrink is refused before it can reach the daemon.
  jobs.length = 0
  warnings.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#size').setValue(1)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: a shrink sends NOTHING', jobs.length, 0)
  ok('resize: a shrink says why', warnings.some(w => /can only grow/.test(w)), warnings.join(' | '))
  ok('resize: a shrink leaves the window open to fix', dlg.destroyed === false)
  warnings.length = 0

  // A grow is a PUT of the size alone.
  dlg.down('#size').setValue(8)
  submit.handler(submit)
  await settle()
  eq('resize: one job', jobs.length, 1)
  eq('resize: it PUTs at the LUN index', [jobs[0].method, jobs[0].path],
    ['put', `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}/luns/0`])
  eq('resize: it sends the size and nothing else', jobs[0].body, { size: 8 * GiB_ })

  // --- The FILE LUN says its resize is a recreate ---------------------------
  lunsGrid.selectRow(1)
  btn = lunsGrid.down('#lunResize')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  ok('resize(file): the note says the backstore is RECREATED with the same identity',
    /same unit serial/i.test(dlg.down('#resizeNote').html) && /same attributes/i.test(dlg.down('#resizeNote').html),
    dlg.down('#resizeNote').html)
  ok('resize(file): and that this is because the size is fixed at creation',
    /fixed at creation/.test(dlg.down('#resizeNote').html), dlg.down('#resizeNote').html)
  dlg.close()

  // --- Delete a LUN ---------------------------------------------------------
  lunsGrid.selectRow(0)
  jobs.length = 0
  const del = lunsGrid.down('#lunDelete')
  del.handler(del)
  await settle()
  eq('deletelun: one request', jobs.length, 1)
  eq('deletelun: it DELETEs the LUN with NO destroy flag by default',
    [jobs[0].method, jobs[0].path],
    ['del', `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}/luns/0`])
  ok('deletelun: it is confirm-gated with a widget window', jobs[0].confirmWindow === true)

  // The destructive half is a SEPARATE ticked choice that becomes a query flag.
  const extra = makeComponent({ xtype: 'window', items: jobs[0].extraItems }, null)
  const box = extra.down('#destroyBacking')
  ok('deletelun: the destroy-backing checkbox exists and starts UNticked',
    !!box && box.getValue() === false)
  ok('deletelun: it names the object it would destroy',
    /\/dev\/zvol\/tank\/vol1/.test(box.boxLabel), box.boxLabel)
  ok('deletelun: and warns a zvol takes its snapshots with it',
    /snapshots/.test(box.boxLabel), box.boxLabel)
  eq('deletelun: unticked adds no query at all', jobs[0].mapConfirm(extra), {})
  box.setValue(true)
  eq('deletelun: ticked becomes ?destroyBacking=true',
    jobs[0].mapConfirm(extra), { pathSuffix: '?destroyBacking=true' })

  ok('resize/delete: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiSessionGatingChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  // The same target, but with an initiator logged in on LUN 0.
  const routes = {
    ...ISCSI_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: iscsiDetail({ session: true }) },
  }
  const { grid } = await openIscsiView(routes)
  const lunsWin = await openLuns(grid, routes)
  const lunsGrid = lunsWin.down('#lunsGrid')

  lunsGrid.selectRow(0) // the LUN with a live session
  let state = toolbar(lunsGrid, ['lunAdd', 'lunResize', 'lunDelete'])
  ok('session: Resize is DISABLED under a live session', state.lunResize.disabled === true)
  ok('session: Delete is DISABLED under a live session', state.lunDelete.disabled === true)
  ok('session: the reason says LIO would not have refused',
    /stale device/.test(state.lunResize.tip), state.lunResize.tip)
  ok('session: Add LUN is still allowed', state.lunAdd.disabled === false)

  lunsGrid.selectRow(1) // the LUN with nobody logged in
  state = toolbar(lunsGrid, ['lunResize', 'lunDelete'])
  ok('session: a LUN with no session is still resizable', state.lunResize.disabled === false)
  ok('session: …and deletable', state.lunDelete.disabled === false)

  // The live session is SHOWN, with its address — and never the misleading
  // `(NOT AUTHENTICATED)` label targetcli prints for one-way CHAP.
  const panel = lunsWin.down('#lunSessions')
  ok('session: the detail lists the logged-in initiator',
    String(panel.html).includes(ISCSI_INITIATOR), panel.html)
  ok('session: with the address it connected from',
    String(panel.html).includes('192.168.200.60'), panel.html)
  ok('session: and never the misleading NOT AUTHENTICATED label',
    !/NOT AUTHENTICATED/.test(String(panel.html)), panel.html)

  ok('session: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiForeignLunChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { grid } = await openIscsiView(ISCSI_ROUTES)
  grid.selectRow(iscsiRowOf(grid, ISCSI_FOREIGN))
  const btn = grid.down('#iscsiLuns')
  btn.handler(btn)
  await settle()
  const win = openWindow()
  const lunsGrid = win.down('#lunsGrid')
  const state = toolbar(lunsGrid, ['lunAdd', 'lunResize', 'lunDelete'])
  ok('foreign luns: Add LUN is DISABLED on a foreign target', state.lunAdd.disabled === true)
  ok('foreign luns: Resize is DISABLED', state.lunResize.disabled === true)
  ok('foreign luns: Delete is DISABLED', state.lunDelete.disabled === true)
  ok('foreign luns: the reason is hands-off, not a generic refusal',
    /not managed by ANAS/.test(state.lunAdd.tip), state.lunAdd.tip)
  ok('foreign luns: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ---------------------------------------------------------------------------
//  iscsi.5 — the Repair door and the `unresolved` backing tier
// ---------------------------------------------------------------------------
//
// A boot restore whose backing device was missing exits 0 and systemd logs
// `Result=success`, so the Repair button is the operator's only handle on it.
// It has to be live ONLY when a hole's backing object is actually back —
// recreating a backstore over an absent device is how the hole was made — and
// when it is not live it has to say what is still missing.

async function iscsiRepairChecks() {
  ajax.responses = { '/network': PVE_NETWORK }

  // 1. Healthy: nothing to repair, and the button says so rather than sitting
  //    greyed with no explanation.
  let view = (await openIscsiView(ISCSI_ROUTES)).view
  let grid = view.down('#iscsiGrid')
  let state = toolbar(grid, ['iscsiRepair'])
  ok('repair(healthy): the button exists on the iSCSI toolbar', state.iscsiRepair !== null)
  ok('repair(healthy): DISABLED', state.iscsiRepair.disabled === true)
  ok('repair(healthy): says there is nothing to repair',
    /Nothing to repair/.test(state.iscsiRepair.tip), state.iscsiRepair.tip)

  // 2. A hole whose backing is STILL MISSING: refused, and the tooltip names
  //    the path so the operator knows what to bring back.
  created.windows.length = 0
  view = (await openIscsiView({ ...ISCSI_ROUTES, 'GET /iscsi/health': iscsiHealth({ missing: [iscsiHole(false)] }) })).view
  grid = view.down('#iscsiGrid')
  state = toolbar(grid, ['iscsiRepair'])
  ok('repair(absent): still DISABLED — a recreate over an absent device made the hole',
    state.iscsiRepair.disabled === true)
  ok('repair(absent): names the backing path that has to come back',
    /\/dev\/zvol\/tank\/vol1/.test(state.iscsiRepair.tip), state.iscsiRepair.tip)

  // 3. The backing is BACK: live, and it POSTs the node-level repair.
  created.windows.length = 0
  jobs.length = 0
  view = (await openIscsiView({
    ...ISCSI_ROUTES,
    'GET /iscsi/health': iscsiHealth({ missing: [iscsiHole(true)] }),
  })).view
  grid = view.down('#iscsiGrid')
  state = toolbar(grid, ['iscsiRepair'])
  ok('repair(present): ENABLED once the backing object resolves again',
    state.iscsiRepair.disabled === false)
  ok('repair(present): the tooltip promises the SAME disk, not a new one',
    /same serial and attributes/.test(state.iscsiRepair.tip), state.iscsiRepair.tip)
  const btn = grid.down('#iscsiRepair')
  btn.handler(btn)
  await settle()
  eq('repair(present): POSTs the node-level repair, with no per-target path',
    { method: jobs[0].method, path: jobs[0].path }, { method: 'post', path: '/iscsi/health/repair' })

  // 4. Not installed: the whole toolbar is flat, Repair included.
  created.windows.length = 0
  view = (await openIscsiView({
    'GET /iscsi/targets': { data: { installed: false, configfsPresent: false, saveconfigPresent: false, reason: 'no LIO', targets: [] } },
  })).view
  grid = view.down('#iscsiGrid')
  ok('repair(not-installed): DISABLED with the rest of the toolbar',
    toolbar(grid, ['iscsiRepair']).iscsiRepair.disabled === true)

  ok('repair: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiUnresolvedLunChecks() {
  // "Not on this node right now" is NOT "somebody else's" (live-proof F2): the
  // target stays ANAS's — the toolbar is live — but the LUN itself cannot be
  // resized, because there is no backing object to grow.
  ajax.responses = { '/network': PVE_NETWORK }
  const detail = iscsiDetail()
  detail.ownershipReason = 'backing-unresolved'
  detail.luns[1] = { ...detail.luns[1], kind: 'unresolved', backingExists: false, present: false, pool: undefined, dataset: undefined }
  const targets = { ...ISCSI_TARGETS, targets: [{ ...ISCSI_TARGETS.targets[0], ownershipReason: 'backing-unresolved' }, ISCSI_TARGETS.targets[1]] }

  const { grid } = await openIscsiView({
    ...ISCSI_ROUTES,
    'GET /iscsi/targets': { data: targets },
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: detail },
  })

  // The target is still ANAS's: every verb stays available.
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))
  const targetState = toolbar(grid, ['iscsiEdit', 'iscsiDelete', 'iscsiLuns'])
  ok('unresolved: an unresolved LUN does NOT make its target hands-off',
    targetState.iscsiEdit.disabled === false && targetState.iscsiDelete.disabled === false)

  const btn = grid.down('#iscsiLuns')
  btn.handler(btn)
  await settle()
  const win = openWindow()
  const lunsGrid = win.down('#lunsGrid')
  const rec = lunsGrid.getStore().getAt(1)
  ok('unresolved: the row carries the new kind', rec.get('kind') === 'unresolved')

  lunsGrid.selectRow(1)
  const state = toolbar(lunsGrid, ['lunResize', 'lunDelete'])
  ok('unresolved: Resize is DISABLED — there is nothing on this node to grow',
    state.lunResize.disabled === true)
  ok('unresolved: and it says why, pointing at Repair',
    /not on this node right now/i.test(state.lunResize.tip) && /Repair/.test(state.lunResize.tip),
    state.lunResize.tip)
  // Unmapping a LUN whose backing is gone is still legitimate cleanup.
  ok('unresolved: Delete stays available', state.lunDelete.disabled === false)

  ok('unresolved: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiAddressFallbackChecks() {
  // PVE's network API is unreadable: the picker must degrade to a free-text
  // field rather than leaving the operator with no way to enter an address.
  ajax.responses = {}
  const { grid } = await openIscsiView(ISCSI_ROUTES)
  const btn = grid.down('#iscsiCreate')
  btn.handler(btn)
  await settle()
  const dlg = openWindow()
  const picker = dlg.down('#portalAddress')
  ok('addresses: a failed network read still leaves an editable field',
    !!picker && picker.editable === true)
  jobs.length = 0
  dlg.down('#name').setValue('vmstore9')
  picker.setValue('10.1.2.3')
  const submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('addresses: a hand-typed address still submits',
    jobs[0].body.portals, [{ address: '10.1.2.3', port: 3260 }])
  ok('addresses: nothing warned', warnings.length === 0, warnings.join(' | '))
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
for (const check of [
  iscsiGridChecks,
  iscsiNotInstalledChecks,
  iscsiCreateChecks,
  iscsiEditChecks,
  iscsiLunChecks,
  iscsiResizeAndDeleteChecks,
  iscsiSessionGatingChecks,
  iscsiForeignLunChecks,
  iscsiAddressFallbackChecks,
  iscsiRepairChecks,
  iscsiUnresolvedLunChecks,
]) {
  warnings.length = 0
  // `created.windows` is module-global; a dialog a previous section left open
  // would otherwise be what `openWindow()` hands back here.
  created.windows.length = 0
  await check()
}

if (failures.length) {
  console.error(`\n✖ ${failures.length} of ${checks} checks failed:\n`)
  for (const f of failures) { console.error(`  • ${f}`) }
  process.exit(1)
}
console.log(`✔ dialog contracts: ${checks} checks passed`)
