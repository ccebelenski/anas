import type { PoolDetail, PoolSummary } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import { AddVdevRequest, AttachDiskRequest, CreatePoolRequest, ExportPoolRequest, ImportPoolRequest, PoolName, ScrubRequest, TrimPoolRequest, UpdatePoolPropertiesRequest } from '@anas/shared'
import { readPveStorages } from '../parsers/pve-storage.js'
import { parseZpoolGet } from '../parsers/zpool-get.js'
import { parseZpoolList } from '../parsers/zpool-list.js'
import { parseZpoolStatus, parseZpoolStatusPool } from '../parsers/zpool-status.js'
import { confirmGate } from '../safety/gate.js'
import { isRootPool } from '../safety/root-pool.js'
import { requireIdentity } from './identity.js'

/** Map a disk by-id identifier to its stable /dev/disk/by-id path. */
function byIdPath(id: string): string {
  return `/dev/disk/by-id/${id}`
}

/**
 * Build the `zpool create` argument array from a validated CreatePoolRequest.
 *
 * A data vdev contributes its redundancy keyword followed by its disk paths
 * (mirror → ['mirror', d1, d2], raidz2 → ['raidz2', ...]); 'stripe' is our
 * synthetic type meaning individual disks — no keyword, just the paths.
 * Log vdevs follow a single 'log' keyword (each mirrored/striped in turn);
 * cache and spare disks follow their 'cache'/'spare' keywords as plain disks.
 */
function buildCreateArgs(req: CreatePoolRequest): string[] {
  const args: string[] = ['create']

  if (req.force)
    args.push('-f')

  if (req.properties) {
    const p = req.properties
    if (p.ashift !== undefined)
      args.push('-o', `ashift=${p.ashift}`)
    if (p.autoexpand !== undefined)
      args.push('-o', `autoexpand=${p.autoexpand ? 'on' : 'off'}`)
    if (p.autoreplace !== undefined)
      args.push('-o', `autoreplace=${p.autoreplace ? 'on' : 'off'}`)
    if (p.autotrim !== undefined)
      args.push('-o', `autotrim=${p.autotrim ? 'on' : 'off'}`)
  }

  if (req.mountpoint)
    args.push('-m', req.mountpoint)

  args.push(req.name)

  // Data vdevs
  for (const vdev of req.dataVdevs) {
    if (vdev.type !== 'stripe')
      args.push(vdev.type)
    for (const id of vdev.disks)
      args.push(byIdPath(id))
  }

  // Log (ZIL) vdevs — 'log' keyword once, then each vdev's keyword + disks
  if (req.logVdevs && req.logVdevs.length > 0) {
    args.push('log')
    for (const vdev of req.logVdevs) {
      if (vdev.type !== 'stripe')
        args.push(vdev.type)
      for (const id of vdev.disks)
        args.push(byIdPath(id))
    }
  }

  // Cache (L2ARC) — always individual disks
  if (req.cacheDisks && req.cacheDisks.length > 0) {
    args.push('cache')
    for (const id of req.cacheDisks)
      args.push(byIdPath(id))
  }

  // Hot spares — always individual disks
  if (req.spareDisks && req.spareDisks.length > 0) {
    args.push('spare')
    for (const id of req.spareDisks)
      args.push(byIdPath(id))
  }

  return args
}

/** An importable pool discovered by a `zpool import` scan. */
interface ImportablePool {
  name: string
  guid: string
  state: string
}

/**
 * Parse the human-readable output of `zpool import` (no args).
 *
 * `zpool import` scan has no structured/JSON output across supported OpenZFS
 * versions, so a text parse is the only option here (documented deviation from
 * "prefer structured output" — there is none). Each importable pool is a block:
 *
 *     pool: tank
 *       id: 12345678901234567890
 *    state: ONLINE
 *   action: The pool can be imported using its name or numeric identifier.
 *   config:
 *     ...topology...
 *
 * We extract the pool: / id: / state: header fields of each block.
 */
function parseImportScan(stdout: string): ImportablePool[] {
  const pools: ImportablePool[] = []
  let current: Partial<ImportablePool> | null = null

  const push = () => {
    if (current && current.name) {
      pools.push({
        name: current.name,
        guid: current.guid ?? '',
        state: current.state ?? '',
      })
    }
  }

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    const colon = line.indexOf(':')
    if (colon === -1)
      continue // topology/config lines have no "key: value" shape
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'pool') {
      // New block starts — flush the previous one.
      push()
      current = { name: value }
    }
    else if (current && key === 'id') {
      current.guid = value
    }
    else if (current && key === 'state') {
      current.state = value
    }
  }
  push()

  return pools
}

export async function poolRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, jobQueue: JobQueue, confirmStore: ConfirmStore },
) {
  const { executor, jobQueue, confirmStore } = opts

  /** Stable by-id identifiers of every leaf disk in a pool (for disk cleanup). */
  async function poolMemberIds(poolName: string): Promise<string[]> {
    const statusResult = await executor.exec('/usr/sbin/zpool', ['status', '-jv'])
    if (statusResult.exitCode !== 0)
      return []
    const pool = parseZpoolStatusPool(statusResult.stdout, poolName)
    if (!pool)
      return []
    const ids: string[] = []
    for (const group of pool.vdevGroups) {
      for (const vdev of group.vdevs) {
        for (const disk of vdev.disks)
          ids.push(disk.id)
      }
    }
    return ids
  }

  server.get('/pools', async (_request, _reply) => {
    const [listResult, statusResult, pveStorages] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
      // Read-only PVE storage detection (Epic 3.25). Fail-open: off-PVE hosts
      // and parse errors yield an empty map, so this never breaks GET /pools.
      readPveStorages(),
    ])

    // If no pools exist, zpool list exits non-zero with no stdout
    if (listResult.exitCode !== 0 && !listResult.stdout.trim()) {
      return { data: [] }
    }

    const listData = parseZpoolList(listResult.stdout)
    const statusData = statusResult.exitCode === 0
      ? parseZpoolStatus(statusResult.stdout)
      : []

    // Build a lookup from status data
    const statusByName = new Map(statusData.map(s => [s.name, s]))

    // Merge list (sizes) with status (state, scan, health) into PoolSummary
    const pools: PoolSummary[] = listData.map((pool) => {
      const status = statusByName.get(pool.name)
      return {
        ...pool,
        state: status?.state ?? pool.state,
        scanRunning: status?.scan?.state === 'SCANNING',
        ...(status?.health && { health: status.health }),
        pveStorages: pveStorages.get(pool.name) ?? [],
      }
    })

    return { data: pools }
  })

  server.get<{ Params: { name: string } }>('/pools/:name', async (request, reply) => {
    const poolName = request.params.name

    const [statusResult, listResult, getResult, pveStorages] = await Promise.all([
      executor.exec('/usr/sbin/zpool', ['status', '-jv']),
      executor.exec('/usr/sbin/zpool', ['list', '-j']),
      executor.exec('/usr/sbin/zpool', ['get', 'all', '-j']),
      // Read-only PVE storage detection (Epic 3.25) — fail-open (see GET /pools).
      readPveStorages(),
    ])

    // Parse status for this specific pool
    const status = statusResult.exitCode === 0
      ? parseZpoolStatusPool(statusResult.stdout, poolName)
      : null

    if (!status) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // Parse list data and find this pool
    const listData = listResult.exitCode === 0
      ? parseZpoolList(listResult.stdout)
      : []
    const listPool = listData.find(p => p.name === poolName)

    // Parse properties
    const properties = getResult.exitCode === 0
      ? parseZpoolGet(getResult.stdout, poolName)
      : null

    if (!listPool || !properties) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const detail: PoolDetail = {
      name: poolName,
      state: status.state,
      guid: status.guid,
      size: listPool.size,
      allocated: listPool.allocated,
      free: listPool.free,
      fragmentation: listPool.fragmentation,
      capacity: listPool.capacity,
      dedupRatio: listPool.dedupRatio,
      ...(status.health && { health: status.health }),
      errorCount: status.errorCount,
      ...(status.errorDetail && { errorDetail: status.errorDetail }),
      vdevGroups: status.vdevGroups,
      scan: status.scan,
      properties,
      pveStorages: pveStorages.get(poolName) ?? [],
    }

    return { data: detail }
  })

  server.post<{ Params: { name: string } }>('/pools/:name/scrub', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = ScrubRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid scrub request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { action } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const args = action === 'stop'
      ? ['scrub', '-s', poolName]
      : ['scrub', poolName]

    const job = jobQueue.submit(
      'zpool.scrub',
      { ...identity, params: { pool: poolName, action } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool scrub exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Trim a pool's SSDs (Epic 4.12). Trim is a safe online operation like scrub —
  // no confirmation gate. `start` issues a trim; `cancel` (-c) stops one.
  server.post<{ Params: { name: string } }>('/pools/:name/trim', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = TrimPoolRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid trim request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { action } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const args = action === 'cancel'
      ? ['trim', '-c', poolName]
      : ['trim', poolName]

    const job = jobQueue.submit(
      'zpool.trim',
      { ...identity, params: { pool: poolName, action } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool trim exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Upgrade a pool's feature flags (Epic 4.12) — one-way. Enabling feature flags
  // is IRREVERSIBLE: the pool may no longer import on an older ZFS or another OS,
  // so this is confirmation-gated like destroy.
  server.post<{ Params: { name: string } }>('/pools/:name/upgrade', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zpool.upgrade',
      params: { pool: poolName },
      message: `Upgrading pool '${poolName}' enables new ZFS feature flags`,
      warnings: [
        'Enabling feature flags is one-way — the pool may no longer be importable on older ZFS versions or other systems.',
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'zpool.upgrade',
      { ...identity, params: { pool: poolName } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', ['upgrade', poolName])
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool upgrade exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Whitelist of user-settable pool properties and their allowed values
  // (Principle 5 — structured operations, not command passthrough). Booleans
  // are expressed to zpool as 'on'/'off'. ashift is creation-only and is
  // deliberately absent so a request to change it is rejected as invalid.
  const SETTABLE_POOL_PROPS: Record<string, readonly string[]> = {
    autoexpand: ['on', 'off'],
    autoreplace: ['on', 'off'],
    autotrim: ['on', 'off'],
    failmode: ['wait', 'continue', 'panic'],
  }

  server.put<{ Params: { name: string } }>('/pools/:name', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = UpdatePoolPropertiesRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid property update: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { properties } = bodyParsed.data

    // Reject any property that is not settable (e.g. ashift) or any
    // out-of-range value before we touch the system.
    for (const [prop, value] of Object.entries(properties)) {
      const allowed = SETTABLE_POOL_PROPS[prop]
      if (!allowed) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Property '${prop}' is not settable` } }
      }
      if (!allowed.includes(value)) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid value '${value}' for property '${prop}'` } }
      }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const changes = Object.entries(properties)

    const job = jobQueue.submit(
      'zpool.set',
      { ...identity, params: { pool: poolName, properties } },
      async (updateProgress) => {
        for (const [prop, value] of changes) {
          updateProgress(`Setting ${prop}=${value} on ${poolName}`)
          const result = await executor.exec('/usr/sbin/zpool', ['set', `${prop}=${value}`, poolName])
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || `zpool set ${prop}=${value} exited with code ${result.exitCode}`)
          }
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  server.post('/pools', async (request, reply) => {
    const bodyParsed = CreatePoolRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // 409 if a pool of that name already exists — the system is the source of truth.
    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const existing = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (existing.some(p => p.name === req.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Pool '${req.name}' already exists` } }
    }

    const args = buildCreateArgs(req)

    const job = jobQueue.submit(
      'zpool.create',
      { ...identity, params: { pool: req.name, vdevs: req.dataVdevs.length } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool create exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // --- Story 3.7: scan for importable pools (read, synchronous) -----------
  // GET /pools/import lists pools available to import (`zpool import` no args).
  // A read, not a mutation, so it returns 200 { data } synchronously — no job.
  server.get('/pools/import', async (_request, _reply) => {
    const scanResult = await executor.exec('/usr/sbin/zpool', ['import'])
    // `zpool import` with no importable pools exits non-zero with no stdout.
    if (scanResult.exitCode !== 0 && !scanResult.stdout.trim()) {
      return { data: [] }
    }
    return { data: parseImportScan(scanResult.stdout) }
  })

  // --- Story 3.7: import a pool by name or guid ---------------------------
  server.post('/pools/import', async (request, reply) => {
    const bodyParsed = ImportPoolRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid import request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const target = req.name ?? req.guid!
    const args = ['import']
    if (req.force)
      args.push('-f')
    if (req.altroot)
      args.push('-R', req.altroot)
    args.push(target)

    const job = jobQueue.submit(
      'zpool.import',
      { ...identity, params: { target, force: req.force ?? false } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool import exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  async function poolExists(poolName: string): Promise<boolean> {
    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    return pools.some(p => p.name === poolName)
  }

  // Add a vdev to an existing pool (story 3.11). Expands capacity by appending a
  // new top-level vdev. `stripe` is our synthetic type — bare disks with no
  // redundancy keyword; every other type prepends its ZFS keyword.
  server.post<{ Params: { name: string } }>('/pools/:name/vdevs', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = AddVdevRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid add-vdev request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { vdev } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const diskPaths = vdev.disks.map(byIdPath)
    // stripe → bare disks (no redundancy vdev keyword); mirror/raidz* → keyword first.
    const args = vdev.type === 'stripe'
      ? ['add', poolName, ...diskPaths]
      : ['add', poolName, vdev.type, ...diskPaths]

    const job = jobQueue.submit(
      'zpool.add',
      { ...identity, params: { pool: poolName, type: vdev.type, disks: vdev.disks } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool add exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Attach or replace a disk (story 3.12). AttachDiskRequest.replace selects the
  // operation: false → `zpool attach` (add a mirror leg to an existing device),
  // true → `zpool replace` (swap a failed/old device for a new one).
  server.post<{ Params: { name: string } }>('/pools/:name/attach', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = AttachDiskRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid attach request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const { existingDiskId, newDiskId, replace } = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await poolExists(poolName))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const existingPath = byIdPath(existingDiskId)
    const newPath = byIdPath(newDiskId)
    const args = replace
      ? ['replace', poolName, existingPath, newPath]
      : ['attach', poolName, existingPath, newPath]

    const job = jobQueue.submit(
      replace ? 'zpool.replace' : 'zpool.attach',
      { ...identity, params: { pool: poolName, existingDisk: existingDiskId, newDisk: newDiskId, replace } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          const verb = replace ? 'replace' : 'attach'
          throw new Error(result.stderr.trim() || `zpool ${verb} exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  server.post<{ Params: { name: string } }>('/pools/:name/export', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data

    const bodyParsed = ExportPoolRequest.safeParse(request.body ?? undefined)
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid export request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const force = bodyParsed.data?.force ?? false

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    // No cheap signal for active shares yet (Epics 6–7) — warn generically that
    // the pool becomes unavailable. Share-aware warnings land with share support.
    const warnings = [
      `Exporting '${poolName}' makes the pool and all its datasets unavailable until it is re-imported.`,
    ]

    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zpool.export',
      params: { pool: poolName },
      message: `Exporting pool '${poolName}' has consequences`,
      warnings,
    })) {
      return reply
    }

    const args = force ? ['export', '-f', poolName] : ['export', poolName]

    const job = jobQueue.submit(
      'zpool.export',
      { ...identity, params: { pool: poolName, force } },
      async () => {
        const result = await executor.exec('/usr/sbin/zpool', args)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool export exited with code ${result.exitCode}`)
        }
        return null
      },
    )

    reply.code(202)
    return { job }
  })

  // Destroy a pool (story 3.14) — the dangerous one. Blocked outright for the
  // root/boot pool (Level 1, no override); otherwise confirmation-gated.
  server.delete<{ Params: { name: string }, Querystring: { cleanup?: string } }>('/pools/:name', async (request, reply) => {
    const nameParsed = PoolName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid pool name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const poolName = nameParsed.data
    // Opt-in disk hygiene (PVE's "Clean Up Disks"): after destroy, wipe each
    // freed member so it comes back pristine and immediately reusable.
    const cleanup = request.query.cleanup === 'true' || request.query.cleanup === '1'

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Level 1 block: the root/boot pool can never be destroyed, no override.
    // Checked before existence — protection is unconditional, and a root pool
    // is always present anyway.
    if (isRootPool(poolName)) {
      reply.code(409)
      return { error: { code: 'PROTECTED_RESOURCE', message: `Cannot destroy the root pool '${poolName}'` } }
    }

    const listResult = await executor.exec('/usr/sbin/zpool', ['list', '-j'])
    const pools = listResult.exitCode === 0 ? parseZpoolList(listResult.stdout) : []
    if (!pools.some(p => p.name === poolName)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Pool '${poolName}' not found` } }
    }

    const warnings = [
      `Destroying '${poolName}' is irreversible — all data in the pool is permanently lost.`,
      `Every dataset, snapshot, and volume in '${poolName}' will be destroyed.`,
    ]
    if (cleanup)
      warnings.push(`The pool's disks will be wiped clean (existing ZFS labels removed).`)

    // The confirmation protects "destroy this pool" — `cleanup` is NOT part of
    // the signature. The checkbox is chosen after the challenge is issued, so
    // binding cleanup here would make the confirmed request (cleanup=true)
    // mismatch the code minted for the challenge (cleanup=false) and 409 again.
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'zpool.destroy',
      params: { pool: poolName },
      message: `Destroying pool '${poolName}' permanently erases all its data`,
      warnings,
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'zpool.destroy',
      { ...identity, params: { pool: poolName, cleanup } },
      async (updateProgress) => {
        // Capture the member disks by stable by-id BEFORE destroy — the pool
        // must still exist to enumerate them.
        const memberIds = cleanup ? await poolMemberIds(poolName) : []

        const result = await executor.exec('/usr/sbin/zpool', ['destroy', poolName])
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `zpool destroy exited with code ${result.exitCode}`)
        }

        if (cleanup && memberIds.length > 0) {
          // Best-effort: the pool is already destroyed, so a failed wipe must
          // not fail the job. Report any disks we couldn't clean.
          const failed: string[] = []
          for (const id of memberIds) {
            updateProgress(`Wiping ${id}`)
            const wipe = await executor.exec('/usr/sbin/wipefs', ['-a', '--force', `/dev/disk/by-id/${id}`])
            if (wipe.exitCode !== 0)
              failed.push(id)
          }
          if (failed.length > 0)
            return { destroyed: poolName, wipedFailed: failed }
          return { destroyed: poolName, wiped: memberIds }
        }
        return { destroyed: poolName }
      },
    )

    reply.code(202)
    return { job }
  })
}
