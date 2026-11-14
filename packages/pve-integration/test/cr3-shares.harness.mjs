#!/usr/bin/env node
/*
 * ANAS — cr3.shares panel harness (the 2026-11-14 review, shares area).
 *
 * Loads the REAL 00-core.js (ANAS.enc, ANAS.t) and the shares-area panel
 * sources (12-picker.js, 14-permissions.js, 70-shares.js, 80-users.js) in a
 * vm sandbox with a recording Ext stub: every Ext.create() config is kept, so
 * the checks read the window titles, the grid renderers, the tooltip
 * attributes and the combo list templates the panels actually build.
 *
 * What it guards:
 *   1. Window titles are HTML: every data value in one is encoded
 *      (14-permissions ~:365, 70-shares edit/connect windows, 80-users).
 *   2. A value in a `data-qtip` is encoded for the attribute AND for the tip
 *      (twice): the point-in-time picker's snapshot id (from a PBS server) and
 *      the permissions editor's orphan tip.
 *   3. Every combo and tagfield whose rows carry a name from the node
 *      (getent accounts and groups, interfaces, addresses) renders its list
 *      (and a tagfield its tags) through an htmlEncode template.
 *   4. INVENTED-STATE-M6 / SHARES-L8: the Shares grid's Active column renders
 *      "unknown" when the daemon could not read the count (null or absent) —
 *      never 0 — and the real number otherwise.
 *   5. A share whose name ANAS cannot address (`unmanagedName`) is marked
 *      "not managed by ANAS" and offers no action.
 *   6. (fourth review D-E) The permissions editor marks a named row EDITED
 *      only when its level changes: opening and closing the level editor on
 *      the level shown keeps the row's live bits; choosing another level, or
 *      adding a principal that is already listed, writes it at its level.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const HOSTILE = '<img src=x onerror=alert(1)>&"'
const encode = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log('ok', label)
  }
  else {
    failures++
    console.error('FAIL:', label, detail === undefined ? '' : detail)
  }
}

// ---- A recording Ext -------------------------------------------------------

/** Every config handed to Ext.create, in order: { cls, cfg }. */
const created = []

/**
 * A component that answers anything: a property it does not hold is a no-op
 * method returning itself, so panel code that wires listeners, loads stores
 * and shows windows runs to the end without a real ExtJS.
 */
function component(cfg) {
  const target = function () {}
  target.cfg = cfg || {}
  target.own = {}
  const handler = {
    set(t, prop, value) {
      t.own[prop] = value
      return true
    },
    get(t, prop) {
      if (prop === 'cfg')
        return t.cfg
      if (prop in t.own)
        return t.own[prop]
      if (prop === 'then')
        return undefined
      if (prop === Symbol.toPrimitive)
        return () => ''
      if (prop === 'destroyed' || prop === 'destroying')
        return false
      if (prop === 'getSelection')
        return () => []
      if (prop === 'getValue')
        return () => ''
      if (prop in t.cfg && typeof t.cfg[prop] !== 'object')
        return t.cfg[prop]
      return proxy
    },
    apply() {
      return proxy
    },
  }
  const proxy = new Proxy(target, handler)
  return proxy
}

const Ext = {
  create(cls, cfg) {
    const obj = component(cfg)
    created.push({ cls, cfg: cfg || {}, obj })
    return obj
  },
  String: { htmlEncode: encode },
  Msg: { alert() {}, confirm() {} },
  isArray: Array.isArray,
  defer(fn) { fn() },
  ComponentQuery: { query: () => [] },
}

function load(files) {
  const win = { ANAS: { views: {} } }
  const sandbox = {
    window: win,
    console,
    Promise,
    Date,
    Ext,
    gettext: s => s,
    setTimeout: fn => { fn(); return 1 },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    document: { createElement: () => ({ style: {} }), head: { appendChild() {} }, getElementById: () => null },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(SRC, '00-core.js'), 'utf8'), sandbox, { filename: '00-core.js' })
  const ANAS = win.ANAS
  // The API never answers: these checks read what the panels BUILD.
  ANAS.api = new Proxy({}, { get: () => () => new Promise(() => {}) })
  ANAS.tbar = items => items
  // A read job that never answers (the archive listing).
  ANAS.readJob = () => ({})
  for (const f of files)
    vm.runInContext(readFileSync(join(SRC, f), 'utf8'), sandbox, { filename: f })
  return ANAS
}

/** Every object in a config tree (depth-first), arrays and nested items included. */
function walk(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node))
    return out
  seen.add(node)
  out.push(node)
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object')
      walk(v.cfg && typeof v === 'function' ? v.cfg : v, out, seen)
    else if (typeof v === 'function' && v.cfg)
      walk(v.cfg, out, seen)
  }
  return out
}

function rec(fields) {
  return { get: k => fields[k], data: fields }
}

// ---- 1-3: 14-permissions ----------------------------------------------------

{
  created.length = 0
  const ANAS = load(['14-permissions.js'])
  ANAS.permissions.open({ node: 'pve', accessPath: '/x/access', title: HOSTILE })
  const winCfg = created.find(c => c.cls === 'Ext.window.Window')
  check('permissions: the window title encodes the caller\'s raw name', winCfg && winCfg.cfg.title === `Permissions: ${encode(HOSTILE)}`, winCfg && winCfg.cfg.title)

  const nodes = created.flatMap(c => walk(c.cfg))
  const nameCombos = nodes.filter(n => n.displayField === 'name')
  check('permissions: every name combo is present (owner, group, add-name)', nameCombos.length >= 2, nameCombos.length)
  check('permissions: every name combo encodes its list', nameCombos.every(n => n.listConfig && /\{name:htmlEncode\}/.test(n.listConfig.tpl)))

  const nameCol = nodes.find(n => n.dataIndex === 'name' && typeof n.renderer === 'function' && n.text === 'Name')
  const meta = {}
  const html = nameCol && nameCol.renderer('1234', meta, rec({ kind: 'user', unresolved: true }))
  check('permissions: the orphan tip is encoded twice in data-qtip', typeof meta.tdAttr === 'string' && meta.tdAttr.includes('&amp;') === false && meta.tdAttr.startsWith('data-qtip="'), meta.tdAttr)
  check('permissions: an orphan name is encoded in the cell', nameCol && !String(nameCol.renderer(HOSTILE, {}, rec({ kind: 'user', unresolved: false }))).includes('<img'), html)
}

// ---- 6: the permissions editor's edited mark (fourth review D-E) -------------

{
  created.length = 0
  const ANAS = load(['14-permissions.js'])
  ANAS.permissions.open({ node: 'pve', accessPath: '/x/access', title: 't' })
  const nodes = created.flatMap(c => walk(c.cfg))
  /** A grid row that records what is set on it. */
  const row = (fields) => {
    const data = { ...fields }
    return {
      data,
      get: k => data[k],
      set(k, v) {
        if (k && typeof k === 'object')
          Object.assign(data, k)
        else
          data[k] = v
      },
    }
  }
  const editing = nodes.find(n => n.ptype === 'cellediting')
  const custom = row({ kind: 'user', name: '4242', level: 'none', perms: '--x', readLevel: 'none' })
  editing.listeners.edit(null, { field: 'level', record: custom, value: 'none', originalValue: 'none' })
  check('permissions: opening and closing the level editor leaves a custom row unedited (its bits are echoed)', custom.get('readLevel') === 'none', custom.data)
  editing.listeners.edit(null, { field: 'level', record: custom, value: 'read', originalValue: 'none' })
  check('permissions: choosing another level marks the row edited', custom.get('readLevel') === null, custom.data)

  // "Add user or group" for a principal already listed: written at the level chosen.
  const store = created.find(c => c.cls === 'Ext.data.Store' && Array.isArray(c.cfg.fields) && c.cfg.fields.includes('readLevel'))
  const listed = row({ kind: 'user', name: 'alice', level: 'read', perms: 'r--', readLevel: 'read' })
  store.obj.findBy = () => 0
  store.obj.getAt = () => listed
  const addBtn = nodes.find(n => n.itemId === 'addBtn')
  addBtn.handler()
  const addWin = created.find(c => c.cfg.cls === 'anas-win-access-add')
  const values = { '#kind': 'user', '#name': 'alice', '#level': 'read' }
  addWin.obj.down = sel => ({ getValue: () => values[sel] })
  const submit = walk(addWin.cfg).find(n => n.cls === 'anas-btn-access-add-submit')
  submit.handler()
  check('permissions: adding a principal already listed marks its row edited (written at the level chosen)', listed.get('readLevel') === null && listed.get('level') === 'read', listed.data)
}

// ---- 2: 12-picker (PBS-sourced strings) -------------------------------------

{
  created.length = 0
  const ANAS = load(['12-picker.js'])
  ANAS.snapshotPicker({ node: 'pve', title: 'Choose a point in time' })
  const nodes = created.flatMap(c => walk(c.cfg))
  const timeCol = nodes.find(n => n.dataIndex === 'backupTimeIso')
  const meta = {}
  const cell = timeCol.renderer(HOSTILE, meta, rec({ snapshot: HOSTILE }))
  check('picker: the PBS snapshot id is encoded twice in data-qtip', meta.tdAttr === `data-qtip="${encode(encode(HOSTILE))}"`, meta.tdAttr)
  check('picker: the point-in-time cell is encoded', cell === encode(HOSTILE), cell)
  const countCol = nodes.find(n => n.dataIndex === 'archiveCount')
  check('picker: a non-number archive count never renders raw', countCol && typeof countCol.renderer === 'function' && countCol.renderer(HOSTILE) === '', countCol && countCol.renderer)

  created.length = 0
  ANAS.pathPicker({ node: 'pve', mode: 'file', backend: 'archive', archive: { snapshot: 'host/x/2026-11-14T00:00:00Z', archive: 'root.pxar' }, title: 'Choose' })
  const tree = created.flatMap(c => walk(c.cfg)).find(n => n.xtype === 'treecolumn')
  const nameCell = tree.renderer(HOSTILE, {}, rec({ kind: 'symlink', target: HOSTILE }))
  check('picker: an archive entry name and its link target are encoded', !nameCell.includes('<img'), nameCell)
}

// ---- 1, 3, 4: 70-shares -----------------------------------------------------

{
  created.length = 0
  const ANAS = load(['70-shares.js'])
  const view = ANAS.views.shares.factory('pve')
  const nodes = [...walk(typeof view === 'function' ? view.cfg : view), ...created.flatMap(c => walk(c.cfg))]
  const active = nodes.find(n => n.dataIndex === 'activeConnections' && typeof n.renderer === 'function')
  const smb = v => active.renderer(v, {}, rec({ protocol: 'smb', activeConnections: v }))
  check('shares: an unread count (null) renders unknown, never 0', /unknown/.test(smb(null)) && !/>0</.test(smb(null)), smb(null))
  check('shares: an absent count (older daemon) renders unknown', /unknown/.test(smb(undefined)), smb(undefined))
  check('shares: a real 0 renders 0', smb(0) === '0', smb(0))
  check('shares: a real count renders the count', /3/.test(smb(3)), smb(3))

  // cr3.shares (review): a name ANAS cannot address is marked, and offers nothing.
  const nameCol = nodes.find(n => n.dataIndex === 'name' && typeof n.renderer === 'function' && n.text === 'Name')
  const marked = nameCol.renderer(' public', {}, rec({ protocol: 'smb', raw: { unmanagedName: true } }))
  check('shares: an unaddressable name is marked "not managed by ANAS"', /not managed by ANAS/.test(marked) && marked.startsWith(encode(' public')), marked)
  check('shares: a managed name carries no mark', !/not managed/.test(nameCol.renderer('media', {}, rec({ protocol: 'smb', raw: {} }))))
  const grid = nodes.find(n => n.listeners && typeof n.listeners.itemdblclick === 'function')
  let opened = 0
  const before = created.length
  grid.listeners.itemdblclick(null, rec({ protocol: 'smb', name: ' public', raw: { unmanagedName: true } }))
  opened = created.length - before
  check('shares: double-clicking an unmanaged share opens nothing', opened === 0, opened)

  // cr3.shares (second review): a list that could not be read is never an
  // empty grid — that half says so, and offers nothing.
  {
    const gridCfg = nodes.find(n => n.itemId === 'sharesGrid')
    const realApi = ANAS.api
    ANAS.api = { get: (_node, path) => path === '/shares/smb' ? Promise.reject(new Error('smbd timed out')) : Promise.resolve({ data: [] }) }
    let loaded = null
    const fakeGrid = { destroyed: false, destroying: false, setLoading() {}, getStore: () => ({ loadData(rows) { loaded = rows } }), down: () => null, getSelection: () => [] }
    gridCfg.listeners.afterrender.call(fakeGrid, fakeGrid)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setImmediate(r))
    ANAS.api = realApi
    check('shares: a failed SMB list renders one could-not-read row, never an empty grid', Array.isArray(loaded) && loaded.length === 1 && loaded[0].raw.readError === 'smbd timed out', JSON.stringify(loaded))
    const errRec = rec({ protocol: 'smb', ...loaded[0], raw: loaded[0].raw })
    const nameHtml = nameCol.renderer('', {}, errRec)
    check('shares: the could-not-read row says so, with the reason', /could not be read/.test(nameHtml) && /smbd timed out/.test(nameHtml), nameHtml)
    const before2 = created.length
    grid.listeners.itemdblclick(null, errRec)
    check('shares: the could-not-read row opens nothing', created.length === before2)
  }

  created.length = 0
  ANAS.shares.openSmbCreate('pve', {}, () => {})
  const smbNodes = created.flatMap(c => walk(c.cfg))
  const userTags = smbNodes.filter(n => n.displayField === 'name')
  check('shares: the valid-users tagfield encodes its list and its tags', userTags.length > 0 && userTags.every(n => n.listConfig && /htmlEncode/.test(n.listConfig.tpl) && (n.xtype !== 'tagfield' || /htmlEncode/.test(n.labelTpl))))
}

// ---- 1, 3: 80-users ---------------------------------------------------------

{
  const src = readFileSync(join(SRC, '80-users.js'), 'utf8')
  for (const title of ["t('Set SMB Password') + ': ' + enc(userName)", "t('Edit Groups') + ': ' + enc(userName)", "t('Group Members') + ': ' + enc(groupName)"])
    check(`users: the window title encodes the name (${title.split("'")[1]})`, src.includes(title))
  const combos = src.split("displayField: 'name',").length - 1
  const encoded = src.split("listConfig: encodedListConfig('name'),").length - 1
  check('users: every name combo/tagfield encodes its list', combos > 0 && combos === encoded, `${encoded}/${combos}`)
}

// ---- The panel-level structural rule: no raw data in a data-qtip -----------

for (const f of ['12-picker.js', '14-permissions.js', '70-shares.js', '80-users.js']) {
  const src = readFileSync(join(SRC, f), 'utf8')
  const single = src.match(/data-qtip="'\s*\+\s*enc\((?!enc\()/g) || []
  check(`${f}: every data-qtip value is encoded twice`, single.length === 0, single.length)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall cr3.shares panel checks passed')
