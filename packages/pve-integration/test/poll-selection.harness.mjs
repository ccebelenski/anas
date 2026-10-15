#!/usr/bin/env node
/*
 * ANAS — cr.46 harness: poll responses applied to the selection they were
 * made for, and deletes through runJob.
 *
 * Two behaviours, both lived in the UI, both proven against the REAL panel
 * loaders (10-api.js + 65-replication.js + 69-snapshots.js run in a vm with
 * the ExtJS surface stubbed — the idiom of edit-retarget.harness.mjs):
 *
 *   a. a row the operator picks WHILE a refresh is in flight survives the
 *      refresh — the selection is read when the response arrives, not when
 *      the request left;
 *   b. a response older than the newest request is dropped (the per-grid
 *      _loadSeq guard, the _previewSeq idiom from 72-cloud.js): the older
 *      answer neither repaints the grid nor touches the loading mask a newer
 *      load owns — and every branch of a fresh response still clears it;
 *   c. the replication task delete and the snapshot-schedule delete go
 *      through ANAS.runJob — not api.del, not a hand-rolled pollJob — so the
 *      failure alert and the grid reload come from the shared helper.
 *
 *   node packages/pve-integration/test/poll-selection.harness.mjs
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
  /** The rows the next GET /replication/tasks answers with (captured per call). */
  taskData: [],
  /** The rows GET /schedules answers with. */
  schedulesData: [],
  /** Hold the next N api.get calls until release(i) is called. */
  holdNext: 0,
  /** Every deferred a held GET handed out: { resolve, reject, path }. */
  pending: [],
  getCalls: [],
  /** ANAS.api.del calls — case c asserts this stays EMPTY. */
  dels: [],
  /** ANAS.runJob calls — case c asserts the deletes land here. */
  runJobs: [],
  toasts: [],
  warnings: [],
  alerts: [],
  confirms: [],
  confirmAnswer: 'yes',
}

function reset() {
  state.taskData = []
  state.schedulesData = []
  state.holdNext = 0
  state.pending = []
  state.getCalls = []
  state.dels = []
  state.runJobs = []
  state.toasts = []
  state.warnings = []
  state.alerts = []
  state.confirms = []
  state.confirmAnswer = 'yes'
}

// ---- ExtJS stub (the edit-retarget idiom, trimmed to what runs here) --------

const Ext = {
  String: { htmlEncode: s => String(s == null ? '' : s) },
  Date: { format: (d, f) => `${d}${f}` },
  Msg: {
    confirm(title, msg, fn) {
      state.confirms.push({ title, msg })
      fn(state.confirmAnswer)
    },
    alert(title, msg) { state.alerts.push({ title, msg }) },
  },
}

function fixtureFor(path) {
  if (path === '/replication/tasks') { return { data: state.taskData.slice() } }
  if (path === '/schedules') { return { data: state.schedulesData.slice() } }
  return { data: [] }
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
  // 10-api.js first, exactly as the real page loads it; the recording stubs go
  // OVER it afterwards (same order as edit-retarget.harness.mjs).
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
    tbar: items => ({ xtype: 'toolbar', items }),
    pollJob: () => Promise.resolve({}),
    gfx: { ready: () => false },
    sched: { absTime: v => String(v || ''), fsTag: kind => `[${kind}] ` },
    notifyMode: {
      field: cfg => Object.assign({ xtype: 'combobox' }, cfg),
      of: (v, d) => v || d,
      hintHtml: () => '',
    },
    api: {
      get(_node, path) {
        state.getCalls.push(path)
        // The value is captured WHEN THE REQUEST LEAVES, like a real server
        // snapshot; the promise resolves (or rejects) only when the test says.
        const value = fixtureFor(path)
        if (state.holdNext > 0) {
          state.holdNext -= 1
          return new Promise((resolve, reject) => {
            state.pending.push({ resolve, reject, path })
          })
        }
        return Promise.resolve(value)
      },
      del(_node, path) {
        state.dels.push(path)
        return Promise.resolve({})
      },
      post: () => Promise.resolve({}),
      put: () => Promise.resolve({}),
    },
    runJob(opts) {
      state.runJobs.push(opts)
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

// ---- A grid stand-in with real selection semantics --------------------------
//
// loadData REPLACES the rows and clears the selection — like Ext's store —
// so a loader that captured the selection too early has something visible to
// get wrong: it restores the stale name, and the operator's newer pick dies.

function makeGrid() {
  const grid = {
    destroyed: false,
    destroying: false,
    loading: false,
    _rows: [],
    _sel: [],
    setLoading(v) { grid.loading = !!v },
    getStore: () => store,
    getSelectionModel: () => selModel,
    getSelection: () => grid._sel.slice(),
    down: () => null,
  }
  const store = {
    loadData(rows) {
      grid._rows = (rows || []).map(r => ({ get: k => r[k], data: r }))
      grid._sel = []
    },
    findExact(field, value) {
      return grid._rows.findIndex(r => r.get(field) === value)
    },
  }
  const selModel = {
    select(idx) {
      if (grid._rows[idx]) { grid._sel = [grid._rows[idx]] }
    },
    getSelection: () => grid._sel.slice(),
  }
  grid.names = () => grid._rows.map(r => r.get('name'))
  grid.selectedNames = () => grid._sel.map(r => r.get('name'))
  grid.pick = name => selModel.select(grid.names().indexOf(name))
  return grid
}

function replTask(name) {
  return {
    task: { name, source: { pool: 'tank' }, target: { pool: 'backup' }, schedule: 'daily', enabled: true },
    lastRunResult: 'success',
  }
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

// =============================================================================
//  a. a pick made while a refresh is in flight survives the refresh
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.taskData = [replTask('alpha'), replTask('beta')]
  ANAS.replication.reload(grid, 'n1') // the load that first populates the grid
  await settle()
  eq('a: the grid loaded', JSON.stringify(grid.names()), JSON.stringify(['alpha', 'beta']))
  grid.pick('alpha')

  // The timed poll goes out while the operator is reaching for a row…
  state.holdNext = 1
  ANAS.replication.reload(grid, 'n1', true)
  // …and their pick lands BEFORE the response arrives.
  grid.pick('beta')
  state.pending[0].resolve(fixtureFor('/replication/tasks'))
  await settle()

  eq('a: the response-arrives read keeps the IN-FLIGHT pick', JSON.stringify(grid.selectedNames()), JSON.stringify(['beta']))
  eq('a: the grid still holds both rows', JSON.stringify(grid.names()), JSON.stringify(['alpha', 'beta']))
  eq('a: nothing warned', state.warnings.length, 0)
}

// =============================================================================
//  b. a response older than the newest request is dropped
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.taskData = [replTask('alpha')]
  ANAS.replication.reload(grid, 'n1')
  await settle()

  // Request #1 leaves…
  state.holdNext = 1
  ANAS.replication.reload(grid, 'n1', true)
  // …then a manual Reload fires request #2, whose answer reflects newer rows.
  state.taskData = [replTask('zulu')]
  state.holdNext = 1
  ANAS.replication.reload(grid, 'n1', true)
  eq('b: two requests are in flight', state.pending.length, 2)

  // The NEWER answer arrives first and wins.
  state.pending[1].resolve(fixtureFor('/replication/tasks'))
  await settle()
  eq('b: the newer response painted', JSON.stringify(grid.names()), JSON.stringify(['zulu']))

  // The OLDER answer lands late: it must not repaint over the newer one.
  state.pending[0].resolve({ data: [replTask('alpha')] })
  await settle()
  eq('b: the stale response did not repaint', JSON.stringify(grid.names()), JSON.stringify(['zulu']))
}

// b2. the loading mask belongs to the newest load: a stale rejection must not
// clear it out from under the request still in flight — and every fresh
// branch (success AND failure) must still clear it.
{
  reset()
  const grid = makeGrid()
  state.taskData = [replTask('alpha')]
  ANAS.replication.reload(grid, 'n1')
  await settle()

  state.holdNext = 2
  ANAS.replication.reload(grid, 'n1') // masked, held — request #1
  ANAS.replication.reload(grid, 'n1') // masked, held — request #2
  eq('b2: the mask is on', grid.loading, true)

  state.pending[0].reject(new Error('stale failure'))
  await settle()
  eq('b2: a stale failure does not clear the newer load\'s mask', grid.loading, true)
  eq('b2: a stale failure does not warn over the newer load', state.warnings.length, 0)

  state.pending[1].resolve(fixtureFor('/replication/tasks'))
  await settle()
  eq('b2: the fresh success clears the mask', grid.loading, false)
  eq('b2: the fresh rows painted', JSON.stringify(grid.names()), JSON.stringify(['alpha']))

  // A FRESH failure still clears the mask (the rule the drop must not break).
  state.pending = []
  state.holdNext = 1
  ANAS.replication.reload(grid, 'n1')
  eq('b2: the mask is on again', grid.loading, true)
  state.pending[0].reject(new Error('boom'))
  await settle()
  eq('b2: a fresh failure clears the mask', grid.loading, false)
  ok('b2: and warns', state.warnings.some(w => /boom/.test(w)), state.warnings.join(' | '))
}

// =============================================================================
//  c. the deletes go through runJob, not api.del
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.taskData = [replTask('alpha')]
  ANAS.replication.reload(grid, 'n1')
  await settle()

  ANAS.replication.deleteTask('n1', grid, { get: k => ({ name: 'alpha' }[k]) })
  eq('c: the delete asked first', state.confirms.length, 1)
  eq('c: exactly one runJob call', state.runJobs.length, 1)
  const job = state.runJobs[0] || {}
  eq('c: method del', job.method, 'del')
  eq('c: the task path', job.path, '/replication/tasks/alpha')
  eq('c: the grid is the view (polling stops when it dies)', job.view, grid)
  ok('c: the completion toast is runJob\'s successMsg', /deleted/i.test(job.successMsg || ''), job.successMsg)
  eq('c: no api.del call', state.dels.length, 0)
  eq('c: no toast on the 202 — the toast belongs to the job', state.toasts.length, 0)

  // When the JOB completes, runJob's onComplete reloads the grid.
  job.onComplete({ id: 'j1', status: 'completed' })
  await settle()
  ok('c: the reload rides the job\'s completion',
    state.getCalls.filter(p => p === '/replication/tasks').length === 2, state.getCalls.join(' '))

  // A declined confirm runs nothing at all.
  reset()
  state.confirmAnswer = 'no'
  ANAS.replication.deleteTask('n1', grid, { get: k => ({ name: 'alpha' }[k]) })
  eq('c: a declined delete runs nothing', state.runJobs.length, 0)
}

// c2. the snapshot-schedule delete — same door, same helper.
{
  reset()
  const grid = makeGrid()
  ANAS.schedules.deleteSchedule('n1', grid, { get: k => ({ id: 'vault-daily', name: 'Vault daily' }[k]) })
  eq('c2: exactly one runJob call', state.runJobs.length, 1)
  const job = state.runJobs[0] || {}
  eq('c2: method del', job.method, 'del')
  eq('c2: the schedule path', job.path, '/schedules/vault-daily')
  eq('c2: the grid is the view', job.view, grid)
  ok('c2: the completion toast is runJob\'s successMsg', /deleted/i.test(job.successMsg || ''), job.successMsg)
  eq('c2: no api.del call', state.dels.length, 0)
  eq('c2: no hand-rolled pollJob toast', state.toasts.length, 0)
  job.onComplete({ id: 'j2', status: 'completed' })
  await settle()
  ok('c2: the schedules grid reload rides the completion',
    state.getCalls.filter(p => p === '/schedules').length === 1, state.getCalls.join(' '))
}

// ---- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} poll-selection checks passed`)
