import type { CloudProvider, CloudRemoteTestResult } from '@anas/shared'
import type { CommandExecutor, ExecOptions, ExecResult, ExecStreamResult, PipelineResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RCLONE, trimProviders } from '../rclone-config.js'
import {
  classifyProbe,
  CRYPT_NOTHING_STORED_MESSAGE,
  CRYPT_UNDECRYPTABLE_RE,
  cryptWrongPasswordMessage,
  PROBE_ENV_PREFIX,
  PROBE_REMOTE_NAME,
  PROBE_TIMEOUT_S,
  probeArgs,
  sweepStaleProbeDirs,
  testRemote,
} from '../rclone-probe.js'
import { SecretOnArgvError } from '../secret-argv.js'

// The REAL 1.60.1 provider capture (same fixture the rclone-config tests
// trim) — the probe's obscure decision rides on its IsPassword facts.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone/providers-1.60.1.json')
const providers: CloudProvider[] = trimProviders(JSON.parse(await readFile(FIXTURE, 'utf-8')))

// ── The verdict classifier, over the captured 1.60.1 messages ──────────────

/**
 * The failure lines rclone v1.60.1-DEV actually emitted on the stunt node
 * (GT 2026-09-23), verbatim — the classifier is table-tested on them, not on
 * paraphrases.
 */
const CAPTURED = {
  notFound: {
    exitCode: 3,
    stderr: '2026/09/23 22:25:03 ERROR : : error listing: directory not found\n'
      + '2026/09/23 22:25:03 Failed to lsjson with 2 errors: last error was: error in ListJSON: directory not found',
  },
  auth: {
    exitCode: 1,
    stderr: '2026/09/23 22:25:27 Failed to create file system for "anastest:": NewFs: couldn\'t connect SSH: '
      + 'ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain',
  },
  unreachable: {
    exitCode: 1,
    stderr: '2026/09/23 22:26:19 Failed to create file system for "anastest:": NewFs: couldn\'t connect SSH: '
      + 'dial tcp 192.0.2.1:22: i/o timeout',
  },
  unknownRemote: {
    exitCode: 1,
    stderr: '2026/09/23 22:26:39 Failed to create file system for "nosuchremote:": didn\'t find section in config file',
  },
}

describe('rclone-probe: classifyProbe over the captured messages (rclone.1)', () => {
  it('exit 0 → ok; the payload (stdout) is not read as a message', () => {
    assert.deepEqual(classifyProbe(0, ''), { verdict: 'ok', message: '' })
    assert.deepEqual(classifyProbe(0, 'whatever'), { verdict: 'ok', message: '' })
  })

  it('exit 124 (the timeout wrapper fired) → unreachable; a line rclone logged BEFORE the hang is carried, not discarded', () => {
    assert.deepEqual(classifyProbe(124, ''), { verdict: 'unreachable', message: '' })
    const line = '2026/09/24 00:00:00 NOTICE : anastest: dialing 192.0.2.1 — the connect then stalls'
    const r = classifyProbe(124, `${line}\n`)
    assert.equal(r.verdict, 'unreachable')
    assert.equal(r.message, line)
  })

  it('the captured not-found (exit 3) → not-found with rclone\'s last line', () => {
    const r = classifyProbe(CAPTURED.notFound.exitCode, CAPTURED.notFound.stderr)
    assert.equal(r.verdict, 'not-found')
    assert.equal(r.message, '2026/09/23 22:25:03 Failed to lsjson with 2 errors: last error was: error in ListJSON: directory not found')
  })

  it('`directory not found` decides on the MESSAGE when the exit is not 3', () => {
    const r = classifyProbe(1, 'Failed to lsjson with 1 errors: last error was: error in ListJSON: directory not found')
    assert.equal(r.verdict, 'not-found')
  })

  it('the captured auth line (exit 1) → auth', () => {
    assert.equal(classifyProbe(CAPTURED.auth.exitCode, CAPTURED.auth.stderr).verdict, 'auth')
  })

  it('the captured unreachable line (exit 1) → unreachable', () => {
    assert.equal(classifyProbe(CAPTURED.unreachable.exitCode, CAPTURED.unreachable.stderr).verdict, 'unreachable')
  })

  it('every unreachable pattern, exit 1', () => {
    for (const line of [
      'dial tcp 10.0.0.9:22: i/o timeout',
      'dial tcp 10.0.0.9:22: connection refused',
      'lookup drive.google.com: no such host',
      'dial tcp 10.0.0.9:443: no route to host',
      'dial tcp 10.0.0.9:443: network is unreachable',
    ]) {
      assert.equal(classifyProbe(1, line).verdict, 'unreachable', line)
    }
  })

  it('every auth pattern, exit 1', () => {
    for (const line of [
      'ssh: unable to authenticate, attempted methods [none password]',
      'ssh: handshake failed: ...',
      'HTTP 401 Unauthorized from the endpoint',
      'request failed with Status: 403 Forbidden',
      'AccessDenied: bucket not accessible',
      'InvalidAccessKeyId: The AWS Access Key Id you provided does not exist',
      'SignatureDoesNotMatch: the signature did not match',
      'permission denied (publickey,password)',
      '401 Unauthorized',
    ]) {
      assert.equal(classifyProbe(1, line).verdict, 'auth', line)
    }
  })

  it('the captured unknown-remote line → RemoteNotFoundError naming the remote', () => {
    assert.throws(
      () => classifyProbe(CAPTURED.unknownRemote.exitCode, CAPTURED.unknownRemote.stderr),
      (err: unknown) => {
        assert.ok(err instanceof Error && err.name === 'RemoteNotFoundError')
        assert.match(err.message, /nosuchremote/)
        return true
      },
    )
  })

  it('an unrecognised failure → error with the LAST non-empty line, never the whole output', () => {
    const r = classifyProbe(1, 'line one\n\n2026/09/23 22:00:00 Failed: something the classifier does not know\n')
    assert.deepEqual(r, {
      verdict: 'error',
      message: '2026/09/23 22:00:00 Failed: something the classifier does not know',
    })
    assert.ok(!r.message.includes('line one'), 'the message is ONE line, not a dump')
  })

  it('bucket order: an unreachable line that also carries an auth token is unreachable (the network died first)', () => {
    const r = classifyProbe(1, 'dial tcp 10.0.0.9:443: i/o timeout (401 expected)')
    assert.equal(r.verdict, 'unreachable')
  })
})

// ── The cloudproof.1 captures: SMB and FTP credential failures ──────────────

/**
 * The two wrong-credential probe captures the cloudproof.1 live proof brought
 * home (GT 2026-09-27, fixtures `probe-*-auth-fail-1.60.1.log`) — both were
 * classified `error` until 0.4.1 widened AUTH_RE with their arms. The tests
 * run over the FIXTURE FILES, so the classifier is pinned to what the node
 * actually said, byte for byte.
 */
const PROBE_CAPTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone')
const SMB_AUTH_FAIL = await readFile(join(PROBE_CAPTURE_DIR, 'probe-smb-auth-fail-1.60.1.log'), 'utf-8')
const FTP_AUTH_FAIL = await readFile(join(PROBE_CAPTURE_DIR, 'probe-ftp-auth-fail-1.60.1.log'), 'utf-8')

// ── The cloudproof.2 captures: the wrong crypt password (0.4.1) ────────────

/**
 * The wrong-CRYPT-password probe captures the cloudproof.2 live proof brought
 * home (GT 2026-09-27, fixtures `probe-crypt-*-debug-1.60.1.*`): the probe's
 * exact argv with `-vv` against an env-defined crypt remote over the node's
 * own sshd. Three states, all exit **0** — a wrong password SUCCEEDS the
 * listing (rclone skips undecryptable names at DEBUG), so the verdict is
 * corrected over the debug lines, never over the listing's emptiness:
 *
 *   empty  nothing stored yet → `[]`, no debug line → ok (with the caveat)
 *   good   correct password   → the names decrypted, no debug line → plain ok
 *   wrong  wrong password     → `[]` AND two `Skipping undecryptable` lines
 *          → auth with the fixed sentence (the listing is empty TOO — the
 *          lines, not the emptiness, are the discriminator)
 */
const WRONG_STDERR = await readFile(join(PROBE_CAPTURE_DIR, 'probe-crypt-wrong-debug-1.60.1.log'), 'utf-8')
const WRONG_STDOUT = await readFile(join(PROBE_CAPTURE_DIR, 'probe-crypt-wrong-debug-1.60.1.stdout'), 'utf-8')
const GOOD_STDERR = await readFile(join(PROBE_CAPTURE_DIR, 'probe-crypt-good-debug-1.60.1.log'), 'utf-8')
const GOOD_STDOUT = await readFile(join(PROBE_CAPTURE_DIR, 'probe-crypt-good-debug-1.60.1.stdout'), 'utf-8')
const EMPTY_STDERR = await readFile(join(PROBE_CAPTURE_DIR, 'probe-crypt-empty-debug-1.60.1.log'), 'utf-8')
const EMPTY_STDOUT = await readFile(join(PROBE_CAPTURE_DIR, 'probe-crypt-empty-debug-1.60.1.stdout'), 'utf-8')

describe('rclone-probe: classifyProbe over the cloudproof.1 captures (0.4.1)', () => {
  it('the captured SMB wrong-credential probe (exit 1) → auth with Samba\'s own sentence', () => {
    const r = classifyProbe(1, SMB_AUTH_FAIL)
    assert.equal(r.verdict, 'auth')
    assert.match(r.message, /The attempted logon is invalid\. This is either due to a bad username or authentication information\./)
    assert.ok(!r.message.includes('\n'), 'the message is rclone\'s LAST line, not a dump')
  })

  it('the captured FTP wrong-credential probe (exit 1) → auth with the server\'s 530', () => {
    const r = classifyProbe(1, FTP_AUTH_FAIL)
    assert.equal(r.verdict, 'auth')
    assert.match(r.message, /530 Authentication failed\./)
  })

  it('the SMB and FTP auth patterns on their own (exit 1)', () => {
    for (const line of [
      // The captured Samba sentence, bare.
      'couldn\'t connect SMB: response error: The attempted logon is invalid. This is either due to a bad username or authentication information.',
      // What a Windows SMB server answers instead (rclone surfaces the NT status).
      'NewFs: couldn\'t connect SMB: NT_STATUS_LOGON_FAILURE',
      // The other FTP servers' 530 (vsftpd/proftpd).
      'NewFs: failed to make FTP connection to "10.0.0.9:21": 530 Login incorrect.',
    ]) {
      assert.equal(classifyProbe(1, line).verdict, 'auth', line)
    }
  })

  it('an SMB failure the server did NOT call a credential problem still falls to `error`', () => {
    const r = classifyProbe(1, 'Failed to lsjson with 2 errors: last error was: error in ListJSON: couldn\'t connect SMB: response error: Network Name Not Found.')
    assert.equal(r.verdict, 'error')
  })
})

// ── testRemote: the argv, the env-defined remote, the guard ────────────────

/** A canned `timeout … rclone …` answer for one fs argument. */
function lsjsonResult(fs: string, result: ExecResult): { exec: (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>, calls: { command: string, args: string[], opts?: ExecOptions }[] } {
  const calls: { command: string, args: string[], opts?: ExecOptions }[] = []
  const exec = async (command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args, opts })
    if (command === RCLONE)
      return { stdout: 'obscured-by-mock\n', stderr: '', exitCode: 0 } // the obscure call
    const fsArg = args[6] // [45, rclone, --config, file, --ask-password=false, lsjson, fs, …]
    if (fsArg === fs)
      return result
    throw new Error(`unexpected lsjson target: ${fsArg}`)
  }
  return { exec, calls }
}

/** The full executor stub (only exec is exercised by the probe). */
function stubExecutor(exec: (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>): CommandExecutor {
  return {
    exec,
    pipeline: async (): Promise<PipelineResult> => {
      throw new Error('pipeline not exercised by the probe')
    },
    execToStream: async (): Promise<ExecStreamResult> => {
      throw new Error('execToStream not exercised by the probe')
    },
  }
}

const PATHS = { configFile: '/etc/anas/rclone.conf' }

/**
 * The base directory an UNSAVED probe makes its private config copy under —
 * injected so the suite never depends on `/run/anas` existing on the host
 * running the tests (the production default falls back to the system temp
 * directory when it does not).
 */
const TMP_BASE = await mkdtemp(join(tmpdir(), 'anas-probe-base-'))
after(async () => {
  await rm(TMP_BASE, { recursive: true, force: true })
})

/** The `--config` path the probe handed the executor (argv slot 3). */
function probeConfigOf(args: string[]): string {
  assert.equal(args[2], '--config', 'the probe argv still carries --config in slot 2')
  return args[3]!
}

describe('rclone-probe: testRemote (rclone.1)', () => {
  it('a SAVED target: the exact timeout-wrapped argv, no env', async () => {
    const { exec, calls } = lsjsonResult('gt:dst', { stdout: '[]', stderr: '', exitCode: 0 })
    const executor = stubExecutor(exec)
    const result = await testRemote(executor, PATHS, { name: 'gt' }, { path: 'dst' })
    assert.deepEqual(result, { verdict: 'ok', message: '' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, '/usr/bin/timeout')
    assert.deepEqual(calls[0]!.args, probeArgs(PATHS.configFile, 'gt:dst'))
    // No env (the file holds the values) — and no onSpawn unless a job's cancel seam passed one.
    assert.deepEqual(calls[0]!.opts, {})
    // A saved remote is probed against ANAS's OWN store: the three sftp
    // detection keys rclone appends land in that remote's own section, which
    // the INI writer keeps and the API lists (GT fact 1).
    assert.equal(probeConfigOf(calls[0]!.args), PATHS.configFile)
  })

  it('the argv is the design\'s: timeout PROBE_TIMEOUT_S (cr.48: 120), base args, lsjson, the bounded flags', () => {
    assert.deepEqual(probeArgs('/etc/anas/rclone.conf', 'gt:'), [
      String(PROBE_TIMEOUT_S),
      RCLONE,
      '--config',
      '/etc/anas/rclone.conf',
      '--ask-password=false',
      'lsjson',
      'gt:',
      '--max-depth',
      '1',
      '--contimeout',
      '10s',
      '--timeout',
      '9s',
      '--retries',
      '1',
      '--low-level-retries',
      '1',
    ])
    assert.equal(probeArgs(PATHS.configFile, 'gt:')[0], String(PROBE_TIMEOUT_S))
  })

  it('an UNSAVED target: the env carries TYPE + every option upper-cased; the password-typed value is OBSCURED, the rest plain', async () => {
    const { exec, calls } = lsjsonResult(`${PROBE_REMOTE_NAME}:dst`, { stdout: '[]', stderr: '', exitCode: 0 })
    const executor = stubExecutor(exec)
    const result = await testRemote(executor, PATHS, {
      remote: { name: 'draft', type: 'sftp', options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' } },
    }, { path: 'dst', providers, tmpBase: TMP_BASE })
    assert.deepEqual(result, { verdict: 'ok', message: '' })

    // Two calls: the obscure (stdin — the value never on argv) and the lsjson.
    assert.equal(calls.length, 2)
    const obscure = calls[0]!
    assert.equal(obscure.command, RCLONE)
    assert.equal(obscure.opts?.stdin, 'gtpass')
    for (const a of obscure.args)
      assert.ok(!a.includes('gtpass'), `the plain password rode an argv token: ${a}`)

    const ls = calls[1]!
    const env = ls.opts?.env
    assert.ok(env, 'the unsaved remote rides the child environment')
    assert.equal(env![`${PROBE_ENV_PREFIX}TYPE`], 'sftp')
    assert.equal(env![`${PROBE_ENV_PREFIX}HOST`], '127.0.0.1')
    assert.equal(env![`${PROBE_ENV_PREFIX}USER`], 'rclonegt')
    assert.equal(env![`${PROBE_ENV_PREFIX}PASS`], 'obscured-by-mock') // NOT 'gtpass'
    assert.ok(!JSON.stringify(ls.args).includes('gtpass'), 'the plain password is not on argv')
  })

  it('an UNSAVED target runs against a PRIVATE copy, never ANAS\'s own file, and the copy is gone afterwards', async () => {
    // A real store with a section the probe must not disturb: rclone would
    // persist its sftp detection as a NEW [anastest] section in whatever
    // --config it is handed (GT fact 1), so it is handed a copy (GT fact 2).
    const storeDir = await mkdtemp(join(TMP_BASE, 'store-'))
    const configFile = join(storeDir, 'rclone.conf')
    const storeText = '[gt]\ntype = sftp\nhost = 127.0.0.1\n'
    await writeFile(configFile, storeText, 'utf-8')

    const { exec, calls } = lsjsonResult(`${PROBE_REMOTE_NAME}:`, { stdout: '[]', stderr: '', exitCode: 0 })
    await testRemote(stubExecutor(exec), { configFile }, {
      remote: { name: 'draft', type: 'sftp', options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' } },
    }, { providers, tmpBase: TMP_BASE })

    const ls = calls.find(c => c.command === '/usr/bin/timeout')!
    const probeConfig = probeConfigOf(ls.args)
    assert.notEqual(probeConfig, configFile, 'the unsaved probe never points rclone at ANAS\'s own file')
    assert.deepEqual(ls.args, probeArgs(probeConfig, `${PROBE_REMOTE_NAME}:`))
    assert.equal(existsSync(dirname(probeConfig)), false, 'the private temp directory is removed with the probe')
    assert.equal(await readFile(configFile, 'utf-8'), storeText, 'ANAS\'s own store is byte-identical after the probe')
  })

  it('the private copy is removed even when the probe THROWS', async () => {
    const storeDir = await mkdtemp(join(TMP_BASE, 'store-throw-'))
    const configFile = join(storeDir, 'rclone.conf')
    await writeFile(configFile, '[gt]\ntype = sftp\n', 'utf-8')

    let probeConfig: string | undefined
    const exec = async (command: string, args: string[]): Promise<ExecResult> => {
      if (command === RCLONE)
        return { stdout: 'obscured-by-mock\n', stderr: '', exitCode: 0 }
      probeConfig = probeConfigOf(args)
      throw new Error('the executor blew up mid-probe')
    }
    await assert.rejects(
      testRemote(stubExecutor(exec), { configFile }, {
        remote: { name: 'draft', type: 'sftp', options: { host: 'h', user: 'u', pass: 'gtpass' } },
      }, { providers, tmpBase: TMP_BASE }),
      /blew up mid-probe/,
    )
    assert.ok(probeConfig, 'the probe reached the executor')
    assert.equal(existsSync(dirname(probeConfig!)), false, 'the private temp directory is removed on the failure path too')
  })

  it('an UNSAVED target with NO store on the node still probes (rclone starts from nothing)', async () => {
    const storeDir = await mkdtemp(join(TMP_BASE, 'store-absent-'))
    const configFile = join(storeDir, 'rclone.conf') // never created
    const { exec, calls } = lsjsonResult(`${PROBE_REMOTE_NAME}:`, { stdout: '[]', stderr: '', exitCode: 0 })
    const r = await testRemote(stubExecutor(exec), { configFile }, {
      remote: { name: 'draft', type: 'sftp', options: { host: 'h', user: 'u', pass: 'gtpass' } },
    }, { providers, tmpBase: TMP_BASE })
    assert.deepEqual(r, { verdict: 'ok', message: '' })
    const ls = calls.find(c => c.command === '/usr/bin/timeout')!
    assert.notEqual(probeConfigOf(ls.args), configFile)
    assert.equal(existsSync(configFile), false, 'no store was conjured into being by a Test')
  })

  it('a name-rule secret (s3 secret_access_key) stays PLAIN in the env (rclone would not reveal an obscured value there)', async () => {
    const { exec, calls } = lsjsonResult(`${PROBE_REMOTE_NAME}:`, { stdout: '[]', stderr: '', exitCode: 0 })
    const executor = stubExecutor(exec)
    await testRemote(executor, PATHS, {
      remote: { name: 'draft', type: 's3', options: { access_key_id: 'AKIAEXAMPLE', secret_access_key: 'plainsecretvalue' } },
    }, { providers, tmpBase: TMP_BASE })
    // One call (the lsjson): s3 has no IsPassword option (passwordKeysFor is
    // empty), so nothing is obscured — the value rides the env plain, exactly
    // as it would ride the file plain.
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, '/usr/bin/timeout')
    assert.equal(calls[0]!.opts?.env![`${PROBE_ENV_PREFIX}SECRET_ACCESS_KEY`], 'plainsecretvalue')
  })

  it('an unsaved target without the catalogue throws (it cannot know which values are password-typed)', async () => {
    const { exec } = lsjsonResult('x:', { stdout: '', stderr: '', exitCode: 0 })
    await assert.rejects(
      testRemote(stubExecutor(exec), PATHS, { remote: { name: 'd', type: 'sftp', options: {} } }),
      /provider catalogue/,
    )
  })

  it('exactly one of name/remote', async () => {
    const { exec } = lsjsonResult('x:', { stdout: '', stderr: '', exitCode: 0 })
    const executor = stubExecutor(exec)
    await assert.rejects(testRemote(executor, PATHS, {}), /exactly one of name or remote/)
    await assert.rejects(
      testRemote(executor, PATHS, { name: 'a', remote: { name: 'b', type: 'sftp', options: {} } }),
      /exactly one of name or remote/,
    )
  })

  it('the argv guard skips the whole STATIC prefix (timeout + rclone + --config base + lsjson), so a secret value that legally matches it does not refuse the probe', async () => {
    // A temp base whose PATH carries `false`: with a short skip count the
    // checked tail held `--config <that path>` and `--ask-password=false`,
    // and an s3 dialog whose secret_access_key is `false` was refused
    // although nothing secret rides argv.
    const falseBase = await mkdtemp(join(TMP_BASE, 'false-'))
    const { exec, calls } = lsjsonResult(`${PROBE_REMOTE_NAME}:`, { stdout: '[]', stderr: '', exitCode: 0 })
    const r = await testRemote(stubExecutor(exec), PATHS, {
      remote: { name: 'draft', type: 's3', options: { access_key_id: 'AKIAEXAMPLE', secret_access_key: 'false' } },
    }, { providers, tmpBase: falseBase })
    assert.deepEqual(r, { verdict: 'ok', message: '' })
    assert.equal(calls.length, 1)

    // The guard still bites on the DYNAMIC tail it is meant to check — a
    // plain secret smuggled into the fs string is refused (the dedicated
    // guard test below pins the same fact).
    await assert.rejects(
      testRemote(
        stubExecutor(exec),
        PATHS,
        { remote: { name: 'draft', type: 'sftp', options: { host: 'h', user: 'u', pass: 'gtpass' } } },
        { path: 'a-folder/named/gtpass', providers, tmpBase: falseBase },
      ),
      SecretOnArgvError,
    )
  })

  it('the argv guard: a typed path carrying a plain secret value is refused, naming nothing', async () => {
    const { exec } = lsjsonResult('x:', { stdout: '', stderr: '', exitCode: 0 })
    await assert.rejects(
      testRemote(
        stubExecutor(exec),
        PATHS,
        { remote: { name: 'd', type: 'sftp', options: { host: 'h', user: 'u', pass: 'gtpass' } } },
        { path: 'a-folder/named/gtpass', providers, tmpBase: TMP_BASE },
      ),
      (err: unknown) => {
        assert.ok(err instanceof SecretOnArgvError)
        assert.ok(!String(err.message).includes('gtpass'), 'the refusal must not echo the secret')
        return true
      },
    )
  })

  it('a SAVED target does not obscure anything (the file holds the values) — no obscure call', async () => {
    const { exec, calls } = lsjsonResult('gt:', { stdout: '[]', stderr: '', exitCode: 0 })
    await testRemote(stubExecutor(exec), PATHS, { name: 'gt' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, '/usr/bin/timeout')
  })

  it('verdict passthrough: the classifier\'s buckets ride the probe result (timeout → unreachable)', async () => {
    const { exec } = lsjsonResult('gt:', { stdout: '', stderr: '', exitCode: 124 })
    const r = await testRemote(stubExecutor(exec), PATHS, { name: 'gt' })
    assert.deepEqual(r, { verdict: 'unreachable', message: '' })
  })

  it('cr.48b: a stderr line echoing a secret value the dialog handed over is masked in the message, the verdict unchanged', async () => {
    // The bad credential's 401 line echoes the pass value verbatim — the exact
    // leak the review proved. The verdict is still `auth` (the classifier read
    // the RAW text); only the message that leaves carries `[secret]`.
    const echo = 'Failed to create file system for "anastest:": NewFs: couldn\'t connect SSH: 401 Unauthorized (token gtpass)'
    const { exec } = lsjsonResult(`${PROBE_REMOTE_NAME}:`, { stdout: '', stderr: `${echo}\n`, exitCode: 1 })
    const r = await testRemote(stubExecutor(exec), PATHS, {
      remote: { name: 'draft', type: 'sftp', options: { host: '127.0.0.1', user: 'rclonegt', pass: 'gtpass' } },
    }, { providers, tmpBase: TMP_BASE })
    assert.equal(r.verdict, 'auth')
    assert.ok(r.message.includes('[secret]'), r.message)
    assert.ok(!r.message.includes('gtpass'), r.message)
  })

  it('cr.48b: a URL-echoed secret (its encodeURIComponent form) is masked too', async () => {
    const echo = 'Failed to access https://user:gt%20secret@example.com/x: 401 Unauthorized'
    const { exec } = lsjsonResult(`${PROBE_REMOTE_NAME}:`, { stdout: '', stderr: `${echo}\n`, exitCode: 1 })
    const r = await testRemote(stubExecutor(exec), PATHS, {
      remote: { name: 'draft', type: 'sftp', options: { host: 'h', user: 'u', pass: 'gt secret' } },
    }, { providers, tmpBase: TMP_BASE })
    assert.equal(r.verdict, 'auth')
    assert.ok(r.message.includes('[secret]'), r.message)
    assert.ok(!r.message.includes('gt%20secret'), r.message)
    assert.ok(!r.message.includes('gt secret'), r.message)
  })
})

// ── sweepStaleProbeDirs: what a killed daemon left behind ──────────────────

describe('rclone-probe: sweepStaleProbeDirs (rclone.1)', () => {
  it('removes the probe-prefixed DIRECTORIES (any age, contents and all), leaves everything else', async () => {
    const base = await mkdtemp(join(tmpdir(), 'anas-sweep-base-'))
    const stale = join(base, 'anas-rclone-probe-oldcrash')
    await mkdir(join(stale, 'deep'), { recursive: true })
    // The survivor's payload: a full copy of the store.
    await writeFile(join(stale, 'deep', 'rclone.conf'), '[gt]\ntype = sftp\n', 'utf-8')
    await mkdir(join(base, 'anas-rclone-probe-second'), { recursive: true })
    await mkdir(join(base, 'unrelated-dir'), { recursive: true })
    await writeFile(join(base, 'anas-rclone-probe-not-a-dir'), 'x', 'utf-8') // a FILE with the prefix
    await writeFile(join(base, 'keep.txt'), 'x', 'utf-8')

    const swept = await sweepStaleProbeDirs(base)
    assert.deepEqual(swept.sort(), ['anas-rclone-probe-oldcrash', 'anas-rclone-probe-second'])
    assert.equal(existsSync(stale), false, 'the stale copy is gone')
    assert.equal(existsSync(join(base, 'anas-rclone-probe-second')), false)
    assert.equal(existsSync(join(base, 'unrelated-dir')), true, 'a foreign directory is not swept')
    assert.equal(existsSync(join(base, 'anas-rclone-probe-not-a-dir')), true, 'a file with the prefix is not a probe dir')
    assert.equal(existsSync(join(base, 'keep.txt')), true)
    await rm(base, { recursive: true, force: true })
  })

  it('a missing base directory is not an error — nothing stale can live in a directory that does not exist', async () => {
    assert.deepEqual(await sweepStaleProbeDirs(join(tmpdir(), 'anas-sweep-missing-zz')), [])
  })
})

describe('rclone-probe: the crypt captures (cloudproof.2, 0.4.1)', () => {
  let dir: string
  let configFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(TMP_BASE, 'crypt-store-'))
    configFile = join(dir, 'rclone.conf')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A SAVED crypt remote's section, and a stub answering one canned probe. */
  async function cryptProbe(result: ExecResult, section = '[gtcrypt]\ntype = crypt\nremote = gtsftp:crypt-base\n'): Promise<{ calls: { command: string, args: string[], opts?: ExecOptions }[], probe: Promise<CloudRemoteTestResult> }> {
    await writeFile(configFile, section, 'utf-8')
    const calls: { command: string, args: string[], opts?: ExecOptions }[] = []
    const exec = async (command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      calls.push({ command, args, opts })
      if (command === '/usr/bin/timeout')
        return result
      throw new Error(`unexpected call: ${command} ${args.join(' ')}`)
    }
    return { calls, probe: testRemote(stubExecutor(exec), { configFile }, { name: 'gtcrypt' }) }
  }

  it('the captured WRONG password (exit 0, empty listing, debug lines) → auth with the fixed sentence, exactly', async () => {
    const { calls, probe } = await cryptProbe({ stdout: WRONG_STDOUT, stderr: WRONG_STDERR, exitCode: 0 })
    assert.deepEqual(await probe, { verdict: 'auth', message: cryptWrongPasswordMessage('gtcrypt:') })
    // The probe ran with debug logging — the exact argv the capture ran.
    assert.deepEqual(calls[0]!.args, probeArgs(configFile, 'gtcrypt:', { debug: true }))
    assert.equal(calls[0]!.args.at(-1), '-vv')
  })

  it('the captured CORRECT password (exit 0, names decrypted) → plain ok, no caveat', async () => {
    const { probe } = await cryptProbe({ stdout: GOOD_STDOUT, stderr: GOOD_STDERR, exitCode: 0 })
    assert.deepEqual(await probe, { verdict: 'ok', message: '' })
  })

  it('the captured EMPTY base (exit 0, `[]`, no debug line) → ok carrying the nothing-stored sentence', async () => {
    const { probe } = await cryptProbe({ stdout: EMPTY_STDOUT, stderr: EMPTY_STDERR, exitCode: 0 })
    assert.deepEqual(await probe, { verdict: 'ok', message: CRYPT_NOTHING_STORED_MESSAGE })
  })

  it('the auth sentence names NOTHING from the capture — no debug text, no obscured password', async () => {
    const { probe } = await cryptProbe({ stdout: WRONG_STDOUT, stderr: WRONG_STDERR, exitCode: 0 })
    const { message } = await probe
    for (const leak of ['PKCS', '8rtb1ufkgr2fl5ctns6naatgfg', '9VIsr1kjQIg84TxBoSV', 'DEBUG', 'Skipping']) {
      assert.ok(!message.includes(leak), `the sentence must not carry '${leak}' from the capture`)
    }
  })

  it('an UNSAVED crypt dialog: the same verdict, the sentence naming the dialog\'s draft name', async () => {
    const { exec, calls } = lsjsonResult(`${PROBE_REMOTE_NAME}:`, { stdout: WRONG_STDOUT, stderr: WRONG_STDERR, exitCode: 0 })
    const r = await testRemote(stubExecutor(exec), PATHS, {
      remote: { name: 'gtdraft', type: 'crypt', options: { remote: 'gtsftp:crypt-base', password: 'gtwrongsecret' } },
    }, { providers, tmpBase: TMP_BASE })
    assert.deepEqual(r, { verdict: 'auth', message: cryptWrongPasswordMessage('gtdraft:') })
    const ls = calls.find(c => c.command === '/usr/bin/timeout')!
    assert.equal(ls.args.at(-1), '-vv', 'the unsaved crypt dialog is probed with debug logging too')
  })

  it('a NON-crypt remote is never probed with -vv and never corrected', async () => {
    const { exec, calls } = lsjsonResult('gtsftp:', { stdout: GOOD_STDOUT, stderr: GOOD_STDERR, exitCode: 0 })
    const r = await testRemote(stubExecutor(exec), { configFile }, { name: 'gtsftp' })
    assert.deepEqual(r, { verdict: 'ok', message: '' })
    assert.notEqual(calls[0]!.args.at(-1), '-vv', 'debug logging rides crypt remotes only')
  })

  it('the debug lines decide ONLY on a succeeded listing — the usual buckets stand on a failure', () => {
    // exit 124 (the timeout wrapper fired) with a debug line in the stream.
    const r = classifyProbe(124, `${WRONG_STDERR}\n`)
    assert.equal(r.verdict, 'unreachable')
    // exit 1 with the captured unreachable line: the undecryptable text alone
    // never turns a failure into auth.
    assert.equal(classifyProbe(1, `${CAPTURED.unreachable.stderr}\n${WRONG_STDERR}`).verdict, 'unreachable')
  })

  it('the captured debug lines match the regex; the good and empty captures do not', () => {
    assert.ok(CRYPT_UNDECRYPTABLE_RE.test(WRONG_STDERR), 'the wrong-password capture carries the lines')
    assert.ok(!CRYPT_UNDECRYPTABLE_RE.test(GOOD_STDERR), 'the correct-password capture does not')
    assert.ok(!CRYPT_UNDECRYPTABLE_RE.test(EMPTY_STDERR), 'the empty-base capture does not')
  })
})

// ── cr.48f rule 3: a SAVED remote's own credentials seed the probe's mask ──
//
// The cr.48b blind spot: the saved branch ran the mask empty because its
// credentials live in rclone.conf and were never loaded. The daemon CAN
// recover the plain values cheaply, IN PROCESS — name-rule secrets are stored
// plain, and an IsPassword value is `rclone obscure`'d, the plain text
// recovered through `revealObscured` (rclone's own `Reveal` reimplemented
// beside the write path, KAT-pinned in rclone-config.test.ts; `rclone reveal
// <value>` — which takes its input ONLY as an argument — is the OPERATOR's
// door, module-header GT fact 3, never a door this daemon opens) — so the
// stored section seeds the mask + argv guard at probe time. NO new rclone
// invocation rides the request path: the decode is in-process, so no stored or
// recovered credential ever touches an argv — pinned below by recording every
// executor call and grepping it for each stored and decoded value.

describe('rclone-probe: the saved-remote probe masks against its own stored credentials (cr.48f)', () => {
  let dir: string
  let configFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(TMP_BASE, 'cr48f-store-'))
    configFile = join(dir, 'rclone.conf')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an IsPassword value is decoded IN PROCESS, and the stored + decoded forms both leave nothing — no executor call carries either on its argv', async () => {
    // A REAL obscuring of `topsecret1` (captured from rclone v1.74.3 — the IV
    // is random per run, but the spelling as written is deterministic, and the
    // KAT pins `revealObscured` against it; here the saved section stores it
    // and the probe's mask must cover BOTH spellings rclone could echo).
    const obscuredSpelling = 'Sp0SC2lTn1lEc3b6AhZl7HttaRoEDLZhQgk'
    const plain = 'topsecret1'
    await writeFile(configFile, `[gtsftp]\ntype = sftp\nhost = 127.0.0.1\nuser = u\npass = ${obscuredSpelling}\n`, 'utf-8')
    // The backend quotes the PLAIN credential it was handed — exactly the echo
    // cr.48b masked for the dialog's values and rule 3 now masks for a saved
    // remote's.
    const echo = `Failed to create file system for "gtsftp:": NewFs: couldn't connect SSH: 401 Unauthorized (token ${plain})`
    const calls: { command: string, args: string[] }[] = []
    const exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === '/usr/bin/timeout')
        return { stdout: '', stderr: `${echo}\n`, exitCode: 1 }
      throw new Error(`unexpected call: ${command} ${args.join(' ')}`)
    }
    const r = await testRemote(stubExecutor(exec), { configFile }, { name: 'gtsftp' })
    assert.equal(r.verdict, 'auth', 'the taxonomy still ran on the raw text')
    assert.ok(r.message.includes('[secret]'), r.message)
    assert.ok(!r.message.includes(plain), r.message)
    // The decode is IN PROCESS: the probe is the ONE executor call, and no
    // call — stored form or decoded form — rides an argv.
    assert.equal(calls.length, 1)
    for (const c of calls) {
      for (const a of c.args)
        assert.ok(!a.includes(obscuredSpelling) && !a.includes(plain), `a credential rode an argv token: ${a}`)
    }
  })

  it('a name-rule secret stored PLAIN (s3 secret_access_key) is masked from the stored value alone — a value that is not a well-formed obscuring decodes to NOTHING', async () => {
    await writeFile(configFile, '[gt]\ntype = s3\nsecret_access_key = s3secretkeyvalue\n', 'utf-8')
    const echo = 'AccessDenied: the access key s3secretkeyvalue is not valid'
    const calls: { command: string, args: string[] }[] = []
    const exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === '/usr/bin/timeout')
        return { stdout: '', stderr: `${echo}\n`, exitCode: 1 }
      throw new Error(`unexpected call: ${command} ${args.join(' ')}`)
    }
    const r = await testRemote(stubExecutor(exec), { configFile }, { name: 'gt' })
    assert.equal(r.verdict, 'auth')
    assert.ok(r.message.includes('[secret]'), r.message)
    assert.ok(!r.message.includes('s3secretkeyvalue'), r.message)
    // `s3secretkeyvalue` is inside rclone's raw-URL-safe base64 alphabet, so it
    // reaches the decode — but it is 16 chars → 12 bytes, fewer than the 16-byte
    // IV, so `revealObscured` returns nothing and the STORED text does the
    // masking. The probe stays the only call, nothing on an argv.
    assert.equal(calls.length, 1)
    for (const c of calls) {
      for (const a of c.args)
        assert.ok(!a.includes('s3secretkeyvalue'), `a credential rode an argv token: ${a}`)
    }
  })

  it('a boolean option (ask_password = true) is never a secret — the word `true` is not shredded, the decoded IsPassword still is', async () => {
    // A REAL obscuring of `gtpass` (captured from rclone v1.74.3): the decoded
    // plain is the form the mask must cover, the boolean literal must not.
    await writeFile(configFile, '[gtsftp]\ntype = sftp\nhost = h\nuser = u\npass = -UHN1nBu7Yj3jQ11eG7NixuTyxrbmw\nask_password = true\n', 'utf-8')
    const echo = 'Failed to create file system for "gtsftp:": NewFs: couldn\'t connect SSH: ssh: handshake failed: "the server asks for a password" is true, but none provided (gtpass)'
    const calls: { command: string, args: string[] }[] = []
    const exec = async (command: string, args: string[]): Promise<ExecResult> => {
      calls.push({ command, args })
      if (command === '/usr/bin/timeout')
        return { stdout: '', stderr: `${echo}\n`, exitCode: 1 }
      throw new Error(`unexpected call: ${command} ${args.join(' ')}`)
    }
    const r = await testRemote(stubExecutor(exec), { configFile }, { name: 'gtsftp' })
    assert.equal(r.verdict, 'auth')
    // If `true` had been put in the mask as ask_password's value, ordinary
    // text like "… is true, but …" would be shredded — it is not.
    assert.ok(r.message.includes('is true, but none provided'), r.message)
    // The decoded IsPassword plain IS masked (4-char floor cleared).
    assert.equal(r.message.includes('gtpass'), false, r.message)
    assert.ok(r.message.includes('[secret]'), r.message)
    // Only the probe runs; the decoded plain `gtpass` never rides an argv.
    assert.equal(calls.length, 1)
    for (const c of calls) {
      for (const a of c.args)
        assert.ok(!a.includes('gtpass') && !a.includes('-UHN1nBu7Yj3jQ11eG7NixuTyxrbmw'), `a credential rode an argv token: ${a}`)
    }
  })
})

// ── cr.55: the probe masks with the ONE secret list — transitive, and the
//    obscured spelling the unsaved crypt's env carried (review L7) ─────────

describe('rclone-probe: the one secret list — wrapped remotes and the obscured env value (cr.55)', () => {
  let dir: string
  let configFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(TMP_BASE, 'cr55-store-'))
    configFile = join(dir, 'rclone.conf')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a SAVED crypt over a saved s3 remote: the WRAPPED credential and crypt password2 rclone echoes are masked', async () => {
    await writeFile(configFile, '[s3]\ntype = s3\nsecret_access_key = Sup3rS3cretValue42\n\n[c]\ntype = crypt\nremote = s3:bucket\npassword2 = -UHN1nBu7Yj3jQ11eG7NixuTyxrbmw\n', 'utf-8')
    const echo = 'Failed to create file system for "c:": NewFs: SignatureDoesNotMatch: Sup3rS3cretValue42 (salt gtpass)'
    const exec = async (command: string): Promise<ExecResult> => {
      if (command === '/usr/bin/timeout')
        return { stdout: '', stderr: `${echo}\n`, exitCode: 1 }
      throw new Error(`unexpected call: ${command}`)
    }
    const r = await testRemote(stubExecutor(exec), { configFile }, { name: 'c' })
    assert.equal(r.verdict, 'auth')
    assert.equal(r.message, 'Failed to create file system for "c:": NewFs: SignatureDoesNotMatch: [secret] (salt [secret])')
  })

  it('L7: an UNSAVED crypt probe masks the OBSCURED value its env carried — the spelling rclone -vv prints (captured debug line)', async () => {
    // The obscured spelling is the one the cloudproof.2 capture's debug line
    // prints (`probe-crypt-good-debug-1.60.1.log` line 6); the stub's
    // `obscure` answers it, so the env carries exactly what rclone echoes.
    const obscured = 'Dj8pksfQxTzq-sbvei2DR5W4r7VLmEZummK0etk'
    const debugLine = `2026/09/27 22:46:50 DEBUG : Setting password="${obscured}" for "anastest" from environment variable RCLONE_CONFIG_ANASTEST_PASSWORD`
    const calls: { command: string, args: string[], opts?: ExecOptions }[] = []
    const exec = async (command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
      calls.push({ command, args, opts })
      if (command === RCLONE)
        return { stdout: `${obscured}\n`, stderr: '', exitCode: 0 } // the obscure call
      // rclone's last word is the -vv line quoting the env value.
      return { stdout: '', stderr: `${debugLine}\n`, exitCode: 1 }
    }
    const r = await testRemote(stubExecutor(exec), PATHS, {
      remote: { name: 'gtdraft', type: 'crypt', options: { remote: 'gtsftp:crypt-base', password: 'gtcryptpass' } },
    }, { providers, tmpBase: TMP_BASE })
    assert.equal(r.verdict, 'error')
    assert.equal(r.message, '2026/09/27 22:46:50 DEBUG : Setting password="[secret]" for "anastest" from environment variable RCLONE_CONFIG_ANASTEST_PASSWORD')
    const ls = calls.find(c => c.command === '/usr/bin/timeout')!
    assert.equal(ls.opts?.env?.[`${PROBE_ENV_PREFIX}PASSWORD`], obscured, 'the env carried the obscured spelling')
  })

  it('an UNSAVED crypt over a SAVED s3 remote: the wrapped remote\'s stored credential is masked too', async () => {
    await writeFile(configFile, '[s3]\ntype = s3\nsecret_access_key = Sup3rS3cretValue42\n', 'utf-8')
    const exec = async (command: string): Promise<ExecResult> => {
      if (command === RCLONE)
        return { stdout: 'obscured-by-mock\n', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'Failed to create file system for "anastest:": NewFs: AccessDenied: Sup3rS3cretValue42\n', exitCode: 1 }
    }
    const r = await testRemote(stubExecutor(exec), { configFile }, {
      remote: { name: 'gtdraft', type: 'crypt', options: { remote: 's3:bucket', password: 'gtcryptpass' } },
    }, { providers, tmpBase: TMP_BASE })
    assert.equal(r.verdict, 'auth')
    assert.equal(r.message, 'Failed to create file system for "anastest:": NewFs: AccessDenied: [secret]')
  })
})
