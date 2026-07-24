/*
 * ANAS — Hybrid RAID (AHR) view. Epic 11 + AHR (docs/AHR-DESIGN.md §6.2).
 *
 * A native ExtJS grid of AHR pools (mdadm banded arrays → LVM → btrfs) with a
 * layered-stack detail panel below (the mounts grid+detail idiom): per-disk
 * bays showing band slices coloured per array, per-array rows with sync
 * progress, the VG/LV line and the btrfs line. Capacity is ALWAYS the labelled
 * AhrCapacity breakdown — never a bare number — and pendingBytes > 0 renders
 * the §5.2 "unlock" explanation with concrete sizes.
 *
 * Data (docs/AHR-DESIGN.md §4, shared shapes in packages/shared/src/schemas/ahr.ts):
 *   GET    /ahr                        → { data: AhrPool[] }
 *   GET    /ahr/:name                  → { data: AhrPool }
 *   POST   /ahr/:name/expand/plan      → { data: plan }   (dry-run, no mutation)
 *   POST   /ahr/:name/expand           → 409 confirm → 202 { job }
 *   POST   /ahr/:name/disk/:id/replace → 409 confirm → 202 { job }
 *   POST   /ahr/:name/scrub            → 202 { job }
 *   DELETE /ahr/:name                  → 409 confirm → 202 { job }
 *
 * Expand / Replace / Scrub are coded to the documented API shape; a daemon
 * that does not serve them yet answers 404 and the handlers degrade to a
 * clear "not available in this build" message (fail-open, never a raw error).
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

    // ---- vocabulary ---------------------------------------------------------

    // Tier labels lead with the MEANING; the acronym is API vocabulary.
    var TIER_LABELS = {
        ahr1: '1-disk fault tolerance (AHR-1)',
        ahr2: '2-disk fault tolerance (AHR-2)',
    };
    function tierLabel(ahrType) {
        return t(TIER_LABELS[ahrType] || ('' + (ahrType || '')));
    }

    // Map an AhrPoolState to the gfx pill severity token + a human label.
    // 'resyncing' arrays after create are "building — pool usable now", so the
    // pool-level expanding/scrubbing states stay NEUTRAL (activity, not fault).
    var POOL_STATES = {
        healthy: { token: 'ONLINE', label: 'healthy' },
        degraded: { token: 'DEGRADED', label: 'degraded' },
        expanding: { token: '', label: 'expanding' },
        rebuilding: { token: 'DEGRADED', label: 'rebuilding' },
        scrubbing: { token: '', label: 'scrubbing' },
        failed: { token: 'FAULTED', label: 'failed' },
        readonly: { token: 'FAULTED', label: 'read-only' },
    };

    function renderPoolState(value) {
        var meta = POOL_STATES[value] || { token: '', label: '' + (value || '') };
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.statePill === 'function' && value) {
                var html = gfx.statePill(meta.token, { label: t(meta.label) });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return enc(t(meta.label));
    }

    // Array-level state pill (clean/degraded/resyncing/...). Initial resync is
    // presented as "building" per the design note, distinct from degraded.
    var ARRAY_STATES = {
        clean: { token: 'ONLINE', label: 'clean' },
        degraded: { token: 'DEGRADED', label: 'degraded' },
        resyncing: { token: '', label: 'building' },
        reshaping: { token: '', label: 'reshaping' },
        recovering: { token: 'DEGRADED', label: 'rebuilding' },
        failed: { token: 'FAULTED', label: 'failed' },
    };

    function arrayStatePill(state) {
        var meta = ARRAY_STATES[state] || { token: '', label: '' + (state || '') };
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.statePill === 'function') {
                var html = gfx.statePill(meta.token, { label: t(meta.label) });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return enc(t(meta.label));
    }

    // Band → themed series colour (cycled, stable per band index).
    function bandColor(band) {
        var n = ((Number(band) || 1) - 1) % 5 + 1;
        return 'var(--anas-series-' + n + ')';
    }

    var HATCH = 'repeating-linear-gradient(45deg,var(--anas-free),var(--anas-free) 6px,'
        + 'var(--anas-slot) 6px,var(--anas-slot) 12px)';

    function fmtEta(seconds) {
        var s = Number(seconds);
        if (isNaN(s) || s < 0) {
            return '';
        }
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        if (h > 0) {
            return h + 'h ' + m + 'm';
        }
        if (m > 0) {
            return m + 'm';
        }
        return Math.round(s) + 's';
    }

    function fmtSpeed(bps) {
        var v = Number(bps);
        if (isNaN(v) || v < 0) {
            return '';
        }
        return fmtBytes(v) + '/s';
    }

    var SYNC_LABELS = {
        resync: 'building',
        reshape: 'reshaping',
        recover: 'rebuilding',
        check: 'checking',
    };
    function syncLabel(action) {
        return t(SYNC_LABELS[action] || ('' + (action || '')));
    }

    // ---- capacity (the labelled breakdown — never a bare number) -----------

    function capOf(rec) {
        try {
            var v = (rec && typeof rec.get === 'function') ? rec.get('capacity') : (rec && rec.capacity);
            return v || null;
        } catch (e) {
            return null;
        }
    }

    // One-line labelled breakdown for tooltips.
    function capTooltip(cap) {
        if (!cap) {
            return '';
        }
        var parts = [
            t('Usable') + ' ' + fmtBytes(cap.usableBytes),
            t('Raw') + ' ' + fmtBytes(cap.rawBytes),
            t('Redundancy overhead') + ' ' + fmtBytes(cap.redundancyOverheadBytes),
            t('Unprotected (wasted)') + ' ' + fmtBytes(cap.unprotectedWastedBytes),
        ];
        if (Number(cap.pendingBytes) > 0) {
            parts.push(t('Pending (locked)') + ' ' + fmtBytes(cap.pendingBytes));
        }
        parts.push(t('Used') + ' ' + fmtBytes(cap.usedBytes));
        parts.push(t('Free') + ' ' + fmtBytes(cap.freeBytes));
        return parts.join('  ·  ');
    }

    // Grid Usable column: usable prominent, the full labelled breakdown in the
    // tooltip, and an explicit "+pending" tag when capacity is locked (§5.2).
    function renderUsable(value, meta, record) {
        var cap = capOf(record);
        if (!cap) {
            return '';
        }
        var html = '<span style="font-weight:650">' + enc(fmtBytes(cap.usableBytes)) + '</span>';
        if (Number(cap.pendingBytes) > 0) {
            html += ' <span style="color:var(--anas-warn);font-size:11px">+'
                + enc(fmtBytes(cap.pendingBytes) + ' ' + t('pending')) + '</span>';
        }
        try {
            if (meta) {
                meta.tdAttr = 'title="' + enc(capTooltip(cap)) + '"';
            }
        } catch (e) {
            // tooltip optional
        }
        return html;
    }

    // ---- arrays / sync helpers ---------------------------------------------

    function arraysOf(rec) {
        try {
            var v = (rec && typeof rec.get === 'function') ? rec.get('arrays') : (rec && rec.arrays);
            return v && v.length ? v : [];
        } catch (e) {
            return [];
        }
    }

    function syncingArrays(arrays) {
        var out = [];
        for (var i = 0; i < (arrays || []).length; i++) {
            if (arrays[i] && arrays[i].sync) {
                out.push(arrays[i]);
            }
        }
        return out;
    }

    // Grid Activity column: an activity strip while any band array syncs
    // (percent from the busiest array), else a muted Idle.
    function renderActivity(value, meta, record) {
        var syncing = syncingArrays(arraysOf(record));
        if (!syncing.length) {
            return '<span style="color:var(--anas-muted)">' + enc(t('Idle')) + '</span>';
        }
        var a = syncing[0];
        var label = syncLabel(a.sync.action) + ' ' + t('band') + ' ' + a.band;
        if (syncing.length > 1) {
            label += ' (+' + (syncing.length - 1) + ')';
        }
        var pc = Number(a.sync.percent);
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.activity === 'function') {
                var html = gfx.activity(isNaN(pc) ? null : pc / 100, { label: label });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return enc(label + (isNaN(pc) ? '' : ' ' + Math.round(pc) + '%'));
    }

    // Disk ids with a faulty/missing member in any array (drives the bay
    // highlight — a faulted disk lights up everywhere it participates).
    function faultedDiskIds(d) {
        var bad = {};
        var arrays = (d && d.arrays) || [];
        for (var i = 0; i < arrays.length; i++) {
            var members = arrays[i].members || [];
            for (var j = 0; j < members.length; j++) {
                var st = members[j].memberState;
                if (st === 'faulty' || st === 'missing') {
                    bad[members[j].disk] = true;
                }
            }
        }
        return bad;
    }

    // ---- detail panel builders ---------------------------------------------

    var SEC = 'margin:14px 0 8px;font-size:11px;font-weight:800;text-transform:uppercase;'
        + 'letter-spacing:.5px;color:var(--anas-muted)';

    function headerHtml(d) {
        var pill = renderPoolState(d.state);
        var tier = '<span style="font-size:12px;color:var(--anas-muted)">'
            + enc(tierLabel(d.ahrType)) + '</span>';
        return '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">'
            + '<span style="font-weight:750;font-size:15px;color:var(--anas-ink)">' + enc(d.name) + '</span>'
            + pill + tier + '</div>';
    }

    function capRow(label, value, emphasis) {
        return '<div style="display:flex;justify-content:space-between;gap:14px;padding:3px 0">'
            + '<span style="color:var(--anas-muted)">' + enc(label) + '</span>'
            + '<span style="font-variant-numeric:tabular-nums;'
            + (emphasis ? 'font-weight:750' : 'font-weight:600') + '">' + enc(value) + '</span></div>';
    }

    function capacityHtml(d) {
        var cap = d.capacity || {};
        var usable = Number(cap.usableBytes) || 0;
        var used = Number(cap.usedBytes) || 0;
        var frac = usable > 0 ? used / usable : 0;
        var gauge = '';
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.gauge === 'function') {
                gauge = gfx.gauge(frac, {
                    label: fmtBytes(used) + ' ' + t('used of') + ' ' + fmtBytes(usable) + ' ' + t('usable'),
                    title: t('Filesystem usage'),
                }) || '';
            }
        } catch (e) {
            gauge = '';
        }
        var rows = capRow(t('Usable'), fmtBytes(cap.usableBytes), true)
            + capRow(t('Free'), fmtBytes(cap.freeBytes))
            + capRow(t('Raw (all member disks)'), fmtBytes(cap.rawBytes))
            + capRow(t('Redundancy overhead'), fmtBytes(cap.redundancyOverheadBytes))
            + capRow(t('Unprotected (wasted)'), fmtBytes(cap.unprotectedWastedBytes));
        if (Number(cap.pendingBytes) > 0) {
            rows += capRow(t('Pending (locked)'), fmtBytes(cap.pendingBytes));
        }
        return '<div style="max-width:420px">'
            + (gauge ? '<div style="margin-bottom:8px">' + gauge + '</div>' : '')
            + rows + '</div>';
    }

    // §5.2 pending-capacity unlock explanation — the single most confusing
    // thing hybrid RAID does, so it is named concretely: how much is locked,
    // and what to add to unlock it. Best-effort concreteness from the pool's
    // own disk sizes (the largest disk defines the boundary to cross).
    function pendingHtml(d) {
        var cap = d.capacity || {};
        var pending = Number(cap.pendingBytes) || 0;
        if (!(pending > 0)) {
            return '';
        }
        var largest = 0;
        var disks = d.disks || [];
        for (var i = 0; i < disks.length; i++) {
            var u = Number(disks[i].usableBytes) || 0;
            if (u > largest) {
                largest = u;
            }
        }
        var msg = '<b>' + enc(fmtBytes(pending) + ' ' + t('is installed but not usable yet.')) + '</b> '
            + enc(t('Too few disks reach the top capacity band to form a protected array.'))
            + (largest > 0
                ? (' ' + enc(t('Add or upgrade one more disk to') + ' ')
                    + '<b>≥ ' + enc(fmtBytes(largest)) + '</b> '
                    + enc(t('to unlock up to') + ' ~' + fmtBytes(pending)
                        + ' ' + t('of protected capacity.')))
                : '');
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.callout === 'function') {
                var html = gfx.callout(msg, { level: 'warn' });
                if (html) {
                    return '<div style="margin:10px 0">' + html + '</div>';
                }
            }
        } catch (e) {
            // fall through
        }
        return '<div style="margin:10px 0;color:var(--anas-warn)">' + msg + '</div>';
    }

    // Pool advisories from the daemon, rendered verbatim as warning callouts.
    function advisoriesHtml(d) {
        var adv = d.advisories || [];
        if (!adv.length) {
            return '';
        }
        var html = '';
        for (var i = 0; i < adv.length; i++) {
            try {
                var gfx = ANAS.gfx;
                var c = (gfx && typeof gfx.callout === 'function')
                    ? gfx.callout(enc(adv[i]), { level: 'warn' })
                    : '';
                html += c || ('<div style="color:var(--anas-warn);font-size:12px;margin:4px 0">'
                    + enc(adv[i]) + '</div>');
            } catch (e) {
                html += '<div style="color:var(--anas-warn);font-size:12px;margin:4px 0">'
                    + enc(adv[i]) + '</div>';
            }
        }
        return '<div style="margin:10px 0;display:flex;flex-direction:column;gap:6px">' + html + '</div>';
    }

    // One disk's band-slice bar: each partition a segment coloured by its band,
    // width proportional to size; the unpartitioned remainder (the raw region
    // above the top array boundary, §2.6) hatched/grey with a label.
    function diskSliceBar(disk, maxBytes) {
        var total = Number(disk.usableBytes) || Number(disk.sizeBytes) || 0;
        if (!(total > 0) || !(maxBytes > 0)) {
            return '';
        }
        var parts = (disk.partitions || []).slice();
        parts.sort(function (a, b) {
            return (a.band || 0) - (b.band || 0);
        });
        var segs = '';
        var allocated = 0;
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            var sz = Number(p.sizeBytes) || 0;
            allocated += sz;
            var w = (sz / maxBytes) * 100;
            segs += '<span title="' + enc(t('band') + ' ' + p.band + ' — ' + fmtBytes(sz)
                + ' (' + p.device + ')') + '"'
                + ' style="display:inline-flex;align-items:center;justify-content:center;'
                + 'width:' + w.toFixed(2) + '%;height:100%;background:' + bandColor(p.band) + ';'
                + 'color:#fff;font-size:9.5px;font-weight:700;overflow:hidden;white-space:nowrap;'
                + 'border-right:1px solid var(--anas-panel)">'
                + (w > 6 ? 'b' + enc('' + p.band) : '') + '</span>';
        }
        var rest = total - allocated;
        if (rest > 0 && (rest / maxBytes) > 0.005) {
            var rw = (rest / maxBytes) * 100;
            segs += '<span title="' + enc(t('unallocated') + ' — ' + fmtBytes(rest)) + '"'
                + ' style="display:inline-flex;align-items:center;justify-content:center;'
                + 'width:' + rw.toFixed(2) + '%;height:100%;background:' + HATCH + ';'
                + 'color:var(--anas-muted);font-size:9.5px;overflow:hidden;white-space:nowrap">'
                + (rw > 12 ? enc(t('unused')) : '') + '</span>';
        }
        var barW = (total / maxBytes) * 100;
        return '<span style="display:inline-flex;width:' + barW.toFixed(2) + '%;height:20px;'
            + 'border-radius:5px;overflow:hidden;border:1px solid var(--anas-card-edge);'
            + 'background:var(--anas-slot)">' + segs + '</span>';
    }

    // Per-disk bays: one gfx.bay per disk (full by-id in the label — never
    // truncated), the slice bar inside, model/size beneath. A faulted disk's
    // bay is outlined in danger red.
    function disksHtml(d) {
        var gfx = ANAS.gfx;
        if (!gfx || typeof gfx.bay !== 'function' || typeof gfx.bayGroup !== 'function') {
            return '';
        }
        var disks = d.disks || [];
        if (!disks.length) {
            return '';
        }
        var bad = faultedDiskIds(d);
        var maxBytes = 0;
        var i;
        for (i = 0; i < disks.length; i++) {
            var u = Number(disks[i].usableBytes) || Number(disks[i].sizeBytes) || 0;
            if (u > maxBytes) {
                maxBytes = u;
            }
        }
        var bays = '';
        for (i = 0; i < disks.length; i++) {
            var disk = disks[i];
            var faulted = !!bad[disk.id];
            var sub = (disk.model ? disk.model + ' · ' : '')
                + fmtBytes(disk.usableBytes || disk.sizeBytes)
                + (disk.role === 'spare' ? ' · ' + t('spare') : '');
            var inner = '<div style="width:100%;min-width:340px">'
                + '<div style="display:block;margin-bottom:5px">' + diskSliceBar(disk, maxBytes) + '</div>'
                + '<div style="font-size:11px;color:var(--anas-muted)">' + enc(sub)
                + (faulted ? ' · <b style="color:var(--anas-danger)">' + enc(t('FAULTED')) + '</b>' : '')
                + '</div></div>';
            var bay = gfx.bay(disk.id, inner) || '';
            if (!bay) {
                continue;
            }
            if (faulted) {
                bay = '<div title="' + enc(disk.id + ' — ' + t('faulted member')) + '"'
                    + ' style="outline:2px solid var(--anas-danger);border-radius:11px">' + bay + '</div>';
            }
            bays += '<div style="flex:1 1 380px;max-width:640px">' + bay + '</div>';
        }
        return gfx.bayGroup(t('Disks — band slices'), bays) || '';
    }

    // Per-array rows: band swatch, md device, level × members, state pill, and
    // the sync progress strip (percent / speed / ETA) while a sync runs.
    function arraysHtml(d) {
        var arrays = (d.arrays || []).slice();
        if (!arrays.length) {
            return '';
        }
        arrays.sort(function (a, b) {
            return (a.band || 0) - (b.band || 0);
        });
        var rows = '';
        for (var i = 0; i < arrays.length; i++) {
            var a = arrays[i];
            var members = a.members || [];
            var inSync = 0;
            for (var j = 0; j < members.length; j++) {
                if (members[j].memberState === 'in_sync') {
                    inSync++;
                }
            }
            var sw = '<span style="width:11px;height:11px;border-radius:3px;flex:0 0 auto;'
                + 'background:' + bandColor(a.band) + '"></span>';
            var head = sw
                + '<span style="font-weight:650;font-variant-numeric:tabular-nums">'
                + enc(a.device || (t('band') + ' ' + a.band)) + '</span>'
                + '<span style="color:var(--anas-muted);font-size:12px">'
                + enc((a.level || '') + ' × ' + members.length
                    + (inSync < members.length ? ' (' + inSync + ' ' + t('in sync') + ')' : '')
                    + ' · ' + t('height') + ' ' + fmtBytes(a.heightBytes)) + '</span>'
                + '<span style="flex:1"></span>' + arrayStatePill(a.state);
            var syncHtml = '';
            if (a.sync) {
                var pc = Number(a.sync.percent);
                var strip = '';
                try {
                    var gfx = ANAS.gfx;
                    if (gfx && typeof gfx.activity === 'function') {
                        strip = gfx.activity(isNaN(pc) ? null : pc / 100,
                            { label: syncLabel(a.sync.action) }) || '';
                    }
                } catch (e) {
                    strip = '';
                }
                var stats = [];
                if (!isNaN(pc)) {
                    stats.push(pc.toFixed(1) + '%');
                }
                var sp = fmtSpeed(a.sync.speedBytesSec);
                if (sp) {
                    stats.push(sp);
                }
                var eta = fmtEta(a.sync.etaSeconds);
                if (eta) {
                    stats.push(t('ETA') + ' ' + eta);
                }
                syncHtml = '<div style="margin-top:6px">' + strip
                    + '<div style="font-size:11px;color:var(--anas-muted);margin-top:3px;'
                    + 'font-variant-numeric:tabular-nums">' + enc(stats.join('  ·  ')) + '</div></div>';
            }
            rows += '<div style="padding:8px 10px;border:1px solid var(--anas-line);border-radius:9px;'
                + 'margin-bottom:6px;background:var(--anas-panel)">'
                + '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">' + head + '</div>'
                + syncHtml + '</div>';
        }
        return '<div style="' + SEC + '">' + enc(t('Band arrays (mdadm)')) + '</div>' + rows;
    }

    function lvmHtml(d) {
        var vg = d.vg || {};
        var lv = d.lv || {};
        return '<div style="' + SEC + '">' + enc(t('Volume (LVM)')) + '</div>'
            + '<div style="font-size:12.5px;color:var(--anas-ink)">'
            + enc(t('VG') + ' ' + (vg.name || '—') + ' — ' + fmtBytes(vg.sizeBytes)
                + ', ' + fmtBytes(vg.freeBytes) + ' ' + t('free')
                + '  ·  ' + t('LV') + ' ' + (lv.name || '—') + ' — ' + fmtBytes(lv.sizeBytes))
            + '</div>';
    }

    function fsHtml(d) {
        var cap = d.capacity || {};
        return '<div style="' + SEC + '">' + enc(t('Filesystem (btrfs)')) + '</div>'
            + '<div style="font-size:12.5px;color:var(--anas-ink)">'
            + enc('btrfs — ' + t('mounted at') + ' ' + (d.mountpoint || '—')
                + '  ·  ' + fmtBytes(cap.usedBytes) + ' ' + t('used') + ', '
                + fmtBytes(cap.freeBytes) + ' ' + t('free'))
            + '</div>';
    }

    function detailHtml(d) {
        return '<div class="anas-ahr-detail-body" style="padding:12px 14px;color:var(--anas-ink);'
            + 'font:12.5px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'
            + headerHtml(d)
            + advisoriesHtml(d)
            + pendingHtml(d)
            + '<div style="' + SEC + '">' + enc(t('Capacity')) + '</div>'
            + capacityHtml(d)
            + '<div style="' + SEC + '">' + enc(t('Layered stack')) + '</div>'
            + disksHtml(d)
            + arraysHtml(d)
            + lvmHtml(d)
            + fsHtml(d)
            + '</div>';
    }

    function detailHint() {
        return '<div style="padding:14px;color:var(--anas-muted);font-size:12.5px">'
            + enc(t('Select a pool to see its layered stack: disks → band arrays → volume → filesystem.'))
            + '</div>';
    }

    // ---- data load ----------------------------------------------------------

    function gridOf(view) {
        return view ? view.down('#ahrGrid') : null;
    }
    function detailOf(view) {
        return view ? view.down('#ahrDetail') : null;
    }
    function selectedPool(grid) {
        var sel = grid ? grid.getSelection() : null;
        return (sel && sel.length) ? sel[0].get('name') : null;
    }

    function setDetailHtml(view, html) {
        var panel = detailOf(view);
        if (!panel || panel.destroyed || panel.destroying) {
            return;
        }
        try {
            panel.setHtml(html);
        } catch (e) {
            // non-fatal
        }
    }

    function loadDetail(view, node, name) {
        if (!name) {
            setDetailHtml(view, detailHint());
            return;
        }
        ANAS.api.get(node, '/ahr/' + encodeURIComponent(name)).then(function (res) {
            if (!view || view.destroyed || view.destroying) {
                return;
            }
            var d = res && res.data;
            if (!d) {
                setDetailHtml(view, detailHint());
                return;
            }
            try {
                setDetailHtml(view, detailHtml(d));
            } catch (e) {
                ANAS.warn('ahr detail render failed: ' + ANAS.errText(e));
                setDetailHtml(view, detailHint());
            }
        }, function (err) {
            if (!view || view.destroyed || view.destroying) {
                return;
            }
            ANAS.warn('ahr detail load failed: ' + ANAS.errText(err));
            setDetailHtml(view, '<div style="padding:14px;color:var(--anas-danger);font-size:12.5px">'
                + enc(t('Failed to load pool detail') + ': ' + ANAS.errText(err)) + '</div>');
        });
    }

    function loadPools(grid, node) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        var keep = selectedPool(grid);
        ANAS.api.get(node, '/ahr').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            var rows = (res && res.data) || [];
            grid.getStore().loadData(rows);
            // Restore the previous selection so the detail panel survives reloads.
            if (keep) {
                var rec = grid.getStore().findRecord('name', keep, 0, false, true, true);
                if (rec) {
                    try {
                        grid.getSelectionModel().select(rec, false, true);
                    } catch (eSel) {
                        // non-fatal
                    }
                }
            }
            updateButtons(grid);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            ANAS.warn('ahr load failed: ' + ANAS.errText(err));
            try {
                Ext.Msg.alert(t('Error'),
                    t('Failed to load Hybrid RAID pools') + ': ' + ANAS.errText(err));
            } catch (e) {
                // non-fatal
            }
        });
    }

    function updateButtons(grid) {
        var sel = grid.getSelection();
        var has = sel && sel.length > 0;
        var ids = ['expand', 'replace', 'scrub', 'destroy'];
        for (var i = 0; i < ids.length; i++) {
            var btn = grid.down('#' + ids[i]);
            if (btn) {
                btn.setDisabled(!has);
            }
        }
    }

    // Expose for the composer (mirror of ANAS.pools.reload).
    ANAS.ahr = ANAS.ahr || {};
    ANAS.ahr.reload = loadPools;
    ANAS.ahr.selectedPool = selectedPool;

    // ---- actions ------------------------------------------------------------

    // A parallel build may not serve the AHR mutation routes yet — a 404 gets a
    // clear "not in this build" message instead of a raw HTTP error.
    function apiMissing(err, what) {
        if (err && err.status === 404) {
            try {
                Ext.Msg.alert(t('Not available'),
                    enc(what) + ' ' + t('is not available in this build of the ANAS daemon yet.'));
            } catch (e) {
                ANAS.warn(what + ' unavailable (404)');
            }
            return true;
        }
        return false;
    }

    function startScrub(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        // btrfs scrub then md check, sequenced by the daemon (§4) — plain 202.
        ANAS.api.post(node, '/ahr/' + encodeURIComponent(pool) + '/scrub', {}).then(function (res) {
            var job = res && res.job;
            ANAS.toast(t('Scrub started on') + ' ' + pool);
            if (job && job.id) {
                ANAS.pollJob(node, job.id, {
                    node: node,
                    view: grid,
                    failTitle: 'Scrub failed',
                    onComplete: function () {
                        loadPools(grid, node);
                    },
                });
            } else {
                loadPools(grid, node);
            }
        }, function (err) {
            if (apiMissing(err, t('Scrub'))) {
                return;
            }
            try {
                Ext.Msg.alert(t('Scrub failed'), ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr scrub failed: ' + ANAS.errText(err));
            }
        });
    }

    function destroyPool(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'del',
            path: '/ahr/' + encodeURIComponent(pool),
            view: grid,
            confirmTitle: 'Destroy Hybrid RAID pool',
            confirmIntro: t('Destroying pool') + ' <b>' + enc(pool) + '</b> '
                + t('erases the arrays, the volume, and ALL data on it:'),
            failTitle: 'Destroy failed',
            successMsg: t('Pool destroyed') + ': ' + pool,
            onComplete: function () {
                loadPools(grid, node);
                var view = grid.up('#ahrView');
                if (view) {
                    setDetailHtml(view, detailHint());
                }
            },
        });
    }

    // ---- expand / replace windows ------------------------------------------

    // Render an expansion plan (POST /ahr/:name/expand/plan response — before →
    // after capacity, the ordered step list, warnings verbatim). Coded to the
    // documented shape; every field is optional-guarded.
    function planHtml(plan) {
        var html = '';
        var before = plan && plan.before;
        var after = plan && plan.after;
        if (before && after) {
            var gain = (Number(after.usableBytes) || 0) - (Number(before.usableBytes) || 0);
            html += '<div style="' + SEC + ';margin-top:4px">' + enc(t('Capacity')) + '</div>'
                + capRow(t('Usable now'), fmtBytes(before.usableBytes))
                + capRow(t('Usable after'), fmtBytes(after.usableBytes), true)
                + capRow(t('Change'), (gain >= 0 ? '+' : '−') + fmtBytes(Math.abs(gain)));
            if (Number(after.pendingBytes) > 0) {
                html += '<div style="margin-top:6px;color:var(--anas-warn);font-size:12px"><b>'
                    + enc(fmtBytes(after.pendingBytes) + ' ' + t('stays pending (locked)'))
                    + '</b> — ' + enc(t('add one more disk above the top boundary to unlock it.'))
                    + '</div>';
            }
        }
        var steps = (plan && plan.steps) || [];
        if (steps.length) {
            html += '<div style="' + SEC + '">' + enc(t('Steps')) + '</div><ol style="margin:0;padding-left:20px">';
            for (var i = 0; i < steps.length; i++) {
                var s = steps[i];
                html += '<li style="margin:2px 0;font-size:12px">' + enc((s.kind || '') + ' — ' + (s.target || '')
                    + (s.detail ? ' (' + s.detail + ')' : '')) + '</li>';
            }
            html += '</ol>';
        }
        var warns = (plan && plan.warnings) || [];
        for (var w = 0; w < warns.length; w++) {
            html += '<div style="color:var(--anas-warn);font-size:12px;margin:5px 0">⚠ '
                + enc(warns[w]) + '</div>';
        }
        // §6.3 fixed truths, always shown with a plan.
        html += '<div style="color:var(--anas-muted);font-size:11.5px;margin-top:10px">'
            + enc(t('The pool stays online during the reshape, but performance degrades and a '
                + 'reshape can take hours on large arrays and cannot be cancelled cleanly '
                + 'mid-flight. Power loss is survivable (md resumes) — do not pull disks.'))
            + '</div>';
        return html || ('<div style="color:var(--anas-muted)">' + enc(t('No plan returned.')) + '</div>');
    }

    // Checkbox list of available disks (full by-id, model, size — nothing
    // truncated). Returns the HTML; ids are read back via input[name].
    function diskChecklistHtml(disks, inputName, type) {
        if (!disks.length) {
            return '<div style="color:var(--anas-muted);font-size:12px">'
                + enc(t('No available disks found.')) + '</div>';
        }
        var html = '';
        for (var i = 0; i < disks.length; i++) {
            var d = disks[i];
            html += '<label style="display:flex;align-items:center;gap:8px;padding:4px 2px;'
                + 'font-size:12px;cursor:pointer">'
                + '<input type="' + (type || 'checkbox') + '" name="' + enc(inputName)
                + '" value="' + enc(d.id) + '">'
                + '<span style="overflow-wrap:anywhere">' + enc(d.id) + '</span>'
                + '<span style="color:var(--anas-muted);white-space:nowrap">'
                + enc((d.model ? d.model + ' · ' : '') + fmtBytes(d.size)) + '</span></label>';
        }
        return html;
    }

    function checkedValues(root, inputName) {
        var out = [];
        try {
            var els = root.querySelectorAll('input[name="' + inputName + '"]:checked');
            for (var i = 0; i < els.length; i++) {
                out.push(els[i].value);
            }
        } catch (e) {
            // fall through
        }
        return out;
    }

    // Expansion wizard (§6.3, minimal): pick add-disks OR a replace pair, plan
    // (dry-run, before → after + steps + warnings), then execute via the
    // confirm gate. Degrades cleanly when the daemon lacks the routes (404).
    function openExpand(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var win = null;
        var planBody = null;

        function bodyEl() {
            var p = win ? win.down('#ahrExpandBody') : null;
            return (p && p.getEl()) ? p.getEl().dom : null;
        }

        function renderForm(avail, members) {
            var html = '<div style="padding:12px;font-size:12.5px;color:var(--anas-ink)">'
                + '<div style="margin-bottom:8px">'
                + '<label style="margin-right:16px"><input type="radio" name="ahrx-mode" value="add" checked> '
                + enc(t('Add disks')) + '</label>'
                + '<label><input type="radio" name="ahrx-mode" value="replace"> '
                + enc(t('Replace a disk (larger)')) + '</label></div>'
                + '<div id="ahrx-add">'
                + '<div style="' + SEC + ';margin-top:2px">' + enc(t('Disks to add')) + '</div>'
                + diskChecklistHtml(avail, 'ahrx-adddisk', 'checkbox') + '</div>'
                + '<div id="ahrx-replace" style="display:none">'
                + '<div style="' + SEC + ';margin-top:2px">' + enc(t('Member to replace')) + '</div>'
                + diskChecklistHtml(members, 'ahrx-old', 'radio')
                + '<div style="' + SEC + '">' + enc(t('Replacement disk')) + '</div>'
                + diskChecklistHtml(avail, 'ahrx-new', 'radio') + '</div>'
                + '<div id="ahrx-plan" style="margin-top:10px"></div>'
                + '</div>';
            var p = win ? win.down('#ahrExpandBody') : null;
            if (p) {
                p.setHtml(html);
            }
            var root = bodyEl();
            if (!root) {
                return;
            }
            var radios = root.querySelectorAll('input[name="ahrx-mode"]');
            for (var i = 0; i < radios.length; i++) {
                radios[i].addEventListener('change', function () {
                    var mode = (checkedValues(root, 'ahrx-mode')[0]) || 'add';
                    root.querySelector('#ahrx-add').style.display = mode === 'add' ? '' : 'none';
                    root.querySelector('#ahrx-replace').style.display = mode === 'replace' ? '' : 'none';
                });
            }
        }

        function buildBody() {
            var root = bodyEl();
            if (!root) {
                return null;
            }
            var mode = (checkedValues(root, 'ahrx-mode')[0]) || 'add';
            if (mode === 'add') {
                var add = checkedValues(root, 'ahrx-adddisk');
                if (!add.length) {
                    Ext.Msg.alert(t('Expand'), t('Select at least one disk to add.'));
                    return null;
                }
                return { addDisks: add };
            }
            var oldId = checkedValues(root, 'ahrx-old')[0];
            var newId = checkedValues(root, 'ahrx-new')[0];
            if (!oldId || !newId) {
                Ext.Msg.alert(t('Expand'), t('Select the member to replace and its replacement.'));
                return null;
            }
            return { replace: { oldDiskId: oldId, newDiskId: newId } };
        }

        function computePlan() {
            var body = buildBody();
            if (!body) {
                return;
            }
            planBody = null;
            ANAS.api.post(node, '/ahr/' + encodeURIComponent(pool) + '/expand/plan', body)
                .then(function (res) {
                    if (!win || win.destroyed || win.destroying) {
                        return;
                    }
                    planBody = body;
                    var root = bodyEl();
                    var target = root ? root.querySelector('#ahrx-plan') : null;
                    if (target) {
                        target.innerHTML = planHtml(res && res.data);
                    }
                    var exec = win.down('#ahrExpandExec');
                    if (exec) {
                        exec.setDisabled(false);
                    }
                }, function (err) {
                    if (apiMissing(err, t('Expansion planning'))) {
                        return;
                    }
                    try {
                        Ext.Msg.alert(t('Plan failed'), ANAS.errText(err));
                    } catch (e) {
                        ANAS.warn('ahr plan failed: ' + ANAS.errText(err));
                    }
                });
        }

        function execute() {
            if (!planBody) {
                return;
            }
            ANAS.confirmAndRun({
                node: node,
                method: 'post',
                path: '/ahr/' + encodeURIComponent(pool) + '/expand',
                body: planBody,
                view: win,
                confirmTitle: 'Expand pool',
                confirmIntro: t('Expanding') + ' <b>' + enc(pool) + '</b> '
                    + t('starts a multi-hour, non-cancellable reshape:'),
                failTitle: 'Expand failed',
                successMsg: t('Expansion started on') + ' ' + pool,
                onComplete: function () {
                    if (win && !win.destroyed && !win.destroying) {
                        win.close();
                    }
                    loadPools(grid, node);
                },
            });
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-expand',
                title: t('Expand Hybrid RAID pool') + ': ' + pool,
                modal: true,
                width: 660,
                height: 560,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrExpandBody',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Compute plan'),
                        itemId: 'ahrExpandPlan',
                        cls: 'anas-btn-ahr-plan',
                        handler: computePlan,
                    },
                    {
                        text: t('Execute expansion'),
                        itemId: 'ahrExpandExec',
                        cls: 'anas-btn-ahr-expand-exec',
                        disabled: true,
                        handler: execute,
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('ahr expand window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        try {
            win.setLoading(true);
        } catch (eL) {
            // non-fatal
        }
        // Load available disks + the pool's members, then render the form.
        ANAS.api.get(node, '/disks').then(function (res) {
            var all = (res && res.data) || [];
            var avail = [];
            for (var i = 0; i < all.length; i++) {
                if (all[i].status === 'available') {
                    avail.push(all[i]);
                }
            }
            ANAS.api.get(node, '/ahr/' + encodeURIComponent(pool)).then(function (res2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                var d = (res2 && res2.data) || {};
                var members = [];
                var pd = d.disks || [];
                for (var j = 0; j < pd.length; j++) {
                    members.push({
                        id: pd[j].id,
                        model: pd[j].model,
                        size: pd[j].sizeBytes,
                    });
                }
                renderForm(avail, members);
            }, function (err2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                renderForm(avail, []);
                ANAS.warn('ahr expand member load failed: ' + ANAS.errText(err2));
            });
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            try {
                Ext.Msg.alert(t('Error'), t('Failed to load disks') + ': ' + ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr expand disk load failed: ' + ANAS.errText(err));
            }
        });
    }

    // Guided single-disk replace: pick the member and the replacement, then
    // POST /ahr/:name/disk/:id/replace through the confirm gate. Uses
    // `mdadm --replace` semantics daemon-side — redundancy is never dropped.
    function openReplace(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var win = null;

        function bodyEl() {
            var p = win ? win.down('#ahrReplaceBody') : null;
            return (p && p.getEl()) ? p.getEl().dom : null;
        }

        function submit() {
            var root = bodyEl();
            if (!root) {
                return;
            }
            var oldId = checkedValues(root, 'ahrr-old')[0];
            var newId = checkedValues(root, 'ahrr-new')[0];
            if (!oldId || !newId) {
                Ext.Msg.alert(t('Replace disk'), t('Select the member to replace and its replacement.'));
                return;
            }
            ANAS.confirmAndRun({
                node: node,
                method: 'post',
                path: '/ahr/' + encodeURIComponent(pool) + '/disk/'
                    + encodeURIComponent(oldId) + '/replace',
                body: { newDiskId: newId },
                view: win,
                confirmTitle: 'Replace disk',
                confirmIntro: t('Replacing') + ' <b>' + enc(oldId) + '</b> '
                    + t('with') + ' <b>' + enc(newId) + '</b> '
                    + t('copies every band it carries onto the new disk:'),
                failTitle: 'Replace failed',
                successMsg: t('Replacement started on') + ' ' + pool,
                onComplete: function () {
                    if (win && !win.destroyed && !win.destroying) {
                        win.close();
                    }
                    loadPools(grid, node);
                },
            });
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-ahr-replace',
                title: t('Replace disk') + ': ' + pool,
                modal: true,
                width: 620,
                height: 500,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'ahrReplaceBody',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Replace'),
                        cls: 'anas-btn-ahr-replace-exec',
                        handler: submit,
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('ahr replace window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        try {
            win.setLoading(true);
        } catch (eL) {
            // non-fatal
        }
        ANAS.api.get(node, '/ahr/' + encodeURIComponent(pool)).then(function (res) {
            var d = (res && res.data) || {};
            var members = [];
            var pd = d.disks || [];
            for (var i = 0; i < pd.length; i++) {
                members.push({ id: pd[i].id, model: pd[i].model, size: pd[i].sizeBytes });
            }
            ANAS.api.get(node, '/disks').then(function (res2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                var all = (res2 && res2.data) || [];
                var avail = [];
                for (var j = 0; j < all.length; j++) {
                    if (all[j].status === 'available') {
                        avail.push(all[j]);
                    }
                }
                var p = win.down('#ahrReplaceBody');
                if (p) {
                    p.setHtml('<div style="padding:12px;font-size:12.5px;color:var(--anas-ink)">'
                        + '<div style="' + SEC + ';margin-top:2px">' + enc(t('Member to replace')) + '</div>'
                        + diskChecklistHtml(members, 'ahrr-old', 'radio')
                        + '<div style="' + SEC + '">' + enc(t('Replacement disk')) + '</div>'
                        + diskChecklistHtml(avail, 'ahrr-new', 'radio')
                        + '<div style="color:var(--anas-muted);font-size:11.5px;margin-top:10px">'
                        + enc(t('The old disk stays in the array while its bands copy over '
                            + '(mdadm --replace) — redundancy is never voluntarily dropped. '
                            + 'A same-nominal-size replacement always fits (sizes are floored '
                            + 'to a safety reserve).'))
                        + '</div></div>');
                }
            }, function (err2) {
                if (!win || win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                try {
                    Ext.Msg.alert(t('Error'), t('Failed to load disks') + ': ' + ANAS.errText(err2));
                } catch (e) {
                    ANAS.warn('ahr replace disk load failed: ' + ANAS.errText(err2));
                }
            });
        }, function (err) {
            if (!win || win.destroyed || win.destroying) {
                return;
            }
            win.setLoading(false);
            if (apiMissing(err, t('Hybrid RAID detail'))) {
                return;
            }
            try {
                Ext.Msg.alert(t('Error'), t('Failed to load pool') + ': ' + ANAS.errText(err));
            } catch (e) {
                ANAS.warn('ahr replace pool load failed: ' + ANAS.errText(err));
            }
        });
    }

    // ---- view ---------------------------------------------------------------

    function ahrView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'ahrType', 'state', 'mountpoint',
                // Nested structures kept verbatim (auto fields): renderers and
                // the detail panel read them directly.
                'capacity', 'arrays', 'disks', 'advisories', 'vg', 'lv',
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        return {
            xtype: 'panel',
            itemId: 'ahrView',
            cls: 'anas-view anas-view-ahr',
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'ahrGrid',
                    cls: 'anas-grid-ahr',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No Hybrid RAID pools — Create composes one from mixed-size disks.'),
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'name',
                            flex: 1,
                            minWidth: 140,
                        },
                        {
                            text: t('Fault tolerance'),
                            dataIndex: 'ahrType',
                            width: 220,
                            renderer: function (value) {
                                return enc(tierLabel(value));
                            },
                        },
                        {
                            text: t('State'),
                            dataIndex: 'state',
                            width: 140,
                            renderer: renderPoolState,
                        },
                        {
                            text: t('Usable'),
                            dataIndex: 'capacity',
                            width: 190,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderUsable,
                        },
                        {
                            text: t('Activity'),
                            dataIndex: 'arrays',
                            width: 240,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderActivity,
                        },
                    ],
                    tbar: [
                        {
                            text: t('Reload'),
                            itemId: 'refresh',
                            cls: 'anas-btn-ahr-refresh',
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                loadPools(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Create'),
                            itemId: 'create',
                            cls: 'anas-btn-ahr-create',
                            iconCls: 'fa fa-plus-circle',
                            handler: function (btn) {
                                var grid = btn.up('grid');
                                try {
                                    if (ANAS.ahrComposer && typeof ANAS.ahrComposer.open === 'function') {
                                        ANAS.ahrComposer.open({ node: node, grid: grid });
                                        return;
                                    }
                                    Ext.Msg.alert(t('Create'), t('The Hybrid RAID composer is unavailable.'));
                                } catch (e) {
                                    ANAS.warn('ahr composer open failed: ' + ANAS.errText(e));
                                }
                            },
                        },
                        {
                            text: t('Expand'),
                            itemId: 'expand',
                            cls: 'anas-btn-ahr-expand',
                            iconCls: 'fa fa-arrows-alt',
                            disabled: true,
                            handler: function (btn) {
                                openExpand(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Replace disk'),
                            itemId: 'replace',
                            cls: 'anas-btn-ahr-replace',
                            iconCls: 'fa fa-exchange',
                            disabled: true,
                            handler: function (btn) {
                                openReplace(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Scrub'),
                            itemId: 'scrub',
                            cls: 'anas-btn-ahr-scrub',
                            iconCls: 'fa fa-check-circle',
                            disabled: true,
                            handler: function (btn) {
                                startScrub(btn.up('grid'), node);
                            },
                        },
                        {
                            text: t('Destroy'),
                            itemId: 'destroy',
                            cls: 'anas-btn-ahr-destroy',
                            iconCls: 'fa fa-trash-o',
                            disabled: true,
                            handler: function (btn) {
                                destroyPool(btn.up('grid'), node);
                            },
                        },
                    ],
                    listeners: {
                        selectionchange: function (selModel, selected) {
                            var grid = this;
                            updateButtons(grid);
                            var view = grid.up('#ahrView');
                            var rec = (selected && selected.length) ? selected[0] : null;
                            loadDetail(view, node, rec ? rec.get('name') : null);
                        },
                    },
                },
                {
                    xtype: 'panel',
                    itemId: 'ahrDetail',
                    cls: 'anas-ahr-detail',
                    height: 380,
                    border: false,
                    scrollable: true,
                    bodyStyle: 'border-top:1px solid var(--anas-line,#dfe3e8);',
                    html: detailHint(),
                },
            ],
            listeners: {
                afterrender: function (view) {
                    loadPools(gridOf(view), node);
                },
                activate: function (view) {
                    loadPools(gridOf(view), node);
                },
            },
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['ahr'] = {
        itemId: 'anas-ahr',
        text: t('Hybrid RAID'),
        iconCls: 'fa fa-server',
        factory: function (node) {
            try {
                return ahrView(node);
            } catch (e) {
                ANAS.warn('ahr view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
