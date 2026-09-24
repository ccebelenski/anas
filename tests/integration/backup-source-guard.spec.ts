import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story backup2.11 (Backup source guard) — LIVE PROOF on the stunt node, over
 * the cloud tasks fixture (`test/stunt-node/cloud-tasks-fixture.sh up`), which
 * owns both fstab shapes this story needs:
 *
 *   /mnt/gt-unmounted  a CIFS share on TEST-NET that can NEVER be mounted
 *   /mnt/gt-guardok    a `tmpfs … noauto` line that starts unmounted and CAN be
 *                      mounted — the recovery half
 *
 * and a real PBS on the second VM (repo `pbsgt`, datastore `gtstore`), so a run
 * that gets past the guard really does write a snapshot.
 *
 * Modelled on cloud-tasks-api.spec.ts: request-context API tests carrying the
 * PVEAuthCookie, gateway → local anasd → the real system, every claim checked
 * BOTH through the API and on the node itself (sshExec). Serial, because the
 * mount state of `/mnt/gt-guardok` is the thread running through them — it is
 * absent for the refusal half and present for the recovery half, and nothing
 * may reorder that.
 *
 * What is proven, per the story's live-proof list:
 *   1. `preview-nested` carries `unmounted` for an archive under the tmpfs line
 *      while it is down, and carries nothing for `/gtbackup`
 *   2. the wizard's archive row shows the alert on the unmounted path and does
 *      not on `/gtbackup` (Playwright, the real PVE UI)
 *   3. Run now → the job FAILS with the sentence naming archive, path,
 *      mountpoint and fstab source; `anas-backup` notifies (`notified via
 *      target`, zero `could not notify`); `GET /v1/status` gains a `backup`
 *      warning
 *   4. the CIFS line is refused the same way, naming the CIFS source
 *   5. `mount /mnt/gt-guardok` + a file → Run now COMPLETES and PBS lists the
 *      snapshot
 *
 * The fixture is taken DOWN and back UP in beforeAll and DOWN in afterAll; the
 * tasks this spec creates are deleted in afterAll. The repository `pbsgt` is
 * registered if it is not there and KEPT — it is node configuration the backup
 * specs share, not this spec's disposable state.
 *
 * NOT YET RUN (2026-09-24): written at unit level while the stunt node was
 * held by another job. Run it with the node free; the counts and any ground
 * truth it turns up belong in the story's Result paragraph.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

/** The fixture that owns both fstab lines. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-tasks-fixture.sh', import.meta.url).pathname
/** provision-pbs.sh writes the token secret and fingerprint here (gitignored). */
const PBS_CONFIG_LOCAL = new URL('../../test/pbs-node/config.local', import.meta.url).pathname

const REPO = 'pbsgt'
const PBS_HOST = '192.168.200.51'
const PBS_PORT = 8007
const PBS_DATASTORE = 'gtstore'
const PBS_TOKEN_ID = 'root@pam!anas'

/** The mountable fixture line and an archive path under it. */
const GUARDOK = '/mnt/gt-guardok'
const GUARDOK_SRC = `${GUARDOK}/data`
/** The line that can never be mounted, and its fstab fs_spec. */
const UNMOUNTED = '/mnt/gt-unmounted'
const UNMOUNTED_SOURCE = '//192.0.2.9/nope'
/** A source that is genuinely there — the pool root, mounted since boot. */
const MOUNTED_SRC = '/gtbackup'

const GUARD_TASK = 'gtguard'
const CIFS_TASK = 'gtguardcifs'
const TASKS = [GUARD_TASK, CIFS_TASK]

/**
 * The PBS token secret + certificate fingerprint, from pbs-node's gitignored
 * `config.local`. A missing file is a SETUP failure, not a test failure — say
 * which script writes it rather than failing on an empty string later.
 */
function pbsCredentials(): { secret: string, fingerprint: string } {
  let text: string
  try {
    text = readFileSync(PBS_CONFIG_LOCAL, 'utf-8')
  }
  catch {
    throw new Error(`${PBS_CONFIG_LOCAL} is missing — run test/pbs-node/provision-pbs.sh first`)
  }
  const read = (key: string): string => {
    const line = text.split('\n').find(l => l.trim().startsWith(`${key}=`))
    return (line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')) ?? ''
  }
  const secret = read('PBS_TOKEN_SECRET')
  const fingerprint = read('PBS_FINGERPRINT')
  expect(secret, 'PBS_TOKEN_SECRET is in test/pbs-node/config.local').not.toBe('')
  expect(fingerprint, 'PBS_FINGERPRINT is in test/pbs-node/config.local').not.toBe('')
  return { secret, fingerprint }
}

/** Build an authenticated request context carrying the PVE session cookie. */
async function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: pveAuthState(ticket),
    timeout: 120_000,
  })
}

/** Poll a 202 job through GET /v1/jobs/:id until it completes or fails. */
async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 180_000,
): Promise<{ status: string, error?: { message?: string } | null, result?: any, progress?: string | null }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${job.error?.message ?? job.progress ?? ''}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Submit a mutation, wait for its job, and require it to COMPLETE. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
  timeout = 180_000,
): Promise<any> {
  const res = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, job.error?.message).toBe('completed')
  return job.result
}

/** Run a task through its own unit (the UI's Run Now path), expecting FAILURE. */
async function runTaskExpectingFailure(ctx: APIRequestContext, name: string): Promise<string> {
  const res = await ctx.post(`${V1}/backup/tasks/${name}/run`, { data: {} })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id)
  expect(job.status, `expected a failed run, got ${job.status}`).toBe('failed')
  return job.error?.message ?? ''
}

/** The `unmounted` fact `preview-nested` reports for one path. */
async function previewUnmounted(ctx: APIRequestContext, path: string): Promise<any> {
  const res = await ctx.post(`${V1}/backup/tasks/preview-nested`, { data: { path } })
  expect(res.status(), await res.text()).toBe(200)
  const [scan] = (await res.json()).data.archives
  return scan.unmounted
}

/** The task body the create door takes. */
function taskBody(name: string, archivePath: string): Record<string, unknown> {
  return {
    name,
    repository: REPO,
    backupId: name,
    archives: [{ name: 'guarded', path: archivePath, excludes: [] }],
    changeDetectionMode: 'default',
    // A failed run must reach the operator — that is half of what this story
    // is about, so the notification is exercised rather than suppressed.
    notify: 'always',
    schedule: '*-*-* 04:00:00',
    enabled: true,
  }
}

/** A journald cursor for the daemon's own unit — the "before" of a comparison. */
async function anasdCursor(): Promise<string> {
  const out = await sshExec('journalctl -u anasd -n 0 --no-pager --show-cursor')
  const cursor = out.split('-- cursor:').pop()?.trim() ?? ''
  expect(cursor, 'journalctl printed a cursor').not.toBe('')
  return cursor
}

/**
 * How many PVE notifications the daemon emitted since `cursor`.
 *
 * Ground truth from rclone.2's proof: `PVE::Notify` logs only
 * "notified via target <t>" and returns 0 even when the template pair is
 * missing — a missing pair logs "could not notify … failed to render" instead.
 * So an emission with ZERO render failures is what proves `anas-backup`'s own
 * template pair rendered.
 */
async function notificationsSince(cursor: string): Promise<{ sent: number, renderFailures: number }> {
  const journal = await sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o short-iso`)
  const lines = journal.split('\n')
  return {
    sent: lines.filter(l => l.includes('notified via target')).length,
    renderFailures: lines.filter(l => l.includes('could not notify')).length,
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('Backup source guard (backup2.11)', () => {
  test.setTimeout(300_000)

  test.beforeAll(async ({ playwright }) => {
    // DOWN first: a crashed earlier run's fstab lines and leftover tmpfs mount
    // are not a "before" this spec should be reading.
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 300_000 })
    await execFileAsync(FIXTURE_SH, ['up'], { timeout: 300_000 })

    // A beforeAll hook may only use WORKER-scoped fixtures, so the session
    // ticket is fetched here rather than taken from the test-scoped pveTicket.
    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    expect(ticketRes.ok()).toBeTruthy()
    const ticket = (await ticketRes.json()).data.ticket as string
    await login.dispose()

    const ctx = await authedContext(playwright, ticket)
    try {
      // Any task left from a crashed run — its units would collide on create.
      for (const name of TASKS) {
        const res = await ctx.get(`${V1}/backup/tasks/${name}`)
        if (res.status() === 200)
          await runJob(ctx, 'delete', `${V1}/backup/tasks/${name}`)
      }

      // The repository is node configuration the backup specs share: register
      // it once and KEEP it. The registry is compare-and-swap, so the version
      // just read is the one the write is based on.
      const reposRes = await ctx.get(`${V1}/backup/repos`)
      expect(reposRes.status()).toBe(200)
      const registry = (await reposRes.json()).data as { version: number, repos: { name: string }[] }
      if (!registry.repos.some(r => r.name === REPO)) {
        const { secret, fingerprint } = pbsCredentials()
        await runJob(ctx, 'post', `${V1}/backup/repos`, {
          expectedVersion: registry.version,
          repo: {
            name: REPO,
            host: PBS_HOST,
            port: PBS_PORT,
            datastore: PBS_DATASTORE,
            authType: 'token',
            tokenId: PBS_TOKEN_ID,
            fingerprint,
            secret,
          },
        })
      }
    }
    finally {
      await ctx.dispose()
    }
  })

  test.afterAll(async ({ playwright }) => {
    // Leave the node as found: this spec's task units go, the repository stays.
    // Best-effort — an afterAll failure must not mask the run's results.
    try {
      const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
      const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
        form: { username: 'root@pam', password: 'anas-test' },
      })
      const ticket = (await ticketRes.json()).data.ticket as string
      await login.dispose()
      const ctx = await authedContext(playwright, ticket)
      for (const name of TASKS) {
        const res = await ctx.get(`${V1}/backup/tasks/${name}`)
        if (res.status() === 200)
          await runJob(ctx, 'delete', `${V1}/backup/tasks/${name}`)
      }
      await ctx.dispose()
    }
    catch (err) {
      console.error(`backup guard task cleanup failed: ${err instanceof Error ? err.message : err}`)
    }
    try {
      await execFileAsync(FIXTURE_SH, ['down'], { timeout: 300_000 })
    }
    catch (err) {
      console.error(`cloud tasks fixture down failed: ${err instanceof Error ? err.message : err}`)
    }
  })

  test('preview-nested carries the unmounted fact for the tmpfs line, and nothing for a mounted source', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The fixture's starting state, read from the node itself.
      expect(await sshExec(`grep -c ' ${GUARDOK} ' /etc/fstab || true`), 'the tmpfs fstab line is there').toBe('1')
      expect(await sshExec(`findmnt -n ${GUARDOK} >/dev/null 2>&1 && echo mounted || echo unmounted`)).toBe('unmounted')

      const unmounted = await previewUnmounted(ctx, GUARDOK_SRC)
      expect(unmounted, 'the scan carries the unmounted fact').toBeTruthy()
      expect(unmounted).toMatchObject({ mountpoint: GUARDOK, source: 'tmpfs', fstype: 'tmpfs' })

      // A source that is genuinely there says nothing at all — the key is
      // absent, never a falsy placeholder.
      expect(await previewUnmounted(ctx, MOUNTED_SRC)).toBeUndefined()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the wizard row warns on the unmounted path and is silent on a mounted one', async ({ page }) => {
    // The real PVE UI, the real wizard. The alert is the element that already
    // carries the row's nested note.
    await openAnasItem(page, 'Backup')
    await page.getByRole('button', { name: 'Add' }).first().click()

    const row = page.locator('.anas-backup-archives .anas-backup-arch-nested-alert').first()
    const path = page.locator('.anas-backup-archives .anas-fld-backup-arch-path input').first()

    await path.fill(GUARDOK_SRC)
    await path.blur()
    await expect(row).toContainText('Not mounted', { timeout: 20_000 })
    await expect(row).toContainText(GUARDOK)
    await expect(row).toContainText('The run will be refused until it is mounted.')

    await path.fill(MOUNTED_SRC)
    await path.blur()
    // The scan for the new path must have landed before this is read — the
    // consistency chip only appears once it has.
    await expect(row).toContainText(/snapshot|live/, { timeout: 20_000 })
    await expect(row).not.toContainText('Not mounted')
  })

  test('Run now on an archive under the unmounted tmpfs line FAILS with the sentence, notifies, and shows as a backup warning', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Saving is NOT blocked: the fact is time-dependent, so a task defined
      // while the mount is down is a legitimate thing to have.
      await runJob(ctx, 'post', `${V1}/backup/tasks`, taskBody(GUARD_TASK, GUARDOK_SRC))

      const cursor = await anasdCursor()
      const refusal = await runTaskExpectingFailure(ctx, GUARD_TASK)

      // DESIGN's own sentence, with all four facts.
      expect(refusal).toContain(
        `archive 'guarded': ${GUARDOK_SRC} is on ${GUARDOK} (tmpfs), `
        + `which is configured in /etc/fstab but not mounted`,
      )

      // Step 0 means step 0: nothing was uploaded, so PBS has no group for this
      // task at all.
      const snapsRes = await ctx.get(`${V1}/backup/tasks/${GUARD_TASK}/snapshots`)
      expect(snapsRes.status()).toBe(200)
      expect((await snapsRes.json()).data.snapshots ?? []).toEqual([])

      // The failure reaches the operator through the surfaces that already
      // existed — nothing new carries it.
      const notified = await notificationsSince(cursor)
      expect(notified.sent, 'the refused run emitted a PVE notification').toBeGreaterThan(0)
      expect(notified.renderFailures, 'the anas-backup template pair rendered').toBe(0)

      const rowRes = await ctx.get(`${V1}/backup/tasks`)
      expect(rowRes.status()).toBe(200)
      const row = (await rowRes.json()).data.find((t: { name: string }) => t.name === GUARD_TASK)
      expect(row.lastRunResult).toBe('failure')

      const statusRes = await ctx.get(`${V1}/status`)
      expect(statusRes.status()).toBe(200)
      const warnings = (await statusRes.json()).data.warnings as { category: string, ref: string, message: string }[]
      const warning = warnings.find(w => w.category === 'backup' && w.ref === GUARD_TASK)
      expect(warning, 'GET /v1/status carries a backup warning for the refused task').toBeTruthy()
      expect(warning!.message).toContain(GUARD_TASK)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the CIFS line is refused the same way, naming the CIFS source', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The incident's own shape: an empty mountpoint directory where a share
      // should be, on a host that can never answer (192.0.2.9 is TEST-NET).
      expect(await sshExec(`findmnt -n ${UNMOUNTED} >/dev/null 2>&1 && echo mounted || echo unmounted`)).toBe('unmounted')

      await runJob(ctx, 'post', `${V1}/backup/tasks`, taskBody(CIFS_TASK, UNMOUNTED))
      const refusal = await runTaskExpectingFailure(ctx, CIFS_TASK)
      expect(refusal).toContain(
        `archive 'guarded': ${UNMOUNTED} is on ${UNMOUNTED} (${UNMOUNTED_SOURCE}), `
        + `which is configured in /etc/fstab but not mounted`,
      )
    }
    finally {
      await ctx.dispose()
    }
  })

  test('mounting it makes the SAME task run: the backup completes and PBS lists the snapshot', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The recovery the failure's tooltip tells the operator to perform: mount
      // it and run it again. Nothing about the task changes.
      await sshExec(`mount ${GUARDOK}`)
      await sshExec(`mkdir -p ${GUARDOK_SRC} && printf 'backup2.11 guard proof\\n' > ${GUARDOK_SRC}/proof.txt && sync`)
      expect(await sshExec(`findmnt -n ${GUARDOK} >/dev/null 2>&1 && echo mounted || echo unmounted`)).toBe('mounted')

      // The save-time fact follows the system, not a cache.
      expect(await previewUnmounted(ctx, GUARDOK_SRC)).toBeUndefined()

      const result = await runJob(ctx, 'post', `${V1}/backup/tasks/${GUARD_TASK}/run`, {})
      expect(result, 'the run produced a result').toBeTruthy()

      // PBS is the witness: the group now has a snapshot, and it carries the
      // archive the guard used to refuse.
      const snapsRes = await ctx.get(`${V1}/backup/tasks/${GUARD_TASK}/snapshots`)
      expect(snapsRes.status()).toBe(200)
      const snapshots = (await snapsRes.json()).data.snapshots as { files?: string[] }[]
      expect(snapshots.length, 'PBS lists the snapshot this run wrote').toBeGreaterThan(0)
      expect(JSON.stringify(snapshots)).toContain('guarded.pxar')
    }
    finally {
      await ctx.dispose()
    }
  })
})
