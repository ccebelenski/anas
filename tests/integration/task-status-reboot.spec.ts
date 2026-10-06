import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { poolExists, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * taskstatus.1 — the last run and its verdict survive a reboot.
 *
 * systemd keeps no service runtime property across a boot, so before the fix
 * every scheduled row read "never run" after the node rebooted. Proven here on
 * the stunt node by REBOOTING it:
 *
 *   - a snapshot schedule on the baseline `gtbackup` pool (monthly,
 *     retention monthly:1, ENABLED — a disabled row with no live record reads
 *     `disabled` by design; the monthly timer's next elapse is the 1st, so it
 *     does not fire on its own during the spec) is run
 *     THROUGH ITS UNIT (`systemctl start anas-snap-<id>.service`, exactly what
 *     its timer does — `POST /schedules/:id/run` runs the take in the daemon
 *     and leaves no unit history, so it cannot be the run a reboot is asked
 *     to remember);
 *   - a cloud sync task (the backup task's twin: the same task-units status
 *     path) over the cloud-tasks fixture's sftp user is run through its unit
 *     with the API's Run Now (which goes through the unit by design);
 *   - both rows are read, the node is rebooted, and after it answers again
 *     both rows still show `success` at the same last-run time (to within the
 *     journal's one-second stamp: before the reboot the time may come from the
 *     service's exit timestamp, after it from the runner's result line).
 *
 * A BACKUP task needs a PBS repository, which the stunt node does not carry;
 * the backup half is covered by the shared derivation's unit tests (backup and
 * cloud share deriveTaskStatus) and by this spec's cloud half.
 *
 * The reboot drops the pvepool fixture's loop devices; when the fixture was
 * up before the reboot, afterAll runs `test/stunt-node/pvepool-fixture.sh up`
 * again (one retry on a stale non-empty mountpoint).
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`
const POOL = 'gtbackup'
const SCHED_ID = 'taskstatus-reboot'
const REMOTE = 'tsreboot'
const TASK = 'tsreboot'
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-tasks-fixture.sh', import.meta.url).pathname
const PVEPOOL_FIXTURE_SH = new URL('../../test/stunt-node/pvepool-fixture.sh', import.meta.url).pathname
/** The pvepool fixture's pool — its loop devices do not survive the reboot. */
const PVEPOOL = 'pvfix'
/** A future absolute date — the timer has nothing to catch up on (SCHEDULES-GT-21). */
const FAR_SCHEDULE = '2030-01-01 00:00:00'

interface Row { lastRunResult: string, lastRunAt: string | null, lastRunNote?: string }

function authed(playwright: PlaywrightWorkerArgs['playwright'], ticket: string): Promise<APIRequestContext> {
  return playwright.request.newContext({ ignoreHTTPSErrors: true, storageState: pveAuthState(ticket), timeout: 120_000 })
}

async function awaitJob(ctx: APIRequestContext, id: string, timeout = 180_000): Promise<{ status: string, error?: { message?: string } | null }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${id}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${id} still '${job.status}' after ${timeout}ms`)
    await new Promise(r => setTimeout(r, 500))
  }
}

async function runJob(ctx: APIRequestContext, verb: 'post' | 'delete', url: string, data?: unknown): Promise<void> {
  const res = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(res.status(), await res.text()).toBe(202)
  const job = await awaitJob(ctx, (await res.json()).job.id)
  expect(job.status, job.error?.message).toBe('completed')
}

/** Best-effort removal (404 is fine) — used before and after. */
async function removeQuietly(ctx: APIRequestContext, url: string): Promise<void> {
  const res = await ctx.delete(url)
  if (res.status() === 202)
    await awaitJob(ctx, (await res.json()).job.id).catch(() => undefined)
}

async function scheduleRow(ctx: APIRequestContext): Promise<Row> {
  const res = await ctx.get(`${V1}/schedules/${SCHED_ID}`)
  expect(res.status()).toBe(200)
  return (await res.json()).data as Row
}

async function cloudRow(ctx: APIRequestContext): Promise<Row> {
  const res = await ctx.get(`${V1}/cloud/tasks`)
  expect(res.status()).toBe(200)
  const row = (await res.json()).data.find((t: { name: string }) => t.name === TASK)
  expect(row, `cloud task ${TASK} listed`).toBeTruthy()
  return row as Row
}

function within(a: string | null, b: string | null, ms: number): boolean {
  if (!a || !b)
    return false
  return Math.abs(Date.parse(a) - Date.parse(b)) <= ms
}

async function ticketFor(playwright: PlaywrightWorkerArgs['playwright']): Promise<string> {
  const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
  const res = await login.post(`${PVE_URL}/api2/json/access/ticket`, { form: { username: 'root@pam', password: 'anas-test' } })
  expect(res.ok()).toBeTruthy()
  const ticket = (await res.json()).data.ticket as string
  await login.dispose()
  return ticket
}

/**
 * Rebuild the pvepool fixture the reboot dropped. A stale mountpoint left by
 * the vanished pool can make the first `up` fail on a non-empty mountpoint;
 * the script clears it on the way out, so one retry is the cure.
 */
async function restorePvepoolFixture(): Promise<void> {
  try {
    await execFileAsync(PVEPOOL_FIXTURE_SH, ['up'], { timeout: 300_000 })
  }
  catch (err) {
    const text = err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err)
    if (!/not empty|non-empty|mountpoint/i.test(text))
      throw err
    console.warn(`pvepool fixture up failed on a mountpoint, retrying once: ${text.split('\n')[0]}`)
    await execFileAsync(PVEPOOL_FIXTURE_SH, ['up'], { timeout: 300_000 })
  }
}

/** Reboot the node and wait until ssh answers again and the daemon serves through the gateway. */
async function rebootAndWait(ctx: APIRequestContext): Promise<void> {
  const bootBefore = await sshExec('cat /proc/sys/kernel/random/boot_id')
  await sshExec('systemctl reboot').catch(() => undefined)
  // Down first (so the "up" below is the NEW boot), then up — up to 5 minutes.
  const deadline = Date.now() + 5 * 60_000
  let bootAfter = bootBefore
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000))
    try {
      bootAfter = await sshExec('cat /proc/sys/kernel/random/boot_id')
      if (bootAfter !== bootBefore)
        break
    }
    catch {
      // Still down.
    }
  }
  expect(bootAfter, 'the node came back on a new boot within 5 minutes').not.toBe(bootBefore)
  // The daemon through the gateway (pveproxy → anas → anasd).
  await expect.poll(async () => {
    try {
      return (await ctx.get(`${V1}/schedules`, { timeout: 10_000 })).status()
    }
    catch {
      return 0
    }
  }, { timeout: 4 * 60_000, intervals: [5000] }).toBe(200)
}

test.describe('taskstatus.1 — last run and verdict survive a reboot (stunt node)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(15 * 60_000)

  let ctx: APIRequestContext
  const before: { schedule?: Row, cloud?: Row } = {}
  /** Was the pvepool fixture up before the reboot? Then afterAll rebuilds it. */
  let pvepoolWasUp = false

  test.beforeAll(async ({ playwright }) => {
    skipIfFixtureMissing(!(await poolExists(POOL)), `baseline pool ${POOL} not present`)
    pvepoolWasUp = await poolExists(PVEPOOL)
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 300_000 })
    await execFileAsync(FIXTURE_SH, ['up'], { timeout: 300_000 })
    ctx = await authed(playwright, await ticketFor(playwright))
    await removeQuietly(ctx, `${V1}/schedules/${SCHED_ID}`)
    await removeQuietly(ctx, `${V1}/cloud/tasks/${TASK}`)
    await removeQuietly(ctx, `${V1}/cloud/remotes/${REMOTE}`)
  })

  test.afterAll(async () => {
    if (ctx) {
      await removeQuietly(ctx, `${V1}/cloud/tasks/${TASK}`)
      await removeQuietly(ctx, `${V1}/cloud/remotes/${REMOTE}`)
      await removeQuietly(ctx, `${V1}/schedules/${SCHED_ID}`)
      await sshExec(`zfs list -H -o name -t snapshot -d 1 ${POOL} | grep '@anas-monthly-' | xargs -r -n1 zfs destroy || true`).catch(() => undefined)
      await ctx.dispose()
    }
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 300_000 }).catch((err) => {
      console.error(`cloud tasks fixture down failed: ${err instanceof Error ? err.message : err}`)
    })
    // The reboot dropped the pvepool fixture's loop devices: put back what
    // was there, so the next spec does not meet a missing fixture.
    if (pvepoolWasUp && !(await poolExists(PVEPOOL)))
      await restorePvepoolFixture()
  })

  test('a snapshot schedule and a cloud task each run once through their units', async () => {
    await runJob(ctx, 'post', `${V1}/schedules`, {
      id: SCHED_ID,
      name: 'taskstatus reboot proof',
      target: { kind: 'zfs', dataset: POOL },
      cadence: 'monthly',
      retention: { monthly: 1 },
      enabled: true,
    })
    // What the timer does: start the oneshot (blocks until it exits).
    await sshExec(`systemctl start anas-snap-${SCHED_ID}.service`)
    before.schedule = await scheduleRow(ctx)
    expect(before.schedule.lastRunResult).toBe('success')
    expect(before.schedule.lastRunAt).not.toBeNull()

    await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
      name: REMOTE,
      type: 'sftp',
      options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' },
    })
    await runJob(ctx, 'post', `${V1}/cloud/tasks`, {
      name: TASK,
      source: '/gtbackup/cloudsrc',
      remote: REMOTE,
      path: 'dst/tsreboot',
      mode: 'copy',
      schedule: FAR_SCHEDULE,
      notify: 'on-failure',
      enabled: true,
    })
    await runJob(ctx, 'post', `${V1}/cloud/tasks/${TASK}/run`, {})
    before.cloud = await cloudRow(ctx)
    expect(before.cloud.lastRunResult).toBe('success')
    expect(before.cloud.lastRunAt).not.toBeNull()
    console.warn(`before reboot: schedule ${JSON.stringify(before.schedule)}; cloud ${JSON.stringify({ lastRunResult: before.cloud.lastRunResult, lastRunAt: before.cloud.lastRunAt })}`)
  })

  test('after a reboot both rows still show the run and its verdict', async () => {
    expect(before.schedule && before.cloud, 'the first test recorded both rows').toBeTruthy()
    // Before the fix this is exactly where the rows went blank: the service
    // properties are empty on the new boot.
    await rebootAndWait(ctx)
    const props = await sshExec(`systemctl show anas-snap-${SCHED_ID}.service anas-cloud-${TASK}.service -p ExecMainExitTimestamp`)
    expect(props.split('\n').filter(l => l.trim() !== '').every(l => l.trim() === 'ExecMainExitTimestamp='), `post-reboot service props are empty: ${props}`).toBe(true)

    const schedule = await scheduleRow(ctx)
    const cloud = await cloudRow(ctx)
    console.warn(`after reboot: schedule ${JSON.stringify({ lastRunResult: schedule.lastRunResult, lastRunAt: schedule.lastRunAt })}; cloud ${JSON.stringify({ lastRunResult: cloud.lastRunResult, lastRunAt: cloud.lastRunAt })}`)

    expect(schedule.lastRunResult).toBe('success')
    expect(within(schedule.lastRunAt, before.schedule!.lastRunAt, 5000), `${schedule.lastRunAt} ≈ ${before.schedule!.lastRunAt}`).toBe(true)
    expect(cloud.lastRunResult).toBe('success')
    expect(within(cloud.lastRunAt, before.cloud!.lastRunAt, 5000), `${cloud.lastRunAt} ≈ ${before.cloud!.lastRunAt}`).toBe(true)
  })
})
