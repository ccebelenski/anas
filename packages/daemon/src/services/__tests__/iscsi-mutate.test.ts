import type { IscsiTargetDetail } from '@anas/shared'
import type { IscsiReadContext } from '../iscsi.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { LVS_ARGS, PVS_ARGS, VGS_ARGS } from '../../parsers/lvm-report.js'
import { mdadmDetailExportArgs } from '../../parsers/mdadm-detail.js'
import { MDSTAT_CAT_ARGS } from '../../parsers/mdstat.js'
import { AHR_FINDMNT_ARGS, AHR_LSBLK_ARGS } from '../ahr-topology.js'
import {
  ACL_AUTH_NULL,
  aclAuthPath,
  addIscsiLun,
  applyAclCredentials,
  assertNoSecretArgs,
  assertSaveable,
  attributeTokens,
  claimsFromTargets,
  createIscsiTarget,
  createSparseImage,
  defaultBackstoreAttributes,
  deleteIscsiLun,
  deleteIscsiTarget,
  growImageFile,
  growZvolLun,
  imageFilePath,
  ISCSI_MAX_UNMAP_LBA_COUNT,
  iscsiNodeName,
  newSerial,
  newTargetIqn,
  nextLunIndex,
  replayAttributes,
  resizeFileLun,
  resolveFileBackingDir,
  resolveZvolBacking,
  runTargetcli,
  SecretOnArgvError,
  setIscsiTargetState,
  setLunWriteBack,
  TARGETCLI,
  TargetcliError,
  withIscsiLock,
  zvolDataset,
  zvolDevicePath,
} from '../iscsi-mutate.js'

/**
 * iSCSI mutation sequences, asserted as EXACT argv lists (story `iscsi.4`).
 *
 * Every check in this file is really the same check: what ANAS hands to
 * `targetcli`, in what order, one command per process. That matters more here
 * than anywhere else in the codebase because `targetcli` is not transactional —
 * a sequence that half-applies has no rollback — and because three of the
 * orderings are load-bearing facts from the ground-truth run rather than
 * preferences:
 *
 *   - `wwn=` is a CREATE parameter with no `set` verb (GT-16),
 *   - `block_size` stops being settable the moment the LUN is mapped (GT-27),
 *   - attributes are dropped on every recreate, so a fileio resize has to replay
 *     the whole set AND the serial AND the LUN index (GT-18/GT-29).
 *
 * The MockExecutor's `calls` array is the whole point: it records the exact argv
 * of every invocation, which is also how the "a CHAP secret never reaches argv"
 * check is made — by sweeping the FULL call log for the secret string.
 */

const IQN = 'iqn.2026-08.nas.anas:vmstore'
const INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
const SECRET = 'correcthorseba' // 14 bytes — inside the 12–16 range
const MUTUAL = 'batterystaple1' // 14 bytes

/** Only the targetcli invocations, as flat argv strings. */
function targetcliCalls(mock: MockExecutor): string[] {
  return mock.calls.filter(c => c.command === TARGETCLI).map(c => c.args.join(' '))
}

/** A MockExecutor whose targetcli always succeeds. */
function okExecutor(): MockExecutor {
  const mock = new MockExecutor()
  mock.addFixture({ command: TARGETCLI, result: { stdout: '', stderr: '', exitCode: 0 } })
  return mock
}

/** An empty read context — the mutation helpers only use `inputs` for backing. */
function emptyCtx(overrides?: Partial<IscsiReadContext>): IscsiReadContext {
  return {
    live: { present: true, backstores: [], targets: [] },
    persisted: { fabricModules: [], storageObjects: [], targets: [] },
    inputs: { pveStorages: new Map(), zfsMountpoints: [] },
    nodeAddresses: null,
    backing: new Map(),
    mounts: new Map(),
    stubs: new Map(),
    ...overrides,
  } as IscsiReadContext
}

/** A minimal ANAS-owned target detail, enough to drive the sequences. */
function target(overrides?: Partial<IscsiTargetDetail>): IscsiTargetDetail {
  return {
    iqn: IQN,
    name: 'vmstore',
    ownership: 'anas',
    ownershipReason: 'anas-managed',
    ownershipDetail: '',
    tpgTag: 1,
    enabled: true,
    portals: [{ address: '192.168.200.50', port: 3260, family: 'inet', carriedByInterface: true }],
    lunCount: 0,
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
    ...overrides,
  } as IscsiTargetDetail
}

describe('runTargetcli — one command per invocation, real exit code (GT-5)', () => {
  it('passes the command line as an argv ARRAY, never a shell string', async () => {
    const mock = okExecutor()
    await runTargetcli(mock, ['/iscsi', 'create', IQN])
    assert.deepEqual(mock.calls[0], { command: TARGETCLI, args: ['/iscsi', 'create', IQN] })
  })

  it('throws on a non-zero exit, carrying what targetcli said', async () => {
    const mock = new MockExecutor()
    mock.addFixture({
      command: TARGETCLI,
      result: { stdout: 'Could not create NetworkPortal in configFS\n', stderr: '', exitCode: 1 },
    })
    await assert.rejects(
      () => runTargetcli(mock, ['/iscsi/x/tpg1/portals', 'create', 'fe80::1', '3260']),
      (err: unknown) => {
        assert.ok(err instanceof TargetcliError)
        assert.match((err as Error).message, /Could not create NetworkPortal/)
        return true
      },
    )
  })

  it('REFUSES to build a command that would put a CHAP secret on argv (GT-35)', () => {
    // The obvious targetcli call is `… set auth password=X`, which shows the
    // secret in `ps` for every local user. The refusal is structural, not a
    // comment, so a future edit that reaches for it fails loudly.
    assert.throws(() => assertNoSecretArgs(['x', `password=${SECRET}`]), SecretOnArgvError)
    assert.throws(() => assertNoSecretArgs([`password_mutual=${MUTUAL}`]), SecretOnArgvError)
    assert.throws(() => assertNoSecretArgs([`mutual_password=${MUTUAL}`]), SecretOnArgvError)
    // A userid is NOT a secret — it crosses the wire in the clear anyway.
    assert.doesNotThrow(() => assertNoSecretArgs(['userid=alice']))
  })

  it('the refusal reaches the executor boundary, not just the helper', async () => {
    const mock = okExecutor()
    await assert.rejects(
      () => runTargetcli(mock, ['/x', 'set', 'auth', `password=${SECRET}`]),
      SecretOnArgvError,
    )
    assert.equal(mock.calls.length, 0, 'nothing was executed')
  })
})

describe('withIscsiLock — the daemon-wide mutex', () => {
  it('serializes sequences, and one failure does not wedge the chain', async () => {
    const order: string[] = []
    const slow = withIscsiLock(async () => {
      order.push('a-start')
      await new Promise(r => setTimeout(r, 20))
      order.push('a-end')
    })
    const boom = withIscsiLock(async () => {
      order.push('b')
      throw new Error('b failed')
    })
    const after = withIscsiLock(async () => {
      order.push('c')
    })
    await slow
    await assert.rejects(() => boom)
    await after
    assert.deepEqual(order, ['a-start', 'a-end', 'b', 'c'])
  })
})

describe('createIscsiTarget — the exact sequence (GT-8, GT-31, GT-35)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-create-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A configfs root with the ACL auth files a create will write into. */
  async function seedAclDir(iqn: string, initiator: string) {
    const authDir = join(dir, 'iscsi', iqn, 'tpgt_1', 'acls', initiator, 'auth')
    await mkdir(authDir, { recursive: true })
    for (const f of ['userid', 'password', 'userid_mutual', 'password_mutual'])
      await writeFile(join(authDir, f), '')
  }

  /** A configfs root where the target came up with an auto-added portal. */
  async function seedAutoPortal(iqn: string, npName: string) {
    await mkdir(join(dir, 'iscsi', iqn, 'tpgt_1', 'np', npName), { recursive: true })
    await mkdir(join(dir, 'iscsi', iqn, 'tpgt_1', 'acls'), { recursive: true })
    await mkdir(join(dir, 'iscsi', iqn, 'tpgt_1', 'lun'), { recursive: true })
  }

  it('creates, REMOVES the auto-added 0.0.0.0 portal, closes the doors, then binds', async () => {
    await seedAutoPortal(IQN, '0.0.0.0:3260')
    const mock = okExecutor()
    const result = await createIscsiTarget(
      { executor: mock, configfsRoot: dir },
      {
        name: 'vmstore',
        portals: [{ address: '192.168.200.50', port: 3260 }],
        auth: 'none',
        acls: [],
      },
      IQN,
    )

    assert.deepEqual(targetcliCalls(mock), [
      `/iscsi create ${IQN}`,
      // GT-8: the wildcard portal is deleted, and only because a READ-BACK
      // found it — on a second target LIO skips creating it entirely.
      `/iscsi/${IQN}/tpg1/portals delete 0.0.0.0 3260`,
      `/iscsi/${IQN}/tpg1 set attribute authentication=0`,
      `/iscsi/${IQN}/tpg1 set attribute generate_node_acls=0`,
      `/iscsi/${IQN}/tpg1 set attribute demo_mode_discovery=0`,
      `/iscsi/${IQN}/tpg1 set attribute cache_dynamic_acls=0`,
      // Portals LAST: the listener only appears once the doors are shut.
      `/iscsi/${IQN}/tpg1/portals create 192.168.200.50 3260`,
      'saveconfig',
    ])
    assert.equal(result.removedDefaultPortal, true)
  })

  it('does NOT assume a wildcard portal exists — it verifies (GT-8)', async () => {
    // The second target on a node: LIO prints "Default portal not created,
    // TPGs within a target cannot share ip:port" and creates nothing.
    await seedAutoPortal(IQN, '192.168.200.50:3260')
    const mock = okExecutor()
    const result = await createIscsiTarget(
      { executor: mock, configfsRoot: dir },
      { name: 'vmstore', portals: [{ address: '192.168.200.50', port: 3260 }], auth: 'none', acls: [] },
      IQN,
    )
    assert.equal(result.removedDefaultPortal, false)
    assert.ok(
      !targetcliCalls(mock).some(c => c.includes('portals delete')),
      'nothing was deleted',
    )
  })

  it('an auto-added portal the request did not ask for is removed whatever its address', async () => {
    await seedAutoPortal(IQN, '10.9.9.9:3260')
    const mock = okExecutor()
    await createIscsiTarget(
      { executor: mock, configfsRoot: dir },
      { name: 'vmstore', portals: [{ address: '192.168.200.50', port: 3260 }], auth: 'none', acls: [] },
      IQN,
    )
    assert.ok(targetcliCalls(mock).includes(`/iscsi/${IQN}/tpg1/portals delete 10.9.9.9 3260`))
  })

  it('turns CHAP on at the TPG and writes the secrets to CONFIGFS, never argv', async () => {
    await seedAutoPortal(IQN, '0.0.0.0:3260')
    await seedAclDir(IQN, INITIATOR)
    const mock = okExecutor()
    await createIscsiTarget(
      { executor: mock, configfsRoot: dir },
      {
        name: 'vmstore',
        portals: [{ address: '192.168.200.50', port: 3260 }],
        auth: 'mutual-chap',
        acls: [{
          initiatorIqn: INITIATOR,
          chapUserid: 'alice',
          chapSecret: SECRET,
          mutualUserid: 'target1',
          mutualSecret: MUTUAL,
        }],
      },
      IQN,
    )

    const calls = targetcliCalls(mock)
    assert.ok(calls.includes(`/iscsi/${IQN}/tpg1 set attribute authentication=1`))
    assert.ok(calls.includes(`/iscsi/${IQN}/tpg1/acls create ${INITIATOR}`))

    // THE check: the secret appears NOWHERE in the full call log — not in an
    // argument, not in a command name, not in a path.
    const wholeLog = JSON.stringify(mock.calls)
    assert.ok(!wholeLog.includes(SECRET), 'the CHAP secret never reached argv')
    assert.ok(!wholeLog.includes(MUTUAL), 'the mutual CHAP secret never reached argv')
    assert.ok(!wholeLog.includes('password='), 'no password= token was ever built')

    // …and it DID land in configfs, where saveconfig will pick it up (GT-35).
    const authDir = join(dir, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR, 'auth')
    assert.equal(await readFile(join(authDir, 'userid'), 'utf8'), 'alice')
    assert.equal(await readFile(join(authDir, 'password'), 'utf8'), SECRET)
    assert.equal(await readFile(join(authDir, 'userid_mutual'), 'utf8'), 'target1')
    assert.equal(await readFile(join(authDir, 'password_mutual'), 'utf8'), MUTUAL)
  })

  it('a `none` auth create writes no credential file at all', async () => {
    await seedAutoPortal(IQN, '0.0.0.0:3260')
    await seedAclDir(IQN, INITIATOR)
    const mock = okExecutor()
    await createIscsiTarget(
      { executor: mock, configfsRoot: dir },
      {
        name: 'vmstore',
        portals: [{ address: '192.168.200.50', port: 3260 }],
        auth: 'none',
        acls: [{ initiatorIqn: INITIATOR }],
      },
      IQN,
    )
    const authDir = join(dir, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR, 'auth')
    assert.equal(await readFile(join(authDir, 'password'), 'utf8'), '')
  })

  it('saveconfig is the LAST command, always', async () => {
    await seedAutoPortal(IQN, '0.0.0.0:3260')
    const mock = okExecutor()
    await createIscsiTarget(
      { executor: mock, configfsRoot: dir },
      { name: 'vmstore', portals: [{ address: 'fd00:6774:0:1::1', port: 3260 }], auth: 'none', acls: [] },
      IQN,
    )
    const calls = targetcliCalls(mock)
    assert.equal(calls.at(-1), 'saveconfig')
    // An IPv6 portal is created with the BARE address; LIO brackets it itself
    // in configfs and in saveconfig.json (GT-12/GT-25).
    assert.ok(calls.includes(`/iscsi/${IQN}/tpg1/portals create fd00:6774:0:1::1 3260`))
  })
})

describe('the ACL auth configfs path helper', () => {
  it('builds the four documented value paths', () => {
    assert.equal(
      aclAuthPath('/sys/kernel/config/target', IQN, 1, INITIATOR, 'password'),
      `/sys/kernel/config/target/iscsi/${IQN}/tpgt_1/acls/${INITIATOR}/auth/password`,
    )
  })

  it('refuses to splice anything that is not an iSCSI name into a path', () => {
    assert.throws(() => aclAuthPath('/root', '../../etc', 1, INITIATOR, 'password'), /not an iSCSI name/)
    assert.throws(() => aclAuthPath('/root', IQN, 1, '../../etc/shadow', 'password'), /not an iSCSI name/)
  })

  it('refuses a file name outside the closed list', () => {
    // @ts-expect-error — deliberately off-contract, which is the point
    assert.throws(() => aclAuthPath('/root', IQN, 1, INITIATOR, 'authenticate_target'), /Refusing/)
  })
})

describe('applyAclCredentials — value / null / omitted = set / clear / keep', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-auth-'))
    const authDir = join(dir, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR, 'auth')
    await mkdir(authDir, { recursive: true })
    for (const f of ['userid', 'password', 'userid_mutual', 'password_mutual'])
      await writeFile(join(authDir, f), 'previous')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const authDir = () => join(dir, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR, 'auth')

  it('an OMITTED field is not written at all — the stored value stands', async () => {
    const written = await applyAclCredentials(dir, IQN, 1, { initiatorIqn: INITIATOR })
    assert.deepEqual(written, [])
    assert.equal(await readFile(join(authDir(), 'password'), 'utf8'), 'previous')
  })

  it('a VALUE is written verbatim', async () => {
    await applyAclCredentials(dir, IQN, 1, { initiatorIqn: INITIATOR, chapSecret: SECRET })
    assert.equal(await readFile(join(authDir(), 'password'), 'utf8'), SECRET)
    assert.equal(await readFile(join(authDir(), 'userid'), 'utf8'), 'previous')
  })

  it('NULL writes LIO\'s clear sentinel, not an empty string', async () => {
    // A zero-length write would store an EMPTY credential and mark it as SET;
    // the kernel's auth store only treats the literal `NULL` as a clear.
    await applyAclCredentials(dir, IQN, 1, { initiatorIqn: INITIATOR, chapSecret: null, chapUserid: null })
    assert.equal(await readFile(join(authDir(), 'password'), 'utf8'), ACL_AUTH_NULL)
    assert.equal(await readFile(join(authDir(), 'userid'), 'utf8'), ACL_AUTH_NULL)
  })

  it('a write failure names the FILE and never the value', async () => {
    await rm(dir, { recursive: true, force: true })
    await assert.rejects(
      () => applyAclCredentials(dir, IQN, 1, { initiatorIqn: INITIATOR, chapSecret: SECRET }),
      (err: unknown) => {
        const msg = (err as Error).message
        assert.match(msg, /credential file/)
        assert.ok(!msg.includes(SECRET), 'the secret is not in the error message')
        return true
      },
    )
  })
})

describe('the backstore attribute set ANAS puts on every LUN (GT-18, GT-26, GT-27, GT-30)', () => {
  it('block_size comes FIRST, because it stops working once the LUN is mapped', () => {
    const tokens = attributeTokens(defaultBackstoreAttributes('fileio', { blockSize: 4096 }))
    assert.equal(tokens[0], 'block_size=4096')
  })

  it('omitting a block size emits no block_size token at all', () => {
    const tokens = attributeTokens(defaultBackstoreAttributes('block'))
    assert.ok(!tokens.some(tk => tk.startsWith('block_size=')))
  })

  it('turns thin reclaim ON and write-back OFF — both are FLIPS of LIO\'s defaults', () => {
    assert.deepEqual(attributeTokens(defaultBackstoreAttributes('fileio')), [
      'emulate_tpu=1',
      'emulate_tpws=1',
      `max_unmap_lba_count=${ISCSI_MAX_UNMAP_LBA_COUNT.fileio}`,
      'emulate_write_cache=0',
    ])
  })

  it('raises max_unmap_lba_count where the default breaks a whole-device discard', () => {
    // fileio ships 8192 (4 MiB), which makes blkdiscard fail outright (GT-30).
    assert.ok(ISCSI_MAX_UNMAP_LBA_COUNT.fileio > 8192)
    // block ships higher already; ANAS sets it explicitly rather than implicitly
    // so the replayed set is the same shape for both kinds.
    assert.equal(ISCSI_MAX_UNMAP_LBA_COUNT.block, 524288)
  })

  it('replayAttributes reads the LIVE values back, it does not reconstruct defaults', () => {
    const attrs = replayAttributes(
      { attributes: { emulateTpu: true, emulateTpws: false, blockSize: 4096, writeBack: true, maxUnmapLbaCount: 999 } },
      'fileio',
    )
    assert.deepEqual(attributeTokens(attrs), [
      'block_size=4096',
      'emulate_tpu=1',
      'emulate_tpws=0',
      'max_unmap_lba_count=999',
      'emulate_write_cache=1',
    ])
  })

  it('replayAttributes lets an explicit writeBack override the stored one', () => {
    const attrs = replayAttributes({ attributes: { writeBack: true } }, 'fileio', { writeBack: false })
    assert.equal(attrs.writeBack, false)
  })
})

describe('addIscsiLun — wwn at create, attributes before the map, then the grant', () => {
  it('a zvol LUN: block backstore with wwn=, attributes, map, saveconfig', async () => {
    const mock = okExecutor()
    const serial = '9bc6e907-6015-4267-be4f-5a0617cb3d71'
    const result = await addIscsiLun(
      { executor: mock },
      target(),
      { name: 'vmdisk1', kind: 'zvol', backing: 'tank/vol1' },
      { path: '/dev/zvol/tank/vol1', plugin: 'block', dataset: 'tank/vol1' },
      null,
      serial,
    )

    assert.deepEqual(targetcliCalls(mock), [
      // `wwn=` is a CREATE parameter — there is no `set wwn` (GT-16).
      `/backstores/block create name=vmdisk1 dev=/dev/zvol/tank/vol1 wwn=${serial}`,
      '/backstores/block/vmdisk1 set attribute emulate_tpu=1',
      '/backstores/block/vmdisk1 set attribute emulate_tpws=1',
      `/backstores/block/vmdisk1 set attribute max_unmap_lba_count=${ISCSI_MAX_UNMAP_LBA_COUNT.block}`,
      '/backstores/block/vmdisk1 set attribute emulate_write_cache=0',
      // …and only THEN is it mapped.
      `/iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/vmdisk1 lun=0`,
      'saveconfig',
    ])
    assert.equal(result.serial, serial)
    assert.equal(result.index, 0)
    // The backstore points at the STABLE path — a zdN name moves across a
    // reboot and is never stored or matched (GT-48).
    assert.ok(!JSON.stringify(mock.calls).includes('/dev/zd1'))
  })

  it('an image LUN: fileio backstore with size, write_back=false and wwn=', async () => {
    const mock = okExecutor()
    const serial = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await addIscsiLun(
      { executor: mock },
      target(),
      { name: 'vmdisk2', kind: 'file', backing: 'tank/images', size: 1073741824 },
      { path: '/tank/images/vmdisk2.raw', plugin: 'fileio', dataset: 'tank/images' },
      1073741824,
      serial,
    )
    assert.deepEqual(targetcliCalls(mock), [
      `/backstores/fileio create name=vmdisk2 file_or_dev=/tank/images/vmdisk2.raw size=1073741824 write_back=false wwn=${serial}`,
      '/backstores/fileio/vmdisk2 set attribute emulate_tpu=1',
      '/backstores/fileio/vmdisk2 set attribute emulate_tpws=1',
      `/backstores/fileio/vmdisk2 set attribute max_unmap_lba_count=${ISCSI_MAX_UNMAP_LBA_COUNT.fileio}`,
      '/backstores/fileio/vmdisk2 set attribute emulate_write_cache=0',
      `/iscsi/${IQN}/tpg1/luns create storage_object=/backstores/fileio/vmdisk2 lun=0`,
      'saveconfig',
    ])
  })

  it('the chosen block size is set BEFORE the map (GT-27)', async () => {
    const mock = okExecutor()
    await addIscsiLun(
      { executor: mock },
      target(),
      { name: 'vmdisk1', kind: 'zvol', backing: 'tank/vol1', blockSize: 4096 },
      { path: '/dev/zvol/tank/vol1', plugin: 'block' },
      null,
      newSerial(),
    )
    const calls = targetcliCalls(mock)
    const blockSizeAt = calls.findIndex(c => c.includes('set attribute block_size=4096'))
    const mapAt = calls.findIndex(c => c.includes('/luns create'))
    assert.ok(blockSizeAt >= 0, 'block_size was set')
    assert.ok(blockSizeAt < mapAt, 'and it was set before the LUN was mapped')
  })

  it('grants the new LUN to every ACL that does not already map it', async () => {
    const mock = okExecutor()
    await addIscsiLun(
      { executor: mock },
      target({
        acls: [
          { initiatorIqn: INITIATOR, chapUserid: null, chapCredentialsSet: false, mutualUserid: null, mutualCredentialsSet: false, mappedLuns: [] },
          { initiatorIqn: 'iqn.1993-08.org.debian:01:already', chapUserid: null, chapCredentialsSet: false, mutualUserid: null, mutualCredentialsSet: false, mappedLuns: [0] },
        ],
      }),
      { name: 'vmdisk1', kind: 'zvol', backing: 'tank/vol1' },
      { path: '/dev/zvol/tank/vol1', plugin: 'block' },
      null,
      newSerial(),
    )
    const calls = targetcliCalls(mock)
    // The mapped-LUN index is deliberately the SAME number as the TPG LUN.
    assert.ok(calls.includes(`/iscsi/${IQN}/tpg1/acls/${INITIATOR} create 0 0`))
    // …and the ACL that already maps LUN 0 is left alone: targetcli's
    // auto_add_mapped_luns preference lives in a pickle in $HOME (GT-7), so
    // ANAS verifies rather than assuming either way.
    assert.ok(!calls.includes(`/iscsi/${IQN}/tpg1/acls/iqn.1993-08.org.debian:01:already create 0 0`))
  })

  it('a LUN targetcli already auto-mapped into an ACL is not granted twice (live-proof wave 2)', async () => {
    // GT-7: targetcli's `auto_add_mapped_luns` preference is TRUE by default, so
    // `/…/luns create` maps the brand-new LUN into every existing ACL by itself.
    // The ACL snapshot addIscsiLun is handed was taken BEFORE that, so it says
    // "not mapped" — and the explicit grant then dies with `This MappedLUN
    // already exists in configFS`, failing a job whose work was complete and
    // leaving the live tree unsaved. Live-proven on the stunt node: adding the
    // first LUN to a target with two ACLs failed exactly this way.
    const root = await mkdtemp(join(tmpdir(), 'anas-iscsi-configfs-'))
    try {
      await mkdir(join(root, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR, 'lun_0'), { recursive: true })
      const mock = okExecutor()
      await addIscsiLun(
        { executor: mock, configfsRoot: root },
        target({
          acls: [
            // Stale: configfs already has lun_0 under this ACL.
            { initiatorIqn: INITIATOR, chapUserid: null, chapCredentialsSet: false, mutualUserid: null, mutualCredentialsSet: false, mappedLuns: [] },
          ],
        }),
        { name: 'vmdisk1', kind: 'zvol', backing: 'tank/vol1' },
        { path: '/dev/zvol/tank/vol1', plugin: 'block' },
        null,
        newSerial(),
      )
      const calls = targetcliCalls(mock)
      assert.ok(!calls.includes(`/iscsi/${IQN}/tpg1/acls/${INITIATOR} create 0 0`), 'no duplicate mapped-LUN create')
      assert.equal(calls.at(-1), 'saveconfig', 'and the add still reaches saveconfig')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an ACL configfs does NOT yet map still gets the explicit grant (live-proof wave 2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-iscsi-configfs-'))
    try {
      await mkdir(join(root, 'iscsi', IQN, 'tpgt_1', 'acls', INITIATOR), { recursive: true })
      const mock = okExecutor()
      await addIscsiLun(
        { executor: mock, configfsRoot: root },
        target({
          acls: [
            { initiatorIqn: INITIATOR, chapUserid: null, chapCredentialsSet: false, mutualUserid: null, mutualCredentialsSet: false, mappedLuns: [] },
          ],
        }),
        { name: 'vmdisk1', kind: 'zvol', backing: 'tank/vol1' },
        { path: '/dev/zvol/tank/vol1', plugin: 'block' },
        null,
        newSerial(),
      )
      assert.ok(targetcliCalls(mock).includes(`/iscsi/${IQN}/tpg1/acls/${INITIATOR} create 0 0`))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes the lowest free LUN index', () => {
    assert.equal(nextLunIndex(target()), 0)
    assert.equal(nextLunIndex(target({ luns: [{ index: 0 }, { index: 2 }] as never })), 1)
  })
})

describe('resizeFileLun — the replay contract, in full (GT-17, GT-18, GT-29)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-resize-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('unmaps, deletes, grows, recreates with the SAME wwn and attributes, re-maps at the SAME index', async () => {
    const image = join(dir, 'vmdisk2.raw')
    await createSparseImage(image, 536870912)
    const mock = okExecutor()
    const serial = '9bc6e907-6015-4267-be4f-5a0617cb3d71'

    await resizeFileLun(
      { executor: mock },
      target({
        luns: [{ index: 3 }] as never,
        acls: [{ initiatorIqn: INITIATOR, chapUserid: null, chapCredentialsSet: false, mutualUserid: null, mutualCredentialsSet: false, mappedLuns: [3] }],
      }),
      {
        index: 3,
        name: 'vmdisk2',
        backingPath: image,
        serial,
        attributes: { emulateTpu: true, emulateTpws: true, maxUnmapLbaCount: 262144, writeBack: false, blockSize: 4096 },
      },
      1073741824,
    )

    assert.deepEqual(targetcliCalls(mock), [
      `/iscsi/${IQN}/tpg1/luns delete lun3`,
      '/backstores/fileio delete vmdisk2',
      // Recreated with the ORIGINAL serial: without it the initiator would see
      // a different disk, and every PVE volid built on it would break (GT-45).
      `/backstores/fileio create name=vmdisk2 file_or_dev=${image} size=1073741824 write_back=false wwn=${serial}`,
      // Every attribute replayed: LIO brings a recreated backstore back at
      // stock defaults, so anything not replayed is silently lost (GT-18).
      '/backstores/fileio/vmdisk2 set attribute block_size=4096',
      '/backstores/fileio/vmdisk2 set attribute emulate_tpu=1',
      '/backstores/fileio/vmdisk2 set attribute emulate_tpws=1',
      '/backstores/fileio/vmdisk2 set attribute max_unmap_lba_count=262144',
      '/backstores/fileio/vmdisk2 set attribute emulate_write_cache=0',
      // Re-mapped at the SAME index, and re-granted to the ACL.
      `/iscsi/${IQN}/tpg1/luns create storage_object=/backstores/fileio/vmdisk2 lun=3`,
      `/iscsi/${IQN}/tpg1/acls/${INITIATOR} create 3 3`,
    ])
    // The FILE was grown before the recreate: `size=` is ignored when the file
    // already exists, so the file's length IS the LUN's size (GT-29).
    assert.equal((await stat(image)).size, 1073741824)
  })

  it('a LUN whose serial could not be read is recreated WITHOUT wwn=, not with a made-up one', async () => {
    const image = join(dir, 'vmdisk3.raw')
    await createSparseImage(image, 1024)
    const mock = okExecutor()
    await resizeFileLun(
      { executor: mock },
      target(),
      { index: 0, name: 'vmdisk3', backingPath: image, serial: null, attributes: { emulateTpu: true, emulateTpws: true, maxUnmapLbaCount: 262144, writeBack: false } },
      2048,
    )
    const create = targetcliCalls(mock).find(c => c.startsWith('/backstores/fileio create'))
    assert.ok(create && !create.includes('wwn='), create)
  })

  it('resizeFileLun does NOT save — the route saves once for the whole update', async () => {
    const image = join(dir, 'vmdisk4.raw')
    await createSparseImage(image, 1024)
    const mock = okExecutor()
    await resizeFileLun(
      { executor: mock },
      target(),
      { index: 0, name: 'vmdisk4', backingPath: image, serial: 'x', attributes: { emulateTpu: true, emulateTpws: true, maxUnmapLbaCount: 1, writeBack: false } },
      2048,
    )
    assert.ok(!targetcliCalls(mock).includes('saveconfig'))
  })
})

describe('the image file itself', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-img-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is created sparse at the requested length', async () => {
    const p = join(dir, 'a.raw')
    await createSparseImage(p, 1073741824)
    const st = await stat(p)
    assert.equal(st.size, 1073741824)
    // Sparse: the allocated blocks are a rounding error next to the length.
    assert.ok(st.blocks * 512 < 1024 * 1024, `allocated ${st.blocks * 512} bytes`)
  })

  it('REFUSES to overwrite an existing file', async () => {
    const p = join(dir, 'b.raw')
    await writeFile(p, 'real data')
    await assert.rejects(() => createSparseImage(p, 4096), /already exists/)
    assert.equal(await readFile(p, 'utf8'), 'real data')
  })

  it('names the image after the LUN, under the chosen directory', () => {
    assert.equal(imageFilePath('/tank/images', 'vmdisk2'), '/tank/images/vmdisk2.raw')
  })

  it('grows in place without touching what is already there', async () => {
    const p = join(dir, 'c.raw')
    await writeFile(p, 'header')
    await growImageFile(p, 4096)
    assert.equal((await stat(p)).size, 4096)
    assert.equal((await readFile(p, 'utf8')).slice(0, 6), 'header')
  })
})

describe('zvol grow, LUN delete, target state and target delete', () => {
  it('a zvol grow is a plain `zfs set volsize=` and NOTHING on the LIO side (GT-28)', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: '', exitCode: 0 } })
    await growZvolLun({ executor: mock }, 'tank/vol1', 2147483648)
    assert.deepEqual(mock.calls, [
      { command: '/usr/sbin/zfs', args: ['set', 'volsize=2147483648', 'tank/vol1'] },
    ])
  })

  it('a zvol grow that ZFS refuses surfaces what ZFS said', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: 'cannot set property for \'tank/vol1\': out of space\n', exitCode: 1 } })
    await assert.rejects(() => growZvolLun({ executor: mock }, 'tank/vol1', 1), /out of space/)
  })

  it('enable / disable is one targetcli command plus the save', async () => {
    const mock = okExecutor()
    await setIscsiTargetState({ executor: mock }, target(), 'disable')
    assert.deepEqual(targetcliCalls(mock), [`/iscsi/${IQN}/tpg1 disable`, 'saveconfig'])
  })

  it('a write-cache change is one attribute set, no recreate', async () => {
    const mock = okExecutor()
    await setLunWriteBack({ executor: mock }, 'fileio', 'vmdisk2', true)
    assert.deepEqual(targetcliCalls(mock), ['/backstores/fileio/vmdisk2 set attribute emulate_write_cache=1'])
  })

  it('deleting a LUN unmaps and deletes the backstore, and KEEPS the backing object', async () => {
    const mock = okExecutor()
    const result = await deleteIscsiLun(
      { executor: mock },
      target(),
      { index: 1, name: 'vmdisk1', plugin: 'block', kind: 'zvol', backingPath: '/dev/zvol/tank/vol1', dataset: 'tank/vol1' },
      false,
    )
    assert.deepEqual(targetcliCalls(mock), [
      `/iscsi/${IQN}/tpg1/luns delete lun1`,
      '/backstores/block delete vmdisk1',
      'saveconfig',
    ])
    assert.equal(result.backingDestroyed, null)
    assert.ok(!mock.calls.some(c => c.command === '/usr/sbin/zfs'))
  })

  it('destroyBacking=true also destroys the zvol — a separate, deliberate step', async () => {
    const mock = okExecutor()
    mock.addFixture({ command: '/usr/sbin/zfs', result: { stdout: '', stderr: '', exitCode: 0 } })
    const result = await deleteIscsiLun(
      { executor: mock },
      target(),
      { index: 1, name: 'vmdisk1', plugin: 'block', kind: 'zvol', backingPath: '/dev/zvol/tank/vol1', dataset: 'tank/vol1' },
      true,
    )
    assert.deepEqual(
      mock.calls.filter(c => c.command === '/usr/sbin/zfs'),
      [{ command: '/usr/sbin/zfs', args: ['destroy', 'tank/vol1'] }],
    )
    assert.equal(result.backingDestroyed, 'tank/vol1')
  })

  it('destroyBacking=true on an image LUN removes the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-del-'))
    try {
      const image = join(dir, 'vmdisk2.raw')
      await createSparseImage(image, 4096)
      const mock = okExecutor()
      const result = await deleteIscsiLun(
        { executor: mock },
        target(),
        { index: 0, name: 'vmdisk2', plugin: 'fileio', kind: 'file', backingPath: image },
        true,
      )
      assert.equal(result.backingDestroyed, image)
      await assert.rejects(() => stat(image))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deleting a target removes the target and saves — an EMPTY target has no backstores to clean up', async () => {
    // The route only calls this for a target with zero LUNs and no live
    // sessions (it refuses both), so the sequence is exactly the delete and
    // the save. A zero-LUN target has no backstores of its own: backstore
    // names are node-global, a LUN delete removes its backstore, and a
    // backstore shared with another target was never this target's to remove.
    const mock = okExecutor()
    const result = await deleteIscsiTarget({ executor: mock }, target())

    assert.deepEqual(targetcliCalls(mock), [
      `/iscsi delete ${IQN}`,
      'saveconfig',
    ])
    assert.deepEqual(result, { iqn: IQN })
  })
})

describe('resolveZvolBacking — PVE territory is never a candidate', () => {
  it('accepts a dataset name and a device path alike', () => {
    for (const backing of ['tank/vol1', '/dev/zvol/tank/vol1']) {
      const r = resolveZvolBacking(backing, emptyCtx())
      assert.ok('ok' in r, backing)
      assert.equal(r.ok.path, '/dev/zvol/tank/vol1')
      assert.equal(r.ok.plugin, 'block')
      assert.equal(r.ok.dataset, 'tank/vol1')
    }
  })

  it('refuses a PVE guest volume by name, whatever pool it is on', () => {
    for (const name of ['vm-101-disk-0', 'base-9000-disk-0', 'subvol-120-disk-0']) {
      const r = resolveZvolBacking(`tank/${name}`, emptyCtx())
      assert.ok('refusal' in r, name)
      assert.equal(r.refusal.reason, 'pve-guest-volume')
    }
  })

  it('refuses a zvol on a PVE-managed pool, naming the storage', () => {
    const ctx = emptyCtx({
      inputs: {
        pveStorages: new Map([['rpool', [{ storage: 'local-zfs', type: 'zfspool', pool: 'rpool' }]]]),
        zfsMountpoints: [],
      },
    } as never)
    const r = resolveZvolBacking('rpool/data/vol1', ctx)
    assert.ok('refusal' in r)
    assert.equal(r.refusal.reason, 'pve-managed-pool')
    assert.match(r.refusal.message, /local-zfs/)
  })

  it('refuses anything that is not a zvol path at all', () => {
    const r = resolveZvolBacking('/dev/sdb', emptyCtx())
    assert.ok('refusal' in r)
    assert.equal(r.refusal.reason, 'not-a-zvol')
  })

  it('the two path helpers round-trip', () => {
    assert.equal(zvolDevicePath('tank/vol1'), '/dev/zvol/tank/vol1')
    assert.equal(zvolDevicePath('/dev/zvol/tank/vol1'), '/dev/zvol/tank/vol1')
    assert.equal(zvolDataset('/dev/zvol/tank/vol1'), 'tank/vol1')
  })
})

/** A node of the `lsblk -J` tree, as far as the unmounted variant needs. */
interface LsblkNode {
  type?: string
  mountpoint?: string | null
  children?: LsblkNode[]
}

/** Clear every LVM child's MOUNTPOINT — the unmounted half of a pool. */
function clearLvmMountpoints(nodes: LsblkNode[]): void {
  for (const n of nodes) {
    if (n.type === 'lvm')
      n.mountpoint = null
    if (n.children)
      clearLvmMountpoints(n.children)
  }
}

/**
 * A MockExecutor on which `readAhrPools` reports the fixture pool `ahr0`
 * (arrays r1+r2, VG `ahr0`, LV `ahr0-vol`). `mountpoint` sets the findmnt half:
 * the fixture mount when given, NO mount when omitted — the pool then reports
 * `mounted: false` while its `mountpoint` field still carries the LV device
 * path, the exact shape the name branch must not mistake for a directory.
 */
function ahrExecutor(mountpoint?: string): MockExecutor {
  const mock = new MockExecutor()
  const lsblk: { blockdevices: LsblkNode[] } = JSON.parse(mockFixtures.ahrLsblk().stdout)
  if (mountpoint === undefined)
    clearLvmMountpoints(lsblk.blockdevices)
  const filesystems = mountpoint === undefined
    ? []
    : [{ target: mountpoint, source: '/dev/mapper/ahr0-ahr0--vol', fstype: 'btrfs', options: 'rw,relatime,subvolid=5,subvol=/' }]
  mock.addFixture({ command: '/usr/bin/cat', args: MDSTAT_CAT_ARGS, result: mockFixtures.ahrMdstat() })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md127'), result: mockFixtures.ahrMdadmExportR1() })
  mock.addFixture({ command: '/usr/sbin/mdadm', args: mdadmDetailExportArgs('/dev/md126'), result: mockFixtures.ahrMdadmExportR2() })
  mock.addFixture({ command: '/usr/bin/lsblk', args: AHR_LSBLK_ARGS, result: { stdout: JSON.stringify(lsblk), stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/ls', args: ['-la', '/dev/disk/by-id/'], result: mockFixtures.diskByIdListing() })
  mock.addFixture({ command: '/usr/sbin/vgs', args: VGS_ARGS, result: mockFixtures.ahrVgs() })
  mock.addFixture({ command: '/usr/sbin/lvs', args: LVS_ARGS, result: mockFixtures.ahrLvs() })
  mock.addFixture({ command: '/usr/sbin/pvs', args: PVS_ARGS, result: mockFixtures.ahrPvs() })
  mock.addFixture({ command: '/usr/bin/findmnt', args: AHR_FINDMNT_ARGS, result: { stdout: JSON.stringify({ filesystems }), stderr: '', exitCode: 0 } })
  return mock
}

describe('resolveFileBackingDir — an AHR pool name is a backing, like a dataset name', () => {
  it('resolves a MOUNTED AHR pool name onto its mountpoint directory', async () => {
    const r = await resolveFileBackingDir(ahrExecutor('/mnt/anas-ahr/ahr0'), 'ahr0', emptyCtx())
    assert.ok('ok' in r)
    assert.equal(r.ok.dir, '/mnt/anas-ahr/ahr0')
    assert.equal(r.ok.pool, 'ahr0')
    assert.equal(r.ok.dataset, undefined)
    assert.deepEqual(r.ok.ahr, { name: 'ahr0', mountpoint: '/mnt/anas-ahr/ahr0' })
  })

  it('refuses an UNMOUNTED AHR pool by name — naming it, saying to mount it', async () => {
    const r = await resolveFileBackingDir(ahrExecutor(), 'ahr0', emptyCtx())
    assert.ok('refusal' in r)
    assert.equal(r.refusal.reason, 'ahr-pool-unmounted')
    assert.match(r.refusal.message, /'ahr0' is an AHR pool, but it is not mounted — mount it first, then place the image/)
  })

  it('still resolves a ZFS dataset name to its mountpoint — without ever reading the AHR topology', async () => {
    const mock = ahrExecutor('/mnt/anas-ahr/ahr0')
    const ctx = emptyCtx({
      inputs: {
        pveStorages: new Map(),
        zfsMountpoints: [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }],
      },
    } as never)
    const r = await resolveFileBackingDir(mock, 'tank/images', ctx)
    assert.ok('ok' in r)
    assert.equal(r.ok.dir, '/tank/images')
    assert.equal(r.ok.dataset, 'tank/images')
    assert.equal(r.ok.pool, 'tank')
    assert.equal(r.ok.ahr, undefined)
    assert.equal(mock.calls.length, 0)
  })

  it('still refuses a name that is neither a dataset nor a pool, with the existing message', async () => {
    const r = await resolveFileBackingDir(ahrExecutor('/mnt/anas-ahr/ahr0'), 'nosuch', emptyCtx())
    assert.ok('refusal' in r)
    assert.equal(r.refusal.reason, 'backing-not-found')
    assert.match(r.refusal.message, /'nosuch' is neither a mounted ZFS dataset nor an AHR pool on this node/)
  })
})

describe('assertSaveable — never saveconfig over a degraded restore (GT-22)', () => {
  it('refuses while a persisted LUN has no live counterpart, and NAMES the hole', () => {
    const ctx = emptyCtx({
      persisted: {
        fabricModules: [],
        storageObjects: [{ name: 'gtiscsi_vol1', plugin: 'block', dev: '/dev/zvol/gtiscsi/vol1', wwn: 'abc', size: null, writeBack: null, readOnly: null, aio: null, attributes: {} }],
        targets: [{
          iqn: IQN,
          fabric: 'iscsi',
          tpgs: [{
            tag: 1,
            enable: true,
            authentication: false,
            generateNodeAcls: false,
            demoModeDiscovery: false,
            tpgCredentialsSet: false,
            portals: [],
            luns: [{ index: 0, storageObject: '/backstores/block/gtiscsi_vol1', backstoreName: 'gtiscsi_vol1', plugin: 'block' }],
            acls: [],
          }],
        }],
      },
    } as never)
    const targets = [target({
      luns: [{ index: 0, name: 'gtiscsi_vol1', kind: 'zvol', plugin: 'block', backingPath: '/dev/zvol/gtiscsi/vol1', size: null, serial: 'abc', attributes: {}, connectedInitiators: [], present: false, backingExists: false }] as never,
    })]
    const refusal = assertSaveable(ctx, targets)
    assert.ok(refusal)
    assert.equal(refusal!.reason, 'degraded-restore')
    assert.match(refusal!.message, /gtiscsi_vol1/)
    assert.match(refusal!.message, /saveconfig/)
    // The refusal has to say what to DO, not merely that it refused.
    assert.match(refusal!.message, /rtslib-fb-targetctl/)
  })

  it('a healthy tree is saveable', () => {
    assert.equal(assertSaveable(emptyCtx(), [target()]), null)
  })
})

describe('claimsFromTargets — the one cross-feature seam (iscsi.6)', () => {
  it('lists every mapped backing object with a sentence ready to append to a refusal', () => {
    const claims = claimsFromTargets([target({
      luns: [
        { index: 0, name: 'vmdisk1', kind: 'zvol', plugin: 'block', backingPath: '/dev/zvol/tank/vol1', size: 1, serial: 's', attributes: {}, connectedInitiators: [INITIATOR], present: true, backingExists: true, pool: 'tank', dataset: 'tank/vol1' },
        { index: 1, name: 'vmdisk2', kind: 'file', plugin: 'fileio', backingPath: '/tank/images/vmdisk2.raw', size: 1, serial: 's2', attributes: {}, connectedInitiators: [], present: true, backingExists: true, pool: 'tank', dataset: 'tank/images' },
      ] as never,
    })])
    assert.equal(claims.length, 2)
    assert.equal(claims[0].backingPath, '/dev/zvol/tank/vol1')
    assert.equal(claims[0].dataset, 'tank/vol1')
    assert.match(claims[0].detail, /held by iSCSI LUN 0 '.+' of target/)
    assert.match(claims[0].detail, /1 live session/)
    assert.ok(!/session/.test(claims[1].detail))
  })

  it('skips a LUN with no backing path — there is nothing to hold', () => {
    assert.deepEqual(claimsFromTargets([target({ luns: [{ index: 0, name: 'x', backingPath: '' }] as never })]), [])
  })
})

describe('the generated IQN', () => {
  const saved = process.env.ANAS_NODENAME
  afterEach(() => {
    if (saved === undefined)
      delete process.env.ANAS_NODENAME
    else
      process.env.ANAS_NODENAME = saved
  })

  it('carries the node\'s whole name, short or qualified', () => {
    process.env.ANAS_NODENAME = 'nas'
    assert.equal(iscsiNodeName(), 'nas')
    assert.match(newTargetIqn('vmstore'), /^iqn\.\d{4}-\d{2}\.nas\.anas:vmstore$/)

    process.env.ANAS_NODENAME = 'NAS.Example.COM'
    assert.match(newTargetIqn('vmstore'), /^iqn\.\d{4}-\d{2}\.com\.example\.nas\.anas:vmstore$/)
  })
})
