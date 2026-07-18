import type { MountEntry, MountSummary } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { parsePveMountPaths } from '../../parsers/pve-storage.js'
import {
  applyMountDefaults,
  buildBaseInventory,
  buildMountWarnings,
  classifyStatHealth,
  credsFileName,
  formatCredentials,
  mapCifsFailure,
  mapNfsFailure,
  parseStatCapacity,
  probeInventoryHealth,
  writeCredentialsFile,
} from '../mounts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/mounts')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

// --- Inventory building (findmnt + fstab + storage.cfg PVE tagging) ----------

describe('buildBaseInventory', () => {
  const rows = buildBaseInventory(
    loadFixture('findmnt-full.json'),
    loadFixture('fstab-anas-managed'),
    parsePveMountPaths(loadFixture('storage.cfg')),
  )
  const by = (mp: string): MountSummary => rows.find(r => r.mountpoint === mp)!

  it('filters pseudo-fs and lists the real mounts', () => {
    const mps = rows.map(r => r.mountpoint)
    assert.ok(!mps.some(m => m === '/proc' || m === '/sys' || m === '/run' || m === '/etc/pve'))
    for (const m of ['/', '/boot/efi', '/mnt/anas-nfs', '/mnt/anas-cifs', '/mnttest', '/mnt/anas-auto', '/mnt/pve/anastest-nfs'])
      assert.ok(mps.includes(m), `expected ${m}`)
  })

  it('tags the PVE-owned mount hands-off from storage.cfg (never findmnt alone)', () => {
    const pve = by('/mnt/pve/anastest-nfs')
    assert.equal(pve.pveManaged, true)
    assert.equal(pve.pveStorage, 'anastest-nfs')
    assert.equal(pve.type, 'nfs')
  })

  it('marks fstab entries persistent and disambiguates remote kinds', () => {
    assert.equal(by('/mnt/anas-nfs').persistent, true)
    assert.equal(by('/mnt/anas-nfs').remote, true)
    assert.equal(by('/mnt/anas-nfs').type, 'nfs')
    assert.equal(by('/mnt/anas-cifs').type, 'cifs')
    assert.equal(by('/mnttest').persistent, false) // ZFS, not in fstab
    assert.equal(by('/mnttest').type, 'zfs')
  })

  it('collapses a stacked automount to one mounted row with automount=true', () => {
    const auto = by('/mnt/anas-auto')
    assert.equal(auto.mounted, true) // real nfs4 present under the autofs placeholder
    assert.equal(auto.automount, true)
    assert.equal(auto.type, 'nfs')
    assert.equal(auto.persistent, true)
  })

  it('a live mount awaits the probe (state unknown until probed)', () => {
    assert.equal(by('/mnt/anas-nfs').state, 'unknown')
  })
})

describe('buildBaseInventory — disabled entry', () => {
  it('surfaces a marker-disabled entry as a visible row with state=disabled', () => {
    const fstab = '#ANAS 127.0.0.1:/srv/nfs/export1 /mnt/off nfs4 defaults,nofail 0 0\n'
    const rows = buildBaseInventory('{"filesystems":[]}', fstab, new Map())
    const off = rows.find(r => r.mountpoint === '/mnt/off')!
    assert.equal(off.disabled, true)
    assert.equal(off.state, 'disabled')
    assert.equal(off.persistent, true)
    assert.equal(off.mounted, false)
  })
})

// --- Status classification (the exit-code table, NOTES §4) -------------------

describe('classifyStatHealth (timeout 2 stat -f exit codes)', () => {
  it('exit 0 → ok', () => {
    assert.equal(classifyStatHealth(0, ''), 'ok')
  })
  it('exit 124 → unreachable (the hang case)', () => {
    assert.equal(classifyStatHealth(124, ''), 'unreachable')
  })
  it('exit 1 + "Stale file handle" → stale', () => {
    assert.equal(classifyStatHealth(1, 'stat: cannot read file system information for \'.\': Stale file handle'), 'stale')
  })
  it('exit 1 + "No such file" → unknown (findmnt, not stat, decides unmounted)', () => {
    assert.equal(classifyStatHealth(1, 'stat: cannot read ...: No such file or directory'), 'unknown')
  })
})

describe('parseStatCapacity', () => {
  it('parses %S %b %f %a into byte capacity + percent', () => {
    const cap = parseStatCapacity('4096 8203953 6637110 6291265')!
    assert.equal(cap.size, 4096 * 8203953)
    assert.equal(cap.used, 4096 * (8203953 - 6637110))
    assert.equal(cap.available, 4096 * 6291265)
    assert.ok(cap.percent >= 0 && cap.percent <= 100)
  })
  it('returns null on garbage', () => {
    assert.equal(parseStatCapacity('nope'), null)
  })
})

describe('probeInventoryHealth skips armed / disabled / unmounted rows', () => {
  it('only live rows get probed', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: '/usr/bin/timeout', result: { stdout: '4096 100 50 50', stderr: '', exitCode: 0 } })
    const rows: MountSummary[] = [
      { mountpoint: '/mnt/live', source: 'h:/e', type: 'nfs', fstype: 'nfs4', state: 'unknown', mounted: true, persistent: true, remote: true, automount: false, disabled: false, pveManaged: false, readOnly: false },
      { mountpoint: '/mnt/armed', source: 'systemd-1', type: 'autofs', fstype: 'autofs', state: 'armed', mounted: false, persistent: true, remote: false, automount: true, disabled: false, pveManaged: false, readOnly: false },
    ]
    await probeInventoryHealth(exec, rows)
    assert.equal(rows[0].state, 'ok')
    assert.equal(rows[1].state, 'armed')
    // Exactly one probe ran (the live row).
    assert.equal(exec.calls.filter(c => c.command === '/usr/bin/timeout').length, 1)
  })
})

// --- Failure taxonomy → test verdicts (every captured string, NOTES §6) ------

describe('mapNfsFailure — every captured mount.nfs failure', () => {
  const cases: [string, string][] = [
    ['mount.nfs4: Connection timed out for 192.0.2.1:/srv/nfs/export1 on /mnt/anas-probe', 'unreachable'],
    ['mount.nfs4: Connection refused for 127.0.0.1:/srv/nfs/export1 on /mnt/anas-probe', 'unreachable'],
    ['mount.nfs4: mounting 127.0.0.1:/srv/nfs/nonexistent failed, reason given by server: No such file or directory', 'not-found'],
    ['mount.nfs4: Protocol not supported for 127.0.0.1:/srv/nfs/export1 on /mnt/anas-probe', 'protocol-mismatch'],
    ['mount.nfs: requested NFS version or transport protocol is not supported for /mnt/anas-probe', 'protocol-mismatch'],
  ]
  for (const [stderr, verdict] of cases) {
    it(`${verdict}: ${stderr.slice(0, 40)}…`, () => {
      assert.equal(mapNfsFailure(stderr), verdict)
    })
  }
})

describe('mapCifsFailure — every captured mount.cifs errno', () => {
  const cases: [string, string][] = [
    ['mount error(115): could not connect to 192.0.2.1Unable to find suitable address.', 'unreachable'],
    ['mount error(111): could not connect to 127.0.0.1Unable to find suitable address.', 'unreachable'],
    ['mount error(13): Permission denied', 'auth-failed'],
    ['mount error(2): No such file or directory', 'not-found'],
    ['mount error(95): Operation not supported', 'protocol-mismatch'],
  ]
  for (const [stderr, verdict] of cases) {
    it(`${verdict}: ${stderr.slice(0, 30)}…`, () => {
      assert.equal(mapCifsFailure(stderr), verdict)
    })
  }
})

// --- Server-side option defaults (18.5) --------------------------------------

describe('applyMountDefaults', () => {
  it('forces nofail and adds _netdev/nosuid/nodev for NFS; vers=4.2 + hard', () => {
    const { options, warnings } = applyMountDefaults('nfs', undefined, false)
    assert.equal(options.common.nofail, true)
    assert.equal(options.common.netdev, true)
    assert.equal(options.common.nosuid, true)
    assert.equal(options.common.nodev, true)
    assert.equal(options.nfs?.vers, '4.2')
    assert.equal(options.nfs?.hard, true)
    assert.equal(warnings.length, 0)
  })

  it('warns on soft NFS', () => {
    const { warnings } = applyMountDefaults('nfs', { hard: false }, false)
    assert.ok(warnings.some(w => w.toLowerCase().includes('soft')))
  })

  it('defaults CIFS to vers=3.1.1 and warns loudly on vers=1.0', () => {
    assert.equal(applyMountDefaults('cifs', undefined, false).options.cifs?.vers, '3.1.1')
    assert.ok(applyMountDefaults('cifs', { vers: '1.0' }, false).warnings.some(w => w.includes('1.0')))
  })

  it('local mounts do not force _netdev/nosuid/nodev', () => {
    const { options } = applyMountDefaults('local', undefined, false)
    assert.equal(options.common.netdev, false)
    assert.equal(options.common.nosuid, false)
    assert.equal(options.common.nofail, true)
  })
})

// --- Dashboard warnings (mount category) -------------------------------------

describe('buildMountWarnings', () => {
  const entry = (mp: string, noauto = false, automount = false): MountEntry => ({
    spec: 'h:/e',
    mountpoint: mp,
    fstype: 'nfs4',
    dump: 0,
    pass: 0,
    options: { common: { readOnly: false, nofail: true, noauto, automount, noatime: false, nosuid: true, nodev: true, netdev: true }, passthrough: '' },
  })
  const row = (mp: string, over: Partial<MountSummary>): MountSummary => ({
    mountpoint: mp,
    source: 'h:/e',
    type: 'nfs',
    fstype: 'nfs4',
    state: 'ok',
    mounted: true,
    persistent: true,
    remote: true,
    automount: false,
    disabled: false,
    pveManaged: false,
    readOnly: false,
    ...over,
  })

  it('warns on a persisted unreachable/stale mount', () => {
    const w = buildMountWarnings([row('/a', { state: 'unreachable' }), row('/b', { state: 'stale' })], new Map())
    assert.equal(w.length, 2)
    assert.ok(w.every(x => x.category === 'mount'))
  })

  it('warns on a boot mount that is configured but not mounted', () => {
    const w = buildMountWarnings([row('/a', { state: 'unmounted' })], new Map([['/a', entry('/a')]]))
    assert.equal(w.length, 1)
  })

  it('does NOT warn on healthy, PVE, ephemeral, noauto, automount, or DISABLED mounts', () => {
    const summaries: MountSummary[] = [
      row('/ok', { state: 'ok' }),
      row('/pve', { state: 'unreachable', pveManaged: true }),
      row('/ephemeral', { state: 'unreachable', persistent: false }),
      row('/noauto', { state: 'unmounted' }),
      row('/auto', { state: 'unmounted' }),
      row('/disabled', { state: 'disabled', disabled: true, mounted: false }),
    ]
    const entries = new Map([['/noauto', entry('/noauto', true)], ['/auto', entry('/auto', false, true)]])
    assert.equal(buildMountWarnings(summaries, entries).length, 0)
  })
})

// --- Credentials file (mode / content / tmpdir) ------------------------------

describe('writeCredentialsFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-creds-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the exact accepted format at 0600 (never the secret on argv)', async () => {
    const credsDir = join(dir, 'creds')
    const path = await writeCredentialsFile(credsDir, '/mnt/anas-cifs', { username: 'smbtest', password: 'Passw0rd123', domain: 'WORKGROUP' })
    assert.equal(path, join(credsDir, 'mnt-anas-cifs.cred'))
    const content = await readFile(path, 'utf8')
    assert.equal(content, 'username=smbtest\npassword=Passw0rd123\ndomain=WORKGROUP\n')
    // Matches the ground-truth fixture format exactly.
    assert.equal(content, loadFixture('creds-anastest.cred'))
    const st = await stat(path)
    assert.equal(st.mode & 0o777, 0o600)
    const dirSt = await stat(credsDir)
    assert.equal(dirSt.mode & 0o777, 0o700)
  })

  it('omits domain when not provided', () => {
    assert.equal(formatCredentials({ username: 'u', password: 'p' }), 'username=u\npassword=p\n')
  })

  it('derives a deterministic per-mount filename', () => {
    assert.equal(credsFileName('/mnt/anas-cifs'), 'mnt-anas-cifs.cred')
    assert.equal(credsFileName('/srv/data/share'), 'srv-data-share.cred')
  })
})
