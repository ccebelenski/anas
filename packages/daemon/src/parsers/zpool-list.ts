/**
 * Parser for `zpool list -j` output.
 * Extracts: pool summaries (size, allocated, free, fragmentation, etc.)
 */

import type { PoolSummary } from '@anas/shared'
import { parseDedupRatio, parseHumanSize, parsePercent, parseZfsJson } from './utils.js'

interface ZfsPropertyRaw {
  value: string
  source: { type: string, data: string }
}

interface ZfsPoolListRaw {
  name: string
  state: string
  properties: Record<string, ZfsPropertyRaw>
}

interface ZpoolListOutput {
  pools: Record<string, ZfsPoolListRaw>
}

/**
 * Parse `zpool list -j` JSON output into pool summaries.
 * Note: This provides size/capacity data. State and health come from zpool-status parser.
 */
export function parseZpoolList(json: string | ZpoolListOutput): Omit<PoolSummary, 'scanRunning' | 'scanFunction' | 'trimSupported' | 'upgradeAvailable' | 'health' | 'pveStorages'>[] {
  const data: ZpoolListOutput = parseZfsJson(json, { pools: {} })
  return Object.values(data.pools).map((pool) => {
    const prop = (name: string) => pool.properties[name]?.value ?? '-'

    return {
      name: pool.name,
      state: pool.state as PoolSummary['state'],
      size: parseHumanSize(prop('size')),
      allocated: parseHumanSize(prop('allocated')),
      free: parseHumanSize(prop('free')),
      fragmentation: parsePercent(prop('fragmentation')),
      capacity: parsePercent(prop('capacity')),
      dedupRatio: parseDedupRatio(prop('dedupratio')),
    }
  })
}
