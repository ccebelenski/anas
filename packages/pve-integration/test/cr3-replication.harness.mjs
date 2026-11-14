#!/usr/bin/env node
/*
 * ANAS — cr3 replication panel harness (the 2026-11-14 review, area
 * `replication`).
 *
 * Loads the REAL 65-replication.js (with 00-core.js, 10-api.js and
 * 69-schedules-common.js, in bundle order) and checks:
 *
 *   • REPLICATION-M3: every combo in the file carries the encoding list
 *     template (settled in a browser on PVE 9.2: the DEFAULT template renders
 *     its display field as raw HTML), and the template encodes the field the
 *     combo displays;
 *   • the two dialog titles built from data go through enc();
 *   • L6 / INVENTED-STATE-M5: a null lag renders unknown, never "N behind";
 *   • REPLICATION-M1: a plan whose target already has the snapshot reads
 *     "Already on the target — nothing to send", never a FULL send;
 *   • a failed task-list or remotes load says so on the grid with the reason,
 *     keeps the rows it had (marked) and, with none, withholds the "No ..."
 *     empty text — a failed read is never an empty list.
 *
 *   node packages/pve-integration/test/cr3-replication.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const FILE = '65-replication.js'
const SOURCE = readFileSync(join(SRC, FILE), 'utf8')

let checks = 0
const failures = []
function ok(name, cond, detail) {
  checks++
  if (!cond) { failures.push(detail === undefined ? name : `${name} — ${detail}`) }
}

function htmlEncode(v) {
  return String(v).replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function permissive() {
  const fn = function () { return proxy }
  const proxy = new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) { return () => '' }
      if (key === 'then') { return undefined }
      if (key === 'String') { return { htmlEncode } }
      return proxy
    },
    apply() { return proxy },
    construct() { return proxy },
  })
  return proxy
}

function loadUi() {
  const doc = {
    hidden: false,
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    getElementsByTagName: () => [{ appendChild() {} }],
    createTextNode: text => ({ text }),
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  }
  const win = { document: doc }
  const sandbox = {
    window: win,
    document: doc,
    Ext: permissive(),
    console: { log() {}, warn() {}, error() {}, info() {} },
    Promise,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }
  for (const file of ['00-core.js', '10-api.js', '69-schedules-common.js', FILE])
    vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  return win.ANAS
}

const ANAS = loadUi()
const R = ANAS.replication || {}
const tick = () => new Promise(resolve => setImmediate(resolve))

// ---- M3: every combo encodes its list ---------------------------------------
ok('encodedList is exposed', typeof R.encodedList === 'function')
const tpl = R.encodedList ? R.encodedList('label').tpl : ''
ok('the template encodes the field', tpl.includes('{label:htmlEncode}'), tpl)
ok('the template never prints the raw field', !/\{label\}/.test(tpl), tpl)
const loc = R.locationComboCfg ? R.locationComboCfg() : {}
ok('the location combo (both dialogs) encodes its label', loc.listConfig && loc.listConfig.tpl.includes('{label:htmlEncode}'), JSON.stringify(loc.listConfig))

/** The object literal around index `i` (from its `{` to the matching `}`). */
function objectAround(text, i) {
  const start = text.lastIndexOf('{', i)
  let depth = 0
  for (let j = start; j < text.length; j++) {
    if (text[j] === '{') { depth++ }
    else if (text[j] === '}') {
      depth--
      if (depth === 0) { return text.slice(start, j + 1) }
    }
  }
  return ''
}

const COMBO_RE = /xtype: 'combobox'/g
let combos = 0
for (const m of SOURCE.matchAll(COMBO_RE)) {
  combos++
  const body = objectAround(SOURCE, m.index)
  const itemId = (/itemId: '([^']+)'/.exec(body) || [])[1] || `#${combos}`
  const display = (/displayField: '([^']+)'/.exec(body) || [])[1]
  const listed = (/listConfig: encodedList\('([^']+)'\)/.exec(body) || [])[1]
  ok(`combo ${itemId} carries the encoding list template`, listed !== undefined, body.slice(0, 200))
  ok(`combo ${itemId} encodes the field it displays`, listed === display, `display ${display}, encoded ${listed}`)
}
ok('every combo of the file was found (8: location, task source pool/dataset/target pool, once source pool/dataset/target pool/snapshot)', combos === 8, String(combos))

// ---- titles built from data -------------------------------------------------
ok('the Edit Remote title encodes the remote name', SOURCE.includes('enc(t(\'Edit Remote\') + \': \' + (r.name || \'\'))'))
ok('the Edit Replication Task title encodes the task name', SOURCE.includes('enc(t(\'Edit Replication Task\') + \': \' + (task.name || \'\'))'))
ok('no window title concatenates a raw value', !/title: isEdit \? \(t\(/.test(SOURCE))

// ---- L6: a null lag is unknown ----------------------------------------------
function rec(fields) {
  return { get: k => fields[k] }
}
ok('renderLag is exposed', typeof R.renderLag === 'function')
if (typeof R.renderLag === 'function') {
  const unknown = R.renderLag(null, {}, rec({ snapshotsBehind: null }))
  ok('a null lag never reads "behind"', !/behind/.test(unknown), unknown)
  ok('a null lag never reads "current"', !/current/.test(unknown), unknown)
  ok('a null lag says unknown in its tooltip', /title="unknown/.test(unknown), unknown)
  const behind = R.renderLag(3, {}, rec({ snapshotsBehind: 3 }))
  ok('a read lag of 3 still reads "3 behind"', />3 behind</.test(behind), behind)
}

// ---- M1: an up-to-date plan -------------------------------------------------
function fakeOnceWin() {
  const state = { html: null, submitDisabled: null, cls: [] }
  const planLine = {
    addCls(c) { state.cls.push(c) },
    removeCls() {},
    update(h) { state.html = h },
  }
  const submit = { setDisabled(d) { state.submitDisabled = d } }
  return { state, win: { down: q => (q === '#planLine' ? planLine : q === '#onceSubmit' ? submit : null) } }
}
ok('renderPlan is exposed', typeof R.renderPlan === 'function')
if (typeof R.renderPlan === 'function') {
  const { state, win } = fakeOnceWin()
  R.renderPlan(win, { mode: 'incremental', snapshot: 'S0', estimatedBytes: 0, targetExists: true, targetDiverged: false, upToDate: true })
  ok('an up-to-date plan reads "Already on the target"', /Already on the target/.test(state.html || ''), state.html)
  ok('...and "nothing to send"', /nothing to send/.test(state.html || ''), state.html)
  ok('...never a FULL send', !/FULL/.test(state.html || ''), state.html)
  ok('...and Replicate stays available (it settles nothing backwards)', state.submitDisabled === false)
  const older = fakeOnceWin()
  R.renderPlan(older.win, { mode: 'incremental', snapshot: 'S1', baseSnapshot: 'S0', estimatedBytes: 4096, targetExists: true, targetDiverged: false })
  ok('a plan without the field renders as before (Incremental, base)', /Incremental/.test(older.state.html || '') && /S0/.test(older.state.html || ''), older.state.html)
}

// ---- a failed load is not an empty list -------------------------------------
function fakeGrid(rowCount, emptyText) {
  const bar = { html: null, shown: false, update(h) { this.html = h }, show() { this.shown = true }, hide() { this.shown = false } }
  const view = { emptyText, opacity: null, refresh() {}, setStyle(_k, v) { this.opacity = v } }
  const calls = { loaded: null }
  const store = { getCount: () => rowCount, loadData(rows) { calls.loaded = rows }, findExact: () => -1, each() {} }
  const grid = {
    destroyed: false,
    destroying: false,
    setLoading() {},
    getStore: () => store,
    getView: () => view,
    down: q => (q === '#loadFail' ? bar : null),
    getSelectionModel: () => ({ getSelection: () => [], select() {} }),
    getSelection: () => [],
    addCls() {},
    removeCls() {},
  }
  return { grid, bar, view, calls }
}

async function withApi(answer, fn) {
  const saved = ANAS.api.get
  ANAS.api.get = () => answer()
  try { await fn() }
  finally { ANAS.api.get = saved }
}

const boom = () => Promise.reject(new Error('HTTP 500: could not read /etc/systemd/system'))

await withApi(boom, async () => {
  const g = fakeGrid(2, 'No replication tasks defined')
  R.reload(g.grid, 'node1', true)
  await tick()
  await tick()
  ok('tasks: a failed load keeps the rows the grid had', g.calls.loaded === null, JSON.stringify(g.calls.loaded))
  ok('tasks: the failure line is shown', g.bar.shown === true)
  ok('tasks: it names what failed and why', /The replication tasks could not be read: .*could not read \/etc\/systemd\/system/.test(g.bar.html || ''), g.bar.html)
  ok('tasks: it marks the kept rows as possibly out of date', /last successful read and may be out of date/.test(g.bar.html || ''), g.bar.html)
  ok('tasks: the kept rows are dimmed', g.view.opacity === '0.6', g.view.opacity)
})

await withApi(boom, async () => {
  const g = fakeGrid(0, 'No replication tasks defined')
  R.reload(g.grid, 'node1', true)
  await tick()
  await tick()
  ok('tasks: a failed FIRST load says the list is unknown, not empty', /the list is unknown, not empty/.test(g.bar.html || ''), g.bar.html)
  ok('tasks: ...and withholds "No replication tasks defined"', g.view.emptyText === '', g.view.emptyText)
  await withApi(() => Promise.resolve({ data: [] }), async () => {
    R.reload(g.grid, 'node1', true)
    await tick()
    await tick()
  })
  ok('tasks: the next good load hides the line', g.bar.shown === false)
  ok('tasks: ...and an empty answer reads "No replication tasks defined" again', g.view.emptyText === 'No replication tasks defined', g.view.emptyText)
})

await withApi(boom, async () => {
  const g = fakeGrid(0, 'No remotes registered')
  const win = { destroyed: false, destroying: false, down: q => (q === '#remotesGrid' ? g.grid : null) }
  ok('reloadRemotes is exposed', typeof R.reloadRemotes === 'function')
  if (typeof R.reloadRemotes === 'function')
    R.reloadRemotes(win, 'node1')
  await tick()
  await tick()
  ok('remotes: a failed load shows the line on the grid', g.bar.shown === true && /The remotes registry could not be read/.test(g.bar.html || ''), g.bar.html)
  ok('remotes: a failed first load withholds "No remotes registered"', g.view.emptyText === '', g.view.emptyText)
})

// ---- review of cr3: the Once dialog never offers a transient; plan refusals --
function fakeOnceDialog(values) {
  const fields = {}
  for (const [id, v] of Object.entries(values)) {
    fields[id] = { value: v, getValue() { return this.value }, setValue(x) { this.value = x }, setDisabled() {} }
  }
  const loaded = { rows: null }
  fields['#snapshot'].getStore = () => ({ loadData(rows) { loaded.rows = rows } })
  const plan = { html: null, update(h) { this.html = h }, addCls() {}, removeCls() {} }
  const submit = { disabled: null, setDisabled(d) { this.disabled = d } }
  const win = {
    destroyed: false,
    destroying: false,
    down: q => (q === '#planLine' ? plan : q === '#onceSubmit' ? submit : (fields[q] || null)),
  }
  return { win, fields, loaded, plan, submit }
}

ok('loadOnceSnapshots is exposed', typeof R.loadOnceSnapshots === 'function')
if (typeof R.loadOnceSnapshots === 'function') {
  const posted = []
  const savedGet = ANAS.api.get
  const savedPost = ANAS.api.post
  ANAS.api.get = () => Promise.resolve({ data: [
    { snapshotName: 'anas-backup-nightly-1794618000', created: '2026-11-14T03:00:00.000Z' },
    { snapshotName: 'S3', created: '2026-11-14T01:00:00.000Z' },
    { snapshotName: 'anas-cloud-offsite-1794617000', created: '2026-11-14T00:30:00.000Z' },
    { snapshotName: 'S2', created: '2026-11-13T01:00:00.000Z' },
  ] })
  ANAS.api.post = (_node, path, body) => {
    posted.push({ path, body })
    return Promise.reject(new Error('Could not list the snapshots of target \'backup/data\': I/O error — refusing the replication; nothing was sent'))
  }
  try {
    const d = fakeOnceDialog({ '#srcPool': 'tank', '#srcDataset': 'data', '#targetPool': 'backup', '#targetDataset': 'data', '#snapshotFirst': false, '#snapshot': '' })
    R.loadOnceSnapshots(d.win, 'node1')
    await tick()
    await tick()
    await tick()
    const names = (d.loaded.rows || []).map(r => r.snapshotName)
    ok('once: no backup or cloud transient is listed', !names.some(n => /^anas-(?:backup|cloud)-/.test(n)), JSON.stringify(names))
    ok('once: the real snapshots are listed, in the daemon\'s order, after the "newest" pick', JSON.stringify(names) === JSON.stringify([R.NEWEST_SNAPSHOT, 'S3', 'S2']), JSON.stringify(names))
    ok('once: the preselection is "the newest snapshot", not a name', d.fields['#snapshot'].value === R.NEWEST_SNAPSHOT, d.fields['#snapshot'].value)
    ok('once: the plan request for "the newest" names no snapshot (the daemon picks by createtxg)', posted.length === 1 && posted[0].body.snapshot === undefined, JSON.stringify(posted))
    ok('once: a refused plan shows the daemon\'s sentence', /plan unavailable: Could not list the snapshots of target/.test(d.plan.html || ''), d.plan.html)
    ok('once: ...and keeps Replicate off', d.submit.disabled === true, String(d.submit.disabled))
  }
  finally {
    ANAS.api.get = savedGet
    ANAS.api.post = savedPost
  }
}

// ---- review 2 of cr3: snapshot-first never shows the EXISTING snapshot's plan --
ok('fetchPlan is exposed', typeof R.fetchPlan === 'function')
if (typeof R.fetchPlan === 'function') {
  const savedPost = ANAS.api.post
  try {
    // A fresh dataset: no snapshot to plan from, so the plan is refused —
    // the run would take one and succeed.
    ANAS.api.post = () => Promise.reject(new Error('Dataset \'tank/fresh\' has no snapshots — create a snapshot first'))
    const fresh = fakeOnceDialog({ '#srcPool': 'tank', '#srcDataset': 'fresh', '#targetPool': 'backup', '#targetDataset': 'fresh', '#snapshotFirst': true, '#snapshot': '' })
    R.fetchPlan(fresh.win, 'node1')
    await tick()
    await tick()
    ok('snapshot-first: a refused plan keeps Replicate available', fresh.submit.disabled === false, String(fresh.submit.disabled))
    ok('snapshot-first: ...and shows the sentence, saying the run asks again', /has no snapshots — create a snapshot first — the run asks again once its snapshot is taken/.test(fresh.plan.html || ''), fresh.plan.html)

    ANAS.api.post = () => Promise.resolve({ data: { mode: 'incremental', snapshot: 'S3', estimatedBytes: 0, targetExists: true, targetDiverged: false, upToDate: true } })
    const old = fakeOnceDialog({ '#srcPool': 'tank', '#srcDataset': 'data', '#targetPool': 'backup', '#targetDataset': 'data', '#snapshotFirst': true, '#snapshot': '' })
    R.fetchPlan(old.win, 'node1')
    await tick()
    await tick()
    ok('snapshot-first: the plan line never describes the existing newest snapshot', !/Already on the target|Incremental|FULL/.test(old.plan.html || ''), old.plan.html)
    ok('snapshot-first: it says the plan is computed after the snapshot is taken', /computed after the snapshot is taken/.test(old.plan.html || ''), old.plan.html)
    ok('snapshot-first: Replicate stays available', old.submit.disabled === false, String(old.submit.disabled))
    ok('snapshot-first: no plan is kept for the success toast', old.win._lastPlan === null, JSON.stringify(old.win._lastPlan))
  }
  finally {
    ANAS.api.post = savedPost
  }
}
ok('submitOnce: the success toast ignores the plan when snapshot-first is checked', SOURCE.includes('var plan = snapFirst ? null : win._lastPlan;'))

// ---- review 2 of cr3: the panel's transient prefixes ARE the daemon's -------
{
  const naming = readFileSync(join(HERE, '..', '..', 'daemon', 'src', 'services', 'snapshot-naming.ts'), 'utf8')
  const consts = new Map([...naming.matchAll(/const (TRANSIENT_\w+_PREFIX) = '([^']+)'/g)].map(m => [m[1], m[2]]))
  const listed = (/const TRANSIENT_PREFIXES = \[([^\]]*)\]/.exec(naming) || [])[1] || ''
  const daemon = listed.split(',').map(x => x.trim()).filter(Boolean).map(name => consts.get(name)).sort()
  const panelList = (/var TRANSIENT_SNAPSHOT_PREFIXES = \[([^\]]*)\]/.exec(SOURCE) || [])[1] || ''
  const panel = [...panelList.matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
  ok('the daemon\'s transient prefix list was read', daemon.length > 0 && daemon.every(Boolean), JSON.stringify(daemon))
  ok('the panel\'s transient prefixes are exactly the daemon\'s (snapshot-naming.ts TRANSIENT_PREFIXES)', JSON.stringify(panel) === JSON.stringify(daemon), `panel ${JSON.stringify(panel)}, daemon ${JSON.stringify(daemon)}`)
}

// ---- the remote-delete confirmation states the check's reach ---------------
ok('the remote delete confirmation says only this node\'s tasks are checked', SOURCE.includes('Only this node\\\'s replication tasks are checked'))

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} cr3 replication panel checks passed`)
