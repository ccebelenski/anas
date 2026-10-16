import type { Job, JobAccepted } from '@anas/shared'
import type { Requester } from '../../cloud-task.js'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { main as cloudTaskMain } from '../../cloud-task.js'
import { listSections, parseRcloneConf } from '../../parsers/rclone-conf.js'
import { TASK_RUNNER_USER } from '../../runner-poll.js'
import { createServer } from '../../server.js'
import { RCLONE, rcloneBaseArgs } from '../../services/rclone-config.js'

/**
 * cr.55 (review 2026-10-16 M1 + W5) — the route-level LEAK PROBE: a saved
 * remote's stored credential, echoed by rclone in its own stderr, must not
 * leave the daemon through ANY cloud door. The probe is the review's shape
 * (`t/c/cloud-leak.test.ts`): a saved s3 remote whose `secret_access_key`
 * rclone quotes back, driven through the REAL routes over the fake executor —
 *
 *   - the remote Test (cr.48f already masked it — the control),
 *   - the task Preview (`errors[]` in the read job's result),
 *   - the direct RUN (`job.error`, the run detail's `recent` ring and its
 *     `lastError`, the notification body, and the line the cloud-task runner
 *     prints to the unit journal from that job record),
 *   - a completed run whose error lines echo it (`job.result.errorLines` and
 *     the runner's result-JSON journal line),
 *   - and a CRYPT remote wrapping the s3 one: the wrapped remote's credential
 *     and the crypt's own IsPassword values (`password`, and `password2`,
 *     which the key-name rule does not see) masked in every form.
 *
 * Nothing here feeds the mask a value: the only source is the rclone.conf the
 * daemon reads, exactly as on a node (W5 — "the fake is fed the oracle, not
 * the route").
 */

const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMD_ANALYZE = '/usr/bin/systemd-analyze'
const TIMEOUT = '/usr/bin/timeout'
const PERL = '/usr/bin/perl'

const S3_SECRET = 'Sup3rS3cretValue42'
/** REAL rclone v1.74.3 obscurings, KAT-pinned in rclone-config.test.ts. */
const CRYPT_PASSWORD_OBSCURED = 'Sp0SC2lTn1lEc3b6AhZl7HttaRoEDLZhQgk'
const CRYPT_PASSWORD_PLAIN = 'topsecret1'
const CRYPT_PASSWORD2_OBSCURED = '-UHN1nBu7Yj3jQ11eG7NixuTyxrbmw'
const CRYPT_PASSWORD2_PLAIN = 'gtpass'

/** Every value that must never appear in anything the daemon hands out. */
const ALL_SECRETS = [S3_SECRET, CRYPT_PASSWORD_OBSCURED, CRYPT_PASSWORD_PLAIN, CRYPT_PASSWORD2_OBSCURED, CRYPT_PASSWORD2_PLAIN]

const CONF = `[s3leak]
type = s3
provider = AWS
access_key_id = AKIAEXAMPLEKEYID0
secret_access_key = ${S3_SECRET}
region = eu-west-1

[cryptleak]
type = crypt
remote = s3leak:bucket/enc
password = ${CRYPT_PASSWORD_OBSCURED}
password2 = ${CRYPT_PASSWORD2_OBSCURED}
`

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }
/** The task runner's own identity (cr.56): the only one a `direct:true` run is taken from. */
const RUNNER_HEADERS = { ...JSON_HEADERS, 'x-anas-user': TASK_RUNNER_USER }

/** rclone's JSON log object for an error naming a file — what `--use-json-log` prints. */
function errorObject(msg: string, object = 'a.bin'): string {
  return JSON.stringify({ level: 'error', msg, object, objectType: '*s3.Object', source: 'operations/copy.go:229', time: '2026-10-16T10:00:00.000000+00:00' })
}

/** A stats object AFTER the error, so the run detail (published per tick) carries the ring. */
function statsObject(errors: number): string {
  return JSON.stringify({ level: 'info', msg: 'stats', stats: { bytes: 0, totalBytes: 1, transfers: 0, checks: 0, deletes: 0, errors, elapsedTime: 1, eta: null }, time: '2026-10-16T10:00:01.000000+00:00' })
}

/** The echo every door is fed: the plain s3 credential in rclone's own words. */
const S3_ECHO = `SignatureDoesNotMatch: bad credential ${S3_SECRET} for key AKIAEXAMPLEKEYID0`

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

async function waitForJob(server: ReturnType<typeof createServer>, id: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const res = await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: IDENTITY })
    const { job } = res.json() as { job: Job }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
      return job
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Job ${id} did not finish`)
}

/** Assert none of the secrets (any spelling in ALL_SECRETS) is in `text`. */
function assertNoSecret(text: string, where: string): void {
  for (const s of ALL_SECRETS)
    assert.ok(!text.includes(s), `${where} carries the credential ${s}: ${text}`)
}

describe('cr.55 — the cloud doors never hand out a saved remote\'s credential (route-level leak probe)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  let configFile: string
  let srcDir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string) {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr55-leak-'))
    const systemdDir = await mkdtemp(join(dir, 'systemd-'))
    configFile = join(dir, 'rclone.conf')
    await writeFile(configFile, CONF, { encoding: 'utf-8', mode: 0o600 })
    setEnv('ANAS_RCLONE_CONFIG', configFile)
    setEnv('ANAS_SYSTEMD_DIR', systemdDir)
    const fstab = join(dir, 'fstab')
    await writeFile(fstab, 'UUID=deadbeef / ext4 defaults 0 1\n', 'utf-8')
    setEnv('ANAS_FSTAB_PATH', fstab)
    srcDir = join(dir, 'src')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'a.bin'), 'x', 'utf-8')
    server = createServer({ mock: true, logger: false })

    const mock = mockOf(server)
    mock.clearFixtures()
    mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMD_ANALYZE, result: { stdout: 'Normalized form: Tue *-*-* 02:00:00\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: SYSTEMCTL, result: { stdout: '', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: PERL, result: { stdout: '', stderr: '', exitCode: 0 } })
    // `config dump` answers from the file the daemon holds, like the binary.
    const base = rcloneBaseArgs(configFile)
    mock.addFixture({
      command: RCLONE,
      args: [...base, 'config', 'dump'],
      result: {
        stdout: JSON.stringify(Object.fromEntries(listSections(parseRcloneConf(CONF)).map(s => [s.name, { ...s.values }]))),
        stderr: '',
        exitCode: 0,
      },
    })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else
        process.env[k] = v
    }
  })

  async function createTask(remote: string): Promise<void> {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/cloud/tasks',
      headers: JSON_HEADERS,
      payload: { name: 'offsite', source: srcDir, remote, path: 'pve1', schedule: 'Tue *-*-* 02:00:00', notify: 'always' },
    })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
  }

  /** Run the task DIRECT (the unit's own execution) and settle it. */
  async function directRun(): Promise<Job> {
    const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/offsite/run', headers: RUNNER_HEADERS, payload: { direct: true } })
    assert.equal(res.statusCode, 202, res.body)
    return waitForJob(server, (res.json() as JobAccepted).job.id)
  }

  /** The text the notification carried — `perl -e <script> <severity> <title> <message>`. */
  function notificationBodies(): string[] {
    return mockOf(server).calls.filter(c => c.command === PERL).map(c => c.args.slice(2).join('\n'))
  }

  /**
   * What the cloud-task runner prints to the unit journal for this job record
   * (stdout on completion, stderr on failure) — the runner fed the SETTLED job
   * the daemon handed it, exactly as it polls it on a node.
   */
  async function journalLines(job: Job): Promise<string> {
    const requester: Requester = async req => req.method === 'POST'
      ? { statusCode: 202, body: { job: { id: job.id, status: 'queued' } } }
      : { statusCode: 200, body: { job } }
    let printed = ''
    const out = process.stdout.write
    const err = process.stderr.write
    process.stdout.write = ((chunk: string) => {
      printed += chunk
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string) => {
      printed += chunk
      return true
    }) as typeof process.stderr.write
    try {
      await cloudTaskMain(['--name', 'offsite'], () => requester)
    }
    finally {
      process.stdout.write = out
      process.stderr.write = err
    }
    return printed
  }

  it('the remote Test (the control, cr.48f): the echoed credential reads [secret]', async () => {
    mockOf(server).addFixture({ command: TIMEOUT, result: { stdout: '', stderr: `2026/10/16 10:00:00 ERROR : ${S3_ECHO}\n`, exitCode: 1 } })
    const res = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: JSON_HEADERS, payload: { name: 's3leak' } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    const message = (job.result as { message: string }).message
    assert.ok(message.includes('[secret]'), message)
    assertNoSecret(JSON.stringify(job), 'the Test job')
  })

  it('the task Preview: rclone\'s error line quoting the credential reaches errors[] as [secret]', async () => {
    await createTask('s3leak')
    mockOf(server).addFixture({ command: TIMEOUT, result: { stdout: '', stderr: `${errorObject(S3_ECHO)}\n${statsObject(1)}\n`, exitCode: 1 } })
    const res = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/preview', headers: JSON_HEADERS, payload: { name: 'offsite' } })
    assert.equal(res.statusCode, 202, res.body)
    const job = await waitForJob(server, (res.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const errors = (job.result as { errors: string[] }).errors
    assert.ok(errors.some(e => e.includes('[secret]')), JSON.stringify(errors))
    assert.ok(errors.some(e => e.includes('SignatureDoesNotMatch')), 'the failure still reads as itself')
    assertNoSecret(JSON.stringify(job), 'the Preview job')
  })

  it('a FAILED run: job.error, the recent ring + lastError, the notification body and the runner\'s journal line carry [secret]', async () => {
    await createTask('s3leak')
    mockOf(server).addFixture({
      command: RCLONE,
      argsMatch: args => args[0] === 'copy',
      result: { stdout: '', stderr: `${errorObject(S3_ECHO)}\n${statsObject(1)}\n`, exitCode: 1 },
    })
    const job = await directRun()
    assert.equal(job.status, 'failed')
    assert.match(job.error?.message ?? '', /^rclone copy failed \(exit 1\): a\.bin: SignatureDoesNotMatch: bad credential \[secret\]/)
    const detail = job.detail as { recent: { message?: string }[], lastError?: string } | null
    assert.ok(detail, 'the direct run published its detail')
    assert.ok(detail!.recent.some(e => e.message?.includes('[secret]')), JSON.stringify(detail!.recent))
    assert.match(detail!.lastError ?? '', /\[secret\]/)
    assertNoSecret(JSON.stringify(job), 'the failed run job')

    const bodies = notificationBodies()
    assert.equal(bodies.length, 1, 'notify: always sent one notification')
    assert.ok(bodies[0]!.includes('[secret]'), bodies[0])
    assertNoSecret(bodies.join('\n'), 'the notification')

    const journal = await journalLines(job)
    assert.ok(journal.includes('[secret]'), journal)
    assertNoSecret(journal, 'the runner\'s journal line')
  })

  it('a COMPLETED run whose error lines echo it: job.result.errorLines and the runner\'s result line carry [secret]', async () => {
    await createTask('s3leak')
    mockOf(server).addFixture({
      command: RCLONE,
      argsMatch: args => args[0] === 'copy',
      // exit 0 with an error line (a retried object that then made it) — the
      // result path, not the failure path.
      result: { stdout: '', stderr: `${errorObject(S3_ECHO)}\n${statsObject(1)}\n`, exitCode: 0 },
    })
    const job = await directRun()
    assert.equal(job.status, 'completed', JSON.stringify(job.error))
    const lines = (job.result as { errorLines: string[] }).errorLines
    assert.ok(lines.some(l => l.includes('[secret]')), JSON.stringify(lines))
    assertNoSecret(JSON.stringify(job), 'the completed run job')
    assertNoSecret(notificationBodies().join('\n'), 'the notification')
    const journal = await journalLines(job)
    assert.ok(journal.includes('[secret]'), journal)
    assertNoSecret(journal, 'the runner\'s journal line')
  })

  it('a CRYPT remote wrapping the s3 one: the wrapped credential, password and password2 (stored and decoded) are all masked', async () => {
    await createTask('cryptleak')
    const echo = `${S3_ECHO}; crypt password ${CRYPT_PASSWORD_PLAIN} / ${CRYPT_PASSWORD_OBSCURED}; password2 ${CRYPT_PASSWORD2_PLAIN} / ${CRYPT_PASSWORD2_OBSCURED}`
    mockOf(server).addFixture({
      command: RCLONE,
      argsMatch: args => args[0] === 'copy',
      result: { stdout: '', stderr: `${errorObject(echo)}\n${statsObject(1)}\n`, exitCode: 1 },
    })
    mockOf(server).addFixture({ command: TIMEOUT, argsMatch: args => args.includes('--dry-run'), result: { stdout: '', stderr: `${errorObject(echo)}\n`, exitCode: 1 } })

    const previewRes = await server.inject({ method: 'POST', url: '/v1/cloud/tasks/preview', headers: JSON_HEADERS, payload: { name: 'offsite' } })
    const preview = await waitForJob(server, (previewRes.json() as JobAccepted).job.id)
    assert.equal(preview.status, 'completed', JSON.stringify(preview.error))
    assertNoSecret(JSON.stringify(preview), 'the crypt Preview job')

    const job = await directRun()
    assert.equal(job.status, 'failed')
    assertNoSecret(JSON.stringify(job), 'the crypt run job')
    assertNoSecret(notificationBodies().join('\n'), 'the crypt notification')
    assertNoSecret(await journalLines(job), 'the crypt runner\'s journal line')
    // The failure still names the cause — the mask removes values, not the line.
    assert.match(job.error?.message ?? '', /SignatureDoesNotMatch/)
  })
})
