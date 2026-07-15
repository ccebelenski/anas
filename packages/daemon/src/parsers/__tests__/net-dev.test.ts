import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { computeNetTelemetry, parseProcNetDev } from '../net-dev.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/telemetry')
const netDevText = readFileSync(join(fixturesDir, 'proc-net-dev.txt'), 'utf-8')

describe('parseProcNetDev', () => {
  it('extracts cumulative rx/tx bytes per interface from the real fixture', () => {
    const ifaces = parseProcNetDev(netDevText)
    const byName = new Map(ifaces.map(i => [i.name, i]))
    assert.equal(byName.get('lo')?.rxBytes, 5172600)
    assert.equal(byName.get('lo')?.txBytes, 5172600)
    assert.equal(byName.get('enp1s0')?.rxBytes, 495669864)
    assert.equal(byName.get('enp1s0')?.txBytes, 2478397427)
    assert.equal(byName.get('vmbr0')?.rxBytes, 480573568)
    assert.equal(byName.get('vmbr0')?.txBytes, 2478397427)
  })
})

describe('computeNetTelemetry — two snapshots', () => {
  it('computes per-second rates, excludes lo, and sums totals', () => {
    const prev = [
      { name: 'lo', rxBytes: 100, txBytes: 100 },
      { name: 'enp1s0', rxBytes: 1000, txBytes: 5000 },
      { name: 'vmbr0', rxBytes: 2000, txBytes: 8000 },
    ]
    const cur = [
      { name: 'lo', rxBytes: 999, txBytes: 999 },
      { name: 'enp1s0', rxBytes: 3000, txBytes: 9000 }, // Δ 2000 rx / 4000 tx
      { name: 'vmbr0', rxBytes: 2500, txBytes: 8000 }, //  Δ  500 rx /    0 tx
    ]
    const net = computeNetTelemetry(prev, cur, 1000) // 1 second window
    const names = net.interfaces.map(i => i.name)
    assert.ok(!names.includes('lo'), 'loopback excluded')
    const enp = net.interfaces.find(i => i.name === 'enp1s0')!
    assert.equal(enp.rxBytesPerSec, 2000)
    assert.equal(enp.txBytesPerSec, 4000)
    assert.equal(net.totalRxBytesPerSec, 2500) // 2000 + 500
    assert.equal(net.totalTxBytesPerSec, 4000) // 4000 + 0
  })

  it('a half-second window doubles the per-second rate', () => {
    const prev = [{ name: 'eth0', rxBytes: 0, txBytes: 0 }]
    const cur = [{ name: 'eth0', rxBytes: 1000, txBytes: 0 }]
    const net = computeNetTelemetry(prev, cur, 500)
    assert.equal(net.interfaces[0].rxBytesPerSec, 2000)
  })

  it('a counter reset (negative delta) or zero window clamps to 0', () => {
    const prev = [{ name: 'eth0', rxBytes: 5000, txBytes: 0 }]
    const cur = [{ name: 'eth0', rxBytes: 10, txBytes: 0 }]
    assert.equal(computeNetTelemetry(prev, cur, 1000).interfaces[0].rxBytesPerSec, 0)
    assert.equal(computeNetTelemetry([{ name: 'eth0', rxBytes: 0, txBytes: 0 }], cur, 0).interfaces[0].rxBytesPerSec, 0)
  })
})
