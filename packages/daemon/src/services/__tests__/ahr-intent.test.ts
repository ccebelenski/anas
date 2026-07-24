import type { AhrCapacity, AhrExpansionIntent } from '@anas/shared'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  AhrIntentConflictError,
  clearIntent,
  listIntents,
  readIntent,
  writeIntent,
} from '../ahr-intent.js'

const CAP: AhrCapacity = {
  rawBytes: 0,
  usableBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  redundancyOverheadBytes: 0,
  unprotectedWastedBytes: 0,
  pendingBytes: 0,
}

function mkIntent(overrides: Partial<AhrExpansionIntent> = {}): AhrExpansionIntent {
  return {
    id: randomUUID(),
    trigger: 'add-disk',
    approvedDisks: ['ata-TANK_X', 'ata-TANK_Y'],
    before: CAP,
    after: { ...CAP, usableBytes: 1024 ** 3 },
    state: 'running',
    ...overrides,
  }
}

describe('ahr-intent (§5.3 — the ONLY persisted expansion state)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anas-ahr-intent-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips an intent through write/read', async () => {
    const intent = mkIntent({ trigger: 'replace-disk', replacedDisk: 'ata-OLD', replacementDisk: 'ata-NEW' })
    await writeIntent('tank', intent, { dir })
    const back = await readIntent('tank', dir)
    assert.deepEqual(back, intent)
  })

  it('reads null for a pool with no intent file', async () => {
    assert.equal(await readIntent('nosuch', dir), null)
  })

  it('persists exactly the AhrExpansionIntent shape as JSON', async () => {
    const intent = mkIntent()
    await writeIntent('tank', intent, { dir })
    const raw = JSON.parse(await readFile(join(dir, 'tank.json'), 'utf-8'))
    assert.deepEqual(raw, intent)
  })

  it('throws on a present-but-invalid file (never silently discards)', async () => {
    await writeFile(join(dir, 'tank.json'), '{"state":"running"}')
    await assert.rejects(() => readIntent('tank', dir), /invalid/)
  })

  it('CAS: expect absent refuses when an intent already exists (double-expand)', async () => {
    await writeIntent('tank', mkIntent(), { dir, expect: 'absent' })
    await assert.rejects(
      () => writeIntent('tank', mkIntent(), { dir, expect: 'absent' }),
      AhrIntentConflictError,
    )
  })

  it('CAS: expect halted refuses a resume race (state moved)', async () => {
    await writeIntent('tank', mkIntent({ state: 'running' }), { dir })
    await assert.rejects(
      () => writeIntent('tank', mkIntent({ state: 'running' }), { dir, expect: 'halted' }),
      AhrIntentConflictError,
    )
    // And succeeds once the intent is actually halted.
    const halted = mkIntent({ state: 'halted' })
    await writeIntent('tank', halted, { dir })
    await writeIntent('tank', { ...halted, state: 'running' }, { dir, expect: 'halted' })
    assert.equal((await readIntent('tank', dir))?.state, 'running')
  })

  it('clearIntent removes the record; clearing an absent record is a no-op', async () => {
    await writeIntent('tank', mkIntent(), { dir })
    await clearIntent('tank', dir)
    assert.equal(await readIntent('tank', dir), null)
    await clearIntent('tank', dir) // no throw
  })

  it('rejects a pool name that fails the schema (no path traversal)', async () => {
    await assert.rejects(() => readIntent('../etc/passwd', dir))
  })

  it('listIntents returns every pool record; absent dir is empty', async () => {
    assert.deepEqual(await listIntents(join(dir, 'nope')), [])
    await writeIntent('tank', mkIntent(), { dir })
    await writeIntent('vault', mkIntent({ state: 'halted' }), { dir })
    const all = await listIntents(dir)
    assert.deepEqual(all.map(i => i.pool).sort(), ['tank', 'vault'])
  })
})
