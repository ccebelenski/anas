import type { Job } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { zfsSnapshotListArgs } from '../../parsers/zfs-list.js'
import { createServer } from '../../server.js'
import { TARGETCLI, ZFS, zvolExistsArgs } from '../../services/iscsi-mutate.js'

/**
 * cr.64cr — the zvol-existence gate of the LUN add, over the REAL route and
 * the dev server's fake executor (the review of cr.64c, probes P8a–P8d).
 *
 * cr.64c put the check inside `addIscsiLun`, which the route runs inside its
 * backstore-undo try with the flag already up — so a missing volume fired
 * `removeOrphanedBackstore`, a targetcli delete of a namesake backstore the
 * job never created; its name-only `zfs list` exited 0 for a filesystem; and
 * it said "does not exist" for a read that could not see. Service-level tests
 * could not show the first: only the route holds the try.
 *
 * The zfs answers are the captured stderr lines (`fixtures/iscsi/zfs-list-t-
 * volume-*.stderr.txt`, zfs-2.4.4, `LC_ALL=C`, 2026-10-16) except the
 * suspended pool, which is SYNTHETIC (libzfs's EZFS_IO description; a
 * suspended pool cannot be produced on demand).
 */

const FIXTURES = new URL('../../fixtures/', import.meta.url).pathname
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')
const IDENTITY_HEADERS = { 'x-anas-user': 'root@pam', 'x-anas-user-uid': '0', 'x-anas-privileges': 'Sys.Audit,Sys.Modify', 'x-anas-request-id': '11111111-2222-4333-8444-555555555555' }
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }
const CAPTURED_IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'
/** The captured target, re-named into an ANAS-generated IQN so it is ANAS-owned (the iscsi-guard harness). */
const IQN = 'iqn.2026-08.dev.gtiscsi.anas:target1'
const ZVOL_PATH = '/dev/zvol/gtiscsi/vol1'
const ZVOL_DATASET = 'gtiscsi/vol1'
const owned = (m: string): string => m.split(CAPTURED_IQN).join(IQN)
const HOLE = owned(fixture('iscsi/configfs-restore-hole.manifest'))
const SNAPSHOTS_CAPTURE = fixture('zfs/zfs-snapshots-media.json')
const NO_SNAPSHOTS = JSON.stringify({ ...JSON.parse(SNAPSHOTS_CAPTURE), datasets: {} })
/** Captured stderr, re-pointed at the test's dataset name (the shape is zfs's, the name is ours). */
const ABSENT_STDERR = fixture('iscsi/zfs-list-t-volume-absent.stderr.txt').replace('zfspool/anas-cr64cr-nonexistent', 'gtiscsi/vol9')
const FILESYSTEM_STDERR = fixture('iscsi/zfs-list-t-volume-filesystem.stderr.txt').replace('zfspool', 'gtiscsi/images')
const SUSPENDED_STDERR = 'cannot open \'gtiscsi/vol9\': pool I/O is currently suspended\n'
const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
const failed = (stderr: string): ExecResult => ({ stdout: '', stderr, exitCode: 1 })
const targetUrl = `/v1/iscsi/targets/${encodeURIComponent(IQN)}`

describe('cr.64cr — the LUN add proves its zvol BEFORE the backstore undo (route level)', () => {
  let dir: string
  let configfs: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** Answers checked BEFORE the dev server's own (command + joined argv → result). */
  let override = new Map<string, ExecResult>()
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ['ANAS_ISCSI_CONFIGFS', 'ANAS_ISCSI_SYS_BLOCK', 'ANAS_ISCSI_SAVECONFIG', 'ANAS_STORAGE_CFG', 'ANAS_ISCSI_INITIATOR_NAME', 'ANAS_ISCSI_DEVICE_STAT']

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cr64cr-'))
    configfs = join(dir, 'target')
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  })
  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined)
        delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  async function serve(answers: [string[], ExecResult][]): Promise<void> {
    override = new Map(answers.map(([args, r]) => [`${ZFS} ${args.join(' ')}`, r]))
    await materializeConfigfsManifest(HOLE, configfs)
    process.env.ANAS_ISCSI_CONFIGFS = configfs
    process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    process.env.ANAS_ISCSI_INITIATOR_NAME = join(dir, 'absent-initiatorname.iscsi')
    process.env.ANAS_ISCSI_DEVICE_STAT = `${ZVOL_PATH}=230:16`
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      const o = override.get(`${command} ${args.join(' ')}`)
      if (o)
        return o
      if (command === TARGETCLI)
        return ok('')
      if (command === ZFS && args.join(' ') === zfsSnapshotListArgs(ZVOL_DATASET).join(' '))
        return ok(NO_SNAPSHOTS)
      return orig(command, args, opts)
    }
    await server.ready()
  }
  const queue = (): JobQueue => (server as unknown as { jobQueue: JobQueue }).jobQueue
  async function finished(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const job = queue().get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error('job did not finish')
  }
  async function addZvolLun(backing: string): Promise<Job> {
    const res = await server!.inject({ method: 'POST', url: `${targetUrl}/luns`, headers: JSON_HEADERS, payload: JSON.stringify({ name: 'newlun', kind: 'zvol', backing }) })
    assert.equal(res.statusCode, 202, res.body)
    return finished(res.json().job.id)
  }
  /** Every argv the JOB ran after the gate reads: the targetcli acts and the volume read. */
  const acts = (): string[] => calls
    .filter(c => c.command === TARGETCLI || (c.command === ZFS && c.args.includes('volume')))
    .map(c => `${c.command} ${c.args.join(' ')}`)

  it('P8a: a MISSING volume — the only act is the `zfs list -t volume` read, no targetcli at all (no orphan cleanup)', async () => {
    await serve([[zvolExistsArgs('gtiscsi/vol9'), failed(ABSENT_STDERR)]])
    const job = await addZvolLun('gtiscsi/vol9')
    assert.equal(job.status, 'failed')
    assert.deepEqual(acts(), [`${ZFS} list -H -t volume -o name -- gtiscsi/vol9`])
    assert.match(job.error!.message, /^volume 'gtiscsi\/vol9' does not exist \(cannot open 'gtiscsi\/vol9': dataset does not exist\); a zvol LUN is backed by an existing ZFS volume; nothing was done$/)
    assert.doesNotMatch(job.error!.message, /backstore/, 'no half-created backstore was deleted — none was created')
  })

  it('P8c: a FILESYSTEM named as the zvol is refused as not a volume, before any targetcli', async () => {
    await serve([[zvolExistsArgs('gtiscsi/images'), failed(FILESYSTEM_STDERR)]])
    const job = await addZvolLun('gtiscsi/images')
    assert.equal(job.status, 'failed')
    assert.deepEqual(acts(), [`${ZFS} list -H -t volume -o name -- gtiscsi/images`])
    assert.match(job.error!.message, /^'gtiscsi\/images' is not a volume — a filesystem or snapshot is not a block device \(cannot open 'gtiscsi\/images': operation not applicable to datasets of this type\)/)
  })

  it('P8d: a read that could not see (pool suspended) says "could not be read", never "does not exist"', async () => {
    await serve([[zvolExistsArgs('gtiscsi/vol9'), failed(SUSPENDED_STDERR)]])
    const job = await addZvolLun('gtiscsi/vol9')
    assert.equal(job.status, 'failed')
    assert.deepEqual(acts(), [`${ZFS} list -H -t volume -o name -- gtiscsi/vol9`])
    assert.equal(job.error!.message, 'volume \'gtiscsi/vol9\' could not be read (cannot open \'gtiscsi/vol9\': pool I/O is currently suspended); nothing was done')
    assert.doesNotMatch(job.error!.message, /does not exist/)
  })

  it('P8b: a volume that IS there — the read first, then the create-and-map sequence and the save', async () => {
    await serve([[zvolExistsArgs('gtiscsi/vol9'), ok('gtiscsi/vol9\n')]])
    const job = await addZvolLun('gtiscsi/vol9')
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const seq = acts()
    assert.equal(seq[0], `${ZFS} list -H -t volume -o name -- gtiscsi/vol9`)
    assert.ok(seq.slice(1).length > 0 && seq.slice(1).every(a => a.startsWith(TARGETCLI)), seq.join('\n'))
    assert.ok(seq.some(a => a.includes('/backstores/block create name=newlun dev=/dev/zvol/gtiscsi/vol9')), seq.join('\n'))
  })
})
