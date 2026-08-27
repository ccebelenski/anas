import type { BackupTaskEntry, Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { effectiveTaskKind, lunBackupId } from '@anas/shared'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { createServer } from '../../server.js'

/**
 * backup2.9 — a backup task is FILES or BLOCK. The daemon side of the contract:
 * the list carries the EFFECTIVE kind (+ the LUN name, resolved live from the
 * iSCSI read layer, fail-open null), and a block task's backup-id is verified
 * against the read layer's own serial — the PBS group is the LUN's durable
 * identity, and a client that sends a different id for a LUN this node can see
 * gets a guiding 400, not a task whose backups split into two groups.
 *
 * The read layer is the same real capture the lun-sources route is tested
 * against (`configfs-live.manifest` + `saveconfig-final.json`), replayed with
 * the IQN's authority rewritten to an ANAS naming authority.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

/** The captured IQN (authority `dev.anas.gtiscsi` — NOT ANAS's). */
const FOREIGN_IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'
/** The same target with an ANAS naming authority. */
const GT_IQN = 'iqn.2026-08.dev.gtiscsi.anas:target1'
const ZVOL_PATH = '/dev/zvol/gtiscsi/vol1'
const SERIAL = '9bc6e907-6015-4267-be4f-5a0617cb3d71'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/** The capture replayed with an ANAS naming authority (ownership is the only axis). */
function asAnasOwned(text: string): string {
  return text.split(FOREIGN_IQN).join(GT_IQN)
}

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string, attempts = 100, delayMs = 10): Promise<Job> {
  for (let i = 0; i < attempts; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error(`Job ${id} did not finish`)
}

function jobIdFrom(res: { json: () => unknown }): string {
  const { job } = res.json() as { job?: { id: string } }
  assert.ok(job?.id, 'expected a job ref')
  return job.id
}

describe('backup task kind (backup2.9) — list read model + the block-id guard', () => {
  let dir: string
  let server: ReturnType<typeof createServer>
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backup-kind-'))
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_STORAGE_CFG', join(dir, 'absent-storage.cfg'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    await mkdir(join(dir, 'priv-storage'), { recursive: true })
  })

  /**
   * The iSCSI seams are read from the environment at createServer time, so the
   * server starts AFTER the capture is in place.
   */
  async function startServer(): Promise<void> {
    server = createServer({ mock: true, logger: false })
    const mock = mockOf(server)
    mock.addFixture({ command: '/usr/bin/systemctl', result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/systemd-analyze', result: { stdout: 'Normalized form: *-*-* 02:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: '/usr/bin/journalctl', result: { stdout: '', stderr: '', exitCode: 0 } })
  }

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else process.env[k] = v
    }
  })

  /** Point the iSCSI read layer at a materialised capture. */
  async function serveIscsi(manifest: string): Promise<void> {
    const root = join(dir, 'target')
    await materializeConfigfsManifest(manifest, root)
    process.env.ANAS_ISCSI_CONFIGFS = root
    const saveconfig = join(dir, 'saveconfig.json')
    await writeFile(saveconfig, asAnasOwned(loadFixture('saveconfig-final.json')))
    process.env.ANAS_ISCSI_SAVECONFIG = saveconfig
    process.env.ANAS_ISCSI_SYS_BLOCK = join(dir, 'block')
    await mkdir(join(dir, 'block', 'zd16'), { recursive: true })
    await writeFile(join(dir, 'block', 'zd16', 'size'), '4194304\n')
  }

  const REPO = {
    name: 'pbs-main',
    host: '127.0.0.1',
    port: 8007,
    datastore: 'store1',
    authType: 'token' as const,
    tokenId: 'root@pam!anas',
    fingerprint: 'cc:b8:a0',
    secret: 'token-secret-value',
  }

  async function createRepo(): Promise<void> {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo: REPO, expectedVersion: 0 } })
    assert.equal(res.statusCode, 202)
    assert.equal((await waitForJob(server, jobIdFrom(res))).status, 'completed')
  }

  async function postTask(payload: Record<string, unknown>): Promise<number> {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/tasks', headers: JSON_HEADERS, payload })
    if (res.statusCode !== 202)
      return res.statusCode
    const job = await waitForJob(server, jobIdFrom(res))
    assert.equal(job.status, 'completed', JSON.stringify(job))
    return 202
  }

  function errorMessage(status: number, res: { json: () => unknown }): string {
    const body = res.json() as { error?: { message?: string } }
    return `status ${status}: ${body.error?.message ?? JSON.stringify(body)}`
  }

  /** The one block-task shape the wizard writes: kind, `disk`, the record, the serial id. */
  function blockTask(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name,
      repository: 'pbs-main',
      backupId: lunBackupId(SERIAL),
      kind: 'block',
      archives: [{ name: 'disk', path: ZVOL_PATH, excludes: [], kind: 'img', lun: { targetIqn: GT_IQN, index: 0 } }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
      ...over,
    }
  }

  it('a block task with the LUN serial id is accepted; the list carries kind + the live LUN name', async () => {
    await serveIscsi(asAnasOwned(loadFixture('configfs-live.manifest')))
    await startServer()
    await createRepo()
    assert.equal(await postTask(blockTask('lun-one')), 202)

    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskEntry[] }
    const entry = data.find(e => e.task.name === 'lun-one')!
    assert.equal(entry.task.kind, 'block')
    assert.equal(entry.task.legacyImgArchives, false)
    // The name is read LIVE off the read layer — it is display-only and never
    // stored in the unit.
    assert.equal(entry.lunName, 'gtiscsi_vol1')
  })

  it('a pre-backup2.9 single-image task derives as block, with the live LUN name and its STORED id untouched', async () => {
    await serveIscsi(asAnasOwned(loadFixture('configfs-live.manifest')))
    await startServer()
    await createRepo()
    // The operator's first LUN backup (2026-08-26): one img archive + record,
    // no task kind, a hand-chosen backup id. It keeps its stored id and group.
    assert.equal(await postTask({
      name: 'legacy-lun',
      repository: 'pbs-main',
      backupId: 'vmstore',
      archives: [{ name: 'lun0', path: ZVOL_PATH, excludes: [], kind: 'img', lun: { targetIqn: GT_IQN, index: 0 } }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }), 202)

    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskEntry[] }
    const entry = data.find(e => e.task.name === 'legacy-lun')!
    // The view carries the STORED kind — absent here, exactly as on the wire a
    // pre-backup2.9 task's archive kind is absent. The effective answer is the
    // client's derivation through the shared helper (the edit dialog asks it to
    // decide whether a save may send `kind` back).
    assert.equal(entry.task.kind, undefined)
    assert.equal(effectiveTaskKind(entry.task).kind, 'block')
    assert.equal(entry.task.legacyImgArchives, false)
    assert.equal(entry.lunName, 'gtiscsi_vol1')
    assert.equal(entry.task.backupId, 'vmstore') // the stored id is never rewritten
  })

  it('a mixed legacy task reads as files with the legacy flag, and no LUN name at all', async () => {
    await serveIscsi(asAnasOwned(loadFixture('configfs-live.manifest')))
    await startServer()
    await createRepo()
    assert.equal(await postTask({
      name: 'legacy-mixed',
      repository: 'pbs-main',
      backupId: 'mixed',
      archives: [
        { name: 'etc', path: '/etc', excludes: [] },
        { name: 'lun0', path: ZVOL_PATH, excludes: [], kind: 'img', lun: { targetIqn: GT_IQN, index: 0 } },
      ],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }), 202)

    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskEntry[] }
    const entry = data.find(e => e.task.name === 'legacy-mixed')!
    assert.equal(entry.task.kind, undefined) // derived files — the unit stores nothing
    assert.equal(effectiveTaskKind(entry.task).kind, 'files')
    assert.equal(entry.task.legacyImgArchives, true)
    assert.equal('lunName' in entry, false) // files tasks do not carry the key
  })

  it('a plain files task derives as files and carries no LUN name', async () => {
    await serveIscsi(asAnasOwned(loadFixture('configfs-live.manifest')))
    await startServer()
    await createRepo()
    assert.equal(await postTask({
      name: 'plain-files',
      repository: 'pbs-main',
      backupId: 'files',
      archives: [{ name: 'etc', path: '/etc', excludes: [] }],
      schedule: '*-*-* 02:00:00',
      enabled: true,
    }), 202)

    const res = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = res.json() as { data: BackupTaskEntry[] }
    const entry = data.find(e => e.task.name === 'plain-files')!
    assert.equal(entry.task.kind, undefined) // derived files — the unit stores nothing
    assert.equal(effectiveTaskKind(entry.task).kind, 'files')
    assert.equal(entry.task.legacyImgArchives, false)
    assert.equal('lunName' in entry, false)
  })

  it('a block task whose id does not match the LUN serial is a 400 naming the required id', async () => {
    await serveIscsi(asAnasOwned(loadFixture('configfs-live.manifest')))
    await startServer()
    await createRepo()

    const post = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: blockTask('lun-wrong', { backupId: 'lun-ffffffff-0000-0000-0000-000000000000' }),
    })
    assert.equal(post.statusCode, 400, errorMessage(post.statusCode, post))
    assert.match(errorMessage(post.statusCode, post), new RegExp(`lun-${SERIAL}`))
    assert.match(errorMessage(post.statusCode, post), /one PBS group/)

    // …and the guard is on the EDIT path too: create a good one, then try to
    // move its group.
    assert.equal(await postTask(blockTask('lun-good')), 202)
    const put = await server.inject({
      method: 'PUT',
      url: '/v1/backup/tasks/lun-good',
      headers: JSON_HEADERS,
      payload: blockTask('lun-good', { backupId: 'renamed-group' }),
    })
    assert.equal(put.statusCode, 400, errorMessage(put.statusCode, put))
    assert.match(errorMessage(put.statusCode, put), new RegExp(`lun-${SERIAL}`))
  })

  it('a block task whose LUN is not served by this node is a 400 pointing at the picker', async () => {
    await serveIscsi(asAnasOwned(loadFixture('configfs-live.manifest')))
    await startServer()
    await createRepo()

    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks',
      headers: JSON_HEADERS,
      payload: blockTask('lun-ghost', {
        archives: [{ name: 'disk', path: ZVOL_PATH, excludes: [], kind: 'img', lun: { targetIqn: GT_IQN, index: 5 } }],
      }),
    })
    assert.equal(res.statusCode, 400, errorMessage(res.statusCode, res))
    assert.match(errorMessage(res.statusCode, res), /not served by this node/i)
    assert.match(errorMessage(res.statusCode, res), /LUN picker/i)
  })

  it('a block task for a LUN whose serial cannot be read is accepted — the read layer cannot verify', async () => {
    // The capture with the zvol's `wwn/vpd_unit_serial` removed: the LUN is
    // served, its serial is `null`, so no id can be checked against it. The
    // guard is fail-open in exactly the same direction the list's
    // `lunName: null` is. The read layer's serial has a fallback to the
    // PERSISTED `wwn` in saveconfig (GT-19: a reboot preserves identity), so
    // that one goes too — otherwise the guard still has a serial to verify.
    const manifestNoSerial = asAnasOwned(loadFixture('configfs-live.manifest'))
      .split('F core/iblock_0/gtiscsi_vol1/wwn/vpd_unit_serial = T10 VPD Unit Serial Number: 9bc6e907-6015-4267-be4f-5a0617cb3d71\n')
      .join('')
    assert.notEqual(manifestNoSerial, asAnasOwned(loadFixture('configfs-live.manifest')))
    await serveIscsi(manifestNoSerial)
    const save = JSON.parse(asAnasOwned(loadFixture('saveconfig-final.json'))) as { storage_objects: Array<{ name?: string, wwn?: string }> }
    const bs = save.storage_objects.find(b => b.name === 'gtiscsi_vol1')
    assert.ok(bs, 'the zvol backstore is in the saveconfig capture')
    delete bs.wwn
    await writeFile(join(dir, 'saveconfig.json'), JSON.stringify(save, null, 2))
    await startServer()
    await createRepo()

    assert.equal(await postTask(blockTask('lun-noserial', { backupId: 'lun-unverifiable' })), 202)

    const list = await server.inject({ method: 'GET', url: '/v1/backup/tasks', headers: IDENTITY })
    const { data } = list.json() as { data: BackupTaskEntry[] }
    const entry = data.find(e => e.task.name === 'lun-noserial')!
    assert.equal(entry.task.kind, 'block')
    // The LUN resolves (its name comes from `product_id`), but the serial is
    // unreadable — the list says so with a null.
    assert.equal(entry.lunName, 'gtiscsi_vol1')
  })
})
