#!/usr/bin/env node
/*
 * ANAS — repl.guard panel harness.
 *
 * Loads the REAL panel sources (00-core.js, 10-api.js, 60-datasets.js) in a vm
 * sandbox with a permissive Ext stub whose Msg box is captured, and a fetch
 * stub that plays the daemon. Checks:
 *
 *   • Item 1: the dataset Edit dialog submits through ANAS.confirmAndRun. A
 *     readonly=off answered 409 + X-Anas-Confirm-Code shows the daemon's
 *     sentence (its message as the headline, its warnings), encoded; Yes
 *     replays the SAME PUT with the code; No sends nothing more. An edit the
 *     daemon answers 202 sends one PUT and no confirm box.
 *   • Item 2: a snapshot rename the daemon refuses (409, no code) surfaces the
 *     daemon's sentence in the failure alert, encoded.
 *   • Item 3: a snapshot destroy the daemon refuses surfaces its sentence the
 *     same way.
 *
 *   node packages/pve-integration/test/repl-guard.harness.mjs
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
      return proxy
    },
    apply() { return proxy },
    construct() { return proxy },
  })
  return proxy
}

/** The Ext stub: permissive, with a captured Msg box and the real htmlEncode. */
function extStub(boxes) {
  const base = permissive()
  const Msg = {
    confirm(title, msg, cb) { boxes.push({ kind: 'confirm', title, msg, cb }) },
    alert(title, msg, cb) { boxes.push({ kind: 'alert', title, msg, cb }) },
  }
  return new Proxy(base, {
    get(t, key) {
      if (key === 'Msg') { return Msg }
      if (key === 'String') { return { htmlEncode } }
      if (key === 'toast') { return () => {} }
      return t[key]
    },
  })
}

/**
 * A daemon over fetch: `answers` is consumed in order, one per request; each
 * is { status, body, headers }. Every request is recorded.
 */
function fetchStub(requests, answers) {
  return function (url, opts) {
    const headers = (opts && opts.headers) || {}
    requests.push({ url, method: opts && opts.method, headers, body: opts && opts.body ? JSON.parse(opts.body) : undefined })
    const a = answers.shift() || { status: 200, body: { job: { id: 'j1', status: 'completed' } } }
    const h = a.headers || {}
    return Promise.resolve({
      status: a.status,
      statusText: '',
      headers: { get: k => (h[k.toLowerCase()] === undefined ? null : h[k.toLowerCase()]) },
      text: () => Promise.resolve(JSON.stringify(a.body)),
    })
  }
}

function loadUi(boxes, requests, answers) {
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
    Ext: extStub(boxes),
    fetch: fetchStub(requests, answers),
    console,
    Promise,
    Date,
    JSON,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 5)),
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    encodeURIComponent,
  }
  for (const file of ['00-core.js', '10-api.js', '60-datasets.js'])
    vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  const ANAS = win.ANAS
  ANAS.warn = () => {}
  return ANAS
}

const tick = () => new Promise(r => setTimeout(r, 10))
async function settle(n = 10) {
  for (let i = 0; i < n; i++) await tick()
}

/** A dataset row of the tree, as openEdit reads it. */
function datasetRec(fields) {
  return { get: k => fields[k], data: fields }
}

/** A form stand-in: findField(name).getValue() over `values`. */
function formOf(values) {
  return {
    findField: name => ({ getValue: () => values[name], setValue() {} }),
    setValues() {},
  }
}

const PROPS = { compression: 'lz4', recordsize: 131072, quota: 0, reservation: 0, refquota: 0, refreservation: 0, sync: 'standard', atime: true, readonly: true, dedup: 'off' }

/** The daemon's repl.guard confirm, with markup in it so the encoding is visible. */
const HEADLINE = '\'tank/rep\' is a replication target. While it is read-only nothing changes it.'
const WARNINGS = [
  'Once it is not read-only, any write to it changes it, and so does any read of a file on it while access-time updates (atime) are on.',
  'It carries the replication hold anas-repl-<b>x</b> on \'tank/rep@s1\'.',
]
const CONFIRM_409 = {
  status: 409,
  headers: { 'x-anas-confirm-code': 'code-1', 'x-anas-confirm-expires': '2026-11-15T00:00:00Z' },
  body: { error: { code: 'CONFIRMATION_REQUIRED', message: HEADLINE, warnings: WARNINGS } },
}
const ACCEPTED = { status: 202, body: { job: { id: 'j1' } } }
const JOB_DONE = { status: 200, body: { job: { id: 'j1', status: 'completed' } } }

/** Open the Edit dialog on tank/rep, load it, turn read-only off, submit. */
async function editReadonlyOff(answers) {
  const boxes = []
  const requests = []
  const ANAS = loadUi(boxes, requests, answers)
  let cfg = null
  ANAS.editWindow = (c) => { cfg = c }
  // The dialog's property load is served here; the job poll goes to the daemon stub.
  const realGet = ANAS.api.get
  ANAS.api.get = () => Promise.resolve({ data: { properties: PROPS } })
  ANAS.datasets.openEdit('n1', null, datasetRec({ kind: 'dataset', pool: 'tank', fullName: 'tank/rep', type: 'filesystem' }))
  ok('the Edit dialog opened (editWindow called)', cfg !== null)
  if (!cfg) { return { boxes, requests } }
  const form = formOf({ ...PROPS, readonly: false, recordsize: 131072 })
  cfg.load(form, () => {})
  await settle(3)
  ANAS.api.get = realGet
  const winStub = { close() {}, destroyed: false, destroying: false }
  cfg.submit(form, winStub)
  await settle()
  return { boxes, requests, ANAS }
}

// ---- static: the edit submits through confirmAndRun -----------------------
const dsSrc = readFileSync(join(SRC, '60-datasets.js'), 'utf8')
ok('60-datasets.js: the dataset edit submits through ANAS.confirmAndRun with the daemon\'s headline',
  /ANAS\.confirmAndRun\(\{\s*node: node,\s*method: 'put',\s*path: datasetPath\(pool, fullName\),\s*body: \{ properties: changed \},\s*view: win,\s*confirmHeadline: true,/.test(dsSrc))

// ---- item 1: the confirm, Yes replays with the code ------------------------
{
  const { boxes, requests } = await editReadonlyOff([CONFIRM_409, ACCEPTED, JOB_DONE])
  const puts = () => requests.filter(r => r.method === 'PUT')
  ok('one PUT, then the confirm box', puts().length === 1 && boxes.length === 1 && boxes[0].kind === 'confirm', JSON.stringify(boxes.map(b => b.kind)))
  ok('the PUT carried only the change: readonly false', JSON.stringify(puts()[0] && puts()[0].body) === '{"properties":{"readonly":false}}', JSON.stringify(puts()[0] && puts()[0].body))
  const msg = boxes[0] ? boxes[0].msg : ''
  ok('the confirm leads with the daemon\'s sentence, encoded', msg.indexOf('<b>' + htmlEncode(HEADLINE) + '</b>') === 0, msg)
  ok('...and lists its warnings, encoded', msg.indexOf(htmlEncode(WARNINGS[0])) > 0 && msg.indexOf('anas-repl-&lt;b&gt;x&lt;/b&gt;') > 0, msg)
  ok('...and nothing raw from the daemon reaches the markup', msg.indexOf('<b>x</b>') < 0, msg)
  if (boxes[0]) { boxes[0].cb('yes') }
  await settle()
  ok('Yes replays the SAME PUT with the code', puts().length === 2
    && puts()[1].headers['X-Anas-Confirm'] === 'code-1'
    && JSON.stringify(puts()[1].body) === JSON.stringify(puts()[0].body)
    && puts()[1].url === puts()[0].url, JSON.stringify(puts()))
  ok('...and the job is polled', requests.some(r => r.method === 'GET' && /\/jobs\/j1/.test(r.url)), JSON.stringify(requests.map(r => `${r.method} ${r.url}`)))
}

// ---- item 1: No sends nothing more -----------------------------------------
{
  const { boxes, requests } = await editReadonlyOff([CONFIRM_409])
  if (boxes[0]) { boxes[0].cb('no') }
  await settle()
  ok('No: no second PUT, no alert', requests.filter(r => r.method === 'PUT').length === 1 && boxes.length === 1, JSON.stringify(boxes.map(b => b.kind)))
}

// ---- item 1: an edit answered 202 shows no confirm --------------------------
{
  const { boxes, requests } = await editReadonlyOff([ACCEPTED, JOB_DONE])
  ok('a 202 edit: one PUT, no box', requests.filter(r => r.method === 'PUT').length === 1 && boxes.length === 0, JSON.stringify(boxes.map(b => b.kind)))
}

// ---- items 2 and 3: the refusals surface the daemon's sentence ---------------
const RENAME_REFUSAL = 'Renaming \'tank/rep@s1\' is refused: it is held by replication task \'nightly\': anas-repl-<i>1</i>. Nothing was renamed.'
const DESTROY_REFUSAL = 'Destroying \'tank/rep@s1\' is refused: ZFS does not destroy a held snapshot — nothing was done. tank/rep@s1 held by \'keep\' & <u>co</u>.'
const ctx = { pool: 'tank', dataset: 'tank/rep', snapshotName: 's1', fullName: 'tank/rep@s1', view: null }
{
  const boxes = []
  const requests = []
  const ANAS = loadUi(boxes, requests, [{ status: 409, body: { error: { code: 'CONFLICT', reason: 'snapshot-held', message: RENAME_REFUSAL } } }])
  const win = {
    destroyed: false,
    destroying: false,
    close() {},
    down: q => (q === '#newName' ? { getValue: () => 'renamed' } : (q === '#form' ? { getForm: () => ({ isValid: () => true }) } : null)),
  }
  let done = 0
  ANAS.datasets.submitRenameSnapshot(win, 'n1', ctx, () => { done++ })
  await settle()
  const put = requests.find(r => r.method === 'PUT')
  ok('rename: the PUT went out', put && JSON.stringify(put.body) === '{"newName":"renamed"}', JSON.stringify(requests))
  ok('rename: the refusal is an alert carrying the daemon\'s sentence, encoded', boxes.length === 1 && boxes[0].kind === 'alert' && boxes[0].msg === htmlEncode(RENAME_REFUSAL), JSON.stringify(boxes))
  ok('rename: no confirm box (the daemon minted no code)', !boxes.some(b => b.kind === 'confirm'))
  if (boxes[0] && boxes[0].cb) { boxes[0].cb() }
  ok('rename: dismissing the alert reloads (onFailed)', done === 1, String(done))
}
{
  const boxes = []
  const requests = []
  const ANAS = loadUi(boxes, requests, [{ status: 409, body: { error: { code: 'CONFLICT', reason: 'snapshot-held', message: DESTROY_REFUSAL } } }])
  ANAS.datasets.runDestroySnapshot('n1', ctx, () => {})
  await settle()
  ok('destroy: the DELETE went out', requests.some(r => r.method === 'DELETE' && /\/snapshots\/s1$/.test(r.url)), JSON.stringify(requests.map(r => `${r.method} ${r.url}`)))
  ok('destroy: the refusal is an alert carrying the daemon\'s sentence, encoded', boxes.length === 1 && boxes[0].kind === 'alert' && boxes[0].msg === htmlEncode(DESTROY_REFUSAL), JSON.stringify(boxes))
}

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} repl.guard panel checks passed`)
