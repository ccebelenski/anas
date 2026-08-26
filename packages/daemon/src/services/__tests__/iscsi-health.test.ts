import type { CommandExecutor, ExecResult, PipelineResult } from '../../executor/types.js'
import type { IscsiReadContext } from '../iscsi.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { computeIscsiHealth } from '../iscsi-health.js'
import { buildIscsiTargets, collectIscsiSessions, iscsiAvailability, parseIpAddrJson, readIscsiContext, toTargetSummary } from '../iscsi.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/**
 * A minimal executor: only `ip -j addr` is consulted by the iSCSI read layer
 * (and `cat /proc/mdstat`, when a file LUN resolved onto no ZFS dataset).
 */
function executorWithAddresses(addresses: string[] | null): CommandExecutor {
  return {
    async exec(command: string): Promise<ExecResult> {
      if (command === '/usr/bin/ip') {
        if (addresses === null)
          return { stdout: '', stderr: 'ip: command failed', exitCode: 1 }
        return {
          stdout: JSON.stringify([{
            ifname: 'vmbr0',
            addr_info: addresses.map(local => ({ family: local.includes(':') ? 'inet6' : 'inet', local })),
          }]),
          stderr: '',
          exitCode: 0,
        }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    },
    async pipeline(): Promise<PipelineResult> {
      return { leftExitCode: 1, rightExitCode: 1, leftStderr: '', rightStderr: '', stdout: '' }
    },
  }
}

interface Materialized { root: string, blockRoot: string, dir: string }

async function materialize(manifestName: string): Promise<Materialized> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-health-'))
  const root = join(dir, 'target')
  await materializeConfigfsManifest(loadFixture(manifestName), root)
  const blockRoot = join(dir, 'block')
  await mkdir(join(blockRoot, 'zd16'), { recursive: true })
  await writeFile(join(blockRoot, 'zd16', 'size'), '4194304\n')
  return { root, blockRoot, dir }
}

async function context(m: Materialized, opts: { addresses?: string[] | null, saveconfig?: string } = {}): Promise<IscsiReadContext> {
  // `addresses: null` means "the read failed" and must survive the default.
  const addresses = 'addresses' in opts ? opts.addresses! : ['192.168.200.50', '127.0.0.1']
  return readIscsiContext(executorWithAddresses(addresses), {
    configfsRoot: m.root,
    blockRoot: m.blockRoot,
    saveconfigPath: join(fixturesDir, opts.saveconfig ?? 'saveconfig-final.json'),
    // storage.cfg does not exist here, so no pool is PVE-managed — which is the
    // right answer on a dev box and keeps the ownership half deterministic.
    pveStorageCfg: join(fixturesDir, 'no-such-storage.cfg'),
  })
}

describe('parseIpAddrJson', () => {
  it('collects every local address from the real `ip -j addr` shape', () => {
    // Trimmed but verbatim from the stunt node.
    const set = parseIpAddrJson(JSON.stringify([
      { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1' }, { family: 'inet6', local: '::1' }] },
      { ifname: 'enp1s0', addr_info: [] },
      { ifname: 'vmbr0', addr_info: [{ family: 'inet', local: '192.168.200.50' }, { family: 'inet6', local: 'fe80::5054:ff:fea0:a501' }] },
    ]))
    const addresses = [...set]
    addresses.sort()
    assert.deepEqual(addresses, ['127.0.0.1', '192.168.200.50', '::1', 'fe80::5054:ff:fea0:a501'])
  })

  it('returns an empty set for junk rather than throwing', () => {
    assert.equal(parseIpAddrJson('not json').size, 0)
    assert.equal(parseIpAddrJson('{}').size, 0)
  })
})

describe('buildIscsiTargets — the persisted+live join, against the real captures', () => {
  let m: Materialized

  before(async () => {
    m = await materialize('configfs-live.manifest')
  })

  after(async () => {
    await rm(m.dir, { recursive: true, force: true })
  })

  it('builds one target with both LUNs, serials, sizes and normalised plugins', async () => {
    const targets = await buildIscsiTargets(await context(m))
    assert.equal(targets.length, 1)
    const t = targets[0]
    assert.equal(t.iqn, 'iqn.2026-08.dev.anas.gtiscsi:target1')
    assert.equal(t.present, true)
    assert.equal(t.persisted, true)
    assert.equal(t.enabled, true)
    assert.equal(t.tpgTag, 1)
    assert.equal(t.lunCount, 2)
    assert.equal(t.aclCount, 2)
    assert.deepEqual(t.security, { authentication: true, generateNodeAcls: false, demoModeDiscovery: true })

    const [lun0, lun1] = t.luns
    // configfs says `iblock`, saveconfig says `block` — one vocabulary wins.
    assert.equal(lun0.plugin, 'block')
    assert.equal(lun0.name, 'gtiscsi_vol1')
    assert.equal(lun0.backingPath, '/dev/zvol/gtiscsi/vol1')
    assert.equal(lun0.serial, '9bc6e907-6015-4267-be4f-5a0617cb3d71')
    assert.equal(lun0.size, 2 * 1024 * 1024 * 1024)
    assert.equal(lun0.present, true)
    assert.deepEqual(lun0.attributes, {
      emulateTpu: true,
      emulateTpws: true,
      blockSize: 512,
      writeBack: false,
      maxUnmapLbaCount: 524288,
    })

    assert.equal(lun1.plugin, 'fileio')
    assert.equal(lun1.serial, '689844a4-1d20-4cba-8516-bdc52a402645')
    assert.equal(lun1.size, 1073741824)
    assert.equal(lun1.attributes.maxUnmapLbaCount, 262144)
  })

  it('reports the backing objects as missing on a host that has none of them', async () => {
    // /dev/zvol/gtiscsi/vol1 and /gtiscsi/images/lun2.raw do not exist here —
    // the GT-40 dangling-path case, reported as broken rather than hidden.
    const targets = await buildIscsiTargets(await context(m))
    for (const lun of targets[0].luns)
      assert.equal(lun.backingExists, false)
  })

  it('the GT target is FOREIGN, and says why', async () => {
    // Its naming authority is `dev.anas.gtiscsi` — it was built by hand during
    // the ground-truth run, not generated by ANAS.
    const targets = await buildIscsiTargets(await context(m))
    assert.equal(targets[0].ownership, 'foreign')
    assert.equal(targets[0].ownershipReason, 'iqn-not-anas')
    assert.equal(targets[0].name, null)
  })

  it('marks the portal as carried when the node holds that address', async () => {
    const targets = await buildIscsiTargets(await context(m, { addresses: ['192.168.200.50'] }))
    assert.deepEqual(targets[0].portals, [{
      address: '192.168.200.50',
      port: 3260,
      family: 'inet',
      carriedByInterface: true,
    }])
    assert.equal(targets[0].portalsWithoutInterfaceCount, 0)
  })

  it('marks the portal as NOT carried when no interface has it (GT-24)', async () => {
    const targets = await buildIscsiTargets(await context(m, { addresses: ['10.0.0.9'] }))
    assert.equal(targets[0].portals[0].carriedByInterface, false)
    assert.equal(targets[0].portalsWithoutInterfaceCount, 1)
  })

  it('leaves carriedByInterface NULL when the addresses could not be read', async () => {
    const targets = await buildIscsiTargets(await context(m, { addresses: null }))
    assert.equal(targets[0].portals[0].carriedByInterface, null)
    assert.equal(targets[0].portalsWithoutInterfaceCount, 0)
  })

  it('carries ACLs as booleans, and no secret survives the whole pipeline', async () => {
    const targets = await buildIscsiTargets(await context(m))
    const acls = targets[0].acls
    assert.equal(acls[0].chapUserid, 'gtacluser')
    assert.equal(acls[0].chapCredentialsSet, true)
    assert.equal(acls[0].mutualCredentialsSet, true)
    assert.equal(acls[1].chapCredentialsSet, false)
    const serialised = JSON.stringify(targets)
    assert.equal(serialised.includes('REDACTED-16char'), false)
    assert.equal(serialised.includes('password'), false)
  })

  it('reports no sessions when every ACL info says there is none', async () => {
    const targets = await buildIscsiTargets(await context(m))
    assert.deepEqual(collectIscsiSessions(targets), [])
    assert.equal(targets[0].sessionCount, 0)
    for (const lun of targets[0].luns)
      assert.deepEqual(lun.connectedInitiators, [])
  })

  it('surfaces a live session and attributes it to the LUNs it maps', async () => {
    const aclInfo = join(
      m.root,
      'iscsi',
      'iqn.2026-08.dev.anas.gtiscsi:target1',
      'tpgt_1',
      'acls',
      'iqn.1993-08.org.debian:01:ae3d2ec18ad',
      'info',
    )
    const original = readFileSync(aclInfo, 'utf-8')
    try {
      await writeFile(aclInfo, loadFixture('configfs-acl-info-loggedin.txt'))
      const targets = await buildIscsiTargets(await context(m))
      const sessions = collectIscsiSessions(targets)
      assert.equal(sessions.length, 1)
      assert.deepEqual(sessions[0], {
        initiatorIqn: 'iqn.1993-08.org.debian:01:ae3d2ec18ad',
        initiatorAlias: 'anas-pve',
        targetIqn: 'iqn.2026-08.dev.anas.gtiscsi:target1',
        tpgTag: 1,
        sessionId: 7,
        state: 'TARG_SESS_STATE_LOGGED_IN',
        connections: [{ cid: 0, address: '192.168.200.50', state: 'TARG_CONN_STATE_LOGGED_IN' }],
        mappedLuns: [0, 1],
      })
      assert.equal(targets[0].sessionCount, 1)
      for (const lun of targets[0].luns)
        assert.deepEqual(lun.connectedInitiators, ['iqn.1993-08.org.debian:01:ae3d2ec18ad'])
    }
    finally {
      await writeFile(aclInfo, original)
    }
  })

  it('toTargetSummary drops the detail arrays and keeps the counts', async () => {
    const targets = await buildIscsiTargets(await context(m))
    const summary = toTargetSummary(targets[0]) as Record<string, unknown>
    assert.equal('luns' in summary, false)
    assert.equal('acls' in summary, false)
    assert.equal('sessions' in summary, false)
    assert.equal(summary.lunCount, 2)
  })
})

describe('computeIscsiHealth — the restore hole (GT-20/GT-21)', () => {
  let live: Materialized
  let hole: Materialized

  before(async () => {
    live = await materialize('configfs-live.manifest')
    hole = await materialize('configfs-restore-hole.manifest')
  })

  after(async () => {
    await rm(live.dir, { recursive: true, force: true })
    await rm(hole.dir, { recursive: true, force: true })
  })

  it('a healthy node reports no missing LUNs and is not degraded', async () => {
    const ctx = await context(live, { addresses: ['192.168.200.50'] })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.equal(health.installed, true)
    assert.equal(health.configfsPresent, true)
    assert.equal(health.saveconfigPresent, true)
    assert.deepEqual(health.missingLuns, [])
    assert.deepEqual(health.targetsServingNothing, [])
    assert.deepEqual(health.portalsWithoutInterface, [])
    assert.deepEqual(health.foreignChanges, [])
    assert.equal(health.degraded, false)
    assert.equal(health.interfacesUnknown, false)
    assert.ok(Date.parse(health.checkedAt) > 0)
  })

  it('names the LUN a degraded restore silently dropped', async () => {
    // saveconfig has 2 LUNs; configfs has only the fileio one, because the
    // block backing device was missing at restore. systemd said SUCCESS.
    const ctx = await context(hole, { addresses: ['192.168.200.50'] })
    const targets = await buildIscsiTargets(ctx)
    const health = computeIscsiHealth(ctx, targets)

    assert.equal(health.missingLuns.length, 1)
    assert.deepEqual(health.missingLuns[0], {
      targetIqn: 'iqn.2026-08.dev.anas.gtiscsi:target1',
      tpgTag: 1,
      lunIndex: 0,
      backstoreName: 'gtiscsi_vol1',
      plugin: 'block',
      backingPath: '/dev/zvol/gtiscsi/vol1',
      backingExists: false,
    })
    // The guard: while this is true nothing may run `saveconfig` (GT-22).
    assert.equal(health.degraded, true)
    // The target itself is still up and still listening — that is the trap.
    assert.equal(targets[0].present, true)
    assert.equal(targets[0].enabled, true)
    assert.equal(targets[0].missingLunCount, 1)
    assert.equal(targets[0].lunCount, 2)
    assert.equal(targets[0].luns[0].present, false)
    assert.equal(targets[0].luns[1].present, true)
  })

  it('one hole out of two LUNs is NOT a target serving nothing', async () => {
    const ctx = await context(hole, { addresses: ['192.168.200.50'] })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.equal(health.missingLuns.length, 1)
    assert.deepEqual(health.targetsServingNothing, [])
  })

  it('the whole pool late: the target comes up enabled with ZERO LUNs (GT-21)', async () => {
    // The second half of the finding. Both LUNs are holes, so the target is
    // live, enabled and listening while an initiator that logs in sees no disks
    // at all — and systemd reported success throughout.
    const empty = await materialize('configfs-restore-empty.manifest')
    try {
      const ctx = await context(empty, { addresses: ['192.168.200.50'] })
      const targets = await buildIscsiTargets(ctx)
      const health = computeIscsiHealth(ctx, targets)

      assert.equal(targets[0].present, true)
      assert.equal(targets[0].enabled, true)
      assert.equal(health.missingLuns.length, 2)
      assert.deepEqual(health.targetsServingNothing, [{
        targetIqn: 'iqn.2026-08.dev.anas.gtiscsi:target1',
        tpgTag: 1,
        persistedLunCount: 2,
        enabled: true,
      }])
      assert.equal(health.degraded, true)
    }
    finally {
      await rm(empty.dir, { recursive: true, force: true })
    }
  })

  it('a persisted target that did not restore at all is not "serving nothing"', async () => {
    // Nothing is live, so nothing is lying to an initiator — that is the
    // `target-not-restored` finding instead.
    const ctx = await readIscsiContext(executorWithAddresses(['192.168.200.50']), {
      configfsRoot: join(tmpdir(), 'anas-no-such-configfs-2'),
      saveconfigPath: join(fixturesDir, 'saveconfig-final.json'),
      pveStorageCfg: join(fixturesDir, 'no-such-storage.cfg'),
    })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.deepEqual(health.targetsServingNothing, [])
  })

  it('a missing LUN still carries its serial and size from the persisted config', async () => {
    // Which is exactly what a repair has to replay (GT-16/GT-18).
    const ctx = await context(hole)
    const targets = await buildIscsiTargets(ctx)
    const missing = targets[0].luns[0]
    assert.equal(missing.serial, '9bc6e907-6015-4267-be4f-5a0617cb3d71')
    assert.equal(missing.name, 'gtiscsi_vol1')
    assert.equal(missing.attributes.emulateTpu, true)
    assert.equal(missing.attributes.maxUnmapLbaCount, 524288)
  })

  it('reports a portal no interface carries (LIO never will — GT-24)', async () => {
    const ctx = await context(live, { addresses: ['10.0.0.9'] })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.deepEqual(health.portalsWithoutInterface, [{
      targetIqn: 'iqn.2026-08.dev.anas.gtiscsi:target1',
      tpgTag: 1,
      address: '192.168.200.50',
      port: 3260,
    }])
  })

  it('reports nothing about portals when the interfaces are unknown', async () => {
    const ctx = await context(live, { addresses: null })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.deepEqual(health.portalsWithoutInterface, [])
    assert.equal(health.interfacesUnknown, true)
  })

  it('reports portals and a LUN that exist live but were never persisted', async () => {
    // The three-portal capture as the PERSISTED side against the one-portal
    // live tree: two portals in the file are not live, and the live config has
    // no extras. Both directions are surfaced.
    const ctx = await context(live, {
      addresses: ['192.168.200.50'],
      saveconfig: 'saveconfig-acl-nochap.json',
    })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    const kinds = health.foreignChanges.map(c => `${c.kind}`).sort()
    assert.deepEqual(kinds, ['portal-not-restored', 'portal-not-restored'])
    assert.ok(health.foreignChanges.every(c => c.targetIqn === 'iqn.2026-08.dev.anas.gtiscsi:target1'))
    assert.ok(health.foreignChanges.some(c => c.detail.includes('fd00:6774:0:1::1')))
    assert.ok(health.foreignChanges.some(c => c.detail.includes('10.99.99.1')))
  })

  it('a live target with NO saveconfig at all is reported as not persisted', async () => {
    const ctx = await readIscsiContext(executorWithAddresses(['192.168.200.50']), {
      configfsRoot: live.root,
      blockRoot: live.blockRoot,
      saveconfigPath: join(fixturesDir, 'no-such-saveconfig.json'),
      pveStorageCfg: join(fixturesDir, 'no-such-storage.cfg'),
    })
    const targets = await buildIscsiTargets(ctx)
    const health = computeIscsiHealth(ctx, targets)
    assert.equal(health.saveconfigPresent, false)
    assert.equal(health.installed, true) // configfs alone is enough
    assert.equal(targets[0].persisted, false)
    assert.deepEqual(health.foreignChanges.map(c => c.kind), ['target-not-persisted'])
    // No saveconfig means no restore hole is knowable — degraded stays false.
    assert.equal(health.degraded, false)
  })

  it('a persisted target that did not come up at all is reported too', async () => {
    const ctx = await readIscsiContext(executorWithAddresses(['192.168.200.50']), {
      configfsRoot: join(tmpdir(), 'anas-no-such-configfs'),
      saveconfigPath: join(fixturesDir, 'saveconfig-final.json'),
      pveStorageCfg: join(fixturesDir, 'no-such-storage.cfg'),
    })
    const targets = await buildIscsiTargets(ctx)
    const health = computeIscsiHealth(ctx, targets)
    assert.equal(health.configfsPresent, false)
    assert.equal(health.saveconfigPresent, true)
    assert.equal(targets[0].present, false)
    assert.ok(health.foreignChanges.some(c => c.kind === 'target-not-restored'))
  })
})

describe('the not-installed path is a first-class state, never an error', () => {
  it('reports installed:false with a reason and empty everything', async () => {
    const ctx = await readIscsiContext(executorWithAddresses(['192.168.200.50']), {
      configfsRoot: join(tmpdir(), 'anas-no-lio-configfs'),
      saveconfigPath: join(tmpdir(), 'anas-no-lio-saveconfig.json'),
    })
    const availability = iscsiAvailability(ctx)
    assert.equal(availability.installed, false)
    assert.equal(availability.configfsPresent, false)
    assert.equal(availability.saveconfigPresent, false)
    assert.match(availability.reason!, /not present on this node/)

    const targets = await buildIscsiTargets(ctx)
    assert.deepEqual(targets, [])
    const health = computeIscsiHealth(ctx, targets)
    assert.deepEqual(health.missingLuns, [])
    assert.deepEqual(health.targetsServingNothing, [])
    assert.deepEqual(health.portalsWithoutInterface, [])
    assert.deepEqual(health.foreignChanges, [])
    assert.equal(health.degraded, false)
  })

  it('costs no extra system reads when there is nothing to read', async () => {
    // Principle 7: no targets ⇒ no storage.cfg, no zfs list, no ip addr.
    const calls: string[] = []
    const spy: CommandExecutor = {
      async exec(command: string): Promise<ExecResult> {
        calls.push(command)
        return { stdout: '', stderr: '', exitCode: 1 }
      },
      async pipeline(): Promise<PipelineResult> {
        return { leftExitCode: 1, rightExitCode: 1, leftStderr: '', rightStderr: '', stdout: '' }
      },
    }
    await readIscsiContext(spy, {
      configfsRoot: join(tmpdir(), 'anas-no-lio-configfs'),
      saveconfigPath: join(tmpdir(), 'anas-no-lio-saveconfig.json'),
    })
    assert.deepEqual(calls, [])
  })
})
