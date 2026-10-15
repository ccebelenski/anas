import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, NODE_NAME, openAnasItem } from '../../../tests/integration/fixtures/pve-ui'
import { sshExec } from '../../../tests/integration/fixtures/stunt-node'
import { Recorder, startSampler, stopSampler, visibleMessageBoxes } from './w2-lib'

/**
 * Wave-2 node pass, story cr.48 in the real PVE UI: the three slow interactive
 * reads are `read.*` jobs that the dialog polls, with a progress line and a
 * Cancel/Stop while they run and the answer from job.result when done.
 *
 *   cloud sync preview  — the New Cloud Sync Task wizard's Preview (never saved:
 *                         the wizard is closed with Cancel)
 *   remote test         — Cloud Sync → Remotes… → select → Test (its own window)
 *   catalog listing     — Backup → Restore from repository… → Choose… → Choose
 *                         files… (the archive path picker), never restored
 *
 * Fixtures (wave-2 setup, never touched here): dataset /gtbackup/w2src, rclone
 * remotes w2ok (answers) and w2bh (blackholed 192.0.2.10), backup repos pbsgt
 * (real PBS, read-only use) and w2bh (blackholed).
 */

const READ_PATHS = /^\/(cloud\/tasks\/preview|cloud\/remotes\/test|backup\/restore\/browse)$/
const SNAPSHOT = 'host/gtguard/2026-09-25T02:36:53Z'
// pgrep -f would match the ssh shell's own command line; the [p] keeps grep off itself.
const PBC_PS = 'ps -eo pid,pgid,etimes,args | grep \'[p]roxmox-backup-client\' || true'

async function openCloud(page: Page): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Cloud Sync')
  const grid = page.locator('.anas-grid-cloud-tasks')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  return grid
}

async function pickCombo(page: Page, field: Locator, item: string | RegExp): Promise<void> {
  await field.locator('.x-form-trigger').first().click()
  const list = page.locator('.x-boundlist:visible').last()
  await expect(list).toBeVisible({ timeout: 15_000 })
  await list.locator('.x-boundlist-item', { hasText: item }).first().click()
}

async function openPreviewWizard(page: Page, remote: string): Promise<Locator> {
  const grid = await openCloud(page)
  await grid.locator('.anas-btn-cloud-task-create').click()
  const dlg = page.locator('.anas-win-cloud-task')
  await expect(dlg).toBeVisible({ timeout: 30_000 })
  await dlg.locator('.anas-fld-cloud-source input').fill('/gtbackup/w2src')
  await pickCombo(page, dlg.locator('.anas-fld-cloud-remote'), new RegExp(`^${remote}$`))
  await dlg.locator('.anas-fld-cloud-remote-path input').fill('w2dst')
  // ExtJS buffers a text field's change event (checkChangeBuffer). Clicking
  // Preview inside that window lets the late change withdraw the preview just
  // sent (refreshCloudPreview → a quiet cancel) — seen in the first run. A
  // person cannot type and click that fast; let the buffered change land.
  await page.waitForTimeout(600)
  await expect(dlg.locator('.anas-btn-cloud-task-preview')).not.toHaveClass(/x-btn-disabled/, { timeout: 15_000 })
  return dlg
}

/** Close the wizard with its Cancel and prove no task was saved. */
async function closeWizardUnsaved(page: Page, dlg: Locator, rec: Recorder): Promise<void> {
  await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dlg).toBeHidden({ timeout: 15_000 })
  const saves = rec.posts.filter(p => /^(POST|PUT) \/cloud\/tasks(\/[^/]+)?$/.test(p) && !p.endsWith('/preview'))
  rec.note(`wizard closed with Cancel; task-saving requests made: ${saves.length ? saves.join(', ') : 'none'}`)
  expect(saves).toEqual([])
}

async function rcloneProcs(): Promise<string> {
  return sshExec('pgrep -ax rclone || true')
}

/** Whether a sampled probe was ever visible (optionally with matching text). */
function sawVisible(samples: { k: string, v: string }[], key: string, text?: RegExp): boolean {
  return samples.some(s => s.k === key && s.v.startsWith('visible') && (!text || text.test(s.v)))
}

function dumpSamples(rec: Recorder, samples: { t: number, k: string, v: string }[]): void {
  for (const s of samples)
    rec.note(`  dom[t+${s.t}s from sampler start] ${s.k}: ${s.v}`)
}

/** Cancel through the dialog's control, then the job ends cancelled with no confirm window. */
async function cancelAndProve(page: Page, rec: Recorder, control: Locator, label: string): Promise<void> {
  const job = rec.last()!
  const before = await visibleMessageBoxes(page)
  rec.note(`${label}: clicking ${await control.innerText()} (job ${job.id}, last status ${rec.lastStatus(job)})`)
  await control.click()
  await expect.poll(() => job.cancel?.http ?? 0, { timeout: 15_000 }).toBe(202)
  await expect.poll(() => rec.lastStatus(job), { timeout: 30_000 }).toBe('cancelled')
  await page.waitForTimeout(1500)
  const after = await visibleMessageBoxes(page)
  rec.note(`${label}: message boxes before the click ${JSON.stringify(before)}, after ${JSON.stringify(after)}`)
  expect(job.cancel!.confirmHeader).toBe(false)
  expect(after).toEqual([])
}

async function noRcloneLeft(rec: Recorder, label: string): Promise<void> {
  let left = ''
  await expect.poll(async () => (left = await rcloneProcs()), { timeout: 15_000 }).toBe('')
  rec.note(`${label}: on the node \`pgrep -ax rclone\` -> ${left === '' ? '(empty)' : left}`)
}

test.describe.serial('cr.48 read jobs in the PVE UI', () => {
  test('preview fast: w2ok answers, result from job.result', async ({ page }) => {
    test.setTimeout(180_000)
    const rec = new Recorder(page, READ_PATHS)
    const dlg = await openPreviewWizard(page, 'w2ok')
    await startSampler(page, {
      line: '.anas-win-cloud-task .anas-cloud-preview-line',
      cancel: '.anas-win-cloud-task .anas-btn-cloud-preview-cancel',
    })
    rec.reset()
    await dlg.locator('.anas-btn-cloud-task-preview').click()
    rec.note('clicked Preview (w2ok)')
    const line = dlg.locator('.anas-cloud-preview-line')
    await expect(line).toContainText(/Would transfer|Nothing to do/, { timeout: 60_000 })
    const job = rec.last()!
    const samples = await stopSampler(page)
    dumpSamples(rec, samples)
    rec.note(`final line: "${(await line.innerText()).replace(/\s+/g, ' ')}"`)
    expect(job.postStatus).toBe(202)
    expect(job.operation).toBe('read.cloud.preview')
    expect(rec.lastStatus(job)).toBe('completed')
    expect(sawVisible(samples, 'line', /asking the server/)).toBe(true)
    expect(sawVisible(samples, 'cancel', /Cancel preview/)).toBe(true)
    // The numbers on screen are job.result's.
    const r = job.result as { transfers: number }
    expect(await line.innerText()).toContain(`Would transfer ${r.transfers} file`)
    await expect(dlg.locator('.anas-btn-cloud-preview-cancel')).toBeHidden()
    await closeWizardUnsaved(page, dlg, rec)
  })

  test('preview slow: w2bh still running past 12 s, then Cancel', async ({ page }) => {
    test.setTimeout(240_000)
    const rec = new Recorder(page, READ_PATHS)
    expect(await rcloneProcs()).toBe('')
    const dlg = await openPreviewWizard(page, 'w2bh')
    rec.reset()
    await dlg.locator('.anas-btn-cloud-task-preview').click()
    rec.note('clicked Preview (w2bh)')
    const cancel = dlg.locator('.anas-btn-cloud-preview-cancel')
    const line = dlg.locator('.anas-cloud-preview-line')
    await expect(cancel).toBeVisible({ timeout: 15_000 })
    const job = await expect.poll(() => rec.last()?.id ?? '', { timeout: 15_000 }).not.toBe('').then(() => rec.last()!)
    expect(job.postStatus).toBe(202)
    expect(job.operation).toBe('read.cloud.preview')
    // Past the old synchronous budget (12 s) the job is still running and the
    // dialog still shows the waiting line and the Cancel.
    await page.waitForTimeout(Math.max(0, (job.postAt + 14) * 1000 - (Date.now() - rec.t0)))
    rec.note(`at t+${rec.now()}s: job status ${rec.lastStatus(job)} after ${job.polls.length} polls; line "${(await line.innerText()).replace(/\s+/g, ' ')}"; node: ${(await rcloneProcs()).split('\n').length} rclone process(es)`)
    expect(rec.lastStatus(job)).toBe('running')
    expect(job.polls.at(-1)!.t).toBeGreaterThan(job.postAt + 12)
    await expect(line).toContainText('asking the server')
    await expect(cancel).toBeVisible()
    await expect(cancel).toBeEnabled()
    await cancelAndProve(page, rec, cancel, 'preview')
    await expect(line).toContainText('Preview cancelled — nothing was copied or deleted.', { timeout: 10_000 })
    rec.note(`final line: "${(await line.innerText()).replace(/\s+/g, ' ')}"`)
    await expect(cancel).toBeHidden()
    await noRcloneLeft(rec, 'preview')
    await closeWizardUnsaved(page, dlg, rec)
  })

  async function openRemoteTest(page: Page, remote: string, rec: Recorder): Promise<Locator> {
    const grid = await openCloud(page)
    await grid.locator('.anas-btn-cloud-remotes').click()
    const mgr = page.locator('.anas-win-cloud-remotes')
    await expect(mgr.locator('.anas-grid-cloud-remotes')).toBeVisible({ timeout: 30_000 })
    await mgr.locator('.x-grid-row', {
      has: page.locator('.x-grid-cell-inner', { hasText: new RegExp(`^${remote}$`) }),
    }).first().click()
    await startSampler(page, {
      area: '.anas-win-cloud-remote-test .anas-cloud-test-result',
      cancel: '.anas-win-cloud-remote-test .anas-btn-cloud-test-cancel',
    })
    rec.reset()
    await mgr.locator('.anas-btn-cloud-remote-test').click()
    rec.note(`clicked Test (${remote})`)
    const win = page.locator('.anas-win-cloud-remote-test')
    await expect(win).toBeVisible({ timeout: 15_000 })
    return win
  }

  test('remote test fast: w2ok verdict ok', async ({ page }) => {
    test.setTimeout(180_000)
    const rec = new Recorder(page, READ_PATHS)
    const win = await openRemoteTest(page, 'w2ok', rec)
    const verdict = win.locator('.anas-cloud-test-verdict')
    await expect(verdict).toBeVisible({ timeout: 60_000 })
    const samples = await stopSampler(page)
    dumpSamples(rec, samples)
    const job = rec.last()!
    rec.note(`verdict line: "${(await verdict.innerText()).replace(/\s+/g, ' ')}"`)
    expect(job.postStatus).toBe(202)
    expect(job.operation).toBe('read.cloud.remote.test')
    expect(rec.lastStatus(job)).toBe('completed')
    expect((job.result as { verdict: string }).verdict).toBe('ok')
    expect(sawVisible(samples, 'area', /testing remote/)).toBe(true)
    expect(sawVisible(samples, 'cancel', /Cancel test/)).toBe(true)
    await expect(win.locator('.anas-btn-cloud-test-cancel')).toBeHidden()
    await win.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(win).toBeHidden()
  })

  test('remote test slow: w2bh cancelled at ~3 s', async ({ page }) => {
    test.setTimeout(180_000)
    const rec = new Recorder(page, READ_PATHS)
    expect(await rcloneProcs()).toBe('')
    const win = await openRemoteTest(page, 'w2bh', rec)
    const cancel = win.locator('.anas-btn-cloud-test-cancel')
    await expect(cancel).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => rec.last()?.id ?? '', { timeout: 10_000 }).not.toBe('')
    const job = rec.last()!
    expect(job.postStatus).toBe(202)
    expect(job.operation).toBe('read.cloud.remote.test')
    await page.waitForTimeout(Math.max(0, (job.postAt + 3) * 1000 - (Date.now() - rec.t0)))
    const area = win.locator('.anas-cloud-test-result')
    rec.note(`at t+${rec.now()}s: job status ${rec.lastStatus(job)}; area "${(await area.innerText()).replace(/\s+/g, ' ')}"; node: ${await rcloneProcs() || '(no rclone)'}`)
    expect(rec.lastStatus(job)).toBe('running')
    await expect(area).toContainText('testing remote')
    await cancelAndProve(page, rec, cancel, 'remote test')
    await expect(area).toContainText('Test cancelled — nothing was changed.', { timeout: 10_000 })
    rec.note(`final area: "${(await area.innerText()).replace(/\s+/g, ' ')}"`)
    dumpSamples(rec, await stopSampler(page))
    await expect(cancel).toBeHidden()
    await noRcloneLeft(rec, 'remote test')
    await win.getByRole('button', { name: 'Close', exact: true }).click()
  })

  test('catalog listing fast: root of guarded.pxar in the pbsgt snapshot', async ({ page }) => {
    test.setTimeout(240_000)
    const rec = new Recorder(page, READ_PATHS)
    await loginToPve(page)
    await openAnasItem(page, 'Backup')
    const restoreBtn = page.locator('.anas-btn-backup-restore-repo')
    await expect(restoreBtn).toBeVisible({ timeout: 45_000 })
    await restoreBtn.click()
    const dlg = page.locator('.anas-win-backup-restore')
    await expect(dlg).toBeVisible({ timeout: 30_000 })
    await pickCombo(page, dlg.locator('.anas-fld-restore-repo'), /pbsgt/)
    const group = dlg.locator('.anas-fld-restore-group input')
    await group.fill('host/gtguard')
    await dlg.locator('.anas-btn-restore-snap').click()
    const snapWin = page.locator('.anas-win-snapshot-picker')
    await expect(snapWin).toBeVisible({ timeout: 30_000 })
    await snapWin.locator('.x-grid-row', { hasText: /2026-09-25.02:36:53/ }).first().click({ timeout: 60_000 })
    await snapWin.locator('.anas-btn-snap-select').click()
    await expect(snapWin).toBeHidden({ timeout: 15_000 })
    await expect(dlg.locator('.anas-fld-restore-snapshot input')).toHaveValue(SNAPSHOT)
    const archive = dlg.locator('.anas-fld-restore-archive input')
    if (!/guarded\.pxar/.test(await archive.inputValue()))
      await pickCombo(page, dlg.locator('.anas-fld-restore-archive'), /guarded\.pxar/)
    await expect(archive).toHaveValue(/guarded\.pxar/)
    await startSampler(page, {
      stop: '.anas-win-path-picker .anas-btn-picker-stop',
      mask: '.anas-win-path-picker .x-mask-msg',
    })
    rec.reset()
    await dlg.locator('.anas-btn-restore-files').click()
    rec.note('clicked Choose files… (archive picker, path /)')
    const picker = page.locator('.anas-win-path-picker')
    await expect(picker).toBeVisible({ timeout: 15_000 })
    const proof = picker.locator('.x-grid-cell-inner', { hasText: /^proof\.txt$/ })
    await expect(proof).toBeVisible({ timeout: 60_000 })
    const samples = await stopSampler(page)
    dumpSamples(rec, samples)
    const job = rec.last()!
    expect(job.postStatus).toBe(202)
    expect(job.operation).toBe('read.backup.catalog')
    expect(rec.lastStatus(job)).toBe('completed')
    const entries = (job.result as { entries: { path: string }[] }).entries.map(e => e.path)
    rec.note(`job.result entries: ${JSON.stringify(entries)}; tree rows: ${JSON.stringify(await picker.locator('.anas-tree-path-picker .x-grid-row').allInnerTexts())}`)
    expect(entries).toContain('/proof.txt')
    expect(sawVisible(samples, 'stop', /Stop/)).toBe(true)
    await expect(picker.locator('.anas-btn-picker-stop')).toBeHidden()
    // Leave without selecting and without restoring.
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(picker).toBeHidden()
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dlg).toBeHidden()
    const writes = rec.posts.filter(p => !/\/backup\/restore\/browse$/.test(p) && !/\/jobs\//.test(p))
    rec.note(`mutating requests made: ${writes.length ? writes.join(', ') : 'none'}`)
    expect(writes).toEqual([])
  })

  test('catalog listing slow: the archive picker on the blackholed repo w2bh, Stop', async ({ page }) => {
    // The restore dialog cannot reach this state from the UI: on a dead repo
    // the point-in-time picker cannot list snapshots, and the archive combo is
    // filled only from that listing. So the SAME picker the dialog's "Choose
    // files…" opens (ANAS.pathPicker, backend 'archive', exactly the cfg
    // pickRestoreFiles passes) is opened directly with the w2bh repo.
    test.setTimeout(180_000)
    const rec = new Recorder(page, READ_PATHS)
    await loginToPve(page)
    await openAnasItem(page, 'Backup')
    await expect(page.locator('.anas-btn-backup-restore-repo')).toBeVisible({ timeout: 45_000 })
    rec.reset()
    await page.evaluate((node) => {
      const A = (window as unknown as { ANAS: { pathPicker: (c: unknown) => void } }).ANAS
      A.pathPicker({
        node,
        backend: 'archive',
        mode: 'any',
        multiSelect: true,
        value: '/',
        title: 'Choose what to restore',
        archive: { repo: 'w2bh', snapshot: 'host/w2b1/2026-10-15T00:00:00Z', archive: 'w2data.pxar' },
        onSelect() {},
      })
    }, NODE_NAME)
    rec.note('opened ANAS.pathPicker (archive backend) on repo w2bh')
    const picker = page.locator('.anas-win-path-picker')
    const stop = picker.locator('.anas-btn-picker-stop')
    await expect(stop).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => rec.last()?.id ?? '', { timeout: 10_000 }).not.toBe('')
    const job = rec.last()!
    expect(job.postStatus).toBe(202)
    expect(job.operation).toBe('read.backup.catalog')
    await page.waitForTimeout(Math.max(0, (job.postAt + 3) * 1000 - (Date.now() - rec.t0)))
    const pbc = await sshExec(PBC_PS)
    rec.note(`at t+${rec.now()}s: job status ${rec.lastStatus(job)}; node: ${pbc || '(no proxmox-backup-client)'}`)
    expect(rec.lastStatus(job)).toBe('running')
    await cancelAndProve(page, rec, stop, 'catalog listing')
    await expect(picker.locator('.x-component', { hasText: 'Listing of / stopped.' }).first()).toBeVisible({ timeout: 10_000 })
    rec.note('picker note: "Listing of / stopped."')
    let left = ''
    await expect.poll(async () => (left = await sshExec(PBC_PS)), { timeout: 15_000 }).toBe('')
    rec.note(`catalog listing: on the node \`ps | grep proxmox-backup-client\` -> ${left || '(empty)'}`)
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})
