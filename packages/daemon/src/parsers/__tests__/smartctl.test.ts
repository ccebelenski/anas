import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseSmartctl } from '../smartctl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/system')

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}

describe('parseSmartctl', () => {
  it('handles disk that does not support SMART', () => {
    const result = parseSmartctl(loadFixture('smartctl.json'))
    assert.equal(result.supported, false)
    assert.equal(result.enabled, false)
    assert.equal(result.overallHealth, 'UNKNOWN')
    assert.equal(result.temperature, null)
    assert.equal(result.powerOnHours, null)
    assert.deepEqual(result.attributes, [])
    assert.equal(result.nvmePercentageUsed, null)
    assert.equal(result.nvmeAvailableSpare, null)
  })

  it('handles SATA disk with SMART', () => {
    const smartData = {
      smart_support: { available: true, enabled: true },
      smart_status: { passed: true },
      temperature: { current: 35 },
      power_on_time: { hours: 12345 },
      ata_smart_attributes: {
        table: [
          { id: 1, name: 'Raw_Read_Error_Rate', value: 100, worst: 100, thresh: 6, raw: { value: 0 } },
          { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 36, raw: { value: 0 } },
          { id: 194, name: 'Temperature_Celsius', value: 65, worst: 60, thresh: 0, raw: { value: 35 } },
        ],
      },
    }

    const result = parseSmartctl(smartData)
    assert.equal(result.supported, true)
    assert.equal(result.enabled, true)
    assert.equal(result.overallHealth, 'PASSED')
    assert.equal(result.temperature, 35)
    assert.equal(result.powerOnHours, 12345)
    assert.equal(result.attributes.length, 3)
    assert.equal(result.attributes[0].failing, false)
  })

  it('detects failing SMART attribute', () => {
    const smartData = {
      smart_support: { available: true, enabled: true },
      smart_status: { passed: false },
      ata_smart_attributes: {
        table: [
          { id: 5, name: 'Reallocated_Sector_Ct', value: 10, worst: 10, thresh: 36, raw: { value: 500 } },
        ],
      },
    }

    const result = parseSmartctl(smartData)
    assert.equal(result.overallHealth, 'FAILED')
    assert.equal(result.attributes[0].failing, true)
  })

  it('handles NVMe disk', () => {
    const smartData = {
      smart_support: { available: true, enabled: true },
      smart_status: { passed: true },
      nvme_smart_health_information_log: {
        percentage_used: 5,
        available_spare: 100,
        temperature: 40,
        power_on_hours: 5000,
      },
    }

    const result = parseSmartctl(smartData)
    assert.equal(result.supported, true)
    assert.equal(result.overallHealth, 'PASSED')
    assert.equal(result.temperature, 40)
    assert.equal(result.powerOnHours, 5000)
    assert.equal(result.nvmePercentageUsed, 5)
    assert.equal(result.nvmeAvailableSpare, 100)
    assert.deepEqual(result.attributes, [])
  })
})
