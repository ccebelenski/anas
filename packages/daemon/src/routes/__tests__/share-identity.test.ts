import type { Job, JobAccepted, ShareGroup, ShareUser } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { createServer } from '../../server.js'

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

    it('creates a user with an SMB password (smbpasswd) and completes', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'POST',
        url: '/v1/identity/users',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'bob', smbPassword: 'hunter2' }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { created: 'bob', smbEnabled: true })
    })

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
})
