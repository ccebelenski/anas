import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { CACHE_PV_IDENTITY_ARGS, cacheDeviceVerdict } from '../ahr-cache.js'

/**
 * cr3 (cache-event review defects 1 and 2): THE cache device's verdict, which
 * drives an unattended `lvconvert --uncache`. Ground truth captured on PVE 9,
 * LVM 2.03.31, over a throwaway two-PV loop VG with one PV detached:
 *  - `fixtures/ahr/pvs-uuid-missing-pv-row.json`: the missing PV's row as
 *    `pvs --reportformat json -o pv_name,pv_uuid,vg_name` printed it (the
 *    pv_name and pv_uuid keys verbatim; the VG name was not part of the hand-off);
 *  - `fixtures/ahr/blkid-p-lvm-pv.txt`: `blkid -p` on a live PV, exit 0.
 * `pvs` exits 0 with nothing on stderr while a PV is missing.
 */
const FIXTURES = join(import.meta.dirname, '../../fixtures/ahr')
const MISSING_ROW = JSON.parse(readFileSync(join(FIXTURES, 'pvs-uuid-missing-pv-row.json'), 'utf8')) as { pv_name: string, pv_uuid: string }
const LIVE_PV_LINE = readFileSync(join(FIXTURES, 'blkid-p-lvm-pv.txt'), 'utf8')
const LIVE_UUID = /UUID="([^"]+)"/.exec(LIVE_PV_LINE)![1]
/**
 * The captured live-PV line was taken on a whole loop DEVICE; on a partition
 * `blkid -p` adds the PART_ENTRY_* keys (the captured blank-partition shape),
 * and the cache verdict reads PART_ENTRY_NAME from there (cr3 review2 3).
 */
const LIVE_CACHE_SLICE_LINE = `${LIVE_PV_LINE.trimEnd()} PART_ENTRY_SCHEME="gpt" PART_ENTRY_NAME="tank-cache1"\n`

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
const BAND1 = { pv_name: '/dev/md127', pv_uuid: 'AAAAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAAAA', vg_name: 'tank' }
const CACHE = { pv_name: '/dev/sds1', pv_uuid: LIVE_UUID, vg_name: 'tank' }

function world(rows: object[], blkid?: ExecResult | 'timeout'): MockExecutor {
  const m = new MockExecutor()
  m.addFixture({ command: '/usr/sbin/pvs', args: CACHE_PV_IDENTITY_ARGS, result: ok(JSON.stringify({ report: [{ pv: rows }] })) })
  if (blkid === 'timeout')
    m.addFixture({ command: '/usr/sbin/blkid', args: ['-p', '/dev/sds1'], timesOut: {} })
  else if (blkid)
    m.addFixture({ command: '/usr/sbin/blkid', args: ['-p', '/dev/sds1'], result: blkid })
  return m
}

describe('cacheDeviceVerdict — cr3: identity, and a read that could not see is unknown', () => {
  it('a live cache PV whose label carries its own UUID (the captured line) is present', async () => {
    assert.equal((await cacheDeviceVerdict(world([BAND1, CACHE], ok(LIVE_CACHE_SLICE_LINE)), { name: 'tank', bandCount: 1 })).verdict, 'present')
  })

  it('the captured [unknown] row is the cache only when every band has its own named md PV', async () => {
    const unknown = { ...MISSING_ROW, vg_name: 'tank' }
    assert.equal((await cacheDeviceVerdict(world([BAND1, unknown]), { name: 'tank', bandCount: 1 })).verdict, 'missing')
    // Defect 1: two bands, band 2's PV unknown, the cache present — the
    // [unknown] row may be the band's: no evidence, nothing done.
    assert.equal((await cacheDeviceVerdict(world([BAND1, unknown, CACHE], ok(LIVE_CACHE_SLICE_LINE)), { name: 'tank', bandCount: 2 })).verdict, 'unknown')
  })

  it('defect 2: blkid that could not SEE is unknown — exit 2 with an error line, exit 8, a timeout', async () => {
    for (const probe of [
      { stdout: '', stderr: 'blkid: error: /dev/sds1: Permission denied\n', exitCode: 2 },
      { stdout: '', stderr: '', exitCode: 8 },
      { stdout: '', stderr: 'blkid: unexpected', exitCode: 4 },
    ] as ExecResult[]) {
      const v = await cacheDeviceVerdict(world([BAND1, CACHE], probe), { name: 'tank', bandCount: 1 })
      assert.equal(v.verdict, 'unknown', JSON.stringify(probe))
    }
    assert.equal((await cacheDeviceVerdict(world([BAND1, CACHE], 'timeout'), { name: 'tank', bandCount: 1 })).verdict, 'unknown')
  })

  it('a pvs that times out is unknown, never a throw', async () => {
    const m = new MockExecutor()
    m.addFixture({ command: '/usr/sbin/pvs', args: CACHE_PV_IDENTITY_ARGS, timesOut: {} })
    assert.equal((await cacheDeviceVerdict(m, { name: 'tank', bandCount: 1 })).verdict, 'unknown')
  })

  // cr3 review2 3: a NAMED PV whose device is gone (exit 2, no output) can no
  // longer be read for its label — it is not proven the cache: unknown (was
  // missing). A slice labelled for this pool's cache that now carries
  // another PV's UUID is missing.
  it('a gone named PV is unknown (label unreadable); a labelled cache slice carrying another PV is missing', async () => {
    assert.equal((await cacheDeviceVerdict(world([BAND1, CACHE], { stdout: '', stderr: '', exitCode: 2 }), { name: 'tank', bandCount: 1 })).verdict, 'unknown')
    assert.equal((await cacheDeviceVerdict(world([BAND1, CACHE], ok(LIVE_CACHE_SLICE_LINE.replace(LIVE_UUID, 'Other0-0000-0000-0000-0000-0000-000000'))), { name: 'tank', bandCount: 1 })).verdict, 'missing')
  })

  it('cr3 review2 3: an operator\'s own PV in the VG (not a pool cache slice) makes an [unknown] row unknown — never missing', async () => {
    const operatorPv = { pv_name: '/dev/sdx', pv_uuid: 'CCCCCC-CCCC-CCCC-CCCC-CCCC-CCCC-CCCCCC', vg_name: 'tank' }
    const m = world([BAND1, operatorPv, { ...MISSING_ROW, vg_name: 'tank' }])
    m.addFixture({ command: '/usr/sbin/blkid', args: ['-p', '/dev/sdx'], result: ok('/dev/sdx: UUID="CCCCCC-CCCC-CCCC-CCCC-CCCC-CCCC-CCCCCC" VERSION="LVM2 001" TYPE="LVM2_member" USAGE="raid"\n') })
    assert.equal((await cacheDeviceVerdict(m, { name: 'tank', bandCount: 1 })).verdict, 'unknown')
  })

  it('cr3 review2 2: an unknown band count ([unknown] row, mdadm.conf unreadable) is unknown', async () => {
    assert.equal((await cacheDeviceVerdict(world([BAND1, { ...MISSING_ROW, vg_name: 'tank' }]), { name: 'tank', bandCount: null })).verdict, 'unknown')
  })
})
