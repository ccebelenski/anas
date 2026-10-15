import type { StatusSummary } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import type { CommandExecutor, ExecOptions, ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CommandTimeoutError, runInLane } from '../../executor/deadline.js'
import { MockExecutor as Mock } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { sharePathWarnings } from '../../routes/dashboard.js'
import { createServer } from '../../server.js'
import { probeSharePath, probeSharePaths, sharePathFields, sharePathProbeArgs } from '../share-path.js'

/**
 * cr.35 (WAVE3-DESIGN §6.1 gap 1): a share's path is checked by a child
 * process under `timeout`, through the executor — never by a `statSync` on
 * the daemon's event loop, which a dead hard NFS mount blocks in the kernel
 * (and every request on the node with it). Every stat answer below is a case
 * of the captured `timeout 2 stat -f` matrix (fixtures/mounts/stat-f-exit-codes.txt).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const TIMEOUT = '/usr/bin/timeout'

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}

/** An executor that answers one result and records the options it was given. */
function recording(result: ExecResult | Error): { exec: CommandExecutor, seen: Array<{ command: string, args: string[], opts?: ExecOptions }> } {
  const seen: Array<{ command: string, args: string[], opts?: ExecOptions }> = []
  const exec = {
    exec: async (command: string, args: string[], opts?: ExecOptions) => {
      seen.push({ command, args, opts })
      if (result instanceof Error)
        throw result
      return result
    },
  } as unknown as CommandExecutor
  return { exec, seen }
}

describe('cr.35 probeSharePath: four outcomes, none of them a guess', () => {
  it('runs `timeout -k 1 2 stat -f -c %t -- <path>` under the C locale', async () => {
    const { exec, seen } = recording(mockFixtures.statF('ext4 root (healthy local)'))
    assert.deepEqual(await probeSharePath(exec, '/tank/media'), { state: 'exists' })
    assert.deepEqual(seen, [{
      command: TIMEOUT,
      args: ['-k', '1', '2', '/usr/bin/stat', '-f', '-c', '%t', '--', '/tank/media'],
      opts: { env: { LC_ALL: 'C' } },
    }])
  })

  it('a missing path (exit 1, "No such file or directory") is `missing`', async () => {
    const { exec } = recording(mockFixtures.statF('nonexistent path'))
    assert.deepEqual(await probeSharePath(exec, '/gone'), { state: 'missing' })
  })

  it('a dead hard NFS mount (timeout\'s 124 after 2 s) is `not-answering`, never `missing`', async () => {
    const { exec } = recording(mockFixtures.statF('nfs-server STOPPED; hard mount -> stat hangs -> timeout kills it'))
    const probe = await probeSharePath(exec, '/mnt/anas-nfs')
    assert.equal(probe.state, 'not-answering')
    assert.match(probe.detail ?? '', /did not return within 2 s/)
  })

  it('a stat stuck past `timeout` itself (the executor gave up on it) is `not-answering` too', async () => {
    const stuck = new CommandTimeoutError(TIMEOUT, sharePathProbeArgs('/mnt/x'), 'request', 8_000, true)
    const { exec } = recording(stuck)
    const probe = await probeSharePath(exec, '/mnt/x')
    assert.equal(probe.state, 'not-answering')
    assert.match(probe.detail ?? '', /stuck in the kernel after 8 s/)
  })

  it('ESTALE (exit 1, another error) is `unreadable` with stat\'s own words — not missing, not fine', async () => {
    const { exec } = recording(mockFixtures.statF('ESTALE: held CWD in a subdir whose server-side inode was removed'))
    assert.deepEqual(await probeSharePath(exec, '/mnt/anas-nfs/x'), {
      state: 'unreadable',
      detail: 'stat: cannot read file system information for \'.\': Stale file handle',
    })
  })

  it('a stat that could not start is `unreadable`, and the probe never throws', async () => {
    const { exec } = recording(Object.assign(new Error('spawn /usr/bin/timeout ENOENT'), { code: 'ENOENT' }))
    assert.deepEqual(await probeSharePath(exec, '/x'), { state: 'unreadable', detail: 'spawn /usr/bin/timeout ENOENT' })
  })

  it('the wire fields: pathExists only where it is a fact', () => {
    assert.deepEqual(sharePathFields({ state: 'exists' }), { pathState: 'exists', pathExists: true })
    assert.deepEqual(sharePathFields({ state: 'missing' }), { pathState: 'missing', pathExists: false })
    assert.deepEqual(sharePathFields({ state: 'not-answering', detail: 'x' }), { pathState: 'not-answering' })
    assert.deepEqual(sharePathFields({ state: 'unreadable', detail: 'x' }), { pathState: 'unreadable' })
  })

  it('many paths: each checked once, in parallel, under the request lane\'s wrapper budget', async () => {
    const mock = new Mock().addFixture({ command: TIMEOUT, result: mockFixtures.statF('ext4 root (healthy local)') })
    const out = await runInLane({ lane: 'request' }, () => probeSharePaths(mock, ['/a', '/b', '/a']))
    assert.deepEqual([...out.keys()], ['/a', '/b'])
    assert.equal(mock.calls.length, 2)
    // `timeout -k 1 2` → the executor's deadline is the wrapper's 3 s + 5 s.
    assert.deepEqual(mock.deadlines.map(d => [d.budgetMs, d.source]), [[8_000, 'wrapper'], [8_000, 'wrapper']])
  })

  it('no share route stats a path on the event loop any more', () => {
    for (const rel of ['routes/shares-smb.ts', 'routes/shares-nfs.ts', 'routes/dashboard.ts']) {
      const text = readFileSync(join(__dirname, '..', '..', rel), 'utf-8')
      assert.doesNotMatch(text, /\bstatSync\b|\blstatSync\b/, rel)
    }
  })
})

describe('cr.35 how the callers present a path that does not answer', () => {
  let server: ReturnType<typeof createServer> | undefined
  let dir: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (dir)
      rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('the dashboard: a `share` warning card that says the path is not answering (a hung mount), one that says missing for a stale share', async () => {
    dir = mkdtempSync(join(tmpdir(), 'anas-sharepath-'))
    const smbConfPath = join(dir, 'smb.conf')
    writeFileSync(smbConfPath, ['[global]', '\tworkgroup = WORKGROUP', '', '[media]', '\tpath = /mnt/anas-nfs/media', '', '[old]', '\tpath = /tank/old', ''].join('\n'))
    server = createServer({ mock: true, logger: false, smbConfPath })
    await server.ready()
    const mock = (server as unknown as { executor: MockExecutor }).executor
    mock.prependFixture({ command: TIMEOUT, args: sharePathProbeArgs('/mnt/anas-nfs/media'), result: mockFixtures.statF('nfs-server STOPPED; hard mount -> stat hangs -> timeout kills it') })
    mock.prependFixture({ command: TIMEOUT, args: sharePathProbeArgs('/tank/old'), result: mockFixtures.statF('nonexistent path') })
    const res = await server.inject({ method: 'GET', url: '/v1/status', headers: IDENTITY_HEADERS })
    assert.equal(res.statusCode, 200)
    const summary = (res.json() as { data: StatusSummary }).data
    const cards = summary.warnings.filter(w => w.category === 'share')
    assert.deepEqual(cards.map(c => c.ref).sort(), ['media', 'old'])
    assert.match(cards.find(c => c.ref === 'media')!.message, /^SMB share 'media': the path \/mnt\/anas-nfs\/media is not answering \(the stat did not return within 2 s\)/)
    assert.equal(cards.find(c => c.ref === 'old')!.message, 'SMB share \'old\' points to a missing path /tank/old')
    // The share count is unaffected by the checks.
    assert.equal(summary.shares.smbCount, 2)
  })

  it('the card wording per outcome (NFS exports name the path)', () => {
    assert.deepEqual(sharePathWarnings('nfs', '/srv/a', '/srv/a', { state: 'exists' }), [])
    assert.equal(sharePathWarnings('nfs', '/srv/a', '/srv/a', { state: 'missing' })[0].message, 'NFS export path /srv/a no longer exists')
    assert.match(sharePathWarnings('nfs', '/srv/a', '/srv/a', { state: 'unreadable', detail: 'stat: … Stale file handle' })[0].message, /^NFS export \/srv\/a: the path \/srv\/a could not be checked \(stat: … Stale file handle\)$/)
  })
})
