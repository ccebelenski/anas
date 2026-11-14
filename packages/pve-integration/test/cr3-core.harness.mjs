#!/usr/bin/env node
/*
 * ANAS — cr3.core panel checks (docs/CODE-REVIEW-2026-11-14.md, "Core,
 * gateway, installers"), against the REAL panel files in a vm sandbox.
 *
 *   L6  20-notinstalled.js: a failed /health probe renders "ANAS is not
 *       installed" ONLY for the gateway's ANAS_NOT_INSTALLED code. A 401
 *       (expired ticket), 502 NODE_UNREACHABLE, 503, 504 or a network error
 *       renders "could not be reached" with the error's own sentence,
 *       HTML-encoded, and no install hint; a 403 stays the privilege panel.
 *   H   10-api.js confirmAndRun (EPICS §3 "Confirm dialog carries the 409's
 *       headline"): the confirm dialog shows the 409's `error.message` under
 *       the intro, encoded, in both presentations (Ext.Msg.confirm and the
 *       widget window); a warning that only repeats it is not shown twice;
 *       an intro that already says it word for word is not doubled.
 *
 *   node packages/pve-integration/test/cr3-core.harness.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const coreSrc = readFileSync(join(SRC, '00-core.js'), 'utf8')
const apiSrc = readFileSync(join(SRC, '10-api.js'), 'utf8')
const notInstalledSrc = readFileSync(join(SRC, '20-notinstalled.js'), 'utf8')

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

function htmlEncode(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

// ---- L6: the install check -----------------------------------------------

function loadInstallCheck(healthResult) {
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
  vm.runInContext(notInstalledSrc, sandbox, { filename: '20-notinstalled.js' })
  return ANAS
}

async function renderCheck(healthResult) {
  const ANAS = loadInstallCheck(healthResult)
  const added = []
  const panel = { add: c => added.push(c), setLoading() {}, addDocked() {} }
  ANAS.withInstallCheck('pve2', () => ({ xtype: 'panel', cls: 'the-view' })).listeners.afterrender(panel)
  await flush()
  return added
}

// An error exactly as 10-api.js's doFetch builds it: the message is the
// envelope's sentence, `.status` and `.body` carried.
function apiFailure(status, code, message) {
  return () => {
    const e = new Error(message)
    e.status = status
    e.body = code ? { error: { code, message } } : message
    return Promise.reject(e)
  }
}

const NOT_INSTALLED_MSG = 'ANAS is not installed on node \'pve2\' (its Proxmox front door answered, but the /anas endpoint is not present).'
{
  const added = await renderCheck(apiFailure(502, 'ANAS_NOT_INSTALLED', NOT_INSTALLED_MSG))
  assert('L6: ANAS_NOT_INSTALLED → the install hint', added[0] && added[0].cls.includes('anas-view-notinstalled'))
}
for (const [status, code, message] of [
  [401, 'UNAUTHORIZED', 'This request did not come through pveproxy'],
  [502, 'NODE_UNREACHABLE', 'Node \'pve2\' is unreachable: its certificate is not trusted (<UNABLE_TO_VERIFY_LEAF_SIGNATURE>)'],
  [502, 'INTERNAL_ERROR', 'anasd unavailable: connect ENOENT /run/anas/anasd.sock'],
  [503, 'UNAVAILABLE', 'The daemon is starting'],
  [504, 'GATEWAY_TIMEOUT', 'Node \'pve2\' did not answer within 25 s: the request timed out.'],
  [0, null, 'network error'],
]) {
  const added = await renderCheck(apiFailure(status, code, message))
  const p = added[0]
  const label = `L6: ${status} ${code || '(no envelope)'}`
  assert(`${label} → the unreachable panel, never the install hint`, p && p.cls.includes('anas-view-unreachable') && !p.cls.includes('notinstalled'))
  assert(`${label}: no install command in it`, p && !p.html.includes('install.sh') && !p.html.includes('not installed'))
  assert(`${label}: shows the error's own sentence, encoded`, p && p.html.includes(htmlEncode(message)))
  assert(`${label}: no raw markup from the message`, p && !p.html.includes('<UNABLE'))
  if (status > 0)
    assert(`${label}: names the status and code`, p && p.html.includes(`HTTP ${status}${code ? ` ${code}` : ''}`))
}
{
  const added = await renderCheck(apiFailure(403, 'FORBIDDEN', 'Permission check failed (/, Sys.Audit)'))
  assert('L6: 403 stays the privilege panel', added[0] && added[0].cls.includes('anas-view-noprivilege'))
}
{
  const ANAS = loadInstallCheck(() => Promise.resolve({}))
  const p = ANAS.unreachablePanel('n"<b>1</b>', { status: 502, message: 'x', body: { error: { code: '<i>C</i>' } } })
  assert('L6: the node name and the code are encoded in the unreachable panel', !p.html.includes('<b>1</b>') && !p.html.includes('<i>C</i>'))
}

// ---- The confirm dialog carries the 409's headline ------------------------

function loadApi(answer) {
  const confirms = []
  const windows = []
  const Ext = {
    String: { htmlEncode },
    toast() {},
    Msg: {
      alert() {},
      // Recorded, never answered: the check is what the dialog SAYS.
      confirm(title, msg) { confirms.push({ title, msg }) },
    },
    create(cls, cfg) {
      windows.push(cfg)
      return { down: () => null, show() {}, close() {}, on() {} }
    },
  }
  const sandbox = {
    console,
    Promise,
    Ext,
    setTimeout,
    clearTimeout,
    fetch() {
      return Promise.resolve({
        status: answer.status,
        statusText: 'Conflict',
        headers: { get: name => (name === 'x-anas-confirm-code' ? 'CODE-1' : null) },
        text: () => Promise.resolve(JSON.stringify(answer.body)),
      })
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(coreSrc, sandbox, { filename: '00-core.js' })
  vm.runInContext(apiSrc, sandbox, { filename: '10-api.js' })
  return { ANAS: sandbox.window.ANAS, confirms, windows }
}

const HEADLINE = 'This plan adds no usable capacity: the new disk is smaller than every band <b>x</b>'
const WARNINGS = ['Rebuilds take hours', HEADLINE]

{
  const { ANAS, confirms } = loadApi({ status: 409, body: { error: { code: 'CONFIRMATION_REQUIRED', message: HEADLINE, warnings: WARNINGS } } })
  ANAS.confirmAndRun({ node: 'pve2', method: 'post', path: '/ahr/tank/expand', body: {} })
  await flush()
  const msg = confirms[0] && confirms[0].msg
  assert('headline: the default dialog opened', typeof msg === 'string')
  assert('headline: the default intro is still there', msg && msg.includes('This operation requires confirmation:'))
  assert('headline: the 409\'s message is shown, encoded', msg && msg.includes(htmlEncode(HEADLINE)))
  assert('headline: never as raw markup', msg && !msg.includes('<b>x</b>'))
  assert('headline: the other warning is listed', msg && msg.includes('Rebuilds take hours'))
  assert('headline: a warning that repeats it is not shown twice', msg && msg.split(htmlEncode(HEADLINE)).length === 2)
}
{
  const { ANAS, confirms } = loadApi({ status: 409, body: { error: { code: 'CONFIRMATION_REQUIRED', message: 'Deleting snapshot \'s1\' from pool \'tank\'', warnings: [] } } })
  ANAS.confirmAndRun({ node: 'pve2', method: 'del', path: '/x', confirmIntro: 'Delete <b>s1</b>?' })
  await flush()
  const msg = confirms[0] && confirms[0].msg
  assert('headline: a caller intro is kept, and the headline follows it', msg && msg.indexOf('Delete <b>s1</b>?') === 0 && msg.includes(htmlEncode('Deleting snapshot \'s1\' from pool \'tank\'')))
}
{
  const said = 'Remounting pool \'tank\' unmounts and mounts its filesystem'
  const { ANAS, confirms } = loadApi({ status: 409, body: { error: { code: 'CONFIRMATION_REQUIRED', message: said, warnings: [] } } })
  ANAS.confirmAndRun({ node: 'pve2', method: 'post', path: '/x', confirmIntro: `<p>${htmlEncode(said)}</p>` })
  await flush()
  const msg = confirms[0] && confirms[0].msg
  assert('headline: an intro that already says it word for word is not doubled', msg && msg.split(htmlEncode(said)).length === 2)
}
{
  const { ANAS, windows } = loadApi({ status: 409, body: { error: { code: 'CONFIRMATION_REQUIRED', message: HEADLINE, warnings: WARNINGS } } })
  ANAS.confirmAndRun({ node: 'pve2', method: 'post', path: '/x', confirmWindow: true, extraItems: [] })
  await flush()
  const body = windows[0] && windows[0].items && windows[0].items[0] && windows[0].items[0].html
  assert('headline: the widget window carries it too, encoded, once', typeof body === 'string' && body.split(htmlEncode(HEADLINE)).length === 2 && body.includes('Rebuilds take hours'))
}
{
  const { ANAS, confirms } = loadApi({ status: 409, body: { error: { code: 'CONFIRMATION_REQUIRED', message: HEADLINE, warnings: [] } } })
  ANAS.confirmAndRun({ node: 'pve2', method: 'post', path: '/x', confirmHeadline: true })
  await flush()
  const msg = confirms[0] && confirms[0].msg
  assert('headline: confirmHeadline flows keep leading with it in bold, once', msg && msg.indexOf(`<b>${htmlEncode(HEADLINE)}</b>`) === 0 && msg.split(htmlEncode(HEADLINE)).length === 2)
}

// ---- confirmAndRun's onCancel (cr3, handed by the pools-panel area) -------
//
// Contract: when the operator answers No to a confirm prompt (the first prompt
// or a re-prompt; No, Cancel, the window's close tool), confirmAndRun calls
// opts.onCancel() exactly once, if given, and sends no request. onCancel is
// never called when the job runs or is rejected.

function loadApiAnswering(handler) {
  const prompts = [] // { kind: 'msg'|'window', answer(yes: boolean) }
  const calls = []
  const Ext = {
    String: { htmlEncode },
    toast() {},
    Msg: {
      // A rejection's alert: dismissed at once (its callback carries onFailed).
      alert(title, msg, fn) { if (fn) fn() },
      confirm(title, msg, fn) {
        prompts.push({ kind: 'msg', answer: yes => fn(yes ? 'yes' : 'no') })
      },
    },
    create(cls, cfg) {
      let closed = false
      const win = {
        down: () => null,
        show() {},
        on() {},
        close() {
          if (closed) return
          closed = true
          cfg.listeners && cfg.listeners.close && cfg.listeners.close()
        },
      }
      prompts.push({
        kind: 'window',
        answer: yes => (yes ? cfg.buttons[1].handler({}) : cfg.buttons[0].handler()),
        closeTool: () => win.close(),
      })
      return win
    },
  }
  const sandbox = {
    console,
    Promise,
    Ext,
    setTimeout,
    clearTimeout,
    fetch(url, o) {
      const method = ((o && o.method) || 'GET').toUpperCase()
      const confirm = o && o.headers && o.headers['X-Anas-Confirm']
      calls.push({ method, url, confirm })
      const a = handler(calls.length, method, url, confirm)
      return Promise.resolve({
        status: a.status,
        statusText: 'x',
        headers: { get: name => (name === 'x-anas-confirm-code' ? (a.code || null) : null) },
        text: () => Promise.resolve(JSON.stringify(a.body)),
      })
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(coreSrc, sandbox, { filename: '00-core.js' })
  vm.runInContext(apiSrc, sandbox, { filename: '10-api.js' })
  return { ANAS: sandbox.window.ANAS, prompts, calls }
}

const CHALLENGE = { status: 409, code: 'C1', body: { error: { code: 'CONFIRMATION_REQUIRED', message: 'Destroying pool \'tank\' erases all of its data', warnings: [] } } }

for (const windowed of [false, true]) {
  const how = windowed ? 'widget window' : 'Ext.Msg.confirm'
  {
    const { ANAS, prompts, calls } = loadApiAnswering(() => CHALLENGE)
    const seen = { cancel: 0, complete: 0, failed: 0 }
    ANAS.confirmAndRun({ node: 'pve2', method: 'del', path: '/pools/tank', confirmWindow: windowed, extraItems: [], onCancel: () => seen.cancel++, onComplete: () => seen.complete++, onFailed: () => seen.failed++ })
    await flush()
    prompts[0].answer(false)
    await flush()
    assert(`onCancel (${how}): No on the first prompt calls onCancel exactly once`, seen.cancel === 1)
    assert(`onCancel (${how}): ... and sends no request after the challenge`, calls.length === 1 && !calls[0].confirm)
    assert(`onCancel (${how}): ... and nothing else is called`, seen.complete === 0 && seen.failed === 0)
  }
  {
    const { ANAS, prompts, calls } = loadApiAnswering(n => (n === 1 ? CHALLENGE : { status: 200, body: {} }))
    const seen = { cancel: 0, complete: 0 }
    ANAS.confirmAndRun({ node: 'pve2', method: 'del', path: '/pools/tank', confirmWindow: windowed, extraItems: [], onCancel: () => seen.cancel++, onComplete: () => seen.complete++ })
    await flush()
    prompts[0].answer(true)
    await flush()
    assert(`onCancel (${how}): Yes runs the job (resend with the code), onCancel never called`, calls.length === 2 && calls[1].confirm === 'C1' && seen.complete === 1 && seen.cancel === 0)
  }
  {
    const { ANAS, prompts } = loadApiAnswering(n => (n === 1 ? CHALLENGE : { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'no' } } }))
    const seen = { cancel: 0, failed: 0 }
    ANAS.confirmAndRun({ node: 'pve2', method: 'del', path: '/pools/tank', confirmWindow: windowed, extraItems: [], onCancel: () => seen.cancel++, onFailed: () => seen.failed++ })
    await flush()
    prompts[0].answer(true)
    await flush()
    assert(`onCancel (${how}): a job the daemon refuses goes to onFailed, never onCancel`, seen.failed === 1 && seen.cancel === 0)
  }
  {
    // A confirmed resend answered with a FRESH challenge is a re-prompt; No there is a cancel too.
    const RECHALLENGE = { status: 409, code: 'C2', body: { error: { code: 'IDENTITY_MISMATCH', message: 'The pool under that name changed', warnings: [] } } }
    const { ANAS, prompts, calls } = loadApiAnswering(n => (n === 1 ? CHALLENGE : RECHALLENGE))
    const seen = { cancel: 0, failed: 0 }
    ANAS.confirmAndRun({ node: 'pve2', method: 'del', path: '/pools/tank', confirmWindow: windowed, extraItems: [], onCancel: () => seen.cancel++, onFailed: () => seen.failed++ })
    await flush()
    prompts[0].answer(true)
    await flush()
    assert(`onCancel (${how}): the re-prompt opened`, prompts.length === 2)
    prompts[1].answer(false)
    await flush()
    assert(`onCancel (${how}): No on a re-prompt calls onCancel exactly once, sends nothing more`, seen.cancel === 1 && seen.failed === 0 && calls.length === 2)
  }
}
{
  // The widget window's close tool (or Esc) is a No; OK then close is not.
  const { ANAS, prompts } = loadApiAnswering(() => CHALLENGE)
  const seen = { cancel: 0 }
  ANAS.confirmAndRun({ node: 'pve2', method: 'del', path: '/pools/tank', confirmWindow: true, extraItems: [], onCancel: () => seen.cancel++ })
  await flush()
  prompts[0].closeTool()
  prompts[0].closeTool()
  await flush()
  assert('onCancel (widget window): the close tool is a No, called once however often the window closes', seen.cancel === 1)
}
{
  // Without onCancel nothing breaks (additive).
  const { ANAS, prompts, calls } = loadApiAnswering(() => CHALLENGE)
  ANAS.confirmAndRun({ node: 'pve2', method: 'del', path: '/pools/tank' })
  await flush()
  prompts[0].answer(false)
  await flush()
  assert('onCancel absent: a No still sends nothing and throws nothing', calls.length === 1)
}

if (failed > 0) {
  console.error(`cr3-core harness: ${failed} failed`)
  process.exitCode = 1
}
else {
  console.log('cr3-core harness: all passed')
}
