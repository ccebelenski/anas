import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'
import { SET_ACCESS_PRESENTATION_ONLY } from '../../services/access.js'

/**
 * Story cr.37 — `fs.setAccess` on the guard, at all three doors (the datasets
 * editor, the AHR editor, a share's Permissions; WAVE3-DESIGN §2.1/§2.3/§2.5
 * "set access" rows and F4). The plan is computed from the directory's live
 * ACL and restates the named grants it READ, so running it over an entry
 * added since would delete that entry. The plan's revision is bound: an ACL
 * entry added after the plan fails the job STATE_CHANGED with nothing
 * written, and a recursive confirm resent after it is 409 STATE_CHANGED.
 *
 * FIXTURES (ruling (l)): the live ACL is `acl/getfacl-pcE-dir-no-named.txt`
 * at the request and `acl/getfacl-pcE-dir-named-user.txt` once an entry was
 * added — two real captures of one directory before and after `setfacl -m
 * u:nobody:r-x` (acl/NOTES.md). PVE: `pve/storage.cfg` with its zfspool
 * storage re-pointed from `datapool` to `testpool/media`. The `stat` line for
 * the share path is the dev mock's own answer for its other directories.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const ZFS = '/usr/sbin/zfs'
const GETFACL = '/usr/bin/getfacl'
const STAT = '/usr/bin/stat'
const WRITERS = new Set(['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown', '/usr/bin/find'])

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const ACL_NO_NAMED = fixture('acl/getfacl-pcE-dir-no-named.txt')
const ACL_NAMED_USER = fixture('acl/getfacl-pcE-dir-named-user.txt')
const STORAGE_ON_MEDIA = rewrite(rewrite(fixture('pve/storage.cfg'), '\tpool datapool\n', '\tpool testpool/media\n'), '\tmountpoint /datapool\n', '\tmountpoint /testpool/media\n')

/** The dev mock's `vgs` capture with the `vg_uuid` column ident.3 appends (`-o +vg_uuid`); the value is typed. */
const VGS_WITH_UUID = rewrite(fixture('ahr/lvm-vgs.json'), '"vg_free":"0 "}', '"vg_free":"0 ", "vg_uuid":"c4Wd2E-1lQp-KdV8-fQ2k-3HbN-9zQe-Lx7T9a"}')
const VG_UUID = 'c4Wd2E-1lQp-KdV8-fQ2k-3HbN-9zQe-Lx7T9a'

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** A call that would mean the permissions were written (or an ACL switch flipped). */
function isWrite(c: { command: string, args: string[] }): boolean {
  return WRITERS.has(c.command) || (c.command === ZFS && c.args[0] === 'set')
}

/** The base three, nothing named: a base-only edit that PRESERVES the named grants the plan read. */
const BASE_ONLY = { entries: [{ kind: 'owner', level: 'read-write' }, { kind: 'owning-group', level: 'read' }, { kind: 'everyone', level: 'none' }] }

interface Door { name: string, url: string, dir: string }
const ZFS_DOOR: Door = { name: 'dataset', url: '/v1/pools/testpool/datasets/media/access', dir: '/testpool/media' }
const AHR_DOOR: Door = { name: 'AHR pool', url: '/v1/ahr/ahr0/access', dir: '/mnt/anas-ahr/ahr0' }
const SHARE_DOOR: Door = { name: 'SMB share', url: '/v1/shares/smb/media/access', dir: '/tank/media' }

describe('cr.37 — fs.setAccess binds its plan and the ACL revision (ruling (j), F4)', () => {
  let dir: string
  let storageCfg: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** The live ACL of every door's directory right now; a test flips it. */
  let acl = ACL_NO_NAMED
  /** `vgs` when set (null: the dev mock's own answer). */
  let vgs: string | null = null
  const savedStorage = process.env.ANAS_STORAGE_CFG

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr37-acl-'))
    storageCfg = join(dir, 'storage.cfg')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    if (savedStorage === undefined)
      delete process.env.ANAS_STORAGE_CFG
    else
      process.env.ANAS_STORAGE_CFG = savedStorage
  })

  async function serve(): Promise<void> {
    acl = ACL_NO_NAMED
    vgs = null
    await rm(storageCfg, { force: true })
    process.env.ANAS_STORAGE_CFG = storageCfg
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    const dirs = new Set([ZFS_DOOR.dir, AHR_DOOR.dir, SHARE_DOOR.dir])
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      // testpool/media with POSIX ACLs on, so its live ACL is read.
      if (command === ZFS && args.join(' ') === 'get -Hp -o value acltype -- testpool/media')
        return ok('posixacl\n')
      if (command === GETFACL && args[0] === '-pcE' && dirs.has(args[1]))
        return ok(acl)
      if (command === '/usr/sbin/vgs' && vgs !== null)
        return ok(vgs)
      if (command === STAT && args[2] === SHARE_DOOR.dir)
        return ok('root root 755\n')
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  function put(door: Door, body: unknown, confirm?: string) {
    return server!.inject({
      method: 'PUT',
      url: door.url,
      headers: confirm ? { ...JSON_HEADERS, 'x-anas-confirm': confirm } : JSON_HEADERS,
      payload: JSON.stringify(body),
    })
  }

  function fillSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  /** Accept the edit while all four slots are held, flip, release; return the finished job. */
  async function race(door: Door, flip: () => Promise<void> | void): Promise<Job> {
    await serve()
    const release = fillSlots()
    const res = await put(door, BASE_ONLY)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued')
    await flip()
    release()
    return finished(id)
  }

  it('control: with nothing changed the held edit runs at every door and restates the grants it read', async () => {
    for (const door of [ZFS_DOOR, AHR_DOOR, SHARE_DOOR]) {
      const job = await race(door, () => {})
      assert.equal(job.status, 'completed', `${door.name}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(isWrite), `${door.name} wrote`)
      await server!.close()
      server = undefined
    }
  })

  it('an ACL entry added while the job waits fails it STATE_CHANGED at every door — nothing written', async () => {
    for (const door of [ZFS_DOOR, AHR_DOOR, SHARE_DOOR]) {
      const job = await race(door, () => {
        acl = ACL_NAMED_USER
      })
      assert.equal(job.status, 'failed', door.name)
      assert.equal(job.error?.code, 'STATE_CHANGED', door.name)
      assert.match(job.error!.message, /changed since you confirmed — nothing was done; reload and confirm again$/, door.name)
      assert.deepEqual(calls.filter(isWrite), [], `${door.name}: nothing written`)
      await server!.close()
      server = undefined
    }
  })

  it('dataset: a PVE storage registered on the dataset while the job waits refuses it (ownership re-run) — nothing written', async () => {
    const job = await race(ZFS_DOOR, () => writeFile(storageCfg, STORAGE_ON_MEDIA))
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'VALIDATION_ERROR')
    assert.match(job.error!.message, /datapool/)
    assert.deepEqual(calls.filter(isWrite), [])
  })

  it('recursive: an ACL entry added between the challenge and the resend is 409 STATE_CHANGED with a fresh code — nothing written', async () => {
    await serve()
    const body = { ...BASE_ONLY, applyToExisting: true }
    const first = await put(ZFS_DOOR, body)
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED')
    acl = ACL_NAMED_USER
    const res = await put(ZFS_DOOR, body, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'STATE_CHANGED')
    assert.ok(res.headers['x-anas-confirm-code'])
    // The fresh code confirms the request against the ACL as it is now.
    const again = await put(ZFS_DOOR, body, res.headers['x-anas-confirm-code'] as string)
    assert.equal(again.statusCode, 202, again.body)
    assert.equal((await finished((again.json() as JobAccepted).job.id)).status, 'completed')
  })

  it('recursive: the confirm signs the whole request — a resend with other entries is CONFIRM_SCOPE_CHANGED naming them', async () => {
    await serve()
    const body = { ...BASE_ONLY, applyToExisting: true }
    const first = await put(ZFS_DOOR, body)
    const other = { entries: [{ kind: 'owner', level: 'read-write' }, { kind: 'owning-group', level: 'read-write' }, { kind: 'everyone', level: 'read' }], applyToExisting: true }
    const res = await put(ZFS_DOOR, other, first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
    assert.deepEqual(res.json().error.changed, ['entries'])
    assert.deepEqual(calls.filter(isWrite), [])
  })

  it('cr.33: a dataset edit claims the dataset exclusive; an AHR edit claims the pool', async () => {
    await serve()
    const release = fillSlots()
    const zfsJob = (await put(ZFS_DOOR, BASE_ONLY)).json() as JobAccepted
    const ahrJob = (await put(AHR_DOOR, BASE_ONLY)).json() as JobAccepted
    const waiting = queue().get(zfsJob.job.id)
    assert.equal(waiting?.status, 'queued')
    release()
    // Both are granted at once (different objects); look while they hold.
    const claims = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs
    assert.deepEqual(claims.get(zfsJob.job.id)?.claims.map(c => [c.key.replace(/\d+/g, 'N'), c.mode]), [
      ['zfs:N/media', 'exclusive'],
      ['zfs:N', 'shared'],
      ['zpool:N', 'shared'],
    ])
    // The dev mock's `vgs` capture (ahr/lvm-vgs.json) predates ident.3's
    // `+vg_uuid`, so ahr0 has no VG UUID: §4.2's fallback, the name key, exclusive.
    assert.deepEqual(claims.get(ahrJob.job.id)?.claims.map(c => [c.key, c.mode]), [['ahrname:ahr0', 'exclusive']])
    assert.equal((await finished(zfsJob.job.id)).status, 'completed')
    assert.equal((await finished(ahrJob.job.id)).status, 'completed')
  })

  it('cr.33: an AHR pool whose VG UUID LVM reports is claimed by it, shared', async () => {
    await serve()
    vgs = VGS_WITH_UUID
    const release = fillSlots()
    const ahrJob = (await put(AHR_DOOR, BASE_ONLY)).json() as JobAccepted
    const claims = (queue() as unknown as { jobs: Map<string, { claims: { key: string, mode: string }[] }> }).jobs
    assert.deepEqual(claims.get(ahrJob.job.id)?.claims.map(c => [c.key, c.mode]), [[`ahr:${VG_UUID}`, 'shared']])
    release()
    assert.equal((await finished(ahrJob.job.id)).status, 'completed')
  })

  it('the recursive confirm leaves no request field out of the signature', () => {
    assert.deepEqual(SET_ACCESS_PRESENTATION_ONLY, {})
  })
})
