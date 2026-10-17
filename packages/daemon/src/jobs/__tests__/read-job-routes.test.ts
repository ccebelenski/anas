import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { READ_JOB_ROUTES } from '@anas/shared'
import { READ_JOB_OPERATIONS } from '../read-jobs.js'

/**
 * cr.67 (operator ruling 2026-10-17) — the gateway admits a POST on
 * `Sys.Audit` only for paths on the shared `READ_JOB_ROUTES` list, and the
 * daemon declares its read jobs in `READ_JOB_OPERATIONS`. The two lists are
 * one fact in two files, so they may not drift:
 *
 *   - every read operation is submitted by exactly one route source file
 *     under routes/, inside the body of a `server.post` whose literal path
 *     is on the shared list;
 *   - every non-cancel entry of the shared list is registered by exactly one
 *     such file, and that file submits a read job;
 *   - the shared cancel shape wraps the real cancel route, whose id segment
 *     the gateway validates by the job-id rule (see the gateway authz tests).
 *
 * The source-text idiom is the one jobs/read-jobs.ts pins ("no source
 * outside this file spells the prefix"): read the route files with
 * readFileSync, never import the routes.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTES = join(HERE, '..', '..', 'routes')

function routeSources(): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of readdirSync(ROUTES, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.ts'))
      out.set(e.name, readFileSync(join(ROUTES, e.name), 'utf-8'))
  }
  return out
}

/** Every `server.post('<literal path>'` registration, with its byte offset. */
function postRegistrations(text: string): Array<{ path: string, at: number }> {
  const out: Array<{ path: string, at: number }> = []
  for (const m of text.matchAll(/server\.post(?:<[^>]*>)?\(\s*'([^']+)'/g))
    out.push({ path: m[1]!, at: m.index! })
  return out
}

describe('cr.67 READ_JOB_OPERATIONS and the shared READ_JOB_ROUTES list cannot drift', () => {
  const sources = routeSources()

  for (const key of Object.keys(READ_JOB_OPERATIONS)) {
    it(`${key}: exactly one route submits it, inside a registration on the shared list`, () => {
      const marker = `READ_JOB_OPERATIONS.${key}`
      const users = [...sources].filter(([, text]) => text.includes(marker))
      assert.equal(users.length, 1, `${marker} submitted by ${users.length} route files (${users.map(([n]) => n).join(', ')})`)
      const [file, text] = users[0]!
      // The submit lives inside a route body: the last server.post above it.
      const submitAt = text.indexOf(marker)
      const owner = postRegistrations(text).filter(r => r.at < submitAt).at(-1)
      assert.ok(owner, `${marker} in ${file} is not inside a server.post body`)
      assert.ok(
        (READ_JOB_ROUTES.exact as readonly string[]).includes(owner.path),
        `${marker} in ${file} is submitted under '${owner.path}', which is not on the shared READ_JOB_ROUTES list`,
      )
    })
  }

  it('every shared non-cancel path is registered by exactly one route file, and that file submits a read job', () => {
    for (const p of READ_JOB_ROUTES.exact) {
      const registered = [...sources].filter(([, text]) => postRegistrations(text).some(r => r.path === p))
      assert.equal(registered.length, 1, `shared path ${p} registered by ${registered.length} route files`)
      assert.ok(
        registered[0]![1].includes('READ_JOB_OPERATIONS.'),
        `shared path ${p} is registered but its file submits no read job`,
      )
    }
  })

  it('the shared cancel shape wraps the real cancel route', () => {
    const text = sources.get('jobs.ts')
    assert.ok(text, 'routes/jobs.ts exists')
    const reg = postRegistrations(text).find(r => r.path === '/jobs/:id/cancel')
    assert.ok(reg, 'routes/jobs.ts registers POST /jobs/:id/cancel')
    const { prefix, suffix } = READ_JOB_ROUTES.cancel
    assert.ok(
      reg!.path.startsWith(prefix) && reg!.path.endsWith(suffix) && reg!.path.slice(prefix.length, -suffix.length).length > 0,
      `cancel route '${reg!.path}' does not match the shared shape ${prefix}<id>${suffix}`,
    )
  })
})
