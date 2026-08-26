import type { BackupLunSourceList } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BackupLunSourceList as BackupLunSourceListSchema } from '@anas/shared'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'

/**
 * backup2.4 — `GET /v1/backup/lun-sources`, the `img` archive's picker.
 *
 * It is the iSCSI READ LAYER seen from the backup side, so it is tested against
 * the same real captures the iSCSI routes are (`configfs-live.manifest` +
 * `saveconfig-final.json`, from story `iscsi.1`): one zvol-backed LUN and one
 * file-backed LUN.
 *
 * The captured target's IQN is `iqn.2026-08.dev.anas.gtiscsi:target1`, whose
 * naming authority ends in `gtiscsi`, not `anas` — so the real capture is a
 * FOREIGN, hands-off target. Since backup2.8 (live-proof F7) that alone keeps
 * its LUNs out of the picker, because `POST /v1/backup/restore` refuses to
 * restore an image onto a target ANAS does not own: a source you can back up
 * and never restore is not a source. The ANAS-owned cases below replay the SAME
 * capture with the ONE byte that decides ownership changed — the IQN's
 * authority — so everything else stays the node's own output.
 *
 * The three things this endpoint adds over the iSCSI read are exactly what is
 * asserted here: the OWNERSHIP gate, the backing FILTER (nothing ANAS cannot
 * resolve, nothing PVE owns) and the DERIVED consistency per LUN.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

/** The captured IQN. Authority `dev.anas.gtiscsi` — NOT ANAS's (F7). */
const FOREIGN_IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'
/** The same target with an ANAS naming authority (`…anas:<name>`). */
const GT_IQN = 'iqn.2026-08.dev.gtiscsi.anas:target1'
const ZVOL_PATH = '/dev/zvol/gtiscsi/vol1'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

/** `gtiscsi` declared as a PVE `zfspool` storage — the hands-off case. */
const PVE_STORAGE_CFG = [
  'zfspool: local-zfs',
  '\tpool gtiscsi',
  '\tcontent images,rootdir',
  '',
].join('\n')

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/**
 * The capture with the target's IQN rewritten to an ANAS naming authority. The
 * IQN is a plain string everywhere it appears (configfs directory names,
 * `saveconfig.json`), and it is the ONLY thing ownership turns on here, so a
 * verbatim substitution changes exactly the axis under test and nothing else.
 */
function asAnasOwned(text: string): string {
  return text.split(FOREIGN_IQN).join(GT_IQN)
}

describe('GET /v1/backup/lun-sources — the img archive picker (backup2.4)', () => {
  let dir: string
  let server: ReturnType<typeof createServer> | undefined
  const savedEnv = {
    configfs: process.env.ANAS_ISCSI_CONFIGFS,
    block: process.env.ANAS_ISCSI_SYS_BLOCK,
    saveconfig: process.env.ANAS_ISCSI_SAVECONFIG,
    storage: process.env.ANAS_STORAGE_CFG,
  }

  async function serve(opts: {
    manifest?: string
    saveconfig?: string
    storageCfg?: string
    /** Replay the capture with a FOREIGN IQN (the bytes as captured). */
    foreignTarget?: boolean
  } = {}) {
    const rewrite = opts.foreignTarget ? (t: string) => t : asAnasOwned
    if (opts.manifest) {
      const root = join(dir, 'target')
      await materializeConfigfsManifest(rewrite(loadFixture(opts.manifest)), root)
      process.env.ANAS_ISCSI_CONFIGFS = root
    }
    else {
      process.env.ANAS_ISCSI_CONFIGFS = join(dir, 'absent-configfs')
    }
    if (opts.saveconfig) {
      const path = join(dir, 'saveconfig.json')
      await writeFile(path, rewrite(loadFixture(opts.saveconfig)))
      process.env.ANAS_ISCSI_SAVECONFIG = path
    }
    else {
      process.env.ANAS_ISCSI_SAVECONFIG = join(dir, 'absent-saveconfig.json')
    }
    if (opts.storageCfg !== undefined) {
      const path = join(dir, 'storage.cfg')
      await writeFile(path, opts.storageCfg)
      process.env.ANAS_STORAGE_CFG = path
    }
    else {
      process.env.ANAS_STORAGE_CFG = join(dir, 'absent-storage.cfg')
    }
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'block')
    server = createServer({ mock: true, logger: false })
    await server.ready()
  }

  async function lunSources(): Promise<{ statusCode: number, data?: BackupLunSourceList }> {
    const res = await server!.inject({ method: 'GET', url: '/v1/backup/lun-sources', headers: IDENTITY })
    return { statusCode: res.statusCode, ...(res.json() as { data?: BackupLunSourceList }) }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-lun-sources-'))
    // The sysfs stub that gives the zvol LUN its real 2 GiB size.
    await mkdir(join(dir, 'block', 'zd16'), { recursive: true })
    await writeFile(join(dir, 'block', 'zd16', 'size'), '4194304\n')
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

  it('lists the zvol-backed LUN from the real capture, with its serial and size', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await lunSources()
    assert.equal(res.statusCode, 200)
    assert.equal(BackupLunSourceListSchema.safeParse(res.data).success, true)
    assert.equal(res.data!.installed, true)

    const zvol = res.data!.luns.find(l => l.path === ZVOL_PATH)
    assert.ok(zvol, JSON.stringify(res.data!.luns))
    assert.equal(zvol.targetIqn, GT_IQN)
    assert.equal(zvol.index, 0)
    assert.equal(zvol.name, 'gtiscsi_vol1')
    assert.equal(zvol.kind, 'zvol')
    assert.equal(zvol.serial, '9bc6e907-6015-4267-be4f-5a0617cb3d71')
    assert.equal(zvol.size, 2 * 1024 * 1024 * 1024)
  })

  it('carries the DERIVED consistency, so the picker says snapshot/live before the pick', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const zvol = (await lunSources()).data!.luns.find(l => l.path === ZVOL_PATH)
    assert.ok(zvol?.consistency)
    // A zvol on a pool PVE does not manage is snapshot-consistent, through its
    // own snapshot device — never a `.zfs/snapshot` path.
    assert.equal(zvol.consistency.consistency, 'snapshot')
    assert.equal(zvol.consistency.backend, 'zfs')
    assert.equal(zvol.consistency.target, 'gtiscsi/vol1')
    assert.equal(zvol.consistency.zvolDevice, ZVOL_PATH)
  })

  it('a LUN whose backing ANAS cannot resolve is NOT offered', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await lunSources()
    // LUN 1 is a fileio backstore on `/gtiscsi/images/lun2.raw`, which resolves
    // onto no dataset and no AHR pool here (`unresolved` since iscsi.5; `foreign`
    // before) — ANAS cannot say what backs it, so it cannot say what backing it
    // up would capture.
    assert.equal(res.data!.luns.some(l => l.path.endsWith('lun2.raw')), false, JSON.stringify(res.data!.luns))
  })

  it('a FOREIGN target\'s LUNs are NOT offered — the image restore refuses them (F7)', async () => {
    // The capture verbatim: authority `dev.anas.gtiscsi`, so `isAnasIqn` is
    // false and the target is hands-off. Live proof watched this exact target's
    // LUNs get offered here and then refused by `POST /v1/backup/restore` with
    // `409 foreign-target` — a source that can be backed up and never restored.
    await serve({
      manifest: 'configfs-live.manifest',
      saveconfig: 'saveconfig-final.json',
      foreignTarget: true,
    })
    const res = await lunSources()
    assert.equal(res.statusCode, 200)
    assert.equal(res.data!.installed, true)
    assert.equal(
      res.data!.luns.some(l => l.targetIqn === FOREIGN_IQN),
      false,
      JSON.stringify(res.data!.luns),
    )
    assert.deepEqual(res.data!.luns, [])
  })

  it('an ANAS-owned target\'s LUNs ARE offered — the same capture, ANAS IQN (F7)', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await lunSources()
    assert.equal(res.statusCode, 200)
    // Same node, same backstores, same serial: ownership is the only difference.
    assert.deepEqual(res.data!.luns.map(l => l.path), [ZVOL_PATH])
    assert.equal(res.data!.luns[0].targetIqn, GT_IQN)
  })

  it('a zvol on a PVE-managed pool is NEVER offered (PVE territory is hands-off)', async () => {
    await serve({
      manifest: 'configfs-live.manifest',
      saveconfig: 'saveconfig-final.json',
      storageCfg: PVE_STORAGE_CFG,
    })
    const res = await lunSources()
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.data!.luns, [])
  })

  it('reports the backing that does not resolve rather than hiding the row (GT-40)', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const zvol = (await lunSources()).data!.luns.find(l => l.path === ZVOL_PATH)
    // No `/dev/zvol` on a test host: the honest answer is `false`, ON the row.
    assert.equal(zvol!.backingExists, false)
  })

  it('a node with no LIO stack answers 200 with installed:false and an empty list', async () => {
    await serve()
    const res = await lunSources()
    assert.equal(res.statusCode, 200)
    assert.equal(BackupLunSourceListSchema.safeParse(res.data).success, true)
    assert.equal(res.data!.installed, false)
    assert.deepEqual(res.data!.luns, [])
    assert.match(res.data!.reason ?? '', /not present on this node/)
  })

  it('is identity-gated like every other route', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const res = await server!.inject({ method: 'GET', url: '/v1/backup/lun-sources' })
    assert.equal(res.statusCode, 401)
  })

  it('never contacts PBS and never runs targetcli', async () => {
    await serve({ manifest: 'configfs-live.manifest', saveconfig: 'saveconfig-final.json' })
    const executor = (server as unknown as { executor: { calls: { command: string }[] } }).executor
    executor.calls.length = 0
    await lunSources()
    const commands = executor.calls.map(c => c.command)
    assert.equal(commands.some(c => c.includes('proxmox-backup-client')), false, commands.join(' | '))
    assert.equal(commands.some(c => c.includes('targetcli')), false, commands.join(' | '))
  })
})
