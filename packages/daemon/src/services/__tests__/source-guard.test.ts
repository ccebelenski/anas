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

function findmnt(targets: string[]): string {
  return JSON.stringify({
    filesystems: targets.map(target => ({
      target,
      source: target === '/' ? '/dev/sda1' : '//nas/share',
      fstype: target === '/' ? 'ext4' : 'cifs',
      options: 'rw',
    })),
  })
}

/** Everything in the fstab is mounted — the healthy node. */
const ALL_MOUNTED = findmnt(['/', '/mnt/pictures', '/mnt/archive', '/mnt/old'])
/** The boot race this guard exists for: the CIFS mount never came up. */
const PICTURES_MISSING = findmnt(['/', '/mnt/archive', '/mnt/old'])

describe('source guard — configured but unmounted (rclone.2)', () => {
  describe('buildSourceGuardFacts', () => {
    it('reads every absolute fstab mountpoint, including a disabled one', () => {
      const facts = buildSourceGuardFacts(FSTAB, ALL_MOUNTED)
      assert.deepEqual(
        facts.configured.map(c => c.mountpoint),
        ['/', '/mnt/pictures', '/mnt/archive', '/mnt/old'],
        'swap has no absolute mountpoint and is dropped by the parser',
      )
      assert.deepEqual(
        facts.configured.filter(c => c.disabled).map(c => c.mountpoint),
        ['/mnt/old'],
        'a #ANAS-commented line is still a CONFIGURED mount',
      )
      assert.equal(facts.mountTableUnavailable, false)
    })

    it('an unreadable mount table is flagged, not read as "nothing is mounted"', () => {
      assert.equal(buildSourceGuardFacts(FSTAB, '').mountTableUnavailable, true)
      assert.equal(buildSourceGuardFacts(FSTAB, 'not json').mountTableUnavailable, true)
    })
  })

  describe('unmountedMountFor', () => {
    it('the source IS the unmounted mountpoint', () => {
      const facts = buildSourceGuardFacts(FSTAB, PICTURES_MISSING)
      assert.deepEqual(unmountedMountFor('/mnt/pictures', facts), { mountpoint: '/mnt/pictures', disabled: false })
    })

    it('the source is UNDER the unmounted mountpoint', () => {
      const facts = buildSourceGuardFacts(FSTAB, PICTURES_MISSING)
      assert.deepEqual(unmountedMountFor('/mnt/pictures/2026/raw', facts), { mountpoint: '/mnt/pictures', disabled: false })
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
      assert.deepEqual(unmountedMountFor('/mnt/pictures/2026', facts), { mountpoint: '/mnt/pictures', disabled: false })
    })

    it('a DISABLED fstab entry that is not mounted is still refused, and says so', () => {
      const facts = buildSourceGuardFacts(FSTAB, findmnt(['/', '/mnt/pictures', '/mnt/archive']))
      assert.deepEqual(unmountedMountFor('/mnt/old/x', facts), { mountpoint: '/mnt/old', disabled: true })
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
  })

  describe('the refusal sentence', () => {
    it('names the mount and the fix, in ASCII', () => {
      const msg = unmountedSourceRefusal('/mnt/pictures/2026', { mountpoint: '/mnt/pictures', disabled: false })
      assert.match(msg, /^\/mnt\/pictures\/2026 is under \/mnt\/pictures/)
      assert.match(msg, /not mounted right now/)
      assert.match(msg, /Mount \/mnt\/pictures and run it again\./)
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[^\x00-\x7F]/.test(msg), 'ASCII only - it becomes a notification body line')
    })

    it('says so when the entry itself is disabled', () => {
      const msg = unmountedSourceRefusal('/mnt/old', { mountpoint: '/mnt/old', disabled: true })
      assert.match(msg, /its \/etc\/fstab entry is disabled/)
    })

    it('guardSourcePath returns the sentence, or null', () => {
      assert.match(guardSourcePath('/mnt/pictures', buildSourceGuardFacts(FSTAB, PICTURES_MISSING)) ?? '', /not mounted/)
      assert.equal(guardSourcePath('/mnt/pictures', buildSourceGuardFacts(FSTAB, ALL_MOUNTED)), null)
    })
  })

  describe('readSourceGuardFacts', () => {
    it('an absent fstab reads as "nothing configured" rather than throwing', async () => {
      const mock = new MockExecutor()
      mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: ALL_MOUNTED, stderr: '', exitCode: 0 } })
      const facts = await readSourceGuardFacts(mock, '/nonexistent/fstab')
      assert.deepEqual(facts.configured, [])
      assert.equal(facts.mountTableUnavailable, false)
    })
  })
})
