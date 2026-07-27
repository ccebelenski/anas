/*
 * ANAS — Schedules shared helpers (Epic 17). The Snapshots view (69-snapshots.js)
 * and the Scrubs view (69-scrubs.js) were split out of one "Schedules" screen; the
 * bits BOTH genuinely share live here ONCE (single-source-of-truth) rather than as
 * two copies that drift apart:
 *   - the filesystem-tag chip (zfs / ahr) — the two views must read IDENTICALLY
 *     (parallel construction: a ZFS and an AHR row look the same),
 *   - the small state pills (pill / soft pill / muted dash),
 *   - the visibility-gated poll loop (start / stop / cleanup) — ~identical machinery
 *     both views need; duplicating it would be a real SSOT violation.
 *
 * Trivial per-file wrappers (`t`, `enc`) stay local in each view, matching the
 * house style of the other screens (replication/backup each carry their own).
 *
 * Exposed as `ANAS.sched.*`. Plain ES5 to match PVE's compiled ExtJS bundle.
 * Fail-open everywhere — a broken helper never breaks the host page.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS) {
        return;
    }

    var ANAS = window.ANAS;
    var sched = ANAS.sched = ANAS.sched || {};

    // Reload cadence while a schedules view is visible — matches replication.
    sched.POLL_MS = 10000;

    function enc(s) {
        return ANAS.enc(s);
    }

    // The filesystem-tag chip ("ZFS"/"AHR") shared by the Snapshots target column
    // and the Scrubs pool column — one renderer so the two read identically.
    sched.fsTag = function (kind, title) {
        return '<span class="anas-sched-fs-tag"' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:0 6px;margin-right:6px;border-radius:8px;'
            + 'font-size:0.78em;text-transform:uppercase;letter-spacing:0.04em;'
            + 'color:var(--anas-accent,#3468c0);'
            + 'background:color-mix(in srgb,var(--anas-accent,#3468c0) 14%,transparent);">'
            + enc(kind || 'zfs') + '</span>';
    };

    // Solid state pill (enabled / success / failure / on).
    sched.pillHtml = function (label, color, title) {
        return '<span' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:#fff;background:' + color + ';">' + enc(label) + '</span>';
    };

    // Soft (tinted) pill — for muted / neutral states (disabled, off, never-run).
    sched.softPill = function (label, color, title) {
        return '<span' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:' + color + ';background:color-mix(in srgb,' + color + ' 15%,transparent);">'
            + enc(label) + '</span>';
    };

    sched.muted = function (html) {
        return '<span style="color:var(--anas-muted,gray);">' + html + '</span>';
    };

    // ---- Visibility-gated poll loop (no leaked intervals) ------------------
    // Each view supplies its own `refresh(quiet)` closure (which grids to reload);
    // this owns the interval + the visibilitychange handler, stored on the view so
    // stop/cleanup can tear both down. Idempotent: starting twice never doubles up.

    sched.stopPolling = function (view) {
        try {
            if (view && view._anasTimer) {
                clearInterval(view._anasTimer);
                view._anasTimer = null;
            }
        } catch (e) {
            // non-fatal
        }
    };

    sched.startPolling = function (view, refresh) {
        if (!view || view.destroyed || view.destroying) {
            return;
        }
        if (refresh) {
            view._anasRefresh = refresh;
        }
        sched.stopPolling(view);
        try {
            view._anasTimer = setInterval(function () {
                try {
                    if (!view || view.destroyed || view.destroying) {
                        sched.stopPolling(view);
                        return;
                    }
                    if (typeof document !== 'undefined' && document.hidden) {
                        return;
                    }
                    if (typeof view.isVisible === 'function' && !view.isVisible()) {
                        return;
                    }
                    if (view._anasRefresh) {
                        view._anasRefresh(view, true);
                    }
                } catch (tickErr) {
                    ANAS.warn('schedules poll tick failed: ' + ANAS.errText(tickErr));
                }
            }, sched.POLL_MS);
        } catch (e) {
            ANAS.warn('schedules interval start failed: ' + ANAS.errText(e));
        }
        // Wire the tab-visibility handler once per view.
        try {
            if (!view._anasVisHandler && typeof document !== 'undefined' && document.addEventListener) {
                view._anasVisHandler = function () {
                    try {
                        if (document.hidden) {
                            sched.stopPolling(view);
                        } else if (typeof view.isVisible === 'function' && view.isVisible()) {
                            sched.startPolling(view);
                        }
                    } catch (e2) {
                        // non-fatal
                    }
                };
                document.addEventListener('visibilitychange', view._anasVisHandler);
            }
        } catch (e3) {
            // non-fatal
        }
    };

    sched.cleanupPolling = function (view) {
        sched.stopPolling(view);
        try {
            if (view && view._anasVisHandler && typeof document !== 'undefined'
                && document.removeEventListener) {
                document.removeEventListener('visibilitychange', view._anasVisHandler);
                view._anasVisHandler = null;
            }
        } catch (e) {
            // non-fatal
        }
    };

    // The standard listeners block a schedules view uses — refresh + poll while
    // visible, tear everything down on destroy. `refresh(view, quiet)` is the
    // view's own (which grid(s) to reload).
    sched.viewListeners = function (refresh) {
        return {
            afterrender: function (v) { refresh(v, false); sched.startPolling(v, refresh); },
            activate: function (v) { refresh(v, false); sched.startPolling(v, refresh); },
            deactivate: function (v) { sched.stopPolling(v); },
            show: function (v) { sched.startPolling(v, refresh); },
            hide: function (v) { sched.stopPolling(v); },
            beforedestroy: function (v) { sched.cleanupPolling(v); },
            destroy: function (v) { sched.cleanupPolling(v); }
        };
    };
})();
