import type { Job, JobAccepted } from '@anas/shared'
import type { ExecResult } from '../../executor/types.js'
import type { JobQueue } from '../../jobs/queue.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CreateNfsExportRequest } from '@anas/shared'
import { addExport, hasExport, removeExport } from '../../parsers/exports.js'
import { createServer } from '../../server.js'

/**
 * Story cr.43 — the NFS export verbs on the guard (docs/WAVE3-DESIGN.md §2.5,
 * §3, §4.2, ruling (j)). The H8 property: a state that refuses at the route
 * but becomes true only AFTER the request was accepted — while the job waits
 * in the queue — refuses the job, and the mock executor shows no mutating
 * argv (`exportfs -ra`, not even the cr.13 baseline) and exports keeps its
 * bytes.
 *
 * The job is held in the REAL queue: four placeholder jobs fill the four
 * slots, the request is accepted behind them (`queued`), the test changes the
 * file, then releases the slots.
 *
 * FIXTURES (ruling (l): fakes serve captured output): `nfs/etc-exports`; a
 * vanished export is the daemon's own `removeExport` of the line, a hand edit
 * one token changed in a captured line.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../../fixtures')
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

const EXPORTFS = '/usr/sbin/exportfs'

const EXPORT = '/srv/nfs/media'
const EXPORT_NOT_FOUND = `Export '${EXPORT}' not found`

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY_HEADERS, 'content-type': 'application/json' }

/** Replace exactly one occurrence of `from` in a capture. */
function rewrite(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `capture has no single '${from}'`)
  return text.replace(from, to)
}

const EXPORTS = fixture('nfs/etc-exports')
/** The media line as an operator hand-edited it (one client flipped to rw). */
const EXPORTS_HAND_EDITED = rewrite(EXPORTS, '10.0.0.5(ro,sync,no_subtree_check)', '10.0.0.5(rw,sync,no_subtree_check)')

/** A call that would mean an NFS verb acted on the node. */
function isMutation(c: { command: string, args: string[] }): boolean {
  return c.command === EXPORTFS
}

const ENV_KEYS = ['ANAS_EXPORTS_PATH'] as const

describe('cr.43 — NFS export verbs re-gate in the job (ruling (j))', () => {
  let dir: string
  let exportsPath: string
  let server: ReturnType<typeof createServer> | undefined
  let calls: { command: string, args: string[] }[] = []
  /** A command that does not return until the test releases it. */
  const paused = new Map<string, Promise<void>>()
  const saved: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr43-nfs-'))
    exportsPath = join(dir, 'exports')
    for (const key of ENV_KEYS)
      saved[key] = process.env[key]
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined)
        delete process.env[key]
      else
        process.env[key] = saved[key]
    }
  })

  /** The dev mock over a private copy of the capture; commands can pause. */
  async function serve(exports = EXPORTS): Promise<void> {
    paused.clear()
    await writeFile(exportsPath, exports)
    process.env.ANAS_EXPORTS_PATH = exportsPath
    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: { exec: (c: string, a: string[], o?: unknown) => Promise<ExecResult> } }).executor
    const orig = mock.exec.bind(mock)
    calls = []
    mock.exec = async (command, args, opts) => {
      calls.push({ command, args })
      const hold = paused.get(command)
      if (hold)
        await hold
      return orig(command, args, opts)
    }
    await server.ready()
  }

  function queue(): JobQueue {
    return (server as unknown as { jobQueue: JobQueue }).jobQueue
  }

  /** Fill the four slots; the next accepted job waits `queued` until the release. */
  function holdSlots(): () => void {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    for (let i = 0; i < 4; i++)
      queue().submit('test.hold', { user: 'test', uid: 0 }, () => held)
    return release
  }

  interface Req { method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown }

  function send(req: Req, code?: string) {
    return server!.inject({
      method: req.method,
      url: req.url,
      headers: { ...(req.payload === undefined ? IDENTITY_HEADERS : JSON_HEADERS), ...(code ? { 'x-anas-confirm': code } : {}) },
      ...(req.payload === undefined ? {} : { payload: JSON.stringify(req.payload) }),
    })
  }

  /** Send; answer a 409 confirm challenge with its code; return the accepted job's id. */
  async function accepted(req: Req): Promise<string> {
    let res = await send(req)
    if (res.statusCode === 409 && res.headers['x-anas-confirm-code'])
      res = await send(req, res.headers['x-anas-confirm-code'] as string)
    assert.equal(res.statusCode, 202, res.body)
    return (res.json() as JobAccepted).job.id
  }

  /** Accept the request while the four slots are held: it waits `queued`. */
  async function acceptedBehindFullQueue(req: Req): Promise<{ id: string, release: () => void }> {
    const release = holdSlots()
    const id = await accepted(req)
    assert.equal(queue().get(id)?.status, 'queued', 'the accepted job waits behind the held slots')
    return { id, release }
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

  /** Wait until a condition holds (a paused command has been reached). */
  async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (cond())
        return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`condition never became true: ${what}`)
  }

  const create = (body: Record<string, unknown>): Req => ({ method: 'POST', url: '/v1/shares/nfs', payload: body })
  const update = (path: string, body: Record<string, unknown>): Req => ({ method: 'PUT', url: `/v1/shares/nfs/${encodeURIComponent(path)}`, payload: body })
  const remove = (path: string): Req => ({ method: 'DELETE', url: `/v1/shares/nfs/${encodeURIComponent(path)}` })
  const edit = { clients: [{ spec: '172.16.0.0/12', options: ['rw', 'async'] }] }

  // -------------------------------------------------------------------------
  // The harness acts when nothing changes
  // -------------------------------------------------------------------------

  it('control: with nothing changed the held edit and remove run and reload — the harness does not refuse on its own', async () => {
    for (const req of [update(EXPORT, edit), remove('/srv/nfs/backups')]) {
      await serve()
      const { id, release } = await acceptedBehindFullQueue(req)
      release()
      const job = await finished(id)
      assert.equal(job.status, 'completed', `${req.method} ${req.url}: ${JSON.stringify(job.error)}`)
      assert.ok(calls.some(isMutation), `${req.method} ${req.url} reloaded the exports table`)
      await server!.close()
      server = undefined
    }
  })

  // -------------------------------------------------------------------------
  // Item 1: the vanished export — the update
  // -------------------------------------------------------------------------

  it('an edit whose line is removed while it waits fails NOT_FOUND — not even the baseline reload runs, the file keeps the vanished bytes', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(update(EXPORT, edit))
    // An operator deletes the export (the daemon's own editor) while the job waits.
    const vanished = removeExport(await readFile(exportsPath, 'utf8'), EXPORT)
    await writeFile(exportsPath, vanished)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'NOT_FOUND', JSON.stringify(job.error))
    assert.equal(job.error?.message, EXPORT_NOT_FOUND)
    assert.deepEqual(calls.filter(isMutation), [], 'exportfs never ran — the refused job does not even take the cr.13 baseline')
    assert.equal(await readFile(exportsPath, 'utf8'), vanished, 'exports untouched by the refused job')
  })

  it('an edit whose line is hand-edited while it waits fails STATE_CHANGED — the hand edit survives, nothing written', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(update(EXPORT, edit))
    await writeFile(exportsPath, EXPORTS_HAND_EDITED)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'STATE_CHANGED', JSON.stringify(job.error))
    assert.equal(job.error?.message, `NFS export ${EXPORT} changed since you confirmed — nothing was done; reload and confirm again`)
    assert.deepEqual(calls.filter(isMutation), [], 'exportfs never ran')
    assert.equal(await readFile(exportsPath, 'utf8'), EXPORTS_HAND_EDITED, 'the operator\'s edit is not overwritten by a merge of the old line')
  })

  // -------------------------------------------------------------------------
  // Item 1: the vanished export — the remove
  // -------------------------------------------------------------------------

  it('a remove whose line is deleted after the confirm fails NOT_FOUND — no reload, the file keeps the vanished bytes', async () => {
    await serve()
    const { id, release } = await acceptedBehindFullQueue(remove(EXPORT))
    // The line goes after the confirm rode and while the job waits.
    const vanished = removeExport(await readFile(exportsPath, 'utf8'), EXPORT)
    await writeFile(exportsPath, vanished)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'NOT_FOUND', JSON.stringify(job.error))
    assert.equal(job.error?.message, EXPORT_NOT_FOUND)
    assert.deepEqual(calls.filter(isMutation), [], 'exportfs never ran')
    assert.equal(await readFile(exportsPath, 'utf8'), vanished, 'exports untouched by the refused job')
  })

  // -------------------------------------------------------------------------
  // Item 2: the duplicate — the create
  // -------------------------------------------------------------------------

  it('a create whose line is added while it waits fails CONFLICT — exportfs never runs, not even the baseline, and no duplicate line is written', async () => {
    await serve()
    const body = { path: '/srv/nfs/photos', clients: [{ spec: '192.168.1.0/24', options: ['ro'] }] }
    const { id, release } = await acceptedBehindFullQueue(create(body))
    // Another writer composes the line onto the file (the daemon's own
    // composer) while the create's job waits.
    const handAdded = addExport(await readFile(exportsPath, 'utf8'), CreateNfsExportRequest.parse(body))
    await writeFile(exportsPath, handAdded)
    release()
    const job = await finished(id)
    assert.equal(job.status, 'failed')
    assert.equal(job.error?.code, 'CONFLICT', JSON.stringify(job.error))
    assert.equal(job.error?.message, `Export '${body.path}' already exists`)
    assert.deepEqual(calls.filter(isMutation), [], 'exportfs never ran — a refused create does not reload the export table of a line it did not write')
    assert.equal(await readFile(exportsPath, 'utf8'), handAdded, 'exports keep the hand line as it was')
    assert.equal(handAdded.split(body.path).length - 1, 1, 'the refused create added no second line for the path')
  })

  // -------------------------------------------------------------------------
  // Item 3: the cr.13 baseline reload runs UNDER the export's lock
  // -------------------------------------------------------------------------

  it('the baseline exportfs -ra runs while the export lock is held — a second writer of the same export waits for the whole edit, reload included', async () => {
    await serve()
    // Pause every exportfs the moment it is issued: the job stops at the
    // cr.13 baseline, before the write.
    let releaseExportfs!: () => void
    paused.set(EXPORTFS, new Promise<void>((resolve) => {
      releaseExportfs = resolve
    }))
    const id = await accepted(update(EXPORT, edit))
    await until(() => calls.some(isMutation), 'the baseline exportfs call is reached')
    // The baseline is mid-flight — and the job already holds the export's lock,
    // so no other verb of THIS export can be composing the file or reloading
    // against it while the baseline answers.
    assert.deepEqual(queue().heldLocks(), [{ key: `share:nfs:${EXPORT}`, mode: 'exclusive', holders: [id] }])
    // Release: the edit, the after-reload and the rollback machinery run to
    // the end — the job acts (the mutation check).
    releaseExportfs()
    const job = await finished(id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    assert.ok(calls.filter(isMutation).length >= 2, 'the baseline and the after-reload both ran')
    assert.ok(hasExport(await readFile(exportsPath, 'utf8'), EXPORT), 'the edit landed')
  })

  // -------------------------------------------------------------------------
  // Item 4: `share:nfs:<path>`, exclusive, for every verb
  // -------------------------------------------------------------------------

  it('every verb holds share:nfs:<path> exclusive while it acts', async () => {
    const cases: Array<{ req: Req, key: string }> = [
      { req: create({ path: '/srv/nfs/photos', clients: [{ spec: '192.168.1.0/24', options: ['ro'] }] }), key: 'share:nfs:/srv/nfs/photos' },
      { req: update(EXPORT, edit), key: `share:nfs:${EXPORT}` },
      { req: remove(EXPORT), key: `share:nfs:${EXPORT}` },
    ]
    for (const { req, key } of cases) {
      await serve()
      let release!: () => void
      paused.set(EXPORTFS, new Promise<void>((resolve) => {
        release = resolve
      }))
      const id = await accepted(req)
      await until(() => calls.some(isMutation), 'the exportfs call is reached')
      assert.deepEqual(queue().heldLocks(), [{ key, mode: 'exclusive', holders: [id] }], `${req.method} ${req.url}`)
      release()
      assert.equal((await finished(id)).status, 'completed', `${req.method} ${req.url}`)
      assert.deepEqual(queue().heldLocks(), [], 'released')
      await server!.close()
      server = undefined
    }
  })

  it('an add accepted while another add of the same path acts waits for its LOCK (no slot), then re-reads and fails CONFLICT', async () => {
    await serve()
    let releaseExportfs!: () => void
    // Pause the first add at its baseline reload: its line is not in the
    // file yet, so the second add's route gate passes — its job then contends
    // on the same export key.
    paused.set(EXPORTFS, new Promise<void>((resolve) => {
      releaseExportfs = resolve
    }))
    const body = { path: '/srv/nfs/photos', clients: [{ spec: '192.168.1.0/24', options: ['ro'] }] }
    const firstId = await accepted(create(body))
    await until(() => calls.some(isMutation), 'the first add\'s baseline is reached')
    const secondId = await accepted(create(body))
    assert.equal(queue().get(secondId)?.status, 'queued')
    assert.equal(queue().get(secondId)?.progress, `waiting for nfs.export.add (job ${firstId}) on NFS export ${body.path}`)
    assert.equal(queue().list('running').length, 1, 'the waiting add holds none of the free slots')
    paused.clear()
    releaseExportfs()
    assert.equal((await finished(firstId)).status, 'completed')
    const second = await finished(secondId)
    assert.equal(second.status, 'failed')
    assert.equal(second.error?.code, 'CONFLICT', JSON.stringify(second.error))
    assert.equal(second.error?.message, `Export '${body.path}' already exists`)
    const text = await readFile(exportsPath, 'utf8')
    assert.equal(text.split(body.path).length - 1, 1, 'exactly one line for the path')
    assert.deepEqual(queue().heldLocks(), [])
  })
})
