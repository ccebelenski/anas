import type { BackupRepo, BackupSnapshot, IscsiLun, IscsiTargetDetail } from '@anas/shared'
import assert from 'node:assert/strict'
import { constants, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { composeSnapshotId } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { parseSnapshotList } from '../backup-reads.js'
import {
  assertSizeMatch,
  explainRestoreFailure,
  imageArchiveSize,
  imageRestoreArgs,
  parseRestoreProgress,
  readBackWarnings,
  readTargetSize,
  restoreTargetFlags,
  runImageRestore,
  snapshotGroup,
  volsizeArgs,
} from '../backup-restore.js'
import { buildBackupEnv, PBC } from '../backup-runner.js'

/**
 * backup2.7 — the whole-image LUN restore, at the service level.
 *
 * The ROUTE tests own the pre-flight gates (`routes/__tests__/backup-restore
 * .test.ts`); what is proven HERE is the sequence itself, as an exact call log,
 * plus every parser built on the story's real captures.
 *
 * Every fixture referenced below is a REAL CAPTURE from story backup2.1 against
 * the disposable stunt PBS (client/server 4.2.5), not a synthetic transcript.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/backup')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/**
 * The exact bytes pbc wrote to STDERR during the real rate-limited restore.
 *
 * `restore-progress.txt` is an ANNOTATED transcript: the capture harness
 * prefixed each line with `[+ NNNN ms] ` (which is how the doubling interval
 * was measured at all) and joined them with newlines. The real stream is those
 * same lines CR-terminated, so both the prefix and the newline joining are
 * undone here — anything less would be testing the harness, not the client.
 */
function realProgressStderr(): string {
  const lines = fixture('restore-progress.txt')
    .split('\n')
    .filter(l => /^\[\+\s*\d+ ms\] /.test(l))
    .map(l => l.replace(/^\[\+\s*\d+ ms\] /, ''))
  assert.equal(lines.length, 5, 'the capture should hold 4 progress lines + the completion line')
  return `${lines.join('\r')}\r`
}

const TARGETCLI = '/usr/bin/targetcli'
const ZFS = '/usr/sbin/zfs'

const IQN = 'iqn.2026-08.nas.anas:vmstore'
const SNAP = 'host/gtimgboth/2026-08-25T19:28:38Z'
/** The real capture's zvol image, byte-for-byte: 512 MiB. */
const IMAGE_SIZE = 536870912

const REPO: BackupRepo = {
  name: 'pbs-main',
  host: 'pbs.example',
  port: 8007,
  datastore: 'store',
  authType: 'token',
  tokenId: 'root@pam!anas',
}

function zvolLun(over: Partial<IscsiLun> = {}): IscsiLun {
  return {
    index: 0,
    name: 'vmdisk1',
    kind: 'zvol',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/vol1',
    size: IMAGE_SIZE,
    serial: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
    attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 524288 },
    connectedInitiators: [],
    present: true,
    backingExists: true,
    pool: 'tank',
    dataset: 'tank/vol1',
    ...over,
  }
}

function fileLun(path: string): IscsiLun {
  return zvolLun({
    index: 1,
    name: 'vmdisk2',
    kind: 'file',
    plugin: 'fileio',
    backingPath: path,
    dataset: 'tank/images',
  })
}

function target(luns: IscsiLun[], over: Partial<IscsiTargetDetail> = {}): IscsiTargetDetail {
  return {
    iqn: IQN,
    name: 'vmstore',
    ownership: 'anas',
    ownershipReason: 'anas-managed',
    ownershipDetail: 'IQN follows the ANAS naming convention',
    tpgTag: 1,
    enabled: true,
    portals: [],
    lunCount: luns.length,
    aclCount: 0,
    sessionCount: 0,
    security: { authentication: false, generateNodeAcls: false, demoModeDiscovery: false },
    present: true,
    persisted: true,
    missingLunCount: 0,
    portalsWithoutInterfaceCount: 0,
    luns,
    acls: [],
    sessions: [],
    ...over,
  }
}

/** A mock wired for a SUCCESSFUL restore: targetcli ok, the stream delivers all. */
function successMock(opts: { stderr?: string, bytesWritten?: number } = {}): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZFS, result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
  mock.addStreamFixture({
    command: PBC,
    result: {
      stderr: opts.stderr ?? 'restore complete (512 MiB processed in 0.6s, average 802.99 MiB/s)    \n',
      exitCode: 0,
      bytesWritten: opts.bytesWritten ?? IMAGE_SIZE,
    },
  })
  return mock
}

function deps(mock: MockExecutor, lun: IscsiLun, tgt: IscsiTargetDetail, over: Record<string, unknown> = {}) {
  return {
    repo: REPO,
    secret: 'super-secret',
    namespace: 'gtrestore',
    snapshot: SNAP,
    archive: 'vol.img',
    imageSize: IMAGE_SIZE,
    target: tgt,
    lun,
    env: buildBackupEnv(REPO, 'super-secret'),
    readBack: async () => [tgt],
    mutate: { executor: mock },
    ...over,
  }
}

function noop(): void {}

// ============================================================================
//  Parsers, against the real captures
// ============================================================================

describe('reading the manifest — through backup2.5\'s parser, not a second one', () => {
  /** The real `gtimgboth` snapshot, parsed by the picker layer that owns it. */
  function gtimgboth(): BackupSnapshot {
    const parsed = parseSnapshotList(JSON.stringify([{
      'backup-id': 'gtimgboth',
      'backup-type': 'host',
      'backup-time': 1787686118,
      'files': JSON.parse(fixture('snapshot-files-img.json')),
      'owner': 'root@pam!anas-test',
      'protected': false,
      'size': 1073742192,
    }]))
    assert.ok(parsed && parsed.length === 1, 'backup2.5 should parse this real capture')
    return parsed[0]
  }

  it('the restore reads the SAME composed id the picker shows (GT-1/GT-57)', () => {
    const snap = gtimgboth()
    // A full three-segment id: a bare group SILENTLY restores the latest
    // snapshot, so ANAS must never be able to produce one by omission.
    assert.match(snap.snapshot, /^host\/gtimgboth\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    assert.equal(snap.snapshot, composeSnapshotId('host', 'gtimgboth', 1787686118))
  })

  it('snapshotGroup takes the group back out of a full id — the list argument', () => {
    assert.equal(snapshotGroup('host/gtimgboth/2026-08-25T19:28:38Z'), 'host/gtimgboth')
    assert.equal(snapshotGroup(gtimgboth().snapshot), 'host/gtimgboth')
    // Degenerate input keeps its shape rather than inventing a group.
    assert.equal(snapshotGroup('host'), 'host')
  })

  it('imageArchiveSize reads files[].size for an .img — the equality pre-check input', () => {
    const snap = gtimgboth()
    // The two real `.img` archives, keyed by the name pbc takes on the command
    // line (the stored `<name>.img.fidx` minus its index suffix).
    assert.equal(imageArchiveSize(snap, 'vol.img'), IMAGE_SIZE)
    assert.equal(imageArchiveSize(snap, 'lun.img'), IMAGE_SIZE)
    // Bookkeeping is never a restore source, and an unknown name is null.
    assert.equal(imageArchiveSize(snap, 'index.json.blob'), null)
    assert.equal(imageArchiveSize(snap, 'nope.img'), null)
  })

  it('a PXAR archive can never be handed to a block restore, whatever it is called', () => {
    const parsed = parseSnapshotList(JSON.stringify([{
      'backup-id': 'trap',
      'backup-type': 'host',
      'backup-time': 1787686118,
      // A tree archive whose NAME ends in `.img` — the KIND, not the name, is
      // what decides, so this must not be offered as an image.
      'files': [{ 'crypt-mode': 'none', 'filename': 'weird.img.pxar.didx', 'size': 123 }],
    }]))
    assert.ok(parsed)
    assert.equal(parsed[0].files[0].kind, 'pxar')
    assert.equal(imageArchiveSize(parsed[0], 'weird.img.pxar'), null)
  })

  it('the real multi-snapshot namespace listing still yields usable image sizes', () => {
    const parsed = parseSnapshotList(fixture('snapshot-list-namespace.json'))
    assert.ok(parsed && parsed.length > 5, `only ${parsed?.length} entries parsed`)
    const withImages = parsed.filter(s => s.files.some(f => f.kind === 'img'))
    assert.ok(withImages.length > 0, 'the capture holds .img snapshots')
    for (const snap of withImages) {
      for (const f of snap.files.filter(x => x.kind === 'img')) {
        assert.ok(f.archive, 'an image file must carry the archive argument')
        assert.equal(imageArchiveSize(snap, f.archive as string), f.size ?? null)
        assert.equal(snapshotGroup(snap.snapshot), `${snap.backupType}/${snap.backupId}`)
      }
    }
  })
})

describe('parseRestoreProgress — STDERR, CR-terminated, doubling interval (GT-59)', () => {
  it('reads the real rate-limited capture, splitting on \\r as well as \\n', () => {
    const p = parseRestoreProgress(realProgressStderr())
    // The last `progress` line of the capture is 86%, and the completion line
    // follows it. The whole stream is ONE CR-joined blob, so a parser that
    // split on `\n` alone would see a single unparseable line.
    assert.equal(p.percent, 86)
    assert.match(p.lastLine ?? '', /^progress 86% \(216\.344 MiB of 250\.001 MiB/)
    assert.match(p.complete ?? '', /^restore complete \(250\.001 MiB processed in 1m 27\.5s/)
  })

  it('the interval really does DOUBLE — silence between lines is normal', () => {
    // 6 s, 16 s, 36 s, 79 s on an 87-second restore: four lines in total, which
    // is why the job must report "running" rather than reading silence as a
    // stall. This asserts the capture still says so.
    const stamps = fixture('restore-progress.txt')
      .split('\n')
      .filter(l => /^\[\+\s*\d+ ms\] progress /.test(l))
      .map(l => Number(/^\[\+\s*(\d+) ms\]/.exec(l)![1]))
    assert.deepEqual(stamps.length, 4)
    for (let i = 1; i < stamps.length; i++)
      assert.ok(stamps[i] > stamps[i - 1] * 1.8, `interval ${i} did not roughly double: ${stamps.join(', ')}`)
  })

  it('a CR-only stream (the pty shape) parses line by line', () => {
    const p = parseRestoreProgress(
      'progress 4% (12.409 MiB of 250.001 MiB in 5.9s, 2.088 MiB/s)    \r'
      + 'progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.096 MiB/s)    \r',
    )
    assert.equal(p.percent, 17)
    assert.equal(p.complete, null)
  })

  it('silence is not a stall — no progress line yields nulls, never a zero', () => {
    assert.deepEqual(parseRestoreProgress(''), { percent: null, lastLine: null, complete: null })
  })
})

describe('explainRestoreFailure — the real taxonomy (GT-56)', () => {
  const taxonomy = fixture('restore-failure-taxonomy.txt')

  it('says the three collapsed causes are collapsed, instead of faking precision', () => {
    const line = 'Error: snapshot host/gtrestore/2020-01-01T00:00:00Z does not exist.'
    assert.ok(taxonomy.includes(line))
    const said = explainRestoreFailure(line)
    assert.match(said, /does not exist/)
    assert.match(said, /missing NAMESPACE/)
  })

  it('names the archive-not-in-manifest case', () => {
    assert.ok(taxonomy.includes('Error: archive not found in manifest'))
    assert.match(explainRestoreFailure('Error: archive not found in manifest'), /holds no archive by that name/)
  })

  it('explains the unknown-suffix case in terms of the .img/.img.fidx trap', () => {
    assert.match(
      explainRestoreFailure('Error: failed to parse archive type for \'data.zzz\''),
      /not the stored '\.img\.fidx' file name/,
    )
  })

  it('discriminates PBS-down from a permission refusal', () => {
    const down = 'Error: client error (Connect)\n\nCaused by:\n    error connecting to https://localhost:8007/ - tcp connect error: Connection refused (os error 111)'
    assert.ok(taxonomy.includes('Connection refused (os error 111)'))
    assert.match(explainRestoreFailure(down), /could not be reached \(the connection was refused\)/)

    const perm = 'Error: no permissions on /datastore/anastest-store/gtrestore'
    assert.ok(taxonomy.includes(perm))
    assert.match(explainRestoreFailure(perm), /not allowed to read this datastore/)
  })

  it('names a dropped connection mid-image (GT-61)', () => {
    assert.match(
      explainRestoreFailure('Error: error extracting archive - failed to copy file contents: connection closed because of a broken pipe'),
      /dropped part-way through the image/,
    )
  })
})

// ============================================================================
//  The size pre-check — the guard nothing below ANAS provides (GT-42)
// ============================================================================

describe('assertSizeMatch — a mismatch is a refusal, with BOTH numbers', () => {
  const ctx = { archive: 'vol.img', targetPath: '/dev/zvol/tank/vol2' }

  it('equal sizes pass', () => {
    assert.equal(assertSizeMatch(IMAGE_SIZE, IMAGE_SIZE, ctx), null)
  })

  it('a LARGER image is refused, naming both sizes and the ENOSPC outcome', () => {
    // The exact real-capture pair: a 512 MiB image onto a 256 MiB zvol wrote
    // the first 256 MiB and then died on `No space left on device`.
    const msg = assertSizeMatch(IMAGE_SIZE, 268435456, ctx) ?? ''
    assert.match(msg, /536870912 bytes/)
    assert.match(msg, /268435456 bytes/)
    assert.match(msg, /LARGER/)
    assert.match(msg, /half-overwritten/)
  })

  it('a SMALLER image is refused too — it succeeds and leaves stale tail bytes', () => {
    const msg = assertSizeMatch(268435456, IMAGE_SIZE, ctx) ?? ''
    assert.match(msg, /SMALLER/)
    assert.match(msg, /stale bytes/)
    assert.match(msg, /536870912/)
    assert.match(msg, /268435456/)
  })

  it('an UNKNOWN image size is refused — no proof, no restore', () => {
    const msg = assertSizeMatch(null, IMAGE_SIZE, ctx) ?? ''
    assert.match(msg, /not in the snapshot manifest/)
    assert.match(msg, /Neither PBS nor LIO checks this/)
  })
})

describe('readTargetSize — volsize for a zvol, stat for an image file', () => {
  it('reads a zvol through `zfs get -Hp -o value volsize` (structured, one row)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
    const size = await readTargetSize(mock, { kind: 'zvol', backingPath: '/dev/zvol/tank/vol1', dataset: 'tank/vol1' })
    assert.deepEqual(size, { size: IMAGE_SIZE })
    assert.deepEqual(mock.calls[0], { command: ZFS, args: volsizeArgs('tank/vol1') })
  })

  it('derives the dataset from the device path when the LUN carries none', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '1024\n', stderr: '', exitCode: 0 } })
    await readTargetSize(mock, { kind: 'zvol', backingPath: '/dev/zvol/tank/vol9' })
    assert.deepEqual(mock.calls[0].args, volsizeArgs('tank/vol9'))
  })

  it('a zfs failure is an error, never a guessed size', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: ZFS, result: { stdout: '', stderr: 'cannot open', exitCode: 1 } })
    const size = await readTargetSize(mock, { kind: 'zvol', backingPath: '/dev/zvol/tank/vol1' })
    assert.ok('error' in size)
  })

  it('an image file is stat-ed, and a missing one is an error', async () => {
    const mock = new MockExecutor()
    const self = fileURLToPath(import.meta.url)
    const size = await readTargetSize(mock, { kind: 'file', backingPath: self })
    assert.ok('size' in size && size.size > 0)
    const gone = await readTargetSize(mock, { kind: 'file', backingPath: join(__dirname, 'no-such-image.raw') })
    assert.ok('error' in gone)
  })
})

// ============================================================================
//  argv + open flags
// ============================================================================

describe('imageRestoreArgs — the target is ALWAYS `-` (GT-39/GT-40)', () => {
  it('never puts the device on the command line', () => {
    const args = imageRestoreArgs(SNAP, 'vol.img', 'gtrestore')
    assert.deepEqual(args, ['restore', SNAP, 'vol.img', '-', '--ns', 'gtrestore'])
    assert.equal(args.includes('/dev/zvol/tank/vol1'), false)
    // `--overwrite` does not help and is never emitted.
    assert.equal(args.includes('--overwrite'), false)
  })

  it('omits --ns when there is none, and emits --rate only when asked', () => {
    assert.deepEqual(imageRestoreArgs(SNAP, 'vol.img'), ['restore', SNAP, 'vol.img', '-'])
    assert.deepEqual(
      imageRestoreArgs(SNAP, 'vol.img', 'gtrestore', '3MB'),
      ['restore', SNAP, 'vol.img', '-', '--ns', 'gtrestore', '--rate', '3MB'],
    )
  })
})

describe('restoreTargetFlags — O_WRONLY on a device, `w` on a file', () => {
  it('a zvol is opened WRITE-ONLY, with no O_CREAT and no O_TRUNC', () => {
    assert.equal(restoreTargetFlags('zvol'), constants.O_WRONLY)
    // Belt and braces: whatever the platform's numbers are, the flags must not
    // carry the create or truncate bits.
    assert.equal((restoreTargetFlags('zvol') as number) & constants.O_CREAT, 0)
    assert.equal((restoreTargetFlags('zvol') as number) & constants.O_TRUNC, 0)
  })

  it('an image file is opened `w` — rewritten in place, SAME inode', () => {
    assert.equal(restoreTargetFlags('file'), 'w')
  })
})

// ============================================================================
//  The sequence
// ============================================================================

describe('runImageRestore — the happy sequence, as an exact call log', () => {
  it('disables the TPG, streams into the device, then re-enables', async () => {
    const mock = successMock()
    const lun = zvolLun()
    const tgt = target([lun])
    const result = await runImageRestore(mock, deps(mock, lun, tgt), noop)

    // The whole sequence, in order, with nothing between the halves.
    assert.deepEqual(mock.calls.map(c => `${c.command} ${c.args.join(' ')}`), [
      `${TARGETCLI} /iscsi/${IQN}/tpg1 disable`,
      `${TARGETCLI} saveconfig`,
      `${PBC} restore ${SNAP} vol.img - --ns gtrestore`,
      `${TARGETCLI} /iscsi/${IQN}/tpg1 enable`,
      `${TARGETCLI} saveconfig`,
    ])

    // The stream went to the LUN's own backing path, write-only.
    assert.equal(mock.streamCalls.length, 1)
    assert.deepEqual(mock.streamCalls[0].target, {
      path: '/dev/zvol/tank/vol1',
      flags: constants.O_WRONLY,
    })

    assert.equal(result.complete, true)
    assert.equal(result.bytesWritten, IMAGE_SIZE)
    assert.equal(result.targetDisabled, true)
    assert.equal(result.targetReEnabled, true)
    assert.equal(result.targetPath, '/dev/zvol/tank/vol1')
    assert.match(result.duration ?? '', /^restore complete/)
    assert.equal(result.warnings, undefined)
  })

  it('the secret rides the ENVIRONMENT and never argv', async () => {
    const mock = successMock()
    const lun = zvolLun()
    const tgt = target([lun])
    await runImageRestore(mock, deps(mock, lun, tgt), noop)
    for (const call of mock.calls) {
      for (const arg of call.args)
        assert.equal(arg.includes('super-secret'), false, `secret on argv: ${arg}`)
    }
  })

  it('a FILE target is opened `w` on the SAME path — no recreate, no replay', async () => {
    // A real file so the post-write size read-back has something to stat.
    const self = fileURLToPath(import.meta.url)
    const size = readFileSync(self).length
    const mock = successMock({ bytesWritten: size })
    const lun = fileLun(self)
    const tgt = target([lun])
    const result = await runImageRestore(mock, deps(mock, lun, tgt, { imageSize: size }), noop)

    assert.deepEqual(mock.streamCalls[0].target, { path: self, flags: 'w' })
    // NOTHING recreated a backstore: no `/backstores/fileio delete`, no
    // `create name=…`, no `wwn=` replay — which is the whole reason the serial
    // and the attributes survive here where `resizeFileLun` has to replay them.
    const argv = mock.calls.map(c => c.args.join(' ')).join(' | ')
    assert.equal(/backstores\/fileio (?:delete|create)/.test(argv), false, argv)
    assert.equal(/wwn=/.test(argv), false, argv)
    assert.equal(result.complete, true)
    assert.equal(result.warnings, undefined)
  })

  it('forwards each new progress percentage from the real capture', async () => {
    const seen: string[] = []
    const mock = successMock({ stderr: realProgressStderr() })
    const lun = zvolLun()
    const tgt = target([lun])
    await runImageRestore(mock, deps(mock, lun, tgt), m => seen.push(m))
    // The last percentage the capture reports, and the completion line.
    assert.ok(seen.some(m => /progress 86%/.test(m)), seen.join('\n'))
  })

  it('leaves a target that was ALREADY disabled exactly as it found it', async () => {
    const mock = successMock()
    const lun = zvolLun()
    const tgt = target([lun], { enabled: false })
    const result = await runImageRestore(mock, deps(mock, lun, tgt), noop)
    assert.equal(mock.calls.some(c => c.args.includes('disable')), false)
    assert.equal(mock.calls.some(c => c.args.includes('enable')), false)
    assert.equal(result.targetDisabled, false)
    assert.equal(result.targetReEnabled, false)
  })
})

describe('runImageRestore — failures', () => {
  it('a MID-STREAM failure leaves the target DISABLED and says the LUN is partial', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addStreamFixture({
      command: PBC,
      result: {
        // The real ENOSPC transcript from the size-mismatch capture.
        stderr: 'Error: No space left on device (os error 28)\n',
        exitCode: 255,
        bytesWritten: 268435456,
      },
    })
    const lun = zvolLun()
    const tgt = target([lun])
    await assert.rejects(
      runImageRestore(mock, deps(mock, lun, tgt), noop),
      (err: Error) => {
        assert.match(err.message, /the image was partially written \(268435456 of 536870912 bytes reached/)
        assert.match(err.message, /disabled until you restore again or accept the state/)
        return true
      },
    )
    // The `finally` did NOT re-enable: a half-written LUN must not be served.
    assert.deepEqual(mock.calls.map(c => `${c.command} ${c.args.join(' ')}`), [
      `${TARGETCLI} /iscsi/${IQN}/tpg1 disable`,
      `${TARGETCLI} saveconfig`,
      `${PBC} restore ${SNAP} vol.img - --ns gtrestore`,
    ])
  })

  it('a failure BEFORE any byte lands re-enables the target in the finally', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addStreamFixture({
      command: PBC,
      result: {
        stderr: 'Error: snapshot host/gtrestore/2020-01-01T00:00:00Z does not exist.\n',
        exitCode: 255,
        bytesWritten: 0,
      },
    })
    const lun = zvolLun()
    const tgt = target([lun])
    await assert.rejects(
      runImageRestore(mock, deps(mock, lun, tgt), noop),
      (err: Error) => {
        assert.match(err.message, /does not exist/)
        assert.match(err.message, /Nothing was written to \/dev\/zvol\/tank\/vol1/)
        return true
      },
    )
    assert.deepEqual(mock.calls.map(c => c.args.join(' ')), [
      `/iscsi/${IQN}/tpg1 disable`,
      'saveconfig',
      `restore ${SNAP} vol.img - --ns gtrestore`,
      `/iscsi/${IQN}/tpg1 enable`,
      'saveconfig',
    ])
  })

  it('a re-enable that itself fails does not replace the restore error — it is said loudly', async () => {
    const mock = new MockExecutor()
    // disable + its saveconfig succeed; the enable fails.
    mock.addFixture({
      command: TARGETCLI,
      results: [
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: '', stderr: '', exitCode: 0 },
        { stdout: '', stderr: 'targetcli: enable failed', exitCode: 1 },
      ],
    })
    mock.addStreamFixture({
      command: PBC,
      result: { stderr: 'restore complete (512 MiB processed in 0.6s)    \n', exitCode: 0, bytesWritten: IMAGE_SIZE },
    })
    const lun = zvolLun()
    const tgt = target([lun])
    const result = await runImageRestore(mock, deps(mock, lun, tgt), noop)
    assert.equal(result.complete, true)
    assert.equal(result.targetReEnabled, false)
    assert.ok(result.warnings?.some(w => /THE TARGET IS STILL DISABLED/.test(w)), JSON.stringify(result.warnings))
  })

  it('a byte count that disagrees with the manifest is a warning, not a silent pass', async () => {
    const mock = successMock({ bytesWritten: IMAGE_SIZE - 4096 })
    const lun = zvolLun()
    const tgt = target([lun])
    const result = await runImageRestore(mock, deps(mock, lun, tgt), noop)
    assert.ok(
      result.warnings?.some(w => /reported a complete restore but 536866816 bytes reached/.test(w)),
      JSON.stringify(result.warnings),
    )
  })
})

describe('readBackWarnings — the serial and attributes must survive', () => {
  it('an unchanged LUN warns about nothing', () => {
    assert.deepEqual(readBackWarnings(zvolLun(), zvolLun()), [])
  })

  it('a changed SERIAL is named — initiators and PVE volids key on it', () => {
    const w = readBackWarnings(zvolLun(), zvolLun({ serial: 'different-uuid' }))
    assert.equal(w.length, 1)
    assert.match(w[0], /unit serial changed/)
    assert.match(w[0], /9bc6e907-6015-4267-be4f-5a0617cb3d71 -> different-uuid/)
  })

  it('a changed BACKING PATH is named', () => {
    const w = readBackWarnings(zvolLun(), zvolLun({ backingPath: '/dev/zvol/tank/other' }))
    assert.match(w[0], /now points at '\/dev\/zvol\/tank\/other'/)
  })

  it('changed ATTRIBUTES are named key by key', () => {
    const w = readBackWarnings(zvolLun(), zvolLun({
      attributes: { emulateTpu: false, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 524288 },
    }))
    assert.match(w[0], /attributes changed/)
    assert.match(w[0], /emulateTpu: true -> false/)
  })

  it('a LUN that could not be read back at all says so', () => {
    const w = readBackWarnings(zvolLun(), undefined)
    assert.match(w[0], /could not be read back after the restore/)
  })

  it('the read-back failure surfaces in the result rather than failing a good write', async () => {
    const mock = successMock()
    const lun = zvolLun()
    const tgt = target([lun])
    const result = await runImageRestore(
      mock,
      deps(mock, lun, tgt, { readBack: async () => { throw new Error('configfs gone') } }),
      noop,
    )
    assert.equal(result.complete, true)
    assert.ok(result.warnings?.some(w => /LIO read-back failed: configfs gone/.test(w)))
  })
})
