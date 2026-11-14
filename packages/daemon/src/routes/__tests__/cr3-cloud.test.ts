import type { CloudSyncTaskDetail, Job, JobAccepted } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor as MockExecutorClass } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { listSections, parseRcloneConf } from '../../parsers/rclone-conf.js'
import { createServer } from '../../server.js'
import { passThroughRealpath } from '../../services/__tests__/cloud-realpath-passthrough.js'
import { HIDDEN_VALUE, RCLONE, rcloneBaseArgs } from '../../services/rclone-config.js'
import { cloudRoutes } from '../cloud.js'

/**
 * A READABLE mount table for every cloud test world (the cr3 backup hand-off):
 * the source guard refuses a source whose mount table could not be read, so a
 * world that answers no `findmnt` would refuse every run and preview. A
 * command-only fixture: a test's own exact `findmnt --json` fixture still wins.
 */
const READABLE_MOUNT_TABLE = JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }] })

/**
 * cr3 (the 2026-11-14 whole-project review), area `cloud`: the route-level
 * pins of the review's findings, each on the REAL `createServer` with the
 * identity headers a gateway-forwarded request carries.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone/providers-1.60.1.json')
const PROVIDERS_STDOUT = await readFile(FIXTURE, 'utf-8')
const TIMEOUT = '/usr/bin/timeout'

function headers(privileges: string) {
  return {
    'x-anas-user': privileges.includes('Sys.Modify') ? 'root@pam' : 'auditor@pve',
    'x-anas-user-uid': '0',
    'x-anas-privileges': privileges,
    'x-anas-request-id': randomUUID(),
    'content-type': 'application/json',
  }
}
const MODIFY = headers('Sys.Audit,Sys.Modify')
const AUDIT = headers('Sys.Audit')
const { 'content-type': _ct, ...MODIFY_NOBODY } = MODIFY
const { 'content-type': _cta, ...AUDIT_NOBODY } = AUDIT

type Server = ReturnType<typeof createServer>

function mockOf(server: Server): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: Server, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: MODIFY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** The real catalogue, `obscure`, and a `config dump` that re-parses the file (cloud-routes.test.ts's contract). */
function installRcloneFixtures(mock: MockExecutor, configFile: string): void {
  mock.clearFixtures()
  mock.addFixture({ command: '/usr/bin/findmnt', result: { stdout: READABLE_MOUNT_TABLE, stderr: '', exitCode: 0 } })
  passThroughRealpath(mock)
  const base = rcloneBaseArgs(configFile)
  mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1-DEV\n', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: RCLONE, args: [...base, 'config', 'providers'], result: { stdout: PROVIDERS_STDOUT, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: RCLONE, args: [...base, 'obscure', '-'], result: { stdout: 'mock-obscured\n', stderr: '', exitCode: 0 } })
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
    if (command === RCLONE && args.at(-2) === 'config' && args.at(-1) === 'dump') {
      let text = ''
      try {
        text = await readFile(configFile, 'utf-8')
      }
      catch { /* absent file: no sections */ }
      const dump: Record<string, Record<string, string>> = {}
      for (const section of listSections(parseRcloneConf(text)))
        dump[section.name] = { ...section.values }
      return { stdout: JSON.stringify(dump), stderr: '', exitCode: 0 }
    }
    return orig(command, args, execOpts)
  }
}

/** Record every probe child (`timeout ... rclone ... lsjson`) and answer it with an empty listing. */
function recordProbes(mock: MockExecutor): { args: string[], env?: Record<string, string> }[] {
  const seen: { args: string[], env?: Record<string, string> }[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
    if (command === TIMEOUT && args.includes('lsjson')) {
      seen.push({ args, ...(execOpts?.env ? { env: execOpts.env as Record<string, string> } : {}) })
      return { stdout: '[]', stderr: '', exitCode: 0 }
    }
    return orig(command, args, execOpts)
  }
  return seen
}

describe('cr3 cloud routes', () => {
  let server: Server
  let dir: string
  let configFile: string
  let savedEnv: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-cloud-'))
    configFile = join(dir, 'rclone.conf')
    savedEnv = process.env.ANAS_RCLONE_CONFIG
    process.env.ANAS_RCLONE_CONFIG = configFile
    server = createServer({ mock: true, logger: false })
    installRcloneFixtures(mockOf(server), configFile)
  })

  afterEach(async () => {
    await server.close()
    if (savedEnv === undefined)
      delete process.env.ANAS_RCLONE_CONFIG
    else process.env.ANAS_RCLONE_CONFIG = savedEnv
    await rm(dir, { recursive: true, force: true })
  })

  // --- CLOUD-C1 ---------------------------------------------------------------
  describe('CLOUD-C1: testing an UNSAVED remote needs Sys.Modify', () => {
    /** The review's probe body: an unsaved webdav remote whose option runs a command. */
    const UNSAVED = {
      remote: {
        name: 'x',
        type: 'webdav',
        options: { url: 'http://127.0.0.1:9/', bearer_token_command: '/usr/bin/touch /root/pwned' },
      },
    }

    it('Sys.Audit alone: 403 FORBIDDEN naming Sys.Modify, no job, no child', async () => {
      const probes = recordProbes(mockOf(server))
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: AUDIT, payload: JSON.stringify(UNSAVED) })
      assert.equal(res.statusCode, 403, res.body)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'FORBIDDEN')
      assert.match(error.message, /^Permission check failed \(\/, Sys\.Modify\): auditor@pve does not have it\./)
      assert.equal(probes.length, 0, 'no rclone child was spawned')
      const { data: jobs } = (await server.inject({ method: 'GET', url: '/v1/jobs', headers: MODIFY })).json() as { data: Job[] }
      assert.ok(Array.isArray(jobs))
      assert.ok(!jobs.some(j => j.operation === 'read.cloud.remote.test'), 'no Test job was queued')
    })

    it('Sys.Audit alone may still test a SAVED remote by name (a read job)', async () => {
      await writeFile(configFile, '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = u\npass = mock-obscured\n', 'utf-8')
      const probes = recordProbes(mockOf(server))
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: AUDIT, payload: JSON.stringify({ name: 'gt' }) })
      assert.equal(res.statusCode, 202, res.body)
      const { job } = res.json() as JobAccepted
      assert.equal(job.operation, 'read.cloud.remote.test')
      const done = await waitForJob(server, job.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.equal(probes.length, 1)
      assert.equal(probes[0]!.env, undefined, 'a saved remote carries no option on the env')
    })

    it('review (C1 depth): the unsaved Test is its own non-read job — a reader cannot cancel it; the saved arm stays the read job', async () => {
      const mock = mockOf(server)
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const orig = mock.exec.bind(mock)
      mock.exec = async (command: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
        if (command === TIMEOUT && args.includes('lsjson')) {
          await held
          return { stdout: '[]', stderr: '', exitCode: 0 }
        }
        return orig(command, args, execOpts)
      }
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: MODIFY, payload: JSON.stringify(UNSAVED) })
      assert.equal(res.statusCode, 202, res.body)
      const { job } = res.json() as JobAccepted
      assert.equal(job.operation, 'cloud.remote.test')
      for (let i = 0; i < 200 && (await server.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: MODIFY })).json().job.status !== 'running'; i++)
        await new Promise(r => setTimeout(r, 5))
      const byReader = await server.inject({ method: 'POST', url: `/v1/jobs/${job.id}/cancel`, headers: AUDIT_NOBODY })
      assert.equal(byReader.statusCode, 403, byReader.body)
      assert.match(byReader.body, /Sys\.Modify/)
      release()
      await waitForJob(server, job.id)
    })

    it('Sys.Modify: the unsaved Test runs as before (202, the options on the env)', async () => {
      const probes = recordProbes(mockOf(server))
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: MODIFY, payload: JSON.stringify(UNSAVED) })
      assert.equal(res.statusCode, 202, res.body)
      const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.equal(probes.length, 1)
      assert.equal(probes[0]!.env?.RCLONE_CONFIG_ANASTEST_TYPE, 'webdav')
    })
  })

  // --- CLOUD-H2 ---------------------------------------------------------------
  describe('CLOUD-H2: credential options the suffix rule missed are secrets', () => {
    // The review's probe: an sftp remote that authenticates with `key_pem`
    // ("Raw PEM-encoded private key", IsPassword false in the 1.60.1 capture).
    const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\\n-----END OPENSSH PRIVATE KEY-----'
    const SA = '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----MIIEv-----END PRIVATE KEY-----"}'

    it('GET /cloud/remotes on Sys.Audit names key_pem, service_account_credentials, authorization and headers as set, never their values', async () => {
      await writeFile(configFile, [
        '[box]',
        'type = sftp',
        'host = backup.example',
        'user = anas',
        `key_pem = ${PEM}`,
        '',
        '[gd]',
        'type = drive',
        `service_account_credentials = ${SA}`,
        '',
        '[ss]',
        'type = sugarsync',
        'authorization = https://api.sugarsync.com/authorization/SECRETTOKEN',
        '',
        '[dav]',
        'type = webdav',
        'url = https://dav.example',
        'headers = "Authorization","Bearer SECRETBEARER"',
        '',
      ].join('\n'), 'utf-8')
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: AUDIT })
      assert.equal(res.statusCode, 200, res.body)
      for (const leaked of ['OPENSSH PRIVATE KEY', 'MIIEv', 'SECRETTOKEN', 'SECRETBEARER'])
        assert.ok(!res.payload.includes(leaked), `the reply carries no '${leaked}'`)
      const remotes = (res.json() as { data: { remotes: { name: string, options: Record<string, string>, secretsSet: string[] }[] } }).data.remotes
      const by = (n: string) => remotes.find(r => r.name === n)!
      assert.deepEqual(by('box').secretsSet, ['key_pem'])
      assert.deepEqual(by('box').options, { host: 'backup.example', user: 'anas' })
      assert.deepEqual(by('gd').secretsSet, ['service_account_credentials'])
      assert.deepEqual(by('ss').secretsSet, ['authorization'])
      assert.deepEqual(by('dav').secretsSet, ['headers'])
      assert.deepEqual(by('dav').options, { url: 'https://dav.example' })
    })
  })

  // --- review of cr3, fix 4 ----------------------------------------------------
  describe('review fix 4: credentials inside readable values never reach a reader', () => {
    const CONF = [
      '[dav]',
      'type = webdav',
      'url = https://alice:SECRETURLPW5@dav.example.com/files',
      '',
      '[box]',
      'type = sftp',
      'host = h',
      'user = u',
      'set_env = PASSPHRASE=SECRETSETENV7',
      '',
      '[uni]',
      'type = union',
      'upstreams = :s3,secret_access_key=SECRETUPSTREAM8:bucket dav:x',
      '',
    ].join('\n')

    it('GET /cloud/remotes: the URL credential reads [secret], the inlined remote is HIDDEN whole; set_env is write-only', async () => {
      await writeFile(configFile, CONF, 'utf-8')
      const res = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: AUDIT })
      assert.equal(res.statusCode, 200, res.body)
      for (const leaked of ['SECRETURLPW5', 'SECRETSETENV7', 'SECRETUPSTREAM8'])
        assert.ok(!res.payload.includes(leaked), leaked)
      const remotes = (res.json() as { data: { remotes: { name: string, options: Record<string, string>, secretsSet: string[] }[] } }).data.remotes
      const by = (n: string) => remotes.find(r => r.name === n)!
      // Third review: the userinfo is ONE marker; a value with inline settings is hidden whole.
      assert.equal(by('dav').options.url, 'https://[secret]@dav.example.com/files')
      assert.deepEqual(by('box').secretsSet, ['set_env'])
      assert.equal(by('uni').options.upstreams, HIDDEN_VALUE)
    })

    it('a Test of the saved remote whose backend echoes its URL: the verdict carries [secret]', async () => {
      await writeFile(configFile, CONF, 'utf-8')
      const mock = mockOf(server)
      const orig = mock.exec.bind(mock)
      mock.exec = async (command: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
        if (command === TIMEOUT && args.includes('lsjson'))
          return { stdout: '', stderr: 'Failed to lsjson: 401 Unauthorized at https://alice:SECRETURLPW5@dav.example.com/files\n', exitCode: 1 }
        return orig(command, args, execOpts)
      }
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: AUDIT, payload: JSON.stringify({ name: 'dav' }) })
      const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
      const text = JSON.stringify(done)
      assert.ok(!text.includes('SECRETURLPW5'), text)
      assert.match(text, /https:\/\/\[secret\]@dav/)
    })

    it('an edit\'s Test with the redacted URL in the dialog probes with the STORED password (as the save would write it)', async () => {
      await writeFile(configFile, CONF, 'utf-8')
      const probes = recordProbes(mockOf(server))
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: MODIFY,
        payload: JSON.stringify({ remote: { name: 'dav', type: 'webdav', options: { url: 'https://[secret]@dav.example.com/files', vendor: 'other' } }, keepStoredSecrets: true }),
      })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(probes[0]!.env!.RCLONE_CONFIG_ANASTEST_URL, 'https://alice:SECRETURLPW5@dav.example.com/files')
    })

    it('third review: a view sent back with ANYTHING changed is refused AT THE DOOR (400, re-enter the whole value), nothing written', async () => {
      await writeFile(configFile, CONF, 'utf-8')
      for (const [name, options] of [
        ['dav', { url: 'https://[secret]@dav.example.com/moved' }],
        ['dav', { url: 'https://[secret]@other.example.com/' }],
        ['uni', { upstreams: `${HIDDEN_VALUE} gt:extra` }],
      ] as const) {
        const res = await server.inject({ method: 'PUT', url: `/v1/cloud/remotes/${name}`, headers: MODIFY, payload: JSON.stringify({ options }) })
        assert.equal(res.statusCode, 400, `${name}: ${res.body}`)
        assert.match(res.body, /re-enter the whole value of '(url|upstreams)'/)
      }
      assert.equal(await readFile(configFile, 'utf-8'), CONF, 'nothing written, the marker never')
    })

    it('third review: a hidden value sent back UNCHANGED is kept as stored (202, byte-identical)', async () => {
      await writeFile(configFile, CONF, 'utf-8')
      const res = await server.inject({ method: 'PUT', url: '/v1/cloud/remotes/uni', headers: MODIFY, payload: JSON.stringify({ options: { upstreams: HIDDEN_VALUE } }) })
      assert.equal(res.statusCode, 202, res.body)
      const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.match(await readFile(configFile, 'utf-8'), /upstreams = :s3,secret_access_key=SECRETUPSTREAM8:bucket dav:x/)
    })

    it('third review (6): a remote whose reference option is HIDDEN makes "is X referenced?" unknown — the delete of X is refused, naming it', async () => {
      await writeFile(configFile, `${CONF}\n[mys3]\ntype = s3\nprovider = AWS\n\n[ov]\ntype = alias\nremote = mys3,region=eu-west-1:bucket\n`, 'utf-8')
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/mys3', headers: MODIFY_NOBODY })
      assert.equal(res.statusCode, 409, res.body)
      assert.match(res.body, /whether remote 'mys3' is referenced cannot be told: remote 'ov' option 'remote'/)
      assert.match(await readFile(configFile, 'utf-8'), /\[mys3\]/)
    })

    it('second review (D1): the create/update JOB RESULT is redacted — GET /v1/jobs as Sys.Audit carries no credential', async () => {
      await writeFile(configFile, CONF, 'utf-8')
      // An update of another option: the result lists the remote's options — the stored URL among them.
      const res = await server.inject({ method: 'PUT', url: '/v1/cloud/remotes/dav', headers: MODIFY, payload: JSON.stringify({ options: { vendor: 'other' } }) })
      assert.equal(res.statusCode, 202, res.body)
      const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const created = await server.inject({ method: 'POST', url: '/v1/cloud/remotes', headers: MODIFY, payload: JSON.stringify({ name: 'web2', type: 'http', options: { url: 'https://carol:NEWPW9999@h.example/?sig=QSIG7777' } }) })
      assert.equal(created.statusCode, 202, created.body)
      await waitForJob(server, (created.json() as JobAccepted).job.id)
      const list = await server.inject({ method: 'GET', url: '/v1/jobs', headers: AUDIT })
      for (const leaked of ['SECRETURLPW5', 'NEWPW9999', 'QSIG7777'])
        assert.ok(!list.payload.includes(leaked), `${leaked} in GET /v1/jobs`)
      assert.match(list.payload, /https:\/\/\[secret\]@h\.example\/\?\[secret\]/)
    })

    it('second review (D5, 11): a CREATE carrying [secret] and a whitespace-only secret are refused at the door, nothing written', async () => {
      await writeFile(configFile, CONF, 'utf-8')
      const marked = await server.inject({ method: 'POST', url: '/v1/cloud/remotes', headers: MODIFY, payload: JSON.stringify({ name: 'web3', type: 'http', options: { url: 'https://u:[secret]@h/' } }) })
      assert.equal(marked.statusCode, 400, marked.body)
      assert.match(marked.body, /a new remote has no stored value to keep/)
      const blank = await server.inject({ method: 'POST', url: '/v1/cloud/remotes', headers: MODIFY, payload: JSON.stringify({ name: 'gd2', type: 'drive', options: { client_secret: '   ' } }) })
      assert.equal(blank.statusCode, 400, blank.body)
      assert.match(blank.body, /a secret of only whitespace is never a secret/)
      const blankPut = await server.inject({ method: 'PUT', url: '/v1/cloud/remotes/box', headers: MODIFY, payload: JSON.stringify({ options: { set_env: '  ' } }) })
      assert.equal(blankPut.statusCode, 400, blankPut.body)
      assert.equal(await readFile(configFile, 'utf-8'), CONF)
    })
  })

  // --- CLOUD-L12 --------------------------------------------------------------
  it('CLOUD-L12: a plain file rclone cannot parse (its echoed line says "password") is an error, not a password-protected empty list', async () => {
    await writeFile(configFile, '[a]\ntype = sftp\npassword = "unterminated\n', 'utf-8')
    const mock = mockOf(server)
    const orig = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
      if (command === RCLONE && args.at(-1) === 'dump')
        return { stdout: '', stderr: 'CRITICAL: Failed to load config file: could not parse line: password = "unterminated\n', exitCode: 1 }
      return orig(command, args, execOpts)
    }
    const res = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: AUDIT })
    assert.notEqual(res.statusCode, 200, res.body)
    assert.match(res.body, /rclone config dump failed/)
    const create = await server.inject({ method: 'POST', url: '/v1/cloud/remotes', headers: MODIFY, payload: JSON.stringify({ name: 'b', type: 'sftp', options: { host: 'h' } }) })
    assert.ok(!/password-protected/.test(create.body), create.body)
  })

  // --- CLOUD-M5 ---------------------------------------------------------------
  describe('CLOUD-M5: a remote with its own OAuth client can be edited', () => {
    const ID = '1234567890-abc123def456.apps.googleusercontent.com'
    beforeEach(async () => {
      await writeFile(configFile, `[gd]\ntype = drive\nclient_id = ${ID}\nclient_secret = GOCSPX-old\ntoken = {"access_token":"a"}\n`, 'utf-8')
    })

    async function put(options: Record<string, string>) {
      return server.inject({ method: 'PUT', url: '/v1/cloud/remotes/gd', headers: MODIFY, payload: JSON.stringify({ options }) })
    }

    it('rotating ONLY the client secret is accepted (the stored id makes the pair whole)', async () => {
      const res = await put({ client_secret: 'GOCSPX-new' })
      assert.equal(res.statusCode, 202, res.body)
      const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.match(await readFile(configFile, 'utf-8'), /client_secret = GOCSPX-new/)
    })

    it('re-pasting only the token keeps the stored pair', async () => {
      const res = await put({ token: '{"access_token":"b"}' })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
    })

    it('clearing the id while the secret stays stored is still refused (a lone secret breaks the refresh)', async () => {
      const res = await put({ client_id: '' })
      assert.equal(res.statusCode, 400, res.body)
      assert.match((res.json() as { error: { message: string } }).error.message, /must be set together/)
    })

    it('review fix 8: a whitespace-only client secret is refused, never written as the new secret', async () => {
      const before = await readFile(configFile, 'utf-8')
      const res = await put({ client_secret: '   ' })
      assert.equal(res.statusCode, 400, res.body)
      assert.equal(await readFile(configFile, 'utf-8'), before)
    })

    it('a malformed id is still refused by its shape', async () => {
      const res = await put({ client_id: 'gdrive' })
      assert.equal(res.statusCode, 400, res.body)
      assert.match((res.json() as { error: { message: string } }).error.message, /is not a Google OAuth client ID/)
    })
  })

  // --- cr3 ruling: null CLEARS a stored option, a secret included -------------
  describe('a remote PUT: null clears (a stored secret included), \'\' keeps a secret, the pair rule judges the result', () => {
    const ID = '1234567890-abc123def456.apps.googleusercontent.com'
    const DRIVE = `[gd]\ntype = drive\nclient_id = ${ID}\nclient_secret = GOCSPX-old\ntoken = {"access_token":"a"}\n`
    const SFTP = '[box]\ntype = sftp\nhost = h.example\nuser = u\npass = OBSCURED\n'

    async function put(name: string, options: Record<string, string | null>) {
      const res = await server.inject({ method: 'PUT', url: `/v1/cloud/remotes/${name}`, headers: MODIFY, payload: JSON.stringify({ options }) })
      if (res.statusCode === 202) {
        const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
        assert.equal(done.status, 'completed', JSON.stringify(done.error))
      }
      return res
    }

    it('clearing ONLY the client secret while the client id stays is refused with the pair sentence; nothing written', async () => {
      await writeFile(configFile, DRIVE, 'utf-8')
      const res = await put('gd', { client_secret: null })
      assert.equal(res.statusCode, 400, res.body)
      assert.match((res.json() as { error: { message: string } }).error.message, /^Client ID and client secret must be set together\.$/)
      assert.equal(await readFile(configFile, 'utf-8'), DRIVE)
    })

    it('clearing BOTH returns the remote to rclone\'s built-in client (the token is kept)', async () => {
      await writeFile(configFile, DRIVE, 'utf-8')
      const res = await put('gd', { client_id: null, client_secret: null })
      assert.equal(res.statusCode, 202, res.body)
      const text = await readFile(configFile, 'utf-8')
      assert.ok(!/client_id|client_secret/.test(text), text)
      assert.match(text, /token = \{"access_token":"a"\}/)
    })

    it('a stored sftp password: null removes it; \'\' keeps it (the dialog\'s "unchanged")', async () => {
      await writeFile(configFile, SFTP, 'utf-8')
      const kept = await put('box', { pass: '' })
      assert.equal(kept.statusCode, 202, kept.body)
      assert.match(await readFile(configFile, 'utf-8'), /pass = OBSCURED/)
      const cleared = await put('box', { pass: null })
      assert.equal(cleared.statusCode, 202, cleared.body)
      assert.ok(!/pass =/.test(await readFile(configFile, 'utf-8')))
      const list = (await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: AUDIT })).json() as { data: { remotes: { name: string, secretsSet: string[] }[] } }
      assert.deepEqual(list.data.remotes.find(r => r.name === 'box')!.secretsSet, [])
    })

    it('null on a non-secret removes it too; an option the backend does not know is refused', async () => {
      await writeFile(configFile, SFTP, 'utf-8')
      const res = await put('box', { user: null })
      assert.equal(res.statusCode, 202, res.body)
      assert.ok(!/user =/.test(await readFile(configFile, 'utf-8')))
      const bogus = await server.inject({ method: 'PUT', url: '/v1/cloud/remotes/box', headers: MODIFY, payload: JSON.stringify({ options: { nosuch: null } }) })
      assert.equal(bogus.statusCode, 202, bogus.body)
      const done = await waitForJob(server, (bogus.json() as JobAccepted).job.id)
      assert.equal(done.status, 'failed')
      assert.match(done.error?.message ?? '', /unknown option 'nosuch' for remote type 'sftp'/)
    })

    it('an edit\'s Test with a cleared secret runs without it (clearedSecrets is never filled)', async () => {
      await writeFile(configFile, '[s3e]\ntype = s3\nprovider = AWS\naccess_key_id = AKIA1\n\n[cr]\ntype = crypt\nremote = s3e:bucket\npassword = OBSCURED1\npassword2 = OBSCURED2\n', 'utf-8')
      const probes = recordProbes(mockOf(server))
      const res = await server.inject({
        method: 'POST',
        url: '/v1/cloud/remotes/test',
        headers: MODIFY,
        payload: JSON.stringify({ remote: { name: 'cr', type: 'crypt', options: { remote: 's3e:bucket' } }, keepStoredSecrets: true, clearedSecrets: ['password2'] }),
      })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const env = probes[0]!.env!
      assert.equal(env.RCLONE_CONFIG_ANASTEST_PASSWORD, 'OBSCURED1', 'the kept secret is filled')
      assert.equal(env.RCLONE_CONFIG_ANASTEST_PASSWORD2, undefined, 'the cleared one is not')
      const bad = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: MODIFY, payload: JSON.stringify({ remote: { name: 'cr', type: 'crypt', options: {} }, clearedSecrets: ['password2'] }) })
      assert.equal(bad.statusCode, 400, 'clearedSecrets only rides with keepStoredSecrets')
    })
  })

  // --- CLOUD-L11 --------------------------------------------------------------
  describe('CLOUD-L11: an edit\'s Test keeps the remote\'s other stored secrets', () => {
    const CRYPT = '[s3e]\ntype = s3\nprovider = AWS\naccess_key_id = AKIA1\nsecret_access_key = storedS3Secret\n\n'
      + '[cr]\ntype = crypt\nremote = s3e:bucket\npassword = OBSCURED1\npassword2 = OBSCURED2\n'
    beforeEach(async () => {
      await writeFile(configFile, CRYPT, 'utf-8')
    })

    async function test(body: unknown, hdrs = MODIFY) {
      return server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: hdrs, payload: JSON.stringify(body) })
    }

    it('a retyped crypt password rides obscured; the stored password2 rides AS STORED (already obscured)', async () => {
      const probes = recordProbes(mockOf(server))
      const res = await test({ remote: { name: 'cr', type: 'crypt', options: { remote: 's3e:bucket', password: 'typedpw' } }, keepStoredSecrets: true })
      assert.equal(res.statusCode, 202, res.body)
      const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const env = probes[0]!.env!
      assert.equal(env.RCLONE_CONFIG_ANASTEST_PASSWORD, 'mock-obscured', 'the typed value, obscured')
      assert.equal(env.RCLONE_CONFIG_ANASTEST_PASSWORD2, 'OBSCURED2', 'the stored value, not re-obscured')
      assert.equal(env.RCLONE_CONFIG_ANASTEST_REMOTE, 's3e:bucket')
    })

    it('an s3 key retyped beside the stored secret: the stored secret is kept, a cleared non-secret stays cleared', async () => {
      const probes = recordProbes(mockOf(server))
      const res = await test({ remote: { name: 's3e', type: 's3', options: { provider: 'AWS', access_key_id: 'AKIA2' } }, keepStoredSecrets: true })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const env = probes[0]!.env!
      assert.equal(env.RCLONE_CONFIG_ANASTEST_ACCESS_KEY_ID, 'AKIA2')
      assert.equal(env.RCLONE_CONFIG_ANASTEST_SECRET_ACCESS_KEY, 'storedS3Secret')
    })

    it('without keepStoredSecrets the dialog alone is tested, as before', async () => {
      const probes = recordProbes(mockOf(server))
      const res = await test({ remote: { name: 's3e', type: 's3', options: { provider: 'AWS', access_key_id: 'AKIA2' } } })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(probes[0]!.env!.RCLONE_CONFIG_ANASTEST_SECRET_ACCESS_KEY, undefined)
    })

    it('refusals: Sys.Audit (an unsaved arm), an unknown remote, another type, the name arm', async () => {
      const audit = await test({ remote: { name: 's3e', type: 's3', options: {} }, keepStoredSecrets: true }, AUDIT)
      assert.equal(audit.statusCode, 403)
      const missing = await test({ remote: { name: 'nosuch', type: 's3', options: {} }, keepStoredSecrets: true })
      assert.equal(missing.statusCode, 404, missing.body)
      const retyped = await test({ remote: { name: 's3e', type: 'b2', options: {} }, keepStoredSecrets: true })
      assert.equal(retyped.statusCode, 400, retyped.body)
      assert.match((retyped.json() as { error: { message: string } }).error.message, /saved as type 's3', not 'b2'/)
      const named = await test({ name: 's3e', keepStoredSecrets: true })
      assert.equal(named.statusCode, 400, named.body)
    })

    it('an edit\'s Test of a drive remote with its own client: the blank secret is the stored one (CLOUD-M5 at the Test door)', async () => {
      await writeFile(configFile, '[gd]\ntype = drive\nclient_id = 1234567890-abc123def456.apps.googleusercontent.com\nclient_secret = GOCSPX-old\n', 'utf-8')
      recordProbes(mockOf(server))
      const res = await test({ remote: { name: 'gd', type: 'drive', options: { client_id: '1234567890-abc123def456.apps.googleusercontent.com', token: '{"access_token":"b"}' } }, keepStoredSecrets: true })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
    })
  })
})

// ---------------------------------------------------------------------------
//  The task doors (a temp systemd dir; every systemd call is the mock's)
// ---------------------------------------------------------------------------

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const FINDMNT = '/usr/bin/findmnt'
const GT_SECTION = '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = rclonegt\npass = obscured\n'

describe('cr3 cloud task routes', () => {
  let server: Server
  let dir: string
  let systemdDir: string
  let configFile: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-cloudtasks-'))
    systemdDir = join(dir, 'systemd')
    await mkdir(systemdDir, { recursive: true })
    configFile = join(dir, 'rclone.conf')
    await writeFile(configFile, GT_SECTION, 'utf-8')
    setEnv('ANAS_RCLONE_CONFIG', configFile)
    setEnv('ANAS_SYSTEMD_DIR', systemdDir)
    const fstab = join(dir, 'fstab')
    await writeFile(fstab, 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
    setEnv('ANAS_FSTAB_PATH', fstab)
    startServer()
  })

  /** A server over the env as it stands now (createServer reads paths such as SMB_CONF_PATH once). */
  function startServer(): void {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    installRcloneFixtures(mock, configFile)
    mock.addFixture({ command: SYSTEMD_ANALYZE, result: { stdout: 'Normalized form: Tue *-*-* 02:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
  }

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else process.env[k] = v
    }
  })

  function taskBody(over: Record<string, unknown> = {}) {
    return { name: 'offsite', source: '/tank/pictures', remote: 'gt', path: 'pve1/pictures', schedule: 'Tue *-*-* 02:00:00', ...over }
  }

  async function createTask(over: Record<string, unknown> = {}): Promise<Job> {
    const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks', headers: MODIFY, payload: JSON.stringify(taskBody(over)) })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob(server, (res.json() as JobAccepted).job.id)
  }

  // --- CORE-L9 (operator ruling: build it) ------------------------------------
  describe('CORE-L9 (coordinator\'s decision on the second review): an INLINE preview needs Sys.Modify; a reader previews saved tasks', () => {
    let src: string

    beforeEach(async () => {
      src = join(dir, 'src')
      await mkdir(join(src, 'sub'), { recursive: true })
      mockOf(server).addFixture({ command: TIMEOUT, argsMatch: args => args.includes(RCLONE), result: { stdout: '', stderr: '', exitCode: 0 } })
    })

    async function preview(body: Record<string, unknown>, hdrs: Record<string, string>) {
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/preview', headers: hdrs, payload: JSON.stringify(body) })
      if (res.statusCode === 202)
        await waitForJob(server, (res.json() as JobAccepted).job.id)
      return res
    }
    const inline = (source: string) => ({ source, remote: 'gt', path: 'p', mode: 'sync', excludes: [] })

    it('Sys.Audit, ANY inline form (inside a share or not): 403 naming Sys.Modify, no job, no child', async () => {
      const res = await preview(inline(join(src, 'sub')), AUDIT)
      assert.equal(res.statusCode, 403, res.body)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'FORBIDDEN')
      assert.match(error.message, /^Permission check failed \(\/, Sys\.Modify\): auditor@pve does not have it\./)
      assert.match(error.message, /a cloud sync preview is of a saved task only/)
      const { data: jobs } = (await server.inject({ method: 'GET', url: '/v1/jobs', headers: MODIFY })).json() as { data: Job[] }
      assert.ok(!jobs.some(j => j.operation === 'cloud.task.preview' || j.operation === 'read.cloud.preview'))
      assert.ok(!mockOf(server).calls.some(c => c.command === TIMEOUT && c.args.includes(RCLONE)))
    })

    it('Sys.Modify: the inline preview is its own non-read job (cloud.task.preview) — and a reader cannot cancel it', async () => {
      const mock = mockOf(server)
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const orig = mock.exec.bind(mock)
      mock.exec = async (command: string, args: string[], execOpts?: ExecOptions): Promise<ExecResult> => {
        if (command === TIMEOUT && args.includes(RCLONE)) {
          await held
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        return orig(command, args, execOpts)
      }
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/preview', headers: MODIFY, payload: JSON.stringify(inline(join(src, 'sub'))) })
      assert.equal(res.statusCode, 202, res.body)
      const { job } = res.json() as JobAccepted
      assert.equal(job.operation, 'cloud.task.preview')
      for (let i = 0; i < 200 && (await server.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: MODIFY })).json().job.status !== 'running'; i++)
        await new Promise(r => setTimeout(r, 5))
      const byReader = await server.inject({ method: 'POST', url: `/v1/jobs/${job.id}/cancel`, headers: AUDIT_NOBODY })
      assert.equal(byReader.statusCode, 403, byReader.body)
      release()
      await waitForJob(server, job.id)
    })

    it('a SAVED task by name previews on Sys.Audit (the read job), whatever its source', async () => {
      const created = await createTask({ source: join(src, 'sub') })
      assert.equal(created.status, 'completed', JSON.stringify(created.error))
      const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/preview', headers: AUDIT, payload: JSON.stringify({ name: 'offsite' }) })
      assert.equal(res.statusCode, 202, res.body)
      assert.equal((res.json() as JobAccepted).job.operation, 'read.cloud.preview')
      await waitForJob(server, (res.json() as JobAccepted).job.id)
    })
  })

  // --- CLOUD-L10 ---------------------------------------------------------------
  describe('CLOUD-L10: PUT /cloud/tasks/:name keeps what the body omits; null clears', () => {
    async function put(body: Record<string, unknown>) {
      return server.inject({ method: 'PUT', url: '/v1/cloud/tasks/offsite', headers: MODIFY, payload: JSON.stringify(body) })
    }
    async function storedTask(): Promise<Record<string, unknown>> {
      const unit = await readFile(join(systemdDir, 'anas-cloud-offsite.service'), 'utf-8')
      return JSON.parse(/^# X-ANAS-Task=(.*)$/m.exec(unit)![1]!) as Record<string, unknown>
    }

    it('an omitted enabled/notify/mode/excludes/bwlimit keeps the stored value (a disabled task stays disabled)', async () => {
      const created = await createTask({ enabled: false, notify: 'on-failure', mode: 'sync', excludes: ['*.tmp'], bwlimit: '8M' })
      assert.equal(created.status, 'completed', JSON.stringify(created.error))
      const calls = mockOf(server).calls
      calls.length = 0
      const res = await put({ path: 'pve1/elsewhere' })
      assert.equal(res.statusCode, 202, res.body)
      const done = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const task = await storedTask()
      assert.equal(task.path, 'pve1/elsewhere')
      assert.equal(task.enabled, false)
      assert.equal(task.notify, 'on-failure')
      assert.equal(task.mode, 'sync')
      assert.deepEqual(task.excludes, ['*.tmp'])
      assert.equal(task.bwlimit, '8M')
      assert.ok(!calls.some(c => c.command === SYSTEMCTL && c.args.join(' ') === 'enable --now anas-cloud-offsite.timer'), 'the timer was not re-enabled')
    })

    it('null clears: bwlimit goes absent, excludes become none, enabled takes its default', async () => {
      await createTask({ enabled: false, excludes: ['*.tmp'], bwlimit: '8M' })
      const res = await put({ bwlimit: null, excludes: null, enabled: null })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const task = await storedTask()
      assert.equal(task.bwlimit, undefined)
      assert.deepEqual(task.excludes, [])
      assert.equal(task.enabled, true)
    })

    it('review fix 3+7: the edit dialog\'s cleared bandwidth limit (null) clears it; bwlimit \'\' on a PUT is a clear too, as on POST', async () => {
      const full = { name: 'offsite', source: '/tank/pictures', remote: 'gt', path: 'pve1/pictures', mode: 'sync', excludes: ['*.tmp'], notify: 'always', enabled: true, cadence: { kind: 'weekly', days: ['Tue'], time: '02:00' } }
      await createTask({ ...full, bwlimit: '8M' })
      const dialog = await put({ ...full, bwlimit: null })
      assert.equal(dialog.statusCode, 202, dialog.body)
      await waitForJob(server, (dialog.json() as JobAccepted).job.id)
      assert.equal((await storedTask()).bwlimit, undefined)
      await put({ bwlimit: '4M' }).then(r => waitForJob(server, (r.json() as JobAccepted).job.id))
      assert.equal((await storedTask()).bwlimit, '4M')
      const empty = await put({ ...full, bwlimit: '' })
      assert.equal(empty.statusCode, 202, empty.body)
      await waitForJob(server, (empty.json() as JobAccepted).job.id)
      assert.equal((await storedTask()).bwlimit, undefined)
    })

    it('a raw schedule alone replaces the stored cadence (schedule and cadence are one decision)', async () => {
      await createTask({ cadence: { kind: 'weekly', days: ['Tue'], time: '02:00' } })
      assert.ok((await storedTask()).cadence, 'the task starts with a cadence')
      const res = await put({ schedule: 'Wed *-*-* 03:00:00' })
      assert.equal(res.statusCode, 202, res.body)
      await waitForJob(server, (res.json() as JobAccepted).job.id)
      const task = await storedTask()
      assert.equal(task.schedule, 'Wed *-*-* 03:00:00')
      assert.equal(task.cadence, undefined)
    })

    it('a malformed field is still a 400 before anything is read; a name mismatch too; a required field cannot be cleared', async () => {
      await createTask()
      const bad = await put({ mode: 'bogus' })
      assert.equal(bad.statusCode, 400, bad.body)
      const mismatch = await put({ name: 'other' })
      assert.equal(mismatch.statusCode, 400)
      assert.match((mismatch.json() as { error: { message: string } }).error.message, /does not match URL/)
      const cleared = await put({ source: null })
      assert.equal(cleared.statusCode, 400, cleared.body)
    })
  })

  // --- CLOUD-L8 ----------------------------------------------------------------
  describe('CLOUD-L8: which tasks use a remote is never guessed as "none"', () => {
    /** A task unit a hand edit (or an older ANAS) left unparseable. */
    async function brokenUnit() {
      await writeFile(join(systemdDir, 'anas-cloud-legacy.service'), '[Unit]\n# X-ANAS-Task={not json\n[Service]\nExecStart=/bin/true\n', 'utf-8')
    }

    it('DELETE of a remote: an unparseable task unit refuses 503 naming the unit, nothing removed', async () => {
      await brokenUnit()
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: MODIFY_NOBODY })
      assert.equal(res.statusCode, 503, res.body)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'UNAVAILABLE')
      assert.match(error.message, /anas-cloud-legacy\.service could not be parsed, so whether its task uses remote 'gt' is unknown/)
      assert.equal(await readFile(configFile, 'utf-8'), GT_SECTION)
    })

    it('PUT re-pointing a remote: the same refusal instead of skipping the confirm', async () => {
      await brokenUnit()
      const res = await server.inject({ method: 'PUT', url: '/v1/cloud/remotes/gt', headers: MODIFY, payload: JSON.stringify({ options: { host: '10.0.0.99' } }) })
      assert.equal(res.statusCode, 503, res.body)
      assert.equal(await readFile(configFile, 'utf-8'), GT_SECTION)
    })

    it('an unreadable unit directory refuses too', async () => {
      await rm(systemdDir, { recursive: true, force: true })
      await writeFile(systemdDir, 'not a directory', 'utf-8')
      const res = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: MODIFY_NOBODY })
      assert.equal(res.statusCode, 503, res.body)
      assert.match((res.json() as { error: { message: string } }).error.message, /could not be listed/)
    })

    it('a readable store still answers: a task naming the remote is the 409, none is the 202', async () => {
      const created = await createTask()
      assert.equal(created.status, 'completed', JSON.stringify(created.error))
      const refused = await server.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: MODIFY_NOBODY })
      assert.equal(refused.statusCode, 409, refused.body)
      assert.match((refused.json() as { error: { message: string } }).error.message, /used by cloud sync task\(s\): offsite/)
    })
  })

  // --- CLOUD-M4 (the detail door) ---------------------------------------------
  it('CLOUD-M4: the task detail derives consistency on the REAL path of a symlinked source', async () => {
    const share = join(dir, 'share')
    const other = join(dir, 'other')
    const link = join(share, 'link')
    await mkdir(join(other, 'photos'), { recursive: true })
    await mkdir(share, { recursive: true })
    await symlink(join(other, 'photos'), link)
    const mock = mockOf(server)
    mock.addFixture({
      command: FINDMNT,
      args: ['--json'],
      result: {
        stdout: JSON.stringify({ filesystems: [
          { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
          { target: share, source: 'tank/share', fstype: 'zfs', options: 'rw' },
          { target: other, source: 'tank/other', fstype: 'zfs', options: 'rw' },
        ] }),
        stderr: '',
        exitCode: 0,
      },
    })
    mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', '/usr/bin/realpath', '-e', '--', link], result: { stdout: `${join(other, 'photos')}\n`, stderr: '', exitCode: 0 } })
    const created = await createTask({ source: link })
    assert.equal(created.status, 'completed', JSON.stringify(created.error))
    const res = await server.inject({ method: 'GET', url: '/v1/cloud/tasks/offsite', headers: AUDIT })
    assert.equal(res.statusCode, 200, res.body)
    const detail = (res.json() as { data: CloudSyncTaskDetail }).data
    assert.equal(detail.consistency?.target, 'tank/other')
    assert.equal(detail.consistency?.relativePath, 'photos')
    assert.ok(detail.consistency?.reason.startsWith(`${link} is on the ZFS dataset tank/other`), detail.consistency?.reason)
  })
})

// ---------------------------------------------------------------------------
//  CLOUD-L9 — the remote delete is bound to the remote it read
// ---------------------------------------------------------------------------

describe('cr3 CLOUD-L9: a remote DELETE removes only the remote the route read', () => {
  let app: FastifyInstance
  let queue: JobQueue
  let bareDir: string
  let bareFile: string

  beforeEach(async () => {
    bareDir = await mkdtemp(join(tmpdir(), 'anas-cr3-cloudbare-'))
    bareFile = join(bareDir, 'rclone.conf')
    const executor = new MockExecutorClass()
    installRcloneFixtures(executor, bareFile)
    app = Fastify({ logger: false })
    queue = new JobQueue({ concurrency: 1 })
    await app.register(cloudRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: queue,
      paths: { configFile: bareFile },
      rcloneAvailable: async () => true,
      referencingTasks: async () => [],
    })
  })

  afterEach(async () => {
    await app.close()
    await rm(bareDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue.get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('job did not finish')
  }

  function holdTheQueue(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    queue.submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  const del = () => app.inject({ method: 'DELETE', url: '/v1/cloud/remotes/gt', headers: MODIFY_NOBODY })

  it('the remote RE-CREATED (another host) while the delete waited is not removed: IDENTITY_MISMATCH', async () => {
    await writeFile(bareFile, '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = a\n', 'utf-8')
    const release = holdTheQueue()
    const accepted = await del()
    assert.equal(accepted.statusCode, 202, accepted.payload)
    const recreated = '[gt]\ntype = sftp\nhost = 10.0.0.99\nuser = b\n'
    await writeFile(bareFile, recreated, 'utf-8')
    release()
    const job = await finished((accepted.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error!.code, 'IDENTITY_MISMATCH')
    assert.equal(await readFile(bareFile, 'utf-8'), recreated, 'the new remote is still there')
  })

  it('the remote unchanged while it waited: the delete completes', async () => {
    await writeFile(bareFile, '[gt]\ntype = sftp\nhost = 127.0.0.1\nuser = a\n', 'utf-8')
    const accepted = await del()
    assert.equal(accepted.statusCode, 202, accepted.payload)
    const job = await finished((accepted.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(!(await readFile(bareFile, 'utf-8')).includes('[gt]'))
  })
})
