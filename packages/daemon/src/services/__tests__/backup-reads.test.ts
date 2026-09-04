import type { BackupRepo } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyArchiveFile, composeGroupId, composeSnapshotId, isBrowsableArchive, snapshotTimeIso } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildGroupListArgs,
  buildSnapshotListArgs,
  classifyBackupReadVerdict,
  listGroups,
  listSnapshots,
  NOT_FOUND_DETAIL,
  parseGroupList,
  parseSnapshotList,
  toSnapshotFile,
} from '../backup-reads.js'

const PBC = '/usr/bin/proxmox-backup-client'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

function makeRepo(over: Partial<BackupRepo> = {}): BackupRepo {
  return {
    name: 'pbs-main',
    host: 'localhost',
    port: 8007,
    datastore: 'anastest-store',
    authType: 'token',
    tokenId: 'root@pam!anas-test',
    ...over,
  }
}

describe('backup restore reads — archive classification (backup2.5)', () => {
  it('classifies every stored filename shape the real fixtures contain', () => {
    // Straight from snapshot-list-namespace.json / group-list.json.
    assert.deepEqual(classifyArchiveFile('data.pxar.didx'), { kind: 'pxar', archive: 'data.pxar' })
    assert.deepEqual(classifyArchiveFile('cdm.mpxar.didx'), { kind: 'pxar', archive: 'cdm.mpxar' })
    assert.deepEqual(classifyArchiveFile('cdm.ppxar.didx'), { kind: 'pxar', archive: 'cdm.ppxar' })
    assert.deepEqual(classifyArchiveFile('lun.img.fidx'), { kind: 'img', archive: 'lun.img' })
    // Bookkeeping — never a restore source, so no archive argument at all.
    assert.deepEqual(classifyArchiveFile('catalog.pcat1.didx'), { kind: 'other' })
    assert.deepEqual(classifyArchiveFile('index.json.blob'), { kind: 'other' })
  })

  it('accepts a bare archive argument (the browse endpoint takes one)', () => {
    assert.deepEqual(classifyArchiveFile('data.pxar'), { kind: 'pxar', archive: 'data.pxar' })
    assert.deepEqual(classifyArchiveFile('lun.img'), { kind: 'img', archive: 'lun.img' })
    // GT: `catalog shell … data` → `Error: failed to parse archive type for 'data'`.
    assert.deepEqual(classifyArchiveFile('data'), { kind: 'other' })
  })

  it('only pxar archives are browsable — an image is restored whole', () => {
    assert.equal(isBrowsableArchive('pxar'), true)
    assert.equal(isBrowsableArchive('img'), false)
    assert.equal(isBrowsableArchive('other'), false)
  })

  it('composes the id the client does not return (GT-1) and the group path', () => {
    // The real capture: backup-time 1787685405 is host/gtrestore/2026-08-25T19:16:45Z.
    assert.equal(composeSnapshotId('host', 'gtrestore', 1787685405), 'host/gtrestore/2026-08-25T19:16:45Z')
    assert.equal(snapshotTimeIso(1787685405), '2026-08-25T19:16:45Z')
    assert.equal(composeGroupId('host', 'gtrestore'), 'host/gtrestore')
  })
})

describe('backup restore reads — snapshot list parsing (real fixtures)', () => {
  it('parses the single-group capture, composing ids and classifying files', () => {
    const snaps = parseSnapshotList(fixture('snapshot-list-group.json'))
    assert.ok(snaps)
    assert.equal(snaps.length, 1)
    const s = snaps[0]!
    assert.equal(s.snapshot, `host/${s.backupId}/${s.backupTimeIso}`)
    assert.equal(s.backupType, 'host')
    assert.ok(Number.isInteger(s.backupTime))
    // GT-4: files[].size is the space estimate, read straight off the listing.
    const pxar = s.files.find(f => f.kind === 'pxar')
    assert.ok(pxar, 'the capture holds a pxar archive')
    assert.ok(typeof pxar.size === 'number' && pxar.size > 0)
    assert.ok(pxar.archive && !pxar.archive.endsWith('.didx'))
    // The manifest blob is present but is never offered as a restore source.
    assert.ok(s.files.some(f => f.filename === 'index.json.blob' && f.kind === 'other' && f.archive === undefined))
  })

  it('sorts NEWEST FIRST — GT-2: the client returns an unsorted array', () => {
    const raw = JSON.parse(fixture('snapshot-list-namespace.json')) as { 'backup-time': number }[]
    const rawTimes = raw.map(r => r['backup-time'])
    const sortedTimes = [...rawTimes]
    sortedTimes.sort((a, b) => b - a)
    assert.notDeepEqual(rawTimes, sortedTimes, 'the fixture really is unsorted (the whole reason we sort)')

    const snaps = parseSnapshotList(fixture('snapshot-list-namespace.json'))
    assert.ok(snaps)
    assert.equal(snaps.length, raw.length)
    for (let i = 1; i < snaps.length; i++)
      assert.ok(snaps[i - 1]!.backupTime >= snaps[i]!.backupTime, 'newest first')
  })

  it('the namespace form carries every group, each with a composed id', () => {
    const snaps = parseSnapshotList(fixture('snapshot-list-namespace.json'))
    assert.ok(snaps)
    const ids = new Set(snaps.map(s => s.backupId))
    assert.ok(ids.size > 1, 'a namespace listing spans several groups')
    for (const s of snaps)
      assert.equal(s.snapshot, `${s.backupType}/${s.backupId}/${s.backupTimeIso}`)
  })

  it('carries owner and protected through verbatim', () => {
    const snaps = parseSnapshotList(fixture('snapshot-list-group.json'))
    assert.ok(snaps)
    assert.equal(snaps[0]!.owner, 'root@pam!anas-test')
    assert.equal(snaps[0]!.protected, false)
  })

  it('an .img snapshot reports the full device size as the archive size', () => {
    const files = (JSON.parse(fixture('snapshot-files-img.json')) as unknown[])
      .map(toSnapshotFile)
      .filter(f => f !== null)
    const img = files.find(f => f.kind === 'img')
    assert.ok(img)
    assert.equal(img.archive, 'lun.img')
    assert.equal(img.size, 536870912)
  })

  it('the metadata-mode snapshot exposes BOTH mpxar and ppxar as pxar archives', () => {
    const files = (JSON.parse(fixture('snapshot-files-metadata.json')) as unknown[])
      .map(toSnapshotFile)
      .filter(f => f !== null)
    const kinds = files.filter(f => f.kind === 'pxar').map(f => f.archive)
    assert.ok(kinds.some(a => a?.endsWith('.mpxar')))
    assert.ok(kinds.some(a => a?.endsWith('.ppxar')))
  })

  it('GT-5: an empty listing is an empty list, not a failure', () => {
    assert.deepEqual(parseSnapshotList('[]'), [])
  })

  it('a non-array / unparseable payload is null (a fault, not an empty listing)', () => {
    assert.equal(parseSnapshotList('not json'), null)
    assert.equal(parseSnapshotList('{"a":1}'), null)
  })

  it('an element missing its identity parts is skipped, not guessed at', () => {
    const parsed = parseSnapshotList(JSON.stringify([
      { 'backup-id': 'x', 'backup-type': 'host' },
      { 'backup-id': 'y', 'backup-time': 100, 'backup-type': 'host', 'files': [] },
    ]))
    assert.ok(parsed)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]!.backupId, 'y')
  })
})

describe('backup restore reads — group list parsing (GT-3: files are STRINGS)', () => {
  it('parses the real group-list capture and classifies the bare filenames', () => {
    const groups = parseGroupList(fixture('group-list.json'))
    assert.ok(groups)
    assert.ok(groups.length > 0)
    const g = groups[0]!
    assert.equal(g.group, `${g.backupType}/${g.backupId}`)
    assert.ok(typeof g.backupCount === 'number')
    assert.ok(typeof g.lastBackup === 'number')
    assert.equal(g.lastBackupIso, snapshotTimeIso(g.lastBackup!))
    // The strings became the SAME classified shape the snapshot listing uses —
    // with no size, because the group listing does not report one.
    for (const f of g.files) {
      assert.equal(typeof f.filename, 'string')
      assert.equal(f.size, undefined)
    }
  })

  it('sorts newest-last-backup first', () => {
    const groups = parseGroupList(fixture('group-list.json'))
    assert.ok(groups)
    for (let i = 1; i < groups.length; i++)
      assert.ok((groups[i - 1]!.lastBackup ?? 0) >= (groups[i]!.lastBackup ?? 0))
  })

  it('an unparseable payload is null', () => {
    assert.equal(parseGroupList('nope'), null)
  })
})

describe('backup restore reads — argv', () => {
  it('the group form names the group, the namespace form does not', () => {
    assert.deepEqual(
      buildSnapshotListArgs('host/gtrestore', 'gtrestore'),
      ['snapshot', 'list', 'host/gtrestore', '--ns', 'gtrestore', '--output-format', 'json'],
    )
    assert.deepEqual(
      buildSnapshotListArgs(undefined, 'gtrestore'),
      ['snapshot', 'list', '--ns', 'gtrestore', '--output-format', 'json'],
    )
  })

  it('no namespace means the datastore root — no empty --ns is emitted', () => {
    assert.deepEqual(buildSnapshotListArgs('host/x'), ['snapshot', 'list', 'host/x', '--output-format', 'json'])
    assert.deepEqual(buildGroupListArgs(), ['list', '--output-format', 'json'])
  })

  it('the group listing is `list`, structured (Principle 13 — never the table)', () => {
    assert.deepEqual(buildGroupListArgs('gtrestore'), ['list', '--ns', 'gtrestore', '--output-format', 'json'])
  })
})

describe('backup restore reads — failure taxonomy (verbatim stderr)', () => {
  const browse = fixture('catalog-shell-browse.txt')

  it('a missing snapshot, group or namespace collapse to ONE message', () => {
    // All three of these strings are in the real capture.
    assert.ok(browse.includes('Error: snapshot host/gtrestore/2020-01-01T00:00:00Z does not exist.'))
    assert.ok(browse.includes('Error: ENOENT: No such file or directory'))
    for (const stderr of [
      'Error: snapshot host/gtrestore/2020-01-01T00:00:00Z does not exist.',
      'Error: ENOENT: No such file or directory',
    ]) {
      const v = classifyBackupReadVerdict(255, stderr)
      assert.equal(v.verdict, 'not-found')
      assert.equal(v.detail, NOT_FOUND_DETAIL)
      assert.ok(/snapshot, group or namespace/.test(v.detail), 'the message names all three')
    }
  })

  it('PBS down is `unreachable` and carries the 4.2.5 Caused-by cause', () => {
    const stderr = 'Error: client error (Connect)\n\nCaused by:\n    error connecting to https://localhost:9999/'
      + ' - tcp connect error: Connection refused (os error 111)\n'
    assert.ok(browse.includes('tcp connect error: Connection refused (os error 111)'))
    const v = classifyBackupReadVerdict(255, stderr)
    assert.equal(v.verdict, 'unreachable')
    assert.ok(v.detail.includes('Connection refused'))
  })

  it('BOTH no-permission wordings map to `permission` (they differ per command)', () => {
    // catalog shell says one thing, snapshot list / list say another — real capture.
    assert.ok(browse.includes('Error: no permissions on /datastore/anastest-store/gtrestore'))
    assert.ok(browse.includes('Error: permission check failed - missing Datastore.Audit|Datastore.Backup'))
    for (const stderr of [
      'Error: no permissions on /datastore/anastest-store/gtrestore',
      'Error: permission check failed - missing Datastore.Audit|Datastore.Backup on /datastore/anastest-store/gtrestore',
    ]) {
      assert.equal(classifyBackupReadVerdict(255, stderr).verdict, 'permission')
    }
  })

  it('a BARE `permission check failed` — a wrong password — reads as a CREDENTIAL problem (R5)', () => {
    // Without the `- missing` suffix PBS is saying the credential was REJECTED,
    // not that it lacks privileges. The old wording ("lacks read access - PBS
    // wants Datastore.Audit or Datastore.Backup") sent an operator with a bad
    // password to fix their token's role.
    const v = classifyBackupReadVerdict(255, 'Error: permission check failed\n')
    assert.equal(v.verdict, 'error')
    assert.ok(/authentication failure/.test(v.detail), v.detail)
    assert.ok(!/Datastore\.Audit/.test(v.detail), 'the privileges wording must not appear for a rejected credential')
  })

  it('the missing-privileges suffix keeps its `permission` verdict and Datastore.Audit wording (R5)', () => {
    const v = classifyBackupReadVerdict(255, 'Error: permission check failed - missing Datastore.Audit|Datastore.Backup on /datastore/anastest-store/gtrestore')
    assert.equal(v.verdict, 'permission')
    assert.ok(v.detail.includes('Datastore.Audit'))
  })

  it('a wrong archive name and a missing type suffix are told apart', () => {
    assert.ok(browse.includes('Error: archive not found in manifest'))
    assert.ok(browse.includes('Error: failed to parse archive type for \'data\''))
    assert.equal(classifyBackupReadVerdict(255, 'Error: archive not found in manifest').verdict, 'not-found')
    const suffix = classifyBackupReadVerdict(255, 'Error: failed to parse archive type for \'data\'')
    assert.equal(suffix.verdict, 'error')
    assert.ok(suffix.detail.includes('type suffix'))
  })

  it('an image handed to the browser says so plainly', () => {
    assert.ok(browse.includes('Error: Can only mount pxar archives.'))
    const v = classifyBackupReadVerdict(255, 'Error: Can only mount pxar archives.')
    assert.equal(v.verdict, 'error')
    assert.ok(v.detail.includes('restored whole'))
  })

  it('a killed child (timeout exit 124) is `unreachable`, not a silent empty list', () => {
    const v = classifyBackupReadVerdict(124, '', true)
    assert.equal(v.verdict, 'unreachable')
    assert.ok(v.detail.includes('did not answer in time'))
  })

  it('anything unrecognised keeps the verbatim Error: line', () => {
    const v = classifyBackupReadVerdict(255, 'Error: something entirely new\n')
    assert.equal(v.verdict, 'error')
    assert.equal(v.detail, 'Error: something entirely new')
  })
})

describe('backup restore reads — the runners', () => {
  it('listSnapshots sends the right argv and returns sorted snapshots', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: PBC, result: { stdout: fixture('snapshot-list-namespace.json'), stderr: '', exitCode: 0 } })
    const out = await listSnapshots(exec, { repo: makeRepo(), secret: 's3cr3t', namespace: 'gtrestore' }, 'host/gtcdm')
    assert.ok(out.ok)
    assert.deepEqual(exec.calls[0]!.args, ['snapshot', 'list', 'host/gtcdm', '--ns', 'gtrestore', '--output-format', 'json'])
    for (let i = 1; i < out.data.length; i++)
      assert.ok(out.data[i - 1]!.backupTime >= out.data[i]!.backupTime)
  })

  it('the secret NEVER reaches argv', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })
    await listSnapshots(exec, { repo: makeRepo(), secret: 'super-secret-token', namespace: 'ns' }, 'host/x')
    for (const call of exec.calls)
      assert.ok(!call.args.some(a => a.includes('super-secret-token')), 'no secret on argv')
  })

  it('a non-zero exit becomes a verdict, never a throw', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: PBC, result: { stdout: '', stderr: 'Error: ENOENT: No such file or directory', exitCode: 255 } })
    const out = await listSnapshots(exec, { repo: makeRepo(), secret: 'x' })
    assert.equal(out.ok, false)
    assert.equal(out.ok === false && out.verdict, 'not-found')
  })

  it('exit 0 with unexpected output is an error verdict, not an empty listing', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: PBC, result: { stdout: 'Nothing here', stderr: '', exitCode: 0 } })
    const out = await listSnapshots(exec, { repo: makeRepo(), secret: 'x' })
    assert.equal(out.ok, false)
    assert.equal(out.ok === false && out.verdict, 'error')
  })

  it('listGroups parses the real group listing', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: PBC, result: { stdout: fixture('group-list.json'), stderr: '', exitCode: 0 } })
    const out = await listGroups(exec, { repo: makeRepo(), secret: 'x', namespace: 'gtrestore' })
    assert.ok(out.ok)
    assert.deepEqual(exec.calls[0]!.args, ['list', '--ns', 'gtrestore', '--output-format', 'json'])
    assert.ok(out.data.length > 0)
  })

  it('an executor that throws becomes an error verdict', async () => {
    const throwing = {
      exec: async () => { throw new Error('ENOENT: no proxmox-backup-client') },
      pipeline: async () => { throw new Error('unused') },
    }
    const out = await listSnapshots(throwing as never, { repo: makeRepo(), secret: 'x' })
    assert.equal(out.ok, false)
    assert.ok(out.ok === false && out.detail.includes('ENOENT'))
  })
})
