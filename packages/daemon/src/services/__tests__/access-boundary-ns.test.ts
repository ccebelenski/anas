import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * cr3.shares D2 (third review), fourth review: the walk's boundary is the
 * DEVICE. The review's prune probe, for real, in a private user + mount
 * namespace (`unshare -rm` — nothing outside it changes), driving the REAL
 * walk helper (services/anas-acl-walk.pl) exactly as the writer runs it: the
 * share root opened at fd 3, the job on stdin.
 *
 * Every filesystem is created inside the namespace (a tmpfs scratch, a tmpfs
 * share root, the foreign mount), so the test does not depend on what
 * TMPDIR sits on. Below the share root a FOREIGN mount — of a DIFFERENT type
 * (overlay) and of the SAME type (another tmpfs) — with and without the
 * share user renaming its ancestor (which defeated find's by-name prune):
 * nothing of the foreign mount is touched, its top directory included (the
 * third review's named residue is gone), and the share's own file is.
 */

const HELPER = fileURLToPath(new URL('../anas-acl-walk.pl', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'anas-cr3-ns-'))
after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function canUnshare(): string | false {
  const r = spawnSync('unshare', ['-rm', 'sh', '-c', 'mount -t tmpfs tmpfs "$1" && mkdir -p "$1/L" "$1/U" "$1/W" "$1/m" && mount -t overlay overlay -o "lowerdir=$1/L,upperdir=$1/U,workdir=$1/W" "$1/m" && touch "$1/f" && setfacl -m u:0:rwx "$1/f"', 'sh', scratch], { encoding: 'utf8' })
  if (r.status !== 0)
    return `needs unprivileged user+mount namespaces with tmpfs, overlay and ACLs (unshare -rm): ${r.stderr.trim() || r.status}`
  return spawnSync('perl', ['-MJSON::PP', '-e', '1']).status === 0 ? false : 'needs perl with JSON::PP'
}
const SKIP = canUnshare()

/** In the namespace: build the tree, mount, optionally rename, run the helper at fd 3, print what changed. */
const SCRIPT = `set -e
D="$1"; FOREIGN="$2"; RENAME="$3"; HELPER="$4"
mount -t tmpfs tmpfs "$D"
mkdir -p "$D/share" && mount -t tmpfs tmpfs "$D/share"
mkdir -p "$D/share/media/mnt" "$D/L" "$D/U" "$D/W"
if [ "$FOREIGN" = overlay ]; then mount -t overlay overlay -o "lowerdir=$D/L,upperdir=$D/U,workdir=$D/W" "$D/share/media/mnt"; else mount -t tmpfs tmpfs "$D/share/media/mnt"; fi
mkdir "$D/share/media/mnt/inner"; echo x > "$D/share/media/mnt/inner/file"
chmod 755 "$D/share/media/mnt" "$D/share/media/mnt/inner"; chmod 644 "$D/share/media/mnt/inner/file"
echo y > "$D/share/own"; chmod 644 "$D/share/own"
M="$D/share/media/mnt"
if [ "$RENAME" = yes ]; then mv "$D/share/media" "$D/share/media2"; M="$D/share/media2/mnt"; fi
set -- $(stat -c '%d %i' "$D/share")
printf '{"roots":[{"fd":3,"path":"%s","dev":%s,"ino":%s}],"acl":"u::rwX,g::rX,o::rX,u:0:rwX,m::rwX","defaultAcl":"u::rwx,g::r-x,o::r-x,u:0:rwx,m::rwx","setgid":true,"mode":"u=rwX,g=rX,o=rwX","tools":{"chown":"/usr/bin/chown","chmod":"/usr/bin/chmod","setfacl":"/usr/bin/setfacl"}}' "$D/share" "$1" "$2" > "$D/job.json"
perl "$HELPER" < "$D/job.json" 3<"$D/share" > "$D/report.json"
acl() { if getfacl -pc "$1" | grep -q '^user:root'; then echo acl; else echo plain; fi; }
echo "$(stat -c %a "$M") $(acl "$M") $(stat -c %a "$M/inner") $(stat -c %a "$M/inner/file") $(acl "$M/inner/file") $(stat -c %a "$D/share/own") $(acl "$D/share/own")"
cat "$D/report.json"
`

interface Outcome { mountRoot: string, mountRootAcl: string, inner: string, innerFile: string, innerFileAcl: string, own: string, ownAcl: string, boundary: number }

function run(name: string, foreign: 'overlay' | 'tmpfs', rename: boolean): Outcome {
  const D = join(scratch, name)
  spawnSync('mkdir', ['-p', D])
  const r = spawnSync('unshare', ['-rm', 'sh', '-c', SCRIPT, 'sh', D, foreign, rename ? 'yes' : 'no', HELPER], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const [line, report] = r.stdout.trim().split('\n')
  const [mountRoot, mountRootAcl, inner, innerFile, innerFileAcl, own, ownAcl] = line.split(' ')
  return { mountRoot, mountRootAcl, inner, innerFile, innerFileAcl, own, ownAcl, boundary: (JSON.parse(report) as { boundary: number }).boundary }
}

const UNTOUCHED = { mountRoot: '755', mountRootAcl: 'plain', inner: '755', innerFile: '644', innerFileAcl: 'plain' }

describe('the walk stops at the device, not at a name (cr3.shares D2 + fourth review, in a private namespace)', { skip: SKIP }, () => {
  for (const foreign of ['overlay', 'tmpfs'] as const) {
    for (const rename of [false, true]) {
      it(`a foreign ${foreign} mount (${foreign === 'tmpfs' ? 'the SAME type as the share' : 'a different type'}), ${rename ? 'its ancestor renamed by the share user' : 'as mounted'}: nothing of it is touched, its top included`, () => {
        const o = run(`${foreign}-${rename ? 'renamed' : 'plain'}`, foreign, rename)
        assert.deepEqual({ mountRoot: o.mountRoot, mountRootAcl: o.mountRootAcl, inner: o.inner, innerFile: o.innerFile, innerFileAcl: o.innerFileAcl }, UNTOUCHED)
        assert.equal(o.own, '646', 'the share\'s own file got the mode')
        assert.equal(o.ownAcl, 'acl', 'and the ACL')
        assert.equal(o.boundary, 1, 'the helper counted the mount as a boundary')
      })
    }
  }
})

/**
 * Fifth review D2: the boundary is the MOUNT, not only the device. The
 * review's probe (`ns-bound.sh` B1, B2): a BIND mount of the SAME filesystem
 * inside the tree carries the root's device number, and the device-only walk
 * crossed it (an outside directory went 700 -> 757, the tree bound inside
 * itself was walked twice) while the plan said "not changed". The helper now
 * reads each entry's mount id (/proc/self/fdinfo `mnt_id:`) and never enters
 * or touches another mount.
 */
const BIND_SCRIPT = `set -e
D="$1"; CASE="$2"; HELPER="$3"
mount -t tmpfs tmpfs "$D"
mkdir -p "$D/share/a" "$D/outside/sub"
for i in 1 2 3; do echo > "$D/share/a/f$i"; done
echo s > "$D/outside/secret"; echo t > "$D/outside/sub/deep"
chmod 600 "$D/outside/secret" "$D/outside/sub/deep"; chmod 700 "$D/outside" "$D/outside/sub"
if [ "$CASE" = outside ]; then mkdir "$D/share/bind"; mount --bind "$D/outside" "$D/share/bind"; fi
if [ "$CASE" = loop ]; then mkdir "$D/share/loop"; mount --bind "$D/share" "$D/share/loop"; fi
set -- $(stat -c '%d %i' "$D/share")
printf '{"roots":[{"fd":3,"path":"%s","dev":%s,"ino":%s}],"mode":"u=rwX,g=rX,o=rwX","tools":{"chown":"/usr/bin/chown","chmod":"/usr/bin/chmod","setfacl":"/usr/bin/setfacl"}}' "$D/share" "$1" "$2" > "$D/job.json"
perl "$HELPER" < "$D/job.json" 3<"$D/share" > "$D/report.json"
[ "$CASE" = outside ] && umount "$D/share/bind"
[ "$CASE" = loop ] && umount "$D/share/loop"
echo "$(stat -c %a "$D/outside") $(stat -c %a "$D/outside/secret") $(stat -c %a "$D/outside/sub") $(stat -c %a "$D/outside/sub/deep") $(stat -c %a "$D/share/a/f1")"
cat "$D/report.json"
`

function bindRun(name: string, kind: 'outside' | 'loop'): { modes: string, report: { boundary: number, boundaries: { name: string, dev: number, mnt: number }[], visited: { files: number, dirs: number } } } {
  const D = join(scratch, name)
  spawnSync('mkdir', ['-p', D])
  const r = spawnSync('unshare', ['-rm', 'sh', '-c', BIND_SCRIPT, 'sh', D, kind, HELPER], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const [modes, report] = r.stdout.trim().split('\n')
  return { modes, report: JSON.parse(report) }
}

describe('a bind mount of the same filesystem is a boundary (fifth review D2, in a private namespace)', { skip: SKIP }, () => {
  it('B1: an OUTSIDE directory bound into the tree (same device) is never touched, its top included', () => {
    const { modes, report } = bindRun('b1', 'outside')
    assert.equal(modes, '700 600 700 600 646', 'outside untouched (700/600/700/600); the share\'s own file changed')
    assert.equal(report.boundary, 1)
    assert.equal(report.boundaries[0].name, 'bind')
    assert.ok(Number.isInteger(report.boundaries[0].mnt), 'reported with its mount id')
  })

  it('B2: the tree bound inside itself is not walked twice', () => {
    const { report } = bindRun('b2', 'loop')
    assert.deepEqual(report.visited, { files: 3, dirs: 2 }, 'the share and a/ once, with their three files (the review saw them twice)')
    assert.deepEqual(report.boundaries.map(b => b.name), ['loop'])
  })
})

/**
 * Fifth review D6, the real writer end to end in the namespace: the plan's
 * excluded mount and the walk's boundaries are matched by identity (mount id
 * and place). The review's probe: m unmounted and x mounted between the plan
 * and the walk — x gets m's mount id back, and the old count comparison said
 * nothing was skipped unexpectedly.
 */
const PROBE = fileURLToPath(new URL('./ns-writer-probe.ts', import.meta.url))
const WRITER_SCRIPT = `set -e
D="$1"; CASE="$2"; PROBE="$3"; NODE="$4"
mount -t tmpfs tmpfs "$D"
mkdir -p "$D/share/m" "$D/share/x" "$D/outside"
chmod 700 "$D/outside"
if [ "$CASE" = count ]; then mount -t tmpfs tmpfs "$D/share/m"; fi
if [ "$CASE" = bind ]; then mkdir "$D/share/bind"; mount --bind "$D/outside" "$D/share/bind"; fi
"$NODE" --import tsx "$PROBE" "$D/share" "$CASE"
[ "$CASE" = bind ] && umount "$D/share/bind"
echo "outside $(stat -c %a "$D/outside")"
`

/**
 * The writer runs under `--map-auto` (a subordinate id range for the
 * tree's owners), which `unshare -rm` above does not need: probed on its
 * own, with the mounts WRITER_SCRIPT makes, so a host without it skips.
 */
const WRITER_NS = ['--map-auto', '--map-root-user', '-m']
function canUnshareMapAuto(): string | false {
  const probe = join(scratch, 'probe-map-auto')
  spawnSync('mkdir', ['-p', probe])
  const r = spawnSync('unshare', [...WRITER_NS, 'sh', '-c', 'mount -t tmpfs tmpfs "$1" && mkdir "$1/a" "$1/b" && mount --bind "$1/a" "$1/b"', 'sh', probe], { encoding: 'utf8' })
  return r.status === 0 ? false : `needs unshare ${WRITER_NS.join(' ')} with tmpfs and bind mounts: ${r.stderr.trim() || r.status}`
}
const SKIP_WRITER = SKIP || canUnshareMapAuto()

function writerRun(name: string, kind: 'count' | 'bind'): { result: { incomplete: boolean, message: string, x?: string, xin?: string }, outside: string } {
  const D = join(scratch, name)
  spawnSync('mkdir', ['-p', D])
  const r = spawnSync('unshare', [...WRITER_NS, 'sh', '-c', WRITER_SCRIPT, 'sh', D, kind, PROBE, process.execPath], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  return { result: JSON.parse(lines.at(-2) ?? ''), outside: (lines.at(-1) ?? '').split(' ')[1] }
}

describe('the real writer matches boundaries by identity (fifth review D6, in a private namespace)', { skip: SKIP_WRITER }, () => {
  it('the review\'s probe: the excluded mount gone, an unnamed one in its place under another name — INCOMPLETE naming both, the unnamed one untouched', () => {
    const { result } = writerRun('w-count', 'count')
    assert.equal(result.incomplete, true, result.message)
    assert.match(result.message, /1 folder on another filesystem that the confirmation did not name was not entered \(x\)/)
    assert.match(result.message, /1 filesystem the confirmation named as left alone was not where the walk looked .*\/share\/m\)/)
    assert.deepEqual([result.x, result.xin], ['700', '700'])
  })

  it('a bind of an outside directory that the confirmation named: complete, and the outside untouched', () => {
    const { result, outside } = writerRun('w-bind', 'bind')
    assert.equal(result.incomplete, false, result.message)
    assert.equal(outside, '700')
  })
})
