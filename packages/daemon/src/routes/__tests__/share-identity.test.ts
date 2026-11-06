import type { Job, JobAccepted, ShareGroup, ShareUser } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
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
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** No /etc/exports: an absent file reads as no exports (cr.29's share roots). */
const ABSENT_EXPORTS = join(tmpdir(), `anas-test-absent-exports-${process.pid}`)

/**
 * cr.59: the uid/gid pick also reads which ZFS filesystems have POSIX ACLs on
 * (none here), the AHR pools (no arrays: fixtures/ahr/mdstat-clean.txt's
 * Personalities and `unused devices` lines) and the mount table
 * (fixtures/mounts/findmnt-root.json) — nothing to walk.
 */
function aclReadFixtures(executor: MockExecutor): void {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')
  const mdstat = readFileSync(join(fixtures, 'ahr/mdstat-clean.txt'), 'utf-8').split('\n').filter(l => l.startsWith('Personalities') || l.startsWith('unused devices')).map(l => `${l}\n`).join('')
  executor.addFixture({ command: '/usr/sbin/zfs', args: ['get', '-H', '-p', '-o', 'name,value', '-t', 'filesystem', 'acltype'], result: { stdout: '', stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/cat', args: ['/proc/mdstat'], result: { stdout: mdstat, stderr: '', exitCode: 0 } })
  executor.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: readFileSync(join(fixtures, 'mounts/findmnt-root.json'), 'utf-8'), stderr: '', exitCode: 0 } })
}

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
      assert.deepEqual(names, ['media', 'root', 'smbusers', 'users'])
      const smb = data.find(g => g.name === 'smbusers')!
      assert.deepEqual(smb.members, ['media', 'backup-svc'])
      assert.equal(smb.local, true)
    })

    it('#78: the default primary group `users` (gid 100) is listed beside root — every ANAS user\'s primary group, never a band group', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/identity/groups' })
      const { data } = res.json() as { data: ShareGroup[] }
      const users = data.find(g => g.name === 'users')
      assert.deepEqual(users, { name: 'users', gid: 100, members: [], local: true })
      // The other side of the exception: no other service-range group leaks in.
      assert.deepEqual(data.filter(g => g.gid > 0 && g.gid < 1000).map(g => g.gid), [100])
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
    it('rejects member names that are not identity names — 400, and no gpasswd runs (cr.17)', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = recordCalls(server)
      for (const member of ['-x', 'a:b']) {
        const res: Awaited<ReturnType<FastifyInstance['inject']>> = await server.inject({
          method: 'PUT',
          url: '/v1/identity/groups/smbusers/members',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ add: [member] }),
        })
        assert.equal(res.statusCode, 400, member)
        assert.equal((res.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR', member)
      }
      assert.equal(find(calls, '/usr/bin/gpasswd', () => true), undefined)
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
        exportsPath: ABSENT_EXPORTS,
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
      // cr.29: the uid pick reads the accounts, the ZFS filesystems (none)
      // and looks the candidate up by number (free: getent exit 2); cr.29c:
      // it reads the groups too and looks gid 1000 up (free as well).
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: { stdout: 'root:x:0:0:root:/root:/bin/bash\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', '1000'], result: { stdout: '', stderr: '', exitCode: 2 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group'], result: { stdout: 'root:x:0:\nusers:x:100:\n', stderr: '', exitCode: 0 } })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group', '1000'], result: { stdout: '', stderr: '', exitCode: 2 } })
      executor.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name', '-t', 'filesystem'], result: { stdout: '', stderr: '', exitCode: 0 } })
      aclReadFixtures(executor)
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
      // identity.5: no user verb reads the group database any more (cr.58's
      // admin-group test is gone), so no `getent group` fixture is needed.
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
      assert.deepEqual(find(calls, '/usr/sbin/useradd', () => true), ['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1002', 'Carol'])
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
        exportsPath: ABSENT_EXPORTS,
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
      // cr.29d: five — Alice's private group (gid 1000, only Alice in it) goes with her.
      assert.equal(challenged.error.warnings.length, 5)
      assert.match(challenged.error.warnings[0], /removed from the system/)
      // cr.29: the number stays on the files, said once, with what cannot be checked.
      assert.equal(challenged.error.warnings[1], 'Files owned by this user keep uid 1000. ANAS will not give uid 1000 to a new user while it still owns files on an imported ZFS filesystem or under a share, but it cannot check ids seen only in exported pools, on disconnected disks or in backups. To give the files back later, re-create the user with User ID 1000.')
      assert.equal(challenged.error.warnings.filter(w => w.includes('keep uid')).length, 1)
      assert.match(challenged.error.warnings[2], /SMB password entry will be removed/)
      assert.match(challenged.error.warnings[3], /^Its group 'Alice' \(gid 1000\) will be removed too/)
      assert.match(challenged.error.warnings[4], /^Files owned by this group keep gid 1000\./)
      const code = first.headers['x-anas-confirm-code'] as string
      assert.ok(code)

      // Confirmed: 202 + job; the code is single-use.
      const ok = await del('/v1/identity/users/Alice', code)
      assert.equal(ok.statusCode, 202)
      const accepted = ok.json() as JobAccepted
      assert.equal(accepted.job.operation, 'identity.user.delete')
      const job = await waitForQueueJob(accepted.job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: true, groupRemoved: 'Alice' })

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
      // No SMB line — absent, not a blank (the other two are Alice's group, cr.29d).
      assert.equal(challenged.error.warnings.length, 4)
      assert.equal(challenged.error.warnings.some(w => /SMB/.test(w)), false)
      const code = first.headers['x-anas-confirm-code'] as string

      const ok = await del('/v1/identity/users/Alice', code)
      assert.equal(ok.statusCode, 202)
      const job = await waitForQueueJob((ok.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: false, groupRemoved: 'Alice' })
      assert.equal(executor.calls.some(c => c.command === '/usr/bin/smbpasswd'), false)
      assert.equal(find(executor.calls, '/usr/bin/pdbedit', a => a[0] === '-x'), undefined)
    })

    it('drops a case-mismatched ORPHAN entry by its stored name (identity.3: smbpasswd -x failed here)', async () => {
      // The #68 shape: the entry is stored lowercase and maps to no account.
      await bootNode({ smbConf: CLEAN_SMB_CONF, pdbedit: 'alice:4294967295:\n' })
      const first = await del('/v1/identity/users/Alice')
      const challenged = first.json() as { error: { warnings: string[] } }
      assert.equal(challenged.error.warnings.length, 5)
      assert.match(challenged.error.warnings[2], /SMB password entry will be removed/)
      const code = first.headers['x-anas-confirm-code'] as string

      const ok = await del('/v1/identity/users/Alice', code)
      const job = await waitForQueueJob((ok.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: true, groupRemoved: 'Alice' })
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
      assert.equal(challenged.error.warnings.length, 4)
      const code = first.headers['x-anas-confirm-code'] as string
      const ok = await del('/v1/identity/users/Alice', code)
      const job = await waitForQueueJob((ok.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { deleted: 'Alice', smbEntryRemoved: false, groupRemoved: 'Alice' })
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
      assert.equal(challenged.error.warnings[1], 'Files owned by this group keep gid 1002. ANAS will not give gid 1002 to a new group while it still owns files on an imported ZFS filesystem or under a share, but it cannot check ids seen only in exported pools, on disconnected disks or in backups. To give the files back later, re-create the group with Group ID 1002.')
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
     * (route-time read first, the job's guard re-read second (cr.42), then
     * each verify read); `namePasswd` the `getent passwd Name` sequence (the
     * create route and the job's guard re-read see it absent, the job after
     * useradd sees it).
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
      // cr.29: no dataset, no share path; `getent passwd <n>` for a number
      // nobody holds is exit 2 (getent(1)) — the create picks uid 1007.
      executor.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name', '-t', 'filesystem'], result: ok('') })
      aclReadFixtures(executor)
      executor.addFixture({ command: '/usr/bin/getent', argsMatch: a => a.length === 2 && a[0] === 'passwd' && Number(a[1]) >= 1007, result: NOT_FOUND })
      // cr.29c: the pick and the same-number check look gid 1007 up too (free).
      executor.addFixture({ command: '/usr/bin/getent', argsMatch: a => a.length === 2 && a[0] === 'group' && Number(a[1]) >= 1007, result: NOT_FOUND })

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
        exportsPath: ABSENT_EXPORTS,
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

    const USERADD_NAME = ['/usr/sbin/useradd', '-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1007', 'Name']
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
      await boot({ pdbedit: ['smbtest:1000:\n', 'smbtest:1000:\n', FIXED], namePasswd: [NOT_FOUND, NOT_FOUND, ok(NAME_LINE)] })
      const res = await post('/v1/identity/users', { name: 'Name', smbPassword: 'hunter2' })
      assert.equal(res.statusCode, 202)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { created: 'Name', uid: 1007, smbEnabled: true })
      assert.deepEqual(sequenceFrom(c => c.command === '/usr/sbin/useradd'), [
        USERADD_NAME,
        SMBPASSWD_NAME,
        GETENT_NAME,
        PDBEDIT_LIST,
      ])
      // The password rides stdin only.
      assert.equal(executor.calls.some(c => c.args.includes('hunter2')), false)
    })

    it('create over a case-mismatched orphan: DROPS it (pdbedit -x) before smbpasswd -a, then verifies exact-case (cr.58r P3)', async () => {
      // cr.58r: the orphan is dropped BEFORE `smbpasswd -a` — writing the new
      // password onto the existing entry would have kept its old attributes
      // (a `D` flag included), so the entry is removed and written fresh.
      await boot({ pdbedit: [ORPHAN, ORPHAN, FIXED], namePasswd: [NOT_FOUND, NOT_FOUND, ok(NAME_LINE)] })
      const res = await post('/v1/identity/users', { name: 'Name', smbPassword: 'hunter2' })
      assert.equal(res.statusCode, 202)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { created: 'Name', uid: 1007, smbEnabled: true, smbEntryReplaced: 'name' })
      assert.deepEqual(sequenceFrom(c => c.command === '/usr/sbin/useradd'), [
        USERADD_NAME,
        PDBEDIT_DROP_ORPHAN,
        SMBPASSWD_NAME,
        GETENT_NAME,
        PDBEDIT_LIST,
      ])
      assert.equal(executor.calls.some(c => c.args.includes('hunter2')), false)
    })

    it('create: a repair that still does not verify fails the job naming the stored entry', async () => {
      await boot({ pdbedit: [ORPHAN, ORPHAN, ORPHAN, ORPHAN], namePasswd: [NOT_FOUND, NOT_FOUND, ok(NAME_LINE)] })
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
      await boot({ pdbedit: [ORPHAN, ORPHAN, ORPHAN, FIXED] })
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
        exportsPath: ABSENT_EXPORTS,
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

  // --- cr.3 (review C3) — system accounts are not mutable --------------------
  //
  // A mutation may target only accounts in the share band [1000, 60000]. root
  // (uid 0), the 1..999 service range, nobody (65534) and system groups (sudo,
  // gid 27) get a HARD 409 SYSTEM_ACCOUNT: no confirm code is minted, no job
  // is submitted, and no mutating command ever runs. Band accounts pass every
  // verb unchanged. Every account here is LOCAL — the band, not locality, is
  // what refuses. The job-time test scripts the getent answer MOVING between
  // the request and the job (MockExecutor `results` sequences).
  describe('cr.3 — system accounts are not mutable (review C3)', () => {
    let app: FastifyInstance | undefined
    let executor: MockExecutor
    let queue: JobQueue
    let tmpDir: string

    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
    const NOT_FOUND: ExecResult = { stdout: '', stderr: '', exitCode: 2 }

    const rootLine = 'root:x:0:0:root:/root:/bin/bash\n'
    const svcLine = 'svcbackup:x:100:100:svc:/nonexistent:/usr/sbin/nologin\n'
    const nobodyLine = 'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n'
    const SHARE_LINE = 'shareuser:x:1001:100:Share User:/home/shareuser:/usr/sbin/nologin\n'
    const PASSWD = [rootLine.trimEnd(), svcLine.trimEnd(), nobodyLine.trimEnd(), SHARE_LINE.trimEnd(), ''].join('\n')
    const GROUP_LINES = ['root:x:0:', 'sudo:x:27:', 'users:x:100:', 'sharegrp:x:1002:shareuser']

    /** Every command that would change the system (pdbedit -x is the carve-out). */
    const MUTATORS = ['/usr/sbin/usermod', '/usr/sbin/userdel', '/usr/sbin/groupdel', '/usr/bin/gpasswd', '/usr/bin/smbpasswd', '/usr/sbin/useradd']
    function mutatorCalls(): Call[] {
      return executor.calls.filter(c => MUTATORS.includes(c.command) || (c.command === '/usr/bin/pdbedit' && c.args[0] === '-x'))
    }

    /**
     * `accounts`: more passwd lines (each also served by name); `groupLines`:
     * the group database in place of GROUP_LINES (each served by name).
     */
    async function boot(opts: { sharePasswd?: ExecResult[], pdblist?: ExecResult, groupsResult?: ExecResult, userCfg?: string, accounts?: string[], groupLines?: string[] } = {}) {
      const passwdText = `${PASSWD}${(opts.accounts ?? []).map(l => `${l}\n`).join('')}`
      const groupLines = opts.groupLines ?? GROUP_LINES
      const groupsText = [...groupLines, ''].join('\n')
      tmpDir = await mkdtemp(join(tmpdir(), 'anas-identity-cr3-'))
      const smbConfPath = join(tmpDir, 'smb.conf')
      writeFileSync(smbConfPath, '[global]\nworkgroup = WORKGROUP\n')
      // cr.58r P4: a user.cfg for the create's @pam-login gate (unset: the
      // default path, absent on a dev host = no logins).
      let pveUserCfgPath: string | undefined
      if (opts.userCfg !== undefined) {
        pveUserCfgPath = join(tmpDir, 'user.cfg')
        writeFileSync(pveUserCfgPath, opts.userCfg)
      }
      executor = new MockExecutor()
      queue = new JobQueue()
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: ok(passwdText) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group'], result: opts.groupsResult ?? ok(groupsText) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd'], result: ok(passwdText) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group'], result: ok(groupsText) })
      const userFixtures: Array<[string, string]> = [
        ['root', rootLine],
        ['svcbackup', svcLine],
        ['nobody', nobodyLine],
        ...(opts.accounts ?? []).map((l): [string, string] => [l.split(':')[0]!, `${l}\n`]),
      ]
      for (const [name, line] of userFixtures) {
        executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', name], result: ok(line) })
        executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', name], result: ok(line) })
      }
      // `results` so the job-time test can script the uid moving out of band.
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'shareuser'], results: opts.sharePasswd ?? [ok(SHARE_LINE)] })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'shareuser'], result: ok(SHARE_LINE) })
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'newbie'], result: NOT_FOUND })
      const groupFixtures = groupLines.map((l): [string, string] => [l.split(':')[0]!, `${l}\n`])
      for (const [name, line] of groupFixtures) {
        executor.addFixture({ command: '/usr/bin/getent', args: ['group', name], result: ok(line) })
        executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group', name], result: ok(line) })
      }
      executor.addFixture({ command: '/usr/bin/pdbedit', args: ['-L'], result: opts.pdblist ?? ok('') })
      executor.addFixture({ command: '/usr/bin/pdbedit', result: ok('') })
      executor.addFixture({ command: '/usr/bin/smbpasswd', result: ok('') })
      executor.addFixture({ command: '/usr/sbin/usermod', result: ok('') })
      executor.addFixture({ command: '/usr/sbin/useradd', result: ok('') })
      executor.addFixture({ command: '/usr/sbin/userdel', result: ok('') })
      executor.addFixture({ command: '/usr/sbin/groupdel', result: ok('') })
      executor.addFixture({ command: '/usr/bin/gpasswd', result: ok('') })

      app = Fastify({ logger: false })
      await app.register(shareIdentityRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: queue,
        confirmStore: new ConfirmStore(),
        smbConfPath,
        exportsPath: ABSENT_EXPORTS,
        ...(pveUserCfgPath !== undefined ? { pveUserCfgPath } : {}),
        smbpasswdAvailable: async () => true,
      })
    }

    function del(url: string, confirm?: string) {
      const headers: Record<string, string> = { ...IDENTITY_HEADERS }
      if (confirm !== undefined)
        headers['x-anas-confirm'] = confirm
      return app!.inject({ method: 'DELETE', url, headers })
    }
    function put(url: string, body: unknown) {
      return app!.inject({ method: 'PUT', url, headers: JSON_HEADERS, payload: JSON.stringify(body) })
    }
    function post(url: string, body: unknown) {
      return app!.inject({ method: 'POST', url, headers: JSON_HEADERS, payload: JSON.stringify(body) })
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

    /** The shared shape of every cr.3 refusal: hard 409, no code, no job, no command. */
    function assertRefusal(res: { statusCode: number, headers: Record<string, unknown>, json: () => { error: { code: string, message: string } } }, name: string) {
      assert.equal(res.statusCode, 409)
      const { error } = res.json()
      assert.equal(error.code, 'SYSTEM_ACCOUNT')
      assert.match(error.message, new RegExp(`'${name}'`))
      assert.match(error.message, /managed outside ANAS/)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(queue.list().length, 0)
      assert.deepEqual(mutatorCalls(), [])
    }

    afterEach(async () => {
      await app?.close()
      app = undefined
      await rm(tmpDir, { recursive: true, force: true })
    })

    // The three out-of-band shapes: uid 0, the service range, the range above 60000.
    const OUT_OF_BAND: Array<[string, number]> = [['root', 0], ['svcbackup', 100], ['nobody', 65534]]

    it('refuses to disable/enable root, a service account, and nobody (uid 0/100/65534)', async () => {
      await boot()
      for (const [name, uid] of OUT_OF_BAND) {
        const res = await put(`/v1/identity/users/${name}`, { enabled: false })
        assertRefusal(res, name)
        assert.match((res.json() as { error: { message: string } }).error.message, new RegExp(`uid ${uid}`))
      }
    })

    it('refuses an SMB password on root, a service account, and nobody', async () => {
      await boot()
      for (const [name] of OUT_OF_BAND) {
        const res = await post(`/v1/identity/users/${name}/smb-password`, { password: 'hunter2' })
        assertRefusal(res, name)
      }
    })

    it('refuses deleting root, a service account, and nobody (userdel has no uid floor)', async () => {
      await boot()
      for (const [name] of OUT_OF_BAND) {
        const res = await del(`/v1/identity/users/${name}`)
        assertRefusal(res, name)
      }
    })

    it('refuses a membership edit of the sudo group (gid 27)', async () => {
      await boot()
      const res = await put('/v1/identity/groups/sudo/members', { add: ['shareuser'] })
      assertRefusal(res, 'sudo')
      assert.match((res.json() as { error: { message: string } }).error.message, /gid 27/)
    })

    it('refuses deleting the sudo group (groupdel has no gid floor)', async () => {
      await boot()
      const res = await del('/v1/identity/groups/sudo')
      assertRefusal(res, 'sudo')
    })

    it('identity.5 (#78): `users` (gid 100) is listed, its membership editable, never deleted — an in-band member is added and removed with gpasswd; the delete still 409s', async () => {
      await boot({ groupLines: ['root:x:0:', 'sudo:x:27:', 'users:x:100:shareuser', 'sharegrp:x:1002:shareuser'] })
      const list = await app!.inject({ method: 'GET', url: '/v1/identity/groups', headers: IDENTITY_HEADERS })
      assert.deepEqual((list.json() as { data: ShareGroup[] }).data.map(g => g.name).sort(), ['root', 'sharegrp', 'users'])
      // The delete first: still the hard 409, no code, no job, no command.
      const deleted = await del('/v1/identity/groups/users')
      assertRefusal(deleted, 'users')
      assert.match((deleted.json() as { error: { message: string } }).error.message, /gid 100/)

      const added = await put('/v1/identity/groups/users/members', { add: ['shareuser'] })
      assert.equal(added.statusCode, 202, added.body)
      assert.equal((await waitForQueueJob((added.json() as JobAccepted).job.id)).status, 'completed')
      const removed = await put('/v1/identity/groups/users/members', { remove: ['shareuser'] })
      assert.equal(removed.statusCode, 202, removed.body)
      assert.equal((await waitForQueueJob((removed.json() as JobAccepted).job.id)).status, 'completed')
      assert.deepEqual(mutatorCalls().map(c => [c.command, ...c.args]), [
        ['/usr/bin/gpasswd', '-a', 'shareuser', 'users'],
        ['/usr/bin/gpasswd', '-d', 'shareuser', 'users'],
      ])
    })

    it('identity.5: the `users` Members door still refuses an out-of-band member (root) and a @pam login; root\'s own Members door (gid 0) and delete stay refused', async () => {
      await boot({ userCfg: 'user:shareuser@pam:1:0:::::,,,\n' })
      const rootMember = await put('/v1/identity/groups/users/members', { add: ['root'] })
      assertRefusal(rootMember, 'root')
      assert.match((rootMember.json() as { error: { message: string } }).error.message, /^User 'root' \(uid 0\) is a system account\..* It cannot be added to group 'users' here\.$/)
      const pamMember = await put('/v1/identity/groups/users/members', { add: ['shareuser'] })
      assertRefusal(pamMember, 'shareuser')
      assert.match((pamMember.json() as { error: { message: string } }).error.message, /it is a Proxmox VE login \('shareuser@pam'\)\..* It cannot be added to group 'users' here\.$/)
      const rootGroup = await put('/v1/identity/groups/root/members', { add: ['svcbackup'] })
      assertRefusal(rootGroup, 'root')
      assert.match((rootGroup.json() as { error: { message: string } }).error.message, /^Group 'root' \(gid 0\) is a system account/)
      assertRefusal(await del('/v1/identity/groups/root'), 'root')
    })

    it('identity.5 (#78): create with `groups: [\'users\']` runs useradd with -G users, as the primary group is taken', async () => {
      await boot()
      // An explicit uid: the id is not walked for files, so the create needs
      // only the by-number lookups (nothing holds 1500).
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', '1500'], result: NOT_FOUND })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group', '1500'], result: NOT_FOUND })
      const res = await post('/v1/identity/users', { name: 'newbie', uid: 1500, groups: ['users'] })
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.deepEqual(find(executor.calls, '/usr/sbin/useradd', () => true), ['-N', '-M', '-s', '/usr/sbin/nologin', '-u', '1500', '-G', 'users', 'newbie'])
    })

    it('identity.5: create with `groups: [\'root\']` still 409s SYSTEM_ACCOUNT naming root (gid 0) — `users` beside it is not named; no useradd', async () => {
      await boot()
      const res = await post('/v1/identity/users', { name: 'newbie', groups: ['users', 'root'] })
      assert.equal(res.statusCode, 409, res.body)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'SYSTEM_ACCOUNT')
      assert.equal(error.message, `Group(s) 'root' (gid 0) are system groups. System accounts (uid/gid below 1000 or above 60000) are managed outside ANAS; the default primary group (gid 100) is the one exception.`)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(queue.list().length, 0)
      assert.equal(executor.calls.some(c => c.command === '/usr/sbin/useradd'), false)
    })

    it('identity.5 (#78, the reporter\'s shape): a user whose primary group is an in-band group named `admin` and who is listed in sudo is a share account — disable, enable, SMB password, delete and both Members doors run', async () => {
      const CHRIS = 'chris:x:1010:3000::/home/chris:/usr/sbin/nologin'
      const DANA = 'dana:x:1011:100::/home/dana:/usr/sbin/nologin'
      await boot({
        accounts: [CHRIS, DANA],
        groupLines: ['root:x:0:', 'sudo:x:27:chris', 'users:x:100:', 'admin:x:3000:dana', 'sharegrp:x:1002:shareuser'],
        pdblist: ok('chris:1010:\n'),
      })
      for (const [req, act] of [
        [() => put('/v1/identity/users/chris', { enabled: false }), ['/usr/sbin/usermod', '--expiredate', '1', 'chris']],
        [() => put('/v1/identity/users/chris', { enabled: true }), ['/usr/sbin/usermod', '--expiredate', '', 'chris']],
        [() => post('/v1/identity/users/chris/smb-password', { password: 'hunter2' }), ['/usr/bin/smbpasswd', '-a', '-s', 'chris']],
        // The reporter's re-group: the `admin` group's own Members door, and chris into a band group.
        [() => put('/v1/identity/groups/admin/members', { add: ['shareuser'], remove: ['dana'] }), ['/usr/bin/gpasswd', '-d', 'dana', 'admin']],
        [() => put('/v1/identity/groups/sharegrp/members', { add: ['chris'] }), ['/usr/bin/gpasswd', '-a', 'chris', 'sharegrp']],
      ] as const) {
        const res = await req()
        assert.equal(res.statusCode, 202, res.body)
        const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
        assert.equal(job.status, 'completed', JSON.stringify(job.error))
        assert.ok(mutatorCalls().some(c => [c.command, ...c.args].join(' ') === act.join(' ')), `${act.join(' ')} ran`)
      }
      assert.ok(mutatorCalls().some(c => [c.command, ...c.args].join(' ') === '/usr/bin/gpasswd -a shareuser admin'))

      const challenged = await del('/v1/identity/users/chris')
      assert.equal(challenged.statusCode, 409, challenged.body)
      assert.equal((challenged.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
      const confirmed = await del('/v1/identity/users/chris', challenged.headers['x-anas-confirm-code'] as string)
      assert.equal(confirmed.statusCode, 202, confirmed.body)
      assert.equal((await waitForQueueJob((confirmed.json() as JobAccepted).job.id)).status, 'completed')
      assert.deepEqual(find(executor.calls, '/usr/sbin/userdel', () => true), ['chris'])
    })

    it('create with a system group in `groups` refuses naming the group, no useradd', async () => {
      await boot()
      const res = await post('/v1/identity/users', { name: 'newbie', groups: ['sharegrp', 'sudo'] })
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'SYSTEM_ACCOUNT')
      assert.match(error.message, /'sudo' \(gid 27\)/)
      assert.match(error.message, /managed outside ANAS/)
      assert.equal(queue.list().length, 0)
      assert.equal(executor.calls.some(c => c.command === '/usr/sbin/useradd'), false)
    })

    it('a share-band user still passes every verb (disable, SMB password, delete)', async () => {
      await boot({ pdblist: ok('shareuser:1001:\n') })

      const disable = await put('/v1/identity/users/shareuser', { enabled: false })
      assert.equal(disable.statusCode, 202)
      assert.equal((await waitForQueueJob((disable.json() as JobAccepted).job.id)).status, 'completed')
      assert.deepEqual(find(executor.calls, '/usr/sbin/usermod', () => true), ['--expiredate', '1', 'shareuser'])

      const smb = await post('/v1/identity/users/shareuser/smb-password', { password: 'hunter2' })
      assert.equal(smb.statusCode, 202)
      assert.equal((await waitForQueueJob((smb.json() as JobAccepted).job.id)).status, 'completed')

      const challenged = await del('/v1/identity/users/shareuser')
      assert.equal(challenged.statusCode, 409)
      assert.equal((challenged.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
      const code = challenged.headers['x-anas-confirm-code'] as string
      const confirmed = await del('/v1/identity/users/shareuser', code)
      assert.equal(confirmed.statusCode, 202)
      assert.equal((await waitForQueueJob((confirmed.json() as JobAccepted).job.id)).status, 'completed')
    })

    it('a share-band group still passes every verb (members, delete)', async () => {
      await boot()
      const members = await put('/v1/identity/groups/sharegrp/members', { add: ['shareuser'] })
      assert.equal(members.statusCode, 202)
      assert.equal((await waitForQueueJob((members.json() as JobAccepted).job.id)).status, 'completed')
      assert.deepEqual(find(executor.calls, '/usr/bin/gpasswd', () => true), ['-a', 'shareuser', 'sharegrp'])

      const challenged = await del('/v1/identity/groups/sharegrp')
      assert.equal(challenged.statusCode, 409)
      const code = challenged.headers['x-anas-confirm-code'] as string
      const confirmed = await del('/v1/identity/groups/sharegrp', code)
      assert.equal(confirmed.statusCode, 202)
      const job = await waitForQueueJob((confirmed.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(find(executor.calls, '/usr/sbin/groupdel', () => true), ['sharegrp'])
    })

    it('job re-gate (ruling (j)): in-band at request time, out-of-band when the job runs → failed, no command', async () => {
      // The getent answer MOVES between the request and the job: uid 1001 at
      // request time (the route admits the mutation), 999 by the time the job
      // re-reads — the job must fail closed before its first usermod. Since
      // cr.42 the uid is the account's id, so a moved uid is another account
      // (IDENTITY_MISMATCH) before the band gate is even asked.
      await boot({ sharePasswd: [ok(SHARE_LINE), ok(SHARE_LINE.replace(':1001:', ':999:'))] })
      const res = await put('/v1/identity/users/shareuser', { enabled: false })
      assert.equal(res.statusCode, 202)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
      assert.match(job.error?.message ?? '', /User 'shareuser' is not the one that was confirmed \(uid 1001 at the confirmation, uid 999 now\)/)
      assert.deepEqual(mutatorCalls(), [])
    })

    // cr.58r (the cr.58 review's four possibles): one pin per behaviour here
    // too — the review found every cr.58 behaviour covered only by
    // share-identity-strict.test.ts. The full scenarios live there; these are
    // the same refusals on this older harness.

    it('cr.58r P1: a failing smbpasswd -d fails the disable BEFORE usermod — no half-done disable', async () => {
      await boot({ pdblist: ok('shareuser:1001:\n') })
      executor.addFixture({ command: '/usr/bin/smbpasswd', args: ['-d', 'shareuser'], result: { stdout: '', stderr: 'tdb locked\n', exitCode: 1 } })
      const res = await put('/v1/identity/users/shareuser', { enabled: false })
      assert.equal(res.statusCode, 202)
      const job = await waitForQueueJob((res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error?.message ?? '', /tdb locked/)
      // The SMB step (the transient-failure one) runs first; its failure
      // leaves the unix half untouched — no half-disabled account.
      assert.equal(find(executor.calls, '/usr/sbin/usermod', () => true), undefined, 'usermod never ran')
      assert.deepEqual(find(executor.calls, '/usr/bin/smbpasswd', () => true), ['-d', 'shareuser'])
    })

    it('cr.58r P2 (identity.5 re-pinned): a getent group that exits non-zero with PARTIAL output is unreadable where it is still read — a create 503s; the disable reads no group listing and runs', async () => {
      // The review's EXTRA1 shape: the sudo line cut off mid-members-list.
      // identity.5: membership is no longer a system-account criterion, so
      // the user verbs never read the listing; a create's uid pick does.
      await boot({ groupsResult: { stdout: 'root:x:0:\nsudo:x:27:shareuse', stderr: '', exitCode: 1 } })
      const create = await post('/v1/identity/users', { name: 'newbie' })
      assert.equal(create.statusCode, 503, create.body)
      assert.equal((create.json() as { error: { code: string } }).error.code, 'UNAVAILABLE')
      assert.match((create.json() as { error: { message: string } }).error.message, /could not read the group database \(getent group\)/)
      assert.deepEqual(mutatorCalls(), [])

      const listings = () => executor.calls.filter(c => c.command === '/usr/bin/getent' && ['group', '-s files group'].includes(c.args.join(' '))).length
      const before = listings()
      assert.ok(before > 0, 'the create read the listing')
      const res = await put('/v1/identity/users/shareuser', { enabled: false })
      assert.equal(res.statusCode, 202, res.body)
      assert.equal((await waitForQueueJob((res.json() as JobAccepted).job.id)).status, 'completed')
      assert.deepEqual(find(executor.calls, '/usr/sbin/usermod', () => true), ['--expiredate', '1', 'shareuser'])
      assert.equal(listings(), before, 'the disable (route and job) read no group listing')
    })

    it('cr.58r P4: create refuses a name that is a @pam login in user.cfg with no unix account — 409 SYSTEM_ACCOUNT, no useradd', async () => {
      await boot({ userCfg: 'user:bob@pam:1:1:::::,,,\n' })
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'bob'], result: NOT_FOUND })
      const res = await post('/v1/identity/users', { name: 'bob' })
      assert.equal(res.statusCode, 409, res.body)
      const { error } = res.json() as { error: { code: string, message: string } }
      assert.equal(error.code, 'SYSTEM_ACCOUNT')
      assert.match(error.message, /'bob' is a Proxmox VE login \('bob@pam'/)
      assert.match(error.message, /NOT created/)
      assert.equal(queue.list().length, 0)
      assert.equal(executor.calls.some(c => c.command === '/usr/sbin/useradd'), false)
    })
  })

  // --- cr.30 — delete refuses EVERY smb.conf name reference (review M6 #25) ---
  //
  // The identity.1d refusal scanned only `valid users`; cr.30 scans the full
  // parameter list of WAVE2-DESIGN §6 C4 — `valid users`, `invalid users`,
  // `read list`, `write list`, `admin users`, `force user`, `force group` —
  // with groups in every form the design names (`@`, `+`, `&`), plus `force
  // group`'s bare spelling. One refusal test per parameter and form, for the
  // user and the group verb, driven by the checked-in fixture
  // fixtures/samba/smb-identity-refs.conf — a SYNTHETIC conf authored for
  // these tests (one share per parameter, test-scaffold accounts), not a
  // capture from a machine.
  describe('cr.30 — delete refuses every smb.conf name reference', () => {
    let app: FastifyInstance | undefined
    let queue: JobQueue
    let tmpDir: string

    const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/samba/smb-identity-refs.conf')

    interface RefCase { share: string, parameter: string, user?: string, group?: string }
    const REF_CASES: RefCase[] = [
      { share: 'valid-users', parameter: 'valid users', user: 'vuser', group: 'vgroup' },
      { share: 'invalid-users', parameter: 'invalid users', user: 'iuser', group: 'igroup' },
      { share: 'read-list', parameter: 'read list', user: 'ruser', group: 'rgroup' },
      { share: 'write-list', parameter: 'write list', user: 'wuser', group: 'wgroup' },
      { share: 'admin-users', parameter: 'admin users', user: 'auser', group: 'agroup' },
      { share: 'force-user', parameter: 'force user', user: 'fuser' },
      { share: 'force-group-at', parameter: 'force group', group: 'fgroupat' },
      { share: 'force-group-bare', parameter: 'force group', group: 'fgroupbare' },
    ]

    const ok = (stdout: string): ExecResult => ({ stdout: `${stdout}\n`, stderr: '', exitCode: 0 })

    /**
     * A node whose smb.conf is the checked-in fixture (or `smbConfText`,
     * written to a temp file for the multi-reference case). Every account in
     * the table exists and is LOCAL, users at uid 1501+ and groups at gid
     * 1601+ (in the share band); no account holds another's gid as its
     * primary, so the group delete reaches the reference check. `extraUsers`
     * adds resolvable LOCAL users beyond the table (the multi-reference and
     * case-fold cases).
     */
    async function bootNode(opts: { smbConfText?: string, extraUsers?: string[] } = {}) {
      tmpDir = await mkdtemp(join(tmpdir(), 'anas-identity-cr30-'))
      const smbConfPath = opts.smbConfText !== undefined
        ? join(tmpDir, 'smb.conf')
        : FIXTURE
      if (opts.smbConfText !== undefined)
        writeFileSync(smbConfPath, opts.smbConfText)

      const executor = new MockExecutor()
      queue = new JobQueue()
      executor.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: ok('root:x:0:0:root:/root:/bin/bash') })
      executor.addFixture({ command: '/usr/bin/getent', args: ['group'], result: ok('root:x:0:') })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd'], result: ok('root:x:0:0:root:/root:/bin/bash') })
      executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group'], result: ok('root:x:0:') })
      const addUser = (name: string, uid: number) => {
        const line = `${name}:x:${uid}:100:Test user:/home/${name}:/usr/sbin/nologin`
        executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', name], result: ok(line) })
        executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', name], result: ok(line) })
      }
      const addGroup = (name: string, gid: number) => {
        const line = `${name}:x:${gid}:`
        executor.addFixture({ command: '/usr/bin/getent', args: ['group', name], result: ok(line) })
        executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group', name], result: ok(line) })
      }
      let uid = 1500
      let gid = 1600
      for (const c of REF_CASES) {
        if (c.user !== undefined)
          addUser(c.user, ++uid)
        if (c.group !== undefined)
          addGroup(c.group, ++gid)
      }
      // Namesakes for the form tests: a USER named like the `@vgroup` entry
      // and a GROUP named like the bare `vuser` entry.
      addUser('vgroup', 1570)
      addGroup('vuser', 1670)
      // The case-fold probe: same account, uppercase name resolves too.
      addUser('VUSER', 1580)
      for (const name of opts.extraUsers ?? [])
        addUser(name, ++uid)
      executor.addFixture({ command: '/usr/bin/pdbedit', args: ['-L'], result: ok('') })

      app = Fastify({ logger: false })
      await app.register(shareIdentityRoutes, {
        prefix: '/v1',
        executor,
        jobQueue: queue,
        confirmStore: new ConfirmStore(),
        smbConfPath,
        exportsPath: ABSENT_EXPORTS,
        smbpasswdAvailable: async () => true,
      })
    }

    function del(url: string) {
      return app!.inject({ method: 'DELETE', url, headers: IDENTITY_HEADERS })
    }

    afterEach(async () => {
      await app?.close()
      app = undefined
      await rm(tmpDir, { recursive: true, force: true })
    })

    /** The shared shape of a cr.30 refusal: hard 409, no code, no job. */
    function assertRefusal(res: Awaited<ReturnType<FastifyInstance['inject']>>, share: string, parameter: string) {
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(error.code, 'CONFLICT')
      assert.equal(error.reason, 'referenced-by-share')
      assert.match(error.message, new RegExp(share))
      assert.match(error.message, new RegExp(parameter))
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(queue.list().length, 0)
    }

    for (const c of REF_CASES) {
      if (c.user !== undefined) {
        it(`refuses a user named in '${c.parameter}' of [${c.share}]`, async () => {
          await bootNode()
          assertRefusal(await del(`/v1/identity/users/${c.user}`), c.share, c.parameter)
        })
      }
      if (c.group !== undefined) {
        it(`refuses a group named in '${c.parameter}' of [${c.share}]`, async () => {
          await bootNode()
          assertRefusal(await del(`/v1/identity/groups/${c.group}`), c.share, c.parameter)
        })
      }
    }

    it('the match is case-folded (Samba folds smb.conf names too)', async () => {
      await bootNode()
      assertRefusal(await del('/v1/identity/users/VUSER'), 'valid-users', 'valid users')
    })

    it('the REFUSAL names every share and every parameter — media (valid users, write list), archive (force user)', async () => {
      await bootNode({
        smbConfText: [
          '[global]',
          '\tworkgroup = WORKGROUP',
          '',
          '[media]',
          '\tpath = /tank/media',
          '\tvalid users = alice',
          '\twrite list = alice',
          '',
          '[archive]',
          '\tpath = /tank/archive',
          '\tforce user = alice',
          '',
        ].join('\n'),
        extraUsers: ['alice'],
      })
      const res = await del('/v1/identity/users/alice')
      assert.equal(res.statusCode, 409)
      const { error } = res.json() as { error: { reason: string, message: string } }
      assert.equal(error.reason, 'referenced-by-share')
      assert.match(error.message, /media \(valid users, write list\)/)
      assert.match(error.message, /archive \(force user\)/)
    })

    it('a USER whose name only appears in GROUP form (@vgroup) is not refused — the gate is reached', async () => {
      await bootNode()
      const res = await del('/v1/identity/users/vgroup')
      assert.equal(res.statusCode, 409)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
    })

    it('a GROUP whose name only appears in bare user form (vuser) is not refused — the gate is reached', async () => {
      await bootNode()
      const res = await del('/v1/identity/groups/vuser')
      assert.equal(res.statusCode, 409)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
    })
  })
})
