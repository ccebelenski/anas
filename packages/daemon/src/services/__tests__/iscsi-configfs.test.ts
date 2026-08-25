import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import {
  describeLunHolder,
  findLunHolder,
  lunHoldingDevice,
  parseAclInfo,
  parseBackstoreInfo,
  parseLunSymlinkTarget,
  parseNpDirName,
  parsePluginDir,
  readConfigfs,
  stripUnitSerialPrefix,
} from '../iscsi-configfs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/**
 * Materialise a captured configfs manifest into a temp tree and hand back its
 * root plus a matching `/sys/class/block` stub — a zvol LUN's size lives there,
 * because a block backstore's configfs `info` does not report one.
 */
async function materialize(manifestName: string): Promise<{ root: string, blockRoot: string, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-configfs-'))
  const root = join(dir, 'target')
  await materializeConfigfsManifest(loadFixture(manifestName), root)
  const blockRoot = join(dir, 'block')
  // zd16, 4194304 512-byte sectors = 2 GiB — the live value read off the node.
  await mkdir(join(blockRoot, 'zd16'), { recursive: true })
  await writeFile(join(blockRoot, 'zd16', 'size'), '4194304\n')
  return { root, blockRoot, dir }
}

describe('stripUnitSerialPrefix (GT-13)', () => {
  it('strips the `T10 VPD Unit Serial Number: ` prefix configfs reads back with', () => {
    assert.equal(
      stripUnitSerialPrefix('T10 VPD Unit Serial Number: 9bc6e907-6015-4267-be4f-5a0617cb3d71'),
      '9bc6e907-6015-4267-be4f-5a0617cb3d71',
    )
  })

  it('passes a bare value through, trimmed', () => {
    assert.equal(stripUnitSerialPrefix('  689844a4-1d20-4cba-8516-bdc52a402645  '), '689844a4-1d20-4cba-8516-bdc52a402645')
  })
})

describe('parseBackstoreInfo — the two real `info` shapes', () => {
  it('parses a block backstore: CLAIMED, the volatile kernel name, the stable path', () => {
    // Verbatim from the reboot capture (fixtures/iscsi/reboot-real.txt, GT-48).
    const info = parseBackstoreInfo(
      'Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 32768\n'
      + '        iBlock device: zd16  UDEV PATH: /dev/zvol/gtiscsi/vol1  readonly: 0\n'
      + '  exclusive: 1\n'
      + '        Major: 230 Minor: 16  CLAIMED: IBLOCK',
    )
    assert.equal(info.status, 'ACTIVATED')
    assert.equal(info.claimed, 'IBLOCK')
    assert.equal(info.kernelDevice, 'zd16')
    assert.equal(info.path, '/dev/zvol/gtiscsi/vol1')
    // A block backstore reports NO size — this is why the size comes from sysfs.
    assert.equal(info.size, null)
  })

  it('parses a fileio backstore: the file, its size, no CLAIMED marker', () => {
    const info = parseBackstoreInfo(
      'Status: ACTIVATED  Max Queue Depth: 128  SectorSize: 512  HwMaxSectors: 16384\n'
      + '        TCM FILEIO ID: 0        File: /gtiscsi/images/lun2.raw  Size: 1073741824  Mode: O_DSYNC Async: 0',
    )
    assert.equal(info.status, 'ACTIVATED')
    assert.equal(info.claimed, null)
    assert.equal(info.kernelDevice, null)
    assert.equal(info.path, '/gtiscsi/images/lun2.raw')
    assert.equal(info.size, 1073741824)
  })
})

describe('parseAclInfo — sessions come from acls/<iqn>/info, not dynamic_sessions (GT-38)', () => {
  it('parses a logged-in session with its connection address', () => {
    const s = parseAclInfo(loadFixture('configfs-acl-info-loggedin.txt'), 'fallback')!
    assert.ok(s)
    assert.equal(s.initiatorIqn, 'iqn.1993-08.org.debian:01:ae3d2ec18ad')
    assert.equal(s.initiatorAlias, 'anas-pve')
    assert.equal(s.sessionId, 7)
    assert.equal(s.state, 'TARG_SESS_STATE_LOGGED_IN')
    assert.deepEqual(s.connections, [
      { cid: 0, address: '192.168.200.50', state: 'TARG_CONN_STATE_LOGGED_IN' },
    ])
  })

  it('returns null for the no-session line', () => {
    assert.equal(parseAclInfo(loadFixture('configfs-acl-info-nosession.txt'), 'fallback'), null)
  })

  it('dynamic_sessions really is EMPTY under explicit ACLs', () => {
    assert.equal(loadFixture('configfs-dynamic-sessions-empty.txt'), '')
  })
})

describe('parseNpDirName — an IPv6 np directory is BRACKETED (GT-13)', () => {
  it('parses both address families', () => {
    assert.deepEqual(parseNpDirName('192.168.200.50:3260'), { address: '192.168.200.50', port: 3260, ipv6: false })
    assert.deepEqual(parseNpDirName('[fd00:6774:0:1::1]:3260'), { address: 'fd00:6774:0:1::1', port: 3260, ipv6: true })
  })

  it('returns null for a directory name that is not a portal', () => {
    assert.equal(parseNpDirName('cxgbit'), null)
  })
})

describe('parsePluginDir — the creation index is parsed, never hardcoded (GT-13)', () => {
  it('splits the indexed plugin directory', () => {
    assert.deepEqual(parsePluginDir('iblock_0'), { plugin: 'iblock', index: 0 })
    assert.deepEqual(parsePluginDir('fileio_1'), { plugin: 'fileio', index: 1 })
    // The index moves with creation order — a different index is still fileio.
    assert.deepEqual(parsePluginDir('fileio_7'), { plugin: 'fileio', index: 7 })
  })
})

describe('parseLunSymlinkTarget — matched by its tail, never resolved', () => {
  it('extracts the plugin and backstore name from the real relative target', () => {
    assert.deepEqual(
      parseLunSymlinkTarget('../../../../../../target/core/iblock_0/gtiscsi_vol1'),
      { plugin: 'iblock', name: 'gtiscsi_vol1' },
    )
    assert.deepEqual(
      parseLunSymlinkTarget('../../../../../../target/core/fileio_1/gtiscsi_lun2'),
      { plugin: 'fileio', name: 'gtiscsi_lun2' },
    )
  })

  it('returns null when the target names no backstore', () => {
    assert.equal(parseLunSymlinkTarget('../../../../../../target/iscsi/iqn.x/tpgt_1/lun/lun_0'), null)
  })
})

describe('readConfigfs — the live capture, materialised', () => {
  let root: string
  let blockRoot: string
  let dir: string

  before(async () => {
    ({ root, blockRoot, dir } = await materialize('configfs-live.manifest'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads both backstores with exact serials, paths and attributes', async () => {
    const state = await readConfigfs({ root, blockRoot })
    assert.equal(state.present, true)
    assert.deepEqual(state.backstores.map(b => b.name).sort(), ['gtiscsi_lun2', 'gtiscsi_vol1'])

    const block = state.backstores.find(b => b.name === 'gtiscsi_vol1')!
    assert.equal(block.plugin, 'iblock')
    assert.equal(block.hbaIndex, 0)
    assert.equal(block.udevPath, '/dev/zvol/gtiscsi/vol1')
    assert.equal(block.serial, '9bc6e907-6015-4267-be4f-5a0617cb3d71')
    assert.equal(block.productId, 'gtiscsi_vol1') // GT-15: the SCSI model string
    assert.equal(block.vendorId, 'LIO-ORG')
    assert.equal(block.enabled, true)
    assert.equal(block.status, 'ACTIVATED')
    assert.equal(block.claimed, 'IBLOCK')
    assert.equal(block.kernelDevice, 'zd16')
    assert.equal(block.size, 2 * 1024 * 1024 * 1024) // from /sys/class/block/zd16/size
    assert.deepEqual(block.attributes, {
      emulate_tpu: 1,
      emulate_tpws: 1,
      block_size: 512,
      emulate_write_cache: 0,
      max_unmap_lba_count: 524288,
    })

    const fileio = state.backstores.find(b => b.name === 'gtiscsi_lun2')!
    assert.equal(fileio.plugin, 'fileio')
    assert.equal(fileio.hbaIndex, 1)
    assert.equal(fileio.udevPath, '/gtiscsi/images/lun2.raw')
    assert.equal(fileio.serial, '689844a4-1d20-4cba-8516-bdc52a402645')
    assert.equal(fileio.claimed, null)
    assert.equal(fileio.size, 1073741824) // from its own `info`
    assert.equal(fileio.attributes.max_unmap_lba_count, 262144)
  })

  it('reads the target, its TPG and the portal', async () => {
    const state = await readConfigfs({ root, blockRoot })
    assert.equal(state.targets.length, 1)
    const target = state.targets[0]
    assert.equal(target.iqn, 'iqn.2026-08.dev.anas.gtiscsi:target1')
    const tpg = target.tpgs[0]
    assert.equal(tpg.tag, 1)
    assert.equal(tpg.enabled, true)
    assert.equal(tpg.authentication, true)
    assert.equal(tpg.generateNodeAcls, false)
    assert.equal(tpg.demoModeDiscovery, true)
    assert.deepEqual(tpg.portals, [{ address: '192.168.200.50', port: 3260, ipv6: false }])
    // `dynamic_sessions` is present and EMPTY — sessions come from the ACLs.
    assert.equal(tpg.dynamicSessionsRaw, '')
  })

  it('resolves each LUN to its backstore through the alias-named symlink', async () => {
    const state = await readConfigfs({ root, blockRoot })
    assert.deepEqual(state.targets[0].tpgs[0].luns, [
      { index: 0, backstoreName: 'gtiscsi_vol1', plugin: 'iblock' },
      { index: 1, backstoreName: 'gtiscsi_lun2', plugin: 'fileio' },
    ])
  })

  it('reads ACLs as credentialsSet booleans and NEVER a secret', async () => {
    const state = await readConfigfs({ root, blockRoot })
    const acls = state.targets[0].tpgs[0].acls
    assert.deepEqual(acls.map(a => a.initiatorIqn), [
      'iqn.1993-08.org.debian:01:ae3d2ec18ad',
      'iqn.2026-08.dev.anas.gtiscsi:allowed2',
    ])

    const debian = acls[0]
    assert.equal(debian.chapUserid, 'gtacluser')
    assert.equal(debian.chapCredentialsSet, true)
    assert.equal(debian.mutualUserid, 'gttargetuser')
    assert.equal(debian.mutualCredentialsSet, true)
    // GT-32: setting a mutual secret flips authenticate_target automatically.
    assert.equal(debian.authenticateTarget, true)
    assert.deepEqual(debian.mappedLuns, [0, 1])

    // The ACL with NO credentials. This is the case a size-based emptiness test
    // would get wrong: configfs reports every auth file as 4096 bytes, so
    // emptiness has to come from the CONTENT.
    const allowed2 = acls[1]
    assert.equal(allowed2.chapUserid, null)
    assert.equal(allowed2.chapCredentialsSet, false)
    assert.equal(allowed2.mutualUserid, null)
    assert.equal(allowed2.mutualCredentialsSet, false)
    assert.equal(allowed2.authenticateTarget, false)

    // And nothing anywhere in the live state carries a secret value.
    const serialised = JSON.stringify(state)
    assert.equal(serialised.includes('REDACTED-16char'), false)
    assert.equal(serialised.includes('password'), false)
  })

  it('reports no session when the ACL info says there is none', async () => {
    const state = await readConfigfs({ root, blockRoot })
    for (const acl of state.targets[0].tpgs[0].acls)
      assert.equal(acl.session, null)
  })

  it('picks up a session when an ACL info block carries one', async () => {
    // Overwrite one ACL's `info` with the captured logged-in block.
    const aclInfo = join(
      root,
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
      const state = await readConfigfs({ root, blockRoot })
      const acl = state.targets[0].tpgs[0].acls[0]
      assert.ok(acl.session)
      assert.equal(acl.session.sessionId, 7)
      assert.equal(acl.session.initiatorAlias, 'anas-pve')
      assert.equal(acl.session.state, 'TARG_SESS_STATE_LOGGED_IN')
    }
    finally {
      await writeFile(aclInfo, original)
    }
  })

  it('skips `iscsi/` entries that are not targets (discovery_auth, lio_version)', async () => {
    const state = await readConfigfs({ root, blockRoot })
    assert.equal(state.targets.length, 1)
    // The captured tree really does contain them.
    assert.ok(loadFixture('configfs-live.manifest').includes('iscsi/discovery_auth'))
    assert.ok(loadFixture('configfs-live.manifest').includes('iscsi/lio_version'))
  })
})

describe('readConfigfs — fail-open', () => {
  it('reports an absent configfs tree as present:false, not an error', async () => {
    const state = await readConfigfs({ root: join(tmpdir(), 'anas-no-such-configfs-root') })
    assert.deepEqual(state, { present: false, backstores: [], targets: [] })
  })
})

describe('lunHoldingDevice — the busy-diagnosis seam (GT-41)', () => {
  let root: string
  let blockRoot: string
  let dir: string

  before(async () => {
    ({ root, blockRoot, dir } = await materialize('configfs-live.manifest'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('names the LUN holding a zvol — the claim nothing else in userspace sees', async () => {
    const holder = await lunHoldingDevice('/dev/zvol/gtiscsi/vol1', { root, blockRoot })
    assert.ok(holder)
    assert.equal(holder.targetIqn, 'iqn.2026-08.dev.anas.gtiscsi:target1')
    assert.equal(holder.tpgTag, 1)
    assert.equal(holder.lunIndex, 0)
    assert.equal(holder.backstoreName, 'gtiscsi_vol1')
    // The holder speaks the SAME plugin vocabulary as the LUN model — one
    // definition of `iblock` → `block`, shared with the assembly layer.
    assert.equal(holder.plugin, 'block')
    assert.equal(holder.claimed, 'IBLOCK')
    assert.match(
      describeLunHolder(holder),
      /held by LUN 0 of iSCSI target iqn\.2026-08\.dev\.anas\.gtiscsi:target1/,
    )
  })

  it('names the LUN holding a fileio image file', async () => {
    const holder = await lunHoldingDevice('/gtiscsi/images/lun2.raw', { root, blockRoot })
    assert.equal(holder?.lunIndex, 1)
    assert.equal(holder?.backstoreName, 'gtiscsi_lun2')
  })

  it('matches a DIRECTORY the backing file lives under — the busy-export case', async () => {
    // `zpool export` fails with "cannot unmount '/gtiscsi/images': … busy"
    // (GT-40); the explanation is the LUN under that directory.
    const holder = await lunHoldingDevice('/gtiscsi/images', { root, blockRoot })
    assert.equal(holder?.backstoreName, 'gtiscsi_lun2')
  })

  it('never matches a volatile /dev/zdN name (GT-48)', async () => {
    assert.equal(await lunHoldingDevice('/dev/zd16', { root, blockRoot }), null)
  })

  it('returns null for an unheld path and for an absent LIO stack', async () => {
    assert.equal(await lunHoldingDevice('/dev/zvol/other/vol', { root, blockRoot }), null)
    assert.equal(await lunHoldingDevice('/dev/zvol/gtiscsi/vol1', { root: join(tmpdir(), 'anas-nope') }), null)
    assert.equal(findLunHolder({ present: false, backstores: [], targets: [] }, '/dev/zvol/gtiscsi/vol1'), null)
  })

  it('does not let a prefix match masquerade as a containment match', async () => {
    // /gtiscsi/imagesX must not match a backing file under /gtiscsi/images.
    assert.equal(await lunHoldingDevice('/gtiscsi/image', { root, blockRoot }), null)
  })
})
