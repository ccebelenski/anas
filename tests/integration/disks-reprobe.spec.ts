import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

/**
 * Story disks.1 (SMART readings age out) — LIVE PROOF on the stunt node.
 *
 * The story's Proof sentence is the contract this file discharges:
 *
 *   "with `ANAS_SMART_REPROBE_MS=2000` in a daemon drop-in, two Disks loads
 *    3 s apart show two `smartctl` invocations per disk in the daemon journal,
 *    two loads 1 s apart show one; Playwright: the detail shows the read-age
 *    line and the power-mode row (absent on the virtual disks — assert
 *    absence, and presence from a fixture through the dev mock); the dashboard
 *    shows 'ANAS <version>'."
 *
 * What is proven here, in order (serial — every test moves the node's cadence
 * and restarts the daemon):
 *
 *   1. Cadence DUE: two `GET /v1/disks` loads 3 s apart under a 2 s cadence →
 *      TWO `smartctl` identity probes per disk.
 *   2. Cadence HIT: two loads 1 s apart under the same 2 s cadence → ONE.
 *   3. The CONTROL the story does not name but the proof needs: the drop-in
 *      removed (the shipped 30-minute default), two loads 3 s apart → ONE per
 *      disk. Without it, (1) proves only that something probed twice; with it,
 *      the env override is the only thing that changed.
 *   4. Playwright over the real PVE UI: a disk's SMART detail shows the
 *      read-age line (`.anas-smart-reading`, "SMART read <age> ago") and NO
 *      "Power mode:" row — the stunt node's disks are QEMU SCSI and report no
 *      `power_mode` object, which is exactly the absence the rider promises
 *      never to infer around.
 *   5. The dashboard header shows "ANAS <version>" (`.anas-dash-version`),
 *      equal to the version `GET /v1/health` reports.
 *
 * The POWER-MODE PRESENCE case is harness-proven, not proven here: no disk on
 * this node (or any QEMU guest) reports an ATA `power_mode`, and the daemon
 * never fabricates one. `packages/pve-integration/test/dialog-contracts.harness.mjs`
 * already drives the detail window through its real `itemdblclick` door over a
 * fixture record carrying `powerMode: 'ACTIVE or IDLE'` and asserts
 * "Power mode: ACTIVE or IDLE (as of <age>)" on BOTH detail shapes (attribute
 * table and summary), its absence on the standby shape, and its absence on a
 * SAS-shaped record. That check is not duplicated here; test 4 proves the
 * live half — the absence — on a real node.
 *
 * GROUND TRUTH that corrected the story's own parenthetical (2026-09-25): the
 * story assumed "virtual disks have no SMART — smartctl fails". On this node
 * smartctl SUCCEEDS on the QEMU SCSI disks (exit 0, a SCSI identity document
 * with `smart_support.available: false`), so the daemon takes the MEASURED
 * path and the reading carries a real `measuredAt`. That is better than the
 * story feared: the cadence's age check — the disks.1 change itself — is what
 * governs here, rather than the probe-failure backoff that would have governed
 * had the probes failed. The detail line is therefore the plain "SMART read
 * <age> ago", not the probe-failed marker. Counting invocations rather than
 * values stays right either way, and is what the tests below do.
 *
 * HOW THE INVOCATIONS ARE COUNTED. The daemon does not log the argv it
 * executes (nothing in `executor/prod.ts` does, by design — Principle:
 * journald carries events, not a command trace). So the count comes from a
 * test-side stand-in, the pattern cloud-tasks-ui.spec.ts already uses for
 * `/usr/bin/rclone`: `/usr/sbin/smartctl` is moved aside and replaced by a
 * two-line shim that `logger`s its argv under the tag `anas-smart-gt` and
 * `exec`s the real binary. Nothing about the daemon changes; the probe's own
 * argv (`-n standby -iH --json /dev/X`) is the record, and the device path in
 * it is what makes the count PER DISK. `afterAll` puts the real binary back.
 *
 * GROUND TRUTH on reading those lines back (2026-09-25): they must be selected
 * by TAG (`journalctl -t anas-smart-gt`), never by `-u anasd`. The shim's
 * `logger` child lives in anasd's cgroup, so most of its entries do get
 * `_SYSTEMD_UNIT=anasd.service` — but not all: the process is short-lived and
 * journald resolves the sender's cgroup at receive time, so an entry whose
 * sender has already exited lands with no unit attribution. Measured on this
 * node: a `-u anasd` view dropped 1 of 6 lines in one window and 5 of 9 in the
 * next, while the tag view held all 15. The window is still bounded by a
 * journald cursor taken before the loads, so only this spec's own probes are
 * counted, and `smartd` is asserted inactive so nothing else on the box can
 * call smartctl into the same window.
 *
 * PER DISK means every disk `GET /v1/disks` reports. A bare stunt node has one
 * (the boot disk); attach spares with `test/stunt-node/add-disk.sh --size 256
 * <n>` and the same assertions run over all of them. The two proof runs
 * recorded for this story were taken with disks 7 and 8 attached — three disks,
 * `/dev/sda=2 /dev/sdb=2 /dev/sdc=2` on the 3 s pair — and the file was then
 * re-proven green on the bare one-disk node the spares were detached from, so
 * it needs no fixture of its own.
 *
 * Leaves the node as found: the drop-in removed, the real smartctl restored,
 * the daemon restarted and the gateway active (it follows anasd through
 * `PartOf=`, which this spec asserts rather than assumes).
 */

test.describe.configure({ mode: 'serial' })

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

/** The re-probe cadence the drop-in asks for, in ms — the story's own value. */
const CADENCE_MS = 2000

const DROPIN_DIR = '/etc/systemd/system/anasd.service.d'
const DROPIN = `${DROPIN_DIR}/zz-anas-spec.conf`

/** The real smartctl, the place it is parked, and the shim's journal tag. */
const SMARTCTL = '/usr/sbin/smartctl'
const SMARTCTL_BAK = '/usr/sbin/smartctl.anas-spec-bak'
const PROBE_TAG = 'anas-smart-gt'

/** The daemon's identity probe, as the shim records it (disk path captured). */
const PROBE_RE = /^-n standby -iH --json (\/dev\/\S+)$/

// ---- node-side instrument ---------------------------------------------------

/**
 * Park the real smartctl and put the logging shim in its place. Idempotent: a
 * leftover backup from an aborted run is NOT overwritten (that would park the
 * shim as the "real" binary and leave the node with a recursive stand-in).
 */
async function installProbeShim(): Promise<void> {
  await sshExec(
    `set -e; [ -e ${SMARTCTL_BAK} ] || cp -a ${SMARTCTL} ${SMARTCTL_BAK}; `
    + `printf '%s\\n' '#!/bin/sh' 'logger -t ${PROBE_TAG} -- "$*"' 'exec ${SMARTCTL_BAK} "$@"' > ${SMARTCTL}; `
    + `chmod 755 ${SMARTCTL}`,
  )
  const head = await sshExec(`head -1 ${SMARTCTL}`)
  expect(head, 'the shim is in place').toBe('#!/bin/sh')
}

/** Put the real smartctl back. Never throws — teardown must not mask a failure. */
async function restoreProbeShim(): Promise<void> {
  await sshExec(`[ -e ${SMARTCTL_BAK} ] && mv -f ${SMARTCTL_BAK} ${SMARTCTL}; true`).catch(() => {})
}

/**
 * Set (or clear) the re-probe cadence through a daemon drop-in and restart the
 * daemon — which also clears the identity cache, so every test starts from a
 * disk list that has never been probed. `null` removes the drop-in, leaving
 * the shipped 30-minute default.
 */
async function setCadence(ms: number | null): Promise<void> {
  if (ms === null) {
    await sshExec(`rm -f ${DROPIN}`)
  }
  else {
    await sshExec(
      `mkdir -p ${DROPIN_DIR} && `
      + `printf '[Service]\\nEnvironment=ANAS_SMART_REPROBE_MS=${ms}\\n' > ${DROPIN}`,
    )
  }
  await sshExec('systemctl daemon-reload && systemctl restart anasd')
  // The unit's environment is the assertion that the drop-in took — a typo in
  // the path would otherwise read as "the cadence made no difference".
  const env = await sshExec('systemctl show anasd -p Environment')
  if (ms === null)
    expect(env, 'the drop-in is gone').not.toContain('ANAS_SMART_REPROBE_MS')
  else
    expect(env, 'the drop-in is in force').toContain(`ANAS_SMART_REPROBE_MS=${ms}`)
}

/**
 * Wait for the daemon to answer again after a restart, and require the gateway
 * to have come back with it. The gateway unit is `PartOf=anasd.service`
 * (e49ce7f) — a daemon restart restarts it too, and before that fix the UI sat
 * at 502 after exactly this kind of restart, so it is asserted, not assumed.
 */
async function waitForDaemon(ctx: APIRequestContext): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const res = await ctx.get(`${V1}/health`).catch(() => null)
    if (res && res.status() === 200)
      break
    if (Date.now() > deadline)
      throw new Error('daemon did not answer /v1/health within 60 s of the restart')
    await new Promise(r => setTimeout(r, 500))
  }
  expect(await sshExec('systemctl is-active anasd'), 'anasd active').toBe('active')
  expect(await sshExec('systemctl is-active anas'), 'the gateway followed the daemon').toBe('active')
}

/** A journald cursor for the whole journal — the "before" of a probe count. */
async function journalCursor(): Promise<string> {
  const out = await sshExec('journalctl -n 0 --no-pager --show-cursor')
  const cursor = out.split('-- cursor:').pop()?.trim() ?? ''
  expect(cursor, 'journalctl printed a cursor').not.toBe('')
  return cursor
}

/**
 * The daemon's smartctl identity probes since `cursor`, counted per device
 * path. Only the daemon's own argv shape counts, so an unrelated smartctl run
 * could never inflate it.
 */
async function probesSince(cursor: string): Promise<Map<string, number>> {
  // journald files an entry when it receives it; give the last shim's logger
  // child room to land before the window is read.
  await new Promise(r => setTimeout(r, 1000))
  const out = await sshExec(
    `journalctl --after-cursor='${cursor}' --no-pager -o cat -t ${PROBE_TAG} || true`,
  )
  const counts = new Map<string, number>()
  for (const line of out.split('\n')) {
    const m = PROBE_RE.exec(line.trim())
    if (m)
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  return counts
}

// ---- API helpers ------------------------------------------------------------

function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: pveAuthState(ticket),
    timeout: 60_000,
  })
}

/** One Disks LOAD: `GET /v1/disks`, the call that carries the re-probe pass. */
async function loadDisks(ctx: APIRequestContext): Promise<any[]> {
  const res = await ctx.get(`${V1}/disks`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data
}

/** Assert the same probe count for every disk the load reported. */
function expectProbesPerDisk(
  counts: Map<string, number>,
  paths: string[],
  want: number,
  what: string,
): void {
  const tally = paths.map(p => `${p}=${counts.get(p) ?? 0}`).join(' ')
  for (const p of paths)
    expect(counts.get(p) ?? 0, `${what} — ${p} (tally: ${tally})`).toBe(want)
  // Nothing probed a disk the load did not report (a pruned or vanished
  // device probing on would be a finding, not a rounding error).
  const unexpected = [...counts.keys()].filter(p => !paths.includes(p))
  expect(unexpected, `${what} — only the listed disks were probed`).toEqual([])
  // eslint-disable-next-line no-console
  console.log(`[disks.1] ${what}: ${tally}`)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// ---- the proof --------------------------------------------------------------

test.describe('disks.1 — SMART readings age out (stunt node)', () => {
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    expect(
      await sshExec('systemctl is-active smartd || true'),
      'smartd is not running — nothing but the daemon calls smartctl in the counted window',
    ).not.toBe('active')
    await installProbeShim()
  })

  test.afterAll(async () => {
    // The drop-in AND the directory setCadence made for it — an empty
    // anasd.service.d left on the node is still something this spec put
    // there. `rmdir` declines a directory that holds anything else, so a
    // node with its own drop-ins keeps them.
    await sshExec(`rm -f ${DROPIN}; rmdir ${DROPIN_DIR} 2>/dev/null; true`).catch(() => {})
    await restoreProbeShim()
    await sshExec('systemctl daemon-reload && systemctl restart anasd').catch(() => {})
    // Leave the node usable: the daemon back up and the gateway with it.
    await sleep(5000)
    const state = await sshExec('systemctl is-active anasd anas || true')
    // eslint-disable-next-line no-console
    console.log(`[disks.1] teardown — anasd/anas: ${state.split('\n').join(' ')}`)
  })

  test('a reading older than the cadence is re-probed: two loads 3 s apart, two probes per disk', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await setCadence(CADENCE_MS)
      await waitForDaemon(ctx)

      const cursor = await journalCursor()
      // Load 1 — the daemon has just restarted, so no disk has a reading yet.
      const disks = await loadDisks(ctx)
      expect(disks.length, 'the node reports at least one disk').toBeGreaterThan(0)
      const paths: string[] = disks.map((d: any) => d.path)
      // Every disk here takes the MEASURED path (see the header): the reading
      // is dated, which is what the cadence then ages out.
      for (const d of disks)
        expect(d.smartMeasuredAt, `${d.name} carries a measured date`).toBeTruthy()

      await sleep(3000)
      // Load 2 — each reading is now ~3 s old against a 2 s cadence: due.
      await loadDisks(ctx)

      expectProbesPerDisk(
        await probesSince(cursor),
        paths,
        2,
        'cadence 2000 ms, loads 3 s apart',
      )
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a reading younger than the cadence is a hit: two loads 1 s apart, one probe per disk', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Restart to clear the cache, so load 1 below is the disk's first pass.
      await setCadence(CADENCE_MS)
      await waitForDaemon(ctx)

      const cursor = await journalCursor()
      const disks = await loadDisks(ctx)
      const paths: string[] = disks.map((d: any) => d.path)

      await sleep(1000)
      // Load 2 — each reading is ~1 s old against a 2 s cadence: not due.
      const second = await loadDisks(ctx)

      expectProbesPerDisk(
        await probesSince(cursor),
        paths,
        1,
        'cadence 2000 ms, loads 1 s apart',
      )
      // The second load still ANSWERED with the cached reading — a hit is not
      // a blank: same values, same measurement date, no fresh claim.
      const byId = new Map(disks.map((d: any) => [d.id, d]))
      for (const d of second) {
        expect(d.smartMeasuredAt, `${d.name} kept its reading date on the cache hit`)
          .toBe(byId.get(d.id)?.smartMeasuredAt)
      }
    }
    finally {
      await ctx.dispose()
    }
  })

  test('control: without the drop-in the shipped 30-minute cadence holds — two loads 3 s apart, one probe per disk', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await setCadence(null)
      await waitForDaemon(ctx)

      const cursor = await journalCursor()
      const disks = await loadDisks(ctx)
      const paths: string[] = disks.map((d: any) => d.path)

      await sleep(3000)
      await loadDisks(ctx)

      expectProbesPerDisk(
        await probesSince(cursor),
        paths,
        1,
        'default cadence (no drop-in), loads 3 s apart',
      )
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the disk detail dates the reading and shows no power-mode row for a disk that reports none', async ({ page, playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    const disks = await loadDisks(ctx).finally(() => ctx.dispose())
    // The daemon reports no power mode for any disk on this node — QEMU SCSI
    // documents carry no `power_mode` object, and it is never inferred. That
    // is the absence the UI assertion below is the display side of.
    for (const d of disks)
      expect(d.powerMode, `${d.name} reports no power mode`).toBeUndefined()

    await loginToPve(page)
    await openAnasItem(page, 'Disks')

    const view = page.locator('.anas-view-disks')
    await expect(view).toBeVisible({ timeout: 45_000 })
    const grid = view.locator('.anas-grid-disks')
    const rows = grid.locator('.x-grid-row')
    await expect(rows.first()).toBeVisible({ timeout: 30_000 })

    // The grid's records were dated when THIS load ran; `ANAS.ago` renders
    // anything under 10 s as "just now", which is an age but not a duration.
    // Wait past that boundary so the line has to render a real one — the
    // window re-reads /smart but takes the DATE from the grid record, so the
    // age grows without anything re-probing.
    await sleep(13_000)

    await rows.first().click()
    await view.locator('.anas-btn-smart').click()

    const win = page.locator('.x-window').filter({ hasText: 'S.M.A.R.T. Values' }).first()
    await expect(win).toBeVisible({ timeout: 20_000 })

    const reading = win.locator('.anas-smart-reading')
    await expect(reading).toBeVisible({ timeout: 20_000 })
    const line = ((await reading.textContent()) ?? '').trim()
    // eslint-disable-next-line no-console
    console.log(`[disks.1] detail reading line: ${line}`)

    // The read-age line, with a REAL duration in it.
    expect(line, 'the detail dates the reading with an age').toMatch(
      /^SMART read \d+(?:s|m \d+s|h \d+m|d \d+h) ago$/,
    )
    // ...and no power-mode row, because the daemon reported no mode.
    expect(line, 'no power-mode row on a disk that reports none').not.toContain('Power mode')
    await expect(win.locator('.anas-smart-reading', { hasText: 'Power mode' })).toHaveCount(0)

    // The reading line lives ABOVE the grid, not inside it (the rider's own
    // finding): it is never a row in the summary store.
    // (`.x-grid` — an ExtJS itemId is a component name, not a DOM id, so
    // `#smartGrid` never matches anything in the page.)
    const gridText = (await win.locator('.x-grid').first().textContent()) ?? ''
    expect(gridText, 'the reading line is not duplicated into the grid').not.toContain('SMART read')
  })

  test('the dashboard header shows "ANAS <version>", the version /v1/health reports', async ({ page, playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    const health = await ctx.get(`${V1}/health`)
      .then(async (res) => {
        expect(res.status(), await res.text()).toBe(200)
        return res.json()
      })
      .finally(() => ctx.dispose())
    const version: string = health.version
    expect(version, '/v1/health reports a version').toBeTruthy()

    await loginToPve(page)
    await openAnasItem(page, 'Dashboard')

    const view = page.locator('.anas-view-dashboard')
    await expect(view).toBeVisible({ timeout: 45_000 })

    const label = view.locator('.anas-dash-version')
    await expect(label).toBeVisible({ timeout: 30_000 })
    const text = ((await label.textContent()) ?? '').trim()
    // eslint-disable-next-line no-console
    console.log(`[disks.1] dashboard version label: "${text}" (/v1/health: ${version})`)
    expect(text).toBe(`ANAS ${version}`)
  })
})
