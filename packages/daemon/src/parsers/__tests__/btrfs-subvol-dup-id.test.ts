import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { confirmedSubvolumesBelowMount } from '../../services/access-walk.js'
import { subvolumesBelowMount } from '../btrfs-subvol-list.js'

/*
 * Review of cr3.nodefix R2 (2026-11-15, the reviewer's probe 1e). The list
 * shape is the captured one (fixtures/ahr/btrfs-subvol-list-nested-mounted.txt:
 * `ID <n> gen <g> top level <p> path <rel>` on a `subvol=/@data` mount); the
 * last line is what a subvolume named `x` + LF + `ID 258 gen 1 top level 5
 * path deep` prints (line breaks are printed raw: captured in
 * fixtures/ahr/btrfs-subvol-list-newline-names.txt).
 */
const MOUNT = { target: '/mnt/anas-ahr/p', options: 'rw,relatime,subvolid=256,subvol=/@data' }
const FORGED_REUSED_ID = [
  'ID 256 gen 9 top level 5 path @data',
  'ID 258 gen 10 top level 256 path sv',
  'ID 300 gen 10 top level 258 path sv/deep',
  'ID 258 gen 1 top level 5 path deep',
].join('\n')

describe('a subvolume list that names one id twice', () => {
  it('refuses: a forged line reusing a real id never yields a shorter list', () => {
    const read = subvolumesBelowMount(FORGED_REUSED_ID, MOUNT)
    assert.ok('problem' in read, JSON.stringify(read))
    assert.match(read.problem, /^listed subvolume id 258 twice \('deep'\): /)
    assert.match(read.problem, /find '\/mnt\/anas-ahr\/p' -inum 256/)
    assert.doesNotMatch(read.problem, /…/)
  })

  it('a subvolume whose name starts with two dots is under the mount, not outside it', async () => {
    const list = ['ID 256 gen 9 top level 5 path @data', 'ID 257 gen 10 top level 256 path ..archive'].join('\n')
    const stat = (ino: number, dev: number) => ({ ino, dev, isSymbolicLink: () => false, isDirectory: () => true })
    const lstat = async (p: string) => p === MOUNT.target ? stat(256, 91) : stat(256, 92)
    const read = await confirmedSubvolumesBelowMount(list, MOUNT, lstat as never)
    assert.deepEqual(read, { below: [{ path: '/mnt/anas-ahr/p/..archive', subvol: '@data/..archive' }] })
  })
})
