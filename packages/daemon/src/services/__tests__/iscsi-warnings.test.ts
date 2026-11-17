/**
 * iSCSI → dashboard warning cards (story `iscsi.5`).
 *
 * Two halves: the pure mapping (`buildIscsiWarnings`) against every card shape
 * the health diff can produce, and the fail-open collector against the real
 * fixtures — including the two states that must add NOTHING (healthy, and LIO
 * not installed) and the one that must not throw (a read that blows up).
 */

import type { IscsiHealth, IscsiHoleRepair } from '@anas/shared'
import type { CommandExecutor, ExecResult, ExecStreamResult, PipelineResult } from '../../executor/types.js'
import type { IscsiPaths } from '../iscsi.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeConfigfsManifest } from '../../fixtures/configfs-manifest.js'
import { computeIscsiHealth } from '../iscsi-health.js'
import { repairAdvice } from '../iscsi-hole.js'
import { buildIscsiWarnings, collectIscsiWarnings } from '../iscsi-warnings.js'
import { buildIscsiTargets } from '../iscsi.js'
import { restoreMarkDetail } from '../restore-mark.js'
import { contextOf, holeIoFor } from './lio-model.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '../../fixtures/iscsi')

const IQN = 'iqn.2026-08.dev.anas.gtiscsi:target1'

/** A healthy diff — every collection empty, nothing degraded. */
function health(overrides: Partial<IscsiHealth> = {}): IscsiHealth {
  return {
    installed: true,
    configfsPresent: true,
    saveconfigPresent: true,
    missingLuns: [],
    targetsServingNothing: [],
    stubLuns: [],
    disabledTargets: [],
    portalsWithoutInterface: [],
    foreignChanges: [],
    degraded: false,
    interfacesUnknown: false,
    checkedAt: '2026-08-25T20:00:00.000Z',
    ...overrides,
  }
}

function executor(addresses: string[] | null = ['192.168.200.50']): CommandExecutor {
  return {
    async exec(command: string): Promise<ExecResult> {
      if (command === '/usr/bin/ip' && addresses !== null) {
        return {
          stdout: JSON.stringify([{ ifname: 'vmbr0', addr_info: addresses.map(local => ({ family: 'inet', local })) }]),
          stderr: '',
          exitCode: 0,
        }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    },
    async pipeline(): Promise<PipelineResult> {
      return { leftExitCode: 1, rightExitCode: 1, leftStderr: '', rightStderr: '', stdout: '' }
    },
    // Interface parity (backup2.7 added the streaming exec); unused here.
    async execToStream(): Promise<ExecStreamResult> {
      return { stderr: '', exitCode: 1, bytesWritten: 0 }
    },
  }
}

async function materialize(manifestName: string): Promise<{ root: string, blockRoot: string, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'anas-iscsi-warn-'))
  const root = join(dir, 'target')
  await materializeConfigfsManifest(readFileSync(join(fixturesDir, manifestName), 'utf-8'), root)
  const blockRoot = join(dir, 'block')
  await mkdir(join(blockRoot, 'zd16'), { recursive: true })
  await writeFile(join(blockRoot, 'zd16', 'size'), '4194304\n')
  return { root, blockRoot, dir }
}

// ---------------------------------------------------------------------------

describe('buildIscsiWarnings — one card shape per finding', () => {
  it('healthy adds NOTHING', () => {
    assert.deepEqual(buildIscsiWarnings(health()), [])
  })

  it('LIO not installed adds NOTHING, whatever else the shape says', () => {
    // Most PVE nodes serve no block storage; an iSCSI card there would be noise.
    assert.deepEqual(buildIscsiWarnings(health({
      installed: false,
      configfsPresent: false,
      saveconfigPresent: false,
      degraded: true,
    })), [])
  })

  it('a LUN that did not restore names the LUN, the target and the backing path', () => {
    const w = buildIscsiWarnings(health({
      missingLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 0,
        backstoreName: 'gtiscsi_vol1',
        plugin: 'block',
        backingPath: '/dev/zvol/gtiscsi/vol1',
        backingExists: false,
        // The verdict the real read gives this hole: a dead path, decided from
        // the pure facts alone (services/iscsi-hole.ts).
        repair: {
          state: 'backing-absent',
          detail: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
          advice: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
        },
      }],
    }))
    assert.equal(w.length, 1)
    assert.equal(w[0].category, 'iscsi')
    assert.equal(w[0].level, 'warning')
    assert.equal(w[0].ref, IQN)
    assert.match(w[0].message, /LUN 0 'gtiscsi_vol1' of target iqn\.2026-08\.dev\.anas\.gtiscsi:target1 did not restore/)
    assert.match(w[0].message, /its backing \/dev\/zvol\/gtiscsi\/vol1 was not available/)
    assert.match(w[0].message, /serving without it/)
    // Still missing ⇒ the card says what to do FIRST, not "press Repair".
    assert.match(w[0].message, /still missing/)
    assert.doesNotMatch(w[0].message, /use Repair/)
  })

  it('a hole whose backing is BACK points at the Repair door', () => {
    const w = buildIscsiWarnings(health({
      missingLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 0,
        backstoreName: 'gtiscsi_vol1',
        plugin: 'block',
        backingPath: '/dev/zvol/gtiscsi/vol1',
        backingExists: true,
        // The real read gathers I/O facts for a present backing, so this hole
        // is judged ready and carries Repair's sentence.
        repair: {
          state: 'ready',
          detail: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.',
          advice: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.',
        },
      }],
    }))
    assert.match(w[0].message, /available again — use Repair/)
  })

  it('a target restored with zero LUNs is CRITICAL and says it is accepting logins', () => {
    const w = buildIscsiWarnings(health({
      targetsServingNothing: [{ targetIqn: IQN, tpgTag: 1, persistedLunCount: 2, enabled: true }],
    }))
    assert.equal(w.length, 1)
    assert.equal(w[0].level, 'critical')
    assert.equal(w[0].category, 'iscsi')
    assert.equal(w[0].ref, IQN)
    assert.match(w[0].message, /restored with none of its 2 LUNs/)
    assert.match(w[0].message, /accepting logins with no disks behind it/)
  })

  it('a disabled target serving nothing says so instead', () => {
    const w = buildIscsiWarnings(health({
      targetsServingNothing: [{ targetIqn: IQN, tpgTag: 1, persistedLunCount: 1, enabled: false }],
    }))
    assert.match(w[0].message, /It is disabled/)
    assert.doesNotMatch(w[0].message, /accepting logins/)
  })

  it('a portal on an address no interface carries', () => {
    const w = buildIscsiWarnings(health({
      portalsWithoutInterface: [{ targetIqn: IQN, tpgTag: 1, address: '10.9.9.9', port: 3260 }],
    }))
    assert.equal(w.length, 1)
    assert.equal(w[0].level, 'warning')
    assert.equal(w[0].category, 'iscsi')
    assert.match(w[0].message, /Portal 10\.9\.9\.9:3260 of target/)
    assert.match(w[0].message, /no.*interface on this node carries/)
    assert.match(w[0].message, /never logs/)
  })

  it('degraded is its own node-level card and states the consequence', () => {
    const w = buildIscsiWarnings(health({
      degraded: true,
      missingLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 0,
        backstoreName: 'gtiscsi_vol1',
        plugin: 'block',
        backingPath: '/dev/zvol/gtiscsi/vol1',
        backingExists: false,
        repair: {
          state: 'backing-absent',
          detail: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
          advice: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
        },
      }],
    }))
    const degraded = w.filter(c => c.ref === undefined)
    assert.equal(degraded.length, 1)
    assert.equal(degraded[0].level, 'critical')
    assert.match(degraded[0].message, /incomplete restore \(1 LUN /)
    assert.match(degraded[0].message, /mutations are refused until this is repaired/)
    // It is node-level, so it carries no target ref to deep-link to.
    assert.equal(degraded[0].ref, undefined)
  })

  it('a placeholder LUN is the CRITICAL card, and names both signals plus what ANAS did', () => {
    const w = buildIscsiWarnings(health({
      stubLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        persistedSize: 536870912,
        actualSize: 0,
        containingMount: '/',
        expectedMount: '/mnt/anas-ahr/lpahr',
        zeroSized: true,
        wrongMount: true,
        ownership: 'anas',
        quarantined: true,
        fileRemoved: true,
      }],
      degraded: true,
    }))
    const card = w.find(c => /placeholder created by/.test(c.message))!
    assert.ok(card, w.map(c => c.message).join(' | '))
    assert.equal(card.level, 'critical')
    assert.equal(card.category, 'iscsi')
    assert.equal(card.ref, IQN)
    // The LUN, the target and the path are all named in full (ids never truncated).
    assert.match(card.message, /LUN 3 'lpahrlun'/)
    assert.match(card.message, /\/mnt\/anas-ahr\/lpahr\/lpahrlun\.raw/)
    // Both measurements, so the operator can check the claim.
    assert.match(card.message, /0 bytes where the saved configuration says 536870912/)
    assert.match(card.message, /on \/ instead of \/mnt\/anas-ahr\/lpahr/)
    // What it cost, and the way out.
    assert.match(card.message, /empty disk of the right size with the right serial/)
    assert.match(card.message, /ANAS has taken it offline/)
    assert.match(card.message, /mount the filesystem and use Repair/i)
  })

  // cr.62 (review L9): the reads no longer quarantine, so `quarantined: false`
  // on a card means "not taken offline yet" — the card says it is still served
  // and names Repair (the POST that takes it offline), never "could NOT".
  it('a placeholder still being served says so and names Repair as the way to take it offline (cr.62)', () => {
    const w = buildIscsiWarnings(health({
      stubLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        persistedSize: 536870912,
        actualSize: 0,
        containingMount: '/',
        expectedMount: '/mnt/anas-ahr/lpahr',
        zeroSized: true,
        wrongMount: false,
        ownership: 'anas',
        quarantined: false,
        fileRemoved: false,
      }],
      degraded: true,
    }))
    const card = w.find(c => /placeholder created by/.test(c.message))!
    assert.match(card.message, /It is still being served\. Use Repair on the iSCSI screen to take it offline now/)
    assert.ok(!/could NOT/.test(card.message), card.message)
    // Only the signal that actually fired is quoted.
    assert.ok(!/instead of/.test(card.message), card.message)
  })

  it('a FOREIGN placeholder is a hand job — ANAS will not unmap another tool\'s LUN (cr.62)', () => {
    const w = buildIscsiWarnings(health({
      stubLuns: [{
        targetIqn: 'iqn.2026-08.dev.example:other',
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        persistedSize: 536870912,
        actualSize: 0,
        containingMount: '/',
        expectedMount: '/mnt/anas-ahr/lpahr',
        zeroSized: true,
        wrongMount: false,
        ownership: 'foreign',
        quarantined: false,
        fileRemoved: false,
      }],
    }))
    const card = w.find(c => /placeholder created by/.test(c.message))!
    assert.match(card.message, /the target is not ANAS's, so ANAS will not unmap it\. Log initiators out and delete LUN 3 by hand/)
    assert.ok(!/Use Repair/.test(card.message), card.message)
  })

  it('a hole whose path still holds a placeholder says THAT, not "still missing"', () => {
    const w = buildIscsiWarnings(health({
      missingLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        plugin: 'fileio',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        backingExists: false,
        stubBacking: true,
        // A 0-byte file where the saved record has a size is a placeholder —
        // the verdict the real read decides from `zeroSized`.
        repair: {
          state: 'placeholder',
          detail: 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not the image, '
            + 'which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair on the '
            + 'iSCSI screen to put the LUN back with its own serial.',
          advice: 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not the image, '
            + 'which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair on the '
            + 'iSCSI screen to put the LUN back with its own serial.',
        },
      }],
      degraded: true,
    }))
    const card = w.find(c => /did not restore/.test(c.message))!
    assert.match(card.message, /holds a PLACEHOLDER the restore service created/)
    assert.match(card.message, /Mount the filesystem that should hold the image/)
    assert.ok(!/still missing/.test(card.message), card.message)
  })

  // C4: the quarantine pass that REMOVED the placeholder leaves a hole whose
  // path is empty because ANAS emptied it. "Bring the storage back (restore the
  // image)" is then an instruction to undo a deletion that destroyed nothing —
  // the image is still on the filesystem that never mounted.
  it('a hole ANAS made by REMOVING the placeholder says so, and points at mount + Repair', () => {
    const w = buildIscsiWarnings(health({
      missingLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        plugin: 'fileio',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        // The file is gone because the quarantine unlinked it: nothing is at
        // that path, and it is not a stub any more.
        backingExists: false,
        // The verdict is the plain absence; the card's own knowledge of what
        // it removed is what adds the REMOVED clause.
        repair: {
          state: 'backing-absent',
          detail: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
          advice: 'That path is still missing — bring the storage back (import the pool, restore the image) first.',
        },
      }],
      stubLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        persistedSize: 536870912,
        actualSize: 0,
        containingMount: '/',
        expectedMount: '/mnt/anas-ahr/lpahr',
        zeroSized: true,
        wrongMount: true,
        ownership: 'anas',
        quarantined: true,
        fileRemoved: true,
      }],
      degraded: true,
    }))
    const card = w.find(c => /did not restore/.test(c.message))!
    assert.match(card.message, /ANAS REMOVED the placeholder/)
    assert.match(card.message, /nothing of yours was deleted/)
    assert.match(card.message, /Mount the filesystem that should hold the image/)
    assert.match(card.message, /use Repair on the iSCSI screen/)
    assert.ok(!/still missing/.test(card.message), card.message)
    assert.ok(!/restore the image\) first/.test(card.message), card.message)
  })

  it('a quarantine that could NOT remove the file leaves the hole card alone', () => {
    // Only the LUN was unmapped (one signal), so the placeholder is still at
    // that path and `stubBacking` says so — the pre-existing card is right.
    const w = buildIscsiWarnings(health({
      missingLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        plugin: 'fileio',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        backingExists: false,
        stubBacking: true,
        repair: {
          state: 'placeholder',
          detail: 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not the image, '
            + 'which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair on the '
            + 'iSCSI screen to put the LUN back with its own serial.',
          advice: 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not the image, '
            + 'which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair on the '
            + 'iSCSI screen to put the LUN back with its own serial.',
        },
      }],
      stubLuns: [{
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: 3,
        backstoreName: 'lpahrlun',
        backingPath: '/mnt/anas-ahr/lpahr/lpahrlun.raw',
        persistedSize: 536870912,
        actualSize: 0,
        containingMount: '/mnt/anas-ahr/lpahr',
        expectedMount: '/mnt/anas-ahr/lpahr',
        zeroSized: true,
        wrongMount: false,
        ownership: 'anas',
        quarantined: true,
        fileRemoved: false,
      }],
      degraded: true,
    }))
    const card = w.find(c => /did not restore/.test(c.message))!
    assert.match(card.message, /holds a PLACEHOLDER the restore service created/)
    assert.ok(!/ANAS REMOVED the placeholder/.test(card.message), card.message)
  })

  it('a DISABLED ANAS target is a warning card that names the reason when there is one', () => {
    const plain = buildIscsiWarnings(health({
      disabledTargets: [{ targetIqn: IQN, tpgTag: 1, lunCount: 4 }],
    }))
    assert.equal(plain.length, 1)
    assert.equal(plain[0].level, 'warning')
    assert.equal(plain[0].category, 'iscsi')
    assert.equal(plain[0].ref, IQN)
    assert.match(plain[0].message, /is disabled/)
    assert.match(plain[0].message, /4 LUNs are unreachable/)
    assert.match(plain[0].message, /Enable it from the iSCSI screen/)

    const withReason = buildIscsiWarnings(health({
      disabledTargets: [{ targetIqn: IQN, tpgTag: 1, lunCount: 1, detail: 'A whole-image restore onto it failed and left it disabled: the image was partially written' }],
    }))
    assert.match(withReason[0].message, /partially written/)
  })

  // cr4.lun D-7/D-8: the restore-mark cards on a target that is enabled (served
  // now) and on a disabled one whose Enable would refuse.
  describe('restore marks that could not be read (cr4.lun D-7/D-8)', () => {
    const MARK = { v: 1 as const, repo: 'pbs-main', snapshot: 'vm/1/2026-11-14T10:00:00Z', archive: 'drive-scsi0.img', started: '2026-11-14T10:00:00.000Z', state: 'writing' as const }
    function markRow(o: { state: 'unreadable' | 'interrupted' | 'unverified', what: string, dataset: string, reason?: string, lunIndex?: number }): NonNullable<IscsiHealth['restoreMarks']>[number] {
      const read = o.state === 'unreadable'
        ? { state: 'unknown' as const, dataset: o.dataset, reason: o.reason ?? 'zfs get exited with code 1' }
        : { state: 'present' as const, dataset: o.dataset, raw: JSON.stringify(MARK), mark: MARK }
      const index = o.lunIndex ?? 0
      return {
        backingPath: `/dev/zvol/${o.dataset}`,
        dataset: o.dataset,
        backstoreName: `vmdisk${index}`,
        targetIqn: IQN,
        tpgTag: 1,
        lunIndex: index,
        state: o.state,
        source: 'mark' as const,
        mark: o.state === 'unreadable' ? null : MARK,
        detail: restoreMarkDetail({ state: o.state, source: 'mark', mark: o.state === 'unreadable' ? null : MARK, what: o.what, dataset: o.dataset, read, unreadableDoor: 'enabling the target' }),
      }
    }

    it('D-7: an unreadable mark on an ENABLED target is a critical card: served now, the command, then Disable', () => {
      const w = buildIscsiWarnings(health({
        restoreMarks: [markRow({ state: 'unreadable', what: `LUN 0 ('vmdisk0') of ${IQN}`, dataset: 'tank/vm1' })],
      }))
      const card = w.find(c => /restore state is unknown/.test(c.message))
      assert.ok(card, 'a card was added for the unreadable mark on an enabled target')
      assert.equal(card.level, 'critical')
      assert.equal(card.ref, IQN)
      assert.match(card.message, /ANAS could not read the restore mark on tank\/vm1 \(zfs get exited with code 1\)/)
      assert.match(card.message, /Target .* is enabled, so initiators are being served an image whose restore state is unknown\./)
      assert.match(card.message, /To see what ANAS sees, run 'zfs get -Hp -o value,source anas:restore -- tank\/vm1' as root\./)
      assert.match(card.message, /Disable the target on the iSCSI screen until the mark can be read\.$/)
    })

    it('D-8: a disabled target with one interrupted and one unreadable LUN reads as Enable answers: refused until the mark can be read, never a confirm', () => {
      const w = buildIscsiWarnings(health({
        disabledTargets: [{ targetIqn: IQN, tpgTag: 1, lunCount: 2 }],
        restoreMarks: [
          markRow({ state: 'interrupted', what: `LUN 0 ('vmdisk0') of ${IQN}`, dataset: 'tank/vm1', lunIndex: 0 }),
          markRow({ state: 'unreadable', what: `LUN 1 ('vmdisk1') of ${IQN}`, dataset: 'tank/vm2', lunIndex: 1 }),
        ],
      }))
      const card = w.find(c => /is disabled/.test(c.message))
      assert.ok(card)
      assert.match(card.message, /ANAS could not read the restore mark on tank\/vm2/)
      assert.match(card.message, /Enable is refused until the mark can be read\./)
      assert.doesNotMatch(card.message, /asks you to confirm|Restoring the image again is the other way out/)
    })

    it('D-8: every unreadable LUN is named', () => {
      const w = buildIscsiWarnings(health({
        disabledTargets: [{ targetIqn: IQN, tpgTag: 1, lunCount: 2 }],
        restoreMarks: [
          markRow({ state: 'unreadable', what: `LUN 0 ('vmdisk0') of ${IQN}`, dataset: 'tank/vm1', lunIndex: 0 }),
          markRow({ state: 'unreadable', what: `LUN 1 ('vmdisk1') of ${IQN}`, dataset: 'tank/vm2', lunIndex: 1 }),
        ],
      }))
      const card = w.find(c => /is disabled/.test(c.message))
      assert.match(card?.message ?? '', /LUN 0 \('vmdisk0'\)/)
      assert.match(card?.message ?? '', /LUN 1 \('vmdisk1'\)/)
    })
  })

  it('foreignChanges are NOT cards — they are informational, not failures', () => {
    // The dashboard shows failures and overdue things only (standing ruling).
    // "This portal is live but unsaved" belongs on the iSCSI screen.
    const w = buildIscsiWarnings(health({
      foreignChanges: [{ kind: 'portal-not-persisted', targetIqn: IQN, detail: 'whatever' }],
    }))
    assert.deepEqual(w, [])
  })

  it('every card carries the iscsi category and a non-empty message', () => {
    const w = buildIscsiWarnings(health({
      degraded: true,
      missingLuns: [{ targetIqn: IQN, tpgTag: 1, lunIndex: 0, backstoreName: 'a', plugin: 'block', backingPath: '/dev/zvol/p/a', backingExists: true, repair: { state: 'ready', detail: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.', advice: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.' } }],
      targetsServingNothing: [{ targetIqn: IQN, tpgTag: 1, persistedLunCount: 1, enabled: true }],
      portalsWithoutInterface: [{ targetIqn: IQN, tpgTag: 1, address: '10.9.9.9', port: 3260 }],
    }))
    assert.equal(w.length, 4)
    for (const card of w) {
      assert.equal(card.category, 'iscsi')
      assert.ok(card.message.length > 0)
      assert.ok(card.level === 'warning' || card.level === 'critical')
    }
  })
})

describe('own.4 (c) — the hole card\'s tail is the hole\'s verdict, framed per state', () => {
  // An ANAS-generated IQN: the real-read cases need a target ANAS owns.
  const ANAS_IQN = 'iqn.2026-08.nas.anas:vmstore'
  const BACKING = '/dev/zvol/gtiscsi/vol1'
  const HOLE = {
    targetIqn: IQN,
    tpgTag: 1,
    lunIndex: 0,
    backstoreName: 'gtiscsi_vol1',
    plugin: 'block',
    backingPath: BACKING,
    backingExists: true,
  }
  const HEAD = `LUN 0 'gtiscsi_vol1' of target ${IQN} did not restore — its backing ${BACKING} was not available; the target is serving without it.`
  const cardOf = (repair?: IscsiHoleRepair) => buildIscsiWarnings(health({
    // The card prints the verdict's own advice; a hand-built verdict gets the
    // sentence the owner frames, so these cases pin the card's tail end to end.
    missingLuns: [repair ? { ...HOLE, repair: { ...repair, advice: repairAdvice(repair.state, repair.detail) } } : HOLE],
    degraded: true,
  })).find(c => /did not restore/.test(c.message))!

  it('a clause-shaped verdict never invites Repair: "Repair cannot put it back: <detail>."', () => {
    const detail = 'the saved record\'s "name=v 1" cannot be handed to targetcli (a space, a quote or an \'=\' it would '
      + 'read as something else) — restore it by hand (bring the device back, then restart rtslib-fb-targetctl in a '
      + 'maintenance window)'
    for (const state of ['record-incomplete', 'backing-unreadable', 'backstore-live', 'device-served-elsewhere', 'restore-mark'] as const)
      assert.equal(cardOf({ state, detail }).message, `${HEAD} Repair cannot put it back: ${detail}.`, state)
  })

  it('a detail that is already a full sentence does not get a second stop', () => {
    const detail = 'The initiator ACL "bad name" is not an iSCSI name ANAS can address. Nothing was changed. Remove or '
      + 'recreate that ACL with targetcli, then retry.'
    assert.equal(cardOf({ state: 'record-incomplete', detail }).message, `${HEAD} Repair cannot put it back: ${detail}`)
  })

  it('hands-off: the target is not this repair\'s, and the reason is the verdict\'s own', () => {
    const detail = `Target '${IQN}' has 2 target portal groups (TPG 1, 2). ANAS creates one TPG per target and changes `
      + 'only that one, so it does not change a target that was given more by hand — use targetcli for this target. This '
      + 'refusal has no confirm bypass.'
    assert.equal(cardOf({ state: 'target-hands-off', detail }).message, `${HEAD} Repair does not write to this target: ${detail}`)
  })

  it('ready, placeholder and backing-absent keep the sentences they have always had', () => {
    const ready = 'That path is available again — use Repair on the iSCSI screen to put the LUN back.'
    assert.equal(cardOf({ state: 'ready', detail: ready }).message, `${HEAD} ${ready}`)
    const placeholder = 'That path holds a PLACEHOLDER the restore service created — a file of the right name that is not '
      + 'the image, which is why ANAS took the LUN offline. Mount the filesystem that should hold the image, then use Repair '
      + 'on the iSCSI screen to put the LUN back with its own serial.'
    assert.equal(cardOf({ state: 'placeholder', detail: placeholder }).message, `${HEAD} ${placeholder}`)
    const absent = 'That path is still missing — bring the storage back (import the pool, restore the image) first.'
    assert.equal(cardOf({ state: 'backing-absent', detail: absent }).message, `${HEAD} ${absent}`)
  })

  it('a removed placeholder keeps the REMOVED clause, and only on the backing-absent verdict', () => {
    const removed = {
      targetIqn: IQN,
      tpgTag: 1,
      lunIndex: 0,
      backstoreName: 'gtiscsi_vol1',
      backingPath: BACKING,
      persistedSize: 1,
      actualSize: 0,
      containingMount: '/',
      expectedMount: '/gtbackup',
      zeroSized: true,
      wrongMount: true,
      ownership: 'anas' as const,
      quarantined: true,
      fileRemoved: true,
    }
    const absent = { state: 'backing-absent' as const, detail: 'That path is still missing — bring the storage back (import the pool, restore the image) first.' }
    const removedCard = buildIscsiWarnings(health({ missingLuns: [{ ...HOLE, backingExists: false, repair: absent }], stubLuns: [removed], degraded: true }))
      .find(c => /did not restore/.test(c.message))!
    assert.match(removedCard.message, /ANAS REMOVED the placeholder/)
    assert.ok(!/still missing/.test(removedCard.message), removedCard.message)
    // Any other verdict says its own thing: the removed clause is about an absence.
    const readyCard = buildIscsiWarnings(health({ missingLuns: [{ ...HOLE, repair: { state: 'ready', detail: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.', advice: 'That path is available again — use Repair on the iSCSI screen to put the LUN back.' } }], stubLuns: [removed], degraded: true }))
      .find(c => /did not restore/.test(c.message))!
    assert.ok(!/ANAS REMOVED the placeholder/.test(readyCard.message), readyCard.message)
  })

  it('foreign: the card prints the verdict\'s hand-restore sentence, not one of its own', () => {
    const sentence = `LUN 0 of ${IQN} (backstore 'gtiscsi_vol1', ${BACKING}) is missing from a target ANAS does not `
      + 'manage. ANAS never writes to a target it does not own, so Repair leaves it alone.'
    assert.equal(cardOf({ state: 'foreign-target', detail: sentence }).message, `${HEAD} ${sentence}`)
  })

  it('a hole with no verdict gets no tail at all: nothing is claimed about Repair', () => {
    assert.equal(cardOf(undefined).message, HEAD)
  })

  it('through the real diff: a present backing is ready and the card points at Repair', async () => {
    const ctx = contextOf({ backstores: [], luns: [] }, {
      backstores: [{ name: 'v1', plugin: 'block', dev: '/dev/zvol/tank/v1', wwn: 'w-1' }],
      luns: [{ iqn: ANAS_IQN, tag: 1, index: 0, backstore: 'v1', plugin: 'block' }],
    }, { iqn: ANAS_IQN, tag: 1, backstores: [], luns: [] })
    const targets = await buildIscsiTargets(ctx)
    const h = computeIscsiHealth(ctx, targets, { holeIo: holeIoFor(ctx, targets) })
    assert.equal(h.missingLuns[0].repair?.state, 'ready')
    assert.match(buildIscsiWarnings(h).find(c => /did not restore/.test(c.message))!.message, / That path is available again — use Repair on the iSCSI screen to put the LUN back\.$/)
  })

  it('through the real diff: a fileio record with no size never says "use Repair"', async () => {
    const ctx = contextOf({ backstores: [], luns: [] }, {
      backstores: [{ name: 'v1', plugin: 'fileio', dev: '/tank/images/v1.raw', wwn: 'w-1' }],
      luns: [{ iqn: ANAS_IQN, tag: 1, index: 0, backstore: 'v1', plugin: 'fileio' }],
    }, { iqn: ANAS_IQN, tag: 1, backstores: [], luns: [] })
    ctx.inputs.zfsMountpoints = [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }]
    const targets = await buildIscsiTargets(ctx)
    const h = computeIscsiHealth(ctx, targets, { holeIo: holeIoFor(ctx, targets) })
    assert.equal(h.missingLuns[0].repair?.state, 'record-incomplete')
    assert.match(buildIscsiWarnings(h).find(c => /did not restore/.test(c.message))!.message, / Repair cannot put it back: the saved configuration records no size for fileio backstore 'v1' \(\/tank\/images\/v1\.raw\) — recreating it without one would serve a 0-byte disk with the right serial\.$/)
  })

  it('W2: a full-size image on an unexpected mount is ready, never a PLACEHOLDER card tail', async () => {
    const ctx = contextOf({ backstores: [], luns: [] }, {
      backstores: [{ name: 'v1', plugin: 'fileio', dev: '/tank/images/v1.raw', wwn: 'w-1' }],
      luns: [{ iqn: ANAS_IQN, tag: 1, index: 0, backstore: 'v1', plugin: 'fileio' }],
    }, { iqn: ANAS_IQN, tag: 1, backstores: [], luns: [] })
    ;(ctx.persisted as unknown as { storageObjects: { size: number | null }[] }).storageObjects[0].size = 1048576
    ctx.inputs.zfsMountpoints = [{ dataset: 'tank/images', mountpoint: '/tank/images', pool: 'tank' }]
    ctx.backing.set('/tank/images/v1.raw', { exists: true, size: 1048576 })
    ctx.mounts = new Map([['/', { target: '/', source: '/dev/sda1', fstype: 'ext4', options: 'rw' }]])
    const targets = await buildIscsiTargets(ctx)
    assert.equal(ctx.stubs.get('/tank/images/v1.raw')?.wrongMount, true, 'the fixture does carry the wrong-mount signal')
    const h = computeIscsiHealth(ctx, targets, { holeIo: holeIoFor(ctx, targets) })
    assert.equal(h.missingLuns[0].repair?.state, 'ready')
    assert.equal(h.missingLuns[0].stubBacking, undefined, 'stubBacking follows zeroSized, not the stub map')
    assert.ok(!/PLACEHOLDER/.test(buildIscsiWarnings(h).find(c => /did not restore/.test(c.message))!.message))
  })
})

// ---------------------------------------------------------------------------

describe('collectIscsiWarnings — fail-open, against the real captures', () => {
  it('a node with no LIO at all contributes nothing', async () => {
    const w = await collectIscsiWarnings(executor(), {
      configfsRoot: join(tmpdir(), 'anas-no-lio-configfs'),
      saveconfigPath: join(tmpdir(), 'anas-no-lio-saveconfig.json'),
    })
    assert.deepEqual(w, [])
  })

  it('a healthy node contributes nothing', async () => {
    const m = await materialize('configfs-live.manifest')
    try {
      const w = await collectIscsiWarnings(executor(['192.168.200.50']), {
        configfsRoot: m.root,
        blockRoot: m.blockRoot,
        saveconfigPath: join(fixturesDir, 'saveconfig-final.json'),
        pveStorageCfg: join(fixturesDir, 'no-such-storage.cfg'),
      })
      assert.deepEqual(w, [])
    }
    finally {
      await rm(m.dir, { recursive: true, force: true })
    }
  })

  it('the restore hole produces the LUN card and the degraded card', async () => {
    const m = await materialize('configfs-restore-hole.manifest')
    try {
      const w = await collectIscsiWarnings(executor(['192.168.200.50']), {
        configfsRoot: m.root,
        blockRoot: m.blockRoot,
        saveconfigPath: join(fixturesDir, 'saveconfig-final.json'),
        pveStorageCfg: join(fixturesDir, 'no-such-storage.cfg'),
      })
      assert.equal(w.length, 2)
      assert.ok(w.every(c => c.category === 'iscsi'))
      assert.ok(w.some(c => /gtiscsi_vol1/.test(c.message)))
      assert.ok(w.some(c => /mutations are refused/.test(c.message)))
    }
    finally {
      await rm(m.dir, { recursive: true, force: true })
    }
  })

  it('a read that THROWS propagates — the dashboard marks the section unavailable, never "no warnings"', async () => {
    // cr3 INVENTED-STATE-H1: this used to assert the collector answered []
    // (all clear) for a read that threw. The dashboard marks a section
    // unavailable only on a throw or a timeout, so the throw is the honest
    // answer now; routes/dashboard.ts's section reader catches it.
    const exploding: CommandExecutor = {
      async exec(): Promise<ExecResult> {
        throw new Error('boom')
      },
      async pipeline(): Promise<PipelineResult> {
        throw new Error('boom')
      },
      async execToStream(): Promise<ExecStreamResult> {
        throw new Error('boom')
      },
    }
    const hostile = {
      get configfsRoot(): string {
        throw new Error('boom')
      },
    } as IscsiPaths

    await assert.rejects(() => collectIscsiWarnings(exploding, hostile), /boom/)
  })
})
