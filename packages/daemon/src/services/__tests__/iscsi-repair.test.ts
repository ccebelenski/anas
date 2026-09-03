/**
 * The repair door — planning and the exact replay (story `iscsi.5`).
 *
 * Two things are under test and both are load-bearing:
 *
 *  1. **The preflight.** A hole is only repairable when its backing device is
 *     BACK. Recreating a backstore over an absent device is exactly what made
 *     the hole, so "still missing" is a refusal that NAMES the paths.
 *  2. **The replay argv.** Repair is not `targetctl restore` — that call takes
 *     rtslib's `clear_existing=True` default and wipes the whole live tree,
 *     dropping every healthy LUN's sessions with it. So repair is a surgical
 *     recreate from the PERSISTED record, and its identity contract is the same
 *     one every other recreate path signs: `wwn=` at create (create-only, no
 *     `set` verb — GT-16) plus EVERY attribute replayed (they come back at stock
 *     defaults otherwise — GT-18), `block_size` first and the whole set applied
 *     BEFORE the map (GT-27), then the map at the STORED index and a re-grant to
 *     every ACL that had it.
 *
 * And the rule that outranks both: **never `saveconfig` while anything is still
 * missing** (GT-22) — a save over an incomplete restore writes the hole into
 * `saveconfig.json` permanently.
 */

import type { IscsiHealth, IscsiTargetDetail } from '@anas/shared'
import type { LioSaveconfig } from '../../parsers/lio-saveconfig.js'
import type { IscsiReadContext } from '../iscsi.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { parseLioSaveconfig } from '../../parsers/lio-saveconfig.js'
import { computeIscsiHealth } from '../iscsi-health.js'
import { TARGETCLI } from '../iscsi-mutate.js'
import { assertRepairable, planIscsiRepair, repairIscsiHoles } from '../iscsi-repair.js'
import { buildIscsiTargets, readIscsiContext } from '../iscsi.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')
const IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

function okExecutor(): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
  return mock
}

function targetcliCalls(mock: MockExecutor): string[] {
  const calls = mock.calls.filter(c => c.command === TARGETCLI)
  return calls.map(c => c.args.join(' '))
}

/**
 * The real restore-hole state, built from the real captures: `saveconfig-final`
 * has both LUNs, the materialised configfs has only the fileio one because the
 * block backing device was missing at restore.
 */
async function holeState(): Promise<{
  ctx: IscsiReadContext
  targets: IscsiTargetDetail[]
  health: IscsiHealth
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-repair-'))
  const root = join(dir, 'target')
  await materializeConfigfsManifest(loadFixture('configfs-restore-hole.manifest'), root)
  const blockRoot = join(dir, 'block')
  await mkdir(join(blockRoot, 'zd16'), { recursive: true })
  await writeFile(join(blockRoot, 'zd16', 'size'), '4194304\n')

  const ctx = await readIscsiContext(new MockExecutor(), {
    configfsRoot: root,
    blockRoot,
    saveconfigPath: join(fixturesDir, 'saveconfig-final.json'),
    pveStorageCfg: join(fixturesDir, 'no-such-storage.cfg'),
  })
  const targets = await buildIscsiTargets(ctx)
  return { ctx, targets, health: computeIscsiHealth(ctx, targets), dir }
}

/** The same state, with the backing device declared BACK. */
function withBackingPresent(health: IscsiHealth): IscsiHealth {
  return { ...health, missingLuns: health.missingLuns.map(l => ({ ...l, backingExists: true })) }
}

// ---------------------------------------------------------------------------

describe('planIscsiRepair — the plan comes from the PERSISTED record', () => {
  it('reads serial, size, write_back and attributes off saveconfig.json', async () => {
    const s = await holeState()
    try {
      const plan = planIscsiRepair(s.ctx, withBackingPresent(s.health), s.targets)
      assert.equal(plan.repairable.length, 1)
      assert.equal(plan.blocked.length, 0)
      const item = plan.repairable[0]
      assert.equal(item.targetIqn, IQN)
      assert.equal(item.tpgTag, 1)
      assert.equal(item.lunIndex, 0)
      assert.equal(item.backstoreName, 'gtiscsi_vol1')
      assert.equal(item.plugin, 'block')
      assert.equal(item.backingPath, '/dev/zvol/gtiscsi/vol1')
      // The whole point: the same disk comes back.
      assert.equal(item.serial, '9bc6e907-6015-4267-be4f-5a0617cb3d71')
      assert.equal(item.attributes.emulateTpu, true)
      assert.equal(item.attributes.emulateTpws, true)
      assert.equal(item.attributes.maxUnmapLbaCount, 524288)
      assert.equal(item.attributes.blockSize, 512)
      assert.equal(item.attributes.writeBack, false)
      // Both ACLs in the captured config mapped LUN 0.
      // eslint-disable-next-line e18e/prefer-array-to-sorted -- toSorted() is ES2023; this package targets ES2022 (no such lib member)
      const acls = [...item.aclInitiators].sort()
      assert.deepEqual(acls, ['iqn.1993-08.org.debian:01:ae3d2ec18ad', 'iqn.2026-08.dev.anas.gtiscsi:allowed2'])
    }
    finally {
      await rm(s.dir, { recursive: true, force: true })
    }
  })

  it('an absent backing device lands in `blocked`, never in `repairable`', async () => {
    const s = await holeState()
    try {
      // The real state: /dev/zvol/gtiscsi/vol1 does not exist on this machine.
      assert.equal(s.health.missingLuns[0].backingExists, false)
      const plan = planIscsiRepair(s.ctx, s.health, s.targets)
      assert.equal(plan.repairable.length, 0)
      assert.equal(plan.blocked.length, 1)
      assert.equal(plan.blocked[0].backingPath, '/dev/zvol/gtiscsi/vol1')
    }
    finally {
      await rm(s.dir, { recursive: true, force: true })
    }
  })

  it('"we could not tell" (null) counts as absent, not as present', async () => {
    const s = await holeState()
    try {
      const unknown: IscsiHealth = {
        ...s.health,
        missingLuns: s.health.missingLuns.map(l => ({ ...l, backingExists: null })),
      }
      const plan = planIscsiRepair(s.ctx, unknown, s.targets)
      assert.equal(plan.repairable.length, 0)
      assert.equal(plan.blocked.length, 1)
    }
    finally {
      await rm(s.dir, { recursive: true, force: true })
    }
  })
})

describe('assertRepairable — the guiding 409', () => {
  it('nothing to repair when the tree already matches', () => {
    const refusal = assertRepairable({ repairable: [], blocked: [] })
    assert.equal(refusal?.reason, 'nothing-to-repair')
    assert.match(refusal!.message, /already matches the saved one/)
  })

  it('refuses while the devices are still absent, NAMING every path', async () => {
    const s = await holeState()
    try {
      const refusal = assertRepairable(planIscsiRepair(s.ctx, s.health, s.targets))
      assert.equal(refusal?.reason, 'backing-absent')
      assert.match(refusal!.message, /LUN 0 of iqn\.2026-08\.dev\.anas\.gtiscsi:target1/)
      assert.match(refusal!.message, /gtiscsi_vol1/)
      assert.match(refusal!.message, /\/dev\/zvol\/gtiscsi\/vol1/)
      // …and says what to do about it.
      assert.match(refusal!.message, /import the pool, restore the image/)
    }
    finally {
      await rm(s.dir, { recursive: true, force: true })
    }
  })

  it('allows the repair the moment ONE hole has its backing back', async () => {
    const s = await holeState()
    try {
      const plan = planIscsiRepair(s.ctx, withBackingPresent(s.health), s.targets)
      assert.equal(assertRepairable(plan), null)
    }
    finally {
      await rm(s.dir, { recursive: true, force: true })
    }
  })
})

describe('repairIscsiHoles — the exact replay argv', () => {
  it('creates with wwn=, replays every attribute, maps at the STORED index, re-grants', async () => {
    const s = await holeState()
    try {
      const mock = okExecutor()
      const plan = planIscsiRepair(s.ctx, withBackingPresent(s.health), s.targets)
      const result = await repairIscsiHoles({ executor: mock }, plan)

      assert.deepEqual(targetcliCalls(mock), [
        // create — `wwn=` is create-only (GT-16), so identity rides the create line
        '/backstores/block create name=gtiscsi_vol1 dev=/dev/zvol/gtiscsi/vol1 wwn=9bc6e907-6015-4267-be4f-5a0617cb3d71',
        // every attribute, block_size FIRST and all of them BEFORE the map (GT-27)
        '/backstores/block/gtiscsi_vol1 set attribute block_size=512',
        '/backstores/block/gtiscsi_vol1 set attribute emulate_tpu=1',
        '/backstores/block/gtiscsi_vol1 set attribute emulate_tpws=1',
        '/backstores/block/gtiscsi_vol1 set attribute max_unmap_lba_count=524288',
        '/backstores/block/gtiscsi_vol1 set attribute emulate_write_cache=0',
        // the SAME LUN index the saved config had
        `/iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/gtiscsi_vol1 lun=0`,
        // and back into both ACLs that mapped it, at the same number, in the
        // order the saved configuration lists them
        `/iscsi/${IQN}/tpg1/acls/iqn.2026-08.dev.anas.gtiscsi:allowed2 create 0 0`,
        `/iscsi/${IQN}/tpg1/acls/iqn.1993-08.org.debian:01:ae3d2ec18ad create 0 0`,
        // …and only THEN the save, because nothing is missing any more (GT-22)
        'saveconfig',
      ])

      assert.equal(result.repaired.length, 1)
      assert.equal(result.repaired[0].serialReplayed, true)
      assert.deepEqual(result.stillMissing, [])
      assert.equal(result.saved, true)
    }
    finally {
      await rm(s.dir, { recursive: true, force: true })
    }
  })

  it('does not re-grant a mapped LUN targetcli already auto-added (live-proof wave 2)', async () => {
    // GT-7: `auto_add_mapped_luns` is true by default, so the `/luns create`
    // above has already put the LUN back into every ACL. A blind
    // `acls/<iqn> create n n` then fails with `This MappedLUN already exists in
    // configFS` and takes the whole repair down — live-proven on the stunt node,
    // where Repair after a pool re-import failed exactly this way. The shared
    // grant helper reads the ACL's live mapped set first.
    const s = await holeState()
    try {
      const root = join(s.dir, 'target')
      for (const initiator of ['iqn.2026-08.dev.anas.gtiscsi:allowed2', 'iqn.1993-08.org.debian:01:ae3d2ec18ad'])
        await mkdir(join(root, 'iscsi', IQN, 'tpgt_1', 'acls', initiator, 'lun_0'), { recursive: true })
      const mock = okExecutor()
      const plan = planIscsiRepair(s.ctx, withBackingPresent(s.health), s.targets)
      const result = await repairIscsiHoles({ executor: mock, configfsRoot: root }, plan)

      const calls = targetcliCalls(mock)
      assert.equal(calls.filter(c => c.includes('/acls/')).length, 0, 'no mapped-LUN create was issued')
      assert.equal(calls.at(-1), 'saveconfig')
      assert.equal(result.saved, true)
      assert.deepEqual(result.stillMissing, [])
    }
    finally {
      await rm(s.dir, { recursive: true, force: true })
    }
  })

  it('NEVER runs saveconfig while a hole is left (GT-22)', async () => {
    // Two holes, one device back. The repaired LUN goes in; the save does not
    // happen, because saving now would write the OTHER hole into
    // saveconfig.json permanently.
    const ctx = twoHoleCtx()
    const health = twoHoleHealth([true, false])
    const plan = planIscsiRepair(ctx, health, [])
    assert.equal(plan.repairable.length, 1)
    assert.equal(plan.blocked.length, 1)

    const mock = okExecutor()
    const result = await repairIscsiHoles({ executor: mock }, plan)
    assert.equal(result.repaired.length, 1)
    assert.equal(result.stillMissing.length, 1)
    assert.equal(result.saved, false)
    assert.equal(targetcliCalls(mock).includes('saveconfig'), false)
  })

  it('saveconfig runs exactly once, last, after a FULL repair', async () => {
    const ctx = twoHoleCtx()
    const plan = planIscsiRepair(ctx, twoHoleHealth([true, true]), [])
    const mock = okExecutor()
    const result = await repairIscsiHoles({ executor: mock }, plan)
    const calls = targetcliCalls(mock)
    assert.equal(result.saved, true)
    assert.equal(calls.filter(c => c === 'saveconfig').length, 1)
    assert.equal(calls.at(-1), 'saveconfig')
  })

  it('a fileio hole is recreated with its size and write_back on the create line', async () => {
    const ctx = twoHoleCtx()
    const plan = planIscsiRepair(ctx, twoHoleHealth([false, true]), [])
    const mock = okExecutor()
    await repairIscsiHoles({ executor: mock }, plan)
    assert.equal(
      targetcliCalls(mock)[0],
      '/backstores/fileio create name=img1 file_or_dev=/tank/images/img1.raw size=268435456 write_back=false wwn=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
  })

  it('a record with no stored serial is recreated WITHOUT wwn= and says so', async () => {
    // The one case where identity cannot be replayed. It is reported, not
    // papered over: the disk that comes back is a different disk to its
    // initiator, and the job result has to admit that.
    const ctx = twoHoleCtx({ dropSerial: true })
    const plan = planIscsiRepair(ctx, twoHoleHealth([true, false]), [])
    const mock = okExecutor()
    const result = await repairIscsiHoles({ executor: mock }, plan)
    assert.equal(targetcliCalls(mock)[0], '/backstores/block create name=vol1 dev=/dev/zvol/tank/vol1')
    assert.equal(result.repaired[0].serialReplayed, false)
  })

  // C3: `size=${item.size ?? 0}` did not refuse — `targetcli` CREATES a 0-byte
  // file at the image's path and serves it with the right serial, which is the
  // placeholder story `iscsi.8` exists to take away, made this time by ANAS.
  it('a fileio record with NO persisted size is BLOCKED, never created at size=0 (C3)', async () => {
    const ctx = twoHoleCtx({ dropSize: true })
    // The fileio backing is BACK — the only thing standing in the way is the
    // record itself, which is the whole point of the case.
    const plan = planIscsiRepair(ctx, twoHoleHealth([false, true]), [])
    assert.equal(plan.repairable.length, 0)
    const sizeless = plan.blocked.find(b => b.backstoreName === 'img1')
    assert.ok(sizeless, JSON.stringify(plan.blocked))
    assert.equal(sizeless.backingPresent, true, 'the backing is present — the RECORD is what blocks it')
    assert.equal(sizeless.size, null)
    assert.match(sizeless.blockedReason ?? '', /no size/)

    const mock = okExecutor()
    const result = await repairIscsiHoles({ executor: mock }, plan)
    assert.deepEqual(result.repaired, [])
    assert.equal(result.saved, false)
    assert.equal(targetcliCalls(mock).length, 0, JSON.stringify(targetcliCalls(mock)))
    assert.ok(!targetcliCalls(mock).some(c => /size=0/.test(c)), 'no 0-byte placeholder may be created')
  })

  it('the 409 for a size-less record NAMES the missing size, not "import the pool"', () => {
    const ctx = twoHoleCtx({ dropSize: true })
    const both = twoHoleHealth([true, true])
    // ONLY the fileio hole: the other one is repairable and would carry the
    // ordinary absent-backing sentence.
    const plan = planIscsiRepair(ctx, { ...both, missingLuns: [both.missingLuns[1]] }, [])
    const refusal = assertRepairable(plan)
    assert.ok(refusal)
    assert.equal(refusal.reason, 'record-incomplete')
    assert.match(refusal.message, /no size/)
    assert.match(refusal.message, /img1/)
    assert.doesNotMatch(refusal.message, /import the pool/)
  })

  it('never issues `targetctl restore` or a service restart', async () => {
    // rtslib's restore takes clear_existing=True and wipes the whole live tree,
    // dropping every healthy LUN's sessions. Repair is surgical, by design.
    const ctx = twoHoleCtx()
    const plan = planIscsiRepair(ctx, twoHoleHealth([true, true]), [])
    const mock = okExecutor()
    await repairIscsiHoles({ executor: mock }, plan)
    for (const call of mock.calls) {
      assert.doesNotMatch(call.command, /targetctl$|systemctl/)
      assert.equal(call.args.includes('restore'), false)
    }
  })
})

// ---------------------------------------------------------------------------
// A synthetic two-hole state: one block LUN and one fileio LUN, both persisted,
// neither live. Small on purpose — the argv is what matters, and the real
// captures already cover the parse.
// ---------------------------------------------------------------------------

const TWO_HOLE_SAVECONFIG = {
  fabric_modules: [],
  storage_objects: [
    {
      name: 'vol1',
      plugin: 'block',
      dev: '/dev/zvol/tank/vol1',
      wwn: '11111111-2222-3333-4444-555555555555',
      attributes: { block_size: 512, emulate_tpu: 1, emulate_tpws: 1, max_unmap_lba_count: 524288, emulate_write_cache: 0 },
    },
    {
      name: 'img1',
      plugin: 'fileio',
      dev: '/tank/images/img1.raw',
      wwn: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      size: 268435456,
      write_back: false,
      attributes: { block_size: 512, emulate_tpu: 1, emulate_tpws: 1, max_unmap_lba_count: 262144, emulate_write_cache: 0 },
    },
  ],
  targets: [{
    wwn: IQN,
    fabric: 'iscsi',
    tpgs: [{
      tag: 1,
      enable: true,
      attributes: { authentication: 0, generate_node_acls: 0, demo_mode_discovery: 0 },
      parameters: {},
      luns: [
        { index: 0, storage_object: '/backstores/block/vol1' },
        { index: 1, storage_object: '/backstores/fileio/img1' },
      ],
      node_acls: [{
        node_wwn: 'iqn.1993-08.org.debian:01:aaaaaaaaaaaa',
        mapped_luns: [{ index: 0, tpg_lun: 0 }, { index: 1, tpg_lun: 1 }],
      }],
      portals: [{ ip_address: '192.168.200.50', port: 3260 }],
    }],
  }],
}

function twoHoleCtx(opts: { dropSerial?: boolean, dropSize?: boolean } = {}): IscsiReadContext {
  const raw = JSON.parse(JSON.stringify(TWO_HOLE_SAVECONFIG))
  if (opts.dropSerial)
    delete raw.storage_objects[0].wwn
  // A fileio record whose `size` the saved configuration does not carry (C3).
  if (opts.dropSize)
    delete raw.storage_objects[1].size
  const persisted: LioSaveconfig = parseLioSaveconfig(JSON.stringify(raw))
  return {
    // Live: the target is up, but neither backstore nor LUN restored.
    live: { present: true, backstores: [], targets: [] },
    persisted,
    inputs: { pveStorages: new Map(), zfsMountpoints: [] },
    nodeAddresses: null,
    backing: new Map(),
    mounts: new Map(),
    stubs: new Map(),
  } as IscsiReadContext
}

/** The health diff for the synthetic state; `present` is per LUN, in order. */
function twoHoleHealth(present: [boolean, boolean]): IscsiHealth {
  return {
    installed: true,
    configfsPresent: true,
    saveconfigPresent: true,
    missingLuns: [
      { targetIqn: IQN, tpgTag: 1, lunIndex: 0, backstoreName: 'vol1', plugin: 'block', backingPath: '/dev/zvol/tank/vol1', backingExists: present[0] },
      { targetIqn: IQN, tpgTag: 1, lunIndex: 1, backstoreName: 'img1', plugin: 'fileio', backingPath: '/tank/images/img1.raw', backingExists: present[1] },
    ],
    targetsServingNothing: [{ targetIqn: IQN, tpgTag: 1, persistedLunCount: 2, enabled: true }],
    stubLuns: [],
    disabledTargets: [],
    portalsWithoutInterface: [],
    foreignChanges: [],
    degraded: true,
    interfacesUnknown: true,
    checkedAt: '2026-08-25T20:00:00.000Z',
  }
}
