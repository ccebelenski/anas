import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { buildWalkArgs, findPathLiteral } from '../nested-filesystems.js'

/**
 * cr3 DATASETS-SCHEDULES-L4: the walk's prune paths are `find -path` GLOBS.
 * A mount point whose name carries `[`, `*`, `?` or `\` was not pruned — the
 * walk entered the remote or automount it exists to avoid. Run against the
 * real GNU find on a scratch tree.
 */
const FIND = '/usr/bin/find'
const NAMES = ['[nas]', 'a*b', 'q?', 'back\\slash', 'plain']

describe('cr3 L4: find -path prune terms are literal', { skip: !existsSync(FIND) }, () => {
  let root: string

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-cr3-findglob-'))
    for (const n of NAMES)
      await mkdir(join(root, n, 'inner'), { recursive: true })
    // Siblings a glob would have matched instead.
    await mkdir(join(root, 'n', 'inner'), { recursive: true })
    await mkdir(join(root, 'axxb', 'inner'), { recursive: true })
    await mkdir(join(root, 'qz', 'inner'), { recursive: true })
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  for (const name of NAMES) {
    it(`a mount point named '${name}' is pruned, and only it`, () => {
      const pruned = join(root, name)
      const out = execFileSync(FIND, buildWalkArgs(root, [pruned], 5), { encoding: 'utf8' })
      const paths = out.split('\n').filter(Boolean).map(l => l.split('\t')[1])
      assert.ok(!paths.includes(pruned), `${pruned} printed`)
      assert.ok(!paths.includes(join(pruned, 'inner')), `${pruned}/inner entered`)
      // The look-alike siblings are still walked.
      for (const other of ['n', 'axxb', 'qz'])
        assert.ok(paths.includes(join(root, other, 'inner')), `${other}/inner skipped`)
    })
  }

  it('escapes each glob character with a backslash', () => {
    assert.equal(findPathLiteral('/srv/[nas]/a*b?c\\d'), '/srv/\\[nas]/a\\*b\\?c\\\\d')
    assert.equal(findPathLiteral('/srv/plain'), '/srv/plain')
  })
})
