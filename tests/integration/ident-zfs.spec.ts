import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { datasetExists, poolExists, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

/**
 * Story ident.1 (audit #1 #2 #11 #12 #20) — LIVE proof on the stunt node,
 * through the API (PVEAuthCookie → gateway → anasd → real zfs):
 *
 *   1. a schedule take leaves `anas:schedule=<id>` (source local) on EVERY
 *      snapshot it created — the recursive take's child included;
 *   2. two schedules on one dataset (presets standard: hourly cadence 36h/30d/12m,
 *      and minimal: daily cadence 7d/4w) each prune only their own stamped
 *      snapshots and keep the other's buckets after both run;
 *   3. a pool destroy is challenged, the pool is exported and another pool
 *      takes its name (loop-backed) → the confirmed resend is 409
 *      IDENTITY_MISMATCH naming both guids, and nothing is destroyed;
 *   4. an EXISTING dataset named `<pool>/snapshots/x` is destroyed as that
 *      dataset (confirm-gated), never as `<pool>@x` — and a NEW dataset with a
 *      reserved segment is refused 400;
 *   5. pool destroy with "Clean up disks" on a pool whose only leaf is a loop
 *      partition addressed by-partuuid wipes only that partition: the other
 *      partition on the same loop disk keeps its ext4 signature and the GPT
 *      stays (the disk is shared, so it is never zapped).
 *
 * Preconditions: `testpool` (setup-test-data.sh); `losetup`, `sgdisk`,
 * `mkfs.ext4`, `blkid`, `udevadm` on the node (stock PVE); udev publishes
 * `/dev/disk/by-partuuid/*` for loop partitions. Everything here is created by
 * the spec (datasets under `testpool/ident1*`, loop images under /var/tmp,
 * pools `identswap` and `identpart`, schedules `ident1-*`, all DISABLED so no
 * timer fires mid-spec — a Run Now works on a disabled schedule) and torn down
 * in afterAll.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`
const POOL = 'testpool'
const DS = 'testpool/ident1'
const CHILD = 'testpool/ident1/child'
const PAIR = 'testpool/ident1pair'
const LEGACY_PARENT = 'testpool/snapshots'
const LEGACY = 'testpool/snapshots/x'
const SWAP_POOL = 'identswap'
const PART_POOL = 'identpart'
const IMG = '/var/tmp/ident1'
const SCHED_TAKE = 'ident1-take'
const SCHED_STD = 'ident1-std'
const SCHED_MIN = 'ident1-min'

interface JobRes {
  job: {
    id: string
    status: string
    error?: { code?: string, message?: string } | null
    result?: Record<string, unknown> & { taken?: string, pruned?: string[], prunedCount?: number }
  }
}

function authed(playwright: PlaywrightWorkerArgs['playwright'], ticket: string): Promise<APIRequestContext> {
  return playwright.request.newContext({ ignoreHTTPSErrors: true, storageState: pveAuthState(ticket) })
}

async function waitJob(ctx: APIRequestContext, id: string): Promise<JobRes['job']> {
  let last: JobRes['job'] | undefined
  await expect.poll(async () => {
    const r = await ctx.get(`${V1}/jobs/${id}`)
    last = ((await r.json()) as JobRes).job
    return last.status
  }, { timeout: 120_000 }).toMatch(/completed|failed/)
  return last!
}

async function accepted(ctx: APIRequestContext, res: APIResponse): Promise<JobRes['job']> {
  expect(res.status(), await res.text()).toBe(202)
  return waitJob(ctx, ((await res.json()) as JobRes).job.id)
}

async function deleteSchedule(ctx: APIRequestContext, id: string): Promise<void> {
  const res = await ctx.delete(`${V1}/schedules/${id}`)
  expect([202, 404]).toContain(res.status())
  if (res.status() === 202)
    await waitJob(ctx, ((await res.json()) as JobRes).job.id)
}

async function createSchedule(ctx: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const done = await accepted(ctx, await ctx.post(`${V1}/schedules`, { data: { enabled: false, ...body } }))
  expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')
}

async function runSchedule(ctx: APIRequestContext, id: string): Promise<JobRes['job']> {
  // The name stamp is one-second resolution; never fire twice in one second.
  await new Promise(r => setTimeout(r, 1500))
  const done = await accepted(ctx, await ctx.post(`${V1}/schedules/${id}/run`))
  expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')
  return done
}

/** `anas-*` snapshot labels on ONE dataset (not its children), sorted. */
async function anasSnapshots(dataset: string): Promise<string[]> {
  const out = await sshExec(`zfs list -H -o name -t snapshot -d 1 ${dataset} 2>/dev/null || true`)
  return out.split('\n').map(l => l.trim()).filter(l => l.includes('@anas-')).map(l => l.split('@')[1]).sort()
}

/** The confirm two-step for a DELETE: the challenge's code, then the resend. */
async function challenge(ctx: APIRequestContext, url: string): Promise<string> {
  const first = await ctx.delete(url)
  expect(first.status(), await first.text()).toBe(409)
  const code = first.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  return code
}

/** Tear down a loop-backed pool (imported or not), its loop devices and images. Never throws. */
async function teardownLoops(): Promise<void> {
  const script = [
    `for p in ${SWAP_POOL} ${PART_POOL}; do zpool list "$p" >/dev/null 2>&1 && zpool destroy -f "$p"; done`,
    `for f in ${IMG}-*.img; do`,
    `  [ -e "$f" ] || continue`,
    `  for l in $(losetup -j "$f" -O NAME -n 2>/dev/null); do`,
    `    for part in "$l" "$l"p1 "$l"p2; do [ -b "$part" ] && zpool labelclear -f "$part" 2>/dev/null; done`,
    `    losetup -d "$l" 2>/dev/null`,
    `  done`,
    `  rm -f "$f"`,
    `done`,
    'true',
  ].join('\n')
  try {
    await sshExec(script)
  }
  catch {
    // best-effort
  }
}

/** A fresh loop device over a sparse image; `-P` so partitions get nodes. */
async function loopDevice(name: string, size: string): Promise<string> {
  const dev = (await sshExec(`truncate -s ${size} ${IMG}-${name}.img && losetup -fP --show ${IMG}-${name}.img`)).trim()
  expect(dev).toMatch(/^\/dev\/loop\d+$/)
  return dev
}

test.describe('ident.1 — ZFS ownership stamps, stable-id confirms, wipe-by-identity, reserved names (stunt node)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  let ctx: APIRequestContext

  test.beforeAll(async ({ playwright, pveTicket }) => {
    skipIfFixtureMissing(!(await poolExists(POOL)), 'testpool not present — run setup-test-data.sh')
    ctx = await authed(playwright, pveTicket)
    for (const id of [SCHED_TAKE, SCHED_STD, SCHED_MIN])
      await deleteSchedule(ctx, id)
    for (const ds of [DS, PAIR, LEGACY_PARENT]) {
      if (await datasetExists(ds))
        await sshExec(`zfs destroy -r ${ds}`)
    }
    await sshExec(`zfs destroy ${POOL}@x 2>/dev/null || true`)
    await teardownLoops()
  })

  test.afterAll(async () => {
    if (!ctx)
      return
    for (const id of [SCHED_TAKE, SCHED_STD, SCHED_MIN])
      await deleteSchedule(ctx, id)
    await ctx.dispose()
    for (const ds of [DS, PAIR, LEGACY_PARENT]) {
      if (await datasetExists(ds))
        await sshExec(`zfs destroy -r ${ds}`)
    }
    await sshExec(`zfs destroy ${POOL}@x 2>/dev/null || true`)
    await teardownLoops()
  })

  test('1. a schedule take stamps anas:schedule=<id> (source local) on every snapshot it created', async () => {
    await sshExec(`zfs create -p ${CHILD}`)
    await createSchedule(ctx, {
      id: SCHED_TAKE,
      name: 'ident1 take',
      target: { kind: 'zfs', dataset: DS },
      cadence: 'hourly',
      retention: { hourly: 5 },
      recursive: true,
    })
    const done = await runSchedule(ctx, SCHED_TAKE)
    const taken = done.result?.taken ?? ''
    expect(taken).toMatch(/^anas-hourly-/)
    for (const ds of [DS, CHILD]) {
      const [value, source] = (await sshExec(`zfs get -H -o value,source anas:schedule ${ds}@${taken}`)).split('\t')
      expect(value, ds).toBe(SCHED_TAKE)
      expect(source, ds).toBe('local')
    }
    // The dataset itself carries no stamp — the property lives on the snapshots only.
    expect((await sshExec(`zfs get -H -o value anas:schedule ${DS}`)).trim()).toBe('-')
  })

  test('2. two schedules on one dataset (standard + minimal) each keep the other\'s buckets', async () => {
    await sshExec(`zfs create ${PAIR}`)
    // Seeds, as each schedule's earlier takes would have left them (stamped,
    // names older than any real fire): 40 standard hourlies, 9 minimal dailies.
    const hours = Array.from({ length: 40 }, (_, i) => `anas-hourly-2026-01-0${1 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}0000Z`)
    const days = Array.from({ length: 9 }, (_, i) => `anas-daily-2026-01-${String(10 + i).padStart(2, '0')}T000000Z`)
    await sshExec([
      `for s in ${hours.join(' ')}; do zfs snapshot -o anas:schedule=${SCHED_STD} ${PAIR}@$s; done`,
      `for s in ${days.join(' ')}; do zfs snapshot -o anas:schedule=${SCHED_MIN} ${PAIR}@$s; done`,
    ].join('\n'))
    await createSchedule(ctx, {
      id: SCHED_STD,
      name: 'ident1 standard',
      target: { kind: 'zfs', dataset: PAIR },
      cadence: 'hourly',
      retention: { hourly: 36, daily: 30, monthly: 12 },
    })
    await createSchedule(ctx, {
      id: SCHED_MIN,
      name: 'ident1 minimal',
      target: { kind: 'zfs', dataset: PAIR },
      cadence: 'daily',
      retention: { daily: 7, weekly: 4 },
    })

    // Minimal first: before ident.1 its "keep 0" for the absent hourly bucket
    // erased every standard hourly but the newest.
    const min = await runSchedule(ctx, SCHED_MIN)
    const afterMin = await anasSnapshots(PAIR)
    for (const h of hours)
      expect(afterMin, `standard's ${h} survives the minimal run`).toContain(h)
    // Minimal pruned its own: 9 seeded + the new take, keep 7 → the 3 oldest.
    expect(min.result?.prunedCount).toBe(3)
    for (const d of days.slice(0, 3))
      expect(afterMin).not.toContain(d)

    const std = await runSchedule(ctx, SCHED_STD)
    const afterStd = await anasSnapshots(PAIR)
    // Standard pruned its own: 40 seeded + the new take, keep 36 → the 5 oldest.
    expect(std.result?.prunedCount).toBe(5)
    for (const h of hours.slice(0, 5))
      expect(afterStd).not.toContain(h)
    // …and kept every one of minimal's dailies (its daily:30 never reaches another schedule's stamp).
    for (const d of [...days.slice(3), String(min.result?.taken)])
      expect(afterStd, `minimal's ${d} survives the standard run`).toContain(d)
  })

  test('3. a pool swapped under the same name between challenge and resend → 409 IDENTITY_MISMATCH, nothing destroyed', async () => {
    const loopA = await loopDevice('swap-a', '256M')
    const loopB = await loopDevice('swap-b', '256M')
    await sshExec(`zpool create -f ${SWAP_POOL} ${loopA}`)
    const guidA = (await sshExec(`zpool get -H -o value guid ${SWAP_POOL}`)).trim()
    const url = `${V1}/pools/${SWAP_POOL}`
    const code = await challenge(ctx, url)

    // The swap: A leaves, another pool takes the name.
    await sshExec(`zpool export ${SWAP_POOL} && zpool create -f ${SWAP_POOL} ${loopB}`)
    const guidB = (await sshExec(`zpool get -H -o value guid ${SWAP_POOL}`)).trim()
    expect(guidB).not.toBe(guidA)

    const res = await ctx.delete(url, { headers: { 'x-anas-confirm': code } })
    expect(res.status()).toBe(409)
    const body = (await res.json()) as { error: { code: string, message: string } }
    expect(body.error.code).toBe('IDENTITY_MISMATCH')
    expect(body.error.message).toContain(`guid ${guidA}`)
    expect(body.error.message).toContain(`guid ${guidB}`)
    expect(res.headers()['x-anas-confirm-code'], 'a fresh code to confirm again').toBeTruthy()
    expect(await poolExists(SWAP_POOL), 'the namesake was not destroyed').toBe(true)
  })

  test('4. an existing dataset named <pool>/snapshots/x is destroyed as a dataset — <pool>@x survives; a new reserved name is 400', async () => {
    await sshExec(`zfs create -p ${LEGACY} && zfs snapshot ${POOL}@x`)
    const url = `${V1}/pools/${POOL}/datasets/snapshots/x`
    const code = await challenge(ctx, url)
    const done = await accepted(ctx, await ctx.delete(url, { headers: { 'x-anas-confirm': code } }))
    expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')
    expect(await datasetExists(LEGACY)).toBe(false)
    expect((await sshExec(`zfs list -H -o name -t snapshot ${POOL}@x 2>/dev/null || true`)).trim()).toBe(`${POOL}@x`)

    const refused = await ctx.post(`${V1}/pools/${POOL}/datasets`, { data: { path: 'ident1/snapshots' } })
    expect(refused.status()).toBe(400)
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/'snapshots' is reserved/)
  })

  test('5. destroy with cleanup on a by-partuuid leaf wipes only that partition; the sibling partition keeps its filesystem', async () => {
    const loop = await loopDevice('part', '512M')
    await sshExec(`sgdisk -n1:0:+200M -n2:0:0 ${loop} && partx -u ${loop} 2>/dev/null; udevadm settle; mkfs.ext4 -q -F ${loop}p2 && udevadm trigger ${loop}p1 && udevadm settle`)
    const partuuid = (await sshExec(`blkid -p -s PART_ENTRY_UUID -o value ${loop}p1 || lsblk -dno PARTUUID ${loop}p1`)).trim()
    expect(partuuid).toMatch(/^[0-9a-f-]{36}$/)
    const leaf = `/dev/disk/by-partuuid/${partuuid}`
    expect((await sshExec(`test -L ${leaf} && echo yes || echo no`)).trim(), 'udev published the by-partuuid link').toBe('yes')
    await sshExec(`zpool create -f ${PART_POOL} ${leaf}`)
    expect(await sshExec(`zpool status -P ${PART_POOL}`)).toContain(leaf)
    const guid = (await sshExec(`zpool get -H -o value guid ${PART_POOL}`)).trim()
    expect((await sshExec(`blkid -p -s UUID -o value ${leaf}`)).trim(), 'blkid reads the pool guid as UUID').toBe(guid)

    const url = `${V1}/pools/${PART_POOL}`
    const code = await challenge(ctx, url)
    const done = await accepted(ctx, await ctx.delete(`${url}?cleanup=true`, { headers: { 'x-anas-confirm': code } }))
    expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')
    const result = done.result as { wiped?: string[], zapped?: string[], preserved?: { disk: string, reason: string }[] }
    expect(result.wiped).toEqual([leaf])
    expect(result.zapped ?? []).toEqual([])
    expect(result.preserved).toEqual([{ disk: loop.replace('/dev/', ''), reason: 'shared' }])

    // p1: no ZFS label left; p2: still ext4; the GPT still has both partitions.
    expect((await sshExec(`blkid -p -s TYPE -o value ${loop}p1 || true`)).trim()).not.toBe('zfs_member')
    expect((await sshExec(`blkid -p -s TYPE -o value ${loop}p2`)).trim()).toBe('ext4')
    expect(await sshExec(`sgdisk -p ${loop}`)).toMatch(/^\s+2\s+/m)
  })
})
