import type { AhrPool, Job, SelfhealOutcome, SelfhealOutcomeKind, SelfhealReasonCode } from '@anas/shared'
import type { MdGeometry } from '../selfheal-map.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrRepairRequest, AhrRepairResult, SELFHEAL_CSUM_UNREADABLE, SELFHEAL_RUN_STOPPED, SELFHEAL_WRITE_UNCONFIRMED } from '@anas/shared'
import { MockExecutor } from '../../executor/mock.js'
import { mirrorReconcileEvidence } from '../ahr-mirror-reconcile.js'
import { parityRewriteArrayRefusal, parityRewriteEvidence } from '../ahr-parity-rewrite.js'
import { repairAhrFiles } from '../ahr-repair.js'
import { SelfhealRunError } from '../selfheal-repair.js'

/**
 * The repair JOB (story selfheal.6) — the engine is faked here on purpose.
 *
 * `selfheal-repair.test.ts` holds the engine to the captured rigs; what this
 * file holds is the job around it: the three buckets, the one notification, the
 * strictly sequential order, and the rule that a block which THROWS is that
 * block's verdict and never the job's.
 */

const MOUNTPOINT = '/mnt/anas-ahr/tank'

function pool(over?: Partial<AhrPool>): AhrPool {
  return {
    name: 'tank',
    ahrType: 'hybrid',
    mountpoint: MOUNTPOINT,
    mounted: true,
    disks: [],
    arrays: [],
    vg: { name: 'tank', sizeBytes: 0, freeBytes: 0 },
    lv: { name: 'tank-vol', sizeBytes: 0 },
    capacity: { totalBytes: 0, usedBytes: 0, freeBytes: 0, usableBytes: 0, rawBytes: 0, parityBytes: 0 },
    state: 'healthy',
    subvolLayout: true,
    advisories: [],
    ...over,
  } as unknown as AhrPool
}

function outcome(file: string, block: number, kind: SelfhealOutcomeKind, reason: string, code?: SelfhealReasonCode): SelfhealOutcome {
  return { outcome: kind, reason, ...(code ? { reasonCode: code } : {}), file, block, pool: 'tank', array: '/dev/md127', member: '/dev/sdb1', stripe: 1, steps: [] }
}

/** An executor that answers everything (the notification's perl call included). */
function executor(): MockExecutor {
  const exec = new MockExecutor()
  exec.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: '', exitCode: 0 } })
  return exec
}

/** The severity + body of the one notification the job emitted. */
function notification(exec: MockExecutor): { severity: string, title: string, body: string } | null {
  const call = exec.calls.find(c => c.command === '/usr/bin/perl')
  if (!call)
    return null
  return { severity: call.args[2], title: call.args[3], body: call.args[4] }
}

/** cr3.heal.paths — the job paragraph for agreeing-bad blocks (coordinator decision 1), one block. */
const AGREEING_BAD_1 = 'Every copy the array holds of 1 block(s) gives the same bytes, and those bytes fail their stored checksum: '
  + 'they were already wrong when md wrote them, so this result is final. Nothing was written to them. '
  + 'Test the node\'s memory with memtest86+ (a boot menu entry where the package is installed), then restore the files listed above from a backup if one exists.'

/** cr3.heal.paths — the mapping-abort paragraph, two blocks. */
const MAPPING_ABORT_2 = '2 block(s) pass their stored checksum where they sit on disk, so nothing was written to them. '
  + 'Run a scrub (Scrubs → Run now) to confirm them: a block that passes is no longer named. '
  + 'If the scrub names one again, ANAS located it wrongly: report it with this job\'s result.'

/** cr3.heal.paths — the per-file csum-unreadable line for an ordinary file. */
// Review R3 (safety): the restore is offered only after the scrub named the
// file again AND the repair stopped at the same place a second time.
const CSUM_UNREADABLE_FILE = 'the checksum btrfs keeps for these blocks could not be read, so nothing judged them and nothing was written. '
  + 'Run a scrub (Scrubs → Run now). If it names this file again, run Repair from parity on it from that finding. If the repair stops here a second time, the checksum record is damaged and ANAS has no repair for it: the scrub has named the file twice, so restore this file from a backup if one exists. If the scrub does not name the file, nothing remains to do.'

describe('AHR repair job — the four honest counts (review R9)', () => {
  it('sorts every verdict into repaired / unrepairable / aboveMd / mappingAbort, each as itself', async () => {
    const exec = executor()
    const verdicts: Record<string, SelfhealOutcomeKind> = {
      '/a.bin:1': 'repaired',
      '/a.bin:2': 'unrepairable',
      '/b.bin:7': 'above-md',
      '/b.bin:8': 'mapping-abort',
    }
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }, { path: '/b.bin', blocks: [7, 8] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, verdicts[`${req.file}:${req.block}`], `verdict for ${req.block}`) },
    )

    assert.equal(result.repaired, 1)
    // mapping-abort counts AS ITSELF now (review R9) — not a repair, but the
    // opposite of unrepairable: the block was fine at the mapped location.
    assert.equal(result.unrepairable, 1)
    assert.equal(result.aboveMd, 1)
    assert.equal(result.mappingAbort, 1)
    assert.equal(result.blocks, 4)
    assert.equal(result.repaired + result.unrepairable + result.aboveMd + result.mappingAbort, result.blocks)
    // …and keeps its own name and reason in the per-block entry.
    const b8 = result.files[1].blocks.find(b => b.block === 8)!
    assert.equal(b8.outcome, 'mapping-abort')
    assert.equal(b8.reason, 'verdict for 8')
  })

  it('a block the engine THROWS on before its write is run-stopped with the error text, never unrepairable — the job carries on', async () => {
    const exec = executor()
    const seen: number[] = []
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2, 3] }],
      () => {},
      {
        repair: async (_e, req) => {
          seen.push(req.block)
          if (req.block === 2)
            throw new Error('btrfs tree walk died')
          return outcome(req.file, req.block, 'repaired', 'ok')
        },
      },
    )

    assert.deepEqual(seen, [1, 2, 3], 'the blocks after the failure still got their attempt')
    assert.equal(result.repaired, 2)
    // cr3 AHR-HEAL-H1: a thrown block decided nothing — run-stopped, never
    // the bucket that advises a restore.
    assert.equal(result.unrepairable, 0)
    assert.equal(result.notExamined, 1)
    const bad = result.files[0].blocks.find(b => b.block === 2)!
    assert.equal(bad.outcome, 'not-examined')
    assert.equal(bad.reasonCode, SELFHEAL_RUN_STOPPED)
    // cr3.heal.paths (coordinator decision 4): no rerun is offered for a
    // thrown error — nothing names what would change.
    assert.equal(bad.reason, 'btrfs tree walk died. Nothing was written. This result is final for this run. Report it with this job\'s result.')
  })

  it('cr3 AHR-HEAL-H1: a block the engine threw on AFTER its write is REPAIRED with the confirmation skipped — never a restore', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [7] }],
      () => {},
      {
        repair: async () => {
          throw new SelfhealRunError('injected before postcheck', [], { cleanupErrors: [] }, {
            written: '/a.bin block 7 reconstructed from the XOR of the other 5 members of stripe 49 and verified against the stored csum 0x01020304',
          })
        },
      },
    )
    assert.equal(result.repaired, 1)
    assert.equal(result.unrepairable, 0)
    const block = result.files[0].blocks[0]
    assert.equal(block.outcome, 'repaired')
    assert.match(block.reason, /the run stopped before its confirmation \(injected before postcheck\)/)
    assert.doesNotMatch(notification(exec)!.body, /restore this file from backup/)
  })

  it('cr3 AHR-HEAL-H1: a block the engine threw on BEFORE its write is never told to restore', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [7] }],
      () => {},
      { repair: async () => { throw new SelfhealRunError('cannot pin /mnt: snapshot failed', [], { cleanupErrors: [] }) } },
    )
    const body = notification(exec)!.body
    assert.doesNotMatch(body, /restore this file from backup/)
    assert.ok(body.includes('  /a.bin: cannot pin /mnt: snapshot failed. Nothing was written. '
      + 'This result is final for this run. Report it with this job\'s result.'), body)
    assert.doesNotMatch(body, /run the repair again|Run Repair from parity again/i)
  })

  it('runs strictly one block at a time, in the order they were asked for', async () => {
    const exec = executor()
    const order: string[] = []
    let inFlight = 0
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [5, 6] }, { path: '/b.bin', blocks: [1] }],
      () => {},
      {
        repair: async (_e, req) => {
          inFlight += 1
          // Two engine runs at once would fight over the same md knobs.
          assert.equal(inFlight, 1, 'a second repair started while one was running')
          await new Promise(resolve => setTimeout(resolve, 1))
          order.push(`${req.file}:${req.block}`)
          inFlight -= 1
          return outcome(req.file, req.block, 'repaired', 'ok')
        },
      },
    )
    assert.deepEqual(order, ['/a.bin:5', '/a.bin:6', '/b.bin:1'])
  })

  it('hands the engine the pool and the pool mountpoint, never a path of its own', async () => {
    const exec = executor()
    const seen: { mountpoint: string, file: string, pool: string | null }[] = []
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: `${MOUNTPOINT}/a.bin`, blocks: [1] }],
      () => {},
      {
        repair: async (_e, req) => {
          seen.push({ mountpoint: req.mountpoint, file: req.file, pool: req.pool?.name ?? null })
          return outcome(req.file, req.block, 'repaired', 'ok')
        },
      },
    )
    assert.deepEqual(seen, [{ mountpoint: MOUNTPOINT, file: `${MOUNTPOINT}/a.bin`, pool: 'tank' }])
  })

  it('progress names the file, the block and the outcome', async () => {
    const exec = executor()
    const progress: string[] = []
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [9] }],
      m => progress.push(m),
      { repair: async (_e, req) => outcome(req.file, req.block, 'above-md', 'parity agrees') },
    )
    assert.ok(progress.some(p => p.includes('/a.bin') && p.includes('9') && p.includes('1/1')), progress.join(' | '))
    assert.ok(progress.includes('/a.bin block 9: above-md'), progress.join(' | '))
  })
})

describe('AHR repair job — the one notification', () => {
  it('everything repaired notifies at info and says so', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )
    const notify = notification(exec)!
    assert.equal(exec.calls.filter(c => c.command === '/usr/bin/perl').length, 1, 'exactly one notification')
    assert.equal(notify.severity, 'info')
    assert.match(notify.body, /2 repaired, 0 unrepairable, 0 above md/)
    assert.match(notify.body, /\/a\.bin: 2 repaired/)
    // Nothing to act on, so neither piece of advice appears.
    assert.doesNotMatch(notify.body, /restore this file from backup/)
    assert.doesNotMatch(notify.body, /cause above the disks/)
  })

  it('anything unrepairable or above md notifies at warning, in the epic\'s words', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }, { path: '/b.bin', blocks: [2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          req.file === '/a.bin' ? 'unrepairable' : 'above-md',
          'because',
        ),
      },
    )
    const notify = notification(exec)!
    assert.equal(notify.severity, 'warning')
    assert.match(notify.body, /\/a\.bin: restore this file from backup/)
    // cr3.sentences: the above-md file is on the restore list, with "if one
    // exists", and the cause is said for the job. cr3.heal.paths: final, and
    // the memory test is the one check named.
    assert.ok(notify.body.includes('  /b.bin: every copy the array holds of these blocks gives the same failing bytes, and this result is final: '
      + 'restore this file from a backup if one exists'), notify.body)
    assert.ok(notify.body.includes(AGREEING_BAD_1), notify.body)
    assert.doesNotMatch(notify.body, /controller or software|checksum record is what is wrong/)
    // An implication, never a certainty.
    assert.doesNotMatch(notify.body, /proves|definitely/)
  })

  it('cr3.sentences: an above-md block is on the restore list, "if one exists", and nothing beside it says not to restore', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/b.bin', blocks: [7] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'above-md', 'the per-block sentence') },
    )
    assert.equal(result.aboveMd, 1)
    assert.equal(result.unrepairable, 0)
    const notify = notification(exec)!
    assert.equal(notify.severity, 'warning')
    assert.equal(notify.title, 'AHR repair from parity left blocks unrepaired')
    assert.ok(notify.body.includes('ANAS could not repair these blocks from the array. What to do, per file '
      + '(a file restore is Backup → the backup task → Restore, or Restore from repository):\n'
      + '  /b.bin: every copy the array holds of these blocks gives the same failing bytes, and this result is final: '
      + 'restore this file from a backup if one exists'), notify.body)
    assert.ok(notify.body.includes(AGREEING_BAD_1), notify.body)
    assert.doesNotMatch(notify.body, /reason to restore|need no restore|Unrepairable blocks/, notify.body)
  })

  it('cr3.sentences: an above-md block of a LUN image gets the LUN restore sentence, "if one exists"', async () => {
    const LUN = `${MOUNTPOINT}/lun-images/win.lun`
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: LUN, blocks: [4] }],
      () => {},
      {
        repair: async (_e, req) => outcome(req.file, req.block, 'above-md', 'the per-block sentence'),
        lunHeld: async path => path === LUN
          ? { targetIqn: 'iqn.2026-01.org.anas:storage.tank', index: 3, name: 'win-lun-3', backingPath: LUN, connectedInitiators: [], detail: 'held' }
          : null,
      },
    )
    const notify = notification(exec)!
    assert.ok(notify.body.includes(`  ${LUN}: every copy the array holds of these blocks gives the same failing bytes, and this block backs `
      + 'iSCSI LUN iqn.2026-01.org.anas:storage.tank/3. Restore the LUN image from a PBS backup (Backup → Restore as new LUN) '
      + 'or the guest\'s own backup, if one exists'), notify.body)
    assert.doesNotMatch(notify.body, /restore this file from/)
  })

  it('a mapping-abort is never told to restore from backup — it means the block is FINE (selfheal.7 F2, R9)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'mapping-abort', 'not corrupt here') },
    )
    const notify = notification(exec)!
    // Still a warning and now counted AS ITSELF — nothing was repaired.
    assert.equal(notify.severity, 'warning')
    assert.match(notify.body, /0 repaired, 0 unrepairable, 0 above md, 2 not corrupt at the mapped location/)
    assert.match(notify.body, /\/a\.bin: 2 mapping-abort/)
    // But the advice is the opposite of "restore from backup", and it reads the
    // ONE number (review R9).
    assert.doesNotMatch(notify.body, /restore this file from backup/)
    // cr3.heal.paths: a scrub confirms, and a block it names again is reported.
    assert.ok(notify.body.includes(MAPPING_ABORT_2), notify.body)
    assert.equal(notify.title, 'AHR repair from parity completed; run a scrub to confirm')
  })

  it('a mix keeps each sentence with the blocks it belongs to (selfheal.7 F2, R9)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }, { path: '/b.bin', blocks: [2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          req.file === '/a.bin' ? 'unrepairable' : 'mapping-abort',
          'because',
        ),
      },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /0 repaired, 1 unrepairable, 0 above md, 1 not corrupt at the mapped location/)
    // "restore from backup" belongs to the TRUE unrepairable only.
    assert.match(notify.body, /restore this file from backup/)
    assert.ok(notify.body.includes('1 block(s) pass their stored checksum where they sit on disk'), notify.body)
  })

  // Design review 2026-09-14, D10 — "restore this file from backup" was wrong
  // for two shapes: an iSCSI LUN image (a different restore verb, refused while
  // a session is live) and a csum-unreadable block (nothing was confirmed yet).
  it('a LUN-backed unrepairable file is told to restore the LUN, not the file (D10)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: `${MOUNTPOINT}/lun-images/win.lun`, blocks: [4] }],
      () => {},
      {
        repair: async (_e, req) => outcome(req.file, req.block, 'unrepairable', 'both legs unreadable'),
        lunHeld: async path => path === `${MOUNTPOINT}/lun-images/win.lun`
          ? {
              targetIqn: 'iqn.2026-01.org.anas:storage.tank',
              index: 3,
              name: 'win-lun-3',
              backingPath: `${MOUNTPOINT}/lun-images/win.lun`,
              connectedInitiators: [],
              detail: 'held by iqn.1998-01.com.vmware:esx1',
            }
          : null,
      },
    )
    const notify = notification(exec)!
    assert.match(
      notify.body,
      new RegExp(`${MOUNTPOINT.replace(/\//g, '\\/')}/lun-images\\/win\\.lun: this block backs iSCSI LUN iqn\\.2026-01\\.org\\.anas:storage\\.tank/3`),
    )
    assert.match(notify.body, /Restore as new LUN/)
    assert.doesNotMatch(notify.body, /restore this file from backup/)
  })

  it('a csum-unreadable unrepairable block is told to re-scrub, not restore (D10)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          'unrepairable',
          'the metadata copy holding the checksum is damaged',
          SELFHEAL_CSUM_UNREADABLE,
        ),
        // No LUN claim is even consulted: csum-unreadable classification stands
        // on its own, and the default configfs lookup fail-opens to null.
      },
    )
    const notify = notification(exec)!
    assert.ok(notify.body.includes(`  /a.bin: ${CSUM_UNREADABLE_FILE}`), notify.body)
    assert.doesNotMatch(notify.body, /restore this file from backup/)
  })

  it('a LUN image whose unrepairable blocks are ALL csum-unreadable is NOT told to restore (N5)', async () => {
    // Both facts are true of this file, and they are not the same kind of fact.
    // "It is a LUN" says WHICH restore verb would apply; "the checksum could
    // not be read" says a restore is the wrong action — nothing has confirmed
    // the block is corrupt, and restoring a LUN image overwrites a guest's
    // disk on no evidence. LUN-ness used to be tested first and won.
    const exec = executor()
    const LUN = `${MOUNTPOINT}/lun-images/win.lun`
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: LUN, blocks: [4, 5] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          'unrepairable',
          'the metadata copy holding the checksum is damaged',
          SELFHEAL_CSUM_UNREADABLE,
        ),
        lunHeld: async path => path === LUN
          ? {
              targetIqn: 'iqn.2026-01.org.anas:storage.tank',
              index: 3,
              name: 'win-lun-3',
              backingPath: LUN,
              connectedInitiators: [],
              detail: 'held by iqn.1998-01.com.vmware:esx1',
            }
          : null,
      },
    )
    const notify = notification(exec)!
    // No plain file restore; the LUN restore is offered only in the branch
    // where the scrub shows the checksum record itself is damaged
    // (cr3.heal.paths), with the LUN identity composed in.
    assert.doesNotMatch(notify.body, /restore this file from backup/)
    assert.ok(notify.body.includes(`  ${LUN}: this block backs iSCSI LUN iqn.2026-01.org.anas:storage.tank/3, and the checksum btrfs keeps for these blocks `
      + 'could not be read, so nothing judged them and nothing was written. Run a scrub (Scrubs → Run now). If it names this file again, run Repair from parity on it from that finding. If the repair stops here a second time, the checksum record is damaged and ANAS has no repair for it: the scrub has named the file twice, so '
      + 'restore the LUN image from a PBS backup (Backup → Restore as new LUN) or the guest\'s own backup, if one exists. If the scrub does not name the file, nothing remains to do.'), notify.body)
    assert.doesNotMatch(notify.body, /errors that name no file/, 'review R3: unrelated I/O errors never send the reader to a restore')
  })

  it('a LUN image with a MIXED unrepairable file still gets the LUN restore advice (N5, the other side)', async () => {
    const exec = executor()
    const LUN = `${MOUNTPOINT}/lun-images/win.lun`
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: LUN, blocks: [4, 5] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          'unrepairable',
          req.block === 4 ? 'the metadata copy holding the checksum is damaged' : 'both legs unreadable',
          req.block === 4 ? SELFHEAL_CSUM_UNREADABLE : undefined,
        ),
        lunHeld: async () => ({
          targetIqn: 'iqn.2026-01.org.anas:storage.tank',
          index: 3,
          name: 'win-lun-3',
          backingPath: LUN,
          connectedInitiators: [],
          detail: 'held by iqn.1998-01.com.vmware:esx1',
        }),
      },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /Restore as new LUN/)
    assert.doesNotMatch(notify.body, /restore this file from backup/)
  })

  it('the engine\'s reason CODE rides into the per-block entry — the result is what a parser reads', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          req.block === 1 ? 'unrepairable' : 'repaired',
          req.block === 1 ? 'the metadata copy holding the checksum is damaged' : 'written back and read cold',
          req.block === 1 ? SELFHEAL_CSUM_UNREADABLE : undefined,
        ),
      },
    )
    // Carried through, and ONLY on the block that earned it — the other entry
    // has no code at all rather than a null.
    assert.equal(result.files[0].blocks[0].reasonCode, SELFHEAL_CSUM_UNREADABLE)
    assert.equal(result.files[0].blocks[1].reasonCode, undefined)
    // And it survives the shared schema on the way out (Principle 6).
    assert.equal(AhrRepairResult.parse(result).files[0].blocks[0].reasonCode, SELFHEAL_CSUM_UNREADABLE)
  })

  it('the advice keys on the CODE, not on the reason text — a reworded sentence still classifies', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      {
        // The sentence says nothing a grep could match; only the code does.
        repair: async (_e, req) => outcome(req.file, req.block, 'unrepairable', 'nothing arbitrated this block', SELFHEAL_CSUM_UNREADABLE),
      },
    )
    const notify = notification(exec)!
    assert.ok(notify.body.includes(CSUM_UNREADABLE_FILE), notify.body)
    assert.doesNotMatch(notify.body, /restore this file from backup/)
  })

  it('a MIXED unrepairable file (one csum-unreadable, one other) keeps the ordinary restore advice (D10)', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      {
        repair: async (_e, req) => outcome(
          req.file,
          req.block,
          'unrepairable',
          req.block === 1 ? 'the metadata copy holding the checksum is damaged' : 'both legs unreadable',
          req.block === 1 ? SELFHEAL_CSUM_UNREADABLE : undefined,
        ),
      },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /\/a\.bin: restore this file from backup/)
  })

  it('the notification names all five counts, and they add up (review R9, seventh pass F3)', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2, 3, 4, 5] }],
      () => {},
      {
        repair: async (_e, req) => outcome(req.file, req.block, ({
          1: 'repaired',
          2: 'unrepairable',
          3: 'above-md',
          4: 'mapping-abort',
          5: 'not-examined',
        } as Record<number, SelfhealOutcomeKind>)[req.block], 'because'),
      },
    )
    assert.equal(
      result.repaired + result.unrepairable + result.aboveMd + result.mappingAbort + result.notExamined,
      result.blocks,
    )
    const notify = notification(exec)!
    assert.match(notify.body, /1 repaired, 1 unrepairable, 1 above md, 1 not corrupt at the mapped location, 1 not examined, of 5 block\(s\)/)
  })

  it('caps the file list at 20 and says how many more', async () => {
    const exec = executor()
    const files = Array.from({ length: 23 }, (_, i) => ({ path: `/f${i}.bin`, blocks: [1] }))
    await repairAhrFiles(
      exec,
      pool(),
      files,
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )
    const notify = notification(exec)!
    assert.match(notify.body, /\n {2}and 3 more/)
    assert.doesNotMatch(notify.body, /…/, 'no ellipsis character (product voice)')
    assert.ok(notify.body.includes('/f19.bin'), 'the 20th file is listed')
    assert.ok(!notify.body.includes('/f20.bin'), 'the 21st is not')
  })

  it('a notification that cannot be delivered never fails the repair', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: '/usr/bin/perl', result: { stdout: '', stderr: 'no such target', exitCode: 1 } })
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )
    assert.equal(result.repaired, 1)
  })
})

describe('AHR repair schemas — round trips', () => {
  it('a request carries files with at least one block each', () => {
    const req = AhrRepairRequest.parse({ files: [{ path: '/mnt/anas-ahr/tank/a.bin', blocks: [1, 2] }] })
    assert.deepEqual(req.files[0].blocks, [1, 2])
    // A file with no blocks names nothing to repair.
    assert.throws(() => AhrRepairRequest.parse({ files: [{ path: '/mnt/anas-ahr/tank/a.bin', blocks: [] }] }))
    // …and a request with no files even less.
    assert.throws(() => AhrRepairRequest.parse({ files: [] }))
    // Relative paths (a finding inside @snapshots is filesystem-relative) and
    // traversal are refused at the schema, at both boundaries.
    assert.throws(() => AhrRepairRequest.parse({ files: [{ path: '@snapshots/nightly/a.bin', blocks: [1] }] }))
    assert.throws(() => AhrRepairRequest.parse({ files: [{ path: '/mnt/../etc/shadow', blocks: [1] }] }))
  })

  it('a result parses back with its buckets, and an unknown verdict does not', () => {
    const value = {
      pool: 'tank',
      files: [{ path: '/a.bin', blocks: [{ block: 1, outcome: 'mapping-abort', reason: 'not corrupt here' }] }],
      repaired: 0,
      unrepairable: 0,
      aboveMd: 0,
      mappingAbort: 1,
      notExamined: 0,
      parityResiduals: [],
      blocks: 1,
    }
    assert.deepEqual(AhrRepairResult.parse(value), value)
    assert.throws(() => AhrRepairResult.parse({ ...value, files: [{ path: '/a.bin', blocks: [{ block: 1, outcome: 'fixed', reason: '' }] }] }))
  })

  it('a pre-R9 payload without mappingAbort parses (additive field, default 0)', () => {
    const legacy = {
      pool: 'tank',
      files: [{ path: '/a.bin', blocks: [{ block: 1, outcome: 'unrepairable', reason: 'two bad blocks' }] }],
      repaired: 0,
      unrepairable: 1,
      aboveMd: 0,
      blocks: 1,
    }
    const parsed = AhrRepairResult.parse(legacy)
    assert.equal(parsed.mappingAbort, 0, 'the new count defaults to 0, never undefined')
    assert.equal(parsed.notExamined, 0, 'and so does the seventh pass\'s')
    assert.deepEqual(parsed.parityResiduals, [], 'and the residual rows are a list, never undefined')
  })
})

/**
 * Seventh pass, F3 — the `not-examined` bucket.
 *
 * Every map failure used to land in `mappingAbort`, whose notification sentence
 * says the bytes still pass their stored checksum and need no restore. That is
 * a reassurance about blocks nobody looked at.
 */
describe('AHR repair job — the not-examined bucket (F3)', () => {
  // cr3.heal.paths: the engine's reason is the fact, the advice the one
  // instruction after it — full strings. `owner-scan-truncated` has no entry
  // (only the scrub raises it) and falls back to `unresolvable`'s.
  const REPORT = 'This result is final for this run. Report it with this job\'s result.'
  const REASONS: [string, string][] = [
    ['inline-extent', 'Run a scrub (Scrubs → Run now) to refresh the findings: the extent the scrub named is no longer part of this file, and damage in the file now is named afresh.'],
    ['hole', 'Run a scrub (Scrubs → Run now) to refresh the findings: btrfs keeps no checksum for a hole.'],
    ['owner-scan-truncated', REPORT],
    ['band-unreadable', 'Run Repair from parity again once the AHR panel shows that band clean. If it stops here again while the band shows clean, report it with this job\'s result.'],
    ['unresolvable', REPORT],
    ['inode-changed', 'Run a scrub (Scrubs → Run now) and repair from what it names: the file the scrub named is no longer at this path.'],
  ]

  for (const [code, advice] of REASONS) {
    it(`counts a '${code}' block as not-examined and gives it its own advice`, async () => {
      const exec = executor()
      const result = await repairAhrFiles(
        exec,
        pool(),
        [{ path: '/a.bin', blocks: [1] }],
        () => {},
        { repair: async (_e, req) => outcome(req.file, req.block, 'not-examined', 'the chain stopped here.', code as SelfhealReasonCode) },
      )
      assert.equal(result.notExamined, 1)
      assert.equal(result.mappingAbort, 0, 'never folded into the bucket that says the bytes are fine')
      assert.equal(result.unrepairable, 0, 'and never into the bucket that advises a restore')
      const body = notification(exec)!.body
      assert.ok(body.includes('The repair reached no verdict on 1 block(s). Nothing was written to them. What to do, per file:\n'
        + `  /a.bin: the chain stopped here. ${advice}`), body)
      assert.ok(!/need no restore|nothing is known/.test(body), body)
    })
  }

  it('a not-examined block never carries restore advice, and keeps the run a warning', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'not-examined', 'the chain stopped here.', 'hole') },
    )
    assert.equal(result.repaired, 0)
    const notify = notification(exec)!
    assert.equal(notify.severity, 'warning')
    assert.ok(!/restore this file from backup/.test(notify.body), notify.body)
    assert.doesNotMatch(notify.body, /nothing is known|neither a clean bill/)
  })

  it('one file with two different reasons gets both sentences', async () => {
    const exec = executor()
    await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'not-examined', 'stopped.', req.block === 1 ? 'hole' : 'inline-extent') },
    )
    const body = notification(exec)!.body
    assert.match(body, /stopped\. Run a scrub \(Scrubs → Run now\) to refresh the findings: btrfs keeps no checksum for a hole\./)
    assert.match(body, /stopped\. Run a scrub \(Scrubs → Run now\) to refresh the findings: the extent the scrub named is no longer part of this file/)
  })
})

/**
 * Seventh pass, F2 — a repaired block that left a parity residual on its band.
 *
 * The block is right; the band's parity is not. It rides out in the SAME row
 * shape a scrub's `parityMismatches` uses, so Rewrite parity can act on it
 * without a fresh multi-hour two-phase scrub.
 */
describe('AHR repair job — parity residuals (F2)', () => {
  function withResidual(bandIndex: number | null, mismatchCnt: number) {
    return async (_e: unknown, req: { file: string, block: number }): Promise<SelfhealOutcome> => ({
      ...outcome(req.file, req.block, 'repaired', 'repaired, band still mismatching'),
      parityResidual: { array: '/dev/md127', band: bandIndex === null ? 'md127' : `tank-r${bandIndex}`, bandIndex, mismatchCnt },
    })
  }

  const BANDED = pool({ arrays: [{ band: 2, device: '/dev/md/tank-r2', level: 'raid6', kernelName: 'md127' }] as unknown as AhrPool['arrays'] })

  it('rolls the residual up into a parityMismatches-shaped row, with the band level', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      BANDED,
      [{ path: '/a.bin', blocks: [1, 2] }],
      () => {},
      { repair: withResidual(2, 8) as never },
    )
    assert.equal(result.repaired, 2)
    assert.deepEqual(result.parityResiduals, [
      { band: 'tank-r2', bandIndex: 2, array: '/dev/md127', mismatchCnt: 8, level: 'raid6' },
    ])
  })

  it('one row per band, carrying the highest count seen', async () => {
    const exec = executor()
    let n = 0
    const result = await repairAhrFiles(
      exec,
      BANDED,
      [{ path: '/a.bin', blocks: [1, 2, 3] }],
      () => {},
      { repair: (async (_e: unknown, req: { file: string, block: number }) => {
        n += 1
        return {
          ...outcome(req.file, req.block, 'repaired', 'ok'),
          parityResidual: { array: '/dev/md127', band: 'tank-r2', bandIndex: 2, mismatchCnt: n * 4 },
        }
      }) as never },
    )
    assert.equal(result.parityResiduals.length, 1)
    assert.equal(result.parityResiduals[0].mismatchCnt, 12)
  })

  it('a residual with no band number is NOT promoted to a row — it would name nothing', async () => {
    const exec = executor()
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      { repair: withResidual(null, 8) as never },
    )
    assert.deepEqual(result.parityResiduals, [])
    assert.equal(result.files[0].blocks[0].parityResidual?.mismatchCnt, 8, 'the per-block fact is still reported')
  })

  it('a residual keeps the notification a WARNING and names Rewrite parity, not a restore', async () => {
    const exec = executor()
    await repairAhrFiles(exec, BANDED, [{ path: '/a.bin', blocks: [1] }], () => {}, { repair: withResidual(2, 8) as never })
    const notify = notification(exec)!
    assert.equal(notify.severity, 'warning', 'every block repaired is not a clean run while a band still mismatches')
    assert.equal(notify.title, 'AHR repair from parity completed: rewrite parity on tank-r2')
    assert.ok(notify.body.includes('The blocks on the bands below were repaired and proven cold against their stored checksum, and md still counts '
      + 'mismatching stripes there, so their parity (or Q) disagrees with the data. '
      + 'Run Rewrite parity on each (Scrubs → the pool\'s parity mismatch → Rewrite parity):\n  tank-r2 (/dev/md127): mismatch_cnt 8'), notify.body)
    assert.ok(!/restore/i.test(notify.body), notify.body)
  })
})

/**
 * cr3.heal.paths — the three defects the coordinator verified in code (7a/7b/7c).
 * The notification must say what the product will actually accept: Rewrite
 * parity's evidence gate (`parityRewriteEvidence` → `repairEvidence`) is the
 * oracle, read here on the very result the job produced.
 */
describe('AHR repair job — residual advice the product accepts (cr3.heal.paths 7a/7b/7c)', () => {
  const BANDED = pool({ arrays: [{ band: 2, device: '/dev/md/tank-r2', level: 'raid6', kernelName: 'md127' }] as unknown as AhrPool['arrays'] })

  function asJob(result: unknown): Job {
    return { id: 'job-r', status: 'completed', operation: 'ahr.repair', progress: null, createdAt: '2026-11-15T00:00:00.000Z', createdBy: 'root@pam', startedAt: null, completedAt: null, result, error: null }
  }

  function residualOn(file: string, block: number, mismatchCnt: number): SelfhealOutcome {
    return {
      ...outcome(file, block, 'repaired', 'repaired, band still mismatching'),
      parityResidual: { array: '/dev/md127', band: 'tank-r2', bandIndex: 2, mismatchCnt },
    }
  }

  it('7a: every block repaired with a parity residual is titled by the residual, never "left blocks unrepaired"', async () => {
    const exec = executor()
    const result = await repairAhrFiles(exec, BANDED, [{ path: '/a.bin', blocks: [1, 2] }], () => {}, {
      repair: async (_e, req) => residualOn(req.file, req.block, 8),
    })
    const notify = notification(exec)!
    assert.equal(notify.severity, 'warning')
    assert.equal(notify.title, 'AHR repair from parity completed: rewrite parity on tank-r2')
    assert.equal(parityRewriteEvidence('tank', asJob(result), 2).ok, true, 'and Rewrite parity accepts what the title offers')
  })

  it('7b: a residual md counted 0 on is not a Rewrite-parity row — the notification says to scrub first', async () => {
    const exec = executor()
    const result = await repairAhrFiles(exec, BANDED, [{ path: '/a.bin', blocks: [1] }], () => {}, {
      repair: async (_e, req) => residualOn(req.file, req.block, 0),
    })
    // The gate refuses a zero, so no row offers the verb (the Scrubs parity
    // cell reads these rows); the per-block fact stays.
    assert.deepEqual(result.parityResiduals, [])
    assert.equal(result.files[0].blocks[0].parityResidual?.mismatchCnt, 0)
    assert.equal(parityRewriteEvidence('tank', asJob(result), 2).ok, false)
    const notify = notification(exec)!
    assert.equal(notify.title, 'AHR repair from parity completed: run a scrub, then rewrite parity on tank-r2')
    assert.ok(notify.body.includes('A direct read found the parity (or Q) of tank-r2 disagreeing with the repaired data, '
      + 'and md\'s check counted no mismatch there. Run a scrub (Scrubs → Run now) so md counts it, then run Rewrite parity from that scrub\'s parity mismatch.'), notify.body)
    assert.doesNotMatch(notify.body, /mismatch_cnt 0|Run Rewrite parity on/)
  })

  it('7c: a residual beside an unrepaired block names the refusal and what comes first, never "Run Rewrite parity on"', async () => {
    const exec = executor()
    const result = await repairAhrFiles(exec, BANDED, [{ path: '/a.bin', blocks: [1] }, { path: '/b.bin', blocks: [2] }], () => {}, {
      repair: async (_e, req) => req.file === '/a.bin' ? residualOn(req.file, req.block, 8) : outcome(req.file, req.block, 'unrepairable', 'both legs unreadable'),
    })
    const evidence = parityRewriteEvidence('tank', asJob(result), 2)
    assert.equal(evidence.ok, false)
    assert.equal(evidence.ok ? null : evidence.code, 'data-findings-present', 'the oracle: Rewrite parity refuses this run')
    const notify = notification(exec)!
    assert.equal(notify.title, 'AHR repair from parity left blocks unrepaired')
    assert.ok(notify.body.includes('md still counts mismatching stripes on the bands below, and Rewrite parity refuses while this run left '
      + 'blocks unrepaired, above md or not examined. Deal with the files above, run a scrub (Scrubs → Run now), '
      + 'then run Rewrite parity from that scrub\'s parity mismatch:\n  tank-r2 (/dev/md127): mismatch_cnt 8'), notify.body)
    assert.doesNotMatch(notify.body, /Run Rewrite parity on/)
  })

  it('7c: a mapping-abort beside a residual is not an unrepaired block — the gate accepts the run, and so does the advice', async () => {
    // `repairEvidence` counts unrepairable + above md + not examined, and NOT
    // mapping-abort: such a block passes its checksum where it sits, and the
    // rewrite's own first phase is a fresh checksum scrub of the whole pool.
    const exec = executor()
    const result = await repairAhrFiles(exec, BANDED, [{ path: '/a.bin', blocks: [1] }, { path: '/b.bin', blocks: [2] }], () => {}, {
      repair: async (_e, req) => req.file === '/a.bin' ? residualOn(req.file, req.block, 8) : outcome(req.file, req.block, 'mapping-abort', 'not corrupt here'),
    })
    assert.equal(parityRewriteEvidence('tank', asJob(result), 2).ok, true)
    const notify = notification(exec)!
    assert.equal(notify.title, 'AHR repair from parity completed: rewrite parity on tank-r2')
    assert.match(notify.body, /Run Rewrite parity on each \(Scrubs → the pool's parity mismatch → Rewrite parity\):\n {2}tank-r2 \(\/dev\/md127\): mismatch_cnt 8/)
  })
})

/**
 * Review D1 — the verb the notification names is the one the gate for THAT
 * band's level accepts: Rewrite parity refuses a mirror band
 * (`parityRewriteArrayRefusal`, `not-a-parity-band`), Reconcile mirror refuses
 * a parity band (`mirrorReconcileEvidence`, `not-a-mirror-band`).
 */
describe('AHR repair job — a residual is offered the verb its band level accepts (review D1)', () => {
  const MIXED = pool({ arrays: [
    { band: 2, device: '/dev/md/tank-r2', level: 'raid6', kernelName: 'md127' },
    { band: 3, device: '/dev/md/tank-r3', level: 'raid1', kernelName: 'md126' },
  ] as unknown as AhrPool['arrays'] })

  function asJob(result: unknown): Job {
    return { id: 'job-r', status: 'completed', operation: 'ahr.repair', progress: null, createdAt: '2026-11-15T00:00:00.000Z', createdBy: 'root@pam', startedAt: null, completedAt: null, result, error: null }
  }

  function residualOn(file: string, block: number, band: 2 | 3, mismatchCnt: number): SelfhealOutcome {
    return {
      ...outcome(file, block, 'repaired', 'repaired, band still mismatching'),
      parityResidual: { array: band === 2 ? '/dev/md127' : '/dev/md126', band: `tank-r${band}`, bandIndex: band, mismatchCnt },
    }
  }

  const MIRROR_PARAGRAPH = 'The blocks on the mirror bands below were repaired and proven cold against their stored checksum, and md still counts '
    + 'stripes there where the mirror legs differ. Run Reconcile mirror on each (Scrubs → the pool\'s parity mismatch → Reconcile mirror):\n'
    + '  tank-r3 (/dev/md126): mismatch_cnt 4'

  it('review D1: a RAID1 residual names Reconcile mirror and the legs, never Rewrite parity', async () => {
    const exec = executor()
    const result = await repairAhrFiles(exec, MIXED, [{ path: '/a.bin', blocks: [1] }], () => {}, {
      repair: async (_e, req) => residualOn(req.file, req.block, 3, 4),
    })
    const notify = notification(exec)!
    assert.equal(notify.title, 'AHR repair from parity completed: reconcile mirror on tank-r3')
    assert.ok(notify.body.includes(MIRROR_PARAGRAPH), notify.body)
    assert.doesNotMatch(notify.body, /Rewrite parity|parity \(or Q\) disagrees/)
    // The oracle: the mirror verb accepts this run, the parity verb refuses the band.
    assert.equal(mirrorReconcileEvidence('tank', asJob(result), 3).ok, true)
    assert.equal((await parityRewriteArrayRefusal({ raid1: true, device: '/dev/md126' } as MdGeometry))?.code, 'not-a-parity-band')
  })

  it('review D1: a run with a RAID6 and a RAID1 residual lists each under its own verb', async () => {
    const exec = executor()
    const result = await repairAhrFiles(exec, MIXED, [{ path: '/a.bin', blocks: [1, 2] }], () => {}, {
      repair: async (_e, req) => residualOn(req.file, req.block, req.block === 1 ? 2 : 3, req.block === 1 ? 8 : 4),
    })
    const notify = notification(exec)!
    assert.equal(notify.title, 'AHR repair from parity completed: rewrite parity on tank-r2; reconcile mirror on tank-r3')
    assert.ok(notify.body.includes('Run Rewrite parity on each (Scrubs → the pool\'s parity mismatch → Rewrite parity):\n  tank-r2 (/dev/md127): mismatch_cnt 8'), notify.body)
    assert.ok(notify.body.includes(MIRROR_PARAGRAPH), notify.body)
    assert.doesNotMatch(notify.body, /tank-r3 \(\/dev\/md126\): mismatch_cnt 4\n?.*Rewrite/)
    assert.equal(parityRewriteEvidence('tank', asJob(result), 2).ok, true)
    assert.equal(mirrorReconcileEvidence('tank', asJob(result), 2).ok, false)
    assert.equal(mirrorReconcileEvidence('tank', asJob(result), 3).ok, true)
  })
})

/**
 * Seventh pass, F11 — the finding's inode rides into the engine.
 */
describe('AHR repair job — the finding\'s inode (F11)', () => {
  it('passes it through when the caller has it, and omits it when it does not', async () => {
    const seen: (number | undefined)[] = []
    await repairAhrFiles(
      executor(),
      pool(),
      [{ path: '/a.bin', blocks: [1], inode: 257 }, { path: '/b.bin', blocks: [1] }],
      () => {},
      { repair: async (_e, req) => {
        seen.push(req.inode)
        return outcome(req.file, req.block, 'repaired', 'ok')
      } },
    )
    assert.deepEqual(seen, [257, undefined])
  })

  it('the request schema takes it, and it is optional', () => {
    assert.equal(AhrRepairRequest.parse({ files: [{ path: '/mnt/a.bin', blocks: [1], inode: 257 }] }).files[0].inode, 257)
    assert.equal(AhrRepairRequest.parse({ files: [{ path: '/mnt/a.bin', blocks: [1] }] }).files[0].inode, undefined)
  })
})

describe('AHR repair job — corrected metadata reads in its own window (selfheal.12)', () => {
  // GT-20's verbatim kernel capture: the only durable evidence a member is
  // returning bad metadata. The repair's cold reads touch the metadata that
  // holds the checksums it arbitrates against, so its OWN window is read.
  const GT20_CORRECTED
    = 'BTRFS info (device dm-0): read error corrected: ino 0 off 30834688 (dev /dev/mapper/gtsh-data sector 76608)'

  function journal(lines: string[]): string {
    return `${lines.map(l => JSON.stringify({ _TRANSPORT: 'kernel', MESSAGE: l })).join('\n')}\n`
  }

  function executorWithJournal(lines: string[]): MockExecutor {
    const exec = executor()
    exec.addFixture({ command: '/usr/bin/realpath', args: ['/dev/tank/tank-vol'], result: { stdout: '/dev/dm-0\n', stderr: '', exitCode: 0 } })
    exec.addFixture({ command: '/usr/bin/journalctl', result: { stdout: journal(lines), stderr: '', exitCode: 0 } })
    return exec
  }

  it('carries the count in the result and the sentence in the notification', async () => {
    const exec = executorWithJournal([
      GT20_CORRECTED,
      GT20_CORRECTED.replace('sector 76608', 'sector 76610'),
      'BTRFS info (device dm-9): read error corrected: ino 0 off 1 (dev /dev/mapper/other sector 2)',
    ])
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )

    assert.deepEqual(result.metadataCorrected, { count: 2, devices: ['/dev/mapper/gtsh-data'] })
    const notify = exec.calls.find(c => c.command === '/usr/bin/perl')!
    assert.ok(notify.args[4].includes(
      'btrfs corrected 2 metadata read(s) from the mirror copy during this run. '
      + 'Check SMART for each disk of pool \'tank\' in Disks.',
    ), notify.args[4])
  })

  it('an unreadable journal costs the count, never the repair — and no sentence appears', async () => {
    const exec = executor() // no journalctl, no realpath: both reads fail open
    const result = await repairAhrFiles(
      exec,
      pool(),
      [{ path: '/a.bin', blocks: [1] }],
      () => {},
      { repair: async (_e, req) => outcome(req.file, req.block, 'repaired', 'ok') },
    )
    assert.equal(result.metadataCorrected, undefined)
    const body = exec.calls.find(c => c.command === '/usr/bin/perl')!.args[4]
    assert.ok(!body.includes('metadata read(s)'), body)
  })

  it('metadataCorrected round-trips the shared schema — and stays optional', () => {
    const parsed = AhrRepairResult.parse({
      pool: 'tank',
      files: [{ path: '/a.bin', blocks: [{ block: 1, outcome: 'repaired', reason: 'ok' }] }],
      repaired: 1,
      unrepairable: 0,
      aboveMd: 0,
      blocks: 1,
      metadataCorrected: { count: 1, devices: ['/dev/mapper/gtsh-data'] },
    })
    assert.deepEqual(parsed.metadataCorrected, { count: 1, devices: ['/dev/mapper/gtsh-data'] })
    // A pre-selfheal.12 payload parses unchanged.
    const legacy = AhrRepairResult.parse({
      pool: 'tank',
      files: [],
      repaired: 0,
      unrepairable: 0,
      aboveMd: 0,
      blocks: 0,
    })
    assert.equal(legacy.metadataCorrected, undefined)
  })
})

describe('AHR repair job — the sentences a repeat and an unconfirmed write get (cr3 second review 5(b)(c))', () => {
  it('cr3.heal.paths: run-stopped adds no advice of its own — the reason from its site says what to do (decision 5)', async () => {
    const exec = executor()
    const reason = '/dev/md127 is busy (sync_action=check). Nothing was examined or written. '
      + 'Run Repair from parity again when the AHR panel shows /dev/md127 clean, with no check, build or rebuild in progress.'
    await repairAhrFiles(exec, pool(), [{ path: '/a.bin', blocks: [7] }], () => {}, {
      repair: async () => outcome('/a.bin', 7, 'not-examined', reason, SELFHEAL_RUN_STOPPED),
    })
    const body = notification(exec)!.body
    assert.ok(body.includes(`  /a.bin: ${reason}`), body)
    assert.equal(body.match(/Run Repair from parity again/g)?.length, 1, body)
    assert.doesNotMatch(body, /Wait until|it will not pass by waiting|needs looking at directly/)
  })

  it('write-unconfirmed gives its advice ONCE', async () => {
    const exec = executor()
    await repairAhrFiles(exec, pool(), [{ path: '/a.bin', blocks: [7] }], () => {}, {
      repair: async () => outcome('/a.bin', 7, 'not-examined', 'the write of /a.bin block 7 through /dev/md127 at md byte 4096 was issued and then reported a failure (dd: fsync failed). The arbitrated bytes may have landed or may not.', SELFHEAL_WRITE_UNCONFIRMED),
    })
    const body = notification(exec)!.body
    assert.ok(body.includes('The repair reached no verdict on 1 block(s). A block whose write could not be confirmed may have been written; '
      + 'nothing was written to the others. What to do, per file:\n'
      + '  /a.bin: the write of /a.bin block 7 through /dev/md127 at md byte 4096 was issued and then reported a failure (dd: fsync failed). '
      + 'The arbitrated bytes may have landed or may not. Run a scrub (Scrubs → Run now). If it no longer names this block, the write landed. '
      + 'If it names it again, run Repair from parity again once the AHR panel shows the band clean.'
      // Review R4: the rerun has a stop.
      + ' If the write fails again while the band shows clean, check that member\'s SMART data in Disks.'), body)
    assert.equal(body.match(/Run a scrub/g)?.length, 1, body)
  })
})
