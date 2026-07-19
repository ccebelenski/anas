import type {
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
  BackupName,
  BackupRepoTestRequest,
  BackupTaskRequest,
  UpsertBackupRepoRequest,
} from '@anas/shared'
import {
  readBackupRepos,
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
  fetchServerFingerprint,
  normalizeFingerprint,
  PBC,
  resolvesDns,
  runBackup,
  tcpReachable,
} from '../services/backup-runner.js'
import {
  deriveTaskStatus,
  readAllTasks,
  readRecentJournal,
  readTask,
  readUnitTexts,
  removeTaskUnits,
  taskFileExists,
  validateSchedule,
  writeTaskUnits,
} from '../services/backup-units.js'
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
 *   POST   /v1/backup/tasks/:name/run  → Run Now (job carries pbc progress)
 *
 * Mutations are identity-gated jobs (202 → { job }); registry writes are
 * COMPARE-AND-SWAP. Status is LOCAL-ONLY — ANAS never contacts the PBS server
 * except for backup runs and the explicit user-initiated Test.
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

  // ==========================================================================
  //  Repositories
  // ==========================================================================

  /** The response shape for one repo (adds `credentialsSet`; never the secret). */
  async function toRepoResponse(repo: BackupRepo): Promise<BackupRepoResponse> {
    return { ...repo, credentialsSet: await repoSecretSet(paths.credsDir, repo.name) }
  }

  // --- GET /backup/repos ----------------------------------------------------
  server.get('/backup/repos', async () => {
    const reg = await readBackupRepos(paths)
    const repos = await Promise.all(reg.repos.map(toRepoResponse))
    return { data: { version: reg.version, repos } }
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

    // Resolve to a repo-like target + secret: a registered repo (by name, stored
    // secret) OR an inline config (from the dialog, with its secret).
    let repo: BackupRepo
    let secret: string | null
    if (!req.host && req.name) {
      const reg = await readBackupRepos(paths)
      const found = reg.repos.find(r => r.name === req.name)
      if (!found) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Repository '${req.name}' not found` } }
      }
      repo = found
      secret = await readRepoSecret(paths.credsDir, found.name)
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
      secret = req.secret ?? null
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
   * the referenced repository must be registered. Sends the 4xx and returns
   * false on the first failure.
   */
  async function guardTask(task: BackupTask, reply: FastifyReply): Promise<boolean> {
    const schedule = await validateSchedule(executor, task.schedule)
    if (!schedule.ok) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Invalid schedule '${task.schedule}': ${schedule.error}` } })
      return false
    }
    const reg = await readBackupRepos(paths)
    if (!reg.repos.some(r => r.name === task.repository)) {
      reply.code(400)
      reply.send({ error: { code: 'VALIDATION_ERROR', message: `Repository '${task.repository}' is not registered` } })
      return false
    }
    return true
  }

  // --- GET /backup/tasks — grid (LOCAL-ONLY status) -------------------------
  server.get('/backup/tasks', async () => {
    const [tasks, reg] = await Promise.all([readAllTasks(systemdDir), readBackupRepos(paths)])
    const data = await Promise.all(
      tasks.map(async (task): Promise<BackupTaskEntry> => {
        const st = await deriveTaskStatus(executor, task)
        return {
          task: toTaskView(task, reg.repos),
          lastRunResult: st.lastRunResult,
          lastRunAt: st.lastRunAt,
          nextRunAt: st.nextRunAt,
          overdue: st.overdue,
        }
      }),
    )
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

    const [reg, st, units, journal] = await Promise.all([
      readBackupRepos(paths),
      deriveTaskStatus(executor, task),
      readUnitTexts(systemdDir, name),
      readRecentJournal(executor, name),
    ])
    const detail: BackupTaskDetail = {
      task: toTaskView(task, reg.repos),
      lastRunResult: st.lastRunResult,
      lastRunAt: st.lastRunAt,
      nextRunAt: st.nextRunAt,
      overdue: st.overdue,
      unit: units.unit,
      timer: units.timer,
      ...(journal ? { journal } : {}),
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

  // --- POST /backup/tasks/:name/run — Run Now (real backup, live progress) --
  // Unlike replication (which fires the systemd unit), the backup RUN endpoint
  // runs the backup as the job itself so the UI can poll it for pbc progress.
  // The timer's ExecStart helper (backup-task.js) POSTs to THIS endpoint too, so
  // scheduled and manual runs share one code path.
  server.post<{ Params: { name: string } }>('/backup/tasks/:name/run', async (request, reply) => {
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
      'backup.task.run',
      { ...identity, params: { task: name } },
      async (updateProgress) => {
        const task = await readTask(systemdDir, name)
        if (!task)
          throw new Error(`Backup task '${name}' not found`)
        const reg = await readBackupRepos(paths)
        const repo = reg.repos.find(r => r.name === task.repository)
        if (!repo)
          throw new Error(`Repository '${task.repository}' is not registered`)
        const secret = await readRepoSecret(paths.credsDir, repo.name)
        if (secret === null)
          throw new Error(`No secret stored for repository '${repo.name}' — set its credentials first`)
        return runBackup(executor, { task, repo, secret }, updateProgress)
      },
    )
    reply.code(202)
    return { job }
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
