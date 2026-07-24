import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createAuthProvider } from '../auth/index.js'
import { PveAuthProvider } from '../auth/providers/pve.js'

/**
 * Dev auth authenticates every request as `devuser` — a total auth bypass. It's
 * fine on a dev/test box (no PVE authkey), but a stray ANAS_AUTH_PROVIDER=dev on
 * a real PVE node would silently accept everyone. createAuthProvider refuses to
 * arm dev auth when the node looks real, unless an explicit override is set.
 *
 * We mock PveAuthProvider.isAvailable() (the authkey.pub presence check) rather
 * than touching /etc/pve.
 */
describe('createAuthProvider dev-auth tripwire', () => {
  const realIsAvailable = PveAuthProvider.isAvailable
  const realOverride = process.env.ANAS_ALLOW_INSECURE_DEV_AUTH

  afterEach(() => {
    PveAuthProvider.isAvailable = realIsAvailable
    if (realOverride === undefined)
      delete process.env.ANAS_ALLOW_INSECURE_DEV_AUTH
    else
      process.env.ANAS_ALLOW_INSECURE_DEV_AUTH = realOverride
  })

  it('dev on a NON-PVE node starts fine (as today)', () => {
    PveAuthProvider.isAvailable = () => false
    delete process.env.ANAS_ALLOW_INSECURE_DEV_AUTH
    const provider = createAuthProvider('dev')
    assert.equal(provider.name, 'dev')
  })

  it('dev on a real PVE node with no override throws at startup', () => {
    PveAuthProvider.isAvailable = () => true
    delete process.env.ANAS_ALLOW_INSECURE_DEV_AUTH
    assert.throws(
      () => createAuthProvider('dev'),
      /total authentication bypass.*real PVE node|ANAS_ALLOW_INSECURE_DEV_AUTH/,
    )
  })

  it('dev on a real PVE node WITH the override starts (escape hatch)', () => {
    PveAuthProvider.isAvailable = () => true
    process.env.ANAS_ALLOW_INSECURE_DEV_AUTH = '1'
    const provider = createAuthProvider('dev')
    assert.equal(provider.name, 'dev')
  })

  it('the default (unset provider) selects pve regardless of authkey presence', () => {
    PveAuthProvider.isAvailable = () => true
    const provider = createAuthProvider(undefined)
    assert.equal(provider.name, 'pve')
  })
})
