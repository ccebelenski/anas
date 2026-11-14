import type { MockExecutor } from '../executor/mock.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer } from '../server.js'

/**
 * cr3 (handed by the area builders): the dev `--mock` server answers the reads
 * this wave adds — `realpath -e --` on the two seeded mountpoints (each to
 * itself, ahead of the catch-all that answers every other realpath with the
 * md device), the discard-granularity lsblk read, and the two-column zfs
 * mountpoint list.
 */
describe('cr3 the dev mock seed answers the wave\'s new reads', () => {
  it('realpath, lsblk DISC-GRAN and zfs list name,mountpoint', async () => {
    const server = createServer({ mock: true, logger: false })
    await server.ready()
    const ex = (server as unknown as { executor: MockExecutor }).executor
    for (const mp of ['/testpool/media', '/mnt/anas-ahr/ahr0']) {
      const r = await ex.exec('/usr/bin/realpath', ['-e', '--', mp])
      assert.deepEqual([r.exitCode, r.stdout], [0, `${mp}\n`])
    }
    assert.equal((await ex.exec('/usr/bin/realpath', ['/dev/md/ahr0-r1'])).stdout, '/dev/md127\n', 'the catch-all still answers the md symlink')
    const disc = await ex.exec('/usr/bin/lsblk', ['-Jbno', 'NAME,DISC-GRAN'])
    const devs = (JSON.parse(disc.stdout) as { blockdevices: Array<{ 'name': string, 'disc-gran': number }> }).blockdevices
    assert.ok(devs.length > 0)
    assert.ok(devs.every(d => typeof d.name === 'string' && d['disc-gran'] === 0))
    const zfs = await ex.exec('/usr/sbin/zfs', ['list', '-H', '-o', 'name,mountpoint'])
    assert.equal(zfs.stdout, 'testpool\t/testpool\ntestpool/media\t/testpool/media\n')
    await server.close()
  })
})
