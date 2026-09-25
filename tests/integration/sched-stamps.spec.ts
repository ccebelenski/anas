import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * `sched.stamps` (EPICS 0.4.0 riders; SCHEDULES-GROUND-TRUTH GT-16…GT-23) —
 * LIVE PROOF on the stunt node of the operator ruling of 2026-09-25:
 *
 *   - `removeTaskUnits` deletes the timer's `Persistent` STAMP alongside the
 *     units and issues `systemctl reset-failed` for the service and the timer
 *     as two calls, so a removed task leaves neither the stamp that arms a
 *     self-fire (GT-17) nor a `not-found failed` ghost;
 *   - the daemon SWEEPS the orphan stamps already on a node at start, for all
 *     four unit-store prefixes (`anas-backup-`, `anas-cloud-`, `anas-repl-`,
 *     `anas-snap-`), leaving a foreign stamp and the node-wide scrub pair
 *     alone.
 *
 * What is proven here, against the real systemd on the node:
 *   1. the sweep at daemon start removes PLANTED orphans of all four prefixes
 *      (one journald line each, verbatim) and leaves a foreign
 *      `stamp-<name>.timer` and `stamp-anas-scrub.timer` untouched
 *   2. a backup task created under a PREVIOUSLY-USED-AND-DELETED name, with a
 *      time-of-day schedule that has already passed today, does NOT run itself
 *      — `LastTriggerUSec` empty, no unit activation in the journal, no
 *      `lastRunAt` on the task (the GT-17 self-fire is gone)
 *   3. deleting a task whose last run FAILED removes its stamp and clears the
 *      failed state — no `anas-backup-<name>` ghost in `list-units --failed`
 *   4. the same three facts for a CLOUD task (`anas-cloud-` prefix), over the
 *      cloud tasks fixture's sftp remote
 *
 * The orphans are PLANTED rather than assumed: the node's own ~30 leftovers
 * (GT-18) are swept by the first daemon start that carries the fix, so a
 * second run of this spec would have nothing to observe. Planting makes the
 * assertion exact — these files and no others — and repeatable. The node's own
 * natural sweep is captured once, verbatim, as SCHEDULES-GT-22.
 *
 * Serial: every test restarts the daemon or waits out a 45 s no-fire window,
 * and the stamp directory is the shared state running through all of them.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const STAMP_DIR = '/var/lib/systemd/timers'
const SYSTEMD_DIR = '/etc/systemd/system'

/** The cloud fixture that owns the sftp remote and the unmountable mount. */
const CLOUD_FIXTURE_SH = new URL('../../test/stunt-node/cloud-tasks-fixture.sh', import.meta.url).pathname

/** The PBS repository the backup task points at (node configuration). */
const REPO = 'pbsgt'
/** The cloud remote the fixture registers through the API. */
const REMOTE = 'gt'
const RCLONE_USER = 'rclonegt'
const RCLONE_PASS = 'gtpass'
/** A source that exists — the task must be creatable; the RUN is what fails. */
const CLOUD_SRC = '/mnt/gt-unmounted'

/** The task names this spec owns. Deleted in afterAll whatever happens. */
const BACKUP_TASK = 'gtstampbk'
const CLOUD_TASK = 'gtstampcl'

/**
 * The orphan stamps test 1 plants — one per swept prefix — and the two that
 * must SURVIVE it: a foreign timer's stamp, and the node-wide scrub pair's
 * (`anas-scrub` does not start with any task prefix, and the scrub store owns
 * its own stamp).
 */
const PLANTED_ORPHANS = [
  'stamp-anas-backup-gtsweepbk.timer',
  'stamp-anas-cloud-gtsweepcl.timer',
  'stamp-anas-repl-gtsweeprp.timer',
  'stamp-anas-snap-gtsweepsn.timer',
]
const PLANTED_SURVIVORS = [
  'stamp-gtsweepforeign.timer',
  'stamp-anas-scrub.timer',
]

/** An archive path that does not exist — the run fails, so a ghost would form. */
const MISSING_ARCHIVE = '/gtbackup/no-such-path-gtstamp'

/** A time of day that has ALREADY passed today — the GT-17 self-fire trigger. */
const PASSED_TODAY = '*-*-* 00:05:00'
/** An absolute future date: enabled, but nothing to catch up on (GT-21). */
const FUTURE_DATE = '2030-01-01 00:00:00'

/** Build an authenticated request context carrying the PVE session cookie. */
async function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    ignoreHTTPSErrors: true,
    storageState: pveAuthState(ticket),
    timeout: 120_000,
  })
}

/** Poll a 202 job through GET /v1/jobs/:id until it completes or fails. */
async function awaitJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 180_000,
): Promise<{ status: string, error?: { message?: string } | null, result?: any }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const res = await ctx.get(`${V1}/jobs/${jobId}`)
    expect(res.status()).toBe(200)
    const job = (await res.json()).job
    if (job.status === 'completed' || job.status === 'failed')
      return job
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still '${job.status}' after ${timeout}ms`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Submit a mutation, wait for its job, and require it to COMPLETE. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
  timeout = 180_000,
): Promise<any> {
  const res = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, job.error?.message).toBe('completed')
  return job.result
}

/** Run a task through its own unit, expecting the job to FAIL. */
async function runExpectingFailure(ctx: APIRequestContext, path: string): Promise<string> {
  const res = await ctx.post(path, { data: {} })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id)
  expect(job.status, `expected a failed run, got ${job.status}`).toBe('failed')
  return job.error?.message ?? ''
}

/** `systemctl show <unit> --value -p <prop>` on the node ('' when unset). */
async function systemctlValue(unit: string, prop: string): Promise<string> {
  return (await sshExec(`systemctl show ${unit} --value -p ${prop} 2>/dev/null || true`)).trim()
}

/** Whether a path exists on the node. */
async function nodeExists(path: string): Promise<boolean> {
  return (await sshExec(`test -e ${path} && echo yes || echo no`)).trim() === 'yes'
}

/** Every file name in the node's systemd timer-stamp directory. */
async function stampFiles(): Promise<string[]> {
  const out = await sshExec(`ls ${STAMP_DIR} 2>/dev/null || true`)
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

/** `systemctl list-units --failed` as raw text (the GT-23 before/after). */
async function failedUnits(): Promise<string> {
  return sshExec('systemctl list-units --failed --no-legend --no-pager 2>/dev/null || true')
}

/** A journald cursor for one unit — the "before" of a comparison. */
async function cursorFor(unit: string): Promise<string> {
  const out = await sshExec(`journalctl -u ${unit} -n 0 --no-pager --show-cursor`)
  const cursor = out.split('-- cursor:').pop()?.trim() ?? ''
  expect(cursor, 'journalctl printed a cursor').not.toBe('')
  return cursor
}

/** Everything a unit journalled after `cursor`. */
async function journalSince(unit: string, cursor: string): Promise<string> {
  return sshExec(`journalctl -u ${unit} --after-cursor='${cursor}' --no-pager -o short-iso 2>/dev/null || true`)
}

/**
 * Restart the daemon and wait for it AND the gateway to be back.
 *
 * `anas.service` is `PartOf=anasd.service` (e49ce7f), so the gateway follows
 * the daemon — both must be active before the next API call, or pveproxy's
 * ANAS hook answers 502.
 */
async function restartDaemon(): Promise<void> {
  await sshExec('systemctl restart anasd')
  for (let i = 0; i < 40; i++) {
    const ok = (await sshExec(
      'test -S /run/anas/anasd.sock && systemctl is-active --quiet anasd '
      + '&& systemctl is-active --quiet anas && echo up || echo down',
    )).trim()
    if (ok === 'up')
      return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('anasd and/or the anas gateway did not come back after a restart')
}

/** Remove every artefact this spec can leave on the node. Never throws. */
async function cleanNode(): Promise<void> {
  const names = [`anas-backup-${BACKUP_TASK}`, `anas-cloud-${CLOUD_TASK}`]
  const planted = [...PLANTED_ORPHANS, ...PLANTED_SURVIVORS].map(f => `${STAMP_DIR}/${f}`).join(' ')
  await sshExec(
    [
      ...names.flatMap(u => [
        `systemctl disable --now ${u}.timer >/dev/null 2>&1 || true`,
        `rm -f ${SYSTEMD_DIR}/${u}.service ${SYSTEMD_DIR}/${u}.timer`,
        `rm -f ${STAMP_DIR}/stamp-${u}.timer`,
        `systemctl reset-failed ${u}.service >/dev/null 2>&1 || true`,
        `systemctl reset-failed ${u}.timer >/dev/null 2>&1 || true`,
      ]),
      `rm -f ${planted}`,
      'systemctl daemon-reload',
    ].join('\n'),
  ).catch(() => {})
}

/** The backup task body the create door takes. */
function backupTaskBody(schedule: string): Record<string, unknown> {
  return {
    name: BACKUP_TASK,
    repository: REPO,
    backupId: BACKUP_TASK,
    archives: [{ name: 'stamped', path: MISSING_ARCHIVE, excludes: [] }],
    changeDetectionMode: 'default',
    notify: 'on-failure',
    schedule,
    enabled: true,
  }
}

/** The cloud task body the create door takes. */
function cloudTaskBody(schedule: string): Record<string, unknown> {
  return {
    name: CLOUD_TASK,
    source: CLOUD_SRC,
    remote: REMOTE,
    mode: 'copy',
    schedule,
    notify: 'on-failure',
    enabled: true,
  }
}

/**
 * The shared body of the per-kind proof: a name is used, run to FAILURE and
 * deleted (stamp gone, no failed ghost — GT-23), then RE-USED with a schedule
 * whose time of day already passed today and left alone for 45 s (no
 * self-fire — the GT-17 remedy).
 */
async function proveKind(
  ctx: APIRequestContext,
  kind: 'backup' | 'cloud',
  name: string,
  body: (schedule: string) => Record<string, unknown>,
): Promise<{ failedBefore: string, failedAfter: string }> {
  const unit = `anas-${kind}-${name}`
  const stamp = `${STAMP_DIR}/stamp-${unit}.timer`
  const collection = `${V1}/${kind}/tasks`

  // --- life 1: create, run to failure, delete -----------------------------
  await runJob(ctx, 'post', collection, body(FUTURE_DATE))
  expect(await nodeExists(`${SYSTEMD_DIR}/${unit}.timer`), 'the timer unit was written').toBe(true)
  expect(await nodeExists(stamp), 'systemd created the stamp at enable --now (GT-16)').toBe(true)

  const message = await runExpectingFailure(ctx, `${collection}/${name}/run`)
  expect(message, 'the run failed for the reason the spec staged').not.toBe('')
  expect(
    (await systemctlValue(`${unit}.service`, 'Result')),
    'the oneshot is left in a failed Result — a ghost WOULD form',
  ).not.toBe('success')

  // GT-23 — `systemctl list-units --failed` before and after the removal.
  const failedBefore = await failedUnits()
  expect(failedBefore, 'the failed run shows as a failed unit before the delete').toContain(`${unit}.service`)

  await runJob(ctx, 'delete', `${collection}/${name}`)
  const failedAfter = await failedUnits()
  expect(await nodeExists(`${SYSTEMD_DIR}/${unit}.timer`), 'the timer unit is gone').toBe(false)
  expect(await nodeExists(`${SYSTEMD_DIR}/${unit}.service`), 'the service unit is gone').toBe(false)
  expect(await nodeExists(stamp), 'removeTaskUnits deleted the Persistent stamp (GT-18 is fixed)').toBe(false)
  expect(failedAfter, 'reset-failed cleared the ghost').not.toContain(unit)

  // --- life 2: the SAME name, a time of day that already passed today -----
  const svcCursor = await cursorFor(`${unit}.service`)
  const timerCursor = await cursorFor(`${unit}.timer`)
  await runJob(ctx, 'post', collection, body(PASSED_TODAY))

  // Immediately: no trigger recorded, and the next elapse is in the future.
  expect(
    await systemctlValue(`${unit}.timer`, 'LastTriggerUSec'),
    'a stamp-less timer records no last trigger (GT-16)',
  ).toBe('')
  expect(
    await systemctlValue(`${unit}.timer`, 'NextElapseUSecRealtime'),
    'the next elapse is a real future point, not "already missed"',
  ).not.toBe('')

  await new Promise(resolve => setTimeout(resolve, 45_000))

  expect(
    await systemctlValue(`${unit}.timer`, 'LastTriggerUSec'),
    'still no trigger 45 s later — the GT-17 self-fire is gone',
  ).toBe('')
  const svcJournal = await journalSince(`${unit}.service`, svcCursor)
  expect(svcJournal, 'the service never started').not.toContain('Starting')
  expect(svcJournal, 'the service never started').not.toContain('Started')
  const timerJournal = await journalSince(`${unit}.timer`, timerCursor)
  expect(timerJournal, 'the timer itself did start (it is enabled)').toContain('Started')

  const listed = await ctx.get(collection)
  expect(listed.status()).toBe(200)
  // The two list doors carry the same facts in different shapes: a backup row
  // is `{ task: {name,…}, lastRunAt }`, a cloud row is the task itself with
  // `lastRunAt` alongside. Read both rather than assert one.
  const rows = (await listed.json()).data as any[]
  const row = rows.find(r => (r.name ?? r.task?.name) === name)
  expect(row, 'the task is listed').toBeTruthy()
  expect(row.lastRunAt ?? null, 'no run was recorded for the re-used name').toBeNull()

  // --- and it comes off the node again ------------------------------------
  await runJob(ctx, 'delete', `${collection}/${name}`)
  expect(await nodeExists(stamp), 'the second life left no stamp either').toBe(false)

  return { failedBefore, failedAfter }
}

test.describe.configure({ mode: 'serial' })

test.describe('Scheduled-task timer stamps (sched.stamps)', () => {
  test.setTimeout(420_000)

  test.beforeAll(async ({ playwright }) => {
    await cleanNode()
    // The cloud half needs the fixture's sftp remote and the unmountable
    // fstab line. DOWN first — a crashed earlier run is not a "before".
    await execFileAsync(CLOUD_FIXTURE_SH, ['down'], { timeout: 300_000 })
    await execFileAsync(CLOUD_FIXTURE_SH, ['up'], { timeout: 300_000 })

    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    expect(ticketRes.ok()).toBeTruthy()
    const ticket = (await ticketRes.json()).data.ticket as string
    await login.dispose()

    const ctx = await authedContext(playwright, ticket)
    try {
      await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
        name: REMOTE,
        type: 'sftp',
        options: { host: '127.0.0.1', user: RCLONE_USER, pass: RCLONE_PASS },
      })
    }
    finally {
      await ctx.dispose()
    }
  })

  test.afterAll(async () => {
    await cleanNode()
    try {
      await execFileAsync(CLOUD_FIXTURE_SH, ['down'], { timeout: 300_000 })
    }
    catch (err) {
      console.error(`cloud tasks fixture down failed: ${err instanceof Error ? err.message : err}`)
    }
  })

  test('the daemon start sweeps orphan task stamps of all four prefixes and leaves the rest alone', async () => {
    // Plant one orphan per swept prefix and two that must survive. Their
    // mtimes are backdated: the sweep deliberately SKIPS a stamp newer than
    // the daemon's process start (a create may be landing in its window), and
    // an `install`-fresh file would be newer than the restart below.
    const plant = [...PLANTED_ORPHANS, ...PLANTED_SURVIVORS]
      .map(f => `install -m 0644 /dev/null ${STAMP_DIR}/${f} && touch -d '2026-07-01 00:00:00' ${STAMP_DIR}/${f}`)
      .join('\n')
    await sshExec(plant)

    const before = await stampFiles()
    for (const f of [...PLANTED_ORPHANS, ...PLANTED_SURVIVORS])
      expect(before, `${f} was planted`).toContain(f)
    // None of the planted orphans has a .service unit — that is what makes
    // them orphans, and it is the store's own existence test (review R3).
    for (const f of PLANTED_ORPHANS) {
      const unit = f.slice('stamp-'.length, -'.timer'.length)
      expect(await nodeExists(`${SYSTEMD_DIR}/${unit}.service`), `${unit}.service does not exist`).toBe(false)
    }

    const cursor = await cursorFor('anasd')
    await restartDaemon()
    // The sweep is fire-and-forget at start; give it a beat to journal.
    await new Promise(resolve => setTimeout(resolve, 2000))

    const journal = await journalSince('anasd', cursor)
    for (const f of PLANTED_ORPHANS) {
      expect(
        journal,
        `the sweep journalled ${f}`,
      ).toContain(`task stamp sweep: removed orphan stamp ${f} — its task no longer exists`)
    }
    for (const f of PLANTED_SURVIVORS)
      expect(journal, `${f} was never named by the sweep`).not.toContain(f)

    const after = await stampFiles()
    for (const f of PLANTED_ORPHANS)
      expect(after, `${f} was swept`).not.toContain(f)
    for (const f of PLANTED_SURVIVORS)
      expect(after, `${f} survived`).toContain(f)
    expect(after.length, 'exactly the four orphans went').toBe(before.length - PLANTED_ORPHANS.length)

    // Both services are up — the gateway follows the daemon (e49ce7f).
    expect((await sshExec('systemctl is-active anasd anas')).split('\n').map(s => s.trim()))
      .toEqual(['active', 'active'])

    await sshExec(`rm -f ${PLANTED_SURVIVORS.map(f => `${STAMP_DIR}/${f}`).join(' ')}`)
  })

  test('a backup task: delete clears stamp and failed state, and a re-used name does not run itself', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const { failedBefore, failedAfter } = await proveKind(ctx, 'backup', BACKUP_TASK, backupTaskBody)
      // GT-23 capture — printed so the ground-truth doc quotes the real thing.
      console.error(`GT-23 backup --- list-units --failed BEFORE the delete ---\n${failedBefore}`)
      console.error(`GT-23 backup --- list-units --failed AFTER the delete ---\n${failedAfter}`)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a cloud task: the same three facts under the anas-cloud- prefix', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const { failedBefore, failedAfter } = await proveKind(ctx, 'cloud', CLOUD_TASK, cloudTaskBody)
      console.error(`GT-23 cloud --- list-units --failed BEFORE the delete ---\n${failedBefore}`)
      console.error(`GT-23 cloud --- list-units --failed AFTER the delete ---\n${failedAfter}`)
    }
    finally {
      await ctx.dispose()
    }
  })
})
