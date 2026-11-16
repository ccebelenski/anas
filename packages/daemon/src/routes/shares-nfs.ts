import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { ConfirmStore } from '../safety/confirm.js'
import type { GuardSpec, ObjectView, Refusal } from '../safety/guard.js'
import type { AccessService } from '../services/access.js'
import { createHash } from 'node:crypto'
import { AbsolutePath, CreateNfsExportRequest, EXPORT_PATH_MSG, isExportPath, sameConfigPath, UpdateNfsExportRequest } from '@anas/shared'
import { addExport, exportsOnLines, hasExport, linesFor, parseExportsByPath, parseExportsDoc, removeExport, replaceExport, serializeClients } from '../parsers/exports.js'
import { guardCheck, guardConfirm, guarded, GuardRefusalError, nfsShareClaim, sendRefusal } from '../safety/guard.js'
import { createAccessService } from '../services/access.js'
import { duplicateKeyRefusal, duplicateKeyWarning, EXPORT_DUPLICATE } from '../services/config-duplicates.js'
import { editConfig, readConfig } from '../services/config-writer.js'
import { normalizeMountpointPath } from '../services/mounts.js'
import { loadPveFootprint } from '../services/pve-footprint.js'
import { probeSharePath, probeSharePaths, sharePathFields, sharePathVerdictRefusal } from '../services/share-path.js'
import { requireIdentity } from './identity.js'
import { shareAccessHandlers } from './share-access.js'

/** `exportfs -ra` re-reads /etc/exports and syncs the kernel export table. */
const EXPORTFS = '/usr/sbin/exportfs'

/** The file `exportfs -ra` re-reads; it is not an export it can name. */
const EXPORTS_FILE = '/etc/exports'

/** What ends a path token in an exportfs error line: blanks, a colon, a quote. */
const EXPORT_ERROR_BOUNDS = /[\s:,"']/

/**
 * The paths an `exportfs -ra` error line NAMES, read as whole tokens. An
 * exportfs error quotes the export it choked on as a path (`exportfs: Failed
 * to stat /testpool/share1: No such file or directory` — node pass capture),
 * so a path begins at a `/` that starts the line or follows a blank, a colon
 * or a quote, and ends at the next one. `/etc/exports` is the file being
 * reloaded, never an export (`exportfs: /etc/exports:3: unknown keyword`). A
 * line with no path in it (`exportfs: duplicated export entries`) names no
 * export (cr4.conf D-3a).
 */
function pathsInExportError(line: string): string[] {
  const out: string[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      // A quoted path is one token, blanks inside it included.
      const end = line.indexOf('"', i + 1)
      const text = end === -1 ? line.slice(i + 1) : line.slice(i + 1, end)
      if (text.startsWith('/'))
        out.push(text)
      i = end === -1 ? line.length : end
      continue
    }
    if (line[i] !== '/')
      continue
    const before = i === 0 ? '' : line[i - 1]
    if (before !== '' && !EXPORT_ERROR_BOUNDS.test(before))
      continue // a slash inside a word does not begin a path
    let end = i + 1
    while (end < line.length && !EXPORT_ERROR_BOUNDS.test(line[end]))
      end++
    out.push(line.slice(i, end))
    i = end - 1
  }
  return out.filter(path => !sameConfigPath(path, EXPORTS_FILE))
}

/**
 * The honest restore report (cr4.conf D-3b): a hand-edit landed while
 * `exportfs -ra` ran, the change-detecting restore left the file alone, and
 * the read-back proves the pre-edit bytes did NOT go back. Says what the read
 * established — the bytes differ, so the earlier contents were not put back —
 * then whether the exact line this job wrote is still in the file, by its
 * bytes and line number. A delete wrote no line, so it reports the lines the
 * path has now, without claiming they are the job's.
 */
function notUndoneSentence(now: string, changedPath: string, written: string): string {
  const current = exportsOnLines(now, changedPath)
  const wrote = exportsOnLines(written, changedPath)[0]?.raw ?? null
  let what: string
  if (wrote !== null) {
    const same = current.find(entry => entry.raw === wrote)
    what = same
      ? `The line this job wrote is still there: line ${same.line}.`
      : 'The line this job wrote is no longer there.'
  }
  else {
    what = current.length > 0
      ? `A line for this path is in /etc/exports: line ${current.map(entry => entry.line).join(' and ')}.`
      : 'No line for this path is in /etc/exports.'
  }
  return `/etc/exports changed while ANAS was reloading it, so ANAS did not put its earlier contents back. ${what} Check the file, then run: exportfs -ra.`
}

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

  /**
   * cr4.conf D-2: an edit of a path on more than one line has no single line
   * to rewrite — the first-match editor would change one line and report
   * success while the other still exports the path with the old clients.
   * Refused at the door and again in the job; the reads show the same
   * sentence. A DELETE is not refused: it removes every line (see
   * `removeExport`), which is the whole export.
   */
  const exportDuplicated = (text: string, path: string): Refusal | null => {
    const lines = linesFor(text, path)
    return lines.length > 1 ? duplicateKeyRefusal(path, lines, '/etc/exports', EXPORT_DUPLICATE) : null
  }

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
      gates: [
        async o => (hasExport(o.text, path) ? null : exportNotFound(path)),
        async o => exportDuplicated(o.text, path),
      ],
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
      gates: [
        async o => (hasExport(o.text, path) ? null : exportNotFound(path)),
      ],
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
      gates: [
        async o => (hasExport(o.text, path) ? exportExists(path) : null),
        // cr3.shares L7 (ruling (j)): the PVE claim re-asked in the job too.
        async () => sharePathVerdictRefusal((await loadPveFootprint(executor)).sharePathVerdict(path), 'Export path', path, 'exports'),
      ],
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
   * reloaded once before the edit. An error line predates this change only
   * when the baseline printed it verbatim, it NAMES the export exportfs
   * choked on, and it does not name the path this job changed; such errors
   * are reported and left alone (cr4.conf D-3a). A line that names no export
   * says nothing about WHICH export fails — a baseline that printed the same
   * path-less text waives nothing — so it counts against the change. When
   * the baseline was clean, any failure counts.
   *
   * The pre-edit bytes are captured inside the SAME `editConfig` transform and
   * the restore is a second `editConfig` under the same change-detecting lock,
   * so a hand-edit that lands between the write and the reload is left alone.
   * `restored` is then decided by READING the file back and comparing bytes
   * (cr4.conf D-3b): the file is either back or it is not, and when it is
   * not, the job says the bytes differ and reports whether the line it wrote
   * is still there, instead of reporting a rollback that never happened.
   * `changedPath` is the path this job's line is about — the waiver test
   * needs it, and the honest restore report reads it back.
   */
  async function editExportsWithReload(transform: (current: string) => string, progress: (message: string) => void, changedPath: string): Promise<void> {
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
    // Every real exportfs error quotes the export it choked on as a path (the
    // pathsInExportError capture above). A line with no path in it names no
    // export, so it cannot be judged to predate anything. The changed path is
    // compared as a whole token, so an error on `/srv/nfs/backups` is not an
    // error on `/srv/nfs/backup`.
    const namedPaths = (line: string): string[] => pathsInExportError(line)
    const namesExport = (line: string): boolean => namedPaths(line).length > 0
    const namesChangedPath = (line: string): boolean => namedPaths(line).some(path => sameConfigPath(path, changedPath))
    const predatesChange = (line: string): boolean =>
      known.has(line) && namesExport(line) && !namesChangedPath(line)
    const against = after.errors.filter(line => !predatesChange(line))
    if (!baseline.ok && after.errors.length > 0 && against.length === 0) {
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
        // cr4.conf D-3b: believe the bytes, not the call — the read-back is
        // what decides whether the file is back.
        const now = await readConfig(exportsPath)
        restored = now === previous
        if (!restored)
          progress(notUndoneSentence(now, changedPath, writtenBytes))
      }
      catch (restoreErr) {
        progress(`Could not restore /etc/exports after the failed reload — the rejected change is still in the file: ${why(restoreErr)}`)
      }
      if (restored) {
        // A failed `exportfs -ra` may have applied part of the bad file to the
        // kernel's export table; reload the restored file so the kernel
        // matches it again. Best-effort: the error below is what the job reports.
        // A non-zero exit with no stderr names no export, so it says its note
        // too (cr4.conf D-3a).
        const again = await runExportfs().catch(() => null)
        if (again && !again.ok && (again.errors.length === 0 || again.errors.some(line => !predatesChange(line))))
          progress(`/etc/exports was restored, but reloading it failed — the kernel's export table may not match the file: ${again.message}`)
      }
    }
    throw new Error(against.length > 0 ? against.join('\n') : after.message)
  }

  // --- GET /shares/nfs — list ALL exports --------------------------------
  server.get('/shares/nfs', async () => {
    // Check each export's path at read time: missing = a stale line, not
    // answering = a hung mount under it (cr.35, through the executor).
    const text = await readConfig(exportsPath)
    // cr4.conf D-2: one row per path, carrying the clients of every line for
    // it — /etc/exports allows the same path on several lines for different
    // clients. A path on more than one line cannot be edited, so its row says
    // so with the line numbers.
    const parsed = parseExportsByPath(text)
    const probes = await probeSharePaths(executor, parsed.map(e => e.path))
    const exports = parsed.map(exp => ({
      ...exp,
      ...sharePathFields(probes.get(exp.path)!),
      ...duplicateKeyWarning(exp.path, linesFor(text, exp.path), '/etc/exports', EXPORT_DUPLICATE),
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

    const text = await readConfig(exportsPath)
    const exp = parseExportsByPath(text).find(e => sameConfigPath(e.path, path))
    if (!exp) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Export '${path}' not found` } }
    }
    return {
      data: {
        ...exp,
        ...sharePathFields(await probeSharePath(executor, exp.path)),
        // cr4.conf D-2: the same line-number warning the list carries.
        ...duplicateKeyWarning(path, linesFor(text, path), '/etc/exports', EXPORT_DUPLICATE),
      },
    }
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
    // cr3.shares M4: only a positive "no claim" opens the door — a
    // footprint that could not see refuses (sharePathVerdictRefusal).
    const pathRefusal = sharePathVerdictRefusal((await loadPveFootprint(executor)).sharePathVerdict(exp.path), 'Export path', exp.path, 'exports')
    if (pathRefusal)
      return sendRefusal(reply, pathRefusal)

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
        }, updateProgress, exp.path)
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
          // cr4.conf D-2: two lines for the path appeared since the reverify
          // read — the same refusal, the file keeps its bytes.
          const dup = exportDuplicated(current, path)
          if (dup)
            throw new GuardRefusalError(dup)
          return replaceExport(current, path, exp)
        }, updateProgress, path)
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
    // The confirm names every line the delete removes, with that line's
    // clients: a path on several lines is one export and the delete takes all
    // of them.
    if (!guardConfirm(confirmStore, request, reply, spec, pre, {
      validated: { path },
      address: ['path'],
      message: `Removing NFS export '${path}' revokes access for its clients`,
      warnings: [
        `Export '${path}' will be removed from /etc/exports and unexported immediately.`,
        `Any clients currently mounting '${path}' will lose access on the next access.`,
        ...exportsOnLines(pre.object.text, path).map(entry => `Line ${entry.line}: ${serializeClients(entry.clients) || 'no clients'}`),
      ],
    })) {
      return reply
    }

    const job = jobQueue.submit(
      'nfs.export.remove',
      { ...identity, params: { path } },
      guarded(spec, pre, async (_exp, { updateProgress }) => {
        updateProgress(`Removing NFS export ${path}`)
        let removedLines = 0
        await editExportsWithReload((current) => {
          // Last-moment backstop: gone since the reverify read — refuse with
          // the 404 sentence, the file keeps its bytes.
          if (!hasExport(current, path))
            throw new GuardRefusalError(exportNotFound(path))
          // cr4.conf D-2: every line for the path goes — the lines differ only
          // in clients, and one left behind would keep exporting the path.
          removedLines = exportsOnLines(current, path).length
          return removeExport(current, path)
        }, updateProgress, path)
        return { removed: path, lines: removedLines }
      }),
      { locks: pre.locks },
    )

    reply.code(202)
    return { job }
  })
}
