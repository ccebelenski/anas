import type { AccessEntry, DatasetAccess, Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { SetAccessRequest } from '@anas/shared'
import { createServer } from '../../server.js'

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

interface Call { command: string, args: string[] }
interface Stub { command: string, args?: string[], result: ExecResult }

/**
 * Wrap the mock executor to (a) record every command/args issued and (b) return
 * canned results for chosen commands (stubs) before delegating. This lets a test
 * pose the dataset as acltype=posixacl (or off), with specific getfacl output,
 * that the fixed dev fixtures can't model — while still asserting the exact
 * setfacl/chmod/chown/zfs argument arrays the route constructs.
 */
function installExecutor(server: ReturnType<typeof createServer>, stubs: Stub[] = []): Call[] {
  const mock = (server as any).executor as MockExecutor
  const calls: Call[] = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    const stub = stubs.find(s =>
      s.command === command
      && (s.args === undefined
        || (s.args.length === args.length && s.args.every((a, i) => a === args[i]))),
    )
    if (stub)
      return stub.result
    return orig(command, args)
  }
  return calls
}

const ACLTYPE_MEDIA = ['get', '-Hp', '-o', 'value', 'acltype', 'testpool/media']
const MP = '/testpool/media'

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function find(calls: Call[], command: string, pred: (a: string[]) => boolean): string[] | undefined {
  return calls.find(c => c.command === command && pred(c.args))?.args
}

describe('access routes', () => {
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  // --- GET /access -------------------------------------------------------
  describe('GET /v1/pools/:name/datasets/*path/access', () => {
    it('maps a live POSIX ACL into base + named entries', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.aclSupported, true)
      assert.equal(data.aclEnabled, true)
      assert.equal(data.owner, 'root')
      assert.ok(data.aclText && data.aclText.includes('user::rwx'))

      const byKind = (kind: string, name?: string) =>
        data.entries.find((e: AccessEntry) => e.kind === kind && e.name === name)
      assert.equal(byKind('owner')?.level, 'read-write') // user::rwx
      assert.equal(byKind('owning-group')?.level, 'read') // group::r-x
      assert.equal(byKind('everyone')?.level, 'none') // other::---
      assert.equal(byKind('user', 'alice')?.level, 'read-write') // user:alice:rwx
    })

    it('flags a named entry whose uid no longer resolves as unresolved', async () => {
      server = createServer({ mock: true, logger: false })
      // A user deleted outside ANAS leaves a bare-numeric ACL entry.
      installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(
          'user::rwx\nuser:1002:r-x\ngroup::r-x\nmask::rwx\nother::---\n',
        ) },
      ])

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      const orphan = data.entries.find((e: AccessEntry) => e.kind === 'user' && e.name === '1002')
      assert.ok(orphan, 'numeric named entry present')
      assert.equal(orphan?.unresolved, true)
      assert.equal(orphan?.level, 'read')
    })

    it('derives base three from mode bits when ACLs are disabled', async () => {
      server = createServer({ mock: true, logger: false })
      // acltype fixture is 'off' → mode-only path; stat fixture is 755.
      installExecutor(server)

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.aclEnabled, false)
      assert.equal(data.aclText, null)
      assert.equal(data.entries.length, 3)
      assert.equal(data.entries.find(e => e.kind === 'owner')?.level, 'read-write') // 7
      assert.equal(data.entries.find(e => e.kind === 'owning-group')?.level, 'read') // 5
      assert.equal(data.entries.find(e => e.kind === 'everyone')?.level, 'read') // 5
    })

    it('404s for an unknown dataset', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/nope/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
    })

    it('404s for a non-filesystem (volume / unmounted) dataset', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{
        command: '/usr/sbin/zfs',
        args: ['get', '-j', 'all', 'testpool/vol'],
        result: ok(JSON.stringify({ datasets: { 'testpool/vol': { name: 'testpool/vol', type: 'VOLUME', properties: {} } } })),
      }])
      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/vol/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 404)
      assert.match(res.json().error.message, /not a mounted filesystem/)
    })
  })

  // --- PUT /access: base-only (mode bits) --------------------------------
  describe('PUT /v1/pools/:name/datasets/*path/access — base only', () => {
    it('issues a single chmod and no ACL commands', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server)

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'none' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const body = res.json() as JobAccepted
      assert.equal(body.job.operation, 'fs.setAccess')
      const job = await waitForJob(server, body.job.id)
      assert.equal(job.status, 'completed')

      // owner=rwx(7), group=r-x(5), everyone=---(0) → 750
      assert.deepEqual(find(calls, '/usr/bin/chmod', () => true), ['750', MP])
      assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
      assert.equal(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), undefined)
    })

    it('recursive base-only chmod uses symbolic X, not a blanket numeric +x', async () => {
      // A recursive Read grant must not sprinkle execute onto plain data files:
      // the base-only chmod uses capital X so only directories gain execute.
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server) // acltype 'off' → base-only path

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          entries: [
            { kind: 'owner', level: 'read-write' },
            { kind: 'owning-group', level: 'read' },
            { kind: 'everyone', level: 'read' },
          ],
          applyToExisting: true,
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      // Symbolic mode with X (owner rwX, group rX, other rX) — never a numeric octal.
      const chmod = find(calls, '/usr/bin/chmod', a => a[0] === '-R')
      assert.deepEqual(chmod, ['-R', 'u=rwX,g=rX,o=rX', MP])
      assert.ok(chmod && chmod[1].includes('X'), 'recursive chmod mode uses capital X')
      assert.equal(find(calls, '/usr/bin/chmod', a => /^[0-7]{3,4}$/.test(a[1] ?? '')), undefined)
    })
  })

  // --- PUT /access: base-level fallback reads the real ACL, not the mask --
  describe('PUT /v1/pools/:name/datasets/*path/access — ACL mask fallback', () => {
    it('an omitted owning-group falls back to group::, not the ACL mask', async () => {
      // acltype=posixacl, group::r-x (read) but mask::rwx so the mode group digit
      // is 7 (rwx). A PUT that omits owning-group must keep it at read (g::r-x),
      // NOT escalate it to read-write by reading the mask digit off the mode.
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        // stat reports mode 775 — group digit 7 is the MASK, not group::.
        { command: '/usr/bin/stat', args: ['-c', '%U %G %a', MP], result: ok('root root 775\n') },
        // Live ACL: real owning-group level is r-x (read), mask is rwx.
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: ok(
          'user::rwx\ngroup::r-x\nmask::rwx\nother::---\n',
        ) },
      ])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        // Omits owning-group; includes a named entry so the setfacl --set path runs.
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'everyone', level: 'none' },
          { kind: 'user', name: 'alice', level: 'read-write' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      const setArgs = find(calls, '/usr/bin/setfacl', a => a[0] === '--set')
      assert.ok(setArgs, 'setfacl --set was issued')
      const spec = setArgs![1]
      assert.ok(spec.includes('g::r-x'), `spec keeps group at read: ${spec}`)
      assert.ok(!spec.includes('g::rwx'), `spec must NOT escalate group to rwx: ${spec}`)
      assert.equal(spec, 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx')
    })
  })

  // --- PUT /access: add a named user on an acltype=off dataset ------------
  describe('PUT /v1/pools/:name/datasets/*path/access — named grant', () => {
    it('enables acltype, sets the access + default ACL, and sets setgid', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server) // acltype fixture 'off'

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'none' },
          { kind: 'user', name: 'alice', level: 'read-write' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.equal((job.result as { aclAutoEnabled: boolean }).aclAutoEnabled, true)

      // acltype auto-enabled first.
      assert.deepEqual(find(calls, '/usr/sbin/zfs', a => a[0] === 'set'), ['set', 'acltype=posixacl', 'xattr=sa', 'testpool/media'])

      const expectSpec = 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx'
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '--set'), ['--set', expectSpec, MP])
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-d'), ['-d', '--set', expectSpec, MP])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('g+s')), ['g+s', MP])
    })

    it('fails the job clearly when the acl package is absent', async () => {
      server = createServer({ mock: true, logger: false })
      installExecutor(server, [{ command: '/usr/bin/getfacl', args: ['--version'], result: { stdout: '', stderr: 'not found', exitCode: 127 } }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ entries: [{ kind: 'user', name: 'alice', level: 'read-write' }] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'failed')
      assert.match(job.error!.message, /acl package/)
    })
  })

  // --- PUT /access: remove all named entries (back to mode bits) ----------
  // Removal is EXPLICIT (#37): `clearNamed: true`. An entries list that simply
  // carries no named row means "not changing the grants" — see the regression
  // suite below for why an empty list must never be read as "delete them all".
  describe('PUT /v1/pools/:name/datasets/*path/access — remove named', () => {
    it('clears the ACL then chmods when clearNamed is requested on an ACL dataset', async () => {
      server = createServer({ mock: true, logger: false })
      // Pose the dataset as posixacl with a live named entry (server fixture
      // getfacl -pcE returns alice), so the explicit clear must strip it.
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ clearNamed: true, entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'read' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')
      assert.equal((job.result as { clearedNamed: boolean }).clearedNamed, true)

      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), ['-b', '-k', MP])
      // Clearing the ACLs also drops the setgid bit we set for inheritance, so
      // the reported mode is the whole truth (no misleading 2775).
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('g-s')), ['g-s', MP])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('755')), ['755', MP]) // 7,5,5
    })

    it('recursively clears the ACL then folds setgid-drop into a single chmod -R', async () => {
      server = createServer({ mock: true, logger: false })
      // Same posixacl dataset with a live named entry, but applyToExisting so the
      // whole subtree is walked. The setgid-clear must ride along with the mode
      // chmod (one `-R` traversal), not be a second independent recursive walk.
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ clearNamed: true, entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'read' },
        ], applyToExisting: true }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      // The ACL clear is a different tool (setfacl) and stays recursive.
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), ['-R', '-b', '-k', MP])
      // A SINGLE recursive chmod carries both the base perms (symbolic X) and the
      // setgid-drop clause — not two `chmod -R` walks.
      const chmodR = calls.filter(c => c.command === '/usr/bin/chmod' && c.args[0] === '-R')
      assert.equal(chmodR.length, 1, 'exactly one recursive chmod')
      assert.deepEqual(chmodR[0].args, ['-R', 'u=rwX,g=rX,o=rX,g-s', MP])
      // No standalone `chmod -R g-s`.
      assert.equal(find(calls, '/usr/bin/chmod', a => a.length === 3 && a[0] === '-R' && a[1] === 'g-s'), undefined)
    })
  })

  // --- #37: named grants are never destroyed by omission ------------------
  //
  // The bug: the Permissions dialog's pre-fill failed open (warn + null), the
  // window stayed live with hard-coded defaults and an EMPTY named grid, and
  // Apply sent that empty list. The daemon read "no named entries + base
  // changed" as "delete every named grant", stripped the ACL, and reported the
  // job as a success. The contract now: absence is not intent.
  describe('PUT /v1/pools/:name/datasets/*path/access — implicit-clear guard (#37)', () => {
    it('a base-only update with no named entries LEAVES existing named ACLs alone', async () => {
      server = createServer({ mock: true, logger: false })
      // posixacl dataset whose live ACL grants alice rwx (server fixture).
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        // Exactly the payload the fail-open dialog used to send.
        payload: JSON.stringify({ entries: [
          { kind: 'owner', level: 'read-write' },
          { kind: 'owning-group', level: 'read' },
          { kind: 'everyone', level: 'none' },
        ] }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      // NOTHING is stripped: no `setfacl -b`, no setgid drop.
      assert.equal(find(calls, '/usr/bin/setfacl', a => a.includes('-b')), undefined)
      assert.equal(find(calls, '/usr/bin/chmod', a => a.includes('g-s')), undefined)
      // alice survives, restated in the declarative set alongside the new base
      // levels — and the base lands on `g::`, not on the ACL mask a chmod would
      // have moved instead.
      const spec = find(calls, '/usr/bin/setfacl', a => a[0] === '--set')
      assert.deepEqual(spec, ['--set', 'u::rwx,g::r-x,o::---,u:alice:rwx,m::rwx', MP])
      assert.equal((job.result as { namedCount: number }).namedCount, 1)
    })

    it('an owner-only update touches neither the ACL nor the mode bits', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server, [{ command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') }])

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ owner: 'media' }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      assert.deepEqual(find(calls, '/usr/bin/chown', () => true), ['media', MP])
      assert.equal(find(calls, '/usr/bin/setfacl', () => true), undefined)
      assert.equal(find(calls, '/usr/bin/chmod', () => true), undefined)
    })

    it('the request schema requires an explicit flag for a destructive clear', async () => {
      // Class guard: a list-valued field whose emptiness would destroy data must
      // never carry that meaning implicitly. Asserted on the SCHEMA so a future
      // field that infers "clear" from an empty list is caught here.
      const noFlag = SetAccessRequest.parse({ entries: [{ kind: 'owner', level: 'read' }] })
      assert.equal(noFlag.clearNamed, undefined, 'an empty named list carries no clear intent')
      assert.equal(SetAccessRequest.parse({ clearNamed: true }).clearNamed, true)
      // The flag and named entries are contradictory — refused at the boundary.
      const contradiction = SetAccessRequest.safeParse({
        clearNamed: true,
        entries: [{ kind: 'user', name: 'alice', level: 'read' }],
      })
      assert.equal(contradiction.success, false)
    })

    it('an unreadable getfacl is reported as degraded, not as healthy ACLs', async () => {
      server = createServer({ mock: true, logger: false })
      // acltype says posixacl but the ACL itself cannot be read.
      installExecutor(server, [
        { command: '/usr/sbin/zfs', args: ACLTYPE_MEDIA, result: ok('posixacl\n') },
        { command: '/usr/bin/getfacl', args: ['-pcE', MP], result: { stdout: '', stderr: 'Permission denied', exitCode: 1 } },
      ])

      const res = await server.inject({ method: 'GET', url: '/v1/pools/testpool/datasets/media/access', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: DatasetAccess }
      assert.equal(data.aclDegraded, true, 'the degradation is surfaced')
      // The entries are a mode-bit approximation with no named grants in them —
      // reporting aclEnabled:true would invite the client to apply that as truth.
      assert.equal(data.aclEnabled, false)
      assert.equal(data.entries.length, 3)
    })
  })

  // --- PUT /access: applyToExisting recurses ------------------------------
  describe('PUT /v1/pools/:name/datasets/*path/access — applyToExisting', () => {
    it('adds -R to chown, setfacl (access + default), and chmod g+s, using X for read', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = installExecutor(server) // acltype 'off'

      const res = await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/datasets/media/access',
        headers: JSON_HEADERS,
        payload: JSON.stringify({
          owner: 'media',
          entries: [
            { kind: 'owner', level: 'read-write' },
            { kind: 'owning-group', level: 'read' },
            { kind: 'everyone', level: 'read' },
            { kind: 'user', name: 'alice', level: 'read' },
          ],
          applyToExisting: true,
        }),
      })
      assert.equal(res.statusCode, 202)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed')

      assert.deepEqual(find(calls, '/usr/bin/chown', () => true), ['-R', 'media', MP])
      // Recursive → read levels use capital X so files don't gain execute.
      const spec = 'u::rwx,g::r-X,o::r-X,u:alice:r-X,m::rwx'
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-R' && a[1] === '--set'), ['-R', '--set', spec, MP])
      assert.deepEqual(find(calls, '/usr/bin/setfacl', a => a[0] === '-R' && a[1] === '-d'), ['-R', '-d', '--set', spec, MP])
      assert.deepEqual(find(calls, '/usr/bin/chmod', a => a.includes('g+s')), ['-R', 'g+s', MP])
    })
  })
})
