import type { RemotesPaths } from '../replication-remotes.js'
import type { ResolvedLocation, TransportConfig } from '../replication-transport.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { writeRemotes } from '../replication-remotes.js'
import { buildSshArgv, createTransport, readMembers } from '../replication-transport.js'

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

  it('remotePoolNames issues `ssh … zpool list -H -o name` and parses names (fail-open [])', async () => {
    const mock = new MockExecutor()
    const resolved: ResolvedLocation = { kind: 'peer', host: 'node2' }
    const argv = buildSshArgv(resolved, ['zpool', 'list', '-H', '-o', 'name'])
    mock.addFixture({ command: argv[0], args: argv.slice(1), result: { stdout: 'rpool\nbackup\n', stderr: '', exitCode: 0 } })
    const t = createTransport(mock, config)
    assert.deepEqual(await t.remotePoolNames(resolved), ['rpool', 'backup'])
    // A failing probe fails open to [].
    assert.deepEqual(await t.remotePoolNames({ kind: 'peer', host: 'nohost' }), [])
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
