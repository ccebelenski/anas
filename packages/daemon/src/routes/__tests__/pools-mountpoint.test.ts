import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Poll a job until it reaches a terminal state. */
async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** Record every command/args pair the mock executor issues. */
function spyExecutor(server: ReturnType<typeof createServer>): Array<{ command: string, args: string[] }> {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  const calls: Array<{ command: string, args: string[] }> = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return orig(command, args)
  }
  return calls
}

function createCall(calls: Array<{ command: string, args: string[] }>): string[] | undefined {
  return calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'create')?.args
}

// --- Create-time mountpoint override (story 3.27) --------------------------
describe('create pool: mountpoint override (3.27)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('passes -m <mountpoint> to zpool create when overridden', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        name: 'newpool',
        dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }],
        mountpoint: '/srv/tank',
      }),
    })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.deepEqual(createCall(calls), [
      'create',
      '-m',
      '/srv/tank',
      'newpool',
      'mirror',
      '/dev/disk/by-id/d1',
      '/dev/disk/by-id/d2',
    ])
  })

  it('omits -m entirely when no mountpoint is given (ZFS default /<pool>)', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }] }),
    })
    assert.equal(res.statusCode, 202)
    await waitForJob(server, (res.json() as JobAccepted).job.id)
    const args = createCall(calls)!
    assert.ok(!args.includes('-m'), 'no -m flag')
  })

  it('rejects a /mnt/pve mountpoint (reserved) with 400 — never creates', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }], mountpoint: '/mnt/pve/foo' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.equal(createCall(calls), undefined)
  })

  it('rejects a relative / legacy / none mountpoint at the schema boundary (400)', async () => {
    const s = createServer({ mock: true, logger: false })
    server = s
    for (const mountpoint of ['not/absolute', 'legacy', 'none']) {
      const res = await s.inject({
        method: 'POST',
        url: '/v1/pools',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }], mountpoint }),
      })
      assert.equal(res.statusCode, 400, mountpoint)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR', mountpoint)
    }
  })

  it('rejects a mountpoint already serving a live mount with 409', async () => {
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)
    // The AHR findmnt fixture mounts /mnt/anas-ahr/ahr0 — a live-mount collision.
    const res = await server.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }], mountpoint: '/mnt/anas-ahr/ahr0' }),
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
    assert.equal(createCall(calls), undefined)
  })
})

// --- Change mountpoint (PUT /v1/pools/:name/mountpoint) --------------------
describe('change pool mountpoint: PUT /v1/pools/:name/mountpoint (3.27)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('401 without identity headers', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ mountpoint: '/srv/newhome' }),
    })
    assert.equal(res.statusCode, 401)
  })

  it('404 for an unknown pool', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/nosuch/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: '/srv/newhome' }),
    })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error.code, 'NOT_FOUND')
  })

  it('400 for a reserved /mnt/pve mountpoint', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: '/mnt/pve/x' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('400 when the target equals the pool current mountpoint', async () => {
    server = createServer({ mock: true, logger: false })
    // The mock reports testpool mounted at /testpool.
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: '/testpool' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
  })

  it('409 when the target collides with a live mount', async () => {
    server = createServer({ mock: true, logger: false })
    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: '/mnt/anas-ahr/ahr0' }),
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFLICT')
  })

  it('409 confirm (with child-inherit + explicit-child warnings), then 202 → zfs set mountpoint', async () => {
    server = createServer({ mock: true, logger: false })
    // A child dataset with its OWN explicit mountpoint (source local) — the
    // confirm text must state it stays put while inheriting children move.
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.addFixture({
      command: '/usr/sbin/zfs',
      args: ['get', '-Hp', '-r', '-o', 'name,value,source', 'mountpoint', 'testpool'],
      result: { stdout: 'testpool\t/testpool\tdefault\ntestpool/media\t/mnt/media\tlocal\n', stderr: '', exitCode: 0 },
    })
    const calls = spyExecutor(server)

    const first = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: '/srv/newhome' }),
    })
    assert.equal(first.statusCode, 409)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    const code = first.headers['x-anas-confirm-code'] as string
    assert.ok(code, 'a confirm code is issued')
    const warnings: string[] = first.json().error.warnings
    // Inheriting children move with the pool root.
    assert.ok(warnings.some(w => /inherit/i.test(w) && /move with the pool root/i.test(w)), 'inherit-move warning present')
    // A child with its own explicit mountpoint stays put.
    assert.ok(warnings.some(w => /explicit mountpoint/i.test(w) && /stay where they are/i.test(w) && w.includes('testpool/media')), 'explicit-child stays-put warning present')
    // Nothing executed at the 409 stage.
    assert.ok(!calls.some(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set'), 'no zfs set before confirm')

    const second = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: { ...JSON_HEADERS, 'x-anas-confirm': code },
      payload: JSON.stringify({ mountpoint: '/srv/newhome' }),
    })
    assert.equal(second.statusCode, 202)
    const job = await waitForJob(server, (second.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.operation, 'zpool.mountpoint')
    // The mechanic is ZFS-native — a single `zfs set mountpoint=<path> <pool>`.
    const setCall = calls.find(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set')
    assert.deepEqual(setCall?.args, ['set', 'mountpoint=/srv/newhome', 'testpool'])
  })
})

// --- PVE-managed hands-off (story 3.25 scope guard) ------------------------
describe('change pool mountpoint: PVE-managed pools are hands-off (3.27 / 3.25)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_STORAGE_CFG
    if (dir)
      await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('400s for a pool PVE manages (storage.cfg zfspool entry names it)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-pools-3-27-'))
    const cfg = join(dir, 'storage.cfg')
    await writeFile(cfg, 'zfspool: local-zfs\n\tpool testpool\n\tcontent images,rootdir\n')
    process.env.ANAS_STORAGE_CFG = cfg
    server = createServer({ mock: true, logger: false })
    const calls = spyExecutor(server)

    const res = await server.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint: '/srv/newhome' }),
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, /PVE/)
    assert.ok(!calls.some(c => c.command === '/usr/sbin/zfs' && c.args[0] === 'set'), 'never runs zfs set')
  })
})
