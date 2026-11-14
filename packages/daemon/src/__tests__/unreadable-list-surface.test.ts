import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer } from '../server.js'

/**
 * cr3 (handed by cr3.datasets): a dataset or snapshot list that could not be
 * READ (`DatasetListUnreadableError`, `SnapshotListUnreadableError`, thrown by
 * routes/datasets.ts) answers 503 UNAVAILABLE with its own sentence through
 * the server's error handler, like an unreadable AHR topology: never a bare
 * 500. The handler matches by the error's name (no import of the route), so
 * these stand-ins carry exactly the names the route's classes set.
 */
class DatasetListUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatasetListUnreadableError'
  }
}
class SnapshotListUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotListUnreadableError'
  }
}

describe('cr3 an unreadable dataset or snapshot list is a 503 UNAVAILABLE', () => {
  for (const make of [
    () => new DatasetListUnreadableError('The dataset list of pool \'tank\' could not be read (zfs list exited 1: I/O error)'),
    () => new SnapshotListUnreadableError('The snapshots of \'tank/a\' could not be read (zfs list exited 1: I/O error)'),
  ]) {
    const sample = make()
    it(`${sample.name} → 503 UNAVAILABLE with its sentence`, async () => {
      const server = createServer({ mock: true, logger: false })
      server.get('/test/throw', async () => {
        throw make()
      })
      const res = await server.inject({ method: 'GET', url: '/test/throw' })
      assert.equal(res.statusCode, 503)
      assert.deepEqual(res.json().error, { code: 'UNAVAILABLE', message: sample.message })
      await server.close()
    })
  }

  it('any other error still takes the default path (500)', async () => {
    const server = createServer({ mock: true, logger: false })
    server.get('/test/throw', async () => {
      throw new Error('something else')
    })
    const res = await server.inject({ method: 'GET', url: '/test/throw' })
    assert.equal(res.statusCode, 500)
    await server.close()
  })
})
