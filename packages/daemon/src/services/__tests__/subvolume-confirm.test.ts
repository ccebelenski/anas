import type { SubvolumeLstat } from '../access-walk.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { subvolumesBelowMount } from '../../parsers/btrfs-subvol-list.js'
import { confirmedSubvolumesBelowMount, nestedSubvolumes } from '../access-walk.js'

/**
 * cr3.nodefix review R2: `btrfs subvolume list` is text a user can shape. A
 * user without privileges can create a subvolume, the list prints its name's
 * line break raw, and a name holding a line break and a well-formed line
 * forges a placement: the real subvolume lands on another user's plain
 * folder and a phantom is placed elsewhere. Every placement is now confirmed
 * against the filesystem (each path component lstat'ed, never a link; the
 * last one a subvolume root: inode 256 on a device of its own), and one that
 * does not confirm refuses the whole reading, naming it and what to do.
 *
 * CAPTURES (anas-pve, btrfs-progs 6.14, kernel 7.0.14-28-pve):
 *  - fixtures/ahr/btrfs-subvol-list-newline-names.txt: the list with two
 *    names holding a line break (`udir/nl<LF>name`, and the forging
 *    `share/victimdir<LF>ID 9999 gen 1 top level 256 path accounts` beside a
 *    plain folder `share/victimdir`), and `stat -c '%i %d %F %n'` of the
 *    mount, the subvolume roots and the ordinary folders — the fake lstat
 *    below answers exactly those lines, and ENOENT for any other path;
 *  - fixtures/ahr/btrfs-subvol-list-nested-mounted.txt (cr3 node pass 2): the
 *    list and `stat -c %d:%i:%n` of the mount and the three subvolumes; its
 *    one plain folder on a path (`plain`) was not stat'ed there and is
 *    answered as inode 257 on the mount's device (any inode but 256 on that
 *    device is a plain folder).
 */
function capture(name: string): string[] {
  return readFileSync(new URL(`../../fixtures/ahr/${name}`, import.meta.url), 'utf-8').split('\n')
}
/** The output of `### $ <cmd>` (prefix match) up to its `### exit=` line. */
function block(lines: string[], cmd: string): string {
  const at = lines.findIndex(l => l.startsWith(`### $ ${cmd}`))
  assert.ok(at >= 0, cmd)
  return lines.slice(at + 1, lines.findIndex((l, i) => i > at && l.startsWith('### exit='))).map(l => `${l}\n`).join('')
}
interface Stat { ino: number, dev: number }
function lstatFrom(stats: Map<string, Stat>, links: Set<string> = new Set()): SubvolumeLstat {
  return async (path: string) => {
    if (links.has(path))
      return { dev: 1, ino: 1, isDirectory: () => false, isSymbolicLink: () => true }
    const st = stats.get(path)
    if (!st)
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' })
    return { ...st, isDirectory: () => true, isSymbolicLink: () => false }
  }
}

const NL = capture('btrfs-subvol-list-newline-names.txt')
const NL_MP = '/mnt/anas-ahr/nfxahr'
const [nlTarget, , , nlOptions] = block(NL, `findmnt -n -o TARGET,SOURCE,FSTYPE,OPTIONS ${NL_MP}`).trim().split(' ')
const nlMount = { target: nlTarget!, source: '', fstype: 'btrfs', options: nlOptions! }
const NL_LIST = block(NL, `btrfs subvolume list ${NL_MP}\n`.trim())
/** `stat -c '%i %d %F %n'`: a line that does not start a new record continues the previous name (its line break). */
const NL_STATS = (() => {
  const out = new Map<string, Stat>()
  let last: string | null = null
  for (const line of block(NL, 'stat -c').split('\n').slice(0, -1)) {
    const m = /^(\d+) (\d+) directory (.*)$/.exec(line)
    if (m) {
      last = m[3]!
      out.set(last, { ino: Number(m[1]), dev: Number(m[2]) })
    }
    else if (last !== null) {
      const st = out.get(last)!
      out.delete(last)
      last = `${last}\n${line}`
      out.set(last, st)
    }
  }
  return out
})()
/** The captured list without the `udir/nl<LF>name` subvolume's two lines: the forging name alone. */
const FORGE_ONLY = NL_LIST.split('\n').filter(l => !l.endsWith('path udir/nl') && l !== 'name').join('\n')

const NESTED = capture('btrfs-subvol-list-nested-mounted.txt')
const N_MP = '/mnt/anas-ahr/n2ahr'
const [nTarget, , , nOptions] = block(NESTED, `findmnt -n -o TARGET,SOURCE,FSTYPE,OPTIONS ${N_MP}`).trim().split(' ')
const nMount = { target: nTarget!, source: '', fstype: 'btrfs', options: nOptions! }
const N_LIST = block(NESTED, `btrfs subvolume list ${N_MP}\n`.trim())
const N_STATS = new Map<string, Stat>(block(NESTED, 'stat -c %d:%i:%n').split('\n').filter(l => /^\d+:\d+:/.test(l)).map((l) => {
  const [dev, ino, ...name] = l.split(':')
  return [name.join(':'), { dev: Number(dev), ino: Number(ino) }] as const
}))
N_STATS.set(`${N_MP}/plain`, { ino: 257, dev: N_STATS.get(N_MP)!.dev })

const REMEDY = (mp: string) => `a subvolume with a line break in its name makes the list unreadable; rename or delete it (find '${mp}' -inum 256 -name '*[[:cntrl:]]*' lists them)`

describe('cr3.nodefix review R2 — every placed subvolume is confirmed against the filesystem', () => {
  it('the captures say what this block says they do', () => {
    assert.ok(NL_LIST.includes('path udir/nl\nname\n'), 'the line break is printed raw')
    assert.ok(NL_LIST.includes('path share/victimdir\nID 9999 gen 1 top level 256 path accounts\n'), 'a name forges a whole line')
    assert.deepEqual(NL_STATS.get(NL_MP), { ino: 256, dev: 91 })
    assert.deepEqual(NL_STATS.get(`${NL_MP}/sv`), { ino: 256, dev: 92 })
    assert.deepEqual(NL_STATS.get(`${NL_MP}/share/victimdir\nID 9999 gen 1 top level 256 path accounts`), { ino: 256, dev: 94 })
    assert.deepEqual(NL_STATS.get(`${NL_MP}/share/victimdir`), { ino: 260, dev: 91 })
    assert.match(block(NL, 'btrfs --format json subvolume list'), /^ERROR: output format json is unsupported for this command$/m)
  })

  it('RED: the forging name alone — before, the real subvolume was placed on the plain folder and a phantom at accounts; now the reading refuses, naming the plain folder', async () => {
    // What the unconfirmed placement says (the defect the review constructed, here from the capture).
    const unconfirmed = subvolumesBelowMount(FORGE_ONLY, nlMount)
    assert.deepEqual('below' in unconfirmed && unconfirmed.below.map(b => b.path), [`${NL_MP}/sv`, `${NL_MP}/share/victimdir`, `${NL_MP}/accounts`])
    assert.deepEqual(await confirmedSubvolumesBelowMount(FORGE_ONLY, nlMount, lstatFrom(NL_STATS)), {
      problem: `named ${NL_MP}/share/victimdir as a subvolume, and ${NL_MP}/share/victimdir is a plain folder, not a subvolume; a subvolume deleted or moved while the list was read does this, and so does one whose name ANAS cannot read: ${REMEDY(NL_MP)}`,
    })
    assert.ok('problem' in await nestedSubvolumes(FORGE_ONLY, nlMount, NL_MP, lstatFrom(NL_STATS)))
  })

  it('RED: the reviewer\'s forged list (P6) over the node-pass capture: the phantom does not exist, and the reading refuses naming it', async () => {
    const forged = `${N_LIST}ID 341 gen 1 top level 256 path share/victimdir\nID 9999 gen 1 top level 256 path accounts\n`
    const r = await confirmedSubvolumesBelowMount(forged, nMount, lstatFrom(N_STATS))
    assert.deepEqual(r, { problem: `named ${N_MP}/share/victimdir as a subvolume, and ${N_MP}/share does not exist; a subvolume deleted or moved while the list was read does this, and so does one whose name ANAS cannot read: ${REMEDY(N_MP)}` })
  })

  it('the whole captured list (a plain line-break name too): the unreadable line is named, with the same way to find it', async () => {
    assert.deepEqual(await confirmedSubvolumesBelowMount(NL_LIST, nlMount, lstatFrom(NL_STATS)), {
      problem: `answered lines it could not read ("name"): ${REMEDY(NL_MP)}`,
    })
  })

  it('subvolume roots that are what the list says are confirmed (the node-pass capture), and a symbolic link on the way never is', async () => {
    const ok = await confirmedSubvolumesBelowMount(N_LIST, nMount, lstatFrom(N_STATS))
    assert.deepEqual('below' in ok && ok.below.map(b => b.path), [`${N_MP}/sv`, `${N_MP}/plain/sv2`, `${N_MP}/sv/deep`])
    const linked = await confirmedSubvolumesBelowMount(N_LIST, nMount, lstatFrom(N_STATS, new Set([`${N_MP}/plain`])))
    assert.ok('problem' in linked && linked.problem.startsWith(`named ${N_MP}/plain/sv2 as a subvolume, and ${N_MP}/plain is a symbolic link; `), JSON.stringify(linked))
    // A subvolume root's inode on the SAME device as its folder is a plain folder (a bind, a copy).
    const sameDev = new Map(N_STATS)
    sameDev.set(`${N_MP}/sv`, { ino: 256, dev: N_STATS.get(N_MP)!.dev })
    const r = await confirmedSubvolumesBelowMount(N_LIST, nMount, lstatFrom(sameDev))
    assert.ok('problem' in r && r.problem.startsWith(`named ${N_MP}/sv as a subvolume, and ${N_MP}/sv is a plain folder, not a subvolume; `), JSON.stringify(r))
  })
})
