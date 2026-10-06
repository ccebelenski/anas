import type { FastifyReply, FastifyRequest } from 'fastify'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockExecutor } from '../../executor/mock.js'
import { ConfirmStore } from '../confirm.js'
import {
  confirmGateBound,
  IDENTITY_MISMATCH,
  IdentityMismatchError,
  readDatasetGuid,
  readPoolGuid,
  readRollbackIds,
  requireStableId,
} from '../stable-id.js'

/** A minimal reply that records what a gate sent. */
function fakeReply() {
  const sent: { status?: number, headers: Record<string, string>, body?: unknown } = { headers: {} }
  const reply = {
    code(n: number) {
      sent.status = n
      return reply
    },
    header(k: string, v: string) {
      sent.headers[k.toLowerCase()] = v
      return reply
    },
    send(b: unknown) {
      sent.body = b
      return reply
    },
  }
  return { reply: reply as unknown as FastifyReply, sent }
}

function req(code?: string): FastifyRequest {
  return { headers: code ? { 'x-anas-confirm': code } : {} } as unknown as FastifyRequest
}

const OPTS = { operation: 'zpool.destroy', params: { pool: 'tank' }, what: `Pool 'tank'`, message: 'm', warnings: ['w'] }

describe('ConfirmStore — bound ids (ident.1)', () => {
  it('a code minted under one guid verifies only under that guid', () => {
    const store = new ConfirmStore()
    const { code } = store.generateCode('zpool.destroy', { pool: 'tank' }, { guid: '1' })
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }, { guid: '2' }), false)
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }), false, 'unbound verify cannot use a bound code')
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }, { guid: '1' }), true)
  })

  it('takeBoundMismatch returns the minted id (and consumes the code) only on a same-name, different-id resend', () => {
    const store = new ConfirmStore()
    const { code } = store.generateCode('zpool.destroy', { pool: 'tank' }, { guid: '1' })
    assert.equal(store.takeBoundMismatch(code, 'zpool.destroy', { pool: 'other' }, { guid: '2' }), null)
    assert.equal(store.takeBoundMismatch(code, 'zpool.destroy', { pool: 'tank' }, { guid: '1' }), null)
    assert.deepEqual(store.takeBoundMismatch(code, 'zpool.destroy', { pool: 'tank' }, { guid: '2' }), { guid: '1' })
    assert.equal(store.verifyCode(code, 'zpool.destroy', { pool: 'tank' }, { guid: '1' }), false, 'consumed')
  })
})

describe('confirmGateBound (ident.1)', () => {
  it('no code → the ordinary 409 CONFIRMATION_REQUIRED; the right code → proceed', () => {
    const store = new ConfirmStore()
    const a = fakeReply()
    assert.equal(confirmGateBound(store, req(), a.reply, { ...OPTS, bound: { guid: '7' } }), false)
    assert.equal(a.sent.status, 409)
    assert.equal((a.sent.body as { error: { code: string } }).error.code, 'CONFIRMATION_REQUIRED')
    const code = a.sent.headers['x-anas-confirm-code']
    assert.equal(confirmGateBound(store, req(code), fakeReply().reply, { ...OPTS, bound: { guid: '7' } }), true)
  })

  it('a resend after the guid changed → 409 IDENTITY_MISMATCH naming both, a fresh code, the mismatch as the first warning', () => {
    const store = new ConfirmStore()
    const a = fakeReply()
    confirmGateBound(store, req(), a.reply, { ...OPTS, bound: { guid: '7' } })
    const b = fakeReply()
    assert.equal(confirmGateBound(store, req(a.sent.headers['x-anas-confirm-code']), b.reply, { ...OPTS, bound: { guid: '8' } }), false)
    assert.equal(b.sent.status, 409)
    const err = (b.sent.body as { error: { code: string, message: string, warnings: string[] } }).error
    assert.equal(err.code, IDENTITY_MISMATCH)
    assert.equal(err.message, `Pool 'tank' is not the one that was confirmed (guid 7 at the confirmation, guid 8 now) — nothing was done; confirm again`)
    assert.match(err.warnings[0], /changed since you confirmed \(guid 7 then, guid 8 now\)/)
    assert.equal(err.warnings[1], 'w')
    const fresh = b.sent.headers['x-anas-confirm-code']
    assert.ok(fresh)
    assert.equal(confirmGateBound(store, req(fresh), fakeReply().reply, { ...OPTS, bound: { guid: '8' } }), true)
  })
})

describe('stable-id readers and the job-side check (ident.1)', () => {
  it('reads pool and dataset guids with -H -o value; a failed or empty read is null', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: '/usr/sbin/zpool', args: ['get', '-H', '-o', 'value', 'guid', 'tank'], result: { stdout: '123\n', stderr: '', exitCode: 0 } })
    ex.addFixture({ command: '/usr/sbin/zfs', args: ['get', '-H', '-o', 'value', 'guid', 'tank/a'], result: { stdout: '456\n', stderr: '', exitCode: 0 } })
    assert.deepEqual(await readPoolGuid(ex, 'tank'), { guid: '123' })
    assert.deepEqual(await readDatasetGuid(ex, 'tank/a'), { guid: '456' })
    assert.equal(await readPoolGuid(ex, 'gone'), null)
  })

  it('rollback ids: the target\'s createtxg and the NEWEST snapshot\'s (numeric, not lexical)', async () => {
    const ex = new MockExecutor()
    ex.addFixture({ command: '/usr/sbin/zfs', args: ['list', '-t', 'snapshot', '-Hp', '-o', 'name,createtxg', '-d', '1', 'tank/a'], result: {
      stdout: 'tank/a@one\t99\ntank/a@two\t100\ntank/a@three\t1000\n',
      stderr: '',
      exitCode: 0,
    } })
    assert.deepEqual(await readRollbackIds(ex, 'tank/a', 'tank/a@two'), { snapshotTxg: '100', newestTxg: '1000' })
    assert.equal(await readRollbackIds(ex, 'tank/a', 'tank/a@gone'), null)
  })

  it('requireStableId throws IdentityMismatchError (jobErrorCode IDENTITY_MISMATCH) on a change or an unreadable id', async () => {
    await requireStableId('Pool \'tank\'', { guid: '1' }, async () => ({ guid: '1' }))
    const err = await requireStableId('Pool \'tank\'', { guid: '1' }, async () => ({ guid: '2' })).catch(e => e)
    assert.ok(err instanceof IdentityMismatchError)
    assert.equal(err.jobErrorCode, IDENTITY_MISMATCH)
    assert.match(err.message, /guid 1 at the confirmation, guid 2 now/)
    const gone = await requireStableId('Pool \'tank\'', { guid: '1' }, async () => null).catch(e => e)
    assert.match(gone.message, /unreadable now/)
  })
})
