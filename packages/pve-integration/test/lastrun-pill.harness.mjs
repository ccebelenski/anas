#!/usr/bin/env node
/*
 * ANAS — Last-run pill harness (0.4.2 test-review C9).
 *
 * taskstatus.1: after a reboot, a task whose verdict did not survive (the
 * timer's stamp says it ran, nothing says how) reads
 * `{ lastRunResult: 'unknown', lastRunNote: 'ran at …; result not retained
 * across the reboot' }`. Each of the four grids — Backup (68-backup.js), Cloud
 * Sync (72-cloud.js), Snapshot Schedules (69-snapshots.js) and Replication
 * (65-replication.js) — renders that as the shared muted "result not retained"
 * pill (ANAS.sched.notRetainedPill, 69-schedules-common.js) with the note as
 * its tooltip. This loads the REAL sources and renders the REAL cell:
 *
 *   • unknown + note, overdue false → the pill, the note as the tooltip;
 *   • unknown + note, overdue true  → Snapshot Schedules and Replication keep
 *     the pill (their overdue flag lives in the Next run column); Backup and
 *     Cloud Sync show their "overdue" pill instead, exactly as an overdue
 *     success does there (overdue = treated as failed outranks every verdict
 *     but failure/running/disabled/never-run);
 *   • unknown WITHOUT a note renders as before taskstatus.1 (each grid's own
 *     fallback), never the not-retained pill.
 *
 *   node packages/pve-integration/test/lastrun-pill.harness.mjs
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

// ---- A permissive ExtJS stub ------------------------------------------------
// The four sources only DEFINE things at load time (functions, view
// registrations); nothing here renders a component. Any Ext member is a
// callable that answers another stub, so a load-time Ext.* reference never
// throws, and the cells under test are plain string builders.
function htmlEncode(v) {
  return String(v).replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function permissive() {
  const fn = function () { return proxy }
  const proxy = new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) { return () => '' }
      if (key === 'then') { return undefined }
      // The one Ext member the cells use: ANAS.enc → Ext.String.htmlEncode.
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
    console,
    Promise,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }
  // Bundle order, as the page loads them.
  for (const file of ['00-core.js', '10-api.js', '69-schedules-common.js', '65-replication.js', '68-backup.js', '69-snapshots.js', '72-cloud.js'])
    vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  return win.ANAS
}

const ANAS = loadUi()

const NOTE = 'ran at 2026-10-05 02:00 UTC; result not retained across the reboot'
const RAN_AT = '2026-10-05T02:00:07.000Z'

/** A grid record stand-in: `get(k)` over a plain object. */
function rec(fields) {
  return { get: k => fields[k], store: null }
}

const GRIDS = [
  // name, renderer, the time field the row carries, does overdue outrank the note?
  { name: 'backup', render: ANAS.backup && ANAS.backup.renderLastRun, overdueWins: true },
  { name: 'cloud', render: ANAS.cloud && ANAS.cloud.renderLastRun, overdueWins: true },
  { name: 'snapshots', render: ANAS.schedules && ANAS.schedules.renderLastRun, overdueWins: false },
  { name: 'replication', render: ANAS.replication && ANAS.replication.renderLastRun, overdueWins: false },
]

ok('the shared pill helper is the real one', typeof (ANAS.sched && ANAS.sched.notRetainedPill) === 'function')

for (const g of GRIDS) {
  ok(`${g.name}: the Last run renderer is reachable`, typeof g.render === 'function')
  if (typeof g.render !== 'function') { continue }
  const cell = fields => g.render(fields.lastRunResult, {}, rec(fields))

  // --- unknown + note, not overdue → the pill, the note as its tooltip -----
  const fresh = cell({ name: 't', lastRunResult: 'unknown', lastRunNote: NOTE, lastRunAt: RAN_AT, lastReplicatedAt: null, overdue: false })
  ok(`${g.name}: unknown + note reads "result not retained"`, /result not retained/.test(fresh), fresh)
  ok(`${g.name}: …with the note as the tooltip`, fresh.includes(`title="${NOTE}"`), fresh)
  ok(`${g.name}: …and never as a success or a failure`, !/>success</.test(fresh) && !/>failure</.test(fresh), fresh)

  // --- unknown + note, overdue ---------------------------------------------
  const late = cell({ name: 't', lastRunResult: 'unknown', lastRunNote: NOTE, lastRunAt: RAN_AT, lastReplicatedAt: null, overdue: true })
  if (g.overdueWins) {
    ok(`${g.name}: overdue outranks the note (as it outranks a success here)`, />overdue</.test(late) && !/result not retained/.test(late), late)
  }
  else {
    ok(`${g.name}: overdue leaves the pill (overdue lives in the Next run column)`, /result not retained/.test(late), late)
    ok(`${g.name}: …tooltip intact when overdue`, late.includes(`title="${NOTE}"`), late)
  }

  // --- unknown WITHOUT a note renders as before ------------------------------
  const bare = cell({ name: 't', lastRunResult: 'unknown', lastRunNote: '', lastRunAt: null, lastReplicatedAt: null, overdue: false })
  ok(`${g.name}: unknown without a note never shows the not-retained pill`, !/result not retained/.test(bare), bare)
  const before = g.name === 'snapshots' ? /never run/ : />unknown</
  ok(`${g.name}: …it reads as it did before taskstatus.1`, before.test(bare), bare)
  const bareLate = cell({ name: 't', lastRunResult: 'unknown', lastRunNote: '', lastRunAt: null, lastReplicatedAt: null, overdue: true })
  ok(`${g.name}: unknown without a note, overdue, never shows the not-retained pill`, !/result not retained/.test(bareLate), bareLate)
}

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} last-run pill checks passed`)
