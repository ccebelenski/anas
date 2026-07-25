import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockExecutor } from '../../executor/mock.js'
import {
  diagnoseBusyPath,
  enrichBusyError,
  extractBusyPath,
  formatHolders,
  isBusyError,
  parseFuserPids,
} from '../busy-diagnosis.js'

/**
 * Busy-unmount root-cause diagnosis (story 3.29). Parser is exercised against
 * the REAL `fuser -m` terse capture; enrichment is proven to append on a busy
 * failure with a known path AND to leave the primary error verbatim in every
 * degrade case (tool missing, no holders, not a busy error, no path).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FUSER_HOLDERS = readFileSync(join(__dirname, '../../fixtures/busy/fuser-m-holders.txt'), 'utf-8')

const FUSER = '/usr/bin/fuser'

describe('busy-diagnosis — parser (real fuser -m fixture)', () => {
  it('parses the two real holder PIDs from the terse capture', () => {
    assert.deepEqual(parseFuserPids(FUSER_HOLDERS), [483284, 483285])
  })

  it('strips the access-type letter suffix fuser sometimes appends (5961c → 5961)', () => {
    // The story-18.1 capture form: PIDs with a trailing access letter.
    assert.deepEqual(parseFuserPids(' 5960  5961c\n'), [5960, 5961])
  })

  it('de-duplicates and tolerates junk / empty output', () => {
    assert.deepEqual(parseFuserPids('42 42 43'), [42, 43])
    assert.deepEqual(parseFuserPids(''), [])
    assert.deepEqual(parseFuserPids('\n  \n'), [])
  })
})

describe('busy-diagnosis — isBusyError / extractBusyPath', () => {
  it('recognizes the ZFS and umount busy classes, rejects unrelated errors', () => {
    assert.equal(isBusyError(`cannot unmount '/chiapools/pool15': pool or dataset is busy`), true)
    assert.equal(isBusyError('umount: /mnt/anas-cifs: target is busy.'), true)
    assert.equal(isBusyError('no such pool'), false)
  })

  it('extracts the path from the umount error segment', () => {
    assert.equal(extractBusyPath('umount: /mnt/anas-cifs: target is busy.'), '/mnt/anas-cifs')
  })

  it('extracts the quoted path from the ZFS error', () => {
    assert.equal(extractBusyPath(`cannot unmount '/chiapools/pool15': pool or dataset is busy`), '/chiapools/pool15')
  })

  it('returns null when no path is present', () => {
    assert.equal(extractBusyPath('device is busy'), null)
  })
})

describe('busy-diagnosis — formatHolders', () => {
  it('renders comm(pid), comma-joined', () => {
    assert.equal(
      formatHolders([{ command: 'chia_harvester', pid: 1234 }, { command: 'smbd', pid: 567 }]),
      'held open by: chia_harvester(1234), smbd(567)',
    )
  })

  it('caps at 5 with a +N more tail', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ command: 'p', pid: i + 1 }))
    assert.equal(formatHolders(many), 'held open by: p(1), p(2), p(3), p(4), p(5), +3 more')
  })

  it('empty in → empty string (nothing to append)', () => {
    assert.equal(formatHolders([]), '')
  })
})

describe('busy-diagnosis — diagnoseBusyPath (fuser + injected /proc)', () => {
  let procRoot: string

  beforeEach(async () => {
    procRoot = await mkdtemp(join(tmpdir(), 'anas-proc-'))
  })
  afterEach(async () => {
    await rm(procRoot, { recursive: true, force: true })
  })

  async function seedComm(pid: number, comm: string): Promise<void> {
    await mkdir(join(procRoot, String(pid)))
    await writeFile(join(procRoot, String(pid), 'comm'), `${comm}\n`)
  }

  it('names the holders (comm from /proc/<pid>/comm)', async () => {
    await seedComm(1234, 'chia_harvester')
    await seedComm(567, 'smbd')
    const exec = new MockExecutor()
    exec.addFixture({ command: FUSER, args: ['-m', '/chiapools/pool15'], result: { stdout: '1234 567\n', stderr: '', exitCode: 0 } })

    const holders = await diagnoseBusyPath(exec, '/chiapools/pool15', { procRoot })
    assert.deepEqual(holders, [{ command: 'chia_harvester', pid: 1234 }, { command: 'smbd', pid: 567 }])
  })

  it('skips a PID whose /proc entry vanished (process died) — never throws', async () => {
    await seedComm(1234, 'chia_harvester')
    const exec = new MockExecutor()
    exec.addFixture({ command: FUSER, args: ['-m', '/x'], result: { stdout: '1234 999\n', stderr: '', exitCode: 0 } })

    const holders = await diagnoseBusyPath(exec, '/x', { procRoot })
    assert.deepEqual(holders, [{ command: 'chia_harvester', pid: 1234 }])
  })

  it('fuser missing / errors → empty (fail-open)', async () => {
    // No fixture for fuser → MockExecutor returns exit 127 (command not found).
    const holders = await diagnoseBusyPath(new MockExecutor(), '/x', { procRoot })
    assert.deepEqual(holders, [])
  })
})

describe('busy-diagnosis — enrichBusyError (the wire-up contract)', () => {
  let procRoot: string
  beforeEach(async () => {
    procRoot = await mkdtemp(join(tmpdir(), 'anas-proc-'))
    await mkdir(join(procRoot, '1234'))
    await writeFile(join(procRoot, '1234', 'comm'), 'chia_harvester\n')
  })
  afterEach(async () => {
    await rm(procRoot, { recursive: true, force: true })
  })

  function execWithHolder(path: string): MockExecutor {
    const exec = new MockExecutor()
    exec.addFixture({ command: FUSER, args: ['-m', path], result: { stdout: '1234\n', stderr: '', exitCode: 0 } })
    return exec
  }

  it('appends the holders on a busy error with a KNOWN path', async () => {
    const exec = execWithHolder('/mnt/tank')
    const out = await enrichBusyError(exec, 'umount: /mnt/tank: target is busy.', '/mnt/tank', { procRoot })
    assert.equal(out, 'umount: /mnt/tank: target is busy. — held open by: chia_harvester(1234)')
  })

  it('appends on a busy error whose path is EXTRACTED from the text (ZFS destroy)', async () => {
    const exec = execWithHolder('/chiapools/pool15')
    const base = `cannot unmount '/chiapools/pool15': pool or dataset is busy`
    const out = await enrichBusyError(exec, base, undefined, { procRoot })
    assert.equal(out, `${base} — held open by: chia_harvester(1234)`)
  })

  it('leaves a NON-busy error verbatim (never diagnoses)', async () => {
    const exec = execWithHolder('/mnt/tank')
    const base = 'cannot open pool: no such pool'
    assert.equal(await enrichBusyError(exec, base, '/mnt/tank', { procRoot }), base)
  })

  it('leaves the error verbatim when NO holders are found', async () => {
    const exec = new MockExecutor()
    exec.addFixture({ command: FUSER, args: ['-m', '/mnt/tank'], result: { stdout: '', stderr: '', exitCode: 1 } })
    const base = 'umount: /mnt/tank: target is busy.'
    assert.equal(await enrichBusyError(exec, base, '/mnt/tank', { procRoot }), base)
  })

  it('leaves the error verbatim when the tool is MISSING', async () => {
    const base = 'umount: /mnt/tank: target is busy.'
    assert.equal(await enrichBusyError(new MockExecutor(), base, '/mnt/tank', { procRoot }), base)
  })

  it('leaves the error verbatim when no path is known or derivable', async () => {
    const base = 'device is busy' // busy, but names no path
    assert.equal(await enrichBusyError(execWithHolder('/x'), base, undefined, { procRoot }), base)
  })
})
