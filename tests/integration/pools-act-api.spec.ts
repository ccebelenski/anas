import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { GATEWAY_URL, NODE_NAME } from './fixtures/pve-ui'
import {
  createTestPool,
  destroyPool,
  getRootPool,
  listSpareDisks,
  poolExists,
  sshExec,
} from './fixtures/stunt-node'

/**
 * Epic 3 Act stories 3.7–3.14 — request-context API tests for the pool
 * mutations, driven exactly the way the injected ExtJS panels' API helper will
 * (PVEAuthCookie in the jar, gateway → local anasd).
 *
 * Contracts under test (DESIGN.md → "Public API", "Safety Semantics"):
 *   - PUT    /v1/pools/:name          modify properties            → 202 { job }
 *   - POST   /v1/pools                create                       → 202 { job }
 *   - POST   /v1/pools/import         import a known (exported) pool → 202 { job }
 *   - POST   /v1/pools/:name/vdevs    add a vdev                   → 202 { job }
 *   - POST   /v1/pools/:name/export   export — DANGEROUS           → 409 / 202
 *   - DELETE /v1/pools/:name          destroy — DANGEROUS          → 409 / 202
 *
 * The confirmation flow is the priority (DESIGN Principle 14, Safety Semantics):
 *   without x-anas-confirm → 409 { error.code: 'CONFIRMATION_REQUIRED' } plus an
 *   `x-anas-confirm-code` response header; resend with `x-anas-confirm: <code>`
 *   → 202; a wrong code → 409 again. The boot/root pool is a Level-1 block:
 *   409 { error.code: 'PROTECTED_RESOURCE' } with NO code header (no override).
 *
 * These run against the REAL stunt node. Guarded on poolExists('testpool') so
 * the whole file skips cleanly when the box isn't set up (poolExists also
 * swallows SSH failures → skips when the node is off). Every throwaway pool is
 * torn down in a finally/afterEach so reruns start clean. Generous timeouts:
 * these go browser → gateway → anasd → real zpool.
 */

const V1 = `${GATEWAY_URL}/api/nodes/${NODE_NAME}/v1`

// Throwaway pool names — one per destructive test so a failure can't bleed into
// the next. All are cleaned in the owning test's finally AND in afterEach.
const TMP_CREATE = 'anasactcreate'
const TMP_EXPORT = 'anasactexport'
const TMP_IMPORT = 'anasactimport'
const TMP_ADDVDEV = 'anasactvdev'
const ALL_TMP = [TMP_CREATE, TMP_EXPORT, TMP_IMPORT, TMP_ADDVDEV]

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

// Skip the whole file when the reference pool is absent (box not set up / node
// off). Mirrors pve-native-ui.spec.ts and scrub-era specs.
test.beforeEach(async () => {
  test.skip(!(await poolExists('testpool')), 'testpool not present — run setup-test-data.sh')
})

test.describe('Pool safety confirmation — challenge (no mutation)', () => {
  test.setTimeout(60_000)

  // These probe the 409 + x-anas-confirm-code mechanism against the REAL
  // testpool, which has active SMB/NFS shares (setup-test-data.sh) → destroy and
  // export are genuinely consequential (Safety Semantics Level 2). We never send
  // a confirm code here, so testpool is never mutated.

  test('export without a confirm code → 409 CONFIRMATION_REQUIRED + code header', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.post(`${V1}/pools/testpool/export`)
      expect(res.status()).toBe(409)
      expect(res.headers()['x-anas-confirm-code']).toBeTruthy()
      const body = await res.json()
      expect(body.error.code).toBe('CONFIRMATION_REQUIRED')
      // testpool is untouched.
      expect(await poolExists('testpool')).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('destroy without a confirm code → 409 CONFIRMATION_REQUIRED + code header', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.delete(`${V1}/pools/testpool`)
      expect(res.status()).toBe(409)
      expect(res.headers()['x-anas-confirm-code']).toBeTruthy()
      const body = await res.json()
      expect(body.error.code).toBe('CONFIRMATION_REQUIRED')
      expect(await poolExists('testpool')).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('destroy with a WRONG confirm code → 409 again (code not honoured)', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.delete(`${V1}/pools/testpool`, {
        headers: { 'x-anas-confirm': 'not-a-real-code' },
      })
      expect(res.status()).toBe(409)
      // Still not destroyed.
      expect(await poolExists('testpool')).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('destroying the boot/root pool → 409 PROTECTED_RESOURCE with NO code header', async ({ playwright, pveTicket }) => {
    const rootPool = await getRootPool()
    test.skip(!rootPool, 'system root is not on ZFS — no protected pool to exercise')

    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.delete(`${V1}/pools/${rootPool}`)
      expect(res.status()).toBe(409)
      const body = await res.json()
      expect(body.error.code).toBe('PROTECTED_RESOURCE')
      // Level-1 block: there is no override path, so no confirm code is offered.
      expect(res.headers()['x-anas-confirm-code']).toBeUndefined()
      expect(await poolExists(rootPool!)).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })
})

test.describe('Pool property modify (3.9)', () => {
  test.setTimeout(90_000)

  test('PUT /pools/testpool changing a property → 202 { job }', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    // autoexpand is a standard, reversible tunable (story 3.9). Toggle it, assert
    // the job is accepted, wait for it to actually apply, then restore.
    const orig = (await sshExec('zpool get -H -o value autoexpand testpool')).trim()
    const next = orig === 'on' ? 'off' : 'on'
    try {
      const res = await ctx.put(`${V1}/pools/testpool`, {
        data: { properties: { autoexpand: next } },
      })
      expect(res.status()).toBe(202)
      const body = await res.json()
      expect(body.job).toBeDefined()

      // Source of truth: the property really changed on the pool.
      await expect
        .poll(async () => (await sshExec('zpool get -H -o value autoexpand testpool')).trim(), {
          timeout: 30_000,
        })
        .toBe(next)
    }
    finally {
      // Restore regardless of outcome (best effort).
      await sshExec(`zpool set autoexpand=${orig} testpool`).catch(() => {})
      await ctx.dispose()
    }
  })
})

test.describe('Pool create / destroy / export / import (spare disks)', () => {
  test.setTimeout(180_000)

  let spares: string[] = []

  test.beforeEach(async () => {
    // Pre-clean any leftovers from a previous crashed run BEFORE counting spares,
    // so a stale throwaway pool doesn't hide its own disk.
    for (const p of ALL_TMP)
      await destroyPool(p)
    spares = await listSpareDisks()
  })

  test.afterEach(async () => {
    for (const p of ALL_TMP)
      await destroyPool(p)
  })

  test('creates a pool via the API, then destroys it through the confirmation flow (3.8, 3.14)', async ({ playwright, pveTicket }) => {
    test.skip(spares.length < 1, 'no spare disks — attach one with add-disk.sh')
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Create — 202 job, then the pool really appears (async job).
      const createRes = await ctx.post(`${V1}/pools`, {
        data: {
          name: TMP_CREATE,
          dataVdevs: [{ type: 'stripe', disks: [spares[0]] }],
          force: true,
        },
      })
      expect(createRes.status()).toBe(202)
      expect((await createRes.json()).job).toBeDefined()
      await expect.poll(() => poolExists(TMP_CREATE), { timeout: 90_000 }).toBe(true)

      // Give the pool a consequence (a child dataset) so destroy is a genuine
      // Level-2 confirmation, matching the dangerous-op contract.
      await sshExec(`zfs create ${TMP_CREATE}/child`).catch(() => {})

      // Destroy challenge — 409 + code.
      const challenge = await ctx.delete(`${V1}/pools/${TMP_CREATE}`)
      expect(challenge.status()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      expect((await challenge.json()).error.code).toBe('CONFIRMATION_REQUIRED')

      // Wrong code → still blocked.
      const wrong = await ctx.delete(`${V1}/pools/${TMP_CREATE}`, {
        headers: { 'x-anas-confirm': 'wrong-code' },
      })
      expect(wrong.status()).toBe(409)
      expect(await poolExists(TMP_CREATE)).toBe(true)

      // Correct code → accepted, and the pool is really gone.
      const confirmed = await ctx.delete(`${V1}/pools/${TMP_CREATE}`, {
        headers: { 'x-anas-confirm': code },
      })
      expect(confirmed.status()).toBe(202)
      expect((await confirmed.json()).job).toBeDefined()
      await expect.poll(() => poolExists(TMP_CREATE), { timeout: 60_000 }).toBe(false)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('exports a pool through the confirmation flow (3.13)', async ({ playwright, pveTicket }) => {
    test.skip(spares.length < 1, 'no spare disks — attach one with add-disk.sh')
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Stage a disposable, consequential pool directly (not the create path).
      await createTestPool(TMP_EXPORT, [spares[0]])
      await sshExec(`zfs create ${TMP_EXPORT}/child`).catch(() => {})

      // Export challenge → 409 + code.
      const challenge = await ctx.post(`${V1}/pools/${TMP_EXPORT}/export`)
      expect(challenge.status()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      expect((await challenge.json()).error.code).toBe('CONFIRMATION_REQUIRED')

      // Confirm → 202, and the pool leaves the imported set (export != destroy).
      const confirmed = await ctx.post(`${V1}/pools/${TMP_EXPORT}/export`, {
        headers: { 'x-anas-confirm': code },
      })
      expect(confirmed.status()).toBe(202)
      expect((await confirmed.json()).job).toBeDefined()
      await expect.poll(() => poolExists(TMP_EXPORT), { timeout: 60_000 }).toBe(false)
    }
    finally {
      // afterEach's destroyPool re-imports the exported pool and destroys it.
      await ctx.dispose()
    }
  })

  test('imports a known (exported) pool (3.7)', async ({ playwright, pveTicket }) => {
    test.skip(spares.length < 1, 'no spare disks — attach one with add-disk.sh')
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Stage a pool, then export it so it becomes importable but absent.
      await createTestPool(TMP_IMPORT, [spares[0]])
      await sshExec(`zpool export ${TMP_IMPORT}`)
      expect(await poolExists(TMP_IMPORT)).toBe(false)

      // Import by name → 202 job, then the pool is really back.
      const res = await ctx.post(`${V1}/pools/import`, {
        data: { name: TMP_IMPORT },
      })
      expect(res.status()).toBe(202)
      expect((await res.json()).job).toBeDefined()
      await expect.poll(() => poolExists(TMP_IMPORT), { timeout: 60_000 }).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('adds a vdev to a pool (3.11)', async ({ playwright, pveTicket }) => {
    test.skip(spares.length < 2, 'need 2 spare disks — attach more with add-disk.sh')
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Stage a single-disk stripe, then add a second stripe vdev via the API.
      await createTestPool(TMP_ADDVDEV, [spares[0]])
      const dev2 = (await sshExec(`readlink -f /dev/disk/by-id/${spares[1]}`)).trim()

      const res = await ctx.post(`${V1}/pools/${TMP_ADDVDEV}/vdevs`, {
        data: { vdev: { type: 'stripe', disks: [spares[1]] } },
      })
      expect(res.status()).toBe(202)
      expect((await res.json()).job).toBeDefined()

      // Source of truth: zpool status now references the newly-added disk (the
      // resolved /dev path is a substring of the partition path it prints).
      await expect
        .poll(async () => sshExec(`zpool status -LP ${TMP_ADDVDEV}`), { timeout: 60_000 })
        .toContain(dev2)
    }
    finally {
      await ctx.dispose()
    }
  })
})
