import type { Locator, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { apiCtx, awaitJob, getJob, runJob, V1 } from './fixtures/cloud-api'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

/**
 * LIVE PROOF for the backup half of story rclone.5 "Cancel a running run"
 * (commit bfe050c) over the real daemon on the stunt node (HEAD a9b9904) —
 * the same ladder the cloud spec proves for rclone (cloud-cancel.spec.ts),
 * for `proxmox-backup-client`:
 *
 *   1. The cancel ladder — Run now, the row `running` with `runningJobId`, the
 *      pbc child genuinely uploading from the task's transient snapshot,
 *      POST /v1/jobs/:id/cancel answered 409 with `X-Anas-Confirm-Code` and
 *      the headline ("Backup task '…' has been running for …; cancelling stops
 *      it here") plus the consequence sentence in `warnings`, the replay with
 *      the code → 202 `job.cancel`, the pbc child GONE within 5 s, the direct
 *      job `cancelled` with "cancelled by <user> at <time>", the unit failed
 *      with ExecMainStatus=130, the row reading `cancelled` with `lastRunNote`,
 *      NO new point in time for the task's group on PBS (checked BOTH through
 *      the API and with the daemon's own `proxmox-backup-client snapshot list`
 *      command and env on the node), no leftover transient snapshot, and one
 *      journald "cancelled — no notification sent" line + the `job.cancelled`
 *      audit line with NO notification and NO prune trace.
 *   2. The dialog — the Backup toolbar's Cancel run is enabled only on a
 *      running row (disabled on the cancelled row test 1 left), opens the
 *      daemon-worded confirm window, "Keep running" is the default (clicking
 *      it sends nothing — the run continues), and confirming ends the run:
 *      the "Run cancelled" toast and the row reading cancelled.
 *
 * GROUND TRUTH (calibration 2026-09-26, before this spec was written): PBS on
 * the second VM ingests ~225 MiB/s over the test network and per-file overhead
 * is negligible (20k small files in 0.4 s), so a run only lasts if the SOURCE
 * is large: 3 GiB of fresh urandom uploads in ~14 s. The source is REWRITTEN
 * with fresh random bytes before every run — PBS deduplicates chunks, so
 * re-uploading unchanged data finishes in under a second and would end the
 * run before any cancel could land. The pool holds ~6 GiB free, which caps
 * the margin: the spec cancels as soon as the pbc child is visible on the
 * node, never after a progress wait (the cloud spec's waitRunning would eat
 * the window).
 *
 * FIXTURE: none of its own — the `pbsgt` repository is node configuration the
 * backup specs share (registered here if absent, then KEPT, exactly as
 * backup-source-guard.spec.ts leaves it), and the source dataset
 * gtbackup/gtbackcancel is created and destroyed by this spec. The operator's
 * remote `gtest` and task `testoff` are asserted present at teardown — nothing
 * here ever runs, edits or removes them.
 */

const TASK = 'gtbackcancel'
const REPO = 'pbsgt'
const DATASET = 'gtbackup/gtbackcancel'
/** The dataset's mountpoint — the archive path the task backs up. */
const SRC_DIR = `/${DATASET}/src`
const UNIT = `anas-backup-${TASK}.service`
const SCHEDULE = '2030-01-01 00:00:00'

const PBS_HOST = '192.168.200.51'
const PBS_PORT = 8007
const PBS_DATASTORE = 'gtstore'
const PBS_TOKEN_ID = 'root@pam!anas'
/** provision-pbs.sh writes the token secret and fingerprint here (gitignored). */
const PBS_CONFIG_LOCAL = new URL('../../test/pbs-node/config.local', import.meta.url).pathname

/** How much fresh source a run needs: 3 GiB at ~225 MiB/s ≈ 14 s of pbc. */
const SOURCE_4M_BLOCKS = 768

/**
 * The consequence sentence, verbatim from the rclone.5 story (backup parity)
 * — BACKUP_CANCEL_CONSEQUENCE in routes/backup.ts.
 */
const CONSEQUENCE = 'The unfinished snapshot is discarded by the backup server; earlier snapshots are untouched.'

/** The cancel headline's shape for this task (jobs.ts cancelHeadline). */
const HEADLINE_RE = /^Backup task 'gtbackcancel' has been running for .+; cancelling stops it here$/

/**
 * pgrep pattern for the run's pbc child. The alternation is split (`(bac)kup`)
 * so THIS ssh command's own bash cmdline — which contains the pattern verbatim
 * — can never match itself; the daemon's real argv (`proxmox-backup-client
 * backup …`, prlimit execs in place) still matches.
 */
const PBC_CHILD = `pgrep -af 'proxmox-backup-client (bac)kup' || true`

/** The task body the create door takes — no retention, so nothing ever prunes. */
function taskBody(): Record<string, unknown> {
  return {
    name: TASK,
    repository: REPO,
    backupId: TASK,
    archives: [{ name: 'gtdata', path: SRC_DIR, excludes: [] }],
    changeDetectionMode: 'default',
    // `always`, so a run that went through the notify path leaves a trace the
    // cancelled run must NOT leave (the suppression is what is proven).
    notify: 'always',
    // A raw date years out, never a time of day: a leftover timer stamp must
    // not self-run the task (the SCHEDULES-GT-16..21 lesson).
    schedule: SCHEDULE,
    enabled: true,
  }
}

// ---- Node-side helpers --------------------------------------------------------

/**
 * Fresh random source, ~3 GiB — fresh BYTES every call (PBS dedupes chunks;
 * unchanged data would upload in under a second and end the run). ~20 s of
 * urandom on the node.
 */
async function stageSource(): Promise<void> {
  await sshExec(`zfs list ${DATASET} >/dev/null 2>&1 || zfs create ${DATASET}`)
  await sshExec(`mkdir -p ${SRC_DIR} && dd if=/dev/urandom of=${SRC_DIR}/blob.bin bs=4M count=${SOURCE_4M_BLOCKS} status=none && sync`)
}

/**
 * The PBS token secret + certificate fingerprint, from pbs-node's gitignored
 * `config.local` — read only when the shared `pbsgt` repo is NOT yet
 * registered (the secret is otherwise read ON the node, from the creds file
 * the daemon itself wrote).
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

/**
 * The task's group on PBS, as points in time — read with the daemon's OWN
 * command and env on the node (`proxmox-backup-client snapshot list`, the
 * repository string and fingerprint built from the node's registry, the token
 * secret from the daemon's creds file), so the assertion reads the same
 * machine contact the run made. The secret never crosses from the desktop.
 */
async function pbcSnapshotTimes(): Promise<number[]> {
  const out = await sshExec([
    `registry=/etc/pve/anas/backup-repos.json`,
    `repo=$(python3 -c "import json;r=[x for x in json.load(open('$registry'))['repos'] if x['name']=='${REPO}'][0];print(f\\"{r['tokenId']}@{r['host']}:{r['port']}:{r['datastore']}\\")")`,
    `fp=$(python3 -c "import json;r=[x for x in json.load(open('$registry'))['repos'] if x['name']=='${REPO}'][0];print(r['fingerprint'])")`,
    `PBS_REPOSITORY=$repo PBS_FINGERPRINT=$fp PBS_PASSWORD=$(cat /etc/anas/creds/backup-repo-${REPO}.secret) \\`,
    `  proxmox-backup-client snapshot list --output-format json 2>/dev/null`,
  ].join('\n'))
  // An empty answer is a FAILED pbc call (stderr was suppressed), never an
  // empty datastore — fail here rather than vacuously passing the delta below.
  expect(out.trim(), 'pbc snapshot list answered JSON').not.toBe('')
  const snaps = JSON.parse(out) as Array<{ 'backup-type': string, 'backup-id': string, 'backup-time': number }>
  return snaps
    .filter(s => s['backup-type'] === 'host' && s['backup-id'] === TASK)
    .map(s => s['backup-time'])
}

/** The task's points in time as the daemon's own listing reports them. */
async function taskSnapshotTimes(ctx: Awaited<ReturnType<typeof apiCtx>>): Promise<number[]> {
  const res = await ctx.get(`${V1}/backup/tasks/${TASK}/snapshots`)
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()).data.snapshots ?? []).map((s: { backupTime: number }) => s.backupTime)
}

/** One POST /v1/jobs/:id/cancel, verbatim — the caller asserts the shape. */
async function postCancel(
  ctx: Awaited<ReturnType<typeof apiCtx>>,
  jobId: string,
  code?: string,
): Promise<{ status: number, codeHeader?: string, errorCode?: string, message?: string, warnings?: string[] }> {
  const res = await ctx.post(`${V1}/jobs/${jobId}/cancel`, {
    data: {},
    ...(code ? { headers: { 'x-anas-confirm': code } } : {}),
  })
  const body = await res.json().catch(() => ({}))
  return {
    status: res.status(),
    codeHeader: res.headers()['x-anas-confirm-code'],
    errorCode: body?.error?.code,
    message: body?.error?.message,
    warnings: body?.error?.warnings,
  }
}

/** One row of GET /v1/backup/tasks, by task name. */
async function backupRowByName(ctx: Awaited<ReturnType<typeof apiCtx>>): Promise<Record<string, any>> {
  const res = await ctx.get(`${V1}/backup/tasks`)
  expect(res.status(), await res.text()).toBe(200)
  const rows = (await res.json()).data as Array<Record<string, any>>
  const row = rows.find(r => r.task?.name === TASK)
  expect(row, `task ${TASK} present in GET /v1/backup/tasks`).toBeTruthy()
  return row as unknown as Record<string, any>
}

// ---- UI helpers ---------------------------------------------------------------

/** Select the node, open the Backup menu, wait for the tasks grid. */
async function openBackupView(page: Page): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Backup')
  const grid = page.locator('.anas-grid-backup')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  return grid
}

/** The grid row for task `name` — scoped to the NAME cell, exact match. */
function taskRow(page: Page, grid: Locator, name: string): Locator {
  return grid
    .locator('.x-grid-row', {
      has: page.locator('.x-grid-cell-inner', { hasText: new RegExp(`^${name}$`) }),
    })
    .first()
}

// ---- Fixtures -----------------------------------------------------------------

test.beforeAll(async ({ playwright }) => {
  // The throwaway source dataset: a crashed earlier run's leftover transient
  // snapshots and staged data are not a "before" this spec should read.
  await sshExec(`zfs destroy -r ${DATASET}`).catch(() => {})
  await stageSource()

  const ctx = await apiCtx(playwright)
  try {
    // Any task left from a crashed run — its units would collide on create.
    const list = await ctx.get(`${V1}/backup/tasks/${TASK}`)
    if (list.status() === 200)
      await runJob(ctx, 'delete', `${V1}/backup/tasks/${TASK}`)

    // The repository is node configuration the backup specs share: register
    // it once and KEEP it (the guard spec's pattern).
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

test.describe.serial('backup cancel live proof — the rclone.5 backup half', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(300_000)

  test.afterAll(async ({ playwright }) => {
    // Teardown even on failure, best-effort throughout — the operator-survival
    // assertions at the end must not be masked: this spec's task goes through
    // its API door, the source dataset is destroyed.
    const ctx = await apiCtx(playwright).catch(() => null)
    try {
      if (ctx)
        await ctx.delete(`${V1}/backup/tasks/${TASK}`).catch(() => {})
    }
    finally {
      ctx?.dispose()
      await sshExec(`zfs destroy -r ${DATASET}`).catch(() => {})
    }

    // The operator's own remote and task — and the shared repository —
    // survived everything this spec did: the one thing the node rules make
    // non-negotiable.
    const ctx2 = await apiCtx(playwright)
    try {
      expect(await (await ctx2.get(`${V1}/cloud/remotes`)).json(), 'gtest untouched')
        .toEqual(expect.objectContaining({ data: expect.objectContaining({
          remotes: expect.arrayContaining([expect.objectContaining({ name: 'gtest' })]),
        }) }))
      expect(await (await ctx2.get(`${V1}/cloud/tasks`)).json(), 'testoff untouched')
        .toEqual(expect.objectContaining({ data: expect.arrayContaining([
          expect.objectContaining({ name: 'testoff' }),
        ]) }))
      expect(await (await ctx2.get(`${V1}/backup/repos`)).json(), 'pbsgt kept')
        .toEqual(expect.objectContaining({ data: expect.objectContaining({
          repos: expect.arrayContaining([expect.objectContaining({ name: REPO })]),
        }) }))
    }
    finally {
      await ctx2.dispose()
    }
  })

  test('1 — the cancel ladder: 409 + code, replay 202, the pbc child stopped (gone, exit 130), cancelled row with its note, no new snapshot on PBS, no transient left, no notification, no prune', async ({ playwright }) => {
    test.setTimeout(420_000)
    const ctx = await apiCtx(playwright)
    try {
      await runJob(ctx, 'post', `${V1}/backup/tasks`, taskBody())

      // The "before" of every delta below: PBS points in time for this group,
      // through BOTH doors the proof reads later.
      const pbcBefore = await pbcSnapshotTimes()
      const apiBefore = await taskSnapshotTimes(ctx)

      // The journal window every anasd-side assertion below reads, and the
      // instant snapshots are compared against.
      const runStart = await sshExec('date -Is')
      const runStartedAt = Date.now()

      // Run now (the UI path — no `direct` flag): 202, the supervising job.
      const runRes = await ctx.post(`${V1}/backup/tasks/${TASK}/run`, { data: {} })
      expect(runRes.status(), await runRes.text()).toBe(202)
      const superviseJobId = (await runRes.json()).job.id

      // Within 20 s the row reads `running` with the direct job id — the job
      // the cancel verb targets.
      await expect.poll(async () => {
        const row = await backupRowByName(ctx)
        return row.lastRunResult === 'running' && row.runningJobId ? 'go' : 'wait'
      }, { timeout: 20_000, intervals: [1_000], message: 'the row reads running with runningJobId within 20 s' }).toBe('go')
      const directId = (await backupRowByName(ctx)).runningJobId as string
      expect(superviseJobId, 'the supervising job is a different job than the direct one').not.toBe(directId)

      // The pbc child is genuinely running — the transient snapshot exists and
      // the client is reading it. The cancel must land mid-upload, so the spec
      // waits for the process itself and NOT for a progress line (the whole
      // upload is ~14 s; the margin lives in cancelling fast, not late).
      await expect.poll(async () => (await sshExec(PBC_CHILD)).trim(), {
        timeout: 20_000,
        intervals: [500],
        message: 'the proxmox-backup-client child is on the node',
      }).not.toBe('')

      // The first call is the confirm challenge: 409 with the code header, the
      // headline naming the task and its elapsed time — and the consequence
      // sentence in warnings.
      const challenge = await postCancel(ctx, directId)
      expect(challenge.status, JSON.stringify(challenge)).toBe(409)
      expect(challenge.codeHeader, 'X-Anas-Confirm-Code on the challenge').toBeTruthy()
      expect(challenge.message ?? '', challenge.message).toMatch(HEADLINE_RE)
      expect(challenge.warnings ?? [], `warnings: ${JSON.stringify(challenge.warnings)}`).toContain(CONSEQUENCE)

      // The replay with the code submits the job.cancel CONTROL job — it
      // completes once the hook has stopped the run. The header was proven
      // present just above; the assertion does not narrow, so the field rides
      // with its type's own honesty.
      const replayRes = await ctx.post(`${V1}/jobs/${directId}/cancel`, {
        data: {},
        headers: { 'x-anas-confirm': challenge.codeHeader! },
      })
      expect(replayRes.status(), await replayRes.text()).toBe(202)
      const cancelJobId = (await replayRes.json()).job.id
      const cancelJob = await awaitJob(ctx, cancelJobId, 30_000)
      expect(cancelJob.status, cancelJob.error).toBe('completed')

      // The child is gone within 5 s of the cancel landing.
      await expect.poll(async () => (await sshExec(PBC_CHILD)).trim(), {
        timeout: 5_000,
        intervals: [500],
        message: 'no proxmox-backup-client child within 5 s of the cancel',
      }).toBe('')

      // The direct job ended `cancelled` — additive status, error null, the
      // reason naming who cancelled and when.
      await expect.poll(async () => (await getJob(ctx, directId)).job?.status, {
        timeout: 30_000,
        intervals: [1_000],
        message: 'the direct run job reaches cancelled',
      }).toBe('cancelled')
      const directJob = (await getJob(ctx, directId)).job
      expect(directJob.error ?? null, 'a cancelled job carries no error').toBeNull()
      const reason = directJob.result?.reason ?? directJob.reason ?? ''
      expect(reason, `reason: ${JSON.stringify(directJob.result ?? directJob)}`).toMatch(/cancelled by .+ at /)

      // The unit ends failed / exit-code / 130 — within 20 s (the runner
      // prints its result line and exits the cancel code at its next poll).
      // The unit ends its cancelled run with the runner's cancel exit —
      // within 20 s (the runner prints its result line and exits 130 at its
      // next poll). ExecMainStatus SURVIVES the failed-state settle below;
      // ActiveState and Result do not (the reset clears the failed flag and
      // resets Result), so the exit code is the stable read.
      await expect.poll(async () => sshExec(`systemctl show -p ExecMainStatus --value ${UNIT}`), {
        timeout: 20_000,
        intervals: [1_000],
        message: 'the unit reads the runner\'s cancel exit 130 within 20 s',
      }).toBe('130')

      // 0.4.1: the failed state is settled — within 45 s of the cancel the
      // unit is GONE from `systemctl --failed` (the daemon reset-faileds it
      // once it reads the unit terminal with the cancel exit), while the row
      // keeps reading cancelled below.
      await expect.poll(async () => sshExec('systemctl --failed --no-legend || true'), {
        timeout: 45_000,
        intervals: [2_000],
        message: 'the task unit leaves systemd\'s failed list within 45 s of the cancel',
      }).not.toContain(UNIT)

      // The row reads cancelled — never failure — with the "cancelled by …"
      // note read back from the unit journal.
      await expect.poll(async () => (await backupRowByName(ctx)).lastRunResult, {
        timeout: 20_000,
        intervals: [1_000],
        message: 'the task row reads cancelled',
      }).toBe('cancelled')
      const row = await backupRowByName(ctx)
      expect(row.lastRunNote ?? '', `lastRunNote: ${JSON.stringify(row)}`).toMatch(/cancelled by .+ at /)

      // PBS kept NOTHING from the cancelled run — checked through both doors:
      // the daemon's listing (the API) and the daemon's own command on the
      // node. The group count is unchanged and no point in time exists at or
      // after this run's start (PBS discards the unfinished snapshot).
      const pbcAfter = await pbcSnapshotTimes()
      const apiAfter = await taskSnapshotTimes(ctx)
      expect(pbcAfter.length, `pbc snapshot list: ${JSON.stringify(pbcBefore)} -> ${JSON.stringify(pbcAfter)}`)
        .toBe(pbcBefore.length)
      expect(apiAfter.length, `API snapshots: ${JSON.stringify(apiBefore)} -> ${JSON.stringify(apiAfter)}`)
        .toBe(apiBefore.length)
      expect(pbcAfter.filter(t => t * 1000 >= runStartedAt - 1_000), 'no new point in time on PBS')
        .toEqual([])

      // No transient snapshot left behind: the run's `finally` destroyed the
      // `anas-backup-<task>-<ts>` snapshot it took (recursive, so the whole
      // dataset is swept).
      const transients = await sshExec(`zfs list -H -o name -t snapshot -r ${DATASET} | grep anas-backup- || true`)
      expect(transients.trim(), `transient snapshots on ${DATASET}`).toBe('')

      // The journal window: the cancelled-run line and the audit line — and NO
      // notification trace and NO prune line. The task notifies `always`, so a
      // run that reached the notify path would leave 'notified via target'
      // (calibration run: it did); a run with retention would prune. The
      // cancelled path shows neither.
      const journal = await sshExec(`journalctl -u anasd --since '${runStart}' --no-pager`)
      expect(journal, `anasd journal since ${runStart}`).toContain(`backup task '${TASK}' cancelled — no notification sent`)
      expect(journal).toContain('job.cancelled')
      // The settle's one journald line (0.4.1): the unit left the failed list.
      expect(journal).toContain(`${UNIT} left systemd's failed list`)
      expect(journal).not.toContain('notified via target')
      expect(journal).not.toContain('could not notify')
      expect(journal).not.toContain('pve-notify')
      expect(journal.split('\n').filter(l => l.includes('prune')), 'no prune line in the window').toEqual([])
    }
    finally {
      await ctx.dispose()
    }
  })

  test('2 — the dialog: Cancel run enabled only on a running row, the daemon words the window, Keep running sends nothing, confirming cancels and the row reads cancelled', async ({ page, playwright }) => {
    // The row test 1 left is the gating witness: cancelled ⇒ Cancel run disabled.
    const grid = await openBackupView(page)
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    await expect(row).toContainText('cancelled', { timeout: 30_000 })
    await row.click()
    await expect(grid.locator('.anas-btn-backup-cancel')).toBeDisabled()

    // A fresh run — fresh random bytes, or PBS dedupe would end it in a second.
    await stageSource()
    const ctx = await apiCtx(playwright)
    try {
      const runRes = await ctx.post(`${V1}/backup/tasks/${TASK}/run`, { data: {} })
      expect(runRes.status(), await runRes.text()).toBe(202)

      // In flight: row running with the direct job id, pbc child on the node.
      await expect.poll(async () => {
        const r = await backupRowByName(ctx)
        return r.lastRunResult === 'running' && r.runningJobId ? 'go' : 'wait'
      }, { timeout: 20_000, intervals: [1_000], message: 'the fresh run is in flight' }).toBe('go')
      await expect.poll(async () => (await sshExec(PBC_CHILD)).trim(), {
        timeout: 20_000,
        intervals: [500],
        message: 'the proxmox-backup-client child is on the node',
      }).not.toBe('')
    }
    finally {
      await ctx.dispose()
    }

    // The grid was opened BEFORE the run started — refresh it, then the
    // running row enables the same verb.
    await grid.locator('.anas-btn-backup-refresh').click()
    await expect(row).toContainText('running', { timeout: 30_000 })
    await row.click()
    const cancelBtn = grid.locator('.anas-btn-backup-cancel')
    await expect(cancelBtn).toBeEnabled({ timeout: 15_000 })
    await cancelBtn.click()

    const dlg = page.locator('.anas-win-cancel-run')
    await expect(dlg).toBeVisible({ timeout: 30_000 })
    const dlgText = (await dlg.textContent()) ?? ''
    expect(dlgText, `dialog text: ${dlgText}`).toContain('has been running for')
    expect(dlgText, `dialog text: ${dlgText}`).toContain(CONSEQUENCE)

    // "Keep running" is the default: it takes focus when the window shows…
    await expect.poll(() => page.evaluate(() => {
      const el = document.activeElement
      return el ? (el.textContent ?? '') : ''
    }), { timeout: 5_000, message: 'Keep running takes focus (the default button)' })
      .toContain('Keep running')

    // …and clicking it sends NOTHING: the window closes, the run continues.
    await dlg.locator('.x-btn', { hasText: 'Keep running' }).first().click()
    await expect(dlg).toBeHidden({ timeout: 15_000 })
    const ctx2 = await apiCtx(playwright)
    try {
      expect((await backupRowByName(ctx2)).lastRunResult, 'Keep running left the run alone')
        .toBe('running')
    }
    finally {
      await ctx2.dispose()
    }

    // The real cancel: same door, confirm button inside the window. The run is
    // ~14 s of pbc — the cancel lands while it uploads or right after; either
    // way the row must read cancelled (a cancelled run, never a failure).
    await expect(row).toContainText(/running/, { timeout: 30_000 })
    await cancelBtn.click()
    await expect(dlg).toBeVisible({ timeout: 30_000 })
    await dlg.locator('.x-btn', { hasText: 'Cancel run' }).first().click()

    await expect(page.locator('.x-toast', { hasText: 'Run cancelled' })).toBeVisible({ timeout: 90_000 })
    await expect(row).toContainText('cancelled', { timeout: 90_000 })
  })
})
