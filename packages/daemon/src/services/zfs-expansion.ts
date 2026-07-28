/**
 * ZFS pool expansion helpers (story 3.31, daemon stage 1).
 *
 * The composer offers three outcomes off a single dropped disk, keyed by WHERE
 * it lands (drop-location = intent):
 *   - mirror / single-disk leaf → `zpool attach` a mirror leg (+redundancy)
 *   - raidz vdev                → RAIDZ EXPANSION `zpool attach <raidz-vdev> <new>` (+capacity)
 * This module supplies the version detection, the gate evaluation, and the
 * HONEST raidz capacity math the route and the (stage-2) UI consume.
 */

import type { ExpansionCapability, ExpansionTarget, Vdev } from '@anas/shared'
import type { CommandExecutor } from '../executor/types.js'
import type { ZfsVersion } from '../parsers/zfs-version.js'
import type { ParsedPoolStatus, PoolBusyState } from '../parsers/zpool-status.js'
import { parseZfsVersion, supportsRaidzExpansion } from '../parsers/zfs-version.js'

const ZFS = '/usr/sbin/zfs'

/** The pool feature flag that gates raidz expansion. */
export const RAIDZ_EXPANSION_FEATURE = 'feature@raidz_expansion'

/** Detect the LOCAL OpenZFS module version via `zfs version`. Fail-soft → null. */
export async function detectLocalZfsVersion(executor: CommandExecutor): Promise<ZfsVersion | null> {
  const res = await executor.exec(ZFS, ['version'])
  if (res.exitCode !== 0)
    return null
  return parseZfsVersion(res.stdout)
}

/** raidz parity count by vdev type, or null when the type is not a raidz. */
export function raidzParity(type: string): number | null {
  if (type === 'raidz')
    return 1
  if (type === 'raidz2')
    return 2
  if (type === 'raidz3')
    return 3
  return null
}

/** feature@raidz_expansion value → the schema's featureState + enabled flag. */
export function featureStateOf(value: string | null): { state: ExpansionCapability['featureState'], enabled: boolean } {
  if (value === 'active')
    return { state: 'active', enabled: true }
  if (value === 'enabled')
    return { state: 'enabled', enabled: true }
  if (value === 'disabled')
    return { state: 'disabled', enabled: false }
  return { state: 'unknown', enabled: false }
}

/** Assemble the node/pool raidz-expansion capability from its three inputs. */
export function buildCapability(
  version: ZfsVersion | null,
  featureValue: string | null,
): ExpansionCapability {
  const moduleSupported = supportsRaidzExpansion(version)
  const { state, enabled } = featureStateOf(featureValue)
  return {
    zfsVersion: version?.raw ?? null,
    moduleSupported,
    featureState: state,
    featureEnabled: enabled,
    raidzExpandAvailable: moduleSupported && enabled,
  }
}

/** The honest raidz capacity delta of widening a vdev by one disk. */
export interface RaidzCapacity {
  /** Usable bytes of one added data column — the naive "+1 disk" figure. */
  naiveUsableGainBytes: number
  /** Honest realized usable gain (< naive); omitted when allocation is unknown. */
  honestUsableGainBytes?: number
  advisories: string[]
}

/**
 * Compute the HONEST usable gain of adding one disk to a raidz vdev.
 *
 * Capacity model (documented ESTIMATE — live-verify on pve5). For a raidz vdev,
 * `Vdev.size` (from `total_space`) is the RAW size — confirmed against captured
 * fixtures where a 3×~500 MiB raidz1 reports total_space ≈ 3 columns raw, not
 * the deflated usable. So per raw column `cRaw = size / w`.
 *
 * Widening by one disk (width w → w+1, same parity p, same column size):
 *   - naive usable gain            = cRaw           (one more DATA column)
 *   - existing data is NOT re-laid-out: its allocated raw stays at the old
 *     parity ratio (w−p)/w; only newly-freed raw is usable at the better new
 *     ratio (w+1−p)/(w+1). So the realized gain is LESS than naive, converging
 *     on naive only for an empty vdev.
 *
 *   honestTotalUsable = allocRaw·(w−p)/w  +  (rawAfter − allocRaw)·(w+1−p)/(w+1)
 *   honestGain        = honestTotalUsable − size·(w−p)/w
 */
export function raidzExpansionCapacity(vdev: Vdev, parity: number): RaidzCapacity {
  const advisories: string[] = [
    'RAIDZ expansion does not re-lay-out existing data — blocks written before the expansion keep their old parity ratio, so realized free space grows by LESS than one full disk until the data is rewritten (send/recv or in-place copy) at the new ratio.',
  ]

  const w = vdev.disks.length
  const dataCols = w - parity
  const size = vdev.size ?? 0
  if (dataCols <= 0 || size <= 0 || w <= 0)
    return { naiveUsableGainBytes: 0, advisories }

  const cRaw = size / w // raw per column ≈ usable per DATA column at the new ratio
  const naiveUsableGainBytes = Math.round(cRaw)

  // A widened raidz1 keeps single-disk parity over a wider stripe — more
  // exposure. Flag it once the post-expansion stripe gets wide.
  if (parity === 1 && w + 1 >= 8) {
    advisories.push(`Widening this RAIDZ1 to ${w + 1} disks keeps single-disk fault tolerance across a wider stripe (more exposure per parity disk). Consider RAIDZ2 for wide vdevs.`)
  }

  const result: RaidzCapacity = { naiveUsableGainBytes, advisories }

  const alloc = vdev.allocated
  if (alloc !== undefined && alloc >= 0) {
    const wNew = w + 1
    const dataColsNew = wNew - parity
    const rawAfter = cRaw * wNew
    const usableStored = alloc * (dataCols / w) // logical bytes behind the raw alloc
    const freeUsableNew = Math.max(0, rawAfter - alloc) * (dataColsNew / wNew)
    const usableBefore = size * (dataCols / w)
    const honestGain = Math.max(0, usableStored + freeUsableNew - usableBefore)
    result.honestUsableGainBytes = Math.round(honestGain)
  }

  return result
}

/**
 * Build the per-data-vdev expansion targets for the composer's read model. Each
 * top-level DATA vdev becomes one drop target; its kind and allowed/reason are
 * derived from the vdev type, the node capability, and the busy state.
 */
export function buildExpansionTargets(
  status: ParsedPoolStatus,
  poolName: string,
  capability: ExpansionCapability,
  busy: PoolBusyState,
): ExpansionTarget[] {
  const targets: ExpansionTarget[] = []
  const dataGroup = status.vdevGroups.find(g => g.role === 'data')
  if (!dataGroup)
    return targets

  for (const vdev of dataGroup.vdevs) {
    const parity = raidzParity(vdev.type)

    if (parity !== null) {
      // RAIDZ vdev → raidz-expand.
      const degraded = vdev.state !== 'ONLINE'
      const cap = raidzExpansionCapacity(vdev, parity)
      let allowed = true
      let reason: ExpansionTarget['reason']
      let reasonDetail: string | undefined
      if (busy.busy) {
        allowed = false
        reason = 'busy'
        reasonDetail = busyDetail(busy, poolName)
      }
      else if (!capability.moduleSupported) {
        allowed = false
        reason = 'version'
        reasonDetail = `RAIDZ expansion needs OpenZFS ≥ 2.3.0; this node runs ${capability.zfsVersion ?? 'an undetectable version'}.`
      }
      else if (!capability.featureEnabled) {
        allowed = false
        reason = 'flag'
        reasonDetail = `Pool '${poolName}' has feature@raidz_expansion ${capability.featureState}. Enable it with: zpool upgrade ${poolName}`
      }
      else if (degraded) {
        allowed = false
        reason = 'degraded'
        reasonDetail = `Vdev ${vdev.name} is ${vdev.state} — a raidz cannot be widened while degraded; restore it first.`
      }
      targets.push({
        vdevName: vdev.name,
        vdevType: vdev.type,
        kind: 'raidz-expand',
        allowed,
        ...(reason && { reason }),
        ...(reasonDetail && { reasonDetail }),
        naiveUsableGainBytes: cap.naiveUsableGainBytes,
        ...(cap.honestUsableGainBytes !== undefined && { honestUsableGainBytes: cap.honestUsableGainBytes }),
        advisories: cap.advisories,
      })
    }
    else if (vdev.type === 'mirror' || vdev.type === 'disk') {
      // Mirror / single-disk vdev → attach a mirror leg (+redundancy). Busy-gated
      // (mirror-attach yields the same double-write pressure), never version-gated.
      const allowed = !busy.busy
      targets.push({
        vdevName: vdev.name,
        vdevType: vdev.type,
        kind: 'attach-leg',
        allowed,
        ...(busy.busy && { reason: 'busy' as const, reasonDetail: busyDetail(busy, poolName) }),
        advisories: [],
      })
    }
    else {
      // draid / other — not expandable by attach in this story.
      targets.push({
        vdevName: vdev.name,
        vdevType: vdev.type,
        kind: 'attach-leg',
        allowed: false,
        reason: 'unsupported',
        reasonDetail: `${vdev.type} vdevs cannot be expanded by attaching a disk.`,
        advisories: [],
      })
    }
  }
  return targets
}

/** The shared "try again when it finishes" busy message (route + read model). */
export function busyDetail(busy: PoolBusyState, poolName: string): string {
  const op = busy.operation === 'raidz-expand' ? 'a RAIDZ-expansion reflow' : 'a resilver'
  const pct = busy.percentComplete !== undefined ? ` (${busy.percentComplete}% done)` : ''
  return `Pool '${poolName}' has ${op} in progress${pct} — try again when it finishes.`
}
