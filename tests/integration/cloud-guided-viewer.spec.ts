import type { Locator, Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { apiCtx, remoteNames, runJob, taskNames, taskRowByName, V1 } from './fixtures/cloud-api'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * LIVE PROOFS for the two cloud stories that landed 2026-09-25, over the real
 * daemon + real PVE UI on the stunt node (deploy 431e7e1):
 *
 *   rclone.4 "Guided remote form" (0947d00 + review fix 3670263) — the Add
 *   remote dialog on a CURATED backend renders the few fields the backend
 *   actually needs: drive shows the OAuth sentence and the token field alone
 *   in the primary container, the own-OAuth-client pair in a collapsed
 *   "Use your own OAuth client" fieldset with its one sentence, scope and
 *   service_account_file in a collapsed "More options" fieldset, and nothing
 *   advanced (root_folder_id) until the advanced toggle; s3 shows the five
 *   primary fields in order once a provider is picked, env_auth in More
 *   options, no own-client group and the access-key-page sentence; an
 *   UNCURATED backend (koofr) renders exactly as before rclone.4 — no guide
 *   note, no fieldsets, setmtime behind the advanced toggle.
 *
 *   rclone.6 "Run viewer" (fdcbbd9 + review fixes 908ad70, 3670263) — View run
 *   opens the live dashboard over the running direct job's detail: overall
 *   bytes/files bars, the full throughput spark, seven labeled figures, the
 *   in-flight rows, the task row's tiny spark (surviving a quiet reload), the
 *   dashboard strip's small spark + speed; a SIGSTOP'd rclone shows the
 *   stalled label in the viewer AND on the task row within 25 s and it leaves
 *   after SIGCONT; Recent fills newest-first as files complete; when the run
 *   ends the result banner stands in and the polling stops; a job that left
 *   the queue (daemon restart) turns the viewer to the no-detail sentence and
 *   no polling continues.
 *
 * Runs are kept SHORT on purpose: ~12 MiB in 6 files at --bwlimit 200k is a
 * little over a minute of rclone, so the whole viewer story rides one run and
 * the 404-terminal proof rides a second (destination wiped first, so it
 * actually transfers).
 *
 * FIXTURE: test/stunt-node/cloud-review-fixture.sh (profile `view` — up /
 * down): the loopback sftp user rclonegt (SHARED with the gate/cancel
 * profiles), the gtbackup/gtviewsrc dataset (6 x 2 MiB) and the sftp landing
 * area. Like those profiles it NEVER touches /etc/anas/rclone.conf: the
 * spec's remote arrives and leaves through the API. The operator's own remote
 * (gtest) and task (testoff) are asserted present at teardown — nothing here
 * ever runs, edits or removes them.
 */

const REMOTE = 'gtviewsftp'
const TASK = 'gtview'
const SOURCE = '/gtbackup/gtviewsrc'
const SCHEDULE = '2030-01-01 00:00:00'
const DST_DIR = '/home/rclonegt/gtview-dst'
const SRC_FILE_COUNT = 6

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-review-fixture.sh', import.meta.url).pathname

/**
 * The daemon's rclone child (argv `rclone copy <src> gtview-dst…`). `cop[y]`:
 * the self-match guard — this pattern travels verbatim in the ssh command's
 * own bash cmdline, which a plain `rclone copy` would match, so pkill would
 * signal its own wrapper (found live in cloud-cancel.spec.ts test 4).
 */
const RCLONE_CHILD_RE = 'rclone cop[y] .*gtview'

/**
 * The OAuth instruction sentence — rclone.1's fix, verbatim from
 * 72-cloud.js `oauthSentence()` for the drive backend (t() is identity in the
 * served English bundle).
 */
const OAUTH_DRIVE_SENTENCE = 'This backend authorises through a browser. On a machine with one, run '
  + '`rclone authorize "drive"` and paste only the JSON block it prints, from '
  + 'the opening { to the closing }, into the token field. Leave out the "Paste '
  + 'the following" and "End paste" lines.'

/** The one sentence inside the own-OAuth-client group (rclone.4). */
const OWN_CLIENT_SENTENCE = 'Optional. rclone\'s built-in client is shared by '
  + 'every rclone user and rate-limited; a client of your own avoids that.'

/** The run viewer's no-detail sentence, verbatim (72-cloud.js). */
const NO_DETAIL_SENTENCE = 'Per-file detail is shown only while a run is in progress.'

/** The task body the viewer tests drive. bwlimit 200k on ~12 MiB ≈ 70 s. */
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
 * the direct job id and live rclone stats ("copy: …"). The viewer needs the
 * first stats object's detail; the copy: line is its mark on the row.
 */
async function waitRunning(ctx: Awaited<ReturnType<typeof apiCtx>>): Promise<string> {
  await expect.poll(async () => {
    const row = await taskRowByName(ctx, TASK)
    return row.lastRunResult === 'running' && row.runningJobId && row.runningProgress?.includes('copy:')
      ? 'go'
      : 'wait'
  }, { timeout: 60_000, message: 'the row reads running with live "copy:" progress + runningJobId' }).toBe('go')
  return (await taskRowByName(ctx, TASK)).runningJobId as string
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

/** Open the Remotes manager, then the Add dialog. Returns both locators. */
async function openAddRemoteDialog(page: Page): Promise<{ win: Locator, dlg: Locator }> {
  const grid = await openTasksView(page)
  await grid.locator('.anas-btn-cloud-remotes').click()
  const win = page.locator('.anas-win-cloud-remotes')
  await expect(win).toBeVisible({ timeout: 30_000 })
  await win.locator('.anas-btn-cloud-remote-add').click()
  const dlg = page.locator('.anas-win-cloud-remote-edit')
  await expect(dlg).toBeVisible({ timeout: 20_000 })
  return { win, dlg }
}

/**
 * Pick a backend in the type combo. The bound-list item renders
 * `<b>drive</b> — Google Drive` — the match is anchored to the exact `b`
 * text, never the whole row (onedrive is also on the list).
 */
async function pickType(page: Page, dlg: Locator, name: string): Promise<void> {
  await dlg.locator('.anas-fld-cloud-remote-type input').click()
  const boundList = page.locator('.x-boundlist').last()
  await expect(boundList).toBeVisible({ timeout: 20_000 })
  await boundList
    .locator('.x-boundlist-item', { has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) })
    .first()
    .click()
  await expect(dlg.locator(`.anas-fld-cloud-opt-${name === 'drive' ? 'token' : 'provider'}`).first())
    .toBeVisible({ timeout: 20_000 })
}

/**
 * Pick a sub-provider in the `provider` option combo (the bound-list item
 * renders `<b>AWS</b> — …`).
 */
async function pickProvider(page: Page, dlg: Locator, name: string): Promise<void> {
  await dlg.locator('.anas-fld-cloud-opt-provider input').click()
  const boundList = page.locator('.x-boundlist').last()
  await expect(boundList).toBeVisible({ timeout: 20_000 })
  await boundList
    .locator('.x-boundlist-item', { has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) })
    .first()
    .click()
  // The provider change rebuilds the form; wait out the rebuild.
  await page.waitForTimeout(500)
}

/** Tick / untick the "Show advanced options" checkbox in the open dialog. */
async function setAdvanced(dlg: Locator, check: boolean): Promise<void> {
  const input = dlg.locator('.anas-fld-cloud-advanced input').first()
  const checked = await input.evaluate(el => (el as HTMLInputElement).checked)
  if (checked !== check)
    await input.click()
}

/**
 * Which container holds option `name`, per Ext (itemId is NOT a DOM id — the
 * rclone.3 ground truth; the component tree is the honest witness).
 */
interface OptHome {
  exists: boolean
  inBasic: boolean
  inOwnClient: boolean
  inMore: boolean
  inAdvanced: boolean
}

async function optHome(page: Page, name: string): Promise<OptHome> {
  return page.evaluate((optName) => {
    const Ext = (window as unknown as { Ext: any }).Ext
    const fld = Ext.ComponentQuery.query(`#cloudOpt_${optName}`)[0]
    if (!fld)
      return { exists: false, inBasic: false, inOwnClient: false, inMore: false, inAdvanced: false }
    return {
      exists: true,
      inBasic: !!fld.up('#cloudOptionsBasic'),
      inOwnClient: !!fld.up('#cloudOwnClientGroup'),
      inMore: !!fld.up('#cloudMoreGroup'),
      inAdvanced: !!fld.up('#cloudOptionsAdvanced'),
    }
  }, name)
}

/** Collapsed/hidden state + title of the two curated fieldsets. */
interface FieldsetState {
  ownHidden: boolean
  ownCollapsed: boolean
  ownTitle: string
  moreHidden: boolean
  moreCollapsed: boolean
  moreTitle: string
}

async function fieldsetState(page: Page): Promise<FieldsetState> {
  return page.evaluate(() => {
    const Ext = (window as unknown as { Ext: any }).Ext
    const own = Ext.ComponentQuery.query('#cloudOwnClientGroup')[0]
    const more = Ext.ComponentQuery.query('#cloudMoreGroup')[0]
    const titleOf = (fs: any) => fs ? String((fs.getTitle ? fs.getTitle() : fs.title) || '') : ''
    return {
      ownHidden: own ? own.isHidden() : true,
      ownCollapsed: own ? !!own.collapsed : false,
      ownTitle: titleOf(own),
      moreHidden: more ? more.isHidden() : true,
      moreCollapsed: more ? !!more.collapsed : false,
      moreTitle: titleOf(more),
    }
  })
}

/** The option names in the primary container, in render order. */
async function basicOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const Ext = (window as unknown as { Ext: any }).Ext
    const basic = Ext.ComponentQuery.query('#cloudOptionsBasic')[0]
    const names: string[] = []
    basic.items.each((c: any) => {
      const f = c.items && c.items.getAt ? c.items.getAt(0) : null
      names.push(f && f.name ? String(f.name) : '?')
    })
    return names
  })
}

// ---- Fixtures -----------------------------------------------------------------

test.beforeAll(async ({ playwright }) => {
  // ONCE per worker, in three idempotent steps — everything here tolerates
  // the leftovers a crashed earlier run leaves (found live 2026-09-26):
  //
  // 1. WAKE: the stall proof's SIGSTOP'd rclone child (and its sftp peer)
  //    never sees a teardown signal while stopped — CONT everything owned by
  //    the fixture user first, or `down`'s userdel fails with "still in use".
  await sshExec('pkill -CONT -u rclonegt >/dev/null 2>&1; true').catch(() => {})
  // 2. Physical down: units, dataset, landing areas, user (the `view`
  //    profile's own names only; never the rclone store).
  await execFileAsync(FIXTURE_SH, ['down', 'view']).catch(() => {})
  // 3. Store-side down: down never touches /etc/anas/rclone.conf, so a
  //    crashed run's task + remote survive there. Delete through the API —
  //    task first (the remote delete refuses while referenced), best-effort.
  const ctx = await apiCtx(playwright).catch(() => null)
  try {
    if (ctx && (await taskNames(ctx)).includes(TASK)) {
      await ctx.delete(`${V1}/cloud/tasks/${TASK}`).catch(() => {})
      await expect.poll(async () => (await taskNames(ctx)).includes(TASK), { timeout: 20_000 }).toBe(false)
    }
    if (ctx && (await remoteNames(ctx)).includes(REMOTE)) {
      await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`).catch(() => {})
    }
  }
  catch {
    // best-effort — `up` below recreates both anyway when absent
  }
  finally {
    ctx?.dispose()
  }
  // 4. Up — the `view` profile. beforeEach skips the whole suite when the
  //    fixture user is absent, so a failed up is a skip, not a false pass.
  await execFileAsync(FIXTURE_SH, ['up', 'view']).catch(() => {})
})

test.beforeEach(async () => {
  // The fixture user is the "fixture present" signal (as in the other cloud
  // specs). The rclone STORE is deliberately absent from that check: on this
  // node it is never the fixture's business.
  test.skip(
    !(await sshExec('id -u rclonegt').then(() => true).catch(() => false)),
    `cloud guided/viewer fixture not present — run ${FIXTURE_SH} up view`,
  )
})

test.describe.serial('cloud guided form (rclone.4) + run viewer (rclone.6) live proofs', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(300_000)

  test.afterAll(async ({ playwright }) => {
    // Teardown even on failure: end any run the spec left (SIGINT — allowed to
    // fail the run, it is teardown), remove the spec's OWN task and remote
    // through their API doors (the task first — the remote delete refuses
    // while referenced), then the fixture down. Best-effort throughout — the
    // operator-survival assertions at the end must not be masked.
    await execFileAsync(FIXTURE_SH, ['sigint', 'view']).catch(() => {})
    const ctx = await apiCtx(playwright).catch(() => null)
    try {
      if (ctx) {
        await ctx.delete(`${V1}/cloud/tasks/${TASK}`).catch(() => {})
        await expect.poll(async () => (await taskNames(ctx)).includes(TASK), {
          timeout: 20_000,
          message: 'the gtview task is gone before the remote delete',
        }).toBe(false)
        await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`).catch(() => {})
      }
    }
    catch {
      // best-effort — the fixture down below removes the units either way
    }
    finally {
      ctx?.dispose()
      await execFileAsync(FIXTURE_SH, ['down', 'view']).catch(() => {})
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

  test('1 — rclone.4 drive form: OAuth sentence alone, token in the primary container, own-client pair collapsed with its sentence, scope/service-account in More options, root_folder_id behind the advanced toggle', async ({ page }) => {
    const { win, dlg } = await openAddRemoteDialog(page)
    await dlg.locator('.anas-fld-cloud-remote-name input').fill('gtdrive-form')
    await pickType(page, dlg, 'drive')

    // The guide note is HIDDEN on the OAuth backends (review batch B: the
    // token sentence below is their only instruction).
    await expect(dlg.locator('.anas-cloud-guide')).toBeHidden()
    const noteState = await page.evaluate(() => {
      const Ext = (window as unknown as { Ext: any }).Ext
      const g = Ext.ComponentQuery.query('#cloudGuideNote')[0]
      const o = Ext.ComponentQuery.query('#cloudOAuthNote')[0]
      return { guideHidden: g ? g.isHidden() : true, oauthHidden: o ? o.isHidden() : true }
    })
    expect(noteState.guideHidden, 'the guide note is hidden on drive').toBe(true)
    expect(noteState.oauthHidden, 'the OAuth note is visible on drive').toBe(false)

    // EXACTLY one instruction sentence, naming rclone authorize and both
    // marker lines — rclone.1's fix, byte for byte.
    const oauthText = ((await dlg.locator('.anas-cloud-oauth').textContent()) ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    expect(oauthText, `OAuth note text: ${oauthText}`).toBe(OAUTH_DRIVE_SENTENCE)

    // The token field lives in the primary container and NOWHERE else.
    const tokenHome = await optHome(page, 'token')
    expect(tokenHome, 'token field home').toEqual({
      exists: true,
      inBasic: true,
      inOwnClient: false,
      inMore: false,
      inAdvanced: false,
    })
    await expect(dlg.locator('.anas-fld-cloud-opt-token')).toHaveCount(1)

    // The own-OAuth-client pair: in the collapsed fieldset, titled as the
    // story words it.
    const ownState = await fieldsetState(page)
    expect(ownState.ownHidden, 'the own-client fieldset is rendered on drive').toBe(false)
    expect(ownState.ownCollapsed, 'the own-client fieldset starts collapsed').toBe(true)
    expect(ownState.ownTitle, 'the own-client fieldset title').toBe('Use your own OAuth client')
    expect((await optHome(page, 'client_id')).inOwnClient, 'client_id in the own-client fieldset').toBe(true)
    expect((await optHome(page, 'client_secret')).inOwnClient, 'client_secret in the own-client fieldset').toBe(true)

    // Opening it shows the one sentence (rclone.4's rate-limit rationale).
    await dlg.locator('.anas-fld-cloud-own-client .x-fieldset-header').click()
    await expect(dlg.locator('.anas-cloud-ownclient-note')).toBeVisible({ timeout: 10_000 })
    await expect(dlg.locator('.anas-cloud-ownclient-note')).toContainText(OWN_CLIENT_SENTENCE)
    const ownStateOpen = await fieldsetState(page)
    expect(ownStateOpen.ownCollapsed, 'the own-client fieldset opened').toBe(false)

    // scope and service_account_file: in "More options", collapsed.
    const moreState = await fieldsetState(page)
    expect(moreState.moreHidden, 'the More options fieldset is rendered on drive').toBe(false)
    expect(moreState.moreCollapsed, 'More options starts collapsed').toBe(true)
    expect(moreState.moreTitle, 'the More options title').toBe('More options')
    expect((await optHome(page, 'scope')).inMore, 'scope in More options').toBe(true)
    expect((await optHome(page, 'service_account_file')).inMore, 'service_account_file in More options').toBe(true)

    // root_folder_id is ADVANCED on drive: absent until the toggle is ticked,
    // then built below it.
    expect((await optHome(page, 'root_folder_id')).exists, 'root_folder_id absent before the toggle').toBe(false)
    await expect(dlg.locator('.anas-fld-cloud-opt-root_folder_id')).toHaveCount(0)
    await setAdvanced(dlg, true)
    const rootHome = await optHome(page, 'root_folder_id')
    expect(rootHome.exists, 'root_folder_id built after the toggle').toBe(true)
    expect(rootHome.inAdvanced, 'root_folder_id under the advanced toggle').toBe(true)

    await dlg.locator('.x-btn', { hasText: 'Cancel' }).click()
    await expect(dlg).toBeHidden({ timeout: 20_000 })
    await expect(win.locator('.x-grid-row', { hasText: /^gtdrive-form/ })).toHaveCount(0)
  })

  test('2 — rclone.4 s3 form: the five primary fields in order after picking a provider, env_auth in More options, no own-client group, the access-key-page sentence', async ({ page }) => {
    const { dlg } = await openAddRemoteDialog(page)
    await dlg.locator('.anas-fld-cloud-remote-name input').fill('gts3-form')
    await pickType(page, dlg, 's3')

    // The guide sentence names where the keys come from.
    await expect(dlg.locator('.anas-cloud-guide')).toBeVisible({ timeout: 10_000 })
    await expect(dlg.locator('.anas-cloud-guide')).toContainText(/access-key page/)

    // s3 has no token: the OAuth note stays hidden.
    await expect(dlg.locator('.anas-cloud-oauth')).toBeHidden()

    // No own-client group on s3.
    const state = await fieldsetState(page)
    expect(state.ownHidden, 'no own-client fieldset on s3').toBe(true)

    // env_auth is essential=false, advanced=false → More options, even before
    // a provider is picked (it carries no provider filter).
    expect((await optHome(page, 'env_auth')).inMore, 'env_auth in More options').toBe(true)
    expect(state.moreHidden, 'the More options fieldset is rendered on s3').toBe(false)

    // Pick the AWS sub-provider: the primary container then holds EXACTLY the
    // five essential fields, in the story's order.
    await pickProvider(page, dlg, 'AWS')
    const order = await basicOrder(page)
    expect(order, `primary container order: ${JSON.stringify(order)}`).toEqual([
      'provider',
      'access_key_id',
      'secret_access_key',
      'region',
      'endpoint',
    ])

    await dlg.locator('.x-btn', { hasText: 'Cancel' }).click()
    await expect(dlg).toBeHidden({ timeout: 20_000 })
  })

  test('3 — rclone.4 uncurated backend (koofr): no guide note, no fieldsets, the primary container reads provider/user/password, setmtime behind the advanced toggle', async ({ page }) => {
    const { dlg } = await openAddRemoteDialog(page)
    await dlg.locator('.anas-fld-cloud-remote-name input').fill('gtkoofr-form')
    await pickType(page, dlg, 'koofr')

    // Uncurated ⇒ byte-identical to pre-rclone.4: no guide note, no OAuth
    // sentence, both curated fieldsets absent.
    await expect(dlg.locator('.anas-cloud-guide')).toBeHidden()
    await expect(dlg.locator('.anas-cloud-oauth')).toBeHidden()
    const state = await fieldsetState(page)
    expect(state.ownHidden, 'no own-client fieldset on koofr').toBe(true)
    expect(state.moreHidden, 'no More options fieldset on koofr').toBe(true)
    expect((await dlg.textContent()) ?? '').not.toContain('access-key page')

    // After picking the koofr sub-provider the primary container reads
    // provider, user, password (the positive-filtered rows arrive).
    await pickProvider(page, dlg, 'koofr')
    const order = await basicOrder(page)
    expect(order, `primary container order: ${JSON.stringify(order)}`).toEqual([
      'provider',
      'user',
      'password',
    ])

    // setmtime is advanced: behind the toggle, like it always was.
    expect((await optHome(page, 'setmtime')).exists, 'setmtime absent before the toggle').toBe(false)
    await setAdvanced(dlg, true)
    const setmtime = await optHome(page, 'setmtime')
    expect(setmtime.exists, 'setmtime built after the toggle').toBe(true)
    expect(setmtime.inAdvanced, 'setmtime under the advanced toggle').toBe(true)

    await dlg.locator('.x-btn', { hasText: 'Cancel' }).click()
    await expect(dlg).toBeHidden({ timeout: 20_000 })
  })

  test('4 — rclone.6 viewer live: bars/spark/figures, transferring climbs, tiny + small sparks, stalled via SIGSTOP/CONT, newest-first Recent, result banner, polling stops', async ({ page, playwright }) => {
    // One run carries the whole viewer story: ~70 s of rclone plus the stall.
    test.setTimeout(900_000)

    const ctx = await apiCtx(playwright)
    let directId = ''
    let jobGets = 0
    try {
      await createRemoteViaApi(ctx)
      await createTaskViaApi(ctx)

      // Wipe the destination: a crashed earlier run leaves files there and a
      // copy run against them SKIPS them — fewer in-flight rows, fewer recent
      // events, a banner naming the wrong count.
      await sshExec(`rm -rf ${DST_DIR} && mkdir -p ${DST_DIR} && chown -R rclonegt:rclonegt ${DST_DIR}`)

      await startRun(ctx)
      directId = await waitRunning(ctx)
    }
    finally {
      await ctx.dispose()
    }

    // Count every page request for the direct job's detail — the viewer's 2 s
    // poll, the grid's 5 s row poll and the dashboard's detail GET all ride
    // this one URL; the terminal assertions below read the counter.
    page.on('request', (req) => {
      if (req.url().includes(`/v1/jobs/${directId}`))
        jobGets++
    })

    const grid = await openTasksView(page)
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    await row.click()

    // View run is enabled on the running row; the window opens.
    const viewBtn = grid.locator('.anas-btn-cloud-task-view-run')
    await expect(viewBtn).toBeEnabled({ timeout: 20_000 })
    await viewBtn.click()
    const viewer = page.locator('.anas-win-cloud-run')
    await expect(viewer).toBeVisible({ timeout: 20_000 })

    // "Preparing the run…" may flash first (review batch B) — never asserted,
    // the run already carries stats. The live dashboard appears within 15 s:
    // header with the running pill, both bars, the full spark, 7 figures.
    await expect(viewer.locator('.anas-run-header')).toBeVisible({ timeout: 15_000 })
    await expect(viewer.locator('.anas-run-header')).toContainText('running')
    const progress = viewer.locator('.anas-run-progress')
    await expect(progress).toBeVisible({ timeout: 15_000 })
    await expect(progress.locator('.anas-gfx-gauge')).toHaveCount(1)
    await expect(progress.locator('.anas-gfx-bar')).toHaveCount(1)
    await expect(viewer.locator('.anas-run-spark svg.anas-gfx-spark-full')).toBeVisible({ timeout: 15_000 })
    await expect(viewer.locator('[data-anas-run-figure]')).toHaveCount(7)

    // Cancel run is enabled while the run is live (rclone.5's door in the
    // viewer; the flow itself is cloud-cancel.spec.ts's proof).
    await expect(viewer.locator('.anas-btn-cloud-run-cancel')).toBeEnabled({ timeout: 10_000 })

    // Transferring now: at least one in-flight row, and its percentage CLIMBS
    // between two reads 6 s apart (the same file name on both reads — rows
    // change as files complete).
    const rowPcts = async (): Promise<Map<string, number>> => {
      const rows = await viewer.locator('.anas-run-transferring-row').all()
      const out = new Map<string, number>()
      for (const r of rows) {
        // The row's FIRST span is the file name; the percentage is the bar's
        // own pct label (the row's text also carries the size, speed and ETA).
        const name = ((await r.locator('span').first().textContent()) ?? '').trim()
        const pctText = await r.locator('.anas-gfx-bar-pct').first().textContent().catch(() => null)
        const pct = pctText?.match(/(\d+(?:\.\d+)?)/)
        if (name && pct)
          out.set(name, Number(pct[1]))
      }
      return out
    }
    await expect(viewer.locator('.anas-run-transferring-row').first()).toBeVisible({ timeout: 30_000 })
    const pcts1 = await rowPcts()
    expect(pcts1.size, `in-flight rows: ${JSON.stringify([...pcts1])}`).toBeGreaterThanOrEqual(1)
    await page.waitForTimeout(6_000)
    const pcts2 = await rowPcts()
    let climbed = false
    for (const [name, pct1] of pcts1) {
      const pct2 = pcts2.get(name)
      if (pct2 !== undefined && pct2 > pct1)
        climbed = true
    }
    expect(climbed, `percentages 6 s apart: ${JSON.stringify([...pcts1])} → ${JSON.stringify([...pcts2])}`).toBe(true)

    // Recent, snapshot ONE — taken while the run is young, so a later head
    // change is a NEW completion floating to the top (the whole run is ~70 s
    // at 200k; a snapshot taken after the finish would have nothing left to
    // wait for).
    const recentNames = async (): Promise<string[]> => {
      const rows = await viewer.locator('.anas-run-recent-row').all()
      const names: string[] = []
      for (const r of rows)
        names.push((((await r.locator('.anas-run-col-file .anas-run-path').textContent()) ?? '').trim()))
      return names
    }
    const recentHead1 = (await recentNames())[0]

    // The task row's tiny spark: beside the running progress in the Last-run
    // cell, with the throughput title and a speed text. (The dashboard strip's
    // small spark rides test 5's run — its live window there is controlled by
    // the restart that follows it; here the run's ~70 s are too tight to fit
    // both the dashboard detour and the stall below.)
    await expect(row.locator('svg.anas-gfx-spark-tiny')).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('svg.anas-gfx-spark-tiny')).toHaveAttribute('title', 'throughput, last 5 minutes')
    await expect(row).toContainText(/B\/s/)

    // …and it survives a quiet grid reload (12 s — the review batch B fix:
    // the detail map outlives the record replacement). BEFORE the stall: the
    // row only carries the spark while IT reads running, so the 12 s must fit
    // inside the run's life; after the stall the run's tail is too short to
    // guarantee that.
    await page.waitForTimeout(12_000)
    await expect(row.locator('svg.anas-gfx-spark-tiny')).toBeVisible()

    // STALLED — SIGSTOP the rclone child (the `cop[y]` pattern never matches
    // THIS ssh command's own cmdline). Within 25 s both the viewer and the
    // task row show the danger label; -CONT clears it within 25 s.
    //
    // Why this shape works now: the samples are daemon-derived byte deltas
    // (rclone.6 review batch A) and a SIGSTOP'd rclone emits NO stats objects,
    // so a pure delta-difference sampler would never see zero bytes move —
    // found live on 2026-09-26 (measured on the build without the fix: the
    // label only ever fired with rclone ALIVE and not progressing, e.g. a
    // frozen sftp peer, and even then only after ~30-40 s). Commit d9a08f9
    // closed exactly that gap: the tracker keeps its own 5 s clock and
    // appends a zero sample for every interval that produced no stats object,
    // so a FROZEN rclone reads stalled after three intervals (~15 s) exactly
    // like an unchanged-bytes network stall — the shape the story text
    // sketched. The run also cannot END while frozen (the runner's poll sits
    // waiting), so the window is unlimited.
    await expect(viewer.locator('.anas-run-transferring-row').first()).toBeVisible({ timeout: 10_000 })
    await sshExec(`pkill -STOP -f '${RCLONE_CHILD_RE}'`)
    await expect(viewer.locator('.anas-gfx-stalled')).toBeVisible({ timeout: 25_000 })
    await expect(viewer.locator('.anas-gfx-stalled')).toContainText(/stalled for \d+s/)
    await expect(row.locator('.anas-gfx-stalled')).toBeVisible({ timeout: 25_000 })
    await expect(row.locator('.anas-gfx-stalled')).toContainText(/stalled for \d+s/)

    // RESUME: the next real stats object lands within one 5 s cadence of the
    // CONT, so the label leaves both homes within the same 25 s window.
    await sshExec(`pkill -CONT -f '${RCLONE_CHILD_RE}'`)
    await expect(viewer.locator('.anas-gfx-stalled')).toHaveCount(0, { timeout: 25_000 })
    await expect(row.locator('.anas-gfx-stalled')).toHaveCount(0, { timeout: 25_000 })

    // Recent fills as files complete, NEWEST first: the head must have MOVED
    // past the early snapshot (a later completion floated to the TOP), the
    // earlier head must still be listed — and the external witness, the
    // destination's own mtime order, names the same file the head does.
    await expect(viewer.locator('.anas-run-recent-row').first()).toBeVisible({ timeout: 240_000 })
    await expect.poll(async () => (await recentNames())[0], {
      timeout: 240_000,
      message: 'a newer completion floats to the top of Recent',
    }).not.toBe(recentHead1)
    const names2 = await recentNames()
    if (recentHead1)
      expect(names2, `recent after the change: ${JSON.stringify(names2)}`).toContain(recentHead1)
    // NO mtime witness: the destination's own timestamps CANNOT arbitrate
    // ring order — measured live 2026-09-26. rclone copy preserves the
    // source modtime and the sftp server truncates it to whole seconds, so
    // all six files land with the IDENTICAL mtime (the fixture's dd loop
    // creates them within one second) and `ls -t` returns directory-hash
    // order. And even with distinct source mtimes, completion order is
    // bandwidth-scheduled (the probe run finished f2 first), never the
    // mtime order. Newest-first rests on the ring itself: the head moved
    // past the early snapshot, and the earlier head is still listed BELOW.

    // The run finishes on its own: the result banner stands in where the
    // in-flight section was — files, bytes, duration, no errors — and the
    // bars stand at their final values.
    const banner = viewer.locator('.anas-run-result-banner')
    await expect(banner).toBeVisible({ timeout: 300_000 })
    const bannerText = (await banner.textContent()) ?? ''
    expect(bannerText, `banner: ${bannerText}`).toContain(`${SRC_FILE_COUNT} files`)
    expect(bannerText, `banner: ${bannerText}`).toMatch(/MiB/)
    expect(bannerText, `banner: ${bannerText}`).toContain('no errors')

    // The viewer's poll stopped with the job; the grid's row poll ends with
    // the row itself. Refresh the grid (the run was started through the API,
    // so the row still reads running until it reloads), wait out any tick in
    // flight, then require SECONDS of silence on the job's detail URL.
    await grid.locator('.anas-btn-cloud-refresh').click()
    await expect(row).toContainText('success', { timeout: 90_000 })
    await expect(row.locator('svg.anas-gfx-spark-tiny')).toHaveCount(0, { timeout: 30_000 })
    await page.waitForTimeout(7_500)
    const gets1 = jobGets
    await page.waitForTimeout(6_000)
    expect(jobGets, `GET /v1/jobs/${directId} after the run ended: ${gets1} → ${jobGets}`).toBe(gets1)
  })

  test('5 — rclone.6 404 terminal: a job that left the queue (daemon restart) turns the viewer to the no-detail sentence and no polling continues', async ({ page, playwright }) => {
    test.setTimeout(600_000)

    const ctx = await apiCtx(playwright)
    let directId = ''
    let jobGets = 0
    try {
      await createRemoteViaApi(ctx)
      await createTaskViaApi(ctx)

      // Wipe the destination: the previous test's run left all six files
      // there, and a copy run against them would complete in seconds —
      // before the restart could land mid-run.
      await sshExec(`rm -rf ${DST_DIR} && mkdir -p ${DST_DIR} && chown -R rclonegt:rclonegt ${DST_DIR}`)

      await startRun(ctx)
      directId = await waitRunning(ctx)
    }
    finally {
      await ctx.dispose()
    }

    page.on('request', (req) => {
      if (req.url().includes(`/v1/jobs/${directId}`))
        jobGets++
    })

    const grid = await openTasksView(page)
    const row = taskRow(page, grid, TASK)
    await expect(row).toBeVisible({ timeout: 45_000 })
    await row.click()
    const viewBtn = grid.locator('.anas-btn-cloud-task-view-run')
    await expect(viewBtn).toBeEnabled({ timeout: 20_000 })
    await viewBtn.click()
    const viewer = page.locator('.anas-win-cloud-run')
    await expect(viewer).toBeVisible({ timeout: 20_000 })

    // The viewer is LIVE (detail flowing) when the daemon goes away.
    await expect(viewer.locator('.anas-run-progress')).toBeVisible({ timeout: 15_000 })

    // The dashboard strip (its live window is controlled here: the run has
    // its whole ~70 s ahead of it and the restart lands right after): the
    // running cloud row with the small spark and the current speed. The
    // strip's brief carries only the job's operation — the direct run's row
    // reads cloud.task.run, and the spark rides exactly that row (the
    // supervising Run-now job has no detail, so no spark).
    await openAnasItem(page, 'Dashboard')
    const strip = page.locator('.anas-view-dashboard .anas-dash-jobstrip')
    const sparkRow = strip.locator('.anas-dash-job', {
      has: page.locator('svg.anas-gfx-spark-small'),
    })
    await expect(sparkRow.first()).toBeVisible({ timeout: 30_000 })
    await expect(sparkRow.first()).toContainText('cloud.task.run')
    await expect(sparkRow.first()).toContainText('running')
    await expect(sparkRow.first().locator('.anas-dash-job-speed')).toContainText(/B\/s/)

    // Back to Cloud Sync: the viewer (an independent window) is still live,
    // and the grid is on screen for the rest of the proof.
    await openAnasItem(page, 'Cloud Sync')
    await expect(taskRow(page, grid, TASK)).toBeVisible({ timeout: 45_000 })
    await expect(viewer.locator('.anas-run-progress')).toBeVisible({ timeout: 15_000 })

    // The restart: the queue is in-memory, the job leaves it. The gateway
    // comes back WITH the daemon (PartOf). Health over the socket is the
    // honest "up" (is-active lies between crash loops).
    await sshExec('systemctl restart anasd')
    await expect.poll(async () => sshExec(
      'curl -sf --max-time 2 --unix-socket /run/anas/anasd.sock http://localhost/v1/health >/dev/null 2>&1 && echo up || echo down',
    ), { timeout: 90_000, message: 'anasd /v1/health answers after the restart' }).toBe('up')

    // The viewer's poll first rides the transient errors (daemon down), then
    // answers 4xx — TERMINAL: the pill turns to the task's own result and the
    // body reads the no-detail sentence above the journal summary.
    await expect(viewer.locator('.anas-run-no-detail')).toBeVisible({ timeout: 120_000 })
    await expect(viewer.locator('.anas-run-no-detail')).toContainText(NO_DETAIL_SENTENCE)

    // No polling continues: the viewer's timer is cleared, and the grid's row
    // poll stops with the view — leave the Cloud Sync card so the only thing
    // left polling is nothing.
    await openAnasItem(page, 'Dashboard')
    await page.waitForTimeout(7_500)
    const gets1 = jobGets
    await page.waitForTimeout(6_000)
    expect(jobGets, `GET /v1/jobs/${directId} after the 4xx: ${gets1} → ${jobGets}`).toBe(gets1)
  })
})
