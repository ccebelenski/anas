import type { CloudBackendCase } from './fixtures/cloud-runner'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { apiCtx, taskNames, V1 } from './fixtures/cloud-api'
import { runCloudBackendProof } from './fixtures/cloud-runner'
import { sshExec } from './fixtures/stunt-node'

const execFileAsync = promisify(execFile)

/**
 * LIVE PROOFS for cloudproof.2 — three more real protocol paths with no
 * account, through the ANAS API with a PVE ticket, over the current build:
 *
 *   azure  Azurite (Microsoft's emulator, npm) as anas-gt-azure on
 *          127.0.0.1:10000 — the well-known dev account devstoreaccount1,
 *          container gtcontainer created through rclone.
 *   gcs    fake-gcs-server v1.56.1 as anas-gt-gcs on 127.0.0.1:4443 (http,
 *          filesystem backend) — bucket gtbucket is a directory under
 *          /opt/anas-test/gcs-data.
 *   crypt  NO server: the node's sshd with fixture user gtcryptsftp (home
 *          /var/tmp/anas-gtcrypt). The spec creates TWO remotes through the
 *          API — gtcryptsftp (sftp) then gtcrypt (crypt, remote
 *          `gtcryptsftp:crypt-base`, password, default name encryption) —
 *          and the task runs over the CRYPT remote.
 *
 * Per backend the SIX-STEP runner in fixtures/cloud-runner.ts (shared with
 * cloudproof.1's cloud-backends.spec.ts — one helper, not a copy) does the
 * story's steps; azure/gcs destinations are verified through `rclone ls`
 * env-config remotes on the node, crypt through the underlying sftp
 * directory (encrypted names, larger sizes) AND through an env-config crypt
 * remote (byte-identical content).
 *
 * FINDINGS recorded along the way (honest assertions, not papered over):
 *   1. azureblob curation gap: reaching an http emulator needs BOTH
 *      `use_emulator` (standard) and `endpoint` (advanced) — neither is in
 *      the curated essential set {account, key}, so the guided form's
 *      primary fields cannot reach Azurite. On rclone 1.60.1 either alone
 *      fails: `endpoint` alone builds `https://<account>.<endpoint>` (https
 *      only), and `use_emulator` alone fails because 1.60.1 defaults
 *      `endpoint` to `blob.core.windows.net` BEFORE the use_emulator branch
 *      reads it. And under use_emulator rclone IGNORES account/key — they
 *      are hardcoded to the dev credentials — so a wrong key still tests
 *      `ok`. azureblob on rclone 1.60.1 therefore has no shape that answers
 *      an `auth` verdict against Azurite; the wrong-key probes here pin the
 *      verdicts that ARE honest (`ok` under use_emulator, `unreachable`
 *      without it).
 *   2. gcs is UNCURATED: the proof exercises rclone's own basic option list
 *      — anonymous (standard), plus project_number (standard; 1.60 refuses
 *      a bucket listing without one) and endpoint (ADVANCED — the dialog
 *      tucks it under "More options"; recorded, per the story's ask).
 *   3. crypt wrong password: the Test door answers `ok` — rclone 1.60
 *      reports undecryptable names at Debug level, and the probe lists the
 *      remote root, so no error surfaces (a deeper `path` answers
 *      `not-found`: the encrypted directory name does not decrypt). The
 *      Test door cannot catch a wrong crypt password.
 *   4. The remote delete door checks TASK references only: DELETE
 *      gtcryptsftp while gtcrypt (a crypt remote whose `remote` names it)
 *      still exists answers 202 and strands the crypt remote (its next use
 *      fails with "didn't find section in config file"). Recorded as a
 *      finding; the spec asserts the observed 202.
 *
 * FIXTURE: cloud-backends-fixture.sh profiles azure/gcs/crypt, up in
 * beforeAll (idempotent), down in afterAll with every ✓ verified. The
 * operator's remote gtest, task testoff, existing shares/users and the
 * gtbackup/gtiscsi pools are never touched: every fixture name is
 * gt-prefixed (gtcryptsftp/gtcrypt* included).
 */

const FIXTURE_SH = new URL('../../test/stunt-node/cloud-backends-fixture.sh', import.meta.url).pathname

const AZ_ENDPOINT = 'http://127.0.0.1:10000/devstoreaccount1'
const GCS_ENDPOINT = 'http://127.0.0.1:4443/storage/v1/'

/** rclone env-config reaching Azurite on the node (use_emulator + endpoint). */
const AZ_LS = 'tmp=$(mktemp -d) && '
  + 'RCLONE_CONFIG_GTPROBE_TYPE=azureblob RCLONE_CONFIG_GTPROBE_USE_EMULATOR=true '
  + `RCLONE_CONFIG_GTPROBE_ENDPOINT=${AZ_ENDPOINT} `
  + 'rclone --config $tmp/rclone.conf ls gtprobe:gtcontainer/proof 2>&1; rc=$?; rm -rf $tmp; exit $rc'

/** rclone env-config reaching the emulator's GCS API (anonymous + project). */
const GCS_LS = 'tmp=$(mktemp -d) && '
  + 'RCLONE_CONFIG_GTPROBE_TYPE=gcs RCLONE_CONFIG_GTPROBE_ANONYMOUS=true '
  + 'RCLONE_CONFIG_GTPROBE_PROJECT_NUMBER=123456 '
  + `RCLONE_CONFIG_GTPROBE_ENDPOINT=${GCS_ENDPOINT} `
  + 'rclone --config $tmp/rclone.conf ls gtprobe:gtbucket/proof 2>&1; rc=$?; rm -rf $tmp; exit $rc'

/** rclone env-config crypt remote over the SAVED gtcryptsftp remote. */
function cryptEnvCmd(sub: string): string {
  return `tmp=$(mktemp -d) && cp /etc/anas/rclone.conf $tmp/rclone.conf && `
    + 'RCLONE_CONFIG_GTPROBE_TYPE=crypt RCLONE_CONFIG_GTPROBE_REMOTE=gtcryptsftp:crypt-base '
    + 'RCLONE_CONFIG_GTPROBE_PASSWORD=$(printf %s gtcryptsecret | rclone obscure -) '
    + `rclone --config $tmp/rclone.conf ${sub} 2>&1; rc=$?; rm -rf $tmp; exit $rc`
}

/** The sftp-side encrypted tree under the crypt base. */
const CRYPT_BASE = '/var/tmp/anas-gtcrypt/crypt-base'

const BACKENDS: CloudBackendCase[] = [
  {
    key: 'azure',
    remotes: [{
      name: 'gtazure',
      type: 'azureblob',
      // The curated essentials (account, key) PLUS the two options the
      // dialog hides that the emulator actually needs (finding 1: account
      // and key are IGNORED under use_emulator).
      options: {
        account: 'devstoreaccount1',
        key: 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
        use_emulator: 'true',
        endpoint: AZ_ENDPOINT,
      },
      nonSecretKeys: ['account', 'use_emulator', 'endpoint'],
      // rclone types azureblob.key as a plain string (not IsPassword), but
      // ANAS's name rule makes any `key` a secret: never listed, named in
      // secretsSet, stored plain (an obscured one would not base64-decode).
      secretKeys: ['key'],
    }],
    task: 'gtcloud-azure',
    path: 'gtcontainer/proof',
    listCmd: AZ_LS,
    probes: {
      ok: [{ label: 'dialog fields + emulator options', type: 'azureblob', options: {
        account: 'devstoreaccount1',
        key: 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
        use_emulator: 'true',
        endpoint: AZ_ENDPOINT,
      } }],
      wrong: [
        // A wrong key CANNOT yield an auth verdict here (finding 1): under
        // use_emulator the credentials are ignored, so the probe succeeds.
        { label: 'wrong key under use_emulator (credentials ignored)', type: 'azureblob', options: {
          account: 'devstoreaccount1',
          key: 'gtwrong-key',
          use_emulator: 'true',
          endpoint: AZ_ENDPOINT,
        }, verdict: 'ok' },
        // Without use_emulator the https-only branch cannot even parse a
        // non-base64 key (rclone's own sentence, before any network) — and
        // with a valid-base64 wrong key it would build
        // https://devstoreaccount1.<endpoint> and never reach the http
        // emulator either. Pinned to the parse failure the wrong key gets.
        { label: 'wrong key, no use_emulator (parse failure before any request)', type: 'azureblob', options: {
          account: 'devstoreaccount1',
          key: 'gtwrong-key',
          endpoint: AZ_ENDPOINT,
        }, verdict: 'error' },
      ],
    },
  },
  {
    key: 'gcs',
    remotes: [{
      name: 'gtgcs',
      type: 'google cloud storage',
      // UNCURATED backend: rclone's own basic (non-advanced) option list is
      // what the dialog renders. endpoint is ADVANCED on 1.60 (finding 2).
      options: {
        anonymous: 'true',
        project_number: '123456',
        endpoint: GCS_ENDPOINT,
      },
      nonSecretKeys: ['anonymous', 'project_number', 'endpoint'],
      secretKeys: [],
    }],
    task: 'gtcloud-gcs',
    path: 'gtbucket/proof',
    listCmd: GCS_LS,
    probes: {
      ok: [{ label: 'rclone basic options', type: 'google cloud storage', options: {
        anonymous: 'true',
        project_number: '123456',
        endpoint: GCS_ENDPOINT,
      } }],
      // No credential to get wrong (anonymous) — the wrong ENDPOINT is the
      // failure the dialog can meet: nothing listens on :4444.
      wrong: [{ label: 'wrong endpoint port (anonymous has no credential)', type: 'google cloud storage', options: {
        anonymous: 'true',
        project_number: '123456',
        endpoint: 'http://127.0.0.1:4444/storage/v1/',
      }, verdict: 'unreachable' }],
    },
  },
  {
    key: 'crypt',
    remotes: [
      {
        name: 'gtcryptsftp',
        type: 'sftp',
        options: { host: '127.0.0.1', user: 'gtcryptsftp', pass: 'gtcryptpass' },
        nonSecretKeys: ['host', 'user'],
        secretKeys: ['pass'],
      },
      {
        name: 'gtcrypt',
        type: 'crypt',
        // Default filename/directory encryption (standard/true): the options
        // below are all the dialog would send.
        options: { remote: 'gtcryptsftp:crypt-base', password: 'gtcryptsecret' },
        nonSecretKeys: ['remote'],
        secretKeys: ['password'],
      },
    ],
    // The task runs over the CRYPT remote; its remote-side path is under
    // the wrapper (`gtcrypt:proof`), not the sftp base.
    taskRemote: 'gtcrypt',
    task: 'gtcloud-crypt',
    path: 'proof',
    // The DESTINATION listing through the crypt remote (decrypted names —
    // the underlying tree holds encrypted ones, checked below).
    listCmd: cryptEnvCmd('ls gtprobe:proof'),
    probes: {
      ok: [
        // The SAVED sftp remote: the stored (obscured) pass really works.
        { label: 'saved sftp remote', name: 'gtcryptsftp' },
        // The SAVED crypt remote: the stored obscured password decrypts.
        { label: 'saved crypt remote', name: 'gtcrypt' },
      ],
      // Finding 3: the root listing tolerates undecryptable names (rclone
      // logs them at Debug), so a wrong password still tests `ok`.
      wrong: [{ label: 'wrong crypt password (undecryptable names are Debug-level)', type: 'crypt', options: {
        remote: 'gtcryptsftp:crypt-base',
        password: 'gtwrongsecret',
      }, verdict: 'ok' }],
    },
    extraCopyChecks: async () => {
      // The underlying sftp tree: encrypted names only — none equal to a
      // source name — and every file LARGER than its source by rclone's
      // encryption envelope (16-byte header + per-block trailer).
      const stat = await sshExec(`cd ${CRYPT_BASE} && find . -type f -printf '%s %P\\n' 2>&1`)
      const rows = stat.split('\n').filter(Boolean)
      expect(rows.length, `crypt-base holds one file per copied source:\n${stat}`).toBe(12)
      for (const row of rows) {
        const [size, name] = row.split(' ', 2)
        expect(Number(size), `encrypted file ${name} larger than its 16-byte source`).toBeGreaterThan(16)
        expect(name, `encrypted name for ${name}`).not.toMatch(/^(f\d{2}|scratch)\.(txt|tmp)$/)
      }
      // Through the crypt remote, one file's bytes come back IDENTICAL
      // (base64 both sides — sshExec trims, so compare encodings).
      const cat = await sshExec(cryptEnvCmd('cat gtprobe:proof/f01.txt | base64'))
      const src = await sshExec('base64 < /var/tmp/anas-gtcloud-src/f01.txt')
      expect(cat.trim(), 'rclone cat through the crypt remote yields the original bytes').toBe(src.trim())
    },
    beforeRemoval: async (ctx) => {
      // Finding 4: the delete door checks TASK references only. Removing
      // the sftp remote while the crypt remote still names it answers 202 —
      // asserted as observed (the crypt remote is removed right after).
      const res = await ctx.delete(`${V1}/cloud/remotes/gtcryptsftp`)
      expect(res.status(), `DELETE gtcryptsftp while gtcrypt references it: ${await res.text()}`).toBe(202)
    },
    removalOrder: ['gtcrypt'],
  },
]

test.beforeAll(async () => {
  // up the three cloudproof.2 profiles — each up tears its own leftovers
  // down first. A failed up fails the suite here (the skip guard below must
  // never turn a missing fixture into green).
  await execFileAsync(FIXTURE_SH, ['up', 'azure', 'gcs', 'crypt'])
})

test.beforeEach(async () => {
  // The fixture's source directory is the "fixture present" signal.
  test.skip(
    !(await sshExec(`test -d /var/tmp/anas-gtcloud-src && echo yes`).then(() => true).catch(() => false)),
    `cloud backends fixture not present — run ${FIXTURE_SH} up`,
  )
})

test.describe.serial('cloud sync live proofs over emulated stores and an encrypted wrapper (cloudproof.2)', () => {
  test.setTimeout(300_000)

  test.afterAll(async ({ playwright }) => {
    // Teardown even on failure: this spec's OWN remotes/tasks through their
    // API doors (task first — the remote delete refuses while referenced;
    // the crypt remote before the sftp one it wraps), then the fixture
    // down, whose ✓/✗ lines VERIFY the teardown. Best-effort — must not
    // mask the run's results.
    const ctx = await apiCtx(playwright).catch(() => null)
    try {
      if (ctx) {
        await ctx.delete(`${V1}/cloud/tasks/gtcloud-azure`).catch(() => {})
        await ctx.delete(`${V1}/cloud/tasks/gtcloud-gcs`).catch(() => {})
        await ctx.delete(`${V1}/cloud/tasks/gtcloud-crypt`).catch(() => {})
        await expect
          .poll(async () => (await taskNames(ctx)).filter(n => n.startsWith('gtcloud-')).length, { timeout: 30_000 })
          .toBe(0)
        await ctx.delete(`${V1}/cloud/remotes/gtazure`).catch(() => {})
        await ctx.delete(`${V1}/cloud/remotes/gtgcs`).catch(() => {})
        await ctx.delete(`${V1}/cloud/remotes/gtcrypt`).catch(() => {})
        await ctx.delete(`${V1}/cloud/remotes/gtcryptsftp`).catch(() => {})
        await ctx.dispose()
      }
    }
    finally {
      const down = String(
        (await execFileAsync(FIXTURE_SH, ['down', 'azure', 'gcs', 'crypt']).then(r => r.stdout).catch(e => e.stdout ?? e.message ?? '')) ?? '',
      )
      // eslint-disable-next-line no-console -- the ✓/✗ lines ARE the verification
      console.log(down)
      expect(down.includes('✗'), `fixture down must verify clean:\n${down}`).toBe(false)
      expect((down.match(/✓/g) ?? []).length).toBeGreaterThanOrEqual(11)
    }
  })

  for (const b of BACKENDS) {
    test(`${b.key} — create, Test ok, copy run lands 12 files (verified through the backend), sync run deletes, wrong-credential verdict, remove-guard`, async ({ playwright }) => {
      await runCloudBackendProof(playwright, b)
    })
  }
})
