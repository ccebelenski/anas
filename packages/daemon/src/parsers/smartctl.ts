/**
 * Parser for `smartctl -a --json /dev/X` output.
 * Handles SATA (attribute table), NVMe (health log), and unsupported disks.
 */

import type { SmartAttribute, SmartData, SmartHealth } from '@anas/shared'

interface SmartctlOutput {
  smart_support?: { available: boolean, enabled?: boolean }
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
 * The power-mode line smartctl prints when `-n standby` made it skip a sleeping
 * disk. The `(OS)` variant is smartctl 7.x's wording for a disk parked by the
 * OS power management ("Device is in STANDBY (OS) mode, exit(2)") — it must
 * match, or a standby disk reads as a failure.
 */
const STANDBY_MESSAGE_RE = /in (?:STANDBY|SLEEP)(?: \(OS\))? mode/i

/**
 * Single source of truth for "smartctl declined to read the disk because it is
 * asleep": run with `-n standby`, smartctl checks the power mode first and, for
 * a disk in STANDBY or SLEEP, exits with bit 1 set (exit code 2, possibly
 * OR'ed with other bits) WITHOUT issuing any command that would spin the
 * platters up. With `--json` it still emits a document whose messages name the
 * power mode; a bare exit code alone is not enough (bit 1 also fires for other
 * failures), so the message is required to confirm it was the power mode.
 *
 * The message is looked for in the JSON document's messages first, then in the
 * raw stdout/stderr text: older or non-`--json` invocations print it as plain
 * text, and the message — not the transport — is the evidence.
 */
export function isSmartctlStandby(result: { stdout: string, stderr?: string, exitCode: number }): boolean {
  if ((result.exitCode & 2) === 0)
    return false
  try {
    const data = JSON.parse(result.stdout) as {
      smartctl?: { messages?: Array<{ string?: string }> }
    }
    const messages = data.smartctl?.messages ?? []
    if (messages.some(m => STANDBY_MESSAGE_RE.test(m.string ?? '')))
      return true
  }
  catch {
    // not a document — the raw text below is the only place to look
  }
  if (STANDBY_MESSAGE_RE.test(result.stdout))
    return true
  if (result.stderr && STANDBY_MESSAGE_RE.test(result.stderr))
    return true
  return false
}

/**
 * The disk's power mode from a smartctl `--json` identity document, as
 * `power_mode.string` (smartctl 7.5's ATA identity emits it on the
 * `-n standby -iH` call — GT capture pve14 2026-09-10): "ACTIVE or IDLE",
 * "STANDBY", "SLEEP". SCSI/SAS/NVMe documents carry no `power_mode` object at
 * all, and that absence is preserved — the mode is NEVER inferred from a
 * transport or a rotation rate (2026-09-10 power-policy ruling: display only,
 * no policy). Undefined when the document reports none.
 */
export function parsePowerMode(data: {
  power_mode?: { string?: string }
  [key: string]: unknown
}): string | undefined {
  const mode = data.power_mode?.string
  return mode || undefined
}

/**
 * Classify a PARSED `smartctl --json` document as a probe FAILURE.
 *
 * smartctl emits a VALID document even when the probe failed: for an open
 * failure it exits with bit 1 set (`-n standby` never got to the power-mode
 * check) and reports the failure in `smartctl.messages` with
 * `severity: 'error'` — and carries no device fields at all. The executor
 * RESOLVES on a non-zero exit (it does not throw), so the document reaches
 * the caller as a successful parse, and a "measured" identity built from it
 * is all null: cache it as a hit and the disk's model/serial/health is
 * blank for the daemon's lifetime.
 *
 * The caller checks {@link isSmartctlStandby} FIRST: a standby skip also
 * exits with bit 1, and only what is neither a skip nor a measurement is
 * classified here. A disk that measures fine but FAILS its SMART check
 * (exit 1, `smart_status.passed: false`) is NOT a probe failure — the
 * "overall-health ... FAILED" line lands in the document's `output`, not in
 * `smartctl.messages`, so a dying-but-readable disk is still measured.
 */
export function isSmartctlProbeFailure(data: {
  smartctl?: { exit_status?: number, messages?: Array<{ string?: string, severity?: string }> }
  device?: { name?: string }
  model_name?: string
  serial_number?: string
  [key: string]: unknown
}): boolean {
  const smartctl = data.smartctl
  if (smartctl?.exit_status != null && (smartctl.exit_status & 2) !== 0)
    return true
  if (smartctl?.messages?.some(m => m.severity === 'error'))
    return true
  // No device identity at all — the probe got nothing back.
  return !data.device && !data.model_name && !data.serial_number
}

/** The SmartData payload for a disk we refused to wake: placeholders + the standby flag. */
export function standbySmartData(): SmartData {
  return {
    supported: false,
    enabled: false,
    overallHealth: 'UNKNOWN',
    temperature: null,
    powerOnHours: null,
    attributes: [],
    nvmePercentageUsed: null,
    nvmeAvailableSpare: null,
    standby: true,
  }
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
      standby: false,
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
    standby: false,
  }
}
