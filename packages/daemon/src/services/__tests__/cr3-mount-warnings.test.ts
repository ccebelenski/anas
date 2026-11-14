import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { readDashboardSection } from '../../routes/dashboard.js'
import { collectMountWarnings } from '../mounts.js'

/**
 * cr3.mounts INVENTED-STATE-H1 / M10 — the dashboard's mounts collector.
 * It used to catch its own failure and answer `[]` (a successful read: no
 * cards), and an unreadable findmnt table read as "nothing mounted" (a
 * "configured but not mounted" card for every boot mount). Now a failed read
 * throws, and `readDashboardSection` marks the section unavailable.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FINDMNT_FULL = readFileSync(join(__dirname, '../../fixtures/mounts/findmnt-full.json'), 'utf8')
const FSTAB = readFileSync(join(__dirname, '../../fixtures/mounts/fstab-anas-managed'), 'utf8')

describe('cr3.mounts INVENTED-STATE-H1/M10 — collectMountWarnings never answers a failed read as "no warnings"', () => {
  it('an unreadable mount table makes the mounts section unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-mw-'))
    try {
      await writeFile(join(dir, 'fstab'), FSTAB)
      const exec = new MockExecutor()
      exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: '', stderr: 'findmnt: cannot open /proc/self/mountinfo', exitCode: 1 } })
      await assert.rejects(collectMountWarnings(exec, { fstabPath: join(dir, 'fstab'), storagePath: join(dir, 'none.cfg') }), /mount table/)
      const read = await readDashboardSection(exec, 5000, 'mounts', [], e => collectMountWarnings(e, { fstabPath: join(dir, 'fstab'), storagePath: join(dir, 'none.cfg') }))
      assert.equal(read.unavailable?.section, 'mounts')
      assert.match(read.unavailable?.reason ?? '', /mount table/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an fstab that cannot be read (not ENOENT) makes it unavailable too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-mw-'))
    try {
      const exec = new MockExecutor()
      exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: FINDMNT_FULL, stderr: '', exitCode: 0 } })
      // A directory where the file should be: EISDIR, a read that failed.
      await assert.rejects(collectMountWarnings(exec, { fstabPath: dir, storagePath: join(dir, 'none.cfg') }))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cr3.mounts follow-up (4): an unreadable storage.cfg (not ENOENT) makes it unavailable — PVE\'s mounts cannot be told apart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-mw-'))
    try {
      await writeFile(join(dir, 'fstab'), FSTAB)
      const exec = new MockExecutor()
      exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: FINDMNT_FULL, stderr: '', exitCode: 0 } })
      // A directory where storage.cfg should be: EISDIR.
      await assert.rejects(collectMountWarnings(exec, { fstabPath: join(dir, 'fstab'), storagePath: dir }), /storage configuration/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a readable table still answers its warnings (a healthy read is not unavailable)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-mw-'))
    try {
      await writeFile(join(dir, 'fstab'), FSTAB)
      const exec = new MockExecutor()
      exec.addFixture({ command: '/usr/bin/findmnt', args: ['--json'], result: { stdout: FINDMNT_FULL, stderr: '', exitCode: 0 } })
      exec.addFixture({ command: '/usr/bin/timeout', result: { stdout: '4096 8203953 6637110 6291265\n', stderr: '', exitCode: 0 } })
      const read = await readDashboardSection(exec, 5000, 'mounts', [], e => collectMountWarnings(e, { fstabPath: join(dir, 'fstab'), storagePath: join(dir, 'none.cfg') }))
      assert.equal(read.unavailable, undefined)
      assert.ok(Array.isArray(read.value))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
