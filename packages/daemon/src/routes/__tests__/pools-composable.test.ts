import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'
import { createServer } from '../../server.js'

/**
 * D4 — the ZFS pool composer reads the disk inventory, like the AHR composer
 * always has. A `handsOff: 'iscsi-served-here'` disk is the GT-43 loop-back:
 * the node's own LUN arriving over its own initiator, indistinguishable from a
 * remote array to `zpool` — and a non-available disk would be clobbered by the
 * create. All three composer doors (create, add-vdev, attach/replace) refuse
 * such a disk BEFORE the job, naming the disk and the hands-off reason, and a
 * disk the inventory does not know keeps zpool's own error as the answer.
 *
 * The loop-back is produced the honest way: the real `iscsi.1` configfs capture
 * is materialised (so the inventory's served-serial read sees the LUN) and the
 * mock lsblk gains one `transport: iscsi` blank disk carrying that LUN's real
 * unit serial — exactly what the node's own initiator shows.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ISCSI_FIXTURES = join(__dirname, '../../fixtures/iscsi')

/** gtiscsi_lun2's real unit serial from the capture (GT-43's shape). */
const LOOPBACK_SERIAL = '689844a4-1d20-4cba-8516-bdc52a402645'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

describe('D4 — the ZFS pool composer refuses non-composable disks', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[]

  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    storage: process.env.ANAS_STORAGE_CFG,
  }

  /**
   * A mock server whose inventory is the dev fixture plus ONE loop-back disk:
   * `sdz`, transport iscsi, carrying the captured LUN's serial. `withLio`
   * decides whether that LUN is actually being SERVED (the materialised
   * capture ⇒ the hands-off tag) or not (no tag ⇒ an ordinary available disk).
   */
  async function serve(withLio: boolean): Promise<void> {
    if (withLio) {
      const root = join(dir, 'target')
      await materializeConfigfsManifest(
        readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8'),
        root,
      )
      process.env.ANAS_ISCSI_CONFIGFS = root
      process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
      process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'absent-block')
    }
    process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')

    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === '/usr/bin/lsblk' && args.join(' ') === LSBLK_ARGS.join(' ')) {
        // The dev fixture's disks, plus the loop-back LUN as the kernel shows it.
        const inventory = JSON.parse(mockFixtures.lsblk().stdout) as { blockdevices: unknown[] }
        inventory.blockdevices.push({
          'name': 'sdz',
          'type': 'disk',
          'size': 8589934592,
          'model': 'gtiscsi_lun2',
          'serial': LOOPBACK_SERIAL,
          'tran': 'iscsi',
          'fstype': null,
          'mountpoint': null,
          'rota': true,
          'phy-sec': 512,
          'log-sec': 512,
          'wwn': null,
          'vendor': 'LIO-ORG',
          'rev': '4.0',
        })
        return { stdout: JSON.stringify(inventory), stderr: '', exitCode: 0 }
      }
      return orig(command, args)
    }
    await server.ready()
  }

  /** Did any command actually try to do the composer's work? */
  function ran(zpoolVerb: string): boolean {
    return calls.some(c => c.command === '/usr/sbin/zpool' && c.args[0] === zpoolVerb)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-composable-'))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const [key, saved] of [
      ['ANAS_ISCSI_CONFIGFS', savedEnv.configfs],
      ['ANAS_ISCSI_SYS_BLOCK', savedEnv.block],
      ['ANAS_ISCSI_SAVECONFIG', savedEnv.saveconfig],
      ['ANAS_STORAGE_CFG', savedEnv.storage],
    ] as const) {
      if (saved === undefined)
        delete process.env[key]
      else
        process.env[key] = saved
    }
  })

  it('POST /v1/pools refuses a hands-off (loop-back LUN) disk — named, with the reason, no zpool create', async () => {
    await serve(true)
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        name: 'looppool',
        dataVdevs: [{ type: 'stripe', disks: [LOOPBACK_SERIAL] }],
      }),
    })
    assert.equal(res.statusCode, 400)
    const { message } = res.json().error
    assert.ok(message.includes(`disk '${LOOPBACK_SERIAL}' is hands-off`), message)
    assert.match(message, /served by THIS node/)
    // The reason is the loop-back one: storage on top of itself.
    assert.match(message, /stack storage on top of itself/)
    assert.match(message, /Manage it from the iSCSI screen/)
    assert.equal(ran('create'), false, 'zpool create must never run')
  })

  it('the same disk absent the tag composes normally — the refusal is the tag, not the disk', async () => {
    await serve(false)
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools',
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        name: 'plainpool',
        dataVdevs: [{ type: 'stripe', disks: [LOOPBACK_SERIAL] }],
      }),
    })
    assert.equal(res.statusCode, 202, JSON.stringify(res.json()))
    await new Promise(resolve => setTimeout(resolve, 20))
    const create = calls.find(c => c.command === '/usr/sbin/zpool' && c.args[0] === 'create')
    assert.ok(create, 'zpool create ran')
    assert.ok(create.args.includes(`/dev/disk/by-id/${LOOPBACK_SERIAL}`), JSON.stringify(create.args))
  })

  it('POST /v1/pools/:name/attach refuses a hands-off NEW disk — no zpool attach', async () => {
    await serve(true)
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/attach',
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        existingDiskId: 'ata-WDC_WD2003FZEX-00SRLA0_WD-12345678',
        newDiskId: LOOPBACK_SERIAL,
        replace: false,
      }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /is hands-off/)
    assert.equal(ran('attach'), false)
  })

  it('POST /v1/pools/:name/vdevs refuses a hands-off cache disk — no zpool add', async () => {
    await serve(true)
    const res = await server!.inject({
      method: 'POST',
      url: '/v1/pools/testpool/vdevs',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ role: 'cache', disks: [LOOPBACK_SERIAL] }),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().error.message, /is hands-off/)
    assert.equal(ran('add'), false)
  })
})
