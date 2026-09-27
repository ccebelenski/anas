import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import { apiCtx, awaitJob, remoteNames, runJob, taskNames, V1 } from './cloud-api'
import { sshExec } from './stunt-node'

const execFileAsync = promisify(execFile)

/**
 * The SIX-STEP per-backend runner the cloud live-proof specs share
 * (cloudproof.1 `cloud-backends.spec.ts`, cloudproof.2
 * `cloud-backends-2.spec.ts`) — one helper, not a copy (the single
 * source-of-truth rule). The steps are the story's:
 *
 *   (a) create the remote(s) through the API with the fields the dialog
 *       would offer; the listing carries the non-secret keys, the secrets
 *       only as `secretsSet`;
 *   (b) Test → `ok` (each ok probe);
 *   (c) a copy task over the shared 12-file source with a `*.tmp` exclude →
 *       run now → the destination verified THROUGH THE BACKEND itself
 *       (`listCmd`), plus any per-backend `extraCopyChecks`;
 *   (d) edit to sync, delete one source file, run again → gone at the
 *       destination (`syncListCmd`, default `listCmd`);
 *   (e) the wrong-credential probes — each pinned to the verdict the daemon
 *       ACTUALLY answers (a curation/verdict gap is a finding recorded in
 *       the spec, never papered over);
 *   (f) the remote delete refuses (409) while the task references it; the
 *       task then the remote(s) removed → all gone.
 *
 * The caller owns the FIXTURE half: `up` in beforeAll, teardown + `down` in
 * afterAll, the skip guard in beforeEach.
 */

/** The copy-task source the fixture builds (12 files + scratch.tmp). */
export const SOURCE = '/var/tmp/anas-gtcloud-src'
/** Raw OnCalendar far in the future — a stale stamp must never self-run. */
export const SCHEDULE = '2030-01-01 00:00:00'

/** f01.txt … f12.txt — every name the copy must land at the destination. */
export const ALL_FILES = Array.from({ length: 12 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`)
export const SYNC_DELETED = 'f06.txt'

/** One remote created through the API in step (a). */
export interface CloudRemoteCase {
  name: string
  type: string
  /** ONLY the fields the dialog would offer for this backend. */
  options: Record<string, string>
  /** The non-secret option names the listing must carry. */
  nonSecretKeys: string[]
  /** The secret names `secretsSet` must name (values never listed). */
  secretKeys: string[]
}

/**
 * One Test-door probe. `name` probes a SAVED remote (the stored config —
 * obscured secrets — really works); `type`+`options` probe an UNSAVED
 * dialog (the field set as typed, through the env-defined remote).
 */
export interface CloudProbeCase {
  label: string
  name?: string
  type?: string
  options?: Record<string, string>
  /** The verdict the daemon ACTUALLY answers — captured, not assumed.
   *  Optional: an ok probe (step b) answers `ok` by definition. */
  verdict?: string
  /** A sentence the verdict's message must carry (a fixed classifier sentence). */
  messageRe?: RegExp
}

export interface CloudBackendCase {
  key: string
  remotes: CloudRemoteCase[]
  /** Which remote the task writes through (default: remotes[0]). */
  taskRemote?: string
  task: string
  /** Remote-side path under `remote:` — bucket+prefix on s3, `proof` elsewhere. */
  path: string
  /** ssh command listing the destination THROUGH the backend (names + sizes). */
  listCmd: string
  /** Test-door probes: the ok ones (step b) and the wrong ones (step e). */
  probes: { ok: CloudProbeCase[], wrong: CloudProbeCase[] }
  /** Listing for the sync step (default: listCmd). */
  syncListCmd?: string
  /** Extra verification THROUGH the backend after the copy run (crypt). */
  extraCopyChecks?: () => Promise<void>
  /** Run after the task is deleted, before the remote removals (crypt). */
  beforeRemoval?: (ctx: APIRequestContext) => Promise<void>
  /** Remote removal order after the task (default: every case remote). */
  removalOrder?: string[]
}

/**
 * The destination listing through the backend, reduced to the file names the
 * run should have produced (smbclient rows and PROPFIND hrefs and rclone ls
 * paths all carry the bare names).
 */
export async function destFiles(listCmd: string): Promise<string[]> {
  const out = await sshExec(listCmd)
  const names = out.match(/(?:f\d{2}|scratch)\.(?:txt|tmp)/g) ?? []
  // The rule's autofix sorts the SET itself (no such method) — keep the spread.
  // eslint-disable-next-line e18e/prefer-array-to-sorted
  return [...new Set(names)].sort()
}

/**
 * Rebuild the shared source deterministically — backends run serially and
 * the sync step deletes a file from it, so every backend starts from the full
 * 12 + scratch.tmp whatever a previous backend left behind.
 */
export async function resetSource(): Promise<void> {
  await sshExec(
    `rm -rf ${SOURCE} && mkdir -p ${SOURCE} && for i in $(seq -w 1 12); do `
    + `printf 'fixture file %s\\n' $i > ${SOURCE}/f$i.txt; done && `
    + `printf 'to be excluded\\n' > ${SOURCE}/scratch.tmp && chmod -R a+r ${SOURCE}`,
  )
}

async function remotesList(ctx: APIRequestContext): Promise<Array<Record<string, any>>> {
  const res = await ctx.get(`${V1}/cloud/remotes`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data.remotes as Array<Record<string, any>>
}

/** POST the test door for a probe target and return its verdict + message. */
export async function probeRemote(
  ctx: APIRequestContext,
  p: CloudProbeCase,
): Promise<{ status: number, verdict?: string, message?: string }> {
  const body = p.name !== undefined
    ? { name: p.name }
    : { remote: { name: 'gtdraft', type: p.type, options: p.options } }
  const res = await ctx.post(`${V1}/cloud/remotes/test`, { data: body })
  const json = await res.json().catch(() => ({}))
  return { status: res.status(), verdict: json?.data?.verdict, message: json?.data?.message }
}

async function createRemote(ctx: APIRequestContext, r: CloudRemoteCase): Promise<void> {
  if (!(await remoteNames(ctx)).includes(r.name)) {
    await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
      name: r.name,
      type: r.type,
      options: r.options,
    })
  }
}

/**
 * The six steps, one test per backend case. Splits into three request
 * contexts exactly as cloudproof.1's original ran (main flow, the
 * wrong-credential probes, the removals) — plumbing, not assertions.
 */
export async function runCloudBackendProof(
  playwright: PlaywrightWorkerArgs['playwright'],
  c: CloudBackendCase,
): Promise<void> {
  const taskRemote = c.taskRemote ?? c.remotes[0].name

  const ctx = await apiCtx(playwright)
  try {
    await resetSource()

    // (a) create with the dialog's fields; the listing carries the
    // non-secret keys, the secrets only as `secretsSet`.
    for (const r of c.remotes)
      await createRemote(ctx, r)
    const list = await remotesList(ctx)
    for (const r of c.remotes) {
      const row = list.find(x => x.name === r.name)
      expect(row, `remote ${r.name} listed`).toBeTruthy()
      const listed = row as unknown as { options: Record<string, string>, secretsSet: string[] }
      for (const k of r.nonSecretKeys)
        expect(Object.keys(listed.options), `non-secret key ${k}`).toContain(k)
      for (const k of r.secretKeys) {
        expect(Object.keys(listed.options), `secret ${k} never listed`).not.toContain(k)
        expect(listed.secretsSet, `secretsSet names ${k}`).toContain(k)
      }
    }

    // (b) Test → ok.
    for (const p of c.probes.ok) {
      const ok = await probeRemote(ctx, p)
      expect(ok.status, `${c.key} ${p.label}: ${JSON.stringify(ok)}`).toBe(200)
      expect(ok.verdict, `${c.key} ${p.label}: ${JSON.stringify(ok)}`).toBe('ok')
    }

    // (c) the copy task → run now → 12 files at the destination, the *.tmp
    // exclude honoured, verified THROUGH the backend.
    await runJob(ctx, 'post', `${V1}/cloud/tasks`, {
      name: c.task,
      source: SOURCE,
      remote: taskRemote,
      path: c.path,
      mode: 'copy',
      excludes: ['*.tmp'],
      schedule: SCHEDULE,
      enabled: true,
    })
    const run = await ctx.post(`${V1}/cloud/tasks/${c.task}/run`, { data: {} })
    expect(run.status(), await run.text()).toBe(202)
    const runJobId = (await run.json()).job.id
    expect((await awaitJob(ctx, runJobId)).status).toBe('completed')
    let names = await destFiles(c.listCmd)
    for (const f of ALL_FILES)
      expect(names, `${c.key} destination listing:\n${names.join('\n')}`).toContain(f)
    expect(names, 'the *.tmp exclude kept scratch.tmp off the destination').not.toContain('scratch.tmp')
    await c.extraCopyChecks?.()

    // (d) edit to sync, delete one source file, run again → gone at the
    // destination (copy never deletes; sync does — both modes in one run).
    await runJob(ctx, 'put', `${V1}/cloud/tasks/${c.task}`, {
      name: c.task,
      source: SOURCE,
      remote: taskRemote,
      path: c.path,
      mode: 'sync',
      excludes: ['*.tmp'],
      schedule: SCHEDULE,
      enabled: true,
    })
    await sshExec(`rm -f ${SOURCE}/${SYNC_DELETED}`)
    const run2 = await ctx.post(`${V1}/cloud/tasks/${c.task}/run`, { data: {} })
    expect(run2.status(), await run2.text()).toBe(202)
    expect((await awaitJob(ctx, (await run2.json()).job.id)).status).toBe('completed')
    names = await destFiles(c.syncListCmd ?? c.listCmd)
    expect(names, `${c.key} destination after the sync run:\n${names.join('\n')}`)
      .not
      .toContain(SYNC_DELETED)
    for (const f of ALL_FILES.filter(f => f !== SYNC_DELETED))
      expect(names).toContain(f)
  }
  finally {
    await ctx.dispose()
  }

  // (e) the wrong-credential probes — each pinned to the verdict the daemon
  // actually answers, with a sentence naming itself and never Go internals.
  const ctx2 = await apiCtx(playwright)
  try {
    for (const p of c.probes.wrong) {
      const wrong = await probeRemote(ctx2, p)
      expect(wrong.status, `${c.key} ${p.label}: ${JSON.stringify(wrong)}`).toBe(200)
      expect(wrong.verdict, `${c.key} ${p.label}: ${JSON.stringify(wrong)}`).toBe(p.verdict ?? 'ok')
      if ((p.verdict ?? 'ok') !== 'ok')
        expect(wrong.message ?? '', `${c.key} ${p.label}: a failure names itself in a sentence`).not.toBe('')
      if (p.messageRe)
        expect(wrong.message ?? '', `${c.key} ${p.label}: message ${JSON.stringify(wrong.message)}`).toMatch(p.messageRe)
      expect(`${wrong.verdict} ${wrong.message}`).not.toContain('goroutine')
      expect(`${wrong.verdict} ${wrong.message}`).not.toContain('cannot unmarshal')
    }
  }
  finally {
    await ctx2.dispose()
  }

  // (f) the remote delete refuses while the task references it; task then
  // remote(s) removed → all gone.
  const ctx3 = await apiCtx(playwright)
  try {
    const refused = await ctx3.delete(`${V1}/cloud/remotes/${taskRemote}`)
    expect(refused.status(), await refused.text()).toBe(409)
    expect((await refused.json()).error.message).toContain(c.task)

    await runJob(ctx3, 'delete', `${V1}/cloud/tasks/${c.task}`)
    await c.beforeRemoval?.(ctx3)
    for (const name of c.removalOrder ?? c.remotes.map(r => r.name))
      await runJob(ctx3, 'delete', `${V1}/cloud/remotes/${name}`)
    const names = await remoteNames(ctx3)
    for (const r of c.remotes)
      expect(names, `remote ${r.name} gone`).not.toContain(r.name)
    expect(await taskNames(ctx3)).not.toContain(c.task)
  }
  finally {
    await ctx3.dispose()
  }
}
