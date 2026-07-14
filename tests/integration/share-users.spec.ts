import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import {
  removeShareGroup,
  removeShareUser,
  shareGroupExists,
  shareUserExists,
  smbUserExists,
  userDisabled,
  userGroups,
} from './fixtures/stunt-node'

/**
 * Epic 8 Unit 1 (Share Users & Groups) — full-chain ExtJS specs driven through
 * the real PVE UI on the stunt node (PVE login → ANAS node menu → native Share
 * Users view). Companion to the identity API specs; this exercises the injected
 * view under test (packages/pve-integration/src/80-users.js). Modelled on
 * shares.spec.ts — same auth/setup helpers, same selector convention, same
 * teardown discipline.
 *
 * Contracts under test (DESIGN.md "Identity — share users & groups (Epic 8)",
 * EPICS Epic 8.1–8.6):
 *   - ONE "Share Users" menu item → a single view with TWO grids: share USERS
 *     ('.anas-grid-users') on top, GROUPS ('.anas-grid-groups') below. View cls
 *     '.anas-view-users'. Identities resolve via getent/nsswitch and are
 *     filtered to real accounts (regular-user band + root; service accounts
 *     like nobody are hidden).
 *   - Users grid columns include SMB (passdb ✓/✗) and Source (Local/Directory).
 *   - Toolbar: '.anas-btn-refresh' / '.anas-btn-user-add' (selection-free) plus
 *     '.anas-btn-user-smbpw' / '.anas-btn-user-toggle' / '.anas-btn-user-groups'
 *     (per-selection; enabled only for a LOCAL row — directory users are
 *     read-only). Groups toolbar: '.anas-btn-group-add' / '.anas-btn-group-members'.
 *   - Every mutation is a plain job (202 + { job }) — NOT confirm-gated. The row
 *     appears/updates once the change lands on the real system (getent/pdbedit
 *     are the source of truth). Enable/Disable is a plain UI Ext.Msg.confirm.
 *   - Create windows '.anas-win-group-create' / '.anas-win-user-create', submit
 *     hooks '.anas-btn-group-create-submit' / '.anas-btn-user-create-submit'.
 *     Set-SMB-password window '.anas-win-smb-password', submit
 *     '.anas-btn-smb-password-submit'. Password fields must match their confirm
 *     field or the window won't submit.
 *
 * ExtJS boot + panel render is slow, so timeouts are generous. Destructive work
 * is confined to THROWAWAY identities (itest_usr/itest_grp), torn down (userdel
 * + smbpasswd -x / groupdel over SSH) in beforeEach AND afterEach so a crash
 * can't leak state between runs. The pre-existing login users (root, debian)
 * are never mutated.
 */

const ITEST_USR = 'itest_usr'
const ITEST_GRP = 'itest_grp'
const SMB_PW = 'itest-Passw0rd!'

/**
 * Log into PVE, open Share Users, and wait for the view + both grids to render.
 */
async function openUsers(page: Page): Promise<void> {
  await loginToPve(page)
  await openAnasItem(page, 'Share Users')
  await expect(page.locator('.anas-view-users')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.anas-grid-users')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.anas-grid-groups')).toBeVisible({ timeout: 45_000 })
}

/** A users-grid row whose visible text contains `text`. */
function userRow(page: Page, text: string) {
  return page.locator('.anas-grid-users .x-grid-row', { hasText: text })
}

/** A groups-grid row whose visible text contains `text`. */
function groupRow(page: Page, text: string) {
  return page.locator('.anas-grid-groups .x-grid-row', { hasText: text })
}

// ---------------------------------------------------------------------------
// Read-only view: rendering, filtering, columns, and the local/read-only guard.
// ---------------------------------------------------------------------------

test.describe('ANAS Share Users view (stunt node)', () => {
  test.setTimeout(120_000)

  test('renders both grids, lists real login users, and hides service accounts', async ({ page }) => {
    await openUsers(page)
    const users = page.locator('.anas-grid-users')

    // The real login users on the box (root, debian) surface as share users.
    for (const name of ['root', 'debian']) {
      const nameCell = users
        .locator('.x-grid-cell-inner', { hasText: new RegExp(`^${name}$`) })
        .first()
      await expect(nameCell).toBeVisible({ timeout: 45_000 })
    }

    // Service accounts are filtered out (regular-user band + root only). `nobody`
    // (uid 65534) must NOT appear as a Name cell.
    await expect(
      users.locator('.x-grid-cell-inner', { hasText: /^nobody$/ }),
    ).toHaveCount(0)

    // The SMB (passdb) and Source columns are present.
    await expect(users.getByRole('columnheader', { name: 'SMB', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(users.getByRole('columnheader', { name: 'Source', exact: true })).toBeVisible({ timeout: 20_000 })

    // Native, not embedded — no retired iframe.
    await expect(page.locator('.anas-view-users iframe')).toHaveCount(0)
  })

  test('per-selection actions are disabled until a LOCAL user is selected', async ({ page }) => {
    await openUsers(page)

    // Selection-free actions are visible + enabled immediately.
    for (const sel of ['.anas-btn-refresh', '.anas-btn-user-add', '.anas-btn-group-add']) {
      const btn = page.locator(sel)
      await expect(btn).toBeVisible({ timeout: 20_000 })
      await expect(btn).toBeEnabled()
    }

    // The per-selection user actions exist but are disabled with no selection
    // (ExtJS marks disabled with x-item-disabled / x-btn-disabled).
    for (const sel of ['.anas-btn-user-smbpw', '.anas-btn-user-toggle', '.anas-btn-user-groups']) {
      const btn = page.locator(sel)
      await expect(btn).toBeVisible({ timeout: 20_000 })
      await expect(btn).toHaveClass(/x-item-disabled|x-btn-disabled/)
    }

    // debian is a LOCAL user (getent -s files), so selecting it ENABLES the
    // mutating actions. NOTE: the mirror case — a DIRECTORY (AD/LDAP) user
    // keeping these disabled — needs a directory-provided user on the node to
    // exercise (Epic 14). root is local too, so no local user demonstrates the
    // read-only path; it is deliberately NOT faked here.
    await userRow(page, 'debian').first().click()
    for (const sel of ['.anas-btn-user-smbpw', '.anas-btn-user-toggle', '.anas-btn-user-groups'])
      await expect(page.locator(sel)).toBeEnabled({ timeout: 20_000 })
  })
})

// ---------------------------------------------------------------------------
// Create + lifecycle on THROWAWAY identities. Serialized because it mutates the
// real passwd/group/passdb databases; both pre-cleans (beforeEach) and
// post-cleans (afterEach) so a crash can't leak the account/group between runs.
// ---------------------------------------------------------------------------

test.describe.serial('ANAS Share Users create → SMB password → group → disable via UI', () => {
  test.setTimeout(240_000)

  test.beforeEach(async () => {
    // User first (it may be a member of the group), then the group.
    await removeShareUser(ITEST_USR)
    await removeShareGroup(ITEST_GRP)
  })

  test.afterEach(async () => {
    await removeShareUser(ITEST_USR)
    await removeShareGroup(ITEST_GRP)
  })

  test('creates a group, then a user with SMB password + that group, disables/enables it, and re-sets its SMB password', async ({ page }) => {
    await openUsers(page)

    // --- Create group (8.3) ---------------------------------------------------
    await page.locator('.anas-btn-group-add').click()
    const gwin = page.locator('.anas-win-group-create')
    await expect(gwin).toBeVisible({ timeout: 20_000 })
    await gwin.locator('.anas-fld-group-name input[type="text"]').fill(ITEST_GRP)
    await gwin.locator('.anas-btn-group-create-submit').click()

    // Source of truth: the group really lands (async job), then the row appears.
    await expect.poll(() => shareGroupExists(ITEST_GRP), { timeout: 60_000 }).toBe(true)
    await expect(groupRow(page, ITEST_GRP)).toBeVisible({ timeout: 30_000 })

    // --- Create user + SMB password + group (8.2 / 8.4 / 8.5) ------------------
    await page.locator('.anas-btn-user-add').click()
    const uwin = page.locator('.anas-win-user-create')
    await expect(uwin).toBeVisible({ timeout: 20_000 })

    await uwin.locator('.anas-fld-user-name input[type="text"]').fill(ITEST_USR)
    await uwin.locator('.anas-fld-user-fullname input[type="text"]').fill('Integration Test User')

    // Select the just-created group in the tagfield. It is in the getent-backed
    // pick list (loaded on window open); typing the exact name + Enter commits it
    // (createNewOnEnter). The daemon's useradd -G requires the group to exist —
    // which the poll above guaranteed.
    const groupsInput = uwin.locator('.anas-fld-user-groups input[type="text"]').first()
    // Force past the tagfield's placeholder <label>, which overlays and
    // intercepts pointer events; then type real keystrokes so ExtJS filters the
    // pick list and createNewOnEnter commits the tag.
    await groupsInput.click({ force: true })
    await groupsInput.pressSequentially(ITEST_GRP)
    await groupsInput.press('Enter')

    // SMB password + matching confirm (unmatched → the window won't submit).
    await uwin.locator('.anas-fld-smb-password input[type="password"]').first().fill(SMB_PW)
    await uwin.locator('.anas-fld-smb-password-confirm input[type="password"]').first().fill(SMB_PW)
    await uwin.locator('.anas-btn-user-create-submit').click()

    // Source of truth: the user exists, has a passdb entry, and is in the group.
    await expect.poll(() => shareUserExists(ITEST_USR), { timeout: 60_000 }).toBe(true)
    await expect.poll(() => smbUserExists(ITEST_USR), { timeout: 60_000 }).toBe(true)
    await expect.poll(() => userGroups(ITEST_USR), { timeout: 60_000 }).toContain(ITEST_GRP)

    // The grid gains the user row with SMB ✓, Source=Local, and the group listed.
    const row = userRow(page, ITEST_USR)
    await expect(row).toBeVisible({ timeout: 30_000 })
    // SMB ✓ renders as a green check (&#10003;); Source=Local renders the badge.
    await expect(row.locator('.anas-badge-local')).toHaveCount(1, { timeout: 20_000 })
    await expect(row).toContainText('✓')
    await expect(row).toContainText(ITEST_GRP)

    // --- Disable, then re-enable (8.6) ----------------------------------------
    // Disable: select the row → the toggle button (labelled "Disable") → confirm.
    await row.click()
    const toggle = page.locator('.anas-btn-user-toggle')
    await expect(toggle).toBeEnabled({ timeout: 20_000 })
    await expect(toggle).toContainText('Disable')
    await toggle.click()
    // Plain Ext.Msg.confirm (NOT a daemon confirm-code gate) — accept it.
    await page.getByRole('button', { name: 'Yes' }).click()

    // Source of truth flips to disabled, and the grid Status reads "Disabled".
    await expect.poll(() => userDisabled(ITEST_USR), { timeout: 60_000 }).toBe(true)
    await expect(userRow(page, ITEST_USR)).toContainText('Disabled', { timeout: 30_000 })

    // Re-enable: reselect (the reload cleared selection), toggle (now "Enable"),
    // confirm.
    const disabledRow = userRow(page, ITEST_USR)
    await disabledRow.click()
    await expect(toggle).toBeEnabled({ timeout: 20_000 })
    await expect(toggle).toContainText('Enable')
    await toggle.click()
    await page.getByRole('button', { name: 'Yes' }).click()

    await expect.poll(() => userDisabled(ITEST_USR), { timeout: 60_000 }).toBe(false)
    await expect(userRow(page, ITEST_USR)).toContainText('Active', { timeout: 30_000 })

    // --- Set SMB Password via its window (8.5) --------------------------------
    // Re-select and open the Set SMB Password window; a fresh matching password
    // is a plain 202 job.
    await userRow(page, ITEST_USR).click()
    const smbpwBtn = page.locator('.anas-btn-user-smbpw')
    await expect(smbpwBtn).toBeEnabled({ timeout: 20_000 })
    await smbpwBtn.click()
    const pwin = page.locator('.anas-win-smb-password')
    await expect(pwin).toBeVisible({ timeout: 20_000 })
    await pwin.locator('.anas-fld-smb-password input[type="password"]').first().fill(`${SMB_PW}2`)
    await pwin.locator('.anas-fld-smb-password-confirm input[type="password"]').first().fill(`${SMB_PW}2`)
    await pwin.locator('.anas-btn-smb-password-submit').click()

    // The window closes on job completion and the passdb entry is still present.
    await expect(pwin).toBeHidden({ timeout: 30_000 })
    await expect.poll(() => smbUserExists(ITEST_USR), { timeout: 60_000 }).toBe(true)
  })
})
