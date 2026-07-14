import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ConfigConflictError, editConfig, readConfig } from '../config-writer.js'

describe('config-writer', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-cfg-'))
    file = join(dir, 'smb.conf')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a missing file as empty', async () => {
    assert.equal(await readConfig(file), '')
  })

  it('writes the transformed content', async () => {
    await writeFile(file, '[global]\n')
    await editConfig(file, cur => `${cur}[media]\n  path = /x\n`)
    assert.equal(await readFile(file, 'utf8'), '[global]\n[media]\n  path = /x\n')
  })

  it('backs up the previous content to .bak before overwriting', async () => {
    await writeFile(file, 'ORIGINAL\n')
    await editConfig(file, () => 'NEW\n')
    assert.equal(await readFile(`${file}.bak`, 'utf8'), 'ORIGINAL\n')
    assert.equal(await readFile(file, 'utf8'), 'NEW\n')
  })

  it('does not write (or back up) on a no-op transform', async () => {
    await writeFile(file, 'SAME\n')
    await editConfig(file, cur => cur)
    assert.equal(await readFile(file, 'utf8'), 'SAME\n')
    await assert.rejects(readFile(`${file}.bak`, 'utf8')) // no backup created
  })

  it('aborts with ConfigConflictError if the file changes under us', async () => {
    await writeFile(file, 'v1\n')
    await assert.rejects(
      editConfig(file, async () => {
        // Simulate an external hand-edit landing during our transform.
        await writeFile(file, 'external-edit\n')
        return 'our-change\n'
      }),
      ConfigConflictError,
    )
    // Our change was NOT applied — the external edit stands.
    assert.equal(await readFile(file, 'utf8'), 'external-edit\n')
  })

  it('serializes concurrent edits — no lost update', async () => {
    await writeFile(file, '')
    // Fire two appends concurrently; the per-file lock must serialize them so
    // both land (a naive read-modify-write would lose one).
    await Promise.all([
      editConfig(file, cur => `${cur}A\n`),
      editConfig(file, cur => `${cur}B\n`),
    ])
    const out = await readFile(file, 'utf8')
    assert.ok(out.includes('A\n') && out.includes('B\n'), `expected both appends, got: ${JSON.stringify(out)}`)
  })
})
