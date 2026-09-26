import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CLOUD_STATS_INTERVAL_SECS, STALLED_SAMPLES, stalledFor } from '../cloud-run.js'

/**
 * The cloud run display helpers (rclone.6 review batch A, 2026-09-25). The
 * stalled rule is ONE function shared by the daemon and the ES5 UI, so its
 * test vectors live OUTSIDE the code — `test-vectors/stalled-samples.json` —
 * and every consumer's test iterates the same file.
 */

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), '../../test-vectors')

interface StalledCase {
  name: string
  samples: number[]
  transfers?: number
  totalTransfers?: number
  transferring?: number
  stalledSeconds: number | null
}

const STALLED_CASES: StalledCase[] = JSON.parse(
  readFileSync(join(VECTORS, 'stalled-samples.json'), 'utf-8'),
)

describe('stalledFor — the shared stalled rule (rclone.6)', () => {
  it('answers every vector in test-vectors/stalled-samples.json', () => {
    for (const c of STALLED_CASES) {
      const got = stalledFor({
        speedSamples: c.samples,
        transfers: c.transfers,
        totalTransfers: c.totalTransfers,
        transferring: Array.from({ length: c.transferring ?? 0 }).fill({}),
      })
      assert.equal(got, c.stalledSeconds, c.name)
    }
  })

  it('absent or malformed detail fields degrade to no verdict, never a throw', () => {
    assert.equal(stalledFor({}), null)
    assert.equal(stalledFor({ speedSamples: 'nope' as unknown as number[] }), null)
    assert.equal(stalledFor({ speedSamples: [0, 0, 0], transferring: 'x' as unknown as object[] }), null)
    assert.equal(stalledFor(undefined as unknown as Parameters<typeof stalledFor>[0]), null)
  })

  it('the pinned cadence and sample count agree with the vectors that encode them', () => {
    assert.equal(CLOUD_STATS_INTERVAL_SECS, 5)
    assert.equal(STALLED_SAMPLES, 3)
    // "three zero samples with files remaining" = 3 * 5s.
    assert.equal(STALLED_CASES[0].stalledSeconds, STALLED_SAMPLES * CLOUD_STATS_INTERVAL_SECS)
  })
})
