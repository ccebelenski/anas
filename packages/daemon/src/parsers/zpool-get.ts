/**
 * Parser for `zpool get all -j` output.
 * Extracts: typed pool properties + optional full property bag.
 */

import type { PoolProperties } from '@anas/shared'
import { parseZfsJson } from './utils.js'

const ASHIFT_RE = /^\d+$/

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
  const data: ZpoolGetOutput = parseZfsJson(json, { pools: {} })
  const pool = data.pools[poolName]
  if (!pool)
    return null

  // cr3: a property the read did not return is null (unknown), never a
  // default; so is a value outside the property's domain.
  const prop = (name: string): string | undefined => pool.properties?.[name]?.value
  const bool = (name: string): boolean | null => {
    const v = prop(name)
    return v === 'on' ? true : v === 'off' ? false : null
  }
  const ashift = prop('ashift')

  const result: PoolProperties = {
    ashift: ashift !== undefined && ASHIFT_RE.test(ashift) ? Number(ashift) : null,
    autoexpand: bool('autoexpand'),
    autoreplace: bool('autoreplace'),
    autotrim: bool('autotrim'),
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

function parseFailmode(val: string | undefined): 'wait' | 'continue' | 'panic' | null {
  if (val === 'wait' || val === 'continue' || val === 'panic')
    return val
  return null // not returned, or not a failmode: unknown (cr3)
}

/**
 * Read a single pool feature-flag value (e.g. `feature@raidz_expansion`) from
 * `zpool get all -j`. Feature values are `disabled` | `enabled` | `active`.
 * Returns null when the pool or feature is absent (fail-soft). Used to gate
 * raidz expansion, which requires the feature enabled/active (story 3.31).
 */
export function parseZpoolFeature(
  json: string | ZpoolGetOutput,
  poolName: string,
  feature: string,
): string | null {
  const data: ZpoolGetOutput = parseZfsJson(json, { pools: {} })
  const pool = data.pools[poolName]
  if (!pool)
    return null
  return pool.properties[feature]?.value ?? null
}
