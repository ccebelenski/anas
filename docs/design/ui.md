# The panels in the PVE web UI

## UI: Native PVE Panels (ExtJS)

> Decision (July 2026): ANAS follows the Ceph model. The UI is a set of native ExtJS panels injected into pve-manager — no separate web app, no iframe. The earlier Nuxt/Vue frontend (floating panels, embedded mode, ticket handoff) is retired; `anas` is a pure API gateway. Rationale: users live in the PVE UI; an iframed, differently-styled app inside it reads as foreign. Native panels inherit PVE's theme, interaction patterns, and node-scoped mental model by construction.

**Structure** (mirrors how Ceph presents in the node menu):

```
Node "pve1"
└─ ANAS                    (collapsible group in the node menu, injected)
   ├─ Dashboard            ExtJS panel — health summary, active jobs
   ├─ Storage
   │  ├─ Pools             grid of pools → detail window (topology, properties, scan, actions)
   │  └─ Disks             grid of disks → SMART window
   ├─ Shares (SMB/NFS)     added with Epics 6–7
   └─ Jobs                 added with Epic 9
```

**Interaction model:** PVE-native. Grids with toolbars for collection views; double-click / button → `Ext.window.Window` for details and actions; `Proxmox.window.Edit` subclasses for mutations (they already handle 4xx display, loading masks, and submit flow); confirmation flows use the 409 + `X-Anas-Confirm-Code` API contract. Long operations submit a job and surface progress the way PVE tasks do.

**"Not installed" check (the Ceph pattern):** before rendering, panels probe the gateway (`GET /api/nodes/<node>/v1/health` through the local gateway). Connection refused / probe failure renders a friendly "ANAS is not installed on this node" panel with install instructions — we cannot auto-install like Ceph (we don't ship through PVE's packaging), so the panel shows the release-tarball path (`tar xzf anas-<version>.tar.gz && cd anas-<version> && ./install.sh`) instead of a wizard.

**Code layout:** the panels live in `packages/pve-integration/` alongside the injection loader — plain ES5 ExtJS (matching PVE's bundle), split into per-view files concatenated to `anas.js` by the installer. No build step, no framework dependencies.

**Dev workflow:** panel development targets a PVE host (the stunt node) — edit, push via a fast deploy script, reload the PVE UI. API development keeps the mock loop: `anasd --mock` + the gateway serve realistic fixture data without ZFS hardware.

### `ANAS.gfx` — graphical visual language (Epic 15)

> Decision (2026-07-14, validated via three local HTML spikes — composer, pools-status, datasets-tree). Storage views use a purpose-built graphical language rather than plain grids, because the physical/spatial reality of storage (which disk in which vdev faulted; where the space went) is legible graphically in a way tables aren't. **SVG + DOM, never canvas** — canvas has no DOM nodes → no `anas-*` test hooks, no CSS theming, no accessibility.

**Three visual registers** (a deliberate, consistent separation):
- **Content objects** — skeuomorphic *filled* SVG with material gradients: disks (HDD platter+actuator / SSD label / NVMe PCB+gold), vdev "bays", the pool. Materials are theme-neutral (a real drive is grey regardless of UI theme).
- **Controls** — flat monochrome *line* icons (`currentColor`, so they theme): add / snapshot / share / lock / properties / trash / folder / pool. Always-visible with `title` tooltips (no hover-reveal).
- **Data viz** — capacity gauges/bars (fullness-coloured) and the pool-space donut (breakdown by dataset + free).

**Module surface** (`ANAS.gfx`, a new file in the `packages/pve-integration/` concat, loaded before the views):
- `icon(kind, {state})` / `objectIcon('pool'|'folder')` → content-object SVG; `ctl(name)` → control line-icon button; `gauge(frac)` / `bar(frac)` → capacity viz; `donut(segments)` + `legend(segments)` → breakdown ring.
- Monitor-side vocabulary (added with the 15.3/15.4/15.5 retrofits, so a faulted disk etc. looks identical in every view): `statePill(state)` pool/vdev state chip; `chip(text, {good})` property chip; `badge(text, {kind:'smb'|'nfs'})` share badge; `callout(html, {level})` advisory banner (reuses the composer advisor output); `activity(frac, {label})` animated scrub/resilver strip; `bay(label, inner)` read-only vdev bay; `diskCard({kind, state, id, sub})` skeuomorphic disk tile.
- `drag(el, {onDrop})` → the pointer-events drag/dropzone helper (ghost locked to source width — no resize-on-lift; dropzone hit-test via `elementFromPoint`). Native Pointer Events — no library for MVP (a vendored Interact.js UMD is an optional later polish for touch/snapping, added as an earlier-numbered concat file exposing a global).
- Shared `<defs>` (material gradients) + a scoped `<style>` (palette tokens) injected once by the layer. Chrome tokens inherit PVE light/dark; every object/control carries an `anas-gfx-*` hook.

**First increment (de-risk before the composer):** port `ANAS.gfx` into `pve-integration` and deploy a minimal graphical panel to the stunt node to confirm the *real* PVE page is happy — CSP permits inline SVG/style, no ExtJS event conflicts, theme inherits, a Playwright hook drives. (The one thing local spikes couldn't prove.)

**Consumers** (build order): Pool Composer (below, the flagship / Epic 3.23 build-side) → Pools status view (same objects, live health) → Datasets enriched tree (inline bars/chips/badges + persistent controls + space donut) → Dashboard/Disk-Health as the vocabulary matures. Graphics where they add insight; Shares/Users/Jobs stay tabular.

### Pool Composer (Epic 15.2 / story 3.23)

A large modal composer launched from the Pools view, serving **create** (empty draft) and **expand** (seeded with the pool's existing topology, shown read-only; stage additions). Built on `ANAS.gfx`.

- **Data flow:** on open, GET the node's disks (existing disks API), filter to available/blank. Hold a **client-side draft model** (`vdevs[]` with role/type/disks, an assigned map) — no server calls until commit. Commit → **create**: `POST /pools` with `CreatePoolRequest` (compose `dataVdevs[]/logVdevs[]/cacheDisks[]/spareDisks[]` from the draft, one shot); **expand**: `zpool add` per staged vdev (`AddVdevRequest`). Via `ANAS.runJob`. No new schema — the API is already vdev-centric.
- **Interaction:** available-disk objects (draggable) → vdev bays grouped by role; "Add vdev" (role+type) spins up a bay; drag disks in, remove returns them; change a bay's type inline. Live summary (usable capacity, redundancy, "survives N failures").
- **Validity gating:** the Create button is DISABLED until the draft is valid — ≥1 data vdev at/above its type-min, every vdev meets its min, and (hard rule, per 3.22) special/dedup vdevs are **redundant** (mirror or raidz). A log vdev is a mirror or an unmirrored log device; the unmirrored one warns but does not block, and raidz is never offered for a log (ZFS refuses it; the daemon answers `400` `A log vdev cannot be <type> — ZFS supports only single disks and mirrors as log devices` on create and on add). Mixed data-vdev types warn but don't block.
- **Pool advisor** (differentiator): a rules-based panel that (a) characterises best-use from the composition ("Capacity pool, all-HDD — sequential/large-file"), (b) suggests improvements from the *unused* disks ("2 free SSDs → a mirrored special vdev accelerates metadata/small files"), (c) states honest caveats (L2ARC helps only when the working set exceeds RAM yet fits cache, and costs RAM for headers; SLOG helps only sync writes; a special vdev's loss loses the pool). Advisory, not salesy.

---

## PVE UI Integration (injection mechanism)

PVE 9 has **no official UI extension hook**. Verified facts (PVE 9.2, stunt node):
- pveproxy serves unowned files dropped into `/usr/share/pve-manager/js/` (dpkg never removes files it doesn't own — survives upgrades)
- The PVE UI page sends no CSP headers — same-origin injected scripts work
- `PVEAuthCookie` is set by PVE's own JS with `Secure` + `SameSite=Lax` and tickets are **cluster-valid** (any node verifies against the replicated authkey)

Integration consists of:
1. **`/usr/share/pve-manager/js/anas.js`** — the ANAS ExtJS panels + loader (concatenated from `packages/pve-integration/`), served at `/pve2/js/anas.js`. Our file, upgrade-safe.
2. **One `<script>` line inserted into `/usr/share/pve-manager/index.html.tpl`** (after `pvemanagerlib.js`). The single fragile point: pve-manager upgrades overwrite the template. Mitigations: idempotent presence-checked insert, an apt `DPkg::Post-Invoke` hook re-applies after upgrades (`packages/pve-integration/apt-reapply.sh`, installed by `install.sh`), uninstall restores the pristine template. (`anas doctor` was never built — EPICS-HISTORY marks 10.6 OBE: install.sh's preflight is the doctor at install time.)
3. **Menu injection**: a direct prototype patch of `PVE.node.Config.initComponent` (NOT `Ext.override` — `callParent` in a runtime override resolves against a missing hierarchy and crashes panel construction). The captured original runs first; our injection is try/catch-guarded.
4. **Fail-open, always**: every ExtJS/PVE internal touched is feature-detected; worst-case failure is "no ANAS section appears" plus one `console.warn`. The PVE UI must never break because of ANAS.

### Forward compatibility

- **Epic 12 (multi-node)**: already assumed by the API shape — the node is a path parameter and forwarding is server-side. A cluster deployment is N gateways + N daemons; the UI needs no changes.
- **Upstream extension point**: if PVE ever ships an official UI hook, the tpl insert is replaced by the sanctioned mechanism; everything else stays.

---
