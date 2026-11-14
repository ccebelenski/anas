#!/usr/bin/env node
/*
 * ANAS — repl.drift panel harness.
 *
 * Loads the REAL 65-replication.js (with 00-core.js, 10-api.js and
 * 69-schedules-common.js, in bundle order) and checks the task row's drift
 * pill (`targetDrift` on GET /replication/tasks):
 *
 *   • modified / exposed / unknown each render their own pill beside the lag,
 *     with the daemon's sentence as the tip; clean and an absent field
 *     (an older daemon) render nothing extra;
 *   • the sentence is encoded twice in `data-qtip` (once for the attribute,
 *     once for the tip, which QuickTip renders as HTML); the state is encoded
 *     where it reaches a class name;
 *   • the row builder carries the field, and `null` when the daemon sent none.
 *
 *   node packages/pve-integration/test/repl-drift.harness.mjs
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

function rec(fields) {
  return { get: k => fields[k] }
}

ok('renderDrift is exposed', typeof R.renderDrift === 'function')
ok('renderLag is exposed', typeof R.renderLag === 'function')
ok('taskRow is exposed', typeof R.taskRow === 'function')

const SENTENCE = 'Target \'backup/data\' on remote \'nas<b>1\' has been changed since \'@S1\': 14.00 KiB written & more'
const lagOnly = R.renderLag(0, {}, rec({ snapshotsBehind: 0 }))

// modified
const modified = R.renderLag(0, {}, rec({ snapshotsBehind: 0, targetDrift: { state: 'modified', dataset: 'backup/data', base: 'S1', writtenBytes: 14336, message: SENTENCE } }))
ok('modified: its own pill', /anas-repl-drift-modified/.test(modified), modified)
ok('modified: labelled "target changed"', />target changed</.test(modified), modified)
ok('modified: the lag is still shown first', modified.startsWith(lagOnly), modified)
const twice = htmlEncode(htmlEncode(SENTENCE))
ok('modified: the sentence is the tip, encoded twice', modified.includes(`data-qtip="${twice}"`), modified)
ok('modified: no raw markup from the sentence reaches the cell', !modified.includes('<b>1'), modified)

// exposed
const exposed = R.renderDrift(rec({ targetDrift: { state: 'exposed', dataset: 'backup/data', base: 'S1', writtenBytes: 0, readonly: 'off', message: 'Target \'backup/data\' is not read-only (readonly=off, local): x' } }))
ok('exposed: its own pill', /anas-repl-drift-exposed/.test(exposed) && />not read-only</.test(exposed), exposed)
ok('exposed: not styled as the failure pill', !/background:var\(--anas-danger/.test(exposed), exposed)

// unknown
const unknown = R.renderDrift(rec({ targetDrift: { state: 'unknown', dataset: 'backup/data', base: 'S1', message: 'Could not check whether target \'backup/data\' was changed since \'@S1\': ssh: connect timed out' } }))
ok('unknown: its own muted pill, never clean', /anas-repl-drift-unknown/.test(unknown) && />target unchecked</.test(unknown), unknown)

// clean / absent / junk
ok('clean: nothing extra', R.renderDrift(rec({ targetDrift: { state: 'clean', dataset: 'backup/data', base: 'S1' } })) === '')
ok('absent (an older daemon): nothing extra', R.renderDrift(rec({})) === '')
ok('an unknown state name renders nothing (no class injection)', R.renderDrift(rec({ targetDrift: { state: '"><img src=x>', message: 'x' } })) === '')
// Review N8 (reviewer probe p7): a state named after an Object.prototype member
// rendered a pill labelled "undefined".
for (const state of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
  const html = R.renderDrift(rec({ targetDrift: { state, message: 'x' } }))
  ok(`a prototype-key state '${state}' renders nothing`, html === '', html)
}
ok('a state that is not a string renders nothing', R.renderDrift(rec({ targetDrift: { state: ['modified'], message: 'x' } })) === '')

// the row
const row = R.taskRow({ task: { name: 'n', source: { pool: 'tank', dataset: 'data' }, target: { pool: 'backup' } }, lastRunResult: 'success', targetDrift: { state: 'exposed', dataset: 'backup/data', base: 'S1' } })
ok('the row carries targetDrift', row.targetDrift && row.targetDrift.state === 'exposed', JSON.stringify(row))
const oldRow = R.taskRow({ task: { name: 'n', source: { pool: 'tank', dataset: 'data' }, target: { pool: 'backup' } }, lastRunResult: 'success' })
ok('a row from an older daemon carries null', oldRow.targetDrift === null, JSON.stringify(oldRow))

// the store declares the field
ok('the grid store declares targetDrift', /\{ name: 'targetDrift', type: 'auto' \}/.test(SOURCE))

if (failures.length) {
  console.error(`repl-drift harness: ${failures.length} of ${checks} checks FAILED`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`repl-drift harness: ${checks} checks passed`)
