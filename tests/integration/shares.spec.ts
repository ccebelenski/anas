import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import {
  makeDir,
  nfsExportExists,
  poolExists,
  removeDir,
  removeNfsExport,
  removeSmbShare,
  smbShareExists,
  sshExec,
} from './fixtures/stunt-node'

/**
 * Epic 6/7 (unified Shares) — full-chain ExtJS specs driven through the real PVE
 * UI on the stunt node (PVE login → ANAS node menu → native Shares grid).
 * Companion to the API specs; this exercises the injected view under test
 * (packages/pve-integration/src/70-shares.js) and the contextual "Share…" action
 * on the Datasets view (60-datasets.js). Modelled on datasets-ui.spec.ts /
 * pools-act-ui.spec.ts — same auth/setup helpers, same selector convention, same
 * teardown discipline.
 *
 * Contracts under test (DESIGN.md §5d "Shares UX"):
 *   - ONE "Shares" menu item → a native grid listing every share across BOTH
 *     protocols, tagged by a Protocol column (SMB + NFS badges), with an Active
 *     column. View/grid hooks: '.anas-view-shares' / '.anas-grid-shares'.
 *   - Toolbar: '.anas-btn-smb-add' / '.anas-btn-nfs-add' / '.anas-btn-smb-settings'
 *     plus '.anas-btn-share-edit' / '.anas-btn-share-remove' (per-selection).
 *   - Create windows '.anas-win-smb-share' / '.anas-win-nfs-export', submit hooks
 *     '.anas-btn-smb-share-submit' / '.anas-btn-nfs-export-submit'. Every mutation
 *     is a job (202 + { job }); the row appears once it lands on the real system.
 *   - Remove is confirmation-gated: an unconfirmed DELETE surfaces the 409 warnings
 *     in '.anas-win-share-remove', confirmed via '.anas-btn-share-remove-confirm'.
 *   - SMB Settings ('.anas-win-smb-settings') surfaces the §5c global config.
 *   - Datasets' contextual '.anas-btn-ds-share' opens the SMB create window
 *     PRE-FILLED from the dataset's mountpoint.
 *
 * ExtJS boot + panel render is slow, so timeouts are generous. Destructive work
 * is confined to THROWAWAY shares (itest_*), torn down in afterEach; the pristine
 * pre-existing config (printers/print$/share1, /testpool/share1 export) is never
 * mutated. Every mutating describe both pre-cleans and post-cleans so a crash
 * can't leak state between runs.
 */

const DS_MOUNT = '/testpool/share1'
const SMB_ITEST = 'itest_smb'
const NFS_ITEST_DIR = '/testpool/itest_nfs'

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

/**
 * Select the stunt node, open Shares, and wait for the grid to render + load.
 */
async function openShares(page: Page): Promise<void> {
  await loginToPve(page)
  await openAnasItem(page, 'Shares')
  await expect(page.locator('.anas-view-shares')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.anas-grid-shares')).toBeVisible({ timeout: 45_000 })
}

/**
 * Locate the grid row whose visible text contains `text`. ExtJS binds a row to
 * '.x-grid-row'; the badge/attribute renderers live inside the same element.
 */
function shareRow(page: Page, text: string) {
  return page.locator('.anas-grid-shares .x-grid-row', { hasText: text })
}

test.describe('ANAS Shares view (stunt node)', () => {
  test.setTimeout(120_000)

  test('renders a native grid listing SMB shares and the NFS export with protocol badges', async ({ page }) => {
    await openShares(page)
    const grid = page.locator('.anas-grid-shares')

    // The pre-existing SMB shares are listed with SMB badges. Match the Name cell
    // EXACTLY (a substring 'share1' would also hit the NFS /testpool/share1 row,
    // and 'printers' the /var/lib/samba/printers path) then assert the SMB badge
    // in the same row.
    for (const name of ['printers', 'print$', 'share1']) {
      const nameCell = grid
        .locator('.x-grid-cell-inner', { hasText: new RegExp(`^${name.replace(/\$/g, '\\$')}$`) })
        .first()
      await expect(nameCell).toBeVisible({ timeout: 45_000 })
      const row = nameCell.locator('xpath=ancestor::*[contains(@class,"x-grid-row")][1]')
      await expect(row.locator('.anas-badge-smb')).toHaveCount(1, { timeout: 20_000 })
    }

    // The pre-existing NFS export (/testpool/share1) is listed with an NFS badge.
    const nfsRow = grid.locator('.x-grid-row').filter({ has: page.locator('.anas-badge-nfs') })
    await expect(nfsRow).toContainText(DS_MOUNT, { timeout: 45_000 })

    // The Active column header is present (SMB-connection count surface, §5d).
    await expect(grid.getByRole('columnheader', { name: 'Active', exact: true })).toBeVisible({ timeout: 20_000 })

    // Native, not embedded — no retired iframe.
    await expect(page.locator('.anas-view-shares iframe')).toHaveCount(0)
  })

  test('the toolbar exposes SMB add / NFS add / SMB settings, and per-selection edit/remove', async ({ page }) => {
    await openShares(page)

    // Selection-free actions are visible + enabled immediately.
    for (const sel of ['.anas-btn-smb-add', '.anas-btn-nfs-add', '.anas-btn-smb-settings', '.anas-btn-refresh']) {
      const btn = page.locator(sel)
      await expect(btn).toBeVisible({ timeout: 20_000 })
      await expect(btn).toBeEnabled()
    }

    // Edit/Remove exist but are disabled until a row is selected (ExtJS marks the
    // disabled state with x-item-disabled / x-btn-disabled on the .anas-btn element).
    for (const sel of ['.anas-btn-share-edit', '.anas-btn-share-remove']) {
      const btn = page.locator(sel)
      await expect(btn).toBeVisible({ timeout: 20_000 })
      await expect(btn).toHaveClass(/x-item-disabled|x-btn-disabled/)
    }

    // Selecting a share enables the per-row actions.
    await shareRow(page, 'share1').first().click()
    for (const sel of ['.anas-btn-share-edit', '.anas-btn-share-remove'])
      await expect(page.locator(sel)).toBeEnabled({ timeout: 20_000 })
  })

  test('the + SMB Share button opens the .anas-win-smb-share window', async ({ page }) => {
    await openShares(page)
    await page.locator('.anas-btn-smb-add').click()
    await expect(page.locator('.anas-win-smb-share')).toBeVisible({ timeout: 20_000 })
  })

  test('the + NFS Export button opens the .anas-win-nfs-export window', async ({ page }) => {
    await openShares(page)
    await page.locator('.anas-btn-nfs-add').click()
    await expect(page.locator('.anas-win-nfs-export')).toBeVisible({ timeout: 20_000 })
  })
})

/**
 * SMB create + confirmation-gated remove — end-to-end on a THROWAWAY share.
 * Serialized because it mutates the real smb.conf; both pre-cleans (beforeEach)
 * and post-cleans (afterEach) so a crash can't leak the stanza between runs.
 */
test.describe.serial('ANAS SMB share create + remove via UI (throwaway share)', () => {
  test.setTimeout(180_000)

  test.beforeEach(async () => {
    await removeSmbShare(SMB_ITEST)
  })

  test.afterEach(async () => {
    await removeSmbShare(SMB_ITEST)
  })

  test('creating an SMB share adds a row, then the confirm-gated remove deletes it', async ({ page }) => {
    await openShares(page)

    // --- Create ---------------------------------------------------------------
    await page.locator('.anas-btn-smb-add').click()
    const win = page.locator('.anas-win-smb-share')
    await expect(win).toBeVisible({ timeout: 20_000 })

    await win.locator('.anas-fld-smb-name input[type="text"]').fill(SMB_ITEST)
    await win.locator('.anas-fld-smb-path input[type="text"]').fill(DS_MOUNT)
    // Defaults (browseable=yes, read-only=no, guest=no) are left untouched.
    await win.locator('.anas-btn-smb-share-submit').click()

    // Source of truth: the stanza really lands in smb.conf (async job).
    await expect.poll(() => smbShareExists(SMB_ITEST), { timeout: 60_000 }).toBe(true)

    // The grid gains the row, badged SMB, with the default read-write attribute
    // (and NOT guest, since guestOk defaulted off).
    const row = shareRow(page, SMB_ITEST)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('.anas-badge-smb').first()).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText('read-write')

    // --- Remove (confirmation-gated) -----------------------------------------
    await row.click()
    await page.locator('.anas-btn-share-remove').click()

    // The unconfirmed DELETE returns 409 → the warnings dialog appears.
    const confirm = page.locator('.anas-win-share-remove')
    await expect(confirm).toBeVisible({ timeout: 30_000 })
    await expect(confirm).toContainText(SMB_ITEST)
    await confirm.locator('.anas-btn-share-remove-confirm').click()

    // Source of truth: the stanza leaves smb.conf, and the row disappears.
    await expect.poll(() => smbShareExists(SMB_ITEST), { timeout: 60_000 }).toBe(false)
    await expect(shareRow(page, SMB_ITEST)).toHaveCount(0, { timeout: 30_000 })
  })
})

/**
 * NFS create + confirmation-gated remove — end-to-end on a THROWAWAY export.
 * The export path must exist on disk before exportfs accepts it, so the dir is
 * staged in beforeEach and removed in afterEach alongside the export line.
 */
test.describe.serial('ANAS NFS export create + remove via UI (throwaway export)', () => {
  test.setTimeout(180_000)

  test.beforeEach(async () => {
    await removeNfsExport(NFS_ITEST_DIR)
    await makeDir(NFS_ITEST_DIR)
  })

  test.afterEach(async () => {
    await removeNfsExport(NFS_ITEST_DIR)
    await removeDir(NFS_ITEST_DIR)
  })

  test('creating an NFS export adds a row, then the confirm-gated remove deletes it', async ({ page }) => {
    await openShares(page)

    // --- Create ---------------------------------------------------------------
    await page.locator('.anas-btn-nfs-add').click()
    const win = page.locator('.anas-win-nfs-export')
    await expect(win).toBeVisible({ timeout: 20_000 })

    await win.locator('.anas-fld-nfs-path input[type="text"]').fill(NFS_ITEST_DIR)

    // The client grid seeds one blank row (options pre-filled). Fill its spec via
    // the cell editor: click the first spec cell, type the subnet into the
    // .anas-fld-client-spec editor, and commit with Tab.
    const clientGrid = win.locator('.anas-grid-nfs-clients')
    await clientGrid.locator('.x-grid-row').first().locator('.x-grid-cell').first().click()
    const specEditor = win.locator('.anas-fld-client-spec input[type="text"]')
    await expect(specEditor).toBeVisible({ timeout: 20_000 })
    await specEditor.fill('192.168.200.0/24')
    await specEditor.press('Tab')

    await win.locator('.anas-btn-nfs-export-submit').click()

    // Source of truth: the export lands in /etc/exports (async job).
    await expect.poll(() => nfsExportExists(NFS_ITEST_DIR), { timeout: 60_000 }).toBe(true)

    // The grid gains the row, badged NFS.
    const row = shareRow(page, NFS_ITEST_DIR).filter({ has: page.locator('.anas-badge-nfs') })
    await expect(row).toBeVisible({ timeout: 30_000 })

    // --- Remove (confirmation-gated) -----------------------------------------
    await row.click()
    await page.locator('.anas-btn-share-remove').click()

    const confirm = page.locator('.anas-win-share-remove')
    await expect(confirm).toBeVisible({ timeout: 30_000 })
    await expect(confirm).toContainText(NFS_ITEST_DIR)
    await confirm.locator('.anas-btn-share-remove-confirm').click()

    // Source of truth: the export leaves /etc/exports, and the row disappears.
    await expect.poll(() => nfsExportExists(NFS_ITEST_DIR), { timeout: 60_000 }).toBe(false)
    await expect(shareRow(page, NFS_ITEST_DIR).filter({ has: page.locator('.anas-badge-nfs') }))
      .toHaveCount(0, { timeout: 30_000 })
  })
})

/**
 * SMB Settings round-trip (§5c global config). Non-destructive: the whole smb.conf
 * is snapshotted in beforeEach and restored (+ smbd reload) in afterEach, so the
 * real file ends byte-identical regardless of how the round-trip goes.
 */
test.describe.serial('ANAS SMB Settings round-trip (reversible)', () => {
  test.setTimeout(180_000)

  const BAK = '/tmp/anas-itest-smb.conf.bak'
  const TEST_SERVER_STRING = 'anas itest server string'

  test.beforeEach(async () => {
    await sshExec(`cp -a /etc/samba/smb.conf ${BAK}`)
  })

  test.afterEach(async () => {
    // Restore the pristine file and reload smbd so nothing leaks out-of-band.
    await sshExec(`cp -a ${BAK} /etc/samba/smb.conf && systemctl reload smbd 2>/dev/null; rm -f ${BAK} || true`).catch(() => {})
  })

  test('SMB Settings loads workgroup=WORKGROUP and persists a server-string edit', async ({ page }) => {
    await openShares(page)

    // Open the settings window; it loads the current global config.
    await page.locator('.anas-btn-smb-settings').click()
    const win = page.locator('.anas-win-smb-settings')
    await expect(win).toBeVisible({ timeout: 20_000 })

    const workgroup = win.locator('.anas-fld-workgroup input[type="text"]')
    await expect(workgroup).toHaveValue('WORKGROUP', { timeout: 20_000 })

    // Capture the original server string so we can restore it through the UI too
    // (the file restore in afterEach is the backstop).
    const serverString = win.locator('.anas-fld-server-string input[type="text"]')
    const original = await serverString.inputValue()

    // Edit → submit → the job persists it to smb.conf.
    await serverString.fill(TEST_SERVER_STRING)
    await win.locator('.anas-btn-smb-settings-submit').click()
    await expect(win).toBeHidden({ timeout: 30_000 })
    await expect
      .poll(() => sshExec(`testparm -s --parameter-name='server string' 2>/dev/null`).catch(() => ''), { timeout: 60_000 })
      .toBe(TEST_SERVER_STRING)

    // Reopen → the edited value is loaded back (persisted round-trip).
    await page.locator('.anas-btn-smb-settings').click()
    await expect(win).toBeVisible({ timeout: 20_000 })
    await expect(serverString).toHaveValue(TEST_SERVER_STRING, { timeout: 20_000 })

    // Set it back through the UI, restoring the original value.
    await serverString.fill(original)
    await win.locator('.anas-btn-smb-settings-submit').click()
    await expect(win).toBeHidden({ timeout: 30_000 })
  })
})

/**
 * Contextual "Share…" from Datasets (§5d) — the Datasets toolbar action opens the
 * SMB create window PRE-FILLED from the selected filesystem dataset's mountpoint,
 * with a suggested name. Read-only: the window is cancelled, nothing is created.
 */
test.describe('ANAS contextual Share… from a dataset (stunt node)', () => {
  test.setTimeout(120_000)

  test('Share… → SMB pre-fills the create window with the dataset mountpoint', async ({ page }) => {
    await loginToPve(page)
    await openAnasItem(page, 'Datasets')
    await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })

    // Select the filesystem dataset 'share1' (mountpoint /testpool/share1).
    await page.locator('.anas-grid-datasets').getByText('share1', { exact: true }).first().click()

    // Open the "Share…" split menu and pick SMB.
    const shareBtn = page.locator('.anas-btn-ds-share')
    await expect(shareBtn).toBeEnabled({ timeout: 20_000 })
    await shareBtn.click()
    const smbItem = page.locator('.anas-btn-ds-share-smb')
    await expect(smbItem).toBeVisible({ timeout: 20_000 })
    await smbItem.click()

    // The SMB create window opens pre-filled from the mountpoint.
    const win = page.locator('.anas-win-smb-share')
    await expect(win).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.anas-fld-smb-path input[type="text"]')).toHaveValue(DS_MOUNT, { timeout: 20_000 })
    // The name is suggested from the dataset's last path segment.
    await expect(win.locator('.anas-fld-smb-name input[type="text"]')).toHaveValue('share1', { timeout: 20_000 })

    // Read-only test — cancel without creating.
    await win.getByText('Cancel', { exact: true }).click()
    await expect(win).toBeHidden({ timeout: 20_000 })
  })
})
