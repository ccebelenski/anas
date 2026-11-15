/**
 * cr3.lunrestore.filemark — the restore mark on an image FILE: the reader and
 * the writer against the calls CAPTURED on the stunt nodes
 * (`fixtures/restore-mark/`, README there names node, filesystem and command):
 * ZFS 2.4.2 on anas-zfs, ext4 and btrfs on anas-pve, and vfat for a
 * filesystem that refuses extended attributes. No typed stderr line: every
 * answer below is one a node printed.
 */
import type { CommandExecutor } from '../../executor/types.js'
import type { CapturedCase } from './file-mark-fixtures.js'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { ProdExecutor } from '../../executor/prod.js'
import {
  ATTR_NOT_INSTALLED,
  clearMarkCommand,
  clearRestoreMark,
  encodeRestoreMark,
  FILE_RESTORE_MARK_ATTR,
  fileMarkGetArgs,
  fileMarkRemoveArgs,
  fileMarkSetArgs,
  GETFATTR,
  isFileMark,
  markName,
  markOn,
  parseFileMarkHex,
  putBackRestoreMark,
  readFileMark,
  readRestoreMark,
  readRestoreMarksBatch,
  RestoreMarkUnsupportedError,
  SETFATTR,
  setRestoreMark,
} from '../restore-mark.js'
import { answerAs, capturedCase, capturedCases, capturedHex, enoent, hexOf, withFileMarks } from './file-mark-fixtures.js'

/** The mark the capture script wrote (`fixtures/restore-mark/file-mark-capture.sh`), as the daemon's schema encodes it. */
const CAPTURED_WRITING = { v: 1 as const, repo: 'pbs-main', snapshot: 'vm/101/2026-11-14T10:00:00Z', archive: 'drive-scsi0.img', started: '2026-11-14T10:00:00.000Z', state: 'writing' as const }

/** A mock that answers exactly the captured call with the captured result. */
function replaying(c: CapturedCase): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: c.command, args: c.args, result: { stdout: c.stdout, stderr: c.stderr, exitCode: c.exitCode } })
  return mock
}

/** The three filesystems an image file lives on, as captured. */
const ORDINARY = [['anas-zfs', 'zfs-2.4.2'], ['anas-pve', 'ext4'], ['anas-pve', 'btrfs']] as const

describe('cr3.lunrestore.filemark — the argv the daemon issues is the argv run on the nodes', () => {
  for (const [node, fs] of ORDINARY) {
    it(`${fs}: read, set (the schema's own encoding), remove and put-back are byte-identical to the capture`, () => {
      const read = capturedCase(node, fs, 'read-absent')
      assert.equal(read.command, GETFATTR)
      assert.deepEqual(fileMarkGetArgs(read.path), read.args)
      const set = capturedCase(node, fs, 'set-writing')
      assert.equal(set.command, SETFATTR)
      assert.deepEqual(fileMarkSetArgs(set.path, hexOf(encodeRestoreMark(CAPTURED_WRITING))), set.args)
      const remove = capturedCase(node, fs, 'remove')
      assert.deepEqual(fileMarkRemoveArgs(remove.path), remove.args)
      const odd = capturedCase(node, fs, 'set-odd')
      assert.deepEqual(fileMarkSetArgs(odd.path, 'fffe0a7b'), odd.args)
    })
  }

  it('every captured getfattr is the reader\'s argv for its path; every setfattr -x the remover\'s', () => {
    const gets = capturedCases().filter(c => c.command === GETFATTR)
    const removes = capturedCases().filter(c => c.command === SETFATTR && c.args[0] === '-x')
    assert.ok(gets.length >= 20 && removes.length >= 10)
    for (const c of gets)
      assert.deepEqual(fileMarkGetArgs(c.path), c.args, `${c.node} ${c.fs} ${c.name}`)
    for (const c of removes)
      assert.deepEqual(fileMarkRemoveArgs(c.path), c.args, `${c.node} ${c.fs} ${c.name}`)
  })
})

describe('cr3.lunrestore.filemark — the reader, captured line by captured line (zfs, ext4, btrfs)', () => {
  for (const [node, fs] of ORDINARY) {
    const read = async (name: string) => {
      const c = capturedCase(node, fs, name)
      return { c, r: await readFileMark(replaying(c), c.path) }
    }
    it(`${fs}: the attribute not set ("No such attribute", exit 1) is ABSENT`, async () => {
      const { c, r } = await read('read-absent')
      assert.deepEqual(r, { state: 'absent', dataset: c.path })
    })
    it(`${fs}: a writing mark is PRESENT, validated, with its bytes`, async () => {
      const { c, r } = await read('read-writing')
      assert.equal(r.state, 'present')
      assert.ok(r.state === 'present')
      assert.equal(r.dataset, c.path)
      assert.deepEqual(r.mark, CAPTURED_WRITING)
      assert.equal(r.hex, capturedHex(c))
    })
    it(`${fs}: an unverified mark is PRESENT with its state and reason`, async () => {
      const { r } = await read('read-unverified')
      assert.ok(r.state === 'present')
      assert.equal(r.mark?.state, 'unverified')
      assert.match(r.mark?.reason ?? '', /is 0 bytes, not the image's 1048576/)
    })
    it(`${fs}: a file that is not there ("No such file or directory") carries nothing: ABSENT, as a volume that is not there`, async () => {
      const { c, r } = await read('read-missing-file')
      assert.deepEqual(r, { state: 'absent', dataset: c.path })
    })
    it(`${fs}: an EMPTY value, a value that is not UTF-8 and one with a newline are still marks (details unknown), byte-exact`, async () => {
      const empty = await read('read-empty')
      assert.ok(empty.r.state === 'present')
      assert.deepEqual([empty.r.raw, empty.r.hex, empty.r.mark], ['', '', null])
      const odd = await read('read-odd')
      assert.ok(odd.r.state === 'present')
      assert.deepEqual([odd.r.hex, odd.r.mark], ['fffe0a7b', null])
      const nl = await read('read-newline')
      assert.ok(nl.r.state === 'present')
      assert.deepEqual([nl.r.raw, nl.r.mark], ['{\n}', null])
    })
  }

  it('ext4 and zfs mounted READ-ONLY: the mark set before still reads (present); a full filesystem reads absent when nothing was set', async () => {
    for (const [node, fs] of [['anas-pve', 'ext4'], ['anas-zfs', 'zfs-2.4.2']] as const) {
      const c = capturedCase(node, fs, 'readonly-read')
      const r = await readFileMark(replaying(c), c.path)
      assert.ok(r.state === 'present', `${fs}`)
      assert.deepEqual([r.raw, r.mark], ['{}', null])
      const f = capturedCase(node, fs, 'full-read')
      assert.equal((await readFileMark(replaying(f), f.path)).state, 'absent')
    }
  })

  it('vfat (a filesystem that refuses extended attributes): UNSUPPORTED with the reason, never absent', async () => {
    const c = capturedCase('anas-pve', 'vfat', 'unsupported-read')
    assert.deepEqual(await readFileMark(replaying(c), c.path), {
      state: 'unsupported',
      reason: 'the filesystem it is on refuses extended attributes (Operation not supported)',
    })
  })

  it('no getfattr on the node (spawn ENOENT, or a shell\'s 127): UNSUPPORTED naming the package and install.sh', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: GETFATTR, throws: enoent(GETFATTR), result: { stdout: '', stderr: '', exitCode: 0 } })
    assert.deepEqual(await readFileMark(mock, '/tank/images/x.raw'), { state: 'unsupported', reason: ATTR_NOT_INSTALLED })
    assert.deepEqual(await readFileMark(new MockExecutor(), '/tank/images/x.raw'), { state: 'unsupported', reason: ATTR_NOT_INSTALLED })
    assert.match(ATTR_NOT_INSTALLED, /attr package, which install\.sh installs/)
  })

  it('the ENOENT the fake throws is the real executor\'s shape (a real spawn of a binary that is not there)', async () => {
    const real = new ProdExecutor()
    const missing = '/nonexistent-anas-filemark/getfattr'
    const err = await real.exec(missing, ['--version']).then(() => null, (e: unknown) => e as NodeJS.ErrnoException)
    assert.ok(err, 'a missing binary rejects')
    assert.equal(err.code, (enoent(missing) as NodeJS.ErrnoException).code)
    // And through the reader: the real rejection is "not installed", never unknown.
    const routed: CommandExecutor = {
      exec: (c, a, o) => real.exec(c === GETFATTR ? missing : c, a, o),
      pipeline: (...x) => real.pipeline(...x),
      execToStream: (...x) => real.execToStream(...x),
    }
    assert.deepEqual(await readFileMark(routed, '/tank/images/x.raw'), { state: 'unsupported', reason: ATTR_NOT_INSTALLED })
  })

  it('any other failure is UNKNOWN, never absent: a rejected read, a refusal line nobody captured, output for two files', async () => {
    const thrown = new MockExecutor()
    thrown.addFixture({ command: GETFATTR, throws: new Error('Command timed out after 12000ms'), result: { stdout: '', stderr: '', exitCode: 0 } })
    const t = await readFileMark(thrown, '/tank/images/x.raw')
    assert.deepEqual([t.state, t.state === 'unknown' && t.reason], ['unknown', 'Command timed out after 12000ms'])
    // A captured setfattr refusal line, where getfattr printed it: not a line the reader knows.
    const ro = capturedCase('anas-pve', 'ext4', 'readonly-set')
    const odd = new MockExecutor()
    odd.addFixture({ command: GETFATTR, result: { stdout: '', stderr: ro.stderr, exitCode: 1 } })
    assert.equal((await readFileMark(odd, ro.path)).state, 'unknown')
    // Two captured value dumps in one output (one per file asked about): never read as one mark.
    const a = capturedCase('anas-pve', 'ext4', 'read-writing')
    const b = capturedCase('anas-pve', 'ext4', 'read-odd')
    assert.match((parseFileMarkHex(`${a.stdout}${b.stdout}`) as { error: string }).error, /getfattr printed/)
    const two = new MockExecutor()
    two.addFixture({ command: GETFATTR, result: { stdout: `${a.stdout}${b.stdout}`, stderr: '', exitCode: 0 } })
    assert.equal((await readFileMark(two, a.path)).state, 'unknown')
    // A value line that is not hex.
    assert.ok('error' in parseFileMarkHex(a.stdout.replace('=0x7b', '="{')))
  })
})

describe('cr3.lunrestore.filemark — the writer, captured refusal by captured refusal', () => {
  const run = (c: CapturedCase) => replaying(c)

  it('a set and a remove that exit 0 succeed (zfs, ext4, btrfs); a remove of an attribute that is not there is already done', async () => {
    for (const [node, fs] of ORDINARY) {
      const set = capturedCase(node, fs, 'set-writing')
      await setRestoreMark(run(set), set.path, CAPTURED_WRITING)
      await clearRestoreMark(run(capturedCase(node, fs, 'remove')), set.path)
      await clearRestoreMark(run(capturedCase(node, fs, 'remove-absent')), set.path)
    }
  })

  it('put back is byte-exact: the captured odd bytes go back as the captured argv', async () => {
    const c = capturedCase('anas-pve', 'ext4', 'set-odd')
    await putBackRestoreMark(run(c), c.path, 'ignored: the bytes win', 'fffe0a7b')
  })

  it('a read-only filesystem, a quota, a value too large and a missing file refuse with the node\'s own line — never "unsupported"', async () => {
    const cases: [CapturedCase, RegExp][] = [
      [capturedCase('anas-pve', 'ext4', 'readonly-set'), /Read-only file system/],
      [capturedCase('anas-zfs', 'zfs-2.4.2', 'readonly-set'), /Read-only file system/],
      [capturedCase('anas-zfs', 'zfs-2.4.2', 'full-set'), /Disk quota exceeded/],
      [capturedCase('anas-pve', 'ext4', 'set-missing-file'), /No such file or directory/],
    ]
    for (const [c, re] of cases) {
      const err = await setRestoreMark(run(c), c.path, CAPTURED_WRITING).then(() => null, (e: Error) => e)
      assert.ok(err && !(err instanceof RestoreMarkUnsupportedError), c.name)
      assert.match(err.message, re)
      assert.match(err.message, /could not set the restore mark trusted\.anas\.restore on /)
    }
    // ext4's limit for this name (4032 bytes, ground truth): 4096 is refused with ENOSPC.
    const big = capturedCase('anas-pve', 'ext4', 'toobig-set-4096')
    const mock = new MockExecutor()
    mock.addFixture({ command: SETFATTR, argsMatch: a => a[0] === '-n' && a.at(-1) === big.path, result: { stdout: big.stdout, stderr: big.stderr, exitCode: big.exitCode } })
    await assert.rejects(setRestoreMark(mock, big.path, CAPTURED_WRITING), /No space left on device/)
    const ro = capturedCase('anas-pve', 'ext4', 'readonly-remove')
    await assert.rejects(clearRestoreMark(run(ro), ro.path), /could not remove the restore mark .*Read-only file system/)
  })

  it('a filesystem that refuses extended attributes: a set throws RestoreMarkUnsupportedError; a remove is a plain failure (the mark, if any, stays)', async () => {
    const set = capturedCase('anas-pve', 'vfat', 'unsupported-set')
    const err = await setRestoreMark(run(set), set.path, CAPTURED_WRITING).then(() => null, (e: Error) => e)
    assert.ok(err instanceof RestoreMarkUnsupportedError)
    assert.equal(err.reason, 'the filesystem it is on refuses extended attributes (Operation not supported)')
    const rm = capturedCase('anas-pve', 'vfat', 'unsupported-remove')
    const rmErr = await clearRestoreMark(run(rm), rm.path).then(() => null, (e: Error) => e)
    assert.ok(rmErr && !(rmErr instanceof RestoreMarkUnsupportedError))
    assert.match(rmErr.message, /could not remove the restore mark trusted\.anas\.restore from .*refuses extended attributes/)
  })

  it('no setfattr on the node: a set throws RestoreMarkUnsupportedError naming the package; a remove fails plainly', async () => {
    const node = withFileMarks(new MockExecutor(), {}, { notInstalled: true })
    const err = await setRestoreMark(node.executor, '/tank/images/x.raw', CAPTURED_WRITING).then(() => null, (e: Error) => e)
    assert.ok(err instanceof RestoreMarkUnsupportedError)
    assert.equal(err.reason, ATTR_NOT_INSTALLED)
    await assert.rejects(clearRestoreMark(node.executor, '/tank/images/x.raw'), /could not remove the restore mark .*not installed on this node/)
  })
})

describe('cr3.lunrestore.filemark — where a mark lives, by the backing path', () => {
  it('a zvol path names its volume; an image file names itself; a device that is not a volume, or a relative path, names none', () => {
    assert.equal(markOn('/dev/zvol/tank/vol1'), 'tank/vol1')
    assert.equal(markOn('/tank/images/lun0.raw'), '/tank/images/lun0.raw')
    assert.equal(markOn('/mnt/anas-ahr/ahr0/images/lun0.raw'), '/mnt/anas-ahr/ahr0/images/lun0.raw')
    assert.equal(markOn('/dev/sdb'), null)
    assert.equal(markOn('/dev/zvol/tank'), null)
    assert.equal(markOn('images/lun0.raw'), null)
    assert.equal(isFileMark('tank/vol1'), false)
    assert.equal(isFileMark('/tank/images/lun0.raw'), true)
    assert.deepEqual([markName('tank/vol1'), markName('/tank/images/lun0.raw')], ['anas:restore', FILE_RESTORE_MARK_ATTR])
    assert.equal(clearMarkCommand('tank/vol1'), 'zfs inherit anas:restore tank/vol1')
    assert.equal(clearMarkCommand('/tank/images/lun0.raw'), 'setfattr -x trusted.anas.restore /tank/images/lun0.raw')
  })

  it('a block device that is not a volume reads unsupported without running anything', async () => {
    const mock = new MockExecutor()
    assert.deepEqual(await readRestoreMark(mock, { path: '/dev/sdb' }), { state: 'unsupported', reason: 'it is a device that is not a ZFS volume' })
    assert.equal(mock.calls.length, 0)
  })

  it('the batch read: one zfs get for the volumes, one getfattr per image file, each read as its single read reads it', async () => {
    const node = withFileMarks(new MockExecutor(), { '/tank/images/a.raw': hexOf(encodeRestoreMark(CAPTURED_WRITING)) })
    const zfs = new MockExecutor()
    let zfsCalls = 0
    const ex: CommandExecutor = {
      exec: async (c, a, o) => {
        if (c === '/usr/sbin/zfs') {
          zfsCalls++
          return zfs.exec(c, a, o).then(() => ({ stdout: 'tank/v1\t-\t-\ntank/v2\t-\t-\n', stderr: '', exitCode: 0 }))
        }
        return node.executor.exec(c, a, o)
      },
      pipeline: (...x) => node.executor.pipeline(...x),
      execToStream: (...x) => node.executor.execToStream(...x),
    }
    const reads = await readRestoreMarksBatch(ex, ['/dev/zvol/tank/v1', '/dev/zvol/tank/v2', '/tank/images/a.raw', '/tank/images/b.raw', '/dev/sdc'])
    assert.equal(zfsCalls, 1)
    assert.equal(reads.get('/tank/images/a.raw')?.state, 'present')
    assert.deepEqual(reads.get('/tank/images/b.raw'), { state: 'absent', dataset: '/tank/images/b.raw' })
    assert.equal(reads.get('/dev/zvol/tank/v1')?.state, 'absent')
    assert.equal(reads.get('/dev/sdc')?.state, 'unsupported')
  })
})

describe('cr3.lunrestore.filemark — the test fake prints only what the node printed', () => {
  it('a set, read, remove, remove-again cycle through withFileMarks answers byte for byte as anas-pve ext4 did', async () => {
    const path = capturedCase('anas-pve', 'ext4', 'read-absent').path
    const node = withFileMarks(new MockExecutor())
    const steps: [string, () => Promise<unknown>][] = [
      ['read-absent', () => node.executor.exec(GETFATTR, fileMarkGetArgs(path))],
      ['set-writing', () => node.executor.exec(SETFATTR, fileMarkSetArgs(path, hexOf(encodeRestoreMark(CAPTURED_WRITING))))],
      ['read-writing', () => node.executor.exec(GETFATTR, fileMarkGetArgs(path))],
      ['remove', () => node.executor.exec(SETFATTR, fileMarkRemoveArgs(path))],
      ['remove-absent', () => node.executor.exec(SETFATTR, fileMarkRemoveArgs(path))],
    ]
    for (const [name, step] of steps) {
      const c = capturedCase('anas-pve', 'ext4', name)
      assert.deepEqual(await step(), { stdout: c.stdout, stderr: c.stderr, exitCode: c.exitCode }, name)
    }
    // And a swapped path changes nothing but the path.
    const other = answerAs(capturedCase('anas-pve', 'ext4', 'read-absent'), '/x/y.raw')
    assert.equal(other.stderr, '/x/y.raw: trusted.anas.restore: No such attribute\n')
  })
})

describe('cr3.lunrestore.filemark review D1 — getfattr and setfattr run in the C locale (their error lines are matched in English)', () => {
  /** Record each call's options, answering as the captured ext4 node does. */
  function recordingEnv() {
    const seen: { command: string, args: string[], env?: Record<string, string> }[] = []
    const node = withFileMarks(new MockExecutor())
    const executor: CommandExecutor = {
      exec: async (c, a, o) => {
        seen.push({ command: c, args: a, ...(o?.env ? { env: o.env } : {}) })
        return node.executor.exec(c, a, o)
      },
      pipeline: (...x) => node.executor.pipeline(...x),
      execToStream: (...x) => node.executor.execToStream(...x),
    }
    return { executor, seen }
  }

  it('every getfattr and setfattr the reader and writers issue carries LC_ALL=C', async () => {
    const { executor, seen } = recordingEnv()
    const path = '/tank/images/lun2.raw'
    await readFileMark(executor, path)
    await setRestoreMark(executor, path, CAPTURED_WRITING)
    await readRestoreMarksBatch(executor, [path, '/tank/images/other.raw'])
    await putBackRestoreMark(executor, path, '', 'fffe0a7b')
    await clearRestoreMark(executor, path)
    await clearRestoreMark(executor, path)
    assert.ok(seen.length >= 7)
    for (const c of seen) {
      assert.ok(c.command === GETFATTR || c.command === SETFATTR)
      assert.deepEqual(c.env, { LC_ALL: 'C' }, `${c.command} ${c.args.join(' ')}`)
    }
  })

  it('a localized line, if one ever arrives, is never read as absent or as done: unknown, and a plain failure', async () => {
    // The real attr 2.6.0 text under de_DE.UTF-8 (review probe p1, this workstation).
    const de = new MockExecutor()
    de.addFixture({ command: GETFATTR, result: { stdout: '', stderr: '/tank/images/lun2.raw: trusted.anas.restore: Kein solches Attribut\n', exitCode: 1 } })
    assert.equal((await readFileMark(de, '/tank/images/lun2.raw')).state, 'unknown')
    const deRm = new MockExecutor()
    deRm.addFixture({ command: SETFATTR, result: { stdout: '', stderr: 'setfattr: /tank/images/lun2.raw: Kein solches Attribut\n', exitCode: 1 } })
    await assert.rejects(clearRestoreMark(deRm, '/tank/images/lun2.raw'), /could not remove the restore mark/)
  })

  it('end to end: a daemon started under de_DE still reads an unset attribute as ABSENT through the real getfattr', { skip: !existsSync(GETFATTR) && 'no getfattr on this host' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-filemark-locale-'))
    const before = process.env.LC_ALL
    try {
      const path = join(dir, 'lun.raw')
      await writeFile(path, '')
      process.env.LC_ALL = 'de_DE.UTF-8'
      // A non-root reader sees trusted.* as not set: the same line as an unmarked file read by root.
      assert.deepEqual(await readFileMark(new ProdExecutor(), path), { state: 'absent', dataset: path })
    }
    finally {
      if (before === undefined)
        delete process.env.LC_ALL
      else
        process.env.LC_ALL = before
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cr3.lunrestore.filemark review D2 — every copy the README and DESIGN state is in a capture', () => {
  /** `$ <command>` blocks of a travel/limits capture: the command, its output, its exit. */
  function blocks(file: string): { cmd: string, out: string, exit: number }[] {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'restore-mark', file), 'utf-8')
    const out: { cmd: string, out: string, exit: number }[] = []
    let cur: { cmd: string, lines: string[] } | null = null
    for (const line of text.split('\n')) {
      if (line.startsWith('$ ')) {
        cur = { cmd: line.slice(2), lines: [] }
        continue
      }
      const e = /^exit=(\d+)$/.exec(line)
      if (e && cur) {
        out.push({ cmd: cur.cmd, out: cur.lines.join('\n'), exit: Number(e[1]) })
        cur = null
        continue
      }
      cur?.lines.push(line)
    }
    return out
  }
  /** Does the getfattr of `path` in this capture show the mark? (the read after the step named) */
  function markOnAfter(file: string, step: RegExp, path: string): boolean {
    const b = blocks(file)
    const at = b.findIndex(x => step.test(x.cmd))
    assert.ok(at >= 0 && b[at].exit === 0, `${file}: the step ${step} ran and exited 0`)
    const read = b.slice(at + 1).find(x => x.cmd.startsWith('getfattr ') && x.cmd.includes(path))
    assert.ok(read, `${file}: a read of ${path} after ${step}`)
    return read.exit === 0 && /^trusted\.anas\.restore=0x7b7d$/m.test(read.out)
  }

  it('ZFS: mv between two datasets, the .zfs/snapshot copy, plain send|recv and a clone carry it; a rollback puts back what the snapshot holds', () => {
    const f = 'travel.anas-zfs.txt'
    assert.match(blocks(f)[1].out, /^\/rpool\/filemarkgt\/a zfs rpool\/filemarkgt\/a\n\/rpool\/filemarkgt\/b zfs rpool\/filemarkgt\/b\n60 .*\n61 /, 'two filesystems (two devices)')
    assert.equal(markOnAfter(f, /^cp -a .* && mv \/rpool\/filemarkgt\/a\/mv\.raw \/rpool\/filemarkgt\/b\/mv\.raw$/, '/rpool/filemarkgt/b/mv.raw'), true)
    assert.equal(markOnAfter(f, /^zfs snapshot rpool\/filemarkgt\/a@s1$/, '.zfs/snapshot/s1/img.raw'), true)
    assert.equal(markOnAfter(f, /^zfs send rpool\/filemarkgt\/a@s1 \| zfs recv /, '/rpool/filemarkgt/recvd/img.raw'), true)
    assert.equal(markOnAfter(f, /^zfs clone /, '/rpool/filemarkgt/clone/img.raw'), true)
    assert.equal(markOnAfter(f, /^setfattr -x /, '/rpool/filemarkgt/a/img.raw'), false, 'removed after the snapshot')
    assert.equal(markOnAfter(f, /^zfs rollback rpool\/filemarkgt\/a@s1$/, '/rpool/filemarkgt/a/img.raw'), true, 'the rollback brings it back')
    assert.equal(markOnAfter(f, /^zfs rollback rpool\/filemarkgt\/a@s2$/, '/rpool/filemarkgt/a/late.raw'), false, 'a mark set after the snapshot goes')
  })

  it('ext4 and btrfs: cp -a, rsync -aX and mv across filesystems carry it, plain cp and rsync drop it; btrfs snapshots carry it', () => {
    const f = 'travel.anas-pve.txt'
    assert.match(blocks(f)[1].out, /^\/ ext4\n\/mnt\/filemarkgt\/btrfs btrfs$/, 'ext4 and btrfs')
    assert.equal(markOnAfter(f, /^cp \/mnt\/filemarkgt\/ext4\/img\.raw /, 'btrfs/cp.raw'), false)
    assert.equal(markOnAfter(f, /^cp -a \/mnt\/filemarkgt\/ext4\/img\.raw \/mnt\/filemarkgt\/btrfs\/cp-a\.raw$/, 'btrfs/cp-a.raw'), true)
    assert.equal(markOnAfter(f, /^rsync \/mnt/, 'btrfs/rsync.raw'), false)
    assert.equal(markOnAfter(f, /^rsync -aX /, 'btrfs/rsync-aX.raw'), true)
    assert.equal(markOnAfter(f, /&& mv \/mnt\/filemarkgt\/ext4\/mv\.raw \/mnt\/filemarkgt\/btrfs\/mv\.raw$/, 'btrfs/mv.raw'), true)
    assert.equal(markOnAfter(f, /^mv \/mnt\/filemarkgt\/btrfs\/mv\.raw /, 'ext4/mv-back.raw'), true)
    assert.equal(markOnAfter(f, /^btrfs subvolume snapshot \/mnt/, 'sv-snap/img.raw'), true)
    assert.equal(markOnAfter(f, /^btrfs subvolume snapshot -r /, 'sv-rosnap/img.raw'), true)
  })

  it('OpenZFS 2.4.2 xattr=off does not refuse the mark; ext4 takes 4032 bytes and refuses 4033', () => {
    const z = blocks('limits.anas-zfs.txt')
    assert.match(z[1].out, /noxattr/)
    assert.equal(markOnAfter('limits.anas-zfs.txt', /^setfattr -n trusted\.anas\.restore -v 0x7b7d -- \/rpool\/filemarkgt\/xoff\/lun0\.img$/, 'xoff/lun0.img'), true)
    const p = blocks('limits.anas-pve.txt')
    const sized = (n: number) => p.find(x => x.cmd.includes(`head -c ${n} `) && x.cmd.includes('/ext4/a.img'))!
    assert.deepEqual([sized(4032).exit, sized(4032).out], [0, '4032'])
    assert.equal(sized(4033).exit, 1)
    assert.match(sized(4033).out, /No space left on device/)
  })
})
