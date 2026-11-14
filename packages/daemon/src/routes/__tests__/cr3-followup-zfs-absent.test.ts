import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { createServer } from '../../server.js'
import { guardReplicationTarget, readLocalPoolExistence } from '../../services/replication-target.js'

/**
 * cr3.followup item 8 — the readers that still ran `zpool list` raw ignored
 * the wave's "ZFS is not available on this node" rule (parsers/zpool-list.ts
 * `execZpool` + `zfsUnavailableReason`): on an AHR-only node without the ZFS
 * module, `GET /v1/scrub` answered 503 for the WHOLE view (AHR rows
 * included), a dataset list said "not found", a schedule create said the
 * pool does not exist, and the replication target read could not tell "no
 * ZFS" from a failed read. A missing `zfs` binary made `GET /v1/pools` a bare
 * 500. The world here is libzfs_init's own answer with the module absent.
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const r = (exitCode: number, stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode })
/** libzfs_init with the module not loadable (OpenZFS 2.4.x zpool_main.c). */
const NO_MODULE_ANSWER = r(1, '', 'The ZFS modules cannot be auto-loaded.\nTry running \'modprobe zfs\' as root to manually load them.\n')
const MODULE_ABSENT = { command: '/usr/bin/test', args: ['-d', '/sys/module/zfs'], result: r(1, '') }
const MODULE_PRESENT = { command: '/usr/bin/test', args: ['-d', '/sys/module/zfs'], result: r(0, '') }
const STATEMENT = /^ZFS is not available on this node: The ZFS modules cannot be auto-loaded\./

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

/** The dev server (its AHR pool ahr0 seeded) with every zpool read answering libzfs_init's refusal. */
function noZfsServer(module: 'absent' | 'present' = 'absent'): ReturnType<typeof createServer> {
  const server = createServer({ mock: true, logger: false })
  const mock = mockOf(server)
  for (const args of [['list', '-j'], ['status', '-jv'], ['list', '-H', '-o', 'name']])
    mock.prependFixture({ command: ZPOOL, args, result: NO_MODULE_ANSWER })
  mock.prependFixture(module === 'absent' ? MODULE_ABSENT : MODULE_PRESENT)
  return server
}

describe('cr3.followup — GET /v1/scrub on a node without the ZFS module', () => {
  it('answers 200: the AHR rows, no ZFS rows, and the statement', async () => {
    const server = noZfsServer()
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/scrub', headers: IDENTITY })
      assert.equal(res.statusCode, 200, res.body)
      const body = res.json() as { data: { target: { kind: string, pool: string } }[], zfsUnavailable?: string }
      assert.ok(body.data.some(s => s.target.kind === 'ahr' && s.target.pool === 'ahr0'), JSON.stringify(body.data))
      assert.ok(!body.data.some(s => s.target.kind === 'zfs'))
      assert.match(body.zfsUnavailable ?? '', STATEMENT)
    }
    finally {
      await server.close()
    }
  })

  it('a failed read (module PRESENT) stays 503, never "no ZFS pools"', async () => {
    const server = noZfsServer('present')
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/scrub', headers: IDENTITY })
      assert.equal(res.statusCode, 503, res.body)
    }
    finally {
      await server.close()
    }
  })

  it('PUT /scrub/zfs/:pool refuses 409 zfs-unavailable with the statement', async () => {
    const server = noZfsServer()
    try {
      const res = await server.inject({ method: 'PUT', url: '/v1/scrub/zfs/tank', headers: JSON_HEADERS, payload: JSON.stringify({ enabled: true }) })
      assert.equal(res.statusCode, 409, res.body)
      const error = (res.json() as { error: { reason?: string, message: string } }).error
      assert.equal(error.reason, 'zfs-unavailable')
      assert.match(error.message, STATEMENT)
    }
    finally {
      await server.close()
    }
  })
})

describe('cr3.followup — GET /v1/pools/<name>/datasets on a node without the ZFS module', () => {
  it('refuses 409 zfs-unavailable with the statement (was: 404 "not found")', async () => {
    const server = noZfsServer()
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/pools/tank/datasets', headers: IDENTITY })
      assert.equal(res.statusCode, 409, res.body)
      const error = (res.json() as { error: { reason?: string, message: string } }).error
      assert.equal(error.reason, 'zfs-unavailable')
      assert.match(error.message, STATEMENT)
    }
    finally {
      await server.close()
    }
  })

  it('a failed read (module PRESENT) is 503, never "not found"', async () => {
    const server = noZfsServer('present')
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/pools/tank/datasets', headers: IDENTITY })
      assert.equal(res.statusCode, 503, res.body)
    }
    finally {
      await server.close()
    }
  })
})

describe('cr3.followup — schedules on a node without the ZFS module', () => {
  const SCHEDULE = { id: 'nightly-media', name: 'Nightly media', target: { kind: 'zfs', dataset: 'tank/media' }, cadence: 'daily', retention: { daily: 7 }, recursive: false, enabled: true }

  async function withDir<T>(fn: (server: ReturnType<typeof createServer>) => Promise<T>, module: 'absent' | 'present' = 'absent'): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-followup-sched-'))
    const prev = process.env.ANAS_SYSTEMD_DIR
    process.env.ANAS_SYSTEMD_DIR = dir
    const server = noZfsServer(module)
    try {
      return await fn(server)
    }
    finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
      if (prev === undefined)
        delete process.env.ANAS_SYSTEMD_DIR
      else
        process.env.ANAS_SYSTEMD_DIR = prev
    }
  }

  it('GET /v1/schedules still answers (it reads no pool list)', async () => {
    await withDir(async (server) => {
      const res = await server.inject({ method: 'GET', url: '/v1/schedules', headers: IDENTITY })
      assert.equal(res.statusCode, 200, res.body)
    })
  })

  it('a ZFS schedule create refuses 409 zfs-unavailable with the statement (was: 400 "does not exist")', async () => {
    await withDir(async (server) => {
      const res = await server.inject({ method: 'POST', url: '/v1/schedules', headers: JSON_HEADERS, payload: JSON.stringify(SCHEDULE) })
      assert.equal(res.statusCode, 409, res.body)
      const error = (res.json() as { error: { reason?: string, message: string } }).error
      assert.equal(error.reason, 'zfs-unavailable')
      assert.match(error.message, STATEMENT)
    })
  })

  it('a failed pool list (module PRESENT) refuses 503, never "does not exist"', async () => {
    await withDir(async (server) => {
      const res = await server.inject({ method: 'POST', url: '/v1/schedules', headers: JSON_HEADERS, payload: JSON.stringify(SCHEDULE) })
      assert.equal(res.statusCode, 503, res.body)
      assert.doesNotMatch(res.body, /does not exist/)
    }, 'present')
  })
})

describe('cr3.followup — the local replication target read on a node without the ZFS module', () => {
  function world(module: 'absent' | 'present'): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: NO_MODULE_ANSWER })
    mock.addFixture(module === 'absent' ? MODULE_ABSENT : MODULE_PRESENT)
    return mock
  }

  it('answers "no such pool" WITH the statement', async () => {
    const answer = await readLocalPoolExistence(world('absent'), 'backup')
    assert.equal(answer.ok, true)
    assert.ok(answer.ok && !answer.exists)
    assert.match((answer as { zfsUnavailable?: string }).zfsUnavailable ?? '', STATEMENT)
  })

  it('the guard says the pool does not exist BECAUSE ZFS is not available', async () => {
    const mock = world('absent')
    const result = await guardReplicationTarget({
      transport: { resolveLocation: async () => ({ ok: true, resolved: null }) } as never,
      poolExists: (pool: string) => readLocalPoolExistence(mock, pool),
      pveFootprint: async () => ({ ownershipOf: () => null, claimedByPve: () => null }) as never,
    } as never, { target: { pool: 'backup', dataset: 'media' } as never, sourceFull: 'tank/media', targetFull: 'backup/media' })
    assert.equal(result.ok, false)
    assert.match((result as { message: string }).message, /^Target pool 'backup' does not exist: ZFS is not available on this node/)
  })

  it('a failed read (module PRESENT) is { ok: false }, never "absent"', async () => {
    const answer = await readLocalPoolExistence(world('present'), 'backup')
    assert.equal(answer.ok, false)
  })
})

describe('cr3.followup — GET /v1/pools with no zfs binary', () => {
  it('is the ZFS-unavailable empty, never a bare 500', async () => {
    const server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    const enoent = (cmd: string) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT', path: cmd })
    mock.prependFixture({ command: ZPOOL, throws: enoent(ZPOOL) })
    for (const args of [['list', '-j'], ['status', '-jv'], ['upgrade']])
      mock.prependFixture({ command: ZPOOL, args, result: r(0, ''), throws: enoent(ZPOOL) })
    mock.prependFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint,mounted'], result: r(0, ''), throws: enoent(ZFS) })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/pools', headers: IDENTITY })
      assert.equal(res.statusCode, 200, res.body)
      const body = res.json() as { data: unknown[], zfsUnavailable?: string }
      assert.deepEqual(body.data, [])
      assert.match(body.zfsUnavailable ?? '', /ZFS is not available on this node/)
    }
    finally {
      await server.close()
    }
  })

  it('another spawn failure of zfs is a 503 sentence, never a bare 500', async () => {
    const server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    const eacces = Object.assign(new Error(`spawn ${ZFS} EACCES`), { code: 'EACCES', path: ZFS })
    mock.prependFixture({ command: ZFS, args: ['list', '-H', '-o', 'name,mountpoint,mounted'], result: r(0, ''), throws: eacces })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/pools', headers: IDENTITY })
      assert.equal(res.statusCode, 503, res.body)
      assert.match(res.body, /zfs/)
    }
    finally {
      await server.close()
    }
  })
})
