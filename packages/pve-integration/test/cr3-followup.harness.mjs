#!/usr/bin/env node
/*
 * ANAS — cr3.followup panel harness (the items that fell between the cr3 fix
 * lanes, 2026-11-14).
 *
 * Loads the REAL panel sources in a vm sandbox (the cr3-datasets harness's
 * permissive Ext stub) and checks:
 *
 *   • Item 2, Scrubs (69-scrubs.js) renders what the self-heal lane returns:
 *     a scrub whose checksum pass has no verdict (`btrfsUnproven`) never
 *     reads clean and keeps Rewrite parity / Reconcile mirror dark; the
 *     not-examined codes `no-checksum` and `write-unconfirmed`; a repaired
 *     block whose post-check was skipped; `array-rebuilds-rot`'s own
 *     sentence on the restore list; a `scrub-unproven` refusal; a mirror
 *     reconcile's `writtenAt`; and the writing verbs gated on an `unknown`
 *     (or unreadable) AHR pool state. Every daemon string is encoded.
 *   • Item 3, Import (33-pool-import.js): `unreadableEntries` are shown,
 *     encoded, and an empty importable list beside them never reads "No
 *     importable pools found" alone.
 *   • Item 4: ONE panel `isComposableDisk`, answering exactly what the shared
 *     `isComposableDisk` answers over the shared tests' table of disks.
 *
 *   node packages/pve-integration/test/cr3-followup.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { isComposableDisk as sharedIsComposableDisk, SELFHEAL_ARRAY_REBUILDS_ROT, SELFHEAL_NO_CHECKSUM, SELFHEAL_NOT_EXAMINED_REASONS, SELFHEAL_RUN_STOPPED, SELFHEAL_WRITE_UNCONFIRMED } from '@anas/shared'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

let checks = 0
const failures = []
function ok(name, cond, detail) {
  checks++
  if (!cond) { failures.push(detail === undefined ? name : `${name} — ${detail}`) }
}

function htmlEncode(v) {
  return String(v).replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function permissive() {
  const fn = function () { return proxy }
  const proxy = new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) { return () => '' }
      if (key === 'then') { return undefined }
      if (key === 'String') { return { htmlEncode } }
      return proxy
    },
    apply() { return proxy },
    construct() { return proxy },
  })
  return proxy
}

function loadUi(files, ext) {
  const doc = {
    hidden: false,
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    getElementsByTagName: () => [{ appendChild() {} }],
    createTextNode: text => ({ text }),
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  }
  const win = { document: doc }
  const sandbox = {
    window: win,
    document: doc,
    Ext: ext || permissive(),
    console,
    Promise,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }
  for (const file of files)
    vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  return win.ANAS
}

/** A daemon string that must reach the page as text. */
const XSS = '<img src=x onerror=alert(1)>'
const XSS_ENC = '&lt;img src=x onerror=alert(1)&gt;'

/** A grid record stand-in. */
function rec(fields) {
  return { get: k => fields[k], store: null }
}

function button() {
  const b = { disabled: false, text: '', tip: null }
  b.setDisabled = (d) => { b.disabled = !!d }
  b.setText = (x) => { b.text = x }
  b.setIconCls = () => {}
  b.setTooltip = (x) => { b.tip = x }
  return b
}

function panelWin(id) {
  const panel = { html: '', setHidden() {}, update(h) { panel.html = h } }
  return { panel, win: { down: q => (q === id ? panel : null) } }
}

// ===========================================================================
// Item 2 — Scrubs
// ===========================================================================
{
  const ANAS = loadUi(['00-core.js', '10-api.js', '69-schedules-common.js', '69-scrubs.js'])
  const S = ANAS.scrubs || {}
  const hooks = ['scrubRow', 'renderLastScrub', 'updateButtons', 'showRepairResult', 'showMirrorResult', 'showParityResult', 'updateRepairButton', 'updateParityButton', 'fileOutcome']
  ok('scrubs: the cr3.followup hooks are reachable', hooks.every(k => typeof S[k] === 'function'), hooks.filter(k => typeof S[k] !== 'function').join(', '))

  // ---- the panel's code spellings are the shared ones -------------------------
  const codes = S.notExaminedCodes || {}
  ok('scrubs: the panel\'s not-examined codes are exactly the shared SELFHEAL_NOT_EXAMINED_REASONS',
    JSON.stringify(Object.keys(codes).sort()) === JSON.stringify([...SELFHEAL_NOT_EXAMINED_REASONS].sort()),
    `${JSON.stringify(Object.keys(codes).sort())} vs ${JSON.stringify([...SELFHEAL_NOT_EXAMINED_REASONS].sort())}`)
  const scrubsSrc = readFileSync(join(SRC, '69-scrubs.js'), 'utf8')
  for (const [name, value] of [['RUN_STOPPED', SELFHEAL_RUN_STOPPED], ['WRITE_UNCONFIRMED', SELFHEAL_WRITE_UNCONFIRMED], ['NO_CHECKSUM', SELFHEAL_NO_CHECKSUM], ['ARRAY_REBUILDS_ROT', SELFHEAL_ARRAY_REBUILDS_ROT]])
    ok(`scrubs: var ${name} spells the shared '${value}'`, scrubsSrc.includes(`var ${name} = '${value}';`))
  ok('scrubs: var SCRUB_UNPROVEN spells the shared reason code', scrubsSrc.includes('var SCRUB_UNPROVEN = \'scrub-unproven\';'))

  const ahrState = extra => ({ target: { kind: 'ahr', pool: 'ahr0' }, enabled: true, cadence: 'monthly', mechanism: 'anas-scrub-timer', lastScrub: null, phases: ['md-parity', 'btrfs-checksums'], ...extra })
  const scrubJob = result => ({ ahr0: { at: 1, result: { scrubbed: 'ahr0', btrfsErrors: null, checkedArrays: 2, ...result } } })
  const healthy = { ahr0: 'healthy' }

  if (typeof S.scrubRow === 'function' && typeof S.renderLastScrub === 'function') {
    // ---- (a) btrfsUnproven: never clean -----------------------------------------
    const unprovenRow = S.scrubRow(ahrState({}), scrubJob({ btrfsUnproven: `a scrub was already running ${XSS}` }), {}, healthy)
    ok('(a) the row carries btrfsUnproven from the newest completed scrub', /already running/.test(String(unprovenRow.btrfsUnproven)))
    const cell = S.renderLastScrub(null, {}, rec(unprovenRow))
    ok('(a) the Last scrub cell says "checksum pass: no verdict"', /checksum pass: no verdict/.test(cell), cell)
    ok('(a) ...with the daemon\'s reason, encoded', cell.includes(XSS_ENC) && !cell.includes('<img'), cell)
    ok('(a) ...never the clean-shaped "md keeps no completion record" line', !/md keeps no completion record/.test(cell), cell)
    const cleanRow = S.scrubRow(ahrState({}), scrubJob({}), {}, healthy)
    ok('(a) a scrub WITH a verdict carries no unproven mark', cleanRow.btrfsUnproven === null)
    ok('(a) ...and its cell has no "no verdict"', !/no verdict/.test(S.renderLastScrub(null, {}, rec(cleanRow))))
    // Parity rows beside an unproven pass: the tip never claims the data is intact.
    const parityRow = { ...unprovenRow, parity: [{ band: 'ahr0-r1', bandIndex: 1, mismatchCnt: 3, level: 'raid5' }] }
    const pcell = S.renderLastScrub(null, {}, rec(parityRow))
    ok('(a) the parity tip on an unproven pass does not say the checksum scrub found no corrupt files', !/found no corrupt\s+files/.test(pcell) && /no\s+verdict/.test(pcell), pcell)
  }

  // ---- (a+) an unproven pass never displaces earlier findings ----------------
  if (typeof S.latestScrubByPool === 'function') {
    const job = (id, at, status, result) => ({ id, operation: 'ahr.scrub', status, completedAt: at, createdAt: at, result, detail: { pool: 'ahr0' } })
    const finding = { path: '/mnt/anas-ahr/ahr0/@data/f', inode: 7, badBlocks: [3] }
    const FOUND = job('j1', '2026-11-10T00:00:00.000Z', 'completed', { scrubbed: 'ahr0', btrfsErrors: 'csum=1', checkedArrays: 2, findings: [finding] })
    const UNPROVEN = job('j2', '2026-11-12T00:00:00.000Z', 'completed', { scrubbed: 'ahr0', btrfsErrors: null, checkedArrays: 2, btrfsUnproven: 'a scrub was already running', bandsSkipped: [{ band: 'ahr0-r2', reason: 'froze' }] })
    const CLEAN = job('j3', '2026-11-13T00:00:00.000Z', 'completed', { scrubbed: 'ahr0', btrfsErrors: null, checkedArrays: 2 })
    const rowOf = jobs => S.scrubRow(ahrState({}), S.latestScrubByPool({ data: jobs }), {}, healthy)
    const held = rowOf([UNPROVEN, FOUND])
    ok('(a+) a newer unproven scrub keeps the earlier scrub\'s findings on the row', !!held.findings && held.findings.result.findings.length === 1)
    ok('(a+) ...and the row still says the newest pass had no verdict', held.btrfsUnproven === 'a scrub was already running')
    ok('(a+) ...with the newest pass\'s own phase-1 facts (its skipped band)', !!held.skipped && held.skipped[0].band === 'ahr0-r2')
    const heldCell = S.renderLastScrub(null, {}, rec(held))
    ok('(a+) the cell says both: no verdict, and the files', /checksum pass: no verdict/.test(heldCell) && /1 file with checksum errors/.test(heldCell), heldCell)
    ok('(a+) ...and the findings link says an earlier scrub found them', /an earlier AHR scrub found checksum errors/.test(heldCell), heldCell)
    const twice = rowOf([FOUND, UNPROVEN, job('j2b', '2026-11-12T12:00:00.000Z', 'completed', { ...UNPROVEN.result })])
    ok('(a+) two unproven passes in a row still keep the findings', !!twice.findings)
    const cleared = rowOf([FOUND, UNPROVEN, CLEAN])
    ok('(a+) control: a later scrub WITH a verdict still displaces them', cleared.findings === null && cleared.btrfsUnproven === null)
    const order = rowOf([FOUND, UNPROVEN])
    ok('(a+) the job order in the list does not matter', !!order.findings && order.btrfsUnproven !== null)
  }

  // ---- (a)/(f) the band verbs are dark on an unproven pass -------------------
  if (typeof S.updateParityButton === 'function') {
    const bandWin = (extra, level) => {
      const items = { '#rewriteParity': button(), '#reconcileMirror': button() }
      const sel = [rec({ bandIndex: 1, level, mismatchCnt: 2 })]
      items['#parityGrid'] = { getSelection: () => sel }
      return { items, win: { down: id => items[id] || null, ...extra } }
    }
    const p = bandWin({ anasUnproven: `no state ${XSS}`, anasPoolState: 'healthy' }, 'raid5')
    S.updateParityButton(p.win, false)
    ok('(f) Rewrite parity is dark when the last checksum pass had no verdict', p.items['#rewriteParity'].disabled === true)
    ok('(f) ...and says why, with the daemon\'s reason encoded', /checksum pass delivered no verdict/.test(String(p.items['#rewriteParity'].tip)) && String(p.items['#rewriteParity'].tip).includes(XSS_ENC), String(p.items['#rewriteParity'].tip))
    const m = bandWin({ anasUnproven: 'canceled', anasPoolState: 'healthy' }, 'raid1')
    S.updateParityButton(m.win, false)
    ok('(f) Reconcile mirror is dark too', m.items['#reconcileMirror'].disabled === true && /no verdict/.test(String(m.items['#reconcileMirror'].tip)))
    const c = bandWin({ anasPoolState: 'healthy' }, 'raid5')
    S.updateParityButton(c.win, false)
    ok('(f) control: a proven pass and a healthy pool light Rewrite parity', c.items['#rewriteParity'].disabled === false, String(c.items['#rewriteParity'].tip))
    const u = bandWin({ anasPoolState: 'unknown' }, 'raid5')
    S.updateParityButton(u.win, false)
    ok('(h) Rewrite parity is dark on an unknown pool state, with the state as the reason', u.items['#rewriteParity'].disabled === true && /pool state: unknown/.test(String(u.items['#rewriteParity'].tip)), String(u.items['#rewriteParity'].tip))
  }

  // ---- (h) Repair gated on the pool state ------------------------------------
  if (typeof S.updateButtons === 'function') {
    const finding = { path: '/mnt/anas-ahr/ahr0/@data/f', inode: 7, badBlocks: [3] }
    const grid = (r) => {
      const items = { '#scrubToggle': button(), '#scrubRun': button(), '#scrubStop': button(), '#scrubRepair': button() }
      return { items, down: id => items[id] || null, getSelection: () => [r], getStore: () => ({ each: (f) => { f(r) } }) }
    }
    const withState = states => rec(S.scrubRow(ahrState({}), scrubJob({ btrfsErrors: 'csum=1', findings: [finding] }), {}, states))
    const gu = grid(withState({ ahr0: 'unknown' }))
    S.updateButtons(gu)
    ok('(h) Repair is disabled when the pool state is unknown', gu.items['#scrubRepair'].disabled === true)
    ok('(h) ...with the state as the reason', /pool state: unknown/.test(String(gu.items['#scrubRepair'].tip)), String(gu.items['#scrubRepair'].tip))
    const gn = grid(withState(null))
    S.updateButtons(gn)
    ok('(h) Repair is disabled when GET /ahr could not be read', gn.items['#scrubRepair'].disabled === true && /could not be read/.test(String(gn.items['#scrubRepair'].tip)), String(gn.items['#scrubRepair'].tip))
    const gh = grid(withState({ ahr0: 'healthy' }))
    S.updateButtons(gh)
    ok('(h) control: a healthy pool with a repairable finding lights Repair', gh.items['#scrubRepair'].disabled === false, String(gh.items['#scrubRepair'].tip))

    // The findings window's own Repair button reads the same gate.
    const winFor = (state) => {
      const btn = button()
      const sel = [rec({ path: '/f', inode: 7, blocks: 1, blockArray: [3], missing: false, outsideMount: false, unidentified: false, compressed: false })]
      const fg = { getSelection: () => sel }
      return { btn, win: { anasPoolState: state, down: id => (id === '#repairFromParity' ? btn : (id === '#findingsGrid' ? fg : null)) } }
    }
    if (typeof S.updateRepairButton === 'function') {
      const wu = winFor('unknown')
      S.updateRepairButton(wu.win)
      ok('(h) the findings window\'s Repair is dark on an unknown pool state', wu.btn.disabled === true && /pool state: unknown/.test(String(wu.btn.tip)), String(wu.btn.tip))
      const wh = winFor('healthy')
      S.updateRepairButton(wh.win)
      ok('(h) control: ...and lit on a healthy one with a ticked file', wh.btn.disabled === false)
    }
  }

  if (typeof S.showRepairResult === 'function') {
    const repair = (blocks, counts) => {
      const r = panelWin('#repairResult')
      S.showRepairResult(r.win, { status: 'completed', result: { pool: 'ahr0', blocks: blocks.length, repaired: 0, unrepairable: 0, aboveMd: 0, mappingAbort: 0, notExamined: 0, ...counts, files: [{ path: `/f${XSS}`, blocks }] } })
      return r.panel.html
    }
    // ---- (b) no-checksum ---------------------------------------------------------
    const nc = repair([{ block: 1, outcome: 'not-examined', reasonCode: 'no-checksum', reason: 'btrfs stores no checksum' }], { notExamined: 1 })
    ok('(b) no-checksum: "scrub again"', /scrub again/.test(nc), nc)
    ok('(b) ...and no restore advice', !/[Rr]estore this file|from backup\./.test(nc), nc)
    const ncU = repair([{ block: 1, outcome: 'unrepairable', reasonCode: 'no-checksum', reason: 'x' }], { unrepairable: 1 })
    ok('(b) a no-checksum block in the unrepairable bucket earns no restore advice either', !/Restore this file from backup/.test(ncU), ncU)

    // ---- (c) write-unconfirmed ---------------------------------------------------
    const wu = repair([{ block: 1, outcome: 'not-examined', reasonCode: 'write-unconfirmed', reason: 'dd exited 1' }], { notExamined: 1 })
    ok('(c) write-unconfirmed never reads "Nothing was written"', !/Nothing was written/.test(wu), wu)
    ok('(c) ...it says the write could not be confirmed and the next scrub decides', /could not be confirmed/.test(wu) && /next scrub decides/.test(wu), wu)
    ok('(c) ...and is no reason to restore', /not a reason to restore/.test(wu) && !/Restore this file from backup/.test(wu), wu)
    const mix = repair([
      { block: 1, outcome: 'not-examined', reasonCode: 'write-unconfirmed', reason: 'dd exited 1' },
      { block: 2, outcome: 'not-examined', reasonCode: 'run-stopped', reason: 'a gate refused' },
    ], { notExamined: 2 })
    ok('(c) a mix: the run-stopped block keeps "Nothing was written" with its own count', /1 block\(s\) could not be EXAMINED \(the run stopped before reaching them\)\. Nothing was written/.test(mix), mix)
    ok('(c) ...and the unconfirmed block its own sentence', /1 block\(s\) were written through md and the write could not be confirmed/.test(mix), mix)

    // ---- (d) postcheckSkipped ----------------------------------------------------
    const ps = repair([{ block: 4, outcome: 'repaired', reason: 'repaired', postcheckSkipped: `md took a recover ${XSS}` }], { repaired: 1 })
    ok('(d) a repaired block whose post-check was skipped: "repaired; re-scrub to confirm"', /repaired; re-scrub to confirm/.test(ps), ps)
    ok('(d) ...with the daemon\'s note, encoded', ps.includes(XSS_ENC) && !ps.includes('<img'), ps)
    const fileOutcome = typeof S.fileOutcome === 'function' ? S.fileOutcome : () => ({})
    const fo = fileOutcome({ path: '/f', blocks: [{ block: 4, outcome: 'repaired', reason: 'r', postcheckSkipped: 'recover' }] })
    ok('(d) the file\'s Repair cell reads "repaired; re-scrub to confirm" in warn, never ok', /re-scrub to confirm/.test(fo.text) && fo.level === 'warn', JSON.stringify(fo))
    const fc = fileOutcome({ path: '/f', blocks: [{ block: 4, outcome: 'repaired', reason: 'r' }] })
    ok('(d) control: a confirmed repair stays ok', fc.level === 'ok' && fc.text === '1 repaired', JSON.stringify(fc))

    // ---- (e) array-rebuilds-rot --------------------------------------------------
    const rot = repair([{ block: 9, outcome: 'unrepairable', reasonCode: 'array-rebuilds-rot', reason: `/f block 9 fails its stored checksum ${XSS}. Restore the file from a backup if one exists.` }], { unrepairable: 1 })
    ok('(e) array-rebuilds-rot is on the restore list', /Restore this file from backup/.test(rot), rot)
    ok('(e) ...with the daemon\'s sentence, encoded', /block 9 fails its stored checksum/.test(rot) && rot.includes(XSS_ENC) && !rot.includes('<img'), rot)
  }

  // ---- (f) scrub-unproven refusals; (g) writtenAt ---------------------------
  if (typeof S.showMirrorResult === 'function') {
    const pr = panelWin('#parityResult')
    ;(S.showParityResult || (() => {}))(pr.win, { status: 'completed', result: { band: 1, outcome: 'refused', reasonCode: 'scrub-unproven', reason: `refused: the fresh btrfs scrub's verdict could not be read ${XSS}`, mismatchBefore: 2, mismatchAfter: null } })
    ok('(f) Rewrite parity refused scrub-unproven: says the checksum scrub had no verdict', /delivered no verdict/.test(pr.panel.html), pr.panel.html)
    ok('(f) ...and the daemon\'s sentence, encoded', pr.panel.html.includes(XSS_ENC) && !pr.panel.html.includes('<img'), pr.panel.html)
    const mr = panelWin('#parityResult')
    S.showMirrorResult(mr.win, { status: 'completed', result: { band: 2, arm: 'scrub', outcome: 'refused', reasonCode: 'scrub-unproven', reason: `arm A, pass 1: the btrfs scrub's verdict could not be read ${XSS}`, passes: [], mismatchBefore: 3, mismatchAfter: null } })
    ok('(f) Reconcile mirror refused scrub-unproven: says the pass had no verdict', /no checksum verdict/.test(mr.panel.html), mr.panel.html)
    ok('(f) ...and the daemon\'s sentence, encoded', mr.panel.html.includes(XSS_ENC) && !mr.panel.html.includes('<img'), mr.panel.html)
    ok('(f) a refused arm-A run never says btrfs healed the band', !/healed the band/.test(mr.panel.html), mr.panel.html)
    const ma = panelWin('#parityResult')
    S.showMirrorResult(ma.win, { status: 'completed', result: { band: 2, arm: 'scrub', outcome: 'reconciled', passes: [{ corrected: 3, mismatchAfter: 0 }], mismatchBefore: 3, mismatchAfter: 0 } })
    ok('(f) control: a reconciled arm-A run still says it healed the band', /healed the band/.test(ma.panel.html), ma.panel.html)

    const wr = panelWin('#parityResult')
    S.showMirrorResult(wr.win, { status: 'completed', result: { band: 2, arm: 'compare', outcome: 'residual', reason: 'the check still counted 1', passes: [{ corrected: 0, mismatchAfter: 1 }], rowsDiffering: 4, rowsWritten: { leg0: 2, leg1: 1 }, writtenAt: [4096, 8192], mismatchBefore: 4, mismatchAfter: 1 } })
    ok('(g) a residual run names the rows it wrote, and how many more', /at md byte\(s\) 4096, 8192 and 1 more/.test(wr.panel.html), wr.panel.html)
    const wc = panelWin('#parityResult')
    S.showMirrorResult(wc.win, { status: 'completed', result: { band: 2, arm: 'compare', outcome: 'reconciled', passes: [], rowsWritten: { leg0: 1, leg1: 0 }, writtenAt: [4096], mismatchBefore: 1, mismatchAfter: 0 } })
    ok('(g) control: a reconciled run does not list them', !/at md byte/.test(wc.panel.html), wc.panel.html)
  }
}

// ===========================================================================
// Item 3 — Import: unreadable scan entries
// ===========================================================================
const settle = () => new Promise(r => setImmediate(r))
{
  let windowCfg = null
  const view = { emptyText: '', setEmptyText(h) { view.emptyText = h } }
  let loaded = null
  const igrid = { setLoading() {}, getStore: () => ({ loadData(d) { loaded = d } }), getView: () => view }
  const box = { html: '', hidden: true, update(h) { box.html = h }, setHidden(h) { box.hidden = !!h } }
  const win = { destroyed: false, destroying: false, show() {}, down: q => (q === '#importGrid' ? igrid : (q === '#importUnreadable' ? box : null)) }
  const Ext = {
    String: { htmlEncode },
    create: (cls, cfg) => {
      if (cls === 'Ext.window.Window') { windowCfg = cfg; return win }
      return cfg
    },
    on() {},
    un() {},
    Msg: { alert() {}, confirm() {} },
  }
  const ANAS = loadUi(['00-core.js', '10-api.js', '15-gfx.js', '30-pools.js', '33-pool-import.js'], Ext)
  ANAS.warn = () => {}
  ANAS.alertMsg = () => {}
  const scan = ANAS.pools && ANAS.pools.importScan
  ok('import: the scan door is reachable', typeof scan === 'function')
  const ENTRY = `the scan entry for '${XSS}' carries no pool id and cannot be imported from here`
  let answer = null
  ANAS.api.get = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))

  // The window carries the notice above the grid.
  const action = (ANAS.pools.actions || ANAS.pools._actions || []).find(a => a.itemId === 'importPool')
  answer = { data: [] }
  if (action) {
    action.handler('n', {})
    await settle(); await settle()
  }
  const gridCfg = windowCfg && windowCfg.items && windowCfg.items[0]
  ok('import: the window docks a hidden "could not be read" notice above the grid', !!gridCfg && (gridCfg.dockedItems || []).some(d => d.itemId === 'importUnreadable' && d.dock === 'top' && d.hidden === true), JSON.stringify(gridCfg && gridCfg.dockedItems))
  ok('import: the grid claims nothing before the first scan answers', !!gridCfg && gridCfg.emptyText === '', gridCfg && gridCfg.emptyText)

  // Each scan below runs through the Import action itself (the window opens
  // and scans), so the checks read what an operator sees.
  const rescan = () => (action ? action.handler('n', {}) : (typeof scan === 'function' ? scan(win, 'n') : null))
  {
    // Empty list + unreadable entries: never "No importable pools found" alone.
    answer = { data: [], unreadableEntries: [ENTRY] }
    rescan()
    await settle(); await settle()
    ok('import: the unreadable entries are shown', box.hidden === false && /Scan entries that could not be read \(1\)/.test(box.html), box.html)
    ok('import: ...each entry encoded', box.html.includes(XSS_ENC) && !box.html.includes('<img'), box.html)
    ok('import: an empty list beside unreadable entries never says "No importable pools found"', !view.emptyText.includes('No importable pools found') && /could not be read/.test(view.emptyText), view.emptyText)

    // Pools AND unreadable entries: both said.
    answer = { data: [{ name: 'tank', guid: '1', state: 'ONLINE' }], unreadableEntries: [ENTRY, 'the scan entry for \'b\' carries no pool id and cannot be imported from here'] }
    rescan()
    await settle(); await settle()
    ok('import: importable pools load beside unreadable entries', Array.isArray(loaded) && loaded.length === 1)
    ok('import: ...and the notice counts both entries', box.hidden === false && /\(2\)/.test(box.html), box.html)

    // Control: no unreadable entries.
    answer = { data: [] }
    rescan()
    await settle(); await settle()
    ok('import: control: a clean empty scan says No importable pools found', view.emptyText.includes('No importable pools found'), view.emptyText)
    ok('import: control: ...and hides the notice', box.hidden === true)

    // A scan that could not be read: no stale rows, never "no pools".
    answer = Object.assign(new Error('The importable pools could not be listed: zpool import exited 1'), { status: 503 })
    loaded = [{ name: 'stale' }]
    rescan()
    await settle(); await settle()
    ok('import: a failed scan clears the earlier rows', Array.isArray(loaded) && loaded.length === 0, JSON.stringify(loaded))
    ok('import: ...and says the scan could not be read, never "No importable pools found"', /scan could not be read/.test(view.emptyText) && !view.emptyText.includes('No importable'), view.emptyText)
  }
}

// ===========================================================================
// Item 4 — ONE panel isComposableDisk, answering as the shared one does
// ===========================================================================
{
  const ANAS = loadUi(['00-core.js', '10-api.js', '15-gfx.js', '39-ahr.js'])
  const gfxFn = ANAS.gfx && ANAS.gfx.isComposableDisk
  const ahrFn = ANAS.ahr && ANAS.ahr.isComposableDisk
  ok('composable: the panel predicate is reachable (ANAS.gfx.isComposableDisk)', typeof gfxFn === 'function')
  ok('composable: the AHR export is reachable (ANAS.ahr.isComposableDisk)', typeof ahrFn === 'function')
  // The shared function's own test table (daemon disks-iscsi-served.test.ts
  // `isComposableDisk — hands-off means something`), plus every status and
  // tag the shared schema carries, and the real captured /v1/disks rows.
  const capture = JSON.parse(readFileSync(join(HERE, '..', '..', 'daemon', 'src', 'fixtures', 'iscsi', 'anasd-v1-disks.json'), 'utf8')).data
  const TABLE = [
    { status: 'available' },
    { status: 'available', handsOff: 'iscsi-served-here' },
    { status: 'available', handsOff: 'iscsi-unverified' },
    ...['pool_member', 'ahr_member', 'ceph_osd', 'system', 'other', 'unknown'].map(status => ({ status })),
    { status: 'pool_member', handsOff: 'iscsi-served-here' },
    { status: 'available', handsOff: undefined },
    ...capture,
  ]
  if (typeof gfxFn === 'function' && typeof ahrFn === 'function') {
    for (const d of TABLE) {
      const want = sharedIsComposableDisk(d)
      const label = `${d.status}${d.handsOff ? `/${d.handsOff}` : ''}${d.id ? ` ${d.id}` : ''}`
      ok(`composable: gfx answers as shared for ${label}`, gfxFn(d) === want, `${gfxFn(d)} vs ${want}`)
      ok(`composable: ahr answers as shared for ${label}`, ahrFn(d) === want, `${ahrFn(d)} vs ${want}`)
    }
    ok('composable: the table holds both answers', TABLE.some(d => sharedIsComposableDisk(d)) && TABLE.some(d => !sharedIsComposableDisk(d)))
    // The AHR export is the gfx predicate, not a copy: it asks gfx at call time.
    let asked = 0
    const real = ANAS.gfx.isComposableDisk
    ANAS.gfx.isComposableDisk = (d) => { asked++; return real(d) }
    ahrFn({ status: 'available' })
    ANAS.gfx.isComposableDisk = real
    ok('composable: ANAS.ahr.isComposableDisk asks ANAS.gfx.isComposableDisk', asked === 1)
    ok('composable: a non-object is never composable (the panel says false where shared throws)', gfxFn(null) === false && ahrFn(undefined) === false)
  }
  // Static: one copy of the rule's text across the panel sources.
  const panelFiles = ['15-gfx.js', '35-pool-attach.js', '38-pool-composer.js', '39-ahr.js', '39-ahr-composer.js']
  let copies = 0
  for (const f of panelFiles)
    copies += (readFileSync(join(SRC, f), 'utf8').match(/status === 'available' && \w+\.handsOff === undefined/g) || []).length
  ok('composable: the rule is written once in the panel (15-gfx.js)', copies === 1, String(copies))
  const composerSrc = readFileSync(join(SRC, '39-ahr-composer.js'), 'utf8')
  ok('composable: the AHR composer\'s tray asks ANAS.gfx.isComposableDisk', /function isComposableDisk\(disk\) \{\s*var g = ANAS\.gfx;\s*return !!\(g && typeof g\.isComposableDisk === 'function' && g\.isComposableDisk\(disk\)\);/.test(composerSrc))
}

// ===========================================================================
// Item 5 — Backup: per-task `problems` and `unreadableTasks`
// ===========================================================================
{
  const ANAS = loadUi(['00-core.js', '10-api.js', '69-schedules-common.js', '68-backup.js'])
  const B = ANAS.backup || {}
  ok('backup: the cr3.followup hooks are reachable', ['taskRow', 'renderLastRun', 'taskDetailHtml', 'unreadableTasksHtml'].every(k => typeof B[k] === 'function'))
  const PROBLEM = `backup ID '${XSS}' is not a PBS id - every run would be refused`
  const task = (extra) => ({ name: 'nightly', repository: 'pbs1', backupId: 'host1', archives: [{ name: 'etc', path: '/etc' }], schedule: 'daily', enabled: true, ...extra })
  if (typeof B.taskRow === 'function' && typeof B.renderLastRun === 'function') {
    const row = B.taskRow({ task: task({ problems: [PROBLEM] }), lastRunResult: 'failure', lastRunAt: null })
    ok('backup: the row carries the task\'s problems', Array.isArray(row.problems) && row.problems.length === 1)
    const cell = B.renderLastRun(row.lastRunResult, {}, rec(row))
    ok('backup: the row says every run is refused', /every run refused/.test(cell), cell)
    ok('backup: ...with the daemon\'s sentence, encoded', cell.includes(htmlEncode(XSS)) && !cell.includes('<img'), cell)
    const clean = B.taskRow({ task: task({}), lastRunResult: 'success' })
    ok('backup: control: a task without problems carries none and says nothing of it', Array.isArray(clean.problems) && clean.problems.length === 0 && !/every run refused/.test(B.renderLastRun('success', {}, rec(clean))))
  }
  if (typeof B.taskDetailHtml === 'function') {
    const html = B.taskDetailHtml({ task: task({ problems: [PROBLEM] }), lastRunResult: 'unknown' })
    ok('backup: the detail window lists the problems', /Every run of this task would be refused/.test(html) && html.includes(htmlEncode(XSS)) && !html.includes('<img'), html.slice(0, 400))
    const ok2 = B.taskDetailHtml({ task: task({}), lastRunResult: 'unknown' })
    ok('backup: control: a task without problems has no such block', !/would be refused/.test(ok2))
  }
  if (typeof B.unreadableTasksHtml === 'function') {
    const html = B.unreadableTasksHtml([{ name: `bad${XSS}`, reason: `the unit could not be parsed: ${XSS}` }, { name: 'other', reason: 'EACCES' }])
    ok('backup: unreadable tasks are listed by name with the reason', /Backup tasks that could not be read \(2\)/.test(html) && /EACCES/.test(html), html)
    ok('backup: ...both encoded', html.split(htmlEncode(XSS)).length === 3 && !html.includes('<img'), html)
    ok('backup: ...and say no verb can reach them', /cannot be run, edited or deleted from here/.test(html), html)
    ok('backup: control: none to list is no note', B.unreadableTasksHtml([]) === '' && B.unreadableTasksHtml(undefined) === '')
  }
  // The list read wires both: the note beside the grid, the field on the row.
  const src = readFileSync(join(SRC, '68-backup.js'), 'utf8')
  ok('backup: loadTasks renders the unreadable tasks from the list answer', /showUnreadableTasks\(view, res && res\.unreadableTasks\);/.test(src))
  ok('backup: the view carries the unreadable-task note', /itemId: 'backupUnreadableNote'/.test(src))
  ok('backup: the store keeps the problems field', /\{ name: 'problems', type: 'auto' \}/.test(src))
}

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} cr3.followup panel checks passed`)
