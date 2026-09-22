import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL, STUNT_HOST } from './fixtures/pve-ui'
import {
  datasetExists,
  destroyDataset,
  poolExists,
  sshExec,
} from './fixtures/stunt-node'

/**
 * Story pvepool.1 (GitHub #61) — LIVE PROOF of the PVE footprint ownership
 * predicate, over the pvepool fixture on the stunt node
 * (test/stunt-node/pvepool-fixture.sh up). Modelled on datasets-api.spec.ts and
 * pools-act-api.spec.ts: request-context API tests carrying the PVEAuthCookie,
 * gateway → local anasd → real zfs/targetcli.
 *
 * The fixture (NEVER touch its guest datasets or storages from here):
 *   pvfix   a loop pool registered as PVE zfspool storage `pvfix` (bare pool
 *           root), carrying guest volumes vm-100-disk-0 / subvol-101-disk-0 /
 *           basevol-102-disk-0 / base-103-disk-0, ANAS siblings
 *           pvfix/media + pvfix/media/child, and pvfix/dump registered as
 *           dir storage `pvfixdump`
 *   sysfix  a loop pool shaped like a ZFS-root install: bootfs =
 *           sysfix/ROOT/pve-1, a nested sysfix/data zfspool storage
 *           `sysfix-data` holding vm-200-disk-0, and sibling sysfix/media
 *
 * What is proven, per DESIGN.md "PVE footprint ownership":
 *   1/2. per-dataset ownership stamps on the dataset list (storage-root,
 *        guest-volume, dir-storage, system) — siblings carry NO pve field
 *   3.   a child of a storage root outside the guest naming is created (202
 *        job) and destroyed again through the confirm flow
 *   4.   the naming guard refuses a guest-named DIRECT child of the storage
 *        path (400), while the same name deeper in the tree is fine
 *   5.   owned-dataset mutations (destroy / property set / snapshot create)
 *        are refused with the ownership reason
 *   6.   snapshot SCHEDULES refuse only owned targets, not the pool
 *   7.   pool-level verbs on a SYSTEM pool (change mount / export / destroy)
 *        are hard-refused with no confirm bypass
 *   8.   iSCSI add-LUN accepts a sibling zvol and refuses a guest volume
 *   9.   backup consistency derives snapshot on a sibling and live on a guest
 *        subvol, via POST /backup/tasks/preview-nested (no PBS contact)
 *
 * Every refusal sentence observed by this file NAMES THE STORAGE AND THE
 * DATASET — never "this pool". Everything the tests create is destroyed in
 * afterEach/finally; the fixture itself is left exactly as found.
 */

// The API is reached exactly the way the injected panels reach it
// (packages/pve-integration/src/10-api.js): the PVE origin's /anas/ forward,
// which pveproxy proxies to the gateway's loopback listener. The gateway binds
// 127.0.0.1 plain HTTP (packages/gateway/src/config.ts), so :3000 is not a
// reachable target from outside the node. The AUTH PATH is unchanged — the same
// PVEAuthCookie jar the other API specs build (fixtures/auth.ts).
const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const PVE_POOL = 'pvfix'
const SYS_POOL = 'sysfix'

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

/** Poll a 202 job through GET /v1/jobs/:id until it completes or fails. */
async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 60_000,
): Promise<{ status: string, [k: string]: any }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${job.error ?? job.progress ?? ''}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Drive the standard 409-challenge → confirm → 202 destroy flow for a dataset. */
async function destroyViaApi(
  ctx: APIRequestContext,
  pool: string,
  path: string,
): Promise<void> {
  const challenge = await ctx.delete(`${V1}/pools/${pool}/datasets/${path}`)
  expect(challenge.status()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  const confirmed = await ctx.delete(`${V1}/pools/${pool}/datasets/${path}`, {
    headers: { 'x-anas-confirm': code },
  })
  expect(confirmed.status()).toBe(202)
  await expect
    .poll(() => datasetExists(`${pool}/${path}`), { timeout: 60_000 })
    .toBe(false)
}

// Skip the whole file when the fixture is absent (fixture not built / node off).
test.beforeEach(async () => {
  test.skip(!(await poolExists(PVE_POOL)) || !(await poolExists(SYS_POOL)), 'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up')
})

// ---------------------------------------------------------------------------
// 1 + 2 — the per-dataset ownership stamps on the list
// ---------------------------------------------------------------------------
test.describe('Per-dataset ownership stamps (list)', () => {
  test.setTimeout(60_000)

  test('pvfix: storage root, guest volumes and dir-storage stamped; siblings clean', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.get(`${V1}/pools/${PVE_POOL}/datasets`)
      expect(res.status()).toBe(200)
      const rows: Array<{ name: string, pve?: { kind: string, storage?: string, reason: string, childrenManageable?: boolean } }>
        = (await res.json()).data
      const byName = new Map(rows.map(r => [r.name, r]))

      // The storage root — PVE's configured pool path.
      const root = byName.get(PVE_POOL)
      expect(root?.pve).toEqual({
        kind: 'storage-root',
        storage: PVE_POOL,
        // A storage root may hold ANAS siblings — the daemon says so itself (review fix 3).
        childrenManageable: true,
        reason: expect.stringContaining(`PVE storage '${PVE_POOL}' owns ${PVE_POOL}`),
      })

      // All four guest prefixes, DIRECT children of the storage path.
      for (const vol of ['vm-100-disk-0', 'subvol-101-disk-0', 'basevol-102-disk-0', 'base-103-disk-0']) {
        const row = byName.get(`${PVE_POOL}/${vol}`)
        expect(row?.pve, vol).toEqual({
          kind: 'guest-volume',
          childrenManageable: false,
          storage: PVE_POOL,
          reason: expect.stringContaining(`PVE storage '${PVE_POOL}' owns ${PVE_POOL}/${vol} as a guest volume`),
        })
      }

      // The dir storage's tree (rule c).
      const dump = byName.get(`${PVE_POOL}/dump`)
      expect(dump?.pve).toEqual({
        kind: 'dir-storage',
        childrenManageable: false,
        storage: 'pvfixdump',
        reason: expect.stringContaining(`PVE storage 'pvfixdump' owns ${PVE_POOL}/dump as directory storage`),
      })

      // The ANAS siblings — the datasets this story exists to open up.
      expect(byName.get(`${PVE_POOL}/media`)?.pve).toBeUndefined()
      expect(byName.get(`${PVE_POOL}/media/child`)?.pve).toBeUndefined()
    }
    finally {
      await ctx.dispose()
    }
  })

  test('sysfix: boot tree system-owned; nested storage root and its guest stamped; sibling clean', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.get(`${V1}/pools/${SYS_POOL}/datasets`)
      expect(res.status()).toBe(200)
      const rows: Array<{ name: string, pve?: { kind: string, storage?: string, reason: string, childrenManageable?: boolean } }>
        = (await res.json()).data
      const byName = new Map(rows.map(r => [r.name, r]))

      const bootfs = `${SYS_POOL}/ROOT/pve-1`
      // The system pool's ROOT may hold ANAS siblings (rpool/media on a default install);
      // the boot tree may not — the daemon states both (review fix 3).
      expect(byName.get(SYS_POOL)?.pve).toMatchObject({ kind: 'system', childrenManageable: true })
      expect(byName.get(`${SYS_POOL}/ROOT`)?.pve).toMatchObject({ kind: 'system', childrenManageable: false })
      expect(byName.get(bootfs)?.pve).toMatchObject({ kind: 'system', childrenManageable: false })
      expect(byName.get(bootfs)?.pve?.reason).toContain(`${bootfs} is the boot filesystem of pool ${SYS_POOL}`)

      const dataRoot = byName.get(`${SYS_POOL}/data`)
      expect(dataRoot?.pve).toEqual({
        kind: 'storage-root',
        storage: 'sysfix-data',
        childrenManageable: true,
        reason: expect.stringContaining(`PVE storage 'sysfix-data' owns ${SYS_POOL}/data`),
      })

      expect(byName.get(`${SYS_POOL}/data/vm-200-disk-0`)?.pve).toEqual({
        kind: 'guest-volume',
        childrenManageable: false,
        storage: 'sysfix-data',
        reason: expect.stringContaining(`PVE storage 'sysfix-data' owns ${SYS_POOL}/data/vm-200-disk-0 as a guest volume`),
      })

      expect(byName.get(`${SYS_POOL}/media`)?.pve).toBeUndefined()
    }
    finally {
      await ctx.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 3 + 4 — create outside the footprint; the naming guard
// ---------------------------------------------------------------------------
test.describe('Dataset create on a PVE pool', () => {
  const PROOF_PATH = 'anas-proof'
  const PROOF_FQ = `${PVE_POOL}/${PROOF_PATH}`
  const SIBLING_GUEST = 'vm-900-disk-0'
  const SIBLING_GUEST_FQ = `${PVE_POOL}/media/${SIBLING_GUEST}`

  test.setTimeout(150_000)

  test.afterEach(async () => {
    // Only the throwaway names this describe creates — never the fixture's
    // guest volumes or storages.
    await destroyDataset(PROOF_FQ)
    await destroyDataset(SIBLING_GUEST_FQ)
  })

  test('a child of the storage root outside PVE\'s footprint is created and destroyed (3)', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const createRes = await ctx.post(`${V1}/pools/${PVE_POOL}/datasets`, {
        data: { path: PROOF_PATH },
      })
      expect(createRes.status()).toBe(202)
      const { id } = (await createRes.json()).job
      const job = await awaitJob(ctx, id)
      expect(job.status).toBe('completed')

      // Real system: the dataset exists, and the list does NOT stamp it.
      expect(await datasetExists(PROOF_FQ)).toBe(true)
      const list = await ctx.get(`${V1}/pools/${PVE_POOL}/datasets`)
      const row = ((await list.json()).data as Array<{ name: string, pve?: unknown }>)
        .find(d => d.name === PROOF_FQ)
      expect(row).toBeDefined()
      expect(row?.pve).toBeUndefined()

      // Destroy it again through the confirm flow.
      await destroyViaApi(ctx, PVE_POOL, PROOF_PATH)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('naming guard: a guest-named direct child is refused; deeper in the tree it is allowed (4)', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Direct child of the storage path — PVE would inventory it as a guest
      // disk. 400 backstop, and the sentence names the STORAGE and the DATASET.
      const refused = await ctx.post(`${V1}/pools/${PVE_POOL}/datasets`, {
        data: { path: SIBLING_GUEST },
      })
      expect(refused.status()).toBe(400)
      const err = (await refused.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toContain(`PVE storage '${PVE_POOL}' would inventory '${PVE_POOL}/${SIBLING_GUEST}' as a guest disk`)
      expect(await datasetExists(`${PVE_POOL}/${SIBLING_GUEST}`)).toBe(false)

      // The SAME name under a sibling — not a direct child of the storage
      // path, never listed by `zfs list -d1` — is accepted.
      const allowed = await ctx.post(`${V1}/pools/${PVE_POOL}/datasets`, {
        data: { path: `media/${SIBLING_GUEST}` },
      })
      expect(allowed.status()).toBe(202)
      const { id } = (await allowed.json()).job
      expect((await awaitJob(ctx, id)).status).toBe('completed')
      expect(await datasetExists(SIBLING_GUEST_FQ)).toBe(true)

      // And it is destroyed again through the confirm flow (a dataset ANAS
      // created is ANAS's to remove — even with a guest-shaped name).
      await destroyViaApi(ctx, PVE_POOL, `media/${SIBLING_GUEST}`)
    }
    finally {
      await ctx.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 5 — owned-dataset mutations refused with the ownership reason
// ---------------------------------------------------------------------------
test.describe('Owned-dataset mutations refused', () => {
  test.setTimeout(90_000)

  test('destroy vm-100-disk-0 → 400 naming storage + dataset', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.delete(`${V1}/pools/${PVE_POOL}/datasets/vm-100-disk-0`)
      expect(res.status()).toBe(400)
      const err = (await res.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toBe(`PVE storage '${PVE_POOL}' owns ${PVE_POOL}/vm-100-disk-0 as a guest volume`)
      expect(await datasetExists(`${PVE_POOL}/vm-100-disk-0`)).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('property set on subvol-101-disk-0 → 400 naming storage + dataset', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.put(`${V1}/pools/${PVE_POOL}/datasets/subvol-101-disk-0`, {
        data: { properties: { compression: 'lz4' } },
      })
      expect(res.status()).toBe(400)
      const err = (await res.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toBe(`PVE storage '${PVE_POOL}' owns ${PVE_POOL}/subvol-101-disk-0 as a guest volume`)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('snapshot create on the storage root pvfix → 400 naming storage + dataset', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.post(`${V1}/pools/${PVE_POOL}/datasets//snapshots`, {
        data: { name: 'anas-proof-snap' },
      })
      expect(res.status()).toBe(400)
      const err = (await res.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toContain(`PVE storage '${PVE_POOL}' owns ${PVE_POOL}`)
      // The storage root really has no such snapshot (source of truth).
      const snaps = await sshExec(`zfs list -H -o name -t snapshot -d 1 ${PVE_POOL} 2>/dev/null || true`)
      expect(snaps).not.toContain('anas-proof-snap')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('destroy sysfix/ROOT/pve-1 → 400 with the system reason', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.delete(`${V1}/pools/${SYS_POOL}/datasets/ROOT/pve-1`)
      expect(res.status()).toBe(400)
      const err = (await res.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toBe(`${SYS_POOL}/ROOT/pve-1 is the boot filesystem of pool ${SYS_POOL}`)
      expect(await datasetExists(`${SYS_POOL}/ROOT/pve-1`)).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 6 — snapshot schedules refuse only owned targets
// ---------------------------------------------------------------------------
test.describe('Snapshot schedules', () => {
  const SCHEDULE_ID = 'pvepool-proof'
  const SCHEDULE_BODY = {
    id: SCHEDULE_ID,
    name: 'pvepool proof',
    target: { kind: 'zfs', dataset: `${PVE_POOL}/media` },
    cadence: 'daily',
    retention: { daily: 3 },
    enabled: false,
  }

  test.setTimeout(90_000)

  test('a schedule on the sibling is accepted (and deleted again); one on a guest volume is refused', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Sibling target → accepted as a job.
      const ok = await ctx.post(`${V1}/schedules`, { data: SCHEDULE_BODY })
      expect(ok.status()).toBe(202)
      expect((await ok.json()).job).toBeDefined()

      // Owned target → 400 with the reason naming storage + dataset. The
      // schedule above is untouched (this is a different id-scoped refusal).
      const refused = await ctx.post(`${V1}/schedules`, {
        data: {
          ...SCHEDULE_BODY,
          id: 'pvepool-proof-owned',
          name: 'pvepool proof owned',
          target: { kind: 'zfs', dataset: `${PVE_POOL}/vm-100-disk-0` },
        },
      })
      expect(refused.status()).toBe(400)
      const err = (await refused.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toBe(`Cannot schedule snapshots of '${PVE_POOL}/vm-100-disk-0' — PVE storage '${PVE_POOL}' owns ${PVE_POOL}/vm-100-disk-0 as a guest volume`)

      // Clean up the accepted schedule through its own door.
      const del = await ctx.delete(`${V1}/schedules/${SCHEDULE_ID}`)
      expect(del.status()).toBe(202)
      expect((await del.json()).job).toBeDefined()
    }
    finally {
      await ctx.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 7 — system-pool hard refusals (no confirm bypass)
// ---------------------------------------------------------------------------
test.describe('System-pool hard refusals (sysfix)', () => {
  const BOOT = `${SYS_POOL}/ROOT/pve-1`

  test.setTimeout(90_000)

  test('change mount, export and destroy are hard-refused with the boot filesystem named', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const expectedMessage = `Pool '${SYS_POOL}' holds this node's boot filesystem (${BOOT}) — ANAS never destroys, exports or remounts a system pool`

      // PUT /pools/sysfix/mountpoint
      const mp = await ctx.put(`${V1}/pools/${SYS_POOL}/mountpoint`, {
        data: { mountpoint: '/anas-sysfix-elsewhere' },
      })
      expect(mp.status()).toBe(409)
      expect((await mp.json()).error).toEqual({ code: 'CONFLICT', reason: 'system-pool', message: expectedMessage })
      expect(mp.headers()['x-anas-confirm-code']).toBeUndefined()

      // POST /pools/sysfix/export
      const ex = await ctx.post(`${V1}/pools/${SYS_POOL}/export`)
      expect(ex.status()).toBe(409)
      expect((await ex.json()).error).toEqual({ code: 'CONFLICT', reason: 'system-pool', message: expectedMessage })
      expect(ex.headers()['x-anas-confirm-code']).toBeUndefined()

      // DELETE /pools/sysfix
      const de = await ctx.delete(`${V1}/pools/${SYS_POOL}`)
      expect(de.status()).toBe(409)
      expect((await de.json()).error).toEqual({ code: 'CONFLICT', reason: 'system-pool', message: expectedMessage })
      expect(de.headers()['x-anas-confirm-code']).toBeUndefined()

      // No confirm bypass: resending WITH a code (as if one had been offered)
      // still refuses.
      const bypass = await ctx.delete(`${V1}/pools/${SYS_POOL}`, {
        headers: { 'x-anas-confirm': 'whatever-code' },
      })
      expect(bypass.status()).toBe(409)
      expect((await bypass.json()).error.reason).toBe('system-pool')

      // The pool is untouched.
      expect(await poolExists(SYS_POOL)).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 8 — iSCSI add-LUN: sibling zvol accepted, guest volume refused
// ---------------------------------------------------------------------------
test.describe('iSCSI add-LUN on a PVE pool', () => {
  const TARGET_NAME = 'pvepoolproof'
  const DUMMY_INITIATOR = 'iqn.2005-03.org.openiscsi:anas.pvepool.proof'
  const ZVOL = 'lun-zvol-proof'
  const ZVOL_FQ = `${PVE_POOL}/media/${ZVOL}`

  test.setTimeout(240_000)

  /**
   * Best-effort removal of the proof target — pre-clean of a leaked one from
   * a crashed earlier run AND the teardown for this run. LUNs go first
   * (confirm flow each), then the LUN-less target. Never throws.
   */
  async function deleteProofTarget(ctx: APIRequestContext): Promise<void> {
    try {
      const list = await ctx.get(`${V1}/iscsi/targets`)
      if (!list.ok())
        return
      const target = ((await list.json()).data.targets as Array<{ iqn: string }>)
        .find(t => t.iqn.includes(TARGET_NAME))
      if (!target)
        return
      const iqn = encodeURIComponent(target.iqn)
      const detail = await ctx.get(`${V1}/iscsi/targets/${iqn}`)
      const luns: Array<{ index: number }> = detail.ok()
        ? (await detail.json()).data.luns
        : []
      for (const lun of luns) {
        const challenge = await ctx.delete(`${V1}/iscsi/targets/${iqn}/luns/${lun.index}`)
        const code = challenge.headers()['x-anas-confirm-code']
        if (challenge.status() === 409 && code) {
          const confirmed = await ctx.delete(`${V1}/iscsi/targets/${iqn}/luns/${lun.index}`, {
            headers: { 'x-anas-confirm': code },
          })
          if (confirmed.status() === 202)
            await awaitJob(ctx, (await confirmed.json()).job.id)
        }
      }
      await ctx.delete(`${V1}/iscsi/targets/${iqn}`)
    }
    catch {
      // Best-effort only.
    }
  }

  test.afterEach(async () => {
    // The staged zvol: destroyed here because the LUN door keeps the backing
    // unless destroyBacking is chosen (and may refuse it for other reasons).
    await sshExec(`zfs destroy ${ZVOL_FQ} 2>/dev/null || true`).catch(() => {})
  })

  test('a zvol on the sibling is accepted; a PVE guest volume is refused with the guest sentence', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Pre-clean a target a crashed earlier run may have leaked.
      await deleteProofTarget(ctx)

      // Stage a throwaway zvol under the ANAS sibling (source of truth
      // staging, like the specs stage datasets with `zfs create -p`).
      await sshExec(`zfs create -V 64M ${ZVOL_FQ}`)
      expect(await datasetExists(ZVOL_FQ)).toBe(true)

      // A target is needed for both add-LUN calls (the refusal happens after
      // the target is found). Created through the API, deleted before exit.
      const createRes = await ctx.post(`${V1}/iscsi/targets`, {
        data: {
          name: TARGET_NAME,
          portals: [{ address: STUNT_HOST }],
          acls: [{ initiatorIqn: DUMMY_INITIATOR }],
        },
      })
      expect(createRes.status()).toBe(202)
      const createJob = await awaitJob(ctx, (await createRes.json()).job.id)
      expect(createJob.status).toBe('completed')
      const list = await ctx.get(`${V1}/iscsi/targets`)
      const target = ((await list.json()).data.targets as Array<{ iqn: string }>)
        .find(t => t.iqn.includes(TARGET_NAME))
      expect(target).toBeDefined()
      const targetIqn = target!.iqn
      const iqn = encodeURIComponent(targetIqn)

      try {
        // Guest volume backing → refused with the guest sentence. 409 (the
        // refusal is a CONFLICT, not a validation error).
        const refused = await ctx.post(`${V1}/iscsi/targets/${iqn}/luns`, {
          data: { name: 'proof-guest', kind: 'zvol', backing: `${PVE_POOL}/vm-100-disk-0` },
        })
        expect(refused.status()).toBe(409)
        const err = (await refused.json()).error
        expect(err.reason).toBe('pve-guest-volume')
        expect(err.message).toBe(`'${PVE_POOL}/vm-100-disk-0' is a PVE guest volume — PVE's territory is read-only and hands-off, and its disks are never ANAS's to export`)

        // Sibling zvol backing → accepted; the LUN really appears.
        const ok = await ctx.post(`${V1}/iscsi/targets/${iqn}/luns`, {
          data: { name: 'proof-sibling', kind: 'zvol', backing: ZVOL_FQ },
        })
        expect(ok.status()).toBe(202)
        const okJob = await awaitJob(ctx, (await ok.json()).job.id)
        expect(okJob.status).toBe('completed')
        const detail = await ctx.get(`${V1}/iscsi/targets/${iqn}`)
        const luns = (await detail.json()).data.luns as Array<{ name: string, kind: string, backingPath: string }>
        const lun = luns.find(l => l.name === 'proof-sibling')
        expect(lun).toBeDefined()
        expect(lun!.backingPath).toBe(`/dev/zvol/${ZVOL_FQ}`)

        // Clean the LUN through its own door (confirm flow), keeping nothing:
        // the backing zvol is destroyed in afterEach.
        const challenge = await ctx.delete(`${V1}/iscsi/targets/${iqn}/luns/0`)
        expect(challenge.status()).toBe(409)
        const code = challenge.headers()['x-anas-confirm-code']
        expect(code).toBeTruthy()
        const confirmed = await ctx.delete(`${V1}/iscsi/targets/${iqn}/luns/0`, {
          headers: { 'x-anas-confirm': code },
        })
        expect(confirmed.status()).toBe(202)
        expect((await awaitJob(ctx, (await confirmed.json()).job.id)).status).toBe('completed')
      }
      finally {
        // The target must have NO LUNs before it can be deleted.
        await deleteProofTarget(ctx)
      }
    }
    finally {
      await ctx.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 9 — backup consistency via preview-nested (no PBS contact, no task needed)
// ---------------------------------------------------------------------------
test.describe('Backup consistency derivation', () => {
  test.setTimeout(60_000)

  test('preview-nested: sibling source gets a snapshot; guest subvol is live with the reason', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.post(`${V1}/backup/tasks/preview-nested`, {
        data: {
          archives: [
            { name: 'media', path: `/${PVE_POOL}/media` },
            { name: 'guest', path: `/${PVE_POOL}/subvol-101-disk-0` },
          ],
        },
      })
      expect(res.status()).toBe(200)
      // Each scan row carries the DERIVED consistency as an object
      // (BackupArchiveConsistency) — the verdict + the one-sentence reason.
      const archives = (await res.json()).data.archives as Array<{
        archive?: string
        consistency?: { consistency: string, reason: string }
      }>

      const sibling = archives.find(a => a.archive === 'media')
      expect(sibling?.consistency?.consistency).toBe('snapshot')
      expect(sibling?.consistency?.reason).toContain(`is on the ZFS dataset ${PVE_POOL}/media`)

      const guest = archives.find(a => a.archive === 'guest')
      expect(guest?.consistency?.consistency).toBe('live')
      expect(guest?.consistency?.reason).toBe(`/${PVE_POOL}/subvol-101-disk-0 is inside PVE's footprint - PVE storage '${PVE_POOL}' owns ${PVE_POOL}/subvol-101-disk-0 as a guest volume - so the run takes no snapshot and reads the live tree`)
    }
    finally {
      await ctx.dispose()
    }
  })
})
