import type { CommandExecutor, ExecResult, ExecStreamResult, PipelineResult } from '../../executor/types.js'
import type { StatDevice } from '../iscsi-served.js'
import type { IscsiPaths, IscsiReadContext } from '../iscsi.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { computeIscsiHealth } from '../iscsi-health.js'
import { ZFS } from '../iscsi-mutate.js'
import { readIscsiHealth } from '../iscsi-quarantine.js'
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
    // Interface parity (backup2.7 added the streaming exec); unused here.
    async execToStream(): Promise<ExecStreamResult> {
      return { stderr: '', exitCode: 1, bytesWritten: 0 }
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
      // cr3 (ISCSI-L7): whose target the hole is in. The captured gtiscsi
      // target's IQN is not ANAS's, so it is foreign — and still degrades.
      targetOwnership: 'foreign',
      // own.4 (c): the repair verdict rides the record. This hole is in a
      // foreign target, which is decided from the pure facts alone.
      repair: {
        state: 'foreign-target',
        detail: 'LUN 0 of iqn.2026-08.dev.anas.gtiscsi:target1 (backstore \'gtiscsi_vol1\', /dev/zvol/gtiscsi/vol1) is '
          + 'missing from a target ANAS does not manage. ANAS never writes to a target it does not own, so Repair leaves '
          + 'it alone. Restore it by hand: bring the backing device back, then run \'systemctl restart '
          + 'rtslib-fb-targetctl\' in a maintenance window — it restores the whole saved configuration with the same '
          + 'serials, and drops every iSCSI session on this node while it does. Until then this node stays degraded and '
          + 'ANAS makes no iSCSI change: any save would erase that LUN from /etc/rtslib-fb-target/saveconfig.json. If its '
          + 'device is gone for good, the way out is your own \'targetcli saveconfig\', which writes the live '
          + 'configuration over the saved one and so ERASES that LUN\'s record — a deliberate act, and not one ANAS takes.',
      },
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

  it('cr4: a node with NO targets does not run `ip addr`, and is not "interfaces unknown"', async () => {
    // RED before: the empty read returned nodeAddresses null and health read
    // that as "the addresses could not be read" — a failed read that was never
    // made. The read is genuinely not needed with no targets, so say nothing.
    const dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-notargets-'))
    let ipCalls = 0
    const exec: CommandExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command === '/usr/bin/ip')
          ipCalls++
        return { stdout: '', stderr: '', exitCode: 1 }
      },
      async pipeline(): Promise<PipelineResult> {
        return { leftExitCode: 1, rightExitCode: 1, leftStderr: '', rightStderr: '', stdout: '' }
      },
      async execToStream(): Promise<ExecStreamResult> {
        return { stderr: '', exitCode: 1, bytesWritten: 0 }
      },
    }
    const ctx = await readIscsiContext(exec, { configfsRoot: join(dir, 'target'), saveconfigPath: join(dir, 'saveconfig.json') })
    const health = computeIscsiHealth(ctx, await buildIscsiTargets(ctx))
    assert.equal(ipCalls, 0, 'ip addr must not run with nothing to compare against')
    assert.equal(ctx.nodeAddresses, null)
    assert.equal(ctx.nodeAddressesUnread, undefined, 'a read that was not made is not a failed read')
    assert.equal(health.interfacesUnknown, false)
    await rm(dir, { recursive: true, force: true })
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
      async execToStream(): Promise<ExecStreamResult> {
        return { stderr: '', exitCode: 1, bytesWritten: 0 }
      },
    }
    await readIscsiContext(spy, {
      configfsRoot: join(tmpdir(), 'anas-no-lio-configfs'),
      saveconfigPath: join(tmpdir(), 'anas-no-lio-saveconfig.json'),
    })
    assert.deepEqual(calls, [])
  })
})

/**
 * own.4 (c): the repair verdict as the HEALTH READ attaches it — through
 * `read()` with a job view, on a configfs tree and a saved configuration built
 * for the case. One live zvol LUN (v2) and one hole (v1), so the marks of the
 * live volume and of the hole's volume are one `zfs get`.
 */
describe('own.4 (c) — the repair verdict through read()', () => {
  const IQN = 'iqn.2026-08.nas.anas:vmstore'
  const MARK = { v: 1, repo: 'pbs-main', snapshot: 'host/gtimgboth/2026-08-25T19:28:38Z', archive: 'v1.img', started: '2026-11-14T10:00:00.000Z', state: 'writing' }
  const MARK_DETAIL = 'a whole-image restore of v1.img from host/gtimgboth/2026-08-25T19:28:38Z (repository pbs-main) started 2026-11-14T10:00:00.000Z'
  const READY = 'That path is available again — use Repair on the iSCSI screen to put the LUN back.'
  const ST = { type: 'block' as const, rdevMajor: 230, rdevMinor: 16, dev: '0', ino: '0', size: 0 }

  interface LiveBs { name: string, plugin: 'block' | 'fileio', udevPath: string, serial: string, info?: string }
  interface LiveLun { index: number, backstore: string, plugin: 'block' | 'fileio' }
  interface SavedBs { name: string, plugin: 'block' | 'fileio', dev: string, wwn: string, size?: number | null }
  interface SavedLun { index: number, backstore: string, plugin: 'block' | 'fileio' }

  const V2_BS: LiveBs = { name: 'v2', plugin: 'block', udevPath: '/dev/zvol/tank/v2', serial: 'w-2' }
  const V2_SAVED: SavedBs = { name: 'v2', plugin: 'block', dev: '/dev/zvol/tank/v2', wwn: 'w-2' }
  const V1_SAVED: SavedBs = { name: 'v1', plugin: 'block', dev: '/dev/zvol/tank/v1', wwn: 'w-1' }
  const V2_LUN: LiveLun = { index: 1, backstore: 'v2', plugin: 'block' }
  const V1_LUN: SavedLun = { index: 0, backstore: 'v1', plugin: 'block' }

  async function holeNode(o: {
    iqn?: string
    live?: { backstores?: LiveBs[], luns?: LiveLun[] }
    saved?: { backstores?: SavedBs[], luns?: SavedLun[] }
    backingExists?: (path: string) => Promise<boolean | null>
    backingSize?: (path: string) => Promise<number | null>
    deviceStat?: StatDevice
    findmnt?: () => Promise<string | null>
    zfsMountpoints?: { dataset: string, mountpoint: string, pool: string }[]
    zfsGet?: string
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'anas-hole-health-'))
    const root = join(dir, 'target')
    const iqn = o.iqn ?? IQN
    const tpgDir = join(root, 'iscsi', iqn, 'tpgt_1')
    await mkdir(join(tpgDir, 'lun'), { recursive: true })
    await mkdir(join(tpgDir, 'acls'), { recursive: true })
    await writeFile(join(tpgDir, 'enable'), '1\n')
    for (const b of o.live?.backstores ?? []) {
      const pluginDir = b.plugin === 'block' ? 'iblock_1' : 'fileio_1'
      const bsDir = join(root, 'core', pluginDir, b.name)
      await mkdir(join(bsDir, 'wwn'), { recursive: true })
      await writeFile(join(bsDir, 'wwn', 'vpd_unit_serial'), `T10 VPD Unit Serial Number: ${b.serial}\n`)
      await writeFile(join(bsDir, 'udev_path'), `${b.udevPath}\n`)
      await writeFile(join(bsDir, 'info'), `${b.info ?? 'Status: DEACTIVATED'}\n`)
    }
    for (const l of o.live?.luns ?? []) {
      const pluginDir = l.plugin === 'block' ? 'iblock_1' : 'fileio_1'
      const linkDir = join(tpgDir, 'lun', `lun_${l.index}`)
      await mkdir(linkDir, { recursive: true })
      await symlink(join(root, 'core', pluginDir, l.backstore), join(linkDir, 'l'))
    }
    const saveconfigPath = join(dir, 'saveconfig.json')
    await writeFile(saveconfigPath, JSON.stringify({
      fabric_modules: [],
      storage_objects: (o.saved?.backstores ?? []).map(b => ({
        name: b.name,
        plugin: b.plugin,
        dev: b.dev,
        wwn: b.wwn,
        attributes: {},
        ...(b.size === undefined ? {} : { size: b.size }),
      })),
      targets: [{
        wwn: iqn,
        fabric: 'iscsi',
        parameters: {},
        tpgs: [{
          tag: 1,
          enable: true,
          attributes: {},
          parameters: {},
          portals: [],
          node_acls: [],
          luns: (o.saved?.luns ?? []).map(l => ({ index: l.index, storage_object: `/backstores/${l.plugin}/${l.backstore}` })),
        }],
      }],
    }))
    const zfs: string[][] = []
    const executor: CommandExecutor = {
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === '/usr/bin/ip') {
          return {
            stdout: JSON.stringify([{ ifname: 'vmbr0', addr_info: [{ family: 'inet', local: '192.168.200.50' }] }]),
            stderr: '',
            exitCode: 0,
          }
        }
        if (command === ZFS && args[0] === 'get') {
          zfs.push(args)
          return { stdout: o.zfsGet ?? '', stderr: '', exitCode: 0 }
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
    const paths: IscsiPaths = {
      configfsRoot: root,
      saveconfigPath,
      pveStorageCfg: join(dir, 'no-storage.cfg'),
      initiatorNamePath: join(dir, 'no-initiator'),
      backingExists: o.backingExists ?? (async () => true),
      zfsMountpoints: async () => o.zfsMountpoints ?? [],
      ...(o.backingSize ? { backingSize: o.backingSize } : {}),
      // A block hole's stat: a device no fixture backstore names, so a default
      // is never read as "served elsewhere".
      deviceStat: o.deviceStat ?? (async () => ({ type: 'block', rdevMajor: 230, rdevMinor: 0, dev: '0', ino: '0', size: 0 })),
      ...(o.findmnt ? { findmnt: o.findmnt } : {}),
    }
    return { dir, paths, executor, zfs, close: () => rm(dir, { recursive: true, force: true }) }
  }

  const jobs = { restoreRunning: () => undefined, restoreFailed: () => undefined }

  it('a live zvol LUN and a hole: ONE zfs get covers both volumes, and the hole reads ready', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS], luns: [V2_LUN] },
      saved: { backstores: [V2_SAVED, V1_SAVED], luns: [V2_LUN, V1_LUN] },
      zfsGet: 'tank/v2\t-\t-\ntank/v1\t-\t-\n',
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns.length, 1)
      assert.deepEqual(health.missingLuns[0].repair, { state: 'ready', detail: READY })
      assert.deepEqual(node.zfs, [['get', '-Hp', '-o', 'name,value,source', 'anas:restore', '--', 'tank/v2', 'tank/v1']], 'the marks of the live volume and the hole are ONE command')
      assert.equal(node.zfs.length, 1)
    }
    finally {
      await node.close()
    }
  })

  it('a marked hole volume reads restore-mark, with where the mark is', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS], luns: [V2_LUN] },
      saved: { backstores: [V2_SAVED, V1_SAVED], luns: [V2_LUN, V1_LUN] },
      zfsGet: `tank/v2\t-\t-\ntank/v1\t${JSON.stringify(MARK)}\tlocal\n`,
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.deepEqual(health.missingLuns[0].repair, {
        state: 'restore-mark',
        detail: `${MARK_DETAIL} onto tank/v1 did not finish, so it holds a partial image`,
        restoreMark: 'interrupted',
        markOn: 'tank/v1',
      })
      assert.equal(node.zfs.length, 1, 'still one zfs get')
    }
    finally {
      await node.close()
    }
  })

  it('an absent backing reads backing-absent, and its volume is NOT read', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS], luns: [V2_LUN] },
      saved: { backstores: [V2_SAVED, V1_SAVED], luns: [V2_LUN, V1_LUN] },
      backingExists: async p => (p !== '/dev/zvol/tank/v1'),
      zfsGet: 'tank/v2\t-\t-\n',
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns[0].repair?.state, 'backing-absent')
      assert.deepEqual(node.zfs, [['get', '-Hp', '-o', 'value,source', 'anas:restore', '--', 'tank/v2']], 'an absent backing never joins the batch (one volume left, read on its own)')
    }
    finally {
      await node.close()
    }
  })

  it('an existence check that failed reads backing-unreadable, never absent', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS], luns: [V2_LUN] },
      saved: { backstores: [V2_SAVED, V1_SAVED], luns: [V2_LUN, V1_LUN] },
      backingExists: async p => (p === '/dev/zvol/tank/v1' ? null : true),
      zfsGet: 'tank/v2\t-\t-\n',
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns[0].repair?.state, 'backing-unreadable')
    }
    finally {
      await node.close()
    }
  })

  it('a live backstore of the hole\'s name and plugin reads backstore-live', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS, { ...V1_SAVED, udevPath: '/dev/zvol/tank/v1', serial: 'w-1' }], luns: [V2_LUN] },
      saved: { backstores: [V2_SAVED, V1_SAVED], luns: [V2_LUN, V1_LUN] },
      zfsGet: 'tank/v2\t-\t-\ntank/v1\t-\t-\n',
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns[0].repair?.state, 'backstore-live')
      assert.match(health.missingLuns[0].repair!.detail, /^backstore 'v1' \(block, \/dev\/zvol\/tank\/v1\) is still live and no LUN maps it/)
    }
    finally {
      await node.close()
    }
  })

  it('the hole\'s device served by another live backstore reads device-served-elsewhere', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS, { name: 'other', plugin: 'block', udevPath: '/dev/zvol/tank/other', serial: 's', info: 'Status: DEACTIVATED Major: 230 Minor: 16' }], luns: [V2_LUN] },
      saved: { backstores: [V2_SAVED, V1_SAVED], luns: [V2_LUN, V1_LUN] },
      zfsGet: 'tank/v2\t-\t-\ntank/v1\t-\t-\n',
      deviceStat: async () => ST,
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns[0].repair?.state, 'device-served-elsewhere')
    }
    finally {
      await node.close()
    }
  })

  it('a fileio record with no size reads record-incomplete', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS], luns: [V2_LUN] },
      saved: {
        backstores: [V2_SAVED, { name: 'v1', plugin: 'fileio', dev: '/tank/images/v1.raw', wwn: 'w-1', size: null }],
        luns: [V2_LUN, { index: 0, backstore: 'v1', plugin: 'fileio' }],
      },
      zfsMountpoints: [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }],
      zfsGet: 'tank/v2\t-\t-\n',
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns[0].repair?.state, 'record-incomplete')
    }
    finally {
      await node.close()
    }
  })

  it('a 0-byte image against a saved size reads placeholder', async () => {
    const node = await holeNode({
      live: { backstores: [V2_BS], luns: [V2_LUN] },
      saved: {
        backstores: [V2_SAVED, { name: 'v1', plugin: 'fileio', dev: '/tank/images/v1.raw', wwn: 'w-1', size: 1048576 }],
        luns: [V2_LUN, { index: 0, backstore: 'v1', plugin: 'fileio' }],
      },
      zfsGet: 'tank/v2\t-\t-\n',
      backingSize: async p => (p === '/tank/images/v1.raw' ? 0 : null),
      zfsMountpoints: [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }],
      findmnt: async () => JSON.stringify({ filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }] }),
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns[0].repair?.state, 'placeholder')
    }
    finally {
      await node.close()
    }
  })

  it('a foreign IQN reads foreign-target, decided without its I/O facts', async () => {
    const foreign = 'iqn.2026-08.other.example:target1'
    const node = await holeNode({
      iqn: foreign,
      live: { backstores: [V2_BS], luns: [V2_LUN] },
      saved: { backstores: [V2_SAVED, V1_SAVED], luns: [V2_LUN, V1_LUN] },
      zfsGet: 'tank/v2\t-\t-\ntank/v1\t-\t-\n',
    })
    try {
      const { health } = await readIscsiHealth(node.executor, node.paths, jobs)
      assert.equal(health.missingLuns[0].repair?.state, 'foreign-target')
    }
    finally {
      await node.close()
    }
  })
})
