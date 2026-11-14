import type { SetAccessRequest } from '@anas/shared'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SetAccessRequest as SetAccessRequestSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { standInPins } from '../../routes/__tests__/real-path-echo.js'
import { guardCheck } from '../../safety/guard.js'
import { accessDirIo, createAccessService, PINNED_DIR } from '../access.js'

/** The real pin, kept to restore for the real-directory block. */
const REAL_IO = { ...accessDirIo }

/**
 * cr3.shares M3: an Apply restated every named ACL entry through the
 * three-level abstraction and forced `m::rwx` — a mask-clamped grant gained
 * write, `-w-` became `rwx`, `r--` became `r-x`, `--x` (traverse) became
 * `---` — and a base-only edit added a default ACL and the setgid bit. DESIGN
 * "Layered access": the daemon preserves the named grants. The review of the
 * first fix (cr3, 71740fc35) drove it with the body the PANEL sends — every
 * base level and every named row, always — so the write is decided from the
 * DIFFERENCE between what the editor read and what it sent.
 *
 * FIXTURE `acl/getfacl-pcE-dir-mask-clamped.txt` is verbatim `getfacl -pcE`
 * on a scratch directory (Fedora, acl 2.4.0) after
 *   setfacl --set u::rwx,g::r-x,o::r-x,u:root:--x,u:4242:rwx,g:4343:-w-,m::r-x <dir>
 *   setfacl -d --set u::rwx,g::r-x,o::r-x,u:4242:rwx,m::r-x <dir>
 * (numeric principals so the capture names nobody on the host). The second
 * block re-runs the planned argv with the REAL setfacl on a scratch tree and
 * reads the result back with getfacl; it skips where the acl tools or POSIX
 * ACLs on the temp filesystem are missing.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLAMPED = readFileSync(join(__dirname, '../../fixtures/acl/getfacl-pcE-dir-mask-clamped.txt'), 'utf8')
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
const DIR = '/srv/share/team'

function service(dir: string, acl: string, mode = '755') {
  const ex = new MockExecutor()
  ex.addFixture({ command: '/usr/bin/stat', result: ok(`root root ${mode}\n`) })
  ex.addFixture({ command: '/usr/bin/realpath', args: ['-e', '--', dir], result: ok(`${dir}\n`) })
  ex.addFixture({ command: '/usr/bin/getfacl', args: ['--version'], result: ok('getfacl 2.4.0\n') })
  // The share door asks the PVE footprint (sharePathVerdict): a node with no
  // ZFS datasets, read successfully. An unanswered `zfs list` is cannot-see.
  ex.addFixture({ command: '/usr/sbin/zfs', result: ok('') })
  ex.addFixture({ command: '/usr/bin/getfacl', result: ok(acl) })
  for (const w of ['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown'])
    ex.addFixture({ command: w, result: ok('') })
  return { ex, acc: createAccessService({ executor: ex, pveStorageCfg: join(__dirname, 'no-such-storage.cfg') }) }
}

async function run(dir: string, acl: string, req: SetAccessRequest, mode = '755') {
  const { ex, acc } = service(dir, acl, mode)
  const planned = await acc.planSetAccess({ kind: 'share', path: dir, home: null }, req)
  assert.ok(planned.ok, JSON.stringify(planned))
  const result = await acc.runSetAccess(planned.value, () => {})
  return { result, calls: ex.calls.filter(c => ['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown'].includes(c.command)) }
}

describe('an Apply never rewrites what the operator did not touch (cr3.shares M3)', () => {
  // The fake path has no inode on the test host: a stand-in pin (H2).
  before(() => standInPins())

  it('the editor reads each group-class principal at what the mask lets it do', async () => {
    const { acc } = service(DIR, CLAMPED)
    const read = await acc.readAccess({ kind: 'share', path: DIR, home: null })
    assert.ok(read.ok)
    assert.deepEqual(read.value.entries.map(e => [e.kind, e.name ?? '', e.level]), [
      ['owner', '', 'read-write'],
      ['owning-group', '', 'read'],
      ['everyone', '', 'read'],
      ['user', 'root', 'none'],
      ['user', '4242', 'read'], // granted rwx, mask r-x
      ['group', '4343', 'none'], // granted -w-, mask r-x
    ])
  })

  /**
   * What the panel sends: every base level and every named row, as read —
   * each untouched named row echoing the bits the GET gave it (third review
   * D3).
   */
  const PANEL: SetAccessRequest = { entries: [
    { kind: 'owner', level: 'read-write' },
    { kind: 'owning-group', level: 'read' },
    { kind: 'everyone', level: 'read' },
    { kind: 'user', name: 'root', level: 'none', perms: '--x' },
    { kind: 'user', name: '4242', level: 'read', perms: 'r-x' },
    { kind: 'group', name: '4343', level: 'none', perms: '---' },
  ] }
  /** The same body from an older panel or the API: no bits. */
  const NO_BITS: SetAccessRequest = { entries: PANEL.entries!.map(({ perms: _p, ...e }) => e) }
  const withEntries = (f: (e: NonNullable<SetAccessRequest['entries']>) => NonNullable<SetAccessRequest['entries']>): SetAccessRequest => ({ entries: f(PANEL.entries!.map(e => ({ ...e }))) })
  /** The panel's body for a row the operator changed: its level, no bits. */
  const edited = (e: NonNullable<SetAccessRequest['entries']>[number], level: 'none' | 'read' | 'read-write') => {
    const { perms: _p, ...rest } = e
    return { ...rest, level }
  }

  // A row whose live bits are not exactly its level's (`u:root:--x` reads as
  // none, whose bits are `---`) is CUSTOM: the GET carries the bits (second
  // review), and — third review D3 — the panel echoes them for an untouched
  // row, which then stays exactly as it is.
  it('the GET carries each row\'s live bits (custom rows are visible) and a read revision', async () => {
    const { acc } = service(DIR, CLAMPED)
    const read = await acc.readAccess({ kind: 'share', path: DIR, home: null })
    assert.ok(read.ok)
    assert.deepEqual(read.value.entries.map(e => [e.name ?? e.kind, e.perms]), [
      ['owner', 'rwx'],
      ['owning-group', 'r-x'],
      ['everyone', 'r-x'],
      ['root', '--x'],
      ['4242', 'r-x'],
      ['4343', '---'],
    ])
    assert.match(read.value.revision ?? '', /^[0-9a-f]{64}$/)
  })

  it('"change nothing" on a directory with no custom row runs no command and says so', async () => {
    const CANON = CLAMPED.replace('user:root:--x\n', '')
    const body = withEntries(e => e.filter(x => x.name !== 'root'))
    const { calls, result } = await run(DIR, CANON, body)
    assert.deepEqual(calls, [])
    assert.equal(result.nothingChanged, true)
  })

  // Third review D3: was "a custom row the body names is restated" — the
  // panel's untouched dialog now runs NO command, custom rows included.
  it('the panel\'s untouched dialog runs no command, a custom row included (its bits echoed)', async () => {
    const { calls, result } = await run(DIR, CLAMPED, PANEL)
    assert.deepEqual(calls, [])
    assert.equal(result.nothingChanged, true)
  })

  it('a body WITHOUT bits (an older panel, the API) restates a custom row at its level', async () => {
    const { calls } = await run(DIR, CLAMPED, NO_BITS)
    assert.deepEqual(calls.map(c => [c.command, ...c.args]), [
      ['/usr/bin/setfacl', '--set', 'u::rwx,g::r-x,o::r-x,u:root:---,u:4242:r-x,g:4343:---,m::r-x', '--', PINNED_DIR],
    ])
  })

  it('everyone -> none: the access ACL, and the SAME base entry of the existing default ACL (second review)', async () => {
    const { calls } = await run(DIR, CLAMPED, withEntries(e => e.map(x => x.kind === 'everyone' ? { ...x, level: 'none' } : x)))
    assert.deepEqual(calls.map(c => [c.command, ...c.args]), [
      ['/usr/bin/setfacl', '--set', 'u::rwx,g::r-x,o::---,u:root:--x,u:4242:r-x,g:4343:---,m::r-x', '--', PINNED_DIR],
      // `default:other::` follows; the default entry the old default mask
      // clamped (4242 rwx under r-x) is restated at what it could do.
      ['/usr/bin/setfacl', '-d', '-m', 'o::---,u:4242:r-x', '--', PINNED_DIR],
    ])
  })

  it('a body with no named rows (#37) keeps every named entry\'s live bits, custom ones included', async () => {
    const { calls } = await run(DIR, CLAMPED, { entries: [{ kind: 'everyone', level: 'none' }] })
    assert.equal(calls[0].args[1], 'u::rwx,g::r-x,o::---,u:root:--x,u:4242:r-x,g:4343:---,m::r-x')
    assert.deepEqual(calls.map(c => c.args[0]), ['--set', '-d'])
  })

  it('adding one principal on a directory WITH a default ACL: its access and default entries, no setgid', async () => {
    const { calls } = await run(DIR, CLAMPED, withEntries(e => [...e, { kind: 'user', name: '5151', level: 'read-write' }]))
    assert.deepEqual(calls.map(c => [c.command, ...c.args]), [
      ['/usr/bin/setfacl', '--set', 'u::rwx,g::r-x,o::r-x,u:root:--x,u:4242:r-x,g:4343:---,u:5151:rwx,m::rwx', '--', PINNED_DIR],
      ['/usr/bin/setfacl', '-d', '-m', 'u:5151:rwx,u:4242:r-x', '--', PINNED_DIR],
    ])
  })

  it('adding one principal on a directory with NO default ACL establishes it (base + that principal) and sets setgid', async () => {
    const accessOnly = CLAMPED.split('\n').filter(l => !l.startsWith('default:')).join('\n')
    const { calls } = await run(DIR, accessOnly, withEntries(e => [...e, { kind: 'user', name: '5151', level: 'read-write' }]))
    assert.deepEqual(calls.map(c => [c.command, ...c.args]).slice(1), [
      ['/usr/bin/setfacl', '-d', '-m', 'u:5151:rwx,m::rwx', '--', PINNED_DIR],
      ['/usr/bin/chmod', 'g+s', '--', PINNED_DIR],
    ])
  })

  it('changing a principal with no default entry writes no default ACL and no setgid', async () => {
    const accessOnly = CLAMPED.split('\n').filter(l => !l.startsWith('default:')).join('\n')
    const { calls } = await run(DIR, accessOnly, withEntries(e => e.map(x => x.name === '4242' ? edited(x, 'read-write') : x)))
    assert.deepEqual(calls.map(c => c.args[0]), ['--set'])
  })

  it('removing one principal drops it from the access and the default ACL, nothing else', async () => {
    const { calls } = await run(DIR, CLAMPED, withEntries(e => e.filter(x => x.name !== '4242')))
    assert.deepEqual(calls.map(c => [c.command, ...c.args]), [
      ['/usr/bin/setfacl', '--set', 'u::rwx,g::r-x,o::r-x,u:root:--x,g:4343:---,m::r-x', '--', PINNED_DIR],
      ['/usr/bin/setfacl', '-n', '-d', '-x', 'u:4242', '--', PINNED_DIR],
    ])
  })

  it('a clear keeps a setgid bit the administrator set when the default ACL holds no named entry (second review)', async () => {
    const accessOnly = CLAMPED.split('\n').filter(l => !l.startsWith('default:')).join('\n')
    const { calls } = await run(DIR, accessOnly, { clearNamed: true, entries: [{ kind: 'owner', level: 'read-write' }] }, '2770')
    assert.equal(calls.some(c => c.command === '/usr/bin/chmod'), false, 'no g-s on a hand-set 2770')
  })

  // Third review N3: a clear NEVER removes setgid — ANAS cannot tell the bit
  // it set from one an administrator set, and a leftover one is harmless.
  // (Was: removing the last named entry of a default ACL ran `chmod g-s`.)
  it('a clear never removes setgid, even with the last named entry of a default ACL', async () => {
    const { calls } = await run(DIR, CLAMPED, { clearNamed: true, entries: [{ kind: 'owner', level: 'read-write' }] }, '2775')
    assert.equal(calls.some(c => c.command === '/usr/bin/chmod'), false)
  })

  it('a principal the operator moved gets the level\'s own perms; the others keep theirs', async () => {
    const { calls } = await run(DIR, CLAMPED, withEntries(e => e.map(x => x.name === 'root' ? edited(x, 'read') : x)))
    assert.equal(calls[0].args[1], 'u::rwx,g::r-x,o::r-x,u:root:r-x,u:4242:r-x,g:4343:---,m::r-x')
    // root has no default entry: no default write.
    assert.equal(calls.length, 1)
  })

  it('on plain mode 0751, "change nothing" runs no chmod (others keep traverse), and a moved level keeps the other digits', async () => {
    const base = { entries: [
      { kind: 'owner' as const, level: 'read-write' as const },
      { kind: 'owning-group' as const, level: 'read' as const },
      { kind: 'everyone' as const, level: 'none' as const },
    ] }
    const { calls: none } = await runPlain(DIR, '751', base)
    assert.deepEqual(none, [])
    const { calls: moved } = await runPlain(DIR, '751', { entries: [{ kind: 'owning-group', level: 'none' }, { kind: 'everyone', level: 'none' }] })
    assert.deepEqual(moved.map(c => c.args), [['701', '--', PINNED_DIR]])
  })
})

/** The same service with ACLs OFF on the directory (no live ACL, mode bits only). */
async function runPlain(dir: string, mode: string, req: SetAccessRequest) {
  const ex = new MockExecutor()
  ex.addFixture({ command: '/usr/bin/stat', result: ok(`root root ${mode}\n`) })
  ex.addFixture({ command: '/usr/bin/realpath', args: ['-e', '--', dir], result: ok(`${dir}\n`) })
  ex.addFixture({ command: '/usr/bin/getfacl', args: ['--version'], result: { stdout: '', stderr: 'not found', exitCode: 127 } })
  for (const w of ['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown'])
    ex.addFixture({ command: w, result: ok('') })
  const acc = createAccessService({ executor: ex, pveStorageCfg: join(__dirname, 'no-such-storage.cfg') })
  const planned = await acc.planSetAccess({ kind: 'share', path: dir, home: null }, req)
  assert.ok(planned.ok, JSON.stringify(planned))
  const result = await acc.runSetAccess(planned.value, () => {})
  return { result, calls: ex.calls.filter(c => ['/usr/bin/setfacl', '/usr/bin/chmod', '/usr/bin/chown'].includes(c.command)) }
}

// --- The panel's bodies on real directories (setfacl/getfacl/chmod) ----------
//
// The review's probe (t/review/m3-real.mts) as a permanent test: seven
// directory states × five panel edits, each run through the REAL tools with
// the pinned descriptor handed to the child exactly as the executor does.

const scratch = mkdtempSync(join(tmpdir(), 'anas-cr3-m3-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function aclTools(): boolean {
  try {
    const probe = join(scratch, 'probe')
    mkdirSync(probe)
    execFileSync('setfacl', ['-m', 'u:4242:r-x', '--', probe], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}
const HAVE_ACL = aclTools()

/** A real executor: runs the tool, the pinned descriptors handed to the child at fd 3, 4, ... */
const realExec = {
  calls: [] as { command: string, args: string[] }[],
  async exec(command: string, args: string[], opts?: { inheritedFds?: number[] }) {
    this.calls.push({ command, args })
    if (command === '/usr/bin/chown')
      return ok('') // not ours to run as a user
    const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', ...(opts?.inheritedFds ?? [])] })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 }
  },
}

/** principal → what it can do (group class clamped by its mask), plus the mode. */
function effective(dir: string): Record<string, string> {
  const raw: Record<string, string> = {}
  for (const line of execFileSync('getfacl', ['-pcn', '--', dir], { encoding: 'utf8' }).split('\n')) {
    if (!line || line.startsWith('#'))
      continue
    const e = line.split('\t')[0]
    raw[e.slice(0, e.lastIndexOf(':'))] = e.slice(e.lastIndexOf(':') + 1)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'mask:' || k === 'default:mask:')
      continue
    const mask = k.startsWith('default:') ? raw['default:mask:'] : raw['mask:']
    const groupClass = /(?:^|default:)(?:user:[^:]+|group:.*)$/.test(k)
    out[k] = groupClass && mask ? Array.from(v, (c, i) => mask[i] === '-' ? '-' : c).join('') : v
  }
  out.setgid = (Number.parseInt(execFileSync('stat', ['-c', '%a', '--', dir], { encoding: 'utf8' }).trim(), 8) & 0o2000) ? 'yes' : 'no'
  return out
}

const sf = (d: string, ...a: string[]) => execFileSync('setfacl', [...a, '--', d])
const STATES: Record<string, (d: string) => void> = {
  'plain 0755': d => execFileSync('chmod', ['0755', d]),
  'plain 0751': d => execFileSync('chmod', ['0751', d]),
  'ANAS shape': (d) => {
    sf(d, '--set', 'u::rwx,g::r-x,o::r-x,u:4242:rwx,g:4343:r-x,m::rwx')
    sf(d, '-d', '--set', 'u::rwx,g::r-x,o::r-x,u:4242:rwx,g:4343:r-x,m::rwx')
    execFileSync('chmod', ['g+s', d])
  },
  'restrictive mask + default': (d) => {
    sf(d, '--set', 'u::rwx,g::r-x,o::r-x,u:4242:rwx,g:4343:-w-,m::r-x')
    sf(d, '-d', '--set', 'u::rwx,g::r-x,o::r-x,u:4242:rwx,m::r-x')
  },
  'hand named, no default, no setgid': (d) => {
    execFileSync('chmod', ['0750', d])
    sf(d, '-m', 'u:4242:rwx,g:4343:r-x')
  },
  'default differs from access': (d) => {
    sf(d, '-m', 'u:4242:rwx')
    sf(d, '-d', '--set', 'u::rwx,g::r-x,o::---,u:5000:r-x,m::r-x')
  },
  'odd bits': d => sf(d, '--set', 'u::rwx,g::rw-,o::--x,u:4242:-w-,m::rwx'),
  // The third review's J row: traverse-only and a drop box.
  'custom traverse + drop box': d => sf(d, '--set', 'u::rwx,g::r-x,o::---,u:4242:--x,g:4343:-wx,m::rwx'),
  'hand setgid 2770, named, no default': (d) => {
    execFileSync('chmod', ['2770', d])
    sf(d, '-m', 'u:4242:rwx')
  },
}

type Entries = NonNullable<SetAccessRequest['entries']>
/** Each panel edit: the body change and the principals (getfacl keys) it may move. */
const EDITS: Record<string, (e: Entries) => { req: SetAccessRequest, moves: string[], grants: boolean }> = {
  'change nothing': e => ({ req: { entries: e }, moves: [], grants: false }),
  'grant 4242 read-write': (e) => {
    const has = e.some(x => x.name === '4242')
    // The operator changed this row: the panel sends its level and no bits.
    const entries = has ? e.map(({ perms: _p, ...x }) => x.name === '4242' ? { ...x, level: 'read-write' as const } : (_p ? { ...x, perms: _p } : x)) : [...e, { kind: 'user' as const, name: '4242', level: 'read-write' as const }]
    return { req: { entries }, moves: ['user:4242'], grants: true }
  },
  'remove the first named': (e) => {
    const gone = e.find(x => x.kind === 'user' || x.kind === 'group')
    if (!gone)
      return { req: { entries: e }, moves: [], grants: false }
    const entries = e.filter(x => x !== gone)
    const left = entries.some(x => x.kind === 'user' || x.kind === 'group')
    return { req: left ? { entries } : { entries, clearNamed: true }, moves: [`${gone.kind}:${gone.name}`], grants: false }
  },
  'everyone -> none': e => ({ req: { entries: e.map(x => x.kind === 'everyone' ? { ...x, level: 'none' as const } : x) }, moves: ['other:'], grants: false }),
}

describe('the panel\'s bodies on real directories (cr3.shares M3, the review probe)', { skip: HAVE_ACL ? false : 'no setfacl or no POSIX ACLs on the temp filesystem' }, () => {
  // The REAL pin: these directories exist.
  before(() => Object.assign(accessDirIo, REAL_IO))
  const acc = createAccessService({ executor: realExec as never, pveStorageCfg: join(scratch, 'none.cfg') })
  let n = 0
  for (const [state, setup] of Object.entries(STATES)) {
    for (const [edit, change] of Object.entries(EDITS)) {
      it(`[${state}] ${edit}: only what the edit names moves`, async () => {
        const dir = join(scratch, `d${n++}`)
        mkdirSync(dir)
        setup(dir)
        const before = effective(dir)
        const target = { kind: 'share' as const, path: dir, home: null }
        const read = await acc.readAccess(target)
        assert.ok(read.ok)
        // The panel's body: every row as read, each named row echoing its bits
        // (third review D3) — nothing the edit did not name moves, custom rows
        // included.
        const sent = read.value.entries.map(e => ({ kind: e.kind, ...(e.name ? { name: e.name } : {}), level: e.level, ...((e.kind === 'user' || e.kind === 'group') && e.perms ? { perms: e.perms } : {}) })) as Entries
        const { req, moves, grants } = change(sent)
        realExec.calls.length = 0
        const planned = await acc.planSetAccess(target, req)
        assert.ok(planned.ok, JSON.stringify(planned))
        const result = await acc.runSetAccess(planned.value, () => {})
        const after = effective(dir)
        if (moves.length === 0) {
          assert.deepEqual(realExec.calls.filter(c => ['/usr/bin/setfacl', '/usr/bin/chmod'].includes(c.command)), [], 'no command for an edit that moves nothing')
          assert.equal(result.nothingChanged, true)
        }
        const hadDefault = Object.keys(before).some(k => k.startsWith('default:'))
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (before[key] === after[key])
            continue
          const plain = key.replace(/^default:/, '')
          // getfacl -n prints ids: a moved principal's key may be numeric.
          const ok = moves.some(m => m === plain || (m === 'user:4242' && plain === 'user:4242'))
            // (i) A grant on a directory with NO default ACL establishes it
            // (its base entries + that principal) and sets setgid.
            || (grants && !hadDefault && (key.startsWith('default:') || key === 'setgid'))
          assert.ok(ok, `${key} moved (${before[key] ?? 'absent'} -> ${after[key] ?? 'absent'}) though "${edit}" never named it`)
        }
      })
    }
  }
})

// --- Second review: the stale edit, duplicate rows, the result's path --------
describe('an Apply made from a stale read is refused; a principal appears once (cr3.shares, second review)', () => {
  before(() => standInPins())

  it('a PUT carrying the GET\'s revision is refused 409 STATE_CHANGED when the ACL moved since; without one it behaves as before', async () => {
    const { acc: before } = service(DIR, CLAMPED)
    const read = await before.readAccess({ kind: 'share', path: DIR, home: null })
    assert.ok(read.ok)
    const seen = read.value.revision!
    // Another edit adds u:nobody between the GET and the PUT.
    const moved = CLAMPED.replace('group::r-x\n', 'user:nobody:r-x\ngroup::r-x\n')
    const { acc } = service(DIR, moved)
    const req = { entries: [{ kind: 'everyone' as const, level: 'none' as const }] }
    const spec = (r: SetAccessRequest) => acc.setAccessGuardSpec({ what: 'Share path', address: { path: DIR }, req: r, resolve: async () => ({ ok: true, value: { kind: 'share' as const, path: DIR, home: null } }) })
    const stale = await guardCheck(spec({ ...req, expectedRevision: seen }))
    assert.ok('refusal' in stale)
    if ('refusal' in stale) {
      assert.equal(stale.refusal.status, 409)
      assert.equal(stale.refusal.code, 'STATE_CHANGED')
      assert.match(stale.refusal.message, /reload/)
    }
    const fresh = await acc.readAccess({ kind: 'share', path: DIR, home: null })
    assert.ok(fresh.ok)
    assert.ok(!('refusal' in await guardCheck(spec({ ...req, expectedRevision: fresh.value.revision }))))
    assert.ok(!('refusal' in await guardCheck(spec(req))), 'no revision: today\'s behaviour')
  })

  it('the same user named two ways (a name and its numeric id) is refused 400 (third review N4)', async () => {
    const { ex, acc } = service(DIR, CLAMPED)
    const line = ok('alice:x:4242:4242:Alice:/home/alice:/usr/sbin/nologin\n')
    ex.prependFixture({ command: '/usr/bin/getent', args: ['passwd', 'alice'], result: line })
    ex.prependFixture({ command: '/usr/bin/getent', args: ['passwd', '4242'], result: line })
    const planned = await acc.planSetAccess({ kind: 'share', path: DIR, home: null }, { entries: [
      { kind: 'user', name: 'alice', level: 'read' },
      { kind: 'user', name: '4242', level: 'read-write' },
    ] })
    assert.equal(planned.ok, false)
    if (!planned.ok) {
      assert.equal(planned.failure.status, 400)
      assert.match(planned.failure.body.error.message, /'alice' and '4242' name the same user \(uid 4242\)/)
    }
  })

  it('two everyone rows are refused by the schema (third review N4)', () => {
    assert.equal(SetAccessRequestSchema.safeParse({ entries: [{ kind: 'everyone', level: 'none' }, { kind: 'everyone', level: 'read' }] }).success, false)
  })

  it('a body naming one principal twice is refused', () => {
    assert.equal(SetAccessRequestSchema.safeParse({ entries: [
      { kind: 'user', name: 'nobody', level: 'read' },
      { kind: 'user', name: 'nobody', level: 'read-write' },
    ] }).success, false)
    assert.equal(SetAccessRequestSchema.safeParse({ entries: [
      { kind: 'user', name: 'nobody', level: 'read' },
      { kind: 'group', name: 'nobody', level: 'read-write' },
    ] }).success, true, 'a user and a group of one name are two principals')
  })

  it('"nothing to change" names the path the operator named, not the resolved one (third review N6)', async () => {
    const CANON = CLAMPED.replace('user:root:--x\n', '')
    const { acc } = service('/srv/real', CANON)
    const planned = await acc.planSetAccess({ kind: 'share', path: '/srv/real', configuredPath: '/srv/link', home: null }, { entries: [{ kind: 'everyone', level: 'read' }] })
    assert.ok(planned.ok, JSON.stringify(planned))
    const result = await acc.runSetAccess(planned.value, () => {})
    assert.equal(result.nothingChanged, true)
    assert.match(String(result.message), /'\/srv\/link' already has/)
  })

  it('the job result names the configured path, and the resolved one beside it when they differ', async () => {
    const { acc } = service('/srv/real', CLAMPED)
    const planned = await acc.planSetAccess({ kind: 'share', path: '/srv/real', configuredPath: '/srv/link', home: null }, { entries: [{ kind: 'everyone', level: 'none' }] })
    assert.ok(planned.ok, JSON.stringify(planned))
    const result = await acc.runSetAccess(planned.value, () => {})
    assert.equal(result.path, '/srv/link')
    assert.equal(result.resolvedPath, '/srv/real')
  })
})
