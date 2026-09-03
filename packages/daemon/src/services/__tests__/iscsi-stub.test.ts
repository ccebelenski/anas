/**
 * Story `iscsi.8` — a stub fileio LUN is never served.
 *
 * The state under test is the one live-proof wave 2 found (F2) and could not
 * see: `targetctl restore` CREATES a missing fileio backing file at the recorded
 * size when the mountpoint directory exists, so the LUN comes up `ACTIVATED`,
 * the right size, with the right serial — and full of zeros. Every existing
 * detector reports a healthy node, and the one signal that moves points the
 * wrong way (the backing no longer resolves onto ANAS storage, so ownership used
 * to flip to `foreign`).
 *
 * The fixtures are a real configfs manifest (materialised from the ground-truth
 * format) plus a FAKE filesystem: a `backing` probe map standing in for `stat`
 * and a `findmnt --json` document standing in for the mount table. Both are the
 * gathered-facts seams the read layer already reads through, so nothing here
 * mocks the code under test — it supplies the two numbers the verdict is made
 * of.
 */

import type { CommandExecutor, ExecResult, ExecStreamResult, PipelineResult } from '../../executor/types.js'
import type { IscsiBackingProbe, IscsiReadContext } from '../iscsi.js'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { parseLioSaveconfig } from '../../parsers/lio-saveconfig.js'
import { readConfigfs } from '../iscsi-configfs.js'
import { computeIscsiHealth } from '../iscsi-health.js'
import { readIscsiHealthWithQuarantine } from '../iscsi-quarantine.js'
import { planIscsiRepair } from '../iscsi-repair.js'
import { fileStubVerdict } from '../iscsi-stub.js'
import { buildIscsiTargets } from '../iscsi.js'
import { mountIndex } from '../nested-filesystems.js'

/** An ANAS-generated IQN, so ownership is ANAS's to lose. */
const IQN = 'iqn.2026-08.dev.anas-pve.anas:lp2'
const IMAGE = '/gtbackup/img2/lpsmall.raw'
const IMAGE_SIZE = 268435456

/**
 * A live tree with ONE fileio LUN, in the ground-truth manifest format.
 *
 * `Size:` in `info` is what LIO reports — and it reports the RECORDED size even
 * when the file behind it is empty, which is exactly why the size has to be read
 * from the filesystem instead.
 */
function manifest(image: string = IMAGE): string {
  const tpg = `iscsi/${IQN}/tpgt_1`
  return [
    'D core',
    'D core/fileio_0',
    'D core/fileio_0/lpsmall',
    `F core/fileio_0/lpsmall/udev_path = ${image}`,
    'F core/fileio_0/lpsmall/enable = 1',
    `F core/fileio_0/lpsmall/info = Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384\\n        TCM FILEIO ID: 0        File: ${image}  Size: ${IMAGE_SIZE}  Mode: O_DSYNC Async: 0`,
    'D core/fileio_0/lpsmall/attrib',
    'F core/fileio_0/lpsmall/attrib/emulate_tpu = 1',
    'F core/fileio_0/lpsmall/attrib/emulate_tpws = 1',
    'F core/fileio_0/lpsmall/attrib/block_size = 512',
    'F core/fileio_0/lpsmall/attrib/emulate_write_cache = 0',
    'D core/fileio_0/lpsmall/wwn',
    'F core/fileio_0/lpsmall/wwn/vpd_unit_serial = T10 VPD Unit Serial Number: 8157f977-1111-2222-3333-444455556666',
    'F core/fileio_0/lpsmall/wwn/product_id = lpsmall',
    'F core/fileio_0/lpsmall/wwn/vendor_id = LIO-ORG',
    'D iscsi',
    `D iscsi/${IQN}`,
    `D ${tpg}`,
    `F ${tpg}/enable = 1`,
    `D ${tpg}/attrib`,
    `F ${tpg}/attrib/authentication = 0`,
    `F ${tpg}/attrib/generate_node_acls = 0`,
    `F ${tpg}/attrib/demo_mode_discovery = 0`,
    `F ${tpg}/dynamic_sessions = `,
    `D ${tpg}/np`,
    `D ${tpg}/np/192.168.200.50:3260`,
    `D ${tpg}/lun`,
    `D ${tpg}/lun/lun_0`,
    `L ${tpg}/lun/lun_0/6847ded961 -> ../../../../../../target/core/fileio_0/lpsmall`,
    `D ${tpg}/acls`,
    '',
  ].join('\n')
}

/** The persisted half — the record a Repair replays and a quarantine must keep. */
function saveconfig(image: string = IMAGE): string {
  return JSON.stringify({
    fabric_modules: [],
    storage_objects: [{
      name: 'lpsmall',
      plugin: 'fileio',
      dev: image,
      size: IMAGE_SIZE,
      wwn: '8157f977-1111-2222-3333-444455556666',
      readonly: false,
      write_back: false,
      attributes: {},
      alua_tpgs: [],
    }],
    targets: [{
      wwn: IQN,
      fabric: 'iscsi',
      parameters: {},
      tpgs: [{
        tag: 1,
        enable: true,
        attributes: { authentication: 0, generate_node_acls: 0, demo_mode_discovery: 0 },
        parameters: {},
        luns: [{ index: 0, storage_object: '/backstores/fileio/lpsmall', alias: '6847ded961' }],
        node_acls: [],
        portals: [{ ip_address: '192.168.200.50', port: 3260 }],
      }],
    }],
  })
}

/**
 * The mount table, as `findmnt --json` prints it.
 *
 * `childMounted: false` is the failure: the dataset that should hold the image
 * did not mount, so the deepest mount containing the path is its PARENT.
 */
function findmnt(childMounted: boolean, base = ''): string {
  const filesystems: unknown[] = [
    { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' },
    { target: `${base}/gtbackup`, source: 'gtbackup', fstype: 'zfs', options: 'rw' },
  ]
  if (childMounted)
    filesystems.push({ target: `${base}/gtbackup/img2`, source: 'gtbackup/img2', fstype: 'zfs', options: 'rw' })
  return JSON.stringify({ filesystems })
}

/** ZFS's own view, rooted under a temp directory for the end-to-end pass. */
function zfsMountpoints(base = '') {
  return [
    { mountpoint: `${base}/gtbackup`, dataset: 'gtbackup', pool: 'gtbackup' },
    { mountpoint: `${base}/gtbackup/img2`, dataset: 'gtbackup/img2', pool: 'gtbackup' },
  ]
}

/** ZFS's own view: the dataset EXISTS with that mountpoint, mounted or not. */
const ZFS_MOUNTPOINTS = [
  { mountpoint: '/gtbackup', dataset: 'gtbackup', pool: 'gtbackup' },
  { mountpoint: '/gtbackup/img2', dataset: 'gtbackup/img2', pool: 'gtbackup' },
]

interface Scenario {
  /** The `stat` answer for the image path. */
  probe: IscsiBackingProbe
  /** Did the child dataset mount? */
  childMounted: boolean
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-stub-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Build the context by hand from the two fixtures plus the fake filesystem. */
async function context(s: Scenario): Promise<IscsiReadContext> {
  const root = join(dir, 'target')
  await materializeConfigfsManifest(manifest(), root)
  return {
    live: await readConfigfs({ root }),
    persisted: parseLioSaveconfig(saveconfig()),
    inputs: { pveStorages: new Map(), zfsMountpoints: ZFS_MOUNTPOINTS },
    nodeAddresses: null,
    backing: new Map([[IMAGE, s.probe]]),
    mounts: mountIndex(findmnt(s.childMounted)),
    stubs: new Map(),
  }
}

describe('fileStubVerdict — the two signals, and what licenses deleting the file', () => {
  const base = {
    backingPath: IMAGE,
    plugin: 'fileio',
    persistedSize: IMAGE_SIZE,
    exists: true as boolean | null,
    actualSize: IMAGE_SIZE as number | null,
    expectedMount: '/gtbackup/img2' as string | null,
    containingMount: '/gtbackup/img2' as string | null,
  }

  it('a real image on the right filesystem is not a stub', () => {
    assert.deepEqual(fileStubVerdict(base), { stub: false, zeroSized: false, wrongMount: false, removable: false })
  })

  it('0 bytes against a recorded size is a stub — one signal, so the file stays', () => {
    const v = fileStubVerdict({ ...base, actualSize: 0 })
    assert.deepEqual(v, { stub: true, zeroSized: true, wrongMount: false, removable: false })
  })

  it('the wrong containing mount is a stub on its own — even at full size', () => {
    const v = fileStubVerdict({ ...base, containingMount: '/gtbackup' })
    assert.deepEqual(v, { stub: true, zeroSized: false, wrongMount: true, removable: false })
  })

  it('both signals together are the only thing that licenses removing the file', () => {
    const v = fileStubVerdict({ ...base, actualSize: 0, containingMount: '/gtbackup' })
    assert.deepEqual(v, { stub: true, zeroSized: true, wrongMount: true, removable: true })
  })

  it('trailing slashes are not a mount mismatch', () => {
    assert.equal(fileStubVerdict({ ...base, containingMount: '/gtbackup/img2/' }).wrongMount, false)
  })

  it('an ABSENT file is an ordinary hole, never a stub', () => {
    assert.equal(fileStubVerdict({ ...base, exists: false, actualSize: null }).stub, false)
  })

  it('a block backing is never a stub — LIO cannot conjure a device node', () => {
    assert.equal(fileStubVerdict({ ...base, plugin: 'block', backingPath: '/dev/zvol/tank/vol1', actualSize: 0 }).stub, false)
  })

  it('withholds every signal it could not measure (fail-open)', () => {
    // Unread size, unknown expected mount, unread mount table: a node whose
    // `findmnt` or `stat` failed must not have its LUNs torn down on a guess.
    assert.equal(fileStubVerdict({ ...base, actualSize: null }).stub, false)
    assert.equal(fileStubVerdict({ ...base, expectedMount: null, containingMount: '/gtbackup' }).stub, false)
    assert.equal(fileStubVerdict({ ...base, containingMount: null }).stub, false)
    // A record with no persisted size cannot say "0 is wrong".
    assert.equal(fileStubVerdict({ ...base, persistedSize: null, actualSize: 0 }).stub, false)
  })
})

describe('the read layer — a stub is `unresolved`, and never costs the target its ownership', () => {
  it('a healthy image LUN reads as a file on its dataset', async () => {
    const targets = await buildIscsiTargets(await context({
      probe: { exists: true, size: IMAGE_SIZE },
      childMounted: true,
    }))
    const lun = targets[0].luns[0]
    assert.equal(lun.kind, 'file')
    assert.equal(lun.backingExists, true)
    assert.equal(targets[0].ownership, 'anas')
    assert.equal(targets[0].ownershipReason, 'anas-managed')
  })

  it('the F2 state: a 0-byte placeholder on the parent filesystem', async () => {
    const ctx = await context({ probe: { exists: true, size: 0 }, childMounted: false })
    const targets = await buildIscsiTargets(ctx)
    const lun = targets[0].luns[0]

    // The LUN is LIVE and LIO reports the full size — that is the whole trap.
    assert.equal(lun.present, true)
    assert.equal(lun.size, IMAGE_SIZE)
    assert.equal(lun.serial, '8157f977-1111-2222-3333-444455556666')

    // …and ANAS calls it what it is.
    assert.equal(lun.kind, 'unresolved')
    assert.equal(lun.backingExists, false, 'the DATA is not on this node, whatever `stat` says')

    // The ownership half of F2: this used to read `foreign` and take the target
    // hands-off at the exact moment it needed managing.
    // The file resolves onto a dataset ANAS manages, so ownership does not even
    // reach the unresolved branch — which is the point: nothing about a
    // placeholder is evidence of anyone else's storage.
    assert.equal(targets[0].ownership, 'anas')
    assert.notEqual(targets[0].ownership, 'foreign')

    const health = computeIscsiHealth(ctx, targets)
    assert.equal(health.stubLuns.length, 1)
    assert.equal(health.degraded, true, 'nothing may run saveconfig over this')
    const stub = health.stubLuns[0]
    assert.equal(stub.targetIqn, IQN)
    assert.equal(stub.lunIndex, 0)
    assert.equal(stub.backstoreName, 'lpsmall')
    assert.equal(stub.persistedSize, IMAGE_SIZE)
    assert.equal(stub.actualSize, 0)
    assert.equal(stub.containingMount, '/gtbackup')
    assert.equal(stub.expectedMount, '/gtbackup/img2')
    assert.equal(stub.zeroSized, true)
    assert.equal(stub.wrongMount, true)
    // Nothing has acted yet — this is the pure diff.
    assert.equal(stub.quarantined, false)
    // It is NOT a missing LUN: the kernel has it. That is the finding.
    assert.equal(health.missingLuns.length, 0)
  })

  it('a full-size file on the WRONG filesystem is a stub too (nobody truncated it)', async () => {
    const ctx = await context({ probe: { exists: true, size: IMAGE_SIZE }, childMounted: false })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.equal(health.stubLuns.length, 1)
    assert.equal(health.stubLuns[0].zeroSized, false)
    assert.equal(health.stubLuns[0].wrongMount, true)
  })

  it('a 0-byte file on the RIGHT filesystem is still a stub — but not a removable one', async () => {
    const ctx = await context({ probe: { exists: true, size: 0 }, childMounted: true })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.equal(health.stubLuns.length, 1)
    assert.equal(health.stubLuns[0].zeroSized, true)
    assert.equal(health.stubLuns[0].wrongMount, false)
  })

  it('an unreadable mount table produces no stub at all (fail-open)', async () => {
    const ctx = await context({ probe: { exists: true, size: IMAGE_SIZE }, childMounted: false })
    ctx.mounts.clear()
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.equal(health.stubLuns.length, 0)
    assert.equal(health.degraded, false)
  })
})

describe('a DISABLED ANAS target is serving nothing, and says so (live-proof F12)', () => {
  it('reports the target, its LUN count, and the reason when a job still has one', async () => {
    const ctx = await context({ probe: { exists: true, size: IMAGE_SIZE }, childMounted: true })
    // The image-restore door leaves a target disabled on purpose after a partial
    // write; nothing else in ANAS turns one off.
    ctx.live.targets[0].tpgs[0].enabled = false
    const targets = await buildIscsiTargets(ctx)
    assert.equal(targets[0].ownership, 'anas')

    const bare = computeIscsiHealth(ctx, targets)
    assert.equal(bare.disabledTargets.length, 1)
    assert.equal(bare.disabledTargets[0].targetIqn, IQN)
    assert.equal(bare.disabledTargets[0].lunCount, 1)
    assert.equal(bare.disabledTargets[0].detail, undefined, 'no job, no invented reason')

    const withJob = computeIscsiHealth(ctx, targets, {
      disabledDetail: t => (t.iqn === IQN ? 'A whole-image restore onto it failed and left it disabled: boom' : undefined),
    })
    assert.match(withJob.disabledTargets[0].detail ?? '', /restore onto it failed/)
  })

  it('an ENABLED target is not a finding, and a foreign one is never ANAS\'s business', async () => {
    const ctx = await context({ probe: { exists: true, size: IMAGE_SIZE }, childMounted: true })
    assert.equal(computeIscsiHealth(ctx, await buildIscsiTargets(ctx)).disabledTargets.length, 0)

    // The same disabled tree under a foreign IQN: hands-off means hands off the
    // enable flag too — somebody else's target being down is not ANAS's finding.
    ctx.live.targets[0].tpgs[0].enabled = false
    ctx.live.targets[0].iqn = 'iqn.2026-08.dev.example:other'
    ctx.persisted!.targets[0].iqn = 'iqn.2026-08.dev.example:other'
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.equal(health.disabledTargets.length, 0)
  })
})

describe('Repair refuses to build a LUN over a placeholder', () => {
  it('treats a stub backing as ABSENT, and says why', async () => {
    // The post-quarantine state: the LUN is gone from configfs, the persisted
    // record still has it, and the 0-byte placeholder is still on disk because
    // only one signal fired.
    const ctx = await context({ probe: { exists: true, size: 0 }, childMounted: true })
    ctx.live.backstores = []
    ctx.live.targets[0].tpgs[0].luns = []
    const targets = await buildIscsiTargets(ctx)
    const health = computeIscsiHealth(ctx, targets)

    assert.equal(health.missingLuns.length, 1, 'now it IS an honest hole')
    assert.equal(health.missingLuns[0].backingExists, false)
    // …but a hole that still has a placeholder sitting at its path, and it keeps
    // saying so: the quarantine is the reason the LUN is missing, and "bring the
    // storage back" reads wrong when there is visibly a file there.
    assert.equal(health.missingLuns[0].stubBacking, true)
    assert.equal(health.stubLuns.length, 0, 'and no longer reported as a stub — nothing is being served')

    const plan = planIscsiRepair(ctx, health, targets)
    assert.equal(plan.repairable.length, 0)
    assert.equal(plan.blocked.length, 1)
    assert.equal(plan.blocked[0].stubBacking, true)
  })
})

describe('quarantine — unmap that LUN, delete the stub backstore, never saveconfig', () => {
  /** Records every targetcli invocation; `ip`/`findmnt` answer emptily. */
  function recorder(calls: string[][], failOn?: string): CommandExecutor {
    return {
      async exec(command: string, args: string[] = []): Promise<ExecResult> {
        if (command.endsWith('targetcli')) {
          calls.push(args)
          if (failOn && args.join(' ').includes(failOn))
            return { stdout: '', stderr: 'targetcli refused', exitCode: 1 }
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 1 }
      },
      async pipeline(): Promise<PipelineResult> {
        return { leftExitCode: 1, rightExitCode: 1, leftStderr: '', rightStderr: '', stdout: '' }
      },
      async execToStream(): Promise<ExecStreamResult> {
        return { stderr: '', exitCode: 1, bytesWritten: 0 }
      },
    }
  }

  /**
   * Point the read layer at the fixtures through the real seams, so the
   * quarantine's own re-reads work: the configfs tree, the saveconfig file, the
   * `stat` answers and the mount table all arrive the way production supplies
   * them.
   */
  async function paths(s: Scenario & { bytes?: number, iqn?: string }) {
    const root = join(dir, 'target')
    const image = join(dir, 'gtbackup', 'img2', 'lpsmall.raw')
    // A different IQN rewrites BOTH halves of the fixture: the live tree and the
    // persisted record must agree on whose target it is, or the read layer sees
    // a diff that has nothing to do with the case under test.
    const iqn = s.iqn ?? IQN
    await materializeConfigfsManifest(manifest(image).replaceAll(IQN, iqn), root)
    await mkdir(join(dir, 'gtbackup', 'img2'), { recursive: true })
    // A REAL file on a real filesystem: the `stat` and the `unlink` are the
    // production ones, so "only a 0-byte file is ever removed" is proven rather
    // than asserted against a mock.
    await writeFile(image, Buffer.alloc(s.bytes ?? 0))
    const savePath = join(dir, 'saveconfig.json')
    await writeFile(savePath, saveconfig(image).replaceAll(IQN, iqn))
    return {
      image,
      paths: {
        configfsRoot: root,
        saveconfigPath: savePath,
        pveStorageCfg: join(dir, 'no-such-storage.cfg'),
        findmnt: async () => findmnt(s.childMounted, dir),
        zfsMountpoints: async () => zfsMountpoints(dir),
      },
    }
  }

  it('does nothing at all when nothing is a stub', async () => {
    const calls: string[][] = []
    const { paths: p } = await paths({ probe: { exists: true, size: IMAGE_SIZE }, childMounted: true, bytes: IMAGE_SIZE })
    const { outcomes, health } = await readIscsiHealthWithQuarantine(recorder(calls), { ...p, log: () => {} })
    assert.deepEqual(outcomes, [])
    assert.deepEqual(calls, [], 'a healthy node never runs targetcli from a READ')
    assert.equal(health.degraded, false)
  })

  it('unmaps ONLY that LUN, deletes its backstore and the placeholder — and never saves', async () => {
    const calls: string[][] = []
    const logged: string[] = []
    const { image, paths: p } = await paths({ probe: { exists: true, size: 0 }, childMounted: false })
    const { outcomes, health } = await readIscsiHealthWithQuarantine(
      recorder(calls),
      { ...p, log: (l: string) => logged.push(l) },
    )

    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].quarantined, true)
    assert.equal(outcomes[0].lunIndex, 0)
    assert.deepEqual(calls, [
      [`/iscsi/${IQN}/tpg1/luns`, 'delete', 'lun0'],
      ['/backstores/fileio', 'delete', 'lpsmall'],
    ])
    // GT-22, restated for this story: the persisted record is what Repair
    // replays. A save here would erase the LUN for good.
    assert.ok(!calls.some(c => c.includes('saveconfig')), 'saveconfig is the one call that must never happen')

    // Both signals agreed, so the placeholder itself goes.
    assert.equal(outcomes[0].fileRemoved, true)
    assert.equal(existsSync(image), false)

    // Still degraded, and the pass that found the placeholder still EXPLAINS it:
    // by the next read it is an ordinary hole and the explanation would be gone.
    // (What the live tree looks like afterwards is proven in the Repair suite
    // above — `targetcli` is a recorder here, so configfs does not actually
    // change.)
    assert.equal(health.degraded, true)
    assert.equal(health.stubLuns.length, 1)
    assert.equal(health.stubLuns[0].quarantined, true)
    assert.equal(health.stubLuns[0].fileRemoved, true)

    // The audit line carries the numbers that decided it, not just a verdict.
    assert.equal(logged.length, 1)
    assert.match(logged[0], /^iscsi\.quarantine /)
    assert.match(logged[0], /zeroSized=true wrongMount=true/)
    assert.match(logged[0], /result=unmapped fileRemoved=true/)
    assert.match(logged[0], /lun=0 backstore=lpsmall/)
  })

  it('NEVER removes a file with content, even when it unmaps the LUN', async () => {
    const calls: string[][] = []
    // Full size, wrong filesystem: one signal. Somebody's bytes are in there.
    const { image, paths: p } = await paths({ probe: { exists: true, size: IMAGE_SIZE }, childMounted: false, bytes: 4096 })
    const { outcomes } = await readIscsiHealthWithQuarantine(recorder(calls), { ...p, log: () => {} })
    assert.equal(outcomes[0].quarantined, true)
    assert.equal(outcomes[0].fileRemoved, false)
    assert.equal(existsSync(image), true)
  })

  it('is idempotent — the second pass finds an ordinary hole and runs nothing', async () => {
    const calls: string[][] = []
    const { paths: p } = await paths({ probe: { exists: true, size: 0 }, childMounted: false })
    await readIscsiHealthWithQuarantine(recorder(calls), { ...p, log: () => {} })
    const before = calls.length
    // The recorder is a fake, so configfs still shows the LUN; what must NOT
    // repeat is the tear-down of a LUN whose file is already gone.
    const second = await readIscsiHealthWithQuarantine(recorder(calls), { ...p, log: () => {} })
    assert.equal(calls.length, before, 'nothing more was run')
    assert.equal(second.outcomes.length, 0)
  })

  it('reports the failure instead of pretending, when targetcli refuses', async () => {
    const calls: string[][] = []
    const { image, paths: p } = await paths({ probe: { exists: true, size: 0 }, childMounted: false })
    const { outcomes, health } = await readIscsiHealthWithQuarantine(
      recorder(calls, 'luns delete'),
      { ...p, log: () => {} },
    )
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].quarantined, false)
    assert.match(outcomes[0].error ?? '', /targetcli refused/)
    // The file is untouched: a LUN that is still mapped still owns its backing.
    assert.equal(existsSync(image), true)
    // Still reported, still degraded — and the card will say ANAS could not.
    assert.equal(health.stubLuns.length, 1)
    assert.equal(health.stubLuns[0].quarantined, false)
    assert.equal(health.degraded, true)
  })

  it('leaves a FOREIGN target\'s stub alone — reported, never acted on (issue #54)', async () => {
    const calls: string[][] = []
    const logged: string[] = []
    // Foreign by IQN shape: the same placeholder tree the pass above tears
    // down, under an IQN ANAS did not generate.
    const foreignIqn = 'iqn.2026-08.dev.example:other'
    const { image, paths: p } = await paths({
      probe: { exists: true, size: 0 },
      childMounted: false,
      iqn: foreignIqn,
    })
    const { outcomes, health } = await readIscsiHealthWithQuarantine(
      recorder(calls),
      { ...p, log: (l: string) => logged.push(l) },
    )

    // The hands-off gate: no targetcli call at all, and the file stays — both
    // stub signals agree here, so on an ANAS target this same pass unmaps,
    // deletes the backstore AND unlinks the placeholder.
    assert.deepEqual(calls, [], 'somebody else\'s LUN is not unmapped from a READ')
    assert.equal(existsSync(image), true, 'nobody\'s file is unlinked either')

    // Still REPORTED — the stub verdict is ownership-blind — with the pure
    // diff's card: `quarantined: false` means nothing was attempted, not that
    // ANAS tried and failed. And no outcome: an outcome reads as "ANAS took it
    // offline", which the boot scan counts and says.
    assert.deepEqual(outcomes, [])
    assert.equal(health.degraded, true)
    assert.equal(health.stubLuns.length, 1)
    assert.equal(health.stubLuns[0].targetIqn, foreignIqn)
    assert.equal(health.stubLuns[0].quarantined, false)
    assert.equal(health.stubLuns[0].fileRemoved, false)

    // The skip is told in journald, with the ownership derivation that decided
    // it — `result=skipped`, never `failed`, which would claim an attempt.
    assert.equal(logged.length, 1)
    assert.match(logged[0], /^iscsi\.quarantine /)
    assert.match(logged[0], /result=skipped/)
    assert.match(logged[0], /iqn-not-anas/)
  })

  it('a node with no LIO tree quarantines nothing and does not throw', async () => {
    const calls: string[][] = []
    const { health, outcomes } = await readIscsiHealthWithQuarantine(recorder(calls), {
      configfsRoot: join(dir, 'nothing-here'),
      saveconfigPath: join(dir, 'nothing-here.json'),
      log: () => {},
    })
    assert.equal(health.installed, false)
    assert.deepEqual(outcomes, [])
    assert.deepEqual(calls, [])
  })
})
