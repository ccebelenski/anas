import type { CloudProvider, CloudRemoteTestRequest, CloudRemoteTestResult, CloudRemoteWrite } from '@anas/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CommandExecutor } from '../executor/types.js'
import type { JobQueue } from '../jobs/queue.js'
import type { RcloneConfigPaths } from '../services/rclone-config.js'
import { access, constants } from 'node:fs/promises'
import { CloudRemoteName, CloudRemoteTestRequest as CloudRemoteTestRequestSchema, CloudRemoteUpdate as CloudRemoteUpdateSchema, CloudRemoteWrite as CloudRemoteWriteSchema } from '@anas/shared'
import { RCLONE, rcloneBaseArgs, rcloneVersion, readConfig, RemoteNotFoundError, removeRemote, trimProviders, writeRemote } from '../services/rclone-config.js'
import { testRemote } from '../services/rclone-probe.js'
import { zodIssue } from '../validation.js'
import { requireIdentity } from './identity.js'

/**
 * Cloud sync — remotes (story rclone.1, DESIGN "Cloud sync — rclone").
 *
 *   GET    /v1/cloud/providers        → rclone's backend catalogue, trimmed
 *   GET    /v1/cloud/remotes          → { rclone: {version, configFile, encrypted}, remotes }
 *   POST   /v1/cloud/remotes          → 202 job (surgical INI write + gate)
 *   PUT    /v1/cloud/remotes/:name    → 202 job (type immutable)
 *   DELETE /v1/cloud/remotes/:name    → 202 job (409 while a task references it)
 *   POST   /v1/cloud/remotes/test     → 200 { verdict, message } (bounded lsjson, no job)
 *
 * The store is ANAS's OWN rclone.conf — the service layer (rclone-config.ts)
 * owns the file, the secrets and the gate; these routes are the doors:
 * identity via {@link requireIdentity}, mutations as quick audit jobs
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
  /**
   * The cloud sync task names referencing `name` (the delete refusal's hard
   * 409 names them). The task store lands in rclone.2, which wires this in;
   * the default (none) refuses nothing — rclone.1 ships the check against an
   * empty store.
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
  const referencingTasks = opts.referencingTasks ?? (async () => [] as string[])

  /** Refuse before the call: the availability probe (no binary → the sentinel). */
  async function requireRclone(): Promise<void> {
    if (!(await available()))
      throw new RcloneNotInstalledError()
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
