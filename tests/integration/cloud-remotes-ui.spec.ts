import type { APIRequestContext, Locator, Page, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { loginToPve, NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story rclone.1 (Cloud sync — remotes) — UI ACCEPTANCE over the real PVE UI
 * on the stunt node, driven through the cloud fixture
 * (test/stunt-node/cloud-fixture.sh up). Companion to cloud-remotes-api.spec.ts
 * (which proves the daemon halves); this file exercises the Remotes manager
 * window — packages/pve-integration/src/72-cloud.js, opened programmatically
 * as ANAS.cloud.openRemotes(node) because the Cloud Sync MENU is rclone.3 —
 * the way a user meets it, per DESIGN.md "Cloud sync — rclone" → Workflow:
 *
 *   1. Add an sftp remote `gt` (host 127.0.0.1, user rclonegt, pass gtpass)
 *      → Test in the dialog → "Reachable" → Save → the grid row `gt` lists
 *      `pass (secret)` — never the value.
 *   2. Edit → the password box is blank ("(unchanged)") → change the USER and
 *      save → the file's `user =` line moves while the `pass =` line stays
 *      byte-identical (ssh; the secret is write-only), then the user goes back.
 *   3. Test from the toolbar → "Reachable" (the saved remote, by name).
 *   4. A wrong-password UNSAVED dialog → the "Authentication failed" verdict.
 *   5. The S3 form waits for a provider pick, then shows exactly ONE `region`
 *      row — and it is the PICKED provider's row, not rclone's `!AWS,…`
 *      fallback (rendered from the real schema, told apart by the examples).
 *   6. Remove → confirm → the row is gone.
 *   7. An injected failure (the store renamed to a DIRECTORY before Save) →
 *      the failure surfaces and the grid still reloads (the 0.3.3 lesson).
 *
 * Every test leaves the node as found: the fixture's `down` restores the
 * captured pre-state of /etc/anas/rclone.conf and removes the fixture user.
 * Runs at 2560×1080 (same reason as smbsvc-ui / pvepool-ui — the toolbar must
 * not overflow into an invisible menu).
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const RCLONE_CONF = '/etc/anas/rclone.conf'
const REMOTE = 'gt'
const USER = 'rclonegt'
const PASS = 'gtpass'
const HOST = '127.0.0.1'

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-fixture.sh', import.meta.url).pathname

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

/** Create the sftp remote through its own API door (the UI spec's setup). */
async function createGtViaApi(ctx: APIRequestContext): Promise<void> {
  const res = await ctx.get(`${V1}/cloud/remotes`)
  const names: string[] = res.ok()
    ? (await res.json()).data.remotes.map((r: { name: string }) => r.name)
    : []
  if (!names.includes(REMOTE)) {
    await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
      name: REMOTE,
      type: 'sftp',
      options: { host: HOST, user: USER, pass: PASS },
    })
  }
}

/** Delete the sftp remote through its own API door (best-effort). */
async function removeGtViaApi(ctx: APIRequestContext): Promise<void> {
  await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`).catch(() => {})
}

// ---- Node-side helpers (source of truth) ------------------------------------

/** One `[name]` section of the store, exactly as it stands in the file. */
async function storeSection(name: string): Promise<string> {
  const py = [
    `import re`,
    `s = open('${RCLONE_CONF}').read()`,
    `m = re.search(r'(?ms)^\\[${name}\\].*?(?=^\\[|\\Z)', s)`,
    `print(m.group(0).rstrip('\\n') if m else '')`,
  ].join('\n')
  const b64 = Buffer.from(py, 'utf8').toString('base64')
  return sshExec(`echo ${b64} | base64 -d | python3`)
}

// ---- UI helpers --------------------------------------------------------------

/**
 * Open the Remotes manager window — there is NO menu item until rclone.3, so
 * the window is opened the way the harness and this spec open it:
 * programmatically, through ANAS.cloud.openRemotes(node).
 */
async function openRemotesWindow(page: Page): Promise<Locator> {
  await loginToPve(page)
  // The window is opened programmatically — no menu item exists until
  // rclone.3 wires one (the harness opens it the same way).
  await page.evaluate((node) => {
    const anas = (window as unknown as { ANAS: { cloud: { openRemotes: (node: string) => void } } }).ANAS
    anas.cloud.openRemotes(node)
  }, NODE_NAME)
  const win = page.locator('.anas-win-cloud-remotes')
  await expect(win).toBeVisible({ timeout: 30_000 })
  await expect(win.locator('.anas-grid-cloud-remotes')).toBeVisible({ timeout: 30_000 })
  return win
}

/** The grid row for remote `name` — scoped to the NAME cell, exact match. */
function remoteRow(page: Page, win: Locator, name: string): Locator {
  return win
    .locator('.x-grid-row', {
      has: page.locator('.x-grid-cell-inner', { hasText: new RegExp(`^${name}$`) }),
    })
    .first()
}

/**
 * Count the remotes-list fetches — the reload-after-every-job observable (the
 * 0.3.3 lesson: the grid reflects reality after success AND failure).
 */
async function trackRemotesFetches(page: Page): Promise<{ count: () => number }> {
  const state = { n: 0 }
  await page.route(/\/v1\/cloud\/remotes$/, async (route) => {
    state.n += 1
    await route.continue()
  })
  return { count: () => state.n }
}

/** The Add/Edit dialog's field by its per-option hook class. */
function optField(win: Locator, name: string): Locator {
  return win.locator(`.anas-fld-cloud-opt-${name} input`).first()
}

/**
 * The example values behind an option's combo, read off the component rather
 * than by opening its picker — an expanded bound list has to be dismissed, and
 * ESC on a modal window is the wrong thing to gamble a whole test on.
 */
async function comboExamples(dlg: Locator, name: string): Promise<string[]> {
  const inputId = await dlg.locator(`.anas-fld-cloud-opt-${name} input`).first().getAttribute('id')
  return dlg.page().evaluate((id) => {
    const ext = (window as unknown as { Ext: { getCmp: (id: string) => any } }).Ext
    const cmp = ext.getCmp(String(id).replace(/-inputEl$/, ''))
    const out: string[] = []
    if (cmp && cmp.getStore) {
      cmp.getStore().each((r: { get: (k: string) => unknown }) => out.push(String(r.get('value'))))
    }
    return out
  }, inputId)
}

/** Open the Add dialog, pick a backend type, and wait for its fields. */
async function openAddDialog(page: Page, win: Locator, name: string, type: string): Promise<Locator> {
  await win.locator('.anas-btn-cloud-remote-add').click()
  const dlg = page.locator('.anas-win-cloud-remote-edit')
  await expect(dlg).toBeVisible({ timeout: 20_000 })

  await dlg.locator('.anas-fld-cloud-remote-name input').fill(name)
  // The type combo is non-editable: click it, then click the bound-list item.
  await dlg.locator('.anas-fld-cloud-remote-type input').click()
  const boundList = page.locator('.x-boundlist').last()
  await expect(boundList).toBeVisible({ timeout: 20_000 })
  await boundList.locator('.x-boundlist-item', { hasText: type }).first().click()
  await expect(optField(dlg, 'host').or(page.locator('.anas-fld-cloud-opt-provider input'))).toBeVisible({ timeout: 20_000 })
  return dlg
}

// ---- Fixtures ---------------------------------------------------------------

test.beforeEach(async () => {
  // Self-heal like cloud-remotes-api.spec.ts: a failed test ends the worker
  // and its afterAll tears the fixture down; the next worker re-ups it here.
  await execFileAsync(FIXTURE_SH, ['up']).catch(() => {})
  // The fixture user is the "fixture present" signal — NOT the store, which
  // `up` deliberately removes after capturing the pre-state (every run starts
  // with no store). Mirrors the script's user_exists(): getent/id on the user.
  test.skip(
    !(await sshExec('id -u rclonegt')
      .then(() => true)
      .catch(() => false)),
    'cloud fixture not present — run test/stunt-node/cloud-fixture.sh up',
  )
})

test.describe('rclone.1 — Remotes manager window (stunt node UI)', () => {
  test.use({ viewport: { width: 2560, height: 1080 } })
  test.setTimeout(240_000)

  test.afterAll(async ({ playwright }) => {
    // Leave the node as found: the remote through its own API door (with an
    // ssh safety net), finally the fixture down (which restores the store's
    // captured pre-state). Best-effort — an afterAll failure must not mask
    // the run's results.
    const ticket = await pveTicket(playwright)
    const ctx = ticket ? await authedContext(playwright, ticket) : null
    try {
      if (ctx) {
        await removeGtViaApi(ctx)
      }
    }
    finally {
      if (ctx) {
        await ctx.dispose()
      }
      // A test-7 leftover directory where the store belongs (the spec's own
      // restore already ran; this is the safety net).
      await sshExec(`if [ -d ${RCLONE_CONF} ]; then rmdir ${RCLONE_CONF}; fi; `
        + `if [ -f ${RCLONE_CONF}.failing ]; then mv ${RCLONE_CONF}.failing ${RCLONE_CONF}; fi`)
        .catch(() => {})
      await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
    }
  })

  test('1 — add through the dialog: Test says Reachable, the row lists pass (secret), the file holds an obscured value', async ({ page }) => {
    const win = await openRemotesWindow(page)

    // The footer names rclone, ANAS's own store and the copy-back sentence.
    await expect(win.locator('.anas-cloud-footer')).toContainText('rclone')
    await expect(win.locator('.anas-cloud-footer')).toContainText(RCLONE_CONF)
    await expect(win.locator('.anas-cloud-footer')).toContainText('To copy data back, run on this node:')

    const dlg = await openAddDialog(page, win, REMOTE, 'sftp')
    await optField(dlg, 'host').fill(HOST)
    await optField(dlg, 'user').fill(USER)
    await optField(dlg, 'pass').fill(PASS)

    // Test in the dialog — inline, UNSAVED (the daemon serves it from an
    // env-defined remote; nothing is written before the save).
    await dlg.locator('.anas-btn-cloud-remote-testconn').click()
    await expect(dlg.locator('.anas-cloud-test-verdict')).toContainText('Reachable', { timeout: 60_000 })

    await dlg.locator('.anas-btn-cloud-remote-save').click()
    await expect(dlg).toBeHidden({ timeout: 90_000 })

    const row = remoteRow(page, win, REMOTE)
    await expect(row).toBeVisible({ timeout: 45_000 })
    // The Set column names the key and marks it secret — never the value.
    await expect(row).toContainText('pass (secret)')
    await expect(row).not.toContainText(PASS)

    // The store holds an OBSCURED value (rclone's own model), mode 0600.
    const section = await storeSection(REMOTE)
    expect(section).toContain(`[gt]`)
    expect(section).toMatch(/^pass = \S+$/m)
    expect(section).not.toContain(PASS)
  })

  test('2 — edit keeps the secret: blank "(unchanged)" box, the file\'s pass line untouched', async ({ page }) => {
    const win = await openRemotesWindow(page)
    const before = await storeSection(REMOTE)
    const passBefore = before.split('\n').filter(l => l.startsWith('pass =')).join('\n')
    expect(passBefore).not.toBe('')

    await remoteRow(page, win, REMOTE).click()
    await win.locator('.anas-btn-cloud-remote-edit').click()
    const dlg = page.locator('.anas-win-cloud-remote-edit')
    await expect(dlg).toBeVisible({ timeout: 20_000 })

    // Name and type are immutable on edit.
    await expect(dlg.locator('.anas-fld-cloud-remote-name input')).toBeDisabled()
    await expect(dlg.locator('.anas-fld-cloud-remote-type input')).toBeDisabled()

    // The secret is write-only: the box is BLANK and reads "(unchanged)".
    const passInput = optField(dlg, 'pass')
    expect(await passInput.inputValue()).toBe('')
    const placeholder = await passInput.getAttribute('placeholder')
    const emptyClass = await passInput.evaluate(el => el.classList.contains('x-form-empty-field'))
    expect(placeholder === '(unchanged)' || emptyClass, `placeholder=${placeholder}`).toBe(true)

    // The non-secret values read back.
    await expect(optField(dlg, 'host')).toHaveValue(HOST)
    await expect(optField(dlg, 'user')).toHaveValue(USER)

    // Change the user to a DIFFERENT value and save: the `user =` line must
    // move and the secret must survive byte-identically. (Re-filling the same
    // value fires no change event and would prove only that an EMPTY save is
    // harmless — which is a different claim.)
    const userLine = (section: string) =>
      section.split('\n').filter(l => l.startsWith('user =')).join('\n')
    const userBefore = userLine(before)
    expect(userBefore).toBe(`user = ${USER}`)

    await optField(dlg, 'user').fill(`${USER}2`)
    await dlg.locator('.anas-btn-cloud-remote-save').click()
    await expect(dlg).toBeHidden({ timeout: 90_000 })

    const after = await storeSection(REMOTE)
    const passAfter = after.split('\n').filter(l => l.startsWith('pass =')).join('\n')
    expect(passAfter).toBe(passBefore)
    expect(userLine(after)).not.toBe(userBefore)
    expect(userLine(after)).toBe(`user = ${USER}2`)

    // Put it back through the same door — test 3 tests the SAVED remote, and
    // this second round trip proves the secret survives that save too.
    await remoteRow(page, win, REMOTE).click()
    await win.locator('.anas-btn-cloud-remote-edit').click()
    await expect(dlg).toBeVisible({ timeout: 20_000 })
    await optField(dlg, 'user').fill(USER)
    await dlg.locator('.anas-btn-cloud-remote-save').click()
    await expect(dlg).toBeHidden({ timeout: 90_000 })

    const restored = await storeSection(REMOTE)
    expect(userLine(restored)).toBe(userBefore)
    expect(restored.split('\n').filter(l => l.startsWith('pass =')).join('\n')).toBe(passBefore)
  })

  test('3 — toolbar Test: the saved remote by name says Reachable', async ({ page }) => {
    const win = await openRemotesWindow(page)
    await remoteRow(page, win, REMOTE).click()
    await win.locator('.anas-btn-cloud-remote-test').click()
    // The verdict sentence rides the toast.
    await expect(page.locator('.x-toast', { hasText: 'Reachable' })).toBeVisible({ timeout: 60_000 })
  })

  test('4 — a wrong password in an UNSAVED dialog: the Authentication-failed verdict', async ({ page }) => {
    const win = await openRemotesWindow(page)

    const dlg = await openAddDialog(page, win, 'gt-wrongpass', 'sftp')
    await optField(dlg, 'host').fill(HOST)
    await optField(dlg, 'user').fill(USER)
    await optField(dlg, 'pass').fill('definitely-not-the-password')
    await dlg.locator('.anas-btn-cloud-remote-testconn').click()

    await expect(dlg.locator('.anas-cloud-test-verdict')).toContainText('Authentication failed', { timeout: 60_000 })

    // Nothing was written: the wrong remote never reaches the grid or the file.
    await dlg.locator('.x-btn', { hasText: 'Cancel' }).click()
    await expect(dlg).toBeHidden({ timeout: 20_000 })
    await expect(remoteRow(page, win, 'gt-wrongpass')).toHaveCount(0)
  })

  test('5 — the S3 form shows exactly ONE region row once a provider is picked', async ({ page }) => {
    const win = await openRemotesWindow(page)

    const dlg = await openAddDialog(page, win, 'gt-s3probe', 's3')

    // Before the pick, the only `region` row that survives is rclone's
    // `!AWS,…` negation variant — the fallback, not AWS's row. Its examples
    // say which one it is. Save waits for the provider pick.
    await expect(dlg.locator('.anas-fld-cloud-opt-region')).toHaveCount(1)
    const regionBefore = await comboExamples(dlg, 'region')
    expect(regionBefore, `region examples before the pick: ${regionBefore.join(',')}`)
      .toContain('other-v2-signature')
    expect(regionBefore).not.toContain('us-east-1')
    await expect(dlg.locator('.anas-btn-cloud-remote-save')).toBeDisabled()

    // The `provider` option renders as an editable combo of rclone's examples.
    const providerInput = dlg.locator('.anas-fld-cloud-opt-provider input')
    await providerInput.click()
    const boundList = page.locator('.x-boundlist').last()
    await expect(boundList).toBeVisible({ timeout: 20_000 })
    await boundList.locator('.x-boundlist-item', { hasText: 'AWS' }).first().click()

    // rclone's schema repeats `region` per provider filter — the dialog
    // renders only the row that applies to the picked provider, and THAT row
    // is AWS's (its examples carry the AWS regions).
    await expect(dlg.locator('.anas-fld-cloud-opt-region')).toHaveCount(1)
    const regionAfter = await comboExamples(dlg, 'region')
    expect(regionAfter, `region examples after picking AWS: ${regionAfter.join(',')}`)
      .toContain('us-east-1')
    expect(regionAfter).not.toContain('other-v2-signature')
    await expect(dlg.locator('.anas-btn-cloud-remote-save')).toBeEnabled()

    await dlg.locator('.x-btn', { hasText: 'Cancel' }).click()
    await expect(dlg).toBeHidden({ timeout: 20_000 })
  })

  test('6 — remove: the confirm, then the row is gone', async ({ page }) => {
    const win = await openRemotesWindow(page)
    await remoteRow(page, win, REMOTE).click()
    await win.locator('.anas-btn-cloud-remote-remove').click()

    const confirm = page.locator('.x-messagebox')
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await confirm.getByRole('button', { name: 'Yes' }).click()

    await expect(remoteRow(page, win, REMOTE)).toHaveCount(0, { timeout: 90_000 })
    expect(await storeSection(REMOTE)).toBe('')
  })

  test('7 — an injected failure before Save: the failure surfaces AND the grid still reloads', async ({ page, playwright }) => {
    // A remote to edit (test 6 removed it) — through the API door.
    const ticket = await pveTicket(playwright)
    expect(ticket).toBeTruthy()
    const ctx = await authedContext(playwright, ticket as string)
    try {
      await createGtViaApi(ctx)
    }
    finally {
      await ctx.dispose()
    }

    const fetches = await trackRemotesFetches(page)
    const win = await openRemotesWindow(page)
    await remoteRow(page, win, REMOTE).click()
    await win.locator('.anas-btn-cloud-remote-edit').click()
    const dlg = page.locator('.anas-win-cloud-remote-edit')
    await expect(dlg).toBeVisible({ timeout: 20_000 })

    // Change a value so the save has something to send, then break the store
    // under the dialog: the file becomes a DIRECTORY.
    await optField(dlg, 'user').fill(`${USER}2`)
    await sshExec(`mv ${RCLONE_CONF} ${RCLONE_CONF}.failing && mkdir ${RCLONE_CONF}`)

    const before = fetches.count()
    await dlg.locator('.anas-btn-cloud-remote-save').click()

    // The failure surfaces as the SAVE failure alert — 10-api.js titles it with
    // the job's failTitle ('Save failed' on an edit) and puts the daemon's own
    // sentence in the body — never a bare "failed" and never some other modal.
    const failAlert = page.locator('.x-messagebox').filter({ hasText: 'Save failed' })
    await expect(failAlert.first()).toBeVisible({ timeout: 60_000 })
    const failBody = ((await failAlert.first().textContent()) ?? '').replace(/Save failed|OK|Cancel/g, '').trim()
    expect(failBody.length, `the save-failure alert body was: ${failBody}`).toBeGreaterThan(10)

    // …and the manager grid STILL reloads. The counter is fed by an async
    // route handler, so it is polled, not read once.
    await expect.poll(() => fetches.count(), { timeout: 60_000 }).toBeGreaterThan(before)

    // Restore, then dismiss every stacked failure alert (the save's refusal
    // and the reload's own load failure — the reload path re-probed the store
    // while it was still broken).
    await sshExec(`rmdir ${RCLONE_CONF} && mv ${RCLONE_CONF}.failing ${RCLONE_CONF}`)
    for (let i = 0; i < 5; i++) {
      const boxes = page.locator('.x-messagebox:visible')
      if ((await boxes.count()) === 0) {
        break
      }
      await boxes.first().getByRole('button', { name: 'OK' }).click().catch(() => {})
      await page.waitForTimeout(500)
    }
    await expect(dlg).toBeHidden({ timeout: 20_000 })
    expect(await storeSection(REMOTE)).not.toBe('')
  })
})
