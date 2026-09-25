import type { APIRequestContext, Locator, Page, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story rclone.3 (Cloud sync — the Cloud Sync workflow) — UI ACCEPTANCE over
 * the real PVE UI on the stunt node. Companion to cloud-remotes-ui.spec.ts
 * (rclone.1's Remotes manager) and the cloud-tasks daemon halves' own spec;
 * this file exercises packages/pve-integration/src/72-cloud.js the way a user
 * meets it, per DESIGN.md "Cloud sync — rclone" → Workflow:
 *
 *   1. Create through the wizard — every toolbar button is on the bar at this
 *      viewport, Browse hands the source back through the shared path picker,
 *      the nested-filesystems note renders from preview-nested for the picked
 *      source (the source dataset has a CHILD dataset: what a snapshot will
 *      NOT contain, said BEFORE the save), the Mode radios carry the sync
 *      sentence with Copy the default, and the saved row lands selected with
 *      its `remote:path` destination.
 *   2. Run now → the run rides the dashboard jobs strip (ANAS.runJob) and the
 *      row's Last run pill refreshes to `success` on completion.
 *   3. The empty-source `sync` refusal: the daemon's sentence, shown in the
 *      job-failure dialog, verbatim.
 *   4. An injected failure (a stand-in `/usr/bin/rclone` exiting 7) → the
 *      failure surfaces with rclone's error line, and the grid still reloads
 *      (the 0.3.3 lesson) with the failed Last run cell red, the error line
 *      as its tooltip.
 *   5. Remotes… opens the rclone.1 window from the tasks toolbar.
 *   6. Removing a remote that a task references is refused (409), the refusal
 *      naming the task.
 *   7. A disabled task's detail shows the history note.
 *   8. The Preview rider (rclone.3, operator 2026-09-24): the wizard's dry run
 *      of the unsaved form — with one source file deleted after a copy sits at
 *      the destination, the summary line under the Mode field names that file
 *      under the would-be deletes — and the grid toolbar's Preview of the
 *      saved task in the display-only window, the same renderer.
 *
 * FIXTURE DEPENDENCY (written alongside this spec):
 * `test/stunt-node/cloud-tasks-fixture.sh` — `up` / `down`, the same capture
 * pre-state / restore posture as cloud-fixture.sh. It creates:
 *   - the dataset `gtbackup/cloudsrc` mounted at `/gtbackup/cloudsrc` WITH an
 *     EMPTY child dataset `gtbackup/cloudsrc/raw` (the nested note needs a
 *     nested filesystem to name; empty because the API spec lists the files
 *     under the source and a file in the child would change that list),
 *   - the sftp user `rclonegt` (password `gtpass`) the `gt` remote points at.
 * The remote `gt` and the tasks themselves are created through their own API
 * doors here (the UI's create is proven in test 1, the Remotes window's in
 * cloud-remotes-ui.spec.ts). Every test leaves the node as found: the
 * fixture's `down` restores the captured state of the task units and
 * /etc/anas/rclone.conf and removes the fixture user and dataset.
 * Runs at 2560×1080 (toolbar overflow rule, as pvepool.2 / smbsvc-ui).
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const RCLONE_BIN = '/usr/bin/rclone'
const RCLONE_BAK = '/usr/bin/rclone.anas-spec-bak'
const EMPTY_SOURCE = '/tmp/anas-gt-empty-source'

const REMOTE = 'gt'
const REMOTE_USER = 'rclonegt'
const REMOTE_PASS = 'gtpass'
const SOURCE = '/gtbackup/cloudsrc'
const NESTED = `${SOURCE}/raw`
const TASK = 'pictures-offsite'

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-tasks-fixture.sh', import.meta.url).pathname

/** A copy of the fixture task, the shape the wizard itself sends. */
const TASK_BODY: Record<string, unknown> = {
  name: TASK,
  source: SOURCE,
  remote: REMOTE,
  path: 'pictures',
  mode: 'copy',
  excludes: [],
  notify: 'on-failure',
  cadence: { kind: 'weekly', days: ['Mon'], time: '02:00' },
  enabled: true,
}

// ---- API helpers (request contexts carrying the PVE cookie) ----------------

function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: {
      cookies: [{
        name: 'PVEAuthCookie',
        value: ticket,
        domain: new URL(PVE_URL).hostname,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      }],
      origins: [],
    },
  })
}

async function pveTicket(playwright: PlaywrightWorkerArgs['playwright']): Promise<string | null> {
  const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
  try {
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    const ok = ticketRes.ok()
    const ticket = ok ? ((await ticketRes.json()).data.ticket as string) : null
    return ticket
  }
  finally {
    await login.dispose()
  }
}

/** Ticket + request context in one step — every test's setup door. */
async function apiCtx(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  const ticket = await pveTicket(playwright)
  expect(ticket, 'PVE ticket for API setup').toBeTruthy()
  return authedContext(playwright, ticket as string)
}

/** Poll a 202 job through GET /v1/jobs/:id until it completes or fails. */
async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 90_000,
): Promise<{ status: string, error?: string, [k: string]: any }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${job.error ?? job.progress ?? ''}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Submit a mutation, wait for its job, and require it to complete. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
): Promise<void> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id)
  expect(job.status, job.error).toBe('completed')
}

/** Create the sftp remote through its own API door (this spec's setup). */
async function createGtViaApi(ctx: APIRequestContext): Promise<void> {
  const res = await ctx.get(`${V1}/cloud/remotes`)
  const names: string[] = res.ok()
    ? (await res.json()).data.remotes.map((r: { name: string }) => r.name)
    : []
  if (!names.includes(REMOTE)) {
    await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
      name: REMOTE,
      type: 'sftp',
      options: { host: '127.0.0.1', user: REMOTE_USER, pass: REMOTE_PASS },
    })
  }
}

/** A cloud sync task through its own API door — setup for run/refusal tests. */
async function createTaskViaApi(
  ctx: APIRequestContext,
  body: Record<string, unknown>,
): Promise<void> {
  const existing = await ctx.get(`${V1}/cloud/tasks`)
  const names: string[] = existing.ok()
    ? (await existing.json()).data.map((t: { name: string }) => t.name)
    : []
  if (!names.includes(body.name as string)) {
    await runJob(ctx, 'post', `${V1}/cloud/tasks`, body)
  }
}

/**
 * Write a task through its own API door whatever is already there — the create
 * helper above SKIPS an existing task, so a test that needs a particular stored
 * state (a DISABLED task) has to say so rather than inherit the last test's.
 */
async function putTaskViaApi(
  ctx: APIRequestContext,
  body: Record<string, unknown>,
): Promise<void> {
  await runJob(ctx, 'put', `${V1}/cloud/tasks/${body.name as string}`, body)
}

/** Delete a cloud sync task through its own API door (best-effort). */
async function removeTaskViaApi(ctx: APIRequestContext, name: string): Promise<void> {
  await ctx.delete(`${V1}/cloud/tasks/${name}`).catch(() => {})
}

async function removeGtViaApi(ctx: APIRequestContext): Promise<void> {
  await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`).catch(() => {})
}

/** Set up remote + a given task through the API doors, then dispose. */
async function setupViaApi(
  playwright: PlaywrightWorkerArgs['playwright'],
  taskBody: Record<string, unknown> | null,
): Promise<void> {
  const ctx = await apiCtx(playwright)
  try {
    await createGtViaApi(ctx)
    if (taskBody) {
      await createTaskViaApi(ctx, taskBody)
    }
  }
  finally {
    await ctx.dispose()
  }
}

// ---- Node-side helpers (source of truth) ------------------------------------

/** The local tree rclone wrote — proof the run actually copied something. */
async function remoteTreeListing(): Promise<string> {
  return sshExec(`ls -1 /home/${REMOTE_USER}/pictures 2>/dev/null || true`)
}

// ---- UI helpers --------------------------------------------------------------

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

/** Open the task wizard (create; edit when `name` is given). */
async function openWizard(page: Page, grid: Locator, name?: string): Promise<Locator> {
  if (name) {
    await taskRow(page, grid, name).click()
    await grid.locator('.anas-btn-cloud-task-edit').click()
  }
  else {
    await grid.locator('.anas-btn-cloud-task-create').click()
  }
  const dlg = page.locator('.anas-win-cloud-task')
  await expect(dlg).toBeVisible({ timeout: 30_000 })
  return dlg
}

/** Pick a remote in the wizard's non-editable combo (click, then bound-list). */
async function pickRemote(page: Page, dlg: Locator, name: string): Promise<void> {
  await dlg.locator('.anas-fld-cloud-remote input').click()
  const boundList = page.locator('.x-boundlist').last()
  await expect(boundList).toBeVisible({ timeout: 20_000 })
  await boundList.locator('.x-boundlist-item', { hasText: new RegExp(`^${name}$`) }).first().click()
}

/**
 * A radiogroup's value, read off the GROUP component — `{ <name>: <inputValue> }`.
 * The element carrying the `cls` is the group's own, so its id is the component
 * id; the walk upward is there only in case a wrapper takes the class instead.
 * Reading a CHILD radio is what fails: `Ext.form.field.Radio#getValue()` hands
 * back the boolean `checked`, which carries no inputValue at all.
 */
async function radioValue(scope: Locator, cls: string): Promise<string> {
  return scope.locator(`.${cls}`).first().evaluate((el) => {
    const ext = (window as unknown as { Ext: { getCmp: (id: string) => any } }).Ext
    let node: Element | null = el
    while (node) {
      const cmp = node.id ? ext.getCmp(node.id) : null
      if (cmp && typeof cmp.isXType === 'function' && cmp.isXType('radiogroup')) {
        const v = cmp.getValue()
        return (v && typeof v === 'object') ? String(Object.values(v)[0] ?? '') : ''
      }
      node = node.parentElement
    }
    return ''
  })
}

/** Set a radiogroup's value on the GROUP component (the same walk as radioValue). */
async function setRadio(scope: Locator, cls: string, value: string): Promise<void> {
  await scope.locator(`.${cls}`).first().evaluate((el, v) => {
    const ext = (window as unknown as { Ext: { getCmp: (id: string) => any } }).Ext
    let node: Element | null = el
    while (node) {
      const cmp = node.id ? ext.getCmp(node.id) : null
      if (cmp && typeof cmp.isXType === 'function' && cmp.isXType('radiogroup')) {
        const radio = cmp.items.getAt(0)
        cmp.setValue({ [radio.name]: v })
        return
      }
      node = node.parentElement
    }
  }, value)
}

/** The job-failure alert ANAS.runJob raises. */
function failureAlert(page: Page): Locator {
  return page.locator('.x-messagebox', { hasText: /failed|refused/i })
}

/** Dismiss whatever Ext messagebox is up. */
async function dismissMessageBox(page: Page): Promise<void> {
  await page.locator('.x-messagebox .x-btn:visible').first().click()
  await expect(page.locator('.x-messagebox')).toBeHidden({ timeout: 15_000 })
}

/**
 * The reload-after-every-job observable (the 0.3.3 lesson: the grid reflects
 * reality after success AND failure), read where the user reads it — the row's
 * own Last run text. A raw fetch count cannot prove it: the view polls every
 * 10 s on its own, so two fetches around a run that takes longer than that are
 * met by the poll alone. A cell that moves from one result to another can only
 * have come from a reload.
 */
async function rowText(row: Locator): Promise<string> {
  return ((await row.textContent()) ?? '').replace(/\s+/g, ' ')
}

// ---- Fixtures ---------------------------------------------------------------

test.beforeAll(async () => {
  // ONCE per worker: `down` first (a crashed earlier run leaves units and a
  // dataset behind), then `up`. A per-test `up` is a swallowed no-op once the
  // store's pre-state is captured — worse, re-capturing it would record a
  // state this spec itself wrote as the "before" the teardown restores.
  // Self-heal like cloud-remotes-ui.spec.ts: a failed test ends the worker and
  // its afterAll tears the fixture down; the next worker re-ups it here.
  await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
  await execFileAsync(FIXTURE_SH, ['up']).catch(() => {})
})

test.beforeEach(async () => {
  // The fixture user is the "fixture present" signal (the same posture the
  // rclone.1 spec uses — NOT the store, which `up` restores to its pre-state).
  test.skip(
    !(await sshExec(`id -u ${REMOTE_USER}`)
      .then(() => true)
      .catch(() => false)),
    `cloud tasks fixture not present — run ${FIXTURE_SH} up`,
  )
})

test.describe('rclone.3 — Cloud Sync tasks (stunt node UI)', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(300_000)

  test.afterAll(async ({ playwright }) => {
    // Leave the node as found: tasks then the remote through their own API
    // doors, the stand-in rclone restored if a test died mid-swap, the empty
    // source dir swept, finally the fixture down. Best-effort — an afterAll
    // failure must not mask the run's results.
    const ctx = await apiCtx(playwright).catch(() => null)
    try {
      if (ctx) {
        await removeTaskViaApi(ctx, TASK)
        await removeTaskViaApi(ctx, 'sync-empty')
        await removeGtViaApi(ctx)
      }
    }
    finally {
      if (ctx) {
        await ctx.dispose()
      }
      // The stand-in-rclone safety net: if a test was interrupted after the
      // swap, the real binary is sitting at ${RCLONE_BAK}.
      await sshExec(
        `if [ -f ${RCLONE_BAK} ]; then mv ${RCLONE_BAK} ${RCLONE_BIN}; fi; `
        + `rmdir ${EMPTY_SOURCE} 2>/dev/null; true`,
      ).catch(() => {})
      await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
    }
  })

  test('1 — create through the wizard: empty-remotes toast, nested note, sync sentence, Copy default, the row lands selected', async ({ page, playwright }) => {
    const grid = await openTasksView(page)

    // The empty-remotes toast: a create with no remote saved never opens the
    // wizard — it points at Remotes… instead.
    await grid.locator('.anas-btn-cloud-task-create').click()
    await expect(page.locator('.x-toast', { hasText: 'Add a remote first' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.anas-win-cloud-task')).toHaveCount(0)

    // The remote arrives through its own door (the Remotes window's create is
    // cloud-remotes-ui.spec.ts's proof); a refresh brings the grid up to date.
    await setupViaApi(playwright, null)
    await grid.locator('.anas-btn-cloud-refresh').click()

    // The toolbar overflow rule (pvepool.2): at 2560×1080 every toolbar button
    // is ON the bar. A button ExtJS collapsed into the overflow menu is one the
    // operator has to go looking for — and one this spec could never click.
    for (const btn of [
      'anas-btn-cloud-refresh',
      'anas-btn-cloud-task-create',
      'anas-btn-cloud-remotes',
      'anas-btn-cloud-task-run',
      'anas-btn-cloud-preview-task',
      'anas-btn-cloud-task-details',
      'anas-btn-cloud-task-edit',
      'anas-btn-cloud-task-toggle',
      'anas-btn-cloud-task-remove',
    ]) {
      await expect(grid.locator(`.${btn}`), btn).toBeVisible({ timeout: 15_000 })
    }

    const dlg = await openWizard(page, grid)

    // The sync sentence rides the Mode radios; Copy is the checked default —
    // the mode that cannot destroy anything is the one you get for free.
    // (ExtJS 7 does not stamp itemIds as DOM ids — the cls is the selector.)
    await expect(dlg.locator('.anas-cloud-mode-note')).toContainText(
      'Sync deletes files at the destination that are no longer in the source. Copy never deletes.',
    )
    expect(await radioValue(dlg, 'anas-fld-cloud-mode')).toBe('copy')

    // The Source Browse button opens the SHARED path picker, and a
    // single-select picker hands its answer back as a path STRING — the field
    // is authoritative there, so a typed path the tree never showed is a
    // legitimate pick. Reading `.path` off that string filled the field with
    // nothing, and the wizard then refused its own source.
    await dlg.locator('.anas-fld-cloud-task-name input').fill(TASK)
    await dlg.locator('.anas-btn-cloud-source-browse').click()
    const picker = page.locator('.anas-win-path-picker')
    await expect(picker).toBeVisible({ timeout: 30_000 })
    await picker.locator('.anas-fld-picker-path input').fill(SOURCE)
    await picker.locator('.anas-btn-picker-select').click()
    await expect(picker).toBeHidden({ timeout: 20_000 })
    await expect(dlg.locator('.anas-fld-cloud-source input')).toHaveValue(SOURCE, { timeout: 15_000 })

    // The nested-filesystems note renders from the live preview-nested scan of
    // the picked source: the fixture dataset has a CHILD dataset, and a
    // snapshot will not contain it — said BEFORE the save, in the wizard.
    await expect(dlg.locator('.anas-cloud-source-scan')).toContainText(
      `Contains 1 nested filesystem that will not be included: ${NESTED}`,
      { timeout: 30_000 },
    )

    await pickRemote(page, dlg, REMOTE)
    await dlg.locator('.anas-fld-cloud-remote-path input').fill('pictures')
    // A NEW task opens on the Custom tab with an empty OnCalendar field, and
    // the wizard refuses to save without one ("Enter a schedule.").
    await dlg.locator('.anas-fld-cloud-schedule input').fill('daily')
    await dlg.locator('.anas-btn-cloud-task-submit').click()
    await expect(dlg).toBeHidden({ timeout: 120_000 })

    // The new row lands SELECTED with its destination whole and untruncated.
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    await expect(row).toHaveClass(/x-grid-row-selected/, { timeout: 15_000 })
    await expect(row).toContainText('gt:pictures')

    // The stored side of the contract: the task's unit pair exists and
    // carries both the embedded task JSON and the generated OnCalendar.
    const units = await sshExec(`systemctl cat anas-cloud-${TASK}.service anas-cloud-${TASK}.timer 2>/dev/null || true`)
    expect(units).toContain('X-ANAS-Task=')
    expect(units).toMatch(/OnCalendar=/)
  })

  test('2 — run now: the job rides the strip, the Last run pill refreshes to success', async ({ page, playwright }) => {
    await setupViaApi(playwright, TASK_BODY)

    const grid = await openTasksView(page)
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    const before = await rowText(row)

    await row.click()
    await grid.locator('.anas-btn-cloud-task-run').click()

    // The finished-run toast names the task and rclone's own counters; the
    // run itself is visible on the dashboard jobs strip (ANAS.runJob).
    await expect(page.locator('.x-toast', { hasText: `Cloud sync finished: ${TASK}` }))
      .toBeVisible({ timeout: 180_000 })

    // The grid reloaded after the job: the row's Last run MOVED to success,
    // which only a reload can do.
    expect(before, 'the row had not already succeeded before this run').not.toContain('success')
    await expect(row).toContainText('success', { timeout: 45_000 })
    await expect(row).not.toContainText('never run')

    // The copy actually landed at the remote (the fixture user's home).
    const listing = await remoteTreeListing()
    expect(listing.length).toBeGreaterThan(0)
  })

  test('3 — the empty-source sync refusal: the daemon\'s sentence in the dialog', async ({ page, playwright }) => {
    // An EMPTY directory as source, sync mode — the catastrophe guard, met
    // where the user meets it: the run they just started refuses, in words.
    await sshExec(`mkdir -p ${EMPTY_SOURCE}`)
    await setupViaApi(playwright, {
      name: 'sync-empty',
      source: EMPTY_SOURCE,
      remote: REMOTE,
      path: 'sync-empty',
      mode: 'sync',
      excludes: [],
      notify: 'on-failure',
      schedule: 'daily',
      enabled: true,
    })

    const grid = await openTasksView(page)
    const row = taskRow(page, grid, 'sync-empty')
    await expect(row).toBeVisible({ timeout: 45_000 })
    await row.click()
    await grid.locator('.anas-btn-cloud-task-run').click()

    const alert = failureAlert(page)
    await expect(alert).toBeVisible({ timeout: 120_000 })
    await expect(alert).toContainText(`${EMPTY_SOURCE} is empty and this task syncs`)
    await expect(alert).toContainText('would delete everything')
    await dismissMessageBox(page)

    // The grid reloaded after the failed run; the Last run cell is red.
    await expect(row).toContainText('failure', { timeout: 45_000 })
  })

  test('4 — a stand-in rclone exiting 7: the failure surfaces, the grid still reloads', async ({ page, playwright }) => {
    await setupViaApi(playwright, TASK_BODY)

    // The stand-in: the real binary aside, a shim that exits 7 — rclone's own
    // "retries exhausted" code. Restored the moment this test has proven its
    // point (and in afterAll if the test dies mid-way).
    await sshExec(`mv ${RCLONE_BIN} ${RCLONE_BAK} && printf '#!/bin/sh\\nexit 7\\n' > ${RCLONE_BIN} && chmod 755 ${RCLONE_BIN}`)
    try {
      const grid = await openTasksView(page)
      const row = taskRow(page, grid, TASK)
      await expect(row).toBeVisible({ timeout: 45_000 })
      const before = await rowText(row)
      await row.click()
      await grid.locator('.anas-btn-cloud-task-run').click()

      const alert = failureAlert(page)
      await expect(alert).toBeVisible({ timeout: 180_000 })
      await expect(alert).toContainText('exit 7')
      await dismissMessageBox(page)

      // Reload-after-failure, read as a transition: the Last run cell MOVED to
      // failure, which only a reload can do. Then the cell itself — red, with
      // the run's error line as its tooltip.
      expect(before, 'the row had not already failed before this run').not.toContain('failure')
      await expect(row).toContainText('failure', { timeout: 45_000 })
      const cellTip = await row
        .locator('.x-grid-cell-inner', { hasText: 'failure' })
        .locator('span[title]')
        .first()
        .getAttribute('title')
      expect(cellTip).toContain('exit 7')
    }
    finally {
      // Put the real rclone back BEFORE anything else runs.
      await sshExec(`if [ -f ${RCLONE_BAK} ]; then mv ${RCLONE_BAK} ${RCLONE_BIN}; fi`)
    }

    // The real binary is back: one more run succeeds, the row recovers.
    const ctx = await apiCtx(playwright)
    try {
      await runJob(ctx, 'post', `${V1}/cloud/tasks/${TASK}/run`, {})
    }
    finally {
      await ctx.dispose()
    }
    const grid = await openTasksView(page)
    await expect(taskRow(page, grid, TASK)).toContainText('success', { timeout: 120_000 })
  })

  test('5 — Remotes… opens the rclone.1 window', async ({ page }) => {
    const grid = await openTasksView(page)
    await grid.locator('.anas-btn-cloud-remotes').click()
    const win = page.locator('.anas-win-cloud-remotes')
    await expect(win).toBeVisible({ timeout: 30_000 })
    await expect(win.locator('.anas-grid-cloud-remotes')).toBeVisible({ timeout: 30_000 })
    await win.locator('.x-tool-close').click()
    await expect(win).toBeHidden({ timeout: 15_000 })
  })

  test('6 — removing a referenced remote is refused, the task named', async ({ page, playwright }) => {
    await setupViaApi(playwright, TASK_BODY)

    const grid = await openTasksView(page)
    await grid.locator('.anas-btn-cloud-remotes').click()
    const win = page.locator('.anas-win-cloud-remotes')
    await expect(win).toBeVisible({ timeout: 30_000 })
    await expect(win.locator('.anas-grid-cloud-remotes')).toBeVisible({ timeout: 30_000 })

    const row = win
      .locator('.x-grid-row', {
        has: page.locator('.x-grid-cell-inner', { hasText: new RegExp(`^${REMOTE}$`) }),
      })
      .first()
    await row.click()
    await win.locator('.anas-btn-cloud-remote-remove').click()

    // Confirm the removal…
    const confirm = page.locator('.x-messagebox', { hasText: 'Remove the remote' })
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await confirm.locator('.x-btn', { hasText: 'Yes' }).click()

    // …and the daemon's 409 names the referencing task, not just a code.
    const alert = failureAlert(page)
    await expect(alert).toBeVisible({ timeout: 60_000 })
    await expect(alert).toContainText('used by cloud sync task')
    await expect(alert).toContainText(TASK)
    await dismissMessageBox(page)

    // The remote is still there — the refusal kept it.
    await expect(row).toBeVisible({ timeout: 15_000 })
    await win.locator('.x-tool-close').click()
  })

  test('7 — a disabled task\'s detail shows the history note', async ({ page, playwright }) => {
    // The earlier tests left this task ENABLED, and the create helper skips a
    // task that already exists — so the disabled state is written explicitly.
    await setupViaApi(playwright, TASK_BODY)
    const setupCtx = await apiCtx(playwright)
    try {
      await putTaskViaApi(setupCtx, { ...TASK_BODY, enabled: false })
    }
    finally {
      await setupCtx.dispose()
    }

    const grid = await openTasksView(page)
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    await expect(row).toContainText('disabled')
    await row.click()

    await grid.locator('.anas-btn-cloud-task-details').click()
    const detail = page.locator('.anas-win-cloud-task-detail')
    await expect(detail).toBeVisible({ timeout: 30_000 })

    // The detail carries the config, the recent-only journald section, and —
    // for a DISABLED task — the sentence systemd's GC forces on us.
    await expect(detail).toContainText(SOURCE)
    await expect(detail).toContainText('gt:pictures')
    await expect(detail).toContainText('Recent runs (journald)')
    await expect(detail).toContainText('run history is not retained while a task is disabled')

    await detail.locator('.x-tool-close').click()
    await expect(detail).toBeHidden({ timeout: 15_000 })
  })

  test('8 — preview: the wizard names the deleted file, the toolbar previews the saved task', async ({ page, playwright }) => {
    // Two 120 s-bounded dry runs (wizard + toolbar) ride on top of the run —
    // the describe-level budget can be eaten by the run alone.
    test.setTimeout(600_000)
    // A sync whose destination already holds a copy. The fixture swept the
    // destination and this spec's earlier runs are not order guarantees, so
    // the stored sync task's OWN run lays the copy down first (a sync into an
    // empty destination copies everything and deletes nothing) — then one
    // source file goes away, and the preview must name it. The fixture's `up`
    // rebuilds the source dataset, so the deletion needs no restore.
    // setupViaApi's create helper SKIPS an existing task and test 7 leaves
    // this one copy + disabled — the state the preview needs is written
    // explicitly.
    await setupViaApi(playwright, TASK_BODY)
    const putCtx = await apiCtx(playwright)
    try {
      await putTaskViaApi(putCtx, { ...TASK_BODY, mode: 'sync', enabled: true })
    }
    finally {
      await putCtx.dispose()
    }
    const runCtx = await apiCtx(playwright)
    try {
      await runJob(runCtx, 'post', `${V1}/cloud/tasks/${TASK}/run`, {})
    }
    finally {
      await runCtx.dispose()
    }
    await sshExec(`rm -f ${SOURCE}/b.bin`)

    const grid = await openTasksView(page)
    const dlg = await openWizard(page, grid, TASK)
    // The Mode radio is flipped in the wizard BEFORE the Preview: the summary
    // must answer to the UNSAVED form — the inline arm, no name key on the
    // wire — never to the stored row behind it.
    await setRadio(dlg, 'anas-fld-cloud-mode', 'sync')
    expect(await radioValue(dlg, 'anas-fld-cloud-mode')).toBe('sync')
    await dlg.locator('.anas-btn-cloud-task-preview').click()

    // The summary line under the Mode field: rclone's own dry-run counters,
    // with the deleted file named under the would-be deletes. A dry run on the
    // LIVE source is bounded by the daemon's 120 s ceiling — allow for it.
    // (ExtJS 7 does not stamp itemIds as DOM ids — the cls is the selector.)
    const line = dlg.locator('.anas-cloud-preview-line')
    await expect(line).toContainText('Would transfer', { timeout: 120_000 })
    await expect(line).toContainText('delete 1 file at the destination')
    await expect(line).toContainText('b.bin')

    await dlg.locator('.x-tool-close').click()
    await expect(dlg).toBeHidden({ timeout: 15_000 })

    // The grid toolbar's Preview: the SAVED task by name, the same summary in
    // the display-only window. The toolbar button carries its OWN cls —
    // distinct from the wizard's Preview — so this locator can never click
    // the wrong one.
    const row = taskRow(page, grid, TASK)
    await row.click()
    await grid.locator('.anas-btn-cloud-preview-task').click()
    const previewWin = page.locator('.anas-win-cloud-preview')
    await expect(previewWin).toBeVisible({ timeout: 30_000 })
    await expect(previewWin).toContainText('Would transfer', { timeout: 120_000 })
    await expect(previewWin).toContainText('b.bin')
    await previewWin.locator('.x-tool-close').click()
    await expect(previewWin).toBeHidden({ timeout: 15_000 })
  })
})
