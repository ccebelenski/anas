import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadConfig } from '../config.js'

/**
 * Port variables (cr4). `Number.parseInt` read `ANAS_PORT=3000abc` as 3000
 * (trailing junk silently ignored) and `abc` as NaN: a mis-set variable could
 * bind a port nobody chose, or none at all. A port variable is digits only,
 * 1 to 65535; anything else stops the start with a line naming the variable,
 * the value found and the file where it is set.
 */

/** Env with the node-name tiers kept off the real filesystem. */
function load(extra: Record<string, string> = {}) {
  return loadConfig({ ANAS_PVE_LOCAL_PATH: '/nonexistent.anas-port-test', ...extra }, () => 'testnode')
}

describe('gateway config — port variables (cr4)', () => {
  it('the defaults hold when the variables are unset or empty', () => {
    const config = load()
    assert.equal(config.port, 3000)
    assert.equal(config.pvePort, 8006)
    const empty = load({ ANAS_PORT: '', ANAS_PVE_PORT: '' })
    assert.equal(empty.port, 3000)
    assert.equal(empty.pvePort, 8006)
  })

  it('plain digits are accepted, at the fenceposts included', () => {
    assert.equal(load({ ANAS_PORT: '1' }).port, 1)
    assert.equal(load({ ANAS_PORT: '65535' }).port, 65535)
    assert.equal(load({ ANAS_PVE_PORT: '8443' }).pvePort, 8443)
  })

  it('digits with trailing junk are refused, naming the variable and the value', () => {
    assert.throws(
      () => load({ ANAS_PORT: '3000abc' }),
      (err: Error) => err.message.includes('ANAS_PORT')
        && err.message.includes('\'3000abc\'')
        && err.message.includes('digits only')
        && err.message.includes('1 to 65535'),
    )
  })

  it('a value that is no number at all is refused (parseInt yielded NaN)', () => {
    assert.throws(
      () => load({ ANAS_PORT: 'abc' }),
      (err: Error) => err.message.includes('ANAS_PORT') && err.message.includes('\'abc\''),
    )
  })

  it('numbers outside the port range are refused', () => {
    for (const value of ['0', '-1', '65536', '99999']) {
      assert.throws(
        () => load({ ANAS_PORT: value }),
        (err: Error) => err.message.includes('ANAS_PORT') && err.message.includes(`'${value}'`),
      )
    }
  })

  it('the cross-node port is the same class of value', () => {
    assert.throws(
      () => load({ ANAS_PVE_PORT: '8006x' }),
      (err: Error) => err.message.includes('ANAS_PVE_PORT')
        && err.message.includes('\'8006x\'')
        && !err.message.includes('Invalid ANAS_PORT='),
    )
  })

  it('the refusal says where to fix it and what the default is', () => {
    assert.throws(
      () => load({ ANAS_PORT: '3000abc' }),
      (err: Error) => err.message.includes('/etc/default/anas') && err.message.includes('to use 3000'),
    )
    assert.throws(
      () => load({ ANAS_PVE_PORT: '0' }),
      (err: Error) => err.message.includes('/etc/default/anas') && err.message.includes('to use 8006'),
    )
  })
})
