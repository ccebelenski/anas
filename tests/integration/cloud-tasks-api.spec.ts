import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story rclone.2 (Cloud sync — tasks, runner, notifications) — LIVE PROOF over
 * the cloud tasks fixture on the stunt node
 * (test/stunt-node/cloud-tasks-fixture.sh up): real `anas-cloud-*` systemd
 * units, real rclone runs over sftp to the node's OWN sshd, a real ZFS dataset
 * as the source, and the real guards.
 *
 * Modelled on cloud-remotes-api.spec.ts: request-context API tests carrying the
 * PVEAuthCookie, gateway → local anasd → the real system; every claim checked
 * BOTH through the API and on the node itself (sshExec).
 *
 * What is proven, per the story's acceptance list:
 *   1. create → the two unit files with the `X-ANAS-Task=` marker and
 *      `Persistent=true`, the timer enabled, and `nextRunAt` equal to the
 *      timer's own next elapse
 *   2. Run Now → the files land byte-identical under the remote path, rclone's
 *      own counters come back on the result (`countersReported`), the unit's
 *      journal carries the run's result JSON, `lastRunResult: success`, and the
 *      run read from a TRANSIENT snapshot that no longer exists afterwards
 *   3. `sync` mirrors a source deletion to the destination; `copy` never does
 *   4. `sync` from an EMPTY source is refused in DESIGN's own words; `copy`
 *      from the same empty source completes as the harmless no-op it is
 *   5. a source on a configured-but-unmounted fstab mount is refused, naming
 *      the mount
 *   6. a wrong-password remote fails the run with rclone's own error line, the
 *      notification is emitted (the daemon journal carries the PVE::Notify
 *      call), `GET /v1/status` gains a `cloud` warning — and a SUCCESSFUL run
 *      of an `on-failure` task emits none
 *   7. a real TIMER fire (an absolute OnCalendar a minute out) produces the
 *      same history as a Run Now
 *   8. disable → `status: disabled` with the history note and a disabled timer;
 *      delete → the units are gone and nothing at the destination is touched;
 *      a remote a task still references refuses to delete, and deletes once it
 *      does not
 *   9. the dry-run preview (rclone.2 addendum) lists a source deletion as a
 *      would-be delete on the LIVE source (no snapshot), and refuses an
 *      unmounted-mount source naming the mount
 *
 * The fixture is taken DOWN and back UP in beforeAll (so a crashed earlier run
 * cannot be read as a "before") and DOWN in afterAll, leaving the node as
 * found: no `anas-cloud-*` units, no `gtbackup/cloud*` datasets, no fixture
 * fstab line, no `rclonegt`, and /etc/anas/rclone.conf back to its pre-state.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const SYSTEMD_DIR = '/etc/systemd/system'
const REMOTE = 'gt'
const BAD_REMOTE = 'gtbad'
const USER = 'rclonegt'
const PASS = 'gtpass'
const DST = `/home/${USER}/dst`
const SRC_DS = 'gtbackup/cloudsrc'
const SRC = `/${SRC_DS}`
const EMPTY_SRC = '/gtbackup/cloudempty'
const UNMOUNTED = '/mnt/gt-unmounted'

/** The absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-tasks-fixture.sh', import.meta.url).pathname

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
  timeout = 120_000,
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
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Submit a mutation, wait for its job, and require it to COMPLETE. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
  timeout = 120_000,
): Promise<any> {
  const res = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, job.error?.message).toBe('completed')
  return job.result
}

/**
 * Run a task through its own unit (the UI's Run Now path) and require the job
 * to COMPLETE. Returns the supervised result, whose `run` is the runner's own
 * result JSON recovered from the unit journal.
 */
async function runTask(ctx: APIRequestContext, name: string, timeout = 180_000): Promise<any> {
  return runJob(ctx, 'post', `${V1}/cloud/tasks/${name}/run`, {}, timeout)
}

/** Run a task expecting the job to FAIL; returns the failure message. */
async function runTaskExpectingFailure(ctx: APIRequestContext, name: string, timeout = 180_000): Promise<string> {
  const res = await ctx.post(`${V1}/cloud/tasks/${name}/run`, { data: {} })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, `expected a failed run, got ${job.status}`).toBe('failed')
  return job.error?.message ?? ''
}

/** A task's row as GET /v1/cloud/tasks lists it. */
async function taskRow(ctx: APIRequestContext, name: string): Promise<any> {
  const res = await ctx.get(`${V1}/cloud/tasks`)
  expect(res.status()).toBe(200)
  return (await res.json()).data.find((t: { name: string }) => t.name === name)
}

/** The task body the create/update doors take (the stored CloudSyncTask). */
function taskBody(over: Record<string, unknown>): Record<string, unknown> {
  return {
    source: SRC,
    remote: REMOTE,
    mode: 'copy',
    schedule: '*-*-* 03:00:00',
    notify: 'on-failure',
    enabled: true,
    ...over,
  }
}

/** Absolute paths of the regular files under a directory on the node. */
async function filesUnder(dir: string): Promise<string[]> {
  const out = await sshExec(`find ${dir} -type f 2>/dev/null | sort || true`)
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

/** `sha256sum` of the named paths relative to `dir` ('' for a missing file). */
async function sha256(dir: string, names: string[]): Promise<Record<string, string>> {
  const out = await sshExec(`cd ${dir} && sha256sum ${names.join(' ')} 2>/dev/null || true`)
  const map: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const [hash, ...rest] = line.trim().split(/\s+/)
    if (hash && rest.length)
      map[rest.join(' ')] = hash
  }
  return map
}

/** The transient snapshots of the source dataset ([] between runs). */
async function transientSnapshots(): Promise<string[]> {
  const out = await sshExec(`zfs list -H -o name -t snapshot -d 1 ${SRC_DS} 2>/dev/null || true`)
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

/** A journald cursor for the daemon's own unit — the "before" of a comparison. */
async function anasdCursor(): Promise<string> {
  const out = await sshExec('journalctl -u anasd -n 0 --no-pager --show-cursor')
  const cursor = out.split('-- cursor:').pop()?.trim() ?? ''
  expect(cursor, 'journalctl printed a cursor').not.toBe('')
  return cursor
}

/** Everything the daemon's unit journalled after `cursor`. */
async function anasdJournalSince(cursor: string): Promise<string> {
  return sshExec(`journalctl -u anasd --after-cursor='${cursor}' --no-pager -o short-iso`)
}

/**
 * How many PVE notifications the daemon emitted since `cursor`.
 *
 * `PVE::Notify` logs its own outcome line ("notified via target `<target>`")
 * to the journal — from the perl child, which runs inside anasd's cgroup, so
 * journald files it under `anasd.service` even though its stdout is a pipe the
 * executor holds (ground truth 2026-09-24). That line is the PROOF an emission
 * happened; PVE does not name the template in it, so the template that
 * rendered is proven the other way round — a missing `anas-cloud-*.hbs` pair
 * logs "could not notify via target … failed to render notification template"
 * instead, which {@link expectNotificationsSince} requires to be absent.
 */
async function notificationsSince(cursor: string): Promise<{ sent: number, renderFailures: number }> {
  const journal = await anasdJournalSince(cursor)
  const lines = journal.split('\n')
  return {
    sent: lines.filter(l => l.includes('notified via target')).length,
    renderFailures: lines.filter(l => l.includes('could not notify')).length,
  }
}

/** The unit journal for one task's service. */
async function unitJournal(name: string): Promise<string> {
  return sshExec(`journalctl -u anas-cloud-${name}.service -n 200 -o short-iso --no-pager`)
}

/** The runner's result JSON lines in a unit journal, newest last. */
function resultJsonLines(journal: string): any[] {
  const out: any[] = []
  for (const line of journal.split('\n')) {
    const idx = line.indexOf(']: ')
    const msg = idx >= 0 ? line.slice(idx + 3).trim() : ''
    if (!msg.startsWith('{'))
      continue
    try {
      const obj = JSON.parse(msg)
      if (obj?.result)
        out.push(obj)
    }
    catch {
      // not the result line
    }
  }
  return out
}

/** `systemctl show <unit> --value -p <prop>` on the node. */
async function systemctlValue(unit: string, prop: string): Promise<string> {
  return (await sshExec(`systemctl show ${unit} --value -p ${prop}`)).trim()
}

/**
 * A systemd timestamp string as unix seconds. An unset property (`''`, or the
 * `n/a` systemd prints for some) is NaN, never a number — a comparison against
 * NaN is false, which is the honest answer for "has this timer ever fired".
 */
async function nodeEpoch(stamp: string): Promise<number> {
  if (!stamp || stamp === 'n/a')
    return Number.NaN
  return Number(await sshExec(`date -u -d '${stamp}' +%s 2>/dev/null || echo nan`))
}

test.describe.configure({ mode: 'serial' })

test.describe('Cloud sync tasks (rclone.2)', () => {
  test.setTimeout(300_000)

  test.beforeAll(async ({ playwright }) => {
    // DOWN first: a crashed earlier run's units, datasets and fstab line are
    // not a "before" this spec should be reading.
    await execFileAsync(FIXTURE_SH, ['down'], { timeout: 300_000 })
    await execFileAsync(FIXTURE_SH, ['up'], { timeout: 300_000 })

    // A beforeAll hook may only use WORKER-scoped fixtures, so the session
    // ticket is fetched here rather than taken from the test-scoped
    // `pveTicket` (smbsvc-ui.spec.ts's pattern).
    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    expect(ticketRes.ok()).toBeTruthy()
    const ticket = (await ticketRes.json()).data.ticket as string
    await login.dispose()

    // The remote every task but the failure one points at: sftp to the node's
    // OWN sshd as the fixture user. Registered through the API, like a user
    // would (rclone.1's door).
    const ctx = await authedContext(playwright, ticket)
    try {
      await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
        name: REMOTE,
        type: 'sftp',
        options: { host: '127.0.0.1', user: USER, pass: PASS },
      })
    }
    finally {
      await ctx.dispose()
    }
  })

  test.afterAll(async () => {
    // Leave the node as found. Best-effort — an afterAll failure must not mask
    // the run's results.
    try {
      await execFileAsync(FIXTURE_SH, ['down'], { timeout: 300_000 })
    }
    catch (err) {
      console.error(`cloud tasks fixture down failed: ${err instanceof Error ? err.message : err}`)
    }
  })

  test('create a copy task: both units carry the marker, the timer is enabled and nextRunAt is its next elapse', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await runJob(ctx, 'post', `${V1}/cloud/tasks`, taskBody({
        name: 'gtcopy',
        path: 'dst/copy',
        mode: 'copy',
        schedule: '*-*-* 03:00:00',
        notify: 'on-failure',
      }))

      // The store IS the two unit files.
      const service = await sshExec(`cat ${SYSTEMD_DIR}/anas-cloud-gtcopy.service`)
      const timer = await sshExec(`cat ${SYSTEMD_DIR}/anas-cloud-gtcopy.timer`)
      expect(service, 'the service carries the X-ANAS-Task marker').toContain('X-ANAS-Task=')
      expect(service).toContain('SuccessExitStatus=75')
      expect(service).toContain('/opt/anas/packages/daemon/dist/cloud-task.js --name gtcopy')
      expect(timer, 'a missed fire is caught up').toContain('Persistent=true')
      expect(timer).toContain('OnCalendar=*-*-* 03:00:00')

      // The marker JSON is the canonical task, not a re-derivation.
      const marker = service.split('\n').find(l => l.includes('X-ANAS-Task='))!
      const stored = JSON.parse(marker.slice(marker.indexOf('X-ANAS-Task=') + 'X-ANAS-Task='.length))
      expect(stored).toMatchObject({
        name: 'gtcopy',
        source: SRC,
        remote: REMOTE,
        path: 'dst/copy',
        mode: 'copy',
        notify: 'on-failure',
        enabled: true,
      })

      // systemd's own view, and the API's, of the same timer.
      expect(await systemctlValue('anas-cloud-gtcopy.timer', 'UnitFileState')).toBe('enabled')
      const row = await taskRow(ctx, 'gtcopy')
      expect(row.enabled).toBe(true)
      expect(row.lastRunResult).toBe('never-run')
      const nextElapse = await systemctlValue('anas-cloud-gtcopy.timer', 'NextElapseUSecRealtime')
      expect(nextElapse, 'the timer has a next elapse').not.toBe('')
      expect(Math.floor(Date.parse(row.nextRunAt) / 1000)).toBe(await nodeEpoch(nextElapse))
    }
    finally {
      await ctx.dispose()
    }
  })

  test('Run Now: the files land byte-identical, rclone\'s counters come back, and the run read a transient snapshot that is gone afterwards', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const sourceHashes = await sha256(SRC, ['a.bin', 'b.bin', 'sub/c.txt'])
      expect(Object.keys(sourceHashes), 'the fixture staged three files').toHaveLength(3)

      const supervised = await runTask(ctx, 'gtcopy')
      expect(supervised.status).toBe('success')
      expect(supervised.alreadyRunning).toBe(false)

      // The run's own numbers, recovered from the unit journal — rclone's, not
      // ours. `countersReported` says rclone actually printed a stats object.
      const run = supervised.run
      expect(run.status).toBe('success')
      expect(run.mode).toBe('copy')
      expect(run.countersReported, 'rclone reported its counters').toBe(true)
      expect(run.bytes).toBeGreaterThan(0)
      expect(run.transfers).toBe(3)
      expect(run.errors).toBe(0)
      expect(run.errorLines).toEqual([])
      expect(run.destination).toBe(`${REMOTE}:dst/copy`)

      // The source was the TRANSIENT SNAPSHOT, not the live tree.
      expect(run.consistency.consistency).toBe('snapshot')
      expect(run.consistency.backend).toBe('zfs')
      expect(run.consistency.target).toBe(SRC_DS)
      expect(run.snapshot).toMatch(new RegExp(`^${SRC_DS}@anas-cloud-gtcopy-\\d+$`))
      expect(run.source).toBe(`${SRC}/.zfs/snapshot/${run.snapshot.split('@')[1]}`)
      // ...and it was destroyed in the run's `finally`.
      expect(await transientSnapshots(), 'no transient snapshot outlived the run').toEqual([])

      // The node: the three files under the remote path, byte for byte.
      expect(await filesUnder(`${DST}/copy`)).toEqual([
        `${DST}/copy/a.bin`,
        `${DST}/copy/b.bin`,
        `${DST}/copy/sub/c.txt`,
      ])
      expect(await sha256(`${DST}/copy`, ['a.bin', 'b.bin', 'sub/c.txt'])).toEqual(sourceHashes)

      // The unit's own journal carries the run's result JSON with the stats.
      const results = resultJsonLines(await unitJournal('gtcopy'))
      expect(results.length, 'the unit journalled its result').toBeGreaterThan(0)
      const journalled = results.at(-1)
      expect(journalled.task).toBe('gtcopy')
      expect(journalled.result.bytes).toBe(run.bytes)
      expect(journalled.result.transfers).toBe(3)
      expect(journalled.result.snapshot).toBe(run.snapshot)

      // And the grid's derived status.
      const row = await taskRow(ctx, 'gtcopy')
      expect(row.lastRunResult).toBe('success')
      expect(row.lastRunAt).not.toBeNull()
      expect(row.overdue).toBe(false)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('sync mirrors a source deletion to the destination; copy never deletes', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await runJob(ctx, 'post', `${V1}/cloud/tasks`, taskBody({
        name: 'gtsync',
        path: 'dst/sync',
        mode: 'sync',
        schedule: '*-*-* 03:30:00',
      }))

      // First run: the mirror is made.
      const first = await runTask(ctx, 'gtsync')
      expect(first.run.mode).toBe('sync')
      expect(first.run.transfers).toBe(3)
      expect(await filesUnder(`${DST}/sync`)).toEqual([
        `${DST}/sync/a.bin`,
        `${DST}/sync/b.bin`,
        `${DST}/sync/sub/c.txt`,
      ])

      // The source loses a file.
      await sshExec(`rm -f ${SRC}/b.bin && sync`)
      expect(await filesUnder(SRC)).toEqual([`${SRC}/a.bin`, `${SRC}/sub/c.txt`])

      // Second sync run: the deletion is mirrored.
      const second = await runTask(ctx, 'gtsync')
      expect(second.run.deletes, 'rclone deleted the file at the destination').toBe(1)
      expect(await filesUnder(`${DST}/sync`)).toEqual([
        `${DST}/sync/a.bin`,
        `${DST}/sync/sub/c.txt`,
      ])

      // The copy task over the SAME source: b.bin stays at its destination.
      // That is the whole difference between the two modes, and it is why
      // `copy` is the default (it cannot destroy anything).
      const again = await runTask(ctx, 'gtcopy')
      expect(again.run.deletes).toBe(0)
      expect(await filesUnder(`${DST}/copy`), 'copy never deletes at the destination').toEqual([
        `${DST}/copy/a.bin`,
        `${DST}/copy/b.bin`,
        `${DST}/copy/sub/c.txt`,
      ])
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a dry-run preview lists the would-be deletes on the live source — and refuses an unmounted mount', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The source lost b.bin in the previous test, but that test's second
      // sync already mirrored the deletion — so stage the would-be delete
      // ourselves: b.bin is absent from the LIVE source, so put it back at
      // the destination and a sync preview must name it. The content is
      // irrelevant; a would-be delete is presence at the destination,
      // absence at the source.
      await sshExec(`echo gt > ${DST}/sync/b.bin && chown ${USER}: ${DST}/sync/b.bin && sync`)
      expect(await filesUnder(`${DST}/sync`)).toEqual([
        `${DST}/sync/a.bin`,
        `${DST}/sync/b.bin`,
        `${DST}/sync/sub/c.txt`,
      ])

      // The sync PREVIEW of the saved task must read the live source and name
      // b.bin as a would-be delete — rclone's own `skipped: delete` object,
      // counted in its own `deletes` counter.
      const res = await ctx.post(`${V1}/cloud/tasks/preview`, { data: { name: 'gtsync' } })
      expect(res.status(), await res.text()).toBe(200)
      const preview = (await res.json()).data
      expect(preview.truncated, 'the look finished inside the 120 s ceiling').toBe(false)
      expect(preview.deletes).toBeGreaterThanOrEqual(1)
      expect(preview.deletedFiles).toContain('b.bin')
      expect(preview.deletedTotal, 'the count and the list agree on a small destination').toBe(preview.deletedFiles.length)

      // A preview is a LOOK, not a run: no snapshot was taken, and nothing
      // was written or deleted at the destination — b.bin is still there.
      expect(await transientSnapshots(), 'a preview takes no snapshot').toEqual([])
      expect(await filesUnder(`${DST}/sync`)).toEqual([
        `${DST}/sync/a.bin`,
        `${DST}/sync/b.bin`,
        `${DST}/sync/sub/c.txt`,
      ])

      // And the guard: a source on a configured-but-unmounted mount is a 400
      // naming the mount — never a 200 that would have read through the empty
      // mountpoint and reported "nothing to do".
      const refused = await ctx.post(`${V1}/cloud/tasks/preview`, { data: { source: UNMOUNTED, remote: REMOTE } })
      expect(refused.status(), await refused.text()).toBe(400)
      const err = await refused.json()
      expect(err.error.message).toContain(`${UNMOUNTED} is a mount defined in /etc/fstab but not mounted right now`)
      expect(err.error.message).toContain(`Mount ${UNMOUNTED} and run it again.`)

      // The FAILING preview (a dry run rclone itself cannot complete) is
      // proven in the wrong-password test below — BAD_REMOTE is created
      // there, and this spec runs serially.
    }
    finally {
      await ctx.dispose()
    }
  })

  test('an empty source is refused in sync mode with the sentence, and is a harmless no-op in copy mode', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await runJob(ctx, 'post', `${V1}/cloud/tasks`, taskBody({
        name: 'gtempty',
        source: EMPTY_SRC,
        path: 'dst/empty',
        mode: 'sync',
        schedule: '*-*-* 04:00:00',
      }))
      expect(await sshExec(`ls -A ${EMPTY_SRC} | wc -l`), 'the fixture source is empty').toBe('0')

      // The catastrophic shape: a sync from an empty source would delete
      // everything at the destination. The run is refused up front, in
      // DESIGN's own words, with the recovery command spelled out.
      const refusal = await runTaskExpectingFailure(ctx, 'gtempty')
      expect(refusal).toContain(`${EMPTY_SRC} is empty and this task syncs`)
      expect(refusal).toContain('an empty source in sync mode would delete everything at the destination')
      expect(refusal).toContain('rclone --config /etc/anas/rclone.conf purge gt:dst/empty')
      expect(await taskRow(ctx, 'gtempty')).toMatchObject({ lastRunResult: 'failure' })

      // `copy` from the same empty source has nothing to guard: it never
      // deletes, so an empty source is a no-op, not a catastrophe.
      await runJob(ctx, 'post', `${V1}/cloud/tasks`, taskBody({
        name: 'gtemptycopy',
        source: EMPTY_SRC,
        path: 'dst/empty',
        mode: 'copy',
        schedule: '*-*-* 04:30:00',
      }))
      const run = await runTask(ctx, 'gtemptycopy')
      expect(run.status).toBe('success')
      expect(run.run.transfers).toBe(0)
      expect(run.run.errors).toBe(0)
      expect(await taskRow(ctx, 'gtemptycopy')).toMatchObject({ lastRunResult: 'success' })
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a source on a configured-but-unmounted mount is refused, naming the mount', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The boot-race shape the guard exists for: an fstab CIFS entry that is
      // not mounted, with an empty mountpoint directory sitting where a share
      // should be. Reading through it would copy (or, in sync mode, mirror)
      // nothing at all.
      expect(await sshExec(`grep -c ' ${UNMOUNTED} cifs ' /etc/fstab || true`), 'the fstab entry is there').toBe('1')
      expect(await sshExec(`findmnt -n ${UNMOUNTED} >/dev/null 2>&1 && echo mounted || echo unmounted`)).toBe('unmounted')

      await runJob(ctx, 'post', `${V1}/cloud/tasks`, taskBody({
        name: 'gtunmounted',
        source: UNMOUNTED,
        path: 'dst/nope',
        schedule: '*-*-* 05:00:00',
      }))

      const refusal = await runTaskExpectingFailure(ctx, 'gtunmounted')
      expect(refusal).toContain(`${UNMOUNTED} is a mount defined in /etc/fstab but not mounted right now`)
      expect(refusal).toContain('the run is refused instead of reading through it')
      expect(refusal).toContain(`Mount ${UNMOUNTED} and run it again.`)
      expect(await taskRow(ctx, 'gtunmounted')).toMatchObject({ lastRunResult: 'failure' })
      // Nothing was created at the remote for a refused run.
      expect(await filesUnder(`${DST}/nope`)).toEqual([])
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a wrong-password remote fails the run with rclone\'s error line, notifies, and shows as a cloud warning — a quiet success does not notify', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // First half: a SUCCESSFUL run of an `on-failure` task must emit no
      // notification at all. Counted over the daemon's own journal.
      const quietCursor = await anasdCursor()
      await runTask(ctx, 'gtcopy')
      const quiet = await notificationsSince(quietCursor)
      expect(quiet.sent, 'a success under notify:on-failure notifies nobody').toBe(0)

      // Second half: a remote whose password is wrong. Everything else about
      // it is right, so the failure is rclone's own and nothing else's.
      await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
        name: BAD_REMOTE,
        type: 'sftp',
        options: { host: '127.0.0.1', user: USER, pass: 'wrong-password' },
      })
      await runJob(ctx, 'post', `${V1}/cloud/tasks`, taskBody({
        name: 'gtfail',
        remote: BAD_REMOTE,
        path: 'dst/fail',
        schedule: '*-*-* 06:00:00',
        // `always` here, so the ONE notification this window sees can only be
        // the failure's (the mode gate is not what is under test).
        notify: 'always',
      }))

      const cursor = await anasdCursor()
      const failure = await runTaskExpectingFailure(ctx, 'gtfail')
      // rclone's own line, verbatim, with the exit code ANAS classified on.
      expect(failure).toContain('rclone copy failed (exit 1)')
      expect(failure).toContain(`Failed to create file system for "${BAD_REMOTE}:dst/fail"`)
      expect(failure).toContain('couldn\'t connect SSH')
      expect(failure, 'no secret rides the failure message').not.toContain('wrong-password')

      // The FAILING PREVIEW (rclone.2 addendum, fix batch 2026-09-24). It
      // belongs with the preview test above, but BAD_REMOTE is created here —
      // and the spec is serial, so this is the first place it exists. The
      // shape under test: a dry run that fails is still 200 (a preview is a
      // read), and its `errors` carry rclone's OWN sentence. A preview that
      // answered zero counters with an empty `errors` would be
      // byte-identical to an honest "nothing to do", which is the one lie
      // this endpoint must never tell.
      const failedPreview = await ctx.post(`${V1}/cloud/tasks/preview`, {
        data: { source: SRC, remote: BAD_REMOTE, path: 'dst/fail', mode: 'copy' },
      })
      expect(failedPreview.status(), await failedPreview.text()).toBe(200)
      const bad = (await failedPreview.json()).data
      expect(bad.errors.length, 'the failure is reported, not swallowed').toBeGreaterThan(0)
      expect(bad.errors[0]).toMatch(/NewFs|couldn't connect SSH/)
      expect(bad.truncated, 'rclone\'s own retries finish inside the 120 s ceiling').toBe(false)
      expect(bad.transfers).toBe(0)
      expect(bad.bytes).toBe(0)
      expect(bad.checks).toBe(0)
      expect(bad.deletes).toBe(0)
      expect(bad.deletedFiles).toEqual([])
      expect(bad.deletedTotal).toBe(0)
      // GROUND TRUTH OWED: the first run of this spec must capture rclone's
      // own stderr for this dry run and save it VERBATIM as
      // `packages/daemon/src/fixtures/rclone/dry-run-auth-fail-1.60.1.log`
      // (`rclone copy <SRC> gtbad:dst/fail --dry-run --use-json-log
      // --stats 30s --stats-log-level NOTICE --config /etc/anas/rclone.conf
      // --ask-password=false` on the node, stderr only). The unit test in
      // `cloud-preview.test.ts` reads that file when it exists and says in
      // its own name when it is still working from the hand-written shape.

      // The notification. PVE::Notify logs its outcome from the perl child in
      // anasd's cgroup, so the daemon's own journal carries the call; a
      // missing anas-cloud template pair would log a render failure instead,
      // so an emission with no render failure proves the pair rendered.
      const notified = await notificationsSince(cursor)
      expect(notified.sent, 'the failed run emitted a PVE notification').toBeGreaterThan(0)
      expect(notified.renderFailures, 'the anas-cloud template pair rendered').toBe(0)

      // And the dashboard's pull-only warning for the category.
      const statusRes = await ctx.get(`${V1}/status`)
      expect(statusRes.status()).toBe(200)
      const warnings = (await statusRes.json()).data.warnings as { category: string, ref: string, message: string }[]
      const cloud = warnings.find(w => w.category === 'cloud' && w.ref === 'gtfail')
      expect(cloud, 'GET /v1/status carries a cloud warning for gtfail').toBeTruthy()
      expect(cloud!.message).toContain('gtfail')
      expect(cloud!.message).toContain('Cloud Sync')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a real timer fire produces the same history as a Run Now', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // A REAL fire, not `systemctl start`: an absolute OnCalendar a little
      // over a minute out, which systemd accepts and elapses once. That is the
      // path a scheduled run actually takes, timer trigger included.
      const schedule = await sshExec('date -u -d \'+75 seconds\' +\'%Y-%m-%d %H:%M:%S\'')
      expect(await sshExec(`systemd-analyze calendar '${schedule}' | head -n1`)).toContain('Normalized form')
      const scheduledAt = await nodeEpoch(schedule)

      const before = resultJsonLines(await unitJournal('gtcopy')).length
      await runJob(ctx, 'put', `${V1}/cloud/tasks/gtcopy`, taskBody({
        name: 'gtcopy',
        path: 'dst/copy',
        schedule,
      }))
      expect(await systemctlValue('anas-cloud-gtcopy.timer', 'UnitFileState')).toBe('enabled')

      // Wait for the unit to run and finish, on the timer's own clock.
      const deadline = Date.now() + 210_000
      let ran = false
      while (Date.now() < deadline) {
        const trigger = await nodeEpoch(await systemctlValue('anas-cloud-gtcopy.timer', 'LastTriggerUSec'))
        const active = await systemctlValue('anas-cloud-gtcopy.service', 'ActiveState')
        if (trigger >= scheduledAt && active === 'inactive') {
          ran = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
      expect(ran, 'the timer elapsed and its service finished').toBe(true)

      // The timer really is what triggered it.
      const trigger = await nodeEpoch(await systemctlValue('anas-cloud-gtcopy.timer', 'LastTriggerUSec'))
      expect(trigger).toBeGreaterThanOrEqual(scheduledAt)
      expect(await systemctlValue('anas-cloud-gtcopy.service', 'Result')).toBe('success')

      // The same history a manual run leaves: one more result JSON in the unit
      // journal, and the grid's last result derived from systemd.
      const after = resultJsonLines(await unitJournal('gtcopy'))
      expect(after.length, 'the scheduled fire journalled its own result').toBeGreaterThan(before)
      expect(after.at(-1).result.status).toBe('success')
      expect(after.at(-1).result.consistency.consistency).toBe('snapshot')

      const row = await taskRow(ctx, 'gtcopy')
      expect(row.lastRunResult).toBe('success')
      expect(Date.parse(row.lastRunAt) / 1000).toBeGreaterThanOrEqual(scheduledAt)
      expect(await transientSnapshots(), 'the scheduled run cleaned up after itself too').toEqual([])
    }
    finally {
      await ctx.dispose()
    }
  })

  test('disable leaves the history note; delete removes the units and touches nothing at the destination; a referenced remote refuses to go', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // --- disable ------------------------------------------------------
      await runJob(ctx, 'put', `${V1}/cloud/tasks/gtcopy`, taskBody({
        name: 'gtcopy',
        path: 'dst/copy',
        enabled: false,
      }))
      expect(await sshExec('systemctl is-enabled anas-cloud-gtcopy.timer || true')).toBe('disabled')
      expect(await sshExec('systemctl is-active anas-cloud-gtcopy.timer || true')).toBe('inactive')

      const disabled = await taskRow(ctx, 'gtcopy')
      expect(disabled.enabled).toBe(false)
      // systemd garbage-collects a disabled unit's run history, so there is no
      // durable last result to report — and the detail says so rather than
      // inventing one.
      expect(disabled.lastRunResult).toBe('disabled')
      expect(disabled.nextRunAt).toBeNull()
      const detailRes = await ctx.get(`${V1}/cloud/tasks/gtcopy`)
      expect(detailRes.status()).toBe(200)
      const detail = (await detailRes.json()).data
      expect(detail.statusNote).toBe('run history is not retained while a task is disabled')
      expect(detail.unit).toContain('X-ANAS-Task=')
      expect(detail.timer).toContain('Persistent=true')

      // --- delete -------------------------------------------------------
      const keptAtDestination = await sha256(`${DST}/copy`, ['a.bin', 'b.bin', 'sub/c.txt'])
      expect(Object.keys(keptAtDestination)).toHaveLength(3)

      await runJob(ctx, 'delete', `${V1}/cloud/tasks/gtcopy`)
      expect(await sshExec(`ls ${SYSTEMD_DIR} | grep -c anas-cloud-gtcopy || true`)).toBe('0')
      expect(await ctx.get(`${V1}/cloud/tasks/gtcopy`).then(r => r.status())).toBe(404)
      // Deleting a schedule is not deleting data.
      expect(await sha256(`${DST}/copy`, ['a.bin', 'b.bin', 'sub/c.txt'])).toEqual(keptAtDestination)

      // --- the remote's referenced-refusal --------------------------------
      // Everything else naming `gt` goes, leaving exactly one task behind.
      for (const name of ['gtempty', 'gtemptycopy', 'gtunmounted'])
        await runJob(ctx, 'delete', `${V1}/cloud/tasks/${name}`)

      const refused = await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`)
      expect(refused.status(), await refused.text()).toBe(409)
      const body = await refused.json()
      expect(body.error.code).toBe('CONFLICT')
      expect(body.error.message).toContain('gtsync')
      expect(body.error.message).toContain('remove or retarget them first')

      // Once nothing references it, the remote deletes.
      await runJob(ctx, 'delete', `${V1}/cloud/tasks/gtsync`)
      await runJob(ctx, 'delete', `${V1}/cloud/remotes/${REMOTE}`)
      const remotes = await ctx.get(`${V1}/cloud/remotes`).then(r => r.json())
      expect(remotes.data.remotes.map((r: { name: string }) => r.name)).not.toContain(REMOTE)

      // The failure task and its bad remote go too, so the node is left with
      // no anas-cloud unit at all.
      await runJob(ctx, 'delete', `${V1}/cloud/tasks/gtfail`)
      await runJob(ctx, 'delete', `${V1}/cloud/remotes/${BAD_REMOTE}`)
      expect(await sshExec(`ls ${SYSTEMD_DIR} | grep -c anas-cloud || true`)).toBe('0')
      expect((await ctx.get(`${V1}/cloud/tasks`).then(r => r.json())).data).toEqual([])
    }
    finally {
      await ctx.dispose()
    }
  })
})
