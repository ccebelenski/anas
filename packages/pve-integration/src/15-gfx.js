/*
 * ANAS — gfx foundation (ANAS.gfx). Epic 15.1.
 *
 * The shared graphical layer for ANAS's storage views: skeuomorphic SVG hardware
 * objects, flat line-icon controls, capacity gauges/bars, the pool-space donut,
 * and a dependency-free pointer-drag toolkit. Ported and cleaned up from three
 * reviewed local spikes (pool-composer, pools-status, datasets-tree). Consumed by
 * the Pool Composer, Pools status, and the enriched Datasets tree so a faulted
 * disk (etc.) looks identical everywhere.
 *
 * DESIGN CONTRACT (DESIGN.md → "ANAS.gfx — graphical visual language"):
 *   - SVG + DOM, never canvas — canvas has no DOM nodes → no test hooks, no CSS
 *     theming, no accessibility.
 *   - THREE visual registers, deliberately separated:
 *       * Content objects  — skeuomorphic *filled* SVG with material gradients
 *                            (disks, pool, folder). Materials are THEME-NEUTRAL
 *                            (a real drive is grey regardless of UI theme).
 *       * Controls         — flat monochrome *line* icons (currentColor → they
 *                            theme). Always-visible with `title` tooltips.
 *       * Data viz         — fullness-coloured gauges/bars + the breakdown donut.
 *   - Chrome tokens INHERIT the PVE light/dark theme (detected below); material
 *     gradients do not.
 *   - FAIL OPEN: injection and every builder is try/catch-guarded. A gfx failure
 *     must never break the PVE UI — worst case a builder returns '' and the
 *     caller renders nothing.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps. Loads
 * after 10-api and before the views (lexical concat order: 15-*).
 *
 * ---------------------------------------------------------------------------
 * TEST HOOKS (stable classes for Playwright / integration):
 *   Content objects
 *     .anas-gfx-icon                 disk object wrapper (hdd/ssd/nvme)
 *     .anas-gfx-icon-<kind>          +hdd | +ssd | +nvme
 *     .anas-gfx-icon-dead            faulted/dead greyscale variant
 *     .anas-gfx-status               health status dot overlay
 *     .anas-gfx-status-<state>       +online|degraded|faulted|resilvering|spare
 *     .anas-gfx-obj                  object line-icon wrapper (pool/folder)
 *     .anas-gfx-obj-pool | -folder   object kind
 *     .anas-gfx-disk                 CONVENTION class for a consumer disk card
 *                                    (gfx does not emit it; views add it so the
 *                                    whole draggable tile is targetable — used by
 *                                    the gfx-check proof + the composer)
 *     .anas-gfx-bay                  CONVENTION class for a vdev drop bay
 *   Controls
 *     .anas-gfx-ctl                  line-icon button
 *     .anas-gfx-ctl-<name>           +add|snapshot|share|lock|props|trash
 *     .anas-gfx-ctl-danger           destructive-styled control
 *   Data viz
 *     .anas-gfx-bar / -bar-fill      inline capacity bar
 *     .anas-gfx-gauge / -gauge-fill  capacity gauge (bar + used/total text)
 *     .anas-gfx-donut                breakdown ring
 *     .anas-gfx-legend / -legend-row donut legend
 *     .anas-gfx-timechart            labelled time-series chart (axes + legend)
 *   Status & labels (monitor side)
 *     .anas-gfx-pill / -pill-<lvl>   pool/vdev state pill (online|degraded|faulted)
 *     .anas-gfx-chip / -chip-good    dataset property chip
 *     .anas-gfx-badge / -badge-<k>   share badge (+smb|nfs)
 *     .anas-gfx-callout / -<lvl>     advisory banner (ok|warn|bad)
 *     .anas-gfx-activity             scrub/resilver progress strip
 *     .anas-gfx-bay-box              read-only vdev bay wrapper
 *     .anas-gfx-baygroup             role-group wrapper (label + flex row of bays)
 *     .anas-gfx-diskcard             read-only disk tile (+ .anas-gfx-disk)
 *   Drag
 *     .anas-gfx-ghost                the floating drag ghost (width-locked)
 *     .anas-gfx-dragging             source element while its ghost is aloft
 *     .anas-gfx-drophover            a drop zone currently under the pointer
 * ---------------------------------------------------------------------------
 *
 * THEME INHERITANCE — detectDark() reads, in order: the PVE `PVEThemeCookie`
 * (values containing "dark"/"light"; "auto"/absent falls through), then a
 * proxmox-theme-* class on <html>/<body>, then prefers-color-scheme. The result
 * stamps `data-anas-theme` on <html>; the injected <style> keys dark tokens off
 * both that attribute AND @media (prefers-color-scheme: dark), so gfx follows
 * PVE even if detection can't run. refreshTheme() re-detects on demand.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') {
        return;
    }
    var ANAS = window.ANAS || (window.ANAS = {});

    var gfx = {};

    // ---- small helpers -----------------------------------------------------

    function warn(msg) {
        try {
            if (ANAS && typeof ANAS.warn === 'function') {
                ANAS.warn('gfx: ' + msg);
            } else if (typeof console !== 'undefined' && console.warn) {
                console.warn('[ANAS] gfx: ' + msg);
            }
        } catch (e) {
            // stay silent rather than break the page
        }
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function clampFrac(f) {
        f = Number(f);
        if (isNaN(f)) { return 0; }
        if (f < 0) { return 0; }
        if (f > 1) { return 1; }
        return f;
    }

    // Fullness colour thresholds (shared across gauge/bar): >=90% danger,
    // >=75% warn, else ok. Returned as a themeable CSS var.
    function fillColorVar(frac) {
        if (frac >= 0.9) { return 'var(--anas-danger)'; }
        if (frac >= 0.75) { return 'var(--anas-warn)'; }
        return 'var(--anas-ok)';
    }

    function fillBackground(colorVar) {
        // Glossy fill: solid colour fading to a lighter tint (spike look).
        return 'linear-gradient(90deg,' + colorVar
            + ',color-mix(in srgb,' + colorVar + ' 60%,#fff))';
    }

    // Default themeable series colours for donut segments (cycled).
    var SERIES = [
        'var(--anas-series-1)', 'var(--anas-series-2)', 'var(--anas-series-3)',
        'var(--anas-series-4)', 'var(--anas-series-5)',
    ];
    var FREE_COLOR = 'var(--anas-free)';

    // ======================================================================
    // ONE-TIME INJECTION: shared <defs> gradients + scoped <style> tokens.
    // ======================================================================

    var DEFS_ID = 'anas-gfx-defs';
    var STYLE_ID = 'anas-gfx-style';

    // Material gradients (theme-neutral). IDs are prefixed `anasM*` so they never
    // collide with PVE's own SVG defs; the icon builders reference them by url().
    function defsSvg() {
        return ''
            + '<svg id="' + DEFS_ID + '" width="0" height="0" '
            + 'style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>'
            + '<linearGradient id="anasMBody" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#cdd6df"/><stop offset=".5" stop-color="#a9b4c0"/>'
            + '<stop offset="1" stop-color="#8896a5"/></linearGradient>'
            + '<radialGradient id="anasMPlatter" cx=".38" cy=".32" r=".8">'
            + '<stop offset="0" stop-color="#f4f7fa"/><stop offset=".55" stop-color="#c3cdd8"/>'
            + '<stop offset="1" stop-color="#8e9bab"/></radialGradient>'
            + '<linearGradient id="anasMLabel" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#fbfcfe"/><stop offset="1" stop-color="#dde3ea"/></linearGradient>'
            + '<linearGradient id="anasMPcb" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#1c8f6f"/><stop offset="1" stop-color="#0f6b52"/></linearGradient>'
            + '<linearGradient id="anasMGold" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#ffe6a0"/><stop offset="1" stop-color="#c99a2e"/></linearGradient>'
            + '<linearGradient id="anasMChip" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#3a4048"/><stop offset="1" stop-color="#22262c"/></linearGradient>'
            + '<linearGradient id="anasMDead" x1="0" y1="0" x2="0" y2="1">'
            + '<stop offset="0" stop-color="#c9b3b0"/><stop offset="1" stop-color="#9a8582"/></linearGradient>'
            + '</defs></svg>';
    }

    // Scoped stylesheet: palette tokens (light default + dark override) plus the
    // component styles for every gfx surface. All selectors are `.anas-gfx-*`
    // scoped and all custom properties are `--anas-*` prefixed, so nothing here
    // can clobber PVE's own CSS.
    function styleCss() {
        var lightTokens =
            '--anas-panel:#fff;--anas-panel-edge:#d3d8de;--anas-ink:#232936;--anas-muted:#6b7280;'
            + '--anas-line:#dfe3e8;--anas-accent:#3468c0;--anas-accent-soft:#dce9fd;'
            + '--anas-ok:#1f9c56;--anas-warn:#b06a12;--anas-danger:#c23b2c;'
            + '--anas-card-top:#fff;--anas-card-bot:#eef1f5;--anas-card-edge:#cfd6df;--anas-card-hi:rgba(255,255,255,.9);'
            + '--anas-bay:#dfe4ea;--anas-bay-in:#cbd2db;--anas-bay-lip:#fff;--anas-slot:#f2f4f7;'
            + '--anas-shadow:0 1px 1px rgba(20,30,50,.10),0 6px 16px rgba(20,30,50,.10);'
            + '--anas-lift:0 14px 30px rgba(20,30,50,.30);'
            + '--anas-series-1:#3468c0;--anas-series-2:#7a3fb0;--anas-series-3:#147d68;'
            + '--anas-series-4:#b06a12;--anas-series-5:#2f6f8f;--anas-free:#c2c9d2;';
        var darkTokens =
            '--anas-panel:#191d24;--anas-panel-edge:#0a0d11;--anas-ink:#e7eaf0;--anas-muted:#9aa4b2;'
            + '--anas-line:#2a313b;--anas-accent:#5b8def;--anas-accent-soft:#1f2c44;'
            + '--anas-ok:#3ecf7f;--anas-warn:#e0a54a;--anas-danger:#e5715f;'
            + '--anas-card-top:#2a313b;--anas-card-bot:#20262e;--anas-card-edge:#10141a;--anas-card-hi:rgba(255,255,255,.06);'
            + '--anas-bay:#14181e;--anas-bay-in:#0d1116;--anas-bay-lip:rgba(255,255,255,.05);--anas-slot:#1c222a;'
            + '--anas-shadow:0 1px 1px rgba(0,0,0,.5),0 8px 20px rgba(0,0,0,.45);'
            + '--anas-lift:0 16px 34px rgba(0,0,0,.6);'
            + '--anas-series-1:#5b8def;--anas-series-2:#b393e6;--anas-series-3:#45c3a5;'
            + '--anas-series-4:#e0a54a;--anas-series-5:#6fb0cf;--anas-free:#3a424d;';

        var css = [];
        // Tokens. Light on :root; dark keyed off explicit attribute AND the media
        // query (media guarded to not fight an explicit light choice).
        css.push(':root{' + lightTokens + '}');
        css.push(':root[data-anas-theme="dark"]{' + darkTokens + '}');
        css.push('@media (prefers-color-scheme: dark){:root:not([data-anas-theme="light"]){' + darkTokens + '}}');

        // Content object: disk icon + status overlay.
        css.push('.anas-gfx-icon{position:relative;display:inline-flex;flex:0 0 auto;line-height:0}');
        css.push('.anas-gfx-icon.anas-gfx-icon-dead{filter:grayscale(.5);opacity:.85}');
        css.push('.anas-gfx-status{position:absolute;right:-3px;bottom:-3px;width:13px;height:13px;'
            + 'border-radius:50%;border:2px solid var(--anas-panel);display:flex;align-items:center;'
            + 'justify-content:center;font-size:8px;line-height:1;color:#fff;font-weight:900;box-sizing:border-box}');
        css.push('.anas-gfx-status-online{background:var(--anas-ok)}');
        css.push('.anas-gfx-status-degraded,.anas-gfx-status-resilvering{background:var(--anas-warn)}');
        css.push('.anas-gfx-status-faulted{background:var(--anas-danger)}');
        css.push('.anas-gfx-status-spare{background:var(--anas-muted)}');

        // Object line icons (pool/folder).
        css.push('.anas-gfx-obj{display:inline-flex;flex:0 0 auto;color:var(--anas-muted);line-height:0}');
        css.push('.anas-gfx-obj-pool{color:var(--anas-accent)}');
        css.push('.anas-gfx-obj-folder{color:color-mix(in srgb,var(--anas-accent) 70%,var(--anas-ink))}');
        css.push('.anas-gfx-obj svg{width:17px;height:17px;fill:none;stroke:currentColor;'
            + 'stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}');

        // Controls: flat line-icon buttons (currentColor → themeable).
        css.push('.anas-gfx-ctl{display:inline-flex;align-items:center;justify-content:center;'
            + 'width:26px;height:24px;padding:0;color:var(--anas-muted);background:transparent;'
            + 'border:1px solid transparent;border-radius:7px;cursor:pointer;box-sizing:border-box}');
        css.push('.anas-gfx-ctl:hover{color:var(--anas-accent);background:var(--anas-slot);border-color:var(--anas-card-edge)}');
        css.push('.anas-gfx-ctl.anas-gfx-ctl-danger:hover{color:var(--anas-danger)}');
        css.push('.anas-gfx-ctl svg{width:15px;height:15px;fill:none;stroke:currentColor;'
            + 'stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}');

        // Data viz: inline bar.
        css.push('.anas-gfx-bar{display:inline-flex;align-items:center;gap:8px;width:100%}');
        css.push('.anas-gfx-bar-track{flex:1;height:9px;border-radius:999px;background:var(--anas-slot);'
            + 'border:1px solid var(--anas-card-edge);box-shadow:inset 0 1px 2px rgba(0,0,0,.16);overflow:hidden}');
        css.push('.anas-gfx-bar-fill{display:block;height:100%;border-radius:999px}');
        css.push('.anas-gfx-bar-pct{width:34px;text-align:right;font-size:11px;color:var(--anas-muted);'
            + 'font-variant-numeric:tabular-nums}');

        // Data viz: capacity gauge (bar + used/total + pct).
        css.push('.anas-gfx-gauge{display:inline-block;width:100%;max-width:320px}');
        css.push('.anas-gfx-gauge-track{display:block;height:12px;border-radius:999px;background:var(--anas-slot);'
            + 'border:1px solid var(--anas-card-edge);box-shadow:inset 0 1px 3px rgba(0,0,0,.18);overflow:hidden}');
        css.push('.anas-gfx-gauge-fill{display:block;height:100%;border-radius:999px}');
        css.push('.anas-gfx-gauge-text{font-size:11px;color:var(--anas-muted);margin-top:3px;'
            + 'display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}');

        // Data viz: donut + legend.
        css.push('.anas-gfx-donut{position:relative;display:inline-flex;flex:0 0 auto}');
        css.push('.anas-gfx-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;'
            + 'align-items:center;justify-content:center;text-align:center}');
        css.push('.anas-gfx-donut-big{font-weight:750;font-size:15px;color:var(--anas-ink)}');
        css.push('.anas-gfx-donut-sm{color:var(--anas-muted);font-size:10.5px}');
        css.push('.anas-gfx-legend{display:flex;flex-direction:column;gap:6px}');
        css.push('.anas-gfx-legend-row{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--anas-ink)}');
        css.push('.anas-gfx-legend-sw{width:11px;height:11px;border-radius:3px;flex:0 0 auto}');
        css.push('.anas-gfx-legend-nm{flex:1}');
        css.push('.anas-gfx-legend-sz{color:var(--anas-muted);font-variant-numeric:tabular-nums}');
        css.push('.anas-gfx-legend-pct{width:42px;text-align:right;font-weight:650;font-variant-numeric:tabular-nums}');

        // Data viz: labelled time-series chart (axes + gridlines + legend/readout).
        css.push('.anas-gfx-timechart{display:block;max-width:100%}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-frame{fill:var(--anas-slot);stroke:var(--anas-card-edge);stroke-width:1}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-grid{stroke:var(--anas-line);stroke-width:1;shape-rendering:crispEdges}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-base{stroke:var(--anas-card-edge);stroke-width:1;shape-rendering:crispEdges}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-tick{stroke:var(--anas-card-edge);stroke-width:1;shape-rendering:crispEdges}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-ylab,.anas-gfx-timechart .anas-gfx-tc-xlab{'
            + 'fill:var(--anas-muted);font-size:9.5px;font-variant-numeric:tabular-nums}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-title{fill:var(--anas-muted);font-size:10.5px;font-weight:700}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-legend{fill:var(--anas-ink);font-size:11px;font-variant-numeric:tabular-nums}');
        css.push('.anas-gfx-timechart .anas-gfx-tc-empty{fill:var(--anas-muted);font-size:11px}');

        // Status pill: pool/vdev state chip with a coloured dot (monitor side).
        css.push('.anas-gfx-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;'
            + 'font-weight:800;letter-spacing:.4px;text-transform:uppercase;padding:3px 10px;'
            + 'border-radius:999px;border:1px solid var(--anas-line);color:var(--anas-muted)}');
        css.push('.anas-gfx-pill-dot{width:8px;height:8px;border-radius:50%;background:var(--anas-muted)}');
        css.push('.anas-gfx-pill-online{color:var(--anas-ok);border-color:color-mix(in srgb,var(--anas-ok) 45%,var(--anas-line))}');
        css.push('.anas-gfx-pill-online .anas-gfx-pill-dot{background:var(--anas-ok)}');
        css.push('.anas-gfx-pill-degraded{color:var(--anas-warn);border-color:color-mix(in srgb,var(--anas-warn) 45%,var(--anas-line))}');
        css.push('.anas-gfx-pill-degraded .anas-gfx-pill-dot{background:var(--anas-warn)}');
        css.push('.anas-gfx-pill-faulted{color:var(--anas-danger);border-color:color-mix(in srgb,var(--anas-danger) 45%,var(--anas-line))}');
        css.push('.anas-gfx-pill-faulted .anas-gfx-pill-dot{background:var(--anas-danger)}');

        // Property chip (dataset props) + share badge (SMB/NFS).
        css.push('.anas-gfx-chip{display:inline-flex;align-items:center;font-size:10px;padding:1px 7px;'
            + 'border-radius:999px;border:1px solid var(--anas-card-edge);color:var(--anas-muted);'
            + 'background:var(--anas-slot);white-space:nowrap}');
        css.push('.anas-gfx-chip-good{color:var(--anas-ok);border-color:color-mix(in srgb,var(--anas-ok) 45%,var(--anas-line))}');
        css.push('.anas-gfx-badge{display:inline-flex;align-items:center;font-size:9.5px;font-weight:800;'
            + 'color:#fff;padding:1px 6px;border-radius:999px;background:var(--anas-accent)}');
        css.push('.anas-gfx-badge-smb{background:var(--anas-series-1)}');
        css.push('.anas-gfx-badge-nfs{background:var(--anas-series-2)}');

        // Advisory callout (reuses the composer advisor rule-engine output).
        css.push('.anas-gfx-callout{display:flex;gap:8px;align-items:flex-start;font-size:12px;'
            + 'padding:9px 11px;border-radius:10px;box-shadow:inset 0 1px 0 var(--anas-card-hi)}');
        css.push('.anas-gfx-callout b{font-weight:750}');
        css.push('.anas-gfx-callout-ok{background:color-mix(in srgb,var(--anas-ok) 11%,transparent);color:var(--anas-ok)}');
        css.push('.anas-gfx-callout-warn{background:color-mix(in srgb,var(--anas-warn) 13%,transparent);color:var(--anas-warn)}');
        css.push('.anas-gfx-callout-bad{background:color-mix(in srgb,var(--anas-danger) 14%,transparent);color:var(--anas-danger)}');

        // Activity strip: animated indeterminate/progress bar (scrub/resilver).
        css.push('.anas-gfx-activity{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;'
            + 'background:color-mix(in srgb,var(--anas-accent) 8%,transparent);'
            + 'border:1px solid color-mix(in srgb,var(--anas-accent) 25%,var(--anas-line))}');
        css.push('.anas-gfx-activity-lbl{font-weight:700;color:var(--anas-ink)}');
        css.push('.anas-gfx-activity-bar{flex:1;height:8px;border-radius:999px;background:var(--anas-slot);'
            + 'overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.2)}');
        css.push('.anas-gfx-activity-fill{display:block;height:100%;background-size:24px 100%;'
            + 'background-image:linear-gradient(90deg,var(--anas-accent),color-mix(in srgb,var(--anas-accent) 55%,#fff));'
            + 'animation:anas-gfx-stripe 1s linear infinite}');
        css.push('.anas-gfx-activity-pct{font-size:11px;color:var(--anas-muted);font-variant-numeric:tabular-nums}');
        css.push('@keyframes anas-gfx-stripe{to{background-position:24px 0}}');

        // Read-only vdev bay (the monitor-side counterpart of the composer bay).
        css.push('.anas-gfx-bay-box{display:inline-flex;flex-direction:column;gap:8px;border-radius:11px;'
            + 'background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16),inset 0 -1px 0 var(--anas-bay-lip);padding:10px}');
        css.push('.anas-gfx-bay-box-lbl{font-size:10.5px;color:var(--anas-muted);font-weight:700}');
        css.push('.anas-gfx-bay-box-disks{display:flex;gap:8px;flex-wrap:wrap}');

        // Role-group wrapper: an uppercase role label above a flex row of bays
        // (the pool topology's per-role container).
        css.push('.anas-gfx-baygroup{margin-bottom:12px}');
        css.push('.anas-gfx-baygroup-lbl{font-size:10px;font-weight:800;text-transform:uppercase;'
            + 'letter-spacing:.5px;color:var(--anas-muted);margin:0 0 7px}');
        css.push('.anas-gfx-baygroup-bays{display:flex;flex-wrap:wrap;gap:10px}');

        // Disk tile: skeuomorphic disk object + id/size text (status view).
        css.push('.anas-gfx-diskcard{display:inline-flex;align-items:center;gap:8px;padding:6px 8px;'
            + 'border-radius:9px;background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'border:1px solid var(--anas-card-edge);box-shadow:var(--anas-shadow),inset 0 1px 0 var(--anas-card-hi);'
            + 'max-width:174px;box-sizing:border-box}');
        css.push('.anas-gfx-diskcard-faulted{border-color:color-mix(in srgb,var(--anas-danger) 55%,var(--anas-card-edge));'
            + 'box-shadow:0 0 0 1px var(--anas-danger) inset,var(--anas-shadow)}');
        css.push('.anas-gfx-diskcard-id{font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
        css.push('.anas-gfx-diskcard-sub{font-size:10px;color:var(--anas-muted)}');

        // Drag: the floating ghost (width locked in JS → no resize-on-lift) and
        // the source/zone highlight states.
        css.push('.anas-gfx-ghost{position:fixed;z-index:99999;pointer-events:none;margin:0;'
            + 'box-shadow:var(--anas-lift);transform:rotate(-2.5deg);opacity:.96}');
        css.push('.anas-gfx-dragging{opacity:.22}');
        css.push('.anas-gfx-drophover{outline:2px dashed var(--anas-accent);outline-offset:2px;'
            + 'background:var(--anas-accent-soft)}');

        return css.join('\n');
    }

    // Detect whether the PVE UI is in a dark theme. See file header for order.
    function detectDark() {
        try {
            var m = document.cookie
                && document.cookie.match(/(?:^|;\s*)PVEThemeCookie=([^;]+)/);
            if (m && m[1]) {
                var v = decodeURIComponent(m[1]).toLowerCase();
                if (v.indexOf('dark') !== -1) { return true; }
                if (v.indexOf('light') !== -1 || v === 'crisp') { return false; }
                // 'auto' / unknown → fall through to further signals.
            }
        } catch (e) {
            // cookie unreadable — fall through
        }
        try {
            var cls = (document.documentElement.className || '') + ' '
                + (document.body ? document.body.className : '');
            if (/proxmox-theme-dark/i.test(cls)) { return true; }
            if (/proxmox-theme-light/i.test(cls)) { return false; }
        } catch (e2) {
            // fall through
        }
        try {
            if (window.matchMedia) {
                return window.matchMedia('(prefers-color-scheme: dark)').matches;
            }
        } catch (e3) {
            // fall through
        }
        return false;
    }

    function applyTheme() {
        try {
            var dark = detectDark();
            document.documentElement.setAttribute('data-anas-theme', dark ? 'dark' : 'light');
        } catch (e) {
            // non-fatal — the media query still handles the common case
        }
    }

    var injected = false;
    function ensureInjected() {
        if (injected) { return; }
        try {
            var head = document.head || document.getElementsByTagName('head')[0]
                || document.documentElement;
            var host = document.body || document.documentElement;
            if (!document.getElementById(STYLE_ID) && head) {
                var style = document.createElement('style');
                style.id = STYLE_ID;
                style.type = 'text/css';
                style.appendChild(document.createTextNode(styleCss()));
                head.appendChild(style);
            }
            if (!document.getElementById(DEFS_ID) && host) {
                var holder = document.createElement('div');
                holder.innerHTML = defsSvg();
                var svg = holder.firstChild;
                if (svg) { host.appendChild(svg); }
            }
            applyTheme();
            // Follow OS theme flips while the panel is open (no-op when the PVE
            // cookie forces a theme — detectDark re-reads it each time).
            try {
                if (window.matchMedia) {
                    var mq = window.matchMedia('(prefers-color-scheme: dark)');
                    if (mq.addEventListener) {
                        mq.addEventListener('change', applyTheme);
                    } else if (mq.addListener) {
                        mq.addListener(applyTheme);
                    }
                }
            } catch (eMq) {
                // media listener optional
            }
            injected = true;
        } catch (e) {
            warn('injection failed: ' + (e && e.message));
        }
    }

    // Re-detect the theme on demand (e.g. after a view learns the PVE theme
    // changed). Idempotent and cheap.
    gfx.refreshTheme = function () {
        applyTheme();
    };

    // ======================================================================
    // CONTENT OBJECTS — skeuomorphic disk icons + object line icons.
    // ======================================================================

    function screws(pts) {
        var out = '';
        for (var i = 0; i < pts.length; i++) {
            var x = pts[i][0], y = pts[i][1];
            out += '<circle cx="' + x + '" cy="' + y + '" r="1.9" fill="#5c6875"/>'
                + '<circle cx="' + x + '" cy="' + (y - 0.5) + '" r="1" fill="#dfe5ec" opacity=".7"/>';
        }
        return out;
    }

    function wrapSvg(w, h, scale, inner) {
        return '<svg width="' + (w * scale) + '" height="' + (h * scale) + '" '
            + 'viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' + inner + '</svg>';
    }

    // Raw skeuomorphic SVG for a drive body. dead → the corroded/grey material.
    function diskSvg(kind, dead, scale) {
        var body = dead ? 'url(#anasMDead)' : 'url(#anasMBody)';
        if (kind === 'nvme') {
            // NVMe has no metal chassis to recolour; the .anas-gfx-icon-dead
            // greyscale filter on the wrapper carries the dead state.
            return wrapSvg(58, 34, scale,
                '<rect x="10" y="7" width="44" height="20" rx="2.5" fill="url(#anasMPcb)" stroke="#0b5540" stroke-width="1"/>'
                + '<rect x="10.6" y="7.6" width="43" height="5" rx="2" fill="#ffffff" opacity=".12"/>'
                + '<rect x="14" y="11" width="15" height="12" rx="1.5" fill="url(#anasMChip)"/>'
                + '<rect x="31" y="12" width="9" height="10" rx="1" fill="#0c4e3b"/>'
                + '<g fill="url(#anasMGold)">'
                + '<rect x="46" y="8" width="2.4" height="7"/><rect x="49.5" y="8" width="2.4" height="7"/>'
                + '<rect x="46" y="19" width="2.4" height="7"/><rect x="49.5" y="19" width="2.4" height="7"/></g>'
                + '<rect x="45" y="15" width="8" height="4" fill="url(#anasMPcb)"/>');
        }
        if (kind === 'ssd') {
            return wrapSvg(46, 40, scale,
                '<rect x="6" y="5" width="34" height="30" rx="4" fill="' + body + '" stroke="#7c8a99" stroke-width="1"/>'
                + '<rect x="6.6" y="5.6" width="32.8" height="6" rx="3" fill="#ffffff" opacity=".35"/>'
                + '<rect x="10" y="12" width="26" height="18" rx="2.5" fill="url(#anasMLabel)" stroke="#c3ccd6" stroke-width=".8"/>'
                + '<g stroke="#aab4c0" stroke-width="1">'
                + '<line x1="13" y1="17" x2="29" y2="17"/><line x1="13" y1="21" x2="33" y2="21"/>'
                + '<line x1="13" y1="25" x2="24" y2="25"/></g>'
                + screws([[9, 8], [37, 8], [9, 32], [37, 32]]));
        }
        // HDD — 3.5" top view: chassis, mirror platter, spindle, actuator arm.
        var platter = dead ? '#b9a6a3' : 'url(#anasMPlatter)';
        return wrapSvg(48, 42, scale,
            '<rect x="5" y="4" width="38" height="34" rx="4.5" fill="' + body + '" stroke="#71808f" stroke-width="1"/>'
            + '<rect x="5.6" y="4.6" width="36.8" height="6" rx="3" fill="#ffffff" opacity=".4"/>'
            + '<circle cx="22" cy="22" r="13" fill="' + platter + '" stroke="#8b98a6" stroke-width="1"/>'
            + '<circle cx="22" cy="22" r="8.5" fill="none" stroke="#ffffff" stroke-width=".8" opacity=".5"/>'
            + '<circle cx="22" cy="22" r="3.4" fill="#5a6673"/><circle cx="22" cy="22" r="1.3" fill="#e9eef3"/>'
            + '<path d="M38 9 L25 19" stroke="#4a5561" stroke-width="2.6" stroke-linecap="round"/>'
            + '<circle cx="38" cy="9" r="2.4" fill="#66717d" stroke="#3f4854" stroke-width=".8"/>'
            + screws([[9, 8], [39, 8], [9, 34], [39, 34]]));
    }

    // Health status dot glyphs per state.
    var STATUS = {
        online: '✓',       // check
        degraded: '!',
        faulted: '✗',      // cross
        resilvering: '⟳',  // circular arrow
        spare: 'S',
    };

    function kindLabel(k) {
        return k === 'nvme' ? 'NVMe' : k === 'ssd' ? 'SSD' : 'HDD';
    }

    // icon(kind, opts) → skeuomorphic disk object SVG string.
    //   kind : 'hdd' | 'ssd' | 'nvme'
    //   opts : { state:'online'|'degraded'|'faulted'|'resilvering'|'spare',
    //            dead:bool, scale:Number (default 0.82), title:String }
    // A `state` renders the corner status dot; 'faulted' (or dead:true) applies
    // the greyscale/dead material treatment. Returns a positioned wrapper span so
    // the status overlay is self-contained.
    gfx.icon = function (kind, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            kind = (kind === 'ssd' || kind === 'nvme') ? kind : 'hdd';
            var state = opts.state;
            var dead = opts.dead === true || state === 'faulted';
            var scale = (typeof opts.scale === 'number' && opts.scale > 0) ? opts.scale : 0.82;

            var cls = 'anas-gfx-icon anas-gfx-icon-' + kind + (dead ? ' anas-gfx-icon-dead' : '');
            var title = opts.title || (state ? kindLabel(kind) + ' — ' + state : '');
            var dot = '';
            if (state && STATUS.hasOwnProperty(state)) {
                dot = '<span class="anas-gfx-status anas-gfx-status-' + state + '">'
                    + STATUS[state] + '</span>';
            }
            return '<span class="' + cls + '"'
                + (title ? ' title="' + enc(title) + '"' : '') + '>'
                + diskSvg(kind, dead, scale) + dot + '</span>';
        } catch (e) {
            warn('icon failed: ' + (e && e.message));
            return '';
        }
    };

    gfx.kindLabel = kindLabel;

    // Object line icons (pool = stacked layers; folder = open/closed).
    var OBJ_ICONS = {
        pool: '<path d="M12 3l8 4-8 4-8-4 8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16.5l8 4 8-4"/>',
        folderOpen: '<path d="M4 8V6a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v1"/>'
            + '<path d="M3.3 10h17.4l-1.8 8.2a1 1 0 0 1-1 .8H6.1a1 1 0 0 1-1-.8z"/>',
        folderClosed: '<path d="M4 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
    };

    // objectIcon(kind, opts) → line-icon object span.
    //   kind : 'pool' | 'folder'
    //   opts : { open:bool (folder), title:String }
    gfx.objectIcon = function (kind, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var path, objCls;
            if (kind === 'pool') {
                path = OBJ_ICONS.pool;
                objCls = 'anas-gfx-obj anas-gfx-obj-pool';
            } else {
                path = opts.open ? OBJ_ICONS.folderOpen : OBJ_ICONS.folderClosed;
                objCls = 'anas-gfx-obj anas-gfx-obj-folder';
            }
            return '<span class="' + objCls + '"'
                + (opts.title ? ' title="' + enc(opts.title) + '"' : '') + '>'
                + '<svg viewBox="0 0 24 24">' + path + '</svg></span>';
        } catch (e) {
            warn('objectIcon failed: ' + (e && e.message));
            return '';
        }
    };

    // ======================================================================
    // CONTROLS — flat monochrome line-icon buttons.
    // ======================================================================

    var CTL_ICONS = {
        add: '<path d="M12 6v12M6 12h12"/>',
        snapshot: '<rect x="4" y="7" width="16" height="12" rx="2"/><path d="M8 7l1.5-2h5L16 7"/>'
            + '<circle cx="12" cy="13" r="3"/>',
        share: '<circle cx="6" cy="12" r="2.3"/><circle cx="17" cy="6" r="2.3"/>'
            + '<circle cx="17" cy="18" r="2.3"/><path d="M8 11l7-4M8 13l7 4"/>',
        lock: '<rect x="5" y="10.5" width="14" height="8.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
        props: '<path d="M4 8h8M18 8h2"/><circle cx="15" cy="8" r="2.2"/>'
            + '<path d="M4 16h2M12 16h8"/><circle cx="9" cy="16" r="2.2"/>',
        trash: '<path d="M5 7h14M9 7V5.5h6V7M6.5 7l1 12.5h9L17.5 7"/>',
        // Two circular sync arrows — send/receive replication (Epic 5.5).
        replicate: '<path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3M21 3v5h-5"/>'
            + '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3M3 21v-5h5"/>',
    };
    // Convenience aliases so callers can use either vocabulary.
    var CTL_ALIAS = { snap: 'snapshot', properties: 'props', permissions: 'lock', delete: 'trash' };

    // ctl(name, label, opts) → a flat line-icon <button>.
    //   name  : add | snapshot | share | lock | props | trash (aliases accepted)
    //   label : tooltip text (also its accessible title)
    //   opts  : { danger:bool } → destructive hover styling (typically 'trash')
    // Always-visible with a `title` tooltip (no hover-reveal, per the datasets v2
    // spike). The button carries a `data-anas-ctl` attribute so handlers can be
    // delegated by name.
    gfx.ctl = function (name, label, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var key = CTL_ALIAS[name] || name;
            var path = CTL_ICONS[key];
            if (!path) {
                warn('unknown control "' + name + '"');
                return '';
            }
            var cls = 'anas-gfx-ctl anas-gfx-ctl-' + key + (opts.danger ? ' anas-gfx-ctl-danger' : '');
            var tip = label || key;
            return '<button type="button" class="' + cls + '" data-anas-ctl="' + enc(key) + '"'
                + ' title="' + enc(tip) + '" aria-label="' + enc(tip) + '">'
                + '<svg viewBox="0 0 24 24">' + path + '</svg></button>';
        } catch (e) {
            warn('ctl failed: ' + (e && e.message));
            return '';
        }
    };

    // ======================================================================
    // DATA VIZ — capacity bar / gauge and the breakdown donut.
    // ======================================================================

    // bar(frac, opts) → a slim inline capacity bar (fullness-coloured).
    //   frac : 0..1 fullness
    //   opts : { pct:bool show a trailing % label (default true), color:cssVar
    //            override, title:String }
    gfx.bar = function (frac, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var f = clampFrac(frac);
            var pct = Math.round(f * 100);
            var col = opts.color || fillColorVar(f);
            var showPct = opts.pct !== false;
            var title = opts.title ? ' title="' + enc(opts.title) + '"' : '';
            return '<span class="anas-gfx-bar"' + title + '>'
                + '<span class="anas-gfx-bar-track">'
                + '<span class="anas-gfx-bar-fill" style="width:' + pct + '%;background:'
                + fillBackground(col) + '"></span></span>'
                + (showPct ? '<span class="anas-gfx-bar-pct">' + pct + '%</span>' : '')
                + '</span>';
        } catch (e) {
            warn('bar failed: ' + (e && e.message));
            return '';
        }
    };

    // gauge(frac, opts) → a capacity gauge: bar + a used/total + % caption.
    //   frac : 0..1 fullness
    //   opts : { label:String left caption (else nothing), pct:bool show %
    //            (default true), color:cssVar override, title:String }
    // Callers typically build the label from ANAS.formatBytes(used)/total.
    gfx.gauge = function (frac, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var f = clampFrac(frac);
            var pct = Math.round(f * 100);
            var col = opts.color || fillColorVar(f);
            var title = opts.title ? ' title="' + enc(opts.title) + '"' : '';
            var caption = '';
            if (opts.label || opts.pct !== false) {
                caption = '<span class="anas-gfx-gauge-text">'
                    + '<span>' + (opts.label ? enc(opts.label) : '') + '</span>'
                    + '<span>' + (opts.pct !== false ? pct + '%' : '') + '</span></span>';
            }
            return '<span class="anas-gfx-gauge"' + title + '>'
                + '<span class="anas-gfx-gauge-track">'
                + '<span class="anas-gfx-gauge-fill" style="width:' + pct + '%;background:'
                + fillBackground(col) + '"></span></span>'
                + caption + '</span>';
        } catch (e) {
            warn('gauge failed: ' + (e && e.message));
            return '';
        }
    };

    function segColor(seg, i) {
        if (seg && seg.color) { return seg.color; }
        if (seg && seg.free) { return FREE_COLOR; }
        return SERIES[i % SERIES.length];
    }

    function segTotal(segments, opts) {
        if (opts && typeof opts.total === 'number' && opts.total > 0) { return opts.total; }
        var sum = 0;
        for (var i = 0; i < segments.length; i++) {
            sum += Number(segments[i].value) || 0;
        }
        return sum > 0 ? sum : 1;
    }

    // donut(segments, opts) → an SVG breakdown ring (stroke-dasharray arcs).
    //   segments : [{ label, value, color?, free? }]  (free:true → the --anas-free
    //              tint; otherwise a series colour is auto-assigned)
    //   opts     : { total:Number (default = sum), size:px (default 150),
    //                center:{ big:String, sm:String } optional centre caption }
    // Pair with legend() for the swatch list.
    gfx.donut = function (segments, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            segments = segments || [];
            var total = segTotal(segments, opts);
            var size = (typeof opts.size === 'number' && opts.size > 0) ? opts.size : 150;
            var r = 15.9;
            var C = 2 * Math.PI * r;
            var off = 0;
            var arcs = '';
            for (var i = 0; i < segments.length; i++) {
                var val = Number(segments[i].value) || 0;
                var len = (val / total) * C;
                arcs += '<circle cx="21" cy="21" r="' + r + '" fill="none" '
                    + 'stroke="' + segColor(segments[i], i) + '" stroke-width="7" '
                    + 'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" '
                    + 'stroke-dashoffset="' + (-off).toFixed(2) + '"/>';
                off += len;
            }
            var center = '';
            if (opts.center) {
                center = '<span class="anas-gfx-donut-center">'
                    + (opts.center.big ? '<span class="anas-gfx-donut-big">' + enc(opts.center.big) + '</span>' : '')
                    + (opts.center.sm ? '<span class="anas-gfx-donut-sm">' + enc(opts.center.sm) + '</span>' : '')
                    + '</span>';
            }
            return '<span class="anas-gfx-donut">'
                + '<svg width="' + size + '" height="' + size + '" viewBox="0 0 42 42" '
                + 'style="transform:rotate(-90deg)" aria-hidden="true">' + arcs + '</svg>'
                + center + '</span>';
        } catch (e) {
            warn('donut failed: ' + (e && e.message));
            return '';
        }
    };

    // legend(segments, opts) → the donut's swatch/name/size/% list.
    //   opts : { total:Number (default = sum), format:function(value)->String
    //            for the size column (default: raw value) }
    gfx.legend = function (segments, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            segments = segments || [];
            var total = segTotal(segments, opts);
            var fmt = (typeof opts.format === 'function') ? opts.format : function (v) { return '' + v; };
            var rows = '';
            for (var i = 0; i < segments.length; i++) {
                var seg = segments[i];
                var val = Number(seg.value) || 0;
                var pct = Math.round((val / total) * 100);
                rows += '<div class="anas-gfx-legend-row">'
                    + '<span class="anas-gfx-legend-sw" style="background:' + segColor(seg, i) + '"></span>'
                    + '<span class="anas-gfx-legend-nm">' + enc(seg.label || '') + '</span>'
                    + '<span class="anas-gfx-legend-sz">' + enc(fmt(val)) + '</span>'
                    + '<span class="anas-gfx-legend-pct">' + pct + '%</span></div>';
            }
            return '<div class="anas-gfx-legend">' + rows + '</div>';
        } catch (e) {
            warn('legend failed: ' + (e && e.message));
            return '';
        }
    };

    // Round a positive value UP to a "nice" 1/2/5 × 10ⁿ boundary so the chart's
    // top gridline is a readable round number (e.g. 118 MB/s → 200 MB/s).
    function niceCeil(v) {
        v = Number(v);
        if (!(v > 0)) { return 1; }
        var exp = Math.floor(Math.log(v) / Math.LN10);
        var base = Math.pow(10, exp);
        var f = v / base; // 1 .. <10
        var nice;
        if (f <= 1) { nice = 1; }
        else if (f <= 2) { nice = 2; }
        else if (f <= 5) { nice = 5; }
        else { nice = 10; }
        return nice * base;
    }

    function tcColor(i) {
        return SERIES[i % SERIES.length];
    }

    // Latest (newest) finite value of a series' values array, or null.
    function latestVal(values) {
        if (!values) { return null; }
        for (var i = values.length - 1; i >= 0; i--) {
            var v = Number(values[i]);
            if (!isNaN(v)) { return v; }
        }
        return null;
    }

    // timeChart(series, opts) → a compact-but-readable labelled time-series SVG.
    //   series : [{ label, color?, values:[oldest..newest] }]  values may be
    //            SHORTER than the window (right-aligned: newest at the right edge).
    //   opts   : { width:px (REQUIRED — caller measures the container),
    //              height:px (default 150), windowMs (default 5min),
    //              sampleMs (default 2500), max:Number (fixed; else nice-auto),
    //              minMax:Number (floor for the auto max so an idle chart still
    //              has a scale; default 1), format:fn(v)->str (Y labels + readout;
    //              default ANAS.formatBytes(v)+'/s'), title:String }
    // Renders: 0 / mid / nice-max Y gridlines with labels; a time X axis spanning
    // windowMs with ~1-minute ticks (now, 1m, 2m…); each series as a 2px polyline
    // over a faint filled area; a legend + latest-value readout per series.
    // Fail-open: <2 total points → framed empty axes + muted "collecting…"; any
    // throw → ''. Test hook: .anas-gfx-timechart.
    gfx.timeChart = function (series, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            series = series || [];

            var W = Math.round(Number(opts.width) || 0);
            var H = Math.round(Number(opts.height) || 150);
            if (!(W > 0)) { return ''; }
            if (!(H > 40)) { H = 40; }

            var fmt = (typeof opts.format === 'function')
                ? opts.format
                : function (v) {
                    return (ANAS.formatBytes ? ANAS.formatBytes(v) : ('' + Math.round(v))) + '/s';
                };
            var windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : 5 * 60 * 1000;
            var sampleMs = Number(opts.sampleMs) > 0 ? Number(opts.sampleMs) : 2500;
            var slots = Math.max(2, Math.round(windowMs / sampleMs));

            // Plot geometry — margins reserved for the labels.
            var ML = 52, MR = 12, MT = 20, MB = 18;
            var plotW = W - ML - MR;
            var plotH = H - MT - MB;
            if (plotW < 12) { plotW = 12; }
            if (plotH < 12) { plotH = 12; }
            var x0 = ML;                    // left edge of plot
            var xR = ML + plotW;            // right edge (newest sample)
            var yTop = MT;                  // top of plot (= max)
            var yBase = MT + plotH;         // baseline (= 0)

            // Value scale: nice-rounded max across all series (or fixed opts.max),
            // floored so an idle chart still has a readable scale.
            var peak = 0, totalPts = 0, si, vi;
            for (si = 0; si < series.length; si++) {
                var vals = (series[si] && series[si].values) || [];
                for (vi = 0; vi < vals.length; vi++) {
                    var pv = Number(vals[vi]);
                    if (!isNaN(pv)) {
                        totalPts++;
                        if (pv > peak) { peak = pv; }
                    }
                }
            }
            var floor = Number(opts.minMax) > 0 ? Number(opts.minMax) : 1;
            var vmax;
            if (Number(opts.max) > 0) {
                vmax = Number(opts.max);
            } else {
                vmax = niceCeil(peak > floor ? peak : floor);
            }
            if (!(vmax > 0)) { vmax = 1; }
            var vmid = vmax / 2;

            function yFor(v) {
                v = Number(v);
                if (isNaN(v) || v < 0) { v = 0; }
                if (v > vmax) { v = vmax; }
                return yBase - (v / vmax) * plotH;
            }

            var parts = [];
            parts.push('<svg class="anas-gfx-timechart" width="' + W + '" height="' + H + '" '
                + 'viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">');
            // Plot background frame.
            parts.push('<rect class="anas-gfx-tc-frame" x="' + x0 + '" y="' + yTop
                + '" width="' + plotW + '" height="' + plotH + '" rx="3"/>');

            // Horizontal gridlines + Y labels at 0 / mid / max.
            var yLines = [[vmax, yTop], [vmid, (yTop + yBase) / 2], [0, yBase]];
            for (var g = 0; g < yLines.length; g++) {
                var gy = yLines[g][1];
                var cls = (yLines[g][0] === 0) ? 'anas-gfx-tc-base' : 'anas-gfx-tc-grid';
                parts.push('<line class="' + cls + '" x1="' + x0 + '" y1="' + gy.toFixed(1)
                    + '" x2="' + xR + '" y2="' + gy.toFixed(1) + '"/>');
                parts.push('<text class="anas-gfx-tc-ylab" x="' + (x0 - 6) + '" y="'
                    + (gy + 3).toFixed(1) + '" text-anchor="end">' + enc(fmt(yLines[g][0])) + '</text>');
            }

            // Time X axis: ticks + labels at ~1-minute intervals (now, 1m, 2m…).
            var stepMs = 60000;
            for (var mMs = 0; mMs <= windowMs + 1; mMs += stepMs) {
                var tx = xR - (mMs / windowMs) * plotW;
                if (tx < x0 - 0.5) { break; }
                parts.push('<line class="anas-gfx-tc-tick" x1="' + tx.toFixed(1) + '" y1="'
                    + yBase + '" x2="' + tx.toFixed(1) + '" y2="' + (yBase + 4) + '"/>');
                var lbl = (mMs === 0) ? 'now' : (Math.round(mMs / 60000) + 'm');
                var anchor = (mMs === 0) ? 'end' : 'middle';
                parts.push('<text class="anas-gfx-tc-xlab" x="' + tx.toFixed(1) + '" y="'
                    + (yBase + 13) + '" text-anchor="' + anchor + '">' + enc(lbl) + '</text>');
            }

            if (totalPts < 2) {
                // Empty state — framed axes already drawn; add a muted note.
                parts.push('<text class="anas-gfx-tc-empty" x="' + ((x0 + xR) / 2).toFixed(1)
                    + '" y="' + ((yTop + yBase) / 2 + 4).toFixed(1) + '" text-anchor="middle">'
                    + enc('collecting…') + '</text>');
            } else {
                var spacing = plotW / (slots - 1);
                for (si = 0; si < series.length; si++) {
                    var s = series[si] || {};
                    var v2 = s.values || [];
                    var col = s.color || tcColor(si);
                    // Right-align: plot at most `slots` newest points.
                    var start = Math.max(0, v2.length - slots);
                    var pts = [];
                    for (vi = start; vi < v2.length; vi++) {
                        var nv = Number(v2[vi]);
                        if (isNaN(nv)) { continue; }
                        var px = xR - (v2.length - 1 - vi) * spacing;
                        if (px < x0) { px = x0; }
                        pts.push(px.toFixed(1) + ',' + yFor(nv).toFixed(1));
                    }
                    if (pts.length < 1) { continue; }
                    if (pts.length >= 2) {
                        var first = pts[0].split(',')[0];
                        var last = pts[pts.length - 1].split(',')[0];
                        parts.push('<path d="M' + first + ',' + yBase.toFixed(1) + ' L'
                            + pts.join(' L') + ' L' + last + ',' + yBase.toFixed(1) + ' Z" '
                            + 'fill="' + col + '" fill-opacity="0.12" stroke="none"/>');
                        parts.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="'
                            + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
                    } else {
                        var pc = pts[0].split(',');
                        parts.push('<circle cx="' + pc[0] + '" cy="' + pc[1] + '" r="2" fill="' + col + '"/>');
                    }
                }
            }

            // Title (top-left) + legend/readout (top-right, latest value per series).
            if (opts.title) {
                parts.push('<text class="anas-gfx-tc-title" x="2" y="13">' + enc(opts.title) + '</text>');
            }
            var charW = 6.3, swGap = 13, entryGap = 14;
            var entries = [];
            var totalW = 0;
            for (si = 0; si < series.length; si++) {
                var se = series[si] || {};
                var lv = latestVal(se.values);
                var txt = (se.label ? se.label + ' ' : '') + (lv == null ? '—' : fmt(lv));
                var wEst = swGap + txt.length * charW + entryGap;
                entries.push({ color: se.color || tcColor(si), text: txt, w: wEst });
                totalW += wEst;
            }
            var lx = xR - totalW;
            var titleMin = opts.title ? (2 + ('' + opts.title).length * charW + 8) : x0;
            if (lx < titleMin) { lx = titleMin; }
            for (si = 0; si < entries.length; si++) {
                var e = entries[si];
                parts.push('<rect x="' + lx.toFixed(1) + '" y="5" width="9" height="9" rx="2" fill="'
                    + e.color + '"/>');
                parts.push('<text class="anas-gfx-tc-legend" x="' + (lx + swGap).toFixed(1)
                    + '" y="13">' + enc(e.text) + '</text>');
                lx += e.w;
            }

            parts.push('</svg>');
            return parts.join('');
        } catch (e) {
            warn('timeChart failed: ' + (e && e.message));
            return '';
        }
    };

    // ======================================================================
    // STATUS & LABELS — the monitor-side vocabulary that pairs with the
    // composer's editing objects: state pills, property chips, share badges,
    // advisory callouts, activity strips, read-only vdev bays and disk tiles.
    // ======================================================================

    // Map a raw ZFS state string to one of the three pill severities (or '').
    function pillLevel(state) {
        var s = ('' + (state || '')).toUpperCase();
        if (s === 'ONLINE' || s === 'AVAIL' || s === 'INUSE') { return 'online'; }
        if (s === 'DEGRADED' || s === 'REMOVED' || s === 'RESILVERING') { return 'degraded'; }
        if (s === 'FAULTED' || s === 'OFFLINE' || s === 'UNAVAIL' || s === 'SUSPENDED') { return 'faulted'; }
        return '';
    }
    gfx.pillLevel = pillLevel;

    // statePill(state, opts) → a pool/vdev state pill (coloured dot + label).
    //   opts : { label:String override text, title:String }
    gfx.statePill = function (state, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var lvl = pillLevel(state);
            var cls = 'anas-gfx-pill' + (lvl ? ' anas-gfx-pill-' + lvl : '');
            var text = opts.label != null ? opts.label : ('' + (state || ''));
            var title = opts.title ? ' title="' + enc(opts.title) + '"' : '';
            return '<span class="' + cls + '"' + title + '>'
                + '<span class="anas-gfx-pill-dot"></span>' + enc(text) + '</span>';
        } catch (e) {
            warn('statePill failed: ' + (e && e.message));
            return '';
        }
    };

    // chip(text, opts) → a small property chip (compression, recordsize, …).
    //   opts : { good:bool positive-highlight, title:String }
    gfx.chip = function (text, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var cls = 'anas-gfx-chip' + (opts.good ? ' anas-gfx-chip-good' : '');
            var title = opts.title ? ' title="' + enc(opts.title) + '"' : '';
            return '<span class="' + cls + '"' + title + '>' + enc(text) + '</span>';
        } catch (e) {
            warn('chip failed: ' + (e && e.message));
            return '';
        }
    };

    // badge(text, opts) → a filled share badge (SMB/NFS).
    //   opts : { kind:'smb'|'nfs', title:String }
    gfx.badge = function (text, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var kind = (opts.kind === 'smb' || opts.kind === 'nfs') ? opts.kind : '';
            var cls = 'anas-gfx-badge' + (kind ? ' anas-gfx-badge-' + kind : '');
            var title = opts.title ? ' title="' + enc(opts.title) + '"' : '';
            return '<span class="' + cls + '"' + title + '>' + enc(text) + '</span>';
        } catch (e) {
            warn('badge failed: ' + (e && e.message));
            return '';
        }
    };

    // callout(html, opts) → an advisory banner (advisor output / health note).
    //   opts : { level:'ok'|'warn'|'bad' (default 'ok'), icon:String glyph }
    // `html` is inserted verbatim — callers pass gfx-built / already-encoded
    // markup (e.g. the advisor's <b>…</b> emphasis), never raw user text.
    gfx.callout = function (html, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var lvl = (opts.level === 'warn' || opts.level === 'bad') ? opts.level : 'ok';
            var glyph = opts.icon || (lvl === 'bad' ? '⛔' : lvl === 'warn' ? '⚠' : '✓');
            return '<div class="anas-gfx-callout anas-gfx-callout-' + lvl + '">'
                + '<span aria-hidden="true">' + glyph + '</span>'
                + '<span>' + (html == null ? '' : html) + '</span></div>';
        } catch (e) {
            warn('callout failed: ' + (e && e.message));
            return '';
        }
    };

    // activity(frac, opts) → an animated progress strip (scrub / resilver).
    //   frac : 0..1 progress (null/undefined → indeterminate: full striped bar)
    //   opts : { label:String left caption, pct:bool show % (default true when
    //            determinate) }
    gfx.activity = function (frac, opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var determinate = frac != null && !isNaN(Number(frac));
            var f = determinate ? clampFrac(frac) : 1;
            var pct = Math.round(f * 100);
            var showPct = determinate && opts.pct !== false;
            return '<div class="anas-gfx-activity">'
                + (opts.label ? '<span class="anas-gfx-activity-lbl">' + enc(opts.label) + '</span>' : '')
                + '<span class="anas-gfx-activity-bar"><span class="anas-gfx-activity-fill" '
                + 'style="width:' + pct + '%"></span></span>'
                + (showPct ? '<span class="anas-gfx-activity-pct">' + pct + '%</span>' : '')
                + '</div>';
        } catch (e) {
            warn('activity failed: ' + (e && e.message));
            return '';
        }
    };

    // bay(label, innerHtml, opts) → a read-only vdev bay (label + a flex row of
    // disk tiles). The monitor-side counterpart of the composer's drop bay.
    // `innerHtml` is inserted verbatim (gfx-built tiles).
    gfx.bay = function (label, innerHtml) {
        try {
            ensureInjected();
            return '<div class="anas-gfx-bay-box">'
                + (label ? '<span class="anas-gfx-bay-box-lbl">' + enc(label) + '</span>' : '')
                + '<div class="anas-gfx-bay-box-disks">' + (innerHtml == null ? '' : innerHtml) + '</div></div>';
        } catch (e) {
            warn('bay failed: ' + (e && e.message));
            return '';
        }
    };

    // bayGroup(label, baysHtml) → a labelled role-group container: an uppercase
    // label above a flex-wrapping row of vdev bays. The topology's per-role
    // wrapper (data / log / cache / spare / special / dedup). `baysHtml` is
    // inserted verbatim (caller-built gfx.bay outputs, optionally wrapped).
    gfx.bayGroup = function (label, baysHtml) {
        try {
            ensureInjected();
            return '<div class="anas-gfx-baygroup">'
                + (label ? '<div class="anas-gfx-baygroup-lbl">' + enc(label) + '</div>' : '')
                + '<div class="anas-gfx-baygroup-bays">'
                + (baysHtml == null ? '' : baysHtml) + '</div></div>';
        } catch (e) {
            warn('bayGroup failed: ' + (e && e.message));
            return '';
        }
    };

    // diskCard(opts) → a skeuomorphic disk tile (object icon + id + size), the
    // read-only cousin of the composer's draggable disk. Carries the CONVENTION
    // class .anas-gfx-disk so the whole tile is targetable.
    //   opts : { kind:'hdd'|'ssd'|'nvme', state:<health>, id:String top line,
    //            sub:String bottom line (e.g. size), title:String }
    gfx.diskCard = function (opts) {
        try {
            ensureInjected();
            opts = opts || {};
            var dead = opts.state === 'faulted';
            var cls = 'anas-gfx-diskcard anas-gfx-disk' + (dead ? ' anas-gfx-diskcard-faulted' : '');
            var title = opts.title || (opts.id ? opts.id + (opts.state ? ' — ' + opts.state : '') : '');
            return '<span class="' + cls + '"' + (title ? ' title="' + enc(title) + '"' : '') + '>'
                + gfx.icon(opts.kind, { state: opts.state })
                + '<span style="display:inline-flex;flex-direction:column;min-width:0">'
                + (opts.id != null ? '<span class="anas-gfx-diskcard-id">' + enc(opts.id) + '</span>' : '')
                + (opts.sub != null ? '<span class="anas-gfx-diskcard-sub">' + enc(opts.sub) + '</span>' : '')
                + '</span></span>';
        } catch (e) {
            warn('diskCard failed: ' + (e && e.message));
            return '';
        }
    };

    // ======================================================================
    // DRAG — dependency-free pointer-events drag + dropzone helper.
    // ======================================================================

    // drag(el, opts) → make `el` draggable onto dropzones. Generalised from the
    // composer spike: pointerdown clones a ghost whose WIDTH is locked to the
    // source rect (no resize-on-lift), the ghost follows the pointer, dropzones
    // are hit-tested with elementFromPoint (ghost temporarily hidden so it never
    // tests itself), the hovered zone is highlighted, and pointerup fires onDrop.
    //   opts:
    //     getId(el)     -> stable id for the dragged element (default:
    //                      el.getAttribute('data-id'))
    //     zoneSelector  CSS selector identifying a drop zone (default
    //                      '[data-anas-zone]')
    //     onDrop(id, zoneEl)  dropped onto a zone (zoneEl is the matched zone)
    //     onHover(zoneEl|null) hovered zone changed (null when leaving all zones)
    // Native Pointer Events, no library. Returns a detach() function that removes
    // the pointerdown listener.
    gfx.drag = function (el, opts) {
        opts = opts || {};
        if (!el || typeof el.addEventListener !== 'function') {
            return function () {};
        }
        var zoneSelector = opts.zoneSelector || '[data-anas-zone]';

        function getId(node) {
            if (typeof opts.getId === 'function') { return opts.getId(node); }
            return node.getAttribute ? node.getAttribute('data-id') : null;
        }

        function startDrag(e) {
            try {
                // Left button / primary pointer only.
                if (typeof e.button === 'number' && e.button !== 0) { return; }
                var source = el;
                var id = getId(source);
                e.preventDefault();

                var rect = source.getBoundingClientRect();
                var ghost = source.cloneNode(true);
                ghost.classList.add('anas-gfx-ghost');
                // Lock the width to the source — the ghost must not resize on lift.
                ghost.style.width = rect.width + 'px';
                ghost.style.left = rect.left + 'px';
                ghost.style.top = rect.top + 'px';
                document.body.appendChild(ghost);
                source.classList.add('anas-gfx-dragging');

                var st = {
                    ghost: ghost,
                    dx: e.clientX - rect.left,
                    dy: e.clientY - rect.top,
                    zone: null,
                };

                function zoneAt(x, y) {
                    ghost.style.visibility = 'hidden';
                    var target = document.elementFromPoint(x, y);
                    ghost.style.visibility = '';
                    if (!target || !target.closest) { return null; }
                    return target.closest(zoneSelector);
                }

                function onMove(ev) {
                    ghost.style.left = (ev.clientX - st.dx) + 'px';
                    ghost.style.top = (ev.clientY - st.dy) + 'px';
                    var z = zoneAt(ev.clientX, ev.clientY);
                    if (z !== st.zone) {
                        if (st.zone) { st.zone.classList.remove('anas-gfx-drophover'); }
                        if (z) { z.classList.add('anas-gfx-drophover'); }
                        st.zone = z;
                        if (typeof opts.onHover === 'function') { opts.onHover(z); }
                    }
                }

                function cleanup() {
                    window.removeEventListener('pointermove', onMove);
                    if (st.zone) { st.zone.classList.remove('anas-gfx-drophover'); }
                    if (ghost.parentNode) { ghost.parentNode.removeChild(ghost); }
                    source.classList.remove('anas-gfx-dragging');
                }

                function onUp() {
                    var z = st.zone;
                    cleanup();
                    if (z && typeof opts.onDrop === 'function') {
                        try {
                            opts.onDrop(id, z);
                        } catch (dropErr) {
                            warn('onDrop threw: ' + (dropErr && dropErr.message));
                        }
                    }
                }

                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp, { once: true });
                // Safety net: if the pointer is cancelled, tear down without a drop.
                window.addEventListener('pointercancel', function () {
                    window.removeEventListener('pointermove', onMove);
                    cleanup();
                }, { once: true });
            } catch (err) {
                warn('drag start failed: ' + (err && err.message));
            }
        }

        el.addEventListener('pointerdown', startDrag);
        return function detach() {
            try {
                el.removeEventListener('pointerdown', startDrag);
            } catch (e) {
                // ignore
            }
        };
    };

    // ---- publish + prime injection ----------------------------------------

    gfx.fillColorVar = fillColorVar; // exposed so views can colour-match custom bits

    // Capability check: gfx is present AND its core builders are wired up.
    // Views gate their gfx retrofit on this and degrade to plain rendering.
    gfx.ready = function () {
        return !!(gfx && typeof gfx.icon === 'function'
            && typeof gfx.drag === 'function');
    };

    ANAS.gfx = gfx;

    // Inject eagerly at load (guarded); every builder also calls ensureInjected
    // so a pre-body load or a torn-down head still self-heals on first use.
    try {
        ensureInjected();
    } catch (e) {
        warn('eager injection skipped: ' + (e && e.message));
    }
})();
