import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  matchAhrArrayName,
  mdadmDetailExportArgs,
  parseMdadmDetailExport,
  stripHomehost,
} from '../mdadm-detail.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseMdadmDetailExport', () => {
  it('parses the raid5 band array export (stage-0 phase A)', () => {
    const r1 = parseMdadmDetailExport(loadFixture('mdadm-export-r1.txt'))
    assert.equal(r1.level, 'raid5')
    assert.equal(r1.devices, 3)
    assert.equal(r1.metadata, '1.2')
    assert.equal(r1.uuid, '8f425218:8811d919:db5d4baa:f414bbac')
    assert.equal(r1.devName, 'ahr0-r1')
    // MD_NAME carries the homehost prefix after some assembly paths (GT-3).
    assert.equal(r1.name, 'anas-pve:ahr0-r1')
    assert.equal(r1.members.length, 3)
    assert.deepEqual(
      r1.members.find(m => m.dev === '/dev/sdb1'),
      { dev: '/dev/sdb1', role: '0' },
    )
    assert.deepEqual(
      r1.members.find(m => m.dev === '/dev/sdd1'),
      { dev: '/dev/sdd1', role: '2' },
    )
  })

  it('parses the raid1 band array export', () => {
    const r2 = parseMdadmDetailExport(loadFixture('mdadm-export-r2.txt'))
    assert.equal(r2.level, 'raid1')
    assert.equal(r2.devices, 2)
    assert.equal(r2.uuid, '7cf3b711:6f0d9a8b:16467c9c:e6028ee8')
    assert.equal(r2.name, 'anas-pve:ahr0-r2')
    assert.equal(r2.members.length, 2)
  })

  it('tolerates partial output (grep-filtered capture, phase B)', () => {
    const partial = parseMdadmDetailExport('MD_LEVEL=raid5\nMD_DEVICES=4\n')
    assert.equal(partial.level, 'raid5')
    assert.equal(partial.devices, 4)
    assert.equal(partial.uuid, null)
    assert.equal(partial.name, null)
    assert.deepEqual(partial.members, [])
  })

  it('is total: empty/garbage input yields an all-null record', () => {
    const empty = parseMdadmDetailExport('')
    assert.equal(empty.level, null)
    assert.deepEqual(empty.members, [])
    assert.equal(parseMdadmDetailExport('no equals sign here').level, null)
  })
})

describe('stripHomehost', () => {
  it('normalizes both observed name forms (GT-3)', () => {
    // Clean boot: homehost-prefixed. Hotplug assembly: bare.
    assert.equal(stripHomehost('anas-pve:ahr0-r1'), 'ahr0-r1')
    assert.equal(stripHomehost('ahr0-r2'), 'ahr0-r2')
  })
})

describe('matchAhrArrayName', () => {
  it('matches the <pool>-r<N> convention, homehost-tolerant', () => {
    assert.deepEqual(matchAhrArrayName('ahr0-r1'), { pool: 'ahr0', band: 1 })
    assert.deepEqual(matchAhrArrayName('anas-pve:ahr0-r2'), { pool: 'ahr0', band: 2 })
    assert.deepEqual(matchAhrArrayName('ahr2t-r1'), { pool: 'ahr2t', band: 1 })
    // A pool name that itself ends in -r<N>: the LAST suffix is the band.
    assert.deepEqual(matchAhrArrayName('tank-r1-r2'), { pool: 'tank-r1', band: 2 })
  })

  it('rejects foreign/non-AHR names', () => {
    assert.equal(matchAhrArrayName('0'), null)
    assert.equal(matchAhrArrayName('md127'), null)
    assert.equal(matchAhrArrayName('tank'), null)
    assert.equal(matchAhrArrayName('tank-r0'), null) // bands are 1-based
    assert.equal(matchAhrArrayName(''), null)
  })
})

describe('mdadmDetailExportArgs', () => {
  it('builds the structured --export invocation (GT-13)', () => {
    assert.deepEqual(
      mdadmDetailExportArgs('/dev/md127'),
      ['--detail', '--export', '/dev/md127'],
    )
  })
})
