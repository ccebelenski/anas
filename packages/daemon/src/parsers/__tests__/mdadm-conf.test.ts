import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  getArrays,
  getProgram,
  hasArray,
  MdadmConfValueError,
  MdadmForeignProgramError,
  parseMdadmConfDoc,
  removeArray,
  removeProgram,
  serializeMdadmConfDoc,
  upsertArray,
  upsertProgram,
} from '../mdadm-conf.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(__dirname, '../../fixtures/ahr/mdadm-conf-debian-sample'), 'utf-8')

const UUID_A = '9f3c1a2b:4d5e6f70:8192a3b4:c5d6e7f8'
const UUID_B = '01234567:89abcdef:01234567:89abcdef'

describe('mdadm.conf round-trip (byte identity)', () => {
  it('reproduces the Debian sample BYTE-FOR-BYTE', () => {
    assert.equal(serializeMdadmConfDoc(parseMdadmConfDoc(fixture)), fixture)
  })

  it('round-trips a file with no trailing newline', () => {
    const text = 'MAILADDR root\nARRAY /dev/md0 UUID=11111111:22222222:33333333:44444444'
    assert.equal(serializeMdadmConfDoc(parseMdadmConfDoc(text)), text)
  })

  it('round-trips the empty file', () => {
    assert.equal(serializeMdadmConfDoc(parseMdadmConfDoc('')), '')
  })
})

describe('parse — which lines are interpreted', () => {
  const doc = parseMdadmConfDoc(fixture)

  it('recognizes ARRAY lines incl. lowercase keyword; ignores comments/continuations', () => {
    const arrays = getArrays(doc)
    assert.equal(arrays.length, 2)
    assert.deepEqual(arrays[0], { device: '/dev/md0', uuid: '11111111:22222222:33333333:44444444', name: 'oldbox:0' })
    assert.deepEqual(arrays[1], { device: '/dev/md/legacy', uuid: 'aaaabbbb:ccccdddd:eeeeffff:00001111', name: undefined })
  })

  it('does not revive the commented-out DEVICE line or interpret MAILADDR/HOMEHOST', () => {
    // Only the two ARRAY lines and zero PROGRAM lines are interpreted.
    assert.equal(getProgram(doc), undefined)
    assert.equal(doc.filter(l => l.kind !== 'other').length, 2)
  })

  it('matches array UUIDs case-insensitively', () => {
    assert.ok(hasArray(doc, 'AAAABBBB:CCCCDDDD:EEEEFFFF:00001111'))
    assert.ok(!hasArray(doc, UUID_A))
  })

  it('treats a continuation line as verbatim other-text', () => {
    const cont = doc.find(l => l.raw.startsWith('   spares=1'))
    assert.equal(cont?.kind, 'other')
  })
})

describe('upsertArray — surgical add / update-by-UUID', () => {
  it('appends a canonical line before the trailing newline; everything else untouched', () => {
    const doc = parseMdadmConfDoc(fixture)
    const out = serializeMdadmConfDoc(upsertArray(doc, { name: 'tank-r1', uuid: UUID_A }))
    assert.equal(out, `${fixture}ARRAY /dev/md/tank-r1 metadata=1.2 UUID=${UUID_A}\n`)
  })

  it('updates ONLY the line with the matching UUID', () => {
    let doc = parseMdadmConfDoc(fixture)
    doc = upsertArray(doc, { name: 'tank-r1', uuid: UUID_A })
    doc = upsertArray(doc, { name: 'tank-r2', uuid: UUID_B })
    const before = serializeMdadmConfDoc(doc)

    // Rename r1's pin (same UUID, new name) — r2 and all foreign lines keep their bytes.
    const after = serializeMdadmConfDoc(upsertArray(parseMdadmConfDoc(before), { name: 'tank2-r1', uuid: UUID_A }))
    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    assert.equal(afterLines.length, beforeLines.length)
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i].includes(UUID_A))
        assert.equal(afterLines[i], `ARRAY /dev/md/tank2-r1 metadata=1.2 UUID=${UUID_A}`)
      else
        assert.equal(afterLines[i], beforeLines[i], `line ${i} must be untouched`)
    }
  })

  it('is byte-identical when re-upserting the same pin (idempotent)', () => {
    const doc = upsertArray(parseMdadmConfDoc(fixture), { name: 'tank-r1', uuid: UUID_A })
    const once = serializeMdadmConfDoc(doc)
    assert.equal(serializeMdadmConfDoc(upsertArray(parseMdadmConfDoc(once), { name: 'tank-r1', uuid: UUID_A })), once)
  })

  it('updates a foreign-form line when the UUID matches (it IS our array)', () => {
    const out = serializeMdadmConfDoc(
      upsertArray(parseMdadmConfDoc(fixture), { name: 'adopted', uuid: '11111111:22222222:33333333:44444444' }),
    )
    assert.ok(out.includes('ARRAY /dev/md/adopted metadata=1.2 UUID=11111111:22222222:33333333:44444444'))
    assert.ok(!out.includes('oldbox:0'))
  })

  it('starts a missing conf as a newline-terminated single entry', () => {
    const out = serializeMdadmConfDoc(upsertArray(parseMdadmConfDoc(''), { name: 'tank-r1', uuid: UUID_A }))
    assert.equal(out, `ARRAY /dev/md/tank-r1 metadata=1.2 UUID=${UUID_A}\n`)
  })

  it('rejects unsafe names and malformed UUIDs with a typed error', () => {
    const doc = parseMdadmConfDoc(fixture)
    assert.throws(() => upsertArray(doc, { name: 'bad name', uuid: UUID_A }), MdadmConfValueError)
    assert.throws(() => upsertArray(doc, { name: '../evil', uuid: UUID_A }), MdadmConfValueError)
    assert.throws(() => upsertArray(doc, { name: 'ok', uuid: 'not-a-uuid' }), MdadmConfValueError)
    assert.throws(() => upsertArray(doc, { name: 'ok', uuid: '9f3c1a2b4d5e6f708192a3b4c5d6e7f8' }), MdadmConfValueError)
    // Nothing was written by the failed attempts.
    assert.equal(serializeMdadmConfDoc(doc), fixture)
  })
})

describe('removeArray — surgical remove-by-UUID', () => {
  it('removes only the matching line; add-then-remove is a byte no-op', () => {
    const added = serializeMdadmConfDoc(upsertArray(parseMdadmConfDoc(fixture), { name: 'tank-r1', uuid: UUID_A }))
    const removed = serializeMdadmConfDoc(removeArray(parseMdadmConfDoc(added), UUID_A))
    assert.equal(removed, fixture)
  })

  it('is a no-op for an absent UUID (foreign lines never touched)', () => {
    assert.equal(serializeMdadmConfDoc(removeArray(parseMdadmConfDoc(fixture), UUID_A)), fixture)
  })
})

describe('PROGRAM — exactly one, never stolen', () => {
  const hook = '/usr/local/bin/anas-md-event'

  it('appends PROGRAM when none exists; everything else untouched', () => {
    const out = serializeMdadmConfDoc(upsertProgram(parseMdadmConfDoc(fixture), hook))
    assert.equal(out, `${fixture}PROGRAM ${hook}\n`)
    assert.equal(getProgram(parseMdadmConfDoc(out)), hook)
  })

  it('is a byte-identical no-op when the PROGRAM already points at the hook', () => {
    const withHook = `MAILADDR root\nPROGRAM ${hook}\n`
    assert.equal(serializeMdadmConfDoc(upsertProgram(parseMdadmConfDoc(withHook), hook)), withHook)
  })

  it('REFUSES to overwrite a foreign PROGRAM (typed error carrying the path)', () => {
    const foreign = 'PROGRAM /usr/sbin/handle-mdadm-events\n'
    assert.throws(
      () => upsertProgram(parseMdadmConfDoc(fixture + foreign), hook),
      (err: unknown) => err instanceof MdadmForeignProgramError
        && err.existingProgram === '/usr/sbin/handle-mdadm-events',
    )
  })

  it('rejects a non-absolute or unsafe hook path with a typed error', () => {
    assert.throws(() => upsertProgram(parseMdadmConfDoc(''), 'relative/path'), MdadmConfValueError)
    assert.throws(() => upsertProgram(parseMdadmConfDoc(''), '/path with space'), MdadmConfValueError)
  })

  it('removeProgram removes ours; with a path filter it leaves a foreign hook alone', () => {
    const withHook = serializeMdadmConfDoc(upsertProgram(parseMdadmConfDoc(fixture), hook))
    assert.equal(serializeMdadmConfDoc(removeProgram(parseMdadmConfDoc(withHook), hook)), fixture)

    const foreign = `${fixture}PROGRAM /usr/sbin/handle-mdadm-events\n`
    assert.equal(serializeMdadmConfDoc(removeProgram(parseMdadmConfDoc(foreign), hook)), foreign)
    // Unfiltered removal takes whatever PROGRAM line exists.
    assert.equal(serializeMdadmConfDoc(removeProgram(parseMdadmConfDoc(foreign))), fixture)
  })
})
