#!/usr/bin/env node
/*
 * ANAS — cr.46 harness: poll responses applied to the selection they were
 * made for, deletes through runJob, and the loading-mask / sequence rules the
 * cr.45 review added.
 *
 * Behaviours, all lived in the UI, all proven against the REAL panel loaders
 * (10-api.js + 65-replication.js + 69-snapshots.js + 68-backup.js +
 * 69-scrubs.js run in a vm with the ExtJS surface stubbed — the idiom of
 * edit-retarget.harness.mjs):
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
 *   c3/c4  a masked load followed by a quiet load: the QUIET response that is
 *      the newest clears the mask (success and failure alike), and the stale
 *      masked one never touches it or the grid (cr.45 review, item 3);
 *   d/e/f  the SCHEDULES loader carries the same rules (item 5): the
 *      selection is read at response time, a stale response is dropped, and
 *      the newest quiet success / failure clears the mask;
 *   g/h    the backup and scrub loaders get the same mask rule.
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
  /** The rows GET /backup/tasks answers with. */
  backupData: [],
  /** The rows GET /scrub answers with. */
  scrubData: [],
  /** Hold the next N api.get calls until release(i) is called. */
  holdNext: 0,
  /** When set, hold only calls whose path contains this substring. */
  holdForPath: null,
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
  state.backupData = []
  state.scrubData = []
  state.holdNext = 0
  state.holdForPath = null
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
  if (path === '/backup/tasks') { return { data: state.backupData.slice() } }
  if (path === '/scrub') { return { data: state.scrubData.slice() } }
  if (path === '/backup/repos') { return { data: [] } }
  if (path === '/jobs?status=completed') { return { data: [] } }
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
    sched: {
      absTime: v => String(v || ''),
      fsTag: kind => `[${kind}] `,
      cadence: { of: () => '', text: () => '' },
      cancellable: () => false,
    },
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
        // holdForPath lets a test hold only ONE read in a loader that issues
        // two (backup: repos then tasks; scrub: scrub then jobs).
        const hold = state.holdForPath
          ? path.indexOf(state.holdForPath) !== -1
          : state.holdNext > 0
        if (hold) {
          if (state.holdNext > 0) { state.holdNext -= 1 }
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
  vm.runInNewContext(readFileSync(join(SRC, '68-backup.js'), 'utf8'), sandbox, { filename: '68-backup.js' })
  vm.runInNewContext(readFileSync(join(SRC, '69-scrubs.js'), 'utf8'), sandbox, { filename: '69-scrubs.js' })
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

function schedEntry(id, name) {
  return {
    schedule: { id, name, target: {} },
    lastRunResult: 'unknown',
  }
}

function scrubState(pool) {
  return { target: { pool, kind: 'zfs' }, enabled: true, cadence: 'monthly' }
}

// The backup loader resolves the grid through the view's down('#backupGrid').
function backupView(grid) {
  return {
    destroyed: false,
    destroying: false,
    down: q => q === '#backupGrid' ? grid : null,
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

// =============================================================================
//  c3. the loading-mask rule (cr.45 review, item 3): a masked load then a
//  quiet load — the QUIET response arrives first and clears the mask (it IS
//  the newest), and the stale masked one leaves mask and grid alone.
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.taskData = [replTask('alpha')]
  ANAS.replication.reload(grid, 'n1')
  await settle()

  state.holdNext = 2
  ANAS.replication.reload(grid, 'n1')       // masked, held — request #1
  ANAS.replication.reload(grid, 'n1', true) // quiet, held — request #2
  eq('c3: the mask is up', grid.loading, true)

  state.pending[1].resolve(fixtureFor('/replication/tasks'))
  await settle()
  eq('c3: the newest QUIET success clears the mask', grid.loading, false)

  state.pending[0].resolve({ data: [replTask('alpha')] })
  await settle()
  eq('c3: the stale masked response leaves the mask down', grid.loading, false)
  eq('c3: the stale response did not repaint', JSON.stringify(grid.names()), JSON.stringify(['alpha']))
}

// c4. the SAME rule on the failure branch — a quiet FAILURE is the newest, so
// it clears the mask and warns; the stale masked failure stays silent.
{
  reset()
  const grid = makeGrid()
  state.taskData = [replTask('alpha')]
  ANAS.replication.reload(grid, 'n1')
  await settle()

  state.holdNext = 2
  ANAS.replication.reload(grid, 'n1')
  ANAS.replication.reload(grid, 'n1', true)
  eq('c4: the mask is up', grid.loading, true)

  state.pending[1].reject(new Error('quiet boom'))
  await settle()
  eq('c4: the newest quiet FAILURE clears the mask', grid.loading, false)
  ok('c4: and warns its own error', state.warnings.some(w => /quiet boom/.test(w)), state.warnings.join(' | '))

  state.pending[0].reject(new Error('stale thing'))
  await settle()
  eq('c4: a stale failure still leaves the mask alone', grid.loading, false)
  eq('c4: and does not warn over the newer load',
    state.warnings.filter(w => /stale thing/.test(w)).length, 0)
}

// =============================================================================
//  d. the SCHEDULES loader (item 5) — the selection is read at RESPONSE time:
//  a pick made while the refresh was in flight survives it.
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.schedulesData = [schedEntry('vault-daily', 'Vault daily'), schedEntry('backup-daily', 'Backup daily')]
  ANAS.schedules.reload(grid, 'n1')
  await settle()
  eq('d: the schedules grid loaded', JSON.stringify(grid.names()), JSON.stringify(['Vault daily', 'Backup daily']))
  grid.pick('Vault daily')

  state.holdNext = 1
  ANAS.schedules.reload(grid, 'n1')
  grid.pick('Backup daily')
  state.pending[0].resolve(fixtureFor('/schedules'))
  await settle()
  eq('d: the response-arrives read keeps the in-flight pick', JSON.stringify(grid.selectedNames()), JSON.stringify(['Backup daily']))
  eq('d: the grid still holds both rows', JSON.stringify(grid.names()), JSON.stringify(['Vault daily', 'Backup daily']))
}

// =============================================================================
//  e. the SCHEDULES loader drops a response older than the newest request.
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.schedulesData = [schedEntry('vault-daily', 'Vault daily')]
  ANAS.schedules.reload(grid, 'n1')
  await settle()

  state.holdNext = 1
  ANAS.schedules.reload(grid, 'n1', true)
  state.schedulesData = [schedEntry('zulu', 'Zulu')]
  state.holdNext = 1
  ANAS.schedules.reload(grid, 'n1', true)
  eq('e: two requests are in flight', state.pending.length, 2)

  state.pending[1].resolve(fixtureFor('/schedules'))
  await settle()
  eq('e: the newer response painted', JSON.stringify(grid.names()), JSON.stringify(['Zulu']))

  // The OLDER answer lands late carrying a THIRD shape: it must not repaint.
  state.pending[0].resolve({ data: [schedEntry('alpha', 'Alpha')] })
  await settle()
  eq('e: the stale response did not repaint', JSON.stringify(grid.names()), JSON.stringify(['Zulu']))
}

// =============================================================================
//  f. the SCHEDULES loader mask rule: a masked load then a quiet load — the
//  quiet response arrives first and clears, the stale masked one stays out.
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.schedulesData = [schedEntry('vault-daily', 'Vault daily')]
  ANAS.schedules.reload(grid, 'n1')
  await settle()

  state.holdNext = 2
  ANAS.schedules.reload(grid, 'n1')
  ANAS.schedules.reload(grid, 'n1', true)
  eq('f: the mask is up', grid.loading, true)

  state.pending[1].resolve(fixtureFor('/schedules'))
  await settle()
  eq('f: the newest QUIET success clears the mask', grid.loading, false)

  state.pending[0].resolve({ data: [schedEntry('alpha', 'Alpha')] })
  await settle()
  eq('f: the stale masked response leaves the mask down', grid.loading, false)
  eq('f: the stale response did not repaint', JSON.stringify(grid.names()), JSON.stringify(['Vault daily']))
}

// f2. the schedules failure branch of the same rule.
{
  reset()
  const grid = makeGrid()
  state.schedulesData = [schedEntry('vault-daily', 'Vault daily')]
  ANAS.schedules.reload(grid, 'n1')
  await settle()

  state.holdNext = 2
  ANAS.schedules.reload(grid, 'n1')
  ANAS.schedules.reload(grid, 'n1', true)
  eq('f2: the mask is up', grid.loading, true)

  state.pending[1].reject(new Error('schedule boom'))
  await settle()
  eq('f2: the newest quiet FAILURE clears the mask', grid.loading, false)
  ok('f2: and warns', state.warnings.some(w => /schedule boom/.test(w)), state.warnings.join(' | '))

  state.pending[0].reject(new Error('stale boom'))
  await settle()
  eq('f2: a stale failure leaves the mask alone', grid.loading, false)
}

// =============================================================================
//  g. the BACKUP loader gets the same mask rule (item 3) — the repos read is
//  left instant, only the /backup/tasks read is held.
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.backupData = [replTask('alpha')]
  const view = backupView(grid)
  ANAS.backup.reload(view, 'n1')
  await settle()
  eq('g: the backup grid loaded', JSON.stringify(grid.names()), JSON.stringify(['alpha']))

  state.holdForPath = '/backup/tasks'
  ANAS.backup.reload(view, 'n1')
  await settle() // let the repos read resolve and the tasks read go out
  ANAS.backup.reload(view, 'n1', true)
  await settle()
  eq('g: the mask is up', grid.loading, true)
  eq('g: both task reads were held', state.pending.length, 2)

  state.pending[1].resolve(fixtureFor('/backup/tasks'))
  await settle()
  eq('g: the newest QUIET success clears the mask', grid.loading, false)

  state.pending[0].resolve({ data: [replTask('alpha')] })
  await settle()
  eq('g: the stale masked response leaves the mask down', grid.loading, false)
}

// =============================================================================
//  h. the SCRUB loader gets the same mask rule (item 3) — the jobs read is
//  left instant, only the /scrub read is held.
// =============================================================================
{
  reset()
  const grid = makeGrid()
  state.scrubData = [scrubState('tank')]
  const scrubPools = () => JSON.stringify(grid._rows.map(r => r.get('pool')))
  ANAS.scrubs.reload(grid, 'n1')
  await settle()
  eq('h: the scrub grid loaded', scrubPools(), JSON.stringify(['tank']))

  state.holdForPath = '/scrub'
  ANAS.scrubs.reload(grid, 'n1')
  ANAS.scrubs.reload(grid, 'n1', true)
  eq('h: the mask is up', grid.loading, true)
  eq('h: both scrub reads were held', state.pending.length, 2)

  state.pending[1].resolve(fixtureFor('/scrub'))
  await settle()
  eq('h: the newest QUIET success clears the mask', grid.loading, false)

  state.pending[0].resolve({ data: [scrubState('tank')] })
  await settle()
  eq('h: the stale masked response leaves the mask down', grid.loading, false)
}

// ---- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} poll-selection checks passed`)
