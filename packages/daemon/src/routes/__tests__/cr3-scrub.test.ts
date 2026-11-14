import type { Job, PeriodicScrubState } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { renderScrubServiceUnit, renderScrubTimerUnit } from '../../services/scrub-schedule-units.js'
import { readAhrScrubState, readZfsScrubState, setAhrScrubEnabled } from '../../services/scrub-schedules.js'
import { scrubRoutes } from '../scrub.js'

/**
 * cr3 — the scrub reads that used to invent state, and the node-level unit's
 * lost update:
 *  - POOLS-DISKS-M3: a failed `zpool status -jv` read as "never scrubbed" and
 *    idle on every ZFS row; the rows now say both facts are unknown.
 *  - DATASETS-SCHEDULES-L7: a failed `zfs get org.debian:periodic-scrub`
 *    read as enabled; the row now says enabled is unknown.
 *  - AHR-HEAL (other doors): a failed `btrfs scrub status` read as "not
 *    running"; the row now says running is unknown.
 *  - DATASETS-SCHEDULES-L6: an anas-scrub unit that exists but does not
 *    parse read as "no pools", and a toggle rewrote it dropping the others;
 *    the toggle now refuses and the state says enabled is unknown.
 *  - POOLS-DISKS-M5: two AHR toggles for different pools raced on the one
 *    unit; both now land.
 */

const ZPOOL = '/usr/sbin/zpool'
const ZFS = '/usr/sbin/zfs'
const SYSTEMCTL = '/usr/bin/systemctl'
const IDENTITY = { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify' }
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })

describe('cr3 M3 + L7: GET /scrub says unknown where a ZFS read failed', () => {
  async function getScrub(statusResult: { stdout: string, stderr: string, exitCode: number }, propResult: { stdout: string, stderr: string, exitCode: number }): Promise<PeriodicScrubState[]> {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', properties: {} } } })) })
    ex.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: statusResult })
    ex.addFixture({ command: '/usr/bin/cat', result: ok('Personalities :\nunused devices: <none>\n') })
    ex.addFixture({ command: ZFS, result: propResult })
    const server = Fastify({ logger: false })
    await server.register(scrubRoutes, { prefix: '/v1', executor: ex, jobQueue: new JobQueue(), systemdDir: join(tmpdir(), `anas-cr3-absent-${randomUUID()}`) })
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/scrub', headers: IDENTITY })
      assert.equal(res.statusCode, 200, res.body)
      return res.json().data as PeriodicScrubState[]
    }
    finally {
      await server.close()
    }
  }

  it('a failed `zpool status -jv` is lastScrub and running unknown, never "never scrubbed"', async () => {
    const [row] = await getScrub({ stdout: '', stderr: 'internal error: Interrupted system call', exitCode: 1 }, ok('enable\n'))
    assert.deepEqual(row.unknown, ['lastScrub', 'running'])
    assert.equal(row.lastScrub, null)
    assert.equal(row.running, undefined)
    assert.equal(row.enabled, true)
  })

  it('a failed property read is enabled unknown, never "on"', async () => {
    const [row] = await getScrub(ok(JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', pool_guid: '1', vdevs: {}, error_count: '0' } } })), { stdout: '', stderr: 'I/O error', exitCode: 1 })
    assert.deepEqual(row.unknown, ['enabled'])
  })

  it('every read good: no unknown field at all', async () => {
    const [row] = await getScrub(ok(JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', pool_guid: '1', vdevs: {}, error_count: '0' } } })), ok('disable\n'))
    assert.equal(row.unknown, undefined)
    assert.equal(row.enabled, false)
  })

  it('readZfsScrubState: a throwing property read is enabled unknown', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: ZFS, throws: new Error('EAGAIN') })
    const state = await readZfsScrubState(ex, 'tank')
    assert.deepEqual(state.unknown, ['enabled'])
  })
})

describe('cr3 L6 + M5: the node-level anas-scrub unit', () => {
  let dir: string
  const savedStamp = process.env.ANAS_TIMERS_STAMP_DIR

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-scrub-'))
    process.env.ANAS_TIMERS_STAMP_DIR = dir
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (savedStamp === undefined)
      delete process.env.ANAS_TIMERS_STAMP_DIR
    else
      process.env.ANAS_TIMERS_STAMP_DIR = savedStamp
  })

  function systemctl(): MockExecutor {
    const ex = new MockExecutor()
    ex.addFixture({ command: SYSTEMCTL, args: ['is-enabled', 'anas-scrub.timer'], result: ok('enabled\n') })
    ex.addFixture({ command: SYSTEMCTL, args: ['is-enabled', 'mdcheck_start.timer'], result: { stdout: 'disabled\n', stderr: '', exitCode: 1 } })
    ex.addFixture({ command: SYSTEMCTL, result: ok('') })
    return ex
  }

  /** An ANAS-marked service whose schedule JSON does not parse (a hand edit), beside a good timer. */
  async function corruptUnit(): Promise<string> {
    const good = { kind: 'ahr-scrub' as const, cadence: 'monthly' as const, pools: ['alpha', 'beta'] }
    const service = renderScrubServiceUnit(good).replace('"pools":["alpha","beta"]', '"pools":["alpha","beta"')
    await writeFile(join(dir, 'anas-scrub.service'), service)
    await writeFile(join(dir, 'anas-scrub.timer'), renderScrubTimerUnit(good))
    return service
  }

  it('L6: a toggle over a marked unit that does not parse is refused and the unit is left byte-for-byte', async () => {
    const before = await corruptUnit()
    await assert.rejects(setAhrScrubEnabled(systemctl(), 'gamma', true, { dir }), /could not be read .* refusing to rewrite it/)
    await assert.rejects(setAhrScrubEnabled(systemctl(), 'alpha', false, { dir }), /refusing to rewrite it/)
    assert.equal(await readFile(join(dir, 'anas-scrub.service'), 'utf-8'), before)
  })

  it('L6: the state of a pool over that unit is enabled unknown, with the reason in the note', async () => {
    await corruptUnit()
    const state = await readAhrScrubState(systemctl(), 'alpha', null, { dir })
    assert.deepEqual(state.unknown, ['enabled'])
    assert.match(state.note ?? '', /the anas-scrub unit could not be read/)
  })

  it('AHR: a btrfs running read that failed is running unknown', async () => {
    const state = await readAhrScrubState(systemctl(), 'alpha', 'unknown', { dir })
    assert.deepEqual(state.unknown, ['running'])
    assert.equal(state.running, undefined)
  })

  it('M5: two AHR toggles for different pools both land (the units key serialises them)', async () => {
    // The real queue (4 slots, so both would run at once without a shared
    // key) driving the toggle's body with the claim the route adds — the
    // route's claim set itself is pinned in scrub.test.ts (heldLocks).
    const queue = new JobQueue()
    const ex = systemctl()
    const claim = { key: 'unit:anas-scrub', mode: 'exclusive' as const, what: 'the node\'s anas-scrub timer' }
    const run = (pool: string) => queue.submit('scrub.ahr.toggle', { user: 'root@pam', uid: 0 }, async () => {
      await setAhrScrubEnabled(ex, pool, true, { dir })
      return { pool }
    }, { locks: [claim] })
    const a = run('alpha')
    const b = run('beta')
    for (let i = 0; i < 200 && [a.id, b.id].some(id => !['completed', 'failed'].includes(queue.get(id)?.status ?? '')); i++)
      await new Promise(r => setTimeout(r, 5))
    assert.equal((queue.get(a.id) as Job).status, 'completed')
    assert.equal((queue.get(b.id) as Job).status, 'completed')
    const service = await readFile(join(dir, 'anas-scrub.service'), 'utf-8')
    assert.match(service, /"pools":\["alpha","beta"\]/)
  })
})
