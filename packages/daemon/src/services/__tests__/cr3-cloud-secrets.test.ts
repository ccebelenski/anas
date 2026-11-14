import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyOptionValue, HIDDEN_VALUE, isSecretKey, remoteSecretValuesFromText, remoteSectionIdentity, remotesReferencing, restoreRedacted, trimProviders } from '../rclone-config.js'

/**
 * cr3 CLOUD-H2 (review 2026-11-14): the secret rule against rclone's OWN
 * catalogue. The name rule (`...pass|password|secret|token|key`) plus the
 * explicit name set is a heuristic; this test reads the captured 1.60.1
 * catalogue and requires every option whose help text names a credential to
 * be either a secret or on the closed list of names that are NOT secrets for
 * a stated reason. A new capture that brings a new credential-shaped option
 * fails here until someone decides which side it belongs on.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone/providers-1.60.1.json')
interface RawOption { Name: string, Help?: string, Type?: string, IsPassword?: boolean }
const RAW: { Name: string, Options?: RawOption[] }[] = JSON.parse(await readFile(FIXTURE, 'utf-8'))

/** A help text's first paragraph names a credential. */
const CREDENTIAL_HELP_RE = /private key|credential|\btoken\b|secret|password|passphrase|authori[sz]ation|cookie|api key|signature/i

/**
 * The closed list: credential-SHAPED names that are not the credential, each
 * with its reason (rclone-config.ts SECRET_NAMES's doc says the same).
 */
const NOT_SECRET: Record<string, string> = {
  application_credential_id: 'an identifier (swift)',
  application_credential_name: 'an identifier (swift)',
  username: 'an identifier',
  authorization_expiry: 'a time (sugarsync)',
  token_expiry: 'a time (filefabric)',
  download_auth_duration: 'a duration (b2)',
  token_url: 'an endpoint',
  key_file: 'a path to the key, not the key',
  service_account_file: 'a path to the credentials, not the credentials',
  service_principal_file: 'a path to the credentials, not the credentials',
  shared_credentials_file: 'a path to the credentials, not the credentials',
  profile: 'a profile NAME inside the shared credentials file',
  bearer_token_command: 'a command; the token it prints is never stored',
  // From the WHOLE help text (review of cr3, fix 4):
  access_key_id: 'an identifier (its help mentions "runtime credentials")',
  data_transfer_protection: 'an enum (hdfs: authentication|integrity|privacy)',
  download_url: 'an endpoint (its help mentions the Authorization header)',
  impersonate: 'a user to impersonate (dropbox), not a credential',
  test_mode: 'a debugging flag (b2)',
  url: 'an endpoint; a password in its userinfo is REDACTED in every view (redactOptionValue), the URL stays readable',
}

describe('cr3 CLOUD-H2: the secret rule over the 1.60.1 catalogue', () => {
  it('the review\'s names are secrets: key_pem, service_account_credentials, authorization, the SSE-C key forms, headers', () => {
    for (const name of ['key_pem', 'service_account_credentials', 'authorization', 'sse_customer_key_base64', 'sse_customer_key_md5', 'headers', 'sas_url', 'set_env'])
      assert.equal(isSecretKey(name), true, `expected '${name}' secret`)
  })

  it('every credential-describing option is a secret or on the closed NOT_SECRET list, and the list holds nothing stale', () => {
    const providers = trimProviders(RAW)
    const unclassified: string[] = []
    const used = new Set<string>()
    for (const backend of RAW) {
      for (const raw of backend.Options ?? []) {
        if (raw.Type === 'bool' || raw.IsPassword)
          continue
        // Review of cr3, fix 4: the WHOLE help text, not its first paragraph.
        const help = raw.Help ?? ''
        if (!CREDENTIAL_HELP_RE.test(help))
          continue
        const option = providers.find(p => p.name === backend.Name)?.options.find(o => o.name === raw.Name)
        if (isSecretKey(raw.Name, option))
          continue
        if (Object.hasOwn(NOT_SECRET, raw.Name)) {
          used.add(raw.Name)
          continue
        }
        unclassified.push(`${backend.Name}.${raw.Name}: ${help.replace(/\s+/g, ' ').slice(0, 80)}`)
      }
    }
    assert.deepEqual(unclassified, [], 'credential-describing options that are neither secret nor on the closed list')
    assert.deepEqual(Object.keys(NOT_SECRET).filter(n => !used.has(n)), [], 'NOT_SECRET names no option of the capture describes')
  })

  it('the catalogue the dialog renders marks them secret (write-only fields)', () => {
    const providers = trimProviders(RAW)
    const opt = (backend: string, name: string) => providers.find(p => p.name === backend)?.options.find(o => o.name === name)
    assert.equal(opt('sftp', 'key_pem')?.secret, true)
    assert.equal(opt('sugarsync', 'authorization')?.secret, true)
    assert.equal(opt('webdav', 'headers')?.secret, true)
    assert.equal(opt('s3', 'sse_customer_key_base64')?.secret, true)
  })

  it('a key_pem never enters the bound identity: a rotated key is the same remote', () => {
    const a = remoteSectionIdentity('[box]\ntype = sftp\nhost = h\nkey_pem = AAA\n', 'box')
    const b = remoteSectionIdentity('[box]\ntype = sftp\nhost = h\nkey_pem = BBB\n', 'box')
    assert.ok(a !== null)
    assert.equal(a, b)
  })
})

describe('third review: the view is an ALLOW-LIST (classifyOptionValue)', () => {
  const H = HIDDEN_VALUE
  const cls = (k: string, v: string) => classifyOptionValue(k, v)

  it('PLAIN: a reference of name:path entries / absolute paths (with the union and combine decorations), a URL without credentials, an ordinary value', () => {
    for (const [k, v] of [
      ['remote', 'gt:x/y'],
      ['remote', 'gt:'],
      ['remote', '/mnt/data'],
      ['upstreams', 'gt:a gt:b:ro /mnt/disk1:nc'],
      ['upstreams', 'docs=gt:d photos=dst:/p'],
      ['url', 'https://dav.example.com:8443/remote.php/webdav/'],
      ['endpoint', 'http://[::1]:9000'],
      ['region', 'eu-west-1'],
      ['provider', 'AWS'],
      ['chunk_size', '5Mi'],
    ] as const)
      assert.deepEqual(cls(k, v), { cls: 'plain', view: v, conceals: [] }, `${k}=${v}`)
  })

  it('URL-REDACTED: userinfo as ONE marker, query and fragment as ONE marker', () => {
    assert.equal(cls('url', 'https://alice:pw0005@dav.example.com/x').view, 'https://[secret]@dav.example.com/x')
    assert.equal(cls('url', 'https://TOKEN123@h.example/p').view, 'https://[secret]@h.example/p')
    assert.equal(cls('url', 'https://alice:raw@tail@dav.example.com/x').view, 'https://[secret]@dav.example.com/x', 'the userinfo ends at the LAST @')
    assert.equal(cls('url', 'https://h.example/c?sv=2020&sig=SIGSECRET#frag').view, 'https://h.example/c?[secret]')
    assert.equal(cls('url', 'https://h/p#access_token=FRAG10ii').view, 'https://h/p?[secret]', 'a fragment rides the query marker')
    const c = cls('url', 'https://u:PW14mm@h/?a=Q14nn#f')
    for (const s of ['u:PW14mm', 'PW14mm', 'Q14nn'])
      assert.ok(c.conceals.includes(s), `${s} in ${JSON.stringify(c.conceals)}`)
  })

  it('HIDDEN, whole: inline settings, an override on a named remote, quotes, two URLs, a URL that does not parse strictly', () => {
    for (const [k, v] of [
      ['remote', ':s3,secret_access_key=SK:b'],
      ['remote', 'mys3,secret_access_key=OVER:bucket'],
      ['remote', 'mys3,region=eu-west-1:bucket'],
      ['remote', '":s3,secret_access_key=X:b"'],
      ['remote', 'gt:x y'],
      ['upstreams', 'a=:s3,secret_access_key=A:b c=gt:d'],
      ['upstreams', 'gt:x mys3,session_token=T:b:ro'],
      ['url', 'https://alice:Qz/Pw11jj@h/'],
      ['url', 'https://a:p@h1/ https://b:q@h2/'],
      ['url', ':webdav,url=https://u:p@h/'],
      ['description', 'x,secret_access_key=y'],
      ['description', ':inline'],
    ] as const) {
      const c = cls(k, v)
      assert.equal(c.cls, 'hidden', `${k}=${v}`)
      assert.equal(c.view, H)
      assert.ok(c.conceals.includes(v), 'the whole value is masked')
    }
    assert.ok(cls('remote', ':s3,secret_access_key=QzSk16pp:b').conceals.includes('QzSk16pp'), 'and every 4+ token of it')
  })

  it('the output mask carries what every view conceals', () => {
    const values = remoteSecretValuesFromText([
      '[dav]',
      'type = webdav',
      'url = https://alice:SECRETURLPW@dav.example.com/?sig=QUERYTOKEN123',
      '',
      '[c]',
      'type = alias',
      'remote = :crypt,remote=\'w:x\',password=OBSCPW1,password2=OBSSALT2:',
      '',
      '[t]',
      'type = http',
      'url = https://TOKENUSER9@h/',
      '',
    ].join('\n'))
    for (const v of ['SECRETURLPW', 'QUERYTOKEN123', 'OBSCPW1', 'OBSSALT2', 'TOKENUSER9'])
      assert.ok(values.includes(v), `${v} in ${JSON.stringify(values)}`)
  })

  it('restore: a view sent back UNCHANGED keeps the stored value; anything else is refused ("re-enter")', () => {
    const url = 'https://alice:pw0005@dav.example.com/x?sig=S1'
    assert.equal(restoreRedacted('url', 'https://[secret]@dav.example.com/x?[secret]', url), url)
    assert.throws(() => restoreRedacted('url', 'https://[secret]@dav.example.com/moved?[secret]', url), /re-enter the whole value of 'url'/)
    assert.throws(() => restoreRedacted('url', 'https://[secret]@h/', 'https://h/'), /re-enter the whole value/)
    const inline = 'a=:s3,secret_access_key=SKAAAA:b c=:s3,secret_access_key=SKCCCC:d'
    assert.equal(restoreRedacted('upstreams', H, inline), inline, 'a hidden value kept whole')
    assert.throws(() => restoreRedacted('upstreams', `${H} gt:x`, inline), /re-enter the whole value of 'upstreams'/)
    assert.equal(restoreRedacted('url', 'https://alice:newpw@dav.example.com/x', url), 'https://alice:newpw@dav.example.com/x', 'a typed value replaces')
  })

  it('the bound identity: a URL credential rotation is the same remote; any change to a HIDDEN value is another', () => {
    assert.equal(
      remoteSectionIdentity('[d]\ntype = webdav\nurl = https://a:one@h/?sig=1\n', 'd'),
      remoteSectionIdentity('[d]\ntype = webdav\nurl = https://a:two@h/?sig=2\n', 'd'),
    )
    assert.notEqual(
      remoteSectionIdentity('[d]\ntype = alias\nremote = :s3,secret_access_key=A:b\n', 'd'),
      remoteSectionIdentity('[d]\ntype = alias\nremote = :s3,secret_access_key=A:c\n', 'd'),
    )
  })

  it('(6) a named-remote override names the remote before the first , or : — never a parameter value', () => {
    const remotes: { name: string, type: string, options: Record<string, string>, secretsSet: string[] }[] = [
      { name: 'mys3', type: 's3', options: {}, secretsSet: [] },
      { name: 'ov', type: 'alias', options: { remote: 'mys3,region=eu-west-1:bucket' }, secretsSet: [] },
    ]
    assert.deepEqual(remotesReferencing(remotes, 'mys3'), ['ov'])
    assert.deepEqual(remotesReferencing(remotes, 'eu-west-1'), [])
  })
})
