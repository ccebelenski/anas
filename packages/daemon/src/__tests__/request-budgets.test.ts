import type { Disk } from '@anas/shared'
import type { MockExecutor } from '../executor/mock.js'
import type { ExecOptions } from '../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMMAND_BUDGETS, CommandBudgetExecutor, commandBudgetRow } from '../executor/command-budgets.js'
import { LANE_BUDGET_MS, runInLane, TIMEOUT_WRAPPER_MARGIN_MS } from '../executor/deadline.js'
import { MockExecutor as Mock } from '../executor/mock.js'
import { zfsSnapshotListArgs } from '../parsers/zfs-list.js'
import { createServer } from '../server.js'
import { buildCatalogShellArgs, CATALOG_SHELL_TIMEOUT_S } from '../services/backup-catalog.js'
import { buildSnapshotListArgs } from '../services/backup-reads.js'
import { PBC } from '../services/backup-runner.js'
import { zfsTransientListArgs } from '../services/backup-snapshots.js'
import { PREVIEW_TIMEOUT_S } from '../services/cloud-preview.js'
import { DiskIdentityCache } from '../services/disk-identity-cache.js'
import { PVE_NOTIFY_BUDGET_MS, pveNotify } from '../services/pve-notify.js'
import { PROBE_TIMEOUT_S, probeArgs } from '../services/rclone-probe.js'
import { scanHostKeys } from '../services/replication-remotes.js'
import { buildSshArgv } from '../services/replication-transport.js'
import { zfsStampSourceArgs, zfsTreeSnapshotListArgs } from '../services/snapshot-schedules.js'
import { UDEVADM_SETTLE_ARGS, UDEVADM_SETTLE_BUDGET_MS } from '../services/udev-settle.js'

/**
 * cr.35 — the request-path budgets of WAVE3-DESIGN §6.3 and the request-path
 * conventions of §6.2 ("Gate fails closed, Display fails open and says so,
 * Strict reads name the timeout"), each driven by a command that never
 * answers. The never-answering command is the MockExecutor's `timesOut`
 * fixture: it rejects with the CommandTimeoutError the production executor
 * raises at the end of the call's deadline. Every other output is a capture
 * (ruling (l)): the dev server's seeded fixtures, fixtures/system/*.json.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '..', 'fixtures')

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const SMARTCTL = '/usr/sbin/smartctl'

/** The deadline one argv gets through the daemon's executor (the §6.3 table in front of it), in a lane. */
async function budgetOf(command: string, args: string[], lane: 'request' | 'job' | 'background' = 'request', opts?: ExecOptions): Promise<{ budgetMs: number | null, source: string }> {
  const mock = new Mock()
  const exec = new CommandBudgetExecutor(mock)
  const run = (): Promise<unknown> => exec.exec(command, args, opts)
  if (lane === 'background')
    await run()
  else
    await runInLane(lane === 'job' ? { lane, jobId: 'j1' } : { lane }, run)
  const d = mock.deadlines.at(-1)!
  return { budgetMs: d.budgetMs, source: d.source }
}

describe('cr.35 §6.3 per-command budgets: the table, against the argv the call sites build', () => {
  it('every row matches what its call sites actually run, with its §6.3 budget', async () => {
    const peerSsh = buildSshArgv({ kind: 'peer', host: 'node2' }, ['zpool', 'list', '-H', '-o', 'name'])
    const cases: Array<[string, string, string[], number]> = [
      ['smartctl', SMARTCTL, ['-n', 'standby', '-iH', '--json', '/dev/sda'], 20_000],
      ['smartctl', SMARTCTL, ['-n', 'standby', '-a', '--json', '/dev/sda'], 20_000],
      ['ssh', peerSsh[0], peerSsh.slice(1), 20_000],
      ['ssh-keyscan', '/usr/bin/ssh-keyscan', ['-T', '10', '-p', '22', '--', 'host'], 20_000],
      ['proxmox-backup-client', PBC, buildSnapshotListArgs('vm/100'), 25_000],
      ['zpool import (scan)', ZPOOL, ['import'], 30_000],
      ['zfs snapshot list', ZFS, zfsSnapshotListArgs('tank/a'), 30_000],
      ['zfs snapshot list', ZFS, zfsTreeSnapshotListArgs('tank/a'), 30_000],
      ['zfs snapshot list', ZFS, zfsStampSourceArgs('tank/a'), 30_000],
      ['zfs snapshot list', ZFS, zfsTransientListArgs('tank/a'), 30_000],
      ['zfs send -nP', ZFS, ['send', '-nvP', '--', 'tank/a@s1'], 30_000],
      // routes/mounts.ts listHolders and services/busy-diagnosis.ts diagnoseBusyPath.
      ['lsof', '/usr/bin/lsof', ['+f', '--', '/mnt/anas-nfs'], 10_000],
      ['fuser', '/usr/bin/fuser', ['-m', '/mnt/anas-nfs'], 10_000],
    ]
    for (const [id, cmd, args, budget] of cases) {
      assert.equal(commandBudgetRow(cmd, args)?.id, id, `${cmd} ${args.join(' ')}`)
      assert.deepEqual(await budgetOf(cmd, args), { budgetMs: budget, source: 'call' }, `${cmd} ${args.join(' ')}`)
    }
    // Every row is exercised above.
    assert.deepEqual(new Set(cases.map(c => c[0])), new Set(COMMAND_BUDGETS.map(r => r.id)))
  })

  it('every other read keeps the lane\'s 10 s — a dataset list is not a snapshot list', async () => {
    for (const [cmd, args] of [
      [ZFS, ['list', '-j', '-o', 'name']],
      [ZFS, ['get', '-Hp', 'mountpoint', '--', 'tank']],
      [ZPOOL, ['status', '-jv']],
      [ZPOOL, ['list', '-j']],
      ['/usr/bin/lsblk', ['-J']],
    ] as Array<[string, string[]]>)
      assert.deepEqual(await budgetOf(cmd, args), { budgetMs: LANE_BUDGET_MS.request, source: 'lane' })
  })

  it('a call\'s own budget, a `null` data mover and a timeout wrapper all win over the table', async () => {
    assert.deepEqual(await budgetOf(ZFS, ['send', '-nvP', 'a@b'], 'request', { timeoutMs: 5_000 }), { budgetMs: 5_000, source: 'call' })
    // The catalog shell: pbc under its own `timeout 25`.
    assert.deepEqual(await budgetOf('/usr/bin/timeout', ['25', PBC, 'catalog', 'shell']), { budgetMs: 25_000 + TIMEOUT_WRAPPER_MARGIN_MS, source: 'wrapper' })
    // The send|recv pipeline: no deadline, ended by the ssh keepalives instead.
    const mock = new Mock()
    await runInLane({ lane: 'job', jobId: 'j1' }, () => new CommandBudgetExecutor(mock).pipeline(ZFS, ['send', 'tank/a@s1'], '/usr/bin/ssh', ['root@node2', 'zfs', 'recv', 'b'], { timeoutMs: null, longRunning: 'zfs send|recv' }))
    assert.deepEqual(mock.deadlines.map(d => [d.budgetMs, d.longRunning]), [[null, 'zfs send|recv']])
  })

  it('in a job a snapshot list, an ssh read and a send keep the job lane\'s 300 s; smartctl, ssh-keyscan, lsof and fuser keep their bound everywhere', async () => {
    assert.equal((await budgetOf(ZFS, zfsTreeSnapshotListArgs('tank/a'), 'job')).budgetMs, LANE_BUDGET_MS.job)
    assert.equal((await budgetOf('/usr/bin/ssh', ['-o', 'BatchMode=yes', '--', 'root@node2', 'zfs', 'list'], 'job')).budgetMs, LANE_BUDGET_MS.job)
    assert.equal((await budgetOf(ZFS, ['send', '-nvP', 'a@b'], 'job')).budgetMs, LANE_BUDGET_MS.job)
    assert.equal((await budgetOf(SMARTCTL, ['-n', 'standby', '-iH', '--json', '/dev/sda'], 'job')).budgetMs, 20_000)
    assert.equal((await budgetOf('/usr/bin/ssh-keyscan', ['-T', '10', '-p', '22', '--', 'h'], 'job')).budgetMs, 20_000)
    assert.equal((await budgetOf('/usr/bin/fuser', ['-m', '/x'], 'job')).budgetMs, 10_000)
    assert.equal((await budgetOf('/usr/bin/lsof', ['+f', '--', '/x'], 'job')).budgetMs, 10_000)
    // Boot/background pulls too.
    assert.equal((await budgetOf(SMARTCTL, ['-n', 'standby', '-iH', '--json', '/dev/sda'], 'background')).budgetMs, 20_000)
  })

  it('ssh-keyscan carries `-T 10` and gets its 20 s on the request path', async () => {
    const mock = new Mock()
    await runInLane({ lane: 'request' }, () => scanHostKeys(new CommandBudgetExecutor(mock), 'backup.example', 22))
    assert.deepEqual(mock.deadlines.map(d => [d.args, d.budgetMs]), [
      [['-T', '10', '-p', '22', '--', 'backup.example'], 20_000],
    ])
  })

  it('the daemon runs every route through the table (server.ts wraps its executor)', async () => {
    const server = createServer({ mock: true, logger: false })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.deadlines.length = 0
    const res = await server.inject({ method: 'GET', url: '/v1/pools/import', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(mock.deadlines.map(d => [d.args, d.lane, d.budgetMs]), [[['import'], 'request', 30_000]])
    await server.close()
  })

  it('a PVE notification is bounded at 60 s in any lane; a timeout is a journal warning, never a throw', async () => {
    assert.equal(PVE_NOTIFY_BUDGET_MS, 60_000)
    const mock = new Mock().addFixture({ command: '/usr/bin/perl', timesOut: {} })
    const errors: string[] = []
    const original = console.error
    console.error = (msg: string) => errors.push(msg)
    try {
      await runInLane({ lane: 'job', jobId: 'j1' }, () => pveNotify(mock, 'error', 't', 'm'))
    }
    finally {
      console.error = original
    }
    assert.deepEqual(mock.deadlines.map(d => [d.command, d.budgetMs]), [['/usr/bin/perl', 60_000]])
    assert.equal(errors.length, 1)
    assert.match(errors[0], /^pve-notify: delivery did not finish within 60 s and was stopped — the notification may not have been sent/)
  })

  it('every ssh the daemon runs is built by buildSshArgv (so every one carries the keepalives), the send|recv pipeline included', () => {
    const src = join(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name)
        if (name.isDirectory()) {
          if (name.name !== '__tests__' && name.name !== 'fixtures')
            walk(full)
          continue
        }
        // The transport builds every ssh; the budget table only names the binary to match it.
        if (!name.name.endsWith('.ts') || full.endsWith('replication-transport.ts') || full.endsWith('command-budgets.ts'))
          continue
        if (/'\/usr\/bin\/ssh'/.test(readFileSync(full, 'utf-8')))
          offenders.push(full.slice(src.length + 1))
      }
    }
    walk(src)
    assert.deepEqual(offenders, [])
    const replication = readFileSync(join(src, 'routes', 'replication.ts'), 'utf-8')
    assert.match(replication, /transport\.buildSshArgv\(/)
    const argv = buildSshArgv({ kind: 'remote', host: 'b.example', port: 22, user: 'u', keyPath: '/k', knownHostsFile: '/kh' }, ['zfs', 'recv', 'x'])
    for (const opt of ['ConnectTimeout=10', 'ServerAliveInterval=15', 'ServerAliveCountMax=4'])
      assert.ok(argv.indexOf(opt) > 0 && argv.indexOf(opt) < argv.indexOf('--'), opt)
  })

  it('udevadm settle: `--timeout=60`, and the executor 30 s above it', () => {
    assert.deepEqual([...UDEVADM_SETTLE_ARGS], ['settle', '--timeout=60'])
    assert.equal(UDEVADM_SETTLE_BUDGET_MS, 90_000)
  })

  it('no source file runs `udevadm settle` with an argv of its own (one definition, services/udev-settle.ts)', () => {
    const offenders: string[] = []
    const src = join(__dirname, '..')
    for (const rel of ['services/ahr-cache.ts', 'services/ahr-spare.ts', 'services/ahr-expand-exec.ts', 'services/ahr-create.ts', 'services/backup-zvol.ts']) {
      const text = readFileSync(join(src, rel), 'utf-8')
      if (/UDEVADM, \['settle'/.test(text) || !text.includes('udevSettleArgs()'))
        offenders.push(rel)
    }
    assert.deepEqual(offenders, [])
  })
})

describe('cr.35 Q3 (open): the request-path reads that can exceed 30 s stay synchronous at 25 s', () => {
  it('cloud preview, rclone remote test and the PBS catalog shell: a 25 s `timeout` wrapper each, under AnasProxy\'s 30 s', async () => {
    assert.equal(PREVIEW_TIMEOUT_S, 25)
    assert.equal(PROBE_TIMEOUT_S, 25)
    assert.equal(CATALOG_SHELL_TIMEOUT_S, 25)
    assert.equal(probeArgs('/etc/pve/priv/anas/rclone.conf', 'gt:')[0], '25')
    const shell = buildCatalogShellArgs('host/pve1/2026-10-15T00:00:00Z', 'root.pxar')
    assert.deepEqual([shell.command, shell.args[0]], ['/usr/bin/timeout', '25'])
    // The executor sits 5 s above the wrapper, so exit 124 (the verdict each
    // caller already words) arrives first — at 25 s, before the 30 s cut.
    assert.deepEqual(await budgetOf(shell.command, shell.args), { budgetMs: 30_000, source: 'wrapper' })
  })

  it('each site carries the Q3 marker until the operator rules', () => {
    const src = join(__dirname, '..')
    for (const rel of ['services/cloud-preview.ts', 'services/rclone-probe.ts', 'services/backup-catalog.ts'])
      assert.match(readFileSync(join(src, rel), 'utf-8'), /\/\/ Q3 \(WAVE3-DESIGN §10\): job or sync is the operator's call/, rel)
  })
})

describe('cr.35 the SMART probe: 20 s for the probe, 8 s for the list that waits on it', () => {
  const identityJson = readFileSync(join(FIXTURES, 'system', 'smartctl-ata-identity.json'), 'utf-8')

  it('a probe still running after the wait leaves the list to answer with no reading; its answer lands in the cache later', { timeout: 5_000 }, async () => {
    const mock = new Mock().addFixture({ command: SMARTCTL, live: { signalsToExit: Infinity } })
    const cache = new DiskIdentityCache(mock)
    const started = Date.now()
    await cache.loadMany([{ id: 'ata-X', path: '/dev/sda' }], { waitMs: 30 })
    assert.ok(Date.now() - started < 1_000, 'the list must not wait for the probe')
    // Nothing measured, nothing invented.
    assert.equal(cache.getCached('ata-X'), null)
    // The probe answers (a captured identity) — the next pull has it.
    mock.finishLive({ stdout: identityJson, stderr: '', exitCode: 0 })
    await new Promise(r => setTimeout(r, 5))
    assert.equal(cache.getCached('ata-X')?.smartHealthy, true)
  })

  it('without a wait the list waits for every probe (the job-side callers)', async () => {
    const mock = new Mock().addFixture({ command: SMARTCTL, result: { stdout: identityJson, stderr: '', exitCode: 0 } })
    const cache = new DiskIdentityCache(mock)
    await cache.loadMany([{ id: 'ata-X', path: '/dev/sda' }])
    assert.equal(cache.getCached('ata-X')?.smartHealthy, true)
  })
})

describe('cr.35 request-path conventions with a command that never answers (§6.2)', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function mockServer(): Promise<{ server: ReturnType<typeof createServer>, mock: MockExecutor }> {
    server = createServer({ mock: true, logger: false })
    await server.ready()
    return { server, mock: (server as unknown as { executor: MockExecutor }).executor }
  }

  it('Display: GET /v1/disks with every SMART probe hung is 200 — health `unknown`, probe-failed, never `healthy` on SMART\'s word', async () => {
    const first = await mockServer()
    const before = (await first.server.inject({ method: 'GET', url: '/v1/disks', headers: IDENTITY_HEADERS })).json() as { data: Disk[] }
    // A FRESH daemon (no cached readings) whose smartctl never answers.
    await first.server.close()
    const s2 = await mockServer()
    for (const d of before.data)
      s2.mock.prependFixture({ command: SMARTCTL, args: ['-n', 'standby', '-iH', '--json', d.path], timesOut: {} })
    s2.mock.deadlines.length = 0
    const res = await s2.server.inject({ method: 'GET', url: '/v1/disks', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const { data } = res.json() as { data: Disk[] }
    assert.equal(data.length, before.data.length, 'every disk is still listed')
    // The seeded node has disks outside any pool, whose health is SMART's alone.
    assert.ok(data.some(d => d.status !== 'pool_member'))
    assert.ok(before.data.some(d => d.status !== 'pool_member' && d.healthStatus === 'healthy'), 'with SMART answering, a free disk reads healthy')
    for (const d of data) {
      assert.equal(d.smartHealthy, null, d.path)
      assert.equal(d.smartStaleReason ?? 'probe-failed', 'probe-failed', d.path)
      if (d.status !== 'pool_member')
        assert.equal(d.healthStatus, 'unknown', d.path)
    }
    const probes = s2.mock.deadlines.filter(d => d.command === SMARTCTL)
    assert.ok(probes.length > 0)
    for (const p of probes)
      assert.deepEqual([p.lane, p.budgetMs, p.source], ['request', 20_000, 'call'])
  })

  it('Strict: GET /v1/disks/:id/smart with smartctl hung is 503 TIMEOUT naming it (20 s), not an empty SMART table', async () => {
    const { server, mock } = await mockServer()
    const { data } = (await server.inject({ method: 'GET', url: '/v1/disks', headers: IDENTITY_HEADERS })).json() as { data: Disk[] }
    const disk = data[0]
    mock.prependFixture({ command: SMARTCTL, args: ['-n', 'standby', '-a', '--json', disk.path], timesOut: {} })
    const res = await server.inject({ method: 'GET', url: `/v1/disks/${encodeURIComponent(disk.id)}/smart`, headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 503)
    const body = res.json() as { error: { code: string, message: string, details: { budgetMs: number } } }
    assert.equal(body.error.code, 'TIMEOUT')
    assert.match(body.error.message, /^'smartctl' did not finish within 20 s/)
    assert.equal(body.error.details.budgetMs, 20_000)
  })

  it('Strict: GET /v1/pools/import with the device scan hung is 503 TIMEOUT (30 s) — never `data: []` ("nothing to import")', async () => {
    const { server, mock } = await mockServer()
    mock.prependFixture({ command: ZPOOL, args: ['import'], timesOut: {} })
    const res = await server.inject({ method: 'GET', url: '/v1/pools/import', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 503)
    const body = res.json() as { error: { code: string, message: string, details: { budgetMs: number } } }
    assert.equal(body.error.code, 'TIMEOUT')
    assert.match(body.error.message, /^'zpool import' did not finish within 30 s/)
  })

  it('Gate: a pool destroy whose read hangs is refused 503 TIMEOUT before any confirm code is minted', async () => {
    const { server, mock } = await mockServer()
    mock.clearFixtures()
    mock.addFixture({ command: ZPOOL, timesOut: {} })
    const res = await server.inject({ method: 'DELETE', url: '/v1/pools/testpool', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 503)
    assert.equal((res.json() as { error: { code: string } }).error.code, 'TIMEOUT')
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    // Nothing destructive reached the executor.
    assert.ok(!mock.calls.some(c => c.args[0] === 'destroy'))
  })
})
