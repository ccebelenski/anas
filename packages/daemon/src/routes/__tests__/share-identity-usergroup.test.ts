import type { Job, JobAccepted } from '@anas/shared'
import type { FastifyInstance } from 'fastify'
import type { ExecResult } from '../../executor/types.js'
import type { LockClaim } from '../../jobs/locks.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import { MockExecutor } from '../../executor/mock.js'
import { JobQueue } from '../../jobs/queue.js'
import { parseGroups, parsePasswd } from '../../parsers/getent.js'
import { ConfirmStore } from '../../safety/confirm.js'
import { groupRemovedWithUser, shareIdentityRoutes, userdelRemovesUserGroup } from '../share-identity.js'

/**
 * Story cr.29d — a user delete never removes a group behind the group-delete
 * gates.
 *
 * With `USERGROUPS_ENAB yes` (PVE 9.2's login.defs, probe P06) `userdel
 * <name>` also removes the group NAMED like the user when it is the user's
 * primary group, has no members once the user is dropped from every member
 * list, and is no other LOCAL account's primary group (shadow src/userdel.c,
 * update_groups → remove_usergroup, 4.19.0; cr.29e — the third check reads
 * the LOCAL passwd file, not the directory). userdel has no option to keep it
 * (its getopt string is `fhrR:P:Z`; `-K` is useradd's), so the user delete
 * names that group in its confirm, binds it as the confirm's scope, takes its
 * gid key and runs the group delete's band, primary-group and share
 * reference gates on it — the primary-group gate over ALL of NSS, so a
 * directory account's primary group makes the delete refuse (cr.29e) where
 * userdel alone would have orphaned it.
 *
 * FIXTURES: getent lines in the passwd(5)/group(5) shape the route tests use
 * (`name:x:uid:gid:gecos:home:shell`, `name:x:gid:members`); the PVE
 * login.defs line is probe P06's verbatim (`USERGROUPS_ENAB yes`). Accounts
 * in `Boot.directory` answer only the plain `getent passwd` — the shape of
 * an sssd/AD account on a node whose nsswitch consults the directory.
 */

const IDENTITY_HEADERS = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-privileges': 'Sys.Audit,Sys.Modify',
  'x-anas-request-id': randomUUID(),
}

/** carol: an ANAS user created with `primaryGroup: carol` (cr.29c) — uid 1004, primary gid 1005. */
const CAROL = 'carol:x:1004:1005::/home/carol:/usr/sbin/nologin'

const CLEAN_SMB_CONF = '[global]\nworkgroup = WORKGROUP\n\n[media]\npath = /tank/media\nvalid users = bob\n'

interface Boot {
  /** carol's passwd line (default {@link CAROL}). */
  carol?: string
  /** Extra passwd lines (other LOCAL accounts — in every answer). */
  passwd?: string[]
  /** Accounts only the plain `getent passwd` holds (directory: sssd/AD, cr.29e). */
  directory?: string[]
  /** The group file's carol line (default `carol:x:1005:` — empty). */
  group?: string
  /** A SEQUENCE of `getent -s files group` answers (route, route, job …). */
  groupFiles?: string[]
  /** A SEQUENCE of `getent -s files passwd` answers; `!` prefix = unreadable (cr.29e). */
  passwdFiles?: string[]
  smbConf?: string
  /** login.defs text; unset = the option is not passed (PVE's yes assumed). */
  loginDefs?: string
}

describe('cr.29d — the group userdel removes with a user', () => {
  let app: FastifyInstance | undefined
  let executor: MockExecutor
  let queue: JobQueue
  let tmpDir: string
  let submittedLocks: LockClaim[][]

  function groupFile(carolLine: string): string {
    return ['root:x:0:', 'users:x:100:', 'smbusers:x:1001:bob', carolLine, ''].join('\n')
  }

  async function boot(o: Boot = {}) {
    tmpDir = await mkdtemp(join(tmpdir(), 'anas-cr29d-'))
    const smbConfPath = join(tmpDir, 'smb.conf')
    writeFileSync(smbConfPath, o.smbConf ?? CLEAN_SMB_CONF)
    let loginDefsPath: string | undefined
    if (o.loginDefs !== undefined) {
      loginDefsPath = join(tmpDir, 'login.defs')
      writeFileSync(loginDefsPath, o.loginDefs)
    }
    const carol = o.carol ?? CAROL
    const filesLines = ['root:x:0:0:root:/root:/bin/bash', carol, ...(o.passwd ?? [])]
    const filesPasswd = [...filesLines, ''].join('\n')
    const passwd = [...filesLines, ...(o.directory ?? []), ''].join('\n')
    const groups = o.groupFiles ?? [groupFile(o.group ?? 'carol:x:1005:')]
    const passwdFiles = o.passwdFiles ?? [filesPasswd]
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
    const answer = (line: string): ExecResult => line.startsWith('!') ? { stdout: '', stderr: line.slice(1), exitCode: 1 } : ok(line)

    executor = new MockExecutor()
    queue = new JobQueue()
    submittedLocks = []
    const submit = queue.submit.bind(queue)
    queue.submit = ((...args: Parameters<JobQueue['submit']>) => {
      submittedLocks.push([...(args[3]?.locks ?? [])])
      return submit(...args)
    }) as JobQueue['submit']

    executor.addFixture({ command: '/usr/bin/getent', args: ['passwd'], result: ok(passwd) })
    executor.addFixture({ command: '/usr/bin/getent', args: ['group'], result: ok(groups[0]) })
    executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd'], results: passwdFiles.map(answer) })
    executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'group'], results: groups.map(answer) })
    executor.addFixture({ command: '/usr/bin/getent', args: ['passwd', 'carol'], result: ok(`${carol}\n`) })
    executor.addFixture({ command: '/usr/bin/getent', args: ['-s', 'files', 'passwd', 'carol'], result: ok(`${carol}\n`) })
    executor.addFixture({ command: '/usr/bin/pdbedit', args: ['-L'], result: ok('') })
    executor.addFixture({ command: '/usr/sbin/userdel', result: ok('') })

    app = Fastify({ logger: false })
    await app.register(shareIdentityRoutes, {
      prefix: '/v1',
      executor,
      jobQueue: queue,
      confirmStore: new ConfirmStore(),
      smbConfPath,
      exportsPath: join(tmpDir, 'absent-exports'),
      smbpasswdAvailable: async () => true,
      ...(loginDefsPath !== undefined ? { loginDefsPath } : {}),
    })
  }

  function del(confirm?: string) {
    const headers: Record<string, string> = { ...IDENTITY_HEADERS }
    if (confirm !== undefined)
      headers['x-anas-confirm'] = confirm
    return app!.inject({ method: 'DELETE', url: '/v1/identity/users/carol', headers })
  }

  async function settle(id: string): Promise<Job> {
    for (let i = 0; i < 50; i++) {
      const job = queue.get(id)
      if (job && (job.status === 'completed' || job.status === 'failed'))
        return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Job ${id} did not finish`)
  }

  const userdelRan = () => executor.calls.some(c => c.command === '/usr/sbin/userdel')

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('an empty primary group named like the user goes with it: the confirm names it, the job takes its gid key and reports it', async () => {
    await boot()
    const first = await del()
    assert.equal(first.statusCode, 409)
    const { error } = first.json() as { error: { code: string, message: string, warnings: string[] } }
    assert.equal(error.code, 'CONFIRMATION_REQUIRED')
    assert.match(error.message, /removes the account and its group 'carol'/)
    assert.ok(error.warnings.some(w => /^Its group 'carol' \(gid 1005\) will be removed too: it is the user's primary group, named like the user, and no other account uses it, so userdel removes it \(USERGROUPS_ENAB in \/etc\/login\.defs\)$/.test(w)), JSON.stringify(error.warnings))
    assert.ok(error.warnings.some(w => w.startsWith('Files owned by this group keep gid 1005.')))

    const ok = await del(first.headers['x-anas-confirm-code'] as string)
    assert.equal(ok.statusCode, 202)
    const job = await settle((ok.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.deepEqual(job.result, { deleted: 'carol', smbEntryRemoved: false, groupRemoved: 'carol' })
    // Plain `userdel carol` — no -f (which would skip userdel's own "another
    // account's primary group" check) and no -r.
    assert.deepEqual(executor.calls.filter(c => c.command === '/usr/sbin/userdel').map(c => c.args), [['carol']])
    assert.ok(submittedLocks[0].some(l => l.key === 'gid:1005'), JSON.stringify(submittedLocks[0]))
    assert.ok(submittedLocks[0].some(l => l.key === 'uid:1004'))
  })

  it('a group a share references is not removed by a user delete: 409 referenced-by-share, no confirm code, no job, no userdel', async () => {
    for (const ref of ['valid users = @carol', 'force group = carol', 'write list = +carol']) {
      await boot({ smbConf: `[global]\nworkgroup = WORKGROUP\n\n[media]\npath = /tank/media\n${ref}\n` })
      const res = await del()
      assert.equal(res.statusCode, 409, ref)
      const { error } = res.json() as { error: { code: string, reason: string, message: string } }
      assert.equal(error.code, 'CONFLICT', ref)
      assert.equal(error.reason, 'referenced-by-share', ref)
      assert.match(error.message, /^Deleting user 'carol' would also remove group 'carol' \(gid 1005\): userdel removes a user's same-named primary group when no other local account uses it, and that group cannot be deleted\. Group 'carol' is referenced by share\(s\): media/, ref)
      assert.equal(res.headers['x-anas-confirm-code'], undefined, ref)
      assert.equal(queue.list().length, 0, ref)
      assert.equal(userdelRan(), false, ref)
      await app?.close()
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('a same-named group outside the share band is refused the way the group delete refuses it (SYSTEM_ACCOUNT)', async () => {
    await boot({ carol: 'carol:x:1004:999::/home/carol:/usr/sbin/nologin', group: 'carol:x:999:' })
    const res = await del()
    assert.equal(res.statusCode, 409)
    const { error } = res.json() as { error: { code: string, message: string } }
    assert.equal(error.code, 'SYSTEM_ACCOUNT')
    assert.match(error.message, /would also remove group 'carol' \(gid 999\).*Group 'carol' \(gid 999\) is a system account/)
    assert.equal(queue.list().length, 0)
  })

  it('a same-named group userdel KEEPS is neither named nor gated — even when a share references it', async () => {
    const referenced = '[global]\nworkgroup = WORKGROUP\n\n[media]\npath = /tank/media\nvalid users = @carol\n'
    const kept: [string, Boot][] = [
      ['another member', { group: 'carol:x:1005:dave', passwd: ['dave:x:1007:100::/home/dave:/usr/sbin/nologin'] }],
      ['another account\'s primary group', { passwd: ['erin:x:1006:1005::/home/erin:/usr/sbin/nologin'] }],
      ['not the user\'s primary group (the -N default, users)', { carol: 'carol:x:1004:100::/home/carol:/usr/sbin/nologin' }],
      ['USERGROUPS_ENAB no', { loginDefs: '# login.defs\nUSERGROUPS_ENAB no\n' }],
    ]
    for (const [why, o] of kept) {
      await boot({ ...o, smbConf: referenced })
      const first = await del()
      const { error } = first.json() as { error: { code: string, message: string, warnings: string[] } }
      assert.equal(error.code, 'CONFIRMATION_REQUIRED', `${why}: ${error.message}`)
      assert.equal(error.warnings.some(w => /group 'carol'|keep gid/.test(w)), false, why)
      const ok = await del(first.headers['x-anas-confirm-code'] as string)
      assert.equal(ok.statusCode, 202, why)
      const job = await settle((ok.json() as JobAccepted).job.id)
      assert.deepEqual(job.result, { deleted: 'carol', smbEntryRemoved: false, groupRemoved: null }, why)
      assert.equal(submittedLocks[0].some(l => l.key.startsWith('gid:')), false, why)
      await app?.close()
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('a confirm that named no group does not open a delete that would now remove one (route door: the bound scope)', async () => {
    await boot({ groupFiles: [groupFile('carol:x:1005:dave'), groupFile('carol:x:1005:')], passwd: ['dave:x:1007:100::/home/dave:/usr/sbin/nologin'] })
    const first = await del()
    assert.equal(first.statusCode, 409)
    assert.equal((first.json() as { error: { warnings: string[] } }).error.warnings.some(w => /group 'carol'/.test(w)), false)
    // dave left the group between the confirm and the resend.
    const resend = await del(first.headers['x-anas-confirm-code'] as string)
    assert.equal(resend.statusCode, 409)
    assert.equal(queue.list().length, 0)
    assert.equal(userdelRan(), false)
  })

  it('…and the job door refuses STATE_CHANGED when the group became removable after the confirm', async () => {
    const kept = groupFile('carol:x:1005:dave')
    await boot({ groupFiles: [kept, kept, groupFile('carol:x:1005:')], passwd: ['dave:x:1007:100::/home/dave:/usr/sbin/nologin'] })
    const first = await del()
    const ok = await del(first.headers['x-anas-confirm-code'] as string)
    assert.equal(ok.statusCode, 202)
    const job = await settle((ok.json() as JobAccepted).job.id)
    assert.equal(job.status, 'failed')
    assert.match(job.error?.message ?? '', /changed since you confirmed \(was: none; now: 'carol' \(gid 1005\)\)/)
    assert.equal(userdelRan(), false)
  })

  it('a group file that cannot be read refuses (503), never a guess', async () => {
    await boot({ groupFiles: ['!getent: cannot open database'] })
    const res = await del()
    assert.equal(res.statusCode, 503)
    assert.match((res.json() as { error: { message: string } }).error.message, /could not read the local group file .* so it cannot tell whether deleting user 'carol' would also remove its group/)
    assert.equal(queue.list().length, 0)
  })

  it('cr.29e — a directory account holds the going group as its primary gid: the mirror says userdel removes it, the primary-group gate (ALL of NSS) refuses the delete', async () => {
    // adacct is visible to `getent passwd` but not to `getent -s files
    // passwd` — shadow 4.19.0 proven: userdel checks the LOCAL passwd file
    // only, sees nobody, and REMOVES the group. ANAS must not stand by
    // while that orphans adacct's primary gid, so the going group passes
    // the group delete's primary-group gate — reason 'primary-group-in-use'.
    await boot({ directory: ['adacct:x:2001:1005::/home/adacct:/usr/sbin/nologin'] })
    const res = await del()
    assert.equal(res.statusCode, 409)
    const { error } = res.json() as { error: { code: string, reason: string, message: string } }
    assert.equal(error.code, 'CONFLICT')
    assert.equal(error.reason, 'primary-group-in-use')
    assert.match(error.message, /^Deleting user 'carol' would also remove group 'carol' \(gid 1005\): userdel removes a user's same-named primary group when no other local account uses it, and that group cannot be deleted\. Group 'carol' is the primary group of: adacct\./)
    assert.equal(res.headers['x-anas-confirm-code'], undefined)
    assert.equal(queue.list().length, 0)
    assert.equal(userdelRan(), false)
  })

  it('cr.29e — the same primary gid held by a LOCAL account: userdel keeps the group — not named, not gated, no gid lock (pinned)', async () => {
    await boot({ passwd: ['erin:x:1006:1005::/home/erin:/usr/sbin/nologin'] })
    const first = await del()
    const { error } = first.json() as { error: { code: string, warnings: string[] } }
    assert.equal(error.code, 'CONFIRMATION_REQUIRED')
    assert.equal(error.warnings.some(w => /group 'carol'/.test(w)), false)
    const ok = await del(first.headers['x-anas-confirm-code'] as string)
    assert.equal(ok.statusCode, 202)
    const job = await settle((ok.json() as JobAccepted).job.id)
    assert.equal(job.status, 'completed')
    assert.deepEqual(job.result, { deleted: 'carol', smbEntryRemoved: false, groupRemoved: null })
    assert.equal(submittedLocks[0].some(l => l.key.startsWith('gid:')), false)
  })

  it('cr.29e — a local account file that cannot be read refuses (503), naming the local account file', async () => {
    await boot({ passwdFiles: ['!getent: cannot open database'] })
    const res = await del()
    assert.equal(res.statusCode, 503)
    assert.match((res.json() as { error: { message: string } }).error.message, /could not read the local account file \(getent -s files passwd\), so it cannot tell whether deleting user 'carol' would also remove its group 'carol'/)
    assert.equal(queue.list().length, 0)
    assert.equal(userdelRan(), false)
  })
})

describe('cr.29d — userdel\'s rule, mirrored', () => {
  it('login.defs USERGROUPS_ENAB: yes in any case or quoted, a later line wins, a comment is not a setting; unreadable/absent/unset read as yes (fail closed)', () => {
    assert.equal(userdelRemovesUserGroup('UID_MIN\t\t\t 1000\nUSERGROUPS_ENAB yes\n'), true)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB no\n'), false)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB "no"\n'), false)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB YES\n'), true)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB yes\nUSERGROUPS_ENAB no\n'), false)
    assert.equal(userdelRemovesUserGroup('#USERGROUPS_ENAB no\nUSERGROUPS_ENAB yes\n'), true)
    assert.equal(userdelRemovesUserGroup('# USERGROUPS_ENAB no\n'), true)
    assert.equal(userdelRemovesUserGroup(''), true)
    assert.equal(userdelRemovesUserGroup(null), true)
  })

  it('cr.29e — a trailing comment does not change the value: shadow\'s getdef strips `# …` before the value test', () => {
    // Proven against shadow 4.19.0: under `USERGROUPS_ENAB yes # note` the
    // real userdel REMOVED the group; ANAS had read the value as
    // `yes # note`, seen not-yes, and skipped every cr.29d gate.
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB yes # comment'), true)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB yes\t# comment'), true)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB "yes" # comment'), true)
    // The strip never turns a setting into its opposite, and a comment-only
    // line sets nothing (fail closed: yes).
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB no # keep it'), false)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB # note'), true)
    // A comment LINE and a quoted value stay exactly as pinned above.
    assert.equal(userdelRemovesUserGroup('# USERGROUPS_ENAB yes\nUSERGROUPS_ENAB no\n'), false)
    assert.equal(userdelRemovesUserGroup('USERGROUPS_ENAB "no"\n'), false)
  })

  it('remove_usergroup: named like the user, the user\'s primary gid, no member but the user, no other LOCAL account\'s primary group', () => {
    const [carol] = parsePasswd(`${CAROL}\n`)
    // cr.29e: this list is the LOCAL accounts (`getent -s files passwd`) —
    // userdel checks the local passwd file only. A directory account with
    // gid 1005 as its primary is NOT here and must not stop the mirror; it
    // is caught by the delete's primary-group gate (route test above).
    const users = parsePasswd(`root:x:0:0:root:/root:/bin/bash\n${CAROL}\n`)
    const g = (line: string) => parseGroups(`${line}\n`)[0]
    assert.equal(groupRemovedWithUser(carol, g('carol:x:1005:'), users)?.name, 'carol')
    // The user is dropped from every member list BEFORE the check (update_groups → remove_usergroup).
    assert.equal(groupRemovedWithUser(carol, g('carol:x:1005:carol'), users)?.name, 'carol')
    assert.equal(groupRemovedWithUser(carol, g('carol:x:1005:carol,dave'), users), null)
    assert.equal(groupRemovedWithUser(carol, g('carol:x:1006:'), users), null)
    assert.equal(groupRemovedWithUser(carol, g('Carol:x:1005:'), users), null)
    assert.equal(groupRemovedWithUser(carol, undefined, users), null)
    const erin = parsePasswd('erin:x:1006:1005::/home/erin:/usr/sbin/nologin\n')
    assert.equal(groupRemovedWithUser(carol, g('carol:x:1005:'), [...users, ...erin]), null)
  })
})
