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
 * Simpler than the ZFS composer on purpose: AHR has no vdev topology to
 * arrange — the layout algorithm IS the product — so disk selection is a
 * checkbox list (full by-id shown, never truncated), not drag-and-drop.
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
            name: 'tank',
            tier: 'ahr1',
            disks: [],          // available disks (from /disks, status 'available')
            diskById: {},
            selected: {},       // diskId -> true
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
            if (state.selected[state.disks[i].id]) {
                out.push(state.disks[i].id);
            }
        }
        return out;
    }

    // ---- disk list ----------------------------------------------------------

    function diskKind(d) {
        if (d.rotational === true) {
            return 'hdd';
        }
        var tr = ('' + (d.transport || '')).toLowerCase();
        return tr === 'nvme' ? 'nvme' : 'ssd';
    }

    // One selectable disk row: checkbox, skeuomorphic icon, the FULL by-id
    // (wrapped, never truncated — UI discipline), model + size.
    function diskRowHtml(state, d) {
        var checked = state.selected[d.id] ? ' checked' : '';
        var icon = '';
        try {
            icon = ANAS.gfx.icon(diskKind(d), { scale: 0.5 }) || '';
        } catch (e) {
            icon = '';
        }
        var border = state.selected[d.id]
            ? 'border:1px solid var(--anas-accent);background:var(--anas-accent-soft)'
            : 'border:1px solid var(--anas-card-edge);background:linear-gradient(var(--anas-card-top),var(--anas-card-bot))';
        return '<label class="anas-ahrc-disk" data-id="' + enc(d.id) + '"'
            + ' style="display:flex;align-items:center;gap:9px;padding:7px 9px;margin:4px 0;'
            + 'border-radius:10px;cursor:pointer;' + border + '">'
            + '<input type="checkbox" class="anas-fld-ahrc-disk" name="ahrc-disk" value="' + enc(d.id) + '"' + checked + '>'
            + icon
            + '<span style="min-width:0;flex:1;line-height:1.3">'
            + '<span style="display:block;font-weight:650;font-size:12px;color:var(--anas-ink);'
            + 'overflow-wrap:anywhere">' + enc(d.id) + '</span>'
            + '<span style="display:block;font-size:11px;color:var(--anas-muted)">'
            + enc((d.model ? d.model + ' · ' : '') + fmtBytes(d.size)) + '</span>'
            + '</span></label>';
    }

    function renderDiskList(state) {
        var el = state.root ? state.root.querySelector('#ahrc-disks') : null;
        if (!el) {
            return;
        }
        var html = '';
        for (var i = 0; i < state.disks.length; i++) {
            html += diskRowHtml(state, state.disks[i]);
        }
        el.innerHTML = html
            || '<div style="color:var(--anas-muted);font-size:12px;text-align:center;padding:20px 0">'
                + enc(t('No available disks found')) + '</div>';
        var count = state.root.querySelector('#ahrc-diskcount');
        if (count) {
            count.textContent = selectedIds(state).length + ' / ' + state.disks.length
                + ' ' + t('selected');
        }
        // Wire checkbox changes (innerHTML replaced ⇒ rewire each render).
        var boxes = el.querySelectorAll('input[name="ahrc-disk"]');
        for (var b = 0; b < boxes.length; b++) {
            (function (box) {
                box.addEventListener('change', function () {
                    if (box.checked) {
                        state.selected[box.value] = true;
                    } else {
                        delete state.selected[box.value];
                    }
                    renderDiskList(state);
                    schedulePreview(state);
                });
            })(boxes[b]);
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
    function previewBarsHtml(state) {
        var p = state.preview;
        var bands = (p && p.bands) || [];
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
        var ids = selectedIds(state);
        var rows = '';
        // Largest first — the banding reads top-down like the design's tables.
        var sel = [];
        for (i = 0; i < ids.length; i++) {
            var d = state.diskById[ids[i]];
            if (d) {
                sel.push(d);
            }
        }
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
            + ' spellcheck="false" style="font:inherit;color:var(--anas-ink);padding:5px 8px;'
            + 'border-radius:8px;border:1px solid var(--anas-card-edge);'
            + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'outline:none;width:170px">'
            + '<span id="ahrc-tiers" style="display:inline-flex;gap:6px">'
            + tierButtonHtml(state, 'ahr1') + tierButtonHtml(state, 'ahr2') + '</span>'
            + '<span style="flex:1"></span>'
            + '<span style="font-size:11.5px;color:var(--anas-muted)">'
            + enc(t('Filesystem: btrfs (checksums + scrub) on one redundant volume — '
                + 'redundancy lives in the band arrays, never in btrfs.')) + '</span></div>'

            + '<div style="display:grid;grid-template-columns:300px minmax(380px,1fr) 280px;'
            + 'gap:14px;align-items:start">'

            // Disk multi-select
            + '<div style="' + CARD + '">'
            + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
            + '<span style="' + SEC + ';margin:0">' + enc(t('Disks')) + '</span>'
            + '<span id="ahrc-diskcount" style="color:var(--anas-muted);font-size:12px;'
            + 'margin-left:auto"></span></div>'
            + '<p style="color:var(--anas-muted);font-size:11.5px;margin:0 0 8px">'
            + enc(t('Every ticked disk is WIPED when the pool is created.')) + '</p>'
            + '<div id="ahrc-disks" class="anas-grid-ahrc-disks"></div></div>'

            // Sliced layout preview
            + '<div style="' + CARD + '" id="ahrc-preview"></div>'

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
                    schedulePreview(state);
                });
            })(tiers[i]);
        }
    }

    function wireStatic(state) {
        var root = state.root;
        var nameInput = root.querySelector('#ahrc-name');
        if (nameInput) {
            nameInput.addEventListener('input', function () {
                state.name = nameInput.value;
                nameInput.style.borderColor = nameValid(state.name)
                    ? 'var(--anas-card-edge)' : 'var(--anas-danger)';
                syncCreateButton(state);
            });
        }
        wireTiers(state);
    }

    // ---- commit -------------------------------------------------------------

    function commit(state) {
        var ids = selectedIds(state);
        if (!ids.length || !nameValid(state.name)) {
            return;
        }
        ANAS.confirmAndRun({
            node: state.node,
            method: 'post',
            path: '/ahr',
            body: { name: state.name, tier: state.tier, disks: ids },
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
                renderDiskList(state);
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
