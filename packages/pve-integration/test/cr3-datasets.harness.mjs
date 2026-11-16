#!/usr/bin/env node
/*
 * ANAS — cr3.datasets panel harness (the 2026-11-14 review, area datasets).
 *
 * Loads the REAL panel sources in a vm sandbox (the lastrun-pill harness's
 * permissive Ext stub) and checks:
 *
 *   • Scrubs (POOLS-DISKS-M3, DATASETS-SCHEDULES-L6/L7, AHR-HEAL other doors):
 *     a fact the daemon lists in `unknown` renders as unknown — the periodic
 *     scrub pill never On/Off, the Last scrub cell never "never scrubbed" or
 *     idle — and the toggle is disabled (its direction is unknown). A row
 *     without `unknown` renders as before.
 *   • DATASETS-SCHEDULES-L5: a cell tooltip (`data-qtip`) is encoded TWICE
 *     (QuickTip renders the decoded attribute as HTML); a toolbar tooltip
 *     (`setTooltip`) once.
 *   • AHR results (handed by the AHR builders): a mirror reconcile's
 *     `undecidedRows` is said; a `run-stopped` block is "not examined" with
 *     its reason and never earns restore-from-backup advice.
 *   • Window titles (mounts review): every data value in a `title:` of
 *     60-datasets.js, 69-snapshots.js and 69-scrubs.js goes through enc().
 *   • Version skew (could-not-verify item): a save whose fire fields an older
 *     daemon dropped is detected by the read-back (fireFieldsNotStored).
 *   • DATASETS-SCHEDULES-H2 (+ review fold): a schedule CREATE and EDIT go through
 *     ANAS.confirmAndRun (the daemon confirm-gates a create over snapshots
 *     already stamped with its id); an edit through runJob.
 *
 *   node packages/pve-integration/test/cr3-datasets.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

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

function loadUi(files) {
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
    console,
    Promise,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }
  for (const file of files)
    vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  return win.ANAS
}

const ANAS = loadUi(['00-core.js', '10-api.js', '69-schedules-common.js', '69-scrubs.js'])
const S = ANAS.scrubs || {}

/** A grid record stand-in over a scrubRow. */
function rec(fields) {
  return { get: k => fields[k], store: null }
}

ok('the scrub row/cell helpers are reachable', ['scrubRow', 'renderEnabled', 'renderLastScrub', 'renderFindingPath', 'renderRepairOutcome', 'updateButtons'].every(k => typeof S[k] === 'function'))

if (typeof S.scrubRow === 'function') {
  const zfsState = extra => ({ target: { kind: 'zfs', pool: 'tank' }, enabled: true, cadence: 'monthly', mechanism: 'zfs-property', lastScrub: null, ...extra })
  const ahrState = extra => ({ target: { kind: 'ahr', pool: 'ahr0' }, enabled: false, cadence: 'monthly', mechanism: 'anas-scrub-timer', lastScrub: null, phases: ['md-parity', 'btrfs-checksums'], ...extra })

  // ---- enabled unknown ------------------------------------------------------
  const unkEnabled = rec(S.scrubRow(zfsState({ unknown: ['enabled'] })))
  const pill = S.renderEnabled(true, {}, unkEnabled)
  ok('enabled unknown renders Unknown', />Unknown</.test(pill), pill)
  ok('...never On or Off', !/>On</.test(pill) && !/>Off</.test(pill), pill)
  const known = S.renderEnabled(true, {}, rec(S.scrubRow(zfsState({}))))
  ok('enabled known still renders On', />On</.test(known), known)

  // ---- lastScrub / running unknown --------------------------------------------
  const unkScan = rec(S.scrubRow(zfsState({ unknown: ['lastScrub', 'running'] })))
  const cell = S.renderLastScrub(null, {}, unkScan)
  ok('a failed status read renders unknown', /unknown/.test(cell), cell)
  ok('...never "never scrubbed"', !/never scrubbed/.test(cell), cell)
  const never = S.renderLastScrub(null, {}, rec(S.scrubRow(zfsState({}))))
  ok('a read status with no record still says never scrubbed', /never scrubbed/.test(never), never)
  const ahrUnk = S.renderLastScrub(null, {}, rec(S.scrubRow(ahrState({ unknown: ['running'] }))))
  ok('an AHR btrfs read that failed renders unknown', /unknown/.test(ahrUnk), ahrUnk)
  ok('an older daemon (no unknown field) maps to []', Array.isArray(S.scrubRow(zfsState({})).unknown) && S.scrubRow(zfsState({})).unknown.length === 0)

  // ---- toolbar: the toggle is off while enabled is unknown ---------------------
  function button() {
    const b = { disabled: false, text: '', tip: null }
    b.setDisabled = (d) => { b.disabled = !!d }
    b.setText = (x) => { b.text = x }
    b.setIconCls = () => {}
    b.setTooltip = (x) => { b.tip = x }
    return b
  }
  function grid(r) {
    const items = { '#scrubToggle': button(), '#scrubRun': button(), '#scrubStop': button(), '#scrubRepair': button() }
    return {
      items,
      down: id => items[id] || null,
      getSelection: () => [r],
      getStore: () => ({ each: (f) => { f(r) } }),
    }
  }
  const g1 = grid(unkEnabled)
  S.updateButtons(g1)
  ok('toggle disabled while enabled is unknown', g1.items['#scrubToggle'].disabled === true)
  const g2 = grid(rec(S.scrubRow(zfsState({}))))
  S.updateButtons(g2)
  ok('toggle enabled when enabled is known', g2.items['#scrubToggle'].disabled === false)
  const g3 = grid(rec(S.scrubRow(ahrState({ unknown: ['running'] }))))
  S.updateButtons(g3)
  ok('Stop says the running state could not be read', /could not be read/.test(String(g3.items['#scrubStop'].tip)), String(g3.items['#scrubStop'].tip))
  // setTooltip is HTML: a reason is encoded once for it.
  const g4 = grid(rec(S.scrubRow(ahrState({}))))
  S.updateButtons(g4)
  ok('a toolbar tooltip is encoded for the tip', /node&#39;s|node's/.test(String(g4.items['#scrubToggle'].tip)) && !/</.test(String(g4.items['#scrubToggle'].tip)), String(g4.items['#scrubToggle'].tip))

  // ---- L5: data-qtip encoded twice ---------------------------------------------
  const meta = {}
  S.renderFindingPath('', meta, rec({ inode: 7, subvolume: '<img src=x onerror=alert(1)>', path: '/a' }))
  ok('finding path tip: the subvolume is double-encoded', meta.tdAttr.includes('&amp;lt;img'), meta.tdAttr)
  ok('...and nothing raw reaches the attribute', !meta.tdAttr.includes('<img') && !meta.tdAttr.includes('&lt;img'), meta.tdAttr)
  const meta2 = {}
  S.renderRepairOutcome({ level: 'ok', text: 'done', detail: '<b id=x>d</b>' }, meta2, rec({}))
  ok('repair outcome tip: the detail is double-encoded', meta2.tdAttr.includes('&amp;lt;b id=x&amp;gt;'), meta2.tdAttr)
}

// ---- AHR results: undecidedRows said; run-stopped never earns restore advice -
if (typeof S.showMirrorResult === 'function' && typeof S.showRepairResult === 'function') {
  const panelWin = (id) => {
    const panel = { html: null, setHidden() {}, update(h) { panel.html = h } }
    return { panel, win: { down: q => (q === id ? panel : null) } }
  }
  const m = panelWin('#parityResult')
  S.showMirrorResult(m.win, { status: 'completed', result: { band: 1, arm: 'compare', outcome: 'residual', passes: [], mismatchBefore: 4, mismatchAfter: 1, rowsDiffering: 3, undecidedRows: 2 } })
  ok('mirror reconcile: undecidedRows renders its line', /2 row\(s\) not decided: no verdict about their data, nothing written/.test(m.panel.html), m.panel.html)
  const m0 = panelWin('#parityResult')
  S.showMirrorResult(m0.win, { status: 'completed', result: { band: 1, arm: 'scrub', outcome: 'reconciled', passes: [] } })
  ok('mirror reconcile: no undecided line without the field', !/not decided: no verdict/.test(m0.panel.html), m0.panel.html)

  const r = panelWin('#repairResult')
  S.showRepairResult(r.win, { status: 'completed', result: { blocks: 2, repaired: 0, unrepairable: 0, aboveMd: 0, mappingAbort: 0, notExamined: 2, files: [{ path: '/a', blocks: [{ block: 1, outcome: 'not-examined', reasonCode: 'run-stopped', reason: 'a gate refused' }, { block: 2, outcome: 'not-examined', reasonCode: 'run-stopped', reason: 'x' }] }] } })
  ok('run-stopped renders as not examined, pointing at its reason', /2 block\(s\) were not examined, and nothing was written to them: the run stopped before a verdict/.test(r.panel.html), r.panel.html)
  ok('...and never restore-from-backup advice', !/Restore this file from backup/.test(r.panel.html), r.panel.html)
  const r2 = panelWin('#repairResult')
  S.showRepairResult(r2.win, { status: 'completed', result: { blocks: 1, repaired: 0, unrepairable: 1, aboveMd: 0, mappingAbort: 0, notExamined: 0, files: [{ path: '/a', blocks: [{ block: 1, outcome: 'unrepairable', reasonCode: 'run-stopped', reason: 'stopped' }] }] } })
  ok('an unrepairable count whose blocks are run-stopped carries no restore advice', !/Restore this file from backup/.test(r2.panel.html), r2.panel.html)
  const r3 = panelWin('#repairResult')
  S.showRepairResult(r3.win, { status: 'completed', result: { blocks: 1, repaired: 0, unrepairable: 1, aboveMd: 0, mappingAbort: 0, notExamined: 0, files: [{ path: '/a', blocks: [{ block: 1, outcome: 'unrepairable', reasonCode: 'both-fail', reason: 'proven lost' }] }] } })
  ok('an examined, proven-lost block still carries restore advice', /Unrepairable: \/a\./.test(r3.panel.html) && /The job(&#39;|')s PVE notification says what to restore, per file\./.test(r3.panel.html), r3.panel.html)
}
else {
  ok('scrub result renderers reachable', false)
}

// ---- Static: no single-encoded data-qtip, every title value through enc() ---
const scrubsSrc = readFileSync(join(SRC, '69-scrubs.js'), 'utf8')
ok('69-scrubs.js builds no data-qtip outside qtipAttr', (scrubsSrc.match(/data-qtip="/g) || []).length === 1, String((scrubsSrc.match(/data-qtip="/g) || []).length))
const TITLE_RE = /title: (?:isEdit \? \()?t\('[^']*'\) \+ ': ' \+ (\S+)/g
for (const file of ['60-datasets.js', '69-snapshots.js', '69-scrubs.js']) {
  const src = readFileSync(join(SRC, file), 'utf8')
  const hits = [...src.matchAll(TITLE_RE)]
  ok(`${file}: has data-carrying window titles to check`, hits.length > 0)
  for (const m of hits)
    ok(`${file}: window title value is encoded (${m[1]})`, m[1].startsWith('enc('), m[0])
}

// ---- H2: the schedule create goes through confirmAndRun ----------------------
const snapSrc = readFileSync(join(SRC, '69-snapshots.js'), 'utf8')
ok('69-snapshots.js: create AND edit submit through confirmAndRun', /ANAS\.confirmAndRun\(\{\s*node: node,\s*method: isEdit \? 'put' : 'post',\s*path: isEdit \? \('\/schedules\/'/.test(snapSrc))
ok('ANAS.confirmAndRun exists', typeof ANAS.confirmAndRun === 'function')

// ---- version skew: a fire field an older daemon dropped is detected ---------
{
  const SNAP = loadUi(['00-core.js', '10-api.js', '69-schedules-common.js', '69-snapshots.js'])
  const f = SNAP.schedules && SNAP.schedules.fireFieldsNotStored
  ok('fireFieldsNotStored is reachable', typeof f === 'function')
  if (typeof f === 'function') {
    const sent = { cadence: 'weekly', time: '01:30', weekday: 'Thu' }
    ok('an older daemon that stored neither field: both named', JSON.stringify(f(sent, { cadence: 'weekly' })) === '["time","weekday"]', JSON.stringify(f(sent, { cadence: 'weekly' })))
    ok('a daemon that stored both: none named', f(sent, { cadence: 'weekly', time: '01:30', weekday: 'Thu' }).length === 0)
    ok('a field at its default is stored as absence: not named', f({ cadence: 'daily', time: '00:00' }, { cadence: 'daily' }).length === 0)
    ok('a field the save did not send is never named', f({ cadence: 'daily' }, { cadence: 'daily' }).length === 0)
    ok('numbers compare as numbers', f({ cadence: 'monthly', dayOfMonth: 15 }, { cadence: 'monthly', dayOfMonth: 15 }).length === 0)
  }
}

// ---- L15 at the panel: a list that could not be read is SAID, never empty ----
const tick = () => new Promise(r => setImmediate(r))
const unavailable = (msg) => {
  const e = new Error(msg)
  e.status = 503
  e.body = { error: { code: 'UNAVAILABLE', message: msg } }
  return e
}
{
  const DS = loadUi(['00-core.js', '10-api.js', '60-datasets.js'])
  DS.warn = () => {}
  DS.api.get = (_node, path) => {
    if (path === '/pools')
      return Promise.resolve({ data: [{ name: 'tank', size: 100 }] })
    if (path === '/pools/tank/datasets')
      return Promise.reject(unavailable('The dataset list of pool \'tank\' could not be read'))
    return Promise.resolve({ data: [] })
  }
  let built = null
  const tree = { setLoading() {}, getRootNode: () => null, getSelection: () => [], setRootNode(r) { built = r }, down: () => null }
  DS.datasets.reload(tree, 'n1')
  for (let i = 0; i < 5; i++) await tick()
  const pool = built && built.children && built.children[0]
  const kids = (pool && pool.children) || []
  ok('a pool whose dataset list failed carries one "could not be read" row', kids.length === 1 && kids[0].kind === 'unreadable', JSON.stringify(kids))
  ok('...with the daemon\'s reason', kids[0] && /could not be read: .*dataset list of pool 'tank' could not be read/.test(kids[0].name), kids[0] && kids[0].name)

  // Inline snapshot rows.
  DS.api.get = () => Promise.reject(unavailable('The snapshots of \'tank/a\' could not be read'))
  const appended = []
  const dsNode = {
    destroyed: false,
    childNodes: [],
    firstChild: null,
    get: k => ({ pool: 'tank', fullName: 'tank/a', kind: 'dataset' })[k],
    appendChild: (n) => { appended.push(n) },
    insertBefore: (n) => { appended.push(n) },
    removeChild() {},
  }
  DS.datasets.loadSnapshotsForNode('n1', null, dsNode, true)
  for (let i = 0; i < 5; i++) await tick()
  ok('a snapshot list that failed renders a "could not be read" row under the dataset', appended.length === 1 && appended[0].kind === 'snapshots-unreadable' && /could not be read/.test(appended[0].name), JSON.stringify(appended))
  ok('...and the load can be retried', dsNode.anasSnapsLoaded === false)
}
{
  const SN = loadUi(['00-core.js', '10-api.js', '69-schedules-common.js', '69-snapshots.js'])
  SN.warn = () => {}
  SN.api.get = () => Promise.reject(unavailable('down'))
  const res = await SN.schedules.loadDatasetOptions('n1', 'tank', { name: 'tank' })
  ok('schedule dataset picker: a failed read offers no choice and says unreadable', res.opts.length === 0 && res.rows.length === 0 && /down/.test(res.unreadable), JSON.stringify(res))
  const pools = await SN.schedules.loadZfsPools('n1')
  ok('schedule pool picker: a failed read is an empty list CARRYING unreadable', Array.isArray(pools) && pools.length === 0 && /down/.test(pools.unreadable))
  const snapSrc2 = readFileSync(join(SRC, '69-snapshots.js'), 'utf8')
  ok('the save refuses a ZFS target picked from an unread dataset list', /if \(win\.anasDatasetsUnreadable\) \{\s*ANAS\.alertMsg\('Cannot save'/.test(snapSrc2))
}

// ---- cr4 fold: a rejected /pools read is SAID in the tree, never an empty one --
// The pool grid's D-16 rule, at the datasets tree: a failed pool read used to
// only alert, leaving whatever rows the previous read put there standing as if
// they were current (or an ordinary empty tree if there were none). The tree
// now says the read failed, with the reason, and carries no rows; an answered
// read puts the ordinary text back.
{
  const DS = loadUi(['00-core.js', '10-api.js', '30-pools.js', '60-datasets.js'])
  DS.warn = () => {}
  const alerts = []
  DS.alertMsg = (title, msg) => alerts.push({ title, msg })
  let mode = 'answer'
  DS.api.get = (_node, path) => {
    if (path === '/pools') {
      if (mode === 'fail') {
        return Promise.reject(unavailable('502 BAD GATEWAY: anasd is not answering'))
      }
      return Promise.resolve(mode === 'answer' ? { data: [{ name: 'tank', size: 100 }] } : { data: [] })
    }
    return Promise.resolve({ data: [] })
  }
  const view = {
    emptyText: 'No datasets found',
    setEmptyText(t) { view.emptyText = t },
  }
  const built = []
  const tree = {
    setLoading() {},
    getRootNode: () => null,
    getSelection: () => [],
    setRootNode(r) { built.push(r) },
    down: () => null,
    getView: () => view,
  }
  // A first, ANSWERED read puts a pool row on screen...
  DS.datasets.reload(tree, 'n1')
  for (let i = 0; i < 5; i++) await tick()
  const first = built[built.length - 1] || {}
  ok('fold6: the answered read puts the pool on screen',
    (first.children || []).length === 1, JSON.stringify(first))

  // ...then the next read is rejected.
  mode = 'fail'
  DS.datasets.reload(tree, 'n1')
  for (let i = 0; i < 5; i++) await tick()
  ok('fold6: the tree says the pool list could not be read, with the reason',
    /The pool list could not be read/.test(String(view.emptyText))
    && /502 BAD GATEWAY/.test(String(view.emptyText)), String(view.emptyText))
  ok('fold6: ...and the rows the previous read left are not standing as current',
    built.length >= 2 && (built[built.length - 1].children || []).length === 0,
    JSON.stringify(built[built.length - 1]))
  ok('fold6: ...and the alert still carries the reason',
    alerts.length === 1 && /502 BAD GATEWAY/.test(alerts[0].msg), JSON.stringify(alerts))

  // Recovery: an answered (empty) read restores the ordinary text.
  mode = 'empty'
  DS.datasets.reload(tree, 'n1')
  for (let i = 0; i < 5; i++) await tick()
  ok('fold6: an answered read puts the ordinary empty text back',
    /No datasets found/.test(String(view.emptyText))
    && !/could not be read/.test(String(view.emptyText)), String(view.emptyText))
}

// ---- 60-datasets.js: the toolbar tooltip setter encodes --------------------
const dsSrc = readFileSync(join(SRC, '60-datasets.js'), 'utf8')
ok('60-datasets.js setTip encodes the tooltip', /var tipHtml = text \? enc\(text\) : undefined;/.test(dsSrc))

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} cr3.datasets panel checks passed`)
