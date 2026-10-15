import type { BackupTask, Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { disableMount } from '../../parsers/fstab.js'
import { createServer } from '../../server.js'
import { renderServiceUnit as renderBackupService } from '../../services/backup-units.js'
import { credsFilePath } from '../../services/mounts.js'

/**
 * Story cr.39 — the mount verbs on the guard (docs/WAVE3-DESIGN.md §2.5, the
 * mount rows are the acceptance list; §3–§5; §8.2). The H8 property: a state
 * that would refuse at the route but becomes true only AFTER the request was
 * accepted — while the job waits in the queue — refuses the job, and the mock
 * executor shows no mutating argv. One race test per "Missing" cell:
 *
 *  - create: the non-persistent create re-checks the fstab entry;
 *  - update: the line's revision (the job writes a merge of the RT line);
 *  - mount / enable / unmount / disable: held by a LUN, and the verb's state;
 *  - remove: held by a LUN, and the holders a forced unmount detaches;
 *
 * plus the reference check EPICS §2 Mounts describes ("unmount cross-checks
 * shares and backup tasks riding the path"; Q4: warn, never refuse), the
 * always-confirming remove and what it binds, and the `mount:<path>` lock.
 *
 * The job is held in the REAL queue: four placeholder jobs fill the four
 * slots, the request is accepted behind them (`queued`), the test changes the
 * node's state, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes print captured output). Each flip serves a
 * capture, with the one rewrite it needs spelled out at the call site:
 *  - fstab: `mounts/fstab-anas-managed`; a hand edit is one token added to a
 *    captured line, a disabled line is the daemon's own `disableMount` of it;
 *  - the mount table: `mounts/findmnt-full.json` (the dev mock's answer);
 *  - LIO: `iscsi/configfs-restore-empty.manifest` (a target, no LUNs) at the
 *    request; `iscsi/configfs-live.manifest` with its fileio LUN's image
 *    re-pointed from `/gtiscsi/images/lun2.raw` to a file under the mount;
 *  - holders: the `lsof +f -- /mnt/anas-cifs` block of
 *    `mounts/busy-unmount.txt` (two `sleep` holders), with one row dropped for
 *    the state the operator confirmed;
 *  - references: `samba/smb.conf` with `[media]`'s path re-pointed under the
 *    mount; a backup task is a real `anas-backup-*` unit (the daemon's writer).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const FINDMNT = '/usr/bin/findmnt'
const MOUNT = '/usr/bin/mount'
const UMOUNT = '/usr/bin/umount'
const LSOF = '/usr/bin/lsof'
const SYSTEMCTL = '/usr/bin/systemctl'

const NFS_MP = '/mnt/anas-nfs'
const CIFS_MP = '/mnt/anas-cifs'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const enc = (path: string): string => encodeURIComponent(path)

const FSTAB = fixture('mounts/fstab-anas-managed')
const NFS_LINE = '127.0.0.1:/srv/nfs/export1  /mnt/anas-nfs  nfs4  defaults,nofail  0  0'
/** The NFS line as an operator hand-edited it (one option added). */
const FSTAB_NFS_HAND_EDITED = rewrite(FSTAB, NFS_LINE, NFS_LINE.replace('defaults,nofail', 'defaults,nofail,noatime'))
/** The NFS line disabled the way the daemon disables it. */
const FSTAB_NFS_DISABLED = disableMount(FSTAB, NFS_MP)

const FINDMNT_FULL = fixture('mounts/findmnt-full.json')

const LIO_NO_LUNS = fixture('iscsi/configfs-restore-empty.manifest')
/** The capture's fileio LUN, its image moved under the NFS mount. */
const LIO_LUN_UNDER_NFS = fixture('iscsi/configfs-live.manifest').split('/gtiscsi/images/lun2.raw').join(`${NFS_MP}/lun2.raw`)

/** The `lsof +f -- /mnt/anas-cifs` block of the busy-unmount capture (header + two holders). */
const LSOF_TWO_HOLDERS = (() => {
  const text = fixture('mounts/busy-unmount.txt')
  const start = text.indexOf('### lsof +f -- /mnt/anas-cifs\n') + '### lsof +f -- /mnt/anas-cifs\n'.length
  const block = text.slice(start, text.indexOf('lsof EXIT=0', start))
  assert.match(block, /^COMMAND +PID/)
  return block
})()
/** The same capture with its second holder (pid 5961) not yet there. */
const LSOF_ONE_HOLDER = LSOF_TWO_HOLDERS.split('\n').filter(l => !l.includes(' 5961 ')).join('\n')

/** `[media]` of the smb.conf capture, re-pointed at a directory on the NFS mount. */
const SMB_MEDIA_ON_NFS = rewrite(fixture('samba/smb.conf'), 'path = /tank/media', `path = ${NFS_MP}/media`)

/** A backup task whose source is on the NFS mount — written by the daemon's own unit writer. */
const BACKUP_ON_NFS: BackupTask = {
  name: 'nas-media',
  repository: 'pve:local',
  backupId: 'nas-media',
  archives: [{ name: 'media', path: `${NFS_MP}/media`, excludes: [] }],
  changeDetectionMode: 'default',
  notify: 'always',
  schedule: '*-*-* 02:00:00',
  enabled: true,
  limitNofile: 1024,
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** A call that would mean a mount verb acted on the node. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return c.command === MOUNT || c.command === UMOUNT || (c.command === SYSTEMCTL && ['daemon-reload', 'stop'].includes(c.args[0]))
}

const ENV_KEYS = [
  'ANAS_FSTAB_PATH',
  'ANAS_CREDS_DIR',
  'ANAS_STORAGE_CFG',
  'ANAS_ISCSI_CONFIGFS',
  'ANAS_ISCSI_SAVECONFIG',
  'ANAS_ISCSI_SYS_BLOCK',
  'SMB_CONF_PATH',
  'ANAS_EXPORTS_PATH',
  'ANAS_SYSTEMD_DIR',
] as const

describe('cr.39 — mount verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let paths: { fstab: string, creds: string, configfs: string, smb: string, exports: string, systemd: string }
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] } [] = []
  /** What `lsof +f -- <mp>` answers right now (null: nothing holds it — the dev mock's answer). */
  let lsof: string | null = null
  /** A command that does not return until the test releases it. */
  const paused = new Map<string, Promise<void>>()
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr39-'))
    paths = {
      fstab: join(dir, 'fstab'),
      creds: join(dir, 'creds'),
      configfs: join(dir, 'target'),
      smb: join(dir, 'smb.conf'),
      exports: join(dir, 'exports'),
      systemd: join(dir, 'units'),
    }
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

  /** The dev mock over private copies of the captures; reads routed through the flippable state. */
  async function serve(fstab = FSTAB): Promise<void> {
    lsof = null
    paused.clear()
    await writeFile(paths.fstab, fstab)
    await writeFile(paths.smb, fixture('samba/smb.conf'))
    await writeFile(paths.exports, fixture('nfs/etc-exports'))
    await mkdir(paths.systemd, { recursive: true })
    await rm(paths.configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(LIO_NO_LUNS, paths.configfs)
    process.env.ANAS_FSTAB_PATH = paths.fstab
    process.env.ANAS_CREDS_DIR = paths.creds
    process.env.ANAS_STORAGE_CFG = join(FIXTURES, 'mounts/storage.cfg')
    process.env.ANAS_ISCSI_CONFIGFS = paths.configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.SMB_CONF_PATH = paths.smb
    process.env.ANAS_EXPORTS_PATH = paths.exports
    process.env.ANAS_SYSTEMD_DIR = paths.systemd
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      if (command === FINDMNT && args.length === 1 && args[0] === '--json')
        return ok(FINDMNT_FULL)
      if (command === LSOF && lsof !== null)
        return ok(lsof)
      const hold = paused.get(command)
      if (hold)
        await hold
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /** Fill the four slots; the next accepted job waits `queued` until the release. */
  function holdSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  interface Req { method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown }

  function send(req: Req, code?: string) {
    return server!.inject({
      method: req.method,
      url: req.url,
      headers: { ...(req.payload === undefined ? IDENTITY_HEADERS : JSON_HEADERS), ...(code ? { 'x-anas-confirm': code } : {}) },
      ...(req.payload === undefined ? {} : { payload: JSON.stringify(req.payload) }),
    })
  }

  /** Send; answer a 409 confirm challenge with its code; return the accepted job's id. */
  async function accepted(req: Req): Promise<string> {
    let res = await send(req)
    if (res.statusCode === 409 && res.headers['x-anas-confirm-code'])
      res = await send(req, res.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    return (res.json() as JobAccepted).job.id
  }

  /** Accept the request while the four slots are held: it waits `queued`. */
  async function acceptedBehindFullQueue(req: Req): Promise<{ id: string, release: () => void }> {
    const release = holdSlots()
    const id = await accepted(req)
    assert.equal(queue().get(id)?.status, 'queued', 'the accepted job waits behind the held slots')
    return { id, release }
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

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(cond(), 'condition not reached')
  }

  const state = (mp: string, action: string): Req => ({ method: 'POST', url: `/v1/mounts/${enc(mp)}/state`, payload: { action } })
  const remove = (mp: string, query = ''): Req => ({ method: 'DELETE', url: `/v1/mounts/${enc(mp)}${query}` })
  const update = (mp: string, options: Record<string, unknown>): Req => ({ method: 'PUT', url: `/v1/mounts/${enc(mp)}`, payload: { options } })

  // -------------------------------------------------------------------------
  // The harness acts when nothing changes
  // -------------------------------------------------------------------------

  it('control: with nothing changed every held verb runs and acts — the harness does not refuse on its own', async () => {
    const cases: Array<{ fstab?: string, req: Req, acted: (c: { command: string, args: string[] }) => boolean }> = [
      { req: state(NFS_MP, 'unmount'), acted: c => c.command === UMOUNT },
      { req: state(NFS_MP, 'disable'), acted: c => c.command === UMOUNT },
      { req: remove(NFS_MP), acted: c => c.command === UMOUNT },
      { req: state(NFS_MP, 'mount'), acted: c => c.command === MOUNT },
      { fstab: FSTAB_NFS_DISABLED, req: state(NFS_MP, 'enable'), acted: c => c.command === SYSTEMCTL && c.args[0] === 'daemon-reload' },
      { req: update(NFS_MP, { noatime: true }), acted: c => c.command === UMOUNT },
    ]
    for (const { fstab, req, acted } of cases) {
      await serve(fstab)
      const { id, release } = await acceptedBehindFullQueue(req)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'completed', `${req.method} ${req.url}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(acted), `${req.method} ${req.url} acted`)
      await server!.close()
      server = undefined
    }
  })

  // -------------------------------------------------------------------------
  // §2.5 "mount / enable / unmount / disable" + "mount remove": LUN-held
  // -------------------------------------------------------------------------

  it('a LUN whose image appears under the mount after the request refuses unmount, disable AND remove — no umount, fstab untouched', async () => {
    for (const req of [state(NFS_MP, 'unmount'), state(NFS_MP, 'disable'), remove(NFS_MP)]) {
      await serve()
      const { id, release } = await acceptedBehindFullQueue(req)
      // A file LUN is created on the mount while the job waits.
      await rm(paths.configfs, { recursive: true, force: true })
      await materializeConfigfsManifest(LIO_LUN_UNDER_NFS, paths.configfs)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'failed', req.url)
      assert.equal(job.error?.code, 'CONFLICT', req.url)
      assert.match(job.error!.message, /mount '\/mnt\/anas-nfs' is refused: it is held by iSCSI LUN \d+ 'gtiscsi_lun2'/)
      assert.deepEqual(calls.filter(isMutation), [], `${req.method} ${req.url}: no mutating argv`)
      assert.equal(await readFile(paths.fstab, 'utf8'), FSTAB, 'fstab untouched')
      await server!.close()
      server = undefined
    }
  })

  it('the same LUN at the request is the route\'s hard 409 — the route and the job share the gate', async () => {
    await serve()
    await rm(paths.configfs, { recursive: true, force: true })
    await materializeConfigfsManifest(LIO_LUN_UNDER_NFS, paths.configfs)
    for (const req of [state(NFS_MP, 'unmount'), state(NFS_MP, 'disable'), remove(NFS_MP)]) {
      const res = await send(req)
      assert.equal(res.statusCode, 409, req.url)
      assert.equal(res.json().error.reason, 'held-by-lun')
      assert.equal(res.headers['x-anas-confirm-code'], undefined, 'no confirm bypass')
    }
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // -------------------------------------------------------------------------
  // §2.5 "mount / enable": the verb's state
  // -------------------------------------------------------------------------

  it('a line disabled after a Mount was accepted refuses the job ("enable it first") — no mount', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(state(NFS_MP, 'mount'))
    await writeFile(paths.fstab, FSTAB_NFS_DISABLED)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'VALIDATION_ERROR')
    assert.equal(job.error?.message, `Mount '${NFS_MP}' is disabled — enable it first`)
    assert.ok(!calls.some(c => c.command === MOUNT), 'mount never ran')
  })

  it('a line enabled by hand after an Enable was accepted refuses the job ("not disabled") — fstab not rewritten', async () => {
    await serve(FSTAB_NFS_DISABLED)
    const { id, release } = await acceptedBehindFullQueue(state(NFS_MP, 'enable'))
    await writeFile(paths.fstab, FSTAB)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.message, `Mount '${NFS_MP}' is not disabled`)
    assert.deepEqual(calls.filter(isMutation), [])
    assert.equal(await readFile(paths.fstab, 'utf8'), FSTAB)
  })

  // -------------------------------------------------------------------------
  // §2.5 "mount create": the non-persistent create re-checks the fstab entry
  // -------------------------------------------------------------------------

  it('a non-persistent create whose mountpoint gains an fstab line while it waits is refused — no mkdir, no mount, that line\'s secret untouched', async () => {
    await serve()
    const mp = join(dir, 'ephemeral')
    const { id, release } = await acceptedBehindFullQueue({
      method: 'POST',
      url: '/v1/mounts',
      payload: { type: 'cifs', server: '127.0.0.1', remotePath: 'anastest', mountpoint: mp, persistent: false, mountNow: true, credentials: { username: 'new', password: 'n3w' } },
    })
    // An operator adds a line for the same mountpoint, with its own secret
    // under the mountpoint's credentials name (the captured CIFS line, moved).
    const theirs = credsFilePath(paths.creds, mp)
    await mkdir(paths.creds, { recursive: true })
    await writeFile(theirs, fixture('mounts/creds-anastest.cred'), { mode: 0o600 })
    await writeFile(paths.fstab, rewrite(rewrite(FSTAB, '/mnt/anas-cifs ', `${mp} `), 'credentials=/etc/anas/creds/anastest.cred', `credentials=${theirs}`))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT')
    assert.equal(job.error?.message, `Mount '${mp}' is already in /etc/fstab`)
    assert.ok(!calls.some(c => c.command === MOUNT), 'mount never ran')
    await assert.rejects(stat(mp), 'the mountpoint was never created')
    assert.equal(await readFile(theirs, 'utf8'), fixture('mounts/creds-anastest.cred'), 'the line\'s credentials are byte-identical')
    assert.deepEqual(await readdir(paths.creds), [credsFilePath(paths.creds, mp).split('/').pop()])
  })

  // -------------------------------------------------------------------------
  // §2.5 "mount update": the line's revision
  // -------------------------------------------------------------------------

  it('an edit whose line is hand-edited while it waits fails STATE_CHANGED — the hand edit survives, nothing remounted', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(update(NFS_MP, { ro: true }))
    await writeFile(paths.fstab, FSTAB_NFS_HAND_EDITED)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.equal(job.error?.message, `Mount '${NFS_MP}' changed since you confirmed — nothing was done; reload and confirm again`)
    assert.deepEqual(calls.filter(isMutation), [])
    assert.equal(await readFile(paths.fstab, 'utf8'), FSTAB_NFS_HAND_EDITED, 'the operator\'s edit is not overwritten by a merge of the old line')
  })

  it('an edit whose line is replaced by another share while it waits fails IDENTITY_MISMATCH', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(update(NFS_MP, { ro: true }))
    await writeFile(paths.fstab, rewrite(FSTAB, NFS_LINE, NFS_LINE.replace('127.0.0.1:/srv/nfs/export1', '127.0.0.1:/srv/nfs/backups')))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'IDENTITY_MISMATCH')
    assert.match(job.error!.message, /spec 127\.0\.0\.1:\/srv\/nfs\/export1, fstype nfs4 at the confirmation, spec 127\.0\.0\.1:\/srv\/nfs\/backups, fstype nfs4 now/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // -------------------------------------------------------------------------
  // §2.5 "mount remove": holders, and what the confirm binds
  // -------------------------------------------------------------------------

  it('a forced remove detaches only the holders it confirmed: a new holder before the job refuses it — no umount -l', async () => {
    await serve()
    lsof = LSOF_ONE_HOLDER
    const first = await send(remove(CIFS_MP))
    assert.equal(first.statusCode, 409)
    assert.deepEqual(first.json().error.warnings.filter((w: string) => w.startsWith('sleep')), ['sleep (pid 5960)'])
    const release = holdSlots()
    const res = await send(remove(CIFS_MP), first.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    lsof = LSOF_TWO_HOLDERS // a second process opens the mount
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, /holders the confirmation did not name \(sleep \(pid 5961\)\)/)
    assert.deepEqual(calls.filter(isMutation), [])
    assert.equal(await readFile(paths.fstab, 'utf8'), FSTAB)
  })

  it('a forced remove whose confirmed holders are still the ones there unmounts lazily (and one that left is no reason to stop)', async () => {
    await serve()
    lsof = LSOF_TWO_HOLDERS
    const { id, release } = await acceptedBehindFullQueue(remove(CIFS_MP))
    lsof = LSOF_ONE_HOLDER // pid 5961 exits
    release()
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(calls.some(c => c.command === UMOUNT && c.args[0] === '-l' && c.args[1] === CIFS_MP))
  })

  it('remove ALWAYS confirms — an idle, unreferenced mount too — and the challenge names what it deletes', async () => {
    await serve()
    const res = await send(remove(NFS_MP, '?removeMountpointDir=true'))
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
    assert.ok(res.headers['x-anas-confirm-code'])
    assert.deepEqual(res.json().error.warnings, [
      `The /etc/fstab line for '${NFS_MP}' is deleted; the mount does not come back at boot.`,
      `'${NFS_MP}' is unmounted now.`,
      `The mountpoint directory '${NFS_MP}' is removed if it is empty (never its contents).`,
    ])
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('remove binds removeMountpointDir: a resend with the other value is 409 CONFIRM_SCOPE_CHANGED naming it (both directions)', async () => {
    await serve()
    for (const [from, to, sentence] of [
      ['', '?removeMountpointDir=true', 'You confirmed with removeMountpointDir off; this request has removeMountpointDir on — confirm again'],
      ['?removeMountpointDir=true', '?removeMountpointDir=false', 'You confirmed with removeMountpointDir on; this request has removeMountpointDir off — confirm again'],
    ] as const) {
      const first = await send(remove(NFS_MP, from))
      const res = await send(remove(NFS_MP, to), first.headers['x-anas-confirm-code'] as string)
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRM_SCOPE_CHANGED')
      assert.deepEqual(res.json().error.changed, ['removeMountpointDir'])
      assert.equal(res.json().error.message, sentence)
    }
    assert.deepEqual(calls.filter(isMutation), [])
  })

  it('remove binds the credentials file it deletes: a line re-pointed at another file before the job fails STATE_CHANGED naming both', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(remove(CIFS_MP))
    await writeFile(paths.fstab, rewrite(FSTAB, 'credentials=/etc/anas/creds/anastest.cred', `credentials=${join(paths.creds, 'other.cred')}`))
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED')
    assert.match(job.error!.message, /the credentials file to remove: \/etc\/anas\/creds\/anastest\.cred at the confirmation, the credentials file to remove: \S+other\.cred now/)
    assert.deepEqual(calls.filter(isMutation), [])
  })

  // -------------------------------------------------------------------------
  // EPICS §2 Mounts: what rides the path (cr.24's helper; Q4: warn, never refuse)
  // -------------------------------------------------------------------------

  it('unmount, disable and remove name the SMB share and the backup task riding the path in the confirm — and never refuse', async () => {
    await serve()
    await writeFile(paths.smb, SMB_MEDIA_ON_NFS)
    await writeFile(join(paths.systemd, 'anas-backup-nas-media.service'), renderBackupService(BACKUP_ON_NFS))
    const expected = [
      `SMB share 'media' serves '${NFS_MP}/media', which is on this mount, and stops working while it is not mounted`,
      `Backup task 'nas-media' backs up '${NFS_MP}/media', which is on this mount - its source is missing while it is not mounted`,
    ]
    for (const req of [state(NFS_MP, 'unmount'), state(NFS_MP, 'disable'), remove(NFS_MP)]) {
      const res = await send(req)
      assert.equal(res.statusCode, 409, `${req.url}: an idle unmount now confirms because something rides the path`)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      const warnings = res.json().error.warnings as string[]
      for (const line of expected)
        assert.ok(warnings.includes(line), `${req.url}: ${warnings.join(' | ')}`)
      const done = await send(req, res.headers['x-anas-confirm-code'] as string)
      assert.equal(done.statusCode, 202, done.body)
      const job = await finished((done.json() as JobAccepted).job.id)
      assert.equal(job.status, 'completed', JSON.stringify(job.error))
      assert.equal((job.result as { warnings?: string[] }).warnings, undefined, 'a reference the confirm listed is not repeated')
      // Put the line back for the next verb.
      await writeFile(paths.fstab, FSTAB)
    }
  })

  it('an idle unmount with nothing riding the path still runs without a confirm (wire-compatible)', async () => {
    await serve()
    const res = await send(state(NFS_MP, 'unmount'))
    assert.equal(res.statusCode, 202, res.body)
  })

  it('a share that appears on the path after the unmount was accepted is reported on the COMPLETED job, not refused', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(state(NFS_MP, 'unmount'))
    await writeFile(paths.smb, SMB_MEDIA_ON_NFS)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual((job.result as { warnings?: string[] }).warnings, [
      `SMB share 'media' serves '${NFS_MP}/media', which is on this mount, and stops working while it is not mounted`,
    ])
    assert.ok(calls.some(c => c.command === UMOUNT && c.args[0] === NFS_MP))
  })

  it('a reference source that cannot be read is disclosed in the confirm, never read as "nothing there"', async () => {
    await serve()
    await rm(paths.smb)
    await mkdir(paths.smb) // smb.conf is a directory: readConfig fails, not ENOENT
    const res = await send(state(NFS_MP, 'unmount'))
    assert.equal(res.statusCode, 409)
    assert.ok((res.json().error.warnings as string[]).includes(
      `ANAS could not read smb.conf, so it could not check whether an SMB share serves a path on '${NFS_MP}'. If this node has SMB shares, verify their paths before confirming.`,
    ))
  })

  // -------------------------------------------------------------------------
  // §4.2: `mount:<target path>`, exclusive, for every verb
  // -------------------------------------------------------------------------

  it('every verb holds mount:<path> exclusive while it acts', async () => {
    const cases: Array<{ fstab?: string, req: Req, command: string, key: string }> = [
      { req: state(NFS_MP, 'unmount'), command: UMOUNT, key: `mount:${NFS_MP}` },
      { req: state(NFS_MP, 'disable'), command: UMOUNT, key: `mount:${NFS_MP}` },
      { req: remove(NFS_MP), command: UMOUNT, key: `mount:${NFS_MP}` },
      { req: state(NFS_MP, 'mount'), command: MOUNT, key: `mount:${NFS_MP}` },
      { fstab: FSTAB_NFS_DISABLED, req: state(NFS_MP, 'enable'), command: SYSTEMCTL, key: `mount:${NFS_MP}` },
      { req: update(NFS_MP, { noatime: true }), command: UMOUNT, key: `mount:${NFS_MP}` },
    ]
    for (const { fstab, req, command, key } of cases) {
      await serve(fstab)
      let release!: () => void
      paused.set(command, new Promise<void>((resolve) => {
        release = resolve
      }))
      const id = await accepted(req)
      await until(() => calls.some(c => c.command === command))
      assert.deepEqual(queue().heldLocks(), [{ key, mode: 'exclusive', holders: [id] }], `${req.method} ${req.url}`)
      release()
      assert.equal((await finished(id)).status, 'completed')
      assert.deepEqual(queue().heldLocks(), [], 'released')
      await server!.close()
      server = undefined
    }
  })

  it('create holds mount:<path> too, keyed by the normalised mountpoint', async () => {
    await serve()
    let release!: () => void
    paused.set(MOUNT, new Promise<void>((resolve) => {
      release = resolve
    }))
    const mp = join(dir, 'made')
    const id = await accepted({ method: 'POST', url: '/v1/mounts', payload: { type: 'nfs', server: '127.0.0.1', remotePath: '/srv/nfs/export1', mountpoint: `${mp}/`, persistent: false, mountNow: true } })
    await until(() => calls.some(c => c.command === MOUNT))
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [[`mount:${mp}`, 'exclusive']])
    release()
    assert.equal((await finished(id)).status, 'completed')
  })

  it('a disable accepted while an unmount of the same mount runs waits for its LOCK (no slot), then re-reads and runs', async () => {
    await serve()
    let releaseUmount!: () => void
    paused.set(UMOUNT, new Promise<void>((resolve) => {
      releaseUmount = resolve
    }))
    const unmountId = await accepted(state(NFS_MP, 'unmount'))
    await until(() => calls.some(c => c.command === UMOUNT))
    const disableId = await accepted(state(NFS_MP, 'disable'))
    assert.equal(queue().get(disableId)?.status, 'queued')
    assert.equal(queue().get(disableId)?.progress, `waiting for mount.unmount (job ${unmountId}) on the mount at ${NFS_MP}`)
    assert.equal(queue().list('running').length, 1, 'the waiting disable holds none of the free slots')
    paused.clear()
    releaseUmount()
    assert.equal((await finished(unmountId)).status, 'completed')
    const disabled = await finished(disableId)
    assert.equal(disabled.status, 'completed', JSON.stringify(disabled.error))
    assert.deepEqual(queue().heldLocks(), [])
  })
})
