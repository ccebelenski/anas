import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProdExecutor } from '../prod.js'

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
})
