import type { APIRequestContext } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { apiCtx, awaitJob, remoteNames, runJob, taskNames, V1 } from './fixtures/cloud-api'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * LIVE PROOFS for cloudproof.1 — the four NON-OAuth curated backends driven
 * against real loopback servers, through the ANAS API with a PVE ticket, over
 * the real daemon (deploy 6b4b189):
 *
 *   s3       versitygw 1.8.0 (posix backend, /opt/anas-test/s3-data, bucket
 *            gtbucket, keys gtaccess/gtsecret123) as anas-gt-s3 on :7070
 *   smb      the node's own Samba — fixture user gtsmbuser + share gtsmbshare
 *            created THROUGH the API by the fixture, on /var/tmp/anas-gtsmb
 *   webdav   `rclone serve webdav` as anas-gt-webdav on :8087 (gtdav)
 *   ftp      python3-pyftpdlib as anas-gt-ftp on :2121 (gtftp) — rclone 1.60
 *            has NO `serve ftp` (its serve subcommands are dlna, docker,
 *            http, restic, sftp, webdav; captured on the node 2026-09-27),
 *            so the SERVER is pyftpdlib while the client under proof stays
 *            rclone's own ftp backend.
 *
 * Per backend (fixture cloud-backends-fixture.sh <up|down> <profile>):
 * the remote is created with ONLY the backend's curated essential fields
 * (cloud-guide.ts) — proving the guided form's field set is sufficient;
 * Test → ok; a copy task over ~12 files + a `*.tmp`-excluded scratch.tmp →
 * the destination checked THROUGH the backend itself (rclone env-remote for
 * s3/ftp, smbclient for SMB, PROPFIND for WebDAV); the task edited to sync
 * with one source file deleted → gone at the destination; a wrong-password
 * Test → the backend's verdict; the remote delete refuses (409) while the
 * task references it; task then remote removed → both gone.
 *
 * FINDINGS recorded along the way (honest assertions, not papered over):
 *   1. The curated sets suffice everywhere — versitygw (provider `Other`)
 *      needs NO `force_path_style` on rclone 1.60, and smb needs no `domain`.
 *   2. The test verdict classifier (rclone-probe.ts AUTH_RE) answers `auth`
 *      for s3 (403) and webdav (401) but only `error` for SMB's NT logon
 *      failure and FTP's 530 — real credential failures below the generic
 *      verdict. The auth step below asserts the verdicts the daemon ACTUALLY
 *      answers; widening AUTH_RE is a 0.4.1 candidate.
 *   3. `s3` region: the curated set carries `region`; versitygw (default
 *      region us-east-1) accepts it — nothing outside the set was needed.
 *   4. rclone's smb backend names the SHARE as the first path component, so
 *      a task's remote-side path under an SMB remote is `<share>/<subpath>`
 *      (the Test door probes the remote root = the share list and cannot
 *      catch a bare-subpath mistake — only a real run does).
 *   5. Against pyftpdlib, rclone 1.60's ftp backend cannot create a missing
 *      top-level destination directory (pyftpdlib answers `501 No such
 *      directory` to a LIST of a missing path, not the standard 550), so the
 *      fixture pre-creates the `proof` landing dir. rclone creates it fine
 *      against its own webdav/s3 servers — a pyftpdlib quirk, not a product
 *      defect.
 *
 * FIXTURE: the fixture up/down runs INSIDE this spec (beforeAll/afterAll) —
 * every `up` tears down leftovers first (idempotent), every `down` verifies
 * unit, dirs, server process and (smb) user/share are gone. The operator's
 * remote gtest, task testoff, existing shares/users and the gtbackup/gtiscsi
 * pools are never touched: every fixture name is gt-prefixed.
 */

const FIXTURE_SH = new URL('../../test/stunt-node/cloud-backends-fixture.sh', import.meta.url).pathname

/** The copy-task source the fixture builds (12 files + scratch.tmp). */
const SOURCE = '/var/tmp/anas-gtcloud-src'
/** Raw OnCalendar far in the future — a stale stamp must never self-run. */
const SCHEDULE = '2030-01-01 00:00:00'

interface Backend {
  key: string
  remote: string
  type: string
  /** ONLY the curated essential fields (cloud-guide.ts) this backend needs. */
  options: Record<string, string>
  /** The same remote with the credential wrong — the auth-verdict probe. */
  wrongOptions: Record<string, string>
  /** The verdict the daemon ACTUALLY answers for wrongOptions (finding 2). */
  authVerdict: string
  /** The non-secret option names the remotes listing must carry. */
  nonSecretKeys: string[]
  /** The secret names `secretsSet` must name. */
  secretKeys: string[]
  task: string
  /** Remote-side path under `remote:` — bucket+prefix on s3, `proof` elsewhere. */
  path: string
  /** ssh command listing the destination THROUGH the backend (names + sizes). */
  listCmd: string
}

const BACKENDS: Backend[] = [
  {
    key: 's3',
    remote: 'gts3',
    type: 's3',
    options: {
      provider: 'Other',
      access_key_id: 'gtaccess',
      secret_access_key: 'gtsecret123',
      endpoint: 'http://127.0.0.1:7070',
      region: 'us-east-1',
    },
    wrongOptions: {
      provider: 'Other',
      access_key_id: 'gtaccess',
      secret_access_key: 'gtwrong-secret',
      endpoint: 'http://127.0.0.1:7070',
      region: 'us-east-1',
    },
    authVerdict: 'auth',
    nonSecretKeys: ['provider', 'access_key_id', 'endpoint', 'region'],
    secretKeys: ['secret_access_key'],
    task: 'gtcloud-s3',
    path: 'gtbucket/proof',
    listCmd: 'tmp=$(mktemp -d) && '
      + 'RCLONE_CONFIG_GTPROBE_TYPE=s3 RCLONE_CONFIG_GTPROBE_PROVIDER=Other '
      + 'RCLONE_CONFIG_GTPROBE_ACCESS_KEY_ID=gtaccess RCLONE_CONFIG_GTPROBE_SECRET_ACCESS_KEY=gtsecret123 '
      + 'RCLONE_CONFIG_GTPROBE_ENDPOINT=http://127.0.0.1:7070 RCLONE_CONFIG_GTPROBE_REGION=us-east-1 '
      + 'rclone --config $tmp/rclone.conf ls gtprobe:gtbucket/proof 2>&1; rc=$?; rm -rf $tmp; exit $rc',
  },
  {
    key: 'smb',
    remote: 'gtsmb',
    type: 'smb',
    options: { host: '127.0.0.1', user: 'gtsmbuser', pass: 'gtsmbpass' },
    wrongOptions: { host: '127.0.0.1', user: 'gtsmbuser', pass: 'gtwrong-pass' },
    authVerdict: 'error',
    nonSecretKeys: ['host', 'user'],
    secretKeys: ['pass'],
    task: 'gtcloud-smb',
    // rclone's smb backend names the SHARE as the FIRST path component
    // (`gtsmb:` lists shares; `gtsmb:share/sub` goes inside) — the task path
    // under an SMB remote is `<share>/<subpath>` (finding 4: a bare `proof`
    // addresses a share named 'proof' and fails with Network Name Not Found;
    // the Test door cannot see it, it probes the remote root = the share list).
    path: 'gtsmbshare/proof',
    listCmd: 'smbclient //127.0.0.1/gtsmbshare -U gtsmbuser%gtsmbpass -c \'cd proof; ls\' 2>&1',
  },
  {
    key: 'webdav',
    remote: 'gtdav',
    type: 'webdav',
    options: { url: 'http://127.0.0.1:8087', vendor: 'other', user: 'gtdav', pass: 'gtdavpass' },
    wrongOptions: { url: 'http://127.0.0.1:8087', vendor: 'other', user: 'gtdav', pass: 'gtwrong-pass' },
    authVerdict: 'auth',
    nonSecretKeys: ['url', 'vendor', 'user'],
    secretKeys: ['pass'],
    task: 'gtcloud-webdav',
    path: 'proof',
    listCmd: 'curl -su gtdav:gtdavpass -X PROPFIND -H \'Depth: 1\' http://127.0.0.1:8087/proof/ 2>&1',
  },
  {
    key: 'ftp',
    remote: 'gtftp',
    type: 'ftp',
    options: { host: '127.0.0.1', port: '2121', user: 'gtftp', pass: 'gtftppass' },
    wrongOptions: { host: '127.0.0.1', port: '2121', user: 'gtftp', pass: 'gtwrong-pass' },
    authVerdict: 'error',
    nonSecretKeys: ['host', 'port', 'user'],
    secretKeys: ['pass'],
    task: 'gtcloud-ftp',
    path: 'proof',
    listCmd: 'tmp=$(mktemp -d) && P=$(printf %s gtftppass | rclone obscure -) && '
      + 'RCLONE_CONFIG_GTPROBE_TYPE=ftp RCLONE_CONFIG_GTPROBE_HOST=127.0.0.1 RCLONE_CONFIG_GTPROBE_PORT=2121 '
      + 'RCLONE_CONFIG_GTPROBE_USER=gtftp RCLONE_CONFIG_GTPROBE_PASS=$P '
      + 'rclone --config $tmp/rclone.conf ls gtprobe:proof 2>&1; rc=$?; rm -rf $tmp; exit $rc',
  },
]

/** f01.txt … f12.txt — every name the copy must land at the destination. */
const ALL_FILES = Array.from({ length: 12 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`)
const SYNC_DELETED = 'f06.txt'

/**
 * The destination listing through the backend, reduced to the file names the
 * run should have produced (smbclient rows and PROPFIND hrefs and rclone ls
 * paths all carry the bare names).
 */
async function destFiles(b: Backend): Promise<string[]> {
  const out = await sshExec(b.listCmd)
  const names = out.match(/(?:f\d{2}|scratch)\.(?:txt|tmp)/g) ?? []
  // The rule's autofix sorts the SET itself (no such method) — keep the spread.
  // eslint-disable-next-line e18e/prefer-array-to-sorted
  return [...new Set(names)].sort()
}

/**
 * Rebuild the shared source deterministically — backends run serially and
 * the sync step deletes a file from it, so every backend starts from the full
 * 12 + scratch.tmp whatever a previous backend left behind.
 */
async function resetSource(): Promise<void> {
  await sshExec(
    `rm -rf ${SOURCE} && mkdir -p ${SOURCE} && for i in $(seq -w 1 12); do `
    + `printf 'fixture file %s\\n' $i > ${SOURCE}/f$i.txt; done && `
    + `printf 'to be excluded\\n' > ${SOURCE}/scratch.tmp && chmod -R a+r ${SOURCE}`,
  )
}

async function remotesList(ctx: APIRequestContext): Promise<Array<Record<string, any>>> {
  const res = await ctx.get(`${V1}/cloud/remotes`)
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).data.remotes as Array<Record<string, any>>
}

async function createRemote(ctx: APIRequestContext, b: Backend): Promise<void> {
  if (!(await remoteNames(ctx)).includes(b.remote)) {
    await runJob(ctx, 'post', `${V1}/cloud/remotes`, {
      name: b.remote,
      type: b.type,
      options: b.options,
    })
  }
}

async function createTask(ctx: APIRequestContext, b: Backend, mode: 'copy' | 'sync'): Promise<void> {
  await runJob(ctx, 'post', `${V1}/cloud/tasks`, {
    name: b.task,
    source: SOURCE,
    remote: b.remote,
    path: b.path,
    mode,
    excludes: ['*.tmp'],
    schedule: SCHEDULE,
    enabled: true,
  })
}

/** POST the test door for an UNSAVED remote and return its verdict + message. */
async function probeRemote(
  ctx: APIRequestContext,
  type: string,
  options: Record<string, string>,
): Promise<{ status: number, verdict?: string, message?: string }> {
  const res = await ctx.post(`${V1}/cloud/remotes/test`, {
    data: { remote: { name: 'gtdraft', type, options } },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status(), verdict: body?.data?.verdict, message: body?.data?.message }
}

test.beforeAll(async () => {
  // up ALL four profiles — each up tears its own leftovers down first, so a
  // crashed earlier run cannot poison this one. A failed up fails the suite
  // here (the skip guard below must never turn a missing fixture into green).
  await execFileAsync(FIXTURE_SH, ['up', 'all'])
})

test.beforeEach(async () => {
  // The fixture's source directory is the "fixture present" signal (all four
  // ups rebuild it; s3 is up first but smb/webdav/ftp rebuild it too).
  test.skip(
    !(await sshExec(`test -d ${SOURCE} && echo yes`).then(() => true).catch(() => false)),
    `cloud backends fixture not present — run ${FIXTURE_SH} up all`,
  )
})

test.describe.serial('cloud sync live proofs over real backends (cloudproof.1)', () => {
  test.setTimeout(300_000)

  test.afterAll(async ({ playwright }) => {
    // Teardown even on failure: this spec's OWN remotes/tasks through their
    // API doors (task first — the remote delete refuses while referenced),
    // then the fixture down, whose ✓/✗ lines VERIFY the teardown. Best-effort
    // — must not mask the run's results.
    const ctx = await apiCtx(playwright).catch(() => null)
    try {
      if (ctx) {
        for (const b of BACKENDS) {
          await ctx.delete(`${V1}/cloud/tasks/${b.task}`).catch(() => {})
          await expect
            .poll(async () => (await taskNames(ctx)).includes(b.task), { timeout: 30_000 })
            .toBe(false)
          await ctx.delete(`${V1}/cloud/remotes/${b.remote}`).catch(() => {})
        }
        await ctx.dispose()
      }
    }
    finally {
      const down = String(
        (await execFileAsync(FIXTURE_SH, ['down', 'all']).then(r => r.stdout).catch(e => e.stdout ?? e.message ?? '')) ?? '',
      )
      // eslint-disable-next-line no-console -- the ✓/✗ lines ARE the verification
      console.log(down)
      expect(down.includes('✗'), `fixture down must verify clean:\n${down}`).toBe(false)
      expect((down.match(/✓/g) ?? []).length).toBeGreaterThanOrEqual(12)
    }
  })

  for (const b of BACKENDS) {
    test(`${b.key} — curated create, Test ok, copy run lands 12 files, sync run deletes, wrong-credential verdict, remove-guard`, async ({ playwright }) => {
      const ctx = await apiCtx(playwright)
      try {
        await resetSource()
        // (a) create with ONLY the curated essential fields; the listing
        // carries the non-secret keys, the secrets only as `secretsSet`.
        await createRemote(ctx, b)
        const row = (await remotesList(ctx)).find(r => r.name === b.remote)
        expect(row, `remote ${b.remote} listed`).toBeTruthy()
        const listed = row as unknown as { options: Record<string, string>, secretsSet: string[] }
        for (const k of b.nonSecretKeys)
          expect(Object.keys(listed.options), `non-secret key ${k}`).toContain(k)
        for (const k of b.secretKeys) {
          expect(Object.keys(listed.options), `secret ${k} never listed`).not.toContain(k)
          expect(listed.secretsSet, `secretsSet names ${k}`).toContain(k)
        }

        // (b) Test → ok.
        const ok = await probeRemote(ctx, b.type, b.options)
        expect(ok.status, JSON.stringify(ok)).toBe(200)
        expect(ok.verdict, JSON.stringify(ok)).toBe('ok')

        // (c) the copy task → run now → 12 files at the destination, the
        // *.tmp exclude honoured.
        await createTask(ctx, b, 'copy')
        const run = await ctx.post(`${V1}/cloud/tasks/${b.task}/run`, { data: {} })
        expect(run.status(), await run.text()).toBe(202)
        const runJobId = (await run.json()).job.id
        expect((await awaitJob(ctx, runJobId)).status).toBe('completed')
        let names = await destFiles(b)
        for (const f of ALL_FILES)
          expect(names, `${b.key} destination listing:\n${names.join('\n')}`).toContain(f)
        expect(names, 'the *.tmp exclude kept scratch.tmp off the destination').not.toContain('scratch.tmp')

        // (d) edit to sync, delete one source file, run again → gone at the
        // destination (copy never deletes; sync does — both modes in one run).
        await runJob(ctx, 'put', `${V1}/cloud/tasks/${b.task}`, {
          name: b.task,
          source: SOURCE,
          remote: b.remote,
          path: b.path,
          mode: 'sync',
          excludes: ['*.tmp'],
          schedule: SCHEDULE,
          enabled: true,
        })
        await sshExec(`rm -f ${SOURCE}/${SYNC_DELETED}`)
        const run2 = await ctx.post(`${V1}/cloud/tasks/${b.task}/run`, { data: {} })
        expect(run2.status(), await run2.text()).toBe(202)
        expect((await awaitJob(ctx, (await run2.json()).job.id)).status).toBe('completed')
        names = await destFiles(b)
        expect(names, `${b.key} destination after the sync run:\n${names.join('\n')}`)
          .not
          .toContain(SYNC_DELETED)
        for (const f of ALL_FILES.filter(f => f !== SYNC_DELETED))
          expect(names).toContain(f)
      }
      finally {
        await ctx.dispose()
      }

      // (e) a wrong credential → the backend's verdict with a sentence, never
      // Go internals (finding 2: smb/ftp classify as error, not auth).
      const ctx2 = await apiCtx(playwright)
      try {
        const wrong = await probeRemote(ctx2, b.type, b.wrongOptions)
        expect(wrong.status, JSON.stringify(wrong)).toBe(200)
        expect(wrong.verdict, JSON.stringify(wrong)).toBe(b.authVerdict)
        expect(wrong.message ?? '', 'a wrong credential names itself in a sentence').not.toBe('')
        expect(`${wrong.verdict} ${wrong.message}`).not.toContain('goroutine')
        expect(`${wrong.verdict} ${wrong.message}`).not.toContain('cannot unmarshal')
      }
      finally {
        await ctx2.dispose()
      }

      // (f) the remote delete refuses while the task references it; task
      // then remote removed → both gone.
      const ctx3 = await apiCtx(playwright)
      try {
        const refused = await ctx3.delete(`${V1}/cloud/remotes/${b.remote}`)
        expect(refused.status(), await refused.text()).toBe(409)
        expect((await refused.json()).error.message).toContain(b.task)

        await runJob(ctx3, 'delete', `${V1}/cloud/tasks/${b.task}`)
        await runJob(ctx3, 'delete', `${V1}/cloud/remotes/${b.remote}`)
        expect(await remoteNames(ctx3)).not.toContain(b.remote)
        expect(await taskNames(ctx3)).not.toContain(b.task)
      }
      finally {
        await ctx3.dispose()
      }
    })
  }
})
