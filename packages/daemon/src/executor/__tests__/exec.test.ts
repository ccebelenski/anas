import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProdExecutor, StderrTee } from '../prod.js'

const TRUE = '/usr/bin/true'
const FALSE = '/usr/bin/false'
const TIMEOUT = '/usr/bin/timeout'

describe('ProdExecutor.exec (exit-code propagation)', () => {
  it('reports exit 0 on success', async () => {
    const exec = new ProdExecutor()
    const r = await exec.exec(TRUE, [])
    assert.equal(r.exitCode, 0)
  })

  it('reports a plain non-zero exit code', async () => {
    const exec = new ProdExecutor()
    const r = await exec.exec(FALSE, [])
    assert.equal(r.exitCode, 1)
  })

  it('preserves the EXACT non-zero exit code (regression: not collapsed to 1)', async () => {
    // `timeout` exits 124 when it kills a still-running child. This exact code
    // is load-bearing: the Mounts liveness probe (`timeout 2 stat -f`) maps 124
    // → 'unreachable'. A dead NFS server hangs stat, timeout fires, and the
    // daemon MUST see 124 (not a collapsed 1, which classifies as 'unknown' and
    // suppresses the dashboard mount warning). See prod.ts err.code vs .status.
    const exec = new ProdExecutor()
    const r = await exec.exec(TIMEOUT, ['1', 'sleep', '5'])
    assert.equal(r.exitCode, 124)
  })

  it('rejects when the command cannot be spawned (ENOENT)', async () => {
    const exec = new ProdExecutor()
    await assert.rejects(() => exec.exec('/nonexistent/bin/nope', []), /ENOENT/)
  })

  it('honours a caller-supplied maxBuffer on the buffered path (over the cap: rejected)', async () => {
    const exec = new ProdExecutor()
    await assert.rejects(
      () => exec.exec(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024 * 1024))'], { maxBuffer: 16 * 1024 }),
      /maxBuffer/,
    )
  })

  it('honours a caller-supplied maxBuffer on the buffered path (generous cap: completes)', async () => {
    const exec = new ProdExecutor()
    // 11 MB of stdout — over the 10 MiB DEFAULT, under the requested 32 MiB:
    // this is the option doing its job, not the default.
    const r = await exec.exec(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(11 * 1024 * 1024))'],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout.length, 11 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------------------
//  The tee path — exec with onStderr (rclone.2 slice 2 fix batch)
// ---------------------------------------------------------------------------

describe('ProdExecutor.exec with onStderr (the tee path)', () => {
  /**
   * A child that writes ~30 MB of rclone-shaped stats JSON to stderr: 300k
   * lines of ~100 bytes, then one final stats object. At `--stats 30s` that
   * is what a multi-day offsite copy accumulates — the shape that died on the
   * old flat 10 MiB maxBuffer.
   */
  const LONG_STDERR_SCRIPT = `
    const line = JSON.stringify({ level: 'info', stats: { bytes: 1, totalBytes: 2 } }) + ' '.repeat(60) + '\\n';
    for (let i = 0; i < 300000; i++) process.stderr.write(line);
    process.stderr.write(JSON.stringify({ level: 'info', stats: { bytes: 4194304, totalBytes: 4194304 } }) + '\\n');
  `

  it('a 30 MB stderr stream completes, tees every byte, and retains only the bounded tail', async () => {
    const exec = new ProdExecutor()
    const seen: string[] = []
    const r = await exec.exec(
      process.execPath,
      ['-e', LONG_STDERR_SCRIPT],
      { onStderr: chunk => seen.push(chunk) },
    )
    assert.equal(r.exitCode, 0)
    const teed = seen.join('')
    assert.ok(teed.length > 20 * 1024 * 1024, `the tee delivered the whole log (${teed.length} chars)`)
    // The RESULT is not the log: the tee consumed it, the tail is all that is kept.
    assert.ok(r.stderr.length <= 64 * 1024, `retained ${r.stderr.length} chars`)
    // And the tail carries what post-run code reads — the LAST stats object.
    const lastLine = r.stderr.trim().split('\n').at(-1)!
    assert.equal(JSON.parse(lastLine).stats.bytes, 4194304)
  })

  it('the tail re-parses at a line boundary (no phantom partial first line)', async () => {
    const exec = new ProdExecutor()
    const r = await exec.exec(
      process.execPath,
      ['-e', LONG_STDERR_SCRIPT],
      { onStderr: () => {} },
    )
    for (const line of r.stderr.split('\n').slice(0, -1))
      assert.ok(line.startsWith('{'), `tail line cut mid-line: ${JSON.stringify(line.slice(0, 40))}`)
  })
})

// ---------------------------------------------------------------------------
//  StderrTee — UTF-8 chunk boundaries + the bounded tail (rclone.2 fix batch)
// ---------------------------------------------------------------------------

describe('StderrTee', () => {
  it('a multi-byte character split across two chunks is never mangled', () => {
    const seen: string[] = []
    const tee = new StderrTee(c => seen.push(c))
    // 'é' is 0xC3 0xA9 in UTF-8 — split across the chunks, as a pipe read can.
    tee.write(Buffer.from([0x61, 0xC3]))
    tee.write(Buffer.from([0xA9, 0x62, 0x0A]))
    assert.deepEqual(seen, ['a', 'éb\n'])
    assert.equal(tee.finish(), 'aéb\n')
  })

  it('a TRUNCATED multi-byte tail at end of stream is an honest U+FFFD, not a held byte', () => {
    const seen: string[] = []
    const tee = new StderrTee(c => seen.push(c))
    tee.write(Buffer.from('caf', 'utf8'))
    tee.write(Buffer.from([0xC3])) // first byte of '©' — the second never arrives
    assert.deepEqual(seen, ['caf'])
    // StringDecoder cannot invent the missing byte; the replacement character
    // is the truthful answer to "the child died mid-character". The fix the
    // tee exists for is the case above: bytes that DO all arrive decode whole.
    assert.equal(tee.finish(), 'caf\uFFFD')
  })

  it('a long stream keeps only the last 64 KiB, cut at a line boundary', () => {
    const seen: string[] = []
    const tee = new StderrTee(c => seen.push(c))
    const line = `${'x'.repeat(99)}\n`
    for (let i = 0; i < 1000; i++)
      tee.write(Buffer.from(line, 'utf8'))
    const tail = tee.finish()
    assert.ok(tail.length <= 64 * 1024, `tail is ${tail.length} chars`)
    assert.ok(tail.startsWith('x'), 'starts at a line boundary, not mid-line')
    assert.ok(tail.endsWith('\n'))
    // The bound is on RETENTION only — the tee still delivered everything.
    assert.equal(seen.join('').length, 1000 * 100)
  })

  it('a single line longer than the cap keeps its raw cut — bounded is the point', () => {
    const tee = new StderrTee(() => {})
    tee.write(Buffer.alloc(80 * 1024, 0x78)) // 80 KiB of 'x', no newline
    assert.equal(tee.finish().length, 64 * 1024)
  })
})
