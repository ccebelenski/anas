import type { CloudBackendCase } from './fixtures/cloud-runner'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { apiCtx, taskNames, V1 } from './fixtures/cloud-api'
import { runCloudBackendProof } from './fixtures/cloud-runner'
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
 * Per backend (fixture cloud-backends-fixture.sh <up|down> <profile>) the
 * SIX-STEP runner in fixtures/cloud-runner.ts does the story's steps: the
 * remote is created with ONLY the backend's curated essential fields
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
 *   2. The test verdict classifier (rclone-probe.ts AUTH_RE) answered
 *      `auth` for s3 (403) and webdav (401) but only `error` for SMB's NT
 *      logon failure and FTP's 530 — real credential failures below the
 *      generic verdict. FIXED in 0.4.1: the captured lines live in the
 *      daemon's fixtures (`probe-smb-auth-fail-1.60.1.log`,
 *      `probe-ftp-auth-fail-1.60.1.log`) and AUTH_RE reads them; this spec
 *      asserts `auth` for all four and needs one run on the node after the
 *      0.4.1 deploy to re-prove it.
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

const BACKENDS: CloudBackendCase[] = [
  {
    key: 's3',
    remotes: [{
      name: 'gts3',
      type: 's3',
      options: {
        provider: 'Other',
        access_key_id: 'gtaccess',
        secret_access_key: 'gtsecret123',
        endpoint: 'http://127.0.0.1:7070',
        region: 'us-east-1',
      },
      nonSecretKeys: ['provider', 'access_key_id', 'endpoint', 'region'],
      secretKeys: ['secret_access_key'],
    }],
    task: 'gtcloud-s3',
    // bucket+prefix under `gts3:`
    path: 'gtbucket/proof',
    listCmd: 'tmp=$(mktemp -d) && '
      + 'RCLONE_CONFIG_GTPROBE_TYPE=s3 RCLONE_CONFIG_GTPROBE_PROVIDER=Other '
      + 'RCLONE_CONFIG_GTPROBE_ACCESS_KEY_ID=gtaccess RCLONE_CONFIG_GTPROBE_SECRET_ACCESS_KEY=gtsecret123 '
      + 'RCLONE_CONFIG_GTPROBE_ENDPOINT=http://127.0.0.1:7070 RCLONE_CONFIG_GTPROBE_REGION=us-east-1 '
      + 'rclone --config $tmp/rclone.conf ls gtprobe:gtbucket/proof 2>&1; rc=$?; rm -rf $tmp; exit $rc',
    probes: {
      ok: [{ label: 'curated dialog', type: 's3', options: {
        provider: 'Other',
        access_key_id: 'gtaccess',
        secret_access_key: 'gtsecret123',
        endpoint: 'http://127.0.0.1:7070',
        region: 'us-east-1',
      } }],
      wrong: [{ label: 'wrong secret key', type: 's3', options: {
        provider: 'Other',
        access_key_id: 'gtaccess',
        secret_access_key: 'gtwrong-secret',
        endpoint: 'http://127.0.0.1:7070',
        region: 'us-east-1',
      }, verdict: 'auth' }],
    },
  },
  {
    key: 'smb',
    remotes: [{
      name: 'gtsmb',
      type: 'smb',
      options: { host: '127.0.0.1', user: 'gtsmbuser', pass: 'gtsmbpass' },
      nonSecretKeys: ['host', 'user'],
      secretKeys: ['pass'],
    }],
    task: 'gtcloud-smb',
    // rclone's smb backend names the SHARE as the FIRST path component
    // (`gtsmb:` lists shares; `gtsmb:share/sub` goes inside) — the task path
    // under an SMB remote is `<share>/<subpath>` (finding 4: a bare `proof`
    // addresses a share named 'proof' and fails with Network Name Not Found;
    // the Test door cannot see it, it probes the remote root = the share list).
    path: 'gtsmbshare/proof',
    listCmd: 'smbclient //127.0.0.1/gtsmbshare -U gtsmbuser%gtsmbpass -c \'cd proof; ls\' 2>&1',
    probes: {
      ok: [{ label: 'curated dialog', type: 'smb', options: { host: '127.0.0.1', user: 'gtsmbuser', pass: 'gtsmbpass' } }],
      wrong: [{ label: 'wrong password', type: 'smb', options: { host: '127.0.0.1', user: 'gtsmbuser', pass: 'gtwrong-pass' }, verdict: 'auth' }],
    },
  },
  {
    key: 'webdav',
    remotes: [{
      name: 'gtdav',
      type: 'webdav',
      options: { url: 'http://127.0.0.1:8087', vendor: 'other', user: 'gtdav', pass: 'gtdavpass' },
      nonSecretKeys: ['url', 'vendor', 'user'],
      secretKeys: ['pass'],
    }],
    task: 'gtcloud-webdav',
    path: 'proof',
    listCmd: 'curl -su gtdav:gtdavpass -X PROPFIND -H \'Depth: 1\' http://127.0.0.1:8087/proof/ 2>&1',
    probes: {
      ok: [{ label: 'curated dialog', type: 'webdav', options: { url: 'http://127.0.0.1:8087', vendor: 'other', user: 'gtdav', pass: 'gtdavpass' } }],
      wrong: [{ label: 'wrong password', type: 'webdav', options: { url: 'http://127.0.0.1:8087', vendor: 'other', user: 'gtdav', pass: 'gtwrong-pass' }, verdict: 'auth' }],
    },
  },
  {
    key: 'ftp',
    remotes: [{
      name: 'gtftp',
      type: 'ftp',
      options: { host: '127.0.0.1', port: '2121', user: 'gtftp', pass: 'gtftppass' },
      nonSecretKeys: ['host', 'port', 'user'],
      secretKeys: ['pass'],
    }],
    task: 'gtcloud-ftp',
    path: 'proof',
    listCmd: 'tmp=$(mktemp -d) && P=$(printf %s gtftppass | rclone obscure -) && '
      + 'RCLONE_CONFIG_GTPROBE_TYPE=ftp RCLONE_CONFIG_GTPROBE_HOST=127.0.0.1 RCLONE_CONFIG_GTPROBE_PORT=2121 '
      + 'RCLONE_CONFIG_GTPROBE_USER=gtftp RCLONE_CONFIG_GTPROBE_PASS=$P '
      + 'rclone --config $tmp/rclone.conf ls gtprobe:proof 2>&1; rc=$?; rm -rf $tmp; exit $rc',
    probes: {
      ok: [{ label: 'curated dialog', type: 'ftp', options: { host: '127.0.0.1', port: '2121', user: 'gtftp', pass: 'gtftppass' } }],
      wrong: [{ label: 'wrong password', type: 'ftp', options: { host: '127.0.0.1', port: '2121', user: 'gtftp', pass: 'gtwrong-pass' }, verdict: 'auth' }],
    },
  },
]

test.beforeAll(async () => {
  // up THIS spec's four profiles — each up tears its own leftovers down
  // first, so a crashed earlier run cannot poison this one. A failed up
  // fails the suite here (the skip guard below must never turn a missing
  // fixture into green).
  await execFileAsync(FIXTURE_SH, ['up', 's3', 'smb', 'webdav', 'ftp'])
})

test.beforeEach(async () => {
  // The fixture's source directory is the "fixture present" signal (all four
  // ups rebuild it; s3 is up first but smb/webdav/ftp rebuild it too).
  test.skip(
    !(await sshExec(`test -d /var/tmp/anas-gtcloud-src && echo yes`).then(() => true).catch(() => false)),
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
          await ctx.delete(`${V1}/cloud/remotes/${b.remotes[0].name}`).catch(() => {})
        }
        await ctx.dispose()
      }
    }
    finally {
      const down = String(
        (await execFileAsync(FIXTURE_SH, ['down', 's3', 'smb', 'webdav', 'ftp']).then(r => r.stdout).catch(e => e.stdout ?? e.message ?? '')) ?? '',
      )
      // eslint-disable-next-line no-console -- the ✓/✗ lines ARE the verification
      console.log(down)
      expect(down.includes('✗'), `fixture down must verify clean:\n${down}`).toBe(false)
      expect((down.match(/✓/g) ?? []).length).toBeGreaterThanOrEqual(12)
    }
  })

  for (const b of BACKENDS) {
    test(`${b.key} — curated create, Test ok, copy run lands 12 files, sync run deletes, wrong-credential verdict, remove-guard`, async ({ playwright }) => {
      await runCloudBackendProof(playwright, b)
    })
  }
})
