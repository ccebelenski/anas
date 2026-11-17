import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { apiCtx, awaitJob, V1 } from './fixtures/cloud-api'
import { loginToPve, openAnasItem, STUNT_HOST } from './fixtures/pve-ui'
import { lioInstalled, poolExists, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

/**
 * LIVE PROOF for own.4 (c) — the iSCSI screen's Repair button and its tooltip
 * read the daemon's per-hole verdict. The panel never decides for itself
 * whether a hole can be put back: the button is live only for a hole whose
 * `repair.state` is `ready`, and every refused hole is named with the daemon's
 * own sentence (`repair.advice`). An enabled button is a claim about the
 * system, so it must not appear while Repair would refuse.
 *
 * Over the real daemon, LIO and ZFS on the stunt node:
 *
 *   A. The LUN is unmapped from configfs, its backstore still live. Reloading
 *      the screen shows Repair DISABLED, with the daemon's "map it back by
 *      hand" sentence (`luns create storage_object=`), never "can be put back
 *      now".
 *   B. The backstore is deleted too. Reloading shows Repair ENABLED and the
 *      tooltip promising the same disk.
 *   C. Repair puts the LUN back: the health read has no missing LUN for the
 *      target, and the button is disabled with "Nothing to repair".
 *
 * FIXTURE: the node's own `gtiscsi` pool (present on every stunt node). The
 * throwaway volume `gtiscsi/verdictproof-a`, the target `verdictproof` and its
 * LUN are created and removed by this spec. Teardown never runs `targetcli
 * saveconfig` by hand: the API's mutations own the saved configuration.
 */

const POOL = 'gtiscsi'
const VOL = `${POOL}/verdictproof-a`
const TARGET_NAME = 'verdictproof'
const DUMMY_INITIATOR = 'iqn.2005-03.org.openiscsi:anas.verdict.proof'

interface Lun { index: number, name: string, serial: string | null, backingPath: string, size: number | null }

// ---- API helpers ------------------------------------------------------------

async function targetIqn(ctx: APIRequestContext): Promise<string | null> {
  const list = await ctx.get(`${V1}/iscsi/targets`)
  if (!list.ok())
    return null
  const t = ((await list.json()).data.targets as Array<{ iqn: string }>).find(x => x.iqn.includes(TARGET_NAME))
  return t?.iqn ?? null
}

async function luns(ctx: APIRequestContext, iqn: string): Promise<Lun[]> {
  const res = await ctx.get(`${V1}/iscsi/targets/${encodeURIComponent(iqn)}`)
  expect(res.status()).toBe(200)
  return (await res.json()).data.luns as Lun[]
}

async function addLun(ctx: APIRequestContext, iqn: string, name: string, backing: string): Promise<void> {
  const res = await ctx.post(`${V1}/iscsi/targets/${encodeURIComponent(iqn)}/luns`, { data: { name, kind: 'zvol', backing } })
  expect(res.status(), await res.text()).toBe(202)
  const job = await awaitJob(ctx, (await res.json()).job.id)
  expect(job.status, job.error).toBe('completed')
}

/** Delete a LUN through its own confirm flow (backing kept). */
async function deleteLun(ctx: APIRequestContext, iqn: string, index: number): Promise<void> {
  const url = `${V1}/iscsi/targets/${encodeURIComponent(iqn)}/luns/${index}`
  const challenge = await ctx.delete(url)
  expect(challenge.status()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  const confirmed = await ctx.delete(url, { headers: { 'x-anas-confirm': code } })
  expect(confirmed.status(), await confirmed.text()).toBe(202)
  const job = await awaitJob(ctx, (await confirmed.json()).job.id)
  expect(job.status, job.error).toBe('completed')
}

/** Create the proof target (dummy ACL, the node's own portal). */
async function createTarget(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.post(`${V1}/iscsi/targets`, {
    data: { name: TARGET_NAME, portals: [{ address: STUNT_HOST }], acls: [{ initiatorIqn: DUMMY_INITIATOR }] },
  })
  expect(res.status(), await res.text()).toBe(202)
  expect((await awaitJob(ctx, (await res.json()).job.id)).status).toBe('completed')
  const iqn = await targetIqn(ctx)
  expect(iqn).toBeTruthy()
  return iqn as string
}

/** Best-effort removal of the proof target and volume (pre-clean AND teardown). */
async function cleanup(ctx: APIRequestContext): Promise<void> {
  try {
    const iqn = await targetIqn(ctx)
    if (iqn) {
      // A hole this spec left behind is put back first (Repair is the product's
      // own door), so the LUN is live again and the API can delete it.
      const health = await ctx.get(`${V1}/iscsi/health`)
      const missing = health.ok()
        ? ((await health.json()).data.missingLuns as Array<{ targetIqn: string }>).filter(h => h.targetIqn === iqn)
        : []
      if (missing.length > 0) {
        const repair = await ctx.post(`${V1}/iscsi/health/repair`, { data: {} })
        if (repair.status() === 202)
          await awaitJob(ctx, (await repair.json()).job.id).catch(() => undefined)
      }
      for (const lun of await luns(ctx, iqn))
        await deleteLun(ctx, iqn, lun.index).catch(() => undefined)
      const del = await ctx.delete(`${V1}/iscsi/targets/${encodeURIComponent(iqn)}`)
      if (del.status() === 202)
        await awaitJob(ctx, (await del.json()).job.id)
    }
  }
  catch {
    // Best-effort only.
  }
  await sshExec(`zfs destroy -r ${VOL}`).catch(() => undefined)
}

// ---- browser helpers --------------------------------------------------------

async function openIscsi(page: Page): Promise<void> {
  await openAnasItem(page, 'iSCSI')
  await expect(page.locator('.anas-btn-iscsi-repair')).toBeVisible({ timeout: 45_000 })
}

/** Reload the page and reopen the iSCSI screen, so the health read runs again. */
async function reloadIscsi(page: Page): Promise<void> {
  await page.reload()
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.x-mask')].some(el => (el as HTMLElement).offsetParent !== null),
    undefined,
    { timeout: 30_000 },
  ).catch(() => undefined)
  const nag = page.getByText('No valid subscription')
  if (await nag.isVisible({ timeout: 10_000 }).catch(() => false))
    await page.getByRole('button', { name: 'OK' }).click()
  await openIscsi(page)
}

/**
 * The Repair button as the panel leaves it. `setDisabled` writes the Ext
 * component's `disabled`, and `btnSetTip` writes `btn.tooltip` (HTML-encoded)
 * plus `setTooltip`; neither is a DOM attribute, so the button is read through
 * the Ext component query by its itemId.
 */
async function repairState(page: Page): Promise<{ disabled: boolean, tip: string }> {
  return page.evaluate(() => {
    const ext = (window as unknown as { Ext?: { ComponentQuery?: { query: (q: string) => unknown[] } } }).Ext
    const btn = ext?.ComponentQuery?.query('#iscsiRepair')[0] as { disabled?: boolean, tooltip?: unknown } | undefined
    if (!btn)
      return { disabled: true, tip: '<the Repair button is not rendered>' }
    return { disabled: Boolean(btn.disabled), tip: String(btn.tooltip ?? '') }
  })
}

// ---- the proof --------------------------------------------------------------

test.describe('own.4 (c) — the Repair button reads the hole verdict', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)
  // The iSCSI toolbar overflows at the default 1280px; wide enough to keep
  // every button on screen (and clickable).
  test.use({ viewport: { width: 2560, height: 1080 } })

  let ctx: APIRequestContext

  test.beforeAll(async ({ playwright }) => {
    ctx = await apiCtx(playwright)
    skipIfFixtureMissing(!(await poolExists(POOL)), `pool ${POOL} is not on the node`)
    skipIfFixtureMissing(!(await lioInstalled()), 'the LIO target stack is not installed on the node (apt install targetcli-fb python3-rtslib-fb)')
    await cleanup(ctx)
  })

  test.afterAll(async () => {
    if (ctx) {
      await cleanup(ctx)
      await ctx.dispose()
    }
  })

  test('a refused hole leaves Repair disabled with the daemon\'s sentence; a ready hole enables it; Repair clears it', async ({ page }) => {
    const iqn = await createTarget(ctx)
    await sshExec(`zfs create -V 64M ${VOL} && udevadm settle && test -e /dev/zvol/${VOL}`)
    await addLun(ctx, iqn, 'verdicta', VOL)
    const [lun] = await luns(ctx, iqn)
    expect(lun.index).toBe(0)

    await loginToPve(page)
    await openIscsi(page)

    // (A) The LUN is unmapped from configfs, the backstore still live: the
    // daemon refuses (mapping an existing backstore is the manual path).
    await sshExec(`targetcli /iscsi/${iqn}/tpg1/luns delete ${lun.index}`)
    await reloadIscsi(page)
    await expect.poll(async () => (await repairState(page)).tip, { timeout: 45_000 })
      .toContain('luns create storage_object=')
    const refused = await repairState(page)
    expect(refused.disabled, 'a hole the daemon refuses never enables the button').toBe(true)
    expect(refused.tip, 'and it never claims the disk can be put back').not.toContain('can be put back now')

    // (B) The backstore is deleted too: the daemon calls the hole ready.
    await sshExec(`targetcli /backstores/block delete ${lun.name}`)
    await reloadIscsi(page)
    await expect.poll(async () => (await repairState(page)).tip, { timeout: 45_000 })
      .toContain('can be put back now')
    expect((await repairState(page)).disabled, 'a ready hole enables the button').toBe(false)

    // (C) Repair puts the LUN back; nothing is missing afterwards.
    await page.locator('.anas-btn-iscsi-repair').click()
    await expect.poll(async () => {
      const res = await ctx.get(`${V1}/iscsi/health`)
      const holes = ((await res.json()).data.missingLuns as Array<{ targetIqn: string }>).filter(h => h.targetIqn === iqn)
      return holes.length
    }, { timeout: 120_000 }).toBe(0)
    await reloadIscsi(page)
    await expect.poll(async () => (await repairState(page)).tip, { timeout: 45_000 })
      .toContain('Nothing to repair')
    expect((await repairState(page)).disabled, 'with no hole the button is disabled again').toBe(true)
  })
})
