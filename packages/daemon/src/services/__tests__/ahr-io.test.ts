import type { ExecOptions } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { btrfsUsageArgs } from '../../parsers/btrfs-usage.js'
import { parseDiskstats } from '../../parsers/diskstats.js'
import { LVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { buildAhrPoolTelemetry, collectAhrTelemetry } from '../ahr-io.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../ahr-topology.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
const load = (name: string): string => readFileSync(join(fixturesDir, name), 'utf-8')
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })

// The two genuine stunt-node snapshots (pool `tank`, ~1s apart, 80 MiB write).
const t0 = load('diskstats-tank-t0.txt')
const t1 = load('diskstats-tank-t1.txt')

describe('buildAhrPoolTelemetry — real tank diskstats', () => {
  // The tank topology as resolved at sample time: LV dm-0, band r1 → md127
  // (members sdd1/sdf1/sdg1/sdm1), band r2 → md126 (…2). The spare (sde) is
  // excluded upstream and never appears here.
  const resolved = {
    lv: 'dm-0',
    bands: [
      { band: 1, level: 'raid5' as const, md: 'md127', members: [
        { id: 'disk-d', part: 'sdd1' },
        { id: 'disk-f', part: 'sdf1' },
        { id: 'disk-g', part: 'sdg1' },
        { id: 'disk-m', part: 'sdm1' },
      ] },
      { band: 2, level: 'raid5' as const, md: 'md126', members: [
        { id: 'disk-d', part: 'sdd2' },
        { id: 'disk-f', part: 'sdf2' },
        { id: 'disk-g', part: 'sdg2' },
        { id: 'disk-m', part: 'sdm2' },
      ] },
    ],
  }
  const prev = parseDiskstats(t0)
  const cur = parseDiskstats(t1)

  it('builds the pool → band → member I/O tree with the LV as the pool level', () => {
    const tel = buildAhrPoolTelemetry('tank', resolved, prev, cur, 1000)
    assert.ok(tel, 'pool telemetry produced')
    assert.equal(tel!.name, 'tank')
    // Pool-level = dm-0: the 80 MiB write shows through.
    assert.ok(tel!.writeBytesPerSec > 80 * 1024 * 1024, 'pool LV carries the write')
    assert.equal(tel!.bands.length, 2)

    // Band r1 (md127) took the write; its four members are present, each idle
    // or busy but never fabricated.
    const b1 = tel!.bands.find(b => b.band === 1)!
    assert.equal(b1.level, 'raid5')
    assert.ok(b1.writeBytesPerSec > 0, 'band r1 md carries the write')
    assert.equal(b1.disks.length, 4)
    const sdf = b1.disks.find(d => d.id === 'disk-f')!
    assert.ok(sdf.writeBytesPerSec > 0, 'member sdf1 carries its parity-striped share')

    // Band r2 (md126) was idle in this window → honest zeros + null await.
    const b2 = tel!.bands.find(b => b.band === 2)!
    assert.equal(b2.writeBytesPerSec, 0)
    assert.equal(b2.writeLatencyNs, null)
  })

  it('omits the pool when the LV is unresolvable / absent from diskstats', () => {
    const tel = buildAhrPoolTelemetry('tank', { lv: 'dm-missing', bands: resolved.bands }, prev, cur, 1000)
    assert.equal(tel, null)
    const tel2 = buildAhrPoolTelemetry('tank', { lv: null, bands: resolved.bands }, prev, cur, 1000)
    assert.equal(tel2, null)
  })

  it('drops an unresolvable band member rather than fabricating it', () => {
    const partial = {
      lv: 'dm-0',
      bands: [{ band: 1, level: 'raid5' as const, md: 'md127', members: [
        { id: 'disk-f', part: 'sdf1' },
        { id: 'disk-gone', part: null },
        { id: 'disk-absent', part: 'sdZZZ' },
      ] }],
    }
    const tel = buildAhrPoolTelemetry('tank', partial, prev, cur, 1000)!
    assert.equal(tel.bands[0].disks.length, 1, 'only the resolved+present member survives')
    assert.equal(tel.bands[0].disks[0].id, 'disk-f')
  })
})

describe('collectAhrTelemetry — topology + sample-time resolution', () => {
  /**
   * healthy ahr0 topology, plus a readlink that resolves the LV + both md pins
   *  (partitions left unresolved → members honestly dropped).
   */
  class TelemetryExecutor extends MockExecutor {
    async exec(command: string, args: string[], opts?: ExecOptions) {
      if (command === '/usr/bin/readlink') {
        const path = args.at(-1) ?? ''
        if (path.endsWith('-r1'))
          return ok('/dev/md127\n')
        if (path.endsWith('-r2'))
          return ok('/dev/md126\n')
        if (path.includes('/dev/mapper/'))
          return ok('/dev/dm-0\n')
        return { stdout: '', stderr: '', exitCode: 1 }
      }
      return super.exec(command, args, opts)
    }
  }

  function healthy(): TelemetryExecutor {
    const mock = new TelemetryExecutor()
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok(load('mdstat-clean.txt')) })
    mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: ok(load('mdadm-export-r1.txt')) })
    mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: ok(load('mdadm-export-r2.txt')) })
    mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: ok(load('lsblk-ahr0.json')) })
    mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: ok(load('disk-by-id-ahr.txt')) })
    mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: ok(load('lvm-vgs.json')) })
    mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: ok(load('lvm-lvs.json')) })
    mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: ok(load('findmnt-ahr0.json')) })
    mock.addFixture({ command: '/usr/bin/btrfs', args: btrfsUsageArgs('/mnt/anas-ahr/ahr0'), result: ok(load('btrfs-usage.txt')) })
    return mock
  }

  // Minimal diskstats snapshots carrying the resolved LV + md kernel names.
  const dsPrev = ' 252 0 dm-0 10 0 800 5 20 0 1000 8 0 40 13\n 9 127 md127 8 0 700 4 15 0 900 6 0 30 10\n 9 126 md126 3 0 200 2 1 0 40 1 0 5 3\n'
  const dsCur = ' 252 0 dm-0 12 0 900 7 120 0 200000 60 0 90 80\n 9 127 md127 9 0 760 5 118 0 199000 55 0 85 70\n 9 126 md126 3 0 200 2 1 0 40 1 0 5 3\n'

  it('produces a name-matched AHR pool with pool + band I/O from the sample', async () => {
    const pools = await collectAhrTelemetry(healthy(), dsPrev, dsCur, 1000)
    assert.equal(pools.length, 1)
    const ahr0 = pools[0]
    assert.equal(ahr0.name, 'ahr0')
    // dm-0 write delta 200000 - 1000 = 199000 sectors → non-zero pool write.
    assert.ok(ahr0.writeBytesPerSec > 0, 'pool LV I/O derived')
    assert.equal(ahr0.bands.length, 2)
    assert.ok(ahr0.bands.some(b => b.writeBytesPerSec > 0), 'the busy band md carries I/O')
    // Members were left unresolved (readlink exit 1) → dropped, never faked.
    for (const b of ahr0.bands)
      assert.equal(b.disks.length, 0)
  })

  it('fail-open: no diskstats → [] (never disturbs the rest of telemetry)', async () => {
    assert.deepEqual(await collectAhrTelemetry(healthy(), null, dsCur, 1000), [])
    assert.deepEqual(await collectAhrTelemetry(healthy(), dsPrev, null, 1000), [])
  })

  it('fail-open: a topology read error → [] (AHR degrades, ZFS unaffected)', async () => {
    class ThrowOnMdstat extends TelemetryExecutor {
      async exec(command: string, args: string[], opts?: ExecOptions) {
        if (command === '/usr/bin/cat')
          throw new Error('boom')
        return super.exec(command, args, opts)
      }
    }
    assert.deepEqual(await collectAhrTelemetry(new ThrowOnMdstat(), dsPrev, dsCur, 1000), [])
  })

  it('no AHR pools on the system → [] (a ZFS-only node is unchanged)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: ok('Personalities : [raid1]\nunused devices: <none>\n') })
    assert.deepEqual(await collectAhrTelemetry(mock, dsPrev, dsCur, 1000), [])
  })
})
