#!/usr/bin/env node
/*
 * ANAS — cr3.iscsi panel harness (the 2026-11-14 review, 75-iscsi.js).
 *
 * Loads the REAL 75-iscsi.js in a vm sandbox with a stub ANAS and checks the
 * panel halves of the cr3 iSCSI fixes:
 *
 *   - an unreadable session renders UNKNOWN, never "0 sessions" / "none", and
 *     an in-place restore is refused on it (sessionCount, cross-cutting sweep);
 *   - the LUN window's backup menu encodes the task name and hands the backup
 *     dialog the task NAME, never the task object cached at open;
 *   - a backing-choices read that fails is SAID in the dialog, with its reason;
 *   - every window title built from data, and every combo whose rows carry
 *     node text, encodes it (a source sweep, so a new one cannot slip in).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_PATH = join(HERE, '..', 'src', '75-iscsi.js')
const SRC = readFileSync(SRC_PATH, 'utf8')

function htmlEncode(s) {
  return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const warnings = []
const editCalls = []
let routes = {}

const ANAS = {
  views: {},
  t: s => s,
  enc: htmlEncode,
  warn: m => warnings.push(m),
  errText: e => (e && e.message) ? e.message : String(e),
  // The real helper (00-core.js): a value outside the known set is null.
  knownEnum(value, known) {
    if (value === undefined || value === null || value === '')
      return null
    const v = '' + value
    return (known && Object.prototype.hasOwnProperty.call(known, v)) ? v : null
  },
  formatBytes: v => `${v} B`,
  api: {
    get(_node, path) {
      const r = routes[path]
      if (r instanceof Error)
        return Promise.reject(r)
      return Promise.resolve(r === undefined ? { data: [] } : r)
    },
  },
  // The shared PVE-ownership helper (10-api.js), reduced to "nothing is PVE's".
  pve: { storagesOf: () => [], isOwned: () => false, ownership: () => null },
  backup: {
    openEditTask(view, node, task, onDone) { editCalls.push({ view, node, task, onDone }) },
    runTaskNow() {},
  },
}

// The panel keeps repairableHoles and servedStubs private; publish both on the
// test copy only, so the cases below call the real functions. (SRC itself stays
// verbatim for the source sweeps.)
const TEST_SRC = SRC.replace(
  'ANAS.iscsi.applyHealth = applyHealth;',
  'ANAS.iscsi.applyHealth = applyHealth; ANAS.iscsi.repairableHoles = repairableHoles; ANAS.iscsi.servedStubs = servedStubs;',
)
if (TEST_SRC === SRC)
  throw new Error('cr3-iscsi harness: the export seam did not match 75-iscsi.js')

const sandbox = { window: { ANAS }, console, Ext: { create: () => ({}) } }
vm.createContext(sandbox)
vm.runInContext(TEST_SRC, sandbox, { filename: '75-iscsi.js' })
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
  for (let i = 0; i < 8; i++)
    await new Promise(r => setImmediate(r))
}

// --- sessionCount: unknown is never "none" ----------------------------------

{
  const unknown = iscsi.renderSessions(0, {}, rec({ sessionsUnknown: true }))
  ok('sessions: an unreadable session renders unknown', /unknown/.test(unknown), unknown)
  ok('sessions: and never "0 sessions"', !/0 sessions/.test(unknown), unknown)
  const none = iscsi.renderSessions(0, {}, rec({}))
  ok('sessions: a readable none still renders 0 sessions', /0 sessions/.test(none), none)

  const lunUnknown = iscsi.renderLunSessions([], {}, rec({ connectedInitiatorsUnknown: true }))
  ok('LUN sessions: unknown, never "none"', /unknown/.test(lunUnknown) && !/none/.test(lunUnknown), lunUnknown)

  const verdict = iscsi.lunInPlace({ kind: 'zvol', connectedInitiators: [], connectedInitiatorsUnknown: true, backingExists: true, size: 1024 })
  ok('in-place restore: refused on an unreadable session', verdict.allowed === false, verdict)
  const fine = iscsi.lunInPlace({ kind: 'zvol', connectedInitiators: [], backingExists: true, size: 1024 })
  ok('in-place restore: allowed when every session read', fine.allowed === true, fine)
}

// --- the LUN window's backup menu ------------------------------------------

{
  const evil = '<img src=x onerror=1>'
  const lunRec = rec({ index: 0, backingPath: '/dev/zvol/tank/vol1', serial: 's1' })
  const win = {
    anasIqn: 'iqn.2026-11.nas.anas:vmstore',
    anasNode: 'n1',
    anasView: 'view',
    anasBackupTasks: [{ task: { name: evil, archives: [{ kind: 'img', path: '/dev/zvol/tank/vol1' }] } }],
    down: sel => (sel === '#lunsGrid' ? { getSelection: () => [lunRec] } : null),
  }
  const items = iscsi.lunBackupMenuItems(win)
  ok('backup menu: the task name in a menu item is encoded', items.length === 2 && items.every(i => !i.text.includes('<img')), items.map(i => i.text))
  items[1].handler()
  ok('backup menu: Edit hands the backup dialog the task object, by its name (the dialog re-reads it)',
    editCalls.length === 1 && editCalls[0].task && editCalls[0].task.name === evil, editCalls.map(c => typeof c.task))
}

// --- backing choices: a failed read is said, with its reason ---------------

{
  const note = { html: null, hidden: true, update(h) { this.html = h }, setHidden(v) { this.hidden = v } }
  const pickers = {}
  const field = id => (pickers[id] ??= { id, emptyText: '', setStore() {}, setEmptyText(t) { this.emptyText = t } })
  const win = {
    destroyed: false,
    down: sel => (sel === '#backingChoicesNote' ? note : (sel === '#zvolPicker' || sel === '#filePicker') ? field(sel) : null),
  }
  routes = { '/pools': new Error('500 <b>daemon</b> down') }
  iscsi.loadBackingChoices('n1', win)
  await settle()
  ok('choices: the note is shown', note.hidden === false, note)
  ok('choices: it names the read and the reason, encoded', /pools/.test(note.html || '') && /&lt;b&gt;daemon/.test(note.html || ''), note.html)
  ok('choices: each picker says it could not read its choices', /could not read the choices/.test(field('#zvolPicker').emptyText), field('#zvolPicker').emptyText)

  // One pool's datasets and the AHR read fail; the pools read answered.
  const note2 = { html: null, hidden: true, update(h) { this.html = h }, setHidden(v) { this.hidden = v } }
  const win2 = { destroyed: false, down: sel => (sel === '#backingChoicesNote' ? note2 : null) }
  routes = { '/pools': { data: [{ name: 'tank' }] }, '/pools/tank/datasets': new Error('timeout'), '/ahr': new Error('ahr unreadable') }
  iscsi.loadBackingChoices('n1', win2)
  await settle()
  ok('choices: a pool whose datasets did not read is named', /datasets of pool tank \(timeout\)/.test(note2.html || ''), note2.html)
  ok('choices: an AHR read that failed is named', /AHR pools \(ahr unreadable\)/.test(note2.html || ''), note2.html)

  // All reads answer: the note stays hidden.
  const note3 = { html: null, hidden: true, update(h) { this.html = h }, setHidden(v) { this.hidden = v } }
  routes = { '/pools': { data: [] }, '/ahr': { data: [] } }
  iscsi.loadBackingChoices('n1', { destroyed: false, down: sel => (sel === '#backingChoicesNote' ? note3 : null) })
  await settle()
  ok('choices: every read answered — no note', note3.hidden === true && note3.html === null, note3)
}

// --- the Repair button's tip: a failed read is never "nothing to repair" -----

{
  const btn = { disabled: false, tooltip: '', setDisabled(v) { this.disabled = v }, setTooltip(v) { this.tooltip = v } }
  const grid = { anasInstalled: true, down: sel => (sel === '#iscsiRepair' ? btn : null) }
  const view = { down: sel => (sel === '#iscsiGrid' ? grid : null) }
  iscsi.applyHealth(view, null, 'HTTP 500')
  ok('repair tip: a failed health read says so, with the reason', /could not be read \(HTTP 500\)/.test(btn.tooltip), btn.tooltip)
  ok('repair tip: and never claims the configurations match', !/matches the saved one/.test(btn.tooltip), btn.tooltip)
  iscsi.applyHealth(view, { missingLuns: [], stubLuns: [], saveconfigUnreadable: '/etc/x is not valid JSON' })
  ok('repair tip: an unreadable saveconfig.json is named (ISCSI-L15)', /cannot be read: \/etc\/x is not valid JSON/.test(btn.tooltip), btn.tooltip)
  iscsi.applyHealth(view, { missingLuns: [], stubLuns: [] })
  ok('repair tip: a clean read still says nothing to repair', /Nothing to repair/.test(btn.tooltip), btn.tooltip)
  // A foreign hole: the daemon's verdict, printed as its advice — the page
  // frames nothing itself.
  const FOREIGN = 'LUN 0 of iqn.2003-01.x:t is missing from a target ANAS does not manage. ANAS never writes to a target '
    + 'it does not own, so Repair leaves it alone. Restore it by hand: bring the backing device back, then run '
    + '\'systemctl restart rtslib-fb-targetctl\' in a maintenance window.'
  iscsi.applyHealth(view, { missingLuns: [{ targetIqn: 'iqn.2003-01.x:t', lunIndex: 0, backingExists: true, targetOwnership: 'foreign', repair: { state: 'foreign-target', detail: FOREIGN, advice: FOREIGN } }], stubLuns: [] })
  ok('repair (ISCSI-L7): a foreign hole never makes Repair live', btn.disabled === true, btn)
  ok('repair (ISCSI-L7): the tip names it and the hand restore', /LUN 0 of iqn\.2003-01\.x:t/.test(btn.tooltip) && /maintenance window/.test(btn.tooltip), btn.tooltip)
  ok('repair (ISCSI-L7): one missing LUN reads in the singular', /Repair cannot put back the missing LUN\./.test(btn.tooltip), btn.tooltip)
  const FOREIGN_U = 'LUN 2 of iqn.2003-01.x:u is missing from a target ANAS does not manage.'
  iscsi.applyHealth(view, { missingLuns: [
    { targetIqn: 'iqn.2003-01.x:t', lunIndex: 0, backingExists: true, targetOwnership: 'foreign', repair: { state: 'foreign-target', detail: FOREIGN, advice: FOREIGN } },
    { targetIqn: 'iqn.2003-01.x:u', lunIndex: 2, backingExists: false, targetOwnership: 'foreign', repair: { state: 'foreign-target', detail: FOREIGN_U, advice: FOREIGN_U } },
  ], stubLuns: [] })
  ok('repair (review 2, L7): several LUNs read in the plural', /Repair cannot put back any of the 2 missing LUNs\./.test(btn.tooltip), btn.tooltip)
}

// --- the Repair button reads the hole's verdict ------------------------------
//
// own.4 (c): the daemon decides whether Repair can put a hole back and says
// why in `repair.advice`; the panel is a reader. Nothing below may derive
// readiness from backingExists or ownership.

{
  const STATES = ['ready', 'foreign-target', 'target-hands-off', 'record-incomplete', 'placeholder', 'backing-absent',
    'backing-unreadable', 'backstore-live', 'device-served-elsewhere', 'restore-mark']
  const IQN = 'iqn.2026-08.nas.anas:t'
  const hole = over => Object.assign({
    targetIqn: IQN,
    tpgTag: 1,
    lunIndex: 0,
    backstoreName: 'v1',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/v1',
    backingExists: true,
    targetOwnership: 'anas',
  }, over)
  function button() {
    const btn = { disabled: false, tooltip: '', setDisabled(v) { this.disabled = v }, setTooltip(v) { this.tooltip = v } }
    const grid = { anasInstalled: true, down: sel => (sel === '#iscsiRepair' ? btn : null) }
    const view = { down: sel => (sel === '#iscsiGrid' ? grid : null) }
    return { btn, apply: (health, err) => iscsi.applyHealth(view, health, err) }
  }
  const READY_ADVICE = 'That path is available again — use Repair on the iSCSI screen to put the LUN back.'
  const READY_TIP = '1 LUN can be put back now — the same serial and attributes are replayed, so the initiator sees the same disk.'

  // (i) one ready hole: live, with today's sentence.
  {
    const health = { missingLuns: [hole({ repair: { state: 'ready', detail: READY_ADVICE, advice: READY_ADVICE } })], stubLuns: [] }
    ok('verdict (i): a ready hole is repair-able', iscsi.repairableHoles(health).length === 1, iscsi.repairableHoles(health))
    const b = button()
    b.apply(health)
    ok('verdict (i): the button is live', b.btn.disabled === false, b.btn)
    ok('verdict (i): the tooltip is the can-be-put-back sentence', b.btn.tooltip === READY_TIP, b.btn.tooltip)
  }

  // (ii) every other state, in the shape today's rule wrongly calls ready.
  for (const state of STATES.filter(s => s !== 'ready')) {
    const advice = `advice for ${state}`
    const health = { missingLuns: [hole({ repair: { state, detail: `detail for ${state}`, advice } })], stubLuns: [] }
    ok(`verdict (ii): ${state} is never repair-able`, iscsi.repairableHoles(health).length === 0, iscsi.repairableHoles(health))
    const b = button()
    b.apply(health)
    ok(`verdict (ii): ${state} leaves the button disabled`, b.btn.disabled === true, b.btn)
    ok(`verdict (ii): ${state} is named with its advice in the tooltip`,
      b.btn.tooltip.indexOf(`LUN 0 of ${IQN} (/dev/zvol/tank/v1): ${advice}`) !== -1, b.btn.tooltip)
  }

  // (iii) a ready hole and a refused one: the button is live and both are said.
  {
    const health = { missingLuns: [
      hole({ lunIndex: 0, repair: { state: 'ready', detail: READY_ADVICE, advice: READY_ADVICE } }),
      hole({ lunIndex: 1, repair: { state: 'backstore-live', detail: 'detail', advice: 'advice for backstore-live' } }),
    ], stubLuns: [] }
    const b = button()
    b.apply(health)
    ok('verdict (iii): one ready hole keeps the button live', b.btn.disabled === false, b.btn)
    ok('verdict (iii): the ready sentence is there', b.btn.tooltip.indexOf(READY_TIP) === 0, b.btn.tooltip)
    ok('verdict (iii): the other LUN is named with its advice',
      b.btn.tooltip.indexOf(`1 other cannot be put back: LUN 1 of ${IQN} (/dev/zvol/tank/v1): advice for backstore-live`) !== -1, b.btn.tooltip)
  }

  // (iv) an older daemon: no verdict at all, or one whose sentence is missing.
  {
    for (const repair of [undefined, { state: 'backing-absent', detail: 'That path is still missing.' }]) {
      const health = { missingLuns: [hole(repair ? { repair } : {})], stubLuns: [] }
      const b = button()
      b.apply(health)
      ok('verdict (iv): a hole with no sentence leaves the button disabled', b.btn.disabled === true, b.btn)
      ok('verdict (iv): the tooltip says the node did not say',
        b.btn.tooltip.indexOf(`LUN 0 of ${IQN} (/dev/zvol/tank/v1): this node did not say whether Repair can put it back.`) !== -1, b.btn.tooltip)
    }
  }

  // (v) a state this page does not know is never ready, and its sentence is shown.
  {
    const health = { missingLuns: [hole({ repair: { state: 'some-future-state', detail: 'd', advice: 'advice from a newer daemon' } })], stubLuns: [] }
    ok('verdict (v): an unknown state is never repair-able', iscsi.repairableHoles(health).length === 0, iscsi.repairableHoles(health))
    const b = button()
    b.apply(health)
    ok('verdict (v): unknown state leaves the button disabled', b.btn.disabled === true, b.btn)
    ok('verdict (v): its advice is still shown', b.btn.tooltip.indexOf('advice from a newer daemon') !== -1, b.btn.tooltip)
  }

  // (vi) a served placeholder counts only when the daemon says it is zero-size.
  {
    const stub = over => Object.assign({ targetIqn: IQN, tpgTag: 1, lunIndex: 3, backstoreName: 'p', plugin: 'fileio', backingPath: '/p', ownership: 'anas', quarantined: false }, over)
    const absentFlag = iscsi.servedStubs({ stubLuns: [stub({}), stub({ zeroSized: false })] })
    ok('verdict (vi): zeroSized absent or false is not counted', absentFlag.length === 0, absentFlag)
    const zero = iscsi.servedStubs({ stubLuns: [stub({ zeroSized: true }), stub({ zeroSized: true, ownership: 'foreign' })] })
    ok('verdict (vi): a zero-size ANAS stub is counted, a foreign one is not', zero.length === 1, zero)
  }

  // (vii) the branches before the hole list are what they were.
  {
    const b = button()
    b.apply(null, 'HTTP 500')
    ok('verdict (vii): an unreadable health read still says so', /could not be read \(HTTP 500\)/.test(b.btn.tooltip), b.btn.tooltip)
    b.apply({ missingLuns: [hole({ repair: { state: 'ready', detail: READY_ADVICE, advice: READY_ADVICE } })], stubLuns: [], saveconfigUnreadable: '/etc/x' })
    ok('verdict (vii): an unreadable saveconfig still wins', /cannot be read: \/etc\/x/.test(b.btn.tooltip), b.btn.tooltip)
    b.apply({ missingLuns: [hole({ repair: { state: 'ready', detail: READY_ADVICE, advice: READY_ADVICE } })], stubLuns: [{ targetIqn: IQN, lunIndex: 3, ownership: 'anas', quarantined: false, zeroSized: true }] })
    ok('verdict (vii): a served placeholder still wins', /serving a placeholder/.test(b.btn.tooltip), b.btn.tooltip)
    b.apply({ missingLuns: [], stubLuns: [] })
    ok('verdict (vii): nothing missing still says nothing to repair', /Nothing to repair/.test(b.btn.tooltip), b.btn.tooltip)
  }
}

// --- source sweeps ----------------------------------------------------------

{
  // Every window title concatenated with a value encodes it.
  const titles = [...SRC.matchAll(/^\s*title:\s*(.+)$/gm)].map(m => m[1]).filter(l => l.includes('+'))
  // A title whose only value is a row number (`'Initiator ' + (index + 1)`) is no data.
  const bare = titles.filter(l => !/\benc\(/.test(l) && !/^t\('[^']*'\) \+ ' ' \+ \(index \+ 1\),$/.test(l.trim()))
  ok('titles: every title built from data encodes it', titles.length > 0 && bare.length === 0, bare)

  // Every combobox whose rows are node text encodes its list. The constant
  // lists (size units, block sizes) are named and exempt.
  const CONSTANT = new Set(['unit', 'blockSize'])
  const combos = [...SRC.matchAll(/xtype: 'combobox',([\s\S]*?)\n\s{0,40}\}/g)].map(m => m[1])
  const rows = combos.map(body => ({
    itemId: (body.match(/itemId: '([^']+)'/) || [])[1],
    encoded: /listConfig: encodedList\(\)/.test(body),
  }))
  const missing = rows.filter(r => !CONSTANT.has(r.itemId) && !r.encoded)
  ok('combos: every node-text combo has an encoding list template', rows.length >= 5 && missing.length === 0, { rows, missing })

  // Tooltips carry data (ownership derivations name paths): encoded at the sink.
  const tipFn = SRC.slice(SRC.indexOf('function btnSetTip'), SRC.indexOf('function btnSetTip') + 600)
  ok('tooltips: btnSetTip encodes what it sets', /enc\(msg\)/.test(tipFn), tipFn)
  ok('menus: no menu item text concatenates a raw entry name', !/text: t\([^)]*\) \+ entry\.name/.test(SRC))
}

// The one console warning is the failed pools read the choices check forced.
ok('nothing else warned', warnings.length === 1 && /backing choices failed/.test(warnings[0]), warnings)

if (failed) {
  console.error(`\n✖ ${failed} cr3-iscsi check(s) failed`)
  process.exitCode = 1
}
else {
  console.log('\n✔ cr3-iscsi panel checks passed')
}
