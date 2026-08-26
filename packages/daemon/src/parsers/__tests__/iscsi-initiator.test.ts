import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseInitiatorName, readNodeInitiatorName } from '../iscsi-initiator.js'

/**
 * The node's own initiator IQN, from open-iscsi's `initiatorname.iscsi`.
 *
 * The read is the "Add this node" door's value, so the contract is: the real
 * file shape parses, comments and blanks are ignored, and every failure mode
 * (missing file, unreadable file, no legal value) is `null` — never an error,
 * because a null is the UI's "hide the button", and open-iscsi may simply not
 * be installed on a node that serves block storage.
 */

// Verbatim shape of a real Debian/PVE file (open-iscsi 2.1.x): a block of
// `#` comments around one `InitiatorName=` line.
const REAL_SHAPE = [
  '# This file was created by openscsd. Do not edit it manually unless you',
  '# know what you are doing.',
  '#',
  'InitiatorName=iqn.1993-08.org.debian:01:1dd0a338f783',
  '',
  '# End of file',
].join('\n')

describe('parseInitiatorName — one small function, three failure shapes', () => {
  it('parses the real line shape, ignoring the comment block around it', () => {
    assert.equal(parseInitiatorName(REAL_SHAPE), 'iqn.1993-08.org.debian:01:1dd0a338f783')
  })

  it('a commented-out file has no initiator — null, not the first `#` line', () => {
    assert.equal(parseInitiatorName('# InitiatorName=iqn.1993-08.org.debian:01:deadbeef\n# nothing else\n'), null)
  })

  it('a file with no InitiatorName line is null', () => {
    assert.equal(parseInitiatorName('# just comments\n\n# and blanks\n'), null)
  })

  it('an empty file is null', () => {
    assert.equal(parseInitiatorName(''), null)
  })

  it('a value that is not a legal iSCSI name reads as none', () => {
    // The UI would insert this row and the daemon would refuse it — the same
    // failure, one step earlier.
    assert.equal(parseInitiatorName('InitiatorName=not-an-iqn\n'), null)
  })

  it('the first InitiatorName line wins', () => {
    assert.equal(
      parseInitiatorName('InitiatorName=iqn.1993-08.org.debian:01:aaaa\nInitiatorName=iqn.1993-08.org.debian:01:bbbb\n'),
      'iqn.1993-08.org.debian:01:aaaa',
    )
  })
})

describe('readNodeInitiatorName — fail-open on the filesystem itself', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-initiator-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a missing file is null — open-iscsi may not be installed at all', async () => {
    assert.equal(await readNodeInitiatorName(join(dir, 'absent', 'initiatorname.iscsi')), null)
  })

  it('a path that is a directory is null, not an EISDIR error', async () => {
    assert.equal(await readNodeInitiatorName(dir), null)
  })

  it('reads the real shape from a temp file', async () => {
    const p = join(dir, 'initiatorname.iscsi')
    await writeFile(p, REAL_SHAPE)
    assert.equal(await readNodeInitiatorName(p), 'iqn.1993-08.org.debian:01:1dd0a338f783')
  })

  it('a file with comments only is null', async () => {
    const p = join(dir, 'initiatorname.iscsi')
    await writeFile(p, '# InitiatorName=iqn.1993-08.org.debian:01:deadbeef\n')
    assert.equal(await readNodeInitiatorName(p), null)
  })
})
