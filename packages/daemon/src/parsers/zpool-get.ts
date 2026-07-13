/**
 * Parser for `zpool get all -j` output.
 * Extracts: typed pool properties + optional full property bag.
 */

import type { PoolProperties } from '@anas/shared'
import { parseIntOrZero, parseZfsBool } from './utils.js'

interface ZfsPropertyRaw {
  value: string
  source: { type: string, data: string }
}

interface ZfsPoolGetRaw {
  properties: Record<string, ZfsPropertyRaw>
}

interface ZpoolGetOutput {
  pools: Record<string, ZfsPoolGetRaw>
}

/**
 * Parse `zpool get all -j` for a specific pool.
 * @param json raw `zpool get` JSON output (string or pre-parsed object)
 * @param poolName pool to extract properties for
 * @param includeAll If true, include the full property bag in `all`.
 */
export function parseZpoolGet(
  json: string | ZpoolGetOutput,
  poolName: string,
  includeAll = false,
): PoolProperties | null {
  const data: ZpoolGetOutput = typeof json === 'string' ? JSON.parse(json) : json
  const pool = data.pools[poolName]
  if (!pool)
    return null

  const prop = (name: string) => pool.properties[name]?.value ?? ''

  const result: PoolProperties = {
    ashift: parseIntOrZero(prop('ashift')),
    autoexpand: parseZfsBool(prop('autoexpand')),
    autoreplace: parseZfsBool(prop('autoreplace')),
    autotrim: parseZfsBool(prop('autotrim')),
    failmode: parseFailmode(prop('failmode')),
  }

  if (includeAll) {
    const all: Record<string, string> = {}
    for (const [key, val] of Object.entries(pool.properties)) {
      all[key] = val.value
    }
    result.all = all
  }

  return result
}

function parseFailmode(val: string): 'wait' | 'continue' | 'panic' {
  if (val === 'continue' || val === 'panic')
    return val
  return 'wait' // default
}
