import type { BackupTask, CloudSyncTask, ReplicationTask, SnapshotSchedule } from '@anas/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { renderServiceUnit as renderBackupService } from '../backup-units.js'
import { renderServiceUnit as renderCloudService } from '../cloud-units.js'
import {
  poolReferenceWarning,
  poolReferenceWarnings,
  readPoolReferences,
} from '../pool-references.js'
import { renderServiceUnit as renderReplicationService } from '../replication-units.js'
import { renderScrubServiceUnit } from '../scrub-schedule-units.js'
import { renderServiceUnit as renderSnapshotService } from '../snapshot-schedule-units.js'

/**
 * Story cr.24 — the ONE "what references this path" helper.
 *
 * The route tests prove the confirm-door wiring (warnings, generic-only,
 * unreadable disclosure, job-time re-read); this file proves the helper itself
 * against materialised config files — the SAME readers the daemon uses, so a
 * share is a real smb.conf line and a backup task is a real `anas-backup-*`
 * unit file, never a mock's guess (ruling (l)).
 */

const SMB_TEMPLATE = `
[global]
        workgroup = WORKGROUP

[media]
        path = /tank/media
        read only = no

[offpool]
        path = /elsewhere/media
        read only = no
`

const EXPORTS_TEMPLATE = `
/tank/nfs-media  192.168.1.0/24(rw,sync,no_subtree_check)
/elsewhere    *(ro,sync,no_subtree_check)
`

const FSTAB_TEMPLATE = `
PARTUUID=abcd / ext4 rw 0 1
//127.0.0.1/anastest  /tank/archive  cifs  credentials=/etc/anas/creds/x.cred,vers=3.1.1,uid=1002,nofail  0  0
`

/** A backup task whose source lives on the pool — a real unit body. */
const BACKUP_TASK: BackupTask = {
  name: 'media-backup',
  repository: 'pve:local',
  backupId: 'media-backup',
  archives: [{ name: 'media', path: '/tank/media', excludes: [] }],
  changeDetectionMode: 'default',
  notify: 'always',
  schedule: '*-*-* 02:00:00',
  enabled: true,
  limitNofile: 1024,
}

/** A cloud task whose source lives on the pool. */
const CLOUD_TASK: CloudSyncTask = {
  name: 'media-sync',
  source: '/tank/media',
  remote: 's3',
  path: '',
  mode: 'copy',
  excludes: [],
  notify: 'always',
  schedule: '*-*-* 03:00:00',
  enabled: true,
}

/** A replication task with its source on the pool and a LOCAL target off it. */
const REPLICATION_TASK: ReplicationTask = {
  name: 'media-repl',
  source: { pool: 'tank', dataset: 'media' },
  target: { pool: 'otherpool', dataset: 'media' },
  schedule: '*-*-* 04:00:00',
  snapshotFirst: true,
  enabled: true,
  notify: 'on-failure',
}

/** A replication task with a LOCAL target on the pool. */
const REPLICATION_TARGET_TASK: ReplicationTask = {
  name: 'into-tank',
  source: { pool: 'somewhere', dataset: 'media' },
  target: { pool: 'tank', dataset: 'media', location: { kind: 'local' } },
  schedule: '*-*-* 05:00:00',
  snapshotFirst: true,
  enabled: true,
  notify: 'on-failure',
}

/** A snapshot schedule targeting a dataset on the pool. */
const SNAPSHOT_SCHEDULE: SnapshotSchedule = {
  id: 'media-hourly',
  name: 'Media hourly',
  target: { kind: 'zfs', dataset: 'tank/media' },
  cadence: 'hourly',
  retention: { hourly: 24 },
  enabled: true,
  notify: 'on-failure',
}

const SCRUB_SCHEDULE = { kind: 'ahr-scrub' as const, cadence: 'monthly' as const, pools: ['tank'] }

interface Fixtures {
  dir: string
  smbConfPath: string
  exportsPath: string
  fstabPath: string
  systemdDir: string
}

async function makeFixtures(over: Partial<{ smb: string, exports: string, fstab: string }> = {}): Promise<Fixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-poolrefs-'))
  const smbConfPath = join(dir, 'smb.conf')
  const exportsPath = join(dir, 'exports')
  const fstabPath = join(dir, 'fstab')
  const systemdDir = join(dir, 'units')
  await mkdir(systemdDir)
  await writeFile(smbConfPath, over.smb ?? SMB_TEMPLATE, 'utf-8')
  await writeFile(exportsPath, over.exports ?? EXPORTS_TEMPLATE, 'utf-8')
  await writeFile(fstabPath, over.fstab ?? FSTAB_TEMPLATE, 'utf-8')
  return { dir, smbConfPath, exportsPath, fstabPath, systemdDir }
}

async function writeTaskUnits(f: Fixtures): Promise<void> {
  await writeFile(join(f.systemdDir, 'anas-backup-media-backup.service'), renderBackupService(BACKUP_TASK), 'utf-8')
  await writeFile(join(f.systemdDir, 'anas-cloud-media-sync.service'), renderCloudService(CLOUD_TASK), 'utf-8')
  await writeFile(join(f.systemdDir, 'anas-repl-media-repl.service'), renderReplicationService(REPLICATION_TASK), 'utf-8')
  await writeFile(join(f.systemdDir, 'anas-repl-into-tank.service'), renderReplicationService(REPLICATION_TARGET_TASK), 'utf-8')
  await writeFile(join(f.systemdDir, 'anas-snap-media-hourly.service'), renderSnapshotService(SNAPSHOT_SCHEDULE), 'utf-8')
  await writeFile(join(f.systemdDir, 'anas-scrub.service'), renderScrubServiceUnit(SCRUB_SCHEDULE), 'utf-8')
}

async function readFor(f: Fixtures, pool = 'tank', paths = ['/tank']): Promise<ReturnType<typeof readPoolReferences>> {
  return readPoolReferences({
    // The helper reads config files and the unit stores only; no executor call
    // exists today, but the context carries one so a zfs-read reference can be
    // added without changing every call site.
    executor: {} as never,
    pool,
    paths,
    smbConfPath: f.smbConfPath,
    exportsPath: f.exportsPath,
    systemdDir: f.systemdDir,
    fstabPath: f.fstabPath,
  })
}

let live: Fixtures[] = []
afterEach(async () => {
  for (const f of live)
    await rm(f.dir, { recursive: true, force: true })
  live = []
})
async function track(f: Fixtures): Promise<Fixtures> {
  live.push(f)
  return f
}

describe('pool-references — one helper answers "what references this path"', () => {
  it('lists every direction a reference can point at the pool, with kind and name', async () => {
    const f = await track(await makeFixtures())
    await writeTaskUnits(f)

    const { refs, unreadableSources } = await readFor(f)

    assert.deepEqual(unreadableSources, [], 'everything readable, nothing unreadable')
    const byKind = (kind: string) => refs.filter(r => r.kind === kind)
    assert.deepEqual(byKind('smb').map(r => [r.name, r.path]), [['media', '/tank/media']])
    assert.deepEqual(byKind('nfs').map(r => [r.name, r.path]), [['/tank/nfs-media', '/tank/nfs-media']])
    assert.deepEqual(byKind('backup').map(r => [r.name, r.path]), [['media-backup', '/tank/media']])
    assert.deepEqual(byKind('cloud').map(r => [r.name, r.path]), [['media-sync', '/tank/media']])
    // Source on the pool, and the LOCAL target onto this pool; the remote
    // target (otherpool) is NOT this pool's reference.
    assert.deepEqual(byKind('replication').sort(), [
      { kind: 'replication', name: 'into-tank', path: 'tank/media' },
      { kind: 'replication', name: 'media-repl', path: 'tank/media' },
    ])
    assert.deepEqual(byKind('snapshot-schedule').map(r => [r.name, r.path]), [['Media hourly', 'tank/media']])
    assert.deepEqual(byKind('scrub-schedule').map(r => [r.name, r.path]), [['ANAS scrub timer', 'tank']])
    assert.deepEqual(byKind('mount').map(r => [r.name, r.path]), [['/tank/archive', '/tank/archive']])
  })

  it('a backup ZVOL source (img) counts by its dataset name, not a mountpoint path', async () => {
    const f = await track(await makeFixtures())
    await writeFile(
      join(f.systemdDir, 'anas-backup-lun.service'),
      renderBackupService({
        ...BACKUP_TASK,
        name: 'lun-backup',
        backupId: 'lun-backup',
        archives: [{ name: 'lun', path: '/dev/zvol/tank/lun1', kind: 'img', excludes: [] }],
      }),
      'utf-8',
    )

    const { refs } = await readFor(f, 'tank', ['/tank/media'])
    assert.deepEqual(refs.filter(r => r.kind === 'backup').map(r => r.path), ['/dev/zvol/tank/lun1'])
  })

  it('a path on a different filesystem is not a reference (isPathWithin, never a prefix)', async () => {
    const f = await track(await makeFixtures())
    // The pool is `/tank/media`; a sibling `/tank.media` or a `/tank-other`
    // path must NOT match, and the export at `/elsewhere` must not either.
    const siblingSmb = `
[global]
        workgroup = W
[lookalike]
        path = /tank-media
        read only = no
[sibling]
        path = /tank.media/x
        read only = no
`
    // fstab / mounts are covered by the template; only the smb fixt is swapped.
    await rm(f.smbConfPath, { force: true })
    await writeFile(f.smbConfPath, siblingSmb, 'utf-8')

    await rm(f.exportsPath, { force: true })
    await writeFile(f.exportsPath, '/tank-media  *(ro)\n/tank/media        *(ro)\n', 'utf-8')

    const { refs } = await readFor(f, 'tank', ['/tank/media'])
    // Exports: `/tank/media` at the pool MOUNTPOINT — a share exactly at the
    // root mountpoint IS a reference (isPathWithin parent===child).
    assert.deepEqual(refs.filter(r => r.kind === 'smb'), [], 'sibling paths never match')
    assert.deepEqual(refs.filter(r => r.kind === 'nfs').map(r => r.path), ['/tank/media'])
  })

  it('an AHR pool matches by name (snapshot target + scrub + replication target)', async () => {
    const f = await track(await makeFixtures({ smb: '# empty', exports: '# empty', fstab: '# empty' }))
    await writeTaskUnits(f)
    // Treat 'tank' as the AHR pool: its "mountpoint" is the mounted @data path.
    const { refs } = await readFor(f, 'tank', ['/mnt/ahr/tank'])
    // The path-based refs (smb/nfs/backup/cloud/mount) point at /tank/media and
    // do not match /mnt/ahr/tank; the NAME-matched ones (snapshot target,
    // scrub pools list, replication source) still do.
    const snapshot = refs.filter(r => r.kind === 'snapshot-schedule').map(r => r.path)
    assert.deepEqual(snapshot, ['tank/media'], 'a ZFS snapshot target dataset on the pool counts by name')
    const scrub = refs.filter(r => r.kind === 'scrub-schedule').map(r => r.path)
    assert.deepEqual(scrub, ['tank'])
    const replication = refs.filter(r => r.kind === 'replication').map(r => r.path).sort()
    assert.deepEqual(replication, ['tank/media', 'tank/media'])
  })
})

describe('pool-references — unreadable sources are disclosed, never skipped', () => {
  it('an unreadable smb.conf is reported as unreadable:smb', async () => {
    const f = await track(await makeFixtures())
    // A DIRECTORY where the file should be: readConfig gets EISDIR, not ENOENT.
    await rm(f.smbConfPath, { force: true })
    await mkdir(f.smbConfPath)

    const { refs, unreadableSources } = await readFor(f)
    assert.deepEqual(refs.filter(r => r.kind === 'smb'), [], 'no smb refs from an unreadable file')
    assert.deepEqual(refs.map(r => r.kind).sort(), ['mount', 'nfs'], 'the readable sources still answer')
    assert.deepEqual(unreadableSources, [{ kind: 'smb', unreadable: true }])
  })

  it('an unreadable unit-store is reported per kind with its own sentence', async () => {
    const f = await track(await makeFixtures())
    // Nuke the unit dir so every store read fails open — and is disclosed.
    await rm(f.systemdDir, { recursive: true, force: true })
    await writeFile(f.systemdDir, 'not a directory', 'utf-8')

    const { refs, unreadableSources } = await readFor(f)
    assert.deepEqual(refs.map(r => r.kind).sort(), ['mount', 'nfs', 'smb'], 'only the fs-level sources answer')
    const kinds = unreadableSources.map(s => s.kind).sort()
    assert.deepEqual(kinds, ['backup', 'cloud', 'replication', 'scrub-schedule', 'snapshot-schedule'])
    for (const source of unreadableSources)
      assert.match(poolReferenceWarnings({ refs: [], unreadableSources: [source] }, 'tank')[0], /could not (read|check)/i)
  })

  it('an absent systemdDir means the unit-store kinds are not checked at all', async () => {
    const f = await track(await makeFixtures())
    const { refs, unreadableSources } = await readPoolReferences({
      executor: {} as never,
      pool: 'tank',
      paths: ['/tank'],
      smbConfPath: f.smbConfPath,
      exportsPath: f.exportsPath,
      // No systemdDir, no fstabPath: only smb + nfs are in scope.
    })
    assert.deepEqual(refs.map(r => r.kind), ['smb', 'nfs'])
    assert.deepEqual(unreadableSources, [])
  })
})

describe('pool-references — warning sentences', () => {
  it('name the kind and the name, and the unreadable sentences say what could not be read', async () => {
    const warnings = poolReferenceWarnings(
      {
        refs: [{ kind: 'smb', name: 'media', path: '/tank/media' }],
        unreadableSources: [{ kind: 'nfs', unreadable: true }],
      },
      'tank',
    )
    assert.deepEqual(warnings, [
      `SMB share 'media' serves '/tank/media', which is a path on this pool, and will stop working`,
      `ANAS could not read /etc/exports, so it could not check whether an NFS export references 'tank'. If this node exports NFS, verify the exports before confirming.`,
    ])
    // A smoke over every kind: the sentence always carries the kind word + name.
    const cases: { kind: 'smb' | 'nfs' | 'backup' | 'replication' | 'cloud' | 'snapshot-schedule' | 'scrub-schedule' | 'mount', word: string }[] = [
      { kind: 'smb', word: 'SMB share' },
      { kind: 'nfs', word: 'NFS export' },
      { kind: 'backup', word: 'Backup task' },
      { kind: 'replication', word: 'Replication task' },
      { kind: 'cloud', word: 'Cloud-sync task' },
      { kind: 'snapshot-schedule', word: 'Snapshot schedule' },
      { kind: 'scrub-schedule', word: 'Scrub schedule' },
      { kind: 'mount', word: 'Mount' },
    ]
    for (const c of cases) {
      const sentence = poolReferenceWarning({ kind: c.kind, name: 'media-backup', path: '/tank/media' })
      assert.match(sentence, new RegExp(c.word), `${c.kind} names its kind`)
      assert.match(sentence, /media-backup/, `${c.kind} names the reference`)
    }
  })
})
