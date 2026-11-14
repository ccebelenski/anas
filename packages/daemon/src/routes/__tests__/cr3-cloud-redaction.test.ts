import type { Job } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { listSections, parseRcloneConf } from '../../parsers/rclone-conf.js'
import { createServer } from '../../server.js'
import { destinationChanges } from '../../services/cloud-retarget.js'
import { classifyOptionValue, RCLONE, rcloneBaseArgs, readConfig, remoteSecretValues, trimProviders } from '../../services/rclone-config.js'
import { maskSecretValues } from '../../services/secret-argv.js'

/**
 * cr3, third review: the redaction VIEW is an ALLOW-LIST (classifyOptionValue).
 * The reviewer's table — 47 stored values and 6 creates, each planting
 * distinctive secrets — goes through EVERY exit a Sys.Audit reader can reach
 * (the remotes list / edit prefill, a PUT's job result and the jobs list, the
 * saved Test's verdict with rclone echoing the stored section verbatim, the
 * run/preview/notification mask, a create's job result, the retarget 409's
 * from/to, a failed config dump's error), and NO secret, whole or a 4+
 * character piece, may appear at any of them.
 */

type Case = [string, string, string, string, string[]]
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\\nQzPem20ttAAAAbbbb\\n-----END OPENSSH PRIVATE KEY-----'
const C: Case[] = [
  ['u01', 'webdav', 'url', 'https://alice:QzPw01aa@dav.ex/r', ['QzPw01aa']],
  ['u02', 'webdav', 'url', 'https://alice:Qz%40Pw%3A02@dav.ex/', ['Qz%40Pw%3A02']],
  ['u03', 'webdav', 'url', 'https://alice:Qz@Pw03xx@dav.ex/', ['Qz@Pw03xx']],
  ['u04', 'webdav', 'url', 'https://alice:Qz:Pw04xx@dav.ex/', ['Qz:Pw04xx']],
  ['u05', 'webdav', 'url', 'http://alice:QzPw05bb@[::1]:8080/dav', ['QzPw05bb']],
  ['u06', 'webdav', 'url', 'HTTPS://alice:QzPw06cc@h/', ['QzPw06cc']],
  ['u07', 'http', 'url', 'https://QzTok07dd@h/', ['QzTok07dd']],
  ['u08', 'http', 'url', 'https://h/p?token=QzTok08ee&sig=QzSig08ff&X-Amz-Signature=QzAmz08gg', ['QzTok08ee', 'QzSig08ff', 'QzAmz08gg']],
  ['u09', 'http', 'url', 'https://h/p?QzBare09hh', ['QzBare09hh']],
  ['u10', 'http', 'url', 'https://h/p#access_token=QzFrag10ii', ['QzFrag10ii']],
  ['u11', 'webdav', 'url', 'https://alice:Qz/Pw11jj@h/', ['Qz/Pw11jj']],
  ['u12', 'webdav', 'url', 'https://alice:Qz?Pw12kk@h/', ['Qz?Pw12kk']],
  ['u13', 'webdav', 'url', 'https://alice:Qz#Pw13ll@h/', ['Qz#Pw13ll']],
  ['u14', 'webdav', 'url', 'https://u:QzPw14mm@h/?a=QzQ14nn#f', ['QzPw14mm', 'QzQ14nn']],
  ['e15', 's3', 'endpoint', 'https://AK:QzPw15oo@minio:9000', ['QzPw15oo']],
  ['e41', 's3', 'endpoint', 'https://h/?X-Amz-Credential=QzCred41UU', ['QzCred41UU']],
  ['a16', 'alias', 'remote', ':s3,secret_access_key=QzSk16pp:b', ['QzSk16pp']],
  ['a17', 'alias', 'remote', ':s3,secret_access_key=\'QzSk17q,q:qq\':b', ['QzSk17q,q:qq']],
  ['a18', 'alias', 'remote', ':s3,secret_access_key=\'QzSk18rr\'\'QzQuote18\':b', ['QzSk18rr\'QzQuote18']],
  ['a19', 'alias', 'remote', ':s3,secret_access_key=\'QzSk19ss QzSpace19\':b', ['QzSk19ss QzSpace19']],
  ['a20', 'alias', 'remote', `:sftp,host=h,key_pem='${PEM}':/`, [PEM]],
  ['a21', 'alias', 'remote', ':s3,secret_access_key=\'QzUnbal21uu:b', ['QzUnbal21uu']],
  ['a22', 'alias', 'remote', ':crypt,remote=\':s3,secret_access_key=QzDeep22vv:b\',password=QzCpw22ww,password2=QzSalt22xx:', ['QzDeep22vv', 'QzCpw22ww', 'QzSalt22xx']],
  ['a23', 'alias', 'remote', ':crypt,password=QzCpw23yy,remote=\':alias,remote=":s3,secret_access_key=QzDeep23zz:b":\':', ['QzCpw23yy', 'QzDeep23zz']],
  ['a24', 'alias', 'remote', ':crypt,password=QzCpw24AA,remote=\':alias,remote=":crypt,password=QzCpw24BB,remote=\'\'/x\'\':":\':', ['QzCpw24AA', 'QzCpw24BB']],
  ['a25', 'alias', 'remote', 'mys3,secret_access_key=QzOver25DD:bucket', ['QzOver25DD']],
  ['a26', 'alias', 'remote', ':webdav,url=\'https://u:QzPw26EE@h/\':p', ['QzPw26EE']],
  ['a27', 'alias', 'remote', ':webdav,url=https://u:QzPw27FF@h/:p', ['QzPw27FF']],
  ['a28', 'alias', 'remote', ':crypt,remote=x:,password=QzCpw28GG:', ['QzCpw28GG']],
  ['a29', 'alias', 'remote', ':ftp,host=h,pass=QzPw29HH QzPw29II:/', ['QzPw29HH', 'QzPw29II']],
  ['a42', 'alias', 'remote', '":s3,secret_access_key=QzWhole42VV:b"', ['QzWhole42VV']],
  ['a43', 'alias', 'remote', '":s3,secret_access_key=\'QzMix43 QzMix43WW\':b"', ['QzMix43 QzMix43WW']],
  ['a45', 'alias', 'remote', ':s3,secret_access_key=QzEq45ZZ=abcd:b', ['QzEq45ZZ=abcd']],
  ['a46', 'alias', 'remote', ':s3,sse_customer_key_base64=QzSse46ab:b', ['QzSse46ab']],
  ['a47', 'crypt', 'remote', ':crypt,remote=gt:x,password2=QzSalt47cd:', ['QzSalt47cd']],
  ['a48', 'alias', 'remote', 'mycrypt,password2=QzOver48ef:', ['QzOver48ef']],
  ['a49', 'alias', 'remote', ':s3,secret_access_key="QzDq49gh""QzDq49ij":b', ['QzDq49gh"QzDq49ij']],
  ['n31', 'union', 'upstreams', 'a=:s3,secret_access_key=QzUp31JJ:b c=:s3,secret_access_key=QzUp31KK:d', ['QzUp31JJ', 'QzUp31KK']],
  ['n32', 'union', 'upstreams', '"c=:s3,secret_access_key=\'QzUp32 QzUp32LL\':d" other:x', ['QzUp32 QzUp32LL']],
  ['n33', 'union', 'upstreams', 'remote:path:ro :s3,secret_access_key=QzUp33MM:b:ro', ['QzUp33MM']],
  ['n34', 'combine', 'upstreams', 'name=:s3,secret_access_key=QzUp34NN:', ['QzUp34NN']],
  ['n35', 'union', 'upstreams', 'mys3,secret_access_key=QzUp35OO:b gt:x', ['QzUp35OO']],
  ['n36', 'union', 'remotes', ':s3,secret_access_key=QzRem36PP:b', ['QzRem36PP']],
  ['n50', 'union', 'upstreams', 'gt:x mys3,session_token=QzUp50QR:b:ro', ['QzUp50QR']],
  ['u44', 'webdav', 'url', 'https://alice:QzPw44XX@h1/ https://bob:QzPw44YY@h2/', ['QzPw44XX', 'QzPw44YY']],
]
const CREATE: [string, string, Record<string, string>, string[]][] = [
  ['c18', 'alias', { remote: ':s3,secret_access_key=\'QzNew18rr\'\'QzNewQuote18\':b' }, ['QzNew18rr\'QzNewQuote18']],
  ['c19', 'alias', { remote: ':s3,secret_access_key=\'QzNew19ss QzNewSpace19\':b' }, ['QzNew19ss QzNewSpace19']],
  ['c21', 'alias', { remote: ':s3,secret_access_key=\'QzNewUnbal21:b' }, ['QzNewUnbal21']],
  ['c25', 'alias', { remote: 'mys3,secret_access_key=QzNewOver25:b' }, ['QzNewOver25']],
  ['c11', 'webdav', { url: 'https://alice:QzNew/Pw11@h/' }, ['QzNew/Pw11']],
  ['c09', 'http', { url: 'https://h/p?QzNewBare09' }, ['QzNewBare09']],
]

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/rclone/providers-1.60.1.json')
const PROVIDERS = await readFile(FIXTURE, 'utf-8')

/** Every planted secret found whole, or any 4+ piece of it carrying the Qz marker (the reviewer's rule). */
function leakIn(text: string, secrets: string[]): string[] {
  const hits: string[] = []
  for (const s of secrets) {
    if (text.includes(s)) {
      hits.push(`WHOLE:${JSON.stringify(s)}`)
      continue
    }
    let best = ''
    for (let L = s.length - 1; L >= 4 && !best; L--) {
      for (let i = 0; i + L <= s.length; i++) {
        const sub = s.slice(i, i + L)
        if (sub.includes('Qz') && /[a-z]{2}\d|\d[a-z]{2}|[A-Z]{2}$|Qz\w{2}/.test(sub) && text.includes(sub)) {
          best = sub
          break
        }
      }
    }
    if (best)
      hits.push(`PART:${JSON.stringify(best)}`)
  }
  return hits
}

describe('cr3 third review: the reviewer\'s 47 + 6 values at every Sys.Audit exit', () => {
  let dir: string
  let configFile: string
  let server: ReturnType<typeof createServer>
  let mock: MockExecutor
  let echo = ''
  let failDump = false
  let saved: string | undefined
  const leaks: string[] = []
  const ALL: [string, string[]][] = [
    ...C.map(c => [c[0], c[4]] as [string, string[]]),
    ['mycrypt', ['QzTopCpw37QQ', 'QzTopSalt37RR']],
    ['hdr', ['QzHdr39SS']],
  ]
  const hdr = (priv: string) => ({ 'x-anas-user': 'auditor@pve', 'x-anas-user-uid': '0', 'x-anas-request-id': randomUUID(), 'content-type': 'application/json', 'x-anas-privileges': priv })
  const AUD = 'Sys.Audit'
  const MOD = 'Sys.Audit,Sys.Modify'
  function record(exit: string, name: string, text: string, secrets: string[]): void {
    for (const h of leakIn(text, secrets))
      leaks.push(`${name} @ ${exit}: ${h}`)
  }
  async function wait(id: string): Promise<Job> {
    for (let i = 0; i < 400; i++) {
      const j = (await server.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: hdr(AUD) })).json().job as Job
      if (j.status !== 'running' && j.status !== 'queued')
        return j
      await new Promise(r => setTimeout(r, 10))
    }
    throw new Error('job did not finish')
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cr3-redact-'))
    configFile = join(dir, 'rclone.conf')
    let conf = '[gt]\ntype = local\n\n[mys3]\ntype = s3\nprovider = AWS\n\n[mycrypt]\ntype = crypt\nremote = gt:x\npassword = QzTopCpw37QQ\npassword2 = QzTopSalt37RR\n\n[hdr]\ntype = webdav\nurl = https://h/\nheaders = "Authorization","Bearer QzHdr39SS"\n\n'
    for (const [s, t, k, v] of C)
      conf += `[${s}]\ntype = ${t}\n${k} = ${v}\n\n`
    await writeFile(configFile, conf, 'utf-8')
    saved = process.env.ANAS_RCLONE_CONFIG
    process.env.ANAS_RCLONE_CONFIG = configFile
    server = createServer({ mock: true, logger: false })
    mock = (server as unknown as { executor: MockExecutor }).executor
    mock.clearFixtures()
    const base = rcloneBaseArgs(configFile)
    mock.addFixture({ command: RCLONE, args: ['version'], result: { stdout: 'rclone v1.60.1-DEV\n', stderr: '', exitCode: 0 } })
    mock.addFixture({ command: RCLONE, args: [...base, 'config', 'providers'], result: { stdout: PROVIDERS, stderr: '', exitCode: 0 } })
    const orig = mock.exec.bind(mock)
    mock.exec = async (cmd: string, args: string[], o?: ExecOptions): Promise<ExecResult> => {
      if (cmd === RCLONE && args.at(-2) === 'config' && args.at(-1) === 'dump') {
        const text = await readFile(configFile, 'utf-8').catch(() => '')
        if (failDump)
          return { stdout: '', stderr: `Failed to load config file: ${text.replace(/\n/g, ' | ')}`, exitCode: 1 }
        const dump: Record<string, Record<string, string>> = {}
        for (const s of listSections(parseRcloneConf(text)))
          dump[s.name] = { ...s.values }
        return { stdout: JSON.stringify(dump), stderr: '', exitCode: 0 }
      }
      if (cmd === RCLONE && args.at(-2) === 'obscure')
        return { stdout: 'mock-obscured\n', stderr: '', exitCode: 0 }
      if (cmd === '/usr/bin/timeout' && args.includes(RCLONE))
        return { stdout: '', stderr: `ERROR : ${echo}\nFailed to lsjson: couldn't list: ${echo}`, exitCode: 1 }
      return orig(cmd, args, o)
    }
  })

  after(async () => {
    await server.close()
    if (saved === undefined)
      delete process.env.ANAS_RCLONE_CONFIG
    else process.env.ANAS_RCLONE_CONFIG = saved
    await rm(dir, { recursive: true, force: true })
  })

  it('every value is classified, and the counts are the ones the report states', () => {
    const counts: Record<string, number> = { 'plain': 0, 'url-redacted': 0, 'hidden': 0 }
    for (const [, , k, v] of C)
      counts[classifyOptionValue(k, v).cls]!++
    for (const [, , o] of CREATE) {
      for (const [k, v] of Object.entries(o))
        counts[classifyOptionValue(k, v).cls]!++
    }
    // 45 stored values (the reviewer's other two, mycrypt and hdr, are secret OPTIONS: write-only) + 6 creates.
    assert.deepEqual(counts, { 'plain': 0, 'url-redacted': 14, 'hidden': 37 })
  })

  it('zero leaks at every exit', async () => {
    // 1. the remotes list (and the edit prefill, read from it)
    const list = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: hdr(AUD) })
    assert.equal(list.statusCode, 200, list.body)
    const remotes = (list.json() as { data: { remotes: { name: string }[] } }).data.remotes
    const byName = new Map(remotes.map(r => [r.name, r]))
    for (const [name, secrets] of ALL)
      record('GET /cloud/remotes', name, JSON.stringify(byName.get(name)), secrets)

    // 2. a PUT's job result; the saved Test's verdict (rclone echoing the
    //    stored section verbatim); the run/preview/notification mask
    const unrelated: Record<string, Record<string, string>> = { webdav: { vendor: 'other' }, http: { no_slash: 'true' }, s3: { region: 'eu-west-1' }, crypt: { filename_encryption: 'off' }, union: { cache_time: '121' } }
    for (const [name, secrets] of ALL) {
      const type = name === 'mycrypt' ? 'crypt' : name === 'hdr' ? 'webdav' : C.find(c => c[0] === name)![1]
      const opts = unrelated[type]
      if (opts) {
        const put = await server.inject({ method: 'PUT', url: `/v1/cloud/remotes/${name}`, headers: hdr(MOD), payload: JSON.stringify({ options: opts }) })
        record('PUT door', name, put.body, secrets)
        if (put.statusCode === 202)
          record('PUT job result', name, JSON.stringify(await wait(put.json().job.id)), secrets)
      }
      const sec = listSections(parseRcloneConf(await readFile(configFile, 'utf-8'))).find(s => s.name === name)!
      echo = Object.entries(sec.values).map(([k, v]) => `${k}=${v}`).join(' ')
      const t = await server.inject({ method: 'POST', url: '/v1/cloud/remotes/test', headers: hdr(AUD), payload: JSON.stringify({ name }) })
      record('saved Test', name, t.statusCode === 202 ? JSON.stringify(await wait(t.json().job.id)) : t.body, secrets)
      record('run/preview/notify mask', name, maskSecretValues(echo, await remoteSecretValues(configFile, name)), secrets)
    }
    record('GET /jobs', '(all)', (await server.inject({ method: 'GET', url: '/v1/jobs', headers: hdr(AUD) })).body, ALL.flatMap(a => a[1]))

    // 3. creates of the shapes that used to fail open: their job results
    for (const [name, type, options, secrets] of CREATE) {
      const r = await server.inject({ method: 'POST', url: '/v1/cloud/remotes', headers: hdr(MOD), payload: JSON.stringify({ name, type, options }) })
      record('POST door', name, r.body, secrets)
      if (r.statusCode === 202)
        record('POST job result', name, JSON.stringify(await wait(r.json().job.id)), secrets)
      ALL.push([name, secrets])
    }
    record('GET /jobs (after creates)', '(all)', (await server.inject({ method: 'GET', url: '/v1/jobs', headers: hdr(AUD) })).body, ALL.flatMap(a => a[1]))

    // 4. the retarget 409's from/to
    const providers = trimProviders(JSON.parse(PROVIDERS))
    const read = await readConfig({ configFile }, mock, providers, [])
    const raw = new Map(listSections(parseRcloneConf(read.text)).map(s => [s.name, s.values]))
    for (const r of read.remotes) {
      const k = ['url', 'remote', 'upstreams', 'remotes', 'endpoint'].find(x => r.options[x] !== undefined)
      if (!k)
        continue
      const ch = destinationChanges(r, { [k]: 'gt:elsewhere' }, providers, raw.get(r.name))
      record('retarget from/to', r.name, JSON.stringify(ch), ALL.find(a => a[0] === r.name)?.[1] ?? [])
    }

    // 5. a failed config dump's error
    failDump = true
    const fd = await server.inject({ method: 'GET', url: '/v1/cloud/remotes', headers: hdr(AUD) })
    failDump = false
    for (const [name, secrets] of ALL)
      record('failed config dump', name, fd.body, secrets)

    assert.deepEqual(leaks, [])
  })
})

describe('cr3 third review (D2): an unsaved Test\'s verdict conceals what the DIALOG typed', () => {
  it('rclone 1.75\'s captured echo of a token userinfo and query values (t/review3/p4-capture.txt) is masked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-redact-p4-'))
    try {
      const configFile = join(dir, 'rclone.conf')
      await writeFile(configFile, '', 'utf-8')
      const URL = 'http://QzUserTok7@127.0.0.1:9/dav?token=QzTestTok1&sig=QzTestSig2'
      // The captured stderr (rclone 1.75.2 against a closed local port), with its timestamps.
      const ECHO = `2026/11/14 14:49:21 ERROR : error listing: couldn't list files: Propfind "${URL}/": dial tcp 127.0.0.1:9: connect: connection refused\n`
        + `2026/11/14 14:49:21 NOTICE: Failed to lsjson with 2 errors: last error was: error in ListJSON: couldn't list files: Propfind "${URL}/": dial tcp 127.0.0.1:9: connect: connection refused\n`
      const masked = maskSecretValues(ECHO, await remoteSecretValues(configFile, { url: URL }))
      for (const s of ['QzUserTok7', 'QzTestTok1', 'QzTestSig2'])
        assert.ok(!masked.includes(s), `${s} in ${masked}`)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
