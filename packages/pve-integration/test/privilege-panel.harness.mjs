#!/usr/bin/env node
/*
 * ANAS — install-check panel choice harness (story cr.27, docs/WAVE2-DESIGN.md
 * §5 row 15 and §7).
 *
 * Since cr.27 the gateway answers a user whom PVE does not grant Sys.Audit on
 * `/` with a 403 FORBIDDEN. Every view is wrapped in ANAS.withInstallCheck,
 * which probes /health first; before cr.27 ANY failure rendered "ANAS is not
 * installed on this node", which would send the operator to reinstall a node
 * that is fine. This loads the REAL 20-notinstalled.js in a vm sandbox and
 * drives its afterrender listener with a stubbed ANAS.api.health:
 *
 *   - 403 → the privilege panel (names Sys.Audit on /, shows the gateway's
 *     sentence), not the not-installed panel;
 *   - a network failure (status 0) and a 502 → the not-installed panel, as
 *     before;
 *   - success → the view the factory builds.
 *
 *   node packages/pve-integration/test/privilege-panel.harness.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, '..', 'src', '20-notinstalled.js'), 'utf8')

let failed = 0
function assert(label, cond) {
  if (!cond) {
    console.error('FAIL:', label)
    failed++
  }
  else {
    console.log('ok', label)
  }
}

function htmlEncode(v) {
  return String(v).replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function load(healthResult) {
  const warnings = []
  const ANAS = {
    enc: htmlEncode,
    t: s => s,
    warn: m => warnings.push(m),
    errText: e => (e && e.message) ? e.message : String(e),
    errorPanel: m => ({ xtype: 'panel', html: m, cls: 'error' }),
    api: { health: () => healthResult() },
  }
  const sandbox = { window: { ANAS }, console, Promise }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: '20-notinstalled.js' })
  return { ANAS, warnings }
}

async function render(healthResult) {
  const { ANAS, warnings } = load(healthResult)
  const added = []
  const panel = { add: c => added.push(c), setLoading() {}, addDocked() {} }
  const cfg = ANAS.withInstallCheck('anas-pve', () => ({ xtype: 'panel', cls: 'the-view' }))
  cfg.listeners.afterrender(panel)
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  return { added, warnings }
}

function failure(status, message) {
  return () => {
    const e = new Error(message)
    e.status = status
    return Promise.reject(e)
  }
}

const FORBIDDEN = 'Permission check failed (/, Sys.Audit): anas-none@pve does not have it. ANAS asks the privilege PVE asks for its own disk and ZFS operations.'

{
  const { added, warnings } = await render(failure(403, FORBIDDEN))
  assert('403: one panel rendered', added.length === 1)
  assert('403: the privilege panel', added[0] && added[0].cls.includes('anas-view-noprivilege'))
  assert('403: NOT the not-installed panel', added[0] && !added[0].cls.includes('anas-view-notinstalled'))
  assert('403: the heading names Sys.Audit on /', added[0] && added[0].html.includes('You need Sys.Audit on / to view ANAS on this node'))
  assert('403: the gateway\'s sentence is shown, encoded', added[0] && added[0].html.includes(htmlEncode(FORBIDDEN)))
  assert('403: logged to the console', warnings.some(w => w.includes('403')))
}
{
  const { added } = await render(failure(0, 'network error'))
  assert('network failure: the not-installed panel, as before', added[0] && added[0].cls.includes('anas-view-notinstalled'))
}
{
  const { added } = await render(failure(502, 'ANAS gateway not ready (no proxy key)'))
  assert('502: the not-installed panel, as before', added[0] && added[0].cls.includes('anas-view-notinstalled'))
}
{
  const { added } = await render(() => Promise.resolve({ version: '0.4.4' }))
  assert('success: the view itself', added.some(c => c.cls === 'the-view'))
}
{
  const { ANAS } = load(() => Promise.resolve({}))
  const p = ANAS.noPrivilegePanel('n"<1>', '<script>x</script>')
  assert('the node name and the sentence are HTML-encoded', !p.html.includes('<script>') && p.html.includes('&lt;script&gt;') && !p.html.includes('n"<1>'))
}

if (failed > 0) {
  console.error(`privilege-panel harness: ${failed} failed`)
  process.exitCode = 1
}
