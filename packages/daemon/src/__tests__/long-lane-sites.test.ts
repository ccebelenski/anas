import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * cr.33 (WAVE3-DESIGN §4.3): the data movers and the supervisors of their runs
 * ride the LONG lane, which may fill at most 3 of the queue's 4 slots, so a
 * short verb is never stuck behind four of them. Every `jobQueue.submit` that
 * passes `lane: 'long'` is listed here, in the `null-sites.test.ts` idiom: a
 * new long submit — or a data mover that forgot its lane — is a visible diff.
 *
 * The scan parses the daemon's non-test sources with the TypeScript compiler
 * (no text heuristics): a call `<x>.submit(op, submitter, handler, opts)` on
 * a receiver named `jobQueue`, its operation as written, and whether `opts`
 * is an object literal carrying `lane: 'long'`.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Every long-lane submit: file (relative to packages/daemon/src) and the operation as written. */
const LONG_SITES: { file: string, operation: string }[] = [
  { file: 'routes/backup.ts', operation: `'backup.restore.files'` },
  { file: 'routes/backup.ts', operation: `'backup.restore.image'` }, // in place
  { file: 'routes/backup.ts', operation: `'backup.restore.image'` }, // to a new LUN
  { file: 'routes/backup.ts', operation: `'backup.task.run'` }, // the Run-Now supervisor and the direct run
  { file: 'routes/cloud.ts', operation: `'cloud.task.run'` }, // the Run-Now supervisor and the direct run
  { file: 'routes/replication.ts', operation: `'zfs.replicate'` },
]

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

interface Site { file: string, operation: string, lane: string | null }

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
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const prop of opts.properties) {
          if (ts.isPropertyAssignment(prop) && prop.name.getText(source) === 'lane')
            lane = prop.initializer.getText(source)
        }
      }
      out.push({ file, operation: op ? op.getText(source) : '', lane })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function byKey(a: { file: string, operation: string }, b: { file: string, operation: string }): number {
  return a.file.localeCompare(b.file) || a.operation.localeCompare(b.operation)
}

describe('cr.33: the long lane — every data mover and run supervisor, and nothing else', () => {
  const all = sources(SRC).flatMap(submitSites)

  it('the scan sees the queue\'s callers (a parser that found nothing would pass the table vacuously)', () => {
    assert.ok(all.length > 90, `found ${all.length} submits`)
  })

  it('the table and the source agree, site for site', () => {
    const found = all.filter(s => s.lane !== null).map(({ file, operation }) => ({ file, operation }))
    found.sort(byKey)
    const want = [...LONG_SITES]
    want.sort(byKey)
    assert.deepEqual(found, want)
    assert.ok(all.filter(s => s.lane !== null).every(s => s.lane === `'long'`), 'a lane is only ever spelled long')
  })

  it('every run-shaped submit is either long or named here as short with its reason', () => {
    const runs = all.filter(s => RUN_SHAPED.test(s.operation))
    assert.ok(runs.length >= LONG_SITES.length + SHORT_RUNS.size, 'the run-shaped filter matches the known runs')
    const unweighed = runs.filter(s => s.lane === null && !SHORT_RUNS.has(s.operation))
    assert.deepEqual(unweighed, [])
  })
})
