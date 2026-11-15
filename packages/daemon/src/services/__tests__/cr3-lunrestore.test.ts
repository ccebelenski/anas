/**
 * cr3.lunrestore — a restore as a NEW LUN never exposes an image that is not
 * completely written.
 *
 * The rule (operator, 2026-11-14: "ship no problem of our own making"): the LUN
 * is mapped, its ACLs granted and the configuration saved only AFTER the stream
 * ended with exit 0 and the size read back confirmed it. Until then the image
 * sits in a backstore that no LUN maps — which holds its backing like a LUN
 * (the claims), is reported for what it is (health, dashboard), is persisted
 * by another verb's `saveconfig` as a storage object with no LUN, and is never
 * "repaired" into a mapping.
 *
 * The node is modelled by replaying the argv the run issued (`lio-model.ts`):
 * a daemon that stops inside call K leaves exactly the live tree of the calls
 * before K, and a reboot brings back whatever the last `saveconfig` held — in
 * the worst case, another verb saved the live tree the instant before the stop.
 */
import type { IscsiLun, IscsiTargetDetail, RestoreMark } from '@anas/shared'
import type { CommandExecutor, ExecResult } from '../../executor/types.js'
import type { ImageRestoreDeps, NewLunRestoreDeps } from '../backup-restore.js'
import type { IscsiRepairItem } from '../iscsi-repair.js'
import type { IscsiReadContext } from '../iscsi.js'
import type { RestoreMarkRead } from '../restore-mark.js'
import type { LioTree, RecordedCall } from './lio-model.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { StreamFlushError, StreamNotStartedError } from '../../executor/stream-errors.js'
import { JobQueue } from '../../jobs/queue.js'
import { reconcileLunWarnings, rewriteLunWarnings } from '../../routes/ahr-mutate.js'
import { assertVolumeMutable } from '../../routes/datasets.js'
import { failedBeforeWriting, imageBytesWritten, ownBackstoreRefusal, parseRestoreProgress, runImageRestore, runNewLunImageRestore, volsizeArgs } from '../backup-restore.js'
import { buildBackupEnv, PBC } from '../backup-runner.js'
import { describeUnmappedHolder, findUnmappedBackstoreHolder } from '../iscsi-configfs.js'
import { lunNameFreeGate } from '../iscsi-guard.js'
import { computeIscsiHealth, unmappedLiveBackstores } from '../iscsi-health.js'
import { heldByLunRefusal, heldHolderPhrase, pickHolder } from '../iscsi-held.js'
import { assertSaveable, claimsFromState, createAndMapLun, createLunBackstore, mapLunIntoTarget, saveIscsiConfig, TARGETCLI, withIscsiLock, ZFS } from '../iscsi-mutate.js'
import { readRestoreMarks } from '../iscsi-quarantine.js'
import { assertRepairable, planIscsiRepair, repairIscsiHoles } from '../iscsi-repair.js'
import { buildIscsiWarnings } from '../iscsi-warnings.js'
import { buildIscsiTargets } from '../iscsi.js'
import { decodeRestoreMark, describeMarkSet, enableMarkVerdict, encodeRestoreMark, imageRestorePin, JOB_RECORD_ONLY, markDataset, readLunMarks, readRestoreMark, readRestoreMarksBatch, restoreJobsOf, restoreMarkGetArgs, restoreMarkRefusal, restoreMarksGetArgs, unverifiedMark, writingMark } from '../restore-mark.js'
import { contextOf, recording, replayLio, targetObjectOf } from './lio-model.js'

const IQN = 'iqn.2026-08.nas.anas:vmstore'
const SNAP = 'host/gtimgboth/2026-08-25T19:28:38Z'
const IMAGE_SIZE = 536870912
const SOURCE_SERIAL = '9bc6e907-6015-4267-be4f-5a0617cb3d71'
const INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
const NEWVOL = '/dev/zvol/tank/newvol'
const REPO = { name: 'pbs-main', host: 'pbs.example', port: 8007, datastore: 'store', authType: 'token' as const, tokenId: 'root@pam!anas' }

const SOURCE_BASE = {
  iqn: IQN,
  tag: 1,
  backstores: [{ name: 'vmdisk1', plugin: 'block', dev: '/dev/zvol/tank/vol1', wwn: SOURCE_SERIAL }],
  luns: [{ iqn: IQN, tag: 1, index: 0, backstore: 'vmdisk1', plugin: 'block' }],
}

function targetDetail(extraLuns: number[] = []): IscsiTargetDetail {
  const lun = (index: number, name: string) => ({
    index,
    name,
    kind: 'zvol' as const,
    plugin: 'block',
    backingPath: `/dev/zvol/tank/${name}`,
    size: IMAGE_SIZE,
    serial: SOURCE_SERIAL,
    attributes: {},
    connectedInitiators: [],
    present: true,
    backingExists: true,
    pool: 'tank',
    dataset: `tank/${name}`,
  })
  return {
    iqn: IQN,
    name: 'vmstore',
    ownership: 'anas',
    ownershipReason: 'anas-managed',
    ownershipDetail: '',
    tpgTag: 1,
    enabled: true,
    portals: [],
    lunCount: 1 + extraLuns.length,
    aclCount: 1,
    sessionCount: 0,
    security: { authentication: false, generateNodeAcls: false, demoModeDiscovery: false },
    present: true,
    persisted: true,
    missingLunCount: 0,
    portalsWithoutInterfaceCount: 0,
    luns: [lun(0, 'vol1'), ...extraLuns.map(i => lun(i, `other${i}`))],
    acls: [{ initiatorIqn: INITIATOR, chapUserid: null, chapCredentialsSet: false, mutualUserid: null, mutualCredentialsSet: false, mappedLuns: [0] }],
    sessions: [],
  } as IscsiTargetDetail
}

/** The node right now, as the recorded calls left it (failed calls not applied). */
function nodeOf(calls: RecordedCall[]) {
  const m = replayLio(calls)
  return { model: m, ctx: contextOf(m, m.saved, SOURCE_BASE) }
}

function argv(calls: RecordedCall[]): string[] {
  return calls.map(c => `${c.command} ${c.args.join(' ')}`)
}

/** A mock wired for a SUCCESSFUL zvol new-LUN restore; `over` fixtures win (added first). */
function mockWith(over: (m: MockExecutor) => void = () => {}, stream = { stderr: 'restore complete (512 MiB processed in 0.6s)    \n', exitCode: 0, bytesWritten: IMAGE_SIZE }): MockExecutor {
  const mock = new MockExecutor()
  over(mock)
  mock.addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addFixture({ command: ZFS, result: { stdout: '', stderr: '', exitCode: 0 } })
  mock.addStreamFixture({ command: PBC, result: stream })
  return mock
}

function depsFor(rec: { executor: import('../../executor/types.js').CommandExecutor, calls: RecordedCall[] }, configfsRoot: string, over: Partial<NewLunRestoreDeps> = {}): NewLunRestoreDeps {
  return {
    repo: REPO,
    secret: 'super-secret',
    namespace: 'gtrestore',
    snapshot: SNAP,
    archive: 'vol.img',
    imageSize: IMAGE_SIZE,
    target: targetDetail(),
    refresh: async () => targetDetail(),
    refreshAfterCreate: async () => targetObjectOf(targetDetail(), nodeOf(rec.calls).ctx),
    readLive: async () => ({ ctx: nodeOf(rec.calls).ctx }),
    name: 'newvol',
    backing: { path: NEWVOL, plugin: 'block', dataset: 'tank/newvol' },
    env: buildBackupEnv(REPO, 'super-secret'),
    mutate: { executor: rec.executor, configfsRoot },
    ...over,
  }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'anas-cr3-lunrestore-'))
  try {
    await mkdir(join(root, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR), { recursive: true })
    await run(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const isNewvolLun = (tree: LioTree) => tree.luns.some(l => l.backstore === 'newvol')
const hasNewvolBackstore = (tree: LioTree) => tree.backstores.some(b => b.name === 'newvol')

/** THE invariant: at no prefix of the call log is newvol a LUN before the image was proved whole. */
function assertNeverExposedHalf(calls: RecordedCall[]): void {
  for (let k = 0; k <= calls.length; k++) {
    const tree = replayLio(calls, k)
    if (!isNewvolLun(tree))
      continue
    const before = calls.slice(0, k)
    const stream = before.findIndex(c => c.command === PBC && c.kind === 'stream')
    const sized = before.findIndex(c => c.command === ZFS && c.args.join(' ') === volsizeArgs('tank/newvol').join(' '))
    assert.ok(stream >= 0 && before[stream].exitCode === 0, `prefix ${k}: newvol mapped before a stream that ended with exit 0`)
    assert.ok(sized > stream && before[sized].exitCode === 0, `prefix ${k}: newvol mapped before its size was read back`)
  }
}

/** The marks the model holds, as the health read's per-backing reads (no job running: a crashed run has none). */
function marksOf(model: { marks: string[], volumes: string[] }, paths: string[]): Map<string, RestoreMarkRead> {
  return new Map(paths.map((p) => {
    const ds = p.slice('/dev/zvol/'.length)
    const read: RestoreMarkRead = model.marks.includes(ds)
      ? { state: 'present', dataset: ds, raw: '{}', mark: null }
      : { state: 'absent', dataset: ds }
    return [p, read]
  }))
}

// The successful zvol run, call by call (0-based), with what a stop INSIDE
// that call leaves on the node (the call itself not applied) and whether the
// volume then carries the restore mark.
const CRASH_TABLE: { at: number, call: string, node: 'nothing' | 'backing only' | 'unmapped backstore' | 'complete LUN', mark: boolean }[] = [
  { at: 0, call: 'zfs create -s -V', node: 'nothing', mark: false },
  { at: 1, call: 'zfs set anas:restore (the mark)', node: 'backing only', mark: false },
  { at: 2, call: 'backstore create', node: 'backing only', mark: true },
  { at: 3, call: 'set emulate_tpu', node: 'unmapped backstore', mark: true },
  { at: 4, call: 'set emulate_tpws', node: 'unmapped backstore', mark: true },
  { at: 5, call: 'set max_unmap_lba_count', node: 'unmapped backstore', mark: true },
  { at: 6, call: 'set emulate_write_cache', node: 'unmapped backstore', mark: true },
  { at: 7, call: 'the image stream', node: 'unmapped backstore', mark: true },
  { at: 8, call: 'size read-back', node: 'unmapped backstore', mark: true },
  { at: 9, call: 'zfs inherit anas:restore (mark removed)', node: 'unmapped backstore', mark: true },
  { at: 10, call: 'map (luns create)', node: 'unmapped backstore', mark: false },
  { at: 11, call: 'ACL grant', node: 'complete LUN', mark: false },
  { at: 12, call: 'saveconfig', node: 'complete LUN', mark: false },
]

describe('cr3.lunrestore — the crash table: a stop at every step leaves no LUN, or a complete one; the mark says which', () => {
  it('the successful run is exactly the 13 calls the table names, and its log never maps newvol early', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith())
      const result = await runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {})
      assert.equal(rec.calls.length, CRASH_TABLE.length, argv(rec.calls).join('\n'))
      assert.equal(result.lunIndex, 1)
      assertNeverExposedHalf(rec.calls)
      assert.deepEqual(replayLio(rec.calls).marks, [], 'no mark is left after a verified restore')
    })
  })

  for (const row of CRASH_TABLE) {
    it(`a stop inside call ${row.at} (${row.call}) leaves: ${row.node}, mark ${row.mark ? 'present' : 'absent'} — after a daemon restart and after a reboot`, async () => {
      await withRoot(async (root) => {
        const rec = recording(mockWith(), { haltAt: row.at })
        const run = runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {})
        run.catch(() => {})
        await rec.halted
        try {
          await checkCrashRow(row, rec.calls.slice(0, row.at))
        }
        finally {
          // Unwind the halted run (and any iSCSI mutex it holds) whatever the verdict.
          rec.resume()
          await run.catch(() => {})
        }
      })
    })
  }

  async function checkCrashRow(row: typeof CRASH_TABLE[number], halted: RecordedCall[]): Promise<void> {
    const live = replayLio(halted)
    // Worst case: another iSCSI verb saved the live tree just before the stop.
    const savedWorst: LioTree = { backstores: live.backstores, luns: live.luns }
    assertNeverExposedHalf(halted)
    assert.equal(live.marks.includes('tank/newvol'), row.mark, 'the mark column')
    for (const [when, tree] of [['daemon restart', live], ['reboot after a save by another verb', savedWorst]] as const) {
      const ctx = contextOf(tree, savedWorst, SOURCE_BASE)
      const targets = await buildIscsiTargets(ctx)
      // The job died with the daemon: no restore is running.
      const health = computeIscsiHealth(ctx, targets, { marks: marksOf(live, [NEWVOL, '/dev/zvol/tank/vol1']), restoreRunning: () => undefined })
      const cards = buildIscsiWarnings(health).map(w => w.message).join('\n')
      assert.equal(health.degraded, false, `${when}: never degraded`)
      if (row.node === 'nothing' || row.node === 'backing only') {
        assert.ok(!hasNewvolBackstore(tree) && !isNewvolLun(tree), `${when}: no LIO object`)
        assert.deepEqual(health.unmappedBackstores, [])
      }
      else if (row.node === 'unmapped backstore') {
        assert.ok(hasNewvolBackstore(tree) && !isNewvolLun(tree), `${when}: a backstore, not a LUN`)
        assert.deepEqual(health.unmappedBackstores?.map(b => [b.name, b.persisted, b.restoreMark ?? null]), [['newvol', true, row.mark ? 'interrupted' : null]])
        if (row.mark)
          assert.match(cards, /iSCSI backstore 'newvol' \(block, \/dev\/zvol\/tank\/newvol\) is not mapped as a LUN\. A whole-image restore \(its details could not be read\) onto backstore 'newvol' did not finish: it holds a partial image\./)
        else
          assert.match(cards, /is not mapped as a LUN\. A backstore no LUN maps holds this storage, and no restore mark is on it: ANAS cannot tell what it holds/)
        assert.match(cards, /'targetcli \/backstores\/block delete newvol'/)
        assert.match(cards, /'zfs destroy tank\/newvol'/)
        const held = pickHolder(claimsFromState(ctx, targets), { dataset: 'tank/newvol' })
        assert.equal(held?.unmapped, true)
      }
      else {
        assert.ok(isNewvolLun(tree), `${when}: the LUN is mapped`)
        const stream = halted.find(c => c.command === PBC)
        assert.equal(stream?.exitCode, 0, 'a mapped LUN only ever holds a complete image')
        assert.deepEqual(health.unmappedBackstores, [])
        assert.ok(!(health.restoreMarks ?? []).some(m => m.backstoreName === 'newvol'), 'and it is not marked')
      }
    }
    assert.equal(live.volumes.length, row.at === 0 ? 0 : 1, 'the volume exists from the first call on')
  }
})

describe('cr3.lunrestore — every failure, its sentence, and what it leaves (fault table, with the mark)', () => {
  const fail = (stderr: string) => ({ stdout: '', stderr, exitCode: 1 })
  const map = `/iscsi/${IQN}/tpg1/luns`
  const rows: {
    name: string
    over?: (m: MockExecutor) => void
    stream?: { stderr: string, exitCode: number, bytesWritten: number }
    deps?: (rec: { calls: RecordedCall[] }) => Partial<NewLunRestoreDeps>
    said: RegExp[]
    notSaid?: RegExp[]
    leaves: 'nothing' | 'backstore + backing' | 'backing only' | 'LUN'
    mark: boolean
    saved: boolean
  }[] = [
    { name: 'the backing create fails', over: m => m.addFixture({ command: ZFS, args: ['create', '-s', '-V', String(IMAGE_SIZE), '--', 'tank/newvol'], result: fail('dataset already exists') }), said: [/could not create the new volume tank\/newvol at the image's size: dataset already exists/], leaves: 'nothing', mark: false, saved: false },
    { name: 'the mark cannot be set (no mark, no write)', over: m => m.addFixture({ command: ZFS, argsMatch: a => a[0] === 'set', result: fail('permission denied') }), said: [/could not set the restore mark anas:restore on tank\/newvol: permission denied/, /ANAS has removed volume tank\/newvol, so nothing of the failed restore remains/], notSaid: [/backstore 'newvol'/], leaves: 'nothing', mark: false, saved: false },
    { name: 'the backstore create fails (a namesake is never deleted)', over: m => m.addFixture({ command: TARGETCLI, argsMatch: a => a[0] === '/backstores/block' && a[1] === 'create', result: fail('exists') }), said: [/ANAS has removed volume tank\/newvol, so nothing of the failed restore remains/], leaves: 'nothing', mark: false, saved: false },
    { name: 'an attribute set fails after the create', over: m => m.addFixture({ command: TARGETCLI, args: ['/backstores/block/newvol', 'set', 'attribute', 'emulate_tpws=1'], result: fail('Invalid argument') }), said: [/ANAS has removed backstore 'newvol', volume tank\/newvol/], leaves: 'nothing', mark: false, saved: false },
    { name: 'the stream fails part-way', stream: { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 }, said: [/partially written .*; it was never mapped as a LUN/, /ANAS has removed backstore 'newvol', volume tank\/newvol/], leaves: 'nothing', mark: false, saved: false },
    { name: 'the stream is killed (a stop signal reaching pbc)', stream: { stderr: '', exitCode: 143, bytesWritten: 4096 }, said: [/never mapped as a LUN/, /nothing of the failed restore remains/], leaves: 'nothing', mark: false, saved: false },
    { name: 'D3: the size re-read fails after exit 0 — kept, marked unverified, nothing destroyed', over: m => m.addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: fail('cannot open') }), said: [/^the client reported the image complete, but the size of \/dev\/zvol\/tank\/newvol could not be re-read \(.*cannot open\), so it was not mapped as a LUN\./, /keeps its restore mark, now saying the size was not verified/, /are kept, not mapped as a LUN/], notSaid: [/in full/, /removed/], leaves: 'backstore + backing', mark: true, saved: false },
    { name: 'D3: the size disagrees after exit 0 — both numbers, kept, marked', over: m => m.addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: { stdout: `${IMAGE_SIZE * 2}\n`, stderr: '', exitCode: 0 } }), said: [/\/dev\/zvol\/tank\/newvol is 1073741824 bytes, not the image's 536870912, so it was not mapped as a LUN/], notSaid: [/in full/], leaves: 'backstore + backing', mark: true, saved: false },
    { name: 'the mark cannot be removed after a verified image — kept, not mapped, the one command named', over: m => m.addFixture({ command: ZFS, argsMatch: a => a[0] === 'inherit', result: fail('busy') }), said: [/restored in full and its size verified, but could not remove the restore mark .*busy.*so it was not mapped as a LUN/, /'zfs inherit anas:restore tank\/newvol'/], leaves: 'backstore + backing', mark: true, saved: false },
    { name: 'the target is gone at the map (N2: never told to map into it)', deps: () => ({ refreshAfterCreate: async () => { throw new Error('iSCSI target \'x\' not found. This refusal has no confirm bypass.') } }), said: [/restored in full into \/dev\/zvol\/tank\/newvol, but it could not be mapped as a LUN: iSCSI target 'x' not found\. The backstore 'newvol'/, /cannot take it as it is \(above\): map it into a target ANAS manages with targetcli/], notSaid: [/luns create/, /no confirm bypass/, /\.\./], leaves: 'backstore + backing', mark: false, saved: false },
    { name: 'the map (luns create) fails', over: m => m.addFixture({ command: TARGETCLI, args: [map, 'create', 'storage_object=/backstores/block/newvol', 'lun=1'], result: fail('LUN busy') }), said: [/restored in full .*, but mapping it as a LUN on .* failed: .*LUN busy/, /are kept, not mapped as a LUN/], leaves: 'backstore + backing', mark: false, saved: false },
    { name: 'N1: the map reports a failure but landed — re-read, unmapped, said', over: m => m.addFixture({ command: TARGETCLI, args: [map, 'create', 'storage_object=/backstores/block/newvol', 'lun=1'], result: fail('timed out') }), deps: rec => ({ readLive: async () => ({ ctx: contextOf(replayLio(rec.calls, rec.calls.length, c => c.args[0] === map && c.args[1] === 'create'), null, SOURCE_BASE) }) }), said: [/failed: .*timed out/, /ANAS removed the partial mapping \(LUN 1\)/], leaves: 'backstore + backing', mark: false, saved: false },
    { name: 'an ACL grant fails after the map', over: m => m.addFixture({ command: TARGETCLI, args: [`/iscsi/${IQN}/tpg1/acls/${INITIATOR}`, 'create', '1', '1'], result: fail('acl gone') }), said: [/mapping it as a LUN .* failed: .*acl gone/, /ANAS removed the partial mapping \(LUN 1\)/, /are kept, not mapped as a LUN/], leaves: 'backstore + backing', mark: false, saved: false },
    {
      name: 'an ACL grant fails and the partial mapping cannot be removed',
      over: (m) => {
        m.addFixture({ command: TARGETCLI, args: [`/iscsi/${IQN}/tpg1/acls/${INITIATOR}`, 'create', '1', '1'], result: fail('acl gone') })
        m.addFixture({ command: TARGETCLI, args: [map, 'delete', 'lun1'], result: fail('busy') })
      },
      said: [/The partial mapping could not be removed .*busy.*: LUN 1 on .* serves the complete image but may not be granted to every initiator, and it is not saved/],
      leaves: 'LUN',
      mark: false,
      saved: false,
    },
    { name: 'the final save fails', over: m => m.addFixture({ command: TARGETCLI, args: ['saveconfig'], result: fail('disk full') }), said: [/the image was restored in full and LUN 1 \('newvol'\) on .* is live, but saving the iSCSI configuration failed: .*disk full/], leaves: 'LUN', mark: false, saved: false },
  ]

  for (const row of rows) {
    it(`${row.name}: ${row.leaves} is left, mark ${row.mark ? 'present' : 'absent'}, ${row.saved ? 'saved' : 'nothing saved'}`, async () => {
      await withRoot(async (root) => {
        const rec = recording(mockWith(row.over, row.stream))
        await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root, row.deps?.(rec)), () => {}), (err: Error) => {
          for (const re of row.said)
            assert.match(err.message, re)
          for (const re of row.notSaid ?? [])
            assert.doesNotMatch(err.message, re)
          assert.ok(!err.message.includes('undefined'), err.message)
          return true
        })
        assertNeverExposedHalf(rec.calls)
        const node = replayLio(rec.calls)
        assert.equal(node.saved !== null, row.saved, 'a save happened')
        const want = {
          'nothing': [false, false, 0],
          'backing only': [false, false, 1],
          'backstore + backing': [true, false, 1],
          'LUN': [true, true, 1],
        }[row.leaves]
        assert.deepEqual([hasNewvolBackstore(node), isNewvolLun(node), node.volumes.length], want, argv(rec.calls).join('\n'))
        assert.equal(node.marks.includes('tank/newvol'), row.mark, 'the mark column')
        // Nothing is destroyed after a stream that exited 0 (D3).
        const stream = rec.calls.find(c => c.command === PBC)
        if (stream?.exitCode === 0)
          assert.ok(!argv(rec.calls).some(a => a.startsWith(`${ZFS} destroy`) || a.includes('/backstores/block delete')), 'nothing destroyed after exit 0')
        if (row.name.startsWith('the backstore create fails'))
          assert.ok(!argv(rec.calls).some(a => a.includes('/backstores/block delete')), 'no delete of a backstore this run did not make')
      })
    })
  }
})

describe('cr3.lunrestore (D2/D4/N4/N8) — the cleanup deletes only what a re-read proves is this run\'s', () => {
  const enospc = { stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 268435456 }
  const run = async (over: (m: MockExecutor) => void, readLive: (rec: { calls: RecordedCall[] }) => IscsiReadContext, extra: (rec: { calls: RecordedCall[] }) => Partial<NewLunRestoreDeps> = () => ({})) => {
    let out!: { rec: ReturnType<typeof recording>, err: Error }
    await withRoot(async (root) => {
      const rec = recording(mockWith(over, enospc))
      const err = await runNewLunImageRestore(rec.executor, depsFor(rec, root, { readLive: async () => ({ ctx: readLive(rec) }), ...extra(rec) }), () => {}).then(() => new Error('resolved'), (e: Error) => e)
      out = { rec, err }
    })
    return out
  }

  it('D2: a backstore of that name made by hand meanwhile (another serial, another path) is NOT deleted; this run\'s volume, held by nothing, is', async () => {
    const { rec, err } = await run(() => {}, () => contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: '/dev/zvol/tank/handmade', wwn: 'hand-serial' }], luns: [] }, null, SOURCE_BASE))
    assert.ok(!argv(rec.calls).some(a => a.includes('/backstores/block delete')), 'the namesake is left')
    assert.ok(argv(rec.calls).includes(`${ZFS} destroy -- tank/newvol`))
    assert.match(err.message, /a backstore named 'newvol' that is not this restore's is in the live configuration \(backstore 'newvol' now carries the unit serial hand-serial.*\); ANAS left it as it is/)
    assert.doesNotMatch(err.message, /nothing of the failed restore remains/)
  })

  it('D2: a namesake by hand over THIS volume (another serial): not deleted, and the volume it holds is kept', async () => {
    const { rec, err } = await run(() => {}, () => contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 'hand-serial' }], luns: [] }, null, SOURCE_BASE))
    assert.ok(!argv(rec.calls).some(a => a.includes('/backstores/block delete') || a.startsWith(`${ZFS} destroy`)))
    assert.match(err.message, /volume tank\/newvol is kept, because backstore 'newvol' still holds it/)
  })

  it('D4: a backstore create that failed (timed out) AFTER taking effect is found by name + serial and removed', async () => {
    const created = (c: RecordedCall) => c.args[0] === '/backstores/block' && c.args[1] === 'create'
    const { rec, err } = await run(m => m.addFixture({ command: TARGETCLI, argsMatch: a => a[0] === '/backstores/block' && a[1] === 'create', result: { stdout: '', stderr: 'timed out', exitCode: 1 } }), rec => contextOf(replayLio(rec.calls, rec.calls.length, created), null, SOURCE_BASE))
    assert.ok(argv(rec.calls).includes(`${TARGETCLI} /backstores/block delete newvol`), 'found and removed')
    assert.match(err.message, /ANAS has removed backstore 'newvol', volume tank\/newvol, so nothing of the failed restore remains/)
  })

  it('a live tree that cannot be read: nothing deleted by name, the volume kept, and it says so', async () => {
    const { rec, err } = await run(() => {}, () => {
      throw new Error('configfs EIO')
    })
    assert.ok(!argv(rec.calls).some(a => a.includes('/backstores/block delete') || a.startsWith(`${ZFS} destroy`)))
    assert.match(err.message, /could not be read to prove which backstore is this restore's \(configfs EIO\), so ANAS deleted nothing/)
    assert.doesNotMatch(err.message, /nothing of the failed restore remains/)
  })

  it('N4: the save-away runs whenever this run\'s backstore was deleted — also when the volume destroy failed', async () => {
    const serialOf = (calls: RecordedCall[]) => (calls.find(c => c.args[0] === '/backstores/block' && c.args[1] === 'create')?.args.find(a => a.startsWith('wwn=')) ?? '').slice(4)
    const { rec, err } = await run(m => m.addFixture({ command: ZFS, args: ['destroy', '--', 'tank/newvol'], result: { stdout: '', stderr: 'dataset is busy', exitCode: 1 } }), rec => nodeOf(rec.calls).ctx, rec => ({ persistedBackstores: async () => [{ name: 'newvol', wwn: serialOf(rec.calls) }] }))
    assert.match(err.message, /volume tank\/newvol could not be destroyed \(dataset is busy\)/)
    assert.match(err.message, /the copy of it another iSCSI change had saved during the restore/)
    assert.equal(argv(rec.calls).at(-1), `${TARGETCLI} saveconfig`)
  })

  it('N8: a volume renamed by hand mid-stream — the cleanup says it is no longer at that name and where the image went', async () => {
    const { err } = await run(m => m.addFixture({ command: ZFS, args: ['destroy', '--', 'tank/newvol'], result: { stdout: '', stderr: 'cannot open \'tank/newvol\': dataset does not exist', exitCode: 1 } }), rec => nodeOf(rec.calls).ctx)
    assert.match(err.message, /volume tank\/newvol could not be destroyed \(it is no longer at that name .*renamed or destroyed by hand while the image was written; if it was renamed, the volume under its new name holds a partial image and carries the restore mark anas:restore\)/)
  })
})

describe('cr3.lunrestore (4) — the name and the index between the two lock holds', () => {
  const runWith = async (live: (rec: { calls: RecordedCall[] }) => IscsiReadContext) => {
    let out!: { rec: ReturnType<typeof recording>, err: Error | null }
    await withRoot(async (root) => {
      const rec = recording(mockWith())
      const err = await runNewLunImageRestore(rec.executor, depsFor(rec, root, {
        refreshAfterCreate: async () => targetObjectOf(targetDetail(), live(rec)),
      }), () => {}).then(() => null, (e: Error) => e)
      out = { rec, err }
    })
    return out
  }

  it('the backstore deleted by hand during the stream: not mapped, the volume kept, the name not touched', async () => {
    const { rec, err } = await runWith(rec => nodeWithout(rec.calls))
    assert.match(err?.message ?? '', /backstore 'newvol' is no longer in the live configuration/)
    assert.match(err?.message ?? '', /\/dev\/zvol\/tank\/newvol is kept; ANAS did not touch the backstore named 'newvol'/)
    assert.ok(!argv(rec.calls).some(a => a.includes('/luns create') || a.includes('saveconfig') || a.includes('delete')))
  })

  it('a backstore of the same name, recreated by hand with another serial: refused, never mapped over', async () => {
    const { rec, err } = await runWith(() => contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 'aaaaaaaa-0000-0000-0000-000000000000' }], luns: [] }, null, SOURCE_BASE))
    assert.match(err?.message ?? '', /now carries the unit serial aaaaaaaa-0000-0000-0000-000000000000, not the .* this restore created it with/)
    assert.ok(!argv(rec.calls).some(a => a.includes('/luns create')))
  })

  it('this run\'s backstore mapped by hand meanwhile: refused, naming the LUN', async () => {
    const { rec, err } = await runWith(rec => contextOf({ ...nodeOf(rec.calls).model, luns: [{ iqn: IQN, tag: 1, index: 7, backstore: 'newvol', plugin: 'block' }] }, null, SOURCE_BASE))
    assert.match(err?.message ?? '', /was mapped as LUN 7 of iqn\.2026-08\.nas\.anas:vmstore by something else/)
    assert.ok(!argv(rec.calls).some(a => a.includes('/luns create')))
  })

  it('the index the request saw was taken meanwhile: the map takes the lowest free index of the after-create read', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith())
      const result = await runNewLunImageRestore(rec.executor, depsFor(rec, root, {
        refreshAfterCreate: async () => targetObjectOf(targetDetail([1]), nodeOf(rec.calls).ctx),
      }), () => {})
      assert.equal(result.lunIndex, 2)
      assert.ok(argv(rec.calls).includes(`${TARGETCLI} /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/newvol lun=2`))
    })
  })

  it('lunNameFreeGate already counts an unmapped backstore of that name, live or saved (cr3 ISCSI-M5, confirmed)', async () => {
    const live = contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's' }], luns: [] }, null, SOURCE_BASE)
    const refused = await lunNameFreeGate('newvol')({ target: targetDetail(), state: { ctx: live, targets: [targetDetail()] } }, undefined as never)
    assert.equal(refused?.message, 'A backstore named \'newvol\' exists on this node and no LUN maps it. The name is the SCSI model string '
    + 'initiators see, so it has to be unique: pick another name, or remove that backstore with targetcli.')
  })
})

/** The node as the calls left it, minus this run's backstore (deleted by hand). */
function nodeWithout(calls: RecordedCall[]): IscsiReadContext {
  const m = replayLio(calls)
  return contextOf({ backstores: m.backstores.filter(b => b.name !== 'newvol'), luns: m.luns }, null, SOURCE_BASE)
}

describe('cr3.lunrestore (2c) — another verb\'s saveconfig during the stream persists only an UNMAPPED backstore', () => {
  it('saved mid-stream, then a reboot: the backstore comes back unmapped, health reports it, nothing degrades, Repair has nothing to do', async () => {
    await withRoot(async (root) => {
      const base = mockWith()
      // Park the run inside the stream (call 7), the window that used to hold a live, half-written LUN.
      const rec = recording(base, { haltAt: 7 })
      const run = runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {})
      run.catch(() => {})
      await rec.halted
      // Another iSCSI verb's save — it takes the mutex the stream does not hold.
      const other = recording(base)
      await withIscsiLock(async () => saveIscsiConfig(other.executor))
      const saved = replayLio([...rec.calls.slice(0, 7), ...other.calls]).saved!
      assert.ok(hasNewvolBackstore(saved), 'the save persisted the backstore')
      assert.ok(!isNewvolLun(saved), 'and NO LUN of it — never a half-written LUN')

      // Reboot: the kernel comes back with the saved tree (unproven on a node:
      // that targetctl restore recreates a storage object with no LUN, unmapped).
      const ctx = contextOf(saved, saved, SOURCE_BASE)
      const targets = await buildIscsiTargets(ctx)
      const health = computeIscsiHealth(ctx, targets)
      assert.equal(health.degraded, false)
      assert.deepEqual(health.missingLuns, [])
      assert.deepEqual(health.unmappedBackstores?.map(b => b.name), ['newvol'])
      assert.equal(assertSaveable(ctx, targets), null, 'it blocks no other iSCSI verb')
      const plan = planIscsiRepair(ctx, health, targets)
      assert.deepEqual([plan.repairable, plan.blocked], [[], []], 'Repair never turns it into a mapping')

      rec.resume()
      await run.catch(() => {})
    })
  })
})

describe('cr3.lunrestore (2a) — an unmapped backstore holds its backing, door by door', () => {
  // A zvol one (the restore's) and an image on an AHR pool (a file restore's),
  // both unmapped, on a node whose target has no LUN of its own.
  const ctx = contextOf({
    backstores: [
      { name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's1' },
      { name: 'img', plugin: 'fileio', dev: '/mnt/ahr1/images/img.raw', wwn: 's2' },
    ],
    luns: [],
  }, null, { iqn: IQN, tag: 1, backstores: [], luns: [] })
  ctx.inputs.ahrMountpoints = new Map([['ahr1', '/mnt/ahr1']])

  const doors: { door: string, subject: { pool?: string, dataset?: string, path?: string }, action: string, what: string, holder: string }[] = [
    { door: 'dataset destroy of the zvol', subject: { dataset: 'tank/newvol' }, action: 'Destroying', what: 'dataset \'tank/newvol\'', holder: 'newvol' },
    { door: 'recursive dataset destroy of its parent', subject: { dataset: 'tank' }, action: 'Destroying', what: 'dataset \'tank\' (recursive)', holder: 'newvol' },
    { door: 'snapshot rollback of the zvol', subject: { dataset: 'tank/newvol' }, action: 'Rolling back', what: 'dataset \'tank/newvol\' to snapshot \'s\'', holder: 'newvol' },
    { door: 'ZFS pool destroy / export', subject: { pool: 'tank' }, action: 'Destroying', what: 'pool \'tank\'', holder: 'newvol' },
    { door: 'AHR pool destroy / change-mount', subject: { pool: 'ahr1', path: '/mnt/ahr1' }, action: 'Destroying', what: 'AHR pool \'ahr1\'', holder: 'img' },
    { door: 'unmount of the mount the image sits under', subject: { path: '/mnt/ahr1' }, action: 'Unmounting', what: 'mount \'/mnt/ahr1\'', holder: 'img' },
    { door: 'a file restore into the image\'s directory', subject: { path: '/mnt/ahr1/images' }, action: 'Restoring files into', what: '\'/mnt/ahr1/images\'', holder: 'img' },
  ]
  for (const d of doors) {
    it(`${d.door}: refused, the sentence says it is a backstore not mapped as a LUN`, async () => {
      const held = pickHolder(claimsFromState(ctx, await buildIscsiTargets(ctx)), d.subject)
      assert.equal(held?.unmapped, true)
      assert.equal(held?.name, d.holder)
      assert.equal(held?.targetIqn, undefined)
      const msg = heldByLunRefusal(d.what, d.action, held!).message
      assert.match(msg, new RegExp(`is held by iSCSI backstore '${d.holder}' \\((block|fileio), .*\\), which is not mapped as a LUN`))
      assert.match(msg, new RegExp(`delete it with 'targetcli /backstores/(block|fileio) delete ${d.holder}'`))
      assert.match(msg, /no confirm bypass/)
      assert.ok(!/undefined|LUN \d/.test(msg), msg)
    })
  }

  it('volume rename / rollback / destroy refuse; a shrink refuses naming it; a GROW is refused too (D3 ruling, by the claim)', async () => {
    const held = pickHolder(claimsFromState(ctx, await buildIscsiTargets(ctx)), { dataset: 'tank/newvol' })
    const row = { name: 'tank/newvol', type: 'volume', volsize: IMAGE_SIZE } as never
    for (const op of ['rename', 'rollback', 'destroy'] as const)
      assert.match(assertVolumeMutable('tank/newvol', op, row, undefined, held)?.message ?? '', /not mapped as a LUN/)
    assert.match(assertVolumeMutable('tank/newvol', 'grow', row, { volsize: 4096 }, held)?.message ?? '', /SHRINK .*It is also held by iSCSI backstore 'newvol'/)
    assert.match(assertVolumeMutable('tank/newvol', 'grow', row, { volsize: IMAGE_SIZE * 2 }, held)?.message ?? '', /^Resizing volume 'tank\/newvol' is refused: it is held by iSCSI backstore 'newvol'/)
    // A grow of a volume a MAPPED LUN holds stays allowed (iscsi.3).
    const mapped = pickHolder(claimsFromState(contextOf({ backstores: [], luns: [] }, null, SOURCE_BASE), [targetDetail()]), { dataset: 'tank/vol1' })
    assert.equal(mapped?.unmapped, undefined)
    assert.equal(assertVolumeMutable('tank/vol1', 'grow', { name: 'tank/vol1', type: 'volume', volsize: IMAGE_SIZE } as never, { volsize: IMAGE_SIZE * 2 }, mapped), null)
  })

  it('a mapped LUN on the same pool is named first; the disclosure phrase never invents a LUN number', async () => {
    const both = contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's1' }], luns: [] }, null, SOURCE_BASE)
    const held = pickHolder(claimsFromState(both, await buildIscsiTargets(both)), { pool: 'tank' })
    assert.equal(held?.unmapped, undefined)
    assert.equal(held?.name, 'vmdisk1')
    assert.equal(heldHolderPhrase({ unmapped: true, name: 'newvol' }), 'iSCSI backstore \'newvol\', which is not mapped as a LUN')
    assert.equal(heldHolderPhrase({ name: 'vmdisk1', index: 0, targetIqn: IQN }), `iSCSI LUN 0 ('vmdisk1') of target ${IQN}`)
  })

  it('the AHR rewrite and reconcile disclosures name it as a backstore no initiator sees, never as a guest\'s live LUN', () => {
    const held = { unmapped: true as const, plugin: 'fileio', name: 'img', backingPath: '/mnt/ahr1/images/img.raw', connectedInitiators: [], detail: 'd' }
    for (const line of [...rewriteLunWarnings(held), ...reconcileLunWarnings(held)]) {
      assert.match(line, /held by iSCSI backstore 'img', which is not mapped as a LUN: no initiator can see it/)
      assert.ok(!/undefined|guest's disk is live/.test(line), line)
    }
  })

  it('a backstore on storage that is not ANAS\'s still HOLDS (a claim) but gets no health row (hands-off)', async () => {
    const raw = contextOf({ backstores: [{ name: 'byhand', plugin: 'block', dev: '/dev/sdz', wwn: 's9' }], luns: [] }, null, SOURCE_BASE)
    assert.equal(unmappedLiveBackstores(raw).length, 1)
    assert.ok(claimsFromState(raw, await buildIscsiTargets(raw)).some(c => c.unmapped === true && c.backingPath === '/dev/sdz'))
    assert.deepEqual(computeIscsiHealth(raw, await buildIscsiTargets(raw)).unmappedBackstores, [])
  })
})

describe('cr3.lunrestore (2b, N3, B2/B3) — health and dashboard read an unmapped backstore, and a mark, as what they are', () => {
  const ctx = contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's1' }], luns: [] }, null, SOURCE_BASE)
  const present = (mark: RestoreMark | null): RestoreMarkRead => ({ state: 'present', dataset: 'tank/newvol', raw: mark ? JSON.stringify(mark) : 'garbage', mark })
  const MARK: RestoreMark = { v: 1, repo: 'pbs-main', snapshot: SNAP, archive: 'vol.img', started: '2026-11-14T10:00:00.000Z', state: 'writing' }
  const healthWith = async (read: RestoreMarkRead | null, running?: string, c = ctx) =>
    computeIscsiHealth(c, await buildIscsiTargets(c), {
      marks: new Map(read ? [[NEWVOL, read]] : []),
      restoreRunning: p => (p === NEWVOL ? running : undefined),
    })

  it('N3: no mark — the neutral card: only what is known, zfs destroy for a zvol, no "content may be incomplete"', async () => {
    const health = await healthWith(null)
    assert.equal(health.degraded, false)
    assert.deepEqual(health.unmappedBackstores, [{ name: 'newvol', plugin: 'block', backingPath: NEWVOL, serial: 's1', persisted: false }])
    const cards = buildIscsiWarnings(health)
    assert.equal(cards.length, 1)
    assert.equal(cards[0].level, 'warning')
    assert.equal(cards[0].category, 'iscsi')
    assert.match(cards[0].message, /^iSCSI backstore 'newvol' \(block, \/dev\/zvol\/tank\/newvol\) is not mapped as a LUN\. A backstore no LUN maps holds this storage, and no restore mark is on it: ANAS cannot tell what it holds\./)
    assert.match(cards[0].message, /ANAS refuses to destroy, roll back, rename or resize tank\/newvol while the backstore exists/)
    assert.match(cards[0].message, /To remove it: 'targetcli \/backstores\/block delete newvol', then 'zfs destroy tank\/newvol' if you do not need the image\./)
    assert.doesNotMatch(cards[0].message, /content may be incomplete|delete \/dev\/zvol/)
    assert.ok(!cards[0].message.includes('\u2026'))
    assert.equal(assertSaveable(ctx, await buildIscsiTargets(ctx)), null)
  })

  it('a mark and no running restore: interrupted — the card names what was restored, since when, and that the image is partial', async () => {
    const health = await healthWith(present(MARK))
    assert.equal(health.unmappedBackstores?.[0].restoreMark, 'interrupted')
    assert.equal(health.restoreMarks?.[0].state, 'interrupted')
    const msg = buildIscsiWarnings(health)[0].message
    assert.match(msg, /is not mapped as a LUN\. A whole-image restore of vol\.img from host\/gtimgboth\/2026-08-25T19:28:38Z \(repository pbs-main\) started 2026-11-14T10:00:00\.000Z onto backstore 'newvol' did not finish: it holds a partial image\./)
    assert.match(msg, /To restore the image again: remove both, then restore it as a new LUN/)
  })

  it('a mark that does not parse is still a mark: "its details could not be read"', async () => {
    const msg = buildIscsiWarnings(await healthWith(present(null)))[0].message
    assert.match(msg, /A whole-image restore \(its details could not be read\) onto backstore 'newvol' did not finish/)
  })

  it('an unverified mark: written, size not verified, the way to accept it named', async () => {
    const msg = buildIscsiWarnings(await healthWith(present({ ...MARK, state: 'unverified', reason: 'zfs get failed' })))[0].message
    assert.match(msg, /wrote backstore 'newvol', and the client reported the image complete, but its size was not verified \(zfs get failed\): treat its content as unproven\./)
    assert.match(msg, /clear the mark \('zfs inherit anas:restore tank\/newvol'\)/)
  })

  it('a mark that could not be read is "unreadable", never "absent"', async () => {
    const health = await healthWith({ state: 'unknown', dataset: 'tank/newvol', reason: 'pool suspended' })
    assert.equal(health.unmappedBackstores?.[0].restoreMark, 'unreadable')
    assert.match(buildIscsiWarnings(health)[0].message, /ANAS could not read the restore mark on tank\/newvol/)
  })

  it('N5: a restore RUNNING onto it is progress — a row with the job, no card', async () => {
    const health = await healthWith(present(MARK), 'j-7')
    assert.equal(health.unmappedBackstores?.[0].restoreInFlight, 'job j-7')
    assert.equal(health.restoreMarks?.[0].state, 'in-progress')
    assert.deepEqual(buildIscsiWarnings(health), [])
  })

  // The in-place door: the target is disabled, LUN 0 carries the mark.
  const inPlace = contextOf({ backstores: [], luns: [] }, null, SOURCE_BASE)
  inPlace.live.targets[0].tpgs[0].enabled = false
  const VOL1 = '/dev/zvol/tank/vol1'
  const disabledHealth = async (read: RestoreMarkRead, running?: string) => {
    const targets = await buildIscsiTargets(inPlace)
    targets[0].ownership = 'anas'
    return computeIscsiHealth(inPlace, targets, { marks: new Map([[VOL1, read]]), restoreRunning: p => (p === VOL1 ? running : undefined) })
  }

  it('D5 a: a disabled target whose LUN a restore is writing says so and does NOT invite Enable', async () => {
    const health = await disabledHealth({ state: 'present', dataset: 'tank/vol1', raw: '{}', mark: MARK }, 'j-9')
    const msg = buildIscsiWarnings(health).map(w => w.message).join('\n')
    assert.match(msg, /is disabled — it is serving nothing.* A whole-image restore of vol\.img .* is writing LUN 0 \('vmdisk1'\) of .* right now \(job j-9\)\. Enable is refused until the restore ends\. When the restore ends, a target the restore disabled is enabled again only if the image is complete and its size verified, and put back as it was if the restore fails before writing anything and leaves the volume with no restore mark \(an earlier restore's mark, put back, keeps it disabled\); in every other case it stays disabled and the restore job says why\. A target the restore did not disable is left as it is\./)
    assert.doesNotMatch(msg, /re-enables the target when it finishes/)
    assert.doesNotMatch(msg, /Enable it from the iSCSI screen when you are ready/)
  })

  it('an interrupted in-place restore: the disabled card\'s reason comes from the mark, and names Enable\'s confirm', async () => {
    const msg = buildIscsiWarnings(await disabledHealth({ state: 'present', dataset: 'tank/vol1', raw: '{}', mark: MARK })).map(w => w.message).join('\n')
    assert.match(msg, /onto LUN 0 \('vmdisk1'\) of .* did not finish: it holds a partial image\. Enabling the target serves that image to initiators: Enable on the iSCSI screen asks you to confirm and removes the restore mark\. Restoring the image again is the other way out\./)
  })

  it('a marked LUN on an ENABLED target is critical: initiators are being served it', async () => {
    const on = contextOf({ backstores: [], luns: [] }, null, SOURCE_BASE)
    const targets = await buildIscsiTargets(on)
    const health = computeIscsiHealth(on, targets, { marks: new Map([[VOL1, { state: 'present', dataset: 'tank/vol1', raw: '{}', mark: MARK }]]), restoreRunning: () => undefined })
    const crit = buildIscsiWarnings(health).find(w => w.level === 'critical')
    assert.match(crit?.message ?? '', /holds a partial image\. Target .* is enabled, so initiators are being served that image now\./)
  })
})

describe('cr3.lunrestore (1) — the add-LUN door keeps its exact argv; the two halves are its two halves', () => {
  it('createAndMapLun = createLunBackstore + mapLunIntoTarget, byte for byte, in that order', async () => {
    await withRoot(async (root) => {
      const whole = recording(mockWith())
      await createAndMapLun({ executor: whole.executor, configfsRoot: root }, targetDetail(), 'newvol', { path: NEWVOL, plugin: 'block', dataset: 'tank/newvol' }, null, 'serial-1')
      const halves = recording(mockWith())
      await createLunBackstore({ executor: halves.executor, configfsRoot: root }, 'newvol', { path: NEWVOL, plugin: 'block', dataset: 'tank/newvol' }, null, 'serial-1')
      await mapLunIntoTarget({ executor: halves.executor, configfsRoot: root }, targetDetail(), 'newvol', 'block')
      assert.deepEqual(argv(whole.calls), argv(halves.calls))
      assert.deepEqual(argv(whole.calls), [
        `${TARGETCLI} /backstores/block create name=newvol dev=${NEWVOL} wwn=serial-1`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpu=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_tpws=1`,
        `${TARGETCLI} /backstores/block/newvol set attribute max_unmap_lba_count=524288`,
        `${TARGETCLI} /backstores/block/newvol set attribute emulate_write_cache=0`,
        `${TARGETCLI} /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/newvol lun=1`,
        `${TARGETCLI} /iscsi/${IQN}/tpg1/acls/${INITIATOR} create 1 1`,
      ])
    })
  })

  it('ownBackstoreRefusal passes this run\'s own unmapped backstore and nothing else', () => {
    const own = { name: 'newvol', plugin: 'block', backingPath: NEWVOL, serial: 'S' }
    const at = (b: { name: string, plugin: string, dev: string, wwn: string }) => ({ ctx: contextOf({ backstores: [b], luns: [] }, null, SOURCE_BASE) })
    assert.equal(ownBackstoreRefusal(at({ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 'S' }), own), null)
    assert.match(ownBackstoreRefusal(at({ name: 'newvol', plugin: 'block', dev: '/dev/zvol/tank/x', wwn: 'S' }), own) ?? '', /now points at \/dev\/zvol\/tank\/x/)
    assert.match(ownBackstoreRefusal(at({ name: 'newvol', plugin: 'fileio', dev: NEWVOL, wwn: 'S' }), own) ?? '', /no longer in the live configuration/)
  })
})

describe('cr3.lunrestore Part B — the restore mark reader (tri-state, plus "this kind carries none")', () => {
  const at = (stdout: string, exitCode = 0, stderr = '') => {
    const m = new MockExecutor()
    m.addFixture({ command: ZFS, args: restoreMarkGetArgs('tank/newvol'), result: { stdout, stderr, exitCode } })
    return readRestoreMark(m, { path: NEWVOL })
  }
  const VALUE = JSON.stringify({ v: 1, repo: 'r', snapshot: 's', archive: 'a.img', started: 't', state: 'writing' })

  it('a value set ON the volume (local, or received) is a mark; its details are validated', async () => {
    const local = await at(`${VALUE}\tlocal\n`)
    assert.equal(local.state, 'present')
    assert.equal(local.state === 'present' && local.mark?.archive, 'a.img')
    assert.equal((await at(`${VALUE}\treceived\n`)).state, 'present')
  })

  it('a value that does not parse is STILL a mark (its details unknown)', async () => {
    const r = await at('not json at all\tlocal\n')
    assert.equal(r.state, 'present')
    assert.equal(r.state === 'present' ? r.mark : 'x', null)
    const tooLong = await at(`${JSON.stringify({ v: 1, repo: 'r'.repeat(500), snapshot: 's', archive: 'a', started: 't', state: 'writing' })}\tlocal\n`)
    assert.equal(tooLong.state === 'present' ? tooLong.mark : 'x', null, 'bounded: an oversized field fails validation')
  })

  it('unset, or inherited from an ancestor, is absent — the mark is a fact about THIS object', async () => {
    assert.equal((await at('-\t-\n')).state, 'absent')
    assert.equal((await at(`${VALUE}\tinherited from tank\n`)).state, 'absent')
  })

  it('a volume that does not exist carries nothing; any other failed read is UNKNOWN, never absent', async () => {
    assert.equal((await at('', 1, 'cannot open \'tank/newvol\': dataset does not exist')).state, 'absent')
    const r = await at('', 1, 'cannot get property: pool I/O is currently suspended')
    assert.equal(r.state, 'unknown')
    assert.match(r.state === 'unknown' ? r.reason : '', /suspended/)
    assert.equal((await at('')).state, 'unknown', 'an exit 0 that printed nothing saw nothing')
  })

  it('an image FILE carries no mark: unsupported (the attr question is held for the operator)', async () => {
    assert.deepEqual(await readRestoreMark(new MockExecutor(), { path: '/tank/images/x.raw' }), { state: 'unsupported' })
  })

  it('the value written is the bounded JSON the reader validates, round trip', () => {
    const m = writingMark({ repo: 'pbs-main', namespace: 'ns', snapshot: SNAP, archive: 'vol.img' }, new Date('2026-11-14T10:00:00Z'))
    assert.deepEqual(decodeRestoreMark(encodeRestoreMark(m)), m)
    assert.equal(unverifiedMark(m, 'x'.repeat(900)).reason?.length, 512)
  })
})

describe('cr3.lunrestore N7 — the busy diagnosis names a backstore no LUN maps', () => {
  it('findUnmappedBackstoreHolder finds it by device or by a directory above a file; a mapped one is the LUN branch\'s', () => {
    const ctx = contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's' }, { name: 'img', plugin: 'fileio', dev: '/tank/images/img.raw', wwn: 't' }], luns: [] }, null, SOURCE_BASE)
    assert.deepEqual(findUnmappedBackstoreHolder(ctx.live, NEWVOL), { backstoreName: 'newvol', plugin: 'block', backingPath: NEWVOL })
    assert.equal(findUnmappedBackstoreHolder(ctx.live, '/tank/images')?.backstoreName, 'img')
    assert.equal(findUnmappedBackstoreHolder(ctx.live, '/dev/zvol/tank/vol1'), null, 'vol1 is mapped: not this branch')
    assert.equal(describeUnmappedHolder({ backstoreName: 'newvol', plugin: 'block', backingPath: NEWVOL }), `held by iSCSI backstore 'newvol' (block, ${NEWVOL}), which is not mapped as a LUN`)
  })
})

// ---------------------------------------------------------------------------
// The IN-PLACE path (review2): a node whose volumes keep their restore marks.
// ---------------------------------------------------------------------------

const VOL1 = '/dev/zvol/tank/vol1'
const OLD_MARK = JSON.stringify({ v: 1, repo: 'pbs-main', snapshot: 'host/x/2026-01-01T00:00:00Z', archive: 'vol.img', started: '2026-11-13T09:00:00.000Z', state: 'writing' })
const OLD_UNVERIFIED = JSON.stringify({ v: 1, repo: 'pbs-main', snapshot: 'host/x/2026-01-01T00:00:00Z', archive: 'vol.img', started: '2026-11-13T09:00:00.000Z', state: 'unverified', reason: 'size could not be re-read' })
const SUSPENDED = 'cannot get property: pool I/O is currently suspended'
const OK: ExecResult = { stdout: '', stderr: '', exitCode: 0 }

/**
 * Wrap an executor so the volumes keep their `anas:restore` marks: `zfs set`
 * stores the value verbatim, `zfs inherit` clears it, `zfs get` answers from it
 * — in the single form (`-o value,source -- <ds>`) and the batched one
 * (`-o name,value,source -- <ds>...`). `unreadable` datasets fail every read;
 * `failSet` refuses a set whose value it matches.
 */
function withMarks(base: CommandExecutor, initial: Record<string, string> = {}, opts: { unreadable?: Set<string>, failSet?: (raw: string) => boolean, failInherit?: boolean } = {}) {
  const marks = new Map(Object.entries(initial))
  const unreadable = opts.unreadable ?? new Set<string>()
  const executor: CommandExecutor = {
    async exec(command, args, o) {
      if (command === ZFS && args[0] === 'set' && (args[1] ?? '').startsWith('anas:restore=')) {
        const raw = args[1].slice('anas:restore='.length)
        if (opts.failSet?.(raw))
          return { stdout: '', stderr: 'cannot set property for \'tank/vol1\': pool I/O is currently suspended', exitCode: 1 }
        marks.set(args.at(-1)!, raw)
        return OK
      }
      if (command === ZFS && args[0] === 'inherit' && args[1] === 'anas:restore') {
        if (opts.failInherit)
          return { stdout: '', stderr: 'cannot inherit anas:restore: pool I/O is currently suspended', exitCode: 1 }
        marks.delete(args.at(-1)!)
        return OK
      }
      if (command === ZFS && args[0] === 'get' && args.includes('anas:restore')) {
        const datasets = args.slice(args.indexOf('--') + 1)
        if (datasets.some(d => unreadable.has(d)))
          return { stdout: '', stderr: SUSPENDED, exitCode: 1 }
        const named = args.includes('name,value,source')
        const rows = datasets.map((d) => {
          const v = marks.get(d)
          const row = v === undefined ? '-\t-' : `${v}\tlocal`
          return named ? `${d}\t${row}` : row
        })
        return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 }
      }
      return base.exec(command, args, o)
    },
    pipeline: (c1, a1, c2, a2, o) => base.pipeline(c1, a1, c2, a2, o),
    execToStream: (c, a, t, o) => base.execToStream(c, a, t, o),
  }
  return { executor, marks, unreadable }
}

/** A mock for the in-place path: targetcli ok, volsize = the image, the stream as given (or thrown). */
function inPlaceMock(stream: { stderr: string, exitCode: number, bytesWritten: number } | Error = { stderr: 'restore complete (512 MiB processed in 0.6s)    \n', exitCode: 0, bytesWritten: IMAGE_SIZE }, over: (m: MockExecutor) => void = () => {}): MockExecutor {
  const mock = new MockExecutor()
  over(mock)
  mock.addFixture({ command: ZFS, args: volsizeArgs('tank/vol1'), result: { stdout: `${IMAGE_SIZE}\n`, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: TARGETCLI, result: OK })
  mock.addFixture({ command: ZFS, result: OK })
  if (stream instanceof Error)
    mock.addStreamFixture({ command: PBC, throws: stream, result: { stderr: '', exitCode: 0, bytesWritten: 0 } })
  else
    mock.addStreamFixture({ command: PBC, result: stream })
  return mock
}

/** LUN 0 of the target, backed by a zvol (`/dev/zvol/...`) or an image file (any other path). */
function lunAt(path = VOL1): IscsiLun {
  const zvol = path.startsWith('/dev/zvol/')
  return { ...targetDetail().luns[0], name: 'vmdisk1', backingPath: path, kind: zvol ? 'zvol' : 'file', plugin: zvol ? 'block' : 'fileio', dataset: zvol ? path.slice('/dev/zvol/'.length) : 'tank/images' }
}

function inPlaceDeps(executor: CommandExecutor, opts: { enabled: boolean, path?: string }): ImageRestoreDeps {
  const lun = lunAt(opts.path)
  const tgt = { ...targetDetail(), enabled: opts.enabled, luns: [lun] }
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
    readSessions: async () => [],
    reverify: async () => ({ target: tgt, lun, size: IMAGE_SIZE }),
    mutate: { executor },
  }
}

const enabledBy = (calls: RecordedCall[]) => argv(calls).includes(`${TARGETCLI} /iscsi/${IQN}/tpg1 enable`)
const disabledBy = (calls: RecordedCall[]) => argv(calls).includes(`${TARGETCLI} /iscsi/${IQN}/tpg1 disable`)

/** The Enable door's verdict on the node now (no restore running: the job ended). */
async function enableVerdictOn(executor: CommandExecutor, path = VOL1): Promise<string> {
  const v = enableMarkVerdict(IQN, [{ index: 0, name: 'vmdisk1', backingPath: path, read: await readRestoreMark(executor, { path }) }])
  return v.kind === 'refuse' ? `refuse(${v.reason})` : v.kind
}

/** PBS refused the connection: the CAPTURED stderr (restore-failure-taxonomy.txt F10, review3 3 — never a typed one). */
const REFUSED_STREAM = { stderr: 'Error: client error (Connect)\n\nCaused by:\n    error connecting to https://pbs.example:8007/ - tcp connect error: Connection refused (os error 111)\n', exitCode: 255, bytesWritten: 0 }

describe('cr3.lunrestore review2 (1, defect A) — a run that writes nothing leaves the mark it found', () => {
  it('an EARLIER interrupted restore\'s mark is put back exactly; the target it left disabled stays disabled; Enable still asks', async () => {
    const node = withMarks(inPlaceMock(REFUSED_STREAM), { 'tank/vol1': OLD_MARK })
    const rec = recording(node.executor)
    assert.equal(await enableVerdictOn(node.executor), 'confirm')
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: false }), () => {}), (err: Error) => {
      assert.match(err.message, /The PBS server could not be reached \(the connection was refused\)\. Nothing was written to \/dev\/zvol\/tank\/vol1\./)
      assert.match(err.message, /tank\/vol1 carries the restore mark of a whole-image restore of vol\.img from host\/x\/2026-01-01T00:00:00Z \(repository pbs-main\) started 2026-11-13T09:00:00\.000Z again, as it did before this restore: the LUN holds that restore's image, so target .* stays disabled\. Enable on the iSCSI screen asks you to confirm/)
      return true
    })
    assert.equal(node.marks.get('tank/vol1'), OLD_MARK, 'the earlier value, byte for byte')
    assert.ok(!enabledBy(rec.calls), 'nothing enabled')
    assert.equal(await enableVerdictOn(node.executor), 'confirm')
  })

  it('an earlier UNVERIFIED mark is put back exactly too (A2)', async () => {
    const node = withMarks(inPlaceMock({ stderr: 'Error: permission check failed.\n', exitCode: 1, bytesWritten: 0 }), { 'tank/vol1': OLD_UNVERIFIED })
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: false }), () => {}))
    assert.equal(node.marks.get('tank/vol1'), OLD_UNVERIFIED)
    assert.equal(await enableVerdictOn(node.executor), 'confirm')
  })

  it('a target that was ENABLED over an earlier mark (by hand) is disabled for the run and NOT re-enabled over the earlier image', async () => {
    const node = withMarks(inPlaceMock(REFUSED_STREAM), { 'tank/vol1': OLD_MARK })
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), /stays disabled/)
    assert.ok(disabledBy(rec.calls))
    assert.ok(!enabledBy(rec.calls), 'ANAS does not serve the earlier partial image')
    assert.equal(node.marks.get('tank/vol1'), OLD_MARK)
  })

  it('a mark that cannot be put back keeps the target disabled and says the volume carries this restore\'s mark', async () => {
    const node = withMarks(inPlaceMock(REFUSED_STREAM), { 'tank/vol1': OLD_MARK }, { failSet: raw => raw === OLD_MARK })
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.match(err.message, /could not put back the restore mark anas:restore on tank\/vol1: .*suspended \(the mark of a whole-image restore of vol\.img .*\): tank\/vol1 carries this restore's mark instead, so it still reads as holding a partial image and target .* stays disabled\./)
      return true
    })
    assert.ok(!enabledBy(rec.calls))
    assert.equal(JSON.parse(node.marks.get('tank/vol1')!).started === '2026-11-13T09:00:00.000Z', false, 'this run\'s mark')
  })

  it('no mark before: the run removes only its own mark and re-enables what it disabled', async () => {
    const node = withMarks(inPlaceMock(REFUSED_STREAM))
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), /Nothing was written to \/dev\/zvol\/tank\/vol1\.$/)
    assert.equal(node.marks.has('tank/vol1'), false)
    assert.ok(enabledBy(rec.calls))
  })

  it('a mark that cannot be READ refuses the restore before anything is disabled or written', async () => {
    const node = withMarks(inPlaceMock(), { 'tank/vol1': OLD_MARK }, { unreadable: new Set(['tank/vol1']) })
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.match(err.message, /^ANAS could not read the restore mark anas:restore on tank\/vol1 \(.*suspended\), so it cannot keep the record an earlier restore may have left there\. The restore is refused until the mark can be read\. Nothing was disabled and nothing was written\.$/)
      return true
    })
    assert.ok(!disabledBy(rec.calls))
    assert.ok(!rec.calls.some(c => c.command === PBC || (c.command === ZFS && c.args[0] === 'set')))
  })

  it('a mark that IS there never refuses the restore: restoring again is the way out (and its success removes the mark)', async () => {
    const node = withMarks(inPlaceMock(), { 'tank/vol1': OLD_MARK })
    const rec = recording(node.executor)
    const result = await runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: false }), () => {})
    assert.equal(result.complete, true)
    assert.equal(node.marks.has('tank/vol1'), false)
  })
})

describe('cr3.lunrestore review2 (2, defect B) — a stream that rejects: only "never started" restores the previous state', () => {
  const codeOf = (err: Error) => (err as Error & { jobErrorCode?: string }).jobErrorCode

  it('in place: the stream exits 0 but the flush REJECTS — the target stays disabled, the mark turns unverified with the reason', async () => {
    const node = withMarks(inPlaceMock(new StreamFlushError('EIO: i/o error, fsync', 0)))
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.match(err.message, /^the client exited 0, but flushing \/dev\/zvol\/tank\/vol1 to the medium failed \(EIO: i\/o error, fsync\): how much of the image is on the medium is not known\. Target .* stays disabled and the restore mark on tank\/vol1 now says the image was not verified\. Enable on the iSCSI screen asks you to confirm/)
      assert.doesNotMatch(err.message, /could not be started/)
      assert.equal(codeOf(err), 'IMAGE_UNVERIFIED')
      return true
    })
    assert.ok(!enabledBy(rec.calls), 'never re-enabled over an image not proven on the medium')
    assert.equal(JSON.parse(node.marks.get('tank/vol1')!).state, 'unverified')
    assert.equal(await enableVerdictOn(node.executor), 'confirm')
  })

  it('in place: any other rejection (the executor lost the child) — unknown amount written: disabled, mark kept as writing', async () => {
    const node = withMarks(inPlaceMock(new Error('EIO: i/o error, fsync')))
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.match(err.message, /^the image restore into \/dev\/zvol\/tank\/vol1 ended without a result from the client \(EIO: i\/o error, fsync\): how much of the image reached it is not known\. Target .* stays disabled and the restore mark on tank\/vol1 stays\./)
      assert.equal(codeOf(err), 'IMAGE_PARTIAL')
      return true
    })
    assert.ok(!enabledBy(rec.calls))
    assert.equal(JSON.parse(node.marks.get('tank/vol1')!).state, 'writing')
  })

  it('in place: the executor proves the client NEVER started — "could not be started", nothing written, the previous state comes back', async () => {
    const node = withMarks(inPlaceMock(new StreamNotStartedError('spawn /usr/bin/proxmox-backup-client ENOENT')))
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.equal(err.message, 'proxmox-backup-client could not be started: spawn /usr/bin/proxmox-backup-client ENOENT. Nothing was written to /dev/zvol/tank/vol1.')
      assert.equal(codeOf(err), undefined)
      return true
    })
    assert.equal(node.marks.has('tank/vol1'), false)
    assert.ok(enabledBy(rec.calls), 'what it disabled is enabled again')
  })

  it('in place: never started over an EARLIER mark — that mark comes back, the target stays disabled', async () => {
    const node = withMarks(inPlaceMock(new StreamNotStartedError('spawn /usr/bin/proxmox-backup-client ENOENT')), { 'tank/vol1': OLD_MARK })
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), /could not be started: .*Nothing was written to \/dev\/zvol\/tank\/vol1\. tank\/vol1 carries the restore mark of .* again/)
    assert.equal(node.marks.get('tank/vol1'), OLD_MARK)
    assert.ok(!enabledBy(rec.calls))
  })

  for (const c of [
    { name: 'killed before its first progress line (a signal, no bytes counted)', stream: { stderr: '', exitCode: 1, bytesWritten: 0, signal: 'SIGKILL' }, nothing: false },
    { name: 'an unclassified error and no progress', stream: { stderr: 'Error: something went wrong\n', exitCode: 1, bytesWritten: 0 }, nothing: false },
    { name: 'a dropped connection and no progress', stream: { stderr: 'Error: broken pipe\n', exitCode: 1, bytesWritten: 0 }, nothing: false },
    { name: 'PBS refused the connection (before any data)', stream: REFUSED_STREAM, nothing: true },
    { name: 'the snapshot does not exist (before any data)', stream: { stderr: 'Error: snapshot host/x/2026 does not exist.\n', exitCode: 255, bytesWritten: 0 }, nothing: true },
  ]) {
    it(`in place, exit != 0 with no byte counted — ${c.name}: ${c.nothing ? 'nothing written, re-enabled' : 'NOT proof of nothing: disabled, mark kept'}`, async () => {
      const node = withMarks(inPlaceMock(c.stream))
      const rec = recording(node.executor)
      await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
        if (c.nothing) {
          assert.match(err.message, /Nothing was written to \/dev\/zvol\/tank\/vol1\.$/)
        }
        else {
          assert.match(err.message, /^the restore failed before the client reported any progress, so how much of the image reached \/dev\/zvol\/tank\/vol1 is not known \(possibly none\); the LUN is disabled/)
          assert.doesNotMatch(err.message, /Nothing was written/)
          assert.equal(codeOf(err), 'IMAGE_PARTIAL')
        }
        return true
      })
      assert.equal(enabledBy(rec.calls), c.nothing)
      assert.equal(node.marks.has('tank/vol1'), !c.nothing)
    })
  }

  it('new LUN: the flush REJECTS after exit 0 — nothing is destroyed; kept unmapped, mark unverified, the way to serve it clears the mark first', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith(m => m.addStreamFixture({ command: PBC, throws: new StreamFlushError('EIO: i/o error, fsync', 0), result: { stderr: '', exitCode: 0, bytesWritten: 0 } })))
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {}), (err: Error) => {
        assert.match(err.message, /^the client exited 0, but flushing \/dev\/zvol\/tank\/newvol to the medium failed \(EIO: i\/o error, fsync\), so it was not mapped as a LUN: how much of the image is on the medium is not known\. tank\/newvol keeps its restore mark, now saying the image was not verified/)
        assert.match(err.message, /If you have checked the image and want to serve it, clear the restore mark with 'zfs inherit anas:restore tank\/newvol', then map it with 'targetcli /)
        assert.equal(codeOf(err), 'IMAGE_UNVERIFIED')
        return true
      })
      const node = replayLio(rec.calls)
      assert.deepEqual([hasNewvolBackstore(node), isNewvolLun(node), node.volumes.length], [true, false, 1], 'kept, unmapped, nothing destroyed')
      assert.ok(node.marks.includes('tank/newvol'))
      assertNeverExposedHalf(rec.calls)
    })
  })

  it('new LUN: any other rejection — kept unmapped with its writing mark, and told to delete it (it may be partial), never to map it', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith(m => m.addStreamFixture({ command: PBC, throws: new Error('EIO: i/o error, fsync'), result: { stderr: '', exitCode: 0, bytesWritten: 0 } })))
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {}), (err: Error) => {
        assert.match(err.message, /^the image restore into the new backing \/dev\/zvol\/tank\/newvol ended without a result from the client \(EIO: i\/o error, fsync\), so it was not mapped as a LUN: how much of the image reached it is not known\. tank\/newvol keeps its restore mark/)
        assert.match(err.message, /It may hold a partial image: delete it with 'targetcli \/backstores\/block delete newvol', then 'zfs destroy tank\/newvol', and restore the image again\.$/)
        assert.doesNotMatch(err.message, /luns create|could not be started/)
        assert.equal(codeOf(err), 'IMAGE_PARTIAL')
        return true
      })
      const node = replayLio(rec.calls)
      assert.deepEqual([hasNewvolBackstore(node), isNewvolLun(node), node.volumes.length], [true, false, 1])
      assert.ok(node.marks.includes('tank/newvol'))
    })
  })

  it('new LUN: never started — undone, and it says so', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith(m => m.addStreamFixture({ command: PBC, throws: new StreamNotStartedError('spawn /usr/bin/proxmox-backup-client ENOENT'), result: { stderr: '', exitCode: 0, bytesWritten: 0 } })))
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {}), /proxmox-backup-client could not be started: spawn .*ENOENT\. Nothing was written to the new backing \/dev\/zvol\/tank\/newvol\. .*nothing of the failed restore remains/)
      const node = replayLio(rec.calls)
      assert.deepEqual([hasNewvolBackstore(node), node.volumes.length], [false, 0])
    })
  })

  it('new LUN: exit != 0 with no progress and an unclassified error — undone (never complete), and the sentence does not claim nothing was written', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith(undefined, { stderr: 'Error: something went wrong\n', exitCode: 1, bytesWritten: 0 }))
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {}), (err: Error) => {
        assert.match(err.message, /^the restore failed before the client reported any progress, so how much of the image reached the new backing \/dev\/zvol\/tank\/newvol is not known \(possibly none\); it was never mapped as a LUN\./)
        assert.doesNotMatch(err.message, /Nothing was written/)
        return true
      })
      assert.equal(replayLio(rec.calls).volumes.length, 0)
    })
  })
})

/** An image file of `size` bytes (sparse) under `root`. */
async function imageFile(root: string, size: number, name = 'vmdisk2.raw'): Promise<string> {
  const path = join(root, name)
  await writeFile(path, '')
  await truncate(path, size)
  return path
}

describe('cr3.lunrestore review2 (3, defect C) — an in-place restore onto a FILE LUN verifies the size like a zvol', () => {
  const codeOf = (err: Error) => (err as Error & { jobErrorCode?: string }).jobErrorCode

  it('exit 0, the image file is the WRONG size afterwards: the target stays disabled, the job fails with both numbers', async () => {
    await withRoot(async (root) => {
      const path = await imageFile(root, IMAGE_SIZE / 2)
      const rec = recording(inPlaceMock())
      await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true, path }), () => {}), (err: Error) => {
        assert.equal(err.message, `the client reported the image complete, but ${path} is 268435456 bytes, not the image's 536870912: target ${IQN} stays disabled. `
        + 'Enable on the iSCSI screen asks you to confirm that you accept it while ANAS keeps this job\'s record; an image file carries no '
        + 'restore mark, so the record is lost when the ANAS daemon restarts, or when the daemon holds more than 100 such records and more than 1000 jobs '
        + `(the oldest record goes first). To restore the image again in place, first set ${path} to the image's 536870912 bytes with 'truncate -s 536870912 ${path}' `
        + '(the in-place restore refuses a file of any other size, and a failed restore can leave the file shorter); deleting this LUN and restoring the image as a new LUN is the other way out.')
        assert.equal(codeOf(err), 'IMAGE_UNVERIFIED')
        return true
      })
      assert.ok(disabledBy(rec.calls))
      assert.ok(!enabledBy(rec.calls), 'never re-enabled over a file of the wrong size')
    })
  })

  it('exit 0, the image file cannot be re-read: the target stays disabled, the job fails with the read error', async () => {
    await withRoot(async (root) => {
      const path = join(root, 'gone.raw')
      const rec = recording(inPlaceMock())
      await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true, path }), () => {}), (err: Error) => {
        assert.match(err.message, /^the client reported the image complete, but the size of .*gone\.raw could not be re-read \(could not read the size of image file '.*gone\.raw': ENOENT.*\): target .* stays disabled\./)
        assert.equal(codeOf(err), 'IMAGE_UNVERIFIED')
        return true
      })
      assert.ok(!enabledBy(rec.calls))
    })
  })

  it('exit 0 and the size is the image\'s: the target is enabled again, the restore complete', async () => {
    await withRoot(async (root) => {
      const path = await imageFile(root, IMAGE_SIZE)
      const rec = recording(inPlaceMock())
      const result = await runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true, path }), () => {})
      assert.equal(result.complete, true)
      assert.equal(result.targetReEnabled, true)
      assert.ok(enabledBy(rec.calls))
    })
  })
})

describe('cr3.lunrestore review2 (4, defect D) — an image FILE carries no mark: what the job records can close', () => {
  const FILE = '/tank/images/lun2.raw'
  const user = { user: 'root@pam', uid: 0 }

  /** Run a job to its end on `queue`; `fail` = the error (with its code) the body throws. */
  async function ran(queue: JobQueue, operation: string, params: Record<string, unknown>, fail?: { message: string, code?: string }): Promise<string> {
    const ref = queue.submit(operation, { ...user, params }, async () => {
      if (fail)
        throw Object.assign(new Error(fail.message), fail.code ? { jobErrorCode: fail.code } : {})
      return {}
    })
    for (let i = 0; i < 200 && !['completed', 'failed'].includes(queue.get(ref.id)?.status ?? ''); i++)
      await new Promise(resolve => setTimeout(resolve, 2))
    return ref.id
  }
  const restoreOnto = (path: string) => ({ backing: path, target: IQN, lun: 1 })

  it('a failed restore whose code says partial or unverified is remembered for that backing; a nothing-written failure and a success are not', async () => {
    const queue = new JobQueue()
    const jobs = restoreJobsOf(queue)
    const p = await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'partial', code: 'IMAGE_PARTIAL' })
    assert.deepEqual(jobs.restoreFailed(FILE, IQN), { job: p, outcome: 'partial' })
    const u = await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'unverified', code: 'IMAGE_UNVERIFIED' })
    assert.deepEqual(jobs.restoreFailed(FILE, IQN), { job: u, outcome: 'unverified' }, 'the LAST one that ran')
    await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'refused before any byte' })
    assert.deepEqual(jobs.restoreFailed(FILE, IQN), { job: u, outcome: 'unverified' }, 'review3 1: a run that wrote nothing (JOB_FAILED) does not supersede the unverified image')
    await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'partial', code: 'IMAGE_PARTIAL' })
    await ran(queue, 'backup.restore.image', restoreOnto(FILE))
    assert.equal(jobs.restoreFailed(FILE, IQN), undefined, 'a complete restore supersedes it')
    assert.equal(jobs.restoreFailed('/tank/images/other.raw', IQN), undefined, 'per backing')
  })

  it('an Enable of the target that COMPLETED after the failure accepted it (that Enable went through the confirm); one before it did not', async () => {
    const queue = new JobQueue()
    const jobs = restoreJobsOf(queue)
    await ran(queue, 'iscsi.target.enable', { target: IQN })
    await new Promise(resolve => setTimeout(resolve, 3))
    const p = await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'partial', code: 'IMAGE_PARTIAL' })
    assert.deepEqual(jobs.restoreFailed(FILE, IQN), { job: p, outcome: 'partial' })
    await new Promise(resolve => setTimeout(resolve, 3))
    await ran(queue, 'iscsi.target.enable', { target: IQN })
    assert.equal(jobs.restoreFailed(FILE, IQN), undefined)
    assert.deepEqual(jobs.restoreFailed(FILE), { job: p, outcome: 'partial' }, 'an unmapped backstore (no target) has no Enable to accept it')
  })

  it('review3 1: the last CODED failure stands until a later completed restore or a later Enable; uncoded failures never supersede it', async () => {
    const queue = new JobQueue()
    const jobs = restoreJobsOf(queue)
    const u = await ran(queue, 'backup.restore.image', { ...restoreOnto(FILE), imageBytes: IMAGE_SIZE }, { message: 'flush failed', code: 'IMAGE_UNVERIFIED' })
    for (const message of ['open EACCES: nothing written', 'refused: the size changed while the job waited', 'the repository secret could not be read'])
      await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message })
    assert.deepEqual(jobs.restoreFailed(FILE, IQN), { job: u, outcome: 'unverified', imageBytes: IMAGE_SIZE }, 'three uncoded failures later, the unverified image still stands')
    const p = await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'partial', code: 'IMAGE_PARTIAL' })
    assert.deepEqual(jobs.restoreFailed(FILE, IQN), { job: p, outcome: 'partial' }, 'a later coded failure replaces it')
    await ran(queue, 'backup.restore.image', restoreOnto(FILE))
    await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'refused before any byte' })
    assert.equal(jobs.restoreFailed(FILE, IQN), undefined, 'a later complete restore cleared it; the uncoded failure after it adds nothing')
  })

  it('review3 1 (p1-seq "flush > neverOpen"): an unverified file image, then a restore whose open fails — Enable still asks, never clear', async () => {
    await withRoot(async (root) => {
      const path = await imageFile(root, IMAGE_SIZE)
      const queue = new JobQueue()
      const runIn = async (executor: CommandExecutor, enabled: boolean) => {
        const ref = queue.submit('backup.restore.image', { ...user, params: { ...restoreOnto(path), imageBytes: IMAGE_SIZE } }, async () => runImageRestore(executor, inPlaceDeps(executor, { enabled, path }), () => {}))
        for (let i = 0; i < 500 && !['completed', 'failed'].includes(queue.get(ref.id)?.status ?? ''); i++)
          await new Promise(resolve => setTimeout(resolve, 2))
        return queue.get(ref.id)!
      }
      const first = await runIn(inPlaceMock(new StreamFlushError('EIO: i/o error, fsync', 0)), true)
      assert.equal(first.error?.code, 'IMAGE_UNVERIFIED')
      const second = await runIn(inPlaceMock(new StreamNotStartedError(`EACCES: permission denied, open '${path}'`)), false)
      assert.equal(second.error?.code, 'JOB_FAILED', 'the open failed: nothing written, no code')
      const facts = await readLunMarks(new MockExecutor(), [{ index: 0, name: 'vmdisk1', backingPath: path }], { ...restoreJobsOf(queue), targetIqn: IQN })
      const v = enableMarkVerdict(IQN, facts)
      assert.equal(v.kind, 'confirm', 'the unverified image from the first run is still behind the confirm')
      assert.match(v.kind === 'confirm' ? v.warnings[0] : '', new RegExp(`job ${first.id} onto .* ended with the client reporting the image complete, but ANAS could not verify it`))
    })
  })

  it('review3 1 (p4): eviction keeps the standing record of a file LUN past maxRetained, so five unrelated jobs do not turn confirm into clear', async () => {
    const queue = new JobQueue({ maxRetained: 5 })
    queue.pinWhile(imageRestorePin(queue))
    const p = await ran(queue, 'backup.restore.image', restoreOnto(FILE), { message: 'partial', code: 'IMAGE_PARTIAL' })
    for (let i = 0; i < 8; i++)
      await ran(queue, 'dataset.snapshot.create', { name: `tank/x@s${i}` })
    assert.ok(queue.get(p), 'pinned: not evicted')
    assert.deepEqual(restoreJobsOf(queue).restoreFailed(FILE, IQN), { job: p, outcome: 'partial' })
    const facts = await readLunMarks(new MockExecutor(), [{ index: 1, name: 'lun2', backingPath: FILE }], { ...restoreJobsOf(queue), targetIqn: IQN })
    assert.equal(enableMarkVerdict(IQN, facts).kind, 'confirm')
  })

  it('review3 1: what is NOT pinned — a superseded failure, a zvol\'s (its mark is on the volume), an uncoded failure; and the bound drops the oldest pinned first', async () => {
    const queue = new JobQueue({ maxRetained: 3, maxPinned: 2 })
    queue.pinWhile(imageRestorePin(queue))
    const superseded = await ran(queue, 'backup.restore.image', restoreOnto('/tank/images/a.raw'), { message: 'partial', code: 'IMAGE_PARTIAL' })
    await ran(queue, 'backup.restore.image', restoreOnto('/tank/images/a.raw'))
    const zvol = await ran(queue, 'backup.restore.image', restoreOnto('/dev/zvol/tank/vol9'), { message: 'partial', code: 'IMAGE_PARTIAL' })
    const uncoded = await ran(queue, 'backup.restore.image', restoreOnto('/tank/images/b.raw'), { message: 'refused' })
    const f1 = await ran(queue, 'backup.restore.image', restoreOnto('/tank/images/f1.raw'), { message: 'partial', code: 'IMAGE_PARTIAL' })
    const f2 = await ran(queue, 'backup.restore.image', restoreOnto('/tank/images/f2.raw'), { message: 'partial', code: 'IMAGE_PARTIAL' })
    const f3 = await ran(queue, 'backup.restore.image', restoreOnto('/tank/images/f3.raw'), { message: 'partial', code: 'IMAGE_PARTIAL' })
    for (let i = 0; i < 6; i++)
      await ran(queue, 'dataset.snapshot.create', { name: `tank/x@s${i}` })
    assert.deepEqual([superseded, zvol, uncoded].map(id => queue.get(id) !== undefined), [false, false, false], 'evicted like any finished job')
    assert.deepEqual([f1, f2, f3].map(id => queue.get(id) !== undefined), [false, true, true], 'three pinned, the bound is two: the oldest goes')
    assert.equal(restoreJobsOf(queue).restoreFailed('/tank/images/f1.raw', IQN), undefined, 'past the bound the record is lost (JOB_RECORD_ONLY says when)')
    assert.match(JOB_RECORD_ONLY, /the record is lost when the ANAS daemon restarts, or when the daemon holds more than 100 such records and more than 1000 jobs \(the oldest record goes first\)$/)
  })

  it('review3 2: the Enable confirm and the add-initiator refusal for a FILE record name the truncate a restore in place needs; a zvol\'s keep "restore again"', async () => {
    const record = { job: 'j-9', outcome: 'partial' as const, imageBytes: IMAGE_SIZE }
    const fileFact = { index: 1, name: 'lun2', backingPath: FILE, read: { state: 'unsupported' as const }, record }
    const zvolFact = { index: 0, name: 'vmdisk1', backingPath: VOL1, read: { state: 'present' as const, dataset: 'tank/vol1', raw: OLD_MARK, mark: decodeRestoreMark(OLD_MARK) } }
    const v = enableMarkVerdict(IQN, [zvolFact, fileFact])
    assert.equal(v.kind, 'confirm')
    const [zw, fw] = v.kind === 'confirm' ? v.warnings : []
    assert.match(zw, /Confirming removes the restore mark; restoring the image again is the other way out\.$/)
    assert.ok(fw.endsWith(`To restore the image again in place, first set ${FILE} to the image's ${IMAGE_SIZE} bytes with 'truncate -s ${IMAGE_SIZE} ${FILE}' `
      + '(the in-place restore refuses a file of any other size, and a failed restore can leave the file shorter); deleting this LUN and restoring the image as a new LUN is the other way out.'), fw)
    assert.doesNotMatch(fw, /Restoring the image again is the other way out/)
    const refused = restoreMarkRefusal(fileFact.read, `LUN 1 ('lun2') of ${IQN}`, 'Adding an initiator to this target', { mark: 'M.', job: 'J.' }, fileFact)
    assert.ok(refused?.message.endsWith(` J. To restore the image again in place, first set ${FILE} to the image's ${IMAGE_SIZE} bytes with 'truncate -s ${IMAGE_SIZE} ${FILE}' `
      + '(the in-place restore refuses a file of any other size, and a failed restore can leave the file shorter); deleting this LUN and restoring the image as a new LUN is the other way out.'), refused?.message)
  })

  it('review3 2: the disabled-target card over a volume mark AND a file record says "restoring again" only for the volume; the file row says what it needs', async () => {
    const ctx = contextOf({ backstores: [{ name: 'lun2', plugin: 'fileio', dev: FILE, wwn: 's2' }], luns: [{ iqn: IQN, tag: 1, index: 1, backstore: 'lun2', plugin: 'fileio' }] }, null, SOURCE_BASE)
    ctx.live.targets[0].tpgs[0].enabled = false
    const targets = await buildIscsiTargets(ctx)
    targets[0].ownership = 'anas'
    const marks = new Map<string, RestoreMarkRead>([[FILE, { state: 'unsupported' }], ['/dev/zvol/tank/vol1', { state: 'present', dataset: 'tank/vol1', raw: OLD_MARK, mark: decodeRestoreMark(OLD_MARK) }]])
    const health = computeIscsiHealth(ctx, targets, { marks, restoreRunning: () => undefined, restoreFailed: p => (p === FILE ? { job: 'j-1', outcome: 'partial', imageBytes: IMAGE_SIZE } : undefined) })
    const card = buildIscsiWarnings(health).map(w => w.message).find(m => /is disabled/.test(m)) ?? ''
    assert.match(card, /asks you to confirm and removes the restore mark\. For a LUN on a volume, restoring the image again is the other way out\./)
    assert.ok(card.includes(`first set ${FILE} to the image's ${IMAGE_SIZE} bytes with 'truncate -s ${IMAGE_SIZE} ${FILE}'`), card)
  })

  it('review3 4: the running card over a FILE LUN states the three endings true for a file (never "otherwise stays disabled")', async () => {
    const ctx = contextOf({ backstores: [{ name: 'lun2', plugin: 'fileio', dev: FILE, wwn: 's2' }], luns: [{ iqn: IQN, tag: 1, index: 1, backstore: 'lun2', plugin: 'fileio' }] }, null, SOURCE_BASE)
    ctx.live.targets[0].tpgs[0].enabled = false
    const targets = await buildIscsiTargets(ctx)
    targets[0].ownership = 'anas'
    const marks = new Map<string, RestoreMarkRead>([[FILE, { state: 'unsupported' }], ['/dev/zvol/tank/vol1', { state: 'absent', dataset: 'tank/vol1' }]])
    const card = buildIscsiWarnings(computeIscsiHealth(ctx, targets, { marks, restoreRunning: p => (p === FILE ? 'j-1' : undefined), restoreFailed: () => undefined })).map(w => w.message).find(m => /is disabled/.test(m)) ?? ''
    assert.match(card, /Enable is refused until the restore ends\. When the restore ends, a target the restore disabled is enabled again only if the image is complete and its size verified, and put back as it was if the restore fails before it opens the image file and the file is still the image's size \(opening it for the restore empties it\); in every other case it stays disabled and the restore job says why\. A target the restore did not disable is left as it is\./)
    assert.doesNotMatch(card, /otherwise the target stays disabled|restore mark/)
  })

  it('THE GAP: after a restart of the ANAS daemon (a new, empty queue) the record is gone and the file LUN reads as any other', async () => {
    const before = new JobQueue()
    await ran(before, 'backup.restore.image', restoreOnto(FILE), { message: 'partial', code: 'IMAGE_PARTIAL' })
    assert.ok(restoreJobsOf(before).restoreFailed(FILE, IQN))
    const after = new JobQueue()
    assert.equal(restoreJobsOf(after).restoreFailed(FILE, IQN), undefined)
    const facts = await readLunMarks(new MockExecutor(), [{ index: 1, name: 'lun2', backingPath: FILE }], { ...restoreJobsOf(after), targetIqn: IQN })
    assert.deepEqual(enableMarkVerdict(IQN, facts), { kind: 'clear' }, 'nothing on the object says otherwise (no file mark yet)')
  })

  it('a restore RUNNING onto a file LUN refuses Enable although the file carries no mark (the reviewer\'s restore-mark.ts:252, marked.map)', async () => {
    const facts = await readLunMarks(new MockExecutor(), [{ index: 1, name: 'lun2', backingPath: FILE }], { restoreRunning: p => (p === FILE ? 'job-7' : undefined), restoreFailed: () => undefined, targetIqn: IQN })
    assert.equal(facts[0].read.state, 'unsupported')
    const v = enableMarkVerdict(IQN, facts)
    assert.equal(v.kind, 'refuse')
    assert.equal(v.kind === 'refuse' && v.reason, 'restore-in-progress')
    assert.match(v.kind === 'refuse' ? v.message : '', /^A whole-image restore is writing LUN 1 \('lun2'\) of .* right now \(job job-7\)\. Enabling the target is refused until the restore ends: it would serve a partly written disk\.$/)
  })

  it('health: a running restore onto a file LUN is an in-progress row (source job), and the retained failed one an interrupted row naming the job', async () => {
    const ctx = contextOf({ backstores: [{ name: 'lun2', plugin: 'fileio', dev: FILE, wwn: 's2' }], luns: [{ iqn: IQN, tag: 1, index: 1, backstore: 'lun2', plugin: 'fileio' }] }, null, SOURCE_BASE)
    ctx.live.targets[0].tpgs[0].enabled = false
    const targets = await buildIscsiTargets(ctx)
    targets[0].ownership = 'anas'
    const marks = new Map<string, RestoreMarkRead>([[FILE, { state: 'unsupported' }], ['/dev/zvol/tank/vol1', { state: 'absent', dataset: 'tank/vol1' }]])
    const running = computeIscsiHealth(ctx, targets, { marks, restoreRunning: p => (p === FILE ? 'j-1' : undefined), restoreFailed: () => undefined })
    assert.deepEqual(running.restoreMarks?.map(r => [r.lunIndex, r.state, r.source, r.dataset, r.job]), [[1, 'in-progress', 'job', null, 'j-1']])
    const card = buildIscsiWarnings(running).map(w => w.message).join('\n')
    assert.match(card, /A whole-image restore \(job j-1\) is writing LUN 1 \('lun2'\) of .* right now\. Enable is refused until the restore ends\./)
    const failed = computeIscsiHealth(ctx, targets, { marks, restoreRunning: () => undefined, restoreFailed: p => (p === FILE ? { job: 'j-1', outcome: 'partial', imageBytes: IMAGE_SIZE } : undefined) })
    assert.deepEqual(failed.restoreMarks?.map(r => [r.lunIndex, r.state, r.source, r.job]), [[1, 'interrupted', 'job', 'j-1']])
    const msg = buildIscsiWarnings(failed).map(w => w.message).join('\n')
    assert.match(msg, /The whole-image restore job j-1 onto LUN 1 \('lun2'\) of .* did not finish, so it may hold a partial image\. ANAS knows this only from that job's record in this run of the ANAS daemon: an image file carries no restore mark, so the record is lost when the ANAS daemon restarts, or when the daemon holds more than 100 such records and more than 1000 jobs \(the oldest record goes first\)\. To restore the image again in place, first set \/tank\/images\/lun2\.raw to the image's 536870912 bytes with 'truncate -s 536870912 \/tank\/images\/lun2\.raw' \(the in-place restore refuses a file of any other size, and a failed restore can leave the file shorter\); deleting this LUN and restoring the image as a new LUN is the other way out\. Enabling the target serves that image to initiators: Enable on the iSCSI screen asks you to confirm\./)
    assert.doesNotMatch(msg, /removes the restore mark|Enable it from the iSCSI screen when you are ready|Restoring the image again is the other way out/)
  })
})

describe('cr3.lunrestore review2 (5, E) — a hole held back by a restore mark is its own kind in the Repair refusal', () => {
  const hole = (over: Partial<IscsiRepairItem>): IscsiRepairItem => ({
    targetIqn: IQN,
    tpgTag: 1,
    lunIndex: 1,
    backstoreName: 'ghost',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/gone',
    backingPresent: true,
    stubBacking: false,
    serial: 's',
    size: null,
    writeBack: false,
    attributes: {} as IscsiRepairItem['attributes'],
    aclInitiators: [],
    ...over,
  })

  it('review3 6: a MIXED Repair (one hole put back, one held by a mark) says the mark held it back, not only "still missing"', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: TARGETCLI, result: OK })
    mock.addFixture({ command: ZFS, result: OK })
    const marked = hole({ lunIndex: 2, backstoreName: 'held', restoreMark: 'interrupted', restoreMarkDataset: 'tank/gone', blockedReason: 'a whole-image restore (its details could not be read) onto tank/gone did not finish, so it holds a partial image' })
    const result = await repairIscsiHoles({ executor: mock }, { repairable: [hole({ backingPath: '/dev/zvol/tank/back' })], blocked: [marked] })
    assert.equal(result.repaired.length, 1)
    assert.match(result.stillDegraded ?? '', /^This node stays degraded: 1 LUN is still missing, so nothing was saved\. One hole is held back by a restore mark on the backing: LUN 2 of .* \(backstore 'held', \/dev\/zvol\/tank\/gone\): a whole-image restore .* did not finish, so it holds a partial image\. Repair would map that image into the target again, so it does not\./)
    assert.match(result.stillDegraded ?? '', /clear its restore mark \('zfs inherit anas:restore tank\/gone'\) and run Repair again/)
  })

  it('only marked holes: reason restore-mark (not record-incomplete), the clause once, one stop', () => {
    const r = assertRepairable({ repairable: [], blocked: [hole({ restoreMark: 'interrupted', restoreMarkDataset: 'tank/gone', blockedReason: 'a whole-image restore (its details could not be read) onto tank/gone did not finish, so it holds a partial image' })] })
    assert.equal(r?.reason, 'restore-mark')
    assert.match(r?.message ?? '', /^None of the missing LUNs can be repaired\. One hole is held back by a restore mark on the backing: LUN 1 of .* \(backstore 'ghost', \/dev\/zvol\/tank\/gone\): a whole-image restore \(its details could not be read\) onto tank\/gone did not finish, so it holds a partial image\. Repair would map that image into the target again/)
    assert.doesNotMatch(r?.message ?? '', /\.\.|does not describe/)
  })

  it('a marked hole beside an absent one: the absent one leads (bring the storage back), the marked one is named after it', () => {
    const r = assertRepairable({ repairable: [], blocked: [
      hole({ lunIndex: 2, backstoreName: 'away', backingPath: '/dev/zvol/tank/away', backingPresent: false }),
      hole({ restoreMark: 'in-progress', restoreMarkDataset: 'tank/gone', blockedReason: 'a whole-image restore is writing it right now (job j)' }),
    ] })
    assert.equal(r?.reason, 'backing-absent')
    assert.match(r?.message ?? '', /LUN 2 of .* \(backstore 'away', \/dev\/zvol\/tank\/away\)\. Bring the storage back first/)
    assert.match(r?.message ?? '', /One hole is held back by a restore mark on the backing: LUN 1 .*: a whole-image restore is writing it right now \(job j\)\. Repair is refused for a LUN a restore is writing until the restore ends\.$/)
  })
})

describe('cr3.lunrestore review2 (6, F) — each sentence true on the path that prints it', () => {
  const MARK: RestoreMark = { v: 1, repo: 'pbs-main', snapshot: SNAP, archive: 'vol.img', started: '2026-11-14T10:00:00.000Z', state: 'writing' }
  const UNVERIFIED: RestoreMark = { ...MARK, state: 'unverified', reason: 'size could not be re-read' }
  const fact = (index: number, mark: RestoreMark | null, raw = mark ? JSON.stringify(mark) : 'garbage') => ({ index, name: `l${index}`, backingPath: `/dev/zvol/tank/l${index}`, read: { state: 'present' as const, dataset: `tank/l${index}`, raw, mark } })

  it('F3: an UNVERIFIED mark is never "did not finish" or "partially written" — in the Enable confirm', () => {
    const v = enableMarkVerdict(IQN, [fact(0, UNVERIFIED)])
    assert.equal(v.kind, 'confirm')
    if (v.kind !== 'confirm')
      return
    assert.equal(v.message, `Enabling ${IQN} serves a LUN whose restored image is not verified`)
    assert.equal(v.warnings[0], `LUN 0 ('l0'): a whole-image restore of vol.img from ${SNAP} (repository pbs-main) started 2026-11-14T10:00:00.000Z onto tank/l0 `
    + 'ended with the client reporting the image complete, but its size was not verified (size could not be re-read). An initiator will be '
    + 'served an image ANAS could not verify. Confirming removes the restore mark; restoring the image again is the other way out.')
    assert.doesNotMatch(v.warnings.join(' '), /did not finish|partial/)
  })

  it('F3: interrupted alone, and the two together, each get their own title sentence', () => {
    const one = enableMarkVerdict(IQN, [fact(0, MARK)])
    assert.equal(one.kind === 'confirm' && one.message, `Enabling ${IQN} serves a LUN whose whole-image restore did not finish`)
    const both = enableMarkVerdict(IQN, [fact(0, MARK), fact(1, UNVERIFIED)])
    assert.equal(both.kind === 'confirm' && both.message, `Enabling ${IQN} serves 2 LUNs whose whole-image restore did not finish or whose restored image is not verified`)
  })

  it('the confirm\'s scope in words: each mark described, an unreadable one by a fingerprint of its value, a job record by its job', () => {
    const words = describeMarkSet([fact(1, null, 'not json'), fact(0, UNVERIFIED), { index: 2, name: 'l2', backingPath: '/tank/images/l2.raw', read: { state: 'unsupported' as const }, record: { job: 'j-3', outcome: 'partial' as const } }])
    assert.equal(words, '/tank/images/l2.raw: restore job j-3 did not finish; '
    + `tank/l0: an unverified whole-image restore of vol.img from ${SNAP} (repository pbs-main) started 2026-11-14T10:00:00.000Z (not verified: size could not be re-read); `
    + 'tank/l1: a restore mark whose details could not be read (value fingerprint 7ccfa1fbf394)')
    assert.notEqual(describeMarkSet([fact(1, null, 'not json')]), describeMarkSet([fact(1, null, 'not json!')]), 'two unparsed values never read the same')
  })

  it('F2: a door refused while a restore RUNS says it runs, and when it can go on', () => {
    const r = restoreMarkRefusal({ state: 'present', dataset: 'tank/vol1', raw: '{}', mark: MARK }, 'LUN 0 (\'vmdisk1\') of t', 'Adding an initiator to this target', 'unused', { running: 'j-1' })
    assert.deepEqual(r, { reason: 'restore-in-progress', message: 'A whole-image restore is writing LUN 0 (\'vmdisk1\') of t right now (job j-1). Adding an initiator to this target is refused until the restore ends.' })
  })

  it('F4: a new-LUN image kept UNVERIFIED (zvol): to serve it, clear the mark first, then map', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith(m => m.addFixture({ command: ZFS, args: volsizeArgs('tank/newvol'), result: { stdout: `${IMAGE_SIZE * 2}\n`, stderr: '', exitCode: 0 } })))
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {}), (err: Error) => {
        assert.match(err.message, /are kept, not mapped as a LUN\. If you have checked the image and want to serve it, clear the restore mark with 'zfs inherit anas:restore tank\/newvol', then map it with 'targetcli \/iscsi\/.*\/tpg1\/luns create \/backstores\/block\/newvol' and grant it to the initiators \(the next iSCSI change in ANAS saves the configuration\); otherwise delete it with 'targetcli \/backstores\/block delete newvol', then 'zfs destroy tank\/newvol'\.$/)
        assert.doesNotMatch(err.message, /To serve it, map it/)
        return true
      })
    })
  })

  it('F4: a new-LUN image FILE kept unverified: no mark to clear — map it once checked', async () => {
    await withRoot(async (root) => {
      const path = join(root, 'newimg.raw')
      const base = mockWith()
      // The stream "writes" past the image's end: the file grows.
      const stream = base.execToStream.bind(base)
      base.execToStream = async (c, a, t, o) => {
        await truncate(path, IMAGE_SIZE * 2)
        return stream(c, a, t, o)
      }
      const rec = recording(base)
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root, { backing: { path, plugin: 'fileio', dataset: 'tank/images' } }), () => {}), (err: Error) => {
        assert.match(err.message, /, so it was not mapped as a LUN\. The backstore 'newvol' .* are kept, not mapped as a LUN\. If you have checked the image and want to serve it, map it with 'targetcli /)
        assert.doesNotMatch(err.message, /zfs inherit|restore mark/)
        assert.equal((err as Error & { jobErrorCode?: string }).jobErrorCode, 'IMAGE_UNVERIFIED')
        return true
      })
    })
  })

  it('lunNameFreeGate: a name only the SAVED configuration holds says so, and what removes it', async () => {
    const saved = contextOf({ backstores: [], luns: [] }, { backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's' }], luns: [] }, SOURCE_BASE)
    const refused = await lunNameFreeGate('newvol')({ target: targetDetail(), state: { ctx: saved, targets: [targetDetail()] } }, undefined as never)
    assert.equal(refused?.message, 'A backstore named \'newvol\' is in the saved configuration of this node (not in the live one), and no LUN maps it. '
    + 'The name is the SCSI model string initiators see, so it has to be unique: pick another name. The next iSCSI change in ANAS saves the configuration without it.')
  })

  it('lunNameFreeGate: a backstore a restore is writing is named with its job, and never "remove it"', async () => {
    const live = contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's' }], luns: [] }, null, SOURCE_BASE)
    const refused = await lunNameFreeGate('newvol', p => (p === NEWVOL ? 'j-5' : undefined))({ target: targetDetail(), state: { ctx: live, targets: [targetDetail()] } }, undefined as never)
    assert.match(refused?.message ?? '', /no LUN maps it: a whole-image restore is writing its image right now \(job j-5\)\. .*: pick another name\.$/)
    assert.doesNotMatch(refused?.message ?? '', /remove/)
  })
})

describe('cr3.lunrestore review2 (7) — the marks of every volume in ONE zfs get, fail-closed per row', () => {
  const VALUE = JSON.stringify({ v: 1, repo: 'r', snapshot: 's', archive: 'a.img', started: 't', state: 'writing' })
  const P = (d: string) => `/dev/zvol/${d}`
  const batch = (stdout: string, exitCode = 0, stderr = '', more: (m: MockExecutor) => void = () => {}) => {
    const m = new MockExecutor()
    more(m)
    m.addFixture({ command: ZFS, args: restoreMarksGetArgs(['tank/a', 'tank/b', 'tank/c']), result: { stdout, stderr, exitCode } })
    return { m, run: () => readRestoreMarksBatch(m, [P('tank/a'), P('tank/b'), P('tank/c'), '/tank/images/x.raw']) }
  }
  const states = (reads: Map<string, RestoreMarkRead>) => [P('tank/a'), P('tank/b'), P('tank/c'), '/tank/images/x.raw'].map(p => reads.get(p)?.state)

  it('one command for three volumes and a file; each row read as the single read reads it', async () => {
    const { m, run } = batch(`tank/a\t${VALUE}\tlocal\ntank/b\t-\t-\ntank/c\t${VALUE}\tinherited from tank\n`)
    const reads = await run()
    assert.deepEqual(states(reads), ['present', 'absent', 'absent', 'unsupported'])
    assert.equal(m.calls.length, 1)
    assert.deepEqual(m.calls[0].args, ['get', '-Hp', '-o', 'name,value,source', 'anas:restore', '--', 'tank/a', 'tank/b', 'tank/c'])
  })

  it('a value that runs on past a newline makes THAT volume unknown, never absent; the others stand', async () => {
    const reads = await batch(`tank/a\tline one\nline two\tlocal\ntank/b\t-\t-\ntank/c\t${VALUE}\tlocal\n`).run()
    assert.deepEqual(states(reads), ['unknown', 'absent', 'present', 'unsupported'])
    assert.match((reads.get(P('tank/a')) as { reason: string }).reason, /spans lines/)
  })

  it('a missing row is unknown; a repeated row is unknown; a line before any row makes every volume unknown', async () => {
    assert.deepEqual(states(await batch(`tank/a\t-\t-\ntank/c\t-\t-\n`).run()), ['absent', 'unknown', 'absent', 'unsupported'])
    assert.deepEqual(states(await batch(`tank/a\t-\t-\ntank/a\t-\t-\ntank/b\t-\t-\ntank/c\t-\t-\n`).run()), ['unknown', 'absent', 'absent', 'unsupported'])
    assert.deepEqual(states(await batch(`noise\ntank/a\t-\t-\ntank/b\t-\t-\ntank/c\t-\t-\n`).run()), ['unknown', 'unknown', 'unknown', 'unsupported'])
  })

  it('a non-zero exit (a volume that does not exist): one read per volume, the missing one absent, the others as read', async () => {
    const { m, run } = batch(`tank/a\t${VALUE}\tlocal\ntank/c\t-\t-\n`, 1, 'cannot open \'tank/b\': dataset does not exist', (mm) => {
      mm.addFixture({ command: ZFS, args: restoreMarkGetArgs('tank/a'), result: { stdout: `${VALUE}\tlocal\n`, stderr: '', exitCode: 0 } })
      mm.addFixture({ command: ZFS, args: restoreMarkGetArgs('tank/b'), result: { stdout: '', stderr: 'cannot open \'tank/b\': dataset does not exist', exitCode: 1 } })
      mm.addFixture({ command: ZFS, args: restoreMarkGetArgs('tank/c'), result: { stdout: '', stderr: 'cannot get property: pool I/O is currently suspended', exitCode: 1 } })
    })
    assert.deepEqual(states(await run()), ['present', 'absent', 'unknown', 'unsupported'])
    assert.equal(m.calls.length, 4, 'the batch, then one per volume')
  })

  it('the single read: a value spanning lines is unknown (it used to read the first line)', async () => {
    const m = new MockExecutor()
    m.addFixture({ command: ZFS, args: restoreMarkGetArgs('tank/newvol'), result: { stdout: 'a\tx\nb\tlocal\n', stderr: '', exitCode: 0 } })
    assert.equal((await readRestoreMark(m, { path: NEWVOL })).state, 'unknown')
  })

  it('cost: the health read of two zvol LUNs and an unmapped backstore runs ONE zfs get for the marks', async () => {
    const ctx = contextOf({ backstores: [{ name: 'newvol', plugin: 'block', dev: NEWVOL, wwn: 's' }, { name: 'other2', plugin: 'block', dev: '/dev/zvol/tank/other2', wwn: 't' }], luns: [{ iqn: IQN, tag: 1, index: 2, backstore: 'other2', plugin: 'block' }] }, null, SOURCE_BASE)
    const node = withMarks(new MockExecutor())
    const rec = recording(node.executor)
    const reads = await readRestoreMarks(rec.executor, ctx, await buildIscsiTargets(ctx))
    assert.equal(reads.size, 3)
    assert.deepEqual(argv(rec.calls), [`${ZFS} get -Hp -o name,value,source anas:restore -- tank/vol1 tank/other2 tank/newvol`])
  })
})

describe('cr3.lunrestore review2 (9) — one derivation of the volume a mark lives on: from the backing path', () => {
  it('the writer marks the volume the path names even when the LUN record names another dataset; the readers read that volume', async () => {
    const node = withMarks(inPlaceMock({ stderr: 'Error: No space left on device (os error 28)\n', exitCode: 255, bytesWritten: 4096 }))
    const rec = recording(node.executor)
    const deps = inPlaceDeps(rec.executor, { enabled: true })
    deps.lun = { ...deps.lun, dataset: 'tank/somewhere-else' }
    await assert.rejects(runImageRestore(rec.executor, deps, () => {}))
    assert.deepEqual([...node.marks.keys()], ['tank/vol1'])
    assert.ok(argv(rec.calls).every(a => !a.includes('somewhere-else')), argv(rec.calls).join('\n'))
    const facts = await readLunMarks(node.executor, [{ index: 0, name: 'vmdisk1', backingPath: VOL1 }])
    assert.equal(facts[0].read.state, 'present')
  })

  it('markDataset: a zvol path names its volume; an image file and a bare pool path name none', () => {
    assert.equal(markDataset('/dev/zvol/tank/sub/vol'), 'tank/sub/vol')
    assert.equal(markDataset('/dev/zvol/tank'), null)
    assert.equal(markDataset('/tank/images/x.raw'), null)
  })
})

// ---------------------------------------------------------------------------
// The crash tables for BOTH paths and BOTH backings (review2 acceptance).
// A stop inside call K: the call does not complete; the daemon restarts with
// no job records (the job died with it); a reboot brings back the last save.
// Columns: call | state after a crash there | mark | Enable verdict | dashboard.
// ---------------------------------------------------------------------------

type Image = 'untouched' | 'PARTIAL' | 'written, not verified' | 'verified'
type Card = 'none' | 'disabled: invites Enable' | 'disabled: Enable asks (partial)' | 'critical: served' | 'unmapped: partial (mark)' | 'unmapped: content unknown'

/** The dashboard's verdict on the restore, as one label (the cards are asserted in full elsewhere). */
function cardOf(cards: string[]): Card {
  if (cards.some(m => /so initiators are being served that image now/.test(m)))
    return 'critical: served'
  const dis = cards.find(m => m.startsWith(`iSCSI target ${IQN} is disabled`))
  if (dis && /did not finish|not verified|may hold a partial image/.test(dis))
    return 'disabled: Enable asks (partial)'
  if (dis && /Enable it from the iSCSI screen when you are ready/.test(dis))
    return 'disabled: invites Enable'
  const unm = cards.find(m => m.startsWith('iSCSI backstore \'newvol\''))
  if (unm && /did not finish: it holds a partial image/.test(unm))
    return 'unmapped: partial (mark)'
  if (unm && /ANAS cannot tell what it holds/.test(unm))
    return 'unmapped: content unknown'
  return 'none'
}

/** The TPG enable flag as the calls left it: live, and as the last save holds it (both start enabled). */
function tpgOf(calls: RecordedCall[]): { live: boolean, saved: boolean } {
  let live = true
  let saved = true
  for (const c of calls) {
    if (c.command !== TARGETCLI || c.exitCode !== 0)
      continue
    if (c.args[0] === `/iscsi/${IQN}/tpg1` && (c.args[1] === 'enable' || c.args[1] === 'disable'))
      live = c.args[1] === 'enable'
    if (c.args[0] === 'saveconfig')
      saved = live
  }
  return { live, saved }
}

/** Health + cards + the Enable verdict of a node whose target is enabled or not, after a restart (no job records). */
async function verdictsOn(base: typeof SOURCE_BASE, enabled: boolean, marks: CommandExecutor, tree: LioTree = { backstores: [], luns: [] }, prep: (ctx: IscsiReadContext) => void = () => {}): Promise<{ enable: string, card: Card }> {
  const ctx = contextOf(tree, null, base)
  prep(ctx)
  ctx.live.targets[0].tpgs[0].enabled = enabled
  const targets = await buildIscsiTargets(ctx)
  targets[0].ownership = 'anas'
  const facts = await readLunMarks(marks, targets[0].luns)
  const v = enableMarkVerdict(IQN, facts)
  const reads = await readRestoreMarks(marks, ctx, targets)
  const health = computeIscsiHealth(ctx, targets, { marks: reads, restoreRunning: () => undefined, restoreFailed: () => undefined })
  return { enable: v.kind === 'refuse' ? `refuse (${v.reason})` : v.kind, card: cardOf(buildIscsiWarnings(health).map(w => w.message)) }
}

interface InPlaceRow { at: number, call: string, live: 'on' | 'off', reboot: 'on' | 'off', image: Image, mark: string, enable: string, card: Card, rebootCard: Card }

// In place, ZVOL, the target enabled when the restore starts.
const IN_PLACE_ZVOL: InPlaceRow[] = [
  { at: 0, call: 'zfs get anas:restore (the mark already there)', live: 'on', reboot: 'on', image: 'untouched', mark: 'none', enable: 'clear', card: 'none', rebootCard: 'none' },
  { at: 1, call: 'targetcli tpg1 disable', live: 'on', reboot: 'on', image: 'untouched', mark: 'none', enable: 'clear', card: 'none', rebootCard: 'none' },
  { at: 2, call: 'saveconfig', live: 'off', reboot: 'on', image: 'untouched', mark: 'none', enable: 'clear', card: 'disabled: invites Enable', rebootCard: 'none' },
  { at: 3, call: 'zfs set anas:restore (writing)', live: 'off', reboot: 'off', image: 'untouched', mark: 'none', enable: 'clear', card: 'disabled: invites Enable', rebootCard: 'disabled: invites Enable' },
  { at: 4, call: 'the image stream', live: 'off', reboot: 'off', image: 'PARTIAL', mark: 'writing', enable: 'confirm', card: 'disabled: Enable asks (partial)', rebootCard: 'disabled: Enable asks (partial)' },
  { at: 5, call: 'zfs get volsize (verify)', live: 'off', reboot: 'off', image: 'written, not verified', mark: 'writing', enable: 'confirm', card: 'disabled: Enable asks (partial)', rebootCard: 'disabled: Enable asks (partial)' },
  { at: 6, call: 'zfs inherit anas:restore', live: 'off', reboot: 'off', image: 'verified', mark: 'writing', enable: 'confirm', card: 'disabled: Enable asks (partial)', rebootCard: 'disabled: Enable asks (partial)' },
  { at: 7, call: 'targetcli tpg1 enable', live: 'off', reboot: 'off', image: 'verified', mark: 'none', enable: 'clear', card: 'disabled: invites Enable', rebootCard: 'disabled: invites Enable' },
  { at: 8, call: 'saveconfig', live: 'on', reboot: 'off', image: 'verified', mark: 'none', enable: 'clear', card: 'none', rebootCard: 'disabled: invites Enable' },
]

// In place, IMAGE FILE, the target enabled when the restore starts. The file
// carries no mark and the job record died with the daemon: the row at the
// stream is THE GAP (Enable is not asked after a restart), stated, not hidden.
const IN_PLACE_FILE: InPlaceRow[] = [
  { at: 0, call: 'targetcli tpg1 disable', live: 'on', reboot: 'on', image: 'untouched', mark: 'n/a (a file carries none)', enable: 'clear', card: 'none', rebootCard: 'none' },
  { at: 1, call: 'saveconfig', live: 'off', reboot: 'on', image: 'untouched', mark: 'n/a (a file carries none)', enable: 'clear', card: 'disabled: invites Enable', rebootCard: 'none' },
  { at: 2, call: 'the image stream', live: 'off', reboot: 'off', image: 'PARTIAL', mark: 'n/a (a file carries none)', enable: 'clear', card: 'disabled: invites Enable', rebootCard: 'disabled: invites Enable' },
  { at: 3, call: 'targetcli tpg1 enable (size verified by stat before it)', live: 'off', reboot: 'off', image: 'verified', mark: 'n/a (a file carries none)', enable: 'clear', card: 'disabled: invites Enable', rebootCard: 'disabled: invites Enable' },
  { at: 4, call: 'saveconfig', live: 'on', reboot: 'off', image: 'verified', mark: 'n/a (a file carries none)', enable: 'clear', card: 'none', rebootCard: 'disabled: invites Enable' },
]

describe('cr3.lunrestore review2 — the IN-PLACE crash tables (zvol and image file), machine-checked', () => {
  for (const [kind, table] of [['zvol', IN_PLACE_ZVOL], ['file', IN_PLACE_FILE]] as const) {
    it(`${kind}: the successful run is exactly the ${table.length} calls the table names`, async () => {
      await withRoot(async (root) => {
        const path = kind === 'zvol' ? VOL1 : await imageFile(root, IMAGE_SIZE)
        const rec = recording(withMarks(inPlaceMock()).executor)
        await runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true, path }), () => {})
        assert.equal(rec.calls.length, table.length, argv(rec.calls).join('\n'))
      })
    })

    for (const row of table) {
      it(`${kind}: a stop inside call ${row.at} (${row.call}) — live ${row.live}, after reboot ${row.reboot}, image ${row.image}, mark ${row.mark}, Enable ${row.enable}, dashboard "${row.card}"`, async () => {
        await withRoot(async (root) => {
          const path = kind === 'zvol' ? VOL1 : await imageFile(root, IMAGE_SIZE)
          const node = withMarks(inPlaceMock())
          const rec = recording(node.executor, { haltAt: row.at })
          const run = runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true, path }), () => {})
          run.catch(() => {})
          await rec.halted
          try {
            const halted = rec.calls.slice(0, row.at)
            const tpg = tpgOf(halted)
            const stream = rec.calls.findIndex(c => c.command === PBC)
            const verify = kind === 'zvol' ? rec.calls.findIndex(c => c.args.join(' ') === volsizeArgs('tank/vol1').join(' ')) : stream + 1
            const image: Image = stream < 0 || row.at < stream ? 'untouched' : row.at === stream ? 'PARTIAL' : row.at <= verify && kind === 'zvol' ? 'written, not verified' : 'verified'
            const raw = node.marks.get('tank/vol1')
            const mark = kind === 'file' ? 'n/a (a file carries none)' : raw ? JSON.parse(raw).state : 'none'
            const base = kind === 'zvol' ? SOURCE_BASE : { iqn: IQN, tag: 1, backstores: [{ name: 'vmdisk1', plugin: 'fileio', dev: path, wwn: SOURCE_SERIAL }], luns: [{ iqn: IQN, tag: 1, index: 0, backstore: 'vmdisk1', plugin: 'fileio' }] }
            const now = await verdictsOn(base, tpg.live, node.executor)
            const reboot = await verdictsOn(base, tpg.saved, node.executor)
            assert.deepEqual(
              { live: tpg.live ? 'on' : 'off', reboot: tpg.saved ? 'on' : 'off', image, mark, enable: now.enable, card: now.card, rebootCard: reboot.card },
              { live: row.live, reboot: row.reboot, image: row.image, mark: row.mark, enable: row.enable, card: row.card, rebootCard: row.rebootCard },
            )
            // THE INVARIANT: a target ANAS serves (live, or after a reboot) holds an untouched or a verified image.
            if (tpg.live || tpg.saved)
              assert.ok(image === 'untouched' || image === 'verified', `served with image ${image}`)
            // A zvol whose image is not proven is never served on Enable without the confirm.
            if (kind === 'zvol' && (image === 'PARTIAL' || image === 'written, not verified'))
              assert.notEqual(now.enable, 'clear')
            // The file GAP, stated: after a daemon restart nothing marks the partial image.
            if (kind === 'file' && image === 'PARTIAL')
              assert.equal(now.enable, 'clear', 'GAP (until a file mark exists): the job record died with the daemon')
          }
          finally {
            rec.resume()
            await run.catch(() => {})
          }
        })
      })
    }
  }
})

// New LUN, the Enable verdict and the dashboard for the existing zvol table
// (CRASH_TABLE above holds the node and mark columns). The destination
// target's Enable is never asked about a new LUN: it is mapped only after its
// mark is removed. The marked volume no backstore holds yet (call 2) has no
// card: the round's open item, stated.
const NEW_LUN_ZVOL_VERDICTS: { at: number, enable: string, card: Card }[] = [
  { at: 0, enable: 'clear', card: 'none' },
  { at: 1, enable: 'clear', card: 'none' },
  { at: 2, enable: 'clear', card: 'none' },
  ...[3, 4, 5, 6, 7, 8, 9].map(at => ({ at, enable: 'clear', card: 'unmapped: partial (mark)' as Card })),
  { at: 10, enable: 'clear', card: 'unmapped: content unknown' },
  { at: 11, enable: 'clear', card: 'none' },
  { at: 12, enable: 'clear', card: 'none' },
]

// New LUN, IMAGE FILE (the sparse file is created before call 0, by Node, not a command).
const NEW_LUN_FILE: { at: number, call: string, node: 'backing only' | 'unmapped backstore' | 'complete LUN', enable: string, card: Card }[] = [
  { at: 0, call: 'backstore create', node: 'backing only', enable: 'clear', card: 'none' },
  { at: 1, call: 'set emulate_tpu', node: 'unmapped backstore', enable: 'clear', card: 'unmapped: content unknown' },
  { at: 2, call: 'set emulate_tpws', node: 'unmapped backstore', enable: 'clear', card: 'unmapped: content unknown' },
  { at: 3, call: 'set max_unmap_lba_count', node: 'unmapped backstore', enable: 'clear', card: 'unmapped: content unknown' },
  { at: 4, call: 'set emulate_write_cache', node: 'unmapped backstore', enable: 'clear', card: 'unmapped: content unknown' },
  { at: 5, call: 'the image stream', node: 'unmapped backstore', enable: 'clear', card: 'unmapped: content unknown' },
  { at: 6, call: 'map (luns create; size verified by stat before it)', node: 'unmapped backstore', enable: 'clear', card: 'unmapped: content unknown' },
  { at: 7, call: 'ACL grant', node: 'complete LUN', enable: 'clear', card: 'none' },
  { at: 8, call: 'saveconfig', node: 'complete LUN', enable: 'clear', card: 'none' },
]

describe('cr3.lunrestore review2 — the NEW-LUN crash tables: Enable verdict and dashboard (zvol), and the image-file table', () => {
  for (const row of NEW_LUN_ZVOL_VERDICTS) {
    it(`zvol: a stop inside call ${row.at} (${CRASH_TABLE[row.at].call}) — Enable ${row.enable}, dashboard "${row.card}"`, async () => {
      await withRoot(async (root) => {
        const rec = recording(mockWith(), { haltAt: row.at })
        const run = runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {})
        run.catch(() => {})
        await rec.halted
        try {
          const live = replayLio(rec.calls.slice(0, row.at))
          const marks = withMarks(new MockExecutor(), Object.fromEntries(live.marks.map(d => [d, '{}'])))
          const v = await verdictsOn(SOURCE_BASE, true, marks.executor, live)
          assert.deepEqual(v, { enable: row.enable, card: row.card })
        }
        finally {
          rec.resume()
          await run.catch(() => {})
        }
      })
    })
  }

  it(`file: the successful run is exactly the ${NEW_LUN_FILE.length} calls the table names`, async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith())
      await runNewLunImageRestore(rec.executor, newFileDeps(rec, root), () => {})
      assert.equal(rec.calls.length, NEW_LUN_FILE.length, argv(rec.calls).join('\n'))
    })
  })

  for (const row of NEW_LUN_FILE) {
    it(`file: a stop inside call ${row.at} (${row.call}) — ${row.node}, Enable ${row.enable}, dashboard "${row.card}"`, async () => {
      await withRoot(async (root) => {
        const rec = recording(mockWith(), { haltAt: row.at })
        const run = runNewLunImageRestore(rec.executor, newFileDeps(rec, root), () => {})
        run.catch(() => {})
        await rec.halted
        try {
          const halted = rec.calls.slice(0, row.at)
          const live = replayLio(halted)
          const mapped = live.luns.some(l => l.backstore === 'newvol')
          const node = mapped ? 'complete LUN' : live.backstores.some(b => b.name === 'newvol') ? 'unmapped backstore' : 'backing only'
          assert.equal(node, row.node)
          // Mapped only after a stream that exited 0 (its size then checked by stat).
          if (mapped)
            assert.equal(halted.find(c => c.command === PBC)?.exitCode, 0)
          // The image lands on an AHR pool's filesystem (ANAS storage, so an unmapped backstore on it is reported).
          const v = await verdictsOn(SOURCE_BASE, true, withMarks(new MockExecutor()).executor, live, (ctx) => {
            ctx.inputs.ahrMountpoints = new Map([['ahr1', root]])
          })
          assert.deepEqual(v, { enable: row.enable, card: row.card })
        }
        finally {
          rec.resume()
          await run.catch(() => {})
        }
      })
    })
  }

  function newFileDeps(rec: ReturnType<typeof recording>, root: string): NewLunRestoreDeps {
    return depsFor(rec, root, {
      backing: { path: join(root, 'new.raw'), plugin: 'fileio', dataset: 'tank/images' },
      refreshAfterCreate: async () => targetObjectOf(targetDetail(), contextOf(replayLio(rec.calls), null, SOURCE_BASE)),
      readLive: async () => ({ ctx: contextOf(replayLio(rec.calls), null, SOURCE_BASE) }),
    })
  }
})

describe('cr3.lunrestore review2 — an image FILE is emptied when it is opened for the stream: "nothing written" is not "as it was"', () => {
  it('PBS refused before any byte, but the open truncated the file: the target stays disabled and the job carries IMAGE_PARTIAL', async () => {
    await withRoot(async (root) => {
      const path = await imageFile(root, IMAGE_SIZE)
      const base = inPlaceMock(REFUSED_STREAM)
      const stream = base.execToStream.bind(base)
      base.execToStream = async (c, a, t, o) => {
        await truncate(path, 0) // what open(path, 'w') does on the node
        return stream(c, a, t, o)
      }
      const rec = recording(base)
      await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true, path }), () => {}), (err: Error) => {
        assert.match(err.message, /Nothing was written to .*vmdisk2\.raw\. .*vmdisk2\.raw is 0 bytes now, not 536870912: the image file is emptied when it is opened for the restore, so it no longer holds the image it held, and target .* stays disabled\. To restore the image again in place, first set .*vmdisk2\.raw to the image's 536870912 bytes with 'truncate -s 536870912 .*vmdisk2\.raw' \(the in-place restore refuses a file of any other size, and a failed restore can leave the file shorter\); deleting this LUN and restoring the image as a new LUN is the other way out\.$/)
        assert.equal((err as Error & { jobErrorCode?: string }).jobErrorCode, 'IMAGE_PARTIAL')
        return true
      })
      assert.ok(!enabledBy(rec.calls), 'an emptied image file is not served')
    })
  })

  it('the open itself failed (never started, file untouched): the previous state comes back', async () => {
    await withRoot(async (root) => {
      const path = await imageFile(root, IMAGE_SIZE)
      const rec = recording(inPlaceMock(new StreamNotStartedError(`EACCES: permission denied, open '${path}'`)))
      await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true, path }), () => {}), /could not be started: .*Nothing was written to .*vmdisk2\.raw\.$/)
      assert.ok(enabledBy(rec.calls))
    })
  })
})

// ---------------------------------------------------------------------------
// review3 3: "nothing written" is a CAPTURED pre-write line and nothing else
// ---------------------------------------------------------------------------

const BACKUP_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/backup')

/** The stderr a capture printed under the header that contains `header` (restore-failure-taxonomy.txt layout). */
function capturedBlock(file: string, header: string): string {
  const lines = readFileSync(join(BACKUP_FIXTURES, file), 'utf-8').split('\n')
  const at = lines.findIndex(l => l.includes(header))
  assert.ok(at >= 0, `${header} is in ${file}`)
  const from = lines.findIndex((l, i) => i > at && l.startsWith('### $'))
  const to = lines.findIndex((l, i) => i > from && l.startsWith('### exit='))
  return `${lines.slice(from + 1, to).join('\n')}\n`
}

/** The stderr of one `CASE: n.` in backup-failure-taxonomy.txt (its `  | ` lines). */
function capturedCase(n: number): string {
  const lines = readFileSync(join(BACKUP_FIXTURES, 'backup-failure-taxonomy.txt'), 'utf-8').split('\n')
  const at = lines.findIndex(l => l.startsWith(`CASE: ${n}.`))
  const to = lines.findIndex((l, i) => i > at && l.includes('=== EXIT CODE'))
  return `${lines.slice(at, to).filter(l => l.startsWith('  | ')).map(l => l.slice(4)).join('\n')}\n`
}

describe('cr3.lunrestore review3 (3) — "nothing written" needs a captured pre-write line and no sign the stream started', () => {
  const R = 'restore-failure-taxonomy.txt'
  for (const [name, stderr, nothing] of [
    ['F1 missing snapshot (restore)', () => capturedBlock(R, '=== F1 '), true],
    ['F2 missing group (restore)', () => capturedBlock(R, '=== F2 missing GROUP'), true],
    ['F3 missing namespace (restore)', () => capturedBlock(R, '=== F3 '), true],
    ['F4 missing archive (restore)', () => capturedBlock(R, '=== F4 '), true],
    ['F5 unknown archive suffix (restore)', () => capturedBlock(R, '=== F5 '), true],
    ['F10 PBS refused the connection (restore)', () => capturedBlock(R, '=== F10 '), true],
    ['F11 no-permission token (restore)', () => capturedBlock(R, '=== F11 '), true],
    ['21-connect A: unresolvable name (snapshot list)', () => capturedBlock(R, '=== A. unresolvable hostname'), true],
    ['21-connect D: bad fingerprint (snapshot list)', () => capturedBlock(R, '=== D. bad fingerprint'), true],
    ['21-connect C: connect deadline (a timeout: may have written)', () => capturedBlock(R, '=== C. unreachable IP'), false],
    ['CASE 4 wrong password (snapshot list)', () => capturedCase(4), true],
    ['CASE 7 token lacking privileges (snapshot list)', () => capturedCase(7), true],
    ['CASE 5 wrong token secret: no pre-write class names it (unclassified)', () => capturedCase(5), false],
    ['K3 PBS stopped mid-restore (restore-interrupted.txt)', () => 'progress 4% (12.409 MiB of 250.001 MiB in 5.9s, 2.094 MiB/s)    \nprogress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.09 MiB/s)    \nHTTP/2.0 connection failed\n', false],
    ['MIX: progress 0% then a captured pre-write line', () => 'progress 0% (1 MiB of 250 GiB in 6.0s)    \rError: permission check failed.\n', false],
    ['MIX: progress with no amount then a pre-write line', () => 'progress 0% (0 B of 1 GiB)    \rError: no permissions on /datastore/x\n', false],
    ['MIX: a captured cert line then a broken pipe', () => 'WARNING: certificate fingerprint does not match expected fingerprint!\nError: connection closed because of a broken pipe\n', false],
    ['MIX: a mid-stream line that mentions "snapshot ... does not exist"', () => 'Error: reading chunk for snapshot vm/100/2026-01-01T00:00:00Z failed: chunk 0123abcd does not exist\n', false],
    ['MIX: a captured pre-write line beside a line nobody captured', () => 'Error: client error (Connect)\nHTTP/2.0 connection failed\n', false],
    ['a restore complete line, exit != 0', () => 'restore complete (512 MiB processed in 0.6s)    \nError: permission check failed.\n', false],
  ] as [string, () => string, boolean][]) {
    it(`${name}: ${nothing ? 'nothing written' : 'may have written'}`, () => {
      assert.equal(failedBeforeWriting(stderr()), nothing)
      assert.equal(failedBeforeWriting(stderr(), 'SIGKILL'), false, 'a signal always may have written')
    })
  }

  it('the amount on a progress line counts: "progress 0% (1 MiB of 512 GiB in 6.0s)" is at least 1 MiB less its display rounding, never 0', () => {
    const big = 512 * 2 ** 30
    const p = parseRestoreProgress('progress 0% (1 MiB of 512 GiB in 6.0s, 0.2 MiB/s)    \r')
    assert.deepEqual(imageBytesWritten(0, p, big, 1), { bytes: Math.floor((1 - 0.0005) * 2 ** 20), estimated: true })
    assert.deepEqual(imageBytesWritten(0, parseRestoreProgress('progress 17% (43.939 MiB of 250.001 MiB in 16.1s, 3.1 MiB/s)    \r'), 262145073, 1).bytes, Math.max(Math.floor(0.17 * 262145073), Math.floor((43.939 - 0.0005) * 2 ** 20)))
    assert.deepEqual(imageBytesWritten(0, parseRestoreProgress('progress 0% (0 B of 1 GiB)    \r'), 2 ** 30, 1), { bytes: 0, estimated: false })
    assert.deepEqual(imageBytesWritten(0, parseRestoreProgress('progress 0% (652 B of 1 GiB)    \r'), 2 ** 30, 1), { bytes: 652, estimated: true })
  })

  it('p6: progress 0% (1 MiB of 512 MiB) then "permission check failed." on a zvol — partially written: the target stays disabled, the mark stays (it was re-enabled and unmarked)', async () => {
    const node = withMarks(inPlaceMock({ stderr: 'progress 0% (1 MiB of 512 MiB in 6.0s)    \rError: permission check failed.\n', exitCode: 255, bytesWritten: 0 }))
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.match(err.message, /^the image was partially written \(at least 1048051 of 536870912 bytes reached \/dev\/zvol\/tank\/vol1\)/)
      assert.doesNotMatch(err.message, /Nothing was written/)
      assert.equal((err as Error & { jobErrorCode?: string }).jobErrorCode, 'IMAGE_PARTIAL')
      return true
    })
    assert.ok(!enabledBy(rec.calls), 'never re-enabled')
    assert.equal(JSON.parse(node.marks.get('tank/vol1')!).state, 'writing')
  })

  it('a progress line that names no amount: not "nothing written", and never "before the client reported any progress"', async () => {
    const node = withMarks(inPlaceMock({ stderr: 'progress 0% (0 B of 512 MiB)    \rError: permission check failed.\n', exitCode: 255, bytesWritten: 0 }))
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.match(err.message, /^the client printed 'progress 0% \(0 B of 512 MiB\)' and then failed without naming an amount above zero, so how much of the image reached \/dev\/zvol\/tank\/vol1 is not known \(possibly none\); the LUN is disabled/)
      assert.doesNotMatch(err.message, /before the client reported any progress|Nothing was written/)
      return true
    })
    assert.ok(!enabledBy(rec.calls))
    assert.ok(node.marks.has('tank/vol1'))
  })

  it('new LUN: a progress line that names no amount gets the same true sentence, never "before the client reported any progress"', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith(undefined, { stderr: 'progress 0% (0 B of 512 MiB)    \rError: something went wrong\n', exitCode: 1, bytesWritten: 0 }))
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {}), (err: Error) => {
        assert.match(err.message, /^the client printed 'progress 0% \(0 B of 512 MiB\)' and then failed without naming an amount above zero, so how much of the image reached the new backing \/dev\/zvol\/tank\/newvol is not known \(possibly none\); it was never mapped as a LUN\./)
        return true
      })
    })
  })
})

describe('cr3.lunrestore review3 (6) — an exit 0 the byte count does not prove is unverified, never "verify it" beside a re-enable', () => {
  it('in place: exit 0 with no "restore complete" line — the target stays disabled, the mark says unverified, and the sentence never says the client reported it complete', async () => {
    const node = withMarks(inPlaceMock({ stderr: '', exitCode: 0, bytesWritten: 0 }))
    const rec = recording(node.executor)
    await assert.rejects(runImageRestore(rec.executor, inPlaceDeps(rec.executor, { enabled: true }), () => {}), (err: Error) => {
      assert.match(err.message, /^the client exited 0, but it did not report the restore complete and ANAS cannot count what it wrote: target .* stays disabled and the restore mark on tank\/vol1 now says the image was not verified\./)
      assert.doesNotMatch(err.message, /reported the image complete|verify the LUN's contents/)
      assert.equal((err as Error & { jobErrorCode?: string }).jobErrorCode, 'IMAGE_UNVERIFIED')
      return true
    })
    assert.ok(!enabledBy(rec.calls), 'never re-enabled')
    assert.equal(JSON.parse(node.marks.get('tank/vol1')!).state, 'unverified')
  })

  it('new LUN: exit 0 with no "restore complete" line — not mapped, kept unverified', async () => {
    await withRoot(async (root) => {
      const rec = recording(mockWith(undefined, { stderr: '', exitCode: 0, bytesWritten: 0 }))
      await assert.rejects(runNewLunImageRestore(rec.executor, depsFor(rec, root), () => {}), (err: Error) => {
        assert.match(err.message, /^the client exited 0, but it did not report the restore complete and ANAS cannot count what it wrote, so it was not mapped as a LUN\./)
        assert.equal((err as Error & { jobErrorCode?: string }).jobErrorCode, 'IMAGE_UNVERIFIED')
        return true
      })
      assert.equal(isNewvolLun(replayLio(rec.calls)), false)
      assertNeverExposedHalf(rec.calls)
    })
  })
})
