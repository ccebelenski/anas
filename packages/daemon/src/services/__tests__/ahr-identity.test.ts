import type { AhrPool } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { parseMdadmConfDoc } from '../../parsers/mdadm-conf.js'
import { mdadmDetailExportArgs, mdadmExamineExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import {
  ahrNameOccupancy,
  canonicalMdUuid,
  classifyPartition,
  isIntentStale,
  isIntentStaleForPool,
  isOwnedArray,
  pinnedUuids,
  poolIntentIdentity,
  readAhrPoolIdentity,
} from '../ahr-identity.js'

/**
 * Story ident.3 — the ONE "is this ours?" helper. A `<pool>-r<N>` name is a
 * convention anyone can reuse; the pins in mdadm.conf, the VG's PVs and the
 * superblock inside a partition are what decide.
 */

const OURS = 'aaaaaaaa:aaaaaaaa:aaaaaaaa:aaaaaaaa'
const FOREIGN = '99999999:99999999:99999999:99999999'

const MDSTAT_TWO_MEDIA = `Personalities : [raid1]
md127 : active raid1 sdc1[1] sdb1[0]
      1047552 blocks super 1.2 [2/2] [UU]

md9 : active raid1 sdq1[1] sdp1[0]
      1047552 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`

function exportFor(name: string, uuid: string): string {
  return `MD_LEVEL=raid1\nMD_DEVICES=2\nMD_METADATA=1.2\nMD_UUID=${uuid}\nMD_NAME=${name}\n`
}

function report(kind: 'vg' | 'pv', rows: object[]): string {
  return JSON.stringify({ report: [{ [kind]: rows }] })
}

describe('pinnedUuids', () => {
  it('counts only ARRAY lines naming the pool — by device or by name=, homehost-tolerant, case-folded', () => {
    const doc = parseMdadmConfDoc([
      '# comment',
      `ARRAY /dev/md/media-r1 metadata=1.2 UUID=${OURS.toUpperCase()}`,
      `ARRAY /dev/md127 metadata=1.2 UUID=bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb name=pve:media-r2`,
      `ARRAY /dev/md/mediax-r1 metadata=1.2 UUID=${FOREIGN}`,
      `ARRAY /dev/md/data metadata=1.2 UUID=cccccccc:cccccccc:cccccccc:cccccccc`,
      '',
    ].join('\n'))
    assert.deepEqual(pinnedUuids(doc, 'media'), new Set([OURS, 'bbbbbbbb:bbbbbbbb:bbbbbbbb:bbbbbbbb']))
    assert.deepEqual([...pinnedUuids(doc, 'mediax')], [FOREIGN])
    assert.equal(pinnedUuids(doc, 'data').size, 0, '`data` is not an AHR name')
  })
})

describe('isOwnedArray — THE rule', () => {
  const facts = { pool: 'media', band: 1, uuid: FOREIGN, kernelName: 'md9' }

  it('a pinned UUID is the pool\'s', () => {
    assert.equal(isOwnedArray({ ...facts, uuid: OURS }, new Set([OURS]), new Set(), true), true)
  })

  it('once the pool is pinned, an UNPINNED same-named array is foreign — even with the VG present', () => {
    assert.equal(isOwnedArray(facts, new Set([OURS]), new Set(), true), false)
  })

  it('a PV of the pool\'s VG is the pool\'s (the fact that survives a failed pin)', () => {
    assert.equal(isOwnedArray(facts, new Set([OURS]), new Set(['/dev/md9']), true), true)
    assert.equal(isOwnedArray(facts, new Set([OURS]), new Set(['/dev/md/media-r1']), true), true)
  })

  it('an UNPINNED pool with its VG present is adopted by name (the pre-ident.3 rule, §5.3)', () => {
    assert.equal(isOwnedArray(facts, new Set(), new Set(), true), true)
  })

  it('no pins and no VG: never the pool\'s', () => {
    assert.equal(isOwnedArray(facts, new Set(), new Set(), false), false)
  })
})

describe('readAhrPoolIdentity / classifyPartition', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-identity-'))
    await writeFile(join(dir, 'mdadm.conf'), `ARRAY /dev/md/media-r1 metadata=1.2 UUID=${OURS}\n`)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function world(): MockExecutor {
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: MDSTAT_TWO_MEDIA, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: { stdout: exportFor('pve:media-r1', OURS), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md9'), result: { stdout: exportFor('otherbox:media-r1', FOREIGN), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/pvs', args: PVS_ARGS, result: { stdout: report('pv', [{ pv_name: '/dev/md127', vg_name: 'media' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: { stdout: report('vg', [{ vg_name: 'media', vg_uuid: 'VG-UUID-1' }]), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmExamineExportArgs('/dev/sdb1'), result: { stdout: exportFor('pve:media-r1', OURS), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmExamineExportArgs('/dev/sdp1'), result: { stdout: exportFor('otherbox:media-r1', FOREIGN), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmExamineExportArgs('/dev/sdz1'), result: { stdout: '', stderr: 'mdadm: No md superblock detected on /dev/sdz1.', exitCode: 1 } })
    return executor
  }

  it('a same-named foreign array is split out: owned = pinned, foreign = the other `media-r1`', async () => {
    const id = await readAhrPoolIdentity(world(), 'media', { mdadmConfPath: join(dir, 'mdadm.conf'), withVgUuid: true })
    assert.deepEqual(id.arrays.map(a => a.dev), ['/dev/md127'])
    assert.deepEqual(id.foreign.map(a => a.kernelName), ['md9'])
    assert.deepEqual([...id.uuids], [OURS])
    assert.equal(id.vgUuid, 'VG-UUID-1')
  })

  it('a partition is ours / foreign / blank by the superblock INSIDE it', async () => {
    const executor = world()
    const id = await readAhrPoolIdentity(executor, 'media', { mdadmConfPath: join(dir, 'mdadm.conf') })
    assert.equal(await classifyPartition(executor, id, '/dev/sdb1'), 'ours')
    assert.equal(await classifyPartition(executor, id, '/dev/sdp1'), 'foreign')
    assert.equal(await classifyPartition(executor, id, '/dev/sdz1'), 'blank')
  })

  it('a pinned pool asks LVM only for its PVs — `vgs` is not read unless asked', async () => {
    const executor = world()
    const id = await readAhrPoolIdentity(executor, 'media', { mdadmConfPath: join(dir, 'mdadm.conf') })
    assert.equal(id.vgUuid, null)
    assert.equal(executor.calls.filter(c => c.command === '/usr/sbin/vgs').length, 0)
  })

  it('a caller\'s own UUIDs (a failed create\'s rollback, before any pin) count as the pool\'s', async () => {
    const executor = world()
    await writeFile(join(dir, 'mdadm.conf'), '')
    // No pins, no VG listing for the pool here → neither array is owned…
    const strict = await readAhrPoolIdentity(executor, 'nopool', { mdadmConfPath: join(dir, 'mdadm.conf') })
    assert.equal(strict.arrays.length, 0)
    // …and an extra UUID admits exactly the array that carries it.
    const id = await readAhrPoolIdentity(executor, 'media', { mdadmConfPath: join(dir, 'mdadm.conf'), extraUuids: [FOREIGN.toUpperCase()] })
    assert.ok(id.arrays.some(a => a.kernelName === 'md9'))
  })
})

describe('ahrNameOccupancy — create refuses an occupied name', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-occupancy-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a free name reads free; an array, a pin and a label each occupy it', async () => {
    const conf = join(dir, 'mdadm.conf')
    await writeFile(conf, `ARRAY /dev/md/pinned-r2 metadata=1.2 UUID=${OURS}\n`)
    const executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: { stdout: MDSTAT_TWO_MEDIA, stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: { stdout: exportFor('pve:media-r1', OURS), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md9'), result: { stdout: exportFor('otherbox:data', FOREIGN), stderr: '', exitCode: 0 } })
    executor.addFixture({ command: '/usr/bin/lsblk', args: ['-J', '-o', 'NAME,PARTLABEL'], result: { stdout: JSON.stringify({ blockdevices: [
      { name: 'sdw', partlabel: null, children: [{ name: 'sdw1', partlabel: 'labelled-d1-b1' }, { name: 'sdw2', partlabel: 'labelled-cache1' }] },
    ] }), stderr: '', exitCode: 0 } })

    assert.deepEqual(await ahrNameOccupancy(executor, 'fresh', { mdadmConfPath: conf }), [])
    assert.match((await ahrNameOccupancy(executor, 'media', { mdadmConfPath: conf })).join(' | '), /media-r1 \(\/dev\/md127\)/)
    assert.match((await ahrNameOccupancy(executor, 'pinned', { mdadmConfPath: conf })).join(' | '), /mdadm\.conf already pins/)
    assert.match((await ahrNameOccupancy(executor, 'labelled', { mdadmConfPath: conf })).join(' | '), /labelled-d1-b1, labelled-cache1/)
    // A prefix is not the name: `label` is free although `labelled-*` exists.
    assert.deepEqual(await ahrNameOccupancy(executor, 'label', { mdadmConfPath: conf }), [])
  })
})

describe('the expansion intent — whose is it?', () => {
  const pool = (uuids: (string | undefined)[], vgUuid?: string): Pick<AhrPool, 'arrays' | 'vg'> => ({
    arrays: uuids.map((uuid, i) => ({
      device: `/dev/md/t-r${i + 1}` as AhrPool['arrays'][number]['device'],
      band: i + 1,
      level: 'raid1' as const,
      heightBytes: 1,
      members: [],
      state: 'clean' as const,
      ...(uuid ? { uuid } : {}),
    })),
    vg: { name: 't', sizeBytes: 0, freeBytes: 0, ...(vgUuid ? { uuid: vgUuid } : {}) },
  })

  it('records the arrays\' UUIDs and the VG UUID it was written for', () => {
    assert.deepEqual(poolIntentIdentity(pool([OURS.toUpperCase(), undefined], 'VG-1')), { arrayUuids: [OURS], vgUuid: 'VG-1' })
    assert.deepEqual(poolIntentIdentity(pool([undefined])), {})
  })

  it('reads STALE against a recreated pool (no shared array, or another VG) — never against its own', () => {
    const recorded = { arrayUuids: [OURS], vgUuid: 'VG-1' }
    assert.equal(isIntentStaleForPool(recorded, pool([OURS], 'VG-1')), false)
    assert.equal(isIntentStaleForPool(recorded, pool([OURS, FOREIGN], 'VG-1')), false, 'an expansion that added a band is still its own')
    assert.equal(isIntentStaleForPool(recorded, pool([FOREIGN], 'VG-1')), true)
    assert.equal(isIntentStaleForPool(recorded, pool([OURS], 'VG-2')), true)
  })

  it('an intent written before ident.3 (nothing recorded) is never stale; nor against an unreadable pool', () => {
    assert.equal(isIntentStale({}, { uuids: [FOREIGN], vgUuid: 'VG-2' }), false)
    assert.equal(isIntentStale({ arrayUuids: [OURS] }, { uuids: [], vgUuid: null }), false)
  })

  it('canonicalMdUuid keeps only well-formed UUIDs, lowercased', () => {
    assert.equal(canonicalMdUuid(OURS.toUpperCase()), OURS)
    assert.equal(canonicalMdUuid('not-a-uuid'), null)
    assert.equal(canonicalMdUuid(null), null)
  })
})
