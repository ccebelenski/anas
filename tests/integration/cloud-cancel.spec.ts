import type { Locator, Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { apiCtx, awaitJob, getJob, remoteNames, runJob, taskNames, taskRowByName, V1 } from './fixtures/cloud-api'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * LIVE PROOFS for story rclone.5 "Cancel a running run" (commit bfe050c) and
 * the runner-poll fix (commit 3ed1831), over the real daemon on the stunt node
 * (deploy fdcbbd9):
 *
 *   1. The cancel ladder, end to end — Run now, the running row carrying
 *      `runningJobId`, POST /v1/jobs/:id/cancel answered 409 with
 *      `X-Anas-Confirm-Code` and the headline ("… has been running for …;
 *      cancelling stops it here") plus the consequence sentence in `warnings`,
 *      the replay with the code → 202 `job.cancel`, the rclone child GONE
 *      within 5 s, the direct job `cancelled` with "cancelled by <user> at
 *      <time>", the unit failed with ExecMainStatus=130, the row reading
 *      `cancelled` with `lastRunNote`, a PARTIAL destination, one journald
 *      "cancelled — no notification sent" line + the `job.cancelled` audit
 *      line, and no notification attempt in the daemon's journal.
 *   2. The refusals — a finished job (409 naming its final state, NO code), a
 *      cancel of the supervising Run-now job (409 NOT_CANCELLABLE), and a
 *      replayed (consumed) confirm code against a new target → a fresh 409
 *      with a NEW code.
 *   3. The dialog — the toolbar's Cancel run on a selected running row opens
 *      the daemon-worded confirm window, "Keep running" is the default (it
 *      takes focus, and clicking it sends nothing — the run continues);
 *      confirming ends the run, toasts "Run cancelled" and the row reads
 *      cancelled after the door's reload.
 *   4. The runner-poll fix — `systemctl restart anasd` mid-run (the job queue
 *      is in-memory; the child died with the daemon) ends the unit `failed`
 *      within 60 s — never stuck `activating` — with the interruption sentence
 *      in the unit journal, the row reading `failure`, and Run now answering
 *      202 again; the gateway came back with the daemon (PartOf).
 *
 * Runs are kept SHORT on purpose: ~12 MiB in 6 files at --bwlimit 200k is
 * about a minute of rclone, so every cancel lands while the run is still
 * copying and the destination ends partial. The one teardown-only SIGINT (test
 * 4's cleanup) goes through the fixture's `sigint` and is allowed to fail the
 * run — the cancel verb itself is what tests 1–3 prove.
 *
 * FIXTURE: test/stunt-node/cloud-review-fixture.sh (profile `cancel` — up /
 * sigint / down): the loopback sftp user rclonegt (SHARED with the review-fix
 * profile, which is why `down cancel` leaves the user when that profile still
 * has state on the node), the gtbackup/gtcancelsrc dataset (6 x 2 MiB) and the
 * sftp landing area. Like the review-fix profile it NEVER touches
 * /etc/anas/rclone.conf: the spec's remote arrives and leaves through the API.
 * The operator's own remote (gtest) and task (testoff) are asserted present at
 * teardown — nothing here ever runs, edits or removes them.
 */

const REMOTE = 'gtcancelsftp'
const TASK = 'gtcancel'
const SOURCE = '/gtbackup/gtcancelsrc'
const SCHEDULE = '2030-01-01 00:00:00'
const UNIT = `anas-cloud-${TASK}.service`
const DST_DIR = `/home/rclonegt/${TASK}-dst`
const SRC_FILE_COUNT = 6

/** The consequence sentence, verbatim from the rclone.5 story (cloud.ts). */
const CONSEQUENCE = 'Files already copied stay at the destination. A sync run stopped '
  + 'part-way leaves the destination between two states until the next run completes.'

/** The cancel headline's shape for this task (jobs.ts cancelHeadline). */
const HEADLINE_RE = /^Cloud sync task 'gtcancel' has been running for .+; cancelling stops it here$/

/**
 * The runner-poll fix's interruption sentence, verbatim (runner-poll.ts) —
 * the unit journal carries it, and so does the row's Last-run tooltip.
 */
const INTERRUPTED_RE = /no longer exists: the daemon restarted while the run was in progress, so the run was interrupted and must be started again/

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-review-fixture.sh', import.meta.url).pathname

/**
 * pgrep pattern for the run's rclone child. The alternation is split
 * (`copy|sy` + `nc`) so THIS ssh command's own bash cmdline — which contains
 * the pattern verbatim — can never match itself; a real `rclone copy|sync`
 * argv still matches.
 */
const RCLONE_CHILD = `pgrep -af 'rclone (copy|sy)nc' || true`

/** The task body the cancel tests drive. bwlimit 200k on ~12 MiB ≈ 60 s. */
const TASK_BODY: Record<string, unknown> = {
  name: TASK,
  source: SOURCE,
  remote: REMOTE,
  path: `${TASK}-dst`,
  mode: 'copy',
  excludes: [],
  bwlimit: '200k',
  notify: 'on-failure',
  // A raw OnCalendar, NOT a cadence: a stale stamp must never self-run this
  // task (the SCHEDULES-GT-17 lesson, cloud-tasks-ui.spec.ts SCHEDULE).
  schedule: SCHEDULE,
  enabled: true,
}

// ---- State carried along the serial ladder ------------------------------------

/** The happy path's direct job id and its (consumed) confirm code. */
let directJobId1 = ''
let consumedCode1 = ''

// ---- API helpers --------------------------------------------------------------

async function createRemoteViaApi(ctx: Awaited<ReturnType<typeof apiCtx>>): Promise<void> {
  if (!(await remoteNames(ctx)).includes(REMOTE)) {
    await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
      name: REMOTE,
      type: 'sftp',
      options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' },
    })
  }
}

async function createTaskViaApi(ctx: Awaited<ReturnType<typeof apiCtx>>): Promise<void> {
  if (!(await taskNames(ctx)).includes(TASK)) {
    await runJob(ctx, 'post', `${V1}/cloud/tasks`, TASK_BODY)
  }
}

/** Run now (the UI path — no `direct` flag): 202, the supervising job. */
async function startRun(ctx: Awaited<ReturnType<typeof apiCtx>>): Promise<string> {
  const res = await ctx.post(`${V1}/cloud/tasks/${TASK}/run`, { data: {} })
  expect(res.status(), await res.text()).toBe(202)
  return (await res.json()).job.id
}

/**
 * Wait for the run to be IN FLIGHT and COPYING: the row reads `running` with
 * the direct job id and live rclone stats ("copy: …") — then one stats
 * interval more, until the progress line has MOVED. The cancel must land
 * mid-transfer (the partial-destination proof needs bytes already across), not
 * during rclone's listing phase — the direct job publishes progress before
 * rclone spawns (gate detail lines), which is exactly what a premature cancel
 * would ride (run 1: the destination ended empty).
 */
async function waitRunning(ctx: Awaited<ReturnType<typeof apiCtx>>): Promise<string> {
  await expect.poll(async () => {
    const row = await taskRowByName(ctx, TASK)
    return row.lastRunResult === 'running' && row.runningJobId && row.runningProgress?.includes('copy:')
      ? 'go'
      : 'wait'
  }, { timeout: 30_000, message: 'the row reads running with live "copy:" progress + runningJobId' }).toBe('go')
  const directId = (await taskRowByName(ctx, TASK)).runningJobId as string
  const firstProgress = (await taskRowByName(ctx, TASK)).runningProgress ?? ''
  await expect.poll(async () => (await taskRowByName(ctx, TASK)).runningProgress ?? '', {
    timeout: 30_000,
    message: 'the live progress moved past the first stats sample',
  }).not.toBe(firstProgress)
  return directId
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

// ---- UI helpers ---------------------------------------------------------------

/** Select the node, open the Cloud Sync menu, wait for the tasks grid. */
async function openTasksView(page: Page): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Cloud Sync')
  const grid = page.locator('.anas-grid-cloud-tasks')
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

test.beforeAll(async () => {
  // ONCE per worker: down first (a crashed earlier run leaves units, a
  // dataset and a user behind), then up — the `cancel` profile. Neither
  // touches the rclone store.
  await execFileAsync(FIXTURE_SH, ['down', 'cancel']).catch(() => {})
  await execFileAsync(FIXTURE_SH, ['up', 'cancel']).catch(() => {})
})

test.beforeEach(async () => {
  // The fixture user is the "fixture present" signal (as in the other cloud
  // specs). The rclone STORE is deliberately absent from that check: on this
  // node it is never the fixture's business.
  test.skip(
    !(await sshExec('id -u rclonegt').then(() => true).catch(() => false)),
    `cloud cancel fixture not present — run ${FIXTURE_SH} up cancel`,
  )
})

test.describe.serial('cloud cancel live proofs — the rclone.5 cancel ladder + the runner-poll restart fix', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(300_000)

  test.afterAll(async ({ playwright }) => {
    // Teardown even on failure: end any run the spec left (SIGINT — allowed to
    // fail the run, it is teardown), remove the spec's OWN task and remote
    // through their API doors (the task first — the remote delete refuses
    // while referenced), then the fixture down. Best-effort throughout — the
    // operator-survival assertions at the end must not be masked.
    await execFileAsync(FIXTURE_SH, ['sigint', 'cancel']).catch(() => {})
    const ctx = await apiCtx(playwright).catch(() => null)
    try {
      if (ctx) {
        await ctx.delete(`${V1}/cloud/tasks/${TASK}`).catch(() => {})
        await expect.poll(async () => (await taskNames(ctx)).includes(TASK), {
          timeout: 20_000,
          message: 'the gtcancel task is gone before the remote delete',
        }).toBe(false)
        await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`).catch(() => {})
      }
    }
    catch {
      // best-effort — the fixture down below removes the units either way
    }
    finally {
      ctx?.dispose()
      await execFileAsync(FIXTURE_SH, ['down', 'cancel']).catch(() => {})
    }

    // The operator's own remote and task survived everything this spec did —
    // the one thing the node rules make non-negotiable.
    const ctx2 = await apiCtx(playwright)
    try {
      expect(await remoteNames(ctx2), `remotes after teardown: ${JSON.stringify(await remoteNames(ctx2))}`)
        .toContain('gtest')
      expect(await taskNames(ctx2), `tasks after teardown: ${JSON.stringify(await taskNames(ctx2))}`)
        .toContain('testoff')
    }
    finally {
      await ctx2.dispose()
    }
  })

  test('1 — the cancel ladder: 409 + code, replay 202, SIGINT lands (child gone, exit 130), cancelled row with its note, a partial destination, and no notification', async ({ playwright }) => {
    const ctx = await apiCtx(playwright)
    try {
      await createRemoteViaApi(ctx)
      await createTaskViaApi(ctx)

      // The journal window every anasd-side assertion below reads.
      const runStart = await sshExec('date -Is')

      const superviseJobId = await startRun(ctx)
      const directId = await waitRunning(ctx)
      expect(superviseJobId, 'the supervising job is a different job than the direct one').not.toBe(directId)
      directJobId1 = directId

      // The first call is the confirm challenge: 409 with the code header, the
      // headline naming the task, its elapsed time and its progress — and the
      // consequence sentence in warnings.
      const challenge = await postCancel(ctx, directId)
      expect(challenge.status, JSON.stringify(challenge)).toBe(409)
      expect(challenge.codeHeader, 'X-Anas-Confirm-Code on the challenge').toBeTruthy()
      expect(challenge.message ?? '', challenge.message).toMatch(HEADLINE_RE)
      expect(challenge.warnings ?? [], `warnings: ${JSON.stringify(challenge.warnings)}`).toContain(CONSEQUENCE)
      consumedCode1 = challenge.codeHeader as string

      // The replay with the code submits the job.cancel CONTROL job — the
      // 202 body names it, and it completes once the hook has stopped the run.
      const replayRes = await ctx.post(`${V1}/jobs/${directId}/cancel`, {
        data: {},
        headers: { 'x-anas-confirm': consumedCode1 },
      })
      expect(replayRes.status(), await replayRes.text()).toBe(202)
      const cancelJobId = (await replayRes.json()).job.id
      const cancelJob = await awaitJob(ctx, cancelJobId, 30_000)
      expect(cancelJob.status, cancelJob.error).toBe('completed')

      // The child is gone within 5 s of the cancel landing.
      await expect.poll(async () => sshExec(RCLONE_CHILD), {
        timeout: 5_000,
        message: 'no rclone copy/sync child within 5 s of the cancel',
      }).toBe('')

      // The direct job ended `cancelled` — additive status, error null, the
      // reason naming who cancelled and when.
      await expect.poll(async () => (await getJob(ctx, directId)).job?.status, {
        timeout: 30_000,
        message: 'the direct run job reaches cancelled',
      }).toBe('cancelled')
      const directJob = (await getJob(ctx, directId)).job
      expect(directJob.error ?? null, 'a cancelled job carries no error').toBeNull()
      const reason = directJob.result?.reason ?? directJob.reason ?? ''
      expect(reason, `reason: ${JSON.stringify(directJob.result ?? directJob)}`).toMatch(/cancelled by .+ at /)

      // The unit ends failed / exit-code / 130 — within 20 s (the runner
      // prints its result line and exits the cancel code at its next poll).
      await expect.poll(async () => sshExec(`systemctl show -p ActiveState --value ${UNIT}`), {
        timeout: 20_000,
        message: 'the unit leaves activating/active and reads failed within 20 s',
      }).toBe('failed')
      const props = await sshExec(`systemctl show ${UNIT} -p ActiveState,Result,ExecMainStatus`)
      expect(props).toContain('ActiveState=failed')
      expect(props).toContain('Result=exit-code')
      expect(props).toContain('ExecMainStatus=130')

      // The row reads cancelled — never failure — with the "cancelled by …"
      // note read back from the unit journal.
      await expect.poll(async () => (await taskRowByName(ctx, TASK)).lastRunResult, {
        timeout: 20_000,
        message: 'the task row reads cancelled',
      }).toBe('cancelled')
      const row = await taskRowByName(ctx, TASK)
      expect(row.lastRunNote ?? '', `lastRunNote: ${JSON.stringify(row)}`).toMatch(/cancelled by .+ at /)

      // The destination is PARTIAL: the in-flight copy got at least one file
      // across before the SIGINT, and not all six (a full destination would
      // mean the cancel never reached the child).
      const copied = Number(await sshExec(`find ${DST_DIR} -maxdepth 1 -type f | wc -l`))
      expect(copied, `${copied} of ${SRC_FILE_COUNT} files at ${DST_DIR}`).toBeGreaterThanOrEqual(1)
      expect(copied, `${copied} of ${SRC_FILE_COUNT} files at ${DST_DIR}`).toBeLessThan(SRC_FILE_COUNT)

      // The journal window: the cancelled-run line, the audit line — and NO
      // notification trace. The task notifies on-failure, so a run that went
      // through the notify path would leave the daemon's only notification
      // trace (a pve-notify attempt/error line — a successful emission leaves
      // no anasd journal line at all); the cancelled path must show none.
      const journal = await sshExec(`journalctl -u anasd --since '${runStart}' --no-pager`)
      expect(journal, `anasd journal since ${runStart}`).toContain(`cloud sync task '${TASK}' cancelled — no notification sent`)
      expect(journal).toContain('job.cancelled')
      expect(journal).not.toContain('pve-notify')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('2 — the refusals: a finished job, the supervising job, and a consumed code answered with a fresh one', async ({ playwright }) => {
    const ctx = await apiCtx(playwright)
    try {
      // (a) The happy path's direct job is over: the cancel names its final
      // state and mints NO code (the refusal comes before the gate).
      const finished = await postCancel(ctx, directJobId1)
      expect(finished.status, JSON.stringify(finished)).toBe(409)
      expect(finished.errorCode).toBe('CONFLICT')
      expect(finished.message ?? '', finished.message).toContain('already ended')
      expect(finished.codeHeader, 'no confirm code on a finished job').toBeUndefined()

      // A fresh run, for the two live-target refusals.
      const superviseJobId = await startRun(ctx)
      const directId = await waitRunning(ctx)

      // (b) The supervising Run-now job registers no hook: 409
      // NOT_CANCELLABLE, again without a code.
      const supervise = await postCancel(ctx, superviseJobId)
      expect(supervise.status, JSON.stringify(supervise)).toBe(409)
      expect(supervise.errorCode).toBe('NOT_CANCELLABLE')
      expect(supervise.message ?? '', supervise.message).toContain('cannot be cancelled')
      expect(supervise.codeHeader, 'no confirm code on a not-cancellable job').toBeUndefined()

      // (c) The consumed code from test 1 replayed against this new target:
      // the signature (operation + THIS job id) no longer matches — a fresh
      // 409 carries a NEW code, not the used one.
      const reused = await postCancel(ctx, directId, consumedCode1)
      expect(reused.status, JSON.stringify(reused)).toBe(409)
      expect(reused.errorCode).toBe('CONFIRMATION_REQUIRED')
      expect(reused.codeHeader, 'a fresh code is minted').toBeTruthy()
      expect(reused.codeHeader, 'the fresh code is not the consumed one').not.toBe(consumedCode1)

      // Clean up the run the refusals started — the real ladder.
      const cleanup = await postCancel(ctx, directId, reused.codeHeader)
      expect(cleanup.status, JSON.stringify(cleanup)).toBe(202)
      await expect.poll(async () => (await taskRowByName(ctx, TASK)).lastRunResult, {
        timeout: 60_000,
        message: 'the refusal test run ends cancelled',
      }).toBe('cancelled')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('3 — the dialog: the daemon words the confirm window, Keep running sends nothing, confirming cancels and the row reads cancelled', async ({ page, playwright }) => {
    const ctx = await apiCtx(playwright)
    try {
      await createRemoteViaApi(ctx)
      await createTaskViaApi(ctx)
      await startRun(ctx)
      await waitRunning(ctx)
    }
    finally {
      await ctx.dispose()
    }

    const grid = await openTasksView(page)
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    await row.click()

    // The toolbar verb is gated exactly like the daemon: enabled only on a
    // running row whose direct job is named.
    const cancelBtn = grid.locator('.anas-btn-cloud-task-cancel')
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
      expect((await taskRowByName(ctx2, TASK)).lastRunResult, 'Keep running left the run alone')
        .toBe('running')
    }
    finally {
      await ctx2.dispose()
    }

    // The real cancel: same door, confirm button inside the window.
    await expect(row).toContainText(/running — copy:/, { timeout: 30_000 })
    await cancelBtn.click()
    await expect(dlg).toBeVisible({ timeout: 30_000 })
    await dlg.locator('.x-btn', { hasText: 'Cancel run' }).first().click()

    // The toast names the verb; the row reads cancelled after the door's
    // reload (completion reload + the 12 s second reload).
    await expect(page.locator('.x-toast', { hasText: 'Run cancelled' })).toBeVisible({ timeout: 90_000 })
    await expect(row).toContainText('cancelled', { timeout: 90_000 })
  })

  test('4 — the runner-poll fix: a daemon restart mid-run ends the unit failed with the interruption sentence, and Run now comes back', async ({ playwright }) => {
    const ctx = await apiCtx(playwright)
    let restartedAt = ''
    try {
      await createRemoteViaApi(ctx)
      await createTaskViaApi(ctx)
      await startRun(ctx)
      await waitRunning(ctx)

      // The restart, and the timestamp every journal window below reads.
      restartedAt = await sshExec('date -Is')
      await sshExec('systemctl restart anasd')

      // The daemon is back when /v1/health answers over its socket — the
      // deploy script's own verification approach (is-active alone lies:
      // a crash-looping unit reads active between crashes).
      await expect.poll(async () => sshExec(
        'curl -sf --max-time 2 --unix-socket /run/anas/anasd.sock http://localhost/v1/health >/dev/null 2>&1 && echo up || echo down',
      ), { timeout: 90_000, message: 'anasd /v1/health answers after the restart' }).toBe('up')

      // The gateway came back WITH the daemon (PartOf=anasd.service).
      expect(await sshExec('systemctl is-active anas'), 'the gateway after the daemon restart').toBe('active')
    }
    finally {
      await ctx.dispose()
    }

    // The unit ENDS — failed, never stuck activating (the pre-fix failure
    // mode was a 24 h poll of a job id that can never come back).
    await expect.poll(async () => sshExec(`systemctl show -p ActiveState --value ${UNIT}`), {
      timeout: 90_000,
      message: 'the unit ends failed within 60 s of the restart — never stuck activating',
    }).toBe('failed')

    // The unit journal carries the interruption sentence, verbatim.
    const unitJournal = await sshExec(`journalctl -u ${UNIT} --since '${restartedAt}' --no-pager`)
    expect(unitJournal, `unit journal since ${restartedAt}`).toMatch(INTERRUPTED_RE)

    // The row reads failure — not running, not cancelled: the run was
    // interrupted, it did not stop on purpose.
    const ctx2 = await apiCtx(playwright)
    try {
      await expect.poll(async () => (await taskRowByName(ctx2, TASK)).lastRunResult, {
        timeout: 30_000,
        message: 'the task row reads failure after the restart',
      }).toBe('failure')
      const row = await taskRowByName(ctx2, TASK)
      expect(row.runningProgress, 'no live progress on an interrupted row').toBeUndefined()
      expect(row.runningJobId, 'no direct job named on an interrupted row').toBeUndefined()

      // Run now answers 202 again — the pre-fix trap was a 409 with nothing
      // running behind it and no cancel possible.
      const res = await ctx2.post(`${V1}/cloud/tasks/${TASK}/run`, { data: {} })
      expect(res.status(), await res.text()).toBe(202)
    }
    finally {
      await ctx2.dispose()
    }

    // End the run the restart just started: SIGINT through the fixture —
    // allowed to FAIL the run, it is teardown (the real verb is tests 1–3).
    await execFileAsync(FIXTURE_SH, ['sigint', 'cancel'])
    await expect.poll(async () => sshExec(`systemctl show -p ActiveState --value ${UNIT}`), {
      timeout: 60_000,
      message: 'the teardown run ends',
    }).not.toBe('active')
  })
})
