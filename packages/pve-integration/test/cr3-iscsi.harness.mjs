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

const sandbox = { window: { ANAS }, console, Ext: { create: () => ({}) } }
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox, { filename: '75-iscsi.js' })
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
  iscsi.applyHealth(view, { missingLuns: [{ targetIqn: 'iqn.2003-01.x:t', lunIndex: 0, backingExists: true, targetOwnership: 'foreign' }], stubLuns: [] })
  ok('repair (ISCSI-L7): a foreign hole never makes Repair live', btn.disabled === true, btn)
  ok('repair (ISCSI-L7): the tip names it and the hand restore', /LUN 0 of iqn\.2003-01\.x:t/.test(btn.tooltip) && /maintenance window/.test(btn.tooltip), btn.tooltip)
  ok('repair (ISCSI-L7): one LUN reads in the singular', /is missing from a target ANAS does not manage/.test(btn.tooltip), btn.tooltip)
  iscsi.applyHealth(view, { missingLuns: [
    { targetIqn: 'iqn.2003-01.x:t', lunIndex: 0, backingExists: true, targetOwnership: 'foreign' },
    { targetIqn: 'iqn.2003-01.x:u', lunIndex: 2, backingExists: false, targetOwnership: 'foreign' },
  ], stubLuns: [] })
  ok('repair (review 2, L7): several LUNs read in the plural', /are missing from targets ANAS does not manage — Repair never writes to them\. Bring their backing devices back/.test(btn.tooltip), btn.tooltip)
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
