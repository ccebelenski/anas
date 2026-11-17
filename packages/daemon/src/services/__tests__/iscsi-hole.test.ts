/**
 * own.4 (c): ONE verdict per hole — what Repair can do with it, and if nothing,
 * why — decided by `holeRepairVerdict` from facts the caller gathered.
 *
 * Every case here is built from the read layer itself (`contextOf` →
 * `buildIscsiTargets` → `restoreHoles`), so the hole a test hands the owner is
 * the hole the daemon would hand it. I/O facts are handed in as the read
 * gathers them: a mark read, a running job, a retained job record, one stat of
 * a block backing. `io === null` is "the caller gathered none" and must never
 * turn into `ready`.
 */
import type { IscsiMissingLun, IscsiTargetDetail, RestoreMark } from '@anas/shared'
import type { ConfigfsBackstore, ConfigfsLun } from '../iscsi-configfs.js'
import type { HoleIoFacts } from '../iscsi-hole.js'
import type { IscsiReadContext } from '../iscsi.js'
import type { RestoreMarkRead } from '../restore-mark.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { restoreHoles } from '../iscsi-health.js'
import { holeKey, holeRepairVerdict } from '../iscsi-hole.js'
import { buildIscsiTargets } from '../iscsi.js'
import { ATTR_NOT_INSTALLED, jobRecordOnly } from '../restore-mark.js'
import { contextOf, holeIoFor } from './lio-model.js'

const IQN = 'iqn.2026-08.nas.anas:vmstore'
const OTHER_IQN = 'iqn.2026-08.nas.anas:other'
const BLOCK_PATH = '/dev/zvol/tank/v1'
const FILE_PATH = '/tank/images/v1.raw'

/** A live block device stat, as the served-device read takes it. */
const ST = { type: 'block' as const, rdevMajor: 230, rdevMinor: 16, dev: '0', ino: '0', size: 0 }

const MARK: RestoreMark = {
  v: 1,
  repo: 'pbs-main',
  snapshot: 'host/gtimgboth/2026-08-25T19:28:38Z',
  archive: 'v1.img',
  started: '2026-11-14T10:00:00.000Z',
  state: 'writing',
}
const UNVERIFIED: RestoreMark = { ...MARK, state: 'unverified', reason: 'size could not be re-read' }

const MARK_DETAIL = 'a whole-image restore of v1.img from host/gtimgboth/2026-08-25T19:28:38Z (repository pbs-main) started 2026-11-14T10:00:00.000Z'

interface WorldOptions {
  plugin?: 'block' | 'fileio'
  name?: string
  dev?: string
  serial?: string
  /** The saved fileio size; null = the record holds none. */
  savedSize?: number | null
  /** The file's real size, as the backing probe measured it. */
  actualSize?: number | null
  /** `backingExists`: true, false, or null (the check itself failed). */
  exists?: boolean | null
  /** Is a live backstore of the same name and plugin there? Default true. */
  liveBackstore?: boolean
  /** The kernel mount table, when a case needs a wrong-mount signal. */
  mounts?: Map<string, { target: string, source: string, fstype: string, options: string }>
}

async function world(o: WorldOptions = {}): Promise<{ ctx: IscsiReadContext, target: IscsiTargetDetail, hole: IscsiMissingLun }> {
  const plugin = o.plugin ?? 'block'
  const name = o.name ?? 'v1'
  const dev = o.dev ?? (plugin === 'block' ? BLOCK_PATH : FILE_PATH)
  const bs = { name, plugin, dev, wwn: o.serial ?? 'w-1' }
  const live = o.liveBackstore === false ? { backstores: [], luns: [] } : { backstores: [bs], luns: [] }
  const saved = { backstores: [bs], luns: [{ iqn: IQN, tag: 1, index: 0, backstore: name, plugin }] }
  const ctx = contextOf(live, saved, { iqn: IQN, tag: 1, backstores: [], luns: [] })
  if (plugin === 'fileio') {
    ;(ctx.persisted as unknown as { storageObjects: { size: number | null }[] }).storageObjects[0].size = o.savedSize === undefined ? 1048576 : o.savedSize
    ctx.inputs.zfsMountpoints = [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }]
  }
  ctx.backing.set(dev, { exists: o.exists === undefined ? true : o.exists, size: o.actualSize === undefined ? null : o.actualSize })
  if (o.mounts)
    ctx.mounts = o.mounts
  const targets = await buildIscsiTargets(ctx)
  const found = restoreHoles(ctx, targets)
  assert.equal(found.length, 1, 'the fixture holds exactly one hole')
  return { ctx, target: targets[0], hole: found[0].hole }
}

/** Block-hole I/O facts: a stat of a device nothing serves, no mark, no job. */
function io(over: Partial<HoleIoFacts> = {}): HoleIoFacts {
  return { device: ST, mark: { state: 'absent', dataset: 'tank/v1' }, running: undefined, record: undefined, ...over }
}

/** Fileio-hole I/O facts: no stat (there is no device to name), no mark, no job. */
function fileIo(over: Partial<HoleIoFacts> = {}): HoleIoFacts {
  return { mark: { state: 'absent', dataset: FILE_PATH }, running: undefined, record: undefined, ...over }
}

function present(mark: RestoreMark, dataset = 'tank/v1'): RestoreMarkRead {
  return { state: 'present', mark, raw: JSON.stringify(mark), dataset }
}

/** A live configfs backstore, for the cases the model builder does not make. */
function liveBs(name: string, plugin: string, udevPath: string, over: Partial<ConfigfsBackstore> = {}): ConfigfsBackstore {
  return {
    name,
    plugin,
    hbaIndex: 0,
    udevPath,
    serial: 's-2',
    productId: name,
    vendorId: 'LIO-ORG',
    enabled: true,
    status: 'DEACTIVATED',
    claimed: null,
    kernelDevice: null,
    size: null,
    devMajor: null,
    devMinor: null,
    attributes: {},
    ...over,
  }
}

/** A live target of another name, when a case needs a LUN outside the hole's target. */
function otherTarget(iqn: string, tag: number, luns: ConfigfsLun[]) {
  return { iqn, tpgs: [{ tag, enabled: true, authentication: false, generateNodeAcls: false, demoModeDiscovery: false, portals: [], luns, acls: [], dynamicSessionsRaw: '' }] }
}

describe('own.4 (c) — holeKey names a hole by the address targetcli uses', () => {
  it('the TPG path plus the LUN index', () => {
    assert.equal(holeKey({ targetIqn: IQN, tpgTag: 1, lunIndex: 0 }), `/iscsi/${IQN}/tpg1/lun0`)
    assert.equal(holeKey({ targetIqn: IQN, tpgTag: 2, lunIndex: 7 }), `/iscsi/${IQN}/tpg2/lun7`)
  })
})

describe('own.4 (c) — ready: Repair puts the LUN back', () => {
  it('a block hole whose backing is back, with no other objection', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'ready',
      detail: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.',
      advice: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.',
    })
  })

  it('a fileio hole with its size, its image back and nothing else to say', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false })
    assert.equal(holeRepairVerdict(ctx, target, hole, fileIo())?.state, 'ready')
  })
})

describe('own.4 (c) — backing-absent: the path is still missing', () => {
  it('backingExists false', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false, exists: false })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'backing-absent',
      detail: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
      advice: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
    })
  })
})

describe('own.4 (c) — backing-unreadable: a failed read is unknown, never absent', () => {
  it('the existence check failed (backingExists null)', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false, exists: null })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'backing-unreadable',
      detail: `ANAS could not tell whether ${BLOCK_PATH} is on this node (its stat failed with an error other than "not found"), and Repair never recreates a backstore over a device it cannot see`,
      advice: `Repair cannot put it back: ANAS could not tell whether ${BLOCK_PATH} is on this node (its stat failed with an error other than "not found"), and Repair never recreates a backstore over a device it cannot see.`,
    })
  })

  it('a block backing whose device could not be stat\'ed (io.device null)', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io({ device: null })), {
      state: 'backing-unreadable',
      detail: `ANAS could not stat ${BLOCK_PATH}, so it cannot tell which device the path names, and Repair never recreates a backstore over a device it cannot identify`,
      advice: `Repair cannot put it back: ANAS could not stat ${BLOCK_PATH}, so it cannot tell which device the path names, and Repair never recreates a backstore over a device it cannot identify.`,
    })
  })

  it('a block hole with no device fact at all is unreadable too, never "not served"', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    const facts: HoleIoFacts = { mark: { state: 'absent', dataset: 'tank/v1' }, running: undefined, record: undefined }
    assert.equal(holeRepairVerdict(ctx, target, hole, facts)?.state, 'backing-unreadable')
  })

  it('a fileio hole is never judged by a device stat: the ready case stays ready', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false })
    assert.equal(holeRepairVerdict(ctx, target, hole, fileIo({ device: null }))?.state, 'ready')
  })
})

describe('own.4 (c) — placeholder: a zero-byte file, never a full-size one on the wrong mount', () => {
  it('a 0-byte file against a saved size', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false, savedSize: 1048576, actualSize: 0 })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, fileIo()), {
      state: 'placeholder',
      detail: 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not the image, '
        + 'which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair on the '
        + 'iSCSI screen to put the LUN back with its own serial.',
      advice: 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not the image, '
        + 'which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair on the '
        + 'iSCSI screen to put the LUN back with its own serial.',
    })
  })

  it('a FULL-SIZE image on an unexpected mount is ready, not placeholder', async () => {
    const mounts = new Map([['/', { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }]])
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false, savedSize: 1048576, actualSize: 1048576, mounts })
    assert.equal(ctx.stubs.get(FILE_PATH)?.wrongMount, true, 'the fixture does carry the wrong-mount signal')
    assert.equal(ctx.stubs.get(FILE_PATH)?.zeroSized, false)
    assert.equal(holeRepairVerdict(ctx, target, hole, fileIo())?.state, 'ready')
  })
})

describe('own.4 (c) — foreign-target: ANAS never writes to it', () => {
  it('a hole in a target ANAS does not own carries the hand-restore sentence', async () => {
    const { ctx, target, hole } = await world({ exists: false })
    hole.targetOwnership = 'foreign'
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'foreign-target',
      detail: `LUN 0 of ${IQN} (backstore 'v1', ${BLOCK_PATH}) is missing from a target ANAS does not manage. ANAS never `
        + `writes to a target it does not own, so Repair leaves it alone. Restore it by hand: bring the backing device back, `
        + `then run 'systemctl restart rtslib-fb-targetctl' in a maintenance window — it restores the whole saved configuration `
        + `with the same serials, and drops every iSCSI session on this node while it does. Until then this node stays degraded `
        + `and ANAS makes no iSCSI change: any save would erase that LUN from /etc/rtslib-fb-target/saveconfig.json. If its `
        + `device is gone for good, the way out is your own 'targetcli saveconfig', which writes the live configuration over `
        + `the saved one and so ERASES that LUN's record — a deliberate act, and not one ANAS takes.`,
      advice: `LUN 0 of ${IQN} (backstore 'v1', ${BLOCK_PATH}) is missing from a target ANAS does not manage. ANAS never `
        + `writes to a target it does not own, so Repair leaves it alone. Restore it by hand: bring the backing device back, `
        + `then run 'systemctl restart rtslib-fb-targetctl' in a maintenance window — it restores the whole saved configuration `
        + `with the same serials, and drops every iSCSI session on this node while it does. Until then this node stays degraded `
        + `and ANAS makes no iSCSI change: any save would erase that LUN from /etc/rtslib-fb-target/saveconfig.json. If its `
        + `device is gone for good, the way out is your own 'targetcli saveconfig', which writes the live configuration over `
        + `the saved one and so ERASES that LUN's record — a deliberate act, and not one ANAS takes.`,
    })
  })
})

describe('own.4 (c) — target-hands-off: an ANAS target ANAS will not write to', () => {
  it('a second TPG added by hand', async () => {
    const { ctx, target, hole } = await world()
    target.otherTpgs = [{ tpgTag: 2, enabled: true, present: true, persisted: true, portals: [], luns: [], acls: [] }]
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'target-hands-off',
      detail: `Target '${IQN}' has 2 target portal groups (TPG 1, 2). ANAS creates one TPG per target and changes only that `
        + 'one, so it does not change a target that was given more by hand — use targetcli for this target. This refusal has '
        + 'no confirm bypass.',
      advice: `Repair does not write to this target: Target '${IQN}' has 2 target portal groups (TPG 1, 2). ANAS creates one `
        + 'TPG per target and changes only that one, so it does not change a target that was given more by hand — use targetcli '
        + 'for this target. This refusal has no confirm bypass.',
    })
  })

  it('a LUN whose backing owner could not be judged', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio' })
    target.luns[0].backingOwnershipUnknown = true
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, fileIo()), {
      state: 'target-hands-off',
      detail: `ANAS could not read the ZFS mountpoint table ('zfs list' failed), so it cannot tell whether '${FILE_PATH}' is `
        + 'inside PVE\'s footprint — refusing the change while its owner is unknown. Nothing was changed; retry once \'zfs list\' answers.',
      advice: `Repair does not write to this target: ANAS could not read the ZFS mountpoint table ('zfs list' failed), so it `
        + `cannot tell whether '${FILE_PATH}' is inside PVE's footprint — refusing the change while its owner is unknown. `
        + `Nothing was changed; retry once 'zfs list' answers.`,
    })
  })
})

describe('own.4 (c) — record-incomplete: the saved record cannot be replayed', () => {
  it('a backstore name configshell would read as something else', async () => {
    const { ctx, target, hole } = await world({ name: 'v 1', liveBackstore: false })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'record-incomplete',
      detail: 'the saved record\'s "name=v 1" cannot be handed to targetcli (a space, a quote or an \'=\' it would read as '
        + 'something else) — restore it by hand (bring the device back, then restart rtslib-fb-targetctl in a maintenance window)',
      advice: 'Repair cannot put it back: the saved record\'s "name=v 1" cannot be handed to targetcli (a space, a quote '
        + 'or an \'=\' it would read as something else) — restore it by hand (bring the device back, then restart '
        + 'rtslib-fb-targetctl in a maintenance window).',
    })
  })

  it('an ACL name ANAS cannot address', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    ;(ctx.persisted as unknown as { targets: { tpgs: { acls: unknown[] }[] }[] }).targets[0].tpgs[0].acls.push({ initiatorIqn: 'bad name', mappedLuns: [0] })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'record-incomplete',
      detail: `The initiator ACL "bad name" of target '${IQN}' is not an iSCSI name ANAS can address (configfs path, `
        + 'targetcli line), so this change cannot re-grant the LUN to it. Nothing was changed. Remove or recreate that ACL '
        + 'with targetcli, then retry.',
      advice: `Repair cannot put it back: The initiator ACL "bad name" of target '${IQN}' is not an iSCSI name ANAS can `
        + 'address (configfs path, targetcli line), so this change cannot re-grant the LUN to it. Nothing was changed. Remove '
        + 'or recreate that ACL with targetcli, then retry.',
    })
  })

  it('a backing path configshell would re-split', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false, dev: '/tank/images/im age.raw' })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, fileIo()), {
      state: 'record-incomplete',
      detail: 'the saved backing path "/tank/images/im age.raw" contains a space, a quote or an \'=\', which targetcli '
        + 'cannot be handed — restore it by hand (bring the device back, then restart rtslib-fb-targetctl in a maintenance window)',
      advice: 'Repair cannot put it back: the saved backing path "/tank/images/im age.raw" contains a space, a quote or an '
        + '\'=\', which targetcli cannot be handed — restore it by hand (bring the device back, then restart '
        + 'rtslib-fb-targetctl in a maintenance window).',
    })
  })

  it('a fileio record with no size', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false, savedSize: null })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, fileIo()), {
      state: 'record-incomplete',
      detail: `the saved configuration records no size for fileio backstore 'v1' (${FILE_PATH}) — recreating it without `
        + 'one would serve a 0-byte disk with the right serial',
      advice: `Repair cannot put it back: the saved configuration records no size for fileio backstore 'v1' (${FILE_PATH}) `
        + '— recreating it without one would serve a 0-byte disk with the right serial.',
    })
  })
})

describe('own.4 (c) — backstore-live: a live backstore of this name and plugin still exists', () => {
  const DETAIL = `backstore 'v1' (block, ${BLOCK_PATH}) is still live and no LUN maps it, so Repair does not create it a `
    + `second time — check that it is this LUN's disk (live serial w-1, saved serial w-1), then map it back by hand: `
    + `'targetcli /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/v1 lun=0'`

  it('block, nothing mapping it', async () => {
    const { ctx, target, hole } = await world()
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'backstore-live',
      detail: DETAIL,
      advice: `Repair cannot put it back: ${DETAIL}.`,
    })
  })

  it('fileio', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio' })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, fileIo()), {
      state: 'backstore-live',
      detail: `backstore 'v1' (fileio, ${FILE_PATH}) is still live and no LUN maps it, so Repair does not create it a `
        + `second time — check that it is this LUN's disk (live serial w-1, saved serial w-1), then map it back by hand: `
        + `'targetcli /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/fileio/v1 lun=0'`,
      advice: `Repair cannot put it back: backstore 'v1' (fileio, ${FILE_PATH}) is still live and no LUN maps it, so Repair `
        + `does not create it a second time — check that it is this LUN's disk (live serial w-1, saved serial w-1), then map `
        + `it back by hand: 'targetcli /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/fileio/v1 lun=0'.`,
    })
  })

  it('a live backstore a LUN of another TPG already maps is named', async () => {
    const { ctx, target, hole } = await world()
    ctx.live.targets.push(otherTarget(OTHER_IQN, 3, [{ index: 2, backstoreName: 'v1', plugin: 'iblock' }]))
    const verdict = holeRepairVerdict(ctx, target, hole, io())
    assert.equal(verdict?.state, 'backstore-live')
    assert.match(verdict!.detail, new RegExp(`^backstore 'v1' \\(block, ${BLOCK_PATH}\\) is still live and serves LUN 2 of ${OTHER_IQN}, so Repair`))
  })

  it('the same NAME under another plugin is not this hole\'s backstore', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    ctx.live.backstores.push(liveBs('v1', 'fileio', BLOCK_PATH, { serial: 'w-1' }))
    assert.equal(holeRepairVerdict(ctx, target, hole, io())?.state, 'ready')
  })
})

describe('own.4 (c) — device-served-elsewhere: the device is another backstore\'s', () => {
  it('names the backstore already serving it', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false, serial: 'w-1' })
    ctx.live.backstores.push(liveBs('other', 'iblock', '/dev/zvol/tank/other', { devMajor: 230, devMinor: 16 }))
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io()), {
      state: 'device-served-elsewhere',
      detail: `${BLOCK_PATH} names device 230:16, which LIO already serves as backstore 'other' — the path no longer names `
        + 'the volume this LUN was created on, and recreating it would serve one device under two serials',
      advice: `Repair cannot put it back: ${BLOCK_PATH} names device 230:16, which LIO already serves as backstore 'other' `
        + '— the path no longer names the volume this LUN was created on, and recreating it would serve one device under two serials.',
    })
  })
})

describe('own.4 (c) — restore-mark: a mark, a running restore, or a standing job record', () => {
  it('interrupted (a writing mark, no running job)', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io({ mark: present(MARK) })), {
      state: 'restore-mark',
      detail: `${MARK_DETAIL} onto tank/v1 did not finish, so it holds a partial image`,
      advice: `Repair cannot put it back: ${MARK_DETAIL} onto tank/v1 did not finish, so it holds a partial image.`,
      restoreMark: 'interrupted',
      markOn: 'tank/v1',
    })
  })

  it('unverified (the client said complete, the size could not be confirmed)', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io({ mark: present(UNVERIFIED) })), {
      state: 'restore-mark',
      detail: `${MARK_DETAIL} wrote tank/v1, and the client reported the image complete, but its size was not verified (size could not be re-read)`,
      advice: `Repair cannot put it back: ${MARK_DETAIL} wrote tank/v1, and the client reported the image complete, but its `
        + 'size was not verified (size could not be re-read).',
      restoreMark: 'unverified',
      markOn: 'tank/v1',
    })
  })

  it('unreadable (the mark itself could not be read)', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    const mark: RestoreMarkRead = { state: 'unknown', dataset: 'tank/v1', reason: 'zfs get exited with code 1' }
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io({ mark })), {
      state: 'restore-mark',
      detail: 'ANAS could not read the restore mark on tank/v1 (zfs get exited with code 1), so it cannot tell whether it '
        + 'holds a partially restored image',
      advice: 'Repair cannot put it back: ANAS could not read the restore mark on tank/v1 (zfs get exited with code 1), so '
        + 'it cannot tell whether it holds a partially restored image.',
      restoreMark: 'unreadable',
      markOn: 'tank/v1',
    })
  })

  it('in-progress (a restore is writing it now)', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    assert.deepEqual(holeRepairVerdict(ctx, target, hole, io({ mark: present(MARK), running: 'job-7' })), {
      state: 'restore-mark',
      detail: 'a whole-image restore is writing it right now (job job-7)',
      advice: 'Repair cannot put it back: a whole-image restore is writing it right now (job job-7).',
      restoreMark: 'in-progress',
      markOn: 'tank/v1',
    })
  })

  it('a job record on an image file whose mark is unsupported, and where the mark would be', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false })
    const mark: RestoreMarkRead = { state: 'unsupported', reason: ATTR_NOT_INSTALLED }
    const record = { job: 'j-3', outcome: 'partial' as const }
    const verdict = holeRepairVerdict(ctx, target, hole, fileIo({ mark, record }))
    assert.equal(verdict?.state, 'restore-mark')
    assert.equal(verdict?.restoreMark, 'interrupted')
    assert.equal(verdict?.markOn, null)
    assert.equal(verdict?.detail, `the whole-image restore job j-3 onto it did not finish, so it may hold a partial image. ${jobRecordOnly(mark)}`)
  })
})

describe('own.4 (c) — the first rung that holds wins, and no earlier lead is lost', () => {
  it('foreign beats absent', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false, exists: false })
    hole.targetOwnership = 'foreign'
    assert.equal(holeRepairVerdict(ctx, target, hole, io())?.state, 'foreign-target')
  })

  it('hands-off beats an incomplete record', async () => {
    const { ctx, target, hole } = await world({ name: 'v 1', liveBackstore: false })
    target.otherTpgs = [{ tpgTag: 2, enabled: true, present: true, persisted: true, portals: [], luns: [], acls: [] }]
    assert.equal(holeRepairVerdict(ctx, target, hole, io())?.state, 'target-hands-off')
  })

  it('incomplete beats a placeholder', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', liveBackstore: false, dev: '/tank/images/im age.raw', savedSize: 1048576, actualSize: 0 })
    assert.equal(holeRepairVerdict(ctx, target, hole, fileIo())?.state, 'record-incomplete')
  })

  it('placeholder beats a live backstore', async () => {
    const { ctx, target, hole } = await world({ plugin: 'fileio', savedSize: 1048576, actualSize: 0 })
    assert.equal(holeRepairVerdict(ctx, target, hole, fileIo())?.state, 'placeholder')
  })

  it('absent beats a live backstore', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: true, exists: false })
    assert.equal(holeRepairVerdict(ctx, target, hole, io())?.state, 'backing-absent')
  })

  it('a live backstore held by a restore mark says both', async () => {
    const { ctx, target, hole } = await world()
    const verdict = holeRepairVerdict(ctx, target, hole, io({ mark: present(MARK) }))
    assert.equal(verdict?.state, 'backstore-live')
    assert.equal(verdict?.detail, `backstore 'v1' (block, ${BLOCK_PATH}) is still live and no LUN maps it, so Repair does not `
    + `create it a second time — check that it is this LUN's disk (live serial w-1, saved serial w-1), then map it back by `
    + `hand: 'targetcli /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/v1 lun=0'; its backing is held by a `
    + `restore mark: ${MARK_DETAIL} onto tank/v1 did not finish, so it holds a partial image`)
    assert.equal(verdict?.restoreMark, undefined, 'a backstore-live verdict carries no restoreMark field')
  })

  it('served-elsewhere beats a restore mark', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    ctx.live.backstores.push(liveBs('other', 'iblock', '/dev/zvol/tank/other', { devMajor: 230, devMinor: 16 }))
    assert.equal(holeRepairVerdict(ctx, target, hole, io({ mark: present(MARK) }))?.state, 'device-served-elsewhere')
  })
})

describe('own.4 (c) — io === null: the pure states stand, everything else is NOT judged', () => {
  const pure: { name: string, build: () => ReturnType<typeof world>, expect: string }[] = [
    {
      name: 'foreign',
      build: async () => {
        const w = await world({ liveBackstore: false })
        w.hole.targetOwnership = 'foreign'
        return w
      },
      expect: 'foreign-target',
    },
    {
      name: 'hands-off',
      build: async () => {
        const w = await world()
        w.target.otherTpgs = [{ tpgTag: 2, enabled: true, present: true, persisted: true, portals: [], luns: [], acls: [] }]
        return w
      },
      expect: 'target-hands-off',
    },
    { name: 'incomplete', build: () => world({ plugin: 'fileio', liveBackstore: false, savedSize: null }), expect: 'record-incomplete' },
    { name: 'placeholder', build: () => world({ plugin: 'fileio', liveBackstore: false, actualSize: 0 }), expect: 'placeholder' },
    { name: 'absent', build: () => world({ liveBackstore: false, exists: false }), expect: 'backing-absent' },
    { name: 'unreadable', build: () => world({ liveBackstore: false, exists: null }), expect: 'backing-unreadable' },
    { name: 'backstore-live', build: () => world(), expect: 'backstore-live' },
  ]
  for (const c of pure) {
    it(`${c.name} is decided without I/O facts`, async () => {
      const { ctx, target, hole } = await c.build()
      assert.equal(holeRepairVerdict(ctx, target, hole, null)?.state, c.expect)
    })
  }

  it('a hole that would be ready is NOT judged — never ready without its facts', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    assert.equal(holeRepairVerdict(ctx, target, hole, null), null)
  })

  it('a block hole with a live backstore but no facts: backstore-live, with no mark clause invented', async () => {
    const { ctx, target, hole } = await world()
    const verdict = holeRepairVerdict(ctx, target, hole, null)
    assert.equal(verdict?.state, 'backstore-live')
    assert.doesNotMatch(verdict!.detail, /restore mark/)
  })
})

describe('own.4 (c) — holeIoFor is the shape read() gathers', () => {
  it('a present backing gets an absent-mark read and an unserved device stat', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    const facts = holeIoFor(ctx, [target]).get(holeKey(hole))
    assert.ok(facts)
    assert.deepEqual(facts.mark, { state: 'absent', dataset: 'tank/v1' })
    assert.equal(facts.device?.rdevMajor, 230)
    assert.equal(holeRepairVerdict(ctx, target, hole, facts)?.state, 'ready')
  })

  it('an absent backing gets no entry — it is never read', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false, exists: false })
    assert.equal(holeIoFor(ctx, [target]).size, 0)
    assert.equal(holeRepairVerdict(ctx, target, hole, null)?.state, 'backing-absent')
  })

  it('an override carries the mark into the verdict', async () => {
    const { ctx, target, hole } = await world({ liveBackstore: false })
    const facts = holeIoFor(ctx, [target], { mark: present(MARK) }).get(holeKey(hole))
    assert.ok(facts)
    assert.equal(holeRepairVerdict(ctx, target, hole, facts)?.state, 'restore-mark')
  })
})

describe('own.4 (c) — advice: one whole sentence for a person, framed by the verdict owner', () => {
  // The card and the panel print this sentence; neither frames a state itself.
  // Each case is the same world as the state's own test above, and the whole
  // sentence is pinned so a change to any state's framing is seen here first.
  const READY = 'That path is available again — use Repair on the iSCSI screen to put the LUN back.'
  const ABSENT = 'That path is still missing — bring the storage back (import the pool, restore the image) first.'
  const PLACEHOLDER = 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not the image, '
    + 'which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair on the '
    + 'iSCSI screen to put the LUN back with its own serial.'
  const BACKSTORE_LIVE = `backstore 'v1' (block, ${BLOCK_PATH}) is still live and no LUN maps it, so Repair does not create it a `
    + `second time — check that it is this LUN's disk (live serial w-1, saved serial w-1), then map it back by hand: `
    + `'targetcli /iscsi/${IQN}/tpg1/luns create storage_object=/backstores/block/v1 lun=0'`

  interface AdviceCase {
    name: string
    build: () => Promise<{ ctx: IscsiReadContext, target: IscsiTargetDetail, hole: IscsiMissingLun }>
    facts: () => HoleIoFacts
    expected: string
  }
  const cases: AdviceCase[] = [
    {
      name: 'ready: the verdict\'s own sentence',
      build: () => world({ liveBackstore: false }),
      facts: () => io(),
      expected: READY,
    },
    {
      name: 'backing-absent: the verdict\'s own sentence',
      build: () => world({ liveBackstore: false, exists: false }),
      facts: () => io(),
      expected: ABSENT,
    },
    {
      name: 'placeholder: the verdict\'s own sentence',
      build: () => world({ plugin: 'fileio', liveBackstore: false, savedSize: 1048576, actualSize: 0 }),
      facts: () => fileIo(),
      expected: PLACEHOLDER,
    },
    {
      name: 'foreign-target: the verdict already holds the hand-restore sentence',
      build: async () => {
        const w = await world({ exists: false })
        w.hole.targetOwnership = 'foreign'
        return w
      },
      facts: () => io(),
      expected: `LUN 0 of ${IQN} (backstore 'v1', ${BLOCK_PATH}) is missing from a target ANAS does not manage. ANAS never `
        + 'writes to a target it does not own, so Repair leaves it alone. Restore it by hand: bring the backing device back, '
        + 'then run \'systemctl restart rtslib-fb-targetctl\' in a maintenance window — it restores the whole saved configuration '
        + 'with the same serials, and drops every iSCSI session on this node while it does. Until then this node stays degraded '
        + 'and ANAS makes no iSCSI change: any save would erase that LUN from /etc/rtslib-fb-target/saveconfig.json. If its '
        + 'device is gone for good, the way out is your own \'targetcli saveconfig\', which writes the live configuration over '
        + 'the saved one and so ERASES that LUN\'s record — a deliberate act, and not one ANAS takes.',
    },
    {
      name: 'target-hands-off: the framing says Repair will not write there',
      build: async () => {
        const w = await world()
        w.target.otherTpgs = [{ tpgTag: 2, enabled: true, present: true, persisted: true, portals: [], luns: [], acls: [] }]
        return w
      },
      facts: () => io(),
      expected: `Repair does not write to this target: Target '${IQN}' has 2 target portal groups (TPG 1, 2). ANAS creates `
        + 'one TPG per target and changes only that one, so it does not change a target that was given more by hand — use '
        + 'targetcli for this target. This refusal has no confirm bypass.',
    },
    {
      name: 'record-incomplete: a clause, and the frame supplies the stop',
      build: () => world({ name: 'v 1', liveBackstore: false }),
      facts: () => io(),
      expected: 'Repair cannot put it back: the saved record\'s "name=v 1" cannot be handed to targetcli (a space, a quote '
        + 'or an \'=\' it would read as something else) — restore it by hand (bring the device back, then restart '
        + 'rtslib-fb-targetctl in a maintenance window).',
    },
    {
      name: 'backing-unreadable: a clause, framed as a refusal',
      build: () => world({ liveBackstore: false, exists: null }),
      facts: () => io(),
      expected: `Repair cannot put it back: ANAS could not tell whether ${BLOCK_PATH} is on this node (its stat failed with an `
        + 'error other than "not found"), and Repair never recreates a backstore over a device it cannot see.',
    },
    {
      name: 'backstore-live: a clause, framed as a refusal',
      build: () => world(),
      facts: () => io(),
      expected: `Repair cannot put it back: ${BACKSTORE_LIVE}.`,
    },
    {
      name: 'device-served-elsewhere: a clause, framed as a refusal',
      build: async () => {
        const w = await world({ liveBackstore: false, serial: 'w-1' })
        w.ctx.live.backstores.push(liveBs('other', 'iblock', '/dev/zvol/tank/other', { devMajor: 230, devMinor: 16 }))
        return w
      },
      facts: () => io(),
      expected: `Repair cannot put it back: ${BLOCK_PATH} names device 230:16, which LIO already serves as backstore `
        + '\'other\' — the path no longer names the volume this LUN was created on, and recreating it would serve one '
        + 'device under two serials.',
    },
    {
      name: 'restore-mark: a clause, framed as a refusal',
      build: () => world({ liveBackstore: false }),
      facts: () => io({ mark: { state: 'present', mark: MARK, raw: JSON.stringify(MARK), dataset: 'tank/v1' } }),
      expected: `Repair cannot put it back: ${MARK_DETAIL} onto tank/v1 did not finish, so it holds a partial image.`,
    },
  ]
  for (const c of cases) {
    it(c.name, async () => {
      const { ctx, target, hole } = await c.build()
      assert.equal(holeRepairVerdict(ctx, target, hole, c.facts())?.advice, c.expected)
    })
  }
})
