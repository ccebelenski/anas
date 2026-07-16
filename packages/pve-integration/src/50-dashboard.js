/*
 * ANAS — Dashboard view (Epic 2: stories 2.1–2.7; gfx retrofit 15.5;
 * information-architecture re-layout).
 *
 * The real, gold-standard ANAS landing page. Top → bottom:
 *   1. Warnings   — critical/warning callouts (only when present).
 *   2. Disk Fleet — the at-a-glance healthy/warning/critical/unknown count tiles
 *                   plus a compact "Recent activity" jobs strip (relative time +
 *                   duration + outcome). Moved to the TOP.
 *   3. Pools      — THE HEADLINE. One nested Pool → VDEV → Device hierarchy per
 *                   pool, absorbing the old "Pool health", "Pool I/O" and
 *                   "Disk I/O" sections: pool state pill + capacity donut +
 *                   aggregate live I/O + scan indicator; each vdev its own state
 *                   pill + type + aggregated I/O; each device its disk object +
 *                   live throughput + latency. Matches /status pools to
 *                   /telemetry pools by name.
 *   4. ARC        — hit-ratio gauge + size/target + L2.
 *   5. Network    — total rx/tx time chart + per-interface rx/tx numbers.
 * All rendered in the ANAS.gfx visual language (15-gfx.js). Pool, per-vdev and
 * network I/O use labelled gfx.timeChart time-series charts fed by client-side
 * rolling 5-minute buffers; ARC keeps its gauge and per-device rows are live
 * numbers + an activity bar.
 *
 * Data contract (two endpoints, read as JSON; no compile dependency):
 *   GET /v1/status    → { node, pools[], disks{healthy,warning,critical,unknown,
 *                         total}, shares{}, jobs[{id,kind,status,startedAt?,
 *                         finishedAt?,durationMs?}], warnings[] }
 *                       loaded on show + manual Refresh.
 *   GET /v1/telemetry → { sampledAt, windowMs, arc{}, net{}, pools:[ { name,
 *                         ...ioStats, vdevs:[ { name,type,role,state,...ioStats,
 *                         disks:[ { id, ...ioStats } ] } ] } ] }
 *                       POLLED every POLL_MS while the panel is visible.
 *                       ioStats = { readBytesPerSec, writeBytesPerSec, readIops,
 *                       writeIops, readLatencyNs|null, writeLatencyNs|null }.
 *                       (The old flat top-level disks[] array is GONE — disks are
 *                       nested under vdevs under pools.)
 *
 * The Pools section needs BOTH endpoints (state/capacity/scan from /status, I/O
 * from /telemetry). We cache the last-good of each on the view (_anasStatus /
 * _anasTelemetry) and re-render the composite whenever either arrives.
 *
 * POLL LIFECYCLE (critical — a leaked setInterval hammering the daemon is
 * unacceptable): the interval starts on afterrender / activate / show and STOPS
 * on deactivate / hide / destroy. It also self-guards each tick on
 * view.isVisible() and document.hidden, and a visibilitychange listener
 * stops/restarts it when the browser tab is hidden. destroy tears everything
 * down (interval + the document listener).
 *
 * FRAMEWORK CONTRACT: window.ANAS with ANAS.api.get (Promise; path relative to
 * /v1), ANAS.gfx (gauge/bar/donut/legend/icon/statePill/callout/badge/activity/
 * pillLevel), ANAS.formatBytes, ANAS.t, ANAS.enc. The framework wraps this view
 * in the "not installed" probe — we do NOT probe health here. Fail open
 * throughout: a failed status/telemetry fetch degrades a section to a muted
 * "unavailable" state and NEVER throws into the PVE UI.
 *
 * Test hooks: view cls 'anas-view anas-view-dashboard'; section classes
 * 'anas-dash-warnings' / 'anas-dash-fleet' / 'anas-dash-pools' / 'anas-dash-arc'
 * / 'anas-dash-net' / 'anas-dash-status'; Refresh button 'anas-btn-dash-refresh';
 * latency now/peak/avg readout 'anas-dash-lat' (pool head, vdev line, device tile).
 * (The old 'anas-dash-overview' / 'anas-dash-io' / 'anas-dash-disks' /
 * 'anas-dash-shares' sections were folded away by the re-layout.)
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    // Poll cadence for /telemetry while the panel is visible, and the time span of
    // the client-side rolling buffers feeding the time-series charts. 5 minutes at
    // the 2.5s cadence is ~120 samples per metric key. Buffers live on the view so
    // they reset with the panel and never touch the server (no persisted history —
    // Principle 7).
    var POLL_MS = 2500;
    var BUFFER_MS = 5 * 60 * 1000;
    var BUFFER_MAX = Math.max(2, Math.round(BUFFER_MS / POLL_MS));

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
                + '.anas-dash-status .dot{display:inline-block;width:8px;'
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
                + '.anas-dash-cb-bad{background:rgba(194,59,44,.14);color:var(--anas-danger,#c23b2c)}'
                // Recent-activity jobs strip (under the fleet).
                + '.anas-dash-jobstrip{margin-top:14px}'
                + '.anas-dash-job{display:flex;align-items:baseline;gap:8px;font-size:12px;padding:5px 0;'
                + 'border-bottom:1px solid var(--anas-line,#dfe3e8)}'
                + '.anas-dash-job-k{font-weight:650;color:var(--anas-ink,#232936)}'
                + '.anas-dash-job-meta{color:var(--anas-muted,#6b7280);font-variant-numeric:tabular-nums}'
                + '.anas-dash-job-out{margin-left:auto;font-size:10px;text-transform:uppercase;'
                + 'letter-spacing:.5px;font-weight:800}'
                + '.anas-dash-job-run{color:var(--anas-accent,#3468c0)}'
                + '.anas-dash-job-ok{color:var(--anas-ok,#1f9c56)}'
                + '.anas-dash-job-bad{color:var(--anas-danger,#c23b2c)}'
                // Pool → VDEV → Device composite hierarchy.
                + '.anas-dash-pool{padding:14px;border-radius:12px;margin-bottom:14px;box-sizing:border-box;'
                + 'background:linear-gradient(var(--anas-card-top,#fff),var(--anas-card-bot,#eef1f5));'
                + 'border:1px solid var(--anas-card-edge,#cfd6df);box-shadow:var(--anas-shadow,0 1px 3px rgba(20,30,50,.12))}'
                + '.anas-dash-pool-head{display:flex;align-items:center;gap:18px;flex-wrap:wrap}'
                + '.anas-dash-pool-cap{flex:0 0 auto;text-align:center}'
                + '.anas-dash-pool-main{flex:1 1 280px;min-width:240px}'
                + '.anas-dash-pool-name{display:flex;align-items:center;gap:8px;font-weight:750;'
                + 'font-size:15px;color:var(--anas-ink,#232936);margin-bottom:8px}'
                + '.anas-dash-pool-io{margin-top:10px}'
                + '.anas-dash-vdev-chart{margin-top:6px}'
                + '.anas-dash-vdev{margin:10px 0 0 4px;padding:8px 10px 8px 12px;border-radius:0 10px 10px 0;'
                + 'border-left:3px solid var(--anas-card-edge,#cfd6df);background:var(--anas-slot,#f2f4f7)}'
                + '.anas-dash-vdev-degraded{border-left-color:var(--anas-warn,#b06a12)}'
                + '.anas-dash-vdev-faulted{border-left-color:var(--anas-danger,#c23b2c)}'
                + '.anas-dash-vdev-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px}'
                + '.anas-dash-vdev-name{font-weight:700;color:var(--anas-ink,#232936)}'
                + '.anas-dash-vdev-type{font-size:10px;text-transform:uppercase;letter-spacing:.5px;'
                + 'color:var(--anas-muted,#6b7280)}'
                + '.anas-dash-vdev-io{margin-left:auto;color:var(--anas-muted,#6b7280);'
                + 'font-variant-numeric:tabular-nums}'
                + '.anas-dash-devs{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}'
                // Latency now/peak/avg readout (pool head, vdev line, device tiles).
                + '.anas-dash-lat{font-variant-numeric:tabular-nums}'
                + '.anas-dash-vdev-lat{margin-top:4px;font-size:11px}'
                + '.anas-dash-lat-hist{opacity:.85}';
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

    // ---- Rolling buffers + time-series charts ------------------------------

    // Push a sample onto the rolling buffer for `key`, capped at BUFFER_MAX (the
    // 5-minute window), and return the (mutated, oldest→newest) buffer. The
    // buffers feed gfx.timeChart; they live on the view so they reset with the
    // panel and never touch the server (no persisted history — Principle 7).
    function pushSpark(view, key, value) {
        var buf = view._anasSpark || (view._anasSpark = {});
        var arr = buf[key] || (buf[key] = []);
        arr.push(num(value));
        while (arr.length > BUFFER_MAX) {
            arr.shift();
        }
        return arr;
    }

    // ---- Latency rolling buffers + high-water / average readout ------------
    //
    // Latency is measured over each ~1s sample window; a bursty system (e.g. a
    // chia farm) has ZERO I/O in most windows, so the instantaneous value is null
    // most polls. We keep the instantaneous read (it matches the instantaneous
    // rate beside it) and ADD a peak (high-water) + average over the SAME rolling
    // 5-minute window the throughput charts use. Same eviction as pushSpark
    // (capped at BUFFER_MAX), but — unlike pushSpark — we store null verbatim for
    // idle windows: peak/avg skip nulls while the buffer stays time-aligned, so
    // the window is a true 5 minutes with no faked zeros. Lives on the view
    // (_anasLat) so it resets with the panel and never touches the server.
    function pushLat(view, key, value) {
        var buf = view._anasLat || (view._anasLat = {});
        var arr = buf[key] || (buf[key] = []);
        var n = (value === null || value === undefined || isNaN(Number(value)))
            ? null : Number(value);
        arr.push(n);
        while (arr.length > BUFFER_MAX) {
            arr.shift();
        }
        return arr;
    }

    // Peak (max) and average (mean) over the NON-null samples of a latency buffer.
    // count === 0 (no I/O seen yet in the window) → peak/avg null, so the readout
    // shows just the instantaneous value with no fake zeros.
    function latStats(arr) {
        var peak = null, sum = 0, count = 0;
        if (arr) {
            for (var i = 0; i < arr.length; i++) {
                var v = arr[i];
                if (v === null || v === undefined || isNaN(Number(v))) { continue; }
                v = Number(v);
                if (peak === null || v > peak) { peak = v; }
                sum += v;
                count++;
            }
        }
        return { peak: peak, avg: count > 0 ? sum / count : null, count: count };
    }

    // A read/write latency pair: "<label> ▼ <read> ▲ <write>" (▼ = read, ▲ =
    // write, matching the throughput glyphs elsewhere). fmtLat renders null as a
    // muted em dash, so idle directions read as "–" not "0".
    function latPair(label, r, w) {
        return label + ' ▼ ' + fmtLat(r) + ' ▲ ' + fmtLat(w);
    }

    // Compact 3-part latency readout (now / peak / avg, read & write) for an
    // entity, pushing THIS poll's read+write samples onto the entity's rolling
    // buffers first. `keyBase` scopes the buffers (pool by name / vdev by
    // pool+name / disk by id). While no non-null sample has landed in the window
    // yet, only the instantaneous "now" shows (no fake peak/avg zeros). A title
    // tooltip spells out the peak/average-over-5-minutes meaning. `opts.compact`
    // renders the two-muted-line form for the small device tiles; the default is
    // the inline pool/vdev form. Every readout carries the .anas-dash-lat hook.
    function latReadout(view, keyBase, readNs, writeNs, opts) {
        opts = opts || {};
        var rs = latStats(pushLat(view, keyBase + '.read', readNs));
        var ws = latStats(pushLat(view, keyBase + '.write', writeNs));
        var hasHist = rs.count > 0 || ws.count > 0;
        var now = latPair(t('lat'), readNs, writeNs);
        var peak = latPair(t('peak'), rs.peak, ws.peak);
        var avg = latPair(t('avg'), rs.avg, ws.avg);
        var tip = t('now · peak / average over the last 5 minutes');
        if (opts.compact) {
            var line1 = '<div class="anas-dash-disk-sub anas-dash-lat" title="'
                + enc(tip) + '">' + enc(now) + '</div>';
            if (!hasHist) { return line1; }
            return line1 + '<div class="anas-dash-disk-sub anas-dash-lat-hist" title="'
                + enc(tip) + '">' + enc(peak + ' · ' + avg) + '</div>';
        }
        var txt = hasHist ? (now + ' · ' + peak + ' · ' + avg) : now;
        return '<span class="anas-dash-lat" title="' + enc(tip) + '">' + enc(txt) + '</span>';
    }

    // Content width of a section component (its rendered pixel width), so the
    // time charts can be rendered at exact px and fill the section. Fail-open to
    // a sane default before the first layout pass has sized the component.
    function sectionWidth(view, itemId, fallback) {
        try {
            var cmp = view && view.down && view.down('#' + itemId);
            if (cmp && typeof cmp.getWidth === 'function') {
                var w = cmp.getWidth();
                if (w && w > 0) { return w; }
            }
            if (view && typeof view.getWidth === 'function') {
                var vw = view.getWidth();
                if (vw && vw > 0) { return vw - 32; } // minus bodyPadding
            }
        } catch (e) {
            // fall through
        }
        return fallback || 620;
    }

    // Render a bicolor gfx.timeChart, degrading to a muted note if gfx is absent
    // or the chart fails open (returns ''). Never throws into the caller.
    function timeChartHtml(series, opts) {
        try {
            if (gfx && typeof gfx.timeChart === 'function') {
                var html = gfx.timeChart(series, opts);
                if (html) { return html; }
            }
        } catch (e) {
            // fall through to the muted note
        }
        return '<div class="anas-dash-muted">' + enc(t('Live I/O collecting…')) + '</div>';
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

    // A coloured count tile for the fleet summary.
    function statTile(n, label, color) {
        return '<div class="anas-dash-stat">'
            + '<div class="anas-dash-stat-n" style="color:' + color + '">' + enc('' + n) + '</div>'
            + '<div class="anas-dash-stat-l">' + enc(label) + '</div></div>';
    }

    // ---- Jobs / activity time formatting -----------------------------------

    // Coerce an ISO string or epoch (ms or s) to epoch-ms; NaN when absent/bad.
    function toMs(v) {
        if (v === null || v === undefined || v === '') { return NaN; }
        if (typeof v === 'number') {
            // Heuristic: a 10-digit epoch is seconds; widen to milliseconds.
            return v < 1e12 ? v * 1000 : v;
        }
        var p = Date.parse('' + v);
        return isNaN(p) ? NaN : p;
    }

    // Human duration from milliseconds: "45s", "12m 3s", "1h 2m", "2d 3h".
    function fmtDur(ms) {
        var n = Number(ms);
        if (isNaN(n) || n < 0) { return '—'; }
        var s = Math.round(n / 1000);
        if (s < 60) { return s + 's'; }
        var m = Math.floor(s / 60); s = s % 60;
        if (m < 60) { return m + 'm ' + s + 's'; }
        var h = Math.floor(m / 60); m = m % 60;
        if (h < 24) { return h + 'h ' + m + 'm'; }
        var d = Math.floor(h / 24); h = h % 24;
        return d + 'd ' + h + 'h';
    }

    // Relative "time ago" from an epoch-ms; "just now" under 10s. Never negative.
    function relAgo(ms) {
        var n = Number(ms);
        if (isNaN(n)) { return ''; }
        var delta = Date.now() - n;
        if (delta < 0) { delta = 0; }
        if (delta < 10000) { return t('just now'); }
        return fmtDur(delta) + ' ' + t('ago');
    }

    // 2.4 — enriched recent-activity strip. Each job renders as
    // "<kind [target]> · <when> · <ran|elapsed duration>" plus an outcome tag.
    // Running jobs show elapsed since startedAt; finished jobs show finishedAt
    // relative + the run duration (durationMs, else finishedAt − startedAt).
    function jobsStrip(status) {
        var jobs = (status && status.jobs) || [];
        if (!jobs.length) {
            return heading(t('Recent activity')) + muted(t('No recent jobs.'));
        }
        var maxRows = Math.min(jobs.length, 6);
        var rows = '';
        for (var i = 0; i < maxRows; i++) {
            var j = jobs[i] || {};
            var kind = j.kind || j.id || t('job');
            var target = j.target || j.pool || j.dataset || j.name || '';
            var st = ('' + (j.status || '')).toLowerCase();
            var started = toMs(j.startedAt);
            var finished = toMs(j.finishedAt);
            var running = isNaN(finished)
                && (st === 'running' || st === 'active' || st === 'in_progress'
                    || st === 'pending' || st === '');

            var when = '';
            var durPart = '';
            var outCls = 'anas-dash-job-ok';
            var outTxt = st || t('done');
            if (running) {
                outCls = 'anas-dash-job-run';
                outTxt = t('running');
                when = t('running');
                if (!isNaN(started)) {
                    durPart = t('elapsed') + ' ' + fmtDur(Date.now() - started);
                }
            } else {
                if (st === 'failed' || st === 'error' || st === 'cancelled' || st === 'canceled') {
                    outCls = 'anas-dash-job-bad';
                }
                when = !isNaN(finished) ? relAgo(finished) : (!isNaN(started) ? relAgo(started) : '');
                var dur = j.durationMs;
                if ((dur === null || dur === undefined || isNaN(Number(dur)))
                    && !isNaN(finished) && !isNaN(started)) {
                    dur = finished - started;
                }
                if (dur !== null && dur !== undefined && !isNaN(Number(dur))) {
                    durPart = t('ran') + ' ' + fmtDur(dur);
                }
            }

            var meta = [];
            if (when) { meta.push(when); }
            if (durPart) { meta.push(durPart); }

            rows += '<div class="anas-dash-job">'
                + '<span class="anas-dash-job-k">' + enc(kind + (target ? ' ' + target : '')) + '</span>'
                + (meta.length ? '<span class="anas-dash-job-meta">· ' + enc(meta.join(' · ')) + '</span>' : '')
                + '<span class="anas-dash-job-out ' + outCls + '">' + enc(outTxt) + '</span>'
                + '</div>';
        }
        if (jobs.length > maxRows) {
            rows += '<div class="anas-dash-muted" style="margin-top:6px">'
                + enc('+' + (jobs.length - maxRows) + ' ' + t('more')) + '</div>';
        }
        return heading(t('Recent activity')) + rows;
    }

    // 2.2 — disk fleet health, now at the TOP: healthy / warning / critical /
    // unknown count tiles + total, with the recent-activity strip alongside.
    function renderFleet(status) {
        var d = (status && status.disks) || {};
        var tiles = '<div class="anas-dash-stats">'
            + statTile(num(d.healthy), t('Healthy'), OK_COLOR)
            + statTile(num(d.warning), t('Warning'), WARN_COLOR)
            + statTile(num(d.critical), t('Critical'), BAD_COLOR)
            + statTile(num(d.unknown), t('Unknown'), MUTED_COLOR)
            + '</div>'
            + '<div class="anas-dash-muted" style="margin-top:8px">'
            + enc(num(d.total) + ' ' + t('disks total')) + '</div>';
        return '<div class="anas-dash-row">'
            + '<div class="anas-dash-col" style="flex:1 1 340px">'
            + heading(t('Disk Fleet')) + tiles + '</div>'
            + '<div class="anas-dash-col anas-dash-jobs" style="flex:1 1 300px">'
            + '<div class="anas-dash-jobstrip">' + jobsStrip(status) + '</div></div>'
            + '</div>';
    }

    // ---- TELEMETRY sections (polled) ---------------------------------------

    // 2.7 — ARC hit ratio gauge + size/target + max, L2ARC line when present.
    // Hit ratio is a natural 0..1 fullness, so the gauge already reads clearly —
    // no time chart here (the sparkline earned no axes and was removed).
    function renderArc(view, tel) {
        var arc = tel && tel.arc;
        if (!arc) {
            return heading(t('ARC')) + muted(t('No ARC data.'));
        }
        var hr = clamp01(arc.hitRatio);
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
        return heading(t('ARC — Adaptive Replacement Cache'))
            + '<div class="anas-dash-row">'
            + '<div class="anas-dash-col">' + gaugeHtml + maxLine + l2 + '</div>'
            + '</div>';
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

    // ---- Pool → VDEV → Device composite (the headline) ---------------------
    //
    // ONE nested hierarchy per pool, absorbing the old Pool-health / Pool-I/O /
    // Disk-I/O sections. State/capacity/scan come from /status; live I/O comes
    // from the matching /telemetry pool (by name); vdevs and devices come from
    // the telemetry pool's nested vdevs[].disks[]. Both caches live on the view
    // and this renders from whichever we have (fail-open, last-good preserved).

    // A telemetry device tile: disk object + live throughput numbers + latency +
    // a slim activity bar (combined throughput relative to the busiest sibling
    // device in this vdev — a live, stateless "how busy" read; no sparkline, it
    // earned no axes). Kind defaults to 'hdd', state to 'online' (telemetry
    // carries no per-disk health) — scoped to its vdev by nesting.
    function renderDevice(view, dev, refMax) {
        dev = dev || {};
        var id = dev.id || 'disk';
        var iconHtml = '';
        try {
            if (gfx && typeof gfx.icon === 'function') {
                iconHtml = gfx.icon('hdd', { state: 'online', title: id }) || '';
            }
        } catch (e) {
            iconHtml = '';
        }
        var total = num(dev.readBytesPerSec) + num(dev.writeBytesPerSec);
        var frac = refMax > 0 ? total / refMax : 0;
        var barHtml = '';
        try {
            if (gfx && typeof gfx.bar === 'function') {
                barHtml = gfx.bar(frac, {
                    pct: false, color: 'var(--anas-accent,#3468c0)', title: bps(total)
                }) || '';
            }
        } catch (eB) {
            barHtml = '';
        }
        if (!barHtml) {
            barHtml = fallbackBar(frac, 'var(--anas-accent,#3468c0)');
        }
        return '<div class="anas-dash-disk">' + iconHtml
            + '<div style="min-width:0;flex:1 1 auto">'
            + '<div class="anas-dash-disk-id" title="' + enc(id) + '">' + enc(shortId(id)) + '</div>'
            + '<div class="anas-dash-disk-sub">'
            + enc('▼ ' + bps(dev.readBytesPerSec) + '  ▲ ' + bps(dev.writeBytesPerSec)) + '</div>'
            + latReadout(view, 'disk.' + id, dev.readLatencyNs, dev.writeLatencyNs, { compact: true })
            + '<div style="margin-top:5px">' + barHtml + '</div>'
            + '</div></div>';
    }

    // A vdev group: name + type + its state pill + aggregated IOPS/latency line,
    // its own bicolor read/write time chart, over a device grid. The left border
    // + a *-degraded/-faulted class make a degraded vdev read as degraded even at
    // a glance (colour keyed off gfx.pillLevel). `chartW` is the measured pixel
    // width for its time chart; `poolName` scopes the rolling-buffer keys.
    function renderVdev(view, vdev, poolName, chartW) {
        vdev = vdev || {};
        var lvl = '';
        try {
            if (gfx && typeof gfx.pillLevel === 'function') {
                lvl = gfx.pillLevel(vdev.state) || '';
            }
        } catch (eL) {
            lvl = '';
        }
        var pill = '';
        try {
            if (gfx && typeof gfx.statePill === 'function' && vdev.state) {
                pill = gfx.statePill(vdev.state, { label: vdev.state }) || '';
            }
        } catch (eP) {
            pill = '';
        }
        if (!pill && vdev.state) {
            pill = '<span class="anas-dash-muted">' + enc('' + vdev.state) + '</span>';
        }
        var name = vdev.name || vdev.type || t('vdev');
        var typeTag = vdev.type
            ? '<span class="anas-dash-vdev-type">' + enc(vdev.type) + '</span>' : '';
        var io = '<span class="anas-dash-vdev-io">'
            + enc('▼ ' + bps(vdev.readBytesPerSec) + '  ▲ ' + bps(vdev.writeBytesPerSec)
                + '  ·  ' + iops(vdev.readIops) + '/' + iops(vdev.writeIops) + ' IOPS') + '</span>';

        // Latency now/peak/avg for the whole vdev, on its own muted line under the
        // head (the head is already IOPS-dense; keeping latency on its own line
        // lets peak/avg for both directions sit inline without crowding).
        var latHtml = '<div class="anas-dash-vdev-lat anas-dash-muted">'
            + latReadout(view, 'vdev.' + poolName + '.' + name,
                vdev.readLatencyNs, vdev.writeLatencyNs, {}) + '</div>';

        // Per-vdev bicolor read/write time chart (compact — visual hierarchy under
        // the pool chart — but still fully labelled with axes + legend).
        var vKey = 'vdev.' + poolName + '.' + name;
        var vr = pushSpark(view, vKey + '.read', vdev.readBytesPerSec);
        var vw = pushSpark(view, vKey + '.write', vdev.writeBytesPerSec);
        var chart = timeChartHtml(
            [
                { label: t('Read'), color: READ_COLOR, values: vr },
                { label: t('Write'), color: WRITE_COLOR, values: vw }
            ],
            { width: chartW, height: 120, windowMs: BUFFER_MS, sampleMs: POLL_MS }
        );

        var devs = vdev.disks || [];
        var refMax = 0;
        for (var d = 0; d < devs.length; d++) {
            var dt = num(devs[d] && devs[d].readBytesPerSec) + num(devs[d] && devs[d].writeBytesPerSec);
            if (dt > refMax) { refMax = dt; }
        }
        var devHtml = '';
        for (var i = 0; i < devs.length; i++) {
            devHtml += renderDevice(view, devs[i], refMax);
        }
        return '<div class="anas-dash-vdev' + (lvl ? ' anas-dash-vdev-' + lvl : '') + '">'
            + '<div class="anas-dash-vdev-head">'
            + '<span class="anas-dash-vdev-name">' + enc(name) + '</span>'
            + typeTag + pill + io + '</div>'
            + latHtml
            + '<div class="anas-dash-vdev-chart">' + chart + '</div>'
            + (devHtml ? '<div class="anas-dash-devs">' + devHtml + '</div>' : '')
            + '</div>';
    }

    // A single pool block: the good card look (state pill + capacity donut) +
    // aggregate live I/O + scan indicator, then the nested vdevs. `p` is the
    // /status pool (capacity/state/scan); `tp` is the matched /telemetry pool
    // (I/O + vdevs), or null when telemetry hasn't landed for this pool yet.
    function renderPoolBlock(view, p, tp, dims) {
        dims = dims || {};
        var poolW = dims.pool > 0 ? dims.pool : 620;
        var vdevW = dims.vdev > 0 ? dims.vdev : 560;
        var name = p.name || 'pool';
        var cap = num(p.capacity);
        var alloc = num(p.allocated);
        var size = num(p.size);
        var free = p.free !== undefined ? num(p.free) : Math.max(size - alloc, 0);

        var donut = '';
        try {
            if (gfx && typeof gfx.donut === 'function' && (size > 0 || alloc > 0 || free > 0)) {
                donut = gfx.donut(
                    [
                        { label: t('Used'), value: alloc },
                        { label: t('Free'), value: free, free: true }
                    ],
                    { size: 104, center: { big: Math.round(cap) + '%', sm: ANAS.formatBytes(size) } }
                ) || '';
            }
        } catch (eD) {
            donut = '';
        }
        if (!donut && p.capacity !== undefined) {
            // gfx unavailable — a plain fullness bar still conveys capacity.
            donut = fallbackBar(cap / 100, cap >= 90 ? BAD_COLOR : (cap >= 75 ? WARN_COLOR : OK_COLOR))
                + '<div class="anas-dash-muted" style="margin-top:4px">' + enc(Math.round(cap) + '%') + '</div>';
        }

        var pill = '';
        try {
            if (gfx && typeof gfx.statePill === 'function' && p.state) {
                pill = gfx.statePill(p.state, { label: p.state }) || '';
            }
        } catch (eP) {
            pill = '';
        }
        if (!pill && p.state && ANAS.renderState) {
            pill = ANAS.renderState(p.state);
        }

        // Aggregate live read/write I/O from the telemetry pool level: an IOPS +
        // latency summary line in the head, and the headline full-width bicolor
        // time chart below it.
        var summaryHtml = '';
        var chartHtml = '';
        if (tp) {
            summaryHtml = '<div class="anas-dash-muted" style="margin-top:4px">'
                + enc(iops(tp.readIops) + ' r · ' + iops(tp.writeIops) + ' w IOPS   ·   ')
                + latReadout(view, 'pool.' + name, tp.readLatencyNs, tp.writeLatencyNs, {})
                + '</div>';
            var pr = pushSpark(view, 'pool.' + name + '.read', tp.readBytesPerSec);
            var pw = pushSpark(view, 'pool.' + name + '.write', tp.writeBytesPerSec);
            chartHtml = '<div class="anas-dash-pool-io">' + timeChartHtml(
                [
                    { label: t('Read'), color: READ_COLOR, values: pr },
                    { label: t('Write'), color: WRITE_COLOR, values: pw }
                ],
                {
                    width: poolW, height: 160, windowMs: BUFFER_MS, sampleMs: POLL_MS,
                    title: t('Pool I/O')
                }
            ) + '</div>';
        } else {
            chartHtml = '<div class="anas-dash-pool-io">' + muted(t('Live I/O collecting…')) + '</div>';
        }

        var capBlock = donut
            ? '<div class="anas-dash-pool-cap">' + donut
                + '<div class="anas-dash-muted" style="margin-top:6px">'
                + enc(ANAS.formatBytes(alloc) + ' / ' + ANAS.formatBytes(size)) + '</div></div>'
            : '';

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

        var vdevs = (tp && tp.vdevs) || [];
        var vdevHtml = '';
        for (var i = 0; i < vdevs.length; i++) {
            vdevHtml += renderVdev(view, vdevs[i], name, vdevW);
        }

        return '<div class="anas-dash-pool">'
            + '<div class="anas-dash-pool-head">'
            + capBlock
            + '<div class="anas-dash-pool-main">'
            + '<div class="anas-dash-pool-name">' + poolGlyph()
            + '<span>' + enc(name) + '</span>' + pill + '</div>'
            + summaryHtml
            + '</div></div>'
            + chartHtml
            + scan
            + vdevHtml
            + '</div>';
    }

    // The headline Pools section: matches /status pools to /telemetry pools by
    // name and renders each as a Pool → VDEV → Device block. Reads both caches
    // off the view so it re-renders correctly whichever endpoint ticked.
    function renderPoolsComposite(view) {
        var st = view && view._anasStatus;
        var tel = view && view._anasTelemetry;
        var statusPools = (st && st.pools) || [];
        var telPools = (tel && tel.pools) || [];

        var telMap = {};
        for (var k = 0; k < telPools.length; k++) {
            if (telPools[k] && telPools[k].name != null) {
                telMap['' + telPools[k].name] = telPools[k];
            }
        }

        // Prefer /status pools (they carry capacity/state); fall back to the
        // telemetry pools when status hasn't arrived so the section is never
        // empty on the first telemetry tick.
        var list = statusPools.length ? statusPools : telPools;
        if (!list.length) {
            return heading(t('Pools')) + muted(t('No pools.'));
        }

        // Measure the section so the time charts render at exact px and fill it.
        // pool card = 14px padding each side + 1px border; the nested vdev adds a
        // 4px margin, 12+10px padding and 3px accent border. Floor so a not-yet-
        // laid-out (width 0) first render still produces sensible charts.
        var secW = sectionWidth(view, 'anasDashPools', 620);
        var poolW = Math.max(240, secW - 30);
        var vdevW = Math.max(220, poolW - 33);
        var dims = { pool: poolW, vdev: vdevW };

        var body = '';
        for (var i = 0; i < list.length; i++) {
            var p = list[i] || {};
            var name = p.name || ('pool' + i);
            // When falling back to telemetry pools, `p` already IS the telemetry
            // pool, so use it directly for the I/O side too.
            var tp = telMap[name] || (statusPools.length ? null : p);
            body += renderPoolBlock(view, p, tp, dims);
        }
        return heading(t('Pools')) + body;
    }

    // 2.7 — network correlation view: total rx/tx (link utilization next to the
    // storage throughput above) plus a per-interface card.
    function renderNet(view, tel) {
        var net = tel && tel.net;
        if (!net) {
            return heading(t('Network')) + muted(t('No network telemetry.'));
        }
        // Full-width bicolor rx/tx time chart for total link utilization.
        var secW = sectionWidth(view, 'anasDashNet', 620);
        var netW = Math.max(240, secW - 30);
        var nrx = pushSpark(view, 'net.total.rx', net.totalRxBytesPerSec);
        var ntx = pushSpark(view, 'net.total.tx', net.totalTxBytesPerSec);
        var total = '<div class="anas-dash-card" style="margin-bottom:12px">'
            + timeChartHtml(
                [
                    { label: t('RX'), color: RX_COLOR, values: nrx },
                    { label: t('TX'), color: TX_COLOR, values: ntx }
                ],
                {
                    width: netW, height: 150, windowMs: BUFFER_MS, sampleMs: POLL_MS,
                    title: t('Total throughput')
                }
            )
            + '</div>';
        // Per-interface live numeric readout (no chart — the total chart carries
        // the trend; interfaces are a compact rx/tx number pair).
        var ifs = net.interfaces || [];
        var perIf = '';
        for (var i = 0; i < ifs.length; i++) {
            var f = ifs[i] || {};
            var nm = f.name || ('if' + i);
            perIf += '<div class="anas-dash-card" style="min-width:200px;flex:1 1 220px">'
                + '<div class="anas-dash-card-title"><span>' + enc(nm) + '</span></div>'
                + '<div class="anas-dash-disk-sub">'
                + enc('▼ ' + t('RX') + ' ' + bps(f.rxBytesPerSec)) + '</div>'
                + '<div class="anas-dash-disk-sub">'
                + enc('▲ ' + t('TX') + ' ' + bps(f.txBytesPerSec)) + '</div>'
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
            view._anasStatus = st; // cache for the composite (needs both endpoints)
            setSection(view, 'anasDashWarnings', renderWarnings(st));
            setSection(view, 'anasDashFleet', renderFleet(st));
            // The Pools composite blends /status (state/capacity/scan) with the
            // cached /telemetry (I/O + vdevs). Re-render it from both caches.
            setSection(view, 'anasDashPools', renderPoolsComposite(view));
        }, function (err) {
            if (view.destroyed || view.destroying) {
                return;
            }
            ANAS.warn('dashboard status failed: ' + ANAS.errText(err));
            // Fail-open: degrade the status-fed sections to muted "unavailable".
            setSection(view, 'anasDashWarnings', '');
            setSection(view, 'anasDashFleet', heading(t('Disk Fleet')) + muted(t('Status unavailable.')));
            // Keep the composite if we've ever had status; otherwise show it as
            // unavailable (telemetry-only pools may still fill in on a good tick).
            if (!view._anasStatus) {
                setSection(view, 'anasDashPools', heading(t('Pools')) + muted(t('Status unavailable.')));
            }
        });
    }

    function pollTelemetry(view, node) {
        ANAS.api.get(node, '/telemetry').then(function (res) {
            if (view.destroyed || view.destroying) {
                return;
            }
            var tel = unwrap(res, 'arc');
            view._anasTelemetry = tel; // cache for the composite
            view._anasHadTelemetry = true;
            setSection(view, 'anasDashStatus', statusLine(true, t('just now')));
            setSection(view, 'anasDashArc', renderArc(view, tel));
            // Pool I/O now lives inside the composite — re-render it each tick.
            setSection(view, 'anasDashPools', renderPoolsComposite(view));
            setSection(view, 'anasDashNet', renderNet(view, tel));
        }, function (err) {
            if (view.destroyed || view.destroying) {
                return;
            }
            ANAS.warn('dashboard telemetry failed: ' + ANAS.errText(err));
            setSection(view, 'anasDashStatus', statusLine(false, ''));
            // Only blank the telemetry sections on the FIRST failure (no good
            // data yet). Once we've had a good sample, keep the last-good render
            // rather than flickering to "unavailable" on a transient blip. The
            // Pools composite still shows /status capacity/state without I/O.
            if (!view._anasHadTelemetry) {
                setSection(view, 'anasDashArc', heading(t('ARC')) + muted(t('Live telemetry unavailable.')));
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
                    // Disk Fleet at the top — the at-a-glance view (+ recent activity).
                    section('anasDashFleet', 'anas-dash-fleet', heading(t('Disk Fleet')) + muted(t('Loading…'))),
                    // The headline: nested Pool → VDEV → Device composite.
                    section('anasDashPools', 'anas-dash-pools', heading(t('Pools')) + muted(t('Loading…'))),
                    section('anasDashArc', 'anas-dash-arc', heading(t('ARC')) + muted(t('Connecting…'))),
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
