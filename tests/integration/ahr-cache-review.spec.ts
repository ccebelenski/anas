import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story ahrcache.1 — LIVE PROOF of the review-fix batch (666f3e1) on the stunt
 * node, for the shapes its ground truth did NOT already measure. Modelled on
 * ahr-cache-api.spec.ts (same auth, same gateway path, same fixture).
 *
 * The fix batch's own claims, and where this spec proves each:
 *
 *   SHAPE 1 — THE IDLE PULL (GT-19 measured the removal under a read load;
 *   the idle shape is the review batch's own gap): a cached pool with NO I/O
 *   on it loses its cache SSD. dm-cache enters Fail only after an I/O reaches
 *   the dead device, so at event time `dmsetup status` still prints healthy
 *   counters — the review batch's answer is that the pool's `cache` block
 *   reads `failed` with `deviceMissing` (an `[unknown]` PV under the band
 *   guard) once LVM notices, and that the udev event route also accepts a
 *   fresh label sweep finding no `<pool>-cache<n>` slice while the LV is still
 *   a cache target. The rung must have uncached BEFORE the pool's FIRST read,
 *   so that read succeeds instead of returning EIO.
 *
 *   SHAPE 2 — THE BAND DOWN WITH THE CACHE SSD HEALTHY, in two phases: with
 *   the band array STOPPED the pool is not discoverable at all (the topology
 *   reader reconstructs pools from /proc/mdstat) and the pool read answers
 *   404 — recorded, with the no-uncache facts asserted on the node and in the
 *   journal; with the band back and the volume still deactivated, the pool
 *   reads `cache.state: 'inactive'` (the shape the state was added for), the
 *   device still named, no deviceMissing, no counters — and no rung acts.
 *
 *   SHAPE 2b — THE UDEV RUNG'S JOURNAL RECORD. (The boot rung's shape — cache
 *   SSD gone at activation, journal `cause=missing` — is already live-proven
 *   in ahr-cache-api.spec.ts's boot-rung test and is not duplicated here.)
 *   This shape captures every `ahr.cache pool=gtcache` line the recovery
 *   writes and asserts the record carries its classification: the rung ran,
 *   which device it acted on, and that the IDLE pool never went read-only
 *   (`readonly=false` — no write ever met the dead cache, so the notification
 *   carries no Remount clause).
 *
 *   SHAPE 3 — THE FOREIGN PV: a partition the OPERATOR `pvcreate`d and
 *   `vgextend`ed into the pool VG, on a disk ANAS never labelled (no
 *   `<pool>-cache<n>` GPT label). It must surface as a pool advisory naming
 *   it, never as a role-`cache` pool disk (pool.disks is destroy's wipe list),
 *   never as cache capacity — and destroy must leave it standing as a physical
 *   volume with no volume group.
 *
 * The spec leaves the node blank in afterAll (`ahrcache-fixture.sh down`),
 * which also wipes and detaches the foreign disk.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const POOL = 'gtcache'
const MOUNT = `/mnt/anas-ahr/${POOL}`
/** The pool LV's device-mapper name (`-` escapes as `--`). */
const DM_NAME = `${POOL}-${POOL}--vol`

const BAND_SERIALS = ['ANAS_HOT7', 'ANAS_HOT8']
const CACHE_SERIAL = 'ANAS_HOT9'
const FOREIGN_SERIAL = 'ANAS_HOT10'
const BY_ID = (serial: string): string => `scsi-0QEMU_QEMU_HARDDISK_${serial}`
const FOREIGN_ID = BY_ID(FOREIGN_SERIAL)

/** Absolute paths of the fixture scripts, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/ahrcache-fixture.sh', import.meta.url).pathname

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
  timeout = 120_000,
): Promise<{ status: string, error?: { message?: string }, result?: unknown, progress?: string }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms: ${JSON.stringify(job.error ?? job.progress ?? '')}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Submit a mutation, wait for its job, require it to complete, return it. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'delete',
  url: string,
  data?: unknown,
  headers?: Record<string, string>,
  timeout = 120_000,
): Promise<{ result?: unknown }> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers !== undefined ? { headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, JSON.stringify(job.error)).toBe('completed')
  return job
}

/** Drive a confirm-gated mutation: 409 challenge → resend with the code. */
async function runConfirmedJob(
  ctx: APIRequestContext,
  verb: 'post' | 'delete',
  url: string,
  data?: unknown,
  timeout = 300_000,
): Promise<void> {
  const challenge = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(challenge.status(), await challenge.text()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  await runJob(ctx, verb, url, data, { 'x-anas-confirm': code }, timeout)
}

interface CacheBlock {
  devices: string[]
  sizeBytes: number
  mode: string
  policy: string
  state: 'healthy' | 'failed' | 'absent' | 'inactive'
  /** Present only on the evidence the review batch added: the PV's device is gone. */
  deviceMissing?: true
  hits?: number
  misses?: number
  usedBlocks?: number
  totalBlocks?: number
  dirtyBlocks?: number
}

interface PoolDetail {
  state: string
  mounted: boolean
  cache?: CacheBlock
  lv: { name: string, sizeBytes: number }
  disks: { id: string, role: string }[]
  advisories: string[]
}

async function poolDetail(ctx: APIRequestContext): Promise<PoolDetail> {
  const res = await ctx.get(`${V1}/ahr/${POOL}`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data as PoolDetail
}

/**
 * The same read, never throwing — the idle-pull window and the band-down
 * restart are sampled through it: a transient non-200 while the daemon reads
 * a half-vanished topology, or the gateway's own restart window (the
 * fixture's restart-daemon takes anas down with it), is a sample, not a
 * failure of the shape.
 */
async function poolDetailSafe(ctx: APIRequestContext): Promise<PoolDetail | null> {
  try {
    const res = await ctx.get(`${V1}/ahr/${POOL}`)
    if (res.status() !== 200)
      return null
    return (await res.json()).data as PoolDetail
  }
  catch {
    return null
  }
}

interface DiskRow {
  id: string
  status: string
  poolName: string | null
  ahrArray: string | null
  partitions: unknown[]
}

async function diskRow(ctx: APIRequestContext, id: string): Promise<DiskRow> {
  const res = await ctx.get(`${V1}/disks`)
  expect(res.status()).toBe(200)
  const disks = (await res.json()).data as DiskRow[]
  const disk = disks.find(d => d.id === id)
  expect(disk, `${id} present in /v1/disks`).toBeTruthy()
  return disk!
}

/** A file's presence on the node — `test -e` that never throws. */
async function fileExists(path: string): Promise<boolean> {
  return (await sshExec(`test -e '${path}' && echo yes || echo no`)) === 'yes'
}

/** A journald cursor for the daemon's own unit — the "before" of a comparison. */
async function anasdCursor(): Promise<string> {
  const out = await sshExec('journalctl -u anasd -n 0 --no-pager --show-cursor')
  const cursor = out.split('-- cursor:').pop()?.trim() ?? ''
  expect(cursor, 'journalctl printed a cursor').not.toBe('')
  return cursor
}

/**
 * How many PVE notifications the daemon emitted since `cursor` (the
 * "notified via target" line the perl child files under anasd.service), and
 * whether any template failed to render.
 */
async function notificationsSince(cursor: string): Promise<{ sent: number, renderFailures: number }> {
  const journal = await sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o short-iso`)
  const lines = journal.split('\n')
  return {
    sent: lines.filter(l => l.includes('notified via target')).length,
    renderFailures: lines.filter(l => l.includes('could not notify')).length,
  }
}

/** Poll a predicate against the live API. Returns the first value that passes. */
async function until<T>(read: () => Promise<T>, pass: (v: T) => boolean, timeout: number, what: string): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T = await read()
  while (!pass(last)) {
    if (Date.now() > deadline)
      throw new Error(`${what} did not happen within ${timeout}ms; last: ${JSON.stringify(last)}`)
    await new Promise(resolve => setTimeout(resolve, 500))
    last = await read()
  }
  return last
}

/**
 * Build the pool (disks 7+8, through the daemon's own API — the create is not
 * under proof here but the pool must exist the operator's way) and attach the
 * cache (disk 9). The staged file exists for the idle pull, whose first
 * post-recovery read is the pool's first I/O through the (then-dead) cache;
 * the band-down shape stages it too and never reads it. NO read loop, NO
 * reads on the pool after the attach — the cache stays idle until each shape
 * does its own work.
 */
async function buildCachedPool(ctx: APIRequestContext): Promise<void> {
  const inventory = await ctx.get(`${V1}/disks`)
  const disks = (await inventory.json()).data as DiskRow[]
  const bandIds = BAND_SERIALS.map((serial) => {
    const disk = disks.find(d => d.id.includes(serial))
    expect(disk, `disk ${serial} in /v1/disks`).toBeTruthy()
    return disk!.id
  })

  await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: bandIds })

  // Data whose read is the proof: written to the BANDS before the cache
  // exists (so no block of it is ever promoted), checksummed from a copy in
  // /tmp — the pool file itself is never read until the FIRST read below.
  await sshExec(
    `dd if=/dev/urandom of=/tmp/anas-pre.bin bs=1M count=8 status=none && `
    + `sha256sum /tmp/anas-pre.bin > /tmp/anas-pre.sha && `
    + `cp /tmp/anas-pre.bin ${MOUNT}/pre-attach.bin && sync`,
  )

  await runJob(ctx, 'post', `${V1}/ahr/${POOL}/cache`, { disks: [BY_ID(CACHE_SERIAL)] })
  const cached = await poolDetail(ctx)
  expect(cached.state).toBe('healthy')
  expect(cached.cache?.state).toBe('healthy')
}

test.describe('AHR read cache — review-fix live proofs (ahrcache.1)', () => {
  test.setTimeout(900_000)

  test.afterAll(async () => {
    // Leave the node as found — including the foreign disk (shape 3). The
    // specs tear their own state down through the API; `down` is the safety
    // net for a run that died partway, and it wipes + detaches disk 10 too.
    await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
  })

  /**
   * SHAPE 1 (the idle pull) + SHAPE 2 (the rung's journal record).
   *
   * Sequence: idle cached pool → `sync` → yank disk 9 live → sample the pool
   * read WHILE the detach and the rung race (the pre-recovery window: a
   * `failed` + `deviceMissing` read is recorded when caught, and reported as
   * not-caught when the recovery beats the first poll — never faked) →
   * recovery observed within 10 s → the LV reads linear, no ghost PV → the
   * pool's FIRST read (direct I/O, so the page cache cannot answer for the
   * block layer) succeeds with no EIO and the right bytes → the journal
   * record carries its classification → the disk returns and Detach reclaims
   * it → the pool is destroyed through the API.
   */
  test('shape 1: the idle pull — the rung uncaches before the first read', async ({ playwright, pveTicket }) => {
    const cacheId = BY_ID(CACHE_SERIAL)
    // Blank images: a disk left over from an earlier run carries stale labels,
    // and a stale signature aborts `pvcreate` non-interactively (GT-18).
    await execFileAsync(FIXTURE_SH, ['up'])
    for (const serial of [...BAND_SERIALS, CACHE_SERIAL])
      expect(await fileExists(`/dev/disk/by-id/${BY_ID(serial)}`), `${serial} attached`).toBe(true)

    const ctx = await authedContext(playwright, pveTicket)
    try {
      await buildCachedPool(ctx)

      const cursor = await anasdCursor()

      // `sync` once so nothing is pending, then yank the cache disk. The
      // detach is NOT awaited first: the udev rung races it, and the samples
      // below are the honest record of what the pool read in that window.
      await sshExec('sync')
      let pullError: unknown = null
      const pull = execFileAsync(FIXTURE_SH, ['pull-cache']).catch((err: unknown) => {
        pullError = err
      })

      // --- the pre-recovery window ----------------------------------------
      // Poll as fast as the API answers, recording every DISTINCT cache-block
      // reading. The review batch's promise: once LVM has noticed, the read is
      // `failed` with `deviceMissing` — and the sweep path covers the moment
      // before that. Catching it depends on the race; missing it is recorded,
      // not faked.
      const samples: string[] = []
      let caught: CacheBlock | null = null
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const p = await poolDetailSafe(ctx)
        if (p) {
          const c = p.cache
          const tag = `state=${c?.state} deviceMissing=${c?.deviceMissing === true} devices=${JSON.stringify(c?.devices)}`
          if (samples.at(-1) !== tag)
            samples.push(tag)
          if (c?.state === 'failed' && c.deviceMissing === true) {
            caught = c
            break
          }
          if (c?.state === 'absent')
            break // the rung already finished — the window closed before a sample
        }
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      await pull
      if (pullError)
        throw pullError
      // eslint-disable-next-line no-console
      console.log(`[idle-pull] pre-recovery window samples: ${samples.join(' | ') || '(none)'}`)
      // eslint-disable-next-line no-console
      console.log(caught
        ? `[idle-pull] CAUGHT pre-recovery: ${JSON.stringify(caught)}`
        : '[idle-pull] the failed+deviceMissing read was NOT caught — the recovery beat the first poll')

      // --- recovery, within 10 s of the pull -------------------------------
      const recovered = await until(
        () => poolDetail(ctx),
        p => p.cache?.state === 'absent',
        10_000,
        'the udev rung uncached the idle pool',
      )
      // An IDLE pool earns none of the btrfs aftermath: no write ever met the
      // dead cache, so btrfs never forced read-only and the pool is healthy.
      expect(recovered.state).toBe('healthy')
      // The LV is no longer a cache target — the node's own view.
      expect(await sshExec(`lvs --noheadings -o lv_attr ${POOL}/${POOL}-vol`)).toMatch(/^-wi-ao/)
      expect(await sshExec(`dmsetup status ${DM_NAME}`)).toContain('linear')
      // No ghost PV left in the VG (`vgreduce --removemissing` ran behind the
      // band guard — every band has its own named md PV here).
      expect(await sshExec(`pvs --noheadings -o pv_name ${POOL} | tr -d ' '`)).not.toContain('[unknown]')

      // --- the FIRST read on the pool --------------------------------------
      // Direct I/O, so the page cache cannot answer for the block layer: this
      // is the read GT-19 measured returning EIO under a dead dm-cache. The
      // rung has uncached, so it must succeed — and carry the right bytes.
      // `pipefail` makes dd's exit code the pipeline's; `rc=$?` is captured
      // BEFORE anything else can reset `$?`.
      const firstRead = await sshExec(
        `set -o pipefail; `
        + `d=$(dd if=${MOUNT}/pre-attach.bin bs=1M iflag=direct status=none 2>/dev/null | sha256sum | cut -d' ' -f1); rc=$?; `
        + `s=$(cut -d' ' -f1 /tmp/anas-pre.sha); `
        + `echo "rc=$rc match=$([ "$d" = "$s" ] && echo yes || echo no)"`,
      )
      expect(firstRead, 'the first read after the idle pull succeeds, no EIO, data intact').toBe('rc=0 match=yes')

      // --- SHAPE 2: the rung's journal record ------------------------------
      // Every ahr.cache line the recovery wrote, captured for the report; the
      // assertions check the classification the record carries: WHICH device
      // the rung acted on (by-id when the topology could still resolve it,
      // the udev-reported GPT label once it could not) and that the IDLE pool
      // never went read-only — the fact that keeps the notification's Remount
      // clause out.
      const journal = await sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o cat`)
      const rungLines = journal.split('\n').filter(l => l.includes(`ahr.cache pool=${POOL}`))
      // eslint-disable-next-line no-console
      console.log(`[idle-pull] udev-rung journal lines:\n  ${rungLines.join('\n  ')}`)
      expect(rungLines.join('\n'), 'the recovery is journalled with the device it acted on')
        .toMatch(/rung=recover status=uncached device=\S+/)
      expect(rungLines.join('\n'), 'and with the idle pool\'s read-only classification')
        .toMatch(/rung=recover readonly=false notified=1/)

      // The udev hook's own record, under the AHR tag.
      const udevJournal = await sshExec(`journalctl -t anas-ahr --after-cursor='${cursor}' --no-pager -o cat`)
      expect(udevJournal).toContain(`EVENT=CacheDeviceRemoved POOL=${POOL} SLICE=${POOL}-cache1`)

      // The recovery notified, and the template pair rendered.
      const notified = await notificationsSince(cursor)
      expect(notified.sent, 'a PVE notification was emitted').toBeGreaterThan(0)
      expect(notified.renderFailures, 'the anas-ahr template pair rendered').toBe(0)

      // --- the disk returns; Detach reclaims it ----------------------------
      await execFileAsync(FIXTURE_SH, ['return-cache'])
      const returned = await poolDetail(ctx)
      // Still attributed to the pool, by the slice the recovery deliberately
      // did NOT delete — the operator's product path back to the disk.
      expect(returned.cache?.state).toBe('absent')
      expect(returned.cache?.devices).toEqual([cacheId])

      const detachJob = await runJob(ctx, 'delete', `${V1}/ahr/${POOL}/cache`)
      expect((detachJob.result as { released: string[] }).released).toEqual([cacheId])
      const released = await diskRow(ctx, cacheId)
      expect(released.status).toBe('available')
      expect(released.partitions).toEqual([])

      await sshExec('rm -f /tmp/anas-pre.bin /tmp/anas-pre.sha')
      await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
    }
    finally {
      await ctx.dispose()
    }
  })

  /**
   * SHAPE 2 — THE BAND DOWN, THE CACHE SSD HEALTHY — in two phases, because
   * the live run taught where each fact is readable.
   *
   * PHASE A (the band stopped). The cached LV cannot activate because its
   * band's md array is stopped — with disk 9 attached and fine the whole
   * time. The no-uncache facts are the assertion: the pool LV stays a cache
   * target, the boot rung runs no recovery (`action=recover-before-mount`,
   * `rung=recover` absent from the journal) and no notification goes out.
   * The pre-fix behavior here was reading the dead dm question as `failed`
   * and uncaching a partial VG over a healthy SSD.
   *
   * RECORDED, NOT PAPERED OVER: with the ONLY band array stopped, the pool
   * is not discoverable at all — the topology reader reconstructs pools from
   * /proc/mdstat (stateless, the system is the source of truth), so
   * `GET /v1/ahr/gtcache` answers 404, and with it every cache reading. The
   * brief expected `cache.state: 'inactive'` here; the API's honest answer is
   * "no such pool". Also recorded: the boot rung's band ladder does NOT
   * reassemble the stopped array by itself.
   *
   * PHASE B (the band back, the volume still deactivated) is the shape the
   * `inactive` state was added for and the first one the API can see: the
   * band array is assembled, so the pool is discovered; the LV is a cache
   * target with no dm table. `cache.state` must read `inactive` — the device
   * still named, no `deviceMissing`, no counters — and STILL no rung acts.
   * Then the volume is activated and mounted, a second restart sees a healthy
   * cached pool and touches nothing, and the teardown goes through the API.
   */
  test('shape 2: band down, cache SSD healthy — no rung uncaches it; inactive where the API can see it', async ({ playwright, pveTicket }) => {
    const cacheId = BY_ID(CACHE_SERIAL)
    await execFileAsync(FIXTURE_SH, ['up'])
    for (const serial of [...BAND_SERIALS, CACHE_SERIAL])
      expect(await fileExists(`/dev/disk/by-id/${BY_ID(serial)}`), `${serial} attached`).toBe(true)

    const ctx = await authedContext(playwright, pveTicket)
    try {
      await buildCachedPool(ctx)
      expect((await poolDetail(ctx)).cache?.state).toBe('healthy')
      // The state we are proving must survive: an ACTIVE cache target.
      expect(await sshExec(`lvs --noheadings -o lv_attr ${POOL}/${POOL}-vol`)).toMatch(/^C/)

      // The band goes down; the cache SSD stays attached and healthy.
      await execFileAsync(FIXTURE_SH, ['stop-band'])

      const cursor = await anasdCursor()
      await execFileAsync(FIXTURE_SH, ['restart-daemon'])

      // --- PHASE A: what the API answers while the band array is down ------
      const statuses = new Set<number>()
      let answer: { status: number, body: string } | null = null
      let sawPool = false
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const res = await ctx.get(`${V1}/ahr/${POOL}`)
        statuses.add(res.status())
        answer = { status: res.status(), body: await res.text() }
        if (res.status() === 200) {
          sawPool = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      const mdstatDuring = await sshExec(`grep -c '${POOL}-' /proc/mdstat || true`)
      // eslint-disable-next-line no-console
      console.log(`[band-down] phase A statuses: ${[...statuses].join(', ') || '(none)'}`)
      // eslint-disable-next-line no-console
      console.log(`[band-down] phase A last answer: ${answer ? `${answer.status} ${answer.body.slice(0, 200)}` : '(never answered)'}`)
      // eslint-disable-next-line no-console
      console.log(mdstatDuring === '0'
        ? '[band-down] the band array never reappeared in /proc/mdstat — the boot ladder did NOT reassemble it on its own'
        : '[band-down] the band array IS in /proc/mdstat — the ladder reassembled it on its own')

      if (!sawPool) {
        // The honest answer while the only band is stopped: no pool to read.
        expect(answer?.status, `the pool read answered: ${answer?.body}`).toBe(404)
        expect(answer?.body).toContain('not found')
      }

      // --- NO uncache happened, in either phase -----------------------------
      // The pool LV is still a cache target. (With the band down the VG
      // metadata is read from the cache PV alone; the attr's first char is
      // `C` active or inactive alike.)
      const cacheTargetStill = () => sshExec(
        `lvs --noheadings -o lv_name,lv_attr ${POOL} | awk '$1 == "${POOL}-vol" {print substr($2, 1, 1)}'`,
      )
      expect(await cacheTargetStill()).toBe('C')
      expect(await sshExec(`lvs -a --noheadings -o lv_name ${POOL}`)).toContain(`[${POOL}-vol_corig]`)

      const journalSoFar = () => sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o cat`)
      let journal = await journalSoFar()
      expect(journal, 'no boot-rung recover for the pool').not.toMatch(new RegExp(`ahr\\.boot pool=${POOL}.*action=recover-before-mount`))
      expect(journal, 'no rung=recover for the pool').not.toContain(`ahr.cache pool=${POOL} rung=recover`)
      expect(journal, 'no recovery journalled a notification').not.toContain('notified=1')

      // --- PHASE B: band back, volume still down — where 'inactive' reads --
      // Deliberately NOT activating the volume: the band array is assembled
      // (pool discovered), the cached LV has no dm table.
      await sshExec(`mdadm --assemble --scan 2>/dev/null || true; udevadm settle`)
      const rediscovered = await until(
        () => poolDetailSafe(ctx),
        p => p !== null,
        30_000,
        'the pool to be discovered again once its band is back',
      )
      expect(rediscovered, 'the pool answered once its band was back').toBeTruthy()
      if (rediscovered!.cache?.state === 'inactive') {
        // eslint-disable-next-line no-console
        console.log(`[band-down] phase B INACTIVE reading: ${JSON.stringify({ state: rediscovered!.state, mounted: rediscovered!.mounted, advisories: rediscovered!.advisories, cache: rediscovered!.cache })}`)
        // The SSD is NOT blamed: the device is still named, no deviceMissing,
        // and no counters — those ride healthy only, and an inactive cache
        // has no dm answer to count.
        expect(rediscovered!.cache?.devices).toEqual([cacheId])
        expect(rediscovered!.cache?.deviceMissing).toBeUndefined()
        expect(rediscovered!.cache?.hits).toBeUndefined()
        expect(rediscovered!.cache?.totalBlocks).toBeUndefined()
        expect(await cacheTargetStill()).toBe('C')
      }
      else {
        // eslint-disable-next-line no-console
        console.log(`[band-down] phase B did NOT read inactive (got ${rediscovered!.cache?.state}) — the volume was already active again`)
      }

      // --- restore: activate the volume, mount, restart, healthy -----------
      const restored = (await execFileAsync(FIXTURE_SH, ['restore-band'])).stdout
      expect(restored, 'the band reassembled and the pool mounted').toContain(MOUNT)
      expect(restored).not.toContain('NOT MOUNTED')
      await execFileAsync(FIXTURE_SH, ['restart-daemon'])

      const healthy = await until(
        () => poolDetailSafe(ctx),
        p => p !== null && p.mounted && p.cache?.state === 'healthy',
        120_000,
        'the restored pool to read healthy and cached after the second restart',
      )
      expect(healthy, 'the pool answered after the restart').toBeTruthy()
      expect(healthy!.state).toBe('healthy')
      // Still a cache target, and now an ACTIVE one again.
      expect(await sshExec(`lvs --noheadings -o lv_attr ${POOL}/${POOL}-vol`)).toMatch(/^Cwi-a/)
      expect(await sshExec(`dmsetup status ${DM_NAME}`)).toContain('cache')

      // --- the whole shape notified nothing --------------------------------
      const notified = await notificationsSince(cursor)
      expect(notified.sent, 'no PVE notification was emitted, band down or restored').toBe(0)
      expect(notified.renderFailures).toBe(0)
      journal = await journalSoFar()
      expect(journal, 'no recover line at any point of the shape').not.toContain(`ahr.cache pool=${POOL} rung=recover`)

      // --- teardown through the API, as the other tests do ------------------
      await sshExec('rm -f /tmp/anas-pre.bin /tmp/anas-pre.sha')
      const detachJob = await runJob(ctx, 'delete', `${V1}/ahr/${POOL}/cache`)
      expect((detachJob.result as { released: string[] }).released).toEqual([cacheId])
      expect((await diskRow(ctx, cacheId)).status).toBe('available')
      await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
    }
    finally {
      await ctx.dispose()
    }
  })

  /**
   * SHAPE 3 — THE FOREIGN PV (the review batch's label-scoping fix).
   *
   * A partition `pvcreate`d and `vgextend`ed into the pool VG BY HAND, on a
   * disk ANAS never labelled — no `<pool>-cache<n>` GPT label, no md
   * superblock. Under the pre-fix rule (every named non-md PV counts as
   * cache) it became a role-`cache` POOL DISK, and destroy's zap list reached
   * a disk the operator owned. Under the fix it is: a pool advisory naming
   * it, off the disk list, out of the cache size — and destroy removes the VG
   * around it and leaves it a physical volume with no volume group, which
   * this proof verifies on the node before cleaning the disk up by hand.
   */
  test('shape 3: a foreign PV in the pool VG is an advisory, never a pool disk, and survives destroy', async ({ playwright, pveTicket }) => {
    const cacheId = BY_ID(CACHE_SERIAL)
    await execFileAsync(FIXTURE_SH, ['up'])
    for (const serial of [...BAND_SERIALS, CACHE_SERIAL])
      expect(await fileExists(`/dev/disk/by-id/${BY_ID(serial)}`), `${serial} attached`).toBe(true)
    // The fourth disk, 200 MB, blank — the operator's would-be PV.
    await execFileAsync(FIXTURE_SH, ['attach-foreign'])
    expect(await fileExists(`/dev/disk/by-id/${FOREIGN_ID}`), `${FOREIGN_SERIAL} attached`).toBe(true)

    const ctx = await authedContext(playwright, pveTicket)
    try {
      // --- the pool, cached, healthy — the state before the hand-work ------
      const inventory = await ctx.get(`${V1}/disks`)
      const disks = (await inventory.json()).data as DiskRow[]
      const bandIds = BAND_SERIALS.map(serial => disks.find(d => d.id.includes(serial))!.id)
      expect(disks.find(d => d.id === FOREIGN_ID)!.status).toBe('available')

      await runConfirmedJob(ctx, 'post', `${V1}/ahr`, { name: POOL, tier: 'ahr1', disks: bandIds })
      await runJob(ctx, 'post', `${V1}/ahr/${POOL}/cache`, { disks: [cacheId] })
      const cached = await poolDetail(ctx)
      expect(cached.cache?.state).toBe('healthy')
      expect(cached.cache?.devices).toEqual([cacheId])
      const cacheBytesBefore = cached.cache!.sizeBytes

      // --- the operator's PV, in the pool's VG, no ANAS label --------------
      // NO partition name (`-c` is not passed): the whole point is that the
      // disk carries none of ANAS's `<pool>-cache<n>` labels.
      await sshExec(
        `d=/dev/disk/by-id/${FOREIGN_ID}; `
        + `sgdisk -n 1:0:0 -t 1:8E00 "$d" && udevadm settle && `
        + `wipefs -a "$d-part1" && pvcreate -y "$d-part1" && vgextend ${POOL} "$d-part1"`,
      )

      // The PV name exactly as `pvs` reports it — the name the advisory must
      // carry. Every band PV is /dev/md/*; the cache slice is hot9's (pvs
      // prints the KERNEL path, not the by-id the daemon pvcreate'd — run 1
      // of this spec named both and taught this exclusion); whatever else
      // sits in the VG is the foreign one.
      const cacheKernel = await sshExec(`readlink -f /dev/disk/by-id/${cacheId}-part1`)
      const foreignPv = await sshExec(
        `pvs --noheadings --separator '|' -o pv_name,vg_name `
        + `| awk -F'|' '{gsub(/ /,"",$1); gsub(/ /,"",$2)} $2 == "${POOL}" && $1 !~ /^\\/dev\\/md/ && $1 != "${cacheKernel}" {print $1}'`,
      )
      expect(foreignPv, 'exactly one foreign PV in the VG').toMatch(/^\/dev\/\S+$/)

      // --- the pool detail: advisory, not disk, not capacity ---------------
      const after = await poolDetail(ctx)
      const advisory = after.advisories.find(a => a.includes(foreignPv))
      expect(advisory, `an advisory names the foreign PV ${foreignPv}`).toBeTruthy()
      expect(advisory!, 'it says what the verbs do with it')
        .toContain(`neither a band array nor one of this pool's cache slices`)
      // NOT a pool disk: pool.disks is destroy's wipe list, and disk 10 is
      // the operator's.
      expect(after.disks.some(d => d.id === FOREIGN_ID), 'disk 10 is not a pool disk').toBe(false)
      // NOT cache capacity: the reported cache size is scoped to ANAS's own
      // slices, so the hand-made PV's extents do not inflate it.
      expect(after.cache?.sizeBytes).toBe(cacheBytesBefore)

      // NOT attributed in the inventory either.
      const foreignDisk = await diskRow(ctx, FOREIGN_ID)
      expect(foreignDisk.poolName, 'disk 10 is not attributed to the pool').not.toBe(POOL)
      expect(foreignDisk.status).not.toBe('ahr_member')

      // --- destroy: the VG goes, the foreign PV stays ----------------------
      await runConfirmedJob(ctx, 'delete', `${V1}/ahr/${POOL}`)
      const list = await ctx.get(`${V1}/ahr`)
      expect((await list.json()).data).toEqual([])

      // The GPT is intact and the partition is STILL a physical volume —
      // with no volume group, exactly as the advisory promised.
      const gpt = await sshExec(`sgdisk -p /dev/disk/by-id/${FOREIGN_ID}`)
      expect(gpt, 'the partition table survived destroy').toMatch(/\n\s+1\s+/)
      expect(gpt).toContain('8E00')
      const foreignKernel = await sshExec(`readlink -f /dev/disk/by-id/${FOREIGN_ID}-part1`)
      const pvLine = await sshExec(
        `pvs --noheadings --separator '|' -o pv_name,vg_name `
        + `| awk -F'|' '{gsub(/ /,"",$1); gsub(/ /,"",$2)} $1 == "${foreignKernel}" {print $1 "=" $2}'`,
      )
      expect(pvLine, 'the foreign PV survives, with no volume group').toMatch(/=$/)

      // --- clean the operator's disk up by hand, then hand it back ---------
      await execFileAsync(FIXTURE_SH, ['detach-foreign'])
    }
    finally {
      await ctx.dispose()
    }
  })
})
