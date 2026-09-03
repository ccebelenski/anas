/**
 * iSCSI → dashboard warning cards (story `iscsi.5`).
 *
 * Two halves: the pure mapping (`buildIscsiWarnings`) against every card shape
 * the health diff can produce, and the fail-open collector against the real
 * fixtures — including the two states that must add NOTHING (healthy, and LIO
 * not installed) and the one that must not throw (a read that blows up).
 */

import type { IscsiHealth } from '@anas/shared'
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
import { buildIscsiWarnings, collectIscsiWarnings } from '../iscsi-warnings.js'

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

  it('a placeholder ANAS could NOT unmap says so, instead of implying it is handled', () => {
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
        quarantined: false,
        fileRemoved: false,
      }],
      degraded: true,
    }))
    const card = w.find(c => /placeholder created by/.test(c.message))!
    assert.match(card.message, /could NOT take it offline - it is still being served|could NOT take it offline — it is still being served/)
    // Only the signal that actually fired is quoted.
    assert.ok(!/instead of/.test(card.message), card.message)
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
        quarantined: true,
        fileRemoved: true,
      }],
      degraded: true,
    }))
    const card = w.find(c => /did not restore/.test(c.message))!
    assert.match(card.message, /ANAS REMOVED the placeholder/)
    assert.match(card.message, /nothing of yours was deleted/)
    assert.match(card.message, /Mount the filesystem that should hold the image/)
    assert.match(card.message, /use Repair on the iSCSI menu/)
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
    assert.match(plain[0].message, /Enable it from the iSCSI menu/)

    const withReason = buildIscsiWarnings(health({
      disabledTargets: [{ targetIqn: IQN, tpgTag: 1, lunCount: 1, detail: 'A whole-image restore onto it failed and left it disabled: the image was partially written' }],
    }))
    assert.match(withReason[0].message, /partially written/)
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
      missingLuns: [{ targetIqn: IQN, tpgTag: 1, lunIndex: 0, backstoreName: 'a', plugin: 'block', backingPath: '/dev/zvol/p/a', backingExists: true }],
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

  it('a read that THROWS fails open to no cards, never to a broken dashboard', async () => {
    // Every read INSIDE the layer already swallows its own errors, so the throw
    // has to be forced from outside it — the guarantee under test is simply
    // "this collector never propagates", the same contract every other
    // dashboard source signs.
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

    const w = await collectIscsiWarnings(exploding, hostile)
    assert.deepEqual(w, [])
  })
})
