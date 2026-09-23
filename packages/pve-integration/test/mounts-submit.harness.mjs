#!/usr/bin/env node
/*
 * ANAS — Mounts edit-dialog submit harness.
 *
 * The Mounts wizard is ES5 browser code inside PVE's ExtJS bundle, so this
 * harness stubs the surface 67-mounts.js touches (Ext.create for the window and
 * stores, an ANAS.api that answers /mounts/:mp and the identity lists, a
 * runJob that captures the request body) and drives the REAL dialog: open the
 * edit window on a record, let it populate from the detail, then blank fields
 * and press Save.
 *
 * What it proves — the three mounts-family contract bugs whose UI half lives
 * here:
 *
 *   #34 the CLEAR contract — every value-bearing option travels on every save,
 *       and a BLANKED pre-filled field arrives as null (remove), not as an
 *       omission (which the daemon can only read as "keep");
 *   #43 item 3 — an untouched edit sends exactly what the entry carries: no
 *       field-config default (vers, file_mode, dir_mode, idle-timeout) leaks
 *       onto an entry that never had it;
 *   #38 — Server and Export path/Share name are read-only on an edit, and Test
 *       connection probes the STORED spec, never an edited value the save would
 *       drop;
 *   (2026-09-22 bug) — the typed Server/Share normalise on blur (the browser
 *       port of packages/shared/src/mount-target.ts), the Test button arms
 *       only once the target is testable (server; share for CIFS), the new
 *       `invalid` verdict renders, and an UNKNOWN verdict never claims
 *       "no route to the server".
 *
 *   node packages/pve-integration/test/mounts-submit.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

// ---- Fixture: the mount being edited ----------------------------------------
//
// A CIFS share that carries SOME options and pointedly lacks others: no
// file_mode, no dir_mode, no iocharset, no domain. Those are exactly the fields
// whose config defaults used to ride an untouched save into the fstab line.

const MOUNTPOINT = '/mnt/idle-cifs'
const DETAIL = {
  mountpoint: MOUNTPOINT,
  type: 'cifs',
  fstype: 'cifs',
  source: '//nas.example.com/media',
  server: 'nas.example.com',
  remotePath: 'media',
  state: 'armed',
  mounted: false,
  persistent: true,
  remote: true,
  automount: true,
  disabled: false,
  pveManaged: false,
  ahrManaged: false,
  readOnly: false,
  health: { state: 'armed' },
  warnings: [],
  credentials: { set: true, username: 'smbuser' },
  configuredOptions: {
    common: {
      readOnly: false,
      nofail: true,
      noauto: false,
      automount: true,
      automountIdleTimeout: 60,
      noatime: false,
      nosuid: true,
      nodev: true,
      noexec: false,
      netdev: true,
    },
    cifs: { vers: '3.0', cache: 'strict', uid: 1000 },
    passthrough: 'x-anas-note=keepme',
  },
}

const GRID_RECORD = {
  mountpoint: MOUNTPOINT,
  type: 'cifs',
  source: '//nas.example.com/media',
  remote: true,
  persistent: true,
  automount: true,
}

// ---- The Ext stub -----------------------------------------------------------

const failures = []
function check(ok, what) {
  if (!ok) {
    failures.push(what)
  }
}

function isField(xtype) {
  return xtype === 'textfield' || xtype === 'numberfield' || xtype === 'combobox'
    || xtype === 'checkboxfield' || xtype === 'radiogroup'
}

function initialValue(cfg) {
  if (cfg.xtype === 'checkboxfield') { return !!cfg.checked }
  if (cfg.xtype === 'radiogroup') {
    const out = {}
    for (const item of cfg.items || []) {
      if (item.checked) { out[item.name] = item.inputValue }
    }
    return out
  }
  if (cfg.value !== undefined) { return cfg.value }
  return cfg.xtype === 'numberfield' ? null : ''
}

// One component: a field when it has a field xtype, an inert box otherwise.
function makeCmp(cfg, win) {
  const cmp = {
    itemId: cfg.itemId,
    xtype: cfg.xtype || 'component',
    isField: isField(cfg.xtype),
    readOnly: !!cfg.readOnly,
    disabled: !!cfg.disabled,
    hidden: !!cfg.hidden,
    fieldLabel: cfg.fieldLabel,
    html: cfg.html || '',
    _value: initialValue(cfg),
    _handlers: {},
    up: () => win,
    down: () => null,
    on(evt, fn) { (this._handlers[evt] = this._handlers[evt] || []).push(fn) },
    /** Fire a component event (the dialog wires change AND blur). */
    fire(evt) { for (const fn of (this._handlers[evt] || []).slice()) { fn(this, this.getValue()) } },
    update(html) { this.html = html },
    setHidden(v) { this.hidden = !!v },
    setDisabled(v) { this.disabled = !!v },
    setFieldLabel(v) { this.fieldLabel = v },
    getValue() {
      if (this.xtype === 'checkboxfield') { return !!this._value }
      if (this.xtype === 'radiogroup') { return this._value }
      if (this.xtype === 'numberfield') {
        return (this._value === '' || this._value === null || this._value === undefined)
          ? null
          : Number(this._value)
      }
      return (this._value === null || this._value === undefined) ? '' : this._value
    },
    setValue(v) {
      if (this.xtype === 'checkboxfield') { this._value = !!v }
      else if (this.xtype === 'radiogroup') { this._value = v || {} }
      else { this._value = v }
      this.fire('change')
      return this
    },
  }
  return cmp
}

// Walk a window config into a flat itemId → component map (fieldsets nest).
function collect(items, win, out, fields, all) {
  for (const cfg of items || []) {
    const cmp = makeCmp(cfg, win)
    cmp.cls = cfg.cls || ''
    cmp.handler = cfg.handler
    all.push(cmp)
    if (cfg.itemId) { out[cfg.itemId] = cmp }
    if (cmp.isField) { fields.push(cmp) }
    collect(cfg.items, win, out, fields, all)
  }
}

function makeWindow(cfg) {
  const byId = {}
  const fields = []
  const all = []
  const win = {
    destroyed: false,
    destroying: false,
    title: cfg.title,
    _shown: false,
    _all: all,
    show() { this._shown = true },
    close() { this.destroyed = true },
    down(sel) { return byId[String(sel).replace('#', '')] || null },
    up: () => null,
    byCls(cls) { return all.find(c => String(c.cls).indexOf(cls) !== -1) || null },
  }
  collect(cfg.items, win, byId, fields, all)
  for (const b of cfg.buttons || []) {
    const cmp = makeCmp(b, win)
    cmp.handler = b.handler
    cmp.text = b.text
    if (b.itemId) { byId[b.itemId] = cmp }
    if (b.text === 'Save' || b.text === 'Add') { win._submit = cmp }
  }
  // The form panel: the dialog asks it for validity and for every field.
  byId.form = {
    itemId: 'form',
    getForm: () => ({ isValid: () => true }),
    query: () => fields,
    up: () => win,
    on() {},
  }
  win._fields = byId
  return win
}

function makeStore() {
  return {
    destroyed: false,
    data: [],
    loadData(rows) { this.data = rows },
    getCount() { return this.data.length },
  }
}

// ---- The ANAS stub ----------------------------------------------------------

const captured = { jobs: [], posts: [], alerts: [] }

// Queued responses for POST /mounts/test (shifted one per test post; the
// default — an `ok` verdict — applies when the queue is empty).
const testResponses = []

/** The real autofill opt-out from 00-core.js — the credential tier reads it
 * while building its fields, so the fake must mirror it. */
const noAutofill = (() => {
  const sandbox = { window: {} }
  vm.runInNewContext(readFileSync(join(SRC, '00-core.js'), 'utf8'), sandbox, { filename: '00-core.js' })
  return sandbox.window.ANAS.noAutofill
})()

function loadUi() {
  const doc = {
    cookie: '',
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  }
  const win = { document: doc }
  win.ANAS = {
    views: {},
    noAutofill,
    t: s => s,
    enc: s => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    formatBytes: b => `${b}`,
    warn(m) { failures.push(`view warned: ${m}`) },
    errText: e => String((e && e.message) || e),
    errorPanel: m => ({ html: m }),
    tbar: items => ({ xtype: 'toolbar', items }), // real 00-core.js helper
    warningsHtml: w => String(w),
    // Recorded, not failed, HERE: the negative tests consume the alert they
    // expect. Anything still in captured.alerts at the report is unexpected.
    alertMsg(title, msg) { captured.alerts.push({ title, msg }) },
    fmtMode: () => ({ valid: true, symbolic: 'rw-r--r--', gloss: '' }),
    api: {
      get(_node, path) {
        if (path === '/identity/users') { return Promise.resolve({ data: [{ name: 'smbuser', uid: 1000 }] }) }
        if (path === '/identity/groups') { return Promise.resolve({ data: [{ name: 'users', gid: 100 }] }) }
        if (path === `/mounts/${encodeURIComponent(MOUNTPOINT)}`) { return Promise.resolve({ data: DETAIL }) }
        if (path === '/mounts') { return Promise.resolve({ data: [GRID_RECORD] }) }
        return Promise.reject(new Error(`unexpected GET ${path}`))
      },
      post(_node, path, body) {
        captured.posts.push({ path, body })
        if (path === '/mounts/test' && testResponses.length > 0) {
          return Promise.resolve(testResponses.shift())
        }
        return Promise.resolve({ data: { verdict: 'ok' } })
      },
    },
    runJob(opts) { captured.jobs.push(opts) },
  }
  const sandbox = {
    window: win,
    document: doc,
    console,
    Promise,
    Date,
    setInterval: () => 1,
    clearInterval: () => {},
    Ext: {
      create(xclass, cfg) {
        if (xclass === 'Ext.data.Store') { return makeStore() }
        if (xclass === 'Ext.window.Window') {
          const w = makeWindow(cfg)
          captured.window = w
          return w
        }
        throw new Error(`unexpected Ext.create(${xclass})`)
      },
      Msg: { alert() {} },
    },
  }
  vm.runInNewContext(readFileSync(join(SRC, '67-mounts.js'), 'utf8'), sandbox, { filename: '67-mounts.js' })
  return win.ANAS
}

const ANAS = loadUi()

// ---- Driving the dialog -----------------------------------------------------

// A view stand-in whose grid holds exactly one selected record.
function makeView() {
  const record = {
    data: GRID_RECORD,
    get(k) { return GRID_RECORD[k] },
    getData() { return GRID_RECORD },
  }
  const grid = {
    getSelection: () => [record],
    up: () => view,
    down: () => null,
    getStore: () => makeStore(),
  }
  const view = {
    destroyed: false,
    destroying: false,
    down: sel => (sel === '#mountsGrid' ? grid : { update() {}, setHtml() {} }),
    up: () => null,
    isVisible: () => true,
  }
  return view
}

function toolbarButton(cfg, text) {
  const grid = cfg.items[0]
  // ANAS.tbar wraps the tbar in a toolbar config object — accept both shapes.
  const tbar = Array.isArray(grid.tbar) ? grid.tbar : (grid.tbar && grid.tbar.items) || []
  return tbar.find(b => b && b.text === text)
}

const flush = () => new Promise(resolve => setImmediate(resolve))

async function openDialog(text) {
  const view = makeView()
  const cfg = ANAS.views.mounts.factory('node1')
  const btn = toolbarButton(cfg, text)
  check(!!btn, `toolbar button '${text}' exists`)
  btn.handler({ up: () => view })
  await flush()
  await flush()
  await flush()
  return captured.window
}

function submit(win) {
  captured.jobs.length = 0
  win._submit.handler()
  return captured.jobs[0]
}

// ---- 1. EDIT: identity is read-only, Test probes the stored spec (#38) ------

const edit = await openDialog('Edit')
check(!!edit, 'the edit window opened')
check(edit.down('#server').readOnly === true, '#38 Server is read-only on an edit')
check(edit.down('#remotePath').readOnly === true, '#38 Export path / Share name is read-only on an edit')
check(edit.down('#mountpoint').readOnly === true, 'the mountpoint stays read-only (unchanged)')
check(edit.down('#type').disabled === true, 'the protocol stays fixed (unchanged)')
check(edit.down('#server').getValue() === 'nas.example.com', 'Server pre-fills from the stored spec')
check(edit.down('#remotePath').getValue() === 'media', 'Share name pre-fills from the stored spec')

// Even with another value forced into the field, the diagnosis follows the
// STORED spec — the save cannot move the mount, so neither may the test.
edit.down('#server').setValue('someone-elses-nas')
edit.down('#remotePath').setValue('someone-elses-share')
captured.posts.length = 0
const testButton = edit.byCls('anas-btn-mount-testconn')
check(!!testButton, 'the Test connection button exists')
testButton.handler()
await flush()
const testPost = captured.posts.find(p => p.path === '/mounts/test')
check(!!testPost, 'Test connection posts /mounts/test')
check(testPost && testPost.body.server === 'nas.example.com', `#38 Test probes the STORED server (got ${testPost && testPost.body.server})`)
check(testPost && testPost.body.remotePath === 'media', `#38 Test probes the STORED share (got ${testPost && testPost.body.remotePath})`)

// ---- 2. EDIT: an UNTOUCHED save writes no unshown default (#43 item 3) -----

// Put the forced values back so this reads a genuinely untouched dialog.
edit.down('#server').setValue('nas.example.com')
edit.down('#remotePath').setValue('media')
const untouched = submit(edit)
check(!!untouched, 'an untouched Save fires a job')
const uo = (untouched && untouched.body && untouched.body.options) || {}
check(uo.vers === '3.0', `vers rides the entry's own value (got ${JSON.stringify(uo.vers)})`)
check(uo.cache === 'strict', 'cache rides the stored value')
check(uo.uid === 1000, 'uid rides the stored value')
check(uo.fileMode === null, `an entry with no file_mode sends null, not 0644 (got ${JSON.stringify(uo.fileMode)})`)
check(uo.dirMode === null, `an entry with no dir_mode sends null, not 0755 (got ${JSON.stringify(uo.dirMode)})`)
check(uo.iocharset === null, 'an entry with no iocharset sends null')
check(uo.domain === null, 'an entry with no domain sends null')
check(uo.idleTimeout === 60, 'the stored idle timeout rides unchanged')
check(untouched && untouched.body.extraOptions === 'x-anas-note=keepme', 'the passthrough round-trips verbatim')
check(untouched && untouched.body.persistent === undefined, 'persistence is not sent on an edit (#27)')
check(untouched && untouched.body.credentials === undefined, 'no credential rotation without a typed password')

// Every value-bearing CIFS option is PRESENT in the body — the clear contract
// only works if the field always travels.
for (const key of ['vers', 'cache', 'domain', 'uid', 'gid', 'fileMode', 'dirMode', 'sec', 'rsize', 'wsize', 'actimeo', 'iocharset', 'idleTimeout']) {
  check(Object.prototype.hasOwnProperty.call(uo, key), `#34 '${key}' is always present in the save body`)
}

// ---- 3. EDIT: a BLANKED field clears (#34) ----------------------------------

const edit2 = await openDialog('Edit')
edit2.down('#optIdle').setValue(null) // blank the pre-filled idle timeout
edit2.down('#cifsVers').setValue('') // blank the pre-filled SMB version
edit2.down('#cifsCache').setValue('') // blank the pre-filled cache mode
edit2.down('#cifsUid').setValue(null) // blank the pre-filled owner
edit2.down('#extraOptions').setValue('') // blank the passthrough
const cleared = submit(edit2)
const co = (cleared && cleared.body && cleared.body.options) || {}
check(co.idleTimeout === null, `#34 a blanked idle timeout sends null (got ${JSON.stringify(co.idleTimeout)})`)
check(co.vers === null, `#34 a blanked SMB version sends null (got ${JSON.stringify(co.vers)})`)
check(co.cache === null, '#34 a blanked cache sends null')
check(co.uid === null, '#34 a blanked owner sends null')
check(cleared && cleared.body.extraOptions === '', '#34 a blanked passthrough is sent (empty), never omitted')
check(Object.prototype.hasOwnProperty.call(co, 'idleTimeout'), '#34 the blanked field is PRESENT (null), not omitted')

// ---- 4. CREATE: the visible defaults are still written ----------------------

const add = await openDialog('Add Remote Share…')
check(add.down('#server').readOnly === false, 'Server stays editable on a create')
check(add.down('#remotePath').readOnly === false, 'Export path stays editable on a create')
add.down('#server').setValue('nas.example.com')
add.down('#remotePath').setValue('/srv/export1')
add.down('#mountpoint').setValue('/mnt/new-share')
const created = submit(add)
const ao = (created && created.body && created.body.options) || {}
check(created && created.body.type === 'nfs', 'the create dialog defaults to NFS')
check(ao.vers === '4.2', `a create still writes the version the dialog SHOWS (got ${JSON.stringify(ao.vers)})`)
check(ao.hard === true, 'a create still writes the hard mount it shows')
check(created && created.body.persistent === true, 'persistence is create-time and sent')
check(created && created.body.credentials === undefined, 'NFS create sends no credentials block (the CIFS rule does not reach it)')

// ---- 5. CREATE: typed target normalises; Test gates + renders verdicts ------
//
// The Server/Share fields apply the shared normaliser on blur (the ES5 port of
// packages/shared/src/mount-target.ts), the Test button arms only once the
// target is testable, the new `invalid` verdict renders with its detail, and
// an UNKNOWN verdict says "Test failed: <detail>" — never "no route".

const add2 = await openDialog('Add Remote Share…')
const tbtn = add2.byCls('anas-btn-mount-testconn')
check(!!tbtn, 'the Test connection button exists on a create')
check(tbtn.disabled === true, 'the Test button starts disabled (nothing typed)')

// CIFS with the reproduced shapes: a UNC-marked server, an outer-slashed share.
add2.down('#type').setValue('cifs')
add2.down('#server').setValue('//10.0.0.212')
check(tbtn.disabled === true, 'Test stays disabled: a CIFS test needs a share too')
add2.down('#remotePath').setValue('/pictures')
check(tbtn.disabled === false, 'Test arms once server AND share are filled (CIFS)')

// BLUR normalises the typed values in place — the fields show what the daemon
// would write, and the test body follows them.
add2.down('#server').fire('blur')
add2.down('#remotePath').fire('blur')
check(add2.down('#server').getValue() === '10.0.0.212', `blur normalises the server (got ${add2.down('#server').getValue()})`)
check(add2.down('#remotePath').getValue() === 'pictures', `blur normalises the share (got ${add2.down('#remotePath').getValue()})`)

captured.posts.length = 0
tbtn.handler()
await flush()
const npost = captured.posts.find(p => p.path === '/mounts/test')
check(!!npost, 'Test posts /mounts/test')
check(npost && npost.body.server === '10.0.0.212', `the test body carries the normalised server (got ${npost && npost.body.server})`)
check(npost && npost.body.remotePath === 'pictures', `the test body carries the normalised share (got ${npost && npost.body.remotePath})`)

// The new `invalid` verdict renders with its guiding detail.
testResponses.push({ data: { verdict: 'invalid', stage: 'mount', detail: "The server or share is malformed — server is a host or address, share is the share's name." } })
tbtn.handler()
await flush()
let verdictArea = add2.down('#testResult')
check(verdictArea && verdictArea.html.indexOf('Malformed') !== -1, 'the invalid verdict renders its label')
check(verdictArea && verdictArea.html.indexOf('server or share is malformed') !== -1, 'the invalid verdict renders the daemon detail')

// An UNKNOWN verdict says "Test failed: <detail>" — never "no route".
testResponses.push({ data: { verdict: 'brand-new-verdict', stage: 'mount', detail: 'some odd failure' } })
tbtn.handler()
await flush()
verdictArea = add2.down('#testResult')
check(verdictArea && verdictArea.html.indexOf('Test failed: some odd failure') !== -1, `an unknown verdict renders "Test failed: <detail>" (got ${verdictArea && verdictArea.html})`)
check(verdictArea && verdictArea.html.indexOf('no route') === -1, 'an unknown verdict never claims "no route"')

// The SUBMIT body normalises too — raw values never reach the daemon.
add2.down('#server').setValue('  //nas.example.com  ')
add2.down('#remotePath').setValue('media\\sub')
add2.down('#mountpoint').setValue('/mnt/norm-sub')
const normJob = submit(add2)
check(normJob && normJob.body.server === 'nas.example.com', `the save body carries the normalised server (got ${normJob && normJob.body.server})`)
check(normJob && normJob.body.remotePath === 'media/sub', `the save body carries the normalised share (got ${normJob && normJob.body.remotePath})`)
check(normJob && normJob.body.type === 'cifs', 'the save body keeps the chosen protocol')

// ---- 6. CREATE: CIFS credentials — guest / half-filled / complete -----------
//
// A server may allow guest access: both credential fields BLANK sends NO
// credentials block at all (the daemon writes `guest`); exactly ONE filled is
// refused with guidance BEFORE any job; both filled sends the complete pair.

const cifsAdd = await openDialog('Add Remote Share…')
cifsAdd.down('#type').setValue('cifs')
cifsAdd.down('#server').setValue('nas.example.com')
cifsAdd.down('#remotePath').setValue('public')
cifsAdd.down('#mountpoint').setValue('/mnt/guest-share')

// Both blank → POST without a credentials block (guest).
const guestJob = submit(cifsAdd)
check(guestJob && guestJob.method === 'post', 'a blank-credentials CIFS create still POSTs')
check(guestJob && guestJob.body.type === 'cifs', 'the guest create keeps the chosen protocol')
check(guestJob && guestJob.body.credentials === undefined, `both blank sends NO credentials block (got ${JSON.stringify(guestJob && guestJob.body.credentials)})`)

// Username only → refused with the guidance, and NO job.
cifsAdd.down('#credUser').setValue('smbuser')
const halfJob = submit(cifsAdd)
check(halfJob === undefined, 'a username-only CIFS create sends NO job')
const halfAlert = captured.alerts.shift()
check(
  halfAlert && halfAlert.title === 'Invalid input' && halfAlert.msg === 'Enter both the SMB username and password, or leave both blank for guest access.',
  `half-filled credentials are refused with the guidance (got ${JSON.stringify(halfAlert)})`,
)

// Password only → the same refusal (the rule is symmetric).
cifsAdd.down('#credUser').setValue('')
cifsAdd.down('#credPass').setValue('s3cret')
const halfJob2 = submit(cifsAdd)
check(halfJob2 === undefined, 'a password-only CIFS create sends NO job')
const halfAlert2 = captured.alerts.shift()
check(
  halfAlert2 && halfAlert2.msg === 'Enter both the SMB username and password, or leave both blank for guest access.',
  `a password-only half-fill is refused too (got ${JSON.stringify(halfAlert2)})`,
)

// Both filled → the complete pair travels.
cifsAdd.down('#credUser').setValue('smbuser')
cifsAdd.down('#credDomain').setValue('WORKGROUP')
const fullJob = submit(cifsAdd)
check(fullJob && fullJob.method === 'post', 'a filled-credentials CIFS create POSTs')
check(fullJob && fullJob.body.credentials && fullJob.body.credentials.username === 'smbuser', `the username travels (got ${JSON.stringify(fullJob && fullJob.body.credentials)})`)
check(fullJob && fullJob.body.credentials && fullJob.body.credentials.password === 's3cret', 'the password travels')
check(fullJob && fullJob.body.credentials && fullJob.body.credentials.domain === 'WORKGROUP', 'the domain rides along')

// ---- Report -----------------------------------------------------------------

for (const a of captured.alerts) {
  failures.push(`unexpected alert: ${a.title} — ${a.msg}`)
}

if (failures.length) {
  console.error(`mounts-submit harness: ${failures.length} failure(s)`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log('mounts-submit harness: all checks passed')
