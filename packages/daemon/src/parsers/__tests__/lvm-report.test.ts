import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  lvIsActive,
  LVS_ARGS,
  parseLvmSize,
  parseLvsReport,
  parsePvsReport,
  parseVgsReport,
  PVS_ARGS,
  VGS_ARGS,
} from '../lvm-report.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/ahr')
function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseLvmSize', () => {
  it('parses the exact byte form (--units b --nosuffix)', () => {
    assert.equal(parseLvmSize('2671771648'), 2671771648)
    assert.equal(parseLvmSize('0'), 0)
  })

  it('parses lvm human-suffixed forms (the stage-0 capture shape)', () => {
    // Lowercase = powers of 1024.
    assert.equal(parseLvmSize('508.00m'), 508 * 1024 ** 2)
    assert.equal(parseLvmSize('1.99g'), Math.round(1.99 * 1024 ** 3))
    // `<` marks display rounding — ignored.
    assert.equal(parseLvmSize('<2.49g'), Math.round(2.49 * 1024 ** 3))
    // Uppercase = powers of 1000 (lvm --units semantics).
    assert.equal(parseLvmSize('1.00G'), 1000 ** 3)
    // Trailing-space quirk in pv_free ("0 ").
    assert.equal(parseLvmSize('0 '), 0)
    // Byte-suffixed form (--units b WITHOUT --nosuffix).
    assert.equal(parseLvmSize('532676608B'), 532676608)
  })

  it('is fail-open: garbage yields 0', () => {
    assert.equal(parseLvmSize(undefined), 0)
    assert.equal(parseLvmSize(''), 0)
    assert.equal(parseLvmSize('lots'), 0)
    assert.equal(parseLvmSize('1.5x'), 0)
  })
})

describe('parsePvsReport', () => {
  it('parses the stage-0 pvs capture (two band-array PVs in vg ahr0)', () => {
    const pvs = parsePvsReport(loadFixture('lvm-pvs.json'))
    assert.equal(pvs.length, 2)
    const r2 = pvs.find(p => p.name === '/dev/md126')!
    assert.equal(r2.vgName, 'ahr0')
    assert.equal(r2.sizeBytes, 508 * 1024 ** 2)
    assert.equal(r2.freeBytes, 0)
    const r1 = pvs.find(p => p.name === '/dev/md127')!
    assert.equal(r1.sizeBytes, Math.round(1.99 * 1024 ** 3))
  })

  it('parses the exact byte form', () => {
    // Shape check for the form the daemon actually runs (--units b --nosuffix);
    // no byte-form ground truth was captured in stage 0 (see fixtures NOTES.md).
    const json = JSON.stringify({
      report: [{ pv: [{ pv_name: '/dev/md127', vg_name: 'ahr0', pv_size: '2140143616', pv_free: '0', dev_size: '2140143616' }] }],
    })
    assert.deepEqual(parsePvsReport(json), [
      { name: '/dev/md127', vgName: 'ahr0', sizeBytes: 2140143616, freeBytes: 0, devSizeBytes: 2140143616 },
    ])
  })

  it('is total: malformed JSON yields an empty list', () => {
    assert.deepEqual(parsePvsReport('not json'), [])
    assert.deepEqual(parsePvsReport('{}'), [])
  })
})

describe('parseVgsReport', () => {
  it('parses the stage-0 vgs capture', () => {
    const vgs = parseVgsReport(loadFixture('lvm-vgs.json'))
    assert.equal(vgs.length, 1)
    const vg = vgs[0]
    assert.equal(vg.name, 'ahr0')
    assert.equal(vg.pvCount, 2)
    assert.equal(vg.lvCount, 1)
    assert.equal(vg.sizeBytes, Math.round(2.49 * 1024 ** 3)) // "<2.49g"
    assert.equal(vg.freeBytes, 0)
  })
})

describe('parseLvsReport', () => {
  it('parses the stage-0 lvs capture (the one <pool>-vol LV)', () => {
    const lvs = parseLvsReport(loadFixture('lvm-lvs.json'))
    assert.equal(lvs.length, 1)
    const lv = lvs[0]
    assert.equal(lv.name, 'ahr0-vol')
    assert.equal(lv.vgName, 'ahr0')
    assert.equal(lv.attr, '-wi-a-----')
    assert.equal(lv.sizeBytes, Math.round(2.49 * 1024 ** 3))
  })
})

// Story cr.31 (docs/LIVE-PROOF-0.4.4-wave1b.md R2-D1): LVS_ARGS carries the
// SEGMENT fields cache_mode/cache_policy, so lvs prints one row per segment.
// The parser returns one record per LV — captured on real LVM 2.03.31.
describe('parseLvsReport — one record per LV over a per-segment report (cr.31)', () => {
  it('the two-band capture lists the LV twice; the parser returns it once', () => {
    const json = loadFixture('lvs-multiseg-two-bands.json')
    assert.equal(JSON.parse(json).report[0].lv.length, 2, 'the capture itself carries one row per segment')
    assert.deepEqual(parseLvsReport(json), [{
      name: 'cr31seg-vol',
      vgName: 'cr31seg',
      attr: '-wi-a-----',
      sizeBytes: 192937984,
      cacheMode: null,
      cachePolicy: null,
      cacheTotalBlocks: null,
      cacheUsedBlocks: null,
      cacheReadHits: null,
      cacheReadMisses: null,
      cacheDirtyBlocks: null,
    }])
  })

  it('the expanded capture lists the LV three times; one record, the WHOLE LV size', () => {
    const json = loadFixture('lvs-multiseg-expanded.json')
    assert.equal(JSON.parse(json).report[0].lv.length, 3)
    const lvs = parseLvsReport(json)
    assert.equal(lvs.length, 1)
    assert.equal(lvs[0].sizeBytes, 289406976)
    // The same LV in the default columns (ahr-cache's LVS_STATE_ARGS) is one row
    // to begin with — both forms now read the same.
    assert.deepEqual(parseLvsReport(loadFixture('lvs-multiseg-expanded-default-columns.json')).map(l => [l.vgName, l.name, l.sizeBytes]), [['cr31seg', 'cr31seg-vol', 289406976]])
  })

  it('a cached LV over a three-segment origin is one row with its cache cells', () => {
    const lvs = parseLvsReport(loadFixture('lvs-cached-multiseg-origin.json'))
    assert.equal(lvs.length, 1)
    assert.equal(lvs[0].attr, 'Cwi-a-C---')
    assert.equal(lvs[0].sizeBytes, 289406976)
    assert.equal(lvs[0].cacheMode, 'writethrough')
    assert.equal(lvs[0].cachePolicy, 'smq')
    assert.equal(lvs[0].cacheTotalBlocks, 1344)
    assert.equal(lvs[0].cacheUsedBlocks, 0)
    assert.equal(lvs[0].cacheDirtyBlocks, 0)
  })

  it('a cached single-segment LV is unchanged', () => {
    const lvs = parseLvsReport(loadFixture('lvs-cached-single-seg.json'))
    assert.deepEqual(lvs.map(l => [l.vgName, l.name, l.cacheMode, l.cachePolicy, l.cacheTotalBlocks]), [['cr31one', 'cr31one-vol', 'writethrough', 'smq', 1344]])
  })

  it('collapses by (vg, lv), keeps first-seen order, and takes a cache cell from whichever segment row carries it', () => {
    const json = JSON.stringify({ report: [{ lv: [
      { lv_name: 'b-vol', vg_name: 'b', lv_attr: '-wi-a-----', lv_size: '10', cache_mode: '', cache_policy: '' },
      { lv_name: 'a-vol', vg_name: 'a', lv_attr: 'Cwi-aoC---', lv_size: '20', cache_mode: '', cache_policy: '', cache_total_blocks: '' },
      { lv_name: 'a-vol', vg_name: 'a', lv_attr: 'Cwi-aoC---', lv_size: '20', cache_mode: 'writethrough', cache_policy: 'smq', cache_total_blocks: '8' },
      { lv_name: 'b-vol', vg_name: 'b', lv_attr: '-wi-a-----', lv_size: '10', cache_mode: '', cache_policy: '' },
      // Same LV name in ANOTHER VG is another LV.
      { lv_name: 'b-vol', vg_name: 'a', lv_attr: '-wi-a-----', lv_size: '30' },
    ] }] })
    assert.deepEqual(parseLvsReport(json).map(l => [l.vgName, l.name, l.sizeBytes, l.cacheMode, l.cachePolicy, l.cacheTotalBlocks]), [
      ['b', 'b-vol', 10, null, null, null],
      ['a', 'a-vol', 20, 'writethrough', 'smq', 8],
      ['a', 'b-vol', 30, null, null, null],
    ])
  })
})

// The LV state field (issue #18) — what says a volume over a partial VG is not
// merely reduced but UNREACHABLE.
describe('lvIsActive', () => {
  it('reads the healthy stage-0 LV as active', () => {
    assert.equal(lvIsActive(parseLvsReport(loadFixture('lvm-lvs.json'))[0].attr), true)
  })

  it('an LV over a PARTIAL vg is NOT active (the state field is what matters)', () => {
    // `-wi-----p-`: state field `-`, and lvm's `p` health flag for partial. The
    // volume is listed and sized, and cannot be read.
    assert.equal(lvIsActive('-wi-----p-'), false)
    assert.equal(lvIsActive('-wi-------'), false)
  })

  it('every non-`a` state code reads as not active', () => {
    for (const state of ['-', 's', 'S', 'I', 'm', 'M', 'd', 'i', 'X'])
      assert.equal(lvIsActive(`-wi-${state}-----`), false, `state '${state}'`)
  })

  it('an absent or truncated attr column is UNKNOWN, never a failure verdict', () => {
    assert.equal(lvIsActive(''), null)
    assert.equal(lvIsActive('-wi-'), null)
  })
})

describe('report ARGS', () => {
  it('always request json + exact bytes', () => {
    for (const args of [PVS_ARGS, VGS_ARGS, LVS_ARGS]) {
      assert.deepEqual(args.slice(0, 5), ['--reportformat', 'json', '--units', 'b', '--nosuffix'])
    }
  })

  // pvs additionally asks for the underlying device size, so a PV left smaller
  // than its (grown) array is detectable from structured output (issue #13).
  it('pvs appends dev_size WITHOUT dropping the default columns', () => {
    assert.deepEqual(PVS_ARGS.slice(5), ['-o', '+dev_size'])
  })

  // vgs additionally asks for the VG UUID (story ident.3) — the identity an
  // expansion intent records, since a recreated pool reuses the VG NAME.
  it('vgs appends vg_uuid WITHOUT dropping the default columns', () => {
    assert.deepEqual(VGS_ARGS.slice(5), ['-o', '+vg_uuid'])
    const json = JSON.stringify({ report: [{ vg: [{ vg_name: 't2', vg_uuid: 'AbCd-1234', pv_count: '1', lv_count: '1', vg_size: '1', vg_free: '0' }] }] })
    assert.equal(parseVgsReport(json)[0].uuid, 'AbCd-1234')
    assert.equal(parseVgsReport(JSON.stringify({ report: [{ vg: [{ vg_name: 't2' }] }] }))[0].uuid, null)
  })

  it('a report without dev_size reads 0 — never a spurious resize', () => {
    const json = JSON.stringify({ report: [{ pv: [{ pv_name: '/dev/md127', vg_name: 'ahr0', pv_size: '100', pv_free: '0' }] }] })
    assert.equal(parsePvsReport(json)[0].devSizeBytes, 0)
  })
})
