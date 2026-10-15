#!/usr/bin/env node
/*
 * ANAS — pollJob harness (story cr.45, docs/WAVE3-DESIGN.md §7.2).
 *
 * Loads the real 00-core.js + 10-api.js (+ 69-schedules-common.js for the
 * cancel-run flow) in a vm sandbox with a stub Ext, a scripted stub fetch and
 * a FAKE clock: setTimeout records timers and the driver fires them in order,
 * draining microtasks between firings so the real promise chains run. Nothing
 * sleeps for real.
 *
 * Checked sequences:
 *   a  completes → onComplete once
 *   b  running past maxMs → onStillRunning once, still polling, then
 *      completed → onComplete once (and only then)
 *   c  still running at maxMs → onComplete NOT called
 *   d  404 → terminal lost: onLost(err), or onFailed(null) without onLost;
 *      polling stops
 *   e  two network errors then success → resumes normal polling, with the
 *      1 s and 2 s retry delays observed
 *   f  60 s without a successful poll → lost contact, onFailed(null); the
 *      <what> interpolation is HTML-encoded (cr.11 idiom)
 *   g  view destroyed mid-poll → silent stop, no callbacks
 *   h  the cancel-run flow (69-schedules-common.js) toasts "Run cancelled"
 *      only when the cancel job reaches completed
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const coreSrc = readFileSync(join(SRC, '00-core.js'), 'utf8')
const apiSrc = readFileSync(join(SRC, '10-api.js'), 'utf8')
const schedSrc = readFileSync(join(SRC, '69-schedules-common.js'), 'utf8')

// ---- env factory: fresh sandbox, fake clock and scripted fetch per case ----

function makeEnv(handle) {
  const toasts = []
  const alerts = []
  const delays = [] // every setTimeout delay in scheduling order
  const calls = [] // every fetch: { method, url }
  let now = 0
  let seq = 0
  const timers = []

  const Ext = {
    String: {
      htmlEncode: function (s) {
        return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      },
    },
    toast: function (msg) { toasts.push(msg) },
    Msg: { alert: function (title, msg) { alerts.push({ title, msg }) } },
  }

  function ok(bodyText) {
    return {
      status: 200,
      statusText: 'OK',
      headers: { get: function () { return null } },
      text: function () { return Promise.resolve(bodyText) },
    }
  }

  const sandbox = {
    console,
    Promise,
    Ext,
    fetch: function (url, opts) {
      const method = ((opts && opts.method) || 'GET').toUpperCase()
      calls.push({ method, url })
      const r = handle(method, url, calls)
      if (r && r.networkError) return Promise.reject(new Error(r.networkError))
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
      return Promise.resolve({
        status: r.status || 200,
        statusText: r.statusText || (r.status === 200 ? 'OK' : 'Err'),
        headers: { get: function () { return null } },
        text: function () { return Promise.resolve(body) },
      })
    },
    setTimeout: function (fn, ms) {
      delays.push({ at: now, ms: ms || 0 })
      timers.push({ at: now + (ms || 0), seq: seq++, fn })
      return seq
    },
    clearTimeout: function () {},
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(coreSrc, sandbox, { filename: '00-core.js' })
  vm.runInContext(apiSrc, sandbox, { filename: '10-api.js' })
  vm.runInContext(schedSrc, sandbox, { filename: '69-schedules-common.js' })

  // Drain the real promise chains the fired timers kick off (doFetch wraps
  // fetch().then(res.text().then(...)) — a handful of generations).
  async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve()
  }

  // Fire every timer due by `limit` (fake ms), oldest first, microtasks
  // drained after each — the poll's own re-schedule lands in this list.
  async function advanceTo(limit) {
    await flush()
    for (;;) {
      timers.sort((a, b) => (a.at - b.at) || (a.seq - b.seq))
      const idx = timers.findIndex(function (t) { return t.at <= limit })
      if (idx === -1) break
      const t = timers.splice(idx, 1)[0]
      now = t.at
      t.fn()
      await flush()
    }
    await flush()
  }

  function jobPolls() {
    return calls.filter(function (c) {
      return c.method === 'GET' && c.url.indexOf('/jobs/') !== -1
    }).length
  }

  // Retry delays = scheduled after the first 500 ms poll: drop the first.
  function scheduledDelays() {
    return delays.map(function (d) { return d.ms })
  }

  return {
    sandbox,
    ANAS: sandbox.window.ANAS,
    toasts,
    alerts,
    calls,
    jobPolls,
    scheduledDelays,
    advanceTo,
  }
}

const run = () => ({ status: 200, body: { job: { id: 'J', status: 'running', operation: 'test.op' } } })
const done = () => ({ status: 200, body: { job: { id: 'J', status: 'completed', operation: 'test.op' } } })
const netErr = () => ({ networkError: 'connect ECONNREFUSED' })

// ---- assertions ----

let failures = 0
function assert(label, cond) {
  if (!cond) {
    failures++
    console.error('FAIL:', label)
  }
  else {
    console.log('ok', label)
  }
}

function count(arr) { return arr.length }
function contains(hay, needle) { return String(hay).indexOf(needle) !== -1 }

async function main() {
  // --- a: completes → onComplete once -------------------------------------
  {
    let polls = 0
    const env = makeEnv(function () { polls++; return polls >= 3 ? done() : run() })
    let completes = 0
    let failed = 0
    let lost = 0
    env.ANAS.pollJob('pve1', 'J', {
      onComplete: function () { completes++ },
      onFailed: function () { failed++ },
      onLost: function () { lost++ },
    })
    await env.advanceTo(60000)
    assert('a: onComplete once', completes === 1)
    assert('a: no onFailed/onLost', failed === 0 && lost === 0)
    assert('a: three polls', env.jobPolls() === 3)
  }

  // --- b: running past maxMs → onStillRunning once, keeps polling, then
  //        completes → onComplete once -------------------------------------
  {
    let polls = 0
    const env = makeEnv(function () { polls++; return polls >= 8 ? done() : run() })
    let completes = 0
    let still = 0
    env.ANAS.pollJob('pve1', 'J', {
      maxMs: 3000,
      onComplete: function () { completes++ },
      onStillRunning: function () { still++ },
    })
    await env.advanceTo(13000) // announced at 3000, then 5 s cadence: 8000, 13000 → completed
    assert('b: onStillRunning once', still === 1)
    assert('b: onComplete once, only after completed', completes === 1)
    assert('b: kept polling after the announcement', env.jobPolls() === 8)
    // Delays: 0.5 s polls to 3 s, then 5 s while announced.
    assert('b: 0.5 s cadence before the announcement',
      env.scheduledDelays().slice(0, 4).join(',') === '500,500,500,500')
    assert('b: 5 s cadence after the announcement',
      env.scheduledDelays().filter(function (d) { return d === 5000 }).length >= 1)
  }

  // --- c: still running at maxMs → onComplete NOT called -------------------
  {
    const env = makeEnv(run)
    let completes = 0
    let still = 0
    env.ANAS.pollJob('pve1', 'J', {
      onComplete: function () { completes++ },
      onStillRunning: function () { still++ },
    })
    await env.advanceTo(60000) // well past the 15 s default
    assert('c: onComplete NOT called while running', completes === 0)
    assert('c: onStillRunning once at maxMs', still === 1)
    assert('c: still polling', env.jobPolls() > 15)
  }

  // --- d: 404 → terminal lost ----------------------------------------------
  {
    const env = makeEnv(function () { return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no job' } } } })
    let lostErr = 'none'
    let failed = 0
    env.ANAS.pollJob('pve1', 'J', {
      onLost: function (e) { lostErr = e },
      onFailed: function () { failed++ },
    })
    await env.advanceTo(300000)
    assert('d: onLost called with the 404', lostErr && lostErr.status === 404)
    assert('d: onFailed NOT called when onLost given', failed === 0)
    assert('d: alert shown', count(env.alerts) === 1
      && contains(env.alerts[0].msg, 'The node no longer knows this job'))
    assert('d: polling stopped', env.jobPolls() === 1)
  }
  {
    const env = makeEnv(function () { return { status: 404, body: {} } })
    let failedArg = 'none'
    let failedCalls = 0
    env.ANAS.pollJob('pve1', 'J', {
      onFailed: function (j) { failedArg = j; failedCalls++ },
    })
    await env.advanceTo(300000)
    assert('d: without onLost → onFailed(null) once', failedCalls === 1 && failedArg === null)
  }

  // --- e: two network errors then success → resumes, 1 s and 2 s observed --
  {
    let polls = 0
    const env = makeEnv(function () {
      polls++
      if (polls <= 2) return netErr()
      return polls >= 4 ? done() : run()
    })
    let completes = 0
    env.ANAS.pollJob('pve1', 'J', { onComplete: function () { completes++ } })
    await env.advanceTo(60000)
    // Schedule: 500 (poll1 err) → 1000 (poll2 err) → 2000 (poll3 ok) → 500
    // (normal cadence) → completed.
    assert('e: retry delays 1 s then 2 s',
      env.scheduledDelays().join(',') === '500,1000,2000,500')
    assert('e: resumed and completed once', completes === 1)
    assert('e: four polls total', env.jobPolls() === 4)
  }

  // --- f: 60 s of errors → lost contact, onFailed(null), <what> encoded ----
  {
    const env = makeEnv(netErr)
    let failedArg = 'none'
    let failedCalls = 0
    env.ANAS.pollJob('pve1', 'J', {
      what: '<i>scrub tank</i>',
      onFailed: function (j) { failedArg = j; failedCalls++ },
    })
    await env.advanceTo(300000)
    assert('f: onFailed(null) once', failedCalls === 1 && failedArg === null)
    assert('f: one lost-contact alert', count(env.alerts) === 1
      && contains(env.alerts[0].msg, 'Lost contact with the node')
      && contains(env.alerts[0].msg, 'it may still be running'))
    assert('f: <what> HTML-encoded in the alert',
      contains(env.alerts[0].msg, '&lt;i&gt;scrub tank&lt;/i&gt;')
      && !contains(env.alerts[0].msg, '<i>scrub tank</i>'))
    assert('f: polling stopped', env.jobPolls() === 10)
    // No successful poll for 60 s: the terminal fired on the first failure
    // after the 60 s window opened (500+1000+2000+4000+8000+10000·n ms).
    assert('f: terminal after ≥ 60 s of failures',
      env.scheduledDelays().reduce(function (a, d) { return a + d }, 0) >= 60000)
  }

  // --- g: view destroyed → silent stop, no callbacks -----------------------
  {
    const env = makeEnv(run)
    const view = { destroyed: false }
    let called = 0
    env.ANAS.pollJob('pve1', 'J', {
      view,
      onComplete: function () { called++ },
      onFailed: function () { called++ },
      onLost: function () { called++ },
      onStillRunning: function () { called++ },
    })
    await env.advanceTo(1200)
    const before = env.jobPolls()
    assert('g: polled while alive', before >= 2)
    view.destroyed = true
    await env.advanceTo(300000)
    assert('g: no polls after destroy', env.jobPolls() === before)
    assert('g: no callbacks', called === 0)
    assert('g: silent — no toast, no alert',
      count(env.toasts) === 0 && count(env.alerts) === 0)
  }

  // --- h: cancel-run flow toasts "Run cancelled" only on completed ---------
  {
    let polls = 0
    const env = makeEnv(function (method) {
      if (method === 'POST') return { status: 202, body: { job: { id: 'J', status: 'running', operation: 'job.cancel' } } }
      polls++
      return polls >= 3 ? done() : run()
    })
    // The confirm window is UI; the flow under test is what it hands to the
    // gateway: run the captured opts through the real runJob → pollJob.
    env.ANAS.confirmAndRun = env.ANAS.runJob
    let reloads = 0
    env.ANAS.sched.cancelRun({
      node: 'pve1',
      jobId: 'J',
      name: 'nightly',
      view: null,
      reload: function () { reloads++ },
    })
    await env.advanceTo(1200) // two running polls in (next due at 1500)
    assert('h: no "Run cancelled" toast while the cancel job runs',
      !env.toasts.some(function (t) { return contains(t, 'Run cancelled') }))
    await env.advanceTo(60000)
    const cancelledToasts = env.toasts.filter(function (t) { return contains(t, 'Run cancelled') })
    assert('h: "Run cancelled" toasted once on completed', count(cancelledToasts) === 1)
    assert('h: toast names the task', count(cancelledToasts) === 1 && contains(cancelledToasts[0], 'nightly'))
    assert('h: reload ran', reloads >= 1)
    assert('h: three polls', env.jobPolls() === 3)
  }

  if (!failures) {
    console.log('All pollJob checks passed')
  }
  else {
    process.exitCode = 1
  }
}

main().catch(function (e) {
  console.error('FAIL: harness error', e)
  process.exitCode = 1
})
