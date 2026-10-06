import type { BackupNestedScan } from '@anas/shared'
import type { MockExecutor } from '../../executor/mock.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { BackupNestedPreviewResponse } from '@anas/shared'
import { createServer } from '../../server.js'

/**
 * backup2.11 — the SAVE-TIME half of the source guard: `preview-nested` carries
 * the configured-but-unmounted fact for each archive row, so the wizard can
 * warn before a task is saved against a share that is not there.
 *
 * It is a WARNING and nothing more. Save is not blocked and this endpoint
 * cannot refuse: the fact is time-dependent (a task may legitimately be defined
 * while a share is down, and the timer fires later), so the RUN is the gate —
 * which is what `backup-runner-source-guard.test.ts` pins.
 *
 * The mock server's `findmnt --json` fixture is the mount table here
 * (`fixtures/mounts/findmnt-full.json`): `/mnttest` is mounted in it,
 * `/mnt/gt-absent` is not. The fstab is this test's own, via ANAS_FSTAB_PATH.
 */

const IDENTITY = {
  'x-anas-user': 'root@pam',
  'x-anas-user-uid': '0',
  'x-anas-request-id': randomUUID(),
}
const JSON_HEADERS = { ...IDENTITY, 'content-type': 'application/json' }

/**
 * Two configured mounts: `/mnttest` (present in the mock mount table) and
 * `/mnt/gt-absent` (a CIFS share that never came up — the incident shape).
 */
const FSTAB = [
  '# /etc/fstab: static file system information.',
  'UUID=deadbeef   /               ext4  errors=remount-ro  0  1',
  // The dataset the capture really has at /mnttest (findmnt-full.json):
  // since ident.4 (c) a target counts as mounted only when its live source
  // is the configured one.
  'mnttest         /mnttest        zfs   defaults  0  0',
  '//nas/gtabsent  /mnt/gt-absent  cifs  credentials=/etc/anas/creds/gt,nofail  0  0',
  '',
].join('\n')

function mockOf(server: ReturnType<typeof createServer>): MockExecutor {
  return (server as unknown as { executor: MockExecutor }).executor
}

describe('preview-nested carries the unmounted fact (backup2.11)', () => {
  let server: ReturnType<typeof createServer>
  let dir: string
  const saved: Record<string, string | undefined> = {}

  function setEnv(k: string, v: string): void {
    saved[k] = process.env[k]
    process.env[k] = v
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-backupguard-'))
    setEnv('ANAS_SYSTEMD_DIR', dir)
    setEnv('ANAS_BACKUP_REPOS_FILE', join(dir, 'backup-repos.json'))
    setEnv('ANAS_BACKUP_CREDS_DIR', join(dir, 'creds'))
    setEnv('ANAS_FSTAB_PATH', join(dir, 'fstab'))
    await writeFile(join(dir, 'fstab'), FSTAB)
    server = createServer({ mock: true, logger: false })
    // The boundary walk: whatever it answers, the unmounted fact rides the same
    // scan — so a single permissive fixture is enough for every path here.
    mockOf(server).addFixture({ command: '/usr/bin/timeout', result: { stdout: '', stderr: '', exitCode: 0 } })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined)
        delete process.env[k]
      else process.env[k] = v
    }
  })

  async function preview(payload: Record<string, unknown>): Promise<BackupNestedScan[]> {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/backup/tasks/preview-nested',
      headers: JSON_HEADERS,
      payload,
    })
    assert.equal(res.statusCode, 200)
    return (res.json() as { data: { archives: BackupNestedScan[] } }).data.archives
  }

  it('a path on a configured-but-unmounted mount answers `unmounted`, naming the mount', async () => {
    const [scan] = await preview({ path: '/mnt/gt-absent/photos' })
    assert.equal(scan.path, '/mnt/gt-absent/photos')
    // The wizard's alert is built from exactly these fields — the mountpoint the
    // path sits on and the fstab source that is missing. They can only come
    // from fstab: there is nothing in the kernel's table to read them from.
    assert.deepEqual(scan.unmounted, {
      mountpoint: '/mnt/gt-absent',
      source: '//nas/gtabsent',
      fstype: 'cifs',
      disabled: false,
    })
  })

  it('a path on a MOUNTED configured mount carries no `unmounted` key at all', async () => {
    const [scan] = await preview({ path: '/mnttest' })
    assert.equal(scan.path, '/mnttest')
    assert.equal(scan.unmounted, undefined, 'absent, not a falsy placeholder')
    assert.ok(!('unmounted' in scan), 'the key is not emitted at all')
  })

  it('an `img` source is guarded the same way — nothing about it is stat\'ed', async () => {
    const mock = mockOf(server)
    mock.calls.length = 0
    const [scan] = await preview({ path: '/mnt/gt-absent/vm-100.raw', kind: 'img' })
    assert.equal(scan.unmounted?.mountpoint, '/mnt/gt-absent')
    // The img branch skips the walk entirely; the guard is pure prefix
    // arithmetic over two tables, so it never touches the path either.
    assert.ok(!mock.calls.some(c => c.command === '/usr/bin/timeout'), 'no tree walk for an image source')
  })

  it('the per-archive form answers per row: the unmounted one warns, the mounted one does not', async () => {
    const archives = await preview({
      archives: [
        { name: 'absent', path: '/mnt/gt-absent' },
        { name: 'present', path: '/mnttest' },
      ],
    })
    assert.deepEqual(archives.map(a => a.archive), ['absent', 'present'])
    assert.equal(archives[0].unmounted?.source, '//nas/gtabsent')
    assert.equal(archives[1].unmounted, undefined)
  })

  it('the whole response — with and without the field — parses with the shared schema', async () => {
    const warned = await preview({ path: '/mnt/gt-absent' })
    const quiet = await preview({ path: '/mnttest' })
    // An old-shape client is unaffected because the field is ADDITIVE and
    // OPTIONAL: both bodies are the same schema, and a daemon that never sends
    // the key still parses.
    assert.ok(BackupNestedPreviewResponse.safeParse({ archives: warned }).success)
    assert.ok(BackupNestedPreviewResponse.safeParse({ archives: quiet }).success)
    const stripped = quiet.map(({ unmounted: _drop, ...rest }) => rest)
    assert.ok(BackupNestedPreviewResponse.safeParse({ archives: stripped }).success)
  })

  it('FAIL OPEN: an unreadable fstab configures nothing, so nothing is reported unmounted', async () => {
    await rm(join(dir, 'fstab'))
    const [scan] = await preview({ path: '/mnt/gt-absent' })
    assert.equal(scan.unmounted, undefined, 'a guard that cannot see the system claims nothing')
  })
})
