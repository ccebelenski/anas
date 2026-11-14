import type { CommandExecutor, ExecResult, ExecStreamResult, PipelineResult } from '../../executor/types.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { BLOCK_BYTES, probeFileBlockState, sleep, writeDirect } from '../selfheal-io.js'

/**
 * An executor whose `dd` reads its staged payload only AFTER a delay — long
 * enough for a second, concurrent write to have staged its own in the
 * meantime. What each `dd` read is recorded per target device.
 */
class SlowDd implements CommandExecutor {
  readonly wrote = new Map<string, Buffer>()
  readonly calls: { command: string, args: string[] }[] = []
  statExit = 0

  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args })
    if (command === '/usr/bin/stat')
      return { stdout: this.statExit === 0 ? '257\n' : '', stderr: '', exitCode: this.statExit }
    if (command === '/usr/bin/dd') {
      const from = args.find(a => a.startsWith('if='))?.slice(3) ?? ''
      const of = args.find(a => a.startsWith('of='))?.slice(3) ?? ''
      await sleep(20)
      if (of !== '/dev/null')
        this.wrote.set(of, readFileSync(from))
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: `unexpected ${command}`, exitCode: 127 }
  }

  async pipeline(): Promise<PipelineResult> {
    throw new Error('not used')
  }

  async execToStream(): Promise<ExecStreamResult> {
    throw new Error('not used')
  }
}

describe('writeDirect — the staged payload (cr3 AHR-HEAL-L11)', () => {
  let runtime: string
  beforeEach(() => {
    runtime = mkdtempSync(join(tmpdir(), 'anas-selfheal-io-'))
    process.env.ANAS_SELFHEAL_RUNTIME_DIR = runtime
  })
  afterEach(() => {
    delete process.env.ANAS_SELFHEAL_RUNTIME_DIR
    rmSync(runtime, { recursive: true, force: true })
  })

  it('two writes at the SAME md byte offset on two pools each write their OWN 4 KiB', async () => {
    // A repair on pool A and a mirror reconcile on pool B, both long-lane jobs,
    // writing md byte 16171008 at the same moment. The staged file used to be
    // named `<pid>-<byteOffset>`: one name for both, so one pool's block went
    // through the OTHER pool's md device.
    const exec = new SlowDd()
    const a = Buffer.alloc(BLOCK_BYTES, 0xAA)
    const b = Buffer.alloc(BLOCK_BYTES, 0xBB)
    await Promise.all([
      writeDirect(exec, '/dev/md/poolA-r1', 16171008, a),
      writeDirect(exec, '/dev/md/poolB-r1', 16171008, b),
    ])
    assert.ok(exec.wrote.get('/dev/md/poolA-r1')?.equals(a), 'pool A got pool A\'s bytes')
    assert.ok(exec.wrote.get('/dev/md/poolB-r1')?.equals(b), 'pool B got pool B\'s bytes')
    assert.deepEqual(readdirSync(runtime), [], 'every staged payload was removed')
  })
})

describe('probeFileBlockState — a path that is not there is not a bad block (cr3 AHR-HEAL-M6)', () => {
  it('answers `missing` without reading when stat says the path is absent', async () => {
    const exec = new SlowDd()
    exec.statExit = 1
    assert.equal(await probeFileBlockState(exec, '/mnt/pool/anas-selfheal-1/vm/disk.raw', 3), 'missing')
    assert.ok(!exec.calls.some(c => c.command === '/usr/bin/dd'), 'nothing was read')
  })

  it('answers `ok` for a block that reads, through the same O_DIRECT probe the scrub uses', async () => {
    const exec = new SlowDd()
    assert.equal(await probeFileBlockState(exec, '/mnt/pool/f1.bin', 3), 'ok')
    assert.ok(exec.calls.some(c => c.command === '/usr/bin/dd' && c.args.includes('iflag=direct')))
  })
})
