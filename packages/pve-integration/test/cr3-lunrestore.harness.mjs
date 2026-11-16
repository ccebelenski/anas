#!/usr/bin/env node
/*
 * ANAS — cr3.lunrestore panel harness (75-iscsi.js).
 *
 * Loads the REAL 00-core.js, 10-api.js and 75-iscsi.js in a vm sandbox (a
 * permissive Ext stub whose Ext.Msg records what it was asked to show; the
 * daemon answers through a stubbed ANAS.api.post) and checks the panel half
 * of the restore mark (operator ruling 2026-11-14: a whole-image restore leaves
 * a breadcrumb on the volume):
 *
 *   - the target row and the LUN row show "Restore running" / "Partial image" /
 *     "Image not verified" / "Restore mark unreadable" from the health read's
 *     `restoreMarks[]`, the most telling one first, with the daemon's sentence
 *     as the tip, encoded;
 *   - review2 (8): the State column shows BOTH facts — Enabled/Disabled AND the
 *     mark — so an enabled target serving a marked LUN reads as both;
 *   - review2 (4a): while a restore is writing a LUN of a disabled target the
 *     toolbar does not invite Enable, and says why;
 *   - Enable goes through the real confirm path (a 409 with a confirm code is
 *     a question whose title is true for every mark state, review2 F3, and
 *     whose daemon sentences are encoded); Yes resends with the code; a 409
 *     without a code is a failure alert; Disable is a plain job;
 *   - the new code is ES5 and routes its strings through t().
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')
const SRC = readFileSync(join(SRC_DIR, '75-iscsi.js'), 'utf8')

const shown = []
const msg = {
  alert: (title, body, cb) => {
    shown.push({ kind: 'alert', title, body })
    if (cb)
      cb()
  },
  confirm: (title, body, cb) => shown.push({ kind: 'confirm', title, body, cb }),
  show: o => shown.push({ kind: 'show', o }),
}
function htmlEncode(v) {
  // ExtJS 7 Ext.String.htmlEncode: & > < " '
  return String(v).replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function permissive() {
  const fn = function () {
    return proxy
  }
  const proxy = new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive)
        return () => ''
      if (key === 'then')
        return undefined
      if (key === 'String')
        return { htmlEncode }
      if (key === 'Msg')
        return msg
      return proxy
    },
    apply() {
      return proxy
    },
    construct() {
      return proxy
    },
  })
  return proxy
}
const doc = { hidden: false, head: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, getElementById: () => null, getElementsByTagName: () => [{ appendChild() {} }], createTextNode: text => ({ text }), createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) }
const win = { document: doc }
const sandbox = { window: win, document: doc, Ext: permissive(), console, Promise, Date, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} }
for (const file of ['00-core.js', '10-api.js', '75-iscsi.js'])
  vm.runInNewContext(readFileSync(join(SRC_DIR, file), 'utf8'), sandbox, { filename: file })
const ANAS = win.ANAS
const iscsi = ANAS.iscsi

let failed = 0
function ok(label, cond, detail) {
  if (!cond) {
    failed++
    console.error(`FAIL: ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
  else {
    console.log(`ok ${label}`)
  }
}

function rec(data) {
  return { get: k => data[k] }
}
async function settle() {
  for (let i = 0; i < 4; i++)
    await new Promise(r => setImmediate(r))
}

const IQN = 'iqn.2026-11.nas.anas:vmstore'
const EVIL = `"><img src=x onerror=alert(1)>'</span><script>x</script>&amp;`
const health = {
  restoreMarks: [
    { targetIqn: IQN, lunIndex: 1, backstoreName: 'b', backingPath: '/dev/zvol/tank/b', dataset: 'tank/b', state: 'unreadable', source: 'mark', mark: null, detail: 'could not read <b>' },
    { targetIqn: IQN, lunIndex: 0, backstoreName: 'a', backingPath: '/dev/zvol/tank/a', dataset: 'tank/a', state: 'interrupted', source: 'mark', mark: null, detail: 'A restore onto LUN 0 did not finish: <script>x</script>' },
    { targetIqn: 'iqn.other', lunIndex: 0, backstoreName: 'c', backingPath: '/tank/images/c.raw', dataset: null, state: 'in-progress', source: 'job', mark: null, detail: 'running', job: 'j-1' },
  ],
}

// --- which mark a row shows -------------------------------------------------
ok('the target shows its most telling mark (interrupted beats unreadable)', iscsi.restoreMarkFor(health, IQN)?.state === 'interrupted')
ok('a LUN shows its own mark', iscsi.restoreMarkFor(health, IQN, 1)?.state === 'unreadable')
ok('another target\'s mark is not this one\'s', iscsi.restoreMarkFor(health, 'iqn.none') === null)
ok('a health read without the field marks nothing (an older daemon)', iscsi.restoreMarkFor({}, IQN) === null && iscsi.restoreMarkFor(null, IQN) === null)
ok('in progress outranks everything', iscsi.restoreMarkFor({ restoreMarks: [{ targetIqn: IQN, lunIndex: 0, state: 'interrupted', detail: '' }, { targetIqn: IQN, lunIndex: 1, state: 'in-progress', detail: '' }] }, IQN)?.state === 'in-progress')
ok('a job-sourced row (an image file, dataset null) is shown like any other', iscsi.restoreMarkFor(health, 'iqn.other')?.state === 'in-progress')

// --- how it renders ---------------------------------------------------------
const partial = iscsi.restoreMarkPill(health.restoreMarks[1])
ok('an interrupted mark renders "Partial image"', partial.includes('>Partial image<'), partial)
ok('the daemon\'s sentence is the tip, ENCODED', partial.includes('&lt;script&gt;x&lt;/script&gt;') && !partial.includes('<script>'), partial)
ok('a running restore renders "Restore running"', iscsi.restoreMarkPill({ state: 'in-progress', detail: 'job 7' }).includes('>Restore running<'))
ok('an unverified image renders "Image not verified"', iscsi.restoreMarkPill({ state: 'unverified', detail: '' }).includes('>Image not verified<'))
ok('an unreadable mark renders "Restore mark unreadable", never nothing', iscsi.restoreMarkPill({ state: 'unreadable', detail: '' }).includes('>Restore mark unreadable<'))
ok('no mark renders nothing', iscsi.restoreMarkPill(null) === '')
// --- D-27/P-10 (cr4.panels2): a state this page does not know renders as ----
// unknown, never as the red "Partial image" of a known value (the panel and
// the daemon upgrade independently in a cluster).
{
  const fut = iscsi.restoreMarkPill({ state: 'extent-gone-quietly', detail: `the daemon from tomorrow says <b>${EVIL}</b>` })
  ok('an unknown mark state renders a neutral "Unknown state" pill, never "Partial image"',
    fut.includes('>Unknown state<') && !fut.includes('Partial image') && !fut.includes('#c62828'), fut)
  ok('...with the daemon\'s detail as its tip, ENCODED',
    fut.includes('&lt;b&gt;') && fut.includes('&lt;script&gt;') && !fut.includes('<script'), fut)
  ok('a mark whose state is simply absent renders unknown too',
    iscsi.restoreMarkPill({ detail: 'x' }).includes('>Unknown state<'))
  ok('the known states keep their own pills', iscsi.restoreMarkPill({ state: 'interrupted', detail: '' }).includes('>Partial image<'))
}
for (const st of ['in-progress', 'interrupted', 'unverified', 'unreadable', EVIL, undefined]) {
  const html = iscsi.restoreMarkPill({ ...health.restoreMarks[1], state: st, detail: EVIL })
  ok(`a hostile sentence in a ${String(st).slice(0, 12)} pill stays text`, !html.includes('<img') && !html.includes('<script'), html)
}

// review2 (8): both facts in the State column.
const disabledMarked = iscsi.renderEnabled(false, {}, rec({ restoreMark: health.restoreMarks[1] }))
ok('a DISABLED marked target shows "Disabled" AND the mark', disabledMarked.includes('>Disabled<') && disabledMarked.includes('>Partial image<'), disabledMarked)
const enabledMarked = iscsi.renderEnabled(true, {}, rec({ restoreMark: health.restoreMarks[1] }))
ok('an ENABLED marked target (the critical case) shows "Enabled" AND the mark', enabledMarked.includes('>Enabled<') && enabledMarked.includes('>Partial image<'), enabledMarked)
ok('the state comes first, then the mark', enabledMarked.indexOf('>Enabled<') < enabledMarked.indexOf('>Partial image<'))
ok('an unmarked target renders as before (one pill, no mark)', iscsi.renderEnabled(false, {}, rec({ restoreMark: null })).includes('>Disabled<') && !iscsi.renderEnabled(true, {}, rec({})).includes('anas-iscsi-restore'))
const lunName = iscsi.renderLunName('vm<disk>', {}, rec({ restoreMark: health.restoreMarks[1] }))
ok('the LUN row: the name ENCODED, then the mark', lunName.startsWith('vm&lt;disk&gt; ') && lunName.includes('Partial image'), lunName)
ok('the LUN row without a mark is just the encoded name', iscsi.renderLunName('a&b', {}, rec({})) === 'a&amp;b')
ok('a hostile LUN name stays text', !iscsi.renderLunName(EVIL, {}, rec({ restoreMark: health.restoreMarks[1] })).includes('<img'))

// --- review2 (4a): the toolbar does not invite Enable while a restore runs -----
function toolbarFor(data) {
  const buttons = {}
  const button = id => (buttons[id] ??= {
    id,
    disabled: null,
    tooltip: '',
    texts: [],
    setDisabled(d) {
      this.disabled = d
    },
    setTooltip(tip) {
      this.tooltip = tip
    },
    setText(x) {
      this.texts.push(x)
    },
    setIconCls() {},
  })
  const grid = { anasInstalled: true, getSelection: () => [rec(data)], down: sel => button(sel.slice(1)) }
  iscsi.updateButtons(grid)
  return button('iscsiToggle')
}
const running = toolbarFor({ iqn: IQN, ownership: 'anas', enabled: false, restoreMark: { state: 'in-progress', detail: 'x' } })
ok('a restore running onto a LUN of a disabled target: Enable is disabled', running.disabled === true, running)
ok('...and says why', /Enable is refused until the restore ends/.test(running.tooltip), running.tooltip)
const interrupted = toolbarFor({ iqn: IQN, ownership: 'anas', enabled: false, restoreMark: { state: 'interrupted', detail: 'x' } })
ok('an interrupted restore: Enable stays available (the daemon asks to confirm)', interrupted.disabled === false && interrupted.tooltip === '', interrupted)
// D-27/P-10: an unknown mark state gates Enable like in-progress — the page
// cannot tell what the state allows, so it says to reload and reads the mark
// again. The daemon stays the authority (its 409 says the same).
const staleMark = toolbarFor({ iqn: IQN, ownership: 'anas', enabled: false, restoreMark: { state: 'extent-gone-quietly', detail: 'x' } })
ok('an unknown mark state: Enable is disabled', staleMark.disabled === true, staleMark)
ok('...and the tip names the state and says to reload the page',
  staleMark.tooltip === `This restore mark carries a state (${ANAS.enc('extent-gone-quietly')}) this page does not know. Reload the page to read it.`, staleMark.tooltip)
const staleMarkOn = toolbarFor({ iqn: IQN, ownership: 'anas', enabled: true, restoreMark: { state: 'extent-gone-quietly', detail: 'x' } })
ok('...and only ENABLE is gated (an enabled target keeps Disable)', staleMarkOn.disabled === false && staleMarkOn.texts.at(-1) === 'Disable', staleMarkOn)
const plain = toolbarFor({ iqn: IQN, ownership: 'anas', enabled: false, restoreMark: null })
ok('no mark: Enable available', plain.disabled === false)
const on = toolbarFor({ iqn: IQN, ownership: 'anas', enabled: true, restoreMark: { state: 'in-progress', detail: 'x' } })
ok('an ENABLED target keeps Disable available', on.disabled === false && on.texts.at(-1) === 'Disable')

// --- Enable: the real confirm path; Disable: a plain job ----------------------
const posts = []
let next = []
ANAS.api = ANAS.api || {}
ANAS.api.post = (node, path, body, reqOpts) => {
  posts.push({ path, body, ...(reqOpts && reqOpts.confirmCode ? { confirm: reqOpts.confirmCode } : {}) })
  const r = next.shift()
  return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
}
ANAS.pollJob = (node, id, opts) => {
  posts.push({ polled: id })
  if (opts.onComplete)
    opts.onComplete({ id })
}
function err409(code, message, warnings, confirmCode) {
  const e = new Error(message)
  e.status = 409
  if (confirmCode)
    e.confirmCode = confirmCode
  e.body = { error: { code, message, warnings } }
  return e
}

shown.length = 0
next = [err409('CONFIRMATION_REQUIRED', `Enabling ${IQN} serves a LUN whose restored image is not verified ${EVIL}`, [`LUN 0 ('${EVIL}'): restore of ${EVIL}`], 'c0de'), { job: { id: 'j1' } }]
iscsi.toggleTarget({}, 'pve1', rec({ iqn: IQN, name: EVIL, enabled: false }))
await settle()
const c = shown.find(s => s.kind === 'confirm')
ok('Enable answered with a confirm code: a confirm is shown', !!c, shown)
ok('its title is true for every mark state (review2 F3: never "partial" for an unverified image)', c?.title === 'Enable a target whose LUN image is not proven complete', c?.title)
ok('the daemon\'s message and warnings are in it, ENCODED', (c?.body ?? '').includes('&lt;img src=x') && !(c?.body ?? '').includes('<img') && !(c?.body ?? '').includes('<script'), c?.body)
c?.cb('yes')
await settle()
const statePath = `/iscsi/targets/${encodeURIComponent(IQN)}/state`
ok('Yes resends the same request with the code, then polls the job', JSON.stringify(posts) === JSON.stringify([
  { path: statePath, body: { action: 'enable' } },
  { path: statePath, body: { action: 'enable' }, confirm: 'c0de' },
  { polled: 'j1' },
]), posts)

shown.length = 0
posts.length = 0
next = [err409('CONFLICT', `A whole-image restore is writing LUN 0 ('${EVIL}') right now`)]
iscsi.toggleTarget({}, 'pve1', rec({ iqn: IQN, name: 'x', enabled: false }))
await settle()
ok('Enable refused outright (a restore running): one failure alert, no confirm', shown.length === 1 && shown[0].kind === 'alert' && shown[0].title === 'State change failed', shown.map(s => s.kind))
ok('...its text encoded', !(shown[0]?.body ?? '').includes('<img'), shown[0]?.body)

shown.length = 0
posts.length = 0
next = [{ job: { id: 'j2' } }]
iscsi.toggleTarget({}, 'pve1', rec({ iqn: IQN, name: 'x', enabled: true }))
await settle()
ok('Disable: a plain job, no dialog', posts.length === 2 && posts[0].body.action === 'disable' && shown.length === 0, { posts, shown })

// --- source checks over the new code (ES5, t()) -----------------------------
const start = SRC.indexOf('// ---- cr3.lunrestore: the restore mark')
const end = SRC.indexOf('function renderAuth(', start)
const block = SRC.slice(start, end)
const tbStart = SRC.indexOf('// review2 D (4a): a whole-image restore writing a LUN')
const toolbar = SRC.slice(tbStart, SRC.indexOf('btnSetTip(grid, \'iscsiDelete\'', tbStart))
for (const [name, code] of [['the mark code', block], ['the toolbar gate', toolbar]]) {
  ok(`${name} is ES5: no arrow functions`, code.length > 0 && !code.includes('=>'))
  ok(`${name} is ES5: no template strings, no let/const`, !code.includes('`') && !/\b(?:let|const)\s/.test(code))
  ok(`no ellipsis character in ${name}`, !code.includes('\u2026'))
}
for (const label of ['Restore running', 'Partial image', 'Image not verified', 'Restore mark unreadable', 'Unknown state'])
  ok(`"${label}" goes through t()`, block.includes(`t('${label}')`))
ok('the toolbar\'s reason goes through t()', toolbar.includes('t(\'A whole-image restore is writing a LUN of this target; Enable is refused until the restore ends\')'))
ok('the unknown-state Enable tip goes through t() (D-27)', toolbar.includes('t(\'This restore mark carries a state\')') && toolbar.includes('t(\'this page does not know. Reload the page to read it.\')'))

if (failed) {
  console.error(`${failed} cr3.lunrestore panel check(s) FAILED`)
  process.exit(1)
}
console.log('ok — cr3.lunrestore panel checks passed')
