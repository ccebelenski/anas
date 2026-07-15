/*
 * ANAS — Dashboard view (Epic 2: stories 2.1–2.7; gfx retrofit 15.5).
 *
 * The real, gold-standard ANAS landing page: warnings, per-pool health, disk
 * fleet, shares + jobs, and — the headline — live ZFS telemetry (ARC, per-pool
 * and per-disk I/O, network) rendered entirely in the ANAS.gfx visual language
 * (15-gfx.js) with client-side rolling sparklines. Replaces the story-13.12
 * placeholder landing panel.
 *
 * Data contract (two endpoints, read as JSON; no compile dependency):
 *   GET /v1/status    → { node, pools[], disks{}, shares{}, jobs[], warnings[] }
 *                       loaded on show + manual Refresh.
 *   GET /v1/telemetry → { sampledAt, windowMs, arc{}, pools[], disks[], net{} }
 *                       POLLED every POLL_MS while the panel is visible.
 *
 * POLL LIFECYCLE (critical — a leaked setInterval hammering the daemon is
 * unacceptable): the interval starts on afterrender / activate / show and STOPS
 * on deactivate / hide / destroy. It also self-guards each tick on
 * view.isVisible() and document.hidden, and a visibilitychange listener
 * stops/restarts it when the browser tab is hidden. destroy tears everything
 * down (interval + the document listener).
 *
 * FRAMEWORK CONTRACT: window.ANAS with ANAS.api.get (Promise; path relative to
 * /v1), ANAS.gfx (gauge/bar/donut/legend/icon/statePill/callout/badge/activity),
 * ANAS.formatBytes, ANAS.t, ANAS.enc. The framework wraps this view in the
 * "not installed" probe — we do NOT probe health here. Fail open throughout: a
 * failed status/telemetry fetch degrades a section to a muted "unavailable"
 * state and NEVER throws into the PVE UI.
 *
 * Test hooks: view cls 'anas-view anas-view-dashboard'; section classes
 * 'anas-dash-warnings' / 'anas-dash-pools' / 'anas-dash-overview' (fleet+shares+
 * jobs) / 'anas-dash-arc' / 'anas-dash-io' / 'anas-dash-disks' / 'anas-dash-net'
 * / 'anas-dash-status'; Refresh button 'anas-btn-dash-refresh'.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    // Poll cadence for /telemetry while the panel is visible, and the depth of
    // the client-side rolling sparkline buffers (samples kept per metric key).
    var POLL_MS = 2500;
    var SPARK_MAX = 60;

    // Owning card's itemId (see ANAS.makeCard → itemId: view.itemId). We attach
    // the card-layout activate/deactivate listeners here so polling follows the
    // PVE menu even though those events fire on the card, not this nested panel.
    var CARD_ITEM_ID = 'anas-dashboard';

    // Themeable series colours (fall back to literals if gfx tokens are absent).
    var READ_COLOR = 'var(--anas-series-1,#3468c0)';
    var WRITE_COLOR = 'var(--anas-series-4,#b06a12)';
    var RX_COLOR = 'var(--anas-series-3,#147d68)';
    var TX_COLOR = 'var(--anas-series-2,#7a3fb0)';
    var ARC_COLOR = 'var(--anas-series-3,#147d68)';
    var OK_COLOR = 'var(--anas-ok,#1f9c56)';
    var WARN_COLOR = 'var(--anas-warn,#b06a12)';
    var BAD_COLOR = 'var(--anas-danger,#c23b2c)';
    var MUTED_COLOR = 'var(--anas-muted,#6b7280)';

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    var gfx = ANAS.gfx;

    // ---- Small formatters --------------------------------------------------

    function num(v) {
        var n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    function clamp01(f) {
        f = Number(f);
        if (isNaN(f) || f < 0) { return 0; }
        return f > 1 ? 1 : f;
    }

    // Bytes/second, reusing the shared byte formatter.
    function bps(v) {
        return ANAS.formatBytes(num(v)) + '/s';
    }

    // Compact IOPS (k above 1000).
    function iops(v) {
        var n = num(v);
        if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
        return '' + Math.round(n);
    }

    // Latency in nanoseconds → ns / µs / ms. null/undefined → em dash.
    function fmtLat(ns) {
        if (ns === null || ns === undefined || isNaN(Number(ns))) {
            return '—';
        }
        var n = Number(ns);
        if (n < 1000) { return Math.round(n) + ' ns'; }
        if (n < 1000000) { return (n / 1000).toFixed(1) + ' µs'; }
        return (n / 1000000).toFixed(2) + ' ms';
    }

    // Prefer whichever device latency is present (max of the two when both).
    function pickLat(io) {
        var r = io.readLatencyNs;
        var w = io.writeLatencyNs;
        var hasR = r !== null && r !== undefined && !isNaN(Number(r));
        var hasW = w !== null && w !== undefined && !isNaN(Number(w));
        if (hasR && hasW) { return Math.max(Number(r), Number(w)); }
        if (hasR) { return r; }
        if (hasW) { return w; }
        return null;
    }

    // Trim a long device id to a tail form; full id stays in the title tooltip.
    function shortId(id) {
        id = '' + (id || '');
        return id.length > 16 ? '…' + id.substring(id.length - 15) : id;
    }

    function heading(txt) {
        return '<div class="anas-dash-h">' + enc(txt) + '</div>';
    }

    function muted(txt) {
        return '<div class="anas-dash-muted">' + enc(txt) + '</div>';
    }

    // ---- Scoped stylesheet (injected once, fail-open) ----------------------
    //
    // Uses the gfx --anas-* theme tokens (with literal fallbacks) so the
    // dashboard follows the PVE light/dark theme automatically. All selectors
    // are .anas-dash-* scoped so nothing here can clobber PVE's CSS.

    function ensureDashStyles() {
        try {
            if (typeof document === 'undefined' || !document.getElementById) {
                return;
            }
            if (document.getElementById('anas-dash-styles')) {
                return;
            }
            var css = ''
                + '.anas-dash-h{font-size:11px;font-weight:800;text-transform:uppercase;'
                + 'letter-spacing:.6px;color:var(--anas-muted,#6b7280);margin:0 0 8px}'
                + '.anas-dash-muted{color:var(--anas-muted,#6b7280);font-size:12px}'
                + '.anas-dash-status{font-size:11px;color:var(--anas-muted,#6b7280)}'
                + '.anas-dash-status .dot,.anas-dash-shares .dot{display:inline-block;width:8px;'
                + 'height:8px;border-radius:50%;margin:0 6px;vertical-align:middle}'
                + '.anas-dash-section{margin-bottom:20px}'
                + '.anas-dash-cards{display:flex;flex-wrap:wrap;gap:14px}'
                + '.anas-dash-card{flex:0 1 auto;min-width:170px;padding:14px;border-radius:12px;'
                + 'background:linear-gradient(var(--anas-card-top,#fff),var(--anas-card-bot,#eef1f5));'
                + 'border:1px solid var(--anas-card-edge,#cfd6df);'
                + 'box-shadow:var(--anas-shadow,0 1px 3px rgba(20,30,50,.12));box-sizing:border-box}'
                + '.anas-dash-card-title{font-weight:700;font-size:13px;color:var(--anas-ink,#232936);'
                + 'margin-bottom:8px;display:flex;align-items:center;gap:8px;justify-content:space-between}'
                + '.anas-dash-row{display:flex;flex-wrap:wrap;gap:22px}'
                + '.anas-dash-col{flex:1 1 220px;min-width:190px}'
                + '.anas-dash-metric{display:flex;align-items:center;gap:10px;margin:6px 0}'
                + '.anas-dash-metric-lbl{width:66px;font-size:11px;color:var(--anas-muted,#6b7280);flex:0 0 auto}'
                + '.anas-dash-metric-bar{flex:1 1 auto;min-width:70px;display:flex}'
                + '.anas-dash-metric-val{width:92px;text-align:right;font-size:11.5px;'
                + 'font-variant-numeric:tabular-nums;color:var(--anas-ink,#232936);flex:0 0 auto}'
                + '.anas-dash-spark{flex:0 0 auto;display:block}'
                + '.anas-dash-stats{display:flex;flex-wrap:wrap;gap:12px}'
                + '.anas-dash-stat{min-width:70px;padding:10px 12px;border-radius:10px;'
                + 'background:var(--anas-slot,#f2f4f7);border:1px solid var(--anas-card-edge,#cfd6df);text-align:center}'
                + '.anas-dash-stat-n{font-size:20px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1}'
                + '.anas-dash-stat-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;'
                + 'color:var(--anas-muted,#6b7280);margin-top:5px}'
                + '.anas-dash-diskgrid{display:flex;flex-wrap:wrap;gap:10px}'
                + '.anas-dash-disk{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;'
                + 'background:linear-gradient(var(--anas-card-top,#fff),var(--anas-card-bot,#eef1f5));'
                + 'border:1px solid var(--anas-card-edge,#cfd6df);min-width:150px;box-sizing:border-box}'
                + '.anas-dash-disk-id{font-size:11px;font-weight:650;color:var(--anas-ink,#232936);'
                + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:118px}'
                + '.anas-dash-disk-sub{font-size:10px;color:var(--anas-muted,#6b7280)}'
                + '.anas-dash-jobrow{display:flex;justify-content:space-between;gap:12px;font-size:12px;'
                + 'padding:4px 0;border-bottom:1px solid var(--anas-line,#dfe3e8)}'
                + '.anas-dash-cb{display:flex;gap:8px;align-items:flex-start;font-size:12px;padding:9px 11px;'
                + 'border-radius:10px;margin-bottom:8px}'
                + '.anas-dash-cb-warn{background:rgba(176,106,18,.13);color:var(--anas-warn,#b06a12)}'
                + '.anas-dash-cb-bad{background:rgba(194,59,44,.14);color:var(--anas-danger,#c23b2c)}';
            var style = document.createElement('style');
            style.id = 'anas-dash-styles';
            style.type = 'text/css';
            if (style.styleSheet) {
                style.styleSheet.cssText = css;
            } else {
                style.appendChild(document.createTextNode(css));
            }
            var head = document.getElementsByTagName('head')[0] || document.documentElement;
            head.appendChild(style);
        } catch (e) {
            // non-fatal — sections still render, just without bespoke layout CSS
            ANAS.warn('dashboard style injection failed: ' + ANAS.errText(e));
        }
    }

    // ---- Sparklines (client-side rolling buffer) ---------------------------

    // Push a sample onto the rolling buffer for `key`, capped at SPARK_MAX, and
    // return the (mutated) buffer. Buffers live on the view so they reset with
    // the panel and never touch the server (no persisted history — Principle 7).
    function pushSpark(view, key, value) {
        var buf = view._anasSpark || (view._anasSpark = {});
        var arr = buf[key] || (buf[key] = []);
        arr.push(num(value));
        while (arr.length > SPARK_MAX) {
            arr.shift();
        }
        return arr;
    }

    // Inline SVG sparkline (area + polyline), auto-scaled to the buffer peak.
    // Fail-open: any trouble (or <2 points) returns '' and the caller omits it.
    function sparkline(values, opts) {
        try {
            opts = opts || {};
            if (!values || values.length < 2) {
                return '';
            }
            var w = opts.width || 96;
            var hgt = opts.height || 22;
            var pad = 2;
            var i;
            var max = 0;
            for (i = 0; i < values.length; i++) {
                var v = num(values[i]);
                if (v > max) { max = v; }
            }
            if (opts.max && opts.max > max) { max = opts.max; }
            if (max <= 0) { max = 1; }
            var n = values.length;
            var stepX = (w - pad * 2) / (n - 1);
            var pts = [];
            for (i = 0; i < n; i++) {
                var x = pad + i * stepX;
                var y = hgt - pad - (num(values[i]) / max) * (hgt - pad * 2);
                pts.push(x.toFixed(1) + ',' + y.toFixed(1));
            }
            var line = pts.join(' ');
            var baseline = (hgt - pad).toFixed(1);
            var lastX = (pad + (n - 1) * stepX).toFixed(1);
            var area = 'M' + pad.toFixed(1) + ',' + baseline
                + ' L' + pts.join(' L')
                + ' L' + lastX + ',' + baseline + ' Z';
            var color = opts.color || 'var(--anas-accent,#3468c0)';
            return '<svg class="anas-dash-spark" width="' + w + '" height="' + hgt + '" '
                + 'viewBox="0 0 ' + w + ' ' + hgt + '" preserveAspectRatio="none" aria-hidden="true">'
                + '<path d="' + area + '" fill="' + color + '" opacity="0.12"/>'
                + '<polyline points="' + line + '" fill="none" stroke="' + color + '" '
                + 'stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>'
                + '</svg>';
        } catch (e) {
            return '';
        }
    }

    // A throughput row: label + fullness-relative gfx bar (scaled to the metric's
    // recent peak) + absolute value + rolling sparkline. Bytes/s throughput has
    // no natural 0..1 fullness, so we scale the bar against the buffer peak to
    // give a live sense of "how busy relative to recent". Fail-open bar fallback.
    function metricRow(view, key, label, value, color) {
        var arr = pushSpark(view, key, value);
        var peak = 0;
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] > peak) { peak = arr[i]; }
        }
        var frac = peak > 0 ? num(value) / peak : 0;
        var barHtml = '';
        try {
            if (gfx && typeof gfx.bar === 'function') {
                barHtml = gfx.bar(frac, { pct: false, color: color, title: bps(value) }) || '';
            }
        } catch (e) {
            barHtml = '';
        }
        if (!barHtml) {
            barHtml = fallbackBar(frac, color);
        }
        return '<div class="anas-dash-metric">'
            + '<span class="anas-dash-metric-lbl">' + enc(label) + '</span>'
            + '<span class="anas-dash-metric-bar">' + barHtml + '</span>'
            + '<span class="anas-dash-metric-val">' + enc(bps(value)) + '</span>'
            + sparkline(arr, { color: color, width: 88, height: 20 })
            + '</div>';
    }

    function fallbackBar(frac, color) {
        var pct = Math.round(clamp01(frac) * 100);
        return '<span style="display:inline-block;width:100%;height:8px;border-radius:6px;'
            + 'background:var(--anas-slot,#eee);overflow:hidden">'
            + '<span style="display:block;height:100%;width:' + pct + '%;background:'
            + (color || 'var(--anas-accent,#3468c0)') + '"></span></span>';
    }

    // ---- STATUS sections (loaded on show + manual Refresh) -----------------

    // 2.5 — warnings banners at the very top, critical before warning. Empty
    // string when there are none (the section then renders nothing).
    function renderWarnings(status) {
        var ws = (status && status.warnings) || [];
        if (!ws.length) {
            return '';
        }
        var crit = [];
        var warn = [];
        for (var i = 0; i < ws.length; i++) {
            if (ws[i] && ws[i].level === 'critical') {
                crit.push(ws[i]);
            } else {
                warn.push(ws[i]);
            }
        }
        var ordered = crit.concat(warn);
        var out = '';
        for (var j = 0; j < ordered.length; j++) {
            var w = ordered[j] || {};
            var lvl = w.level === 'critical' ? 'bad' : 'warn';
            var body = '';
            if (w.category) {
                body += '<b>' + enc('' + w.category) + '</b> — ';
            }
            body += enc(w.message || '');
            var callout = '';
            try {
                if (gfx && typeof gfx.callout === 'function') {
                    callout = gfx.callout(body, { level: lvl }) || '';
                }
            } catch (e) {
                callout = '';
            }
            if (!callout) {
                callout = '<div class="anas-dash-cb anas-dash-cb-' + lvl + '">'
                    + '<span aria-hidden="true">' + (lvl === 'bad' ? '⛔' : '⚠') + '</span>'
                    + '<span>' + body + '</span></div>';
            }
            out += '<div style="margin-bottom:8px">' + callout + '</div>';
        }
        return out;
    }

    // 2.1 / 2.2 — per-pool health card: name, a capacity donut (used vs free,
    // capacity% in the centre), a state pill, a free/used caption, and an
    // indeterminate activity strip while a scrub/resilver runs.
    function renderPools(status) {
        var pools = (status && status.pools) || [];
        if (!pools.length) {
            return heading(t('Pool Health')) + muted(t('No pools.'));
        }
        var cards = '';
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i] || {};
            var cap = num(p.capacity);
            var alloc = num(p.allocated);
            var size = num(p.size);
            var free = p.free !== undefined ? num(p.free) : Math.max(size - alloc, 0);

            var donut = '';
            try {
                if (gfx && typeof gfx.donut === 'function') {
                    donut = gfx.donut(
                        [
                            { label: t('Used'), value: alloc },
                            { label: t('Free'), value: free, free: true }
                        ],
                        { size: 108, center: { big: Math.round(cap) + '%', sm: ANAS.formatBytes(size) } }
                    ) || '';
                }
            } catch (eD) {
                donut = '';
            }
            if (!donut) {
                // gfx unavailable — a plain fullness bar still conveys capacity.
                donut = fallbackBar(cap / 100, cap >= 90 ? BAD_COLOR : (cap >= 75 ? WARN_COLOR : OK_COLOR))
                    + '<div class="anas-dash-muted" style="margin-top:4px">' + enc(Math.round(cap) + '%') + '</div>';
            }

            var pill = '';
            try {
                if (gfx && typeof gfx.statePill === 'function') {
                    pill = gfx.statePill(p.state, { label: p.state }) || '';
                }
            } catch (eP) {
                pill = '';
            }
            if (!pill) {
                pill = ANAS.renderState(p.state);
            }

            var scan = '';
            if (p.scanRunning) {
                try {
                    if (gfx && typeof gfx.activity === 'function') {
                        scan = '<div style="margin-top:10px">'
                            + (gfx.activity(null, { label: t('Scrub / Resilver') }) || '')
                            + '</div>';
                    }
                } catch (eA) {
                    scan = '';
                }
            }

            cards += '<div class="anas-dash-card" style="text-align:center;min-width:180px">'
                + '<div class="anas-dash-card-title" style="justify-content:center">' + enc(p.name) + '</div>'
                + donut
                + '<div style="margin-top:8px">' + pill + '</div>'
                + '<div class="anas-dash-muted" style="margin-top:6px">'
                + enc(ANAS.formatBytes(alloc) + ' ' + t('used') + ' · '
                    + ANAS.formatBytes(free) + ' ' + t('free')) + '</div>'
                + scan
                + '</div>';
        }
        return heading(t('Pool Health')) + '<div class="anas-dash-cards">' + cards + '</div>';
    }

    // A coloured count tile for the fleet summary.
    function statTile(n, label, color) {
        return '<div class="anas-dash-stat">'
            + '<div class="anas-dash-stat-n" style="color:' + color + '">' + enc('' + n) + '</div>'
            + '<div class="anas-dash-stat-l">' + enc(label) + '</div></div>';
    }

    // 2.2 — disk fleet health: healthy / warning / critical / unknown counts.
    function fleetHtml(status) {
        var d = (status && status.disks) || {};
        var tiles = '<div class="anas-dash-stats">'
            + statTile(num(d.healthy), t('Healthy'), OK_COLOR)
            + statTile(num(d.warning), t('Warning'), WARN_COLOR)
            + statTile(num(d.critical), t('Critical'), BAD_COLOR)
            + statTile(num(d.unknown), t('Unknown'), MUTED_COLOR)
            + '</div>'
            + '<div class="anas-dash-muted" style="margin-top:8px">'
            + enc(num(d.total) + ' ' + t('disks total')) + '</div>';
        return heading(t('Disk Fleet')) + tiles;
    }

    // Service-active dot: green active, red stopped, muted unknown (undefined).
    function svcDot(active) {
        var color = active === true ? OK_COLOR : (active === false ? BAD_COLOR : MUTED_COLOR);
        return '<span class="dot" style="background:' + color + '"></span>';
    }

    function svcLabel(active) {
        return active === true ? t('active') : (active === false ? t('stopped') : t('unknown'));
    }

    // 2.3 — SMB / NFS share counts + service-active state.
    function sharesHtml(status) {
        var s = (status && status.shares) || {};
        var smbBadge = '';
        var nfsBadge = '';
        try {
            if (gfx && typeof gfx.badge === 'function') {
                smbBadge = gfx.badge('SMB', { kind: 'smb' }) || '';
                nfsBadge = gfx.badge('NFS', { kind: 'nfs' }) || '';
            }
        } catch (e) {
            smbBadge = '';
            nfsBadge = '';
        }
        var rows = '<div class="anas-dash-metric">' + smbBadge
            + '<span class="anas-dash-metric-lbl" style="width:auto">'
            + enc(num(s.smbCount) + ' ' + t('shares')) + '</span>'
            + svcDot(s.smbActive) + '<span class="anas-dash-muted">' + enc(svcLabel(s.smbActive)) + '</span></div>'
            + '<div class="anas-dash-metric">' + nfsBadge
            + '<span class="anas-dash-metric-lbl" style="width:auto">'
            + enc(num(s.nfsCount) + ' ' + t('exports')) + '</span>'
            + svcDot(s.nfsActive) + '<span class="anas-dash-muted">' + enc(svcLabel(s.nfsActive)) + '</span></div>';
        return heading(t('Shares')) + rows;
    }

    // 2.4 — a short active-jobs list (kind + status), capped with a "+N more".
    function jobsHtml(status) {
        var jobs = (status && status.jobs) || [];
        if (!jobs.length) {
            return heading(t('Active Jobs')) + muted(t('No active jobs.'));
        }
        var maxRows = Math.min(jobs.length, 6);
        var rows = '';
        for (var i = 0; i < maxRows; i++) {
            var j = jobs[i] || {};
            rows += '<div class="anas-dash-jobrow"><span>' + enc(j.kind || j.id || t('job')) + '</span>'
                + '<span class="anas-dash-muted">' + enc(j.status || '') + '</span></div>';
        }
        if (jobs.length > maxRows) {
            rows += '<div class="anas-dash-muted" style="margin-top:4px">'
                + enc('+' + (jobs.length - maxRows) + ' ' + t('more')) + '</div>';
        }
        return heading(t('Active Jobs')) + rows;
    }

    // Fleet + shares + jobs in one three-column row.
    function renderOverview(status) {
        return '<div class="anas-dash-row">'
            + '<div class="anas-dash-col anas-dash-fleet">' + fleetHtml(status) + '</div>'
            + '<div class="anas-dash-col anas-dash-shares">' + sharesHtml(status) + '</div>'
            + '<div class="anas-dash-col anas-dash-jobs">' + jobsHtml(status) + '</div>'
            + '</div>';
    }

    // ---- TELEMETRY sections (polled) ---------------------------------------

    // 2.7 — ARC hit ratio gauge + size/target + max, L2ARC line when present,
    // and a hit-ratio sparkline.
    function renderArc(view, tel) {
        var arc = tel && tel.arc;
        if (!arc) {
            return heading(t('ARC')) + muted(t('No ARC data.'));
        }
        var hr = clamp01(arc.hitRatio);
        var arr = pushSpark(view, 'arc.hit', hr);
        var gaugeHtml = '';
        try {
            if (gfx && typeof gfx.gauge === 'function') {
                gaugeHtml = gfx.gauge(hr, {
                    label: ANAS.formatBytes(arc.size) + ' / ' + ANAS.formatBytes(arc.target),
                    title: t('ARC hit ratio')
                }) || '';
            }
        } catch (e) {
            gaugeHtml = '';
        }
        if (!gaugeHtml) {
            gaugeHtml = fallbackBar(hr, ARC_COLOR)
                + '<div class="anas-dash-muted" style="margin-top:4px">'
                + enc(Math.round(hr * 100) + '% · ' + ANAS.formatBytes(arc.size)
                    + ' / ' + ANAS.formatBytes(arc.target)) + '</div>';
        }
        var maxLine = '<div class="anas-dash-muted" style="margin-top:4px">'
            + enc(t('Max') + ' ' + ANAS.formatBytes(arc.max)) + '</div>';
        var l2 = '';
        if (arc.l2) {
            l2 = '<div class="anas-dash-muted" style="margin-top:6px">'
                + enc('L2ARC: ' + Math.round(clamp01(arc.l2.hitRatio) * 100) + '% '
                    + t('hit') + ' · ' + ANAS.formatBytes(arc.l2.size)) + '</div>';
        }
        var spark = sparkline(arr, { color: ARC_COLOR, width: 140, height: 26 });
        return heading(t('ARC — Adaptive Replacement Cache'))
            + '<div class="anas-dash-row">'
            + '<div class="anas-dash-col">' + gaugeHtml + maxLine + l2 + '</div>'
            + '<div class="anas-dash-col" style="max-width:170px;flex:0 0 auto">'
            + (spark || '<span class="anas-dash-muted">' + enc(t('collecting…')) + '</span>')
            + '</div></div>';
    }

    function poolGlyph() {
        try {
            if (gfx && typeof gfx.objectIcon === 'function') {
                return gfx.objectIcon('pool') || '';
            }
        } catch (e) {
            // ignore
        }
        return '';
    }

    // 2.7 — per-pool read/write throughput bars + sparklines + IOPS + latency.
    function renderPoolIo(view, tel) {
        var pools = (tel && tel.pools) || [];
        if (!pools.length) {
            return heading(t('Pool I/O')) + muted(t('No pool I/O.'));
        }
        var body = '';
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i] || {};
            var name = p.name || ('pool' + i);
            body += '<div class="anas-dash-card" style="min-width:290px;flex:1 1 300px">'
                + '<div class="anas-dash-card-title"><span>' + poolGlyph() + ' ' + enc(name) + '</span>'
                + '<span class="anas-dash-muted">'
                + enc(iops(p.readIops) + ' r · ' + iops(p.writeIops) + ' w IOPS') + '</span></div>'
                + metricRow(view, 'pool.' + name + '.read', t('Read'), p.readBytesPerSec, READ_COLOR)
                + metricRow(view, 'pool.' + name + '.write', t('Write'), p.writeBytesPerSec, WRITE_COLOR)
                + '<div class="anas-dash-muted" style="margin-top:6px">'
                + enc(t('Latency') + '  ▼ ' + fmtLat(p.readLatencyNs)
                    + '   ▲ ' + fmtLat(p.writeLatencyNs)) + '</div>'
                + '</div>';
        }
        return heading(t('Pool I/O — live throughput'))
            + '<div class="anas-dash-cards">' + body + '</div>';
    }

    // 2.7 — per-disk objects in a compact grid, each with live throughput +
    // latency + a combined-throughput sparkline. Kind defaults to 'hdd' and
    // state to 'online' (telemetry carries no per-disk health) — fail-open.
    function renderDisks(view, tel) {
        var disks = (tel && tel.disks) || [];
        if (!disks.length) {
            return heading(t('Disk I/O')) + muted(t('No per-disk telemetry.'));
        }
        var grid = '';
        for (var i = 0; i < disks.length; i++) {
            var d = disks[i] || {};
            var id = d.id || ('disk' + i);
            var iconHtml = '';
            try {
                if (gfx && typeof gfx.icon === 'function') {
                    iconHtml = gfx.icon('hdd', {
                        state: 'online',
                        title: id + (d.pool ? (' · ' + d.pool) : '')
                    }) || '';
                }
            } catch (e) {
                iconHtml = '';
            }
            var total = num(d.readBytesPerSec) + num(d.writeBytesPerSec);
            var arr = pushSpark(view, 'disk.' + id, total);
            var spark = sparkline(arr, { color: 'var(--anas-accent,#3468c0)', width: 66, height: 18 });
            grid += '<div class="anas-dash-disk">' + iconHtml
                + '<div style="min-width:0">'
                + '<div class="anas-dash-disk-id" title="' + enc(id) + '">' + enc(shortId(id)) + '</div>'
                + '<div class="anas-dash-disk-sub">'
                + enc('▼ ' + bps(d.readBytesPerSec) + '  ▲ ' + bps(d.writeBytesPerSec)) + '</div>'
                + '<div class="anas-dash-disk-sub">' + enc(t('lat') + ' ' + fmtLat(pickLat(d))) + '</div>'
                + spark
                + '</div></div>';
        }
        return heading(t('Disk I/O — per device'))
            + '<div class="anas-dash-diskgrid">' + grid + '</div>';
    }

    // 2.7 — network correlation view: total rx/tx (link utilization next to the
    // storage throughput above) plus a per-interface card.
    function renderNet(view, tel) {
        var net = tel && tel.net;
        if (!net) {
            return heading(t('Network')) + muted(t('No network telemetry.'));
        }
        var total = '<div class="anas-dash-card" style="margin-bottom:12px">'
            + metricRow(view, 'net.total.rx', t('Total RX'), net.totalRxBytesPerSec, RX_COLOR)
            + metricRow(view, 'net.total.tx', t('Total TX'), net.totalTxBytesPerSec, TX_COLOR)
            + '</div>';
        var ifs = net.interfaces || [];
        var perIf = '';
        for (var i = 0; i < ifs.length; i++) {
            var f = ifs[i] || {};
            var nm = f.name || ('if' + i);
            perIf += '<div class="anas-dash-card" style="min-width:270px;flex:1 1 280px">'
                + '<div class="anas-dash-card-title"><span>' + enc(nm) + '</span></div>'
                + metricRow(view, 'net.' + nm + '.rx', t('RX'), f.rxBytesPerSec, RX_COLOR)
                + metricRow(view, 'net.' + nm + '.tx', t('TX'), f.txBytesPerSec, TX_COLOR)
                + '</div>';
        }
        return heading(t('Network — link utilization vs storage throughput'))
            + total
            + (perIf ? '<div class="anas-dash-cards">' + perIf + '</div>' : '');
    }

    // Telemetry freshness line for the toolbar (live/unavailable + a dot).
    function statusLine(ok, whenTxt) {
        var color = ok ? OK_COLOR : BAD_COLOR;
        var txt = ok ? (t('Live telemetry') + ' · ' + whenTxt) : t('Live telemetry unavailable');
        return '<span class="dot" style="background:' + color + '"></span>' + enc(txt);
    }

    // ---- Section plumbing --------------------------------------------------

    function setSection(view, itemId, html) {
        try {
            if (!view || view.destroyed || view.destroying) {
                return;
            }
            var cmp = view.down('#' + itemId);
            if (cmp) {
                if (typeof cmp.setHtml === 'function') {
                    cmp.setHtml(html);
                } else if (typeof cmp.update === 'function') {
                    cmp.update(html);
                }
            }
        } catch (e) {
            ANAS.warn('dashboard section ' + itemId + ' failed: ' + ANAS.errText(e));
        }
    }

    // Some daemons wrap payloads in { data: ... }; the contract is a bare object.
    // Accept either so the view is robust to both shapes.
    function unwrap(res, probe) {
        if (res && res[probe] === undefined && res.data && res.data[probe] !== undefined) {
            return res.data;
        }
        return res || {};
    }

    // ---- Loaders -----------------------------------------------------------

    function loadStatus(view, node) {
        ANAS.api.get(node, '/status').then(function (res) {
            if (view.destroyed || view.destroying) {
                return;
            }
            var st = unwrap(res, 'pools');
            setSection(view, 'anasDashWarnings', renderWarnings(st));
            setSection(view, 'anasDashPools', renderPools(st));
            setSection(view, 'anasDashOverview', renderOverview(st));
        }, function (err) {
            if (view.destroyed || view.destroying) {
                return;
            }
            ANAS.warn('dashboard status failed: ' + ANAS.errText(err));
            // Fail-open: degrade the status sections to muted "unavailable".
            setSection(view, 'anasDashWarnings', '');
            setSection(view, 'anasDashPools', heading(t('Pool Health')) + muted(t('Status unavailable.')));
            setSection(view, 'anasDashOverview', muted(t('Status unavailable.')));
        });
    }

    function pollTelemetry(view, node) {
        ANAS.api.get(node, '/telemetry').then(function (res) {
            if (view.destroyed || view.destroying) {
                return;
            }
            var tel = unwrap(res, 'arc');
            view._anasHadTelemetry = true;
            setSection(view, 'anasDashStatus', statusLine(true, t('just now')));
            setSection(view, 'anasDashArc', renderArc(view, tel));
            setSection(view, 'anasDashIo', renderPoolIo(view, tel));
            setSection(view, 'anasDashDisks', renderDisks(view, tel));
            setSection(view, 'anasDashNet', renderNet(view, tel));
        }, function (err) {
            if (view.destroyed || view.destroying) {
                return;
            }
            ANAS.warn('dashboard telemetry failed: ' + ANAS.errText(err));
            setSection(view, 'anasDashStatus', statusLine(false, ''));
            // Only blank the telemetry sections on the FIRST failure (no good
            // data yet). Once we've had a good sample, keep the last-good render
            // rather than flickering to "unavailable" on a transient blip.
            if (!view._anasHadTelemetry) {
                setSection(view, 'anasDashArc', heading(t('ARC')) + muted(t('Live telemetry unavailable.')));
                setSection(view, 'anasDashIo', heading(t('Pool I/O')) + muted(t('Live telemetry unavailable.')));
                setSection(view, 'anasDashDisks', heading(t('Disk I/O')) + muted(t('Live telemetry unavailable.')));
                setSection(view, 'anasDashNet', heading(t('Network')) + muted(t('Live telemetry unavailable.')));
            }
        });
    }

    // ---- Poll loop control (start/stop; strictly no leaked intervals) ------

    function startPolling(view, node) {
        if (!view || view.destroyed || view.destroying) {
            return;
        }
        stopPolling(view); // idempotent — never run two intervals
        try {
            pollTelemetry(view, node); // immediate tick so we don't wait POLL_MS
        } catch (e) {
            // non-fatal
        }
        try {
            view._anasTimer = setInterval(function () {
                try {
                    if (!view || view.destroyed || view.destroying) {
                        stopPolling(view);
                        return;
                    }
                    // Pause (skip the fetch) while the tab or panel is hidden —
                    // belt-and-suspenders on top of the hide/deactivate stops.
                    if (typeof document !== 'undefined' && document.hidden) {
                        return;
                    }
                    if (typeof view.isVisible === 'function' && !view.isVisible()) {
                        return;
                    }
                    pollTelemetry(view, node);
                } catch (tickErr) {
                    ANAS.warn('dashboard poll tick failed: ' + ANAS.errText(tickErr));
                }
            }, POLL_MS);
        } catch (e2) {
            ANAS.warn('dashboard interval start failed: ' + ANAS.errText(e2));
        }
    }

    function stopPolling(view) {
        try {
            if (view && view._anasTimer) {
                clearInterval(view._anasTimer);
                view._anasTimer = null;
            }
        } catch (e) {
            // non-fatal
        }
    }

    // Full teardown on destroy: interval + the document visibility listener.
    function cleanup(view) {
        stopPolling(view);
        try {
            if (view && view._anasVisHandler && typeof document !== 'undefined'
                && document.removeEventListener) {
                document.removeEventListener('visibilitychange', view._anasVisHandler);
                view._anasVisHandler = null;
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ---- Factory + registration --------------------------------------------

    function headHtml(node) {
        return '<h2 style="margin:0 0 2px 0">' + enc(t('ANAS Dashboard')) + '</h2>'
            + '<div class="anas-dash-muted">' + enc(t('Node') + ': ' + node) + '</div>';
    }

    function section(itemId, cls, initialHtml) {
        return {
            xtype: 'component',
            itemId: itemId,
            cls: cls,
            style: { 'margin-bottom': '20px' },
            html: initialHtml
        };
    }

    ANAS.views.dashboard = {
        itemId: CARD_ITEM_ID,
        text: 'Dashboard',
        iconCls: 'fa fa-tachometer',
        factory: function (node) {
            gfx = ANAS.gfx; // (re)bind in case gfx loaded after this file's IIFE
            try {
                ensureDashStyles();
            } catch (e) {
                // non-fatal
            }
            return {
                xtype: 'panel',
                cls: 'anas-view anas-view-dashboard',
                scrollable: true,
                bodyPadding: 16,
                border: false,
                tbar: [
                    {
                        text: t('Refresh'),
                        cls: 'anas-btn-dash-refresh',
                        iconCls: 'fa fa-refresh',
                        handler: function (btn) {
                            try {
                                var v = btn.up('panel');
                                loadStatus(v, node);
                                pollTelemetry(v, node);
                            } catch (e) {
                                ANAS.warn('dashboard refresh failed: ' + ANAS.errText(e));
                            }
                        }
                    },
                    '->',
                    {
                        xtype: 'component',
                        itemId: 'anasDashStatus',
                        cls: 'anas-dash-status',
                        html: '<span class="dot" style="background:' + MUTED_COLOR + '"></span>'
                            + enc(t('Connecting…'))
                    }
                ],
                items: [
                    {
                        xtype: 'component',
                        itemId: 'anasDashHead',
                        style: { 'margin-bottom': '14px' },
                        html: headHtml(node)
                    },
                    // 2.5 warnings — no heading, callouts speak for themselves.
                    {
                        xtype: 'component',
                        itemId: 'anasDashWarnings',
                        cls: 'anas-dash-warnings',
                        html: ''
                    },
                    section('anasDashPools', 'anas-dash-pools', heading(t('Pool Health')) + muted(t('Loading…'))),
                    section('anasDashOverview', 'anas-dash-overview', muted(t('Loading…'))),
                    section('anasDashArc', 'anas-dash-arc', heading(t('ARC')) + muted(t('Connecting…'))),
                    section('anasDashIo', 'anas-dash-io', heading(t('Pool I/O')) + muted(t('Connecting…'))),
                    section('anasDashDisks', 'anas-dash-disks', heading(t('Disk I/O')) + muted(t('Connecting…'))),
                    section('anasDashNet', 'anas-dash-net', heading(t('Network')) + muted(t('Connecting…')))
                ],
                listeners: {
                    afterrender: function (view) {
                        loadStatus(view, node);
                        startPolling(view, node);
                        // Follow the owning card's activate/deactivate (the PVE
                        // card layout fires these on the card, not this panel).
                        try {
                            var card = view.up('#' + CARD_ITEM_ID);
                            if (card && typeof card.on === 'function') {
                                card.on('activate', function () {
                                    loadStatus(view, node);
                                    startPolling(view, node);
                                });
                                card.on('deactivate', function () {
                                    stopPolling(view);
                                });
                            }
                        } catch (e) {
                            // non-fatal — panel show/hide + tick guard still apply
                        }
                        // Pause/resume with the browser tab.
                        try {
                            view._anasVisHandler = function () {
                                try {
                                    if (document.hidden) {
                                        stopPolling(view);
                                    } else if (typeof view.isVisible === 'function' && view.isVisible()) {
                                        startPolling(view, node);
                                    }
                                } catch (e2) {
                                    // non-fatal
                                }
                            };
                            if (typeof document !== 'undefined' && document.addEventListener) {
                                document.addEventListener('visibilitychange', view._anasVisHandler);
                            }
                        } catch (e3) {
                            // non-fatal
                        }
                    },
                    activate: function (view) {
                        loadStatus(view, node);
                        startPolling(view, node);
                    },
                    deactivate: function (view) {
                        stopPolling(view);
                    },
                    show: function (view) {
                        startPolling(view, node);
                    },
                    hide: function (view) {
                        stopPolling(view);
                    },
                    beforedestroy: function (view) {
                        cleanup(view);
                    },
                    destroy: function (view) {
                        cleanup(view);
                    }
                }
            };
        }
    };
})();
