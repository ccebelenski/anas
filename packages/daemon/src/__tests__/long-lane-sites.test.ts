import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * cr.33 (WAVE3-DESIGN §4.3): the data movers ride the LONG lane, which may
 * fill at most 3 of the queue's 4 slots, so a short verb is never stuck behind
 * four of them. cr.49 (ruled 2026-10-15): a job that only WATCHES work it
 * started elsewhere — the Run-Now supervisor — rides the WATCH lane, its own
 * slots beyond the 4, so the direct run its unit submits never waits behind
 * it. Every `jobQueue.submit` that passes a `lane` is listed here, in the
 * `null-sites.test.ts` idiom: a new long or watch submit — or a data mover
 * that forgot its lane — is a visible diff.
 *
 * The scan parses the daemon's non-test sources with the TypeScript compiler
 * (no text heuristics): a call `<x>.submit(op, submitter, handler, opts)` on
 * a receiver named `jobQueue`, its operation as written, and the `lane` of
 * `opts` when it is an object literal: a string literal is one lane, a
 * conditional of two string literals is both (the Run-Now door submits its
 * supervisor and its direct run from one call, `direct ? 'long' : 'watch'`).
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Every long-lane submit: file (relative to packages/daemon/src) and the operation as written. */
const LONG_SITES: { file: string, operation: string }[] = [
  // cr.38 session B (§4.3): the AHR long verbs — hours of md and btrfs work
  // each, so they ride the long lane too.
  { file: 'routes/ahr-expand.ts', operation: `'ahr.readd'` },
  { file: 'routes/ahr-mutate.ts', operation: `'ahr.mirror-reconcile'` },
  { file: 'routes/ahr-mutate.ts', operation: `'ahr.parity-rewrite'` },
  { file: 'routes/ahr-mutate.ts', operation: `'ahr.repair'` },
  { file: 'routes/ahr-mutate.ts', operation: `'ahr.scrub'` },
  { file: 'routes/backup.ts', operation: `'backup.restore.files'` },
  { file: 'routes/backup.ts', operation: `'backup.restore.image'` }, // in place
  { file: 'routes/backup.ts', operation: `'backup.restore.image'` }, // to a new LUN
  { file: 'routes/backup.ts', operation: `'backup.task.run'` }, // the direct run (its supervisor is in WATCH_SITES)
  { file: 'routes/cloud.ts', operation: `'cloud.task.run'` }, // the direct run (its supervisor is in WATCH_SITES)
  { file: 'routes/replication.ts', operation: `'zfs.replicate'` },
  // The one expansion driver: expand, guided replace, resume and the boot
  // re-attach (`ahr.expand`, `ahr.replace`, `ahr.expand.resume`), by argument.
  { file: 'services/ahr-expand-resume.ts', operation: 'operation' },
]

/**
 * Every watch-lane submit (cr.49), the lane as written, and why it only
 * watches. A watch job takes no lock claims (the queue refuses one at submit).
 */
const WATCH_SITES: { file: string, operation: string, lane: string, reason: string }[] = [
  {
    file: 'routes/backup.ts',
    operation: `'backup.task.run'`,
    lane: `direct ? 'long' : 'watch'`,
    reason: 'the Run-Now supervisor (!direct): starts the task\'s unit and polls `systemctl show` until it ends; the unit submits the direct run (long) back to the daemon',
  },
  {
    file: 'routes/cloud.ts',
    operation: `'cloud.task.run'`,
    lane: `direct ? 'long' : 'watch'`,
    reason: 'the Run-Now supervisor (!direct): starts the task\'s unit and polls `systemctl show` until it ends; the unit submits the direct run (long) back to the daemon',
  },
]

/** The lanes a `lane:` initializer can take: a string literal, or both branches of a conditional of two. */
function lanesOf(init: ts.Expression): string[] {
  if (ts.isStringLiteral(init))
    return [init.text]
  if (ts.isConditionalExpression(init) && ts.isStringLiteral(init.whenTrue) && ts.isStringLiteral(init.whenFalse))
    return [init.whenTrue.text, init.whenFalse.text]
  return [init.getText()]
}

/**
 * Submits that LOOK like runs but are short, and why — so a reader of this
 * table sees they were weighed, not missed.
 *  - `replication.task.run`: `systemctl start --no-block`, returns at once; the
 *    run itself arrives as a `zfs.replicate` job (long).
 *  - `schedule.run`: one snapshot and a retention prune — seconds.
 */
const SHORT_RUNS = new Set([`'replication.task.run'`, `'schedule.run'`])

/** An operation that names a run, a send or a restore (`prune-preview` is not one). */
const RUN_SHAPED = /\brun\b|replicate|restore/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'fixtures')
        continue
      out.push(...sources(path))
    }
    else if (entry.name.endsWith('.ts')) {
      out.push(path)
    }
  }
  return out
}

interface Site { file: string, operation: string, lane: string | null, lanes: string[] }

function submitSites(path: string): Site[] {
  const text = readFileSync(path, 'utf8')
  const file = relative(SRC, path)
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'submit'
      && node.expression.expression.getText(source) === 'jobQueue') {
      const [op, , , opts] = node.arguments
      let lane: string | null = null
      let lanes: string[] = []
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const prop of opts.properties) {
          if (ts.isPropertyAssignment(prop) && prop.name.getText(source) === 'lane') {
            lane = prop.initializer.getText(source)
            lanes = lanesOf(prop.initializer)
          }
        }
      }
      out.push({ file, operation: op ? op.getText(source) : '', lane, lanes })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function byKey(a: { file: string, operation: string }, b: { file: string, operation: string }): number {
  return a.file.localeCompare(b.file) || a.operation.localeCompare(b.operation)
}

describe('cr.33 / cr.49: the long lane holds every data mover, the watch lane every run supervisor, and nothing else', () => {
  const all = sources(SRC).flatMap(submitSites)

  it('the scan sees the queue\'s callers (a parser that found nothing would pass the table vacuously)', () => {
    assert.ok(all.length > 90, `found ${all.length} submits`)
  })

  it('the long table and the source agree, site for site', () => {
    const found = all.filter(s => s.lanes.includes('long')).map(({ file, operation }) => ({ file, operation }))
    found.sort(byKey)
    const want = [...LONG_SITES]
    want.sort(byKey)
    assert.deepEqual(found, want)
    assert.ok(all.filter(s => s.lane !== null).every(s => s.lanes.every(l => l === 'long' || l === 'watch')), 'a lane is only ever spelled long or watch')
  })

  it('cr.49: the watch table and the source agree, site for site and lane as written', () => {
    const found = all.filter(s => s.lanes.includes('watch')).map(({ file, operation, lane }) => ({ file, operation, lane }))
    found.sort(byKey)
    const want = WATCH_SITES.map(({ file, operation, lane }) => ({ file, operation, lane }))
    want.sort(byKey)
    assert.deepEqual(found, want)
    assert.ok(WATCH_SITES.every(s => s.reason.length > 0), 'every watch site says why it only watches')
  })

  it('cr.49: every Run-Now supervisor (superviseRun) sits in a watch-lane submit', () => {
    // The supervisors are the jobs whose body calls `superviseRun` — the door
    // that starts a task's unit and polls it. Each file that calls it submits
    // through a site in WATCH_SITES, so a new supervisor cannot land in the
    // long lane unseen.
    const supervising = sources(SRC)
      .filter(path => path.includes('/routes/') && /\bsuperviseRun\(/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path))
    supervising.sort()
    const watched = [...new Set(WATCH_SITES.map(s => s.file))]
    watched.sort()
    assert.deepEqual(supervising, watched)
  })

  it('every run-shaped submit is either long or named here as short with its reason', () => {
    const runs = all.filter(s => RUN_SHAPED.test(s.operation))
    // The AHR long verbs (cr.38) are long without being run-shaped by name.
    const runShapedLong = LONG_SITES.filter(s => RUN_SHAPED.test(s.operation)).length
    assert.ok(runs.length >= runShapedLong + SHORT_RUNS.size, 'the run-shaped filter matches the known runs')
    const unweighed = runs.filter(s => s.lane === null && !SHORT_RUNS.has(s.operation))
    assert.deepEqual(unweighed, [])
  })
})
