/**
 * Lazy-loaded cache of disk identity info from smartctl.
 * Keyed by disk by-id name. Model family, form factor and firmware are
 * immutable per disk — they don't change unless the physical disk changes,
 * which means a new by-id key. The measured SMART health, by contrast, is
 * re-probed on a cadence (default 30 minutes, `ANAS_SMART_REPROBE_MS` to
 * override — disks.1): a reading ages out and the next consumer pull re-reads
 * it, so a climbing reallocated-sector count is seen within the hour, not at
 * the next daemon restart. There is no poller and no timer — only pulls probe.
 */

import type { CommandExecutor } from '../executor/types.js'
import { isSmartctlProbeFailure, isSmartctlStandby, parsePowerMode } from '../parsers/smartctl.js'

/**
 * The re-probe cadence when nothing overrides it: 30 minutes, smartd's own
 * default check interval — the cadence TrueNAS's disk health follows, and the
 * one a PVE operator already learned to expect.
 */
const DEFAULT_SMART_REPROBE_MS = 30 * 60 * 1000

/**
 * The narrowest cadence the env may ask for. `Number.parseInt` would have read
 * `30m` as 30 — a re-probe on every pull, i.e. an smartctl storm per disk per
 * page load — so the value is parsed WHOLE and then clamped.
 */
const MIN_SMART_REPROBE_MS = 1000
/**
 * ...and the widest. A day is already "effectively never" on a box nobody
 * looks at; anything past it restores the never-re-probe bug this story
 * exists to fix.
 */
const MAX_SMART_REPROBE_MS = 24 * 60 * 60 * 1000

/**
 * `ANAS_SMART_REPROBE_MS` override (tests), or the 30-minute default. The
 * value must be a whole number of milliseconds: `Number` rejects `30m`, `abc`
 * and every other suffixed or partial form that `parseInt` would have taken
 * the leading digits of, and anything outside [1 s, 24 h] is clamped rather
 * than honoured — neither a probe storm nor a cadence that never comes due.
 */
function reprobeCadenceFromEnv(): number {
  const raw = process.env.ANAS_SMART_REPROBE_MS
  if (raw === undefined || raw.trim() === '')
    return DEFAULT_SMART_REPROBE_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0)
    return DEFAULT_SMART_REPROBE_MS
  return Math.min(Math.max(n, MIN_SMART_REPROBE_MS), MAX_SMART_REPROBE_MS)
}

export interface DiskIdentityCacheOptions {
  /**
   * The clock, injected so tests age readings without sleeping. Default
   * `Date.now`.
   */
  now?: () => number
  /**
   * Re-probe cadence in ms. Default: `ANAS_SMART_REPROBE_MS` (parsed whole and
   * clamped to [1 s, 24 h]) or 30 minutes. Unlike the env, this option is
   * taken verbatim — it is the tests' own dial, and `reprobeMs: 0` means
   * ALWAYS DUE: every pull re-probes. Tests only; nothing in the daemon
   * passes it.
   */
  reprobeMs?: number
}

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
  /** Whether TRIM is available (SSD) */
  trimSupport: boolean
  /** SMART health: true=passed, false=failed, null=not supported/unknown */
  smartHealthy: boolean | null
  /**
   * The disk's power mode as smartctl reported it at measurement time
   * (`power_mode.name` from the ATA identity JSON — "ACTIVE or IDLE",
   * "IDLE_A", "STANDBY_Y" and the rest of smartmontools 7.5's names, reported
   * verbatim). Absent when the transport reports none (SAS/SCSI drives do
   * not) — never inferred from a transport or a rotation rate. A standby skip
   * and a failed probe keep the last measured value: it rides the identity
   * it was measured with, and the reading's `measuredAt` says how old that is.
   */
  powerMode?: string
  /**
   * When THIS reading was measured (epoch ms). Carried by a fresh measured
   * reading, and — spread from the last measured identity — by the standby and
   * probe-failed readings that report those last measured values, so a
   * consumer can show the reading's age. Absent only on a disk that was never
   * measured (there is no measurement to date).
   */
  measuredAt?: number
  /**
   * The disk is asleep (STANDBY/SLEEP) and smartctl was told not to wake it —
   * nothing was measured this pass. Absent on a reading taken from an awake
   * disk.
   */
  standby?: boolean
  /**
   * The reported identity is the LAST MEASURED one, not a fresh reading: the
   * disk has a measured reading, and this pass was a standby skip
   * (`staleReason: 'standby'`) or the probe failed
   * (`staleReason: 'probe-failed'`). Never set on a disk that was never
   * measured — there is no reading to be stale relative to; its
   * `staleReason` then carries only the re-probe duty.
   */
  stale?: boolean
  /**
   * Why the reading is not a fresh measurement — it was a standby skip, or
   * the probe failed. Also carried by a never-measured disk whose probe
   * failed, where it is what keeps the re-probes alive, with no `stale`.
   */
  staleReason?: 'standby' | 'probe-failed'
}

/**
 * Bounded re-probe state per failing disk. Each consecutive failure delays
 * the next attempt by 2^(failures-1) passes, capped — a disk that fails
 * forever must not be probed on every pass, nor never: the first failure of
 * a disk that later answers must not blank it for the daemon's lifetime.
 * Any answering probe (a standby skip or a measurement) clears it.
 */
interface ProbeBackoff {
  failures: number
  /** Passes to wait before the next attempt. */
  skip: number
}

const MAX_PROBE_BACKOFF_PASSES = 8

function probeBackoffSkip(failures: number): number {
  return Math.min(2 ** (failures - 1), MAX_PROBE_BACKOFF_PASSES)
}

/**
 * A device that has left the topology is dropped only after this many
 * CONSECUTIVE passes of absence from a trustworthy enumeration — one empty
 * `ls /dev/disk/by-id/` must not cost the fleet its identities.
 */
const PRUNE_AFTER_ABSENT_PASSES = 3

export class DiskIdentityCache {
  /**
   * The last MEASURED identity per disk (an awake reading). A standby reading
   * never touches it — the disk may sleep for days under the spindown policy
   * and its measured identity stays the truth to report in the meantime. A
   * failed probe never touches it either: it is not a measurement, and
   * `stale` is reported only over a real entry here.
   */
  private measured = new Map<string, DiskIdentity>()
  /**
   * The latest reading to REPORT per disk: the measured identity, the measured
   * identity marked `standby` + `stale`, the last reading marked
   * `stale: 'probe-failed'` after a failed probe on a measured disk, or a
   * placeholder (never seen awake) with no health claim.
   */
  private reading = new Map<string, DiskIdentity>()
  private pending = new Map<string, Promise<DiskIdentity>>()
  /** Bounded re-probe state per disk — see ProbeBackoff. */
  private backoff = new Map<string, ProbeBackoff>()
  /** Consecutive passes a key has been absent from a TRUSTWORTHY enumeration. */
  private absentPasses = new Map<string, number>()
  private executor: CommandExecutor
  /** The clock (injected in tests) — ages readings for the cadence check. */
  private now: () => number
  /** How old a measured reading may get before it is re-probed. */
  private reprobeMs: number

  constructor(executor: CommandExecutor, opts: DiskIdentityCacheOptions = {}) {
    this.executor = executor
    this.now = opts.now ?? Date.now
    this.reprobeMs = opts.reprobeMs ?? reprobeCadenceFromEnv()
  }

  /** Get the latest reading (measured, or standby/failure-marked), or null if never loaded */
  getCached(diskId: string): DiskIdentity | null {
    return this.reading.get(diskId) ?? null
  }

  /**
   * Whether a disk's reading needs a fresh probe: it was never read, the last
   * reading was a standby skip (the disk may have woken), the last probe
   * failed and its backoff has drained, or the measured reading has aged past
   * the re-probe cadence. That last one is the disks.1 change: a clean
   * measured reading is a hit only WITHIN the cadence, so a reallocated-sector
   * count that starts climbing is seen on the next pull after 30 minutes —
   * not at the next daemon restart. The re-probe is the same `-n standby`
   * call, so an aged reading on a now-sleeping disk is refreshed by a skip,
   * never a spin-up.
   */
  private isDue(diskId: string, reading: DiskIdentity | undefined): boolean {
    if (!reading)
      return true
    if (reading.standby)
      return true
    if (reading.staleReason === 'probe-failed') {
      // A failed probe re-probes — but bounded: wait out the backoff. (Its
      // age check is unreachable: the failure spread keeps the last
      // measurement's `measuredAt`, and the backoff governs until it answers.)
      const state = this.backoff.get(diskId)
      return !state || state.skip <= 0
    }
    if (reading.measuredAt != null && this.now() - reading.measuredAt >= this.reprobeMs)
      return true
    return false
  }

  /** One pass has happened for this disk: advance it toward its next attempt. */
  private tickBackoff(diskId: string): void {
    const state = this.backoff.get(diskId)
    if (state && state.skip > 0)
      state.skip--
  }

  /**
   * Get the reading for a disk, re-reading smartctl when the reading is due
   * (a standby skip, a failed probe whose backoff has drained, or a measured
   * reading aged past the re-probe cadence).
   */
  async get(diskId: string, devicePath: string): Promise<DiskIdentity> {
    this.tickBackoff(diskId)
    const reading = this.reading.get(diskId)
    if (reading && !this.isDue(diskId, reading))
      return reading

    // Deduplicate concurrent requests for the same disk
    const existing = this.pending.get(diskId)
    if (existing)
      return existing

    const promise = this.load(diskId, devicePath)
    this.pending.set(diskId, promise)
    try {
      return await promise
    }
    finally {
      this.pending.delete(diskId)
    }
  }

  /**
   * Load readings for multiple disks in parallel. Disks whose reading is due
   * (never read, a standby skip, a failed probe whose backoff has drained, or
   * a measured reading aged past the re-probe cadence) are re-read; the rest
   * are left alone.
   *
   * The disk list is also the TOPOLOGY REFRESH: the cache is keyed per device,
   * and a device that has left the fleet must not leave its entries behind
   * (on a box where disks come and go, the maps would otherwise grow without
   * bound for the daemon's lifetime). But a list that cannot name the fleet is
   * no evidence of departure — see {@link pruneAbsent}.
   *
   * `presentIds` names the disks the enumeration resolved THROUGH by-id
   * (fourth pass). Given, it is the presence list for the prune, so a disk
   * whose id fell back to a serial/kernel name does not count as present —
   * its fallback entry is exactly the kind that goes stale — while the rest
   * of the fleet prunes normally. Absent, every listed disk counts.
   */
  async loadMany(
    disks: Array<{ id: string, path: string }>,
    opts: { prunable?: boolean, presentIds?: string[] } = {},
  ): Promise<void> {
    this.pruneAbsent(
      opts.presentIds !== undefined
        ? opts.presentIds.map(id => ({ id }))
        : disks,
      opts.prunable !== false,
    )
    for (const d of disks)
      this.tickBackoff(d.id)
    const due = disks.filter(d => this.isDue(d.id, this.reading.get(d.id)))
    if (due.length === 0)
      return
    await Promise.all(due.map(d => this.get(d.id, d.path)))
  }

  /**
   * The topology prune. A key is dropped only when the enumeration is
   * TRUSTWORTHY — non-empty (the caller passes prunable: false when the by-id
   * listing came back empty or failed, so no disk was named by id), and
   * listing only ids that resolved through by-id when the caller passed
   * `presentIds` — and the key has been absent from such a list for
   * PRUNE_AFTER_ABSENT_PASSES consecutive passes. One empty
   * `ls /dev/disk/by-id/` must not prune the whole cache, sleeping disks'
   * preserved identities included.
   */
  private pruneAbsent(disks: Array<{ id: string }>, prunable: boolean): void {
    if (!prunable || disks.length === 0)
      return
    const present = new Set(disks.map(d => d.id))
    for (const key of [...this.reading.keys()]) {
      if (present.has(key)) {
        this.absentPasses.delete(key)
        continue
      }
      const n = (this.absentPasses.get(key) ?? 0) + 1
      if (n < PRUNE_AFTER_ABSENT_PASSES) {
        this.absentPasses.set(key, n)
        continue
      }
      this.reading.delete(key)
      this.measured.delete(key)
      this.backoff.delete(key)
      this.absentPasses.delete(key)
    }
  }

  private async load(diskId: string, devicePath: string): Promise<DiskIdentity> {
    const result = await this.fetchFromSmartctl(devicePath)
    if (result.kind === 'standby') {
      // The disk is asleep and we declined to wake it — nothing was measured.
      // Report the last measured identity marked standby+stale, or a
      // no-claim placeholder if the disk was never seen awake. The measured
      // map is untouched, and this reading is NOT a cache hit: the disk may
      // wake at any time, so the next pass retries. The disk did ANSWER
      // (smartctl read its power state), so any re-probe backoff is cleared.
      this.backoff.delete(diskId)
      const last = this.measured.get(diskId)
      const identity = last
        ? { ...last, standby: true, stale: true, staleReason: 'standby' as const }
        : { ...emptyIdentity(), standby: true }
      this.reading.set(diskId, identity)
      return identity
    }
    if (result.kind === 'error') {
      // A probe ERROR is not a measurement. It must not overwrite the good
      // measured identity (one transient smartctl failure blanking
      // model/serial/health for the daemon's lifetime was the bug), and it
      // must not end the re-probes: the reading is not a cache hit, so the
      // disk is probed again — but BOUNDED, since a disk that fails forever
      // must not be probed on every pass. Each consecutive failure doubles
      // the delay (1, 2, 4, … passes, capped).
      const failures = (this.backoff.get(diskId)?.failures ?? 0) + 1
      this.backoff.set(diskId, { failures, skip: probeBackoffSkip(failures) })
      const prior = this.reading.get(diskId)
      const last = this.measured.get(diskId)
      const identity = {
        ...(last ?? prior ?? emptyIdentity()),
        // The power mode rides the spread above: the probe reported nothing,
        // so the LAST MEASURED mode is what is carried, dated by the same
        // `measuredAt` — shown as "as of <age>", never as a fresh claim.
        standby: false,
        // `stale` is "last known, not current" — a claim only a REAL prior
        // reading can support. A disk never measured gets the re-probe duty
        // (staleReason) without the mark: "last known" about a reading that
        // never happened would be a lie.
        ...(last
          ? { stale: true, staleReason: 'probe-failed' as const }
          : { staleReason: 'probe-failed' as const }),
      }
      this.reading.set(diskId, identity)
      return identity
    }
    // A fresh measurement: the disk answers, so the backoff is over.
    this.backoff.delete(diskId)
    this.measured.set(diskId, result.identity)
    this.reading.set(diskId, result.identity)
    return result.identity
  }

  private async fetchFromSmartctl(
    devicePath: string,
  ): Promise<{ kind: 'standby' } | { kind: 'error' } | { kind: 'measured', identity: DiskIdentity }> {
    try {
      // -n standby: if the disk is asleep, smartctl checks the power mode and
      // exits without issuing anything that would spin it up. -iH is identity +
      // health check (no full scan), fast.
      const result = await this.executor.exec('/usr/sbin/smartctl', ['-n', 'standby', '-iH', '--json', devicePath])
      // Standby FIRST: a standby skip also exits with bit 1, so the power-mode
      // check must win the classification or a sleeping disk reads as a
      // failure.
      if (isSmartctlStandby(result))
        return { kind: 'standby' }
      let data: any
      try {
        data = JSON.parse(result.stdout)
      }
      catch {
        // not a document at all — the raw failure text is the only record
        return { kind: 'error' }
      }
      // smartctl --json emits a VALID document on failure too (an open
      // failure: exit bit 1, a severity 'error' message, no device fields),
      // and the executor RESOLVES on a non-zero exit — so a real probe
      // failure arrives here as a "successful" parse. Classify it, or the
      // all-null identity it would build overwrites a good measured one and
      // caches as a hit: the disk blank for the daemon's lifetime.
      if (isSmartctlProbeFailure(data))
        return { kind: 'error' }
      return {
        kind: 'measured',
        identity: {
          modelFamily: data.model_family ?? null,
          deviceModel: data.model_name ?? null,
          formFactor: data.form_factor?.name ?? null,
          firmwareVersion: data.firmware_version ?? null,
          interface: formatInterface(data),
          trimSupport: !!data.trim?.supported,
          smartHealthy: data.smart_status?.passed ?? null,
          powerMode: parsePowerMode(data),
          measuredAt: this.now(),
        },
      }
    }
    catch {
      // smartctl failed (could not even start). Report the error — NOT a
      // measured reading: an empty measured identity would overwrite a good
      // one and cache as a hit, so the disk was never probed again, even once
      // smartctl recovered. load() decides what the error means per disk.
      return { kind: 'error' }
    }
  }
}

function emptyIdentity(): DiskIdentity {
  return {
    modelFamily: null,
    deviceModel: null,
    formFactor: null,
    firmwareVersion: null,
    interface: null,
    trimSupport: false,
    smartHealthy: null,
  }
}

function formatInterface(data: any): string | null {
  if (data.sata_version?.string)
    return data.sata_version.string
  if (data.nvme_version?.string)
    return `NVMe ${data.nvme_version.string}`
  if (data.device?.protocol)
    return data.device.protocol
  return null
}
