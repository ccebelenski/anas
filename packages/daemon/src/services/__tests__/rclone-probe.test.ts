import type { CloudProvider } from '@anas/shared'
import type { CommandExecutor, ExecOptions, ExecResult, ExecStreamResult, PipelineResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RCLONE, trimProviders } from '../rclone-config.js'
import {
  classifyProbe,
  PROBE_ENV_PREFIX,
  PROBE_REMOTE_NAME,
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
    assert.equal(calls[0]!.opts, undefined)
    // A saved remote is probed against ANAS's OWN store: the three sftp
    // detection keys rclone appends land in that remote's own section, which
    // the INI writer keeps and the API lists (GT fact 1).
    assert.equal(probeConfigOf(calls[0]!.args), PATHS.configFile)
  })

  it('the argv is the design\'s: timeout 45, base args, lsjson, the bounded flags', () => {
    assert.deepEqual(probeArgs('/etc/anas/rclone.conf', 'gt:'), [
      '45',
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
      '30s',
      '--retries',
      '1',
      '--low-level-retries',
      '1',
    ])
    assert.equal(probeArgs(PATHS.configFile, 'gt:')[0], '45')
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
