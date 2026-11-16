import type { Job, JobAccepted, MountDetail, MountSummary } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { JobQueue } from '../../jobs/queue.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { createServer } from '../../server.js'
import { buildBaseInventory } from '../../services/mounts.js'
import { mountsRoutes } from '../mounts.js'

/**
 * cr3.mounts — the remote-mounts findings of the 2026-11-14 review
 * (docs/CODE-REVIEW-2026-11-14.md, "Remote mounts"), each pinned at the route
 * the operator's request reaches. The probes named are the reviewer's
 * (scratchpad fullreview/mounts/p1..p8).
 *
 * FIXTURES: the mount table is `mounts/findmnt-full.json` (captured), with
 * rows added or re-pointed per test and the change spelled out at the call
 * site; LIO is `iscsi/configfs-restore-empty.manifest` (no LUNs) or
 * `iscsi/configfs-live.manifest` with its fileio image re-pointed under the
 * mount (as mounts-guard.test.ts does).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const FINDMNT = '/usr/bin/findmnt'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const SYSTEMCTL = '/usr/bin/systemctl'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }
const enc = (p: string): string => encodeURIComponent(p)
const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** The captured mount table as a tree, so a test can add rows under `/`. */
interface FsRow { target: string, source: string, fstype: string, options: string, children?: FsRow[] }
const FINDMNT_FULL = JSON.parse(fixture('mounts/findmnt-full.json')) as { filesystems: FsRow[] }

/** A mutation call: a mount verb acted on the node. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return c.command === MOUNT || c.command === UMOUNT || (c.command === SYSTEMCTL && ['daemon-reload', 'stop'].includes(c.args[0]))
}

const ENV_KEYS = ['ANAS_FSTAB_PATH', 'ANAS_CREDS_DIR', 'ANAS_STORAGE_CFG', 'ANAS_ISCSI_CONFIGFS', 'ANAS_ISCSI_SAVECONFIG', 'ANAS_ISCSI_SYS_BLOCK', 'ANAS_MOUNT_PROBE_RUNTIME_DIR', 'ANAS_AHR_MOUNT_BASE'] as const

describe('cr3.mounts — remote-mount findings at the route', () => {
  let dir = ''
  let base = ''
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** Extra rows the mount table carries under `/` (added to the capture). */
  let extraRows: FsRow[] = []
  /** findmnt fails (non-zero exit) when set. */
  let findmntFails = false
  /** Per-command answers that win over the dev mock (first match by predicate). */
  let answers: { when: (c: string, a: string[]) => boolean, result: ExecResult | ((a: string[]) => Promise<ExecResult> | ExecResult) }[] = []
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-mounts-'))
    base = join(dir, 'mnt')
    await mkdir(base, { recursive: true })
    for (const key of ENV_KEYS)
      saved[key] = process.env[key]
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined)
        delete process.env[key]
      else
        process.env[key] = saved[key]
    }
  })

  function table(): string {
    const t = structuredClone(FINDMNT_FULL)
    t.filesystems[0].children = [...(t.filesystems[0].children ?? []), ...extraRows]
    return JSON.stringify(t)
  }

  async function serve(fstab: string, opts: { lio?: string, storageCfg?: string } = {}): Promise<void> {
    extraRows = []
    findmntFails = false
    answers = []
    calls = []
    await writeFile(join(dir, 'fstab'), fstab)
    const configfs = join(dir, 'target')
    await rm(configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(opts.lio ?? fixture('iscsi/configfs-restore-empty.manifest'), configfs)
    process.env.ANAS_FSTAB_PATH = join(dir, 'fstab')
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = opts.storageCfg ?? join(FIXTURES, 'mounts/storage.cfg')
    process.env.ANAS_ISCSI_CONFIGFS = configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = join(dir, 'run')
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    mock.exec = async (command, args, o) => {
      calls.push({ command, args })
      if (command === FINDMNT && args.length === 1 && args[0] === '--json')
        return findmntFails ? { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo', exitCode: 1 } : ok(table())
      for (const a of answers) {
        if (a.when(command, args))
          return typeof a.result === 'function' ? a.result(args) : a.result
      }
      return orig(command, args, o)
    }
    await server.ready()
  }

  function send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, code?: string) {
    return server!.inject({
      method,
      url,
      headers: { ...(payload === undefined ? IDENTITY_HEADERS : JSON_HEADERS), ...(code ? { 'x-anas-confirm': code } : {}) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    })
  }

  /** Send; answer a confirm challenge with its code; the response that is not a challenge. */
  async function confirmed(method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const res = await send(method, url, payload)
    if (res.statusCode === 409 && res.headers['x-anas-confirm-code'])
      return send(method, url, payload, res.headers['x-anas-confirm-code'] as string)
    return res
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const res = await send('GET', `/v1/jobs/${id}`)
      const { job } = res.json() as { job: Job }
      if (job.status === 'completed' || job.status === 'failed')
        return job
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  async function job(method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Job> {
    const res = await confirmed(method, url, payload)
    assert.equal(res.statusCode, 202, res.body)
    return finished((res.json() as JobAccepted).job.id)
  }

  // ---- H1 / L10: remote kinds by fstype only --------------------------------

  describe('MOUNTS-H1 / MOUNTS-L10 — a FUSE or other non-NFS/CIFS mount is never a remote share', () => {
    const XSS_MP = '/home/alice/<img src=x onerror=alert(document.domain)>'

    it('the inventory reads a remote-shaped FUSE/sshfs/glusterfs/davfs source as `other`, not nfs (probe p5)', () => {
      const t = structuredClone(FINDMNT_FULL)
      t.filesystems[0].children = [
        ...(t.filesystems[0].children ?? []),
        { target: XSS_MP, source: 'nas:/backup', fstype: 'fuse.x', options: 'rw,nosuid,nodev,user_id=1000' },
        { target: '/mnt/ssh', source: 'bob@host:/srv', fstype: 'fuse.sshfs', options: 'rw' },
        { target: '/mnt/gv', source: 'gluster1:/gv0', fstype: 'fuse.glusterfs', options: 'rw' },
        { target: '/mnt/smbfuse', source: '//nas/share', fstype: 'fuse.smbnetfs', options: 'rw' },
      ]
      const rows = buildBaseInventory(JSON.stringify(t), 'https://dav.example/remote.php /mnt/dav davfs user,noauto,_netdev 0 0\n', new Map())
      for (const mp of [XSS_MP, '/mnt/ssh', '/mnt/gv', '/mnt/smbfuse', '/mnt/dav']) {
        const row = rows.find(r => r.mountpoint === mp)
        assert.ok(row, mp)
        assert.equal(row.type, 'other', `${mp} kind`)
        assert.equal(row.remote, false, `${mp} is not a remote share`)
        assert.equal(row.server, undefined, `${mp} carries no parsed server`)
      }
      // The real NFS/CIFS rows of the capture are unchanged.
      assert.equal(rows.find(r => r.mountpoint === '/mnt/anas-nfs')?.type, 'nfs')
      assert.equal(rows.find(r => r.mountpoint === '/mnt/anas-cifs')?.type, 'cifs')
    })

    it('every mutation verb refuses a fuse.sshfs fstab line with a remote-shaped source — nothing runs', async () => {
      const mp = join(base, 'ssh')
      await mkdir(mp)
      await serve(`bob@host:/srv ${mp} fuse.sshfs noauto,_netdev,nofail 0 0\n`)
      for (const [method, url, payload] of [
        ['PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } }],
        ['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' }],
        ['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'disable' }],
        ['DELETE', `/v1/mounts/${enc(mp)}`, undefined],
      ] as const) {
        const res = await send(method, url, payload)
        assert.equal(res.statusCode, 400, `${method} ${url}: ${res.body}`)
        assert.match(res.json().error.message, /ANAS manages remote \(NFS\/CIFS\) shares only/)
      }
      assert.deepEqual(calls.filter(isMutation), [])
    })

    it('a live FUSE mount with an NFS-shaped source refuses Unmount (no fstab line)', async () => {
      await serve('')
      extraRows = [{ target: XSS_MP, source: 'nas:/backup', fstype: 'fuse.x', options: 'rw,nosuid,nodev,user_id=1000' }]
      const res = await send('POST', `/v1/mounts/${enc(XSS_MP)}/state`, { action: 'unmount' })
      assert.equal(res.statusCode, 400, res.body)
      assert.deepEqual(calls.filter(isMutation), [])
    })
  })

  // ---- H2: Edit takes the LUN gate ------------------------------------------

  describe('MOUNTS-H2 — Edit of a mount holding an iSCSI fileio image is a hard 409', () => {
    it('refuses at the route, nothing unmounted, the fstab line untouched', async () => {
      const mp = join(base, 'lunhost')
      await mkdir(mp)
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\n`
      // The capture's fileio LUN, its image re-pointed under this mount.
      const lio = fixture('iscsi/configfs-live.manifest').split('/gtiscsi/images/lun2.raw').join(`${mp}/lun2.raw`)
      await serve(fstab, { lio })
      extraRows = [{ target: mp, source: 'nas:/export', fstype: 'nfs4', options: 'rw,vers=4.2,hard' }]
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.reason, 'held-by-lun')
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no confirm bypass')
      assert.deepEqual(calls.filter(isMutation), [])
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })
  })

  // ---- M4: Edit of a disabled line ------------------------------------------

  describe('MOUNTS-M4 — Edit of a DISABLED line is refused (it used to mount it)', () => {
    it('400 "enable it first" at the route; nothing mounted, the line untouched (probe p2)', async () => {
      const mp = join(base, 'share')
      await mkdir(mp)
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev,noauto,x-anas.disabled 0 0\n`
      await serve(fstab)
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } })
      assert.equal(res.statusCode, 400, res.body)
      assert.match(res.json().error.message, /is disabled — enable it first/)
      assert.deepEqual(calls.filter(isMutation), [])
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })
  })

  // ---- M5: smb3 is CIFS; credentials on a non-CIFS line refused --------------

  describe('MOUNTS-M5 — an `smb3` line is CIFS end to end; credentials on an NFS line are refused', () => {
    it('detail reads the smb3 line\'s credentials file; a rotation names the NEW file on the line (probe p3)', async () => {
      const mp = join(base, 'share')
      await mkdir(mp)
      const oldCreds = join(dir, 'operator.cred')
      await writeFile(oldCreds, 'username=bob\npassword=OLD\n', { mode: 0o600 })
      await serve(`//nas/media ${mp} smb3 credentials=${oldCreds},vers=3.1.1,_netdev,nofail 0 0\n`)
      extraRows = [{ target: mp, source: '//nas/media', fstype: 'smb3', options: 'rw,vers=3.1.1' }]
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.equal(det.type, 'cifs')
      assert.deepEqual(det.credentials, { set: true, username: 'bob' })
      assert.equal(det.entry?.credentialsFile, oldCreds)

      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'bob', password: 'NEW' } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const line = (await readFile(join(dir, 'fstab'), 'utf8')).trim()
      const created = await readdir(join(dir, 'creds'))
      assert.equal(created.length, 1, `one creds file: ${created.join(',')}`)
      const newFile = join(dir, 'creds', created[0])
      assert.ok(line.includes(`credentials=${newFile}`), line)
      assert.ok(!line.includes(oldCreds), `the old file is no longer named: ${line}`)
      assert.match(line, / smb3 /, 'the fstype the operator wrote stays')
      assert.equal(await readFile(newFile, 'utf8'), 'username=bob\npassword=NEW\n')
      // The operator's own file outside the creds dir is never deleted.
      assert.equal(await readFile(oldCreds, 'utf8'), 'username=bob\npassword=OLD\n')
    })

    it('credentials sent for an NFS line are a 400 and no file is written', async () => {
      const mp = join(base, 'nfs')
      await mkdir(mp)
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\n`
      await serve(fstab)
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'u', password: 'p' } })
      assert.equal(res.statusCode, 400, res.body)
      assert.match(res.json().error.message, /credentials apply to CIFS mounts only/)
      assert.deepEqual(await readdir(join(dir, 'creds')).catch(() => []), [])
      assert.deepEqual(calls.filter(isMutation), [])
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })
  })

  // ---- M6: Mount of a line with an inline password ---------------------------

  describe('MOUNTS-M6 — Mount of a hand-written CIFS line with an inline password is refused with the way out', () => {
    it('400 naming Edit → Save; mount(8) never runs (probe p7)', async () => {
      const mp = join(base, 'media')
      await mkdir(mp)
      const fstab = `//nas/media ${mp} cifs username=bob,password=s3cret,vers=3.0,_netdev,nofail 0 0\n`
      await serve(fstab)
      const res = await send('POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' })
      assert.equal(res.statusCode, 400, res.body)
      const err = res.json().error
      assert.equal(err.reason, 'inline-credentials')
      assert.match(err.message, /Open Edit and Save/)
      assert.ok(!res.body.includes('s3cret'), 'the secret is never echoed')
      assert.deepEqual(calls.filter(isMutation), [])
    })

    it('Edit → Save of that line migrates the password and mounts with the credentials file, never the secret in argv', async () => {
      const mp = join(base, 'media')
      await mkdir(mp)
      await serve(`//nas/media ${mp} cifs username=bob,password=s3cret,vers=3.0,_netdev,nofail 0 0\n`)
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, {})
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const mountCall = calls.find(c => c.command === MOUNT)
      assert.ok(mountCall, 'the save mounts the share')
      assert.ok(mountCall.args.join(' ').includes('credentials='), mountCall.args.join(' '))
      assert.ok(!calls.some(c => c.args.join(' ').includes('s3cret')), 'the secret is in no argv')
    })
  })

  // ---- L11: a session CIFS mount's credentials file -------------------------

  describe('MOUNTS-L11 — a non-persistent CIFS create leaves no credentials file behind', () => {
    it('the file is used by the mount and removed once it is up; nothing is written to fstab', async () => {
      const mp = join(base, 'session')
      await serve('')
      let fileAtMount: string | undefined
      answers.push({
        when: c => c === MOUNT,
        result: async (args) => {
          const opt = args[args.indexOf('-o') + 1] ?? ''
          fileAtMount = /credentials=([^,]+)/.exec(opt)?.[1]
          assert.ok(fileAtMount && (await readFile(fileAtMount, 'utf8')).includes('password=p'), 'the file exists when mount.cifs reads it')
          return ok('')
        },
      })
      const done = await job('POST', '/v1/mounts', { type: 'cifs', server: 'nas', remotePath: 'media', mountpoint: mp, persistent: false, mountNow: true, credentials: { username: 'u', password: 'p' } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.ok(fileAtMount, 'the mount used a credentials file')
      assert.deepEqual(await readdir(join(dir, 'creds')), [], 'no secret left on disk')
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), '')
    })

    it('Remove of a session CIFS mount (no line) deletes its hashed credentials file', async () => {
      const mp = join(base, 'session')
      await mkdir(mp)
      await serve('')
      extraRows = [{ target: mp, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
      await mkdir(join(dir, 'creds'), { recursive: true })
      const { credsFilePath } = await import('../../services/mounts.js')
      const leftover = credsFilePath(join(dir, 'creds'), mp)
      await writeFile(leftover, 'username=u\npassword=p\n', { mode: 0o600 })
      const done = await job('DELETE', `/v1/mounts/${enc(mp)}`)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.deepEqual(await readdir(join(dir, 'creds')), [])
    })
  })

  // ---- L12: an untouched save keeps a hand-written line's bytes ---------------

  describe('MOUNTS-L12 — an untouched save rewrites a hand-written line byte-identically (§2 dialog contract)', () => {
    const lines = (mp: string): string[] => [
      `nas:/export   ${mp}   nfs   defaults,_netdev,nofail,nfsvers=4.1,rw   0 0`,
      `//nas/share ${mp} cifs credentials=/root/.smb,iocharset=utf8,_netdev,nofail,uid=1000 0 0`,
    ]
    for (const which of [0, 1]) {
      it(`${which === 0 ? 'NFS' : 'CIFS'} line: an empty body and the dialog's echo both leave the line alone (probe p8)`, async () => {
        const mp = join(base, 'hand')
        await mkdir(mp)
        const fstab = `# keep me\n${lines(mp)[which]}\n`
        await serve(fstab)
        extraRows = [{ target: mp, source: which === 0 ? 'nas:/export' : '//nas/share', fstype: which === 0 ? 'nfs' : 'cifs', options: 'rw' }]
        const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
        const co = det.configuredOptions!
        // What the dialog sends on an untouched Save: every field, its stored value or null (#34).
        const echo = which === 0
          ? { automount: false, extraOptions: co.passthrough, options: { ro: false, noatime: false, nosuid: false, nodev: false, noexec: false, netdev: true, idleTimeout: null, vers: co.nfs?.vers ?? null, hard: null, timeo: null, retrans: null, rsize: null, wsize: null, proto: null, nconnect: null, actimeo: null, lookupcache: null, sec: null, noac: false, bg: false } }
          : { automount: false, extraOptions: co.passthrough, options: { ro: false, noatime: false, nosuid: false, nodev: false, noexec: false, netdev: true, idleTimeout: null, vers: null, cache: null, domain: null, uid: co.cifs?.uid ?? null, gid: null, fileMode: null, dirMode: null, sec: null, rsize: null, wsize: null, actimeo: null, iocharset: co.cifs?.iocharset ?? null, mfsymlinks: false, forceuid: false, forcegid: false, noserverino: false, nobrl: false } }
        for (const body of [{}, echo]) {
          const done = await job('PUT', `/v1/mounts/${enc(mp)}`, body)
          assert.equal(done.status, 'completed', JSON.stringify(done.error))
          assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab, `byte-identical after ${JSON.stringify(body).slice(0, 40)}`)
        }
        // A real edit still rewrites the line.
        const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } })
        assert.equal(done.status, 'completed', JSON.stringify(done.error))
        assert.match(await readFile(join(dir, 'fstab'), 'utf8'), /noatime/)
      })
    }
  })

  // ---- L15: options that undo nofail ------------------------------------------

  describe('MOUNTS-L15 — ANAS never writes an x-systemd.required-by= that undoes the forced nofail', () => {
    it('create refuses it (400), nothing written or mounted', async () => {
      const mp = join(base, 'req')
      await serve('')
      const res = await send('POST', '/v1/mounts', { type: 'nfs', server: 'nas', remotePath: '/export', mountpoint: mp, extraOptions: 'x-systemd.required-by=local-fs.target' })
      assert.equal(res.statusCode, 400, res.body)
      assert.match(res.json().error.message, /undoes the forced nofail/)
      assert.deepEqual(calls.filter(isMutation), [])
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), '')
    })

    it('an edit that ADDS one is refused; a hand-written one already on the line is kept by an echo', async () => {
      const mp = join(base, 'req')
      await mkdir(mp)
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\n`
      await serve(fstab)
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { extraOptions: 'X-Systemd.Required-By=local-fs.target' })
      assert.equal(res.statusCode, 400, res.body)
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)

      const handWritten = `nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev,x-systemd.required-by=pve-guests.service 0 0\n`
      await serve(handWritten)
      extraRows = [{ target: mp, source: 'nas:/export', fstype: 'nfs4', options: 'rw' }]
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { extraOptions: 'x-systemd.required-by=pve-guests.service', options: { noatime: true } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.match(await readFile(join(dir, 'fstab'), 'utf8'), /x-systemd\.required-by=pve-guests\.service/)
    })
  })

  // ---- L14: removeMountpointDir on a protected path ---------------------------

  describe('MOUNTS-L14 — Remove\'s directory opt-in never removes a protected or top-level path', () => {
    for (const mp of ['/srv', '/mnt', '/root/share']) {
      it(`a hand-written line at ${mp}: the line goes, the directory is left and said`, async () => {
        await serve(`nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\n`)
        const done = await job('DELETE', `/v1/mounts/${enc(mp)}?removeMountpointDir=true`)
        assert.equal(done.status, 'completed', JSON.stringify(done.error))
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), '')
        // The refusal is the RULE's, not whatever an rmdir attempt hit.
        const warnings = (done.result as { warnings?: string[] }).warnings ?? []
        assert.ok(warnings.some(w => w.startsWith(`The directory '${mp}' was left in place — `) && /mount-target rule refuses|top-level directory/.test(w)), JSON.stringify(warnings))
      })
    }
  })

  // ---- L16: a failed forced unmount ------------------------------------------

  describe('MOUNTS-L16 — a failed forced (lazy) unmount fails the job before anything else changes', () => {
    /** The `lsof +f -- /mnt/anas-cifs` block of the busy-unmount capture (header + two holders). */
    const LSOF_TWO_HOLDERS = (() => {
      const text = fixture('mounts/busy-unmount.txt')
      const start = text.indexOf('### lsof +f -- /mnt/anas-cifs\n') + '### lsof +f -- /mnt/anas-cifs\n'.length
      return text.slice(start, text.indexOf('lsof EXIT=0', start))
    })()

    for (const verb of ['disable', 'remove'] as const) {
      it(`${verb}: the job fails, the fstab line and the credentials file stay`, async () => {
        const mp = join(base, 'busy')
        await mkdir(mp)
        await mkdir(join(dir, 'creds'), { recursive: true })
        const creds = join(dir, 'creds', 'busy.cred')
        await writeFile(creds, 'username=u\npassword=p\n', { mode: 0o600 })
        const fstab = `//nas/media ${mp} cifs credentials=${creds},vers=3.1.1,nofail 0 0\n`
        await serve(fstab)
        extraRows = [{ target: mp, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
        answers.push({ when: c => c === '/usr/bin/lsof', result: ok(LSOF_TWO_HOLDERS) })
        answers.push({ when: (c, a) => c === UMOUNT && a[0] === '-l', result: { stdout: '', stderr: `umount: ${mp}: not permitted`, exitCode: 32 } })
        const done = verb === 'disable'
          ? await job('POST', `/v1/mounts/${enc(mp)}/state`, { action: 'disable' })
          : await job('DELETE', `/v1/mounts/${enc(mp)}`)
        assert.equal(done.status, 'failed', JSON.stringify(done.result))
        assert.match(done.error?.message ?? '', /forced \(lazy\) unmount .* failed .* still mounted, and nothing else was changed/)
        assert.ok(calls.some(c => c.command === UMOUNT && c.args[0] === '-l'), 'the forced unmount was tried')
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
        assert.equal(await readFile(creds, 'utf8'), 'username=u\npassword=p\n')
      })
    }
  })

  // ---- AHR review question: a share under the AHR mount base ------------------

  describe('cr3.mounts (AHR review) — a remote share is never created or edited under the AHR mount base', () => {
    it('create at the base and under it: 409 ahr-mount-base, nothing made, mounted or written', async () => {
      process.env.ANAS_AHR_MOUNT_BASE = join(base, 'anas-ahr')
      await serve('')
      for (const mp of [join(base, 'anas-ahr'), join(base, 'anas-ahr', 'tank'), join(base, 'anas-ahr', 'tank', 'sub')]) {
        const res = await send('POST', '/v1/mounts', { type: 'nfs', server: 'nas', remotePath: '/export', mountpoint: mp })
        assert.equal(res.statusCode, 409, `${mp}: ${res.body}`)
        assert.equal(res.json().error.reason, 'ahr-mount-base')
      }
      // A sibling that only shares the prefix is not under the base.
      const sibling = await send('POST', '/v1/mounts', { type: 'nfs', server: 'nas', remotePath: '/export', mountpoint: join(base, 'anas-ahr-other'), mountNow: false })
      assert.equal(sibling.statusCode, 202, sibling.body)
      assert.deepEqual(calls.filter(c => c.command === MOUNT), [])
    })

    it('an edit of a hand-written remote line under the base is refused too', async () => {
      process.env.ANAS_AHR_MOUNT_BASE = join(base, 'anas-ahr')
      const mp = join(base, 'anas-ahr', 'share')
      await mkdir(mp, { recursive: true })
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\n`
      await serve(fstab)
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } })
      assert.equal(res.statusCode, 409, res.body)
      assert.equal(res.json().error.reason, 'ahr-mount-base')
      assert.deepEqual(calls.filter(isMutation), [])
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })
  })

  // ---- INVENTED-STATE-M10: an unreadable mount table ---------------------------

  describe('INVENTED-STATE-M10 — an unreadable findmnt table reads as unknown, never "not mounted"', () => {
    it('GET /mounts: fstab rows are `unknown` with mounted null and tableUnreadable; the list says so too', async () => {
      const mp = join(base, 'nfs')
      await mkdir(mp)
      await serve(`nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\nnas:/off ${mp}-off nfs4 noauto,x-anas.disabled,nofail 0 0\n`)
      findmntFails = true
      const res = await send('GET', '/v1/mounts')
      assert.equal(res.statusCode, 200)
      const body = res.json() as { data: MountSummary[], tableUnreadable?: boolean }
      assert.equal(body.tableUnreadable, true)
      const row = body.data.find(r => r.mountpoint === mp)!
      assert.equal(row.state, 'unknown', 'never "unmounted" off a table nobody read')
      assert.equal(row.mounted, null)
      assert.equal(row.tableUnreadable, true)
      const off = body.data.find(r => r.mountpoint === `${mp}-off`)!
      assert.equal(off.state, 'disabled', 'disabled is an fstab fact and stays')
      assert.equal(off.mounted, null)
      // The table read succeeds again: no flag anywhere.
      findmntFails = false
      const again = (await send('GET', '/v1/mounts')).json() as { data: MountSummary[], tableUnreadable?: boolean }
      assert.equal(again.tableUnreadable, undefined)
      assert.equal(again.data.find(r => r.mountpoint === mp)?.tableUnreadable, undefined)
    })

    it('GET /mounts/:mp: health is unknown with the reason, never "Configured in /etc/fstab but not currently mounted."', async () => {
      const mp = join(base, 'nfs')
      await mkdir(mp)
      await serve(`nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\n`)
      findmntFails = true
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.equal(det.health.state, 'unknown')
      assert.match(det.health.detail ?? '', /could not read the kernel mount table/)
      assert.equal(det.mounted, null)
      assert.equal(det.tableUnreadable, true)
    })
  })

  // ---- follow-up (2): a secret ANAS cannot migrate never rides argv -------------

  // The coordinator's rulings after reviews 2 and 3 (PVE 9 ground truth:
  // cifs-utils 2:7.4-1+deb13u2's mount.cifs(8) documents `password2=`/`pass2=`
  // and a credentials FILE line `password2=value`; cifs-utils 7.4 source for
  // the reading rules): an inline alternate password on a CIFS line is
  // MIGRATED like an inline password when the line names NO file or ANAS's
  // OWN file; a line naming the OPERATOR's file is refused (ANAS never copies
  // or edits it). A password on a non-CIFS line stays refused.
  describe('cr3.mounts follow-up (2), as re-ruled after reviews 2 and 3', () => {
    async function ownFile(mp: string, text: string): Promise<string> {
      const { credsFilePath } = await import('../../services/mounts.js')
      await mkdir(join(dir, 'creds'), { recursive: true, mode: 0o700 })
      const f = credsFilePath(join(dir, 'creds'), mp)
      await writeFile(f, text, { mode: 0o600 })
      return f
    }

    for (const key of ['password2', 'pass2'] as const) {
      it(`review 3 (2): ${key}= on a line naming the OPERATOR's file — Mount and Save refused with what to move where; nothing changed`, async () => {
        const mp = join(base, 'p2')
        await mkdir(mp)
        await mkdir(join(dir, 'op'), { recursive: true })
        const opFile = join(dir, 'op', 'operator.cred')
        await writeFile(opFile, 'username=bob\npassword=Pr1mary\ndomain=CORP\n', { mode: 0o600 })
        const fstab = `//nas/media ${mp} cifs credentials=${opFile},${key}=R0tate#2,vers=3.0,nofail 0 0\n`
        await serve(fstab)
        for (const [method, url, payload] of [
          ['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' }],
          ['PUT', `/v1/mounts/${enc(mp)}`, {}],
          ['PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'bob', password: 'NEW' } }],
        ] as const) {
          const res = await send(method, url, payload)
          assert.equal(res.statusCode, 400, `${method} ${JSON.stringify(payload)}: ${res.body}`)
          assert.equal(res.json().error.reason, 'operator-credentials-file')
          // review 4 (D1): per key on the line — the file has no password2, so: move it.
          assert.match(res.json().error.message, new RegExp(`move the inline ${key}= into ${opFile.replaceAll('/', '\\/')} as a password2= line and remove it from the line`))
          assert.ok(!/inline password=|pass=/.test(res.json().error.message), 'a key not on the line is never named')
          assert.ok(!res.body.includes('R0tate#2'))
        }
        assert.deepEqual(calls.filter(isMutation), [])
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
        assert.equal(await readFile(opFile, 'utf8'), 'username=bob\npassword=Pr1mary\ndomain=CORP\n')
        assert.deepEqual((await readdir(join(dir, 'creds')).catch(() => [])).filter(f => !f.startsWith('.')), [])
      })
    }

    it('review 3 (2): no file — Mount refused (Edit-then-Save); Save migrates the inline password and alternate password; secret in no argv, answer or job record', async () => {
      const mp = join(base, 'inl')
      await mkdir(mp)
      await serve(`//nas/media ${mp} cifs username=u,password=InlPw,password2=ALTpw,domain=D,vers=3.0,nofail 0 0\n`)
      const res = await send('POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' })
      assert.equal(res.statusCode, 400, res.body)
      assert.equal(res.json().error.reason, 'inline-credentials')
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, {})
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const files = await readdir(join(dir, 'creds'))
      assert.equal(await readFile(join(dir, 'creds', files[0]), 'utf8'), 'username=u\npassword=InlPw\npassword2=ALTpw\ndomain=D\n')
      const line = await readFile(join(dir, 'fstab'), 'utf8')
      assert.ok(!line.includes('InlPw') && !line.includes('ALTpw'), line)
      assert.ok(!JSON.stringify(done).includes('ALTpw') && !JSON.stringify(done).includes('InlPw'))
      assert.ok(!calls.some(c => [c.command, ...c.args].join(' ').match(/ALTpw|InlPw/)))
    })

    // A0c/A0d/A0e of review 3, on a line naming ANAS's OWN file: the account
    // migrated is the one mount.cifs used — passwords: the FILE wins in
    // either order; user/domain: the LAST on the line, the file at its token.
    for (const [name, line, fileText, want] of [
      ['A0c the file\'s password2 wins over the inline one', 'credentials=F,password2=ALTpw', 'username=alice\npassword=FilePw\npassword2=FileAlt\n', 'username=alice\npassword=FilePw\npassword2=FileAlt\n'],
      ['A0d user=bob BEFORE credentials=F(alice): the file (later) wins', 'user=bob,credentials=F,password2=ALTpw', 'username=alice\npassword=FilePw\ndomain=CORP\n', 'username=alice\npassword=FilePw\npassword2=ALTpw\ndomain=CORP\n'],
      ['A0d\' credentials=F(alice) BEFORE user=bob: the line (later) wins', 'credentials=F,user=bob,password2=ALTpw', 'username=alice\npassword=FilePw\n', 'username=bob\npassword=FilePw\npassword2=ALTpw\n'],
      ['A0e domain=LINEDOM after credentials=F(CORP): the line wins', 'credentials=F,domain=LINEDOM,password2=ALTpw', 'username=alice\npassword=FilePw\ndomain=CORP\n', 'username=alice\npassword=FilePw\npassword2=ALTpw\ndomain=LINEDOM\n'],
    ] as const) {
      it(`review 3 (2) precedence, ANAS's own file: ${name}`, async () => {
        const mp = join(base, 'own')
        await mkdir(mp)
        const f = await ownFile(mp, fileText)
        await serve(`//nas/media ${mp} cifs ${line.replace('F', f)},vers=3.0,nofail 0 0\n`)
        const done = await job('PUT', `/v1/mounts/${enc(mp)}`, {})
        assert.equal(done.status, 'completed', JSON.stringify(done.error))
        assert.equal(await readFile(f, 'utf8'), want)
        const after = await readFile(join(dir, 'fstab'), 'utf8')
        assert.ok(!/password2|ALTpw|user=bob|domain=LINEDOM/.test(after), after)
      })
    }

    for (const [name, line, why] of [
      ['A0g no username anywhere', 'password2=ALTpw', /names no username/],
      ['A0h an escaped newline in the secret', 'username=u,password=InlPw,password2=ALTpw\\012domain=EVIL', /contains a line break/],
      ['USERNAME= is not mount.cifs\' spelling', 'USERNAME=bob,password=InlPw', /spells USERNAME= in a way mount\.cifs does not read/],
    ] as const) {
      it(`review 3 (1)/(7): ${name} — Save refused at the route, nothing written`, async () => {
        const mp = join(base, 'ref')
        await mkdir(mp)
        const fstab = `//nas/media ${mp} cifs ${line},vers=3.0,nofail 0 0\n`
        await serve(fstab)
        const res = await send('PUT', `/v1/mounts/${enc(mp)}`, {})
        assert.equal(res.statusCode, 400, res.body)
        assert.match(res.json().error.message, why)
        assert.ok(!/ALTpw|InlPw|EVIL/.test(res.body), res.body)
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
        assert.deepEqual(await readdir(join(dir, 'creds')).catch(() => []), [])
      })
    }

    it('review 3 (1): PASSWORD= (not mount.cifs\' spelling) — Mount and Save refused naming the key, nothing changed', async () => {
      const mp = join(base, 'up')
      await mkdir(mp)
      const fstab = `//nas/media ${mp} cifs username=u,PASSWORD=Up9,vers=3.0,nofail 0 0\n`
      await serve(fstab)
      for (const [method, url, payload] of [['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' }], ['PUT', `/v1/mounts/${enc(mp)}`, {}]] as const) {
        const res = await send(method, url, payload)
        assert.equal(res.statusCode, 400, res.body)
        assert.equal(res.json().error.reason, 'inline-secret-option')
        assert.match(res.json().error.message, /PASSWORD=, a password spelled in a way mount\.cifs does not read/)
        assert.ok(!res.body.includes('Up9'))
      }
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })

    it('review 3 (3): a rotation with typed credentials proceeds over an unreadable old file and says the alternate password was not carried', async () => {
      const mp = join(base, 'rot')
      await mkdir(mp)
      const f = await ownFile(mp, 'username=bob\npassword=OLD\npassword2=Alt2\n')
      const { chmod } = await import('node:fs/promises')
      await serve(`//nas/media ${mp} cifs credentials=${f},vers=3.0,nofail 0 0\n`)
      extraRows = [{ target: mp, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
      await chmod(f, 0o000)
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'bob', password: 'NEW' } })
      await chmod(f, 0o600)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const warnings = (done.result as { warnings?: string[] }).warnings ?? []
      assert.ok(warnings.some(w => /was not carried over to the new credentials: it could not be read/.test(w)), JSON.stringify(warnings))
      assert.equal(await readFile(f, 'utf8'), 'username=bob\npassword=NEW\n')
    })

    it('review 3 (3): a rotation to a DIFFERENT username never carries the old account\'s alternate password', async () => {
      const mp = join(base, 'rot2')
      await mkdir(mp)
      const f = await ownFile(mp, 'username=alice\npassword=OLD\npassword2=Alt2\n')
      await serve(`//nas/media ${mp} cifs credentials=${f},vers=3.0,nofail 0 0\n`)
      extraRows = [{ target: mp, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'carol', password: 'NEW' } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.equal(await readFile(f, 'utf8'), 'username=carol\npassword=NEW\n')
      const warnings = (done.result as { warnings?: string[] }).warnings ?? []
      assert.ok(warnings.some(w => /alternate password of 'alice' was not carried over to 'carol'/.test(w)), JSON.stringify(warnings))
      assert.ok(!JSON.stringify(done).includes('Alt2'))
    })

    it('a rotation that does not mention the alternate password keeps the stored one', async () => {
      const mp = join(base, 'rot')
      await mkdir(mp)
      const f = await ownFile(mp, 'username=bob\npassword=OLD\npassword2=Alt2\n')
      await serve(`//nas/media ${mp} cifs credentials=${f},vers=3.0,nofail 0 0\n`)
      extraRows = [{ target: mp, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'bob', password: 'NEW' } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.equal(await readFile(f, 'utf8'), 'username=bob\npassword=NEW\npassword2=Alt2\n')
      const det = await send('GET', `/v1/mounts/${enc(mp)}`)
      assert.ok(!det.body.includes('Alt2') && !det.body.includes('NEW'), 'the detail never carries a password')
      assert.deepEqual((det.json().data as MountDetail).credentials, { set: true, username: 'bob' })
    })

    it('review 3 (4): Disable of a legacy #ANAS line carrying an inline secret is refused, the line byte-identical', async () => {
      const mp = join(base, 'leg')
      await mkdir(mp)
      const fstab = `#ANAS //nas/s ${mp} cifs username=u,password2=ALTpw,nofail 0 0\n`
      await serve(fstab)
      const res = await send('POST', `/v1/mounts/${enc(mp)}/state`, { action: 'disable' })
      assert.equal(res.statusCode, 400, res.body)
      assert.match(res.json().error.message, /Enable it, then open Edit and Save/)
      assert.ok(!res.body.includes('ALTpw'))
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
      const { disableMount } = await import('../../parsers/fstab.js')
      assert.equal(disableMount(fstab, mp), fstab, 'the parser never drops it either')
    })

    it('review 3 (5): the detail of credentials=OP(alice, CORP)+password2= shows alice and CORP', async () => {
      const mp = join(base, 'det')
      await mkdir(mp)
      const opFile = join(dir, 'op.cred')
      await writeFile(opFile, 'username=alice\npassword=FilePw\ndomain=CORP\n', { mode: 0o600 })
      await serve(`//nas/s ${mp} cifs credentials=${opFile},vers=3.0,password2=ALTpw,nofail 0 0\n`)
      const det = await send('GET', `/v1/mounts/${enc(mp)}`)
      assert.deepEqual((det.json().data as MountDetail).credentials, { set: true, username: 'alice', domain: 'CORP' })
      assert.ok(!det.body.includes('ALTpw') && !det.body.includes('FilePw'))
    })

    for (const existed of [false, true]) {
      it(`review 3 (6): a failed /etc/fstab write ${existed ? 'puts back the credentials file that existed' : 'removes the credentials file this job wrote'}`, async () => {
        const mp = join(base, 'fail')
        await mkdir(mp)
        const { chmod } = await import('node:fs/promises')
        const { credsFilePath } = await import('../../services/mounts.js')
        await mkdir(join(dir, 'creds'), { recursive: true, mode: 0o700 })
        const f = credsFilePath(join(dir, 'creds'), mp)
        const before = 'username=u\npassword=Prev\n'
        if (existed)
          await writeFile(f, before, { mode: 0o600 })
        const fstab = `//nas/media ${mp} cifs username=u,password=InlPw,vers=3.0,nofail 0 0\n`
        await serve(fstab)
        // The fstab's directory goes read-only after the route: the atomic write's temp cannot be made.
        const res = await send('PUT', `/v1/mounts/${enc(mp)}`, {})
        assert.equal(res.statusCode, 202, res.body)
        await chmod(dir, 0o555)
        let done: Job
        try {
          done = await finished((res.json() as JobAccepted).job.id)
        }
        finally {
          await chmod(dir, 0o755)
        }
        assert.equal(done.status, 'failed', JSON.stringify(done.result))
        assert.match(done.error?.message ?? '', existed ? /was put back as it was/ : /this job wrote was removed again/)
        assert.ok(!(done.error?.message ?? '').includes('InlPw'))
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
        if (existed)
          assert.equal(await readFile(f, 'utf8'), before)
        else
          assert.deepEqual((await readdir(join(dir, 'creds'))).filter(n => !n.startsWith('.')), [])
      })
    }

    it('review 3 (10): an option-only edit while the named file is unreadable keeps domain= off the line', async () => {
      const mp = join(base, 'unr')
      await mkdir(mp)
      const opFile = join(dir, 'op.cred')
      await writeFile(opFile, 'username=alice\npassword=FilePw\ndomain=CORP\n', { mode: 0o600 })
      await serve(`//nas/s ${mp} cifs credentials=${opFile},vers=3.0,nofail 0 0\n`)
      extraRows = [{ target: mp, source: '//nas/s', fstype: 'cifs', options: 'rw' }]
      const { chmod } = await import('node:fs/promises')
      await chmod(opFile, 0o000)
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { options: { domain: 'CORP', noatime: true } })
      await chmod(opFile, 0o600)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const after = await readFile(join(dir, 'fstab'), 'utf8')
      assert.ok(!after.includes('domain='), after)
      assert.match(after, /noatime/)
    })

    it('review 3 (11): an octal-escaped key (\\160assword=) is a password — redacted, Mount refused, Save migrates it', async () => {
      const mp = join(base, 'esc')
      await mkdir(mp)
      await serve(`//nas/s ${mp} cifs username=u,\\160assword=EscSec,vers=3.0,nofail 0 0\n`)
      const det = await send('GET', `/v1/mounts/${enc(mp)}`)
      assert.ok(!det.body.includes('EscSec'), det.body)
      const res = await send('POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' })
      assert.equal(res.statusCode, 400, res.body)
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, {})
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const files = await readdir(join(dir, 'creds'))
      assert.equal(await readFile(join(dir, 'creds', files[0]), 'utf8'), 'username=u\npassword=EscSec\n')
      assert.ok(!(await readFile(join(dir, 'fstab'), 'utf8')).includes('EscSec'))
      assert.ok(!calls.some(c => [c.command, ...c.args].join(' ').includes('EscSec')))
    })

    it('password= on an NFS line: Mount and Edit stay 400 inline-secret-option, nothing runs', async () => {
      const mp = join(base, 'p2')
      await mkdir(mp)
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,password=R0tate#2,nofail 0 0\n`
      await serve(fstab)
      for (const [method, url, payload] of [
        ['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' }],
        ['PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } }],
      ] as const) {
        const res = await send(method, url, payload)
        assert.equal(res.statusCode, 400, `${method}: ${res.body}`)
        assert.equal(res.json().error.reason, 'inline-secret-option')
        assert.ok(!res.body.includes('R0tate#2'))
      }
      assert.deepEqual(calls.filter(isMutation), [])
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })

    it('the direct-mount option list never carries a secret token (the belt to the gate)', async () => {
      const { directMountOptionArgs, getMount } = await import('../../parsers/fstab.js')
      const entry = getMount('nas:/e /m nfs4 vers=4.2,password=R0tate#2,nofail 0 0\n', '/m')!
      assert.deepEqual(directMountOptionArgs(entry), ['-o', 'vers=4.2'])
    })

    it('review 3 (12): a non-CIFS secret token is written back VERBATIM by the serializer and the disable path', async () => {
      const { disableMount, getMount, serializeMountLine } = await import('../../parsers/fstab.js')
      const text = 'nas:/e /m nfs4 vers=4.2,nofail,password=a\\054b 0 0\n'
      assert.ok(serializeMountLine(getMount(text, '/m')!).includes('password=a\\054b'))
      assert.ok(disableMount(text, '/m').includes('password=a\\054b'))
      assert.ok(disableMount(`#ANAS ${text}`, '/m').includes('password=a\\054b'))
    })
  })

  // ---- review 4 -------------------------------------------------------------------

  describe('cr3.mounts review 4', () => {
    async function ownFile(mp: string, text: string | Buffer): Promise<string> {
      const { credsFilePath } = await import('../../services/mounts.js')
      await mkdir(join(dir, 'creds'), { recursive: true, mode: 0o700 })
      const f = credsFilePath(join(dir, 'creds'), mp)
      await writeFile(f, text, { mode: 0o600 })
      return f
    }
    async function opFile(text: string): Promise<string> {
      await mkdir(join(dir, 'op'), { recursive: true })
      const f = join(dir, 'op', 'operator.cred')
      await writeFile(f, text, { mode: 0o600 })
      return f
    }
    async function allFilesHolding(secret: string, root: string): Promise<string[]> {
      const { readdir: rd, readFile: rf, lstat } = await import('node:fs/promises')
      const out: string[] = []
      async function walk(d: string): Promise<void> {
        for (const n of await rd(d).catch(() => [] as string[])) {
          const p = join(d, n)
          const st = await lstat(p)
          if (st.isDirectory()) {
            if (n !== 'mnt' && n !== 'target')
              await walk(p)
          }
          else if (st.isFile() && (await rf(p, 'utf8').catch(() => '')).includes(secret)) {
            out.push(p.slice(root.length))
          }
        }
      }
      await walk(root)
      return out
    }

    it('D1: the operator\'s file already holds a password2 — "the inline password2= is not used: remove it"; no other key named', async () => {
      const mp = join(base, 'd1')
      await mkdir(mp)
      const f = await opFile('username=bob\npassword=Pr1mary\npassword2=FileAlt\n')
      await serve(`//nas/media ${mp} cifs credentials=${f},password2=Inl2,vers=3.0,nofail 0 0\n`)
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, {})
      assert.equal(res.statusCode, 400, res.body)
      const msg = res.json().error.message as string
      assert.match(msg, /the inline password2= is not used \(the file's password2 wins\): remove it from the line/)
      assert.ok(!/move the inline/.test(msg) && !/password=|pass=/.test(msg.replace('password2=', '')), msg)
      assert.ok(!res.body.includes('Inl2') && !res.body.includes('FileAlt'))
    })

    it('D2: a failed fstab write whose undo also fails, on a line that already names that file, says what the file holds — never "remove by hand"', async () => {
      const mp = join(base, 'd2')
      await mkdir(mp)
      const f = await ownFile(mp, 'username=bob\npassword=OLD\n')
      const fstab = `//nas/media ${mp} cifs credentials=${f},vers=3.0,nofail 0 0\n`
      await serve(fstab)
      extraRows = [{ target: mp, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
      const { chmodSync, watch } = await import('node:fs')
      const credsDir = join(dir, 'creds')
      // The moment the rotation renames the new file into place, both the
      // fstab's directory and the creds directory go read-only: the fstab
      // write fails AND the put-back fails.
      let fired = false
      const w = watch(credsDir, (_ev, name) => {
        if (!fired && name === f.split('/').pop()) {
          fired = true
          chmodSync(credsDir, 0o555)
          chmodSync(dir, 0o555)
        }
      })
      let done: Job
      try {
        done = await job('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'bob', password: 'NEW' } })
      }
      finally {
        w.close()
        chmodSync(dir, 0o755)
        chmodSync(credsDir, 0o700)
      }
      assert.ok(fired, 'the watch saw the rotation land')
      assert.equal(done.status, 'failed', JSON.stringify(done.result))
      const msg = done.error?.message ?? ''
      assert.match(msg, /this line names could not be put back .* now holds the new credentials \(already tested against the server\) — leave it in place: the line still names it/)
      assert.ok(!/removed by hand/.test(msg), msg)
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })

    for (const [name, opts, pos] of [
      ['user=bob\\054password=... (a username AND a password to mount.cifs)', 'credentials=/etc/x.cred,user=bob\\054password=S8sec,vers=3.0', 2],
      ['pass\\075word=... (a password)', 'username=bob,pass\\075word=S6sec,vers=3.0', 2],
    ] as const) {
      it(`D4: ${name} — hidden whole, Mount/Save/Disable refused naming the position, Unmount/Remove/detail work`, async () => {
        const mp = join(base, 'd4')
        await mkdir(mp)
        const fstab = `//nas/s ${mp} cifs ${opts},nofail 0 0\n`
        await serve(fstab)
        extraRows = [{ target: mp, source: '//nas/s', fstype: 'cifs', options: 'rw' }]
        const det = await send('GET', `/v1/mounts/${enc(mp)}`)
        assert.equal(det.statusCode, 200)
        assert.ok(!/S[68]sec/.test(det.body), det.body)
        assert.ok(!/S[68]sec/.test((await send('GET', '/v1/mounts')).body))
        for (const [method, url, payload] of [
          ['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' }],
          ['PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } }],
          ['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'disable' }],
        ] as const) {
          const res = await send(method, url, payload)
          assert.equal(res.statusCode, 400, `${method} ${JSON.stringify(payload)}: ${res.body}`)
          assert.equal(res.json().error.reason, 'escaped-separator')
          assert.match(res.json().error.message, new RegExp(`option ${pos} of its /etc/fstab line .* Fix the line on the node`))
          assert.ok(!/S[68]sec/.test(res.body))
        }
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
        const un = await job('POST', `/v1/mounts/${enc(mp)}/state`, { action: 'unmount' })
        assert.equal(un.status, 'completed', JSON.stringify(un.error))
        assert.ok(!calls.some(c => [c.command, ...c.args].join(' ').match(/S[68]sec/)), 'never on an argv')
        const rm2 = await job('DELETE', `/v1/mounts/${enc(mp)}`)
        assert.equal(rm2.status, 'completed', JSON.stringify(rm2.error))
      })
    }

    it('D5: a line naming two credentials files — Mount and Save refused', async () => {
      const mp = join(base, 'd5')
      await mkdir(mp)
      const f = await opFile('username=carol\npassword=OpPw\n')
      const fstab = `//nas/s ${mp} cifs cred=${f},cred=${join(dir, 'creds', 'x.cred')},password=Pinline,vers=3.0,nofail 0 0\n`
      await serve(fstab)
      for (const [method, url, payload] of [['POST', `/v1/mounts/${enc(mp)}/state`, { action: 'mount' }], ['PUT', `/v1/mounts/${enc(mp)}`, {}]] as const) {
        const res = await send(method, url, payload)
        assert.equal(res.statusCode, 400, res.body)
        assert.equal(res.json().error.reason, 'several-credentials-files')
      }
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })

    it('P1: a rotation on a line naming the OPERATOR\'s file copies nothing out of it', async () => {
      const mp = join(base, 'p1')
      await mkdir(mp)
      const f = await opFile('username=bob\npassword=OpPw\npassword2=OpAlt\n')
      await serve(`//nas/s ${mp} cifs credentials=${f},vers=3.0,nofail 0 0\n`)
      extraRows = [{ target: mp, source: '//nas/s', fstype: 'cifs', options: 'rw' }]
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'bob', password: 'NEW' } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const files = await readdir(join(dir, 'creds'))
      assert.equal(await readFile(join(dir, 'creds', files.find(n => !n.startsWith('.'))!), 'utf8'), 'username=bob\npassword=NEW\n')
      const warnings = (done.result as { warnings?: string[] }).warnings ?? []
      assert.ok(warnings.some(w => /was not carried over .* ANAS does not copy anything out of your file/.test(w)), JSON.stringify(warnings))
    })

    for (const verb of ['save', 'remove'] as const) {
      it(`N1: after a ${verb === 'save' ? 'migrating Save' : 'Remove'} no file under the etc dir holds the planted secret except the 0600 credentials file`, async () => {
        const mp = join(base, 'n1')
        await mkdir(mp)
        await serve(`//nas/s ${mp} cifs username=u,password=PlantedS3cret,vers=3.0,nofail 0 0\n`)
        // An earlier edit made a backup holding the line, as the writer does.
        await writeFile(join(dir, 'fstab.bak'), await readFile(join(dir, 'fstab'), 'utf8'))
        await writeFile(join(dir, 'fstab'), `${await readFile(join(dir, 'fstab'), 'utf8')}# an earlier change\n`)
        const done = verb === 'save' ? await job('PUT', `/v1/mounts/${enc(mp)}`, {}) : await job('DELETE', `/v1/mounts/${enc(mp)}`)
        assert.equal(done.status, 'completed', JSON.stringify(done.error))
        const holding = await allFilesHolding('PlantedS3cret', dir)
        const allowed = verb === 'save' ? holding.filter(p => p.startsWith('/creds/')) : []
        assert.deepEqual(holding, allowed, `files holding the secret: ${JSON.stringify(holding)}`)
        if (verb === 'save') {
          const { stat: st } = await import('node:fs/promises')
          assert.equal((await st(join(dir, allowed[0]))).mode & 0o777, 0o600)
        }
      })
    }

    it('N2: a domain token after cred= is what the detail shows (one account path)', async () => {
      const mp = join(base, 'n2')
      await mkdir(mp)
      const f = await opFile('username=alice\npassword=FilePw\ndomain=CORP\n')
      await serve(`//nas/s ${mp} cifs cred=${f},domain=LINEDOM,vers=3.0,nofail 0 0\n`)
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.deepEqual(det.credentials, { set: true, username: 'alice', domain: 'LINEDOM' })
    })

    for (const [name, bytes] of [
      ['a line of 4095 bytes', Buffer.from(`username=alice\npassword=${'x'.repeat(4090)}\n`)],
      ['bytes that are not UTF-8', Buffer.from([0x75, 0x73, 0x65, 0x72, 0x3D, 0xFF, 0xFE, 0x0A])],
    ] as const) {
      it(`N3: a credentials file with ${name} is UNKNOWN in the detail and never migrated`, async () => {
        const mp = join(base, 'n3')
        await mkdir(mp)
        const f = await ownFile(mp, bytes)
        const fstab = `//nas/s ${mp} cifs credentials=${f},password2=Inl2,vers=3.0,nofail 0 0\n`
        await serve(fstab)
        const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
        assert.deepEqual(det.credentials, { set: true, unknown: true })
        const res = await send('PUT', `/v1/mounts/${enc(mp)}`, {})
        assert.equal(res.statusCode, 400, res.body)
        assert.match(res.json().error.message, /mount\.cifs splits in two|is not UTF-8 text/)
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
        assert.deepEqual(await readFile(f), bytes, 'the file is untouched, byte for byte')
      })
    }

    // cr4.conf D-22: the `credentials=` option is the fact that credentials
    // are SET; the file is only where the account is READ. A file the open
    // refused — a directory, a symlink loop, a path that is simply not there
    // — is a read that saw nothing, so the account is UNKNOWN. `set: false`
    // belongs to a line WITHOUT a `credentials=` option, never to a failed
    // read (the two N3 cases above already pin the uninterpretable-content
    // half of this rule; these are the open failures).
    for (const [name, make] of [
      ['a path that is a DIRECTORY', async (f: string) => mkdir(f, { recursive: true })],
      ['a SYMLINK LOOP', async (f: string) => (await import('node:fs/promises')).symlink(f, f)],
      ['a path that is NOT THERE', async () => {}],
    ] as const) {
      it(`D-22: a credentials file that is ${name} reads UNKNOWN in the detail, never set:false`, async () => {
        const mp = join(base, 'd22')
        await mkdir(mp)
        const f = join(dir, 'd22.cred')
        await make(f)
        await serve(`//nas/s ${mp} cifs credentials=${f},vers=3.0,nofail 0 0\n`)
        const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
        assert.deepEqual(det.credentials, { set: true, unknown: true })
      })
    }

    it('N3: a failed fstab write puts a non-UTF-8 credentials file back BYTE for byte', async () => {
      const mp = join(base, 'n3b')
      await mkdir(mp)
      const bytes = Buffer.from([0x75, 0x73, 0x65, 0x72, 0x3D, 0xFF, 0xFE, 0x0A])
      const f = await ownFile(mp, bytes)
      await serve(`//nas/s ${mp} cifs credentials=${f},vers=3.0,nofail 0 0\n`)
      extraRows = [{ target: mp, source: '//nas/s', fstype: 'cifs', options: 'rw' }]
      const { chmodSync, watch } = await import('node:fs')
      let fired = false
      const w = watch(join(dir, 'creds'), (_ev, name) => {
        if (!fired && name === f.split('/').pop()) {
          fired = true
          chmodSync(dir, 0o555)
        }
      })
      let done: Job
      try {
        done = await job('PUT', `/v1/mounts/${enc(mp)}`, { credentials: { username: 'bob', password: 'NEW' } })
      }
      finally {
        w.close()
        chmodSync(dir, 0o755)
      }
      assert.ok(fired)
      assert.equal(done.status, 'failed', JSON.stringify(done.result))
      assert.match(done.error?.message ?? '', /was put back as it was/)
      assert.deepEqual(await readFile(f), bytes)
    })

    it('N6: a CR in ANAS\'s own file is the FILE\'s to fix — the refusal says so', async () => {
      const mp = join(base, 'n6')
      await mkdir(mp)
      const f = await ownFile(mp, 'username=alice\r\npassword=FilePw\n')
      await serve(`//nas/s ${mp} cifs credentials=${f},password2=Inl2,vers=3.0,nofail 0 0\n`)
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, {})
      assert.equal(res.statusCode, 400, res.body)
      assert.match(res.json().error.message, /in the credentials file .* Fix the file on the node/)
    })

    it('N7: Remove also removes a stale .validating candidate and an orphaned hashed credentials file of that mountpoint', async () => {
      const mp = join(base, 'n7')
      await mkdir(mp)
      const { credsFilePath, credsFileName } = await import('../../services/mounts.js')
      await mkdir(join(dir, 'creds'), { recursive: true, mode: 0o700 })
      const hashed = credsFilePath(join(dir, 'creds'), mp)
      const cand = join(dir, 'creds', `.${credsFileName(mp)}.validating`)
      const other = join(dir, 'creds', 'not-ours.cred')
      await writeFile(hashed, 'username=u\npassword=Orphan\n', { mode: 0o600 })
      await writeFile(cand, 'username=u\npassword=HalfRotated\n', { mode: 0o600 })
      await writeFile(other, 'x', { mode: 0o600 })
      await serve(`//nas/s ${mp} cifs guest,vers=3.0,nofail 0 0\n`)
      const done = await job('DELETE', `/v1/mounts/${enc(mp)}`)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.deepEqual(await readdir(join(dir, 'creds')), ['not-ours.cred'])
    })

    it('N7/N2: a guest line with an orphaned hashed file does not show that file as its account', async () => {
      const mp = join(base, 'n7b')
      await mkdir(mp)
      const { credsFilePath } = await import('../../services/mounts.js')
      await mkdir(join(dir, 'creds'), { recursive: true, mode: 0o700 })
      await writeFile(credsFilePath(join(dir, 'creds'), mp), 'username=u\npassword=Orphan\n', { mode: 0o600 })
      await serve(`//nas/s ${mp} cifs guest,vers=3.0,nofail 0 0\n`)
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.deepEqual(det.credentials, { set: false })
    })

    it('N9: an option-only Save does not read the owned credentials path (a directory there does not fail it)', async () => {
      const mp = join(base, 'n9')
      await mkdir(mp)
      const { credsFilePath } = await import('../../services/mounts.js')
      await mkdir(credsFilePath(join(dir, 'creds'), mp), { recursive: true })
      await serve(`nas:/e ${mp} nfs4 vers=4.2,nofail 0 0\n`)
      extraRows = [{ target: mp, source: 'nas:/e', fstype: 'nfs4', options: 'rw' }]
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
    })

    it('N10: a credentials directory that cannot be created is a sentence, never a raw EEXIST', async () => {
      const mp = join(base, 'n10')
      await mkdir(mp)
      await serve(`//nas/s ${mp} cifs username=u,password=InlPw,vers=3.0,nofail 0 0\n`)
      await writeFile(join(dir, 'creds'), 'a file in the way')
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, {})
      assert.equal(done.status, 'failed')
      assert.match(done.error?.message ?? '', /could not create its credentials directory .* something that is not a directory is in its place/)
      assert.ok(!(done.error?.message ?? '').includes('InlPw'))
    })
  })

  // ---- review 2: pass2 / cred aliases ------------------------------------------

  describe('cr3.mounts review 2 (1) — `pass2=` is a secret and `cred=` is the credentials file, everywhere', () => {
    it('the detail hides a pass2= value (fstabLine redacted, never in passthrough)', async () => {
      const mp = join(base, 'p2x')
      await mkdir(mp)
      await serve(`//nas/media ${mp} cifs credentials=/root/.c,pass2=Zs3cret9,vers=3.0,nofail 0 0\n`)
      const det = await send('GET', `/v1/mounts/${enc(mp)}`)
      assert.ok(!det.body.includes('Zs3cret9'), det.body)
      assert.match((det.json().data as MountDetail).fstabLine ?? '', /pass2=\*{5}/)
      assert.ok(!(await send('GET', '/v1/mounts')).body.includes('Zs3cret9'))
    })

    for (const extra of ['pass2=Zs3cret9', 'PASS2=Zs3cret9', 'cred=/root/other.cred']) {
      it(`create refuses extraOptions '${extra}' (400), nothing written or run`, async () => {
        const mp = join(base, 'cr')
        await serve('')
        const res = await send('POST', '/v1/mounts', { type: 'cifs', server: 'nas', remotePath: 's', mountpoint: mp, extraOptions: extra, credentials: { username: 'u', password: 'p' } })
        assert.equal(res.statusCode, 400, res.body)
        assert.deepEqual(calls.filter(isMutation), [])
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), '')
      })
    }

    it('a `cred=` line is credentialed: an edit keeps cred= (never guest) and the mount uses the file', async () => {
      const mp = join(base, 'cr')
      await mkdir(mp)
      await serve(`//nas/s ${mp} cifs cred=/root/x,vers=3.0,nofail 0 0\n`)
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.equal(det.entry?.credentialsFile, '/root/x')
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const line = (await readFile(join(dir, 'fstab'), 'utf8')).trim()
      assert.ok(line.includes('cred=/root/x'), line)
      assert.ok(!line.split(/[ \t]+/)[3].split(',').includes('guest'), `no guest: ${line}`)
      const m = calls.find(c => c.command === MOUNT)!
      assert.ok(m.args.join(' ').includes('cred=/root/x') && !m.args.join(' ').includes('guest'), m.args.join(' '))
    })
  })

  // ---- follow-up (4): an unreadable storage.cfg ----------------------------------

  describe('cr3.mounts follow-up (4) — an unreadable storage.cfg leaves PVE ownership unknown in the list; every verb refuses', () => {
    it('GET /mounts and the detail carry pveOwnershipUnknown; /mnt/pve rows stay PVE\'s; Edit refuses on the strict read', async () => {
      const mp = join(base, 'nfs')
      await mkdir(mp)
      // A storage.cfg that exists but cannot be read (a directory: EISDIR).
      await mkdir(join(dir, 'storage.cfg'))
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,hard,nofail,_netdev 0 0\n`
      await serve(fstab, { storageCfg: join(dir, 'storage.cfg') })
      const list = (await send('GET', '/v1/mounts')).json().data as MountSummary[]
      const row = list.find(r => r.mountpoint === mp)!
      assert.equal(row.pveOwnershipUnknown, true)
      assert.equal(row.pveManaged, false)
      const pve = list.find(r => r.mountpoint === '/mnt/pve/anastest-nfs')!
      assert.equal(pve.pveManaged, true, 'the fixed /mnt/pve path needs no file')
      assert.equal(pve.pveOwnershipUnknown, undefined)
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.equal(det.pveOwnershipUnknown, true)
      // The gates read storage.cfg strictly: refused, nothing done.
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: true } })
      assert.equal(res.statusCode, 400, res.body)
      assert.match(res.json().error.message, /PVE storage configuration is unreadable/)
      assert.deepEqual(calls.filter(isMutation), [])
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })
  })

  // ---- independent review fixes -------------------------------------------------

  describe('cr3.mounts review fixes', () => {
    it('(1) an echo of the credentials FILE\'s domain does not add domain= to a line that has none', async () => {
      const mp = join(base, 'dom')
      await mkdir(mp)
      await mkdir(join(dir, 'creds'), { recursive: true })
      const cred = join(dir, 'creds', 'dom.cred')
      await writeFile(cred, 'username=bob\npassword=p\ndomain=CORP\n', { mode: 0o600 })
      const fstab = `//nas/media ${mp} cifs vers=3.1.1,credentials=${cred},nosuid,nodev,nofail,_netdev 0 0\n`
      await serve(fstab)
      extraRows = [{ target: mp, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.equal(det.credentials?.domain, 'CORP')
      const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { options: { domain: 'CORP' } })
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab, 'byte-identical: no domain=CORP added')
      // A domain the operator really sets (different from the file's) still lands.
      const set = await job('PUT', `/v1/mounts/${enc(mp)}`, { options: { domain: 'OTHER' } })
      assert.equal(set.status, 'completed', JSON.stringify(set.error))
      assert.match(await readFile(join(dir, 'fstab'), 'utf8'), /domain=OTHER/)
    })

    for (const [name, sep] of [['NBSP', '\u00A0'], ['U+3000', '\u3000'], ['U+2003', '\u2003']] as const) {
      it(`(2) a password carrying ${name} is redacted whole in fstabLine; its tail reaches no reader`, async () => {
        const mp = join(base, 'r')
        await mkdir(mp)
        await serve(`//nas/r ${mp} cifs username=bob,password=ab${sep}TAILSECRET,nofail 0 0\n`)
        const detail = await send('GET', `/v1/mounts/${enc(mp)}`)
        assert.ok(!detail.body.includes('TAILSECRET'), detail.body)
        assert.match((detail.json().data as MountDetail).fstabLine ?? '', /password=\*{5},nofail/)
        const list = await send('GET', '/v1/mounts')
        assert.ok(!list.body.includes('TAILSECRET'))
      })
    }

    it('(5) an untouched save changes nothing and RUNS nothing — no umount, no mount, no daemon-reload — and says so', async () => {
      for (const line of [
        (mp: string) => `nas:/export ${mp} nfs4 vers=4.2,hard,nosuid,nodev,nofail,_netdev 0 0\n`,
        (mp: string) => `nas:/export ${mp} nfs4 vers=4.2,hard,noauto,nofail,_netdev 0 0\n`, // an unmounted noauto line is not mounted by a save
      ]) {
        const mp = join(base, `u${Math.random().toString(36).slice(2, 6)}`)
        await mkdir(mp)
        const fstab = line(mp)
        await serve(fstab)
        extraRows = fstab.includes('noauto') ? [] : [{ target: mp, source: 'nas:/export', fstype: 'nfs4', options: 'rw,vers=4.2,hard' }]
        const done = await job('PUT', `/v1/mounts/${enc(mp)}`, { options: { noatime: false } })
        assert.equal(done.status, 'completed', JSON.stringify(done.error))
        const result = done.result as { unchanged?: boolean, message?: string }
        assert.equal(result.unchanged, true)
        assert.match(result.message ?? '', /Nothing changed/)
        assert.deepEqual(calls.filter(isMutation), [], 'no umount, mount or daemon-reload')
        assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
      }
    })

    it('(6) a byte-equal echo of a hand-written passthrough that fails the token rule saves; anything new is validated', async () => {
      const mp = join(base, 'pt')
      await mkdir(mp)
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,nofail,x-note=a\\040b 0 0\n`
      await serve(fstab)
      extraRows = [{ target: mp, source: 'nas:/export', fstype: 'nfs4', options: 'rw' }]
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      assert.equal(det.configuredOptions?.passthrough, 'x-note=a\\040b')
      const echo = await job('PUT', `/v1/mounts/${enc(mp)}`, { extraOptions: det.configuredOptions!.passthrough })
      assert.equal(echo.status, 'completed', JSON.stringify(echo.error))
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
      for (const bad of ['x-other=a\\040b', 'x-note=a\\040b,password=s3cret', 'credentials=/x']) {
        const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { extraOptions: bad })
        assert.equal(res.statusCode, 400, `${bad}: ${res.body}`)
      }
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
    })

    it('(7) Remove\'s directory warning names the real reason (a symlinked parent), not "a protected system path"', async () => {
      await mkdir(join(base, 'real', 'share'), { recursive: true })
      const { symlink } = await import('node:fs/promises')
      await symlink(join(base, 'real'), join(base, 'link'))
      const mp = join(base, 'link', 'share')
      await serve(`nas:/export ${mp} nfs4 vers=4.2,nofail 0 0\n`)
      const done = await job('DELETE', `/v1/mounts/${enc(mp)}?removeMountpointDir=true`)
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      const warnings = (done.result as { warnings?: string[] }).warnings ?? []
      assert.ok(warnings.some(w => w.includes('was left in place') && /symlink/.test(w)), JSON.stringify(warnings))
      assert.ok(!warnings.some(w => /protected system path/.test(w)))
    })

    it('(8, as re-ruled) a password2= line is displayed normally in the list and the detail, its value hidden', async () => {
      const filed = join(base, 'p2f')
      await mkdir(filed)
      await serve(`//nas/media ${filed} cifs credentials=${dir}/c.cred,password2=R0tate#2,vers=3.0,nofail 0 0\n`)
      extraRows = [{ target: filed, source: '//nas/media', fstype: 'cifs', options: 'rw' }]
      const list = (await send('GET', '/v1/mounts')).json().data as MountSummary[]
      const row = list.find(r => r.mountpoint === filed)!
      assert.equal(row.type, 'cifs')
      assert.equal(row.remote, true)
      assert.equal(row.state, 'ok')
      const det = await send('GET', `/v1/mounts/${enc(filed)}`)
      assert.equal(det.statusCode, 200)
      assert.ok(!det.body.includes('R0tate#2'))
      assert.match((det.json().data as MountDetail).fstabLine ?? '', /password2=\*{5}/)
    })

    it('review 2 (4): a stored passthrough with a VT inside a token is echoed by a save (the line was unsaveable)', async () => {
      const mp = join(base, 'vt')
      await mkdir(mp)
      const fstab = `nas:/export ${mp} nfs4 vers=4.2,nofail,x-note=a\u000Bb 0 0\n`
      await serve(fstab)
      extraRows = [{ target: mp, source: 'nas:/export', fstype: 'nfs4', options: 'rw' }]
      const det = (await send('GET', `/v1/mounts/${enc(mp)}`)).json().data as MountDetail
      const echo = await job('PUT', `/v1/mounts/${enc(mp)}`, { extraOptions: det.configuredOptions!.passthrough })
      assert.equal(echo.status, 'completed', JSON.stringify(echo.error))
      assert.equal(await readFile(join(dir, 'fstab'), 'utf8'), fstab)
      // Not byte-equal: the full validator still answers.
      const res = await send('PUT', `/v1/mounts/${enc(mp)}`, { extraOptions: 'x-other=a\u000Bb' })
      assert.equal(res.statusCode, 400, res.body)
      // A newline or NUL never passes the boundary.
      for (const bad of ['x-note=a\nb', 'x-note=a\u0000b'])
        assert.equal((await send('PUT', `/v1/mounts/${enc(mp)}`, { extraOptions: bad })).statusCode, 400)
    })
  })
})

// ---- L9: Test from Edit with the stored credentials ------------------------

describe('MOUNTS-L9 — Test from Edit of a credentialed CIFS mount uses the line\'s own credentials', () => {
  let dir = ''
  let app: ReturnType<typeof Fastify> | undefined
  let executor: MockExecutor
  const savedRuntime = process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR

  async function start(fstab: string): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-l9-'))
    process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = join(dir, 'run')
    await writeFile(join(dir, 'fstab'), fstab.replaceAll('@DIR@', dir))
    executor = new MockExecutor()
    executor.addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 0 } })
    executor.addFixture({ command: UMOUNT, result: { stdout: '', stderr: '', exitCode: 0 } })
    app = Fastify({ logger: false })
    await app.register(mountsRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: new JobQueue(),
      confirmStore: new ConfirmStore(),
      fstabPath: join(dir, 'fstab'),
      credsDir: join(dir, 'creds'),
      storagePath: join(dir, 'no-storage.cfg'),
      mountTestStages: { resolves: async () => true, tcpReachable: async () => true },
    })
  }

  afterEach(async () => {
    await app?.close()
    app = undefined
    if (savedRuntime === undefined)
      delete process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR
    else
      process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = savedRuntime
    await rm(dir, { recursive: true, force: true })
  })

  const post = (body: unknown) => app!.inject({ method: 'POST', url: '/v1/mounts/test', headers: JSON_HEADERS, payload: JSON.stringify(body) })

  it('the reviewer\'s body (a username, no password) is still a schema 400 (probe p6)', async () => {
    await start('')
    const res = await post({ type: 'cifs', server: 'nas', remotePath: 'media', credentials: { username: 'bob' } })
    assert.equal(res.statusCode, 400)
  })

  it('`mountpoint` and no credentials: the probe authenticates with the credentials FILE the line names', async () => {
    await start('//nas/media /mnt/media cifs credentials=@DIR@/media.cred,vers=3.0,nofail 0 0\n')
    const res = await post({ type: 'cifs', server: 'nas', remotePath: 'media', mountpoint: '/mnt/media' })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().data.verdict, 'ok')
    const probe = executor.calls.find(c => c.command === '/usr/bin/timeout')!
    assert.equal(probe.args[5], `vers=3.0,credentials=${dir}/media.cred`, 'the line\'s file and its vers')
  })

  it('a hand-written inline password is tested from a private temp file, never argv', async () => {
    await start('//nas/media /mnt/media cifs username=bob,password=s3cret,vers=3.0,nofail 0 0\n')
    const res = await post({ type: 'cifs', server: 'nas', remotePath: 'media', mountpoint: '/mnt/media' })
    assert.equal(res.statusCode, 200, res.body)
    const probe = executor.calls.find(c => c.command === '/usr/bin/timeout')!
    assert.match(probe.args[5], /^vers=3\.0,credentials=.+probe\.cred$/)
    assert.ok(!probe.args.join(' ').includes('s3cret'))
  })

  it('stored credentials are never offered to another share: 400, nothing probed', async () => {
    await start('//nas/media /mnt/media cifs credentials=@DIR@/media.cred,nofail 0 0\n')
    const res = await post({ type: 'cifs', server: 'evil.example', remotePath: 'media', mountpoint: '/mnt/media' })
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/timeout').length, 0)
  })

  it('review fix 3: a username-only line (no password, no file) is a 400 — never a guest probe for another identity', async () => {
    await start('//nas/media /mnt/media cifs username=bob,nofail 0 0\n')
    const res = await post({ type: 'cifs', server: 'nas', remotePath: 'media', mountpoint: '/mnt/media' })
    assert.equal(res.statusCode, 400, res.body)
    assert.match(res.json().error.message, /type the password/)
    assert.equal(executor.calls.filter(c => c.command === '/usr/bin/timeout').length, 0)
  })

  it('review 2 (5): a probe runtime directory that cannot be created is a 503 naming it, never a raw errno 500', async () => {
    await start('')
    // A FILE where the runtime directory's parent should be: ENOTDIR.
    process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = join(dir, 'fstab', 'run')
    const res = await post({ type: 'nfs', server: 'nas', remotePath: '/e' })
    assert.equal(res.statusCode, 503, res.body)
    assert.equal(res.json().error.code, 'UNAVAILABLE')
    assert.match(res.json().error.message, new RegExp(`could not create its private probe directory under ${join(dir, 'fstab', 'run').replaceAll('/', '\\/')} \\(ENOTDIR\\)`))
  })

  it('review 4 (N8): a username AFTER cred= is what the mount uses — the probe tests that account (the file\'s password, the line\'s user)', async () => {
    await start('//nas/media /mnt/media cifs cred=@DIR@/op.cred,user=bob,vers=3.0,nofail 0 0\n')
    await writeFile(join(dir, 'op.cred'), 'username=alice\npassword=FilePw\n', { mode: 0o600 })
    let probeFile = ''
    const orig = executor.exec.bind(executor)
    executor.exec = async (command, args, o) => {
      if (command === '/usr/bin/timeout') {
        const f = /credentials=([^,]+)/.exec(args[5])?.[1]
        probeFile = f ? await readFile(f, 'utf8') : `(no file: ${args[5]})`
      }
      return orig(command, args, o)
    }
    const res = await post({ type: 'cifs', server: 'nas', remotePath: 'media', mountpoint: '/mnt/media' })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(probeFile, 'username=bob\npassword=FilePw\n')
  })

  it('a mountpoint with no CIFS line is a 404', async () => {
    await start('nas:/export /mnt/media nfs4 nofail 0 0\n')
    const res = await post({ type: 'cifs', server: 'nas', remotePath: 'media', mountpoint: '/mnt/media' })
    assert.equal(res.statusCode, 404, res.body)
  })
})
