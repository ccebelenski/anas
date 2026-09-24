import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isSmartctlProbeFailure, isSmartctlStandby, parsePowerMode, parseSmartctl, standbySmartData } from '../smartctl.js'

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
    assert.equal(result.standby, false)
  })
})

describe('isSmartctlStandby', () => {
  function standbyJson(mode: string) {
    return JSON.stringify({
      smartctl: { messages: [{ string: `Device is in ${mode} mode, exit(2)`, severity: 'information' }] },
    })
  }

  it('exit 2 + STANDBY message → true', () => {
    assert.equal(isSmartctlStandby({ stdout: standbyJson('STANDBY'), exitCode: 2 }), true)
  })

  it('exit 2 + SLEEP message → true', () => {
    assert.equal(isSmartctlStandby({ stdout: standbyJson('SLEEP'), exitCode: 2 }), true)
  })

  it('exit 2 OR-ed with other bits + STANDBY message → true', () => {
    assert.equal(isSmartctlStandby({ stdout: standbyJson('STANDBY'), exitCode: 6 }), true)
  })

  it('exit 0 + normal JSON → false', () => {
    assert.equal(isSmartctlStandby({ stdout: JSON.stringify({ model_name: 'X' }), exitCode: 0 }), false)
  })

  it('exit 2 + 7.5 "(OS)" wording in the JSON document → true', () => {
    const doc = loadFixture('smartctl-standby-skip.json')
    assert.equal(isSmartctlStandby({ stdout: JSON.stringify(doc), exitCode: 2 }), true)
  })

  it('exit 2 + plain-text STANDBY message on stdout (no JSON document) → true', () => {
    assert.equal(isSmartctlStandby({ stdout: 'Device is in STANDBY mode, exit(2)', exitCode: 2 }), true)
  })

  it('exit 2 + STANDBY message on stderr only → true', () => {
    assert.equal(isSmartctlStandby({ stdout: '', stderr: 'Device is in STANDBY (OS) mode, exit(2)\n', exitCode: 2 }), true)
  })

  it('exit 2 + no standby message → false (bit 1 alone is not proof of standby)', () => {
    assert.equal(isSmartctlStandby({ stdout: JSON.stringify({ smartctl: { messages: [{ string: 'Device open failed' }] } }), exitCode: 2 }), false)
  })

  it('exit 2 + non-JSON stdout without the power-mode message → false', () => {
    assert.equal(isSmartctlStandby({ stdout: 'Device open failed', stderr: 'unable to open /dev/sdb', exitCode: 2 }), false)
  })
})

describe('isSmartctlProbeFailure', () => {
  it('a synthesized smartctl 7.5 "open device failed" document → true', () => {
    // The document smartctl --json emits when it cannot open the device:
    // VALID JSON, exit bit 1, a severity 'error' message, and no device
    // fields at all. The envelope mirrors smartctl-standby-skip.json; the
    // message is smartctl's own `jerr("Smartctl open device: %s failed: %s")`
    // line (severity 'error').
    const doc = loadFixture('smartctl-open-device-failed.json')
    assert.equal(isSmartctlProbeFailure(doc), true)
  })

  it('an open-failed document is NOT a standby skip (the caller checks that first)', () => {
    const doc = loadFixture('smartctl-open-device-failed.json')
    assert.equal(isSmartctlStandby({ stdout: JSON.stringify(doc), exitCode: 2 }), false, 'no power-mode message — not a skip')
    assert.equal(isSmartctlProbeFailure(doc), true, '…and it IS a failure')
  })

  it('exit bit 1 with no device identity → true', () => {
    assert.equal(isSmartctlProbeFailure({ smartctl: { exit_status: 2 } }), true)
  })

  it('a severity error message → true', () => {
    assert.equal(
      isSmartctlProbeFailure({ smartctl: { messages: [{ string: 'Smart Read Error Log failed: I/O error', severity: 'error' }] } }),
      true,
    )
  })

  it('no device fields at all → true', () => {
    assert.equal(isSmartctlProbeFailure({ json_format_version: [1, 0] }), true)
  })

  it('a measured document → false', () => {
    assert.equal(
      isSmartctlProbeFailure({
        smartctl: { exit_status: 0 },
        device: { name: '/dev/sdb' },
        model_name: 'WDC WD2003FZEX-00SRLA0',
        serial_number: 'WD-123456789',
      }),
      false,
    )
  })

  it('a dying-but-readable disk (exit 1, smart_status failed, full identity, no error message) → false', () => {
    // The "overall-health ... FAILED" line lands in the document's `output`,
    // not in smartctl.messages — a failing disk is still MEASURED, so its
    // smartHealthy: false reaches the payload instead of being classified as
    // a probe failure.
    assert.equal(
      isSmartctlProbeFailure({
        smartctl: { exit_status: 1, messages: [{ string: 'SMART overall-health self-assessment test result: FAILED!', severity: 'information' }] },
        smart_status: { passed: false },
        device: { name: '/dev/sdb' },
        model_name: 'WDC WD2003FZEX-00SRLA0',
        serial_number: 'WD-123456789',
      }),
      false,
    )
  })

  it('a SMART-unsupported disk with identity (the QEMU fixture) → false', () => {
    assert.equal(isSmartctlProbeFailure(loadFixture('smartctl.json')), false)
  })
})

describe('standbySmartData', () => {
  it('is the empty payload plus standby: true', () => {
    const data = standbySmartData()
    assert.equal(data.standby, true)
    assert.equal(data.supported, false)
    assert.equal(data.enabled, false)
    assert.equal(data.overallHealth, 'UNKNOWN')
    assert.equal(data.temperature, null)
    assert.equal(data.powerOnHours, null)
    assert.deepEqual(data.attributes, [])
    assert.equal(data.nvmePercentageUsed, null)
    assert.equal(data.nvmeAvailableSpare, null)
  })

  it('parseSmartctl normal output carries standby: false (unsupported branch too)', () => {
    assert.equal(parseSmartctl(loadFixture('smartctl.json')).standby, false)
    assert.equal(parseSmartctl({ smart_support: { available: true, enabled: true } }).standby, false)
  })
})

/**
 * disks.1 rider 1 — the power mode, read off the ATA identity document's
 * `power_mode.string` and never inferred. The fixture is a minimal ATA
 * identity in the real smartctl 7.5 shape (built from smartctl's documented
 * `power_mode` object; no live capture in the tree carried the field). The
 * SCSI fixture (smartctl.json — a QEMU virtual disk) reports none, and so
 * would any SAS drive: absence must survive as absence.
 */
describe('parsePowerMode', () => {
  it('reads power_mode.string from the ATA identity document', () => {
    const ata = loadFixture('smartctl-ata-identity.json')
    assert.equal(parsePowerMode(ata), 'ACTIVE or IDLE')
  })

  it('is absent on a document without power_mode (SCSI/SAS shape)', () => {
    const scsi = loadFixture('smartctl.json')
    assert.equal(parsePowerMode(scsi), undefined)
    assert.equal(parsePowerMode({}), undefined)
  })

  it('an empty power_mode.string is absence, not an empty mode', () => {
    assert.equal(parsePowerMode({ power_mode: { string: '' } }), undefined)
  })
})
