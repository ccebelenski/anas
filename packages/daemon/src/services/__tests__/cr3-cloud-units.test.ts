import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CloudSyncTask as CloudSyncTaskSchema } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { collectCloudWarnings, readAllTasksChecked } from '../cloud-units.js'

/**
 * cr3 (the backup area's hand-off): the dashboard's cloud collector reads the
 * task store CHECKED — readable tasks still warn, and what could not be read
 * is reported by name through `incomplete`, never read as "no warnings".
 */
const TASK = CloudSyncTaskSchema.parse({ name: 'good', source: '/tank/p', remote: 'gt', path: '', schedule: 'daily' })

describe('cr3: the cloud task store read checked', () => {
  it('a readable unit is a task; an unparseable one is named; nothing throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-cloudunits-'))
    try {
      await writeFile(join(dir, 'anas-cloud-good.service'), `[Unit]\n# X-ANAS-Task=${JSON.stringify(TASK)}\n`, 'utf-8')
      await writeFile(join(dir, 'anas-cloud-legacy.service'), '[Unit]\n# X-ANAS-Task={not json\n', 'utf-8')
      const store = await readAllTasksChecked(dir)
      assert.equal(store.listed, true)
      assert.deepEqual(store.tasks.map(t => t.name), ['good'])
      assert.deepEqual(store.unreadable, [{ file: 'anas-cloud-legacy.service', why: 'parsed' }])

      const reasons: string[] = []
      const mock = new MockExecutor()
      // Composed at the cr3 merge with the shared collector (task-units.ts):
      // the unparseable unit is named through the callback, and because this
      // bare world answers no `systemctl show`, NO row is readable — the
      // shared rule then fails the section (unavailable) rather than answer
      // "no warnings".
      await assert.rejects(collectCloudWarnings(mock, dir, r => reasons.push(r)), /systemd could not be asked about cloud sync task 'good'/)
      assert.deepEqual(reasons, ['cloud sync task unit anas-cloud-legacy.service could not be parsed'])
      assert.ok(mock.calls.some(c => c.args.some(a => a.includes('anas-cloud-good'))), 'the readable task was still derived')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable unit directory is reported, not read as an empty store', async () => {
    // A real UNREADABLE shape (second review, 10): a FILE where the directory
    // should be (ENOTDIR) — not a missing path, which a shared collector may
    // fairly read as an empty store.
    const dir = await mkdtemp(join(tmpdir(), 'anas-cr3-cloudunits-'))
    try {
      const notDir = join(dir, 'systemd')
      await writeFile(notDir, 'not a directory', 'utf-8')
      const reasons: string[] = []
      // Composed at the cr3 merge: the shared collector fails the whole
      // section on a directory that cannot be listed (never an empty store).
      await assert.rejects(collectCloudWarnings(new MockExecutor(), notDir, r => reasons.push(r)), /could not be listed/)
      assert.deepEqual(reasons, [`the cloud sync task units in ${notDir} could not be listed`])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
