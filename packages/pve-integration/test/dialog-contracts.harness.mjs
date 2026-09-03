#!/usr/bin/env node
/*
 * ANAS — Dialog-contract harness: what the PVE-UI dialogs actually SEND.
 *
 * A companion to the render harnesses (dashboard-telemetry, gfx-timechart):
 * those prove what a view DRAWS, this one proves what a dialog POSTs/PUTs. It
 * stubs the slice of ExtJS the ES5 sources touch (a component tree with
 * down()/up()/getValue(), a store, a grid selection model), loads the real
 * sources in a vm sandbox, drives the real toolbar handlers, and asserts on the
 * captured request bodies.
 *
 * What it guards:
 *
 *   1. Backup task edit → Save round-trips EVERY field of the BackupTask schema.
 *      The keys are read from the shared Zod schema itself, so a field added to
 *      BackupTask that the dialog does not carry FAILS here rather than being
 *      silently reset to its schema default on the next save. (That is exactly
 *      how `limitNofile` — a real prlimit --nofile on the generated unit — was
 *      lost, after `cadence` before it.)
 *   2. The enable/disable toggle round-trips every field too: a toggle is a PUT
 *      of the WHOLE task, so it drops fields just as easily as the dialog.
 *   3. `includeNested` (backup2.2) has set / clear / keep semantics: an explicit
 *      choice round-trips, clearing to None sends NO key, and an archive that
 *      never chose one still sends nothing after an untouched edit — which is
 *      what keeps a pre-backup2.2 unit byte-identical on save.
 *   3b. `kind` (backup2.4) has the same set / clear / keep semantics, and an
 *      `img` row hides AND DISABLES the controls that cannot apply to a block
 *      image — a stale exclude read back off a hidden field would be refused by
 *      the daemon with nothing on screen to explain it. The LUN record follows
 *      the PATH: retype the path and the record is not sent.
 *   4. Import Pool sends the GUID it displays — duplicate-name imports are the
 *      whole reason the scan reports a GUID.
 *   5c/5d. backup2.6: the RESTORE doors — the request body in every mode, the
 *      confirm-code prediction for an in-place TREE only, a hardlink group as
 *      ONE unit, `img` archives excluded, and both doors on the Backup screen.
 *   5. backup2.5: the shared path picker — lazy tree loads, breadcrumbs,
 *      type-ahead, multi-select set semantics, hardlink groups as ONE unit, and
 *      the archive backend carrying its snapshot context. Plus the one that
 *      matters most to the wizard: the archive-path body is BYTE-IDENTICAL
 *      whether the path was typed or picked.
 *   4. Datasets: a VOLUME (zvol) and a FILESYSTEM are the same dialog sending
 *      two different bodies (story iscsi.3). Guards that a filesystem create is
 *      still byte-identical to what it was before volumes existed (version
 *      skew), that a volume create carries the zvol keys and NO filesystem
 *      ones, that Resize Volume grows only — an untouched edit sends nothing, a
 *      shrink sends nothing — and the toolbar gating matrix for a volume row,
 *      including the tooltip reason on each disabled control.
 *   5. iSCSI (story iscsi.4): a CHAP secret is WRITE-ONLY, so a blank box means
 *      KEEP and never "clear" — a dialog that got that backwards would strip
 *      every stored secret on the next unrelated save. Also: an untouched target
 *      edit sends an EMPTY body, the Add LUN pickers never offer PVE territory,
 *      a resize grows only, destroying a LUN's backing object is a separate
 *      ticked choice that becomes a query flag, and a foreign target, a live
 *      session, or a non-empty target greys the right controls with the reason
 *      attached — a target is deletable ONLY empty and quiet, and that delete
 *      is a plain confirm, never a confirm-code flow.
 *   6. iSCSI boot lifecycle (story iscsi.5): the Repair button is live ONLY when
 *      a restore hole's backing object is BACK, and says what is still missing
 *      otherwise — a boot restore with a missing device exits 0 and systemd
 *      calls it a success, so this button is the operator's only handle on it.
 *      And an `unresolved` LUN does NOT make its target hands-off: "not on this
 *      node right now" is not "somebody else's", and reading it that way would
 *      take away the very tools that fix it.
 *   7. Whole-image LUN restore (story backup2.7): a backup image that is not
 *      EXACTLY the size of the LUN is silently destructive below ANAS — larger
 *      writes until the device is full and leaves the LUN half-overwritten,
 *      smaller succeeds and leaves stale bytes past its end. So the dialog shows
 *      both numbers, keeps Restore DEAD on a mismatch, and refuses again in the
 *      submit handler; a pxar group is never offered at all; every point in time
 *      travels as a FULL `<type>/<id>/<RFC3339>` (a bare group silently restores
 *      the latest); and a live session or an absent backing greys the button
 *      with the reason attached.
 *   7b. The LUN toolbar is backup-aware: each LUN is badged with the backup
 *      task(s) that cover it (an archive's `lun` record, or a pre-backup2.4
 *      kind-`img` archive on the LUN's backing path) and their last-run
 *      result; "Back up…" runs/edits the covering task through the Backup
 *      menu's OWN doors (asserted on the job and dialog produced, not a copy),
 *      or opens the new-task wizard with the block panel already chosen and
 *      the LUN pre-selected (backup2.9 — the kind choice is skipped; 7c),
 *      whose body is deep-equal to a manual block pick in that same wizard; the tasks
 *      read failing shows no badge and gates nothing (fail-open, silent), and
 *      a foreign target or an absent backing disables the door with the
 *      reason.
 *   7c. backup2.9: a task is FILES or BLOCK, chosen FIRST — the block panel is
 *      the LUN picker and nothing else (no path, excludes, nested or
 *      change-detection controls), a new block task's id is `lun-<serial>`
 *      read-only and its archive name the fixed `disk`, and the door's
 *      pre-fill is deep-equal to a manual block pick in the same wizard. File
 *      archive names derive from the path's last segment at row creation
 *      (pinned against the shared deriveArchiveName) and are read-only; STORED
 *      names are never re-derived. A pre-backup2.9 single-image task derives
 *      as block but its save carries NO `kind` key — its stored id and group
 *      ride through verbatim. The grid grows a Kind column + the LUN's live
 *      name (null = "no longer resolvable"), and the LUN door's badge matches
 *      a task by the serial in its backup-id.
 *
 *   node packages/pve-integration/test/dialog-contracts.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { BackupTask, BLOCK_ARCHIVE_NAME, cadenceToOnCalendar, deriveArchiveName, lunBackupId } from '@anas/shared'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

// ---- Assertions -------------------------------------------------------------

const failures = []
let checks = 0
function ok(label, cond, detail) {
  checks++
  if (!cond) { failures.push(`${label}${detail ? ` — ${detail}` : ''}`) }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ============================================================================
//  A minimal ExtJS: component tree, fields, stores, grid selection
// ============================================================================

function makeRecord(data) {
  const d = { ...data }
  return { data: d, get: k => d[k], set: (k, v) => { d[k] = v } }
}

/**
 * A tree node as the ES5 sources use one: get()/set(), childNodes, isExpanded().
 * Built from the plain `{ …fields, children: [] }` objects buildPoolNode emits.
 */
function makeNode(cfg, parent) {
  const data = { ...cfg }
  const kids = data.children || []
  delete data.children
  const node = {
    data,
    parentNode: parent || null,
    get: k => data[k],
    set: (k, v) => { data[k] = v },
    isExpanded: () => !!data.expanded,
    childNodes: [],
    // The lazy-load surface the backup2.5 path picker drives: a level is
    // appended into a node, and expanding a node that has not loaded yet is what
    // triggers the next browse call.
    appendChild(childCfg) {
      const child = childCfg && childCfg.get ? childCfg : makeNode(childCfg, node)
      child.parentNode = node
      node.childNodes.push(child)
      return child
    },
    removeAll() { node.childNodes.length = 0 },
    expand() { data.expanded = true },
    collapse() { data.expanded = false },
  }
  for (const kid of kids) { node.childNodes.push(makeNode(kid, node)) }
  return node
}

function makeTreeStore(cfg) {
  const store = {
    isStore: true,
    isTreeStore: true,
    fields: (cfg.fields || []).map(f => (typeof f === 'string' ? f : f.name)),
    root: makeNode(cfg.root || { children: [] }, null),
    getRootNode() { return this.root },
    setRootNode(rootCfg) { this.root = makeNode(rootCfg, null); return this.root },
  }
  return store
}

function makeStore(cfg) {
  const rows = []
  const store = {
    isStore: true,
    fields: (cfg.fields || []).map(f => (typeof f === 'string' ? f : f.name)),
    loadData(list) { rows.length = 0; for (const r of list || []) rows.push(makeRecord(r)) },
    getRange: () => rows.slice(),
    getCount: () => rows.length,
    getAt: i => rows[i],
    each(fn) { rows.slice().forEach(fn) },
    findExact(field, value) { return rows.findIndex(r => r.get(field) === value) },
    findRecord(field, value) { return rows.find(r => r.get(field) === value) || null },
    add(r) { rows.push(r.get ? r : makeRecord(r)) },
    removeAll() { rows.length = 0 },
  }
  if (cfg.data) { store.loadData(cfg.data) }
  return store
}

const CHECKBOXES = ['checkbox', 'checkboxfield', 'radiofield', 'radio']

function makeComponent(cfg, parent) {
  const c = { ...(cfg && typeof cfg === 'object' ? cfg : { xtype: 'tbseparator' }) }
  c.parent = parent || null
  c.destroyed = false
  c.destroying = false
  c.hidden = !!c.hidden
  c.disabled = !!c.disabled
  c._on = {}
  c._selection = []

  const kids = []
  // `list` is a plain array (items/buttons) or a toolbar config object —
  // ANAS.tbar wraps every tbar in { xtype:'toolbar', items:[…] }, so the
  // stub materialises the object's items, flattening as it always did.
  //
  // ExtJS container `items` is an Ext.util.ItemCollection KEYED BY
  // getItemId() (itemId || id): adding a component whose key already exists
  // silently REMOVES the earlier entry from the collection first (the first
  // stays rendered in the DOM). A row factory emitting the same itemId is
  // therefore "N rows visible, 1 row in the collection" — exactly the fleet
  // bug this harness exists to catch, so the stub models it.
  const keyOf = cmp => cmp.itemId || cmp.id
  const keyedPush = (arr, kc) => {
    const key = keyOf(kc)
    if (key !== undefined && key !== null) {
      const dup = arr.findIndex(x => keyOf(x) === key)
      if (dup >= 0) { arr.splice(dup, 1)[0].parent = null }
    }
    arr.push(kc)
    return kc
  }
  const build = list => (Array.isArray(list) ? list : (list && list.items) || [])
    .filter(x => x && typeof x === 'object')
    .map((k) => { const kc = makeComponent(k, c); keyedPush(kids, kc); return kc })

  const own = build(cfg && cfg.items)
  c.buttonCmps = build(cfg && cfg.buttons)
  c.tbarCmps = build(cfg && cfg.tbar)

  // The `items` collection Ext hands back: each()/add()/remove() are all the
  // ES5 sources use of it (readArchives walks it).
  const items = own.slice()
  c.items = {
    each(fn) { items.slice().forEach(fn) },
    getCount: () => items.length,
    getAt: i => items[i],
    getRange: () => items.slice(),
    indexOf: x => items.indexOf(x),
  }
  c.childCmps = () => items.concat(c.buttonCmps, c.tbarCmps)

  c.add = function (what) {
    const list = Array.isArray(what) ? what : [what]
    let last = null
    for (const one of list) {
      // keyedPush, not items.push: a duplicate key REPLACES the earlier
      // entry (ExtJS ItemCollection semantics), it does not append.
      last = keyedPush(items, makeComponent(one, c))
    }
    return Array.isArray(what) ? items.slice(-list.length) : last
  }
  c.remove = function (cmp) {
    const i = items.indexOf(cmp)
    if (i >= 0) { items.splice(i, 1) }
    if (cmp) { cmp.destroyed = true }
  }
  c.removeAll = function () { items.length = 0 }

  function matches(cmp, sel) {
    // '#id', an xtype, or an ExtJS ComponentQuery attribute selector
    // '[attr]' / '[attr=value]' matched against any component property
    // (row markers like anasRowKind are config properties, not xtypes).
    const attr = sel.match(/^\[([A-Za-z_$][\w$]*)(?:=(.+))?\]$/)
    if (attr) {
      const v = cmp[attr[1]]
      if (attr[2] === undefined) { return v !== undefined && v !== null }
      return String(v) === attr[2]
    }
    return sel.charAt(0) === '#' ? cmp.itemId === sel.slice(1) : cmp.xtype === sel
  }
  c.down = function (sel) {
    for (const kid of c.childCmps()) {
      if (matches(kid, sel)) { return kid }
      const deep = kid.down(sel)
      if (deep) { return deep }
    }
    return null
  }
  c.up = function (sel) {
    let p = c.parent
    while (p) {
      if (!sel || matches(p, sel)) { return p }
      p = p.parent
    }
    return null
  }

  // --- field value semantics, per xtype ---
  const isCheckbox = CHECKBOXES.indexOf(c.xtype) >= 0
  const isRadioGroup = c.xtype === 'radiogroup'
  // The DOM box — what the operator sees in the input — versus the field's
  // committed value. setValue commits both (a programmatic set); a paste
  // writes the box ONLY, and the commit happens on blur. That is the split a
  // real browser holds while a field's input is uncommitted, and the
  // target-dialog contract (a visible row's box contents reach the POST body)
  // is asserted against it. Checkbox/radio/number fields commit on the spot
  // and keep the old single-value behaviour.
  const isTextish = !isCheckbox && !isRadioGroup && c.xtype !== 'numberfield'
  c._domValue = isTextish ? ((c.value === undefined || c.value === null) ? '' : c.value) : undefined
  c.getValue = function () {
    if (isCheckbox) { return !!c.checked }
    if (isRadioGroup) {
      for (const kid of c.childCmps()) {
        if (kid.checked) { return { [kid.name]: kid.inputValue } }
      }
      return null
    }
    if (c.xtype === 'numberfield') {
      return (c.value === undefined || c.value === null || c.value === '') ? null : Number(c.value)
    }
    return c.value === undefined || c.value === null ? '' : c.value
  }
  c.setValue = function (v) {
    if (isCheckbox) { c.checked = !!v }
    else if (isRadioGroup) {
      const want = v && typeof v === 'object' ? v[Object.keys(v)[0]] : v
      for (const kid of c.childCmps()) { kid.checked = kid.inputValue === want }
    }
    else {
      c.value = v
      if (isTextish) { c._domValue = (v === undefined || v === null) ? '' : v }
    }
    c.fireEvent('change', c, v)
    return c
  }
  /** Simulate an operator PASTE: the text lands in the box, uncommitted. */
  c.pasteInto = function (v) { c._domValue = v; return c }
  /** The blur that commits the box into the field's value (ExtJS syncs it). */
  c.blur = function () {
    if (isTextish && c._domValue !== undefined && c._domValue !== c.value) {
      c.setValue(c._domValue)
    }
    return c
  }
  /** The box contents, committed or not — ExtJS's getRawValue. */
  c.getRawValue = function () {
    return c._domValue === undefined ? c.getValue() : c._domValue
  }

  c.on = function (ev, fn) { (c._on[ev] = c._on[ev] || []).push(fn) }
  c.fireEvent = function (ev, ...args) {
    for (const fn of c._on[ev] || []) { fn(...args) }
    const l = cfg && cfg.listeners && cfg.listeners[ev]
    if (typeof l === 'function') { l.apply(c, args) }
  }

  c.getStore = () => c.store
  c.setStore = function (st) { c.store = st; return c }
  c.getSelection = () => c._selection.slice()
  // Tree panels delegate the root to their store (the ES5 sources call both).
  c.getRootNode = () => (c.store && c.store.getRootNode ? c.store.getRootNode() : null)
  c.setRootNode = function (rootCfg) {
    return c.store && c.store.setRootNode ? c.store.setRootNode(rootCfg) : null
  }
  /** Select a TREE node (as opposed to a grid row) and fire selectionchange. */
  // ExtJS's own setter. Two sources (67-mounts, 39-ahr) set a disabled button's
  // reason through it rather than assigning `.tooltip`, so the stub must model
  // it or their tooltips would be untestable.
  c.setTooltip = function (v) { c.tooltip = v || '' }
  // ExtJS's own menu-button setter — the LUN toolbar's "Back up…" rebuilds its
  // menu on every selection, so the stub must hold what setMenu hands it.
  c.setMenu = function (m) { c.menu = m; return c }
  c.selectNode = function (node) {
    c._selection = node ? [node] : []
    c.fireEvent('selectionchange', {}, c._selection)
    return node
  }
  c.getSelectionModel = () => ({
    // Real ExtJS: select(what, keepExisting, suppressEvent). A grid selects by
    // index, a tree selects the node object — and unless suppressEvent is set it
    // FIRES selectionchange, which is exactly how a widget that writes a field
    // from its own selection can loop. The harness reproduces that.
    select(what, _keepExisting, suppressEvent) {
      const rec = (what && typeof what === 'object') ? what : (c.store ? c.store.getAt(what) : null)
      c._selection = rec ? [rec] : []
      if (!suppressEvent) { c.fireEvent('selectionchange', {}, c._selection) }
      return rec
    },
    getSelection: () => c._selection.slice(),
    deselectAll() { c._selection = [] },
  })
  c.ensureVisible = () => c
  /** What a click on a row does: set the selection and fire the grid's listener. */
  c.selectRow = function (idx) {
    const rec = c.store.getAt(idx)
    c._selection = rec ? [rec] : []
    c.fireEvent('selectionchange', {}, c._selection)
    return rec
  }

  c.setLoading = () => c
  c.setHidden = function (v) { c.hidden = !!v; return c }
  c.setVisible = function (v) { c.hidden = !v; return c }
  c.isVisible = () => !c.hidden
  c.setDisabled = function (v) { c.disabled = !!v; return c }
  // The block panel (backup2.9) locks the backup-id field once a pick with a
  // readable serial derives it — readOnly, not disabled: the value is still
  // read (and asserted), the operator just cannot type over it.
  c.setReadOnly = function (v) { c.readOnly = !!v; return c }
  c.setText = function (v) { c.text = v; return c }
  c.setIconCls = function (v) { c.iconCls = v; return c }
  c.update = function (h) { c.html = h; return c }
  c.setHtml = function (h) { c.html = h; return c }
  c.getForm = () => ({ isValid: () => true, getValues: () => ({}) })
  c.getEl = () => ({ on() {}, dom: {} })
  c.getWidth = () => 900
  c.show = function () { c.hidden = false; return c }
  c.close = function () { c.destroyed = true; return c }
  c.destroy = function () { c.destroyed = true; return c }
  c.focus = () => c
  c.query = () => []

  return c
}

/** Everything Ext.create() handed out, so a harness can find the open window. */
const created = { windows: [] }

const Ext = {
  ComponentQuery: { query: () => [] },
  create(cls, cfg) {
    if (cls === 'Ext.data.TreeStore') { return makeTreeStore(cfg || {}) }
    if (cls === 'Ext.data.Store') { return makeStore(cfg || {}) }
    const cmp = makeComponent({ xtype: 'window', ...(cfg || {}) }, null)
    if (cls === 'Ext.window.Window') { created.windows.push(cmp) }
    return cmp
  },
  String: { htmlEncode: s => String(s == null ? '' : s) },
  Date: { format: d => String(d) },
  Msg: {
    confirm(title, msg, fn) { confirms.push({ title, msg }); if (fn) { fn('yes') } },
    alert(title, msg) { alerts.push({ title, msg }) },
  },
  // PVE's own /nodes/<node>/network, which the portal picker reads (the same
  // endpoint the SMB "how to connect" strings use). `ajax.responses` lets a
  // check choose success-with-addresses or outright failure.
  Ajax: {
    request(cfg) {
      const hit = Object.keys(ajax.responses).find(k => String(cfg.url).includes(k))
      if (hit === undefined) { if (cfg.failure) { cfg.failure({}) } return }
      const body = ajax.responses[hit]
      if (body === null) { if (cfg.failure) { cfg.failure({}) } return }
      if (cfg.success) { cfg.success({ responseText: JSON.stringify(body) }) }
    },
  },
  decode: t => JSON.parse(t),
}

/** What Ext.Ajax hands back, keyed by a substring of the URL. */
const ajax = { responses: {} }

/** The most recently opened, still-open window. */
function openWindow() {
  for (let i = created.windows.length - 1; i >= 0; i--) {
    if (!created.windows[i].destroyed) { return created.windows[i] }
  }
  return null
}

/** Find a component by its `cls` where no itemId reaches (the wizard's
 * "Add archive" and per-row "LUN…" buttons carry only a class). */
function findCmp(cmp, cls) {
  if (!cmp || cmp.destroyed) { return null }
  if (cmp.cls === cls) { return cmp }
  for (const kid of cmp.childCmps()) {
    const hit = findCmp(kid, cls)
    if (hit) { return hit }
  }
  return null
}

// ============================================================================
//  The ANAS surface the sources call
// ============================================================================

const warnings = []
/** Every job the UI submitted: method, path and the exact body. */
const jobs = []
/** Every plain Ext.Msg.confirm the UI asked (title + message) — the confirmAndRun
 * flow is recorded on the JOB instead (confirmWindow/extraItems), so a check can
 * tell a plain confirm from a confirm-code flow. */
const confirms = []
/** Every GET the UI issued, with its query — the read-contract record. */
const apiGets = []
/** Every toast the UI raised (message) — the run-completion channel. */
const toasts = []
/** Every Ext.Msg.alert the UI opened (title + message) — a MODAL. A check
 * asserting "no modal" counts these; a confirmAndRun confirm is NOT one. */
const alerts = []

/** The real autofill opt-out from 00-core.js — every credential dialog
 * references it while building its fields, so the fake must mirror it. */
const noAutofill = (() => {
  const sandbox = { window: {} }
  vm.runInNewContext(readFileSync(join(SRC, '00-core.js'), 'utf8'), sandbox, { filename: '00-core.js' })
  return sandbox.window.ANAS.noAutofill
})()

function makeAnas(routes) {
  return {
    views: {},
    noAutofill,
    pools: { registerAction(a) { this._actions = (this._actions || []).concat([a]) }, reload() {} },
    datasets: {},
    // The Datasets view degrades gracefully without the gfx layer (every call
    // site checks gfxReady first), and this harness is about what the dialogs
    // SEND, not what they draw — so gfx stays absent here on purpose.
    formatBytes: n => `${Number(n) || 0} B`,
    formatBool: b => (b ? 'on' : 'off'),
    editWindow: () => null,
    t: s => s,
    enc: s => String(s == null ? '' : s),
    warn(m) { warnings.push(m) },
    errText: e => String((e && e.message) || e),
    toast(m) { toasts.push(m) },
    // The real save gate from 10-api.js — the iSCSI target dialog blocks Save
    // on it (a create with zero ACLs), so the stub mirrors its state machine:
    // state on the window, reason() the first live block, refresh() mirrored
    // onto the #submit button and the #guardNote component.
    editGuard: {
      reason(win) {
        const blocks = win._saveBlocks || {}
        for (const k of Object.keys(blocks)) { if (blocks[k]) { return blocks[k] } }
        return ''
      },
      refresh(win) {
        const reason = this.reason(win)
        const btn = win.down('#submit')
        if (btn) { btn.setDisabled(!!reason) }
        const note = win.down('#guardNote')
        if (note) {
          note.setHidden(!reason)
          note.setHtml(reason
            ? `<div style="color:var(--anas-danger,#c23b2c);font-size:12px;">${reason}</div>`
            : '')
        }
      },
      block(win, key, reason) {
        win._saveBlocks = win._saveBlocks || {}
        win._saveBlocks[key] = reason
        this.refresh(win)
      },
      unblock(win, key) {
        if (win._saveBlocks) { delete win._saveBlocks[key] }
        this.refresh(win)
      },
      noteCfg() {
        return { xtype: 'component', itemId: 'guardNote', cls: 'anas-edit-guard', hidden: true, margin: '0 0 8 0', html: '' }
      },
    },
    alertMsg(title, msg) { warnings.push(`alert: ${title}: ${msg}`) },
    errorPanel: msg => ({ xtype: 'component', html: msg }),
    // The real 00-core.js helper (this stub stands in for it) — every tbar is
    // a toolbar config object, and build() materialises its items.
    tbar: items => ({ xtype: 'toolbar', items }),
    // The real 00-core.js helper: a `<ul><li>` per line. Rendered for real
    // here (not '') so a check can assert WHICH lines ride an alert or a
    // detail block — a stub that swallows the list would prove nothing about
    // the content.
    warningsHtml(lines) {
      const list = Array.isArray(lines) ? lines : [lines]
      return '<ul>' + list.map(l => `<li>${String(l == null ? '' : l)}</li>`).join('') + '</ul>'
    },
    renderState: s => String(s),
    notifyMode: {
      of(value, dflt) {
        const s = String(value == null ? '' : value).toLowerCase()
        if (s === 'always') { return 'always' }
        if (s === 'on-failure') { return 'on-failure' }
        return dflt === 'always' ? 'always' : 'on-failure'
      },
      field: cfg => ({ xtype: 'combobox', itemId: cfg.itemId, cls: cfg.cls, value: cfg.value }),
      hintHtml: () => '',
      rowHtml: () => '',
    },
    api: {
      get(_node, path) {
        // Recorded so a check can assert the exact QUERY a dialog sent — which
        // is the whole contract for a two-call read like backup2.5's groups
        // endpoint (`?ns=` for the groups, `?group=` for that group's points in
        // time). A route value may be a FUNCTION of the full path for the same
        // reason: one key, two answers.
        apiGets.push(path)
        const key = `GET ${path.split('?')[0]}`
        if (!(key in routes)) { return Promise.reject(new Error(`unexpected ${key}`)) }
        const value = routes[key]
        return Promise.resolve(typeof value === 'function' ? value(path) : value)
      },
      post(_node, path, body) {
        const key = `POST ${path}`
        if (!(key in routes)) { return Promise.reject(new Error(`unexpected ${key}`)) }
        return Promise.resolve(typeof routes[key] === 'function' ? routes[key](body) : routes[key])
      },
      put(_node, path, body) {
        const key = `PUT ${path}`
        if (!(key in routes)) { return Promise.reject(new Error(`unexpected ${key}`)) }
        return Promise.resolve(typeof routes[key] === 'function' ? routes[key](body) : routes[key])
      },
      del(_node, path) {
        const key = `DELETE ${path}`
        if (!(key in routes)) { return Promise.reject(new Error(`unexpected ${key}`)) }
        return Promise.resolve(routes[key])
      },
    },
    runJob(cfg) {
      // The handler is kept on the record: a check can complete the job with a
      // RESULT of its own choosing (the auto-call below simulates the default
      // "finished, nothing to report").
      jobs.push({ method: cfg.method, path: cfg.path, body: cfg.body, onComplete: cfg.onComplete })
      if (cfg.onComplete) { cfg.onComplete({}) }
    },
    // A confirm-gated mutation. The real one only shows its window after the
    // daemon answers 409 with a code; here the SHAPE is what matters, so the
    // request is recorded along with the widget hooks a destructive dialog adds.
    confirmAndRun(cfg) {
      jobs.push({
        method: cfg.method,
        path: cfg.path,
        body: cfg.body,
        // The poll view is recorded so a check can assert a dialog that closes
        // itself on acceptance hands the poll a LONG-LIVED component, never the
        // dialog being closed (issue #48 — a dead view silences the failure
        // alert and every grid refresh).
        view: cfg.view,
        confirmWindow: !!cfg.confirmWindow,
        extraItems: cfg.extraItems,
        mapConfirm: cfg.mapConfirm,
      })
      if (cfg.onComplete) { cfg.onComplete({}) }
    },
    casWrite(cfg) { jobs.push({ method: 'cas', path: cfg && cfg.path, body: cfg && cfg.body }) },
  }
}

function loadSource(files, routes) {
  // Accepts one file or a list (a view may depend on a shared widget file, e.g.
  // 68-backup.js on 12-picker.js) — loaded into ONE sandbox in bundle order.
  return loadSources(Array.isArray(files) ? files : [files], routes)
}

/**
 * Load SEVERAL sources into one sandbox, sharing one ANAS object — which is how
 * the real page works. The Pools grid's toolbar is built from
 * `ANAS.pools.actions`, a list that `36-pool-export.js` and `37-pool-destroy.js`
 * push into; loading `30-pools.js` alone would produce a toolbar with no
 * Export/Destroy buttons to gate.
 */
function loadSources(files, routes) {
  const head = { appendChild() {} }
  const doc = {
    hidden: false,
    head,
    documentElement: head,
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    getElementsByTagName: () => [head],
    createTextNode: text => ({ text }),
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  }
  const win = { document: doc, ANAS: makeAnas(routes) }
  const sandbox = {
    window: win,
    document: doc,
    console,
    Promise,
    Date,
    Ext,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1 },
    clearTimeout: () => {},
  }
  for (const file of files)
    vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  return win.ANAS
}

/** Let the sources' promise chains settle. */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) { await new Promise(r => setImmediate(r)) }
}

// ============================================================================
//  1 + 2. Backup task: edit → Save, and the enable/disable toggle
// ============================================================================

// One task with EVERY BackupTask field set to a distinctive, non-default value:
// a default-valued field would round-trip by accident.
const CADENCE = { kind: 'biweekly', days: ['Sun'], time: '02:30', parity: 'odd' }
const TASK = {
  name: 'nightly-pictures',
  repository: 'pbs-main',
  namespace: 'anas/pictures',
  backupId: 'pictures',
  // Three archives so backup2.2's three `includeNested` states are all present:
  // an explicit `all`, an explicit path list, and — the one that matters most —
  // an archive that never chose, whose field must stay ABSENT through a save.
  archives: [
    { name: 'pictures', path: '/mnt/pictures', excludes: ['**/*.tmp', '**/cache'], includeNested: 'all' },
    { name: 'etc', path: '/etc', excludes: [], includeNested: ['/etc/pve'] },
    { name: 'srv', path: '/srv', excludes: [] },
    // backup2.4 — a BLOCK IMAGE with the LUN record it was picked at. Its
    // excludes/nested controls must be hidden AND disabled, and an untouched
    // edit must send `kind` and `lun` back verbatim.
    { name: 'lun0', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img', lun: { targetIqn: 'iqn.2026-08.anas:vmstore', index: 0 } },
  ],
  changeDetectionMode: 'metadata',
  retention: { keepLast: 3, keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 2 },
  notify: 'on-failure',
  // The cadence is authoritative; the schedule is what the daemon generates FROM
  // it, so the two agree exactly as a stored task's do.
  schedule: cadenceToOnCalendar(CADENCE),
  cadence: CADENCE,
  enabled: true,
  // Raised by hand on a node where metadata mode hoards descriptors — the field
  // no dialog control edits, and therefore the easiest one to drop.
  limitNofile: 65536,
}

/**
 * The wizard's LOCAL boundary scan (backup2.2). Real shape, real product-level
 * example: `/etc` has `/etc/pve` (pmxcfs) nested under it — the case that is
 * silently stored as an empty directory today.
 */
const NESTED_BY_PATH = {
  '/etc': [{ path: '/etc/pve', relativePath: 'pve', kind: 'pmxcfs', fstype: 'fuse' }],
  '/mnt/pictures': [{ path: '/mnt/pictures/raw', relativePath: 'raw', kind: 'dataset', fstype: 'zfs' }],
  '/srv': [{ path: '/srv/nfs', relativePath: 'nfs', kind: 'nfs', fstype: 'nfs4' }],
}

/** The daemon's own run-NOTICE line (backup2 fix-ups) — the product-level shape. */
const RUN_NOTICE = "archive 'etc': nested filesystem /etc/pve (pmxcfs) is NOT included - it is backed up as an empty directory"

/**
 * backup2.3 — the DERIVED consistency the daemon attaches to the SAME scan.
 * READ-ONLY: it appears in the response, never in a request body. `/mnt/pictures`
 * is a ZFS dataset (snapshot-capable); `/etc` sits on the ext4 root and `/srv`
 * likewise, so both are honestly live.
 */
const CONSISTENCY_BY_PATH = {
  '/mnt/pictures': {
    consistency: 'snapshot',
    reason: '/mnt/pictures is on the ZFS dataset tank/pictures; the run takes a recursive snapshot',
    backend: 'zfs',
    target: 'tank/pictures',
    mountpoint: '/mnt/pictures',
    relativePath: '',
  },
  '/etc': {
    consistency: 'live',
    reason: '/etc is on /dev/sda1 (ext4), which has no snapshot mechanism ANAS can drive - the backup is live',
  },
  '/srv': {
    consistency: 'live',
    reason: '/srv is on /dev/sda1 (ext4), which has no snapshot mechanism ANAS can drive - the backup is live',
  },
  // backup2.4 — a zvol answers through its snapshot DEVICE, not a `.zfs` path.
  '/dev/zvol/tank/vol1': {
    consistency: 'snapshot',
    reason: '/dev/zvol/tank/vol1 is the ZFS volume tank/vol1; the run snapshots the volume and reads the snapshot device (snapdev is published for the run and restored afterwards)',
    backend: 'zfs',
    target: 'tank/vol1',
    zvolDevice: '/dev/zvol/tank/vol1',
  },
}

/**
 * backup2.4 — what `GET /backup/lun-sources` returns: the read layer's
 * backup-eligible LUNs, already filtered (nothing foreign, nothing PVE-owned)
 * and carrying each one's derived consistency.
 */
const LUN_SOURCES = [
  {
    targetIqn: 'iqn.2026-08.anas:vmstore',
    index: 0,
    name: 'tank_vol1',
    kind: 'zvol',
    path: '/dev/zvol/tank/vol1',
    serial: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
    size: 2147483648,
    backingExists: true,
    consistency: CONSISTENCY_BY_PATH['/dev/zvol/tank/vol1'],
  },
  {
    targetIqn: 'iqn.2026-08.anas:vmstore',
    index: 1,
    name: 'tank_lun2',
    kind: 'file',
    path: '/tank/images/lun2.raw',
    serial: '689844a4-1d20-4cba-8516-bdc52a402645',
    size: 1073741824,
    backingExists: true,
  },
]

/**
 * Every preview-nested body sent (the endpoint must be user-driven). Two
 * shapes are user-driven: the wizard's boundary check (the `path:` form), and
 * the Details window OPENING — the operator's action — which loads the task's
 * boundary scan progressively (the `archives:` form, one entry per archive).
 */
const nestedPreviews = []

/**
 * The preview-nested answer for a body — the wizard's single-path form, or the
 * Details window's per-archive form (one scan per requested archive,
 * index-aligned, an `img` answered "no boundaries" exactly like the daemon's
 * `scanArchives`). Both forms answer `exists: true` here: this is a route
 * mock of the success path, not a missing-path fixture.
 */
function nestedPreviewResponse(body) {
  const scan = (path, choice, kind) => {
    const consistency = CONSISTENCY_BY_PATH[path]
    if (kind === 'img') {
      // The daemon skips the walk entirely for an img source.
      return {
        path,
        exists: true,
        includeNested: 'none',
        nested: [],
        truncated: false,
        warnings: [],
        ...(consistency ? { consistency } : {}),
      }
    }
    const found = NESTED_BY_PATH[path] || []
    const covers = p => choice === 'all' || (Array.isArray(choice) && choice.indexOf(p) >= 0)
    return {
      path,
      exists: true,
      includeNested: choice,
      nested: found.map(n => ({ ...n, included: covers(n.path) })),
      truncated: false,
      warnings: [],
      ...(consistency ? { consistency } : {}),
    }
  }
  const archives = (body && body.archives) || []
  return {
    data: {
      archives: archives.length
        ? archives.map(a => (a.name
          ? { archive: a.name, ...scan(a.path, a.includeNested || 'none', a.kind) }
          : scan(a.path, a.includeNested || 'none', a.kind)))
        : [scan(body && body.path, (body && body.includeNested) || 'none', body && body.kind)],
    },
  }
}

function nestedPreviewRoute(body) {
  nestedPreviews.push(body)
  return nestedPreviewResponse(body)
}

/**
 * backup2.9 — the one block-task shape the wizard writes: the stored kind,
 * the fixed archive name, the LUN record, and the id DERIVED from the LUN's
 * serial (pinned through the shared helper, not a re-typed literal).
 */
const BLOCK_TASK = {
  name: 'lun-disk',
  repository: 'pbs-main',
  backupId: lunBackupId(LUN_SOURCES[0].serial),
  kind: 'block',
  archives: [{
    name: BLOCK_ARCHIVE_NAME,
    path: LUN_SOURCES[0].path,
    excludes: [],
    kind: 'img',
    lun: { targetIqn: LUN_SOURCES[0].targetIqn, index: LUN_SOURCES[0].index },
  }],
  changeDetectionMode: 'default',
  schedule: 'daily',
  enabled: true,
}

/**
 * A block task whose `lun` record points at a LIVE LUN on the iscsi screen
 * (`iqn.2026-08.nas.anas:vmstore` LUN 0) — the "This LUN" resolution keys on the
 * real identity, not the backup-side LUN_SOURCES iqn, so the restore door gets
 * the in-place destination. Driven directly with a prefill (not the grid).
 */
const LIVE_BLOCK_TASK = {
  name: 'live-lun',
  repository: 'pbs-main',
  backupId: lunBackupId(LUN_SOURCES[0].serial),
  kind: 'block',
  archives: [{
    name: BLOCK_ARCHIVE_NAME,
    path: '/dev/zvol/tank/vol1',
    excludes: [],
    kind: 'img',
    lun: { targetIqn: 'iqn.2026-08.nas.anas:vmstore', index: 0 },
  }],
  changeDetectionMode: 'default',
  schedule: 'daily',
  enabled: true,
}

/**
 * backup2.9 — a block task whose `lun` record maps to a LUN this node does NOT
 * serve (the LUN is gone, or was never here). The unified dialog then offers
 * ONLY "A new LUN…" — "This LUN" exists only when the source maps to a live LUN.
 */
const STRAY_LUN_TASK = {
  name: 'stray-lun',
  repository: 'pbs-main',
  backupId: 'stray',
  kind: 'block',
  archives: [{
    name: BLOCK_ARCHIVE_NAME,
    path: '/dev/zvol/tank/volX',
    excludes: [],
    kind: 'img',
    lun: { targetIqn: LUN_SOURCES[0].targetIqn, index: 9 },
  }],
  changeDetectionMode: 'default',
  schedule: 'daily',
  enabled: true,
}

/**
 * backup2.9 — the operator's first LUN backup (2026-08-26): one img archive
 * with its record, NO stored kind, a hand-chosen id. It derives as a block
 * task, but an untouched edit must send NO `kind` key and keep the stored id
 * and group verbatim — the daemon's serial guard would refuse the claim.
 */
const LEGACY_LUN_TASK = {
  name: 'legacy-lun',
  repository: 'pbs-main',
  backupId: 'vmstore',
  archives: [{
    name: 'lun0',
    path: LUN_SOURCES[0].path,
    excludes: [],
    kind: 'img',
    lun: { targetIqn: LUN_SOURCES[0].targetIqn, index: LUN_SOURCES[0].index },
  }],
  schedule: 'daily',
  enabled: true,
}

const BACKUP_ROUTES = {
  'GET /backup/repos': { data: { version: 1, repos: [{ name: 'pbs-main', datastore: 'store1', source: 'anas' }] } },
  'GET /backup/tasks': {
    data: [
      { task: TASK, lastRunResult: 'success', enabled: true },
      { task: BLOCK_TASK, lastRunResult: 'success', lastRunAt: '2026-08-27T02:00:00Z', nextRunAt: null, overdue: false, lunName: LUN_SOURCES[0].name },
      { task: LEGACY_LUN_TASK, lastRunResult: 'failure', lastRunAt: '2026-08-26T02:00:00Z', nextRunAt: null, overdue: false, lunName: LUN_SOURCES[0].name },
    ],
  },
  'GET /mounts': { data: [] },
  'GET /pools': { data: [] },
  'POST /backup/tasks/preview-nested': nestedPreviewRoute,
  'GET /backup/lun-sources': { data: { installed: true, luns: LUN_SOURCES } },
  'GET /fs/browse': path => ({ data: { exists: true, path } }),
}

/**
 * Per-key check of a captured body against TASK. The DEFAULT is a deep compare,
 * so a NEW BackupTask field the dialogs do not carry fails automatically — that
 * is the class guard. Only the two keys with a documented wire alias override it.
 */
const FIELD_CHECKS = {
  // The UI sends `changeDetectionMode` AND the legacy `mode` alias; the daemon
  // prefers the former.
  changeDetectionMode: (body, want) => (body.changeDetectionMode || body.mode) === want,
  // A structured cadence is authoritative: the daemon GENERATES the OnCalendar
  // from it, so a body carrying the cadence need not carry the expression.
  schedule: (body, want) => body.schedule === want
    || (body.cadence ? cadenceToOnCalendar(body.cadence) === want : false),
}

function sweepFields(label, body, want) {
  const keys = Object.keys(BackupTask.shape)
  ok(`${label}: the schema still has fields to sweep`, keys.length > 5, `${keys.length} keys`)
  for (const key of keys) {
    const check = FIELD_CHECKS[key]
    if (check) {
      ok(`${label}: ${key} survives`, check(body, want[key]), `body ${JSON.stringify(body[key])}`)
    }
    else {
      eq(`${label}: ${key} survives`, body[key], want[key])
    }
  }
}

async function backupChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  // afterrender is what the PVE UI fires on the real view; it loads the grid.
  view.fireEvent('afterrender', view)
  await settle()

  const grid = view.down('#backupGrid')
  ok('backup: the grid loaded all three tasks', grid && grid.getStore().getCount() === 3)
  const rec = grid.selectRow(0)
  ok('backup: the row carries the raw task', rec && rec.get('raw') && rec.get('raw').name === TASK.name)
  ok('backup: selecting a row enables Edit', grid.down('#backupEdit').disabled === false)

  // --- 0c. backup2.9 — the grid's Kind column + the LUN's live name ---------
  const kindCol = (grid.columns || []).find(c => c.dataIndex === 'kind')
  const lunCol = (grid.columns || []).find(c => c.dataIndex === 'lunName')
  ok('backup: the grid has a Kind column', !!kindCol)
  ok('backup: the grid has a LUN column', !!lunCol)
  if (kindCol && lunCol) {
    const rowFiles = grid.getStore().getAt(0) // TASK: derived files, mixed legacy
    const rowBlock = grid.getStore().getAt(1) // BLOCK_TASK: stored block
    const rowLegacy = grid.getStore().getAt(2) // LEGACY_LUN_TASK: derived block
    eq('backup: a pre-backup2.9 mixed task reads as files', rowFiles.get('kind'), 'files')
    eq('backup: a stored-block task reads as block', rowBlock.get('kind'), 'block')
    eq('backup: a pre-backup2.9 single-image task DERIVES as block', rowLegacy.get('kind'), 'block')
    ok('backup: the files row renders no LUN (a dash, not a state)',
      /&mdash;|&mdash|—/.test(lunCol.renderer(rowFiles.get('lunName'), {}, rowFiles)),
      lunCol.renderer(rowFiles.get('lunName'), {}, rowFiles))
    ok('backup: the block row shows the LUN\'s LIVE name',
      lunCol.renderer(rowBlock.get('lunName'), {}, rowBlock).includes(LUN_SOURCES[0].name),
      lunCol.renderer(rowBlock.get('lunName'), {}, rowBlock))
    ok('backup: a block task whose LUN no longer resolves says so',
      /no longer resolvable/i.test(lunCol.renderer(null, {}, { get: k => (k === 'kind' ? 'block' : null) })))
    ok('backup: a files task never shows the "unresolvable" state',
      !/no longer resolvable/i.test(lunCol.renderer(undefined, {}, { get: k => (k === 'kind' ? 'files' : undefined) })))
  }

  // --- 0b. A DISABLED task has no run result to show (live-proof F9) --------
  // systemd unloads a disabled unit nothing references and answers from
  // property defaults (`Result=success`, empty timestamps), so the grid read
  // "success / never" no matter what had happened — including after a failure.
  const lastRunCol = (grid.columns || []).find(c => c.dataIndex === 'lastRunResult')
  ok('backup: the grid has a Last run column', !!lastRunCol)
  const disabledRec = {
    get: (k) => ({ lastRunResult: 'disabled', lastRunAt: null, overdue: false }[k]),
  }
  const disabledCell = lastRunCol.renderer('disabled', {}, disabledRec)
  ok('backup: a disabled task reads "disabled", never a fabricated success',
    /disabled/.test(disabledCell) && !/success/.test(disabledCell), disabledCell)
  ok('backup: and it explains that systemd keeps no history for one',
    /run history|does not keep the run history/i.test(disabledCell), disabledCell)
  // The enabled twin of F9: the timer keeps the unit loaded, so empty run
  // timestamps mean an ENABLED task has never fired — the default-valued
  // Result=success must not read as a successful run that never happened.
  const neverRunRec = {
    get: (k) => ({ lastRunResult: 'never-run', lastRunAt: null, overdue: false }[k]),
  }
  const neverRunCell = lastRunCol.renderer('never-run', {}, neverRunRec)
  ok('backup: a never-run task reads "never run", never a fabricated success',
    /never run/.test(neverRunCell) && !/success/.test(neverRunCell), neverRunCell)
  ok('backup: and it says so in plain words',
    /has not run yet/.test(neverRunCell), neverRunCell)
  const successCell = lastRunCol.renderer('success', {}, {
    get: (k) => ({ lastRunResult: 'success', lastRunAt: null, overdue: false }[k]),
  })
  ok('backup: an enabled task still reads success', /success/.test(successCell), successCell)

  // --- 1. Edit → Save ---
  jobs.length = 0
  const editBtn = grid.down('#backupEdit')
  editBtn.handler(editBtn)
  await settle()
  const dlg = openWindow()
  ok('backup: the edit dialog opened', !!dlg)
  ok('backup: the dialog opened on the task', dlg && dlg.down('#name').getValue() === TASK.name)
  const save = dlg.down('#taskSubmitBtn')
  save.handler(save)
  await settle()

  eq('backup: Save is a PUT of the whole task', jobs.length && jobs[0].method, 'put')
  eq('backup: Save targets the task', jobs.length && jobs[0].path, `/backup/tasks/${TASK.name}`)
  if (jobs.length) { sweepFields('edit→save', jobs[0].body, TASK) }
  // backup2.9 — the kind rule the whole story hinges on: TASK predates the
  // field (and its derived kind is `files` anyway), so an untouched edit sends
  // NO `kind` key at all — the unit rewrites byte-for-byte. (sweepFields cannot
  // see a key present-with-undefined: JSON.stringify drops it, so the `in` test
  // is what actually guards it.)
  if (jobs.length) {
    ok('backup: an untouched pre-backup2.9 edit sends NO `kind` key',
      !('kind' in jobs[0].body), JSON.stringify(jobs[0].body))
  }

  // --- 2. Enable / disable ---
  jobs.length = 0
  const toggle = grid.down('#backupToggle')
  toggle.handler(toggle)
  await settle()
  eq('backup: the toggle is a PUT of the whole task', jobs.length && jobs[0].method, 'put')
  if (jobs.length) {
    sweepFields('toggle', jobs[0].body, { ...TASK, enabled: !TASK.enabled })
  }

  ok('backup: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1b. backup2.2 — includeNested: set / clear / keep, and the untouched edit
// ============================================================================

/** The archive editor rows of an open task dialog, in order. */
function archiveRows(dlg) {
  const cont = dlg.down('#archivesContainer')
  return cont ? cont.items.getRange() : []
}

/** Open the task dialog fresh from the grid's Edit button. */
async function openEdit(grid) {
  const editBtn = grid.down('#backupEdit')
  editBtn.handler(editBtn)
  await settle()
  return openWindow()
}

/** Press Save and hand back the body the dialog sent. */
async function save(dlg) {
  jobs.length = 0
  const btn = dlg.down('#taskSubmitBtn')
  btn.handler(btn)
  await settle()
  return jobs.length ? jobs[0].body : null
}

async function nestedChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  // --- KEEP: an untouched edit rewrites every archive exactly as stored ---
  nestedPreviews.length = 0
  let dlg = await openEdit(grid)
  let rows = archiveRows(dlg)
  eq('nested: the dialog built one row per archive', rows.length, TASK.archives.length)
  eq('nested: the stored `all` prefills as All', rows[0].down('#archNested').getValue(), 'all')
  eq('nested: a stored path list prefills as Choose…', rows[1].down('#archNested').getValue(), 'choose')
  eq('nested: the stored paths prefill verbatim', rows[1].down('#archNestedPaths').getValue(), '/etc/pve')
  eq('nested: an ABSENT choice prefills as None', rows[2].down('#archNested').getValue(), 'none')
  ok('nested: the path list is hidden unless Choose… is picked', rows[2].down('#archNestedPaths').hidden === true)

  // The preview is user-driven and LOCAL: one call per row, carrying that row's
  // own path and its own choice. It is never a PBS contact.
  ok('nested: the wizard previewed every row', nestedPreviews.length >= TASK.archives.length,
    `${nestedPreviews.length} previews`)
  ok('nested: a preview carries the row path and choice',
    nestedPreviews.some(b => b.path === '/srv' && b.includeNested === 'none'),
    JSON.stringify(nestedPreviews))

  // The alert names what the current choice would silently omit.
  ok('nested: the None row alerts about the filesystem it would skip',
    /\/srv\/nfs/.test(rows[2].down('#archNestedAlert').html || '')
    && /empty directories/.test(rows[2].down('#archNestedAlert').html || ''),
    rows[2].down('#archNestedAlert').html)
  ok('nested: the alert names the KIND, not just the path',
    /NFS mount/.test(rows[2].down('#archNestedAlert').html || ''),
    rows[2].down('#archNestedAlert').html)
  ok('nested: a covered row does NOT alert',
    !/empty directories/.test(rows[0].down('#archNestedAlert').html || ''),
    rows[0].down('#archNestedAlert').html)
  ok('nested: a covered row still LISTS what is nested, with its kind',
    /\/mnt\/pictures\/raw/.test(rows[0].down('#archNestedAlert').html || '')
    && /child dataset/.test(rows[0].down('#archNestedAlert').html || ''),
    rows[0].down('#archNestedAlert').html)

  let body = await save(dlg)
  ok('nested: the untouched edit saved', !!body)
  eq('nested (keep): `all` survives untouched', body.archives[0].includeNested, 'all')
  eq('nested (keep): the path list survives untouched', body.archives[1].includeNested, ['/etc/pve'])
  ok('nested (keep): an archive that never chose sends NO key at all',
    !('includeNested' in body.archives[2]), JSON.stringify(body.archives[2]))

  // --- SET: None → All, and None → Choose… with a path ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[2].down('#archNested').setValue('all')
  await settle()
  body = await save(dlg)
  eq('nested (set): choosing All sends `all`', body.archives[2].includeNested, 'all')

  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[2].down('#archNested').setValue('choose')
  await settle()
  ok('nested (set): Choose… reveals the path list', rows[2].down('#archNestedPaths').hidden === false)
  rows[2].down('#archNestedPaths').setValue('/srv/nfs\n')
  await settle()
  body = await save(dlg)
  eq('nested (set): the typed paths are sent as a list', body.archives[2].includeNested, ['/srv/nfs'])

  // --- CLEAR: All → None sends NOTHING (archives are replaced wholesale, so an
  // omitted field IS the clear — and it is the same on-disk shape as absent) ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[0].down('#archNested').setValue('none')
  await settle()
  body = await save(dlg)
  ok('nested (clear): clearing to None sends no key',
    !('includeNested' in body.archives[0]), JSON.stringify(body.archives[0]))
  eq('nested (clear): the OTHER archives are untouched', body.archives[1].includeNested, ['/etc/pve'])

  // --- Choose… with an empty list is None, not an empty array ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[1].down('#archNestedPaths').setValue('')
  await settle()
  body = await save(dlg)
  ok('nested: an emptied Choose… list is None, never []',
    !('includeNested' in body.archives[1]), JSON.stringify(body.archives[1]))

  ok('nested: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1c. backup2.3 — the consistency chip is READ-ONLY, and nothing new is writable
// ============================================================================

async function consistencyChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  nestedPreviews.length = 0
  const dlg = await openEdit(grid)
  const rows = archiveRows(dlg)

  // --- The chip renders the DERIVED verdict, with the daemon's own reason ---
  const picturesAlert = rows[0].down('#archNestedAlert').html || ''
  ok('consistency: a ZFS source shows the `snapshot` chip',
    />snapshot</.test(picturesAlert), picturesAlert)
  ok('consistency: the chip carries the daemon\'s reason as its tooltip',
    picturesAlert.includes('recursive snapshot'), picturesAlert)

  const etcAlert = rows[1].down('#archNestedAlert').html || ''
  ok('consistency: a non-snapshottable source shows the `live` chip',
    />live</.test(etcAlert), etcAlert)
  ok('consistency: the live chip explains WHY, verbatim from the daemon',
    etcAlert.includes('no snapshot mechanism'), etcAlert)

  // --- The expansion preview line: N nested filesystems -> N+1 archives ---
  // Archive 0 is `all` over a ZFS source with one nested child dataset.
  ok('consistency: a snapshot source with an included child previews the expansion',
    /1 nested filesystem → 2 archives/.test(picturesAlert), picturesAlert)
  // A LIVE source expands into nothing, whatever its choice — the line is absent.
  ok('consistency: a live source shows NO expansion preview',
    !/→ \d+ archives/.test(etcAlert), etcAlert)

  // --- READ-ONLY: no control exists for it, and no save carries it ---
  ok('consistency: the archive row has no consistency control at all',
    !rows[0].down('#archConsistency'), 'a control would make a derived fact editable')

  const body = await save(dlg)
  ok('consistency: an untouched save still produced a body', !!body)
  for (let i = 0; i < body.archives.length; i++) {
    ok(`consistency: archive ${i} sends no consistency key`,
      !('consistency' in body.archives[i]), JSON.stringify(body.archives[i]))
    ok(`consistency: archive ${i} sends no snapshot/expansion key`,
      !('snapshots' in body.archives[i]) && !('expansion' in body.archives[i]),
      JSON.stringify(body.archives[i]))
  }
  ok('consistency: the task body itself carries no derived key',
    !('consistency' in body) && !('snapshots' in body) && !('expansion' in body),
    Object.keys(body).join(','))
  // The class guard: an untouched edit is still byte-for-byte the stored task.
  sweepFields('consistency: untouched edit', body, TASK)

  ok('consistency: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1d. backup2.4 — archive kind: what an `img` row shows, disables and SENDS
// ============================================================================

async function imageKindChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  nestedPreviews.length = 0
  let dlg = await openEdit(grid)
  let rows = archiveRows(dlg)
  eq('kind: the dialog built one row per archive', rows.length, TASK.archives.length)

  // --- The stored kind prefills, and absent prefills as Files ---
  eq('kind: a stored `img` prefills as Block image', rows[3].down('#archKind').getValue(), 'img')
  eq('kind: an ABSENT kind prefills as Files', rows[0].down('#archKind').getValue(), 'pxar')
  eq('kind: the archive-name suffix follows the kind', rows[3].down('#archSuffix').html, '.img')
  eq('kind: a file archive still shows .pxar', rows[0].down('#archSuffix').html, '.pxar')

  // --- The controls that do not apply are hidden AND disabled ---
  ok('kind(img): excludes are hidden', rows[3].down('#archExcludes').hidden === true)
  ok('kind(img): excludes are DISABLED, so a stale value cannot be read back',
    rows[3].down('#archExcludes').disabled === true)
  ok('kind(img): the nested choice is hidden', rows[3].down('#archNested').hidden === true)
  ok('kind(img): the nested choice is DISABLED', rows[3].down('#archNested').disabled === true)
  ok('kind(img): the nested path list is hidden', rows[3].down('#archNestedPaths').hidden === true)
  ok('kind(img): the LUN button is shown', rows[3].down('#archLun').hidden === false)
  ok('kind(img): the directory Browse button is hidden', rows[3].down('#archBrowse').hidden === true)
  ok('kind(pxar): the LUN button is hidden', rows[0].down('#archLun').hidden === true)
  ok('kind(pxar): excludes stay enabled', rows[0].down('#archExcludes').disabled === false)

  // --- The two honest statements, and the LUN identity ---
  const note = rows[3].down('#archImageNote').html || ''
  ok('kind(img): the row states that every run reads the full image',
    /every run reads the full image/i.test(note), note)
  ok('kind(img): and that the change-detection mode does not apply',
    /change-detection mode does not apply/i.test(note), note)
  ok('kind(img): and that a live LUN backup is crash-consistent',
    /crash-consistent/i.test(note), note)
  ok('kind(img): the LUN identity is shown in full, never truncated',
    note.includes('iqn.2026-08.anas:vmstore') && /LUN 0/.test(note), note)
  eq('kind(pxar): a file archive shows no image note', rows[0].down('#archImageNote').html || '', '')

  // --- The preview for an image row says `img` and asks for no walk ---
  ok('kind(img): the preview carries kind:img for the image row',
    nestedPreviews.some(b => b.path === '/dev/zvol/tank/vol1' && b.kind === 'img'),
    JSON.stringify(nestedPreviews))
  ok('kind(pxar): a file row still sends NO kind at all',
    nestedPreviews.filter(b => b.path === '/srv').every(b => !('kind' in b)),
    JSON.stringify(nestedPreviews))
  const imgAlert = rows[3].down('#archNestedAlert').html || ''
  ok('kind(img): the consistency chip is shown for an image source',
    />snapshot</.test(imgAlert), imgAlert)
  ok('kind(img): an image row never claims a nested filesystem',
    !/empty directories/.test(imgAlert), imgAlert)

  // --- KEEP: an untouched edit round-trips kind AND lun verbatim ---
  let body = await save(dlg)
  ok('kind: the untouched edit saved', !!body)
  eq('kind (keep): `img` survives untouched', body.archives[3].kind, 'img')
  eq('kind (keep): the LUN record survives untouched', body.archives[3].lun,
    { targetIqn: 'iqn.2026-08.anas:vmstore', index: 0 })
  ok('kind (keep): a file archive sends NO kind key at all',
    !('kind' in body.archives[0]), JSON.stringify(body.archives[0]))
  ok('kind (keep): a file archive sends NO lun key at all',
    !('lun' in body.archives[0]), JSON.stringify(body.archives[0]))
  // The class guard: an untouched edit is still byte-for-byte the stored task.
  sweepFields('kind: untouched edit', body, TASK)

  // --- SET: Files → Block image sends `kind`, and nothing that cannot apply ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[0].down('#archKind').setValue('img')
  await settle()
  ok('kind (set): switching to Block image disables the nested choice',
    rows[0].down('#archNested').disabled === true)
  body = await save(dlg)
  eq('kind (set): the switched archive sends kind:img', body.archives[0].kind, 'img')
  eq('kind (set): its excludes are dropped — they do not apply to an image',
    body.archives[0].excludes, [])
  ok('kind (set): and its nested choice is dropped too',
    !('includeNested' in body.archives[0]), JSON.stringify(body.archives[0]))
  ok('kind (set): no LUN is invented for a hand-typed path',
    !('lun' in body.archives[0]), JSON.stringify(body.archives[0]))

  // --- CLEAR: Block image → Files sends NO kind, and drops the LUN record ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[3].down('#archKind').setValue('pxar')
  await settle()
  body = await save(dlg)
  ok('kind (clear): switching back to Files sends no kind key',
    !('kind' in body.archives[3]), JSON.stringify(body.archives[3]))
  ok('kind (clear): the LUN record goes with it',
    !('lun' in body.archives[3]), JSON.stringify(body.archives[3]))
  eq('kind (clear): the OTHER archives are untouched', body.archives[1].includeNested, ['/etc/pve'])

  // --- The LUN record follows the PATH: retype it and the record is dropped ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[3].down('#archPath').setValue('/dev/zvol/tank/other')
  await settle()
  body = await save(dlg)
  eq('kind: a retyped path keeps the image kind', body.archives[3].kind, 'img')
  ok('kind: but the stale LUN record is NOT sent (the path is a different source)',
    !('lun' in body.archives[3]), JSON.stringify(body.archives[3]))

  // --- A typed `.img` suffix is stripped, exactly as `.pxar` always was ---
  dlg = await openEdit(grid)
  rows = archiveRows(dlg)
  rows[3].down('#archName').setValue('lun0.img')
  await settle()
  body = await save(dlg)
  eq('kind: a typed .img suffix is stripped, never doubled', body.archives[3].name, 'lun0')

  ok('kind: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1e. backup2.4 — the LUN picker fills the path and records the LUN
// ============================================================================

async function lunPickerChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  const dlg = await openEdit(grid)
  const rows = archiveRows(dlg)

  // Open the picker from the image row's LUN button.
  const lunBtn = rows[3].down('#archLun')
  lunBtn.handler(lunBtn)
  await settle()
  const picker = openWindow()
  ok('picker: the LUN picker window opened', !!picker && !!picker.down('#lunGrid'))
  if (!picker) { return }

  const lunGrid = picker.down('#lunGrid')
  eq('picker: it listed the daemon\'s LUN sources', lunGrid.getStore().getCount(), LUN_SOURCES.length)
  ok('picker: the IQN column is present and never truncated',
    (lunGrid.columns || []).some(col => col.dataIndex === 'targetIqn'))
  ok('picker: the serial is on screen', (lunGrid.columns || []).some(col => col.dataIndex === 'serial'))
  ok('picker: the derived consistency is on screen',
    (lunGrid.columns || []).some(col => col.dataIndex === 'consistency'))

  // Pick the FILE-backed LUN: a different path AND a different LUN number, so
  // neither can round-trip by accident.
  lunGrid.selectRow(1)
  const select = picker.buttonCmps.find(b => b.cls === 'anas-btn-backup-lun-select')
  ok('picker: the Select button exists', !!select)
  select.handler(select)
  await settle()

  eq('picker: it filled the path field', rows[3].down('#archPath').getValue(), '/tank/images/lun2.raw')
  const body = await save(dlg)
  eq('picker: the saved path is the picked one', body.archives[3].path, '/tank/images/lun2.raw')
  eq('picker: and the LUN record is the picked one', body.archives[3].lun,
    { targetIqn: 'iqn.2026-08.anas:vmstore', index: 1 })
  eq('picker: the archive is still a block image', body.archives[3].kind, 'img')

  ok('picker: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  1f. backup2.9 — a task is FILES or BLOCK, chosen first
// ============================================================================
//
// The contract this section pins:
//  - a new task starts at the kind choice (files is the default), and choosing
//    block turns the dialog into the LUN panel — the picker and nothing else;
//  - a block task's identity IS the LUN's serial: `lun-<serial>`, derived from
//    the pick and read-only (pinned to the shared lunBackupId), and its single
//    archive is `disk` at the LUN's path (pinned to the shared
//    BLOCK_ARCHIVE_NAME);
//  - file archive names derive from the path's last segment at creation (pinned
//    to the shared deriveArchiveName) — shown, not editable — and are NEVER
//    re-derived on an edit: the name is the change-detection key;
//  - the edit dialog keeps the kind as STORED: a pre-backup2.9 single-image
//    task edits as block but sends NO `kind` back (the daemon's serial guard
//    must never fire on its hand-chosen id); a stored block task sends
//    `kind: 'block'` verbatim and keeps its stored archive name.

async function backupTaskKindChecks() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')

  // --- 1. New task: the kind is chosen first, and block is a different shape ---
  created.windows.length = 0
  ANAS.backup.openNewTask(view, 'harness', null)
  await settle()
  let wiz = openWindow()
  ok('kind: the plain door opens the NEW-task wizard',
    !!wiz && /New Backup Task/.test(wiz.title || ''), wiz && wiz.title)
  const kindGroup = wiz && wiz.down('#kindGroup')
  ok('kind: a new task shows the kind choice', !!kindGroup && kindGroup.hidden === false)
  eq('kind: …and it opens on files', kindGroup && kindGroup.getValue(), { taskKind: 'files' })
  ok('kind: the files panel (the archive list) is the shape it opens on',
    !!wiz && wiz.down('#filesPanel').hidden === false)
  ok('kind: the block panel waits until it is chosen',
    !!wiz && wiz.down('#blockPanel').hidden === true)

  kindGroup.setValue('block')
  await settle()
  ok('kind: choosing block hides the archive list', wiz.down('#filesPanel').hidden === true)
  ok('kind: …and the change-detection fieldset (a no-op for images)',
    wiz.down('#modePanel').hidden === true)
  ok('kind: …and shows the block panel', wiz.down('#blockPanel').hidden === false)
  ok('kind: with no pick yet, the panel says so — not a blank',
    /No LUN chosen\./.test(wiz.down('#blockLunOut').html || ''))
  ok('kind: the id field is not locked without a pick',
    wiz.down('#backupId').readOnly === false)

  // The picker is the panel's one input.
  findCmp(wiz, 'anas-btn-backup-block-lun').handler()
  await settle()
  const picker = openWindow()
  ok('kind: the block panel opens the same LUN picker the rows use',
    !!picker && /iSCSI LUN/.test(picker.title || ''), picker && picker.title)
  picker.down('#lunGrid').selectRow(0)
  picker.buttonCmps.find(b => b.cls === 'anas-btn-backup-lun-select').handler()
  await settle()

  const outHtml = wiz.down('#blockLunOut').html || ''
  ok("kind: the pick's facts are on screen (name, full IQN, LUN number, path)",
    outHtml.includes(LUN_SOURCES[0].name)
    && outHtml.includes(LUN_SOURCES[0].targetIqn)
    && outHtml.includes('LUN 0')
    && outHtml.includes(LUN_SOURCES[0].path), outHtml)
  ok('kind: the snapshot consistency chip comes with the pick',
    /snapshot/.test(outHtml), outHtml)
  eq('kind: the backup-id is DERIVED from the serial (shared lunBackupId)',
    wiz.down('#backupId').getValue(), lunBackupId(LUN_SOURCES[0].serial))
  ok('kind: …and the field locks — the group IS the LUN',
    wiz.down('#backupId').readOnly === true)
  eq('kind: the archive name is the fixed block name (shared BLOCK_ARCHIVE_NAME)',
    wiz.down('#blockArchiveName').getValue(), BLOCK_ARCHIVE_NAME)
  ok('kind: the archive name is shown, not editable',
    wiz.down('#blockArchiveName').readOnly === true)

  jobs.length = 0
  wiz.down('#name').setValue('lun-disk')
  wiz.down('#schedule').setValue('daily')
  wiz.down('#taskSubmitBtn').handler(wiz.down('#taskSubmitBtn'))
  await settle()
  ok('kind: a block create POSTs one task', jobs.length === 1
    && jobs[0].method === 'post' && jobs[0].path === '/backup/tasks',
    JSON.stringify(jobs[0] && [jobs[0].method, jobs[0].path]))
  if (jobs.length) {
    const body = jobs[0].body
    eq('kind: …claiming to be block', body.kind, 'block')
    eq('kind: …with the id derived from the pick', body.backupId, lunBackupId(LUN_SOURCES[0].serial))
    eq("kind: …with the single img archive at the LUN's path", body.archives, [{
      name: BLOCK_ARCHIVE_NAME,
      path: LUN_SOURCES[0].path,
      excludes: [],
      kind: 'img',
      lun: { targetIqn: LUN_SOURCES[0].targetIqn, index: LUN_SOURCES[0].index },
    }])
    eq('kind: …with no change detection (a block task stores the default)',
      [body.changeDetectionMode, body.mode], ['default', 'default'])
  }

  // --- 2. Files names: derived from the path at creation, shown not editable ---
  created.windows.length = 0
  ANAS.backup.openNewTask(view, 'harness', null)
  await settle()
  wiz = openWindow()
  let rows = archiveRows(wiz)
  eq('kind: the files wizard opens on the suggested etc row', rows.length, 1)
  ok('kind: the archive name is shown, not typed', rows[0].down('#archName').readOnly === true)

  // The suggested row came in NAMED: re-typing its path does not re-name it.
  rows[0].down('#archPath').setValue('/var/log')
  await settle()
  eq('kind: a named row keeps its name when its path moves',
    rows[0].down('#archName').getValue(), 'etc')

  const add = findCmp(wiz, 'anas-btn-backup-arch-add')
  add.handler(add)
  await settle()
  rows = archiveRows(wiz)
  let r = rows[1]
  r.down('#archPath').setValue('/mnt/pictures/raw')
  await settle()
  eq("kind: an unnamed row takes the path's last segment (shared deriveArchiveName)",
    r.down('#archName').getValue(), deriveArchiveName('/mnt/pictures/raw', ['etc']))
  r.down('#archPath').setValue('/etc')
  await settle()
  eq('kind: a taken name is auto-suffixed', r.down('#archName').getValue(), 'etc-2')

  add.handler(add)
  await settle()
  rows = archiveRows(wiz)
  r = rows[2]
  r.down('#archPath').setValue('/mnt/my-dir!')
  await settle()
  eq('kind: non-archive characters are sanitised', r.down('#archName').getValue(), 'my-dir_')

  add.handler(add)
  await settle()
  rows = archiveRows(wiz)
  r = rows[3]
  r.down('#archKind').setValue('img')
  await settle()
  r.down('#archPath').setValue('/tank/images/lun2.raw')
  await settle()
  eq('kind: an image row derives the same way (the name, not the kind, is the key)',
    r.down('#archName').getValue(), 'lun2.raw')

  // --- 3. An edit never re-derives a stored name (it is the detection key) ---
  grid.selectRow(0)
  let editDlg = await openEdit(grid)
  const erows = archiveRows(editDlg)
  erows[0].down('#archPath').setValue('/mnt/elsewhere')
  await settle()
  eq('kind: a stored archive name survives its path moving',
    erows[0].down('#archName').getValue(), 'pictures')

  // The same dialog: TASK carries one pre-block image archive — the note
  // names it and points at the shape it should become.
  const note = editDlg.down('#filesLegacyNote')
  ok('kind: a files task with image archive(s) shows the legacy note',
    !!note && /image archive/i.test(note.html || ''), note && note.html)
  ok('kind: …pointing at one block task per LUN',
    !!note && /block task/.test(note.html || ''), note && note.html)
  editDlg.close()
  await settle()

  // --- 4. A stored block task: edits as block, the id editable, name stored ---
  grid.selectRow(1)
  editDlg = await openEdit(grid)
  ok('kind: a stored-block task edits as block',
    /Edit Backup Task/.test(editDlg.title || '') && editDlg.down('#blockPanel').hidden === false)
  ok('kind: …with no kind choice (the task is what it is)',
    editDlg.down('#kindGroup').hidden === true)
  eq('kind: the block archive name stays the stored one',
    editDlg.down('#blockArchiveName').getValue(), BLOCK_ARCHIVE_NAME)
  eq('kind: the stored id is shown', editDlg.down('#backupId').getValue(), BLOCK_TASK.backupId)
  ok("kind: …and editable on an edit (the daemon's guard says what it may become)",
    editDlg.down('#backupId').readOnly === false)
  await settle()
  ok('kind: the stored pick re-resolves against the LUN list (live name on screen)',
    (editDlg.down('#blockLunOut').html || '').includes(LUN_SOURCES[0].name),
    editDlg.down('#blockLunOut').html)

  jobs.length = 0
  editDlg.down('#taskSubmitBtn').handler(editDlg.down('#taskSubmitBtn'))
  await settle()
  ok('kind: an untouched stored-block edit PUTs the whole task', jobs.length === 1
    && jobs[0].method === 'put' && jobs[0].path === '/backup/tasks/lun-disk',
    JSON.stringify(jobs[0] && [jobs[0].method, jobs[0].path]))
  if (jobs.length) {
    const body = jobs[0].body
    eq('kind: …sending its stored kind back verbatim', body.kind, 'block')
    eq('kind: …with the stored archive unchanged', body.archives, BLOCK_TASK.archives)
    eq('kind: …with the stored id', body.backupId, BLOCK_TASK.backupId)
  }

  // A re-pick is a different source: the record and the path follow the pick,
  // the stored name stays.
  editDlg.down('#blockLunChoose').handler()
  await settle()
  const picker2 = openWindow()
  picker2.down('#lunGrid').selectRow(1)
  picker2.buttonCmps.find(b => b.cls === 'anas-btn-backup-lun-select').handler()
  await settle()
  jobs.length = 0
  editDlg.down('#taskSubmitBtn').handler(editDlg.down('#taskSubmitBtn'))
  await settle()
  if (jobs.length) {
    const body = jobs[0].body
    eq('kind: a re-pick re-points the archive at the new LUN', body.archives, [{
      name: BLOCK_ARCHIVE_NAME,
      path: LUN_SOURCES[1].path,
      excludes: [],
      kind: 'img',
      lun: { targetIqn: LUN_SOURCES[1].targetIqn, index: LUN_SOURCES[1].index },
    }])
    eq('kind: …and the stored id rides back as-is (the daemon says what it may become)',
      body.backupId, BLOCK_TASK.backupId)
  }
  editDlg.close()
  await settle()

  // --- 5. A pre-backup2.9 LUN task: edits as block, sends NO kind -----------
  grid.selectRow(2)
  editDlg = await openEdit(grid)
  ok('kind: a pre-backup2.9 single-image task edits as block',
    /Edit Backup Task/.test(editDlg.title || '') && editDlg.down('#blockPanel').hidden === false)
  ok('kind: …with no kind choice', editDlg.down('#kindGroup').hidden === true)
  eq('kind: the archive name is the stored one — NOT the fixed block name',
    editDlg.down('#blockArchiveName').getValue(), 'lun0')
  eq('kind: the hand-chosen id is shown', editDlg.down('#backupId').getValue(), 'vmstore')
  await settle()
  ok('kind: its stored pick re-resolves too',
    (editDlg.down('#blockLunOut').html || '').includes(LUN_SOURCES[0].name),
    editDlg.down('#blockLunOut').html)

  jobs.length = 0
  editDlg.down('#taskSubmitBtn').handler(editDlg.down('#taskSubmitBtn'))
  await settle()
  if (jobs.length) {
    const body = jobs[0].body
    ok('kind: an untouched legacy LUN edit sends NO `kind` key — its id and group survive',
      !('kind' in body), JSON.stringify(body))
    eq('kind: …with the hand-chosen id verbatim', body.backupId, 'vmstore')
    eq('kind: …with the stored archive verbatim', body.archives, LEGACY_LUN_TASK.archives)
  }
  editDlg.close()
  await settle()

  ok('kind: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  3. Import Pool sends the GUID it shows
// ============================================================================

const IMPORTABLE = [
  { name: 'tank', guid: '2371539348432104789', state: 'ONLINE' },
  // The case GUIDs exist for: a second exported pool with the SAME name.
  { name: 'tank', guid: '9911223344556677889', state: 'ONLINE' },
]

async function poolImportChecks() {
  const ANAS = loadSource('33-pool-import.js', {
    'GET /pools/import': { data: IMPORTABLE },
  })
  const action = (ANAS.pools._actions || []).find(a => a.itemId === 'importPool')
  ok('import: the Import action registered', !!action)
  if (!action) { return }

  jobs.length = 0
  action.handler('harness', makeComponent({ xtype: 'gridpanel' }, null))
  await settle()
  const win = openWindow()
  ok('import: the window opened', !!win)
  const grid = win.down('#importGrid')
  ok('import: the scan filled the grid', grid && grid.getStore().getCount() === 2)
  ok('import: the GUID is on screen', (grid.columns || []).some(col => col.dataIndex === 'guid'))

  // Pick the SECOND same-named pool — by name alone this import is ambiguous.
  grid.selectRow(1)
  const btn = win.buttonCmps.find(b => b.cls === 'anas-btn-import-submit')
  ok('import: the Import button exists', !!btn)
  btn.handler(btn)
  await settle()

  eq('import: one import job was submitted', jobs.length, 1)
  if (jobs.length) {
    eq('import: it posts to /pools/import', jobs[0].path, '/pools/import')
    eq('import: it carries the selected row\'s GUID', jobs[0].body.guid, IMPORTABLE[1].guid)
    // Name AND guid would import the NAME (the daemon prefers it), which is the
    // ambiguous identifier this whole column exists to replace.
    ok('import: it does not fall back to the ambiguous name', jobs[0].body.name === undefined,
      `body ${JSON.stringify(jobs[0].body)}`)
  }
  ok('import: nothing warned', warnings.length === 0, warnings.join(' | '))
}


// ============================================================================
//  4. Datasets: filesystem vs volume — what each one sends, and what a volume
//     row does to the toolbar (story iscsi.3)
// ============================================================================

const GiB = 1024 * 1024 * 1024

// One ANAS-managed pool with a filesystem and a real-shaped zvol, and one
// PVE-managed pool whose zvol must stay hands-off (story 3.25 — the SAME
// pool-level tag as its datasets, not a second check).
const DS_POOLS = [
  { name: 'tank', size: 8 * GiB, pveStorages: [] },
  { name: 'pvepool', size: 8 * GiB, pveStorages: [{ id: 'local-zfs', type: 'zfspool' }] },
]

const TANK_DATASETS = [
  { name: 'tank', pool: 'tank', type: 'filesystem', used: 1, available: 1, referenced: 1, mountpoint: '/tank', compression: 'lz4', compressratio: 1, quota: 0 },
  { name: 'tank/media', pool: 'tank', type: 'filesystem', used: 1, available: 1, referenced: 1, mountpoint: '/tank/media', compression: 'lz4', compressratio: 1, quota: 0 },
  { name: 'tank/vol1', pool: 'tank', type: 'volume', used: 2 * GiB, available: 1, referenced: 1, mountpoint: null, compression: 'on', compressratio: 1, quota: 0, volsize: 2 * GiB, volblocksize: 16384, sparse: false },
]

const PVE_DATASETS = [
  { name: 'pvepool', pool: 'pvepool', type: 'filesystem', used: 1, available: 1, referenced: 1, mountpoint: '/pvepool', compression: 'on', compressratio: 1, quota: 0 },
  { name: 'pvepool/vm-100-disk-0', pool: 'pvepool', type: 'volume', used: GiB, available: 1, referenced: 1, mountpoint: null, compression: 'on', compressratio: 1, quota: 0, volsize: GiB, volblocksize: 8192, sparse: true },
]

const DATASET_ROUTES = {
  'GET /pools': { data: DS_POOLS },
  // `defaults` is the ZFS-observed volblocksize the Create dialog must QUOTE
  // rather than hard-code.
  'GET /pools/tank/datasets': { data: TANK_DATASETS, defaults: { volblocksize: 16384 } },
  'GET /pools/pvepool/datasets': { data: PVE_DATASETS, defaults: { volblocksize: 16384 } },
}

/** Find a node in the loaded tree by its full ZFS name. */
function findNode(tree, fullName) {
  const walk = (node) => {
    if (node.get && node.get('fullName') === fullName) { return node }
    for (const kid of node.childNodes || []) {
      const hit = walk(kid)
      if (hit) { return hit }
    }
    return null
  }
  return walk(tree.getRootNode())
}

/** The toolbar's disabled/tooltip state, keyed by itemId. */
function toolbarState(tree, ids) {
  const out = {}
  for (const id of ids) {
    const btn = tree.down(`#${id}`)
    out[id] = btn ? { disabled: !!btn.disabled, tip: btn.tooltip || '' } : null
  }
  return out
}

async function datasetsChecks() {
  const ANAS = loadSource('60-datasets.js', DATASET_ROUTES)
  const view = makeComponent(ANAS.views.datasets.factory('harness'), null)
  const tree = view.down('#dsTree')
  ok('datasets: the tree panel exists', !!tree)
  tree.fireEvent('afterrender', tree)
  await settle()

  const fsNode = findNode(tree, 'tank/media')
  const volNode = findNode(tree, 'tank/vol1')
  const pveVolNode = findNode(tree, 'pvepool/vm-100-disk-0')
  ok('datasets: the filesystem row loaded', !!fsNode)
  ok('datasets: the volume row loaded', !!volNode)
  ok('datasets: the PVE-owned zvol loaded', !!pveVolNode)
  if (!fsNode || !volNode || !pveVolNode) { return }

  eq('datasets: the volume row carries volsize', volNode.get('volsize'), 2 * GiB)
  eq('datasets: the volume row carries volblocksize', volNode.get('volblocksize'), 16384)
  eq('datasets: the volume row carries sparse', volNode.get('sparse'), false)
  eq('datasets: a filesystem row carries NO volsize', fsNode.get('volsize'), undefined)
  eq('datasets: the observed ZFS default reached the tree', tree.anasVolblocksizeDefault, 16384)

  // --- 4a. The gating matrix -------------------------------------------------
  const GATED = ['dsEdit', 'dsPerms', 'dsShare', 'dsResize', 'dsDestroy', 'dsDetail']

  tree.selectNode(fsNode)
  let state = toolbarState(tree, GATED)
  ok('gating(filesystem): Edit Properties enabled', state.dsEdit.disabled === false)
  ok('gating(filesystem): Permissions enabled', state.dsPerms.disabled === false)
  ok('gating(filesystem): Share… enabled', state.dsShare.disabled === false)
  ok('gating(filesystem): Destroy enabled', state.dsDestroy.disabled === false)
  ok('gating(filesystem): Resize Volume DISABLED', state.dsResize.disabled === true)
  ok('gating(filesystem): Resize says why it is off', /volume/i.test(state.dsResize.tip), state.dsResize.tip)
  ok('gating(filesystem): Edit carries no volume excuse', state.dsEdit.tip === '', state.dsEdit.tip)

  tree.selectNode(volNode)
  state = toolbarState(tree, GATED)
  ok('gating(volume): Edit Properties DISABLED', state.dsEdit.disabled === true)
  ok('gating(volume): Permissions DISABLED', state.dsPerms.disabled === true)
  ok('gating(volume): Share… DISABLED', state.dsShare.disabled === true)
  ok('gating(volume): Resize Volume ENABLED', state.dsResize.disabled === false)
  ok('gating(volume): Destroy stays enabled', state.dsDestroy.disabled === false)
  ok('gating(volume): Detail stays enabled', state.dsDetail.disabled === false)
  // Every disabled control explains ITSELF — a greyed button with no reason
  // reads as a bug rather than as a rule.
  ok('gating(volume): Edit says filesystem properties do not exist', /Resize Volume/.test(state.dsEdit.tip), state.dsEdit.tip)
  ok('gating(volume): Permissions says there is no mountpoint', /mountpoint/.test(state.dsPerms.tip), state.dsPerms.tip)
  ok('gating(volume): Share says a volume has no path', /iSCSI/.test(state.dsShare.tip), state.dsShare.tip)

  tree.selectNode(pveVolNode)
  state = toolbarState(tree, GATED)
  ok('gating(PVE volume): Resize DISABLED (3.25 hands-off)', state.dsResize.disabled === true)
  ok('gating(PVE volume): Destroy DISABLED', state.dsDestroy.disabled === true)
  ok('gating(PVE volume): Edit DISABLED', state.dsEdit.disabled === true)
  ok('gating(PVE volume): Detail still enabled (read-only is allowed)', state.dsDetail.disabled === false)

  // --- 4b. Create: filesystem body is unchanged, volume body is new ----------
  tree.selectNode(fsNode)
  jobs.length = 0
  let btn = tree.down('#dsCreate')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('create: the dialog opened', !!dlg && !!dlg.down('#dsType'))
  if (!dlg) { return }
  eq('create: it defaults to Filesystem', dlg.down('#dsType').getValue(), 'filesystem')
  ok('create: the volume fields start hidden', dlg.down('#size').hidden === true)
  ok('create: the filesystem fields start visible', dlg.down('#recordsize').hidden === false)

  dlg.down('#path').setValue('media/movies')
  dlg.down('#recordsize').setValue(131072)
  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-dataset-create-submit')
  submit.handler(submit)
  await settle()
  eq('create(filesystem): one job', jobs.length, 1)
  eq('create(filesystem): posts to the pool', jobs[0].path, '/pools/tank/datasets')
  // The body must be EXACTLY what it was before volumes existed: no `type`, no
  // zvol keys. An older daemon has to keep understanding it (version skew).
  eq('create(filesystem): the body is unchanged by this story',
    jobs[0].body, { path: 'media/movies', properties: { recordsize: 131072 } })

  // Now the volume branch of the same dialog.
  jobs.length = 0
  btn = tree.down('#dsCreate')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#dsType').setValue('volume')
  await settle()
  ok('create(volume): the volume fields appear', dlg.down('#size').hidden === false)
  ok('create(volume): the block-size picker appears', dlg.down('#volblocksize').hidden === false)
  ok('create(volume): the filesystem fields go away', dlg.down('#recordsize').hidden === true)
  ok('create(volume): and are disabled, so a stale value cannot be read back',
    dlg.down('#recordsize').disabled === true)
  // The blank block-size row STATES the observed ZFS default rather than
  // hard-coding one.
  const blankRow = dlg.down('#volblocksize').getStore().getAt(0)
  eq('create(volume): the blank block-size row means "send nothing"', blankRow.get('value'), '')
  ok('create(volume): it names the observed ZFS default', /ZFS default/.test(blankRow.get('label')), blankRow.get('label'))

  dlg.down('#path').setValue('vol2')
  dlg.down('#size').setValue(4)
  dlg.down('#unit').setValue(GiB)
  dlg.down('#volblocksize').setValue(8192)
  dlg.down('#sparse').setValue(true)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-dataset-create-submit')
  submit.handler(submit)
  await settle()
  eq('create(volume): one job', jobs.length, 1)
  eq('create(volume): the body carries type + the zvol trio, and no filesystem keys',
    jobs[0].body, { path: 'vol2', type: 'volume', volsize: 4 * GiB, volblocksize: 8192, sparse: true })

  // Blank block size ⇒ the key is ABSENT, so ZFS applies its own default.
  jobs.length = 0
  btn = tree.down('#dsCreate')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#dsType').setValue('volume')
  dlg.down('#path').setValue('vol3')
  dlg.down('#size').setValue(512)
  dlg.down('#unit').setValue(1024 * 1024)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-dataset-create-submit')
  submit.handler(submit)
  await settle()
  eq('create(volume): a default block size sends no volblocksize at all',
    jobs[0].body, { path: 'vol3', type: 'volume', volsize: 512 * 1024 * 1024 })

  // --- 4c. Resize Volume: grow only -----------------------------------------
  tree.selectNode(volNode)

  // (i) An UNTOUCHED edit sends nothing — the dialog↔daemon contract.
  jobs.length = 0
  btn = tree.down('#dsResize')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  ok('resize: the window opened', !!dlg && !!dlg.down('#size'))
  eq('resize: it pre-fills the CURRENT size, in the largest exact unit',
    [dlg.down('#size').getValue(), dlg.down('#unit').getValue()], [2, GiB])
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-volume-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: an untouched edit sends NOTHING', jobs.length, 0)
  ok('resize: an untouched edit closes the window', dlg.destroyed === true)

  // (ii) A SHRINK is refused before it can reach the daemon.
  jobs.length = 0
  warnings.length = 0
  btn = tree.down('#dsResize')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#size').setValue(1)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-volume-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: a shrink sends NOTHING', jobs.length, 0)
  ok('resize: a shrink says why', warnings.some(w => /Cannot shrink/.test(w)), warnings.join(' | '))
  ok('resize: a shrink leaves the window open to fix', dlg.destroyed === false)

  // (iii) A GROW is a PUT of volsize alone.
  jobs.length = 0
  warnings.length = 0
  dlg.down('#size').setValue(8)
  submit.handler(submit)
  await settle()
  eq('resize: one job', jobs.length, 1)
  eq('resize: it is a PUT', jobs[0].method, 'put')
  eq('resize: it targets the volume', jobs[0].path, '/pools/tank/datasets/vol1')
  eq('resize: it sends volsize and nothing else',
    jobs[0].body, { properties: { volsize: 8 * GiB } })

  ok('datasets: nothing warned', warnings.length === 0, warnings.join(' | '))
}


// ============================================================================
//  5. iSCSI: targets, ACLs/CHAP and LUNs — what each dialog SENDS (story iscsi.4)
// ============================================================================
//
// The three things this section exists to hold down:
//
//   * a CHAP secret is WRITE-ONLY, so the box always opens empty — which makes
//     "blank" mean KEEP, not clear. A dialog that sent `chapSecret: null` for an
//     untouched box would silently strip every stored secret on the next save.
//   * an untouched target edit must send an EMPTY body, and a resize that
//     changes nothing must send no request at all.
//   * destroying the backing object is a SEPARATE, ticked choice that becomes a
//     query flag — not something a Delete button does on its own.

const ISCSI_IQN = 'iqn.2026-08.nas.anas:vmstore'
const ISCSI_FOREIGN = 'iqn.2026-08.dev.anas.gtiscsi:target1'
const ISCSI_INITIATOR = 'iqn.1993-08.org.debian:01:ae3d2ec18ad'
// The node's OWN initiator IQN, as `/etc/iscsi/initiatorname.iscsi` carries it —
// the value "Add this node" inserts.
const ISCSI_NODE_IQN = 'iqn.1993-08.org.debian:01:1dd0a338f783'
const ISCSI_SECRET = 'correcthorseba' // 14 bytes — inside the 12–16 range

const ISCSI_TARGETS = {
  installed: true,
  configfsPresent: true,
  saveconfigPresent: true,
  nodeInitiatorIqn: ISCSI_NODE_IQN,
  targets: [
    {
      iqn: ISCSI_IQN,
      name: 'vmstore',
      ownership: 'anas',
      ownershipReason: 'anas-managed',
      ownershipDetail: 'IQN follows the ANAS naming convention and all 2 LUNs are backed by ANAS-managed storage',
      tpgTag: 1,
      enabled: true,
      portals: [{ address: '192.168.200.50', port: 3260, family: 'inet', carriedByInterface: true }],
      lunCount: 2,
      aclCount: 1,
      sessionCount: 0,
      security: { authentication: false, generateNodeAcls: false, demoModeDiscovery: false },
      present: true,
      persisted: true,
      missingLunCount: 0,
      portalsWithoutInterfaceCount: 0,
    },
    {
      iqn: ISCSI_FOREIGN,
      name: null,
      ownership: 'foreign',
      ownershipReason: 'iqn-not-anas',
      ownershipDetail: `IQN '${ISCSI_FOREIGN}' was not generated by ANAS (an ANAS target's naming authority ends in '.anas')`,
      tpgTag: 1,
      enabled: true,
      portals: [{ address: '10.9.9.9', port: 3260, family: 'inet', carriedByInterface: false }],
      lunCount: 1,
      aclCount: 0,
      sessionCount: 1,
      security: { authentication: true, generateNodeAcls: false, demoModeDiscovery: true },
      present: true,
      persisted: true,
      missingLunCount: 0,
      portalsWithoutInterfaceCount: 1,
    },
  ],
}

const GiB_ = 1024 * 1024 * 1024

/** The ANAS target in full: two LUNs, one ACL with a STORED CHAP secret. */
function iscsiDetail(opts = {}) {
  return {
    ...ISCSI_TARGETS.targets[0],
    security: { authentication: true, generateNodeAcls: false, demoModeDiscovery: false },
    sessions: opts.session
      ? [{ initiatorIqn: ISCSI_INITIATOR, initiatorAlias: 'anas-pve', targetIqn: ISCSI_IQN, tpgTag: 1, sessionId: 1, state: 'TARG_SESS_STATE_LOGGED_IN', connections: [{ cid: 0, address: '192.168.200.60', state: 'TARG_CONN_STATE_LOGGED_IN' }], mappedLuns: [opts.sessionLun ?? 0] }]
      : [],
    acls: [{
      initiatorIqn: ISCSI_INITIATOR,
      chapUserid: 'alice',
      chapCredentialsSet: true,
      mutualUserid: null,
      mutualCredentialsSet: false,
      authenticateTarget: false,
      mappedLuns: [0, 1],
    }],
    luns: [
      {
        index: 0,
        name: 'vmdisk1',
        kind: 'zvol',
        plugin: 'block',
        backingPath: '/dev/zvol/tank/vol1',
        size: 2 * GiB_,
        serial: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
        attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 524288 },
        connectedInitiators: opts.session && (opts.sessionLun ?? 0) === 0 ? [ISCSI_INITIATOR] : [],
        present: true,
        backingExists: true,
        pool: 'tank',
        dataset: 'tank/vol1',
      },
      {
        index: 1,
        name: 'vmdisk2',
        kind: 'file',
        plugin: 'fileio',
        backingPath: '/tank/images/vmdisk2.raw',
        size: GiB_,
        serial: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 262144 },
        connectedInitiators: opts.session && opts.sessionLun === 1 ? [ISCSI_INITIATOR] : [],
        present: true,
        backingExists: true,
        pool: 'tank',
        dataset: 'tank/images',
      },
    ],
  }
}

/** The pools/datasets the Add LUN pickers read. */
const ISCSI_POOL_ROUTES = {
  'GET /pools': { data: [
    { name: 'tank', size: 8 * GiB_, pveStorages: [] },
    // PVE territory: never a candidate, and never even enumerated.
    { name: 'pvepool', size: 8 * GiB_, pveStorages: [{ id: 'local-zfs', type: 'zfspool' }] },
  ] },
  'GET /pools/tank/datasets': { data: [
    { name: 'tank', type: 'filesystem', mountpoint: '/tank' },
    { name: 'tank/images', type: 'filesystem', mountpoint: '/tank/images' },
    { name: 'tank/vol1', type: 'volume', volsize: 2 * GiB_ },
    { name: 'tank/vol2', type: 'volume', volsize: 4 * GiB_ },
    // A PVE guest disk that happens to sit on an ANAS pool: still never a
    // candidate — the same three prefixes the daemon refuses.
    { name: 'tank/vm-101-disk-0', type: 'volume', volsize: GiB_ },
  ] },
  // The picker reads the same GET /ahr the AHR menu makes (the daemon has no
  // /ahr/pools) and offers only MOUNTED pools — the image directory IS the
  // mountpoint, and an unmounted pool has none to hold one in.
  'GET /ahr': { data: [{ name: 'ahrpool', mountpoint: '/mnt/anas-ahr/ahrpool', mounted: true }] },
}

/** The saveconfig ⟷ configfs diff behind the Repair button (story iscsi.5). */
function iscsiHealth(opts = {}) {
  const missing = opts.missing || []
  return {
    data: {
      installed: true,
      configfsPresent: true,
      saveconfigPresent: true,
      missingLuns: missing,
      targetsServingNothing: opts.servingNothing || [],
      portalsWithoutInterface: [],
      foreignChanges: [],
      degraded: missing.length > 0,
      interfacesUnknown: false,
      checkedAt: '2026-08-25T20:00:00.000Z',
    },
  }
}

/** One restore hole; `backingExists` is the whole gate on Repair. */
function iscsiHole(backingExists) {
  return {
    targetIqn: ISCSI_IQN,
    tpgTag: 1,
    lunIndex: 0,
    backstoreName: 'vmdisk1',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/vol1',
    backingExists,
  }
}

const ISCSI_ROUTES = {
  'GET /iscsi/targets': { data: ISCSI_TARGETS },
  'GET /iscsi/health': iscsiHealth(),
  [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: iscsiDetail() },
  [`GET /iscsi/targets/${encodeURIComponent(ISCSI_FOREIGN)}`]: { data: { ...ISCSI_TARGETS.targets[1], luns: [], acls: [], sessions: [] } },
  ...ISCSI_POOL_ROUTES,
}

/** The node's real addresses, as PVE's own /nodes/<node>/network reports them. */
const PVE_NETWORK = {
  data: [
    { iface: 'lo', address: '127.0.0.1', active: 1 },
    { iface: 'vmbr0', address: '192.168.200.50', active: 1 },
    { iface: 'vmbr1', address: '10.0.0.5', active: 0 },
  ],
}

/** Open the view and wait for its first load. */
async function openIscsiView(routes) {
  const ANAS = loadSource('75-iscsi.js', routes)
  const view = makeComponent(ANAS.views.iscsi.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  return { ANAS, view, grid: view.down('#iscsiGrid') }
}

/** Row index of a target by IQN. */
function iscsiRowOf(grid, iqn) {
  return grid.getStore().findExact('iqn', iqn)
}

function toolbar(grid, ids) {
  const out = {}
  for (const id of ids) {
    const btn = grid.down(`#${id}`)
    out[id] = btn ? { disabled: !!btn.disabled, tip: btn.tooltip || '', text: btn.text } : null
  }
  return out
}

async function iscsiGridChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)

  ok('iscsi: the grid loaded both targets', grid && grid.getStore().getCount() === 2)
  ok('iscsi: the view registered under its own menu key', !!view.down('#iscsiGrid'))

  const GATED = ['iscsiCreate', 'iscsiEdit', 'iscsiToggle', 'iscsiDelete', 'iscsiLuns']

  // Nothing selected: only Create is live.
  let state = toolbar(grid, GATED)
  ok('gating(none): Create is enabled', state.iscsiCreate.disabled === false)
  ok('gating(none): Edit is disabled', state.iscsiEdit.disabled === true)
  ok('gating(none): LUNs… is disabled', state.iscsiLuns.disabled === true)

  // An ANAS target: everything is live and the toggle reads Disable — except
  // Delete, which is dead while the row still carries LUNs: a target is only
  // deletable empty, and the tooltip says what to clear first.
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))
  state = toolbar(grid, GATED)
  ok('gating(anas): Edit enabled', state.iscsiEdit.disabled === false)
  ok('gating(anas): Delete DISABLED while the target still has LUNs', state.iscsiDelete.disabled === true)
  ok('gating(anas): and the tooltip says to delete the LUNs first',
    /Delete its 2 LUNs first/.test(state.iscsiDelete.tip), state.iscsiDelete.tip)
  ok('gating(anas): LUNs… enabled', state.iscsiLuns.disabled === false)
  ok('gating(anas): an enabled target offers Disable', state.iscsiToggle.text === 'Disable')
  ok('gating(anas): no hands-off excuse on an ANAS row', state.iscsiEdit.tip === '', state.iscsiEdit.tip)

  // A FOREIGN target: hands-off, and every disabled control explains itself.
  grid.selectRow(iscsiRowOf(grid, ISCSI_FOREIGN))
  state = toolbar(grid, GATED)
  ok('gating(foreign): Edit DISABLED', state.iscsiEdit.disabled === true)
  ok('gating(foreign): Enable/Disable DISABLED', state.iscsiToggle.disabled === true)
  ok('gating(foreign): Delete DISABLED', state.iscsiDelete.disabled === true)
  ok('gating(foreign): reading its LUNs is still allowed', state.iscsiLuns.disabled === false)
  ok('gating(foreign): the tooltip carries the DERIVATION, not just a refusal',
    /not generated by ANAS/.test(state.iscsiEdit.tip), state.iscsiEdit.tip)

  // A double-click on a foreign row must not open the edit dialog either.
  const before = created.windows.length
  grid.fireEvent('itemdblclick', grid, grid.getStore().getAt(iscsiRowOf(grid, ISCSI_FOREIGN)))
  await settle()
  eq('gating(foreign): a double-click opens nothing', created.windows.length, before)

  ok('iscsi: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiNotInstalledChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  // Verbatim from `iscsiAvailability` — including the modules half (GT-4): there
  // is no load-on-first-use to arrange, so the envelope says so instead of
  // implying a knob exists.
  const reason = 'The LIO iSCSI target stack is not present on this node (no configfs target tree and no saved configuration) '
    + '— install targetcli-fb and python3-rtslib-fb to serve block storage. Installing them costs nothing at rest: '
    + 'the target kernel modules arrive with the first real targetcli call, and rtslib loads every backstore plugin '
    + 'at once — there is no load-on-first-use to arrange, and ANAS never loads one itself.'
  const { view, grid } = await openIscsiView({
    'GET /iscsi/targets': {
      data: {
        installed: false,
        configfsPresent: false,
        saveconfigPresent: false,
        reason,
        targets: [],
      },
    },
  })

  const banner = view.down('#iscsiEnvelope')
  ok('not-installed: the panel renders the envelope\'s OWN reason', banner && banner.hidden === false
    && String(banner.html).includes('install targetcli-fb'), banner && banner.html)
  const state = toolbar(grid, ['iscsiCreate', 'iscsiEdit', 'iscsiToggle', 'iscsiDelete', 'iscsiLuns'])
  ok('not-installed: even Create is disabled', state.iscsiCreate.disabled === true)
  ok('not-installed: Create says what is missing', /targetcli-fb/.test(state.iscsiCreate.tip), state.iscsiCreate.tip)
  ok('not-installed: the rest of the toolbar is disabled too',
    state.iscsiEdit.disabled === true && state.iscsiLuns.disabled === true)
  ok('not-installed: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiCreateChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)

  jobs.length = 0
  const btn = grid.down('#iscsiCreate')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('create: the dialog opened', !!dlg && !!dlg.down('#name'))
  if (!dlg) { return }

  // The portal picker is filled from PVE's OWN network API — the addresses this
  // node actually carries, because LIO will bind one it does not and say nothing.
  const picker = dlg.down('#portalAddress')
  const addrs = picker.getStore().getRange().map(r => r.get('address'))
  ok('create: the portal picker offers this node\'s ACTIVE addresses',
    addrs.includes('192.168.200.50') && addrs.includes('127.0.0.1'), JSON.stringify(addrs))
  ok('create: an inactive interface is not offered', !addrs.includes('10.0.0.5'), JSON.stringify(addrs))
  ok('create: the picker stays editable — an address about to exist is legitimate',
    picker.editable === true)

  // The PVE-CHAP note is hidden until auth is not none, then it appears.
  ok('create: the PVE no-CHAP-field note starts hidden', dlg.down('#pveChapNote').hidden === true)

  // --- zero ACLs: the create is GATED, and "Add this node" is the door out ---
  //
  // ANAS closes discovery (demo mode is never enabled), so a target nobody is
  // listed on never appears in any scan. The dialog says that out loud, keeps
  // Save dead until an initiator is listed, and offers the one initiator an
  // operator is most likely to mean: this node itself.

  const nodeBtn = dlg.down('#aclAddNode')
  ok('create: "Add this node" is live when the daemon reports the node\'s own IQN',
    !!nodeBtn && nodeBtn.disabled === false, nodeBtn && `${nodeBtn.disabled}`)

  dlg.down('#name').setValue('vmstore2')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()

  eq('create: a target with zero ACLs is BLOCKED — no job', jobs.length, 0)
  ok('create: Save is dead', submit.disabled === true)
  ok('create: and the gate says WHY, in the dialog, in the operator\'s words',
    /needs at least one initiator ACL/.test(dlg.down('#guardNote').html),
    dlg.down('#guardNote').html)
  ok('create: the static note under the ACL editor is shown while the list is empty',
    dlg.down('#aclEmptyNote').hidden === false
    && /invisible to everyone/.test(dlg.down('#aclEmptyNote').html),
    dlg.down('#aclEmptyNote').html)

  nodeBtn.handler(nodeBtn)
  await settle()
  const nodeRow = dlg.down('#aclsContainer').items.getAt(0)
  eq('create: "Add this node" inserts the node\'s own IQN as an ACL row',
    nodeRow.down('#aclIqn').getValue(), ISCSI_NODE_IQN)
  ok('create: …and unblocks Save', submit.disabled === false)
  ok('create: the empty-ACL note goes away once a row carries an IQN',
    dlg.down('#aclEmptyNote').hidden === true)
  submit.handler(submit)
  await settle()

  eq('create: one job', jobs.length, 1)
  eq('create: it POSTs to the collection', [jobs[0].method, jobs[0].path], ['post', '/iscsi/targets'])
  eq('create: the body carries the name, the portal and the node\'s own ACL',
    jobs[0].body, { name: 'vmstore2', portals: [{ address: '192.168.200.50', port: 3260 }], auth: 'none', acls: [{ initiatorIqn: ISCSI_NODE_IQN }] })

  // --- with CHAP ---
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('vmstore3')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#authGroup').setValue({ authMode: 'chap' })
  await settle()
  ok('create: choosing CHAP reveals the PVE no-CHAP-field note',
    dlg.down('#pveChapNote').hidden === false)
  ok('create: the note names the PVE plugin limitation exactly',
    /iscsi: storage plugin has no CHAP field/.test(dlg.down('#pveChapNote').html),
    dlg.down('#pveChapNote').html)
  ok('create: the 12–16 byte rule is stated, since LIO does not enforce it',
    /12–16 bytes/.test(dlg.down('#chapLengthNote').html), dlg.down('#chapLengthNote').html)

  const addAcl = dlg.down('#aclAdd')
  addAcl.handler(addAcl)
  await settle()
  let row = dlg.down('#aclsContainer').items.getAt(0)
  row.down('#aclIqn').setValue(ISCSI_INITIATOR)
  row.down('#aclUserid').setValue('alice')
  row.down('#aclSecret').setValue(ISCSI_SECRET)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('create(chap): the ACL carries the username and the secret',
    jobs[0].body.acls, [{ initiatorIqn: ISCSI_INITIATOR, chapUserid: 'alice', chapSecret: ISCSI_SECRET }])
  eq('create(chap): the auth mode travels', jobs[0].body.auth, 'chap')

  // --- a too-short secret never reaches the daemon ---
  jobs.length = 0
  warnings.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('vmstore4')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#authGroup').setValue({ authMode: 'chap' })
  const addAcl2 = dlg.down('#aclAdd')
  addAcl2.handler(addAcl2)
  await settle()
  row = dlg.down('#aclsContainer').items.getAt(0)
  row.down('#aclIqn').setValue(ISCSI_INITIATOR)
  row.down('#aclUserid').setValue('alice')
  row.down('#aclSecret').setValue('short')
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('create: a too-short CHAP secret sends NOTHING', jobs.length, 0)
  ok('create: and it says why', warnings.some(w => /12–16/.test(w)), warnings.join(' | '))
  warnings.length = 0

  // --- a portal-less target is refused client-side too ---
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('vmstore5')
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('create: a target with no portal sends nothing', jobs.length, 0)
  ok('create: and says a portal is needed', warnings.some(w => /portal/.test(w)), warnings.join(' | '))
  warnings.length = 0
}

async function iscsiNodeIqnAbsentChecks() {
  // Version skew: a daemon that predates the field omits it entirely. The
  // ruling is "absent ⇒ today's screen, no error": the button is DEAD (and
  // says so), nothing else is gated, and a hand-typed initiator still gets a
  // target created.
  ajax.responses = { '/network': PVE_NETWORK }
  const old = { ...ISCSI_TARGETS }
  delete old.nodeInitiatorIqn
  const { grid } = await openIscsiView({ ...ISCSI_ROUTES, 'GET /iscsi/targets': { data: old } })

  jobs.length = 0
  grid.down('#iscsiCreate').handler(grid.down('#iscsiCreate'))
  await settle()
  const dlg = openWindow()
  ok('skew: the dialog opens — an absent field is not an error', !!dlg && !!dlg.down('#name'))
  if (!dlg) { return }
  const nodeBtn = dlg.down('#aclAddNode')
  ok('skew: "Add this node" is DEAD when the daemon predates the field',
    !!nodeBtn && nodeBtn.disabled === true, nodeBtn && `${nodeBtn.disabled}`)
  ok('skew: and its tooltip says the daemon does not report it',
    /predates the field/.test(nodeBtn.tooltip || ''), nodeBtn.tooltip)

  dlg.down('#name').setValue('vmstore9')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#aclAdd').handler(dlg.down('#aclAdd'))
  await settle()
  dlg.down('#aclsContainer').items.getAt(0).down('#aclIqn').setValue(ISCSI_INITIATOR)
  await settle()
  const submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  ok('skew: a typed initiator unblocks Save', submit.disabled === false)
  submit.handler(submit)
  await settle()
  eq('skew: and the create goes through', jobs.length, 1)
  eq('skew: the body carries the typed initiator', jobs[0].body.acls, [{ initiatorIqn: ISCSI_INITIATOR }])
  ok('skew: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiEditChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))

  const openEdit = async () => {
    const btn = grid.down('#iscsiEdit')
    btn.handler(btn)
    await settle()
    return openWindow()
  }
  const save = async (dlg) => {
    jobs.length = 0
    const b = dlg.buttonCmps.find(x => x.cls === 'anas-btn-iscsi-target-submit')
    b.handler(b)
    await settle()
    return jobs.length ? jobs[0] : null
  }

  // The dialog opens on the DETAIL read, never on the grid row's summary.
  let dlg = await openEdit()
  ok('edit: the dialog opened on the stored entry', !!dlg && !!dlg.down('#iqn'))
  eq('edit: the IQN is shown read-only — there is no rename in LIO',
    dlg.down('#iqn').value.includes(ISCSI_IQN), true)
  eq('edit: the stored auth mode pre-fills', dlg.down('#authGroup').getValue(), { authMode: 'chap' })
  const aclRow = dlg.down('#aclsContainer').items.getAt(0)
  eq('edit: the stored initiator pre-fills', aclRow.down('#aclIqn').getValue(), ISCSI_INITIATOR)
  eq('edit: the stored CHAP username pre-fills', aclRow.down('#aclUserid').getValue(), 'alice')
  eq('edit: the secret box is EMPTY — a secret is never returned', aclRow.down('#aclSecret').getValue(), '')
  ok('edit: and the label says one is stored', /stored/.test(aclRow.down('#aclSecret').fieldLabel),
    aclRow.down('#aclSecret').fieldLabel)
  eq('edit: the stored portal pre-fills', dlg.down('#portalAddress').getValue(), '192.168.200.50')

  // (i) An UNTOUCHED edit sends NOTHING.
  let job = await save(dlg)
  eq('edit: an untouched edit sends NOTHING', job, null)

  // (ii) Changing only the auth mode sends only `auth`.
  dlg = await openEdit()
  dlg.down('#authGroup').setValue({ authMode: 'none' })
  await settle()
  job = await save(dlg)
  eq('edit(auth): it is a PUT at the target', [job.method, job.path],
    ['put', `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`])
  eq('edit(auth): the body carries auth and nothing else', job.body, { auth: 'none' })

  // (iii) A blank secret box KEEPS the stored secret — it does not clear it.
  dlg = await openEdit()
  dlg.down('#portalPort').setValue(3261)
  await settle()
  job = await save(dlg)
  eq('edit(portal): the portal set travels complete', job.body.portals,
    [{ address: '192.168.200.50', port: 3261 }])
  ok('edit(portal): an untouched ACL sends no acls key at all',
    !('acls' in job.body), JSON.stringify(job.body))

  // (iv) A TYPED secret rotates it.
  dlg = await openEdit()
  dlg.down('#aclsContainer').items.getAt(0).down('#aclSecret').setValue('newsecret1234')
  await settle()
  job = await save(dlg)
  eq('edit(rotate): the new secret travels', job.body.acls,
    [{ initiatorIqn: ISCSI_INITIATOR, chapSecret: 'newsecret1234' }])

  // (v) Clearing the CHAP USERNAME clears the credential pair.
  dlg = await openEdit()
  dlg.down('#aclsContainer').items.getAt(0).down('#aclUserid').setValue('')
  await settle()
  job = await save(dlg)
  eq('edit(clear): a blanked username sends null, and takes the secret with it',
    job.body.acls, [{ initiatorIqn: ISCSI_INITIATOR, chapUserid: null, chapSecret: null }])

  // (vi) Removing an initiator sends the SHORTER complete list.
  dlg = await openEdit()
  const remove = dlg.down('#aclsContainer').items.getAt(0).down('#aclRemove')
  remove.handler(remove)
  await settle()
  job = await save(dlg)
  eq('edit(remove): the ACL list travels complete and shorter', job.body.acls, [])

  ok('edit: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// Bug report (live, 2026-08-28): a target dialog with TWO visible initiator
// rows — "Add this node" plus a row with a pasted Windows IQN — submitted
// only ONE ACL: the LAST-added one. Root cause: every row was created with
// the SAME itemId, and an ExtJS container's `items` is keyed by itemId, so
// the second add silently REPLACED the first entry in the collection while
// the first stayed rendered in the DOM. The daemon audit (acls:
// req.acls.length) proved the body itself carried one. The contract these
// orders must honour: every visible row reaches the body — in either
// add-order, set OR pasted (committed or uncommitted), on a create AND on an
// edit, for initiator AND portal rows alike.
async function iscsiRowSurvivalChecks() {
  const WINDOWS_IQN = 'iqn.1991-05.com.microsoft:winserv2025'
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)
  const submit = (dlg) => dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  // The operator always types into the row they JUST added — the last entry
  // of the collection (a pre-fix dialog had evicted the earlier row from it).
  const lastRow = (dlg, id) => dlg.down(id).items.getRange().slice(-1)[0]

  // (a) Add this node, THEN Add initiator + set the Windows IQN, then Create.
  jobs.length = 0
  grid.down('#iscsiCreate').handler(grid.down('#iscsiCreate'))
  await settle()
  let dlg = openWindow()
  ok('acl-survival: the create dialog opened', !!dlg && !!dlg.down('#name'))
  if (!dlg) { return }
  dlg.down('#name').setValue('winsrv')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#aclAddNode').handler(dlg.down('#aclAddNode'))
  await settle()
  dlg.down('#aclAdd').handler(dlg.down('#aclAdd'))
  await settle()
  eq('acl-survival(a): both rows are in the container',
    dlg.down('#aclsContainer').items.getCount(), 2)
  lastRow(dlg, '#aclsContainer').down('#aclIqn').setValue(WINDOWS_IQN)
  await settle()
  submit(dlg).handler(submit(dlg))
  await settle()
  eq('acl-survival(a): one job', jobs.length, 1)
  eq('acl-survival(a): it POSTs to the collection', [jobs[0].method, jobs[0].path],
    ['post', '/iscsi/targets'])
  eq('acl-survival(a): BOTH IQNs reach the body', jobs[0].body.acls,
    [{ initiatorIqn: ISCSI_NODE_IQN }, { initiatorIqn: WINDOWS_IQN }])

  // The two operator-requested hints, muted, in the initiator section.
  const sectionNotes = dlg.down('#aclsContainer').up().items.getRange()
    .map(c => c.html || '').join('\n')
  ok('acl-survival: the discovery hint renders in the initiator section',
    /Initiators must be listed here before they can discover this target/.test(sectionNotes), sectionNotes)
  ok('acl-survival: the all-LUNs-visible hint renders in the initiator section',
    /Every initiator listed sees all of this target's LUNs/.test(sectionNotes), sectionNotes)

  // (b) Add initiator + set the Windows IQN, THEN Add this node, then Create.
  jobs.length = 0
  grid.down('#iscsiCreate').handler(grid.down('#iscsiCreate'))
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('winsrv2')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#aclAdd').handler(dlg.down('#aclAdd'))
  await settle()
  // The IQN goes into this row NOW, before the second add — a pre-fix dialog
  // would evict it from the collection afterwards, but the box keeps the text.
  lastRow(dlg, '#aclsContainer').down('#aclIqn').setValue(WINDOWS_IQN)
  await settle()
  dlg.down('#aclAddNode').handler(dlg.down('#aclAddNode'))
  await settle()
  eq('acl-survival(b): both rows are in the container',
    dlg.down('#aclsContainer').items.getCount(), 2)
  submit(dlg).handler(submit(dlg))
  await settle()
  eq('acl-survival(b): one job', jobs.length, 1)
  eq('acl-survival(b): BOTH IQNs reach the body, order kept', jobs[0].body.acls,
    [{ initiatorIqn: WINDOWS_IQN }, { initiatorIqn: ISCSI_NODE_IQN }])

  // (c) The paste: the Windows IQN lands in the box via pasteInto (the DOM
  // input), NOT setValue — straight to Create with the value still
  // UNCOMMITTED: the box is what the operator sees, so the box is what gets
  // sent.
  jobs.length = 0
  grid.down('#iscsiCreate').handler(grid.down('#iscsiCreate'))
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('winsrv3')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#aclAddNode').handler(dlg.down('#aclAddNode'))
  await settle()
  dlg.down('#aclAdd').handler(dlg.down('#aclAdd'))
  await settle()
  lastRow(dlg, '#aclsContainer').down('#aclIqn').pasteInto(WINDOWS_IQN)
  submit(dlg).handler(submit(dlg))
  await settle()
  eq('acl-survival(c): an UNCOMMITTED paste still submits', jobs.length, 1)
  // (Pre-fix this order can also gate out entirely: the evicted-collection
  // dialog reads zero ACL rows, so the create save-gate blocks the button.)
  if (jobs.length) {
    eq('acl-survival(c): BOTH IQNs reach the body', jobs[0].body.acls,
      [{ initiatorIqn: ISCSI_NODE_IQN }, { initiatorIqn: WINDOWS_IQN }])
  }

  // (c2) the same paste with the blur that commits it before Create.
  jobs.length = 0
  grid.down('#iscsiCreate').handler(grid.down('#iscsiCreate'))
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('winsrv4')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#aclAddNode').handler(dlg.down('#aclAddNode'))
  await settle()
  dlg.down('#aclAdd').handler(dlg.down('#aclAdd'))
  await settle()
  const pasted = lastRow(dlg, '#aclsContainer').down('#aclIqn')
  pasted.pasteInto(WINDOWS_IQN)
  pasted.blur()
  await settle()
  submit(dlg).handler(submit(dlg))
  await settle()
  eq('acl-survival(c2): a committed paste still submits', jobs.length, 1)
  eq('acl-survival(c2): BOTH IQNs reach the body', jobs[0].body.acls,
    [{ initiatorIqn: ISCSI_NODE_IQN }, { initiatorIqn: WINDOWS_IQN }])

  // (d) EDIT: the dialog opens on the stored ACL; Add initiator with the
  // Windows IQN; Save → the PUT body carries the COMPLETE list, both ACLs —
  // and the stored row's blank secret box still means "keep", not "clear".
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))
  jobs.length = 0
  grid.down('#iscsiEdit').handler(grid.down('#iscsiEdit'))
  await settle()
  dlg = openWindow()
  eq('acl-survival(d): the edit opened on the one stored row',
    dlg.down('#aclsContainer').items.getCount(), 1)
  dlg.down('#aclAdd').handler(dlg.down('#aclAdd'))
  await settle()
  lastRow(dlg, '#aclsContainer').down('#aclIqn').setValue(WINDOWS_IQN)
  await settle()
  submit(dlg).handler(submit(dlg))
  await settle()
  eq('acl-survival(d): one job', jobs.length, 1)
  eq('acl-survival(d): it PUTs at the target', [jobs[0].method, jobs[0].path],
    ['put', `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`])
  eq('acl-survival(d): the PUT body carries BOTH ACLs, stored one untouched',
    jobs[0].body.acls,
    [{ initiatorIqn: ISCSI_INITIATOR }, { initiatorIqn: WINDOWS_IQN }])

  // (e) PORTALS, the same class of bug: two portal rows (Add portal twice),
  // two addresses — both must reach the POST body's portals array.
  jobs.length = 0
  grid.down('#iscsiCreate').handler(grid.down('#iscsiCreate'))
  await settle()
  dlg = openWindow()
  dlg.down('#name').setValue('winsrv5')
  dlg.down('#portalAddress').setValue('192.168.200.50')
  dlg.down('#aclAddNode').handler(dlg.down('#aclAddNode'))
  await settle()
  dlg.down('#portalAdd').handler(dlg.down('#portalAdd'))
  await settle()
  lastRow(dlg, '#portalsContainer').down('#portalAddress').setValue('127.0.0.1')
  await settle()
  submit(dlg).handler(submit(dlg))
  await settle()
  eq('portal-survival(e): one job', jobs.length, 1)
  eq('portal-survival(e): BOTH portals reach the body', jobs[0].body.portals,
    [{ address: '192.168.200.50', port: 3260 }, { address: '127.0.0.1', port: 3260 }])

  ok('row-survival: nothing warned', warnings.length === 0, warnings.join(' | '))
}

/** Open the LUNs window on the ANAS target. */
async function openLuns(grid, routes) {
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))
  const btn = grid.down('#iscsiLuns')
  btn.handler(btn)
  await settle()
  return openWindow()
}

async function iscsiLunChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { view, grid } = await openIscsiView(ISCSI_ROUTES)
  const lunsWin = await openLuns(grid, ISCSI_ROUTES)
  ok('luns: the window opened', !!lunsWin && !!lunsWin.down('#lunsGrid'))
  if (!lunsWin) { return }
  const lunsGrid = lunsWin.down('#lunsGrid')
  eq('luns: both LUNs loaded', lunsGrid.getStore().getCount(), 2)

  const LUN_BTNS = ['lunAdd', 'lunResize', 'lunDelete']
  let state = toolbar(lunsGrid, LUN_BTNS)
  ok('luns: Add is enabled on an ANAS target', state.lunAdd.disabled === false)
  ok('luns: Resize needs a selection', state.lunResize.disabled === true)

  lunsGrid.selectRow(0)
  state = toolbar(lunsGrid, LUN_BTNS)
  ok('luns(selected): Resize enabled', state.lunResize.disabled === false)
  ok('luns(selected): Delete enabled', state.lunDelete.disabled === false)

  // --- Add LUN: the zvol branch --------------------------------------------
  jobs.length = 0
  let btn = lunsGrid.down('#lunAdd')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('addlun: the dialog opened', !!dlg && !!dlg.down('#lunName'))
  if (!dlg) { return }
  eq('addlun: it defaults to a zvol', dlg.down('#kindGroup').getValue(), { lunKind: 'zvol' })
  ok('addlun: the image fields start hidden AND disabled', dlg.down('#size').hidden === true
    && dlg.down('#size').disabled === true)
  ok('addlun: the zvol picker is visible', dlg.down('#zvolPicker').hidden === false)

  const zvols = dlg.down('#zvolPicker').getStore().getRange().map(r => r.get('name'))
  ok('addlun: the picker offers ANAS-managed volumes', zvols.includes('tank/vol1') && zvols.includes('tank/vol2'),
    JSON.stringify(zvols))
  ok('addlun: a PVE guest disk is NEVER a candidate', !zvols.includes('tank/vm-101-disk-0'), JSON.stringify(zvols))
  ok('addlun: a PVE-managed pool is not even enumerated',
    !zvols.some(z => z.startsWith('pvepool')), JSON.stringify(zvols))
  ok('addlun: filesystems are not offered as zvols', !zvols.includes('tank/images'), JSON.stringify(zvols))

  const dirs = dlg.down('#filePicker').getStore().getRange().map(r => r.get('name'))
  ok('addlun: the image-file picker offers datasets AND the AHR pool',
    dirs.includes('tank/images') && dirs.includes('ahrpool'), JSON.stringify(dirs))
  ok('addlun: it does not offer a zvol as a place to put a file',
    !dirs.includes('tank/vol1'), JSON.stringify(dirs))

  ok('addlun: the attribute summary states what ANAS sets',
    /Thin reclaim on/.test(dlg.down('#lunAttrSummary').html)
    && /Write-through/.test(dlg.down('#lunAttrSummary').html),
    dlg.down('#lunAttrSummary').html)
  ok('addlun: and that the serial survives a recreate',
    /unit serial that survives every recreate/.test(dlg.down('#lunAttrSummary').html),
    dlg.down('#lunAttrSummary').html)

  dlg.down('#lunName').setValue('vmdisk3')
  dlg.down('#zvolPicker').setValue('tank/vol2')
  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-submit')
  submit.handler(submit)
  await settle()
  eq('addlun(zvol): one job', jobs.length, 1)
  eq('addlun(zvol): it POSTs to the target\'s LUN collection', jobs[0].path,
    `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}/luns`)
  eq('addlun(zvol): the body names the volume and carries NO size and NO block size',
    jobs[0].body, { name: 'vmdisk3', kind: 'zvol', backing: 'tank/vol2' })

  // --- Add LUN: the file branch --------------------------------------------
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#kindGroup').setValue({ lunKind: 'file' })
  await settle()
  ok('addlun(file): the image fields appear', dlg.down('#size').hidden === false
    && dlg.down('#filePicker').hidden === false)
  ok('addlun(file): the zvol picker goes away AND is disabled, so a stale value cannot be read back',
    dlg.down('#zvolPicker').hidden === true && dlg.down('#zvolPicker').disabled === true)
  ok('addlun(file): the honest reclaim caveat appears for an image file',
    /rejected by LIO for this backend/.test(dlg.down('#lunAttrSummary').html),
    dlg.down('#lunAttrSummary').html)
  ok('addlun(file): and that its size is fixed at creation',
    /fixed at creation/.test(dlg.down('#lunAttrSummary').html), dlg.down('#lunAttrSummary').html)

  dlg.down('#lunName').setValue('vmdisk4')
  dlg.down('#filePicker').setValue('tank/images')
  dlg.down('#size').setValue(4)
  dlg.down('#unit').setValue(GiB_)
  dlg.down('#blockSize').setValue(4096)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-submit')
  submit.handler(submit)
  await settle()
  eq('addlun(file): the body carries the host, the size in BYTES and the block size',
    jobs[0].body, { name: 'vmdisk4', kind: 'file', backing: 'tank/images', size: 4 * GiB_, blockSize: 4096 })

  // A blank block size sends NO key — LIO then applies its own 512.
  jobs.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#lunName').setValue('vmdisk5')
  dlg.down('#zvolPicker').setValue('tank/vol2')
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-submit')
  submit.handler(submit)
  await settle()
  ok('addlun: a default block size sends no blockSize at all',
    !('blockSize' in jobs[0].body), JSON.stringify(jobs[0].body))

  ok('addlun: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiResizeAndDeleteChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { grid } = await openIscsiView(ISCSI_ROUTES)
  const lunsWin = await openLuns(grid, ISCSI_ROUTES)
  const lunsGrid = lunsWin.down('#lunsGrid')

  // --- Resize the ZVOL LUN (index 0, 2 GiB) --------------------------------
  lunsGrid.selectRow(0)
  jobs.length = 0
  let btn = lunsGrid.down('#lunResize')
  btn.handler(btn)
  await settle()
  let dlg = openWindow()
  ok('resize: the window opened', !!dlg && !!dlg.down('#size'))
  eq('resize: it pre-fills the CURRENT size in the largest exact unit',
    [dlg.down('#size').getValue(), dlg.down('#unit').getValue()], [2, GiB_])
  ok('resize: the serial is shown — it is the identity the initiator keys on',
    String(dlg.down('#currentSerial').value).includes('9bc6e907'), dlg.down('#currentSerial').value)
  ok('resize(zvol): the note says a volume grows LIVE',
    /grows live/.test(dlg.down('#resizeNote').html), dlg.down('#resizeNote').html)

  let submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: an untouched edit sends NOTHING', jobs.length, 0)
  ok('resize: and closes', dlg.destroyed === true)

  // A shrink is refused before it can reach the daemon.
  jobs.length = 0
  warnings.length = 0
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  dlg.down('#size').setValue(1)
  submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-lun-resize-submit')
  submit.handler(submit)
  await settle()
  eq('resize: a shrink sends NOTHING', jobs.length, 0)
  ok('resize: a shrink says why', warnings.some(w => /can only grow/.test(w)), warnings.join(' | '))
  ok('resize: a shrink leaves the window open to fix', dlg.destroyed === false)
  warnings.length = 0

  // A grow is a PUT of the size alone.
  dlg.down('#size').setValue(8)
  submit.handler(submit)
  await settle()
  eq('resize: one job', jobs.length, 1)
  eq('resize: it PUTs at the LUN index', [jobs[0].method, jobs[0].path],
    ['put', `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}/luns/0`])
  eq('resize: it sends the size and nothing else', jobs[0].body, { size: 8 * GiB_ })

  // --- The FILE LUN says its resize is a recreate ---------------------------
  lunsGrid.selectRow(1)
  btn = lunsGrid.down('#lunResize')
  btn.handler(btn)
  await settle()
  dlg = openWindow()
  ok('resize(file): the note says the backstore is RECREATED with the same identity',
    /same unit serial/i.test(dlg.down('#resizeNote').html) && /same attributes/i.test(dlg.down('#resizeNote').html),
    dlg.down('#resizeNote').html)
  ok('resize(file): and that this is because the size is fixed at creation',
    /fixed at creation/.test(dlg.down('#resizeNote').html), dlg.down('#resizeNote').html)
  dlg.close()

  // --- Delete a LUN ---------------------------------------------------------
  lunsGrid.selectRow(0)
  jobs.length = 0
  const del = lunsGrid.down('#lunDelete')
  del.handler(del)
  await settle()
  eq('deletelun: one request', jobs.length, 1)
  eq('deletelun: it DELETEs the LUN with NO destroy flag by default',
    [jobs[0].method, jobs[0].path],
    ['del', `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}/luns/0`])
  ok('deletelun: it is confirm-gated with a widget window', jobs[0].confirmWindow === true)

  // The destructive half is a SEPARATE ticked choice that becomes a query flag.
  const extra = makeComponent({ xtype: 'window', items: jobs[0].extraItems }, null)
  const box = extra.down('#destroyBacking')
  ok('deletelun: the destroy-backing checkbox exists and starts UNticked',
    !!box && box.getValue() === false)
  ok('deletelun: it names the object it would destroy',
    /\/dev\/zvol\/tank\/vol1/.test(box.boxLabel), box.boxLabel)
  ok('deletelun: and warns a zvol takes its snapshots with it',
    /snapshots/.test(box.boxLabel), box.boxLabel)
  eq('deletelun: unticked adds no query at all', jobs[0].mapConfirm(extra), {})
  box.setValue(true)
  eq('deletelun: ticked becomes ?destroyBacking=true',
    jobs[0].mapConfirm(extra), { pathSuffix: '?destroyBacking=true' })

  ok('resize/delete: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiSessionGatingChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  // The same target, but with an initiator logged in on LUN 0.
  const routes = {
    ...ISCSI_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: iscsiDetail({ session: true }) },
  }
  const { grid } = await openIscsiView(routes)
  const lunsWin = await openLuns(grid, routes)
  const lunsGrid = lunsWin.down('#lunsGrid')

  // LUN 0 is the ZVOL, and it is the one with the session.
  lunsGrid.selectRow(0)
  let state = toolbar(lunsGrid, ['lunAdd', 'lunResize', 'lunDelete'])
  // Live-proof F13: the two doors used to disagree about the same safe
  // operation — Datasets accepted a grow of the held zvol, this one refused
  // every resize. A zvol grow is live end to end (measured: the initiator kept
  // showing the old size until `iscsiadm -R`, then the new one), so it is
  // allowed here too. A FILE-backed LUN's resize is a backstore recreate and
  // stays refused.
  ok('session: growing a ZVOL LUN is allowed under a live session', state.lunResize.disabled === false)
  ok('session: Delete is DISABLED under a live session', state.lunDelete.disabled === true)
  ok('session: the delete reason says LIO would not have refused',
    /stale device/.test(state.lunDelete.tip), state.lunDelete.tip)
  ok('session: Add LUN is still allowed', state.lunAdd.disabled === false)

  // …and the dialog tells the operator the one thing that is not obvious.
  let btn = lunsGrid.down('#lunResize')
  btn.handler(btn)
  await settle()
  let resizeWin = openWindow()
  let note = String(resizeWin.down('#resizeNote').html)
  ok('session: the resize dialog says the initiator must RESCAN to see it',
    /iscsiadm -m node -R/.test(note), note)
  ok('session: …and that the filesystem on top is a separate job',
    /grown separately/.test(note), note)
  resizeWin.close()
  await settle()

  lunsGrid.selectRow(1) // the FILE LUN, nobody logged in
  state = toolbar(lunsGrid, ['lunResize', 'lunDelete'])
  ok('session: a LUN with no session is still resizable', state.lunResize.disabled === false)
  ok('session: …and deletable', state.lunDelete.disabled === false)

  // The other half of F13: move the session onto the FILE LUN. Its size is fixed
  // at creation, so a resize deletes and recreates the backstore under the
  // initiator — refused, with the reason stated.
  const fileRoutes = {
    ...ISCSI_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: iscsiDetail({ session: true, sessionLun: 1 }) },
  }
  const fileView = await openIscsiView(fileRoutes)
  const fileLuns = (await openLuns(fileView.grid, fileRoutes)).down('#lunsGrid')
  fileLuns.selectRow(1)
  state = toolbar(fileLuns, ['lunResize', 'lunDelete'])
  ok('session: a FILE LUN is NOT resizable under a live session', state.lunResize.disabled === true)
  ok('session: …and the tip says why it is different from a zvol',
    /fixed at creation/.test(state.lunResize.tip) && /zvol-backed LUN grows live/.test(state.lunResize.tip),
    state.lunResize.tip)
  fileLuns.selectRow(0)
  state = toolbar(fileLuns, ['lunResize'])
  ok('session: the zvol sibling of a busy file LUN is unaffected', state.lunResize.disabled === false)

  // The live session is SHOWN, with its address — and never the misleading
  // `(NOT AUTHENTICATED)` label targetcli prints for one-way CHAP.
  const panel = lunsWin.down('#lunSessions')
  ok('session: the detail lists the logged-in initiator',
    String(panel.html).includes(ISCSI_INITIATOR), panel.html)
  ok('session: with the address it connected from',
    String(panel.html).includes('192.168.200.60'), panel.html)
  ok('session: and never the misleading NOT AUTHENTICATED label',
    !/NOT AUTHENTICATED/.test(String(panel.html)), panel.html)

  ok('session: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ---------------------------------------------------------------------------
//  The target-delete gate: only an EMPTY, session-free target is deletable
// ---------------------------------------------------------------------------
//
// The daemon refuses a target delete with live sessions (they drop, and the
// devices go stale with no kernel message — no confirm bypass) and with any
// LUN (delete the LUNs first, where destroyBacking is the per-LUN choice). So
// the button is dead with the reason while either is true; what remains is not
// data-destroying, so it is a PLAIN confirm, never a confirm-code flow.

async function iscsiTargetDeleteChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  // One target in each state the gate knows: live sessions, and — the only
  // deletable one — empty and quiet.
  const EMPTY_IQN = 'iqn.2026-08.nas.anas:empty'
  const targets = {
    ...ISCSI_TARGETS,
    targets: [
      { ...ISCSI_TARGETS.targets[0], lunCount: 0, sessionCount: 2 },
      {
        ...ISCSI_TARGETS.targets[0],
        iqn: EMPTY_IQN,
        name: 'empty',
        lunCount: 0,
        sessionCount: 0,
        ownershipDetail: 'IQN follows the ANAS naming convention; the target has no LUNs',
      },
    ],
  }
  const { grid } = await openIscsiView({ ...ISCSI_ROUTES, 'GET /iscsi/targets': { data: targets } })

  // Live sessions: dead, and the tooltip counts them and says the way out.
  grid.selectRow(0)
  let state = toolbar(grid, ['iscsiDelete'])
  ok('delgate(sessions): Delete is DISABLED while initiators are connected',
    state.iscsiDelete.disabled === true)
  ok('delgate(sessions): the tooltip counts them and says to log them out',
    /2 initiators connected — log them out first/.test(state.iscsiDelete.tip),
    state.iscsiDelete.tip)

  // The empty, quiet one: live, with nothing to clear first.
  grid.selectRow(iscsiRowOf(grid, EMPTY_IQN))
  state = toolbar(grid, ['iscsiDelete'])
  ok('delgate(empty): Delete is ENABLED on an empty, session-free target',
    state.iscsiDelete.disabled === false)
  ok('delgate(empty): and it says nothing — there is nothing to clear first',
    state.iscsiDelete.tip === '', state.iscsiDelete.tip)

  // Pressing it: a PLAIN confirm (the harness answers yes), then a plain
  // DELETE. Not confirmAndRun — so no confirm-code flow and no widget window.
  jobs.length = 0
  confirms.length = 0
  grid.down('#iscsiDelete').handler(grid.down('#iscsiDelete'))
  await settle()
  eq('delgate: one request', jobs.length, 1)
  eq('delgate: it DELETEs the target', [jobs[0].method, jobs[0].path],
    ['del', '/iscsi/targets/' + encodeURIComponent(EMPTY_IQN)])
  ok('delgate: it is NOT a confirm-code flow — no confirm window, no widgets',
    !jobs[0].confirmWindow && !jobs[0].extraItems)
  ok('delgate: and the confirm was the plain one, naming the empty target',
    confirms.length === 1 && /Delete empty target/.test(confirms[0].msg) && confirms[0].msg.includes('empty'),
    JSON.stringify(confirms))

  ok('delgate: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiForeignLunChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { grid } = await openIscsiView(ISCSI_ROUTES)
  grid.selectRow(iscsiRowOf(grid, ISCSI_FOREIGN))
  const btn = grid.down('#iscsiLuns')
  btn.handler(btn)
  await settle()
  const win = openWindow()
  const lunsGrid = win.down('#lunsGrid')
  const state = toolbar(lunsGrid, ['lunAdd', 'lunResize', 'lunDelete'])
  ok('foreign luns: Add LUN is DISABLED on a foreign target', state.lunAdd.disabled === true)
  ok('foreign luns: Resize is DISABLED', state.lunResize.disabled === true)
  ok('foreign luns: Delete is DISABLED', state.lunDelete.disabled === true)
  ok('foreign luns: the reason is hands-off, not a generic refusal',
    /not managed by ANAS/.test(state.lunAdd.tip), state.lunAdd.tip)
  ok('foreign luns: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ---------------------------------------------------------------------------
//  iscsi.5 — the Repair door and the `unresolved` backing tier
// ---------------------------------------------------------------------------
//
// A boot restore whose backing device was missing exits 0 and systemd logs
// `Result=success`, so the Repair button is the operator's only handle on it.
// It has to be live ONLY when a hole's backing object is actually back —
// recreating a backstore over an absent device is how the hole was made — and
// when it is not live it has to say what is still missing.

async function iscsiRepairChecks() {
  ajax.responses = { '/network': PVE_NETWORK }

  // 1. Healthy: nothing to repair, and the button says so rather than sitting
  //    greyed with no explanation.
  let view = (await openIscsiView(ISCSI_ROUTES)).view
  let grid = view.down('#iscsiGrid')
  let state = toolbar(grid, ['iscsiRepair'])
  ok('repair(healthy): the button exists on the iSCSI toolbar', state.iscsiRepair !== null)
  ok('repair(healthy): DISABLED', state.iscsiRepair.disabled === true)
  ok('repair(healthy): says there is nothing to repair',
    /Nothing to repair/.test(state.iscsiRepair.tip), state.iscsiRepair.tip)

  // 2. A hole whose backing is STILL MISSING: refused, and the tooltip names
  //    the path so the operator knows what to bring back.
  created.windows.length = 0
  view = (await openIscsiView({ ...ISCSI_ROUTES, 'GET /iscsi/health': iscsiHealth({ missing: [iscsiHole(false)] }) })).view
  grid = view.down('#iscsiGrid')
  state = toolbar(grid, ['iscsiRepair'])
  ok('repair(absent): still DISABLED — a recreate over an absent device made the hole',
    state.iscsiRepair.disabled === true)
  ok('repair(absent): names the backing path that has to come back',
    /\/dev\/zvol\/tank\/vol1/.test(state.iscsiRepair.tip), state.iscsiRepair.tip)

  // 3. The backing is BACK: live, and it POSTs the node-level repair.
  created.windows.length = 0
  jobs.length = 0
  view = (await openIscsiView({
    ...ISCSI_ROUTES,
    'GET /iscsi/health': iscsiHealth({ missing: [iscsiHole(true)] }),
  })).view
  grid = view.down('#iscsiGrid')
  state = toolbar(grid, ['iscsiRepair'])
  ok('repair(present): ENABLED once the backing object resolves again',
    state.iscsiRepair.disabled === false)
  ok('repair(present): the tooltip promises the SAME disk, not a new one',
    /same serial and attributes/.test(state.iscsiRepair.tip), state.iscsiRepair.tip)
  const btn = grid.down('#iscsiRepair')
  btn.handler(btn)
  await settle()
  eq('repair(present): POSTs the node-level repair, with no per-target path',
    { method: jobs[0].method, path: jobs[0].path }, { method: 'post', path: '/iscsi/health/repair' })

  // 4. Not installed: the whole toolbar is flat, Repair included.
  created.windows.length = 0
  view = (await openIscsiView({
    'GET /iscsi/targets': { data: { installed: false, configfsPresent: false, saveconfigPresent: false, reason: 'no LIO', targets: [] } },
  })).view
  grid = view.down('#iscsiGrid')
  ok('repair(not-installed): DISABLED with the rest of the toolbar',
    toolbar(grid, ['iscsiRepair']).iscsiRepair.disabled === true)

  ok('repair: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiUnresolvedLunChecks() {
  // "Not on this node right now" is NOT "somebody else's" (live-proof F2): the
  // target stays ANAS's — the toolbar is live — but the LUN itself cannot be
  // resized, because there is no backing object to grow.
  ajax.responses = { '/network': PVE_NETWORK }
  const detail = iscsiDetail()
  detail.ownershipReason = 'backing-unresolved'
  detail.luns[1] = { ...detail.luns[1], kind: 'unresolved', backingExists: false, present: false, pool: undefined, dataset: undefined }
  const targets = { ...ISCSI_TARGETS, targets: [{ ...ISCSI_TARGETS.targets[0], ownershipReason: 'backing-unresolved' }, ISCSI_TARGETS.targets[1]] }

  const { grid } = await openIscsiView({
    ...ISCSI_ROUTES,
    'GET /iscsi/targets': { data: targets },
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: detail },
  })

  // The target is still ANAS's: the verbs stay available — Delete still needs
  // the LUNs gone first (this row carries two), but it is NOT hands-off.
  grid.selectRow(iscsiRowOf(grid, ISCSI_IQN))
  const targetState = toolbar(grid, ['iscsiEdit', 'iscsiDelete', 'iscsiLuns'])
  ok('unresolved: an unresolved LUN does NOT make its target hands-off',
    targetState.iscsiEdit.disabled === false)
  ok('unresolved: …but Delete still says the LUNs must go first',
    targetState.iscsiDelete.disabled === true && /Delete its 2 LUNs first/.test(targetState.iscsiDelete.tip),
    targetState.iscsiDelete.tip)

  const btn = grid.down('#iscsiLuns')
  btn.handler(btn)
  await settle()
  const win = openWindow()
  const lunsGrid = win.down('#lunsGrid')
  const rec = lunsGrid.getStore().getAt(1)
  ok('unresolved: the row carries the new kind', rec.get('kind') === 'unresolved')

  lunsGrid.selectRow(1)
  const state = toolbar(lunsGrid, ['lunResize', 'lunDelete'])
  ok('unresolved: Resize is DISABLED — there is nothing on this node to grow',
    state.lunResize.disabled === true)
  ok('unresolved: and it says why, pointing at Repair',
    /not on this node right now/i.test(state.lunResize.tip) && /Repair/.test(state.lunResize.tip),
    state.lunResize.tip)
  // Unmapping a LUN whose backing is gone is still legitimate cleanup.
  ok('unresolved: Delete stays available', state.lunDelete.disabled === false)

  ok('unresolved: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  7. Restore a LUN from a PBS backup — the size gate (story backup2.7)
// ============================================================================
//
// The one thing this section exists to hold down: a backup image that is not
// EXACTLY the size of the LUN is silently destructive below ANAS (a larger one
// writes until the device is full and leaves the LUN half-overwritten, a
// smaller one succeeds and leaves stale bytes past its end). The daemon refuses
// a mismatch too — safety lives in the API — but a dialog that lets the button
// be pressed and then explains why not is a dialog that failed.

/** The repositories the restore dialog offers: both tiers, as the wizard sees them. */
const RESTORE_REPOS = {
  data: {
    version: 3,
    repos: [
      { name: 'pbs-main', host: 'pbs.example', port: 8007, datastore: 'store', authType: 'token', namespace: 'anas', credentialsSet: true, source: 'anas' },
      { name: 'pve:anastest', host: '10.0.0.9', port: 8007, datastore: 'anastest-store', authType: 'password', credentialsSet: true, source: 'pve' },
    ],
  },
}

const RESTORE_SNAP = 'host/gtimgboth/2026-08-25T19:28:38Z'
const RESTORE_SNAP_OLD = 'host/gtimgboth/2026-08-24T19:28:38Z'

// backup2.9 — a block task's backup-id derives from the LUN's unit serial, so
// its PBS group IS this LUN's durable identity. The LUN door resolves THIS
// group when it exists, else falls back to the repository's `.img` groups.
const LUN_SERIAL = LUN_SOURCES[0].serial
const LUN_GROUP = `host/lun-${LUN_SERIAL}`
const LUN_SNAP = `${LUN_GROUP}/2026-08-25T19:28:38Z`

/**
 * backup2.5's groups endpoint answers in TWO shapes from one path, so the
 * fixture is a function of the query — which is also how the two-call contract
 * gets asserted at all.
 *
 * Without `?group=`: the namespace's GROUPS, each carrying its classified
 * filenames. `host/etc-only` holds only a pxar and must never be offered — a
 * tree cannot restore a block device.
 *
 * With `?group=`: that group's POINTS IN TIME, in the same `BackupSnapshot`
 * shape the task endpoint uses. `gtimgboth` holds two images: one exactly the
 * LUN's 2 GiB and one a mismatched 1 GiB.
 */
const RESTORE_GROUP_LIST = {
  data: {
    verdict: 'ok',
    repository: 'pbs-main',
    namespace: 'anas',
    groups: [
      {
        group: LUN_GROUP,
        backupType: 'host',
        backupId: `lun-${LUN_SERIAL}`,
        backupCount: 2,
        lastBackup: 1787686118,
        lastBackupIso: '2026-08-25T19:28:38Z',
        files: [
          { filename: 'disk.img.fidx', archive: 'disk.img', kind: 'img', size: 2 * GiB_ },
          { filename: 'index.json.blob', kind: 'other', size: 368 },
        ],
      },
      {
        group: 'host/gtimgboth',
        backupType: 'host',
        backupId: 'gtimgboth',
        backupCount: 2,
        lastBackup: 1787686118,
        lastBackupIso: '2026-08-25T19:28:38Z',
        files: [
          { filename: 'vol.img.fidx', archive: 'vol.img', kind: 'img', size: 2 * GiB_ },
          { filename: 'small.img.fidx', archive: 'small.img', kind: 'img', size: GiB_ },
          { filename: 'index.json.blob', kind: 'other', size: 368 },
        ],
      },
      {
        group: 'host/etc-only',
        backupType: 'host',
        backupId: 'etc-only',
        backupCount: 1,
        lastBackupIso: '2026-08-25T02:00:00Z',
        files: [
          { filename: 'etc.pxar.didx', archive: 'etc.pxar', kind: 'pxar', size: 1234 },
          { filename: 'catalog.pcat1.didx', kind: 'other', size: 99 },
        ],
      },
    ],
  },
}

const RESTORE_GROUP_SNAPSHOTS = {
  data: {
    verdict: 'ok',
    repository: 'pbs-main',
    namespace: 'anas',
    group: 'host/gtimgboth',
    groups: [],
    snapshots: [
      {
        snapshot: RESTORE_SNAP,
        backupType: 'host',
        backupId: 'gtimgboth',
        backupTime: 1787686118,
        backupTimeIso: '2026-08-25T19:28:38Z',
        files: [
          { filename: 'vol.img.fidx', archive: 'vol.img', kind: 'img', size: 2 * GiB_ },
          { filename: 'small.img.fidx', archive: 'small.img', kind: 'img', size: GiB_ },
          { filename: 'index.json.blob', kind: 'other', size: 368 },
        ],
      },
      {
        snapshot: RESTORE_SNAP_OLD,
        backupType: 'host',
        backupId: 'gtimgboth',
        backupTime: 1787599718,
        backupTimeIso: '2026-08-24T19:28:38Z',
        files: [
          { filename: 'vol.img.fidx', archive: 'vol.img', kind: 'img', size: 2 * GiB_ },
          // A tree archive whose NAME ends in `.img` — the KIND decides, so it
          // must not reach the archive list.
          { filename: 'weird.img.pxar.didx', archive: 'weird.img.pxar', kind: 'pxar', size: 77 },
        ],
      },
    ],
  },
}

/**
 * The LUN's own group's points in time — the size gate's playground: one image
 * EXACTLY this LUN's 2 GiB (`disk.img`, the block task's fixed archive name)
 * and one mismatched 1 GiB.
 */
const LUN_GROUP_SNAPSHOTS = {
  data: {
    verdict: 'ok',
    repository: 'pbs-main',
    namespace: 'anas',
    group: LUN_GROUP,
    groups: [],
    snapshots: [
      {
        snapshot: LUN_SNAP,
        backupType: 'host',
        backupId: `lun-${LUN_SERIAL}`,
        backupTime: 1787686118,
        backupTimeIso: '2026-08-25T19:28:38Z',
        files: [
          { filename: 'disk.img.fidx', archive: 'disk.img', kind: 'img', size: 2 * GiB_ },
          { filename: 'small.img.fidx', archive: 'small.img', kind: 'img', size: GiB_ },
          { filename: 'index.json.blob', kind: 'other', size: 368 },
        ],
      },
    ],
  },
}

const RESTORE_ROUTES = {
  ...ISCSI_ROUTES,
  'GET /backup/repos': RESTORE_REPOS,
  'GET /backup/repos/pbs-main/groups': path => {
    // The group travels URL-encoded (`host%2Flun-<serial>`), so match the
    // serial, not the slash.
    if (`/lun-${LUN_SERIAL}` && /[?&]group=/.test(path) && decodeURIComponent(path).includes(LUN_GROUP)) {
      return LUN_GROUP_SNAPSHOTS
    }
    return /[?&]group=/.test(path) ? RESTORE_GROUP_SNAPSHOTS : RESTORE_GROUP_LIST
  },
}

/**
 * Open the LUNs window, select LUN 0 (the 2 GiB zvol), and open Restore — which
 * is now the UNIFIED restore dialog (68-backup.js's), reached through the LUN
 * toolbar door's `{lun}` prefill. Both sources load into one sandbox exactly as
 * the real page loads them.
 */
async function openRestoreDialog(routes = RESTORE_ROUTES) {
  ajax.responses = { '/network': PVE_NETWORK }
  const ANAS = loadSources(['12-picker.js', '68-backup.js', '75-iscsi.js'], routes)
  const view = makeComponent(ANAS.views.iscsi.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#iscsiGrid')
  const lunsWin = await openLuns(grid, routes)
  const lunsGrid = lunsWin.down('#lunsGrid')
  lunsGrid.selectRow(0)
  const btn = lunsGrid.down('#lunRestore')
  btn.handler(btn)
  await settle()
  return { ANAS, view, grid, lunsWin, lunsGrid, dlg: openWindow() }
}

async function iscsiRestoreGatingChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { grid } = await openIscsiView(RESTORE_ROUTES)
  const lunsWin = await openLuns(grid, RESTORE_ROUTES)
  const lunsGrid = lunsWin.down('#lunsGrid')

  let state = toolbar(lunsGrid, ['lunRestore'])
  ok('restore: the button exists and needs a selection', state.lunRestore !== null
    && state.lunRestore.disabled === true)

  lunsGrid.selectRow(0)
  state = toolbar(lunsGrid, ['lunRestore'])
  ok('restore: a zvol LUN with a present backing and a known size is restorable',
    state.lunRestore.disabled === false, state.lunRestore.tip)

  // A FOREIGN target keeps its hands off, selection and all — the `foreign`
  // clause is the door's only live case.
  created.windows.length = 0
  const foreignRoutes = {
    ...RESTORE_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_FOREIGN)}`]: {
      data: {
        ...ISCSI_TARGETS.targets[1],
        luns: [{
          index: 0, name: 'xvol', kind: 'foreign', plugin: 'fileio',
          backingPath: '/unknown/x', size: GiB_, serial: 'ffffffff-0000-0000-0000-000000000000',
          attributes: {}, connectedInitiators: [], present: true, backingExists: true,
        }],
        acls: [], sessions: [],
      },
    },
  }
  const { grid: fGrid } = await openIscsiView(foreignRoutes)
  fGrid.selectRow(iscsiRowOf(fGrid, ISCSI_FOREIGN))
  fGrid.down('#iscsiLuns').handler(fGrid.down('#iscsiLuns'))
  await settle()
  const fWin = openWindow()
  const fLuns = fWin.down('#lunsGrid')
  fLuns.selectRow(0)
  state = toolbar(fLuns, ['lunRestore'])
  ok('restore(foreign): DISABLED on a foreign target, selection and all — hands-off',
    state.lunRestore.disabled === true)
  ok('restore(foreign): and says the target is not managed by ANAS',
    /not managed by ANAS/.test(state.lunRestore.tip), state.lunRestore.tip)

  ok('restore: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiRestoreSessionAndUnresolvedChecks() {
  // backup2.10 fix-up 2026-08-29: the session is NO LONGER the entry gate —
  // a new-LUN restore touches nothing live, so the door stays open and the
  // in-place refusal (with its reason) travels into the dialog's prefill
  // (lunInPlace). Only the destructive destination is refused.
  ajax.responses = { '/network': PVE_NETWORK }
  const sessionRoutes = {
    ...RESTORE_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: iscsiDetail({ session: true }) },
  }
  let { grid } = await openIscsiView(sessionRoutes)
  let lunsWin = await openLuns(grid, sessionRoutes)
  let lunsGrid = lunsWin.down('#lunsGrid')
  lunsGrid.selectRow(0)
  let state = toolbar(lunsGrid, ['lunRestore'])
  ok('restore(session): the door STAYS OPEN under a live session — a new-LUN restore touches nothing live',
    state.lunRestore.disabled === false, state.lunRestore.tip)
  ok('restore(session): the in-place refusal travels into the dialog, so the toolbar tip is empty',
    state.lunRestore.tip === '')

  // A backing that is not on this node: nothing to restore ONTO in place —
  // but a new LUN needs none of it.
  created.windows.length = 0
  const detail = iscsiDetail()
  detail.luns[1] = { ...detail.luns[1], kind: 'unresolved', backingExists: false, present: false }
  const unresolvedRoutes = {
    ...RESTORE_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: detail },
  }
  ;({ grid } = await openIscsiView(unresolvedRoutes))
  lunsWin = await openLuns(grid, unresolvedRoutes)
  lunsGrid = lunsWin.down('#lunsGrid')
  lunsGrid.selectRow(1)
  state = toolbar(lunsGrid, ['lunRestore'])
  ok('restore(unresolved): the door stays open — a new-LUN restore does not need the missing backing',
    state.lunRestore.disabled === false, state.lunRestore.tip)

  // A LUN whose size ANAS cannot read cannot be size-checked in place: the
  // equality IS the guard — but again, only for the in-place destination.
  created.windows.length = 0
  const noSize = iscsiDetail()
  noSize.luns[0] = { ...noSize.luns[0], size: null }
  const noSizeRoutes = {
    ...RESTORE_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: noSize },
  }
  ;({ grid } = await openIscsiView(noSizeRoutes))
  lunsWin = await openLuns(grid, noSizeRoutes)
  lunsGrid = lunsWin.down('#lunsGrid')
  lunsGrid.selectRow(0)
  state = toolbar(lunsGrid, ['lunRestore'])
  ok('restore(no size): the door stays open — only the size equality is in question, and that is in place',
    state.lunRestore.disabled === false, state.lunRestore.tip)

  ok('restore gating: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiRestoreLiveSessionDialogChecks() {
  // backup2.10 fix-up 2026-08-29 — the dialog half of the ruling: the door
  // opened on a LUN under a live session defaults to a new LUN, disables
  // "This LUN (in place)" through the stray-mapping machinery, carries the
  // door's own reason, and the new-LUN body is the shared schema's shape.
  const sessionRoutes = {
    ...RESTORE_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: iscsiDetail({ session: true }) },
  }
  const { dlg } = await openRestoreDialog(sessionRoutes)
  if (!dlg) { return }
  const submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-restore-submit')

  const snapBtn = dlg.down('#restoreSnapPick')
  snapBtn.handler(snapBtn)
  await settle()
  const snapWin = openWindow()
  snapWin.down('#snapGrid').selectRow(0)
  const snapSelect = snapWin.buttonCmps.find(b => b.cls === 'anas-btn-snap-select')
  snapSelect.handler(snapSelect)
  await settle()
  dlg.down('#restoreArchive').setValue('disk.img')
  await settle()

  eq('restore(live session): the destination defaults to "A new LUN…"',
    dlg.down('#restoreDest').getValue(), { restoreDest: 'newLun' })
  const inPlace = dlg.down('#restoreDest').childCmps().find(k => k.inputValue === 'inPlace')
  ok('restore(live session): "This LUN (in place)" is DISABLED', inPlace.disabled === true)
  ok('restore(live session): the door\'s reason speaks under the radio',
    /under a mounted filesystem/.test(dlg.down('#restoreInPlaceNote').html || ''),
    dlg.down('#restoreInPlaceNote').html)

  // The new-LUN path is whole legal under the session — the source LUN is
  // never touched, so nothing has to log out.
  dlg.down('#newLunName').setValue('vmdisk-live')
  dlg.down('#newLunPool').setValue('tank')
  await settle()
  eq('restore(live session): the target combo still pre-fills the LUN\'s own target',
    dlg.down('#newLunTarget').getValue(), ISCSI_IQN)
  ok('restore(live session): the new-LUN verdict is legal — Restore is live',
    submit.disabled === false, dlg.down('#newLunVerdict').html)

  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(live session): the submitted body is the newLun shape',
    jobs.length && jobs[0].body, {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: LUN_SNAP,
      archive: 'disk.img',
      target: {
        mode: 'newLun',
        targetIqn: ISCSI_IQN,
        name: 'vmdisk-live',
        backing: { kind: 'zvol', pool: 'tank' },
      },
      ns: 'anas',
    })
  ok('restore(live session): a newLun body never carries the in-place lun key',
    jobs.length && !('lun' in jobs[0].body), JSON.stringify((jobs[0] || {}).body))

  ok('restore(live session): nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function restoreDoorsLiveSessionChecks() {
  // backup2.10 fix-up 2026-08-29, part two — the verdict is ONE helper
  // (`ANAS.iscsi.lunInPlace`) the DIALOG applies to the LUN it resolves, so
  // EVERY door says the refusal before the daemon's 409 does: the task grid,
  // task Details, and the repository door alike — not just the LUN toolbar.
  // One live session on the LUN the block task maps to, for every door.
  const ANAS = loadRestoreSources()
  const liveIqnPath = `/iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`
  const groupsPath = '/backup/repos/pbs-main/groups'
  const baseGet = ANAS.api.get
  ANAS.api.get = (node, path) => {
    const [base, query] = String(path).split('?')
    if (base === '/backup/tasks') {
      // The live-LUN block task is a grid row for THIS check only — the shared
      // fixture's three-task grid is asserted elsewhere.
      return Promise.resolve({
        data: BACKUP_ROUTES['GET /backup/tasks'].data.concat([
          { task: LIVE_BLOCK_TASK, lastRunResult: 'success', enabled: true },
        ]),
      })
    }
    if (base === '/backup/tasks/live-lun') {
      // A FUNCTION route: the detail window stores `res.data` on itself.
      return Promise.resolve({
        data: { task: LIVE_BLOCK_TASK, unit: '', timer: '', recentRuns: [], lastRunNotices: [] },
      })
    }
    if (base === liveIqnPath) {
      return Promise.resolve({ data: iscsiDetail({ session: true }) })
    }
    if (base === groupsPath) {
      // The repository's group list carries the LUN's own group; the group's
      // snapshot listing is the LUN group's (disk.img, exactly the LUN's size).
      if (query && decodeURIComponent(query).includes(`group=${LUN_GROUP}`)) {
        return Promise.resolve(LUN_GROUP_SNAPSHOTS)
      }
      return Promise.resolve({
        data: {
          verdict: 'ok',
          repository: 'pbs-main',
          groups: [
            {
              group: 'host/pictures',
              backupType: 'host',
              backupId: 'pictures',
              backupCount: 3,
              lastBackup: 1787685405,
              lastBackupIso: '2026-08-25T19:16:45Z',
              files: [{ filename: 'data.pxar.didx', archive: 'data.pxar', kind: 'pxar' }],
            },
            {
              group: LUN_GROUP,
              backupType: 'host',
              backupId: `lun-${LUN_SERIAL}`,
              backupCount: 1,
              lastBackup: 1787685405,
              lastBackupIso: '2026-08-25T19:16:45Z',
              files: [{ filename: 'disk.img.fidx', archive: 'disk.img', kind: 'img' }],
            },
          ],
        },
      })
    }
    return baseGet(node, path)
  }

  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  const liveRow = grid.getStore().findExact('name', 'live-lun')
  ok('doors(live session): the grid carries the live-LUN block task', liveRow >= 0, `${liveRow}`)
  if (liveRow < 0) { return }

  const liveDestAsserts = (dlg, label) => {
    eq(`doors(live session, ${label}): the destination defaults to "A new LUN…"`,
      dlg.down('#restoreDest').getValue(), { restoreDest: 'newLun' })
    const inPlace = dlg.down('#restoreDest').childCmps().find(k => k.inputValue === 'inPlace')
    ok(`doors(live session, ${label}): "This LUN (in place)" is DISABLED`, inPlace.disabled === true)
    ok(`doors(live session, ${label}): the live reason speaks under the radio`,
      /under a mounted filesystem/.test(dlg.down('#restoreInPlaceNote').html || ''),
      dlg.down('#restoreInPlaceNote').html)
  }
  const submitNewLun = async (dlg, label, name) => {
    dlg.down('#newLunName').setValue(name)
    dlg.down('#newLunPool').setValue('tank')
    await settle()
    eq(`doors(live session, ${label}): the target combo pre-fills the ANAS-owned target`,
      dlg.down('#newLunTarget').getValue(), ISCSI_IQN)
    jobs.length = 0
    dlg.down('#restoreSubmit').handler(dlg.down('#restoreSubmit'))
    await settle()
    return jobs[0] || null
  }
  const newLunBody = (snapshot, name, ns) => {
    const body = {
      kind: 'image',
      repo: 'pbs-main',
      snapshot,
      archive: 'disk.img',
      target: { mode: 'newLun', targetIqn: ISCSI_IQN, name, backing: { kind: 'zvol', pool: 'tank' } },
    }
    if (ns) { body.ns = ns }
    return body
  }
  // #49: the new-LUN backing pickers start EMPTY and are filled only by
  // ANAS.iscsi.loadBackingChoices — which used to run on the LUN door alone,
  // leaving these stores empty on every other door (where #newLunPool is
  // non-editable, so the new-LUN destination could never be submitted). The
  // stores must be filled on every door that reaches the image half.
  const backingAsserts = async (dlg, label) => {
    await settle()
    const pools = dlg.down('#newLunPool').getStore().getRange().map(r => r.get('name'))
    ok(`doors(live session, ${label}): the new-LUN pool picker is FILLED on this door too`,
      pools.includes('tank') && !pools.includes('pvepool'), JSON.stringify(pools))
    const dirs = dlg.down('#filePicker').getStore().getRange().map(r => `${r.get('name')}@${r.get('source') || ''}`)
    ok(`doors(live session, ${label}): the image picker is FILLED on this door too`,
      dirs.includes('tank/images@dataset') && dirs.includes('ahrpool@ahr'), JSON.stringify(dirs))
  }

  // --- Door 1: the task grid's selection-dependent Restore… ----------------
  grid.selectRow(liveRow)
  ok('doors(live session, grid): Restore… is live for the selected block task',
    grid.down('#backupRestore').disabled === false)
  created.windows.length = 0
  grid.down('#backupRestore').handler(grid.down('#backupRestore'))
  await settle()
  const gridDlg = openWindow()
  ok('doors(live session, grid): the grid door opened the unified dialog',
    gridDlg && gridDlg.cls === 'anas-win-backup-restore')
  if (!gridDlg) { return }
  await pickFileSnapshot(gridDlg)
  eq('doors(live session, grid): the single disk.img archive is pre-selected',
    gridDlg.down('#restoreArchive').getValue(), 'disk.img')
  liveDestAsserts(gridDlg, 'grid')
  await backingAsserts(gridDlg, 'grid')
  const gridJob = await submitNewLun(gridDlg, 'grid', 'grid-live-new')
  eq('doors(live session, grid): the submitted body is the newLun shape',
    gridJob && gridJob.body,
    newLunBody(`${LUN_GROUP}/2026-08-25T19:16:45Z`, 'grid-live-new'))
  ok('doors(live session, grid): a newLun body never carries the in-place lun key',
    !!gridJob && !('lun' in gridJob.body), JSON.stringify((gridJob || {}).body))

  // --- Door 2: the task Details window's Restore… ---------------------------
  created.windows.length = 0
  grid.selectRow(liveRow)
  grid.down('#backupDetails').handler(grid.down('#backupDetails'))
  await settle()
  const detailWin = openWindow()
  ok('doors(live session, detail): the Details window opened',
    detailWin && detailWin.cls === 'anas-win-backup-detail')
  if (!detailWin) { return }
  const detailRestore = detailWin.down('#backupDetailRestore')
  ok('doors(live session, detail): Restore… is live once the detail loaded',
    detailRestore.disabled === false)
  created.windows.length = 0
  detailRestore.handler(detailRestore)
  await settle()
  const detailDlg = openWindow()
  ok('doors(live session, detail): the Details door opened the unified dialog',
    detailDlg && detailDlg.cls === 'anas-win-backup-restore')
  if (!detailDlg) { return }
  await pickFileSnapshot(detailDlg)
  liveDestAsserts(detailDlg, 'detail')
  await backingAsserts(detailDlg, 'detail')
  const detailJob = await submitNewLun(detailDlg, 'detail', 'detail-live-new')
  eq('doors(live session, detail): the submitted body is the newLun shape',
    detailJob && detailJob.body,
    newLunBody(`${LUN_GROUP}/2026-08-25T19:16:45Z`, 'detail-live-new'))
  ok('doors(live session, detail): a newLun body never carries the in-place lun key',
    !!detailJob && !('lun' in detailJob.body), JSON.stringify((detailJob || {}).body))

  // --- Door 3: Restore from repository… (task-less) --------------------------
  created.windows.length = 0
  ANAS.backup.openRestoreDialog('harness', 'harness', {})
  await settle()
  const repoDlg = openWindow()
  ok('doors(live session, repo): the repository door opened the unified dialog',
    repoDlg && repoDlg.cls === 'anas-win-backup-restore')
  if (!repoDlg) { return }
  repoDlg.down('#restoreRepo').setValue('pbs-main')
  await settle()
  const repoGroups = repoDlg.down('#restoreGroup').getStore().getRange().map(r => r.get('group'))
  ok('doors(live session, repo): the repository group list carries the LUN\'s own group',
    repoGroups.includes(LUN_GROUP), JSON.stringify(repoGroups))
  repoDlg.down('#restoreGroup').setValue(LUN_GROUP)
  await settle()
  await pickFileSnapshot(repoDlg)
  eq('doors(live session, repo): the LUN group lists its image archives',
    repoDlg.down('#restoreArchive').getStore().getRange().map(r => r.get('archive')),
    ['disk.img', 'small.img'])
  repoDlg.down('#restoreArchive').setValue('disk.img')
  await settle()
  await backingAsserts(repoDlg, 'repo')
  liveDestAsserts(repoDlg, 'repo')
  const repoJob = await submitNewLun(repoDlg, 'repo', 'repo-live-new')
  eq('doors(live session, repo): the submitted body is the newLun shape',
    repoJob && repoJob.body, newLunBody(LUN_SNAP, 'repo-live-new'))
  ok('doors(live session, repo): a newLun body never carries the in-place lun key',
    !!repoJob && !('lun' in repoJob.body), JSON.stringify((repoJob || {}).body))

  // --- The contrast: the SAME task door, the SAME LUN, NO live session ------
  // "This LUN" is offered and selected, exactly as before the fix-up.
  const ANAS2 = loadRestoreSources()
  created.windows.length = 0
  ANAS2.backup.openRestoreDialog('harness', 'harness', { task: LIVE_BLOCK_TASK })
  await settle()
  const quietDlg = openWindow()
  ok('doors(no session): the task door opened the unified dialog',
    quietDlg && quietDlg.cls === 'anas-win-backup-restore')
  if (!quietDlg) { return }
  await pickFileSnapshot(quietDlg)
  eq('doors(no session): "This LUN (in place)" is selected by default',
    quietDlg.down('#restoreDest').getValue(), { restoreDest: 'inPlace' })
  const quietInPlace = quietDlg.down('#restoreDest').childCmps().find(k => k.inputValue === 'inPlace')
  ok('doors(no session): the in-place radio is ENABLED', quietInPlace.disabled === false)
  ok('doors(no session): the refusal note is empty',
    !(quietDlg.down('#restoreInPlaceNote').html || '').length,
    quietDlg.down('#restoreInPlaceNote').html)

  ok('doors(live session): nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiRestoreDialogChecks() {
  // The LUN door now opens the UNIFIED restore dialog (backup2.6/2.7/2.10): the
  // source collapses to one read-only summary line, and the dialog starts AT
  // the point in time — the LUN selection already said everything else.
  const { dlg } = await openRestoreDialog()
  ok('restore dialog: it opened as the unified restore dialog',
    dlg && dlg.cls === 'anas-win-backup-restore')
  if (!dlg) { return }

  // --- the LUN door's summary line, and what it collapses -------------------
  const summary = dlg.down('#restoreSourceSummary')
  ok('restore: the LUN door shows the read-only summary line',
    summary && (summary.html || '').includes('From LUN'), summary && summary.html)
  ok('restore: it names the LUN itself', /vmdisk1/.test(summary.html || ''), summary && summary.html)
  ok('restore: it names the LUN\'s group (host/lun-<serial>)',
    new RegExp(LUN_GROUP).test(summary.html || ''), summary && summary.html)
  ok('restore: it names the repository the group was found in',
    /pbs-main/.test(summary.html || ''), summary && summary.html)

  // The same fields live behind the summary, but collapsed (hidden AND
  // disabled — a stale source value can never be read back before it is
  // chosen), and the point-in-time is the first interactive field.
  eq('restore: the repository field is collapsed on the LUN door',
    dlg.down('#restoreRepo').disabled, true)
  eq('restore: the namespace field is collapsed too', dlg.down('#restoreNs').disabled, true)
  eq('restore: the group field is collapsed too', dlg.down('#restoreGroup').disabled, true)
  ok('restore: point-in-time is the first interactive field',
    dlg.down('#restoreSnapshot').disabled === false && dlg.down('#restoreSnapPick').disabled === false)
  ok('restore: a "change source…" link expands the fields',
    !!dlg.down('#restoreChangeSource'))
  created.windows.length = 0
  dlg.down('#restoreChangeSource').handler(dlg.down('#restoreChangeSource'))
  await settle()
  eq('restore: change source expands the source part',
    dlg.down('#restoreRepo').disabled, false)
  ok('restore: the summary line hides once expanded',
    dlg.down('#restoreSourceSummary').hidden === true)

  // Both repository tiers are still offered (the collapsed repo combo holds
  // exactly what the task-less door offers).
  const repos = dlg.down('#restoreRepo').getStore().getRange().map(r => r.get('name'))
  eq('restore: both repository tiers are offered', repos, ['pbs-main', 'pve:anastest'])
  ok('restore: a PVE-discovered repository says so',
    /PVE/.test(dlg.down('#restoreRepo').getStore().getAt(1).get('label'))
    || /from Proxmox/.test(dlg.down('#restoreRepo').getStore().getAt(1).get('label')),
    dlg.down('#restoreRepo').getStore().getAt(1).get('label'))
  eq('restore: a repository that carries a namespace pre-fills it',
    dlg.down('#restoreNs').getValue(), 'anas')

  // --- the group resolved, then point in time, then the single `disk` archive
  const groups = dlg.down('#restoreGroup').getStore().getRange().map(r => r.get('group'))
  ok('restore: the LUN\'s own group was pre-selected (lun-<serial> exists)',
    groups.includes(LUN_GROUP) && dlg.down('#restoreGroup').getValue() === LUN_GROUP, JSON.stringify(groups))

  const snapBtn = dlg.down('#restoreSnapPick')
  snapBtn.handler(snapBtn)
  await settle()
  const snapWin = openWindow()
  ok('restore: point-in-time opened the SHARED snapshot picker',
    snapWin && snapWin.cls === 'anas-win-snapshot-picker')
  ok('restore: it lists the LUN\'s own group, never an empty picker',
    snapWin && snapWin.down('#snapGrid').getStore().getCount() >= 1)
  snapWin.down('#snapGrid').selectRow(0)
  const snapSelect = snapWin.buttonCmps.find(b => b.cls === 'anas-btn-snap-select')
  snapSelect.handler(snapSelect)
  await settle()
  eq('restore: every point in time is a FULL <type>/<id>/<RFC3339> id',
    dlg.down('#restoreSnapshot').getValue(), LUN_SNAP)

  // Two images in the LUN group's snapshot → the archive is a real choice; the
  // image half appears once an image archive is picked.
  eq('restore: the archive combo carries the group\'s image archives',
    dlg.down('#restoreArchive').getStore().getRange().map(r => r.get('archive')),
    ['disk.img', 'small.img'])
  ok('restore: the what/where part stays hidden until the archive is picked',
    dlg.down('#restoreFilesWrap').hidden === true && dlg.down('#restoreImageWrap').hidden === true,
    `${dlg.down('#restoreFilesWrap').hidden}/${dlg.down('#restoreImageWrap').hidden}`)
  dlg.down('#restoreArchive').setValue('disk.img')
  await settle()
  ok('restore: choosing the image archive reveals the image half',
    dlg.down('#restoreImageWrap').hidden === false, `${dlg.down('#restoreImageWrap').hidden}`)
  ok('restore: the files half stays hidden for a whole-image restore',
    dlg.down('#restoreFilesWrap').hidden === true)

  ok('restore dialog: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiRestoreVerdictChecks() {
  // backup2.5's reads answer 200 with a VERDICT: a PBS-side problem is a
  // DIAGNOSIS the screen shows verbatim, never a bare failure.
  const routes = {
    ...RESTORE_ROUTES,
    'GET /backup/repos/pbs-main/groups': {
      data: {
        verdict: 'unreachable',
        detail: 'Could not reach the PBS server (the connection was refused).',
        repository: 'pbs-main',
        groups: [],
      },
    },
  }
  const { dlg } = await openRestoreDialog(routes)
  if (!dlg) { return }
  ok('verdict: the PBS-side detail is shown verbatim',
    (dlg.down('#restoreArchiveNote').html || '').includes('connection was refused'),
    dlg.down('#restoreArchiveNote').html)
  eq('verdict: and no group is offered', dlg.down('#restoreGroup').getStore().getCount(), 0)
}

async function iscsiRestoreSizeGateChecks() {
  const { view, dlg } = await openRestoreDialog()
  if (!dlg) { return }
  const submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-restore-submit')

  // Point in time -> the picker -> the LUN's own group's snapshot.
  const snapBtn = dlg.down('#restoreSnapPick')
  snapBtn.handler(snapBtn)
  await settle()
  const snapWin = openWindow()
  snapWin.down('#snapGrid').selectRow(0)
  const snapSelect = snapWin.buttonCmps.find(b => b.cls === 'anas-btn-snap-select')
  snapSelect.handler(snapSelect)
  await settle()

  // Two images in the LUN group's snapshot: a 2 GiB match and a 1 GiB mismatch.
  const archives = dlg.down('#restoreArchive').getStore().getRange().map(r => r.get('archive'))
  eq('size gate: the archive combo carries both images (no auto-preference)', archives, ['disk.img', 'small.img'])

  // --- MISMATCH: a 1 GiB image onto the 2 GiB LUN --------------------------
  dlg.down('#restoreArchive').setValue('small.img')
  await settle()
  ok('size gate: a mismatch DISABLES Restore', submit.disabled === true)
  ok('size gate: and says which way it is wrong',
    /SMALLER/.test(dlg.down('#sizeVerdict').html), dlg.down('#sizeVerdict').html)
  ok('size gate: and names the stale-tail consequence',
    /stale bytes/.test(dlg.down('#sizeVerdict').html), dlg.down('#sizeVerdict').html)
  ok('size gate: both numbers are on screen',
    /1073741824 B/.test(dlg.down('#sizeVerdict').html)
    && /2147483648 B/.test(dlg.down('#sizeVerdict').html),
    dlg.down('#sizeVerdict').html)

  // Pressing it anyway sends NOTHING (the button is dead, and the handler
  // refuses independently — safety is not one check deep).
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('size gate: a mismatch sends NOTHING', jobs.length, 0)
  ok('size gate: and says why', warnings.some(w => /Size mismatch/.test(w)), warnings.join(' | '))
  warnings.length = 0

  // --- MATCH: the 2 GiB image ---------------------------------------------
  dlg.down('#restoreArchive').setValue('disk.img')
  await settle()
  ok('size gate: an exact match ENABLES Restore', submit.disabled === false)
  ok('size gate: and says so',
    /exactly the size of this LUN/.test(dlg.down('#sizeVerdict').html), dlg.down('#sizeVerdict').html)

  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore: one request', jobs.length, 1)
  eq('restore: it POSTs the image-kind restore', [jobs[0].method, jobs[0].path],
    ['post', '/backup/restore'])
  // #48: the in-place half closes the dialog on acceptance, so the poll view
  // must be the LONG-LIVED view the dialog was opened from — keyed to the
  // dialog, ANAS.pollJob dies the moment onSubmitted closes it and the
  // failure alert + the LUNs-window refresh never fire.
  ok('restore(in place): the poll view is the LUNs view, never the dialog being closed',
    jobs[0].view === view && view !== dlg, `view === dlg: ${jobs[0].view === dlg}`)
  eq('restore: the body names the repo, namespace, FULL snapshot, .img archive and the LUN',
    jobs[0].body, {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: LUN_SNAP,
      archive: 'disk.img',
      lun: { targetIqn: ISCSI_IQN, index: 0 },
      ns: 'anas',
    })
  // backup2.10 — the in-place door is byte-identical to backup2.7's: no NEW
  // `target` key appears just because the dialog now has a second door.
  ok('restore: the in-place body carries NO `target` key (byte-identical to backup2.7)',
    jobs.length && !('target' in jobs[0].body), JSON.stringify(jobs[0].body))
  ok('restore: it goes through the danger idiom (409 + confirm code)',
    jobs[0].confirmWindow === true)

  // A blank namespace sends NO key at all — the repository's own then stands.
  jobs.length = 0
  dlg.down('#restoreNs').setValue('')
  submit.handler(submit)
  await settle()
  ok('restore: a blank namespace sends no ns key', !('ns' in jobs[0].body), JSON.stringify(jobs[0].body))

  ok('size gate: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  7b. backup2.10 — restore the image AS A NEW LUN, through the same dialog
// ============================================================================

async function iscsiRestoreNewLunChecks() {
  const { view, dlg } = await openRestoreDialog()
  if (!dlg) { return }
  const submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-restore-submit')

  // Point in time -> picker -> the LUN's group, then the matching image archive
  // (two archives: a choice, not an auto-pick — the block task would have one).
  const snapBtn = dlg.down('#restoreSnapPick')
  snapBtn.handler(snapBtn)
  await settle()
  const snapWin = openWindow()
  snapWin.down('#snapGrid').selectRow(0)
  const snapSelect = snapWin.buttonCmps.find(b => b.cls === 'anas-btn-snap-select')
  snapSelect.handler(snapSelect)
  await settle()
  dlg.down('#restoreArchive').setValue('disk.img')
  await settle()

  // --- the destination radios, and what each carries ----------------------
  eq('restore(newLun): the dialog defaults to "This LUN (in place)"',
    dlg.down('#restoreDest').getValue(), { restoreDest: 'inPlace' })
  {
    // No session → no refusal: the in-place radio is live and carries no
    // reason line (the fix-up's default case).
    const inPlace = dlg.down('#restoreDest').childCmps().find(k => k.inputValue === 'inPlace')
    ok('restore(newLun): with no session the in-place radio is ENABLED',
      inPlace.disabled === false)
    ok('restore(newLun): …and the refusal note is empty',
      !(dlg.down('#restoreInPlaceNote').html || '').length,
      dlg.down('#restoreInPlaceNote').html)
  }
  ok('restore(newLun): the new-LUN form is hidden until its radio is chosen',
    dlg.down('#newLunFields').hidden === true)
  ok('restore(newLun): a hidden form is disabled too — a stale value cannot be read back',
    dlg.down('#newLunFields').disabled === true)

  // --- the new-LUN door -----------------------------------------------------
  dlg.down('#restoreDest').setValue('newLun')
  await settle()
  ok('restore(newLun): choosing the radio reveals the new-LUN form',
    dlg.down('#newLunFields').hidden === false)
  ok('restore(newLun): …and hides the in-place restore-target line',
    dlg.down('#restoreTargetPath').hidden === true)
  ok('restore(newLun): the source LUN is named as staying untouched',
    (dlg.down('#newLunSource').getValue() || '').includes('vmdisk1'),
    dlg.down('#newLunSource').getValue())
  ok('restore(newLun): the note says the source stays online, no offline window, a FRESH serial',
    /stays online/.test(dlg.down('#restoreNote').html || '')
    && /no initiator/.test(dlg.down('#restoreNote').html || '')
    && /FRESH/.test(dlg.down('#restoreNote').html || ''),
    dlg.down('#restoreNote').html)

  // The target combo offers ANAS-owned targets only; the current one is default.
  const targets = dlg.down('#newLunTarget').getStore().getRange().map(r => r.get('value'))
  eq('restore(newLun): only ANAS-owned targets are offered, never a foreign one',
    targets, [ISCSI_IQN])
  eq('restore(newLun): the current target pre-fills', dlg.down('#newLunTarget').getValue(), ISCSI_IQN)

  // The backing lists reuse the add-LUN door's reads: pools for the zvol, and
  // the dataset/AHR list for the image — with the source flag that keeps the
  // `dataset` vs `ahrPool` phrase honest.
  const pools = dlg.down('#newLunPool').getStore().getRange().map(r => r.get('name'))
  ok('restore(newLun): the zvol picker offers ANAS-managed pools', pools.includes('tank'), JSON.stringify(pools))
  ok('restore(newLun): a PVE-managed pool is never a candidate', !pools.includes('pvepool'))
  const dirs = dlg.down('#filePicker').getStore().getRange()
  ok('restore(newLun): the image picker marks a dataset row with its source',
    !!dirs.find(r => r.get('name') === 'tank/images' && r.get('source') === 'dataset'))
  ok('restore(newLun): the image picker marks an AHR pool row with its source',
    !!dirs.find(r => r.get('name') === 'ahrpool' && r.get('source') === 'ahr'))

  // --- validation blocks Save, with the reason ----------------------------
  const blocked = async () => {
    jobs.length = 0
    submit.handler(submit)
    await settle()
    return jobs.length === 0
  }

  dlg.down('#newLunName').setValue('')
  await settle()
  ok('restore(newLun): a missing name blocks Save', await blocked())
  ok('restore(newLun): the reason names the missing name',
    /Enter a LUN name/.test(dlg.down('#newLunVerdict').html), dlg.down('#newLunVerdict').html)

  dlg.down('#newLunName').setValue('vmdisk1')
  await settle()
  ok('restore(newLun): a taken name blocks Save', await blocked())
  ok('restore(newLun): the reason is the daemon\'s own — a name is a node-global SCSI model string',
    /already exists on this node/.test(dlg.down('#newLunVerdict').html), dlg.down('#newLunVerdict').html)

  dlg.down('#newLunName').setValue('vmdisk-new')
  dlg.down('#newLunTarget').setValue('')
  await settle()
  ok('restore(newLun): a missing target blocks Save', await blocked())
  ok('restore(newLun): the reason names the missing target',
    /ANAS-managed target/.test(dlg.down('#newLunVerdict').html), dlg.down('#newLunVerdict').html)
  dlg.down('#newLunTarget').setValue(ISCSI_IQN)
  await settle()

  dlg.down('#newLunPool').setValue('')
  await settle()
  ok('restore(newLun): a missing pool blocks Save', await blocked())
  ok('restore(newLun): the reason names the pool',
    /ZFS pool/.test(dlg.down('#newLunVerdict').html), dlg.down('#newLunVerdict').html)
  dlg.down('#newLunPool').setValue('tank')
  await settle()

  // --- the newLun body, in the shared schema's exact shape ----------------
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(newLun): one request', jobs.length, 1)
  // #48: the newLun half KEEPS the dialog open, but its poll view is the same
  // long-lived reference — and the operator may still close the dialog while
  // the job runs (the result panel guards on that).
  ok('restore(newLun): the poll view is the LUNs view, never the dialog itself',
    jobs[0].view === view && view !== dlg, `view === dlg: ${jobs[0].view === dlg}`)
  eq('restore(newLun): the zvol body is target={mode,targetIqn,name,backing:{kind:zvol,pool}}',
    jobs.length && jobs[0].body, {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: LUN_SNAP,
      archive: 'disk.img',
      target: {
        mode: 'newLun',
        targetIqn: ISCSI_IQN,
        name: 'vmdisk-new',
        backing: { kind: 'zvol', pool: 'tank' },
      },
      ns: 'anas',
    })
  ok('restore(newLun): a newLun body never sends the in-place `lun` key',
    jobs.length && !('lun' in jobs[0].body), JSON.stringify(jobs[0].body))
  ok('restore(newLun): it goes through the danger idiom too (the daemon confirm-gates a create)',
    jobs.length && jobs[0].confirmWindow === true)

  // File backing on a dataset.
  dlg.down('#newLunName').setValue('disk-new-img')
  dlg.down('#newLunKind').setValue({ lunKind: 'file' })
  await settle()
  ok('restore(newLun): the file kind swaps the pool picker for the dataset/AHR picker',
    dlg.down('#newLunPool').hidden === true && dlg.down('#filePicker').hidden === false,
    `${dlg.down('#newLunPool').hidden}/${dlg.down('#filePicker').hidden}`)
  dlg.down('#filePicker').setValue('tank/images')
  await settle()
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(newLun): a file-on-dataset backing is {kind:file, dataset}',
    jobs.length && jobs[0].body.target && jobs[0].body.target.backing,
    { kind: 'file', dataset: 'tank/images' })

  // File backing on an AHR pool.
  dlg.down('#filePicker').setValue('ahrpool')
  await settle()
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(newLun): a file-on-AHR backing is {kind:file, ahrPool}',
    jobs.length && jobs[0].body.target && jobs[0].body.target.backing,
    { kind: 'file', ahrPool: 'ahrpool' })

  // --- a new LUN needs NO size equality — only a KNOWN size ----------------
  // The 1 GiB image is a MISMATCH for the 2 GiB LUN in place (the size gate
  // above). As a new LUN the backing is CREATED at 1 GiB, so it is legal.
  dlg.down('#restoreArchive').setValue('small.img')
  await settle()
  ok('restore(newLun): the verdict speaks of the image size, never "SMALLER"',
    /at exactly the image/.test(dlg.down('#newLunVerdict').html), dlg.down('#newLunVerdict').html)
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(newLun): a 1 GiB image on a 2 GiB LUN is a WHOLE legal new-LUN body',
    jobs.length && jobs[0].body, {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: LUN_SNAP,
      archive: 'small.img',
      target: {
        mode: 'newLun',
        targetIqn: ISCSI_IQN,
        name: 'disk-new-img',
        backing: { kind: 'file', ahrPool: 'ahrpool' },
      },
      ns: 'anas',
    })

  // A blank namespace still sends no ns key in the newLun body.
  dlg.down('#restoreNs').setValue('')
  await settle()
  jobs.length = 0
  submit.handler(submit)
  await settle()
  ok('restore(newLun): a blank namespace sends no ns key in a newLun body',
    jobs.length && !('ns' in jobs[0].body), JSON.stringify(jobs[0].body))

  ok('restore(newLun): nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  7c. backup2.10 — a daemon refusal surfaces VERBATIM, and the result panel
// ============================================================================

async function iscsiRestoreRefusalAndResultChecks() {
  const { ANAS, dlg } = await openRestoreDialog()
  if (!dlg) { return }
  const submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-restore-submit')

  const snapBtn = dlg.down('#restoreSnapPick')
  snapBtn.handler(snapBtn)
  await settle()
  const snapWin = openWindow()
  snapWin.down('#snapGrid').selectRow(0)
  const snapSelect = snapWin.buttonCmps.find(b => b.cls === 'anas-btn-snap-select')
  snapSelect.handler(snapSelect)
  await settle()
  dlg.down('#restoreArchive').setValue('disk.img')
  await settle()
  dlg.down('#restoreDest').setValue('newLun')
  await settle()
  dlg.down('#newLunName').setValue('vmdisk-new')
  dlg.down('#newLunTarget').setValue(ISCSI_IQN)
  dlg.down('#newLunPool').setValue('tank')
  await settle()

  // --- the daemon refuses (409, no confirm code) --------------------------
  const refusal = "A LUN named 'vmdisk-new' already exists on this node. The name is the SCSI model string initiators see, so it has to be unique."
  const recordOnly = cfg => {
    jobs.push({ method: cfg.method, path: cfg.path, body: cfg.body })
    if (cfg.onFailed) { cfg.onFailed({ error: { message: refusal } }) }
  }
  ANAS.confirmAndRun = recordOnly
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(refuse): the request still reached the daemon',
    jobs.length && [jobs[0].method, jobs[0].path], ['post', '/backup/restore'])
  ok('restore(refuse): the daemon\'s refusal is on screen VERBATIM, in the dialog\'s own line',
    (dlg.down('#newLunVerdict').html || '').includes(refusal), dlg.down('#newLunVerdict').html)
  ok('restore(refuse): the dialog is still open to fix the form', dlg.destroyed !== true)

  // --- the restore completes: the new LUN's identity lands in the result panel
  const completed = cfg => {
    jobs.push({ method: cfg.method, path: cfg.path, body: cfg.body })
    if (cfg.onComplete) {
      cfg.onComplete({
        result: {
          newLun: {
            targetIqn: ISCSI_IQN,
            index: 2,
            name: 'vmdisk-new',
            serial: '11111111-2222-3333-4444-555555555555',
            backingPath: '/dev/zvol/tank/vmdisk-new',
          },
        },
      })
    }
  }
  ANAS.confirmAndRun = completed
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(result): the resubmitted request is the same shape',
    jobs.length && jobs[0].body.target && jobs[0].body.target.name, 'vmdisk-new')
  const panel = dlg.down('#restoreResult').html || ''
  ok('restore(result): the result panel names the NEW LUN and its LUN number',
    /vmdisk-new/.test(panel) && /LUN 2/.test(panel), panel)
  ok('restore(result): the result panel shows the target', /iqn\.2026-08\.nas\.anas:vmstore/.test(panel), panel)
  ok('restore(result): the result panel shows the FRESH serial', /11111111-2222-3333-4444-555555555555/.test(panel), panel)
  ok('restore(result): the result panel shows the backing created, and that the source was untouched',
    /\/dev\/zvol\/tank\/vmdisk-new/.test(panel) && /never touched/.test(panel), panel)

  ok('restore(result): nothing warned', warnings.length === 0, warnings.join(' | '))
}
//  5b. The LUN toolbar is backup-aware — "Backed up by" + "Back up…"
//
//  The LUN row offered a restore with no door to the backup. Now the LUNs
//  window reads the task list ONCE (GET /backup/tasks — the list carries the
//  full task with its archives plus lastRunResult/lastRunAt, so no second
//  daemon endpoint exists or is needed):
//    · each LUN is badged with the covering task(s) and their last-run
//      result — coverage = an archive records the LUN's
//      lun { targetIqn, index }, or (a pre-backup2.4 task) is kind 'img' of
//      the LUN's backing path — or reads "not backed up";
//    · "Back up…" offers the covering task's Run / Edit — the Backup menu's
//      OWN doors (ANAS.backup.* in 68-backup.js), asserted on the job and
//      dialog they produce, never a copy — or opens the new-task wizard
//      pre-filled with the LUN's archive, whose body must be BYTE-IDENTICAL
//      to a manual LUN pick in that same wizard;
//    · fail-open: the tasks read failing shows no badge and gates nothing —
//      the wizard door still works, and unknown is not "not backed up".
//
//  Both sources load into ONE sandbox (as on the real page) so the LUN
//  toolbar's doors reach the real ANAS.backup surface.
// ============================================================================

/** The task list this section's node carries. */
const LUN_BACKUP_TASKS = {
  data: [
    {
      // Covers LUN 0 through the lun record (backup2.4) and LUN 1 through the
      // PATH fallback (a pre-backup2.4 img archive, no record at all).
      task: {
        name: 'vmstore-luns',
        repository: 'pbs-main',
        backupId: 'vmstore',
        archives: [
          { name: 'vol1', path: '/dev/zvol/tank/vol1', excludes: [], kind: 'img', lun: { targetIqn: ISCSI_IQN, index: 0 } },
          { name: 'vmdisk2', path: '/tank/images/vmdisk2.raw', excludes: [], kind: 'img' },
          { name: 'etc', path: '/etc', excludes: [] },
        ],
        schedule: 'daily',
        enabled: true,
      },
      lastRunResult: 'success',
      lastRunAt: '2026-08-27T02:00:00Z',
      nextRunAt: null,
      overdue: false,
    },
    {
      // A pxar-only task: covers nothing and must badge no LUN.
      task: {
        name: 'pictures',
        repository: 'pbs-main',
        backupId: 'pictures',
        archives: [{ name: 'pictures', path: '/mnt/pictures', excludes: [] }],
        schedule: 'daily',
        enabled: true,
      },
      lastRunResult: 'failure',
      lastRunAt: '2026-08-26T02:00:00Z',
      nextRunAt: null,
      overdue: false,
    },
    {
      // A record on ANOTHER target: the record is { targetIqn, index }, so the
      // index alone must never match.
      task: {
        name: 'other-lun',
        repository: 'pbs-main',
        backupId: 'other',
        archives: [{ name: 'x', path: '/dev/zvol/other/x', excludes: [], kind: 'img', lun: { targetIqn: ISCSI_FOREIGN, index: 0 } }],
        schedule: 'daily',
        enabled: true,
      },
      lastRunResult: 'success',
      lastRunAt: '2026-08-27T03:00:00Z',
      nextRunAt: null,
      overdue: false,
    },
    {
      // A second cover for LUN 1, through its record — the "several tasks"
      // case on the menu. Its path does NOT match the LUN (the record is the
      // truth); its last run failed, so the two badges show two results.
      task: {
        name: 'repointed',
        repository: 'pbs-main',
        backupId: 'other',
        archives: [{ name: 'vmdisk2-moved', path: '/tank/moved/vmdisk2.raw', excludes: [], kind: 'img', lun: { targetIqn: ISCSI_IQN, index: 1 } }],
        schedule: 'daily',
        enabled: true,
      },
      lastRunResult: 'failure',
      lastRunAt: '2026-08-26T03:00:00Z',
      nextRunAt: null,
      overdue: false,
    },
    {
      // backup2.9 — covers LUN 2 ONLY by the serial in its backup-id: it has
      // no `lun` record, and its path is not the LUN's backing path (the
      // backing moved under the LUN — the GT-40 shape the serial exists for).
      // The only possible match is `lun-<this LUN's unit serial>`, the group
      // the wizard derives for every new block task.
      task: {
        name: 'vol2-block',
        repository: 'pbs-main',
        backupId: 'lun-12121212-3434-5656-7878-9a9a9a9a9a9a',
        kind: 'block',
        archives: [{ name: 'disk', path: '/dev/zvol/elsewhere/vol2', excludes: [], kind: 'img' }],
        schedule: 'daily',
        enabled: true,
      },
      lastRunResult: 'success',
      lastRunAt: '2026-08-27T04:00:00Z',
      nextRunAt: null,
      overdue: false,
    },
  ],
}

/** The section's target: the usual two LUNs, a THIRD covered ONLY by the
 * serial in a backup-id (backup2.9), and a FOURTH, uncovered one — the wizard
 * door's target (the door is for exactly these). */
function lunsDetail(opts = {}) {
  const base = iscsiDetail(opts)
  base.luns.push({
    index: 2,
    name: 'vmdisk 3',
    kind: 'zvol',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/vol2',
    size: 4 * GiB_,
    serial: '12121212-3434-5656-7878-9a9a9a9a9a9a',
    attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 262144 },
    connectedInitiators: [],
    present: true,
    backingExists: true,
    pool: 'tank',
    dataset: 'tank/vol2',
  })
  base.luns.push({
    index: 3,
    name: 'vmdisk 4',
    kind: 'zvol',
    plugin: 'block',
    backingPath: '/dev/zvol/tank/vol3',
    size: 2 * GiB_,
    serial: '34343434-5656-7878-9a9a-1b1b1b1b1b1b',
    attributes: { emulateTpu: true, emulateTpws: true, blockSize: 512, writeBack: false, maxUnmapLbaCount: 524288 },
    connectedInitiators: [],
    present: true,
    backingExists: true,
    pool: 'tank',
    dataset: 'tank/vol3',
  })
  base.lunCount = base.luns.length
  return base
}

/** The wizard's LUN picker, in this section's sandbox: every backup-eligible
 * LUN of the ANAS target — the door's re-resolution (and the fail-open
 * re-resolution) needs its pre-selected LUN in the list, as it always is on
 * the node. */
const LUN_BACKUP_SOURCES = {
  data: {
    installed: true,
    luns: [
      {
        targetIqn: ISCSI_IQN,
        index: 0,
        name: 'vmdisk1',
        kind: 'zvol',
        path: '/dev/zvol/tank/vol1',
        serial: '9bc6e907-6015-4267-be4f-5a0617cb3d71',
        size: 2 * GiB_,
        backingExists: true,
        consistency: {
          consistency: 'snapshot',
          reason: '/dev/zvol/tank/vol1 is the ZFS volume tank/vol1; the run snapshots the volume and reads the snapshot device',
          backend: 'zfs',
          target: 'tank/vol1',
          zvolDevice: '/dev/zvol/tank/vol1',
        },
      },
      {
        targetIqn: ISCSI_IQN,
        index: 1,
        name: 'vmdisk2',
        kind: 'file',
        path: '/tank/images/vmdisk2.raw',
        serial: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        size: GiB_,
        backingExists: true,
      },
      {
        targetIqn: ISCSI_IQN,
        index: 2,
        name: 'vmdisk 3',
        kind: 'zvol',
        path: '/dev/zvol/tank/vol2',
        serial: '12121212-3434-5656-7878-9a9a9a9a9a9a',
        size: 4 * GiB_,
        backingExists: true,
        consistency: {
          consistency: 'snapshot',
          reason: '/dev/zvol/tank/vol2 is the ZFS volume tank/vol2; the run snapshots the volume and reads the snapshot device',
          backend: 'zfs',
          target: 'tank/vol2',
          zvolDevice: '/dev/zvol/tank/vol2',
        },
      },
      {
        targetIqn: ISCSI_IQN,
        index: 3,
        name: 'vmdisk 4',
        kind: 'zvol',
        path: '/dev/zvol/tank/vol3',
        serial: '34343434-5656-7878-9a9a-1b1b1b1b1b1b',
        size: 2 * GiB_,
        backingExists: true,
        consistency: {
          consistency: 'snapshot',
          reason: '/dev/zvol/tank/vol3 is the ZFS volume tank/vol3; the run snapshots the volume and reads the snapshot device',
          backend: 'zfs',
          target: 'tank/vol3',
          zvolDevice: '/dev/zvol/tank/vol3',
        },
      },
    ],
  },
}

const LUN_BACKUP_ROUTES = {
  ...ISCSI_ROUTES,
  [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: lunsDetail() },
  'GET /backup/tasks': LUN_BACKUP_TASKS,
  'GET /backup/repos': { data: { version: 1, repos: [{ name: 'pbs-main', datastore: 'store1', source: 'anas' }] } },
  'GET /backup/lun-sources': LUN_BACKUP_SOURCES,
  'POST /backup/tasks/preview-nested': nestedPreviewRoute,
  'GET /fs/browse': path => ({ data: { exists: true, path: path } }),
}

/** Both sources into one sandbox, then the iSCSI view — as on the real page. */
async function openLunBackupView(routes) {
  const ANAS = loadSources(['68-backup.js', '75-iscsi.js'], routes)
  const view = makeComponent(ANAS.views.iscsi.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  return { ANAS, view, grid: view.down('#iscsiGrid') }
}

/**
 * Select the picker row for a LUN NUMBER. The list holds every eligible LUN,
 * so the row position is not the LUN number — the number is the address.
 */
function lunPickerSelect(picker, idx) {
  const grid = picker.down('#lunGrid')
  const pos = grid.getStore().getRange().findIndex(r => r.get('index') === idx)
  if (pos >= 0) { grid.selectRow(pos) }
  return pos
}

async function lunBackupBadgeChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { grid } = await openLunBackupView(LUN_BACKUP_ROUTES)
  const lunsWin = await openLuns(grid, LUN_BACKUP_ROUTES)
  ok('lunbackup: the window opened with four LUNs', !!lunsWin && lunsWin.down('#lunsGrid').getStore().getCount() === 4)
  if (!lunsWin) { return }
  const lunsGrid = lunsWin.down('#lunsGrid')
  await settle()

  const byCol = (lunsGrid.columns || []).find(c => c.dataIndex === 'backupBy')
  ok('lunbackup: the grid has a "Backed up by" column', !!byCol)
  const r0 = lunsGrid.getStore().getAt(0)
  const r1 = lunsGrid.getStore().getAt(1)
  const r2 = lunsGrid.getStore().getAt(2)
  const r3 = lunsGrid.getStore().getAt(3)

  eq('lunbackup: LUN 0 is covered by the task whose archive records it',
    r0.get('backupBy'),
    [{ name: 'vmstore-luns', lastRunResult: 'success', lastRunAt: '2026-08-27T02:00:00Z' }])
  eq('lunbackup: LUN 1 is covered by TWO tasks — a record and the path fallback',
    r1.get('backupBy'),
    [
      { name: 'vmstore-luns', lastRunResult: 'success', lastRunAt: '2026-08-27T02:00:00Z' },
      { name: 'repointed', lastRunResult: 'failure', lastRunAt: '2026-08-26T03:00:00Z' },
    ])
  eq('lunbackup: LUN 2 is covered ONLY by the serial in the task\'s backup-id (no record, no path match)',
    r2.get('backupBy'),
    [{ name: 'vol2-block', lastRunResult: 'success', lastRunAt: '2026-08-27T04:00:00Z' }])
  eq('lunbackup: an uncovered LUN is an EMPTY list — "known and none", not unknown',
    r3.get('backupBy'), [])

  const cell0 = byCol.renderer(r0.get('backupBy'), {}, r0)
  ok('lunbackup: the covered cell names the task and its last result',
    /vmstore-luns/.test(cell0) && /success/.test(cell0), cell0)
  ok('lunbackup: a pxar-only task never badges a LUN', !/pictures/.test(cell0), cell0)
  ok('lunbackup: a serial on ANOTHER LUN never matches (the id is the LUN\'s own)',
    !/vol2-block/.test(cell0), cell0)
  const cell1 = byCol.renderer(r1.get('backupBy'), {}, r1)
  ok('lunbackup: both covering tasks are named, each with its OWN result',
    /vmstore-luns/.test(cell1) && /repointed/.test(cell1) && /failure/.test(cell1), cell1)
  ok('lunbackup: a record on another target never matches on index alone',
    !/other-lun/.test(cell1), cell1)
  const cell2 = byCol.renderer(r2.get('backupBy'), {}, r2)
  ok('lunbackup: the serial-matched cell names the task and its last result',
    /vol2-block/.test(cell2) && /success/.test(cell2), cell2)
  ok('lunbackup: an uncovered LUN reads "not backed up"',
    /not backed up/.test(byCol.renderer(r3.get('backupBy'), {}, r3)))
  ok('lunbackup: a failed read renders NOTHING — unknown is not "not backed up"',
    byCol.renderer(undefined, {}, r3) === '' && byCol.renderer(null, {}, r3) === '')

  ok('lunbackup: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function lunBackupMenuChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { ANAS, view, grid } = await openLunBackupView(LUN_BACKUP_ROUTES)
  const lunsWin = await openLuns(grid, LUN_BACKUP_ROUTES)
  const lunsGrid = lunsWin.down('#lunsGrid')
  await settle()
  const btn = lunsGrid.down('#lunBackup')
  ok('lunbackup: the button exists and needs a selection', !!btn && btn.disabled === true)
  if (!lunsWin) { return }

  // --- LUN 0: covered by exactly one task — Run + Edit for THAT task ------
  lunsGrid.selectRow(0)
  ok('lunbackup: live on a covered LUN', btn.disabled === false)
  let items = (btn.menu && btn.menu.items) || []
  eq('lunbackup: a covered LUN offers exactly Run/Edit for its task',
    items.map(i => i.text), ['Run task vmstore-luns now', 'Edit task vmstore-luns…'])

  // Run — the Backup menu's OWN run path, asserted on the job it files.
  jobs.length = 0
  items[0].handler()
  await settle()
  eq('lunbackup: Run files the task\'s own /run job — the existing run path',
    jobs.length === 1 ? [jobs[0].method, jobs[0].path, jobs[0].body] : null,
    ['post', '/backup/tasks/vmstore-luns/run', {}])

  // Edit — the Backup menu's OWN edit dialog, prefilled from the entry.
  created.windows.length = 0
  items[1].handler()
  await settle()
  const editDlg = openWindow()
  ok('lunbackup: Edit opens the EXISTING edit dialog',
    !!editDlg && /Edit Backup Task/.test(editDlg.title || ''), editDlg && editDlg.title)
  eq('lunbackup: …on the covering task, prefilled from its entry',
    editDlg && editDlg.down('#name') ? editDlg.down('#name').getValue() : null, 'vmstore-luns')
  ok('lunbackup: the task\'s archives prefill as rows',
    !!editDlg && archiveRows(editDlg).length === 3,
    editDlg && `${archiveRows(editDlg).length}`)

  // --- LUN 1: covered by two tasks — the same two actions, per task -------
  lunsGrid.selectRow(1)
  items = (btn.menu && btn.menu.items) || []
  eq('lunbackup: several covering tasks get the same two actions each',
    items.map(i => i.text),
    ['Run task vmstore-luns now', 'Edit task vmstore-luns…', 'Run task repointed now', 'Edit task repointed…'])

  // --- LUN 3: uncovered — the wizard door, and body identity ---------------
  lunsGrid.selectRow(3)
  ok('lunbackup: live on an uncovered LUN — the door is for exactly these',
    btn.disabled === false)
  items = (btn.menu && btn.menu.items) || []
  eq('lunbackup: an uncovered LUN offers the wizard door',
    items.map(i => i.text), ['Create backup task…'])

  const LUN3 = { serial: '34343434-5656-7878-9a9a-1b1b1b1b1b1b', path: '/dev/zvol/tank/vol3' }

  // Flow A — a MANUAL block pick in the plain New Task wizard: the kind is
  // chosen, then the LUN through the block panel's own picker.
  created.windows.length = 0
  jobs.length = 0
  ANAS.backup.openNewTask(view, 'harness', null)
  await settle()
  let wiz = openWindow()
  ok('lunbackup: the plain door opens the NEW-task wizard',
    !!wiz && /New Backup Task/.test(wiz.title || ''), wiz && wiz.title)
  wiz.down('#kindGroup').setValue('block')
  await settle()
  ok('lunbackup: the plain door SHOWS the kind choice (skipping it is the door\'s)',
    wiz.down('#kindGroup').hidden === false && wiz.down('#blockPanel').hidden === false)
  findCmp(wiz, 'anas-btn-backup-block-lun').handler()
  await settle()
  const picker = openWindow()
  ok('lunbackup: the manual door is the wizard\'s own LUN picker',
    !!picker && /iSCSI LUN/.test(picker.title || ''), picker && picker.title)
  eq('lunbackup: the picker listed every eligible LUN of the target',
    picker.down('#lunGrid').getStore().getCount(), 4)
  eq('lunbackup: …and the door\'s LUN is selectable', lunPickerSelect(picker, 3), 3)
  picker.buttonCmps.find(b => b.cls === 'anas-btn-backup-lun-select').handler()
  await settle()
  eq('lunbackup: the pick derives the backup-id from the serial (shared lunBackupId)',
    wiz.down('#backupId').getValue(), lunBackupId(LUN3.serial))
  ok('lunbackup: …and locks it (the group IS the LUN)', wiz.down('#backupId').readOnly === true)
  wiz.down('#name').setValue('lun3-manual')
  wiz.down('#schedule').setValue('daily')
  wiz.down('#taskSubmitBtn').handler(wiz.down('#taskSubmitBtn'))
  await settle()
  eq('lunbackup: the manual wizard POSTs its block task',
    jobs.length === 1 ? [jobs[0].method, jobs[0].path] : null, ['post', '/backup/tasks'])
  const manualBody = jobs.length ? jobs[0].body : null
  eq('lunbackup: the manual block pick carries the single disk archive',
    manualBody && manualBody.archives, [{
      name: BLOCK_ARCHIVE_NAME,
      path: LUN3.path,
      excludes: [],
      kind: 'img',
      lun: { targetIqn: ISCSI_IQN, index: 3 },
    }])

  // Flow B — the LUN toolbar's door: the SAME wizard, the choice skipped and
  // the LUN pre-selected.
  created.windows.length = 0
  jobs.length = 0
  lunsGrid.selectRow(3) // the menu is rebuilt on selection
  items = (btn.menu && btn.menu.items) || []
  items[0].handler()
  await settle()
  wiz = openWindow()
  ok('lunbackup: the door opens the NEW-task wizard',
    !!wiz && /New Backup Task/.test(wiz.title || ''), wiz && wiz.title)
  ok('lunbackup: the door SKIPS the kind choice (the toolbar already said block)',
    wiz.down('#kindGroup').hidden === true)
  ok('lunbackup: …and opens on the block panel, the files panel off',
    wiz.down('#blockPanel').hidden === false && wiz.down('#filesPanel').hidden === true)
  const doorHtml = wiz.down('#blockLunOut').html || ''
  ok('lunbackup: the LUN is pre-selected, re-resolved against the node\'s list',
    doorHtml.includes('vmdisk 4') && doorHtml.includes(ISCSI_IQN)
    && doorHtml.includes('LUN 3') && doorHtml.includes(LUN3.path), doorHtml)
  eq('lunbackup: …and the id derives from its serial (shared lunBackupId)',
    [wiz.down('#backupId').getValue(), wiz.down('#backupId').readOnly],
    [lunBackupId(LUN3.serial), true])
  eq('lunbackup: the archive name is the fixed block name (shared BLOCK_ARCHIVE_NAME)',
    wiz.down('#blockArchiveName').getValue(), BLOCK_ARCHIVE_NAME)
  wiz.down('#name').setValue('lun3-prefilled')
  wiz.down('#schedule').setValue('daily')
  wiz.down('#taskSubmitBtn').handler(wiz.down('#taskSubmitBtn'))
  await settle()
  ok('lunbackup: the pre-filled wizard POSTs one task', jobs.length === 1
    && jobs[0].method === 'post' && jobs[0].path === '/backup/tasks',
    JSON.stringify(jobs[0] && [jobs[0].method, jobs[0].path]))

  // The point of the door: the pre-filled body is BYTE-IDENTICAL to the
  // manual block pick's — same code path, one archive. Only the name the
  // harness types differs.
  eq('lunbackup: the pre-filled body is deep-equal to the manual block pick',
    jobs.length ? jobs[0].body : null,
    manualBody ? { ...manualBody, name: 'lun3-prefilled' } : null)

  ok('lunbackup: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function lunBackupFailOpenChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  // The tasks read FAILS: no badge, nothing gated, the door still works — and
  // the failure is silent (a badge is display, not safety).
  const routes = { ...LUN_BACKUP_ROUTES }
  delete routes['GET /backup/tasks']
  const { grid } = await openLunBackupView(routes)
  const lunsWin = await openLuns(grid, routes)
  const lunsGrid = lunsWin.down('#lunsGrid')
  await settle()

  ok('lunbackup(fail-open): a failed read leaves no badge',
    lunsGrid.getStore().getAt(0).get('backupBy') === undefined)
  const btn = lunsGrid.down('#lunBackup')
  lunsGrid.selectRow(0)
  ok('lunbackup(fail-open): the button is still LIVE — coverage does not gate it',
    btn.disabled === false)
  const items = (btn.menu && btn.menu.items) || []
  eq('lunbackup(fail-open): unknown coverage still offers the wizard door',
    items.map(i => i.text), ['Create backup task…'])
  created.windows.length = 0
  jobs.length = 0
  items[0].handler()
  await settle()
  const wiz = openWindow()
  ok('lunbackup(fail-open): the wizard opens on the BLOCK panel — the door is unchanged',
    !!wiz && wiz.down('#blockPanel').hidden === false && wiz.down('#kindGroup').hidden === true)
  const foHtml = wiz && (wiz.down('#blockLunOut').html || '')
  ok('lunbackup(fail-open): …with the LUN re-resolved from its record (live name on screen)',
    !!wiz && foHtml.includes(ISCSI_IQN) && foHtml.includes('vmdisk1') && foHtml.includes('LUN 0'), foHtml)
  eq('lunbackup(fail-open): …and the id derives from its serial (shared lunBackupId)',
    wiz && wiz.down('#backupId').getValue(), lunBackupId('9bc6e907-6015-4267-be4f-5a0617cb3d71'))

  ok('lunbackup(fail-open): nothing warned — fail-open is silent',
    warnings.length === 0, warnings.join(' | '))
}

async function lunBackupGatingChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  // A FOREIGN target: hands-off — the backup door is no exception.
  const foreignRoutes = {
    ...LUN_BACKUP_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_FOREIGN)}`]: {
      data: {
        ...ISCSI_TARGETS.targets[1],
        luns: [{
          index: 0, name: 'xvol', kind: 'foreign', plugin: 'fileio',
          backingPath: '/unknown/x', size: GiB_, serial: 'ffffffff-0000-0000-0000-000000000000',
          attributes: {}, connectedInitiators: [], present: true, backingExists: true,
        }],
        acls: [], sessions: [],
      },
    },
  }
  const { grid } = await openLunBackupView(foreignRoutes)
  grid.selectRow(iscsiRowOf(grid, ISCSI_FOREIGN))
  grid.down('#iscsiLuns').handler(grid.down('#iscsiLuns'))
  await settle()
  const fWin = openWindow()
  const fGrid = fWin.down('#lunsGrid')
  await settle()
  fGrid.selectRow(0)
  const fBtn = fGrid.down('#lunBackup')
  ok('lunbackup(foreign): DISABLED on a foreign target', fBtn.disabled === true)
  ok('lunbackup(foreign): and says the target is hands-off',
    /not managed by ANAS/.test(fBtn.tooltip || ''), fBtn.tooltip)

  // An ABSENT backing: there is nothing on this node to read.
  const missing = lunsDetail()
  missing.luns[2] = { ...missing.luns[2], backingExists: false }
  const missingRoutes = {
    ...LUN_BACKUP_ROUTES,
    [`GET /iscsi/targets/${encodeURIComponent(ISCSI_IQN)}`]: { data: missing },
  }
  const { grid: g2 } = await openLunBackupView(missingRoutes)
  const mWin = await openLuns(g2, missingRoutes)
  const mGrid = mWin.down('#lunsGrid')
  await settle()
  mGrid.selectRow(2)
  const mBtn = mGrid.down('#lunBackup')
  ok('lunbackup(absent): DISABLED when the backing is not on this node',
    mBtn.disabled === true)
  ok('lunbackup(absent): and points at Repair, the way the restore door does',
    /Repair/.test(mBtn.tooltip || ''), mBtn.tooltip)

  ok('lunbackup gating: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function addLunGrowthNoteChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { grid } = await openLunBackupView(LUN_BACKUP_ROUTES)
  const lunsWin = await openLuns(grid, LUN_BACKUP_ROUTES)
  const lunsGrid = lunsWin.down('#lunsGrid')
  lunsGrid.down('#lunAdd').handler(lunsGrid.down('#lunAdd'))
  await settle()
  const dlg = openWindow()
  const note = dlg && dlg.down('#lunKindNote')
  ok('addlun: the growth note sits under the Kind choice', !!note)
  const html = note ? note.html : ''
  ok('addlun: it says a volume grows live, even under a connected initiator',
    /Volumes \(zvol\) grow live, even while an initiator is connected/.test(html), html)
  ok('addlun: …and that an image-file grow is a refused backstore recreate',
    /recreates its backstore, which is refused while any initiator is logged in to the target/
      .test(html), html)
  ok('addlun: …and names the Proxmox consequence',
    /with Proxmox storage that means disabling the storage first/.test(html), html)
  ok('addlun: it gives the rule of thumb',
    /Choose a volume for anything you expect to grow; an image file for AHR pools or for things sized once/
      .test(html), html)
  ok('addlun: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiAddressFallbackChecks() {
  // PVE's network API is unreadable: the picker must degrade to a free-text
  // field rather than leaving the operator with no way to enter an address.
  ajax.responses = {}
  const { grid } = await openIscsiView(ISCSI_ROUTES)
  const btn = grid.down('#iscsiCreate')
  btn.handler(btn)
  await settle()
  const dlg = openWindow()
  const picker = dlg.down('#portalAddress')
  ok('addresses: a failed network read still leaves an editable field',
    !!picker && picker.editable === true)
  jobs.length = 0
  dlg.down('#name').setValue('vmstore9')
  picker.setValue('10.1.2.3')
  // A zero-ACL create is now gated; list this node itself so the check can get
  // on with testing the address, not the gate.
  const nodeBtn = dlg.down('#aclAddNode')
  nodeBtn.handler(nodeBtn)
  await settle()
  const submit = dlg.buttonCmps.find(b => b.cls === 'anas-btn-iscsi-target-submit')
  submit.handler(submit)
  await settle()
  eq('addresses: a hand-typed address still submits',
    jobs[0].body.portals, [{ address: '10.1.2.3', port: 3260 }])
  ok('addresses: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  5. backup2.5 — the shared path picker (12-picker.js), both backends
//
//  What this guards:
//    · the wizard's archive-path body is BYTE-IDENTICAL whether the path was
//      typed or picked — the picker is a convenience, never a second contract
//    · the tree lazy-loads: expanding a node asks the right endpoint for THAT
//      node's path, not the root's
//    · breadcrumb navigation and type-ahead jump/filter
//    · multi-select set semantics (de-duplicated, order preserved)
//    · the archive backend carries the snapshot context on every call
//    · a hardlink group is ONE selection — its primary comes along (GT-25)
// ============================================================================

/** The live filesystem the picker walks in these checks. */
const LIVE_TREE = {
  '/': { dirs: ['etc', 'mnt', 'srv'], files: ['swap.img'] },
  '/mnt': { dirs: ['pictures', 'photos-old'], files: [] },
  '/mnt/pictures': { dirs: ['2024', '2025'], files: ['cover.raw'] },
}

function liveRoute(path, wantFiles) {
  const level = LIVE_TREE[path]
  if (!level) {
    return { data: { path, exists: false, type: 'missing', dirs: [] } }
  }
  // The daemon sends `files` ONLY when `files=1` was asked for — absent is
  // "not requested", never "none there".
  const data = { path, exists: true, type: 'dir', dirs: level.dirs.slice() }
  if (wantFiles) { data.files = level.files.slice() }
  return { data }
}

/** One directory level inside a pxar archive, in the daemon's own shape. */
const ARCHIVE_TREE = {
  '/': {
    verdict: 'ok',
    archiveKind: 'pxar',
    path: '/',
    entries: [
      { name: 'docs', path: '/docs', type: 'dir' },
      // F11 — the daemon marks every archive mtime as the NODE's local time:
      // `catalog shell` renders `Modify:` in the READING process's timezone and
      // prints no offset at all, so a UI that assumed UTC was wrong by it.
      { name: 'alpha.txt', path: '/alpha.txt', type: 'file', size: 23, modified: '2026-08-25 19:16:23', mtimeZone: 'node-local' },
      { name: 'hard-a.txt', path: '/hard-a.txt', type: 'file', size: 17, modified: '2026-08-25 19:16:23', mtimeZone: 'node-local' },
      { name: 'hard-b.txt', path: '/hard-b.txt', type: 'hardlink', target: 'hard-a.txt' },
      { name: 'link-to-alpha', path: '/link-to-alpha', type: 'symlink', target: 'alpha.txt' },
    ],
    warnings: [],
  },
  '/docs': {
    verdict: 'ok',
    archiveKind: 'pxar',
    path: '/docs',
    entries: [
      { name: 'notes.txt', path: '/docs/notes.txt', type: 'file', size: 9 },
      { name: 'readme.md', path: '/docs/readme.md', type: 'file', size: 10 },
    ],
    warnings: [],
  },
}

/** Every browse request the picker made, in order. */
const browseCalls = []

const PICKER_ROUTES = {
  ...BACKUP_ROUTES,
  'GET /fs/browse': null, // replaced below by a function-aware get
  'POST /backup/restore/browse': (body) => {
    browseCalls.push(body)
    const level = ARCHIVE_TREE[body.path]
    if (!level) {
      return { data: { verdict: 'not-found', detail: `'${body.path}' is not in this archive.`, entries: [], warnings: [] } }
    }
    return { data: level }
  },
  'GET /backup/tasks/nightly-pictures/snapshots': {
    data: {
      verdict: 'ok',
      repository: 'pbs-main',
      namespace: 'anas/pictures',
      group: 'host/pictures',
      snapshots: [
        {
          snapshot: 'host/pictures/2026-08-25T19:16:45Z',
          backupType: 'host',
          backupId: 'pictures',
          backupTime: 1787685405,
          backupTimeIso: '2026-08-25T19:16:45Z',
          size: 3309,
          files: [
            { filename: 'data.pxar.didx', archive: 'data.pxar', kind: 'pxar', size: 2607 },
            { filename: 'catalog.pcat1.didx', kind: 'other', size: 327 },
            { filename: 'index.json.blob', kind: 'other', size: 375 },
          ],
        },
        {
          snapshot: 'host/pictures/2026-08-24T19:16:45Z',
          backupType: 'host',
          backupId: 'pictures',
          backupTime: 1787599005,
          backupTimeIso: '2026-08-24T19:16:45Z',
          files: [{ filename: 'lun.img.fidx', archive: 'lun.img', kind: 'img', size: 536870912 }],
        },
      ],
    },
  },
}

/**
 * The picker's own ANAS sandbox. `GET /fs/browse` needs the QUERY (the path and
 * the files flag), which the shared route table keys away — so this wraps
 * `loadSource`'s ANAS with a get that records the full URL.
 */
const liveCalls = []
function loadPickerSources(files) {
  const ANAS = loadSource(files, PICKER_ROUTES)
  ANAS.api.get = (_node, path) => {
    const [base, query] = path.split('?')
    if (base === '/fs/browse') {
      liveCalls.push(path)
      const params = new URLSearchParams(query || '')
      return Promise.resolve(liveRoute(params.get('path') || '/', params.get('files') === '1'))
    }
    const key = `GET ${base}`
    return key in PICKER_ROUTES && PICKER_ROUTES[key]
      ? Promise.resolve(PICKER_ROUTES[key])
      : Promise.reject(new Error(`unexpected GET ${base}`))
  }
  return ANAS
}

async function pickerChecks() {
  browseCalls.length = 0
  liveCalls.length = 0
  const ANAS = loadPickerSources(['12-picker.js'])
  const P = ANAS.picker

  // --- pure path helpers ---------------------------------------------------
  eq('picker: normalize collapses slashes and drops the trailing one', P.normalizePath('//mnt//pictures/'), '/mnt/pictures')
  eq('picker: the root normalizes to itself', P.normalizePath('/'), '/')
  eq('picker: parent of the root is the root', P.parentDir('/'), '/')
  eq('picker: parent of a top-level dir is the root', P.parentDir('/etc'), '/')
  eq('picker: parent of a nested dir', P.parentDir('/mnt/pictures/2025'), '/mnt/pictures')
  eq('picker: join does not double the root slash', P.joinPath('/', 'etc'), '/etc')
  eq('picker: join a nested child', P.joinPath('/mnt', 'pictures'), '/mnt/pictures')
  eq('picker: basename of a path', P.baseName('/mnt/pictures'), 'pictures')

  // --- breadcrumbs ---------------------------------------------------------
  eq('picker: the root breadcrumb is one segment', P.crumbs('/'), [{ label: '/', path: '/' }])
  eq('picker: a nested breadcrumb walks the whole path', P.crumbs('/mnt/pictures/2025'), [
    { label: '/', path: '/' },
    { label: 'mnt', path: '/mnt' },
    { label: 'pictures', path: '/mnt/pictures' },
    { label: '2025', path: '/mnt/pictures/2025' },
  ])
  // Ids are never truncated — a long segment is carried whole.
  const longSeg = 'a-very-long-directory-name-that-a-picker-must-not-shorten'
  ok('picker: a long segment is never truncated',
    P.crumbs(`/mnt/${longSeg}`).some(c => c.label === longSeg))

  // --- what may be selected ------------------------------------------------
  ok('picker: dir mode selects a directory', P.isSelectable('dir', 'dir') === true)
  ok('picker: dir mode refuses a file', P.isSelectable('file', 'dir') === false)
  ok('picker: file mode refuses a directory', P.isSelectable('dir', 'file') === false)
  ok('picker: any mode takes both', P.isSelectable('dir', 'any') && P.isSelectable('file', 'any'))
  ok('picker: a hardlink is selectable in file mode', P.isSelectable('hardlink', 'file') === true)
  ok('picker: the whole-image pseudo-entry is selectable', P.isSelectable('image', 'any') === true)
  ok('picker: an unknown entry kind is never selectable', P.isSelectable('other', 'any') === false)

  // --- hardlink groups are ONE selection (GT-25) ---------------------------
  eq('picker: a plain file selects only itself',
    P.selectionFor({ path: '/alpha.txt', type: 'file' }), ['/alpha.txt'])
  eq('picker: a symlink selects only itself (its target is not restored with it)',
    P.selectionFor({ path: '/link-to-alpha', type: 'symlink', target: 'alpha.txt' }), ['/link-to-alpha'])
  eq('picker: a hardlink brings its group primary along',
    P.selectionFor({ path: '/hard-b.txt', type: 'hardlink', target: 'hard-a.txt' }),
    ['/hard-b.txt', '/hard-a.txt'])
  eq('picker: a hardlink in a subdirectory resolves its primary as a sibling',
    P.selectionFor({ path: '/docs/hard-b.txt', type: 'hardlink', target: 'hard-a.txt' }),
    ['/docs/hard-b.txt', '/docs/hard-a.txt'])
  eq('picker: an archive-absolute hardlink target is taken as given',
    P.selectionFor({ path: '/docs/hard-b.txt', type: 'hardlink', target: '/hard-a.txt' }),
    ['/docs/hard-b.txt', '/hard-a.txt'])

  // --- multi-select set semantics -----------------------------------------
  eq('picker: a selection set is de-duplicated, order preserved',
    P.selectionPaths([
      { path: '/hard-b.txt', type: 'hardlink', target: 'hard-a.txt' },
      { path: '/hard-a.txt', type: 'file' },
      { path: '/alpha.txt', type: 'file' },
    ]),
    ['/hard-b.txt', '/hard-a.txt', '/alpha.txt'])
  eq('picker: an empty set is an empty list', P.selectionPaths([]), [])

  // --- the request each backend builds ------------------------------------
  eq('picker: a directory picker never asks for the file listing',
    P.liveBrowseUrl('/mnt/pictures', false), '/fs/browse?path=%2Fmnt%2Fpictures')
  eq('picker: a file picker opts IN to files',
    P.liveBrowseUrl('/mnt/pictures', true), '/fs/browse?path=%2Fmnt%2Fpictures&files=1')
  eq('picker: the archive body carries the whole snapshot context',
    P.archiveBrowseBody({ repo: 'pbs-main', ns: 'anas/pictures', snapshot: 'host/pictures/2026-08-25T19:16:45Z', archive: 'data.pxar' }, '/docs'),
    { repo: 'pbs-main', snapshot: 'host/pictures/2026-08-25T19:16:45Z', archive: 'data.pxar', path: '/docs', ns: 'anas/pictures' })
  ok('picker: an absent namespace sends NO ns key (absent means the repo’s own)',
    !('ns' in P.archiveBrowseBody({ repo: 'r', snapshot: 's', archive: 'a.pxar' }, '/')))

  // --- entry normalization -------------------------------------------------
  const liveRows = P.entriesFromLive(liveRoute('/mnt/pictures', true).data, '/mnt/pictures', 'any')
  eq('picker: the live backend lists directories first, then files',
    liveRows.map(r => r.name), ['2024', '2025', 'cover.raw'])
  eq('picker: a live child path is joined onto its parent', liveRows[0].path, '/mnt/pictures/2024')
  ok('picker: only directories expand', liveRows[0].expandable === true && liveRows[2].expandable === false)
  const dirOnly = P.entriesFromLive({ path: '/mnt', dirs: ['pictures'] }, '/mnt', 'dir')
  eq('picker: an absent files key lists no files at all', dirOnly.map(r => r.name), ['pictures'])
  const volunteered = P.entriesFromLive({ path: '/mnt', dirs: ['pictures'], files: ['stray.img'] }, '/mnt', 'dir')
  eq('picker: a directory picker hides a file even if the daemon volunteers one',
    volunteered.map(r => r.name), ['pictures'])

  const archRows = P.entriesFromArchive(ARCHIVE_TREE['/'], '/', 'any')
  eq('picker: the archive backend keeps the daemon’s order (folders first)',
    archRows.map(r => r.name), ['docs', 'alpha.txt', 'hard-a.txt', 'hard-b.txt', 'link-to-alpha'])
  eq('picker: a hardlink row carries its group primary', archRows[3].target, 'hard-a.txt')
  eq('picker: sizes and mtimes are carried through verbatim',
    [archRows[1].size, archRows[1].modified], [23, '2026-08-25 19:16:23'])
  // F11 — the row carries the daemon's marker so the column can LABEL the time
  // instead of a reader assuming UTC. Nothing is converted.
  eq('picker: an archive mtime is marked as the node’s local time', archRows[1].mtimeZone, 'node-local')
  eq('picker: a row with no mtime carries no marker either', archRows[0].mtimeZone, undefined)

  // --- the archive backend surfaces a verdict as a failure ----------------
  const archBackend = P.makeBackend({
    node: 'harness',
    backend: 'archive',
    mode: 'any',
    archive: { repo: 'pbs-main', ns: 'anas/pictures', snapshot: 'host/pictures/2026-08-25T19:16:45Z', archive: 'data.pxar' },
  })
  const level = await archBackend.load('/docs')
  eq('picker: the archive backend asked for THAT path',
    browseCalls[browseCalls.length - 1].path, '/docs')
  eq('picker: the archive backend carried the snapshot on the call',
    browseCalls[browseCalls.length - 1].snapshot, 'host/pictures/2026-08-25T19:16:45Z')
  eq('picker: the level came back as rows', level.rows.map(r => r.name), ['notes.txt', 'readme.md'])
  let rejected = null
  await archBackend.load('/nosuch').then(() => {}, (e) => { rejected = e })
  ok('picker: a non-ok verdict rejects with the daemon’s own detail',
    rejected && /is not in this archive/.test(rejected.message), String(rejected))
  eq('picker: the rejection carries the verdict', rejected && rejected.verdict, 'not-found')

  // --- the tree: lazy load, breadcrumb, type-ahead ------------------------
  liveCalls.length = 0
  let picked = null
  const win = ANAS.pathPicker({
    node: 'harness',
    backend: 'live',
    mode: 'dir',
    value: '/mnt',
    onSelect: (v) => { picked = v },
  })
  await settle()
  ok('picker: the window opened', !!win)
  eq('picker: the first browse is the starting directory', liveCalls[0], '/fs/browse?path=%2Fmnt')

  const tree = win.down('#pickerTree')
  const root = tree.getRootNode()
  eq('picker: the root level loaded its children',
    root.childNodes.map(n => n.get('name')), ['pictures', 'photos-old'])

  // Expanding a child asks for THAT child's path — the lazy load.
  liveCalls.length = 0
  const child = root.childNodes[0]
  tree.fireEvent('beforeitemexpand', child)
  await settle()
  eq('picker: expanding a node browses that node’s own path',
    liveCalls[0], '/fs/browse?path=%2Fmnt%2Fpictures')
  eq('picker: the expanded node holds its own level',
    child.childNodes.map(n => n.get('name')), ['2024', '2025'])
  ok('picker: an expanded node is marked loaded, so it is not fetched twice',
    child.get('loaded') === true)
  liveCalls.length = 0
  tree.fireEvent('beforeitemexpand', child)
  await settle()
  eq('picker: re-expanding a loaded node makes no call', liveCalls.length, 0)

  // Clicking a row fills the path field — the field stays the value.
  tree.selectNode(root.childNodes[1])
  eq('picker: clicking a row fills the path field',
    win.down('#pickerPath').getValue(), '/mnt/photos-old')

  // Breadcrumb navigation: jump back to the root.
  liveCalls.length = 0
  ok('picker: the breadcrumb rendered every segment',
    /data-path="\/mnt"/.test(win.down('#pickerCrumbs').html), win.down('#pickerCrumbs').html)

  // Type-ahead: typing a path in ANOTHER directory jumps there and selects the
  // matching row; typing a tail in THIS directory just filters.
  liveCalls.length = 0
  win.down('#pickerPath').setValue('/mnt/pictures/20')
  await settle()
  eq('picker: type-ahead jumped to the typed parent',
    liveCalls[0], '/fs/browse?path=%2Fmnt%2Fpictures')
  eq('picker: type-ahead selected the first matching child',
    tree.getSelection().length && tree.getSelection()[0].get('name'), '2024')

  // Typing a deeper tail INSIDE the current directory only filters — no browse.
  liveCalls.length = 0
  win.down('#pickerPath').setValue('/mnt/pictures/2025')
  await settle()
  eq('picker: a tail in the current directory filters without a new browse', liveCalls.length, 0)
  eq('picker: and the cursor moved to the match',
    tree.getSelection().length && tree.getSelection()[0].get('name'), '2025')

  // The type-ahead must not chase its own tail: moving the cursor writes the
  // path field, and the field drives the type-ahead. One keystroke, ONE browse.
  liveCalls.length = 0
  win.down('#pickerPath').setValue('/mnt/photos')
  await settle()
  eq('picker: a jump settles — one browse, no field/selection loop', liveCalls.length, 1)
  eq('picker: the jump landed on the matching row',
    tree.getSelection().length && tree.getSelection()[0].get('name'), 'photos-old')

  // Keyboard: ENTER on a row is the Select button. In DIRECTORY mode a folder
  // IS the answer, so ENTER finishes rather than descending.
  const ENTER = { getKey: () => 13, ENTER: 13, stopEvent() {} }
  tree.fireEvent('itemkeydown', tree, root.childNodes[0], null, 0, ENTER)
  eq('picker: ENTER on a folder in directory mode selects it', picked, '/mnt/pictures')
  ok('picker: and it closed the window', win.destroyed === true)

  // A fresh picker for the remaining single-select checks (the last one closed).
  picked = null
  const win2 = ANAS.pathPicker({
    node: 'harness',
    backend: 'live',
    mode: 'dir',
    value: '/mnt',
    onSelect: (v) => { picked = v },
  })
  await settle()

  // Select: free-form typing is AUTHORITATIVE — a path the tree never showed is
  // still a legitimate answer.
  win2.down('#pickerPath').setValue('/mnt/not-browsed-yet')
  const selectBtn = win2.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  selectBtn.handler(selectBtn)
  eq('picker: Select returns the TYPED path, not the tree cursor', picked, '/mnt/not-browsed-yet')

  // --- multi-select against the archive backend ---------------------------
  browseCalls.length = 0
  let multi = null
  const mwin = ANAS.pathPicker({
    node: 'harness',
    backend: 'archive',
    mode: 'any',
    multiSelect: true,
    archive: { repo: 'pbs-main', ns: 'anas/pictures', snapshot: 'host/pictures/2026-08-25T19:16:45Z', archive: 'data.pxar' },
    onSelect: (v) => { multi = v },
  })
  await settle()
  eq('picker: the archive picker opened at the archive root', browseCalls[0].path, '/')
  const mtree = mwin.down('#pickerTree')
  const mroot = mtree.getRootNode()
  eq('picker: the archive root listed its entries',
    mroot.childNodes.map(n => n.get('name')),
    ['docs', 'alpha.txt', 'hard-a.txt', 'hard-b.txt', 'link-to-alpha'])
  // F11 — the Modified column LABELS a node-local time rather than leaving a
  // reader to assume UTC: a header tooltip, and the words on the marked cell.
  const modCol = (mtree.columns || []).find(c => c.dataIndex === 'modified')
  ok('picker: the Modified column has a node-local-time tooltip',
    !!modCol && /node local time/i.test(modCol.tooltip || ''), modCol && modCol.tooltip)
  ok('picker: it says the time is not UTC and not converted',
    !!modCol && /not UTC/.test(modCol.tooltip || ''), modCol && modCol.tooltip)
  const alphaCell = modCol.renderer('2026-08-25 19:16:23', {}, mroot.childNodes[1]);
  ok('picker: a marked cell carries the verbatim time', /2026-08-25 19:16:23/.test(alphaCell), alphaCell)
  ok('picker: and says node local time on the cell', /node local time/.test(alphaCell), alphaCell)
  // The tooltip is allowed to SAY "not UTC"; what is displayed must not be a
  // converted time or wear a zone suffix of its own.
  const alphaShown = alphaCell.replace(/data-qtip="[^"]*"/g, '');
  ok('picker: nothing converts it or claims UTC', !/UTC|GMT|\+\d\d:\d\d/.test(alphaShown), alphaShown)
  eq('picker: an entry with no mtime renders nothing at all',
    modCol.renderer('', {}, mroot.childNodes[0]), '')

  // Pick the hardlink and an ordinary file.
  mtree._selection = [mroot.childNodes[3], mroot.childNodes[1]]
  mtree.fireEvent('selectionchange', {}, mtree._selection)
  const mSelect = mwin.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  mSelect.handler(mSelect)
  eq('picker: multi-select returns a set, hardlink group intact',
    multi, ['/hard-b.txt', '/hard-a.txt', '/alpha.txt'])

  // A row the mode cannot take is DROPPED and said out loud — never returned as
  // a path the caller silently did not agree to.
  const dirWin = ANAS.pathPicker({
    node: 'harness',
    backend: 'archive',
    mode: 'file',
    multiSelect: true,
    archive: { repo: 'pbs-main', snapshot: 'host/pictures/2026-08-25T19:16:45Z', archive: 'data.pxar' },
    onSelect: (v) => { multi = v },
  })
  await settle()
  const dtree = dirWin.down('#pickerTree')
  const droot = dtree.getRootNode()
  dtree._selection = [droot.childNodes[0], droot.childNodes[1]]
  dtree.fireEvent('selectionchange', {}, dtree._selection)
  const dSelect = dirWin.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  dSelect.handler(dSelect)
  eq('picker: a file-mode multi-select drops the directory', multi, ['/alpha.txt'])
  ok('picker: and says it dropped something',
    /cannot be picked here/.test(dirWin.down('#pickerNote').html), dirWin.down('#pickerNote').html)

  // --- the point-in-time picker ------------------------------------------
  eq('picker: the task door is the task’s own snapshots endpoint',
    P.snapshotListUrl({ task: 'nightly-pictures' }), '/backup/tasks/nightly-pictures/snapshots')
  eq('picker: the task-less door is the repository groups endpoint',
    P.snapshotListUrl({ repo: 'pbs-main', ns: 'anas/pictures', group: 'host/pictures' }),
    '/backup/repos/pbs-main/groups?ns=anas%2Fpictures&group=host%2Fpictures')
  eq('picker: a bare repository door has no query at all',
    P.snapshotListUrl({ repo: 'pbs-main' }), '/backup/repos/pbs-main/groups')

  const snapRows = P.snapshotRows(PICKER_ROUTES['GET /backup/tasks/nightly-pictures/snapshots'].data)
  eq('picker: the daemon’s newest-first order is preserved',
    snapRows.map(r => r.backupTimeIso), ['2026-08-25T19:16:45Z', '2026-08-24T19:16:45Z'])
  eq('picker: bookkeeping files are never offered as archives',
    snapRows[0].archives.map(a => a.archive), ['data.pxar'])
  eq('picker: an image archive is listed with its kind',
    snapRows[1].archives, [{ archive: 'lun.img', kind: 'img', size: 536870912 }])
  eq('picker: the composed id rides every row', snapRows[0].snapshot, 'host/pictures/2026-08-25T19:16:45Z')

  let chosen = null
  const swin = ANAS.snapshotPicker({ node: 'harness', task: 'nightly-pictures', onSelect: (v) => { chosen = v } })
  await settle()
  const sgrid = swin.down('#snapGrid')
  eq('picker: the snapshot grid loaded both points in time', sgrid.getStore().getCount(), 2)
  sgrid.selectRow(0)
  const sSelect = swin.buttonCmps.find(b => b.cls === 'anas-btn-snap-select')
  sSelect.handler(sSelect)
  eq('picker: choosing a point in time hands back the FULL id (never a bare group)',
    chosen && chosen.snapshot, 'host/pictures/2026-08-25T19:16:45Z')
  ok('picker: the chosen point in time carries its archives',
    chosen && chosen.archives.length === 1 && chosen.archives[0].archive === 'data.pxar')

  ok('picker: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  5b. The wizard's archive path: TYPED and PICKED must send the same bytes
// ============================================================================

async function pickedPathChecks() {
  liveCalls.length = 0
  const ANAS = loadPickerSources(['12-picker.js', '68-backup.js'])
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  const NEW_PATH = '/mnt/pictures/2025'

  // (a) TYPED: open the dialog, type the path into the archive row, save.
  const typedDlg = await openEdit(grid)
  archiveRows(typedDlg)[0].down('#archPath').setValue(NEW_PATH)
  await settle()
  const typedBody = await save(typedDlg)
  ok('picked-path: the typed save produced a body', !!typedBody)

  // (b) PICKED: open the dialog, open the picker from the row's Browse button,
  //     walk to the same directory and Select — then save.
  const pickedDlg = await openEdit(grid)
  const row = archiveRows(pickedDlg)[0]
  // The Browse button sits beside #archPath and is identified by its cls (the
  // harness's down() matches itemIds and xtypes only), so walk for it.
  let btn = null
  const findByCls = (cmp) => {
    for (const kid of cmp.childCmps()) {
      if (kid.cls === 'anas-btn-backup-arch-browse') { btn = kid }
      findByCls(kid)
    }
  }
  findByCls(row)
  ok('picked-path: the archive row still has its Browse button', !!btn)
  btn.handler(btn)
  await settle()

  const pickerWin = openWindow()
  ok('picked-path: Browse opened the SHARED path picker', pickerWin && pickerWin.cls === 'anas-win-path-picker')
  // Walk: the picker opened on the row's current path; navigate to the target
  // through the tree exactly as a click would, then Select.
  pickerWin.down('#pickerPath').setValue(NEW_PATH)
  const pickBtn = pickerWin.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  pickBtn.handler(pickBtn)
  await settle()
  eq('picked-path: Select filled the wizard field',
    archiveRows(pickedDlg)[0].down('#archPath').getValue(), NEW_PATH)
  const pickedBody = await save(pickedDlg)

  // The check is only meaningful if the path really changed — otherwise both
  // bodies would be the stored task and the comparison would prove nothing.
  eq('picked-path: the typed save actually carried the new path',
    typedBody && typedBody.archives[0].path, NEW_PATH)
  eq('picked-path: typed and picked send byte-identical bodies', pickedBody, typedBody)
}

//  7. Held by a LUN (story iscsi.6) — every refused verb's button carries the
//     reason, and an ABSENT field gates nothing.
//
//  The daemon answers the question ONCE, on the row (`heldByLun`), and all four
//  screens read that one answer: no extra request per row, no second rule, and
//  the tooltip is the daemon's own `detail` sentence — so a greyed button and
//  the 409 it would have produced say the same thing.
//
//  The absent case is the version-skew ruling made testable: a new UI against a
//  pre-iscsi.6 daemon gets no field at all and must render today's screen.
// ============================================================================

const HELD_VOL = {
  targetIqn: 'iqn.2026-08.nas.anas:vmstore',
  index: 0,
  name: 'vmdisk1',
  backingPath: '/dev/zvol/tank/vol1',
  connectedInitiators: ['iqn.1993-08.org.debian:01:abc'],
  detail: 'held by iSCSI LUN 0 \'vmdisk1\' of target iqn.2026-08.nas.anas:vmstore (/dev/zvol/tank/vol1) with 1 live session',
}

const HELD_FS = {
  targetIqn: 'iqn.2026-08.nas.anas:vmstore',
  index: 1,
  name: 'vmdisk2',
  backingPath: '/tank/media/lun2.raw',
  connectedInitiators: [],
  detail: 'held by iSCSI LUN 1 \'vmdisk2\' of target iqn.2026-08.nas.anas:vmstore (/tank/media/lun2.raw)',
}

/** The same datasets as section 4, with the two held rows stamped. */
const HELD_IMAGES_DATASET = {
  name: 'tank/images',
  pool: 'tank',
  type: 'filesystem',
  used: 1,
  available: 1,
  referenced: 1,
  mountpoint: '/tank/images',
  compression: 'lz4',
  compressratio: 1,
  quota: 0,
  heldByLun: HELD_FS,
}

// `tank/vol1` is held as the LUN's own backing device; `tank/images` is held
// because a LUN's IMAGE FILE lives under its mountpoint. `tank/media` is the
// control and must stay fully usable.
const HELD_DATASETS = [
  ...TANK_DATASETS.map(d => (d.name === 'tank/vol1' ? { ...d, heldByLun: HELD_VOL } : d)),
  HELD_IMAGES_DATASET,
]

const HELD_DATASET_ROUTES = {
  ...DATASET_ROUTES,
  'GET /pools/tank/datasets': { data: HELD_DATASETS, defaults: { volblocksize: 16384 } },
}

/** A snapshot row as the tree builds one, hung off `parent`. */
function snapshotRecord(parent, name) {
  const data = {
    name: `@${name}`,
    fullName: `${parent.get('fullName')}@${name}`,
    pool: parent.get('pool'),
    dataset: parent.get('fullName'),
    snapshotName: name,
    kind: 'snapshot',
  }
  return { data, get: k => data[k], set: (k, v) => { data[k] = v }, parentNode: parent }
}

async function openDatasetTree(routes) {
  const ANAS = loadSource('60-datasets.js', routes)
  const view = makeComponent(ANAS.views.datasets.factory('harness'), null)
  const tree = view.down('#dsTree')
  tree.fireEvent('afterrender', tree)
  await settle()
  return { ANAS, tree }
}

async function heldByLunDatasetChecks() {
  const GATED = ['dsDestroy', 'dsResize', 'snapRollback']
  const { tree } = await openDatasetTree(HELD_DATASET_ROUTES)

  const volNode = findNode(tree, 'tank/vol1')
  const fsNode = findNode(tree, 'tank/images')
  const freeNode = findNode(tree, 'tank/media')
  ok('held(datasets): the held volume row loaded', !!volNode)
  ok('held(datasets): the held filesystem row loaded', !!fsNode)
  if (!volNode || !fsNode || !freeNode) { return }

  // The row carries the daemon's answer verbatim — the UI never re-derives it.
  eq('held(datasets): the field reached the tree node', volNode.get('heldByLun'), HELD_VOL)

  tree.selectNode(volNode)
  let state = toolbarState(tree, GATED)
  ok('held(volume): Destroy DISABLED', state.dsDestroy.disabled === true)
  ok('held(volume): Destroy names the holding target', state.dsDestroy.tip.includes(HELD_VOL.targetIqn),
    state.dsDestroy.tip)
  ok('held(volume): Destroy names the LUN', /LUN 0 'vmdisk1'/.test(state.dsDestroy.tip), state.dsDestroy.tip)
  ok('held(volume): Destroy says what to do next', /iSCSI screen/.test(state.dsDestroy.tip), state.dsDestroy.tip)
  // A GROW is the supported live resize — refusing it would take away the only
  // safe way to change a served volume's size.
  ok('held(volume): Resize Volume STAYS ENABLED (grow is the live path)',
    state.dsResize.disabled === false)

  tree.selectNode(fsNode)
  state = toolbarState(tree, GATED)
  ok('held(filesystem): Destroy DISABLED (a LUN image lives under its mountpoint)',
    state.dsDestroy.disabled === true)
  ok('held(filesystem): Destroy names the LUN', /LUN 1 'vmdisk2'/.test(state.dsDestroy.tip), state.dsDestroy.tip)

  // The rollback subject is the snapshot's PARENT dataset.
  tree.selectNode(snapshotRecord(volNode, 'before-grow'))
  state = toolbarState(tree, GATED)
  ok('held(snapshot): Rollback DISABLED on a snapshot of a held volume',
    state.snapRollback.disabled === true)
  ok('held(snapshot): Rollback names the LUN', /LUN 0 'vmdisk1'/.test(state.snapRollback.tip),
    state.snapRollback.tip)

  tree.selectNode(snapshotRecord(freeNode, 'nightly'))
  state = toolbarState(tree, GATED)
  ok('held(snapshot): Rollback stays ENABLED on a snapshot of an unheld dataset',
    state.snapRollback.disabled === false)
  ok('held(snapshot): and carries no leftover excuse', state.snapRollback.tip === '',
    state.snapRollback.tip)

  // Selecting an unheld row must CLEAR the reason, not leave it stuck.
  tree.selectNode(freeNode)
  state = toolbarState(tree, GATED)
  ok('held(unheld): Destroy enabled again', state.dsDestroy.disabled === false)
  ok('held(unheld): and the reason is gone', state.dsDestroy.tip === '', state.dsDestroy.tip)
  ok('held(datasets): nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function heldByLunAbsentFieldChecks() {
  // The SAME screen against a pre-iscsi.6 daemon: no `heldByLun` anywhere.
  const { tree } = await openDatasetTree(DATASET_ROUTES)
  const volNode = findNode(tree, 'tank/vol1')
  const fsNode = findNode(tree, 'tank/media')
  if (!volNode || !fsNode) { ok('skew: the rows loaded', false); return }

  eq('skew: the row carries no heldByLun at all', volNode.get('heldByLun'), undefined)

  tree.selectNode(volNode)
  let state = toolbarState(tree, ['dsDestroy', 'dsResize'])
  ok('skew(volume): Destroy stays ENABLED — absent means no gating',
    state.dsDestroy.disabled === false)
  ok('skew(volume): and carries no reason', state.dsDestroy.tip === '', state.dsDestroy.tip)

  tree.selectNode(fsNode)
  state = toolbarState(tree, ['dsDestroy'])
  ok('skew(filesystem): Destroy stays ENABLED', state.dsDestroy.disabled === false)

  tree.selectNode(snapshotRecord(volNode, 'before-grow'))
  state = toolbarState(tree, ['snapRollback'])
  ok('skew(snapshot): Rollback stays ENABLED', state.snapRollback.disabled === false)
  ok('skew: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ---- Pools / Hybrid RAID / Mounts: the same field, three more toolbars ------

const HELD_POOL = {
  targetIqn: 'iqn.2026-08.nas.anas:vmstore',
  index: 0,
  name: 'vmdisk1',
  backingPath: '/dev/zvol/tank/vol1',
  connectedInitiators: [],
  detail: 'held by iSCSI LUN 0 \'vmdisk1\' of target iqn.2026-08.nas.anas:vmstore (/dev/zvol/tank/vol1)',
}

function poolRow(name, extra) {
  return {
    name,
    state: 'ONLINE',
    size: 8 * GiB,
    allocated: GiB,
    free: 7 * GiB,
    capacity: 12,
    fragmentation: 0,
    dedupRatio: 1,
    scanRunning: false,
    trimSupported: false,
    upgradeAvailable: false,
    mountpoint: `/${name}`,
    mounted: true,
    pveStorages: [],
    ...extra,
  }
}

async function heldByLunPoolChecks() {
  // Export and Destroy are registered by their own action files, which push
  // into the `ANAS.pools.actions` list the grid's toolbar is built from — so
  // all three sources have to share ONE sandbox.
  const ANAS = loadSources(['15-gfx.js', '30-pools.js', '36-pool-export.js', '37-pool-destroy.js'], {
    'GET /pools': { data: [poolRow('tank', { heldByLun: HELD_POOL }), poolRow('spare')] },
  })
  // `ANAS.views.pools.factory` returns the grid itself (no wrapping panel).
  const view = makeComponent(ANAS.views.pools.factory('harness'), null)
  const grid = view.itemId === 'poolsGrid' ? view : view.down('#poolsGrid')
  ok('held(pools): the grid exists', !!grid, JSON.stringify(warnings))
  if (!grid) { return }
  grid.fireEvent('afterrender', grid)
  await settle()

  const GATED = ['exportPool', 'destroyPool']
  const rowOf = name => grid.getStore().findExact('name', name)
  grid.selectRow(rowOf('tank'))
  let state = toolbar(grid, GATED)
  ok('held(pools): the action buttons exist', !!state.destroyPool && !!state.exportPool)
  if (!state.destroyPool || !state.exportPool) { return }
  ok('held(pools): Destroy DISABLED', state.destroyPool.disabled === true)
  ok('held(pools): Export DISABLED', state.exportPool.disabled === true)
  ok('held(pools): Destroy names the LUN', /LUN 0 'vmdisk1'/.test(state.destroyPool.tip), state.destroyPool.tip)
  ok('held(pools): Export names the LUN', /LUN 0 'vmdisk1'/.test(state.exportPool.tip), state.exportPool.tip)

  grid.selectRow(rowOf('spare'))
  state = toolbar(grid, GATED)
  ok('held(pools): an unheld pool keeps Destroy', state.destroyPool.disabled === false)
  ok('held(pools): and carries no leftover reason', state.destroyPool.tip === '', state.destroyPool.tip)
  ok('held(pools): nothing warned', warnings.length === 0, warnings.join(' | '))
}

const AHR_HELD = {
  targetIqn: 'iqn.2026-08.nas.anas:blockstore',
  index: 0,
  name: 'ahrblock1',
  backingPath: '/mnt/anas-ahr/ahr0/images/block1.raw',
  connectedInitiators: [],
  detail: 'held by iSCSI LUN 0 \'ahrblock1\' of target iqn.2026-08.nas.anas:blockstore (/mnt/anas-ahr/ahr0/images/block1.raw)',
}

function ahrPoolRow(name, extra) {
  return {
    name,
    ahrType: 'ahr1',
    state: 'healthy',
    mountpoint: `/mnt/anas-ahr/${name}`,
    mounted: true,
    subvolLayout: true,
    disks: [],
    arrays: [],
    vg: { name, sizeBytes: 8 * GiB, freeBytes: 0 },
    lv: { name: `${name}-vol`, sizeBytes: 8 * GiB },
    capacity: { rawBytes: 8 * GiB, usableBytes: 6 * GiB, usedBytes: GiB, freeBytes: 5 * GiB },
    advisories: [],
    ...extra,
  }
}

async function heldByLunAhrChecks() {
  const ANAS = loadSources(['15-gfx.js', '39-ahr.js'], {
    'GET /ahr': { data: [ahrPoolRow('ahr0', { heldByLun: AHR_HELD }), ahrPoolRow('ahr1')] },
  })
  const view = makeComponent(ANAS.views.ahr.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.itemId === 'ahrGrid' ? view : view.down('#ahrGrid')
  ok('held(ahr): the grid exists', !!grid, JSON.stringify(warnings))
  if (!grid) { return }

  const GATED = ['destroy', 'changeMount']
  const rowOf = name => grid.getStore().findExact('name', name)
  grid.selectRow(rowOf('ahr0'))
  let state = toolbar(grid, GATED)
  ok('held(ahr): the action buttons exist', !!state.destroy && !!state.changeMount)
  if (!state.destroy || !state.changeMount) { return }
  ok('held(ahr): Destroy DISABLED', state.destroy.disabled === true)
  ok('held(ahr): Change mount DISABLED', state.changeMount.disabled === true)
  ok('held(ahr): Destroy names the LUN', /LUN 0 'ahrblock1'/.test(state.destroy.tip), state.destroy.tip)
  ok('held(ahr): Change mount names the LUN', /LUN 0 'ahrblock1'/.test(state.changeMount.tip), state.changeMount.tip)

  grid.selectRow(rowOf('ahr1'))
  state = toolbar(grid, GATED)
  ok('held(ahr): an unheld pool keeps Destroy', state.destroy.disabled === false)
  ok('held(ahr): and carries no leftover reason', state.destroy.tip === '', state.destroy.tip)
  ok('held(ahr): nothing warned', warnings.length === 0, warnings.join(' | '))
}

const MOUNT_HELD = {
  targetIqn: 'iqn.2026-08.nas.anas:vmstore',
  index: 1,
  name: 'vmdisk2',
  backingPath: '/mnt/anas-nfs/blocks/lun.raw',
  connectedInitiators: [],
  detail: 'held by iSCSI LUN 1 \'vmdisk2\' of target iqn.2026-08.nas.anas:vmstore (/mnt/anas-nfs/blocks/lun.raw)',
}

function mountRow(mountpoint, extra) {
  return {
    mountpoint,
    source: 'nas.example.test:/export/blocks',
    type: 'nfs',
    fstype: 'nfs4',
    state: 'ok',
    mounted: true,
    persistent: true,
    remote: true,
    automount: false,
    disabled: false,
    pveManaged: false,
    ahrManaged: false,
    readOnly: false,
    ...extra,
  }
}

async function heldByLunMountChecks() {
  const ANAS = loadSource('67-mounts.js', {
    'GET /mounts': { data: [mountRow('/mnt/anas-nfs', { heldByLun: MOUNT_HELD }), mountRow('/mnt/other')] },
  })
  const view = makeComponent(ANAS.views.mounts.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#mountsGrid')
  ok('held(mounts): the grid exists', !!grid)
  if (!grid) { return }

  const GATED = ['mountToggle', 'mountRemove', 'mountDisable']
  const rowOf = mp => grid.getStore().findExact('mountpoint', mp)
  grid.selectRow(rowOf('/mnt/anas-nfs'))
  let state = toolbar(grid, GATED)
  ok('held(mounts): the action buttons exist', !!state.mountToggle && !!state.mountRemove)
  if (!state.mountToggle || !state.mountRemove) { return }
  ok('held(mounts): Unmount DISABLED', state.mountToggle.disabled === true)
  ok('held(mounts): Remove DISABLED', state.mountRemove.disabled === true)
  ok('held(mounts): Unmount names the LUN', /LUN 1 'vmdisk2'/.test(state.mountToggle.tip), state.mountToggle.tip)
  ok('held(mounts): Remove names the LUN', /LUN 1 'vmdisk2'/.test(state.mountRemove.tip), state.mountRemove.tip)

  grid.selectRow(rowOf('/mnt/other'))
  state = toolbar(grid, GATED)
  ok('held(mounts): an unheld mount keeps Unmount', state.mountToggle.disabled === false)
  ok('held(mounts): and Remove', state.mountRemove.disabled === false)
  ok('held(mounts): nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ---- The iSCSI screen's own two additions (story iscsi.6, clauses 4 and 7) --

async function iscsiBackingOwnerChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { ANAS } = await openIscsiView(ISCSI_ROUTES)
  const owner = ANAS.iscsi.backingOwner
  const rec = data => ({ data, get: k => data[k] })

  // NAME ONLY — no navigation machinery, no deep link, no cross-view router.
  eq('owner: a zvol points at Datasets, by dataset name',
    owner(rec({ kind: 'zvol', dataset: 'tank/vol1', backingPath: '/dev/zvol/tank/vol1' })),
    { screen: 'Datasets', name: 'tank/vol1' })
  eq('owner: a file on a dataset points at Datasets',
    owner(rec({ kind: 'file', dataset: 'tank/images', pool: 'tank', backingPath: '/tank/images/lun.raw' })),
    { screen: 'Datasets', name: 'tank/images' })
  eq('owner: a file on an AHR pool points at Hybrid RAID, by pool name',
    owner(rec({ kind: 'file', pool: 'ahr0', backingPath: '/mnt/anas-ahr/ahr0/lun.raw' })),
    { screen: 'Hybrid RAID', name: 'ahr0' })
  eq('owner: any other resolvable file points at Mounts, by its directory',
    owner(rec({ kind: 'file', backingPath: '/mnt/anas-nfs/blocks/lun.raw' })),
    { screen: 'Mounts', name: '/mnt/anas-nfs/blocks' })
  eq('owner: a foreign backing names no screen (none of ours owns it)',
    owner(rec({ kind: 'foreign', backingPath: '/dev/sdz' })), null)
  eq('owner: an unresolved backing names no screen either',
    owner(rec({ kind: 'unresolved', backingPath: '/gone/lun.raw' })), null)
  ok('owner: nothing warned', warnings.length === 0, warnings.join(' | '))
}

async function iscsiPortalWarningChecks() {
  ajax.responses = { '/network': PVE_NETWORK }
  const { ANAS } = await openIscsiView(ISCSI_ROUTES)
  const warn = ANAS.iscsi.portalAddressWarning
  const carried = [{ address: '192.168.200.50', iface: 'vmbr0' }]
  const missing = warn(carried, '203.0.113.77')

  eq('portal: an address the node carries warns about nothing',
    warn(carried, '192.168.200.50'), '')
  ok('portal: an address NO interface carries warns (LIO binds it silently — GT-24)',
    missing.includes('203.0.113.77'), missing)
  ok('portal: the warning says LIO will never tell you', /never tell you/.test(missing), missing)
  // A WARNING, never a block: an address about to exist is legitimate.
  ok('portal: it still says the portal would be created', /bind the portal anyway/.test(missing), missing)
  eq('portal: an EMPTY address list says nothing (PVE\'s network API was unreadable)',
    warn([], '203.0.113.77'), '')
  eq('portal: a blank field says nothing', warn(carried, ''), '')
  eq('portal: matching is case-insensitive (IPv6)',
    warn([{ address: 'fd00:6774:0:1::1' }], 'FD00:6774:0:1::1'), '')
  ok('portal: nothing warned', warnings.length === 0, warnings.join(' | '))
}


// ============================================================================
//  5c. backup2.6 — the RESTORE doors: what each mode SENDS
//
//  What this guards:
//    · the request body in EVERY mode — into the original (merge) and
//      somewhere else (the default, path required), through the task door
//      and the task-less repository door
//    · omission is meaningful: an un-ticked ignore flag, an empty namespace and
//      an empty rate are ABSENT, never `false`/`''`
//    · the confirm-code dance is predicted for an in-place TREE and ONLY for
//      that — a single explicitly picked file in place is not gated
//    · a hardlink group travels as ONE unit (GT-25), through the real picker
//    · `img` archives are NOT offered by the file-restore door
//    · both doors exist and open the same dialog
// ============================================================================

/** The archive tree the RESTORE picker walks — the same shape the daemon returns. */
const FILE_RESTORE_SNAPSHOTS = {
  data: {
    verdict: 'ok',
    repository: 'pbs-main',
    namespace: 'anas/pictures',
    group: 'host/pictures',
    snapshots: [{
      snapshot: 'host/pictures/2026-08-25T19:16:45Z',
      backupType: 'host',
      backupId: 'pictures',
      backupTime: 1787685405,
      backupTimeIso: '2026-08-25T19:16:45Z',
      size: 3309,
      files: [
        { filename: 'data.pxar.didx', archive: 'data.pxar', kind: 'pxar', size: 2607 },
        // A block image in the SAME snapshot: the file door must not offer it.
        { filename: 'lun.img.fidx', archive: 'lun.img', kind: 'img', size: 536870912 },
        { filename: 'catalog.pcat1.didx', kind: 'other', size: 327 },
      ],
    }],
  },
}

const FILE_RESTORE_ROUTES = {
  ...PICKER_ROUTES,
  // A FUNCTION route: the detail window stores `res.data` on itself and the
  // progressive scan later writes `nested` onto it — a shared constant object
  // would leak that state into every later detail GET in the harness.
  'GET /backup/tasks/nightly-pictures': () => ({
    data: {
      task: TASK,
      unit: '',
      timer: '',
      recentRuns: [],
      // The last run carried a notice (backup2 fix-ups): the run's toast
      // pointed at THIS window for it, so the detail must show it.
      lastRunNotices: [RUN_NOTICE],
    },
  }),
  'GET /backup/tasks/nightly-pictures/snapshots': FILE_RESTORE_SNAPSHOTS,
  'GET /backup/repos/pbs-main/groups': {
    data: {
      verdict: 'ok',
      repository: 'pbs-main',
      groups: [{
        group: 'host/pictures',
        backupType: 'host',
        backupId: 'pictures',
        backupCount: 3,
        lastBackup: 1787685405,
        lastBackupIso: '2026-08-25T19:16:45Z',
        files: [{ filename: 'data.pxar.didx', archive: 'data.pxar', kind: 'pxar' }],
      }],
    },
  },
  // A block task's group holds exactly ONE restorable archive (`disk.img`) so
  // the unified dialog auto-selects it — the whole-image half then appears.
  'GET /backup/tasks/lun-disk/snapshots': {
    data: {
      verdict: 'ok',
      repository: 'pbs-main',
      namespace: 'anas',
      group: LUN_GROUP,
      snapshots: [{
        snapshot: `${LUN_GROUP}/2026-08-25T19:16:45Z`,
        backupType: 'host',
        backupId: `lun-${LUN_SERIAL}`,
        backupTime: 1787685405,
        backupTimeIso: '2026-08-25T19:16:45Z',
        files: [{ filename: 'disk.img.fidx', archive: 'disk.img', kind: 'img', size: 2 * GiB_ }],
      }],
    },
  },
  // The block task whose `lun` record maps to a LIVE LUN (LUN 0 of this IQN).
  'GET /backup/tasks/live-lun/snapshots': {
    data: {
      verdict: 'ok',
      repository: 'pbs-main',
      namespace: 'anas',
      group: LUN_GROUP,
      snapshots: [{
        snapshot: `${LUN_GROUP}/2026-08-25T19:16:45Z`,
        backupType: 'host',
        backupId: `lun-${LUN_SERIAL}`,
        backupTime: 1787685405,
        backupTimeIso: '2026-08-25T19:16:45Z',
        files: [{ filename: 'disk.img.fidx', archive: 'disk.img', kind: 'img', size: 2 * GiB_ }],
      }],
    },
  },
  // The stray block task (its `lun` record maps to no LUN on this node).
  'GET /backup/tasks/stray-lun/snapshots': {
    data: {
      verdict: 'ok',
      repository: 'pbs-main',
      group: 'host/stray',
      snapshots: [{
        snapshot: 'host/stray/2026-08-25T19:16:45Z',
        backupType: 'host',
        backupId: 'stray',
        backupTime: 1787685405,
        backupTimeIso: '2026-08-25T19:16:45Z',
        files: [{ filename: 'disk.img.fidx', archive: 'disk.img', kind: 'img', size: 2 * GiB_ }],
      }],
    },
  },
  'POST /backup/restore': { job: { id: 'restore-1' } },
}

/** Open the restore dialog through the ONE dialog's task door and return it. */
function openFileRestoreDialog(ANAS, opts) {
  created.windows.length = 0
  const o = opts || {}
  ANAS.backup.openRestoreDialog('harness', 'harness', {
    task: o.task,
    repo: o.repo,
    ns: o.ns,
    homeByArchive: o.homeByArchive,
  })
  return openWindow()
}

/** Pick the point in time through the dialog's shared picker. */
async function pickFileSnapshot(dlg) {
  const snapBtn = dlg.down('#restoreSnapPick')
  snapBtn.handler(snapBtn)
  await settle()
  const snapWin = openWindow()
  if (!snapWin || snapWin.destroyed) { return null }
  snapWin.down('#snapGrid').selectRow(0)
  const snapSelect = snapWin.buttonCmps.find(b => b.cls === 'anas-btn-snap-select')
  snapSelect.handler(snapSelect)
  await settle()
  return snapWin
}

/**
 * The picker sandbox plus the restore-only routes (the task detail, the
 * snapshot listings, the restore door itself) AND the iSCSI reads the image
 * half needs (the LUN inventory, the new-LUN target + backing pickers).
 */
function loadRestoreSources() {
  const ANAS = loadPickerSources(['12-picker.js', '68-backup.js', '75-iscsi.js'])
  const ROUTES = { ...FILE_RESTORE_ROUTES, ...ISCSI_ROUTES }
  const baseGet = ANAS.api.get
  ANAS.api.get = (node, path) => {
    const [base, query] = path.split('?')
    if (base === '/fs/browse') {
      const params = new URLSearchParams(query || '')
      return Promise.resolve(liveRoute(params.get('path') || '/', params.get('files') === '1'))
    }
    const key = `GET ${base}`
    if (!(key in ROUTES)) { return Promise.reject(new Error(`unexpected GET ${key}`)) }
    const value = ROUTES[key]
    return Promise.resolve(typeof value === 'function' ? value(path) : value)
  }
  ANAS.api.post = (_node, path, body) => {
    const key = `POST ${path}`
    if (!(key in ROUTES)) { return Promise.reject(new Error(`unexpected ${key}`)) }
    const route = ROUTES[key]
    return Promise.resolve(typeof route === 'function' ? route(body) : route)
  }
  return ANAS
}

async function restoreChecks() {
  const ANAS = loadRestoreSources()
  const R = ANAS.backupRestore

  // --- pure helpers --------------------------------------------------------

  const ARCHIVES = FILE_RESTORE_SNAPSHOTS.data.snapshots[0].files
    .filter(f => f.archive)
    .map(f => ({ archive: f.archive, kind: f.kind, size: f.size }))
  eq('file restore: the files half offers ONLY the pxar archives',
    R.restorableArchives(ARCHIVES).map(a => a.archive), ['data.pxar'])
  eq('file restore: the image half offers ONLY the img archives',
    R.imageArchivesOf(ARCHIVES).map(a => a.archive), ['lun.img'])
  eq('file restore: the estimate is the archive`s logical size', R.archiveBytes(ARCHIVES, 'data.pxar'), 2607)
  eq('file restore: a lun-<serial> group id yields its serial',
    R.lunSerialOfGroup(`host/lun-${LUN_SERIAL}`), LUN_SERIAL)
  eq('file restore: a non-LUN group id yields no serial', R.lunSerialOfGroup('host/pictures'), '')

  const FILE_ROW = { path: '/alpha.txt', type: 'file' }
  const DIR_ROW = { path: '/docs', type: 'dir' }
  ok('file restore: in place + a directory predicts the confirm dance',
    R.needsConfirm('inPlace', [FILE_ROW, DIR_ROW]) === true)
  ok('file restore: in place + only files does NOT — the checkbox is the consent',
    R.needsConfirm('inPlace', [FILE_ROW]) === false)
  // A newLocation restore whose chosen directory ALREADY EXISTS is also gated
  // by the daemon (its own 409 + confirm code) — but the dialog cannot see
  // whether the path exists, so this helper does not predict it; the confirm
  // flow answers either gate the same way.
  ok('file restore: a new location is never PREDICTED gated (the daemon decides)',
    R.needsConfirm('newLocation', [DIR_ROW]) === false)
  ok('file restore: a typed selection with no row is not gated either',
    R.needsConfirm('inPlace', []) === false)

  // --- the files body, mode by mode ----------------------------------------

  const CTX = {
    repo: 'pbs-main',
    ns: 'anas/pictures',
    task: 'nightly-pictures',
    snapshot: 'host/pictures/2026-08-25T19:16:45Z',
    archive: 'data.pxar',
    selections: ['/alpha.txt'],
    home: '/mnt/pictures',
  }
  eq('file restore: the inPlace body (into the original) is exactly this',
    R.restoreBody({ ...CTX, mode: 'inPlace' }), {
      kind: 'files',
      repo: 'pbs-main',
      snapshot: 'host/pictures/2026-08-25T19:16:45Z',
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
      target: { mode: 'inPlace', path: '/mnt/pictures' },
      options: {},
      ns: 'anas/pictures',
      task: 'nightly-pictures',
    })
  // Somewhere else (the default radio, ruling 2026-08-29): carries the chosen
  // directory (trimmed) as the target; the archive's live home is IGNORED.
  eq('file restore: the newLocation body carries the chosen directory',
    R.restoreBody({ ...CTX, mode: 'newLocation', newPath: ' /srv/restores/pictures ' }).target,
    { mode: 'newLocation', path: '/srv/restores/pictures' })
  eq('file restore: an inPlace body ignores the newLocation path field',
    R.restoreBody({ ...CTX, mode: 'inPlace', newPath: '/srv/restores/pictures' }).target,
    { mode: 'inPlace', path: '/mnt/pictures' })
  // Every key OUTSIDE `target` is byte-identical between the two modes —
  // the destination is the only thing that differs.
  eq('file restore: every other key of a newLocation body is byte-identical to inPlace',
    (() => { const a = R.restoreBody({ ...CTX, mode: 'newLocation', newPath: '/srv/restores/pictures' }); delete a.target; return a })(),
    (() => { const a = R.restoreBody({ ...CTX, mode: 'inPlace' }); delete a.target; return a })())
  eq('file restore: the task-less door sends no task key',
    Object.prototype.hasOwnProperty.call(R.restoreBody({ ...CTX, task: '' }), 'task'), false)
  eq('file restore: an empty namespace is ABSENT, never an empty string',
    Object.prototype.hasOwnProperty.call(R.restoreBody({ ...CTX, ns: '' }), 'ns'), false)
  eq('file restore: an empty rate is absent; a set one rides',
    Object.prototype.hasOwnProperty.call(R.restoreBody({ ...CTX, rate: '' }), 'rate'), false)
  eq('file restore: a set rate rides verbatim', R.restoreBody({ ...CTX, rate: ' 50MB ' }).rate, '50MB')
  eq('file restore: an UN-TICKED ignore flag is absent, not false',
    R.restoreBody({ ...CTX, ignoreAcls: false }).options, {})
  eq('file restore: every ticked ignore flag rides', R.restoreBody({
    ...CTX,
    ignoreOwnership: true,
    ignoreAcls: true,
    ignoreXattrs: true,
    ignorePermissions: true,
  }).options, {
    ignoreOwnership: true,
    ignoreAcls: true,
    ignoreXattrs: true,
    ignorePermissions: true,
  })

  // --- the image body, mode by mode (backup2.7/2.10 shapes, byte-identical) --

  const IMG = {
    repo: 'pbs-main',
    ns: 'anas',
    snapshot: LUN_SNAP,
    archive: 'disk.img',
  }
  eq('image restore: the in-place body is exactly {kind,repo,ns,snapshot,archive,lun}',
    R.imageRestoreBody({ ...IMG, dest: 'inPlace', lun: { targetIqn: ISCSI_IQN, index: 0 } }), {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: LUN_SNAP,
      archive: 'disk.img',
      lun: { targetIqn: ISCSI_IQN, index: 0 },
      ns: 'anas',
    })
  eq('image restore: a blank ns sends no ns key',
    Object.prototype.hasOwnProperty.call(
      R.imageRestoreBody({ ...IMG, ns: '', dest: 'inPlace', lun: { targetIqn: ISCSI_IQN, index: 0 } }), 'ns'), false)
  ok('image restore: the in-place body NEVER carries a target key',
    !('target' in R.imageRestoreBody({ ...IMG, dest: 'inPlace', lun: { targetIqn: ISCSI_IQN, index: 0 } })))
  eq('image restore: the newLun body is the shared schema\'s exact shape',
    R.imageRestoreBody({ ...IMG, dest: 'newLun', newLunTargetIqn: ISCSI_IQN, newLunName: 'vmdisk-new', newLunKind: 'zvol', newLunPool: 'tank' }), {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: LUN_SNAP,
      archive: 'disk.img',
      target: {
        mode: 'newLun',
        targetIqn: ISCSI_IQN,
        name: 'vmdisk-new',
        backing: { kind: 'zvol', pool: 'tank' },
      },
      ns: 'anas',
    })
  ok('image restore: a newLun body NEVER carries the in-place lun key',
    !('lun' in R.imageRestoreBody({ ...IMG, dest: 'newLun', newLunTargetIqn: ISCSI_IQN, newLunName: 'n', newLunKind: 'zvol', newLunPool: 'tank' })))
  eq('image restore: a file-on-dataset backing is {kind:file, dataset}',
    R.imageRestoreBody({ ...IMG, dest: 'newLun', newLunTargetIqn: ISCSI_IQN, newLunName: 'n', newLunKind: 'file', filePath: 'tank/images' }).target.backing,
    { kind: 'file', dataset: 'tank/images' })
  eq('image restore: a file-on-AHR backing is {kind:file, ahrPool}',
    R.imageRestoreBody({ ...IMG, dest: 'newLun', newLunTargetIqn: ISCSI_IQN, newLunName: 'n', newLunKind: 'file', filePath: 'ahrpool', fileSource: 'ahr' }).target.backing,
    { kind: 'file', ahrPool: 'ahrpool' })

  // --- the files task door, end to end --------------------------------------

  jobs.length = 0
  const dlg = openFileRestoreDialog(ANAS, {
    task: 'nightly-pictures',
    repo: 'pbs-main',
    ns: 'anas/pictures',
    homeByArchive: { data: '/mnt/pictures' },
  })
  ok('file restore: the task door opened the unified restore dialog', dlg && dlg.cls === 'anas-win-backup-restore')
  // The bare-name prefill fetches the task (repo/ns/group/homes come from it),
  // which settles after the window opens.
  await settle()

  // The task door collapses the source part to the summary line (the task
  // already names repo, namespace and group) and starts AT the point in time.
  const summary = dlg.down('#restoreSourceSummary')
  ok('file restore: the task door shows the read-only summary line',
    summary && (summary.html || '').includes('From task'), summary && summary.html)
  ok('file restore: it names the task, the repository, namespace and group',
    /nightly-pictures/.test(summary.html || '') && /pbs-main/.test(summary.html || '')
    && /anas\/pictures/.test(summary.html || '') && /host\/pictures/.test(summary.html || ''),
    summary && summary.html)
  eq('file restore: the source fields are collapsed (disabled)',
    dlg.down('#restoreRepo').disabled && dlg.down('#restoreNs').disabled && dlg.down('#restoreGroup').disabled, true)
  ok('file restore: point-in-time is the first interactive field',
    dlg.down('#restoreSnapshot').disabled === false && dlg.down('#restoreSnapPick').disabled === false)

  // Point in time → the picker, then Select. The archive combo then holds BOTH
  // kinds — no auto-preference when there is a real choice.
  const snapWin1 = await pickFileSnapshot(dlg)
  ok('file restore: it opened the SHARED snapshot picker', snapWin1 && snapWin1.cls === 'anas-win-snapshot-picker')
  eq('file restore: the composed snapshot id is carried WHOLE (never a bare group)',
    dlg.down('#restoreSnapshot').getValue(), 'host/pictures/2026-08-25T19:16:45Z')
  const comboKinds = dlg.down('#restoreArchive').getStore().getRange().map(r => r.get('archive'))
  eq('file restore: the archive combo lists both kinds, pre-selecting nothing',
    comboKinds, ['data.pxar', 'lun.img'])
  eq('file restore: the what/where part stays hidden until an archive is picked',
    dlg.down('#restoreFilesWrap').hidden && dlg.down('#restoreImageWrap').hidden, true)
  dlg.down('#restoreArchive').setValue('data.pxar')
  await settle()
  eq('file restore: choosing the pxar archive reveals the files half',
    dlg.down('#restoreFilesWrap').hidden, false)
  eq('file restore: …and follows the archive to ITS live home',
    dlg.down('#restoreHome').getValue(), '/mnt/pictures')

  // Files → the archive-backed multi-select picker. Pick the HARDLINK only.
  const filesBtn = dlg.down('#restoreFilesPick')
  filesBtn.handler(filesBtn)
  await settle()
  const filePicker = openWindow()
  ok('file restore: it opened the shared path picker on the ARCHIVE backend',
    filePicker && filePicker.cls === 'anas-win-path-picker')
  const tree = filePicker.down('#pickerTree')
  const rootKids = filePicker.down('#pickerTree').getStore().getRootNode().childNodes
  const hardB = rootKids.find(n => n.get('name') === 'hard-b.txt')
  ok('file restore: the archive level listed the hardlink', !!hardB)
  tree.fireEvent('selectionchange', tree.getSelectionModel(), [hardB])
  const fileSelect = filePicker.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  fileSelect.handler(fileSelect)
  await settle()

  // The destination choice (ruling 2026-08-29): EXACTLY two radios,
  // "Somewhere else…" is the default, and Restore stays dead until the
  // directory is named (early validation — the daemon is still the authority).
  const targetGroup = dlg.down('#restoreTargetKind')
  const destRadios = targetGroup.childCmps()
  eq('file restore: EXACTLY two destination radios', destRadios.length, 2)
  eq('file restore: …with the two labels the ruling names, in order',
    destRadios.map(r => r.boxLabel),
    ['Into the original — overwrite matching files, keep the rest', 'Somewhere else…'])
  eq('file restore: "Somewhere else…" is the default destination',
    targetGroup.getValue(), { restoreTarget: 'newLocation' })
  eq('file restore: Restore is DEAD until the directory is named',
    dlg.down('#restoreSubmit').disabled, true)
  dlg.down('#restoreNewLocation').setValue('/mnt/pictures/restore-new')
  await settle()
  eq('file restore: naming the directory takes Restore live',
    dlg.down('#restoreSubmit').disabled, false)

  // Submit.
  const submit = dlg.down('#restoreSubmit')
  submit.handler(submit)
  await settle()

  ok('file restore: the dialog submitted exactly one request', jobs.length === 1, `${jobs.length}`)
  const sent = jobs[0] || {}
  eq('file restore: it is a POST to the ONE restore door', `${sent.method} ${sent.path}`, 'post /backup/restore')
  // #48: onSubmitted closes the dialog the moment the daemon accepts, so the
  // poll view must be the long-lived component the dialog was opened from —
  // keyed to the dialog, the failure alert and the completion summary die
  // with it.
  ok('file restore: the poll view outlives the dialog — never the dialog being closed',
    sent.view !== undefined && sent.view !== dlg, `view === dlg: ${sent.view === dlg}`)
  ok('file restore: it goes through confirmAndRun so a 409 can be answered',
    Object.prototype.hasOwnProperty.call(sent, 'confirmWindow'))
  eq('file restore: the hardlink group travelled as ONE unit (GT-25)',
    sent.body && sent.body.selections, ['/hard-b.txt', '/hard-a.txt'])
  eq('file restore: the body carries the task door`s full context', sent.body, {
    kind: 'files',
    repo: 'pbs-main',
    snapshot: 'host/pictures/2026-08-25T19:16:45Z',
    archive: 'data.pxar',
    selections: ['/hard-b.txt', '/hard-a.txt'],
    target: { mode: 'newLocation', path: '/mnt/pictures/restore-new' },
    options: {},
    ns: 'anas/pictures',
    task: 'nightly-pictures',
  })

  // The same dialog, in place, with a DIRECTORY picked.
  jobs.length = 0
  const dlg2 = openFileRestoreDialog(ANAS, {
    task: 'nightly-pictures',
    repo: 'pbs-main',
    ns: 'anas/pictures',
    homeByArchive: { data: '/mnt/pictures' },
  })
  await pickFileSnapshot(dlg2)
  dlg2.down('#restoreArchive').setValue('data.pxar')
  await settle()
  dlg2.down('#restoreTargetKind').setValue('inPlace')
  const filesBtn2 = dlg2.down('#restoreFilesPick')
  filesBtn2.handler(filesBtn2)
  await settle()
  const filePicker2 = openWindow()
  const tree2 = filePicker2.down('#pickerTree')
  const docs = tree2.getStore().getRootNode().childNodes.find(n => n.get('name') === 'docs')
  ok('file restore: the archive level listed the directory', !!docs)
  tree2.fireEvent('selectionchange', tree2.getSelectionModel(), [docs])
  const fileSelect2 = filePicker2.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  fileSelect2.handler(fileSelect2)
  await settle()
  const submit2 = dlg2.down('#restoreSubmit')
  submit2.handler(submit2)
  await settle()

  eq('file restore: the in-place tree body carries mode inPlace', jobs.length && jobs[0].body.target, {
    mode: 'inPlace',
    path: '/mnt/pictures',
  })
  eq('file restore: …and the directory selection', jobs.length && jobs[0].body.selections, ['/docs'])

  // --- backup2.10: the NEW LOCATION door, end to end ------------------------
  jobs.length = 0
  const dlgN = openFileRestoreDialog(ANAS, {
    task: 'nightly-pictures',
    repo: 'pbs-main',
    ns: 'anas/pictures',
    homeByArchive: { data: '/mnt/pictures' },
  })
  // Point in time → picker → Select; pick the pxar archive; files → alpha.txt.
  await pickFileSnapshot(dlgN)
  dlgN.down('#restoreArchive').setValue('data.pxar')
  await settle()
  const filesBtnN = dlgN.down('#restoreFilesPick')
  filesBtnN.handler(filesBtnN)
  await settle()
  const fpN = openWindow()
  const alphaN = fpN.down('#pickerTree').getStore().getRootNode().childNodes.find(n => n.get('name') === 'alpha.txt')
  fpN.down('#pickerTree').fireEvent('selectionchange', fpN.down('#pickerTree').getSelectionModel(), [alphaN])
  const fselectN = fpN.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  fselectN.handler(fselectN)
  await settle()

  // "Somewhere else…" is the DEFAULT radio, so the directory field is up front.
  ok('file restore: the directory field is visible BY DEFAULT (somewhere-else is the default)',
    dlgN.down('#restoreNewLocationWrap').hidden === false)
  ok('file restore: the note says created-if-missing, confirm-then-merge-if-exists',
    /Created by this restore if it does not exist/.test(dlgN.down('#restoreNewLocationNote').html || '')
    && /ask you to confirm and then merge/.test(dlgN.down('#restoreNewLocationNote').html || ''),
    dlgN.down('#restoreNewLocationNote').html)
  dlgN.down('#restoreTargetKind').setValue('inPlace')
  await settle()
  ok('file restore: choosing "Into the original" hides the directory field',
    dlgN.down('#restoreNewLocationWrap').hidden === true)
  dlgN.down('#restoreTargetKind').setValue('newLocation')
  await settle()
  ok('file restore: …and choosing "Somewhere else…" reveals it again',
    dlgN.down('#restoreNewLocationWrap').hidden === false)

  // The Browse button opens the SHARED path picker on the LIVE backend, for a
  // DIRECTORY; typing a new name is the whole point (the tree shows its parent).
  created.windows.length = 0
  dlgN.down('#restoreNewLocationBrowse').handler()
  await settle()
  const newPicker = openWindow()
  ok('file restore: the Browse button opened the SHARED picker on the LIVE backend',
    newPicker && newPicker.cls === 'anas-win-path-picker'
    && newPicker._backend && newPicker._backend.key === 'live',
    newPicker && newPicker.cls)
  newPicker.down('#pickerPath').setValue('/mnt/pictures/restore-new')
  await settle()
  const pickSelectN = newPicker.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  pickSelectN.handler(pickSelectN)
  await settle()
  eq('file restore: the picked new directory landed in the field',
    dlgN.down('#restoreNewLocation').getValue(), '/mnt/pictures/restore-new')
  ok('file restore: the target line names the directory and what happens to it',
    (dlgN.down('#restoreTargetNote').html || '').includes('/mnt/pictures/restore-new')
    && /Created by this restore if it does not exist/.test(dlgN.down('#restoreTargetNote').html || ''),
    dlgN.down('#restoreTargetNote').html)

  const submitN = dlgN.down('#restoreSubmit')
  submitN.handler(submitN)
  await settle()
  ok('file restore: the newLocation dialog submitted exactly one request', jobs.length === 1, `${jobs.length}`)
  eq('file restore: the newLocation body carries exactly the new target',
    jobs.length && jobs[0].body, {
      kind: 'files',
      repo: 'pbs-main',
      snapshot: 'host/pictures/2026-08-25T19:16:45Z',
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
      target: { mode: 'newLocation', path: '/mnt/pictures/restore-new' },
      options: {},
      ns: 'anas/pictures',
      task: 'nightly-pictures',
    })
  ok('file restore: the files half always rides confirmAndRun (the daemon may still gate an existing directory)',
    Object.prototype.hasOwnProperty.call(jobs[0], 'confirmWindow') && jobs[0].confirmWindow === false,
    JSON.stringify(jobs[0] && jobs[0].confirmWindow))

  // --- the 409 dance: an EXISTING chosen directory (ruling 2026-08-29) ------
  // The transport below is a double that answers the daemon's gate; the control
  // flow mirrors 10-api.js (post → 409 + confirm code → the daemon's message in
  // a Confirm → resend with the code). What is asserted is what 68-backup.js
  // puts on the wire and what the operator is shown.
  {
    const ANASg = loadRestoreSources()
    const EXISTS = '/gtbackup/exists'
    const SENTENCE = `'${EXISTS}' already exists: restoring into it overwrites files with the same names and keeps everything else. Confirm to proceed.`
    const attempts = []
    const wireErr = () => {
      const e = new Error(SENTENCE)
      e.status = 409
      e.confirmCode = 'GT-CONFIRM-1'
      e.body = { error: { code: 'CONFIRMATION_REQUIRED', message: SENTENCE, warnings: [SENTENCE] } }
      return e
    }
    // Everything EXCEPT the restore door rides the sandbox's own routes
    // (the picker's archive browse is a POST too).
    const realPost = ANASg.api.post
    ANASg.api.post = (node, path, body, opts) => {
      if (path !== '/backup/restore') { return realPost(node, path, body, opts) }
      attempts.push({ path, body, confirmCode: opts && opts.confirmCode })
      return (opts && opts.confirmCode)
        ? Promise.resolve({ job: { id: 'restore-1' } })
        : Promise.reject(wireErr())
    }
    ANASg.runJob = (cfg) => ANASg.api.post(cfg.node, cfg.path, cfg.body, cfg.confirmCode ? { confirmCode: cfg.confirmCode } : undefined)
      .then((res) => {
        if (cfg.onSubmitted) { cfg.onSubmitted(res.job) }
        if (cfg.onComplete) { cfg.onComplete({ job: res.job, status: 'completed' }) }
      })
      .catch((err) => {
        if (err && err.status === 409 && err.confirmCode && cfg.onConfirm) { cfg.onConfirm(err); return }
        if (cfg.onFailed) { cfg.onFailed(null) }
      })
    ANASg.confirmAndRun = (opts) => {
      const base = { ...opts }
      base.onConfirm = (err) => {
        // The plain presentation renders intro + the daemon's warnings —
        // exactly the real confirmAndRun's message (10-api.js).
        const warnings = (err.body && err.body.error && err.body.error.warnings) || []
        const intro = opts.confirmIntro || 'Confirm:'
        Ext.Msg.confirm(opts.confirmTitle || 'Confirm', intro + ANASg.warningsHtml(warnings), (btn) => {
          if (btn === 'yes') {
            ANASg.runJob({ ...opts, confirmCode: err.confirmCode })
          }
        })
      }
      ANASg.runJob(base)
    }

    const confirmsBefore = confirms.length
    const dlgG = openFileRestoreDialog(ANASg, {
      task: 'nightly-pictures',
      repo: 'pbs-main',
      ns: 'anas/pictures',
      homeByArchive: { data: '/mnt/pictures' },
    })
    await pickFileSnapshot(dlgG)
    dlgG.down('#restoreArchive').setValue('data.pxar')
    await settle()
    const filesBtnG = dlgG.down('#restoreFilesPick')
    filesBtnG.handler(filesBtnG)
    await settle()
    const fpG = openWindow()
    const alphaG = fpG.down('#pickerTree').getStore().getRootNode().childNodes.find(n => n.get('name') === 'alpha.txt')
    fpG.down('#pickerTree').fireEvent('selectionchange', fpG.down('#pickerTree').getSelectionModel(), [alphaG])
    const fselG = fpG.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
    fselG.handler(fselG)
    await settle()
    dlgG.down('#restoreNewLocation').setValue(EXISTS)
    await settle()
    const submitG = dlgG.down('#restoreSubmit')
    submitG.handler(submitG)
    await settle()

    eq('confirm dance: exactly two attempts — refused, then confirmed', attempts.length, 2)
    eq('confirm dance: the first attempt carries NO confirm code',
      attempts[0] && attempts[0].confirmCode, undefined)
    eq('confirm dance: the first attempt asks for the existing directory',
      attempts[0] && attempts[0].body.target, { mode: 'newLocation', path: EXISTS })
    eq('confirm dance: the resend carries the daemon`s confirm code',
      attempts[1] && attempts[1].confirmCode, 'GT-CONFIRM-1')
    eq('confirm dance: the resend is the SAME body', attempts[1] && attempts[1].body,
      attempts[0] && attempts[0].body)
    ok('confirm dance: the operator saw the daemon`s own sentence in a Confirm',
      confirms.length === confirmsBefore + 1
      && confirms[confirmsBefore].msg.includes('overwrites files with the same names and keeps everything else'),
      confirms[confirmsBefore] && confirms[confirmsBefore].msg)
    ok('confirm dance: no sideBySide anywhere on the wire',
      !/sideBySide/.test(JSON.stringify(attempts)))
  }

  // Nothing may be sent without a selection.
  jobs.length = 0
  const dlg3 = openFileRestoreDialog(ANAS, { task: 'nightly-pictures', repo: 'pbs-main' })
  const submit3 = dlg3.down('#restoreSubmit')
  submit3.handler(submit3)
  await settle()
  ok('file restore: an empty dialog sends NOTHING', jobs.length === 0, `${jobs.length}`)

  ok('file restore: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  5d. backup2.6/2.9 — every restore door on the Backup screen opens the ONE
//      dialog, and the archive kind picks the half (files or LUN)
// ============================================================================

async function restoreDoorChecks() {
  const ANAS = loadRestoreSources()
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')

  // Door 1: the toolbar, always available — the point of the task-less door is
  // that there may be no task to select, and it shows the FULL source part.
  const toolbarDoor = grid.down('#backupRestoreRepo')
  ok('file restore: the Backup toolbar has "Restore from repository…"', !!toolbarDoor)
  ok('file restore: the task-less door needs no selection', toolbarDoor && !toolbarDoor.disabled)
  created.windows.length = 0
  toolbarDoor.handler(toolbarDoor)
  await settle()
  const repoDlg = openWindow()
  ok('file restore: the toolbar door opens the unified restore dialog',
    repoDlg && repoDlg.cls === 'anas-win-backup-restore')
  ok('file restore: the repository door asks for the repository, namespace and group',
    repoDlg && repoDlg.down('#restoreRepo').disabled === false
    && repoDlg.down('#restoreNs').disabled === false && repoDlg.down('#restoreGroup').disabled === false)
  ok('file restore: the task-less door has NO summary line (the source is the full part)',
    repoDlg && !repoDlg.down('#restoreSourceSummary'))
  // The group is a real choice, not a name to remember: the door exists because
  // the task that would have known it is gone.
  ok('file restore: the group combo was filled from the repository`s groups',
    repoDlg && repoDlg.down('#restoreGroup').getStore().getCount() > 0,
    `${repoDlg && repoDlg.down('#restoreGroup').getStore().getCount()}`)
  // …and with no group named, the point-in-time picker does not open on nothing.
  created.windows.length = 0
  repoDlg.down('#restoreGroup').setValue('')
  const emptySnap = repoDlg.down('#restoreSnapPick')
  emptySnap.handler(emptySnap)
  await settle()
  ok('file restore: no group means no empty point-in-time picker', created.windows.length === 0)

  // Door 2: the NEW grid "Restore…" button beside Run Now — selection-dependent,
  // and allowed for a DISABLED task (a disabled task keeps its restore path).
  const gridRestore = grid.down('#backupRestore')
  ok('file restore: the grid has a selection-dependent Restore… button', !!gridRestore)
  ok('file restore: it starts DISABLED with nothing selected', gridRestore.disabled === true)
  grid.selectRow(0)
  ok('file restore: it goes live once a task is selected', gridRestore.disabled === false)
  // A disabled task keeps its restore path — only Run Now/Edit/Delete are taken.
  grid.getStore().getAt(2).set('enabled', false)
  grid.selectRow(2)
  ok('file restore: it stays live for a DISABLED task', gridRestore.disabled === false)
  created.windows.length = 0
  gridRestore.handler(gridRestore)
  await settle()
  const gridDlg = openWindow()
  ok('file restore: the grid Restore… opens the unified dialog',
    gridDlg && gridDlg.cls === 'anas-win-backup-restore')
  const gridSummary = gridDlg && gridDlg.down('#restoreSourceSummary')
  ok('file restore: the grid door collapses the source to the summary line',
    gridSummary && (gridSummary.html || '').includes('From task'), gridSummary && gridSummary.html)

  // The BLOCK task door: one fixed `disk` image archive → the image half. When
  // the archive's `lun` record maps to a LIVE LUN on this node, This LUN is the
  // destination and the body is the in-place shape.
  created.windows.length = 0
  ANAS.backup.openRestoreDialog('harness', 'harness', { task: LIVE_BLOCK_TASK })
  await settle()
  const blockDlg = openWindow()
  ok('block restore: the block task door opened the unified dialog',
    blockDlg && blockDlg.cls === 'anas-win-backup-restore')
  const blockSummary = blockDlg && blockDlg.down('#restoreSourceSummary')
  ok('block restore: the summary names the task and its lun-<serial> group',
    /live-lun/.test(blockSummary.html || '') && new RegExp(LUN_GROUP).test(blockSummary.html || ''),
    blockSummary && blockSummary.html)
  ok('block restore: point-in-time is the first interactive field',
    blockDlg.down('#restoreSnapshot').disabled === false && blockDlg.down('#restoreRepo').disabled === true)
  const blockSnap = await pickFileSnapshot(blockDlg)
  ok('block restore: the shared picker listed the block group', !!blockSnap)
  // A block group holds exactly ONE restorable archive — it is pre-selected.
  eq('block restore: the single `disk.img` archive is pre-selected',
    blockDlg.down('#restoreArchive').getValue(), 'disk.img')
  ok('block restore: the image half appeared', blockDlg.down('#restoreImageWrap').hidden === false)
  ok('block restore: files half stays hidden', blockDlg.down('#restoreFilesWrap').hidden === true)
  ok('block restore: This LUN is available and defaulted (the lun record maps a live LUN)',
    blockDlg.down('#restoreDest').getValue(), { restoreDest: 'inPlace' })
  jobs.length = 0
  const blockSubmit = blockDlg.down('#restoreSubmit')
  blockSubmit.handler(blockSubmit)
  await settle()
  eq('block restore: the LUN body names the task group and the fixed disk archive',
    jobs.length && jobs[0].body, {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: `${LUN_GROUP}/2026-08-25T19:16:45Z`,
      archive: 'disk.img',
      lun: { targetIqn: ISCSI_IQN, index: 0 },
    })
  ok('block restore: the in-place body carries NO target key',
    jobs.length && jobs[0].body && !('target' in jobs[0].body), JSON.stringify((jobs[0] || {}).body))

  // The block task whose LUN record maps to NOTHING: only a new LUN is offered,
  // and the confirm-gated in-place destination is simply not there.
  created.windows.length = 0
  ANAS.backup.openRestoreDialog('harness', 'harness', { task: STRAY_LUN_TASK })
  await settle()
  const strayDlg = openWindow()
  await pickFileSnapshot(strayDlg)
  eq('block restore(stray): the single disk.img archive is pre-selected',
    strayDlg.down('#restoreArchive').getValue(), 'disk.img')
  ok('block restore(stray): This LUN is DISABLED — nothing on this node maps to it',
    strayDlg.down('#restoreDest').getValue(), { restoreDest: 'newLun' })
  const strayInPlace = strayDlg.down('#restoreDest').childCmps().find(k => k.inputValue === 'inPlace')
  ok('block restore(stray): the in-place radio is disabled', strayInPlace.disabled === true)
  // A new-LUN restore is the only destination, and it is a whole legal body.
  strayDlg.down('#newLunName').setValue('stray-new')
  strayDlg.down('#newLunPool').setValue('tank')
  await settle()
  jobs.length = 0
  const straySubmit = strayDlg.down('#restoreSubmit')
  straySubmit.handler(straySubmit)
  await settle()
  eq('block restore(stray): only a new-LUN body leaves the dialog',
    jobs.length && jobs[0].body, {
      kind: 'image',
      repo: 'pbs-main',
      snapshot: 'host/stray/2026-08-25T19:16:45Z',
      archive: 'disk.img',
      target: {
        mode: 'newLun',
        targetIqn: ISCSI_IQN,
        name: 'stray-new',
        backing: { kind: 'zvol', pool: 'tank' },
      },
    })
  ok('block restore(stray): a new-LUN body never carries the in-place lun key',
    jobs.length && jobs[0].body && !('lun' in jobs[0].body), JSON.stringify((jobs[0] || {}).body))

  // --- switching archive kind swaps the half AND clears the other's state ----
  // Same dialog, one mixed snapshot: pick a FILE, then switch to the image —
  // the file selections must fall, not ride along; switch back and the image
  // destination must re-default, not leak a `target`.
  const ANAS2 = loadRestoreSources()
  created.windows.length = 0
  const switchDlg = openFileRestoreDialog(ANAS2, {
    task: 'nightly-pictures',
    repo: 'pbs-main',
    ns: 'anas/pictures',
    homeByArchive: { data: '/mnt/pictures' },
  })
  await pickFileSnapshot(switchDlg)
  switchDlg.down('#restoreArchive').setValue('data.pxar')
  await settle()
  const switchFilesBtn = switchDlg.down('#restoreFilesPick')
  switchFilesBtn.handler(switchFilesBtn)
  await settle()
  const switchPicker = openWindow()
  const alphaS = switchPicker.down('#pickerTree').getStore().getRootNode().childNodes.find(n => n.get('name') === 'alpha.txt')
  switchPicker.down('#pickerTree').fireEvent('selectionchange', switchPicker.down('#pickerTree').getSelectionModel(), [alphaS])
  const switchSel = switchPicker.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  switchSel.handler(switchSel)
  await settle()
  switchDlg.down('#restoreTargetKind').setValue('inPlace')
  await settle()
  ok('kind switch: a file selection is present in the files half',
    (switchDlg.down('#restoreSelectionList').html || '').includes('alpha.txt'),
    switchDlg.down('#restoreSelectionList').html)

  // → the img archive. The files state drops; this task is files-only, so only
  // the new-LUN destination exists for the image.
  switchDlg.down('#restoreArchive').setValue('lun.img')
  await settle()
  ok('kind switch: the image half replaced the files half',
    switchDlg.down('#restoreImageWrap').hidden === false && switchDlg.down('#restoreFilesWrap').hidden === true)
  ok('kind switch: the file selections were dropped, never carried over',
    (switchDlg.down('#restoreSelectionList').html || '').includes('Nothing picked yet.'),
    switchDlg.down('#restoreSelectionList').html)
  eq('kind switch: a files-only task has no This LUN — only the new-LUN destination',
    switchDlg.down('#restoreDest').getValue(), { restoreDest: 'newLun' })

  // → back to the pxar archive. The image state drops; the files half re-appears
  // with the target re-defaulted (no stale target.mode).
  switchDlg.down('#restoreArchive').setValue('data.pxar')
  await settle()
  eq('kind switch: the files half returns somewhere-else, not the stale in-place choice',
    switchDlg.down('#restoreTargetKind').getValue(), { restoreTarget: 'newLocation' })
  ok('kind switch: an image-mode new-LUN verdict left no stale text',
    !(switchDlg.down('#newLunVerdict').html || '').length, switchDlg.down('#newLunVerdict').html)
  // No stale `selections` may ride a files body after the round trip — pick the
  // same entry fresh, name the (now default) destination, and the body is byte-clean.
  const switchFilesBtn2 = switchDlg.down('#restoreFilesPick')
  switchFilesBtn2.handler(switchFilesBtn2)
  await settle()
  const switchPicker2 = openWindow()
  const alphaS2 = switchPicker2.down('#pickerTree').getStore().getRootNode().childNodes.find(n => n.get('name') === 'alpha.txt')
  switchPicker2.down('#pickerTree').fireEvent('selectionchange', switchPicker2.down('#pickerTree').getSelectionModel(), [alphaS2])
  const switchSel2 = switchPicker2.buttonCmps.find(b => b.cls === 'anas-btn-picker-select')
  switchSel2.handler(switchSel2)
  await settle()
  switchDlg.down('#restoreNewLocation').setValue('/mnt/pictures/restore-roundtrip')
  await settle()
  jobs.length = 0
  const switchSubmit = switchDlg.down('#restoreSubmit')
  switchSubmit.handler(switchSubmit)
  await settle()
  ok('kind switch: the round-tripped files body is byte-clean',
    jobs.length && jobs[0].body, {
      kind: 'files',
      repo: 'pbs-main',
      snapshot: 'host/pictures/2026-08-25T19:16:45Z',
      archive: 'data.pxar',
      selections: ['/alpha.txt'],
      target: { mode: 'newLocation', path: '/mnt/pictures/restore-roundtrip' },
      options: {},
      ns: 'anas/pictures',
      task: 'nightly-pictures',
    })

  // Door 3: the task detail window — the same collapsed task door.
  grid.selectRow(0)
  created.windows.length = 0
  const detailsBtn = grid.down('#backupDetails')
  detailsBtn.handler(detailsBtn)
  await settle()
  const detail = openWindow()
  ok('file restore: the task detail window opened', detail && detail.cls === 'anas-win-backup-detail')
  const detailDoor = detail && detail.buttonCmps.find(b => b.itemId === 'backupDetailRestore')
  ok('file restore: the task detail has a Restore… button', !!detailDoor)
  ok('file restore: it went live once the detail loaded', detailDoor && detailDoor.disabled === false)
  created.windows.length = 0
  detailDoor.handler(detailDoor)
  await settle()
  const taskDlg = openWindow()
  ok('file restore: the task door opens the same dialog',
    taskDlg && taskDlg.cls === 'anas-win-backup-restore')
  ok('file restore: the task door collapses the source (fields behind a summary)',
    taskDlg && taskDlg.down('#restoreSourceSummary').hidden === false
    && taskDlg.down('#restoreRepo').disabled === true)
  eq('file restore: the task door carries the task`s repository',
    taskDlg && taskDlg.down('#restoreRepo').getValue(), 'pbs-main')

  ok('file restore: nothing warned in the doors', warnings.length === 0, warnings.join(' | '))
}
// ============================================================================
//  5e. backup2 fix-ups — the Details window loads the boundary scan
//      progressively (the detail GET is instant; preview-nested follows)
// ============================================================================

async function detailNestedScanChecks() {
  const ANAS = loadRestoreSources()
  // The preview-nested answer is DEFERRED: the window must paint its spinner
  // before the scan lands, so the check resolves (and later rejects) it by
  // hand. Everything else the detail flow asks for keeps the usual routes.
  let previewDeferred = null
  const basePost = ANAS.api.post
  ANAS.api.post = (node, path, body) => (path === '/backup/tasks/preview-nested'
    ? (nestedPreviews.push(body), new Promise((resolve, reject) => { previewDeferred = { resolve, reject } }))
    : basePost(node, path, body))

  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')

  grid.selectRow(0)
  created.windows.length = 0
  grid.down('#backupDetails').handler(grid.down('#backupDetails'))
  await settle()
  const detail = openWindow()
  ok('detail scan: the detail window opened', detail && detail.cls === 'anas-win-backup-detail')
  const body = detail && detail.down('#detailBody')

  // (a) The detail GET already rendered — WITHOUT the scan: the files rows show
  // their spinner, the rest of the detail is fully there.
  const html = body && body.html
  ok('detail scan: spinner while the scan is in flight',
    !!html && html.includes('Scanning for nested filesystems'), html && html.slice(0, 300))
  ok('detail scan: the spinner is the icon, not text alone', !!html && html.includes('fa-spin'))
  ok('detail scan: the rest of the detail rendered without the scan',
    !!html && html.includes('nightly-pictures') && html.includes('pbs-main'))

  // The request IS the task's own archives, index-aligned, only defined keys
  // (the `srv` archive never chose includeNested — the key must stay absent).
  const sent = nestedPreviews[nestedPreviews.length - 1]
  ok('detail scan: the preview request is the task`s archives',
    !!sent && Array.isArray(sent.archives) && sent.archives.length === 4 && sent.path === undefined,
    JSON.stringify(sent))
  ok('detail scan: only the keys the schema accepts ride the request',
    !!sent && sent.archives[0].name === 'pictures' && sent.archives[0].path === '/mnt/pictures'
    && sent.archives[0].includeNested === 'all'
    && sent.archives[2].path === '/srv' && sent.archives[2].includeNested === undefined
    && sent.archives[3].kind === 'img' && sent.archives[3].includeNested === undefined,
    JSON.stringify(sent && sent.archives))

  // (b) The scan lands: the nested lines render from it, the spinner is gone.
  previewDeferred.resolve(nestedPreviewResponse(sent))
  await settle()
  const html2 = body && body.html
  ok('detail scan: the scan`s boundaries render once it lands',
    !!html2 && html2.includes('/mnt/pictures/raw') && html2.includes('/etc/pve') && html2.includes('/srv/nfs'))
  ok('detail scan: the spinner is gone after the scan lands', !!html2 && !html2.includes('Scanning for nested filesystems'))
  ok('detail scan: included vs empty-directory is stated per boundary',
    !!html2 && html2.includes('included') && html2.includes('stored as an empty directory'))
  ok('detail scan: the derived consistency rides the same scan', !!html2 && html2.includes('snapshot'))
  // The last run's notice is findable HERE — the run's notes-only toast points
  // the operator to this window, so the pointer must land on something.
  ok('detail scan: the last run`s notes render muted on the detail',
    !!html2 && html2.includes('Notes: <ul>') && html2.includes(RUN_NOTICE))

  // (c) A preview that REFUSES (second window, second request): the rows say
  // "unavailable" and the rest of the detail stays exactly as it is.
  grid.selectRow(0)
  created.windows.length = 0
  grid.down('#backupDetails').handler(grid.down('#backupDetails'))
  await settle()
  const detail2 = openWindow()
  const body2 = detail2 && detail2.down('#detailBody')
  const sent2 = nestedPreviews[nestedPreviews.length - 1]
  ok('detail scan: a second open requests the scan again', !!sent2 && Array.isArray(sent2.archives))
  previewDeferred.reject(new Error('the scan could not run'))
  await settle()
  const html3 = body2 && body2.html
  ok('detail scan: a failed scan says unavailable on the archive rows',
    !!html3 && html3.includes('Nested-filesystem scan unavailable') && html3.includes('the scan could not run'))
  ok('detail scan: the rest of the detail survives a failed scan',
    !!html3 && html3.includes('nightly-pictures') && html3.includes('pbs-main'))
  ok('detail scan: the spinner is gone after a failure too', !!html3 && !html3.includes('Scanning for nested filesystems'))
  ok('detail scan: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// ============================================================================
//  5f. backup2 fix-ups — the run's completion: notices are INFORMATION,
//      never a second modal
// ============================================================================

async function runNotesChecks() {
  const ANAS = loadRestoreSources()
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()

  // (a) Warnings + notes: ONE alert, the notes riding inside it (muted, headed
  // "Notes") — a second modal for information is wrong.
  ANAS.backup.runTaskNow('harness', 'nightly-pictures', view)
  const run1 = jobs[jobs.length - 1]
  ok('run notes: the run posts the task`s own /run',
    !!run1 && run1.path === '/backup/tasks/nightly-pictures/run', run1 && run1.path)
  toasts.length = 0
  alerts.length = 0
  run1.onComplete({ result: { warnings: ['the retention prune did not run: ENOENT'], notices: [RUN_NOTICE] } })
  await settle()
  ok('run notes: warnings + notes is ONE alert', alerts.length === 1, `${alerts.length}`)
  ok('run notes: the alert keeps the warning title',
    alerts[0] && alerts[0].title === 'Backup finished with a warning', alerts[0] && alerts[0].title)
  ok('run notes: the warning line still rides it',
    alerts[0] && alerts[0].msg.includes('the retention prune did not run: ENOENT'))
  ok('run notes: the notes ride INSIDE it, headed Notes',
    alerts[0] && alerts[0].msg.includes('Notes') && alerts[0].msg.includes(RUN_NOTICE),
    alerts[0] && alerts[0].msg)

  // (b) Notes WITHOUT warnings: no modal at all — the toast counts them and
  // points at the task's Details (where they render).
  ANAS.backup.runTaskNow('harness', 'nightly-pictures', view)
  const run2 = jobs[jobs.length - 1]
  toasts.length = 0
  alerts.length = 0
  run2.onComplete({ result: { notices: [RUN_NOTICE, 'archive \'srv\': nested filesystem /srv/nfs (nfs) is NOT included - it is backed up as an empty directory'] } })
  await settle()
  ok('run notes: notes without warnings open NO modal', alerts.length === 0, `${alerts.length}`)
  ok('run notes: the toast counts the notes and points at the detail',
    toasts.length === 1 && toasts[0].includes('2 notes, see the task'), toasts.join(' | '))

  // (c) One note reads singular.
  ANAS.backup.runTaskNow('harness', 'nightly-pictures', view)
  const run3 = jobs[jobs.length - 1]
  toasts.length = 0
  alerts.length = 0
  run3.onComplete({ result: { notices: [RUN_NOTICE] } })
  await settle()
  ok('run notes: a single note reads singular',
    toasts.length === 1 && toasts[0].includes('1 note, see the task'), toasts.join(' | '))
  ok('run notes: nothing warned', warnings.length === 0, warnings.join(' | '))
}

await backupChecks()
warnings.length = 0
await nestedChecks()
warnings.length = 0
await consistencyChecks()
warnings.length = 0
await imageKindChecks()
warnings.length = 0
await lunPickerChecks()
warnings.length = 0
await backupTaskKindChecks()
warnings.length = 0
await poolImportChecks()
warnings.length = 0
await datasetsChecks()
for (const check of [
  iscsiGridChecks,
  iscsiNotInstalledChecks,
  iscsiCreateChecks,
  iscsiNodeIqnAbsentChecks,
  iscsiEditChecks,
  iscsiRowSurvivalChecks,
  iscsiLunChecks,
  iscsiResizeAndDeleteChecks,
  iscsiSessionGatingChecks,
  iscsiTargetDeleteChecks,
  iscsiForeignLunChecks,
  iscsiAddressFallbackChecks,
  iscsiRepairChecks,
  iscsiUnresolvedLunChecks,
  // Story iscsi.6 — the held-by-LUN gating on all four screens, the version-skew
  // absent case, and the iSCSI screen's backing-owner label + portal warning.
  heldByLunDatasetChecks,
  heldByLunAbsentFieldChecks,
  heldByLunPoolChecks,
  heldByLunAhrChecks,
  heldByLunMountChecks,
  iscsiBackingOwnerChecks,
  iscsiPortalWarningChecks,
  // Story backup2.7 — the whole-image restore's size gate and its refusals.
  iscsiRestoreGatingChecks,
  iscsiRestoreSessionAndUnresolvedChecks,
  // backup2.10 fix-up 2026-08-29 — the door stays open under a live session;
  // only the in-place destination is refused, with the door's own reason.
  iscsiRestoreLiveSessionDialogChecks,
  // …and the verdict is ONE helper the dialog applies to the LUN it resolves —
  // every door (task grid, task Details, repository) says it alike.
  restoreDoorsLiveSessionChecks,
  iscsiRestoreDialogChecks,
  iscsiRestoreVerdictChecks,
  iscsiRestoreSizeGateChecks,
  // Story backup2.10 — restore the image AS A NEW LUN (target/newLun), and
  // the daemon refusal + the finished identity on the result panel.
  iscsiRestoreNewLunChecks,
  iscsiRestoreRefusalAndResultChecks,
  // The LUN toolbar is backup-aware: the "Backed up by" badge, the Back up…
  // doors into the Backup menu's own run/edit/wizard, the body identity, the
  // fail-open, the gating — and the Add LUN growth note.
  lunBackupBadgeChecks,
  lunBackupMenuChecks,
  lunBackupFailOpenChecks,
  lunBackupGatingChecks,
  addLunGrowthNoteChecks,
]) {
  warnings.length = 0
  // `created.windows` is module-global; a dialog a previous section left open
  // would otherwise be what `openWindow()` hands back here.
  created.windows.length = 0
  await check()
}
warnings.length = 0
await pickerChecks()
warnings.length = 0
await pickedPathChecks()
warnings.length = 0
created.windows.length = 0
await restoreChecks()
warnings.length = 0
created.windows.length = 0
await restoreDoorChecks()
warnings.length = 0
created.windows.length = 0
await detailNestedScanChecks()
warnings.length = 0
await runNotesChecks()

if (failures.length) {
  console.error(`\n✖ ${failures.length} of ${checks} checks failed:\n`)
  for (const f of failures) { console.error(`  • ${f}`) }
  process.exit(1)
}
console.log(`✔ dialog contracts: ${checks} checks passed`)
