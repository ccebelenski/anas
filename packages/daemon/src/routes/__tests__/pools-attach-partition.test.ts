import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diskClaim } from '../../safety/guard.js'
import { createServer } from '../../server.js'
import { serveBlankInventoryDisks } from './inventory-stub.js'
import { capturedPoolGet, servePoolGuardReads } from './pool-guard-reads.js'

/**
 * Story nf.1 — the wave-3 node pass's D1 (docs/LIVE-PROOF-0.4.4-wave3.md):
 * attach / replace onto a by-id PARTITION. cr.36's new-disk gate resolved
 * `newDiskId` against the whole-disk inventory, so the vdevs.2 (#66) replace
 * of a partition-backed leaf by another partition answered 400 "disk
 * '<id>-part4' not found", and the stripped-id ambiguity refusal was never
 * reached. A partition is now checked as a partition, at both doors, under
 * its WHOLE disk's lock key.
 *
 * FIXTURES (ruling (l): fakes print captured output; every rewrite spelled out):
 *  - the pool: `zfs/zpool-status-multi-cache-spare-jv-2.4.4.json`, the
 *    stunt-node capture of `vdev-fixture.sh up-multi` (gtvdev: data -part1,
 *    log -part2, cache -part3/-part6, spares -part4/-part5, all by-id
 *    partitions of HOT9). The record's repro first ran `zpool remove gtvdev
 *    <id>-part4; zpool labelclear -f <id>-part4`, so the spare -part4 is
 *    DROPPED from the capture's `spares` section — the freed partition.
 *  - the pool's guid and boot facts: `pool-guard-reads.ts` (the captured
 *    `zpool get all -j` under the pool's name).
 *  - the inventory: HOT9 joins the dev lsblk capture as blank disk `sdy0`
 *    (`inventory-stub.ts`).
 *  - the partition probe (`lsblk -J -o NAME,TYPE,PKNAME,MOUNTPOINT <dev>`):
 *    the captured blank partition row `sda14` of `mounts/lsblk-O-full.json`
 *    (type part, no mountpoint, no children), projected onto the four asked
 *    columns with `name` rewritten to `sdy04` and `pkname` to `sdy0`.
 *  - `blkid -p` on a blank partition: the wave-3 capture
 *    (`docs/probes/wave3-node/out/n6-zpool-create.log`, HOT21-part1, "shows
 *    only PART_ENTRY_*") with the device rewritten to HOT9-part4.
 *  - `blkid -p` on a LABELLED partition: no capture exists; the same line
 *    with the content keys a ZFS label adds prepended (`LABEL`, `UUID` = the
 *    pool guid of the capture above, `TYPE="zfs_member" USAGE="filesystem"`,
 *    the `TYPE`/`USAGE` shape of the captured ext4 line in
 *    BACKUP-RESTORE-GROUND-TRUTH.md). COMPOSED, not captured.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const ZPOOL = '/usr/sbin/zpool'
const LSBLK = '/usr/bin/lsblk'
const BLKID = '/usr/sbin/blkid'
const BY_ID = '/dev/disk/by-id/'

const POOL = 'gtvdev'
const DISK = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'
const PART = (n: number): string => `${DISK}-part${n}`
const PART_PATH = (n: number): string => `${BY_ID}${PART(n)}`

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** The capture with the spare -part4 removed (the record's `zpool remove`). */
const STATUS_PART4_FREED = (() => {
  const doc = JSON.parse(fixture('zfs/zpool-status-multi-cache-spare-jv-2.4.4.json')) as { pools: Record<string, Record<string, Record<string, unknown>>> }
  assert.ok(doc.pools[POOL].spares[PART(4)], 'the capture carries the spare -part4')
  delete doc.pools[POOL].spares[PART(4)]
  return JSON.stringify(doc)
})()
const POOL_GUID = (JSON.parse(STATUS_PART4_FREED) as { pools: Record<string, { pool_guid: string }> }).pools[POOL].pool_guid
const LIST = JSON.stringify({ pools: { [POOL]: { name: POOL, state: 'ONLINE', properties: {} } } })

/** The captured blank partition row, projected and renamed (see the module note). */
const PROBE_BLANK = (() => {
  const doc = JSON.parse(fixture('mounts/lsblk-O-full.json')) as { blockdevices: { children?: Record<string, unknown>[] }[] }
  const row = doc.blockdevices.flatMap(d => d.children ?? []).find(c => c.name === 'sda14')
  assert.ok(row && row.type === 'part' && row.mountpoint === null && row.children === undefined, 'the capture carries the blank partition sda14')
  return JSON.stringify({ blockdevices: [{ name: 'sdy04', type: row.type, pkname: 'sdy0', mountpoint: row.mountpoint }] })
})()

/** Captured verbatim (wave-3 node pass, n6), device rewritten HOT21-part1 → HOT9-part4. */
const BLKID_CAPTURED_HOT21 = '/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT21-part1: PART_ENTRY_SCHEME="gpt" PART_ENTRY_NAME="zfs-be7977a25d6c0c32" PART_ENTRY_UUID="41ac7166-7e4f-5e49-bb66-cc0978b656bc" PART_ENTRY_TYPE="6a898cc3-1dd2-11b2-99a6-080020736631" PART_ENTRY_NUMBER="1" PART_ENTRY_OFFSET="2048" PART_ENTRY_SIZE="1028096" PART_ENTRY_DISK="8:64"\n'
const BLKID_BLANK = BLKID_CAPTURED_HOT21.replace('scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT21-part1', PART(4))
/** COMPOSED (see the module note): the blank line with a ZFS label's content keys. */
const BLKID_ZFS_LABEL = BLKID_BLANK.replace(': PART_ENTRY_SCHEME', `: LABEL="${POOL}" UUID="${POOL_GUID}" TYPE="zfs_member" USAGE="filesystem" PART_ENTRY_SCHEME`)

interface Call { command: string, args: string[] }

describe('nf.1 — attach / replace onto a by-id partition (wave-3 D1)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let calls: Call[] = []
  /** What the node answers right now; a test flips these while the job waits. */
  let probe: ExecResult = ok(PROBE_BLANK)
  let blkid: ExecResult = ok(BLKID_BLANK)
  const paused = new Map<string, Promise<void>>()

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  function serve(): void {
    probe = ok(PROBE_BLANK)
    blkid = ok(BLKID_BLANK)
    paused.clear()
    server = createServer({ mock: true, logger: false })
    serveBlankInventoryDisks(server, [DISK])
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.clearFixtures()
    servePoolGuardReads(mock, POOL)
    mock.addFixture({ command: ZPOOL, args: ['list', '-j'], result: ok(LIST) })
    mock.addFixture({ command: ZPOOL, args: ['status', '-jv'], result: ok(STATUS_PART4_FREED) })
    mock.addFixture({ command: ZPOOL, args: undefined, result: ok('') })
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command: string, args: string[], opts?: unknown): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === LSBLK && args.join(' ') === `-J -o NAME,TYPE,PKNAME,MOUNTPOINT ${PART_PATH(4)}`)
        return probe
      if (command === BLKID && args.join(' ') === `-p ${PART_PATH(4)}`)
        return blkid
      const hold = command === ZPOOL ? paused.get(args[0]) : undefined
      if (hold)
        await hold
      return orig(command, args, opts as never)
    }
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  async function post(existingDiskId: string, newDiskId = PART(4), replace = true) {
    return server!.inject({
      method: 'POST',
      url: `/v1/pools/${POOL}/attach`,
      headers: JSON_HEADERS,
      payload: JSON.stringify({ existingDiskId, newDiskId, replace }),
    })
  }

  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`job ${id} did not finish`)
  }

  const mutations = (): Call[] => calls.filter(c => c.command === ZPOOL && ['replace', 'attach', 'online'].includes(c.args[0]))

  it('the record\'s repro: the freed partition -part4 replaces the LOG partition -part2 — ZFS is handed both partitions', async () => {
    serve()
    const res = await post(PART(2))
    assert.equal(res.statusCode, 202, res.body)
    const job = await finished((res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.deepEqual(mutations().map(c => c.args), [
      ['replace', '--', POOL, PART_PATH(2), PART_PATH(4)],
      ['online', '-e', '--', POOL, PART_PATH(4)],
    ])
    // Checked at both doors: the probe and the signature read ran at the
    // route AND in the job.
    assert.equal(calls.filter(c => c.command === BLKID).length, 2)
    assert.equal(calls.filter(c => c.command === LSBLK && c.args.includes(PART_PATH(4))).length, 2)
  })

  it('the record\'s second form: the STRIPPED disk id now reaches the ambiguity refusal, with its candidates', async () => {
    serve()
    const res = await post(DISK)
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(res.json().error.code, 'VALIDATION_ERROR')
    assert.match(res.json().error.message, new RegExp(`names more than one device in pool ${POOL}`))
    assert.match(res.json().error.message, /name the one you mean by its device/)
    assert.doesNotMatch(res.json().error.message, /not found/)
    assert.deepEqual(mutations(), [])
  })

  it('race: the partition gains a ZFS label while the job waits → VALIDATION_ERROR naming it, no zpool replace', async () => {
    serve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    const res = await post(PART(2))
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    assert.equal(queue().get(id)?.status, 'queued', 'the job waits behind the held slots')

    blkid = ok(BLKID_ZFS_LABEL)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'VALIDATION_ERROR', job.error?.message)
    assert.match(job.error!.message, new RegExp(`partition '${PART(4)}' carries a signature \\(TYPE=zfs_member, LABEL=${POOL}\\)`))
    assert.deepEqual(mutations(), [])
  })

  it('the job holds the WHOLE disk\'s key, not the partition\'s', async () => {
    serve()
    let release!: () => void
    paused.set('replace', new Promise<void>((resolve) => {
      release = resolve
    }))
    const res = await post(PART(2))
    const id = (res.json() as JobAccepted).job.id
    for (let i = 0; i < 400 && !calls.some(c => c.command === ZPOOL && c.args[0] === 'replace'); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(queue().heldLocks().map(l => [l.key, l.mode]), [
      // The guid the guard reads (`pool-guard-reads.ts`: the captured `zpool get` under gtvdev's name).
      [`zpool:${capturedPoolGet().guid}`, 'exclusive'],
      // cr.33b: a guid-keyed claim also holds the pool's name key shared.
      ['zname:gtvdev', 'shared'],
      [`disk:${DISK}`, 'exclusive'],
    ])
    release()
    assert.equal((await finished(id)).status, 'completed')
  })

  /**
   * cr.57 (review L14): one disk, one `disk:` key. The attach locked the
   * by-id PREFIX the caller typed; every other disk verb (the AHR spare and
   * cache verbs, `diskClaim`) locks the INVENTORY id. A `wwn-…-part4` attach
   * and an AHR verb on the same disk therefore did not serialise. The alias
   * resolves (udev) to the same kernel partition, so the fake answers the
   * alias path with the same captured lsblk row / blkid line as `-part4`.
   */
  it('a partition named through ANOTHER by-id alias locks the inventory\'s key — and contends with a verb that locks the disk by its inventory id', async () => {
    serve()
    const WWN = 'wwn-0x5000c500a1b2c3d4'
    const aliasPath = `${BY_ID}${WWN}-part4`
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const inner = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[], opts?: unknown): Promise<ExecResult> =>
      inner(command, args.map(a => (a === aliasPath ? PART_PATH(4) : a)), opts as never)

    let release!: () => void
    paused.set('replace', new Promise<void>((resolve) => {
      release = resolve
    }))
    const res = await post(PART(2), `${WWN}-part4`)
    assert.equal(res.statusCode, 202, res.body)
    const id = (res.json() as JobAccepted).job.id
    for (let i = 0; i < 400 && !calls.some(c => c.command === ZPOOL && c.args[0] === 'replace'); i++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(calls.some(c => c.command === ZPOOL && c.args[0] === 'replace'), 'the attach job is running')
    const keys = queue().heldLocks().map(l => l.key)
    assert.ok(keys.includes(`disk:${DISK}`), keys.join(', '))
    assert.ok(!keys.some(k => k.startsWith('disk:wwn-')), keys.join(', '))

    // The AHR spare/cache doors lock `diskClaim(<inventory id>)`: a job holding
    // that key waits for the attach.
    let ran = false
    const other = queue().submit('test.ahr-disk-verb', { user: 'test', uid: 0 }, async () => {
      ran = true
    }, { locks: [diskClaim(DISK)] })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(queue().get(other.id)?.status, 'queued', 'the other door waits on the same disk key')
    assert.equal(ran, false)
    release()
    assert.equal((await finished(id)).status, 'completed')
    assert.equal((await finished(other.id)).status, 'completed')
  })

  it('a partition that already carries a signature is refused at the route, naming it', async () => {
    serve()
    blkid = ok(BLKID_ZFS_LABEL)
    const res = await post(PART(2))
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, `Ineligible disk selection: partition '${PART(4)}' carries a signature (TYPE=zfs_member, LABEL=${POOL}) — clear it first if the partition is really free`)
    assert.deepEqual(mutations(), [])
  })

  it('blkid exit 2 (nothing found) is a blank partition too', async () => {
    serve()
    blkid = { stdout: '', stderr: '', exitCode: 2 }
    const res = await post(PART(2))
    assert.equal(res.statusCode, 202, res.body)
    assert.equal((await finished((res.json() as JobAccepted).job.id)).status, 'completed')
  })

  it('a partition that does not exist (lsblk exit 32) is a 400 naming it; a failed probe is a 409 unreadable', async () => {
    serve()
    probe = { stdout: '', stderr: `lsblk: ${PART_PATH(4)}: not a block device`, exitCode: 32 }
    let res = await post(PART(2))
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.message, `Ineligible disk selection: partition '${PART(4)}' not found`)

    probe = ok(PROBE_BLANK)
    blkid = { stdout: '', stderr: 'blkid: error', exitCode: 4 }
    res = await post(PART(2))
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.reason, 'unreadable')
    assert.match(res.json().error.message, /could not be probed for signatures \(blkid exited 4: blkid: error\); refusing to replace a device it cannot identify/)
    assert.deepEqual(mutations(), [])
  })

  /**
   * cr.57 (review M3): the two partition doors see each other's labels. An
   * AHR slice is BLANK until md writes it — an expansion halted after cutting
   * its slices leaves exactly that, and the resume then `mdadm --add`s over
   * whatever ZFS put there. The slice's GPT name is the only mark, and the
   * blank-line capture above carries one: its `PART_ENTRY_NAME` value is
   * rewritten to a CAPTURED AHR label (`ahr0-d3-b2`, a member slice in
   * `fixtures/ahr/lsblk-ahr0.json`; `gtcache-cache1`, the cache slice of the
   * GT-25 udev capture). The unchanged line — ZFS's own `zfs-<hex>` name —
   * is every other test's blank partition, so ZFS's label keeps passing.
   */
  describe('cr.57 — an AHR slice label refuses the partition', () => {
    const withName = (name: string): string => {
      assert.ok(BLKID_BLANK.includes('PART_ENTRY_NAME="zfs-be7977a25d6c0c32"'))
      return BLKID_BLANK.replace('PART_ENTRY_NAME="zfs-be7977a25d6c0c32"', `PART_ENTRY_NAME="${name}"`)
    }

    it('a blank partition labelled as an AHR MEMBER slice is refused at the route, naming the pool', async () => {
      serve()
      blkid = ok(withName('ahr0-d3-b2'))
      const res = await post(PART(2))
      assert.equal(res.statusCode, 400, res.body)
      assert.equal(res.json().error.message, `Ineligible disk selection: partition '${PART(4)}' carries AHR pool 'ahr0''s member slice label 'ahr0-d3-b2' — AHR still counts it as that pool's (an expansion resume writes md onto it); delete or relabel the partition first if it is really free`)
      assert.deepEqual(mutations(), [])
    })

    it('a blank partition labelled as an AHR CACHE slice is refused too', async () => {
      serve()
      blkid = ok(withName('gtcache-cache1'))
      const res = await post(PART(2))
      assert.equal(res.statusCode, 400, res.body)
      assert.match(res.json().error.message, new RegExp(`partition '${PART(4)}' carries AHR pool 'gtcache''s cache slice label 'gtcache-cache1'`))
      assert.deepEqual(mutations(), [])
    })

    it('race: the partition is labelled as an AHR slice while the job waits → the job refuses, no zpool replace', async () => {
      serve()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      for (let i = 0; i < 4; i++)
        queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
      const res = await post(PART(2))
      assert.equal(res.statusCode, 202, res.body)
      const id = (res.json() as JobAccepted).job.id
      blkid = ok(withName('ahr0-d3-b2'))
      release()
      const job = await finished(id)
      assert.equal(job.status, 'failed')
      assert.equal(job.error?.code, 'VALIDATION_ERROR', job.error?.message)
      assert.match(job.error!.message, /member slice label 'ahr0-d3-b2'/)
      assert.deepEqual(mutations(), [])
    })
  })

  it('a mounted partition, or one on a disk the inventory does not know, is refused', async () => {
    serve()
    const row = JSON.parse(PROBE_BLANK) as { blockdevices: Record<string, unknown>[] }
    probe = ok(JSON.stringify({ blockdevices: [{ ...row.blockdevices[0], mountpoint: '/srv/x' }] }))
    let res = await post(PART(2))
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, new RegExp(`partition '${PART(4)}' is mounted at /srv/x`))

    probe = ok(JSON.stringify({ blockdevices: [{ ...row.blockdevices[0], pkname: 'sdzz' }] }))
    res = await post(PART(2))
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, new RegExp(`partition '${PART(4)}' is on a disk the inventory does not know \\(sdzz\\)`))
    assert.deepEqual(mutations(), [])
  })
})
