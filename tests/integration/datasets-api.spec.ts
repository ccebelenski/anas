import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { GATEWAY_URL, NODE_NAME } from './fixtures/pve-ui'
import {
  datasetExists,
  destroyDataset,
  getDatasetMountpoint,
  getDatasetProp,
  poolExists,
  sshExec,
  statOwnership,
} from './fixtures/stunt-node'

/**
 * Epic 4 (ZFS Datasets), stories 4.1–4.8 — request-context API tests driven
 * exactly the way the injected ExtJS panels' API helper will (PVEAuthCookie in
 * the jar, gateway → local anasd), against the REAL stunt node.
 *
 * Contracts under test (DESIGN.md → "ZFS Datasets", "Safety Semantics" + brief):
 *   - GET    /pools/:name/datasets            list (flat) incl. the pool itself → 200 { data: Dataset[] }
 *   - GET    /pools/:name/datasets/<path>     detail + properties + permissions + associatedShares → 200 { data }
 *   - POST   /pools/:name/datasets            create (body { path, properties? }) → 202 { job }; 409 if exists
 *   - PUT    /pools/:name/datasets/<path>     modify (body { properties })        → 202 { job }
 *   - DELETE /pools/:name/datasets/<path>[?recursive=true]  destroy — DANGEROUS  → 409 / 202
 *   - PUT    /pools/:name/datasets/<path>/permissions  chown/chmod (owner/group/mode/recursive) → 202 { job }
 *   - GET    /identity/users                  owner/group picker source          → 200 { data: SystemUser[] }
 *   - GET    /identity/groups                                                    → 200 { data: SystemGroup[] }
 *
 * The destroy confirmation flow is the priority (Principle 14, Safety Semantics):
 *   without x-anas-confirm → 409 { error.code: 'CONFIRMATION_REQUIRED' } plus an
 *   `x-anas-confirm-code` response header; resend with `x-anas-confirm: <code>`
 *   → 202. A plain (non-recursive) destroy of a parent that still has children
 *   fails; `?recursive=true` destroys them.
 *
 * Guarded on poolExists('testpool') so the whole file skips cleanly when the box
 * isn't set up (poolExists also swallows SSH failures → skips when the node is
 * off). Datasets need NO spare disks — they live inside testpool — so unlike the
 * pool Act specs these are not gated on listSpareDisks(). Everything created is
 * torn down (recursively) in afterEach so reruns start clean. Generous timeouts:
 * these go browser → gateway → anasd → real zfs, then poll the source of truth.
 */

const V1 = `${GATEWAY_URL}/api/nodes/${NODE_NAME}/v1`

// Throwaway dataset used across the lifecycle + child tests. Path within the
// pool is 'itest'; fully-qualified on the system it is 'testpool/itest'.
const POOL = 'testpool'
const DS_PATH = 'itest'
const DS_FQ = `${POOL}/${DS_PATH}`

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
// off). Mirrors the pool specs.
test.beforeEach(async () => {
  test.skip(!(await poolExists(POOL)), 'testpool not present — run setup-test-data.sh')
})

// Always tear the throwaway dataset (and any children) down, even on failure, so
// a crashed run can't leak state into the next.
test.afterEach(async () => {
  await destroyDataset(DS_FQ)
})

test.describe('Dataset read model (4.1–4.4)', () => {
  test.setTimeout(60_000)

  test('GET /pools/testpool/datasets → 200 { data: [] } that includes testpool itself', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.get(`${V1}/pools/${POOL}/datasets`)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data.length).toBeGreaterThan(0)
      // The flat list includes the pool's root dataset (name === the pool name).
      expect(body.data.some((d: { name: string }) => d.name === POOL)).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('GET /identity/users → 200 non-empty array including root', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.get(`${V1}/identity/users`)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data.length).toBeGreaterThan(0)
      // root (uid 0) is always present — the owner picker must surface it.
      expect(body.data.some((u: { name: string }) => u.name === 'root')).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('GET /identity/groups → 200 non-empty array including root', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.get(`${V1}/identity/groups`)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data.length).toBeGreaterThan(0)
      expect(body.data.some((g: { name: string }) => g.name === 'root')).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })
})

test.describe('Dataset lifecycle: create → detail → modify → permissions → destroy (4.5–4.8)', () => {
  test.setTimeout(150_000)

  // Pre-clean any leftover from a previous crashed run so create isn't a no-op
  // and the confirmation code is bound to a fresh dataset.
  test.beforeEach(async () => {
    await destroyDataset(DS_FQ)
  })

  test('full lifecycle through the API, verified against the real system', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // --- create (4.5) — 202 job, then the dataset really appears (async job).
      const createRes = await ctx.post(`${V1}/pools/${POOL}/datasets`, {
        data: { path: DS_PATH, properties: { compression: 'lz4' } },
      })
      expect(createRes.status()).toBe(202)
      expect((await createRes.json()).job).toBeDefined()
      await expect.poll(() => datasetExists(DS_FQ), { timeout: 60_000 }).toBe(true)

      // Source of truth: the create-time property was applied.
      await expect
        .poll(() => getDatasetProp(DS_FQ, 'compression'), { timeout: 30_000 })
        .toBe('lz4')

      // --- create again → 409 (already exists).
      const dup = await ctx.post(`${V1}/pools/${POOL}/datasets`, {
        data: { path: DS_PATH },
      })
      expect(dup.status()).toBe(409)

      // --- detail (4.2–4.4) — the dataset, its properties, and the permissions +
      // associatedShares blocks the UI needs.
      const detail = await ctx.get(`${V1}/pools/${POOL}/datasets/${DS_PATH}`)
      expect(detail.status()).toBe(200)
      const dd = (await detail.json()).data
      expect(dd.name).toBe(DS_FQ)
      expect(dd.properties).toBeDefined()
      // The set property is visible in the detail payload (shape-agnostic check).
      expect(JSON.stringify(dd.properties)).toContain('lz4')
      expect(dd.permissions).toBeDefined()
      expect(Array.isArray(dd.associatedShares)).toBe(true)

      // --- modify (4.6) — flip compression, assert 202, verify on the system.
      const modify = await ctx.put(`${V1}/pools/${POOL}/datasets/${DS_PATH}`, {
        data: { properties: { compression: 'gzip' } },
      })
      expect(modify.status()).toBe(202)
      expect((await modify.json()).job).toBeDefined()
      await expect
        .poll(() => getDatasetProp(DS_FQ, 'compression'), { timeout: 30_000 })
        .toBe('gzip')

      // --- permissions (4.7) — chown/chmod the mountpoint. owner/group root:root
      // are guaranteed to exist; mode 0770 is a clear change from the ZFS default
      // (0755), so `stat` is a meaningful source-of-truth check.
      const perms = await ctx.put(`${V1}/pools/${POOL}/datasets/${DS_PATH}/permissions`, {
        data: { owner: 'root', group: 'root', mode: '0770' },
      })
      expect(perms.status()).toBe(202)
      expect((await perms.json()).job).toBeDefined()

      const mountpoint = await getDatasetMountpoint(DS_FQ)
      expect(mountpoint.startsWith('/')).toBe(true)
      await expect
        .poll(() => statOwnership(mountpoint), { timeout: 30_000 })
        .toBe('root root 770')

      // --- destroy through the confirmation flow (4.8).
      // Challenge — no confirm header → 409 + code.
      const challenge = await ctx.delete(`${V1}/pools/${POOL}/datasets/${DS_PATH}`)
      expect(challenge.status()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      expect((await challenge.json()).error.code).toBe('CONFIRMATION_REQUIRED')
      expect(await datasetExists(DS_FQ)).toBe(true)

      // Correct code → accepted, and the dataset is really gone.
      const confirmed = await ctx.delete(`${V1}/pools/${POOL}/datasets/${DS_PATH}`, {
        headers: { 'x-anas-confirm': code },
      })
      expect(confirmed.status()).toBe(202)
      expect((await confirmed.json()).job).toBeDefined()
      await expect.poll(() => datasetExists(DS_FQ), { timeout: 60_000 }).toBe(false)
    }
    finally {
      await ctx.dispose()
    }
  })
})

test.describe('Dataset destroy with children — plain fails, recursive succeeds (4.8)', () => {
  test.setTimeout(150_000)

  const CHILD_FQ = `${DS_FQ}/child`

  test.beforeEach(async () => {
    // Stage parent + child directly (this test is about destroy semantics, not
    // the create path). `-p` creates the parent chain in one go.
    await destroyDataset(DS_FQ)
    await sshExec(`zfs create -p ${CHILD_FQ}`)
  })

  test('a plain destroy of a parent with children fails; ?recursive=true removes the tree', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      expect(await datasetExists(CHILD_FQ)).toBe(true)

      // Plain (non-recursive) destroy: obtain the confirmation code, resend — but
      // `zfs destroy` without -r cannot remove a dataset that still has children,
      // so the parent survives.
      const challenge = await ctx.delete(`${V1}/pools/${POOL}/datasets/${DS_PATH}`)
      expect(challenge.status()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      await ctx.delete(`${V1}/pools/${POOL}/datasets/${DS_PATH}`, {
        headers: { 'x-anas-confirm': code },
      })
      // The child (and therefore the parent) is still present — plain destroy did
      // not, and must not, remove the tree.
      expect(await datasetExists(CHILD_FQ)).toBe(true)
      expect(await datasetExists(DS_FQ)).toBe(true)

      // Recursive destroy: fresh challenge for the recursive operation, then
      // confirm — the whole tree goes.
      const recChallenge = await ctx.delete(`${V1}/pools/${POOL}/datasets/${DS_PATH}?recursive=true`)
      expect(recChallenge.status()).toBe(409)
      const recCode = recChallenge.headers()['x-anas-confirm-code']
      expect(recCode).toBeTruthy()
      expect((await recChallenge.json()).error.code).toBe('CONFIRMATION_REQUIRED')

      const recConfirmed = await ctx.delete(`${V1}/pools/${POOL}/datasets/${DS_PATH}?recursive=true`, {
        headers: { 'x-anas-confirm': recCode },
      })
      expect(recConfirmed.status()).toBe(202)
      expect((await recConfirmed.json()).job).toBeDefined()
      await expect.poll(() => datasetExists(DS_FQ), { timeout: 60_000 }).toBe(false)
      expect(await datasetExists(CHILD_FQ)).toBe(false)
    }
    finally {
      await ctx.dispose()
    }
  })
})
