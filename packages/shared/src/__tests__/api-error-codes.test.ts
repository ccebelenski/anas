import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ErrorCode } from '../schemas/api.js'

/**
 * Every code the daemon and gateway put in an error envelope must be in the
 * shared ErrorCode enum — cr.17 found 'CONFLICT' (154 emit sites) and eleven
 * others answering live outside the declared contract.
 *
 * This list was produced by scanning the non-test sources of packages/daemon
 * and packages/gateway for `code: '…'` (including the ternaries that pick
 * between two codes on one line) and keeping the literals that sit inside an
 * `{ error: { code, message } }` envelope; the scan also showed codes like
 * ENOENT/EBUSY, which are fs/errno checks, and JOB_FAILED, which is a JOB
 * error code (Job.error.code is deliberately a free string, not an ApiError
 * code) — neither belongs here. A new emit site that skips the enum fails
 * here only if this list is updated too; keep them in step.
 */
const EMITTED_CODES = [
  // daemon
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'PROTECTED_RESOURCE',
  'CONFIRMATION_REQUIRED',
  'INTERNAL_ERROR',
  'UNAUTHORIZED',
  'SYSTEM_ACCOUNT',
  'CONFLICT',
  'UNAVAILABLE',
  'IN_USE',
  'PVE_MANAGED',
  'IDENTITY_MISMATCH',
  'NOT_CANCELLABLE',
  'UPSTREAM_ERROR',
  // gateway
  'NODE_UNREACHABLE',
  'ANAS_NOT_INSTALLED',
  'CLUSTER_CA_UNAVAILABLE',
  'NODE_UNRESOLVED',
  'GATEWAY_TIMEOUT',
  'FORWARD_LOOP',
]

describe('ErrorCode covers every emitted code (cr.17)', () => {
  it('the enum accepts every code the daemon or gateway emits', () => {
    for (const code of EMITTED_CODES)
      assert.ok(ErrorCode.safeParse(code).success, `code '${code}' is emitted but not in ErrorCode`)
  })

  it('the enum is still a closed set', () => {
    assert.equal(ErrorCode.safeParse('NOT_A_REAL_CODE').success, false)
    assert.equal(ErrorCode.safeParse('conflict').success, false)
  })
})
