import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AhrCreateRequest, ahrMaxPoolNameLength } from '../schemas/ahr.js'

/**
 * Story cr.18 (review M7.4): create builds the md array name
 * `<pool>-r<band>` (mdadm cap: 32) and the member GPT labels
 * `<pool>-d<n>-b<band>` (GPT cap: 36 UTF-16) from the pool name, and the
 * disks are wiped BEFORE either tool would complain. The refusal therefore
 * lives in the create schema, where the request still means nothing yet.
 */

const poolName = (length: number) => `a${'l'.repeat(length - 1)}`

function createBody(name: string, diskCount: number) {
  return {
    name,
    tier: 'ahr1',
    disks: Array.from({ length: diskCount }, (_, i) => `ata-DISK_${i}`),
  }
}

describe('ahrMaxPoolNameLength — the create-time name ceiling (cr.18, M7.4)', () => {
  it('binds md (30 − digits) for 1–9 disks, both at 10, GPT (32 − 2·digits) beyond', () => {
    // d=1: md binds (29 < 30); d=2: both bind at 28; d≥3: GPT binds.
    assert.equal(ahrMaxPoolNameLength(1), 29)
    assert.equal(ahrMaxPoolNameLength(9), 29)
    assert.equal(ahrMaxPoolNameLength(10), 28)
    assert.equal(ahrMaxPoolNameLength(99), 28)
    assert.equal(ahrMaxPoolNameLength(100), 26)
    assert.equal(ahrMaxPoolNameLength(1000), 24)
  })

  it('treats a zero disk count as one (the schema floor)', () => {
    assert.equal(ahrMaxPoolNameLength(0), 29)
  })
})

describe('AhrCreateRequest — names that cannot fit the derived identifiers are refused (cr.18, M7.4)', () => {
  it('accepts the longest name and refuses one longer, per disk count', () => {
    for (const diskCount of [1, 2, 9, 10, 100]) {
      const max = ahrMaxPoolNameLength(diskCount)
      const ok = AhrCreateRequest.safeParse(createBody(poolName(max), diskCount))
      assert.equal(ok.success, true, `${diskCount} disk(s), ${max} chars: ${JSON.stringify(ok.error?.issues)}`)

      const tooLong = AhrCreateRequest.safeParse(createBody(poolName(max + 1), diskCount))
      assert.equal(tooLong.success, false, `${diskCount} disk(s), ${max + 1} chars must be refused`)
      const issue = tooLong.error!.issues[0]
      assert.deepEqual(issue.path, ['name'])
      assert.match(issue.message, new RegExp(`max ${max} for ${diskCount} disk\\(s\\)`))
    }
  })

  it('the refusal names the offending length and the capped identifiers', () => {
    const r = AhrCreateRequest.safeParse(createBody(poolName(30), 2))
    assert.equal(r.success, false)
    const { message } = r.error!.issues[0]
    assert.ok(message.includes('is 30 characters'), message)
    assert.ok(message.includes('<pool>-r<N>'), message)
    assert.ok(message.includes('<pool>-d<N>-b<N>'), message)
  })

  it('does not mask the other create validations: an over-long name on a bad body still fails on both counts, and a good short name is untouched', () => {
    const short = AhrCreateRequest.safeParse(createBody('tpool', 2))
    assert.equal(short.success, true)
    // The 255-char PoolName ceiling is now dominated by this one: 255 > 29.
    const schemaCeiling = AhrCreateRequest.safeParse(createBody(poolName(255), 1))
    assert.equal(schemaCeiling.success, false)
    assert.match(schemaCeiling.error!.issues[0].message, /max 29/)
  })
})
