import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import {
  datasetExists,
  makeDir,
  removeShareUser,
  removeSmbShare,
  skipIfFixtureMissing,
  sshExec,
} from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story smbsvc.1 (Previous Versions on SMB shares) — LIVE PROOF over the
 * smbsvc fixture on the stunt node (test/stunt-node/smbsvc-fixture.sh up).
 * Modelled on pvepool-api.spec.ts: request-context API tests carrying the
 * PVEAuthCookie, gateway → local anasd → real smb.conf/smbd/smbclient.
 *
 * The fixture (gtbackup/pvshare — a child of the node's existing gtbackup
 * pool; NEVER touch its siblings cdm/img2):
 *   report.txt carries one content version per snapshot:
 *     v1  @anas-daily-2026-09-20T100000Z   (schedule-shaped)
 *     v2  @anas-hourly-2026-09-22T110000Z  (schedule-shaped)
 *         @keep-me                          (manual)
 *     v3  live
 *
 * What is proven, per DESIGN.md "Self-service on SMB shares":
 *   1. schedules for the dataset exist (hourly + daily, both ENABLED — the
 *      bucket pick reads the SCHEDULE store, never the snapshot names) →
 *      share created plain, its stanza captured → PUT previousVersions
 *      enabled → job completes → detail reads bucket 'hourly' (the finest
 *      present) → the stanza on the node carries the composed
 *      `vfs objects = shadow_copy2` line and the exact managed `shadow:*` keys
 *   2. smbclient ON THE NODE, authenticated as the share user: allinfo lists
 *      exactly the hourly snapshot's @GMT entry (none for daily/manual), and
 *      `get @GMT-…/report.txt` returns the v2 content
 *   3. PUT disable → job → the stanza has no `vfs objects` / `shadow:` keys
 *      and is byte-identical to the pre-enable stanza captured in (1)
 *   4. refusals (400, sentences verbatim): enabling on a share whose path is
 *      a plain directory under /var/tmp ("not on a ZFS dataset or an AHR
 *      pool"), and enabling on a share carrying a hand-written
 *      `vfs objects = acl_xattr` line ("custom vfs objects line")
 *   5. the AHR half on REAL disks (`smbsvc-fixture.sh ahr-up` — loop devices
 *      have no /dev/disk/by-id entry and the daemon addresses AHR create disks
 *      exclusively by by-id): pool `ahrpv` created through POST /v1/ahr
 *      (confirm flow), share + Previous Versions → absolute
 *      `shadow:snapdir` into the ONE read-only `@snapshots` fstab mount,
 *      smbclient puts a file, POST /v1/ahr/ahrpv/snapshots, the old content
 *      reads back through @GMT, re-enable/second-share reuse the mount,
 *      disable keeps the mount (by design), and DESTROY takes the mount AND
 *      its fstab line with the pool
 *   6. the Time Machine target (smbsvc.3, BETA) addendum: enabling with a
 *      500 GiB cap on pvshare writes the composed `vfs objects = catia fruit
 *      streams_xattr` line and the fruit keys — and NOTHING else (the
 *      enforced durable-handles / posix-locking / kernel-oplocks settings are
 *      vfs_fruit's own connect-time consequences, which GT 2026-09-23 showed
 *      testparm cannot display: `--parameter-name` answers the unchanged
 *      default identically for [global] and the TM share). `testparm -s` ON
 *      THE NODE shows the share with the fruit keys as written.
 *      Client-side proof = community (no current macOS on the bench).
 *
 * Every test leaves the node as found: the shares, schedules, and share users
 * this file creates are removed through their own API doors (best-effort
 * safety nets behind them), and the fixtures are torn down (down + ahr-down)
 * in afterAll.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const DATASET = 'gtbackup/pvshare'
const SHARE_PATH = '/gtbackup/pvshare'
const SHARE = 'pvshare'
const SHARE_FILE = 'report.txt'
const SHARE_USER = 'smbsvc_pv'
const SHARE_PW = 'anas-pv-proof'
const V2_CONTENT = 'pv report v2'
const V3_CONTENT = 'pv report v3'

const HOURLY_SCHEDULE = 'smbsvc-proof-hourly'
const DAILY_SCHEDULE = 'smbsvc-proof-daily'
// vfs_shadow_copy2 renders the ANAS format as a @GMT path with dots/colons.
const HOURLY_GMT = '@GMT-2026.09.22-11.00.00'
const DAILY_GMT = '@GMT-2026.09.20-10.00.00'

const REFUSAL_DIR = '/var/tmp/smbsvc-refusal'
const REFUSAL_SHARE = 'pvrefusal'
const CUSTOM_SHARE = 'pvcustom'

// ---- The AHR half (test 5) — real disks, the pool made through the API ------

const AHR_POOL = 'ahrpv'
const AHR_MOUNT = `/mnt/anas-ahr/${AHR_POOL}`
const AHR_SNAP_MOUNT = `/mnt/anas-ahr-snapshots/${AHR_POOL}`
const AHR_SHARE = 'ahrpv'
const AHR_SHARE2 = 'ahrpv-two'
const AHR_SHARE_FILE = 'docs.txt'
const AHR_USER = 'smbsvc_ahr'
const AHR_PW = 'anas-ahr-proof'
// No schedule targets an AHR pool in this file → the design's fallback bucket.
const AHR_SNAP_FORMAT = 'anas-daily-%Y-%m-%dT%H%M%SZ'
const AHR_SNAPSHOT = 'anas-daily-2026-09-22T100000Z'
// vfs_shadow_copy2 renders the ANAS format as a @GMT path with dots/colons.
const AHR_GMT = '@GMT-2026.09.22-10.00.00'
const AHR_V1 = 'ahr pv report v1'
const AHR_V2 = 'ahr pv report v2'
// The fixture's two AHR disks (smbsvc-fixture.sh ahr-up): hot slots 7+8 —
// 1–6 belong to other specs. Serial → by-id prefix.
const AHR_HOT_SERIALS = ['ANAS_HOT7', 'ANAS_HOT8']
const AHR_BY_ID = AHR_HOT_SERIALS.map(s => `scsi-0QEMU_QEMU_HARDDISK_${s}`)

/** The plain-share stanza, captured on the node before the feature goes on. */
let stanzaBeforeEnable = ''

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
  timeout = 90_000,
): Promise<{ status: string, error?: string, [k: string]: any }> {
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

/** Submit a mutation, wait for its job, and require it to complete. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
  headers?: Record<string, string>,
  timeout = 90_000,
): Promise<void> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers !== undefined ? { headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, job.error).toBe('completed')
}

/** Drive the standard 409-challenge → confirm → 202 share-removal flow. */
async function removeShareViaApi(
  ctx: APIRequestContext,
  name: string,
): Promise<void> {
  const challenge = await ctx.delete(`${V1}/shares/smb/${name}`)
  if (challenge.status() === 404)
    return
  expect(challenge.status()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  await runJob(ctx, 'delete', `${V1}/shares/smb/${name}`, undefined, { 'x-anas-confirm': code })
}

/**
 * The share's stanza exactly as it stands in /etc/samba/smb.conf on the node —
 * the section header line through the last line before the next section (or
 * EOF, trailing newlines stripped). This is the byte-exact text the
 * byte-identical rollback check compares. The extractor ships base64-encoded
 * so no quoting survives the trip through ssh.
 */
async function shareStanza(name: string): Promise<string> {
  const py = [
    `import re`,
    `s = open('/etc/samba/smb.conf').read()`,
    `m = re.search(r'(?ms)^\\[${name}\\].*?(?=^\\[|\\Z)', s)`,
    `print(m.group(0).rstrip('\\n') if m else '')`,
  ].join('\n')
  const b64 = Buffer.from(py, 'utf8').toString('base64')
  return sshExec(`echo ${b64} | base64 -d | python3`)
}

/** smbclient ON THE NODE, authenticated as a share user. */
async function smbClientAs(share: string, user: string, pw: string, commands: string): Promise<string> {
  return sshExec(
    `smbclient //localhost/${share} -U ${user}%${pw} -c '${commands}'`,
  )
}

/** smbclient ON THE NODE, authenticated as the ZFS fixture's share user. */
function smbClient(commands: string): Promise<string> {
  return smbClientAs(SHARE, SHARE_USER, SHARE_PW, commands)
}

/** The /etc/fstab lines containing `needle`, as they stand on the node. */
async function fstabLinesMatching(needle: string): Promise<string[]> {
  const out = await sshExec(`grep -F '${needle}' /etc/fstab || true`)
  return out === '' ? [] : out.split('\n')
}

/** A file's presence on the node — `test -e` that never throws. */
async function fileExists(path: string): Promise<boolean> {
  return (await sshExec(`test -e '${path}' && echo yes || echo no`)) === 'yes'
}

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/smbsvc-fixture.sh', import.meta.url).pathname

/**
 * Skip the whole file when the fixture cannot be made present. The `up` here
 * is a self-heal, not the primary build (that is `smbsvc-fixture.sh up`, run by
 * hand): Playwright ENDS THE WORKER after any failed test, and the old
 * worker's teardown runs this file's afterAll — tearing the fixture down
 * mid-run. The next worker re-ups it and continues instead of skipping.
 */
test.beforeEach(async () => {
  if (!(await datasetExists(DATASET)))
    await execFileAsync(FIXTURE_SH, ['up']).catch(() => {})
  skipIfFixtureMissing(!(await datasetExists(DATASET)), 'smbsvc fixture not present — run test/stunt-node/smbsvc-fixture.sh up')
})

test.describe('Previous Versions on SMB shares (smbsvc.1)', () => {
  test.setTimeout(180_000)

  test.afterAll(async ({ playwright }) => {
    // Leave the node as found: everything this file created is removed —
    // schedules and the share user through their own API doors, the shares
    // through the confirm flow — and finally the fixture is torn down
    // (smbsvc-fixture.sh down, which also sweeps a leaked [pvshare] stanza).
    // All best-effort: an afterAll failure must not mask the run's results.
    // The ticket is fetched here (afterAll sees no test-scoped fixtures) with
    // the same PVE login the auth fixture uses.
    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    const ticket = (await ticketRes.json()).data.ticket as string
    await login.dispose()
    const ctx = await authedContext(playwright, ticket)
    try {
      for (const id of [HOURLY_SCHEDULE, DAILY_SCHEDULE]) {
        try {
          await runJob(ctx, 'delete', `${V1}/schedules/${id}`)
        }
        catch { /* best-effort */ }
      }
      for (const user of [SHARE_USER, AHR_USER]) {
        try {
          const challenge = await ctx.delete(`${V1}/identity/users/${user}`)
          const code = challenge.headers()['x-anas-confirm-code']
          if (challenge.status() === 409 && code)
            await runJob(ctx, 'delete', `${V1}/identity/users/${user}`, undefined, { 'x-anas-confirm': code })
        }
        catch { /* best-effort */ }
      }
      for (const name of [SHARE, REFUSAL_SHARE, CUSTOM_SHARE, AHR_SHARE, AHR_SHARE2]) {
        try {
          await removeShareViaApi(ctx, name)
        }
        catch {
          await removeSmbShare(name).catch(() => {})
        }
      }
    }
    finally {
      await ctx.dispose()
      await removeShareUser(SHARE_USER).catch(() => {})
      await removeShareUser(AHR_USER).catch(() => {})
      await sshExec(`rm -rf ${REFUSAL_DIR}`).catch(() => {})
      await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
      // The AHR half's disks and any pool remnants — idempotent, silent when
      // test 5 never ran (or destroyed everything through the API itself).
      await execFileAsync(FIXTURE_SH, ['ahr-down']).catch(() => {})
    }
  })

  test('1 — enable through the API: bucket = finest ENABLED schedule (hourly); stanza carries the composed VFS line and the managed shadow keys', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The schedule store decides the bucket — two ENABLED schedules on this
      // dataset, hourly and daily; the daemon must pick the finest (hourly).
      for (const [id, cadence] of [[HOURLY_SCHEDULE, 'hourly'], [DAILY_SCHEDULE, 'daily']] as const) {
        await runJob(ctx, 'post', `${V1}/schedules`, {
          id,
          name: `smbsvc proof ${cadence}`,
          target: { kind: 'zfs', dataset: DATASET },
          cadence,
          retention: cadence === 'hourly' ? { hourly: 2 } : { daily: 3 },
          enabled: true,
        })
      }

      // A share user with an SMB password (created through the identity API —
      // the same door the Shares UI uses), so smbclient can authenticate.
      await runJob(ctx, 'post', `${V1}/identity/users`, { name: SHARE_USER, smbPassword: SHARE_PW })

      // The share is created PLAIN; its stanza is captured byte-exact so
      // test 3 can require the disable round trip to restore it.
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: SHARE, path: SHARE_PATH })
      const plain = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect(plain.status()).toBe(200)
      expect((await plain.json()).data.previousVersions).toBeUndefined()
      stanzaBeforeEnable = await shareStanza(SHARE)
      expect(stanzaBeforeEnable).toContain(`path = ${SHARE_PATH}`)
      expect(stanzaBeforeEnable).not.toContain('vfs objects')

      // Enable → job → detail derives the bucket from the stanza.
      await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { previousVersions: { enabled: true } })
      const detail = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect(detail.status()).toBe(200)
      expect((await detail.json()).data.previousVersions).toEqual({ bucket: 'hourly' })

      // The stanza on the node — the source of truth — carries the composer's
      // line and the exact managed keys DESIGN.md names.
      const stanza = await shareStanza(SHARE)
      expect(stanza).toContain('vfs objects = shadow_copy2')
      expect(stanza).toContain('shadow:format = anas-hourly-%Y-%m-%dT%H%M%SZ')
      expect(stanza).toContain('shadow:snapdir = .zfs/snapshot')
      expect(stanza).toContain('shadow:snapdirseverywhere = yes')
      expect(stanza).toContain('shadow:localtime = no')

      // testparm accepts the config as written (the daemon gated the write
      // already — this is the independent check from the node).
      expect(await sshExec('testparm -s 2>&1 || true')).not.toContain('ERROR')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('2 — smbclient on the node: allinfo lists exactly the hourly snapshot; the v2 content reads back through @GMT', async () => {
    // The live file is reachable as the share user (the share exists and
    // authenticates — precondition for every shadow-copy check below).
    // smbclient prints its progress to STDERR, so the verdict is the exit
    // status (sshExec throws on non-zero) plus the file content it produced.
    const tmp = '/var/tmp/smbsvc-live.txt'
    await smbClient(`get ${SHARE_FILE} ${tmp}`)
    expect(await sshExec(`cat ${tmp} && rm -f ${tmp}`)).toBe(V3_CONTENT)

    // Previous Versions enumerates ONLY the hourly bucket: the daily
    // schedule-shaped snapshot and the manual `keep-me` never appear.
    const info = await smbClient(`allinfo ${SHARE_FILE}`)
    const gmt = info.split('\n').map(l => l.trim()).filter(l => l.startsWith('@GMT-'))
    expect(gmt).toEqual([HOURLY_GMT])

    // The old content reads back through the @GMT path.
    const v2tmp = '/var/tmp/smbsvc-v2.txt'
    await smbClient(`get ${HOURLY_GMT}/${SHARE_FILE} ${v2tmp}`)
    expect(await sshExec(`cat ${v2tmp} && rm -f ${v2tmp}`)).toBe(V2_CONTENT)

    // The daily snapshot is NOT reachable through this share (its bucket is
    // not the one the share exposes — the same sentence the design rules):
    // the get fails outright with NT_STATUS_OBJECT_NAME_NOT_FOUND (smbclient
    // prints NT_STATUS on STDOUT; the rejection error keeps it).
    const dailyErr = await sshExec(
      `smbclient //localhost/${SHARE} -U ${SHARE_USER}%${SHARE_PW} -c 'get ${DAILY_GMT}/${SHARE_FILE} /var/tmp/smbsvc-daily.txt'`,
    ).then(
      () => { throw new Error('daily snapshot get unexpectedly succeeded') },
      (err: Error & { stdout?: string }) => err,
    )
    expect(`${dailyErr.stdout ?? ''}\n${dailyErr.message}`).toContain('NT_STATUS_OBJECT_NAME_NOT_FOUND')
  })

  test('3 — disable through the API: stanza loses vfs objects/shadow keys and is byte-identical to pre-enable', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { previousVersions: { enabled: false } })
      const detail = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect((await detail.json()).data.previousVersions).toBeUndefined()

      // The stanza read fresh from the node: no composed line, no managed
      // keys — and byte-identical to the plain share as first rendered.
      const stanza = await shareStanza(SHARE)
      expect(stanza).not.toContain('vfs objects')
      expect(stanza).not.toContain('shadow:')
      expect(stanza).toBe(stanzaBeforeEnable)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('4 — refusals: plain-directory path and a custom vfs objects line are both refused 400 with their sentences', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // (a) A share on a plain directory under /var/tmp — nothing snapshot-
      // bearing underneath. The enable is refused with the design's sentence.
      await makeDir(REFUSAL_DIR)
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: REFUSAL_SHARE, path: REFUSAL_DIR })
      const refused = await ctx.put(`${V1}/shares/smb/${REFUSAL_SHARE}`, {
        data: { previousVersions: { enabled: true } },
      })
      expect(refused.status()).toBe(400)
      const err = (await refused.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toContain('not on a ZFS dataset or an AHR pool')
      expect(err.message).toContain(REFUSAL_DIR)
      // Nothing was written to the share's stanza.
      expect(await shareStanza(REFUSAL_SHARE)).not.toContain('vfs objects')

      // (b) A hand-written `vfs objects` line is never merged: enabling on
      // such a share is refused with the custom-line sentence. The line is
      // injected straight into smb.conf on the node (surgical, as a user
      // would), and smbd reloaded.
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: CUSTOM_SHARE, path: SHARE_PATH })
      await sshExec(
        // The shell receives `\[` (TS `\\[`) — sed must match a literal `[`.
        `sed -i '/^\\[${CUSTOM_SHARE}\\]$/a vfs objects = acl_xattr' /etc/samba/smb.conf && systemctl reload smbd`,
      )
      const customStanza = await shareStanza(CUSTOM_SHARE)
      expect(customStanza).toContain('vfs objects = acl_xattr')
      const refusedCustom = await ctx.put(`${V1}/shares/smb/${CUSTOM_SHARE}`, {
        data: { previousVersions: { enabled: true } },
      })
      expect(refusedCustom.status()).toBe(400)
      const customErr = (await refusedCustom.json()).error
      expect(customErr.code).toBe('VALIDATION_ERROR')
      expect(customErr.message).toContain('custom vfs objects line')
      expect(customErr.message).toContain(CUSTOM_SHARE)
      // The custom line stands untouched (no adoption, no rewrite).
      expect(await shareStanza(CUSTOM_SHARE)).toContain('vfs objects = acl_xattr')

      // Clean both shares through their own door (afterAll has a safety net).
      await removeShareViaApi(ctx, REFUSAL_SHARE)
      await removeShareViaApi(ctx, CUSTOM_SHARE)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('5 — AHR half: real-disk pool, the @snapshots mount, smbclient through the snapshot, and destroy takes the mount with the pool', async ({ playwright, pveTicket }) => {
    // A real-disk AHR pool (loop devices have no /dev/disk/by-id entry, and the
    // daemon addresses AHR create disks exclusively by by-id — shared DiskId):
    // `smbsvc-fixture.sh ahr-up` attaches the two hot disks the fixture owns
    // (indices 7+8, serials ANAS_HOT7/8 — 1–6 belong to other tests), and the
    // POOL is created here through the daemon's own API, never by hand.
    test.setTimeout(600_000)

    if (!(await fileExists(`/dev/disk/by-id/${AHR_BY_ID[0]}`)) || !(await fileExists(`/dev/disk/by-id/${AHR_BY_ID[1]}`)))
      await execFileAsync(FIXTURE_SH, ['ahr-up'])
    expect(await fileExists(`/dev/disk/by-id/${AHR_BY_ID[0]}`), `${AHR_BY_ID[0]} present`).toBe(true)
    expect(await fileExists(`/dev/disk/by-id/${AHR_BY_ID[1]}`), `${AHR_BY_ID[1]} present`).toBe(true)

    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The two hot disks must be live inventory and 'available' — the create
      // route resolves every id against /v1/disks and refuses anything else.
      const disks = (await (await ctx.get(`${V1}/disks`)).json()).data as { id: string, status: string }[]
      const selected = AHR_HOT_SERIALS.map((serial) => {
        const disk = disks.find(d => d.id.includes(serial))
        expect(disk, `disk ${serial} in /v1/disks and available`).toBeTruthy()
        expect(disk!.status).toBe('available')
        return disk!.id
      })

      // 1. Create the pool through the API (confirm flow — the disks are
      // wiped), AHR-1 on two disks = a RAID1 band; wait out the create job.
      const createChallenge = await ctx.post(`${V1}/ahr`, {
        data: { name: AHR_POOL, tier: 'ahr1', disks: selected },
      })
      expect(createChallenge.status()).toBe(409)
      const createCode = createChallenge.headers()['x-anas-confirm-code']
      expect(createCode).toBeTruthy()
      await runJob(ctx, 'post', `${V1}/ahr`, { name: AHR_POOL, tier: 'ahr1', disks: selected }, { 'x-anas-confirm': createCode }, 300_000)

      const poolRes = await ctx.get(`${V1}/ahr/${AHR_POOL}`)
      expect(poolRes.status()).toBe(200)
      const pool = (await poolRes.json()).data
      expect(pool.mountpoint).toBe(AHR_MOUNT)
      expect(pool.subvolLayout).toBe(true) // §12 layout — snapshots exist at all

      // A share user of its own, a share on the pool mountpoint, Previous
      // Versions on. No schedule targets an AHR pool here → the design's
      // fallback bucket: daily.
      await runJob(ctx, 'post', `${V1}/identity/users`, { name: AHR_USER, smbPassword: AHR_PW })
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: AHR_SHARE, path: AHR_MOUNT })
      // The pool directory is root-owned 755 (create leaves it that way); the
      // share user needs write to plant the proof file. The product path for
      // this is the Permissions editor; the proof just opens the directory.
      await sshExec(`chmod 777 ${AHR_MOUNT}`)
      await runJob(ctx, 'put', `${V1}/shares/smb/${AHR_SHARE}`, { previousVersions: { enabled: true } })
      const detail = await ctx.get(`${V1}/shares/smb/${AHR_SHARE}`)
      expect((await detail.json()).data.previousVersions).toEqual({ bucket: 'daily' })

      // 2. The stanza carries the AHR shape: absolute snapdir INTO the
      // snapshots mount, snapdirseverywhere OFF (the mount is the snapshot
      // home, there is nothing beneath the share to walk into).
      const stanza = await shareStanza(AHR_SHARE)
      expect(stanza).toContain('vfs objects = shadow_copy2')
      expect(stanza).toContain(`shadow:format = ${AHR_SNAP_FORMAT}`)
      expect(stanza).toContain(`shadow:snapdir = ${AHR_SNAP_MOUNT}`)
      expect(stanza).toContain('shadow:snapdirseverywhere = no')
      expect(stanza).toContain('shadow:localtime = no')

      // EXACTLY ONE fstab line for the mount, read-only, subvol=@snapshots —
      // and it is actually mounted, read-only, right now.
      const snapLines = await fstabLinesMatching(AHR_SNAP_MOUNT)
      expect(snapLines).toHaveLength(1)
      expect(snapLines[0]).toContain('subvol=@snapshots')
      expect(snapLines[0]).toContain(' ro,')
      const findmntSnap = await sshExec(`findmnt -n -o TARGET,OPTIONS ${AHR_SNAP_MOUNT}`)
      expect(findmntSnap).toContain(AHR_SNAP_MOUNT)
      expect(findmntSnap).toContain('ro')

      // 3. A file through smbclient, a snapshot through the daemon's own API,
      // the file changed — the FIRST content reads back through @GMT.
      await sshExec(`printf '${AHR_V1}\\n' > /var/tmp/ahr-v1.txt && chmod 644 /var/tmp/ahr-v1.txt`)
      await sshExec(`printf '${AHR_V2}\\n' > /var/tmp/ahr-v2.txt && chmod 644 /var/tmp/ahr-v2.txt`)
      await smbClientAs(AHR_SHARE, AHR_USER, AHR_PW, `put /var/tmp/ahr-v1.txt ${AHR_SHARE_FILE}`)
      await runJob(ctx, 'post', `${V1}/ahr/${AHR_POOL}/snapshots`, { name: AHR_SNAPSHOT })
      await smbClientAs(AHR_SHARE, AHR_USER, AHR_PW, `put /var/tmp/ahr-v2.txt ${AHR_SHARE_FILE}`)

      // The snapshot is visible through the read-only mount (that mount IS the
      // snapshot home the share's snapdir points into).
      expect(await fileExists(`${AHR_SNAP_MOUNT}/${AHR_SNAPSHOT}/${AHR_SHARE_FILE}`)).toBe(true)

      const info = await smbClientAs(AHR_SHARE, AHR_USER, AHR_PW, `allinfo ${AHR_SHARE_FILE}`)
      const gmt = info.split('\n').map(l => l.trim()).filter(l => l.startsWith('@GMT-'))
      expect(gmt).toEqual([AHR_GMT])
      const oldTmp = '/var/tmp/ahr-old.txt'
      await smbClientAs(AHR_SHARE, AHR_USER, AHR_PW, `get ${AHR_GMT}/${AHR_SHARE_FILE} ${oldTmp}`)
      expect(await sshExec(`cat ${oldTmp} && rm -f ${oldTmp}`)).toBe(AHR_V1)

      // 4. Enable a second time: idempotent — still ONE fstab line.
      await runJob(ctx, 'put', `${V1}/shares/smb/${AHR_SHARE}`, { previousVersions: { enabled: true } })
      expect(await fstabLinesMatching(AHR_SNAP_MOUNT)).toHaveLength(1)

      // A second share on the SAME pool reuses the mount: still one line, same
      // absolute snapdir in its own stanza.
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: AHR_SHARE2, path: AHR_MOUNT })
      await runJob(ctx, 'put', `${V1}/shares/smb/${AHR_SHARE2}`, { previousVersions: { enabled: true } })
      expect(await fstabLinesMatching(AHR_SNAP_MOUNT)).toHaveLength(1)
      expect(await shareStanza(AHR_SHARE2)).toContain(`shadow:snapdir = ${AHR_SNAP_MOUNT}`)

      // Disable: the stanza goes clean and the detail forgets the feature —
      // but the mount and its fstab line REMAIN (the design's no-counting rule:
      // the line stays across enable/disable, only destroy ends it).
      await runJob(ctx, 'put', `${V1}/shares/smb/${AHR_SHARE}`, { previousVersions: { enabled: false } })
      const afterDisable = await ctx.get(`${V1}/shares/smb/${AHR_SHARE}`)
      expect((await afterDisable.json()).data.previousVersions).toBeUndefined()
      const cleanStanza = await shareStanza(AHR_SHARE)
      expect(cleanStanza).not.toContain('vfs objects')
      expect(cleanStanza).not.toContain('shadow:')
      expect(await fstabLinesMatching(AHR_SNAP_MOUNT)).toHaveLength(1)
      expect(await sshExec(`findmnt -n -o TARGET ${AHR_SNAP_MOUNT}`)).toContain(AHR_SNAP_MOUNT)

      // 5. Destroy the pool through the API (confirm flow). This is where the
      // @snapshots mount must go WITH the pool: a still-mounted one holds the
      // LV open (lvremove fails the job) and its fstab line would dangle across
      // a pool that no longer exists.
      const destroyChallenge = await ctx.delete(`${V1}/ahr/${AHR_POOL}`)
      expect(destroyChallenge.status()).toBe(409)
      const destroyCode = destroyChallenge.headers()['x-anas-confirm-code']
      expect(destroyCode).toBeTruthy()
      await runJob(ctx, 'delete', `${V1}/ahr/${AHR_POOL}`, undefined, { 'x-anas-confirm': destroyCode }, 300_000)

      expect((await ctx.get(`${V1}/ahr/${AHR_POOL}`)).status()).toBe(404)
      // No dangling fstab line for the snapshots mount — and none for the pool.
      expect(await fstabLinesMatching(AHR_SNAP_MOUNT)).toEqual([])
      expect(await fstabLinesMatching(`${AHR_MOUNT} `)).toEqual([])
      // The mount itself is gone (destroy unmounted it before tearing the LV).
      expect(await sshExec(`findmnt -n -o TARGET ${AHR_SNAP_MOUNT} 2>/dev/null || true`)).toBe('')
    }
    finally {
      // Best-effort cleanup through the API doors (a crashed run leaves the
      // rest to ahr-down in afterAll: stanzas, mounts, fstab, LVM/md, disks).
      for (const name of [AHR_SHARE, AHR_SHARE2]) {
        try {
          await removeShareViaApi(ctx, name)
        }
        catch {
          await removeSmbShare(name).catch(() => {})
        }
      }
      try {
        const userChallenge = await ctx.delete(`${V1}/identity/users/${AHR_USER}`)
        const userCode = userChallenge.headers()['x-anas-confirm-code']
        if (userChallenge.status() === 409 && userCode)
          await runJob(ctx, 'delete', `${V1}/identity/users/${AHR_USER}`, undefined, { 'x-anas-confirm': userCode })
      }
      catch { /* best-effort */ }
      await ctx.dispose()
      await sshExec('rm -f /var/tmp/ahr-v1.txt /var/tmp/ahr-v2.txt /var/tmp/ahr-old.txt').catch(() => {})
    }
  })

  test('6 — Time Machine target (smbsvc.3, beta): enable with a 500 GiB cap — the fruit keys land and ANAS writes nothing besides', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The share may already exist (test 1 made it plain; a grep'd solo run
      // starts without it) — either way it stands plain here.
      const create = await ctx.post(`${V1}/shares/smb`, { data: { name: SHARE, path: SHARE_PATH } })
      expect([202, 409]).toContain(create.status())
      if (create.status() === 202)
        await awaitJob(ctx, (await create.json()).job.id)

      // The detail carries the storage's free space (the cap suggestion's
      // input): pvshare is a ZFS dataset, so capacity is present.
      const plain = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect((await plain.json()).data.capacity?.availableBytes ?? 0).toBeGreaterThan(0)

      // Enable with a 500 GiB cap → the composed fruit line + keys.
      await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { timeMachine: { maxSize: 536870912000 } })
      const detail = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect((await detail.json()).data.timeMachine).toEqual({ maxSize: 536870912000 })
      const stanza = await shareStanza(SHARE)
      expect(stanza).toContain('vfs objects = catia fruit streams_xattr')
      expect(stanza).toContain('fruit:time machine = yes')
      expect(stanza).toContain('fruit:time machine max size = 500G')
      // ANAS writes NOTHING beyond the composed line and the two fruit keys:
      // durable handles / kernel oplocks / kernel share modes / posix locking
      // are vfs_fruit's own connect-time consequences of fruit:time machine.
      expect(stanza).not.toContain('durable handles')
      expect(stanza).not.toContain('posix locking')
      expect(stanza).not.toContain('kernel oplocks')
      // The node's independent testparm read. GROUND TRUTH 2026-09-23 (Samba
      // 4.22.11): testparm echoes the `fruit:*` params AS WRITTEN (they are
      // VFS options, not loadparm booleans — no `Yes`/`No` normalisation), and
      // fruit's enforced settings are NOT visible to it at all — a
      // `--parameter-name` query answers the unchanged default identically for
      // [global] and the TM share, because the enforcement happens when smbd
      // serves the share, not in the config. The runtime behaviour is Samba's
      // documented one; with no macOS on the bench the client side stays
      // community-verified (the beta's standing disclosure).
      const tp = await sshExec('testparm -s 2>/dev/null')
      const lines = tp.split('\n')
      const start = lines.findIndex(l => l.trim() === `[${SHARE}]`)
      expect(start).toBeGreaterThanOrEqual(0)
      const rest = lines.slice(start + 1)
      const end = rest.findIndex(l => l.trim().startsWith('['))
      const section = (end === -1 ? rest : rest.slice(0, end)).join('\n')
      expect(section).toContain('vfs objects = catia fruit streams_xattr')
      expect(section).toContain('fruit:time machine = yes')
      expect(section).toContain('fruit:time machine max size = 500G')

      // Disable → the stanza goes clean again (the fruit keys are ANAS's to
      // remove, the enforced settings were never written).
      await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { timeMachine: null })
      const after = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect((await after.json()).data.timeMachine).toBeUndefined()
      expect(await shareStanza(SHARE)).not.toContain('fruit:')
    }
    finally {
      await ctx.dispose()
    }
  })
})
