#!/usr/bin/env node
/*
 * ANAS — PVE-footprint ownership harness (story pvepool.2, slice U0).
 *
 * `ANAS.pve` is the ONE client-side ownership helper (10-api.js). It is PURE
 * and headless-checkable, so this harness loads the REAL 10-api.js into a
 * minimal sandbox (a stub ANAS with t/enc/warn/errText, no gfx — so the badge
 * exercises its plain-span fallback) and asserts on the verdicts it returns.
 * It proves the shape later slices replace the six per-file `isPveManaged`
 * copies with: per-kind ownership, the version-skew fallback (tightens, never
 * loosens), the badge text per kind, and the client-side naming guard.
 *
 *   node packages/pve-integration/test/pve-ownership.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

// ---- Load the REAL 10-api.js against a minimal ANAS -------------------------
//
// 10-api.js's IIFE grabs window.ANAS (creating it if absent) and adds the
// shared helpers, including ANAS.pve. It only touches fetch/Promise/Ext inside
// function bodies (never at load), so a bare sandbox with an ANAS stub is
// enough. The stub's enc is a real HTML escaper so badge() output is checked
// against escaped markup, exactly as it lands in a cell.

function loadPve() {
  const win = {}
  win.ANAS = {
    t: s => s,
    enc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    warn() {},
    errText: e => String((e && e.message) || e),
  }
  const sandbox = {
    window: win,
    console,
    Promise,
    setTimeout: fn => { fn(); return 1 },
    clearTimeout: () => {},
  }
  vm.runInNewContext(readFileSync(join(SRC, '10-api.js'), 'utf8'), sandbox, { filename: '10-api.js' })
  return win.ANAS
}

const ANAS = loadPve()

// ---- Assertions -------------------------------------------------------------

const failures = []
let checks = 0
function ok(label, cond, detail) {
  checks++
  if (!cond) { failures.push(`${label}${detail ? ` — ${detail}` : ''}`) }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// Fixtures: one nested zfspool storage (`rpool/data`), one bare-pool storage
// (`tank`), one `dir` storage, and a system pool.
const NESTED = { storage: 'local-zfs', type: 'zfspool', dataset: 'rpool/data', content: ['images', 'rootdir'] }
const BARE = { storage: 'datapool', type: 'zfspool', content: ['images', 'rootdir'] }
const DIR = { storage: 'local', type: 'dir', dataset: 'tank/iso', content: ['iso'] }
const ZFSP = { storage: 'zfsx', type: 'zfs', dataset: 'tank/vol', content: ['images'] }

const SKEW_REASON = id =>
  `PVE storage '${id}' manages pool 'rpool' (older daemon — per-dataset ownership unavailable)`

// ---- 1. ownership() returns the daemon's per-node verdict, per kind ---------

const POOL_NE = { name: 'rpool', pveStorages: [NESTED] }
const KINDS = {
  'storage-root': { kind: 'storage-root', storage: 'local-zfs', reason: 'PVE storage \'local-zfs\' owns rpool/data as a storage root' },
  'guest-volume': { kind: 'guest-volume', storage: 'local-zfs', reason: 'PVE storage \'local-zfs\' owns rpool/data/vm-100-disk-0 as a guest volume' },
  'dir-storage': { kind: 'dir-storage', storage: 'local', reason: 'PVE storage \'local\' owns tank/iso as directory storage' },
  'system': { kind: 'system', reason: 'rpool/ROOT/pve-1 is the boot filesystem of pool rpool' },
}

for (const [kind, verdict] of Object.entries(KINDS)) {
  const node = { name: 'rpool/data/vm-100-disk-0', pve: verdict }
  const got = ANAS.pve.ownership(node, POOL_NE, true)
  ok(`ownership(${kind}): returns the daemon's verdict`, got === verdict, JSON.stringify(got))
  ok(`ownership(${kind}): isOwned is true`, ANAS.pve.isOwned(node, POOL_NE, true) === true)
}

// A node WITHOUT a pve field and perNodeAvailable=true → not owned (new daemon
// says "this one is outside the footprint").
ok('ownership(new daemon, no pve): null',
  ANAS.pve.ownership({ name: 'rpool/media' }, POOL_NE, true) === null)
ok('ownership(new daemon, no pve): isOwned false',
  ANAS.pve.isOwned({ name: 'rpool/media' }, POOL_NE, true) === false)

// ---- 2. Version skew: the fallback tightens, never loosens ------------------

// Old daemon (perNodeAvailable=false) + a pool PVE names → whole-pool rule:
// storage-root, the first storage's id, and the skew sentence naming both.
const SK = ANAS.pve.ownership({ name: 'rpool/media' }, POOL_NE, false)
eq('skew: kind is storage-root', SK && SK.kind, 'storage-root')
eq('skew: storage is the first ref', SK && SK.storage, 'local-zfs')
eq('skew: reason names storage + pool + skew', SK && SK.reason, SKEW_REASON('local-zfs'))
ok('skew: isOwned true on an old-daemon PVE pool', ANAS.pve.isOwned({ name: 'rpool/media' }, POOL_NE, false) === true)

// SAME payload with perNodeAvailable=true → the missing pve means NOT owned
// (the gate does not fire from the pool field alone when the daemon stamps it).
ok('skew→new: same node, perNodeAvailable true ⇒ null',
  ANAS.pve.ownership({ name: 'rpool/media' }, POOL_NE, true) === null)
ok('skew→new: same node, perNodeAvailable true ⇒ isOwned false',
  ANAS.pve.isOwned({ name: 'rpool/media' }, POOL_NE, true) === false)

// Old daemon + a pool PVE does NOT name → still not owned (the fallback only
// ever adds ownership, it cannot make an ANAS pool PVE's).
const ANAS_POOL = { name: 'tank', pveStorages: [] }
ok('skew: an ANAS pool stays not-owned on an old daemon',
  ANAS.pve.ownership({ name: 'tank/media' }, ANAS_POOL, false) === null)
ok('skew: an ANAS pool stays not-owned (isOwned false)',
  ANAS.pve.isOwned({ name: 'tank/media' }, ANAS_POOL, false) === false)

// A daemon stamping a per-node verdict wins over the pool field, either way.
ok('per-node verdict beats the pool field (owned + perNode true)',
  ANAS.pve.ownership({ name: 'rpool/data', pve: KINDS['storage-root'] }, POOL_NE, true) === KINDS['storage-root'])
ok('per-node verdict beats the pool field (owned + perNode false)',
  ANAS.pve.ownership({ name: 'rpool/data', pve: KINDS['guest-volume'] }, POOL_NE, false) === KINDS['guest-volume'])

// ---- 3. badge() text per kind ----------------------------------------------

// No gfx in this sandbox → the plain .anas-gfx-badge span fallback, carrying
// the kind label and the reason as its title.
function badgeCheck(kind, o) {
  const b = ANAS.pve.badge(o)
  const label =
    kind === 'storage-root' ? 'PVE storage root: local-zfs'
      : kind === 'guest-volume' ? 'PVE guest volume (local-zfs)'
        : kind === 'dir-storage' ? 'PVE storage (local-zfs)'
          : 'System pool: boot filesystem'
  ok(`badge(${kind}): label present`, b.html.includes(label), b.html)
  ok(`badge(${kind}): uses the shared badge class`, b.html.includes('anas-gfx-badge'), b.html)
  eq(`badge(${kind}): tip is the reason`, b.tip, o.reason)
  return b
}
badgeCheck('storage-root', { kind: 'storage-root', storage: 'local-zfs', reason: 'R-root' })
badgeCheck('guest-volume', { kind: 'guest-volume', storage: 'local-zfs', reason: 'R-guest' })
badgeCheck('dir-storage', { kind: 'dir-storage', storage: 'local-zfs', reason: 'R-dir' })
badgeCheck('system', { kind: 'system', reason: 'R-sys' })

// The title carries the reason, HTML-escaped (the reason has apostrophes, not
// angle brackets — but a `<` in a reason must be escaped so it cannot inject).
const inj = ANAS.pve.badge({ kind: 'dir-storage', storage: 'x', reason: 'a <img> on rpool' })
ok('badge: a hostile reason is escaped in the title', inj.html.includes('a &lt;img&gt; on rpool') && !inj.html.includes('<img>'), inj.html)

eq('badge(null): empty html + tip', ANAS.pve.badge(null), { html: '', tip: '' })
eq('badge(undefined): empty html + tip', ANAS.pve.badge(undefined), { html: '', tip: '' })

// ---- 4. wouldBeClaimed — the client-side naming guard -----------------------

// POSITIVE: parent IS the configured path, baseName matches the guest regex.
eq('claimed: nested storage path (rpool/data)',
  ANAS.pve.wouldBeClaimed('rpool/data', 'vm-100-disk-0', POOL_NE), { storage: 'local-zfs' })
eq('claimed: bare pool (no dataset ⇒ pool name)',
  ANAS.pve.wouldBeClaimed('tank', 'subvol-101-disk-0', { name: 'tank', pveStorages: [BARE] }), { storage: 'datapool' })
eq('claimed: basevol prefix',
  ANAS.pve.wouldBeClaimed('tank', 'basevol-102-disk-0', { name: 'tank', pveStorages: [BARE] }), { storage: 'datapool' })
eq('claimed: plain `base` prefix',
  ANAS.pve.wouldBeClaimed('tank', 'base-103-disk-0', { name: 'tank', pveStorages: [BARE] }), { storage: 'datapool' })

// NEGATIVE: not a direct child of the storage path (deeper nesting is never
// listed by PVE's `zfs list -d1`).
eq('not claimed: a nested child under the storage path',
  ANAS.pve.wouldBeClaimed('rpool/data/vm-100-disk-0', 'subvol-104-disk-0', POOL_NE), null)
// NEGATIVE: the name does not match the guest pattern.
eq('not claimed: a non-guest basename', ANAS.pve.wouldBeClaimed('rpool/data', 'media', POOL_NE), null)
eq('not claimed: guest prefix without a vmid', ANAS.pve.wouldBeClaimed('tank', 'vm-disk-0', { name: 'tank', pveStorages: [BARE] }), null)
eq('not claimed: a bare prefix with no tail', ANAS.pve.wouldBeClaimed('tank', 'vm-100', { name: 'tank', pveStorages: [BARE] }), null)
// NEGATIVE: a parent that is not the storage's configured path (a nested
// storage points at rpool/data, so `otherpool` is not a footprint path).
eq('not claimed: a parent that is not any storage path',
  ANAS.pve.wouldBeClaimed('otherpool', 'vm-100-disk-0', POOL_NE), null)
// NEGATIVE: a `dir` storage is not a zfspool footprint (it inventories files).
eq('not claimed: under a dir storage, even with a guest name',
  ANAS.pve.wouldBeClaimed('tank/iso', 'vm-100-disk-0', { name: 'tank', pveStorages: [DIR] }), null)
// NEGATIVE: a `zfs` storage is not a zfspool footprint either.
eq('not claimed: under a zfs storage',
  ANAS.pve.wouldBeClaimed('tank/vol', 'vm-100-disk-0', { name: 'tank', pveStorages: [ZFSP] }), null)
// NEGATIVE: empty parent / base.
eq('not claimed: empty parent', ANAS.pve.wouldBeClaimed('', 'vm-100-disk-0', POOL_NE), null)
eq('not claimed: empty base', ANAS.pve.wouldBeClaimed('rpool/data', '', POOL_NE), null)

// GUEST_NAME_RE is the plugin's contract, verbatim (source: packages/shared/
// src/pve-footprint.ts). Spot-check the boundary cases the daemon relies on.
const RE = ANAS.pve.GUEST_NAME_RE
eq('regex: vm-100-disk-0', RE.test('vm-100-disk-0'), true)
eq('regex: subvol-100-foo (no -disk- tail)', RE.test('subvol-100-foo'), true)
eq('regex: basevol-102-disk-0', RE.test('basevol-102-disk-0'), true)
eq('regex: rejects vm-100 (no tail)', RE.test('vm-100'), false)
eq('regex: rejects media', RE.test('media'), false)
eq('regex: rejects vm-abc-disk-0 (no vmid)', RE.test('vm-abc-disk-0'), false)

// ---- 5. Records, not just plain objects ------------------------------------
//
// 30-pools.js and the Datasets grid pass ExtJS records (a .get method), not
// plain objects. pveField must read both the same way — this is the shape the
// helper actually sees in the page.

function rec(data) {
  return { data, get: k => data[k], set: (k, v) => { data[k] = v } }
}

// A pool RECORD with a non-empty pveStorages, driven the way 30-pools.js drives
// it: isOwned(rec, rec, false) — the pool row has no per-node field, so the
// whole-pool rule applies.
const pveRec = rec({ name: 'rpool', pveStorages: [NESTED] })
const nasRec = rec({ name: 'tank', pveStorages: [] })
ok('record: a PVE pool row is owned (perNode false)', ANAS.pve.isOwned(pveRec, pveRec, false) === true)
ok('record: an ANAS pool row is not owned (perNode false)', ANAS.pve.isOwned(nasRec, nasRec, false) === false)

// The pool-row verdict rides the whole-pool rule, so it agrees with the plain
// "non-empty pveStorages" test 30-pools.js used before U0 (no behaviour change).
const gotRec = ANAS.pve.ownership(pveRec, pveRec, false)
eq('record: pool-row verdict is the storage-root skew fallback',
  { kind: gotRec && gotRec.kind, storage: gotRec && gotRec.storage },
  { kind: 'storage-root', storage: 'local-zfs' })

// A dataset RECORD carrying a per-node pve verdict → returned, perNode true.
const dsRec = rec({ name: 'rpool/data/vm-100-disk-0', pve: KINDS['guest-volume'] })
ok('record: a per-node verdict is returned (perNode true)',
  ANAS.pve.ownership(dsRec, pveRec, true) === KINDS['guest-volume'])
// A dataset RECORD with no pve, perNode true → not owned.
ok('record: no pve + perNode true ⇒ not owned',
  ANAS.pve.isOwned(rec({ name: 'rpool/media' }), pveRec, true) === false)

// wouldBeClaimed reads the pool via .get too.
eq('record: wouldBeClaimed reads a record pool',
  ANAS.pve.wouldBeClaimed('rpool/data', 'vm-100-disk-0', pveRec), { storage: 'local-zfs' })

// ---- Report -----------------------------------------------------------------

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} pve-ownership checks passed`)
