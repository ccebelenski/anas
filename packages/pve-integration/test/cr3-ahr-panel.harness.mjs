#!/usr/bin/env node
/*
 * ANAS — cr3.ahr-panel harness (the 2026-11-14 review, section "AHR (panels)",
 * findings AHR-PANEL-M1 ... L9).
 *
 * Loads the REAL 39-ahr-composer.js and 39-ahr.js in a vm sandbox with small
 * stubs. An export line is spliced in before each file's closing `})();` IN
 * MEMORY ONLY, so the files' internal functions can be called with
 * constructed pool records — the reviewer's probe method (fullreview/
 * ahr-panel/probe.mjs, probe2.mjs), kept as the permanent check.
 *
 *   M1  spare / replacement rows are not band members (counts and usable)
 *   M2  an unmounted pool: no LV path as a mount, no 0 B used / free
 *   M3  a running btrfs scrub pass reads scrubbing, Scrub not offered
 *   L4  "Mount at" sends what was typed (ends trimmed); confirm names it
 *   L5  every disk picker filters with isComposableDisk (no hands-off disk)
 *   L6  expand / replace members never include a spare or the cache disk
 *   L7  the expand confirm names every disk it wipes
 *   L8  the composer caps the name at ahrMaxPoolNameLength(disk count)
 *   L9  the LUN tooltip encodes held.detail; window titles encode the name
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const REPO = join(HERE, '..', '..', '..')

let failed = 0
let passed = 0
function ok(label, cond, detail) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error('FAIL:', label, detail === undefined ? '' : `— ${detail}`)
  }
}

function splice(file, exportExpr) {
  const src = readFileSync(join(SRC, file), 'utf8')
  const at = src.lastIndexOf('})();')
  return `${src.slice(0, at)}\n    ANAS['__harness_' + ${JSON.stringify(file)}] = ${exportExpr};\n${src.slice(at)}`
}

// The real Ext.String.htmlEncode set (ExtJS 7 encodes & < > " and ').
function htmlEncode(s) {
  return (`${s}`).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function fmtBytes(bytes) {
  if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes))) {
    return ''
  }
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let o = 0
  let s = Number(bytes)
  while (s >= 1024 && o < u.length - 1) {
    s /= 1024
    o++
  }
  return `${o ? s.toFixed(2) : String(s)} ${u[o]}`
}
// HTML → the text a reader sees.
const text = h => String(h).replace(/<br>/g, '\n').replace(/<\/(div|li|summary)>/g, '\n')
  .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/\n\s*\n+/g, '\n')

// ---- sandbox ----------------------------------------------------------------

const calls = { confirm: [], mountFlow: [], drags: [], windows: [], alerts: [], posts: [] }
let routes = {}
let dragSelection = []

function answer(method, path, body) {
  const key = `${method} ${path}`
  const r = routes[key]
  if (r === undefined) {
    return Promise.reject(Object.assign(new Error(`no route ${key}`), { status: 404 }))
  }
  return Promise.resolve(typeof r === 'function' ? r(body) : r)
}

function fakeEl() {
  return { style: {}, innerHTML: '', value: '', title: '', addEventListener() {}, querySelector: () => fakeEl(), querySelectorAll: () => [] }
}
const fakeRoot = { querySelector: () => fakeEl(), querySelectorAll: () => [] }

function makePanel(id) {
  return {
    id,
    html: '',
    disabled: undefined,
    setHtml(h) { this.html = h },
    getEl() { return { dom: fakeRoot } },
    setDisabled(d) { this.disabled = d },
  }
}
function makeWin(cfg) {
  const panels = {}
  const win = {
    cfg,
    destroyed: false,
    destroying: false,
    panels,
    down(sel) {
      const id = sel.replace(/^#/, '')
      if (!panels[id]) {
        panels[id] = makePanel(id)
      }
      return panels[id]
    },
    show() {},
    setLoading() {},
    close() { this.destroyed = true },
  }
  calls.windows.push(win)
  return win
}

const ANAS = {
  t: s => s,
  enc: htmlEncode,
  formatBytes: fmtBytes,
  formatPercent: p => `${p.toFixed(1)}%`,
  warn: () => {},
  errText: e => (e && e.message) || String(e),
  views: {},
  tbar: x => x,
  gfx: {
    ready: () => true,
    statePill: (token, o) => `[pill ${token || 'neutral'}:${o.label}]`,
    callout: html => `<div>${html}</div>`,
    bay: (label, inner) => `<div>[bay ${htmlEncode(label)}]${inner}</div>`,
    bayGroup: (title, inner) => `<div>[${title}]</div>${inner}`,
    activity: (frac, o) => `[activity ${o.label}]`,
    gauge: (frac, o) => `[gauge ${o.label}]`,
    bar: (frac, o) => `[bar ${o.title}]`,
    mountColumn: () => ({ text: 'Mount', dataIndex: 'mountpoint', renderer: v => `GFX:${v}` }),
    // applyToConfirm as 15-gfx.js does it: the amber section PREPENDED to
    // the intro, a window, the "anyway" button.
    warnGate: {
      chip: () => '',
      applyToConfirm: (opts, warnings, anyway) => {
        if (warnings && warnings.length) {
          opts.confirmIntro = `<div class="warngate">${warnings.map(htmlEncode).join('<br>')}</div>${opts.confirmIntro || ''}`
          opts.confirmWindow = true
          opts.confirmButtonText = anyway
        }
        return opts
      },
    },
  },
  api: {
    get: (node, path) => answer('GET', path),
    post: (node, path, body) => {
      calls.posts.push([path, body])
      return answer('POST', path, body)
    },
  },
  confirmAndRun: o => calls.confirm.push(o),
  changeMountpointFlow: o => calls.mountFlow.push(o),
  alertMsg: (title, msg) => calls.alerts.push([title, msg]),
  toast: () => {},
  pollJob: () => {},
}
const head = { appendChild() {} }
const document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  createTextNode: t => t,
  head,
  documentElement: head,
}
const Ext = {
  create: (cls, cfg) => makeWin(cfg || {}),
  String: { htmlEncode },
  Date: { format: d => `FMT:${d.toISOString()}` },
  Msg: { prompt() {}, confirm() {}, alert() {} },
}
const sandbox = { window: { ANAS, document }, document, Ext, console, Promise, Date, setTimeout: (fn) => { fn(); return 1 }, clearTimeout() {} }
vm.createContext(sandbox)
vm.runInContext(splice('39-ahr-composer.js', '{ makeState: makeState, loadDisks: loadDisks, wireStatic: wireStatic, commit: commit, nameValid: nameValid, syncCreateButton: syncCreateButton }'), sandbox, { filename: '39-ahr-composer.js' })
vm.runInContext(splice('39-ahr.js', '{ detailHtml: detailHtml, poolBands: poolBands, renderUsed: renderUsed, renderFree: renderFree, renderCapacityPct: renderCapacityPct, renderUsable: renderUsable, renderActivity: renderActivity, renderGridState: renderGridState, renderMount: renderMount, updateButtons: updateButtons, changeMountpoint: changeMountpoint, openExpand: openExpand, openReplace: openReplace, openAddSpare: openAddSpare, openAttachCache: openAttachCache, expandConfirmIntro: expandConfirmIntro, fmtSnapCreated: fmtSnapCreated, renderPoolState: renderPoolState, planLiveHtml: planLiveHtml }'), sandbox, { filename: '39-ahr.js' })
const C = ANAS['__harness_39-ahr-composer.js']
const A = ANAS['__harness_39-ahr.js']

// The drag controller is the seam every drag picker hands its candidates to.
ANAS.ahrComposer.makeDragSelect = (spec) => {
  calls.drags.push(spec)
  return { render() {}, selectedInBay: () => dragSelection.slice() }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

// ---- fixtures -----------------------------------------------------------------

const TiB = 1024 ** 4
const rec = obj => ({ get: k => obj[k] })
const ids = ['ata-A', 'ata-B', 'ata-C', 'ata-D']
const memberDisk = id => ({ id, sizeBytes: 4 * TiB, usableBytes: 4 * TiB, model: 'M', serial: 's', role: 'member', partitions: [{ device: `/dev/disk/by-id/${id}-part1`, band: 1, sizeBytes: 4 * TiB }] })

// A healthy AHR-1 pool: one raid5 band of four members, one idle hot spare
// (a member row with memberState 'spare' — ahr-topology.ts), one cache SSD.
function pool(extra) {
  return {
    name: 'tank',
    ahrType: 'ahr1',
    state: 'healthy',
    mounted: true,
    mountpoint: '/mnt/anas-ahr/tank',
    mountedReadOnly: false,
    subvolLayout: true,
    advisories: [],
    disks: [...ids.map(memberDisk),
      { id: 'ata-S', sizeBytes: 4 * TiB, usableBytes: 4 * TiB, model: 'M', serial: 's', role: 'spare', partitions: [{ device: '/dev/disk/by-id/ata-S-part1', band: 1, sizeBytes: 4 * TiB }] },
      { id: 'nvme-CACHE', sizeBytes: 4 * TiB, usableBytes: 4 * TiB, model: 'SSD', serial: 'c', role: 'cache', partitions: [] }],
    arrays: [{
      device: '/dev/md/tank-r1',
      band: 1,
      level: 'raid5',
      heightBytes: 4 * TiB,
      state: 'clean',
      members: [...ids.map(id => ({ disk: id, partition: `/dev/disk/by-id/${id}-part1`, memberState: 'in_sync' })),
        { disk: 'ata-S', partition: '/dev/disk/by-id/ata-S-part1', memberState: 'spare' }],
    }],
    vg: { name: 'tank', sizeBytes: 16 * TiB, freeBytes: 0 },
    lv: { name: 'tank-vol', sizeBytes: 12 * TiB },
    capacity: { rawBytes: 16 * TiB, usableBytes: 12 * TiB, usedBytes: 1 * TiB, freeBytes: 11 * TiB, redundancyOverheadBytes: 4 * TiB, unprotectedWastedBytes: 0, pendingBytes: 0 },
    cache: { devices: ['nvme-CACHE'], sizeBytes: 4 * TiB, mode: 'writethrough', policy: 'smq', state: 'healthy' },
    ...extra,
  }
}

// ---- M1 -------------------------------------------------------------------------

{
  const P = pool()
  const t1 = text(A.detailHtml(P))
  ok('M1: the band row reads four members and the spare apart', /raid5 × 4, 1 spare · height 4\.00 TiB/.test(t1), t1)
  ok('M1: no band reads five members', !/× 5/.test(t1), t1)
  ok('M1: the member list counts 4 members and the spare', /4 members, 1 spare/.test(t1), t1)
  ok('M1: a healthy band reads no "in sync" shortfall', !/in sync\)/.test(t1), t1)
  const bands = A.poolBands(P)
  ok('M1: poolBands memberCount is the slot count', bands[0] && bands[0].memberCount === 4, JSON.stringify(bands[0]))
  ok('M1: the band legend usable equals the Capacity block usable (12 TiB)',
    bands[0] && bands[0].usableBytes === P.capacity.usableBytes, bands[0] && bands[0].usableBytes)
  // An mdadm --replace in flight: the incoming disk's row is memberState
  // 'rebuilding' (mdstat (R)) — a fifth ROW, not a fifth slot.
  const R = pool({ state: 'rebuilding' })
  R.arrays[0].members = [...ids.map(id => ({ disk: id, partition: `/dev/disk/by-id/${id}-part1`, memberState: 'in_sync' })),
    { disk: 'ata-NEW', partition: '/dev/disk/by-id/ata-NEW-part1', memberState: 'rebuilding' }]
  const tr = text(A.detailHtml(R))
  ok('M1: a replacement row is counted apart', /raid5 × 4, 1 replacing/.test(tr), tr)
  ok('M1: and keeps usable at the slot count', A.poolBands(R)[0].usableBytes === 12 * TiB, A.poolBands(R)[0].usableBytes)
  // A degraded band: a faulty member is still a slot, and the shortfall shows.
  const D = pool({ state: 'degraded' })
  D.arrays[0].members[0] = { ...D.arrays[0].members[0], memberState: 'faulty' }
  const td = text(A.detailHtml(D))
  ok('M1: a faulty member still counts as a slot', /raid5 × 4 \(3 in sync\), 1 spare/.test(td), td)
}

// ---- review follow-ups 1, 2, 5 (counting) ------------------------------------

{
  // 1. An INACTIVE array (GT-8): md lists every member device (S), so every
  // row arrives memberState 'spare'. Not hot spares, no slots, no usable.
  const I = pool({ state: 'offline', mounted: false, mountpoint: '/dev/tank/tank-vol', disks: ids.map(memberDisk), cache: undefined })
  I.arrays[0] = { ...I.arrays[0], state: 'inactive', members: ids.map(id => ({ disk: id, partition: `/dev/disk/by-id/${id}-part1`, memberState: 'spare' })) }
  const ti = text(A.detailHtml(I))
  ok('F1: an inactive array reads its member devices and not running', /raid5 · 4 member devices · not running · height 4\.00 TiB/.test(ti), ti)
  ok('F1: never "× 0" and never "spare"', !/× 0/.test(ti) && !/\bspares?\b/.test(ti), ti)
  ok('F1: the member list counts member devices', /4 member devices/.test(ti), ti)
  ok('F1: each row reads not running', (ti.match(/part1not running/g) || []).length === 4, ti)
  const bi = A.poolBands(I)
  ok('F1: poolBands derives no usable figure (null, not 0)', bi[0] && bi[0].usableBytes === null && bi[0].notRunning === true, JSON.stringify(bi[0]))
  const legendI = text(ANAS.ahr.bandBarsHtml(bi, I.disks.map(d => ({ id: d.id, size: d.usableBytes }))))
  ok('F1: the band legend reads usable unknown, never 0 B', /Band 1 — raid5 · 4 member devices · not running · height 4\.00 TiB · usable unknown/.test(legendI) && !/usable 0 B/.test(legendI), legendI)
  ok('F1: the segment title says not running', /band 1 — 4\.00 TiB \(raid5, not running\)/.test(ANAS.ahr.bandBarsHtml(bi, I.disks.map(d => ({ id: d.id, size: d.usableBytes })))))
  // The same rows on an ACTIVE array are hot spares (keyed on state, not count).
  const Sp = pool()
  Sp.arrays[0].members.push({ disk: 'ata-S2', partition: '/dev/disk/by-id/ata-S2-part1', memberState: 'spare' })
  const ts = text(A.detailHtml(Sp))
  // 2. Plural.
  ok('F2: two spares read "2 spares" on the band row', /raid5 × 4, 2 spares · height/.test(ts), ts)
  ok('F2: and in the member list', /4 members, 2 spares/.test(ts), ts)
  ok('F2: one spare stays singular', /4 members, 1 spare(?!s)/.test(text(A.detailHtml(pool()))))

  // 5. Band math versus the LV.
  const legendOf = P => text(ANAS.ahr.bandBarsHtml(A.poolBands(P), P.disks.filter(d => d.role !== 'cache').map(d => ({ id: d.id, size: d.usableBytes }))))
  const five = ['ata-A', 'ata-B', 'ata-C', 'ata-D', 'ata-E']
  const grown = extra => {
    const G = pool({ disks: five.map(memberDisk), cache: undefined, ...extra })
    G.arrays[0] = { ...G.arrays[0], members: five.map(id => ({ disk: id, partition: `/dev/disk/by-id/${id}-part1`, memberState: 'in_sync' })) }
    return G
  }
  // (a) a reshape in flight (review probe1b): the array has 5 slots, the LV is 12 TiB.
  const R = grown({ state: 'expanding' })
  R.arrays[0].state = 'reshaping'
  ok('F5: mid-reshape the legend says what the band gives once the volume is grown',
    /usable 16\.00 TiB once the volume is grown/.test(legendOf(R)), legendOf(R))
  ok('F5: while Capacity keeps the LV figure', /Usable\s*12\.00 TiB/.test(text(A.detailHtml(R))))
  // (b) a halted expansion: clean arrays, the intent on the record.
  const H = grown({ expansion: { state: 'halted' } })
  ok('F5: a halted expansion labels the legend too', /usable 16\.00 TiB once the volume is grown/.test(legendOf(H)), legendOf(H))
  // (c) the belowLvm shape: clean, no intent, band math a whole band over the LV.
  const B = grown({ advisories: ['4096 GiB is grown into the RAID arrays but not yet handed up to LVM — resume or re-run the expansion to deliver it (the capacity is protected, just not yet usable)'] })
  // Second review (rule C): growth is never inferred from arithmetic. The
  // stranded fact is a sentence in `advisories`, not a field — not read. The
  // band figure differs from the LV, so it says what it is.
  ok('F5: stranded capacity with no structured signal is not called growth', !/once the volume/.test(legendOf(B)), legendOf(B))
  ok('F5: its band figure names itself (band capacity before overhead)', /band capacity 16\.00 TiB before md and volume overhead/.test(legendOf(B)), legendOf(B))
  // A healthy pool, and one whose LV sits the usual md/LVM sliver under band
  // math, read the plain figure.
  ok('F5: a healthy pool reads the plain figure', /usable 12\.00 TiB$/m.test(legendOf(pool())) && !/once the volume/.test(legendOf(pool())), legendOf(pool()))
  const N = pool()
  N.capacity = { ...N.capacity, usableBytes: 12 * TiB - 600 * 1024 ** 2 }
  ok('F5: md data offsets and LVM rounding are not "growth"', !/once the volume/.test(legendOf(N)), legendOf(N))
  ok('F5: an inactive pool is never labelled as growing', !/once the volume/.test(legendOf(I)))
  // Second review, probe4: the daemon pins a 256 MiB md data offset on
  // members of 128 GiB and more (ahr-geometry.ts AHR_DATA_OFFSET.largeBytes),
  // so on a HEALTHY pool the LV is (height − 256 MiB) × data slots.
  const OFF = 256 * 1024 ** 2
  const healthyOf = (bandSlots) => {
    const allIds = []
    const arrays = bandSlots.map((n, bi) => {
      const bIds = Array.from({ length: n }, (_, k) => `ata-${bi}${k}`)
      allIds.push(...bIds)
      return { device: `/dev/md/tank-r${bi + 1}`, band: bi + 1, level: 'raid5', heightBytes: 4 * TiB, state: 'clean',
        members: bIds.map(id => ({ disk: id, partition: `/dev/disk/by-id/${id}-part${bi + 1}`, memberState: 'in_sync' })) }
    })
    const lv = bandSlots.reduce((sum, n) => sum + (4 * TiB - OFF) * (n - 1), 0)
    const P = pool({ disks: [...new Set(allIds)].map(memberDisk), arrays, cache: undefined, lv: { name: 'tank-vol', sizeBytes: lv } })
    P.capacity = { ...P.capacity, usableBytes: lv }
    return P
  }
  const h5 = healthyOf([5])
  ok('F5: a healthy 4 TiB × 5 raid5 (256 MiB offset) reads the plain figure', /usable 16\.00 TiB$/m.test(legendOf(h5)) && !/once the volume|before md/.test(legendOf(h5)), legendOf(h5))
  const h33 = healthyOf([3, 3])
  ok('F5: two healthy 3-slot 4 TiB bands read the plain figure', (legendOf(h33).match(/usable 8\.00 TiB$/gm) || []).length === 2 && !/once the volume|before md/.test(legendOf(h33)), legendOf(h33))
  // A real stranded case: the arrays grew to 5 slots, the LV was never
  // resized (still 4 slots' worth), no reshape, no intent.
  const st = healthyOf([5])
  st.capacity = { ...st.capacity, usableBytes: (4 * TiB - OFF) * 3 }
  st.lv = { name: 'tank-vol', sizeBytes: (4 * TiB - OFF) * 3 }
  ok('F5: a real stranded pool is not called growth without a signal', !/once the volume/.test(legendOf(st)), legendOf(st))
  ok('F5: but its band figure names itself', /band capacity 16\.00 TiB before md and volume overhead/.test(legendOf(st)), legendOf(st))
  // The same stranded pool with the structured signal (a halted intent) does.
  const stI = { ...st, expansion: { state: 'halted' } }
  ok('F5: with an expansion intent it reads once the volume is grown', /usable 16\.00 TiB once the volume is grown/.test(legendOf(stI)), legendOf(stI))
  const src5 = readFileSync(join(SRC, '39-ahr.js'), 'utf8')
  ok('F5: no arithmetic growth margin is left in the source', !/GROW_NOISE|noise/.test(src5))
  ok('F5: no advisory wording is matched for growth', !/grown into the RAID arrays/.test(src5))
}

// ---- the daemon's final contract (cr3-ahr-core) -------------------------------

{
  // (1) AhrPool.state 'unknown': the mount table could not be read.
  const U = pool({ state: 'unknown', subvolLayout: false, mountedReadOnly: undefined,
    advisories: ['the kernel mount table could not be read (findmnt exited 1) — whether \'tank\' is mounted read-only is unknown'] })
  delete U.mountedReadOnly
  ok('S1: unknown wears a neutral pill', A.renderPoolState('unknown') === '[pill neutral:unknown]', A.renderPoolState('unknown'))
  ok('S1: the State column too', A.renderGridState('unknown', {}, rec(U)) === '[pill neutral:unknown]')
  ok('S1: a running btrfs scrub never lifts unknown to scrubbing', A.renderGridState('unknown', {}, rec({ ...U, btrfsScrubRunning: true })) === '[pill neutral:unknown]')
  const tu = text(A.detailHtml(U))
  ok('S1: the detail header reads unknown', /\[pill neutral:unknown\]/.test(tu.split('\n')[0]), tu.split('\n')[0])
  ok('S1: the detail says the mount state could not be read', /mount state could not be read/.test(tu), tu)
  const g = toolbarGrid(rec(U))
  A.updateButtons(g)
  ok('S1: Expand is not offered', g.btns.expand.disabled === true)
  ok('S1: and says why', /mount state could not be read/.test(g.btns.expand.tip || ''), g.btns.expand.tip)
  ok('S1: Scrub is not offered, with the reason', g.btns.scrub.disabled === true && /mount state could not be read/.test(g.btns.scrub.tip || ''), g.btns.scrub.tip)
  ok('S1: Snapshots is not offered, with the state as the reason (not "predates the layout")',
    g.btns.snapshots.disabled === true && /mount state could not be read/.test(g.btns.snapshots.tip || '') && !/predates/.test(g.btns.snapshots.tip || ''), g.btns.snapshots.tip)
  ok('S1: Remount is not offered (mountedReadOnly absent)', g.btns.remount.hidden === true && g.btns.remount.disabled === true)
  const gc = toolbarGrid(rec({ ...U, cache: { devices: [], sizeBytes: 0, mode: '', policy: '', state: 'absent' } }))
  A.updateButtons(gc)
  ok('S1: Attach cache is not offered, with the reason', gc.btns.attachCache.disabled === true && /mount state could not be read/.test(gc.btns.attachCache.tip || ''), gc.btns.attachCache.tip)
  const gch = toolbarGrid(rec(pool({ cache: { devices: [], sizeBytes: 0, mode: '', policy: '', state: 'absent' } })))
  A.updateButtons(gch)
  ok('S1: a healthy cacheless pool keeps Attach cache', gch.btns.attachCache.disabled === false && gch.btns.attachCache.tip === '')
  // Second review: unknown AND mountedReadOnly true (one read feeds both, so
  // it should not occur) — Remount stays hidden, the read-only line stays out.
  const UR = { ...U, mountedReadOnly: true }
  const gr = toolbarGrid(rec(UR))
  A.updateButtons(gr)
  ok('S1: unknown + mountedReadOnly true keeps Remount hidden and off', gr.btns.remount.hidden === true && gr.btns.remount.disabled === true)
  const tur = text(A.detailHtml(UR))
  ok('S1: and prints no read-only line beside the unknown line', /mount state could not be read/.test(tur) && !/read-only — writes are stopped/.test(tur), tur)
  ok('S1: the unknown sentence names only verbs this view has (no Repair)', !/Repair/.test(tu) && /Expand, Scrub, Attach cache, Remount and snapshot actions/.test(tu), tu)
  const gro = toolbarGrid(rec(pool({ state: 'readonly', mountedReadOnly: true, cache: undefined })))
  A.updateButtons(gro)
  ok('S1: a read-only pool still offers Remount', gro.btns.remount.hidden === false && gro.btns.remount.disabled === false)
  const gh = toolbarGrid(rec(pool()))
  A.updateButtons(gh)
  ok('S1: a healthy pool keeps Expand, Scrub, Snapshots with no reason', gh.btns.expand.disabled === false && gh.btns.expand.tip === ''
    && gh.btns.scrub.disabled === false && gh.btns.snapshots.disabled === false && !/could not be read/.test(gh.btns.snapshots.tip || ''))
  // Every lookup over the state: a value the panel does not know is a
  // neutral pill with the daemon's word, never healthy, never blank.
  ok('S1: an unmapped state is neutral and named', A.renderPoolState('wobbly') === '[pill neutral:wobbly]')
  ok('S1: a state named like an Object property is not a lookup hit', A.renderPoolState('toString') === '[pill neutral:toString]', A.renderPoolState('toString'))
  const src = readFileSync(join(SRC, '39-ahr.js'), 'utf8')
  ok('S1: the state table maps unknown with the neutral token', /unknown: \{ token: '', label: 'unknown' \}/.test(src))

  // (2) AhrArray.raidDevices: md's own slot count.
  const F = pool({ state: 'rebuilding' })
  // A spare failover: D failed (F), the spare S is being rebuilt onto and
  // carries no marker — two non-spare rows for one slot.
  F.arrays[0] = { ...F.arrays[0], state: 'recovering', raidDevices: 4, members: [
    ...['ata-A', 'ata-B', 'ata-C'].map(id => ({ disk: id, partition: `/dev/disk/by-id/${id}-part1`, memberState: 'in_sync' })),
    { disk: 'ata-D', partition: '/dev/disk/by-id/ata-D-part1', memberState: 'faulty' },
    { disk: 'ata-S', partition: '/dev/disk/by-id/ata-S-part1', memberState: 'in_sync' }] }
  const tf = text(A.detailHtml(F))
  ok('R2: raidDevices is the slot count (not 5 rows)', /raid5 × 4 · height/.test(tf) && !/× 5/.test(tf), tf)
  const bandRow = (tf.match(/\/dev\/md\/tank-r1raid5[^\n]*/) || [''])[0]
  ok('R2: in sync is capped at the slot count', bandRow !== '' && !/in sync\)/.test(bandRow), bandRow)
  ok('R2: the member list counts 4 members', /4 members/.test(tf), tf)
  ok('R2: the band legend usable is 3 slots of data (12 TiB)', A.poolBands(F)[0].memberCount === 4 && A.poolBands(F)[0].usableBytes === 12 * TiB, JSON.stringify(A.poolBands(F)[0]))
  const D2 = pool({ state: 'degraded' })
  D2.arrays[0] = { ...D2.arrays[0], state: 'degraded', raidDevices: 4, members: [
    ...['ata-A', 'ata-B', 'ata-C'].map(id => ({ disk: id, partition: `/dev/disk/by-id/${id}-part1`, memberState: 'in_sync' }))] }
  ok('R2: a slot with no row still counts (pulled disk): raid5 × 4 (3 in sync)', /raid5 × 4 \(3 in sync\)/.test(text(A.detailHtml(D2))), text(A.detailHtml(D2)))
  ok('R2: without raidDevices the row rule stands', /raid5 × 4, 1 spare/.test(text(A.detailHtml(pool()))))

  // (3) capacity.usableBytes, vg and lv sizes can be null.
  const Nn = pool({ vg: { name: 'tank', sizeBytes: null, freeBytes: null }, lv: { name: 'tank-vol', sizeBytes: null } })
  Nn.capacity = { ...Nn.capacity, usableBytes: null }
  const tn = text(A.detailHtml(Nn))
  ok('N3: the Capacity block Usable reads unknown', /Usable\s*unknown/.test(tn), tn)
  ok('N3: no gauge without a usable figure', !/\[gauge/.test(A.detailHtml(Nn)))
  ok('N3: the LV size reads unknown', /LV tank-vol — unknown/.test(tn), tn)
  ok('N3: grid Usable reads unknown', text(A.renderUsable(null, {}, rec(Nn))) === 'unknown', A.renderUsable(null, {}, rec(Nn)))
  ok('N3: grid Capacity reads unknown', text(A.renderCapacityPct(null, {}, rec(Nn))) === 'unknown')
  const metaN = {}
  A.renderUsable(null, metaN, rec(Nn))
  ok('N3: the Usable tooltip says unknown', /Usable unknown/.test(metaN.tdAttr), metaN.tdAttr)
  ok('N3: no 0 B stands in for a null', !/Usable\s*0 B|LV tank-vol — 0 B/.test(tn))
  // The expansion plan's before/after are AhrPoolCapacity too.
  const plan = { bands: [], steps: [], warnings: [],
    before: { rawBytes: 0, usableBytes: null, usedBytes: null, freeBytes: null, redundancyOverheadBytes: 0, unprotectedWastedBytes: 0, pendingBytes: 0 },
    after: { rawBytes: 20 * TiB, usableBytes: null, usedBytes: null, freeBytes: null, redundancyOverheadBytes: 4 * TiB, unprotectedWastedBytes: 0, pendingBytes: 0 } }
  const tp = text(A.planLiveHtml(plan, []))
  ok('N3: the plan readout says Usable unknown', /Usable\s*unknown/.test(tp), tp)
  ok('N3: and computes no Change from an unknown', !/Change/.test(tp), tp)
}

// ---- review follow-ups 3 and 4 ----------------------------------------------

{
  const raw = '<img src=x onerror=alert(1)>'
  ok('F3: an unparsed snapshot date is encoded', A.fmtSnapCreated(raw) === htmlEncode(raw), A.fmtSnapCreated(raw))
  ok('F3: a parsed one still goes through Ext.Date.format', A.fmtSnapCreated('2026-11-14T10:00:00Z') === 'FMT:2026-11-14T10:00:00.000Z', A.fmtSnapCreated('2026-11-14T10:00:00Z'))
  // 4. The composer comment says the create route refuses / and /mnt/pve
  // too: it does, through its shared system-path gate. Pin that it still does.
  const mutate = readFileSync(join(REPO, 'packages', 'daemon', 'src', 'routes', 'ahr-mutate.ts'), 'utf8')
  const spec = mutate.slice(mutate.indexOf('function createSpec('), mutate.indexOf('function createSpec(') + 4000)
  ok('F4: the AHR create spec still runs mountTargetGate on the typed mountpoint', /mountTargetGate<NewAhrPool>\(req\.mountpoint\)/.test(spec))
}

// ---- M2 -------------------------------------------------------------------------

{
  // ahr-topology.ts: mountpoint = the LV device path when unmounted, and
  // used/free = placeholder 0 (today) — or null (the daemon builder's fix).
  for (const [label, cap] of [
    ['placeholder 0', { usedBytes: 0, freeBytes: 0 }],
    ['null', { usedBytes: null, freeBytes: null }],
    ['absent', { usedBytes: undefined, freeBytes: undefined }],
  ]) {
    const U = pool({ mounted: false, mountpoint: '/dev/tank/tank-vol', subvolLayout: false, advisories: ['pool \'tank\' filesystem is not mounted'] })
    U.capacity = { ...U.capacity, ...cap }
    const html = A.detailHtml(U)
    const tu = text(html)
    ok(`M2 (${label}): the detail never says mounted at the LV path`, !/mounted at/.test(tu) && !/\/dev\/tank\/tank-vol/.test(tu), tu)
    ok(`M2 (${label}): the detail says not mounted, usage unknown`, /not mounted — usage unknown/i.test(tu), tu)
    ok(`M2 (${label}): no "0 B used" / "0 B free" anywhere`, !/0 B used|0 B free/.test(tu), tu)
    ok(`M2 (${label}): no usage gauge is drawn`, !/\[gauge/.test(html), html)
    ok(`M2 (${label}): Free reads unknown in the Capacity block`, /Free\s*unknown/.test(tu), tu)
    ok(`M2 (${label}): Usable (the LV size) still reads`, /Usable\s*12\.00 TiB/.test(tu), tu)
    const r = rec(U)
    ok(`M2 (${label}): grid Used reads unknown`, text(A.renderUsed(null, {}, r)) === 'unknown', A.renderUsed(null, {}, r))
    ok(`M2 (${label}): grid Free reads unknown`, text(A.renderFree(null, {}, r)) === 'unknown', A.renderFree(null, {}, r))
    ok(`M2 (${label}): grid Capacity reads unknown`, text(A.renderCapacityPct(null, {}, r)) === 'unknown', A.renderCapacityPct(null, {}, r))
    const meta = {}
    A.renderUsable(null, meta, r)
    ok(`M2 (${label}): the Usable tooltip says Used/Free unknown`, /Used unknown/.test(meta.tdAttr) && /Free unknown/.test(meta.tdAttr), meta.tdAttr)
    const mount = text(A.renderMount(U.mountpoint, {}, r))
    ok(`M2 (${label}): the Mount column shows no LV path`, mount === '(not mounted)', mount)
  }
  // Mounted, but the usage read failed (the daemon builder's null).
  const N = pool()
  N.capacity = { ...N.capacity, usedBytes: null, freeBytes: null }
  const tn = text(A.detailHtml(N))
  ok('M2: a mounted pool with an unread usage says mounted at its directory', /mounted at \/mnt\/anas-ahr\/tank/.test(tn), tn)
  ok('M2: and reads unknown used / unknown free, never 0', /unknown used, unknown free/.test(tn) && !/0 B used/.test(tn), tn)
  ok('M2: grid Used unknown on a mounted pool with no figure', text(A.renderUsed(null, {}, rec(N))) === 'unknown')
  // Mounted with real figures: unchanged.
  const M = pool()
  const tm = text(A.detailHtml(M))
  ok('M2: a mounted pool reads its figures', /mounted at \/mnt\/anas-ahr\/tank {2}· {2}1\.00 TiB used, 11\.00 TiB free/.test(tm), tm)
  ok('M2: and keeps its gauge', /\[gauge 1\.00 TiB used of 12\.00 TiB usable\]/.test(A.detailHtml(M)))
  ok('M2: grid Used reads the figure', A.renderUsed(null, {}, rec(M)) === '1.00 TiB')
  ok('M2: grid Free reads the figure', A.renderFree(null, {}, rec(M)) === '11.00 TiB')
  ok('M2: the Mount column shows the mountpoint', A.renderMount(M.mountpoint, {}, rec(M)) === '/mnt/anas-ahr/tank')
  // A true `mounted` is required — a truthy non-boolean is not mounted.
  const S = pool({ mounted: 'true' })
  ok('M2: mounted must be the boolean true', text(A.renderUsed(null, {}, rec(S))) === 'unknown')

  // Change mount prefills only a real mountpoint.
  const grid = { getSelection: () => [rec({ name: 'tank' })] }
  routes = { 'GET /ahr/tank': { data: pool({ mounted: false, mountpoint: '/dev/tank/tank-vol' }) } }
  calls.mountFlow.length = 0
  A.changeMountpoint(grid, 'n1')
  await settle()
  ok('M2: Change mount on an unmounted pool prefills nothing (not the LV path)',
    calls.mountFlow[0] && calls.mountFlow[0].current === '', calls.mountFlow[0] && calls.mountFlow[0].current)
  routes = { 'GET /ahr/tank': { data: pool() } }
  calls.mountFlow.length = 0
  A.changeMountpoint(grid, 'n1')
  await settle()
  ok('M2: Change mount on a mounted pool prefills its mountpoint',
    calls.mountFlow[0] && calls.mountFlow[0].current === '/mnt/anas-ahr/tank', calls.mountFlow[0] && calls.mountFlow[0].current)
}

// ---- M3 -------------------------------------------------------------------------

function toolbarGrid(r) {
  const btns = {}
  const make = id => ({
    id,
    disabled: undefined,
    hidden: undefined,
    tip: undefined,
    setDisabled(d) { this.disabled = d },
    setHidden(h) { this.hidden = h },
    setTooltip(t) { this.tip = t },
  })
  return {
    btns,
    getSelection: () => [r],
    down(sel) {
      const id = sel.replace(/^#/, '')
      if (!btns[id]) {
        btns[id] = make(id)
      }
      return btns[id]
    },
  }
}

{
  for (const [label, extra, scrubbing] of [
    ['btrfsScrubRunning true', { btrfsScrubRunning: true }, true],
    ['btrfsScrubRunning false', { btrfsScrubRunning: false }, false],
    ['btrfsScrubRunning null (unknown)', { btrfsScrubRunning: null }, false],
    ['field absent (older daemon)', {}, false],
  ]) {
    const P = pool(extra)
    const r = rec(P)
    const state = A.renderGridState(P.state, {}, r)
    const act = text(A.renderActivity(null, {}, r))
    const head = text(A.detailHtml(P)).split('\n')[0]
    const g = toolbarGrid(r)
    A.updateButtons(g)
    if (scrubbing) {
      ok(`M3 (${label}): the State column reads scrubbing`, state === '[pill neutral:scrubbing]', state)
      ok(`M3 (${label}): the detail header reads scrubbing`, /scrubbing/.test(head), head)
      ok(`M3 (${label}): Activity reads the btrfs scrub`, /scrubbing \(btrfs\)/.test(act), act)
      ok(`M3 (${label}): Scrub is not offered`, g.btns.scrub.disabled === true)
      ok(`M3 (${label}): and says why`, /already running/.test(g.btns.scrub.tip || ''), g.btns.scrub.tip)
      ok(`M3 (${label}): Expand is not offered on a pool mid-scrub`, g.btns.expand.disabled === true)
    } else {
      ok(`M3 (${label}): the State column reads healthy`, state === '[pill ONLINE:healthy]', state)
      ok(`M3 (${label}): Activity reads Idle`, act === 'Idle', act)
      ok(`M3 (${label}): Scrub is offered`, g.btns.scrub.disabled === false)
      ok(`M3 (${label}): Expand is offered`, g.btns.expand.disabled === false)
    }
  }
  // Only healthy is lifted: a degraded pool mid-scrub stays degraded.
  const Dg = pool({ state: 'degraded', btrfsScrubRunning: true })
  ok('M3: a degraded pool with a scrub running keeps its degraded badge',
    A.renderGridState('degraded', {}, rec(Dg)) === '[pill DEGRADED:degraded]')
  // ONE field name in ONE constant: the coordinator renames it in one place.
  const src = readFileSync(join(SRC, '39-ahr.js'), 'utf8')
  const literal = src.match(/'btrfsScrubRunning'/g) || []
  ok('M3: the field name appears exactly once as a string literal', literal.length === 1, literal.length)
  ok('M3: in the BTRFS_SCRUB_FIELD constant', /var BTRFS_SCRUB_FIELD = 'btrfsScrubRunning';/.test(src))
}

// ---- L4 -------------------------------------------------------------------------

function composerState() {
  const st = C.makeState({ node: 'n1', grid: null })
  const handlers = {}
  const mk = id => ({ id, value: '', title: '', style: {}, placeholder: '', addEventListener: (ev, fn) => { handlers[`${id}:${ev}`] = fn } })
  const nameInput = mk('ahrc-name')
  const mountInput = mk('ahrc-mount')
  st.root = { querySelector: sel => (sel === '#ahrc-name' ? nameInput : sel === '#ahrc-mount' ? mountInput : null), querySelectorAll: () => [] }
  C.wireStatic(st)
  st.createBtn = { disabled: undefined, setDisabled(d) { this.disabled = d } }
  return {
    st,
    nameInput,
    mountInput,
    typeName(v) { nameInput.value = v; handlers['ahrc-name:input']() },
    typeMount(v) { mountInput.value = v; handlers['ahrc-mount:input']() },
  }
}

{
  const c = composerState()
  c.typeName('tank')
  c.typeMount('  /srv/media pool  ')
  c.st.disks = [{ id: 'ata-BLANK', status: 'available' }]
  c.st.assigned['ata-BLANK'] = 'pool'
  calls.confirm.length = 0
  C.commit(c.st)
  const sent = calls.confirm[0]
  ok('L4: the request sends the typed path, ends trimmed, inner space kept',
    sent && sent.body.mountpoint === '/srv/media pool', sent && JSON.stringify(sent.body))
  ok('L4: the confirm intro names the mountpoint', sent && /mounted at \/srv\/media pool/.test(text(sent.confirmIntro)), sent && sent.confirmIntro)
  ok('L4: and the pool', sent && /Creating pool tank/.test(text(sent.confirmIntro)))
  // Follow-up 6b: the daemon's 409 headline says the wipe ("Creating AHR
  // pool 'tank' will WIPE n disk(s) ...") and its warnings list every disk;
  // the intro says only what the operator typed.
  ok('6b: the create intro does not repeat the daemon headline', sent && !/WIPE|ERASE|destroyed/i.test(text(sent.confirmIntro)), sent && text(sent.confirmIntro))
  ok('L4: the create intro is exactly the pool and its mountpoint', sent && text(sent.confirmIntro) === 'Creating pool tank, mounted at /srv/media pool:', sent && text(sent.confirmIntro))

  const d = composerState()
  d.typeName('tank')
  d.st.disks = [{ id: 'ata-BLANK', status: 'available' }]
  d.st.assigned['ata-BLANK'] = 'pool'
  calls.confirm.length = 0
  C.commit(d.st)
  ok('L4: an empty field sends no mountpoint', calls.confirm[0] && !('mountpoint' in calls.confirm[0].body))
  ok('L4: and the confirm names the default', calls.confirm[0] && /mounted at \/mnt\/anas-ahr\/tank \(the default\)/.test(text(calls.confirm[0].confirmIntro)), calls.confirm[0] && text(calls.confirm[0].confirmIntro))

  // What AbsolutePath refuses (plus / and /mnt/pve) is refused at the field.
  for (const bad of ['srv/x', '/', '/mnt/pve', '/mnt/pve/x', '/srv/../etc', '/srv/a\tb', '/srv/a\u007fb']) {
    const e = composerState()
    e.typeName('tank')
    e.typeMount(bad)
    ok(`L4: "${JSON.stringify(bad)}" is refused at the field`, e.st.mountBad === true && e.mountInput.style.borderColor === 'var(--anas-danger)')
  }
  for (const good of ['/srv/media pool', '/srv/x', '/mnt/pvex']) {
    const e = composerState()
    e.typeName('tank')
    e.typeMount(good)
    ok(`L4: "${good}" is accepted`, e.st.mountBad === false)
  }
}

// ---- L5 -------------------------------------------------------------------------

const INVENTORY = [
  { id: 'ata-BLANK', status: 'available', size: 4 * TiB, model: 'M' },
  { id: 'scsi-LIO-ORG_lun0', status: 'available', size: 4 * TiB, handsOff: 'iscsi-served-here', handsOffReason: 'served by this node over iSCSI' },
  { id: 'ata-NULLTAG', status: 'available', size: 4 * TiB, handsOff: null },
  { id: 'ata-INUSE', status: 'in-use', size: 4 * TiB },
  { id: 'nvme-LEFTOVER', status: 'ahr_member', size: 1 * TiB },
]
const OFFERABLE = ['ata-BLANK']

{
  // The composer tray.
  routes = { 'GET /disks': { data: INVENTORY } }
  const st = C.makeState({ node: 'n1', grid: null })
  await new Promise(res => C.loadDisks(st, res))
  ok('L5: the composer tray offers only composable disks', JSON.stringify(st.disks.map(d => d.id)) === JSON.stringify(OFFERABLE), st.disks.map(d => d.id).join(','))

  const grid = { getSelection: () => [rec({ name: 'tank' })] }
  const leftover = pool({ cache: { devices: ['nvme-LEFTOVER'], sizeBytes: 1 * TiB, mode: '', policy: '', state: 'absent' } })
  const pickers = [
    ['spare', A.openAddSpare, pool(), OFFERABLE],
    ['cache', A.openAttachCache, pool(), OFFERABLE],
    // The route also takes the pool's own leftover cache slice (ahr-cache.ts
    // pickCacheDisks: `!isComposableDisk(disk) && !reclaimable.has(id)`).
    ['cache (leftover slice)', A.openAttachCache, leftover, ['ata-BLANK', 'nvme-LEFTOVER']],
    ['expand (add)', A.openExpand, pool(), OFFERABLE],
  ]
  for (const [label, open, P, want] of pickers) {
    routes = { 'GET /disks': { data: INVENTORY }, 'GET /ahr/tank': { data: P } }
    calls.drags.length = 0
    open(grid, 'n1')
    await settle()
    const offered = calls.drags[0] ? calls.drags[0].disks.map(d => d.id).sort() : null
    ok(`L5: the ${label} picker offers only what the route accepts`, JSON.stringify(offered) === JSON.stringify([...want].sort()), JSON.stringify(offered))
  }
  // Without the pool detail the cache picker falls back to composable only.
  routes = { 'GET /disks': { data: INVENTORY } }
  calls.drags.length = 0
  A.openAttachCache(grid, 'n1')
  await settle()
  ok('L5: the cache fallback list is composable only', calls.drags[0] && JSON.stringify(calls.drags[0].disks.map(d => d.id)) === JSON.stringify(OFFERABLE))

  // The two radio lists (expand replace mode, Replace dialog).
  for (const [label, open, bodyId, radio] of [
    ['expand (replace)', A.openExpand, 'ahrExpandBody', 'ahrx-new'],
    ['Replace dialog', A.openReplace, 'ahrReplaceBody', 'ahrr-new'],
  ]) {
    routes = { 'GET /disks': { data: INVENTORY }, 'GET /ahr/tank': { data: pool() } }
    calls.windows.length = 0
    open(grid, 'n1')
    await settle()
    const html = calls.windows[0] ? calls.windows[0].down(`#${bodyId}`).html : ''
    const offered = [...html.matchAll(new RegExp(`name="${radio}" value="([^"]+)"`, 'g'))].map(m => m[1])
    ok(`L5: the ${label} replacement list offers only composable disks`, JSON.stringify(offered) === JSON.stringify(OFFERABLE), JSON.stringify(offered))
  }

  // The source: no picker in either file filters on `status` alone any more.
  for (const f of ['39-ahr.js', '39-ahr-composer.js']) {
    const src = readFileSync(join(SRC, f), 'utf8')
    const raw = src.match(/status === 'available'/g) || []
    ok(`L5: ${f} tests status === 'available' only inside isComposableDisk`, raw.length === (f === '39-ahr.js' ? 1 : 0), raw.length)
  }
  // The predicate is the shared one, condition for condition.
  const shared = readFileSync(join(REPO, 'packages', 'shared', 'src', 'schemas', 'disks.ts'), 'utf8')
  ok('L5: the shared isComposableDisk is still status available AND handsOff undefined',
    /return disk\.status === 'available' && disk\.handsOff === undefined/.test(shared))
  const isC = ANAS.ahr.isComposableDisk
  ok('L5: the panel predicate agrees on every inventory row',
    INVENTORY.every(d => isC(d) === (d.status === 'available' && d.handsOff === undefined)))
}

// ---- L6 + L7 ----------------------------------------------------------------------

{
  const grid = { getSelection: () => [rec({ name: 'tank' })] }
  for (const [label, open, bodyId, radio] of [
    ['expand wizard', A.openExpand, 'ahrExpandBody', 'ahrx-old'],
    ['Replace dialog', A.openReplace, 'ahrReplaceBody', 'ahrr-old'],
  ]) {
    routes = { 'GET /disks': { data: INVENTORY }, 'GET /ahr/tank': { data: pool() } }
    calls.windows.length = 0
    open(grid, 'n1')
    await settle()
    const html = calls.windows[0] ? calls.windows[0].down(`#${bodyId}`).html : ''
    const listed = [...html.matchAll(new RegExp(`name="${radio}" value="([^"]+)"`, 'g'))].map(m => m[1])
    ok(`L6: the ${label} "Member to replace" lists the four members only`, JSON.stringify(listed) === JSON.stringify(ids), JSON.stringify(listed))
  }

  // The planner's preview warning; the daemon's 409 repeats it verbatim
  // (ahr-expand.ts expansionWarnings `...plan.preview.warnings`).
  const PLAN_WARNING = '2 TiB of capacity will be PENDING until one more disk reaches the top band'
  // The wizard's resulting layout is drawn from the same member set: run the
  // live plan with one disk added and read the band picture's rows.
  routes = {
    'GET /disks': { data: INVENTORY },
    'GET /ahr/tank': { data: pool() },
    'POST /ahr/tank/expand/plan': {
      data: {
        bands: [{ band: 1, range: { startBytes: 0, endBytes: 4 * TiB }, memberCount: 5, level: 'raid5', heightBytes: 4 * TiB, usableBytes: 16 * TiB, protected: true }],
        after: { rawBytes: 20 * TiB, usableBytes: 16 * TiB, usedBytes: 0, freeBytes: 0, redundancyOverheadBytes: 4 * TiB, unprotectedWastedBytes: 0, pendingBytes: 0 },
        steps: [],
        warnings: [PLAN_WARNING],
        usableGain: 4 * TiB,
      },
    },
  }
  calls.windows.length = 0
  calls.drags.length = 0
  dragSelection = ['ata-BLANK']
  A.openExpand(grid, 'n1')
  await settle()
  const win = calls.windows[0]
  calls.drags[0].onChange()   // a drop into the add bay → the live plan
  await settle()
  const planEl = { innerHTML: '' }
  // renderPlan writes into #ahrx-plan of the body root; read it back by
  // re-pointing the root's querySelector for this one check.
  const savedQS = fakeRoot.querySelector
  fakeRoot.querySelector = sel => (sel === '#ahrx-plan' ? planEl : savedQS(sel))
  calls.drags[0].onChange()
  await settle()
  fakeRoot.querySelector = savedQS
  const painted = [...planEl.innerHTML.matchAll(/title="([^"]+)"/g)].map(m => m[1]).filter(s => /^(ata-|nvme-)/.test(s))
  ok('L6: the resulting layout paints the members and the added disk, no cache SSD, no spare',
    JSON.stringify(painted) === JSON.stringify([...ids, 'ata-BLANK']), JSON.stringify(painted))

  // L7: Execute signs the request with a confirm that names the wiped disk.
  calls.confirm.length = 0
  const execBtn = win.cfg.buttons.find(b => b.itemId === 'ahrExpandExec')
  execBtn.handler()
  const sent = calls.confirm[0]
  ok('L7: Execute sends the planned body', sent && JSON.stringify(sent.body) === JSON.stringify({ addDisks: ['ata-BLANK'] }), sent && JSON.stringify(sent.body))
  ok('L7: the expand confirm names the disk it wipes', sent && text(sent.confirmIntro) === 'Adding to tank, WIPES ata-BLANK:', sent && sent.confirmIntro)
  // Follow-up 6b: the daemon's 409 carries the headline ("Expanding AHR pool
  // 'tank' starts an online reshape"), the reshape facts and the plan's
  // warnings; the intro repeats none of them.
  ok('6b: the expand intro does not repeat the daemon headline or the reshape facts',
    sent && !/Expanding|reshape|cancel/i.test(text(sent.confirmIntro)), sent && sent.confirmIntro)
  ok('6b: the plan warning is not prepended (the 409 lists it)', sent && sent.confirmIntro.indexOf('PENDING') < 0, sent && sent.confirmIntro)
  ok('6b: a plan with warnings still confirms in a window', sent && sent.confirmWindow === true)
  ok('6b: whose button reads "Expand anyway"', sent && sent.confirmButtonText === 'Expand anyway', sent && sent.confirmButtonText)
  dragSelection = []

  const two = text(A.expandConfirmIntro('tank', { addDisks: ['ata-X', 'ata-Y'] }))
  ok('L7: several added disks are all named', two === 'Adding to tank, WIPES ata-X, ata-Y:', two)
  const rep = text(A.expandConfirmIntro('tank', { replace: { oldDiskId: 'ata-A', newDiskId: 'ata-Z' } }))
  ok('L7: the replace mode names both disks and which one is wiped', rep === 'Replacing ata-A in tank with ata-Z, which is WIPED:', rep)
  ok('L7: disk ids are encoded', /&lt;x/.test(A.expandConfirmIntro('tank', { addDisks: ['<x'] })))
}

// ---- L8 -------------------------------------------------------------------------

{
  ok('L8: 29 characters pass for 1-9 disks', C.nameValid('a'.repeat(29), 1) && C.nameValid('a'.repeat(29), 9))
  ok('L8: 30 characters fail for 1-9 disks', !C.nameValid('a'.repeat(30), 1) && !C.nameValid('a'.repeat(30), 9))
  ok('L8: 28 pass and 29 fail for 10-99 disks', C.nameValid('a'.repeat(28), 10) && !C.nameValid('a'.repeat(29), 10))
  ok('L8: no disks yet reads the 1-disk cap', C.nameValid('a'.repeat(29), 0) && !C.nameValid('a'.repeat(30), 0))
  ok('L8: the PoolName pattern still holds', !C.nameValid('1tank', 1) && !C.nameValid('ta nk', 1) && C.nameValid('t-a_nk2', 1))
  // The shared formula, read from the schema, agrees with the panel's copy.
  const ahrTs = readFileSync(join(REPO, 'packages', 'shared', 'src', 'schemas', 'ahr.ts'), 'utf8')
  ok('L8: the shared ahrMaxPoolNameLength is still min(32 - 2d, 30 - d)',
    /const d = String\(Math\.max\(1, diskCount\)\)\.length\s+return Math\.min\(32 - 2 \* d, 30 - d\)/.test(ahrTs))

  const c = composerState()
  c.typeName('a'.repeat(40))
  c.st.disks = [{ id: 'ata-BLANK', status: 'available' }]
  c.st.assigned['ata-BLANK'] = 'pool'
  c.st.preview = { minDisksMet: true, warnings: [] }
  c.st.previewFresh = true
  C.syncCreateButton(c.st)
  ok('L8: a 40-character name keeps Create disabled', c.st.createBtn.disabled === true)
  ok('L8: the name field is red and says the cap', c.nameInput.style.borderColor === 'var(--anas-danger)' && /at most 29/.test(c.nameInput.title), c.nameInput.title)
  calls.confirm.length = 0
  C.commit(c.st)
  ok('L8: commit refuses it before any request', calls.confirm.length === 0)
  c.typeName('tank')
  ok('L8: a fitting name enables Create', c.st.createBtn.disabled === false)
  ok('L8: and clears the field', c.nameInput.style.borderColor === 'var(--anas-card-edge)' && c.nameInput.title === '')
}

// ---- L9 + titles ------------------------------------------------------------------

{
  const held = { targetIqn: 'iqn.2026-11.x:t', detail: 'held by iSCSI LUN 0 \'x\' of target t (/srv/<img src=x onerror=alert(1)>)' }
  const g = toolbarGrid(rec(pool({ heldByLun: held })))
  A.updateButtons(g)
  const tip = g.btns.destroy.tip || ''
  ok('L9: the LUN tooltip carries no raw markup', !/<img/.test(tip), tip)
  ok('L9: and keeps the sentence, encoded', /&lt;img src=x onerror=alert\(1\)&gt;/.test(tip) && /Delete the LUN from the iSCSI screen first/.test(tip), tip)

  const grid = { getSelection: () => [rec({ name: 'a<b' })] }
  routes = { 'GET /disks': { data: INVENTORY }, 'GET /ahr/a%3Cb': { data: pool({ name: 'a<b' }) } }
  for (const [label, open] of [['spare', A.openAddSpare], ['cache', A.openAttachCache], ['expand', A.openExpand], ['replace', A.openReplace]]) {
    calls.windows.length = 0
    open(grid, 'n1')
    await settle()
    const title = calls.windows[0] && calls.windows[0].cfg.title
    ok(`titles: the ${label} window title encodes the pool name`, /a&lt;b/.test(title || '') && !/a<b/.test(title || ''), title)
  }
}

console.log(`cr3-ahr-panel: ${passed} passed, ${failed} failed`)
if (failed) {
  process.exitCode = 1
}
