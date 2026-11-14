import type { BackupRepo, BackupTask } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { backupTaskProblems, deriveArchiveName } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { buildCatalogShellArgs } from '../backup-catalog.js'
import { buildPruneArgs } from '../backup-prune.js'
import { buildSnapshotListArgs, parseGroupList, parseSnapshotList } from '../backup-reads.js'
import { pveSecretSet, readPveSecret, readRepoSecret, repoSecretPath, repoSecretSet } from '../backup-repos.js'
import { buildRestoreArgs } from '../backup-restore-files.js'
import { imageRestoreArgs } from '../backup-restore.js'
import { buildBackupEnv, buildRepoString, judgeTooSoon, newestBackupTime, pbcPositional, repoHostPart, runBackup } from '../backup-runner.js'
import { destroyTaskZfsTransients } from '../backup-snapshots.js'
import { BACKUP_UNIT_KIND, collectBackupWarnings, readAllTasksChecked } from '../backup-units.js'
import { pathSourceClaims } from '../source-claims.js'
import { guardSourcePath, readSourceGuardFacts } from '../source-guard.js'
import { removeTaskUnits, writeTaskUnitFiles } from '../task-units.js'

/**
 * cr3.backup — service-level pins of the 2026-11-14 review's backup findings.
 * Each `describe` names its finding id.
 */

const INJECTED = '--repository=u@pbs@evil.example:8007:x'

describe('BACKUP-H1: no pbc positional can be read as an option', () => {
  it('the guard refuses a dash-led, empty or control-character value and passes a PBS-shaped one', () => {
    for (const bad of [INJECTED, '-r', '', 'host/a\nb', 'host/a\u007F'])
      assert.throws(() => pbcPositional(bad, 'group'), /proxmox-backup-client/)
    assert.equal(pbcPositional('host/gtrestore', 'group'), 'host/gtrestore')
  })

  it('every pbc argv builder that takes a positional refuses an option-shaped one', () => {
    assert.throws(() => buildSnapshotListArgs(INJECTED))
    assert.throws(() => buildCatalogShellArgs(INJECTED, 'data.pxar'))
    assert.throws(() => buildCatalogShellArgs('host/x/2026-01-01T00:00:00Z', '--ns'))
    assert.throws(() => imageRestoreArgs(INJECTED, 'disk.img'))
    assert.throws(() => imageRestoreArgs('host/x/2026-01-01T00:00:00Z', '-x'))
    const spec = {
      snapshot: 'host/x/2026-01-01T00:00:00Z',
      archive: 'data.pxar',
      target: '/restore/here',
      patterns: [],
      merge: false,
      options: { ignoreOwnership: false, ignoreAcls: false, ignoreXattrs: false, ignorePermissions: false },
    }
    assert.deepEqual(buildRestoreArgs(spec).slice(0, 4), ['restore', spec.snapshot, spec.archive, spec.target])
    assert.throws(() => buildRestoreArgs({ ...spec, target: '--overwrite' }))
    assert.throws(() => buildRestoreArgs({ ...spec, snapshot: INJECTED }))
  })

  it('the prune group is `host/<id>`, so even a dash-led backup-id cannot lead the token', () => {
    // pruneGroup prefixes `host/`: the guard never fires on a stored id, and
    // the argv keeps today's shape.
    assert.deepEqual(buildPruneArgs({ backupId: 'nightly', retention: { keepLast: 2 } }).slice(0, 2), ['prune', 'host/nightly'])
  })
})

describe('backup-panel M5 at the daemon: server rows in PBS`s charset only', () => {
  it('a snapshot row with a markup id or type is dropped, a bad file name is dropped from its row, each said', () => {
    const refused: string[] = []
    const rows = parseSnapshotList(JSON.stringify([
      { 'backup-type': 'host', 'backup-id': 'ok', 'backup-time': 10, 'files': [
        { filename: 'data.pxar.didx', size: 1 },
        { filename: '"><svg onload=x>.img.fidx' },
        { 'filename': 'index.json.blob', 'crypt-mode': '<b>' },
      ] },
      { 'backup-type': 'host', 'backup-id': '-dash', 'backup-time': 9, 'files': [] },
      { 'backup-type': 'vm<b>', 'backup-id': '100', 'backup-time': 8, 'files': [] },
      { 'backup-type': 'ct', 'backup-id': '101', 'backup-time': 7, 'files': [] },
    ]), refused)
    assert.ok(rows)
    assert.deepEqual(rows.map(r => r.snapshot), ['host/ok/1970-01-01T00:00:10Z', 'ct/101/1970-01-01T00:00:07Z'])
    assert.deepEqual(rows[0]!.files.map(f => f.filename), ['data.pxar.didx', 'index.json.blob'])
    assert.equal(rows[0]!.files[1]!.cryptMode, undefined, 'an unknown crypt-mode is not carried')
    assert.equal(refused.length, 3)
    assert.ok(refused.every(r => !r.includes('<') && !r.includes('-dash')), 'the refused text is never echoed')
  })

  it('a group row outside the charset is dropped and said; good rows parse as before', () => {
    const refused: string[] = []
    const groups = parseGroupList(JSON.stringify([
      { 'backup-type': 'host', 'backup-id': 'a', 'files': ['root.pxar.didx', 'x y.pxar.didx'], 'owner': 'root@pam!t' },
      { 'backup-type': 'host', 'backup-id': 'a b', 'files': [] },
    ]), refused)
    assert.deepEqual(groups?.map(g => g.group), ['host/a'])
    assert.deepEqual(groups?.[0]?.files.map(f => f.filename), ['root.pxar.didx'])
    assert.equal(groups?.[0]?.owner, 'root@pam!t')
    assert.equal(refused.length, 2)
  })
})

describe('BACKUP-M6: an IPv6 host is bracketed in PBS_REPOSITORY', () => {
  const base: BackupRepo = { name: 'r', host: '::1', port: 8007, datastore: 'store', authType: 'password', username: 'u@pbs' }

  it('brackets a bare IPv6 literal (real pbc refuses the bare form, connects with brackets)', () => {
    assert.equal(buildRepoString(base), 'u@pbs@[::1]:8007:store')
    assert.equal(buildRepoString({ ...base, host: 'fd00::12' }), 'u@pbs@[fd00::12]:8007:store')
    assert.equal(buildBackupEnv(base, 's').PBS_REPOSITORY, 'u@pbs@[::1]:8007:store')
  })

  it('leaves IPv4, names and an already-bracketed host as they are', () => {
    assert.equal(repoHostPart('10.0.0.5'), '10.0.0.5')
    assert.equal(repoHostPart('pbs.example'), 'pbs.example')
    assert.equal(repoHostPart('[::1]'), '[::1]')
  })
})

describe('BACKUP-H2: "older than last backup" is a skip only when it is the same-second collision', () => {
  const FINDMNT = '/usr/bin/findmnt'
  const TIMEOUT = '/usr/bin/timeout'
  const PRLIMIT = '/usr/bin/prlimit'
  const ZFS = '/usr/sbin/zfs'
  const PBC = '/usr/bin/proxmox-backup-client'
  const CLOCK_MS = Date.parse('2026-01-03T10:00:00Z')
  const CLOCK_S = CLOCK_MS / 1000
  const TOO_SOON = 'Starting backup: host/pve1-docs/2026-01-03T10:00:00Z\nClient name: pve1\nError: backup timestamp is older than last backup.\n'
  const REPO: BackupRepo = { name: 'pbs1', host: '127.0.0.1', port: 8007, datastore: 'store', authType: 'token', tokenId: 'root@pam!t' }
  const TASK = {
    name: 'docs',
    repository: 'pbs1',
    backupId: 'pve1-docs',
    archives: [{ name: 'docs', path: '/srv/docs', excludes: [] }],
    changeDetectionMode: 'default',
    notify: 'always',
    schedule: 'daily',
    enabled: true,
    limitNofile: 1024,
  } as BackupTask
  let dir: string
  let fstabPath: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-h2-'))
    fstabPath = join(dir, 'fstab')
    await writeFile(fstabPath, 'UUID=x / ext4 defaults 0 1\n')
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function wire(list: { stdout: string, stderr: string, exitCode: number }): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }] }), stderr: '', exitCode: 0 } })
    mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: PRLIMIT, result: { stdout: '', stderr: TOO_SOON, exitCode: 255 } })
    mock.addFixture({ command: PBC, result: list })
    return mock
  }

  async function run(mock: MockExecutor) {
    return runBackup(mock, {
      task: TASK,
      repo: REPO,
      secret: 's3cret',
      fstabPath,
      clock: () => CLOCK_MS,
      consistencyOptions: { pveStorageCfg: '/nonexistent/anas-test/storage.cfg' },
    }, () => {})
  }

  it('a node clock an hour behind the newest snapshot FAILS the run and names the clock (was: skipped, exit 0, "success")', async () => {
    const mock = wire({ stdout: JSON.stringify([{ 'backup-type': 'host', 'backup-id': 'pve1-docs', 'backup-time': CLOCK_S + 3600 }]), stderr: '', exitCode: 0 })
    await assert.rejects(run(mock), /2026-01-03T11:00:00Z.*node clock is behind that snapshot/)
    const list = mock.calls.find(c => c.command === PBC)
    assert.deepEqual(list?.args, ['snapshot', 'list', 'host/pve1-docs', '--output-format', 'json'])
  })

  it('the newest snapshot in this run`s own second is the benign collision: skipped, as before', async () => {
    const mock = wire({ stdout: JSON.stringify([{ 'backup-time': CLOCK_S - 600 }, { 'backup-time': CLOCK_S }]), stderr: '', exitCode: 0 })
    const result = await run(mock)
    assert.equal(result.status, 'skipped')
  })

  it('a newest time ANAS cannot read fails closed (never a skip it could not prove)', async () => {
    await assert.rejects(run(wire({ stdout: '', stderr: 'Error: client error (Connect)', exitCode: 255 })), /could not read that snapshot's time.*client error/)
    await assert.rejects(run(wire({ stdout: '[]', stderr: '', exitCode: 0 })), /could not read that snapshot's time/)
  })

  it('cr3 review (5): a slow refusal does not widen the harmless window — a newest snapshot past the START second fails', () => {
    // The client took 20 s to be refused (a slow PBS): a clock 10 s behind used to read "skipped".
    const slow = { startMs: CLOCK_MS + 200, endMs: CLOCK_MS + 20_000 }
    assert.match(judgeTooSoon('host/x', CLOCK_S + 10, slow) ?? '', /node clock is behind/)
    assert.match(judgeTooSoon('host/x', CLOCK_S + 2, slow) ?? '', /node clock is behind/)
    assert.equal(judgeTooSoon('host/x', CLOCK_S + 1, slow), null)
    assert.equal(judgeTooSoon('host/x', CLOCK_S, slow), null)
  })

  it('judgeTooSoon: the window plus one second of slack either side', () => {
    const w = { startMs: CLOCK_MS + 200, endMs: CLOCK_MS + 900 }
    assert.equal(judgeTooSoon('host/x', CLOCK_S, w), null)
    assert.match(judgeTooSoon('host/x', CLOCK_S + 2, w) ?? '', /node clock is behind/)
    assert.equal(judgeTooSoon('host/x', CLOCK_S - 1, w), null)
    assert.match(judgeTooSoon('host/x', CLOCK_S + 3, w) ?? '', /node clock is behind/)
    assert.match(judgeTooSoon('host/x', CLOCK_S - 2, w) ?? '', /node clock is behind/)
    assert.equal(newestBackupTime('[{"backup-time":5},{"backup-time":9},{"backup-time":"x"}]'), 9)
    assert.equal(newestBackupTime('nope'), null)
  })
})

describe('BACKUP-M3: the run doors resolve a source path through the bounded resolver, never in-process', () => {
  const FINDMNT = '/usr/bin/findmnt'
  const TIMEOUT = '/usr/bin/timeout'
  const TABLE = JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw', children: [
    { target: '/mnt/dead-nfs', source: 'server:/export', fstype: 'nfs4', options: 'rw,hard' },
    { target: '/mnt/media', source: 'server:/media', fstype: 'nfs4', options: 'rw' },
  ] }] })
  const realpathCall = (c: { command: string, args: string[] }): boolean => c.command === TIMEOUT && c.args.includes('/usr/bin/realpath')

  it('resolves with `timeout -s KILL 5 realpath -m -- <path>` and follows the answer (a symlinked source locks its target)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', '/usr/bin/realpath', '-e', '--', '/srv/link/photos'], result: { stdout: '/mnt/media/photos\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', '/usr/bin/realpath', '-e', '--', '/srv/link/not-yet'], result: { stdout: '', stderr: 'realpath: /srv/link/not-yet: No such file or directory', exitCode: 1 } })
    mock.addFixture({ command: TIMEOUT, args: ['-s', 'KILL', '5', '/usr/bin/realpath', '-m', '--', '/srv/link/not-yet'], result: { stdout: '/mnt/media/not-yet\n', stderr: '', exitCode: 0 } })
    const { claims, resolved } = await pathSourceClaims(mock, ['/srv/link/photos', '/srv/link/not-yet'], async () => [])
    assert.equal(resolved.get('/srv/link/photos'), '/mnt/media/photos')
    assert.equal(resolved.get('/srv/link/not-yet'), '/mnt/media/not-yet', 'a missing tail resolves its existing ancestor (-m)')
    assert.deepEqual(claims.map(c => c.key), ['mount:/mnt/media', 'mount:/mnt/media'])
    assert.equal(mock.calls.filter(realpathCall).length, 3)
  })

  it('a resolver that does not answer (the dead hard mount: killed by timeout) keeps the path as written and the run door moves on', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: FINDMNT, args: ['--json'], result: { stdout: TABLE, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: TIMEOUT, result: { stdout: '', stderr: '', exitCode: 137 } })
    const { claims, resolved } = await pathSourceClaims(mock, ['/mnt/dead-nfs/docs'], async () => [])
    assert.equal(resolved.get('/mnt/dead-nfs/docs'), '/mnt/dead-nfs/docs')
    assert.deepEqual(claims.map(c => c.key), ['mount:/mnt/dead-nfs'])
    assert.equal(mock.calls.filter(realpathCall).length, 1, 'a path that hung is not asked again')
  })
})

describe('BACKUP-L11: a secret file that cannot be read is never "no secret stored"', () => {
  it('absent = null; present but unreadable throws a sentence; the set-flags say unknown (null)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-l11-'))
    try {
      assert.equal(await readRepoSecret(dir, 'none'), null)
      assert.equal(await repoSecretSet(dir, 'none'), false)
      // A directory where the file should be: EISDIR, an unreadable secret
      // whatever user runs the test (EACCES would not bind under root).
      await mkdir(repoSecretPath(dir, 'broken'), { recursive: true })
      await assert.rejects(readRepoSecret(dir, 'broken'), /could not read the stored secret .*EISDIR/)
      assert.equal(await repoSecretSet(dir, 'broken'), null)
      await mkdir(join(dir, 'pve.pw'), { recursive: true })
      await assert.rejects(readPveSecret(dir, 'pve'), /could not read the stored secret/)
      assert.equal(await pveSecretSet(dir, 'pve'), null)
      assert.equal(await pveSecretSet(dir, 'absent'), false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('BACKUP-L10: the unit store never keeps a write systemd refused, and never removes under an armed timer', () => {
  const SYSTEMCTL = '/usr/bin/systemctl'
  const KIND = BACKUP_UNIT_KIND

  it('a failed daemon-reload puts back the previous units (an edit) or removes the new ones (a create)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-l10-'))
    try {
      const service = join(dir, 'anas-backup-docs.service')
      const timer = join(dir, 'anas-backup-docs.timer')
      await writeFile(service, 'OLD SERVICE\n')
      await writeFile(timer, 'OLD TIMER\n')
      const failing = new MockExecutor()
      failing.addFixture({ command: SYSTEMCTL, results: [
        { stdout: '', stderr: 'Failed to reload daemon: Access denied', exitCode: 1 },
        { stdout: '', stderr: '', exitCode: 0 },
      ] })
      await assert.rejects(
        writeTaskUnitFiles(KIND, failing, dir, { name: 'docs', enabled: true }, { service: 'NEW SERVICE\n', timer: 'NEW TIMER\n' }),
        /Access denied - the task's previous units were put back, so nothing was changed/,
      )
      assert.equal(await readFile(service, 'utf-8'), 'OLD SERVICE\n')
      assert.equal(await readFile(timer, 'utf-8'), 'OLD TIMER\n')

      const createFails = new MockExecutor()
      createFails.addFixture({ command: SYSTEMCTL, results: [
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: '', stderr: 'Failed to enable unit', exitCode: 1 },
        { stdout: '', stderr: '', exitCode: 0 },
      ] })
      await assert.rejects(writeTaskUnitFiles(KIND, createFails, dir, { name: 'fresh', enabled: true }, { service: 'S\n', timer: 'T\n' }))
      assert.deepEqual((await readdir(dir)).filter(f => f.includes('fresh')), [], 'a failed create leaves no unit behind')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cr3 review (4): a timer write that fails puts the service back too (both writes are inside the rollback)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-l10w-'))
    try {
      const service = join(dir, 'anas-backup-docs.service')
      const timer = join(dir, 'anas-backup-docs.timer')
      await writeFile(service, 'OLD SERVICE\n')
      await writeFile(timer, 'OLD TIMER\n')
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      // The timer's write fails (a full disk, say); the put-back writes go through.
      let failed = false
      const write = async (path: string, data: string): Promise<void> => {
        if (path === timer && data === 'NEW TIMER\n') {
          failed = true
          throw new Error('ENOSPC: no space left on device')
        }
        await writeFile(path, data)
      }
      await assert.rejects(writeTaskUnitFiles(KIND, mock, dir, { name: 'docs', enabled: true }, { service: 'NEW SERVICE\n', timer: 'NEW TIMER\n' }, { write }), /ENOSPC/)
      assert.ok(failed)
      assert.equal(await readFile(service, 'utf-8'), 'OLD SERVICE\n', 'the new service is never left beside the old timer')
      assert.equal(await readFile(timer, 'utf-8'), 'OLD TIMER\n')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cr3 review (4): enable --now that enabled and then failed to start is undone to the PRIOR enablement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-l10e-'))
    try {
      // Before: the stored task was DISABLED (the unit's own marked JSON).
      await writeFile(join(dir, 'anas-backup-docs.service'), `# X-ANAS-Task=${JSON.stringify({ name: 'docs', enabled: false })}\nOLD SERVICE\n`)
      await writeFile(join(dir, 'anas-backup-docs.timer'), 'OLD TIMER\n')
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, args: ['enable', '--now', 'anas-backup-docs.timer'], result: { stdout: '', stderr: 'Created symlink ... Job for anas-backup-docs.timer failed.', exitCode: 1 } })
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      await assert.rejects(writeTaskUnitFiles(KIND, mock, dir, { name: 'docs', enabled: true }, { service: 'NEW SERVICE\n', timer: 'NEW TIMER\n' }))
      const after = mock.calls.map(c => c.args.join(' '))
      const enableAt = after.indexOf('enable --now anas-backup-docs.timer')
      assert.ok(after.slice(enableAt + 1).includes('disable --now anas-backup-docs.timer'), `the enablement is undone: ${JSON.stringify(after)}`)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cr3 review2 (8): an unparseable prior unit and a failed disable never claim "nothing was changed"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-l10p-'))
    try {
      await writeFile(join(dir, 'anas-backup-docs.service'), 'NOT A TASK UNIT\n')
      await writeFile(join(dir, 'anas-backup-docs.timer'), 'OLD TIMER\n')
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, args: ['disable', '--now', 'anas-backup-docs.timer'], result: { stdout: '', stderr: 'Failed to disable', exitCode: 1 } })
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      await assert.rejects(
        writeTaskUnitFiles(KIND, mock, dir, { name: 'docs', enabled: false }, { service: 'NEW SERVICE\n', timer: 'NEW TIMER\n' }),
        (err: Error) => {
          assert.ok(!/nothing was changed/.test(err.message), err.message)
          assert.match(err.message, /could not all be put back/)
          return true
        },
      )
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a failed disable with the timer still active removes nothing; with it inactive the removal goes on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-l10r-'))
    try {
      const service = join(dir, 'anas-backup-docs.service')
      await writeFile(service, 'S\n')
      const armed = new MockExecutor()
      armed.addFixture({ command: SYSTEMCTL, args: ['disable', '--now', 'anas-backup-docs.timer'], result: { stdout: '', stderr: 'Failed to disable', exitCode: 1 } })
      armed.addFixture({ command: SYSTEMCTL, args: ['show', '-p', 'ActiveState', '--value', 'anas-backup-docs.timer'], result: { stdout: 'active\n', stderr: '', exitCode: 0 } })
      await assert.rejects(removeTaskUnits(KIND, armed, dir, 'docs'), /could not stop anas-backup-docs\.timer .* still active - nothing was removed/)
      assert.equal(await readFile(service, 'utf-8'), 'S\n')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cr3.backup (handed by cloud): an fstab that cannot be read refuses, never reads as "nothing configured"', () => {
  it('a directory where /etc/fstab should be (EISDIR) is an unavailable fact, and every guard refuses with it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-fstab-'))
    try {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }] }), stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 1 } })
      const facts = await readSourceGuardFacts(mock, dir, ['/srv/docs'])
      assert.equal(facts.fstabUnavailable, 'EISDIR')
      assert.match(guardSourcePath('/srv/docs', facts) ?? '', /\/etc\/fstab could not be read \(EISDIR\).* - refusing/)
      // An ABSENT fstab still configures nothing: no refusal.
      const absent = await readSourceGuardFacts(mock, join(dir, 'no-such-fstab'), ['/srv/docs'])
      assert.equal(absent.fstabUnavailable, undefined)
      assert.equal(guardSourcePath('/srv/docs', absent), null)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cr3 review (2): an unreadable MOUNT TABLE refuses the backup run too (a missing fact only tightens)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: '', stderr: 'findmnt: cannot read /proc/self/mountinfo', exitCode: 1 } })
    mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 1 } })
    const task = { name: 'docs', repository: 'pbs1', backupId: 'docs', archives: [{ name: 'docs', path: '/srv/docs', excludes: [] }], changeDetectionMode: 'default', notify: 'always', schedule: 'daily', enabled: true, limitNofile: 1024 } as BackupTask
    const repo: BackupRepo = { name: 'pbs1', host: '127.0.0.1', port: 8007, datastore: 's', authType: 'token', tokenId: 'a@pam!t' }
    await assert.rejects(
      runBackup(mock, { task, repo, secret: 'x', fstabPath: '/nonexistent/anas-test/fstab', consistencyOptions: { pveStorageCfg: '/nonexistent/anas-test/storage.cfg' } }, () => {}),
      /archive 'docs': \/srv\/docs: the mount table could not be read/,
    )
    assert.equal(mock.calls.filter(c => c.command === '/usr/bin/prlimit').length, 0)
  })

  it('the backup run refuses before anything else runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-fstab-run-'))
    try {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }] }), stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 1 } })
      const task = { name: 'docs', repository: 'pbs1', backupId: 'docs', archives: [{ name: 'docs', path: '/srv/docs', excludes: [] }], changeDetectionMode: 'default', notify: 'always', schedule: 'daily', enabled: true, limitNofile: 1024 } as BackupTask
      const repo: BackupRepo = { name: 'pbs1', host: '127.0.0.1', port: 8007, datastore: 's', authType: 'token', tokenId: 'a@pam!t' }
      await assert.rejects(
        runBackup(mock, { task, repo, secret: 'x', fstabPath: dir, consistencyOptions: { pveStorageCfg: '/nonexistent/anas-test/storage.cfg' } }, () => {}),
        /archive 'docs': \/srv\/docs: \/etc\/fstab could not be read/,
      )
      assert.equal(mock.calls.filter(c => c.command === '/usr/bin/prlimit').length, 0)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cr3 review (3): a status or a unit that could not be read never makes the dashboard read all clear', () => {
  const SYSTEMCTL = '/usr/bin/systemctl'
  const JOURNALCTL = '/usr/bin/journalctl'

  async function store(names: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-inv-'))
    const writer = new MockExecutor()
    writer.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    for (const name of names)
      await writeTaskUnitFiles(BACKUP_UNIT_KIND, writer, dir, { name, enabled: true }, { service: `# X-ANAS-Task=${JSON.stringify({ name, repository: 'pbs1', backupId: name, archives: [{ name: 'a', path: '/a', excludes: [] }], schedule: 'daily', enabled: true })}\n[Service]\n`, timer: '[Timer]\n' })
    return dir
  }

  it('systemctl show and journalctl both failing: the section THROWS (was: [] — every row unknown, nothing warned)', async () => {
    const dir = await store(['docs'])
    try {
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: 'Failed to connect to bus: Connection refused', exitCode: 1 } })
      mock.addFixture({ command: JOURNALCTL, result: { stdout: '', stderr: 'Failed to get journal access', exitCode: 1 } })
      await assert.rejects(collectBackupWarnings(mock, dir), /systemd could not be asked about backup task 'docs'/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a partial failure: with the callback the readable rows still warn and the section says what it could not see', async () => {
    const dir = await store(['good', 'blind'])
    try {
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, args: ['show', 'anas-backup-blind.service', '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'], result: { stdout: '', stderr: 'Failed', exitCode: 1 } })
      mock.addFixture({ command: SYSTEMCTL, args: ['show', 'anas-backup-good.service', '-p', 'ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp'], result: { stdout: 'ActiveState=failed\nResult=exit-code\nExecMainStatus=1\nExecMainExitTimestamp=\nInactiveEnterTimestamp=\n', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: JOURNALCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      const said: string[] = []
      const warnings = await collectBackupWarnings(mock, dir, r => said.push(r))
      assert.deepEqual(warnings.map(w => w.ref), ['good'])
      assert.match(said.join(' '), /systemd could not be asked about backup task 'blind'/)
      // Without the callback the same answer is a failed section, never all clear.
      await assert.rejects(collectBackupWarnings(mock, dir), /'blind'/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable unit file is listed by name, and the section is not all clear', async () => {
    const dir = await store(['good'])
    try {
      await mkdir(join(dir, 'anas-backup-broken.service'))
      const checked = await readAllTasksChecked(dir)
      assert.deepEqual(checked.tasks.map(t => t.name), ['good'])
      assert.deepEqual(checked.unreadable.map(u => u.name), ['broken'])
      assert.match(checked.unreadable[0]!.reason, /could not be read \(EISDIR\)/)
      const mock = new MockExecutor()
      mock.addFixture({ command: SYSTEMCTL, result: { stdout: 'ActiveState=inactive\nResult=success\n', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: JOURNALCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
      await assert.rejects(collectBackupWarnings(mock, dir), /Backup task 'broken': its unit file anas-backup-broken\.service could not be read/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cr3 review (7): a leftover transient that will not go says what holds it', () => {
  const ZFS = '/usr/sbin/zfs'
  it('a hold and a clone are named, and "safe to destroy by hand" is said only when nothing holds it', async () => {
    const snap = 'tank/old@anas-backup-docs-1000000000'
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, args: ['destroy', '-r', '--', snap], result: { stdout: '', stderr: `cannot destroy snapshot ${snap}: dataset is busy`, exitCode: 1 } })
    mock.addFixture({ command: ZFS, args: ['holds', '-H', '-r', '--', snap], result: { stdout: `${snap}\tkeep-me\tThu Jan  1 00:00 2026\n`, stderr: '', exitCode: 0 } })
    mock.addFixture({ command: ZFS, args: ['get', '-H', '-o', 'value', 'clones', '--', snap], result: { stdout: 'tank/clone1\n', stderr: '', exitCode: 0 } })
    const [warning] = await destroyTaskZfsTransients(mock, [{ dataset: 'tank/old', label: 'anas-backup-docs-1000000000' }])
    assert.match(warning ?? '', /held by the hold tag 'keep-me'/)
    assert.match(warning ?? '', /the origin of clone tank\/clone1/)
    assert.ok(!/safe to destroy by hand/.test(warning ?? ''))

    const plain = new MockExecutor()
    plain.addFixture({ command: ZFS, args: ['destroy', '-r', '--', snap], result: { stdout: '', stderr: 'cannot destroy: I/O error', exitCode: 1 } })
    plain.addFixture({ command: ZFS, args: ['holds', '-H', '-r', '--', snap], result: { stdout: '', stderr: '', exitCode: 0 } })
    plain.addFixture({ command: ZFS, args: ['get', '-H', '-o', 'value', 'clones', '--', snap], result: { stdout: '\n', stderr: '', exitCode: 0 } })
    const [w2] = await destroyTaskZfsTransients(plain, [{ dataset: 'tank/old', label: 'anas-backup-docs-1000000000' }])
    assert.match(w2 ?? '', /nothing holds it .* safe to destroy by hand/)
  })
})

describe('cr3 review (8b): the derived archive name is one pbc takes', () => {
  it('a dot becomes _, a leading dash is prefixed, and the result has no problem', () => {
    assert.equal(deriveArchiveName('/srv/my.docs'), 'my_docs')
    assert.equal(deriveArchiveName('/srv/-odd'), '_-odd')
    for (const path of ['/srv/my.docs', '/srv/-odd', '/', '/mnt/pictures/raw'])
      assert.deepEqual(backupTaskProblems({ backupId: 'ok', archives: [{ name: deriveArchiveName(path), path, excludes: [] }] }), [])
  })
})
