import type { MountEntry, MountSummary } from '@anas/shared'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { parsePveMountPaths } from '../../parsers/pve-storage.js'
import {
  ahrPinnedSpecs,
  applyMountDefaults,
  buildBaseInventory,
  buildMountWarnings,
  buildSpec,
  classifyStatHealth,
  credsFileName,
  entryForResponse,
  formatCredentials,
  hasInlineCredentials,
  mapCifsFailure,
  mapNfsFailure,
  parseSpec,
  parseStatCapacity,
  probeInventoryHealth,
  redactFstabLine,
  removeEmptyMountpointDir,
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

  it('exposes parsed server/remotePath on the remote rows (edit round-trip)', () => {
    const nfs = by('/mnt/anas-nfs')
    assert.equal(nfs.server, '127.0.0.1')
    assert.equal(nfs.remotePath, '/srv/nfs/export1')
    const cifs = by('/mnt/anas-cifs')
    assert.equal(cifs.server, '127.0.0.1')
    assert.equal(cifs.remotePath, 'anastest')
  })

  it('never sets server/remotePath on a local row', () => {
    const local = by('/mnttest') // ZFS
    assert.equal(local.server, undefined)
    assert.equal(local.remotePath, undefined)
  })
})

describe('buildBaseInventory — server/remotePath on an option-rich cifs entry', () => {
  const fstab = '//nas.example.com/media  /mnt/media  cifs  '
    + 'credentials=/etc/anas/creds/media.cred,uid=1002,gid=1002,noatime,nofail  0  0\n'
  const rows = buildBaseInventory('{"filesystems":[]}', fstab, new Map())
  const media = rows.find(r => r.mountpoint === '/mnt/media')!

  it('splits the spec even with credentials/uid/gid/noatime present', () => {
    assert.equal(media.type, 'cifs')
    assert.equal(media.server, 'nas.example.com')
    assert.equal(media.remotePath, 'media')
  })
})

describe('parseSpec — reverse of buildSpec (server/share from an fstab spec)', () => {
  it('CIFS //server/share', () => {
    assert.deepEqual(parseSpec('cifs', '//nas.example.com/media'), { server: 'nas.example.com', remotePath: 'media' })
  })

  it('CIFS backslashes \\\\server\\share', () => {
    assert.deepEqual(parseSpec('cifs', '\\\\nas\\media'), { server: 'nas', remotePath: 'media' })
  })

  it('CIFS multi-segment share //server/share/sub', () => {
    assert.deepEqual(parseSpec('cifs', '//nas/media/movies'), { server: 'nas', remotePath: 'media/movies' })
  })

  it('CIFS server-only //server', () => {
    assert.deepEqual(parseSpec('cifs', '//nas'), { server: 'nas' })
  })

  it('NFS server:/export', () => {
    assert.deepEqual(parseSpec('nfs', 'nas.example.com:/srv/export1'), { server: 'nas.example.com', remotePath: '/srv/export1' })
  })

  it('NFS bracketed IPv6 literal [addr]:/export', () => {
    assert.deepEqual(parseSpec('nfs', '[2001:db8::1]:/export'), { server: '2001:db8::1', remotePath: '/export' })
  })

  it('NFS bare IPv6 splits at the colon before the export path', () => {
    assert.deepEqual(parseSpec('nfs', '2001:db8::1:/export'), { server: '2001:db8::1', remotePath: '/export' })
  })

  it('malformed / empty specs fail graceful (no throw, {})', () => {
    assert.deepEqual(parseSpec('nfs', ''), {})
    assert.deepEqual(parseSpec('nfs', 'notaspec'), {})
    assert.deepEqual(parseSpec('cifs', ''), {})
    assert.deepEqual(parseSpec('cifs', '//'), {})
  })

  it('round-trips buildSpec across cifs / nfs / ipv6', () => {
    const cases: Array<['nfs' | 'cifs', string, string]> = [
      ['cifs', 'nas', 'media'],
      ['cifs', 'nas', 'media/movies'],
      ['nfs', 'nas.example.com', '/srv/export1'],
      ['nfs', '2001:db8::1', '/export'],
    ]
    for (const [type, server, remotePath] of cases) {
      const spec = buildSpec(type, { server, remotePath })
      assert.deepEqual(parseSpec(type, spec), { server, remotePath }, `round-trip ${type} ${spec}`)
    }
  })
})

describe('ahrPinnedSpecs — AHR pool LV specs from the ANAS-managed mdadm.conf', () => {
  const conf = [
    '# ANAS-managed pins',
    'ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:bbbbbbbb:cccccccc:dddddddd',
    'ARRAY /dev/md/tank-r2 metadata=1.2 UUID=aaaaaaaa:bbbbbbbb:cccccccc:eeeeeeee',
    'ARRAY /dev/md/media-r1 metadata=1.2 UUID=11111111:22222222:33333333:44444444',
    'MAILADDR root',
    '',
  ].join('\n')

  it('derives one `/dev/<pool>/<pool>-vol` spec per pinned pool (band-collapsed)', () => {
    const specs = ahrPinnedSpecs(conf)
    assert.ok(specs.has('/dev/tank/tank-vol'))
    assert.ok(specs.has('/dev/media/media-vol'))
    assert.equal(specs.size, 2) // tank-r1 + tank-r2 collapse to one pool
  })

  it('ignores foreign / non-AHR-named ARRAY lines and an empty conf', () => {
    const foreign = 'ARRAY /dev/md/backup metadata=1.2 UUID=99999999:88888888:77777777:66666666\n'
    assert.equal(ahrPinnedSpecs(foreign).size, 0)
    assert.equal(ahrPinnedSpecs('').size, 0)
  })
})

describe('buildBaseInventory — AHR pool persistence (ahrManaged) tagging', () => {
  const mdadmConf = [
    'ARRAY /dev/md/tank-r1 metadata=1.2 UUID=aaaaaaaa:bbbbbbbb:cccccccc:dddddddd',
    '',
  ].join('\n')
  const ahrSpecs = ahrPinnedSpecs(mdadmConf)
  // A pinned pool with a CUSTOM mountpoint, plus a non-AHR LVM mount whose spec
  // merely LOOKS like the `/dev/<vg>/<vg>-vol` shape but is NOT pinned.
  const fstab = [
    '/dev/tank/tank-vol /srv/custom-location btrfs nofail,subvol=@data 0 0',
    '/dev/foo/foo-vol /mnt/foo btrfs nofail 0 0',
    '',
  ].join('\n')
  const rows = buildBaseInventory('{"filesystems":[]}', fstab, new Map(), ahrSpecs)
  const by = (mp: string): MountSummary => rows.find(r => r.mountpoint === mp)!

  it('flags a pinned pool even at a custom mountpoint (matched on spec, not mountpoint)', () => {
    assert.equal(by('/srv/custom-location').ahrManaged, true)
  })

  it('does NOT flag a look-alike LVM mount that is not pinned in mdadm.conf', () => {
    assert.equal(by('/mnt/foo').ahrManaged, false)
  })

  it('flags nothing when the mdadm.conf carries no pins (fail-open)', () => {
    const none = buildBaseInventory('{"filesystems":[]}', fstab, new Map(), new Set())
    assert.ok(none.every(r => r.ahrManaged === false))
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

// An IDLED-OUT automount (issue #35). Once the mount idles away, findmnt shows
// only the autofs placeholder — source `systemd-1`, fstype `autofs`, which
// classifies as a local kind. Projected verbatim, the row lost its remote
// identity and the UI disabled Edit / Unmount / Remove on it ("local storage is
// ZFS territory"). The fstab entry is the identity; the placeholder only gets to
// say the STATE.
describe('buildBaseInventory — an ARMED automount keeps its remote identity (#35)', () => {
  const armedFindmnt = JSON.stringify({
    filesystems: [{ target: '/mnt/idle-cifs', source: 'systemd-1', fstype: 'autofs', options: 'rw,relatime,fd=52,pgrp=1,timeout=60' }],
  })
  const fstab = '//nas.example.com/media /mnt/idle-cifs cifs '
    + 'credentials=/etc/anas/creds/idle.cred,nofail,_netdev,x-systemd.automount,x-systemd.idle-timeout=60 0 0\n'
  const row = buildBaseInventory(armedFindmnt, fstab, new Map()).find(r => r.mountpoint === '/mnt/idle-cifs')!

  it('projects type / remote / source from the fstab entry, not the placeholder', () => {
    assert.equal(row.type, 'cifs')
    assert.equal(row.remote, true)
    assert.equal(row.source, '//nas.example.com/media')
    assert.equal(row.fstype, 'cifs')
  })

  it('still reports the LIVE state: armed, not mounted, but persistent + automount', () => {
    assert.equal(row.state, 'armed')
    assert.equal(row.mounted, false)
    assert.equal(row.persistent, true)
    assert.equal(row.automount, true)
  })

  it('carries the parsed server / share the edit dialog round-trips', () => {
    assert.equal(row.server, 'nas.example.com')
    assert.equal(row.remotePath, 'media')
  })

  it('leaves a MOUNTED automount alone (the real fs already wins the projection)', () => {
    const mountedFindmnt = JSON.stringify({
      filesystems: [
        { target: '/mnt/idle-cifs', source: 'systemd-1', fstype: 'autofs', options: 'rw,relatime' },
        { target: '/mnt/idle-cifs', source: '//nas.example.com/media', fstype: 'cifs', options: 'rw,relatime' },
      ],
    })
    const live = buildBaseInventory(mountedFindmnt, fstab, new Map()).find(r => r.mountpoint === '/mnt/idle-cifs')!
    assert.equal(live.mounted, true)
    assert.equal(live.state, 'unknown') // awaiting the guarded probe
    assert.equal(live.type, 'cifs')
    assert.equal(live.remote, true)
  })

  it('an armed autofs with NO fstab entry keeps the honest placeholder identity', () => {
    // Nothing to project from — inventing a remote identity would be shadow state.
    const orphan = buildBaseInventory(armedFindmnt, '', new Map()).find(r => r.mountpoint === '/mnt/idle-cifs')!
    assert.equal(orphan.type, 'autofs')
    assert.equal(orphan.remote, false)
    assert.equal(orphan.state, 'armed')
  })
})

describe('buildBaseInventory — fstab pseudo/system entries never leak', () => {
  // Regression: a `proc /proc` fstab line (standard on many nodes) used to slip
  // past the fstab overlay — the active-mount filter dropped it, then the overlay
  // re-added it as a ghost persistent+unmounted row → a bogus "configured but not
  // mounted" dashboard warning. Both paths now share isIgnoredMount.
  const fstab = `${[
    'proc /proc proc defaults 0 0',
    'sysfs /sys sysfs defaults 0 0',
    'UUID=abcd none swap sw 0 0',
    'tmpfs /run/lock tmpfs defaults 0 0',
    '127.0.0.1:/srv/nfs/export /mnt/data nfs4 defaults 0 0',
  ].join('\n')}\n`
  const rows = buildBaseInventory('{"filesystems":[]}', fstab, new Map())

  it('drops proc/sys/swap/tmpfs fstab lines, keeps the real NFS mount', () => {
    const mps = rows.map(r => r.mountpoint)
    assert.ok(!mps.includes('/proc'), '/proc must not appear')
    assert.ok(!mps.includes('/sys'), '/sys must not appear')
    assert.ok(!mps.includes('none'), 'swap (none) must not appear')
    assert.ok(!mps.includes('/run/lock'), 'tmpfs under /run must not appear')
    assert.deepEqual(mps, ['/mnt/data'])
  })

  it('produces no mount warnings for the pseudo entries', () => {
    const entriesByMount = new Map(rows.map(r => [r.mountpoint, undefined as never]))
    const warnings = buildMountWarnings(rows.filter(r => r.mountpoint !== '/mnt/data'), entriesByMount)
    assert.equal(warnings.length, 0)
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
      { mountpoint: '/mnt/live', source: 'h:/e', type: 'nfs', fstype: 'nfs4', state: 'unknown', mounted: true, persistent: true, remote: true, automount: false, disabled: false, pveManaged: false, ahrManaged: false, readOnly: false },
      { mountpoint: '/mnt/armed', source: 'systemd-1', type: 'autofs', fstype: 'autofs', state: 'armed', mounted: false, persistent: true, remote: false, automount: true, disabled: false, pveManaged: false, ahrManaged: false, readOnly: false },
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

  it('forces nofail on every ANAS-written entry regardless of type', () => {
    assert.equal(applyMountDefaults('nfs', undefined, false).options.common.nofail, true)
    assert.equal(applyMountDefaults('cifs', undefined, false).options.common.nofail, true)
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
    options: { common: { readOnly: false, nofail: true, noauto, automount, noatime: false, nosuid: true, nodev: true, noexec: false, netdev: true }, passthrough: '' },
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
    ahrManaged: false,
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

  it('a comma-bearing password lands in the line-based creds file intact', async () => {
    const credsDir = join(dir, 'creds')
    const path = await writeCredentialsFile(credsDir, '/mnt/x', { username: 'u', password: 'a,b#c$d' })
    assert.equal(await readFile(path, 'utf8'), 'username=u\npassword=a,b#c$d\n')
  })
})

describe('inline-credential redaction (SECURITY — secret never crosses the boundary)', () => {
  const line = '//10.0.0.114/chiap2 /chiapools/chiap2 cifs ro,nofail,username=ccebelenski,password=Xy#zzy!$,uid=1000,gid=100 0 0'

  it('redactFstabLine replaces the password value with a placeholder', () => {
    const redacted = redactFstabLine(line)
    assert.ok(!redacted.includes('Xy#zzy'))
    assert.ok(redacted.includes('password=*****'))
    // Everything else — incl. username and the options past the password — is kept.
    assert.ok(redacted.includes('username=ccebelenski'))
    assert.ok(redacted.includes('uid=1000,gid=100'))
  })

  it('redactFstabLine is a no-op on a secure (credentials=file) line', () => {
    const secure = '//127.0.0.1/anastest /mnt/c cifs credentials=/etc/anas/creds/x.cred,vers=3.1.1 0 0'
    assert.equal(redactFstabLine(secure), secure)
  })

  it('entryForResponse drops the transient inlineCredentials channel', () => {
    const entry: MountEntry = {
      spec: '//h/s',
      mountpoint: '/m',
      fstype: 'cifs',
      options: { common: baseCommon(), passthrough: '' },
      inlineCredentials: { username: 'u', password: 'secret', domain: 'D' },
      dump: 0,
      pass: 0,
    }
    const safe = entryForResponse(entry)
    assert.equal(safe.inlineCredentials, undefined)
    assert.ok(!JSON.stringify(safe).includes('secret'))
  })

  it('hasInlineCredentials detects inline user/pass, ignores a secure entry', () => {
    assert.equal(hasInlineCredentials({ spec: '//h/s', mountpoint: '/m', fstype: 'cifs', options: { common: baseCommon(), passthrough: '' }, inlineCredentials: { password: 'x' }, dump: 0, pass: 0 }), true)
    assert.equal(hasInlineCredentials({ spec: '//h/s', mountpoint: '/m', fstype: 'cifs', options: { common: baseCommon(), passthrough: '' }, credentialsFile: '/etc/anas/creds/x.cred', dump: 0, pass: 0 }), false)
    assert.equal(hasInlineCredentials(undefined), false)
  })
})

// --- Mountpoint-directory tidy-up (18.5 refinement) --------------------------
//
// rmdir SEMANTICS ONLY: an empty directory goes, anything else STAYS and comes
// back as a warning — a leftover directory never fails the delete.

describe('removeEmptyMountpointDir', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-mpdir-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('removes an empty directory and reports no warning', async () => {
    const mp = join(dir, 'empty')
    await mkdir(mp)
    assert.equal(await removeEmptyMountpointDir(mp, false), undefined)
    await assert.rejects(stat(mp))
  })

  it('leaves a NON-EMPTY directory alone, warning why (never recursive)', async () => {
    const mp = join(dir, 'full')
    await mkdir(mp)
    await writeFile(join(mp, 'local-data.txt'), 'not ours to delete\n')
    const warning = await removeEmptyMountpointDir(mp, false)
    assert.match(String(warning), /not empty/)
    assert.deepEqual(await readdir(mp), ['local-data.txt'])
  })

  it('never touches a directory that is still a mountpoint', async () => {
    const mp = join(dir, 'still-mounted')
    await mkdir(mp)
    const warning = await removeEmptyMountpointDir(mp, true)
    assert.match(String(warning), /still mounted/)
    assert.ok((await stat(mp)).isDirectory())
  })

  it('an absent directory is the asked-for outcome, not a warning', async () => {
    assert.equal(await removeEmptyMountpointDir(join(dir, 'never-existed'), false), undefined)
  })
})

/** A fully-populated common-options block for entry fixtures. */
function baseCommon() {
  return { readOnly: false, nofail: true, noauto: false, automount: false, noatime: false, nosuid: false, nodev: false, noexec: false, netdev: false }
}
