/**
 * cr3.iscsi — the mutation sequences' findings of the 2026-11-14 review, each
 * pinned by the probe that reproduced it (a MockExecutor, scratch files only).
 */
import type { IscsiTargetDetail } from '@anas/shared'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { zfsSnapshotListArgs } from '../../parsers/zfs-list.js'
import { lunsMappingBackstore } from '../iscsi-configfs.js'
import { lunDeleteSpec, zvolSnapshotNames } from '../iscsi-guard.js'
import { computeIscsiHealth } from '../iscsi-health.js'
import { holeRepairVerdict } from '../iscsi-hole.js'
import { assertSaveable, createSparseImage, deleteIscsiLun, resizeFileLun, runTargetcli, TARGETCLI, TargetcliArgError, updateIscsiTarget, ZFS } from '../iscsi-mutate.js'
import { assertRepairable, planIscsiRepair, repairIscsiHoles } from '../iscsi-repair.js'
import { aclNamesRefusal, backingPathRefusal, configshellSafe } from '../iscsi-rules.js'
import { buildIscsiTargets } from '../iscsi.js'
import { readPveFirewallAdvisory } from '../pve-firewall.js'
import { contextOf, holeIoFor } from './lio-model.js'

const IQN = 'iqn.2026-08.nas.anas:vmstore'

function okExecutor(): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
  return mock
}

function argv(mock: MockExecutor): string[] {
  return mock.calls.map(c => `${c.command === TARGETCLI ? 'targetcli' : c.command === ZFS ? 'zfs' : c.command} ${c.args.join(' ')}`)
}

function target(): IscsiTargetDetail {
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
    aclCount: 0,
    sessionCount: 0,
    security: { authentication: false, generateNodeAcls: false, demoModeDiscovery: false },
    present: true,
    persisted: true,
    missingLunCount: 0,
    portalsWithoutInterfaceCount: 0,
    luns: [],
    acls: [],
    sessions: [],
  }
}

describe('ISCSI-M3 — a backing that will not go never leaves a restore hole', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-iscsi-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('LUN delete saves BEFORE the destroy; a failed zfs destroy says "LUN deleted, backing kept"', async () => {
    // RED before: the order was unmap, delete backstore, zfs destroy, save —
    // the failed destroy threw before the save, so saveconfig.json still had
    // the LUN, the live tree did not, and the node was degraded (the probe).
    const mock = okExecutor()
    mock.addFixture({ command: ZFS, args: ['destroy', '--', 'tank/vol1'], result: { stdout: '', stderr: 'cannot destroy \'tank/vol1\': dataset is busy\n', exitCode: 1 } })
    await assert.rejects(
      () => deleteIscsiLun({ executor: mock }, target(), { index: 0, name: 'vmdisk1', plugin: 'block', kind: 'zvol', backingPath: '/dev/zvol/tank/vol1', dataset: 'tank/vol1' }, true),
      /^Error: LUN 0 deleted, backing kept: cannot destroy 'tank\/vol1': dataset is busy\./,
    )
    assert.deepEqual(argv(mock), [
      `targetcli /iscsi/${IQN}/tpg1/luns delete lun0`,
      'targetcli /backstores/block delete vmdisk1',
      'targetcli saveconfig',
      'zfs destroy -- tank/vol1',
    ])
  })

  it('an image file that will not unlink: the save already happened, the sentence names the file', async () => {
    const mock = okExecutor()
    const image = join(dir, 'missing-dir', 'img.raw')
    await assert.rejects(
      () => deleteIscsiLun({ executor: mock }, target(), { index: 2, name: 'img', plugin: 'fileio', kind: 'file', backingPath: image }, true),
      (err: Error) => err.message.startsWith('LUN 2 deleted, backing kept: ') && err.message.includes(image),
    )
    assert.equal(argv(mock).at(-1), 'targetcli saveconfig')
  })

  it('a file-LUN resize grows the file FIRST: a grow that fails touches no LUN', async () => {
    // RED before: the unmap and the backstore delete ran first, and a grow
    // that failed left the LUN live-gone and persisted — a restore hole.
    const mock = okExecutor()
    await assert.rejects(() => resizeFileLun(
      { executor: mock },
      target(),
      { index: 0, name: 'img', backingPath: join(dir, 'no-such.raw'), serial: 's', attributes: { emulateTpu: true, emulateTpws: true, maxUnmapLbaCount: 1, writeBack: false } },
      2048,
    ))
    assert.deepEqual(argv(mock), [])
  })

  it('zvolSnapshotNames: a failed list is UNKNOWN (null), never "no snapshots"; an absent volume has none', async () => {
    const failed = new MockExecutor()
    failed.addFixture({ command: ZFS, args: zfsSnapshotListArgs('tank/vol1'), result: { stdout: '', stderr: 'internal error: something\n', exitCode: 1 } })
    assert.equal(await zvolSnapshotNames(failed, 'tank/vol1'), null)
    const absent = new MockExecutor()
    absent.addFixture({ command: ZFS, args: zfsSnapshotListArgs('tank/gone'), result: { stdout: '', stderr: 'cannot open \'tank/gone\': dataset does not exist\n', exitCode: 1 } })
    assert.deepEqual(await zvolSnapshotNames(absent, 'tank/gone'), [])
    const garbled = new MockExecutor()
    garbled.addFixture({ command: ZFS, args: zfsSnapshotListArgs('tank/vol1'), result: { stdout: 'not json', stderr: '', exitCode: 0 } })
    assert.equal(await zvolSnapshotNames(garbled, 'tank/vol1'), null)
  })
})

describe('ISCSI-M6 — a backstore another LUN maps is not one LUN\'s to delete', () => {
  const OTHER = 'iqn.2003-01.org.linux-iscsi.pve.x8664:sn.0123456789ab'
  const live = {
    present: true,
    backstores: [],
    targets: [
      { iqn: IQN, tpgs: [{ tag: 1, enabled: true, authentication: false, generateNodeAcls: false, demoModeDiscovery: false, portals: [], luns: [{ index: 0, backstoreName: 'shared', plugin: 'block' }], acls: [], dynamicSessionsRaw: '' }] },
      { iqn: OTHER, tpgs: [{ tag: 1, enabled: true, authentication: false, generateNodeAcls: false, demoModeDiscovery: false, portals: [], luns: [{ index: 3, backstoreName: 'shared', plugin: 'block' }], acls: [], dynamicSessionsRaw: '' }] },
    ],
  }

  it('lunsMappingBackstore names every OTHER LUN that maps it, never the one being removed', () => {
    assert.deepEqual(lunsMappingBackstore(live, 'block', 'shared', { targetIqn: IQN, tpgTag: 1, lunIndex: 0 }), [{ targetIqn: OTHER, tpgTag: 1, lunIndex: 3 }])
    assert.deepEqual(lunsMappingBackstore(live, 'block', 'nobody'), [])
    // The configfs spelling of a block plugin is `iblock`: the same object.
    assert.equal(lunsMappingBackstore(live, 'iblock', 'shared', { targetIqn: IQN, tpgTag: 1, lunIndex: 0 }).length, 1)
  })

  it('a FILEIO backstore sharing a name with a block one is another object — not "shared" (review)', () => {
    // RED before: matched by name alone.
    assert.deepEqual(lunsMappingBackstore(live, 'fileio', 'shared'), [])
  })

  it('deleteIscsiLun with keepBackstore unmaps this LUN only — no backstore delete', async () => {
    // RED before: the backstore was deleted by name, and rtslib takes every
    // LUN attached to it — the other target's LUN 3, and its session.
    const mock = okExecutor()
    const result = await deleteIscsiLun({ executor: mock }, target(), { index: 0, name: 'shared', plugin: 'block', kind: 'zvol', backingPath: '/dev/zvol/tank/vol1' }, false, true)
    assert.deepEqual(argv(mock), [`targetcli /iscsi/${IQN}/tpg1/luns delete lun0`, 'targetcli saveconfig'])
    assert.equal(result.backstoreDeleted, null)
  })

  it('destroyBacking on a shared backstore is refused by a gate, naming the other LUN', async () => {
    const t = { ...target(), luns: [{ index: 0, name: 'shared', kind: 'zvol' as const, plugin: 'block', backingPath: '/dev/zvol/tank/vol1', size: 1, serial: 's', attributes: {}, connectedInitiators: [], present: true, backingExists: true }] }
    const spec = lunDeleteSpec({ executor: okExecutor(), paths: {} }, IQN, 0, true, { locks: undefined })
    const obj = { state: { ctx: { live } as never, targets: [t] }, target: t, lun: t.luns[0] }
    const reasons: string[] = []
    // Every gate before the served-device read (which needs a live stat).
    for (const gate of spec.gates) {
      const r = await gate(obj, {} as never).catch(() => null)
      if (r)
        reasons.push(r.reason ?? r.code)
    }
    assert.ok(reasons.includes('backstore-shared'), JSON.stringify(reasons))
  })
})

describe('ISCSI-L10 — a token targetcli would re-split never reaches it', () => {
  it('a stored path with a space, a quote or a second = is refused before targetcli runs', async () => {
    for (const bad of ['file_or_dev=/tank/a b.raw', 'dev=/dev/zvol/tank/x=y', 'file_or_dev=/tank/it\'s.raw', 'name=a\tb']) {
      const mock = okExecutor()
      await assert.rejects(() => runTargetcli(mock, ['/backstores/fileio', 'create', bad]), TargetcliArgError)
      assert.deepEqual(argv(mock), [], bad)
    }
  })

  it('every token ANAS builds passes unchanged', async () => {
    const mock = okExecutor()
    await runTargetcli(mock, ['/backstores/fileio', 'create', 'name=vm1', 'file_or_dev=/tank/images/vm1.raw', 'size=1024', 'write_back=false', 'wwn=9bc6e907-6015-4267-be4f-5a0617cb3d71'])
    await runTargetcli(mock, [`/iscsi/${IQN}/tpg1/portals`, 'create', 'fd00:6774:0:1::1', '3260'])
    assert.equal(argv(mock).length, 2)
  })
})

describe('ISCSI-L11 — the firewall advisory asks about the ports the portals listen on', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-fw-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function enabled(): MockExecutor {
    const mock = new MockExecutor()
    mock.addFixture({ command: '/usr/sbin/pve-firewall', result: { stdout: 'Status: enabled/running\n', stderr: '', exitCode: 0 } })
    return mock
  }

  it('a portal on 3261 behind a firewall that admits only 3260 is advised', async () => {
    // RED before: advisory null — only 3260 was ever checked.
    await writeFile(join(dir, 'host.fw'), '[RULES]\nIN ACCEPT -p tcp -dport 3260\n')
    const fw = await readPveFirewallAdvisory(enabled(), { firewallDir: dir, hostFirewallDir: dir }, [3261])
    assert.equal(fw.admits3260, true)
    assert.match(fw.advisory ?? '', /no rule admits 3261\/tcp/)
  })

  it('every port admitted: no advisory; the default is 3260 alone, as before', async () => {
    await writeFile(join(dir, 'host.fw'), '[RULES]\nIN ACCEPT -p tcp -dport 3260:3261\n')
    assert.equal((await readPveFirewallAdvisory(enabled(), { firewallDir: dir, hostFirewallDir: dir }, [3260, 3261])).advisory, null)
    await writeFile(join(dir, 'host.fw'), '[RULES]\nIN ACCEPT -p tcp -dport 22\n')
    assert.match((await readPveFirewallAdvisory(enabled(), { firewallDir: dir, hostFirewallDir: dir })).advisory ?? '', /no rule admits 3260\/tcp/)
  })
})

describe('ISCSI-L13 — an edit creates the new portals before it removes the old ones', () => {
  it('a portal swap creates first; a create that fails leaves the old portal listening', async () => {
    // RED before: delete 192.0.2.10 ran first, and a failed create left the
    // target listening on nothing.
    const t = { ...target(), portals: [{ address: '192.0.2.10', port: 3260, family: 'inet' as const, carriedByInterface: true }] }
    const ok = okExecutor()
    await updateIscsiTarget({ executor: ok }, t, { portals: [{ address: '192.0.2.20', port: 3260 }] })
    assert.deepEqual(argv(ok).slice(0, 2), [
      `targetcli /iscsi/${IQN}/tpg1/portals create 192.0.2.20 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals delete 192.0.2.10 3260`,
    ])
    const failing = new MockExecutor()
    failing.addFixture({ command: TARGETCLI, argsMatch: a => a[1] === 'create', result: { stdout: '', stderr: 'Could not create NetworkPortal in configFS', exitCode: 1 } })
    failing.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    await assert.rejects(() => updateIscsiTarget({ executor: failing }, t, { portals: [{ address: '192.0.2.20', port: 3260 }] }))
    assert.equal(argv(failing).some(a => a.includes('portals delete')), false)
  })

  it('(review 2, L3) a create that fails after the wildcard was removed puts the wildcard back and says so', async () => {
    // RED before: the job failed with the wildcard gone and no portal created.
    const t = { ...target(), portals: [{ address: '0.0.0.0', port: 3260, family: 'inet' as const, carriedByInterface: null }] }
    const failing = new MockExecutor()
    failing.addFixture({ command: TARGETCLI, argsMatch: a => a[1] === 'create' && a[2] === '192.0.2.20', result: { stdout: '', stderr: 'Could not create NetworkPortal in configFS', exitCode: 1 } })
    failing.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    await assert.rejects(() => updateIscsiTarget({ executor: failing }, t, { portals: [{ address: '192.0.2.20', port: 3260 }] }), /wildcard portal this edit had removed \(0\.0\.0\.0:3260\) was put back/)
    assert.deepEqual(argv(failing), [
      `targetcli /iscsi/${IQN}/tpg1/portals delete 0.0.0.0 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals create 192.0.2.20 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals create 0.0.0.0 3260`,
    ])
    // The put-back failing too: the sentence says the target may listen on
    // no portal and names the command.
    const worse = new MockExecutor()
    worse.addFixture({ command: TARGETCLI, argsMatch: a => a[1] === 'create', result: { stdout: '', stderr: 'refused', exitCode: 1 } })
    worse.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    await assert.rejects(() => updateIscsiTarget({ executor: worse }, t, { portals: [{ address: '192.0.2.20', port: 3260 }] }), new RegExp(`may now listen on NO portal\\. Restore it with: targetcli /iscsi/${IQN.replaceAll('.', '\\.')}/tpg1/portals create 0\\.0\\.0\\.0 3260`))
  })

  it('(review) a leftover WILDCARD on the same port as the new address is removed first; others still create-first', async () => {
    const t = { ...target(), portals: [
      { address: '0.0.0.0', port: 3260, family: 'inet' as const, carriedByInterface: null },
      { address: '192.0.2.10', port: 3261, family: 'inet' as const, carriedByInterface: true },
    ] }
    const mock = okExecutor()
    await updateIscsiTarget({ executor: mock }, t, { portals: [{ address: '192.0.2.20', port: 3260 }, { address: '192.0.2.30', port: 3262 }] })
    assert.deepEqual(argv(mock).slice(0, 4), [
      `targetcli /iscsi/${IQN}/tpg1/portals delete 0.0.0.0 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals create 192.0.2.20 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals create 192.0.2.30 3262`,
      `targetcli /iscsi/${IQN}/tpg1/portals delete 192.0.2.10 3261`,
    ])
  })

  it('(cr4 D-12) a create that fails after an earlier one SUCCEEDED undoes the created portal and says so', async () => {
    // RED before: the first address stayed live and unsaved, and the job said
    // "nothing else was changed".
    const t = { ...target(), portals: [{ address: '0.0.0.0', port: 3260, family: 'inet' as const, carriedByInterface: null }] }
    const failing = new MockExecutor()
    failing.addFixture({ command: TARGETCLI, argsMatch: a => a[1] === 'create' && a[2] === '192.0.2.30', result: { stdout: '', stderr: 'Could not create NetworkPortal in configFS', exitCode: 1 } })
    failing.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    await assert.rejects(
      () => updateIscsiTarget({ executor: failing }, t, { portals: [{ address: '192.0.2.20', port: 3260 }, { address: '192.0.2.30', port: 3260 }] }),
      /The portal this edit had created \(192\.0\.2\.20:3260\) was removed again\. The wildcard portal this edit had removed \(0\.0\.0\.0:3260\) was put back\./,
    )
    assert.deepEqual(argv(failing), [
      `targetcli /iscsi/${IQN}/tpg1/portals delete 0.0.0.0 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals create 192.0.2.20 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals create 192.0.2.30 3260`,
      // The one this run created is deleted again, then the wildcard returns.
      `targetcli /iscsi/${IQN}/tpg1/portals delete 192.0.2.20 3260`,
      `targetcli /iscsi/${IQN}/tpg1/portals create 0.0.0.0 3260`,
    ])
  })

  it('(cr4 D-12) an undo that fails names the portal still listening and the command that removes it', async () => {
    const t = { ...target(), portals: [{ address: '0.0.0.0', port: 3260, family: 'inet' as const, carriedByInterface: null }] }
    const failing = new MockExecutor()
    // The second create fails, and the undo of the first (the delete) fails too.
    failing.addFixture({ command: TARGETCLI, argsMatch: a => a[1] === 'create' && a[2] === '192.0.2.30', result: { stdout: '', stderr: 'refused', exitCode: 1 } })
    failing.addFixture({ command: TARGETCLI, argsMatch: a => a[1] === 'delete' && a[2] === '192.0.2.20', result: { stdout: '', stderr: 'busy', exitCode: 1 } })
    failing.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
    let message = ''
    try {
      await updateIscsiTarget({ executor: failing }, t, { portals: [{ address: '192.0.2.20', port: 3260 }, { address: '192.0.2.30', port: 3260 }] })
    }
    catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    assert.match(message, /could not all be removed again/)
    assert.match(message, /is still listening and not saved/)
    // The command that removes it is named, with the address in it.
    assert.match(message, new RegExp(`targetcli /iscsi/${IQN.replaceAll('.', '\\.')}/tpg1/portals delete 192\\.0\\.2\\.20 3260`))
    assert.doesNotMatch(message, /Nothing else was changed/)
  })
})

describe('cr3 — a Repair with nothing to do runs no saveconfig', () => {
  it('an empty plan saves nothing', async () => {
    // RED before: `stillMissing` was empty, so the job saved the live tree.
    const mock = okExecutor()
    const result = await repairIscsiHoles({ executor: mock }, { repairable: [], blocked: [] })
    assert.equal(result.saved, false)
    assert.deepEqual(argv(mock), [])
  })
})

describe('cr3 ISCSI-L7 (ruled) — Repair never writes to a foreign target; its holes keep the node degraded', () => {
  const OWN = 'iqn.2026-11.nas.anas:vmstore'
  const FOREIGN = 'iqn.2003-01.org.linux-iscsi.pve.x8664:sn.0123456789ab'
  function tpg(luns: { index: number, name: string }[]) {
    return { tag: 1, enabled: true, authentication: false, generateNodeAcls: false, demoModeDiscovery: false, portals: [], luns: luns.map(l => ({ index: l.index, backstoreName: l.name, plugin: 'block' })), acls: [], dynamicSessionsRaw: '' }
  }
  function ptpg(luns: { index: number, name: string }[]) {
    return { tag: 1, enable: true, authentication: false, generateNodeAcls: false, demoModeDiscovery: false, tpgCredentialsSet: false, portals: [], luns: luns.map(l => ({ index: l.index, storageObject: `/backstores/block/${l.name}`, backstoreName: l.name, plugin: 'block' })), acls: [] }
  }
  function so(name: string, dev: string) {
    return { name, plugin: 'block', dev, wwn: `wwn-${name}`, size: null, writeBack: null, readOnly: null, aio: null, attributes: {} }
  }
  /** Both targets restored without their LUN 0; both backing devices are back. */
  function ctx(withOwnHole: boolean): never {
    return {
      live: { present: true, backstores: [], targets: [{ iqn: OWN, tpgs: [tpg([])] }, { iqn: FOREIGN, tpgs: [tpg([])] }] },
      persisted: {
        storageObjects: [so('ownlun', '/dev/zvol/tank/own'), so('theirlun', '/dev/zvol/tank/theirs')],
        targets: [
          { iqn: OWN, fabric: 'iscsi', tpgs: [ptpg(withOwnHole ? [{ index: 0, name: 'ownlun' }] : [])] },
          { iqn: FOREIGN, fabric: 'iscsi', tpgs: [ptpg([{ index: 0, name: 'theirlun' }])] },
        ],
      },
      inputs: { pveStorages: new Map(), zfsMountpoints: [], systemFacts: [] },
      nodeAddresses: null,
      backing: new Map([['/dev/zvol/tank/own', { exists: true, size: null }], ['/dev/zvol/tank/theirs', { exists: true, size: null }]]),
      mounts: new Map(),
      stubs: new Map(),
    } as never
  }

  it('mixed: ANAS\'s hole is repaired, the foreign one is untouched, the node stays degraded and says why', async () => {
    // RED before: both holes were planned repairable and the job wrote LUN 0
    // into the foreign target.
    const c = ctx(true)
    const targets = await buildIscsiTargets(c)
    const health = computeIscsiHealth(c, targets, { holeIo: holeIoFor(c, targets) })
    // Targets come in IQN order.
    assert.deepEqual(health.missingLuns.map(m => [m.targetIqn, m.targetOwnership]), [[FOREIGN, 'foreign'], [OWN, 'anas']])
    // A change refused now names BOTH: Repair for ANAS's, the hand restore for theirs.
    const refused = assertSaveable(c, targets)!
    assert.match(refused.message, /use Repair on the iSCSI screen/)
    assert.match(refused.message, new RegExp(`LUN 0 of ${FOREIGN.replaceAll('.', '\\.')} .* missing from a target ANAS does not manage`))

    const plan = planIscsiRepair(c, health, targets)
    assert.deepEqual(plan.repairable.map(r => r.targetIqn), [OWN])
    assert.deepEqual(plan.blocked.map(b => [b.targetIqn, b.verdict?.state]), [[FOREIGN, 'foreign-target']])
    assert.equal(assertRepairable(plan), null)

    const mock = okExecutor()
    const result = await repairIscsiHoles({ executor: mock }, plan)
    assert.deepEqual(result.repaired.map(r => r.targetIqn), [OWN])
    assert.deepEqual(result.foreignUntouched.map(r => r.targetIqn), [FOREIGN])
    assert.equal(result.saved, false)
    assert.match(result.stillDegraded ?? '', /stays degraded/)
    assert.match(result.stillDegraded ?? '', /systemctl restart rtslib-fb-targetctl' in a maintenance window/)
    assert.equal(argv(mock).some(a => a.includes(FOREIGN)), false, argv(mock).join('\n'))
    assert.equal(argv(mock).some(a => a.includes(`/iscsi/${OWN}/tpg1/luns create`)), true, argv(mock).join('\n'))
  })

  it('foreign only: Repair refuses with the sentence, and every change names the foreign target, never "use Repair"', async () => {
    const c = ctx(false)
    const targets = await buildIscsiTargets(c)
    const health = computeIscsiHealth(c, targets, { holeIo: holeIoFor(c, targets) })
    assert.equal(health.degraded, true)
    const refusal = assertRepairable(planIscsiRepair(c, health, targets))
    assert.equal(refusal?.reason, 'foreign-holes-only')
    assert.match(refusal!.message, /Nothing here is ANAS's to repair/)
    // review 2, L6: the exit for a device gone for good, and what it costs.
    assert.match(refusal!.message, /gone for good, the way out is your own 'targetcli saveconfig'.*ERASES that LUN's record/)
    assert.match(refusal!.message, /stays degraded/)
    const refused = assertSaveable(c, targets)!
    assert.match(refused.message, /missing from a target ANAS does not manage/)
    assert.doesNotMatch(refused.message, /use Repair/)
  })
})

describe('cr3 ISCSI-L10 follow-up — an existing LUN on a path targetcli would re-split', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas cr3 space-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('backingPathRefusal: a space, a quote or an = in the path; a plain path passes', () => {
    assert.equal(backingPathRefusal('/dev/zvol/tank/my vol')?.reason, 'backing-path-unsafe')
    assert.equal(backingPathRefusal('/srv/a=b/x.raw')?.reason, 'backing-path-unsafe')
    assert.equal(backingPathRefusal('/srv/it\'s/x.raw')?.reason, 'backing-path-unsafe')
    assert.equal(backingPathRefusal('/tank/images/vm1.raw'), null)
  })

  it('delete (with the image destroyed) still works — no path reaches targetcli', async () => {
    const image = join(dir, 'lun.raw')
    await createSparseImage(image, 4096)
    const mock = okExecutor()
    const result = await deleteIscsiLun({ executor: mock }, target(), { index: 0, name: 'lun', plugin: 'fileio', kind: 'file', backingPath: image }, true)
    assert.equal(result.backingDestroyed, image)
    assert.deepEqual(argv(mock), [`targetcli /iscsi/${IQN}/tpg1/luns delete lun0`, 'targetcli /backstores/fileio delete lun', 'targetcli saveconfig'])
  })

  it('Repair blocks a hole whose SAVED path targetcli would re-split, with the reason — nothing is created', () => {
    const path = '/dev/zvol/tank/my vol'
    const ctx = {
      persisted: { storageObjects: [{ name: 'x', plugin: 'block', dev: path, wwn: 'w', size: null, writeBack: null, readOnly: null, aio: null, attributes: {} }], targets: [{ iqn: IQN, fabric: 'iscsi', tpgs: [{ tag: 1, acls: [], luns: [], portals: [] }] }] },
      live: { present: true, backstores: [], targets: [] },
      stubs: new Map(),
    } as never
    const hole = { targetIqn: IQN, tpgTag: 1, lunIndex: 0, backstoreName: 'x', plugin: 'block', backingPath: path, backingExists: true, targetOwnership: 'anas' as const }
    const health = { missingLuns: [{ ...hole, repair: holeRepairVerdict(ctx, target(), hole, null) }] } as never
    const plan = planIscsiRepair(ctx, health, [])
    assert.equal(plan.repairable.length, 0)
    assert.match(plan.blocked[0].verdict?.detail ?? '', /contains a space, a quote or an '='/)
  })

  it('a file resize is refused BEFORE the first act: the file is not grown, the LUN not unmapped', async () => {
    const image = join(dir, 'lun.raw')
    await createSparseImage(image, 4096)
    const mock = okExecutor()
    await assert.rejects(() => resizeFileLun({ executor: mock }, target(), { index: 0, name: 'lun', backingPath: image, serial: 's', attributes: { emulateTpu: true, emulateTpws: true, maxUnmapLbaCount: 1, writeBack: false } }, 8192), TargetcliArgError)
    assert.deepEqual(argv(mock), [])
    assert.equal((await stat(image)).size, 4096)
  })
})

describe('cr3 (review) — an image whose truncate fails is removed by the call that created it', () => {
  it('EFBIG (a file-size limit) leaves no 0-byte image behind', async () => {
    // RED before: the 0-byte file stayed — createSparseImage threw after
    // creating it, before the add-LUN undo's flag could rise. The limit is
    // the real kernel's (RLIMIT_FSIZE in a child shell), not a double.
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-efbig-'))
    try {
      const mod = join(dirname(fileURLToPath(import.meta.url)), '..', 'iscsi-mutate.ts')
      const image = join(dir, 'x.raw')
      const out = execFileSync('sh', ['-c', `ulimit -f 1; exec "$0" --import tsx -e "$1"`, process.execPath, `import(${JSON.stringify(mod)}).then(m => m.createSparseImage(${JSON.stringify(image)}, 1 << 30)).then(() => console.log('ok'), e => console.log('err', e.code))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      assert.match(out, /err EFBIG/)
      await assert.rejects(() => stat(image))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('cr3 review 2 — every line and every ACL is checked before the first act (L1, L4, L5)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-r2-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('L5: a positional token with = is refused; ANAS\'s keyword parameters pass', () => {
    assert.equal(configshellSafe('gt=vol1'), false)
    for (const ok of ['name=vm1', 'dev=/dev/zvol/tank/v', 'wwn=9bc6e907-6015-4267-be4f-5a0617cb3d71', 'storage_object=/backstores/block/x', 'lun=3', 'emulate_tpu=1', 'authentication=0', 'vm1', 'lun0'])
      assert.equal(configshellSafe(ok), true, ok)
  })

  it('L5: deleting a LUN whose backstore is named gt=vol1 is refused before the unmap', async () => {
    // RED before: the unmap ran, then the delete line was refused — the LUN
    // was left unmapped with its backstore in place.
    const mock = okExecutor()
    await assert.rejects(() => deleteIscsiLun({ executor: mock }, target(), { index: 0, name: 'gt=vol1', plugin: 'block', kind: 'zvol', backingPath: '/dev/zvol/tank/v' }, false), TargetcliArgError)
    assert.deepEqual(argv(mock), [])
  })

  it('L1: a file resize with an ACL that is not an iSCSI name is refused before anything is grown or unmapped', async () => {
    // RED before (probes/aclname.ts): aclDirPath threw at the re-grant —
    // after the unmap, the delete, the recreate and the map.
    const image = join(dir, 'lun.raw')
    await createSparseImage(image, 4096)
    const mock = okExecutor()
    const t = { ...target(), acls: [{ initiatorIqn: 'not an iqn', chapUserid: null, chapCredentialsSet: false, mutualUserid: null, mutualCredentialsSet: false, mappedLuns: [0] }] }
    await assert.rejects(
      () => resizeFileLun({ executor: mock }, t, { index: 0, name: 'lun', backingPath: image, serial: 's', attributes: { emulateTpu: true, emulateTpws: true, maxUnmapLbaCount: 1, writeBack: false } }, 8192),
      /initiator ACL "not an iqn" .* Nothing was changed/,
    )
    assert.deepEqual(argv(mock), [])
    assert.equal((await stat(image)).size, 4096)
    assert.equal(aclNamesRefusal(IQN, [{ initiatorIqn: 'iqn.1993-08.org.debian:01:x' }]), null)
  })

  it('L4: Repair blocks a hole whose saved serial or ACL name cannot be handed to targetcli', () => {
    const ctx = (wwn: string, acl: string) => ({
      persisted: {
        storageObjects: [{ name: 'x', plugin: 'block', dev: '/dev/zvol/tank/x', wwn, size: null, writeBack: null, readOnly: null, aio: null, attributes: {} }],
        targets: [{ iqn: IQN, fabric: 'iscsi', tpgs: [{ tag: 1, acls: [{ initiatorIqn: acl, mappedLuns: [0] }], luns: [], portals: [] }] }],
      },
      live: { present: true, backstores: [], targets: [] },
      stubs: new Map(),
    }) as never
    const hole = { targetIqn: IQN, tpgTag: 1, lunIndex: 0, backstoreName: 'x', plugin: 'block', backingPath: '/dev/zvol/tank/x', backingExists: true, targetOwnership: 'anas' as const }
    // No mark, and a device nothing serves: the good record is a ready hole.
    const facts = { device: { type: 'block' as const, rdevMajor: 230, rdevMinor: 0, dev: '0', ino: '0', size: 0 }, mark: { state: 'absent' as const, dataset: 'tank/x' }, running: undefined, record: undefined }
    const health = (wwn: string, acl: string) => ({ missingLuns: [{ ...hole, repair: holeRepairVerdict(ctx(wwn, acl), target(), hole, facts) }] }) as never
    const badWwn = planIscsiRepair(ctx('a b', 'iqn.1993-08.org.debian:01:x'), health('a b', 'iqn.1993-08.org.debian:01:x'), [])
    assert.equal(badWwn.repairable.length, 0)
    assert.match(badWwn.blocked[0].verdict?.detail ?? '', /"wwn=a b" cannot be handed to targetcli/)
    const badAcl = planIscsiRepair(ctx('w', 'not an iqn'), health('w', 'not an iqn'), [])
    assert.equal(badAcl.repairable.length, 0)
    assert.match(badAcl.blocked[0].verdict?.detail ?? '', /initiator ACL "not an iqn"/)
    assert.equal(planIscsiRepair(ctx('w', 'iqn.1993-08.org.debian:01:x'), health('w', 'iqn.1993-08.org.debian:01:x'), []).repairable.length, 1)
  })
})

describe('own.4 (c) — a hole Repair cannot put back is named as such, never "use Repair"', () => {
  const BASE = { iqn: IQN, tag: 1, backstores: [], luns: [] }
  const IMG = '/tank/images/img.raw'
  const LUN0 = (backstore: string, plugin: string) => [{ iqn: IQN, tag: 1, index: 0, backstore, plugin }]

  it('record-incomplete: the saved record cannot be replayed, so the refusal names the reason, not Repair', async () => {
    const bs = { name: 'img', plugin: 'fileio', dev: IMG, wwn: 'w-1' }
    const ctx = contextOf({ backstores: [], luns: [] }, { backstores: [bs], luns: LUN0('img', 'fileio') }, BASE)
    ctx.inputs.zfsMountpoints = [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }]
    const targets = await buildIscsiTargets(ctx)
    assert.equal(computeIscsiHealth(ctx, targets).missingLuns[0].repair?.state, 'record-incomplete')

    const refused = assertSaveable(ctx, targets)!
    assert.equal(refused.reason, 'degraded-restore')
    // No Repair-able hole is left, so the refusal is the head sentence.
    assert.match(refused.message, /is an INCOMPLETE restore, and every change is refused until it is whole:/)
    assert.match(refused.message, /LUN 0 of .* is missing too, and Repair cannot put it back: the saved configuration records no size for fileio backstore 'img' \(\/tank\/images\/img\.raw\) — recreating it without one would serve a 0-byte disk with the right serial\.$/)
    assert.doesNotMatch(refused.message, /use Repair/)
  })

  it('a reason that is already a full sentence gets ONE stop in the by-hand clause', () => {
    // An ACL name targetcli cannot be handed: that refusal is a whole sentence
    // with its own stop, where the other record-incomplete reasons are clauses.
    const path = '/dev/zvol/tank/v1'
    const ctx = {
      live: { present: true, backstores: [], targets: [] },
      persisted: {
        fabricModules: [],
        storageObjects: [{ name: 'v1', plugin: 'block', dev: path, wwn: 'w-1', size: null, writeBack: null, readOnly: null, aio: null, attributes: {} }],
        targets: [{
          iqn: IQN,
          fabric: 'iscsi',
          tpgs: [{ tag: 1, enable: true, authentication: true, generateNodeAcls: false, demoModeDiscovery: false, tpgCredentialsSet: false, portals: [], luns: [{ index: 0, backstoreName: 'v1', plugin: 'block', storageObject: '/backstores/block/v1' }], acls: [{ initiatorIqn: 'iqn.2020-01.com.foo:bad name', mappedLuns: [0] }] }],
        }],
      },
      inputs: { pveStorages: new Map(), zfsMountpoints: [] },
      nodeAddresses: null,
      backing: new Map(),
      mounts: new Map(),
      stubs: new Map(),
    } as unknown as Parameters<typeof assertSaveable>[0]
    const targets = [{
      iqn: IQN,
      name: 'x',
      ownership: 'anas',
      ownershipReason: 'r',
      ownershipDetail: 'd',
      tpgTag: 1,
      enabled: true,
      portals: [],
      lunCount: 1,
      aclCount: 1,
      sessionCount: 0,
      security: { authentication: true, generateNodeAcls: false, demoModeDiscovery: false },
      present: true,
      persisted: true,
      missingLunCount: 1,
      portalsWithoutInterfaceCount: 0,
      luns: [{ index: 0, name: 'v1', kind: 'zvol', plugin: 'block', backingPath: path, size: null, serial: 'w-1', attributes: {}, connectedInitiators: [], present: false, savedOnly: true, backingExists: true }],
      acls: [],
      sessions: [],
    }] as unknown as Parameters<typeof assertSaveable>[1]
    assert.equal(computeIscsiHealth(ctx, targets).missingLuns[0].repair?.state, 'record-incomplete')
    const message = assertSaveable(ctx, targets)!.message
    assert.match(message, /Repair cannot put it back: /)
    assert.doesNotMatch(message, /\.\./)
    assert.match(message, /[^.]\.$/)
  })

  it('backstore-live: the live backstore is the reason, and the way back is the map line', async () => {
    const bs = { name: 'img', plugin: 'block', dev: '/dev/zvol/tank/img', wwn: 'w-1' }
    const ctx = contextOf({ backstores: [bs], luns: [] }, { backstores: [bs], luns: LUN0('img', 'block') }, BASE)
    const targets = await buildIscsiTargets(ctx)
    assert.equal(computeIscsiHealth(ctx, targets).missingLuns[0].repair?.state, 'backstore-live')

    const refused = assertSaveable(ctx, targets)!
    assert.match(refused.message, /is missing too, and Repair cannot put it back: backstore 'img' \(block, \/dev\/zvol\/tank\/img\) is still live and no LUN maps it/)
    assert.match(refused.message, /map it back by hand: 'targetcli \/iscsi\/iqn\.2026-08\.nas\.anas:vmstore\/tpg1\/luns create storage_object=\/backstores\/block\/img lun=0'\.$/)
    assert.doesNotMatch(refused.message, /use Repair/)
  })

  it('a repairable hole beside a by-hand one keeps today\'s sentence for the repairable one', async () => {
    const img = { name: 'img', plugin: 'fileio', dev: IMG, wwn: 'w-1' }
    const vol = { name: 'vol', plugin: 'block', dev: '/dev/zvol/tank/vol', wwn: 'w-2' }
    const ctx = contextOf({ backstores: [], luns: [] }, {
      backstores: [img, vol],
      luns: [...LUN0('img', 'fileio'), { iqn: IQN, tag: 1, index: 1, backstore: 'vol', plugin: 'block' }],
    }, BASE)
    ctx.inputs.zfsMountpoints = [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }]
    const targets = await buildIscsiTargets(ctx)
    const states = computeIscsiHealth(ctx, targets).missingLuns.map(l => l.repair?.state ?? null)
    assert.deepEqual(states, ['record-incomplete', null])

    const refused = assertSaveable(ctx, targets)!
    assert.match(refused.message, /has 1 LUN the kernel does not: LUN 1 of /)
    assert.match(refused.message, /then use Repair on the iSCSI screen, and retry\./)
    assert.match(refused.message, /LUN 0 of .* is missing too, and Repair cannot put it back: the saved configuration records no size/)
  })
})
