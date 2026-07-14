import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { GATEWAY_URL, NODE_NAME } from './fixtures/pve-ui'
import {
  getDatasetMountpoint,
  listSnapshots,
  poolExists,
  snapshotExists,
  sshExec,
} from './fixtures/stunt-node'

/**
 * Epic 5 (ZFS Snapshots), stories 5.1–5.6 — request-context API tests driven
 * exactly the way the injected ExtJS panels' API helper will (PVEAuthCookie in
 * the jar, gateway → local anasd), against the REAL stunt node. Companion to
 * snapshots-ui.spec.ts. Modelled on datasets-api.spec.ts.
 *
 * Snapshots are nested under a dataset. The dataset PATH within the pool is the
 * ZFS name minus the pool prefix — here 'share1' (fully-qualified
 * 'testpool/share1', which setup-test-data.sh always creates). Snapshots need NO
 * spare disks — they live inside the existing dataset — so this file is guarded
 * only on poolExists('testpool').
 *
 * Contracts under test (DESIGN.md → "ZFS Snapshots" + task brief):
 *   - GET    .../datasets/share1/snapshots         list, newest-first → 200 { data: Snapshot[] }
 *   - POST   .../datasets/share1/snapshots          create (body { name, recursive? }) → 202 { job }; 409 if exists
 *   - PUT    .../datasets/share1/snapshots/:snap    rename (body { newName })          → 202 { job }
 *   - DELETE .../datasets/share1/snapshots/:snap    destroy — PLAIN 202, NO 409 challenge
 *   - POST   .../datasets/share1/snapshots/:snap/rollback  DANGEROUS → 409 challenge / 202
 *
 * Two distinct safety postures are the priority here:
 *   - destroy is NOT confirmation-gated → a bare DELETE returns 202 immediately.
 *   - rollback IS confirmation-gated → a bare POST returns 409
 *     { error.code: 'CONFIRMATION_REQUIRED' } + an `x-anas-confirm-code` response
 *     header; resend with `x-anas-confirm: <code>` → 202. (`?force=true` is NOT
 *     bound to the code — it's an independent modifier.)
 *
 * Everything created is torn down in afterEach so reruns start clean. Generous
 * timeouts: these go browser → gateway → anasd → real zfs, then poll the source
 * of truth.
 */

const V1 = `${GATEWAY_URL}/api/nodes/${NODE_NAME}/v1`

const POOL = 'testpool'
const DS_PATH = 'share1'
const DS_FQ = `${POOL}/${DS_PATH}`
const SNAPS = `${V1}/pools/${POOL}/datasets/${DS_PATH}/snapshots`

// Every snapshot name this file might create — cleaned unconditionally in
// afterEach so a crashed run can't leak recovery points into the next.
const ALL_SNAP_NAMES = ['s1', 's1b', 's2']
const ROLLBACK_MARKER = 'anas-rollback-marker'

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
// off). poolExists swallows SSH failures → skips when the node is off.
test.beforeEach(async () => {
  test.skip(!(await poolExists(POOL)), 'testpool not present — run setup-test-data.sh')
})

// Tear down every snapshot we might have created + the rollback marker file,
// even on failure. Never throws — most will already be gone.
test.afterEach(async () => {
  for (const name of ALL_SNAP_NAMES)
    await sshExec(`zfs destroy testpool/share1@${name}`).catch(() => {})
  await sshExec(`rm -f /testpool/share1/${ROLLBACK_MARKER}`).catch(() => {})
})

test.describe('Snapshot lifecycle: create → list → dup → rename → destroy (5.1–5.6)', () => {
  test.setTimeout(150_000)

  // Pre-clean any leftover from a previous crashed run so create isn't a no-op
  // and the confirmation code is bound to a fresh operation.
  test.beforeEach(async () => {
    for (const name of ALL_SNAP_NAMES)
      await sshExec(`zfs destroy testpool/share1@${name}`).catch(() => {})
  })

  test('create → list (newest-first, typed fields) → duplicate 409 → rename → PLAIN destroy', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // --- create 's1' (5.3) — 202 job, then the snapshot really appears.
      const createRes = await ctx.post(SNAPS, { data: { name: 's1' } })
      expect(createRes.status()).toBe(202)
      expect((await createRes.json()).job).toBeDefined()
      await expect.poll(() => snapshotExists(DS_FQ, 's1'), { timeout: 60_000 }).toBe(true)

      // --- list (5.1–5.2) — s1 is present, newest-first, with the typed fields
      // the UI renders. Create a SECOND snapshot so newest-first ordering is
      // actually observable (s1b is created after s1).
      const create1b = await ctx.post(SNAPS, { data: { name: 's1b' } })
      expect(create1b.status()).toBe(202)
      await expect.poll(() => snapshotExists(DS_FQ, 's1b'), { timeout: 60_000 }).toBe(true)

      const list = await ctx.get(SNAPS)
      expect(list.status()).toBe(200)
      const rows: Array<{
        name: string
        dataset: string
        snapshotName: string
        pool: string
        created: string
        used: number
        referenced: number
      }> = (await list.json()).data
      expect(Array.isArray(rows)).toBe(true)

      const s1 = rows.find(r => r.snapshotName === 's1')
      const s1b = rows.find(r => r.snapshotName === 's1b')
      expect(s1).toBeDefined()
      expect(s1b).toBeDefined()

      // Shape of a snapshot row (5.1/5.2): identity + typed space accounting.
      expect(s1!.name).toBe(`${DS_FQ}@s1`)
      expect(s1!.dataset).toBe(DS_FQ)
      expect(s1!.pool).toBe(POOL)
      // `created` parses as an ISO date.
      expect(Number.isNaN(Date.parse(s1!.created))).toBe(false)
      // used/referenced are numbers (bytes), not human-readable strings.
      expect(typeof s1!.used).toBe('number')
      expect(typeof s1!.referenced).toBe('number')

      // Newest-first: s1b (created after s1) sorts before s1 in the payload.
      const idxS1 = rows.findIndex(r => r.snapshotName === 's1')
      const idxS1b = rows.findIndex(r => r.snapshotName === 's1b')
      expect(idxS1b).toBeLessThan(idxS1)

      // --- duplicate create → 409 (s1 already exists).
      const dup = await ctx.post(SNAPS, { data: { name: 's1' } })
      expect(dup.status()).toBe(409)

      // --- rename s1 → s1b is taken; rename s1 to a fresh name is the clean path,
      // but the brief asks specifically for s1 → s1b. s1b already exists, so first
      // remove it, then rename s1 → s1b (5.4).
      await sshExec(`zfs destroy testpool/share1@s1b`).catch(() => {})
      await expect.poll(() => snapshotExists(DS_FQ, 's1b'), { timeout: 30_000 }).toBe(false)

      const rename = await ctx.put(`${SNAPS}/s1`, { data: { newName: 's1b' } })
      expect(rename.status()).toBe(202)
      expect((await rename.json()).job).toBeDefined()
      await expect.poll(() => snapshotExists(DS_FQ, 's1b'), { timeout: 60_000 }).toBe(true)
      await expect.poll(() => snapshotExists(DS_FQ, 's1'), { timeout: 30_000 }).toBe(false)

      // --- destroy is PLAIN (5.6) — a bare DELETE returns 202 immediately, with
      // NO 409 confirmation challenge. This is the key distinction from rollback.
      const destroy = await ctx.delete(`${SNAPS}/s1b`)
      expect(destroy.status()).toBe(202)
      expect((await destroy.json()).job).toBeDefined()
      // Explicitly assert destroy did NOT issue a challenge.
      expect(destroy.status()).not.toBe(409)
      await expect.poll(() => snapshotExists(DS_FQ, 's1b'), { timeout: 60_000 }).toBe(false)
    }
    finally {
      await ctx.dispose()
    }
  })
})

test.describe('Snapshot rollback — confirmation-gated, verified against the real system (5.5)', () => {
  test.setTimeout(150_000)

  test.beforeEach(async () => {
    for (const name of ALL_SNAP_NAMES)
      await sshExec(`zfs destroy testpool/share1@${name}`).catch(() => {})
    await sshExec(`rm -f /testpool/share1/${ROLLBACK_MARKER}`).catch(() => {})
  })

  test('rollback demands x-anas-confirm (409 + code), then rolls back on resend', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const mountpoint = await getDatasetMountpoint(DS_FQ)
      expect(mountpoint.startsWith('/')).toBe(true)

      // --- stage: snapshot the CURRENT (marker-free) state as s2, then modify the
      // filesystem so rollback has something observable to undo.
      const create = await ctx.post(SNAPS, { data: { name: 's2' } })
      expect(create.status()).toBe(202)
      await expect.poll(() => snapshotExists(DS_FQ, 's2'), { timeout: 60_000 }).toBe(true)

      // Modify: create a marker file that did NOT exist at snapshot time.
      await sshExec(`touch ${mountpoint}/${ROLLBACK_MARKER}`)
      await expect
        .poll(() => sshExec(`test -e ${mountpoint}/${ROLLBACK_MARKER} && echo yes || echo no`), { timeout: 15_000 })
        .toBe('yes')

      // --- rollback challenge — a bare POST is refused (DANGEROUS): 409 +
      // CONFIRMATION_REQUIRED + x-anas-confirm-code header. Nothing changes yet.
      const challenge = await ctx.post(`${SNAPS}/s2/rollback`)
      expect(challenge.status()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      expect((await challenge.json()).error.code).toBe('CONFIRMATION_REQUIRED')
      // The marker is still there — the challenge did not perform the rollback.
      expect(await sshExec(`test -e ${mountpoint}/${ROLLBACK_MARKER} && echo yes || echo no`)).toBe('yes')

      // --- resend WITH the code → 202, and the filesystem really rolls back: the
      // marker file (added after the snapshot) is gone.
      const confirmed = await ctx.post(`${SNAPS}/s2/rollback`, {
        headers: { 'x-anas-confirm': code },
      })
      expect(confirmed.status()).toBe(202)
      expect((await confirmed.json()).job).toBeDefined()
      await expect
        .poll(() => sshExec(`test -e ${mountpoint}/${ROLLBACK_MARKER} && echo yes || echo no`), { timeout: 60_000 })
        .toBe('no')

      // The snapshot itself survives a rollback (it's the recovery point).
      expect(await snapshotExists(DS_FQ, 's2')).toBe(true)
      // Sanity: the source-of-truth lister still sees it.
      expect(await listSnapshots(DS_FQ)).toContain('s2')
    }
    finally {
      await ctx.dispose()
    }
  })
})
