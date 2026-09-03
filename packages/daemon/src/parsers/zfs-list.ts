/**
 * Parsers for `zfs list -j` and `zfs get -j` output (ZFS 2.3+ JSON).
 *
 * Mirrors the zpool parsers: read the structured `-j` output, pull typed
 * values out of the `properties.<name>.value` bag, and identify datasets by
 * their stable ZFS name/path (Principle 13).
 */

import type { Dataset, DatasetProperties, Snapshot } from '@anas/shared'
import { parseDedupRatio, parseHumanSize, parseZfsBool, parseZfsDate, parseZfsJson } from './utils.js'

interface ZfsPropertyRaw {
  /**
   * libzfs prints every property value as a JSON STRING, `-p` included — so a
   * byte count arrives as `"1331439861760"`, not `1331439861760`. That is what
   * a real node emits today; typing the field as `string | number` and reading
   * it through `String()` costs nothing and means a libzfs that ever switched
   * to real JSON numbers could not silently turn a safety gate's size into a
   * parse failure (issue #50).
   */
  value: string | number
  source?: { type: string, data: string }
}

interface ZfsDatasetRaw {
  name: string
  /** "FILESYSTEM" | "VOLUME" | "SNAPSHOT" | "BOOKMARK" */
  type: string
  pool?: string
  /** Parent dataset (present on SNAPSHOT entries), e.g. "tank/media". */
  dataset?: string
  /** Label after '@' (present on SNAPSHOT entries), e.g. "nightly". */
  snapshot_name?: string
  /** Creation transaction group — monotonic, breaks creation-time ties. */
  createtxg?: string
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
  = 'name,used,available,referenced,quota,mountpoint,compression,compressratio,type,'
    + 'volsize,volblocksize,refreservation'

/**
 * `zfs list` argument array for a pool's dataset tree (filesystems + volumes).
 *
 * `-p` is NOT cosmetic and must not be dropped (issue #50). Without it every
 * number in this output is the DISPLAY form — three significant digits — so a
 * 1,331,439,861,760-byte zvol comes back as `1.21T` and reconstructs as
 * 1,330,409,069,609: ~983 MiB light. This list is what feeds
 * `assertVolumeMutable`, the never-shrink gate, so a requested volsize
 * anywhere inside that rounding window read as a GROW and `zfs set volsize=`
 * truncated a possibly-live volume in silence. A gate may only ever compare
 * exact bytes. (Principle 12 asks for machine-parseable output; `-j` alone
 * satisfies the letter of it and not the spirit — the envelope is structured,
 * the values inside it were still rounded for a human.)
 *
 * The snapshot listings below deliberately stay in display form: they carry no
 * gate, and `creation` under `-p` becomes an epoch integer that `parseZfsDate`
 * does not read.
 */
export function zfsListArgs(pool: string): string[] {
  return ['list', '-j', '-p', '-r', '-o', ZFS_LIST_PROPS, '-t', 'filesystem,volume', pool]
}

// NOTE: no `-r`. A dataset's snapshot list must be DIRECT-only — `-r` pulls in
// child datasets' snapshots (e.g. testdata's list would include testdata/dajunk@…),
// which the tree then wrongly shows under the parent. Each dataset node shows
// only its own snapshots.

/** `zfs list` argument array for a dataset's own snapshots (name only). */
export function zfsSnapshotListArgs(dataset: string): string[] {
  return ['list', '-j', '-o', 'name', '-t', 'snapshot', dataset]
}

/**
 * `zfs list` argument array for a dataset's own snapshots with the columns the
 * Snapshot read model needs (creation/used/referenced).
 */
export function zfsSnapshotDetailArgs(dataset: string): string[] {
  return ['list', '-j', '-o', 'name,creation,used,referenced', '-t', 'snapshot', dataset]
}

/**
 * A `properties.<name>.value` reader for one raw dataset, always as a string —
 * the one place a JSON-number value (see {@link ZfsPropertyRaw}) is normalised,
 * so no downstream parser has to guess at the type it was handed.
 */
function propReader(ds: ZfsDatasetRaw): (name: string) => string {
  return (name: string) => {
    const v = ds.properties[name]?.value
    return v === undefined || v === null ? '' : String(v)
  }
}

/** Normalise a ZFS mountpoint value to a path or null (volumes / unmounted). */
function normalizeMountpoint(value: string): string | null {
  if (!value || value === '-' || value === 'none' || value === 'legacy')
    return null
  return value
}

/**
 * The volume-only fields of a Dataset (story iscsi.3), or `{}` for anything
 * that is not a zvol. Additive + optional by contract: on a filesystem the keys
 * are ABSENT, never zero, so "no volsize" and "volsize 0" stay distinguishable.
 *
 * `sparse` is derived, not read: ZFS has no `sparse` property. What `zfs create
 * -s` actually does is omit the refreservation, so a volume is thin exactly
 * when `refreservation` is `none` — which under `-p` prints as a literal `0`
 * (issue #50). Both spellings parse to 0 bytes, so the derivation is unchanged
 * by the flag. (It stays honest afterwards too: an operator
 * who clears the refreservation by hand has thinned the volume, and this
 * reports it.) A volume list that predates the extra columns simply yields
 * `undefined` for each and the UI degrades.
 */
function volumeFields(
  type: 'filesystem' | 'volume',
  prop: (name: string) => string,
): { volsize?: number, volblocksize?: number, sparse?: boolean } {
  if (type !== 'volume')
    return {}

  const out: { volsize?: number, volblocksize?: number, sparse?: boolean } = {}
  const volsize = prop('volsize')
  if (volsize && volsize !== '-')
    out.volsize = parseHumanSize(volsize)
  const volblocksize = prop('volblocksize')
  if (volblocksize && volblocksize !== '-')
    out.volblocksize = parseHumanSize(volblocksize)
  const refres = prop('refreservation')
  if (refres && refres !== '-')
    out.sparse = parseHumanSize(refres) === 0
  return out
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
  const data: ZfsListOutput = parseZfsJson(json, { datasets: {} })
  const result: Dataset[] = []

  for (const ds of Object.values(data.datasets)) {
    const type = datasetKind(ds.type)
    if (!type)
      continue

    const prop = propReader(ds)
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
      ...volumeFields(type, prop),
    })
  }

  return result
}

/**
 * ZFS's OWN default `volblocksize`, in bytes, read out of a `zfs list -j` that
 * already carries the column — or null when nothing in the output can attest to
 * it (story iscsi.3).
 *
 * The Create dialog must STATE the default rather than hard-code one, because
 * `volblocksize` is create-only and OpenZFS has moved the default before (8K to
 * 16K in 2.2). There is no module parameter to read it from — checked on a real
 * node, `/sys/module/zfs/parameters` has no such knob — so the only honest
 * source is an existing volume whose value ZFS reports as DEFAULT-sourced. That
 * lives in the list output we already fetched, so this costs no extra command.
 *
 * Null is a real answer ("this pool has no volume to learn it from"), and the
 * dialog says "ZFS default" with no number rather than inventing one.
 */
export function parseVolblocksizeDefault(json: string | ZfsListOutput): number | null {
  const data: ZfsListOutput = parseZfsJson(json, { datasets: {} })
  for (const ds of Object.values(data.datasets)) {
    if (ds.type.toLowerCase() !== 'volume')
      continue
    const raw = ds.properties.volblocksize
    if (!raw || raw.source?.type !== 'DEFAULT')
      continue
    const bytes = parseHumanSize(raw.value)
    if (bytes > 0)
      return bytes
  }
  return null
}

/** Snapshot names from a `zfs list -t snapshot` output. */
export function parseSnapshotNames(json: string | ZfsListOutput): string[] {
  const data: ZfsListOutput = parseZfsJson(json, { datasets: {} })
  return Object.values(data.datasets)
    .filter(ds => ds.type.toLowerCase() === 'snapshot')
    .map(ds => ds.name)
}

/**
 * Parse `zfs list -j -t snapshot` output into the Snapshot read model, sorted
 * newest-first. `created` comes from the human `creation` string (→ ISO);
 * `used`/`referenced` from the human sizes. Ordering is by creation time
 * descending, with the monotonic `createtxg` breaking ties (and standing in
 * when a creation string fails to parse).
 */
export function parseSnapshotList(json: string | ZfsListOutput): Snapshot[] {
  const data: ZfsListOutput = parseZfsJson(json, { datasets: {} })
  const result: (Snapshot & { _createtxg: number })[] = []

  for (const ds of Object.values(data.datasets)) {
    if (ds.type.toLowerCase() !== 'snapshot')
      continue

    const prop = propReader(ds)
    const atIndex = ds.name.indexOf('@')
    const dataset = ds.dataset ?? (atIndex >= 0 ? ds.name.slice(0, atIndex) : ds.name)
    const snapshotName = ds.snapshot_name ?? (atIndex >= 0 ? ds.name.slice(atIndex + 1) : ds.name)
    const created = parseZfsDate(prop('creation'))

    result.push({
      name: ds.name,
      dataset,
      snapshotName,
      pool: ds.pool ?? ds.name.split('/')[0],
      created: created ?? new Date(0).toISOString(),
      used: parseHumanSize(prop('used')),
      referenced: parseHumanSize(prop('referenced')),
      _createtxg: Number.parseInt(ds.createtxg ?? '', 10) || 0,
    })
  }

  result.sort((a, b) => {
    if (a.created !== b.created)
      return a.created < b.created ? 1 : -1
    return b._createtxg - a._createtxg
  })

  return result.map(({ _createtxg, ...snap }) => snap)
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
  const data: ZfsListOutput = parseZfsJson(json, { datasets: {} })
  const ds = data.datasets[datasetName]
  if (!ds)
    return null

  const type = datasetKind(ds.type)
  if (!type)
    return null

  const prop = propReader(ds)

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
    ...volumeFields(type, prop),
  }

  const all: Record<string, string> = {}
  for (const [key, val] of Object.entries(ds.properties))
    all[key] = String(val.value)

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
