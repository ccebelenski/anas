import type { Server as TlsServer } from 'node:tls'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID, X509Certificate } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createServer as createTlsServer } from 'node:tls'
import { createServer } from '../../server.js'
import { fetchServerFingerprint } from '../../services/backup-runner.js'

/**
 * POST /backup/repos/test — the STORED-SECRET branch (issue #41).
 *
 * The secret is write-only, so the edit dialog sends none when the field was
 * left blank ('(unchanged)'). Test therefore has to fall back to the stored
 * secret for BOTH shapes the UI can send:
 *
 *   { name }                     — the grid's Test (repo untouched)
 *   { name, host, datastore, … } — the dialog's Test (fields possibly EDITED,
 *                                  secret absent because it was left blank)
 *
 * The second shape is the bug: it takes the inline branch, and before the fix
 * that branch passed `secret: null`, so a repo that saves and runs fine failed
 * its own Test. Asserting a status code would not have caught it — a failed
 * auth is still a 200 with a staged verdict — so these tests drive the probe all
 * the way to pbc and read the secret out of the environment it was handed.
 *
 * Reaching pbc means passing the daemon's own dns → tcp → tls-fingerprint gate,
 * so the test stands up a real TLS listener on localhost with the throwaway
 * self-signed certificate below and pins its fingerprint on the repo. The key is
 * generated for this file alone: it certifies localhost, is trusted by nothing,
 * and guards nothing.
 *
 * The host is the NAME `localhost`, not `127.0.0.1`: fetchServerFingerprint sets
 * `servername` unconditionally and Node rejects an IP there, so a repo addressed
 * by IP throws out of the probe today. That is a separate defect from the secret
 * this file guards — reported, not fixed here.
 */
const TEST_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg16uR+kckjfLrJ5qM',
  'gXqnJh3v7CxRlOCebvBBHo2gn4yhRANCAATTkKS5pHEplpPyjU0z5ufVvMh8MnyR',
  'xMdi4V7DIYngEVA434KbynXHWSYxijbcEoyPJCTOvX5BC3HvtNpdNs3E',
  '-----END PRIVATE KEY-----',
].join('\n')

const TEST_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBnDCCAUGgAwIBAgIUFJ9GjPbJUDCDXsAQgl4JOnhIKmwwCgYIKoZIzj0EAwIw',
  'FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgyNDE2NDIwMFoYDzIxMjYwNzMx',
  'MTY0MjAwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO',
  'PQMBBwNCAATTkKS5pHEplpPyjU0z5ufVvMh8MnyRxMdi4V7DIYngEVA434KbynXH',
  'WSYxijbcEoyPJCTOvX5BC3HvtNpdNs3Eo28wbTAdBgNVHQ4EFgQUsfT5s2G63zXi',
  'ZF7n9izQqIta5FowHwYDVR0jBBgwFoAUsfT5s2G63zXiZF7n9izQqIta5FowDwYD',
  'VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI',
  'zj0EAwIDSQAwRgIhANh24MN734bk4g2q12HirTjN4YPPCarc//6HH5vKhhstAiEA',
  'hhCXUeUFU9R4sg80t/kxQPSpaP2cXO+omXDIDXRSUJI=',
  '-----END CERTIFICATE-----',
].join('\n')

/** The pinned form: lowercase colon-hex, exactly what normalizeFingerprint makes. */
const CERT_FINGERPRINT = new X509Certificate(TEST_CERT).fingerprint256.toLowerCase()

const PBC = '/usr/bin/proxmox-backup-client'

/** The TLS listener binds every interface; the probe reaches it under this name. */
const TEST_HOST = 'localhost'

/** A tier-1 PVE-defined repo, so the fallback is proven on both tiers. */
const PVE_STORAGE_CFG = [
  'pbs: anastest-pw',
  '\tdatastore anastest-store',
  `\tserver ${TEST_HOST}`,
  '\tcontent backup',
  `\tfingerprint ${CERT_FINGERPRINT}`,
  '\tusername root@pam',
  '',
].join('\n')

const PVE_SECRET = 'AnasPbsTest123'
const STORED_SECRET = 'stored-token-secret'

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

interface Job { id: string, status: string }

describe('POST /backup/repos/test — stored-secret fallback (#41)', () => {
  let server: ReturnType<typeof createServer>
  let tls: TlsServer
  let port: number
  let dir: string
  const saved: Record<string, string | undefined> = {}
  /** The env of every pbc probe, in order — where the resolved secret shows up. */
  let probeEnvs: Record<string, string>[] = []

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  async function waitForJob(id: string): Promise<Job> {
    for (let i = 0; i < 100; i++) {
      const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
      const { job } = res.json() as { job: Job }
      if (job.status === 'completed' || job.status === 'failed')
        return job
      await new Promise(r => setTimeout(r, 10))
    }
    throw new Error(`Job ${id} did not finish`)
  }

  beforeEach(async () => {
    // A real TLS listener so the dns → tcp → tls-fingerprint gate passes and the
    // probe reaches pbc (the only place the resolved secret is observable).
    tls = createTlsServer({ key: TEST_KEY, cert: TEST_CERT })
    tls.on('tlsClientError', () => {}) // the probe hangs up after the handshake
    await new Promise<void>(resolve => tls.listen(0, resolve))
    port = (tls.address() as { port: number }).port

    dir = await mkdtemp(join(tmpdir(), 'anas-repotest-'))
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_STORAGE_CFG', join(dir, 'storage.cfg'))
    setEnv('ANAS_PVE_PRIV_STORAGE_DIR', join(dir, 'priv-storage'))
    await writeFile(join(dir, 'storage.cfg'), PVE_STORAGE_CFG)
    await mkdir(join(dir, 'priv-storage'), { recursive: true })
    await writeFile(join(dir, 'priv-storage', 'anastest-pw.pw'), `${PVE_SECRET}\n`)

    server = createServer({ mock: true, logger: false })
    const mock = (server as unknown as { executor: MockExecutor }).executor
    // `snapshot list` succeeds — the probe then reports 'ok' and we read the env.
    mock.addFixture({ command: PBC, result: { stdout: '[]', stderr: '', exitCode: 0 } })

    // The mock deliberately does not record env (secrets must never be matched
    // on), so the capture lives here, in the test, wrapping the instance method.
    probeEnvs = []
    const inner = mock.exec.bind(mock)
    mock.exec = async (command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      if (command === PBC)
        probeEnvs.push({ ...(opts?.env ?? {}) })
      return inner(command, args, opts)
    }

    const repo = {
      name: 'pbs-main',
      host: TEST_HOST,
      port,
      datastore: 'store1',
      authType: 'token' as const,
      tokenId: 'root@pam!anas',
      fingerprint: CERT_FINGERPRINT,
      secret: STORED_SECRET,
    }
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos', headers: JSON_HEADERS, payload: { repo, expectedVersion: 0 } })
    assert.equal(res.statusCode, 202)
    const { job } = res.json() as { job: Job }
    assert.equal((await waitForJob(job.id)).status, 'completed')
  })

  afterEach(async () => {
    await server.close()
    await new Promise<void>(resolve => tls.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else process.env[k] = v
    }
  })

  async function test(payload: Record<string, unknown>): Promise<{ stage: string, detail?: string }> {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos/test', headers: JSON_HEADERS, payload })
    assert.equal(res.statusCode, 200, res.body)
    return (res.json() as { data: { stage: string, detail?: string } }).data
  }

  /** The dialog's body for an unchanged repo: every field, secret omitted. */
  function dialogBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'pbs-main',
      host: TEST_HOST,
      port,
      datastore: 'store1',
      authType: 'token',
      tokenId: 'root@pam!anas',
      fingerprint: CERT_FINGERPRINT,
      ...overrides,
    }
  }

  it('name-only (the grid\'s Test) uses the stored secret', async () => {
    const data = await test({ name: 'pbs-main' })
    assert.equal(data.stage, 'ok')
    assert.equal(probeEnvs.length, 1)
    assert.equal(probeEnvs[0].PBS_PASSWORD, STORED_SECRET)
    assert.equal(probeEnvs[0].PBS_REPOSITORY, `root@pam!anas@${TEST_HOST}:${port}:store1`)
  })

  it('host + name with an ABSENT secret falls back to the stored one (the dialog\'s Test)', async () => {
    const data = await test(dialogBody())
    assert.equal(data.stage, 'ok')
    assert.equal(probeEnvs.length, 1)
    // The bug: this was null before the fix, so the dialog's Test failed auth on
    // a repo whose own grid Test passed.
    assert.equal(probeEnvs[0].PBS_PASSWORD, STORED_SECRET)
  })

  it('an EDITED field is what gets tested — with the stored secret', async () => {
    // The reason the fallback is keyed on the name rather than answering the
    // whole request from the registry: Test must exercise what would be SAVED.
    const data = await test(dialogBody({ datastore: 'store-edited', tokenId: 'root@pam!edited' }))
    assert.equal(data.stage, 'ok')
    assert.equal(probeEnvs[0].PBS_REPOSITORY, `root@pam!edited@${TEST_HOST}:${port}:store-edited`)
    assert.equal(probeEnvs[0].PBS_PASSWORD, STORED_SECRET)
  })

  it('a TYPED secret still wins over the stored one (rotation)', async () => {
    const data = await test(dialogBody({ secret: 'freshly-rotated' }))
    assert.equal(data.stage, 'ok')
    assert.equal(probeEnvs[0].PBS_PASSWORD, 'freshly-rotated')
  })

  it('a tier-1 pve:<id> repo falls back to its .pw secret too', async () => {
    const data = await test({
      name: 'pve:anastest-pw',
      host: TEST_HOST,
      port,
      datastore: 'anastest-store',
      authType: 'password',
      username: 'root@pam',
      fingerprint: CERT_FINGERPRINT,
    })
    assert.equal(data.stage, 'ok')
    assert.equal(probeEnvs[0].PBS_PASSWORD, PVE_SECRET)
  })

  it('an unregistered name with no secret stays honest (no secret invented)', async () => {
    const data = await test(dialogBody({ name: 'not-registered-yet' }))
    assert.equal(data.stage, 'ok') // pbc is mocked; the point is the env below
    assert.equal(probeEnvs[0].PBS_PASSWORD, '')
  })

  it('name-only for a repo that does not exist is still a 404', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/backup/repos/test', headers: JSON_HEADERS, payload: { name: 'nope' } })
    assert.equal(res.statusCode, 404)
  })
})

// #44: TLS ServerName must not be an IP — Node throws synchronously
// (ERR_INVALID_ARG_VALUE) and the rejection escaped fetchServerFingerprint,
// turning a repo test against `server <ip>` into a 500. The probe must treat
// an IP host like any other reachable server: connect without SNI and return
// the fingerprint.
describe('fetchServerFingerprint — IP-addressed server (#44)', () => {
  it('returns the fingerprint for an IP host instead of throwing on SNI', async () => {
    const tls = createTlsServer({ key: TEST_KEY, cert: TEST_CERT })
    tls.on('tlsClientError', () => {})
    await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve))
    const port = (tls.address() as { port: number }).port
    try {
      const fp = await fetchServerFingerprint('127.0.0.1', port, 2000)
      assert.equal(fp, CERT_FINGERPRINT)
    }
    finally {
      await new Promise<void>(resolve => tls.close(() => resolve()))
    }
  })
})
