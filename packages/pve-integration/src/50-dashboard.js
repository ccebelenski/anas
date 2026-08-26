/*
 * ANAS — Dashboard view (Epic 2: stories 2.1–2.7; gfx retrofit 15.5).
 *
 * The real, gold-standard ANAS landing page. Top → bottom:
 *   1. Warnings   — critical/warning callouts (only when present).
 *   2. Disk Fleet — the at-a-glance healthy/warning/critical/unknown count tiles
 *                   plus a compact "Recent activity" jobs strip (relative time +
 *                   duration + outcome).
 *   3. Pools      — THE HEADLINE. One nested Pool → VDEV → Device hierarchy per
 *                   pool: pool state pill + capacity donut + aggregate live I/O
 *                   + scan indicator; each vdev its own state pill + type +
 *                   aggregated I/O; each device its disk object + live
 *                   throughput + latency. Matches /status pools to /telemetry
 *                   pools by name.
 *   4. ARC        — hit-ratio gauge + size/target + L2.
 *   5. Network    — total rx/tx time chart + per-interface rx/tx numbers.
 * All rendered in the ANAS.gfx visual language (15-gfx.js). Pool, per-vdev and
 * network I/O use labelled gfx.timeChart time-series charts fed by client-side
 * rolling 5-minute buffers; ARC keeps its gauge and per-device rows are live
 * numbers + an activity bar.
 *
 * TELEMETRY LEGIBILITY (operator design review 2026-08-19). Four rules, applied
 * identically to ZFS and AHR because the chart is one shared component:
 *   1. Chart scales come off a 1-2-5 binary ladder and RATCHET — up on any
 *      sample that would clip, never down on their own; the quiet re-fit control
 *      at a chart's right edge is the only way down (see wireChartFit).
 *   2. A pool's ONLY vdev / ONLY band keeps its header row and its member tiles
 *      but drops the readouts and chart that merely repeat the pool block. Per-
 *      member tiles are never collapsed — a failing disk diverges there.
 *   3. Every headline figure LEADS with a labelled ~10s rolling average, because
 *      an instantaneous figure reads "idle" between txg flushes. The charts keep
 *      the raw per-sample line untouched and add a thin average overlay.
 *   4. The unsampled left of a chart is hatched, not left blank (blank canvas on
 *      a zero baseline is indistinguishable from a measured idle), and every
 *      number names its direction (R/W) and its window (avg 10s / peak 5m).
 *
 * Data contract (two endpoints, read as JSON; no compile dependency):
 *   GET /v1/status    → { node, pools[], disks{healthy,warning,critical,unknown,
 *                         total}, shares{}, jobs[{id,kind,status,startedAt?,
 *                         finishedAt?,durationMs?}], warnings[], ahrPools[] }
 *                       loaded on show + manual Refresh. ahrPools[] (11.13) are
 *                       AHR pool briefs { name, state, usableBytes, usedBytes?,
 *                       mountpoint, mounted, subvolLayout, bands[], spares[] } —
 *                       rendered in the Pools section after the ZFS pools, with a
 *                       live I/O strip (11.15) when telemetry is available.
 *   GET /v1/telemetry → { sampledAt, windowMs, arc{}, net{}, pools:[ { name,
 *                         ...ioStats, vdevs:[ { name,type,role,state,...ioStats,
 *                         disks:[ { id, ...ioStats } ] } ] } ],
 *                         ahrPools:[ { name, ...ioStats, bands:[ { band, level,
 *                         ...ioStats, disks:[ { id, ...ioStats } ] } ] } ] }
 *                       POLLED every POLL_MS while the panel is visible.
 *                       ioStats = { readBytesPerSec, writeBytesPerSec, readIops,
 *                       writeIops, readLatencyNs|null, writeLatencyNs|null }.
 *                       ZFS disks nest under vdevs under pools; AHR member disks
 *                       nest under bands under ahrPools — no flat disks[] array.
 *                       AHR latency is await (diskstats' honest limit).
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
 * latency readout 'anas-dash-lat' (pool head, vdev line, device tile);
 * collapsed sole vdev/band 'anas-dash-vdev-solo'.
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

    // Short-window average (operator design review 2026-08-19). An instantaneous
    // figure is a lie on a txg-cadence workload: ZFS flushes in bursts, so a pool
    // genuinely moving hundreds of MiB/s reads "0 B/s · 0 r · 0 w IOPS" in most
    // sample windows. Every headline slot therefore LEADS with a labelled ~10s
    // average taken off the same rolling ring the charts already hold — no new
    // data, no server round trip. peak/avg over the full window stay as they are.
    var SHORT_MS = 10000;
    var SHORT_N = Math.max(2, Math.round(SHORT_MS / POLL_MS));
    var SHORT_LBL = 'avg ' + Math.round((SHORT_N * POLL_MS) / 1000) + 's';
    var WINDOW_LBL = Math.round(BUFFER_MS / 60000) + 'm';

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
                // Warnings as wrap-flow cards sized to their text — many
                // mild "pool is 9x% full" warnings pack into rows instead of
                // stacking full-width banners. Targets both the gfx callout and
                // the plain-HTML fallback (.anas-dash-cb).
                + '.anas-dash-warn-cards{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}'
                + '.anas-dash-warn-cards .anas-gfx-callout,'
                + '.anas-dash-warn-cards .anas-dash-cb'
                + '{display:inline-flex;width:auto;max-width:520px;flex:0 1 auto;box-sizing:border-box}'
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
                // Full device id, never truncated — the dash/underscore-heavy ids
                // wrap (break-all) to a second line so the disambiguating tail is
                // always visible without hover; the tile grows/wraps to fit.
                + '.anas-dash-disk-id{font-size:11px;font-weight:650;color:var(--anas-ink,#232936);'
                + 'word-break:break-all}'
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
                // Literal "VDEV" tag + human descriptor so the tier self-describes.
                + '.anas-dash-vdev-tag{font-size:9px;font-weight:800;letter-spacing:.6px;'
                + 'text-transform:uppercase;padding:1px 5px;border-radius:4px;'
                + 'background:var(--anas-slot,#e6e9ee);color:var(--anas-muted,#6b7280);'
                + 'border:1px solid var(--anas-card-edge,#cfd6df)}'
                + '.anas-dash-vdev-desc{font-size:11px;color:var(--anas-muted,#6b7280)}'
                + '.anas-dash-vdev-type{font-size:10px;text-transform:uppercase;letter-spacing:.5px;'
                + 'color:var(--anas-muted,#6b7280)}'
                + '.anas-dash-vdev-io{margin-left:auto;color:var(--anas-muted,#6b7280);'
                + 'font-variant-numeric:tabular-nums}'
                + '.anas-dash-devs{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}'
                // I/O + latency now/peak/avg readouts (pool head, vdev line, device tiles).
                + '.anas-dash-lat{font-variant-numeric:tabular-nums}'
                + '.anas-dash-vdev-lat{margin-top:4px;font-size:11px}'
                + '.anas-dash-lat-hist{opacity:.85}'
                // Aligned two-row (I/O, then latency) readout at pool/vdev level:
                // a fixed-width label column keeps the R/W values vertically lined
                // up so the eye can scan the windows down the rows.
                + '.anas-dash-io-lat{margin-top:4px}'
                + '.anas-dash-mrow{display:flex;gap:8px;align-items:baseline;'
                + 'font-variant-numeric:tabular-nums}'
                + '.anas-dash-mrow-l{flex:0 0 auto;min-width:54px;font-weight:650;'
                + 'color:var(--anas-muted,#6b7280)}'
                + '.anas-dash-mrow-v{flex:1 1 auto;min-width:0}'
                // Warning card: category icon + bold ref lead so cards scan by target.
                + '.anas-dash-warn-ico{flex:0 0 auto;margin-right:2px;opacity:.85}'
                + '.anas-dash-warn-ref{font-weight:750}'
                // AHR pool block (11.13): the whole block deep-links to the Hybrid
                // RAID view, so it reads as clickable and highlights on hover/focus.
                + '.anas-dash-pool-ahr{cursor:pointer}'
                + '.anas-dash-pool-ahr:hover{border-color:var(--anas-accent,#3468c0)}'
                + '.anas-dash-pool-ahr:focus{outline:2px solid var(--anas-accent,#3468c0);outline-offset:2px}'
                // The hot-spare tier: accent left border to set it apart from bands.
                + '.anas-dash-vdev-spare{border-left-color:var(--anas-accent,#3468c0)}';
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

    // ONE sample per telemetry tick, however many times we render it.
    //
    // The buffers are filled as a side effect of rendering, but a render is not
    // a measurement: the Pools composite is re-rendered by /status, by the manual
    // Refresh and by the re-fit control as well as by the telemetry poll, and
    // each of those would otherwise duplicate the current sample — bending peak,
    // average and the chart's own time axis. `_anasSampleSeq` is bumped once per
    // telemetry tick; a buffer accepts one push per key per seq and returns
    // itself unchanged for any further render at that seq.
    function pushBuf(view, bufKey, seenKey, key, value, cap) {
        var buf = view[bufKey] || (view[bufKey] = {});
        var seen = view[seenKey] || (view[seenKey] = {});
        var arr = buf[key] || (buf[key] = []);
        var seq = view._anasSampleSeq || 0;
        if (seen[key] !== seq || arr.length === 0) {
            seen[key] = seq;
            arr.push(value);
            while (arr.length > cap) {
                arr.shift();
            }
        }
        return arr;
    }

    // Push a sample onto the rolling buffer for `key`, capped at BUFFER_MAX (the
    // 5-minute window), and return the (mutated, oldest→newest) buffer. The
    // buffers feed gfx.timeChart; they live on the view so they reset with the
    // panel and never touch the server (no persisted history — Principle 7).
    function pushSpark(view, key, value) {
        return pushBuf(view, '_anasSpark', '_anasSeenSpark', key, num(value), BUFFER_MAX);
    }

    // The ratchet state gfx.timeChart reads and writes for a chart, keyed by the
    // same string that scopes the chart's sample buffers. It lives on the view,
    // so a held scale survives every re-render but resets when the panel closes —
    // exactly the lifetime the samples themselves have.
    function scaleFor(view, key) {
        var st = view._anasScale || (view._anasScale = {});
        return st[key] || (st[key] = {});
    }

    // Mean of the last `n` usable samples of a rolling buffer (nulls skipped but
    // still occupying their slot, so the window is a true N seconds). null when
    // the tail holds nothing usable — an idle latency window reads "—", never 0.
    function tailAvg(arr, n) {
        if (!arr || !arr.length) { return null; }
        var start = Math.max(0, arr.length - n);
        var sum = 0, count = 0;
        for (var i = start; i < arr.length; i++) {
            var v = arr[i];
            if (v === null || v === undefined || isNaN(Number(v))) { continue; }
            sum += Number(v);
            count++;
        }
        return count > 0 ? sum / count : null;
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
        var n = (value === null || value === undefined || isNaN(Number(value)))
            ? null : Number(value);
        return pushBuf(view, '_anasLat', '_anasSeenLat', key, n, BUFFER_MAX);
    }

    // Peak (max) and average (mean) over the usable samples of a rolling buffer —
    // serves BOTH the latency and the throughput readouts. Only null/undefined/NaN
    // are skipped:
    //   • LATENCY buffers (pushLat) store null for idle windows, so those are
    //     skipped — avg is over windows that actually had I/O, no fake zeros.
    //   • THROUGHPUT buffers (pushSpark) store a real 0 for idle windows, so those
    //     zeros ARE counted — an idle-mostly pool shows a truthfully low average.
    // count === 0 (nothing usable in the window yet) → peak/avg null, so a latency
    // readout shows just the instantaneous value until real samples land.
    function bufStats(arr) {
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

    // "R <read> W <write>" — every number says which direction it is. The old
    // ▼/▲ glyphs were compact and unlabelled, and nothing on screen said which
    // way was which.
    function rw(fmt, r, w) {
        return 'R ' + fmt(r) + ' W ' + fmt(w);
    }

    // One aligned metric row:
    //   "<label>  avg 10s R … W …  ·  peak 5m R … W …  ·  avg 5m R … W …"
    // shared by the I/O (bps) and latency (fmtLat) readouts so the two rows line
    // up. `fmt` formats each value; `sR`/`sW` are the read/write bufStats over the
    // full window; `shR`/`shW` are the short-window averages the row LEADS with
    // (see SHORT_MS — the instantaneous figure it replaces was misreading bursty
    // pools as idle). peak/avg are appended only once `hasHist` (real history in
    // the window); every window is spelled out in the label so no figure is left
    // without its context. `extraCls` carries hooks (e.g. anas-dash-lat).
    function metricRow(label, extraCls, fmt, shR, shW, sR, sW, hasHist, tip) {
        var seg = SHORT_LBL + ' ' + rw(fmt, shR, shW);
        if (hasHist) {
            seg += ' · ' + t('peak') + ' ' + WINDOW_LBL + ' ' + rw(fmt, sR.peak, sW.peak)
                + ' · ' + t('avg') + ' ' + WINDOW_LBL + ' ' + rw(fmt, sR.avg, sW.avg);
        }
        return '<div class="anas-dash-mrow' + (extraCls ? ' ' + extraCls : '') + '"'
            + (tip ? ' title="' + enc(tip) + '"' : '') + '>'
            + '<span class="anas-dash-mrow-l">' + enc(label) + '</span>'
            + '<span class="anas-dash-mrow-v">' + enc(seg) + '</span></div>';
    }

    // The aligned two-row I/O + latency block for a pool head or a vdev line. The
    // I/O read/write history is REUSED from the caller's throughput spark buffers
    // (rBuf/wBuf — the SAME arrays that feed the time chart, already pushed this
    // tick, so no duplicate buffers for series the chart already holds); peak/avg
    // over them INCLUDE idle 0s. Latency pushes its own null-for-idle buffers here
    // keyed by keyBase, and its peak/avg SKIP the idle windows. The latency row
    // keeps the .anas-dash-lat hook; a shared tooltip explains the 5-minute window.
    function ioLatRows(view, keyBase, rBuf, wBuf, latRNs, latWNs) {
        var ioR = bufStats(rBuf), ioW = bufStats(wBuf);
        var ioHist = rBuf.length > 1 || wBuf.length > 1;
        var latRBuf = pushLat(view, keyBase + '.read', latRNs);
        var latWBuf = pushLat(view, keyBase + '.write', latWNs);
        var lr = bufStats(latRBuf), lw = bufStats(latWBuf);
        var latHist = lr.count > 0 || lw.count > 0;
        var tip = t('rolling averages over the last ' + SHORT_MS / 1000
            + ' seconds and ' + BUFFER_MS / 60000 + ' minutes; peak is the '
            + BUFFER_MS / 60000 + '-minute high-water mark');
        return metricRow(t('I/O'), '', bps,
            tailAvg(rBuf, SHORT_N), tailAvg(wBuf, SHORT_N), ioR, ioW, ioHist, tip)
            + metricRow(t('latency'), 'anas-dash-lat', fmtLat,
                tailAvg(latRBuf, SHORT_N), tailAvg(latWBuf, SHORT_N), lr, lw, latHist, tip);
    }

    // A read/write latency pair: "<label> R <read> W <write>". fmtLat renders
    // null as a muted em dash, so idle directions read as "—" not "0".
    function latPair(label, r, w) {
        return label + ' ' + rw(fmtLat, r, w);
    }

    // Compact 3-part latency readout (short avg / peak / window avg, read &
    // write) for an entity, pushing THIS poll's read+write samples onto the
    // entity's rolling buffers first. `keyBase` scopes the buffers (pool by name
    // / vdev by pool+name / disk by id). While no non-null sample has landed in
    // the window yet, only the short average shows (no fake peak/avg zeros). A
    // title tooltip spells out what each window is. `opts.compact`
    // renders the two-muted-line form for the small device tiles; the default is
    // the inline pool/vdev form. Every readout carries the .anas-dash-lat hook.
    function latReadout(view, keyBase, readNs, writeNs, opts) {
        opts = opts || {};
        var rBuf = pushLat(view, keyBase + '.read', readNs);
        var wBuf = pushLat(view, keyBase + '.write', writeNs);
        var rs = bufStats(rBuf), ws = bufStats(wBuf);
        var hasHist = rs.count > 0 || ws.count > 0;
        var now = latPair(t('latency') + ' ' + SHORT_LBL,
            tailAvg(rBuf, SHORT_N), tailAvg(wBuf, SHORT_N));
        var peak = latPair(t('peak') + ' ' + WINDOW_LBL, rs.peak, ws.peak);
        var avg = latPair(t('avg') + ' ' + WINDOW_LBL, rs.avg, ws.avg);
        var tip = t('rolling averages over the last ' + SHORT_MS / 1000
            + ' seconds and ' + BUFFER_MS / 60000 + ' minutes; peak is the '
            + BUFFER_MS / 60000 + '-minute high-water mark');
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

    // The aggregate IOPS readout for a pool / vdev / band. Same treatment as the
    // byte figures: led by the short-window average (the raw counter reads
    // "0 r · 0 w" between txg flushes on a busy pool) and labelled per direction.
    // The IOPS counters are already on the wire — this only rings them so the
    // average has something to average. `keyBase` scopes the ring.
    function iopsLine(view, keyBase, readIops, writeIops) {
        var r = pushSpark(view, keyBase + '.riops', readIops);
        var w = pushSpark(view, keyBase + '.wiops', writeIops);
        return SHORT_LBL + ' R ' + iops(tailAvg(r, SHORT_N))
            + ' · W ' + iops(tailAvg(w, SHORT_N)) + ' IOPS';
    }

    // The read/write throughput lead line for a device tile: the same labelled
    // short-window average the pool and vdev rows lead with, on the same ring
    // that already feeds the tile's peak/avg line.
    function deviceIoLead(rBuf, wBuf) {
        return SHORT_LBL + ' ' + rw(bps, tailAvg(rBuf, SHORT_N), tailAvg(wBuf, SHORT_N));
    }

    // The tile's window peak/avg line — '' until real history has landed.
    function deviceIoHist(rBuf, wBuf) {
        if (!(rBuf.length > 1 || wBuf.length > 1)) { return ''; }
        var sR = bufStats(rBuf), sW = bufStats(wBuf);
        return '<div class="anas-dash-disk-sub anas-dash-lat-hist">'
            + enc(t('peak') + ' ' + WINDOW_LBL + ' ' + rw(bps, sR.peak, sW.peak)
                + ' · ' + t('avg') + ' ' + WINDOW_LBL + ' ' + rw(bps, sR.avg, sW.avg))
            + '</div>';
    }

    // Render a bicolor gfx.timeChart, degrading to a muted note if gfx is absent
    // or the chart fails open (returns ''). Never throws into the caller.
    //
    // `chartOpts(view, key, width, height, title)` builds the shared option set
    // every telemetry chart uses, so ZFS and AHR cannot drift apart: the ratchet
    // state and the re-fit control id both come off the SAME key that scopes the
    // chart's sample buffers, and the average overlay uses the SAME short window
    // the summary rows lead with.
    function chartOpts(view, key, width, height, title) {
        var o = {
            width: width, height: height, windowMs: BUFFER_MS, sampleMs: POLL_MS,
            scale: scaleFor(view, key), fitId: key, avgSamples: SHORT_N
        };
        if (title) { o.title = title; }
        return o;
    }

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

    // Font Awesome glyph (already shipped in PVE) for a warning's category, so a
    // card can be scanned by kind at a glance. Unknown/absent category → no icon
    // (fail-open — the card still renders).
    function warnIcon(category) {
        var map = {
            pool: 'fa-database', capacity: 'fa-database', disk: 'fa-hdd-o',
            scrub: 'fa-refresh', share: 'fa-share-alt', replication: 'fa-retweet',
            ahr: 'fa-server', schedule: 'fa-clock-o',
            // iSCSI (iscsi.5): block storage handed out over the network — a
            // plug, deliberately not the plain disk glyph, so a restore hole
            // does not read as a failing drive.
            iscsi: 'fa-plug'
        };
        var fa = map['' + (category || '')];
        if (!fa) { return ''; }
        return '<i class="fa ' + fa + ' anas-dash-warn-ico" aria-hidden="true"></i>';
    }

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
            // Lead with identity so cards scan by target, not prose: a small
            // category icon, then the ref in bold, then the message. When the
            // message repeats the ref (e.g. "Pool 'p1' is 94% full") we don't
            // de-dup the text — the bold ref up front is what the eye scans.
            var body = warnIcon(w.category);
            if (w.ref) {
                body += '<span class="anas-dash-warn-ref">' + enc('' + w.ref) + '</span> ';
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
            out += callout;
        }
        // Wrap-flow cards, each sized to its text — a dozen "pool is 9x% full"
        // warnings pack into a couple of rows instead of a full-width banner
        // stack (the callouts themselves are styled inline-flex via
        // .anas-dash-warn-cards in ensureDashStyles).
        return '<div class="anas-dash-warn-cards">' + out + '</div>';
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
    // no time chart here (a sparkline earned no axes).
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

    // ---- AHR pools in the headline Pools section (11.13/11.15, §10) ----------
    //
    // AHR pools render alongside ZFS pools (AFTER them) with the SAME structural
    // presence AND the SAME live I/O strip (11.15 — /proc/diskstats parity with
    // the ZFS pool I/O): name + AHR badge + state light, a used/usable capacity
    // donut, a labeled mountpoint, the pool I/O summary + time chart, and the
    // Pool → band → member-disk composite where each band (its md array) and each
    // member carries its own live throughput + latency. Latency is shown as await
    // (the honest diskstats limit). Structure comes from /v1/status ahrPools
    // (fail-open []); live I/O from the name-matched /v1/telemetry ahrPools entry.
    // A pool with no telemetry yet (first sample pending) renders WITHOUT the I/O
    // strip, exactly as it did before — never a fabricated zero. The whole block
    // deep-links to the Hybrid RAID view.

    // AHR pool state → gfx pill severity token (mirrors 39-ahr.js POOL_STATES):
    // busy states (building/expanding/scrubbing) stay NEUTRAL — activity, not
    // fault. 'building' is the first-build window (issue #7), the AHR analog of
    // the ZFS resilver indicator: long-running, expected, and not a failure.
    // 'offline' is red and UPPERCASE (issue #18): the volume cannot be assembled,
    // so the pool serves nothing — it must not look like amber degraded, which
    // reads as reduced-redundancy-but-functioning. The failure card carries WHICH
    // band arrays cannot start.
    var AHR_PILL_TOKEN = {
        healthy: 'ONLINE', building: '', degraded: 'DEGRADED', expanding: '',
        rebuilding: 'DEGRADED', scrubbing: '', offline: 'OFFLINE',
        failed: 'FAULTED', readonly: 'FAULTED'
    };

    // States whose LABEL is not simply the state word (39-ahr.js POOL_STATES
    // carries the same two): 'read-only' hyphenates, and 'offline' shouts —
    // uppercase alongside the red pill, because a lowercase word beside amber
    // was exactly what read as reduced-redundancy-but-functioning (issue #18).
    var AHR_PILL_LABEL = { readonly: 'read-only', offline: 'OFFLINE' };

    function ahrStatePill(state) {
        var token = AHR_PILL_TOKEN.hasOwnProperty(state) ? AHR_PILL_TOKEN[state] : '';
        var label = t(AHR_PILL_LABEL.hasOwnProperty(state) ? AHR_PILL_LABEL[state] : ('' + (state || '')));
        try {
            if (gfx && typeof gfx.statePill === 'function') {
                var html = gfx.statePill(token, { label: label });
                if (html) { return html; }
            }
        } catch (e) {
            // fall through
        }
        return '<span class="anas-dash-muted">' + enc(label) + '</span>';
    }

    // mdadm band level → display label (RAID5 / RAID6 / RAID1).
    function ahrLevelLabel(level) {
        var l = ('' + (level || '')).toLowerCase();
        if (l === 'raid1') { return 'RAID1'; }
        if (l === 'raid5') { return 'RAID5'; }
        if (l === 'raid6') { return 'RAID6'; }
        return level ? ('' + level).toUpperCase() : t('array');
    }

    // A member/spare disk tile: a skeuomorphic disk object + the FULL by-id
    // (never truncated — .anas-dash-disk-id wraps break-all) + a labeled size.
    // When `tmember` (this band member's live diskstats telemetry) is present it
    // ALSO carries the live throughput + await latency, mirroring the ZFS device
    // tile (renderDevice). `spare` shows the grey spare status dot and never gets
    // an I/O readout (a spare carries no band I/O). `keyBase` scopes the rolling
    // buffers per band+disk so the same disk in two bands doesn't collide.
    // Band-array state → gfx pill token + label. Mirrors 39-ahr.js ARRAY_STATES
    // EXACTLY (parallel construction — the two AHR surfaces must not disagree
    // about what a band's state is called or how severe it looks).
    // 'inactive' = the band cannot start (the pool is OFFLINE): red pill, and the
    // label says "CANNOT START" in the same words as the daemon advisory and the
    // failure card. Bands that DID start keep their own honest state beside it.
    var AHR_ARRAY_STATES = {
        clean: { token: 'ONLINE', label: 'clean' },
        degraded: { token: 'DEGRADED', label: 'degraded' },
        resyncing: { token: '', label: 'building' },
        reshaping: { token: '', label: 'reshaping' },
        recovering: { token: 'DEGRADED', label: 'rebuilding' },
        inactive: { token: 'OFFLINE', label: 'CANNOT START' },
        failed: { token: 'FAULTED', label: 'failed' }
    };

    // `poolBuilding` neutral-tones a no-fault build, mirroring 39-ahr.js exactly
    // (see that file for the full reasoning). The discriminator is the POOL
    // state rather than this band's members, and that is the RIGHT test on both
    // surfaces, not a dashboard compromise: "no faulty member" is unsafe
    // because a PULLED disk leaves nothing wrong-looking in members[] at all.
    // A rebuild with the dead disk still attached and flagged `(F)` keeps amber,
    // which is the load-bearing case. KNOWN LIMIT (tested daemon-side): a
    // pulled disk rebuilding across every band is indistinguishable from a
    // fresh build in mdstat and reads neutral.
    function ahrArrayStatePill(state, poolBuilding) {
        if (!state) {
            return ''; // pre-0.2.4 daemon: no band state on the wire, no pill
        }
        var meta = AHR_ARRAY_STATES[state] || { token: '', label: '' + state };
        if (state === 'recovering' && poolBuilding) {
            meta = { token: '', label: 'building' };
        }
        try {
            if (gfx && typeof gfx.statePill === 'function') {
                var html = gfx.statePill(meta.token, { label: t(meta.label) });
                if (html) { return html; }
            }
        } catch (e) {
            // fall through to plain text
        }
        return '<span class="anas-dash-muted">' + enc(t(meta.label)) + '</span>';
    }

    // Sync-action wording, mirroring 39-ahr.js SYNC_LABELS.
    var AHR_SYNC_LABELS = {
        resync: 'building', reshape: 'reshaping', recover: 'rebuilding', check: 'checking'
    };

    function ahrEta(seconds) {
        var sec = num(seconds);
        if (sec <= 0) { return ''; }
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        if (h > 0) { return h + 'h ' + m + 'm'; }
        if (m > 0) { return m + 'm'; }
        return Math.round(sec) + 's';
    }

    // The band's own sync progress (11.19) — percent / speed / ETA on the SAME
    // gfx.activity strip the ZFS pool scan indicator uses, but determinate,
    // because md gives us real progress where ZFS's scan flag does not.
    //
    // This is what makes the numbers around it legible: md-level recovery
    // traffic is INVISIBLE in the band's own I/O counters by definition (the
    // rebuild is the md layer's work, not filesystem I/O through it), so a band
    // reading ~0 while its members each push ~200 MiB/s looks broken until the
    // strip says "rebuilding 1.8%".
    //
    // A band whose sync is QUEUED behind another carries state 'recovering'
    // with NO sync object — that is issue #9's DELAYED semantics, and this
    // read leans on it directly, so the two move together.
    function ahrBandSyncHtml(band) {
        var st = band.state;
        var sync = band.sync;
        if (!sync) {
            if (st === 'recovering') {
                return '<div class="anas-dash-vdev-lat anas-dash-muted">'
                    + enc(t('queued behind another band')) + '</div>';
            }
            return '';
        }
        var pc = num(sync.percent);
        var strip = '';
        try {
            if (gfx && typeof gfx.activity === 'function') {
                strip = gfx.activity(pc > 0 ? pc / 100 : null,
                    { label: t(AHR_SYNC_LABELS[sync.action] || ('' + sync.action)) }) || '';
            }
        } catch (e) {
            strip = '';
        }
        var stats = [pc.toFixed(1) + '%'];
        if (num(sync.speedBytesSec) > 0) { stats.push(bps(sync.speedBytesSec)); }
        var eta = ahrEta(sync.etaSeconds);
        if (eta) { stats.push(t('ETA') + ' ' + eta); }
        return '<div style="margin-top:8px">' + strip
            + '<div class="anas-dash-muted" style="margin-top:3px;font-size:11px;'
            + 'font-variant-numeric:tabular-nums">' + enc(stats.join('  ·  ')) + '</div></div>';
    }

    // `sliceBytes` (11.19): what this disk contributes to THIS band. A 20 TB
    // member of a 7.28 TiB band gave "Size 20.01 TiB" — the disk's whole size,
    // read against a band it dwarfs, which is simply the wrong number for the
    // question the row is answering. When present the tile says "Slice 7.28
    // TiB"; when absent (pre-0.2.4 daemon) it falls back to exactly the old
    // "Size <disk>" line rather than showing nothing.
    function ahrDiskTile(view, id, sizeBytes, spare, tmember, keyBase, sliceBytes) {
        id = '' + (id || 'disk');
        var iconHtml = '';
        try {
            if (gfx && typeof gfx.icon === 'function') {
                iconHtml = gfx.icon('hdd', { state: spare ? 'spare' : 'online', title: id }) || '';
            }
        } catch (e) {
            iconHtml = '';
        }
        var ioHtml = '';
        if (tmember && !spare) {
            // Same rolling peak/avg machinery the ZFS device tile uses (idle 0s
            // count), keyed per band+disk so multi-band disks stay distinct.
            var kb = keyBase || ('ahrdisk.' + id);
            var dr = pushSpark(view, kb + '.read', tmember.readBytesPerSec);
            var dw = pushSpark(view, kb + '.write', tmember.writeBytesPerSec);
            ioHtml = '<div class="anas-dash-disk-sub">' + enc(deviceIoLead(dr, dw)) + '</div>'
                + deviceIoHist(dr, dw)
                + latReadout(view, kb, tmember.readLatencyNs, tmember.writeLatencyNs, { compact: true });
        }
        return '<div class="anas-dash-disk">' + iconHtml
            + '<div style="min-width:0;flex:1 1 auto">'
            + '<div class="anas-dash-disk-id" title="' + enc(id) + '">' + enc(id) + '</div>'
            + '<div class="anas-dash-disk-sub">'
            + enc(sliceBytes != null
                ? t('Slice') + ' ' + ANAS.formatBytes(num(sliceBytes))
                : t('Size') + ' ' + ANAS.formatBytes(num(sizeBytes))) + '</div>'
            + ioHtml
            + '</div></div>';
    }

    // One band row: "BAND · band N — RAID5 × 4" head + the member disk tiles.
    // Reuses the ZFS vdev tier's classes so a band reads visually as a vdev; when
    // `tband` (this band's md-array live telemetry) is present it gains the SAME
    // aggregate IOPS + I/O/latency readout and read/write time chart a ZFS vdev
    // has. `poolName`/`chartW` scope + size those. Members are matched to their
    // telemetry by disk id (each carries its own per-band I/O).
    //
    // `solo` (this pool's ONLY band) collapses the duplicated readouts exactly as
    // a solo ZFS vdev does — the AHR band strip is deliberately the same shape as
    // the vdev strip, so it duplicates the pool block in the same way and gets the
    // same answer (parallel construction). The band's own SYNC strip is never
    // collapsed: a rebuild's progress exists nowhere else on the block, and md
    // recovery traffic is invisible in the pool's I/O counters by definition.
    function renderAhrBand(view, poolName, band, tband, chartW, poolBuilding, solo) {
        band = band || {};
        var n = num(band.band);
        var desc = '— ' + ahrLevelLabel(band.level) + ' × ' + num(band.memberCount);
        // 11.19: the band's height, the same figure the Details view shows, so
        // the two AHR surfaces describe a band identically. Omitted entirely on
        // a pre-0.2.4 daemon rather than guessed.
        if (band.heightBytes != null) {
            desc += ' · ' + t('height') + ' ' + ANAS.formatBytes(num(band.heightBytes));
        }
        var members = band.members || [];

        // Index this band's member telemetry by disk id (per-band partition I/O).
        var tById = {};
        var tdisks = (tband && tband.disks) || [];
        for (var k = 0; k < tdisks.length; k++) {
            if (tdisks[k] && tdisks[k].id != null) { tById['' + tdisks[k].id] = tdisks[k]; }
        }

        var devHtml = '';
        for (var i = 0; i < members.length; i++) {
            var mid = members[i] && members[i].id;
            var tm = (mid != null) ? tById['' + mid] : null;
            var kb = 'ahrdisk.' + poolName + '.b' + n + '.' + mid;
            devHtml += ahrDiskTile(view, mid, members[i] && members[i].sizeBytes, false, tm, kb,
                band.heightBytes);
        }

        // Aggregate band I/O (its md array): an IOPS line in the head + the
        // two-row I/O/latency readout + a compact read/write chart, matching the
        // ZFS vdev tier. Absent (no telemetry yet) → the band renders as before.
        var ioHead = '';
        var ioLatHtml = '';
        var chartHtml = '';
        if (tband && !solo) {
            var vKey = 'ahrband.' + poolName + '.' + n;
            ioHead = '<span class="anas-dash-vdev-io">'
                + enc(iopsLine(view, vKey, tband.readIops, tband.writeIops)) + '</span>';
            var br = pushSpark(view, vKey + '.read', tband.readBytesPerSec);
            var bw = pushSpark(view, vKey + '.write', tband.writeBytesPerSec);
            ioLatHtml = '<div class="anas-dash-vdev-lat anas-dash-muted anas-dash-io-lat">'
                + ioLatRows(view, vKey, br, bw,
                    tband.readLatencyNs, tband.writeLatencyNs) + '</div>';
            chartHtml = '<div class="anas-dash-vdev-chart">' + timeChartHtml(
                [
                    { label: t('Read'), color: READ_COLOR, values: br },
                    { label: t('Write'), color: WRITE_COLOR, values: bw }
                ],
                chartOpts(view, vKey, chartW > 0 ? chartW : 560, 120)
            ) + '</div>';
        }

        return '<div class="anas-dash-vdev' + (solo ? ' anas-dash-vdev-solo' : '') + '">'
            + '<div class="anas-dash-vdev-head">'
            + '<span class="anas-dash-vdev-tag">' + enc(t('BAND')) + '</span>'
            + '<span class="anas-dash-vdev-name">' + enc(t('band') + ' ' + n) + '</span>'
            + '<span class="anas-dash-vdev-desc">' + enc(desc) + '</span>'
            + ahrArrayStatePill(band.state, poolBuilding) + ioHead + '</div>'
            + ahrBandSyncHtml(band)
            + ioLatHtml
            + chartHtml
            + (devHtml ? '<div class="anas-dash-devs">' + devHtml + '</div>' : '')
            + '</div>';
    }

    // The labeled hot-spare bay (§11 idiom, mirroring 39-ahr.js): a distinct
    // tier whose tiles carry the spare status dot. '' when no spare is attached.
    function renderAhrSpareBay(view, spares) {
        spares = spares || [];
        if (!spares.length) { return ''; }
        var devHtml = '';
        for (var i = 0; i < spares.length; i++) {
            devHtml += ahrDiskTile(view, spares[i] && spares[i].id, spares[i] && spares[i].sizeBytes, true, null, null);
        }
        return '<div class="anas-dash-vdev anas-dash-vdev-spare">'
            + '<div class="anas-dash-vdev-head">'
            + '<span class="anas-dash-vdev-tag">' + enc(t('SPARE')) + '</span>'
            + '<span class="anas-dash-vdev-desc">'
            + enc('— ' + t('hot spare — automatic rebuild target on any member failure'))
            + '</span></div>'
            + '<div class="anas-dash-devs">' + devHtml + '</div>'
            + '</div>';
    }

    // One AHR pool block. Matches the ZFS block's visual language (name + state
    // pill + capacity donut) via gfx, adds a small AHR badge, labels the mount,
    // and — when the name-matched telemetry pool `tap` is present (11.15) —
    // carries the SAME aggregate I/O summary + time chart the ZFS block has, plus
    // per-band/per-member live I/O in the composite. Without telemetry yet it
    // renders exactly as before (no strip). `dims` sizes the charts. data-anas-nav
    // deep-links the whole block to the Hybrid RAID view.
    function renderAhrPoolBlock(view, ap, tap, dims) {
        ap = ap || {};
        dims = dims || {};
        var poolW = dims.pool > 0 ? dims.pool : 620;
        var bandW = dims.vdev > 0 ? dims.vdev : 560;
        var name = ap.name || 'pool';
        var usable = num(ap.usableBytes);
        var hasUsed = ap.usedBytes !== undefined && ap.usedBytes !== null && !isNaN(Number(ap.usedBytes));
        var used = hasUsed ? num(ap.usedBytes) : 0;
        var free = Math.max(usable - used, 0);

        // Capacity: a used/free donut when mounted (used is known); an unmounted
        // pool shows usable only — no misleading fill, never a wrong number.
        var capBlock;
        if (hasUsed && usable > 0) {
            var pct = Math.round((used / usable) * 100);
            var donut = '';
            try {
                if (gfx && typeof gfx.donut === 'function') {
                    donut = gfx.donut(
                        [
                            { label: t('Used'), value: used },
                            { label: t('Free'), value: free, free: true }
                        ],
                        { size: 104, center: { big: pct + '%', sm: ANAS.formatBytes(usable) } }
                    ) || '';
                }
            } catch (eD) {
                donut = '';
            }
            if (!donut) {
                donut = fallbackBar(used / usable, pct >= 90 ? BAD_COLOR : (pct >= 75 ? WARN_COLOR : OK_COLOR))
                    + '<div class="anas-dash-muted" style="margin-top:4px">' + enc(pct + '%') + '</div>';
            }
            capBlock = '<div class="anas-dash-pool-cap">' + donut
                + '<div class="anas-dash-muted" style="margin-top:6px">'
                + enc(ANAS.formatBytes(used) + ' / ' + ANAS.formatBytes(usable)) + '</div></div>';
        } else {
            capBlock = '<div class="anas-dash-pool-cap">'
                + '<div class="anas-dash-stat-n" style="color:' + MUTED_COLOR + '">'
                + enc(ANAS.formatBytes(usable)) + '</div>'
                + '<div class="anas-dash-muted" style="margin-top:4px">' + enc(t('Usable')) + '</div></div>';
        }

        var badge = '';
        try {
            if (gfx && typeof gfx.badge === 'function') {
                badge = gfx.badge(t('AHR'), { title: t('ANAS Hybrid RAID') }) || '';
            }
        } catch (eB) {
            badge = '';
        }

        var mountState = ap.mounted ? t('mounted') : t('not mounted');
        var mountHtml = '<div class="anas-dash-muted" style="margin-top:4px">'
            + enc(t('Mount') + ': ' + (ap.mountpoint || '—') + ' (' + mountState + ')') + '</div>';

        // Aggregate pool I/O from the matched telemetry pool (its LV): an IOPS +
        // I/O/latency summary in the head, and a headline read/write time chart —
        // the SAME strip the ZFS block gets. Absent → rendered exactly as before.
        var summaryHtml = '';
        var chartHtml = '';
        if (tap) {
            var pKey = 'ahrpool.' + name;
            var pr = pushSpark(view, pKey + '.read', tap.readBytesPerSec);
            var pw = pushSpark(view, pKey + '.write', tap.writeBytesPerSec);
            summaryHtml = '<div class="anas-dash-muted" style="margin-top:4px">'
                + enc(iopsLine(view, pKey, tap.readIops, tap.writeIops)) + '</div>'
                + '<div class="anas-dash-muted anas-dash-io-lat">'
                + ioLatRows(view, pKey, pr, pw, tap.readLatencyNs, tap.writeLatencyNs)
                + '</div>';
            chartHtml = '<div class="anas-dash-pool-io">' + timeChartHtml(
                [
                    { label: t('Read'), color: READ_COLOR, values: pr },
                    { label: t('Write'), color: WRITE_COLOR, values: pw }
                ],
                chartOpts(view, pKey, poolW, 160, t('Pool I/O'))
            ) + '</div>';
        }

        // Match each band to its telemetry by band index (the md-array I/O).
        var tbandByIndex = {};
        var tbands = (tap && tap.bands) || [];
        for (var b = 0; b < tbands.length; b++) {
            if (tbands[b] && tbands[b].band != null) { tbandByIndex['' + tbands[b].band] = tbands[b]; }
        }

        var bands = ap.bands || [];
        // A lone band IS the pool at the I/O layer — same collapse the solo ZFS
        // vdev gets. Member tiles and the band's sync strip stay in full.
        var soloBand = bands.length === 1;
        var bandHtml = '';
        for (var i = 0; i < bands.length; i++) {
            var bn = bands[i] && bands[i].band;
            var tband = (bn != null) ? tbandByIndex['' + bn] : null;
            bandHtml += renderAhrBand(view, name, bands[i], tband, bandW,
                ap.state === 'building', soloBand);
        }
        bandHtml += renderAhrSpareBay(view, ap.spares);

        return '<div class="anas-dash-pool anas-dash-pool-ahr" data-anas-nav="anas-ahr" '
            + 'role="link" tabindex="0" title="' + enc(t('Open the Hybrid RAID view')) + '">'
            + '<div class="anas-dash-pool-head">'
            + capBlock
            + '<div class="anas-dash-pool-main">'
            + '<div class="anas-dash-pool-name">' + poolGlyph()
            + '<span>' + enc(name) + '</span>' + badge + ahrStatePill(ap.state) + '</div>'
            + mountHtml
            + summaryHtml
            + '</div></div>'
            + chartHtml
            + bandHtml
            + '</div>';
    }

    // Deep-link from a pool block to another ANAS view by selecting its node in
    // the PVE config treelist (the selection drives the card switch AND keeps the
    // menu highlight in sync). Best-effort + fail-open: it finds the treelist
    // whose store actually contains the target node, so it is robust to the
    // ancestor structure; any missing internal → no-op, never a throw.
    function navigateToView(cardItemId) {
        try {
            var trees = (typeof Ext !== 'undefined' && Ext.ComponentQuery)
                ? Ext.ComponentQuery.query('treelist') : [];
            for (var i = 0; i < trees.length; i++) {
                var tree = trees[i];
                var store = tree && tree.getStore ? tree.getStore() : null;
                var rec = store && store.getNodeById ? store.getNodeById(cardItemId) : null;
                if (rec && typeof tree.setSelection === 'function') {
                    tree.setSelection(rec);
                    return true;
                }
            }
        } catch (e) {
            ANAS.warn('dashboard navigate failed: ' + ANAS.errText(e));
        }
        return false;
    }

    // Attach ONE delegated click/Enter handler on the pools section element so
    // any pool block carrying data-anas-nav deep-links. The element persists
    // across setHtml re-renders, so this wires once (guarded on the view).
    function wirePoolNav(view) {
        try {
            if (!view || view._anasNavWired) { return; }
            var cmp = view.down && view.down('#anasDashPools');
            var el = cmp && cmp.getEl ? cmp.getEl() : null;
            if (!el || typeof el.on !== 'function') { return; }
            var go = function (e) {
                try {
                    var tgt = e && e.getTarget ? e.getTarget('[data-anas-nav]') : null;
                    if (!tgt || !tgt.getAttribute) { return; }
                    var dest = tgt.getAttribute('data-anas-nav');
                    if (dest) { navigateToView(dest); }
                } catch (err) {
                    // fail-open — a click must never throw into the PVE UI
                }
            };
            el.on('click', go);
            el.on('keydown', function (e) {
                try {
                    var k = e && (e.getKey ? e.getKey() : e.keyCode);
                    if (k === 13 || k === 32) { go(e); }
                } catch (err) {
                    // fail-open
                }
            });
            view._anasNavWired = true;
        } catch (e) {
            // non-fatal
        }
    }

    // ---- Manual scale re-fit (the chart's quiet right-edge control) ---------
    //
    // gfx.timeChart ratchets a chart's scale UP and never down; the operator
    // drops it here. The control is an SVG <g> inside the chart carrying
    // data-anas-tcfit="<chart key>" — the SAME key that scopes the chart's
    // sample buffers and its ratchet state — so clearing that state and
    // re-rendering the owning section is the whole handler. Re-rendering does
    // NOT re-sample (see pushBuf), so a click cannot bend the history.

    // Walk up from an event target looking for the re-fit control. A manual walk
    // rather than a selector match: these are SVG nodes, where className is not a
    // string and framework selector helpers are unreliable.
    function fitKeyFor(node) {
        var n = node;
        for (var i = 0; i < 8 && n; i++) {
            if (n.getAttribute) {
                var k = n.getAttribute('data-anas-tcfit');
                if (k) { return k; }
            }
            n = n.parentNode;
        }
        return null;
    }

    function refitChart(view, key) {
        var st = view._anasScale && view._anasScale[key];
        if (!st) { return; }
        st.max = 0; // next render fits the window, then the ratchet resumes
        if (key.indexOf('net.') === 0) {
            if (view._anasTelemetry) {
                setSection(view, 'anasDashNet', renderNet(view, view._anasTelemetry));
            }
        } else {
            setSection(view, 'anasDashPools', renderPoolsComposite(view));
        }
    }

    // ONE delegated click/Enter handler on the whole view element, which persists
    // across every setHtml re-render (guarded on the view, wired once).
    function wireChartFit(view) {
        try {
            if (!view || view._anasFitWired) { return; }
            var el = view.getEl ? view.getEl() : null;
            if (!el || typeof el.on !== 'function') { return; }
            var go = function (e) {
                try {
                    var tgt = e && (e.target || (e.getTarget ? e.getTarget() : null));
                    var key = fitKeyFor(tgt);
                    if (key) { refitChart(view, key); }
                } catch (err) {
                    // fail-open — a click must never throw into the PVE UI
                }
            };
            el.on('click', go);
            el.on('keydown', function (e) {
                try {
                    var k = e && (e.getKey ? e.getKey() : e.keyCode);
                    if (k === 13 || k === 32) { go(e); }
                } catch (err) {
                    // fail-open
                }
            });
            view._anasFitWired = true;
        } catch (e) {
            // non-fatal — the chart still renders, it just won't re-fit on click
        }
    }

    // ---- Pool → VDEV → Device composite (the headline) ---------------------
    //
    // ONE nested hierarchy per pool. State/capacity/scan come from /status; live I/O comes
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

        // Device-level I/O: small rolling buffers (same _anasSpark rolling
        // machinery the pool/vdev throughput uses — idle 0s count) keyed by disk
        // id. peak/avg only once real history has landed (>1 sample). A member
        // tile is NEVER collapsed or reduced — a failing disk diverges from its
        // siblings at exactly this layer, so its numbers always stay in full.
        var dr = pushSpark(view, 'disk.' + id + '.read', dev.readBytesPerSec);
        var dw = pushSpark(view, 'disk.' + id + '.write', dev.writeBytesPerSec);

        return '<div class="anas-dash-disk">' + iconHtml
            + '<div style="min-width:0;flex:1 1 auto">'
            + '<div class="anas-dash-disk-id" title="' + enc(id) + '">' + enc(id) + '</div>'
            + '<div class="anas-dash-disk-sub">' + enc(deviceIoLead(dr, dw)) + '</div>'
            + deviceIoHist(dr, dw)
            + latReadout(view, 'disk.' + id, dev.readLatencyNs, dev.writeLatencyNs, { compact: true })
            + '<div style="margin-top:5px">' + barHtml + '</div>'
            + '</div></div>';
    }

    // Human-readable vdev type label from the raw ZFS type token.
    function vdevTypeLabel(type) {
        var ty = ('' + (type || '')).toLowerCase();
        if (ty === 'mirror') { return t('Mirror'); }
        if (ty === 'raidz' || ty === 'raidz1') { return 'RAIDZ1'; }
        if (ty === 'raidz2') { return 'RAIDZ2'; }
        if (ty === 'raidz3') { return 'RAIDZ3'; }
        if (ty.indexOf('draid') === 0) { return 'dRAID' + ty.substring(5); }
        if (ty === 'disk' || ty === 'file') { return t('Single disk'); }
        return type ? ('' + type) : t('vdev');
    }

    // Human role callout for a NON-data vdev role; '' for data / unknown so the
    // common case adds no noise.
    function vdevRoleLabel(role) {
        var r = ('' + (role || '')).toLowerCase();
        if (r === 'log') { return t('Log (SLOG)'); }
        if (r === 'cache') { return t('Cache (L2ARC)'); }
        if (r === 'special') { return t('Special'); }
        if (r === 'dedup') { return t('Dedup'); }
        if (r === 'spare') { return t('Spare'); }
        return '';
    }

    // A vdev group: name + type + its state pill + aggregated IOPS/latency line,
    // its own bicolor read/write time chart, over a device grid. The left border
    // + a *-degraded/-faulted class make a degraded vdev read as degraded even at
    // a glance (colour keyed off gfx.pillLevel). `chartW` is the measured pixel
    // width for its time chart; `poolName` scopes the rolling-buffer keys.
    //
    // SOLO COLLAPSE (`solo` — this is the pool's ONLY vdev). All of the pool's
    // I/O goes through one vdev, so the vdev's IOPS, throughput, latency and
    // chart are the pool block's numbers repeated verbatim a few pixels lower.
    // A solo vdev therefore keeps its header row — name, type, device count,
    // state pill, which are the things the pool block does NOT say — and drops
    // the duplicated readouts and chart entirely. Two or more vdevs and every
    // one of them renders in full, because then they can disagree. The device
    // tiles below are untouched either way.
    function renderVdev(view, vdev, poolName, chartW, solo) {
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
        // Self-describing identity: a literal "VDEV" tag, the vdev name (omitted
        // for a single-disk vdev, whose raw name IS the disk id the device card
        // below already shows), then a human descriptor — role callout (non-data
        // only) · type label · device count — beside the state pill. So a bare
        // single disk reads "VDEV — Single disk · ONLINE", not a naked disk id.
        var keyName = vdev.name || vdev.type || t('vdev');
        var ty = ('' + (vdev.type || '')).toLowerCase();
        var isSingle = ty === 'disk' || ty === 'file';
        var nDev = (vdev.disks || []).length;
        var descParts = [];
        var roleL = vdevRoleLabel(vdev.role);
        if (roleL) { descParts.push(roleL); }
        descParts.push(vdevTypeLabel(vdev.type));
        if (!isSingle) {
            descParts.push(nDev + ' ' + (nDev === 1 ? t('device') : t('devices')));
        }
        var nameHtml = (!isSingle && vdev.name)
            ? '<span class="anas-dash-vdev-name">' + enc('' + vdev.name) + '</span>' : '';
        var identHtml = '<span class="anas-dash-vdev-tag">' + enc(t('VDEV')) + '</span>'
            + nameHtml
            + '<span class="anas-dash-vdev-desc">' + enc('— ' + descParts.join(' · ')) + '</span>';
        var vKey = 'vdev.' + poolName + '.' + keyName;
        var io = '';
        var ioLatHtml = '';
        var chartHtml = '';
        if (!solo) {
            io = '<span class="anas-dash-vdev-io">'
                + enc(iopsLine(view, vKey, vdev.readIops, vdev.writeIops)) + '</span>';

            // Push the throughput spark buffers first, then reuse those SAME arrays
            // for the I/O peak/avg readout and the time chart (no duplicate buffers).
            var vr = pushSpark(view, vKey + '.read', vdev.readBytesPerSec);
            var vw = pushSpark(view, vKey + '.write', vdev.writeBytesPerSec);

            // Aligned I/O + latency for the whole vdev, on its own line under the
            // head (the head carries identity + IOPS; the two-row block keeps
            // bytes-throughput and latency legible without crowding the head).
            ioLatHtml = '<div class="anas-dash-vdev-lat anas-dash-muted anas-dash-io-lat">'
                + ioLatRows(view, vKey, vr, vw,
                    vdev.readLatencyNs, vdev.writeLatencyNs) + '</div>';

            // Per-vdev bicolor read/write time chart (compact — visual hierarchy
            // under the pool chart — but still fully labelled with axes + legend).
            chartHtml = '<div class="anas-dash-vdev-chart">' + timeChartHtml(
                [
                    { label: t('Read'), color: READ_COLOR, values: vr },
                    { label: t('Write'), color: WRITE_COLOR, values: vw }
                ],
                chartOpts(view, vKey, chartW, 120)
            ) + '</div>';
        }

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
        return '<div class="anas-dash-vdev' + (lvl ? ' anas-dash-vdev-' + lvl : '')
            + (solo ? ' anas-dash-vdev-solo' : '') + '">'
            + '<div class="anas-dash-vdev-head">'
            + identHtml + pill + io + '</div>'
            + ioLatHtml
            + chartHtml
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
            // Push the throughput spark buffers FIRST, then reuse the very same
            // arrays for both the I/O peak/avg readout and the time chart below
            // (no duplicate buffers for a series the chart already holds).
            var pKey = 'pool.' + name;
            var pr = pushSpark(view, pKey + '.read', tp.readBytesPerSec);
            var pw = pushSpark(view, pKey + '.write', tp.writeBytesPerSec);
            summaryHtml = '<div class="anas-dash-muted" style="margin-top:4px">'
                + enc(iopsLine(view, pKey, tp.readIops, tp.writeIops)) + '</div>'
                + '<div class="anas-dash-muted anas-dash-io-lat">'
                + ioLatRows(view, pKey, pr, pw, tp.readLatencyNs, tp.writeLatencyNs)
                + '</div>';
            chartHtml = '<div class="anas-dash-pool-io">' + timeChartHtml(
                [
                    { label: t('Read'), color: READ_COLOR, values: pr },
                    { label: t('Write'), color: WRITE_COLOR, values: pw }
                ],
                chartOpts(view, pKey, poolW, 160, t('Pool I/O'))
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
        // A lone vdev IS the pool at the I/O layer — collapse its duplicated
        // readouts (see renderVdev). Its member tiles stay in full.
        var solo = vdevs.length === 1;
        var vdevHtml = '';
        for (var i = 0; i < vdevs.length; i++) {
            vdevHtml += renderVdev(view, vdevs[i], name, vdevW, solo);
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
        // AHR pools ride the SAME headline section (11.13), rendered AFTER the
        // ZFS pools; [] fail-open so a ZFS-only node is visually unchanged.
        var ahrPools = (st && st.ahrPools) || [];
        // AHR live I/O (11.15): name-matched telemetry pools, same as ZFS.
        var ahrTelPools = (tel && tel.ahrPools) || [];

        var telMap = {};
        for (var k = 0; k < telPools.length; k++) {
            if (telPools[k] && telPools[k].name != null) {
                telMap['' + telPools[k].name] = telPools[k];
            }
        }
        var ahrTelMap = {};
        for (var at = 0; at < ahrTelPools.length; at++) {
            if (ahrTelPools[at] && ahrTelPools[at].name != null) {
                ahrTelMap['' + ahrTelPools[at].name] = ahrTelPools[at];
            }
        }

        // Prefer /status pools (they carry capacity/state); fall back to the
        // telemetry pools when status hasn't arrived so the section is never
        // empty on the first telemetry tick.
        var list = statusPools.length ? statusPools : telPools;
        if (!list.length && !ahrPools.length) {
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
        // AHR pool blocks render AFTER the ZFS pools, in the same section, each
        // matched to its live telemetry pool by name (11.15).
        for (var a = 0; a < ahrPools.length; a++) {
            var ap = ahrPools[a] || {};
            var tap = ap.name != null ? ahrTelMap['' + ap.name] : null;
            body += renderAhrPoolBlock(view, ap, tap, dims);
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
                chartOpts(view, 'net.total', netW, 150, t('Total throughput'))
            )
            + '</div>';
        // Per-interface live numeric readout (no chart — the total chart carries
        // the trend; interfaces are a compact rx/tx number pair). RX/TX already
        // name the direction, so the ▼/▲ glyphs that used to lead these lines
        // were saying nothing the words did not.
        var ifs = net.interfaces || [];
        var perIf = '';
        for (var i = 0; i < ifs.length; i++) {
            var f = ifs[i] || {};
            var nm = f.name || ('if' + i);
            perIf += '<div class="anas-dash-card" style="min-width:200px;flex:1 1 220px">'
                + '<div class="anas-dash-card-title"><span>' + enc(nm) + '</span></div>'
                + '<div class="anas-dash-disk-sub">'
                + enc(t('RX') + ' ' + bps(f.rxBytesPerSec)) + '</div>'
                + '<div class="anas-dash-disk-sub">'
                + enc(t('TX') + ' ' + bps(f.txBytesPerSec)) + '</div>'
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
            // AHR pool blocks deep-link to the Hybrid RAID view (11.13) — wire
            // the delegated click handler once the section has an element.
            wirePoolNav(view);
            wireChartFit(view);
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
            // A new measurement — the rolling buffers accept exactly one sample
            // per key at this sequence, however many renders follow (pushBuf).
            view._anasSampleSeq = (view._anasSampleSeq || 0) + 1;
            setSection(view, 'anasDashStatus', statusLine(true, t('just now')));
            setSection(view, 'anasDashArc', renderArc(view, tel));
            // Pool I/O now lives inside the composite — re-render it each tick.
            setSection(view, 'anasDashPools', renderPoolsComposite(view));
            wirePoolNav(view);
            wireChartFit(view);
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
