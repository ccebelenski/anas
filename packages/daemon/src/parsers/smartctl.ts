/**
 * Parser for `smartctl -a --json /dev/X` output.
 * Handles SATA (attribute table), NVMe (health log), and unsupported disks.
 */

import type { SmartAttribute, SmartData, SmartHealth } from '@anas/shared'

interface SmartctlOutput {
  smart_support?: { available: boolean; enabled?: boolean }
  smart_status?: { passed: boolean }
  temperature?: { current: number }
  power_on_time?: { hours: number }
  ata_smart_attributes?: {
    table: Array<{
      id: number
      name: string
      value: number
      worst: number
      thresh: number
      raw: { value: number }
    }>
  }
  nvme_smart_health_information_log?: {
    percentage_used: number
    available_spare: number
    temperature: number
    power_on_hours: number
  }
  [key: string]: unknown
}

/**
 * Parse `smartctl -a --json` output into SmartData.
 */
export function parseSmartctl(json: string | SmartctlOutput): SmartData {
  const data: SmartctlOutput = typeof json === 'string' ? JSON.parse(json) : json

  const supported = data.smart_support?.available ?? false
  const enabled = data.smart_support?.enabled ?? false

  if (!supported) {
    return {
      supported: false,
      enabled: false,
      overallHealth: 'UNKNOWN',
      temperature: null,
      powerOnHours: null,
      attributes: [],
      nvmePercentageUsed: null,
      nvmeAvailableSpare: null,
    }
  }

  const nvmeLog = data.nvme_smart_health_information_log

  let overallHealth: SmartHealth = 'UNKNOWN'
  if (data.smart_status) {
    overallHealth = data.smart_status.passed ? 'PASSED' : 'FAILED'
  }

  const temperature = nvmeLog?.temperature
    ?? data.temperature?.current
    ?? null

  const powerOnHours = nvmeLog?.power_on_hours
    ?? data.power_on_time?.hours
    ?? null

  const attributes: SmartAttribute[] = []
  if (data.ata_smart_attributes?.table) {
    for (const attr of data.ata_smart_attributes.table) {
      attributes.push({
        id: attr.id,
        name: attr.name,
        value: attr.value,
        worst: attr.worst,
        threshold: attr.thresh,
        rawValue: attr.raw.value,
        failing: attr.value <= attr.thresh && attr.thresh > 0,
      })
    }
  }

  return {
    supported,
    enabled,
    overallHealth,
    temperature,
    powerOnHours: powerOnHours !== null ? Math.floor(powerOnHours) : null,
    attributes,
    nvmePercentageUsed: nvmeLog?.percentage_used ?? null,
    nvmeAvailableSpare: nvmeLog?.available_spare ?? null,
  }
}
