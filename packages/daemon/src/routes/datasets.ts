import type { CreateDatasetRequest, Dataset, DatasetDetail, MountpointPermissions, Snapshot, UpdateDatasetPropertiesRequest } from '@anas/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import { CreateDatasetRequest as CreateDatasetRequestSchema, CreateSnapshotRequest, DatasetPath, PoolName, RenameSnapshotRequest, SetPermissionsRequest, SnapshotName, UpdateDatasetPropertiesRequest as UpdateDatasetPropertiesRequestSchema } from '@anas/shared'
import { parseDatasetGet, parseSnapshotList, parseSnapshotNames, parseZfsList, zfsListArgs, zfsSnapshotDetailArgs, zfsSnapshotListArgs } from '../parsers/zfs-list.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { confirmGate } from '../safety/gate.js'
import { requireIdentity } from './identity.js'

const ZFS = '/usr/sbin/zfs'
const STAT = '/usr/bin/stat'
const CHOWN = '/usr/bin/chown'
const CHMOD = '/usr/bin/chmod'

/** Whitespace splitter for `stat` output (owner group mode). */
const WHITESPACE_RE = /\s+/

/** Build the `zfs create` argument array from a validated request. */
function buildCreateArgs(fullName: string, req: CreateDatasetRequest): string[] {
  const args = ['create']
  const p = req.properties
  if (p) {
    if (p.compression !== undefined)
      args.push('-o', `compression=${p.compression}`)
    if (p.recordsize !== undefined)
      args.push('-o', `recordsize=${p.recordsize}`)
    if (p.quota !== undefined)
      args.push('-o', `quota=${p.quota === 0 ? 'none' : p.quota}`)
    if (p.reservation !== undefined)
      args.push('-o', `reservation=${p.reservation === 0 ? 'none' : p.reservation}`)
    if (p.mountpoint !== undefined)
      args.push('-o', `mountpoint=${p.mountpoint}`)
  }
  args.push(fullName)
  return args
}

/**
 * Build one `<prop>=<value>` token per changed property (fed to `zfs set`).
 * Booleans map to on/off; a 0 quota/reservation means 'none'; the rest pass
 * through as-is. Only the settable properties in the shared schema are mapped —
 * anything else is silently absent (structured operations, Principle 5).
 */
function buildSetPairs(p: UpdateDatasetPropertiesRequest['properties']): string[] {
  const pairs: string[] = []
  const size = (n: number) => (n === 0 ? 'none' : String(n))
  if (p.compression !== undefined)
    pairs.push(`compression=${p.compression}`)
  if (p.recordsize !== undefined)
    pairs.push(`recordsize=${p.recordsize}`)
  if (p.quota !== undefined)
    pairs.push(`quota=${size(p.quota)}`)
  if (p.reservation !== undefined)
    pairs.push(`reservation=${size(p.reservation)}`)
  if (p.refquota !== undefined)
    pairs.push(`refquota=${size(p.refquota)}`)
  if (p.refreservation !== undefined)
    pairs.push(`refreservation=${size(p.refreservation)}`)
  if (p.atime !== undefined)
    pairs.push(`atime=${p.atime ? 'on' : 'off'}`)
  if (p.sync !== undefined)
    pairs.push(`sync=${p.sync}`)
  if (p.readonly !== undefined)
    pairs.push(`readonly=${p.readonly ? 'on' : 'off'}`)
  if (p.dedup !== undefined)
    pairs.push(`dedup=${p.dedup}`)
  return pairs
}

/**
 * The snapshot sub-resource of a dataset wildcard, or null if the wildcard is a
 * plain dataset path. find-my-way only allows a terminal wildcard, so the whole
 * `<datasetpath>/snapshots/<snap>/<action>` tail arrives as one `*` capture.
 * Split on the `snapshots` path segment: everything before it is the dataset
 * path (may contain '/'), everything after is the snapshot sub-resource.
 * Snapshot names never contain '/', so this is unambiguous.
 *
 *   media/snapshots                 → { datasetPath: 'media' }                       (collection)
 *   media/movies/snapshots/snap1    → { datasetPath: 'media/movies', snap: 'snap1' } (item)
 *   media/snapshots/snap1/rollback  → { datasetPath: 'media', snap: 'snap1', rollback }
 *   snapshots                       → { datasetPath: '' }                            (pool-root dataset)
 */
interface SnapshotTail {
  datasetPath: string
  snap?: string
  rollback: boolean
  /** Trailing segments we don't understand (→ 404). */
  extra: boolean
}

function parseSnapshotTail(wildcard: string): SnapshotTail | null {
  const parts = wildcard.split('/')
  const idx = parts.indexOf('snapshots')
  if (idx === -1)
    return null

  const datasetPath = parts.slice(0, idx).join('/')
  const rest = parts.slice(idx + 1)
  const snap = rest[0]
  const rollback = rest.length === 2 && rest[1] === 'rollback'
  const known = rest.length === 0 || rest.length === 1 || rollback
  return { datasetPath, snap, rollback, extra: !known }
}

export async function datasetRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, jobQueue: JobQueue, confirmStore: ConfirmStore },
) {
  const { executor, jobQueue, confirmStore } = opts

  /** Does the named pool exist? (source of truth is `zpool list`). */
  async function poolExists(poolName: string): Promise<boolean> {
    const r = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = r.exitCode === 0 && r.stdout.trim() ? parseZpoolList(r.stdout) : []
    return pools.some(p => p.name === poolName)
  }

  /** The pool's flat dataset list (filesystems + volumes). */
  async function listDatasets(poolName: string): Promise<Dataset[]> {
    const r = await executor.exec(ZFS, zfsListArgs(poolName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return parseZfsList(r.stdout)
  }

  /** Snapshot names below a dataset (for destroy warnings). */
  async function snapshotNames(fullName: string): Promise<string[]> {
    const r = await executor.exec(ZFS, zfsSnapshotListArgs(fullName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return parseSnapshotNames(r.stdout)
  }

  /** Does the named dataset (or pool-root dataset) exist? */
  async function datasetExists(poolName: string, fullName: string): Promise<boolean> {
    const datasets = await listDatasets(poolName)
    return datasets.some(d => d.name === fullName)
  }

  /** A dataset's snapshots, newest-first (empty when it has none). */
  async function listSnapshotsDetail(fullName: string): Promise<Snapshot[]> {
    const r = await executor.exec(ZFS, zfsSnapshotDetailArgs(fullName))
    if (r.exitCode !== 0 || !r.stdout.trim())
      return []
    return parseSnapshotList(r.stdout)
  }

  /**
   * Resolve the pool + wildcard tail to a dataset full name, validating the
   * dataset path (empty tail = the pool-root dataset). Returns null after
   * sending a 400 on an invalid path.
   */
  function resolveDatasetName(poolName: string, datasetPath: string, reply: FastifyReply): string | null {
    if (!datasetPath)
      return poolName
    const parsed = DatasetPath.safeParse(datasetPath)
    if (!parsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${parsed.error.issues[0]?.message}` } })
      return null
    }
    return `${poolName}/${parsed.data}`
  }

  /** Stat a mountpoint for owner/group/mode, or null if it can't be read. */
  async function statMountpoint(mountpoint: string): Promise<MountpointPermissions | null> {
    const r = await executor.exec(STAT, ['-c', '%U %G %a', mountpoint])
    if (r.exitCode !== 0 || !r.stdout.trim())
      return null
    const [owner, group, mode] = r.stdout.trim().split(WHITESPACE_RE)
    if (!owner || !group || !mode)
      return null
    return { owner, group, mode }
  }

  // --- GET /pools/:name/datasets — flat list (UI builds the tree) ----------
  server.get<{ Params: { name: string } }>('/pools/:name/datasets', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    return { data: await listDatasets(poolName) }
  })

  // --- GET /pools/:name/datasets/*path — detail ---------------------------
  // Wildcard `*` captures the full (possibly nested) dataset path. The `PUT`
  // permissions action shares this wildcard because find-my-way only allows a
  // wildcard as the final path segment — see the PUT handler below.
  server.get<{ Params: { 'name': string, '*': string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const poolName = request.params.name
    const path = request.params['*']

    // Snapshot sub-resource: `<dataset>/snapshots[/<snap>]`.
    const tail = parseSnapshotTail(path)
    if (tail) {
      if (tail.extra) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Unknown snapshot resource '${path}'` } }
      }
      return tail.snap
        ? snapshotDetail(poolName, tail.datasetPath, tail.snap, reply)
        : listSnapshots(poolName, tail.datasetPath, reply)
    }

    const fullName = path ? `${poolName}/${path}` : poolName

    const r = await executor.exec(ZFS, ['get', '-j', 'all', fullName])
    if (r.exitCode !== 0 || !r.stdout.trim()) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    const parsed = parseDatasetGet(r.stdout, fullName)
    if (!parsed) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    // POSIX permissions from the mountpoint (filesystems only, when mounted).
    const permissions = parsed.base.type === 'filesystem' && parsed.base.mountpoint
      ? await statMountpoint(parsed.base.mountpoint)
      : null

    const detail: DatasetDetail = {
      ...parsed.base,
      properties: parsed.properties,
      permissions,
      // Populated once SMB/NFS shares exist (Epics 6/7).
      associatedShares: [],
    }

    return { data: detail }
  })

  // --- POST /pools/:name/datasets — create --------------------------------
  server.post<{ Params: { name: string } }>('/pools/:name/datasets', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = CreateDatasetRequestSchema.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data
    const fullName = `${poolName}/${req.path}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // 409 if it already exists — the system is the source of truth.
    const existing = await listDatasets(poolName)
    if (existing.some(d => d.name === fullName)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Dataset '${fullName}' already exists` } }
    }

    const args = buildCreateArgs(fullName, req)

    const job = jobQueue.submit(
      'zfs.create',
      { ...identity, params: { dataset: fullName } },
      async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs create exited with code ${result.exitCode}`)
        return { created: fullName }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- POST /pools/:name/datasets/*path/snapshots[...] — snapshot actions --
  // The only POST on the dataset wildcard is the snapshot sub-resource: create
  // a snapshot (collection) or roll back to one (`/snapshots/:snap/rollback`).
  server.post<{ Params: { 'name': string, '*': string }, Querystring: { force?: string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    const wildcard = request.params['*']

    const tail = parseSnapshotTail(wildcard)
    if (!tail || tail.extra || (tail.snap && !tail.rollback)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Unknown resource '${wildcard}'` } }
    }

    if (tail.rollback && tail.snap)
      return rollbackSnapshot(poolName, tail.datasetPath, tail.snap, request, reply)

    // Collection POST → create a snapshot.
    return createSnapshot(poolName, tail.datasetPath, request, reply)
  })

  // --- PUT /pools/:name/datasets/*path — update props OR permissions ------
  // find-my-way only permits a wildcard as the final segment, so a nested
  // dataset path plus a `/permissions` suffix cannot be two routes. We branch
  // here: a wildcard ending in `/permissions` is the SetPermissions action,
  // otherwise it is a property update.
  server.put<{ Params: { 'name': string, '*': string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    const wildcard = request.params['*']

    // Snapshot rename: `<dataset>/snapshots/<snap>`.
    const tail = parseSnapshotTail(wildcard)
    if (tail) {
      if (!tail.snap || tail.rollback || tail.extra) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Unknown snapshot resource '${wildcard}'` } }
      }
      return renameSnapshot(poolName, tail.datasetPath, tail.snap, request, reply)
    }

    const PERM_SUFFIX = '/permissions'
    if (wildcard === 'permissions' || wildcard.endsWith(PERM_SUFFIX)) {
      const path = wildcard === 'permissions' ? '' : wildcard.slice(0, -PERM_SUFFIX.length)
      return setPermissions(poolName, path, request, reply)
    }

    return updateProperties(poolName, wildcard, request, reply)
  })

  async function updateProperties(
    poolName: string,
    path: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const pathParsed = DatasetPath.safeParse(path)
    if (!pathParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${pathParsed.error.issues[0]?.message}` } }
    }
    const fullName = `${poolName}/${pathParsed.data}`

    const bodyParsed = UpdateDatasetPropertiesRequestSchema.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid property update: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const pairs = buildSetPairs(bodyParsed.data.properties)

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const existing = await listDatasets(poolName)
    if (!existing.some(d => d.name === fullName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    const job = jobQueue.submit(
      'zfs.set',
      { ...identity, params: { dataset: fullName, properties: bodyParsed.data.properties } },
      async (updateProgress) => {
        for (const pair of pairs) {
          updateProgress(`Setting ${pair} on ${fullName}`)
          const result = await executor.exec(ZFS, ['set', pair, fullName])
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `zfs set ${pair} exited with code ${result.exitCode}`)
        }
        return { dataset: fullName, applied: pairs }
      },
    )

    reply.code(202)
    return { job }
  }

  async function setPermissions(
    poolName: string,
    path: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    // Empty path targets the pool root dataset; otherwise validate the path.
    let fullName = poolName
    if (path) {
      const pathParsed = DatasetPath.safeParse(path)
      if (!pathParsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${pathParsed.error.issues[0]?.message}` } }
      }
      fullName = `${poolName}/${pathParsed.data}`
    }

    const bodyParsed = SetPermissionsRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid permissions request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { owner, group, mode, recursive } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Resolve the mountpoint from the dataset — permissions apply to the path.
    const r = await executor.exec(ZFS, ['get', '-j', 'all', fullName])
    if (r.exitCode !== 0 || !r.stdout.trim()) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    const parsed = parseDatasetGet(r.stdout, fullName)
    if (!parsed) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    const mountpoint = parsed.base.mountpoint
    if (!mountpoint) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Dataset '${fullName}' has no mountpoint (volume or unmounted)` } }
    }

    const job = jobQueue.submit(
      'fs.setPermissions',
      { ...identity, params: { dataset: fullName, mountpoint, owner, group, mode, recursive } },
      async (updateProgress) => {
        if (owner !== undefined || group !== undefined) {
          const spec = group !== undefined ? `${owner ?? ''}:${group}` : `${owner}`
          const args = recursive ? ['-R', spec, mountpoint] : [spec, mountpoint]
          updateProgress(`chown ${spec} ${mountpoint}`)
          const result = await executor.exec(CHOWN, args)
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `chown exited with code ${result.exitCode}`)
        }
        if (mode !== undefined) {
          const args = recursive ? ['-R', mode, mountpoint] : [mode, mountpoint]
          updateProgress(`chmod ${mode} ${mountpoint}`)
          const result = await executor.exec(CHMOD, args)
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `chmod exited with code ${result.exitCode}`)
        }
        return { dataset: fullName, mountpoint }
      },
    )

    reply.code(202)
    return { job }
  }

  // --- DELETE /pools/:name/datasets/*path — destroy (dangerous) -----------
  server.delete<{ Params: { 'name': string, '*': string }, Querystring: { recursive?: string } }>('/pools/:name/datasets/*', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    // Snapshot destroy: `<dataset>/snapshots/<snap>` (plain 202, no confirm).
    const tail = parseSnapshotTail(request.params['*'])
    if (tail) {
      if (!tail.snap || tail.rollback || tail.extra) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Unknown snapshot resource '${request.params['*']}'` } }
      }
      return destroySnapshot(poolName, tail.datasetPath, tail.snap, request, reply)
    }

    const pathParsed = DatasetPath.safeParse(request.params['*'])
    if (!pathParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid dataset path: ${pathParsed.error.issues[0]?.message}` } }
    }
    const fullName = `${poolName}/${pathParsed.data}`
    const recursive = request.query.recursive === 'true' || request.query.recursive === '1'

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const datasets = await listDatasets(poolName)
    if (!datasets.some(d => d.name === fullName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    const children = datasets.filter(d => d.name.startsWith(`${fullName}/`))
    const snapshots = await snapshotNames(fullName)

    const warnings = [
      `Destroying '${fullName}' is irreversible — all data in the dataset is permanently lost.`,
    ]
    if (children.length > 0)
      warnings.push(`${children.length} child dataset(s) will also be destroyed.`)
    if (snapshots.length > 0)
      warnings.push(`${snapshots.length} snapshot(s) of '${fullName}' will also be destroyed.`)
    if (!recursive && (children.length > 0 || snapshots.length > 0))
      warnings.push(`This dataset has children or snapshots; destroy will fail unless recursive is requested.`)

    // The confirmation protects "destroy this dataset" — `recursive` is NOT part
    // of the signature. The flag is chosen after the challenge is issued (like
    // the pool-destroy cleanup bug), so binding it here would make the confirmed
    // request mismatch the minted code and 409 again.
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zfs.destroy',
      params: { dataset: fullName },
      message: `Destroying dataset '${fullName}' permanently erases its data`,
      warnings,
    })) {
      return reply
    }

    const args = recursive ? ['destroy', '-r', fullName] : ['destroy', fullName]

    const job = jobQueue.submit(
      'zfs.destroy',
      { ...identity, params: { dataset: fullName, recursive } },
      async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs destroy exited with code ${result.exitCode}`)
        return { destroyed: fullName }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- Snapshot sub-resource handlers (Epic 5) ---------------------------
  // All reached via the dataset `*` wildcard; the tail is parsed by
  // parseSnapshotTail. Full ZFS snapshot name is `<dataset>@<snap>`.

  async function listSnapshots(poolName: string, datasetPath: string, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply
    if (!(await datasetExists(poolName, fullName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    return { data: await listSnapshotsDetail(fullName) }
  }

  async function snapshotDetail(poolName: string, datasetPath: string, snap: string, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply
    if (!(await datasetExists(poolName, fullName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }
    const snapshot = (await listSnapshotsDetail(fullName)).find(s => s.snapshotName === snap)
    if (!snapshot) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${fullName}@${snap}' not found` } }
    }
    return { data: snapshot }
  }

  async function createSnapshot(poolName: string, datasetPath: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const bodyParsed = CreateSnapshotRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create snapshot request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { name, recursive } = bodyParsed.data
    const snapName = `${fullName}@${name}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await datasetExists(poolName, fullName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Dataset '${fullName}' not found` } }
    }

    // 409 if the snapshot already exists — the system is the source of truth.
    const existing = await listSnapshotsDetail(fullName)
    if (existing.some(s => s.name === snapName)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Snapshot '${snapName}' already exists` } }
    }

    const args = recursive ? ['snapshot', '-r', snapName] : ['snapshot', snapName]

    const job = jobQueue.submit(
      'zfs.snapshot',
      { ...identity, params: { snapshot: snapName, recursive: recursive ?? false } },
      async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs snapshot exited with code ${result.exitCode}`)
        return { created: snapName }
      },
    )

    reply.code(202)
    return { job }
  }

  async function renameSnapshot(poolName: string, datasetPath: string, snap: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const snapParsed = SnapshotName.safeParse(snap)
    if (!snapParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${snapParsed.error.issues[0]?.message}` } }
    }

    const bodyParsed = RenameSnapshotRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid rename snapshot request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { newName } = bodyParsed.data
    const from = `${fullName}@${snap}`
    const to = `${fullName}@${newName}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const existing = await listSnapshotsDetail(fullName)
    if (!existing.some(s => s.name === from)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${from}' not found` } }
    }

    const job = jobQueue.submit(
      'zfs.rename',
      { ...identity, params: { from, to } },
      async () => {
        const result = await executor.exec(ZFS, ['rename', from, to])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs rename exited with code ${result.exitCode}`)
        return { renamed: from, to }
      },
    )

    reply.code(202)
    return { job }
  }

  async function destroySnapshot(poolName: string, datasetPath: string, snap: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const snapParsed = SnapshotName.safeParse(snap)
    if (!snapParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${snapParsed.error.issues[0]?.message}` } }
    }
    const snapName = `${fullName}@${snap}`

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const existing = await listSnapshotsDetail(fullName)
    if (!existing.some(s => s.name === snapName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${snapName}' not found` } }
    }

    // Plain 202 — destroying a snapshot removes a recovery point, not live data,
    // so no confirmation gate (DESIGN safety semantics).
    const job = jobQueue.submit(
      'zfs.destroy',
      { ...identity, params: { snapshot: snapName } },
      async () => {
        const result = await executor.exec(ZFS, ['destroy', snapName])
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs destroy exited with code ${result.exitCode}`)
        return { destroyed: snapName }
      },
    )

    reply.code(202)
    return { job }
  }

  async function rollbackSnapshot(poolName: string, datasetPath: string, snap: string, request: FastifyRequest, reply: FastifyReply) {
    const fullName = resolveDatasetName(poolName, datasetPath, reply)
    if (!fullName)
      return reply

    const snapParsed = SnapshotName.safeParse(snap)
    if (!snapParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid snapshot name: ${snapParsed.error.issues[0]?.message}` } }
    }
    const snapName = `${fullName}@${snap}`
    // `?force=true` maps to `zfs rollback -r` (also destroys intermediate
    // snapshots). NOT bound into the confirm signature — it is chosen after the
    // challenge is issued (the pool-destroy cleanup bug).
    const q = request.query as { force?: string }
    const force = q.force === 'true' || q.force === '1'

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const snapshots = await listSnapshotsDetail(fullName)
    const target = snapshots.find(s => s.name === snapName)
    if (!target) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Snapshot '${snapName}' not found` } }
    }

    // Snapshots newer than the target block a plain rollback; ZFS needs `-r`
    // (force) to destroy them. listSnapshotsDetail is newest-first, so "newer"
    // are the ones ahead of the target in the list.
    const targetIndex = snapshots.findIndex(s => s.name === snapName)
    const laterSnapshots = snapshots.slice(0, targetIndex).map(s => s.snapshotName)

    const warnings = [
      `Rolling back discards all changes to '${fullName}' since snapshot '${snap}'.`,
    ]
    if (laterSnapshots.length > 0) {
      warnings.push(`${laterSnapshots.length} more recent snapshot(s) exist (${laterSnapshots.join(', ')}); rollback requires force to destroy them, and doing so is irreversible.`)
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zfs.rollback',
      params: { snapshot: snapName },
      message: `Rolling back '${fullName}' to snapshot '${snap}' discards newer data`,
      warnings,
    })) {
      return reply
    }

    const args = force ? ['rollback', '-r', snapName] : ['rollback', snapName]

    const job = jobQueue.submit(
      'zfs.rollback',
      { ...identity, params: { snapshot: snapName, force } },
      async () => {
        const result = await executor.exec(ZFS, args)
        if (result.exitCode !== 0)
          throw new Error(result.stderr.trim() || `zfs rollback exited with code ${result.exitCode}`)
        return { rolledBack: snapName }
      },
    )

    reply.code(202)
    return { job }
  }
}
