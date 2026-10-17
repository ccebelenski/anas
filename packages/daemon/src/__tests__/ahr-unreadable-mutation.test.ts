import type { MockExecutor } from '../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { mockFixtures } from '../fixtures/loader.js'
import { MDSTAT_CAT_ARGS } from '../parsers/mdstat.js'
import { createServer } from '../server.js'

/**
 * cr.64c (cr.63 (g)) — an AHR MUTATION route whose guard-gate topology read
 * fails: the reads (routes/ahr.ts, routes/scrub.ts) already answer a failed
 * `mdadm --detail` 503 UNAVAILABLE with the read's sentence; a mutation that
 * cannot see the arrays used to answer a bare 500 (the daemon's error handler
 * mapped only JobForbidden and CommandTimeout). Same fact, same code, same
 * sentence.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const MDSTAT_ONE_ARRAY = [
  'Personalities : [raid1] ',
  'md127 : active raid1 sdd1[1] sdc1[0]',
  '      2086912 blocks super 1.2 [2/2] [UU]',
  '      ',
  'unused devices: <none>',
  '',
].join('\n')

describe('cr.64c: a mutation whose guard-gate AHR topology read fails is 503 UNAVAILABLE', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('POST /v1/ahr/:name/scrub with a failing `mdadm --detail` answers 503 UNAVAILABLE with the read sentence — not 500', async () => {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // The arrays are there to SEE (mdstat names md127) but the per-array read
    // fails — the guard gate's `readAhrPools` throws before any gate runs.
    mock.clearFixtures()
    mock.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: MDSTAT_ONE_ARRAY, stderr: '', exitCode: 0 } })
    mock.addFixture({
      command: '/usr/sbin/mdadm',
      argsMatch: a => a[0] === '--detail',
      result: { stdout: '', stderr: 'mdadm: cannot open /dev/md127: No such file or directory', exitCode: 1 },
    })
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/t2/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 503)
    const body = res.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'UNAVAILABLE')
    // The read's own sentence, word for word (the routes/ahr.ts idiom).
    assert.match(body.error.message, /^the AHR topology could not be read \(mdadm --detail --export \/dev\/md127 exited 1: mdadm: cannot open/)
    // Nothing was submitted: no job queue entry for the failed gate.
    const jobs = await server.inject({ method: 'GET', url: '/v1/jobs', headers: IDENTITY_HEADERS })
    assert.deepEqual((jobs.json() as { data: unknown[] }).data, [])
  })

  // cr.64b2-iii (Q, cr.63 review): the scrub gate's OWN mdstat read
  // (`runningAhrCheck`, the foreignCheckGate at routes/ahr-mutate.ts:1075) had
  // no exit check — a failed read answered "no check running" and let a scrub
  // start beside a check it could not see. Same fact as the topology read
  // above: the typed unreadable error, the same 503, the same sentence. The
  // stock dev mock carries the readable `ahr0` topology; the prepended
  // sequence answers the pool-view read first (result 1) and the gate's read
  // second (result 2). The failing stderr line is the one
  // services/__tests__/ahr-topology.test.ts pins for a failed `cat /proc/mdstat`.
  it('POST /v1/ahr/:name/scrub with the gate\'s mdstat read failing (exit 1) answers 503 UNAVAILABLE naming the read', async () => {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({
      command: '/usr/bin/cat',
      args: MDSTAT_CAT_ARGS,
      results: [
        mockFixtures.ahrMdstat(),
        { stdout: '', stderr: 'cat: /proc/mdstat: Permission denied', exitCode: 1 },
      ],
    })
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 503)
    const body = res.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'UNAVAILABLE')
    assert.equal(
      body.error.message,
      'the AHR topology could not be read (cat /proc/mdstat exited 1: cat: /proc/mdstat: Permission denied)',
    )
    const jobs = await server.inject({ method: 'GET', url: '/v1/jobs', headers: IDENTITY_HEADERS })
    assert.deepEqual((jobs.json() as { data: unknown[] }).data, [])
  })

  // The ENOENT rule copied from `readAhrPools`: an ABSENT /proc/mdstat is
  // honestly "no md arrays" — no check can run — and the gate passes as it
  // does today. (Result 3 restores the clean read for the submitted job's own
  // mdstat reads, so the 202's job is not failed by the scripted absence.)
  it('POST /v1/ahr/:name/scrub with an ABSENT /proc/mdstat at the gate passes as today (202)', async () => {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({
      command: '/usr/bin/cat',
      args: MDSTAT_CAT_ARGS,
      results: [
        mockFixtures.ahrMdstat(),
        { stdout: '', stderr: 'cat: /proc/mdstat: No such file or directory', exitCode: 1 },
        mockFixtures.ahrMdstat(),
      ],
    })
    const res = await server.inject({ method: 'POST', url: '/v1/ahr/ahr0/scrub', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 202, res.body)
    const { job } = res.json() as { job: { operation: string } }
    assert.equal(job.operation, 'ahr.scrub')
  })
})
