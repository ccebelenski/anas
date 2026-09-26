import type { CloudProvider, CloudProviderOption } from '@anas/shared'
import type { CommandExecutor } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import {
  ConfigEncryptedError,
  defaultRcloneConfigPaths,
  isSecretKey,
  normalizeOAuthToken,
  OAUTH_TOKEN_ERROR,
  obscure,
  passwordKeysFor,
  providerOption,
  RCLONE,
  rcloneBaseArgs,
  RcloneConfigGateError,
  rcloneVersion,
  readConfig,
  RemoteExistsError,
  RemoteNotFoundError,
  removeRemote,
  trimProviders,
  writeConfigFileAtomic,
  writeRemote,
} from '../rclone-config.js'
import { assertNoSecretValues, SecretOnArgvError } from '../secret-argv.js'

// The REAL 1.60.1 provider capture (packages/daemon/src/fixtures) — the node's
// `rclone config providers` stdout VERBATIM (a bare JSON list of all 46
// backends, GT 2026-09-23), trimmed through the function under test, so every
// assertion below runs on the actual binary's output.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone/providers-1.60.1.json')
const RAW_FIXTURE: { Name: string, Options?: { Hide?: number }[] }[] = JSON.parse(await readFile(FIXTURE, 'utf-8'))
const providers: CloudProvider[] = trimProviders(RAW_FIXTURE)

function provider(name: string): CloudProvider {
  const p = providers.find(x => x.name === name)
  assert.ok(p, `fixture has provider '${name}'`)
  return p!
}

function mkOption(over: Partial<CloudProviderOption> = {}): CloudProviderOption {
  return {
    name: 'x',
    help: '',
    type: 'string',
    required: false,
    secret: false,
    password: false,
    default: '',
    examples: [],
    provider: '',
    advanced: false,
    ...over,
  }
}

/** A canned `config dump` stdout. */
function dumpResult(obj: unknown): { stdout: string, stderr: string, exitCode: number } {
  return { stdout: JSON.stringify(obj, null, 4), stderr: '', exitCode: 0 }
}

describe('rclone-config: the secret-key rule (rclone.1)', () => {
  it('the name rule: whole key or whole suffix at an _ boundary', () => {
    const secret = ['key', 'pass', 'password', 'token', 'secret', 'secret_access_key', 'client_secret', 'sse_customer_key', 'key_file_pass', 'access_token']
    const notSecret = ['access_key_id', 'key_file', 'sse_kms_key_id', 'pubkey_file', 'key_use_agent', 'endpoint', 'host', 'password2', 'mykey', 'bypass']
    for (const k of secret)
      assert.equal(isSecretKey(k), true, `expected '${k}' secret`)
    for (const k of notSecret)
      assert.equal(isSecretKey(k), false, `expected '${k}' NOT secret`)
  })

  it('a known provider option makes rclone\'s own fact authoritative', () => {
    // `password2` fails the NAME rule (ends in a digit) but rclone types it
    // as a password — the option wins.
    assert.equal(isSecretKey('password2', mkOption({ name: 'password2', secret: true, password: true })), true)
    // a non-matching name the provider flags secret
    assert.equal(isSecretKey('access_key_id', mkOption({ name: 'access_key_id', secret: true })), true)
    // an option that says otherwise is NOT trusted over the name rule —
    // the rule is a UNION (a name-lookalike stays secret)
    assert.equal(isSecretKey('client_secret', mkOption({ name: 'client_secret', secret: false })), true)
  })

  it('a BOOL option is never a secret, however it is named', () => {
    // sftp/ftp `ask_password` matches the name rule but holds true/false —
    // hiding it would leave a stored `ask_password = true` neither showable
    // nor clearable in the dialog.
    assert.equal(isSecretKey('ask_password', mkOption({ name: 'ask_password', type: 'bool' })), false)
    // the name rule alone (no option known) still calls it secret
    assert.equal(isSecretKey('ask_password'), true)
    // rclone's own flag still wins on a bool
    assert.equal(isSecretKey('ask_password', mkOption({ name: 'ask_password', type: 'bool', secret: true })), true)
  })
})

describe('rclone-config: trimProviders on the 1.60.1 fixture (rclone.1)', () => {
  it('trims every backend of the captured catalogue with the shared shape', () => {
    assert.equal(providers.length, RAW_FIXTURE.length)
    for (const name of ['alias', 'b2', 'crypt', 'drive', 'local', 's3', 'sftp', 'webdav'])
      assert.ok(providers.some(p => p.name === name), `the '${name}' backend is in the capture`)
  })

  it('every captured backend keeps exactly its fixture option count (Hide=0 only)', () => {
    // The expected counts are the fixture's own, per backend — a drift in
    // the trim (a dropped or duplicated option) fails here.
    for (const raw of RAW_FIXTURE) {
      const expected = (raw.Options ?? []).filter(o => (o.Hide ?? 0) === 0).length
      assert.equal(provider(raw.Name).options.length, expected, `option count for '${raw.Name}'`)
    }
  })

  it('b2: account / key (secret, required) / hard_delete; hidden options dropped', () => {
    const b2 = provider('b2')
    const account = b2.options.find(o => o.name === 'account')!
    assert.equal(account.required, true)
    assert.equal(account.secret, false)
    const key = b2.options.find(o => o.name === 'key')!
    assert.equal(key.required, true)
    assert.equal(key.secret, true) // name rule — rclone does NOT type it as a password
    assert.equal(key.password, false)
    const hardDelete = b2.options.find(o => o.name === 'hard_delete')!
    assert.equal(hardDelete.secret, false)
    assert.equal(b2.options.some(o => o.name === 'test_mode'), false) // Hide = 2
  })

  it('s3: secret_access_key is secret although IsPassword is false', () => {
    const s3 = provider('s3')
    const ssk = s3.options.find(o => o.name === 'secret_access_key')!
    assert.equal(ssk.secret, true)
    assert.equal(ssk.password, false)
    const aik = s3.options.find(o => o.name === 'access_key_id')!
    assert.equal(aik.secret, false)
  })

  it('s3: multiple region options, each with a different non-empty provider filter', () => {
    const regions = provider('s3').options.filter(o => o.name === 'region')
    assert.ok(regions.length >= 2, `expected several region filters, got ${regions.length}`)
    const filters = regions.map(o => o.provider)
    for (const f of filters)
      assert.notEqual(f, '', 'a region instance carries its provider filter')
    assert.equal(new Set(filters).size, filters.length, 'the filters are distinct')
  })

  it('sftp: pass is secret via IsPassword; key_file is not secret', () => {
    const sftp = provider('sftp')
    const pass = sftp.options.find(o => o.name === 'pass')!
    assert.equal(pass.secret, true)
    assert.equal(pass.password, true)
    const keyFile = sftp.options.find(o => o.name === 'key_file')!
    assert.equal(keyFile.secret, false)
    assert.equal(keyFile.password, false)
  })

  it('sftp/ftp ask_password is a bool, so it is not secret despite the name', () => {
    for (const type of ['sftp', 'ftp']) {
      const ask = provider(type).options.find(o => o.name === 'ask_password')!
      assert.equal(ask.type, 'bool', `${type}.ask_password is a bool in the capture`)
      assert.equal(ask.secret, false, `${type}.ask_password is not secret`)
      assert.equal(ask.password, false)
    }
  })

  it('crypt: password and password2 are secret; drive: the advanced token option', () => {
    for (const name of ['password', 'password2'])
      assert.equal(provider('crypt').options.find(o => o.name === name)!.secret, true, name)
    const token = provider('drive').options.find(o => o.name === 'token')!
    assert.equal(token.advanced, true)
    assert.equal(token.secret, true)
  })

  it('passwordKeysFor is the IsPassword set only (the obscure-in-file set)', () => {
    assert.deepEqual([...passwordKeysFor(providers, 'sftp')], ['pass', 'key_file_pass'])
    assert.deepEqual([...passwordKeysFor(providers, 'crypt')], ['password', 'password2'])
    assert.deepEqual([...passwordKeysFor(providers, 's3')], []) // secret_access_key is stored PLAIN
    assert.deepEqual([...passwordKeysFor(providers, 'nope')], [])
  })

  it('providerOption finds the first instance of a repeated option', () => {
    const region = providerOption(providers, 's3', 'region')
    assert.ok(region)
    assert.equal(region!.name, 'region')
    assert.equal(providerOption(providers, 's3', 'no_such_key'), undefined)
    assert.equal(providerOption(providers, 'no_such_type', 'region'), undefined)
  })

  it('a malformed providers blob throws', () => {
    assert.throws(() => trimProviders({}), /unexpected output shape/)
    assert.throws(() => trimProviders(null), /unexpected output shape/)
  })
})

describe('rclone-config: trimProviders curation (rclone.4)', () => {
  it('a curated backend carries the guide sentence and the own-client list', () => {
    const drive = provider('drive')
    assert.ok(drive.guide && drive.guide.length > 0, 'drive has a guide sentence')
    assert.match(drive.guide!, /rclone authorize/)
    assert.match(drive.guide!, /drive/, 'the sentence names its own backend')
    assert.deepEqual(drive.ownClient, ['client_id', 'client_secret'])
    // dropbox/box have no own-client fields: the field stays ABSENT, never [].
    assert.equal(provider('dropbox').ownClient, undefined)
    assert.ok(provider('dropbox').guide, 'dropbox has a guide sentence')
  })

  it('curated ⇒ essential is the table\'s list, on the real capture', () => {
    // drive: token essential (even though rclone types it advanced); the
    // own-client pair and everything else are not.
    const drive = provider('drive')
    assert.equal(drive.options.find(o => o.name === 'token')!.essential, true)
    for (const name of ['client_id', 'client_secret', 'scope', 'service_account_file', 'root_folder_id'])
      assert.equal(drive.options.find(o => o.name === name)!.essential, false, name)
    // s3: exactly the five primary fields.
    const s3 = provider('s3')
    for (const name of ['provider', 'access_key_id', 'secret_access_key', 'region', 'endpoint'])
      assert.equal(s3.options.find(o => o.name === name)!.essential, true, name)
    assert.equal(s3.options.find(o => o.name === 'env_auth')!.essential, false)
    // b2: account / key essential, the rest not.
    const b2 = provider('b2')
    for (const name of ['account', 'key'])
      assert.equal(b2.options.find(o => o.name === name)!.essential, true, name)
    assert.equal(b2.options.find(o => o.name === 'hard_delete')!.essential, false)
    // sftp: the login fields essential; `key_pem` (a paste-in key, not a path) not.
    const sftp = provider('sftp')
    for (const name of ['host', 'port', 'user', 'pass', 'key_file'])
      assert.equal(sftp.options.find(o => o.name === name)!.essential, true, name)
    assert.equal(sftp.options.find(o => o.name === 'key_pem')!.essential, false)
  })

  it('curated backends of the capture all carry a guide', () => {
    for (const name of ['drive', 'onedrive', 'dropbox', 'box', 'pcloud', 's3', 'b2', 'sftp', 'ftp', 'webdav', 'smb', 'azureblob'])
      assert.ok(provider(name).guide, `'${name}' has a guide sentence`)
  })

  it('an uncurated backend mirrors !advanced and adds nothing', () => {
    for (const name of ['koofr', 'alias', 'local']) {
      const p = provider(name)
      assert.equal(p.guide, undefined, `'${name}' has no guide`)
      assert.equal(p.ownClient, undefined, `'${name}' has no own-client list`)
      for (const o of p.options)
        assert.equal(o.essential, !o.advanced, `${name}.${o.name}`)
    }
  })

  it('a curated name absent from rclone\'s catalogue is ignored, never invented', () => {
    // A synthetic capture whose `dropbox` knows only two options: the trim
    // marks what IS there from the table and invents nothing that is not.
    const raw = [
      {
        Name: 'dropbox',
        Description: 'Dropbox',
        Options: [
          { Name: 'token', Help: '', Type: 'string', Required: false, Advanced: true },
          { Name: 'chunk_size', Help: '', Type: 'string', Required: false, Advanced: false },
        ],
      },
      { Name: 'notacuration', Description: 'x', Options: [] },
    ]
    const [dbx, unk] = trimProviders(raw)
    assert.equal(dbx!.options.find(o => o.name === 'token')!.essential, true)
    assert.equal(dbx!.options.find(o => o.name === 'chunk_size')!.essential, false)
    assert.equal(dbx!.options.some(o => o.name === 'nonexistent'), false)
    assert.equal(unk!.guide, undefined)
    assert.equal(unk!.ownClient, undefined)
  })
})

describe('rclone-config: argv guard + base args (rclone.1)', () => {
  it('rcloneBaseArgs is --config <file> --ask-password=false, nothing more', () => {
    assert.deepEqual(rcloneBaseArgs('/etc/anas/rclone.conf'), ['--config', '/etc/anas/rclone.conf', '--ask-password=false'])
  })

  it('assertNoSecretValues refuses an argv carrying a secret, without naming it', () => {
    assert.doesNotThrow(() => assertNoSecretValues(['config', 'dump'], ['hunter2secret']))
    assert.throws(() => assertNoSecretValues(['--pass=hunter2secret'], ['hunter2secret']), SecretOnArgvError)
    assert.throws(() => assertNoSecretValues(['hunter2secret'], ['hunter2secret']), SecretOnArgvError)
    try {
      assertNoSecretValues(['x=hunter2secret'], ['hunter2secret'])
      assert.fail('expected a throw')
    }
    catch (err) {
      assert.ok(err instanceof SecretOnArgvError)
      assert.ok(!String(err.message).includes('hunter2secret'), 'the error must not echo the secret')
    }
    // empty secret values cannot match anything
    assert.doesNotThrow(() => assertNoSecretValues(['anything'], ['', '']))
  })

  it('the guard skips the base args (ANAS constants) and checks only the dynamic tail (regression)', () => {
    // The false positive the flake was: `--ask-password=false` contains the
    // value `false`, and a config path may contain the value `h`. Neither is
    // the dynamic tail, so neither may trip the guard.
    const base = rcloneBaseArgs('/tmp/h-false/rclone.conf')
    assert.doesNotThrow(() => assertNoSecretValues([...base, 'config', 'dump'], ['h', 'false'], base.length))
    assert.doesNotThrow(() => assertNoSecretValues([...base, 'obscure', '-'], ['hunter2secret'], base.length))
    // …but a plain secret smuggled into the DYNAMIC tail is still refused.
    assert.throws(() => assertNoSecretValues([...base, 'config', 'dump', 'x=hunter2secret'], ['hunter2secret'], base.length), SecretOnArgvError)
    assert.throws(() => assertNoSecretValues([...base, 'hunter2secret'], ['hunter2secret'], base.length), SecretOnArgvError)
  })

  it('the config path is env-overridable', () => {
    const saved = process.env.ANAS_RCLONE_CONFIG
    try {
      delete process.env.ANAS_RCLONE_CONFIG
      assert.equal(defaultRcloneConfigPaths().configFile, '/etc/anas/rclone.conf')
      process.env.ANAS_RCLONE_CONFIG = '/tmp/elsewhere.conf'
      assert.equal(defaultRcloneConfigPaths().configFile, '/tmp/elsewhere.conf')
    }
    finally {
      if (saved === undefined)
        delete process.env.ANAS_RCLONE_CONFIG
      else
        process.env.ANAS_RCLONE_CONFIG = saved
    }
  })
})

describe('rclone-config: rcloneVersion (rclone.1)', () => {
  it('parses the first line, stripping v and any -suffix', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1-DEV\nos: go1.22\n', stderr: '', exitCode: 0 } })
    assert.equal(await rcloneVersion(mock), '1.60.1')

    mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1\n', stderr: '', exitCode: 0 } })
    assert.equal(await rcloneVersion(mock), '1.60.1')
  })

  it('a missing binary (executor reports 127) throws a plain message', async () => {
    const mock = new MockExecutor() // no fixture: 127 not-found
    await assert.rejects(rcloneVersion(mock), /mock: command not found: \/usr\/bin\/rclone/)
  })

  it('unrecognised output throws', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'hello\n', stderr: '', exitCode: 0 } })
    await assert.rejects(rcloneVersion(mock), /unrecognized rclone version output/)
  })
})

describe('rclone-config: readConfig (rclone.1)', () => {
  let dir: string
  let paths: { configFile: string }
  let mock: MockExecutor

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-rclone-read-'))
    paths = { configFile: join(dir, 'rclone.conf') }
    mock = new MockExecutor()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an absent file reads as empty: no remotes, not encrypted, not present', async () => {
    mock.addFixture({ command: RCLONE, args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'], result: dumpResult({}) })
    const read = await readConfig(paths, mock)
    assert.equal(read.text, '')
    assert.equal(read.encrypted, false)
    assert.deepEqual(read.remotes, [])
    assert.equal(read.existedBefore, false)
  })

  it('an existing EMPTY file reads as empty text with existedBefore true', async () => {
    await writeFile(paths.configFile, '', 'utf-8')
    mock.addFixture({ command: RCLONE, args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'], result: dumpResult({}) })
    const read = await readConfig(paths, mock)
    assert.equal(read.text, '')
    assert.equal(read.existedBefore, true)
  })

  it('non-JSON dump output throws stating the fact only — no dump bytes in the message', async () => {
    // The dump output can carry a plain name-rule secret (an s3
    // secret_access_key) — the error must not become the leak.
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'],
      result: { stdout: 'secret_access_key = PLAIN\n', stderr: '', exitCode: 0 },
    })
    await assert.rejects(readConfig(paths, mock), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /not JSON/)
      assert.ok(!err.message.includes('PLAIN'), `the error leaked dump bytes: ${err.message}`)
      return true
    })
  })

  it('a real-shaped dump: non-secret options back, secrets named never valued, sorted by name', async () => {
    await writeFile(paths.configFile, '[b]\ntype = s3\naccess_key_id = AKIA\nsecret_access_key = plainsecret\n[b]\n', 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'],
      result: dumpResult({
        b: { type: 's3', access_key_id: 'AKIA', secret_access_key: 'plainsecret', region: 'us-east-1' },
        a: { type: 'sftp', host: '127.0.0.1', user: 'root', pass: 'OBSCURED-value' },
      }),
    })
    const read = await readConfig(paths, mock, providers)
    assert.ok(read.text.length > 0)
    assert.equal(read.encrypted, false)
    assert.deepEqual(read.remotes, [
      { name: 'a', type: 'sftp', options: { host: '127.0.0.1', user: 'root' }, secretsSet: ['pass'] },
      { name: 'b', type: 's3', options: { access_key_id: 'AKIA', region: 'us-east-1' }, secretsSet: ['secret_access_key'] },
    ])

    // and with NO providers (name rule only) the same keys read as secret
    mock.clearFixtures()
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'],
      result: dumpResult({
        b: { type: 's3', access_key_id: 'AKIA', secret_access_key: 'plainsecret', region: 'us-east-1' },
        a: { type: 'sftp', host: '127.0.0.1', user: 'root', pass: 'OBSCURED-value' },
      }),
    })
    const again = await readConfig(paths, mock)
    assert.deepEqual(again.remotes.map(r => r.secretsSet), [['pass'], ['secret_access_key']])
  })

  it('a bool named like a secret comes back as a VALUE, not in secretsSet', async () => {
    // `ask_password = true` on an sftp remote: the providers make the option's
    // type known, so the value is shown and can be cleared.
    await writeFile(paths.configFile, '[a]\ntype = sftp\nask_password = true\n', 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'],
      result: dumpResult({
        a: { type: 'sftp', host: '127.0.0.1', ask_password: 'true', pass: 'OBSCURED-value' },
      }),
    })
    const read = await readConfig(paths, mock, providers)
    const a = read.remotes.find(r => r.name === 'a')!
    assert.equal(a.options.ask_password, 'true')
    assert.deepEqual(a.secretsSet, ['pass'])
  })

  it('an encrypted-style failure reads as encrypted:true with the raw text', async () => {
    await writeFile(paths.configFile, '[x]\nhost = 0.0.0.0\n', 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'],
      result: { stdout: '', stderr: 'Failed to load config file: unable to decrypt configuration\n', exitCode: 1 },
    })
    const read = await readConfig(paths, mock)
    assert.equal(read.encrypted, true)
    assert.deepEqual(read.remotes, [])
    assert.equal(read.text, '[x]\nhost = 0.0.0.0\n')
  })

  it('any other non-zero dump throws carrying rclone\'s last line', async () => {
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(paths.configFile), 'config', 'dump'],
      result: { stdout: '', stderr: 'boom: something went sideways\n', exitCode: 1 },
    })
    await assert.rejects(readConfig(paths, mock), /rclone config dump failed: boom: something went sideways/)
  })
})

describe('rclone-config: obscure (rclone.1)', () => {
  it('obscures via stdin and returns the trimmed stdout', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: RCLONE, args: [...rcloneBaseArgs('/etc/anas/rclone.conf'), 'obscure', '-'], result: { stdout: 'OBSCURED\n', stderr: '', exitCode: 0 } })
    assert.equal(await obscure(mock, 'hunter2secret'), 'OBSCURED')
    // the value rode stdin, never args
    assert.equal(mock.calls.length, 1)
    assert.deepEqual(mock.calls[0]!.args, ['--config', '/etc/anas/rclone.conf', '--ask-password=false', 'obscure', '-'])
  })

  it('a failed obscure throws', async () => {
    const mock = new MockExecutor()
    mock.addFixture({ command: RCLONE, args: [...rcloneBaseArgs('/etc/anas/rclone.conf'), 'obscure', '-'], result: { stdout: '', stderr: 'obscure: nope\n', exitCode: 1 } })
    await assert.rejects(obscure(mock, 'hunter2secret'), /rclone obscure failed: obscure: nope/)
  })
})

describe('rclone-config: writeRemote (rclone.1)', () => {
  let dir: string
  let cfg: string
  let paths: { configFile: string }
  let mock: MockExecutor
  const base = () => rcloneBaseArgs(cfg)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-rclone-write-'))
    // a NESTED config path exercises the create-parent-0700 branch
    cfg = join(dir, 'etc-anas', 'rclone.conf')
    paths = { configFile: cfg }
    mock = new MockExecutor()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('create: the section in provider order, password obscured via stdin, 0600, no secret on any argv', async () => {
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      // first call: the current (empty) state — second call: the gate
      results: [dumpResult({}), dumpResult({ homelab: { type: 'sftp', host: '127.0.0.1', user: 'root', pass: 'OBSCURED' } })],
    })
    mock.addFixture({ command: RCLONE, args: [...base(), 'obscure', '-'], result: { stdout: 'OBSCURED\n', stderr: '', exitCode: 0 } })

    const result = await writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: '127.0.0.1', user: 'root', pass: 'hunter2secret' } }, { providers, mode: 'create' })

    const text = await readFile(cfg, 'utf-8')
    assert.equal(text, '[homelab]\ntype = sftp\nhost = 127.0.0.1\nuser = root\npass = OBSCURED\n')

    const file = await stat(cfg)
    assert.equal(file.mode & 0o777, 0o600)
    const parent = await stat(dirname(cfg))
    assert.equal(parent.mode & 0o777, 0o700)

    assert.deepEqual(result, { name: 'homelab', type: 'sftp', options: { host: '127.0.0.1', user: 'root' }, secretsSet: ['pass'] })

    // NO exec call's args may carry the plain password (the argv-guard proof)
    for (const call of mock.calls) {
      for (const a of call.args)
        assert.ok(!a.includes('hunter2secret'), `secret in argv: ${a}`)
    }
    // and the obscure call did happen
    assert.ok(mock.calls.some(c => c.args.slice(-2).join(' ') === 'obscure -'))
  })

  it('create on an existing name throws RemoteExistsError', async () => {
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      result: dumpResult({ homelab: { type: 'sftp', host: '127.0.0.1' } }),
    })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: {} }, { providers, mode: 'create' }),
      RemoteExistsError,
    )
  })

  it('create with an unknown option key throws naming the key', async () => {
    mock.addFixture({ command: RCLONE, args: [...base(), 'config', 'dump'], result: dumpResult({}) })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { bogus_key: 'x' } }, { providers, mode: 'create' }),
      /unknown option 'bogus_key' for remote type 'sftp'/,
    )
  })

  it('create with an unknown type throws', async () => {
    mock.addFixture({ command: RCLONE, args: [...base(), 'config', 'dump'], result: dumpResult({}) })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'flyingkettles', options: {} }, { providers, mode: 'create' }),
      /unknown remote type 'flyingkettles'/,
    )
  })

  it('update: untouched keys stay verbatim, \'\' removes a non-secret key, \'\' on a secret is ignored, type change refused', async () => {
    const seed = '[homelab]\ntype = sftp\nhost = 127.0.0.1\nuser = root\npass = OBSCURED-orig\nport = 2222\n'
    await mkdir(dirname(cfg), { recursive: true })
    await writeFile(cfg, seed, { encoding: 'utf-8', mode: 0o644 })
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [
        dumpResult({ homelab: { type: 'sftp', host: '127.0.0.1', user: 'root', pass: 'OBSCURED-orig', port: '2222' } }),
        dumpResult({ homelab: { type: 'sftp', host: '10.0.0.9', user: 'root', pass: 'OBSCURED-orig' } }),
      ],
    })

    const result = await writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: '10.0.0.9', pass: '', port: '' } }, { providers, mode: 'update' })

    const text = await readFile(cfg, 'utf-8')
    assert.equal(text, '[homelab]\ntype = sftp\nhost = 10.0.0.9\nuser = root\npass = OBSCURED-orig\n')
    // the update path (re)writes 0600 — a pre-existing 0644 file is not left loose
    assert.equal((await stat(cfg)).mode & 0o777, 0o600)
    assert.deepEqual(result, { name: 'homelab', type: 'sftp', options: { host: '10.0.0.9', user: 'root' }, secretsSet: ['pass'] })
    // no password value was re-sent, so no obscure call
    assert.ok(!mock.calls.some(c => c.args.includes('obscure')))

    // and the type is immutable
    mock.clearFixtures()
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      result: dumpResult({ homelab: { type: 'sftp', host: '127.0.0.1' } }),
    })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'webdav', options: {} }, { providers, mode: 'update' }),
      /the type is immutable/,
    )
  })

  it('update of an absent remote throws RemoteNotFoundError', async () => {
    mock.addFixture({ command: RCLONE, args: [...base(), 'config', 'dump'], result: dumpResult({}) })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'ghost', type: 'sftp', options: {} }, { providers, mode: 'update' }),
      RemoteNotFoundError,
    )
  })

  it('a failed gate rolls the file back byte-identically (absent-before ⇒ removed)', async () => {
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [dumpResult({}), { stdout: '', stderr: 'config file corrupt: cannot parse\n', exitCode: 1 }],
    })
    mock.addFixture({ command: RCLONE, args: [...base(), 'obscure', '-'], result: { stdout: 'OBSCURED\n', stderr: '', exitCode: 0 } })

    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: 'h', pass: 'hunter2secret' } }, { providers, mode: 'create' }),
      RcloneConfigGateError,
    )
    await assert.rejects(stat(cfg), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
  })

  it('a gate that lists the remote but disagrees rolls the PREVIOUS bytes back', async () => {
    const seed = '[homelab]\ntype = sftp\nhost = 127.0.0.1\n'
    await mkdir(dirname(cfg), { recursive: true })
    await writeFile(cfg, seed, 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [
        dumpResult({ homelab: { type: 'sftp', host: '127.0.0.1' } }),
        dumpResult({ homelab: { type: 'sftp', host: 'SOMETHING-ELSE' } }), // disagrees with the write
      ],
    })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: '10.0.0.9' } }, { providers, mode: 'update' }),
      (err: Error) => err instanceof RcloneConfigGateError && err.message.includes('host'),
    )
    assert.equal(await readFile(cfg, 'utf-8'), seed)
  })

  it('a hand-added section with a comment survives a write to ANOTHER section byte-for-byte', async () => {
    const handmade = '[handmade]\ntype = webdav\n# anas:test comment\nurl = https://x\n'
    const seed = `${handmade}\n[homelab]\ntype = sftp\nhost = 127.0.0.1\n`
    await mkdir(dirname(cfg), { recursive: true })
    await writeFile(cfg, seed, 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [
        dumpResult({ handmade: { type: 'webdav', url: 'https://x' }, homelab: { type: 'sftp', host: '127.0.0.1' } }),
        dumpResult({ handmade: { type: 'webdav', url: 'https://x' }, homelab: { type: 'sftp', host: '10.9.9.9' } }),
      ],
    })
    await writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: '10.9.9.9' } }, { providers, mode: 'update' })

    const text = await readFile(cfg, 'utf-8')
    assert.equal(text, `${handmade}\n[homelab]\ntype = sftp\nhost = 10.9.9.9\n`)
  })

  it('an encrypted config refuses the write with ConfigEncryptedError', async () => {
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      result: { stdout: '', stderr: 'Failed to load config file: unable to decrypt configuration\n', exitCode: 1 },
    })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: 'h' } }, { providers, mode: 'create' }),
      ConfigEncryptedError,
    )
    await assert.rejects(stat(cfg), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
  })

  it('secret-SHAPED plain values (host "h", hard_delete "false") do not trip the guard (regression)', async () => {
    // The flake: the guard set was EVERY option value and the check covered
    // the base args too — so a `host` of `h` matched a config path that
    // contains `h`, and a `false` value matched `--ask-password=false`. A
    // config path containing BOTH, and two writes whose values are `h` and
    // `false`, must succeed.
    const cfg2 = join(dir, 'h', 'h-false.conf')
    const paths2 = { configFile: cfg2 }
    const base2 = () => rcloneBaseArgs(cfg2)
    mock.addFixture({
      command: RCLONE,
      args: [...base2(), 'config', 'dump'],
      results: [
        dumpResult({}),
        dumpResult({ one: { type: 'sftp', host: 'h' } }),
        dumpResult({ one: { type: 'sftp', host: 'h' } }),
        dumpResult({ one: { type: 'sftp', host: 'h' }, two: { type: 'b2', account: 'acct', key: 'plainkey', hard_delete: 'false' } }),
      ],
    })

    const ra = await writeRemote(paths2, mock, { name: 'one', type: 'sftp', options: { host: 'h' } }, { providers, mode: 'create' })
    const rb = await writeRemote(paths2, mock, { name: 'two', type: 'b2', options: { account: 'acct', key: 'plainkey', hard_delete: 'false' } }, { providers, mode: 'create' })
    assert.deepEqual(ra.options, { host: 'h' })
    assert.deepEqual(rb, { name: 'two', type: 'b2', options: { account: 'acct', hard_delete: 'false' }, secretsSet: ['key'] })
    assert.equal(await readFile(cfg2, 'utf-8'), '[one]\ntype = sftp\nhost = h\n\n[two]\ntype = b2\naccount = acct\nkey = plainkey\nhard_delete = false\n')
  })

  it('a CRLF-edited config passes the gate and stays CRLF-only after the update', async () => {
    const seed = '[homelab]\r\ntype = sftp\r\nhost = 127.0.0.1\r\nuser = root\r\n'
    await mkdir(dirname(cfg), { recursive: true })
    await writeFile(cfg, seed, 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [
        dumpResult({ homelab: { type: 'sftp', host: '127.0.0.1', user: 'root' } }),
        dumpResult({ homelab: { type: 'sftp', host: '10.0.0.9', user: 'root' } }),
      ],
    })
    await writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: '10.0.0.9' } }, { providers, mode: 'update' })
    const text = await readFile(cfg, 'utf-8')
    assert.equal(text, '[homelab]\r\ntype = sftp\r\nhost = 10.0.0.9\r\nuser = root\r\n')
  })

  it('a gate failure on an existing EMPTY file restores it empty, not deleted', async () => {
    await mkdir(dirname(cfg), { recursive: true })
    await writeFile(cfg, '', 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [dumpResult({}), { stdout: '', stderr: 'config file corrupt: cannot parse\n', exitCode: 1 }],
    })
    await assert.rejects(
      writeRemote(paths, mock, { name: 'homelab', type: 'sftp', options: { host: '127.0.0.1' } }, { providers, mode: 'create' }),
      RcloneConfigGateError,
    )
    // the file EXISTED (empty) before the write — it comes back empty
    assert.equal(await readFile(cfg, 'utf-8'), '')
  })

  it('a failed rename leaves no .tmp behind (the target path is a directory)', async () => {
    await mkdir(dirname(cfg), { recursive: true })
    await mkdir(cfg)
    await assert.rejects(
      writeConfigFileAtomic(paths, '[x]\ntype = sftp\n'),
      (err: NodeJS.ErrnoException) => {
        assert.equal(err.code, 'EISDIR')
        return true
      },
    )
    await assert.rejects(stat(join(dirname(cfg), 'rclone.conf.tmp')), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
  })

  it('a failed ROLLBACK still yields the gate error, stating the restore failed', async () => {
    const seed = '[homelab]\ntype = sftp\nhost = 127.0.0.1\n'
    await mkdir(dirname(cfg), { recursive: true })
    await writeFile(cfg, seed, 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [
        dumpResult({ homelab: { type: 'sftp', host: '127.0.0.1' } }),
        { stdout: '', stderr: 'config file corrupt: cannot parse\n', exitCode: 1 },
      ],
    })
    // The fs goes hostile on the GATE call (the 2nd dump): the config file
    // becomes a directory, so the rollback's rename must fail. Nothing in
    // the real sequence would do that — the mocked rclone call is the only
    // place to stage it.
    let dumps = 0
    const executor: CommandExecutor = {
      async exec(command, args, opts) {
        const result = await mock.exec(command, args, opts)
        if (args.at(-2) === 'config' && args.at(-1) === 'dump') {
          dumps++
          if (dumps === 2) {
            await rm(cfg, { force: true })
            await mkdir(cfg)
          }
        }
        return result
      },
      pipeline: (c1, a1, c2, a2) => mock.pipeline(c1, a1, c2, a2),
      execToStream: (c, a, t, o) => mock.execToStream(c, a, t, o),
    }
    await assert.rejects(
      writeRemote(paths, executor, { name: 'homelab', type: 'sftp', options: { host: '10.0.0.9' } }, { providers, mode: 'update' }),
      (err: unknown) => {
        assert.ok(err instanceof RcloneConfigGateError, `expected RcloneConfigGateError, got ${String(err)}`)
        assert.match(err.message, /config file corrupt/) // the gate reason survives
        assert.match(err.message, /rollback/) // and the failed restore is stated
        assert.ok(!err.message.includes('hunter2secret'), 'no secret in the refusal')
        return true
      },
    )
  })

  it('two concurrent writes on the same file serialise through the lock — no lost update', async () => {
    // Without the lock both writes would read the same pre-state and the
    // second rename would clobber the first section. The canned dumps play
    // the serialised order: A reads empty, A gates, B reads A's section,
    // B gates on both.
    mock.addFixture({
      command: RCLONE,
      args: [...base(), 'config', 'dump'],
      results: [
        dumpResult({}),
        dumpResult({ a: { type: 'sftp', host: '10.0.0.1' } }),
        dumpResult({ a: { type: 'sftp', host: '10.0.0.1' } }),
        dumpResult({ a: { type: 'sftp', host: '10.0.0.1' }, b: { type: 'sftp', host: '10.0.0.2' } }),
      ],
    })
    const [ra, rb] = await Promise.all([
      writeRemote(paths, mock, { name: 'a', type: 'sftp', options: { host: '10.0.0.1' } }, { providers, mode: 'create' }),
      writeRemote(paths, mock, { name: 'b', type: 'sftp', options: { host: '10.0.0.2' } }, { providers, mode: 'create' }),
    ])
    assert.deepEqual(ra, { name: 'a', type: 'sftp', options: { host: '10.0.0.1' }, secretsSet: [] })
    assert.deepEqual(rb, { name: 'b', type: 'sftp', options: { host: '10.0.0.2' }, secretsSet: [] })
    const text = await readFile(cfg, 'utf-8')
    assert.ok(text.includes('[a]\n'), `missing section a in: ${text}`)
    assert.ok(text.includes('[b]\n'), `missing section b in: ${text}`)
    assert.ok(text.includes('host = 10.0.0.1'))
    assert.ok(text.includes('host = 10.0.0.2'))
  })
})

describe('rclone-config: removeRemote (rclone.1)', () => {
  let dir: string
  let cfg: string
  let paths: { configFile: string }
  let mock: MockExecutor

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-rclone-remove-'))
    cfg = join(dir, 'rclone.conf')
    paths = { configFile: cfg }
    mock = new MockExecutor()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('removes only the section — the other one stays byte-identical', async () => {
    const seed = '[media]\ntype = webdav\nurl = https://x\n\n[homelab]\ntype = sftp\nhost = 127.0.0.1\n'
    await writeFile(cfg, seed, 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(cfg), 'config', 'dump'],
      results: [
        dumpResult({ media: { type: 'webdav', url: 'https://x' }, homelab: { type: 'sftp', host: '127.0.0.1' } }),
        dumpResult({ media: { type: 'webdav', url: 'https://x' } }),
      ],
    })
    await removeRemote(paths, mock, 'homelab')
    assert.equal(await readFile(cfg, 'utf-8'), '[media]\ntype = webdav\nurl = https://x\n')
  })

  it('removing the last section leaves an empty file', async () => {
    await writeFile(cfg, '[only]\ntype = sftp\nhost = 127.0.0.1\n', 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(cfg), 'config', 'dump'],
      results: [dumpResult({ only: { type: 'sftp', host: '127.0.0.1' } }), dumpResult({})],
    })
    await removeRemote(paths, mock, 'only')
    assert.equal(await readFile(cfg, 'utf-8'), '')
  })

  it('an absent remote throws RemoteNotFoundError', async () => {
    mock.addFixture({ command: RCLONE, args: [...rcloneBaseArgs(cfg), 'config', 'dump'], result: dumpResult({}) })
    await assert.rejects(removeRemote(paths, mock, 'ghost'), RemoteNotFoundError)
  })

  it('an encrypted config refuses the removal', async () => {
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(cfg), 'config', 'dump'],
      result: { stdout: '', stderr: 'Failed to load config file: unable to decrypt configuration\n', exitCode: 1 },
    })
    await assert.rejects(removeRemote(paths, mock, 'homelab'), ConfigEncryptedError)
  })

  it('a gate failure rolls the PREVIOUS bytes back', async () => {
    const seed = '[media]\ntype = webdav\nurl = https://x\n\n[homelab]\ntype = sftp\nhost = 127.0.0.1\n'
    await writeFile(cfg, seed, 'utf-8')
    mock.addFixture({
      command: RCLONE,
      args: [...rcloneBaseArgs(cfg), 'config', 'dump'],
      results: [
        dumpResult({ media: { type: 'webdav', url: 'https://x' }, homelab: { type: 'sftp', host: '127.0.0.1' } }),
        { stdout: '', stderr: 'config file corrupt: cannot parse\n', exitCode: 1 },
      ],
    })
    await assert.rejects(removeRemote(paths, mock, 'homelab'), RcloneConfigGateError)
    assert.equal(await readFile(cfg, 'utf-8'), seed)
  })
})

describe('rclone-config: normalizeOAuthToken (the OAuth paste, human-pass finding 2026-09-25)', () => {
  // `rclone authorize` prints the marker line, the JSON object, and the
  // closing marker. The helper is the daemon boundary of the same contract
  // the dialog's token field applies on blur (72-cloud.js).
  const TOKEN = '{"access_token":"ya29.x","token_type":"Bearer","refresh_token":"1//rt","expiry":"2026-09-25T00:00:00Z"}'

  it('a bare object is accepted VERBATIM', () => {
    const res = normalizeOAuthToken(TOKEN)
    assert.deepEqual(res, { ok: true, value: TOKEN })
    // whitespace around it is trimmed
    assert.deepEqual(normalizeOAuthToken(`  ${TOKEN}  `), { ok: true, value: TOKEN })
  })

  it('the marker lines are stripped — only what lies between them survives', () => {
    const pasted = `Paste the following into your remote machine --->\n${
      TOKEN}\n<---End paste`
    assert.deepEqual(normalizeOAuthToken(pasted), { ok: true, value: TOKEN })
  })

  it('a JSON-encoded string (the object wrapped in one pair of double quotes) is unwrapped once', () => {
    const quoted = `"${TOKEN.replace(/"/g, '\\"')}"`
    assert.deepEqual(normalizeOAuthToken(quoted), { ok: true, value: TOKEN })
    // a SECOND layer is left alone — and then refused (a string is not an object)
    const twice = `"${quoted.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    assert.equal(normalizeOAuthToken(twice).ok, false)
  })

  it('anything that is not a JSON object is refused, with the sentence ready', () => {
    for (const bad of ['gibberish', '123', '[1,2]', '"just a string"', TOKEN.slice(0, -1)]) {
      const res = normalizeOAuthToken(bad)
      assert.equal(res.ok, false, `expected '${bad}' refused`)
      assert.equal(typeof res.value, 'string')
    }
    // the empty field is the "(unchanged)" marker — nothing to validate
    assert.deepEqual(normalizeOAuthToken(''), { ok: true, value: '' })
    assert.equal(OAUTH_TOKEN_ERROR.includes('JSON block'), true)
  })

  it('answers EVERY case in the shared test vector (the UI\'s copy iterates the same file)', () => {
    const cases: { input: string, ok: boolean, value?: string }[] = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../shared/test-vectors/oauth-token-normalisation.json'), 'utf-8'),
    )
    assert.ok(cases.length >= 7, 'the vector covers the shapes the human pass found')
    for (const c of cases) {
      const res = normalizeOAuthToken(c.input)
      assert.equal(res.ok, c.ok, `ok for ${JSON.stringify(c.input)}`)
      if (c.value !== undefined)
        assert.equal(res.value, c.value, `value for ${JSON.stringify(c.input)}`)
    }
  })
})
