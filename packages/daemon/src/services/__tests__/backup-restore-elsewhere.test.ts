import type { BackupRepo, IscsiLun, IscsiTargetDetail } from '@anas/shared'
import type { CommandExecutor } from '../../executor/types.js'
import type { NewLunRestoreDeps } from '../backup-restore.js'
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { BackupRestoreRequest } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { newLunZvolCreateArgs, runNewLunImageRestore, volsizeArgs } from '../backup-restore.js'
import { buildBackupEnv, PBC } from '../backup-runner.js'
import { ISCSI_MAX_UNMAP_LBA_COUNT, TARGETCLI, withIscsiLock, ZFS } from '../iscsi-mutate.js'

/**
 * backup2.10 — "restore elsewhere": the request shape, at the boundary.
 *
 * Files have TWO destinations (ruling 2026-08-29 — the beside-the-original
 * mode is dropped): `inPlace` (the archive's live home; a merge) and
 * `newLocation`, where `target.path` IS the destination directory, not the
 * archive's live home — created if missing, or merged into, after the
 * daemon's confirm, if it exists. `target` is REQUIRED: there is no
 * destination the daemon may name on the operator's behalf. A whole-image
 * restore gains the `target` door: `mode: 'newLun'` restores
 * the image AS A NEW LUN (fresh backing at the manifest size, a fresh serial,
 * mapped on an existing ANAS-owned target) and makes the in-place `lun`
 * optional. The two image doors are mutually exclusive, and an in-place
 * restore still needs its LUN — the schema is where that is decided, so the
 * route never has to guess which door a body meant.
 *
 * The sequence itself (what runs, in what order, and what a failure undoes)
 * is proven below against a MockExecutor; the ROUTE's pre-flight gates are in
 * `routes/__tests__/backup-restore.test.ts`.
 */

const SNAP = 'host/gtimgboth/2026-08-25T19:28:38Z'
const IQN = 'iqn.2026-08.nas.anas:vmstore'

function imageBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'image',
    repo: 'pbs-main',
    ns: 'gtrestore',
    snapshot: SNAP,
    archive: 'vol.img',
    ...over,
  }
}

function filesBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'files',
    repo: 'pbs-main',
    snapshot: SNAP,
    archive: 'data.pxar',
    selections: ['/alpha.txt'],
    ...over,
  }
}

/** The first issue of a refused parse, with its field path — the test's evidence. */
function firstIssue(result: ReturnType<typeof BackupRestoreRequest.safeParse>): string {
  assert.equal(result.success, false, 'expected a schema refusal')
  return result.error.issues
    .map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .join(' | ')
}

describe('backup2.10 — the restore-elsewhere request shape', () => {
  describe('files — the newLocation mode', () => {
    it('parses, and path IS the directory the restore writes into', () => {
      const result = BackupRestoreRequest.safeParse(
        filesBase({ target: { mode: 'newLocation', path: '/restores/elsewhere' } }),
      )
      assert.ok(result.success, result.success ? '' : result.error.message)
      assert.equal(result.data.kind, 'files')
      const target = (result.data as { target: { mode: string, path?: string } }).target
      assert.equal(target.mode, 'newLocation')
      assert.equal(target.path, '/restores/elsewhere')
    })

    it('refuses a newLocation restore WITHOUT the path it writes into', () => {
      const msg = firstIssue(BackupRestoreRequest.safeParse(filesBase({ target: { mode: 'newLocation' } })))
      assert.match(msg, /target\.path/)
      assert.match(msg, /the directory it writes into/)
    })

    it('inPlace still parses without a path (the task supplies the home); the dropped mode and a missing target do not', () => {
      assert.ok(BackupRestoreRequest.safeParse(filesBase({ target: { mode: 'inPlace' } })).success)
      assert.ok(BackupRestoreRequest.safeParse(filesBase({ target: { mode: 'inPlace', path: '/gtbackup/data' } })).success)
      // Ruling 2026-08-29: the beside-the-original mode is gone from the enum.
      // The name is split so the repo-wide case-insensitive sweep for it stays
      // clean — this test's job is to resend the dropped name and watch it refuse.
      const gone = firstIssue(BackupRestoreRequest.safeParse(filesBase({ target: { mode: 'side' + 'BySide' } })))
      assert.match(gone, /target\.mode: Invalid option: expected one of "inPlace"\|"newLocation"/)
      // …and a body without a target is refused — no destination is guessed.
      const none = firstIssue(BackupRestoreRequest.safeParse(filesBase()))
      assert.match(none, /target/)
    })
  })

  describe('image — the newLun door', () => {
    it('an unparseable rate is refused at the boundary — the SAME schema as the files door (R4)', () => {
      // The image door's `rate` used to be `z.string().max(32)`: any text up to
      // 32 chars parsed, then rode onto pbc's `--rate` argv. It is the files
      // door's BackupRateLimit now, so garbage is a 400 at the boundary.
      const bad = firstIssue(BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'newvol', backing: { kind: 'zvol', pool: 'tank' } },
        rate: 'as fast as possible',
      })))
      assert.match(bad, /rate: /)
      assert.match(bad, /byte rate/)
      const good = BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'newvol', backing: { kind: 'zvol', pool: 'tank' } },
        rate: '50MiB',
      }))
      assert.ok(good.success, good.success ? '' : good.error.message)
    })

    it('parses with a zvol backing and no in-place LUN', () => {
      const result = BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'newvol', backing: { kind: 'zvol', pool: 'tank' } },
      }))
      assert.ok(result.success, result.success ? '' : result.error.message)
      assert.equal(result.data.kind, 'image')
      const req = result.data as { lun?: unknown, target: { mode: string, name: string, backing: unknown } }
      assert.equal(req.lun, undefined)
      assert.equal(req.target.mode, 'newLun')
    })

    it('parses with a file backing — a ZFS dataset OR an AHR pool', () => {
      const onDataset = BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'imgnew', backing: { kind: 'file', dataset: 'tank/images' } },
      }))
      assert.ok(onDataset.success, onDataset.success ? '' : onDataset.error.message)
      const onAhr = BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'imgnew', backing: { kind: 'file', ahrPool: 'ahr0' } },
      }))
      assert.ok(onAhr.success, onAhr.success ? '' : onAhr.error.message)
    })

    it('an in-place image restore still parses with lun and no target', () => {
      const result = BackupRestoreRequest.safeParse(imageBase({ lun: { targetIqn: IQN, index: 0 } }))
      assert.ok(result.success, result.success ? '' : result.error.message)
      assert.equal((result.data as { target?: unknown }).target, undefined)
    })

    it('refuses a newLun door missing its name', () => {
      const msg = firstIssue(BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, backing: { kind: 'zvol', pool: 'tank' } },
      })))
      assert.match(msg, /name/)
    })

    it('refuses a newLun door missing its backing', () => {
      const msg = firstIssue(BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'newvol' },
      })))
      assert.match(msg, /backing/)
    })

    it('refuses a backing kind that is not zvol or file, at the kind field', () => {
      const msg = firstIssue(BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'newvol', backing: { kind: 'lv', pool: 'tank' } },
      })))
      assert.match(msg, /target\.backing\.kind/)
    })

    it('a file backing names exactly ONE place — not both, not neither', () => {
      const both = firstIssue(BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'imgnew', backing: { kind: 'file', dataset: 'tank/images', ahrPool: 'ahr0' } },
      })))
      assert.match(both, /OR an AHR pool, not both/)

      const neither = firstIssue(BackupRestoreRequest.safeParse(imageBase({
        target: { mode: 'newLun', targetIqn: IQN, name: 'imgnew', backing: { kind: 'file' } },
      })))
      assert.match(neither, /a ZFS dataset or an AHR pool/)
    })

    it('an image restore names ONE destination — not both doors, not neither', () => {
      const both = firstIssue(BackupRestoreRequest.safeParse(imageBase({
        lun: { targetIqn: IQN, index: 0 },
        target: { mode: 'newLun', targetIqn: IQN, name: 'newvol', backing: { kind: 'zvol', pool: 'tank' } },
      })))
      assert.match(both, /ONE destination/)

      const neither = firstIssue(BackupRestoreRequest.safeParse(imageBase()))
      assert.match(neither, /target with mode=newLun/)
    })
  })
})

// ============================================================================
//  The newLun sequence — what runs, in what order, and what a failure undoes
// ============================================================================

const IMAGE_SIZE = 536870912
const SOURCE_SERIAL = '9bc6e907-6015-4267-be4f-5a0617cb3d71'
const INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
/** A fresh unit serial is a UUID — LIO's own convention, generated per LUN. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const REPO: BackupRepo = {
  name: 'pbs-main',
  host: 'pbs.example',
  port: 8007,
  datastore: 'store',
  authType: 'token',
  tokenId: 'root@pam!anas',
}

/** The source LUN this image was backed up from — the one that is never touched. */
function sourceLun(): IscsiLun {
  return {
    index: 0,
    name: 'vmdisk1',
    kind: 'zvol',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/vol1',
    size: IMAGE_SIZE,
    serial: SOURCE_SERIAL,
    attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 524288 },
    connectedInitiators: [],
    present: true,
    backingExists: true,
    pool: 'tank',
    dataset: 'tank/vol1',
  }
}

/** The destination: an ANAS-owned target, the source LUN at 0, one ACL mapping it. */
function targetDetail(): IscsiTargetDetail {
  return {
    iqn: IQN,
    name: 'vmstore',
    ownership: 'anas',
    ownershipReason: 'anas-managed',
    ownershipDetail: '',
    tpgTag: 1,
    enabled: true,
    portals: [],
    lunCount: 1,
    aclCount: 1,
    sessionCount: 0,
    security: { authentication: false, generateNodeAcls: false, demoModeDiscovery: false },
    present: true,
    persisted: true,
    missingLunCount: 0,
    portalsWithoutInterfaceCount: 0,
    luns: [sourceLun()],
    acls: [{
      initiatorIqn: INITIATOR,
      chapUserid: null,
      chapCredentialsSet: false,
      mutualUserid: null,
      mutualCredentialsSet: false,
      mappedLuns: [0],
    }],
    sessions: [],
  }
}

/** One newLun restore's deps — a zvol on `tank` named `newvol`, by default. */
function deps(mock: MockExecutor, configfsRoot: string, over: Partial<NewLunRestoreDeps> = {}): NewLunRestoreDeps {
  return {
    repo: REPO,
    secret: 'super-secret',
    namespace: 'gtrestore',
    snapshot: SNAP,
    archive: 'vol.img',
    imageSize: IMAGE_SIZE,
    target: targetDetail(),
    name: 'newvol',
    backing: { path: '/dev/zvol/tank/newvol', plugin: 'block', dataset: 'tank/newvol' },
    env: buildBackupEnv(REPO, 'super-secret'),
    mutate: { executor: mock, configfsRoot },
    ...over,
  }
}

/** A mock wired for a SUCCESSFUL newLun restore (optionally the new vol's read-back). */
function successMock(volsizeDataset?: string): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  if (volsizeDataset)
    mock.addFixture({ command: ZFS, args: volsizeArgs(volsizeDataset), result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
  mock.addStreamFixture({
    command: PBC,
    result: {
      stderr: 'restore complete (512 MiB processed in 0.6s, average 802.99 MiB/s)    \n',
      exitCode: 0,
      bytesWritten: IMAGE_SIZE,
    },
  })
  return mock
}

/** The serial this run generated, read back off the backstore's create. */
function wwnOf(mock: MockExecutor): string {
  const create = mock.calls.find(c => c.command === TARGETCLI && c.args.includes('create') && c.args.join(' ').includes('wwn='))
  assert.ok(create, 'a backstore create with wwn= was issued')
  return create.args.find(a => a.startsWith('wwn='))!.slice('wwn='.length)
}

/** The property the story is really about: the source LUN was never touched. */
function assertSourceUntouched(mock: MockExecutor): void {
  // No TPG disable/enable anywhere — nothing existing went offline — and
  // nothing was written to, or even named, the source LUN's backing.
  for (const c of mock.calls) {
    const argv = c.args.join(' ')
    assert.ok(!c.args.includes('disable') && !c.args.includes('enable'), `TPG state change: ${c.command} ${argv}`)
    assert.ok(!argv.includes('/dev/zvol/tank/vol1'), `touching the source LUN: ${c.command} ${argv}`)
  }
}

function noop(): void {}

/** The configfs root every newLun test runs in: the ACL's directory exists, maps nothing. */
async function withConfigfsRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'anas-newlun-configfs-'))
  try {
    await mkdir(join(root, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR), { recursive: true })
    await run(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('runNewLunImageRestore — the happy sequence, as an exact call log', () => {
  it('a ZVOL: create -s -V at the manifest size, a FRESH-serial backstore, map at the next free index, grant, stream, read-back, saveconfig LAST', async () => {
    await withConfigfsRoot(async (configfsRoot) => {
      const mock = successMock('tank/newvol')
      const result = await runNewLunImageRestore(mock, deps(mock, configfsRoot), noop)

      // The serial is FRESH — generated, never the source's (a copy is a new disk).
      const serial = result.newLun?.serial ?? ''
      assert.match(serial, UUID_RE)
      assert.notEqual(serial, SOURCE_SERIAL)
      assert.equal(wwnOf(mock), serial, 'the wwn= at create IS the reported serial')

      assert.deepEqual(mock.calls.map(c => `${c.command} ${c.args.join(' ')}`), [
        `${ZFS} create -s -V ${IMAGE_SIZE} tank/newvol`,
        `${TARGETCLI} /backstores/block create name=newvol dev=/dev/zvol/tank/newvol wwn=${serial}`,
        // Every attribute BEFORE the map — block_size would stop working after it.
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpu=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpws=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute max_unmap_lba_count=${ISCSI_MAX_UNMAP_LBA_COUNT.block}`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_write_cache=0`,
        // Only NOW is it mapped — at the next free index, after the source's 0 —
        // and granted to the ACL that maps the source.
        `${TARGETCLI} /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/newvol lun=1`,
        `${TARGETCLI} /iscsi/${IQN}/tpg1/acls/${INITIATOR} create 1 1`,
        `${PBC} restore ${SNAP} vol.img - --ns gtrestore`,
        // The read-back proves the new object holds exactly the image…
        `${ZFS} get -Hp -o value volsize tank/newvol`,
        // …and only NOW is the configuration persisted.
        `${TARGETCLI} saveconfig`,
      ])

      // The stream went to the NEW backing, write-only — pbc never saw a path.
      assert.equal(mock.streamCalls.length, 1)
      assert.deepEqual(mock.streamCalls[0].target, { path: '/dev/zvol/tank/newvol', flags: constants.O_WRONLY })
      assert.deepEqual(mock.streamCalls[0].args, ['restore', SNAP, 'vol.img', '-', '--ns', 'gtrestore'])

      assertSourceUntouched(mock)

      // The result names the new LUN, and nothing went offline.
      assert.equal(result.complete, true)
      assert.equal(result.targetDisabled, false)
      assert.equal(result.targetReEnabled, false)
      assert.equal(result.lunIndex, 1)
      assert.equal(result.targetPath, '/dev/zvol/tank/newvol')
      assert.equal(result.bytesWritten, IMAGE_SIZE)
      assert.deepEqual(result.newLun, { targetIqn: IQN, index: 1, name: 'newvol', serial, backingPath: '/dev/zvol/tank/newvol' })
      assert.equal(result.warnings, undefined)
    })
  })

  it('a FILE: a sparse image at the manifest size, a fileio backstore, map, grant, stream into the file, saveconfig LAST', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-newlun-image-'))
    try {
      const file = join(dir, 'newvol.raw')
      const mock = new MockExecutor()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addStreamFixture({
        command: PBC,
        result: { stderr: 'restore complete (512 MiB processed in 0.6s)    \n', exitCode: 0, bytesWritten: IMAGE_SIZE },
      })

      await withConfigfsRoot(async (configfsRoot) => {
        const result = await runNewLunImageRestore(
          mock,
          deps(mock, configfsRoot, { backing: { path: file, plugin: 'fileio', dataset: 'tank/images' } }),
          noop,
        )
        const serial = result.newLun?.serial ?? ''
        assert.match(serial, UUID_RE)
        assert.notEqual(serial, SOURCE_SERIAL)

        assert.deepEqual(mock.calls.map(c => `${c.command} ${c.args.join(' ')}`), [
          // No zfs at all — the file half creates the image itself (real file I/O).
          `${TARGETCLI} /backstores/fileio create name=newvol file_or_dev=${file} size=${IMAGE_SIZE} write_back=false wwn=${serial}`,
          `${TARGETCLI} /backstores/fileio/newvol set attribute emulate_tpu=1`,
          `${TARGETCLI} /backstores/fileio/newvol set attribute emulate_tpws=1`,
          `${TARGETCLI} /backstores/fileio/newvol set attribute max_unmap_lba_count=${ISCSI_MAX_UNMAP_LBA_COUNT.fileio}`,
          `${TARGETCLI} /backstores/fileio/newvol set attribute emulate_write_cache=0`,
          `${TARGETCLI} /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/fileio/newvol lun=1`,
          `${TARGETCLI} /iscsi/${IQN}/tpg1/acls/${INITIATOR} create 1 1`,
          `${PBC} restore ${SNAP} vol.img - --ns gtrestore`,
          `${TARGETCLI} saveconfig`,
        ])
        assert.equal(mock.calls.some(c => c.command === ZFS), false)

        // The sparse image was created at EXACTLY the manifest's size…
        assert.equal((await stat(file)).size, IMAGE_SIZE)
        // …and the stream opened it `w` — the same inode, rewritten in place.
        assert.deepEqual(mock.streamCalls[0].target, { path: file, flags: 'w' })

        assertSourceUntouched(mock)
        assert.equal(result.complete, true)
        assert.equal(result.targetDisabled, false)
        assert.equal(result.targetReEnabled, false)
        assert.equal(result.warnings, undefined)
        assert.equal(result.newLun?.backingPath, file)
      })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runNewLunImageRestore — a failure undoes what it made, and never saves', () => {
  it('a mid-stream ENOSPC: unmap, delete the backstore, destroy the zvol — NO saveconfig', async () => {
    await withConfigfsRoot(async (configfsRoot) => {
      const mock = new MockExecutor()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addStreamFixture({
        command: PBC,
        // The real ENOSPC transcript from the size-mismatch capture.
        result: { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 },
      })

      await assert.rejects(
        runNewLunImageRestore(mock, deps(mock, configfsRoot), noop),
        (err: Error) => {
          assert.match(err.message, /the image was partially written \(268435456 of 536870912 bytes reached the new backing \/dev\/zvol\/tank\/newvol\)/)
          assert.match(err.message, /ANAS has removed LUN 1, backstore 'newvol', volume tank\/newvol/)
          assert.match(err.message, /nothing of the failed restore remains/)
          return true
        },
      )

      const serial = wwnOf(mock)
      assert.deepEqual(mock.calls.map(c => `${c.command} ${c.args.join(' ')}`), [
        `${ZFS} create -s -V ${IMAGE_SIZE} tank/newvol`,
        `${TARGETCLI} /backstores/block create name=newvol dev=/dev/zvol/tank/newvol wwn=${serial}`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpu=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpws=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute max_unmap_lba_count=${ISCSI_MAX_UNMAP_LBA_COUNT.block}`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_write_cache=0`,
        `${TARGETCLI} /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/newvol lun=1`,
        `${TARGETCLI} /iscsi/${IQN}/tpg1/acls/${INITIATOR} create 1 1`,
        `${PBC} restore ${SNAP} vol.img - --ns gtrestore`,
        // The undo, in the REVERSE of the order the objects were made:
        `${TARGETCLI} /iscsi/${IQN}/tpg1/luns delete lun1`,
        `${TARGETCLI} /backstores/block/newvol delete`,
        `${ZFS} destroy tank/newvol`,
      ])

      // The point of the undo: a half-created LUN is never persisted, and
      // nothing existing was taken offline along the way.
      assert.ok(!mock.calls.some(c => c.args.includes('saveconfig')), 'a failed restore must not save the LIO configuration')
      assertSourceUntouched(mock)
    })
  })

  it('a FILE backing is UNLINKED on failure — the image this run made, and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-newlun-image-'))
    try {
      const file = join(dir, 'newvol.raw')
      const mock = new MockExecutor()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addStreamFixture({
        command: PBC,
        result: { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 },
      })

      await withConfigfsRoot(async (configfsRoot) => {
        await assert.rejects(
          runNewLunImageRestore(
            mock,
            deps(mock, configfsRoot, { backing: { path: file, plugin: 'fileio', dataset: 'tank/images' } }),
            noop,
          ),
          (err: Error) => {
            assert.match(err.message, new RegExp(`ANAS has removed LUN 1, backstore 'newvol', image ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
            assert.match(err.message, /nothing of the failed restore remains/)
            return true
          },
        )

        // The sparse image is gone — this run made it seconds earlier.
        await assert.rejects(stat(file), (err: NodeJS.ErrnoException) => {
          assert.equal(err.code, 'ENOENT')
          return true
        })
        assert.equal(mock.calls.some(c => c.command === ZFS), false)
        assert.ok(!mock.calls.some(c => c.args.includes('saveconfig')))
        assertSourceUntouched(mock)
      })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a failure before any byte lands still undoes everything it created', async () => {
    await withConfigfsRoot(async (configfsRoot) => {
      const mock = new MockExecutor()
      mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
      mock.addStreamFixture({
        command: PBC,
        result: { stderr: 'Error: snapshot host/gtimgboth/2026-08-25T19:28:38Z does not exist.\n', exitCode: 255, bytesWritten: 0 },
      })

      await assert.rejects(
        runNewLunImageRestore(mock, deps(mock, configfsRoot), noop),
        (err: Error) => {
          assert.match(err.message, /Nothing was written to the new backing \/dev\/zvol\/tank\/newvol/)
          assert.match(err.message, /ANAS has removed LUN 1, backstore 'newvol', volume tank\/newvol/)
          return true
        },
      )
      assert.ok(!mock.calls.some(c => c.args.includes('saveconfig')))
      assertSourceUntouched(mock)
    })
  })
})

describe('runNewLunImageRestore — where the iSCSI lock is held, and where it is not (the #52 shape for the new-LUN door)', () => {
  /** Resolves 'waited' if `p` has not settled within a few event-loop turns. */
  async function raceAgainstTime(p: Promise<unknown>, ms = 50): Promise<string> {
    let timer: NodeJS.Timeout | undefined
    const verdict = await Promise.race([
      p.then(() => 'ran'),
      new Promise<string>((r) => {
        timer = setTimeout(r, ms, 'waited')
      }),
    ])
    if (timer)
      clearTimeout(timer)
    return verdict
  }

  /**
   * Wrap a base executor, PAUSING the first call whose (command, args) satisfy
   * `match` until `held` resolves; `entered` fires the instant that call begins.
   * Everything else passes straight through to the base mock's fixtures.
   */
  function gatedOn(
    base: MockExecutor,
    which: 'exec' | 'stream',
    match: (command: string, args: string[]) => boolean,
    entered: () => void,
    held: Promise<void>,
  ): CommandExecutor {
    let gated = false
    const gate = async (kind: 'exec' | 'stream', command: string, args: string[]): Promise<void> => {
      if (!gated && kind === which && match(command, args)) {
        gated = true
        entered()
        await held
      }
    }
    return {
      exec: async (c, a, o) => {
        await gate('exec', c, a)
        return base.exec(c, a, o)
      },
      pipeline: (c1, a1, c2, a2) => base.pipeline(c1, a1, c2, a2),
      execToStream: async (c, a, t, o) => {
        await gate('stream', c, a)
        return base.execToStream(c, a, t, o)
      },
    }
  }

  const isBackstoreCreate = (c: string, a: string[]): boolean =>
    c === TARGETCLI && a.includes('create') && a.join(' ').includes('wwn=')
  const isSaveconfig = (c: string, a: string[]): boolean =>
    c === TARGETCLI && a.includes('saveconfig')

  it('the backstore CREATE + MAP runs UNDER the lock — a concurrent mutation waits (FAILS on the whole-job-wrap code)', async () => {
    await withConfigfsRoot(async (configfsRoot) => {
      const base = successMock('tank/newvol')
      let entered!: () => void
      const inCreate = new Promise<void>((r) => {
        entered = r
      })
      let release!: () => void
      const held = new Promise<void>((r) => {
        release = r
      })
      const gated = gatedOn(base, 'exec', isBackstoreCreate, () => entered(), held)

      const run = runNewLunImageRestore(gated, deps(base, configfsRoot, { mutate: { executor: gated, configfsRoot } }), noop)
      // If the create step never runs, fail here instead of hanging the suite.
      assert.equal(await raceAgainstTime(inCreate, 200), 'ran', 'the run must reach the backstore create')

      // The service now sits INSIDE `withIscsiLock(createAndMapLun)`. Any other
      // iSCSI mutation queued now MUST wait — on the old shape the service held
      // no lock of its own and this ran immediately.
      let ran = false
      const other = withIscsiLock(async () => {
        ran = true
      })
      assert.equal(await raceAgainstTime(other), 'waited')
      assert.equal(ran, false)

      release()
      await run
      await other
      assert.equal(ran, true)
    })
  })

  it('the SAVECONFIG step runs UNDER the lock too — a concurrent mutation waits', async () => {
    await withConfigfsRoot(async (configfsRoot) => {
      const base = successMock('tank/newvol')
      let entered!: () => void
      const inSave = new Promise<void>((r) => {
        entered = r
      })
      let release!: () => void
      const held = new Promise<void>((r) => {
        release = r
      })
      const gated = gatedOn(base, 'exec', isSaveconfig, () => entered(), held)

      const run = runNewLunImageRestore(gated, deps(base, configfsRoot, { mutate: { executor: gated, configfsRoot } }), noop)
      assert.equal(await raceAgainstTime(inSave, 200), 'ran', 'the run must reach saveconfig')

      let ran = false
      const other = withIscsiLock(async () => {
        ran = true
      })
      assert.equal(await raceAgainstTime(other), 'waited')
      assert.equal(ran, false)

      release()
      await run
      await other
      assert.equal(ran, true)
    })
  })

  it('the image STREAM does NOT hold the lock — an hours-long restore blocks no mutation', async () => {
    await withConfigfsRoot(async (configfsRoot) => {
      const base = successMock('tank/newvol')
      let streaming!: () => void
      const hasStarted = new Promise<void>((r) => {
        streaming = r
      })
      let release!: () => void
      const finish = new Promise<void>((r) => {
        release = r
      })
      // Park the run mid-image, exactly where a real one spends its hours.
      const gated = gatedOn(base, 'stream', () => true, () => streaming(), finish)

      const run = runNewLunImageRestore(gated, deps(base, configfsRoot, { mutate: { executor: gated, configfsRoot } }), noop)
      await hasStarted

      // The create+map lock section is already done and released: the backstore
      // was created and mapped before the stream began, and the lock is free.
      assert.ok(base.calls.some(c => c.args.includes('create') && c.args.join(' ').includes('wwn=')), 'the backstore was created before the stream')
      const other = withIscsiLock(async () => 'mutated')
      assert.equal(await raceAgainstTime(other), 'ran')

      release()
      await run
      // saveconfig still ran, after the stream, under the lock again.
      assert.ok(base.calls.some(c => c.args.includes('saveconfig')))
    })
  })
})

describe('newLunZvolCreateArgs — the dataset door\'s volume-create argv, not a second copy', () => {
  it('a sparse volume of exactly the image\'s size', () => {
    assert.deepEqual(newLunZvolCreateArgs('tank/newvol', 536870912), ['create', '-s', '-V', '536870912', 'tank/newvol'])
  })
})
