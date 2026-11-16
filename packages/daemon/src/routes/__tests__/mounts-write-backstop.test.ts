/**
 * The duplicate-line refusal INSIDE the write (`editMountLine`): the door's
 * gate passes because the mountpoint is on one line when the request is made;
 * a second line appears after the job's gates have re-read the fstab and
 * before the write. The test holds the fstab's own file lock so the job waits
 * at the write, appends the line, and lets go.
 */
import type { Job, JobAccepted } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { disableMount, linesFor } from '../../parsers/fstab.js'
import { createServer } from '../../server.js'
import { withFileLock } from '../../services/file-lock.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }
const enc = (path: string): string => encodeURIComponent(path)

const FSTAB_FIXTURE = readFileSync(join(__dirname, '../../fixtures/mounts/fstab-anas-managed'), 'utf-8')
const FINDMNT_FULL = readFileSync(join(__dirname, '../../fixtures/mounts/findmnt-full.json'), 'utf-8')
const STORAGE_CFG = join(__dirname, '../../fixtures/mounts/storage.cfg')

/** The duplicate-line sentence, as `duplicateKeySentence` spells it. */
function sentence(key: string, lines: number[]): string {
  const list = lines.length <= 2 ? lines.join(' and ') : `${lines.slice(0, -1).join(', ')} and ${lines.at(-1)}`
  return `${key} is on lines ${list} of /etc/fstab. ANAS changes one line for a path. Remove the line you do not want, then try again.`
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 500; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('the write-time duplicate backstop, reached with a second line added after the gate', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
    delete process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR
    await rm(dir, { recursive: true, force: true })
  })

  async function run(verb: 'put' | 'enable' | 'disable' | 'delete'): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), 'anas-mounts-backstop-'))
    const mountBase = join(dir, 'mnt')
    const mp = join(mountBase, 'anas-nfs')
    await mkdir(mp, { recursive: true })
    await mkdir(join(mountBase, 'anas-cifs'), { recursive: true })
    const mapped = FSTAB_FIXTURE
      .replaceAll('/mnt/anas-nfs', mp)
      .replaceAll('/mnt/anas-cifs', join(mountBase, 'anas-cifs'))
    const fstabPath = join(dir, 'fstab')
    // enable needs the line disabled at the door; every other verb a live one.
    await writeFile(fstabPath, verb === 'enable' ? disableMount(mapped, mp) : mapped)
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = STORAGE_CFG
    process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = join(dir, 'run')
    server = createServer({ mock: true, logger: false })
    ;(server as unknown as { executor: MockExecutor }).executor.prependFixture({
      command: '/usr/bin/findmnt',
      args: ['--json'],
      result: { stdout: FINDMNT_FULL.replaceAll('/mnt/anas-nfs', mp).replaceAll('/mnt/anas-cifs', join(mountBase, 'anas-cifs')), stderr: '', exitCode: 0 },
    })

    // The line a job wrote; also the second line appended later.
    const line = mapped.split('\n').find(l => l.includes(mp))!

    // Hold the fstab's own lock: the job blocks at editConfig's read, after its
    // guard has re-read the file, before the transform sees the text.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = withFileLock(fstabPath, () => held)

    const send = async (method: 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown): Promise<Awaited<ReturnType<ReturnType<typeof createServer>['inject']>>> => {
      let res = await server!.inject({ method, url, headers: payload === undefined ? IDENTITY_HEADERS : JSON_HEADERS, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) })
      if (res.statusCode === 409 && (res.json() as { error: { code: string } }).error.code === 'CONFIRMATION_REQUIRED') {
        const code = res.headers['x-anas-confirm-code'] as string
        res = await server!.inject({ method, url, headers: { ...(payload === undefined ? IDENTITY_HEADERS : JSON_HEADERS), 'x-anas-confirm': code }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) })
      }
      return res
    }

    const markers: Record<typeof verb, string> = {
      put: 'Rewriting /etc/fstab entry',
      enable: `Enabling ${mp} in /etc/fstab`,
      disable: `Disabling ${mp} in /etc/fstab`,
      delete: 'Removing /etc/fstab entry',
    }
    const accepted = verb === 'put'
      ? await send('PUT', `/v1/mounts/${enc(mp)}`, { options: { ro: true } })
      : verb === 'delete'
        ? await send('DELETE', `/v1/mounts/${enc(mp)}`)
        : await send('POST', `/v1/mounts/${enc(mp)}/state`, { action: verb })
    assert.equal(accepted.statusCode, 202, `${verb}: ${accepted.payload}`)
    const jobId = (accepted.json() as JobAccepted).job.id

    // Wait until the job stands at the progress line just before the write; it
    // cannot pass it while we hold the lock.
    let seen = false
    for (let i = 0; i < 500 && !seen; i++) {
      const res = await server.inject({ method: 'GET', url: `/v1/jobs/${jobId}`, headers: IDENTITY_HEADERS })
      const { job } = res.json() as { job: Job }
      seen = (job.progress ?? '').includes(markers[verb])
      if (!seen)
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(seen, `${verb}: the job never reached "${markers[verb]}" (it was blocked or failed earlier)`)

    const appended = `${await readFile(fstabPath, 'utf8')}${line}\n`
    await writeFile(fstabPath, appended)
    release()
    await holding

    const job = await waitForJob(server, jobId)
    const lines = linesFor(appended, mp)
    assert.equal(lines.length, 2, `${verb}: the append made two lines`)
    assert.equal(job.status, 'failed', `${verb}: ${JSON.stringify(job)}`)
    assert.equal(job.error?.code, 'CONFLICT', `${verb}: ${JSON.stringify(job.error)}`)
    assert.equal(job.error?.message, sentence(mp, lines), `${verb}: ${JSON.stringify(job.error)}`)
    // The refusal wrote nothing: the file keeps exactly the bytes after the append.
    assert.equal(await readFile(fstabPath, 'utf8'), appended, `${verb}: the refusal changed the file`)
  }

  it('PUT: refuses at the write with the sentence, the file keeps its bytes', async () => {
    await run('put')
  })

  it('enable: refuses at the write with the sentence, the file keeps its bytes', async () => {
    await run('enable')
  })

  it('disable: refuses at the write with the sentence, the file keeps its bytes', async () => {
    await run('disable')
  })

  it('DELETE: refuses at the write with the sentence, the file keeps its bytes', async () => {
    await run('delete')
  })
})
