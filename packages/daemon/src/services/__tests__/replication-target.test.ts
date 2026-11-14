import type { ReplicationTarget } from '@anas/shared'
import type { PveFootprint } from '../pve-footprint.js'
import type { TargetGuardDeps } from '../replication-target.js'
import type { PoolExistence, ResolvedLocation, Transport } from '../replication-transport.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { guardReplicationTarget, memoisePoolExists } from '../replication-target.js'

/**
 * The target guard's own file (repl.r2): "does the target pool exist" is
 * THREE-VALUED on a peer/remote — answered yes, answered no, or did not answer
 * — and the guard's sentences must keep the third apart from the second. An
 * operator sent to look for a pool that exists is the defect this pins.
 */

const REMOTE_LOCATION = { kind: 'remote' as const, name: 'nas1' }
const PEER_LOCATION = { kind: 'peer' as const, name: 'node2' }

const RESOLVED_REMOTE: ResolvedLocation = {
  kind: 'remote',
  host: '10.0.0.9',
  port: 22,
  user: 'root',
  keyPath: '/etc/pve/priv/anas/replication_key',
  knownHostsFile: '/etc/pve/priv/anas/known_hosts',
}
const RESOLVED_PEER: ResolvedLocation = { kind: 'peer', host: 'node2' }

/** A footprint that owns nothing — the local guard's only other fact. */
const NO_FOOTPRINT = {
  ownershipOf: () => null,
  claimedByPve: () => null,
  ownedDescendant: () => null,
} as unknown as PveFootprint

/** Deps whose transport answers the pool question however the test says. */
function depsOf(answer: PoolExistence, poolExists?: (pool: string) => Promise<PoolExistence>): TargetGuardDeps {
  const transport = {
    resolveLocation: async (location: { kind: string, name?: string }) =>
      location.kind === 'remote'
        ? { ok: true as const, resolved: RESOLVED_REMOTE }
        : { ok: true as const, resolved: RESOLVED_PEER },
    remotePoolExists: async () => answer,
  } as unknown as Transport
  return {
    transport,
    poolExists: poolExists ?? (async () => ({ ok: true, exists: true })),
    pveFootprint: async () => NO_FOOTPRINT,
  }
}

async function guardRemote(answer: PoolExistence, target: ReplicationTarget = { pool: 'backup', location: REMOTE_LOCATION }) {
  return guardReplicationTarget(depsOf(answer), { target, sourceFull: 'testpool/media', targetFull: 'backup/media' })
}

describe('repl.r2 — the target guard distinguishes a missing pool from a host that did not answer', () => {
  it('answered, pool present → ok, with the placement the run needs', async () => {
    const result = await guardRemote({ ok: true, exists: true })
    assert.deepEqual(result, { ok: true, placement: { isRemote: true, resolved: RESOLVED_REMOTE } })
  })

  it('answered, pool absent → today\'s sentence, byte for byte', async () => {
    const result = await guardRemote({ ok: true, exists: false })
    assert.deepEqual(result, { ok: false, message: `Target pool 'backup' does not exist on remote 'nas1'` })
  })

  it('did not answer → the remote\'s own line, and never the does-not-exist sentence', async () => {
    const result = await guardRemote({ ok: false, error: 'root@10.0.0.9: Permission denied (publickey,password).' })
    assert.deepEqual(result, {
      ok: false,
      message: `Could not list the pools on remote 'nas1': root@10.0.0.9: Permission denied (publickey,password).`,
    })
    if (!result.ok)
      assert.doesNotMatch(result.message, /does not exist/)
  })

  it('a peer that did not answer names the peer and carries the ssh line', async () => {
    const result = await guardReplicationTarget(
      depsOf({ ok: false, error: 'ssh: connect to host node2 port 22: Connection timed out' }),
      { target: { pool: 'tank', location: PEER_LOCATION }, sourceFull: 'testpool/media', targetFull: 'tank/media' },
    )
    assert.deepEqual(result, {
      ok: false,
      message: `Could not list the pools on peer 'node2': ssh: connect to host node2 port 22: Connection timed out`,
    })
  })

  it('the LOCAL branch is untouched: an absent local pool keeps the bare sentence', async () => {
    const result = await guardReplicationTarget(
      depsOf({ ok: true, exists: true }, async () => ({ ok: true, exists: false })),
      { target: { pool: 'backup' }, sourceFull: 'testpool/media', targetFull: 'backup/media' },
    )
    assert.deepEqual(result, { ok: false, message: `Target pool 'backup' does not exist` })
  })

  it('the LOCAL branch is untouched: a present local pool passes the guard', async () => {
    const result = await guardReplicationTarget(
      depsOf({ ok: true, exists: true }),
      { target: { pool: 'backup' }, sourceFull: 'testpool/media', targetFull: 'backup/media' },
    )
    assert.deepEqual(result, { ok: true, placement: { isRemote: false } })
  })
})

describe('repl.r2 — memoisePoolExists keeps "did not answer" as itself', () => {
  it('a probe that did not answer is asked once and refuses every dataset of the pass with its own line', async () => {
    let asked = 0
    const deps = memoisePoolExists(depsOf({ ok: true, exists: true }, async () => {
      asked++
      return { ok: false, error: 'local probe failed' }
    }))
    const first = await guardReplicationTarget(deps, { target: { pool: 'backup' }, sourceFull: 'testpool/a', targetFull: 'backup/a' })
    const second = await guardReplicationTarget(deps, { target: { pool: 'backup' }, sourceFull: 'testpool/b', targetFull: 'backup/b' })
    assert.deepEqual(first, { ok: false, message: `Could not list the pools: local probe failed` })
    assert.deepEqual(second, first, 'the memo shares the answer — it never becomes a fresh or different one')
    assert.equal(asked, 1, 'one pool read for the whole pass')
    if (!first.ok)
      assert.doesNotMatch(first.message, /does not exist/)
  })

  it('an answered "no" is shared too, and keeps the does-not-exist sentence', async () => {
    let asked = 0
    const deps = memoisePoolExists(depsOf({ ok: true, exists: true }, async () => {
      asked++
      return { ok: true, exists: false }
    }))
    const first = await guardReplicationTarget(deps, { target: { pool: 'backup' }, sourceFull: 'testpool/a', targetFull: 'backup/a' })
    const second = await guardReplicationTarget(deps, { target: { pool: 'backup' }, sourceFull: 'testpool/b', targetFull: 'backup/b' })
    assert.deepEqual(first, { ok: false, message: `Target pool 'backup' does not exist` })
    assert.deepEqual(second, first)
    assert.equal(asked, 1)
  })
})
