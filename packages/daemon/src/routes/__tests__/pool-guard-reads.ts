import type { MockExecutor } from '../../executor/mock.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mockFixtures } from '../../fixtures/loader.js'

/**
 * Shared seam for pool-route tests that build their own mock fixture set
 * (`clearFixtures()`), story cr.36: since every pool verb runs on the guard,
 * the route and the job read two facts the hand-built sets never served —
 *
 *  - the pool's guid (`zpool get -H -o value guid -- <pool>`), which binds the
 *    request and the job to ONE pool (ident.1) and keys its lock (cr.33);
 *  - the boot facts (`zpool get -H -o name,value bootfs`), which the
 *    system-pool gate reads beside the mount table. Unserved, either reads
 *    as UNREADABLE and tightens every pool to a system pool (cr.23: missing
 *    facts may only tighten; cr.60: the mount table on its own) — every
 *    reshape would answer 409. The mount table is served from its own
 *    capture ({@link capturedRootMountTable}).
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

/**
 * The captured `findmnt --json /` of an ext4-root PVE node
 * (`fixtures/mounts/findmnt-root.json`): a READABLE mount table with no pool
 * at a system path. Since cr.60 (review L24) an unserved table tightens every
 * pool to a system pool ON ITS OWN — readable boot facts no longer stand in
 * for it — so the guard reads serve it too.
 */
export function capturedRootMountTable(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/mounts/findmnt-root.json'), 'utf-8')
}

/** Serve the guid, boot-facts and mount-table reads for `pool` from the captures (see the module note). */
export function servePoolGuardReads(mock: MockExecutor, pool = 'testpool'): void {
  const { guid, bootfs } = capturedPoolGet()
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'value', 'guid', '--', pool], result: { stdout: `${guid}\n`, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'name,value', 'bootfs'], result: { stdout: `${pool}\t${bootfs}\n`, stderr: '', exitCode: 0 } })
  mock.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: capturedRootMountTable(), stderr: '', exitCode: 0 } })
}
