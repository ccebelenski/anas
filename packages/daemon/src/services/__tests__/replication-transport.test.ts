import type { RemotesPaths } from '../replication-remotes.js'
import type { ResolvedLocation, TransportConfig } from '../replication-transport.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { writeRemotes } from '../replication-remotes.js'
import { buildSshArgv, createTransport, readMembers, remoteShellWord } from '../replication-transport.js'

const SSH = '/usr/bin/ssh'

const MEMBERS = JSON.stringify({
  nodename: 'node1',
  nodelist: { node1: { id: 1, online: 1 }, node2: { id: 2, online: 1 }, node3: { id: 3, online: 1 } },
})

describe('replication transport (Epic 5.5.2 — remote SSH)', () => {
  let dir: string
  let paths: RemotesPaths
  let config: TransportConfig

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-transport-'))
    paths = {
      registryFile: join(dir, 'remotes.json'),
      keyPath: join(dir, 'replication_key'),
      knownHostsFile: join(dir, 'known_hosts'),
    }
    config = { paths, membersFile: join(dir, 'members.json') }
    await writeFile(config.membersFile, MEMBERS, 'utf-8')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // --- ssh argv (pure) -------------------------------------------------------
  it('buildSshArgv: remote form carries -p, -i, our known_hosts, StrictHostKeyChecking, user@host', () => {
    const resolved: ResolvedLocation = {
      kind: 'remote',
      host: '10.0.0.9',
      port: 2222,
      user: 'admin',
      keyPath: '/etc/pve/priv/anas/replication_key',
      knownHostsFile: '/etc/pve/priv/anas/known_hosts',
    }
    assert.deepEqual(buildSshArgv(resolved, ['zfs', 'recv', 'backup/media']), [
      SSH,
      '-o',
      'BatchMode=yes',
      // cr.35: a dead host ends at 10 s; a peer that dies mid-stream ends the
      // pipe after four unanswered 15 s keepalives.
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-p',
      '2222',
      '-i',
      '/etc/pve/priv/anas/replication_key',
      '-o',
      'UserKnownHostsFile=/etc/pve/priv/anas/known_hosts',
      '-o',
      'StrictHostKeyChecking=yes',
      '--',
      'admin@10.0.0.9',
      'zfs',
      'recv',
      'backup/media',
    ])
  })

  it('buildSshArgv: peer form is plain root@node with no -i / known_hosts', () => {
    assert.deepEqual(buildSshArgv({ kind: 'peer', host: 'node2' }, ['zpool', 'list', '-H', '-o', 'name']), [
      SSH,
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '--',
      'root@node2',
      'zpool',
      'list',
      '-H',
      '-o',
      'name',
    ])
  })

  // C1 (review 2026-10-14): a hostile user reaching the transport — the READ
  // schema stays lenient, so buildSshArgv is the LAST line of defence: the
  // hostile string must land after `--`, where ssh reads it as the destination,
  // never as an option (-oProxyCommand would run as root).
  it('buildSshArgv: a hostile `-oProxyCommand=…` user appears only AFTER `--`', () => {
    const hostile = '-oProxyCommand=touch x'
    const resolved: ResolvedLocation = {
      kind: 'remote',
      host: '10.0.0.9',
      port: 22,
      user: hostile,
      keyPath: '/etc/pve/priv/anas/replication_key',
      knownHostsFile: '/etc/pve/priv/anas/known_hosts',
    }
    const argv = buildSshArgv(resolved, ['true'])
    const dashdash = argv.indexOf('--')
    assert.ok(dashdash > 0, 'argv carries the option terminator')
    // The user lives inside the `<user>@<host>` destination element.
    const hits = argv.map((a, i) => ({ a, i })).filter(({ a }) => a.includes(hostile))
    assert.equal(hits.length, 1, 'the hostile string appears exactly once')
    assert.ok(hits[0].i > dashdash, `destination (index ${hits[0].i}) must follow \`--\` (index ${dashdash})`)
  })

  // --- members + peer resolution --------------------------------------------
  it('readMembers parses nodename + node list; unreadable → null', async () => {
    const m = await readMembers(config.membersFile)
    assert.equal(m?.nodename, 'node1')
    assert.deepEqual(m?.nodes, ['node1', 'node2', 'node3'])
    assert.equal(await readMembers(join(dir, 'nope')), null)
  })

  it('resolveLocation(peer): resolves a real peer, rejects SELF and unknown nodes', async () => {
    const t = createTransport(new MockExecutor(), config)
    const ok = await t.resolveLocation({ kind: 'peer', name: 'node2' })
    assert.ok(ok.ok && ok.resolved.kind === 'peer' && ok.resolved.host === 'node2')

    const self = await t.resolveLocation({ kind: 'peer', name: 'node1' })
    assert.ok(!self.ok)
    assert.match((self as { error: string }).error, /THIS node/)

    const unknown = await t.resolveLocation({ kind: 'peer', name: 'node9' })
    assert.ok(!unknown.ok)
    assert.match((unknown as { error: string }).error, /not a known cluster node/)
  })

  it('listPeers returns cluster nodes minus self', async () => {
    const t = createTransport(new MockExecutor(), config)
    assert.deepEqual(await t.listPeers(), ['node2', 'node3'])
  })

  // --- remote resolution + zfs ops ------------------------------------------
  it('resolveLocation(remote): resolves a registered remote, rejects an unknown name', async () => {
    await writeRemotes(paths, 0, [{ name: 'nas1', host: '10.0.0.9', port: 22, user: 'root' }])
    const t = createTransport(new MockExecutor(), config)
    const ok = await t.resolveLocation({ kind: 'remote', name: 'nas1' })
    assert.ok(ok.ok && ok.resolved.kind === 'remote')
    assert.equal(ok.ok && ok.resolved.host, '10.0.0.9')
    assert.equal(ok.ok && ok.resolved.keyPath, paths.keyPath)

    const bad = await t.resolveLocation({ kind: 'remote', name: 'ghost' })
    assert.ok(!bad.ok)
    assert.match((bad as { error: string }).error, /not registered/)
  })

  // repl.r2: a listing that did not answer is its own answer, decided by EXIT
  // CODE only (stderr is quoted, never matched), so no caller can read it as
  // "this host has no pools".
  it('remotePoolNames issues `ssh ... zpool list -H -o name`; exit 0 lists the pools', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: 'rpool\nbackup\n', stderr: '', exitCode: 0 } })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remotePoolNames(resolved), { ok: true, pools: ['rpool', 'backup'] })
  })

  it('remotePoolNames: exit 0 with empty stdout is a host with no pools, not a failure', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr: '', exitCode: 0 } })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remotePoolNames(resolved), { ok: true, pools: [] })
  })

  it('remotePoolNames: exit 255 carries ssh\'s own line (a refused key)', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({
      command: argv[0],
      args: argv.slice(1),
      // The real shape seen on the node pair: one line, trailing newline.
      result: { stdout: '', stderr: 'root@node2: Permission denied (publickey,password).\n', exitCode: 255 },
    })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remotePoolNames(resolved), {
      ok: false,
      error: 'root@node2: Permission denied (publickey,password).',
    })
  })

  // Review of repl.r2: OpenSSH prints its decoration first and the reason
  // last. RULE: for ssh's own failure (exit 255) the sentence carries the LAST
  // non-empty line; for a failing remote command, the first.
  it('remotePoolNames: exit 255 quotes the LAST line (changed host key, open key file, a banner), other exits the FIRST', async () => {
    const peer: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(peer, ['zpool', 'list', '-H', '-o', 'name'])
    const answer = async (stderr: string, exitCode: number) => {
      const m = new MockExecutor()
      m.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr, exitCode } })
      return createTransport(m, config).remotePoolNames(peer)
    }
    const BOX = '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@'
    assert.deepEqual(await answer(`${BOX}\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n${BOX}\nOffending ED25519 key in /etc/pve/priv/anas/known_hosts:3\nHost key verification failed.\n`, 255), { ok: false, error: 'Host key verification failed.' })
    assert.deepEqual(await answer(`${BOX}\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n${BOX}\nroot@node2: Permission denied (publickey).\n\n`, 255), { ok: false, error: 'root@node2: Permission denied (publickey).' })
    assert.deepEqual(await answer('*** Authorized use only ***\nroot@node2: Permission denied (publickey,password).\n', 255), { ok: false, error: 'root@node2: Permission denied (publickey,password).' })
    assert.deepEqual(await answer('bash: line 1: zpool: command not found\nsecond line\n', 127), { ok: false, error: 'bash: line 1: zpool: command not found' })
    // Text the far side controls: no control characters, and a bounded length.
    const long = await answer(`${'x'.repeat(5000)}\u001B[31m\u0007\n`, 1)
    assert.equal(long.ok, false)
    if (!long.ok) {
      assert.equal(long.error.length, 303)
      assert.ok(long.error.endsWith('...'))
    }
    const esc = await answer('bad\u001B[31mred\u0007 line\n', 1)
    // eslint-disable-next-line no-control-regex
    assert.ok(!esc.ok && !/[\x00-\x1F\x7F]/.test(esc.error), JSON.stringify(esc))
  })

  it('remotePoolNames: exit 255 with empty stderr says `ssh exited 255`', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr: '', exitCode: 255 } })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remotePoolNames(resolved), { ok: false, error: 'ssh exited 255' })
  })

  it('remotePoolNames: a non-zero exit that is not 255 is still "did not answer"', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr: 'zpool: command not found\n', exitCode: 1 } })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remotePoolNames(resolved), { ok: false, error: 'zpool: command not found' })
    // No fixture at all is still a non-zero exit (the mock's own 127), so a
    // probe that never answered no longer reads as an empty pool list.
    assert.deepEqual(await t.remotePoolNames({ kind: 'peer', host: 'nohost' }), {
      ok: false,
      error: 'mock: command not found: /usr/bin/ssh',
    })
  })

  it('remotePoolExists answers yes, no, and "did not answer" with the same line', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: 'rpool\nbackup\n', stderr: '', exitCode: 0 } })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remotePoolExists(resolved, 'backup'), { ok: true, exists: true })
    assert.deepEqual(await t.remotePoolExists(resolved, 'tank'), { ok: true, exists: false })

    mock.clearFixtures()
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: '', stderr: 'root@node2: Permission denied (publickey,password).\n', exitCode: 255 } })
    assert.deepEqual(await t.remotePoolExists(resolved, 'backup'), {
      ok: false,
      error: 'root@node2: Permission denied (publickey,password).',
    })
  })

  it('remoteSnapshotNames extracts the names after @ from the -H list', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name,creation', '--', 'backup/media'])
    mock.addFixture({
      command: argv[0],
      args: argv.slice(1),
      result: { stdout: 'backup/media@s1\tThu Jul 10 2026\nbackup/media@s2\tFri Jul 11 2026\n', stderr: '', exitCode: 0 },
    })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remoteSnapshotNames(resolved, 'backup/media'), ['s1', 's2'])
  })
})

/**
 * repl.r1 — the remote words reach the remote zfs as the words ANAS meant.
 * ssh joins the words after the destination with spaces and the remote login
 * shell splits them again, so every word is quoted before it goes on the argv.
 */
describe('repl.r1 — remote shell quoting', () => {
  it('remoteShellWord leaves every plain word unchanged, punctuation included', () => {
    const plain = [
      'zfs',
      'hold',
      '--',
      '-H',
      '-o',
      'name,creation',
      'readonly=on',
      'pool/ds@anas-daily-2026-11-13_01.00.00--1d',
      'datapool/spc@nightly',
      'true',
      '--version',
      'abcXYZ019',
      '_',
      '@',
      '%',
      '+',
      '=',
      ':',
      ',',
      '.',
      '/',
      '-',
    ]
    for (const w of plain)
      assert.equal(remoteShellWord(w), w, `plain word ${JSON.stringify(w)} is unchanged`)
  })

  it('remoteShellWord quotes anything outside the plain set', () => {
    assert.equal(remoteShellWord('a b'), `'a b'`)
    assert.equal(remoteShellWord(' x'), `' x'`, 'a leading space keeps its space inside quotes')
    assert.equal(remoteShellWord('x '), `'x '`, 'a trailing space keeps its space inside quotes')
    assert.equal(remoteShellWord('it\'s'), `'it'\\''s'`, 'an embedded quote closes, escapes, reopens')
    assert.equal(remoteShellWord(''), `''`, 'the empty string is two quotes, never nothing')
    assert.equal(remoteShellWord('$(id)'), `'$(id)'`)
    assert.equal(remoteShellWord('a;b'), `'a;b'`)
    assert.equal(remoteShellWord('*'), `'*'`)
  })

  it('buildSshArgv quotes a spaced hold snapshot for a peer and for a remote', () => {
    const peer: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const remote: ResolvedLocation = {
      kind: 'remote',
      host: '10.0.0.9',
      port: 2222,
      user: 'admin',
      keyPath: '/etc/pve/priv/anas/replication_key',
      knownHostsFile: '/etc/pve/priv/anas/known_hosts',
    }
    const cmd = ['zfs', 'hold', '--', 'anas-repl-0123456789ab', 'datapool/spc@nightly 2']
    const peerArgv = buildSshArgv(peer, cmd)
    assert.deepEqual(peerArgv.slice(-5), [
      'zfs',
      'hold',
      '--',
      'anas-repl-0123456789ab',
      `'datapool/spc@nightly 2'`,
    ])
    assert.equal(peerArgv.at(-1), `'datapool/spc@nightly 2'`, 'the snapshot is ONE word')
    const remoteArgv = buildSshArgv(remote, cmd)
    assert.deepEqual(remoteArgv.slice(-5), peerArgv.slice(-5))
    assert.equal(remoteArgv[remoteArgv.indexOf('--') + 1], 'admin@10.0.0.9')
  })

  it('the quoted words survive a real /bin/sh as exactly the original words', () => {
    const words = [
      'datapool/spc@nightly 2',
      'x ',
      ' x',
      '-leading-dash',
      'it\'s',
      'a\tb',
      'a\nb',
      '$(id)',
      'a;b',
      '*',
      '',
      'plain',
      '--',
      'pool/ds@anas-daily-2026-11-13_01.00.00--1d',
    ]
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${words.map(remoteShellWord).join(' ')}`], { encoding: 'utf8' })
    // The format's \0 terminates every printed word and the last one: the
    // split's trailing empty string is that final NUL, not a word.
    assert.deepEqual(out.split('\0').slice(0, -1), words)
  })

  // The monkey on the keyboard (operator, 2026-11-14): the table above holds
  // the shapes somebody thought of. Random words — spaces, quotes, shell
  // syntax, control characters, non-ASCII — go through a real /bin/sh and must
  // come back byte for byte. Seeded: a failure prints the seed and the batch.
  it('random words survive a real /bin/sh byte for byte (seeded)', () => {
    const seed = 0x5EED_2026
    let state = seed
    const next = (): number => {
      // mulberry32
      state = (state + 0x6D2B79F5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pool = [
      ...'abcXYZ019_@%+=:,./-',
      ' ',
      ' ',
      '\t',
      '\n',
      '\r',
      '\'',
      '\'',
      '"',
      '`',
      '$',
      '\\',
      ';',
      '&',
      '|',
      '<',
      '>',
      '(',
      ')',
      '{',
      '}',
      '[',
      ']',
      '*',
      '?',
      '~',
      '!',
      '#',
      '^',
      '\u0001',
      '\u001B',
      '\u007F',
      '\u00E9',
      '\u2028',
      '\u{1F600}',
    ]
    const word = (): string => {
      const len = Math.floor(next() * 12)
      let w = ''
      for (let i = 0; i < len; i++)
        w += pool[Math.floor(next() * pool.length)]
      return w
    }
    for (let batch = 0; batch < 60; batch++) {
      const words = Array.from({ length: 50 }, word)
      const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${words.map(remoteShellWord).join(' ')}`], { encoding: 'utf8' })
      assert.deepEqual(out.split('\0').slice(0, -1), words, `seed ${seed}, batch ${batch}`)
    }
  })
})
