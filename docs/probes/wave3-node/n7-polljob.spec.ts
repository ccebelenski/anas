import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from '../../../tests/integration/fixtures/pve-ui'
import { sshExec } from '../../../tests/integration/fixtures/stunt-node'

/**
 * N7 (WAVE3-DESIGN §8.3, story cr.45) — `pollJob` in the real UI.
 *
 * A throwaway ZFS pool `$W3_POOL` whose dataset `$W3_POOL/big` holds a large
 * tree. `$W3_HOLDER` (a shell command run on the host) starts a long
 * guarded job on that pool — a recursive ownership apply, which holds the
 * pool's `zpool:<guid>` key SHARED. The UI then exports the pool, which needs
 * the key EXCLUSIVE, so the export job sits `queued` behind the holder and the
 * Export confirm's poll keeps polling — the "dialog that polls".
 *
 *   W3_MODE=still  — the export is still queued at the 15 s attention window
 *                    → the "still running" toast; when the holder ends the
 *                    export runs and its completion toast arrives.
 *   W3_MODE=lost   — after the toast, `systemctl stop anasd` for 70 s → the
 *                    "Lost contact" alert (60 s without a successful poll).
 *   W3_MODE=gone   — after the toast, anasd stopped ~8 s and started again →
 *                    the first successful poll answers 404 → "Job lost".
 *
 * Every alert/toast text is timed from the click on Yes; `W3_OUT` appends a
 * JSON line per run.
 */
const POOL = process.env.W3_POOL ?? 'w3n7'
const MODE = process.env.W3_MODE ?? 'still'
const HOLDER = process.env.W3_HOLDER

test(`N7 pollJob (${MODE})`, async ({ page }) => {
  test.setTimeout(420_000)
  const events: { t: number, what: string }[] = []
  let t0 = Date.now()
  const note = (what: string): void => {
    events.push({ t: Math.round((Date.now() - t0) / 100) / 10, what })
    console.log(`[t+${events.at(-1)!.t}s] ${what}`)
  }
  page.on('response', (res) => {
    const u = res.url()
    if (u.includes('/anas/') && u.includes('/jobs/'))
      note(`poll ${res.status()} ${u.replace(/^.*\/jobs\//, 'jobs/')}`)
  })
  page.on('requestfailed', (req) => {
    if (req.url().includes('/jobs/'))
      note(`poll FAILED ${req.failure()?.errorText}`)
  })

  await loginToPve(page)
  await openAnasItem(page, 'Pools')
  const grid = page.locator('.anas-grid-pools')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  await grid.locator('.x-grid-row', { hasText: POOL }).click()

  if (HOLDER) {
    const out = execFileSync('bash', ['-c', HOLDER], { encoding: 'utf8' })
    console.log(`holder: ${out.trim()}`)
  }

  await page.locator('.anas-btn-export').click()
  const yes = page.getByRole('button', { name: 'Yes' })
  await yes.waitFor({ state: 'visible', timeout: 30_000 })
  t0 = Date.now()
  events.length = 0
  await yes.click()
  note('clicked Yes')

  const still = page.getByText(/is still running/)
  await expect(still).toBeVisible({ timeout: 30_000 })
  note(`toast: ${(await still.first().innerText()).replace(/\s+/g, ' ')}`)

  if (MODE === 'still') {
    if (process.env.W3_RELEASE) {
      await page.waitForTimeout(10_000)
      execFileSync('bash', ['-c', process.env.W3_RELEASE], { encoding: 'utf8' })
      note('holder released (NFS lazily unmounted, port reopened)')
    }
    const done = page.getByText(new RegExp(`Exported ${POOL}`))
    await expect(done).toBeVisible({ timeout: 300_000 })
    note(`toast: ${(await done.first().innerText()).replace(/\s+/g, ' ')}`)
  }
  else {
    await sshExec('systemctl stop anasd')
    note('anasd stopped')
    if (MODE === 'gone') {
      await page.waitForTimeout(8_000)
      await sshExec('systemctl start anasd anas')
      note('anasd + anas started')
    }
    const box = page.locator('.x-message-box:visible')
    await expect(box).toBeVisible({ timeout: 120_000 })
    note(`alert: ${(await box.innerText()).replace(/\s+/g, ' ')}`)
    if (MODE === 'lost') {
      await sshExec('systemctl start anasd anas')
      note('anasd + anas started')
    }
  }
  if (process.env.W3_OUT)
    appendFileSync(process.env.W3_OUT, `${JSON.stringify({ mode: MODE, pool: POOL, events })}\n`)
})
