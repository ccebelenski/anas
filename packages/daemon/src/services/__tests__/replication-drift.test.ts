import type { ExecResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CommandTimeoutError } from '../../executor/deadline.js'
import {
  checkTargetDrift,
  classifyTargetState,
  exposedSentence,
  formatSize,
  judgeTargetState,
  modifiedSentence,
  nextIncrementalBase,
  parsePropertyRows,
  parseWrittenValue,
  readBaseHeld,
  readTargetState,
  sealTarget,
  snapshotHeldBy,
  snapshotHoldTags,
  targetStateArgs,
} from '../replication-drift.js'
import { modifiedTargetHint } from '../replication-tree.js'

/**
 * repl.drift: the detection, against the node captures
 * (`fixtures/zfs/zfs-written-replica.zfs2.4.2.txt`, ZFS 2.4.2) — every value
 * a state is judged from here is a line of that file, never typed.
 */

const CAPTURE = readFileSync(join(import.meta.dirname, '../../fixtures/zfs/zfs-written-replica.zfs2.4.2.txt'), 'utf-8')

/** The output lines under the capture's `== <title>` heading (up to the next heading or comment). */
function section(startsWith: string): string[] {
  const lines = CAPTURE.split('\n')
  const at = lines.findIndex(l => l.startsWith(`== ${startsWith}`))
  assert.notEqual(at, -1, `no capture section '${startsWith}'`)
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('==') || l.startsWith('#') || l.length === 0)
      break
    out.push(l)
  }
  return out
}

/** The one value line of a `-o value` capture section. */
function valueOf(startsWith: string): string {
  const lines = section(startsWith)
  return lines.at(-1)!
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
/** The drift read's answer rows, built from captured VALUES and the captured `property\tvalue\tsource` shape. */
function answer(base: string, written: string, readonly: string, source = 'local'): ExecResult {
  return ok(`written@${base}\t${written}\t-\nreadonly\t${readonly}\t${source}\n`)
}

describe('repl.drift parsers, on the captured lines', () => {
  it('the -o property,value,source rows of the clean replica parse (written 0, readonly on local)', () => {
    // The first three captured rows are the dataset's own (the next three are its snapshot's).
    const rows = parsePropertyRows(`${section('clean replica').slice(0, 3).join('\n')}\n`)
    assert.ok(rows)
    assert.deepEqual(rows.get('written'), { value: '0', source: '-' })
    assert.deepEqual(rows.get('readonly'), { value: 'on', source: 'local' })
  })

  it('the six captured rows of a dataset AND its snapshot are not one dataset\'s answer (a repeated property)', () => {
    assert.equal(parsePropertyRows(`${section('clean replica').join('\n')}\n`), null)
  })

  it('every captured -o value line parses to its byte count', () => {
    assert.equal(parseWrittenValue(valueOf('a target-only snapshot taken with NO change')), 0)
    assert.equal(parseWrittenValue(valueOf('zfs set readonly=off, one small file written')), 14336)
    assert.equal(parseWrittenValue(valueOf('after zfs snapshot cr3dst/d@local1')), 14336)
    assert.equal(parseWrittenValue(valueOf('readonly=off, atime=on, ONE FILE READ')), 12288)
    assert.equal(parseWrittenValue(valueOf('A readonly=on')), 0)
    assert.equal(parseWrittenValue(valueOf('E readonly=off, atime inherited')), 12288)
  })

  it('anything that is not an exact integer is no value (never 0)', () => {
    for (const junk of ['', '-', '12K', '1e3', ' ', '99999999999999999999', 'none'])
      assert.equal(parseWrittenValue(junk), null, junk)
  })

  it('the four states from the captured pairs', () => {
    // A: readonly=on, read heavily -> 0: clean.
    assert.equal(classifyTargetState(parseWrittenValue(valueOf('A readonly=on'))!, 'on'), 'clean')
    // D: readonly=off, atime=off, read -> 0: exposed (nothing changed yet).
    assert.equal(classifyTargetState(parseWrittenValue(valueOf('D readonly=off, atime=off'))!, 'off'), 'exposed')
    // E: readonly=off, one cat -> 12288: modified.
    assert.equal(classifyTargetState(parseWrittenValue(valueOf('E readonly=off, atime inherited'))!, 'off'), 'modified')
    // F: readonly set back to on after E: still modified (on does not undo it).
    assert.equal(classifyTargetState(12288, 'on'), 'modified')
  })
})

describe('repl.drift read: one command, four states', () => {
  const BASE = 'S1'
  const T = 'cr3dst/d'

  it('the argv: properties before --, the dataset after it', () => {
    assert.deepEqual(targetStateArgs(T, BASE), ['get', '-Hp', '-o', 'property,value,source', 'written@S1,readonly', '--', 'cr3dst/d'])
  })

  it('clean / exposed / modified from the answer', async () => {
    const seen: string[][] = []
    const runner = (r: ExecResult) => async (args: string[]) => {
      seen.push(args)
      return r
    }
    assert.deepEqual(await readTargetState(runner(answer(BASE, '0', 'on')), T, BASE), { ok: true, written: 0, readonly: 'on', readonlySource: 'local' })
    assert.deepEqual(await readTargetState(runner(answer(BASE, '0', 'off', 'local')), T, BASE), { ok: true, written: 0, readonly: 'off', readonlySource: 'local' })
    assert.deepEqual(await readTargetState(runner(answer(BASE, valueOf('readonly=off, atime=on, ONE FILE READ'), 'off', 'default')), T, BASE), { ok: true, written: 12288, readonly: 'off', readonlySource: 'default' })
    assert.equal(seen.length, 3)
  })

  it('a failed read is unknown with ssh\'s own last line, never clean', async () => {
    const r = await readTargetState(async () => ({ stdout: '', stderr: 'ssh: connect to host nas1 port 22: Connection timed out\n', exitCode: 255 }), T, BASE)
    assert.deepEqual(r, { ok: false, reason: 'ssh: connect to host nas1 port 22: Connection timed out' })
  })

  it('a read that times out (the executor rejects) is unknown', async () => {
    const r = await readTargetState(async () => {
      throw new CommandTimeoutError('/usr/bin/ssh', ['zfs', 'get'], 'request', 10_000, false)
    }, T, BASE)
    assert.equal(r.ok, false)
  })

  it('garbage, a missing row, an extra row or a value that is not a number is unknown', async () => {
    const answers = [
      ok('Welcome to nas1\n'),
      ok(`written@${BASE}\t0\t-\n`),
      ok(`readonly\ton\tlocal\n`),
      ok(`written@${BASE}\t-\t-\nreadonly\ton\tlocal\n`),
      ok(`written@${BASE}\t0\t-\nreadonly\ton\tlocal\nwritten\t0\t-\n`),
      ok(`written@OTHER\t0\t-\nreadonly\ton\tlocal\n`),
      ok(`written@${BASE}\t0\t-\r\nreadonly\ton\tlocal\n`),
      ok(''),
    ]
    for (const a of answers)
      assert.deepEqual(await readTargetState(async () => a, T, BASE), { ok: false, reason: 'the answer could not be read' }, JSON.stringify(a.stdout))
  })

  it('a base the shared SnapshotName refuses is never put on a command line', async () => {
    let ran = false
    const r = await readTargetState(async () => {
      ran = true
      return answer('x', '0', 'on')
    }, T, 'nightly 2')
    assert.equal(ran, false)
    assert.equal(r.ok, false)
  })
})

describe('repl.drift base: what the next incremental starts from', () => {
  it('the newest snapshot both sides share (transients aside)', () => {
    assert.equal(nextIncrementalBase(['S3', 'S2', 'S1'], ['S2', 'S1']), 'S2')
  })
  it('the target\'s newest snapshot when it is a transient the source still has (the decideBase rule-2 exception)', () => {
    assert.equal(nextIncrementalBase(['S3', 'anas-backup-t-1', 'S2'], ['anas-backup-t-1', 'S2']), 'anas-backup-t-1')
  })
  it('a transient the source no longer has is not a base', () => {
    assert.equal(nextIncrementalBase(['S3', 'S2'], ['anas-backup-t-1', 'S2']), 'S2')
  })
  it('nothing in common: no base (diverged is its own state)', () => {
    assert.equal(nextIncrementalBase(['S3'], ['X']), undefined)
  })
})

describe('repl.drift sentences', () => {
  it('sizes read as the panels show them', () => {
    assert.equal(formatSize(12288), '12.00 KiB')
    assert.equal(formatSize(14336), '14.00 KiB')
    assert.equal(formatSize(512), '512 B')
  })

  it('a write with a new target snapshot, remote, not read-only: one sentence with the rollback, the read-only line and the holds', () => {
    assert.equal(modifiedSentence({
      target: 'backup/data',
      where: ' on remote \'nas1\'',
      base: 'S1',
      writtenBytes: 14336,
      newer: ['local1'],
      readonly: 'off',
      readonlySource: 'local',
      held: { source: true, target: true },
    }), 'Target \'backup/data\' on remote \'nas1\' has been changed since \'@S1\': 14.00 KiB written and newer snapshot(s) \'@local1\'. Replication into it stops until those changes are discarded: to continue the chain, on the target release any hold on that snapshot (\'zfs holds backup/data@local1\' lists them; \'zfs release <tag> <snapshot>\' for each), then roll it back to \'@S1\' (\'zfs rollback -r backup/data@S1\', which destroys the snapshots newer than it there and anything written since). It is not read-only (readonly=off, local): the next successful receive sets it read-only again; until then, after the rollback, a write there, or a read with access-time updates on, changes it again (\'zfs set readonly=on backup/data\' on the target prevents that). Nothing was sent and no hold was moved or released: the source and its snapshots are untouched, and \'@S1\' stays held on both sides.')
  })

  it('an atime-only change: a small count, no new snapshot, and why a read changes it', () => {
    const s = modifiedSentence({ target: 'backup/data', where: '', base: 'S1', writtenBytes: 12288, newer: [], readonly: 'off', readonlySource: 'local', held: { source: true, target: false } })
    assert.equal(s, 'Target \'backup/data\' has been changed since \'@S1\': 12.00 KiB written with no new snapshot (a dataset that is not read-only also changes when a file on it is only read, while access-time updates are on). Replication into it stops until those changes are discarded: to continue the chain, on the target roll it back to \'@S1\' (\'zfs rollback -r backup/data@S1\', which destroys the snapshots newer than it there and anything written since). It is not read-only (readonly=off, local): the next successful receive sets it read-only again; until then, after the rollback, a write there, or a read with access-time updates on, changes it again (\'zfs set readonly=on backup/data\' on the target prevents that). Nothing was sent and no hold was moved or released: the source and its snapshots are untouched; \'@S1\' is not held by this replication on the target, so retention there can remove it.')
  })

  // Review D2: the first clause is what the run did to its holds.
  it('the lead clause names the holds the run placed and released, each part only when it happened', () => {
    const base = { target: 'backup/data', where: '', base: 'Sn', writtenBytes: 12288, newer: [], readonly: 'on', held: { source: true, target: true } }
    assert.match(modifiedSentence({ ...base, holdActs: { placed: ['tank/data@Sn'], released: ['tank/data@S0'] } }), / Nothing was sent; this run placed this replication's hold on 'tank\/data@Sn' and released a replication hold from 'tank\/data@S0', and '@Sn' stays held on both sides\.$/)
    assert.match(modifiedSentence({ ...base, holdActs: { placed: [], released: ['backup/data@S0'] } }), / Nothing was sent; this run released a replication hold from 'backup\/data@S0', and '@Sn' stays held on both sides\.$/)
    assert.match(modifiedSentence({ ...base, holdActs: { placed: [], released: [] } }), / Nothing was sent and no hold was moved or released: the source and its snapshots are untouched, and '@Sn' stays held on both sides\.$/)
  })

  it('never tells the operator to remove the target, and carries no ellipsis character', () => {
    for (const s of [
      modifiedSentence({ target: 't/d', where: '', base: 'B', writtenBytes: 1, newer: ['a', 'b', 'c', 'd', 'e', 'f'], readonly: 'on' }),
      exposedSentence({ target: 't/d', where: '', base: 'B', readonly: 'off' }),
    ]) {
      assert.doesNotMatch(s, /remove the target|, or remove it/)
      assert.ok(!s.includes(String.fromCharCode(0x2026)), 'no ellipsis character')
    }
  })

  it('the exposed sentence, nothing received: not read-only, the next run that completes seals it (behind or up to date), the way back now, that it undoes nothing, and the promoted-copy case', () => {
    assert.equal(exposedSentence({ target: 'backup/data', where: ' on remote \'nas1\'', base: 'S1', readonly: 'off', readonlySource: 'local' }), 'Target \'backup/data\' on remote \'nas1\' is not read-only (readonly=off, local): a write there, or a read with access-time updates on, stops the next send. The next replication run that completes sets it read-only again: its receive does when the copy is behind, and the run itself when the copy is up to date. \'zfs set readonly=on backup/data\' on the target does it now, and neither undoes a change already made. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.')
  })

  it('the exposed sentence when this run\'s receive sealed it (ruling 1)', () => {
    assert.equal(exposedSentence({ target: 'backup/data', where: ' on remote \'nas1\'', base: 'S1', readonly: 'off', readonlySource: 'local', sealed: true }), 'Target \'backup/data\' on remote \'nas1\' was not read-only (readonly=off, local); this run\'s receive set it read-only again. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.')
  })

  it('ONE remedy wording: the hint ZFS\'s own refusal gets ends in the same rollback clause as the drift sentence', () => {
    const hint = modifiedTargetHint('cannot receive incremental stream: destination backup/data has been modified\nsince most recent snapshot', 'backup/data', 'S1', ['local1', 'S1'])
    const drift = modifiedSentence({ target: 'backup/data', where: '', base: 'S1', writtenBytes: 1, newer: ['local1'], readonly: 'on' })
    const clause = hint.slice(hint.indexOf('to continue the chain'))
    assert.ok(drift.includes(clause), clause)
  })
})

describe('repl.drift check: the whole detection for one dataset', () => {
  it('modified asks for the holds of the base (only then) and names the newer snapshots', async () => {
    let heldAsked = 0
    const d = await checkTargetDrift(async () => answer('S1', '14336', 'on'), {
      target: 'cr3dst/d',
      where: '',
      base: 'S1',
      targetSnaps: ['local1', 'anas-backup-x-1', 'S1'],
      readHeld: async () => {
        heldAsked++
        return { source: true, target: true }
      },
    })
    assert.equal(d.state, 'modified')
    assert.equal(d.writtenBytes, 14336)
    assert.deepEqual(d.newerSnapshots, ['local1', 'anas-backup-x-1'])
    assert.equal(heldAsked, 1)
  })

  it('clean asks nothing more and carries no sentence', async () => {
    let heldAsked = 0
    const d = await checkTargetDrift(async () => answer('S1', '0', 'on'), { target: 'cr3dst/d', where: '', base: 'S1', targetSnaps: ['anas-backup-x-1', 'S1'], readHeld: async () => {
      heldAsked++
      return { source: true, target: true }
    } })
    assert.deepEqual(d, { state: 'clean', dataset: 'cr3dst/d', base: 'S1', writtenBytes: 0, readonly: 'on' })
    assert.equal(heldAsked, 0)
  })

  it('unknown carries the reason', async () => {
    const d = await checkTargetDrift(async () => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }), { target: 'cr3dst/d', where: ' on remote \'nas1\'', base: 'S1', targetSnaps: ['S1'] })
    assert.deepEqual(d, { state: 'unknown', dataset: 'cr3dst/d', base: 'S1', message: 'Could not check whether target \'cr3dst/d\' on remote \'nas1\' was changed since \'@S1\': permission denied' })
  })

  it('a holds read that does not answer is "could not be read", never "held"', async () => {
    assert.equal(await snapshotHeldBy(async () => ({ stdout: '', stderr: 'x', exitCode: 1 }), 'a@b', 'tag'), null)
    assert.equal(await snapshotHeldBy(async () => ok('a@b\ttag\tMon Jul 13 10:00 2026\n'), 'a@b', 'tag'), true)
    assert.equal(await snapshotHeldBy(async () => ok('a@b\tother\tMon Jul 13 10:00 2026\n'), 'a@b', 'tag'), false)
  })
})

// Review P3: the run's own set of an up-to-date exposed target.
describe('repl.drift review P3 — setting a target read-only', () => {
  it('the argv, an answer that failed, and a set that threw: never a throw, always a reason', async () => {
    const seen: string[][] = []
    assert.deepEqual(await sealTarget(async (args) => {
      seen.push(args)
      return ok('')
    }, 'backup/data'), { ok: true })
    assert.deepEqual(seen, [['set', '--', 'readonly=on', 'backup/data']])
    assert.deepEqual(await sealTarget(async () => ({ stdout: '', stderr: 'cannot set property for \'backup/data\': permission denied\n', exitCode: 1 }), 'backup/data'), { ok: false, reason: 'cannot set property for \'backup/data\': permission denied' })
    assert.deepEqual(await sealTarget(async () => {
      throw new Error('zfs set: had not answered after 30 s')
    }, 'backup/data'), { ok: false, reason: 'zfs set: had not answered after 30 s' })
  })

  it('judgeTargetState asks the set only for an up-to-date exposed target', async () => {
    let asked = 0
    const seal = async () => {
      asked++
      return { ok: true as const }
    }
    const input = { target: 'backup/data', where: '', base: 'S1', targetSnaps: ['S1'], seal }
    await judgeTargetState({ ok: true, written: 0, readonly: 'off', readonlySource: 'local' }, { ...input, sends: true })
    await judgeTargetState({ ok: true, written: 12288, readonly: 'off' }, input)
    await judgeTargetState({ ok: false, reason: 'x' }, input)
    await judgeTargetState({ ok: true, written: 0, readonly: 'on' }, input)
    assert.equal(asked, 0)
    const d = await judgeTargetState({ ok: true, written: 0, readonly: 'off', readonlySource: 'local' }, input)
    assert.equal(asked, 1)
    assert.equal(d.message, 'Target \'backup/data\' was not read-only (readonly=off, local); this run set it read-only on \'backup/data\' itself (\'zfs set readonly=on backup/data\'); datasets below it that inherit the property are read-only too. A replication task keeps its target read-only: to use this copy as a live dataset, remove the replication task into it.')
  })
})

// Review N7: "retention there can remove it" was said when this chain's tag
// was absent even with another hold on the base; ZFS does not destroy a held
// snapshot and ANAS retention skips one (reviewer probe p8).
describe('repl.drift review N7 — the held clause counts every hold on the base', () => {
  /** The captured `zfs holds -H` row (fixtures/zfs/zfs-holds-cr47e.txt, tag `keep`), re-pointed to the snapshot asked. */
  const CAPTURED_HOLDS = readFileSync(join(import.meta.dirname, '../../fixtures/zfs/zfs-holds-cr47e.txt'), 'utf-8').split('\n').filter(l => l && !l.startsWith('#'))
  const holdsOf = (snap: string, extra = ''): ExecResult => ok(`${CAPTURED_HOLDS.map(l => l.replace('w2z/p/c@s', snap)).join('\n')}\n${extra}`)

  it('the read: this chain\'s tag per side, and another hold where there is one', async () => {
    const held = await readBaseHeld(
      async () => ok('tank/data@S1\tanas-repl-abc\tThu Oct 15 22:26 2026\n'),
      async () => holdsOf('backup/data@S1'),
      'tank/data@S1',
      'backup/data@S1',
      'anas-repl-abc',
    )
    assert.deepEqual(held, { source: true, target: false, targetOther: true })
    const failed = await readBaseHeld(async () => ({ stdout: '', stderr: 'x', exitCode: 1 }), async () => holdsOf('backup/data@S1'), 'tank/data@S1', 'backup/data@S1', 'anas-repl-abc')
    assert.deepEqual(failed, { source: null, target: false, targetOther: true })
  })

  // Review 2 (R4): an exit 0 whose answer is not the captured row shape did
  // not answer either — "could not be read" (null), never "not held".
  it('an exit-0 answer that does not parse is null (could not be read), never "not held"; no line is no hold', async () => {
    assert.deepEqual(await snapshotHoldTags(async () => holdsOf('backup/data@S1'), 'backup/data@S1'), ['keep'])
    assert.deepEqual(await snapshotHoldTags(async () => ok(''), 'backup/data@S1'), [])
    for (const junk of [
      'NAME  TAG  TIMESTAMP\nbackup/data@S1  keep  Thu Oct 15 22:26 2026\n', // the header form, spaces not tabs
      'backup/data@S1\tkeep\n', // two fields
      'backup/data@S2\tkeep\tThu Oct 15 22:26 2026\n', // another snapshot
      'backup/data@S1\t\tThu Oct 15 22:26 2026\n', // no tag
      'backup/data@S1\tkeep\tThu Oct 15 22:26 2026\r\n', // a carriage return
      `${CAPTURED_HOLDS[0].replace('w2z/p/c@s', 'backup/data@S1')}\ngarbage\n`, // one good row and one not
    ]) {
      assert.equal(await snapshotHoldTags(async () => ok(junk), 'backup/data@S1'), null, JSON.stringify(junk))
    }
    const held = await readBaseHeld(async () => ok('tank/data@S1\tanas-repl-abc\tThu Oct 15 22:26 2026\n'), async () => ok('garbage\n'), 'tank/data@S1', 'backup/data@S1', 'anas-repl-abc')
    assert.deepEqual(held, { source: true, target: null })
    assert.match(modifiedSentence({ target: 'backup/data', where: '', base: 'S1', writtenBytes: 12288, newer: [], readonly: 'on', held }), /whether '@S1' is held by this replication could not be read\.$/)
  })

  const base = { target: 'backup/data', where: '', base: 'S1', writtenBytes: 12288, newer: [], readonly: 'on' }

  it('another hold on the target: retention cannot remove it there, and the sentence says so', () => {
    assert.match(modifiedSentence({ ...base, held: { source: true, target: false, targetOther: true } }), /; '@S1' is not held by this replication on the target; another hold keeps it there \(ZFS does not destroy a held snapshot\)\.$/)
  })

  it('neither side ours, another hold only on the target: each side said as it is', () => {
    assert.match(modifiedSentence({ ...base, held: { source: false, target: false, targetOther: true } }), /; '@S1' is not held by this replication on either side, so retention on the source can remove it; another hold keeps it on the target \(ZFS does not destroy a held snapshot\)\.$/)
  })

  it('no hold at all where ours is missing: as before, retention there can remove it', () => {
    assert.match(modifiedSentence({ ...base, held: { source: true, target: false } }), /; '@S1' is not held by this replication on the target, so retention there can remove it\.$/)
  })
})

describe('repl.drift read: the exact rows of the third capture (ZFS 2.4.2)', () => {
  /** The rows under a THIRD-capture heading `== <letter> ...` (the file's last block). */
  function third(letter: string): string {
    const block = CAPTURE.slice(CAPTURE.indexOf('# THIRD CAPTURE'))
    const lines = block.split('\n')
    const at = lines.findIndex(l => l.startsWith(`== ${letter} `))
    assert.notEqual(at, -1, `no third-capture section ${letter}`)
    const out: string[] = []
    for (const l of lines.slice(at + 1)) {
      if (l.startsWith('==') || l.startsWith('#') || l.length === 0)
        break
      out.push(l)
    }
    return `${out.join('\n')}\n`
  }

  it('A, a clean replica (rc 0; the source column of written@ reads local): clean', async () => {
    assert.deepEqual(await readTargetState(async () => ok(third('A')), 'cr3dst/d', 'S1'), { ok: true, written: 0, readonly: 'on', readonlySource: 'local' })
    assert.equal(classifyTargetState(0, 'on'), 'clean')
  })

  it('D, one cat on a writable replica (rc 0): modified, and not read-only', async () => {
    const r = await readTargetState(async () => ok(third('D')), 'cr3dst/d', 'S3')
    assert.deepEqual(r, { ok: true, written: 12288, readonly: 'off', readonlySource: 'local' })
    assert.equal(classifyTargetState(12288, 'off'), 'modified')
  })

  it('E, a base snapshot that does not exist answers `-` at EXIT 0: unknown, never clean', async () => {
    const r = await readTargetState(async () => ok(third('E')), 'cr3dst/d', 'nope')
    assert.deepEqual(r, { ok: false, reason: 'the answer could not be read' })
    const d = await checkTargetDrift(async () => ok(third('E')), { target: 'cr3dst/d', where: '', base: 'nope', targetSnaps: ['nope'] })
    assert.equal(d.state, 'unknown')
  })

  it('F, a dataset that does not exist (rc 1): unknown, with ZFS\'s own line', async () => {
    const heading = CAPTURE.split('\n').find(l => l.startsWith('== F a dataset that does not exist'))!
    const stderr = heading.slice(heading.indexOf('stderr: ') + 'stderr: '.length)
    const r = await readTargetState(async () => ({ stdout: '', stderr: `${stderr}\n`, exitCode: 1 }), 'cr3dst/nope', 'S1')
    assert.deepEqual(r, { ok: false, reason: 'cannot open \'cr3dst/nope\': dataset does not exist' })
  })
})
