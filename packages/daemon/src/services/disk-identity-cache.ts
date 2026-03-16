/**
 * Lazy-loaded cache of disk identity info from smartctl.
 * Keyed by disk by-id name. Immutable per disk — model family,
 * form factor, firmware don't change unless the physical disk changes,
 * which means a new by-id key.
 */

import type { CommandExecutor } from '../executor/types.js'

export interface DiskIdentity {
  /** Human-readable model family, e.g. "Western Digital Red Pro" */
  modelFamily: string | null
  /** Device model, e.g. "WDC WD2003FZEX-00SRLA0" */
  deviceModel: string | null
  /** Form factor, e.g. "2.5 inches", "3.5 inches", "M.2" */
  formFactor: string | null
  /** Firmware version */
  firmwareVersion: string | null
  /** Interface/protocol, e.g. "SATA 3.2, 6.0 Gb/s" */
  interface: string | null
  /** Whether TRIM is available (SSDs) */
  trimSupport: boolean
}

export class DiskIdentityCache {
  private cache = new Map<string, DiskIdentity>()
  private pending = new Map<string, Promise<DiskIdentity>>()
  private executor: CommandExecutor

  constructor(executor: CommandExecutor) {
    this.executor = executor
  }

  /** Get cached identity, or null if not yet loaded */
  getCached(diskId: string): DiskIdentity | null {
    return this.cache.get(diskId) ?? null
  }

  /** Get identity, loading from smartctl if not cached. */
  async get(diskId: string, devicePath: string): Promise<DiskIdentity> {
    const cached = this.cache.get(diskId)
    if (cached) return cached

    // Deduplicate concurrent requests for the same disk
    const existing = this.pending.get(diskId)
    if (existing) return existing

    const promise = this.load(diskId, devicePath)
    this.pending.set(diskId, promise)
    try {
      return await promise
    }
    finally {
      this.pending.delete(diskId)
    }
  }

  /** Load identity for multiple disks in parallel. */
  async loadMany(disks: Array<{ id: string, path: string }>): Promise<void> {
    const uncached = disks.filter(d => !this.cache.has(d.id))
    if (uncached.length === 0) return
    await Promise.all(uncached.map(d => this.get(d.id, d.path)))
  }

  private async load(diskId: string, devicePath: string): Promise<DiskIdentity> {
    const identity = await this.fetchFromSmartctl(devicePath)
    this.cache.set(diskId, identity)
    return identity
  }

  private async fetchFromSmartctl(devicePath: string): Promise<DiskIdentity> {
    try {
      const result = await this.executor.exec('/usr/sbin/smartctl', ['-i', '--json', devicePath])
      // smartctl -i is identity only (no full scan), much faster than -a
      const data = JSON.parse(result.stdout)
      return {
        modelFamily: data.model_family ?? null,
        deviceModel: data.model_name ?? null,
        formFactor: data.form_factor?.name ?? null,
        firmwareVersion: data.firmware_version ?? null,
        interface: formatInterface(data),
        trimSupport: !!data.trim?.supported,
      }
    }
    catch {
      // smartctl failed or returned invalid JSON — return empty identity
      return {
        modelFamily: null,
        deviceModel: null,
        formFactor: null,
        firmwareVersion: null,
        interface: null,
        trimSupport: false,
      }
    }
  }
}

function formatInterface(data: any): string | null {
  if (data.sata_version?.string) return data.sata_version.string
  if (data.nvme_version?.string) return `NVMe ${data.nvme_version.string}`
  if (data.device?.protocol) return data.device.protocol
  return null
}
