import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { guardCheck, reverify } from '../../safety/guard.js'
import { accessDirIo, createAccessService } from '../access.js'

/**
 * cr3.shares H2 (the review's symlink probe): a share path whose final — or
 * any — component is a symbolic link planted by a user of an enclosing
 * writable share. The writer runs as root and the PVE gates judge the path,
 * so a link to `/etc` would have had the next Apply chown, chmod g+s and
 * setfacl `/etc`. The daemon resolves a share path ONCE, by its own
 * safe-path walk (second review): a link the test user made is a share
 * user's link and is never followed. The tree is real (this test runs as an
 * ordinary user, so every link in it is a user's link).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ACL_NO_NAMED = readFileSync(join(__dirname, '../../fixtures/acl/getfacl-pcE-dir-no-named.txt'), 'utf8')
const WRITERS = new Set(['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown', '/usr/sbin/zfs'])
/** A call that changes something: a writer, or `zfs set` (a `zfs list` is a read). */
const isWrite = (c: { command: string, args: string[] }): boolean => WRITERS.has(c.command) && (c.command !== '/usr/sbin/zfs' || c.args[0] === 'set')
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })

const scratch = mkdtempSync(join(tmpdir(), 'anas-cr3-h2-'))
mkdirSync(join(scratch, 'victim'))
mkdirSync(join(scratch, 'share', 'plain'), { recursive: true })
mkdirSync(join(scratch, 'elsewhere', 'deep'), { recursive: true })
symlinkSync(join(scratch, 'victim'), join(scratch, 'share', 'projects'))
symlinkSync(join(scratch, 'elsewhere'), join(scratch, 'share', 'team'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function service() {
  const ex = new MockExecutor()
  ex.addFixture({ command: '/usr/bin/stat', result: ok('alice users 755\n') })
  ex.addFixture({ command: '/usr/bin/getfacl', args: ['--version'], result: ok('getfacl 2.3.2\n') })
  // A readable mount list with nothing at the scratch tree: the footprint's
  // positive "no claim" (a failed read would refuse, cr3.shares M4).
  ex.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-H', '-o', 'name,mountpoint'], result: ok('tank\t/tank\n') })
  ex.addFixture({ command: '/usr/bin/getfacl', result: ok(ACL_NO_NAMED) })
  // No AHR pool on this "node" (an empty /proc/mdstat), no findmnt answer needed.
  ex.addFixture({ command: '/usr/bin/cat', result: ok('Personalities : \nunused devices: <none>\n') })
  for (const w of WRITERS)
    ex.addFixture({ command: w, result: ok('') })
  return { ex, acc: createAccessService({ executor: ex, pveStorageCfg: join(scratch, 'no-storage.cfg') }) }
}

const GRANT = { owner: 'alice', entries: [{ kind: 'user' as const, name: 'alice', level: 'read-write' as const }] }

describe('the permissions writer never follows a share user\'s symbolic link (cr3.shares H2)', () => {
  it('a symlinked final component is refused 409 before anything is written, naming the link', async () => {
    const path = join(scratch, 'share', 'projects')
    const { ex, acc } = service()
    const target = await acc.resolveShareTarget(path)
    const planned = await acc.planSetAccess(target, GRANT)
    assert.equal(planned.ok, false)
    if (planned.ok)
      return
    assert.equal(planned.failure.status, 409)
    assert.match(planned.failure.body.error.message, new RegExp(`symbolic link '${path.replace(/[/.]/g, '\\$&')}'`))
    assert.deepEqual(ex.calls.filter(isWrite), [])
  })

  it('a link in an earlier component is refused the same way', async () => {
    const { acc } = service()
    const planned = await acc.planSetAccess(await acc.resolveShareTarget(join(scratch, 'share', 'team', 'deep')), GRANT)
    assert.equal(planned.ok ? 200 : planned.failure.status, 409)
  })

  it('a path that does not resolve is refused, never assumed plain', async () => {
    const { acc } = service()
    const planned = await acc.planSetAccess(await acc.resolveShareTarget(join(scratch, 'share', 'gone')), GRANT)
    assert.equal(planned.ok, false)
    if (!planned.ok)
      assert.match(planned.failure.body.error.message, /does not exist/)
  })

  it('control: a plain directory plans', async () => {
    const { acc } = service()
    const planned = await acc.planSetAccess(await acc.resolveShareTarget(join(scratch, 'share', 'plain')), GRANT)
    assert.equal(planned.ok, true)
  })

  it('a link swapped in after the route passed fails the JOB before any write', async () => {
    const path = join(scratch, 'share', 'swapped')
    mkdirSync(path)
    const { ex, acc } = service()
    const spec = acc.setAccessGuardSpec({
      what: `Share path '${path}'`,
      address: { path },
      req: GRANT,
      resolve: async () => ({ ok: true, value: await acc.resolveShareTarget(path) }),
    })
    const pre = await guardCheck(spec)
    assert.ok(!('refusal' in pre), JSON.stringify(pre))
    if ('refusal' in pre)
      return
    // A share user swaps the directory for a link to the victim.
    renameSync(path, `${path}.moved`)
    symlinkSync(join(scratch, 'victim'), path)
    // The job's own walk refuses the user's link: its plan no longer binds.
    await assert.rejects(reverify(spec, pre.bound), /nothing was done|symbolic link/)
    assert.deepEqual(ex.calls.filter(isWrite), [])
  })
})

describe('the share path is probed before the in-process walk (cr3.shares, third review N7, N6)', () => {
  it('a path whose bounded stat does not answer is refused "not answering", and the walk never runs', async () => {
    const { ex, acc } = service()
    const path = join(scratch, 'share', 'plain')
    // The captured `timeout 2 stat -f` answer for a dead hard NFS mount (124).
    ex.prependFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 124 } })
    let walked = false
    const realLstat = accessDirIo.lstat
    accessDirIo.lstat = async (p: string) => {
      walked = true
      return realLstat(p)
    }
    try {
      const target = await acc.resolveShareTarget(path)
      assert.match(target.pathRefusal ?? '', /is not answering/)
      assert.equal(walked, false, 'no lstat ran in the daemon')
    }
    finally {
      accessDirIo.lstat = realLstat
    }
  })
})
