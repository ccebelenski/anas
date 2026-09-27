import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { expect, pveAuthState, test } from './fixtures/auth'
import { loginToPve, NODE_NAME, openAnasItem, PVE_URL } from './fixtures/pve-ui'
import { makeDir, removeSmbShare, sshExec } from './fixtures/stunt-node'

/**
 * Story identity.3 (GitHub #68) — LIVE PROOF that a share user's Samba passdb
 * entry matches the account EXACTLY, on the stunt node, through the gateway →
 * local anasd → real passdb/smbd/smbclient.
 *
 * Ground truth (reproduced 2026-09-25): tdbsam keys entries by the lowercased
 * name but stores the name as first written. An orphan stored as `idpcase`
 * (its account deleted) is what `smbpasswd -a Idpcase` lands on — it exits 0,
 * the stored name stays `idpcase`, `pdbedit -L` shows `idpcase:4294967295:`,
 * and a logon as `Idpcase` becomes a guest session.
 *
 * What is proven:
 *   1. the orphan is staged by hand exactly as reproduced (useradd idpcase →
 *      smbpasswd -a idpcase → userdel idpcase); creating `Idpcase` WITH an SMB
 *      password through the API repairs it: the job completes with
 *      `smbEntryReplaced: 'idpcase'`, `pdbedit -L` shows `Idpcase:<uid>:`, the
 *      list reads `smbEnabled: true` with no mismatch, and anasd's journal
 *      carries the one "replaced it" line
 *   2. smbclient ON THE NODE as `Idpcase` lists AND writes on a share whose
 *      `valid users = Idpcase` (a guest session could not connect) — the file
 *      lands owned by Idpcase — and the Windows-shaped login
 *      (`-U 'WINPC\Idpcase' -m SMB3`) does too
 *   3. a mismatched entry planted AFTER create (the exact entry dropped, the
 *      lowercase orphan re-staged): the API reports `smbEnabled: false` +
 *      `smbEntryMismatch: 'idpcase'`, smbclient as Idpcase is refused, and the
 *      Share Users grid shows "SMB entry stored as 'idpcase' — set the password
 *      again to repair" in place of the tick
 *   4. set-password repairs it (job `smbEntryReplaced: 'idpcase'`, `pdbedit -L`
 *      exact again, smbclient lists)
 *   5. with a mismatched entry planted once more, the confirm-gated user
 *      delete SUCCEEDS (pdbedit -x -u by the stored name; smbpasswd -x used to
 *      fail here) and leaves no passdb entry and no account behind
 *
 * Self-cleaning: every name this file touches is its own (`idpcase` /
 * `Idpcase`, share `idpcase`, directory /var/tmp/anas-idpcase). beforeAll and
 * afterAll sweep them; no other user or share on the node is ever touched.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const LOWER = 'idpcase'
const USER = 'Idpcase'
const PW = 'anas-idp-proof'
const ORPHAN_PW = 'anas-idp-orphan'
const SHARE = 'idpcase'
const SHARE_DIR = '/var/tmp/anas-idpcase'
const MISMATCH_TEXT = `SMB entry stored as '${LOWER}' — set the password again to repair`

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
  timeout = 60_000,
): Promise<{ status: string, error?: { message?: string }, result?: any }> {
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

/** Submit a mutation, wait for its job, require it to complete; returns the result. */
async function runJob(
  ctx: APIRequestContext,
  verb: 'post' | 'put' | 'delete',
  url: string,
  data?: unknown,
  headers?: Record<string, string>,
): Promise<any> {
  const res = await ctx[verb](url, {
    ...(data !== undefined ? { data } : {}),
    ...(headers !== undefined ? { headers } : {}),
  })
  expect(res.status(), await res.text()).toBe(202)
  const job = await awaitJob(ctx, (await res.json()).job.id)
  expect(job.status, job.error?.message).toBe('completed')
  return job.result
}

/** The confirm-gated delete: 409 challenge → resend with the code → job. */
async function deleteViaApi(ctx: APIRequestContext, url: string): Promise<any> {
  const challenge = await ctx.delete(url)
  if (challenge.status() === 404)
    return undefined
  expect(challenge.status(), await challenge.text()).toBe(409)
  const code = challenge.headers()['x-anas-confirm-code']
  expect(code).toBeTruthy()
  return runJob(ctx, 'delete', url, undefined, { 'x-anas-confirm': code })
}

/** The passdb lines for this file's name, in any case (tdbsam keys lowercase). */
async function passdbLines(): Promise<string[]> {
  const out = await sshExec(`pdbedit -L 2>/dev/null | grep -i '^${LOWER}:' || true`)
  return out === '' ? [] : out.split('\n')
}

/**
 * Stage the #68 orphan exactly as reproduced: a lowercase account gets an SMB
 * password, then the account is deleted — the passdb entry stays behind,
 * stored as `idpcase`, mapped to no uid.
 */
async function stageOrphan(): Promise<void> {
  await sshExec(
    `useradd -M -N -s /usr/sbin/nologin ${LOWER}`
    + ` && printf '%s\\n%s\\n' '${ORPHAN_PW}' '${ORPHAN_PW}' | smbpasswd -a -s ${LOWER}`
    + ` && userdel ${LOWER}`,
  )
  expect(await passdbLines()).toEqual([`${LOWER}:4294967295:`])
}

/** smbclient ON THE NODE; never throws — returns stdout+stderr and the exit code. */
async function smbclient(user: string, pw: string, commands: string, extra = ''): Promise<{ out: string, code: number }> {
  const out = await sshExec(
    `smbclient //127.0.0.1/${SHARE} -U '${user}%${pw}' ${extra} -c '${commands}' 2>&1; echo "exit=$?"`,
  )
  const m = out.match(/exit=(\d+)\s*$/)
  return { out, code: m ? Number(m[1]) : -1 }
}

/** Best-effort sweep of everything this file creates. Never throws. */
async function sweep(): Promise<void> {
  await removeSmbShare(SHARE).catch(() => {})
  // pdbedit -x -u finds the entry case-insensitively — either stored case.
  await sshExec(`pdbedit -x -u ${USER} >/dev/null 2>&1 || true`).catch(() => {})
  await sshExec(`pdbedit -x -u ${LOWER} >/dev/null 2>&1 || true`).catch(() => {})
  await sshExec(`userdel ${USER} 2>/dev/null || true`).catch(() => {})
  await sshExec(`userdel ${LOWER} 2>/dev/null || true`).catch(() => {})
  await sshExec(`rm -rf ${SHARE_DIR}`).catch(() => {})
}

test.describe.configure({ mode: 'serial' })

test.describe('Passdb entry matches the account exactly (identity.3, #68)', () => {
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    await sweep()
  })

  test.afterAll(async ({ playwright }) => {
    // Through the API doors first (share, then user), then the SSH sweep as
    // the safety net. afterAll sees no test-scoped fixtures, so the ticket is
    // fetched here with the auth fixture's login.
    try {
      const login = await playwright.request.newContext({ ignoreHTTPSErrors: true })
      const ticketRes = await login.post(`${PVE_URL}/api2/json/access/ticket`, {
        form: { username: 'root@pam', password: 'anas-test' },
      })
      const ticket = (await ticketRes.json()).data.ticket as string
      await login.dispose()
      const ctx = await authedContext(playwright, ticket)
      try {
        await deleteViaApi(ctx, `${V1}/shares/smb/${SHARE}`).catch(() => {})
        await deleteViaApi(ctx, `${V1}/identity/users/${USER}`).catch(() => {})
      }
      finally {
        await ctx.dispose()
      }
    }
    catch { /* best-effort */ }
    await sweep()
  })

  test('1 — create over a staged case-mismatched orphan repairs it: Idpcase:<uid> exact, smbEnabled, one journal line', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await stageOrphan()
      const since = await sshExec('date -Is')

      const result = await runJob(ctx, 'post', `${V1}/identity/users`, { name: USER, smbPassword: PW })
      expect(result).toEqual({ created: USER, smbEnabled: true, smbEntryReplaced: LOWER })

      const uid = await sshExec(`id -u ${USER}`)
      expect(await passdbLines()).toEqual([`${USER}:${uid}:`])

      const detail = await ctx.get(`${V1}/identity/users/${USER}`)
      expect(detail.status()).toBe(200)
      const user = (await detail.json()).data
      expect(user.smbEnabled).toBe(true)
      expect(user.smbEntryMismatch).toBeUndefined()

      const journal = await sshExec(`journalctl -u anasd --since '${since}' --no-pager`)
      const replaced = journal.split('\n').filter(l => l.includes(`stored as '${LOWER}' did not match account '${USER}'`))
      expect(replaced, journal).toHaveLength(1)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('2 — smbclient as Idpcase lists and writes on a valid-users share (no guest), Windows-shaped login too', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      await makeDir(SHARE_DIR)
      await sshExec(`chown ${USER} ${SHARE_DIR}`)
      await runJob(ctx, 'post', `${V1}/shares/smb`, { name: SHARE, path: SHARE_DIR, validUsers: [USER] })

      const put = await smbclient(USER, PW, 'put /etc/hostname probe.txt; ls')
      expect(put.code, put.out).toBe(0)
      expect(put.out).toContain('probe.txt')
      // The file belongs to the account — a guest session would be nobody
      // (and could not have connected to a valid-users share at all).
      expect(await sshExec(`stat -c %U ${SHARE_DIR}/probe.txt`)).toBe(USER)

      const win = await smbclient(`WINPC\\${USER}`, PW, 'ls', '-m SMB3')
      expect(win.code, win.out).toBe(0)
      expect(win.out).toContain('probe.txt')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('3 — a mismatched entry planted after create: API and grid show the stored name, smbclient is refused', async ({ page, playwright, pveTicket }) => {
    // Drop the exact entry, then re-stage the lowercase orphan by hand.
    await sshExec(`pdbedit -x -u ${USER}`)
    await stageOrphan()

    const ctx = await authedContext(playwright, pveTicket)
    try {
      const list = await ctx.get(`${V1}/identity/users`)
      expect(list.status()).toBe(200)
      const row = ((await list.json()).data as any[]).find(u => u.name === USER)
      expect(row, 'Idpcase in the list').toBeTruthy()
      expect(row.smbEnabled).toBe(false)
      expect(row.smbEntryMismatch).toBe(LOWER)
    }
    finally {
      await ctx.dispose()
    }

    // The broken state as a client meets it: the session cannot become
    // Idpcase, so the valid-users share refuses it.
    const refused = await smbclient(USER, ORPHAN_PW, 'ls')
    expect(refused.code, refused.out).not.toBe(0)
    expect(refused.out).toMatch(/NT_STATUS_|tree connect failed/)

    await loginToPve(page)
    await openAnasItem(page, 'Share Users')
    await expect(page.locator('.anas-grid-users')).toBeVisible({ timeout: 45_000 })
    // The row whose Name cell is exactly Idpcase (case-sensitive regex).
    const gridRow = page.locator('.anas-grid-users .x-grid-row').filter({
      has: page.locator('.x-grid-cell-inner', { hasText: new RegExp(`^${USER}$`) }),
    })
    await expect(gridRow).toHaveCount(1, { timeout: 45_000 })
    await expect(gridRow.locator('.anas-smb-mismatch')).toContainText(MISMATCH_TEXT)
    // In place of the tick, not beside it.
    await expect(gridRow).not.toContainText('✓')
  })

  test('4 — set password repairs the mismatch: exact entry again, smbclient lists', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const result = await runJob(ctx, 'post', `${V1}/identity/users/${USER}/smb-password`, { password: PW })
      expect(result).toEqual({ user: USER, smbEnabled: true, smbEntryReplaced: LOWER })
      const uid = await sshExec(`id -u ${USER}`)
      expect(await passdbLines()).toEqual([`${USER}:${uid}:`])

      const detail = await ctx.get(`${V1}/identity/users/${USER}`)
      const user = (await detail.json()).data
      expect(user.smbEnabled).toBe(true)
      expect(user.smbEntryMismatch).toBeUndefined()

      const ls = await smbclient(USER, PW, 'ls')
      expect(ls.code, ls.out).toBe(0)
      expect(ls.out).toContain('probe.txt')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('5 — delete on a mismatched entry succeeds and leaves nothing behind', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The share names the user in valid users — remove it first (the delete
      // would otherwise be a hard referenced-by-share refusal).
      await deleteViaApi(ctx, `${V1}/shares/smb/${SHARE}`)

      await sshExec(`pdbedit -x -u ${USER}`)
      await stageOrphan()

      const result = await deleteViaApi(ctx, `${V1}/identity/users/${USER}`)
      expect(result).toEqual({ deleted: USER, smbEntryRemoved: true })
      expect(await passdbLines()).toEqual([])
      expect(await sshExec(`getent passwd ${USER} >/dev/null && echo present || echo gone`)).toBe('gone')
    }
    finally {
      await ctx.dispose()
    }
  })
})
