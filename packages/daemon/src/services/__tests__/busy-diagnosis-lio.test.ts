import type { BusyDiagnosisOptions } from '../busy-diagnosis.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import {

  diagnoseIscsiHolder,
  enrichBusyError,
  extractBusyDataset,
  extractBusyPath,
} from '../busy-diagnosis.js'
import { iscsiClaims } from '../iscsi-mutate.js'

/**
 * The LIO branch of the busy diagnosis — story `iscsi.6`, own.4 b.
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
 * The branch is a VIEW over the claim list (own.4 b): it walks no configfs of
 * its own, so the busy clause and every refusal sentence are the same claim
 * read once. Only a claim whose backstore is LIVE can explain a busy the kernel
 * feels — a LUN saved and missing whose backstore is gone is filtered out — and
 * the saved half of LIO's configuration is read too (`saveconfigPath`).
 *
 * The contract this file pins:
 *   1. claimed      → the holder line names the LUN, and `fuser` is NOT run;
 *   2. unclaimed    → the 3.29 process diagnosis, byte for byte as before;
 *   3. saved+missing→ no iSCSI clause when its backstore is gone, the LUN's own
 *                     sentence when the backstore is still live (one claim, not
 *                     the unmapped-backstore one);
 *   4. anything else (no LIO, no match, unreadable tree, not busy) → verbatim
 *                     fall-through to `fuser`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ISCSI_FIXTURES = join(__dirname, '../../fixtures/iscsi')
const FUSER = '/usr/bin/fuser'
const GT_TARGET = 'iqn.2026-08.dev.anas.gtiscsi:target1'
const GT_INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'

/** The real `iscsi.1` capture: LUN 0 `gtiscsi_vol1`, LUN 1 `gtiscsi_lun2`. */
const LIVE_MANIFEST = readFileSync(join(ISCSI_FIXTURES, 'configfs-live.manifest'), 'utf-8')

/** LIO installed, nothing configured — the tree the saved-only cases stand on. */
const EMPTY_MANIFEST = 'D core\nD iscsi\n'

/** The `gtiscsi_vol1` iblock backstore LIVE, with NO target mapping it. */
const BACKSTORE_ONLY_MANIFEST = [
  'D core',
  'D core/iblock_0',
  'D core/iblock_0/gtiscsi_vol1',
  'D core/iblock_0/gtiscsi_vol1/wwn',
  'F core/iblock_0/gtiscsi_vol1/udev_path = /dev/zvol/gtiscsi/vol1',
  'F core/iblock_0/gtiscsi_vol1/enable = 1',
  'D iscsi',
].join('\n')

/** The sentence a saved LUN missing live carries on its claim `detail`. */
const MISSING_SENTENCE = '; this LUN is in the saved iSCSI configuration and missing from the live one, and it holds this object until the LUN is put back'

/** The LUN of BACKSTORE_ONLY_MANIFEST, as LIO wrote saveconfig.json (GT field names). */
function savedLunJson(): string {
  return JSON.stringify({
    fabric_modules: [],
    storage_objects: [
      { name: 'gtiscsi_vol1', plugin: 'block', dev: '/dev/zvol/gtiscsi/vol1', wwn: '9bc6e907-6015-4267-be4f-5a0617cb3d71' },
    ],
    targets: [
      {
        fabric: 'iscsi',
        wwn: GT_TARGET,
        tpgs: [{ tag: 1, enable: true, luns: [{ index: 0, storage_object: '/backstores/block/gtiscsi_vol1' }] }],
      },
    ],
  }, null, 2)
}

describe('busy-diagnosis — the LIO branch (story iscsi.6, GT-40/GT-41)', () => {
  let dir: string
  let configfsRoot: string
  let procRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-busy-lio-'))
    configfsRoot = join(dir, 'target')
    await materializeConfigfsManifest(LIVE_MANIFEST, configfsRoot)
    procRoot = join(dir, 'proc')
    await mkdir(join(procRoot, '1234'), { recursive: true })
    await writeFile(join(procRoot, '1234', 'comm'), 'chia_harvester\n')
  })

  afterEach(async () => {
    // The unreadable-tree test locks configfs' `core` dir; unlock it so the
    // rm below never trips over it.
    await chmod(join(configfsRoot, 'core'), 0o755).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })

  /** Hermetic iSCSI paths: the materialised tree, NO saveconfig, no storage.cfg. */
  function paths(over: BusyDiagnosisOptions = {}): BusyDiagnosisOptions {
    return {
      configfsRoot,
      saveconfigPath: join(dir, 'absent-saveconfig.json'),
      pveStorageCfg: join(dir, 'absent-storage.cfg'),
      blockRoot: join(dir, 'absent-block'),
      ...over,
    }
  }

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

  describe('diagnoseIscsiHolder — the view over the claims', () => {
    it('finds the zvol LUN from the DATASET the ZFS error quotes', async () => {
      const held = await diagnoseIscsiHolder(
        new MockExecutor(),
        `cannot destroy 'gtiscsi/vol1': dataset is busy`,
        undefined,
        paths(),
      )
      assert.ok(held)
      assert.equal(held.targetIqn, GT_TARGET)
      assert.equal(held.index, 0)
      assert.equal(held.name, 'gtiscsi_vol1')
      // The STABLE by-name path, never the `zdN` kernel name (GT-48).
      assert.equal(held.backingPath, '/dev/zvol/gtiscsi/vol1')
    })

    it('finds the fileio LUN from the DIRECTORY a busy export quotes', async () => {
      const held = await diagnoseIscsiHolder(
        new MockExecutor(),
        `cannot unmount '/gtiscsi/images': pool or dataset is busy`,
        undefined,
        paths(),
      )
      assert.ok(held)
      assert.equal(held.index, 1)
      assert.equal(held.name, 'gtiscsi_lun2')
      assert.equal(held.backingPath, '/gtiscsi/images/lun2.raw')
    })

    it('takes the CALLER\'s dataset when the message quotes nothing usable', async () => {
      const held = await diagnoseIscsiHolder(
        new MockExecutor(),
        'device is busy',
        undefined,
        paths({ dataset: 'gtiscsi/vol1' }),
      )
      assert.equal(held?.name, 'gtiscsi_vol1')
    })

    it('takes the caller\'s explicit PATH first', async () => {
      const held = await diagnoseIscsiHolder(
        new MockExecutor(),
        'umount: /gtiscsi/images: target is busy.',
        '/gtiscsi/images',
        paths(),
      )
      assert.equal(held?.name, 'gtiscsi_lun2')
    })

    it('null for an object no LUN holds — falls through to the process branch', async () => {
      assert.equal(
        await diagnoseIscsiHolder(new MockExecutor(), `cannot unmount '/tank/other': pool or dataset is busy`, undefined, paths()),
        null,
      )
    })

    it('null on a node with no LIO tree at all (fail-open)', async () => {
      assert.equal(
        await diagnoseIscsiHolder(new MockExecutor(), `cannot destroy 'gtiscsi/vol1': dataset is busy`, undefined, paths({ configfsRoot: join(dir, 'no-such-configfs') })),
        null,
      )
    })
  })

  describe('enrichBusyError', () => {
    it('names the LUN — and does NOT consult fuser (it would find nothing, GT-41)', async () => {
      const exec = execWithHolder('/gtiscsi/images')
      const base = `cannot unmount '/gtiscsi/images': pool or dataset is busy`
      const out = await enrichBusyError(exec, base, undefined, { ...paths(), procRoot })
      assert.match(out, /held by iSCSI LUN 1 'gtiscsi_lun2' of target iqn\.2026-08\.dev\.anas\.gtiscsi:target1/)
      assert.ok(out.startsWith(base), out)
      assert.ok(!out.includes('held open by'), out)
      assert.equal(fuserCalls(exec), 0)
    })

    it('names the LUN for a busy zvol destroy, which quoted a DATASET and not a path', async () => {
      const exec = new MockExecutor()
      const base = `cannot destroy 'gtiscsi/vol1': dataset is busy`
      const out = await enrichBusyError(exec, base, undefined, { ...paths(), procRoot })
      assert.match(out, /held by iSCSI LUN 0 'gtiscsi_vol1' of target/)
      assert.equal(fuserCalls(exec), 0)
    })

    it('unclaimed path → the EXISTING process diagnosis, verbatim', async () => {
      const exec = execWithHolder('/mnt/tank')
      const out = await enrichBusyError(exec, 'umount: /mnt/tank: target is busy.', '/mnt/tank', { ...paths(), procRoot })
      assert.equal(out, 'umount: /mnt/tank: target is busy. — held open by: chia_harvester(1234)')
      assert.equal(fuserCalls(exec), 1)
    })

    it('unclaimed path with no process holders → the error verbatim', async () => {
      const exec = new MockExecutor()
      exec.addFixture({ command: FUSER, args: ['-m', '/mnt/tank'], result: { stdout: '', stderr: '', exitCode: 1 } })
      const base = 'umount: /mnt/tank: target is busy.'
      assert.equal(await enrichBusyError(exec, base, '/mnt/tank', { ...paths(), procRoot }), base)
    })

    it('a NON-busy error is never diagnosed, LUN or no LUN', async () => {
      const exec = execWithHolder('/gtiscsi/images')
      const base = `cannot open 'gtiscsi/vol1': dataset does not exist`
      assert.equal(await enrichBusyError(exec, base, undefined, { ...paths(), procRoot }), base)
      assert.equal(fuserCalls(exec), 0)
    })
  })

  describe('own.4 b — the saved configuration, live sessions, dataset subjects, unreadable trees', () => {
    it('a saved LUN missing live whose backstore is GONE: no iSCSI clause, fuser answers', async () => {
      // The claim list still carries the LUN (it holds the object until it is
      // put back) — but with no live backstore it is not a hold the kernel can
      // feel, so the busy diagnosis must stay out of the way of fuser.
      const emptyRoot = join(dir, 'empty-target')
      await materializeConfigfsManifest(EMPTY_MANIFEST, emptyRoot)
      const saveconfigPath = join(dir, 'saveconfig.json')
      await writeFile(saveconfigPath, savedLunJson())
      const opts = paths({ configfsRoot: emptyRoot, saveconfigPath })

      const { claims } = await iscsiClaims(new MockExecutor(), opts)
      assert.equal(claims.length, 1)
      assert.equal(claims[0].lunMissing, true)
      assert.equal(claims[0].backstoreMissing, true)

      const base = `cannot destroy 'gtiscsi/vol1': dataset is busy`
      assert.equal(await diagnoseIscsiHolder(new MockExecutor(), base, '/dev/zvol/gtiscsi/vol1', opts), null)

      const exec = execWithHolder('/dev/zvol/gtiscsi/vol1')
      const out = await enrichBusyError(exec, base, '/dev/zvol/gtiscsi/vol1', { ...opts, procRoot })
      assert.equal(out, `${base} — held open by: chia_harvester(1234)`)
      assert.equal(fuserCalls(exec), 1)
    })

    it('the same saved LUN with its backstore still live: the LUN claim describes it, not the unmapped backstore', async () => {
      const bsRoot = join(dir, 'backstore-target')
      await materializeConfigfsManifest(BACKSTORE_ONLY_MANIFEST, bsRoot)
      const saveconfigPath = join(dir, 'saveconfig.json')
      await writeFile(saveconfigPath, savedLunJson())
      const opts = paths({ configfsRoot: bsRoot, saveconfigPath })

      const base = `cannot destroy 'gtiscsi/vol1': dataset is busy`
      const held = await diagnoseIscsiHolder(new MockExecutor(), base, undefined, opts)
      assert.equal(held?.lunMissing, true)
      assert.equal(held?.name, 'gtiscsi_vol1')

      // ONE claim says it (the unmapped duplicate is deduped), and it speaks
      // with the LUN sentence plus the missing-LUN tail.
      const exec = new MockExecutor()
      const out = await enrichBusyError(exec, base, undefined, { ...opts, procRoot })
      assert.equal(out, `${base} — held by iSCSI LUN 0 'gtiscsi_vol1' of target ${GT_TARGET} (/dev/zvol/gtiscsi/vol1)${MISSING_SENTENCE}`)
      assert.ok(!out.includes('not mapped as a LUN'), out)
      assert.equal(fuserCalls(exec), 0)
    })

    it('a LUN with a live session: the claim sentence carries the session count', async () => {
      // The captured ACL says "No active iSCSI Session"; the real logged-in
      // capture from the iscsi.3 GT replaces it (same file the configfs tests
      // rewrite).
      await writeFile(
        join(configfsRoot, 'iscsi', GT_TARGET, 'tpgt_1', 'acls', GT_INITIATOR, 'info'),
        readFileSync(join(ISCSI_FIXTURES, 'configfs-acl-info-loggedin.txt'), 'utf-8'),
      )
      const held = await diagnoseIscsiHolder(
        new MockExecutor(),
        `cannot destroy 'gtiscsi/vol1': dataset is busy`,
        undefined,
        paths(),
      )
      assert.ok(held)
      assert.deepEqual(held.connectedInitiators, [GT_INITIATOR])
      assert.ok(held.detail.endsWith(' with 1 live session'), held.detail)
    })

    it('an image LUN under a dataset: destroying the DATASET names the LUN (N3)', async () => {
      // The capture's LUN 1 image moved from /gtiscsi/images to /tank/a (the
      // dataset under destroy), so only the dataset→image rule can name it.
      const tankRoot = join(dir, 'tank-target')
      await materializeConfigfsManifest(
        LIVE_MANIFEST.replaceAll('/gtiscsi/images/lun2.raw', '/tank/a/lun.raw'),
        tankRoot,
      )
      const held = await diagnoseIscsiHolder(
        new MockExecutor(),
        `cannot destroy 'tank/a': dataset is busy`,
        undefined,
        paths({
          configfsRoot: tankRoot,
          // The image file lives ON dataset tank/a — the read's mountpoint seam
          // says so, and its backing seam says the file is really there.
          zfsMountpoints: async () => [{ mountpoint: '/tank/a', dataset: 'tank/a', pool: 'tank' }],
          backingExists: async () => true,
        }),
      )
      assert.ok(held)
      assert.equal(held.name, 'gtiscsi_lun2')
      assert.equal(held.index, 1)
      assert.ok(held.detail.startsWith(`held by iSCSI LUN 1 'gtiscsi_lun2' of target ${GT_TARGET}`), held.detail)
    })

    it('a configfs tree that cannot be listed in full: no clause, fuser runs (N4)', async () => {
      await chmod(join(configfsRoot, 'core'), 0o000)
      try {
        // The claims read THROWS on a tree it did not fully see — fail-open
        // means no iSCSI clause, not a refusal to answer at all.
        const base = `cannot unmount '/gtiscsi/images': pool or dataset is busy`
        assert.equal(await diagnoseIscsiHolder(new MockExecutor(), base, undefined, paths()), null)
        const exec = execWithHolder('/gtiscsi/images')
        const out = await enrichBusyError(exec, base, undefined, { ...paths(), procRoot })
        assert.equal(out, `${base} — held open by: chia_harvester(1234)`)
        assert.equal(fuserCalls(exec), 1)
      }
      finally {
        await chmod(join(configfsRoot, 'core'), 0o755)
      }
    })
  })
})
