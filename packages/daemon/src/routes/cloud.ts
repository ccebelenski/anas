import type {
  CloudProvider,
  CloudRemoteTestRequest,
  CloudRemoteTestResult,
  CloudRemoteWrite,
  CloudSyncPreviewResult,
  CloudSyncPreviewTask,
  CloudSyncTask,
  CloudSyncTaskDetail,
  CloudSyncTaskView,
} from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { RcloneConfigPaths } from '../services/rclone-config.js'
import { access, constants } from 'node:fs/promises'
import {
  BACKUP_SKIPPED_OFF_WEEK,
  BackupName,
  CloudRemoteName,
  CloudRemoteTestRequest as CloudRemoteTestRequestSchema,
  CloudRemoteUpdate as CloudRemoteUpdateSchema,
  CloudRemoteWrite as CloudRemoteWriteSchema,
  CloudSyncPreviewTask as CloudSyncPreviewTaskSchema,
  CloudSyncRunRequest,
  CloudSyncTaskRequest,
  validateOwnClient,
} from '@anas/shared'
import { assertRunNotCancelled, ChildCancel } from '../jobs/child-cancel.js'
import { JobCancelledError, JobFailedDespiteCancelError } from '../jobs/queue.js'
import { readAhrPools } from '../services/ahr-topology.js'
import { deriveConsistency, readConsistencyFacts } from '../services/backup-consistency.js'
import { notifyCloudRun } from '../services/cloud-notify.js'
import { previewCloudSync, PreviewRefusal } from '../services/cloud-preview.js'
import { runCloudSync } from '../services/cloud-runner.js'
import {
  clearCancelledRunFailedState,
  DEFAULT_SYSTEMD_DIR,
  deriveTaskStatus,
  DISABLED_HISTORY_NOTE,
  effectiveSchedule,
  gateRun,
  readAllTasks,
  readRecentJournal,
  readRunActive,
  readTask,
  readUnitTexts,
  removeTaskUnits,
  runningDirectJobFields,
  runningDirectJobProgress,
  runningRunConflictMessage,
  serviceUnitName,
  superviseRun,
  taskFileExists,
  tasksReferencingRemote,
  validateSchedule,
  writeTaskUnits,
} from '../services/cloud-units.js'
import { scanNestedFilesystems } from '../services/nested-filesystems.js'
import { normalizeOAuthToken, OAUTH_TOKEN_ERROR, RCLONE, rcloneBaseArgs, rcloneVersion, readConfig, RemoteNotFoundError, remotesReferencing, removeRemote, trimProviders, writeRemote } from '../services/rclone-config.js'
import { testRemote } from '../services/rclone-probe.js'
import { zodIssue } from '../validation.js'
import { requireIdentity } from './identity.js'

/**
 * Cloud sync — remotes (story rclone.1) and TASKS (story rclone.2), DESIGN
 * "Cloud sync — rclone".
 *
 *   GET    /v1/cloud/providers        → rclone's backend catalogue, trimmed
 *   GET    /v1/cloud/remotes          → { rclone: {version, configFile, encrypted}, remotes }
 *   POST   /v1/cloud/remotes          → 202 job (surgical INI write + gate)
 *   PUT    /v1/cloud/remotes/:name    → 202 job (type immutable)
 *   DELETE /v1/cloud/remotes/:name    → 202 job (409 while a task references it)
 *   POST   /v1/cloud/remotes/test     → 200 { verdict, message } (bounded lsjson, no job)
 *   GET    /v1/cloud/tasks            → the grid: task + LOCAL-ONLY systemd status
 *   POST   /v1/cloud/tasks            → 202 job (remote must exist; schedule validated)
 *   POST   /v1/cloud/tasks/preview    → 200 dry run on the LIVE source (no job, no notify)
 *   GET    /v1/cloud/tasks/:name      → detail: consistency, nested, unit+timer, journal
 *   PUT    /v1/cloud/tasks/:name      → 202 job (update / enable / disable)
 *   DELETE /v1/cloud/tasks/:name      → 202 job (units only; the remote is untouched)
 *   POST   /v1/cloud/tasks/:name/run  → 202 job (guards → snapshot → rclone → notify)
 *
 * Two stores, one prefix. REMOTES live in ANAS's own rclone.conf — the service
 * layer (rclone-config.ts) owns the file, the secrets and the gate. TASKS are
 * the systemd units themselves (cloud-units.ts) — no second config source and
 * no scheduler of ANAS's own; every derivation behind them is local (systemd +
 * journald + the mount table).
 *
 * These routes are the doors:
 * identity via {@link requireIdentity}, mutations as jobs
 * answering 202 with the job ref, refusals as the standard error envelope
 * (`{ error: { code, message } }` — the code is what the gateway's
 * cross-node classifier keys on, the message names the thing: the duplicate,
 * the encrypted file, the referencing tasks), and one 503 when the node has
 * no rclone at all.
 * Secret option values arrive in plain text on the write body and are never
 * echoed back — reads carry `secretsSet` only.
 */

/** The one "no rclone on this node" sentence — names the fix in one verb. */
export const RCLONE_NOT_INSTALLED
  = 'rclone is not installed on this node — re-run install.sh, which installs it'

/**
 * What cancelling a cloud sync run leaves behind — the confirm dialog's
 * consequence sentence, verbatim from the rclone.5 story.
 */
export const CLOUD_CANCEL_CONSEQUENCE = 'Files already copied stay at the destination. A sync run stopped '
  + 'part-way leaves the destination between two states until the next run completes.'

/**
 * The empty-path refusal for an SMB remote (cloudproof.1 finding 4, 0.4.1):
 * rclone's smb backend names the SHARE as the first path component, so an
 * empty path addresses the share LIST — and the Test door probes the remote
 * root, which cannot catch it. Only a real run would fail. The wizard carries
 * the same fact as a hint; the save refuses it outright.
 */
export const SMB_PATH_REQUIRED_ERROR
  = 'An SMB remote needs a path that starts with the share name (share/folder).'

/** The encrypted-config refusal (DESIGN: ANAS neither prompts nor stores the passphrase). */
const CONFIG_ENCRYPTED_ERROR = 'rclone\'s configuration file is password-protected; ANAS manages it only unencrypted'

/** The "rclone is missing" sentinel — the availability probe, or a spawn ENOENT. */
class RcloneNotInstalledError extends Error {
  constructor() {
    super(RCLONE_NOT_INSTALLED)
    this.name = 'RcloneNotInstalledError'
  }
}

/**
 * Default availability probe: is the whitelisted binary there and executable?
 * Stateless — asked fresh every time, never cached (Principle 11). The dev
 * mock overrides it (nothing is ever really spawned there), and the tests do
 * too (a test host may or may not carry /usr/bin/rclone).
 */
async function rcloneIsInstalled(): Promise<boolean> {
  try {
    await access(RCLONE, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

export interface CloudRouteOptions {
  executor: CommandExecutor
  jobQueue: JobQueue
  /** The rclone config store paths (`defaultRcloneConfigPaths()` in prod). */
  paths: RcloneConfigPaths
  /** Where the `anas-cloud-*` units live (the one systemd dir every store uses). */
  systemdDir?: string
  /** The fstab the run's source guard reads (Mounts' path; overridable for tests). */
  fstabPath?: string
  /** PVE storage.cfg for the consistency derivation (env/default when absent). */
  storagePath?: string
  /**
   * The cloud sync task names referencing `name` (the delete refusal's hard
   * 409 names them). Defaults to the REAL task store (rclone.2); the override
   * exists so a test can drive the refusal without writing unit files.
   */
  referencingTasks?: (name: string) => Promise<string[]>
  /**
   * Is the rclone binary present and executable? Defaults to a real
   * `access(X_OK)` probe. The dev mock overrides it to `true`, and tests
   * override it to `false` to prove the 503 door.
   */
  rcloneAvailable?: () => Promise<boolean>
}

export async function cloudRoutes(server: FastifyInstance, opts: CloudRouteOptions) {
  const { executor, jobQueue, paths } = opts
  const available = opts.rcloneAvailable ?? rcloneIsInstalled
  const systemdDir = opts.systemdDir ?? DEFAULT_SYSTEMD_DIR
  const fstabPath = opts.fstabPath ?? '/etc/fstab'
  // The real store answers the remotes DELETE refusal now that it exists
  // (rclone.1 shipped the hook against an empty store).
  const referencingTasks = opts.referencingTasks ?? (name => tasksReferencingRemote(systemdDir, name))

  /** Refuse before the call: the availability probe (no binary → the sentinel). */
  async function requireRclone(): Promise<void> {
    if (!(await available()))
      throw new RcloneNotInstalledError()
  }

  /**
   * The one OAuth-token normalisation at this boundary: a `token` option is
   * the pasted `rclone authorize` output, and the daemon accepts exactly the
   * text the dialog's field accepts — marker lines and one layer of quotes
   * stripped, a JSON object required ({@link OAUTH_TOKEN_ERROR} is the field's
   * own inline sentence). Empty stays empty (the dialog's "(unchanged)" and
   * the update route's keep-as-stored marker). Returns the options with the
   * normalised token in place — the value that reaches the file and the probe
   * — or null when the paste is not a JSON object and the door answers the
   * 400 instead of letting rclone fail with a Go unmarshal error. `token` is
   * secret only by the NAME rule (rclone does not type it IsPassword): the
   * obscure/secret handling is untouched.
   */
  function normalizeTokenOption(options: Record<string, string>): Record<string, string> | null {
    if (!Object.hasOwn(options, 'token'))
      return options
    const res = normalizeOAuthToken(options.token)
    if (!res.ok)
      return null
    return res.value === options.token ? options : { ...options, token: res.value }
  }

  /**
   * The 503 door every endpoint shares. A missing binary surfaces two ways:
   * the availability probe before the call (the test endpoint's `timeout`
   * wrapper would otherwise hide the spawn failure behind an exit 127), and
   * the executor's spawn ENOENT on a direct `rclone` exec (prod rejects on
   * ENOENT instead of returning an exit code — issue #6). Both become the
   * one install sentence, never Node's raw `spawn /usr/bin/rclone ENOENT`.
   */
  async function guard503<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    }
    catch (err) {
      if (err instanceof RcloneNotInstalledError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.code(503)
        await reply.send({ error: { code: 'UNAVAILABLE', message: RCLONE_NOT_INSTALLED } })
        return undefined
      }
      throw err
    }
  }

  /** Wrap a job body: a binary that vanished after the 202 fails the job with the sentence. */
  function rcloneJob<T>(fn: () => Promise<T>): Promise<T> {
    return (async () => {
      try {
        return await fn()
      }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          throw new Error(RCLONE_NOT_INSTALLED)
        throw err
      }
    })()
  }

  /** rclone's last non-empty output line (stderr first — its log lines live there). */
  function lastLine(result: { stdout: string, stderr: string, exitCode: number }): string {
    const lines = `${result.stderr}\n${result.stdout}`.split('\n').map(l => l.trim()).filter(l => l !== '')
    return lines.at(-1) ?? ''
  }

  /** The trimmed provider catalogue — `config providers`, read per request (no cache). */
  async function providers(): Promise<CloudProvider[]> {
    const result = await executor.exec(RCLONE, [...rcloneBaseArgs(paths.configFile), 'config', 'providers'])
    if (result.exitCode !== 0)
      throw new Error(`rclone config providers failed: ${lastLine(result) || `exit ${result.exitCode}`}`)
    return trimProviders(JSON.parse(result.stdout))
  }

  /**
   * The save-time own-OAuth-client guard (rclone.4 rider, human-pass finding
   * 2026-09-26): a non-empty `client_id` silently overrides rclone's built-in
   * client, and a refresh token issued by the built-in one can never be
   * refreshed under a made-up one — the Test verdict cannot catch it (it does
   * not refresh). The shared rule answers the sentence; the door answers 400
   * with it, before anything is written or probed.
   */
  function ownClientRefusal(backend: string, options: Record<string, string>): string | null {
    const verdict = validateOwnClient(backend, options)
    return verdict.ok ? null : verdict.message
  }

  /**
   * The encrypted-file refusal, the same sentence on every mutation door.
   * Sends and voids: a precheck that refuses has already replied, and the
   * `null` it returns is the "already refused" sentinel the handlers check —
   * a refusal object must never be mistaken for the precheck's data.
   */
  function refuseEncrypted(reply: FastifyReply): void {
    reply.code(409).send({ error: { code: 'CONFLICT', message: CONFIG_ENCRYPTED_ERROR } })
  }

  // --- GET /cloud/providers — the backend catalogue -------------------------
  server.get('/cloud/providers', async (request, reply) => {
    const data = await guard503(reply, providers)
    if (data === undefined)
      return undefined
    return { data }
  })

  // --- GET /cloud/remotes — the remotes of the node's own rclone.conf -------
  server.get('/cloud/remotes', async (request, reply) => {
    const data = await guard503(reply, async () => {
      const [version, provs] = await Promise.all([rcloneVersion(executor), providers()])
      // The providers ride along so `secretsSet` uses rclone's own IsPassword
      // fact, not the name rule alone.
      const read = await readConfig(paths, executor, provs)
      return {
        rclone: { version, configFile: paths.configFile, encrypted: read.encrypted },
        remotes: read.remotes,
      }
    })
    if (data === undefined)
      return undefined
    return { data }
  })

  // --- POST /cloud/remotes — add a remote (202 job) -------------------------
  server.post('/cloud/remotes', async (request, reply) => {
    const parsed = CloudRemoteWriteSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote: ${zodIssue(parsed.error)}` } }
    }
    const input = parsed.data
    const normalized = normalizeTokenOption(input.options)
    if (normalized === null) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: OAUTH_TOKEN_ERROR } }
    }
    input.options = normalized
    const ownClient = ownClientRefusal(input.type, input.options)
    if (ownClient !== null) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: ownClient } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const provs = await guard503(reply, async (): Promise<CloudProvider[] | null> => {
      await requireRclone()
      const catalog = await providers()
      const current = await readConfig(paths, executor, catalog)
      if (current.encrypted) {
        refuseEncrypted(reply)
        return null
      }
      if (current.remotes.some(r => r.name === input.name)) {
        reply.code(409).send({ error: { code: 'CONFLICT', message: `remote '${input.name}' already exists` } })
        return null
      }
      return catalog
    })
    if (provs === undefined || provs === null)
      return undefined

    const job = jobQueue.submit(
      'cloud.remote.create',
      { ...identity, params: { remote: input.name, type: input.type } },
      async () => rcloneJob(() => writeRemote(paths, executor, input, { providers: provs, mode: 'create' })),
    )
    reply.code(202)
    return { job }
  })

  // --- PUT /cloud/remotes/:name — update options (202 job) ------------------
  server.put<{ Params: { name: string } }>('/cloud/remotes/:name', async (request, reply) => {
    const nameParsed = CloudRemoteName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote name: ${zodIssue(nameParsed.error)}` } }
    }
    const name = nameParsed.data

    // Fastify parses a JSON primitive ("x") happily — it is not an object,
    // and `'type' in body` would throw on it. Treat it as no body at all: the
    // schema below answers the 400, naming the field it wanted.
    const body = typeof request.body === 'object' && request.body !== null
      ? request.body as Record<string, unknown>
      : {}
    if ('type' in body) {
      // Checked BEFORE the schema (zod would strip the key and the retype
      // would sail through as an options-only update).
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: 'type is immutable — create a new remote' } }
    }
    const parsed = CloudRemoteUpdateSchema.safeParse(body)
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote update: ${zodIssue(parsed.error)}` } }
    }
    const input = parsed.data
    const normalized = normalizeTokenOption(input.options)
    if (normalized === null) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: OAUTH_TOKEN_ERROR } }
    }
    input.options = normalized

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const precheck = await guard503(reply, async (): Promise<{ catalog: CloudProvider[], type: string } | null> => {
      await requireRclone()
      const catalog = await providers()
      const current = await readConfig(paths, executor, catalog)
      if (current.encrypted) {
        refuseEncrypted(reply)
        return null
      }
      const existing = current.remotes.find(r => r.name === name)
      if (!existing) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: `remote '${name}' does not exist` } })
        return null
      }
      // The update door judges the fields against the STORED backend's type.
      const ownClient = ownClientRefusal(existing.type, input.options)
      if (ownClient !== null) {
        reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: ownClient } })
        return null
      }
      return { catalog, type: existing.type }
    })
    if (precheck === undefined || precheck === null)
      return undefined

    // The write needs a CloudRemoteWrite: the name + the EXISTING type (the
    // service re-checks it under the lock — a drift cannot slip through).
    const write: CloudRemoteWrite = { name, type: precheck.type, options: input.options }
    const job = jobQueue.submit(
      'cloud.remote.update',
      { ...identity, params: { remote: name } },
      async () => rcloneJob(() => writeRemote(paths, executor, write, { providers: precheck.catalog, mode: 'update' })),
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /cloud/remotes/:name — remove the section (202 job) -----------
  server.delete<{ Params: { name: string } }>('/cloud/remotes/:name', async (request, reply) => {
    const nameParsed = CloudRemoteName.safeParse(request.params.name)
    if (!nameParsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid remote name: ${zodIssue(nameParsed.error)}` } }
    }
    const name = nameParsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const precheck = await guard503(reply, async (): Promise<boolean | null> => {
      await requireRclone()
      const current = await readConfig(paths, executor)
      if (current.encrypted) {
        refuseEncrypted(reply)
        return null
      }
      if (!current.remotes.some(r => r.name === name)) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: `remote '${name}' does not exist` } })
        return null
      }
      // The hard refusal (rclone.2 wires the real store behind the hook):
      // deleting a remote a task still names would strand the task's units.
      const refs = await referencingTasks(name)
      if (refs.length > 0) {
        reply.code(409).send({
          error: { code: 'CONFLICT', message: `remote '${name}' is used by cloud sync task(s): ${refs.join(', ')} — remove or retarget them first` },
        })
        return null
      }
      // The same refusal for remote-to-remote references (cloudproof.2
      // finding 4): deleting the remote a crypt/alias/union/… wrapper still
      // names strands the wrapper — every later use fails with rclone's
      // "didn't find section in config file".
      const wrappedBy = remotesReferencing(current.remotes, name)
      if (wrappedBy.length > 0) {
        reply.code(409).send({
          error: { code: 'CONFLICT', message: `remote '${name}' is referenced by remote(s): ${wrappedBy.join(', ')}. Remove them first. This refusal has no confirm bypass.` },
        })
        return null
      }
      return true
    })
    if (precheck === undefined || precheck === null)
      return undefined

    const job = jobQueue.submit(
      'cloud.remote.remove',
      { ...identity, params: { remote: name } },
      async () => rcloneJob(() => removeRemote(paths, executor, name).then(() => ({ removed: name }))),
    )
    reply.code(202)
    return { job }
  })

  // --- POST /cloud/remotes/test — bounded lsjson (200, no job) --------------
  server.post('/cloud/remotes/test', async (request, reply) => {
    const parsed = CloudRemoteTestRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid test request: ${zodIssue(parsed.error)}` } }
    }
    const req = parsed.data
    // The unsaved dialog's token paste is normalised here too — the probe is
    // served the same text the save would write.
    if (req.remote) {
      const normalized = normalizeTokenOption(req.remote.options)
      if (normalized === null) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: OAUTH_TOKEN_ERROR } }
      }
      req.remote.options = normalized
      const ownClient = ownClientRefusal(req.remote.type, req.remote.options)
      if (ownClient !== null) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: ownClient } }
      }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    const data = await guard503(reply, async () => {
      await requireRclone()
      // The catalogue is needed only for the UNSAVED target (it decides which
      // option values are password-typed and go in obscured on the env).
      const provs = req.remote ? await providers() : undefined
      let result: CloudRemoteTestResult
      try {
        result = await testRemote(executor, paths, { name: req.name, remote: req.remote }, { path: req.path, providers: provs })
      }
      catch (err) {
        // The config file does not carry the name — a local fact, the route's
        // 404 (never a verdict).
        if (err instanceof RemoteNotFoundError) {
          reply.code(404).send({ error: { code: 'NOT_FOUND', message: err.message } })
          return null
        }
        throw err
      }
      auditTest(identity, req, result)
      return result
    })
    if (data === undefined || data === null)
      return undefined
    return { data }
  })

  // =========================================================================
  //  Tasks (rclone.2) — the units ARE the store
  // =========================================================================

  /** Parse + validate a task name from the URL, replying 400 itself on failure. */
  function taskName(raw: string, reply: FastifyReply): string | null {
    const parsed = BackupName.safeParse(raw)
    if (parsed.success)
      return parsed.data
    reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid task name: ${zodIssue(parsed.error)}` } })
    return null
  }

  /**
   * The save-time checks a task must pass, in the order that makes the
   * refusal most useful: the remote has to exist (a task naming a remote the
   * file does not carry can only ever fail at run time), then the path has to
   * suit that remote's backend, then the schedule has to be one systemd will
   * accept — `systemd-analyze calendar` is the authority, never a regex of
   * ours. Replies itself and returns false on a refusal.
   */
  async function guardTask(task: CloudSyncTask, reply: FastifyReply): Promise<boolean> {
    const stored = await guard503(reply, async () => {
      await requireRclone()
      const current = await readConfig(paths, executor)
      if (current.encrypted) {
        refuseEncrypted(reply)
        return null
      }
      return current.remotes
    })
    if (stored === undefined || stored === null)
      return false
    const remote = stored.find(r => r.name === task.remote)
    if (!remote) {
      reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: `remote '${task.remote}' is not configured — add it under Remotes first`,
        },
      })
      return false
    }
    // An SMB remote's path IS the share name first (cloudproof.1 finding 4):
    // the empty remote root is the share list, and the Test door cannot see
    // the mistake. Refused at the save, with the share-name shape named.
    if (remote.type === 'smb' && task.path === '') {
      reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: SMB_PATH_REQUIRED_ERROR,
        },
      })
      return false
    }
    const schedule = effectiveSchedule(task)
    const valid = await validateSchedule(executor, schedule)
    if (!valid.ok) {
      reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Invalid schedule '${schedule}': ${valid.error}` },
      })
      return false
    }
    return true
  }

  // --- GET /cloud/tasks — the grid (LOCAL-ONLY status) ----------------------
  // Behind the same 503 door as every other cloud read. `install.sh` installs
  // rclone as a hard dependency, so a node without it has a broken install,
  // and the grid that fronts the whole feature must say the install sentence
  // rather than render an empty list as though nothing were configured.
  server.get('/cloud/tasks', async (request, reply) => {
    const data = await guard503(reply, async () => {
      await requireRclone()
      const tasks = await readAllTasks(systemdDir)
      return Promise.all(
        tasks.map(async (task): Promise<CloudSyncTaskView> => {
          const st = await deriveTaskStatus(executor, task)
          // rclone.3 human-pass finding 2: while the run actually executes,
          // the running DIRECT job's rclone stats text rides on the row — the
          // run outliving the Run-Now supervisor's ceiling keeps reading as
          // alive instead of a bare running pill. Absent otherwise.
          // rclone.5: the same lookup hands over the job's id, which is what
          // the toolbar's Cancel run targets.
          return {
            ...task,
            lastRunResult: st.lastRunResult,
            lastRunAt: st.lastRunAt,
            nextRunAt: st.nextRunAt,
            overdue: st.overdue,
            ...(st.runActive ? runningDirectJobFields(jobQueue, task.name) : {}),
            ...(st.lastRunNote ? { lastRunNote: st.lastRunNote } : {}),
          }
        }),
      )
    })
    if (data === undefined)
      return undefined
    return { data }
  })

  // --- POST /cloud/tasks — create ------------------------------------------
  server.post('/cloud/tasks', async (request, reply) => {
    const parsed = CloudSyncTaskRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid cloud sync task: ${zodIssue(parsed.error)}` } }
    }
    const task = parsed.data

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (await taskFileExists(systemdDir, task.name)) {
      reply.code(409)
      return { error: { code: 'CONFLICT', message: `Cloud sync task '${task.name}' already exists` } }
    }
    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'cloud.task.create',
      { ...identity, params: { task: task.name, remote: task.remote } },
      async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { created: task.name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /cloud/tasks/preview — the dry run (rclone.2 addendum) -----------
  // A USER-INITIATED READ, registered BEFORE any /cloud/tasks/:name door so
  // the literal segment is never read as a task name. 200 with rclone's own
  // counters — NO job (it mutates nothing), NO notification, no audit of its
  // own beyond the request log. The unmounted-mount guard refuses (400, the
  // run's sentence); the empty-source guard does NOT — a sync preview that
  // shows it would delete everything is the point.
  server.post('/cloud/tasks/preview', async (request, reply) => {
    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    // Fastify parses a JSON primitive ("x") happily — it is not an object,
    // and `'name' in body` would throw on it. Treat it as no body at all.
    const body = typeof request.body === 'object' && request.body !== null
      ? request.body as Record<string, unknown>
      : {}

    // The two arms of the shared request, parsed separately on purpose: a
    // union failure collapses to a root "Invalid input", and a 400 that cannot
    // name the field the operator mistyped is half an answer (the task doors'
    // refusals all name the thing).
    //
    // The INLINE arm wins whenever the body carries a `source`: a wizard that
    // previews its unsaved form while a task of that name is already saved
    // would otherwise be shown the SAVED task's numbers under the edits it is
    // looking at. The saved-task arm is `name` and nothing else.
    let task: CloudSyncTask | CloudSyncPreviewTask
    if ('name' in body && !('source' in body)) {
      const nameParsed = BackupName.safeParse(body.name)
      if (!nameParsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid preview request: name — ${zodIssue(nameParsed.error)}` } }
      }
      const stored = await readTask(systemdDir, nameParsed.data)
      if (!stored) {
        reply.code(404)
        return { error: { code: 'NOT_FOUND', message: `Cloud sync task '${nameParsed.data}' not found` } }
      }
      task = stored
    }
    else {
      const parsed = CloudSyncPreviewTaskSchema.safeParse(body)
      if (!parsed.success) {
        reply.code(400)
        return { error: { code: 'VALIDATION_ERROR', message: `Invalid preview request: ${zodIssue(parsed.error)}` } }
      }
      task = parsed.data
    }

    let data: CloudSyncPreviewResult | undefined
    try {
      data = await guard503(reply, async () => {
        await requireRclone()
        return previewCloudSync(executor, { task, paths, fstabPath })
      })
    }
    catch (err) {
      // ONLY a guard refusal: the unmounted mount, the missing source — the
      // run's own sentence, answered 400 at the door (the run throws it into
      // a job). Anything else is an internal fault and must reach Fastify's
      // 500; a broken executor dressed up as "invalid request" would send the
      // operator looking at their own input for a bug that is ours.
      if (!(err instanceof PreviewRefusal))
        throw err
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: err.message } }
    }
    if (data === undefined)
      return undefined
    return { data }
  })

  // --- GET /cloud/tasks/:name — detail --------------------------------------
  server.get<{ Params: { name: string } }>('/cloud/tasks/:name', async (request, reply) => {
    const name = taskName(request.params.name, reply)
    if (name === null)
      return reply

    const task = await readTask(systemdDir, name)
    if (!task) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Cloud sync task '${name}' not found` } }
    }

    const [st, units, journal, consistency, nested] = await Promise.all([
      deriveTaskStatus(executor, task),
      readUnitTexts(systemdDir, name),
      readRecentJournal(executor, name),
      // The DERIVED consistency, from the same facts the run will read. Both
      // probes fail open, so this never blanks the window.
      readConsistencyFacts(executor, readAhrPools, { ...(opts.storagePath ? { pveStorageCfg: opts.storagePath } : {}) })
        .then(facts => deriveConsistency(task.source, facts))
        .catch(() => undefined),
      // What a snapshot will NOT contain. Informational and fail-open.
      scanNestedFilesystems(executor, task.source, { includeNested: 'none' })
        .then(scan => scan.nested.map(n => n.path))
        .catch(() => [] as string[]),
    ])

    const detail: CloudSyncTaskDetail = {
      task: {
        ...task,
        lastRunResult: st.lastRunResult,
        lastRunAt: st.lastRunAt,
        nextRunAt: st.nextRunAt,
        overdue: st.overdue,
        ...(st.runActive ? runningDirectJobFields(jobQueue, name) : {}),
        ...(st.lastRunNote ? { lastRunNote: st.lastRunNote } : {}),
      },
      ...(consistency ? { consistency } : {}),
      ...(nested.length ? { nested } : {}),
      unit: units.unit,
      timer: units.timer,
      ...(journal ? { journal } : {}),
      // A disabled task's run history is garbage-collected by systemd; say so
      // on the one screen with room for the sentence.
      ...(st.lastRunResult === 'disabled' ? { statusNote: DISABLED_HISTORY_NOTE } : {}),
    }
    return { data: detail }
  })

  // --- PUT /cloud/tasks/:name — update / enable / disable -------------------
  server.put<{ Params: { name: string } }>('/cloud/tasks/:name', async (request, reply) => {
    const name = taskName(request.params.name, reply)
    if (name === null)
      return reply

    const parsed = CloudSyncTaskRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid cloud sync task: ${zodIssue(parsed.error)}` } }
    }
    const task = parsed.data
    if (task.name !== name) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Task name in body ('${task.name}') does not match URL ('${name}')` } }
    }

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Cloud sync task '${name}' not found` } }
    }
    if (!(await guardTask(task, reply)))
      return reply

    const job = jobQueue.submit(
      'cloud.task.update',
      { ...identity, params: { task: name, remote: task.remote } },
      async () => {
        await writeTaskUnits(executor, systemdDir, task)
        return { updated: name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- DELETE /cloud/tasks/:name — remove the units -------------------------
  // Nothing at the remote is touched: deleting a schedule is not deleting data.
  server.delete<{ Params: { name: string } }>('/cloud/tasks/:name', async (request, reply) => {
    const name = taskName(request.params.name, reply)
    if (name === null)
      return reply

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Cloud sync task '${name}' not found` } }
    }

    const job = jobQueue.submit(
      'cloud.task.remove',
      { ...identity, params: { task: name } },
      async () => {
        await removeTaskUnits(executor, systemdDir, name)
        return { removed: name }
      },
    )
    reply.code(202)
    return { job }
  })

  // --- POST /cloud/tasks/:name/run — Run Now --------------------------------
  // TWO paths, one endpoint (the recursion guard is the `direct` flag), exactly
  // as the backup run route works:
  //   • UI Run-Now (no `direct`): the job STARTS the task's own systemd unit and
  //     supervises it, so a manual run lands in systemd's last-result and the
  //     unit journal exactly like a scheduled one — one history.
  //   • The unit's OWN execution (`direct:true`, from the cloud-task runner the
  //     timer / `systemctl start` fires): runs rclone IN the daemon and NEVER
  //     re-enters systemctl.
  server.post<{ Params: { name: string } }>('/cloud/tasks/:name/run', async (request, reply) => {
    const name = taskName(request.params.name, reply)
    if (name === null)
      return reply

    const parsed = CloudSyncRunRequest.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: { code: 'VALIDATION_ERROR', message: `Invalid run request: ${zodIssue(parsed.error)}` } }
    }
    const direct = parsed.data.direct === true

    const identity = requireIdentity(request, reply)
    if (!identity)
      return

    if (!(await taskFileExists(systemdDir, name))) {
      reply.code(404)
      return { error: { code: 'NOT_FOUND', message: `Cloud sync task '${name}' not found` } }
    }

    // rclone.3 human-pass finding 1: a run already in flight refuses the door
    // with the run named — the supervising job a second click would submit
    // adds nothing but a "waiting" line in the job list. The supervision's own
    // attach behaviour stays (the timer-vs-manual race still needs it); this
    // gate is for the USER who can see the row. When the task's direct run is
    // executing, its live progress quotes in the sentence.
    if (!direct) {
      const run = await readRunActive(executor, name)
      if (run.active) {
        reply.code(409)
        return {
          error: {
            code: 'CONFLICT',
            message: runningRunConflictMessage(name, run, runningDirectJobProgress(jobQueue, name)),
          },
        }
      }
    }

    const job = jobQueue.submit(
      'cloud.task.run',
      { ...identity, params: { task: name, ...(direct ? { direct: true } : {}) } },
      async (updateProgress, ctx) => {
        if (!direct) {
          // The manual/UI path: run through the task's own unit and supervise it.
          return superviseRun(executor, name, { onProgress: updateProgress })
        }
        // rclone.5: the direct run is cancellable from its first line — the
        // hook SIGINTs the rclone child (the shared ladder in child-cancel.ts);
        // the transient snapshot is still destroyed in runCloudSync's finally.
        const cancel = new ChildCancel(ctx, 'rclone', {
          subject: `Cloud sync task '${name}'`,
          consequence: CLOUD_CANCEL_CONSEQUENCE,
        })
        // rclone.5 review: an accepted cancel ends the run at the NEXT
        // pre-flight boundary, not after it — the guard, the transient
        // snapshot and the exec each get one (the service takes them through
        // `checkCancel`; `assertRunNotCancelled` is the one shared check).
        const task = await readTask(systemdDir, name)
        if (!task)
          throw new Error(`Cloud sync task '${name}' not found`)

        // This branch is the ONE place every real run converges (a timer fire
        // and a UI Run Now both arrive here through the task's own unit), so it
        // is also the one place a run notification is emitted.
        const startedAt = Date.now()
        try {
          assertRunNotCancelled(cancel, 'the cadence gate')
          // Cadence gate: a biweekly task runs on a WEEKLY timer because
          // OnCalendar cannot say "every other week", so an off-week SCHEDULED
          // fire stops here as a first-class, visible skip. A Run Now is never
          // gated (explicit intent), and a skip NEVER notifies.
          const gate = await gateRun(executor, task)
          if (!gate.run) {
            updateProgress(`cloud sync task '${name}': ${gate.detail}`)
            return { status: BACKUP_SKIPPED_OFF_WEEK, reason: gate.detail }
          }
          if (gate.reason === 'heal' || gate.reason === 'no-record')
            updateProgress(`cloud sync task '${name}': ${gate.detail}`)

          const result = await runCloudSync(
            executor,
            {
              task,
              paths,
              fstabPath,
              ...(opts.storagePath ? { consistencyOptions: { pveStorageCfg: opts.storagePath } } : {}),
              onSpawn: cancel.onSpawn,
              checkCancel: next => assertRunNotCancelled(cancel, next),
              // rclone.6: the run's live detail rides on the job itself, beside
              // the text progress — `GET /v1/jobs/:id` carries both.
              onDetail: ctx.updateDetail,
            },
            updateProgress,
          )
          // A cancel never notifies (rclone.5): the operator stopped it and the
          // row says so. One journald line records that nothing was sent.
          if (cancel.requested())
            return logCancelledRun(name)
          // Best-effort by contract: notifyCloudRun never throws, so a broken
          // mail target cannot turn a good sync into a failed job.
          await notifyCloudRun(executor, { task, result, elapsedMs: Date.now() - startedAt })
          return result
        }
        catch (err) {
          // The boundary check's throw IS the cancellation, and so is a run
          // that had a child to be stopped (rclone.5 review): the queue's own
          // settle awaits the hook, so the verdict is `cancelled` whatever
          // microtask order the child's death arrived in.
          if (err instanceof JobCancelledError || (cancel.requested() && cancel.stoppedOnPurpose()))
            return logCancelledRun(name)
          const message = err instanceof Error ? err.message : String(err)
          await notifyCloudRun(executor, { task, error: message, elapsedMs: Date.now() - startedAt })
          // An accepted cancel with nothing that could take a signal (rclone.5
          // review): the child never spawned — the exec rejected before
          // anything ran — so the honest verdict is this failure, marked for
          // the queue to end the job `failed` with the cancel in the reason.
          if (cancel.requested())
            throw new JobFailedDespiteCancelError(message)
          throw err
        }
      },
    )
    reply.code(202)
    return { job }
  })

  /**
   * The one journald line a cancelled run leaves instead of a notification
   * (rclone.5). The queue ends the job `cancelled` whatever the body returns
   * once the cancel was accepted, so the value is only a placeholder.
   *
   * This is also the one place that knows both the task's unit name and that
   * the run ended cancelled, so it settles systemd's failed state here
   * (0.4.1): the runner exits 130 at its next poll, the unit does not declare
   * that a success, and without a `reset-failed` the unit sits in
   * `systemctl --failed` until the task's next run. DETACHED on purpose: the
   * unit cannot go terminal until THIS body returns — the runner learns of
   * the cancel by polling the job — so awaiting it would hold the job for the
   * whole settle ceiling.
   */
  function logCancelledRun(name: string): null {
    server.log.info(`cloud sync task '${name}' cancelled — no notification sent`)
    void clearCancelledRunFailedState(executor, name)
      .then((reset) => {
        if (reset)
          server.log.info(`cloud sync task '${name}': ${serviceUnitName(name)} left systemd's failed list after its cancelled run`)
      })
      .catch(() => undefined)
    return null
  }

  /**
   * Fire-and-forget audit job for a Test (journald record — the same shape
   * replication-remotes' auditTest carries). The params are the remote's NAME
   * or the dialog's TYPE, the path and the verdict — never an option value.
   */
  function auditTest(identity: NonNullable<ReturnType<typeof requireIdentity>>, req: CloudRemoteTestRequest, result: CloudRemoteTestResult): void {
    jobQueue.submit(
      'cloud.remote.test',
      { ...identity, params: { remote: req.name ?? req.remote?.type, path: req.path ?? '', verdict: result.verdict } },
      async () => ({ verdict: result.verdict }),
    )
  }
}
