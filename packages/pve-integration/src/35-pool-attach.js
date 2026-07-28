/*
 * ANAS — ZFS Pool Expansion UI (story 3.31, stage 2). Retires the opaque
 * "Attach / Replace" combobox window and replaces it with a drag-drop
 * expansion surface where DROP-LOCATION = INTENT, folded into the composer
 * idiom (parallel construction with the AHR expand, 39-ahr.js).
 *
 * One toolbar action ('attachDisk', kept so 30-pools' PVE-hands-off gate and
 * the generic action loop still resolve it) opens a modal with two modes:
 *
 *   Expand — the pool's top-level DATA vdevs render as drag DROP TARGETS, one
 *            per GET /pools/:name/expansion `targets[]` entry. Dropping ONE
 *            available disk onto a target does the honest thing for WHERE it
 *            lands:
 *              kind 'attach-leg'   (mirror / single) → POST {existingDiskId, newDiskId}
 *                                   +redundancy, resilver, NO new capacity.
 *              kind 'raidz-expand' (raidzN)          → POST {targetVdev, newDiskId}
 *                                   +capacity, the array reflows online.
 *            A refused target (allowed:false) is disabled/ineligible and shows
 *            its daemon `reasonDetail` VERBATIM (the version/flag/degraded fix),
 *            refusing the drop in place (the makeDragSelect blockDrop idiom).
 *            raidz targets headline `honestUsableGainBytes` (NOT the naive +1
 *            figure) and render `advisories[]` verbatim. A whole-new-vdev grow
 *            (zpool add, story 3.11) is reachable via the composer.
 *
 *   Replace — the pool's leaf devices render as drop slots; drag a replacement
 *            onto a member → POST {existingDiskId, newDiskId, replace:true}. The
 *            daemon resilvers, then `zpool online -e` realizes any larger disk's
 *            extra capacity (story 3.31a).
 *
 * Busy gate: while report.busy.busy (a resilver or raidz reflow is running) the
 * Expand surface is BLOCKED with the in-progress op + percent + "try again when
 * it finishes" — the AHR degraded-refusal altitude, no confirm bypass. The
 * daemon re-gates on commit (409 with a reason) and that message is surfaced.
 * Replace is exempt from the busy gate (the daemon allows replacing the very
 * disk that is degraded), so Replace mode stays available while busy.
 *
 * ONE disk per expansion (OpenZFS has no atomic multi-disk widen): a second
 * drop evicts the first, so exactly one operation is ever staged. Advisories
 * flip the shared ANAS.gfx.warnGate chip amber and require "Expand anyway",
 * exactly like the create/AHR gate.
 *
 * FRAMEWORK CONTRACT: window.ANAS with ANAS.pools.registerAction, ANAS.api.get,
 * ANAS.runJob, ANAS.pools.reload, ANAS.gfx.* (warnGate / dragDisk / drag /
 * makeDragSelect / callout), ANAS.composer.open, ANAS.t / ANAS.enc /
 * ANAS.formatBytes / ANAS.warn / ANAS.errText. Fail open: guarded IIFE + guarded
 * builders; a throw warns and never breaks PVE.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    // Fail open: only register when the pools framework is present.
    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.pools) {
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

    var SEC = 'margin:0 0 8px;font-size:11px;font-weight:800;text-transform:uppercase;'
        + 'letter-spacing:.5px;color:var(--anas-muted)';
    var CARD = 'background:var(--anas-panel);border:1px solid var(--anas-panel-edge);'
        + 'border-radius:12px;padding:14px;box-shadow:var(--anas-shadow)';

    // ---- small helpers ------------------------------------------------------

    function assignedIds(map) {
        var out = [];
        for (var k in map) {
            if (map.hasOwnProperty(k)) {
                out.push(k);
            }
        }
        return out;
    }
    function indexOf(arr, v) {
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === v) {
                return i;
            }
        }
        return -1;
    }
    function makeDragSelect() {
        var f = (ANAS.gfx && ANAS.gfx.makeDragSelect)
            || (ANAS.ahrComposer && ANAS.ahrComposer.makeDragSelect);
        return typeof f === 'function' ? f : null;
    }

    // The by-id leaves of every top-level vdev, keyed by vdev name. A mirror /
    // raidz vdev lists its member disks; a single-disk data vdev is its own leaf
    // (the vdev name IS the device), so it falls back to the vdev name.
    function buildVdevMap(detail) {
        var map = {};
        var leaves = [];        // every pool leaf { id, state, vdevName, role }
        var groups = (detail && detail.vdevGroups) || [];
        for (var gi = 0; gi < groups.length; gi++) {
            var role = groups[gi].role;
            var vdevs = groups[gi].vdevs || [];
            for (var vi = 0; vi < vdevs.length; vi++) {
                var v = vdevs[vi];
                var disks = v.disks || [];
                var ids = [];
                if (disks.length) {
                    for (var di = 0; di < disks.length; di++) {
                        ids.push(disks[di].id);
                        leaves.push({
                            id: disks[di].id,
                            state: disks[di].state || '',
                            vdevName: v.name,
                            role: role,
                        });
                    }
                } else if (v.name) {
                    // Single-disk vdev — the vdev name is the leaf device.
                    ids.push(v.name);
                    leaves.push({ id: v.name, state: v.state || '', vdevName: v.name, role: role });
                }
                map[v.name] = { role: role, type: v.type, leaves: ids, firstLeaf: ids[0] || v.name };
            }
        }
        return { byName: map, leaves: leaves };
    }

    // ---- intent vocabulary --------------------------------------------------

    function intentTitle(target) {
        if (target.kind === 'raidz-expand') {
            return t('RAIDZ expansion — adds capacity');
        }
        return t('Mirror leg — adds redundancy');
    }
    function intentBlurb(target) {
        if (target.kind === 'raidz-expand') {
            return t('A disk dropped here widens this raidz. The array reflows online; '
                + 'realized capacity is an estimate (see below).');
        }
        return t('A disk dropped here adds a mirror leg. It resilvers to restore/add '
            + 'redundancy — no new capacity.');
    }

    // The honest capacity + advisories for one raidz target, rendered verbatim.
    function targetCapacityHtml(target) {
        if (target.kind !== 'raidz-expand') {
            return '';
        }
        var html = '';
        var honest = target.honestUsableGainBytes;
        if (honest !== undefined && honest !== null) {
            // Naive +1-column figure lives ONLY in the tooltip — never the headline.
            var tip = '';
            if (target.naiveUsableGainBytes !== undefined && target.naiveUsableGainBytes !== null) {
                tip = ' title="' + enc(t('Naive +1-disk column would be ~')
                    + fmtBytes(target.naiveUsableGainBytes)
                    + t('; the difference stays locked until existing data is rewritten.')) + '"';
            }
            html += '<div' + tip + ' style="font-size:12px;color:var(--anas-ink);margin:6px 0 2px">'
                + enc(t('Realized usable gain')) + ' <b style="font-variant-numeric:tabular-nums">≈ +'
                + enc(fmtBytes(honest)) + '</b> <span style="color:var(--anas-muted)">'
                + enc('(' + t('estimate') + ')') + '</span></div>';
        } else {
            html += '<div style="font-size:12px;color:var(--anas-muted);margin:6px 0 2px">'
                + enc(t('Usable gain is an estimate — see advisories.')) + '</div>';
        }
        return html;
    }

    // Advisories[] for a target, verbatim, as muted warn callouts.
    function targetAdvisoriesHtml(target) {
        var adv = target.advisories || [];
        if (!adv.length) {
            return '';
        }
        var html = '';
        for (var i = 0; i < adv.length; i++) {
            var c = '';
            try {
                if (ANAS.gfx && typeof ANAS.gfx.callout === 'function') {
                    c = ANAS.gfx.callout(enc(adv[i]), { level: 'warn' }) || '';
                }
            } catch (e) {
                c = '';
            }
            html += c
                ? ('<div style="margin:4px 0">' + c + '</div>')
                : ('<div style="font-size:11.5px;color:var(--anas-warn);margin:4px 0">⚠ '
                    + enc(adv[i]) + '</div>');
        }
        return html;
    }

    // A hard refusal / busy block — the AHR degraded-refusal altitude (the
    // danger-tinted ⛔ block the operator validated on the spare bay).
    function refusalBlockHtml(reason) {
        return '<div style="font-size:12px;padding:9px 11px;border-radius:9px;'
            + 'background:color-mix(in srgb,var(--anas-danger) 14%,transparent);'
            + 'color:var(--anas-danger);display:flex;gap:8px;align-items:flex-start">'
            + '<span>⛔</span><span>' + enc(reason) + '</span></div>';
    }

    function busyMessage(busy) {
        var op = busy.operation === 'raidz-expand' ? t('RAIDZ expansion reflow')
            : (busy.operation === 'resilver' ? t('resilver') : t('operation'));
        var pct = (busy.percentComplete !== undefined && busy.percentComplete !== null)
            ? (' (' + Math.round(Number(busy.percentComplete)) + '% ' + t('complete') + ')')
            : '';
        var vd = busy.vdev ? (' ' + t('on') + ' ' + busy.vdev) : '';
        return t('This pool is busy: a') + ' ' + op + pct + vd + '. '
            + t('Expansion cannot start while a resilver or RAIDZ reflow is running — '
                + 'try again when it finishes.');
    }

    // ======================================================================
    // WINDOW
    // ======================================================================

    function openExpand(node, grid, poolName) {
        if (!poolName) {
            return;
        }
        var win = null;
        var report = null;      // PoolExpansionReport
        var detail = null;      // PoolDetail (topology → leaves)
        var avail = [];         // available disks (drag source)
        var vmap = { byName: {}, leaves: [] };

        var mode = 'expand';    // 'expand' | 'replace'
        var drag = null;        // the active makeDragSelect controller
        var assigned = {};      // diskId -> bayId (controller-owned)
        var prevIds = [];       // for the one-disk-total invariant
        var bayMeta = {};       // bayId -> { kind, vdevName, existingDiskId, target, allowed, reason }

        function bodyEl() {
            var p = win ? win.down('#pexBody') : null;
            return (p && p.getEl()) ? p.getEl().dom : null;
        }
        function execBtn() {
            return win ? win.down('#pexExec') : null;
        }
        function refusalEl() {
            var root = bodyEl();
            return root ? root.querySelector('#pex-refusal') : null;
        }
        function showRefusal(reason) {
            var el = refusalEl();
            if (!el) {
                return;
            }
            el.innerHTML = reason ? refusalBlockHtml(reason) : '';
        }

        // The single staged (op, disk), or null.
        function staged() {
            var ids = assignedIds(assigned);
            if (ids.length !== 1) {
                return null;
            }
            var diskId = ids[0];
            var meta = bayMeta[assigned[diskId]];
            if (!meta || !meta.allowed) {
                return null;
            }
            return { meta: meta, newDiskId: diskId };
        }

        // Enforce ONE disk total across every bay (evict the older on a 2nd drop).
        function enforceSingle() {
            var ids = assignedIds(assigned);
            if (ids.length <= 1) {
                prevIds = ids;
                return;
            }
            var keep = null;
            for (var i = 0; i < ids.length; i++) {
                if (indexOf(prevIds, ids[i]) < 0) {
                    keep = ids[i];
                }
            }
            if (!keep) {
                keep = ids[ids.length - 1];
            }
            for (var j = 0; j < ids.length; j++) {
                if (ids[j] !== keep) {
                    delete assigned[ids[j]];
                }
            }
            if (drag) {
                drag.render();
            }
            prevIds = assignedIds(assigned);
        }

        function updateExec() {
            var b = execBtn();
            if (b) {
                b.setDisabled(!staged());
            }
        }

        // ---- summary (the staged action + the shared warnGate chip) --------

        function renderSummary() {
            var root = bodyEl();
            var el = root ? root.querySelector('#pex-summary') : null;
            if (!el) {
                return;
            }
            var s = staged();
            if (!s) {
                el.innerHTML = '<div style="' + SEC + '">' + enc(t('Ready')) + '</div>'
                    + '<div style="color:var(--anas-muted);font-size:12px">'
                    + enc(mode === 'replace'
                        ? t('Drag a replacement onto the member you want to replace.')
                        : t('Drag one available disk onto a target to stage an expansion.'))
                    + '</div>';
                return;
            }
            var meta = s.meta;
            var advisories = [];
            var lead;
            if (mode === 'replace') {
                lead = t('Replace') + ' <b>' + enc(meta.existingDiskId) + '</b> ' + t('with')
                    + ' <b>' + enc(s.newDiskId) + '</b>. '
                    + t('A resilver copies its data across; if the replacement is larger, '
                        + 'the pool onlines the device (-e) to realize the extra capacity.');
            } else if (meta.kind === 'raidz-expand') {
                advisories = (meta.target && meta.target.advisories) || [];
                var gain = meta.target && meta.target.honestUsableGainBytes;
                lead = t('Expand raidz') + ' <b>' + enc(meta.vdevName) + '</b> ' + t('with')
                    + ' <b>' + enc(s.newDiskId) + '</b>. '
                    + ((gain !== undefined && gain !== null)
                        ? (t('Realized usable gain') + ' ≈ +' + fmtBytes(gain) + ' (' + t('estimate') + '). ')
                        : '')
                    + t('The array reflows online.');
            } else {
                lead = t('Attach') + ' <b>' + enc(s.newDiskId) + '</b> '
                    + t('as a mirror leg of') + ' <b>' + enc(meta.vdevName) + '</b>. '
                    + t('It resilvers to add redundancy — no new capacity.');
            }
            var html = '<div style="' + SEC + '">' + enc(t('Ready')) + '</div>'
                + '<div style="font-size:12.5px;color:var(--anas-ink)">' + lead + '</div>';
            if (advisories.length) {
                html += targetAdvisoriesHtml(meta.target);
            }
            if (ANAS.gfx && ANAS.gfx.warnGate) {
                html += ANAS.gfx.warnGate.chip(advisories,
                    mode === 'replace' ? 'Ready to replace.' : 'Ready to expand.');
            }
            el.innerHTML = html;
        }

        function onChange() {
            enforceSingle();
            showRefusal(null);
            renderSummary();
            updateExec();
        }

        // ---- EXPAND mode render --------------------------------------------

        function targetCardHtml(target, bayId) {
            var allowed = target.allowed !== false;
            var head = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">'
                + '<span style="font-weight:700;background:var(--anas-slot);'
                + 'border:1px solid var(--anas-card-edge);border-radius:6px;padding:2px 9px">'
                + enc(target.vdevName) + '</span>'
                + '<span style="font-size:10px;font-weight:800;text-transform:uppercase;'
                + 'letter-spacing:.5px;color:var(--anas-muted)">' + enc(target.vdevType || '') + '</span>'
                + '<span style="flex:1"></span>'
                + '<span style="font-size:11.5px;color:'
                + (allowed ? 'var(--anas-accent)' : 'var(--anas-muted)') + '">'
                + enc(intentTitle(target)) + '</span></div>';

            var info = '<div style="font-size:11.5px;color:var(--anas-muted);margin-bottom:6px">'
                + enc(intentBlurb(target)) + '</div>';

            var body;
            if (allowed) {
                info += targetCapacityHtml(target);
                info += targetAdvisoriesHtml(target);
                // The live drop zone (makeDragSelect fills this).
                body = '<div class="anas-gfx-bay anas-grid-pex-bay" data-anas-zone="bay:' + enc(bayId) + '"'
                    + ' style="display:flex;flex-wrap:wrap;gap:8px;min-height:64px;border-radius:11px;'
                    + 'padding:10px;background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)">'
                    + '</div>';
            } else {
                // Ineligible: the daemon's reasonDetail verbatim (states the fix),
                // and a refusing (non-live) drop zone with the ⛔ treatment. The
                // "ineligible" label is supplied by bayEmpty() so it survives the
                // makeDragSelect render() that fills this zone.
                var why = target.reasonDetail || target.reason || t('This target is not eligible.');
                info += '<div style="margin:2px 0 6px">' + refusalBlockHtml(why) + '</div>';
                body = '<div class="anas-gfx-bay anas-grid-pex-bay" data-anas-zone="bay:' + enc(bayId) + '"'
                    + ' style="display:flex;align-items:center;justify-content:center;min-height:64px;'
                    + 'border-radius:11px;padding:10px;background:var(--anas-slot);opacity:.6;'
                    + 'border:1.5px dashed var(--anas-card-edge);color:var(--anas-muted);font-size:11.5px">'
                    + '</div>';
            }

            return '<div style="border-radius:13px;overflow:hidden;border:1px solid var(--anas-panel-edge);'
                + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
                + 'box-shadow:var(--anas-shadow);margin-bottom:12px;padding:12px 12px 6px">'
                + head + info + body + '</div>';
        }

        function mountExpandDrag() {
            var root = bodyEl();
            if (!root) {
                return;
            }
            // Wire the new-vdev composer hand-off.
            var nv = root.querySelector('#pex-newvdev');
            if (nv) {
                nv.addEventListener('click', function () {
                    try {
                        if (ANAS.composer && typeof ANAS.composer.open === 'function') {
                            if (win && !win.destroyed && !win.destroying) {
                                win.close();
                            }
                            ANAS.composer.open({
                                node: node, grid: grid, mode: 'expand', poolName: poolName,
                            });
                            return;
                        }
                        ANAS.alertMsg('Add vdev', t('The Pool Composer is unavailable.'));
                    } catch (e) {
                        ANAS.warn('pex new-vdev hand-off failed: ' + ANAS.errText(e));
                    }
                });
            }
            var mk = makeDragSelect();
            if (!mk) {
                return;
            }
            // A refused target keeps a bay zone so the ineligible treatment reads,
            // but blockDrop refuses every drop onto it with the daemon's reason.
            var bays = [];
            for (var k in bayMeta) {
                if (bayMeta.hasOwnProperty(k)) {
                    bays.push({ id: k, single: true });
                }
            }
            assigned = {};
            prevIds = [];
            drag = mk({
                root: root,
                disks: avail,
                assigned: assigned,
                bays: bays,
                cardClass: 'anas-pex-disk',
                removeClass: 'anas-pex-unassign',
                removeAttr: 'data-pex-unassign',
                bayEmpty: function (bayId) {
                    var meta = bayMeta[bayId];
                    if (meta && !meta.allowed) {
                        return '<span style="color:var(--anas-muted);font-size:11.5px">'
                            + enc(t('ineligible — no drop')) + '</span>';
                    }
                    return '<div style="flex:1;min-width:120px;color:var(--anas-muted);font-size:12px;'
                        + 'text-align:center;padding:14px 8px">' + enc(t('Drop a disk here')) + '</div>';
                },
                blockDrop: function (diskId, bayId) {
                    var meta = bayMeta[bayId];
                    if (meta && !meta.allowed) {
                        return meta.reason
                            || t('This target is not eligible for expansion.');
                    }
                    return null;
                },
                onRefuse: function (reason) { showRefusal(reason); },
                onChange: onChange,
            });
            drag.render();
        }

        // ---- REPLACE mode render -------------------------------------------

        function replaceSlotHtml(leaf, bayId) {
            return '<div style="border:1px solid var(--anas-panel-edge);border-radius:11px;'
                + 'padding:10px 10px 6px;margin-bottom:10px;'
                + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot))">'
                + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">'
                + '<span style="font-weight:650;font-size:12px;color:var(--anas-ink);'
                + 'overflow-wrap:anywhere" title="' + enc(leaf.id) + '">' + enc(leaf.id) + '</span>'
                + '<span style="flex:1"></span>'
                + '<span style="font-size:10px;font-weight:800;text-transform:uppercase;'
                + 'letter-spacing:.5px;color:var(--anas-muted)">'
                + enc(leaf.vdevName + ' · ' + (leaf.state || '')) + '</span></div>'
                + '<div class="anas-gfx-bay anas-grid-pex-rep" data-anas-zone="bay:' + enc(bayId) + '"'
                + ' style="display:flex;flex-wrap:wrap;gap:8px;min-height:56px;border-radius:10px;'
                + 'padding:9px;background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)">'
                + '</div></div>';
        }

        function mountReplaceDrag() {
            var root = bodyEl();
            if (!root) {
                return;
            }
            var mk = makeDragSelect();
            if (!mk) {
                return;
            }
            var bays = [];
            for (var k in bayMeta) {
                if (bayMeta.hasOwnProperty(k)) {
                    bays.push({ id: k, single: true });
                }
            }
            assigned = {};
            prevIds = [];
            drag = mk({
                root: root,
                disks: avail,
                assigned: assigned,
                bays: bays,
                cardClass: 'anas-pex-disk',
                removeClass: 'anas-pex-unassign',
                removeAttr: 'data-pex-unassign',
                bayEmpty: function () {
                    return '<div style="flex:1;min-width:120px;color:var(--anas-muted);font-size:12px;'
                        + 'text-align:center;padding:10px 8px">' + enc(t('Drop the replacement here')) + '</div>';
                },
                onChange: onChange,
            });
            drag.render();
        }

        // ---- top-level render (mode header + area) -------------------------

        function shellHtml() {
            var busyNote = (report && report.busy && report.busy.busy)
                ? ('<span style="font-size:11.5px;color:var(--anas-warn)">'
                    + enc(t('Pool is busy — expansion is blocked; replace stays available.')) + '</span>')
                : '';
            return '<div style="padding:14px 16px;color:var(--anas-ink);'
                + 'font:13px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'
                + '<div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap">'
                + '<label style="cursor:pointer"><input type="radio" name="pex-mode" value="expand" checked> '
                + enc(t('Expand (add capacity / redundancy)')) + '</label>'
                + '<label style="cursor:pointer"><input type="radio" name="pex-mode" value="replace"> '
                + enc(t('Replace a disk')) + '</label>'
                + '<span style="flex:1"></span>' + busyNote + '</div>'
                + '<div id="pexArea"></div></div>';
        }

        // Paint the stable shell (mode radios + a #pexArea placeholder), wire the
        // radios, then render the current mode into #pexArea. A mode switch only
        // re-renders #pexArea, so the header persists.
        function paint() {
            var p = win.down('#pexBody');
            if (!p) {
                return;
            }
            p.setHtml(shellHtml());
            var root = bodyEl();
            if (root) {
                var radios = root.querySelectorAll('input[name="pex-mode"]');
                for (var i = 0; i < radios.length; i++) {
                    if (radios[i].value === mode) {
                        radios[i].checked = true;
                    }
                    radios[i].addEventListener('change', function (e) {
                        var v = e.target.value;
                        if (v !== mode) {
                            mode = v;
                            paint();
                        }
                    });
                }
            }
            // Render the mode area into #pexArea by swapping it for the mode HTML.
            renderInto();
        }

        // Render the current mode's UI into the #pexArea placeholder (the mode
        // header lives outside it and survives a mode switch).
        function renderInto() {
            if (mode === 'expand') {
                renderExpandArea();
            } else {
                renderReplaceArea();
            }
        }

        function areaEl() {
            var root = bodyEl();
            return root ? root.querySelector('#pexArea') : null;
        }

        function renderExpandArea() {
            var el = areaEl();
            if (!el) {
                return;
            }
            var targets = (report && report.targets) || [];
            bayMeta = {};
            var cap = report && report.capability;
            var i;
            var hasRaidz = false;
            for (i = 0; i < targets.length; i++) {
                if (targets[i].kind === 'raidz-expand') {
                    hasRaidz = true;
                }
            }
            var capLine = '';
            if (hasRaidz && cap && cap.zfsVersion) {
                capLine = '<div style="font-size:11px;color:var(--anas-muted);margin-bottom:8px">'
                    + enc('OpenZFS ' + cap.zfsVersion + ' · feature@raidz_expansion '
                        + (cap.featureState || 'unknown')) + '</div>';
            }
            var targetsHtml = '';
            if (report && report.busy && report.busy.busy) {
                targetsHtml = '<div style="margin-bottom:10px">'
                    + refusalBlockHtml(busyMessage(report.busy)) + '</div>';
            } else if (!targets.length) {
                targetsHtml = '<div style="color:var(--anas-muted);font-size:12px;padding:14px 0">'
                    + enc(t('This pool has no expandable data vdev.')) + '</div>';
            } else {
                for (i = 0; i < targets.length; i++) {
                    var bId = 'tgt' + i;
                    var leaf = vmap.byName[targets[i].vdevName];
                    bayMeta[bId] = {
                        kind: targets[i].kind,
                        vdevName: targets[i].vdevName,
                        existingDiskId: (leaf && leaf.firstLeaf) || targets[i].vdevName,
                        target: targets[i],
                        allowed: targets[i].allowed !== false,
                        reason: targets[i].reasonDetail || targets[i].reason || '',
                    };
                    targetsHtml += targetCardHtml(targets[i], bId);
                }
            }
            var newVdev = '<div style="border:1px dashed var(--anas-card-edge);border-radius:11px;'
                + 'padding:12px;background:var(--anas-slot);margin-top:4px">'
                + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
                + '<span style="font-size:12.5px;color:var(--anas-ink);flex:1;min-width:200px">'
                + enc(t('Grow with a whole NEW vdev (mirror/raidz) — capacity added as a redundant '
                    + 'unit, not by widening an existing vdev.')) + '</span>'
                + '<button type="button" class="anas-btn-pex-newvdev" id="pex-newvdev"'
                + ' style="font:inherit;color:var(--anas-ink);cursor:pointer;padding:6px 12px;'
                + 'border-radius:8px;border:1px solid var(--anas-card-edge);'
                + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
                + 'box-shadow:var(--anas-shadow)">' + enc(t('Compose new vdev…')) + '</button>'
                + '</div></div>';
            el.innerHTML = '<div style="display:grid;grid-template-columns:260px minmax(340px,1fr);'
                + 'gap:14px;align-items:start">'
                + '<div style="' + CARD + '">'
                + '<div style="' + SEC + '">' + enc(t('Available disks')) + '</div>'
                + '<p style="color:var(--anas-muted);font-size:11.5px;margin:0 0 8px">'
                + enc(t('Drag one disk onto a target. The disk becomes a pool member '
                    + '(its contents are overwritten). Drop it back here to unstage.')) + '</p>'
                + '<div id="pex-tray" data-anas-zone="tray" class="anas-grid-pex-tray"'
                + ' style="display:flex;flex-direction:column;min-height:60px;border-radius:11px;'
                + 'padding:2px"></div></div>'
                + '<div style="display:flex;flex-direction:column;gap:12px">'
                + '<div style="' + CARD + '">'
                + '<div style="' + SEC + '">' + enc(t('Expansion targets')) + '</div>'
                + capLine + targetsHtml + newVdev
                + '<div id="pex-refusal" style="margin-top:8px"></div></div>'
                + '<div id="pex-summary" style="' + CARD + '"></div>'
                + '</div></div>';
            mountExpandDrag();
            renderSummary();
            updateExec();
        }

        function renderReplaceArea() {
            var el = areaEl();
            if (!el) {
                return;
            }
            bayMeta = {};
            var leaves = vmap.leaves || [];
            var slots = '';
            var i;
            if (!leaves.length) {
                slots = '<div style="color:var(--anas-muted);font-size:12px;padding:14px 0">'
                    + enc(t('No pool members were found to replace.')) + '</div>';
            } else {
                for (i = 0; i < leaves.length; i++) {
                    var bId = 'rep' + i;
                    bayMeta[bId] = { existingDiskId: leaves[i].id, allowed: true };
                    slots += replaceSlotHtml(leaves[i], bId);
                }
            }
            el.innerHTML = '<div style="display:grid;grid-template-columns:260px minmax(340px,1fr);'
                + 'gap:14px;align-items:start">'
                + '<div style="' + CARD + '">'
                + '<div style="' + SEC + '">' + enc(t('Available disks')) + '</div>'
                + '<p style="color:var(--anas-muted);font-size:11.5px;margin:0 0 8px">'
                + enc(t('Drag a replacement onto the member to swap. The old disk stays in '
                    + 'the pool while its data resilvers onto the new one — redundancy is not '
                    + 'dropped. Drop it back here to unstage.')) + '</p>'
                + '<div id="pex-tray" data-anas-zone="tray" class="anas-grid-pex-tray"'
                + ' style="display:flex;flex-direction:column;min-height:60px;border-radius:11px;'
                + 'padding:2px"></div></div>'
                + '<div style="display:flex;flex-direction:column;gap:12px">'
                + '<div style="' + CARD + '">'
                + '<div style="' + SEC + '">' + enc(t('Pool members')) + '</div>'
                + slots
                + '<div id="pex-refusal" style="margin-top:8px"></div></div>'
                + '<div id="pex-summary" style="' + CARD + '"></div>'
                + '</div></div>';
            mountReplaceDrag();
            renderSummary();
            updateExec();
        }

        // ---- commit --------------------------------------------------------

        function commit() {
            var s = staged();
            if (!s) {
                return;
            }
            var meta = s.meta;
            var epath = '/pools/' + encodeURIComponent(poolName) + '/attach';
            var body;
            var failTitle;
            var successMsg;
            var advisories = [];
            var anyway = 'Expand anyway';

            if (mode === 'replace') {
                body = { existingDiskId: meta.existingDiskId, newDiskId: s.newDiskId, replace: true };
                failTitle = 'Replace failed';
                successMsg = t('Replacement started on') + ' ' + poolName;
            } else if (meta.kind === 'raidz-expand') {
                body = { targetVdev: meta.vdevName, newDiskId: s.newDiskId };
                advisories = (meta.target && meta.target.advisories) || [];
                failTitle = 'RAIDZ expansion failed';
                successMsg = t('RAIDZ expansion started on') + ' ' + poolName;
            } else {
                body = { existingDiskId: meta.existingDiskId, newDiskId: s.newDiskId };
                failTitle = 'Attach failed';
                successMsg = t('Attach started on') + ' ' + poolName;
                anyway = 'Attach anyway';
            }

            var run = function () {
                ANAS.runJob({
                    node: node,
                    method: 'post',
                    path: epath,
                    body: body,
                    view: grid,
                    // A commit-time re-gate (busy/version/flag) returns 409 with a
                    // `reason` + message — surfaced verbatim by errText here.
                    failTitle: failTitle,
                    successMsg: successMsg,
                    onComplete: function () {
                        if (win && !win.destroyed && !win.destroying) {
                            win.close();
                        }
                        if (ANAS.pools && ANAS.pools.reload) {
                            ANAS.pools.reload(grid, node);
                        }
                    },
                });
            };

            // Advisories flip the shared warn-gate amber and require an explicit
            // "<X> anyway" — the same client-side advisory confirm as create/AHR.
            // These commits use an available disk (no confirm-code / 409-wipe), so
            // clientConfirm is the right gate; no advisories → it runs straight.
            if (ANAS.gfx && ANAS.gfx.warnGate) {
                ANAS.gfx.warnGate.clientConfirm({
                    title: mode === 'replace' ? 'Replace disk'
                        : (meta.kind === 'raidz-expand' ? 'Expand raidz' : 'Attach disk'),
                    warnings: advisories,
                    anywayText: mode === 'replace' ? 'Replace' : anyway,
                    onProceed: run,
                });
            } else {
                run();
            }
        }

        // ---- window + data load --------------------------------------------

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-attach anas-win-pool-expand',
                title: t('Expand / Replace') + ': ' + poolName,
                modal: true,
                width: 900,
                height: 660,
                minWidth: 640,
                minHeight: 440,
                maximizable: true,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'pexBody',
                    border: false,
                    scrollable: true,
                    bodyPadding: 0,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        cls: 'anas-btn-pex-cancel',
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Execute'),
                        itemId: 'pexExec',
                        cls: 'anas-btn-attach-submit anas-btn-pex-exec',
                        disabled: true,
                        handler: commit,
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('pool expand window failed: ' + ANAS.errText(e));
            return;
        }
        win.anasGrid = grid;
        win.show();
        try {
            win.setLoading(true);
        } catch (eL) {
            // non-fatal
        }

        // Load the expansion report + topology + available disks, then paint.
        ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName) + '/expansion').then(function (rep) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            report = (rep && rep.data) || { targets: [], busy: { busy: false }, capability: {} };
            ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName)).then(function (det) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                detail = (det && det.data) || {};
                vmap = buildVdevMap(detail);
                ANAS.api.get(node, '/disks').then(function (res) {
                    if (!win || win.destroyed || win.destroying) {
                        return;
                    }
                    win.setLoading(false);
                    var all = (res && res.data) || [];
                    avail = [];
                    for (var i = 0; i < all.length; i++) {
                        if (all[i].status === 'available') {
                            avail.push(all[i]);
                        }
                    }
                    paint();
                }, diskFail);
            }, topoFail);
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            var note = (err && err.status === 404)
                ? t('Pool expansion is not available in this build of the ANAS daemon yet.')
                : (t('Failed to load pool expansion') + ': ' + ANAS.errText(err));
            var p = win.down('#pexBody');
            if (p) {
                p.setHtml('<div style="padding:16px;color:var(--anas-danger);font-size:12.5px">'
                    + enc(note) + '</div>');
            }
        });

        function topoFail(err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            ANAS.warn('pool expand topology load failed: ' + ANAS.errText(err));
            var p = win.down('#pexBody');
            if (p) {
                p.setHtml('<div style="padding:16px;color:var(--anas-danger);font-size:12.5px">'
                    + enc(t('Failed to load pool topology') + ': ' + ANAS.errText(err)) + '</div>');
            }
        }
        function diskFail(err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            ANAS.warn('pool expand disk load failed: ' + ANAS.errText(err));
            var p = win.down('#pexBody');
            if (p) {
                p.setHtml('<div style="padding:16px;color:var(--anas-danger);font-size:12.5px">'
                    + enc(t('Failed to load disks') + ': ' + ANAS.errText(err)) + '</div>');
            }
        }
    }

    // ---- action registration -----------------------------------------------
    //
    // Keeps itemId 'attachDisk' (30-pools' PVE_HANDS_OFF gate + generic action
    // loop resolve it) and the anas-btn-attach hook; the handler now opens the
    // drop-target expansion surface. This is the ONE pool expand/replace entry
    // point — the old opaque combobox window is retired.
    ANAS.pools.registerAction({
        itemId: 'attachDisk',
        text: 'Expand / Replace',
        cls: 'anas-btn-attach anas-btn-pool-expand',
        iconCls: 'fa fa-exchange',
        needsSelection: true,
        // Busy state is handled inside the window (busy blocks Expand, not
        // Replace) — do NOT disable the whole action while a scan runs.
        disableWhileScanning: false,
        handler: function (node, grid, poolName) {
            try {
                openExpand(node, grid, poolName);
            } catch (e) {
                ANAS.warn('pool expand window failed: ' + ANAS.errText(e));
            }
        },
    });
})();
