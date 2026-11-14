import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { zfsListArgs, zfsSnapshotDetailArgs, zfsSnapshotListArgs, zfsSweepSnapshotListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { DatasetListUnreadableError, SnapshotListUnreadableError } from '../datasets.js'

/**
 * The error the server's error handler saw (it maps by error NAME to 503 —
 * the core builder's `server.ts` change, not in this branch).
 */
function captureErrors(server: ReturnType<typeof createServer>): unknown[] {
  const seen: unknown[] = []
  server.addHook('onError', async (_request, _reply, error) => {
    seen.push(error)
  })
  return seen
}

/**
 * cr3 INVENTED-STATE-L15 (a failed `zfs list` answered an existing pool
 * "no datasets") and INVENTED-STATE-M9 (a failed snapshot read left "N
 * snapshot(s) will also be destroyed" out of the destroy confirm; a recursive
 * destroy never counted its descendants' snapshots). Also the snapshot GETs:
 * a failed read is not "no snapshots".
 */
const ZFS = '/usr/sbin/zfs'
const FAIL = { stdout: '', stderr: 'internal error: Interrupted system call', exitCode: 1 }
const headers = () => ({ 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': randomUUID() })

describe('cr3: dataset and snapshot reads that failed are never "none"', () => {
  let server: ReturnType<typeof createServer> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })
  const mock = () => (server as unknown as { executor: MockExecutor }).executor

  it('L15: GET /pools/:name/datasets answers 503 when `zfs list` fails, never an empty list', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsListArgs('testpool'), result: FAIL })
    const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets', headers: headers() })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.json().error.code, 'UNAVAILABLE')
    assert.match(res.json().error.message, /dataset list of pool 'testpool' could not be read/)
  })

  it('L15: GET .../snapshots answers 503 (not 404) when the dataset list fails, and 503 (not []) when the snapshot read fails', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsListArgs('testpool'), result: FAIL })
    const a = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/snapshots', headers: headers() })
    assert.equal(a.statusCode, 503, a.body)
    await server.close()
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/media'), result: FAIL })
    const b = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/snapshots', headers: headers() })
    assert.equal(b.statusCode, 503, b.body)
  })

  it('a snapshot verb whose listing cannot be read answers 503, never "snapshot not found"', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/media'), result: FAIL })
    const res = await server.inject({ method: 'POST', url: '/v1/pools/testpool/datasets/media/snapshots/snap1/rollback', headers: headers() })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.json().error.code, 'UNAVAILABLE')
  })

  it('M9: a destroy whose snapshot count cannot be read is refused, no confirm minted', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsSnapshotListArgs('testpool/media'), result: FAIL })
    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool/datasets/media', headers: headers() })
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.reason, 'snapshot-count-unreadable')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
  })

  it('M9: a recursive destroy\'s confirm counts the descendants\' snapshots too', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsSweepSnapshotListArgs('testpool/media'), result: { stdout: 'testpool/media@snap1\ntestpool/media@snap2\ntestpool/media/kid@a\ntestpool/media/kid@b\ntestpool/media/kid@c\n', stderr: '', exitCode: 0 } })
    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool/datasets/media?recursive=true', headers: headers() })
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    const warnings = res.json().error.warnings as string[]
    assert.ok(warnings.includes('3 snapshot(s) of its child datasets will also be destroyed.'), warnings.join('\n'))
  })

  // Handed from the replication review: the dependencies this file gives the
  // replication routes (`datasetExists`, `listSnapshotsDetail`) never answer
  // "not found" / "no snapshots" for a read that failed — they throw a typed
  // "could not be read" error (DatasetListUnreadableError /
  // SnapshotListUnreadableError).
  const plan = () => server!.inject({
    method: 'POST',
    url: '/v1/pools/testpool/datasets/media/replicate/plan',
    headers: { ...headers(), 'content-type': 'application/json' },
    payload: JSON.stringify({ target: { pool: 'testpool', dataset: 'copy' } }),
  })

  it('replication source check: a failed dataset list is "could not be read", never "Dataset not found"', async () => {
    server = createServer({ mock: true, logger: false })
    const seen = captureErrors(server)
    mock().prependFixture({ command: ZFS, args: zfsListArgs('testpool'), result: FAIL })
    const res = await plan()
    assert.notEqual(res.statusCode, 404, res.body)
    assert.doesNotMatch(res.body, /not found/)
    assert.match(res.body, /dataset list of pool 'testpool' could not be read/)
    // The class and name the server's 503 mapping keys on.
    assert.equal(seen.length, 1)
    assert.ok(seen[0] instanceof DatasetListUnreadableError)
    assert.equal((seen[0] as Error).name, 'DatasetListUnreadableError')
    assert.equal(res.statusCode, 503, res.body)
  })

  it('replication plan: a failed source snapshot read is "could not be read", never "has no snapshots"', async () => {
    server = createServer({ mock: true, logger: false })
    const seen = captureErrors(server)
    mock().prependFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/media'), result: FAIL })
    const res = await plan()
    assert.notEqual(res.statusCode, 400, res.body)
    assert.doesNotMatch(res.body, /has no snapshots/)
    assert.match(res.body, /snapshots of 'testpool\/media' could not be read/)
    assert.equal(seen.length, 1)
    assert.ok(seen[0] instanceof SnapshotListUnreadableError)
    assert.equal((seen[0] as Error).name, 'SnapshotListUnreadableError')
    assert.equal(res.statusCode, 503, res.body)
  })

  // Second review, item (2): ZFS's own "dataset does not exist" is an ANSWER
  // (404), not a read that failed — only other failures are unreadable.
  const ABSENT = { stdout: '', stderr: 'cannot open \'nopool\': dataset does not exist', exitCode: 1 }

  it('a pool that does not exist answers 404 on the snapshot GET, never 503', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsListArgs('nopool'), result: ABSENT })
    const res = await server.inject({ method: 'GET', url: '/v1/pools/nopool/datasets/x/snapshots', headers: headers() })
    assert.equal(res.statusCode, 404, res.body)
  })

  it('a replication plan on a source pool that does not exist answers 404, never 500', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsListArgs('nopool'), result: ABSENT })
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools/nopool/datasets/x/replicate/plan',
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: JSON.stringify({ target: { pool: 'testpool', dataset: 'copy' } }),
    })
    assert.equal(res.statusCode, 404, res.body)
  })

  it('a snapshot list ZFS says does not exist is an answer (the dataset is gone), not "could not be read"', async () => {
    server = createServer({ mock: true, logger: false })
    mock().prependFixture({ command: ZFS, args: zfsSnapshotDetailArgs('testpool/media'), result: { stdout: '', stderr: 'cannot open \'testpool/media\': dataset does not exist', exitCode: 1 } })
    const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/snapshots', headers: headers() })
    assert.notEqual(res.statusCode, 503, res.body)
  })
})
