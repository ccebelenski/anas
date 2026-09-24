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
    // ExtJS's REAL findRecord: without the trailing args it is a
    // case-INSENSITIVE ANCHORED-PREFIX match (exactMatch=true lifts both).
    // Modeling the exact-match-only form would let a prefix collision
    // ('pbs' resolving to 'pbs-offsite', 'tank' to 'tank2') pass here and
    // misfire in the field — so the stub keeps Ext's semantics.
    findRecord(field, value, startIndex, anyMatch, caseSensitive, exactMatch) {
      const from = startIndex || 0
      const v = String(value === undefined || value === null ? '' : value)
      const rx = exactMatch ? null : new RegExp((anyMatch ? '' : '^')
        + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i')
      const eq = r => (exactMatch
        ? (caseSensitive ? r.get(field) === value : String(r.get(field)) === v)
        : rx.test(String(r.get(field))))
      return rows.slice(from).find(eq) || null
    },
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
    // 'panel[anasUsersView]' — an xtype with a property-PRESENCE selector
    // (the Share Users view looks itself up from its own toolbar buttons).
    const xattr = sel.match(/^([A-Za-z_$][\w$]*)\[([A-Za-z_$][\w$]*)\]$/)
    if (xattr) {
      const v = cmp[xattr[2]]
      return cmp.xtype === xattr[1] && v !== undefined && v !== null
    }
    // 'grid' is ExtJS's alias for gridpanel (the AHR toolbar's handlers walk
    // up('grid') from a tbar button to a gridpanel) — model the alias.
    if (sel.charAt(0) === '#') { return cmp.itemId === sel.slice(1) }
    return cmp.xtype === sel || (sel === 'grid' && cmp.xtype === 'gridpanel')
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
      // Real ExtJS takes ONE record, an index, or an ARRAY of records
      // (CheckboxModel preselect — selfheal.9); the stub models all three.
      const recs = (Array.isArray(what)
        ? what
        : [(typeof what === 'object' && what) ? what : (c.store ? c.store.getAt(what) : null)])
        .filter(r => r)
      c._selection = recs
      if (!suppressEvent) { c.fireEvent('selectionchange', {}, c._selection) }
      return recs[0] || null
    },
    getSelection: () => c._selection.slice(),
    deselectAll() { c._selection = [] },
  })
  c.ensureVisible = () => c
  /**
   * Tick SEVERAL rows (a checkboxmodel grid). Rows the grid's own `beforeselect`
   * vetoes never enter the selection — exactly what the checkbox does in a
   * browser, and the rule the repair action depends on (selfheal.6).
   */
  c.selectRows = function (idxs) {
    const veto = cfg && cfg.listeners && cfg.listeners.beforeselect
    c._selection = idxs
      .map(i => (c.store ? c.store.getAt(i) : null))
      .filter(rec => rec && (typeof veto !== 'function' || veto(c.getSelectionModel(), rec) !== false))
    c.fireEvent('selectionchange', {}, c._selection)
    return c._selection.slice()
  }
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
  // Ext.String.htmlEncode encodes — the identity stub would let a "renderer
  // present" check pass while raw markup still reached innerHTML.
  String: {
    htmlEncode: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  },
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
        // …and the poll budget: a long job left on the 15 s default fires
        // onComplete on a STILL-RUNNING job (the image restore's "finished").
        maxMs: cfg.maxMs,
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
    ok('backup: an ABSENT LUN name (older daemon) is the same unresolved state, never "undefined"',
      /no longer resolvable/i.test(lunCol.renderer(undefined, {}, { get: k => (k === 'kind' ? 'block' : undefined) }))
        && !/undefined/.test(lunCol.renderer(undefined, {}, { get: k => (k === 'kind' ? 'block' : undefined) })),
      lunCol.renderer(undefined, {}, { get: k => (k === 'kind' ? 'block' : undefined) }))
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
  // Raw store values never reach innerHTML: the LUN number and Name columns
  // encode like every other column here (a store value with markup in it is
  // attacker-shaped, but the rule costs nothing).
  {
    const idxCol = (lunGrid.columns || []).find(c => c.dataIndex === 'index')
    const nameCol = (lunGrid.columns || []).find(c => c.dataIndex === 'name')
    ok('picker: the LUN and Name columns encode, never pass raw markup',
      !!idxCol && typeof idxCol.renderer === 'function'
        && idxCol.renderer('<b>2</b>') === '&lt;b&gt;2&lt;/b&gt;'
        && !!nameCol && typeof nameCol.renderer === 'function'
        && nameCol.renderer('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;',
      `index=${idxCol && idxCol.renderer} name=${nameCol && nameCol.renderer}`)
  }

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
  // A whole-image restore runs for hours: the poll budget must be the long
  // one — the 15 s default fires onComplete on a STILL-RUNNING job, and the
  // result panel would say "finished" before the LUN exists.
  ok('restore(newLun): the image half polls for an hour, not the 15 s default',
    jobs.length && jobs[0].maxMs === 3600000, jobs.length && jobs[0].maxMs)

  // The exact-match rule: 'ahrpool' must resolve to the 'ahrpool' ROW, not to
  // whichever earlier row its name prefixes — ExtJS's default findRecord is a
  // case-insensitive PREFIX match, and the wrong row's source flag picks the
  // wrong backing key on submit.
  dlg.down('#filePicker').getStore().loadData([
    { name: 'ahrpool-snap', source: 'dataset' },
    { name: 'ahrpool', source: 'ahr' },
  ])
  dlg.down('#filePicker').setValue('ahrpool')
  await settle()
  jobs.length = 0
  submit.handler(submit)
  await settle()
  eq('restore(newLun): an exact name wins over a prefix sibling (the source flag)',
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

  // --- the poll budget expires with the job still going: the panel must say
  // STILL RUNNING — "finished" with no identity is exactly the old lie.
  const stillRunning = cfg => {
    jobs.push({ method: cfg.method, path: cfg.path })
    if (cfg.onSubmitted) { cfg.onSubmitted({}) }
    if (cfg.onComplete) { cfg.onComplete({ status: 'running', result: {} }) }
  }
  ANAS.confirmAndRun = stillRunning
  jobs.length = 0
  submit.handler(submit)
  await settle()
  ok('restore(result): an expired poll budget reads STILL RUNNING, never "finished"',
    /still running/i.test(dlg.down('#restoreResult').html || '')
      && !/finished/i.test(dlg.down('#restoreResult').html || ''),
    dlg.down('#restoreResult').html)

  // --- the job completes WITHOUT a newLun record: an honest absence, not a
  // generic "finished" that reads as if the LUN landed.
  const completedNoRecord = cfg => {
    jobs.push({ method: cfg.method, path: cfg.path })
    if (cfg.onComplete) { cfg.onComplete({ status: 'completed', result: {} }) }
  }
  ANAS.confirmAndRun = completedNoRecord
  jobs.length = 0
  submit.handler(submit)
  await settle()
  ok('restore(result): completed without a newLun record says the record is missing',
    /no new-LUN record/i.test(dlg.down('#restoreResult').html || ''),
    dlg.down('#restoreResult').html)

  // --- the restore completes: the new LUN's identity lands in the result panel
  const completed = cfg => {
    jobs.push({ method: cfg.method, path: cfg.path, body: cfg.body })
    if (cfg.onComplete) {
      cfg.onComplete({
        // pollJob always hands the job back WITH its status — the result
        // panel reads it to tell a finished job from an expired poll budget.
        status: 'completed',
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

// ============================================================================
//  0d. Remediation 0.3.1 (Waves 3+4) — the 68-backup regression sweep:
//      the nested-scan race (K5), the repo-door namespace prefill (K4), and
//      the task doors' onDone contract (U2, 68-half).
// ============================================================================

/**
 * K5 — two in-flight nested scans on ONE row can resolve out of order; the
 * last to RESOLVE must never paint #archNestedAlert for a path the row no
 * longer holds. The first scan's answer is PARKED here and released only
 * after the second has painted — the stale verdict must be dropped.
 */
async function nestedScanRaceCheck() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const parked = []
  const basePost = ANAS.api.post
  ANAS.api.post = (node, path, body) => (path === '/backup/tasks/preview-nested' && body && body.path === '/etc'
    ? (nestedPreviews.push(body), new Promise(resolve => { parked.push({ body, resolve }) }))
    : basePost(node, path, body))

  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')
  grid.selectRow(0)

  nestedPreviews.length = 0
  const dlg = await openEdit(grid)
  const rows = archiveRows(dlg)
  eq('scan race: the row holds /etc before the retype', rows[1].down('#archPath').getValue(), '/etc')
  ok('scan race: the open scan for /etc is parked', parked.length === 1, `${parked.length}`)

  // Retype the SAME row onto /srv: that scan resolves and paints. Only then
  // does the parked /etc answer land — out of order, exactly the field race.
  rows[1].down('#archPath').setValue('/srv')
  await settle()
  const alert = rows[1].down('#archNestedAlert')
  ok('scan race: the fresh /srv scan painted', /\/srv\/nfs/.test(alert.html || ''), alert && alert.html)

  for (const p of parked) { p.resolve(nestedPreviewResponse({ path: '/etc', includeNested: 'none' })) }
  await settle()
  ok('scan race: the stale /etc verdict is DROPPED — /srv still owns the alert',
    /\/srv\/nfs/.test(alert.html || '') && !/\/etc\/pve/.test(alert.html || ''),
    alert && alert.html)
}

/**
 * K4 — the repository door's namespace prefill must resolve the chosen repo
 * EXACTLY: ExtJS's default findRecord is a case-insensitive PREFIX match, so
 * 'pbs' resolved to 'pbs-offsite' (whichever sorts first) and prefilled the
 * WRONG repo's namespace — which then fails the namespace verify, or backs the
 * wrong groups list.
 */
async function restoreRepoNamespacePrefillCheck() {
  const routes = {
    ...ISCSI_ROUTES,
    'GET /backup/repos': {
      data: {
        version: 3,
        repos: [
          { name: 'pbs-offsite', host: 'pbs.example', port: 8007, datastore: 'off', authType: 'token', namespace: 'off-ns', credentialsSet: true, source: 'anas' },
          { name: 'pbs', host: 'pbs.example', port: 8007, datastore: 'main', authType: 'token', namespace: 'main-ns', credentialsSet: true, source: 'anas' },
        ],
      },
    },
    'GET /backup/repos/pbs/groups': { data: { verdict: 'ok', repository: 'pbs', groups: [] } },
    'GET /backup/repos/pbs-offsite/groups': { data: { verdict: 'ok', repository: 'pbs-offsite', groups: [] } },
  }
  const ANAS = loadSource('68-backup.js', routes)
  const view = makeComponent({ xtype: 'panel' }, null)
  ANAS.backupRestore.open(view, 'harness', { repo: 'pbs' })
  await settle()
  const dlg = openWindow()
  ok('ns prefill: the repository door opened with the prefill', !!dlg
    && dlg.cls === 'anas-win-backup-restore'
    && dlg.down('#restoreRepo').getValue() === 'pbs', dlg && dlg.down('#restoreRepo').getValue())
  eq('ns prefill: "pbs" resolves to the pbs ROW — its own namespace prefills',
    dlg && dlg.down('#restoreNs').getValue(), 'main-ns')
}

/**
 * U2 (68-half) — the wizard doors take a trailing onDone, fired ONCE after a
 * successful save (the iSCSI LUNs window re-reads its backup coverage with
 * it), and every existing caller keeps working without one.
 */
async function taskDoorOnDoneCheck() {
  const ANAS = loadSource('68-backup.js', BACKUP_ROUTES)
  const view = makeComponent(ANAS.views.backup.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.down('#backupGrid')

  // Edit door: the stored task round-trips untouched — Save → onDone, once.
  let done = 0
  ANAS.backup.openEditTask(view, 'harness', TASK, () => { done++ })
  await settle()
  const editDlg = openWindow()
  ok('onDone: the edit door opened the task wizard', !!editDlg && !!editDlg.down('#taskSubmitBtn'))
  if (editDlg) {
    editDlg.down('#taskSubmitBtn').handler(editDlg.down('#taskSubmitBtn'))
    await settle()
    eq('onDone: the edit door fires onDone exactly once after the save', done, 1)
  }

  // New door: same contract, a seeded archive so the form validates.
  done = 0
  ANAS.backup.openNewTask(view, 'harness', [{ name: 'etc', path: '/etc' }], null, () => { done++ })
  await settle()
  const newDlg = openWindow()
  ok('onDone: the new door opened the task wizard', !!newDlg && !!newDlg.down('#taskSubmitBtn'))
  if (newDlg) {
    newDlg.down('#name').setValue('on-done-task')
    newDlg.down('#schedule').setValue('daily')
    newDlg.down('#taskSubmitBtn').handler(newDlg.down('#taskSubmitBtn'))
    await settle()
    eq('onDone: the new door fires onDone exactly once after the save', done, 1)
  }
}

// ============================================================================
//  Scrubs: the AHR scrub's FINDINGS reach the row (story selfheal.3)
// ============================================================================
//
// A real scrub runs for hours — the Run now that started it stopped polling
// long before it finished — so the findings have to be recoverable afterwards.
// They are, from the daemon's own completed-job list, filtered in the view. The
// checks below hold that contract: both reads happen, the newest job per pool
// wins, everything that is not a completed AHR scrub WITH findings is ignored,
// the indicator is the one door to the one window, and a jobs list that cannot
// be read costs the indicator and nothing else.

const SCRUB_STATES = {
  data: [
    { target: { kind: 'zfs', pool: 'tank' }, enabled: true, cadence: 'monthly', mechanism: 'zfs-property', lastScrub: null, running: null },
    // selfheal.4 — the AHR periodic scrub is the node-level ANAS timer running
    // the WHOLE two-phase scrub: phases in the state, nextRun when on.
    { target: { kind: 'ahr', pool: 'ahr0' }, enabled: true, cadence: 'monthly', mechanism: 'anas-scrub-timer', nextRun: null, phases: ['md-parity', 'btrfs-checksums'], note: 'one node-level timer scrubs the enabled AHR pools sequentially (phase 1 md parity, then phase 2 btrfs checksums)', lastScrub: null, running: null },
    { target: { kind: 'ahr', pool: 'ahr1' }, enabled: false, cadence: 'quarterly', mechanism: 'anas-scrub-timer', nextRun: null, phases: ['md-parity', 'btrfs-checksums'], note: 'double parity check: mdcheck is on', lastScrub: null, running: null },
    // review cut-but-verified — ahr2's newest scrub was CLEAN (a later clean
    // pass displaces an older one's findings); its note is the LEGACY mdcheck
    // wording (review R8).
    { target: { kind: 'ahr', pool: 'ahr2' }, enabled: false, cadence: 'monthly', mechanism: 'anas-scrub-timer', nextRun: null, phases: ['md-parity', 'btrfs-checksums'], note: 'mdcheck is the only periodic parity check running (the pre-0.4 mdcheck timer) — it is adopted onto the anas-scrub timer at daemon start', lastScrub: null, running: null },
    // Design review 2026-09-14, D1/D8: ahr3's newest scrub counted parity
    // mismatches but named no file (parity-only rot); ahr4's newest scrub did
    // not check a whole band. Both must read on the row.
    { target: { kind: 'ahr', pool: 'ahr3' }, enabled: true, cadence: 'monthly', mechanism: 'anas-scrub-timer', nextRun: null, phases: ['md-parity', 'btrfs-checksums'], note: 'parity-only rot band', lastScrub: null, running: null },
    { target: { kind: 'ahr', pool: 'ahr4' }, enabled: true, cadence: 'monthly', mechanism: 'anas-scrub-timer', nextRun: null, phases: ['md-parity', 'btrfs-checksums'], note: 'a band md never checked', lastScrub: null, running: null },
    // selfheal.12 (GT-20): ahr5's newest scrub was CLEAN and its only signal
    // is the corrected-metadata count — the row must not read as a clean bill.
    { target: { kind: 'ahr', pool: 'ahr5' }, enabled: true, cadence: 'monthly', mechanism: 'anas-scrub-timer', nextRun: null, phases: ['md-parity', 'btrfs-checksums'], note: 'a clean scrub that corrected metadata', lastScrub: null, running: null },
  ],
}

const FINDING_A = {
  path: '/mnt/anas-ahr/ahr0/@data/movies/a very long name.mkv',
  subvolume: '@data',
  inode: 257,
  stripes: [{ logical: 14811136, offset: 1179648, length: 4096 }],
  badBlocks: [300],
}
const FINDING_B = {
  path: '/mnt/anas-ahr/ahr0/gone.bin',
  subvolume: '@data',
  inode: 258,
  stripes: [{ logical: 19005440, offset: 1179648, length: 4096 }],
  badBlocks: [],
  missing: true,
}
// A scrub covers the WHOLE filesystem, so a corrupt block inside a snapshot is
// a real finding with no path under the mountpoint — said as such, never as
// "deleted" and never as "0 bad blocks".
const FINDING_C = {
  path: '@snapshots/nightly/movies/a very long name.mkv',
  subvolume: '@snapshots/nightly',
  inode: 601,
  stripes: [{ logical: 22000000, offset: 65536, length: 4096 }],
  badBlocks: [],
  outsideMount: true,
}

function scrubJob(over) {
  return {
    id: over.id,
    status: 'completed',
    operation: 'ahr.scrub',
    progress: null,
    createdAt: over.at,
    createdBy: 'harness',
    startedAt: over.at,
    completedAt: over.at,
    result: over.result,
    error: null,
    ...over.extra,
  }
}

const SCRUB_JOBS = {
  data: [
    // The NEWEST job for ahr0 is not last in the list — the view must order by
    // time, not by position.
    scrubJob({
      id: 'j2',
      at: '2026-09-11T09:00:00.000Z',
      result: { scrubbed: 'ahr0', btrfsErrors: 'csum=3', checkedArrays: 3, findings: [FINDING_A, FINDING_B, FINDING_C], errorsReported: 3, errorsAttributed: 3, unattributed: 0, truncated: false },
    }),
    scrubJob({
      id: 'j1',
      at: '2026-09-10T09:00:00.000Z',
      result: { scrubbed: 'ahr0', btrfsErrors: 'csum=9', checkedArrays: 3, findings: [FINDING_A], errorsReported: 9, errorsAttributed: 1, unattributed: 0, truncated: false },
    }),
    // A FAILED scrub that still carries findings — never the row's answer.
    scrubJob({
      id: 'j3',
      at: '2026-09-11T10:00:00.000Z',
      result: { scrubbed: 'ahr0', btrfsErrors: 'csum=3', checkedArrays: 3, findings: [FINDING_A] },
      extra: { status: 'failed' },
    }),
    // Another operation whose result happens to look similar.
    scrubJob({
      id: 'j4',
      at: '2026-09-11T11:00:00.000Z',
      result: { scrubbed: 'ahr0', findings: [FINDING_A] },
      extra: { operation: 'ahr.create' },
    }),
    // ahr1's last scrub was CLEAN — an empty findings list is not a finding.
    scrubJob({
      id: 'j5',
      at: '2026-09-11T09:30:00.000Z',
      result: { scrubbed: 'ahr1', btrfsErrors: null, checkedArrays: 2, findings: [] },
    }),
    // ahr2: a scrub that FOUND something, then a LATER CLEAN one — the newest
    // job wins findings-or-not, so the clean pass clears the indicator
    // (review, cut-but-verified).
    scrubJob({
      id: 'j6',
      at: '2026-09-11T08:00:00.000Z',
      result: { scrubbed: 'ahr2', btrfsErrors: 'csum=2', checkedArrays: 2, findings: [FINDING_A], errorsReported: 2, errorsAttributed: 1, unattributed: 0, truncated: false },
    }),
    scrubJob({
      id: 'j7',
      at: '2026-09-11T12:00:00.000Z',
      result: { scrubbed: 'ahr2', btrfsErrors: null, checkedArrays: 2, findings: [] },
    }),
    // D1 — parity-only rot: md counted mismatches, the checksum scrub named
    // nothing. The result carries the record even with no findings.
    scrubJob({
      id: 'j8',
      at: '2026-09-12T08:00:00.000Z',
      result: {
        scrubbed: 'ahr3',
        btrfsErrors: null,
        checkedArrays: 2,
        bandsChecked: ['ahr3-r1', 'ahr3-r2'],
        parityMismatches: [{ band: 'ahr3-r1', bandIndex: 1, array: '/dev/md/ahr3-r1', mismatchCnt: 12 }],
        findings: [],
      },
    }),
    // D8 — a band md never checked is said, not counted as coverage.
    scrubJob({
      id: 'j9',
      at: '2026-09-12T09:00:00.000Z',
      result: {
        scrubbed: 'ahr4',
        btrfsErrors: null,
        checkedArrays: 1,
        bandsChecked: ['ahr4-r1'],
        bandsSkipped: [{ band: 'ahr4-r2', reason: 'md never started the check' }],
        findings: [],
      },
    }),
    // selfheal.12 — the GT-20 shape: a CLEAN scrub whose journal window
    // carried the kernel's corrected-metadata reads. No findings, no parity,
    // no skips — the count is the only thing the row has to say.
    scrubJob({
      id: 'j10',
      at: '2026-09-12T10:00:00.000Z',
      result: {
        scrubbed: 'ahr5',
        btrfsErrors: null,
        checkedArrays: 2,
        bandsChecked: ['ahr5-r1', 'ahr5-r2'],
        findings: [],
        metadataCorrected: { count: 2, devices: ['/dev/mapper/gtsh-data'] },
      },
    }),
  ],
}

const SCRUB_ROUTES = {
  'GET /scrub': SCRUB_STATES,
  'GET /jobs': SCRUB_JOBS,
}

function scrubCell(grid, rec) {
  const col = (grid.columns || []).find(c => c.dataIndex === 'lastScrub')
  return col && col.renderer ? col.renderer(rec.get('lastScrub'), {}, rec) : ''
}

function rowFor(grid, pool) {
  const idx = grid.getStore().findExact('pool', pool)
  return idx >= 0 ? grid.getStore().getAt(idx) : null
}

/** A click that landed ON the findings link, and one that did not. */
const onLink = { getTarget: sel => (sel === '.anas-scrub-findings-link' ? { dom: true } : null) }
/** A click on the parity indicator — the OTHER door in the same cell (selfheal.10). */
const onParityLink = { getTarget: sel => (sel === '.anas-scrub-parity-link' ? { dom: true } : null) }
const offLink = { getTarget: () => null }

async function scrubFindingsChecks() {
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], SCRUB_ROUTES)
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  ok('scrubs: the grid exists', !!grid)
  if (!grid) { return }
  view.fireEvent('afterrender', view)
  await settle()

  // --- The two reads ---------------------------------------------------------
  ok('scrubs: reads the uniform scrub state', apiGets.includes('/scrub'))
  ok('scrubs: reads the daemon\'s COMPLETED jobs for the findings (no new endpoint)',
    apiGets.includes('/jobs?status=completed'))

  // --- The indicator ---------------------------------------------------------
  const ahr0 = rowFor(grid, 'ahr0')
  const ahr1 = rowFor(grid, 'ahr1')
  const ahr2 = rowFor(grid, 'ahr2')
  const ahr3 = rowFor(grid, 'ahr3')
  const ahr4 = rowFor(grid, 'ahr4')
  const ahr5 = rowFor(grid, 'ahr5')
  const tank = rowFor(grid, 'tank')
  ok('scrubs: every pool is a row', !!ahr0 && !!ahr1 && !!ahr2 && !!ahr3 && !!ahr4 && !!ahr5 && !!tank)
  if (!ahr0 || !ahr1 || !ahr2 || !ahr3 || !ahr4 || !ahr5 || !tank) { return }

  const found = ahr0.get('findings')
  ok('scrubs: the AHR row carries its last scrub\'s findings', !!found)
  eq('scrubs: the NEWEST completed scrub wins', found && found.result.btrfsErrors, 'csum=3')
  eq('scrubs: …with all of its files', found && found.result.findings.length, 3)
  eq('scrubs: a CLEAN last scrub is not a finding', ahr1.get('findings'), null)
  eq('scrubs: a ZFS row never carries AHR findings', tank.get('findings'), null)
  // review cut-but-verified — the NEWEST completed scrub wins, findings or
  // not: a later clean pass displaces an older one's stale findings.
  eq('scrubs: a LATER clean scrub clears an older one\'s findings', ahr2.get('findings'), null)
  ok('scrubs: …and that row falls back to the honest md-keeps-no-record line',
    /md keeps no completion record/.test(scrubCell(grid, ahr2)), scrubCell(grid, ahr2))

  // D1 — parity-only rot reads on the row, amber, with the explanation as the
  // tooltip; the checksum scrub named nothing, so there is no findings link.
  const parityCell = scrubCell(grid, ahr3)
  ok('scrubs: a parity-only rot row shows the amber parity indicator',
    /parity mismatch on ahr3-r1 \(12\)/.test(parityCell), parityCell)
  ok('scrubs: …the parity indicator carries the full explanation as its tooltip',
    /PARITY \(or Q\) member/.test(parityCell) && /reconstruct from the wrong parity/.test(parityCell), parityCell)
  // selfheal.10 — the indicator is also the DOOR to the Rewrite parity verb.
  ok('scrubs: …and it is a link, not just a statement',
    /anas-scrub-parity-link/.test(parityCell), parityCell)
  ok('scrubs: …whose tooltip names the verb rather than sending the operator to the notification',
    /Click to rewrite that band's parity/.test(parityCell), parityCell)
  ok('scrubs: …and a parity-only scrub names no file, so there is no findings link',
    !/anas-scrub-findings-link/.test(parityCell), parityCell)

  // D8 — a band the scrub did not check is said on the row, muted, count first.
  const skippedCell = scrubCell(grid, ahr4)
  ok('scrubs: a scrub that skipped a band says how many, labelled',
    /1 band not checked/.test(skippedCell), skippedCell)
  ok('scrubs: …with the band and the why as the tooltip',
    /ahr4-r2: md never started the check/.test(skippedCell), skippedCell)
  ok('scrubs: …and no findings link when nothing was named',
    !/anas-scrub-findings-link/.test(skippedCell), skippedCell)

  // selfheal.12 — the corrected-metadata count rides the row too, amber, on
  // the newest completed scrub — and a CLEAN scrub whose only signal is this
  // count still reads here, never as "md keeps no record" (GT-20).
  eq('scrubs: the corrected-metadata count rides the newest completed scrub',
    ahr5.get('metadataCorrected') && ahr5.get('metadataCorrected').count, 2)
  const correctedCell = scrubCell(grid, ahr5)
  ok('scrubs: a corrected-metadata count shows on the row, labelled',
    /2 metadata reads corrected/.test(correctedCell), correctedCell)
  ok('scrubs: …with what happened, what it means and what to do as the tooltip',
    /btrfs corrected 2 metadata read\(s\) from the mirror copy/.test(correctedCell)
    && /Check that disk's SMART data in Disks/.test(correctedCell), correctedCell)
  ok('scrubs: …and a count-only scrub names no file, so there is no findings link',
    !/anas-scrub-findings-link/.test(correctedCell), correctedCell)
  ok('scrubs: …and it still says the record is the last completed scrub since the daemon started',
    /last completed scrub since the daemon started/.test(correctedCell), correctedCell)

  const cell = scrubCell(grid, ahr0)
  ok('scrubs: the row says how many files, labelled', /3 files with checksum errors/.test(cell), cell)
  ok('scrubs: …and says the list is only what the daemon still holds',
    /last completed scrub since the daemon started/.test(cell), cell)
  ok('scrubs: the indicator is the door (carries the link class)',
    /anas-scrub-findings-link/.test(cell), cell)
  const cleanCell = scrubCell(grid, ahr1)
  ok('scrubs: an AHR row with nothing found keeps the md-keeps-no-record line',
    /md keeps no completion record/.test(cleanCell) && !/anas-scrub-findings-link/.test(cleanCell), cleanCell)

  // A pass in flight still OUTRANKS the findings: it is what is true now.
  ahr0.set('running', { percent: 12.5 })
  ok('scrubs: a running pass outranks the findings cell',
    !/anas-scrub-findings-link/.test(scrubCell(grid, ahr0)))
  ahr0.set('running', null)

  // --- The one window --------------------------------------------------------
  created.windows.length = 0
  grid.fireEvent('itemclick', grid, ahr0, null, 0, offLink)
  await settle()
  eq('scrubs: a click OFF the indicator opens nothing', created.windows.length, 0)

  grid.fireEvent('itemclick', grid, tank, null, 0, onLink)
  await settle()
  eq('scrubs: a row with no findings opens nothing', created.windows.length, 0)

  grid.fireEvent('itemclick', grid, ahr0, null, 0, onLink)
  await settle()
  const win = openWindow()
  ok('scrubs: the indicator opens the findings window', !!win && win.cls === 'anas-win-scrub-findings')
  if (!win) { return }
  const fGrid = findCmp(win, 'anas-grid-scrub-findings')
  ok('scrubs: the window lists the files', !!fGrid)
  if (!fGrid) { return }
  eq('scrubs: one row per finding', fGrid.store.getCount(), 3)
  eq('scrubs: the path is carried in FULL (never truncated)',
    fGrid.store.getAt(0).get('path'), FINDING_A.path)
  eq('scrubs: the bad-block count rides the row', fGrid.store.getAt(0).get('blocks'), 1)
  ok('scrubs: a deleted file is marked missing, not 0 bad blocks',
    fGrid.store.getAt(1).get('missing') === true)
  // The three-way cell: a count, "deleted", and "in a snapshot" — never a 0
  // that would read as "nothing wrong with it".
  const blocksCol = (fGrid.columns || []).find(c => c.dataIndex === 'blocks')
  const cellFor = i => blocksCol.renderer(null, {}, fGrid.store.getAt(i))
  ok('scrubs: a probed file shows its bad-block count', /1/.test(cellFor(0)), cellFor(0))
  ok('scrubs: a deleted file says so', /deleted since the scrub/.test(cellFor(1)), cellFor(1))
  ok('scrubs: a snapshot finding says it is outside the mounted tree',
    /in a snapshot, outside the mounted tree/.test(cellFor(2)), cellFor(2))
  eq('scrubs: …and carries its filesystem-relative path in full',
    fGrid.store.getAt(2).get('path'), FINDING_C.path)
  const head = (win.items.getAt(0) || {}).html || ''
  ok('scrubs: the window states reported vs attributed', /3 of 3 reported/.test(head), head)

  // --- Fail-open -------------------------------------------------------------
  const NO_JOBS = { 'GET /scrub': SCRUB_STATES }
  const ANAS2 = loadSource(['69-schedules-common.js', '69-scrubs.js'], NO_JOBS)
  const view2 = makeComponent(ANAS2.views.scrubs.factory('harness'), null)
  const grid2 = view2.down('#scrubGrid')
  view2.fireEvent('afterrender', view2)
  await settle()
  eq('scrubs: an unreadable job list still renders every row', grid2.getStore().getCount(), SCRUB_STATES.data.length)
  eq('scrubs: …and simply has no findings to show', rowFor(grid2, 'ahr0').get('findings'), null)
}

// Fourth pass — T7's mark is RENDERED, not just carried: a finding whose probe
// ran without the mapping searched an unverified window, and the bad-block cell
// says so beside the count, muted, with the reason as tooltip. A finding with
// blocks found used to read as a complete account of the file.
const FINDING_UV = {
  path: '/mnt/anas-ahr/ahr0/db/written.bin',
  subvolume: '@data',
  inode: 403,
  stripes: [{ logical: 31000000, offset: 0, length: 4096 }],
  badBlocks: [7],
  probedUnverified: true,
  reason: 'extent could not be resolved (btrfs dump-tree: no extent tree root)',
}

async function scrubUnverifiedWindowCheck() {
  const UV_JOBS = {
    data: [scrubJob({
      id: 'juv',
      at: '2026-09-12T09:00:00.000Z',
      result: { scrubbed: 'ahr0', btrfsErrors: 'csum=1', checkedArrays: 2, findings: [FINDING_UV], errorsReported: 1, errorsAttributed: 1, unattributed: 0, truncated: false },
    })],
  }
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': UV_JOBS })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()

  const ahr0 = rowFor(grid, 'ahr0')
  ok('scrubs: the unverified-window scrub is the row\'s last completed one', !!ahr0 && !!ahr0.get('findings'))
  if (!ahr0) { return }
  created.windows.length = 0
  grid.fireEvent('itemclick', grid, ahr0, null, 0, onLink)
  await settle()
  const win = openWindow()
  ok('scrubs: the finding opens the findings window', !!win && win.cls === 'anas-win-scrub-findings')
  if (!win) { return }
  const fGrid = findCmp(win, 'anas-grid-scrub-findings')
  ok('scrubs: the unverified-window finding reaches the row', !!fGrid && fGrid.store.getAt(0).get('probedUnverified') === true)
  if (!fGrid) { return }
  const blocksCol = (fGrid.columns || []).find(c => c.dataIndex === 'blocks')
  const cell = blocksCol.renderer(null, {}, fGrid.store.getAt(0))
  ok('scrubs: the bad-block count is still shown', />1</.test(cell), cell)
  ok('scrubs: the unverified-window suffix rides the count, muted',
    /\(search window unverified\)/.test(cell) && /var\(--anas-muted/.test(cell), cell)
  ok('scrubs: the reason rides the suffix as the tooltip',
    /title="[^"]*extent could not be resolved/.test(cell), cell)
}

// Design review 2026-09-14, D1 — the findings WINDOW says the parity story too:
// when the newest scrub's result carries parityMismatches, the window's head
// gains one line naming the bands and pointing at the PVE notification.
async function scrubParityWindowCheck() {
  const PARITY_JOBS = {
    data: [scrubJob({
      id: 'jpar',
      at: '2026-09-12T10:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: 'csum=2',
        checkedArrays: 2,
        bandsChecked: ['ahr0-r1', 'ahr0-r2'],
        parityMismatches: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 4 }],
        findings: [FINDING_A],
        errorsReported: 2,
        errorsAttributed: 1,
        unattributed: 0,
        truncated: false,
      },
    })],
  }
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': PARITY_JOBS })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  const ahr0 = rowFor(grid, 'ahr0')
  created.windows.length = 0
  grid.fireEvent('itemclick', grid, ahr0, null, 0, onLink)
  await settle()
  const win = openWindow()
  if (!win) { ok('scrubs: the parity window opens', false); return }
  const head = (win.items.getAt(0) || {}).html || ''
  ok('scrubs: the findings window names the parity-mismatch bands',
    /md counted parity mismatches on ahr0-r1/.test(head), head)
  ok('scrubs: …and points at the notification for the explanation',
    /PVE notification/.test(head), head)
}

// Story selfheal.10 — the Rewrite parity ACTION, behind the parity indicator.
//
// The narrow case is the whole feature: md counted mismatches on a band AND
// the same scrub named no corrupt file. Anything else and `mdadm
// --action=repair` would bless whatever the data says, so the verb is greyed
// with the reason rather than hidden.
async function rewriteParityChecks() {
  // ahr3 is the parity-only row (j8): mismatches on r1, no findings.
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': SCRUB_JOBS })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  created.windows.length = 0

  // --- the door: the parity indicator, not the findings one -----------------
  grid.fireEvent('itemclick', grid, rowFor(grid, 'ahr3'), null, 0, onParityLink)
  await settle()
  const win = openWindow()
  ok('rewrite: the parity indicator opens the parity window', !!win && win.cls === 'anas-win-scrub-parity')
  if (!win) { return }

  const pGrid = win.down('#parityGrid')
  const btn = win.down('#rewriteParity')
  ok('rewrite: the window lists the bands md counted mismatches on', !!pGrid && pGrid.getStore().getCount() === 1)
  ok('rewrite: …with the band label, its md array and the count',
    !!pGrid && pGrid.getStore().getAt(0).get('band') === 'ahr3-r1'
      && pGrid.getStore().getAt(0).get('array') === '/dev/md/ahr3-r1'
      && pGrid.getStore().getAt(0).get('mismatchCnt') === 12)
  ok('rewrite: …and the band NUMBER the request names, carried not parsed',
    !!pGrid && pGrid.getStore().getAt(0).get('bandIndex') === 1)
  ok('rewrite: the head says the data is right and the parity is what is wrong',
    /the data is right, and the parity is what is wrong/.test((win.items.getAt(0) || {}).html || ''),
    (win.items.getAt(0) || {}).html)

  // --- enablement -----------------------------------------------------------
  ok('rewrite: the verb is dark until a band is picked', !!btn && btn.disabled === true)
  ok('rewrite: …and says so', /select the band to rewrite/.test(btn.tooltip || ''), btn.tooltip)
  pGrid.selectRows([0])
  await settle()
  ok('rewrite: one band ticked lights the verb', btn.disabled === false)

  // --- the confirm-gated request -------------------------------------------
  let sent = null
  ANAS.confirmAndRun = (cfg) => { sent = cfg }
  btn.handler(btn)
  await settle()
  ok('rewrite: the verb goes through the confirm-code door', !!sent)
  if (!sent) { return }
  ok('rewrite: …to the pool\'s own parity-rewrite endpoint', sent.path === '/ahr/ahr3/parity-rewrite')
  ok('rewrite: …as a POST', sent.method === 'post')
  ok('rewrite: the body names ONE band, as a number', JSON.stringify(sent.body) === '{"band":1}')
  ok('rewrite: the confirm names the band and md\'s own count',
    /band r1/.test(sent.confirmIntro || '') && /12 mismatch\(es\) there/.test(sent.confirmIntro || ''), sent.confirmIntro)
  ok('rewrite: the poll budget is raised past the default (three md passes over a band)',
    Number(sent.maxMs) > 15000, sent.maxMs)
  ok('rewrite: the poll rides the window, not a component that closes', sent.view === win)

  // --- the result, in the same window --------------------------------------
  const panel = win.down('#parityResult')
  ok('rewrite: the result panel is hidden until there is a result', !!panel && panel.hidden === true)
  sent.onComplete({
    id: 'pj1',
    status: 'completed',
    operation: 'ahr.parity-rewrite',
    result: {
      pool: 'ahr3',
      band: 1,
      array: '/dev/md/ahr3-r1',
      mismatchBefore: 12,
      mismatchAfter: 0,
      outcome: 'rewritten',
      durations: { scrubMs: 1000, repairMs: 2000, checkMs: 3000, totalMs: 6000 },
    },
  })
  await settle()
  ok('rewrite: the result appears in the window the request was made from', panel.hidden === false)
  ok('rewrite: the before and after counts are both said',
    /mismatches before 12/.test(panel.html) && /after 0/.test(panel.html), panel.html)
  ok('rewrite: …and the outcome by name', /outcome rewritten/.test(panel.html), panel.html)
  ok('rewrite: a rewritten band says the check afterwards counted 0',
    /counted 0/.test(panel.html), panel.html)

  // still-mismatched is NOT a success — say it plainly.
  sent.onComplete({
    id: 'pj2',
    status: 'completed',
    operation: 'ahr.parity-rewrite',
    result: {
      pool: 'ahr3',
      band: 1,
      array: '/dev/md/ahr3-r1',
      mismatchBefore: 12,
      mismatchAfter: 4,
      outcome: 'still-mismatched',
      reason: 'the verifying check still counted 4 mismatch(es)',
      durations: { scrubMs: 1, repairMs: 1, checkMs: 1, totalMs: 3 },
    },
  })
  await settle()
  ok('rewrite: a still-mismatched run refuses to read as healthy',
    /is not proven good/.test(panel.html) && /Do not treat this band as healthy/.test(panel.html), panel.html)
  ok('rewrite: …and carries the run\'s own sentence', /still counted 4 mismatch/.test(panel.html), panel.html)

  // A refusal on the fresh scrub names what it found instead of writing.
  sent.onComplete({
    id: 'pj3',
    status: 'completed',
    operation: 'ahr.parity-rewrite',
    result: {
      pool: 'ahr3',
      band: 1,
      array: '/dev/md/ahr3-r1',
      mismatchBefore: 12,
      mismatchAfter: null,
      outcome: 'refused',
      reason: 'the fresh checksum scrub found data corruption — nothing was written',
      reasonCode: 'data-corruption-found',
      btrfsErrors: 'csum=3',
      durations: { scrubMs: 1, repairMs: 0, checkMs: 0, totalMs: 1 },
    },
  })
  await settle()
  ok('rewrite: an unknown after-count is said as unknown, never as 0',
    /after unknown/.test(panel.html), panel.html)
  ok('rewrite: a refusal on the fresh scrub names the errors and says nothing was written',
    /found errors and nothing was written to md/.test(panel.html) && /csum=3/.test(panel.html), panel.html)

  // --- a job still running claims no result --------------------------------
  sent.onComplete({ id: 'pj4', status: 'running' })
  await settle()
  ok('rewrite: a job still running claims no result', /still running/.test(panel.html), panel.html)
  ok('rewrite: …and says where the answer will arrive', /notification/.test(panel.html), panel.html)
}

// Story selfheal.10 — the verb is REFUSED when the same scrub named corrupt
// files: md repair would recompute parity from that rot and make it permanent.
// The door still opens (the mismatch is a real fact the operator must see);
// the button is dark with the reason on it.
async function rewriteParityRefusedChecks() {
  const MIXED = {
    data: [scrubJob({
      id: 'jmix',
      at: '2026-09-12T11:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: 'csum=2',
        checkedArrays: 2,
        bandsChecked: ['ahr0-r1', 'ahr0-r2'],
        parityMismatches: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 4 }],
        findings: [FINDING_A],
        errorsReported: 2,
        errorsAttributed: 1,
        unattributed: 0,
        truncated: false,
      },
    })],
  }
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': MIXED })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  created.windows.length = 0
  grid.fireEvent('itemclick', grid, rowFor(grid, 'ahr0'), null, 0, onParityLink)
  await settle()
  const win = openWindow()
  ok('rewrite: the parity door opens even when files are also corrupt',
    !!win && win.cls === 'anas-win-scrub-parity')
  if (!win) { return }
  const pGrid = win.down('#parityGrid')
  const btn = win.down('#rewriteParity')
  pGrid.selectRows([0])
  await settle()
  ok('rewrite: …but the verb stays dark with a band ticked', btn.disabled === true)
  ok('rewrite: …and the reason is the one the daemon would 409 with',
    /Repair those from parity first/.test(btn.tooltip || '')
      && /make the rot permanent/.test(btn.tooltip || ''), btn.tooltip)
  ok('rewrite: the head says the same thing, before the operator reaches the button',
    /Repair those from parity first/.test((win.items.getAt(0) || {}).html || ''),
    (win.items.getAt(0) || {}).html)

  // Clicking it anyway does nothing — the gate is not only cosmetic.
  let sent = null
  ANAS.confirmAndRun = (cfg) => { sent = cfg }
  btn.handler(btn)
  await settle()
  ok('rewrite: the handler itself refuses, not just the disabled state', sent === null)
}

// Sixth pass, N1 — a RAID1 band has NO parity to rewrite. md's `repair` on a
// mirror copies the first in-sync leg over the others without arbitrating, so
// on a band whose legs disagree it overwrites the good copy half the time. The
// daemon refuses it outright (409 `not-a-parity-band`); the UI says so first,
// and never offers the verb.
async function rewriteParityMirrorChecks() {
  const MIRROR = {
    data: [scrubJob({
      id: 'jmir',
      at: '2026-09-12T12:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: null,
        checkedArrays: 2,
        bandsChecked: ['ahr0-r1', 'ahr0-r2'],
        parityMismatches: [{ band: 'ahr0-r2', bandIndex: 2, array: '/dev/md/ahr0-r2', mismatchCnt: 6, level: 'raid1' }],
      },
    })],
  }
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': MIRROR })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  created.windows.length = 0

  // The row's indicator must not promise the PARITY verb here.
  const cell = scrubCell(grid, rowFor(grid, 'ahr0'));
  ok('rewrite: a mirror-only mismatch row does NOT offer "click to rewrite"',
    !/Click to rewrite/.test(cell), cell)
  // Story selfheal.11 — the tooltip still must NOT name Repair from parity
  // (that verb needs a finding with named blocks, and phase 2 named none). What
  // it names is the verb that DOES apply to a mirror band, and what the
  // operator must not do instead.
  ok('rewrite: …it says there is no parity to rewrite, and points at the mirror verb',
    /no parity to rewrite/.test(cell)
      && /Click to reconcile the mirror/.test(cell)
      && /do not run md repair on a mirror/.test(cell)
      && !/Repair from parity/.test(cell), cell)

  grid.fireEvent('itemclick', grid, rowFor(grid, 'ahr0'), null, 0, onParityLink)
  await settle()
  const win = openWindow()
  ok('rewrite: the mirror row still opens the detail window', !!win && win.cls === 'anas-win-scrub-parity')
  if (!win) { return }
  ok('rewrite: the head does not claim the parity member is wrong on a mirror band',
    !/the parity is what is wrong/.test((win.items.getAt(0) || {}).html || '')
      && /RAID1 mirror bands/.test((win.items.getAt(0) || {}).html || ''),
    (win.items.getAt(0) || {}).html)
  // selfheal.11 — the head explains the two arms, in the order they run, and
  // still names no verb the operator cannot reach.
  ok('rewrite: …and the head explains the reconcile\'s two arms',
    /re-runs the ordinary checksum scrub/.test((win.items.getAt(0) || {}).html || '')
      && /reads BOTH legs in full/.test((win.items.getAt(0) || {}).html || '')
      && /Rows with no checksum/.test((win.items.getAt(0) || {}).html || '')
      && !/Repair from parity/.test((win.items.getAt(0) || {}).html || ''),
    (win.items.getAt(0) || {}).html)

  const pGrid = win.down('#parityGrid')
  const btn = win.down('#rewriteParity')
  ok('rewrite: the band\'s LEVEL rides the row', pGrid.getStore().getAt(0).get('level') === 'raid1')
  pGrid.selectRows([0])
  await settle()
  ok('rewrite: a ticked mirror band leaves the PARITY verb dark', btn.disabled === true)
  ok('rewrite: …with the reason the daemon would 409 with, and the verb that does apply',
    /no parity to rewrite/.test(btn.tooltip || '')
      && /Use Reconcile mirror for this band/.test(btn.tooltip || '')
      && !/Repair from parity/.test(btn.tooltip || ''), btn.tooltip)

  let sent = null
  ANAS.confirmAndRun = (cfg) => { sent = cfg }
  btn.handler(btn)
  await settle()
  ok('rewrite: and the handler refuses it too — nothing is submitted for a mirror band', sent === null)
}

// Story selfheal.11 — Reconcile mirror, the OTHER verb in the parity window.
//
// The R9 root's mismatch: md counted disagreeing LEGS and the checksum pass
// named no file, so one leg holds something btrfs has never been asked to read.
// The verb is need-gated the same way Rewrite parity is, in the same window, and
// the two are mutually exclusive by the band's level.
async function mirrorReconcileChecks() {
  const MIRROR = {
    data: [scrubJob({
      id: 'jmir2',
      at: '2026-09-12T12:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: null,
        checkedArrays: 2,
        bandsChecked: ['ahr0-r1', 'ahr0-r2'],
        parityMismatches: [{ band: 'ahr0-r2', bandIndex: 2, array: '/dev/md/ahr0-r2', mismatchCnt: 128, level: 'raid1' }],
      },
    })],
  }
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': MIRROR })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  created.windows.length = 0

  grid.fireEvent('itemclick', grid, rowFor(grid, 'ahr0'), null, 0, onParityLink)
  await settle()
  const win = openWindow()
  ok('mirror: the parity indicator opens the window that holds both verbs',
    !!win && win.cls === 'anas-win-scrub-parity')
  if (!win) { return }

  const pGrid = win.down('#parityGrid')
  const btn = win.down('#reconcileMirror')
  ok('mirror: the window carries a Reconcile mirror button', !!btn && btn.cls === 'anas-btn-mirror-reconcile')
  if (!btn) { return }
  ok('mirror: the verb is dark until a band is picked', btn.disabled === true)
  ok('mirror: …and says so', /select the band to reconcile/.test(btn.tooltip || ''), btn.tooltip)
  pGrid.selectRows([0])
  await settle()
  ok('mirror: one ticked RAID1 band lights the verb', btn.disabled === false)

  // --- the confirm-gated request -------------------------------------------
  let sent = null
  ANAS.confirmAndRun = (cfg) => { sent = cfg }
  btn.handler(btn)
  await settle()
  ok('mirror: the verb goes through the confirm-code door', !!sent)
  if (!sent) { return }
  ok('mirror: …to the pool\'s own mirror-reconcile endpoint', sent.path === '/ahr/ahr0/mirror-reconcile')
  ok('mirror: …as a POST', sent.method === 'post')
  ok('mirror: the body names ONE band, as a number', JSON.stringify(sent.body) === '{"band":2}')
  ok('mirror: the confirm names the band and md\'s own count',
    /band r2/.test(sent.confirmIntro || '') && /128 disagreeing unit\(s\) there/.test(sent.confirmIntro || ''),
    sent.confirmIntro)
  ok('mirror: the poll budget is raised past the default (scrubs, checks, then both legs)',
    Number(sent.maxMs) > 15000, sent.maxMs)
  ok('mirror: the poll rides the window, not a component that closes', sent.view === win)

  // --- arm A's result, in the same window ----------------------------------
  const panel = win.down('#parityResult')
  ok('mirror: the result panel is hidden until there is a result', !!panel && panel.hidden === true)
  sent.onComplete({
    id: 'mj1',
    status: 'completed',
    operation: 'ahr.mirror-reconcile',
    result: {
      pool: 'ahr0',
      band: 2,
      array: '/dev/md/ahr0-r2',
      arm: 'scrub',
      passes: [{ corrected: 1, mismatchAfter: 0 }],
      rowsCompared: 0,
      rowsDiffering: 0,
      rowsWritten: { leg0: 0, leg1: 0 },
      freeSpaceRows: 0,
      uncheckedRows: 0,
      unresolvedRows: 0,
      mismatchBefore: 128,
      mismatchAfter: 0,
      outcome: 'reconciled',
      durations: { scrubMs: 1000, compareMs: 0, checkMs: 500, totalMs: 1500 },
    },
  })
  await settle()
  ok('mirror: the result appears in the window the request was made from', panel.hidden === false)
  ok('mirror: the before and after counts are both said',
    /mismatches before 128/.test(panel.html) && /after 0/.test(panel.html), panel.html)
  ok('mirror: the ARM that answered is named — arm A is the ordinary scrub healing it',
    /Arm A \(scrub until clean\)/.test(panel.html) && /1 btrfs scrub pass/.test(panel.html), panel.html)
  ok('mirror: a reconciled band says the verifying check counted 0',
    /The legs agree again/.test(panel.html) && /counted 0/.test(panel.html), panel.html)

  // --- arm B's result: rows arbitrated one by one --------------------------
  sent.onComplete({
    id: 'mj2',
    status: 'completed',
    operation: 'ahr.mirror-reconcile',
    result: {
      pool: 'ahr0',
      band: 2,
      array: '/dev/md/ahr0-r2',
      arm: 'compare',
      passes: [{ corrected: 0, mismatchAfter: 128 }],
      rowsCompared: 51200,
      rowsDiffering: 1,
      rowsWritten: { leg0: 0, leg1: 1 },
      freeSpaceRows: 0,
      uncheckedRows: 0,
      unresolvedRows: 0,
      mismatchBefore: 128,
      mismatchAfter: 0,
      outcome: 'reconciled',
      durations: { scrubMs: 1000, compareMs: 9000, checkMs: 500, totalMs: 10500 },
    },
  })
  await settle()
  ok('mirror: arm B is named as such, with the rows it compared and wrote',
    /Arm B \(compare legs\)/.test(panel.html) && /1 differing row\(s\)/.test(panel.html)
      && /1 written back through md/.test(panel.html), panel.html)

  // --- a residual is NOT a success -----------------------------------------
  sent.onComplete({
    id: 'mj3',
    status: 'completed',
    operation: 'ahr.mirror-reconcile',
    result: {
      pool: 'ahr0',
      band: 2,
      array: '/dev/md/ahr0-r2',
      arm: 'compare',
      passes: [{ corrected: 0, mismatchAfter: 128 }],
      rowsCompared: 51200,
      rowsDiffering: 1,
      rowsWritten: { leg0: 0, leg1: 0 },
      freeSpaceRows: 0,
      uncheckedRows: 0,
      unresolvedRows: 1,
      mismatchBefore: 128,
      mismatchAfter: 128,
      outcome: 'residual',
      reason: '1 row(s) of ahr0-r2 could not be arbitrated: neither leg satisfies the checksum btrfs stored for them',
      durations: { scrubMs: 1, compareMs: 1, checkMs: 1, totalMs: 3 },
    },
  })
  await settle()
  ok('mirror: a residual run refuses to read as healthy',
    /The band is NOT clean/.test(panel.html) && /Do not treat it as healthy/.test(panel.html), panel.html)
  ok('mirror: …and repeats the one thing the operator must not reach for',
    /do not run md repair on it/.test(panel.html), panel.html)
  ok('mirror: …and counts the rows NEITHER leg could satisfy, never written',
    /1 row\(s\) where NEITHER leg matched — never written/.test(panel.html), panel.html)
  ok('mirror: …and carries the run\'s own sentence',
    /could not be arbitrated/.test(panel.html), panel.html)

  // --- rows with no checksum are reported, not hidden ----------------------
  sent.onComplete({
    id: 'mj4',
    status: 'completed',
    operation: 'ahr.mirror-reconcile',
    result: {
      pool: 'ahr0',
      band: 2,
      array: '/dev/md/ahr0-r2',
      arm: 'compare',
      passes: [{ corrected: 0, mismatchAfter: 128 }],
      rowsCompared: 51200,
      rowsDiffering: 3,
      rowsWritten: { leg0: 1, leg1: 0 },
      freeSpaceRows: 1,
      uncheckedRows: 1,
      unresolvedRows: 0,
      mismatchBefore: 128,
      mismatchAfter: 0,
      outcome: 'reconciled',
      durations: { scrubMs: 1, compareMs: 1, checkMs: 1, totalMs: 3 },
    },
  })
  await settle()
  ok('mirror: rows with no stored checksum are counted and said to be left alone',
    /1 row\(s\) with no stored checksum \(left as they are\)/.test(panel.html), panel.html)
  ok('mirror: …and so are rows in free space',
    /1 row\(s\) in free space/.test(panel.html), panel.html)

  // --- a job still running claims no result --------------------------------
  sent.onComplete({ id: 'mj5', status: 'running' })
  await settle()
  ok('mirror: a job still running claims no result', /still running/.test(panel.html), panel.html)
  ok('mirror: …and says where the answer will arrive', /notification/.test(panel.html), panel.html)
}

// Story selfheal.11 — the mirror verb is need-gated the same way the parity one
// is: a PARITY band cannot be reconciled (its mismatch is parity disagreeing
// with data), and a pool whose same scrub named corrupt files cannot be either.
async function mirrorReconcileRefusedChecks() {
  const PARITY_BAND = {
    data: [scrubJob({
      id: 'jpar',
      at: '2026-09-12T13:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: null,
        checkedArrays: 1,
        bandsChecked: ['ahr0-r1'],
        parityMismatches: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8, level: 'raid5' }],
      },
    })],
  }
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': PARITY_BAND })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  created.windows.length = 0

  grid.fireEvent('itemclick', grid, rowFor(grid, 'ahr0'), null, 0, onParityLink)
  await settle()
  const win = openWindow()
  if (!win) { ok('mirror: the parity window opens on a parity band', false); return }
  const pGrid = win.down('#parityGrid')
  const mbtn = win.down('#reconcileMirror')
  const rbtn = win.down('#rewriteParity')
  pGrid.selectRows([0])
  await settle()
  ok('mirror: a parity band lights Rewrite parity and leaves Reconcile mirror dark',
    rbtn.disabled === false && mbtn.disabled === true)
  ok('mirror: …with the reason the daemon would 409 with (not-a-mirror-band)',
    /is a parity band, not a mirror/.test(mbtn.tooltip || ''), mbtn.tooltip)

  let sent = null
  ANAS.confirmAndRun = (cfg) => { sent = cfg }
  mbtn.handler(mbtn)
  await settle()
  ok('mirror: the handler itself refuses a parity band, not just the disabled state', sent === null)

  // A row from a daemon too old to record the level cannot be reconciled
  // either: the two mismatch verbs are not interchangeable, and guessing which
  // one a band needs is exactly the guess this epic exists to avoid.
  created.windows.length = 0
  const ANAS2 = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': SCRUB_JOBS })
  const view2 = makeComponent(ANAS2.views.scrubs.factory('harness'), null)
  const grid2 = view2.down('#scrubGrid')
  view2.fireEvent('afterrender', view2)
  await settle()
  created.windows.length = 0
  grid2.fireEvent('itemclick', grid2, rowFor(grid2, 'ahr3'), null, 0, onParityLink)
  await settle()
  const win2 = openWindow()
  if (!win2) { ok('mirror: the parity window opens on a level-less row', false); return }
  win2.down('#parityGrid').selectRows([0])
  await settle()
  const mbtn2 = win2.down('#reconcileMirror')
  ok('mirror: a row with no recorded level leaves the verb dark', mbtn2.disabled === true)
  ok('mirror: …and says the two verbs are not interchangeable',
    /did not record what level the band is/.test(mbtn2.tooltip || ''), mbtn2.tooltip)
}

// Seventh pass, F2 — the parity indicator can be fed by a completed REPAIR.
//
// A repair that wrote a block, proved it cold against its stored checksum and
// then saw md still counting the stripe has MEASURED a parity residual on that
// band. It rides the repair result in the SAME row shape a scrub's
// `parityMismatches` uses, so the door on the Scrubs row opens without waiting
// hours for a fresh two-phase scrub to rediscover the number.
async function parityResidualFromRepairChecks() {
  const REPAIR_RESIDUAL = {
    data: [{
      id: 'jrep',
      operation: 'ahr.repair',
      status: 'completed',
      createdAt: '2026-09-12T14:00:00.000Z',
      completedAt: '2026-09-12T14:30:00.000Z',
      result: {
        pool: 'ahr0',
        files: [],
        repaired: 1,
        unrepairable: 0,
        aboveMd: 0,
        mappingAbort: 0,
        notExamined: 0,
        parityResiduals: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8, level: 'raid5' }],
        blocks: 1,
      },
    }],
  }
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], { 'GET /scrub': SCRUB_STATES, 'GET /jobs': REPAIR_RESIDUAL })
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  created.windows.length = 0

  const cell = scrubCell(grid, rowFor(grid, 'ahr0'))
  ok('residual: the Scrubs row shows the parity indicator from the REPAIR job (F2)',
    /parity mismatch on ahr0-r1 \(8\)/.test(cell), cell)
  ok('residual: and it offers the rewrite, because the band is a parity band',
    /Click to rewrite/.test(cell), cell)

  grid.fireEvent('itemclick', grid, rowFor(grid, 'ahr0'), null, 0, onParityLink)
  await settle()
  const win = openWindow()
  ok('residual: the parity window opens on it', !!win && win.cls === 'anas-win-scrub-parity')
  if (!win) { return }
  const pGrid = win.down('#parityGrid')
  eq('residual: the band is the row', pGrid.getStore().getAt(0).get('band'), 'ahr0-r1')
  eq('residual: with the band number Rewrite parity is keyed on', pGrid.getStore().getAt(0).get('bandIndex'), 1)
  pGrid.selectRows([0])
  await settle()
  eq('residual: the verb is reachable', win.down('#rewriteParity').disabled, false)
}

// Design review 2026-09-14, D15 + S8 — the AHR Snapshots manager meets the
// repair engine's transient pin. A leftover `anas-selfheal-<ts>` snapshot (the
// repair's finally failed to delete it) is labelled as what it is and is never
// a rollback target; and rolling back to a snapshot whose contents the last
// scrub found UNREPAIRED rot in says so before the operator confirms.
async function ahrSnapshotPinChecks() {
  const SNAPS = {
    data: [
      { name: 'nightly', createdAt: '2026-09-12T00:00:00Z', readonly: true },
      { name: 'anas-selfheal-20260913T120000Z', createdAt: '2026-09-13T12:00:00Z', readonly: true },
    ],
  }
  const S8_JOBS = {
    data: [scrubJob({
      id: 'js8',
      at: '2026-09-12T09:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: 'csum=1',
        checkedArrays: 2,
        findings: [{
          path: '@snapshots/nightly/movies/x.mkv',
          subvolume: '@snapshots/nightly',
          inode: 601,
          stripes: [],
          badBlocks: [],
          outsideMount: true,
        }],
        errorsReported: 1,
        errorsAttributed: 1,
        unattributed: 0,
        truncated: false,
      },
    })],
  }
  const ANAS = loadSources(['15-gfx.js', '39-ahr.js'], {
    'GET /ahr': { data: [ahrPoolRow('ahr0')] },
    'GET /ahr/ahr0/snapshots': SNAPS,
    'GET /jobs': S8_JOBS,
  })
  const view = makeComponent(ANAS.views.ahr.factory('harness'), null)
  view.fireEvent('afterrender', view)
  await settle()
  const grid = view.itemId === 'ahrGrid' ? view : view.down('#ahrGrid')
  if (!grid) { ok('snappin: the AHR grid exists', false); return }
  grid.selectRow(grid.getStore().findExact('name', 'ahr0'))
  const snapBtn = grid.down('#snapshots')
  ok('snappin: the Snapshots verb exists for a §12 pool', !!snapBtn && !snapBtn.disabled)
  if (!snapBtn) { return }
  created.windows.length = 0
  snapBtn.handler(snapBtn)
  await settle()
  const win = openWindow()
  ok('snappin: the manager window opens', !!win && win.cls === 'anas-win-ahr-snapshots')
  if (!win) { return }
  const snapGrid = win.down('#ahrSnapGrid')
  ok('snappin: both snapshots list, pin included', !!snapGrid && snapGrid.getStore().getCount() === 2)
  if (!snapGrid) { return }

  // D15 — the pin is LABELLED in the row, never silently indistinguishable.
  const nameCol = (snapGrid.columns || []).find(c => c.dataIndex === 'name')
  const pinCell = nameCol.renderer(SNAPS.data[1].name)
  ok('snappin: a leftover repair pin is labelled as what it is',
    /transient ANAS repair pin; safe to delete if no repair is running/.test(pinCell), pinCell)
  ok('snappin: an operator snapshot carries no pin label',
    !/repair pin/.test(nameCol.renderer(SNAPS.data[0].name)))

  // D15 — and it is never a rollback target; the reason rides the tooltip.
  const rb = win.down('#ahrSnapRollback')
  ok('snappin: the Rollback verb exists', !!rb)
  if (!rb) { return }
  snapGrid.selectRow(1)
  await settle()
  ok('snappin: Rollback DISABLED for the pin', rb.disabled === true)
  ok('snappin: …and the tooltip says why (nothing to roll back to)',
    /transient ANAS repair pin/.test(rb.tooltip || ''), rb.tooltip)
  snapGrid.selectRow(0)
  await settle()
  ok('snappin: Rollback ENABLED for an operator snapshot', rb.disabled === false)
  ok('snappin: …with no leftover reason', rb.tooltip === '', rb.tooltip)

  // S8 — rolling back to a snapshot the last scrub found UNREPAIRED rot inside
  // says so in the confirm, before the code is minted.
  let sent = null
  ANAS.confirmAndRun = (cfg) => { sent = cfg }
  rb.handler(rb)
  await settle()
  ok('snaps8: the rollback goes through the confirm door', !!sent)
  if (!sent) { return }
  ok('snaps8: the confirm warns of the unrepaired finding inside THIS snapshot',
    /the last scrub found an unrepaired corrupt block inside this snapshot \(@snapshots\/nightly\/movies\/x\.mkv\)/
      .test(sent.confirmIntro || ''), sent.confirmIntro)
  ok('snaps8: …and says what rollback does with it',
    /rolling back restores it/.test(sent.confirmIntro || ''), sent.confirmIntro)

  // The negative: the newest scrub found nothing inside THIS snapshot — the
  // confirm carries no warning (and the fail-open path reads as the same).
  const OTHER_JOBS = {
    data: [scrubJob({
      id: 'js8b',
      at: '2026-09-12T09:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: 'csum=1',
        checkedArrays: 2,
        findings: [{ path: '@snapshots/other/y.bin', subvolume: '@snapshots/other', inode: 7, stripes: [], badBlocks: [], outsideMount: true }],
        errorsReported: 1,
        errorsAttributed: 1,
        unattributed: 0,
        truncated: false,
      },
    })],
  }
  const ANAS2 = loadSources(['15-gfx.js', '39-ahr.js'], {
    'GET /ahr': { data: [ahrPoolRow('ahr0')] },
    'GET /ahr/ahr0/snapshots': SNAPS,
    'GET /jobs': OTHER_JOBS,
  })
  const view2 = makeComponent(ANAS2.views.ahr.factory('harness'), null)
  view2.fireEvent('afterrender', view2)
  await settle()
  const grid2 = view2.itemId === 'ahrGrid' ? view2 : view2.down('#ahrGrid')
  if (!grid2) { ok('snaps8: (negative) the grid exists', false); return }
  grid2.selectRow(grid2.getStore().findExact('name', 'ahr0'))
  const snapBtn2 = grid2.down('#snapshots')
  created.windows.length = 0
  snapBtn2.handler(snapBtn2)
  await settle()
  const win2 = openWindow()
  if (!win2) { ok('snaps8: (negative) the window opens', false); return }
  const snapGrid2 = win2.down('#ahrSnapGrid')
  sent = null
  ANAS2.confirmAndRun = (cfg) => { sent = cfg }
  snapGrid2.selectRow(0)
  await settle()
  win2.down('#ahrSnapRollback').handler(win2.down('#ahrSnapRollback'))
  await settle()
  ok('snaps8: rot in a DIFFERENT snapshot does not warn this rollback',
    sent && !/unrepaired corrupt block/.test(sent.confirmIntro || ''), sent && sent.confirmIntro)
}

// ============================================================================
//  Scrubs: Repair from parity, in the findings window (story selfheal.6)
// ============================================================================
//
// The findings window is the ONE place a repair is asked for — the findings are
// what it is selected from. The contract below is the whole surface: which rows
// can be ticked (and why the others cannot), when the verb lights up, that it
// goes out through the confirm-code door with the exact files and blocks the
// operator picked, and that the job's three buckets come back into the same
// window — including the honest "still running" when the poll budget ends
// first.

// A second repairable file, with TWO bad blocks — a repair request carries the
// block indexes, not a count, and the result is counted per block.
const FINDING_D = {
  path: '/mnt/anas-ahr/ahr0/db/pg_data.bin',
  subvolume: '@data',
  inode: 402,
  stripes: [{ logical: 30000000, offset: 0, length: 4096 }],
  badBlocks: [12, 13],
}
// selfheal.8 — a COMPRESSED extent: the kernel's offset is extent-relative, so
// the probe named the extent's whole file range and the finding carries it.
// Repairable — the engine repairs the blob when handed any block of the
// extent, and the request carries the extent's FIRST block.
const FINDING_E = {
  path: '/mnt/anas-ahr/ahr0/comp/text.bin',
  subvolume: '@data',
  inode: 259,
  stripes: [{ logical: 953155584, offset: 0, length: 4096 }],
  badBlocks: Array.from({ length: 32 }, (_, i) => 32 + i),
  compressed: true,
  extentBlocks: { first: 32, count: 32 },
}
// …and one whose corrupt block could not be named at all: said plainly, with
// the reason, instead of an empty badBlocks that reads as "nothing found".
const FINDING_F = {
  path: '/mnt/anas-ahr/ahr0/comp/other.bin',
  subvolume: '@data',
  inode: 260,
  stripes: [{ logical: 953283584, offset: 0, length: 4096 }],
  badBlocks: [],
  unidentified: true,
  reason: 'no block failed on re-read: either the file changed since the scrub, or the read was served from cache',
}

const REPAIR_ROUTES = {
  'GET /scrub': SCRUB_STATES,
  'GET /jobs': {
    data: [scrubJob({
      id: 'r1',
      at: '2026-09-11T09:00:00.000Z',
      result: {
        scrubbed: 'ahr0',
        btrfsErrors: 'csum=6',
        checkedArrays: 3,
        findings: [FINDING_A, FINDING_B, FINDING_C, FINDING_D, FINDING_E, FINDING_F],
        errorsReported: 6,
        errorsAttributed: 6,
        unattributed: 0,
        truncated: false,
      },
    })],
  },
}

/** A completed repair job, as the daemon's job route hands it back. */
function repairJob(result) {
  return { id: 'rj1', status: 'completed', operation: 'ahr.repair', result }
}

async function repairFromParityChecks() {
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], REPAIR_ROUTES)
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()
  created.windows.length = 0
  grid.fireEvent('itemclick', grid, rowFor(grid, 'ahr0'), null, 0, onLink)
  await settle()
  const win = openWindow()
  ok('repair: the findings window opens', !!win && win.cls === 'anas-win-scrub-findings')
  if (!win) { return }
  const fGrid = win.down('#findingsGrid')
  const btn = win.down('#repairFromParity')
  ok('repair: the findings grid is addressable by itemId', !!fGrid)
  ok('repair: the window carries the Repair from parity button', !!btn && btn.cls === 'anas-btn-repair-parity')
  if (!fGrid || !btn) { return }
  eq('repair: the findings are ticked one by one (checkbox selection)',
    fGrid.selModel && fGrid.selModel.selType, 'checkboxmodel')

  // --- Enablement ------------------------------------------------------------
  eq('repair: the verb needs a selection', btn.disabled, true)
  ok('repair: …and says so on the button', /tick the files/.test(btn.tooltip || ''), btn.tooltip)

  // --- Selection rules -------------------------------------------------------
  // Row order: A (repairable, 1 block), B (missing), C (outsideMount), D (2
  // blocks), E (compressed extent), F (unidentified).
  eq('repair: every finding is a row', fGrid.getStore().getCount(), 6)
  eq('repair: a DELETED file cannot be ticked', fGrid.selectRows([1]).length, 0)
  eq('repair: a finding inside a SNAPSHOT cannot be ticked', fGrid.selectRows([2]).length, 0)
  eq('repair: …and the verb stays off', btn.disabled, true)
  const repairCol = (fGrid.columns || []).find(c => c.dataIndex === 'outcome')
  ok('repair: the window has a Repair column', !!repairCol)
  const repairCell = (i) => {
    const meta = {}
    const html = repairCol.renderer(fGrid.getStore().getAt(i).get('outcome'), meta, fGrid.getStore().getAt(i))
    return `${html} ${meta.tdAttr || ''}`
  }
  ok('repair: a deleted file says WHY it cannot be repaired',
    /cannot be repaired/.test(repairCell(1)) && /deleted since the scrub/.test(repairCell(1)), repairCell(1))
  ok('repair: a snapshot finding says it is outside the mounted tree',
    /cannot be repaired/.test(repairCell(2)) && /live @data tree only/.test(repairCell(2)), repairCell(2))
  ok('repair: a repairable file shows nothing yet, not a verdict', /—/.test(repairCell(0)), repairCell(0))

  // selfheal.8 — the two new findings render what they are, never a bare 0.
  const blocksCol = (fGrid.columns || []).find(c => c.dataIndex === 'blocks')
  const blockCell = (i) => {
    const meta = {}
    const html = blocksCol.renderer(null, meta, fGrid.getStore().getAt(i))
    return `${html} ${meta.tdAttr || ''}`
  }
  ok('repair: a COMPRESSED extent says what it is, with the extent\'s block count',
    /compressed extent: 32 blocks/.test(blockCell(4)), blockCell(4))
  ok('repair: …and its tooltip names the failing blocks', /failing 4 KiB file blocks: 32/.test(blockCell(4)), blockCell(4))
  ok('repair: an UNIDENTIFIED corruption says so instead of showing 0',
    /corrupt, block not identified/.test(blockCell(5)) && !/>0</.test(blockCell(5)), blockCell(5))
  ok('repair: …and carries the reason as its tooltip, stating the AMBIGUITY (D9)',
    /no block failed on re-read: either the file changed since the scrub, or the read was served from cache/.test(blockCell(5)), blockCell(5))
  ok('repair: …and never claims the file was repaired',
    !/was repaired/.test(blockCell(5)), blockCell(5))

  eq('repair: a COMPRESSED extent ticks — the engine repairs the blob from any block of it',
    fGrid.selectRows([4]).length, 1)
  eq('repair: an UNIDENTIFIED finding cannot be ticked', fGrid.selectRows([5]).length, 0)
  ok('repair: …and says why, with the reason', /no bad block could be named/.test(repairCell(5)) &&
    /either the file changed since the scrub, or the read was served from cache/.test(repairCell(5)), repairCell(5))

  eq('repair: two repairable files tick', fGrid.selectRows([0, 3]).length, 2)
  eq('repair: …and the verb lights up', btn.disabled, false)
  eq('repair: an unrepairable row ticked ALONGSIDE them is dropped, not carried',
    fGrid.selectRows([0, 1, 3, 4]).length, 3)

  // --- The confirm-gated request --------------------------------------------
  let sent = null
  ANAS.confirmAndRun = (cfg) => { sent = cfg }
  btn.handler(btn)
  await settle()
  ok('repair: the verb goes through the confirm-code door', !!sent)
  if (!sent) { return }
  eq('repair: …to the pool\'s own repair endpoint', sent.path, '/ahr/ahr0/repair')
  eq('repair: …as a POST', sent.method, 'post')
  eq('repair: the request names the files IN FULL, never truncated',
    sent.body.files.map(f => f.path), [FINDING_A.path, FINDING_D.path, FINDING_E.path])
  eq('repair: …and the exact 4 KiB blocks the scrub probed',
    sent.body.files.map(f => f.blocks), [[300], [12, 13], [32]])
  // Seventh pass, F11 — a path is not an identity. The finding's inode rides
  // along so the daemon can refuse a file that is not the one the scrub read.
  eq('repair: …and the finding\'s INODE, so the daemon can check identity (F11)',
    sent.body.files.map(f => f.inode), [FINDING_A.inode, FINDING_D.inode, FINDING_E.inode])
  ok('repair: …the compressed extent rides as ONE block — its first, not 32 copies of the blob',
    sent.body.files[2].blocks.length === 1 && sent.body.files[2].blocks[0] === FINDING_E.extentBlocks.first,
    JSON.stringify(sent.body.files[2]))
  ok('repair: the confirm dialog says how many blocks in how many files',
    /4 block\(s\) in 3 file\(s\)/.test(sent.confirmIntro || ''), sent.confirmIntro)
  ok('repair: the poll budget is raised past the 15 s default (a repair is minutes)',
    Number(sent.maxMs) > 15000, sent.maxMs)
  ok('repair: the poll rides the window, not a component that closes', sent.view === win)

  // --- The result, in the same window ---------------------------------------
  const panel = win.down('#repairResult')
  ok('repair: the result panel is hidden until there is a result', !!panel && panel.hidden === true)
  sent.onComplete(repairJob({
    pool: 'ahr0',
    files: [
      { path: FINDING_A.path, blocks: [{ block: 300, outcome: 'repaired', reason: 'reconstructed from parity' }] },
      { path: FINDING_D.path, blocks: [
        { block: 12, outcome: 'unrepairable', reason: 'two bad blocks in one stripe' },
        { block: 13, outcome: 'above-md', reason: 'parity agrees with the bad data' },
      ] },
    ],
    repaired: 1,
    unrepairable: 1,
    aboveMd: 1,
    blocks: 3,
  }))
  await settle()
  eq('repair: the result appears in the window the request was made from', panel.hidden, false)
  ok('repair: the three buckets are counted', /1 repaired · 1 unrepairable · 1 above md/.test(panel.html), panel.html)
  ok('repair: unrepairable says restore from backup', /Restore this file from backup/.test(panel.html), panel.html)
  ok('repair: above md implicates something other than the disks, as an implication',
    /implicates something other than the disks/.test(panel.html) && !/proves/.test(panel.html), panel.html)
  ok('repair: a repaired file carries its verdict on its own row', /repaired/.test(repairCell(0)), repairCell(0))
  ok('repair: a mixed file says BOTH of its outcomes',
    /1 unrepairable/.test(repairCell(3)) && /1 above-md/.test(repairCell(3)), repairCell(3))

  // --- review R9 — the mapping-abort bucket reads its own number -------------
  sent.onComplete(repairJob({
    pool: 'ahr0',
    files: [
      { path: FINDING_A.path, blocks: [{ block: 300, outcome: 'mapping-abort', reason: 'the bytes still pass their stored checksum' }] },
    ],
    repaired: 0,
    unrepairable: 0,
    aboveMd: 0,
    mappingAbort: 1,
    blocks: 1,
  }))
  await settle()
  ok('repair: the mapping-abort count rides the headline, its OWN number',
    /0 repaired · 0 unrepairable · 0 above md · 1 not corrupt at the mapped location/.test(panel.html), panel.html)
  ok('repair: mapping-abort says nothing was written and nothing needs a restore',
    /1 block\(s\) were not corrupt at the mapped location. Nothing was written, nothing to restore/.test(panel.html), panel.html)
  ok('repair: …and the restore advice stays reserved for the TRUE unrepairable',
    !/restore this file from backup/.test(panel.html), panel.html)

  // --- Seventh pass, F3 — the NOT-EXAMINED bucket ---------------------------
  // A block the mapping could not reach was never looked at. It used to borrow
  // the mapping-abort sentence, which asserts the bytes still pass their stored
  // checksum — a reassurance about blocks nobody read.
  sent.onComplete(repairJob({
    pool: 'ahr0',
    files: [
      { path: FINDING_A.path, blocks: [{ block: 300, outcome: 'not-examined', reason: 'block 300 is a hole', reasonCode: 'hole' }] },
    ],
    repaired: 0,
    unrepairable: 0,
    aboveMd: 0,
    mappingAbort: 0,
    notExamined: 1,
    blocks: 1,
  }))
  await settle()
  ok('repair: the not-examined count rides the headline as its OWN number (F3)',
    /0 repaired · 0 unrepairable · 0 above md · 0 not corrupt at the mapped location · 1 not examined/.test(panel.html), panel.html)
  ok('repair: …with the reason code, and nothing is known about the bytes',
    /could not be EXAMINED \(hole\)/.test(panel.html)
      && /nothing is known about those bytes/.test(panel.html), panel.html)
  ok('repair: …neither a clean bill of health nor a reason to restore',
    /neither a clean bill of health nor a reason to restore/.test(panel.html)
      && !/restore this file from backup/.test(panel.html)
      && !/need no restore/.test(panel.html), panel.html)

  // --- Seventh pass, F2 — a repaired block that left a PARITY residual ------
  sent.onComplete(repairJob({
    pool: 'ahr0',
    files: [
      { path: FINDING_A.path, blocks: [{ block: 300, outcome: 'repaired', reason: 'repaired; the band still has a parity/Q mismatch' }] },
    ],
    repaired: 1,
    unrepairable: 0,
    aboveMd: 0,
    mappingAbort: 0,
    notExamined: 0,
    parityResiduals: [{ band: 'ahr0-r1', bandIndex: 1, array: '/dev/md/ahr0-r1', mismatchCnt: 8, level: 'raid5' }],
    blocks: 1,
  }))
  await settle()
  ok('repair: a parity residual is reported, naming the band and md\'s count (F2)',
    /Repaired, and md still counts mismatching stripes on ahr0-r1 \(mismatch_cnt 8\)/.test(panel.html), panel.html)
  ok('repair: …and points at Rewrite parity, never a restore',
    /Rewrite parity on that band/.test(panel.html)
      && /No fresh scrub is needed/.test(panel.html)
      && !/restore/i.test(panel.html), panel.html)

  // --- D3/D10 — the csum-unreadable verdict does NOT say restore -------------
  sent.onComplete(repairJob({
    pool: 'ahr0',
    files: [
      { path: FINDING_A.path, blocks: [
        { block: 300, outcome: 'unrepairable', reason: 'the metadata copy holding the checksum is damaged', reasonCode: 'csum-unreadable' },
      ] },
    ],
    repaired: 0,
    unrepairable: 1,
    aboveMd: 0,
    mappingAbort: 0,
    blocks: 1,
  }))
  await settle()
  ok('repair: a csum-unreadable file says the checksum could not be read',
    /checksum could not be read reliably/.test(panel.html), panel.html)
  ok('repair: …and says re-scrub after the metadata is repaired',
    /re-scrub after the metadata is repaired/.test(panel.html), panel.html)
  ok('repair: …and NEVER tells the operator to restore data never proven bad',
    !/restore this file from backup/.test(panel.html), panel.html)
  ok('repair: …naming the file it applies to', panel.html.includes(FINDING_A.path), panel.html)

  // A MIXED file keeps the ordinary restore advice: only one of its blocks
  // carries the code, and nothing else can prove the other one.
  sent.onComplete(repairJob({
    pool: 'ahr0',
    files: [
      { path: FINDING_D.path, blocks: [
        { block: 12, outcome: 'unrepairable', reason: 'the metadata copy holding the checksum is damaged', reasonCode: 'csum-unreadable' },
        { block: 13, outcome: 'unrepairable', reason: 'two bad blocks in one stripe' },
      ] },
    ],
    repaired: 0,
    unrepairable: 2,
    aboveMd: 0,
    mappingAbort: 0,
    blocks: 2,
  }))
  await settle()
  ok('repair: a MIXED unrepairable file keeps the ordinary restore advice',
    /Restore this file from backup/.test(panel.html), panel.html)
  ok('repair: …and does not claim the checksum was unreadable for it',
    !/checksum could not be read reliably/.test(panel.html), panel.html)

  // --- The honest "not finished" --------------------------------------------
  sent.onComplete({ id: 'rj2', status: 'running' })
  await settle()
  ok('repair: a job still running claims no result', /still running/.test(panel.html), panel.html)
  ok('repair: …and says where the answer will arrive', /notification/.test(panel.html), panel.html)
}

// ============================================================================
//  Scrubs: Repair on the TOOLBAR (story selfheal.9)
// ============================================================================
//
// The verb's standing home: a Repair action beside Run now / Stop, lit by the
// ONE enablement rule the window's button is lit by (repairableFindings over
// the selected AHR pool's last completed scrub), greyed with the reason on the
// button otherwise. Clicking it opens the SAME findings window, the repairable
// rows already ticked — the toolbar establishes what is repairable, the
// operator only confirms.

async function scrubToolbarRepairChecks() {
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], REPAIR_ROUTES)
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()

  const btn = grid.down('#scrubRepair')
  ok('scrubrepair: the toolbar carries the Repair verb', !!btn && btn.cls === 'anas-btn-scrub-repair')
  if (!btn) { return }

  // --- Enablement, with the reason ON the button -----------------------------
  ok('scrubrepair: nothing selected keeps it off', btn.disabled === true)
  ok('scrubrepair: …and says an AHR pool is wanted', /select an AHR pool/.test(btn.tooltip || ''), btn.tooltip)

  grid.selectRow(grid.getStore().findExact('pool', 'tank'))
  ok('scrubrepair: a ZFS row keeps it off', btn.disabled === true)
  ok('scrubrepair: …still saying an AHR pool is wanted', /select an AHR pool/.test(btn.tooltip || ''), btn.tooltip)

  grid.selectRow(grid.getStore().findExact('pool', 'ahr1'))
  ok('scrubrepair: an AHR row with no findings keeps it off', btn.disabled === true)
  ok('scrubrepair: …saying the daemon holds nothing for this pool',
    /no scrub findings for this pool since the daemon started/.test(btn.tooltip || ''), btn.tooltip)

  // ahr0's recovered findings include repairable rows (A, D, E) — the verb lights.
  grid.selectRow(grid.getStore().findExact('pool', 'ahr0'))
  ok('scrubrepair: an AHR row with a repairable finding lights it', btn.disabled === false)
  ok('scrubrepair: …with no tooltip standing in the way', !btn.tooltip, btn.tooltip)

  // Findings that are ALL blocked: off, and the tooltip counts each kind in the
  // window's own per-row words — one rule, said twice at different zooms.
  const ahr0 = rowFor(grid, 'ahr0')
  const saved = ahr0.get('findings')
  ahr0.set('findings', { at: saved.at, result: { findings: [FINDING_B, FINDING_C, FINDING_F] } })
  grid.selectRow(grid.getStore().findExact('pool', 'ahr0'))
  const tip = btn.tooltip || ''
  ok('scrubrepair: findings that are all deleted/snapshot/unnamed keep it off', btn.disabled === true)
  ok('scrubrepair: …and the tooltip says the findings cannot be repaired from here',
    /findings cannot be repaired from here/.test(tip), tip)
  ok('scrubrepair: …counting each blocked kind the window states per row',
    /1 file deleted since the scrub/.test(tip)
    && /1 finding in a snapshot, outside the mounted tree/.test(tip)
    && /1 corruption whose bad block could not be named/.test(tip), tip)
  ahr0.set('findings', saved)
  grid.selectRow(grid.getStore().findExact('pool', 'ahr0'))

  // --- The click: the SAME window, repairable rows preselected ---------------
  created.windows.length = 0
  btn.handler(btn)
  await settle()
  const win = openWindow()
  ok('scrubrepair: the click opens the findings window', !!win && win.cls === 'anas-win-scrub-findings')
  if (!win) { return }
  const fGrid = win.down('#findingsGrid')
  const wBtn = win.down('#repairFromParity')
  ok('scrubrepair: the ONE findings window, its Repair button included',
    !!fGrid && !!wBtn && wBtn.cls === 'anas-btn-repair-parity')
  if (!fGrid || !wBtn) { return }
  eq('scrubrepair: exactly the repairable rows arrive ticked, none of the blocked ones',
    fGrid.getSelection().map(r => r.get('path')), [FINDING_A.path, FINDING_D.path, FINDING_E.path])
  eq('scrubrepair: the window verb is lit without the operator ticking anything', wBtn.disabled, false)
}

// ============================================================================
//  Scrubs: the two-phase AHR scrub surface (story selfheal.4)
// ============================================================================
//
// The periodic AHR scrub is the WHOLE scrub now — phase 1 md parity, then
// phase 2 btrfs checksums — on one node-level ANAS timer with a monthly or
// quarterly cadence. The contract here: the AHR row names both phases (and the
// next fire when the timer reports one), the cadence selector lives exactly
// where the toggle lives (the toolbar, AHR-only, no new menu/window), the
// toggle body carries the cadence, and the confirm dialog states the node-level
// scope and the mdcheck takeover.

async function scrubTwoPhaseChecks() {
  const ANAS = loadSource(['69-schedules-common.js', '69-scrubs.js'], SCRUB_ROUTES)
  const view = makeComponent(ANAS.views.scrubs.factory('harness'), null)
  const grid = view.down('#scrubGrid')
  view.fireEvent('afterrender', view)
  await settle()

  const ahr0 = rowFor(grid, 'ahr0')
  const ahr1 = rowFor(grid, 'ahr1')
  const tank = rowFor(grid, 'tank')
  if (!ahr0 || !ahr1 || !tank) { ok('scrubs2: every pool is a row', false); return }

  // --- The phases on the row -------------------------------------------------
  // ahr1 is OFF with no findings: the idle AHR cell names both phases and says
  // there is no next fire.
  const offCell = scrubCell(grid, ahr1)
  ok('scrubs2: the AHR row names both phases in order',
    /phase 1 parity \(md\) → phase 2 checksums \(btrfs\)/.test(offCell), offCell)
  ok('scrubs2: an OFF pool claims no next run', !/>?next/.test(offCell), offCell)
  ok('scrubs2: the md-keeps-no-record honesty stays on the row',
    /md keeps no completion record/.test(offCell), offCell)

  // An ON pool shows the timer's next fire — but the findings cell outranks it,
  // so the findings are set aside for the check and put back after.
  const savedFindings = ahr0.get('findings')
  ahr0.set('findings', null)
  ahr0.set('nextRun', '2026-10-04T03:00:00.000Z')
  const onCell = scrubCell(grid, ahr0)
  ok('scrubs2: an ON pool shows the timer\'s next fire',
    /; next /.test(onCell), onCell)
  ahr0.set('nextRun', null)
  ahr0.set('findings', savedFindings)

  // A ZFS row never grew phase wording.
  ok('scrubs2: a ZFS row says neither phase', !/phase 1 parity/.test(scrubCell(grid, tank)))

  // --- The cadence selector + the toggle body --------------------------------
  const cad = grid.down('#scrubCadence')
  ok('scrubs2: the cadence selector exists beside the toggle (no new menu/window)', !!cad)
  ok('scrubs2: it starts disabled with nothing selected', !!cad && cad.disabled === true)

  grid.selectRow(grid.getStore().findExact('pool', 'ahr1'))
  ok('scrubs2: the selector enables for an AHR row', !!cad && cad.disabled === false)
  ok('scrubs2: it shows the row\'s cadence', !!cad && cad.value === 'quarterly')

  cad.value = 'quarterly'
  jobs.length = 0
  confirms.length = 0
  grid.down('#scrubToggle').handler(grid.down('#scrubToggle'))
  ok('scrubs2: the AHR toggle confirms the node-level scope',
    confirms.some(c => /node-level timer/.test(c.title)), JSON.stringify(confirms))
  ok('scrubs2: the enable confirm says mdcheck is turned off',
    confirms.some(c => /mdcheck timers will be turned off/.test(c.msg)))
  // review R10 — Persistent=true + a leftover stamp means the enable may start
  // the whole scrub immediately when the month's occurrence was already missed.
  ok('scrubs2: the enable confirm warns that a missed occurrence may start a scrub right away',
    confirms.some(c => /missed/.test(c.msg) && /RIGHT AWAY/.test(c.msg)))

  // review cut-but-verified — the 10 s poll must not yank the cadence value out
  // from under the operator while they are choosing it.
  grid.selectRow(grid.getStore().findExact('pool', 'ahr1'))
  ok('scrubs2: the selector shows the row cadence before the guard', cad.value === 'quarterly')
  cad.value = 'monthly'
  cad.hasFocus = true // the operator is mid-choice
  grid.fireEvent('selectionchange', grid)
  ok('scrubs2: a FOCUSED cadence selector is left alone by the poll', cad.value === 'monthly')
  cad.hasFocus = false
  grid.fireEvent('selectionchange', grid)
  ok('scrubs2: …and picks the row\'s cadence back up once the operator is done', cad.value === 'quarterly')
  ok('scrubs2: the AHR toggle body carries the cadence',
    jobs.some(j => j.method === 'put' && j.path === '/scrub/ahr/ahr1'
      && j.body.enabled === true && j.body.cadence === 'quarterly'), JSON.stringify(jobs))

  grid.selectRow(grid.getStore().findExact('pool', 'tank'))
  ok('scrubs2: the selector is ZFS-disabled (PVE\'s cron owns ZFS cadence)', !!cad && cad.disabled === true)
  jobs.length = 0
  grid.down('#scrubToggle').handler(grid.down('#scrubToggle'))
  ok('scrubs2: the ZFS toggle body carries no cadence',
    jobs.some(j => j.method === 'put' && j.path === '/scrub/zfs/tank'
      && j.body.enabled === false && !('cadence' in j.body)), JSON.stringify(jobs))
}

// ============================================================================
//  Disks (story 3.18) — the stale/standby marker on the Health cell
// ============================================================================
//
//  The daemon reports a disk's LAST KNOWN SMART state as `smartStale` +
//  `smartStaleReason` ('standby' | 'probe-failed') — the value shown is the
//  last measured one, not current. The Health cell must render that as a muted
//  "(last known — …)" suffix + tooltip, and render NOTHING extra on a fresh
//  reading or on an older daemon that omits the fields (version skew).

async function disksStaleHealthChecks() {
  const ANAS = loadSource('40-disks.js', { 'GET /disks': { data: [] } })
  ok('disks: the disks view registered', !!ANAS.views['disks'])
  const gridCfg = ANAS.views['disks'].factory('n1').items[0]
  const healthCol = gridCfg.columns.find(c => c.dataIndex === 'healthStatus')
  ok('disks: the Health column exists', !!healthCol)
  const render = (v, data) => healthCol.renderer(v, {}, makeRecord(data))

  // A fresh reading: the icon + label, no marker.
  const fresh = render('healthy', { healthStatus: 'healthy' })
  ok('disks: a fresh reading renders no stale marker', !/last known/.test(fresh), fresh)

  // Stale — standby: the last measured value, with the muted suffix + tooltip.
  const standby = render('healthy', { healthStatus: 'healthy', smartStale: true, smartStaleReason: 'standby' })
  ok('disks: a standby disk reads "last known — disk in standby"', /last known — disk in standby/.test(standby), standby)
  ok('disks: the standby marker is muted and carries a tooltip',
    /anas-health-stale/.test(standby) && /title=/.test(standby), standby)

  // Stale — probe failed.
  const failed = render('healthy', { healthStatus: 'healthy', smartStale: true, smartStaleReason: 'probe-failed' })
  ok('disks: a failed probe reads "last known — probe failed"', /last known — probe failed/.test(failed), failed)

  // The marker belongs to the cell, not the level: an unknown cell keeps it too.
  const unknown = render('unknown', { healthStatus: 'unknown', smartStale: true, smartStaleReason: 'probe-failed' })
  ok('disks: the marker renders on an unknown cell too', /last known — probe failed/.test(unknown), unknown)

  // Version skew: an old daemon omits both fields — the cell is byte-identical
  // to what it was before the marker existed.
  const old = render('healthy', { healthStatus: 'healthy', smartStale: undefined, smartStaleReason: undefined })
  ok('disks: an absent marker (old daemon) renders the cell exactly as before', old === fresh, old)
}

// ============================================================================
//  Share Users (identity.1) — mixed-case names, need-gated confirm-gated
//  delete on both grids, and the private-group label
// ============================================================================

const USER_ROWS = [
  { name: 'Alice', uid: 1000, fullName: 'Alice Example', primaryGroup: 'users', groups: ['users', 'smbusers'], smbEnabled: true, locked: false, local: true },
  { name: 'aduser', uid: 6000, fullName: null, primaryGroup: null, groups: [], smbEnabled: false, locked: false, local: false },
]
const GROUP_ROWS = [
  // A pre-existing user-private group (identity.1c): the same name as user
  // `Alice`, whose primary gid is this group.
  { name: 'alice', gid: 2000, members: ['Alice'], local: true, privateGroupOf: 'Alice' },
  { name: 'smbusers', gid: 1001, members: ['Alice', 'backup-svc'], local: true },
  { name: 'adgroup', gid: 6001, members: ['aduser'], local: false },
]
const USER_ROUTES = {
  'GET /identity/users': { data: USER_ROWS },
  'GET /identity/groups': { data: GROUP_ROWS },
}

async function openUsersView(routes = USER_ROUTES) {
  const ANAS = loadSource('80-users.js', routes)
  const view = makeComponent(ANAS.views.users.factory('harness'), null)
  const usersGrid = view.down('#usersGrid')
  const groupsGrid = view.down('#groupsGrid')
  usersGrid.fireEvent('afterrender', usersGrid)
  groupsGrid.fireEvent('afterrender', groupsGrid)
  await settle()
  return { view, usersGrid, groupsGrid }
}

async function shareUsersChecks() {
  const { usersGrid, groupsGrid } = await openUsersView()
  ok('users: both grids exist', !!usersGrid && !!groupsGrid)
  eq('users: the user rows loaded', usersGrid.getStore().getCount(), USER_ROWS.length)
  eq('groups: the group rows loaded', groupsGrid.getStore().getCount(), GROUP_ROWS.length)

  // --- (a) the client-side name rule mirrors the schema: mixed case legal ---
  jobs.length = 0
  warnings.length = 0
  findCmp(usersGrid, 'anas-btn-user-add').handler(null)
  await settle()
  let win = openWindow()
  ok('create: the New User dialog opened', !!win && !!win.down('#name'))
  if (win) {
    const nameField = win.down('#name')
    // The FIELD regex and the submit-handler regex are the same constant —
    // assert the constant through the field config.
    ok('create: the name rule accepts a mixed-case name', nameField.regex.test('Alice') === true)
    ok('create: the name rule still rejects a leading digit', nameField.regex.test('9bad') === false)
    ok('create: the name rule still rejects a leading dash', nameField.regex.test('-x') === false)
    ok('create: the name rule accepts a trailing $', nameField.regex.test('machine$') === true)
    ok('create: the field hint no longer says lowercase', !/lowercase/i.test(nameField.regexText), nameField.regexText)

    // The submit gate: an invalid name alerts (the NEW wording) and sends nothing.
    nameField.setValue('9bad')
    win.buttonCmps.find(b => b.cls === 'anas-btn-user-create-submit').handler(null)
    await settle()
    ok('create: an invalid name sends nothing', jobs.length === 0, JSON.stringify(jobs))
    ok('create: it alerts with the mixed-case wording',
      warnings.some(w => /Enter a valid username \(letters, digits, _ and -\)/.test(w)),
      JSON.stringify(warnings))

    // …and a mixed-case name does send, verbatim.
    nameField.setValue('Alice')
    win.buttonCmps.find(b => b.cls === 'anas-btn-user-create-submit').handler(null)
    await settle()
    eq('create: a mixed-case name POSTs verbatim',
      [jobs[0] && jobs[0].method, jobs[0] && jobs[0].path, jobs[0] && jobs[0].body],
      ['post', '/identity/users', { name: 'Alice' }])
    if (!win.destroyed) { win.close() }
  }

  // The group dialog carries the same rule and its own message.
  jobs.length = 0
  warnings.length = 0
  created.windows.length = 0
  findCmp(groupsGrid, 'anas-btn-group-add').handler(null)
  await settle()
  win = openWindow()
  ok('group create: the dialog opened', !!win && !!win.down('#name'))
  if (win) {
    const gname = win.down('#name')
    ok('group create: the name rule accepts a mixed-case name', gname.regex.test('Media') === true)
    ok('group create: the field hint no longer says lowercase', !/lowercase/i.test(gname.regexText), gname.regexText)
    gname.setValue('9bad')
    win.buttonCmps.find(b => b.cls === 'anas-btn-group-create-submit').handler(null)
    await settle()
    eq('group create: an invalid name sends nothing', jobs.length, 0)
    ok('group create: it alerts with the mixed-case wording',
      warnings.some(w => /Enter a valid group name \(letters, digits, _ and -\)/.test(w)),
      JSON.stringify(warnings))
    if (!win.destroyed) { win.close() }
  }

  // --- (c) the private-group label on the group Name cell -------------------
  const nameCol = groupsGrid.columns.find(c => c.dataIndex === 'name')
  ok('groups: the Name column has the private-group renderer', !!nameCol && typeof nameCol.renderer === 'function')
  const privCell = nameCol.renderer('alice', {}, makeRecord(GROUP_ROWS[0]))
  ok('groups: a private group is labelled as one', /private group of\s*Alice/.test(privCell), privCell)
  const plainCell = nameCol.renderer('smbusers', {}, makeRecord(GROUP_ROWS[1]))
  ok('groups: a plain group renders bare', plainCell === 'smbusers', plainCell)

  // --- (d) delete: need-gated, confirm-code flow, refresh --------------------
  // No selection: both Delete doors are dead.
  let state = toolbarState(usersGrid, ['userDelete'])
  ok('delete(user): no selection — Delete is disabled', state.userDelete.disabled === true)
  // A directory user: read-only, still dead.
  usersGrid.selectRow(1)
  state = toolbarState(usersGrid, ['userDelete', 'userSmbpw', 'userToggle'])
  ok('delete(user): a directory user — Delete is disabled', state.userDelete.disabled === true)
  ok('delete(user): the other mutations stay disabled too', state.userSmbpw.disabled === true && state.userToggle.disabled === true)
  // A LOCAL user: live.
  usersGrid.selectRow(0)
  state = toolbarState(usersGrid, ['userDelete'])
  ok('delete(user): a local user — Delete is enabled', state.userDelete.disabled === false)

  jobs.length = 0
  apiGets.length = 0
  usersGrid.down('#userDelete').handler(usersGrid.down('#userDelete'))
  await settle()
  eq('delete(user): exactly one request', jobs.length, 1)
  eq('delete(user): it DELETEs the selected user',
    [jobs[0] && jobs[0].method, jobs[0] && jobs[0].path],
    ['del', '/identity/users/Alice'])
  ok('delete(user): it goes through the CONFIRM-CODE flow with the widget window (same presentation as pool/dataset/share/LUN delete), not a plain job',
    jobs[0] && 'confirmWindow' in jobs[0] && jobs[0].confirmWindow === true,
    JSON.stringify(jobs[0] || {}))
  ok('delete(user): the grids REFRESH after the job is accepted',
    apiGets.includes('/identity/users') && apiGets.includes('/identity/groups'),
    JSON.stringify(apiGets))

  // The group door: local row live, directory row dead.
  groupsGrid.selectRow(2)
  state = toolbarState(groupsGrid, ['groupDelete'])
  ok('delete(group): a directory group — Delete is disabled', state.groupDelete.disabled === true)
  groupsGrid.selectRow(1)
  state = toolbarState(groupsGrid, ['groupDelete'])
  ok('delete(group): a local group — Delete is enabled', state.groupDelete.disabled === false)

  jobs.length = 0
  groupsGrid.down('#groupDelete').handler(groupsGrid.down('#groupDelete'))
  await settle()
  eq('delete(group): exactly one request', jobs.length, 1)
  eq('delete(group): it DELETEs the selected group',
    [jobs[0] && jobs[0].method, jobs[0] && jobs[0].path],
    ['del', '/identity/groups/smbusers'])
  ok('delete(group): it goes through the confirm-code flow with the widget window too',
    jobs[0] && 'confirmWindow' in jobs[0] && jobs[0].confirmWindow === true,
    JSON.stringify(jobs[0] || {}))
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
warnings.length = 0
created.windows.length = 0
await nestedScanRaceCheck()
warnings.length = 0
created.windows.length = 0
await restoreRepoNamespacePrefillCheck()
warnings.length = 0
created.windows.length = 0
await taskDoorOnDoneCheck()
warnings.length = 0
created.windows.length = 0
// Story selfheal.3 — the AHR scrub's findings on the Scrubs row, and the one
// window they open.
await scrubFindingsChecks()
warnings.length = 0
created.windows.length = 0
// Fourth pass — the unverified-window suffix is rendered in the bad-block cell.
await scrubUnverifiedWindowCheck()
// Design review 2026-09-14 — the parity line in the findings window (D1), and
// the AHR Snapshots manager's pin labelling + rollback warning (D15, S8).
warnings.length = 0
created.windows.length = 0
await scrubParityWindowCheck()
// Story selfheal.10 — the Rewrite parity action behind that indicator.
warnings.length = 0
created.windows.length = 0
await rewriteParityChecks()
warnings.length = 0
created.windows.length = 0
await rewriteParityRefusedChecks()
await rewriteParityMirrorChecks()
// Story selfheal.11 — Reconcile mirror, in that same window.
warnings.length = 0
created.windows.length = 0
await mirrorReconcileChecks()
warnings.length = 0
created.windows.length = 0
await mirrorReconcileRefusedChecks()
warnings.length = 0
created.windows.length = 0
await parityResidualFromRepairChecks()
warnings.length = 0
created.windows.length = 0
await ahrSnapshotPinChecks()
// Story selfheal.4 — the two-phase surface: phases + next run on the row, the
// cadence selector beside the toggle, the toggle body and its confirm.
warnings.length = 0
created.windows.length = 0
await scrubTwoPhaseChecks()
warnings.length = 0
created.windows.length = 0
// Story selfheal.6 — Repair from parity, in that same window.
await repairFromParityChecks()
warnings.length = 0
created.windows.length = 0
// Story selfheal.9 — Repair from parity on the Scrubs toolbar too, need-gated,
// one enablement rule for both doors.
await scrubToolbarRepairChecks()
// Disks (story 3.18) — the stale/standby marker on the Health cell.
warnings.length = 0
created.windows.length = 0
await disksStaleHealthChecks()
// Share Users (identity.1) — mixed-case name rule, need-gated confirm-gated
// delete on both grids, and the private-group label.
warnings.length = 0
created.windows.length = 0
await shareUsersChecks()

// ============================================================================
//  SMB Self-service (smbsvc.1) — the Previous Versions row: what the dialog
//  SENDS (the §2 set / keep contract), the greyed custom-`vfs objects` state,
//  the detail sentence, and reload on success AND failure
// ============================================================================

const SMB_SHARE = {
  name: 'media',
  path: '/tank/media',
  comment: null,
  browseable: true,
  readOnly: false,
  guestOk: false,
  validUsers: [],
  hostsAllow: [],
  hostsDeny: [],
}

function smbSelfServiceRoutes(shares, detail) {
  // The EDIT dialog opens on the share's DETAIL (smbsvc.3: it carries
  // `capacity`, the cap-suggestion input) — defaulting to the first share row
  // so the dialog's initial state matches what the row would show.
  const det = detail || { ...(shares[0] || SMB_SHARE), connections: [] }
  return {
    'GET /shares/smb': { data: shares },
    'GET /shares/nfs': { data: [] },
    'GET /identity/users': { data: [] },
    'GET /identity/groups': { data: [] },
    'GET /shares/smb/media': { data: det },
  }
}

async function openSharesView(routes) {
  // Real bundle order: 10-api.js carries ANAS.smb (the custom-vfs rule the
  // dialog's greyed state decides from), 70-shares.js the view.
  const ANAS = loadSource(['10-api.js', '70-shares.js'], routes)
  const view = makeComponent(ANAS.views.shares.factory('harness'), null)
  const grid = view.down('#sharesGrid')
  grid.fireEvent('afterrender', grid)
  await settle()
  return { ANAS, view, grid }
}

const smbSharesGets = () => apiGets.filter(p => p === '/shares/smb').length

/** Click a Shares toolbar button by cls — the handlers read btn.up('grid'). */
function clickTbar(grid, cls) {
  const b = findCmp(grid, cls)
  b.handler(b)
  return b
}

async function smbSelfServiceChecks() {
  // --- (a) CREATE: the fieldset frame, the fresh-enable note, and that a
  // ticked box sends { enabled: true } while an unticked one sends nothing.
  let { grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE]))
  clickTbar(grid, 'anas-btn-smb-add')
  await settle()
  let dlg = openWindow()
  ok('smb-self: the create dialog has the Self-service fieldset', !!dlg && !!dlg.down('#selfService'))
  let pv = dlg && dlg.down('#previousVersions')
  ok('smb-self: the Previous Versions box starts unticked and live',
    !!pv && pv.checked === false && pv.disabled === false)
  ok('smb-self: an unticked box shows no note',
    !!dlg && dlg.down('#previousVersionsNote').hidden === true)
  if (dlg && pv) {
    pv.setValue(true)
    const note = dlg.down('#previousVersionsNote')
    ok('smb-self: a fresh enable names the empty-until-a-schedule note',
      note.hidden === false && /finest snapshot schedule/.test(note.html)
        && /Snapshots menu/.test(note.html), note.html)
    dlg.down('#name').setValue('videos')
    dlg.down('#path').setValue('/tank/videos')
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-self: a ticked create sends previousVersions { enabled: true }',
      jobs[0] && jobs[0].body && jobs[0].body.previousVersions, { enabled: true })
  }
  created.windows.length = 0

  // …and an unticked create sends NO previousVersions key (omitted = keep).
  clickTbar(grid, 'anas-btn-smb-add')
  await settle()
  dlg = openWindow()
  if (dlg) {
    dlg.down('#name').setValue('videos')
    dlg.down('#path').setValue('/tank/videos')
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    ok('smb-self: an unticked create omits previousVersions',
      !!jobs[0] && !('previousVersions' in jobs[0].body), JSON.stringify(jobs[0] && jobs[0].body))
  }
  created.windows.length = 0

  // --- (b) EDIT, feature already on: the box starts ticked with the bucket
  // sentence; an untouched save sends NO previousVersions key and the SAME
  // body it always did (the byte-identical no-op); unticking sends
  // { enabled: false }.
  const pvOn = { ...SMB_SHARE, previousVersions: { bucket: 'hourly' } }
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([pvOn])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  pv = dlg && dlg.down('#previousVersions')
  ok('smb-self: an on share opens the edit box TICKED', !!pv && pv.checked === true)
  ok('smb-self: the ticked edit names the bucket schedule',
    !!dlg && dlg.down('#previousVersionsNote').hidden === false
      && /exposes the hourly schedule's snapshots/.test(dlg.down('#previousVersionsNote').html),
    dlg && dlg.down('#previousVersionsNote').html)
  if (dlg && pv) {
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-self: an untouched edit PUTs the body it always did (no previousVersions key)', jobs[0] && jobs[0].body, {
      path: '/tank/media',
      comment: '',
      browseable: true,
      readOnly: false,
      guestOk: false,
      validUsers: [],
      hostsAllow: [],
      hostsDeny: [],
    })

    // Untick → the explicit off.
    created.windows.length = 0
    clickTbar(grid, 'anas-btn-share-edit')
    await settle()
    dlg = openWindow()
    dlg.down('#previousVersions').setValue(false)
    ok('smb-self: unticking clears the note', dlg.down('#previousVersionsNote').hidden === true)
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-self: unticking sends previousVersions { enabled: false }',
      jobs[0] && jobs[0].body && jobs[0].body.previousVersions, { enabled: false })
  }
  created.windows.length = 0

  // --- (c) The greyed state: a hand-made `vfs objects` line disables the row
  // with the reason; an ANAS-composed line (the feature itself on) does NOT.
  const custom = { ...SMB_SHARE, name: 'media', vfsObjects: ['media_audit'] }
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([custom])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  pv = dlg && dlg.down('#previousVersions')
  ok('smb-self: a custom vfs objects line DISABLES the Previous Versions box', !!pv && pv.disabled === true)
  ok('smb-self: the greyed row carries the refusal sentence',
    !!dlg && dlg.down('#previousVersionsNote').hidden === false
      && /custom vfs objects line/.test(dlg.down('#previousVersionsNote').html),
    dlg && dlg.down('#previousVersionsNote').html)
  created.windows.length = 0

  const anasLine = {
    ...SMB_SHARE,
    vfsObjects: ['shadow_copy2'],
    previousVersions: { bucket: 'daily' },
  }
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([anasLine])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  pv = dlg && dlg.down('#previousVersions')
  ok('smb-self: an ANAS-composed vfs line does NOT grey the box', !!pv && pv.disabled === false)
  created.windows.length = 0

  // --- (d) The detail window: "Previous Versions: on — <bucket> schedule" / off.
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([pvOn])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-details')
  await settle()
  let dwin = openWindow()
  let summary = dwin && dwin.items.getAt(0) && dwin.items.getAt(0).html
  ok('smb-self(detail): an on share reads "on — <bucket> schedule"',
    /Previous Versions:<\/b> on — hourly schedule/.test(summary || ''), summary)
  created.windows.length = 0

  ;({ grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-details')
  await settle()
  dwin = openWindow()
  summary = dwin && dwin.items.getAt(0) && dwin.items.getAt(0).html
  ok('smb-self(detail): an off share reads "off"',
    /Previous Versions:<\/b> off/.test(summary || ''), summary)
  created.windows.length = 0

  // --- (e) Timeliness: the shares grid reloads after the job completes —
  // and after it FAILS (the daemon's refusal sentence rides the failure
  // alert; the reload is the dialog's own duty).
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  jobs.length = 0
  apiGets.length = 0
  dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
  await settle()
  ok('smb-self: the grid reloaded on SUCCESS', smbSharesGets() > 0, JSON.stringify(apiGets))
  if (typeof jobs[0].onFailed === 'function') {
    const afterSuccess = smbSharesGets()
    apiGets.length = 0
    jobs[0].onFailed({ error: { message: 'share \'media\' has a custom vfs objects line — remove it before enabling self-service features' } })
    await settle()
    ok('smb-self: the grid reloaded on FAILURE too', smbSharesGets() > 0, JSON.stringify(apiGets))
  } else {
    ok('smb-self: onFailed reaches the poll', false, 'no onFailed recorded')
  }
  created.windows.length = 0

  // …and the REMOVE flow (confirmAndRun) obeys the same rule.
  jobs.length = 0
  apiGets.length = 0
  clickTbar(grid, 'anas-btn-share-remove')
  await settle()
  ok('smb-self(remove): the grid reloaded on SUCCESS', smbSharesGets() > 0, JSON.stringify(apiGets))
  if (typeof jobs[0].onFailed === 'function') {
    apiGets.length = 0
    jobs[0].onFailed({ error: { message: 'smbshare removal failed' } })
    await settle()
    ok('smb-self(remove): the grid reloaded on FAILURE too', smbSharesGets() > 0, JSON.stringify(apiGets))
  } else {
    ok('smb-self(remove): onFailed reaches the poll', false, 'no onFailed recorded')
  }
  created.windows.length = 0

  // --- (f) Recycle bin (smbsvc.2): the row, the §2 set/keep contract on
  // purge age, the shared greyed state, and the detail sentences.
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE])))
  clickTbar(grid, 'anas-btn-smb-add')
  await settle()
  dlg = openWindow()
  let rc = dlg && dlg.down('#recycle')
  let rcPurge = dlg && dlg.down('#recyclePurge')
  ok('smb-recycle: the create dialog has the Recycle bin row',
    !!rc && !!rcPurge && rc.checked === false && rc.disabled === false
      && rcPurge.disabled === true, JSON.stringify({ rc: !!rc, purge: !!rcPurge }))
  ok('smb-recycle: the purge combo defaults to 30 days',
    !!rcPurge && rcPurge.getValue() === '30', rcPurge && rcPurge.getValue())
  if (dlg && rc) {
    rc.setValue(true)
    ok('smb-recycle: ticking enables the purge combo and shows the #recycle note',
      rcPurge.disabled === false && dlg.down('#recycleNote').hidden === false
        && /#recycle folder/.test(dlg.down('#recycleNote').html)
        && /Turning this off leaves #recycle in place/.test(dlg.down('#recycleNote').html),
      dlg.down('#recycleNote').html)
    dlg.down('#name').setValue('videos')
    dlg.down('#path').setValue('/tank/videos')
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-recycle: a ticked create sends recycle { purgeDays: 30 }',
      jobs[0] && jobs[0].body && jobs[0].body.recycle, { purgeDays: 30 })
  }
  created.windows.length = 0

  // EDIT on a share with the feature already on (the ANAS-composed line):
  // the box opens ticked with the stored age, an untouched save sends NO
  // recycle key and the byte-identical body, an age change sends the new
  // age, an untick sends null.
  const rcOn = { ...SMB_SHARE, vfsObjects: ['recycle'], recycle: { purgeDays: 30 } }
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([rcOn])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  rc = dlg && dlg.down('#recycle')
  rcPurge = dlg && dlg.down('#recyclePurge')
  ok('smb-recycle: an on share opens the edit box TICKED with the combo live',
    !!rc && rc.checked === true && rc.disabled === false
      && !!rcPurge && rcPurge.disabled === false)
  ok('smb-recycle: the purge combo reads the stored 30 days',
    !!rcPurge && rcPurge.getValue() === '30', rcPurge && rcPurge.getValue())
  if (dlg && rc) {
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    ok('smb-recycle: an untouched edit sends NO recycle key',
      !!jobs[0] && !('recycle' in jobs[0].body), JSON.stringify(jobs[0] && jobs[0].body))
    eq('smb-recycle: an untouched edit PUTs the body it always did', jobs[0] && jobs[0].body, {
      path: '/tank/media',
      comment: '',
      browseable: true,
      readOnly: false,
      guestOk: false,
      validUsers: [],
      hostsAllow: [],
      hostsDeny: [],
    })

    // Purge-age change on an already-on share → the new age (`never` = null).
    created.windows.length = 0
    clickTbar(grid, 'anas-btn-share-edit')
    await settle()
    dlg = openWindow()
    dlg.down('#recyclePurge').setValue('never')
    ok('smb-recycle: choosing never keeps the note up',
      dlg.down('#recycleNote').hidden === false)
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-recycle: changing the purge age to never sends recycle { purgeDays: null }',
      jobs[0] && jobs[0].body && jobs[0].body.recycle, { purgeDays: null })

    // Untick → the explicit off.
    created.windows.length = 0
    clickTbar(grid, 'anas-btn-share-edit')
    await settle()
    dlg = openWindow()
    dlg.down('#recycle').setValue(false)
    ok('smb-recycle: unticking hides the note and disables the combo',
      dlg.down('#recycleNote').hidden === true
        && dlg.down('#recyclePurge').disabled === true)
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-recycle: unticking sends recycle null',
      jobs[0] && jobs[0].body && jobs[0].body.recycle, null)
  }
  created.windows.length = 0

  // The greyed state: a hand-made `vfs objects` line disables BOTH rows,
  // each carrying the SAME refusal sentence.
  const rcCustom = { ...SMB_SHARE, vfsObjects: ['media_audit'] }
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([rcCustom])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  rc = dlg && dlg.down('#recycle')
  ok('smb-recycle: a custom vfs objects line DISABLES the Recycle bin row',
    !!rc && rc.disabled === true && dlg.down('#recyclePurge').disabled === true)
  ok('smb-recycle: the greyed row carries the SAME refusal sentence as Previous Versions',
    !!dlg && dlg.down('#recycleNote').hidden === false
      && /custom vfs objects line/.test(dlg.down('#recycleNote').html)
      && /custom vfs objects line/.test(dlg.down('#previousVersionsNote').html),
    dlg && dlg.down('#recycleNote').html)
  created.windows.length = 0

  // The detail window: "Recycle bin: on — purge after 30 days" /
  // "on — never purged" / "off".
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([
    { ...SMB_SHARE, recycle: { purgeDays: 30 } },
  ])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-details')
  await settle()
  dwin = openWindow()
  summary = dwin && dwin.items.getAt(0) && dwin.items.getAt(0).html
  ok('smb-recycle(detail): an on share reads "on — purge after 30 days"',
    /Recycle bin:<\/b> on — purge after 30 days/.test(summary || ''), summary)
  created.windows.length = 0

  ;({ grid } = await openSharesView(smbSelfServiceRoutes([
    { ...SMB_SHARE, recycle: { purgeDays: null } },
  ])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-details')
  await settle()
  dwin = openWindow()
  summary = dwin && dwin.items.getAt(0) && dwin.items.getAt(0).html
  ok('smb-recycle(detail): a never-purged share reads "on — never purged"',
    /Recycle bin:<\/b> on — never purged/.test(summary || ''), summary)
  created.windows.length = 0

  ;({ grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-details')
  await settle()
  dwin = openWindow()
  summary = dwin && dwin.items.getAt(0) && dwin.items.getAt(0).html
  ok('smb-recycle(detail): an off share reads "off"',
    /Recycle bin:<\/b> off/.test(summary || ''), summary)
  created.windows.length = 0

  // --- (g) Time Machine target (smbsvc.3, BETA): the row, the required cap
  // (empty refused before anything is sent), the capacity prefill, the §2
  // set/keep contract, the shared greyed state, and the detail sentence.
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE])))
  clickTbar(grid, 'anas-btn-smb-add')
  await settle()
  dlg = openWindow()
  let tm = dlg && dlg.down('#timeMachine')
  let tmSize = dlg && dlg.down('#timeMachineSize')
  let tmUnit = dlg && dlg.down('#timeMachineUnit')
  ok('smb-tm: the create dialog has the Time Machine (beta) row',
    !!tm && !!tmSize && !!tmUnit && tm.checked === false && tm.disabled === false
      && tmSize.disabled === true && tmUnit.disabled === true
      && tmUnit.getValue() === 'G',
    JSON.stringify({ tm: !!tm, size: !!tmSize, unit: tmUnit && tmUnit.getValue() }))
  ok('smb-tm: an unticked box shows no note', !!dlg && dlg.down('#timeMachineNote').hidden === true)
  if (dlg && tm) {
    tm.setValue(true)
    ok('smb-tm: ticking shows the note (dedicated share, tmutil, beta) and enables the cap field',
      dlg.down('#timeMachineNote').hidden === false
        && /Dedicate this share to Time Machine/.test(dlg.down('#timeMachineNote').html)
        && /tmutil setdestination/.test(dlg.down('#timeMachineNote').html)
        && /community-verified/.test(dlg.down('#timeMachineNote').html)
        && tmSize.disabled === false && tmUnit.disabled === false,
      dlg.down('#timeMachineNote').html)
    // A create has no capacity to read — the suggestion cannot fill the field,
    // and the REQUIRED cap is refused before anything is sent.
    dlg.down('#name').setValue('videos')
    dlg.down('#path').setValue('/tank/videos')
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    ok('smb-tm: an empty cap is refused with an alert and NO job',
      warnings.length === 1 && /size cap/.test(warnings[0]) && jobs.length === 0,
      JSON.stringify({ warnings: warnings.slice(), jobs: jobs.length }))
    warnings.length = 0
    tmSize.setValue(500)
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-tm: a ticked create sends timeMachine { maxSize: 500 GiB }',
      jobs[0] && jobs[0].body && jobs[0].body.timeMachine, { maxSize: 536870912000 })
  }
  created.windows.length = 0

  // EDIT on a share with the feature already on: the box opens ticked with the
  // stored cap split into the field (500 + G), an untouched save sends NO
  // timeMachine key and the byte-identical body, a cap change sends the new
  // cap, an untick sends null.
  const tmOn = { ...SMB_SHARE, vfsObjects: ['catia', 'fruit', 'streams_xattr'], timeMachine: { maxSize: 536870912000 } }
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([tmOn])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  tm = dlg && dlg.down('#timeMachine')
  tmSize = dlg && dlg.down('#timeMachineSize')
  tmUnit = dlg && dlg.down('#timeMachineUnit')
  ok('smb-tm: an on share opens the edit box TICKED with the cap field live',
    !!tm && tm.checked === true && tm.disabled === false
      && !!tmSize && tmSize.disabled === false
      && !!tmUnit && tmUnit.disabled === false)
  ok('smb-tm: the cap field reads the stored 500 GiB', !!tmSize && tmSize.getValue() === 500 && tmUnit.getValue() === 'G',
    JSON.stringify({ size: tmSize && tmSize.getValue(), unit: tmUnit && tmUnit.getValue() }))
  ok('smb-tm: the note is up on a ticked edit', !!dlg && dlg.down('#timeMachineNote').hidden === false)
  if (dlg && tm) {
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    ok('smb-tm: an untouched edit sends NO timeMachine key',
      !!jobs[0] && !('timeMachine' in jobs[0].body), JSON.stringify(jobs[0] && jobs[0].body))

    // Cap change on an already-on share → the new cap.
    created.windows.length = 0
    clickTbar(grid, 'anas-btn-share-edit')
    await settle()
    dlg = openWindow()
    dlg.down('#timeMachineSize').setValue(250)
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-tm: changing the cap sends timeMachine { maxSize: 250 GiB }',
      jobs[0] && jobs[0].body && jobs[0].body.timeMachine, { maxSize: 268435456000 })

    // Untick → the explicit off.
    created.windows.length = 0
    clickTbar(grid, 'anas-btn-share-edit')
    await settle()
    dlg = openWindow()
    dlg.down('#timeMachine').setValue(false)
    ok('smb-tm: unticking hides the note and disables the cap field',
      dlg.down('#timeMachineNote').hidden === true
        && dlg.down('#timeMachineSize').disabled === true)
    jobs.length = 0
    dlg.buttonCmps.find(b => b.cls === 'anas-btn-smb-share-submit').handler(null)
    await settle()
    eq('smb-tm: unticking sends timeMachine null',
      jobs[0] && jobs[0].body && jobs[0].body.timeMachine, null)
  }
  created.windows.length = 0

  // The capacity prefill (smbsvc.3): an EDIT whose detail carries capacity —
  // ticking an empty cap field prefills HALF the available bytes floored to
  // whole GiB; a filled field is never overwritten.
  const capDetail = { ...SMB_SHARE, connections: [], capacity: { availableBytes: 2 * 1024 ** 4 } }
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE], capDetail)))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  tm = dlg && dlg.down('#timeMachine')
  tmSize = dlg && dlg.down('#timeMachineSize')
  ok('smb-tm: an edit with capacity opens the cap field EMPTY', !!tmSize && !tmSize.getValue())
  if (dlg && tm) {
    tm.setValue(true)
    ok('smb-tm: ticking prefills HALF the available space in GiB',
      tmSize.getValue() === 1024 && dlg.down('#timeMachineUnit').getValue() === 'G',
      JSON.stringify({ size: tmSize.getValue(), unit: dlg.down('#timeMachineUnit').getValue() }))
    tmSize.setValue('') // the suggestion never overwrites a filled field
    tm.setValue(false)
    tm.setValue(true)
    ok('smb-tm: the suggestion refills a re-ticked empty field',
      tmSize.getValue() === 1024)
  }
  created.windows.length = 0

  // The greyed state: the SAME custom-`vfs objects` rule as the other rows.
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([rcCustom])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-edit')
  await settle()
  dlg = openWindow()
  tm = dlg && dlg.down('#timeMachine')
  ok('smb-tm: a custom vfs objects line DISABLES the row',
    !!tm && tm.disabled === true && dlg.down('#timeMachineSize').disabled === true)
  ok('smb-tm: the greyed row carries the SAME refusal sentence',
    !!dlg && dlg.down('#timeMachineNote').hidden === false
      && /custom vfs objects line/.test(dlg.down('#timeMachineNote').html),
    dlg && dlg.down('#timeMachineNote').html)
  created.windows.length = 0

  // The detail window: "Time Machine target (beta): on — cap 500 GiB" / off.
  ;({ grid } = await openSharesView(smbSelfServiceRoutes([tmOn])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-details')
  await settle()
  dwin = openWindow()
  summary = dwin && dwin.items.getAt(0) && dwin.items.getAt(0).html
  ok('smb-tm(detail): an on share reads "on — cap 500 GiB"',
    /Time Machine target \(beta\):<\/b> on — cap 500 GiB/.test(summary || ''), summary)
  created.windows.length = 0

  ;({ grid } = await openSharesView(smbSelfServiceRoutes([SMB_SHARE])))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-share-details')
  await settle()
  dwin = openWindow()
  summary = dwin && dwin.items.getAt(0) && dwin.items.getAt(0).html
  ok('smb-tm(detail): an off share reads "off"',
    /Time Machine target \(beta\):<\/b> off/.test(summary || ''), summary)
  created.windows.length = 0

  ok('smb-self: nothing warned', warnings.length === 0, warnings.join(' | '))
}

// Story smbsvc.1 — the SMB dialog's Self-service fieldset (Previous Versions):
// set/keep on the wire, the custom-vfs greyed state, the detail sentence, and
// reload on success AND failure.
warnings.length = 0
created.windows.length = 0
await smbSelfServiceChecks()

// ---- Story vdevs.2 — the Pools toolbar's "Remove vdev…" dialog ------------
//
// The picker must offer the three classes `zpool remove` drops instantly and
// NOTHING else, say so where the operator can read it, and send the vdev name
// the daemon resolves. The grid AND the pool detail reload afterwards, success
// or failure.

/** A leaf as the pool detail carries one (the parser's PoolDisk shape). */
function vdevLeaf(id, state) {
  return {
    id,
    path: `/dev/disk/by-id/${id}-part1`,
    state: state || 'ONLINE',
    readErrors: 0,
    writeErrors: 0,
    checksumErrors: 0,
    slowIos: 0,
  }
}

function vdevOf(name, type, disks, state) {
  return { name, type, state: state || 'ONLINE', readErrors: 0, writeErrors: 0, checksumErrors: 0, disks }
}

/** A pool with all six classes — a mirrored log, a bare cache, a bare spare. */
const SIX_CLASS_DETAIL = {
  name: 'tank',
  state: 'ONLINE',
  vdevGroups: [
    { role: 'data', vdevs: [vdevOf('mirror-0', 'mirror', [vdevLeaf('ata-DATA-1'), vdevLeaf('ata-DATA-2')])] },
    { role: 'log', vdevs: [vdevOf('mirror-1', 'mirror', [vdevLeaf('ata-LOG-1'), vdevLeaf('ata-LOG-2')])] },
    { role: 'cache', vdevs: [vdevOf('cache', 'disk', [vdevLeaf('ata-CACHE-1')])] },
    { role: 'spare', vdevs: [vdevOf('spares', 'spare', [vdevLeaf('ata-SPARE-1', 'AVAIL')], 'AVAIL')] },
    { role: 'special', vdevs: [vdevOf('mirror-2', 'mirror', [vdevLeaf('ata-SPEC-1'), vdevLeaf('ata-SPEC-2')])] },
    { role: 'dedup', vdevs: [vdevOf('mirror-3', 'mirror', [vdevLeaf('ata-DEDUP-1'), vdevLeaf('ata-DEDUP-2')])] },
  ],
}

/** The same pool with nothing removable on it. */
const NO_REMOVABLE_DETAIL = {
  name: 'tank',
  state: 'ONLINE',
  vdevGroups: [
    { role: 'data', vdevs: [vdevOf('mirror-0', 'mirror', [vdevLeaf('ata-DATA-1'), vdevLeaf('ata-DATA-2')])] },
    { role: 'special', vdevs: [vdevOf('mirror-2', 'mirror', [vdevLeaf('ata-SPEC-1'), vdevLeaf('ata-SPEC-2')])] },
  ],
}

async function openPoolsViewFor(rows, detail) {
  // 00-core.js too: check (e) opens the pool-detail window, whose summary calls
  // the real formatters (formatPercent) the recording stub does not carry.
  const ANAS = loadSources(['00-core.js', '15-gfx.js', '30-pools.js', '34-pool-vdev-remove.js'], {
    'GET /pools': { data: rows },
    'GET /pools/tank': { data: detail },
  })
  const view = makeComponent(ANAS.views.pools.factory('harness'), null)
  const grid = view.itemId === 'poolsGrid' ? view : view.down('#poolsGrid')
  grid.fireEvent('afterrender', grid)
  await settle()
  return { ANAS, grid }
}

const tankDetailGets = () => apiGets.filter(p => p === '/pools/tank').length

async function vdevRemoveChecks() {
  // --- (a) the toolbar action: selection-gated, hands off a PVE-managed pool.
  let { grid } = await openPoolsViewFor([poolRow('tank'), poolRow('pvepool', { pveStorages: [{ storage: 'local-zfs', type: 'zfspool' }] })], SIX_CLASS_DETAIL)
  let state = toolbar(grid, ['removeVdev'])
  ok('vdev-remove: the Remove vdev… button exists', !!state.removeVdev, JSON.stringify(warnings))
  if (!state.removeVdev) { return }
  ok('vdev-remove: it starts DISABLED with no selection', state.removeVdev.disabled === true)

  grid.selectRow(grid.getStore().findExact('name', 'tank'))
  state = toolbar(grid, ['removeVdev'])
  ok('vdev-remove: an ANAS pool ENABLES it', state.removeVdev.disabled === false)

  grid.selectRow(grid.getStore().findExact('name', 'pvepool'))
  state = toolbar(grid, ['removeVdev'])
  ok('vdev-remove: a PVE-managed pool DISABLES it', state.removeVdev.disabled === true)
  ok('vdev-remove: and says why', /PVE manages this pool/.test(state.removeVdev.tip), state.removeVdev.tip)

  // --- (b) the dialog lists ONLY cache/log/spare, and says so.
  grid.selectRow(grid.getStore().findExact('name', 'tank'))
  clickTbar(grid, 'anas-btn-vdev-remove')
  await settle()
  let dlg = openWindow()
  let vgrid = dlg && dlg.down('#removableVdevs')
  ok('vdev-remove: the dialog opened with a vdev grid', !!vgrid)
  if (!vgrid) { return }
  const rows = vgrid.getStore().getRange().map(r => ({ role: r.get('role'), vdev: r.get('vdev') }))
  eq('vdev-remove: only cache, log and spare are listed — the mirrored log as mirror-N', rows, [
    { role: 'log', vdev: 'mirror-1' },
    { role: 'cache', vdev: 'ata-CACHE-1' },
    { role: 'spare', vdev: 'ata-SPARE-1' },
  ])
  ok('vdev-remove: the refusal sentence is on the dialog',
    /Data, special and dedup vdevs cannot be removed here\./.test(dlg.down('#vdevRemoveNote').html || ''),
    dlg.down('#vdevRemoveNote').html)

  // --- (c) the submit payload: the vdev NAME, nothing else.
  jobs.length = 0
  const beforePools = poolsGets()
  vgrid.selectRow(0)
  findCmp(dlg, 'anas-btn-vdev-remove-submit').handler()
  await settle()
  eq('vdev-remove: it POSTs the pool\'s remove path with just the vdev name',
    { method: jobs[0] && jobs[0].method, path: jobs[0] && jobs[0].path, body: jobs[0] && jobs[0].body },
    { method: 'post', path: '/pools/tank/vdevs/remove', body: { vdev: 'mirror-1' } })
  ok('vdev-remove: the dialog closes on success', dlg.destroyed === true)
  ok('vdev-remove: and the Pools grid reloads', poolsGets() > beforePools)

  // --- (d) reload on FAILURE too: a refused removal must not leave a stale view.
  created.windows.length = 0
  grid.selectRow(grid.getStore().findExact('name', 'tank'))
  clickTbar(grid, 'anas-btn-vdev-remove')
  await settle()
  dlg = openWindow()
  vgrid = dlg.down('#removableVdevs')
  jobs.length = 0
  vgrid.selectRow(1)
  findCmp(dlg, 'anas-btn-vdev-remove-submit').handler()
  await settle()
  eq('vdev-remove: a cache leaf goes out by its leaf name', jobs[0] && jobs[0].body, { vdev: 'ata-CACHE-1' })
  const beforeFail = poolsGets()
  jobs[0].onFailed({ error: { message: 'data, special and dedup vdevs cannot be removed here' } })
  await settle()
  ok('vdev-remove: the grid reloads on failure as well', poolsGets() > beforeFail)

  // --- (e) the pool DETAIL behind the dialog reloads too.
  created.windows.length = 0
  grid.selectRow(grid.getStore().findExact('name', 'tank'))
  const detailBtn = grid.down('#detail')
  detailBtn.handler(detailBtn)
  await settle()
  const beforeDetail = tankDetailGets()
  clickTbar(grid, 'anas-btn-vdev-remove')
  await settle()
  dlg = openWindow()
  dlg.down('#removableVdevs').selectRow(0)
  jobs.length = 0
  findCmp(dlg, 'anas-btn-vdev-remove-submit').handler()
  await settle()
  ok('vdev-remove: the open pool detail reloads after the job',
    tankDetailGets() > beforeDetail + 1, `${beforeDetail} → ${tankDetailGets()}`)

  // --- (f) a pool with nothing removable: an empty grid that says so.
  created.windows.length = 0
  ;({ grid } = await openPoolsViewFor([poolRow('tank')], NO_REMOVABLE_DETAIL))
  grid.selectRow(0)
  clickTbar(grid, 'anas-btn-vdev-remove')
  await settle()
  dlg = openWindow()
  vgrid = dlg.down('#removableVdevs')
  eq('vdev-remove: a pool with no cache/log/spare lists nothing', vgrid.getStore().getCount(), 0)
  ok('vdev-remove: and the empty state says why',
    /no cache, log or spare vdev to remove/.test(vgrid.emptyText || ''), vgrid.emptyText)

  ok('vdev-remove: nothing warned', warnings.length === 0, warnings.join(' | '))
}

warnings.length = 0
created.windows.length = 0
await vdevRemoveChecks()

if (failures.length) {
  console.error(`\n✖ ${failures.length} of ${checks} checks failed:\n`)
  for (const f of failures) { console.error(`  • ${f}`) }
  process.exit(1)
}
console.log(`✔ dialog contracts: ${checks} checks passed`)
