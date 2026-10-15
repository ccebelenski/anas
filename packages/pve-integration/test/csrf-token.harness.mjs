#!/usr/bin/env node
/*
 * ANAS — CSRF token harness (story cr.25a, docs/WAVE2-DESIGN.md §3 and §7).
 *
 * Loads the real 10-api.js in a vm sandbox with a stub `fetch` and a fake
 * `Proxmox` global, and checks that ANAS.api's doFetch:
 *   - sends `CSRFPreventionToken` from window.Proxmox.CSRFPreventionToken on
 *     every request (GET and mutations alike, as the design says),
 *   - re-reads the global on EVERY call (PVE replaces it on ticket renewal),
 *   - omits the header, without throwing, when the global or the token is
 *     absent, and otherwise sends exactly the headers it sent before.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const apiSrc = readFileSync(join(SRC, '10-api.js'), 'utf8')

const calls = []

function fakeResponse() {
  return {
    status: 200,
    statusText: 'OK',
    headers: { get: function () { return null } },
    text: function () { return Promise.resolve('{"data":[]}') },
  }
}

const sandbox = {
  ANAS: {},
  console,
  setTimeout,
  Promise,
  fetch: function (url, opts) {
    calls.push({ url, opts })
    return Promise.resolve(fakeResponse())
  },
}
// As in a browser, `window` IS the global object: a bare `Proxmox` and
// `window.Proxmox` name the same thing, and an absent one is a ReferenceError.
sandbox.window = sandbox
vm.createContext(sandbox)
vm.runInContext(apiSrc, sandbox, { filename: '10-api.js' })

const ANAS = sandbox.window.ANAS

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL:', label)
    process.exitCode = 1
  }
  else {
    console.log('ok', label)
  }
}

function last() {
  return calls[calls.length - 1]
}

function headerKeys(call) {
  return Object.keys(call.opts.headers).sort().join(',')
}

async function main() {
  // 1. Token set → sent, on a mutation and on a read.
  sandbox.window.Proxmox = { CSRFPreventionToken: '6720A1B2:tokenOne' }
  await ANAS.api.post('pve1', '/pools/tank/scrub', { action: 'start' })
  assert('POST carries CSRFPreventionToken', last().opts.headers.CSRFPreventionToken === '6720A1B2:tokenOne')
  assert('POST keeps its JSON body and type', last().opts.headers['Content-Type'] === 'application/json'
    && last().opts.body === '{"action":"start"}')
  await ANAS.api.get('pve1', '/pools')
  assert('GET carries CSRFPreventionToken (sent on every request)', last().opts.headers.CSRFPreventionToken === '6720A1B2:tokenOne')
  await ANAS.api.del('pve1', '/shares/smb/x')
  assert('DELETE carries CSRFPreventionToken', last().opts.headers.CSRFPreventionToken === '6720A1B2:tokenOne')

  // 2. PVE renews the ticket and replaces the token: the next call sends the new one.
  sandbox.window.Proxmox.CSRFPreventionToken = '6720B3C4:tokenTwo'
  await ANAS.api.put('pve1', '/datasets/tank%2Fa', { quota: 1 })
  assert('token re-read per call (renewed token sent)', last().opts.headers.CSRFPreventionToken === '6720B3C4:tokenTwo')
  // Replacing the whole Proxmox object is also picked up.
  sandbox.window.Proxmox = { CSRFPreventionToken: '6720C5D6:tokenThree' }
  await ANAS.api.health('pve1')
  assert('token re-read per call (new Proxmox object)', last().opts.headers.CSRFPreventionToken === '6720C5D6:tokenThree')

  // 3. Global absent → header omitted, no throw, the rest unchanged.
  delete sandbox.window.Proxmox
  let threw = null
  try {
    await ANAS.api.post('pve1', '/pools/tank/scrub', { action: 'start' })
  }
  catch (e) {
    threw = e
  }
  assert('no Proxmox global: request resolves, no throw', threw === null)
  assert('no Proxmox global: header omitted', !('CSRFPreventionToken' in last().opts.headers))
  assert('no Proxmox global: exactly the pre-cr.25a headers', headerKeys(last()) === 'Accept,Content-Type')
  await ANAS.api.get('pve1', '/pools')
  assert('no Proxmox global: GET has only Accept', headerKeys(last()) === 'Accept')

  // 4. Proxmox present but no token (not logged in yet) / empty → omitted.
  sandbox.window.Proxmox = {}
  await ANAS.api.post('pve1', '/pools/tank/scrub')
  assert('Proxmox without token: header omitted', !('CSRFPreventionToken' in last().opts.headers))
  sandbox.window.Proxmox = { CSRFPreventionToken: '' }
  await ANAS.api.post('pve1', '/pools/tank/scrub')
  assert('empty token: header omitted', !('CSRFPreventionToken' in last().opts.headers))

  // 5. The confirm header still rides alongside the token.
  sandbox.window.Proxmox = { CSRFPreventionToken: '6720D7E8:tokenFour' }
  await ANAS.api.del('pve1', '/pools/tank', { confirmCode: 'CONF-1' })
  assert('confirm + token together', last().opts.headers['X-Anas-Confirm'] === 'CONF-1'
    && last().opts.headers.CSRFPreventionToken === '6720D7E8:tokenFour')

  if (!process.exitCode)
    console.log('All CSRF token checks passed')
}

main().catch(function (e) {
  console.error('FAIL: harness error', e)
  process.exitCode = 1
})
