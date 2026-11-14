/**
 * Run INSIDE a private user + mount namespace by access-boundary-ns.test.ts
 * (fifth review D2, D6): the REAL planner and writer, the real executor and
 * the real walk helper, over a tmpfs share root the namespace owns. Prints
 * one JSON line. argv: share-root case — the case says what happens to the
 * mounts between the plan and the walk:
 *   count  the plan excludes share/m; before the walk m is unmounted and a
 *          filesystem nobody named is mounted at share/x (the review's
 *          count.mts: the kernel hands it m's mount id back);
 *   bind   share/bind is a bind mount of a directory OUTSIDE the share, on
 *          the same filesystem; nothing moves.
 */
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ProdExecutor } from '../../executor/prod.js'
import { createAccessService } from '../access.js'

const [R, CASE] = process.argv.slice(2)
const HELPER = fileURLToPath(new URL('../anas-acl-walk.pl', import.meta.url))
const real = new ProdExecutor()
const executor = {
  exec(command: string, args: string[], opts?: Record<string, unknown>) {
    if (command === '/usr/bin/perl' && CASE === 'count') {
      spawnSync('umount', [`${R}/m`])
      spawnSync('mount', ['-t', 'tmpfs', 'tmpfs', `${R}/x`])
      spawnSync('mkdir', [`${R}/x/in`])
      spawnSync('chmod', ['700', `${R}/x`, `${R}/x/in`])
    }
    return real.exec(command, args, opts as never)
  },
}
const acc = createAccessService({ executor: executor as never, pveStorageCfg: `${R}/../none.cfg`, aclWalkScript: HELPER })
const planned = await acc.planSetAccess({ kind: 'share', path: R, home: null }, { applyToExisting: true, entries: [{ kind: 'everyone', level: 'read-write' }] })
if (!planned.ok) {
  process.stdout.write(`${JSON.stringify({ refused: planned.failure.body.error.message })}\n`)
}
else {
  const out = await acc.runSetAccess(planned.value, () => {})
  const mode = (p: string): string => (statSync(p).mode & 0o7777).toString(8)
  const after = CASE === 'count' ? { x: mode(`${R}/x`), xin: mode(`${R}/x/in`) } : {}
  process.stdout.write(`${JSON.stringify({ incomplete: out.incomplete ?? false, message: out.message ?? '', notChanged: out.notChanged, ...after })}\n`)
}
