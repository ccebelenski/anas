import type { ReplicationTask } from '@anas/shared'
import type { TargetNamesResolver } from '../replication-units.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { zfsSnapshotDetailArgs } from '../../parsers/zfs-list.js'
import { deriveTaskStatus } from '../replication-units.js'

/**
 * cr3 REPLICATION-L6 = INVENTED-STATE-M5 (the cross-cutting sweep's
 * repl-lag.mts is the first test here): a LOCAL target whose snapshot listing
 * FAILED read as "never replicated" — `snapshotsBehind` = every source
 * snapshot, `lastReplicated*` null — and the grid showed amber "N behind".
 * A listing that could not be read is UNKNOWN (null); ZFS's own "dataset does
 * not exist" is still the truth "nothing replicated yet".
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/zfs')
const SNAPS = readFileSync(join(FIXTURES, 'zfs-snapshots-media.json'), 'utf-8')
// The same snapshot names on the target (a fully replicated target).
const TARGET = SNAPS.replaceAll('testpool/media', 'backup/media').replaceAll('"pool": "testpool"', '"pool": "backup"')

const task = {
  name: 'nightly',
  source: { pool: 'testpool', dataset: 'media' },
  target: { pool: 'backup', dataset: 'media' },
  schedule: 'daily',
  snapshotFirst: true,
  enabled: true,
  notify: 'on-failure',
} as ReplicationTask

function executorWith(target: { stdout: string, stderr: string, exitCode: number }, source = { stdout: SNAPS, stderr: '', exitCode: 0 }): MockExecutor {
  const m = new MockExecutor()
  m.clearFixtures()
  m.addFixture({ command: '/usr/sbin/zfs', args: zfsSnapshotDetailArgs('testpool/media'), result: source })
  m.addFixture({ command: '/usr/sbin/zfs', args: zfsSnapshotDetailArgs('backup/media'), result: target })
  return m
}

describe('cr3 — task lag from a listing that could not be read is unknown', () => {
  it('a readable, fully replicated target: current (the control)', async () => {
    const s = await deriveTaskStatus(executorWith({ stdout: TARGET, stderr: '', exitCode: 0 }), task)
    assert.equal(s.lastReplicatedSnapshot, 'snap2')
    assert.equal(s.snapshotsBehind, 0)
  })

  it('the probe: a LOCAL target listing that FAILED reads unknown, never "every snapshot behind"', async () => {
    const s = await deriveTaskStatus(executorWith({ stdout: '', stderr: 'cannot iterate filesystems: I/O error', exitCode: 1 }), task)
    assert.equal(s.snapshotsBehind, null)
    assert.equal(s.lastReplicatedSnapshot, null)
    assert.equal(s.lastReplicatedAt, null)
  })

  it('a target ZFS says does not exist is "nothing replicated yet": every source snapshot behind', async () => {
    const s = await deriveTaskStatus(executorWith({ stdout: '', stderr: 'cannot open \'backup/media\': dataset does not exist', exitCode: 1 }), task)
    assert.equal(s.snapshotsBehind, 2)
    assert.equal(s.lastReplicatedSnapshot, null)
  })

  it('a SOURCE listing that failed leaves the lag unknown too', async () => {
    const s = await deriveTaskStatus(
      executorWith({ stdout: TARGET, stderr: '', exitCode: 0 }, { stdout: '', stderr: 'cannot iterate filesystems: I/O error', exitCode: 1 }),
      task,
    )
    assert.equal(s.snapshotsBehind, null)
  })

  it('a non-local target the resolver could not read stays unknown (null passes through)', async () => {
    const remoteTask = { ...task, target: { ...task.target, location: { kind: 'remote', name: 'nas1' } } } as ReplicationTask
    const unreadable: TargetNamesResolver = async () => null
    const s = await deriveTaskStatus(executorWith({ stdout: '', stderr: 'unused', exitCode: 1 }), remoteTask, unreadable)
    assert.equal(s.snapshotsBehind, null)
  })
})
