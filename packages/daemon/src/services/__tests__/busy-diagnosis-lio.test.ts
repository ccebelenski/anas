import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import {
  diagnoseLunHolder,
  enrichBusyError,
  extractBusyDataset,
  extractBusyPath,
} from '../busy-diagnosis.js'

/**
 * The LIO branch of the busy diagnosis — story `iscsi.6`.
 *
 * There is exactly one holder `fuser` cannot see. When the kernel iSCSI target
 * is serving a zvol or an image file, `fuser -m`, `lsof` AND
 * `/sys/block/<dev>/holders/` all report nothing (GT-41): the claim exists only
 * in configfs, as `CLAIMED: IBLOCK` beside the backstore's `udev_path`. So a
 * `zpool export` or a `zfs destroy` that fails `dataset is busy` BECAUSE of a
 * LUN produced, before this branch, a busy error with an empty holder list —
 * which reads as "nothing is holding it, try again".
 *
 * Everything below runs against the REAL configfs capture from story `iscsi.1`
 * (`fixtures/iscsi/configfs-live.manifest`, materialised into a temp tree): one
 * zvol-backed LUN 0 `gtiscsi_vol1` at `/dev/zvol/gtiscsi/vol1` and one
 * fileio-backed LUN 1 `gtiscsi_lun2` at `/gtiscsi/images/lun2.raw`, on target
 * `iqn.2026-08.dev.anas.gtiscsi:target1`.
 *
 * The three-line contract this file pins:
 *   1. claimed  → the holder line names the LUN, and `fuser` is NOT run;
 *   2. unclaimed → the 3.29 process diagnosis, byte for byte as before;
 *   3. anything else (no LIO, no match, not busy) → the error verbatim.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ISCSI_FIXTURES = join(__dirname, '../../fixtures/iscsi')
const FUSER = '/usr/bin/fuser'
const GT_TARGET = 'iqn.2026-08.dev.anas.gtiscsi:target1'

describe('busy-diagnosis — the LIO branch (story iscsi.6, GT-40/GT-41)', () => {
  let dir: string
  let configfsRoot: string
  let procRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-busy-lio-'))
    configfsRoot = join(dir, 'target')
    await materializeConfigfsManifest(
      readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8'),
      configfsRoot,
    )
    procRoot = join(dir, 'proc')
    await mkdir(join(procRoot, '1234'), { recursive: true })
    await writeFile(join(procRoot, '1234', 'comm'), 'chia_harvester\n')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** An executor that WOULD name a process holder — so "fuser not consulted" bites. */
  function execWithHolder(path: string): MockExecutor {
    const exec = new MockExecutor()
    exec.addFixture({ command: FUSER, args: ['-m', path], result: { stdout: '1234\n', stderr: '', exitCode: 0 } })
    return exec
  }

  function fuserCalls(exec: MockExecutor): number {
    return exec.calls.filter(c => c.command === FUSER).length
  }

  describe('extractBusyDataset — the message form nothing used to read', () => {
    it('reads the DATASET a zvol destroy quotes (extractBusyPath cannot: no leading slash)', () => {
      const base = `cannot destroy 'gtiscsi/vol1': dataset is busy`
      assert.equal(extractBusyDataset(base), 'gtiscsi/vol1')
      assert.equal(extractBusyPath(base), null)
    })

    it('never mistakes a PATH for a dataset', () => {
      assert.equal(extractBusyDataset(`cannot unmount '/gtiscsi/images': pool or dataset is busy`), null)
    })

    it('never mistakes a bare pool name for a dataset (no child component)', () => {
      assert.equal(extractBusyDataset(`cannot destroy 'gtiscsi': pool is busy`), null)
    })

    it('null when nothing is quoted at all', () => {
      assert.equal(extractBusyDataset('device is busy'), null)
    })
  })

  describe('diagnoseLunHolder', () => {
    it('finds the zvol LUN from the DATASET the ZFS error quotes', async () => {
      const holder = await diagnoseLunHolder(
        `cannot destroy 'gtiscsi/vol1': dataset is busy`,
        undefined,
        { root: configfsRoot },
      )
      assert.ok(holder)
      assert.equal(holder.targetIqn, GT_TARGET)
      assert.equal(holder.lunIndex, 0)
      assert.equal(holder.backstoreName, 'gtiscsi_vol1')
      // The STABLE by-name path, never the `zdN` kernel name (GT-48).
      assert.equal(holder.backingPath, '/dev/zvol/gtiscsi/vol1')
      assert.equal(holder.claimed, 'IBLOCK')
    })

    it('finds the fileio LUN from the DIRECTORY a busy export quotes', async () => {
      const holder = await diagnoseLunHolder(
        `cannot unmount '/gtiscsi/images': pool or dataset is busy`,
        undefined,
        { root: configfsRoot },
      )
      assert.ok(holder)
      assert.equal(holder.lunIndex, 1)
      assert.equal(holder.backstoreName, 'gtiscsi_lun2')
      assert.equal(holder.backingPath, '/gtiscsi/images/lun2.raw')
    })

    it('takes the CALLER\'s dataset when the message quotes nothing usable', async () => {
      const holder = await diagnoseLunHolder(
        'device is busy',
        undefined,
        { root: configfsRoot, dataset: 'gtiscsi/vol1' },
      )
      assert.equal(holder?.backstoreName, 'gtiscsi_vol1')
    })

    it('takes the caller\'s explicit PATH first', async () => {
      const holder = await diagnoseLunHolder('umount: /gtiscsi/images: target is busy.', '/gtiscsi/images', { root: configfsRoot })
      assert.equal(holder?.backstoreName, 'gtiscsi_lun2')
    })

    it('null for an object no LUN holds — falls through to the process branch', async () => {
      assert.equal(
        await diagnoseLunHolder(`cannot unmount '/tank/other': pool or dataset is busy`, undefined, { root: configfsRoot }),
        null,
      )
    })

    it('null on a node with no LIO tree at all (fail-open)', async () => {
      assert.equal(
        await diagnoseLunHolder(`cannot destroy 'gtiscsi/vol1': dataset is busy`, undefined, { root: join(dir, 'no-such-configfs') }),
        null,
      )
    })
  })

  describe('enrichBusyError', () => {
    it('names the LUN — and does NOT consult fuser (it would find nothing, GT-41)', async () => {
      const exec = execWithHolder('/gtiscsi/images')
      const base = `cannot unmount '/gtiscsi/images': pool or dataset is busy`
      const out = await enrichBusyError(exec, base, undefined, { root: configfsRoot, procRoot })
      assert.match(out, /held by iSCSI LUN 1 'gtiscsi_lun2' of target iqn\.2026-08\.dev\.anas\.gtiscsi:target1/)
      assert.ok(out.startsWith(base), out)
      assert.ok(!out.includes('held open by'), out)
      assert.equal(fuserCalls(exec), 0)
    })

    it('names the LUN for a busy zvol destroy, which quoted a DATASET and not a path', async () => {
      const exec = new MockExecutor()
      const base = `cannot destroy 'gtiscsi/vol1': dataset is busy`
      const out = await enrichBusyError(exec, base, undefined, { root: configfsRoot, procRoot })
      assert.match(out, /held by iSCSI LUN 0 'gtiscsi_vol1' of target/)
      assert.equal(fuserCalls(exec), 0)
    })

    it('unclaimed path → the EXISTING process diagnosis, verbatim', async () => {
      const exec = execWithHolder('/mnt/tank')
      const out = await enrichBusyError(exec, 'umount: /mnt/tank: target is busy.', '/mnt/tank', { root: configfsRoot, procRoot })
      assert.equal(out, 'umount: /mnt/tank: target is busy. — held open by: chia_harvester(1234)')
      assert.equal(fuserCalls(exec), 1)
    })

    it('unclaimed path with no process holders → the error verbatim', async () => {
      const exec = new MockExecutor()
      exec.addFixture({ command: FUSER, args: ['-m', '/mnt/tank'], result: { stdout: '', stderr: '', exitCode: 1 } })
      const base = 'umount: /mnt/tank: target is busy.'
      assert.equal(await enrichBusyError(exec, base, '/mnt/tank', { root: configfsRoot, procRoot }), base)
    })

    it('a NON-busy error is never diagnosed, LUN or no LUN', async () => {
      const exec = execWithHolder('/gtiscsi/images')
      const base = `cannot open 'gtiscsi/vol1': dataset does not exist`
      assert.equal(await enrichBusyError(exec, base, undefined, { root: configfsRoot, procRoot }), base)
      assert.equal(fuserCalls(exec), 0)
    })
  })
})
