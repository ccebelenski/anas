import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from './fixtures/pve-ui'
import {
  aclHasNamedUser,
  createShareUser,
  destroyDataset,
  getDatasetMountpoint,
  getDatasetProp,
  getMode,
  poolExists,
  removeShareUser,
  resetDatasetAccess,
  sshExec,
} from './fixtures/stunt-node'

/**
 * Epic 4.7.2 (layered permissions editor) — full-chain ExtJS specs driven
 * through the real PVE UI on the stunt node (PVE login → ANAS node menu →
 * Datasets grid → Permissions). Companion to the access API spec; this exercises
 * the injected editor under test (packages/pve-integration/src/60-datasets.js
 * `openPermissions`). Modelled on datasets-ui.spec.ts / share-users.spec.ts —
 * same auth/setup helpers, same selector convention, same teardown discipline.
 *
 * Contracts under test (packages/shared/src/schemas/access.ts + openPermissions):
 *   - The Datasets 'Permissions' action opens '.anas-win-dataset-access' for a
 *     FILESYSTEM dataset. It renders the base three principals — owner + group
 *     pickers ('.anas-fld-access-owner' / '-group') each with a level dropdown
 *     ('-owner-level' / '-group-level'), plus an 'everyone' level
 *     ('.anas-fld-access-everyone-level') — a named-principal grid
 *     ('.anas-grid-access-named') with a '+ Add user or group' button
 *     ('.anas-btn-access-add'), an 'apply to existing' checkbox
 *     ('.anas-fld-access-recursive'), and a collapsible Advanced getfacl panel
 *     ('.anas-panel-access-advanced'). Submit is '.anas-btn-dataset-access-submit'.
 *   - The base three map to POSIX mode bits (none=0, read=5 r-x, read-write=7 rwx).
 *     Every mutation is a plain 202 job (NOT confirm-gated); the change lands on
 *     the real system (stat / getfacl are the source of truth).
 *   - Adding a named user enables POSIX ACLs (acltype=posixacl) as a side effect
 *     and writes a `user:<name>:` access-ACL entry; removing it and re-applying
 *     strips the ACL and leaves clean mode bits.
 *   - acl IS installed on this node, so the add button is ENABLED and (while the
 *     dataset is not yet posixacl) the inline "will enable POSIX ACLs" note shows.
 *
 * ExtJS boot + panel render is slow, so timeouts are generous. All destructive
 * work is confined to a THROWAWAY dataset (testpool/itest_perm) and a throwaway
 * user (itest_pu), both torn down over SSH in afterAll so a crash can't leak
 * state. The pre-existing /testpool/share1 is never touched.
 */

const POOL = 'testpool'
const DS_LEAF = 'itest_perm'
const DS_FQ = `${POOL}/${DS_LEAF}`
const PU = 'itest_pu'

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists(POOL)), 'testpool not present — run setup-test-data.sh')
})

// ---------------------------------------------------------------------------
// UI helpers.
// ---------------------------------------------------------------------------

/** Select the dataset leaf in the Datasets tree and open its Permissions window. */
async function openPermsFor(page: Page, leaf: string): Promise<Locator> {
  await page.locator('.anas-grid-datasets').getByText(leaf, { exact: true }).first().click()
  const permsBtn = page.locator('.anas-btn-ds-perms')
  await expect(permsBtn).toBeEnabled({ timeout: 20_000 })
  await permsBtn.click()
  const win = page.locator('.anas-win-dataset-access')
  await expect(win).toBeVisible({ timeout: 20_000 })
  return win
}

/** Log in, open Datasets, and open the Permissions editor for `leaf`. */
async function openPermsEditor(page: Page, leaf: string): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Datasets')
  await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })
  return openPermsFor(page, leaf)
}

/**
 * Pick a value in an ExtJS level combobox by its display label. The base-level
 * comboboxes are editable:false, so the value is chosen from the floating
 * boundlist, not typed. Labels: 'No access' / 'Read' / 'Read-Write' — an exact
 * regex is required because 'Read' is a prefix of 'Read-Write'.
 */
async function pickLevel(page: Page, field: Locator, label: string): Promise<void> {
  await field.click()
  await page
    .locator('.x-boundlist:visible .x-boundlist-item', { hasText: new RegExp(`^${label}$`) })
    .first()
    .click()
}

/** The level combobox input for one of the base three (reads back the label). */
function levelInput(win: Locator, which: 'owner' | 'group' | 'everyone'): Locator {
  return win.locator(`.anas-fld-access-${which}-level input[type="text"]`)
}

// ---------------------------------------------------------------------------
// Serialized lifecycle on a THROWAWAY dataset. beforeAll stages the dataset +
// principal once; beforeEach resets the mountpoint to a pristine 755 / no-ACL /
// acltype-off baseline so each test is independent; afterAll tears everything
// down so the node ends pristine.
// ---------------------------------------------------------------------------

test.describe.serial('ANAS layered permissions editor (throwaway dataset)', () => {
  test.setTimeout(180_000)

  let mount = ''

  test.beforeAll(async () => {
    if (!(await poolExists(POOL)))
      return
    await destroyDataset(DS_FQ)
    await sshExec(`zfs create ${DS_FQ}`)
    mount = await getDatasetMountpoint(DS_FQ)
    await removeShareUser(PU)
    await createShareUser(PU)
  })

  test.afterAll(async () => {
    await removeShareUser(PU)
    await destroyDataset(DS_FQ)
  })

  // Pristine baseline before each test (also the post-clean, since beforeAll ran
  // once): clean ACLs, default mode, acltype reverted.
  test.beforeEach(async () => {
    await resetDatasetAccess(DS_FQ, mount)
  })

  // -- 1. Open the editor: base rows + named grid + Advanced panel render. ----
  test('the Permissions action opens the layered editor with the base rows, named grid, and Advanced panel', async ({ page }) => {
    const win = await openPermsEditor(page, DS_LEAF)

    // Base three: owner + group pickers with level dropdowns, plus everyone level.
    for (const sel of [
      '.anas-fld-access-owner',
      '.anas-fld-access-owner-level',
      '.anas-fld-access-group',
      '.anas-fld-access-group-level',
      '.anas-fld-access-everyone-level',
    ]) {
      await expect(win.locator(sel)).toBeVisible({ timeout: 20_000 })
    }

    // The owner picker loads the dataset's real owner (root on a fresh dataset).
    await expect(win.locator('.anas-fld-access-owner input[type="text"]'))
      .toHaveValue('root', { timeout: 20_000 })

    // Named-principal grid + its add button, apply-to-existing, submit.
    await expect(win.locator('.anas-grid-access-named')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.anas-btn-access-add')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.anas-fld-access-recursive')).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('.anas-btn-dataset-access-submit')).toBeVisible({ timeout: 20_000 })

    // The collapsible Advanced (raw getfacl) panel is present.
    await expect(win.locator('.anas-panel-access-advanced')).toBeVisible({ timeout: 20_000 })
  })

  // -- 4. acl installed → add button ENABLED + "will enable posixacl" note. ---
  test('with acl installed but posixacl not yet enabled, the add button is enabled and the enable-posixacl note shows', async ({ page }) => {
    const win = await openPermsEditor(page, DS_LEAF)

    // The owner load settling is the signal the access payload arrived; only then
    // are the aclSupported/aclEnabled flags reflected into the button + note.
    await expect(win.locator('.anas-fld-access-owner input[type="text"]'))
      .toHaveValue('root', { timeout: 20_000 })

    // acl IS installed (aclSupported) → the add button is enabled.
    await expect(win.locator('.anas-btn-access-add')).toBeEnabled({ timeout: 20_000 })

    // The fresh dataset is not yet posixacl (aclEnabled === false), so the inline
    // note explaining that adding a named principal enables POSIX ACLs shows.
    await expect(win).toContainText('enable POSIX ACLs', { timeout: 20_000 })
    await expect(win).toContainText('acltype=posixacl', { timeout: 20_000 })
  })

  // -- 2. Base-only change: set owner + everyone levels, persist as mode bits. -
  test('a base-only change persists as mode bits and reloads', async ({ page }) => {
    const win = await openPermsEditor(page, DS_LEAF)
    await expect(win.locator('.anas-fld-access-owner input[type="text"]'))
      .toHaveValue('root', { timeout: 20_000 })

    // Baseline is 755 → owner Read-Write, group Read, everyone Read. Change owner
    // → Read (5) and everyone → No access (0), leaving group Read (5): mode 550.
    await pickLevel(page, levelInput(win, 'owner'), 'Read')
    await pickLevel(page, levelInput(win, 'everyone'), 'No access')
    await win.locator('.anas-btn-dataset-access-submit').click()

    // Plain 202 job (no confirm gate): the window closes and the mode really lands.
    await expect(win).toBeHidden({ timeout: 30_000 })
    await expect.poll(() => getMode(mount), { timeout: 60_000 }).toBe('550')

    // Reopen → the persisted levels are reflected back in the dropdowns.
    const win2 = await openPermsFor(page, DS_LEAF)
    await expect(levelInput(win2, 'owner')).toHaveValue('Read', { timeout: 20_000 })
    await expect(levelInput(win2, 'group')).toHaveValue('Read', { timeout: 20_000 })
    await expect(levelInput(win2, 'everyone')).toHaveValue('No access', { timeout: 20_000 })
  })

  // -- 3. Add then remove a named principal (POSIX ACL round-trip). -----------
  test('adding a named user writes a POSIX ACL entry; removing it cleans the mode', async ({ page }) => {
    const win = await openPermsEditor(page, DS_LEAF)
    await expect(win.locator('.anas-fld-access-owner input[type="text"]'))
      .toHaveValue('root', { timeout: 20_000 })

    // --- Add itest_pu with level Read (the add window's default) ---------------
    await win.locator('.anas-btn-access-add').click()
    const addWin = page.locator('.anas-win-access-add')
    await expect(addWin).toBeVisible({ timeout: 20_000 })
    // Kind defaults to 'User'; the name picker is editable (forceSelection:false),
    // so type the throwaway user's name and blur to commit it as the value.
    const nameInput = addWin.locator('.anas-fld-access-add-name input[type="text"]')
    await nameInput.click()
    await nameInput.fill(PU)
    await nameInput.blur()
    // Level defaults to Read — leave it. Submit adds the row to the named grid.
    await addWin.locator('.anas-btn-access-add-submit').click()
    await expect(addWin).toBeHidden({ timeout: 20_000 })

    const namedRow = win.locator('.anas-grid-access-named .x-grid-row', { hasText: PU })
    await expect(namedRow).toBeVisible({ timeout: 20_000 })

    // Apply → plain 202 job. The window closes once it lands.
    await win.locator('.anas-btn-dataset-access-submit').click()
    await expect(win).toBeHidden({ timeout: 30_000 })

    // Source of truth: acltype flipped to posix ACLs and the named ACL entry
    // exists. The daemon's isPosixAcl accepts both spellings ZFS may report
    // (`posixacl` on newer OpenZFS, `posix` here), so match either.
    await expect
      .poll(() => getDatasetProp(DS_FQ, 'acltype'), { timeout: 60_000 })
      .toMatch(/^posix(acl)?$/)
    await expect.poll(() => aclHasNamedUser(mount, PU), { timeout: 60_000 }).toBe(true)

    // Reopen → the named row is loaded back from getfacl.
    const win2 = await openPermsFor(page, DS_LEAF)
    const namedRow2 = win2.locator('.anas-grid-access-named .x-grid-row', { hasText: PU })
    await expect(namedRow2).toBeVisible({ timeout: 20_000 })

    // --- Remove the named entry → re-apply → the grant is gone, mode is clean --
    await win2.locator('.anas-btn-access-remove').first().click()
    await expect(win2.locator('.anas-grid-access-named .x-grid-row', { hasText: PU }))
      .toHaveCount(0, { timeout: 20_000 })
    await win2.locator('.anas-btn-dataset-access-submit').click()
    await expect(win2).toBeHidden({ timeout: 30_000 })

    // Source of truth: the named entry is gone and the mode bits are clean (755,
    // no lingering setgid).
    await expect.poll(() => aclHasNamedUser(mount, PU), { timeout: 60_000 }).toBe(false)
    await expect.poll(() => getMode(mount), { timeout: 60_000 }).toBe('755')
  })
})
