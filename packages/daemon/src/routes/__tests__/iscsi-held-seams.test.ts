import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertVolumeMutable } from '../datasets.js'

/**
 * The two seams `iscsi.6` had to cover but could not exercise, because the code
 * they guard DOES NOT EXIST YET — story `iscsi.6`, clause 2.
 *
 * The story names two operations ZFS lets through silently that ANAS must
 * refuse under a LUN:
 *
 *   - a dataset/volume **RENAME**. `zfs rename` under a live LUN returns exit 0,
 *     the LUN keeps serving from the already-open bdev, `udev_path` becomes a
 *     dangling path, and the NEXT BOOT RESTORE silently drops the LUN (GT-40).
 *     ANAS exposes no rename endpoint today, so there is nothing to gate — and
 *     that absence is exactly what has to be pinned, or the day one is added it
 *     will be added without the gate.
 *   - **removal of a backing image file** "wherever ANAS deletes files under a
 *     dataset". A survey of the daemon says there is no such path: the only
 *     `unlink` calls are systemd unit files under the systemd directory, plus
 *     the iSCSI LUN's OWN `?destroyBacking` delete, which is the deliberate
 *     verb, not a collision. That absence is pinned here too.
 *
 * Both tests are FAILURE ALARMS for a future change, not proofs of behaviour.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTES_DIR = join(__dirname, '..')
const SERVICES_DIR = join(__dirname, '../../services')

/** Every route/service source, excluding the test trees. */
async function sourceFiles(dir: string): Promise<{ name: string, text: string }[]> {
  const names = (await readdir(dir)).filter(n => n.endsWith('.ts'))
  return Promise.all(names.map(async name => ({ name, text: await readFile(join(dir, name), 'utf-8') })))
}

describe('iscsi.6 — the rename seam (no endpoint exists yet)', () => {
  it('the gate ACCEPTS a rename op, so a future endpoint has something to call', () => {
    const volume = {
      name: 'tank/vol1',
      pool: 'tank',
      type: 'volume' as const,
      used: 1,
      available: 1,
      referenced: 1,
      mountpoint: null,
      compression: 'lz4',
      compressratio: 1,
      quota: 0,
    }
    const held = {
      targetIqn: 'iqn.2026-08.nas.anas:vmstore',
      index: 0,
      name: 'vmdisk1',
      backingPath: '/dev/zvol/tank/vol1',
      connectedInitiators: [],
      detail: `held by iSCSI LUN 0 'vmdisk1' of target iqn.2026-08.nas.anas:vmstore (/dev/zvol/tank/vol1)`,
    }
    const refusal = assertVolumeMutable('tank/vol1', 'rename', volume, undefined, held)
    assert.ok(refusal, 'a rename of a held volume must be refused')
    assert.equal(refusal.reason, 'held-by-lun')
    assert.match(refusal.message, /Renaming volume 'tank\/vol1' is refused/)
    assert.match(refusal.message, /no confirm bypass/)
  })

  it('an UNHELD volume renames freely — the gate is about the LUN, not about renaming', () => {
    const volume = {
      name: 'tank/vol1',
      pool: 'tank',
      type: 'volume' as const,
      used: 1,
      available: 1,
      referenced: 1,
      mountpoint: null,
      compression: 'lz4',
      compressratio: 1,
      quota: 0,
    }
    assert.equal(assertVolumeMutable('tank/vol1', 'rename', volume, undefined, null), null)
  })

  it('NO dataset rename endpoint exists — if one is added, it must call the gate', async () => {
    // The alarm. ANAS runs `zfs rename` in exactly ONE place today and it is a
    // SNAPSHOT rename (`<dataset>@<snap>` → `<dataset>@<new>`), which never
    // touches the live zvol device and therefore needs no gate. A `zfs rename`
    // appearing in any other function means a DATASET rename verb now exists,
    // and it must route through `assertVolumeMutable` before it runs.
    const found: string[] = []
    for (const { name, text } of await sourceFiles(ROUTES_DIR)) {
      for (const match of text.matchAll(/exec\([^)]*,\s*\[\s*'rename'/g)) {
        const before = text.slice(0, match.index)
        const fn = [...before.matchAll(/function\s+(\w+)\s*\(/g)].at(-1)?.[1] ?? '(top level)'
        found.push(`${name}:${fn}`)
      }
    }
    assert.deepEqual(
      found,
      ['datasets.ts:renameSnapshot'],
      'a `zfs rename` outside renameSnapshot is a DATASET rename — gate it with assertVolumeMutable (story iscsi.6)',
    )
  })
})

describe('iscsi.6 — the backing-file-removal seam (no such path exists)', () => {
  /**
   * The ONLY sanctioned `unlink` callers in the daemon. Each one deletes a file
   * ANAS itself wrote into a directory ANAS owns:
   *
   *   backup-units / replication-units / snapshot-schedule-units
   *       → systemd unit + timer files under the systemd directory
   *   iscsi-mutate
   *       → the LUN's OWN backing image, and only on an explicit, confirm-gated
   *         `?destroyBacking=true`. That is the deliberate verb this story's
   *         refusals point AT, not a path that could surprise a LUN.
   *   iscsi-quarantine
   *       → the 0-byte PLACEHOLDER `targetctl restore` created for itself, and
   *         only when both stub signals agree, the LUN it belonged to has just
   *         been unmapped by this same function, and a fresh `stat` inside the
   *         iSCSI mutex still says 0 bytes (story `iscsi.8`). It cannot surprise
   *         a LUN: it IS the LUN's teardown, and it never touches a file with
   *         content.
   */
  const ALLOWED = new Set([
    'backup-units.ts',
    'replication-units.ts',
    'snapshot-schedule-units.ts',
    'iscsi-mutate.ts',
    'iscsi-quarantine.ts',
  ])

  it('nothing else in services/ deletes a file', async () => {
    for (const { name, text } of await sourceFiles(SERVICES_DIR)) {
      if (ALLOWED.has(name))
        continue
      assert.ok(
        !/\bawait unlink\(/.test(text),
        `${name} deletes a file — if it can reach a dataset, it needs the held-by-LUN gate (story iscsi.6)`,
      )
    }
  })

  it('nothing in routes/ deletes a file directly', async () => {
    for (const { name, text } of await sourceFiles(ROUTES_DIR)) {
      assert.ok(
        !/\bawait unlink\(/.test(text),
        `${name} deletes a file — if it can reach a dataset, it needs the held-by-LUN gate (story iscsi.6)`,
      )
    }
  })

  it('nothing shells out to `rm` at all', async () => {
    for (const dir of [ROUTES_DIR, SERVICES_DIR]) {
      for (const { name, text } of await sourceFiles(dir)) {
        assert.ok(
          !/exec\(\s*['"]\/(?:usr\/)?bin\/rm['"]/.test(text),
          `${name} execs /bin/rm — ANAS removes files through node, and only where it owns them`,
        )
      }
    }
  })
})
