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
 *   5. the AHR half is SKIPPED — see the reason in the test body
 *
 * Every test leaves the node as found: the share, schedules, and share user
 * this file creates are removed through their own API doors (best-effort
 * safety nets behind them), and the fixture is torn down (down) in afterAll.
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
): Promise<void> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers !== undefined ? { headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id)
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

/** smbclient ON THE NODE, authenticated as the share user. */
async function smbClient(commands: string): Promise<string> {
  return sshExec(
    `smbclient //localhost/${SHARE} -U ${SHARE_USER}%${SHARE_PW} -c '${commands}'`,
  )
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
  test.skip(!(await datasetExists(DATASET)), 'smbsvc fixture not present — run test/stunt-node/smbsvc-fixture.sh up')
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
      try {
        const challenge = await ctx.delete(`${V1}/identity/users/${SHARE_USER}`)
        const code = challenge.headers()['x-anas-confirm-code']
        if (challenge.status() === 409 && code)
          await runJob(ctx, 'delete', `${V1}/identity/users/${SHARE_USER}`, undefined, { 'x-anas-confirm': code })
      }
      catch { /* best-effort */ }
      for (const name of [SHARE, REFUSAL_SHARE, CUSTOM_SHARE]) {
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
      await sshExec(`rm -rf ${REFUSAL_DIR}`).catch(() => {})
      await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
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

  test('5 — AHR half: Previous Versions through an AHR @snapshots mount', async () => {
    test.skip(true, 'No loop-device AHR pool can be created through the daemon\'s own API: loop devices have no /dev/disk/by-id entry and the daemon addresses AHR create disks exclusively by by-id (shared DiskId). The fixture therefore builds no AHR pool; proving the AHR half (fstab @snapshots mount + absolute shadow:snapdir) needs a real-disk AHR pool.')
  })
})
