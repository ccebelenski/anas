import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

/**
 * Story vdevs.1 (GitHub #66) — LIVE PROOF that the pool view shows every vdev
 * class ZFS reports. The stunt-node fixture (test/stunt-node/vdev-fixture.sh up,
 * built in beforeAll, torn down in afterAll):
 *
 *   gtvdev  a throwaway pool on hot disk 9's SIX partitions (kernel /dev/sdk1-6,
 *           by-id scsi-…ANAS_HOT9-part1-6), carrying all six vdev classes —
 *           data/log/cache/spare/special/dedup — built BY CLI so the proof is
 *           the display side (the zpool-status parser over the pool-level
 *           logs/l2cache/spares/special/dedup sections), not the composer.
 *
 * What is proven:
 *   1. GET /v1/pools/gtvdev lists all six vdev classes, in the fixed group
 *      order (data, log, cache, spare, special, dedup), each with the right
 *      partition leaf and the state ZFS reports (the spare reads AVAIL).
 *   3. Playwright: the Pools detail topology shows nodes labelled Log,
 *      Special and Dedup.
 *
 * Skipped by design: adding a vdev through ANAS's own add-vdev API (item 2 of
 * the story acceptance) — the route is whole-disk (its pre-flight resolves
 * ids against the whole-disk inventory and the UI pickers offer whole disks
 * only), and this fixture's single disk is fully consumed by its six
 * partitions, so there is no eligible candidate to add. A CLI-built class is
 * indistinguishable from an API-built one at the parser boundary: both land
 * in the same pool-level section of `zpool status -j`.
 *
 * Disks 1-8, gtbackup and gtiscsi are never touched.
 */

const execFileAsync = promisify(execFile)

// The API is reached exactly the way the injected panels reach it
// (packages/pve-integration/src/10-api.js): the PVE origin's /anas/ forward,
// which pveproxy proxies to the gateway's loopback listener.
const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtvdev'
const BY_ID = 'scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT9'

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/vdev-fixture.sh', import.meta.url).pathname

/** Build an authenticated request context carrying the PVE session cookie. */
async function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: pveAuthState(ticket),
  })
}

/** The KERNEL name of the pool's Nth partition (source of truth: the node). */
async function partitionKernelName(n: number): Promise<string> {
  const dev = await sshExec(`readlink -f /dev/disk/by-id/${BY_ID}-part${n}`)
  const name = dev.split('/').pop()
  expect(name, `partition ${n} of ${BY_ID}`).toBeTruthy()
  return name!
}

test.describe('vdevs.1 — pool-level vdev classes (stunt node fixture)', () => {
  // One fixture lifetime for the whole file: up in beforeAll (attach +
  // partition + create runs ~30s), down in afterAll (best-effort — a failed
  // teardown must not mask the run's results; the node state is verified
  // separately after the run).
  test.setTimeout(240_000)

  test.beforeAll(async () => {
    await execFileAsync(FIXTURE_SH, ['up'], { timeout: 240_000 })
  })

  test.afterAll(async () => {
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 240_000 }).catch(() => {})
  })

  // -----------------------------------------------------------------------
  // 1 — the API lists all six classes in the fixed order
  // -----------------------------------------------------------------------
  test('GET /v1/pools/gtvdev lists all six vdev classes in fixed order', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The pool's six partition leaves, by kernel name, from the node itself.
      const leaves: string[] = []
      for (let n = 1; n <= 6; n++)
        leaves.push(await partitionKernelName(n))

      const res = await ctx.get(`${V1}/pools/${POOL}`)
      expect(res.status()).toBe(200)
      const detail = (await res.json()).data as {
        name: string
        state: string
        vdevGroups: Array<{ role: string, vdevs: Array<{ name: string, type: string, state: string, disks: Array<{ id: string, state: string }> }> }>
      }
      expect(detail.name).toBe(POOL)
      expect(detail.state).toBe('ONLINE')

      // Fixed group order whatever the JSON key order: data, log, cache,
      // spare, special, dedup.
      expect(detail.vdevGroups.map(g => g.role)).toEqual(
        ['data', 'log', 'cache', 'spare', 'special', 'dedup'],
      )

      // One single-disk vdev per section, the right partition leaf, and the
      // state ZFS reports (the spare's own state is AVAIL — reported as-is).
      for (let i = 0; i < detail.vdevGroups.length; i++) {
        const group = detail.vdevGroups[i]
        expect(group.vdevs, group.role).toHaveLength(1)
        const vdev = group.vdevs[0]
        expect(vdev.disks, group.role).toHaveLength(1)
        expect(vdev.disks[0].id, `${group.role} leaf`).toBe(leaves[i])
        const state = group.role === 'spare' ? 'AVAIL' : 'ONLINE'
        expect(vdev.state, group.role).toBe(state)
        expect(vdev.disks[0].state, `${group.role} disk state`).toBe(state)
      }
    }
    finally {
      await ctx.dispose()
    }
  })

  // -----------------------------------------------------------------------
  // 1b — telemetry: the kernel-named leaves land on the disk id (0.4.1)
  // -----------------------------------------------------------------------
  test('GET /v1/telemetry resolves the kernel-named partition leaves to the disk id the Disks list carries', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.get(`${V1}/telemetry`)
      expect(res.status()).toBe(200)
      const t = (await res.json()).data as {
        pools: Array<{ name: string, vdevs: Array<{ name: string, disks: Array<{ id: string }> }> }>
      }
      const pool = t.pools.find(p => p.name === POOL)
      expect(pool, 'gtvdev in the telemetry sample').toBeTruthy()

      // Every leaf the sample carries is a partition of the one hot disk,
      // named by its kernel name (the device-named pool, built by CLI from
      // /dev/sdk1-6): each resolves to the WHOLE-disk by-id — the identity
      // the Disks view carries — instead of staying under its kernel name.
      const ids = pool!.vdevs.flatMap(v => v.disks.map(d => d.id))
      expect(ids.length, `leaf rows: ${JSON.stringify(ids)}`).toBeGreaterThan(0)
      for (const id of ids)
        expect(id, `leaf row id ${id}`).toBe(BY_ID)

      // ...and that identity is a disk GET /v1/disks lists — the link holds.
      const disksRes = await ctx.get(`${V1}/disks`)
      expect(disksRes.status()).toBe(200)
      const disks = (await disksRes.json()).data as Array<{ id: string }>
      expect(disks.some(d => d.id === BY_ID), `GET /v1/disks lists ${BY_ID}`).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  // -----------------------------------------------------------------------
  // 3 — the Pools detail topology shows the class nodes
  // -----------------------------------------------------------------------
  test.describe('UI', () => {
    // Wide viewport: the Pools toolbar carries several labelled buttons and at
    // the default 1280px the tail of them collapses into ExtJS's overflow menu.
    test.use({ viewport: { width: 2560, height: 1080 } })

    test('the pool detail topology shows Log, Special and Dedup nodes', async ({ page }) => {
      await loginToPve(page)
      await openAnasItem(page, 'Pools')

      const grid = page.locator('.anas-grid-pools')
      await expect(grid).toBeVisible({ timeout: 45_000 })

      await grid.locator('.x-grid-row', { hasText: POOL }).click()
      const detailBtn = page.locator('.anas-btn-detail')
      await expect(detailBtn).toBeEnabled({ timeout: 20_000 })
      await detailBtn.click()

      const win = page.locator('.anas-view-pool-detail')
      await expect(win).toBeVisible({ timeout: 20_000 })

      // The per-disk topology tree (.anas-pool-topology) carries the group
      // nodes by role label — the three classes the parser used to drop.
      const tree = win.locator('.anas-pool-topology')
      await expect(tree).toBeVisible({ timeout: 20_000 })
      for (const label of ['Log', 'Special', 'Dedup']) {
        await expect(
          tree.locator('.x-tree-node-text', { hasText: new RegExp(`^${label}$`) }),
        ).toBeVisible({ timeout: 20_000 })
      }
    })
  })
})
