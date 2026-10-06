import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { datasetExists, poolExists, releaseHolds, skipIfFixtureMissing, sshExec } from './fixtures/stunt-node'

/**
 * snapx.1 (GitHub #71) — the exclude list on a recursive schedule, proven at
 * the API over the pvepool.1 fixture (`test/stunt-node/pvepool-fixture.sh up`):
 *
 *   - the guard: a recursive schedule over a tree with a nested PVE storage
 *     root is refused and the refusal names the owned descendant and says it
 *     can be excluded; the same schedule WITH that root excluded is accepted;
 *   - the fire: one run snapshots the target and the kept sibling, and NOT the
 *     excluded child, its grandchild, or the excluded storage root;
 *   - prune: a second and third run complete (retention hourly:1) — the
 *     excluded datasets lacking the snapshot never make the prune fail;
 *   - validation: a non-descendant exclude and an exclude on a non-recursive
 *     schedule are both 400s that name the problem;
 *   - snapprune.1: retention reaches every dataset the schedule snapshots —
 *     the kept sibling converges to the policy count like the target, and
 *     hand-seeded droppings (older `anas-hourly-*` taken with `-r` across the
 *     whole tree, stamped `anas:schedule=<this id>` as the schedule's own
 *     takes are since ident.1) are cleared from the excluded child and its
 *     grandchild, while a held sibling snapshot survives and is reported; the
 *     excluded PVE-owned storage root is cleared of them too (they are ANAS's
 *     own leftovers, proven by the stamp).
 *
 * The nested storage root (`pvfix/media/guests`, registered with pvesm for the
 * duration of the spec) is the #71 shape: a pool carrying ANAS datasets and
 * guest storage under one hourly schedule.
 */

const PVE_POOL = 'pvfix'
const TARGET = 'pvfix/media'
const CHILD = 'pvfix/media/child'
const GRANDCHILD = 'pvfix/media/child/sub'
const SIBLING = 'pvfix/media/keep'
const NESTED_ROOT = 'pvfix/media/guests'
const NESTED_STORAGE = 'snapxguests'
const SCHED_ID = 'snapx-api-proof'
// snapprune.1 droppings: older names than any real fire (`anas-<bucket>-<utc>`,
// formatScheduledName's one-second UTC stamp).
const OLD_A = 'anas-hourly-2026-01-01T000000Z'
const OLD_B = 'anas-hourly-2026-01-01T010000Z'
const HOLD_TAG = 'snapprune-proof'
/** A replication target under the excluded child (C11 provenance proof). */
const REPLICA = `${CHILD}/replica`
const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

interface RunDatasetCounts { dataset: string, scope: string, pruned: number, held: number, note?: string }
interface JobRes {
  job: {
    id: string
    status: string
    error?: { message?: string } | string
    result?: { taken?: string, pruned?: string[], skippedHeld?: string[], datasets?: RunDatasetCounts[] }
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
  }, { timeout: 60_000 }).toMatch(/completed|failed/)
  return last!
}

async function deleteSchedule(ctx: APIRequestContext): Promise<void> {
  const res = await ctx.delete(`${V1}/schedules/${SCHED_ID}`)
  expect([202, 404]).toContain(res.status())
  if (res.status() === 202) {
    const { job } = await res.json() as JobRes
    await waitJob(ctx, job.id)
  }
}

function scheduleBody(extra: Record<string, unknown>) {
  return {
    id: SCHED_ID,
    name: 'snapx api proof',
    target: { kind: 'zfs', dataset: TARGET },
    cadence: 'hourly',
    retention: { hourly: 1 },
    enabled: false,
    ...extra,
  }
}

/** `anas-*` snapshot names on ONE dataset (not its children). */
async function anasSnapshots(dataset: string): Promise<string[]> {
  const out = await sshExec(`zfs list -H -o name -t snapshot -d 1 ${dataset} 2>/dev/null || true`)
  return out.split('\n').map(l => l.trim()).filter(l => l.includes('@anas-')).map(l => l.split('@')[1])
}

async function destroyAnasSnapshotsUnder(dataset: string): Promise<void> {
  await sshExec(`zfs list -H -o name -t snapshot -r ${dataset} 2>/dev/null | grep '@anas-' | xargs -r -n1 zfs destroy || true`)
}

async function storageRegistered(id: string): Promise<boolean> {
  const out = await sshExec(`grep -cE '^[a-z]+: ${id}$' /etc/pve/storage.cfg || true`)
  return out.trim() !== '0' && out.trim() !== ''
}

test.describe('snapx.1 — exclude on a recursive schedule, through the API (stunt node fixture)', () => {
  test.describe.configure({ mode: 'serial' })
  let ctx: APIRequestContext

  test.beforeAll(async ({ playwright, pveTicket }) => {
    skipIfFixtureMissing(
      !(await poolExists(PVE_POOL)) || !(await datasetExists(CHILD)),
      'pvepool fixture not present — run test/stunt-node/pvepool-fixture.sh up',
    )
    ctx = await authed(playwright, pveTicket)
    await deleteSchedule(ctx)
    // Another ENABLED schedule on the node changes what this spec proves
    // (snapprune.1 judges swept and excluded datasets by every enabled
    // same-bucket schedule, and a timer firing mid-spec takes and prunes on
    // its own) — refuse to run on such a node rather than prove something else.
    const list = await ctx.get(`${V1}/schedules`)
    expect(list.status()).toBe(200)
    const rows = ((await list.json()) as { data: { schedule: { id: string, enabled: boolean } }[] }).data
    const others = rows.filter(r => r.schedule.enabled && r.schedule.id !== SCHED_ID).map(r => r.schedule.id)
    expect(others, `other enabled snapshot schedules on the node: ${others.join(', ')}`).toEqual([])
    if (await datasetExists(REPLICA))
      await sshExec(`zfs destroy -r ${REPLICA}`)
    for (const ds of [GRANDCHILD, SIBLING, NESTED_ROOT]) {
      if (!(await datasetExists(ds)))
        await sshExec(`zfs create ${ds}`)
    }
    if (!(await storageRegistered(NESTED_STORAGE)))
      await sshExec(`pvesm add zfspool ${NESTED_STORAGE} --pool ${NESTED_ROOT} --content images`)
    await destroyAnasSnapshotsUnder(TARGET)
  })

  test.afterAll(async () => {
    if (!ctx)
      return
    await releaseHolds(SIBLING)
    await deleteSchedule(ctx)
    await ctx.dispose()
    if (await storageRegistered(NESTED_STORAGE))
      await sshExec(`pvesm remove ${NESTED_STORAGE}`)
    await destroyAnasSnapshotsUnder(TARGET)
    for (const ds of [REPLICA, GRANDCHILD, SIBLING, NESTED_ROOT]) {
      if (await datasetExists(ds))
        await sshExec(`zfs destroy -r ${ds}`)
    }
  })

  test('a recursive schedule over a nested storage root is refused and told to exclude it', async () => {
    const res = await ctx.post(`${V1}/schedules`, { data: scheduleBody({ recursive: true }) })
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain(NESTED_ROOT)
    expect(body.error.message).toMatch(/[Ee]xclude/)
  })

  test('exclude on a non-recursive schedule, and a non-descendant exclude, are 400s that name the problem', async () => {
    const flat = await ctx.post(`${V1}/schedules`, { data: scheduleBody({ exclude: [CHILD] }) })
    expect(flat.status()).toBe(400)
    expect(((await flat.json()) as { error: { message: string } }).error.message).toMatch(/recursive/i)

    const stranger = await ctx.post(`${V1}/schedules`, { data: scheduleBody({ recursive: true, exclude: ['pvfix/dump'] }) })
    expect(stranger.status()).toBe(400)
    expect(((await stranger.json()) as { error: { message: string } }).error.message).toContain('pvfix/dump')
  })

  test('the same schedule with the storage root and one child excluded is accepted', async () => {
    const res = await ctx.post(`${V1}/schedules`, {
      data: scheduleBody({ recursive: true, exclude: [NESTED_ROOT, CHILD] }),
    })
    expect(res.status()).toBe(202)
    const { job } = await res.json() as JobRes
    const done = await waitJob(ctx, job.id)
    expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')

    const detail = await ctx.get(`${V1}/schedules/${SCHED_ID}`)
    expect(detail.status()).toBe(200)
    const text = await detail.text()
    expect(text).toContain(NESTED_ROOT)
    expect(text).toContain(CHILD)
  })

  test('one run snapshots the target and the kept sibling only', async () => {
    const res = await ctx.post(`${V1}/schedules/${SCHED_ID}/run`)
    expect(res.status()).toBe(202)
    const { job } = await res.json() as JobRes
    const done = await waitJob(ctx, job.id)
    expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')

    const onTarget = await anasSnapshots(TARGET)
    expect(onTarget).toHaveLength(1)
    expect(onTarget[0]).toMatch(/^anas-hourly-/)
    expect(await anasSnapshots(SIBLING)).toEqual(onTarget)
    expect(await anasSnapshots(CHILD)).toEqual([])
    expect(await anasSnapshots(GRANDCHILD)).toEqual([])
    expect(await anasSnapshots(NESTED_ROOT)).toEqual([])
  })

  test('two more runs complete and prune the target to its retention (excluded datasets never block the prune)', async () => {
    for (let i = 0; i < 2; i++) {
      // The name stamp is one-second resolution; never fire twice in one second.
      await new Promise(r => setTimeout(r, 1500))
      const res = await ctx.post(`${V1}/schedules/${SCHED_ID}/run`)
      expect(res.status()).toBe(202)
      const { job } = await res.json() as JobRes
      const done = await waitJob(ctx, job.id)
      expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')
    }
    expect(await anasSnapshots(TARGET)).toHaveLength(1)
    expect(await anasSnapshots(CHILD)).toEqual([])
    expect(await anasSnapshots(NESTED_ROOT)).toEqual([])
    // snapprune.1: the kept sibling converges like the target (hourly:1).
    expect(await anasSnapshots(SIBLING)).toEqual(await anasSnapshots(TARGET))
  })

  test('snapprune.1: one run clears droppings on excluded datasets, converges the sibling, keeps a held snapshot', async () => {
    // Droppings: what a recursive schedule left before the exclude (and before
    // snapprune.1) — one `zfs snapshot -r` per stamp across the WHOLE tree,
    // excluded child, grandchild and the nested storage root included, each
    // stamped with this schedule's id as its own takes are (ident.1).
    await sshExec(`zfs snapshot -r -o anas:schedule=${SCHED_ID} ${TARGET}@${OLD_A}`)
    await sshExec(`zfs snapshot -r -o anas:schedule=${SCHED_ID} ${TARGET}@${OLD_B}`)
    await sshExec(`zfs hold ${HOLD_TAG} ${SIBLING}@${OLD_A}`)
    // What the earlier runs left (retention hourly:1) plus the two droppings.
    const targetBefore = (await anasSnapshots(TARGET)).length
    const siblingBefore = (await anasSnapshots(SIBLING)).length
    try {
      await new Promise(r => setTimeout(r, 1500))
      const res = await ctx.post(`${V1}/schedules/${SCHED_ID}/run`)
      expect(res.status()).toBe(202)
      const { job } = await res.json() as JobRes
      const done = await waitJob(ctx, job.id)
      expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')
      const taken = done.result?.taken ?? ''
      expect(taken).toMatch(/^anas-hourly-/)

      // Target and sibling: exactly the retention count (the run's own
      // snapshot) — plus, on the sibling, the held dropping.
      expect(await anasSnapshots(TARGET)).toEqual([taken])
      expect((await anasSnapshots(SIBLING)).sort()).toEqual([OLD_A, taken].sort())
      // Excluded child and its grandchild: cleared.
      expect(await anasSnapshots(CHILD)).toEqual([])
      expect(await anasSnapshots(GRANDCHILD)).toEqual([])
      // The PVE-owned excluded storage root: our own (stamped) leftovers are cleared too.
      expect(await anasSnapshots(NESTED_ROOT)).toEqual([])

      // The result reports it per dataset; the held one is named.
      expect(done.result?.skippedHeld).toContain(`${SIBLING}@${OLD_A}`)
      const counts = done.result?.datasets ?? []
      const of = (ds: string) => counts.find(d => d.dataset === ds)
      // Everything but the run's own snapshot goes; on the sibling, the held one stays.
      expect(of(TARGET)).toMatchObject({ scope: 'target', pruned: targetBefore, held: 0 })
      expect(of(SIBLING)).toMatchObject({ scope: 'sweep', pruned: siblingBefore - 1, held: 1 })
      expect(of(CHILD)).toMatchObject({ scope: 'excluded', pruned: 2, held: 0 })
      expect(of(GRANDCHILD)).toMatchObject({ scope: 'excluded', pruned: 2, held: 0 })
      expect(of(NESTED_ROOT)).toMatchObject({ scope: 'excluded', pruned: 2, held: 0 })
      expect(of(NESTED_ROOT)?.note).toBeUndefined()
    }
    finally {
      await releaseHolds(SIBLING)
      await sshExec(`zfs list -H -o name -t snapshot -r ${NESTED_ROOT} 2>/dev/null | grep '@anas-hourly-2026-01-01T' | xargs -r -n1 zfs destroy || true`)
    }
  })

  test('provenance: a RECEIVED snapshot carrying the schedule\'s name on an excluded dataset survives, noted', async () => {
    // A replica of the kept sibling, received under the excluded child: its
    // snapshot has this schedule's name, and `zfs send -p` carries the
    // `anas:schedule` stamp with it — this schedule's own id, but with property
    // source `received`. Only a LOCAL stamp is ours (ident.1 follow-up), so it
    // is left and noted as received.
    const sibling = (await anasSnapshots(SIBLING)).filter(n => !n.startsWith('anas-hourly-2026-01-01T')).sort()
    const snap = sibling.at(-1)
    expect(snap, 'the sibling carries a snapshot this schedule took').toBeTruthy()
    await sshExec(`zfs send -p ${SIBLING}@${snap} | zfs recv ${REPLICA}`)
    try {
      const props = async (full: string) => (await sshExec(`zfs get -Hp -o value createtxg,creation ${full}`)).split('\n')
      const [srcTxg, srcCreation] = await props(`${SIBLING}@${snap}`)
      const [rcvTxg, rcvCreation] = await props(`${REPLICA}@${snap}`)
      console.warn(`provenance: ${SIBLING}@${snap} createtxg=${srcTxg} creation=${srcCreation}; ${REPLICA}@${snap} createtxg=${rcvTxg} creation=${rcvCreation}`)
      expect(rcvTxg).not.toBe(srcTxg)

      await new Promise(r => setTimeout(r, 1500))
      const res = await ctx.post(`${V1}/schedules/${SCHED_ID}/run`)
      expect(res.status()).toBe(202)
      const { job } = await res.json() as JobRes
      const done = await waitJob(ctx, job.id)
      expect(done.status, JSON.stringify(done.error ?? '')).toBe('completed')

      expect(await anasSnapshots(REPLICA)).toEqual([snap])
      const entry = (done.result?.datasets ?? []).find(d => d.dataset === REPLICA)
      expect(entry, JSON.stringify(done.result?.datasets)).toMatchObject({ scope: 'excluded', pruned: 0, held: 0 })
      expect(entry?.note).toMatch(/1 left: received/)
      const [value, source] = (await sshExec(`zfs get -H -o value,source anas:schedule ${REPLICA}@${snap}`)).split('\t')
      expect(value).toBe(SCHED_ID)
      expect(source.trim()).toBe('received')
    }
    finally {
      if (await datasetExists(REPLICA))
        await sshExec(`zfs destroy -r ${REPLICA}`)
    }
  })
})
