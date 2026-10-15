import type { MockExecutor } from '../../executor/mock.js'
import type { ExecResult } from '../../executor/types.js'
import type { createServer } from '../../server.js'
import { mockFixtures } from '../../fixtures/loader.js'
import { LSBLK_ARGS } from '../../parsers/lsblk.js'

/**
 * Shared seam for composer tests (cr.12): make the named disk ids resolve in
 * the LIVE disk inventory as blank, available disks.
 *
 * Since cr.12 the create / add-vdev / attach routes refuse a disk id the
 * inventory does not know (and fail CLOSED when it cannot be read), so tests
 * that pin argv construction with invented ids must make those ids real.
 * Each id joins one blank blockdevice whose SERIAL is the id: parseLsblk
 * derives the inventory id as `byId ?? serial ?? name`, so the id resolves
 * without any by-id symlink fixture, and the route still composes
 * `/dev/disk/by-id/<id>` — the argv pins stay exactly as written.
 *
 * The base is the dev lsblk fixture regardless of the server's fixture state,
 * so this also RESTORES a readable inventory on servers that `clearFixtures()`
 * (those tests exercise other unreadable reads, e.g. pool status, and must not
 * trip the inventory check on the way).
 *
 * NOT a `*.test.ts` file — the test glob ignores it; it is a helper module.
 */
export function serveBlankInventoryDisks(
  server: ReturnType<typeof createServer>,
  ids: string[],
): void {
  serveBlankInventoryDisksOn((server as unknown as { executor: MockExecutor }).executor, ids)
}

/** Same seam, installed straight on a MockExecutor (hand-built test servers). */
export function serveBlankInventoryDisksOn(
  mock: MockExecutor,
  ids: string[],
): void {
  const orig = mock.exec.bind(mock)
  mock.exec = async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === '/usr/bin/lsblk' && args.join(' ') === LSBLK_ARGS.join(' ')) {
      const inventory = JSON.parse(mockFixtures.lsblk().stdout) as { blockdevices: unknown[] }
      ids.forEach((id, i) => {
        inventory.blockdevices.push({
          'name': `sdy${i}`,
          'type': 'disk',
          'size': 2197232012800,
          'model': 'BLANK-TEST',
          'serial': id,
          'tran': 'sata',
          'fstype': null,
          'mountpoint': null,
          'rota': true,
          'phy-sec': 512,
          'log-sec': 512,
          'wwn': null,
          'vendor': 'ATA',
          'rev': '1A00',
        })
      })
      return { stdout: JSON.stringify(inventory), stderr: '', exitCode: 0 }
    }
    return orig(command, args)
  }
}
