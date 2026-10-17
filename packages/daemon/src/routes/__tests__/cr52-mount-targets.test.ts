import type { Job, JobAccepted } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../server.js'
import { serveBlankInventoryDisks } from './inventory-stub.js'

/**
 * Story cr.52 (review H1 + L4's daemon half): ONE shared `mountTargetRefusal`
 * at EVERY door that sets a mountpoint — remote mount, pool create and
 * mountpoint change, dataset create, AHR create and
 * mountpoint — asked at the route AND in the job, answering 409 CONFLICT with
 * the one reason `system-mount-target`. Probes over the REAL routes and the
 * fake executor: every refused door refuses, a planted symlink in the parent
 * chain is caught by realpath, legal mountpoints still 202 / confirm as before,
 * and a job that waits in a full queue re-runs the gate when the filesystem
 * swerves between the two doors.
 *
 * The mounts door's legal-202s use tmpdir paths (the create job MKDIRs its
 * mountpoint on the real filesystem, so the tests never write to the host's
 * `/srv` or `/mnt`); the `/srv` and `/mnt/anas-*` legal shapes are proven
 * through the pool door, whose `-m` argv the mock swallows.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const ZFS = '/usr/sbin/zfs'
const ZPOOL = '/usr/sbin/zpool'
const MOUNT = '/usr/bin/mount'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

function refusalIs(res: Awaited<ReturnType<FastifyInstance['inject']>>): string {
  assert.equal(res.statusCode, 409, res.body)
  const { error } = res.json() as { error: { code: string, reason: string, message: string } }
  assert.equal(error.code, 'CONFLICT', res.body)
  assert.equal(error.reason, 'system-mount-target', res.body)
  return error.message
}

/** Poll a job until it reaches a terminal state. */
async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 80; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** Record every command the mock executor issues. */
function spyExecutor(server: ReturnType<typeof createServer>): Array<{ command: string, args: string[] }> {
  const mock = (server as unknown as { executor: MockExecutor }).executor
  const calls: Array<{ command: string, args: string[] }> = []
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return orig(command, args)
  }
  return calls
}

function mountpointReservedByPveFirst(res: Awaited<ReturnType<FastifyInstance['inject']>>): void {
  assert.equal(res.statusCode, 409, res.body)
  const { error } = res.json() as { error: { code: string } }
  assert.notEqual(error.code, 'CONFIRMATION_REQUIRED', res.body)
  assert.notEqual(error.code, 'VALIDATION_ERROR', res.body)
}

describe('cr.52 — one shared mountTargetRefusal at every mountpoint door', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let fstabPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr52-'))
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, fixture('mounts/fstab-anas-managed'))
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'pve/storage.cfg')
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
    await rm(dir, { recursive: true, force: true })
  })

  // --- The remote mount door ----------------------------------------------
  describe('remote mount add', () => {
    const create = (mountpoint: string, mountNow = false) => server!.inject({
      method: 'POST',
      url: '/v1/mounts',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint, persistent: false, mountNow }),
    })

    it('refuses /root/.ssh with the shared 409 — the credential tree cr.18 let pass', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const message = refusalIs(await create('/root/.ssh'))
      assert.match(message, /protected/)
      assert.deepEqual(calls.filter(c => c.command === MOUNT), [], 'no mount argv')
      assert.equal(await readFile(fstabPath, 'utf8'), fixture('mounts/fstab-anas-managed'), 'fstab untouched')
    })

    it('refuses /var/spool/cron and /var/lib/pve with the shared 409', async () => {
      server = createServer({ mock: true, logger: false })
      refusalIs(await create('/var/spool/cron'))
      refusalIs(await create('/var/lib/pve'))
    })

    it('a planted symlink in the PARENT chain is refused by realpath, not the lexical list', async () => {
      server = createServer({ mock: true, logger: false })
      // A legal-looking mountpoint under a real directory that is actually a
      // symlink to /etc — the typed path trips nothing, the resolved one does.
      const mnt = join(dir, 'mnt')
      await mkdir(mnt)
      await symlink('/etc', join(mnt, 'laundered'))
      // cr.52r D2/D3: a symlink ANYWHERE in the existing parent chain is
      // refused outright (the flyleaf is named), not only when it launders.
      const message = refusalIs(await create(join(mnt, 'laundered', 'data')))
      assert.match(message, /laundered/)
      assert.match(message, /is a symlink/)
    })

    it('a legal (tmpdir-mounted) mountpoint still 202s and completes', async () => {
      // The create job MKDIRs the mountpoint on the real filesystem, so the
      // mounts door's legal-202 shapes use the tmpdir — never the host's /mnt.
      // The /mnt/anas-* and /srv legal shapes are proven through the pool door
      // below, whose `-m` argv the mock swallows.
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const mp = join(dir, 'anas-legal')
      const res = await create(mp, true) // mountNow: the job runs the mount argv
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const mountCall = calls.find(c => c.command === MOUNT)
      assert.ok(mountCall, 'the mountNow path ran the mount argv')
      assert.equal(mountCall!.args[0], '-c', 'cr.52: the mount job runs mount -c (canonicalised target)')
    })

    it('cr.52r D3 — the mountNow job mounts DIRECTLY through the daemon-opened dir: argv carries /proc/self/fd/3, fdPaths records the directory', async () => {
      server = createServer({ mock: true, logger: false })
      const mp = join(dir, 'anas-d3-legal')
      const res = await create(mp, true)
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const mock = (server as unknown as { executor: MockExecutor }).executor
      const mountCall = mock.calls.find(c => c.command === MOUNT)
      assert.ok(mountCall, 'the mountNow job ran a mount argv')
      assert.equal(mountCall!.args.at(-1), '/proc/self/fd/3')
      assert.equal(mountCall!.fdPaths?.[0], mp, 'the inherited fd resolves to the opened mountpoint directory')
    })

    it('a non-empty existing directory confirms exactly as before (L4: sentence names §2)', async () => {
      server = createServer({ mock: true, logger: false })
      const mp = join(dir, 'occupied')
      await mkdir(mp)
      await writeFile(join(mp, 'x.txt'), 'stay')
      const first = await create(mp)
      assert.equal(first.statusCode, 409, first.body)
      const body = first.json() as { error: { code: string, message: string } }
      assert.equal(body.error.code, 'CONFIRMATION_REQUIRED', first.body)
      assert.match(body.error.message, /mountpoint must be an empty directory/, 'the confirm agrees with §2 Mounts')
      const res = await server.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: { ...JSON_HEADERS, 'x-anas-confirm': first.headers['x-anas-confirm-code'] as string },
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: mp, persistent: false, mountNow: false }),
      })
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
    })
  })

  // --- Pool create and mountpoint change ------------------------------------
  describe('ZFS pool doors', () => {
    const DISK_IDS = ['d1', 'd2']
    const create = (mountpoint: string | undefined) => server!.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'newpool', dataVdevs: [{ type: 'mirror', disks: DISK_IDS }], mountpoint }),
    })
    const move = (mountpoint: string) => server!.inject({
      method: 'PUT',
      url: '/v1/pools/testpool/mountpoint',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ mountpoint }),
    })

    it('pool create at /etc → 409, never a zpool create argv (H1 reads the route over the fake)', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const message = refusalIs(await create('/etc'))
      assert.match(message, /system path/)
      assert.ok(!calls.some(c => c.command === ZPOOL && c.args[0] === 'create'), 'no zpool create')
    })

    it('pool mountpoint change to /etc → 409 (NOT a confirm), no zfs set', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const res = await move('/etc')
      mountpointReservedByPveFirst(res)
      refusalIs(res)
      assert.ok(!calls.some(c => c.command === ZFS && c.args[0] === 'set'), 'no zfs set')
      assert.equal(res.json().error.code, 'CONFLICT')
    })

    it('legal mountpoints under /mnt/anas-* and /srv still create — 202 and the job completes', async () => {
      server = createServer({ mock: true, logger: false })
      serveBlankInventoryDisks(server, DISK_IDS)
      for (const mp of ['/mnt/anas-tank/data', '/srv/tank-data']) {
        const res = await create(mp)
        assert.equal(res.statusCode, 202, `${mp}: ${res.body}`)
        const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
        assert.equal(job.status, 'completed', `${mp}: ${JSON.stringify(job.error)}`)
      }
    })
  })

  // --- Dataset create ------------------------------------------------------
  describe('dataset doors', () => {
    const createDataset = (mountpoint: string) => server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/datasets',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ path: 'cr52probe', properties: { mountpoint } }),
    })

    it('dataset create with mountpoint=/usr/bin → 409, no zfs create (H1 probe line)', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const message = refusalIs(await createDataset('/usr/bin'))
      assert.match(message, /system path/)
      assert.ok(!calls.some(c => c.command === ZFS && c.args[0] === 'create'), 'no zfs create')
    })

    it('dataset create with a legal /srv mountpoint still 202s and creates', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const res = await createDataset('/srv/cr52-legal')
      assert.equal(res.statusCode, 202, res.body)
      const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      const createArgs = calls.find(c => c.command === ZFS && c.args[0] === 'create')?.args
      assert.ok(createArgs?.includes('mountpoint=/srv/cr52-legal'), JSON.stringify(createArgs))
    })

    it('AHR create at /etc → 409 before any disk is touched', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const res = await server.inject({
        method: 'POST',
        url: '/v1/ahr',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'apro', tier: 'ahr1', disks: ['d1'], mountpoint: '/etc' }),
      })
      const message = refusalIs(res)
      assert.match(message, /system path/)
      assert.ok(!calls.some(c => ['/usr/sbin/wipefs', '/usr/sbin/sgdisk'].includes(c.command)), 'no disk touched')
    })

    it('AHR mountpoint change to /etc → 409, not a confirm', async () => {
      server = createServer({ mock: true, logger: false })
      const res = await server.inject({
        method: 'PUT',
        url: '/v1/ahr/ahr0/mountpoint',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ mountpoint: '/etc' }),
      })
      mountpointReservedByPveFirst(res)
      refusalIs(res)
    })
  })

  // --- The job re-gate (full-queue pattern, like mover-source-locks) --------
  describe('the job re-runs the refusal under its lock', () => {
    it('a remote mount whose parent becomes a symlink while it waits in a full queue refuses in the job — no mkdir, no mount', async () => {
      server = createServer({ mock: true, logger: false })
      const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
      const calls = spyExecutor(server)

      // A legal mountpoint: a real, empty directory under the tmpdir.
      const mnt = join(dir, 'mnt')
      await mkdir(mnt)
      const mp = join(mnt, 'target')

      // Fill the four queue slots so the accepted create sits QUEUED.
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      for (let i = 0; i < 4; i++)
        queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)

      const res = await server.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: mp, persistent: false, mountNow: true }),
      })
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as JobAccepted).job.id
      assert.equal(queue.get(id)?.status, 'queued', 'the create waits behind the held slots')

      // The flip: the parent is swapped for a symlink to /etc while the job waits.
      await rmdir(mnt)
      await symlink('/etc', mnt)

      release()
      const job = await waitForJob(server, id)
      assert.equal(job.status, 'failed', JSON.stringify(job))
      assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
      assert.match(job.error!.message, /parent path is a symlink/)
      assert.ok(!calls.some(c => c.command === MOUNT), 'no mount argv ran')
      // The flip swapped the parent for a symlink to /etc, so the job's mkdir
      // would have created /etc/target. The refusal stopped the job BEFORE the
      // body — prove nothing landed on the real system through the symlink.
      const fsProbe = await import('node:fs/promises')
      const lstatTarget = await fsProbe.lstat('/etc/target').then(() => true, () => false)
      assert.equal(lstatTarget, false, 'the refused job never mkdir\'d through the planted symlink')
    })
  })

  // ---------------------------------------------------------------------------
  // cr.52r — the refined rules, probed at the real doors
  // ---------------------------------------------------------------------------

  // --- D1: an ANCESTOR of a protected root refuses at every door ------------
  describe('cr.52r D1 — an ancestor of a protected root refuses at every door', () => {
    // `/var/spool` is strictly ABOVE `/var/spool/cron` — a mount there would
    // hide the subtree the protected root guards (cr.52r D1: only the
    // "at or under" rule existed before, so `/home/alice`, `/var/spool`,
    // `/var/lib` and `/mnt` all slipped through).
    const ANCESTOR = '/var/spool'
    const ancestorSentence = (message: string): void => assert.match(message, /an ancestor of the protected '/)

    it('remote mount at an ancestor of a protected root → 409', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      ancestorSentence(refusalIs(await server.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: ANCESTOR, persistent: false }),
      })))
      assert.deepEqual(calls.filter(c => c.command === MOUNT), [])
    })

    it('every one of the four pre-D1 ancestors refuses at the remote door — /home/alice, /var/spool, /var/lib, /mnt', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      for (const ancestor of ['/home/alice', '/var/spool', '/var/lib', '/mnt']) {
        const message = refusalIs(await server.inject({
          method: 'POST',
          url: '/v1/mounts',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: ancestor, persistent: false }),
        }))
        ancestorSentence(message)
      }
      assert.deepEqual(calls.filter(c => c.command === MOUNT), [])
    })

    it('pool create at an ancestor → 409, never a zpool create', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      ancestorSentence(refusalIs(await server.inject({
        method: 'POST',
        url: '/v1/pools',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'ancpool', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }], mountpoint: ANCESTOR }),
      })))
      assert.ok(!calls.some(c => c.command === ZPOOL && c.args[0] === 'create'))
    })

    it('pool mountpoint change to an ancestor → 409, no zfs set', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      ancestorSentence(refusalIs(await server.inject({
        method: 'PUT',
        url: '/v1/pools/testpool/mountpoint',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ mountpoint: ANCESTOR }),
      })))
      assert.ok(!calls.some(c => c.command === ZFS && c.args[0] === 'set'))
    })

    it('dataset create at an ancestor → 409, no zfs create', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      ancestorSentence(refusalIs(await server.inject({
        method: 'POST',
        url: '/v1/pools/testpool/datasets',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ path: 'ancds', properties: { mountpoint: ANCESTOR } }),
      })))
      assert.ok(!calls.some(c => c.command === ZFS && c.args[0] === 'create'))
    })

    it('AHR create at an ancestor → 409 before any disk is touched', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      ancestorSentence(refusalIs(await server.inject({
        method: 'POST',
        url: '/v1/ahr',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'ancpool', tier: 'ahr1', disks: ['d1'], mountpoint: ANCESTOR }),
      })))
      assert.ok(!calls.some(c => ['/usr/sbin/wipefs', '/usr/sbin/sgdisk'].includes(c.command)))
    })

    it('AHR mountpoint change to an ancestor → 409, not a confirm', async () => {
      server = createServer({ mock: true, logger: false })
      ancestorSentence(refusalIs(await server.inject({
        method: 'PUT',
        url: '/v1/ahr/ahr0/mountpoint',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ mountpoint: ANCESTOR }),
      })))
    })
  })

  // --- D2: a MISSING intermediate never skips the walk ----------------------
  describe('cr.52r D2 — a missing intermediate under a symlinked parent refuses', () => {
    it('remote mount where the symlink points to /etc and TWO levels below it are missing → 409', async () => {
      server = createServer({ mock: true, logger: false })
      const mnt = join(dir, 'mnt')
      await mkdir(mnt)
      await symlink('/etc', join(mnt, 'laundered'))
      // `laundered` exists (the symlink); `newdir` and `data` below it do not.
      // cr.52's realpath-diff only refused when the missing part was BELOW a
      // lexically-laundered resolved path; cr.52r's walk stops at `laundered`
      // (lstat succeeds on a symlink) and refuses it regardless of the gap.
      const message = refusalIs(await server.inject({
        method: 'POST',
        url: '/v1/mounts',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: join(mnt, 'laundered', 'newdir', 'data'), persistent: false }),
      }))
      assert.match(message, /laundered/)
      assert.match(message, /is a symlink/)
      // Nothing was ever created through the planted link.
      const e = await import('node:fs/promises')
      assert.equal(await e.lstat('/etc/newdir').then(() => true, () => false), false)
    })
  })

  // --- D5: a pool created WITHOUT -m defaulting to a protected /<name> ------
  describe('cr.52r D5 — a pool created without -m is gated at /<name>', () => {
    it('`name: home` (ZFS default mountpoint /home) → 409, never a zpool create', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      const res = await server.inject({
        method: 'POST',
        url: '/v1/pools',
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: 'home', dataVdevs: [{ type: 'mirror', disks: ['d1', 'd2'] }] }),
      })
      refusalIs(res)
      assert.match(res.json().error.message, /system path|protected/)
      assert.ok(!calls.some(c => c.command === ZPOOL && c.args[0] === 'create'), 'no zpool create')
    })
  })

  // --- P2: a STORED path that now resolves through a swapped parent ---------
  describe('cr.52r P2 — the mount-state verb re-gates a stored path that now resolves into /etc', () => {
    it('state mount of an existing entry whose parent is now a symlink to /etc → 409, no mount', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      // A stored entry at a once-real path whose parent is swapped AFTER the
      // entry was written (the operator moved it, or a rebuild relinked it).
      const stored = join(dir, 'stored')
      await mkdir(stored)
      const mp = join(stored, 'share')
      await writeFile(fstabPath, `//10.0.0.9/export ${mp} cifs credentials=/etc/anas/creds/p2.cred,vers=3.1.1,nofail 0 0\n`)
      await rmdir(stored)
      await symlink('/etc', stored)
      const res = await server.inject({
        method: 'POST',
        url: `/v1/mounts/${encodeURIComponent(mp)}/state`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ action: 'mount' }),
      })
      const message = refusalIs(res)
      assert.match(message, /parent path is a symlink/)
      assert.ok(!calls.some(c => c.command === MOUNT), 'no mount argv')
    })
  })

  // --- P1: the four new entries ride the remote door too --------------------
  describe('cr.52r P1 — the four state trees an operator could hide a mount in refuse', () => {
    it('remote mount at each of vz / ceph / dpkg / log → the ONE shared 409', async () => {
      server = createServer({ mock: true, logger: false })
      const calls = spyExecutor(server)
      for (const mp of ['/var/lib/vz', '/var/lib/vz/112', '/var/lib/ceph', '/var/lib/dpkg', '/var/log', '/var/log/journal']) {
        const message = refusalIs(await server.inject({
          method: 'POST',
          url: '/v1/mounts',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ type: 'nfs', server: '127.0.0.1', remotePath: '/export', mountpoint: mp, persistent: false }),
        }))
        assert.match(message, /protected/, mp)
      }
      assert.deepEqual(calls.filter(c => c.command === MOUNT), [])
    })
  })

  // --- P3: the job re-runs the refusal under its lock at the pool doors -----
  describe('cr.52r P3 — the job re-runs the refusal at the pool and dataset doors (paused-queue)', () => {
    const DISK_IDS = ['d1', 'd2']

    /**
     * The swap-STAGE gate (cr.52r D3's ZFS half) demands root-owned,
     * non-writable ancestors — a user-owned tmpdir SUBDIR refuses before the
     * job. A bare `mkdtemp` root rides the sticky `/tmp` exception (parent
     * `/tmp`, 1777), so it passes both gates at the route; the flip replaces
     * the mountpoint ITSELF with a symlink to `/etc`, which the job's re-run
     * then refuses (the leaf is a symlink). Each test cleans its own temp in a
     * `finally` — after a flip it is exactly one symlink, which `rm` unlinks
     * without following (the same call the shared afterEach makes on a flipped
     * `mnt`). The base is a literal `/tmp`, NOT `os.tmpdir()`: the harness runs
     * with `TMPDIR` inside the worktree, whose user-owned `/home/...` ancestors
     * trip the same refuse-before-the-job gate the test has to get past.
     */
    const flippedDest = async (): Promise<string> => mkdtemp(join('/tmp', 'anas-cr52d-'))

    it('a pool create whose mountpoint is swapped while QUEUED refuses the job — no zpool create (mutation M14)', async () => {
      const dest = await flippedDest()
      try {
        server = createServer({ mock: true, logger: false })
        serveBlankInventoryDisks(server, DISK_IDS)
        const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
        const calls = spyExecutor(server)

        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        for (let i = 0; i < 4; i++)
          queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)

        const res = await server.inject({
          method: 'POST',
          url: '/v1/pools',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ name: 'tank', dataVdevs: [{ type: 'mirror', disks: DISK_IDS }], mountpoint: dest }),
        })
        assert.equal(res.statusCode, 202, res.body)
        const id = (res.json() as JobAccepted).job.id
        assert.equal(queue.get(id)?.status, 'queued', 'the create waits behind the held slots')

        await rmdir(dest)
        await symlink('/etc', dest)

        release()
        const job = await waitForJob(server, id)
        assert.equal(job.status, 'failed', JSON.stringify(job))
        assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
        assert.match(job.error!.message, /symlink/)
        assert.ok(!calls.some(c => c.command === ZPOOL && c.args[0] === 'create'), 'no zpool create argv')
      }
      finally {
        await rm(dest, { recursive: true, force: true })
      }
    })

    it('a pool mountpoint change whose target is swapped while QUEUED refuses the job — no zfs set (mutation M14)', async () => {
      const dest = await flippedDest()
      try {
        server = createServer({ mock: true, logger: false })
        const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
        const calls = spyExecutor(server)

        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        for (let i = 0; i < 4; i++)
          queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)

        // A legal move is confirm-gated (cr.36) — answer the challenge first.
        const first = await server.inject({
          method: 'PUT',
          url: '/v1/pools/testpool/mountpoint',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ mountpoint: dest }),
        })
        assert.equal(first.statusCode, 409, first.body)
        assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED', first.body)
        const code = first.headers['x-anas-confirm-code'] as string

        const res = await server.inject({
          method: 'PUT',
          url: '/v1/pools/testpool/mountpoint',
          headers: { ...JSON_HEADERS, 'x-anas-confirm': code },
          payload: JSON.stringify({ mountpoint: dest }),
        })
        assert.equal(res.statusCode, 202, res.body)
        const id = (res.json() as JobAccepted).job.id
        assert.equal(queue.get(id)?.status, 'queued', 'the move waits behind the held slots')

        await rmdir(dest)
        await symlink('/etc', dest)

        release()
        const job = await waitForJob(server, id)
        assert.equal(job.status, 'failed', JSON.stringify(job))
        assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
        assert.match(job.error!.message, /symlink/)
        assert.ok(!calls.some(c => c.command === ZFS && c.args[0] === 'set'), 'no zfs set argv')
      }
      finally {
        await rm(dest, { recursive: true, force: true })
      }
    })

    it('a dataset create whose mountpoint is swapped while QUEUED refuses the job — no zfs create (mutation M14)', async () => {
      const dest = await flippedDest()
      try {
        server = createServer({ mock: true, logger: false })
        const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
        const calls = spyExecutor(server)

        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        for (let i = 0; i < 4; i++)
          queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)

        const res = await server.inject({
          method: 'POST',
          url: '/v1/pools/testpool/datasets',
          headers: JSON_HEADERS,
          payload: JSON.stringify({ path: 'queued-ds', properties: { mountpoint: dest } }),
        })
        assert.equal(res.statusCode, 202, res.body)
        const id = (res.json() as JobAccepted).job.id
        assert.equal(queue.get(id)?.status, 'queued', 'the create waits behind the held slots')

        await rmdir(dest)
        await symlink('/etc', dest)

        release()
        const job = await waitForJob(server, id)
        assert.equal(job.status, 'failed', JSON.stringify(job))
        assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
        assert.match(job.error!.message, /symlink/)
        assert.ok(!calls.some(c => c.command === ZFS && c.args[0] === 'create'), 'no zfs create argv')
      }
      finally {
        await rm(dest, { recursive: true, force: true })
      }
    })

    it('an AHR create whose mountpoint is swapped while QUEUED refuses the job — no wipe, no vgcreate (mutation M14)', async () => {
      const dest = await flippedDest()
      try {
        server = createServer({ mock: true, logger: false })
        serveBlankInventoryDisks(server, DISK_IDS)
        const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
        const calls = spyExecutor(server)

        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        for (let i = 0; i < 4; i++)
          queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)

        // An AHR create is confirm-gated (it wipes disks) — answer it first.
        const payload = JSON.stringify({ name: 'tank', tier: 'ahr1', disks: DISK_IDS, mountpoint: dest })
        const first = await server.inject({ method: 'POST', url: '/v1/ahr', headers: JSON_HEADERS, payload })
        assert.equal(first.statusCode, 409, first.body)
        assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED', first.body)
        const code = first.headers['x-anas-confirm-code'] as string

        const res = await server.inject({ method: 'POST', url: '/v1/ahr', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
        assert.equal(res.statusCode, 202, res.body)
        const id = (res.json() as JobAccepted).job.id
        assert.equal(queue.get(id)?.status, 'queued', 'the create waits behind the held slots')

        await rmdir(dest)
        await symlink('/etc', dest)

        release()
        const job = await waitForJob(server, id)
        assert.equal(job.status, 'failed', JSON.stringify(job))
        assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
        assert.match(job.error!.message, /symlink/)
        assert.ok(!calls.some(c => ['/usr/sbin/wipefs', '/usr/sbin/sgdisk', '/usr/sbin/vgcreate'].includes(c.command)), 'no wipe/no vgcreate argv')
      }
      finally {
        await rm(dest, { recursive: true, force: true })
      }
    })

    it('an AHR mountpoint move whose target is swapped while QUEUED refuses the job — no fstab rewrite, no mount (mutation M14)', async () => {
      const dest = await flippedDest()
      try {
        server = createServer({ mock: true, logger: false })
        const queue = (server as unknown as { jobQueue: JobQueue }).jobQueue
        const calls = spyExecutor(server)

        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        for (let i = 0; i < 4; i++)
          queue.submit('test.hold', { user: 'root@pam', uid: 0 }, () => held)

        // The move is confirm-gated (it unmounts the pool) — answer it first.
        const payload = JSON.stringify({ mountpoint: dest })
        const first = await server.inject({ method: 'PUT', url: '/v1/ahr/ahr0/mountpoint', headers: JSON_HEADERS, payload })
        assert.equal(first.statusCode, 409, first.body)
        assert.equal(first.json().error.code, 'CONFIRMATION_REQUIRED', first.body)
        const code = first.headers['x-anas-confirm-code'] as string

        const res = await server.inject({ method: 'PUT', url: '/v1/ahr/ahr0/mountpoint', headers: { ...JSON_HEADERS, 'x-anas-confirm': code }, payload })
        assert.equal(res.statusCode, 202, res.body)
        const id = (res.json() as JobAccepted).job.id
        assert.equal(queue.get(id)?.status, 'queued', 'the move waits behind the held slots')

        await rmdir(dest)
        await symlink('/etc', dest)

        release()
        const job = await waitForJob(server, id)
        assert.equal(job.status, 'failed', JSON.stringify(job))
        assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
        assert.match(job.error!.message, /symlink/)
        assert.ok(!calls.some(c => c.command === MOUNT && c.args[0] === '-c'), 'no mount argv ran')
      }
      finally {
        await rm(dest, { recursive: true, force: true })
      }
    })
  })
})
