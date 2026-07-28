import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseZpoolFeature } from '../zpool-get.js'
import { parsePoolBusyState } from '../zpool-status.js'

/** Minimal `zpool status -jv` pool object with an in-progress resilver. */
function resilverJson(examined: string, toExamine: string): string {
  return JSON.stringify({
    pools: {
      tank: {
        name: 'tank',
        state: 'DEGRADED',
        pool_guid: '1',
        scan_stats: {
          function: 'RESILVER',
          state: 'SCANNING',
          start_time: 'Mon Mar 16 15:25:35 UTC 2026',
          end_time: '-',
          to_examine: toExamine,
          examined,
          processed: examined,
          errors: '0',
        },
        vdevs: {},
        error_count: '0',
      },
    },
  })
}

/** Minimal pool object with a raidz-expansion reflow (doc-based field shape). */
function reflowJson(reflowed: string, toReflow: string, endTime = '-'): string {
  return JSON.stringify({
    pools: {
      tank: {
        name: 'tank',
        state: 'ONLINE',
        pool_guid: '1',
        raidz_expand_stats: {
          expanding_vdev: 'raidz1-0',
          state: 'COPYING',
          start_time: 'Mon Mar 16 15:25:35 UTC 2026',
          end_time: endTime,
          to_reflow: toReflow,
          reflowed,
          waiting_for_resilver: '0',
        },
        vdevs: {},
        error_count: '0',
      },
    },
  })
}

describe('parsePoolBusyState', () => {
  it('reports an in-progress resilver with percent', () => {
    const busy = parsePoolBusyState(resilverJson('25G', '100G'), 'tank')
    assert.equal(busy.busy, true)
    assert.equal(busy.operation, 'resilver')
    assert.equal(busy.percentComplete, 25)
  })

  it('reports an in-progress raidz-expansion reflow with percent and vdev', () => {
    const busy = parsePoolBusyState(reflowJson('1G', '5G'), 'tank')
    assert.equal(busy.busy, true)
    assert.equal(busy.operation, 'raidz-expand')
    assert.equal(busy.percentComplete, 20)
    assert.equal(busy.vdev, 'raidz1-0')
  })

  it('reflow takes precedence over a concurrent resilver', () => {
    const obj = JSON.parse(reflowJson('1G', '5G'))
    obj.pools.tank.scan_stats = JSON.parse(resilverJson('25G', '100G')).pools.tank.scan_stats
    const busy = parsePoolBusyState(JSON.stringify(obj), 'tank')
    assert.equal(busy.operation, 'raidz-expand')
  })

  it('a finished reflow (copied == total, end_time set) is not busy', () => {
    const busy = parsePoolBusyState(reflowJson('5G', '5G', 'Mon Mar 16 16:00:00 UTC 2026'), 'tank')
    assert.equal(busy.busy, false)
  })

  it('a SCRUB is a soft note, never a block', () => {
    const scrub = JSON.stringify({
      pools: {
        tank: {
          name: 'tank',
          state: 'ONLINE',
          pool_guid: '1',
          scan_stats: { function: 'SCRUB', state: 'SCANNING', start_time: '-', end_time: '-', to_examine: '10G', examined: '2G', processed: '2G', errors: '0' },
          vdevs: {},
          error_count: '0',
        },
      },
    })
    assert.equal(parsePoolBusyState(scrub, 'tank').busy, false)
  })

  it('returns not-busy for an absent pool or empty output', () => {
    assert.equal(parsePoolBusyState('{}', 'tank').busy, false)
    assert.equal(parsePoolBusyState('{"pools":{}}', 'tank').busy, false)
    assert.equal(parsePoolBusyState('', 'tank').busy, false)
  })
})

describe('parseZpoolFeature', () => {
  const json = JSON.stringify({
    pools: {
      tank: {
        properties: {
          'feature@raidz_expansion': { value: 'enabled', source: { type: 'LOCAL', data: '-' } },
          'feature@fast_dedup': { value: 'disabled', source: { type: 'DEFAULT', data: '-' } },
        },
      },
    },
  })

  it('reads a feature-flag value', () => {
    assert.equal(parseZpoolFeature(json, 'tank', 'feature@raidz_expansion'), 'enabled')
    assert.equal(parseZpoolFeature(json, 'tank', 'feature@fast_dedup'), 'disabled')
  })

  it('returns null for a missing feature or pool', () => {
    assert.equal(parseZpoolFeature(json, 'tank', 'feature@nonesuch'), null)
    assert.equal(parseZpoolFeature(json, 'nope', 'feature@raidz_expansion'), null)
  })
})
