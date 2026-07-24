import type { AhrCapacity, AhrExpansionIntent } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { ahrBootScan } from '../ahr-boot-scan.js'
import { readIntent, writeIntent } from '../ahr-intent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')

/** The GT-8 shape: md127 inactive, every member `(S)`. */
const MDSTAT_INACTIVE_SPARES = readFileSync(join(fixturesDir, 'mdstat-inactive-spares.txt'), 'utf-8')

const MDSTAT_HEALTHY_RESHAPE = `Personalities : [raid1] [raid5]
md127 : active raid5 sde1[4] sdd1[3] sdc1[1] sdb1[0]
      3134976 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]
      [====>................]  reshape = 23.5% (245000/1044992) finish=8.0min speed=2048K/sec

unused devices: <none>
`

const EXPORT_R1 = [
  'MD_LEVEL=raid5',
  'MD_DEVICES=4',
  'MD_METADATA=1.2',
  'MD_UUID=aaaaaaaa:bbbbbbbb:cccccccc:dddddddd',
  'MD_DEVNAME=ahr0-r1',
  'MD_NAME=anas-pve:ahr0-r1', // homehost-prefixed (GT-3)
  '',
].join('\n')

const CAP: AhrCapacity = {
  rawBytes: 0,
  usableBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

function mkIntent(state: AhrExpansionIntent['state']): AhrExpansionIntent {
  return { id: randomUUID(), trigger: 'add-disk', approvedDisks: ['ata-A'], before: CAP, after: CAP, state }
}

function mdstatFixture(executor: MockExecutor, text: string): void {
  executor.addFixture({ command: '/usr/bin/cat', args: [...MDSTAT_CAT_ARGS], result: { stdout: text, stderr: '', exitCode: 0 } })
}

const MDADM = '/usr/sbin/mdadm'

describe('ahr-boot-scan (GT-8 recovery + orphaned intents + reshape observation)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-boot-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('(a) drives the verified ladder for an inactive all-spares array and notifies', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_INACTIVE_SPARES)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_R1, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: MDADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgchange', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.recovered, ['ahr0-r1'])

    // The ladder, in order, gentlest first — and nothing else md-mutating.
    const ladder = executor.calls
      .filter(c => (c.command === MDADM && c.args[0] !== '--detail') || c.command === '/usr/sbin/vgchange')
      .map(c => [c.command, ...c.args])
    assert.deepEqual(ladder, [
      [MDADM, '--run', '/dev/md127'],
      [MDADM, '--readwrite', '/dev/md127'],
      ['/usr/sbin/vgchange', '-ay', 'ahr0'],
    ])
    // One PVE warning naming what happened.
    const warnings = executor.calls.filter(c => c.command === '/usr/bin/perl' && c.args[2] === 'warning')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].args[4], /mdadm --run/)
    assert.match(warnings[0].args[4], /vgchange -ay ahr0/)
  })

  it('(b) flips a running intent to halted and notifies that Resume is needed', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, 'unused devices: <none>\n')
    executor.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
    await writeIntent('tank', mkIntent('running'), { dir })
    await writeIntent('vault', mkIntent('halted'), { dir }) // already halted — untouched

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.haltedIntents, ['tank'])
    assert.equal((await readIntent('tank', dir))?.state, 'halted')
    assert.equal((await readIntent('vault', dir))?.state, 'halted')
    const warnings = executor.calls.filter(c => c.command === '/usr/bin/perl' && c.args[2] === 'warning')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].args[4], /Resume/)
  })

  it('(c) observes a healthy reshape WITHOUT issuing any command (kernel owns it)', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_HEALTHY_RESHAPE)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: EXPORT_R1, stderr: '', exitCode: 0 } })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.observedReshapes, ['ahr0-r1'])
    assert.deepEqual(report.recovered, [])
    // Observation only: reads, never a mutation, never a re-issued reshape.
    const mutating = executor.calls.filter(c =>
      (c.command === MDADM && c.args[0] !== '--detail') || c.command === '/usr/sbin/vgchange')
    assert.deepEqual(mutating, [])
  })

  it('ignores foreign (non-AHR-named) arrays entirely', async () => {
    const executor = new MockExecutor()
    mdstatFixture(executor, MDSTAT_INACTIVE_SPARES)
    executor.addFixture({ command: MDADM, args: ['--detail', '--export', '/dev/md127'], result: { stdout: 'MD_NAME=somebox:data\nMD_LEVEL=raid5\n', stderr: '', exitCode: 0 } })

    const report = await ahrBootScan(executor, { intentDir: dir, log: () => {} })
    assert.deepEqual(report.recovered, [])
    const mutating = executor.calls.filter(c => c.command === MDADM && c.args[0] !== '--detail')
    assert.deepEqual(mutating, [])
  })
})
