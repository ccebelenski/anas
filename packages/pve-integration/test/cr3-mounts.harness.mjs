#!/usr/bin/env node
/*
 * ANAS — cr3.mounts panel harness (packages/pve-integration/src/67-mounts.js).
 *
 * Drives the REAL Mounts panel code under a small Ext/ANAS stub (the shape of
 * mounts-submit.harness.mjs) and pins the panel half of the 2026-11-14 review's
 * remote-mounts findings:
 *
 *   H1   the Edit window title is HTML — a mountpoint from the node is encoded;
 *   L17  every toolbar tooltip is encoded (the iSCSI LUN tip carries names from
 *        the node), and an edit PUTs to the mount's own path, never a trimmed
 *        copy of the read-only field;
 *   M4   a row double-click opens Edit only when the Edit button would (never
 *        on a disabled line);
 *   L13  an armed automount offers no Unmount (the daemon answers 404);
 *   M10  a row whose mount table could not be read renders "Unknown", never
 *        "Not mounted", and Mount/Unmount are greyed;
 *   L9   Test connection from Edit with no new password sends the mountpoint
 *        (the daemon tests with the line's own credentials), never a username
 *        alone (a body the daemon refuses);
 *   L8   a server beginning with `-` is refused before any request;
 *   M7   a probe the daemon could not clean up is said in the verdict.
 *
 *   node packages/pve-integration/test/cr3-mounts.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const failures = []
function check(ok, what) {
  if (!ok) {
    failures.push(what)
  }
}

// A mountpoint an unprivileged local user can create (a FUSE mount), with a
// trailing space — both the title encoding and the PUT path are tested on it.
const XSS_MP = '/mnt/<img src=x onerror=alert(1)> '
const DETAIL = {
  mountpoint: XSS_MP,
  type: 'cifs',
  fstype: 'cifs',
  source: '//nas/media',
  server: 'nas',
  remotePath: 'media',
  state: 'ok',
  mounted: true,
  persistent: true,
  remote: true,
  automount: false,
  disabled: false,
  pveManaged: false,
  ahrManaged: false,
  readOnly: false,
  health: { state: 'ok' },
  warnings: [],
  credentials: { set: true, username: 'smbuser' },
  configuredOptions: {
    common: { readOnly: false, nofail: true, noauto: false, automount: false, noatime: false, nosuid: true, nodev: true, noexec: false, netdev: true },
    cifs: { vers: '3.0' },
    passthrough: '',
  },
}

// ---- Ext stub (fields, windows, stores) ---------------------------------------

function isField(xtype) {
  return xtype === 'textfield' || xtype === 'numberfield' || xtype === 'combobox'
    || xtype === 'checkboxfield' || xtype === 'radiogroup'
}

function makeCmp(cfg, win) {
  return {
    itemId: cfg.itemId,
    xtype: cfg.xtype || 'component',
    // D-35: the bound-list render probe needs the combo's list shape.
    displayField: cfg.displayField,
    valueField: cfg.valueField,
    listConfig: cfg.listConfig,
    store: cfg.store,
    isField: isField(cfg.xtype),
    readOnly: !!cfg.readOnly,
    disabled: !!cfg.disabled,
    hidden: !!cfg.hidden,
    cls: cfg.cls || '',
    handler: cfg.handler,
    html: cfg.html || '',
    _value: cfg.xtype === 'checkboxfield' ? !!cfg.checked : (cfg.value !== undefined ? cfg.value : (cfg.xtype === 'numberfield' ? null : '')),
    _handlers: {},
    up: () => win,
    down: () => null,
    on(evt, fn) { (this._handlers[evt] = this._handlers[evt] || []).push(fn) },
    fire(evt) { for (const fn of (this._handlers[evt] || []).slice()) { fn(this, this.getValue()) } },
    update(html) { this.html = html },
    setHidden(v) { this.hidden = !!v },
    setDisabled(v) { this.disabled = !!v },
    setFieldLabel() {},
    getValue() {
      if (this.xtype === 'checkboxfield') { return !!this._value }
      if (this.xtype === 'numberfield') { return (this._value === '' || this._value == null) ? null : Number(this._value) }
      return this._value == null ? '' : this._value
    },
    setValue(v) { this._value = v; this.fire('change'); return this },
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
    show() {},
    close() { this.destroyed = true },
    down(sel) { return byId[String(sel).replace('#', '')] || null },
    up: () => null,
    byCls(cls) { return all.find(c => String(c.cls).indexOf(cls) !== -1) || null },
  }
  const walk = (items) => {
    for (const c of items || []) {
      const cmp = makeCmp(c, win)
      all.push(cmp)
      if (c.itemId) { byId[c.itemId] = cmp }
      if (cmp.isField) { fields.push(cmp) }
      walk(c.items)
    }
  }
  walk(cfg.items)
  for (const b of cfg.buttons || []) {
    const cmp = makeCmp(b, win)
    cmp.text = b.text
    if (b.itemId) { byId[b.itemId] = cmp }
    if (b.text === 'Save' || b.text === 'Add') { win._submit = cmp }
  }
  byId.form = { itemId: 'form', getForm: () => ({ isValid: () => true }), query: () => fields, up: () => win, on() {} }
  return win
}

const captured = { windows: [], jobs: [], posts: [], alerts: [] }
// What GET /mounts answers (follow-up (3) sets a list-level tableUnreadable).
let listResponse = { data: [] }
// D-35: what GET /identity/users and /identity/groups answer (the CIFS Owner
// and Group combos fill from these).
let usersResponse = { data: [] }
let groupsResponse = { data: [] }
// The real 00-core encoder, captured by loadUi, so the bound-list render probe
// encodes exactly as the panel does.
let REAL_ENC = null

/**
 * What a combo's drop-down list puts into innerHTML for `rows`. A combo with a
 * `listConfig.tpl` renders through it (the XTemplate forms the panels use:
 * `<tpl for=".">`, `{field}`, `{field:htmlEncode}`); one without renders
 * ExtJS's DEFAULT BoundList item, `{<displayField>}` — RAW (proven in a
 * browser on PVE 9.2, ExtJS 7.0.0.168 — the fact 68-backup.js:209 and
 * 75-iscsi.js:196 record, modelled here as in cr3-backup-panel.harness.mjs).
 */
function renderBoundList(combo, rows) {
  const tpl = combo.listConfig && combo.listConfig.tpl
  const inner = tpl
    ? String(tpl).replace(/^<tpl for="\.">/, '').replace(/<\/tpl>$/, '')
    : `<div class="x-boundlist-item">{${combo.displayField}}</div>`
  return rows.map(row => inner.replace(/\{(\w+)(:htmlEncode)?\}/g,
    (_m, field, encode) => (encode ? REAL_ENC(row[field]) : String(row[field] == null ? '' : row[field]))))
    .join('')
}

function loadUi() {
  const doc = { cookie: '', hidden: false, addEventListener() {}, removeEventListener() {} }
  const win = { document: doc }
  const sandbox00 = { window: {} }
  vm.runInNewContext(readFileSync(join(SRC, '00-core.js'), 'utf8'), sandbox00, { filename: '00-core.js' })
  REAL_ENC = sandbox00.window.ANAS.enc
  win.ANAS = {
    views: {},
    noAutofill: sandbox00.window.ANAS.noAutofill,
    t: s => s,
    // The real encoder (00-core.js), so an assertion on the output is an assertion on what ships.
    enc: sandbox00.window.ANAS.enc,
    formatBytes: b => `${b}`,
    warn(m) { failures.push(`view warned: ${m}`) },
    errText: e => String((e && e.message) || e),
    errorPanel: m => ({ html: m }),
    tbar: items => ({ xtype: 'toolbar', items }),
    warningsHtml: w => String(w),
    alertMsg(title, msg) { captured.alerts.push({ title, msg }) },
    fmtMode: () => ({ valid: true, symbolic: 'rw-r--r--', gloss: '' }),
    api: {
      get(_node, path) {
        if (path === '/identity/users') { return Promise.resolve(usersResponse) }
        if (path === '/identity/groups') { return Promise.resolve(groupsResponse) }
        if (path.indexOf('/mounts/') === 0) { return Promise.resolve({ data: DETAIL }) }
        if (path === '/mounts') { return Promise.resolve(listResponse) }
        return Promise.resolve({ data: [] })
      },
      post(_node, path, body) {
        captured.posts.push({ path, body })
        return Promise.resolve({ data: { verdict: 'ok', stage: 'mount', dnsResolved: true, portReachable: true, cleanup: "the probe directory '/var/tmp-probe/anas-mount-probe-x' was left in place (EBUSY) <b>umount</b>." } })
      },
    },
    runJob(opts) { captured.jobs.push(opts) },
    confirmAndRun(opts) { captured.jobs.push(opts) },
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
        if (xclass === 'Ext.data.Store') { return { data: [], loadData(r) { this.data = r }, getCount() { return this.data.length } } }
        if (xclass === 'Ext.window.Window') {
          const w = makeWindow(cfg)
          captured.windows.push(w)
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
const flush = () => new Promise(resolve => setImmediate(resolve))

// A grid stand-in: the toolbar buttons updateButtons drives, one selected record.
function makeGrid(rowData) {
  const buttons = {}
  for (const id of ['mountToggle', 'mountEdit', 'mountRemove', 'mountDisable']) {
    buttons[id] = {
      disabled: false,
      tip: '',
      text: '',
      setDisabled(v) { this.disabled = !!v },
      setTooltip(v) { this.tip = v },
      setText(v) { this.text = v },
      setIconCls() {},
    }
  }
  buttons.mountsTableNotice = { hidden: true, setHidden(v) { this.hidden = !!v } }
  const record = { data: rowData, get: k => rowData[k], getData: () => rowData }
  const view = {
    destroyed: false,
    destroying: false,
    down: sel => (sel === '#mountsGrid' ? grid : { update() {}, setHtml() {}, setLoading() {} }),
    up: () => null,
    isVisible: () => true,
  }
  const grid = {
    buttons,
    getSelection: () => [record],
    down: sel => buttons[String(sel).replace('#', '')] || null,
    up: () => view,
    getStore: () => ({ loadData() {}, findExact: () => -1 }),
  }
  return { grid, record, view }
}

const cfg = ANAS.views.mounts.factory('node1')
const gridCfg = cfg.items[0]
const tbar = Array.isArray(gridCfg.tbar) ? gridCfg.tbar : (gridCfg.tbar && gridCfg.tbar.items) || []
const button = text => tbar.find(b => b && b.text === text)

function select(rowData) {
  const g = makeGrid(rowData)
  gridCfg.listeners.selectionchange.call(g.grid, null, [g.record])
  return g
}

const baseRow = { mountpoint: '/mnt/share', type: 'cifs', source: '//nas/media', remote: true, persistent: true, pveManaged: false, ahrManaged: false, state: 'ok' }

// ---- H1: the Edit title encodes the mountpoint ------------------------------------

{
  const g = select({ ...baseRow, mountpoint: XSS_MP })
  captured.windows.length = 0
  button('Edit').handler({ up: () => g.view })
  await flush()
  const w = captured.windows[0]
  check(!!w, 'H1: the Edit window opened')
  check(w && w.title.indexOf('<img') === -1, `H1: the title carries no raw markup (got ${w && w.title})`)
  check(w && w.title.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1, `H1: the mountpoint is encoded in the title (got ${w && w.title})`)
}

// ---- L17: tooltips are encoded ------------------------------------------------------

{
  const g = select({ ...baseRow, heldByLun: { targetIqn: 'iqn.2026-11.x:t', detail: 'held by <b onmouseover=x>LUN</b>' } })
  const tip = g.grid.buttons.mountRemove.tip
  check(tip.indexOf('<b') === -1, `L17: the LUN tooltip carries no raw markup (got ${tip})`)
  check(tip.indexOf('&lt;b onmouseover=x&gt;LUN&lt;/b&gt;') !== -1, `L17: the LUN detail is encoded once for the QuickTip (got ${tip})`)
  check(g.grid.buttons.mountRemove.disabled === true, 'L17: Remove is still greyed for a LUN-held mount')
}

// ---- M4: the row double-click takes the Edit button's gate --------------------------

{
  const g = select({ ...baseRow, state: 'disabled', disabled: true })
  check(g.grid.buttons.mountEdit.disabled === true, 'M4: the Edit button is greyed on a disabled line (unchanged)')
  captured.windows.length = 0
  gridCfg.listeners.itemdblclick(g.grid, g.record)
  check(captured.windows.length === 0, 'M4: a double-click on a disabled line does not open Edit')
  const live = select({ ...baseRow })
  gridCfg.listeners.itemdblclick(live.grid, live.record)
  await flush()
  check(captured.windows.length === 1, 'M4: a double-click on an enabled remote share still opens Edit')
}

// ---- L13: an armed automount offers no Unmount ---------------------------------------

{
  const g = select({ ...baseRow, state: 'armed', automount: true })
  check(g.grid.buttons.mountToggle.disabled === true, 'L13: the Mount/Unmount toggle is greyed on an armed automount')
  check(/Automount armed/.test(g.grid.buttons.mountToggle.tip), `L13: the tip says what to do instead (got ${g.grid.buttons.mountToggle.tip})`)
}

// ---- M10: an unreadable mount table renders Unknown ----------------------------------

{
  const stateCol = gridCfg.columns.find(c => c.dataIndex === 'state')
  const html = stateCol.renderer('unknown')
  check(/>Unknown</.test(html), `M10: state unknown renders "Unknown" (got ${html})`)
  check(!/Not mounted/.test(html), 'M10: never "Not mounted"')
  const g = select({ ...baseRow, state: 'unknown', tableUnreadable: true })
  check(g.grid.buttons.mountToggle.disabled === true, 'M10: Mount/Unmount is greyed while the table is unreadable')
  check(/could not read the kernel mount table/.test(g.grid.buttons.mountToggle.tip), 'M10: the tip says why')
}

// ---- L9 / L17 / M7: the Edit dialog's Test and Save ---------------------------------

{
  const g = select({ ...baseRow, mountpoint: XSS_MP })
  captured.windows.length = 0
  button('Edit').handler({ up: () => g.view })
  await flush()
  await flush()
  await flush()
  const w = captured.windows[0]
  captured.posts.length = 0
  w.byCls('anas-btn-mount-testconn').handler()
  await flush()
  const post = captured.posts.find(p => p.path === '/mounts/test')
  check(!!post, 'L9: Test connection posts /mounts/test')
  check(post && post.body.mountpoint === XSS_MP, `L9: an Edit test with no new password names the mount (got ${JSON.stringify(post && post.body)})`)
  check(post && post.body.credentials === undefined, 'L9: never a username alone (a body the daemon refuses)')
  const verdict = w.down('#testResult')
  check(verdict && verdict.html.indexOf('Probe cleanup:') !== -1, `M7: the verdict says what the probe left (got ${verdict && verdict.html})`)
  check(verdict && verdict.html.indexOf('<b>umount') === -1, 'M7: the cleanup text is encoded')

  // L9: with a typed password the credentials go, the mountpoint does not.
  const pass = w.down('#credPass')
  pass._userTyped = true
  pass.setValue('n3w')
  captured.posts.length = 0
  w.byCls('anas-btn-mount-testconn').handler()
  await flush()
  const typed = captured.posts.find(p => p.path === '/mounts/test')
  check(typed && typed.body.credentials && typed.body.credentials.password === 'n3w' && typed.body.mountpoint === undefined, `L9: a typed password is tested as typed (got ${JSON.stringify(typed && typed.body)})`)

  // L17: the Save PUTs to the mount's own path — the trailing space kept.
  captured.jobs.length = 0
  w._submit.handler()
  const job = captured.jobs[0]
  check(job && job.path === `/mounts/${encodeURIComponent(XSS_MP)}`, `L17: the PUT targets the mount's own path, untrimmed (got ${job && job.path})`)
}

// ---- L8: a server beginning with '-' is refused before any request -------------------

{
  const g = select({ ...baseRow })
  captured.windows.length = 0
  tbar.find(b => b && String(b.cls).indexOf('anas-btn-mount-add') !== -1).handler({ up: () => g.view })
  await flush()
  const w = captured.windows[0]
  check(!!w, 'L8: the Add window opened')
  w.down('#type').setValue('nfs')
  w.down('#server').setValue('-aoremount,ro')
  w.down('#remotePath').setValue('/export')
  w.down('#mountpoint').setValue('/mnt/x')
  captured.jobs.length = 0
  captured.alerts.length = 0
  w._submit.handler()
  check(captured.jobs.length === 0, 'L8: no job is fired')
  check(captured.alerts.some(a => /must not begin with '-'/.test(a.msg)), `L8: the refusal is said (got ${JSON.stringify(captured.alerts)})`)
  captured.alerts.length = 0
}

// ---- follow-up (3): an unreadable mount table is said above the grid ------------

{
  const g = select({ ...baseRow })
  listResponse = { data: [], tableUnreadable: true }
  ANAS.mounts.reload(g.view, 'node1', true)
  await flush()
  await flush()
  check(g.grid.buttons.mountsTableNotice.hidden === false, '(3): an unreadable mount table shows the notice (never a bare "No mounts found")')
  const notice = gridCfg.dockedItems && gridCfg.dockedItems.find(d => d.itemId === 'mountsTableNotice')
  check(notice && /could not read the kernel mount table/.test(notice.html), '(3): the notice says what could not be read')
  listResponse = { data: [] }
  ANAS.mounts.reload(g.view, 'node1', true)
  await flush()
  await flush()
  check(g.grid.buttons.mountsTableNotice.hidden === true, '(3): a readable table hides it again')
}

// ---- follow-up (4): PVE ownership unknown is never an ANAS share ------------------

{
  const g = select({ ...baseRow, pveOwnershipUnknown: true })
  for (const id of ['mountToggle', 'mountEdit', 'mountRemove', 'mountDisable'])
    check(g.grid.buttons[id].disabled === true, `(4): ${id} is greyed when PVE ownership is unknown`)
  check(/could not read PVE's storage configuration/.test(g.grid.buttons.mountEdit.tip), `(4): the tip says why (got ${g.grid.buttons.mountEdit.tip})`)
  captured.windows.length = 0
  gridCfg.listeners.itemdblclick(g.grid, g.record)
  check(captured.windows.length === 0, '(4): a double-click does not open Edit')
  const managedCol = gridCfg.columns.find(c => c.dataIndex === 'managedBy')
  const badge = managedCol.renderer(undefined, {}, g.record)
  check(/UNKNOWN/.test(badge) && !/>ANAS</.test(badge), `(4): Managed by reads UNKNOWN, never ANAS (got ${badge})`)
}

// ---- cr4.conf fold 6: a row warning rides the Mountpoint cell ----------------------

{
  const mpCol = gridCfg.columns.find(c => c.dataIndex === 'mountpoint')
  const warned = mpCol.renderer('/mnt/share', {}, { get: k => (k === 'warnings' ? ['/mnt/share is on lines 1 and 2 of /etc/fstab.'] : undefined) })
  check(/anas-mount-tag/.test(warned) && warned.includes('/mnt/share is on lines 1 and 2 of /etc/fstab.'), `fold 6: a row warning rides the Mountpoint cell (got ${warned})`)
  check(/warning/.test(warned), `fold 6: the tag says it is a warning (got ${warned})`)
  const plain = mpCol.renderer('/mnt/share', {}, { get: () => undefined })
  check(!/anas-mount-tag/.test(plain), `fold 6: no warning tag without warnings (got ${plain})`)
}

// ---- review fixes -----------------------------------------------------------------

async function openEdit(rowData) {
  const g = select(rowData)
  captured.windows.length = 0
  button('Edit').handler({ up: () => g.view })
  await flush()
  await flush()
  await flush()
  return captured.windows[0]
}

{
  // (1) the Domain field pre-filled from the credentials FILE (the line has
  // none) is not echoed into the line's options on an untouched save.
  DETAIL.credentials = { set: true, username: 'smbuser', domain: 'CORP' }
  const w = await openEdit({ ...baseRow })
  check(w.down('#credDomain').getValue() === 'CORP', 'review (1): the dialog still SHOWS the file\'s domain')
  captured.jobs.length = 0
  w._submit.handler()
  const job = captured.jobs[0]
  check(job && job.body.options.domain === null, `review (1): an untouched save sends no domain for the line (got ${JSON.stringify(job && job.body.options.domain)})`)
  // A domain the operator types is the line's and travels.
  const w2 = await openEdit({ ...baseRow })
  w2.down('#credDomain').setValue('OTHER')
  captured.jobs.length = 0
  w2._submit.handler()
  check(captured.jobs[0] && captured.jobs[0].body.options.domain === 'OTHER', 'review (1): a typed domain is sent')
  DETAIL.credentials = { set: true, username: 'smbuser' }
}

{
  // (3) a username typed without its password is not tested with the stored credentials.
  const w = await openEdit({ ...baseRow })
  w.down('#credUser').setValue('alice')
  captured.posts.length = 0
  captured.alerts.length = 0
  w.byCls('anas-btn-mount-testconn').handler()
  await flush()
  check(captured.posts.filter(p => p.path === '/mounts/test').length === 0, 'review (3): no test request for an identity without its password')
  check(captured.alerts.some(a => /Enter the password to test this username and domain/.test(a.msg)), `review (3): the operator is told to type the password (got ${JSON.stringify(captured.alerts)})`)
  captured.alerts.length = 0
}

{
  // review 2 (3): a CHANGED Domain with no password typed is treated like a changed username.
  const w = await openEdit({ ...baseRow })
  w.down('#credDomain').setValue('OTHERDOM')
  captured.posts.length = 0
  captured.alerts.length = 0
  w.byCls('anas-btn-mount-testconn').handler()
  await flush()
  check(captured.posts.filter(p => p.path === '/mounts/test').length === 0, 'review 2 (3): no test with the stored credentials for a changed domain')
  check(captured.alerts.some(a => /Enter the password/.test(a.msg)), 'review 2 (3): the operator is told the password is needed')
  captured.alerts.length = 0
  // The unchanged dialog still tests with the stored credentials.
  const w2 = await openEdit({ ...baseRow })
  captured.posts.length = 0
  w2.byCls('anas-btn-mount-testconn').handler()
  await flush()
  const post = captured.posts.find(p => p.path === '/mounts/test')
  check(post && post.body.mountpoint !== undefined, 'review 2 (3): an untouched dialog still tests with the stored credentials')
}

{
  // (4) H2 at the panel: Edit is greyed with the LUN reason; the double-click does not open it.
  const g = select({ ...baseRow, heldByLun: { targetIqn: 'iqn.2026-11.x:t', detail: 'held by LUN 0' } })
  check(g.grid.buttons.mountEdit.disabled === true, 'review (4): Edit is greyed for a LUN-held mount')
  check(/Delete the LUN/.test(g.grid.buttons.mountEdit.tip), `review (4): with the LUN reason (got ${g.grid.buttons.mountEdit.tip})`)
  captured.windows.length = 0
  gridCfg.listeners.itemdblclick(g.grid, g.record)
  check(captured.windows.length === 0, 'review (4): the double-click does not open Edit')
}

{
  // review 3 (9): a stored passthrough ending in a VT / NBSP is sent byte for
  // byte by an untouched Save; a typed value is trimmed.
  const savedPt = DETAIL.configuredOptions.passthrough
  DETAIL.configuredOptions.passthrough = 'x-note=a\u000B,x-tail=b\u00A0'
  const w = await openEdit({ ...baseRow })
  captured.jobs.length = 0
  w._submit.handler()
  check(captured.jobs[0] && captured.jobs[0].body.extraOptions === 'x-note=a\u000B,x-tail=b\u00A0', `review 3 (9): the stored bytes are sent (got ${JSON.stringify(captured.jobs[0] && captured.jobs[0].body.extraOptions)})`)
  w.down('#extraOptions').setValue('  x-new=1  ')
  captured.jobs.length = 0
  w._submit.handler()
  check(captured.jobs[0] && captured.jobs[0].body.extraOptions === 'x-new=1', 'review 3 (9): a typed value is trimmed')
  DETAIL.configuredOptions.passthrough = savedPt
}

{
  // review 4 (D3): a credentials FILE domain with a trailing space (`CORP `)
  // pre-fills the field; an untouched Save sends null (the line has none),
  // and Test still uses the stored credentials — never a trimmed `CORP`.
  DETAIL.credentials = { set: true, username: 'smbuser', domain: 'CORP ' }
  const w = await openEdit({ ...baseRow })
  captured.jobs.length = 0
  w._submit.handler()
  check(captured.jobs[0] && captured.jobs[0].body.options.domain === null, `review 4 (D3): untouched file domain sends null (got ${JSON.stringify(captured.jobs[0] && captured.jobs[0].body.options.domain)})`)
  captured.posts.length = 0
  captured.alerts.length = 0
  w.byCls('anas-btn-mount-testconn').handler()
  await flush()
  const post = captured.posts.find(p => p.path === '/mounts/test')
  check(post && post.body.mountpoint !== undefined, 'review 4 (D3): an untouched padded domain still tests with the stored credentials')
  check(captured.alerts.length === 0, `review 4 (D3): no password demanded (got ${JSON.stringify(captured.alerts)})`)
  // The line's OWN domain with a padded byte is sent back exactly.
  const savedCo = DETAIL.configuredOptions.cifs
  DETAIL.configuredOptions.cifs = { vers: '3.0', domain: 'LINE\u00A0' }
  const w2 = await openEdit({ ...baseRow })
  captured.jobs.length = 0
  w2._submit.handler()
  check(captured.jobs[0] && captured.jobs[0].body.options.domain === 'LINE\u00A0', `review 4 (D3): the line's own domain travels byte for byte (got ${JSON.stringify(captured.jobs[0] && captured.jobs[0].body.options.domain)})`)
  DETAIL.configuredOptions.cifs = savedCo
  DETAIL.credentials = { set: true, username: 'smbuser' }
}

{
  // D-35: the CIFS Owner and Group combos fill from /identity/users and
  // /identity/groups — account and group names from the node's getent — so
  // their bound lists must render through an encoded template like the
  // siblings in 70-shares, 80-users and 72-cloud do, not the RAW default.
  usersResponse = { data: [{ name: '<img src=x onerror=alert(1)>', uid: 2000 }, { name: 'smbuser', uid: 1000 }] }
  groupsResponse = { data: [{ name: '<img src=x onerror=alert(1)>', gid: 2001 }, { name: 'staff', gid: 100 }] }
  const w = await openEdit({ ...baseRow })
  for (const id of ['#cifsUid', '#cifsGid']) {
    const combo = w.down(id)
    check(!!combo, `D-35: the CIFS dialog has ${id}`)
    const rows = (combo && combo.store && combo.store.data) || []
    check(rows.some(r => /<img/.test(r.label)), `D-35: ${id} holds a hostile account label from the node (got ${JSON.stringify(rows)})`)
    const html = combo ? renderBoundList(combo, rows) : ''
    check(!/<img/i.test(html) && /&lt;img/.test(html), `D-35: the ${id} list renders account names ENCODED (got ${html})`)
  }
  usersResponse = { data: [] }
  groupsResponse = { data: [] }
}

for (const a of captured.alerts) {
  failures.push(`unexpected alert: ${a.title} — ${a.msg}`)
}
if (failures.length) {
  console.error(`cr3-mounts harness: ${failures.length} failure(s)`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log('cr3-mounts harness: all checks passed')
