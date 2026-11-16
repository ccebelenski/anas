/**
 * cr4.conf D-2 / D-21 — one rule for both config files: a key (the exported
 * path, the mountpoint) that appears on more than one line. The first-match
 * editors rewrite ONE line and report success while the other line still
 * exports the path / still mounts it at boot.
 *
 * /etc/fstab refuses every verb. /etc/exports allows a path on several lines
 * (different clients), so there the EDIT refuses and the DELETE removes every
 * line; the list shows one row per path with all its clients. Both files'
 * reads carry the same sentence with the same line numbers.
 */
import type { Job, JobAccepted, MountDetail, MountSummary, NfsExport } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { disableMount } from '../../parsers/fstab.js'
import { createServer } from '../../server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

function enc(path: string): string {
  return encodeURIComponent(path)
}

/** The line numbers (1-based, as `grep -n` counts) of every line matching. */
function lineNumbers(text: string, match: (line: string) => boolean): number[] {
  const out: number[] = []
  text.split('\n').forEach((line, i) => {
    if (match(line))
      out.push(i + 1)
  })
  return out
}

/** The rule's sentence, spelled out here so the tests pin the exact prose. */
function sentence(key: string, lines: number[], file: string, rule: 'fstab' | 'exports' = 'fstab'): string {
  const middle = rule === 'exports'
    ? 'ANAS edits an export that is on one line. Merge those lines into one by hand, then try again.'
    : 'ANAS changes one line for a path. Remove the line you do not want, then try again.'
  return `${key} is on lines ${lines.join(' and ')} of ${file}. ${middle}`
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY_HEADERS })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed')
      return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

// ---------------------------------------------------------------------------
// /etc/exports (D-2)
// ---------------------------------------------------------------------------

describe('nfs exports: a path on two lines (cr4.conf D-2)', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let exportsPath: string

  // The same path exported twice: line 3 and line 6 of this capture-shaped file.
  const DUP_EXPORTS = [
    '# ANAS-managed NFS exports',
    '',
    '/srv/nfs/media    192.168.1.0/24(rw,sync,no_subtree_check)',
    '/srv/nfs/backups  *(ro,sync,no_subtree_check,root_squash)',
    '',
    '/srv/nfs/media    10.0.0.5(ro,sync)',
    '',
  ].join('\n')
  const SENTENCE = sentence('/srv/nfs/media', [3, 6], '/etc/exports', 'exports')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr4conf-nfs-'))
    exportsPath = join(dir, 'exports')
    await writeFile(exportsPath, DUP_EXPORTS)
    process.env.ANAS_EXPORTS_PATH = exportsPath
    server = createServer({ mock: true, logger: false })
    // The delete's job runs the baseline and reload `exportfs -ra`.
    ;(server as unknown as { executor: MockExecutor }).executor.prependFixture({
      command: '/usr/sbin/exportfs',
      args: ['-ra'],
      result: { stdout: '', stderr: '', exitCode: 0 },
    })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_EXPORTS_PATH
    await rm(dir, { recursive: true, force: true })
  })

  describe('the reads keep working and say it', () => {
    it('the list returns ONE row per path, its clients from every line, and the warning', async () => {
      const res = await server!.inject({ method: 'GET', url: '/v1/shares/nfs', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: NfsExport[] }
      const dup = data.filter(e => e.path === '/srv/nfs/media')
      assert.equal(dup.length, 1)
      assert.deepEqual(
        dup[0].clients.map(c => c.spec),
        ['192.168.1.0/24', '10.0.0.5'],
      )
      assert.deepEqual(dup[0].warnings, [SENTENCE])
      // A path on one line carries nothing.
      const single = data.find(e => e.path === '/srv/nfs/backups')!
      assert.equal(single.warnings, undefined)
    })

    it('the detail carries the folded clients and the warning', async () => {
      const res = await server!.inject({ method: 'GET', url: `/v1/shares/nfs/${enc('/srv/nfs/media')}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: NfsExport }
      assert.deepEqual(data.clients.map(c => c.spec), ['192.168.1.0/24', '10.0.0.5'])
      assert.deepEqual(data.warnings, [SENTENCE])
    })
  })

  describe('the verbs', () => {
    it('PUT refuses 409 with the sentence and leaves the file byte-identical', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/shares/nfs/${enc('/srv/nfs/media')}`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ clients: [{ spec: '172.16.0.0/12', options: ['rw', 'async'] }] }),
      })
      assert.equal(res.statusCode, 409, res.payload)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.equal(res.json().error.message, SENTENCE)
      assert.equal(await readFile(exportsPath, 'utf8'), before)
    })

    it('DELETE asks for a confirm that names every line and its clients', async () => {
      const before = await readFile(exportsPath, 'utf8')
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/srv/nfs/media')}`,
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409, res.payload)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      const warnings = res.json().error.warnings as string[]
      assert.ok(warnings.includes('Line 3: 192.168.1.0/24(rw,sync,no_subtree_check)'), warnings.join('\n'))
      assert.ok(warnings.includes('Line 6: 10.0.0.5(ro,sync)'), warnings.join('\n'))
      assert.ok(res.headers['x-anas-confirm-code'])
      assert.equal(await readFile(exportsPath, 'utf8'), before)
    })

    it('DELETE confirmed removes EVERY line for the path and reports how many', async () => {
      const first = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/srv/nfs/media')}`,
        headers: IDENTITY_HEADERS,
      })
      const code = first.headers['x-anas-confirm-code'] as string
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/srv/nfs/media')}`,
        headers: { ...IDENTITY_HEADERS, 'x-anas-confirm': code },
      })
      assert.equal(res.statusCode, 202, res.payload)
      const { job: accepted } = res.json() as JobAccepted
      const job = await waitForJob(server!, accepted.id)
      assert.equal(job.status, 'completed')
      assert.deepEqual(job.result, { removed: '/srv/nfs/media', lines: 2 })
      const after = await readFile(exportsPath, 'utf8')
      assert.equal(after.split('\n').filter(l => l.includes('/srv/nfs/media')).length, 0)
      assert.ok(after.includes('/srv/nfs/backups'))
    })

    it('a path on ONE line still gets the ordinary confirm challenge', async () => {
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/shares/nfs/${enc('/srv/nfs/backups')}`,
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
    })
  })
})

// ---------------------------------------------------------------------------
// /etc/fstab (D-21)
// ---------------------------------------------------------------------------

describe('mounts: a mountpoint on two fstab lines (cr4.conf D-21)', () => {
  const FSTAB_FIXTURE = readFileSync(join(__dirname, '../../fixtures/mounts/fstab-anas-managed'), 'utf-8')
  const STORAGE_CFG = join(__dirname, '../../fixtures/mounts/storage.cfg')

  let server: ReturnType<typeof createServer> | undefined
  let dir: string
  let mountBase: string
  let fstabPath: string
  let nfsMp: string
  let sent: string

  /** Map a fixture `/mnt/<x>` mountpoint to `<mountBase>/<x>` (a real dir). */
  const MP = (mp: string): string => (mp.startsWith('/mnt/') ? join(mountBase, mp.replace(/^\/mnt\//, '')) : mp)

  /** The managed fixture with the anas-nfs line DUPLICATED at the end. */
  function duplicateFstab(): string {
    const mapped = FSTAB_FIXTURE
      .replaceAll('/mnt/anas-nfs', MP('/mnt/anas-nfs'))
      .replaceAll('/mnt/anas-cifs', MP('/mnt/anas-cifs'))
    const first = mapped.split('\n').find(l => l.includes(MP('/mnt/anas-nfs')))!
    return `${mapped}${first}\n`
  }

  async function writeFstab(text: string): Promise<void> {
    await writeFile(fstabPath, text)
    const lines = lineNumbers(text, l => l.includes(nfsMp))
    assert.equal(lines.length, 2)
    sent = sentence(nfsMp, lines, '/etc/fstab')
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr4conf-mounts-'))
    mountBase = join(dir, 'mnt')
    // A mocked mount through this mountpoint needs a real directory (cr.52r D3
    // pins the final dir before the syscall); the duplicate stays on the same
    // device so the foreign-live-mount check stays out of the way.
    nfsMp = MP('/mnt/anas-nfs')
    await mkdir(nfsMp, { recursive: true })
    await mkdir(MP('/mnt/anas-cifs'), { recursive: true })
    fstabPath = join(dir, 'fstab')
    await writeFstab(duplicateFstab())
    process.env.ANAS_FSTAB_PATH = fstabPath
    process.env.ANAS_CREDS_DIR = join(dir, 'creds')
    process.env.ANAS_STORAGE_CFG = STORAGE_CFG
    process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR = join(dir, 'run')
    server = createServer({ mock: true, logger: false })
    // The inventory JOIN needs the live-mount side mapped the same way.
    const findmntFull = readFileSync(join(__dirname, '../../fixtures/mounts/findmnt-full.json'), 'utf8')
      .replaceAll('/mnt/anas-nfs', MP('/mnt/anas-nfs'))
      .replaceAll('/mnt/anas-cifs', MP('/mnt/anas-cifs'))
    ;(server as unknown as { executor: MockExecutor }).executor.prependFixture({
      command: '/usr/bin/findmnt',
      args: ['--json'],
      result: { stdout: findmntFull, stderr: '', exitCode: 0 },
    })
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    delete process.env.ANAS_FSTAB_PATH
    delete process.env.ANAS_CREDS_DIR
    delete process.env.ANAS_STORAGE_CFG
    delete process.env.ANAS_MOUNT_PROBE_RUNTIME_DIR
    await rm(dir, { recursive: true, force: true })
  })

  describe('the reads keep working and say it', () => {
    it('the inventory row carries the line-number warning', async () => {
      const res = await server!.inject({ method: 'GET', url: '/v1/mounts', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: MountSummary[] }
      const dup = data.find(r => r.mountpoint === nfsMp)!
      assert.ok(dup.warnings?.includes(sent), JSON.stringify(dup.warnings))
      // A mountpoint on one line carries nothing.
      const single = data.find(r => r.mountpoint === MP('/mnt/anas-cifs'))!
      assert.equal(single.warnings, undefined)
    })

    it('the detail carries it too', async () => {
      const res = await server!.inject({ method: 'GET', url: `/v1/mounts/${enc(nfsMp)}`, headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: MountDetail }
      assert.ok(data.warnings.includes(sent), JSON.stringify(data.warnings))
    })

    it('a second line spelled with a trailing slash is the same mountpoint and warns', async () => {
      const base = FSTAB_FIXTURE
        .replaceAll('/mnt/anas-nfs', MP('/mnt/anas-nfs'))
        .replaceAll('/mnt/anas-cifs', MP('/mnt/anas-cifs'))
      const line = base.split('\n').find(l => l.includes(nfsMp))!
      const slashed = line.replace(nfsMp, `${nfsMp}/`)
      await writeFstab(`${base}${slashed}\n`)
      const res = await server!.inject({ method: 'GET', url: '/v1/mounts', headers: IDENTITY_HEADERS })
      assert.equal(res.statusCode, 200)
      const { data } = res.json() as { data: MountSummary[] }
      const dup = data.find(r => r.mountpoint === nfsMp)!
      assert.ok(dup.warnings?.includes(sent), JSON.stringify(dup.warnings))
    })
  })

  describe('the verbs refuse at the door', () => {
    it('PUT refuses 409 with the sentence and leaves /etc/fstab byte-identical', async () => {
      const before = await readFile(fstabPath, 'utf8')
      const res = await server!.inject({
        method: 'PUT',
        url: `/v1/mounts/${enc(nfsMp)}`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ options: { ro: true } }),
      })
      assert.equal(res.statusCode, 409, res.payload)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.equal(res.json().error.message, sent)
      assert.equal(await readFile(fstabPath, 'utf8'), before)
    })

    it('action disable refuses 409 and changes nothing', async () => {
      const before = await readFile(fstabPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: `/v1/mounts/${enc(nfsMp)}/state`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ action: 'disable' }),
      })
      assert.equal(res.statusCode, 409, res.payload)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.equal(res.json().error.message, sent)
      assert.equal(await readFile(fstabPath, 'utf8'), before)
    })

    it('action enable refuses while both lines sit disabled', async () => {
      // Disable EVERY line for the mountpoint first (the current editor already
      // touches both), then ask ANAS to re-enable it — one line for a path.
      const bothDisabled = disableMount(await readFile(fstabPath, 'utf8'), nfsMp)
      assert.equal(bothDisabled.split('\n').filter(l => l.includes(nfsMp)).length, 2)
      await writeFstab(bothDisabled)
      const before = await readFile(fstabPath, 'utf8')
      const res = await server!.inject({
        method: 'POST',
        url: `/v1/mounts/${enc(nfsMp)}/state`,
        headers: JSON_HEADERS,
        payload: JSON.stringify({ action: 'enable' }),
      })
      assert.equal(res.statusCode, 409, res.payload)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.equal(res.json().error.message, sent)
      assert.equal(await readFile(fstabPath, 'utf8'), before)
    })

    it('DELETE refuses 409 with the sentence, mints no confirm, changes nothing', async () => {
      const before = await readFile(fstabPath, 'utf8')
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/mounts/${enc(nfsMp)}`,
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409, res.payload)
      assert.equal(res.json().error.code, 'CONFLICT')
      assert.equal(res.json().error.message, sent)
      assert.equal(res.headers['x-anas-confirm-code'], undefined)
      assert.equal(await readFile(fstabPath, 'utf8'), before)
    })

    it('a mountpoint on ONE line still gets the ordinary confirm challenge', async () => {
      const res = await server!.inject({
        method: 'DELETE',
        url: `/v1/mounts/${enc(MP('/mnt/anas-cifs'))}`,
        headers: IDENTITY_HEADERS,
      })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().error.code, 'CONFIRMATION_REQUIRED')
      assert.ok(res.headers['x-anas-confirm-code'])
    })
  })
})
