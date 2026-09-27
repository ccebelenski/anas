import type { CloudProvider, CloudRemotesResponse, Job, JobAccepted } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { listSections, parseRcloneConf } from '../../parsers/rclone-conf.js'
import { createServer } from '../../server.js'
import { OAUTH_TOKEN_ERROR, RCLONE, rcloneBaseArgs } from '../../services/rclone-config.js'
import { PROBE_REMOTE_NAME, probeArgs } from '../../services/rclone-probe.js'
import { cloudRoutes, RCLONE_NOT_INSTALLED } from '../cloud.js'

// The REAL 1.60.1 provider capture — the `config providers` fixture returns
// the raw bytes verbatim (the route trims them, like the real binary's output).
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone/providers-1.60.1.json')
const PROVIDERS_STDOUT = await readFile(FIXTURE, 'utf-8')

// The shared own-client vectors, read straight from the shared package — the
// three consumers (this suite, the shared unit test, the dialog-contracts
// harness) cannot drift.
const OWN_CLIENT_CASES: { name: string, backend: string, options: Record<string, string>, ok: boolean, message?: string }[] = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../../../shared/test-vectors/own-client.json'), 'utf-8'),
)

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/** A saved sftp remote exactly as ANAS would have written it. */
const GT_SECTION = '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = rclonegt\npass = mock-obscured\n'

/** The captured 1.60.1 failure line (auth bucket) — stderr verbatim. */
const AUTH_STDERR = '2026/09/23 22:25:27 Failed to create file system for "gt:": NewFs: couldn\'t connect SSH: '
  + 'ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain\n'
const UNREACHABLE_STDERR = '2026/09/23 22:26:19 Failed to create file system for "gt:": NewFs: couldn\'t connect SSH: '
  + 'dial tcp 192.0.2.1:22: i/o timeout\n'
const NOT_FOUND_STDERR = '2026/09/23 22:25:03 Failed to lsjson with 2 errors: last error was: error in ListJSON: directory not found\n'
const UNKNOWN_REMOTE_STDERR = '2026/09/23 22:26:39 Failed to create file system for "nosuch:": didn\'t find section in config file\n'

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer> | FastifyInstance, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** Make one command REJECT the way execFile does when its binary is missing (issue #6). */
function failToSpawn(server: ReturnType<typeof createServer>, command: string): void {
  const mock = mockOf(server)
  const orig = mock.exec.bind(mock)
  mock.exec = async (cmd: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
    if (cmd === command) {
      const err = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return orig(cmd, args, execOpts)
  }
}

/**
 * The rclone fixtures every cloud test runs against: the real provider
 * catalogue (the dialog's option facts), the version line, `obscure` — and
 * `config dump` DYNAMIC, re-parsing the file ANAS just wrote (the same
 * contract as the dev block in server.ts: the post-write gate behaves like
 * production, not like a canned answer).
 */
function installRcloneFixtures(mock: MockExecutor, configFile: string): void {
  mock.clearFixtures()
  const base = rcloneBaseArgs(configFile)
  mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1-DEV\n', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: RCLONE, args: [...base, 'config', 'providers'], result: { stdout: PROVIDERS_STDOUT, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: RCLONE, args: [...base, 'obscure', '-'], result: { stdout: 'mock-obscured\n', stderr: '', exitCode: 0 } })
  const orig = mock.exec.bind(mock)
  mock.exec = async (command, args, execOpts) => {
    if (command === RCLONE && args.at(-2) === 'config' && args.at(-1) === 'dump') {
      let text = ''
      try {
        text = await readFile(configFile, 'utf-8')
      }
      catch { /* absent file → no sections, like the real binary */ }
      const dump: Record<string, Record<string, string>> = {}
      for (const section of listSections(parseRcloneConf(text)))
        dump[section.name] = { ...section.values }
      return { stdout: JSON.stringify(dump), stderr: '', exitCode: 0 }
    }
    return orig(command, args, execOpts)
  }
}

describe('cloud remotes routes (rclone.1)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let configFile: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cloudroutes-'))
    configFile = join(dir, 'rclone.conf')
    setEnv('ANAS_RCLONE_CONFIG', configFile)
    server = createServer({ mock: true, logger: false })
    installRcloneFixtures(mockOf(server), configFile)
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  // --- GET /cloud/providers ---------------------------------------------------
  describe('GET /v1/cloud/providers', () => {
    it('returns the trimmed catalogue with the option facts intact', async () => {
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/providers', headers: IDENTITY })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: CloudProvider[] }
      const sftp = data.find(p => p.name === 'sftp')
      assert.ok(sftp, 'sftp in the catalogue')
      const pass = sftp!.options.find(o => o.name === 'pass')
      assert.deepEqual(
        { secret: pass!.secret, password: pass!.password },
        { secret: true, password: true },
        'sftp pass is secret AND password-typed (obscured in the file)',
      )
      const s3 = data.find(p => p.name === 's3')
      const secretKey = s3!.options.find(o => o.name === 'secret_access_key')
      assert.deepEqual(
        { secret: secretKey!.secret, password: secretKey!.password },
        { secret: true, password: false },
        's3 secret_access_key is secret by NAME but not password-typed (stored plain)',
      )
    })
  })

  // --- GET /cloud/remotes -----------------------------------------------------
  describe('GET /v1/cloud/remotes', () => {
    it('absent file → empty remotes, unencrypted, the version and config path', async () => {
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: IDENTITY })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: CloudRemotesResponse }
      assert.deepEqual(data, {
        rclone: { version: '1.60.1', configFile, encrypted: false },
        remotes: [],
      })
    })

    it('secrets never come back: the value stays in the file, only secretsSet names the key', async () => {
      await writeFile(configFile, GT_SECTION, 'utf-8')
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: IDENTITY })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: CloudRemotesResponse }
      assert.deepEqual(data.remotes, [{
        name: 'gt',
        type: 'sftp',
        options: { host: '127.0.0.1', user: 'rclonegt' },
        secretsSet: ['pass'],
      }])
      assert.ok(!res.payload.includes('mock-obscured'), 'no secret value in the body')
    })

    it('a password-protected file → encrypted fact, empty remotes', async () => {
      const mock = mockOf(server)
      const orig = mock.exec.bind(mock)
      mock.exec = async (command, args, execOpts) => {
        if (command === RCLONE && args.at(-2) === 'config' && args.at(-1) === 'dump')
          return { stdout: '', stderr: 'rclone: This configuration file is encrypted, please enter the password to decrypt it.\n', exitCode: 1 }
        return orig(command, args, execOpts)
      }
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: IDENTITY })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: CloudRemotesResponse }
      assert.equal(data.rclone.encrypted, true)
      assert.deepEqual(data.remotes, [])
    })
  })

  // --- POST /cloud/remotes ----------------------------------------------------
  describe('POST /v1/cloud/remotes', () => {
    it('create → 202 job; the file holds the OBSCURED value, the API only secretsSet', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          name: 'gt',
          type: 'sftp',
          options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' },
        }),
      })
      assert.equal(res.statusCode, 202)
      const { job } = res.json() as JobAccepted
      const done = await waitForJob(server, job.id)
      assert.equal(done.status, 'completed', done.error?.message)

      const text = await readFile(configFile, 'utf-8')
      assert.ok(text.includes('pass = mock-obscured'), 'the password-typed value went in obscured')
      assert.ok(!text.includes('gtpass'), 'the plain value never touched the file')
      const { mode } = await stat(configFile)
      assert.equal(mode & 0o777, 0o600, 'the file is 0600')

      const get = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: IDENTITY })
      const { data } = get.json() as { data: CloudRemotesResponse }
      assert.deepEqual(data.remotes, [{
        name: 'gt',
        type: 'sftp',
        options: { host: '127.0.0.1', user: 'rclonegt' },
        secretsSet: ['pass'],
      }])
      assert.ok(!get.payload.includes('gtpass'), 'no secret value in any response')
    })

    it('a duplicate name → 409, no job', async () => {
      await writeFile(configFile, GT_SECTION, 'utf-8')
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt', type: 'sftp', options: {} }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.match(res.json().error.message, /already exists/)
    })

    it('an encrypted file → 409 config-encrypted', async () => {
      const mock = mockOf(server)
      const orig = mock.exec.bind(mock)
      mock.exec = async (command, args, execOpts) => {
        if (command === RCLONE && args.at(-2) === 'config' && args.at(-1) === 'dump')
          return { stdout: '', stderr: 'rclone: This configuration file is encrypted, please enter the password to decrypt it.\n', exitCode: 1 }
        return orig(command, args, execOpts)
      }
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt', type: 'sftp', options: {} }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.match(res.json().error.message, /password-protected/)
    })

    it('no identity → 401; an invalid name → 400', async () => {
      const noId = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'gt', type: 'sftp', options: {} }),
      })
      assert.equal(noId.statusCode, 401)
      const badName = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'bad name', type: 'sftp', options: {} }),
      })
      assert.equal(badName.statusCode, 400)
    })
  })

  // --- PUT /cloud/remotes/:name ------------------------------------------------
  describe('PUT /v1/cloud/remotes/:name', () => {
    it('`type` in the body → 400, checked before the schema', async () => {
      await writeFile(configFile, GT_SECTION, 'utf-8')
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/cloud/remotes/gt',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ type: 's3', options: {} }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
      assert.match(res.json().error.message, /type is immutable/)
    })

    it('a JSON-primitive body ("x" — Fastify parses it) → 400, not a 500', async () => {
      await writeFile(configFile, GT_SECTION, 'utf-8')
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/cloud/remotes/gt',
        headers: JSON_HEADERS,
        payload: JSON.stringify('x'),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
      assert.match(res.json().error.message, /Invalid remote update/)
    })

    it('an options update → 202 job; the untouched obscured line keeps its exact spelling', async () => {
      await writeFile(configFile, GT_SECTION, 'utf-8')
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/cloud/remotes/gt',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ options: { host: '10.0.0.9' } }),
      })
      assert.equal(res.statusCode, 202)
      const { job } = res.json() as JobAccepted
      const done = await waitForJob(server, job.id)
      assert.equal(done.status, 'completed', done.error?.message)

      const text = await readFile(configFile, 'utf-8')
      assert.ok(text.includes('host = 10.0.0.9'))
      assert.ok(text.includes('pass = mock-obscured'), 'the obscured value was never read back, never rewritten')
    })

    it('a missing remote → 404', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/cloud/remotes/nosuch',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ options: {} }),
      })
      assert.equal(res.statusCode, 404)
    })
  })

  // --- DELETE /cloud/remotes/:name ---------------------------------------------
  describe('DELETE /v1/cloud/remotes/:name', () => {
    it('remove → 202 job; the section is gone', async () => {
      await writeFile(configFile, GT_SECTION, 'utf-8')
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY })
      assert.equal(res.statusCode, 202)
      const { job } = res.json() as JobAccepted
      const done = await waitForJob(server, job.id)
      assert.equal(done.status, 'completed', done.error?.message)
      const text = await readFile(configFile, 'utf-8')
      assert.ok(!text.includes('[gt]'))
    })

    it('a missing remote → 404', async () => {
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/nosuch', headers: IDENTITY })
      assert.equal(res.statusCode, 404)
    })

    it('a remote another remote wraps → 409 until the wrapper is removed first (cloudproof.2 finding 4)', async () => {
      await writeFile(configFile, `${GT_SECTION}
[gtcrypt]
type = crypt
remote = gt:crypt-base
password = mock-obscured
`, 'utf-8')
      const refused = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY })
      assert.equal(refused.statusCode, 409)
      assert.match(refused.json().error.message, /referenced by remote\(s\): gtcrypt/)

      // The wrapper removed first, the wrapped remote then deletes cleanly.
      const first = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gtcrypt', headers: IDENTITY })
      assert.equal(first.statusCode, 202)
      const doneFirst = await waitForJob(server, (first.json() as JobAccepted).job.id)
      assert.equal(doneFirst.status, 'completed', doneFirst.error?.message)
      const second = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY })
      assert.equal(second.statusCode, 202)
      const doneSecond = await waitForJob(server, (second.json() as JobAccepted).job.id)
      assert.equal(doneSecond.status, 'completed', doneSecond.error?.message)
      const text = await readFile(configFile, 'utf-8')
      assert.ok(!text.includes('[gt]') && !text.includes('[gtcrypt]'))
    })
  })

  // --- The OAuth token paste (human-pass finding 2026-09-25) -------------------
  // `rclone authorize` prints the marker lines around the JSON block, and a
  // paste of the whole output (or of the block wrapped in quotes) failed
  // inside rclone with a Go unmarshal error. Every door that accepts remote
  // options normalises the `token` option the same way the dialog's field
  // does, and refuses anything that is not a JSON object with the one
  // sentence — 400 at the door, never rclone's own error from inside the
  // write or the probe.
  describe('the OAuth token paste is normalised at every door', () => {
    const TOKEN = '{"access_token":"ya29.x","token_type":"Bearer","refresh_token":"1//rt","expiry":"2026-09-25T00:00:00Z"}'
    const MARKER_PASTE = `Paste the following into your remote machine --->\n${
      TOKEN}\n<---End paste`
    const QUOTED = `"${TOKEN.replace(/"/g, '\\"')}"`
    const DRIVE_SECTION = '[gd]\ntype = drive\nscope = drive\n'

    it('POST /cloud/remotes: a bad paste → 400 with the sentence, no job; a marker paste → the bare object written', async () => {
      const refused = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gd', type: 'drive', options: { token: 'gibberish' } }),
      })
      assert.equal(refused.statusCode, 400)
      assert.equal(refused.json().error.code, 'VALIDATION_ERROR')
      assert.equal(refused.json().error.message, OAUTH_TOKEN_ERROR)
      await assert.rejects(readFile(configFile, 'utf-8'), 'nothing was written')

      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gd', type: 'drive', options: { token: MARKER_PASTE } }),
      })
      assert.equal(res.statusCode, 202)
      const { job } = res.json() as JobAccepted
      const done = await waitForJob(server, job.id)
      assert.equal(done.status, 'completed', done.error?.message)
      const text = await readFile(configFile, 'utf-8')
      // `token` is secret only by the NAME rule — stored PLAIN, the marker
      // lines stripped, exactly the JSON block rclone authorize printed.
      assert.ok(text.includes(`token = ${TOKEN}\n`), text)
      assert.ok(!text.includes('Paste the following') && !text.includes('End paste'), text)
      const get = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: IDENTITY })
      assert.ok(get.payload.includes('"token"'), 'the API names the key (secretsSet), never the value')
      assert.ok(!get.payload.includes('ya29.x'), 'the token value is never returned')
    })

    it('PUT /cloud/remotes/:name: a bad paste → 400 with the sentence, no job; a quoted paste → the bare object written', async () => {
      await writeFile(configFile, DRIVE_SECTION, 'utf-8')
      const refused = await server.inject({
        method: 'PUT',
        url: '/v1/cloud/remotes/gd',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ options: { token: 'gibberish' } }),
      })
      assert.equal(refused.statusCode, 400)
      assert.equal(refused.json().error.message, OAUTH_TOKEN_ERROR)
      const untouched = await readFile(configFile, 'utf-8')
      assert.ok(!untouched.includes('token'), 'the refusal wrote nothing')

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/cloud/remotes/gd',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ options: { token: QUOTED } }),
      })
      assert.equal(res.statusCode, 202)
      const { job } = res.json() as JobAccepted
      const done = await waitForJob(server, job.id)
      assert.equal(done.status, 'completed', done.error?.message)
      const text = await readFile(configFile, 'utf-8')
      assert.ok(text.includes(`token = ${TOKEN}\n`), text)
      assert.ok(text.includes('scope = drive'), 'the untouched line survived')
    })

    it('POST /cloud/remotes/test: a bad paste → 400 with the sentence, no probe; a marker paste → the probe is served the bare object', async () => {
      mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '[]', stderr: '', exitCode: 0 } })
      const refused = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          remote: { name: 'draft', type: 'drive', options: { token: 'gibberish' } },
        }),
      })
      assert.equal(refused.statusCode, 400)
      assert.equal(refused.json().error.message, OAUTH_TOKEN_ERROR)
      assert.equal(mockOf(server).calls.some(c => c.command === '/usr/bin/timeout'), false, 'the refusal never reached the probe')

      const probeEnvs: (Record<string, string> | undefined)[] = []
      const mock = mockOf(server)
      const orig = mock.exec.bind(mock)
      mock.exec = async (command, args, execOpts) => {
        if (command === '/usr/bin/timeout')
          probeEnvs.push(execOpts?.env as Record<string, string> | undefined)
        return orig(command, args, execOpts)
      }
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          remote: { name: 'draft', type: 'drive', options: { token: MARKER_PASTE } },
        }),
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { data: { verdict: 'ok', message: '' } })
      const env = probeEnvs[0] ?? {}
      // The env-defined remote carries the NORMALISED text — the same bytes a
      // save would write.
      assert.equal(env.RCLONE_CONFIG_ANASTEST_TOKEN, TOKEN)
    })
  })

  // --- The own-OAuth-client fields (rclone.4 rider, human-pass finding) -------
  // A made-up `client_id` (the operator's remote carried the word `gdrive`)
  // silently overrides rclone's built-in client, and a refresh token issued
  // by the built-in one can never be refreshed under it — the Test verdict
  // cannot catch that. Every door that accepts remote options therefore runs
  // the SHARED rule (`validateOwnClient`), over the SAME vectors the UI port
  // is pinned to, answering 400 with the sentence before anything is written
  // or probed.
  describe('the own-OAuth-client fields are validated at every door', () => {
    /** The config file's text ('' when it was never written). */
    async function fileText(): Promise<string> {
      try {
        return await readFile(configFile, 'utf-8')
      }
      catch {
        return ''
      }
    }

    it('POST /cloud/remotes: a refusal vector → 400 with the sentence, nothing written; a valid vector → 202', async () => {
      for (const [i, c] of OWN_CLIENT_CASES.entries()) {
        const name = `oc${i}`
        const res = await server.inject({
          method: 'POST',
          url: '/v1/cloud/remotes',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ name, type: c.backend, options: c.options }),
        })
        if (!c.ok) {
          assert.equal(res.statusCode, 400, c.name)
          assert.equal(res.json().error.code, 'VALIDATION_ERROR')
          assert.equal(res.json().error.message, c.message, c.name)
          // Earlier valid vectors may have written their own sections — THIS
          // one must not be among them.
          assert.ok(!(await fileText()).includes(`[${name}]`), `the refusal wrote nothing (${c.name})`)
        }
        else {
          assert.equal(res.statusCode, 202, c.name)
        }
      }
    })

    it('PUT /cloud/remotes/:name: a refusal vector → 400 with the sentence, nothing written; a valid vector → 202', async () => {
      for (const [i, c] of OWN_CLIENT_CASES.entries()) {
        const name = `pu${i}`
        await writeFile(configFile, `[${name}]\ntype = ${c.backend}\n`, 'utf-8')
        const res = await server.inject({
          method: 'PUT',
          url: `/v1/cloud/remotes/${name}`,
          headers: JSON_HEADERS,
          payload: JSON.stringify({ options: c.options }),
        })
        if (!c.ok) {
          assert.equal(res.statusCode, 400, c.name)
          assert.equal(res.json().error.message, c.message, c.name)
          assert.ok(!(await fileText()).includes(`client_id =`), `the refusal wrote nothing (${c.name})`)
        }
        else {
          assert.equal(res.statusCode, 202, c.name)
        }
      }
    })

    it('POST /cloud/remotes/test: a refusal vector → 400 with the sentence, the probe never runs; a valid vector → 200', async () => {
      mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '[]', stderr: '', exitCode: 0 } })
      for (const c of OWN_CLIENT_CASES) {
        const res = await server.inject({
          method: 'POST',
          url: '/v1/cloud/remotes/test',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ remote: { name: 'draft', type: c.backend, options: c.options } }),
        })
        if (!c.ok) {
          assert.equal(res.statusCode, 400, c.name)
          assert.equal(res.json().error.message, c.message, c.name)
        }
        else {
          assert.equal(res.statusCode, 200, c.name)
        }
      }
      // The refusals never reached the probe: one probe call per VALID vector.
      assert.equal(
        mockOf(server).calls.filter(c => c.command === '/usr/bin/timeout').length,
        OWN_CLIENT_CASES.filter(c => c.ok).length,
      )
    })
  })

  // --- POST /cloud/remotes/test (the bounded lsjson probe) ---------------------
  describe('POST /v1/cloud/remotes/test', () => {
    it('a SAVED target → 200 ok, the exact timeout-wrapped argv, nothing else spawned', async () => {
      mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '[]', stderr: '', exitCode: 0 } })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt' }),
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { data: { verdict: 'ok', message: '' } })
      const calls = mockOf(server).calls
      const probe = calls.find(c => c.command === '/usr/bin/timeout')
      assert.deepEqual(probe?.args, probeArgs(configFile, 'gt:'))
      // Only the probe ran — no config write, no obscure (the file holds the values).
      assert.equal(calls.filter(c => c.command === '/usr/bin/timeout').length, 1)
      assert.ok(!calls.some(c => c.args.includes('obscure')))
    })

    it('a SAVED target with a path lists that path', async () => {
      mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '[]', stderr: '', exitCode: 0 } })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt', path: 'dst/sub' }),
      })
      assert.equal(res.statusCode, 200)
      const probe = mockOf(server).calls.find(c => c.command === '/usr/bin/timeout')
      assert.deepEqual(probe?.args, probeArgs(configFile, 'gt:dst/sub'))
    })

    it('an UNSAVED dialog → the password-typed value is obscured via stdin, then the env-defined remote is probed', async () => {
      mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '[]', stderr: '', exitCode: 0 } })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          remote: { name: 'draft', type: 'sftp', options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' } },
          path: 'dst',
        }),
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { data: { verdict: 'ok', message: '' } })

      const calls = mockOf(server).calls
      const obscure = calls.find(c => c.command === RCLONE && c.args.includes('obscure'))
      assert.ok(obscure, 'the password value went through `rclone obscure -`')
      assert.deepEqual(obscure?.args, [...rcloneBaseArgs(configFile), 'obscure', '-'])
      const probe = calls.find(c => c.command === '/usr/bin/timeout')
      // The listing runs against a PRIVATE copy of the store, never ANAS's own
      // file: rclone persists its sftp shell detection as an [anastest]
      // section into whatever --config it is handed (GT 2026-09-24), and an
      // unsaved dialog must leave no trace. The copy's directory is gone by
      // the time the response is out.
      const probeConfig = probe!.args[3]!
      assert.notEqual(probeConfig, configFile)
      assert.deepEqual(probe?.args, probeArgs(probeConfig, `${PROBE_REMOTE_NAME}:dst`))
      assert.equal(existsSync(dirname(probeConfig)), false, 'the probe\'s private temp directory is removed')
      for (const c of calls)
        assert.ok(!c.args.some(a => a.includes('gtpass')), 'the plain password is on no argv')
      // Nothing was written: the dialog is not saved by a Test.
      await assert.rejects(readFile(configFile, 'utf-8'))
    })

    it('the verdicts ride the response: auth, unreachable, not-found, error', async () => {
      const cases: { stderr: string, exitCode: number, verdict: string }[] = [
        { stderr: AUTH_STDERR, exitCode: 1, verdict: 'auth' },
        { stderr: UNREACHABLE_STDERR, exitCode: 1, verdict: 'unreachable' },
        { stderr: NOT_FOUND_STDERR, exitCode: 3, verdict: 'not-found' },
        { stderr: '2026/09/23 22:00:00 Failed: something new\n', exitCode: 1, verdict: 'error' },
      ]
      for (const c of cases) {
        const mock = mockOf(server)
        mock.clearFixtures()
        installRcloneFixtures(mock, configFile)
        mock.addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: c.stderr, exitCode: c.exitCode } })
        const res = await server.inject({
          method: 'POST',
          url: '/v1/cloud/remotes/test',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ name: 'gt' }),
        })
        assert.equal(res.statusCode, 200, `${c.verdict}: ${res.payload}`)
        const { data } = res.json() as { data: { verdict: string, message: string } }
        assert.equal(data.verdict, c.verdict)
        assert.equal(data.message, c.stderr.trimEnd().split('\n').at(-1), `${c.verdict}: one line, verbatim`)
      }
    })

    it('a name the config file does not carry → 404 (a local fact, not a verdict)', async () => {
      mockOf(server).addFixture({
        command: '/usr/bin/timeout',
        result: { stdout: '', stderr: UNKNOWN_REMOTE_STDERR, exitCode: 1 },
      })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'nosuch' }),
      })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
      assert.match(res.json().error.message, /nosuch/)
    })

    it('a timeout-wrapped run that never returns → the wrapper\'s 124 → unreachable', async () => {
      mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 124 } })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt' }),
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), { data: { verdict: 'unreachable', message: '' } })
    })

    it('neither name nor remote → 400; both → 400; no identity → 401', async () => {
      const neither = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: 'dst' }),
      })
      assert.equal(neither.statusCode, 400)
      const both = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt', remote: { name: 'd', type: 'sftp', options: {} } }),
      })
      assert.equal(both.statusCode, 400)
      const noId = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'gt' }),
      })
      assert.equal(noId.statusCode, 401)
    })

    it('a missing `timeout` binary → the ENOENT rides the same 503 install sentence', async () => {
      failToSpawn(server, '/usr/bin/timeout')
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt' }),
      })
      assert.equal(res.statusCode, 503)
      assert.equal(res.json().error.code, 'UNAVAILABLE')
      assert.equal(res.json().error.message, RCLONE_NOT_INSTALLED)
    })

    it('fires the audit job (the journald record) with the remote and the verdict', async () => {
      mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '[]', stderr: '', exitCode: 0 } })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gt' }),
      })
      assert.equal(res.statusCode, 200)
      const jobs = await server.inject({ method: 'GET', url: '/v1/jobs', headers: IDENTITY })
      const { data } = jobs.json() as { data: Job[] }
      assert.ok(data.some(j => j.operation === 'cloud.remote.test'), 'the audit job was submitted')
    })
  })

  // --- The 503 door + the delete refusal (routes wired directly) ----------------
  //
  // The dev-mock server always answers "rclone installed" (it never really
  // spawns anything), and server.ts does not wire the rclone.2 task store —
  // so the availability probe and the referencingTasks hook get their own
  // wiring, the share-identity "samba missing" pattern.
  describe('wired directly (no rclone / referenced remote)', () => {
    let app: FastifyInstance
    let executor: MockExecutor
    let bareDir: string
    let bareFile: string

    async function bare(opts: { rcloneAvailable?: () => Promise<boolean>, referencingTasks?: (name: string) => Promise<string[]> } = {}): Promise<void> {
      bareDir = await mkdtemp(join(tmpdir(), 'anas-cloudbare-'))
      bareFile = join(bareDir, 'rclone.conf')
      executor = new MockExecutor()
      installRcloneFixtures(executor, bareFile)
      app = Fastify({ logger: false })
      await app.register(cloudRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: new JobQueue(),
        paths: { configFile: bareFile },
        rcloneAvailable: opts.rcloneAvailable ?? (async () => true),
        ...(opts.referencingTasks ? { referencingTasks: opts.referencingTasks } : {}),
      })
    }

    afterEach(async () => {
      await app.close()
      if (bareDir)
        await rm(bareDir, { recursive: true, force: true })
    })

    it('the mutation, test and PREVIEW doors consult the availability probe → 503 with the install sentence', async () => {
      await bare({ rcloneAvailable: async () => false })
      for (const req of [
        { method: 'POST', url: '/v1/cloud/remotes/test', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'gt' }) },
        { method: 'POST', url: '/v1/cloud/remotes', headers: JSON_HEADERS, payload: JSON.stringify({ name: 'gt', type: 'sftp', options: {} }) },
        { method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY },
        // The dry-run preview is rclone's own binary too: a node without it
        // has a broken install, not a preview that quietly reports nothing.
        { method: 'POST', url: '/v1/cloud/tasks/preview', headers: JSON_HEADERS, payload: JSON.stringify({ source: '/tank/pictures', remote: 'gt' }) },
      ] as const) {
        const res = await app.inject(req)
        assert.equal(res.statusCode, 503, req.url)
        assert.equal(res.json().error.code, 'UNAVAILABLE', req.url)
        assert.equal(res.json().error.message, RCLONE_NOT_INSTALLED, req.url)
      }
    })

    it('the read doors reach the same 503 when the spawn ENOENTs (the real executor rejects)', async () => {
      await bare()
      const orig = executor.exec.bind(executor)
      executor.exec = async (cmd: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
        if (cmd === RCLONE) {
          const err = new Error(`spawn ${RCLONE} ENOENT`) as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
        return orig(cmd, args, execOpts)
      }
      for (const url of ['/v1/cloud/providers', '/v1/cloud/remotes']) {
        const res = await app.inject({ method: 'GET', url, headers: IDENTITY })
        assert.equal(res.statusCode, 503, url)
        assert.equal(res.json().error.code, 'UNAVAILABLE', url)
        assert.equal(res.json().error.message, RCLONE_NOT_INSTALLED, url)
      }
    })

    it('the tasks GRID read is behind the same door — a node without rclone has a broken install, not an empty list', async () => {
      await bare({ rcloneAvailable: async () => false })
      const res = await app.inject({ method: 'GET', url: '/v1/cloud/tasks', headers: IDENTITY })
      assert.equal(res.statusCode, 503)
      assert.equal(res.json().error.code, 'UNAVAILABLE')
      assert.equal(res.json().error.message, RCLONE_NOT_INSTALLED)
    })

    it('deleting a remote a task still names → 409 naming the task(s)', async () => {
      await bare({ referencingTasks: async name => (name === 'gt' ? ['nightly'] : []) })
      await writeFile(bareFile, GT_SECTION, 'utf-8')
      const res = await app.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.match(res.json().error.message, /nightly/)
    })

    it('deleting a remote another remote wraps → 409 naming the referencing remotes (cloudproof.2 finding 4)', async () => {
      await bare()
      await writeFile(bareFile, `${GT_SECTION}
[gtcrypt]
type = crypt
remote = gt:crypt-base
password = mock-obscured
`, 'utf-8')
      const res = await app.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: IDENTITY })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.match(res.json().error.message, /referenced by remote\(s\): gtcrypt/)
      assert.match(res.json().error.message, /Remove them first\. This refusal has no confirm bypass\./)
    })
  })
})
