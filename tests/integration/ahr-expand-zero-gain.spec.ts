import type { APIRequestContext, Locator, Page, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story **ahrexpand.1** — the zero-gain expansion guard (AHR-DESIGN §5.2) —
 * LIVE PROOF on the stunt node, against real mdadm/LVM/btrfs.
 *
 * The shape §5.2 is written about, built out of three virtual disks
 * (`test/stunt-node/ahrexpand-fixture.sh`): an AHR-1 pool on two 2 GiB disks,
 * and a 4 GiB disk to put in place of one of them. Replacing ONE member above
 * a band boundary forms a [2 GiB, 4 GiB] band with a single member, which
 * AHR-1 cannot protect: the capacity is physically there and locked, and the
 * plan's reachable target adds NO usable bytes. That is the plan the guard
 * refuses up front.
 *
 * The layout granularity is 1 GiB, so the fixture's sizes are exact: 2/2/4 GiB
 * after rounding, no slack, and every figure below is the planner's own.
 *
 * What is proven:
 *   1. the PLAN carries `usableGain: 0` and a `zeroGain` block whose
 *      `shortfall` quotes the planner's own pending-capacity sentence VERBATIM
 *      (the same string that is in `plan.warnings`), with `unlockSize` at the
 *      band boundary and `unlockGain` at what reaching it delivers — and the
 *      unlock is stated as a REPLACE, because the plan is a replace
 *   2. POST /expand is a 409 carrying `X-Anas-Confirm-Code` whose message IS
 *      that shortfall sentence
 *   3. the same POST with the confirm header is a 202 whose job completes: the
 *      pool's disk set really changed (the 4 GiB disk is a member, the 2 GiB
 *      one is not) and RAW capacity grew, while USABLE capacity did not — the
 *      new capacity is reported pending
 *   4. adding the freed 2 GiB disk back is a POSITIVE-gain plan: no `zeroGain`
 *      block, `usableGain` > 0, and the 409 it still gets (expansion is a
 *      Principle-14 dangerous op — the gate is unchanged, only its message)
 *      carries the generic reshape headline, not a zero-gain shortfall
 *   5. the expansion wizard's Change row reads the daemon's verdict: "no
 *      usable capacity" with the shortfall sentence beneath it for the
 *      zero-gain plan, a "+~<size>" for the positive one — and the confirm
 *      dialog carries the pending sentence the shortfall is built from
 *
 * Serial by construction: the pool is built once and each test moves it one
 * step along. `afterAll` destroys it through the API and takes the fixture
 * down, so the node is left with no pool, no intent and no disks 7/8/9.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtexpand'
const FIXTURE_SH = new URL('../../test/stunt-node/ahrexpand-fixture.sh', import.meta.url).pathname

const BY_ID = (serial: string): string => `scsi-0QEMU_QEMU_HARDDISK_${serial}`
/** The two 2 GiB band members the pool is created on. */
const SMALL_A = BY_ID('ANAS_HOT7')
const SMALL_B = BY_ID('ANAS_HOT8')
/** The 4 GiB disk that replaces SMALL_B — one disk above the band boundary. */
const BIG = BY_ID('ANAS_HOT9')

const GiB = 1024 ** 3

/** Build an authenticated request context carrying the PVE session cookie. */
async function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: pveAuthState(ticket),
    timeout: 300_000,
  })
}

/** Poll a 202 job through GET /v1/jobs/:id until it completes or fails. */
async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 600_000,
): Promise<{ status: string, error?: { message?: string } | null, result?: any, progress?: string | null }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${job.error?.message ?? job.progress ?? ''}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

/** Submit a mutation, wait for its job, and require it to COMPLETE. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'delete',
  url: string,
  data?: unknown,
  headers?: Record<string, string>,
  timeout = 600_000,
): Promise<any> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers !== undefined ? { headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, job.error?.message).toBe('completed')
  return job.result
}

/** Drive a confirm-gated mutation: 409 challenge → resend with the code. */
async function runConfirmedJob(
  ctx: APIRequestContext,
  verb: 'post' | 'delete',
  url: string,
  data?: unknown,
  timeout = 600_000,
): Promise<void> {
  const challenge = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(challenge.status(), await challenge.text()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  await runJob(ctx, verb, url, data, { 'x-anas-confirm': code }, timeout)
}

interface PlanResponse {
  before: { usableBytes: number, rawBytes: number, pendingBytes: number }
  after: { usableBytes: number, rawBytes: number, pendingBytes: number }
  steps: { kind: string, target: string, detail?: string }[]
  warnings: string[]
  bands: { band: number, range: { startBytes: number, endBytes: number }, memberCount: number, level: string | null, protected: boolean }[]
  usableGain: number
  zeroGain?: { shortfall: string, unlockSize: number, unlockGain: number }
}

/** POST /expand/plan — no mutation. */
async function plan(ctx: APIRequestContext, body: unknown): Promise<PlanResponse> {
  const res = await ctx.post(`${V1}/ahr/${POOL}/expand/plan`, { data: body })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data as PlanResponse
}

interface PoolDetail {
  state: string
  capacity: { usableBytes: number, rawBytes: number, pendingBytes: number }
  disks: { id: string, role: string }[]
}

async function poolDetail(ctx: APIRequestContext): Promise<PoolDetail> {
  const res = await ctx.get(`${V1}/ahr/${POOL}`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data as PoolDetail
}

/** Whether the pool is on the node right now (a spec may run standalone). */
async function poolExists(ctx: APIRequestContext): Promise<boolean> {
  const res = await ctx.get(`${V1}/ahr`)
  if (!res.ok())
    return false
  return ((await res.json()).data as { name: string }[]).some(p => p.name === POOL)
}

/** The pool's member disk ids, sorted — the "disk set" of the assertions. */
function memberIds(detail: PoolDetail): string[] {
  return detail.disks.map(d => d.id).sort()
}

/** Wait until the pool reports a settled state (no sync in flight). */
async function untilHealthy(ctx: APIRequestContext, timeout = 600_000): Promise<PoolDetail> {
  const deadline = Date.now() + timeout
  for (;;) {
    const detail = await poolDetail(ctx)
    if (detail.state === 'healthy')
      return detail
    if (Date.now() > deadline)
      throw new Error(`pool ${POOL} still '${detail.state}' after ${timeout}ms`)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

/** The plan's own pending-capacity sentence, or '' when it has none. */
function pendingWarning(p: PlanResponse): string {
  return p.warnings.find(w => w.includes('of new capacity is pending')) ?? ''
}

/** Open Hybrid RAID and return the pools grid. */
async function openAhrGrid(page: Page): Promise<Locator> {
  await loginToPve(page)
  await openAnasItem(page, 'Hybrid RAID')
  const grid = page.locator('.anas-grid-ahr')
  await expect(grid).toBeVisible({ timeout: 45_000 })
  return grid
}

test.describe.configure({ mode: 'serial' })

test.describe('AHR zero-gain expansion guard (ahrexpand.1)', () => {
  test.setTimeout(900_000)

  test.beforeAll(async () => {
    test.setTimeout(900_000)
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 600_000 })
    await execFileAsync(FIXTURE_SH, ['up'], { timeout: 600_000 })
  })

  test.afterAll(async ({ playwright }) => {
    test.setTimeout(900_000)
    // Destroy the pool through the API when it is still there, then take the
    // fixture down (which also sweeps whatever a crashed run left).
    try {
      const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
      const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
        form: { username: 'root@pam', password: 'anas-test' },
      })
      const ticket = (await ticketRes.json()).data.ticket as string
      await login.dispose()
      const ctx = await authedContext(playwright, ticket)
      try {
        if (await poolExists(ctx))
          await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
      }
      finally {
        await ctx.dispose()
      }
    }
    catch (err) {
      console.error(`pool teardown failed: ${err instanceof Error ? err.message : err}`)
    }
    try {
      await execFileAsync(FIXTURE_SH, ['down'], { timeout: 600_000 })
    }
    catch (err) {
      console.error(`ahrexpand fixture down failed: ${err instanceof Error ? err.message : err}`)
    }
  })

  test('the plan refuses to credit a replace above a band boundary, and the 409 says what unlocks it', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // --- the pool: AHR-1 on the two 2 GiB disks -------------------------
      await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: [SMALL_A, SMALL_B] })
      const fresh = await untilHealthy(ctx)
      expect(memberIds(fresh)).toEqual([SMALL_A, SMALL_B].sort())
      // One 2 GiB RAID1 band: usable is one disk's worth, nothing pending.
      expect(fresh.capacity.pendingBytes).toBe(0)
      const usableBefore = fresh.capacity.usableBytes
      const rawBefore = fresh.capacity.rawBytes

      // --- 1. the plan: zero gain, with the planner's own sentence ---------
      const zero = await plan(ctx, { replace: { oldDiskId: SMALL_B, newDiskId: BIG } })
      console.error(`ahrexpand.1 ZERO-GAIN PLAN: ${JSON.stringify({
        usableGain: zero.usableGain,
        zeroGain: zero.zeroGain,
        before: zero.before,
        after: zero.after,
        bands: zero.bands,
        warnings: zero.warnings,
        steps: zero.steps.map(s => `${s.kind} ${s.target}${s.detail ? ` (${s.detail})` : ''}`),
      }, null, 2)}`)

      expect(zero.usableGain, 'the replace adds no usable capacity').toBe(0)
      expect(zero.zeroGain, 'a zero-gain plan carries the zeroGain block').toBeTruthy()
      const zg = zero.zeroGain!

      // The band shape that makes it zero: the new top band has ONE member
      // and no level, so it is pending, not protected.
      const top = zero.bands.at(-1)!
      expect(top.memberCount).toBe(1)
      expect(top.level).toBeNull()
      expect(top.protected).toBe(false)
      expect(top.range.endBytes - top.range.startBytes).toBe(2 * GiB)

      // The shortfall LIFTS the planner's pending sentence verbatim — the
      // preview and the refusal can never quote different numbers (§5.2).
      const pending = pendingWarning(zero)
      expect(pending, 'the planner emitted its pending-capacity line').not.toBe('')
      expect(zg.shortfall).toBe(`This plan adds no usable capacity: ${pending}`)
      // …and the unlock is stated as a REPLACE, because the plan is a replace.
      expect(zg.shortfall).toContain('replace one more disk with ≥4 GiB to unlock ~2 GiB')
      expect(zg.unlockSize, 'the unlock size is the band boundary').toBe(4 * GiB)
      expect(zg.unlockGain, 'reaching it delivers the pending band').toBe(2 * GiB)
      // And this is WHY the guard measures planner-vs-planner (§5.2): the
      // plan's own `before` is the LIVE volume, which sits a sliver under its
      // band math (LVM metadata + extent rounding), so the naive
      // `after - before` subtraction reports GROWTH on a plan that delivers
      // nothing. The daemon's verdict is 0 all the same, and the wizard reads
      // the verdict rather than the subtraction.
      const naive = zero.after.usableBytes - zero.before.usableBytes
      expect(naive, 'the live-volume subtraction shows phantom growth').toBeGreaterThan(0)
      expect(naive, '…of LVM-overhead size, not band size').toBeLessThan(GiB)
      expect(zero.usableGain, 'the band-math verdict is still zero').toBe(0)
      expect(zero.after.pendingBytes).toBeGreaterThan(zero.before.pendingBytes)

      // --- 2. Execute → 409 whose MESSAGE is the shortfall -----------------
      const body = { replace: { oldDiskId: SMALL_B, newDiskId: BIG } }
      const challenge = await ctx.post(`${V1}/ahr/${POOL}/expand`, { data: body })
      expect(challenge.status(), await challenge.text()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code, 'the 409 carries a confirm code').toBeTruthy()
      const refusal = (await challenge.json()).error
      expect(refusal.code).toBe('CONFIRMATION_REQUIRED')
      expect(refusal.message, 'the refusal IS the zero-gain shortfall').toBe(zg.shortfall)
      expect(
        refusal.warnings as string[],
        'the pending sentence rides along in the warnings the dialog shows',
      ).toContain(pending)

      // --- 3. the confirm bypass proceeds, and delivers exactly nothing ----
      await runJob(ctx, 'post', `${V1}/ahr/${POOL}/expand`, body, { 'x-anas-confirm': code })
      const after = await untilHealthy(ctx)
      console.error(`ahrexpand.1 AFTER THE ZERO-GAIN EXPANSION: ${JSON.stringify({
        disks: after.disks,
        capacity: after.capacity,
      }, null, 2)}`)

      expect(memberIds(after), 'the 4 GiB disk is in, the 2 GiB one is out').toEqual([SMALL_A, BIG].sort())
      expect(after.capacity.rawBytes, 'raw capacity grew with the bigger disk').toBeGreaterThan(rawBefore)
      expect(after.capacity.usableBytes, 'usable capacity did NOT move').toBe(usableBefore)
      expect(after.capacity.pendingBytes, 'the new capacity is reported pending, never silently missing')
        .toBeGreaterThan(0)
      // No intent is left behind: the job that completes clears it (§5.3).
      expect(await sshExec(`ls /etc/anas/ahr/ 2>/dev/null | grep -c '${POOL}' || true`)).toBe('0')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('adding the freed disk back is a positive-gain plan, and its 409 is the ordinary reshape confirm', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const before = await untilHealthy(ctx)
      const usableBefore = before.capacity.usableBytes

      const positive = await plan(ctx, { addDisks: [SMALL_B] })
      console.error(`ahrexpand.1 POSITIVE-GAIN PLAN: ${JSON.stringify({
        usableGain: positive.usableGain,
        zeroGain: positive.zeroGain ?? null,
        before: positive.before,
        after: positive.after,
        steps: positive.steps.map(s => `${s.kind} ${s.target}${s.detail ? ` (${s.detail})` : ''}`),
      }, null, 2)}`)

      expect(positive.usableGain, 'the third disk widens the bottom band').toBeGreaterThan(0)
      expect(positive.zeroGain ?? null, 'no zeroGain block on a plan that delivers').toBeNull()
      // Band math on both sides: the third disk turns the 2 GiB RAID1 band
      // into a RAID5×3, which is exactly one more disk's worth of usable.
      expect(positive.usableGain).toBe(2 * GiB)
      // The naive subtraction is the same figure plus the live volume's own
      // overhead sliver — close, but not the number the guard rules on (§5.2).
      const naive = positive.after.usableBytes - positive.before.usableBytes
      expect(naive - positive.usableGain).toBeGreaterThan(0)
      expect(naive - positive.usableGain).toBeLessThan(GiB)

      // The confirm gate is unchanged — an expansion is a Principle-14
      // dangerous op whatever it gains — but its MESSAGE is the ordinary
      // reshape headline, not a zero-gain shortfall.
      const body = { addDisks: [SMALL_B] }
      const challenge = await ctx.post(`${V1}/ahr/${POOL}/expand`, { data: body })
      expect(challenge.status(), await challenge.text()).toBe(409)
      const code = challenge.headers()['x-anas-confirm-code']
      expect(code).toBeTruthy()
      const refusal = (await challenge.json()).error
      expect(refusal.message).toBe(`Expanding AHR pool '${POOL}' starts an online reshape`)
      expect(refusal.message).not.toContain('adds no usable capacity')

      await runJob(ctx, 'post', `${V1}/ahr/${POOL}/expand`, body, { 'x-anas-confirm': code })
      const after = await untilHealthy(ctx)
      expect(memberIds(after)).toEqual([SMALL_A, SMALL_B, BIG].sort())
      expect(after.capacity.usableBytes, 'this one really did grow').toBeGreaterThan(usableBefore)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the expansion wizard reads the same verdict: the Change row and the confirm dialog', async ({ page, playwright, pveTicket }) => {
    // The previous test left a three-disk pool, so the §5.2 shape is rebuilt
    // from scratch through the API: the wizard needs the 4 GiB disk AVAILABLE
    // and a 2 GiB member to point it at.
    const ctx = await authedContext(playwright, pveTicket)
    try {
      if (await poolExists(ctx))
        await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
      await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: [SMALL_A, SMALL_B] })
      await untilHealthy(ctx)
    }
    finally {
      await ctx.dispose()
    }

    await page.setViewportSize({ width: 2560, height: 1080 })
    const grid = await openAhrGrid(page)
    await grid.locator('.x-grid-row', { hasText: POOL }).first().click()
    await grid.locator('.anas-btn-ahr-expand').click()
    const win = page.locator('.anas-win-ahr-expand')
    await expect(win).toBeVisible({ timeout: 45_000 })

    // Replace mode: the 2 GiB member out, the 4 GiB disk in. The plan
    // recomputes live on every pick (no Compute button).
    await win.locator('input[name="ahrx-mode"][value="replace"]').check()
    await win.locator(`input[name="ahrx-old"][value="${SMALL_B}"]`).check()
    await win.locator(`input[name="ahrx-new"][value="${BIG}"]`).check()

    // The Change row reads the daemon's verdict (usableGain/zeroGain), not a
    // local before → after subtraction.
    const planBox = win.locator('#ahrx-plan')
    await expect(planBox).toContainText('Change', { timeout: 45_000 })
    await expect(planBox).toContainText('no usable capacity', { timeout: 45_000 })
    await expect(planBox).toContainText('This plan adds no usable capacity:')
    await expect(planBox).toContainText('replace one more disk with ≥4 GiB to unlock ~2 GiB')

    // Execute → the confirm dialog carries the pending sentence the shortfall
    // is built from (confirmAndRun renders the 409's warnings verbatim).
    await win.locator('.anas-btn-ahr-expand-exec').click()
    const confirm = page.locator('.anas-win-confirm')
    await expect(confirm).toBeVisible({ timeout: 45_000 })
    await expect(confirm).toContainText('of new capacity is pending')
    await expect(confirm).toContainText('replace one more disk with ≥4 GiB to unlock ~2 GiB')
    // Nothing is committed: the wizard is left as it was, the pool untouched.
    await confirm.getByText('Cancel', { exact: true }).click()
    await expect(confirm).toBeHidden({ timeout: 20_000 })
    await win.getByText('Cancel', { exact: true }).click()
  })
})
