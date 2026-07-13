/**
 * Parsers for `zfs list -j` and `zfs get -j` output (ZFS 2.3+ JSON).
 *
 * Mirrors the zpool parsers: read the structured `-j` output, pull typed
 * values out of the `properties.<name>.value` bag, and identify datasets by
 * their stable ZFS name/path (Principle 13).
 */

import type { Dataset, DatasetProperties } from '@anas/shared'
import { parseDedupRatio, parseHumanSize, parseZfsBool } from './utils.js'

interface ZfsPropertyRaw {
  value: string
  source?: { type: string, data: string }
}

interface ZfsDatasetRaw {
  name: string
  /** "FILESYSTEM" | "VOLUME" | "SNAPSHOT" | "BOOKMARK" */
  type: string
  pool?: string
  properties: Record<string, ZfsPropertyRaw>
}

interface ZfsListOutput {
  datasets: Record<string, ZfsDatasetRaw>
}

/**
 * Canonical property columns requested from `zfs list`. Full property names
 * (not the short `avail`/`refer` header aliases) so they key the JSON
 * `properties` map the same way `zfs get` does.
 */
export const ZFS_LIST_PROPS
  = 'name,used,available,referenced,quota,mountpoint,compression,compressratio,type'

/** `zfs list` argument array for a pool's dataset tree (filesystems + volumes). */
export function zfsListArgs(pool: string): string[] {
  return ['list', '-j', '-r', '-o', ZFS_LIST_PROPS, '-t', 'filesystem,volume', pool]
}

/** `zfs list` argument array for a dataset's snapshots (name only). */
export function zfsSnapshotListArgs(dataset: string): string[] {
  return ['list', '-j', '-r', '-o', 'name', '-t', 'snapshot', dataset]
}

/** Normalise a ZFS mountpoint value to a path or null (volumes / unmounted). */
function normalizeMountpoint(value: string): string | null {
  if (!value || value === '-' || value === 'none' || value === 'legacy')
    return null
  return value
}

/** Map the raw ZFS dataset kind to the shared enum, or null if not a dataset. */
function datasetKind(rawType: string): 'filesystem' | 'volume' | null {
  const t = rawType.toLowerCase()
  if (t === 'filesystem' || t === 'volume')
    return t
  return null
}

/**
 * Parse `zfs list -j` output into a flat list of datasets. Snapshots and
 * bookmarks are skipped — they are their own resource (Epic 5). The UI builds
 * the tree from these by splitting names on '/'.
 */
export function parseZfsList(json: string | ZfsListOutput): Dataset[] {
  const data: ZfsListOutput = typeof json === 'string' ? JSON.parse(json) : json
  const result: Dataset[] = []

  for (const ds of Object.values(data.datasets)) {
    const type = datasetKind(ds.type)
    if (!type)
      continue

    const prop = (name: string) => ds.properties[name]?.value ?? ''
    result.push({
      name: ds.name,
      pool: ds.pool ?? ds.name.split('/')[0],
      type,
      used: parseHumanSize(prop('used')),
      available: parseHumanSize(prop('available')),
      referenced: parseHumanSize(prop('referenced')),
      mountpoint: normalizeMountpoint(prop('mountpoint')),
      compression: prop('compression') || 'off',
      compressratio: parseDedupRatio(prop('compressratio')),
      quota: parseHumanSize(prop('quota')),
    })
  }

  return result
}

/** Snapshot names from a `zfs list -t snapshot` output. */
export function parseSnapshotNames(json: string | ZfsListOutput): string[] {
  const data: ZfsListOutput = typeof json === 'string' ? JSON.parse(json) : json
  return Object.values(data.datasets)
    .filter(ds => ds.type.toLowerCase() === 'snapshot')
    .map(ds => ds.name)
}

function parseSync(value: string): 'standard' | 'always' | 'disabled' {
  if (value === 'always' || value === 'disabled')
    return value
  return 'standard'
}

/**
 * Parse `zfs get -j all <dataset>` for one dataset into its summary + full
 * typed properties. Returns null if the dataset is absent from the output or
 * is not a filesystem/volume. `all` carries the complete property bag for
 * advanced users.
 */
export function parseDatasetGet(
  json: string | ZfsListOutput,
  datasetName: string,
): { base: Dataset, properties: DatasetProperties } | null {
  const data: ZfsListOutput = typeof json === 'string' ? JSON.parse(json) : json
  const ds = data.datasets[datasetName]
  if (!ds)
    return null

  const type = datasetKind(ds.type)
  if (!type)
    return null

  const prop = (name: string) => ds.properties[name]?.value ?? ''

  const base: Dataset = {
    name: ds.name,
    pool: ds.pool ?? ds.name.split('/')[0],
    type,
    used: parseHumanSize(prop('used')),
    available: parseHumanSize(prop('available')),
    referenced: parseHumanSize(prop('referenced')),
    mountpoint: normalizeMountpoint(prop('mountpoint')),
    compression: prop('compression') || 'off',
    compressratio: parseDedupRatio(prop('compressratio')),
    quota: parseHumanSize(prop('quota')),
  }

  const all: Record<string, string> = {}
  for (const [key, val] of Object.entries(ds.properties))
    all[key] = val.value

  const properties: DatasetProperties = {
    compression: prop('compression') || 'off',
    recordsize: parseHumanSize(prop('recordsize')),
    quota: parseHumanSize(prop('quota')),
    reservation: parseHumanSize(prop('reservation')),
    refquota: parseHumanSize(prop('refquota')),
    refreservation: parseHumanSize(prop('refreservation')),
    atime: parseZfsBool(prop('atime')),
    dedup: prop('dedup') || 'off',
    sync: parseSync(prop('sync')),
    readonly: parseZfsBool(prop('readonly')),
    all,
  }

  return { base, properties }
}
