import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import {
  buildSourceGuardFacts,
  guardSourcePath,
  readSourceGuardFacts,
  unmountedMountFor,
  unmountedSourceRefusal,
} from '../source-guard.js'

/**
 * The ONE configured-but-unmounted source check (rclone.2; backup2.11 wires it
 * into backup). Every case is two strings — an fstab and a findmnt capture — so
 * the whole matrix is expressible without a filesystem.
 */

const FSTAB = [
  '# /etc/fstab: static file system information.',
  'UUID=deadbeef  /               ext4  errors=remount-ro  0  1',
  '//nas/pictures /mnt/pictures   cifs  credentials=/etc/anas/creds/mnt_pictures,nofail  0  0',
  'server:/export /mnt/archive    nfs4  nofail,noauto  0  0',
  '#ANAS //nas/old /mnt/old       cifs  nofail  0  0',
  'none           swap            swap  sw  0  0',
  '',
].join('\n')

/**
 * What the kernel reports at each target when the CONFIGURED thing is mounted
 * there (ident.4 (c): a target counts as mounted only when its live source
 * and fstype match the configuration). An unlisted target gets a generic
 * share, which matches nothing configured.
 */
const LIVE: Record<string, { source: string, fstype: string }> = {
  '/': { source: '/dev/sda1', fstype: 'ext4' },
  '/mnt/pictures': { source: '//nas/pictures', fstype: 'cifs' },
  '/mnt/archive': { source: 'server:/export', fstype: 'nfs4' },
  '/mnt/old': { source: '//nas/old', fstype: 'cifs' },
  '/mnt/pictures/live': { source: '//nas/live', fstype: 'cifs' },
}

function findmnt(targets: string[], over: Record<string, { source: string, fstype: string }> = {}): string {
  return JSON.stringify({
    filesystems: targets.map(target => ({
      target,
      ...(over[target] ?? LIVE[target] ?? { source: '//nas/share', fstype: 'cifs' }),
      options: 'rw',
    })),
  })
}

/** Everything in the fstab is mounted — the healthy node. */
const ALL_MOUNTED = findmnt(['/', '/mnt/pictures', '/mnt/archive', '/mnt/old'])
/** The boot race this guard exists for: the CIFS mount never came up. */
const PICTURES_MISSING = findmnt(['/', '/mnt/archive', '/mnt/old'])

/** The whole fact about `/mnt/pictures` as the fstab configures it. */
const PICTURES_MOUNT = {
  mountpoint: '/mnt/pictures',
  source: '//nas/pictures',
  fstype: 'cifs',
  disabled: false,
}

describe('source guard — configured but unmounted (rclone.2)', () => {
  describe('buildSourceGuardFacts', () => {
    it('reads every absolute fstab mountpoint, including a disabled one', () => {
      const facts = buildSourceGuardFacts(FSTAB, ALL_MOUNTED)
      assert.deepEqual(
        facts.configured.map(c => c.mountpoint),
        ['/', '/mnt/pictures', '/mnt/old'],
        'swap has no absolute mountpoint and is dropped by the parser; the noauto line is not boot-configured',
      )
      assert.deepEqual(
        facts.configured.filter(c => c.disabled).map(c => c.mountpoint),
        ['/mnt/old'],
        'a #ANAS-commented line is still a CONFIGURED mount',
      )
      // backup2.11 — the two fstab fields a refusal sentence NAMES ride along.
      // They can only come from fstab: the kernel table has nothing to say
      // about a mount that is not there.
      assert.deepEqual(
        facts.configured.find(c => c.mountpoint === '/mnt/pictures'),
        { mountpoint: '/mnt/pictures', source: '//nas/pictures', fstype: 'cifs', disabled: false },
      )
    })

    it('an unreadable mount table is flagged, not read as "nothing is mounted"', () => {
      assert.equal(buildSourceGuardFacts(FSTAB, '').mountTableUnavailable, true)
      assert.equal(buildSourceGuardFacts(FSTAB, 'not json').mountTableUnavailable, true)
    })
  })

  describe('unmountedMountFor', () => {
    it('the source IS the unmounted mountpoint', () => {
      const facts = buildSourceGuardFacts(FSTAB, PICTURES_MISSING)
      assert.deepEqual(unmountedMountFor('/mnt/pictures', facts), PICTURES_MOUNT)
    })

    it('the source is UNDER the unmounted mountpoint', () => {
      const facts = buildSourceGuardFacts(FSTAB, PICTURES_MISSING)
      assert.deepEqual(unmountedMountFor('/mnt/pictures/2026/raw', facts), PICTURES_MOUNT)
    })

    it('passes when everything the fstab names is mounted', () => {
      const facts = buildSourceGuardFacts(FSTAB, ALL_MOUNTED)
      assert.equal(unmountedMountFor('/mnt/pictures/2026', facts), null)
    })

    it('a path on no configured mount but under a mounted / passes', () => {
      const facts = buildSourceGuardFacts(FSTAB, ALL_MOUNTED)
      assert.equal(unmountedMountFor('/tank/media', facts), null)
    })

    it('LONGEST prefix wins — a mounted deeper mount is the answer, not a shallower one', () => {
      // `/mnt/pictures` absent, but a deeper `/mnt/pictures/live` IS mounted and
      // configured: the path is genuinely on the deeper filesystem.
      const fstab = `${FSTAB}//nas/live /mnt/pictures/live cifs nofail 0 0\n`
      const facts = buildSourceGuardFacts(fstab, findmnt(['/', '/mnt/archive', '/mnt/old', '/mnt/pictures/live']))
      assert.equal(unmountedMountFor('/mnt/pictures/live/today', facts), null)
      // …while a sibling path under the still-absent mount is refused.
      assert.deepEqual(unmountedMountFor('/mnt/pictures/2026', facts), PICTURES_MOUNT)
    })

    it('a DISABLED fstab entry that is not mounted is still refused, and says so', () => {
      const facts = buildSourceGuardFacts(FSTAB, findmnt(['/', '/mnt/pictures', '/mnt/archive']))
      assert.deepEqual(
        unmountedMountFor('/mnt/old/x', facts),
        { mountpoint: '/mnt/old', source: '//nas/old', fstype: 'cifs', disabled: true },
      )
    })

    it('FAILS OPEN when the mount table could not be read', () => {
      const facts = buildSourceGuardFacts(FSTAB, '')
      assert.equal(
        unmountedMountFor('/mnt/pictures', facts),
        null,
        'a guard that cannot see the system must not claim a mount is missing',
      )
    })

    it('an empty fstab configures nothing, so nothing is refused', () => {
      assert.equal(unmountedMountFor('/mnt/pictures', buildSourceGuardFacts('', ALL_MOUNTED)), null)
    })

    /**
     * A `noauto` line is not configured to be mounted at boot — it mounts on
     * demand — so a path under it passes the guard even while nothing is
     * mounted there, while a normal unmounted entry next to it is still
     * refused (review finding).
     */
    it('a noauto fstab line is not configured-but-unmounted — a path under it passes', () => {
      const facts = buildSourceGuardFacts(FSTAB, findmnt(['/']))
      assert.equal(unmountedMountFor('/mnt/archive', facts), null)
      assert.equal(unmountedMountFor('/mnt/archive/2026/raw', facts), null)
      assert.equal(guardSourcePath('/mnt/archive/2026/raw', facts), null)
      // …while the plain unmounted entry in the SAME fstab still fails it.
      assert.deepEqual(unmountedMountFor('/mnt/pictures', facts), PICTURES_MOUNT)
      assert.match(guardSourcePath('/mnt/pictures', facts) ?? '', /not mounted right now/)
    })
  })

  describe('ident.4 (c) — what is mounted must be what is configured', () => {
    it('a DIFFERENT filesystem at the configured target is "not mounted", naming what is there', () => {
      // The audit #16/#18 shape: the CIFS line failed and a local disk sits at
      // its target. Reading through it would back up the wrong filesystem.
      const facts = buildSourceGuardFacts(FSTAB, findmnt(['/', '/mnt/pictures'], { '/mnt/pictures': { source: '/dev/loop3', fstype: 'ext4' } }))
      assert.deepEqual(unmountedMountFor('/mnt/pictures/2026', facts), {
        ...PICTURES_MOUNT,
        mountedSource: '/dev/loop3',
        mountedFstype: 'ext4',
      })
      const msg = guardSourcePath('/mnt/pictures/2026', facts) ?? ''
      assert.match(msg, /\/dev\/loop3 \(ext4\) is mounted there instead/)
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[^\x00-\x7F]/.test(msg), 'ASCII only')
    })

    it('the same share under another spelling still matches (server case, trailing slash, nfs4 for nfs)', () => {
      const fstab = 'UUID=x / ext4 defaults 0 1\n//NAS/Pictures/ /mnt/pictures cifs nofail 0 0\nserver:/export/ /mnt/archive nfs nofail 0 0\n'
      const facts = buildSourceGuardFacts(fstab, findmnt(['/', '/mnt/pictures', '/mnt/archive']))
      assert.equal(unmountedMountFor('/mnt/pictures', facts), null)
      assert.equal(unmountedMountFor('/mnt/archive', facts), null)
    })

    it('an armed automount placeholder counts as mounted (the first access mounts it)', () => {
      const facts = buildSourceGuardFacts(FSTAB, findmnt(['/', '/mnt/pictures'], { '/mnt/pictures': { source: 'systemd-1', fstype: 'autofs' } }))
      assert.equal(unmountedMountFor('/mnt/pictures/2026', facts), null)
    })

    it('an unmounted ZFS dataset (key not loaded) is refused, naming the dataset', () => {
      const zfs = 'tank\t/tank\ton\tyes\ntank/media\t/tank/media\ton\tno\n'
      const facts = buildSourceGuardFacts('', findmnt(['/', '/tank'], { '/tank': { source: 'tank', fstype: 'zfs' } }), zfs)
      const m = unmountedMountFor('/tank/media/2026', facts)
      assert.deepEqual(m, { mountpoint: '/tank/media', source: 'tank/media', fstype: 'zfs', origin: 'zfs', canmount: 'on' })
      const msg = guardSourcePath('/tank/media/2026', facts) ?? ''
      assert.match(msg, /mountpoint of ZFS dataset tank\/media, which is not mounted right now/)
      assert.match(msg, /Mount tank\/media and run it again/)
      // The mounted parent is fine.
      assert.equal(unmountedMountFor('/tank/other', facts), null)
    })

    it('a canmount=off dataset is refused and the sentence says why', () => {
      const zfs = 'tank\t/tank\ton\tyes\ntank/off\t/tank/off\toff\tno\n'
      const facts = buildSourceGuardFacts('', findmnt(['/', '/tank'], { '/tank': { source: 'tank', fstype: 'zfs' } }), zfs)
      assert.match(guardSourcePath('/tank/off', facts) ?? '', /canmount=off/)
    })

    it('two datasets on one mountpoint (boot environments): mounted when ANY of them is what is there', () => {
      const zfs = 'rpool/ROOT/pve-1\t/\tnoauto\tyes\nrpool/ROOT/pve-old\t/\tnoauto\tno\n'
      const facts = buildSourceGuardFacts('', findmnt(['/'], { '/': { source: 'rpool/ROOT/pve-1', fstype: 'zfs' } }), zfs)
      assert.equal(unmountedMountFor('/srv/data', facts), null)
    })

    it('legacy / none mountpoints and garbage lines are not ZFS mount facts', () => {
      const zfs = 'tank/legacy\tlegacy\ton\tno\ntank/none\tnone\ton\tno\nnot a zfs line\n{"json": true}\n'
      assert.deepEqual(buildSourceGuardFacts('', findmnt(['/']), zfs).configured, [])
    })

    it('a symlinked source is judged where it leads, too', () => {
      const facts = buildSourceGuardFacts(FSTAB, PICTURES_MISSING, '', new Map([['/srv/pics', '/mnt/pictures/2026']]))
      assert.deepEqual(unmountedMountFor('/srv/pics', facts), PICTURES_MOUNT)
      // …and an unresolved path is judged as written.
      assert.equal(unmountedMountFor('/srv/other', facts), null)
    })
  })

  describe('the refusal sentence', () => {
    it('names the mount and the fix, in ASCII', () => {
      const msg = unmountedSourceRefusal('/mnt/pictures/2026', PICTURES_MOUNT)
      assert.match(msg, /^\/mnt\/pictures\/2026 is under \/mnt\/pictures/)
      assert.match(msg, /not mounted right now/)
      assert.match(msg, /Mount \/mnt\/pictures and run it again\./)
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[^\x00-\x7F]/.test(msg), 'ASCII only - it becomes a notification body line')
    })

    it('says so when the entry itself is disabled', () => {
      const msg = unmountedSourceRefusal('/mnt/old', {
        mountpoint: '/mnt/old',
        source: '//nas/old',
        fstype: 'cifs',
        disabled: true,
      })
      assert.match(msg, /its \/etc\/fstab entry is disabled/)
    })

    it('guardSourcePath returns the sentence, or null', () => {
      assert.match(guardSourcePath('/mnt/pictures', buildSourceGuardFacts(FSTAB, PICTURES_MISSING)) ?? '', /not mounted/)
      assert.equal(guardSourcePath('/mnt/pictures', buildSourceGuardFacts(FSTAB, ALL_MOUNTED)), null)
    })
  })

  describe('readSourceGuardFacts', () => {
    it('reads the ZFS mount facts and resolves the named paths in a bounded child', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: findmnt(['/']), stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-p', '-t', 'filesystem', '-o', 'name,mountpoint,canmount,mounted'], result: { stdout: 'tank/media\t/tank/media\ton\tno\n', stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/bin/timeout', args: ['-s', 'KILL', '5', '/usr/bin/realpath', '-e', '--', '/srv/link'], result: { stdout: '/tank/media/x\n', stderr: '', exitCode: 0 } })
      const facts = await readSourceGuardFacts(mock, '/nonexistent/fstab', ['/srv/link'])
      assert.equal(facts.realpaths.get('/srv/link'), '/tank/media/x')
      assert.equal(unmountedMountFor('/srv/link', facts)?.source, 'tank/media')
    })

    it('a path that does not resolve (or a timeout) is judged as written', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: ALL_MOUNTED, stderr: '', exitCode: 0 } })
      mock.addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 124 } })
      const facts = await readSourceGuardFacts(mock, '/nonexistent/fstab', ['/srv/hang'])
      assert.equal(facts.realpaths.size, 0)
    })

    it('an absent fstab reads as "nothing configured" rather than throwing', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: ALL_MOUNTED, stderr: '', exitCode: 0 } })
      const facts = await readSourceGuardFacts(mock, '/nonexistent/fstab')
      assert.deepEqual(facts.configured, [])
      assert.equal(facts.mountTableUnavailable, false)
    })
  })
})
