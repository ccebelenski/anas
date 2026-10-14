import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { AccessService } from '../services/access.js'
import { AbsolutePath, CreateNfsExportRequest, UpdateNfsExportRequest } from '@anas/shared'
import { addExport, hasExport, parseExports, removeExport, replaceExport } from '../parsers/exports.js'
import { confirmGate } from '../safety/gate.js'
import { createAccessService } from '../services/access.js'
import { editConfig, readConfig } from '../services/config-writer.js'
import { loadPveFootprint } from '../services/pve-footprint.js'
import { requireIdentity } from './identity.js'
import { shareAccessHandlers } from './share-access.js'
import { pathExists } from './shares-smb.js'

/** `exportfs -ra` re-reads /etc/exports and syncs the kernel export table. */
const EXPORTFS = '/usr/sbin/exportfs'

/**
 * NFS export management (Epic 7). Exports are keyed by PATH — one line per path
 * in /etc/exports (see exports(5)). ANAS lists and manages EVERY export in the
 * file, whether it or an admin created it (Principle 11), and edits the file
 * surgically, preserving unrelated lines byte-for-byte (Principle 12).
 *
 * The reload (`exportfs -ra`) is a side effect of each mutation, run inside the
 * same job after the surgical write (DESIGN §5b), never a separate API call.
 */
export async function nfsExportRoutes(
  server: FastifyInstance,
  opts: { executor: CommandExecutor, jobQueue: JobQueue, confirmStore: ConfirmStore, exportsPath: string, accessService?: AccessService },
) {
  const { executor, jobQueue, confirmStore, exportsPath } = opts
  const shareAccess = shareAccessHandlers({ access: opts.accessService ?? createAccessService({ executor }), jobQueue, confirmStore: opts.confirmStore })

  /** Reload the kernel export table; throws on failure (fails the job). */
  async function reloadExports(): Promise<void> {
    const r = await executor.exec(EXPORTFS, ['-ra'])
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `exportfs -ra exited with code ${r.exitCode}`)
  }

  /**
   * Edit /etc/exports under the config-writer's lock and reload, ROLLING THE
   * FILE BACK when `exportfs -ra` rejects the result (review H3(b): a failed
   * reload used to leave the bad file standing). The pre-edit bytes are captured
   * inside the SAME `editConfig` transform (the truth the write started from),
   * and the restore is a second `editConfig` call under the same
   * change-detecting lock — so a hand-edit that lands between the write and the
   * reload is left alone, never clobbered. The reload error is what fails the
   * job, with the restore attempted as part of the rollback.
   */
  async function editExportsWithReload(transform: (current: string) => string, progress: (message: string) => void): Promise<void> {
    let before: string | null = null
    let written: string | null = null
    await editConfig(exportsPath, (current) => {
      before = current
      written = transform(current)
      return written
    })
    progress('Reloading NFS exports (exportfs -ra)')
    try {
      await reloadExports()
    }
    catch (err) {
      // Roll the previous bytes back only when the file is still what we wrote
      // (a hand-edit that landed between the write and the reload is left alone).
      if (before !== null && written !== null) {
        const previous = before
        const writtenBytes = written
        try {
          await editConfig(exportsPath, current => (current === writtenBytes ? previous : current))
          // A failed `exportfs -ra` may have applied part of the bad file to
          // the kernel's export table; reload the restored file so the
          // kernel matches it again. Best-effort: the reload error below is
          // what the job reports.
          await reloadExports()
        }
        catch (restoreErr) {
          progress(`Could not restore /etc/exports after the failed reload: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`)
        }
      }
      throw err
    }
  }

  // --- GET /shares/nfs — list ALL exports --------------------------------
  server.get('/shares/nfs', async () => {
    // Stat each export's path at read time to flag stale definitions whose
    // storage no longer exists (pathExists=false). Fail-open per export.
    const exports = parseExports(await readConfig(exportsPath)).map(exp => ({
      ...exp,
      pathExists: pathExists(exp.path),
    }))
    return { data: exports }
  })

  // --- GET /shares/nfs/:path — export detail (path is URL-encoded) --------
  server.get<{ Params: { path: string } }>('/shares/nfs/:path', async (request, reply) => {
    const pathParsed = AbsolutePath.safeParse(request.params.path)
    if (!pathParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid export path: ${pathParsed.error.issues[0]?.message}` } }
    }
    const path = pathParsed.data

    const exp = parseExports(await readConfig(exportsPath)).find(e => e.path === path)
    if (!exp) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Export '${path}' not found` } }
    }
    return { data: { ...exp, pathExists: pathExists(exp.path) } }
  })

  // --- POST /shares/nfs — create an export -------------------------------
  server.post('/shares/nfs', async (request, reply) => {
    const bodyParsed = CreateNfsExportRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create export request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const exp = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Share-path backstop (pvepool.1 review fixes): a path that is PVE's is
    // refused 400 — the SAME sharePathClaim answer the SMB create refuses
    // through: an export onto an OWNED dataset's mountpoint, or under a `dir`
    // storage's configured path on a ZFS filesystem whose dataset could not be
    // resolved (review fix 5; a non-ZFS dir path such as /var/lib/vz is
    // allowed — caveat emptor, EPICS §2, ruled 2026-09-22). A path on a
    // sibling dataset's mountpoint, or on no PVE claim at all, passes. The PUT
    // below cannot move the path (it is the URL identity, only the client list
    // is replaced), so create is the one door to guard.
    const pve = await loadPveFootprint(executor)
    const claim = pve.sharePathClaim(exp.path)
    if (claim) {
      reply.code(400)
      if (claim.kind === 'dataset')
        return { error: { code: 'VALIDATION_ERROR', message: `Export path '${exp.path}' is on '${claim.dataset}', which is PVE-owned — ${claim.ownership.reason}` } }
      return { error: { code: 'VALIDATION_ERROR', message: `Export path '${exp.path}' is inside '${claim.path}', a path PVE storage '${claim.storage}' claims — exports cannot serve PVE territory` } }
    }

    // 409 if the path is already exported — the file is the source of truth.
    if (hasExport(await readConfig(exportsPath), exp.path)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Export '${exp.path}' already exists` } }
    }

    const job = jobQueue.submit(
      'nfs.export.add',
      { ...identity, params: { path: exp.path } },
      async (updateProgress) => {
        updateProgress(`Adding NFS export ${exp.path}`)
        await editExportsWithReload((current) => {
          // Re-check under the file lock — another writer may have won the race.
          if (hasExport(current, exp.path))
            throw new Error(`Export '${exp.path}' already exists`)
          return addExport(current, exp)
        }, updateProgress)
        return { created: exp.path }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- GET/PUT /shares/nfs/:path/access — the export row's Permissions ----
  // (access.1) An export carries no principal list, so there is no automatic
  // grant; this is the shared editor opened on the export's path, after the
  // fact. The export must exist in /etc/exports (the file is the truth).
  async function exportPathOr404(raw: string, reply: FastifyReply): Promise<string | null> {
    const pathParsed = AbsolutePath.safeParse(raw)
    if (!pathParsed.success) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid export path: ${pathParsed.error.issues[0]?.message}` } })
      return null
    }
    if (!hasExport(await readConfig(exportsPath), pathParsed.data)) {
      reply.code(404)
      reply.send({ error: { code: 'NOT_FOUND', message: `Export '${pathParsed.data}' not found` } })
      return null
    }
    return pathParsed.data
  }

  server.get<{ Params: { path: string } }>('/shares/nfs/:path/access', async (request, reply) => {
    const path = await exportPathOr404(request.params.path, reply)
    if (!path)
      return reply
    return shareAccess.get(path, reply)
  })

  server.put<{ Params: { path: string } }>('/shares/nfs/:path/access', async (request, reply) => {
    const path = await exportPathOr404(request.params.path, reply)
    if (!path)
      return reply
    return shareAccess.put(path, { export: path }, request, reply)
  })

  // --- PUT /shares/nfs/:path — replace the client list -------------------
  server.put<{ Params: { path: string } }>('/shares/nfs/:path', async (request, reply) => {
    const pathParsed = AbsolutePath.safeParse(request.params.path)
    if (!pathParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid export path: ${pathParsed.error.issues[0]?.message}` } }
    }
    const path = pathParsed.data

    const bodyParsed = UpdateNfsExportRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid update export request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const exp = { path, clients: bodyParsed.data.clients }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!hasExport(await readConfig(exportsPath), path)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Export '${path}' not found` } }
    }

    const job = jobQueue.submit(
      'nfs.export.set',
      { ...identity, params: { path } },
      async (updateProgress) => {
        updateProgress(`Updating NFS export ${path}`)
        await editExportsWithReload((current) => {
          if (!hasExport(current, path))
            throw new Error(`Export '${path}' not found`)
          return replaceExport(current, path, exp)
        }, updateProgress)
        return { updated: path }
      },
    )

    reply.code(202)
    return { job }
  })

  // --- DELETE /shares/nfs/:path — remove an export (confirmation-gated) --
  server.delete<{ Params: { path: string } }>('/shares/nfs/:path', async (request, reply) => {
    const pathParsed = AbsolutePath.safeParse(request.params.path)
    if (!pathParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid export path: ${pathParsed.error.issues[0]?.message}` } }
    }
    const path = pathParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!hasExport(await readConfig(exportsPath), path)) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Export '${path}' not found` } }
    }

    // Removing an export is a live change: connected clients lose access on the
    // next `exportfs -ra`. Gate it behind a confirmation code (Principle 14).
    if (!confirmGate(confirmStore, request, reply, {
      operation: 'nfs.export.remove',
      params: { path },
      message: `Removing NFS export '${path}' revokes access for its clients`,
      warnings: [
        `Export '${path}' will be removed from /etc/exports and unexported immediately.`,
        `Any clients currently mounting '${path}' will lose access on the next access.`,
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'nfs.export.remove',
      { ...identity, params: { path } },
      async (updateProgress) => {
        updateProgress(`Removing NFS export ${path}`)
        await editExportsWithReload(current => removeExport(current, path), updateProgress)
        return { removed: path }
      },
    )

    reply.code(202)
    return { job }
  })
}
