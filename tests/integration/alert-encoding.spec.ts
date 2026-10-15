import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, NODE_NAME } from './fixtures/pve-ui'
import { nfsExportExists, removeNfsExport, sshExec } from './fixtures/stunt-node'

/**
 * cr.11 (review M5) — the panels' failure alerts carry the daemon's error text
 * ENCODED, so markup an operator typed (or a remote's stderr) is shown as text,
 * never rendered. Proven in the real PVE UI with the real bundle (`anas.js`
 * served by pveproxy), through the two alert paths in 10-api.js that every
 * mutation goes through:
 *
 *   1. jobRejected — the daemon refuses the request outright (400). A mount
 *      under PVE's `/mnt/pve` is refused with a sentence that ECHOES the typed
 *      mountpoint, so a mountpoint carrying `<b>x</b>` reaches the alert.
 *   2. pollJob `failed` — the job runs and fails. An NFS export of a path that
 *      does not exist fails in `exportfs -ra` with "Failed to stat <path>", and
 *      since cr.13 the file is rolled back; the path carries `<b>x</b>`.
 *
 * Both are driven through `ANAS.runJob` — the helper every panel's Add/Edit
 * dialog calls — from the logged-in page, so the alert is the panels' own
 * Ext.Msg box, not a test fabrication. The assertion is on the DOM: the box's
 * text contains the literal `<b>x</b>` and the box contains no <b> element.
 *
 * Leaves nothing behind: (1) never reaches a job; (2) is rolled back by the
 * daemon (cr.13), and afterAll removes the export anyway if a regression lets
 * it land.
 */

const MARK = '<b>x</b>'
const BAD_EXPORT = `/srv/anas-alert-${MARK}`

/** Run one mutation through the panels' ANAS.runJob and wait for its failure alert. */
async function runAndReadAlert(page: Page, opts: { method: string, path: string, body: unknown, failTitle: string }) {
  await page.evaluate(({ node, o }) => {
    const w = window as unknown as { ANAS: { runJob: (x: Record<string, unknown>) => void } }
    w.ANAS.runJob({ node, method: o.method, path: o.path, body: o.body, failTitle: o.failTitle })
  }, { node: NODE_NAME, o: opts })
  const box = page.locator('.x-message-box').filter({ hasText: opts.failTitle })
  await expect(box).toBeVisible({ timeout: 30_000 })
  const body = box.locator('.x-window-text, .x-form-display-field').first()
  const text = (await body.textContent()) ?? ''
  const boldCount = await box.locator('b').count()
  const html = await body.innerHTML()
  await box.getByRole('button', { name: 'OK' }).click()
  await expect(box).toBeHidden()
  return { text, boldCount, html }
}

test.describe('cr.11 — failure alerts show daemon text as text', () => {
  test.setTimeout(120_000)

  test.afterAll(async () => {
    if (await nfsExportExists(BAD_EXPORT))
      await removeNfsExport(BAD_EXPORT)
  })

  test('a refused request (400) echoing <b>x</b> shows the literal text', async ({ page }) => {
    await loginToPve(page)
    await page.waitForFunction(() => typeof (window as unknown as { ANAS?: { runJob?: unknown } }).ANAS?.runJob === 'function')

    const r = await runAndReadAlert(page, {
      method: 'post',
      path: '/mounts',
      body: { type: 'nfs', server: '127.0.0.1', remotePath: '/srv/none', mountpoint: `/mnt/pve/${MARK}`, mountNow: false },
      failTitle: 'cr11 refused',
    })
    expect(r.text).toContain(`/mnt/pve/${MARK}`)
    expect(r.text).toContain('PVE territory')
    expect(r.boldCount).toBe(0)
    expect(r.html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  test('a failed job whose error carries <b>x</b> shows the literal text', async ({ page }) => {
    const before = await sshExec('sha256sum /etc/exports')
    await loginToPve(page)
    await page.waitForFunction(() => typeof (window as unknown as { ANAS?: { runJob?: unknown } }).ANAS?.runJob === 'function')

    const r = await runAndReadAlert(page, {
      method: 'post',
      path: '/shares/nfs',
      body: { path: BAD_EXPORT, clients: [{ spec: '127.0.0.1', options: ['ro'] }] },
      failTitle: 'cr11 failed job',
    })
    expect(r.text).toContain(`Failed to stat ${BAD_EXPORT}`)
    expect(r.boldCount).toBe(0)
    expect(r.html).toContain('&lt;b&gt;x&lt;/b&gt;')
    // cr.13: the rejected export was rolled back.
    expect(await sshExec('sha256sum /etc/exports')).toBe(before)
  })
})
