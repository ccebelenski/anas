import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInLane } from '../executor/deadline.js'
import { MockExecutor } from '../executor/mock.js'
import { run } from '../services/ahr-exec.js'

/**
 * cr.34 (WAVE3-DESIGN §6.2 "Per call"): `timeoutMs: null` — no deadline at
 * all — is allowed only with a `longRunning` reason, and EVERY such site is
 * listed here. A new unbounded call fails this test until it is added to the
 * table, so it is a visible diff a reviewer reads, never a silent default.
 *
 * The scan reads the daemon's non-test sources (the executor directory, which
 * defines the option, is the mechanism and not a site) and requires the
 * reason as a string literal right after the `null`, so the table can quote it.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Every no-deadline site: file (relative to packages/daemon/src) and its reason, verbatim. */
const NULL_SITES: { file: string, reason: string }[] = [
  { file: 'routes/replication.ts', reason: 'zfs send | zfs recv: a data mover, hours for a large send' },
  { file: 'services/access.ts', reason: 'recursive chown/setfacl/chmod/find over a whole tree: hours on a large dataset' },
  { file: 'services/ahr-scrub.ts', reason: 'btrfs scrub: a verify pass over the whole filesystem, hours to days on a large pool' },
  { file: 'services/backup-restore-files.ts', reason: 'proxmox-backup-client file restore: a data mover, hours for a large tree' },
  { file: 'services/backup-restore.ts', reason: 'proxmox-backup-client image restore in place: a data mover, hours for a large image' },
  { file: 'services/backup-restore.ts', reason: 'proxmox-backup-client image restore to a new backing: a data mover, hours for a large image' },
  { file: 'services/backup-runner.ts', reason: 'proxmox-backup-client backup: a data mover, hours for a large source; stopped by its cancel hook' },
  { file: 'services/cloud-runner.ts', reason: 'rclone sync/copy run: a data mover, days long; stopped by its cancel hook' },
]

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'fixtures' || path === join(SRC, 'executor'))
        continue
      out.push(...sources(path))
    }
    else if (entry.name.endsWith('.ts')) {
      out.push(path)
    }
  }
  return out
}

const NULL_RE = /timeoutMs:\s*null/g
const SITE_RE = /timeoutMs:\s*null\s*,\s*longRunning:\s*'([^']+)'/g

function byKey(a: { file: string, reason: string }, b: { file: string, reason: string }): number {
  return a.file.localeCompare(b.file) || a.reason.localeCompare(b.reason)
}

describe('cr.34: every executor call without a deadline is listed', () => {
  const found: { file: string, reason: string }[] = []
  const bare: string[] = []
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8')
    const file = relative(SRC, path)
    const sites = [...text.matchAll(SITE_RE)]
    for (const m of sites)
      found.push({ file, reason: m[1] })
    const nulls = [...text.matchAll(NULL_RE)].length
    if (nulls !== sites.length)
      bare.push(`${file}: ${nulls} \`timeoutMs: null\`, ${sites.length} with a literal reason`)
  }

  it('the table and the source agree, site for site', () => {
    const want = [...NULL_SITES]
    want.sort(byKey)
    found.sort(byKey)
    assert.deepEqual(found, want)
  })

  it('every `timeoutMs: null` carries its reason as a literal (no reason hidden in a variable)', () => {
    assert.deepEqual(bare, [])
  })

  it('every reason says what the command is and why it outlives a deadline', () => {
    for (const { reason } of NULL_SITES)
      assert.match(reason, /^\S.{10,}: .{10,}$/, reason)
  })
})

describe('cr.34: per-call budgets reach the executor', () => {
  it('the AHR run helper passes its timeoutMs (mkfs.btrfs, update-initramfs) and nothing otherwise', async () => {
    const mock = new MockExecutor()
      .addFixture({ command: '/usr/sbin/mkfs.btrfs', result: { stdout: '', stderr: '', exitCode: 0 } })
      .addFixture({ command: '/usr/sbin/pvs', result: { stdout: '', stderr: '', exitCode: 0 } })
    await runInLane({ lane: 'job', jobId: 'j' }, async () => {
      await run(mock, '/usr/sbin/mkfs.btrfs', ['/dev/x'], { timeoutMs: 1_800_000 })
      await run(mock, '/usr/sbin/pvs', [])
    })
    assert.deepEqual(mock.deadlines.map(d => [d.command, d.budgetMs, d.source]), [
      ['/usr/sbin/mkfs.btrfs', 1_800_000, 'call'],
      ['/usr/sbin/pvs', 300_000, 'lane'],
    ])
  })
})
