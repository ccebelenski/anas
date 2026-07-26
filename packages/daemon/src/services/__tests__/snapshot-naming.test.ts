import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrSnapshotName, SnapshotName } from '@anas/shared'
import { formatScheduledName, isScheduledName, parseScheduledName } from '../snapshot-naming.js'

describe('snapshot naming convention (anas-<bucket>-<utc>)', () => {
  it('formats a charset-safe, backend-portable name with no colons', () => {
    const name = formatScheduledName('daily', new Date('2026-07-26T14:23:01.234Z'))
    assert.equal(name, 'anas-daily-2026-07-26T142301Z')
    assert.ok(!name.includes(':'))
    // Valid for BOTH backends' name validators.
    assert.ok(SnapshotName.safeParse(name).success)
    assert.ok(AhrSnapshotName.safeParse(name).success)
  })

  it('round-trips format → parse for every bucket', () => {
    const now = new Date('2026-07-26T09:05:07.000Z')
    for (const bucket of ['frequently', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const) {
      const name = formatScheduledName(bucket, now)
      const parsed = parseScheduledName(name)
      assert.ok(parsed, `expected ${name} to parse`)
      assert.equal(parsed.bucket, bucket)
      assert.equal(parsed.timestamp.toISOString(), '2026-07-26T09:05:07.000Z')
    }
  })

  it('drops sub-second precision (second granularity)', () => {
    const name = formatScheduledName('hourly', new Date('2026-07-26T14:23:01.999Z'))
    assert.equal(name, 'anas-hourly-2026-07-26T142301Z')
    assert.equal(parseScheduledName(name)!.timestamp.toISOString(), '2026-07-26T14:23:01.000Z')
  })

  it('rejects non-ANAS names (source scoping)', () => {
    for (const foreign of [
      'nightly-2026-07-14', // manual ZFS snapshot
      'autosnap_2026-07-22_00:00:00_daily', // sanoid-style
      'before-upgrade', // AHR-manual
      'pre-rollback-2026-07-23T235407Z', // AHR rollback preserve
      'anas-weekly', // no timestamp
      'anas-2026-07-26T142301Z', // no bucket
      'anas-hourly-2026-07-26T142301', // no trailing Z
      'anas-fortnightly-2026-07-26T142301Z', // not a real bucket
    ]) {
      assert.equal(parseScheduledName(foreign), null, `should reject: ${foreign}`)
      assert.equal(isScheduledName(foreign), false)
    }
  })

  it('rejects an ANAS-shaped name whose date is not a real instant', () => {
    assert.equal(parseScheduledName('anas-daily-2026-13-40T250000Z'), null)
    assert.equal(parseScheduledName('anas-monthly-2026-02-30T120000Z'), null) // Feb 30 rolls over
  })
})
