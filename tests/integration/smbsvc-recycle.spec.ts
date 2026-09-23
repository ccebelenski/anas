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
 * Story smbsvc.2 (Recycle bin on SMB shares) — LIVE PROOF over the smbsvc
 * fixture on the stunt node (test/stunt-node/smbsvc-fixture.sh up). Shares
 * smbsvc-api.spec.ts's model: request-context API tests carrying the
 * PVEAuthCookie, gateway → local anasd → real smb.conf/smbd/smbclient.
 *
 * What is proven, per DESIGN.md "Self-service on SMB shares" (recycle bin):
 *   1. enable through the API → detail shows `recycle.purgeDays === 30`; the
 *      stanza on the node carries `vfs objects = recycle`, the four managed
 *      `recycle:*` keys, and the `# anas:recycle-purge-days = 30` marker
 *   2. smbclient ON THE NODE as the share user: `del` lands the file in
 *      `#recycle/docs/a.txt` with ctime = now (the deletion time — the one
 *      thing the purge keys on), a second same-named delete becomes
 *      `Copy #1 of a.txt` beside it, the bin is visible to the client,
 *      deleting FROM the bin is a real delete (no nested bin), `deltree
 *      "#recycle"` empties it, and the next delete recreates the bin
 *   3. the purge runner (path taken from the installed unit's ExecStart) on
 *      a young bin logs `removed=0`; with the marker aged down to 7 and the
 *      NODE'S CLOCK moved forward 8 days it logs `removed=1`, removes the
 *      file, prunes the emptied `docs` dir and keeps `#recycle` itself.
 *      STUNT-NODE-ONLY MANOEUVRE: ctime cannot be set from userspace, so the
 *      age path is proven with `timedatectl set-ntp false; date -s`, wrapped
 *      in try/finally that restores the clock and re-enables NTP — never
 *      against a real node
 *   4. `purgeDays: null` → the marker reads `never` and the runner skips the
 *      share; `recycle: null` → the stanza is byte-identical to the pre-enable
 *      one and `#recycle` REMAINS on disk (a checkbox never deletes data)
 *   5. a share carrying a hand-written `vfs objects` line is refused 400 with
 *      the custom-line sentence (same pattern as smbsvc-api test 4b)
 *
 * Deploy note: deploy-anas.sh lays down only the anasd/anas units and the
 * iSCSI drop-in — the recycle pair is install.sh's business. Until install.sh
 * runs on this node, beforeEach installs it the same way install.sh does
 * (units copied from the synced packaging/ copy at the default /opt/anas
 * prefix, daemon-reload, `enable --now`), and every test leaves the node as
 * found: the share user and shares are removed through their own API doors,
 * the clock is restored by the try/finally above, and the fixture teardown
 * (`down`) destroys the dataset WITH the `#recycle` directory.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const SHARE_PATH = '/gtbackup/pvshare'
const SHARE = 'rbshare'
const SHARE_USER = 'smbsvc_rb'
const SHARE_PW = 'anas-rb-proof'
const BIN = '#recycle'
const BIN_PATH = `${SHARE_PATH}/${BIN}`

const CUSTOM_SHARE = 'rbcustom'
const REFUSAL_DIR = '/var/tmp/rb-refusal'

const RECYCLE_SERVICE = 'anas-recycle.service'
const RECYCLE_TIMER = 'anas-recycle.timer'
const RUNNER = '/opt/anas/packages/daemon/dist/recycle-purge.js'

/** The plain-share stanza, captured on the node before the feature goes on. */
let stanzaBeforeRecycle = ''

/** Absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/smbsvc-fixture.sh', import.meta.url).pathname

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
 * EOF, trailing newlines stripped). The extractor ships base64-encoded
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
  ).catch((err: Error & { stdout?: string, stderr?: string }) => {
    // smbclient reports NT_STATUS on stdout and progress on stderr — surface
    // both; the bare "Command failed" would hide the actual verdict.
    throw new Error(`smbclient ${commands} → ${err.stdout ?? ''} ${err.stderr ?? ''}`.trim(), { cause: err })
  })
}

/** A file's presence on the node — `test -e` that never throws. */
async function fileExists(path: string): Promise<boolean> {
  return (await sshExec(`test -e '${path}' && echo yes || echo no`)) === 'yes'
}

/** The recycle purge runner as installed — path taken from the unit's ExecStart. */
async function installedRunnerCommand(): Promise<string> {
  const unit = await sshExec(`systemctl cat ${RECYCLE_SERVICE}`)
  const execStart = unit.split('\n').find(l => l.trim().startsWith('ExecStart='))
  expect(execStart, `${RECYCLE_SERVICE} carries an ExecStart`).toBeTruthy()
  expect(execStart).toContain(RUNNER)
  return execStart!.split('=', 2)[1].trim()
}

/** Run the purge runner once via ssh and return its stdout. */
async function runPurgeRunner(): Promise<string> {
  return sshExec(await installedRunnerCommand())
}

/**
 * Skip the whole file when the fixture cannot be made present. The `up` here
 * is a self-heal, not the primary build (that is `smbsvc-fixture.sh up`, run
 * by hand): Playwright ENDS THE WORKER after any failed test, and the old
 * worker's teardown runs this file's afterAll — tearing the fixture down
 * mid-run. The next worker re-ups it and continues instead of skipping.
 * The recycle unit pair is then installed the way install.sh would (see the
 * deploy note in the file header) — idempotent, so once per test is cheap.
 */
test.beforeEach(async () => {
  if (!(await datasetExists('gtbackup/pvshare')))
    await execFileAsync(FIXTURE_SH, ['up']).catch(() => {})
  test.skip(!(await datasetExists('gtbackup/pvshare')), 'smbsvc fixture not present — run test/stunt-node/smbsvc-fixture.sh up')
  await sshExec(
    `install -m 0644 /opt/anas/packaging/systemd/${RECYCLE_SERVICE} /etc/systemd/system/${RECYCLE_SERVICE}`
    + ` && install -m 0644 /opt/anas/packaging/systemd/${RECYCLE_TIMER} /etc/systemd/system/${RECYCLE_TIMER}`
    + ` && systemctl daemon-reload && systemctl enable --now ${RECYCLE_TIMER}`,
  )
})

test.describe('Recycle bin on SMB shares (smbsvc.2)', () => {
  test.setTimeout(240_000)

  test.afterAll(async ({ playwright }) => {
    // Leave the node as found: the share user and both shares are removed
    // through their own API doors, the /var/tmp staging files are swept, and
    // the fixture teardown destroys the dataset WITH the #recycle directory.
    // All best-effort: an afterAll failure must not mask the run's results.
    // The ticket is fetched here (afterAll sees no test-scoped fixtures) with
    // the same PVE login the auth fixture uses. The recycle timer pair STAYS
    // installed and enabled — it is the product's install path (install.sh),
    // the runner is a no-op without marked shares, and the proof asserted it.
    const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
      form: { username: 'root@pam', password: 'anas-test' },
    })
    const ticket = (await ticketRes.json()).data.ticket as string
    await login.dispose()
    const ctx = await authedContext(playwright, ticket)
    try {
      for (const user of [SHARE_USER]) {
        try {
          const challenge = await ctx.delete(`${V1}/identity/users/${user}`)
          const code = challenge.headers()['x-anas-confirm-code']
          if (challenge.status() === 409 && code)
            await runJob(ctx, 'delete', `${V1}/identity/users/${user}`, undefined, { 'x-anas-confirm': code })
        }
        catch { /* best-effort */ }
      }
      for (const name of [SHARE, CUSTOM_SHARE]) {
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
      await sshExec(`rm -rf ${REFUSAL_DIR} /var/tmp/rb-a.txt /var/tmp/rb-b.txt`).catch(() => {})
      await execFileAsync(FIXTURE_SH, ['down']).catch(() => {})
    }
  })

  test('1 — enable through the API: detail shows the purge age; the stanza carries the composed VFS line, the four recycle keys, and the marker', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // A share user with an SMB password (the same door the Shares UI uses),
      // so smbclient can authenticate — and write (test 2).
      await runJob(ctx, 'post', `${V1}/identity/users`, { name: SHARE_USER, smbPassword: SHARE_PW })

      // The share is created PLAIN; its stanza is captured byte-exact so
      // test 4 can require the disable round trip to restore it. The directory
      // is opened 777 for the proof only — the product path for share-user
      // write access is the Permissions editor.
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: SHARE, path: SHARE_PATH })
      await sshExec(`chmod 777 ${SHARE_PATH}`)
      const plain = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect(plain.status()).toBe(200)
      expect((await plain.json()).data.recycle).toBeUndefined()
      stanzaBeforeRecycle = await shareStanza(SHARE)
      expect(stanzaBeforeRecycle).toContain(`path = ${SHARE_PATH}`)
      expect(stanzaBeforeRecycle).not.toContain('recycle')

      // Enable with the default purge age → job → detail reads it back.
      await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { recycle: { purgeDays: 30 } })
      const detail = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect(detail.status()).toBe(200)
      expect((await detail.json()).data.recycle).toEqual({ purgeDays: 30 })

      // The stanza on the node — the source of truth — carries the composer's
      // line and the exact managed keys DESIGN.md names.
      const stanza = await shareStanza(SHARE)
      expect(stanza).toContain('vfs objects = recycle')
      expect(stanza).toContain('recycle:repository = #recycle')
      expect(stanza).toContain('recycle:keeptree = yes')
      expect(stanza).toContain('recycle:versions = yes')
      expect(stanza).toContain('recycle:touch = yes')
      expect(stanza).toContain('# anas:recycle-purge-days = 30')

      // testparm accepts the config as written (the daemon gated the write
      // already — this is the independent check from the node).
      expect(await sshExec('testparm -s 2>&1 || true')).not.toContain('ERROR')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('2 — smbclient on the node: del lands in #recycle with ctime = now, versions collide as "Copy #1 of", deleting from the bin is real, deltree empties, the bin is recreated', async () => {
    // A file for the client to put. smbclient prints its progress to STDERR,
    // so the verdict is the exit status (sshExec throws on non-zero) plus what
    // lands on disk.
    await sshExec('printf \'rb proof file\\n\' > /var/tmp/rb-a.txt && chmod 644 /var/tmp/rb-a.txt')

    // The user's delete: a file under docs/ disappears from the share…
    await smbClientAs(SHARE, SHARE_USER, SHARE_PW, 'mkdir docs; put /var/tmp/rb-a.txt docs/a.txt; del docs/a.txt')
    expect(await fileExists(`${SHARE_PATH}/docs/a.txt`)).toBe(false)

    // …and reappears in the bin, tree kept, with ctime = the deletion time
    // (within the last minute — the rename sets it, users cannot forge it).
    const binFile = `${BIN_PATH}/docs/a.txt`
    expect(await fileExists(binFile)).toBe(true)
    const fresh = await sshExec(
      `[ $(stat -c %Z '${binFile}') -gt $(( $(date +%s) - 60 )) ] && echo fresh || echo stale`,
    )
    expect(fresh).toBe('fresh')

    // A second delete of the same name keeps BOTH: the older one stays, the
    // newer one becomes "Copy #1 of a.txt" beside it (versions = yes).
    await sshExec('printf \'rb proof second\\n\' > /var/tmp/rb-a.txt && chmod 644 /var/tmp/rb-a.txt')
    await smbClientAs(SHARE, SHARE_USER, SHARE_PW, 'put /var/tmp/rb-a.txt docs/a.txt; del docs/a.txt')
    expect(await fileExists(`${BIN_PATH}/docs/a.txt`)).toBe(true)
    expect(await fileExists(`${BIN_PATH}/docs/Copy #1 of a.txt`)).toBe(true)

    // The bin is visible to the client at the share root, under its name.
    const listing = await smbClientAs(SHARE, SHARE_USER, SHARE_PW, 'ls')
    expect(listing).toContain(BIN)

    // Deleting FROM the bin is a real delete: the module recognises its own
    // repository — no nested bin, the file is simply gone.
    await smbClientAs(SHARE, SHARE_USER, SHARE_PW, `del "${BIN}/docs/a.txt"`)
    expect(await fileExists(`${BIN_PATH}/docs/a.txt`)).toBe(false)
    expect(await fileExists(`${BIN_PATH}/${BIN}`)).toBe(false)

    // Deleting the folder empties the bin…
    await smbClientAs(SHARE, SHARE_USER, SHARE_PW, `deltree "${BIN}"`)
    expect(await fileExists(BIN_PATH)).toBe(false)

    // …and Samba recreates it on the next delete.
    await smbClientAs(SHARE, SHARE_USER, SHARE_PW, 'put /var/tmp/rb-a.txt docs/a.txt; del docs/a.txt')
    expect(await fileExists(`${BIN_PATH}/docs/a.txt`)).toBe(true)
  })

  test('3 — purge: the runner keeps young files; with the age at 7 and the clock 8 days forward it removes the aged file, prunes the emptied dir, keeps the bin', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)

    // The timer pair as installed: the timer is enabled (list-timers shows it)
    // and the runner path in the unit's ExecStart exists on the node.
    expect(await sshExec(`systemctl is-enabled ${RECYCLE_TIMER}`)).toBe('enabled')
    expect(await sshExec(`systemctl list-timers --no-legend ${RECYCLE_TIMER}`)).toContain(RECYCLE_TIMER)
    expect(await fileExists(RUNNER)).toBe(true)

    // First run at the default 30-day marker: the bin's files are young —
    // kept, nothing pruned. The verdict is the runner's own line (and exit 0,
    // which sshExec enforces).
    const young = await runPurgeRunner()
    expect(young).toContain('share=rbshare removed=0')

    // Age the marker down to 7 BEFORE the clock manoeuvre: all API work in
    // this test happens while the node's clock still tells the truth.
    await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { recycle: { purgeDays: 7 } })
    const detail = await ctx.get(`${V1}/shares/smb/${SHARE}`)
    expect((await detail.json()).data.recycle).toEqual({ purgeDays: 7 })
    expect(await shareStanza(SHARE)).toContain('# anas:recycle-purge-days = 7')
    await ctx.dispose()

    // STUNT-NODE-ONLY MANOEUVRE (see file header): ctime cannot be set from
    // userspace, so the age path is proven by moving the node's clock. The
    // try/finally is the safety: the clock goes back, NTP comes back on, and
    // the timer restarts even when an assertion inside fails. The API is NOT
    // touched while the clock lies (PVE tickets are age-checked).
    //
    // The timer is STOPPED across the window: its Persistent=true catch-up
    // fires anas-recycle.service the instant the clock jumps forward (the
    // fake clock makes 8 daily runs look missed), which purges the bin a
    // second BEFORE the explicit run below and turns its output into
    // removed=0. That catch-up is systemd behaving exactly as designed —
    // ground truth 2026-09-23 — so the explicit run gets a quiet clock by
    // stopping the timer first; the enabled assertions above already stood.
    await sshExec(`systemctl stop ${RECYCLE_TIMER} && timedatectl set-ntp false && date -s "+8 days" >/dev/null`)
    try {
      const purged = await runPurgeRunner()
      expect(purged).toContain('share=rbshare removed=1')
      expect(purged).toContain('pruned_dirs=1')
      // The aged file is gone WITH its emptied directory; the bin itself
      // stays (only directories UNDER the bin are pruned).
      expect(await fileExists(`${BIN_PATH}/docs/a.txt`)).toBe(false)
      expect(await fileExists(`${BIN_PATH}/docs`)).toBe(false)
      expect(await fileExists(BIN_PATH)).toBe(true)
    }
    finally {
      await sshExec(`date -s "-8 days" >/dev/null; timedatectl set-ntp true; systemctl start ${RECYCLE_TIMER}`)
    }
    // The clock is genuinely back: node epoch within a couple of minutes of
    // the test-runner host's (NTP then trims the remainder).
    const nodeNow = Number(await sshExec('date +%s'))
    expect(Math.abs(nodeNow - Date.now() / 1000)).toBeLessThan(300)
  })

  test('4 — never and off: purgeDays null writes the `never` marker and the runner skips the share; recycle null restores the stanza byte-identically and leaves #recycle on disk', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // A young file in the bin — the disable proof below wants data to leave
      // in place (a checkbox never deletes data).
      await smbClientAs(SHARE, SHARE_USER, SHARE_PW, 'put /var/tmp/rb-a.txt docs/a.txt; del docs/a.txt')
      expect(await fileExists(`${BIN_PATH}/docs/a.txt`)).toBe(true)

      // `null` purgeDays = never: the marker reads `never`, the feature stays
      // on, and the runner logs the share as skipped — no age to purge by.
      await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { recycle: { purgeDays: null } })
      const neverDetail = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect((await neverDetail.json()).data.recycle).toEqual({ purgeDays: null })
      const neverStanza = await shareStanza(SHARE)
      expect(neverStanza).toContain('# anas:recycle-purge-days = never')
      expect(neverStanza).toContain('vfs objects = recycle')
      const skipped = await runPurgeRunner()
      expect(skipped).toMatch(/share=rbshare skipped/)

      // Off: the stanza loses the composed line, the keys and the marker — and
      // is byte-identical to the plain share as first rendered — while the
      // #recycle directory and its contents remain on disk.
      await runJob(ctx, 'put', `${V1}/shares/smb/${SHARE}`, { recycle: null })
      const offDetail = await ctx.get(`${V1}/shares/smb/${SHARE}`)
      expect((await offDetail.json()).data.recycle).toBeUndefined()
      const offStanza = await shareStanza(SHARE)
      expect(offStanza).not.toContain('vfs objects')
      expect(offStanza).not.toContain('recycle:')
      expect(offStanza).not.toContain('anas:recycle-purge-days')
      expect(offStanza).toBe(stanzaBeforeRecycle)
      expect(await fileExists(`${BIN_PATH}/docs/a.txt`)).toBe(true)
      expect(await fileExists(BIN_PATH)).toBe(true)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('5 — refusal: a share with a custom vfs objects line cannot enable the recycle bin (400, share named)', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // A share carrying a hand-written `vfs objects` line (injected straight
      // into smb.conf on the node, surgical, as a user would) is never merged:
      // enabling the recycle bin on it is refused with the custom-line
      // sentence and the share named.
      await makeDir(REFUSAL_DIR)
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: CUSTOM_SHARE, path: REFUSAL_DIR })
      await sshExec(
        // The shell receives `\[` (TS `\\[`) — sed must match a literal `[`.
        `sed -i '/^\\[${CUSTOM_SHARE}\\]$/a vfs objects = acl_xattr' /etc/samba/smb.conf && systemctl reload smbd`,
      )
      expect(await shareStanza(CUSTOM_SHARE)).toContain('vfs objects = acl_xattr')

      const refused = await ctx.put(`${V1}/shares/smb/${CUSTOM_SHARE}`, {
        data: { recycle: { purgeDays: 30 } },
      })
      expect(refused.status()).toBe(400)
      const err = (await refused.json()).error
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toContain('custom vfs objects line')
      expect(err.message).toContain(CUSTOM_SHARE)
      // The custom line stands untouched (no adoption, no rewrite).
      expect(await shareStanza(CUSTOM_SHARE)).toContain('vfs objects = acl_xattr')

      // Clean up through its own door (afterAll has a safety net).
      await removeShareViaApi(ctx, CUSTOM_SHARE)
    }
    finally {
      await ctx.dispose()
    }
  })
})
