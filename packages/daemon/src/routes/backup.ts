import type {
  BackupNestedPreviewResponse,
  BackupNestedScan,
  BackupPrunePreviewResponse,
  BackupRepo,
  BackupRepoResponse,
  BackupRepoTestResult,
  BackupTask,
  BackupTaskDetail,
  BackupTaskEntry,
  BackupTaskView,
} from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { BackupReposPaths } from '../services/backup-repos.js'
import {
  BACKUP_SKIPPED_OFF_WEEK,
  BackupName,
  BackupNestedPreviewRequest,
  BackupPrunePreviewRequest,
  BackupRepoTestRequest,
  BackupRunRequest,
  BackupTaskRequest,
  effectiveIncludeNested,
  hasRetentionKeeps,
  UpsertBackupRepoRequest,
} from '@anas/shared'
import { readPbsStorages } from '../parsers/pve-storage.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { deriveConsistency, readConsistencyFacts } from '../services/backup-consistency.js'
import { notifyBackupRun } from '../services/backup-notify.js'
import { pruneAfterBackup, pruneGroup, runPrune } from '../services/backup-prune.js'
import {
  isPveRepoName,
  pbsDefToRepo,
  pveRepoName,
  pveSecretSet,
  pveStorageId,
  readBackupRepos,
  readPveSecret,
  readRepoSecret,
  removeRepoSecret,
  repoSecretSet,
  writeBackupRepos,
  writeRepoSecret,
} from '../services/backup-repos.js'
import {
  buildBackupEnv,
  buildProbeArgs,
  classifyTestVerdict,
  effectiveNamespace,
  fetchServerFingerprint,
  normalizeFingerprint,
  PBC,
  resolvesDns,
  runBackup,
  tcpReachable,
} from '../services/backup-runner.js'
import {
  deriveTaskStatus,
  effectiveSchedule,
  gateRun,
  readAllTasks,
  readRecentJournal,
  readTask,
  readUnitTexts,
  removeTaskUnits,
  superviseRun,
  taskFileExists,
  validateSchedule,
  writeTaskUnits,
} from '../services/backup-units.js'
import { scanArchives, scanNestedFilesystems } from '../services/nested-filesystems.js'
import { requireIdentity } from './identity.js'

/**
 * PBS file backup routes (Epic 16) — the repositories registry (CAS corosync
 * store + per-repo secrets + diagnosing test) and the task store (systemd
 * units-as-store CRUD + LOCAL-ONLY status + Run-Now with progress).
 *
 *   GET    /v1/backup/repos            → { version, repos[+credentialsSet] }
 *   POST   /v1/backup/repos            → register (CAS; 409 on stale/dup)
 *   PUT    /v1/backup/repos/:name      → update / rotate credentials (CAS)
 *   DELETE /v1/backup/repos/:name      → unregister (CAS; 409 while a task uses it)
 *   POST   /v1/backup/repos/test       → dns/tcp/tls/auth/datastore/namespace
 *   GET    /v1/backup/tasks            → task grid (systemd state)
 *   GET    /v1/backup/tasks/:name      → detail (config + units + journald)
 *   POST   /v1/backup/tasks            → create (write units, enable timer)
 *   PUT    /v1/backup/tasks/:name      → update / enable / disable
 *   DELETE /v1/backup/tasks/:name      → remove units (PBS data untouched)
 *   POST   /v1/backup/tasks/:name/run  → Run Now (UI: start+supervise the unit;
 *                                        direct:true: the unit's own pbc exec)
 *   POST   /v1/backup/tasks/:name/prune-preview → retention dry-run (16.11)
 *   POST   /v1/backup/tasks/preview-nested → nested-filesystem scan (backup2.2;
 *                                        LOCAL-ONLY: no PBS contact at all)
 *
 * Mutations are identity-gated jobs (202 → { job }); registry writes are
 * COMPARE-AND-SWAP. Status is LOCAL-ONLY — ANAS never contacts the PBS server
 * except for backup runs, the explicit user-initiated Test, the post-backup
 * retention prune, and this story's user-initiated prune preview. Never polls.
 */
export interface BackupRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** Registry + creds paths (pmxcfs registry / 0600 secret files). */
  paths: BackupReposPaths
  /** systemd unit directory (the task store). Overridable for tests. */
  systemdDir: string
}

function CONFLICT(version: number) {
  return {
    error: { code: 'CONFLICT', message: `backup repositories registry changed (version ${version}) — reload and retry` },
  }
}

export async function backupRoutes(server: FastifyInstance, opts: BackupRouteOptions) {
  const { executor, jobQueue, paths, systemdDir } = opts

  /**
   * Attach the DERIVED snapshot-consistency (backup2.3) to a set of boundary
   * scans. It rides the SCAN rather than a second endpoint because both answers
   * come from the same facts — the mount table the scan already needed, plus the
   * AHR topology — and because the wizard asks the two questions at exactly the
   * same moment (a row's path changed).
   *
   * READ-ONLY and additive: no request body carries `consistency` back, and
   * nothing can set it. FAIL-OPEN — a derivation that throws leaves the key
   * absent ("not known"), never a fabricated `live`.
   */
  async function withConsistency(scans: BackupNestedScan[]): Promise<BackupNestedScan[]> {
    try {
      const facts = await readConsistencyFacts(executor, readAhrPools)
      return scans.map(scan => ({ ...scan, consistency: deriveConsistency(scan.path, facts) }))
    }
    catch (err) {
      server.log.warn(`[backup] consistency derivation failed: ${err instanceof Error ? err.message : String(err)}`)
      return scans
    }
  }

  // ==========================================================================
  //  Repositories
  // ==========================================================================

  /** A tier-2 (ANAS-registered) repo response (adds `credentialsSet`, source). */
  async function toRepoResponse(repo: BackupRepo): Promise<BackupRepoResponse> {
    return { ...repo, credentialsSet: await repoSecretSet(paths.credsDir, repo.name), source: 'anas' }
  }

  /**
   * The tier-1 (PVE-defined) repositories: every `pbs` stanza in storage.cfg,
   * mapped to the repo response shape as `pve:<id>` with `source: 'pve'` and
   * `credentialsSet` reflecting whether the `.pw` file exists. Read-only; the
   * secret itself is NEVER read here (only at exec/test time). FAIL-OPEN.
   */
  async function pveRepoResponses(): Promise<BackupRepoResponse[]> {
    const defs = await readPbsStorages(paths.pveStorageCfg)
    return Promise.all(defs.map(async (def): Promise<BackupRepoResponse> => ({
      ...pbsDefToRepo(def),
      credentialsSet: await pveSecretSet(paths.pvePrivStorageDir, def.id),
      source: 'pve',
    })))
  }

  /**
   * Resolve a repo REFERENCE (tier-2 name or `pve:<id>`) to its runtime repo +
   * secret, reading the secret FRESH at call time. Returns null when the repo
   * does not exist. A tier-1 secret comes from /etc/pve/priv/storage/<id>.pw;
   * a tier-2 secret from /etc/anas/creds — neither is cached.
   */
  async function resolveRepoAndSecret(
    name: string,
  ): Promise<{ repo: BackupRepo, secret: string | null } | null> {
    if (isPveRepoName(name)) {
      const id = pveStorageId(name)
      const def = (await readPbsStorages(paths.pveStorageCfg)).find(d => d.id === id)
      if (!def)
        return null
      return { repo: pbsDefToRepo(def), secret: await readPveSecret(paths.pvePrivStorageDir, id) }
    }
    const found = (await readBackupRepos(paths)).repos.find(r => r.name === name)
    if (!found)
      return null
    return { repo: found, secret: await readRepoSecret(paths.credsDir, name) }
  }

  /**
   * The merged repo list used only to JOIN a task's datastore for the view
   * (tier-2 registry + tier-1 PVE storages). The runner resolves its own repo +
   * secret separately (resolveRepoAndSecret).
   */
  async function reposForJoin(registered: BackupRepo[]): Promise<BackupRepo[]> {
    const defs = await readPbsStorages(paths.pveStorageCfg)
    return [...registered, ...defs.map(pbsDefToRepo)]
  }

  /** 400 body for a mutation attempted on a hands-off PVE-defined repository. */
  function pveHandsOff(name: string) {
    return {
      error: {
        code: 'PVE_MANAGED',
        message: `Repository '${name}' is defined by Proxmox in storage.cfg — manage it in `
          + 'Datacenter → Storage. ANAS never writes storage.cfg or the credential file.',
      },
    }
  }

  // --- GET /backup/repos ----------------------------------------------------
  server.get('/backup/repos', async () => {
    const reg = await readBackupRepos(paths)
    const [registered, pve] = await Promise.all([
      Promise.all(reg.repos.map(toRepoResponse)),
      pveRepoResponses(),
    ])
    return { data: { version: reg.version, repos: [...registered, ...pve] } }
  })

  // --- POST /backup/repos — register (CAS) ----------------------------------
  server.post('/backup/repos', async (request, reply) => {
    const parsed = UpsertBackupRepoRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository request: ${parsed.error.issues[0]?.message}` } }
    }
    const { repo, expectedVersion } = parsed.data
    const authValidation = validateRepoAuth(repo)
    if (authValidation) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: authValidation } }
    }
    // A brand-new repo has no stored secret, so one must be supplied on create.
    if (!repo.secret) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: repo.authType === 'token' ? 'A token secret is required' : 'A password is required' } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const current = await readBackupRepos(paths)
    if (current.version !== expectedVersion) {
      reply.code(409)
      return CONFLICT(current.version)
    }
    if (current.repos.some(r => r.name === repo.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Repository '${repo.name}' already exists` } }
    }

    const { secret, ...stored } = repo
    const job = jobQueue.submit(
      'backup.repo.create',
      { ...identity, params: { repo: repo.name } },
      async () => {
        await writeRepoSecret(paths.credsDir, repo.name, secret)
        const written = await writeBackupRepos(paths, expectedVersion, [...current.repos, stored])
        return { created: repo.name, version: written.version }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /backup/repos/:name — update / rotate (CAS) ----------------------
  server.put<{ Params: { name: string } }>('/backup/repos/:name', async (request, reply) => {
    // Tier-1 PVE repos are hands-off — reject BEFORE the BackupName parse (a
    // `pve:<id>` name would otherwise fail with a cryptic validation error).
    if (isPveRepoName(request.params.name)) {
      reply.code(400)
      return pveHandsOff(request.params.name)
    }
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const parsed = UpsertBackupRepoRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository request: ${parsed.error.issues[0]?.message}` } }
    }
    const { repo, expectedVersion } = parsed.data
    if (repo.name !== name) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Repository name in body ('${repo.name}') does not match URL ('${name}')` } }
    }
    const authValidation = validateRepoAuth(repo)
    if (authValidation) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: authValidation } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const current = await readBackupRepos(paths)
    if (current.version !== expectedVersion) {
      reply.code(409)
      return CONFLICT(current.version)
    }
    const existing = current.repos.find(r => r.name === name)

    // Advisory (NOT a block): changing a repo's auth style while tasks reference
    // it can strand them on the server's group-owner coupling (a group created
    // under password auth refuses a token writer, and vice-versa). Surface it.
    let advisory: string | undefined
    if (existing && existing.authType !== repo.authType) {
      const referencing = (await readAllTasks(systemdDir)).filter(t => t.repository === name)
      if (referencing.length) {
        advisory = `Auth style changed to '${repo.authType}'. Tasks (${referencing.map(t => t.name).join(', ')}) `
          + 'write existing PBS groups owned by the previous auth-id; PBS will refuse the new auth-id until a '
          + 'server-side change-owner is run (or the tasks use a fresh backup-id).'
      }
    }

    const { secret, ...stored } = repo
    const next = existing
      ? current.repos.map(r => (r.name === name ? stored : r))
      : [...current.repos, stored]

    const job = jobQueue.submit(
      'backup.repo.update',
      { ...identity, params: { repo: name } },
      async () => {
        // A blank secret keeps the stored one (write-only field — never cleared
        // by an edit that omits it).
        if (secret)
          await writeRepoSecret(paths.credsDir, name, secret)
        const written = await writeBackupRepos(paths, expectedVersion, next)
        return { updated: name, version: written.version, ...(advisory ? { warnings: [advisory] } : {}) }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /backup/repos/:name?expectedVersion=N — unregister (CAS) -------
  server.delete<{ Params: { name: string }, Querystring: { expectedVersion?: string } }>(
    '/backup/repos/:name',
    async (request, reply) => {
      // Tier-1 PVE repos cannot be unregistered — they live in storage.cfg.
      if (isPveRepoName(request.params.name)) {
        reply.code(400)
        return pveHandsOff(request.params.name)
      }
      const nameParsed = BackupName.safeParse(request.params.name)
      if (!nameParsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid repository name: ${nameParsed.error.issues[0]?.message}` } }
      }
      const name = nameParsed.data

      const rawVersion = request.query.expectedVersion
      const expectedVersion = rawVersion === undefined ? Number.NaN : Number(rawVersion)
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: 'DELETE requires a non-negative integer ?expectedVersion=N (the registry version you read)' } }
      }

      const identity = requireIdentity(request, reply)
      if (!identity)
        return

      const current = await readBackupRepos(paths)
      if (current.version !== expectedVersion) {
        reply.code(409)
        return CONFLICT(current.version)
      }
      if (!current.repos.some(r => r.name === name)) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Repository '${name}' not found` } }
      }

      // Refuse (409) while a backup TASK still references this repository.
      // Distinct code from the CAS 'CONFLICT': the UI reload-and-retries CAS
      // conflicts, but a referenced-repo refusal must show its message.
      const referencing = (await readAllTasks(systemdDir)).filter(t => t.repository === name)
      if (referencing.length) {
        reply.code(409)
        return {
          error: {
            code: 'IN_USE',
            message: `Repository '${name}' is still used by backup task(s): ${referencing.map(t => t.name).join(', ')} — remove them first`,
          },
        }
      }

      const job = jobQueue.submit(
        'backup.repo.remove',
        { ...identity, params: { repo: name } },
        async () => {
          const written = await writeBackupRepos(paths, expectedVersion, current.repos.filter(r => r.name !== name))
          await removeRepoSecret(paths.credsDir, name)
          return { removed: name, version: written.version }
        },
      )
      reply.code(202)
      return { job }
    },
  )

  // --- POST /backup/repos/test — staged diagnosis ---------------------------
  server.post('/backup/repos/test', async (request, reply) => {
    const parsed = BackupRepoTestRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid test request: ${parsed.error.issues[0]?.message}` } }
    }
    const req = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Resolve to a repo-like target + secret: a registered repo OR a tier-1
    // PVE-defined repo (both by name, secret loaded fresh) OR an inline config
    // (from the dialog, with its secret — or, when the secret was left blank on
    // an edit, the stored one; see the fallback in the inline branch).
    let repo: BackupRepo
    let secret: string | null
    if (!req.host && req.name) {
      const resolved = await resolveRepoAndSecret(req.name)
      if (!resolved) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Repository '${req.name}' not found` } }
      }
      // A `namespace` OVERRIDE lets the task wizard verify the TASK's effective
      // namespace (the task's, else the repo's) against a REGISTERED repo without
      // re-entering the whole config — the same `{ name }` form plus one field. A
      // blank override falls through to the repo's own namespace.
      repo = req.namespace
        ? { ...resolved.repo, namespace: req.namespace }
        : resolved.repo
      secret = resolved.secret
    }
    else {
      if (!req.host || !req.datastore || !req.authType) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: 'host, datastore and authType are required to test an unregistered repository' } }
      }
      repo = {
        name: req.name ?? '(inline)',
        host: req.host,
        port: req.port ?? 8007,
        datastore: req.datastore,
        authType: req.authType,
        ...(req.namespace ? { namespace: req.namespace } : {}),
        ...(req.tokenId ? { tokenId: req.tokenId } : {}),
        ...(req.username ? { username: req.username } : {}),
        ...(req.fingerprint ? { fingerprint: normalizeFingerprint(req.fingerprint) } : {}),
      }
      // The secret is WRITE-ONLY: it is never read back, so the edit dialog
      // sends none when the operator left the field blank — its '(unchanged)'
      // promise, and exactly what the save path then honours. Test has to make
      // the same promise, or it fails auth on a repo that saves and runs fine.
      // The fallback is keyed on the NAME while the rest of the config comes
      // from the request, so a repo whose host/datastore/token-id were edited is
      // tested as it would actually be SAVED: the new fields, the stored secret.
      secret = req.secret ?? null
      if (!secret && req.name) {
        const resolved = await resolveRepoAndSecret(req.name)
        secret = resolved?.secret ?? null
      }
    }

    const result = await diagnose(repo, secret)
    // Fire-and-forget audit record (journald) — never logs the secret.
    jobQueue.submit(
      'backup.repo.test',
      { ...identity, params: { repo: repo.name, host: repo.host, port: repo.port } },
      async () => ({ stage: result.stage }),
    )
    return { data: result }
  })

  /**
   * Probe a repo in stages, reporting WHAT failed. The daemon does its OWN dns +
   * tcp + tls-fingerprint checks (pbc collapses dns/tcp/route into one message),
   * then — only once a matching cert is pinned — falls to a cheap `snapshot list`
   * for auth/datastore/namespace.
   */
  async function diagnose(repo: BackupRepo, secret: string | null): Promise<BackupRepoTestResult> {
    if (!(await resolvesDns(repo.host)))
      return { stage: 'dns', detail: `Could not resolve host '${repo.host}'` }
    if (!(await tcpReachable(repo.host, repo.port)))
      return { stage: 'tcp', detail: `No answer on ${repo.host}:${repo.port}` }

    const serverFp = await fetchServerFingerprint(repo.host, repo.port)
    if (!serverFp)
      return { stage: 'tls-fingerprint', detail: 'TLS handshake failed — the server did not present a usable certificate.' }
    if (!repo.fingerprint) {
      return { stage: 'tls-fingerprint', fingerprint: serverFp, detail: 'Certificate is not yet pinned — confirm this fingerprint.' }
    }
    if (normalizeFingerprint(repo.fingerprint) !== serverFp) {
      return { stage: 'tls-fingerprint', fingerprint: serverFp, detail: 'Certificate fingerprint does not match the pinned value — confirm the new one to proceed.' }
    }

    // Cert confirmed. Now exercise auth/datastore/namespace via a cheap read.
    const env = buildBackupEnv(repo, secret ?? '')
    const r = await executor.exec(PBC, buildProbeArgs(repo.namespace), { env })
    return classifyTestVerdict(r.exitCode, r.stderr)
  }

  // ==========================================================================
  //  Tasks
  // ==========================================================================

  /** The datastore for a task's repository (joined so the UI need not). */
  function datastoreOf(task: BackupTask, repos: BackupRepo[]): string | undefined {
    return repos.find(r => r.name === task.repository)?.datastore
  }

  /** A task enriched with its repo datastore (response shape). */
  function toTaskView(task: BackupTask, repos: BackupRepo[]): BackupTaskView {
    const datastore = datastoreOf(task, repos)
    return datastore ? { ...task, datastore } : { ...task }
  }

  /**
   * Create/update guards: the schedule must be valid systemd calendar syntax and
   * the referenced repository must exist — as a tier-2 registered repo OR a
   * tier-1 PVE-defined repo (`pve:<id>`). Sends the 4xx and returns false on the
   * first failure.
   */
  async function guardTask(task: BackupTask, reply: FastifyReply): Promise<boolean> {
    // The EFFECTIVE expression — the one a cadence generated, when there is one.
    // systemd stays the authority on calendar syntax for generated expressions
    // exactly as it is for hand-written ones (16.10).
    const expression = effectiveSchedule(task)
    const schedule = await validateSchedule(executor, expression)
    if (!schedule.ok) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid schedule '${expression}': ${schedule.error}` } })
      return false
    }
    const known = isPveRepoName(task.repository)
      ? (await readPbsStorages(paths.pveStorageCfg)).some(d => pveRepoName(d.id) === task.repository)
      : (await readBackupRepos(paths)).repos.some(r => r.name === task.repository)
    if (!known) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Repository '${task.repository}' is not registered` } })
      return false
    }
    return true
  }

  // --- GET /backup/tasks — grid (LOCAL-ONLY status) -------------------------
  server.get('/backup/tasks', async () => {
    const [tasks, reg] = await Promise.all([readAllTasks(systemdDir), readBackupRepos(paths)])
    // Merge tier-1 PVE repos so a task targeting `pve:<id>` still joins its datastore.
    const joinRepos = await reposForJoin(reg.repos)
    const data = await Promise.all(
      tasks.map(async (task): Promise<BackupTaskEntry> => {
        const st = await deriveTaskStatus(executor, task)
        return {
          task: toTaskView(task, joinRepos),
          lastRunResult: st.lastRunResult,
          lastRunAt: st.lastRunAt,
          nextRunAt: st.nextRunAt,
          overdue: st.overdue,
        }
      }),
    )
    return { data }
  })

  // --- POST /backup/tasks/preview-nested — the wizard's boundary scan -------
  // USER-INITIATED, one-shot, NON-MUTATING and entirely LOCAL: an `st_dev` walk
  // of the source plus `findmnt` to name what it found. NO PBS contact at all —
  // this is the save-time verify pattern (the namespace check, `prune-preview`)
  // with nothing to verify remotely. It is registered BEFORE `/backup/tasks/:name`
  // so the literal segment can never be read as a task name.
  server.post('/backup/tasks/preview-nested', async (request, reply) => {
    const bodyParsed = BackupNestedPreviewRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid preview request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!req.path && !req.archives?.length) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: 'Send a path, or the archives to scan' } }
    }

    const archives: BackupNestedScan[] = req.archives?.length
      ? await scanArchives(executor, req.archives.map(a => ({
          ...(a.name ? { name: a.name } : {}),
          path: a.path,
          includeNested: effectiveIncludeNested(a),
        })))
      : [await scanNestedFilesystems(executor, req.path as string, {
          includeNested: effectiveIncludeNested({ includeNested: req.includeNested ?? 'none' }),
        })]

    // backup2.3 — the DERIVED consistency rides the SAME response rather than a
    // second endpoint: both answers come from the one mount table this scan
    // already needed, plus the AHR topology. Read-only and additive; nothing in
    // any request body carries it back.
    const data: BackupNestedPreviewResponse = { archives: await withConsistency(archives) }
    return { data }
  })

  // --- GET /backup/tasks/:name — detail ------------------------------------
  server.get<{ Params: { name: string } }>('/backup/tasks/:name', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const task = await readTask(systemdDir, name)
    if (!task) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Backup task '${name}' not found` } }
    }

    const [reg, st, units, journal, nested] = await Promise.all([
      readBackupRepos(paths),
      deriveTaskStatus(executor, task),
      readUnitTexts(systemdDir, name),
      readRecentJournal(executor, name),
      // backup2.2 — what is nested under each source RIGHT NOW, and whether the
      // task's current includeNested covers it. LOCAL-ONLY (an st_dev walk plus
      // findmnt); no PBS contact, so the never-poll rule is untouched. Fail-open:
      // a scan that throws leaves the key ABSENT ("not known"), never an empty
      // array pretending nothing is nested.
      scanArchives(executor, task.archives)
        // backup2.3 — and, on the same scan, the DERIVED consistency of each
        // source, so the detail can show `snapshot` / `live` with its reason.
        .then(withConsistency)
        .catch((err: unknown) => {
          server.log.warn(`[backup] nested scan for task ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }),
    ])
    const joinRepos = await reposForJoin(reg.repos)
    const detail: BackupTaskDetail = {
      task: toTaskView(task, joinRepos),
      lastRunResult: st.lastRunResult,
      lastRunAt: st.lastRunAt,
      nextRunAt: st.nextRunAt,
      overdue: st.overdue,
      unit: units.unit,
      timer: units.timer,
      ...(journal ? { journal } : {}),
      ...(nested ? { nested } : {}),
    }
    return { data: detail }
  })

  // --- POST /backup/tasks — create -----------------------------------------
  server.post('/backup/tasks', async (request, reply) => {
    const bodyParsed = BackupTaskRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid backup task: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const task = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (await taskFileExists(systemdDir, task.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Backup task '${task.name}' already exists` } }
    }
    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'backup.task.create',
      { ...identity, params: { task: task.name } },
      async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { created: task.name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /backup/tasks/:name — update / enable / disable ------------------
  server.put<{ Params: { name: string } }>('/backup/tasks/:name', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = BackupTaskRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid backup task: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const task = bodyParsed.data
    if (task.name !== name) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Task name in body ('${task.name}') does not match URL ('${name}')` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Backup task '${name}' not found` } }
    }
    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'backup.task.update',
      { ...identity, params: { task: name } },
      async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { updated: name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /backup/tasks/:name — remove the units (PBS data untouched) ---
  server.delete<{ Params: { name: string } }>('/backup/tasks/:name', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Backup task '${name}' not found` } }
    }

    const job = jobQueue.submit(
      'backup.task.remove',
      { ...identity, params: { task: name } },
      async () => {
        await removeTaskUnits(executor, systemdDir, name)
        return { removed: name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /backup/tasks/:name/run — Run Now ------------------------------
  // TWO paths, one endpoint (the recursion guard is the `direct` flag):
  //   • UI Run-Now (no `direct`): the job STARTS the task's own systemd unit and
  //     supervises it to completion — so a manual run lands in systemd's
  //     last-result and the unit journal exactly like a scheduled run (one code
  //     path, one history). Supervision is LOCAL-ONLY (systemd + journald).
  //   • The unit's OWN execution (`direct:true`, from the backup-task helper the
  //     timer / `systemctl start` fires): runs pbc IN the daemon. It NEVER
  //     re-enters systemctl — that is what keeps the two paths from recursing.
  server.post<{ Params: { name: string } }>('/backup/tasks/:name/run', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = BackupRunRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid run request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const direct = bodyParsed.data.direct === true

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Backup task '${name}' not found` } }
    }

    const job = jobQueue.submit(
      'backup.task.run',
      { ...identity, params: { task: name, ...(direct ? { direct: true } : {}) } },
      async (updateProgress) => {
        if (!direct) {
          // The manual/UI path: run through the task's own unit and supervise it.
          return superviseRun(executor, name, { onProgress: updateProgress })
        }
        // The unit's own execution: run pbc in the daemon (NEVER systemctl).
        const task = await readTask(systemdDir, name)
        if (!task)
          throw new Error(`Backup task '${name}' not found`)

        // 16.12: this branch is the ONE place every real run converges (a timer
        // fire and a UI Run Now both arrive here through the task's own unit),
        // so it is also the one place a run notification is emitted. What is
        // known when the run ends rides the notification, which is why the repo
        // is tracked outside the try — a failure before it resolves still names
        // the task's configured repository.
        const startedAt = Date.now()
        let repo: BackupRepo | undefined
        let namespace: string | undefined
        try {
          // Cadence gate (16.10): a biweekly task runs on a WEEKLY timer because
          // OnCalendar cannot say "every other week", so an off-week SCHEDULED fire
          // stops here. It completes as a first-class, visible skip — a journal
          // line, an exit status systemd counts as success, and a `skipped` task
          // status — never a fake success-with-backup and never a failure. A Run Now
          // is not gated (explicit user intent), and every other cadence is pure
          // OnCalendar with nothing to gate. It NEVER notifies (16.12): the gate
          // produced no run, and the cron jobs it replaces produced no mail.
          const gate = await gateRun(executor, task)
          if (!gate.run) {
            updateProgress(`backup task '${name}': ${gate.detail}`)
            return { status: BACKUP_SKIPPED_OFF_WEEK, archives: [], reason: gate.detail }
          }
          if (gate.reason === 'heal' || gate.reason === 'no-record')
            updateProgress(`backup task '${name}': ${gate.detail}`)

          // Resolve tier-2 (registry) or tier-1 (pve:<id>) repo + secret FRESH.
          // A tier-1 secret is read from /etc/pve/priv/storage/<id>.pw here, at
          // exec time — never copied, never cached (PVE rotation is instant).
          const resolved = await resolveRepoAndSecret(task.repository)
          if (!resolved)
            throw new Error(`Repository '${task.repository}' is not registered`)
          const secret = resolved.secret
          repo = resolved.repo
          namespace = effectiveNamespace(task, repo)
          if (secret === null) {
            throw new Error(isPveRepoName(task.repository)
              ? `No PBS credential file for '${task.repository}' (${paths.pvePrivStorageDir}/${pveStorageId(task.repository)}.pw is missing) — set it in Datacenter → Storage`
              : `No secret stored for repository '${repo.name}' — set its credentials first`)
          }
          const result = await runBackup(executor, { task, repo, secret }, updateProgress)
          // Retention (16.11): prune ONLY after a run that actually backed up. A
          // 'skipped' run (the benign too-soon collision — and any future cadence
          // skip) never prunes, and a FAILED run threw long before this line. A
          // task with no retention prunes nothing at all (the default posture);
          // a prune failure rides back as a warning, never a job failure.
          let final = result
          if (result.status === 'success') {
            const pruned = await pruneAfterBackup(executor, {
              task,
              repo,
              secret,
              onProgress: updateProgress,
              log: (message, level) => (level === 'warn' ? server.log.warn(message) : server.log.info(message)),
            })
            // MERGE the warning lists rather than letting the spread clobber
            // them: the run already carries this story's nested-filesystem
            // omissions (backup2.2), and a prune warning must not erase them.
            const warnings = [...(result.warnings ?? []), ...(pruned.warnings ?? [])]
            final = {
              ...result,
              ...pruned,
              ...(warnings.length ? { warnings } : {}),
            }
          }
          // Best-effort by contract: notifyBackupRun never throws, so a broken
          // mail target cannot turn a good backup into a failed job.
          await notifyBackupRun(executor, { task, repo, namespace, result: final, elapsedMs: Date.now() - startedAt })
          return final
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await notifyBackupRun(executor, { task, repo, namespace, error: message, elapsedMs: Date.now() - startedAt })
          throw err
        }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /backup/tasks/:name/prune-preview — dry-run retention preview ----
  // USER-INITIATED, one-shot, NON-MUTATING (`--dry-run`): the wizard's Preview
  // button. It is the second (and last) PBS contact this story sanctions, the
  // save-time namespace-verify precedent reapplied — never polled, never
  // background. Every field may be supplied inline so an UNSAVED task can be
  // previewed; omitted fields fall back to the stored task's own values.
  server.post<{ Params: { name: string } }>('/backup/tasks/:name/prune-preview', async (request, reply) => {
    const nameParsed = BackupName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${nameParsed.error.issues[0]?.message}` } }
    }
    const name = nameParsed.data

    const bodyParsed = BackupPrunePreviewRequest.safeParse(request.body ?? {})
    if (!bodyParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid preview request: ${bodyParsed.error.issues[0]?.message}` } }
    }
    const req = bodyParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const stored = await readTask(systemdDir, name)
    const repository = req.repository ?? stored?.repository
    const backupId = req.backupId ?? stored?.backupId
    const retention = req.retention ?? stored?.retention
    if (!repository || !backupId) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Backup task '${name}' is not saved yet — send repository and backupId with the preview request`,
        },
      }
    }
    if (!hasRetentionKeeps(retention)) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Set at least one retention keep before previewing — with no keep flags PBS keeps everything, so ANAS never runs prune',
        },
      }
    }

    const resolved = await resolveRepoAndSecret(repository)
    if (!resolved) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Repository '${repository}' not found` } }
    }
    const { repo, secret } = resolved
    if (secret === null) {
      reply.code(400)
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: isPveRepoName(repository)
            ? `No PBS credential file for '${repository}' — set it in Datacenter → Storage`
            : `No secret stored for repository '${repo.name}' — set its credentials first`,
        },
      }
    }

    // Effective namespace: the request's, else the stored task's, else the
    // repo's own — the same fallback the run path uses.
    const namespace = req.namespace ?? stored?.namespace ?? repo.namespace
    const outcome = await runPrune(executor, {
      repo,
      secret,
      backupId,
      ...(namespace ? { namespace } : {}),
      retention: retention as NonNullable<typeof retention>,
      dryRun: true,
    })

    const data: BackupPrunePreviewResponse = outcome.ok
      ? { verdict: 'ok', result: outcome.result }
      : { verdict: outcome.verdict, detail: outcome.detail }

    // Fire-and-forget audit record (journald) — mirrors the repo Test endpoint.
    jobQueue.submit(
      'backup.task.prune-preview',
      { ...identity, params: { task: name, repo: repo.name, group: pruneGroup(backupId) } },
      async () => ({ verdict: data.verdict }),
    )
    return { data }
  })
}

/**
 * Validate that a repo write carries the identity its auth style needs (a token
 * id for token auth, a username for password auth). Returns an error message or
 * null when valid.
 */
function validateRepoAuth(repo: { authType: string, tokenId?: string, username?: string }): string | null {
  if (repo.authType === 'token' && !repo.tokenId)
    return 'Token auth requires a token id (user@realm!tokenname)'
  if (repo.authType === 'password' && !repo.username)
    return 'Password auth requires a username (user@realm)'
  return null
}
