/**
 * cr3.iscsi — the read layer's findings of the 2026-11-14 review, each pinned
 * by the probe that reproduced it (constructed contexts, no I/O).
 */
import type { ConfigfsAcl, ConfigfsBackstore, ConfigfsTpg, LioLiveState } from '../iscsi-configfs.js'
import type { IscsiReadContext } from '../iscsi.js'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseLioSaveconfig, readLioSaveconfigState } from '../../parsers/lio-saveconfig.js'
import { aclInfoReadable, authUnset, readConfigfs, readMappedLuns } from '../iscsi-configfs.js'
import { foreignGate, lunDeleteSpec, targetLunsGate, targetSessionsGate, updateSessionsReadableGate } from '../iscsi-guard.js'
import { computeIscsiHealth } from '../iscsi-health.js'
import { heldByLunRefusal, heldWithSessions, iscsiServedSerials, iscsiServedSerialsStrict, pickHolder, servedSerialsOf } from '../iscsi-held.js'
import { assertSaveable, claimsFromTargets, iscsiClaims, resolveFileBackingDir } from '../iscsi-mutate.js'
import { classifyBacking, deriveOwnership } from '../iscsi-ownership.js'
import { buildIscsiWarnings, collectIscsiWarnings } from '../iscsi-warnings.js'
import { buildIscsiTargets, iscsiAvailability, toTargetSummary } from '../iscsi.js'

const ANAS_IQN = 'iqn.2026-08.pve1.anas:vmstore'

function fileBackstore(name: string, path: string, size = 1 << 30): ConfigfsBackstore {
  return {
    name,
    plugin: 'fileio',
    hbaIndex: 0,
    udevPath: path,
    serial: `serial-${name}`,
    productId: name,
    vendorId: 'LIO-ORG',
    enabled: true,
    status: 'ACTIVATED',
    claimed: null,
    kernelDevice: null,
    size,
    devMajor: null,
    devMinor: null,
    attributes: {},
  } as ConfigfsBackstore
}

function liveTpg(tag: number, luns: { index: number, name: string }[], acls: ConfigfsAcl[] = []): ConfigfsTpg {
  return {
    tag,
    enabled: true,
    authentication: false,
    generateNodeAcls: false,
    demoModeDiscovery: false,
    portals: [],
    luns: luns.map(l => ({ index: l.index, backstoreName: l.name, plugin: 'fileio' })),
    acls,
    dynamicSessionsRaw: '',
  }
}

describe('ISCSI-H1 — an absent or placeholder image never takes a target away from ANAS', () => {
  // The probe's state: a ZFS-root node (`rpool/ROOT/pve-1` at `/`), an AHR
  // image LUN whose AHR pool did NOT mount, and the 0-byte placeholder the
  // restore service created at the image path on `/`.
  const PATH = '/mnt/ahr1/vmdisk.raw'
  function zfsRootCtx(probe: { exists: boolean | null, size: number | null }): IscsiReadContext {
    const live: LioLiveState = {
      present: true,
      backstores: [fileBackstore('vmdisk', PATH)],
      targets: [{ iqn: ANAS_IQN, tpgs: [liveTpg(1, [{ index: 0, name: 'vmdisk' }])] }],
    }
    return {
      live,
      persisted: {
        storageObjects: [{ name: 'vmdisk', plugin: 'fileio', dev: PATH, wwn: 'serial-vmdisk', size: 1 << 30, writeBack: false, readOnly: null, aio: false, attributes: {} }],
        targets: [{ iqn: ANAS_IQN, fabric: 'iscsi', tpgs: [{ tag: 1, enable: true, authentication: false, generateNodeAcls: false, demoModeDiscovery: false, tpgCredentialsSet: false, portals: [], luns: [{ index: 0, storageObject: '/backstores/fileio/vmdisk', backstoreName: 'vmdisk', plugin: 'fileio' }], acls: [] }] }],
      } as unknown as IscsiReadContext['persisted'],
      inputs: {
        pveStorages: new Map(),
        zfsMountpoints: [
          { dataset: 'rpool', mountpoint: '/rpool', pool: 'rpool' },
          { dataset: 'rpool/ROOT/pve-1', mountpoint: '/', pool: 'rpool' },
        ],
        findmntNodes: [{ target: '/', source: 'rpool/ROOT/pve-1', fstype: 'zfs', options: 'rw' }],
        systemFacts: [{ pool: 'rpool', bootfs: 'rpool/ROOT/pve-1', rootDataset: 'rpool/ROOT/pve-1' }],
        ahrMountpoints: new Map([['ahr1', '/mnt/ahr1']]),
      },
      nodeAddresses: null,
      backing: new Map([[PATH, probe]]),
      mounts: new Map([['/', { target: '/', source: 'rpool/ROOT/pve-1', fstype: 'zfs', options: 'rw' }]]),
      stubs: new Map(),
    }
  }

  it('a 0-byte placeholder on the boot dataset: the target stays ANAS\'s, the stub is ANAS\'s, the node is degraded', async () => {
    // RED before: ownership foreign / backing-pve-storage ("rpool/ROOT/pve-1 is
    // the boot filesystem"), stub owner foreign, degraded false — an empty disk
    // with the right serial kept being served and nothing would take it away.
    const ctx = zfsRootCtx({ exists: true, size: 0 })
    const targets = await buildIscsiTargets(ctx)
    assert.equal(targets[0].ownership, 'anas')
    assert.equal(targets[0].ownershipReason, 'backing-unresolved')
    const health = computeIscsiHealth(ctx, targets)
    assert.equal(health.stubLuns.length, 1)
    assert.equal(health.stubLuns[0].ownership, 'anas')
    assert.equal(health.degraded, true)
    // (review) and it carries no pool or dataset: the boot dataset it fell
    // through to is not where the image lives, on screen or in its claim.
    assert.equal(targets[0].luns[0].pool, undefined)
    assert.equal(targets[0].luns[0].dataset, undefined)
    const claim = claimsFromTargets(targets)[0]
    assert.equal(claim.dataset, undefined)
    assert.equal(claim.pool, undefined)
  })

  it('an image that is simply not there on the boot dataset: still ANAS\'s', async () => {
    const ctx = zfsRootCtx({ exists: false, size: null })
    const targets = await buildIscsiTargets(ctx)
    assert.equal(targets[0].ownership, 'anas')
    assert.equal(targets[0].ownershipReason, 'backing-unresolved')
  })

  it('an image that IS there with its data on the boot dataset is still a positive foreign verdict', async () => {
    const ctx = zfsRootCtx({ exists: true, size: 1 << 30 })
    const targets = await buildIscsiTargets(ctx)
    assert.equal(targets[0].ownership, 'foreign')
    assert.equal(targets[0].ownershipReason, 'backing-pve-storage')
  })

  it('deriveOwnership: an absent file under a PVE-owned dataset is unresolved, a present one is foreign', () => {
    const inputs = zfsRootCtx({ exists: false, size: null }).inputs
    const absent = deriveOwnership(ANAS_IQN, [{ name: 'vmdisk', backingPath: PATH, backingExists: false }], inputs)
    assert.equal(absent.ownership, 'anas')
    assert.equal(absent.reason, 'backing-unresolved')
    const present = deriveOwnership(ANAS_IQN, [{ name: 'vmdisk', backingPath: PATH, backingExists: true }], inputs)
    assert.equal(present.ownership, 'foreign')
    // Unchecked (`null`) is not an absence: it keeps the positive verdict.
    const unchecked = deriveOwnership(ANAS_IQN, [{ name: 'vmdisk', backingPath: PATH, backingExists: null }], inputs)
    assert.equal(unchecked.ownership, 'foreign')
  })
})

// ---------------------------------------------------------------------------
// ISCSI-H2 — every TPG is read
// ---------------------------------------------------------------------------

const CLIENT = 'iqn.1993-08.org.debian:01:client'
const FOREIGN_IQN = 'iqn.2003-01.org.linux-iscsi.pve.x8664:sn.0123456789ab'
const ANAS_T1 = 'iqn.2026-08.nas.anas:t1'

function aclWith(mapped: number[], session: 'none' | 'live' | 'unreadable'): ConfigfsAcl {
  return {
    initiatorIqn: CLIENT,
    chapUserid: null,
    chapCredentialsSet: false,
    mutualUserid: null,
    mutualCredentialsSet: false,
    authenticateTarget: null,
    mappedLuns: mapped,
    session: session === 'live'
      ? { initiatorIqn: CLIENT, initiatorAlias: null, sessionId: 1, state: 'TARG_SESS_STATE_LOGGED_IN', connections: [] }
      : null,
    ...(session === 'unreadable' ? { sessionUnreadable: true } : {}),
  }
}

function persistedTpg(tag: number, luns: { index: number, name: string }[]) {
  return {
    tag,
    enable: true,
    authentication: false,
    generateNodeAcls: false,
    demoModeDiscovery: false,
    tpgCredentialsSet: false,
    portals: [{ address: '192.0.2.10', port: 3260 + tag - 1, ipv6: false, iser: false, offload: false }],
    luns: luns.map(l => ({ index: l.index, storageObject: `/backstores/fileio/${l.name}`, backstoreName: l.name, plugin: 'fileio' })),
    acls: [],
  }
}

function so(name: string, path: string) {
  return { name, plugin: 'fileio', dev: path, wwn: `serial-${name}`, size: 1 << 30, writeBack: false, readOnly: null, aio: false, attributes: {} }
}

/**
 * The probe's two targets: a FOREIGN target whose tpg2 LUN 0 (f_b) did not
 * restore, and an ANAS-named target given a second TPG by hand — tpg1 empty,
 * tpg2 serving b_x to a logged-in initiator.
 */
function multiTpgCtx(): IscsiReadContext {
  const t2 = liveTpg(2, [{ index: 0, name: 'b_x' }], [aclWith([0], 'live')])
  return {
    live: {
      present: true,
      backstores: [fileBackstore('f_a', '/tank/img/f_a.raw'), fileBackstore('b_x', '/tank/img/b_x.raw')],
      targets: [
        { iqn: FOREIGN_IQN, tpgs: [liveTpg(1, [{ index: 0, name: 'f_a' }]), liveTpg(2, [])] },
        { iqn: ANAS_T1, tpgs: [liveTpg(1, []), t2] },
      ],
    },
    persisted: {
      storageObjects: [so('f_a', '/tank/img/f_a.raw'), so('f_b', '/tank/img2/f_b.raw'), so('b_x', '/tank/img/b_x.raw')],
      targets: [
        { iqn: FOREIGN_IQN, fabric: 'iscsi', tpgs: [persistedTpg(1, [{ index: 0, name: 'f_a' }]), persistedTpg(2, [{ index: 0, name: 'f_b' }])] },
        { iqn: ANAS_T1, fabric: 'iscsi', tpgs: [persistedTpg(1, []), persistedTpg(2, [{ index: 0, name: 'b_x' }])] },
      ],
    } as unknown as IscsiReadContext['persisted'],
    inputs: { pveStorages: new Map(), zfsMountpoints: [{ dataset: 'tank/img', mountpoint: '/tank/img', pool: 'tank' }], systemFacts: [] },
    nodeAddresses: new Set(['192.0.2.10']),
    backing: new Map([
      ['/tank/img/f_a.raw', { exists: true, size: 1 << 30 }],
      ['/tank/img2/f_b.raw', { exists: false, size: null }],
      ['/tank/img/b_x.raw', { exists: true, size: 1 << 30 }],
    ]),
    mounts: new Map(),
    stubs: new Map(),
  }
}

const NO_DEPS = {} as never

describe('ISCSI-H2 — every TPG of a target is read, and a multi-TPG target is not changed', () => {
  it('(a) a hole in a second TPG is a missing LUN and degrades the node', async () => {
    // RED before: missingLuns [] and degraded false — the next saveconfig
    // would have written f_b out of saveconfig.json for good (GT-22).
    const ctx = multiTpgCtx()
    const targets = await buildIscsiTargets(ctx)
    const health = computeIscsiHealth(ctx, targets)
    assert.deepEqual(health.missingLuns.map(m => [m.targetIqn, m.tpgTag, m.lunIndex, m.backstoreName]), [[FOREIGN_IQN, 2, 0, 'f_b']])
    assert.equal(health.degraded, true)
    const refused = assertSaveable(ctx, targets)
    assert.notEqual(refused, null)
    // The hole is in a FOREIGN target: Repair never touches it (ISCSI-L7,
    // ruled), so the refusal names it and the hand restore — never "use
    // Repair". (ISCSI-L8's "use Repair" for ANAS's own holes is pinned in
    // iscsi-mutate.test.ts and the L7 tests in iscsi-cr3-mutate.test.ts.)
    assert.match(refused!.message, /missing from a target ANAS does not manage/)
    assert.doesNotMatch(refused!.message, /use Repair/)
    const foreign = targets.find(t => t.iqn === FOREIGN_IQN)!
    assert.equal(foreign.missingLunCount, 1)
  })

  it('(b) a LUN in a second TPG is a held-by-LUN claim, at its own TPG', async () => {
    const targets = await buildIscsiTargets(multiTpgCtx())
    const claims = claimsFromTargets(targets).filter(c => c.backingPath === '/tank/img/b_x.raw')
    assert.deepEqual(claims.map(c => [c.targetIqn, c.tpgTag, c.lunIndex, c.connectedInitiators]), [[ANAS_T1, 2, 0, [CLIENT]]])
  })

  it('(c) the target delete gates see the second TPG\'s session and LUN', async () => {
    const ctx = multiTpgCtx()
    const targets = await buildIscsiTargets(ctx)
    const anas = targets.find(t => t.iqn === ANAS_T1)!
    assert.equal(anas.sessionCount, 1)
    assert.equal(anas.sessions[0].tpgTag, 2)
    // The first TPG's own fields are what they were: it has no LUN.
    assert.equal(anas.lunCount, 0)
    assert.equal(anas.otherTpgs?.length, 1)
    const obj = { state: { ctx, targets }, target: anas }
    assert.equal((await targetSessionsGate(obj, NO_DEPS))?.reason, 'live-sessions')
    assert.equal((await targetLunsGate(obj, NO_DEPS))?.reason, 'target-has-luns')
  })

  it('a multi-TPG ANAS target is refused by the hands-off gate every verb runs, with a sentence', async () => {
    const ctx = multiTpgCtx()
    const targets = await buildIscsiTargets(ctx)
    const anas = targets.find(t => t.iqn === ANAS_T1)!
    const refused = await foreignGate({ state: { ctx, targets }, target: anas }, NO_DEPS)
    assert.equal(refused?.reason, 'multiple-tpgs')
    assert.match(refused!.message, /2 target portal groups \(TPG 1, 2\)/)
  })

  it('a session in another TPG is not counted against the first TPG\'s LUN at the same index', async () => {
    const ctx = multiTpgCtx()
    // Give tpg1 a LUN 0 of its own with no ACL; tpg2's initiator maps ITS LUN 0.
    ctx.live.targets[1].tpgs[0] = liveTpg(1, [{ index: 0, name: 'f_a' }])
    const targets = await buildIscsiTargets(ctx)
    const anas = targets.find(t => t.iqn === ANAS_T1)!
    assert.deepEqual(anas.luns[0].connectedInitiators, [])
    assert.deepEqual(anas.otherTpgs?.[0].luns[0].connectedInitiators, [CLIENT])
  })

  it('the served serials (the disk pickers\' loop-back guard) include a second TPG\'s LUN', async () => {
    const targets = await buildIscsiTargets(multiTpgCtx())
    // `serial-b_x`, normalised (lowercase, dashes stripped).
    assert.equal(servedSerialsOf(targets).has('serialb_x'), true)
  })

  it('the TPGs are joined by TAG: a live TPG 2 is never described with the persisted TPG 1', async () => {
    const ctx = multiTpgCtx()
    ctx.live.targets[1].tpgs = [ctx.live.targets[1].tpgs[1]] // live: tpg2 only; persisted: tpg1 + tpg2
    const targets = await buildIscsiTargets(ctx)
    const anas = targets.find(t => t.iqn === ANAS_T1)!
    assert.equal(anas.tpgTag, 1)
    assert.equal(anas.otherTpgs?.[0].tpgTag, 2)
    assert.equal(anas.otherTpgs?.[0].luns[0].present, true)
  })

  it('a single-TPG target carries no otherTpgs, and the grid summary never does', async () => {
    const targets = await buildIscsiTargets(multiTpgCtx())
    assert.equal(targets.every(t => t.otherTpgs?.length === 1), true)
    assert.equal('otherTpgs' in toTargetSummary(targets[1]), false)
    const ctx = multiTpgCtx()
    ctx.live.targets[1].tpgs = [ctx.live.targets[1].tpgs[0]]
    ;(ctx.persisted as { targets: { tpgs: unknown[] }[] }).targets[1].tpgs.length = 1
    const single = (await buildIscsiTargets(ctx)).find(t => t.iqn === ANAS_T1)!
    assert.equal('otherTpgs' in single, false)
  })
})

// ---------------------------------------------------------------------------
// sessionCount — an unreadable session is unknown, never "none"
// ---------------------------------------------------------------------------

describe('sessionCount (cross-cutting sweep) — a session that could not be read refuses, never passes', () => {
  function oneLunCtx(session: 'none' | 'live' | 'unreadable'): IscsiReadContext {
    const ctx = multiTpgCtx()
    ctx.live.targets = [{ iqn: ANAS_T1, tpgs: [liveTpg(1, [{ index: 0, name: 'b_x' }], [aclWith([0], session)])] }]
    ctx.persisted = { ...ctx.persisted!, targets: [{ iqn: ANAS_T1, fabric: 'iscsi', tpgs: [persistedTpg(1, [{ index: 0, name: 'b_x' }])] }] } as IscsiReadContext['persisted']
    return ctx
  }

  it('aclInfoReadable: the two things `info` always says, and nothing else', () => {
    assert.equal(aclInfoReadable('No active iSCSI Session for Initiator Endpoint: iqn.x'), true)
    assert.equal(aclInfoReadable('LIO Session ID: 7\nSession State: TARG_SESS_STATE_LOGGED_IN'), true)
    assert.equal(aclInfoReadable(null), false)
    assert.equal(aclInfoReadable(''), false)
    assert.equal(aclInfoReadable('garbage'), false)
  })

  it('an unreadable session yields 0 sessions but SAYS unknown, on the target and on the LUN', async () => {
    // RED before: sessionCount 0 and nothing else — a failed read counted as
    // "no sessions" in front of the delete and resize gates.
    const targets = await buildIscsiTargets(oneLunCtx('unreadable'))
    assert.equal(targets[0].sessionCount, 0)
    assert.equal(targets[0].sessionsUnknown, true)
    assert.equal(targets[0].luns[0].connectedInitiatorsUnknown, true)
    // A readable "no session" says nothing extra.
    const clean = await buildIscsiTargets(oneLunCtx('none'))
    assert.equal(clean[0].sessionsUnknown, undefined)
    assert.equal(clean[0].luns[0].connectedInitiatorsUnknown, undefined)
  })

  it('the unknown travels into the held-by-LUN claims, the holder and its refusal (review)', async () => {
    // RED before: the claim carried `connectedInitiators: []` and nothing
    // else, so another area's "no session" gate (the AHR repair gate) passed.
    const targets = await buildIscsiTargets(oneLunCtx('unreadable'))
    const claims = claimsFromTargets(targets)
    assert.equal(claims[0].connectedInitiatorsUnknown, true)
    assert.match(claims[0].detail, /session state could not be read/)
    const held = pickHolder(claims, { path: claims[0].backingPath })!
    assert.equal(held.connectedInitiatorsUnknown, true)
    assert.equal(heldWithSessions(held), true)
    // Said once (review 2, L2): the claim's detail carries it into the refusal.
    assert.equal(heldByLunRefusal('dataset x', 'Destroying', held).message.match(/session state could not be read/g)?.length, 1)
    // A readable "no session" carries no marker.
    const clean = claimsFromTargets(await buildIscsiTargets(oneLunCtx('none')))
    assert.equal(clean[0].connectedInitiatorsUnknown, undefined)
    assert.equal(heldWithSessions(pickHolder(clean, { path: clean[0].backingPath })!), false)
  })

  it('the target delete gate refuses on an unreadable session', async () => {
    const ctx = oneLunCtx('unreadable')
    const targets = await buildIscsiTargets(ctx)
    const refused = await targetSessionsGate({ state: { ctx, targets }, target: targets[0] }, NO_DEPS)
    assert.equal(refused?.reason, 'sessions-unknown')
  })

  it('the LUN delete gate refuses on an unreadable session', async () => {
    const ctx = oneLunCtx('unreadable')
    const targets = await buildIscsiTargets(ctx)
    const spec = lunDeleteSpec({ executor: {} as never, paths: {} }, ANAS_T1, 0, false, { seed: { ctx, targets }, locks: undefined })
    const gates = spec.gates
    const obj = { state: { ctx, targets }, target: targets[0], lun: targets[0].luns[0] }
    const reasons: string[] = []
    for (const gate of gates) {
      const r = await gate(obj, NO_DEPS)
      if (r)
        reasons.push(r.reason ?? r.code)
    }
    assert.deepEqual(reasons, ['sessions-unknown'])
  })

  it('a target edit that removes an ACL refuses on an unreadable session; one that removes nothing passes', async () => {
    const ctx = oneLunCtx('unreadable')
    const targets = await buildIscsiTargets(ctx)
    const obj = { state: { ctx, targets }, target: targets[0] }
    assert.equal((await updateSessionsReadableGate({ acls: [] })(obj, NO_DEPS))?.reason, 'sessions-unknown')
    assert.equal(await updateSessionsReadableGate({ acls: [{ initiatorIqn: CLIENT }] as never })(obj, NO_DEPS), null)
    assert.equal(await updateSessionsReadableGate({})(obj, NO_DEPS), null)
  })
})

// ---------------------------------------------------------------------------
// ISCSI-L15 — an unreadable saveconfig.json is not "nothing persisted"
// ---------------------------------------------------------------------------

describe('ISCSI-L15 — an unreadable saveconfig.json is never "nothing persisted"', () => {
  it('readLioSaveconfigState tells absent, garbled and readable apart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-saveconfig-'))
    try {
      assert.deepEqual(await readLioSaveconfigState(join(dir, 'absent.json')), { config: null, unreadable: null })
      await writeFile(join(dir, 'garbled.json'), '{"storage_objects": [')
      const garbled = await readLioSaveconfigState(join(dir, 'garbled.json'))
      assert.equal(garbled.config, null)
      assert.match(garbled.unreadable ?? '', /garbled\.json is not valid JSON/)
      await writeFile(join(dir, 'ok.json'), '{"storage_objects": [], "targets": []}')
      const ok = await readLioSaveconfigState(join(dir, 'ok.json'))
      assert.equal(ok.unreadable, null)
      assert.notEqual(ok.config, null)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades the node, refuses every save, and gets its own dashboard card', async () => {
    // RED before: persisted null read as "nothing saved" — no hole, not
    // degraded, and the next mutation's saveconfig overwrote the file.
    const ctx = multiTpgCtx()
    ctx.persisted = null
    ctx.persistedUnreadable = '/etc/rtslib-fb-target/saveconfig.json is not valid JSON (Unexpected end of JSON input)'
    const targets = await buildIscsiTargets(ctx)
    const health = computeIscsiHealth(ctx, targets)
    assert.equal(health.degraded, true)
    assert.match(health.saveconfigUnreadable ?? '', /not valid JSON/)
    assert.equal(iscsiAvailability(ctx).saveconfigPresent, true)
    assert.equal(assertSaveable(ctx, targets)?.reason, 'saveconfig-unreadable')
    const cards = buildIscsiWarnings(health)
    assert.ok(cards.some(c => /saved iSCSI configuration cannot be read/.test(c.message)), JSON.stringify(cards))
    assert.ok(!cards.some(c => /incomplete restore/.test(c.message)), JSON.stringify(cards))
  })
})

// ---------------------------------------------------------------------------
// INVENTED-STATE-H1 (iscsi) — a failed read is never "no warnings"
// ---------------------------------------------------------------------------

describe('INVENTED-STATE-H1 (iscsi) — a configfs tree that could not be read throws, never reads as absent', () => {
  it('readConfigfs: ENOENT is "not installed"; a tree it may not stat throws; the dashboard collector propagates it', { skip: process.getuid?.() === 0 ? 'root can stat through a mode-000 directory' : false }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-configfs-'))
    try {
      assert.equal((await readConfigfs({ root: join(dir, 'absent') })).present, false)
      const locked = join(dir, 'locked')
      await mkdir(join(locked, 'target'), { recursive: true })
      await chmod(locked, 0o000)
      // RED before: { present: false } — the same answer as "no LIO here", so
      // every saved LUN read as a restore hole, and the collector said [].
      await assert.rejects(() => readConfigfs({ root: join(locked, 'target') }), /could not read/)
      const noExec = { exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }), pipeline: async () => ({ leftExitCode: 1, rightExitCode: 1, leftStderr: '', rightStderr: '', stdout: '' }), execToStream: async () => ({ stderr: '', exitCode: 1, bytesWritten: 0 }) }
      await assert.rejects(() => collectIscsiWarnings(noExec as never, { configfsRoot: join(locked, 'target'), saveconfigPath: join(dir, 'absent.json') }))
      await chmod(locked, 0o700)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// cr3 follow-up — an unreadable configfs DIRECTORY is unknown, never "none"
// ---------------------------------------------------------------------------

describe('cr3 — a configfs directory that cannot be listed is unknown, never "none"', { skip: process.getuid?.() === 0 ? 'root lists a mode-000 directory' : false }, () => {
  it('an unreadable acls/ marks the target, its sessions and LUNs unknown, degrades the node and refuses every change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-acls-'))
    const tpg = join(dir, 'target', 'iscsi', ANAS_T1, 'tpgt_1')
    const acls = join(tpg, 'acls')
    try {
      for (const d of ['np', 'lun', 'acls/iqn.1993-08.org.debian:01:client'])
        await mkdir(join(tpg, d), { recursive: true })
      await mkdir(join(dir, 'target', 'core'), { recursive: true })
      await chmod(acls, 0o000)
      // RED before: listDir answered [] — no ACLs, so no sessions, and every
      // session gate passed in front of a delete or an auth edit.
      const live = await readConfigfs({ root: join(dir, 'target') })
      assert.deepEqual(live.targets[0].unreadable, [acls])
      assert.deepEqual(live.targets[0].tpgs[0].acls, [])

      const ctx = multiTpgCtx()
      ctx.live = { ...live, targets: [{ ...live.targets[0], tpgs: [liveTpg(1, [{ index: 0, name: 'b_x' }])] }] }
      ctx.persisted = { ...ctx.persisted!, targets: [{ iqn: ANAS_T1, fabric: 'iscsi', tpgs: [persistedTpg(1, [{ index: 0, name: 'b_x' }])] }] } as IscsiReadContext['persisted']
      const targets = await buildIscsiTargets(ctx)
      assert.equal(targets[0].sessionsUnknown, true)
      assert.deepEqual(targets[0].configfsUnreadable, [acls])
      assert.equal(targets[0].luns[0].connectedInitiatorsUnknown, true)
      const health = computeIscsiHealth(ctx, targets)
      assert.equal(health.degraded, true)
      assert.deepEqual(health.configfsUnreadable, [acls])
      assert.equal(assertSaveable(ctx, targets)?.reason, 'configfs-unreadable')
      assert.equal((await targetSessionsGate({ state: { ctx, targets }, target: targets[0] }, NO_DEPS))?.reason, 'sessions-unknown')
      assert.ok(buildIscsiWarnings(health).some(c => /could not be read in full/.test(c.message)))

      // The held-by-LUN claims: a failed read, never "nothing held".
      await assert.rejects(() => iscsiClaims({ exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }) } as never, {
        configfsRoot: join(dir, 'target'),
        saveconfigPath: join(dir, 'absent.json'),
        pveStorageCfg: join(dir, 'absent.cfg'),
        zfsMountpoints: async () => [],
      }), /could not be listed in full/)

      // A grant at the point of use (no sink) throws rather than map again.
      await assert.rejects(() => readMappedLuns(acls), /could not list/)
      // A directory that is simply not there is still empty.
      assert.deepEqual(await readMappedLuns(join(dir, 'absent')), [])
    }
    finally {
      await chmod(acls, 0o700).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a LUN of a target whose configfs could not be listed is not reported as a restore hole', async () => {
    const ctx = multiTpgCtx()
    ctx.live.targets = [{ iqn: ANAS_T1, tpgs: [], unreadable: ['/sys/kernel/config/target/iscsi/x/tpgt_1/lun'] }]
    ctx.persisted = { ...ctx.persisted!, targets: [{ iqn: ANAS_T1, fabric: 'iscsi', tpgs: [persistedTpg(1, [{ index: 0, name: 'b_x' }])] }] } as IscsiReadContext['persisted']
    const targets = await buildIscsiTargets(ctx)
    const health = computeIscsiHealth(ctx, targets)
    assert.deepEqual(health.missingLuns, [])
    assert.equal(health.degraded, true)
  })
})

// ---------------------------------------------------------------------------
// cr3 follow-up — an unreadable ZFS mountpoint table leaves a FILE's owner unknown
// ---------------------------------------------------------------------------

describe('cr3 — a failed zfs list leaves a file LUN\'s PVE ownership unknown: never "not PVE\'s", never "foreign"', () => {
  const IMG = '/var/lib/vz/images/lun.raw'
  function unreadableCtx(): IscsiReadContext {
    const ctx = multiTpgCtx()
    ctx.live.backstores = [fileBackstore('img', IMG)]
    ctx.live.targets = [{ iqn: ANAS_T1, tpgs: [liveTpg(1, [{ index: 0, name: 'img' }])] }]
    ctx.persisted = { storageObjects: [so('img', IMG)], targets: [{ iqn: ANAS_T1, fabric: 'iscsi', tpgs: [persistedTpg(1, [{ index: 0, name: 'img' }])] }] } as unknown as IscsiReadContext['persisted']
    ctx.inputs = { pveStorages: new Map(), zfsMountpoints: [], zfsMountpointsUnreadable: true, systemFacts: [] }
    ctx.backing = new Map([[IMG, { exists: true, size: 1 << 30 }]])
    return ctx
  }

  it('classifyBacking: with the table unreadable an unmatched file is UNKNOWN; with it read, foreign as before', () => {
    assert.equal(classifyBacking(IMG, { pveStorages: new Map(), zfsMountpoints: [], zfsMountpointsUnreadable: true }).ownershipUnknown, true)
    assert.equal(classifyBacking(IMG, { pveStorages: new Map(), zfsMountpoints: [] }).kind, 'foreign')
  })

  it('an existing image: the target stays ANAS\'s (H1 rule), the LUN says its owner is unknown', async () => {
    // RED before: kind foreign, target foreign (backing-not-anas-storage) —
    // and with a readable storage.cfg the same file read as "not PVE's".
    const ctx = unreadableCtx()
    const targets = await buildIscsiTargets(ctx)
    assert.equal(targets[0].ownership, 'anas')
    assert.equal(targets[0].luns[0].backingOwnershipUnknown, true)
    assert.equal(deriveOwnership(ANAS_T1, [{ name: 'img', backingPath: IMG, backingExists: true }], ctx.inputs).ownership, 'anas')
  })

  it('destroying its backing is refused with the sentence', async () => {
    const ctx = unreadableCtx()
    const targets = await buildIscsiTargets(ctx)
    const spec = lunDeleteSpec({ executor: {} as never, paths: {} }, ANAS_T1, 0, true, { seed: { ctx, targets }, locks: undefined })
    const reasons: string[] = []
    for (const gate of spec.gates) {
      const r = await gate({ state: { ctx, targets }, target: targets[0], lun: targets[0].luns[0] }, NO_DEPS).catch(() => null)
      if (r)
        reasons.push(r.reason ?? r.code)
    }
    assert.ok(reasons.includes('backing-ownership-unknown'), JSON.stringify(reasons))
  })

  it('a new image LUN on a path or a dataset name is refused, not read as "not PVE\'s"', async () => {
    const ctx = unreadableCtx()
    const noAhr = { exec: async () => ({ stdout: '', stderr: 'cat: /proc/mdstat: No such file or directory\n', exitCode: 1 }) } as never
    const byPath = await resolveFileBackingDir(noAhr, '/var/lib/vz/images', ctx)
    assert.equal('refusal' in byPath && byPath.refusal.reason, 'backing-ownership-unknown')
    const byName = await resolveFileBackingDir(noAhr, 'rpool/data', ctx)
    assert.equal('refusal' in byName && byName.refusal.reason, 'backing-ownership-unknown')
  })
})

describe('cr3 ISCSI-L12 (review) — one rule for an unset CHAP value, in configfs and in saveconfig.json', () => {
  it('the saveconfig parser and the configfs reader give the same answer for NULL, a NULL prefix, empty and a value', () => {
    // RED before: the parser compared exactly against 'NULL', so a stored
    // 'NULLabc' read as SET there and as unset from configfs.
    for (const [v, unset] of [['NULL', true], ['NULLabc', true], ['', true], ['alice', false], ['nullabc', false]] as const) {
      const doc = parseLioSaveconfig(JSON.stringify({ storage_objects: [], targets: [{ wwn: ANAS_T1, fabric: 'iscsi', tpgs: [{ tag: 1, enable: true, attributes: {}, parameters: {}, portals: [], luns: [], node_acls: [{ node_wwn: CLIENT, chap_userid: v, chap_password: v, mapped_luns: [] }] }] }] }))
      const acl = doc.targets[0].tpgs[0].acls[0]
      assert.equal(acl.chapUserid === null, unset, `userid ${JSON.stringify(v)}`)
      assert.equal(acl.chapCredentialsSet, !unset, `password ${JSON.stringify(v)}`)
      assert.equal(authUnset(v), unset, `configfs ${JSON.stringify(v)}`)
    }
  })
})

describe('cr3 (review) — a full-size image on an unexpected mount is never a placeholder', () => {
  it('reported as a wrong-mount warning, read as present, the node not degraded', async () => {
    // RED before: the wrong-mount signal alone made the verdict a stub — the
    // LUN read unresolved and absent, the node degraded, and the quarantine
    // would have unmapped a LUN serving real data (a bind mount, an altroot).
    const IMG = '/tank/images/vm.raw'
    const ctx = multiTpgCtx()
    ctx.live.backstores = [fileBackstore('vm', IMG)]
    ctx.live.targets = [{ iqn: ANAS_T1, tpgs: [liveTpg(1, [{ index: 0, name: 'vm' }])] }]
    ctx.persisted = { storageObjects: [so('vm', IMG)], targets: [{ iqn: ANAS_T1, fabric: 'iscsi', tpgs: [persistedTpg(1, [{ index: 0, name: 'vm' }])] }] } as unknown as IscsiReadContext['persisted']
    ctx.inputs = { pveStorages: new Map(), zfsMountpoints: [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }], systemFacts: [] }
    ctx.backing = new Map([[IMG, { exists: true, size: 1 << 30 }]])
    ctx.mounts = new Map([['/', { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }]])
    const targets = await buildIscsiTargets(ctx)
    assert.equal(targets[0].luns[0].kind, 'file')
    assert.equal(targets[0].luns[0].backingExists, true)
    const health = computeIscsiHealth(ctx, targets)
    assert.equal(health.stubLuns.length, 1)
    assert.deepEqual([health.stubLuns[0].zeroSized, health.stubLuns[0].wrongMount], [false, true])
    assert.equal(health.degraded, false)
    assert.equal(assertSaveable(ctx, targets), null)
    const card = buildIscsiWarnings(health).find(c => c.ref === ANAS_T1)
    assert.equal(card?.level, 'warning')
    assert.match(card?.message ?? '', /full-size, so it holds data and ANAS leaves it serving/)
  })
})

describe('cr3 (review) — the served serials say when they could not be read', () => {
  it('a LIO read that throws: the strict form says unreadable; the old export keeps its empty set', async () => {
    const hostile = {
      get configfsRoot(): string {
        throw new Error('boom')
      },
    } as never
    const strict = await iscsiServedSerialsStrict({} as never, hostile)
    assert.ok('unreadable' in strict && /could not be read \(boom\)/.test(strict.unreadable), JSON.stringify(strict))
    assert.equal((await iscsiServedSerials({} as never, hostile)).size, 0)
  })

  it('a node with no LIO: the strict form answers an empty set, not unreadable', async () => {
    const strict = await iscsiServedSerialsStrict({} as never, { configfsRoot: '/nonexistent-cr3-configfs', saveconfigPath: '/nonexistent-cr3.json' })
    assert.ok('serials' in strict && strict.serials.size === 0, JSON.stringify(strict))
  })
})

describe('cr4 D-11 — a LUN whose backing path could not be read (the probe-2 C3 shape)', () => {
  // A persisted-only target (a restore that did not bring it up) whose only LUN
  // names a backstore the saved config does not carry: neither source can name
  // a backing path, so `backingPath` is ''. RED before: ownership foreign /
  // backing-not-anas-storage with the sentence "backed by , which is not on
  // storage ANAS manages", and an empty path printed in the health message.
  function ctx(): IscsiReadContext {
    return {
      live: { present: true, backstores: [], targets: [] },
      persisted: {
        storageObjects: [],
        targets: [{
          iqn: ANAS_T1,
          fabric: 'iscsi',
          tpgs: [{
            tag: 1,
            enable: true,
            authentication: false,
            generateNodeAcls: false,
            demoModeDiscovery: false,
            tpgCredentialsSet: false,
            portals: [],
            luns: [{ index: 0, storageObject: '/backstores/block/not_in_storage_objects', backstoreName: 'not_in_storage_objects', plugin: 'block' }],
            acls: [],
          }],
        }],
      } as unknown as IscsiReadContext['persisted'],
      inputs: { pveStorages: new Map(), zfsMountpoints: [] },
      nodeAddresses: null,
      backing: new Map(),
      mounts: new Map(),
      stubs: new Map(),
      saveconfigPath: '/etc/rtslib-fb-target/saveconfig.json',
      configfsRoot: '/sys/kernel/config/target',
    }
  }

  it('the target is hands-off with the backing-unreadable reason, and the sentence claims nothing about ownership', async () => {
    const targets = await buildIscsiTargets(ctx())
    assert.equal(targets[0].ownership, 'foreign')
    assert.equal(targets[0].ownershipReason, 'backing-unreadable')
    const detail = targets[0].ownershipDetail
    assert.match(detail, /could not be read from the kernel target configuration/)
    assert.match(detail, /saveconfig\.json/)
    assert.match(detail, /Refresh this screen/)
    assert.doesNotMatch(detail, /is not on storage ANAS manages/)
    assert.doesNotMatch(detail, /backed by ,/)
    // The LUN carries no pool/dataset invented from an empty path.
    assert.equal(targets[0].luns[0].pool, undefined)
    assert.equal(targets[0].luns[0].dataset, undefined)
  })

  it('the restore-hole message no longer prints an empty path', async () => {
    const c = ctx()
    const targets = await buildIscsiTargets(c)
    const refusal = assertSaveable(c, targets)
    assert.ok(refusal)
    assert.doesNotMatch(refusal.message ?? '', /backstore 'not_in_storage_objects', \)/)
    assert.doesNotMatch(refusal.message ?? '', /backed by ,/)
  })
})

describe('cr4 — a target whose LUN directory could not be listed is not "serving nothing"', () => {
  // The hole report next to it is suppressed by `configfsUnreadable` (the LUN
  // list is unknown, not empty). The serving-nothing report must be suppressed
  // the same way: a failed read is not evidence of an empty disk list.
  function ctx(): IscsiReadContext {
    return {
      live: {
        present: true,
        backstores: [],
        targets: [{ iqn: ANAS_IQN, tpgs: [liveTpg(1, [])], unreadable: [`/sys/kernel/config/target/iscsi/${ANAS_IQN}/tpgt_1/lun`] }],
      },
      persisted: {
        storageObjects: [so('b0', '/tank/b0.raw')],
        targets: [{ iqn: ANAS_IQN, fabric: 'iscsi', tpgs: [persistedTpg(1, [{ index: 0, name: 'b0' }])] }],
      } as unknown as IscsiReadContext['persisted'],
      inputs: { pveStorages: new Map(), zfsMountpoints: [] },
      nodeAddresses: null,
      backing: new Map(),
      mounts: new Map(),
      stubs: new Map(),
    }
  }

  it('the serving-nothing report is suppressed, and the LUN list is reported unread', async () => {
    const targets = await buildIscsiTargets(ctx())
    const health = computeIscsiHealth(ctx(), targets)
    assert.deepEqual(health.targetsServingNothing, [])
    // The unreadable list is said, not turned into a fact about LUNs.
    assert.ok((health.configfsUnreadable ?? []).length > 0)
    assert.equal(health.missingLuns.length, 0)
  })

  it('a genuinely empty live LUN list (configfs read fine) still reports serving nothing', async () => {
    // The counterpart: with no unreadable dir, the same live/persisted shape IS
    // the GT-21 restore-with-no-LUNs state and must be reported.
    const c = ctx()
    delete (c.live.targets[0] as { unreadable?: string[] }).unreadable
    const targets = await buildIscsiTargets(c)
    const health = computeIscsiHealth(c, targets)
    assert.equal(health.targetsServingNothing.length, 1)
  })
})
