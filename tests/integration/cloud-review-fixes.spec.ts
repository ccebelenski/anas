import type { Locator, Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { apiCtx, awaitJob, remoteNames, runJob, taskNames, taskRowByName, V1 } from './fixtures/cloud-api'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * LIVE PROOFS for the 2026-09-25 cloud review-fix batch, over the real daemon
 * on the stunt node (deploy 8590bd0):
 *
 *   1. Token paste normalisation (rclone.1, commit b4c6cfd) — UI: the Add
 *      dialog's token field strips `rclone authorize`'s marker lines and one
 *      layer of JSON-string quotes ON BLUR (the field then shows exactly what
 *      will be sent), marks a paste that never becomes a JSON object with the
 *      inline sentence and disables Test and Save; a Test with the bare object
 *      answers a verdict, never rclone's Go unmarshal error. API: the test
 *      door answers 400 with the same sentence for a non-JSON token, and
 *      serves the probe the normalised object for the marker-wrapped paste.
 *   2. Run-now gate + live runningProgress (rclone.3, commit 77bb58f) — API:
 *      a second Run now on a running task answers 409 naming the run; the
 *      task row carries `runningProgress` ("copy: …"), and BOTH survive past
 *      the 600 s supervision ceiling (the supervising job completes with
 *      status 'running' and the reason naming the row; the progress keeps
 *      updating). UI: the running row shows the pill followed by
 *      "running — copy: …", Run now is disabled with the row selected, the
 *      detail window reads the same, and after the run ends Run now is
 *      enabled again.
 *
 * The long run is ENDED EARLY on purpose (a real Cancel verb is story
 * rclone.5): the fixture's `sigint` sends SIGINT to the daemon's rclone child,
 * the run fails — fine, it is teardown — and the proof is that the row leaves
 * `running` and Run now comes back.
 *
 * BACKUP PARITY (the same two fixes on 68-backup.js / routes/backup.ts) is
 * UNIT-tested only (packages/daemon/src/routes/__tests__/backup.test.ts, the
 * dialog-contracts harness, task-units.test.ts) — this spec deliberately does
 * not build a PBS run.
 *
 * FIXTURE: test/stunt-node/cloud-review-fixture.sh (up / sigint / down) —
 * the loopback sftp user rclonegt, the ~40 MiB source dataset
 * gtbackup/gtgatesrc and the sftp landing area. Unlike cloud-fixture.sh it
 * NEVER touches /etc/anas/rclone.conf: the operator's own remote(s) live in
 * the store on this node, so the spec's remote arrives and leaves through the
 * API (a surgical INI section alongside them). The fixture's task/remote names
 * are its own (gtgate / gtsftp) and nothing else is created, edited or run.
 */

const REMOTE = 'gtsftp'
const TASK = 'gtgate'
const SOURCE = '/gtbackup/gtgatesrc'
const SCHEDULE = '2030-01-01 00:00:00'

/** The exact rclone.authorize output shape the human pass pasted. */
const TOKEN_JSON = '{"access_token":"x","token_type":"Bearer","refresh_token":"y","expiry":"2099-01-01T00:00:00Z"}'
const MARKER_PASTE = [
  'Paste the following into your remote machine --->',
  TOKEN_JSON,
  '<---End paste',
].join('\n')
/** The object wrapped in the quotes of a JSON-encoded string. */
const QUOTED_JSON = '"{\\"access_token\\":\\"x\\"}"'

/** The one inline refusal — identical at both boundaries (Principle 6). */
const OAUTH_TOKEN_ERROR = 'The token must be the JSON block rclone authorize prints, starting with { and ending with }'

/** The Run-now 409's sentence, up to the timestamp. */
const RUN_CONFLICT_PREFIX = `Cloud sync task '${TASK}' is already running since `

/** The supervision ceiling's honest reason, verbatim (task-units.ts). */
const CEILING_REASON = 'the task row shows its progress until it ends'

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-review-fixture.sh', import.meta.url).pathname

/** The task body the long-run test drives. bwlimit 50k on ~40 MiB ≈ 13 min. */
const TASK_BODY: Record<string, unknown> = {
  name: TASK,
  source: SOURCE,
  remote: REMOTE,
  path: 'gtgate-dst',
  mode: 'copy',
  excludes: [],
  bwlimit: '50k',
  notify: 'on-failure',
  // A raw OnCalendar, NOT a cadence: a stale stamp must never self-run this
  // task (the SCHEDULES-GT-17 lesson, cloud-tasks-ui.spec.ts SCHEDULE).
  schedule: SCHEDULE,
  enabled: true,
}

// ---- API helpers -------------------------------------------------------------

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

/**
 * POST the unsaved-dialog test door and NORMALISE its two answer shapes: a
 * 200 wraps the probe verdict in `data` ({ data: { verdict, message } }), a
 * refusal carries `error.message` — reading one field across both shapes once
 * read `undefined` on every success and made the assertion below vacuous.
 */
async function postRemoteTest(
  ctx: Awaited<ReturnType<typeof apiCtx>>,
  options: Record<string, string>,
): Promise<{ status: number, message?: string, verdict?: string }> {
  const res = await ctx.post(`${V1}/cloud/remotes/test`, {
    data: { remote: { name: 'gtdraft', type: 'drive', options } },
  })
  const body = await res.json().catch(() => ({}))
  return {
    status: res.status(),
    message: body?.data?.message ?? body?.error?.message,
    verdict: body?.data?.verdict,
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

/**
 * Pick `drive` in the type combo. The bound-list item renders `<b>drive</b> —
 * Google Drive`, and onedrive is also on the list — the match is anchored to
 * the exact `b` text, never the whole row.
 */
async function pickTypeDrive(page: Page, dlg: Locator): Promise<void> {
  await dlg.locator('.anas-fld-cloud-remote-type input').click()
  const boundList = page.locator('.x-boundlist').last()
  await expect(boundList).toBeVisible({ timeout: 20_000 })
  await boundList
    .locator('.x-boundlist-item', { has: page.locator('b', { hasText: /^drive$/ }) })
    .first()
    .click()
  await expect(dlg.locator('.anas-fld-cloud-opt-token input')).toBeVisible({ timeout: 20_000 })
}

/**
 * The token field's inline invalid text, read where ExtJS renders it: the
 * default qtip msgTarget carries the message on the input's data-errorqtip
 * attribute (with the x-form-invalid class); the component's active error is
 * the fallback.
 */
async function tokenInvalidText(dlg: Locator): Promise<string> {
  const input = dlg.locator('.anas-fld-cloud-opt-token input')
  const qtip = await input.getAttribute('data-errorqtip').catch(() => null)
  if (qtip && qtip.length > 0)
    return qtip
  const inputId = await input.getAttribute('id')
  return dlg.page().evaluate((id) => {
    const ext = (window as unknown as { Ext: { getCmp: (id: string) => any } }).Ext
    const cmp = ext.getCmp(String(id).replace(/-inputEl$/, ''))
    return cmp ? String(cmp.getActiveError?.() ?? '') : ''
  }, inputId as string)
}

// ---- Fixtures -----------------------------------------------------------------

test.beforeAll(async () => {
  // ONCE per worker: down first (a crashed earlier run leaves units, a
  // dataset and a user behind) — best-effort, a wedged down must not mask the
  // up failure — then up, which MUST succeed: a missing fixture means every
  // test below would skip and the suite would read green while proving
  // nothing, so an up failure fails the suite here.
  await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
  await execFileAsync(FIXTURE_SH, ['up'])
})

test.beforeEach(async () => {
  // The fixture user is the "fixture present" signal (as in the other cloud
  // specs). The rclone STORE is deliberately absent from that check: on this
  // node it is never the fixture's business.
  skipIfFixtureMissing(
    !(await sshExec('id -u rclonegt').then(() => true).catch(() => false)),
    `cloud review-fix fixture not present — run ${FIXTURE_SH} up`,
  )
})

test.describe.serial('cloud review-fix live proofs — token paste (rclone.1) + Run-now gate/progress (rclone.3)', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(300_000)

  test.afterAll(async ({ playwright }) => {
    // Teardown even on failure: the spec's OWN task and remote through their
    // API doors (the task first — the remote delete refuses while referenced),
    // then the fixture down. Best-effort — must not mask the run's results.
    const ctx = await apiCtx(playwright).catch(() => null)
    try {
      if (ctx) {
        await ctx.delete(`${V1}/cloud/tasks/${TASK}`).catch(() => {})
        // The task delete is a JOB — the remote delete refuses while the task
        // still references it, so wait until it is really gone (the remote
        // used to survive teardown as a leftover the next run inherited).
        await expect.poll(async () => (await taskNames(ctx)).includes(TASK), {
          timeout: 20_000,
          message: 'the gtgate task is gone before the remote delete',
        }).toBe(false)
        await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`).catch(() => {})
        await ctx.dispose()
      }
    }
    finally {
      await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
    }
  })

  test('1 — token paste in the Add dialog: markers stripped, quotes unwrapped, a plain word marked with Test/Save disabled, and a Test of the object answers a verdict', async ({ page }) => {
    test.setTimeout(300_000)
    const grid = await openTasksView(page)
    await grid.locator('.anas-btn-cloud-remotes').click()
    const win = page.locator('.anas-win-cloud-remotes')
    await expect(win).toBeVisible({ timeout: 30_000 })

    await win.locator('.anas-btn-cloud-remote-add').click()
    const dlg = page.locator('.anas-win-cloud-remote-edit')
    await expect(dlg).toBeVisible({ timeout: 20_000 })
    await dlg.locator('.anas-fld-cloud-remote-name input').fill('gtdrive-paste')
    await pickTypeDrive(page, dlg)

    // The OAuth sentence names the JSON block and the two marker lines — the
    // human-pass finding's first half.
    await expect(dlg.locator('.anas-cloud-oauth')).toContainText('paste only the JSON block')
    await expect(dlg.locator('.anas-cloud-oauth')).toContainText('Paste the following')

    const token = dlg.locator('.anas-fld-cloud-opt-token input')

    // The whole rclone authorize output: the field comes back holding EXACTLY
    // the JSON object — the bytes that will be sent.
    await token.fill(MARKER_PASTE)
    await token.blur()
    await expect(token).toHaveValue(TOKEN_JSON, { timeout: 10_000 })

    // The object wrapped in the quotes of a JSON-encoded string: unwrapped once.
    await token.fill(QUOTED_JSON)
    await token.blur()
    await expect(token).toHaveValue('{"access_token":"x"}', { timeout: 10_000 })

    // A plain word never becomes a JSON object: the inline sentence, and
    // Test and Save wait for a valid paste.
    await token.fill('hello')
    await token.blur()
    await expect(token).toHaveValue('hello', { timeout: 10_000 })
    expect(await tokenInvalidText(dlg), 'the field marks the paste inline').toContain(OAUTH_TOKEN_ERROR)
    await expect(dlg.locator('.anas-btn-cloud-remote-testconn')).toBeDisabled()
    await expect(dlg.locator('.anas-btn-cloud-remote-save')).toBeDisabled()

    // The bare object: Test runs — and the verdict is an AUTH answer against
    // Google (the object's fake credentials), never rclone's Go unmarshal
    // error the un-normalised paste produced. This remote is NEVER saved.
    await token.fill(TOKEN_JSON)
    await token.blur()
    await expect(token).toHaveValue(TOKEN_JSON, { timeout: 10_000 })
    await expect(dlg.locator('.anas-btn-cloud-remote-testconn')).toBeEnabled({ timeout: 10_000 })
    await dlg.locator('.anas-btn-cloud-remote-testconn').click()
    const verdict = dlg.locator('.anas-cloud-test-verdict')
    await expect(verdict).toBeVisible({ timeout: 90_000 })
    const verdictText = (await verdict.textContent()) ?? ''
    expect(verdictText, `verdict was: ${verdictText}`).not.toContain('cannot unmarshal')

    await dlg.locator('.x-btn', { hasText: 'Cancel' }).click()
    await expect(dlg).toBeHidden({ timeout: 20_000 })
    await expect(win.locator('.x-grid-row', { hasText: /^gtdrive-paste/ })).toHaveCount(0)
  })

  test('2 — token paste at the API: the test door refuses a non-JSON token with the sentence and normalises the marker-wrapped paste', async ({ playwright }) => {
    const ctx = await apiCtx(playwright)
    try {
      const refused = await postRemoteTest(ctx, { token: 'hello' })
      expect(refused.status, JSON.stringify(refused)).toBe(400)
      expect(refused.message).toBe(OAUTH_TOKEN_ERROR)

      // The marker-wrapped paste is NOT a 400 — normalisation ran and the
      // probe was served the bare object. Against Google with fake
      // credentials the probe answers a VERDICT (ground truth 2026-09-26:
      // verdict `auth`, message `Reason: authError, Message: Invalid
      // Credentials`) — an auth-shaped sentence, never the Go unmarshal error
      // the verbatim paste produced. The verdict is asserted DEFINED: this
      // assertion used to sit behind `if (verdict !== undefined)` and read an
      // always-undefined message, checking an empty string.
      const normalised = await postRemoteTest(ctx, { token: MARKER_PASTE })
      expect(normalised.status, JSON.stringify(normalised)).toBe(200)
      expect(normalised.verdict, `verdict: ${JSON.stringify(normalised)}`).toBe('auth')
      expect(normalised.message ?? '', `message: ${JSON.stringify(normalised)}`)
        .toMatch(/Invalid Credentials|authError/)
      expect(normalised.message ?? '').not.toContain('cannot unmarshal')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('3 — Run now gates a running run with 409, runningProgress rides the row past the supervision ceiling, and Run now comes back when the run ends', async ({ page, playwright }) => {
    // The gate + progress story rides one REAL run: ~40 MiB at --bwlimit 50k
    // is ~13 minutes of rclone — well past the 600 s supervision ceiling.
    test.setTimeout(1_500_000)

    const ctx = await apiCtx(playwright)
    let superviseJobId = ''
    try {
      await createRemoteViaApi(ctx)
      await createTaskViaApi(ctx)

      // Run now (the UI path — no `direct` flag): 202, the supervising job.
      const res = await ctx.post(`${V1}/cloud/tasks/${TASK}/run`, { data: {} })
      expect(res.status(), await res.text()).toBe(202)
      superviseJobId = (await res.json()).job.id

      // The run is in flight: the unit goes active and the row reads running.
      await expect.poll(async () => (await taskRowByName(ctx, TASK)).lastRunResult, {
        timeout: 60_000,
        message: 'the task row reads running once the unit starts',
      }).toBe('running')

      // Finding 1 — the SECOND Run now is refused at the door with the run
      // named (the sentence prefixes the "since <time>" timestamp).
      const again = await ctx.post(`${V1}/cloud/tasks/${TASK}/run`, { data: {} })
      expect(again.status(), await again.text()).toBe(409)
      const conflict = (await again.json()).error.message
      expect(conflict, conflict).toContain(RUN_CONFLICT_PREFIX)
      expect(conflict, conflict).toContain('it continues under systemd — wait for it to finish')

      // Finding 2 — the live progress rides the row within the first stats
      // interval (rclone's "copy: …" line, verbatim).
      await expect.poll(async () => (await taskRowByName(ctx, TASK)).runningProgress ?? '', {
        timeout: 60_000,
        message: 'runningProgress ("copy: …") on the task row within 60 s',
      }).toContain('copy:')
    }
    finally {
      await ctx.dispose()
    }

    // The UI half, while the run is live: the row shows the running pill
    // followed by the progress, Run now is disabled with the row selected,
    // and the detail window reads the same line.
    const grid = await openTasksView(page)
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    await expect(row).toContainText(/running — copy:/, { timeout: 30_000 })

    await row.click()
    await expect(grid.locator('.anas-btn-cloud-task-run')).toBeDisabled()

    await grid.locator('.anas-btn-cloud-task-details').click()
    const detail = page.locator('.anas-win-cloud-task-detail')
    await expect(detail).toBeVisible({ timeout: 30_000 })
    await expect(detail).toContainText(/running — copy:/, { timeout: 30_000 })
    await detail.locator('.x-tool-close').click()
    await expect(detail).toBeHidden({ timeout: 15_000 })

    // Past the 600 s ceiling: the supervising job completes TRUTHFULLY with
    // status 'running' and the reason naming the row — the run continues
    // under systemd, and the progress keeps updating.
    const ctx2 = await apiCtx(playwright)
    try {
      const job = await awaitJob(ctx2, superviseJobId, 780_000)
      expect(job.status, job.error).toBe('completed')
      expect(job.result?.status, JSON.stringify(job.result)).toBe('running')
      expect(job.result?.reason ?? '', 'the ceiling reason').toContain(CEILING_REASON)

      // …and runningProgress is STILL present and STILL updating: two reads
      // 15 s apart differ (a boundary-tolerant read — rclone publishes stats
      // every 30 s, so a 15 s gap straddles one within three samples).
      await expect.poll(async () => (await taskRowByName(ctx2, TASK)).runningProgress ?? '', {
        timeout: 60_000,
        message: 'runningProgress survives the ceiling',
      }).toContain('copy:')
      const progressAt = async () => (await taskRowByName(ctx2, TASK)).runningProgress ?? ''
      const samples = [await progressAt()]
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 15_000))
        samples.push(await progressAt())
        if (samples[i] !== samples[i + 1])
          break
      }
      const changed = samples.some((s, i) => i > 0 && s !== samples[i - 1] && s !== '')
      expect(changed, `progress samples: ${JSON.stringify(samples)}`).toBe(true)
    }
    finally {
      await ctx2.dispose()
    }

    // End the run without waiting the ~13 minutes out: SIGINT to the
    // daemon's rclone child (a real Cancel verb is story rclone.5 — the run
    // failing here is fine, it is teardown). The unit leaves activating, the
    // row leaves running, and Run now comes back.
    await execFileAsync(FIXTURE_SH, ['sigint'])
    const unitState = await sshExec('for i in $(seq 1 24); do '
      + 's=$(systemctl show -p ActiveState --value anas-cloud-gtgate.service); '
      + '[ "$s" != "activating" ] && [ "$s" != "active" ] && echo "$s" && exit 0; sleep 5; done; '
      + 'systemctl show -p ActiveState --value anas-cloud-gtgate.service')
    expect(['inactive', 'failed'], `unit state after SIGINT: ${unitState}`).toContain(unitState)
    const ctx3 = await apiCtx(playwright)
    try {
      await expect.poll(async () => {
        const r = await taskRowByName(ctx3, TASK)
        return `${r.lastRunResult}|${r.runningProgress ?? ''}`
      }, { timeout: 120_000, message: 'the row leaves running once the killed run ends' })
        .not
        .toContain('running|')

      // The UI agrees on the SAME grid this test already opened (a second
      // openTasksView would re-run the login form on an
      // already-authenticated page, which PVE never shows again): a refresh
      // shows the ended run and Run now enabled again with the row selected.
      await grid.locator('.anas-btn-cloud-refresh').click()
      const row2 = taskRow(page, grid, TASK)
      await expect(row2).toBeVisible({ timeout: 45_000 })
      await expect(row2).toContainText('failure', { timeout: 60_000 })
      await expect(row2).not.toContainText('copy:')
      await row2.click()
      await expect(grid.locator('.anas-btn-cloud-task-run')).toBeEnabled()
    }
    finally {
      await ctx3.dispose()
    }
  })
})
