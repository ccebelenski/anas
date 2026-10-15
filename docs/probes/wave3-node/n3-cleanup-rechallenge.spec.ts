import type { Request } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from '../../../tests/integration/fixtures/pve-ui'

/**
 * N3 (WAVE3-DESIGN §8.3) + cr.25a browser trace, wave-3 node pass.
 *
 * The real PVE UI, a throwaway pool `$W3_POOL` (created by the record's row on
 * a hot disk): Destroy → the confirm window → tick "Clean up disks" → the
 * window re-challenges in place (an UNCONFIRMED `DELETE ?cleanup=true`) and
 * swaps in the daemon's wipe warning + the leaf by-ids → OK sends the code the
 * SECOND 409 minted, on `?cleanup=true`.
 *
 * Every non-GET request the page sends to /anas/ is traced with the two
 * headers that matter: PVE's `CSRFPreventionToken` (cr.25a: present on every
 * mutation through /anas) and `X-Anas-Confirm-Code`. The trace is printed and,
 * with `W3_OUT=<file>`, written as JSON.
 */
const POOL = process.env.W3_POOL ?? 'w3n3'

interface Traced {
  t: number
  method: string
  url: string
  csrf: string | null
  confirmCode: string | null
  status?: number
  respConfirmCode?: string | null
  respBody?: unknown
}

test('N3: cleanup re-challenges in place; OK sends the cleanup=true code; CSRF header on every mutation', async ({ page }) => {
  test.setTimeout(240_000)
  const t0 = Date.now()
  const trace: Traced[] = []
  const byReq = new Map<Request, Traced>()

  page.on('request', (req) => {
    if (!req.url().includes('/anas/') || req.method() === 'GET')
      return
    const h = req.headers()
    const e: Traced = {
      t: Date.now() - t0,
      method: req.method(),
      url: req.url().replace(/^https:\/\/[^/]+/, ''),
      csrf: h.csrfpreventiontoken ? `${h.csrfpreventiontoken.slice(0, 12)}…(${h.csrfpreventiontoken.length} chars)` : null,
      confirmCode: h['x-anas-confirm'] ?? null,
    }
    trace.push(e)
    byReq.set(req, e)
  })
  page.on('response', async (res) => {
    const e = byReq.get(res.request())
    if (!e)
      return
    e.status = res.status()
    e.respConfirmCode = res.headers()['x-anas-confirm-code'] ?? null
    try {
      e.respBody = await res.json()
    }
    catch {
      e.respBody = null
    }
  })

  await loginToPve(page)
  await openAnasItem(page, 'Pools')
  const grid = page.locator('.anas-grid-pools')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  const row = grid.locator('.x-grid-row', { hasText: POOL })
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.click()
  await page.locator('.anas-btn-destroy').click()

  const win = page.locator('.anas-win-destroy')
  await expect(win).toBeVisible({ timeout: 30_000 })
  const before = (await win.innerText()).replace(/\s+/g, ' ')
  expect(before).not.toContain('wiped')

  await win.locator('.anas-chk-cleanup input').click()
  await expect(win).toContainText('Disks to wipe', { timeout: 30_000 })
  const after = (await win.innerText()).replace(/\s+/g, ' ')

  await win.locator('.anas-btn-destroy-confirm').click()
  // The confirmed DELETE has gone out and answered.
  await expect.poll(() => trace.find(e => e.method === 'DELETE' && e.confirmCode && e.status !== undefined)?.status, { timeout: 30_000 }).toBe(202)
  // Let the job finish (the grid drops the row).
  await expect(grid.locator('.x-grid-row', { hasText: POOL })).toHaveCount(0, { timeout: 120_000 })

  const deletes = trace.filter(e => e.method === 'DELETE')
  const out = { pool: POOL, windowBefore: before, windowAfter: after, trace }
  console.log(JSON.stringify(out, null, 2))
  if (process.env.W3_OUT)
    writeFileSync(process.env.W3_OUT, `${JSON.stringify(out, null, 2)}\n`)

  // 1st: unconfirmed ?cleanup=false → 409; 2nd: unconfirmed ?cleanup=true → 409 (the re-challenge);
  // 3rd: ?cleanup=true WITH the 2nd's code → 202.
  expect(deletes.length).toBe(3)
  expect(deletes[0].url).toContain('cleanup=false')
  expect(deletes[0].confirmCode).toBeNull()
  expect(deletes[0].status).toBe(409)
  expect(deletes[1].url).toContain('cleanup=true')
  expect(deletes[1].confirmCode).toBeNull()
  expect(deletes[1].status).toBe(409)
  expect(deletes[2].url).toContain('cleanup=true')
  expect(deletes[2].confirmCode).toBe(deletes[1].respConfirmCode)
  expect(deletes[2].status).toBe(202)
  for (const e of trace)
    expect(e.csrf, `${e.method} ${e.url} carries CSRFPreventionToken`).not.toBeNull()
})
