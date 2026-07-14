import type { FastifyInstance } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import { AbsolutePath, CreateNfsExportRequest, UpdateNfsExportRequest } from '@anas/shared'
import { addExport, hasExport, parseExports, removeExport, replaceExport } from '../parsers/exports.js'
import { confirmGate } from '../safety/gate.js'
import { editConfig, readConfig } from '../services/config-writer.js'
import { requireIdentity } from './identity.js'

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
  opts: { executor: CommandExecutor, jobQueue: JobQueue, confirmStore: ConfirmStore, exportsPath: string },
) {
  const { executor, jobQueue, confirmStore, exportsPath } = opts

  /** Reload the kernel export table; throws on failure (fails the job). */
  async function reloadExports(): Promise<void> {
    const r = await executor.exec(EXPORTFS, ['-ra'])
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `exportfs -ra exited with code ${r.exitCode}`)
  }

  // --- GET /shares/nfs — list ALL exports --------------------------------
  server.get('/shares/nfs', async () => {
    return { data: parseExports(await readConfig(exportsPath)) }
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
    return { data: exp }
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
        await editConfig(exportsPath, (current) => {
          // Re-check under the file lock — another writer may have won the race.
          if (hasExport(current, exp.path))
            throw new Error(`Export '${exp.path}' already exists`)
          return addExport(current, exp)
        })
        updateProgress('Reloading NFS exports (exportfs -ra)')
        await reloadExports()
        return { created: exp.path }
      },
    )

    reply.code(202)
    return { job }
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
        await editConfig(exportsPath, (current) => {
          if (!hasExport(current, path))
            throw new Error(`Export '${path}' not found`)
          return replaceExport(current, path, exp)
        })
        updateProgress('Reloading NFS exports (exportfs -ra)')
        await reloadExports()
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
        await editConfig(exportsPath, current => removeExport(current, path))
        updateProgress('Reloading NFS exports (exportfs -ra)')
        await reloadExports()
        return { removed: path }
      },
    )

    reply.code(202)
    return { job }
  })
}
