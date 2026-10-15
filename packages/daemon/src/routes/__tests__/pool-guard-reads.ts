import type { MockExecutor } from '../../executor/mock.js'
import { mockFixtures } from '../../fixtures/loader.js'

/**
 * Shared seam for pool-route tests that build their own mock fixture set
 * (`clearFixtures()`), story cr.36: since every pool verb runs on the guard,
 * the route and the job read two facts the hand-built sets never served —
 *
 *  - the pool's guid (`zpool get -H -o value guid -- <pool>`), which binds the
 *    request and the job to ONE pool (ident.1) and keys its lock (cr.33);
 *  - the boot facts (`zpool get -H -o name,value bootfs`), which the
 *    system-pool gate reads. Unserved, they read as UNREADABLE and, with the
 *    mount table also unserved, tighten every pool to a system pool (cr.23:
 *    missing facts may only tighten) — every reshape would answer 409.
 *
 * Ruling (l): both answers come from the CAPTURED `zpool get all -j`
 * (`fixtures/zfs/zpool-get-all.json`, testpool), rewritten into the `-H`
 * shapes the reads ask for: the guid value as one line, and `<pool>\t<bootfs
 * value>` (the capture's bootfs is `-`, unset). A pool other than testpool
 * borrows testpool's captured row under its own name — the rewrite is the
 * name only.
 *
 * NOT a `*.test.ts` file — the test glob ignores it; it is a helper module.
 */
export function capturedPoolGet(): { guid: string, bootfs: string } {
  const doc = JSON.parse(mockFixtures.zpoolGetAll('testpool').stdout) as {
    pools: { testpool: { properties: { guid: { value: string }, bootfs: { value: string } } } }
  }
  const props = doc.pools.testpool.properties
  return { guid: props.guid.value, bootfs: props.bootfs.value }
}

/** Serve the guid and boot-facts reads for `pool` from the capture (see the module note). */
export function servePoolGuardReads(mock: MockExecutor, pool = 'testpool'): void {
  const { guid, bootfs } = capturedPoolGet()
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'value', 'guid', '--', pool], result: { stdout: `${guid}\n`, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: `${pool}\t${bootfs}\n`, stderr: '', exitCode: 0 } })
}
