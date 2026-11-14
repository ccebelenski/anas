import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * cr3.shares, fourth and fifth reviews: the REAL walk helper
 * (services/anas-acl-walk.pl) against the REAL tools, under swappers —
 * renameat2(RENAME_EXCHANGE) in a loop flipping a file and a directory of the
 * tree with a link to a victim OUTSIDE it (the review's own swap). One test
 * per step, each a stream of walks for a few seconds; after every walk the
 * victims (a file, a directory and a file inside it) must be exactly as
 * before: mode, owner, group, ACL and default ACL. The review's findings were
 * exactly these races:
 *   D-C  acl 2.3.2 `setfacl -P` followed a swapped link (steps acl, default
 *        ACL, clear);
 *   D-B  coreutils 9.7 `chmod -h` raced (steps setgid, mode).
 *
 * WHERE (fifth review (g)): every race runs on a tmpfs mounted in a private
 * user + mount namespace (`unshare --map-auto --map-root-user -m`), never on
 * whatever TMPDIR is: on btrfs, readdir hides exchanged pairs and a mutant
 * survived 8 s there. As the namespace's root the helper runs as it does on
 * the node, and the ownership step changes a real owner and group.
 *
 * Tool sets: the host's /usr/bin tools always; a second set when
 * ANAS_ACL_WALK_ALT_TOOLS names a directory holding `chown`, `chmod` and
 * `setfacl` (the review ran acl 2.3.2 and coreutils 9.7 — the PVE 9 versions
 * — that way). ANAS_ACL_WALK_RACE_SECONDS lengthens each stream.
 *
 * The MUTANT — the helper made to name each entry `./name` in its directory
 * (what find -execdir did) instead of its pinned descriptor — must lose the
 * race: that is the test's proof that it can see the defect at all.
 *
 * Also here: the helper's perl unit tests (anas-acl-walk.t, through prove).
 */

const HELPER = fileURLToPath(new URL('../anas-acl-walk.pl', import.meta.url))
const PERL_TESTS = fileURLToPath(new URL('./anas-acl-walk.t', import.meta.url))
const SECONDS = Number(process.env.ANAS_ACL_WALK_RACE_SECONDS ?? '1.5')
const MUTANT_SECONDS = 20
/** A group the namespace's root can give a file (mapped by --map-auto). */
const OTHER_GID = 100

const scratch = mkdtempSync(join(tmpdir(), 'anas-cr3-aclwalk-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * The race, run INSIDE the namespace on its private tmpfs: build the tree and
 * the victims, start the swappers, walk again and again, and print one JSON
 * line { runs, hits, swapped }. argv: base secs ops-json tools-json helper
 * stop-at-first-hit.
 */
const DRIVER = String.raw`import ctypes, json, os, subprocess, sys, time, stat
base, secs, ops, tools, helper, stop_first = sys.argv[1], float(sys.argv[2]), json.loads(sys.argv[3]), json.loads(sys.argv[4]), sys.argv[5], sys.argv[6] == '1'
R, V = base + '/share', base + '/victim'
os.makedirs(R); os.makedirs(V + '/dir')
VF, VD, VI = V + '/secret', V + '/dir', V + '/dir/inner'
open(VF, 'w').write('x'); open(VI, 'w').write('y')
for i in range(40):
    open('%s/f%d' % (R, i), 'w').close(); os.mkdir('%s/d%d' % (R, i)); open('%s/d%d/x' % (R, i), 'w').close()
pairs = []
for k in range(3):
    a = '%s/swapf%d' % (R, k); open(a, 'w').close(); os.symlink(VF, '%s/.lf%d' % (R, k)); pairs.append((a, '%s/.lf%d' % (R, k)))
    a = '%s/swapd%d' % (R, k); os.mkdir(a); os.symlink(VD, '%s/.ld%d' % (R, k)); pairs.append((a, '%s/.ld%d' % (R, k)))
victims = [VF, VD, VI]
fds = {v: os.open(v, os.O_PATH | os.O_NOFOLLOW) for v in victims}
def at(v): return '/proc/self/fd/%d' % fds[v]
def reset():
    for v in victims:
        os.chown(at(v), 0, 0)
        os.chmod(at(v), 0o700 if v == VD else 0o600)
        subprocess.run(['setfacl', '-b', '-k', '--', at(v)], pass_fds=list(fds.values()))
        if ops.get('clear') is True:
            subprocess.run(['setfacl', '-m', 'u:nobody:r--', '--', at(v)], pass_fds=list(fds.values()))
def xa(p, n):
    try: return os.getxattr(p, n).hex()
    except OSError: return None
def snap():
    out = []
    for v in victims:
        st = os.stat(at(v))
        out.append((st.st_mode, st.st_uid, st.st_gid, xa(at(v), 'system.posix_acl_access'), xa(at(v), 'system.posix_acl_default') if stat.S_ISDIR(st.st_mode) else None))
    return out
SWAP = '''import ctypes, sys, time
libc = ctypes.CDLL(None, use_errno=True)
a, b, end = sys.argv[1].encode(), sys.argv[2].encode(), time.time() + float(sys.argv[3])
while time.time() < end:
    libc.renameat2(-100, a, -100, b, 2)
'''
reset(); before = snap()
procs = [subprocess.Popen([sys.executable, '-I', '-c', SWAP, a, b, str(secs + 2)]) for a, b in pairs]
time.sleep(0.05)
runs = hits = swapped = 0
end = time.time() + secs
while time.time() < end:
    rootfd = os.open(R, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    st = os.fstat(rootfd)
    job = dict({'roots': [{'fd': 3, 'path': R, 'dev': st.st_dev, 'ino': st.st_ino}], 'tools': tools}, **ops)
    p = subprocess.run(['/usr/bin/perl', helper], input=json.dumps(job).encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=False, preexec_fn=lambda: os.dup2(rootfd, 3))
    os.close(rootfd)
    try:
        r = json.loads(p.stdout.decode('utf-8', 'replace').strip().splitlines()[-1])
    except Exception:
        r = {}
    if r.get('done'): runs += 1
    swapped += r.get('swapped', 0)
    if snap() != before:
        hits += 1
        if stop_first: break
        reset(); before = snap()
for pr in procs: pr.kill()
print(json.dumps({'runs': runs, 'hits': hits, 'swapped': swapped}))
`

const NS = ['--map-auto', '--map-root-user', '-m']

function can(): string | false {
  const probe = join(scratch, 'probe')
  mkdirSync(probe)
  const r = spawnSync('unshare', [...NS, 'sh', '-c', 'mount -t tmpfs tmpfs "$1" && touch "$1/f" && chgrp 100 "$1/f" && setfacl -m u:nobody:r-- "$1/f" && python3 -c "import ctypes" && perl -MJSON::PP -e 1', 'sh', probe], { encoding: 'utf8' })
  return r.status === 0
    ? false
    : 'needs unprivileged user+mount namespaces (unshare --map-auto --map-root-user -m) with tmpfs and ACLs, python3 (the swapper) and perl: the race runs on a private tmpfs, never on TMPDIR (on btrfs readdir hides exchanged pairs: a mutant survived 8 s there)'
}
const SKIP = can()

interface Tools { chown: string, chmod: string, setfacl: string }
const TOOLSETS: [string, Tools][] = [['host', { chown: '/usr/bin/chown', chmod: '/usr/bin/chmod', setfacl: '/usr/bin/setfacl' }]]
if (process.env.ANAS_ACL_WALK_ALT_TOOLS) {
  const d = process.env.ANAS_ACL_WALK_ALT_TOOLS
  TOOLSETS.push([`alt (${d})`, { chown: join(d, 'chown'), chmod: join(d, 'chmod'), setfacl: join(d, 'setfacl') }])
}

let raceN = 0
/** One stream of walks under the swappers, in a fresh private tmpfs. */
function race(helper: string, ops: Record<string, unknown>, tools: Tools, seconds: number, stopAtFirstHit = false): { runs: number, hits: number, swapped: number } {
  const base = join(scratch, `race${raceN++}`)
  mkdirSync(base)
  const r = spawnSync('unshare', [...NS, 'sh', '-c', 'mount -t tmpfs tmpfs "$1" && exec python3 -I -c "$2" "$1" "$3" "$4" "$5" "$6" "$7"', 'sh', base, DRIVER, String(seconds), JSON.stringify(ops), JSON.stringify(tools), helper, stopAtFirstHit ? '1' : '0'], { encoding: 'utf8', timeout: (seconds + 120) * 1000 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as { runs: number, hits: number, swapped: number }
}

const STEPS: [string, Record<string, unknown>][] = [
  ['access ACL (setfacl -b -m)', { acl: 'u::rwX,g::rX,o::-,u:nobody:rwX,m::rwX' }],
  ['default ACL (setfacl -d --set)', { defaultAcl: 'u::rwx,g::r-x,o::---,u:nobody:rwx,m::rwx' }],
  ['setgid (chmod g+s)', { setgid: true }],
  ['clear (setfacl -b -k)', { clear: true }],
  ['mode (chmod u=rwX,g=rwX,o=rwX)', { mode: 'u=rwX,g=rwX,o=rwX' }],
  ['ownership (chown 4242:100, as root)', { chown: `4242:${OTHER_GID}` }],
]

describe('anas-acl-walk under swappers, on a private tmpfs: no victim outside the tree ever changes (cr3.shares, fourth review D-B/D-C, fifth review (g))', { skip: SKIP }, () => {
  for (const [label, tools] of TOOLSETS) {
    for (const [step, ops] of STEPS) {
      it(`${label}: ${step} — ${SECONDS} s of walks`, (t) => {
        const r = race(HELPER, ops, tools, SECONDS)
        t.diagnostic(`runs ${r.runs}, entries left alone as swapped ${r.swapped}, victim changes ${r.hits}`)
        assert.ok(r.runs > 0, 'the walk completed at least once under the swap')
        assert.equal(r.hits, 0, `a victim outside the tree changed after ${r.hits} of ${r.runs} walks`)
      })
    }
  }

  it('the MUTANT that names ./name instead of the pinned descriptor loses the race (the test can see the defect)', (t) => {
    const src = readFileSync(HELPER, 'utf8')
    const operand = 'my @argv = (@$argv, map { "/proc/self/fd/$_" } @fds);'
    const batch = 'flush($st) if @{ $st->{batch} } >= $st->{batchMax};'
    assert.equal(src.split(operand).length, 2, 'the operand line is where the mutant expects it')
    assert.equal(src.split(batch).length, 2, 'the batch flush is where the mutant expects it')
    const mutant = join(scratch, 'mutant.pl')
    writeFileSync(mutant, src
      .replace(operand, 'my @argv = (@$argv, map { $_->{fh} ? "./$_->{name}" : "/proc/self/fd/$_->{fd}" } @$members);')
      .replace(batch, 'flush($st);'))
    const r = race(mutant, STEPS[0][1], TOOLSETS[0][1], MUTANT_SECONDS, true)
    t.diagnostic(`mutant: ${r.hits > 0 ? 'victim changed' : 'no victim change'} after ${r.runs} walks`)
    assert.ok(r.hits > 0, `the mutant never reached a victim in ${r.runs} walks — the race test would not see the defect`)
  })
})

describe('the helper\'s own unit tests (anas-acl-walk.t)', () => {
  it('pass', { skip: spawnSync('prove', ['--version']).status === 0 ? false : 'needs prove' }, () => {
    const r = spawnSync('prove', [PERL_TESTS], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  })
})
