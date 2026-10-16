import type { MockExecutor } from '../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
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
})
