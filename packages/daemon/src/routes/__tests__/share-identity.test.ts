import type { Job, JobAccepted, ShareGroup, ShareUser } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { IdentityName } from '@anas/shared'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer } from '../../server.js'
import { shareIdentityRoutes } from '../share-identity.js'

interface Call { command: string, args: string[] }

/**
 * Wrap the mock executor to record every command/args issued (delegating to the
 * original for results), so a test can assert the exact usermod argv the route
 * constructs — the fixed dev fixtures return canned results but don't expose the
 * arguments.
 */
function recordCalls(server: ReturnType<typeof createServer>): Call[] {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  const calls: Call[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return orig(command, args)
  }
  return calls
}

function find(calls: Call[], command: string, pred: (a: string[]) => boolean): string[] | undefined {
  return calls.find(c => c.command === command && pred(c.args))?.args
}

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** The decorated MockExecutor, for adding per-test fixtures. */
function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

/**
 * Make one command REJECT the way execFile does when its binary is missing —
 * the mock's fixtures only ever resolve, so a "samba isn't installed" node
 * cannot be reproduced with fixtures alone (issue #6).
 */
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

describe('share-identity routes', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // --- GET /identity/users ------------------------------------------------
  describe('GET /v1/identity/users', () => {
    it('returns enriched ShareUsers, filtered to share-relevant accounts', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/users' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareUser[] }
      const names = data.map(u => u.name).sort()
      assert.deepEqual(names, ['backup-svc', 'media', 'root'])

      const media = data.find(u => u.name === 'media')!
      assert.equal(media.uid, 1000)
      assert.equal(media.fullName, 'Media User')
      assert.equal(media.primaryGroup, 'media')
      assert.deepEqual(media.groups, ['media', 'smbusers'])
      assert.equal(media.smbEnabled, true)
      assert.equal(media.local, true)
      assert.equal(media.locked, false)
    })

    it('marks an expired account as locked and a non-SMB user as smbEnabled=false', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/users' })
      const { data } = res.json() as { data: ShareUser[] }
      const backup = data.find(u => u.name === 'backup-svc')!
      assert.equal(backup.locked, true)
      assert.equal(backup.smbEnabled, false)
    })
  })

  // --- GET /identity/groups -----------------------------------------------
  describe('GET /v1/identity/groups', () => {
    it('returns enriched ShareGroups with members and the local flag', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/groups' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareGroup[] }
      const names = data.map(g => g.name).sort()
      assert.deepEqual(names, ['media', 'root', 'smbusers'])
      const smb = data.find(g => g.name === 'smbusers')!
      assert.deepEqual(smb.members, ['media', 'backup-svc'])
      assert.equal(smb.local, true)
    })
  })

  // --- GET /identity/users/:name ------------------------------------------
  describe('GET /v1/identity/users/:name', () => {
    it('returns a single ShareUser', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/users/media' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareUser }
      assert.equal(data.name, 'media')
      assert.equal(data.smbEnabled, true)
    })

    it('returns 404 when getent does not resolve the user', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/users/ghost' })
      assert.equal(res.statusCode, 404)
      assert.equal(res.json().error.code, 'NOT_FOUND')
    })

    it('resolves a directory name with a dot and uppercase (not the strict POSIX regex)', async () => {
      // A directory user like `John.Doe` appears in the getent-backed list yet
      // the old strict IdentityName param regex 400'd it. LookupName allows it.
      server = createServer({ mock: true, logger: false })
      mockOf(server).addFixture({
        command: '/usr/bin/getent',
        args: ['passwd', 'John.Doe'],
        result: { stdout: 'John.Doe:*:6000:6000:John Doe:/home/John.Doe:/usr/sbin/nologin\n', stderr: '', exitCode: 0 },
      })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/users/John.Doe' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareUser }
      assert.equal(data.name, 'John.Doe')
      assert.equal(data.uid, 6000)
    })

    it('still rejects an option-injection path param (leading dash)', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/users/-rf' })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })
  })

  // --- POST /identity/users -----------------------------------------------
  describe('POST /v1/identity/users', () => {
    it('creates a share user (useradd) and completes', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'alice', fullName: 'Alice Example', groups: ['smbusers'] }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'identity.user.add')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
    })

    // Create WITH an SMB password is covered in the identity.3 section below,
    // on a mock whose passdb and getent answers follow the create (the dev
    // mock's static fixtures cannot show a new user's entry).

    it('returns 409 when the user already exists', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'media' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('returns 400 when a referenced group does not exist', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'carol', groups: ['nosuchgroup'] }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })

    it('rejects an invalid POSIX name', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'Bad Name!' }),
      })
      assert.equal(res.statusCode, 400)
    })

    it('rejects requests without identity headers', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'dave' }),
      })
      assert.equal(res.statusCode, 401)
    })
  })

  // --- POST /identity/users/:name/smb-password ----------------------------
  describe('POST /v1/identity/users/:name/smb-password', () => {
    it('sets an SMB password on a local user', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users/media/smb-password',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ password: 's3cret' }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'identity.smbpasswd.set')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
    })

    it('returns 404 for an unknown user', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users/ghost/smb-password',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ password: 's3cret' }),
      })
      assert.equal(res.statusCode, 404)
    })

    it('returns 409 for a directory-provided (non-local) user', async () => {
      server = createServer({ mock: true, logger: false })
      // A user that resolves via getent but is NOT in the local files DB.
      mockOf(server).addFixture({ command: '/usr/bin/getent', args: ['passwd', 'aduser'], result: { stdout: 'aduser:*:5000:5000:AD User:/home/aduser:/usr/sbin/nologin\n', stderr: '', exitCode: 0 } })
      mockOf(server).addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'aduser'], result: { stdout: '', stderr: '', exitCode: 2 } })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users/aduser/smb-password',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ password: 's3cret' }),
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFLICT')
    })
  })

  // --- PUT /identity/users/:name (enable/disable) -------------------------
  describe('PUT /v1/identity/users/:name', () => {
    it('disables a user (usermod --expiredate 1 + smbpasswd -d) and completes', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = recordCalls(server)
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/identity/users/media',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ enabled: false }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'identity.user.disable')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { user: 'media', enabled: false })

      // Expiry-only toggle: no redundant --lock (it warns on a passwordless
      // share user and the `locked` flag comes from shadow expiry, not password).
      assert.deepEqual(find(calls, '/usr/sbin/usermod', () => true), ['--expiredate', '1', 'media'])
      assert.equal(find(calls, '/usr/sbin/usermod', a => a.includes('--lock')), undefined)
      // SMB side is unchanged (media has a passdb entry).
      assert.deepEqual(find(calls, '/usr/bin/smbpasswd', () => true), ['-d', 'media'])
    })

    it('enables a user (usermod --expiredate "" + smbpasswd -e) and completes', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = recordCalls(server)
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/identity/users/media',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ enabled: true }),
      })
      assert.equal(res.statusCode, 202)
      assert.equal((res.json() as JobAccepted).job.operation, 'identity.user.enable')
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      // Clears expiry, no redundant --unlock.
      assert.deepEqual(find(calls, '/usr/sbin/usermod', () => true), ['--expiredate', '', 'media'])
      assert.equal(find(calls, '/usr/sbin/usermod', a => a.includes('--unlock')), undefined)
      assert.deepEqual(find(calls, '/usr/bin/smbpasswd', () => true), ['-e', 'media'])
    })

    it('returns 404 for an unknown user', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/identity/users/ghost',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ enabled: false }),
      })
      assert.equal(res.statusCode, 404)
    })
  })

  // --- POST /identity/groups ----------------------------------------------
  describe('POST /v1/identity/groups', () => {
    it('creates a group (groupadd) and completes', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/groups',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'projects' }),
      })
      assert.equal(res.statusCode, 202)
      assert.equal((res.json() as JobAccepted).job.operation, 'identity.group.add')
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
    })

    it('returns 409 when the group already exists', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/groups',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'smbusers' }),
      })
      assert.equal(res.statusCode, 409)
    })
  })

  // --- PUT /identity/groups/:name/members ---------------------------------
  describe('PUT /v1/identity/groups/:name/members', () => {
    it('adds and removes members (gpasswd) and completes', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/identity/groups/smbusers/members',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ add: ['media'], remove: ['backup-svc'] }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'identity.group.members')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { group: 'smbusers', added: ['media'], removed: ['backup-svc'] })
    })

    it('returns 404 for an unknown group', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/identity/groups/ghostgroup/members',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ add: ['media'] }),
      })
      assert.equal(res.statusCode, 404)
    })

    it('returns 400 when a member being added does not exist', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/identity/groups/smbusers/members',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ add: ['nobodyhere'] }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    })

    it('rejects an empty add/remove body', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/identity/groups/smbusers/members',
        headers: JSON_HEADERS,
        payload: JSON.stringify({}),
      })
      assert.equal(res.statusCode, 400)
    })
  })

  // --- A node without samba (issue #6) ------------------------------------
  //
  // The installer now guarantees samba, but a node where it was removed (or an
  // install that predates the fix) must degrade honestly instead of 500ing the
  // list and leaving half-created users behind.
  describe('samba missing', () => {
    let bare: FastifyInstance | undefined

    afterEach(async () => {
      await bare?.close()
      bare = undefined
    })

    /**
     * The identity routes wired to a mock executor that reports samba ABSENT.
     * The dev-mock server always answers "installed" (it never really spawns
     * anything), so the preflight path needs its own wiring.
     */
    async function withoutSamba(): Promise<{ app: FastifyInstance, executor: MockExecutor }> {
      const executor = new MockExecutor()
      const app = Fastify({ logger: false })
      await app.register(shareIdentityRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: new JobQueue(),
        confirmStore: new ConfirmStore(),
        // Never read on the paths this section exercises; absent file = none.
        smbConfPath: join(tmpdir(), `anas-test-absent-${process.pid}.conf`),
        smbpasswdAvailable: async () => false,
      })
      bare = app
      return { app, executor }
    }

    it('still lists users when pdbedit is missing (smbEnabled false for everyone)', async () => {
      server = createServer({ mock: true, logger: false })
      failToSpawn(server, '/usr/bin/pdbedit')
      const res = await server.inject({ method: 'GET', url: '/v1/identity/users' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareUser[] }
      // The list is intact — only the SMB enrichment is missing.
      assert.deepEqual(data.map(u => u.name).sort(), ['backup-svc', 'media', 'root'])
      assert.ok(data.every(u => u.smbEnabled === false))
    })

    it('refuses to create a user with an SMB password, and does not run useradd', async () => {
      const { app, executor } = await withoutSamba()
      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'frank', smbPassword: 'hunter2' }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
      assert.match(res.json().error.message, /apt install samba/)
      assert.match(res.json().error.message, /NOT created/)
      // Nothing half-created: the account is never made without its password.
      assert.equal(executor.calls.some(c => c.command === '/usr/sbin/useradd'), false)
    })

    it('creates a user with no SMB password even when samba is missing', async () => {
      const { app, executor } = await withoutSamba()
      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'gina' }),
      })
      assert.equal(res.statusCode, 202)
      assert.equal((res.json() as JobAccepted).job.operation, 'identity.user.add')
      assert.ok(executor.calls.length >= 1)
    })

    it('refuses to set an SMB password', async () => {
      const { app, executor } = await withoutSamba()
      const line = 'media:*:1000:1000:Media User:/home/media:/usr/sbin/nologin\n'
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'media'], result: { stdout: line, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'media'], result: { stdout: line, stderr: '', exitCode: 0 } })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/identity/users/media/smb-password',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ password: 's3cret' }),
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'VALIDATION_ERROR')
      assert.match(res.json().error.message, /apt install samba/)
      assert.match(res.json().error.message, /NOT changed/)
      assert.equal(executor.calls.some(c => c.command === '/usr/bin/smbpasswd'), false)
    })

    it('rewrites a raw smbpasswd spawn failure into an actionable job error', async () => {
      // samba removed between the route preflight and the job running: the job
      // must still say what happened and what to install, not `spawn … ENOENT`.
      server = createServer({ mock: true, logger: false })
      failToSpawn(server, '/usr/bin/smbpasswd')
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'erin', smbPassword: 'hunter2' }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      const message = job.error?.message ?? ''
      assert.match(message, /was created, but setting the SMB password failed/)
      assert.match(message, /apt install samba/)
      assert.doesNotMatch(message, /ENOENT/)
    })
  })

  // --- identity.1a — the name schema accepts what useradd accepts ----------
  describe('IdentityName (identity.1a)', () => {
    it('accepts mixed case, an underscore start, and a trailing $', () => {
      for (const name of ['alice', 'Alice', 'ALICE', '_x', 'A-b_c9', 'a', 'machine$', 'ab$']) {
        assert.ok(IdentityName.safeParse(name).success, `expected '${name}' to be accepted`)
      }
    })

    it('rejects a leading digit or dash, a mid-name $, separators, and overlong names', () => {
      for (const name of ['9lives', '-x', 'a$b', 'ab cd', 'ab:cd', 'a/b', '', 'x'.repeat(33), 'näme']) {
        assert.equal(IdentityName.safeParse(name).success, false, `expected '${name}' to be rejected`)
      }
    })

    it('POST /identity/users accepts a mixed-case name (202, useradd gets it verbatim)', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = recordCalls(server)
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'Carol' }),
      })
      assert.equal(res.statusCode, 202)
      assert.equal((res.json() as JobAccepted).job.operation, 'identity.user.add')
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      // identity.1c rides the same argv: -N (no user-private group) first.
      assert.deepEqual(find(calls, '/usr/sbin/useradd', () => true), ['-N', '-M', '-s', '/usr/sbin/nologin', 'Carol'])
    })
  })

  // --- identity.1d — DELETE /v1/identity/users|groups/:name ------------------
  //
  // Wired to a mock executor with FULL fixture control: the createServer mock
  // registers first-match-wins fixtures for the `getent` pairs this section
  // needs (a mixed-case user, a directory user, a passdb entry under a
  // different case), which it cannot shadow.
  describe('DELETE (identity.1d)', () => {
    let app: FastifyInstance | undefined
    let executor: MockExecutor
    let queue: JobQueue
    let smbConfPath: string
    let tmpDir: string

    /** The account landscape every test starts from (see bootNode). */
    const PASSWD = [
      'root:x:0:0:root:/root:/bin/bash',
      'Alice:x:1000:1000:Alice Example:/home/Alice:/usr/sbin/nologin',
      'bob:x:1001:1001:Bob:/home/bob:/usr/sbin/nologin',
      '',
    ].join('\n')
    // bob is NOT in the local files DB — directory-provided, read-only.
    const LOCAL_PASSWD = [
      'root:x:0:0:root:/root:/bin/bash',
      'Alice:x:1000:1000:Alice Example:/home/Alice:/usr/sbin/nologin',
      '',
    ].join('\n')
    const GROUPS = [
      'root:x:0:',
      'Alice:x:1000:Alice',
      'team:x:1002:bob',
      '',
    ].join('\n')
    const LOCAL_GROUPS = GROUPS

    /**
     * A node with: user `Alice` (uid/gid 1000, LOCAL — her name is also a
     * group, gid 1000: a user-private group), user `bob` (directory-provided),
     * group `team` (gid 1002, no primary owner), an smb.conf whose [media]
     * share names `alice` (lowercase — the case-fold case) and `@team`, and a
     * passdb entry stored as `ALICE`.
     */
    async function bootNode(overrides?: { pdbedit?: string, smbConf?: string }) {
      tmpDir = await mkdtemp(join(tmpdir(), 'anas-identity-del-'))
      smbConfPath = join(tmpDir, 'smb.conf')
      writeFileSync(smbConfPath, overrides?.smbConf ?? [
        '[global]',
        'workgroup = WORKGROUP',
        '',
        '[media]',
        'path = /tank/media',
        'valid users = alice @team',
        '',
      ].join('\n'))

      executor = new MockExecutor()
      queue = new JobQueue()
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: { stdout: PASSWD, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group'], result: { stdout: GROUPS, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd'], result: { stdout: LOCAL_PASSWD, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group'], result: { stdout: LOCAL_GROUPS, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'Alice'], result: { stdout: 'Alice:x:1000:1000:Alice Example:/home/Alice:/usr/sbin/nologin\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'bob'], result: { stdout: 'bob:x:1001:1001:Bob:/home/bob:/usr/sbin/nologin\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'Alice'], result: { stdout: 'Alice:x:1000:1000:Alice Example:/home/Alice:/usr/sbin/nologin\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'bob'], result: { stdout: '', stderr: '', exitCode: 2 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group', 'Alice'], result: { stdout: 'Alice:x:1000:Alice\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group', 'team'], result: { stdout: 'team:x:1002:bob\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group', 'Alice'], result: { stdout: 'Alice:x:1000:Alice\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group', 'team'], result: { stdout: 'team:x:1002:bob\n', stderr: '', exitCode: 0 } })
      // The passdb holds a DIFFERENT case than the account database.
      executor.addFixture({ command: '/usr/bin/pdbedit', args: ['-L'], result: { stdout: overrides?.pdbedit ?? 'ALICE:1000:Alice Example\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/userdel', result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/sbin/groupdel', result: { stdout: '', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/smbpasswd', result: { stdout: '', stderr: '', exitCode: 0 } })
      // pdbedit -x -u <stored> (identity.3) — any other pdbedit argv succeeds.
      executor.addFixture({ command: '/usr/bin/pdbedit', result: { stdout: '', stderr: '', exitCode: 0 } })

      app = Fastify({ logger: false })
      await app.register(shareIdentityRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: queue,
        confirmStore: new ConfirmStore(),
        smbConfPath,
        smbpasswdAvailable: async () => true,
      })
    }

    function del(url: string, confirm?: string) {
      const headers: Record<string, string> = { ...IDENTITY_HEADERS }
      if (confirm !== undefined)
        headers['x-anas-confirm'] = confirm
      return app!.inject({ method: 'DELETE', url, headers })
    }

    async function waitForQueueJob(id: string): Promise<Job> {
      for (let i = 0; i < 50; i++) {
        const job = queue.get(id)
        if (job && (job.status === 'completed' || job.status === 'failed'))
          return job
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Job ${id} did not finish`)
    }

    /** A node whose smb.conf names NOBODY — the confirm gate can be reached. */
    const CLEAN_SMB_CONF = [
      '[global]',
      'workgroup = WORKGROUP',
      '',
      '[media]',
      'path = /tank/media',
      'valid users = bob',
      '',
    ].join('\n')

    afterEach(async () => {
      await app?.close()
      app = undefined
      await rm(tmpDir, { recursive: true, force: true })
    })

    it('refuses a user a share names in `valid users` (case-folded), naming the share', async () => {
      await bootNode()
      const res = await del('/v1/identity/users/Alice')
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.reason, 'referenced-by-share')
      assert.match(error.message, /media/)
      // A hard refusal: no confirm code is minted and no job is submitted.
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(queue.list().length, 0)
    })

    it('deletes a local user through the confirm gate (202, exact argv)', async () => {
      await bootNode({ smbConf: CLEAN_SMB_CONF })
      // Unconfirmed: the gate answers 409 + a code + the three consequences.
      const first = await del('/v1/identity/users/Alice')
      assert.equal(first.statusCode, 409)
      const challenged = first.json() as { error: { code: string, warnings: string[] } }
      assert.equal(challenged.error.code, 'CONFIRMATION_REQUIRED')
      assert.equal(challenged.error.warnings.length, 3)
      assert.match(challenged.error.warnings[0], /removed from the system/)
      assert.match(challenged.error.warnings[1], /uid \(1000\)/)
      assert.match(challenged.error.warnings[1], /not changed/)
      assert.match(challenged.error.warnings[2], /SMB password entry will be removed/)
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)

      // Confirmed: 202 + job; the code is single-use.
      const ok = await del('/v1/identity/users/Alice', code)
      assert.equal(ok.statusCode, 202)
      const accepted = ok.json() as JobAccepted
      assert.equal(accepted.job.operation, 'identity.user.delete')
      const job = await waitForQueueJob(accepted.job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: true })

      // Exact argv, in order (identity.2 order, identity.3 verb): the SMB
      // entry is dropped FIRST, by its STORED name (ALICE — found case-folded)
      // with pdbedit -x -u, never smbpasswd -x; then userdel.
      assert.deepEqual(find(executor.calls, '/usr/bin/pdbedit', a => a[0] === '-x'), ['-x', '-u', 'ALICE'])
      assert.equal(executor.calls.some(c => c.command === '/usr/bin/smbpasswd'), false)
      assert.deepEqual(find(executor.calls, '/usr/sbin/userdel', () => true), ['Alice'])
      assert.equal(find(executor.calls, '/usr/sbin/userdel', a => a.includes('-r')), undefined)
      const smbIdx = executor.calls.findIndex(c => c.command === '/usr/bin/pdbedit' && c.args[0] === '-x')
      const delIdx = executor.calls.findIndex(c => c.command === '/usr/sbin/userdel')
      assert.ok(smbIdx !== -1 && delIdx !== -1 && smbIdx < delIdx, 'pdbedit -x must run before userdel')

      // The consumed code cannot open the gate a second time.
      const reuse = await del('/v1/identity/users/Alice', code)
      assert.equal(reuse.statusCode, 409)
      assert.equal((reuse.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
    })

    it('fails the job on a failed pdbedit -x and never runs userdel', async () => {
      await bootNode({ smbConf: CLEAN_SMB_CONF })
      executor.addFixture({
        command: '/usr/bin/pdbedit',
        args: ['-x', '-u', 'ALICE'],
        result: { stdout: '', stderr: 'Failed to delete entry for user ALICE.\n', exitCode: 255 },
      })
      const first = await del('/v1/identity/users/Alice')
      assert.equal(first.statusCode, 409)
      const code = first.headers['x-anas-confirm-code'] as string

      const ok = await del('/v1/identity/users/Alice', code)
      assert.equal(ok.statusCode, 202)
      const job = await waitForQueueJob((ok.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error?.message ?? '', /Failed to delete entry for user ALICE/)
      // Nothing destroyed: the account is still there, only the SMB step failed.
      assert.equal(executor.calls.some(c => c.command === '/usr/sbin/userdel'), false)
    })

    it('skips the SMB step when the passdb has no entry for the user (absent is not an error)', async () => {
      await bootNode({ smbConf: CLEAN_SMB_CONF, pdbedit: '' })
      const first = await del('/v1/identity/users/Alice')
      assert.equal(first.statusCode, 409)
      const challenged = first.json() as { error: { warnings: string[] } }
      // Two warnings only — the SMB line is absent, not a blank.
      assert.equal(challenged.error.warnings.length, 2)
      const code = first.headers['x-anas-confirm-code'] as string

      const ok = await del('/v1/identity/users/Alice', code)
      assert.equal(ok.statusCode, 202)
      const job = await waitForQueueJob((ok.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: false })
      assert.equal(executor.calls.some(c => c.command === '/usr/bin/smbpasswd'), false)
      assert.equal(find(executor.calls, '/usr/bin/pdbedit', a => a[0] === '-x'), undefined)
    })

    it('drops a case-mismatched ORPHAN entry by its stored name (identity.3: smbpasswd -x failed here)', async () => {
      // The #68 shape: the entry is stored lowercase and maps to no account.
      await bootNode({ smbConf: CLEAN_SMB_CONF, pdbedit: 'alice:4294967295:\n' })
      const first = await del('/v1/identity/users/Alice')
      const challenged = first.json() as { error: { warnings: string[] } }
      assert.equal(challenged.error.warnings.length, 3)
      assert.match(challenged.error.warnings[2], /SMB password entry will be removed/)
      const code = first.headers['x-anas-confirm-code'] as string

      const ok = await del('/v1/identity/users/Alice', code)
      const job = await waitForQueueJob((ok.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: true })
      const seq = executor.calls
        .filter(c => (c.command === '/usr/bin/pdbedit' && c.args[0] === '-x') || c.command === '/usr/sbin/userdel')
        .map(c => [c.command, ...c.args])
      assert.deepEqual(seq, [
        ['/usr/bin/pdbedit', '-x', '-u', 'alice'],
        ['/usr/sbin/userdel', 'Alice'],
      ])
    })

    it('leaves an entry that belongs to ANOTHER live account alone', async () => {
      // `alice` (uid 1005) is a different account that owns the entry Samba
      // finds for `Alice` case-folded — dropping it would break that account.
      await bootNode({ smbConf: CLEAN_SMB_CONF, pdbedit: 'alice:1005:\n' })
      const first = await del('/v1/identity/users/Alice')
      const challenged = first.json() as { error: { warnings: string[] } }
      assert.equal(challenged.error.warnings.length, 2)
      const code = first.headers['x-anas-confirm-code'] as string
      const ok = await del('/v1/identity/users/Alice', code)
      const job = await waitForQueueJob((ok.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: false })
      assert.equal(find(executor.calls, '/usr/bin/pdbedit', a => a[0] === '-x'), undefined)
    })

    it('returns 404 for an unknown user, 409 for a directory user, 400 for an invalid name', async () => {
      await bootNode()
      const missing = await del('/v1/identity/users/ghost')
      assert.equal(missing.statusCode, 404)
      const directory = await del('/v1/identity/users/bob')
      assert.equal(directory.statusCode, 409)
      assert.match((directory.json() as { error: { message: string } }).error.message, /directory-provided/)
      const invalid = await del('/v1/identity/users/-rf')
      assert.equal(invalid.statusCode, 400)
      assert.equal((invalid.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR')
    })

    it('refuses a group that is any user’s primary group (primary-group-in-use)', async () => {
      await bootNode()
      // Group Alice (gid 1000) is user Alice’s primary group.
      const res = await del('/v1/identity/groups/Alice')
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.reason, 'primary-group-in-use')
      assert.match(error.message, /Alice/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(queue.list().length, 0)
    })

    it('refuses a group a share names with @ (referenced-by-share), naming the share', async () => {
      await bootNode()
      const res = await del('/v1/identity/groups/team')
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { reason: string, message: string } }
      assert.equal(error.reason, 'referenced-by-share')
      assert.match(error.message, /media/)
      assert.equal(queue.list().length, 0)
    })

    it('deletes an unreferenced group through the confirm gate (202, exact argv)', async () => {
      await bootNode({ smbConf: CLEAN_SMB_CONF })
      const first = await del('/v1/identity/groups/team')
      assert.equal(first.statusCode, 409)
      const challenged = first.json() as { error: { code: string, warnings: string[] } }
      assert.equal(challenged.error.code, 'CONFIRMATION_REQUIRED')
      assert.equal(challenged.error.warnings.length, 2)
      assert.match(challenged.error.warnings[0], /removed from the system/)
      assert.match(challenged.error.warnings[1], /gid \(1002\)/)
      const code = first.headers['x-anas-confirm-code'] as string

      const ok = await del('/v1/identity/groups/team', code)
      assert.equal(ok.statusCode, 202)
      const accepted = ok.json() as JobAccepted
      assert.equal(accepted.job.operation, 'identity.group.delete')
      const job = await waitForQueueJob(accepted.job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'team' })
      assert.deepEqual(find(executor.calls, '/usr/sbin/groupdel', () => true), ['team'])
    })

    it('group delete: 404 unknown, 400 invalid name', async () => {
      await bootNode()
      const missing = await del('/v1/identity/groups/ghostgroup')
      assert.equal(missing.statusCode, 404)
      const invalid = await del('/v1/identity/groups/-rf')
      assert.equal(invalid.statusCode, 400)
    })
  })

  // --- identity.3 (#68) — the passdb entry must match the account exactly ----
  //
  // tdbsam keys entries by the lowercased name but stores the name as first
  // written; `smbpasswd -a Name` over an orphan stored as `name` exits 0 and
  // leaves `name:4294967295:` behind — Samba accepts the password, cannot map
  // the stored name to an account, and the session becomes a guest. The
  // `pdbedit -L` fixtures below are that shape (stunt-node reproduction,
  // 2026-09-25). Wired to a mock with full fixture control: the `results`
  // sequences script the passdb and getent answers moving as the job runs.
  describe('passdb exact-case (identity.3)', () => {
    let app: FastifyInstance | undefined
    let executor: MockExecutor
    let queue: JobQueue
    let tmpDir: string
    let logLines: string[]

    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
    const NOT_FOUND: ExecResult = { stdout: '', stderr: '', exitCode: 2 }
    const NAME_LINE = 'Name:x:1001:100::/home/Name:/usr/sbin/nologin\n'
    const PASSWD = [
      'root:x:0:0:root:/root:/bin/bash',
      'smbtest:x:1000:100::/home/smbtest:/usr/sbin/nologin',
      'Name:x:1001:100::/home/Name:/usr/sbin/nologin',
      'Orphan:x:1002:100::/home/Orphan:/usr/sbin/nologin',
      'Absent:x:1003:100::/home/Absent:/usr/sbin/nologin',
      'Unmapped:x:1004:100::/home/Unmapped:/usr/sbin/nologin',
      'pat:x:1005:100::/home/pat:/usr/sbin/nologin',
      'Pat:x:1006:100::/home/Pat:/usr/sbin/nologin',
      '',
    ].join('\n')
    const GROUPS = 'root:x:0:\nusers:x:100:\n'

    /** An exact entry, a case-mismatched orphan, an unmapped uid, and one owned by another account. */
    const LISTING = [
      'smbtest:1000:',
      'Name:1001:',
      'orphan:4294967295:',
      'Unmapped:4294967295:',
      'pat:1005:',
      '',
    ].join('\n')

    /**
     * Boot the identity routes. `pdbedit` is the `pdbedit -L` answer sequence
     * (route-time read first, then each verify read); `namePasswd` the
     * `getent passwd Name` sequence (the create route sees it absent, the job
     * after useradd sees it).
     */
    async function boot(opts: { pdbedit: string[], namePasswd?: ExecResult[] }) {
      tmpDir = await mkdtemp(join(tmpdir(), 'anas-identity-passdb-'))
      const smbConfPath = join(tmpDir, 'smb.conf')
      writeFileSync(smbConfPath, '[global]\nworkgroup = WORKGROUP\n')
      executor = new MockExecutor()
      queue = new JobQueue()
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: ok(PASSWD) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group'], result: ok(GROUPS) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd'], result: ok(PASSWD) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group'], result: ok(GROUPS) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['shadow'], result: ok('') })
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'Name'], results: opts.namePasswd ?? [ok(NAME_LINE)] })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'Name'], result: ok(NAME_LINE) })
      executor.addFixture({ command: '/usr/bin/pdbedit', args: ['-L'], results: opts.pdbedit.map(ok) })
      executor.addFixture({ command: '/usr/bin/pdbedit', result: ok('') })
      executor.addFixture({ command: '/usr/bin/smbpasswd', result: ok('') })
      executor.addFixture({ command: '/usr/sbin/useradd', result: ok('') })

      logLines = []
      app = Fastify({
        logger: {
          level: 'info',
          stream: {
            write: (line: string) => {
              logLines.push(line)
            },
          },
        },
      })
      await app.register(shareIdentityRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: queue,
        confirmStore: new ConfirmStore(),
        smbConfPath,
        smbpasswdAvailable: async () => true,
      })
      return app
    }

    async function waitForQueueJob(id: string): Promise<Job> {
      for (let i = 0; i < 50; i++) {
        const job = queue.get(id)
        if (job && (job.status === 'completed' || job.status === 'failed'))
          return job
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Job ${id} did not finish`)
    }

    /** The argv sequence from the first call matching `from` onward. */
    function sequenceFrom(from: (c: Call) => boolean): string[][] {
      const start = executor.calls.findIndex(from)
      assert.ok(start !== -1, 'expected the job to start')
      return executor.calls.slice(start).map(c => [c.command, ...c.args])
    }

    function post(url: string, body: unknown) {
      return app!.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: JSON.stringify(body) })
    }

    afterEach(async () => {
      await app?.close()
      app = undefined
      await rm(tmpDir, { recursive: true, force: true })
    })

    const USERADD_NAME = ['/usr/sbin/useradd', '-N', '-M', '-s', '/usr/sbin/nologin', 'Name']
    const SMBPASSWD_NAME = ['/usr/bin/smbpasswd', '-a', '-s', 'Name']
    const GETENT_NAME = ['/usr/bin/getent', 'passwd', 'Name']
    const PDBEDIT_LIST = ['/usr/bin/pdbedit', '-L']
    const PDBEDIT_DROP_ORPHAN = ['/usr/bin/pdbedit', '-x', '-u', 'name']
    const ORPHAN = 'name:4294967295:\n'
    const FIXED = 'smbtest:1000:\nName:1001:\n'

    // --- (4) smbEnabled / smbEntryMismatch on the list ---------------------
    it('list: smbEnabled only for an exact-case entry with the account uid; the stored name on a mismatch', async () => {
      const a = await boot({ pdbedit: [LISTING] })
      const res = await a.inject({ method: 'GET', url: '/v1/identity/users' })
      assert.equal(res.statusCode, 200)
      const byName = new Map((res.json() as { data: ShareUser[] }).data.map(u => [u.name, u]))
      const facts = (n: string) => {
        const u = byName.get(n)!
        return { smbEnabled: u.smbEnabled, mismatch: 'smbEntryMismatch' in u ? u.smbEntryMismatch : '(absent)' }
      }
      // exact match
      assert.deepEqual(facts('smbtest'), { smbEnabled: true, mismatch: '(absent)' })
      assert.deepEqual(facts('Name'), { smbEnabled: true, mismatch: '(absent)' })
      // case-mismatched orphan (the #68 state)
      assert.deepEqual(facts('Orphan'), { smbEnabled: false, mismatch: 'orphan' })
      // unmapped uid under the exact name
      assert.deepEqual(facts('Unmapped'), { smbEnabled: false, mismatch: 'Unmapped' })
      // absent
      assert.deepEqual(facts('Absent'), { smbEnabled: false, mismatch: '(absent)' })
      // `pat` owns the entry; `Pat` finds it case-folded but it is not Pat's
      assert.deepEqual(facts('pat'), { smbEnabled: true, mismatch: '(absent)' })
      assert.deepEqual(facts('Pat'), { smbEnabled: false, mismatch: '(absent)' })
    })

    // --- (1)+(2) create --------------------------------------------------
    it('create, clean path: useradd → smbpasswd -a -s → verify read (pinned byte-for-byte)', async () => {
      await boot({ pdbedit: ['smbtest:1000:\n', FIXED], namePasswd: [NOT_FOUND, ok(NAME_LINE)] })
      const res = await post('/v1/identity/users', { name: 'Name', smbPassword: 'hunter2' })
      assert.equal(res.statusCode, 202)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { created: 'Name', smbEnabled: true })
      assert.deepEqual(sequenceFrom(c => c.command === '/usr/sbin/useradd'), [
        USERADD_NAME,
        SMBPASSWD_NAME,
        GETENT_NAME,
        PDBEDIT_LIST,
      ])
      // The password rides stdin only.
      assert.equal(executor.calls.some(c => c.args.includes('hunter2')), false)
    })

    it('create over a case-mismatched orphan: repairs it (pdbedit -x → smbpasswd -a → verify) and logs one line', async () => {
      await boot({ pdbedit: [ORPHAN, ORPHAN, FIXED], namePasswd: [NOT_FOUND, ok(NAME_LINE)] })
      const res = await post('/v1/identity/users', { name: 'Name', smbPassword: 'hunter2' })
      assert.equal(res.statusCode, 202)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { created: 'Name', smbEnabled: true, smbEntryReplaced: 'name' })
      assert.deepEqual(sequenceFrom(c => c.command === '/usr/sbin/useradd'), [
        USERADD_NAME,
        SMBPASSWD_NAME,
        GETENT_NAME,
        PDBEDIT_LIST,
        PDBEDIT_DROP_ORPHAN,
        SMBPASSWD_NAME,
        PDBEDIT_LIST,
      ])
      assert.equal(executor.calls.some(c => c.args.includes('hunter2')), false)
      const replacedLines = logLines.filter(l => l.includes('replaced it'))
      assert.equal(replacedLines.length, 1)
      assert.match(replacedLines[0], /stored as 'name' did not match account 'Name'/)
    })

    it('create: a repair that still does not verify fails the job naming the stored entry', async () => {
      await boot({ pdbedit: [ORPHAN, ORPHAN, ORPHAN], namePasswd: [NOT_FOUND, ok(NAME_LINE)] })
      const res = await post('/v1/identity/users', { name: 'Name', smbPassword: 'hunter2' })
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      const message = job.error?.message ?? ''
      assert.match(message, /User 'Name' was created, but setting the SMB password failed/)
      assert.match(message, /still does not hold 'Name' exactly/)
      assert.match(message, /'name' \(uid unmapped\)/)
      assert.match(message, /pdbedit -x -u name/)
    })

    it('create WITHOUT a password over a case-mismatched orphan: 409 naming the entry and the fix, no useradd', async () => {
      await boot({ pdbedit: [ORPHAN], namePasswd: [NOT_FOUND] })
      const res = await post('/v1/identity/users', { name: 'Name' })
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.reason, 'passdb-orphan')
      assert.match(error.message, /orphan entry stored as 'name'/)
      assert.match(error.message, /pdbedit -x -u name/)
      assert.match(error.message, /NOT created/)
      assert.equal(executor.calls.some(c => c.command === '/usr/sbin/useradd'), false)
      assert.equal(queue.list().length, 0)
    })

    it('create when the case-folded entry belongs to ANOTHER live account: 409, with or without a password', async () => {
      for (const body of [{ name: 'Name', smbPassword: 'hunter2' }, { name: 'Name' }]) {
        await boot({ pdbedit: ['name:1005:\n'], namePasswd: [NOT_FOUND] })
        const res = await post('/v1/identity/users', body)
        assert.equal(res.statusCode, 409)
        const { error } = res.json() as { error: { reason: string, message: string } }
        assert.equal(error.reason, 'passdb-entry-owned')
        assert.match(error.message, /stored as 'name', which belongs to another account \(uid 1005\)/)
        assert.equal(executor.calls.some(c => c.command === '/usr/sbin/useradd' || c.command === '/usr/bin/smbpasswd'), false)
        await app!.close()
        app = undefined
        await rm(tmpDir, { recursive: true, force: true })
      }
    })

    // --- (1) set password ------------------------------------------------
    it('set password, clean path: smbpasswd -a -s → verify read (pinned byte-for-byte)', async () => {
      await boot({ pdbedit: [FIXED, FIXED] })
      const res = await post('/v1/identity/users/Name/smb-password', { password: 's3cret' })
      assert.equal(res.statusCode, 202)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { user: 'Name', smbEnabled: true })
      assert.deepEqual(sequenceFrom(c => c.command === '/usr/bin/smbpasswd'), [
        SMBPASSWD_NAME,
        GETENT_NAME,
        PDBEDIT_LIST,
      ])
      assert.equal(executor.calls.some(c => c.args.includes('s3cret')), false)
    })

    it('set password over a mismatched entry repairs it: pdbedit -x → smbpasswd -a → verify', async () => {
      await boot({ pdbedit: [ORPHAN, ORPHAN, FIXED] })
      const res = await post('/v1/identity/users/Name/smb-password', { password: 's3cret' })
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { user: 'Name', smbEnabled: true, smbEntryReplaced: 'name' })
      assert.deepEqual(sequenceFrom(c => c.command === '/usr/bin/smbpasswd'), [
        SMBPASSWD_NAME,
        GETENT_NAME,
        PDBEDIT_LIST,
        PDBEDIT_DROP_ORPHAN,
        SMBPASSWD_NAME,
        PDBEDIT_LIST,
      ])
      assert.equal(logLines.filter(l => l.includes('replaced it')).length, 1)
    })

    it('set password: a failed pdbedit -x fails the job naming the stored entry, no second smbpasswd', async () => {
      await boot({ pdbedit: [ORPHAN, ORPHAN] })
      executor.addFixture({ command: '/usr/bin/pdbedit', args: ['-x', '-u', 'name'], result: { stdout: '', stderr: 'Failed to delete entry for user name.\n', exitCode: 255 } })
      const res = await post('/v1/identity/users/Name/smb-password', { password: 's3cret' })
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error?.message ?? '', /stores the entry for 'Name' as 'name', and removing it failed: Failed to delete entry/)
      assert.equal(executor.calls.filter(c => c.command === '/usr/bin/smbpasswd').length, 1)
    })

    it('set password: smbpasswd exit 0 but no entry at all fails the job', async () => {
      await boot({ pdbedit: ['', ''] })
      const res = await post('/v1/identity/users/Name/smb-password', { password: 's3cret' })
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error?.message ?? '', /no entry for 'Name'/)
    })

    it('set password when the case-folded entry belongs to ANOTHER live account: 409, smbpasswd never runs', async () => {
      await boot({ pdbedit: ['name:1005:\n'] })
      const res = await post('/v1/identity/users/Name/smb-password', { password: 's3cret' })
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { reason: string, message: string } }
      assert.equal(error.reason, 'passdb-entry-owned')
      assert.match(error.message, /NOT changed/)
      assert.equal(executor.calls.some(c => c.command === '/usr/bin/smbpasswd'), false)
      assert.equal(queue.list().length, 0)
    })
  })

  // --- identity.1b + 1c — case-folded SMB presence, private groups ----------
  describe('case-folded SMB presence and private groups (identity.1b/1c)', () => {
    let app: FastifyInstance | undefined
    let tmpDir: string
    let smbConfPath: string

    const PASSWD = [
      'root:x:0:0:root:/root:/bin/bash',
      'Alice:x:1000:1000:Alice Example:/home/Alice:/usr/sbin/nologin',
      '',
    ].join('\n')
    const GROUPS = [
      'root:x:0:',
      'Alice:x:1000:Alice',
      'plain:x:1002:',
      '',
    ].join('\n')

    async function boot() {
      tmpDir = await mkdtemp(join(tmpdir(), 'anas-identity-case-'))
      smbConfPath = join(tmpDir, 'smb.conf')
      writeFileSync(smbConfPath, '[global]\nworkgroup = WORKGROUP\n')
      const executor = new MockExecutor()
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: { stdout: PASSWD, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group'], result: { stdout: GROUPS, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd'], result: { stdout: PASSWD, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group'], result: { stdout: GROUPS, stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'Alice'], result: { stdout: 'Alice:x:1000:1000:Alice Example:/home/Alice:/usr/sbin/nologin\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'Alice'], result: { stdout: 'Alice:x:1000:1000:Alice Example:/home/Alice:/usr/sbin/nologin\n', stderr: '', exitCode: 0 } })
      // The passdb stores the LOWERCASE form of the mixed-case account.
      executor.addFixture({ command: '/usr/bin/pdbedit', args: ['-L'], result: { stdout: 'alice:1000:Alice Example\n', stderr: '', exitCode: 0 } })

      app = Fastify({ logger: false })
      await app.register(shareIdentityRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: new JobQueue(),
        confirmStore: new ConfirmStore(),
        smbConfPath,
        smbpasswdAvailable: async () => true,
      })
      return app
    }

    afterEach(async () => {
      await app?.close()
      app = undefined
      await rm(tmpDir, { recursive: true, force: true })
    })

    // identity.3 (#68) reverses the identity.1b reading: a passdb entry under
    // a different case is FOUND case-folded (it is the one Samba uses) but it
    // does not make the account SMB-enabled — the list reports the stored name.
    it('a passdb entry under a different case is a mismatch, not smbEnabled (identity.3)', async () => {
      const a = await boot()
      const res = await a.inject({ method: 'GET', url: '/v1/identity/users' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareUser[] }
      const alice = data.find(u => u.name === 'Alice')!
      assert.equal(alice.smbEnabled, false)
      assert.equal(alice.smbEntryMismatch, 'alice')
    })

    it('single-user detail reports the same mismatch', async () => {
      const a = await boot()
      const res = await a.inject({ method: 'GET', url: '/v1/identity/users/Alice' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareUser }
      assert.equal(data.smbEnabled, false)
      assert.equal(data.smbEntryMismatch, 'alice')
    })

    it('marks an existing user-private group with privateGroupOf; a plain group has no key', async () => {
      const a = await boot()
      const res = await a.inject({ method: 'GET', url: '/v1/identity/groups' })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: ShareGroup[] }
      const priv = data.find(g => g.name === 'Alice')!
      assert.equal(priv.privateGroupOf, 'Alice')
      const plain = data.find(g => g.name === 'plain')!
      assert.equal('privateGroupOf' in plain, false)
    })
  })
})
