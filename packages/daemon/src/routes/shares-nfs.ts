import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { AccessService } from '../services/access.js'
import { createHash } from 'node:crypto'
import { AbsolutePath, CreateNfsExportRequest, EXPORT_PATH_MSG, isExportPath, UpdateNfsExportRequest } from '@anas/shared'
import { addExport, hasExport, parseExports, parseExportsDoc, removeExport, replaceExport } from '../parsers/exports.js'
import { guardCheck, guardConfirm, guarded, GuardRefusalError, nfsShareClaim, sendRefusal } from '../safety/guard.js'
import { createAccessService } from '../services/access.js'
import { editConfig, readConfig } from '../services/config-writer.js'
import { normalizeMountpointPath } from '../services/mounts.js'
import { loadPveFootprint, ownershipRefusal, pveManagedRefusal } from '../services/pve-footprint.js'
import { probeSharePath, probeSharePaths, sharePathFields } from '../services/share-path.js'
import { requireIdentity } from './identity.js'
import { shareAccessHandlers } from './share-access.js'

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

  /** One `exportfs -ra`: whether it succeeded and the error lines it printed. */
  async function runExportfs(): Promise<{ ok: boolean, errors: string[], message: string }> {
    const r = await executor.exec(EXPORTFS, ['-ra'])
    const errors = r.stderr.split('\n').map(l => l.trim()).filter(l => l !== '')
    return { ok: r.exitCode === 0, errors, message: r.stderr.trim() || `exportfs -ra exited with code ${r.exitCode}` }
  }

  // --- The export guard specs (story cr.43, WAVE3-DESIGN §2.5/§3.3, ruling (j))
  //
  // One spec per verb, both doors: the route answers a refusal in the request,
  // the job re-reads /etc/exports and refuses again before it writes — item 1
  // (vanished export) included. The reads never return null: absence lives in
  // the per-verb existence gate carrying the routes' existing sentence. A
  // vanished update fails the JOB with NOT_FOUND through the revision —
  // reverify checks the revision before the gates, and a throwing revision
  // getter is the settled mechanism (the route door never reaches it:
  // guardCheck runs the gates first).
  //
  // Item 3 needs nothing here beyond submitting with `{ locks: pre.locks }`:
  // the whole job body — the cr.13 `exportfs -ra` baseline included, and its
  // semantics are untouched — now runs while the export's lock is held.

  interface NfsExportObject { path: string, text: string }

  const exportNotFound = (path: string): Refusal =>
    ({ status: 404, code: 'NOT_FOUND', message: `Export '${path}' not found` })

  /** sha256 of the export's own line in the file, or null when the line is gone. */
  function exportLineRevision(text: string, path: string): string | null {
    for (const line of parseExportsDoc(text)) {
      if (line.kind === 'export' && line.path === path)
        return createHash('sha256').update(line.raw).digest('hex')
    }
    return null
  }

  function nfsExportView(path: string): ObjectView<NfsExportObject> {
    return {
      what: `NFS export ${path}`,
      read: async reads => ({ path, text: await reads.once('exports', () => readConfig(exportsPath)) }),
      id: async () => ({ path }),
      unbound: part => part === 'revision'
        ? `Could not read the /etc/exports line of '${path}' — refusing an edit that cannot be bound to it`
        : `Could not read NFS export ${path} — refusing`,
    }
  }

  function nfsUpdateGuardSpec(path: string): GuardSpec<NfsExportObject> {
    return {
      operation: 'nfs.export.set',
      object: {
        ...nfsExportView(path),
        revision: async (o) => {
          const revision = exportLineRevision(o.text, path)
          // Vanished between confirmation and job: the job fails with the same
          // NOT_FOUND the route answers, not STATE_CHANGED for a line the
          // request was never computed from.
          if (revision === null)
            throw new GuardRefusalError(exportNotFound(path))
          return revision
        },
      },
      gates: [async o => (hasExport(o.text, path) ? null : exportNotFound(path))],
      // The §4.2 key is the NORMALISED path, so `/tank//x/` cannot slip a
      // second writer past the lock on a spelling of the same export.
      locks: async () => [nfsShareClaim(normalizeMountpointPath(path))],
    }
  }

  function nfsRemoveGuardSpec(path: string): GuardSpec<NfsExportObject> {
    return {
      operation: 'nfs.export.remove',
      // A remove deletes the whole line — nothing survives to bind a revision
      // to (the mounts precedent); the gate re-answers the 404.
      object: nfsExportView(path),
      gates: [async o => (hasExport(o.text, path) ? null : exportNotFound(path))],
      locks: async () => [nfsShareClaim(normalizeMountpointPath(path))],
    }
  }

  const exportExists = (path: string): Refusal =>
    ({ status: 409, code: 'CONFLICT', message: `Export '${path}' already exists` })

  function nfsCreateGuardSpec(path: string): GuardSpec<NfsExportObject> {
    return {
      operation: 'nfs.export.add',
      // The object is the export-path SLOT (the mounts create precedent): a
      // line there answers CONFLICT at the route, and item 2 runs the same
      // gate again inside the job under the export's lock — a line added
      // while the create waits refuses there, before its reload touches
      // `exportfs` at all (no baseline runs for a create that never writes).
      object: nfsExportView(path),
      gates: [async o => (hasExport(o.text, path) ? exportExists(path) : null)],
      locks: async () => [nfsShareClaim(normalizeMountpointPath(path))],
    }
  }

  /**
   * Edit /etc/exports under the config-writer's lock and reload, ROLLING THE
   * FILE BACK when `exportfs -ra` rejects the change (review H3(b): a failed
   * reload used to leave the bad file standing).
   *
   * "Rejects the change" is judged against a baseline, not on the exit code
   * alone (node pass R3-D1): `exportfs -ra` exits non-zero for ANY bad line —
   * a stale export whose dataset is gone fails every reload — so the file is
   * reloaded once before the edit and only an error line the baseline did not
   * print counts against this change. Errors that predate it are reported and
   * left alone. When the baseline was clean, any failure counts.
   *
   * The pre-edit bytes are captured inside the SAME `editConfig` transform and
   * the restore is a second `editConfig` under the same change-detecting lock,
   * so a hand-edit that lands between the write and the reload is left alone.
   */
  async function editExportsWithReload(transform: (current: string) => string, progress: (message: string) => void): Promise<void> {
    progress('Checking the current NFS exports (exportfs -ra)')
    const baseline = await runExportfs()
    let before: string | null = null
    let written: string | null = null
    await editConfig(exportsPath, (current) => {
      before = current
      written = transform(current)
      return written
    })
    progress('Reloading NFS exports (exportfs -ra)')
    const after = await runExportfs()
    if (after.ok)
      return
    const known = new Set(baseline.ok ? [] : baseline.errors)
    const fresh = after.errors.filter(line => !known.has(line))
    if (!baseline.ok && fresh.length === 0) {
      progress(`exportfs -ra reports errors that predate this change and were left as they are: ${after.message}`)
      return
    }
    // Roll the previous bytes back only when the file is still what we wrote
    // (a hand-edit that landed between the write and the reload is left alone).
    if (before !== null && written !== null) {
      const previous = before
      const writtenBytes = written
      const why = (e: unknown): string => (e instanceof Error ? e.message : String(e))
      let restored = false
      try {
        await editConfig(exportsPath, current => (current === writtenBytes ? previous : current))
        restored = true
      }
      catch (restoreErr) {
        progress(`Could not restore /etc/exports after the failed reload — the rejected change is still in the file: ${why(restoreErr)}`)
      }
      if (restored) {
        // A failed `exportfs -ra` may have applied part of the bad file to the
        // kernel's export table; reload the restored file so the kernel
        // matches it again. Best-effort: the error below is what the job reports.
        const again = await runExportfs().catch(() => null)
        if (again && !again.ok && (baseline.ok || again.errors.some(line => !known.has(line))))
          progress(`/etc/exports was restored, but reloading it failed — the kernel's export table may not match the file: ${again.message}`)
      }
    }
    throw new Error(fresh.length > 0 ? fresh.join('\n') : after.message)
  }

  // --- GET /shares/nfs — list ALL exports --------------------------------
  server.get('/shares/nfs', async () => {
    // Check each export's path at read time: missing = a stale line, not
    // answering = a hung mount under it (cr.35, through the executor).
    const parsed = parseExports(await readConfig(exportsPath))
    const probes = await probeSharePaths(executor, parsed.map(e => e.path))
    const exports = parsed.map(exp => ({
      ...exp,
      ...sharePathFields(probes.get(exp.path)!),
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
    return { data: { ...exp, ...sharePathFields(await probeSharePath(executor, exp.path)) } }
  })

  // --- POST /shares/nfs — create an export -------------------------------
  server.post('/shares/nfs', async (request, reply) => {
    const bodyParsed = CreateNfsExportRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid create export request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    // cr.36r: the export path is canonicalised ONCE at the door with the lock
    // key's own normaliser (mirroring 0ef1284e): `/srv//x` and `/srv/x` are one
    // directory, so the PVE-territory claim, the exists-gate, the last-moment
    // backstop, the lock key and the written exports line all carry one
    // spelling — `/srv//x` can no longer slip past the `l.path === path`
    // compare and write a second line for a directory already exported.
    const exp = { ...bodyParsed.data, path: normalizeMountpointPath(bodyParsed.data.path) }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Share-path backstop (pvepool.1 review fixes): a path that is PVE's is
    // refused 409 PVE_MANAGED (cr.47b) — the SAME sharePathClaim answer the
    // SMB create refuses through: an export onto an OWNED dataset's
    // mountpoint, or under a `dir`
    // storage's configured path on a ZFS filesystem whose dataset could not be
    // resolved (review fix 5; a non-ZFS dir path such as /var/lib/vz is
    // allowed — caveat emptor, EPICS §2, ruled 2026-09-22). A path on a
    // sibling dataset's mountpoint, or on no PVE claim at all, passes. The PUT
    // below cannot move the path (it is the URL identity, only the client list
    // is replaced), so create is the one door to guard.
    const pve = await loadPveFootprint(executor)
    const claim = pve.sharePathClaim(exp.path)
    if (claim) {
      // The config-unreadable verdict is a different fact and keeps its 400.
      const refusal = claim.kind === 'dataset'
        ? ownershipRefusal(claim.ownership, `Export path '${exp.path}' is on '${claim.dataset}', which is PVE-owned — ${claim.ownership.reason}`)
        : pveManagedRefusal(`Export path '${exp.path}' is inside '${claim.path}', a path PVE storage '${claim.storage}' claims — exports cannot serve PVE territory`)
      return sendRefusal(reply, refusal)
    }

    // Story cr.43 item 2: existence answers 409 CONFLICT at the route, and
    // the same gate runs again in the job under the export's lock — a line
    // that appears while the create waits refuses there, so no duplicate
    // export line is ever written and a refused create never runs exportfs.
    const spec = nfsCreateGuardSpec(exp.path)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'nfs.export.add',
      { ...identity, params: { path: exp.path } },
      // Ruling (j): the slot gate runs again here and the whole job holds the
      // export's lock — a line that appeared while the create waited arrives
      // as CONFLICT, before `exportfs -ra` runs even as the cr.13 baseline.
      guarded(spec, pre, async (_export, { updateProgress }) => {
        updateProgress(`Adding NFS export ${exp.path}`)
        await editExportsWithReload((current) => {
          // The last-moment backstop (the mounts pattern): between the
          // reverify read and this transform's own read a line for the path
          // can still appear — the create refuses with the CONFLICT sentence
          // and the file keeps its bytes.
          if (hasExport(current, exp.path))
            throw new GuardRefusalError(exportExists(exp.path))
          return addExport(current, exp)
        }, updateProgress)
        return { created: exp.path }
      }),
      { locks: pre.locks },
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
    // The same export-path rule as the create door (cr.13 review): this path
    // is re-serialized into /etc/exports by replaceExport.
    const pathParsed = AbsolutePath.refine(isExportPath, EXPORT_PATH_MSG).safeParse(request.params.path)
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

    // Story cr.43: the line's existence answers 404 at the route, and the
    // route's edit is bound to the line's revision — the job writes a merge
    // of THIS line or refuses (NOT_FOUND when it vanished, STATE_CHANGED when
    // a hand edit moved it under the request).
    const spec = nfsUpdateGuardSpec(path)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    const job = jobQueue.submit(
      'nfs.export.set',
      { ...identity, params: { path } },
      // Ruling (j): id, the line's revision and the existence gate run again
      // here, and the whole job — the baseline reload included — holds the
      // export's lock.
      guarded(spec, pre, async (_exp, { updateProgress }) => {
        updateProgress(`Updating NFS export ${path}`)
        await editExportsWithReload((current) => {
          // The last-moment backstop: gone since the reverify read — refuse
          // with the 404 sentence and the file keeps its bytes.
          if (!hasExport(current, path))
            throw new GuardRefusalError(exportNotFound(path))
          return replaceExport(current, path, exp)
        }, updateProgress)
        return { updated: path }
      }),
      { locks: pre.locks },
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

    // Story cr.43: the gate answers the 404 at the route; the job re-runs it
    // under the export's lock, so removing an export that vanished while the
    // job waited fails NOT_FOUND instead of reporting success.
    const spec = nfsRemoveGuardSpec(path)
    const pre = await guardCheck(spec)
    if ('refusal' in pre)
      return sendRefusal(reply, pre.refusal)

    // Removing an export is a live change: connected clients lose access on the
    // next `exportfs -ra`. Gate it behind a confirmation code (Principle 14).
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { path },
      address: ['path'],
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
      guarded(spec, pre, async (_exp, { updateProgress }) => {
        updateProgress(`Removing NFS export ${path}`)
        await editExportsWithReload((current) => {
          // Last-moment backstop: gone since the reverify read — refuse with
          // the 404 sentence, the file keeps its bytes.
          if (!hasExport(current, path))
            throw new GuardRefusalError(exportNotFound(path))
          return removeExport(current, path)
        }, updateProgress)
        return { removed: path }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })
}
