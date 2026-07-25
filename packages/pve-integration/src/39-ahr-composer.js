/*
 * ANAS — Hybrid RAID (AHR) create composer. Epic 11 + AHR (docs/AHR-DESIGN.md §6.1).
 *
 * The AHR-shaped sibling of the ZFS Pool Composer (38-pool-composer.js): pick
 * disks, pick the fault-tolerance tier, and watch the LIVE sliced-layout
 * preview — horizontal disk bars with stacked band segments coloured per band
 * (protected solid, unprotected hatched/greyed and labelled), the labelled
 * AhrCapacity readout (usable / redundancy overhead / unprotected-wasted —
 * never a bare number) and the advisor callouts, all driven by
 * POST /ahr/layout/preview {disks, tier} on every selection change (dry-run,
 * no mutation). btrfs is the filesystem — stated, not chosen.
 *
 * Disk selection is drag-and-drop, the exact ZFS vdev-composer idiom (§6.1
 * revision 2026-07-24, story 11.14 — parallel construction): an available-disks
 * tray of the same skeuomorphic cards (ANAS.gfx.dragDisk) dragged into ONE pool
 * drop bay. AHR has no vdev arrangement — the planner does the banding, so there
 * is a single drop target; dragging a card back to the tray (or its ✕) removes
 * it. The shared drag controller (ANAS.ahrComposer.makeDragSelect) also drives
 * the expand wizard's add-disks step and the spare bay. Full by-id on every
 * card, never truncated.
 *
 * Create is disabled until the name is valid AND a fresh preview reports
 * minDisksMet. Commit: POST /ahr {name, tier, disks} through the 409 confirm
 * gate — the daemon's warnings list EVERY disk that will be wiped and the
 * confirm dialog surfaces them verbatim.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS) {
        return;
    }
    var ANAS = window.ANAS;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }
    function enc(s) {
        return ANAS.enc(s);
    }
    function fmtBytes(n) {
        try {
            return ANAS.formatBytes(n);
        } catch (e) {
            return '' + n;
        }
    }
    function gfxReady() {
        return ANAS.gfx && ANAS.gfx.ready ? ANAS.gfx.ready() : false;
    }

    // Tier vocabulary — meaning first, acronym second (§6.1). Minimums are the
    // client-side hint; the server's minDisksMet is the truth that gates Create.
    var TIERS = {
        ahr1: { label: '1-disk fault tolerance (AHR-1)', min: 2 },
        ahr2: { label: '2-disk fault tolerance (AHR-2)', min: 4 },
    };

    // Mirrors the shared PoolName schema (packages/shared/src/schemas/common.ts):
    // letter first, then alphanumeric/underscore/hyphen, ≤ 255.
    var NAME_RE = /^[a-z][\w-]*$/i;
    function nameValid(name) {
        return !!name && name.length <= 255 && NAME_RE.test(name);
    }

    function bandColor(band) {
        var n = ((Number(band) || 1) - 1) % 5 + 1;
        return 'var(--anas-series-' + n + ')';
    }
    var HATCH = 'repeating-linear-gradient(45deg,var(--anas-free),var(--anas-free) 6px,'
        + 'var(--anas-slot) 6px,var(--anas-slot) 12px)';

    var SEC = 'margin:0 0 8px;font-size:11px;font-weight:800;text-transform:uppercase;'
        + 'letter-spacing:.5px;color:var(--anas-muted)';
    var CARD = 'background:var(--anas-panel);border:1px solid var(--anas-panel-edge);'
        + 'border-radius:12px;padding:14px;box-shadow:var(--anas-shadow)';

    // ---- state --------------------------------------------------------------

    function makeState(opts) {
        return {
            node: opts.node,
            grid: opts.grid,
            name: '',
            mountpoint: '',
            mountBad: false,
            tier: 'ahr1',
            disks: [],          // available disks (from /disks, status 'available')
            diskById: {},
            assigned: {},       // diskId -> 'pool' when dragged into the bay
            drag: null,         // the shared drag-select controller
            preview: null,      // last AhrLayoutPreview
            previewFresh: false, // preview matches the current selection+tier
            previewSeq: 0,
            previewTimer: null,
            win: null,
            root: null,
            createBtn: null,
        };
    }

    function selectedIds(state) {
        var out = [];
        for (var i = 0; i < state.disks.length; i++) {
            if (state.assigned[state.disks[i].id] === 'pool') {
                out.push(state.disks[i].id);
            }
        }
        return out;
    }

    // ======================================================================
    // SHARED DRAG-SELECT CONTROLLER (11.14)
    // ======================================================================
    //
    // A tray of draggable disk cards + one or more drop bays, built on
    // ANAS.gfx.dragDisk + ANAS.gfx.drag — the SAME idiom the ZFS pool composer
    // (38-pool-composer.js) uses. Reused by this create composer, the expand
    // wizard's add-disks step and the spare-attach bay (39-ahr.js). The caller
    // supplies the static shell (a tray element carrying data-anas-zone=
    // "<trayZone>" and each bay carrying data-anas-zone="bay:<id>") plus the
    // candidate disks; the controller renders cards, wires drag + the ✕ remove
    // control, owns the diskId→bayId assignment map, and calls back on change.
    //
    //   spec:
    //     root       DOM element the zones live inside
    //     disks      [{id,size,model,rotational,transport}] candidates
    //     assigned   map diskId→bayId (caller-owned, mutated in place)
    //     bays       [{id, single}] (single → holds one disk; a new drop evicts
    //                the previous back to the tray)
    //     trayZone   available-zone name (default 'tray')
    //     cardClass  hook class on every card (default 'anas-ahrc-disk')
    //     removeClass/removeAttr/removeTitle   the ✕ control
    //     bayEmpty(bayId) → HTML for an empty bay (optional)
    //     blockDrop(diskId, bayId) → reason string to REFUSE the drop (optional);
    //                a refused disk is NOT assigned and onRefuse is called
    //     onRefuse(reason, diskId, bayId)  surface a refusal (optional)
    //     onChange()  after any assignment change
    //   returns { render, selectedInBay(bayId) }
    function makeDragSelect(spec) {
        spec = spec || {};
        var trayZone = spec.trayZone || 'tray';
        var cardClass = spec.cardClass || 'anas-ahrc-disk';
        var removeClass = spec.removeClass || 'anas-ahrc-unassign';
        var removeAttr = spec.removeAttr || 'data-ahr-unassign';
        var removeTitle = spec.removeTitle || t('Remove disk');
        var byId = {};
        (spec.disks || []).forEach(function (d) { byId[d.id] = d; });
        var bays = spec.bays || [];

        function baySingle(bayId) {
            for (var i = 0; i < bays.length; i++) {
                if (bays[i].id === bayId) { return bays[i].single === true; }
            }
            return false;
        }
        function cardHtml(d, removable) {
            return ANAS.gfx.dragDisk({
                id: d.id,
                kind: ANAS.gfx.diskKindOf(d),
                size: d.size,
                model: d.model || '',
                removable: removable,
                cardClass: cardClass,
                removeClass: removeClass,
                removeAttr: removeAttr,
                removeTitle: removeTitle,
                wrapId: true,
            });
        }
        function zoneEl(name) {
            return spec.root ? spec.root.querySelector('[data-anas-zone="' + name + '"]') : null;
        }
        function idsInBay(bayId) {
            var out = [];
            (spec.disks || []).forEach(function (d) {
                if (spec.assigned[d.id] === bayId) { out.push(d.id); }
            });
            return out;
        }
        function render() {
            var trayEl = zoneEl(trayZone);
            if (trayEl) {
                var html = '';
                (spec.disks || []).forEach(function (d) {
                    if (!spec.assigned[d.id]) { html += cardHtml(d, false); }
                });
                trayEl.innerHTML = html
                    || ('<div style="color:var(--anas-muted);font-size:12px;text-align:center;padding:14px 0">'
                        + enc((spec.disks && spec.disks.length) ? t('All disks placed')
                            : t('No available disks found')) + '</div>');
            }
            for (var b = 0; b < bays.length; b++) {
                var bayEl = zoneEl('bay:' + bays[b].id);
                if (!bayEl) { continue; }
                var ids = idsInBay(bays[b].id);
                var bh = '';
                for (var i = 0; i < ids.length; i++) {
                    if (byId[ids[i]]) { bh += cardHtml(byId[ids[i]], true); }
                }
                bayEl.innerHTML = bh || (spec.bayEmpty ? spec.bayEmpty(bays[b].id) : '');
            }
            wire();
        }
        function wire() {
            if (!spec.root) { return; }
            var cards = spec.root.querySelectorAll('.' + cardClass);
            for (var c = 0; c < cards.length; c++) {
                ANAS.gfx.drag(cards[c], {
                    zoneSelector: '[data-anas-zone]',
                    getId: function (elm) { return elm.getAttribute('data-id'); },
                    onDrop: onDrop,
                });
            }
            var rm = spec.root.querySelectorAll('[' + removeAttr + ']');
            for (var r = 0; r < rm.length; r++) {
                (function (btn) {
                    btn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        var id = btn.getAttribute(removeAttr);
                        if (spec.assigned[id]) {
                            delete spec.assigned[id];
                            render();
                            if (spec.onChange) { spec.onChange(); }
                        }
                    });
                    // A click on the remove control must not start a drag.
                    btn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
                })(rm[r]);
            }
        }
        function onDrop(id, zoneElm) {
            var zone = zoneElm.getAttribute('data-anas-zone');
            if (zone === trayZone) {
                if (spec.assigned[id]) { delete spec.assigned[id]; }
            } else if (zone.indexOf('bay:') === 0) {
                var bayId = zone.slice(4);
                if (spec.blockDrop) {
                    var reason = spec.blockDrop(id, bayId);
                    if (reason) {
                        if (spec.onRefuse) { spec.onRefuse(reason, id, bayId); }
                        render();  // bounce: the card stays in the tray
                        return;
                    }
                }
                if (baySingle(bayId)) {
                    idsInBay(bayId).forEach(function (other) {
                        if (other !== id) { delete spec.assigned[other]; }
                    });
                }
                spec.assigned[id] = bayId;
            } else {
                return;
            }
            render();
            if (spec.onChange) { spec.onChange(); }
        }
        return { render: render, selectedInBay: idsInBay };
    }

    // makeDragSelect is a gfx concern (it renders ANAS.gfx.dragDisk cards and
    // wires ANAS.gfx.drag), so its canonical home is the gfx namespace. The old
    // ANAS.ahrComposer.makeDragSelect name is kept as a back-compat alias so the
    // existing 39-ahr.js callers (spare bay, expand add-disks) keep working.
    //
    // SEAM (S6, deliberately NOT merged): the ZFS pool composer
    // (38-pool-composer.js) does NOT consume makeDragSelect. makeDragSelect is an
    // all-or-nothing controller — it OWNS card rendering and a flat diskId→bayId
    // `assigned` map, and its render() overwrites each bay's innerHTML with just
    // cards. The pool composer instead owns a multi-vdev model where each bay is
    // a typed, ordered, deletable vdev carrying its own <select data-vtype> +
    // delete-vdev control interleaved with the cards, plus renderRacks/renderAvail
    // rendering that is far richer than a flat card list. Taking "just the
    // drag/unassign layer" is not possible without either rewriting that model
    // (high risk, no UI test harness) or pulling the vdev machinery into the
    // shared helper (explicitly out of scope). The one primitive both genuinely
    // share — ANAS.gfx.drag — is already shared. So the pool composer keeps its
    // own wireDynamic; this promotion stops at homing the name + documenting the
    // seam.
    ANAS.gfx = ANAS.gfx || {};
    ANAS.gfx.makeDragSelect = ANAS.gfx.makeDragSelect || makeDragSelect;
    ANAS.ahrComposer = ANAS.ahrComposer || {};
    ANAS.ahrComposer.makeDragSelect = makeDragSelect;

    // The empty-pool-bay prompt (drop-target hint), sized to hint the minimum.
    function poolBayEmptyHtml(state) {
        var min = (TIERS[state.tier] || TIERS.ahr1).min;
        return '<div style="flex:1;min-width:230px;color:var(--anas-muted);font-size:12px;'
            + 'text-align:center;border:1.5px dashed var(--anas-card-edge);border-radius:10px;'
            + 'padding:20px 10px;background:var(--anas-bay-in)">'
            + '<span style="display:block;font-size:13px;color:var(--anas-ink);font-weight:600;margin-bottom:2px">'
            + enc(t('Drag disks here')) + '</span>'
            + enc(t('at least') + ' ' + min + ' ' + t(min === 1 ? 'disk' : 'disks')
                + ' — ' + t('mixed sizes are the point')) + '</div>';
    }

    // (Re)build the drag controller after the disks load, and render tray + bay.
    function mountDragSelect(state) {
        state.drag = makeDragSelect({
            root: state.root,
            disks: state.disks,
            assigned: state.assigned,
            bays: [{ id: 'pool' }],
            cardClass: 'anas-ahrc-disk',
            bayEmpty: function () { return poolBayEmptyHtml(state); },
            onChange: function () {
                updateDiskCount(state);
                schedulePreview(state);
            },
        });
        state.drag.render();
        updateDiskCount(state);
    }

    function updateDiskCount(state) {
        var count = state.root ? state.root.querySelector('#ahrc-diskcount') : null;
        if (count) {
            count.textContent = selectedIds(state).length + ' / ' + state.disks.length
                + ' ' + t('placed');
        }
    }

    // ---- preview ------------------------------------------------------------

    // Does this disk participate in the band? Boundaries are computed on the
    // §2.5-rounded usable sizes, which never exceed the raw size — so raw
    // size ≥ endBytes exactly selects the participating disks.
    function diskInBand(d, band) {
        return (Number(d.size) || 0) >= (Number(band.range && band.range.endBytes) || 0);
    }

    // Horizontal disk bars with stacked band segments: protected bands solid
    // (per-band series colour), unprotected hatched/greyed with a label. All
    // widths scale against the tallest usable boundary.
    // Shared core — also drives the expansion wizard's before→after picture
    // (exported as ANAS.ahr.bandBarsHtml; this file loads before 39-ahr.js).
    // diskList = [{id, size}] in any order.
    function bandBarsHtml(bands, diskList) {
        bands = bands || [];
        if (!bands.length) {
            return '';
        }
        var topEnd = 0;
        var i;
        for (i = 0; i < bands.length; i++) {
            var e = Number(bands[i].range && bands[i].range.endBytes) || 0;
            if (e > topEnd) {
                topEnd = e;
            }
        }
        if (!(topEnd > 0)) {
            return '';
        }
        var rows = '';
        // Largest first — the banding reads top-down like the design's tables.
        var sel = (diskList || []).slice();
        sel.sort(function (a, b) {
            return (Number(b.size) || 0) - (Number(a.size) || 0);
        });
        for (i = 0; i < sel.length; i++) {
            var disk = sel[i];
            var segs = '';
            var height = 0;
            for (var bi = 0; bi < bands.length; bi++) {
                var band = bands[bi];
                if (!diskInBand(disk, band)) {
                    continue;
                }
                var h = Number(band.heightBytes) || 0;
                height += h;
                var w = (h / topEnd) * 100;
                var prot = band['protected'] === true;
                var style = prot
                    ? 'background:' + bandColor(band.band) + ';color:#fff'
                    : 'background:' + HATCH + ';color:var(--anas-muted)';
                var label = prot
                    ? (w > 7 ? 'b' + band.band : '')
                    : (w > 14 ? t('unprotected') : (w > 7 ? '✕' : ''));
                segs += '<span title="' + enc(t('band') + ' ' + band.band + ' — '
                    + fmtBytes(h) + (prot
                        ? ' (' + (band.level || '') + ' × ' + band.memberCount + ')'
                        : ' (' + t('unprotected — wasted with this disk set') + ')'))
                    + '" style="display:inline-flex;align-items:center;justify-content:center;'
                    + 'width:' + w.toFixed(2) + '%;height:100%;' + style + ';'
                    + 'font-size:9.5px;font-weight:700;overflow:hidden;white-space:nowrap;'
                    + 'border-right:1px solid var(--anas-panel)">' + enc(label) + '</span>';
            }
            var barW = (height / topEnd) * 100;
            rows += '<div style="display:flex;align-items:center;gap:10px;margin:5px 0">'
                + '<span style="flex:0 0 200px;font-size:11px;color:var(--anas-ink);'
                + 'overflow-wrap:anywhere;line-height:1.25" title="' + enc(disk.id) + '">'
                + enc(disk.id) + '<br><span style="color:var(--anas-muted)">'
                + enc(fmtBytes(disk.size)) + '</span></span>'
                + '<span style="flex:1"><span style="display:inline-flex;width:' + barW.toFixed(2)
                + '%;height:22px;border-radius:5px;overflow:hidden;'
                + 'border:1px solid var(--anas-card-edge);background:var(--anas-slot)">'
                + segs + '</span></span></div>';
        }
        // Band legend: swatch + level × members + height + usable contribution.
        var legend = '';
        for (i = 0; i < bands.length; i++) {
            var b2 = bands[i];
            var prot2 = b2['protected'] === true;
            legend += '<div style="display:flex;align-items:center;gap:8px;font-size:11.5px;'
                + 'margin:3px 0;color:var(--anas-ink)">'
                + '<span style="width:11px;height:11px;border-radius:3px;flex:0 0 auto;background:'
                + (prot2 ? bandColor(b2.band) : HATCH) + '"></span>'
                + '<span>' + enc(t('Band') + ' ' + b2.band + ' — '
                    + (prot2
                        ? ((b2.level || '') + ' × ' + b2.memberCount + ' · '
                            + t('height') + ' ' + fmtBytes(b2.heightBytes) + ' · '
                            + t('usable') + ' ' + fmtBytes(b2.usableBytes))
                        : (t('unprotected') + ' · ' + fmtBytes(b2.heightBytes) + ' × '
                            + b2.memberCount + ' ' + t('disk(s) — wasted'))))
                + '</span></div>';
        }
        return rows + '<div style="margin-top:10px">' + legend + '</div>';
    }

    function previewBarsHtml(state) {
        var ids = selectedIds(state);
        var diskList = [];
        for (var i = 0; i < ids.length; i++) {
            var d = state.diskById[ids[i]];
            if (d) {
                diskList.push(d);
            }
        }
        return bandBarsHtml((state.preview && state.preview.bands) || [], diskList);
    }

    // Shared with 39-ahr.js (loads after this file): the expansion wizard
    // renders the plan's resulting layout with the same banded bars.
    ANAS.ahr = ANAS.ahr || {};
    ANAS.ahr.bandBarsHtml = bandBarsHtml;

    function capRow(label, value, emphasis) {
        return '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;'
            + 'border-bottom:1px dashed var(--anas-line)">'
            + '<span style="color:var(--anas-muted)">' + enc(label) + '</span>'
            + '<span style="font-variant-numeric:tabular-nums;'
            + (emphasis ? 'font-weight:750' : 'font-weight:600') + '">' + enc(value) + '</span></div>';
    }

    // The labelled AhrCapacity readout — never a bare number (§6.1). Values
    // rendered in human units (TiB with two decimals at TB scale) by the
    // shared formatter, independent of whatever text the API warnings carry.
    function renderCapacity(state) {
        var el = state.root ? state.root.querySelector('#ahrc-capacity') : null;
        if (!el) {
            return;
        }
        var p = state.preview;
        var cap = p && p.capacity;
        var html = '<div style="' + SEC + '">' + enc(t('Capacity')) + '</div>';
        if (!cap) {
            html += '<div style="color:var(--anas-muted);font-size:12px">'
                + enc(t('Select disks to see the layout and capacity.')) + '</div>';
        } else {
            html += capRow(t('Usable'), fmtBytes(cap.usableBytes), true)
                + capRow(t('Raw (selected disks)'), fmtBytes(cap.rawBytes))
                + capRow(t('Redundancy overhead'), fmtBytes(cap.redundancyOverheadBytes))
                + capRow(t('Unprotected (wasted)'), fmtBytes(cap.unprotectedWastedBytes));
            if (Number(cap.pendingBytes) > 0) {
                html += capRow(t('Pending (locked)'), fmtBytes(cap.pendingBytes));
            }
        }
        el.innerHTML = html;
    }

    // Advisor: the tier minimum when unmet, then the preview's warnings
    // VERBATIM — the daemon's advisor strings are the guidance (§6.1).
    function renderAdvisor(state) {
        var el = state.root ? state.root.querySelector('#ahrc-advisor') : null;
        if (!el) {
            return;
        }
        var gfx = ANAS.gfx;
        var html = '<div style="' + SEC + '">' + enc(t('Advisor')) + '</div>';
        var p = state.preview;
        var tier = TIERS[state.tier] || TIERS.ahr1;
        var n = selectedIds(state).length;

        function callout(inner, level) {
            try {
                if (gfx && typeof gfx.callout === 'function') {
                    var c = gfx.callout(inner, { level: level });
                    if (c) {
                        return '<div style="margin-bottom:6px">' + c + '</div>';
                    }
                }
            } catch (e) {
                // fall through
            }
            return '<div style="font-size:12px;margin-bottom:6px;color:'
                + (level === 'bad' ? 'var(--anas-danger)'
                    : level === 'warn' ? 'var(--anas-warn)' : 'var(--anas-ok)') + '">'
                + inner + '</div>';
        }

        if (p && p.minDisksMet === false) {
            html += callout('<b>' + enc(t(tier.label)) + '</b> ' + enc(t('needs at least')
                + ' ' + tier.min + ' ' + t('disks') + ' — ' + n + ' ' + t('selected.')), 'bad');
        } else if (!p && n > 0 && n < tier.min) {
            html += callout('<b>' + enc(t(tier.label)) + '</b> ' + enc(t('needs at least')
                + ' ' + tier.min + ' ' + t('disks') + '.'), 'bad');
        }
        var warns = (p && p.warnings) || [];
        for (var i = 0; i < warns.length; i++) {
            html += callout(enc(warns[i]), 'warn');
        }
        if (p && p.minDisksMet === true && !warns.length) {
            html += callout(enc(t('Layout looks good — every band is protected.')), 'ok');
        }
        if (!p && !n) {
            html += '<div style="color:var(--anas-muted);font-size:12px">'
                + enc(t('Tick disks on the left. Mixed sizes are the point — the layout '
                    + 'slices them into size-matched bands so every disk contributes.'))
                + '</div>';
        }
        el.innerHTML = html;
    }

    function renderPreviewArea(state, note) {
        var el = state.root ? state.root.querySelector('#ahrc-preview') : null;
        if (!el) {
            return;
        }
        var html = '<div style="' + SEC + '">' + enc(t('Sliced layout')) + '</div>';
        if (note) {
            html += '<div style="color:var(--anas-muted);font-size:12px;padding:14px 0;'
                + 'text-align:center">' + enc(note) + '</div>';
        } else {
            html += previewBarsHtml(state)
                || ('<div style="color:var(--anas-muted);font-size:12px;padding:14px 0;'
                    + 'text-align:center">'
                    + enc(t('Select disks to preview the band layout.')) + '</div>');
        }
        el.innerHTML = html;
    }

    function syncCreateButton(state) {
        if (!state.createBtn) {
            return;
        }
        var ok = nameValid(state.name)
            && !state.mountBad
            && state.previewFresh
            && !!state.preview
            && state.preview.minDisksMet === true;
        state.createBtn.setDisabled(!ok);
    }

    function renderAll(state, note) {
        try {
            renderPreviewArea(state, note);
            renderCapacity(state);
            renderAdvisor(state);
            syncCreateButton(state);
        } catch (e) {
            ANAS.warn('ahr composer render failed: ' + ANAS.errText(e));
        }
    }

    // Debounced live preview: every selection/tier change posts
    // /ahr/layout/preview (dry-run) and re-renders; a sequence guard drops
    // stale responses.
    function schedulePreview(state) {
        state.previewFresh = false;
        syncCreateButton(state);
        if (state.previewTimer) {
            clearTimeout(state.previewTimer);
        }
        state.previewTimer = setTimeout(function () {
            runPreview(state);
        }, 250);
    }

    function runPreview(state) {
        var ids = selectedIds(state);
        if (!ids.length) {
            state.preview = null;
            state.previewFresh = false;
            renderAll(state);
            return;
        }
        var seq = ++state.previewSeq;
        ANAS.api.post(state.node, '/ahr/layout/preview', {
            disks: ids,
            tier: state.tier,
        }).then(function (res) {
            if (seq !== state.previewSeq) {
                return; // a newer selection superseded this preview
            }
            if (state.win && (state.win.destroyed || state.win.destroying)) {
                return;
            }
            state.preview = (res && res.data) || null;
            state.previewFresh = !!state.preview;
            renderAll(state);
        }, function (err) {
            if (seq !== state.previewSeq) {
                return;
            }
            if (state.win && (state.win.destroyed || state.win.destroying)) {
                return;
            }
            state.preview = null;
            state.previewFresh = false;
            var note = (err && err.status === 404)
                ? t('Layout preview is not available in this build of the ANAS daemon yet.')
                : (t('Preview failed') + ': ' + ANAS.errText(err));
            renderAll(state, note);
        });
    }

    // ---- shell --------------------------------------------------------------

    function tierButtonHtml(state, key) {
        var active = state.tier === key;
        var style = active
            ? 'border:1px solid var(--anas-accent);background:var(--anas-accent-soft);'
                + 'color:var(--anas-accent);font-weight:700'
            : 'border:1px solid var(--anas-card-edge);'
                + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
                + 'color:var(--anas-ink)';
        return '<button type="button" class="anas-btn-ahrc-tier" data-tier="' + key + '"'
            + ' style="font:inherit;font-size:12px;cursor:pointer;padding:6px 12px;'
            + 'border-radius:8px;' + style + '">' + enc(t(TIERS[key].label)) + '</button>';
    }

    function shellHtml(state) {
        return '<div class="anas-ahr-composer" style="padding:16px;color:var(--anas-ink);'
            + 'font:13px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'

            // Header: name, tier toggle, the btrfs statement (not a choice).
            + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">'
            + '<span style="' + SEC + ';margin:0">' + enc(t('Pool')) + '</span>'
            + '<input type="text" class="anas-fld-ahrc-name" id="ahrc-name" value="' + enc(state.name) + '"'
            + ' spellcheck="false" placeholder="' + enc(t('name')) + '"'
            + ' style="font:inherit;color:var(--anas-ink);padding:5px 8px;'
            + 'border-radius:8px;border:1px solid var(--anas-card-edge);'
            + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'outline:none;width:170px">'
            + '<span style="' + SEC + ';margin:0">' + enc(t('Mount at')) + '</span>'
            + '<input type="text" class="anas-fld-ahrc-mount" id="ahrc-mount" value="' + enc(state.mountpoint || '') + '"'
            + ' spellcheck="false" placeholder="' + enc('/mnt/anas-ahr/' + (state.name || '<name>')) + '"'
            + ' title="' + enc(t('Optional. Absolute path; /mnt/pve is reserved for PVE. Empty = the default shown.')) + '"'
            + ' style="font:inherit;color:var(--anas-ink);padding:5px 8px;'
            + 'border-radius:8px;border:1px solid var(--anas-card-edge);'
            + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'outline:none;width:220px">'
            + '<span id="ahrc-tiers" style="display:inline-flex;gap:6px">'
            + tierButtonHtml(state, 'ahr1') + tierButtonHtml(state, 'ahr2') + '</span>'
            + '<span style="flex:1"></span>'
            + '<span style="font-size:11.5px;color:var(--anas-muted)">'
            + enc(t('Filesystem: btrfs (checksums + scrub) on one redundant volume — '
                + 'redundancy lives in the band arrays, never in btrfs.')) + '</span></div>'

            + '<div style="display:grid;grid-template-columns:300px minmax(380px,1fr) 280px;'
            + 'gap:14px;align-items:start">'

            // Available disks tray (drag source; drop a card back here to remove)
            + '<div style="' + CARD + '">'
            + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
            + '<span style="' + SEC + ';margin:0">' + enc(t('Available disks')) + '</span>'
            + '<span id="ahrc-diskcount" style="color:var(--anas-muted);font-size:12px;'
            + 'margin-left:auto"></span></div>'
            + '<p style="color:var(--anas-muted);font-size:11.5px;margin:0 0 8px">'
            + enc(t('Drag a disk into the pool bay. Every placed disk is WIPED when the '
                + 'pool is created. Drop it back here to remove it.')) + '</p>'
            + '<div id="ahrc-tray" class="anas-grid-ahrc-disks" data-anas-zone="tray"'
            + ' style="display:flex;flex-direction:column;min-height:60px;border-radius:11px;'
            + 'padding:2px"></div></div>'

            // Pool bay (the ONE drop target) + sliced layout preview beneath it
            + '<div style="display:flex;flex-direction:column;gap:14px">'
            + '<div style="' + CARD + '">'
            + '<span style="' + SEC + '">' + enc(t('Pool')) + '</span>'
            + '<div id="ahrc-bay" class="anas-gfx-bay anas-grid-ahrc-bay" data-anas-zone="bay:pool"'
            + ' style="display:flex;flex-wrap:wrap;gap:10px;padding:13px;min-height:96px;'
            + 'border-radius:11px;background:var(--anas-bay);'
            + 'box-shadow:inset 0 2px 6px rgba(0,0,0,.16)"></div></div>'
            + '<div style="' + CARD + '" id="ahrc-preview"></div></div>'

            // Capacity + advisor
            + '<div style="display:flex;flex-direction:column;gap:14px">'
            + '<div id="ahrc-capacity" style="' + CARD + '"></div>'
            + '<div id="ahrc-advisor" style="' + CARD + '"></div></div>'

            + '</div></div>';
    }

    // Wire the tier toggle. Re-run after each flip (the buttons are re-rendered
    // so the active style updates); the name input is wired once in wireStatic.
    function wireTiers(state) {
        var root = state.root;
        var tiers = root.querySelectorAll('.anas-btn-ahrc-tier');
        for (var i = 0; i < tiers.length; i++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var key = btn.getAttribute('data-tier');
                    if (!TIERS[key] || state.tier === key) {
                        return;
                    }
                    state.tier = key;
                    var holder = root.querySelector('#ahrc-tiers');
                    if (holder) {
                        holder.innerHTML = tierButtonHtml(state, 'ahr1') + tierButtonHtml(state, 'ahr2');
                        wireTiers(state);
                    }
                    // The empty-bay prompt states the tier minimum — re-render it.
                    if (state.drag) {
                        state.drag.render();
                    }
                    schedulePreview(state);
                });
            })(tiers[i]);
        }
    }

    function wireStatic(state) {
        var root = state.root;
        var nameInput = root.querySelector('#ahrc-name');
        var mountInput = root.querySelector('#ahrc-mount');
        if (nameInput) {
            nameInput.addEventListener('input', function () {
                state.name = nameInput.value;
                nameInput.style.borderColor = nameValid(state.name)
                    ? 'var(--anas-card-edge)' : 'var(--anas-danger)';
                // Keep the mountpoint placeholder tracking the default.
                if (mountInput) {
                    mountInput.placeholder = '/mnt/anas-ahr/' + (state.name || '<name>');
                }
                syncCreateButton(state);
            });
        }
        if (mountInput) {
            mountInput.addEventListener('input', function () {
                state.mountpoint = mountInput.value.replace(/\s+/g, '');
                // Optional field: empty = default. When set it must be an
                // absolute path outside PVE's namespace (daemon re-validates).
                var v = state.mountpoint;
                var bad = v !== '' && (v.charAt(0) !== '/' || v === '/'
                    || v === '/mnt/pve' || v.indexOf('/mnt/pve/') === 0);
                mountInput.style.borderColor = bad ? 'var(--anas-danger)' : 'var(--anas-card-edge)';
                state.mountBad = bad;
                syncCreateButton(state);
            });
        }
        wireTiers(state);
    }

    // ---- commit -------------------------------------------------------------

    function commit(state) {
        var ids = selectedIds(state);
        if (!ids.length || !nameValid(state.name) || state.mountBad) {
            return;
        }
        var body = { name: state.name, tier: state.tier, disks: ids };
        if (state.mountpoint) {
            body.mountpoint = state.mountpoint;
        }
        ANAS.confirmAndRun({
            node: state.node,
            method: 'post',
            path: '/ahr',
            body: body,
            view: state.win,
            confirmTitle: 'Create Hybrid RAID pool',
            // The daemon's 409 warnings list EVERY disk that will be wiped;
            // confirmAndRun renders them under this intro. Say it plainly.
            confirmIntro: '<b>' + enc(t('Creating this pool PERMANENTLY ERASES the disks below.'))
                + '</b> ' + enc(t('All data on them is destroyed:')),
            failTitle: 'Create failed',
            successMsg: t('Hybrid RAID pool created') + ': ' + state.name,
            onComplete: function () {
                if (state.win && !state.win.destroyed && !state.win.destroying) {
                    state.win.close();
                }
                if (state.grid && ANAS.ahr && typeof ANAS.ahr.reload === 'function') {
                    ANAS.ahr.reload(state.grid, state.node);
                }
            },
        });
    }

    // ---- data + window ------------------------------------------------------

    function loadDisks(state, done) {
        ANAS.api.get(state.node, '/disks').then(function (res) {
            var all = (res && res.data) || [];
            state.disks = [];
            state.diskById = {};
            for (var i = 0; i < all.length; i++) {
                if (all[i].status === 'available') {
                    state.disks.push(all[i]);
                    state.diskById[all[i].id] = all[i];
                }
            }
            if (done) {
                done(null);
            }
        }, function (err) {
            ANAS.warn('ahr composer disk load failed: ' + ANAS.errText(err));
            if (done) {
                done(err);
            }
        });
    }

    function openComposer(opts) {
        opts = opts || {};
        if (!opts.node) {
            ANAS.warn('ahr composer: no node');
            return;
        }
        if (!gfxReady()) {
            try {
                Ext.Msg.alert(t('Hybrid RAID'), t('The graphical layer is unavailable.'));
            } catch (e) {
                ANAS.warn('ahr composer: gfx unavailable');
            }
            return;
        }
        var state = makeState(opts);

        // Fill the ANAS content region, like the ZFS composer (DOM up(), not
        // ComponentQuery — see 38-pool-composer for why).
        var regionEl = null, rbox = null;
        try {
            var gridEl = opts.grid && opts.grid.getEl ? opts.grid.getEl() : null;
            var cardEl = gridEl && gridEl.up ? gridEl.up('.anas-view-card') : null;
            if (cardEl && cardEl.getBox) {
                regionEl = cardEl;
                rbox = cardEl.getBox();
            }
        } catch (eRegion) {
            regionEl = null;
            rbox = null;
        }

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-view-ahr-composer anas-win-ahr-composer',
                title: t('Create Hybrid RAID pool'),
                modal: true,
                x: rbox ? rbox.x : undefined,
                y: rbox ? rbox.y : undefined,
                width: rbox ? rbox.width : 1040,
                height: rbox ? rbox.height : 700,
                minWidth: 720,
                minHeight: 460,
                maximizable: true,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrComposerBody',
                    border: false,
                    scrollable: true,
                    bodyPadding: 0,
                    html: shellHtml(state),
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        cls: 'anas-btn-ahrc-cancel',
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Create pool'),
                        cls: 'anas-btn-ahrc-create',
                        itemId: 'ahrComposerCreateBtn',
                        disabled: true,
                        handler: function () {
                            try {
                                commit(state);
                            } catch (e) {
                                ANAS.warn('ahr composer commit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
                listeners: {
                    afterrender: function (w) {
                        try {
                            var bodyPanel = w.down('#ahrComposerBody');
                            state.win = w;
                            state.createBtn = w.down('#ahrComposerCreateBtn');
                            state.root = bodyPanel && bodyPanel.getEl() ? bodyPanel.getEl().dom : null;
                            if (!state.root) {
                                return;
                            }
                            wireStatic(state);
                            renderAll(state);
                        } catch (e) {
                            ANAS.warn('ahr composer wiring failed: ' + ANAS.errText(e));
                        }
                    },
                    destroy: function () {
                        if (state.previewTimer) {
                            clearTimeout(state.previewTimer);
                        }
                    },
                },
            });
        } catch (e) {
            ANAS.warn('ahr composer window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        if (regionEl) {
            var refit = function () {
                try {
                    if (win.destroyed || win.destroying) {
                        return;
                    }
                    var b = regionEl.getBox();
                    win.setBox({ x: b.x, y: b.y, width: b.width, height: b.height });
                } catch (eFit) {
                    // non-fatal
                }
            };
            Ext.on('resize', refit);
            win.on('destroy', function () {
                try {
                    Ext.un('resize', refit);
                } catch (eU) {
                    // non-fatal
                }
            });
        }
        try {
            win.setLoading(true);
        } catch (e2) {
            // non-fatal
        }
        loadDisks(state, function () {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                win.setLoading(false);
            } catch (e3) {
                // non-fatal
            }
            if (state.root) {
                mountDragSelect(state);
                renderAll(state);
            }
        });
    }

    // Public surface — launched from the Hybrid RAID toolbar's Create button.
    ANAS.ahrComposer = ANAS.ahrComposer || {};
    ANAS.ahrComposer.open = function (o) {
        try {
            openComposer(o);
        } catch (e) {
            ANAS.warn('ahr composer open failed: ' + ANAS.errText(e));
        }
    };
})();
