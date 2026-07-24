import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseMdstat } from '../mdstat.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseMdstat', () => {
  it('parses the clean two-array state (stage-0 phase A, post-sync)', () => {
    const arrays = parseMdstat(loadFixture('mdstat-clean.txt'))
    assert.equal(arrays.length, 2)

    const r2 = arrays.find(a => a.kernelName === 'md126')!
    assert.equal(r2.active, true)
    assert.equal(r2.personality, 'raid1')
    assert.equal(r2.blocks, 523200)
    assert.equal(r2.raidDevices, 2)
    assert.equal(r2.activeDevices, 2)
    assert.equal(r2.statusFlags, 'UU')
    assert.equal(r2.sync, null)
    assert.deepEqual(r2.members.map(m => m.device).sort(), ['sdc2', 'sdd2'])

    const r1 = arrays.find(a => a.kernelName === 'md127')!
    assert.equal(r1.personality, 'raid5')
    assert.equal(r1.blocks, 2089984)
    assert.deepEqual(r1.statusFlags, 'UUU')
    // Device NUMBERS are preserved (sdd1 is [3] — number ≠ raid slot).
    assert.equal(r1.members.find(m => m.device === 'sdd1')!.number, 3)
  })

  it('parses the initial-recovery state: sync line + DELAYED marker', () => {
    const arrays = parseMdstat(loadFixture('mdstat-initial-recovery.txt'))

    const r2 = arrays.find(a => a.kernelName === 'md126')!
    assert.equal(r2.syncDelayed, true)
    assert.equal(r2.sync, null)

    const r1 = arrays.find(a => a.kernelName === 'md127')!
    // [3/2] [UU_] — degraded-looking while the initial sync builds parity.
    assert.equal(r1.raidDevices, 3)
    assert.equal(r1.activeDevices, 2)
    assert.equal(r1.statusFlags, 'UU_')
    assert.ok(r1.sync)
    assert.equal(r1.sync.action, 'recovery')
    assert.equal(r1.sync.percent, 1.9)
    assert.equal(r1.sync.doneBlocks, 20472)
    assert.equal(r1.sync.totalBlocks, 1044992)
    assert.equal(r1.sync.finishMinutes, 0.8)
    assert.equal(r1.sync.speedKibPerSec, 20472)
  })

  it('parses the three-array post-expansion state (phase B)', () => {
    const arrays = parseMdstat(loadFixture('mdstat-expanded.txt'))
    assert.equal(arrays.length, 3)
    // Kernel numbers INVERTED from creation order (GT-2) — parser just reports.
    assert.deepEqual(arrays.map(a => a.kernelName), ['md125', 'md126', 'md127'])
    const converted = arrays.find(a => a.kernelName === 'md126')!
    assert.equal(converted.personality, 'raid5')
    assert.equal(converted.members.length, 3)
  })

  it('parses the degraded-reshape drill: (F) member + reshape line (phase C1)', () => {
    const arrays = parseMdstat(loadFixture('mdstat-reshape-degraded.txt'))
    const r1 = arrays.find(a => a.kernelName === 'md127')!
    assert.equal(r1.members.length, 5)
    const failed = r1.members.find(m => m.device === 'sdb1')!
    assert.equal(failed.faulty, true)
    assert.equal(failed.spare, false)
    assert.equal(r1.raidDevices, 5)
    assert.equal(r1.activeDevices, 4)
    assert.equal(r1.statusFlags, '_UUUU')
    assert.ok(r1.sync)
    assert.equal(r1.sync.action, 'reshape')
    assert.equal(r1.sync.percent, 0.4)
    assert.equal(r1.sync.finishMinutes, 16.7)
    assert.equal(r1.sync.speedKibPerSec, 1024)
  })

  it('parses a partial fragment: --replace with an (R) member (phase D)', () => {
    // grep -A3 output — no Personalities header, single array block.
    const arrays = parseMdstat(loadFixture('mdstat-replace-fragment.txt'))
    assert.equal(arrays.length, 1)
    const r1 = arrays[0]
    const replacement = r1.members.find(m => m.device === 'sdg1')!
    assert.equal(replacement.replacement, true)
    assert.equal(replacement.number, 7)
    assert.equal(r1.sync!.action, 'recovery')
    assert.equal(r1.sync!.percent, 1.5)
    assert.equal(r1.sync!.speedKibPerSec, 3276)
  })

  it('parses the GT-8 inactive-all-spares state (post-power-loss assembly)', () => {
    const arrays = parseMdstat(loadFixture('mdstat-inactive-spares.txt'))
    assert.equal(arrays.length, 1)
    const a = arrays[0]
    assert.equal(a.active, false)
    assert.equal(a.personality, null)
    assert.equal(a.members.length, 4)
    assert.ok(a.members.every(m => m.spare))
    assert.equal(a.blocks, 4179968)
  })

  it('flags (auto-read-only) without treating it as a distinct state (GT-9)', () => {
    // The normal post-assembly state of every array until first write.
    const text = [
      'Personalities : [raid1] [raid5]',
      'md127 : active (auto-read-only) raid5 sdd1[3] sdc1[1] sdb1[0]',
      '      2089984 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]',
      '',
      'unused devices: <none>',
    ].join('\n')
    const [a] = parseMdstat(text)
    assert.equal(a.active, true)
    assert.equal(a.readOnly, true)
    assert.equal(a.autoReadOnly, true)
    assert.equal(a.personality, 'raid5')
    assert.equal(a.members.length, 3)
  })

  it('is total: garbage and empty input yield an empty list', () => {
    assert.deepEqual(parseMdstat(''), [])
    assert.deepEqual(parseMdstat('not mdstat at all\nnope'), [])
  })
})
