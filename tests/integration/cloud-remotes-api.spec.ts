import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, pveAuthState, test } from './fixtures/auth'
import { NODE_NAME, PVE_URL } from './fixtures/pve-ui'
import { getMode, sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * Story rclone.1 (Cloud sync — remotes) — LIVE PROOF over the cloud fixture on
 * the stunt node (test/stunt-node/cloud-fixture.sh up): an sftp remote pointing
 * at the node's OWN sshd, written into ANAS's own /etc/anas/rclone.conf through
 * the API, probed by the real bounded `lsjson` Test.
 *
 * Modelled on smbsvc-api.spec.ts: request-context API tests carrying the
 * PVEAuthCookie, gateway → local anasd → real rclone on the node.
 *
 * What is proven, per the story's acceptance list:
 *   1. create the sftp remote with a password (202 job) → the section in the
 *      file carries `pass = <OBSCURED>` (never the plain value, and `rclone
 *      reveal` on the stored value gives the password back), the file is
 *      0600, and the API answers `secretsSet: ['pass']` with no value
 *   2. Test the SAVED remote → `ok` (a real probe of 127.0.0.1 as rclonegt —
 *      the remote root and the fixture's `dst` path)
 *   3. the sftp shell detection rclone persists into the saved remote's own
 *      section (`shell_type`, `md5sum_command`, `sha1sum_command`) is KEPT by
 *      the INI writer and listed by the API — a foreign key is never dropped
 *   4. Test an UNSAVED dialog with the wrong password → `auth`, and the store
 *      gains no section: the dialog's probe runs against a private copy
 *   5. Test an unsaved dialog at 192.0.2.1 (TEST-NET, nothing answers) →
 *      `unreachable`, and the probe's wall budget kept the API responsive
 *   6. Test the saved remote with a missing path → `not-found` (rclone exit 3)
 *   7. Test a saved name the file does not carry → 404 NOT_FOUND
 *   8. a duplicate create → 409, a PUT carrying `type` → 400 (type is immutable)
 *   9. an edit that carries no secret (host changed) keeps the stored one —
 *      the file is byte-identical except the changed key
 *  10. a hand-added section with a comment (an operator edit ANAS did not
 *      make) survives an ANAS write byte-for-byte; DELETE removes only its own
 *      section, leaving the hand-added one as the file's only content, and a
 *      second DELETE is a 404
 *
 * The fixture is up in beforeAll and down in afterAll; `up` captures the
 * store's pre-state and then starts from NO file, `down` puts the pre-state
 * back (on a fresh node that is ABSENCE — the sentinel the fixture records),
 * so a run leaves the node exactly as found.
 */

const V1 = `${PVE_URL}/anas/api/nodes/${NODE_NAME}/v1`

const RCLONE_CONF = '/etc/anas/rclone.conf'
const REMOTE = 'gt'
const REMOTE2 = 'gt2'
const HAND_SECTION = 'manual'
const USER = 'rclonegt'
const PASS = 'gtpass'
// The node's rclone (GT 2026-09-23: v1.60.1-DEV → the bare version).
const RCLONE_VERSION = '1.60.1'

/** The absolute path of the fixture script, relative to this spec file. */
const FIXTURE_SH = new URL('../../test/stunt-node/cloud-fixture.sh', import.meta.url).pathname

/** Build an authenticated request context carrying the PVE session cookie. */
async function authedContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  ticket: string,
): Promise<APIRequestContext> {
  // The Test endpoint holds its request for the whole probe (up to the 45 s
  // `timeout` wrapper on a dead network) — well past Playwright's 30 s request
  // default, so the context carries a wider one.
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
  timeout = 90_000,
): Promise<void> {
  const res = await ctx[verb](url, { ...(data !== undefined ? { data } : {}) })
  expect(res.status(), await res.text()).toBe(202)
  const { id } = (await res.json()).job
  const job = await awaitJob(ctx, id, timeout)
  expect(job.status, job.error).toBe('completed')
}

/** The whole store file as it stands on the node. */
async function storeText(): Promise<string> {
  return sshExec(`cat ${RCLONE_CONF}`)
}

/** The remote as the API lists it (secret values never returned). */
async function listedRemote(ctx: APIRequestContext, name: string): Promise<any> {
  const res = await ctx.get(`${V1}/cloud/remotes`)
  expect(res.status()).toBe(200)
  return (await res.json()).data.remotes.find((r: { name: string }) => r.name === name)
}

/**
 * One `[name]` section of the store, exactly as it stands in the file (the
 * header line through the line before the next section, or EOF — trailing
 * newlines stripped). Base64-shipped so no quoting survives the ssh trip.
 */
async function storeSection(name: string): Promise<string> {
  const py = [
    `import re`,
    `s = open('${RCLONE_CONF}').read()`,
    `m = re.search(r'(?ms)^\\[${name}\\].*?(?=^\\[|\\Z)', s)`,
    `print(m.group(0).rstrip('\\n') if m else '')`,
  ].join('\n')
  const b64 = Buffer.from(py, 'utf8').toString('base64')
  return sshExec(`echo ${b64} | base64 -d | python3`)
}

test.describe('Cloud remotes (rclone.1)', () => {
  test.setTimeout(180_000)

  test.beforeAll(async () => {
    await execFileAsync(FIXTURE_SH, ['up'])
  })

  test.afterAll(async () => {
    // Leave the node as found: the fixture down restores the store's captured
    // pre-state, removes the sshd drop-in and the user. Best-effort — an
    // afterAll failure must not mask the run's results.
    try {
      await execFileAsync(FIXTURE_SH, ['down'])
    }
    catch (err) {
      console.error(`cloud fixture down failed: ${err instanceof Error ? err.message : err}`)
    }
  })

  test('create the sftp remote: the file is 0600 with the obscured pass, the API returns no value', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // The trimmed catalogue, from the node's real rclone: the two facts the
      // dialog renders — sftp's `pass` is password-TYPED (obscured in the
      // file AND hidden), s3's `secret_access_key` is secret by the name rule
      // only (hidden, stored plain — rclone would not reveal it obscured).
      const provRes = await ctx.get(`${V1}/cloud/providers`)
      expect(provRes.status()).toBe(200)
      const providers = (await provRes.json()).data
      const sftp = providers.find((p: { name: string }) => p.name === 'sftp')
      expect(sftp, 'the sftp backend is in the catalogue').toBeTruthy()
      const sftpPass = sftp.options.find((o: { name: string }) => o.name === 'pass')
      expect(sftpPass?.secret).toBe(true)
      expect(sftpPass?.password).toBe(true)
      const s3 = providers.find((p: { name: string }) => p.name === 's3')
      const s3Secret = s3.options.find((o: { name: string }) => o.name === 'secret_access_key')
      expect(s3Secret?.secret).toBe(true)
      expect(s3Secret?.password).toBe(false)

      // The node's rclone facts (the Remotes window footer).
      const remotesRes = await ctx.get(`${V1}/cloud/remotes`)
      expect(remotesRes.status()).toBe(200)
      const remotesBody = (await remotesRes.json()).data
      expect(remotesBody.rclone).toEqual({
        version: RCLONE_VERSION,
        configFile: RCLONE_CONF,
        encrypted: false,
      })

      // The create: a 202 job that surgically writes the section.
      await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
        name: REMOTE,
        type: 'sftp',
        options: { host: '127.0.0.1', user: USER, pass: PASS },
      })

      // The read: the non-secret options, `secretsSet` only — never a value.
      const afterRes = await ctx.get(`${V1}/cloud/remotes`)
      expect(afterRes.status()).toBe(200)
      const afterBody = (await afterRes.json()).data
      const remote = afterBody.remotes.find((r: { name: string }) => r.name === REMOTE)
      expect(remote, `remote ${REMOTE} is listed`).toBeTruthy()
      expect(remote.type).toBe('sftp')
      expect(remote.options).toEqual({ host: '127.0.0.1', user: USER })
      expect(remote.secretsSet).toEqual(['pass'])
      expect(JSON.stringify(afterBody), 'the plain password is not in the response').not.toContain(PASS)

      // The file: 0600, the pass in rclone's OBSCURED form — never the plain
      // value. rclone's own `config dump` (the read the daemon's gate uses)
      // returns that obscured value too: the API never reveals a secret, and
      // `rclone reveal` on the node is the operator's own door back to it.
      expect(await getMode(RCLONE_CONF)).toBe('600')
      const text = await storeText()
      expect(text).toContain('[gt]')
      const passLine = text.split('\n').find(l => l.trim().startsWith('pass = '))
      expect(passLine, 'the section carries a pass line').toBeTruthy()
      expect(text, 'the plain password is not in the file').not.toContain(PASS)
      const dump = JSON.parse(await sshExec(`rclone --config ${RCLONE_CONF} --ask-password=false config dump`))
      expect(dump.gt.pass, 'config dump returns the obscured value, not the password').not.toBe(PASS)
      expect(passLine!.trim()).toBe(`pass = ${dump.gt.pass}`)
      expect(await sshExec(`rclone reveal '${dump.gt.pass}'`), 'the stored value reveals back to the password given').toBe(PASS)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('Test the saved remote: ok on the root and on dst (the real probe)', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      for (const body of [{ name: REMOTE }, { name: REMOTE, path: 'dst' }]) {
        const res = await ctx.post(`${V1}/cloud/remotes/test`, { data: body })
        expect(res.status(), await res.text()).toBe(200)
        expect((await res.json()).data).toEqual({ verdict: 'ok', message: '' })
      }
    }
    finally {
      await ctx.dispose()
    }
  })

  test('the probe\'s sftp shell detection is kept in the section and listed by the API', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // rclone's sftp backend autodetects the remote shell on connect and
      // PERSISTS what it learned into the --config it was given (GT
      // 2026-09-24). For a SAVED remote that is ANAS's own file, appended to
      // that remote's own section — a foreign key the INI writer keeps and
      // the API shows, rather than silently dropping on the next edit.
      const res = await ctx.post(`${V1}/cloud/remotes/test`, { data: { name: REMOTE } })
      expect(res.status(), await res.text()).toBe(200)
      expect((await res.json()).data.verdict).toBe('ok')

      const section = await storeSection(REMOTE)
      expect(section, 'rclone wrote its shell detection into the section').toContain('shell_type = unix')

      const remote = await listedRemote(ctx, REMOTE)
      expect(remote.options.shell_type).toBe('unix')
      expect(remote.secretsSet).toEqual(['pass'])
    }
    finally {
      await ctx.dispose()
    }
  })

  test('Test an unsaved dialog with the wrong password: auth, and nothing is written to the store', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const before = await storeText()
      const res = await ctx.post(`${V1}/cloud/remotes/test`, {
        data: {
          remote: {
            name: 'draft',
            type: 'sftp',
            options: { host: '127.0.0.1', user: USER, pass: 'wrong-password' },
          },
          path: 'dst',
        },
      })
      expect(res.status(), await res.text()).toBe(200)
      expect((await res.json()).data.verdict).toBe('auth')

      // The env-defined remote's own shell detection would land in the
      // --config file as a NEW [anastest] section — the probe runs against a
      // private copy, so ANAS's store is untouched, byte for byte.
      const after = await storeText()
      expect(after, 'a Test of an unsaved dialog writes nothing to the store').toBe(before)
      expect(after).not.toContain('[anastest]')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('Test an unsaved dialog at 192.0.2.1: unreachable (and the API stayed responsive)', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // 192.0.2.1 is TEST-NET — nothing answers. The probe must come back
      // bounded (the 45 s `timeout` wrapper), classified as unreachable, not
      // hang the request.
      const start = Date.now()
      const res = await ctx.post(`${V1}/cloud/remotes/test`, {
        data: {
          remote: {
            name: 'draft',
            type: 'sftp',
            options: { host: '192.0.2.1', user: USER, pass: PASS },
          },
          path: 'dst',
        },
      })
      expect(res.status(), await res.text()).toBe(200)
      expect((await res.json()).data.verdict).toBe('unreachable')
      expect(Date.now() - start).toBeLessThan(60_000)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('Test the saved remote with a missing path: not-found', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.post(`${V1}/cloud/remotes/test`, { data: { name: REMOTE, path: 'no-such-dir' } })
      expect(res.status(), await res.text()).toBe(200)
      expect((await res.json()).data.verdict).toBe('not-found')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('Test a saved name the file does not carry: 404 NOT_FOUND', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const res = await ctx.post(`${V1}/cloud/remotes/test`, { data: { name: 'nosuchremote' } })
      expect(res.status()).toBe(404)
      const body = await res.json()
      expect(body.error.code).toBe('NOT_FOUND')
      expect(body.error.message).toContain('nosuchremote')
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a duplicate create is refused 409; a PUT carrying type is refused 400', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      const before = await storeText()

      const dup = await ctx.post(`${V1}/cloud/remotes`, {
        data: { name: REMOTE, type: 'sftp', options: { host: '127.0.0.1', user: USER, pass: PASS } },
      })
      expect(dup.status(), await dup.text()).toBe(409)
      const dupBody = await dup.json()
      expect(dupBody.error.code).toBe('CONFLICT')
      expect(dupBody.error.message).toContain(REMOTE)

      // Type is immutable (rclone's own posture — a retype is a new remote).
      const retype = await ctx.put(`${V1}/cloud/remotes/${REMOTE}`, {
        data: { type: 'webdav', options: { host: '127.0.0.1' } },
      })
      expect(retype.status(), await retype.text()).toBe(400)
      expect((await retype.json()).error.code).toBe('VALIDATION_ERROR')

      expect(await storeText(), 'a refused write leaves the file alone').toBe(before)
    }
    finally {
      await ctx.dispose()
    }
  })

  test('an edit without the secret keeps it: the file is byte-identical except the changed key', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // Captured RIGHT BEFORE the edit: the probes above legitimately added
      // rclone's own shell-detection keys to [gt], and those are part of the
      // "before" the edit must preserve.
      const before = await storeText()
      // A non-secret key changed; the secret (pass) is not in the body at all
      // — secrets are write-only and the stored value must survive untouched.
      await runJob(ctx, 'put', `${V1}/cloud/remotes/${REMOTE}`, { options: { host: 'localhost' } })
      const after = await storeText()
      expect(after, 'only the changed key differs, byte for byte').toBe(before.replace('host = 127.0.0.1', 'host = localhost'))

      const remote = await listedRemote(ctx, REMOTE)
      expect(remote.options.host).toBe('localhost')
      expect(remote.options.user).toBe(USER)
      expect(remote.secretsSet).toEqual(['pass'])
    }
    finally {
      await ctx.dispose()
    }
  })

  test('a hand-added section with a comment survives an ANAS write byte-for-byte; delete removes only its section', async ({ playwright, pveTicket }) => {
    const ctx = await authedContext(playwright, pveTicket)
    try {
      // An operator edit ANAS did not make: a section with a full-line
      // comment, appended exactly as a text editor would leave it.
      await sshExec(`cat >> ${RCLONE_CONF} << 'ANAS'

[${HAND_SECTION}]
type = local
# a comment an operator left in the file
root = /srv/anas-handwritten
ANAS
`)
      const handBefore = await storeSection(HAND_SECTION)
      expect(handBefore).toContain('# a comment an operator left in the file')

      // The ANAS write over a file the operator also edits.
      await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
        name: REMOTE2,
        type: 'sftp',
        options: { host: '127.0.0.1', user: USER, pass: PASS },
      })
      expect(await storeText()).toContain('[gt2]')
      expect(await storeSection(HAND_SECTION), 'the hand-added section is byte-identical after the ANAS write').toBe(handBefore)

      // The delete removes ONLY its own section.
      const gtBeforeDelete = await storeSection(REMOTE)
      await runJob(ctx, 'delete', `${V1}/cloud/remotes/${REMOTE2}`)
      const afterDelete = await storeText()
      expect(afterDelete).not.toContain('[gt2]')
      expect(await storeSection(HAND_SECTION), 'the hand-added section is untouched by the delete').toBe(handBefore)
      expect(await storeSection(REMOTE), 'the other remote is untouched by the delete').toBe(gtBeforeDelete)

      // And its own door removes the first remote too: what is left of the
      // file is the operator's own section, nothing of ANAS's.
      await runJob(ctx, 'delete', `${V1}/cloud/remotes/${REMOTE}`)
      const finalText = await storeText()
      expect(finalText).not.toContain('[gt]')
      expect(finalText.trim(), 'only the hand-added section is left').toBe(handBefore.trim())

      // A second delete of a name that is gone is a 404, not a job.
      const again = await ctx.delete(`${V1}/cloud/remotes/${REMOTE}`)
      expect(again.status(), await again.text()).toBe(404)
      expect((await again.json()).error.code).toBe('NOT_FOUND')
    }
    finally {
      await ctx.dispose()
    }
  })
})
