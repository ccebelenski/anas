import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLsblk } from '../lsblk.js'
import { parseDiskByIdListing } from '../disk-by-id.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/system')

function loadJson(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'))
}
function loadText(name: string) {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('parseLsblk', () => {
  it('parses all physical disks', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const names = disks.map(d => d.name)
    assert.ok(names.includes('sda'))
    assert.ok(names.includes('sdb'))
    assert.ok(names.includes('sdf'))
    assert.equal(disks.length, 6)
  })

  it('identifies system disk', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sda = disks.find(d => d.name === 'sda')
    assert.ok(sda)
    assert.equal(sda.status, 'system')
  })

  it('identifies pool member disks', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const poolDisks = new Map([
      ['ata-WDC_WD2003FZEX-00SRLA0_WD-12345678', 'testpool'],
      ['ata-WDC_WD2003FZEX-00SRLA0_WD-23456789', 'testpool'],
    ])
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap, poolDisks)

    const sdb = disks.find(d => d.name === 'sdb')
    assert.ok(sdb)
    assert.equal(sdb.status, 'pool_member')
    assert.equal(sdb.poolName, 'testpool')
  })

  it('identifies available (unused) disks', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sdf = disks.find(d => d.name === 'sdf')
    assert.ok(sdf)
    assert.equal(sdf.status, 'available')
    assert.equal(sdf.poolName, null)
  })

  it('parses disk properties correctly', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sdb = disks.find(d => d.name === 'sdb')
    assert.ok(sdb)
    assert.equal(sdb.size, 268435456000)
    assert.ok(sdb.model?.includes('WDC'))
    assert.equal(sdb.serial, 'WD-12345678')
    assert.equal(sdb.transport, 'sata')
    assert.equal(sdb.rotational, true)
  })

  it('parses partitions', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    const sda = disks.find(d => d.name === 'sda')
    assert.ok(sda)
    assert.ok(sda.partitions.length >= 2)

    const rootPart = sda.partitions.find(p => p.mountpoint === '/')
    assert.ok(rootPart)
    assert.equal(rootPart.fstype, 'ext4')
  })

  it('all sizes are numbers', () => {
    const byIdMap = parseDiskByIdListing(loadText('disk-by-id.txt'))
    const disks = parseLsblk(loadJson('lsblk.json'), byIdMap)

    for (const disk of disks) {
      assert.equal(typeof disk.size, 'number')
      for (const part of disk.partitions) {
        assert.equal(typeof part.size, 'number')
      }
    }
  })
})
