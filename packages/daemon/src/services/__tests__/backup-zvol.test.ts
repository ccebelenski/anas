import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  parseSnapdevProperty,
  snapdevGetArgs,
  snapdevRestoreArgs,
  withZvolSnapshotDevices,
  zvolSnapshotDevice,
} from '../backup-zvol.js'
import { ZFS } from '../zfs-snapshot.js'

/**
 * backup2.4 — publishing a zvol's SNAPSHOT DEVICE, and putting the property back
 * exactly as it was.
 *
 * The whole point of this module is GT-46: `zfs set snapdev=hidden` is not a
 * restore. It leaves `source=local` where there was `source=default`, so a
 * backup would permanently change a property on somebody else's volume. The
 * cycle is therefore read → (maybe) set → use → `zfs inherit`, and the tests
 * below pin each half of that.
 */

const UDEVADM = '/usr/bin/udevadm'
const VOLUME = 'tank/vol1'
const DEVICE = '/dev/zvol/tank/vol1'
const LABEL = 'anas-backup-nightly-1787686116'
const SNAP_DEVICE = `${DEVICE}@${LABEL}`

/** `zfs get -Hp -o name,value,source snapdev <vol>` output, as ZFS prints it. */
function snapdev(value: string, source: string): string {
  return `${VOLUME}\t${value}\t${source}\n`
}

/** A mock whose `zfs get` answers with the given property row. */
function wire(value: string, source: string): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({
    command: ZFS,
    args: snapdevGetArgs(VOLUME),
    result: { stdout: snapdev(value, source), stderr: '', exitCode: 0 },
  })
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: UDEVADM, result: { stdout: '', stderr: '', exitCode: 0 } })
  return mock
}

/** Every `zfs <verb>` argv, in call order. */
function zfsArgs(mock: MockExecutor): string[][] {
  return mock.calls.filter(c => c.command === ZFS).map(c => c.args)
}

const SOURCES = [{ volume: VOLUME, device: DEVICE, label: LABEL }]
/** The node is there on the first poll — the normal case (GT-44: ~10 ms). */
const PRESENT = { deviceExists: async () => true, attempts: 3, intervalMs: 0 }

describe('snapdev — the snapshot device (backup2.4)', () => {
  it('the snapshot device path is <device>@<label>', () => {
    assert.equal(zvolSnapshotDevice(DEVICE, LABEL), SNAP_DEVICE)
  })

  it('the get argv is the captured one: structured, one row, value AND source', () => {
    assert.deepEqual(snapdevGetArgs(VOLUME), ['get', '-Hp', '-o', 'name,value,source', 'snapdev', VOLUME])
  })

  it('parses the property row, and returns null for anything else', () => {
    assert.deepEqual(parseSnapdevProperty(snapdev('hidden', 'default')), { value: 'hidden', source: 'default' })
    assert.deepEqual(parseSnapdevProperty(snapdev('visible', 'inherited from tank')), { value: 'visible', source: 'inherited from tank' })
    assert.equal(parseSnapdevProperty(''), null)
    assert.equal(parseSnapdevProperty('no tabs here\n'), null)
    // The exact bytes of the real capture (zvol-snapdev.txt).
    assert.deepEqual(
      parseSnapdevProperty('gtbackup/vol1\thidden\tlocal\n'),
      { value: 'hidden', source: 'local' },
    )
  })

  it('the restore is `zfs inherit` for every INHERITED source (GT-46)', () => {
    for (const source of ['default', 'inherited from tank', 'received', 'temporary']) {
      assert.deepEqual(
        snapdevRestoreArgs(VOLUME, { value: 'hidden', source }),
        ['inherit', 'snapdev', VOLUME],
        source,
      )
    }
  })

  it('the restore is `zfs set <exact prior value>` when it was LOCAL', () => {
    assert.deepEqual(
      snapdevRestoreArgs(VOLUME, { value: 'hidden', source: 'local' }),
      ['set', 'snapdev=hidden', VOLUME],
    )
    // Not always `hidden`: the EXACT prior value goes back.
    assert.deepEqual(
      snapdevRestoreArgs(VOLUME, { value: 'visible', source: 'local' }),
      ['set', 'snapdev=visible', VOLUME],
    )
  })

  it('publish → settle → use → INHERIT, in that order', async () => {
    const mock = wire('hidden', 'default')
    const warnings: string[] = []
    const seen: string[] = []
    const out = await withZvolSnapshotDevices(mock, SOURCES, async (devices) => {
      seen.push(devices.get(VOLUME) as string)
      return 'done'
    }, warnings, () => {}, PRESENT)

    assert.equal(out, 'done')
    assert.deepEqual(seen, [SNAP_DEVICE])
    assert.deepEqual(zfsArgs(mock), [
      snapdevGetArgs(VOLUME),
      ['set', 'snapdev=visible', VOLUME],
      ['inherit', 'snapdev', VOLUME],
    ])
    // udev owns the symlink, so `settle` runs before the node is trusted.
    const order = mock.calls.map(c => `${c.command} ${c.args[0]}`)
    assert.ok(order.indexOf(`${UDEVADM} settle`) > order.indexOf(`${ZFS} set`), order.join(' | '))
    assert.deepEqual(warnings, [])
  })

  it('a LOCAL prior value is restored exactly, never `inherit`', async () => {
    const mock = wire('hidden', 'local')
    const warnings: string[] = []
    await withZvolSnapshotDevices(mock, SOURCES, async () => 0, warnings, () => {}, PRESENT)
    assert.deepEqual(zfsArgs(mock).at(-1), ['set', 'snapdev=hidden', VOLUME])
  })

  it('a volume ALREADY visible is left completely alone — no set, no restore', async () => {
    const mock = wire('visible', 'local')
    const warnings: string[] = []
    await withZvolSnapshotDevices(mock, SOURCES, async () => 0, warnings, () => {}, PRESENT)
    // Only the read. ANAS restores what ANAS changed, and it changed nothing.
    assert.deepEqual(zfsArgs(mock), [snapdevGetArgs(VOLUME)])
    assert.deepEqual(warnings, [])
  })

  it('the property is restored even when the wrapped work THROWS', async () => {
    const mock = wire('hidden', 'default')
    const warnings: string[] = []
    await assert.rejects(
      () => withZvolSnapshotDevices(mock, SOURCES, async () => {
        throw new Error('pbc died')
      }, warnings, () => {}, PRESENT),
      /pbc died/,
    )
    assert.deepEqual(zfsArgs(mock).at(-1), ['inherit', 'snapdev', VOLUME])
  })

  it('a FAILED restore is a warning naming the exact command, never a failure', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: snapdevGetArgs(VOLUME),
      result: { stdout: snapdev('hidden', 'default'), stderr: '', exitCode: 0 },
    })
    mock.addFixture({ command: ZFS, args: ['set', 'snapdev=visible', VOLUME], result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['inherit', 'snapdev', VOLUME], result: { stdout: '', stderr: 'dataset is busy', exitCode: 1 } })
    mock.addFixture({ command: UDEVADM, result: { stdout: '', stderr: '', exitCode: 0 } })
    const warnings: string[] = []
    const out = await withZvolSnapshotDevices(mock, SOURCES, async () => 'ok', warnings, () => {}, PRESENT)
    assert.equal(out, 'ok')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /could not be restored/)
    assert.match(warnings[0], /zfs inherit snapdev tank\/vol1/)
  })

  it('an UNREADABLE property changes nothing and fails loudly (no unrestorable change)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: ZFS,
      args: snapdevGetArgs(VOLUME),
      result: { stdout: '', stderr: 'cannot open \'tank/vol1\': dataset does not exist', exitCode: 1 },
    })
    const warnings: string[] = []
    await assert.rejects(
      () => withZvolSnapshotDevices(mock, SOURCES, async () => 0, warnings, () => {}, PRESENT),
      /will not change a property it cannot restore/,
    )
    assert.deepEqual(zfsArgs(mock), [snapdevGetArgs(VOLUME)])
  })

  it('a node that never appears fails the run — and still restores the property', async () => {
    const mock = wire('hidden', 'default')
    const warnings: string[] = []
    await assert.rejects(
      () => withZvolSnapshotDevices(mock, SOURCES, async () => 0, warnings, () => {}, {
        deviceExists: async () => false,
        attempts: 2,
        intervalMs: 0,
      }),
      /never appeared/,
    )
    assert.deepEqual(zfsArgs(mock).at(-1), ['inherit', 'snapdev', VOLUME])
  })

  it('the node is polled, not assumed present the instant `zfs set` returns (GT-44)', async () => {
    const mock = wire('hidden', 'default')
    let polls = 0
    const warnings: string[] = []
    await withZvolSnapshotDevices(mock, SOURCES, async () => 0, warnings, () => {}, {
      deviceExists: async () => {
        polls++
        return polls >= 3
      },
      attempts: 5,
      intervalMs: 0,
    })
    assert.equal(polls, 3)
  })

  it('no sources at all is a straight pass-through — nothing is read or set', async () => {
    const mock = new MockExecutor()
    const warnings: string[] = []
    const out = await withZvolSnapshotDevices(mock, [], async devices => devices.size, warnings, () => {}, PRESENT)
    assert.equal(out, 0)
    assert.deepEqual(mock.calls, [])
  })
})
