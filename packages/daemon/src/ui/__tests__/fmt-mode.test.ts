import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * Contract test for the UI's shared octal→human helper `ANAS.fmtMode`
 * (packages/pve-integration/src/00-core.js). The helper is browser ES5 with no
 * bundler, so it is exercised the only faithful way — by evaluating the real
 * core file in a VM sandbox and calling the function that ships. This keeps a
 * single source of truth (no duplicated logic in the test) and grows the daemon
 * suite that guards the mounts feature (18.9).
 */
const __dirname = dirname(fileURLToPath(import.meta.url))
const corePath = join(__dirname, '../../../../pve-integration/src/00-core.js')

function loadFmtMode(): (octal: unknown) => { valid: boolean, octal: string, symbolic: string, plain: string } {
  const src = readFileSync(corePath, 'utf-8')
  const sandbox: { window: { ANAS?: Record<string, unknown> }, console: Console } = { window: {}, console }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  const fmtMode = sandbox.window.ANAS?.fmtMode
  assert.equal(typeof fmtMode, 'function', 'ANAS.fmtMode must be defined by 00-core.js')
  return fmtMode as (octal: unknown) => { valid: boolean, octal: string, symbolic: string, plain: string }
}

describe('ANAS.fmtMode — octal → symbolic + plain gloss (18.9)', () => {
  const fmtMode = loadFmtMode()

  it('0644 → rw-r--r-- with a plain owner/group/others gloss', () => {
    const r = fmtMode('0644')
    assert.equal(r.valid, true)
    assert.equal(r.symbolic, 'rw-r--r--')
    assert.equal(r.plain, 'Owner: read & write · Group: read · Others: read')
  })

  it('0755 → rwxr-xr-x', () => {
    const r = fmtMode('0755')
    assert.equal(r.valid, true)
    assert.equal(r.symbolic, 'rwxr-xr-x')
    assert.equal(r.plain, 'Owner: read & write & execute · Group: read & execute · Others: read & execute')
  })

  it('0000 → --------- with "no access" everywhere', () => {
    const r = fmtMode('0000')
    assert.equal(r.valid, true)
    assert.equal(r.symbolic, '---------')
    assert.equal(r.plain, 'Owner: no access · Group: no access · Others: no access')
  })

  it('accepts a 3-digit value (755 == 0755)', () => {
    assert.equal(fmtMode('755').symbolic, 'rwxr-xr-x')
    assert.equal(fmtMode('644').symbolic, 'rw-r--r--')
  })

  it('a 4-digit value ignores the leading special bit for the rwx triads', () => {
    // Setuid (4)755 still reads rwxr-xr-x in the triad view.
    assert.equal(fmtMode('4755').symbolic, 'rwxr-xr-x')
    assert.equal(fmtMode('1777').symbolic, 'rwxrwxrwx')
  })

  it('invalid input degrades gracefully to { valid:false } with empty strings', () => {
    for (const bad of ['', '0648', '77', 'abc', '0644,exec', '12345', null, undefined]) {
      const r = fmtMode(bad)
      assert.equal(r.valid, false, `should reject ${JSON.stringify(bad)}`)
      assert.equal(r.symbolic, '')
      assert.equal(r.plain, '')
    }
  })
})
