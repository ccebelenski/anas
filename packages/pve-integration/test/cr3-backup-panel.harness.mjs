#!/usr/bin/env node
/*
 * ANAS — cr3.backup-panel harness: the 2026-11-14 review's Backup (panel)
 * findings, each pinned against the REAL 68-backup.js.
 *
 * It stubs the slice of ExtJS the Backup view's dialogs touch (windows, forms,
 * combo stores, radio groups, Ext.Msg), loads 68-backup.js in a vm sandbox,
 * drives the real dialogs and asserts on what they SEND and SHOW.
 *
 *   BACKUP-PANEL-M1  restore: an archive / point-in-time / source change drops
 *                    the previous pick's home, selections and archive list
 *   BACKUP-PANEL-M2  a task with one image archive at a non-LUN path can be
 *                    edited (no invented `{targetIqn:'', index:0}`), and the
 *                    wizard stores the kind it was built as
 *   BACKUP-PANEL-M3  retention Preview sends the EFFECTIVE namespace
 *   BACKUP-PANEL-M4  Edit and Enable/Disable start from a fresh read of the task
 *   BACKUP-PANEL-M5  every data-carrying combo encodes its list; titles encode
 *   BACKUP-PANEL-L6  a files task never inherits a LUN's `lun-<serial>` id
 *   BACKUP-PANEL-L7  an auth or identity change on a repo edit needs its secret
 *   BACKUP-PANEL-L8 / INVENTED-STATE-L14  a repo Test that errored or reported
 *                    nothing is never "cannot reach the host" or "verified"
 *   BACKUP-PANEL-L9  the default etc row's name derives from its path
 *   BACKUP-PANEL-L10 a failed repositories read is shown as failed
 *   BACKUP-PANEL-L11 "This LUN" follows a source change
 *   BACKUP-PANEL-L12 a failed LUN inventory read says why "This LUN" is off
 *
 *   node packages/pve-integration/test/cr3-backup-panel.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { BackupTaskRequest } from '@anas/shared'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

// ---- Checks -----------------------------------------------------------------

const failures = []
let checks = 0
function ok(label, cond, detail) {
  checks++
  if (!cond) { failures.push(detail === undefined ? label : `${label} — ${detail}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, `got ${a}, want ${e}`)
}

// ---- Harness-controlled state -----------------------------------------------

const state = {
  routes: {},
  jobs: [],
  warnings: [],
  alerts: [],
  toasts: [],
  confirms: [],
  confirmAnswer: 'yes',
  gets: [],
  posts: [],
  windows: [],
  pathPickers: [],
  snapPickers: [],
  polls: [],
}

function reset(routes) {
  state.routes = routes || {}
  state.jobs.length = 0
  state.warnings.length = 0
  state.alerts.length = 0
  state.toasts.length = 0
  state.confirms.length = 0
  state.confirmAnswer = 'yes'
  state.gets.length = 0
  state.posts.length = 0
  state.windows.length = 0
  state.pathPickers.length = 0
  state.snapPickers.length = 0
  state.polls.length = 0
}

function htmlEncode(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---- A minimal store + component tree ---------------------------------------

function makeRecord(data) {
  const rec = {
    data: { ...data },
    get: k => rec.data[k],
    set(k, v) { rec.data[k] = v },
    getData: () => ({ ...rec.data }),
  }
  return rec
}

function makeStore(cfg) {
  let recs = ((cfg && cfg.data) || []).map(makeRecord)
  const store = {
    isStore: true,
    loadData(rows) { recs = (rows || []).map(makeRecord) },
    getRange: () => recs.slice(),
    getCount: () => recs.length,
    getAt: i => recs[i] || null,
    each(fn) { recs.slice().forEach(fn) },
    findExact(field, value) { return recs.findIndex(r => r.get(field) === value) },
    findRecord(field, value) { return recs.find(r => r.get(field) === value) || null },
  }
  return store
}

const CHECKBOXES = ['checkbox', 'checkboxfield', 'radio', 'radiofield']

function makeComponent(cfg, parent) {
  const c = { ...(cfg && typeof cfg === 'object' ? cfg : {}) }
  c.parent = parent || null
  c.destroyed = false
  c.destroying = false
  c.hidden = !!c.hidden
  c.disabled = !!c.disabled
  c._on = {}
  c._selection = []
  if (c.store && !c.store.isStore) { c.store = makeStore(c.store) }

  const items = []
  const build = list => (Array.isArray(list) ? list : (list && list.items) || [])
    .filter(x => x && typeof x === 'object')
    .map(k => makeComponent(k, c))
  items.push(...build(cfg && cfg.items))
  c.buttonCmps = build(cfg && cfg.buttons)
  c.tbarCmps = build(cfg && cfg.tbar)
  c.items = {
    each(fn) { items.slice().forEach(fn) },
    getCount: () => items.length,
    getRange: () => items.slice(),
  }
  c.childCmps = () => items.concat(c.buttonCmps, c.tbarCmps)
  c.add = function (what) {
    const list = Array.isArray(what) ? what : [what]
    const made = list.map(one => makeComponent(one, c))
    items.push(...made)
    return Array.isArray(what) ? made : made[0]
  }
  c.remove = function (cmp) {
    const i = items.indexOf(cmp)
    if (i >= 0) { items.splice(i, 1) }
    if (cmp) { cmp.destroyed = true }
  }
  c.removeAll = function () { items.length = 0 }
  c.down = function (sel) {
    for (const kid of c.childCmps()) {
      if (sel.charAt(0) === '#' ? kid.itemId === sel.slice(1) : kid.xtype === sel) { return kid }
      const deep = kid.down(sel)
      if (deep) { return deep }
    }
    return null
  }
  c.up = function (sel) {
    let p = c.parent
    while (p) {
      // 'grid' is ExtJS's alias for a gridpanel (toolbar handlers walk up to it).
      if (!sel || (sel.charAt(0) === '#' ? p.itemId === sel.slice(1)
        : (p.xtype === sel || (sel === 'grid' && p.xtype === 'gridpanel')))) { return p }
      p = p.parent
    }
    return null
  }
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
    const before = JSON.stringify(c.getValue())
    if (isCheckbox) { c.checked = !!v }
    else if (isRadioGroup) {
      const want = v && typeof v === 'object' ? v[Object.keys(v)[0]] : v
      for (const kid of c.childCmps()) { kid.checked = kid.inputValue === want }
    }
    else { c.value = v }
    // ExtJS fires `change` only when the value actually changed.
    if (JSON.stringify(c.getValue()) !== before) { c.fireEvent('change', c, c.getValue()) }
    return c
  }
  c.on = function (ev, fn) { (c._on[ev] = c._on[ev] || []).push(fn) }
  c.fireEvent = function (ev, ...args) {
    for (const fn of c._on[ev] || []) { fn(...args) }
    const l = cfg && cfg.listeners && cfg.listeners[ev]
    if (typeof l === 'function') { l.apply(c, args) }
  }
  c.getStore = () => c.store
  // The grid's view: where ExtJS keeps the (HTML) empty sentence.
  c.getView = () => (c._view = c._view || { emptyText: c.emptyText, refresh() {} })
  c.getSelection = () => c._selection.slice()
  c.selectRow = function (idx) {
    const rec = c.store.getAt(idx)
    c._selection = rec ? [rec] : []
    c.fireEvent('selectionchange', {}, c._selection)
    return rec
  }
  c.setLoading = (msg) => { c.loadingMsg = msg; return c }
  c.setHidden = function (v) { c.hidden = !!v; return c }
  c.setVisible = function (v) { c.hidden = !v; return c }
  c.isVisible = () => !c.hidden
  c.setDisabled = function (v) { c.disabled = !!v; return c }
  c.setReadOnly = function (v) { c.readOnly = !!v; return c }
  c.setTooltip = function (v) { c.tooltip = v || '' }
  c.setText = function (v) { c.text = v; return c }
  c.setIconCls = function (v) { c.iconCls = v; return c }
  c.update = function (h) { c.html = h; return c }
  c.setTitle = function (h) { c.title = h; return c }
  c.getForm = () => ({ isValid: () => true })
  c.show = function () { c.hidden = false; return c }
  c.close = function () { c.destroyed = true; return c }
  c.destroy = function () { c.destroyed = true; return c }
  c.focus = () => c
  return c
}

/** Every component under `root` (depth-first), the root included. */
function allCmps(root) {
  const out = [root]
  for (const kid of root.childCmps()) { out.push(...allCmps(kid)) }
  return out
}

function byCls(root, cls) {
  return allCmps(root).find(c => c.cls === cls) || null
}

const Ext = {
  create(cls, cfg) {
    if (cls === 'Ext.data.Store') { return makeStore(cfg) }
    if (cls === 'Ext.window.Window') {
      const w = makeComponent({ ...cfg, xtype: 'window' }, null)
      state.windows.push(w)
      return w
    }
    throw new Error(`Ext.create: unexpected ${cls}`)
  },
  String: { htmlEncode },
  Msg: {
    alert(title, msg) { state.alerts.push({ title, msg }) },
    confirm(title, msg, fn) {
      state.confirms.push({ title, msg })
      if (fn) { fn(state.confirmAnswer) }
    },
  },
}

/**
 * What a combo's drop-down list puts into innerHTML for `rows`. A combo with a
 * `listConfig.tpl` renders through it (the handful of XTemplate forms the
 * panels use: `<tpl for=".">`, `{field}`, `{field:htmlEncode}`); one without
 * renders ExtJS's DEFAULT BoundList item, `{<displayField>}` — RAW (proven in
 * a browser on PVE 9.2, ExtJS 7.0.0.168: the coordinator's settling probe).
 */
function renderBoundList(combo, rows) {
  const tpl = combo.listConfig && combo.listConfig.tpl
  const inner = tpl
    ? String(tpl).replace(/^<tpl for="\.">/, '').replace(/<\/tpl>$/, '')
    : `<div class="x-boundlist-item">{${combo.displayField}}</div>`
  return rows.map(row => inner.replace(/\{(\w+)(:htmlEncode)?\}/g,
    (_m, field, encode) => (encode ? htmlEncode(row[field]) : String(row[field] == null ? '' : row[field]))))
    .join('')
}

// ---- The ANAS surface 68-backup.js calls ------------------------------------

function routeOf(method, path) {
  const exact = `${method} ${path}`
  if (exact in state.routes) { return state.routes[exact] }
  const bare = `${method} ${path.split('?')[0]}`
  if (bare in state.routes) { return state.routes[bare] }
  return undefined
}

function answer(method, path, arg) {
  const value = routeOf(method, path)
  if (value === undefined) { return Promise.reject(new Error(`unexpected ${method} ${path}`)) }
  if (value instanceof Error) { return Promise.reject(value) }
  try {
    const out = typeof value === 'function' ? value(arg, path) : value
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out)
  }
  catch (e) {
    return Promise.reject(e)
  }
}

function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

function makeAnas() {
  return {
    views: {},
    t: s => s,
    enc: htmlEncode,
    warn(m) { state.warnings.push(m) },
    errText: e => String((e && e.message) || e),
    toast(m) { state.toasts.push(m) },
    alertMsg(title, msg) { state.alerts.push({ title, msg: htmlEncode(msg) }) },
    formatBytes: n => `${Number(n) || 0} B`,
    tbar: items => ({ xtype: 'toolbar', items }),
    noAutofill: { user: { inputAttrTpl: '' }, secret: { inputAttrTpl: '' } },
    warningsHtml: lines => `<ul>${(lines || []).map(l => `<li>${htmlEncode(l)}</li>`).join('')}</ul>`,
    errorPanel: msg => ({ xtype: 'component', html: msg }),
    notifyMode: {
      of(value, dflt) {
        const s = String(value == null ? '' : value).toLowerCase()
        return (s === 'always' || s === 'on-failure') ? s : dflt
      },
      // The shared notify combo lives in 00-core (its own area); its rows are
      // fixed words, so the stub carries no store.
      field: cfg => ({ xtype: 'combobox', itemId: cfg.itemId, cls: cfg.cls, value: cfg.value }),
    },
    // The cadence widget lives in 69-schedules-common.js; these checks are not
    // about it, so it is the Custom field alone (the raw schedule round-trips).
    sched: {
      cadence: {
        of: task => (task && task.cadence) || null,
        text: () => '',
        fieldset: (_c, task) => ({ xtype: 'textfield', itemId: 'schedule', value: (task && task.schedule) || 'daily' }),
        kindOf: () => 'custom',
        syncFields() {},
        read: () => null,
      },
      runErrors: { clear() {}, set() {} },
      cancellable: () => false,
    },
    iscsi: {
      lunInPlace: () => ({ allowed: true }),
      loadBackingChoices() {},
    },
    pathPicker(cfg) { state.pathPickers.push(cfg) },
    snapshotPicker(cfg) { state.snapPickers.push(cfg) },
    api: {
      get(_node, path) { state.gets.push(path); return answer('GET', path, path) },
      // A whole-task PUT bound to a revision goes straight through the API (the
      // panel routes its 409 STATE_CHANGED itself); recorded like a job.
      put(_node, path, body) {
        state.jobs.push({ door: 'api.put', method: 'put', path, body })
        return answer('PUT', path.split('?')[0], body)
      },
      post(_node, path, body) { state.posts.push({ path, body }); return answer('POST', path, body) },
    },
    runJob(cfg) {
      state.jobs.push({ door: 'runJob', method: cfg.method, path: cfg.path, body: cfg.body, opts: cfg })
      if (cfg.onSubmitted) { cfg.onSubmitted({ id: 'job-stub' }) }
    },
    confirmAndRun(cfg) {
      state.jobs.push({ door: 'confirmAndRun', method: cfg.method, path: cfg.path, body: cfg.body, confirmIntro: cfg.confirmIntro })
    },
    pollJob(_node, id, opts) { state.polls.push({ id, opts }) },
    casWrite(cfg) { state.jobs.push({ door: 'casWrite', method: cfg.method, path: cfg.path, body: cfg.body }) },
  }
}

function loadPanel() {
  const ANAS = makeAnas()
  const sandbox = {
    window: { ANAS },
    Ext,
    console,
    setTimeout,
    clearTimeout,
    // The view's poll: not exercised here.
    setInterval: () => 0,
    clearInterval() {},
    Promise,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(SRC, '68-backup.js'), 'utf8'), sandbox, { filename: '68-backup.js' })
  return ANAS
}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) { await new Promise(r => setTimeout(r, 0)) }
}

const lastWindow = () => state.windows[state.windows.length - 1] || null
const VIEW = { down: () => null, up: () => null, destroyed: false }
const NODE = 'harness'

function press(win, itemIdOrCls) {
  const btn = win.down(`#${itemIdOrCls}`) || byCls(win, itemIdOrCls)
  if (!btn) { throw new Error(`no button ${itemIdOrCls}`) }
  btn.handler(btn)
}

// ---- Fixtures ---------------------------------------------------------------

const REPOS = {
  data: {
    version: 3,
    repos: [
      { name: 'pbs-main', host: 'pbs.example', port: 8007, datastore: 'store1', source: 'anas', authType: 'token', tokenId: 'root@pam!anas', credentialsSet: true },
      { name: 'pbs-ns', host: 'pbs.example', port: 8007, datastore: 'store2', namespace: 'repo-ns', source: 'anas', authType: 'token', tokenId: 'root@pam!anas', credentialsSet: true },
    ],
  },
}

const TASK = {
  name: 'nightly-pictures',
  repository: 'pbs-main',
  namespace: 'anas/pictures',
  backupId: 'pictures',
  archives: [{ name: 'pictures', path: '/mnt/pictures', excludes: [] }],
  changeDetectionMode: 'default',
  retention: { keepLast: 3 },
  notify: 'always',
  schedule: 'daily',
  enabled: true,
  limitNofile: 1024,
}

const LUNS = [
  { targetIqn: 'iqn.2026-08.anas:vmstore', index: 0, name: 'vmdisk0', kind: 'zvol', path: '/dev/zvol/tank/vol0', serial: 'aaaa-0000', size: 1024, backingExists: true },
  { targetIqn: 'iqn.2026-08.anas:vmstore', index: 1, name: 'vmdisk1', kind: 'zvol', path: '/dev/zvol/tank/vol1', serial: 'bbbb-1111', size: 2048, backingExists: true },
]

function baseRoutes(extra) {
  return {
    'GET /backup/repos': REPOS,
    'GET /mounts': { data: [] },
    'GET /pools': { data: [] },
    'POST /backup/tasks/preview-nested': { data: { archives: [] } },
    'GET /backup/lun-sources': { data: { installed: true, luns: LUNS } },
    'GET /fs/browse': path => ({ data: { exists: true, path } }),
    'POST /backup/repos/test': { data: { stage: 'ok' } },
    ...extra,
  }
}

// ============================================================================
//  Sections are appended below, one per finding.
// ============================================================================

const SECTIONS = []

// ---- BACKUP-PANEL-M5 — every list a server or a node fills is encoded --------

const EVIL = '<img src=x onerror=alert(1)>'

/** Every combo under `win` whose rows render through a list (has a displayField). */
function listCombos(win) {
  return allCmps(win).filter(c => c.xtype === 'combobox' && c.displayField)
}

function assertListsEncoded(label, win) {
  const combos = listCombos(win)
  ok(`${label}: there are combos to check`, combos.length > 0)
  for (const combo of combos) {
    const rows = combo.getStore().getRange().map(r => r.data)
    const probe = rows.length ? rows : [{ [combo.displayField]: EVIL, [combo.valueField]: 'x' }]
    const html = renderBoundList(combo, probe)
    ok(`${label}: the ${combo.itemId} list never renders server/node text as HTML`,
      !/<img/i.test(html), html)
  }
}

SECTIONS.push(['M5', async () => {
  // The task wizard: the repository list (registry/storage.cfg text) and the
  // path candidates (mountpoints off the node).
  const hostileRepos = { data: { version: 1, repos: [{ name: 'pbs-main', datastore: EVIL, source: 'anas' }] } }
  reset(baseRoutes({
    'GET /backup/repos': hostileRepos,
    'GET /mounts': { data: [{ mountpoint: `/mnt/${EVIL}` }] },
  }))
  let A = loadPanel()
  A.backup.openNewTask(VIEW, NODE, null, null)
  await settle()
  const wiz = lastWindow()
  ok('M5: the wizard opened', !!wiz && /New Backup Task/.test(wiz.title || ''))
  ok('M5: the repository combo holds the hostile datastore',
    wiz.down('#repository').getStore().getRange().some(r => /<img/.test(r.get('label'))))
  ok('M5: the path list holds the hostile mountpoint',
    wiz.down('#archPath').getStore().getRange().some(r => /<img/.test(r.get('label'))))
  assertListsEncoded('M5 wizard', wiz)

  // Window titles are HTML: a task name on the edit title is encoded.
  reset(baseRoutes({ [`GET /backup/tasks/${encodeURIComponent('<b>x</b>')}`]: { data: { task: { ...TASK, name: '<b>x</b>' } } } }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, { ...TASK, name: '<b>x</b>' })
  await settle()
  const ed = lastWindow()
  ok('M5: the edit dialog opened', !!ed)
  ok('M5: the edit title encodes the task name', ed && !/<b>/.test(ed.title || ''), ed && ed.title)

  // The repository edit title encodes the repository name.
  reset(baseRoutes())
  A = loadPanel()
  A.backup.openRepos(NODE)
  await settle()
  const mgr = lastWindow()
  const grid = mgr.down('#reposGrid')
  grid.getStore().loadData([{ name: '<b>r</b>', host: 'h', datastore: 'd', authType: 'token', raw: { name: '<b>r</b>', host: 'h', datastore: 'd' } }])
  grid.selectRow(0)
  press(mgr, 'repoEdit')
  await settle()
  const repoWin = lastWindow()
  ok('M5: the repository EDIT dialog opened', /Edit Repository/.test(repoWin.title || ''), repoWin.title)
  ok('M5: the repository edit title encodes the name', !/<b>/.test(repoWin.title || ''), repoWin.title)

  // The restore dialog: repositories, groups (PBS server text), archives
  // (PBS server file names), and the new-LUN target list (node text).
  reset(baseRoutes({
    'GET /backup/repos': hostileRepos,
    'GET /backup/repos/pbs-main/groups': { data: { verdict: 'ok', groups: [{ group: `host/${EVIL}`, backupId: EVIL, lastBackupIso: '2026-11-01' }] } },
    'GET /iscsi/targets': { data: { targets: [{ iqn: 'iqn.2026-08.anas:t', name: EVIL, ownership: 'anas' }] } },
  }))
  A = loadPanel()
  A.backup.openRestoreDialog(VIEW, NODE, {})
  await settle()
  const rd = lastWindow()
  ok('M5: the restore group combo holds the hostile group',
    rd.down('#restoreGroup').getStore().getRange().some(r => /<img/.test(r.get('label'))))
  rd.down('#restoreGroup').setValue(`host/${EVIL}`)
  press(rd, 'restoreSnapPick')
  await settle()
  const snapCfg = state.snapPickers[state.snapPickers.length - 1]
  snapCfg.onSelect({
    snapshot: `host/${EVIL}/2026-11-01T00:00:00Z`,
    group: `host/${EVIL}`,
    archives: [
      { archive: `${EVIL}.pxar`, kind: 'pxar', size: 1 },
      { archive: `${EVIL}.img`, kind: 'img', size: 1 },
    ],
  })
  await settle()
  rd.down('#restoreArchive').setValue(`${EVIL}.img`)
  await settle()
  ok('M5: the restore archive combo holds the hostile archive',
    rd.down('#restoreArchive').getStore().getRange().some(r => /<img/.test(r.get('label'))))
  ok('M5: the new-LUN target combo holds the hostile target name',
    rd.down('#newLunTarget').getStore().getRange().some(r => /<img/.test(r.get('label'))))
  assertListsEncoded('M5 restore', rd)
}])

// ---- BACKUP-PANEL-M1 — a restore pick belongs to the source it came from ----

const RESTORE_TASK = {
  name: 'nightly-pictures',
  repository: 'pbs-main',
  namespace: 'anas/pictures',
  backupId: 'pictures',
  archives: [
    { name: 'data', path: '/mnt/pictures', excludes: [] },
    { name: 'docs', path: '/srv/docs', excludes: [] },
  ],
  schedule: 'daily',
  enabled: true,
}
const SNAP_A = 'host/pictures/2026-08-25T19:16:45Z'
const SNAP_ARCHIVES = [
  { archive: 'data.pxar', kind: 'pxar', size: 2607 },
  // backup2.3 — an expanded child archive: matches no stored archive, so it
  // has no known home.
  { archive: 'data__sub.pxar', kind: 'pxar', size: 1000 },
  { archive: 'docs.pxar', kind: 'pxar', size: 500 },
]

async function pickSnapshot(win, snapshot, group, archives) {
  press(win, 'restoreSnapPick')
  await settle()
  const cfg = state.snapPickers[state.snapPickers.length - 1]
  cfg.onSelect({ snapshot, group, archives })
  await settle()
}

async function pickFiles(win, paths, type) {
  press(win, 'restoreFilesPick')
  await settle()
  const cfg = state.pathPickers[state.pathPickers.length - 1]
  cfg.onSelect(paths, paths.map(p => ({ path: p, type: type || 'file' })))
  await settle()
}

SECTIONS.push(['M1', async () => {
  reset(baseRoutes())
  let A = loadPanel()
  let win = A.backup.openRestoreDialog(VIEW, NODE, { task: RESTORE_TASK })
  await settle()
  await pickSnapshot(win, SNAP_A, 'host/pictures', SNAP_ARCHIVES)
  win.down('#restoreArchive').setValue('data.pxar')
  await settle()
  eq('M1: data.pxar opens on its live home', win.down('#restoreHome').getValue(), '/mnt/pictures')
  await pickFiles(win, ['/docs/a.txt'])
  win.down('#restoreTargetKind').setValue({ restoreTarget: 'inPlace' })
  await settle()
  eq('M1: a file was picked out of data.pxar', win._selections, ['/docs/a.txt'])

  // Switch to the expanded child archive: it has no known home.
  win.down('#restoreArchive').setValue('data__sub.pxar')
  await settle()
  eq('M1: an archive with no known home does not inherit the previous archive\'s home',
    win.down('#restoreHome').getValue(), '')
  eq('M1: the previous archive\'s selections are dropped', win._selections, [])
  ok('M1: the selection list says nothing is picked',
    /Nothing picked yet/.test(win.down('#restoreSelectionList').html || ''), win.down('#restoreSelectionList').html)
  eq('M1: the destination re-defaults to somewhere else',
    win.down('#restoreTargetKind').getValue(), { restoreTarget: 'newLocation' })
  win.down('#restoreTargetKind').setValue({ restoreTarget: 'inPlace' })
  state.jobs.length = 0
  press(win, 'restoreSubmit')
  await settle()
  eq('M1: nothing is submitted with the stale pick', state.jobs.length, 0)

  // An archive with its own home lands on THAT home.
  win.down('#restoreArchive').setValue('docs.pxar')
  await settle()
  eq('M1: docs.pxar lands on its own home', win.down('#restoreHome').getValue(), '/srv/docs')

  // A TYPED point in time is not the one the archive list was read for.
  await pickFiles(win, ['/x'])
  win.down('#restoreSnapshot').setValue('host/pictures/2026-08-26T00:00:00Z')
  await settle()
  eq('M1: a typed point in time drops the selections', win._selections, [])
  eq('M1: ...and the archive list read for the other point in time',
    win.down('#restoreArchive').getStore().getCount(), 0)
  eq('M1: ...and the chosen archive', win.down('#restoreArchive').getValue(), '')

  // The task-less door: a change of repository, namespace or group drops the
  // point in time and everything picked inside it.
  reset(baseRoutes({
    'GET /backup/repos/pbs-main/groups': { data: { verdict: 'ok', groups: [{ group: 'host/a', backupId: 'a' }, { group: 'host/b', backupId: 'b' }] } },
  }))
  A = loadPanel()
  win = A.backup.openRestoreDialog(VIEW, NODE, {})
  await settle()
  win.down('#restoreGroup').setValue('host/a')
  await pickSnapshot(win, 'host/a/2026-08-25T19:16:45Z', 'host/a', SNAP_ARCHIVES)
  win.down('#restoreArchive').setValue('data.pxar')
  await settle()
  await pickFiles(win, ['/etc/hosts'])
  eq('M1: picked in group host/a', win._selections, ['/etc/hosts'])
  win.down('#restoreGroup').setValue('host/b')
  await settle()
  eq('M1: a group change clears the point in time', win.down('#restoreSnapshot').getValue(), '')
  eq('M1: ...the archive list', win.down('#restoreArchive').getStore().getCount(), 0)
  eq('M1: ...and the selections', win._selections, [])

  await pickSnapshot(win, 'host/b/2026-08-25T19:16:45Z', 'host/b', SNAP_ARCHIVES)
  win.down('#restoreArchive').setValue('data.pxar')
  await settle()
  await pickFiles(win, ['/etc/hosts'])
  win.down('#restoreNs').setValue('other-ns')
  await settle()
  eq('M1: a namespace change clears the point in time', win.down('#restoreSnapshot').getValue(), '')
  eq('M1: ...and the selections', win._selections, [])
  ok('M1: nothing warned', state.warnings.length === 0, state.warnings.join(' | '))

  // The task door, then "Change source" to another group (review probe m1
  // case 2b): the other group's archive of the same name has no home HERE,
  // and the earlier "into the original" choice does not survive.
  for (const [label, change] of [
    ['group', w => w.down('#restoreGroup').setValue('host/other')],
    ['repository', w => w.down('#restoreRepo').setValue('pbs-ns')],
    ['namespace', w => w.down('#restoreNs').setValue('other-ns')],
  ]) {
    reset(baseRoutes({
      'GET /backup/repos/pbs-main/groups': { data: { verdict: 'ok', groups: [{ group: 'host/pictures', backupId: 'pictures' }, { group: 'host/other', backupId: 'other' }] } },
      'GET /backup/repos/pbs-ns/groups': { data: { verdict: 'ok', groups: [{ group: 'host/pictures', backupId: 'pictures' }] } },
    }))
    A = loadPanel()
    win = A.backup.openRestoreDialog(VIEW, NODE, { task: RESTORE_TASK })
    await settle()
    await pickSnapshot(win, SNAP_A, 'host/pictures', SNAP_ARCHIVES)
    win.down('#restoreArchive').setValue('data.pxar')
    await settle()
    await pickFiles(win, ['/a.txt'])
    win.down('#restoreTargetKind').setValue({ restoreTarget: 'inPlace' })
    await settle()
    press(win, 'restoreChangeSource')
    await settle()
    change(win)
    await settle()
    eq(`M1 (${label} change): the destination goes back to somewhere else`,
      win.down('#restoreTargetKind').getValue(), { restoreTarget: 'newLocation' })
    const grp = win.down('#restoreGroup').getValue() || 'host/pictures'
    await pickSnapshot(win, `${grp}/2026-08-25T19:16:45Z`, grp, SNAP_ARCHIVES)
    win.down('#restoreArchive').setValue('data.pxar')
    await settle()
    eq(`M1 (${label} change): another source's data.pxar takes no home from this task`,
      win.down('#restoreHome').getValue(), '')
    await pickFiles(win, ['/a.txt'])
    state.jobs.length = 0
    press(win, 'restoreSubmit')
    await settle()
    const sent = state.jobs[0]
    ok(`M1 (${label} change): nothing is restored in place over this task's home`,
      !sent || !(sent.body.target.mode === 'inPlace' && sent.body.target.path === '/mnt/pictures'), JSON.stringify(sent && sent.body))

    // Review 2 (probe m1b A2/B/C): the operator re-chooses "Into the original".
    eq(`M1 (${label} change): "Into the original" is not offered for another source`,
      inPlaceTargetRadio(win).disabled, true)
    ok(`M1 (${label} change): ...and says why`, /original directory/.test(win.down('#restoreOriginalNote').html || ''),
      win.down('#restoreOriginalNote').html)
    win.down('#restoreTargetKind').setValue({ restoreTarget: 'inPlace' })
    await settle()
    eq(`M1 (${label} change): a forced in-place choice falls back to somewhere else`,
      win.down('#restoreTargetKind').getValue(), { restoreTarget: 'newLocation' })
    state.jobs.length = 0
    press(win, 'restoreSubmit')
    await settle()
    eq(`M1 (${label} change): nothing is sent without a destination`, state.jobs.length, 0)
    win.down('#restoreNewLocation').setValue('/srv/restored')
    await settle()
    state.jobs.length = 0
    press(win, 'restoreSubmit')
    await settle()
    const nl = state.jobs[0]
    ok(`M1 (${label} change): the body names no task once the source is another's`,
      !!nl && !('task' in nl.body), JSON.stringify(nl && nl.body))
    // A Source directory the operator TYPES is a known original location.
    win.down('#restoreHome').setValue('/srv/elsewhere')
    await settle()
    eq(`M1 (${label} change): a typed Source directory offers "Into the original"`, inPlaceTargetRadio(win).disabled, false)
    win.down('#restoreTargetKind').setValue({ restoreTarget: 'inPlace' })
    await settle()
    state.jobs.length = 0
    press(win, 'restoreSubmit')
    await settle()
    const ip = state.jobs[0]
    ok(`M1 (${label} change): ...and the in-place body carries THAT path and no task`,
      !!ip && ip.body.target.mode === 'inPlace' && ip.body.target.path === '/srv/elsewhere' && !('task' in ip.body),
      JSON.stringify(ip && ip.body))
  }

  // The door's own source still names its task (the daemon's in-place gate).
  reset(baseRoutes())
  A = loadPanel()
  win = A.backup.openRestoreDialog(VIEW, NODE, { task: RESTORE_TASK })
  await settle()
  await pickSnapshot(win, SNAP_A, 'host/pictures', SNAP_ARCHIVES)
  win.down('#restoreArchive').setValue('data.pxar')
  await settle()
  await pickFiles(win, ['/a.txt'])
  win.down('#restoreTargetKind').setValue({ restoreTarget: 'inPlace' })
  await settle()
  state.jobs.length = 0
  press(win, 'restoreSubmit')
  await settle()
  ok('M1: on the task\'s own source the in-place body names the task and its home',
    !!state.jobs[0] && state.jobs[0].body.task === RESTORE_TASK.name && state.jobs[0].body.target.path === '/mnt/pictures',
    JSON.stringify(state.jobs[0] && state.jobs[0].body))
}])

// ---- BACKUP-PANEL-M2, L6, L9 — the wizard's kinds, ids and names ------------

async function openWizard(A) {
  A.backup.openNewTask(VIEW, NODE, null, null)
  await settle()
  return lastWindow()
}

async function submitAndBody(win) {
  state.jobs.length = 0
  press(win, 'taskSubmitBtn')
  await settle()
  const job = state.jobs.find(j => j.door === 'runJob')
  return job ? job.body : null
}

function schemaOk(label, body) {
  const parsed = BackupTaskRequest.safeParse(body)
  ok(label, parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues[0]))
}

async function pickBlockLun(win, row) {
  byCls(win, 'anas-btn-backup-block-lun').handler()
  await settle()
  const picker = lastWindow()
  picker.down('#lunGrid').selectRow(row)
  byCls(picker, 'anas-btn-backup-lun-select').handler()
  await settle()
}

const inPlaceTargetRadio = win => win.down('#restoreTargetKind').childCmps().find(k => k.inputValue === 'inPlace')

const firstRow = win => win.down('#archivesContainer').items.getRange()[0]

SECTIONS.push(['M2', async () => {
  // Create: the FILES wizard with one row of kind Block image at a typed
  // device path that is not an iSCSI LUN (the row's documented free-typing).
  reset(baseRoutes())
  let A = loadPanel()
  const wiz = await openWizard(A)
  wiz.down('#name').setValue('rawdisk')
  const row = firstRow(wiz)
  row.down('#archKind').setValue('img')
  row.down('#archPath').setValue('/dev/disk/by-id/ata-EXAMPLE')
  await settle()
  const created = await submitAndBody(wiz)
  ok('M2: the create sent a body', !!created)
  schemaOk('M2: the create body passes the shared schema', created)
  eq('M2: a files-wizard task whose one archive is an image stores kind files (what it was built as)',
    created && created.kind, 'files')
  eq('L9: the default row\'s archive name follows the typed path',
    created && created.archives[0].name, 'ata-EXAMPLE')

  // Edit of the shape the OLD wizard stored: no kind, one image archive, no
  // LUN record, a path that is not a LUN. It derives block.
  const STORED = {
    name: 'rawdisk', repository: 'pbs-main', backupId: 'harness-rawdisk',
    archives: [{ name: 'etc', path: '/dev/disk/by-id/ata-EXAMPLE', excludes: [], kind: 'img' }],
    changeDetectionMode: 'default', notify: 'always', schedule: 'daily', enabled: true,
  }
  for (const lunList of ['answers', 'fails']) {
    reset(baseRoutes({
      'GET /backup/tasks/rawdisk': { data: { task: STORED } },
      ...(lunList === 'fails' ? { 'GET /backup/lun-sources': httpError(500, 'lun list unavailable') } : {}),
    }))
    A = loadPanel()
    A.backup.openEditTask(VIEW, NODE, STORED)
    await settle()
    const ed = lastWindow()
    const panel = (ed.down('#blockLunOut').html || '').replace(/<[^>]+>/g, ' ')
    ok(`M2 (list ${lunList}): the block panel invents no LUN number`, !/LUN 0/.test(panel), panel)
    ok(`M2 (list ${lunList}): ...and promises no refusal the daemon will not make`,
      !/saving will be refused/.test(panel), panel)
    ok(`M2 (list ${lunList}): ...and names the stored path`, panel.includes('/dev/disk/by-id/ata-EXAMPLE'), panel)
    ok(`M2 (list ${lunList}): a failed LUN-list read is said, never a quiet absence`,
      (lunList === 'fails') === /Could not read this node's LUN list: lun list unavailable/.test(panel), panel)
    const body = await submitAndBody(ed)
    ok(`M2 (list ${lunList}): the untouched edit sent a body`, !!body)
    schemaOk(`M2 (list ${lunList}): the untouched edit passes the shared schema`, body)
    eq(`M2 (list ${lunList}): the stored archive rides back verbatim (no invented LUN record)`,
      body && body.archives, STORED.archives)
    ok(`M2 (list ${lunList}): and no kind is claimed`, body && !('kind' in body), JSON.stringify(body))
  }
}])

SECTIONS.push(['L6', async () => {
  reset(baseRoutes())
  let A = loadPanel()
  let wiz = await openWizard(A)
  wiz.down('#name').setValue('nightly')
  eq('L6: a new files task tracks <host>-<name>', wiz.down('#backupId').getValue(), 'harness-nightly')
  wiz.down('#kindGroup').setValue({ taskKind: 'block' })
  await settle()
  await pickBlockLun(wiz, 0)
  eq('L6: a block pick derives the LUN id', wiz.down('#backupId').getValue(), 'lun-aaaa-0000')
  wiz.down('#kindGroup').setValue({ taskKind: 'files' })
  await settle()
  eq('L6: back on Files, the id is the files default again', wiz.down('#backupId').getValue(), 'harness-nightly')
  eq('L6: ...and editable', wiz.down('#backupId').readOnly, false)
  let body = await submitAndBody(wiz)
  eq('L6: the files task is created with its own id, never the LUN\'s', body && body.backupId, 'harness-nightly')

  // An id the operator typed before the detour is theirs, and comes back.
  reset(baseRoutes())
  A = loadPanel()
  wiz = await openWizard(A)
  wiz.down('#name').setValue('n2')
  wiz.down('#backupId').setValue('my-own-group')
  wiz.down('#kindGroup').setValue({ taskKind: 'block' })
  await settle()
  await pickBlockLun(wiz, 1)
  eq('L6: the block pick still derives the LUN id', wiz.down('#backupId').getValue(), 'lun-bbbb-1111')
  wiz.down('#kindGroup').setValue({ taskKind: 'files' })
  await settle()
  eq('L6: back on Files, the operator\'s own id returns', wiz.down('#backupId').getValue(), 'my-own-group')
  body = await submitAndBody(wiz)
  eq('L6: ...and is what is sent', body && body.backupId, 'my-own-group')

  // The mirror: block (LUN picked) -> files -> block again.
  reset(baseRoutes())
  A = loadPanel()
  wiz = await openWizard(A)
  wiz.down('#name').setValue('n3')
  wiz.down('#kindGroup').setValue({ taskKind: 'block' })
  await settle()
  await pickBlockLun(wiz, 0)
  wiz.down('#kindGroup').setValue({ taskKind: 'files' })
  await settle()
  wiz.down('#kindGroup').setValue({ taskKind: 'block' })
  await settle()
  eq('L6 mirror: back on Block with the LUN still picked, the id is the LUN\'s again',
    wiz.down('#backupId').getValue(), 'lun-aaaa-0000')
  eq('L6 mirror: ...and read-only', wiz.down('#backupId').readOnly, true)
  body = await submitAndBody(wiz)
  eq('L6 mirror: the block task is created with the LUN\'s id', body && body.backupId, 'lun-aaaa-0000')
}])

SECTIONS.push(['L9', async () => {
  reset(baseRoutes())
  const A = loadPanel()
  const wiz = await openWizard(A)
  wiz.down('#name').setValue('srv')
  const row = firstRow(wiz)
  eq('L9: the suggested row reads etc for /etc', row.down('#archName').getValue(), 'etc')
  row.down('#archPath').setValue('/srv/data')
  await settle()
  eq('L9: a retyped path renames the suggested row (it was never stored)', row.down('#archName').getValue(), 'data')
  const body = await submitAndBody(wiz)
  eq('L9: the body carries the derived name', body && body.archives[0], { name: 'data', path: '/srv/data', excludes: [] })
}])

// ---- BACKUP-PANEL-M3 — Preview names the namespace the prune will hit -------

SECTIONS.push(['M3', async () => {
  const previews = []
  const route = body => { previews.push(body); return { data: { verdict: 'ok', result: { snapshots: [] } } } }
  const NS_TASK = { ...TASK, name: 'ns-task', repository: 'pbs-ns', namespace: 'own-ns' }
  reset(baseRoutes({
    [`GET /backup/tasks/${TASK.name}`]: { data: { task: TASK } },
    [`GET /backup/tasks/${NS_TASK.name}`]: { data: { task: NS_TASK } },
    [`POST /backup/tasks/${TASK.name}/prune-preview`]: route,
    [`POST /backup/tasks/${NS_TASK.name}/prune-preview`]: route,
  }))
  const A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, TASK)
  await settle()
  let ed = lastWindow()
  press(ed, 'retentionPreview')
  await settle()
  eq('M3: an untouched Preview names the task\'s namespace', (previews.pop() || {}).namespace, 'anas/pictures')
  ed.down('#namespace').setValue('')
  press(ed, 'retentionPreview')
  await settle()
  let sent = previews.pop() || {}
  ok('M3: a cleared field still SENDS a namespace (never "omitted = the stored one")', 'namespace' in sent, JSON.stringify(sent))
  // The daemon's review: the Preview names what the Save stores — a cleared
  // stored namespace is null ("cleared; the repository's own is effective"),
  // never the repository's namespace substituted by the panel.
  eq('M3: ...as the Save will: null (the task\'s namespace cleared)', sent.namespace, null)
  const body = await submitAndBody(ed)
  ok('M3: and Save clears it EXPLICITLY (namespace: null; the PUT keeps an omitted field)',
    !!body && body.namespace === null, JSON.stringify(body))

  A.backup.openEditTask(VIEW, NODE, NS_TASK)
  await settle()
  ed = lastWindow()
  ed.down('#namespace').setValue('')
  press(ed, 'retentionPreview')
  await settle()
  sent = previews.pop() || {}
  eq('M3: a cleared field on a repository with its own namespace previews null too (the daemon resolves the repository\'s)',
    sent.namespace, null)
}])

// ---- BACKUP-PANEL-M4 — an edit starts from the stored task ------------------

SECTIONS.push(['M4', async () => {
  const STALE = TASK
  const FRESH = { ...TASK, retention: { keepLast: 9 }, schedule: 'weekly', limitNofile: 4096 }
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: FRESH } } }))
  let A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, STALE)
  await settle()
  let ed = lastWindow()
  ok('M4: the edit re-read the task when it opened', state.gets.includes(`/backup/tasks/${TASK.name}`), state.gets.join(' '))
  eq('M4: the form shows the STORED keep, not the grid\'s', ed.down('#keepLast').getValue(), 9)
  let body = await submitAndBody(ed)
  eq('M4: an untouched Save sends the stored retention', body && body.retention, { keepLast: 9 })
  eq('M4: ...the stored schedule', body && body.schedule, 'weekly')
  eq('M4: ...and the stored LimitNOFILE (no control shows it)', body && body.limitNofile, 4096)
  ok('M4: no read-failure note on a good read', !(ed.down('#taskReadNote') && ed.down('#taskReadNote').hidden === false))

  // The task is gone: no dialog to save it back into existence.
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: httpError(404, `Backup task '${TASK.name}' not found`) }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, STALE)
  await settle()
  eq('M4: a deleted task opens no edit dialog', state.windows.length, 0)
  ok('M4: ...and says it is gone', state.alerts.some(a => /no longer exists/.test(a.msg)), JSON.stringify(state.alerts))

  // The read failed (coordinator ruling: fail CLOSED): no dialog on the
  // list's copy; an alert says the task could not be read, with the reason.
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: httpError(500, 'daemon busy') }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, STALE)
  await settle()
  eq('M4: a failed re-read opens no edit dialog', state.windows.length, 0)
  ok('M4: ...and says the task could not be read, with the reason',
    state.alerts.some(a => /Could not read the backup task/.test(a.msg) && /daemon busy/.test(a.msg)),
    JSON.stringify(state.alerts))

  // The revision: read at open, sent on the PUT; a daemon that sends none
  // gets today's request.
  reset(baseRoutes({
    [`GET /backup/tasks/${TASK.name}`]: { data: { task: FRESH, revision: 'abc123' } },
    [`PUT /backup/tasks/${TASK.name}`]: { job: { id: 'j1' } },
  }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, STALE)
  await settle()
  ed = lastWindow()
  state.jobs.length = 0
  press(ed, 'taskSubmitBtn')
  await settle()
  eq('M4: Save is bound to the revision the dialog read',
    state.jobs.map(j => j.path), [`/backup/tasks/${TASK.name}?expectedRevision=abc123`])
  eq('M4: ...and its job is polled', state.polls.map(p => p.id), ['j1'])

  reset(baseRoutes({
    [`GET /backup/tasks/${TASK.name}`]: { data: { task: FRESH, revision: 'abc123' } },
    [`PUT /backup/tasks/${TASK.name}`]: (() => {
      const e = httpError(409, `Backup task '${TASK.name}' changed since it was read`)
      e.body = { error: { code: 'STATE_CHANGED', message: e.message } }
      return e
    })(),
  }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, STALE)
  await settle()
  ed = lastWindow()
  state.confirmAnswer = 'yes'
  state.gets.length = 0
  press(ed, 'taskSubmitBtn')
  await settle()
  const changed = state.confirms.find(c => /changed/.test(c.title || '') || /was changed/.test(c.msg))
  ok('M4: a 409 STATE_CHANGED says the task changed since the dialog opened', !!changed, JSON.stringify(state.confirms))
  ok('M4: ...offers to reload, and a yes re-reads the stored task into a fresh dialog',
    ed.destroyed === true && state.gets.includes(`/backup/tasks/${TASK.name}`) && lastWindow() !== ed,
    `${ed.destroyed} ${state.gets.join(' ')}`)
  ok('M4: ...never the generic failure alert', !state.alerts.length, JSON.stringify(state.alerts))

  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: FRESH } } }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, STALE)
  await settle()
  ed = lastWindow()
  state.jobs.length = 0
  press(ed, 'taskSubmitBtn')
  await settle()
  eq('M4: a daemon that sends no revision gets today\'s request', state.jobs.map(j => `${j.door} ${j.path}`),
    [`runJob /backup/tasks/${TASK.name}`])

  // Enable/Disable: a whole-task PUT, built from the stored task.
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: FRESH } } }))
  A = loadPanel()
  ok('M4: the toggle door is reachable', typeof A.backup.toggleTask === 'function')
  if (typeof A.backup.toggleTask === 'function') {
    const rec = makeRecord({ name: TASK.name, enabled: true, raw: STALE, repository: 'pbs-main' })
    A.backup.toggleTask(VIEW, NODE, rec)
    await settle()
    const put = state.jobs.find(j => j.method === 'put')
    ok('M4: the toggle PUT went out', !!put)
    eq('M4: the toggle carries the STORED retention', put && put.body.retention, { keepLast: 9 })
    eq('M4: ...the stored schedule', put && put.body.schedule, 'weekly')
    eq('M4: ...and flips enabled as the operator asked', put && put.body.enabled, false)

    // Another admin CLEARED the namespace; this grid row is stale.
    const CLEARED = { ...TASK }
    delete CLEARED.namespace
    reset(baseRoutes({
      [`GET /backup/tasks/${TASK.name}`]: { data: { task: CLEARED, revision: 'r9' } },
      [`PUT /backup/tasks/${TASK.name}`]: { job: { id: 'j2' } },
    }))
    A = loadPanel()
    A.backup.toggleTask(VIEW, NODE, makeRecord({ name: TASK.name, enabled: true, raw: STALE, namespace: 'anas/pictures', repository: 'pbs-main' }))
    await settle()
    const put2 = state.jobs.find(j => j.method === 'put')
    ok('M4: a namespace another admin cleared is not re-instated by a toggle from a stale row',
      !!put2 && !('namespace' in put2.body), JSON.stringify(put2 && put2.body))
    eq('M4: the toggle is bound to the revision it read', put2 && put2.path, `/backup/tasks/${TASK.name}?expectedRevision=r9`)

    for (const [label, err] of [['404', httpError(404, 'not found')], ['500', httpError(500, 'daemon busy')]]) {
      reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: err }))
      A = loadPanel()
      A.backup.toggleTask(VIEW, NODE, makeRecord({ name: TASK.name, enabled: true, raw: STALE }))
      await settle()
      eq(`M4: a toggle whose re-read failed (${label}) sends nothing`, state.jobs.length, 0)
      ok(`M4: ...and says why (${label})`, state.alerts.length === 1 && /Nothing was changed/.test(state.alerts[0].msg),
        JSON.stringify(state.alerts))
    }
  }
}])

// ---- BACKUP-PANEL-L8 / INVENTED-STATE-L14 — a Test result is never invented --

async function openReposGrid(routes) {
  reset(baseRoutes(routes))
  const A = loadPanel()
  A.backup.openRepos(NODE)
  await settle()
  const mgr = lastWindow()
  const grid = mgr.down('#reposGrid')
  return { A, mgr, grid }
}

function testChipOf(grid, rec) {
  const col = grid.columns.find(c => c.dataIndex === 'testStage')
  return col.renderer(rec.get('testStage'), {}, rec)
}

async function openRepoDialog(mgr, existingRow) {
  if (existingRow === undefined) {
    press(mgr, 'anas-btn-backup-repo-add')
  }
  else {
    mgr.down('#reposGrid').selectRow(existingRow)
    press(mgr, 'repoEdit')
  }
  await settle()
  return lastWindow()
}

function testAreaText(win) {
  return allCmps(win.down('#testResult')).map(c => c.html || '').join(' ').replace(/<[^>]+>/g, ' ')
}

SECTIONS.push(['L8', async () => {
  // The manager grid's Test, by name.
  for (const [label, routeValue, want, notWant] of [
    ['a request error', httpError(500, 'repo registry locked'), /could not test/, /^tcp$|>tcp</],
    ['an answer with no stage', { data: {} }, /no result/, />ok</],
  ]) {
    const { mgr, grid } = await openReposGrid({ 'POST /backup/repos/test': routeValue })
    const rec = grid.selectRow(0)
    press(mgr, 'repoTest')
    await settle()
    const chip = testChipOf(grid, rec)
    ok(`L8 grid (${label}): the chip says what happened`, want.test(chip), chip)
    ok(`L8 grid (${label}): ...never a stage that did not happen`, !notWant.test(chip) && rec.get('testStage') !== 'tcp'
      && rec.get('testStage') !== 'ok', `${rec.get('testStage')} ${chip}`)
    if (label === 'a request error') {
      ok('L8 grid: the reason rides the chip\'s tooltip', /repo registry locked/.test(chip), chip)
    }
  }

  // The repository dialog's Test connection.
  for (const [label, routeValue, want, notWant] of [
    ['a request error', httpError(403, 'permission check failed'), /Could not run the test: permission check failed/, /cannot reach the host/],
    ['an answer with no stage', { data: {} }, /did not report a result/, /you can save|cannot reach the host/],
  ]) {
    const { mgr } = await openReposGrid({ 'POST /backup/repos/test': routeValue })
    const dlg = await openRepoDialog(mgr)
    dlg.down('#host').setValue('pbs.example')
    dlg.down('#datastore').setValue('store1')
    byCls(dlg, 'anas-btn-backup-repo-testconn').handler()
    await settle()
    const text = testAreaText(dlg)
    ok(`L8 dialog (${label}): says what happened`, want.test(text), text)
    ok(`L8 dialog (${label}): never a diagnosis it did not make`, !notWant.test(text), text)
  }

  // The save-time namespace check: an answer with no stage verified nothing.
  reset(baseRoutes({ 'POST /backup/repos/test': { data: {} } }))
  const A = loadPanel()
  const wiz = await openWizard(A)
  wiz.down('#name').setValue('nsx')
  wiz.down('#namespace').setValue('some-ns')
  state.confirms.length = 0
  await submitAndBody(wiz)
  ok('INVENTED-STATE-L14: a namespace check with no stage is not a verified namespace',
    state.confirms.some(c => /Could not verify the namespace/.test(c.msg)), JSON.stringify(state.confirms))
}])

// ---- BACKUP-PANEL-L7 — a new auth style or identity needs its own secret -----

SECTIONS.push(['L7', async () => {
  let { mgr } = await openReposGrid()
  let dlg = await openRepoDialog(mgr, 0)
  ok('L7: the edit dialog opened on the token repo', /Edit Repository/.test(dlg.title || ''), dlg.title)
  dlg.down('#authGroup').setValue({ authType: 'password' })
  dlg.down('#username').setValue('root@pam')
  state.jobs.length = 0
  state.posts.length = 0
  byCls(dlg, 'anas-btn-backup-repo-testconn').handler()
  await settle()
  ok('L7: Test does not run the stored TOKEN secret as a password',
    !state.posts.some(p => p.path === '/backup/repos/test'), JSON.stringify(state.posts))
  ok('L7: ...and says the password is needed', /Enter the password/.test(testAreaText(dlg)), testAreaText(dlg))
  press(dlg, 'anas-btn-backup-repo-save')
  await settle()
  eq('L7: Save with a new auth style and a blank secret sends nothing', state.jobs.length, 0)
  ok('L7: ...and says why', state.alerts.some(a => /Enter the password/.test(a.msg)), JSON.stringify(state.alerts))
  dlg.down('#password').setValue('s3cret')
  press(dlg, 'anas-btn-backup-repo-save')
  await settle()
  eq('L7: with the new password it saves', state.jobs.length, 1)
  eq('L7: ...carrying it', state.jobs[0] && state.jobs[0].body.repo.secret, 's3cret')

  // A different token is a different secret too.
  ;({ mgr } = await openReposGrid())
  dlg = await openRepoDialog(mgr, 0)
  dlg.down('#tokenId').setValue('root@pam!other')
  state.jobs.length = 0
  press(dlg, 'anas-btn-backup-repo-save')
  await settle()
  eq('L7: a new token id with a blank secret sends nothing', state.jobs.length, 0)
  ok('L7: ...and asks for that token\'s secret', state.alerts.some(a => /token secret/.test(a.msg)), JSON.stringify(state.alerts))

  // Unchanged identity: blank still means "keep the stored secret".
  ;({ mgr } = await openReposGrid())
  dlg = await openRepoDialog(mgr, 0)
  dlg.down('#datastore').setValue('store9')
  state.jobs.length = 0
  press(dlg, 'anas-btn-backup-repo-save')
  await settle()
  eq('L7: an unchanged identity with a blank secret still saves (kept)', state.jobs.length, 1)
  ok('L7: ...with no secret key', state.jobs[0] && !('secret' in state.jobs[0].body.repo), JSON.stringify(state.jobs[0] && state.jobs[0].body))
}])

// ---- BACKUP-PANEL-L11, L12 — "This LUN" follows the source, and says why not --

const IQN = 'iqn.2026-08.anas:vmstore'
function lunDoorRoutes(extra) {
  return baseRoutes({
    'GET /backup/repos/pbs-main/groups': {
      data: {
        verdict: 'ok',
        groups: [
          { group: 'host/lun-aaaa-0000', backupId: 'lun-aaaa-0000' },
          { group: 'host/lun-bbbb-1111', backupId: 'lun-bbbb-1111' },
          { group: 'host/other', backupId: 'other' },
        ],
      },
    },
    'GET /iscsi/targets': { data: { targets: [{ iqn: IQN, name: 'vmstore', ownership: 'anas' }] } },
    [`GET /iscsi/targets/${encodeURIComponent(IQN)}`]: {
      data: {
        luns: [
          { index: 0, name: 'vmdisk0', kind: 'zvol', size: 1024, serial: 'aaaa-0000', backingPath: '/dev/zvol/tank/vol0', backingExists: true },
          { index: 1, name: 'vmdisk1', kind: 'zvol', size: 2048, serial: 'bbbb-1111', backingPath: '/dev/zvol/tank/vol1', backingExists: true },
        ],
      },
    },
    ...extra,
  })
}
const LUN0_DOOR = { lun: { targetIqn: IQN, index: 0, serial: 'aaaa-0000', name: 'vmdisk0' } }
const inPlaceRadio = win => win.down('#restoreDest').childCmps().find(k => k.inputValue === 'inPlace')

SECTIONS.push(['L11', async () => {
  reset(lunDoorRoutes())
  const A = loadPanel()
  const win = A.backup.openRestoreDialog(VIEW, NODE, LUN0_DOOR)
  await settle()
  eq('L11: the LUN door found the LUN\'s own group', win.down('#restoreGroup').getValue(), 'host/lun-aaaa-0000')
  await pickSnapshot(win, 'host/lun-aaaa-0000/2026-11-01T00:00:00Z', 'host/lun-aaaa-0000', [{ archive: 'disk.img', kind: 'img', size: 1024 }])
  ok('L11: on the door\'s own source, This LUN is the door\'s LUN',
    /\/dev\/zvol\/tank\/vol0/.test(win.down('#restoreTargetPath').getValue() || ''), win.down('#restoreTargetPath').getValue())

  // Change source to a group that is not a LUN's: This LUN no longer applies.
  press(win, 'restoreChangeSource')
  await settle()
  win.down('#restoreGroup').setValue('host/other')
  await settle()
  await pickSnapshot(win, 'host/other/2026-11-01T00:00:00Z', 'host/other', [{ archive: 'disk.img', kind: 'img', size: 1024 }])
  eq('L11: another group\'s image does not resolve to the door\'s LUN', win.down('#restoreTargetPath').getValue(), '')
  eq('L11: ...so This LUN is off', inPlaceRadio(win).disabled, true)
  eq('L11: ...and the destination is a new LUN', win.down('#restoreDest').getValue(), { restoreDest: 'newLun' })

  // Change source to ANOTHER LUN's group: This LUN is THAT LUN (its serial).
  win.down('#restoreGroup').setValue('host/lun-bbbb-1111')
  await settle()
  await pickSnapshot(win, 'host/lun-bbbb-1111/2026-11-01T00:00:00Z', 'host/lun-bbbb-1111', [{ archive: 'disk.img', kind: 'img', size: 2048 }])
  ok('L11: another LUN\'s group resolves to THAT LUN, never the door\'s',
    /\/dev\/zvol\/tank\/vol1/.test(win.down('#restoreTargetPath').getValue() || ''), win.down('#restoreTargetPath').getValue())

  // Back to the door's own group: its LUN again.
  win.down('#restoreGroup').setValue('host/lun-aaaa-0000')
  await settle()
  await pickSnapshot(win, 'host/lun-aaaa-0000/2026-11-01T00:00:00Z', 'host/lun-aaaa-0000', [{ archive: 'disk.img', kind: 'img', size: 1024 }])
  ok('L11: back on the door\'s source, the door\'s LUN again',
    /\/dev\/zvol\/tank\/vol0/.test(win.down('#restoreTargetPath').getValue() || ''), win.down('#restoreTargetPath').getValue())
}])

SECTIONS.push(['L12', async () => {
  for (const [label, routes] of [
    ['the target list', { 'GET /iscsi/targets': httpError(500, 'iscsi read failed') }],
    ['a target\'s LUNs', { [`GET /iscsi/targets/${encodeURIComponent(IQN)}`]: httpError(500, 'iscsi read failed') }],
  ]) {
    reset(lunDoorRoutes(routes))
    const A = loadPanel()
    const win = A.backup.openRestoreDialog(VIEW, NODE, LUN0_DOOR)
    await settle()
    await pickSnapshot(win, 'host/lun-aaaa-0000/2026-11-01T00:00:00Z', 'host/lun-aaaa-0000', [{ archive: 'disk.img', kind: 'img', size: 1024 }])
    eq(`L12 (${label}): This LUN is off when the LUN list could not be read`, inPlaceRadio(win).disabled, true)
    const note = win.down('#restoreInPlaceNote').html || ''
    ok(`L12 (${label}): ...and the dialog says the read failed, with the reason`,
      /Could not read this node(&#39;|')s LUN list/.test(note) && /iscsi read failed/.test(note), note)
  }
  // The new-LUN target list could not be read: the verdict says so, not "pick a target".
  {
    reset(lunDoorRoutes({ 'GET /iscsi/targets': httpError(500, 'iscsi read failed') }))
    const A = loadPanel()
    const win = A.backup.openRestoreDialog(VIEW, NODE, LUN0_DOOR)
    await settle()
    await pickSnapshot(win, 'host/lun-aaaa-0000/2026-11-01T00:00:00Z', 'host/lun-aaaa-0000', [{ archive: 'disk.img', kind: 'img', size: 1024 }])
    win.down('#newLunName').setValue('restored')
    await settle()
    const verdict = win.down('#newLunVerdict').html || ''
    ok('L12 class: an unreadable target list is said on the new-LUN verdict',
      /Could not list this node(&#39;|')s iSCSI targets/.test(verdict) && /iscsi read failed/.test(verdict), verdict)
  }
  // A list that answered and holds no match says nothing of a failure.
  reset(lunDoorRoutes({ [`GET /iscsi/targets/${encodeURIComponent(IQN)}`]: { data: { luns: [] } } }))
  const A = loadPanel()
  const win = A.backup.openRestoreDialog(VIEW, NODE, LUN0_DOOR)
  await settle()
  await pickSnapshot(win, 'host/lun-aaaa-0000/2026-11-01T00:00:00Z', 'host/lun-aaaa-0000', [{ archive: 'disk.img', kind: 'img', size: 1024 }])
  ok('L12: an answered list claims no read failure', !/Could not read/.test(win.down('#restoreInPlaceNote').html || ''),
    win.down('#restoreInPlaceNote').html)
}])

// ---- cr3 follow-up — the task list and the save-time path check never read
//      a failed read as empty / fine --------------------------------------------

async function openView(A) {
  const view = makeComponent(A.views.backup.factory(NODE), null)
  view.fireEvent('afterrender', view)
  await settle()
  return view
}

SECTIONS.push(['tasks-read', async () => {
  const routes = baseRoutes({ 'GET /backup/tasks': httpError(500, 'units unreadable') })
  reset(routes)
  const A = loadPanel()
  const view = await openView(A)
  const grid = view.down('#backupGrid')
  const note = view.down('#backupLoadNote') || { hidden: true, html: '(no load note in the view)' }
  eq('tasks-read: a failed first read shows no rows', grid.getStore().getCount(), 0)
  ok('tasks-read: the view says the list could not be read, with the reason',
    note.hidden === false && /Could not read the backup tasks: units unreadable/.test(note.html || ''), note.html)
  ok('tasks-read: the empty grid never reads "No backup tasks defined"',
    !/No backup tasks defined/.test(grid.getView().emptyText) && /could not be read/.test(grid.getView().emptyText),
    grid.getView().emptyText)

  routes['GET /backup/tasks'] = { data: [{ task: TASK, lastRunResult: 'success' }] }
  A.backup.reload(view, NODE)
  await settle()
  eq('tasks-read: a good read loads the rows', grid.getStore().getCount(), 1)
  ok('tasks-read: ...and retires the failure line', note.hidden === true, note.html)
  ok('tasks-read: ...and the grid\'s own empty sentence returns', /No backup tasks defined/.test(grid.getView().emptyText),
    grid.getView().emptyText)

  routes['GET /backup/tasks'] = httpError(500, 'units unreadable')
  A.backup.reload(view, NODE)
  await settle()
  eq('tasks-read: a later failed read KEEPS the rows it had', grid.getStore().getCount(), 1)
  ok('tasks-read: ...and marks them as the last list read, possibly out of date',
    note.hidden === false && /last list that was read/.test(note.html || '') && /out of date/.test(note.html || ''),
    note.html)
}])

// ---- BACKUP-PANEL-M1 (review 3) — the home is STAMPED with its source -------
//
// Ported from the third review's probes (t/review3/walk.part.mjs, directed.mjs):
// the doors, the actions an operator can take, and the judge. The invariant
// (the stamp rule): no Restore body with mode inPlace whose path was filled or
// typed under a different (repository, namespace, group, archive) than the
// body names.
// Invariant after every Restore press (files half):
//   target.mode === 'inPlace' =>
//     (a) body.task set: repo/ns/snapshot-group are the task's own, and the path is
//         the task's home for THIS archive or a home typed for this source, or
//     (b) no task: target.path is a value the operator TYPED for this source
//         (semantic: typed while repo/ns/group/archive were what the body names;
//         strict: no source/archive change at all since it was typed).
// Image half: a body with `lun` names the LUN the snapshot's group maps to
// (lun-<serial>), or the door's own LUN while the source is the door's own.

const IQN3 = 'iqn.2026-08.anas:vmstore'
const T3 = {
  name: 'nightly-pictures', repository: 'pbs-main', namespace: 'anas/pictures', backupId: 'pictures',
  archives: [{ name: 'data', path: '/mnt/pictures', excludes: [] }, { name: 'docs', path: '/srv/docs', excludes: [] }],
  schedule: 'daily', enabled: true,
}
const HOMES = { data: '/mnt/pictures', docs: '/srv/docs' }
const GROUPS = { data: { verdict: 'ok', groups: [
  { group: 'host/pictures', backupId: 'pictures' }, { group: 'host/other', backupId: 'other' },
  { group: 'host/lun-aaaa-0000', backupId: 'lun-aaaa-0000' }, { group: 'host/lun-bbbb-1111', backupId: 'lun-bbbb-1111' }] } }
function walkRoutes() {
  return baseRoutes({
    'GET /backup/repos/pbs-main/groups': GROUPS,
    'GET /backup/repos/pbs-ns/groups': GROUPS,
    [`GET /backup/tasks/${T3.name}`]: { data: { task: T3 } },
    'GET /iscsi/targets': { data: { targets: [{ iqn: IQN3, name: 'vmstore', ownership: 'anas' }] } },
    [`GET /iscsi/targets/${encodeURIComponent(IQN3)}`]: { data: { luns: [
      { index: 0, name: 'vmdisk0', kind: 'zvol', size: 1024, serial: 'aaaa-0000', backingPath: '/dev/zvol/tank/vol0', backingExists: true },
      { index: 1, name: 'vmdisk1', kind: 'zvol', size: 2048, serial: 'bbbb-1111', backingPath: '/dev/zvol/tank/vol1', backingExists: true }] } },
    'GET /iscsi/backing-choices': { data: [] },
  })
}
const DOORS = {
  repo: { prefill: () => ({}), own: { repo: 'pbs-main', ns: '', group: 'host/other' }, task: '' },
  task: { prefill: () => ({ task: JSON.parse(JSON.stringify(T3)) }), own: { repo: 'pbs-main', ns: 'anas/pictures', group: 'host/pictures' }, task: T3.name },
  taskName: { prefill: () => ({ task: T3.name }), own: { repo: 'pbs-main', ns: 'anas/pictures', group: 'host/pictures' }, task: T3.name },
  lun: { prefill: () => ({ lun: { targetIqn: IQN3, index: 0, serial: 'aaaa-0000', name: 'vmdisk0' } }), own: { repo: 'pbs-main', ns: '', group: 'host/lun-aaaa-0000' }, task: '' },
}
const LUNSIZE = { 'host/lun-aaaa-0000': 1024, 'host/lun-bbbb-1111': 2048 }
const ARCH = {
  one: () => [{ archive: 'data.pxar', kind: 'pxar', size: 10 }],
  multi: () => [{ archive: 'data.pxar', kind: 'pxar', size: 10 }, { archive: 'docs.pxar', kind: 'pxar', size: 5 }, { archive: 'data__sub.pxar', kind: 'pxar', size: 3 }],
  docs: () => [{ archive: 'docs.pxar', kind: 'pxar', size: 5 }],
  mixed: g => [{ archive: 'data.pxar', kind: 'pxar', size: 10 }, { archive: 'disk.img', kind: 'img', size: LUNSIZE[g] || 1024 }],
  img: g => [{ archive: 'disk.img', kind: 'img', size: LUNSIZE[g] || 1024 }],
  none: () => [],
}
const vis = (win, sel) => { const c = win.down(sel); if (!c) return false; let p = c; while (p) { if (p.hidden) return false; p = p.parent } return true }
const groupOfSnap = s => { const m = /^([^/]+\/[^/]+)\//.exec(s || ''); return m ? m[1] : '' }

function srcTuple(win, W) {
  const snap = (win.down('#restoreSnapshot').getValue() || '').trim()
  let g = groupOfSnap(snap)
  if (!g) g = win._group || ''
  return { repo: (win.down('#restoreRepo').getValue() || '').trim(), ns: (win.down('#restoreNs').getValue() || '').trim(), group: g, archive: (win.down('#restoreArchive').getValue() || '').trim() }
}

const ACTIONS = {}
for (const k of Object.keys(ARCH)) {
  ACTIONS['snap:' + k] = async (W) => {
    const win = W.win
    const n0 = state.snapPickers.length
    press(win, 'restoreSnapPick'); await settle(4)
    if (state.snapPickers.length === n0) return false
    const cfg = state.snapPickers[state.snapPickers.length - 1]
    const group = cfg.task ? W.door.own.group : cfg.group
    W.pickN = (W.pickN || 0) + 1
    cfg.onSelect({ snapshot: `${group}/2026-11-0${1 + (W.pickN % 2)}T00:00:00Z`, group, archives: ARCH[k](group) })
    await settle(6)
    return true
  }
}
for (const a of ['data.pxar', 'docs.pxar', 'data__sub.pxar', 'disk.img']) {
  ACTIONS['arch:' + a] = async (W) => {
    const c = W.win.down('#restoreArchive')
    if (!c.getStore().getRange().some(r => r.get('archive') === a)) return false
    if (c.getValue() === a) return false
    c.setValue(a); await settle(6); return true
  }
}
ACTIONS['files:file'] = async (W) => {
  if (!vis(W.win, '#restoreFilesPick')) return false
  const n0 = state.pathPickers.length
  press(W.win, 'restoreFilesPick'); await settle(2)
  if (state.pathPickers.length === n0) return false
  state.pathPickers[state.pathPickers.length - 1].onSelect(['/a.txt'], [{ path: '/a.txt', type: 'file' }]); await settle(2)
  return true
}
ACTIONS['files:dir'] = async (W) => {
  if (!vis(W.win, '#restoreFilesPick')) return false
  const n0 = state.pathPickers.length
  press(W.win, 'restoreFilesPick'); await settle(2)
  if (state.pathPickers.length === n0) return false
  state.pathPickers[state.pathPickers.length - 1].onSelect(['/sub'], [{ path: '/sub', type: 'directory' }]); await settle(2)
  return true
}
ACTIONS['inPlace'] = async (W) => {
  const g = W.win.down('#restoreTargetKind')
  if (!vis(W.win, '#restoreTargetKind')) return false
  const r = g.childCmps().find(k => k.inputValue === 'inPlace')
  if (r.disabled || r.checked) return false
  g.setValue({ restoreTarget: 'inPlace' }); await settle(2); return true
}
ACTIONS['elsewhere'] = async (W) => {
  const g = W.win.down('#restoreTargetKind')
  if (!vis(W.win, '#restoreTargetKind')) return false
  g.setValue({ restoreTarget: 'newLocation' }); await settle(2)
  W.win.down('#restoreNewLocation').setValue('/restore/x'); await settle(2); return true
}
for (const [k, v] of [['home:T', '/typed/T'], ['home:A', '/mnt/pictures'], ['home:clear', '']]) {
  ACTIONS[k] = async (W) => {
    if (!vis(W.win, '#restoreHome')) return false
    const f = W.win.down('#restoreHome')
    if (f.getValue() === v) return false
    f.setValue(v); await settle(2)
    W.typed = v ? { value: v, gen: W.gen, tuple: srcTuple(W.win, W) } : null
    return true
  }
}
ACTIONS['changeSource'] = async (W) => {
  const b = W.win.down('#restoreChangeSource')
  if (!b || W.win._sourceExpanded) return false
  press(W.win, 'restoreChangeSource'); await settle(6); return true
}
for (const [k, sel, val] of [['group:other', '#restoreGroup', 'host/other'], ['group:own', '#restoreGroup', null], ['group:lunB', '#restoreGroup', 'host/lun-bbbb-1111'],
  ['repo:ns', '#restoreRepo', 'pbs-ns'], ['repo:own', '#restoreRepo', null], ['ns:x', '#restoreNs', 'x'], ['ns:own', '#restoreNs', null]]) {
  ACTIONS[k] = async (W) => {
    if (!vis(W.win, sel)) return false
    const f = W.win.down(sel)
    const v = val !== null ? val : W.door.own[sel === '#restoreGroup' ? 'group' : sel === '#restoreRepo' ? 'repo' : 'ns']
    if (f.getValue() === v) return false
    f.setValue(v); await settle(6); return true
  }
}
ACTIONS['snap:typed'] = async (W) => {
  const f = W.win.down('#restoreSnapshot')
  const v = 'host/other/2026-11-09T00:00:00Z'
  if (f.getValue() === v) return false
  f.setValue(v); await settle(2); return true
}
ACTIONS['snap:typedOwn'] = async (W) => {
  const f = W.win.down('#restoreSnapshot')
  const v = W.door.own.group + '/2026-11-08T00:00:00Z'
  if (f.getValue() === v) return false
  f.setValue(v); await settle(2); return true
}
ACTIONS['snap:erase'] = async (W) => {
  const f = W.win.down('#restoreSnapshot')
  if (!f.getValue()) return false
  f.setValue(''); await settle(2); return true
}
ACTIONS['reopen'] = async (W) => { await openW(W); return true }
const NAMES = Object.keys(ACTIONS)
const WEIGHT = { 'snap:one': 3, 'snap:multi': 2, 'snap:mixed': 2, 'snap:img': 1, 'snap:none': 3, 'snap:docs': 1, 'files:file': 4, 'files:dir': 3, inPlace: 5,
  'home:T': 2, 'home:A': 2, 'home:clear': 1, changeSource: 3, 'group:other': 2, 'group:own': 2, 'group:lunB': 1, 'repo:ns': 1, 'repo:own': 1, 'ns:x': 1, 'ns:own': 1,
  'arch:data.pxar': 2, 'arch:docs.pxar': 2, 'arch:data__sub.pxar': 1, 'arch:disk.img': 1, 'snap:typed': 1, 'snap:typedOwn': 1, 'snap:erase': 3, elsewhere: 1, reopen: 0.3 }
const WSUM = NAMES.reduce((a, n) => a + (WEIGHT[n] || 1), 0)
function pickWeighted(r) { let x = r() * WSUM; for (const n of NAMES) { x -= (WEIGHT[n] || 1); if (x <= 0) return n } return NAMES[NAMES.length - 1] }

async function openW(W) {
  if (W.win) W.win.close()
  W.win = W.A.backup.openRestoreDialog(VIEW, NODE, W.door.prefill())
  await settle(10)
  W.gen = 0; W.typed = null; W.tuple = srcTuple(W.win, W); W.pickN = 0
}

const findings = new Map()
let bodies = 0
let inPlaceBodies = 0
let imgInPlace = 0
const kinds = {}
function judge(W, body, seq) {
  bodies++
  const tag = (k, extra) => {
    const key = k + ' | ' + W.doorName
    kinds[key] = (kinds[key] || 0) + 1
    if (!findings.has(key) || findings.get(key).seq.length > seq.length) findings.set(key, { seq: seq.slice(), body, extra })
  }
  if (body.lun) {
    imgInPlace++
    const g = groupOfSnap(body.snapshot)
    const m = /^[^/]+\/lun-(.+)$/.exec(g)
    const serial = body.lun.index === 0 ? 'aaaa-0000' : body.lun.index === 1 ? 'bbbb-1111' : '?'
    const doorOwn = W.door.own
    const isDoorSrc = body.repo === doorOwn.repo && (body.ns || '') === doorOwn.ns && g === doorOwn.group
    if (m ? m[1] !== serial : !(isDoorSrc && W.doorName === 'lun' && body.lun.index === 0)) tag('IMG-LUN-MISMATCH', { serial, g })
    return
  }
  if (!body.target || body.target.mode !== 'inPlace') return
  inPlaceBodies++
  const path = body.target.path
  const bt = { repo: body.repo, ns: body.ns || '', group: groupOfSnap(body.snapshot), archive: body.archive }
  const ty = W.typed
  const typedSemantic = !!(ty && ty.value === path && ty.tuple.repo === bt.repo && ty.tuple.ns === bt.ns
    && (!ty.tuple.group || ty.tuple.group === bt.group) && (!ty.tuple.archive || ty.tuple.archive === bt.archive))
  const typedStrict = !!(ty && ty.value === path && ty.gen === W.gen)
  if (!path) { tag('INPLACE-NO-PATH', {}); return }
  if (body.task) {
    const own = DOORS.task.own
    const ownSrc = body.task === T3.name && bt.repo === own.repo && bt.ns === own.ns && bt.group === own.group
    if (!ownSrc) { tag('TASK-ON-FOREIGN-SOURCE', { bt }); return }
    const home = HOMES[bt.archive.replace(/\.pxar$/, '')]
    if (path !== home && !typedSemantic) tag('TASK-PATH-NOT-THIS-ARCHIVE-HOME', { home, path, typed: ty })
    return
  }
  if (!typedSemantic) tag('NO-TASK-PATH-NOT-TYPED-FOR-SOURCE', { path, typed: ty, bt })
  else if (!typedStrict) tag('borderline:typed-before-a-source-change(same tuple)', { path, typed: ty, bt })
}

async function pressRestore(W, seq, twice) {
  const n0 = state.jobs.length
  const btn = W.win.down('#restoreSubmit')
  if (btn.disabled) return
  press(W.win, 'restoreSubmit'); await settle(2)
  if (twice) { press(W.win, 'restoreSubmit'); await settle(2) }
  for (const j of state.jobs.slice(n0)) if (j.path === '/backup/restore') judge(W, j.body, seq)
}

// mulberry32
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }


async function runDirected(doorName, names) {
  reset(walkRoutes())
  const W = { A: loadPanel(), door: DOORS[doorName], doorName }
  await openW(W)
  const sent = []
  for (const n of names) {
    if (n === 'RESTORE') {
      const n0 = state.jobs.length
      if (!W.win.down('#restoreSubmit').disabled) {
        press(W.win, 'restoreSubmit')
        await settle(2)
      }
      sent.push(state.jobs.slice(n0).filter(j => j.path === '/backup/restore').map(j => j.body)[0] || null)
      continue
    }
    await ACTIONS[n](W)
  }
  return sent
}

SECTIONS.push(['M1-stamp', async () => {
  // The reviewer's sequences, on the three doors.
  const DIRECTED = [
    ['task', ['snap:one', 'files:file', 'inPlace', 'RESTORE', 'snap:none', 'snap:erase', 'changeSource', 'group:other', 'snap:one', 'files:file', 'RESTORE']],
    ['repo', ['group:own', 'snap:one', 'home:T', 'inPlace', 'files:file', 'RESTORE', 'snap:none', 'snap:erase', 'group:lunB', 'snap:one', 'files:file', 'RESTORE']],
    ['lun', ['snap:mixed', 'arch:data.pxar', 'home:T', 'inPlace', 'files:file', 'RESTORE', 'snap:none', 'snap:erase', 'changeSource', 'group:other', 'snap:one', 'files:file', 'RESTORE']],
  ]
  for (const [door, names] of DIRECTED) {
    const sent = await runDirected(door, names)
    const first = sent[0]
    const last = sent[sent.length - 1]
    ok(`M1-stamp (${door} door): on its own source the in-place restore goes out`,
      !!first && first.target.mode === 'inPlace', JSON.stringify(first))
    ok(`M1-stamp (${door} door): after the source changed, nothing restores in place over the old source's directory`,
      !last || last.target.mode !== 'inPlace', JSON.stringify(last))
  }

  // The seeded walk (property check): the stamp invariant over random
  // operator sequences on all four doors.
  const RUNS = Number(process.env.CR3_WALK_RUNS || 40)
  const LEN = 10
  for (const doorName of Object.keys(DOORS)) {
    const r = rng(20261114 + doorName.length)
    for (let run = 0; run < RUNS; run++) {
      reset(walkRoutes())
      const W = { A: loadPanel(), door: DOORS[doorName], doorName }
      await openW(W)
      const seq = []
      for (let step = 0; step < LEN; step++) {
        let name
        let done = false
        for (let tries = 0; tries < 12 && !done; tries++) {
          name = pickWeighted(r)
          done = await ACTIONS[name](W)
        }
        if (!done) {
          continue
        }
        seq.push(name)
        const now = srcTuple(W.win, W)
        if (JSON.stringify(now) !== JSON.stringify(W.tuple)) {
          W.gen++
          W.tuple = now
        }
        await pressRestore(W, seq, step % 3 === 2)
      }
    }
  }
  ok(`M1-stamp walk: restore bodies were produced (${bodies}, ${inPlaceBodies} in place)`, bodies >= RUNS && inPlaceBodies > 0,
    `${bodies} / ${inPlaceBodies}`)
  const hard = [...findings.entries()].filter(([k]) => !k.startsWith('borderline'))
  ok('M1-stamp walk: no in-place body names a path from another source',
    hard.length === 0, hard.map(([k, v]) => `${k}: ${v.seq.join(' > ')} => ${JSON.stringify(v.body)}`).join(' || '))
}])

// ---- The daemon's review — a door opened FROM A TASK names the task and its
//      STORED namespace exactly ('' is a value) -----------------------------------

SECTIONS.push(['task-ns', async () => {
  for (const [label, stored] of [['\'\'', ''], ['absent', undefined], ['\'x\'', 'x']]) {
    const T = { ...RESTORE_TASK, archives: [...RESTORE_TASK.archives, { name: 'disk', path: '/dev/zvol/tank/vol0', excludes: [], kind: 'img' }] }
    delete T.namespace
    if (stored !== undefined) { T.namespace = stored }
    const has = b => Object.prototype.hasOwnProperty.call(b, 'ns')
    const wantNs = b => (stored === undefined ? !has(b) : b.ns === stored)

    // Files restore.
    reset(baseRoutes())
    let A = loadPanel()
    let win = A.backup.openRestoreDialog(VIEW, NODE, { task: T })
    await settle()
    press(win, 'restoreSnapPick')
    await settle()
    const snapCfg = state.snapPickers[state.snapPickers.length - 1]
    eq(`task-ns (${label}): the point-in-time list is the TASK's own`, snapCfg && snapCfg.task, T.name)
    snapCfg.onSelect({ snapshot: SNAP_A, group: 'host/pictures', archives: SNAP_ARCHIVES })
    await settle()
    win.down('#restoreArchive').setValue('data.pxar')
    await settle()
    press(win, 'restoreFilesPick')
    await settle()
    const browseCfg = state.pathPickers[state.pathPickers.length - 1]
    eq(`task-ns (${label}): the browse names the task`, browseCfg.archive.task, T.name)
    ok(`task-ns (${label}): ...and its stored namespace exactly`,
      stored === undefined ? !browseCfg.archive.ns : browseCfg.archive.ns === stored, JSON.stringify(browseCfg.archive))
    browseCfg.onSelect(['/a.txt'], [{ path: '/a.txt', type: 'file' }])
    await settle()
    win.down('#restoreTargetKind').setValue({ restoreTarget: 'inPlace' })
    await settle()
    state.jobs.length = 0
    press(win, 'restoreSubmit')
    await settle()
    let body = state.jobs[0] && state.jobs[0].body
    ok(`task-ns (${label}): the files restore names the task`, !!body && body.task === T.name, JSON.stringify(body))
    ok(`task-ns (${label}): ...and its stored namespace exactly`, !!body && wantNs(body), JSON.stringify(body))

    // Image restore (as a new LUN — the task's own image).
    reset(baseRoutes({
      'GET /iscsi/targets': { data: { targets: [{ iqn: IQN, name: 'vmstore', ownership: 'anas' }] } },
      [`GET /iscsi/targets/${encodeURIComponent(IQN)}`]: { data: { luns: [] } },
    }))
    A = loadPanel()
    win = A.backup.openRestoreDialog(VIEW, NODE, { task: T })
    await settle()
    await pickSnapshot(win, SNAP_A, 'host/pictures', [{ archive: 'disk.img', kind: 'img', size: 1024 }])
    win.down('#restoreDest').setValue({ restoreDest: 'newLun' })
    win.down('#newLunName').setValue('restored')
    win.down('#newLunPool').getStore().loadData([{ name: 'tank', label: 'tank' }])
    win.down('#newLunPool').setValue('tank')
    await settle()
    state.jobs.length = 0
    press(win, 'restoreSubmit')
    await settle()
    body = state.jobs[0] && state.jobs[0].body
    ok(`task-ns (${label}): the image restore names the task`, !!body && body.task === T.name, JSON.stringify(body))
    ok(`task-ns (${label}): ...and its stored namespace exactly`, !!body && wantNs(body), JSON.stringify(body))

    // Prune preview of an untouched edit.
    const previews = []
    const ET = { ...TASK }
    delete ET.namespace
    if (stored !== undefined) { ET.namespace = stored }
    reset(baseRoutes({
      [`GET /backup/tasks/${ET.name}`]: { data: { task: ET } },
      [`POST /backup/tasks/${ET.name}/prune-preview`]: bb => { previews.push(bb); return { data: { verdict: 'ok', result: { snapshots: [] } } } },
    }))
    A = loadPanel()
    A.backup.openEditTask(VIEW, NODE, ET)
    await settle()
    press(lastWindow(), 'retentionPreview')
    await settle()
    const pv = previews.pop() || {}
    ok(`task-ns (${label}): an untouched Preview names the stored namespace exactly (never the repository's)`,
      stored === undefined ? !('namespace' in pv) : pv.namespace === stored, JSON.stringify(pv))
  }
}])

// ---- Review 2 — Save stays off until the job ends; a job's STATE_CHANGED; the
//      daemon lane's new fields ------------------------------------------------

SECTIONS.push(['review2', async () => {
  // (2) Save is disabled from the press until the job ends.
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: TASK } } }))
  let A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, TASK)
  await settle()
  let ed = lastWindow()
  const btn = ed.down('#taskSubmitBtn')
  press(ed, 'taskSubmitBtn')
  await settle()
  const job = state.jobs.find(j => j.door === 'runJob')
  ok('review2: the save was submitted', !!job)
  eq('review2: Save stays disabled while the job runs (no second PUT on the same read)', btn.disabled, true)
  press(ed, 'taskSubmitBtn')
  await settle()
  eq('review2: a second press while the job runs sends nothing', state.jobs.filter(j => j.door === 'runJob').length, 1)
  job.opts.onFailed({ status: 'failed', error: { code: 'EXEC_FAILED', message: 'systemctl said no' } })
  eq('review2: a failed job gives Save back', btn.disabled, false)
  ok('review2: ...and says the daemon\'s sentence', state.alerts.some(x => /systemctl said no/.test(x.msg)), JSON.stringify(state.alerts))

  // (3) A STATE_CHANGED raised by the JOB reaches the "Task changed" prompt.
  state.alerts.length = 0
  state.confirms.length = 0
  state.confirmAnswer = 'no'
  press(ed, 'taskSubmitBtn')
  await settle()
  const job2 = state.jobs.filter(j => j.door === 'runJob').pop()
  job2.opts.onFailed({ status: 'failed', error: { code: 'STATE_CHANGED', message: 'the unit changed under the update' } })
  ok('review2: a job-level STATE_CHANGED asks "Task changed", not the generic alert',
    state.confirms.some(c => /Task changed/.test(c.title)) && !state.alerts.length,
    JSON.stringify({ c: state.confirms, a: state.alerts }))
  eq('review2: ...and Save is given back when the reload is declined', btn.disabled, false)
  job2.opts.onLost(httpError(404, 'gone'))
  ok('review2: a lost job still alerts (its own modal is off for this door)', state.alerts.some(x => /Job lost/.test(x.title)),
    JSON.stringify(state.alerts))

  // The toggle: a job-level STATE_CHANGED offers the fresh list.
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: TASK } } }))
  A = loadPanel()
  A.backup.toggleTask(VIEW, NODE, makeRecord({ name: TASK.name, enabled: true, raw: TASK }))
  await settle()
  const tj = state.jobs.find(j => j.door === 'runJob')
  tj.opts.onFailed({ status: 'failed', error: { code: 'STATE_CHANGED', message: 'moved' } })
  ok('review2: the toggle\'s job-level STATE_CHANGED asks too', state.confirms.some(c => /Task changed/.test(c.title)),
    JSON.stringify(state.confirms))

  // The keep-what-is-omitted PUT: a blanked field is sent as null on an EDIT.
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: TASK } } }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, TASK)
  await settle()
  ed = lastWindow()
  let b = await submitAndBody(ed)
  ok('omit-keep: an untouched edit sends no null anywhere', !!b && !Object.values(b).some(v => v === null), JSON.stringify(b))
  for (const key of ['name', 'repository', 'namespace', 'backupId', 'archives', 'changeDetectionMode', 'retention', 'notify', 'schedule', 'enabled', 'limitNofile']) {
    eq(`omit-keep: an untouched edit sends ${key} as stored`, b && b[key], TASK[key])
  }
  A.backup.openEditTask(VIEW, NODE, TASK)
  await settle()
  ed = lastWindow()
  ed.down('#keepLast').setValue(null)
  b = await submitAndBody(ed)
  ok('omit-keep: an edit that blanks every keep sends retention: null (stop pruning)', !!b && b.retention === null, JSON.stringify(b))
  A.backup.openEditTask(VIEW, NODE, TASK)
  await settle()
  ed = lastWindow()
  ed.down('#namespace').setValue('')
  b = await submitAndBody(ed)
  ok('omit-keep: an edit that clears the namespace sends namespace: null', !!b && b.namespace === null, JSON.stringify(b))
  // A CREATE keeps omitting blanks.
  reset(baseRoutes())
  A = loadPanel()
  const wz = await openWizard(A)
  wz.down('#name').setValue('fresh')
  b = await submitAndBody(wz)
  ok('omit-keep: a create omits the blank namespace and retention (no nulls)',
    !!b && !('namespace' in b) && !('retention' in b) && !Object.values(b).some(v => v === null), JSON.stringify(b))

  // Review 3 (2): a submit that throws gives Save back and says why.
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: TASK } } }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, TASK)
  await settle()
  ed = lastWindow()
  const realRunJob = A.runJob
  A.runJob = () => { throw new Error('runJob exploded') }
  press(ed, 'taskSubmitBtn')
  await settle()
  eq('review3: a submit that throws gives Save back', ed.down('#taskSubmitBtn').disabled, false)
  ok('review3: ...and says why', state.alerts.some(x => /runJob exploded/.test(x.msg)), JSON.stringify(state.alerts))
  A.runJob = realRunJob

  // Review 3 (3): a job that ends cancelled gives Save back.
  state.jobs.length = 0
  press(ed, 'taskSubmitBtn')
  await settle()
  const cj = state.jobs.find(j => j.door === 'runJob')
  eq('review3: Save held while the job runs', ed.down('#taskSubmitBtn').disabled, true)
  cj.opts.onCancelled({ status: 'cancelled', result: { reason: 'cancelled by root@pam' } })
  eq('review3: a cancelled job gives Save back', ed.down('#taskSubmitBtn').disabled, false)
  ok('review3: ...and says it was cancelled', state.toasts.some(m => /cancelled by root@pam/.test(m)), state.toasts.join(' | '))

  // Review 3 (4): an untouched edit and the toggle send back EXACTLY what was
  // stored: a stated '' namespace (the datastore root), and excludes verbatim.
  const ROOT_NS = { ...TASK, namespace: '', archives: [{ name: 'pictures', path: '/mnt/pictures', excludes: [' **/*.tmp ', ''] }] }
  reset(baseRoutes({ [`GET /backup/tasks/${TASK.name}`]: { data: { task: ROOT_NS } } }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, ROOT_NS)
  await settle()
  b = await submitAndBody(lastWindow())
  ok('review3: an untouched edit sends a stored \'\' namespace back as \'\'', !!b && b.namespace === '', JSON.stringify(b && b.namespace))
  eq('review3: ...and the stored excludes verbatim', b && b.archives[0].excludes, [' **/*.tmp ', ''])
  A.backup.toggleTask(VIEW, NODE, makeRecord({ name: TASK.name, enabled: true, raw: ROOT_NS }))
  await settle()
  const tput = state.jobs.filter(j => j.method === 'put').pop()
  ok('review3: the toggle sends a stored \'\' namespace back as \'\'', !!tput && tput.body.namespace === '', JSON.stringify(tput && tput.body))
  eq('review3: ...and the stored excludes verbatim', tput && tput.body.archives[0].excludes, [' **/*.tmp ', ''])

  // (5) Group-list warnings (the daemon's charset gate), encoded.
  reset(baseRoutes({
    'GET /backup/repos/pbs-main/groups': { data: { verdict: 'ok', groups: [{ group: 'host/a', backupId: 'a' }], warnings: ['1 group refused: <b>name</b> outside PBS\'s charset'] } },
  }))
  A = loadPanel()
  const rd = A.backup.openRestoreDialog(VIEW, NODE, {})
  await settle()
  const gw = rd.down('#restoreGroupWarnings')
  ok('review2: the group list\'s warnings are shown', gw.hidden === false && /1 group refused/.test(gw.html || ''), gw.html)
  ok('review2: ...encoded', !/<b>/.test(gw.html || ''), gw.html)

  // credentialsSet: null reads "unknown", never "not set"; pveUnavailable is shown.
  const nullCreds = { data: { version: 1, pveUnavailable: 'storage.cfg could not be read: EACCES', repos: [{ ...REPOS.data.repos[0], credentialsSet: null }] } }
  reset(baseRoutes({ 'GET /backup/repos': nullCreds }))
  A = loadPanel()
  A.backup.openRepos(NODE)
  await settle()
  const mgr = lastWindow()
  const grid = mgr.down('#reposGrid')
  const authCol = grid.columns.find(c => c.dataIndex === 'authType')
  const authHtml = authCol.renderer('token', {}, grid.getStore().getAt(0))
  ok('review2: credentialsSet null reads unknown', /unknown/.test(authHtml) && !/no secret stored/.test(authHtml), authHtml)
  const pn = mgr.down('#reposPveNote')
  ok('review2: the pveUnavailable sentence is shown above the grid',
    pn.hidden === false && /storage.cfg could not be read: EACCES/.test(pn.html || ''), pn.html)

  // The daemon's R3, mirrored: a moved host with a blank secret needs the secret.
  const dlg = await openRepoDialog(mgr, 0)
  dlg.down('#host').setValue('pbs-new.example')
  state.jobs.length = 0
  state.posts.length = 0
  press(dlg, 'anas-btn-backup-repo-save')
  await settle()
  eq('review2: a moved host with a blank secret saves nothing', state.jobs.length, 0)
  ok('review2: ...and asks for the secret', state.alerts.some(x => /host or port changed/.test(x.msg)), JSON.stringify(state.alerts))
  byCls(dlg, 'anas-btn-backup-repo-testconn').handler()
  await settle()
  ok('review2: ...and Test does not send the stored secret to the new host',
    !state.posts.some(p => p.path === '/backup/repos/test'), JSON.stringify(state.posts))
}])

SECTIONS.push(['repos-read', async () => {
  const routes = baseRoutes({ 'GET /backup/repos': httpError(500, 'registry unreadable') })
  reset(routes)
  const A = loadPanel()
  A.backup.openRepos(NODE)
  await settle()
  const grid = lastWindow().down('#reposGrid')
  ok('repos-read: an unread registry never reads "No repositories registered"',
    !/No repositories registered/.test(grid.getView().emptyText) && /could not be read: registry unreadable/.test(grid.getView().emptyText),
    grid.getView().emptyText)
  routes['GET /backup/repos'] = REPOS
  lastWindow()._reload()
  await settle()
  ok('repos-read: a good read restores the grid\'s own sentence', /No repositories registered/.test(grid.getView().emptyText),
    grid.getView().emptyText)
}])

SECTIONS.push(['path-check', async () => {
  for (const [label, browse, want] of [
    ['a browse that failed', httpError(500, 'browse failed'), /\/etc \(browse failed\)/],
    ['an answer without exists', { data: {} }, /\/etc \(the node did not say whether it exists\)/],
  ]) {
    reset(baseRoutes({ 'GET /fs/browse': browse }))
    const A = loadPanel()
    const wiz = await openWizard(A)
    wiz.down('#name').setValue('chk')
    const body = await submitAndBody(wiz)
    const c = state.confirms.find(x => /could not be checked/.test(x.msg))
    ok(`path-check (${label}): the save-time check says the path could not be checked`, !!c && want.test(c.msg),
      JSON.stringify(state.confirms))
    ok(`path-check (${label}): ...and still lets the operator save (warn, never block)`, !!body)
  }
  reset(baseRoutes())
  const A = loadPanel()
  const wiz = await openWizard(A)
  wiz.down('#name').setValue('chk')
  await submitAndBody(wiz)
  eq('path-check: a path that was checked and exists raises no confirm', state.confirms.length, 0)
}])

// ---- BACKUP-PANEL-L10 — a failed repositories read is shown as failed -------

SECTIONS.push(['L10', async () => {
  reset(baseRoutes({ 'GET /backup/repos': httpError(500, 'registry unreadable') }))
  let A = loadPanel()
  A.backup.openNewTask(VIEW, NODE, null, null)
  await settle()
  eq('L10: no wizard opens on a repository list that could not be read', state.windows.length, 0)
  ok('L10: it never says "register a repository first"',
    !state.toasts.some(m => /Register a PBS repository first/.test(m)), state.toasts.join(' | '))
  ok('L10: it says the read failed, with the reason',
    state.alerts.some(a => /Could not read the backup repositories/.test(a.msg) && /registry unreadable/.test(a.msg)),
    JSON.stringify(state.alerts))

  reset(baseRoutes({
    'GET /backup/repos': httpError(500, 'registry unreadable'),
    [`GET /backup/tasks/${TASK.name}`]: { data: { task: TASK } },
  }))
  A = loadPanel()
  A.backup.openEditTask(VIEW, NODE, TASK)
  await settle()
  eq('L10: an edit does not open on an unreadable repository list either', state.windows.length, 0)

  // An empty list that the daemon really answered still points at Repositories.
  reset(baseRoutes({ 'GET /backup/repos': { data: { version: 0, repos: [] } } }))
  A = loadPanel()
  A.backup.openNewTask(VIEW, NODE, null, null)
  await settle()
  ok('L10: a real empty list still says to register one',
    state.toasts.some(m => /Register a PBS repository first/.test(m)), state.toasts.join(' | '))

  // The restore door: the repository list and the group list say they failed.
  reset(baseRoutes({ 'GET /backup/repos': httpError(500, 'registry unreadable') }))
  A = loadPanel()
  let win = A.backup.openRestoreDialog(VIEW, NODE, {})
  await settle()
  ok('L10: the restore door says the repository read failed',
    /Could not read the backup repositories: registry unreadable/.test(win.down('#restoreArchiveNote').html || ''),
    win.down('#restoreArchiveNote').html)
  reset(baseRoutes({ 'GET /backup/repos/pbs-main/groups': httpError(500, 'pbs unreachable') }))
  A = loadPanel()
  win = A.backup.openRestoreDialog(VIEW, NODE, {})
  await settle()
  ok('L10: the restore door says the group read failed',
    /Could not list the backup groups: pbs unreachable/.test(win.down('#restoreArchiveNote').html || ''),
    win.down('#restoreArchiveNote').html)
}])

for (const [name, fn] of SECTIONS) {
  try {
    await fn()
  }
  catch (e) {
    failures.push(`${name}: threw ${e && e.stack ? e.stack : e}`)
  }
}

if (failures.length) {
  console.error(`\n✖ ${failures.length} of ${checks} checks failed:\n`)
  for (const f of failures) { console.error(`  • ${f}`) }
  process.exit(1)
}
console.log(`✔ cr3 backup-panel: ${checks} checks passed`)
