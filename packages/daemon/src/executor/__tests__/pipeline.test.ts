import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProdExecutor } from '../prod.js'

const PRINTF = '/usr/bin/printf'
const WC = '/usr/bin/wc'
const LS = '/usr/bin/ls'
const YES = '/usr/bin/yes'
const FALSE = '/usr/bin/false'

describe('ProdExecutor.pipeline (real processes, no shell)', () => {
  it('pipes producer stdout into consumer stdin and reports both exits', async () => {
    const exec = new ProdExecutor()
    // printf 'hello' | wc -c  → 5 bytes.
    const r = await exec.pipeline(PRINTF, ['hello'], WC, ['-c'])
    assert.equal(r.leftExitCode, 0)
    assert.equal(r.rightExitCode, 0)
    assert.equal(r.leftStderr, '')
    assert.equal(r.stdout.trim(), '5')
  })

  it('reports a non-zero PRODUCER exit with its stderr', async () => {
    const exec = new ProdExecutor()
    // ls of a missing path fails (nonzero + stderr); wc still consumes the empty
    // stream and exits 0. The pipeline surfaces the producer failure.
    const r = await exec.pipeline(LS, ['/no/such/path/xyz'], WC, ['-c'])
    assert.notEqual(r.leftExitCode, 0)
    assert.ok(r.leftStderr.trim().length > 0, 'producer stderr should be captured')
    assert.equal(r.rightExitCode, 0)
  })

  it('kills the producer when the consumer exits early (no zombie, no hang)', async () => {
    const exec = new ProdExecutor()
    // `yes` produces forever; `false` never reads stdin and exits 1 immediately.
    // Because yes writes into OUR process (not directly to false), it would run
    // forever unless we SIGTERM it — so this both proves the kill path and that
    // the promise resolves rather than hanging.
    const start = Date.now()
    const r = await exec.pipeline(YES, [], FALSE, [])
    const elapsed = Date.now() - start
    assert.equal(r.rightExitCode, 1)
    assert.notEqual(r.leftExitCode, 0, 'producer should be terminated (non-zero)')
    assert.ok(elapsed < 5000, `pipeline resolved promptly (took ${elapsed}ms)`)
  })

  it('rejects when a process cannot be spawned (ENOENT)', async () => {
    const exec = new ProdExecutor()
    await assert.rejects(
      () => exec.pipeline('/nonexistent/bin/nope', [], WC, ['-c']),
      /ENOENT/,
    )
  })
})
