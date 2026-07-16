import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { GATEWAY_URL, loginToPve, NODE_NAME, openAnasItem } from './fixtures/pve-ui'
import {
  createSnapshot,
  datasetExists,
  destroyDataset,
  destroySnapshot,
  listSnapshots,
  poolExists,
  releaseHolds,
  sshExec,
} from './fixtures/stunt-node'

/**
 * Replication view (story 5.5.3, stage 2) — the dedicated "Replication" menu
 * item, driven through the real PVE UI on the stunt node (PVE login → ANAS node
 * menu → native Replication grid). Companion to the daemon's replication specs;
 * the daemon owns systemd-unit truth, so the browser asserts only on grid state.
 *
 * UI hooks (task brief):
 *   - View/grid: '.anas-view-replication', '.anas-grid-replication'.
 *   - Toolbar: '.anas-btn-repl-new', '.anas-btn-repl-once', '.anas-btn-repl-run',
 *     '.anas-btn-repl-edit', '.anas-btn-repl-toggle', '.anas-btn-repl-delete'.
 *   - Task dialog: '.anas-win-repl-task' (fields '.anas-fld-repl-name',
 *     '.anas-fld-repl-src-pool', '.anas-fld-repl-src-dataset',
 *     '.anas-fld-repl-tgt-pool', '.anas-fld-repl-tgt-dataset',
 *     '.anas-fld-repl-schedule'; submit '.anas-btn-repl-task-submit').
 *   - Replicate Once dialog: '.anas-win-replicate'; plan line '.anas-repl-plan'
 *     (with '.anas-repl-diverged' when the plan cannot proceed); submit
 *     '.anas-btn-replicate-submit'.
 *
 * Also asserts the Datasets view no longer carries ANY replication surface
 * (the bleed the user explicitly did not want).
 *
 * Uses the pre-existing 'testpool/share1' dataset. ExtJS boot + panel render is
 * slow — timeouts are generous.
 */

const POOL = 'testpool'
const DS_FQ = 'testpool/share1'

// Skip the whole file when the reference pool is absent (box not set up / node
// off) — poolExists swallows SSH failures and returns false.
test.beforeEach(async () => {
  test.skip(!(await poolExists(POOL)), 'testpool not present — run setup-test-data.sh')
})

/** Select the stunt node, open Replication, wait for the grid to render. */
async function openReplication(page: Page): Promise<void> {
  await loginToPve(page)
  await openAnasItem(page, 'Replication')
  await expect(page.locator('.anas-view-replication')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.anas-grid-replication')).toBeVisible({ timeout: 45_000 })
}

/** Select the stunt node, open Datasets, wait for the tree grid to render. */
async function openDatasets(page: Page): Promise<void> {
  await loginToPve(page)
  await openAnasItem(page, 'Datasets')
  await expect(page.locator('.anas-view-datasets')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('.anas-grid-datasets')).toBeVisible({ timeout: 45_000 })
}

/**
 * Pick a value in an ExtJS readonly combobox by its display label — click the
 * field to drop its boundlist, then click the matching item. An exact-match
 * regex avoids selecting a label that is a prefix of another.
 */
async function pickCombo(page: Page, field: Locator, label: string): Promise<void> {
  await field.click()
  await page
    .locator('.x-boundlist:visible .x-boundlist-item', { hasText: new RegExp(`^${label}$`) })
    .first()
    .click()
}

/**
 * Set a target-pool combo that may be a strict pick-list (pools were listed) OR
 * a free-text field (the location's pools could not be listed). Try to click the
 * matching boundlist item; if it isn't offered, type the value into the input.
 */
async function setPool(page: Page, field: Locator, value: string): Promise<void> {
  await field.click()
  const item = page
    .locator('.x-boundlist:visible .x-boundlist-item', { hasText: new RegExp(`^${value}$`) })
    .first()
  if (await item.count().then(n => n > 0).catch(() => false)) {
    await item.click().catch(async () => {
      await field.locator('input').fill(value)
    })
    return
  }
  await field.locator('input').fill(value)
}

test.describe('ANAS replication view — grid, toolbar, once dialog (stunt node)', () => {
  test.setTimeout(120_000)

  test('menu shows Replication; grid + toolbar render', async ({ page }) => {
    await openReplication(page)

    const view = page.locator('.anas-view-replication')
    // Core toolbar affordances are present.
    await expect(view.locator('.anas-btn-repl-new')).toBeVisible({ timeout: 20_000 })
    await expect(view.locator('.anas-btn-repl-once')).toBeVisible({ timeout: 20_000 })
    // Selection-gated actions start disabled (nothing selected yet).
    await expect(view.locator('.anas-btn-repl-run')).toBeDisabled({ timeout: 20_000 })
    await expect(view.locator('.anas-btn-repl-delete')).toBeDisabled({ timeout: 20_000 })
  })

  test('the Replicate Once dialog opens, source is pickable, plan resolves', async ({ page }) => {
    // A single fresh snapshot so the source has a valid send point.
    for (const name of await listSnapshots(DS_FQ))
      await destroySnapshot(DS_FQ, name)
    await createSnapshot(DS_FQ, 'onceui1')

    try {
      await openReplication(page)
      await page.locator('.anas-btn-repl-once').click()

      const win = page.locator('.anas-win-replicate')
      await expect(win).toBeVisible({ timeout: 20_000 })

      // Pick the source pool + dataset in the dialog (no dataset-row context).
      await pickCombo(page, win.locator('.anas-fld-repl-src-pool'), POOL)
      await pickCombo(page, win.locator('.anas-fld-repl-src-dataset'), 'share1')

      // The plan line renders and resolves to an honest verdict (any mode).
      const plan = win.locator('.anas-repl-plan')
      await expect(plan).toBeVisible({ timeout: 20_000 })
      await expect(plan).toHaveText(/Incremental|FULL send|plan unavailable/, { timeout: 30_000 })

      // Cancel — no mutation.
      await win.getByText('Cancel', { exact: true }).click()
      await expect(win).toBeHidden({ timeout: 20_000 })
    }
    finally {
      await destroySnapshot(DS_FQ, 'onceui1')
    }
  })

  test('the Datasets view carries NO replication surface', async ({ page }) => {
    await openDatasets(page)
    // The bleed is gone: the stage-1 toolbar button no longer exists anywhere.
    await expect(page.locator('.anas-btn-ds-replicate')).toHaveCount(0)
  })
})

/**
 * End-to-end "Replicate Once" — replicate share1@<fresh snap> into a throwaway
 * 'testpool/replspec' dataset (same pool is legal), poll the real system for the
 * dataset, then tear it down. Mirrors the stage-1 throwaway pattern.
 */
test.describe('ANAS Replicate Once runs a send | recv job (stunt node)', () => {
  test.setTimeout(180_000)

  const SNAP = 'replspecsnap'
  const TARGET_DS = 'replspec'
  const TARGET_FQ = `${POOL}/${TARGET_DS}`

  test.beforeEach(async () => {
    // Replication HOLDS its base snapshot on both sides (the chain guard).
    // Release holds first or the destroys silently fail and the leftover
    // snapshot breaks the next run's createSnapshot.
    await releaseHolds(TARGET_FQ)
    await releaseHolds(DS_FQ)
    await destroyDataset(TARGET_FQ)
    for (const name of await listSnapshots(DS_FQ))
      await destroySnapshot(DS_FQ, name)
    await createSnapshot(DS_FQ, SNAP)
  })

  test.afterEach(async () => {
    await releaseHolds(TARGET_FQ)
    await releaseHolds(DS_FQ)
    await destroyDataset(TARGET_FQ)
    await destroySnapshot(DS_FQ, SNAP)
  })

  test('replicating share1 into testpool/replspec materialises the dataset', async ({ page }) => {
    await openReplication(page)
    await page.locator('.anas-btn-repl-once').click()

    const win = page.locator('.anas-win-replicate')
    await expect(win).toBeVisible({ timeout: 20_000 })

    await pickCombo(page, win.locator('.anas-fld-repl-src-pool'), POOL)
    await pickCombo(page, win.locator('.anas-fld-repl-src-dataset'), 'share1')

    // Retarget the destination dataset (target pool defaults to the source pool).
    const dsField = win.locator('.anas-fld-repl-dataset input')
    await dsField.fill(TARGET_DS)

    // Wait for the plan to resolve so the Replicate button is enabled (a brand-new
    // target is a clean full send — still runnable).
    const plan = win.locator('.anas-repl-plan')
    await expect(plan).toHaveText(/Incremental|FULL send|plan unavailable/, { timeout: 30_000 })

    const submit = win.locator('.anas-btn-replicate-submit')
    await expect(submit).toBeEnabled({ timeout: 20_000 })
    await submit.click()

    // The job creates the target on the real system (source of truth). Poll.
    await expect.poll(async () => datasetExists(TARGET_FQ), { timeout: 90_000, intervals: [2_000] })
      .toBe(true)
  })
})

/**
 * Task CRUD through the dialog: create a scheduled task → its row appears with
 * the schedule and a lag cell → delete it → the row is gone. The daemon owns the
 * systemd-unit truth (the daemon specs assert that); the browser asserts only on
 * grid state, per the design.
 */
test.describe('ANAS replication task CRUD (stunt node)', () => {
  test.setTimeout(180_000)

  const TASK = 'spec-repl-task'
  const TARGET_DS = 'spec-repl-target'

  // Best-effort teardown of the systemd units + throwaway target, so reruns are
  // clean even if a test aborts mid-way. Never throws (units may not exist).
  async function cleanupTask(): Promise<void> {
    await sshExec(
      `systemctl disable --now anas-repl-${TASK}.timer 2>/dev/null; `
      + `rm -f /etc/systemd/system/anas-repl-${TASK}.* ; systemctl daemon-reload 2>/dev/null`,
    ).catch(() => {})
    await destroyDataset(`${POOL}/${TARGET_DS}`)
  }

  test.beforeEach(async () => {
    await cleanupTask()
  })

  test.afterEach(async () => {
    await cleanupTask()
  })

  test('create a task, see its row, then delete it', async ({ page }) => {
    await openReplication(page)

    // ---- Create ----------------------------------------------------------
    await page.locator('.anas-btn-repl-new').click()
    const dlg = page.locator('.anas-win-repl-task')
    await expect(dlg).toBeVisible({ timeout: 20_000 })

    await dlg.locator('.anas-fld-repl-name input').fill(TASK)
    await pickCombo(page, dlg.locator('.anas-fld-repl-src-pool'), POOL)
    await pickCombo(page, dlg.locator('.anas-fld-repl-src-dataset'), 'share1')
    await pickCombo(page, dlg.locator('.anas-fld-repl-tgt-pool'), POOL)
    await dlg.locator('.anas-fld-repl-tgt-dataset input').fill(TARGET_DS)
    await dlg.locator('.anas-fld-repl-schedule input').fill('daily')

    await dlg.locator('.anas-btn-repl-task-submit').click()
    await expect(dlg).toBeHidden({ timeout: 30_000 })

    // ---- The row appears with its schedule -------------------------------
    const grid = page.locator('.anas-grid-replication')
    const row = grid.locator('.x-grid-row', { hasText: TASK })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('daily', { timeout: 20_000 })

    // ---- Delete (Ext.Msg confirm — removes the schedule only) ------------
    await row.click()
    const del = page.locator('.anas-btn-repl-delete')
    await expect(del).toBeEnabled({ timeout: 20_000 })
    await del.click()

    const confirm = page.locator('.x-message-box:visible')
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Yes' }).click()

    // ---- The row is gone --------------------------------------------------
    await expect(grid.locator('.x-grid-row', { hasText: TASK })).toHaveCount(0, { timeout: 30_000 })
  })
})

/**
 * Stage 3 (story 5.5.2) — the Remotes manager and the self-remote end-to-end.
 *
 * Additional UI hooks (task brief):
 *   - Toolbar: '.anas-btn-repl-remotes'.
 *   - Manager window: '.anas-win-repl-remotes' (grid '.anas-grid-repl-remotes',
 *     public key '.anas-repl-pubkey-text', add '.anas-btn-remote-add').
 *   - Add/edit wizard: '.anas-win-repl-remote-edit' (fields '.anas-fld-remote-name',
 *     '.anas-fld-remote-host', '.anas-fld-remote-port', '.anas-fld-remote-user';
 *     '.anas-btn-remote-testconn' drives the staged test into '.anas-remote-test',
 *     '.anas-btn-remote-trust' confirms an unknown host key, '.anas-btn-remote-save').
 *   - Location picker (both dialogs): '.anas-fld-repl-location'.
 */

const REMOTE = 'selfbox'
const PUBKEY_MARKER = 'anas-replication'

/**
 * Fetch the daemon's cluster public key over the gateway (shares the page's
 * PVE cookie jar). Returns '' on any failure so callers can skip gracefully.
 */
async function fetchPublicKey(page: Page): Promise<string> {
  try {
    const res = await page.request.get(
      `${GATEWAY_URL}/api/nodes/${NODE_NAME}/v1/replication/remotes`,
    )
    if (!res.ok())
      return ''
    const body = await res.json()
    return (body?.data?.publicKey as string) ?? ''
  }
  catch {
    return ''
  }
}

/**
 * Best-effort: drop the 'selfbox' entry from the corosync registry so reruns
 * start clean. Fail-open (the file/daemon may be absent). Bumps the version so
 * the daemon's next GET reflects the removal.
 */
async function scrubRemote(): Promise<void> {
  const py
    = 'import json\n'
      + 'p="/etc/pve/anas/remotes.json"\n'
      + 'try:\n'
      + ' d=json.load(open(p))\n'
      + ' d["remotes"]=[r for r in d.get("remotes",[]) if r.get("name")!="selfbox"]\n'
      + ' d["version"]=int(d.get("version",0))+1\n'
      + ' json.dump(d,open(p,"w"))\n'
      + 'except Exception:\n pass\n'
  await sshExec(`python3 - <<'PY' 2>/dev/null || true\n${py}PY`).catch(() => {})
}

/**
 * Append the cluster public key to root's authorized_keys (base64 to dodge
 * shell quoting), so the daemon can auth to localhost as itself.
 */
async function authorizeKey(pubKey: string): Promise<void> {
  const b64 = Buffer.from(`${pubKey.trim()}\n`).toString('base64')
  await sshExec(
    'mkdir -p /root/.ssh && chmod 700 /root/.ssh && '
    + `echo ${b64} | base64 -d >> /root/.ssh/authorized_keys && `
    + 'chmod 600 /root/.ssh/authorized_keys',
  )
}

/** Remove any authorized_keys line carrying the anas-replication comment. */
async function deauthorizeKey(): Promise<void> {
  await sshExec(`sed -i '/${PUBKEY_MARKER}/d' /root/.ssh/authorized_keys 2>/dev/null || true`)
    .catch(() => {})
}

test.describe('ANAS replication Remotes manager (stunt node)', () => {
  test.setTimeout(120_000)

  test('the Remotes manager opens and shows the cluster public key', async ({ page }) => {
    await openReplication(page)
    await page.locator('.anas-btn-repl-remotes').click()

    const win = page.locator('.anas-win-repl-remotes')
    await expect(win).toBeVisible({ timeout: 20_000 })

    // The public-key panel shows a real key (the daemon generates one on first
    // GET /replication/remotes). ExtJS renders the field as a <textarea>.
    const keyField = win.locator('.anas-repl-pubkey-text textarea')
    await expect(keyField).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => (await keyField.inputValue()).trim(), { timeout: 20_000 })
      .toMatch(/ssh-|AAAA/)

    await win.getByText('Close', { exact: true }).click()
    await expect(win).toBeHidden({ timeout: 20_000 })
  })
})

/**
 * The self-remote E2E: authorize the daemon's own key on the box, register
 * 'selfbox' (host localhost) through the wizard driving the staged test to 'ok'
 * (confirming the unknown host key), then Replicate Once to 'remote: selfbox'
 * targeting testpool/replremote and poll the real system for the dataset. The
 * remote is localhost so datasetExists (a local zfs list) sees the result.
 *
 * Cleanup is fail-open: delete the remote via the UI, then afterEach releases
 * holds, destroys the throwaway target + snapshots, drops the authorized_keys
 * line, and scrubs the registry entry so reruns are clean.
 */
test.describe('ANAS self-remote replication E2E (stunt node)', () => {
  test.setTimeout(240_000)

  const SNAP = 'selfremotesnap'
  const TARGET_DS = 'replremote'
  const TARGET_FQ = `${POOL}/${TARGET_DS}`

  test.beforeEach(async () => {
    await scrubRemote()
    await deauthorizeKey()
    await releaseHolds(TARGET_FQ)
    await releaseHolds(DS_FQ)
    await destroyDataset(TARGET_FQ)
    for (const name of await listSnapshots(DS_FQ))
      await destroySnapshot(DS_FQ, name)
    await createSnapshot(DS_FQ, SNAP)
  })

  test.afterEach(async () => {
    await releaseHolds(TARGET_FQ).catch(() => {})
    await releaseHolds(DS_FQ).catch(() => {})
    await destroyDataset(TARGET_FQ).catch(() => {})
    await destroySnapshot(DS_FQ, SNAP).catch(() => {})
    await deauthorizeKey()
    await scrubRemote()
  })

  test('register selfbox via the wizard, then Replicate Once to it', async ({ page }) => {
    await openReplication(page)

    // Authorize the daemon's own public key so ssh root@localhost works.
    const pubKey = await fetchPublicKey(page)
    test.skip(!pubKey, 'daemon returned no public key — stage-3 daemon not present')
    await authorizeKey(pubKey)

    // ---- Register the remote through the wizard --------------------------
    await page.locator('.anas-btn-repl-remotes').click()
    const mgr = page.locator('.anas-win-repl-remotes')
    await expect(mgr).toBeVisible({ timeout: 20_000 })

    await mgr.locator('.anas-btn-remote-add').click()
    const wiz = page.locator('.anas-win-repl-remote-edit')
    await expect(wiz).toBeVisible({ timeout: 20_000 })

    await wiz.locator('.anas-fld-remote-name input').fill(REMOTE)
    await wiz.locator('.anas-fld-remote-host input').fill('localhost')

    // Drive the staged test to OK, confirming the unknown host key if prompted.
    await wiz.locator('.anas-btn-remote-testconn').click()
    const testArea = wiz.locator('.anas-remote-test')
    await expect(async () => {
      const trust = wiz.locator('.anas-btn-remote-trust')
      if (await trust.count())
        await trust.click()
      await expect(testArea).toContainText(/ok|zfs/i, { timeout: 5_000 })
    }).toPass({ timeout: 90_000 })

    // Save → the row appears in the manager grid.
    await wiz.locator('.anas-btn-remote-save').click()
    await expect(wiz).toBeHidden({ timeout: 30_000 })
    await expect(mgr.locator('.anas-grid-repl-remotes .x-grid-row', { hasText: REMOTE }))
      .toBeVisible({ timeout: 30_000 })

    await mgr.getByText('Close', { exact: true }).click()
    await expect(mgr).toBeHidden({ timeout: 20_000 })

    // ---- Replicate Once to the remote ------------------------------------
    await page.locator('.anas-btn-repl-once').click()
    const once = page.locator('.anas-win-replicate')
    await expect(once).toBeVisible({ timeout: 20_000 })

    await pickCombo(page, once.locator('.anas-fld-repl-src-pool'), POOL)
    await pickCombo(page, once.locator('.anas-fld-repl-src-dataset'), 'share1')

    // Point the target at the registered remote; the target-pool combo then
    // repopulates from the remote's pools (or free-texts if it can't list).
    await pickCombo(page, once.locator('.anas-fld-repl-location'), `remote: ${REMOTE}`)
    await setPool(page, once.locator('.anas-fld-repl-pool'), POOL)
    await once.locator('.anas-fld-repl-dataset input').fill(TARGET_DS)

    const plan = once.locator('.anas-repl-plan')
    await expect(plan).toHaveText(/Incremental|FULL send|plan unavailable/, { timeout: 40_000 })

    const submit = once.locator('.anas-btn-replicate-submit')
    await expect(submit).toBeEnabled({ timeout: 20_000 })
    await submit.click()

    // The daemon send|ssh|recv job materialises the dataset on the (local) box.
    await expect.poll(async () => datasetExists(TARGET_FQ), { timeout: 120_000, intervals: [3_000] })
      .toBe(true)

    // ---- Delete the remote via the UI (registry cleanup) -----------------
    await page.locator('.anas-btn-repl-remotes').click()
    await expect(mgr).toBeVisible({ timeout: 20_000 })
    await mgr.locator('.anas-grid-repl-remotes .x-grid-row', { hasText: REMOTE }).first().click()
    const del = mgr.locator('.anas-btn-remote-delete')
    await expect(del).toBeEnabled({ timeout: 20_000 })
    await del.click()
    const confirm = page.locator('.x-message-box:visible')
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Yes' }).click()
    await expect(mgr.locator('.anas-grid-repl-remotes .x-grid-row', { hasText: REMOTE }))
      .toHaveCount(0, { timeout: 30_000 })
  })
})
