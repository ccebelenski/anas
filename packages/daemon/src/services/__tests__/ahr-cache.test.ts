import type { AhrPool } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { cachePartitionLabel } from '../ahr-cache-state.js'
import { attachAhrCache, detachAhrCache, findCacheSlices } from '../ahr-cache.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/**
 * `cache-attach` / `cache-detach` as §5.1 detect-then-delta step sequences
 * (story ahrcache.1, AHR-DESIGN §13).
 *
 * These tests run against a MODELLED node rather than canned command output.
 * Detect-then-delta is a property of a sequence meeting the state its own
 * earlier steps produced, and a fixed list of replies cannot express that: it
 * pins what each read returns instead of letting the reads follow the writes.
 * With a model, "re-running is a no-op" is asserted by running the verb TWICE
 * and looking at what the second run issued — which is the actual claim.
 *
 * The model's answers are the shapes captured live on the stunt node during
 * this story's proof (fixtures/ahr/lvm-pvs-cached.json,
 * lvs-cached-live.json, lvm-pvs-cache-missing.json).
 */

const POOL = 'gtcache'
const CACHE_DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'
const CACHE_DEV = `/dev/disk/by-id/${CACHE_DISK}`
const CACHE_SLICE = `${CACHE_DEV}-part1`
const CACHE_LABEL = `${POOL}-cache1`
const CACHE_LV = `${POOL}-cache`
const POOL_LV = `${POOL}-vol`
const CACHE_PV_BYTES = 532676608
const SLICE_BYTES = 535805440

const LSBLK = '/usr/bin/lsblk'
const LS = '/usr/bin/ls'
const SGDISK = '/usr/sbin/sgdisk'
const UDEVADM = '/usr/bin/udevadm'
const WIPEFS = '/usr/sbin/wipefs'
const REALPATH = '/usr/bin/realpath'
const PVS = '/usr/sbin/pvs'
const PVCREATE = '/usr/sbin/pvcreate'
const PVREMOVE = '/usr/sbin/pvremove'
const VGEXTEND = '/usr/sbin/vgextend'
const VGREDUCE = '/usr/sbin/vgreduce'
const LVS = '/usr/sbin/lvs'
const LVCREATE = '/usr/sbin/lvcreate'
const LVREMOVE = '/usr/sbin/lvremove'
const LVCONVERT = '/usr/sbin/lvconvert'

const MIXED = ['--config', 'devices/allow_mixed_block_sizes=1']

/**
 * The minimum of an AhrPool these two verbs read. `arrays` is load-bearing,
 * not decoration: its LENGTH is the discriminator that tells a missing CACHE
 * PV from a missing BAND PV, and `vgreduce --removemissing` is taken only when
 * every band is still accounted for.
 */
function pool(extra: Partial<AhrPool> = {}, bands = 1): AhrPool {
  return {
    name: POOL,
    lv: { name: POOL_LV, sizeBytes: 1065353216 },
    arrays: Array.from({ length: bands }, (_, i) => ({ band: i + 1 })),
    ...extra,
  } as AhrPool
}

/**
 * A modelled node: one AHR-1 pool (`/dev/md127`) plus a cache disk, with the
 * LVM/GPT state the two verbs move through. Reads answer FROM the state;
 * mutations advance it. Every call still lands in `calls`, so the exact argv
 * is assertable.
 */
class CacheWorld extends MockExecutor {
  /** The `<pool>-cache<n>` GPT slice exists on the cache disk. */
  slice = false
  /** The slice carries a PV label. */
  pv = false
  /** The PV is a member of the pool VG. */
  inVg = false
  /** The `<pool>-cache` LV exists (hidden once it is a live cachevol). */
  cacheLv = false
  /** The pool LV is a cache target. */
  cached = false
  /** The cache PV's device is gone — `pvs` reports `[unknown]` (GT-19). */
  missingPv = false
  /** A foreign partition label on the cache disk, if any. */
  foreignPart: string | null = null
  /** Make these commands fail, each with its own stderr. */
  failCommands: { command: string, stderr: string }[] = []
  /** Serve this exact `pvs` JSON instead of the modelled one. */
  pvsOverride: string | null = null
  /** Extra `pvs` rows appended to the modelled ones (same capture shape). */
  extraPvRows: Record<string, string>[] = []
  /** The node-wide lsblk tree answers exit 0 with output that is not JSON. */
  lsblkGarbage = false

  private ok(stdout = ''): ExecResult {
    return { stdout, stderr: '', exitCode: 0 }
  }

  private diskParts(): { name: string, partlabel: string }[] {
    if (this.foreignPart !== null)
      return [{ name: 'sdd1', partlabel: this.foreignPart }]
    return this.slice ? [{ name: 'sdd1', partlabel: CACHE_LABEL }] : []
  }

  private lsblkDisk(): string {
    return JSON.stringify({
      blockdevices: [{
        name: 'sdd',
        type: 'disk',
        size: 536870912,
        children: this.diskParts().map(p => ({ name: p.name, type: 'part', size: SLICE_BYTES, partlabel: p.partlabel })),
      }],
    })
  }

  private lsblkNode(): string {
    return JSON.stringify({
      blockdevices: [
        { name: 'sdb', type: 'disk', size: 1073741824, children: [{ name: 'sdb1', type: 'part', size: 1072676352, partlabel: `${POOL}-d1-b1` }] },
        {
          name: 'sdd',
          type: 'disk',
          size: 536870912,
          children: this.diskParts().map(p => ({ name: p.name, type: 'part', size: SLICE_BYTES, partlabel: p.partlabel })),
        },
      ],
    })
  }

  private pvsJson(): string {
    if (this.pvsOverride !== null)
      return this.pvsOverride
    const rows: Record<string, string>[] = [
      { pv_name: '/dev/md127', vg_name: POOL, pv_size: '1065353216', pv_free: '0', dev_size: '1068433408' },
    ]
    if (this.missingPv)
      rows.push({ pv_name: '[unknown]', vg_name: POOL, pv_size: String(CACHE_PV_BYTES), pv_free: '0', dev_size: '0' })
    else if (this.pv)
      rows.push({ pv_name: '/dev/sdd1', vg_name: this.inVg ? POOL : '', pv_size: String(CACHE_PV_BYTES), pv_free: '0', dev_size: String(SLICE_BYTES) })
    rows.push(...this.extraPvRows)
    return JSON.stringify({ report: [{ pv: rows }] })
  }

  private lvsJson(): string {
    const rows: Record<string, string>[] = [{
      lv_name: POOL_LV,
      vg_name: POOL,
      // The partial `p` flag rides along when a PV is missing (GT-19).
      lv_attr: this.cached ? (this.missingPv ? 'Cwi-aoC-p-' : 'Cwi-aoC---') : '-wi-ao----',
      lv_size: '1065353216',
    }]
    // Once it is a live cachevol the volume is the HIDDEN `_cvol` and `lvs`
    // without `-a` does not list it. Only an ORPHAN one is visible.
    if (this.cacheLv && !this.cached)
      rows.push({ lv_name: CACHE_LV, vg_name: POOL, lv_attr: '-wi-a-----', lv_size: String(CACHE_PV_BYTES) })
    return JSON.stringify({ report: [{ lv: rows }] })
  }

  override async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    const failure = this.failCommands.find(f => f.command === command)
    if (failure)
      return { stdout: '', stderr: failure.stderr, exitCode: 5 }

    switch (command) {
      case LSBLK:
        if (this.lsblkGarbage && !args.includes(CACHE_DEV))
          return this.ok('lsblk: sdd: failed to get device path\n')
        return this.ok(args.includes(CACHE_DEV) ? this.lsblkDisk() : this.lsblkNode())
      case LS:
        return this.ok(`total 0
lrwxrwxrwx 1 root root  9 Sep 24 20:00 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7 -> ../../sdb
lrwxrwxrwx 1 root root 10 Sep 24 20:00 scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT7-part1 -> ../../sdb1
lrwxrwxrwx 1 root root  9 Sep 24 20:00 ${CACHE_DISK} -> ../../sdd
lrwxrwxrwx 1 root root 10 Sep 24 20:00 ${CACHE_DISK}-part1 -> ../../sdd1
`)
      case PVS:
        return this.ok(this.pvsJson())
      case LVS:
        return this.ok(this.lvsJson())
      case REALPATH:
        return this.slice ? this.ok('/dev/sdd1\n') : { stdout: '', stderr: 'no such file', exitCode: 1 }
      case SGDISK:
        if (args[0] === '-d') {
          this.slice = false
          this.pv = false
        }
        else { this.slice = true }
        return this.ok()
      case WIPEFS:
        this.pv = false
        return this.ok()
      case PVCREATE:
        this.pv = true
        return this.ok()
      case PVREMOVE:
        this.pv = false
        return this.ok()
      case VGEXTEND:
        this.inVg = true
        return this.ok()
      case VGREDUCE:
        this.inVg = false
        this.missingPv = false
        return this.ok()
      case LVCREATE:
        this.cacheLv = true
        return this.ok()
      case LVREMOVE:
        this.cacheLv = false
        return this.ok()
      case LVCONVERT:
        if (args.includes('--uncache')) {
          this.cached = false
          this.cacheLv = false
        }
        else { this.cached = true }
        return this.ok()
      default:
        return this.ok()
    }
  }
}

/** The argv of every call to `command`, in order. */
function callsTo(world: CacheWorld, command: string): string[][] {
  return world.calls.filter(c => c.command === command).map(c => c.args)
}

/** Forget the call log, keeping the modelled state — for "run it again" tests. */
function clearCalls(world: CacheWorld): void {
  world.calls.length = 0
}

function noop(): void {}

describe('cache-attach — the step sequence (ahrcache.1, §13)', () => {
  it('FRESH disk: slice → settle → wipefs → pvcreate → vgextend → lvcreate → lvconvert', async () => {
    const world = new CacheWorld()
    const result = await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)

    // The slice: whole disk from 1 MiB, LVM type, the deterministic label.
    assert.deepEqual(callsTo(world, SGDISK), [
      ['-n', '1:1M:0', '-t', '1:8E00', '-c', `1:${CACHE_LABEL}`, CACHE_DEV],
    ])
    // GT-21: `udevadm settle` after sgdisk — the create path's pair. The
    // expansion path's `partx -a` answers a holders problem a cache disk,
    // which is idle by definition at attach time, does not have.
    assert.deepEqual(callsTo(world, UDEVADM), [['settle']])
    assert.equal(world.calls.some(c => c.command === '/usr/sbin/partx'), false)
    // GT-18: `wipefs -a` BEFORE pvcreate, or a stale signature aborts it
    // non-interactively and vgextend then fails for a misleading reason.
    assert.deepEqual(callsTo(world, WIPEFS), [['-a', CACHE_SLICE]])
    assert.ok(
      world.calls.findIndex(c => c.command === WIPEFS) < world.calls.findIndex(c => c.command === PVCREATE),
    )
    assert.deepEqual(callsTo(world, PVCREATE), [[...MIXED, CACHE_SLICE]])
    assert.deepEqual(callsTo(world, VGEXTEND), [[...MIXED, POOL, CACHE_SLICE]])
    // GT-18's exact lvcreate: 100%PVS over the NAMED cache PVs only, so the
    // cache can never land on a band array. Linear — no redundancy, because a
    // writethrough cache is never the only copy of anything.
    assert.deepEqual(callsTo(world, LVCREATE), [
      [...MIXED, '-y', '-n', CACHE_LV, '-l', '100%PVS', POOL, CACHE_SLICE],
    ])
    // Writethrough, and `-y` because a job has no tty (GT-18).
    assert.deepEqual(callsTo(world, LVCONVERT), [
      [...MIXED, '-y', '--type', 'cache', '--cachevol', CACHE_LV, '--cachemode', 'writethrough', `${POOL}/${POOL_LV}`],
    ])
    assert.deepEqual(result.devices, [CACHE_DISK])
    assert.equal(result.sizeBytes, CACHE_PV_BYTES)
    assert.equal(result.warnings, undefined)
    assert.equal(world.cached, true)
  })

  it('HALF-DONE (slice cut, PV made, not in the VG): only vgextend onward runs', async () => {
    const world = new CacheWorld()
    world.slice = true
    world.pv = true
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)

    assert.deepEqual(callsTo(world, SGDISK), [], 'the slice is already there')
    assert.deepEqual(callsTo(world, WIPEFS), [], 'the PV label is ours already')
    assert.deepEqual(callsTo(world, PVCREATE), [])
    assert.equal(callsTo(world, VGEXTEND).length, 1)
    assert.equal(callsTo(world, LVCREATE).length, 1)
    assert.equal(callsTo(world, LVCONVERT).length, 1)
  })

  it('HALF-DONE (cache volume made, never converted): only lvconvert runs', async () => {
    const world = new CacheWorld()
    world.slice = true
    world.pv = true
    world.inVg = true
    world.cacheLv = true
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)

    for (const cmd of [SGDISK, WIPEFS, PVCREATE, VGEXTEND, LVCREATE])
      assert.deepEqual(callsTo(world, cmd), [], `${cmd} must not run`)
    assert.equal(callsTo(world, LVCONVERT).length, 1)
  })

  it('DONE: running it AGAIN over the cache it just built issues no mutation', async () => {
    const world = new CacheWorld()
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    clearCalls(world)

    // The live cache volume is now the hidden `_cvol`, invisible to `lvs`
    // without `-a` — which is exactly why completion is detected from the POOL
    // LV's own attribute and not from "does `<pool>-cache` exist".
    const result = await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    for (const cmd of [SGDISK, WIPEFS, PVCREATE, VGEXTEND, LVCREATE, LVCONVERT, LVREMOVE])
      assert.deepEqual(callsTo(world, cmd), [], `${cmd} must not run again`)
    assert.equal(result.sizeBytes, CACHE_PV_BYTES)
  })

  it('a rotating disk is ALLOWED and gets the one advisory, in the job result', async () => {
    const world = new CacheWorld()
    const result = await attachAhrCache(
      world,
      { pool: pool(), diskIds: [CACHE_DISK], rotationalIds: [CACHE_DISK] },
      noop,
    )
    assert.equal(callsTo(world, LVCONVERT).length, 1, 'the attach still happens')
    assert.deepEqual(result.warnings, [`${CACHE_DISK} is a rotating disk: a rotating cache adds a seek, not speed`])
  })

  it('refuses a disk that already carries foreign partitions', async () => {
    const world = new CacheWorld()
    world.foreignPart = 'someone-elses-data'
    await assert.rejects(
      attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop),
      /already carries 1 partition .*refusing to partition a disk that is not empty/,
    )
    assert.deepEqual(callsTo(world, SGDISK), [], 'nothing was written to the GPT')
  })

  it('a failed step rolls back what this attempt created, then re-throws the cause', async () => {
    const world = new CacheWorld()
    world.failCommands = [{ command: LVCONVERT, stderr: 'lvconvert: cannot do that' }]
    await assert.rejects(
      attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop),
      /lvconvert: cannot do that/,
    )
    // The rollback is the detach sequence: the orphan cache volume goes, the
    // PV leaves the VG, and the slice is DELETED. The pool is left uncached
    // and the disk clean — a stray cache PV left in the VG would sit there as
    // free extents a later expansion would try to grow the pool onto.
    assert.equal(callsTo(world, LVREMOVE).length, 1)
    assert.ok(callsTo(world, VGREDUCE).length >= 1)
    assert.ok(callsTo(world, SGDISK).some(a => a[0] === '-d'), 'the slice is deleted')
    assert.equal(world.slice, false)
    assert.equal(world.inVg, false)
    assert.equal(world.cacheLv, false)
  })

  it('a rollback that ALSO fails is LOGGED, and the original cause is what is thrown', async () => {
    const world = new CacheWorld()
    // The attach dies on lvconvert; the rollback's own `lvremove` of the orphan
    // cache volume then dies too. The operator must still get the diagnosis
    // they can act on — and the cleanup's failure must not vanish, or a
    // half-attached cache sits in the VG with nothing anywhere saying so.
    world.failCommands = [
      { command: LVCONVERT, stderr: 'lvconvert: cannot do that' },
      { command: LVREMOVE, stderr: 'lvremove: Logical volume is in use' },
    ]
    const lines: string[] = []
    await assert.rejects(
      attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop, { log: l => lines.push(l) }),
      /lvconvert: cannot do that/,
      'the STEP\'s error is the one that reaches the operator, never the rollback\'s',
    )
    assert.deepEqual(
      lines.filter(l => l.includes('step=rollback')),
      [`ahr.cache pool=${POOL} step=rollback status=failed error=lvremove: Logical volume is in use`],
    )
  })

  it('ALREADY cached: the result names the pool\'s OWN cache disks, not the request\'s', async () => {
    const world = new CacheWorld()
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    clearCalls(world)

    // A request that raced past the route's 409 and asked for a different disk.
    const cached = pool({ cache: { devices: ['ata-SOMEONE_ELSES_SSD'], sizeBytes: CACHE_PV_BYTES, mode: 'writethrough', policy: 'smq', state: 'healthy' } })
    const result = await attachAhrCache(world, { pool: cached, diskIds: ['ata-OPERATORS_NEW_SSD'] }, noop)
    assert.deepEqual(result.devices, ['ata-SOMEONE_ELSES_SSD'], 'what the pool HAS, not what was asked for')
    assert.deepEqual(callsTo(world, SGDISK), [], 'and the requested disk is untouched')
  })

  it('a disk that is not attached fails the step by name, before anything is written', async () => {
    const world = new CacheWorld()
    world.failCommands = [{ command: LSBLK, stderr: 'lsblk: not found' }]
    await assert.rejects(
      attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop),
      /is not attached \(no \/dev\/disk\/by-id entry\)/,
    )
  })
})

describe('cache-detach — the step sequence (ahrcache.1, §13/GT-20/GT-22)', () => {
  it('healthy cache: uncache → vgreduce → pvremove → wipefs → sgdisk -d', async () => {
    const world = new CacheWorld()
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    clearCalls(world)

    const result = await detachAhrCache(world, { pool: pool() }, noop)

    assert.deepEqual(callsTo(world, LVCONVERT), [[...MIXED, '-y', '--uncache', `${POOL}/${POOL_LV}`]])
    assert.deepEqual(callsTo(world, VGREDUCE), [[...MIXED, POOL, '/dev/sdd1']])
    assert.deepEqual(callsTo(world, PVREMOVE), [[...MIXED, '-y', CACHE_SLICE]])
    assert.deepEqual(callsTo(world, WIPEFS), [['-a', CACHE_SLICE]])
    // GT-22: the partition must be DELETED, not merely wiped — otherwise the
    // disk keeps reading `other` in /v1/disks and can never be picked again.
    assert.deepEqual(callsTo(world, SGDISK), [['-d', '1', CACHE_DEV]])
    assert.deepEqual(result.released, [CACHE_DISK])
    assert.equal(world.slice, false)
  })

  it('FAILED cache, device gone: --removemissing, and nothing to wipe or delete', async () => {
    const world = new CacheWorld()
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    // The device is pulled: the slice vanishes with it and the PV goes nameless.
    world.slice = false
    world.pv = false
    world.missingPv = true
    clearCalls(world)

    const result = await detachAhrCache(world, { pool: pool() }, noop)

    // GT-20: `--uncache` works with the device absent and the pool mounted, no
    // force, nothing to flush — writethrough's guarantee, which is what makes
    // this safe to run unattended.
    assert.deepEqual(callsTo(world, LVCONVERT), [[...MIXED, '-y', '--uncache', `${POOL}/${POOL_LV}`]])
    // A nameless PV can only be reached by --removemissing.
    assert.deepEqual(callsTo(world, VGREDUCE), [[...MIXED, '--removemissing', POOL]])
    assert.deepEqual(callsTo(world, PVREMOVE), [])
    assert.deepEqual(callsTo(world, WIPEFS), [])
    assert.deepEqual(callsTo(world, SGDISK), [])
    assert.deepEqual(result.released, [])
  })

  it('LEFTOVER slice only (no cache target): the slice is still deleted (GT-22)', async () => {
    // The state a died-and-returned cache disk comes back in: our GPT label,
    // an outdated PV label LVM ignores, and no cache anywhere.
    const world = new CacheWorld()
    world.slice = true

    const result = await detachAhrCache(world, { pool: pool() }, noop)

    assert.deepEqual(callsTo(world, LVCONVERT), [], 'nothing to uncache')
    assert.deepEqual(callsTo(world, VGREDUCE), [], 'nothing of ours in the VG')
    assert.deepEqual(callsTo(world, PVREMOVE), [], 'LVM already forgot it')
    assert.deepEqual(callsTo(world, WIPEFS), [['-a', CACHE_SLICE]])
    assert.deepEqual(callsTo(world, SGDISK), [['-d', '1', CACHE_DEV]])
    assert.deepEqual(result.released, [CACHE_DISK])
  })

  it('missing PV with every band PRESENT: --removemissing is taken (the live fixture shape)', async () => {
    const world = new CacheWorld()
    world.cached = true
    // The verbatim stunt-node capture: the band's md PV named and present, the
    // cache's device gone and nameless.
    world.pvsOverride = loadFixture('lvm-pvs-cache-missing.json')

    await detachAhrCache(world, { pool: pool() }, noop)

    assert.deepEqual(callsTo(world, LVCONVERT), [[...MIXED, '-y', '--uncache', `${POOL}/${POOL_LV}`]])
    assert.deepEqual(callsTo(world, VGREDUCE), [[...MIXED, '--removemissing', POOL]])
  })

  it('missing PV with a BAND PV also gone: REFUSED, naming what is missing and what unlocks it', async () => {
    const world = new CacheWorld()
    world.cached = true
    // A stopped band array reads `[unknown]` exactly as a dead cache device
    // does. `--removemissing` here would evict the BAND's PV from a pool that
    // was merely not assembled.
    world.pvsOverride = JSON.stringify({
      report: [{
        pv: [
          { pv_name: '[unknown]', vg_name: POOL, pv_size: '1065353216', pv_free: '0', dev_size: '0' },
          { pv_name: '[unknown]', vg_name: POOL, pv_size: String(CACHE_PV_BYTES), pv_free: '0', dev_size: '0' },
        ],
      }],
    })

    await assert.rejects(
      detachAhrCache(world, { pool: pool() }, noop),
      /only 0 of 1 band arrays are present.*Bring the band arrays up first/s,
    )
    assert.deepEqual(callsTo(world, VGREDUCE), [], 'nothing was reduced')
  })

  it('a FOREIGN PV in the pool VG is left alone — only OUR slices are ejected', async () => {
    const world = new CacheWorld()
    world.slice = true
    world.cached = true
    // `/dev/sde1` is in the VG and is not an md device, which is all the old
    // test asked. It carries no `<pool>-cache<n>` label, so it is not ours.
    world.pvsOverride = JSON.stringify({
      report: [{
        pv: [
          { pv_name: '/dev/md127', vg_name: POOL, pv_size: '1065353216', pv_free: '0', dev_size: '1068433408' },
          { pv_name: '/dev/sdd1', vg_name: POOL, pv_size: String(CACHE_PV_BYTES), pv_free: '0', dev_size: String(SLICE_BYTES) },
          { pv_name: '/dev/sde1', vg_name: POOL, pv_size: '1073741824', pv_free: '0', dev_size: '1073741824' },
        ],
      }],
    })

    await detachAhrCache(world, { pool: pool() }, noop)

    assert.deepEqual(callsTo(world, VGREDUCE), [[...MIXED, POOL, '/dev/sdd1']])
    assert.equal(
      callsTo(world, VGREDUCE).some(a => a.includes('/dev/sde1')),
      false,
      'a PV the operator added by hand is not ours to evict',
    )
  })

  it('DONE: running it AGAIN issues nothing', async () => {
    const world = new CacheWorld()
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    await detachAhrCache(world, { pool: pool() }, noop)
    clearCalls(world)

    const result = await detachAhrCache(world, { pool: pool() }, noop)
    for (const cmd of [LVCONVERT, LVREMOVE, VGREDUCE, PVREMOVE, WIPEFS, SGDISK, UDEVADM])
      assert.deepEqual(callsTo(world, cmd), [], `${cmd} must not run`)
    assert.deepEqual(result.released, [])
  })

  it('an ORPHAN cache volume (attach died before lvconvert) is removed first', async () => {
    const world = new CacheWorld()
    world.slice = true
    world.pv = true
    world.inVg = true
    world.cacheLv = true

    await detachAhrCache(world, { pool: pool() }, noop)

    assert.deepEqual(callsTo(world, LVCONVERT), [], 'there is no cache to uncache')
    assert.deepEqual(callsTo(world, LVREMOVE), [[...MIXED, '-f', `${POOL}/${CACHE_LV}`]])
    // vgreduce cannot proceed while the orphan still holds the cache PV.
    assert.ok(
      world.calls.findIndex(c => c.command === LVREMOVE) < world.calls.findIndex(c => c.command === VGREDUCE),
    )
  })
})

describe('findCacheSlices — the on-disk label sweep', () => {
  it('finds our slice by label and resolves it to a by-id path', async () => {
    const world = new CacheWorld()
    world.slice = true
    assert.deepEqual(await findCacheSlices(world, POOL), [{
      diskId: CACHE_DISK,
      partNumber: 1,
      path: CACHE_SLICE,
      kernelPath: '/dev/sdd1',
      ordinal: 1,
    }])
  })

  it('never picks up a BAND slice, or another pool\'s cache slice', async () => {
    const world = new CacheWorld()
    world.slice = true
    assert.deepEqual(await findCacheSlices(world, 'othertank'), [])
  })
})

describe('ahrcache.1 review fixes — the executor', () => {
  /** Every command a detach can MUTATE the node with. */
  const MUTATIONS = [LVCONVERT, LVREMOVE, VGREDUCE, PVREMOVE, WIPEFS, SGDISK, UDEVADM]

  // ---- Finding 4: a failed slice read fails the step ----------------------

  it('lsblk FAILING during detach fails the job BEFORE any mutation, naming the exit and stderr', async () => {
    const world = new CacheWorld()
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    clearCalls(world)
    world.failCommands = [{ command: LSBLK, stderr: 'lsblk: cannot open /sys/block\nsecond line' }]

    await assert.rejects(
      detachAhrCache(world, { pool: pool() }, noop),
      /lsblk exited 5 \(lsblk: cannot open \/sys\/block\)/,
    )
    // The old behaviour: `[]` → uncache ran, every cleanup step was skipped,
    // the job reported success with nothing released and the cache PV stayed
    // in the VG as free extents. Now nothing runs at all.
    for (const cmd of MUTATIONS)
      assert.deepEqual(callsTo(world, cmd), [], `${cmd} must not run`)
    assert.equal(world.cached, true, 'the cache is untouched, so a re-run starts clean')
  })

  it('an unparsable lsblk tree is a failed read too, never "no slices"', async () => {
    const world = new CacheWorld()
    world.slice = true
    world.lsblkGarbage = true
    await assert.rejects(findCacheSlices(world, POOL), /lsblk printed output that is not JSON/)
  })

  it('an unreadable /dev/disk/by-id fails the read — without it no slice can be named', async () => {
    const world = new CacheWorld()
    world.slice = true
    world.failCommands = [{ command: LS, stderr: 'ls: cannot access' }]
    await assert.rejects(findCacheSlices(world, POOL), /ls exited 5 \(ls: cannot access\)/)
  })

  it('an EMPTY answer stays the answer when lsblk genuinely shows no slice', async () => {
    const world = new CacheWorld()
    assert.deepEqual(await findCacheSlices(world, POOL), [])
  })

  it('attach ROLLBACK over a failed slice read: logged, and the step\'s own error is what is thrown', async () => {
    const world = new CacheWorld()
    world.failCommands = [{ command: LSBLK, stderr: 'lsblk: not found' }]
    const lines: string[] = []
    await assert.rejects(
      attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop, { log: l => lines.push(l) }),
      /is not attached \(no \/dev\/disk\/by-id entry\)/,
    )
    assert.ok(
      lines.some(l => l.includes('step=rollback status=failed') && l.includes('lsblk exited 5')),
      JSON.stringify(lines),
    )
  })

  // ---- Finding 1 (executor side): a foreign PV is not cache flash ---------

  it('attach reports the size of OUR slice only, with a foreign PV in the VG', async () => {
    const world = new CacheWorld()
    world.extraPvRows = [{ pv_name: '/dev/sde1', vg_name: POOL, pv_size: '1069547520', pv_free: '1069547520', dev_size: '1073741824' }]
    const result = await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    assert.equal(result.sizeBytes, CACHE_PV_BYTES)
  })

  // ---- Finding 5: the slice label comes from the one helper ---------------

  it('attach writes the GPT label the helper defines', async () => {
    const world = new CacheWorld()
    await attachAhrCache(world, { pool: pool(), diskIds: [CACHE_DISK] }, noop)
    const cut = callsTo(world, SGDISK).find(a => a[0] === '-n')!
    assert.equal(cut[cut.indexOf('-c') + 1], `1:${cachePartitionLabel(POOL, 1)}`)
  })
})
