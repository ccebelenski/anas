/*
 * ANAS — Snapshots view (Epic 17: stories 17.3 / 17.4 / 17.7).
 *
 * The UNIFORM snapshot-SCHEDULE surface. Split from the former single "Schedules"
 * screen: this owns snapshot schedules; the sibling Scrubs view (69-scrubs.js)
 * owns periodic scrubs. Menu label "Snapshots". The guiding principle
 * (SCHEDULES-DESIGN.md): ZFS and AHR function EXACTLY THE SAME for snapshots —
 * one screen, one set of controls — even though the backends differ. A schedule
 * targets a ZFS dataset OR an AHR pool; the grid and the create/edit dialog treat
 * them identically. Only the target picker diverges.
 *
 * A dedicated top-level menu item (sibling of Replication / Scrubs / Backup).
 * Snapshot scheduling is an ongoing, unattended process with its own policy and
 * history — not a point-in-time dataset action — so it lives in its own view,
 * NOT bleeding into the Datasets / AHR menus (those own the snapshot INVENTORY;
 * this owns the scheduled POLICY).
 *
 * Data (paths relative to /v1 — see routes/schedules.ts):
 *   GET    /schedules            → { data: [ { schedule, lastRunResult, lastRunAt,
 *                                     nextRunAt, overdue } ] }
 *     schedule = { id, name, target:{kind:'zfs',dataset}|{kind:'ahr',pool},
 *                  cadence, retention:{frequently?..yearly?}, recursive?,
 *                  exclude? (snapx.1: full dataset paths a recursive ZFS
 *                  schedule skips, each with its subtree), enabled,
 *                  notify ('always'|'on-failure' — when a finished fire notifies
 *                  through PVE; 9.4. ABSENT = 'on-failure', the quiet default a
 *                  schedule stored before the field reads back as) }
 *   POST   /schedules            → SnapshotSchedule body (create, 202 job)
 *   GET    /schedules/:id        → { data: DETAIL } — the status fields PLUS the
 *                                  last run's exit code, the unit files verbatim,
 *                                  and a recent journald blob (last-run log). This
 *                                  MIRRORS the backup task detail (GET
 *                                  /backup/tasks/:name) — same last-run log + exit
 *                                  status surface (parallel construction).
 *     detail = { schedule, lastRunResult, lastRunAt, nextRunAt, overdue,
 *                lastRunExitCode, unit, timer, journal? }
 *   PUT    /schedules/:id        → SnapshotSchedule body (edit / toggle, 202 job).
 *                                  The TARGET is immutable: the daemon rejects a
 *                                  PUT that moves it (retarget = delete + create),
 *                                  and this dialog never substitutes a stored
 *                                  kind/pool that inventory failed to list.
 *   DELETE /schedules/:id        → removes the units only (never the snapshots)
 *   POST   /schedules/:id/run    → fire now: take + prune (202 job; result carries
 *                                  { taken, pruned[], skippedHeld[], datasets?[] } —
 *                                  datasets = per-dataset counts of a recursive
 *                                  schedule's prune, snapprune.1)
 *
 * Target pickers reuse GET /pools (ANAS-managed ZFS pools + their datasets) and
 * GET /ahr (AHR pools; only subvolLayout:true pools can be snapshotted).
 *
 * Shared with the Scrubs view via ANAS.sched.* (69-schedules-common.js): the
 * fs-tag chip, the state pills, and the visibility-gated poll loop — kept in ONE
 * place so the two views read identically and never drift.
 *
 * Client-side validation MIRRORS the shared Zod schemas (ScheduleId regex,
 * non-negative keep-N, cadence enum) — the daemon re-validates with the real
 * @anas/shared schemas (defense in depth; Principle 6 + 14).
 *
 * Test hooks: view cls 'anas-view anas-view-snapshots', grid cls
 * 'anas-grid-schedules', toolbar buttons 'anas-btn-sched-new' /
 * 'anas-btn-sched-run' / 'anas-btn-sched-log' / 'anas-btn-sched-edit' /
 * 'anas-btn-sched-toggle' / 'anas-btn-sched-delete', dialog window
 * 'anas-win-sched', detail/log window 'anas-win-sched-detail' (body
 * 'anas-sched-detail', reload 'anas-btn-sched-detail-reload'), edit-guard
 * blocked-Save note 'anas-edit-guard'.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 * Fail-open everywhere: a broken view renders an error panel, never breaks PVE.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    // Shared schedules helpers (fs-tag chip, pills, poll loop) — ONE copy in
    // 69-schedules-common.js, used by both this view and the Scrubs view.
    var sched = ANAS.sched || {};

    // ScheduleId shape from packages/shared (schedules.ts): start alphanumeric,
    // then letters/digits/underscore/dot/hyphen; ≤255. The daemon is authoritative.
    var ID_RE = /^[a-z0-9][\w.-]*$/i;

    // The six retention period buckets, in age order (shared RetentionBucket).
    // Each carries a compact unit letter for the grid summary and the cadence label.
    var BUCKETS = [
        { key: 'frequently', unit: 'fr', label: 'frequently' },
        { key: 'hourly', unit: 'h', label: 'hourly' },
        { key: 'daily', unit: 'd', label: 'daily' },
        { key: 'weekly', unit: 'w', label: 'weekly' },
        { key: 'monthly', unit: 'm', label: 'monthly' },
        { key: 'yearly', unit: 'y', label: 'yearly' }
    ];

    // Retention presets (SCHEDULES-DESIGN §Retention: a few presets + an advanced
    // per-bucket expander). Common-case-first: the operator picks a preset; the
    // advanced panel exposes the raw keep-N counts and marks the choice Custom
    // once edited.
    // Preset counts trace to real systems, not invention. 'balanced' keeps
    // sanoid [template_production]'s proven short-term granularity (36h/30d) but a
    // full-year monthly tail (like zfs-auto-snapshot's 12) — snapshots are CoW, so
    // an idle monthly costs ~nothing until data diverges, cheap insurance for
    // slow-changing data. 'aggressive' extends sanoid's factory [template_default]
    // (48h/90d) with weekly+2yr coverage. 'minimal' is our lightweight option.
    var PRESETS = [
        { value: 'balanced', label: '36h / 30d / 12m (recommended)',
            retention: { hourly: 36, daily: 30, monthly: 12 } },
        { value: 'minimal', label: 'Minimal — 7d / 4w',
            retention: { daily: 7, weekly: 4 } },
        { value: 'aggressive', label: 'Aggressive — 48h / 90d / 12w / 24m',
            retention: { hourly: 48, daily: 90, weekly: 12, monthly: 24 } },
        { value: 'custom', label: 'Custom…', retention: null }
    ];

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    // ---- Small formatters --------------------------------------------------

    // Compact relative time: "45s ago" / "3m ago" / "in 5m" / "2h ago" / "4d ago".
    function relTime(iso) {
        if (iso === undefined || iso === null || iso === '') {
            return '';
        }
        try {
            var ms = new Date(iso).getTime();
            if (isNaN(ms)) {
                return '';
            }
            var diff = Date.now() - ms;
            var future = diff < 0;
            var s = Math.abs(diff) / 1000;
            var out;
            if (s < 60) {
                out = Math.round(s) + 's';
            } else if (s < 3600) {
                out = Math.round(s / 60) + 'm';
            } else if (s < 86400) {
                out = Math.round(s / 3600) + 'h';
            } else {
                out = Math.round(s / 86400) + 'd';
            }
            return future ? (t('in') + ' ' + out) : (out + ' ' + t('ago'));
        } catch (e) {
            return '';
        }
    }

    // Shared with the Scrubs view (ANAS.sched.absTime) so both screens print a
    // timestamp identically — one copy, no drift.
    function absTime(iso) {
        return sched.absTime ? sched.absTime(iso) : ('' + (iso || ''));
    }

    function gfxReady() {
        return ANAS.gfx && ANAS.gfx.ready ? ANAS.gfx.ready() : false;
    }

    // A schedule's target as a labelled path: "zfs: tank/media" / "ahr: vault".
    // Never truncated — the full dataset/pool is always shown.
    function targetLabel(target) {
        target = target || {};
        if (target.kind === 'ahr') {
            return 'ahr: ' + (target.pool == null ? '' : target.pool);
        }
        return 'zfs: ' + (target.dataset == null ? '' : target.dataset);
    }

    // Compact retention summary from a RetentionPolicy: non-zero buckets joined
    // ("24h / 30d / 12m"). Empty policy → a muted dash.
    function retentionSummary(retention) {
        retention = retention || {};
        var parts = [];
        for (var i = 0; i < BUCKETS.length; i++) {
            var b = BUCKETS[i];
            var n = retention[b.key];
            if (n !== undefined && n !== null && Number(n) > 0) {
                parts.push(Number(n) + b.unit);
            }
        }
        return parts.length ? parts.join(' / ') : '';
    }

    // ---- Renderers ---------------------------------------------------------

    // Presentational helpers live once in ANAS.sched (shared with the Scrubs
    // view); thin local delegates keep the call sites here unchanged.
    function pillHtml(label, color, title) {
        return sched.pillHtml(label, color, title);
    }

    function softPill(label, color, title) {
        return sched.softPill(label, color, title);
    }

    function muted(html) {
        return sched.muted(html);
    }

    // Target: a filesystem-tag chip ("zfs"/"ahr") + the full path. The two
    // filesystems read identically here — one uniform column (parallel construction).
    function renderTarget(v, meta, rec) {
        var kind = rec.get('targetKind');
        var path = rec.get('targetPath');
        var tag = sched.fsTag(kind, kind === 'ahr' ? t('AHR pool') : t('ZFS dataset'));
        var rec2 = '';
        if (rec.get('recursive')) {
            // snapx.1: "(-r, N excluded)" with the excluded names in the
            // tooltip — the shared marker (10-api.js), the replication grid
            // draws the same one (rrep.3).
            rec2 = ANAS.excludePicker.labelHtml(rec.get('exclude'), 'anas-sched-recursive');
        }
        return tag + '<span style="font-family:monospace;font-size:0.92em;">' + enc(path) + '</span>' + rec2;
    }

    // ---- Fire schedule text (snaptime.1, snaptime.2) ------------------------
    //
    // The four fields a snapshot schedule may carry on top of its bucket:
    // time, weekday, dayOfMonth, month (shared schedules.ts). Allowed by
    // cadence: time on daily/weekly/monthly/yearly; weekday weekly;
    // dayOfMonth monthly AND yearly; month yearly. ABSENT means the default —
    // 00:00, Mon, the 1st, January — because the daemon stores a value equal
    // to its default as ABSENCE, so a missing field is never missing
    // information. The weekday abbreviation is systemd's, the full name is
    // what the dialog offers.
    var FIRE_DEFAULTS = { time: '00:00', weekday: 'Mon', dayOfMonth: 1, month: 1 };
    var WEEKDAYS = [
        { abbr: 'Mon', full: 'Monday' },
        { abbr: 'Tue', full: 'Tuesday' },
        { abbr: 'Wed', full: 'Wednesday' },
        { abbr: 'Thu', full: 'Thursday' },
        { abbr: 'Fri', full: 'Friday' },
        { abbr: 'Sat', full: 'Saturday' },
        { abbr: 'Sun', full: 'Sunday' }
    ];
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    // The cadences that fire at a chosen time (everything but the two
    // sub-hourly buckets). An array, not a map: the bucket word must be found
    // IN it — a bare map would answer true for 'toString'.
    var FIRE_CADENCES = ['daily', 'weekly', 'monthly', 'yearly'];
    // The dialog's time field checks this too (same shape as the daemon's).
    var FIRE_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

    function cadenceHasTime(cad) {
        return FIRE_CADENCES.indexOf('' + cad) >= 0;
    }

    // The field as text / as a number, or its default when ABSENT (null,
    // undefined, empty string). Any other value passes through as-is — the
    // daemon's schema is the authority on what a stored schedule can hold.
    function fireStr(v, dflt) {
        return (v === null || v === undefined || v === '') ? dflt : ('' + v);
    }

    function fireNum(v, dflt) {
        if (v === null || v === undefined || v === '') {
            return dflt;
        }
        var n = Number(v);
        return isNaN(n) ? dflt : n;
    }

    // Does the schedule carry ANY fire field? (No field set is what every
    // schedule created before snaptime.1 reads back as — the cell then shows
    // the bare bucket word, exactly as it did before.)
    function fireSet(sched) {
        var s = sched || {};
        return (s.time !== null && s.time !== undefined && s.time !== '')
            || (s.weekday !== null && s.weekday !== undefined && s.weekday !== '')
            || (s.dayOfMonth !== null && s.dayOfMonth !== undefined && s.dayOfMonth !== '')
            || (s.month !== null && s.month !== undefined && s.month !== '');
    }

    // English ordinal day: 1st, 2nd, 3rd, 4th, 11th-13th, 21st-23rd, 31st.
    // The teens take 'th'; otherwise the last digit picks the suffix.
    function dayOrdinal(n) {
        var teens = n % 100;
        if (teens >= 11 && teens <= 13) {
            return n + t('th');
        }
        if (n % 10 === 1) {
            return n + t('st');
        }
        if (n % 10 === 2) {
            return n + t('nd');
        }
        if (n % 10 === 3) {
            return n + t('rd');
        }
        return n + t('th');
    }

    // The Cadence text for a schedule — the grid cell, the detail row, and
    // the contract harness all read it from here. No fire field set: the
    // bucket word exactly as the grid always read it. Once any field is set,
    // the cadence's full form with the defaults filled in:
    //   daily 01:00 · weekly Thu 01:00 · monthly on the 15th 01:00
    //   yearly on 17 June 01:00
    // Monthly day 31 reads systemd's own form — 'on the last day' — since
    // every month has one.
    function cadenceText(sched) {
        var s = sched || {};
        var cad = '' + (s.cadence == null ? '' : s.cadence);
        if (!cad) {
            return '';
        }
        var word = t(cad);
        if (!fireSet(s) || !cadenceHasTime(cad)) {
            return word;
        }
        var time = fireStr(s.time, FIRE_DEFAULTS.time);
        if (cad === 'daily') {
            return word + ' ' + time;
        }
        if (cad === 'weekly') {
            return word + ' ' + t(fireStr(s.weekday, FIRE_DEFAULTS.weekday)) + ' ' + time;
        }
        if (cad === 'monthly') {
            var day = fireNum(s.dayOfMonth, FIRE_DEFAULTS.dayOfMonth);
            var when = day >= 31 ? t('on the last day') : t('on the') + ' ' + dayOrdinal(day);
            return word + ' ' + when + ' ' + time;
        }
        var mon = fireNum(s.month, FIRE_DEFAULTS.month);
        var monName = MONTHS[mon - 1];
        var yday = fireNum(s.dayOfMonth, FIRE_DEFAULTS.dayOfMonth);
        // A day the month does not always have (31 April, 29 February) fires
        // on that month's last day: the label says when it fires, never a date
        // that does not exist (review of snaptime.2).
        if (yday > minDaysInMonth(mon)) {
            return word + ' ' + t('on the last day of') + ' ' + (monName ? t(monName) : mon) + ' ' + time;
        }
        return word + ' ' + t('on') + ' ' + yday
            + ' ' + (monName ? t(monName) : mon) + ' ' + time;
    }

    // The fewest days a month (1-12) can have: February may skip the 29th
    // (leap years are not every year), the four 30-day months never have a
    // 31st. A day beyond this is one the month may lack, and systemd then
    // fires on that month's last day (snaptime.1, proven on the node). We
    // never compute the shift — we only say it.
    function minDaysInMonth(m) {
        if (m === 2) {
            return 28;
        }
        if (m === 4 || m === 6 || m === 9 || m === 11) {
            return 30;
        }
        return 31;
    }

    // True when the chosen day is one the month may lack. Monthly: the 29th
    // and 30th (the 31st only where `show31` — the grid cell already reads
    // 'on the last day' for it, the dialog shows a bare 31 and must warn).
    // Yearly: any day past the month's shortest length (February 29, June 31).
    function fireDayMayBeAbsent(cad, dayOfMonth, month, show31) {
        var day = fireNum(dayOfMonth, 0);
        if (cad === 'monthly') {
            return day === 29 || day === 30 || (show31 === true && day === 31);
        }
        if (cad === 'yearly') {
            return day > minDaysInMonth(fireNum(month, FIRE_DEFAULTS.month));
        }
        return false;
    }

    // Cadence: the bucket a fired snapshot is taken into ("daily", "hourly",
    // and so on), with the fire fields the schedule carries spelled out
    // (snaptime.2).
    // A day the month may lack carries the shift sentence as the cell tip.
    function renderCadence(v, meta, rec) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            return muted('&mdash;');
        }
        var sched = { cadence: s };
        if (rec) {
            sched.time = rec.get('time');
            sched.weekday = rec.get('weekday');
            sched.dayOfMonth = rec.get('dayOfMonth');
            sched.month = rec.get('month');
        }
        var tip = t('a snapshot is taken into this period bucket');
        if (fireDayMayBeAbsent(s, sched.dayOfMonth, sched.month, false)) {
            tip = t('In a shorter month it fires on the last day');
        }
        return '<span title="' + enc(tip) + '">' + enc(cadenceText(sched)) + '</span>';
    }

    function renderRetention(v, meta, rec) {
        var summary = retentionSummary(rec.get('retention'));
        if (!summary) {
            return muted('&mdash;');
        }
        return '<span title="' + enc(t('keep N per period bucket (newest always kept)')) + '"'
            + ' style="font-family:monospace;font-size:0.9em;">' + enc(summary) + '</span>';
    }

    // The one sentence a `disabled` result carries, wherever it is rendered.
    // Same words as the backup grid — one hole, one explanation (F9).
    var DISABLED_RESULT_TIP = 'Disabled — systemd does not keep the run history of a task whose timer is off, so there is no last result to show. The recent journald output on the detail is the only record left.';

    // The one sentence a `never-run` result carries — the enabled twin of the
    // F9 hole: an enabled unit is kept loaded by its timer, so empty run
    // timestamps mean it has never fired (the default-valued Result=success
    // was a fabricated success). Same words as the backup grid.
    var NEVER_RUN_TIP = 'this task has not run yet';

    // Last run: a result pill (success / failure / running / unknown) + relative
    // time. A `failure` here is exactly the dashboard's 17.7 warning surfaced inline.
    function renderLastRun(v, meta, rec) {
        var result = '' + (rec.get('lastRunResult') || 'unknown');
        var at = rec.get('lastRunAt');
        var pill;
        if (result === 'success') {
            pill = pillHtml(t('success'), 'var(--anas-ok,#1f9c56)', absTime(at));
        } else if (result === 'failure') {
            pill = pillHtml(t('failure'), 'var(--anas-danger,#c23b2c)', absTime(at));
        } else if (result === 'running') {
            pill = '<span title="' + enc(t('running')) + '"'
                + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
                + 'color:#fff;background:var(--anas-accent,#3468c0);">'
                + '<i class="fa fa-refresh fa-spin" aria-hidden="true" style="margin-right:4px;"></i>'
                + enc(t('running')) + '</span>';
        } else if (result === 'disabled') {
            // Live-proof F9 — the same hole as the backup grid, and the same
            // answer: a disabled unit's history is garbage-collected, so there
            // is no result to report (its timer being OFF is what sets it apart
            // from the enabled never-run state below).
            pill = softPill(t('disabled'), 'var(--anas-muted,gray)', t(DISABLED_RESULT_TIP));
        } else if (result === 'never-run') {
            // The enabled twin of F9: an enabled unit is kept loaded by its
            // timer, so empty run timestamps mean it has never fired — the
            // default-valued Result=success was a fabricated success.
            pill = softPill(t('never run'), 'var(--anas-muted,gray)', t(NEVER_RUN_TIP));
        } else if (result === 'unknown' && rec.get('lastRunNote')) {
            // taskstatus.1: it ran (the timer's stamp says when), its verdict
            // did not survive the reboot — the shared muted pill, note as tip.
            pill = sched.notRetainedPill(rec.get('lastRunNote'));
        } else {
            pill = softPill(t('never run'), 'var(--anas-muted,gray)', t('no run recorded yet'));
        }
        var rel = at ? relTime(at) : '';
        if (rel) {
            pill += ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">' + enc(rel) + '</span>';
        }
        return pill;
    }

    // Next run: relative time; when OVERDUE (a Persistent timer that never caught
    // up, 17.7) it flips to an amber "overdue" chip — the inline warning surface.
    function renderNextRun(v, meta, rec) {
        if (rec.get('overdue')) {
            return softPill(t('overdue'), 'var(--anas-warn,#b06a12)',
                t('the scheduled run is past due — it will fire on the next timer wake'));
        }
        var at = rec.get('nextRunAt');
        if (!at) {
            return muted('&mdash;');
        }
        if (!rec.get('enabled')) {
            return muted('&mdash;');
        }
        var rel = relTime(at);
        return '<span title="' + enc(absTime(at)) + '">' + enc(rel || absTime(at)) + '</span>';
    }

    function renderEnabled(v, meta, rec) {
        if (rec.get('enabled')) {
            return pillHtml(t('Enabled'), 'var(--anas-ok,#1f9c56)', '');
        }
        return softPill(t('Disabled'), 'var(--anas-muted,gray)', t('kept, but never takes a snapshot'));
    }

    // ---- Load / reload the schedules grid ----------------------------------

    // `quiet` skips the loading mask so the timed poll refreshes in place with
    // no visible flash; the selected row is restored by schedule id so the poll
    // doesn't drop it (the replication pattern, cr.46: a row picked while the
    // request was in flight is read when the answer arrives, and a response
    // older than the newest request is dropped).
    function loadSchedules(grid, node, quiet) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        if (!quiet) {
            try { grid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        // cr.46: per-grid load sequence, the `_previewSeq` idiom — the same
        // guard every sibling loader carries.
        var seq = (grid._loadSeq = (grid._loadSeq || 0) + 1);
        ANAS.api.get(node, '/schedules').then(function (res) {
            // Drop a response older than the newest request: its rows, its
            // mask and — below all else — its idea of what was selected.
            if (grid.destroyed || grid.destroying || grid._loadSeq !== seq) {
                return;
            }
            // The selection is read NOW, when the answer arrives: a row the
            // operator picked while this request was in flight is the row to
            // keep selected, not the one selected when the request left.
            var priorId = null;
            try {
                var sel = grid.getSelectionModel().getSelection();
                priorId = (sel && sel.length) ? sel[0].get('id') : null;
            } catch (eS) {
                priorId = null;
            }
            // cr.45 review: the response that IS the newest clears the mask
            // even when its own load was quiet — a quiet load issued under a
            // masked one would otherwise leave that mask up forever once the
            // masked load's response goes stale and stops touching it
            // (setLoading(false) is a no-op when no mask is up). Applies to
            // error alike, below; only a STALE response keeps its hands off.
            try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            var list = (res && res.data) || [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(scheduleRow(list[i]));
            }
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('schedules grid load failed: ' + ANAS.errText(e2));
            }
            if (priorId) {
                try {
                    var idx = grid.getStore().findExact('id', priorId);
                    if (idx >= 0) {
                        grid.getSelectionModel().select(idx, false, true);
                    }
                } catch (eSel) {
                    // non-fatal
                }
            }
            updateButtons(grid);
        }, function (err) {
            // Stale failure: the newer load owns the mask and the grid now.
            if (grid.destroyed || grid.destroying || grid._loadSeq !== seq) {
                return;
            }
            // The newest response clears the mask whether its own load was
            // quiet or not (see the success branch) — a fresh FAILURE must
            // leave a quiet poll's mask down too.
            try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            ANAS.warn('schedules load failed: ' + ANAS.errText(err));
        });
    }

    // ---- Notifications (9.4) -----------------------------------------------
    // When a finished fire notifies through PVE — backup's own two modes, but
    // with the QUIET default: a schedule can fire every 15 minutes. ABSENT means
    // 'on-failure' (the daemon's schema default), which is exactly what every
    // schedule created before the field existed reads back as.
    function notifyOf(sched) {
        return ANAS.notifyMode.of(sched && sched.notify, 'on-failure');
    }

    // Flatten a SnapshotScheduleStatus into a grid record; keep the raw schedule
    // under 'raw' so edit / toggle round-trip it exactly.
    function scheduleRow(status) {
        status = status || {};
        var sched = status.schedule || {};
        var target = sched.target || {};
        return {
            id: sched.id,
            name: sched.name || sched.id,
            targetKind: target.kind || 'zfs',
            targetPath: target.kind === 'ahr' ? target.pool : target.dataset,
            cadence: sched.cadence,
            // The fire fields pass through untouched (absent stays absent) —
            // the Cadence cell fills the defaults, snaptime.2.
            time: sched.time,
            weekday: sched.weekday,
            dayOfMonth: sched.dayOfMonth,
            month: sched.month,
            retention: sched.retention || {},
            recursive: !!sched.recursive,
            exclude: (sched.exclude || []).slice(),
            notify: notifyOf(sched),
            enabled: sched.enabled !== false,
            lastRunResult: status.lastRunResult || 'unknown',
            lastRunAt: status.lastRunAt,
            lastRunNote: status.lastRunNote || '',
            nextRunAt: status.nextRunAt,
            overdue: !!status.overdue,
            raw: sched
        };
    }

    ANAS.schedules = ANAS.schedules || {};
    // cr3: the read-back comparison, for cr3-datasets.harness.mjs.
    ANAS.schedules.fireFieldsNotStored = fireFieldsNotStored;
    ANAS.schedules.loadDatasetOptions = loadDatasetOptions;
    ANAS.schedules.loadZfsPools = loadZfsPools;
    ANAS.schedules.reload = loadSchedules;
    // The schedule dialog's entry point, exposed so the edit-guard harness
    // (test/edit-retarget.harness.mjs) can open a real edit against stubbed
    // inventory. The view's own toolbar calls the local function directly.
    ANAS.schedules.openDialog = openScheduleDialog;
    // The Enable/Disable toggle and the grid's row renderer, exposed for the
    // same harness (snapx.1: a toggle must round-trip the exclude list, and
    // the row must say how many datasets are excluded).
    ANAS.schedules.toggle = toggleSchedule;
    ANAS.schedules.scheduleRow = scheduleRow;
    ANAS.schedules.renderTarget = renderTarget;
    // The grid's Last run cell, exposed for the pill harness (lastrun-pill.harness.mjs).
    ANAS.schedules.renderLastRun = renderLastRun;
    // The delete door, exposed for poll-selection.harness.mjs (cr.46) — it
    // must go through runJob, and that is only provable from the call site.
    ANAS.schedules.deleteSchedule = deleteSchedule;
    // The Cadence label helper and the cell it feeds, exposed for the dialog
    // contract harness (snaptime.2: the whole table of cadence texts, and the
    // shorter-month cell tip).
    ANAS.schedules.cadenceText = cadenceText;
    ANAS.schedules.renderCadence = renderCadence;

    // ---- Selection + toolbar state -----------------------------------------

    function selectedSchedule(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function setDisabled(grid, itemId, disabled) {
        var btn = grid.down('#' + itemId);
        if (btn) {
            btn.setDisabled(!!disabled);
        }
    }

    function updateButtons(grid) {
        var rec = selectedSchedule(grid);
        var has = !!rec;
        setDisabled(grid, 'schedRun', !has);
        setDisabled(grid, 'schedLog', !has);
        setDisabled(grid, 'schedEdit', !has);
        setDisabled(grid, 'schedToggle', !has);
        setDisabled(grid, 'schedDelete', !has);
        try {
            var toggle = grid.down('#schedToggle');
            if (toggle) {
                var on = has && rec.get('enabled');
                toggle.setText(on ? t('Disable') : t('Enable'));
                toggle.setIconCls(on ? 'fa fa-pause' : 'fa fa-play');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ---- Target pickers (pvepool.2: PVE pools in, owned datasets out) -------
    //
    // The ZFS pool picker lists EVERY pool — PVE's included. The dataset
    // options omit what PVE owns (any kind, per the shared ANAS.pve helper in
    // 10-api.js — the ONE predicate); the daemon's named refusal is the
    // backstop. Against an older daemon (no per-node field in the payload) a
    // pool PVE names keeps the whole-pool rule: every one of its datasets is
    // omitted — skew tightens, never loosens.

    // Every ZFS pool summary (PVE's included); never rejects.
    // cr3: a list that could not be read is an empty array CARRYING
    // `unreadable` (the reason), so the dialog can say so instead of reading
    // it as "nothing to pick".
    function unreadableList(err) {
        var list = [];
        list.unreadable = ANAS.errText(err) || t('unknown error');
        return list;
    }

    function loadZfsPools(node) {
        return ANAS.api.get(node, '/pools').then(function (res) {
            return (res && res.data) || [];
        }, function (err) {
            ANAS.warn('schedules ZFS pools load failed: ' + ANAS.errText(err));
            return unreadableList(err);
        });
    }

    // AHR pool names that CAN be snapshotted (subvolLayout:true only — a pre-§12
    // flat pool cannot, mirroring the daemon's guardTarget). Never rejects.
    function loadAhrPools(node) {
        return ANAS.api.get(node, '/ahr').then(function (res) {
            var pools = (res && res.data) || [];
            var names = [];
            for (var i = 0; i < pools.length; i++) {
                if (pools[i] && pools[i].subvolLayout) {
                    names.push(pools[i].name);
                }
            }
            return names;
        }, function (err) {
            ANAS.warn('schedules AHR pools load failed: ' + ANAS.errText(err));
            return unreadableList(err);
        });
    }

    // Full ZFS name → relative path within its pool ('' for the pool root).
    function relOfFull(fullName, pool) {
        if (!fullName || fullName === pool) {
            return '';
        }
        var prefix = pool + '/';
        return fullName.indexOf(prefix) === 0 ? fullName.substring(prefix.length) : fullName;
    }

    // Dataset options for a ZFS pool: the pool root '(pool root)' first, then each
    // ANAS-managed dataset's relative path — owned rows (any kind, ANAS.pve) are
    // omitted, siblings stay. `rel` '' is the pool root. `poolSummary` carries
    // the pool's pveStorages for the skew fallback. Never rejects. Resolves
    // { opts, rows }: `opts` feed the target picker; `rows` are every dataset
    // below the pool root as { name, own } (own = the PVE ownership or null)
    // for the Exclude picker (snapx.1).
    function loadDatasetOptions(node, pool, poolSummary) {
        var rootOpt = [{ rel: '', label: t('(pool root)') }];
        if (!pool) {
            return Promise.resolve({ opts: rootOpt, rows: [] });
        }
        return ANAS.api.get(node, '/pools/' + encodeURIComponent(pool) + '/datasets').then(
            function (res) {
                var list = (res && res.data) || [];
                // Did the daemon stamp per-node ownership on any row of this
                // payload? (Unowned rows carry no `pve` key — that is the
                // contract ANAS.pve.ownership is called with.)
                var perNode = false;
                for (var k = 0; k < list.length; k++) {
                    var row = list[k];
                    if (row && row.pve && typeof row.pve === 'object') {
                        perNode = true;
                        break;
                    }
                }
                var opts = [];
                var rootOwned = false;
                var rels = [];
                // snapx.1: EVERY row below the pool root, owned ones included
                // (with their ownership, for the badge) — the Exclude picker
                // lists them, because excluding guest volumes from a recursive
                // schedule is exactly what it is for. The shared picker's own
                // reader (10-api.js), so the replication task reads the same.
                var rows = ANAS.excludePicker.rowsOf(list, pool, poolSummary);
                for (var i = 0; i < list.length; i++) {
                    var ds = list[i] || {};
                    var owned;
                    try {
                        owned = ANAS.pve.isOwned(ds, poolSummary, perNode);
                    } catch (eRow) {
                        // A throw in the helper would REJECT this promise
                        // silently (no catch further down the chain). Degrade
                        // the one row toward the TIGHTENING answer and keep
                        // looping: the whole-pool rule when the payload
                        // predates the per-node stamps, OWNED (the row is
                        // omitted) when it carries them — a row whose verdict
                        // cannot be read must never be offered.
                        owned = perNode
                            || ANAS.pve.storagesOf(poolSummary).length > 0;
                    }
                    if (owned) {
                        if (ds.name === pool) {
                            rootOwned = true; // the root row is PVE's
                        }
                        continue; // owned — PVE inventories it, the picker omits it
                    }
                    if (ds.name === pool) {
                        continue;
                    }
                    var rel = relOfFull(ds.name, pool);
                    if (rel) {
                        rels.push(rel);
                    }
                }
                if (!rootOwned) {
                    opts = rootOpt;
                }
                rels.sort();
                for (var j = 0; j < rels.length; j++) {
                    opts.push({ rel: rels[j], label: rels[j] });
                }
                return { opts: opts, rows: rows };
            },
            function (err) {
                ANAS.warn('schedules datasets load failed for ' + pool + ': ' + ANAS.errText(err));
                // cr3 (review fold of INVENTED-STATE-L15): the choices could
                // not be read — offer NONE and say so (`unreadable`); the
                // dialog marks the picker and refuses to save a ZFS target or
                // an exclude list chosen from a list it never saw.
                return { opts: [], rows: [], unreadable: ANAS.errText(err) || t('unknown error') };
            }
        );
    }

    // A pool row for a combo store. `label` is what the operator reads, so a
    // value inventory no longer lists can say so instead of silently looking
    // like any other pick.
    function poolRow(name, unavailable) {
        return {
            name: name,
            label: unavailable ? (name + ' ' + UNAVAILABLE) : name,
            unavailable: !!unavailable
        };
    }

    function poolComboStore(names) {
        var data = [];
        for (var i = 0; i < names.length; i++) {
            data.push(poolRow(names[i], false));
        }
        return Ext.create('Ext.data.Store', { fields: ['name', 'label', 'unavailable'], data: data });
    }

    // ======================================================================
    //  Edit guard — an edit dialog NEVER substitutes stored identity (#40)
    // ======================================================================
    //
    // Both target inventories above are FAIL-OPEN: a failed or slow /pools or
    // /ahr answers []. On a create that only costs an empty picker; on an EDIT
    // it used to silently move the schedule — the filesystem kind flipped to
    // whichever inventory did answer, and an AHR pool fell back to the first in
    // the list. So the stored kind and pool stand no matter what came back, the
    // missing value is shown marked "(unavailable)", and Save is BLOCKED with a
    // named reason. The daemon backs this up: a PUT may not change a schedule's
    // target at all (retarget = delete + create).
    //
    // The gate machinery itself is the shared ANAS.editGuard in 10-api.js —
    // the replication task dialog (65-replication.js, #39) runs the same one.

    var UNAVAILABLE = t('(unavailable)');

    function valOf(win, sel) {
        try {
            var f = win.down(sel);
            return f ? f.getValue() : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // ======================================================================
    //  Create / edit dialog — 'anas-win-sched'
    // ======================================================================

    function cadenceComboCfg(value) {
        var data = [];
        for (var i = 0; i < BUCKETS.length; i++) {
            data.push({ key: BUCKETS[i].key, label: t(BUCKETS[i].label) });
        }
        return {
            xtype: 'combobox',
            itemId: 'cadence',
            cls: 'anas-fld-sched-cadence',
            fieldLabel: t('Take a snapshot'),
            store: Ext.create('Ext.data.Store', { fields: ['key', 'label'], data: data }),
            valueField: 'key',
            displayField: 'label',
            queryMode: 'local',
            editable: false,
            forceSelection: true,
            allowBlank: false,
            value: value || 'daily'
        };
    }

    // Set the six advanced keep-N fields from a retention object (absent = 0).
    function applyRetentionToFields(win, retention) {
        retention = retention || {};
        for (var i = 0; i < BUCKETS.length; i++) {
            var fld = win.down('#keep-' + BUCKETS[i].key);
            if (fld) {
                var n = retention[BUCKETS[i].key];
                fld.setValue((n === undefined || n === null) ? 0 : Number(n));
            }
        }
    }

    // Read the six advanced fields back into a RetentionPolicy (only >0 buckets).
    function retentionFromFields(win) {
        var out = {};
        for (var i = 0; i < BUCKETS.length; i++) {
            var fld = win.down('#keep-' + BUCKETS[i].key);
            var n = fld ? parseInt(fld.getValue(), 10) : 0;
            if (!isNaN(n) && n > 0) {
                out[BUCKETS[i].key] = n;
            }
        }
        return out;
    }

    // Does the given retention match a preset's counts exactly? (choose the
    // preset selector on edit).
    function matchPreset(retention) {
        for (var i = 0; i < PRESETS.length; i++) {
            var p = PRESETS[i];
            if (!p.retention) {
                continue;
            }
            var same = true;
            for (var j = 0; j < BUCKETS.length; j++) {
                var k = BUCKETS[j].key;
                var a = Number(retention[k] || 0);
                var b = Number(p.retention[k] || 0);
                if (a !== b) { same = false; break; }
            }
            if (same) {
                return p.value;
            }
        }
        return 'custom';
    }

    function retentionFieldRow(bucket) {
        return {
            xtype: 'numberfield',
            itemId: 'keep-' + bucket.key,
            cls: 'anas-fld-sched-keep-' + bucket.key,
            fieldLabel: t('keep ' + bucket.label),
            minValue: 0,
            maxValue: 9999,
            step: 1,
            allowDecimals: false,
            value: 0,
            width: 220
        };
    }

    function openScheduleDialog(node, grid, existing) {
        // Load both target inventories up front so the picker can offer ZFS
        // datasets AND AHR pools without a second round-trip on kind switch.
        Promise.all([loadZfsPools(node), loadAhrPools(node)]).then(function (r) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            // Summaries — the dataset options' skew fallback reads pveStorages
            // off the picked pool's summary; the picker stores want names.
            var zfsSummaries = r[0] || [];
            var zfsPools = [];
            for (var i = 0; i < zfsSummaries.length; i++) {
                zfsPools.push(zfsSummaries[i].name);
            }
            var ahrPools = r[1] || [];
            // cr3: an inventory that could not be read is said, never read as
            // "no pool".
            var unreadable = [];
            if (r[0] && r[0].unreadable) {
                unreadable.push(t('ZFS pools') + ': ' + r[0].unreadable);
            }
            if (r[1] && r[1].unreadable) {
                unreadable.push(t('AHR pools') + ': ' + r[1].unreadable);
            }
            // Nothing to point a NEW schedule at. An EDIT still opens: the
            // schedule already has a target, and the dialog's job is then to say
            // that the inventory is missing — not to disappear.
            if (!zfsPools.length && !ahrPools.length && !existing) {
                if (unreadable.length) {
                    ANAS.alertMsg('Cannot load targets', t('The pools could not be read') + ' — ' + unreadable.join('; '));
                    return;
                }
                ANAS.toast(t('No ZFS pool or AHR pool is available to schedule.'));
                return;
            }
            if (unreadable.length) {
                ANAS.toast(t('Some targets could not be read') + ' — ' + unreadable.join('; '));
            }
            buildScheduleWindow(node, grid, existing || null, zfsPools, ahrPools, zfsSummaries);
        });
    }

    function buildScheduleWindow(node, grid, existing, zfsPools, ahrPools, zfsSummaries) {
        var isEdit = !!existing;
        var sched = existing || {};
        var target = sched.target || {};
        var startKind = target.kind || (zfsPools.length ? 'zfs' : 'ahr');

        var zfsPoolStore = poolComboStore(zfsPools);
        var ahrPoolStore = poolComboStore(ahrPools);
        var zfsDsStore = Ext.create('Ext.data.Store', { fields: ['rel', 'label'], data: [] });
        // snapx.1: the target's strict descendants, owned ones badged.
        var excludeStore = Ext.create('Ext.data.Store', { fields: ['name', 'label', 'badge'], data: [] });

        // Kind options limited to filesystems that actually have a target.
        var kindData = [];
        if (zfsPools.length) { kindData.push({ kind: 'zfs', label: t('ZFS dataset') }); }
        if (ahrPools.length) { kindData.push({ kind: 'ahr', label: t('AHR pool') }); }
        var kindKnown = kindData.map(function (k) { return k.kind; }).indexOf(startKind) >= 0;
        // A missing KIND is a missing inventory, never a reason to switch
        // filesystem: on edit the stored kind stays (with its own row, marked),
        // and only a create falls back to whatever did answer.
        var kindMissing = '';
        if (!kindKnown) {
            if (isEdit) {
                kindMissing = startKind;
                kindData.push({ kind: startKind,
                    label: (startKind === 'ahr' ? t('AHR pool') : t('ZFS dataset')) + ' ' + UNAVAILABLE });
            } else if (kindData.length) {
                startKind = kindData[0].kind;
            }
        }

        // Same rule for the pool itself: preserve, mark, and block — the ZFS
        // branch already preserved its stored pool, and AHR now reads the same.
        var zfsMissing = '';
        var ahrMissing = '';
        var defaultZfsPool;
        var defaultAhrPool;
        if (target.kind === 'zfs' && target.dataset) {
            defaultZfsPool = target.dataset.split('/')[0];
            if (isEdit && zfsPools.indexOf(defaultZfsPool) < 0) {
                zfsMissing = defaultZfsPool;
                zfsPoolStore.add(poolRow(defaultZfsPool, true));
            }
        } else {
            defaultZfsPool = zfsPools[0] || '';
        }
        if (target.kind === 'ahr' && target.pool) {
            defaultAhrPool = target.pool;
            if (isEdit && ahrPools.indexOf(defaultAhrPool) < 0) {
                ahrMissing = defaultAhrPool;
                ahrPoolStore.add(poolRow(defaultAhrPool, true));
            }
        } else {
            defaultAhrPool = ahrPools[0] || '';
        }

        var startPreset = isEdit ? matchPreset(sched.retention || {}) : 'balanced';

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-sched',
                title: isEdit ? (t('Edit Snapshot Schedule') + ': ' + enc(sched.name || sched.id || ''))
                    : t('New Snapshot Schedule'),
                modal: true,
                width: 540,
                // snaptime.2: with the fire controls, Recursive and its Exclude
                // picker all shown, the form is taller than a 720px browser
                // window and the Save button fell below it (the exclude
                // browser proof could not click it). The window stops short of
                // the viewport; the form (scrollable) takes the overflow and
                // the button bar stays docked in view. The window is centred
                // when it opens SHORT (Recursive off); ticking Recursive grows
                // it downward from that spot, so it is moved back up whenever
                // its bottom edge would leave the view. One helper (10-api.js)
                // shared with the replication task dialog (rrep.3).
                maxHeight: ANAS.dialogFit.maxHeight(),
                listeners: {
                    resize: ANAS.dialogFit.resize
                },
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    scrollable: true,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        ANAS.editGuard.noteCfg(),
                        {
                            xtype: 'textfield',
                            itemId: 'name',
                            cls: 'anas-fld-sched-name',
                            fieldLabel: t('Name'),
                            emptyText: t('Nightly media snapshots'),
                            allowBlank: false,
                            value: sched.name || ''
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'id',
                            cls: 'anas-fld-sched-id',
                            fieldLabel: t('Identifier'),
                            emptyText: 'nightly-media',
                            disabled: isEdit,
                            allowBlank: false,
                            value: sched.id || '',
                            regex: ID_RE,
                            maxLength: 255,
                            regexText: t('Start alphanumeric; letters, digits, and . _ - only.')
                        },
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            html: enc(t('A stable slug — also the systemd unit name. Cannot be changed later.'))
                        },
                        // --- Uniform target picker: ZFS dataset OR AHR pool -----
                        {
                            xtype: 'combobox',
                            itemId: 'targetKind',
                            cls: 'anas-fld-sched-kind',
                            fieldLabel: t('Filesystem'),
                            store: Ext.create('Ext.data.Store', { fields: ['kind', 'label'], data: kindData }),
                            valueField: 'kind',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            disabled: isEdit,
                            value: startKind
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'zfsPool',
                            cls: 'anas-fld-sched-zfs-pool',
                            fieldLabel: t('ZFS pool'),
                            store: zfsPoolStore,
                            valueField: 'name',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            hidden: startKind !== 'zfs',
                            disabled: isEdit,
                            value: defaultZfsPool
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'zfsDataset',
                            cls: 'anas-fld-sched-zfs-dataset',
                            fieldLabel: t('ZFS dataset'),
                            store: zfsDsStore,
                            valueField: 'rel',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            hidden: startKind !== 'zfs',
                            disabled: isEdit,
                            emptyText: t('(loading…)')
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'ahrPool',
                            cls: 'anas-fld-sched-ahr-pool',
                            fieldLabel: t('AHR pool'),
                            store: ahrPoolStore,
                            valueField: 'name',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            hidden: startKind !== 'ahr',
                            disabled: isEdit,
                            value: defaultAhrPool
                        },
                        cadenceComboCfg(sched.cadence || 'daily'),
                        // snaptime.2: WHEN the schedule fires. Each control
                        // shows only for the cadences that allow it (shared
                        // schedules.ts); applyFireVis re-reads that whenever
                        // the cadence changes. Values fill from the stored
                        // schedule, defaults where absent — the daemon stores
                        // a default as absence, so absent is not missing.
                        {
                            xtype: 'textfield',
                            itemId: 'fireTime',
                            cls: 'anas-fld-sched-time',
                            fieldLabel: t('At'),
                            width: 260,
                            anchor: null,
                            allowBlank: false,
                            regex: FIRE_TIME_RE,
                            regexText: t('A 24-hour time, HH:MM.'),
                            value: fireStr(sched.time, FIRE_DEFAULTS.time),
                            hidden: !cadenceHasTime(sched.cadence || 'daily')
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'fireWeekday',
                            cls: 'anas-fld-sched-weekday',
                            fieldLabel: t('On'),
                            store: Ext.create('Ext.data.Store', { fields: ['abbr', 'label'], data: WEEKDAYS.map(function (d) {
                                return { abbr: d.abbr, label: t(d.full) };
                            }) }),
                            valueField: 'abbr',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            width: 260,
                            anchor: null,
                            value: fireStr(sched.weekday, FIRE_DEFAULTS.weekday),
                            hidden: (sched.cadence || 'daily') !== 'weekly'
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'fireMonth',
                            cls: 'anas-fld-sched-month',
                            fieldLabel: t('In'),
                            store: Ext.create('Ext.data.Store', { fields: ['num', 'label'], data: MONTHS.map(function (name, i) {
                                return { num: i + 1, label: t(name) };
                            }) }),
                            valueField: 'num',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            width: 260,
                            anchor: null,
                            value: fireNum(sched.month, FIRE_DEFAULTS.month),
                            hidden: (sched.cadence || 'daily') !== 'yearly'
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'fireDay',
                            cls: 'anas-fld-sched-day',
                            fieldLabel: t('On day'),
                            minValue: 1,
                            maxValue: 31,
                            step: 1,
                            allowDecimals: false,
                            allowBlank: false,
                            width: 260,
                            anchor: null,
                            value: fireNum(sched.dayOfMonth, FIRE_DEFAULTS.dayOfMonth),
                            hidden: !((sched.cadence || 'daily') === 'monthly'
                                || (sched.cadence || 'daily') === 'yearly')
                        },
                        {
                            xtype: 'component',
                            itemId: 'fireHint',
                            cls: 'anas-fld-sched-firehint',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            hidden: true,
                            html: ''
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'recursive',
                            cls: 'anas-fld-sched-recursive',
                            fieldLabel: t('Recursive'),
                            boxLabel: t('Include child datasets (zfs -r)'),
                            hidden: startKind !== 'zfs',
                            checked: !!sched.recursive
                        },
                        // snapx.1: child datasets a recursive schedule skips,
                        // each with everything beneath it. Shown only for a
                        // recursive ZFS schedule; lists the target's strict
                        // descendants, PVE-owned ones badged and selectable.
                        // The shared picker (10-api.js, ANAS.excludePicker) —
                        // the replication task dialog offers the same one.
                        ANAS.excludePicker.fieldCfg({
                            cls: 'anas-fld-sched-exclude',
                            store: excludeStore,
                            hidden: !(startKind === 'zfs' && sched.recursive)
                        }),
                        ANAS.excludePicker.hintCfg({
                            hidden: !(startKind === 'zfs' && sched.recursive),
                            extra: t('This schedule\'s own snapshots already on an excluded dataset are removed on its next run.')
                        }),
                        // --- Retention: presets + advanced per-bucket expander --
                        {
                            xtype: 'combobox',
                            itemId: 'preset',
                            cls: 'anas-fld-sched-preset',
                            fieldLabel: t('Retention'),
                            store: Ext.create('Ext.data.Store', { fields: ['value', 'label'], data: PRESETS.map(function (p) {
                                return { value: p.value, label: t(p.label) };
                            }) }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: startPreset
                        },
                        {
                            xtype: 'panel',
                            itemId: 'advanced',
                            cls: 'anas-sched-advanced',
                            title: t('Advanced — keep N per period'),
                            collapsible: true,
                            collapsed: startPreset !== 'custom',
                            titleCollapse: true,
                            border: false,
                            bodyPadding: '8 4 2 4',
                            margin: '4 0 0 0',
                            items: [
                                {
                                    xtype: 'component',
                                    style: 'color:var(--anas-muted,gray);font-size:11px;margin-bottom:8px;',
                                    html: enc(t('The N newest of each period are kept; the most recent overall is '
                                        + 'always kept. 0 = keep none of that period.'))
                                }
                            ].concat(BUCKETS.map(retentionFieldRow))
                        },
                        // --- Notifications (9.4) — the same knob Backup has ---
                        ANAS.notifyMode.field({
                            itemId: 'notifyMode',
                            cls: 'anas-fld-sched-notify',
                            value: notifyOf(sched)
                        }),
                        {
                            xtype: 'component',
                            style: 'margin:-4px 0 8px 152px;',
                            html: ANAS.notifyMode.hintHtml('fire', 'anas-snapshot')
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'enabled',
                            cls: 'anas-fld-sched-enabled',
                            fieldLabel: t('Enabled'),
                            boxLabel: t('Take snapshots on the schedule'),
                            checked: sched.enabled !== false
                        }
                    ]
                }],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: isEdit ? t('Save') : t('Create'),
                        itemId: 'submit',
                        cls: 'anas-btn-sched-submit',
                        handler: function () {
                            try {
                                submitSchedule(win, node, grid, isEdit);
                            } catch (e) {
                                ANAS.warn('schedule submit failed: ' + ANAS.errText(e));
                            }
                        }
                    }
                ]
            });
        } catch (e) {
            ANAS.warn('schedule window failed: ' + ANAS.errText(e));
            return;
        }

        var setVis = function (sel, vis) {
            var f = win.down(sel);
            if (f) {
                f.setHidden(!vis);
                // A hidden control must not block Save: ExtJS validates hidden
                // fields (only disabled ones are skipped), so an emptied `At`
                // hidden by switching to hourly would stop the submit with no
                // visible error (review of snaptime.2).
                if (f.setDisabled) { f.setDisabled(!vis); }
            }
        };

        // snapx.1: the Exclude picker shows for a recursive ZFS schedule only.
        var applyExcludeVis = function () {
            var vis = valOf(win, '#targetKind') === 'zfs' && !!valOf(win, '#recursive');
            setVis('#exclude', vis);
            setVis('#excludeHint', vis);
        };

        // Reveal the ZFS or AHR target fields as the filesystem kind changes.
        var applyKind = function (kind) {
            var zfs = kind === 'zfs';
            setVis('#zfsPool', zfs);
            setVis('#zfsDataset', zfs);
            setVis('#recursive', zfs);
            setVis('#ahrPool', !zfs);
            applyExcludeVis();
        };

        // snaptime.2: which fire controls the chosen cadence allows, and the
        // hint line under them. The clock sentence shows whenever the time
        // field shows (we fire in node-local time; snapshot names are UTC).
        // The shift sentence is added when the day is one the month may lack
        // — monthly 29/30/31 (the dialog shows a bare number, so unlike the
        // grid cell the 31st warns too), yearly judged against the month
        // picked. The dialog never computes the shift; systemd performs it.
        var applyFireVis = function (cad) {
            cad = cad || valOf(win, '#cadence') || 'daily';
            var showTime = cadenceHasTime(cad);
            var showDay = cad === 'monthly' || cad === 'yearly';
            setVis('#fireTime', showTime);
            setVis('#fireWeekday', cad === 'weekly');
            setVis('#fireMonth', cad === 'yearly');
            setVis('#fireDay', showDay);
            var hint = win.down('#fireHint');
            if (hint) {
                var html = '';
                if (showTime) {
                    html = enc(t('Node local time. Snapshot names carry the UTC date and time.'));
                    if (showDay && fireDayMayBeAbsent(cad,
                        valOf(win, '#fireDay'), valOf(win, '#fireMonth'), true)) {
                        html += enc(t(' In a shorter month it fires on the last day.'));
                    }
                }
                hint.setHidden(html === '');
                hint.setHtml(html);
            }
        };

        // snapx.1: the Exclude picker's options are the strict descendants of
        // the dataset picked right now, taken from the same dataset listing the
        // target picker reads (owned rows kept, badged). A picked dataset that
        // is no longer a descendant (the target changed) is dropped. On edit
        // the stored list seeds the selection once the listing has answered;
        // a stored entry the listing did not return stays selected and marked
        // (preserve and mark, as for a stored pool; the daemon accepts an
        // entry the schedule already carried).
        // The controller is the shared one (10-api.js, ANAS.excludePicker).
        var excludeSeed = (isEdit && sched.recursive && sched.exclude) ? sched.exclude.slice() : [];
        var excluder = ANAS.excludePicker.create({
            win: win,
            store: excludeStore,
            seed: excludeSeed,
            badgeCls: 'anas-sched-exclude-pve'
        });
        var refreshExclude = function () {
            var pool = valOf(win, '#zfsPool') || '';
            var rel = ('' + (valOf(win, '#zfsDataset') || '')).replace(/^\/+|\/+$/g, '');
            excluder.refresh(pool ? (rel ? (pool + '/' + rel) : pool) : '', pool);
        };

        // Reload the ZFS dataset combo when the ZFS pool changes. The pool's
        // summary rides along: the skew fallback reads its pveStorages from
        // there (an older daemon stamps no per-node field).
        var loadZfsDatasets = function (pool, preselectRel) {
            var summary = null;
            for (var i = 0; i < zfsSummaries.length; i++) {
                if (zfsSummaries[i].name === pool) {
                    summary = zfsSummaries[i];
                    break;
                }
            }
            loadDatasetOptions(node, pool, summary).then(function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                var opts = res.opts;
                // cr3: remembered for the save, which refuses a ZFS target
                // or an exclude list picked from a list that was never read.
                win.anasDatasetsUnreadable = res.unreadable || null;
                excluder.setRows(res.rows);
                zfsDsStore.loadData(opts);
                var fld = win.down('#zfsDataset');
                if (fld) {
                    var want = preselectRel !== undefined ? preselectRel
                        : (opts.length ? opts[0].rel : '');
                    fld.setValue(want);
                    if (res.unreadable) {
                        try {
                            // markInvalid renders HTML in its tip: encoded.
                            fld.markInvalid(enc(t('The datasets of this pool could not be read') + ': ' + res.unreadable));
                        } catch (eMark) {
                            // the save still refuses
                        }
                    }
                }
                refreshExclude();
            });
        };

        try {
            win.down('#targetKind').on('change', function (f) { applyKind(f.getValue()); });
            win.down('#zfsPool').on('change', function (f) { loadZfsDatasets(f.getValue(), undefined); });
            win.down('#zfsDataset').on('change', function () { refreshExclude(); });
            win.down('#recursive').on('change', function () { applyExcludeVis(); });
            // snaptime.2: the cadence decides which fire fields exist; the
            // day and the month decide whether the hint gains the shift
            // sentence.
            win.down('#cadence').on('change', function (f) { applyFireVis(f.getValue()); });
            win.down('#fireDay').on('change', function () { applyFireVis(); });
            win.down('#fireMonth').on('change', function () { applyFireVis(); });
            // Preset → fill the advanced fields; expand advanced only for Custom.
            win.down('#preset').on('change', function (f) {
                var val = f.getValue();
                var p = null;
                for (var i = 0; i < PRESETS.length; i++) {
                    if (PRESETS[i].value === val) { p = PRESETS[i]; break; }
                }
                var adv = win.down('#advanced');
                if (val === 'custom') {
                    if (adv) { adv.expand(); }
                    return;
                }
                if (p && p.retention) {
                    win._suppressPresetReset = true;
                    applyRetentionToFields(win, p.retention);
                    win._suppressPresetReset = false;
                    if (adv) { adv.collapse(); }
                }
            });
            // Editing any keep-N field flips the preset selector to Custom.
            for (var bi = 0; bi < BUCKETS.length; bi++) {
                var kf = win.down('#keep-' + BUCKETS[bi].key);
                if (kf) {
                    kf.on('change', function () {
                        if (win._suppressPresetReset) { return; }
                        var pc = win.down('#preset');
                        if (pc && pc.getValue() !== 'custom') {
                            win._suppressPresetReset = true;
                            pc.setValue('custom');
                            win._suppressPresetReset = false;
                        }
                    });
                }
            }
        } catch (eWire) {
            ANAS.warn('schedule wiring failed: ' + ANAS.errText(eWire));
        }

        win.show();
        // Inventory that came back without the schedule's own target blocks Save
        // by name (#40) — the stored target stays on screen either way.
        if (kindMissing) {
            ANAS.editGuard.block(win, 'targetKind', t('This schedule targets')
                + ' ' + (kindMissing === 'ahr' ? t('an AHR pool') : t('a ZFS dataset'))
                + ', ' + t('but no such filesystem was listed just now (the inventory may '
                    + 'have failed to load). Saving is blocked so the schedule cannot be '
                    + 'moved to a different filesystem — reload the view, or cancel.'));
        }
        if (zfsMissing) {
            ANAS.editGuard.block(win, 'zfsPool', t('ZFS pool') + ' "' + zfsMissing + '" '
                + t('was not listed just now. Saving is blocked so this schedule cannot '
                    + 'be moved to another pool — reload the view, or cancel.'));
        }
        if (ahrMissing) {
            ANAS.editGuard.block(win, 'ahrPool', t('AHR pool') + ' "' + ahrMissing + '" '
                + t('was not listed just now. Saving is blocked so this schedule cannot '
                    + 'be moved to another pool — reload the view, or cancel.'));
        }
        applyKind(startKind);
        applyFireVis();
        if (startKind === 'zfs') {
            loadZfsDatasets(defaultZfsPool,
                isEdit && target.kind === 'zfs' ? relOfFull(target.dataset, defaultZfsPool) : undefined);
        }
        // Seed the retention fields from the preset (new) or the saved policy (edit).
        win._suppressPresetReset = true;
        if (isEdit) {
            applyRetentionToFields(win, sched.retention || {});
        } else {
            applyRetentionToFields(win, PRESETS[0].retention);
        }
        win._suppressPresetReset = false;
    }

    function submitSchedule(win, node, grid, isEdit) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        // The edit guard has the last word: a blocked dialog sends NOTHING, even
        // if the disabled button was somehow reached (#40).
        var blocked = ANAS.editGuard.reason(win);
        if (blocked) {
            ANAS.alertMsg('Cannot save', blocked);
            return;
        }
        var name = ('' + (valOf(win, '#name') || '')).trim();
        if (!name) {
            ANAS.alertMsg('Invalid input', t('Enter a name.'));
            return;
        }
        var id = ('' + (valOf(win, '#id') || '')).trim();
        if (!ID_RE.test(id) || id.length > 255) {
            ANAS.alertMsg('Invalid input',
                t('Identifier must start alphanumeric and contain only letters, digits, and . _ -'));
            return;
        }

        var kind = valOf(win, '#targetKind');
        var target;
        if (kind === 'ahr') {
            var ahrPool = valOf(win, '#ahrPool');
            if (!ahrPool) {
                ANAS.alertMsg('Invalid input', t('Select an AHR pool.'));
                return;
            }
            target = { kind: 'ahr', pool: ahrPool };
        } else {
            var zfsPool = valOf(win, '#zfsPool');
            if (!zfsPool) {
                ANAS.alertMsg('Invalid input', t('Select a ZFS pool.'));
                return;
            }
            if (win.anasDatasetsUnreadable) {
                ANAS.alertMsg('Cannot save', t('The datasets of pool') + ' ' + zfsPool + ' '
                    + t('could not be read, so neither the dataset nor what to exclude can be chosen') + ': '
                    + win.anasDatasetsUnreadable + '. ' + t('Close the dialog and try again.'));
                return;
            }
            var rel = ('' + (valOf(win, '#zfsDataset') || '')).replace(/^\/+|\/+$/g, '');
            target = { kind: 'zfs', dataset: rel ? (zfsPool + '/' + rel) : zfsPool };
        }

        // snaptime.2: read the fire fields the chosen cadence allows. The
        // form already marks a bad time or day red in the browser; this is
        // the same rule as the dialog's usual invalid-input alert, checked
        // before anything is sent.
        var cad = valOf(win, '#cadence') || 'daily';
        var fireTime = '';
        var fireWeekday = '';
        var fireDay = 0;
        var fireMonth = 0;
        if (cadenceHasTime(cad)) {
            fireTime = ('' + (valOf(win, '#fireTime') || '')).trim();
            if (!FIRE_TIME_RE.test(fireTime)) {
                ANAS.alertMsg('Invalid input', t('A 24-hour time, HH:MM.'));
                return;
            }
        }
        if (cad === 'weekly') {
            fireWeekday = fireStr(valOf(win, '#fireWeekday'), FIRE_DEFAULTS.weekday);
        }
        if (cad === 'monthly' || cad === 'yearly') {
            fireDay = fireNum(valOf(win, '#fireDay'), 0);
            if (!(fireDay >= 1 && fireDay <= 31)) {
                ANAS.alertMsg('Invalid input', t('Pick a day of the month from 1 to 31.'));
                return;
            }
        }
        if (cad === 'yearly') {
            fireMonth = fireNum(valOf(win, '#fireMonth'), FIRE_DEFAULTS.month);
        }

        var retention = retentionFromFields(win);
        var body = {
            id: id,
            name: name,
            target: target,
            cadence: cad,
            retention: retention,
            notify: ANAS.notifyMode.of(valOf(win, '#notifyMode'), 'on-failure'),
            enabled: !!valOf(win, '#enabled')
        };
        // snaptime.2: EXACTLY the keys this cadence allows and none of the
        // others (a fire field on a cadence that refuses it is a 400), and
        // always every one of them — the value shown, default included. The
        // daemon stores a value equal to its default as absence, so sending
        // 00:00 / Mon / the 1st / January is exactly how a save says "this
        // field is back at its default". Numbers stay numbers.
        if (cadenceHasTime(cad)) {
            body.time = fireTime;
        }
        if (cad === 'weekly') {
            body.weekday = fireWeekday;
        }
        if (cad === 'monthly' || cad === 'yearly') {
            body.dayOfMonth = fireDay;
        }
        if (cad === 'yearly') {
            body.month = fireMonth;
        }
        if (kind === 'zfs' && valOf(win, '#recursive')) {
            body.recursive = true;
            // The key is ALWAYS sent on a recursive ZFS schedule (`[]` when
            // none): the daemon keeps the stored list when the key is ABSENT
            // (a 0.4.1 UI's PUT), so clearing the list must say so. An empty
            // list is stored as no list (the plain `-r`, unit byte-identical).
            body.exclude = (valOf(win, '#exclude') || []).slice();
        }

        // cr3 H2: a CREATE whose id is already stamped on snapshots under the
        // target (left by a deleted schedule of that id) is confirm-gated by
        // the daemon — its warnings say how many it would own and that an
        // excluded dataset's are destroyed. cr3 review fold: so is an EDIT
        // that newly excludes datasets carrying this schedule's own
        // snapshots (destroyed at its next run). confirmAndRun asks in both.
        ANAS.confirmAndRun({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/schedules/' + encodeURIComponent(id)) : '/schedules',
            body: body,
            view: win,
            confirmTitle: isEdit ? 'Destroy snapshots on excluded datasets?' : 'Adopt existing snapshots?',
            confirmIntro: isEdit ? t('This edit excludes datasets that hold snapshots this schedule took:')
                : t('Snapshots with this schedule id already exist:'),
            failTitle: isEdit ? 'Save failed' : 'Create failed',
            successMsg: isEdit ? (t('Schedule saved') + ': ' + name)
                : (t('Schedule created') + ': ' + name),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadSchedules(grid, node);
                verifyFireFieldsStored(node, id, body);
            }
        });
    }

    // The fire fields the daemon did NOT store, of those this save sent
    // (cr3, the version-skew could-not-verify item): an ANAS daemon older than
    // snaptime.1 parses the body with a schema that has no time / weekday /
    // dayOfMonth / month and drops them SILENTLY — the job completes and the
    // toast says saved, while the timer fires at the cadence's default. A
    // stored field equal to its default is stored as absence, so absence
    // compares as the default. Pure: (sent body, stored schedule) → names.
    function fireFieldsNotStored(sent, stored) {
        var missing = [];
        var fields = ['time', 'weekday', 'dayOfMonth', 'month'];
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            if (!sent || !Object.prototype.hasOwnProperty.call(sent, f)) {
                continue;
            }
            var had = (stored && stored[f] !== undefined && stored[f] !== null) ? stored[f] : FIRE_DEFAULTS[f];
            if (String(had) !== String(sent[f])) {
                missing.push(f);
            }
        }
        return missing;
    }

    // After a save, read the schedule back and SAY when the node did not keep
    // what was sent. Fail-open: a read that fails says nothing (the grid's own
    // reload already shows what the node holds).
    function verifyFireFieldsStored(node, id, sent) {
        try {
            ANAS.api.get(node, '/schedules/' + encodeURIComponent(id)).then(function (res) {
                var stored = res && res.data && res.data.schedule;
                if (!stored) {
                    return;
                }
                var missing = fireFieldsNotStored(sent, stored);
                if (missing.length) {
                    ANAS.alertMsg('Saved without the fire time',
                        t('The node saved this schedule without') + ' ' + missing.join(', ') + '. '
                        + t('Its ANAS daemon is older than this page, so the schedule fires at its cadence\'s default time. '
                            + 'Upgrade ANAS on that node, then edit the schedule again.'));
                }
            }, function () { /* fail-open: the grid reload shows what is stored */ });
        } catch (e) {
            ANAS.warn('schedule read-back failed: ' + ANAS.errText(e));
        }
    }

    // ---- Run Now (take + prune; surfaces held-and-retained) ----------------

    function runSchedule(node, grid, rec) {
        if (!rec) {
            return;
        }
        var id = rec.get('id');
        var name = rec.get('name') || id;
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/schedules/' + encodeURIComponent(id) + '/run',
            body: {},
            view: grid,
            failTitle: 'Run failed',
            onComplete: function (job) {
                var msg = t('Snapshot taken') + ' — ' + name;
                try {
                    var result = job && job.result;
                    if (result) {
                        if (result.taken) {
                            msg = t('Took') + ' ' + result.taken;
                        }
                        // `pruned` lists at most 50 names per dataset; the
                        // real total is `prunedCount` (absent from an older
                        // daemon — then the list is the count).
                        var pruned = (typeof result.prunedCount === 'number')
                            ? result.prunedCount
                            : (result.pruned || []).length;
                        // `skippedHeld` is capped like `pruned`; the real
                        // total is `heldCount` (fallback: the list).
                        var held = (typeof result.heldCount === 'number')
                            ? result.heldCount
                            : (result.skippedHeld || []).length;
                        var extra = [];
                        if (pruned) { extra.push(pruned + ' ' + t('pruned')); }
                        // snapprune.1: a recursive schedule prunes across its
                        // sweep; say over how many datasets.
                        var touched = (result.datasets || []).filter(function (d) {
                            return d && (d.pruned || d.held);
                        }).length;
                        if (touched > 1) { extra.push(t('across') + ' ' + touched + ' ' + t('datasets')); }
                        // Held snapshots are intentionally retained, NOT a failure (GT-7).
                        if (held) { extra.push(held + ' ' + t('held (kept)')); }
                        // Destroys ZFS refused (a clone depends on the
                        // snapshot) are noted per dataset, never a failure.
                        var refused = (result.datasets || []).reduce(function (sum, d) {
                            return sum + ((d && typeof d.refused === 'number') ? d.refused : 0);
                        }, 0);
                        if (refused) { extra.push(refused + ' ' + t('could not be destroyed')); }
                        if (extra.length) { msg += ' — ' + extra.join(', '); }
                    }
                } catch (e) {
                    // best-effort summary
                }
                ANAS.toast(msg);
                loadSchedules(grid, node);
            }
        });
    }

    // ---- Enable / Disable (PUT the schedule with enabled flipped) ----------

    function toggleSchedule(node, grid, rec) {
        if (!rec) {
            return;
        }
        var id = rec.get('id');
        var name = rec.get('name') || id;
        var raw = rec.get('raw') || {};
        var next = !rec.get('enabled');
        // Round-trip the full schedule with only `enabled` changed. The
        // fire fields (snaptime.2) are deliberately NOT part of this body:
        // on PUT an ABSENT key keeps the stored value, and a toggle never
        // changes the cadence, so whatever schedule.time / weekday /
        // dayOfMonth / month the schedule has survives untouched — and a
        // field the daemon stored as absence (its default) must not be
        // re-sent here just to have it stored as absence again.
        var body = {
            id: id,
            name: raw.name || name,
            target: raw.target || targetFromRecord(rec),
            cadence: raw.cadence || rec.get('cadence'),
            retention: raw.retention || rec.get('retention') || {},
            // 9.4: carry the notify mode through, or a toggle silently resets it
            // (the same trap the biweekly-cadence fix closed for backup tasks).
            notify: raw.notify || rec.get('notify') || 'on-failure',
            enabled: next
        };
        if (raw.recursive || (raw.target === undefined && rec.get('recursive'))) {
            body.recursive = true;
            // snapx.1: carry the exclude list, or a toggle silently drops it —
            // always as a key (`[]` when none), see the dialog's save.
            if ((raw.target || targetFromRecord(rec)).kind === 'zfs') {
                body.exclude = (raw.exclude || rec.get('exclude') || []).slice();
            }
        }
        ANAS.runJob({
            node: node,
            method: 'put',
            path: '/schedules/' + encodeURIComponent(id),
            body: body,
            view: grid,
            failTitle: 'Update failed',
            successMsg: next ? (t('Schedule enabled') + ': ' + name) : (t('Schedule disabled') + ': ' + name),
            onComplete: function () {
                loadSchedules(grid, node);
            }
        });
    }

    function targetFromRecord(rec) {
        if (rec.get('targetKind') === 'ahr') {
            return { kind: 'ahr', pool: rec.get('targetPath') };
        }
        return { kind: 'zfs', dataset: rec.get('targetPath') };
    }

    // ---- Delete (Ext.Msg confirm — removes the units, keeps snapshots) -----

    function deleteSchedule(node, grid, rec) {
        if (!rec) {
            return;
        }
        var id = rec.get('id');
        var name = rec.get('name') || id;
        try {
            Ext.Msg.confirm(
                t('Delete Snapshot Schedule'),
                t('Delete the schedule') + ' "' + enc(name) + '"? '
                    + t('This removes the schedule (its systemd units) only — the snapshots '
                        + 'it already took are kept.'),
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    // cr.46: runJob does exactly what this hand-rolled
                    // 202-poll did, plus the failure alert when the submission
                    // itself rejects — same shape as the replication task and
                    // backup task deletes.
                    ANAS.runJob({
                        node: node,
                        method: 'del',
                        path: '/schedules/' + encodeURIComponent(id),
                        view: grid,
                        failTitle: 'Delete failed',
                        successMsg: t('Schedule deleted') + ': ' + name,
                        onComplete: function () {
                            loadSchedules(grid, node);
                        },
                        // cr.45 review: a delete that ends failed or lost reloads
                        // the grid too — pollJob calls onFailed(null) for lost
                        // when there is no onLost, so one handler covers both.
                        onFailed: function () {
                            loadSchedules(grid, node);
                        },
                    });
                }
            );
        } catch (e) {
            ANAS.warn('schedule delete confirm failed: ' + ANAS.errText(e));
        }
    }

    // ======================================================================
    //  Detail / last-run log — GET /schedules/:id. Mirrors the backup Details
    //  window (68-backup.js): an on-demand snapshot (fetch on open + a Reload
    //  button, no polling) that surfaces the last run's EXIT STATUS and the
    //  recent journald blob the SAME way a backup task's detail does. This is
    //  where the operator sees "what happened on the last run" for a schedule.
    // ======================================================================

    function kv(label, value) {
        return '<tr><td style="padding:2px 14px 2px 0;color:var(--anas-muted,gray);'
            + 'white-space:nowrap;vertical-align:top;">' + enc(label)
            + '</td><td style="padding:2px 0;">' + value + '</td></tr>';
    }

    function mono(s) {
        return '<span style="font-family:monospace;font-size:0.92em;word-break:break-all;">'
            + enc(s) + '</span>';
    }

    function unitBlock(title, text) {
        if (!text) {
            return '';
        }
        return '<div style="margin-top:10px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + enc(title) + '</div>'
            + '<pre style="margin:0;padding:8px 10px;border-radius:6px;overflow-x:auto;'
            + 'background:rgba(127,127,127,0.10);font-size:12px;white-space:pre;">'
            + enc(text) + '</pre></div>';
    }

    // The last-run status line: the result pill + the numeric exit code, LABELED
    // (never a bare number). exit 0 on success; a nonzero code on failure. Null
    // (never run) reads as an explicit "never run", not "exit 0".
    function lastRunBlock(d) {
        var result = '' + (d.lastRunResult || 'unknown');
        var pill;
        if (result === 'success') {
            pill = pillHtml(t('success'), 'var(--anas-ok,#1f9c56)', '');
        } else if (result === 'failure') {
            pill = pillHtml(t('failure'), 'var(--anas-danger,#c23b2c)', '');
        } else if (result === 'running') {
            pill = pillHtml(t('running'), 'var(--anas-accent,#3468c0)', '');
        } else if (result === 'disabled') {
            pill = softPill(t('disabled'), 'var(--anas-muted,gray)', t(DISABLED_RESULT_TIP));
        } else if (result === 'never-run') {
            // The enabled twin of F9 — no run to date, timer on (see the grid).
            pill = softPill(t('never run'), 'var(--anas-muted,gray)', t(NEVER_RUN_TIP));
        } else if (result === 'unknown' && d.lastRunNote) {
            pill = sched.notRetainedPill(d.lastRunNote);
        } else {
            pill = softPill(t('never run'), 'var(--anas-muted,gray)', '');
        }
        var when = d.lastRunAt
            ? ' <span style="color:var(--anas-muted,gray);">' + enc(absTime(d.lastRunAt)) + '</span>'
            : '';
        var code = (d.lastRunExitCode !== undefined && d.lastRunExitCode !== null)
            ? ' <span style="color:var(--anas-muted,gray);">('
                + enc(t('exit code') + ' ' + d.lastRunExitCode) + ')</span>'
            : '';
        // The daemon's one-line reason there is nothing to show (F9), or why
        // a run's verdict is missing after a reboot (taskstatus.1).
        var noteText = d.statusNote || (result === 'unknown' ? (d.lastRunNote || '') : '');
        var note = noteText
            ? ' <span style="color:var(--anas-muted,gray);">' + enc('\u2014 ' + noteText) + '</span>'
            : '';
        return pill + code + when + note;
    }

    // The recent journald blob — the run's own log, bounded + recent-only, the
    // SAME "older history is not retained" caveat as the backup detail.
    function journalBlock(d) {
        var journal = d.journal;
        var head = '<div style="margin-top:12px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + '<i class="fa fa-history" style="margin-right:5px;"></i>'
            + enc(t('Recent runs (journald) — older history is not retained')) + '</div>';
        var body;
        if (journal) {
            body = '<pre style="margin:0;padding:8px 10px;border-radius:6px;overflow-x:auto;'
                + 'background:rgba(127,127,127,0.10);font-size:11px;white-space:pre-wrap;">'
                + enc(journal) + '</pre>';
        } else {
            body = '<div style="color:var(--anas-muted,gray);font-size:0.9em;">'
                + enc(t('No recent runs recorded.')) + '</div>';
        }
        return head + body + '</div>';
    }

    function scheduleDetailHtml(d) {
        if (!d) {
            return '<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('No detail returned for this schedule.')) + '</div>';
        }
        var s = d.schedule || {};
        var target = s.target || {};
        var targetText = sched.fsTag(target.kind, target.kind === 'ahr' ? t('AHR pool') : t('ZFS dataset'))
            + '<span style="font-family:monospace;font-size:0.92em;">'
            + enc(target.kind === 'ahr' ? (target.pool || '') : (target.dataset || '')) + '</span>';

        var rows = ''
            + kv(t('Schedule'), mono(s.name || s.id || ''))
            + kv(t('Identifier'), mono(s.id || ''))
            + kv(t('Target'), targetText)
            + kv(t('Cadence'), enc(cadenceText(s)))
            + kv(t('Retention'), '<span style="font-family:monospace;font-size:0.9em;">'
                + enc(retentionSummary(s.retention) || '—') + '</span>')
            + kv(t('Notifications'), ANAS.notifyMode.rowHtml(notifyOf(s), t('fire'), 'anas-snapshot'))
            + kv(t('Enabled'), s.enabled !== false
                ? '<span style="color:var(--anas-ok,#1f9c56);">' + enc(t('yes')) + '</span>'
                : '<span style="color:var(--anas-muted,gray);">' + enc(t('no')) + '</span>')
            + kv(t('Last run'), lastRunBlock(d))
            + kv(t('Next run'), d.overdue
                ? softPill(t('overdue'), 'var(--anas-warn,#b06a12)', '')
                : (d.nextRunAt ? enc(absTime(d.nextRunAt)) : '<span style="color:gray;">&mdash;</span>'));

        var html = '<div style="padding:10px 14px;">'
            + '<table style="border-collapse:collapse;width:100%;">' + rows + '</table>';
        html += journalBlock(d);
        // The unit + timer, verbatim — config-is-the-API transparency (Principle 13),
        // mirroring the backup detail.
        html += unitBlock(t('systemd service unit (as written)'), d.unit);
        html += unitBlock(t('systemd timer (as written)'), d.timer);
        html += '</div>';
        return html;
    }

    // Fetch GET /schedules/:id and render it into the detail window's body.
    // Called on open and by the window's Reload button — no polling.
    function loadDetailInto(win, node, id) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var body = win.down('#detailBody');
        if (!body) {
            return;
        }
        body.update('<div style="padding:12px 14px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
            + enc(t('loading…')) + '</div>');
        ANAS.api.get(node, '/schedules/' + encodeURIComponent(id)).then(function (res) {
            if (body.destroyed || body.destroying) {
                return;
            }
            try {
                body.update(scheduleDetailHtml(res && res.data));
            } catch (e) {
                ANAS.warn('schedule detail render failed: ' + ANAS.errText(e));
            }
        }, function (err) {
            if (body.destroyed || body.destroying) {
                return;
            }
            ANAS.warn('schedule detail load failed: ' + ANAS.errText(err));
            body.update('<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('Failed to load detail') + ': ' + ANAS.errText(err)) + '</div>');
        });
    }

    // Open the on-demand detail/log window (modal:false, snapshot semantics —
    // Reload is the refresh). Mirrors the backup Details window.
    function openScheduleDetailWindow(node, id, name) {
        if (!id) {
            return;
        }
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-sched-detail',
                title: t('Snapshot Schedule') + ': ' + enc(name || id),
                modal: false,
                width: 720,
                height: 500,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'detailBody',
                    cls: 'anas-sched-detail',
                    border: false,
                    scrollable: true,
                    html: ''
                }],
                buttons: [
                    {
                        text: t('Reload'),
                        cls: 'anas-btn-sched-detail-reload',
                        iconCls: 'fa fa-refresh',
                        handler: function () { loadDetailInto(win, node, id); }
                    },
                    { text: t('Close'), handler: function () { win.close(); } }
                ]
            });
        } catch (e) {
            ANAS.warn('schedule detail window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadDetailInto(win, node, id);
    }

    // ---- View --------------------------------------------------------------

    function schedulesView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'id', 'name', 'targetKind', 'targetPath', 'cadence', 'notify',
                'time', 'weekday', 'dayOfMonth', 'month',
                'lastRunResult', 'lastRunAt', 'nextRunAt', 'lastRunNote',
                { name: 'retention', type: 'auto' },
                { name: 'recursive', type: 'auto' },
                { name: 'exclude', type: 'auto' },
                { name: 'enabled', type: 'auto' },
                { name: 'overdue', type: 'auto' },
                { name: 'raw', type: 'auto' }
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }]
        });

        // Reload just this view's grid (the poll loop lives in ANAS.sched).
        var refresh = function (view, quiet) {
            try {
                var g = view.down('#schedGrid');
                if (g) { loadSchedules(g, node, quiet); }
            } catch (e) {
                ANAS.warn('snapshots refresh failed: ' + ANAS.errText(e));
            }
        };

        var tbar = [
            {
                text: t('Reload'),
                cls: 'anas-btn-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    var g = btn.up('panel').down('#schedGrid');
                    if (g) { loadSchedules(g, node, false); }
                }
            },
            {
                text: t('New Schedule…'),
                cls: 'anas-btn-sched-new',
                iconCls: 'fa fa-plus',
                handler: function (btn) {
                    openScheduleDialog(node, btn.up('grid'), null);
                }
            },
            '-',
            {
                text: t('Run Now'),
                itemId: 'schedRun',
                cls: 'anas-btn-sched-run',
                iconCls: 'fa fa-play-circle',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    runSchedule(node, grid, selectedSchedule(grid));
                }
            },
            {
                text: t('View log'),
                itemId: 'schedLog',
                cls: 'anas-btn-sched-log',
                iconCls: 'fa fa-file-text-o',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    var rec = selectedSchedule(grid);
                    if (rec) {
                        openScheduleDetailWindow(node, rec.get('id'), rec.get('name'));
                    }
                }
            },
            {
                text: t('Edit'),
                itemId: 'schedEdit',
                cls: 'anas-btn-sched-edit',
                iconCls: 'fa fa-pencil',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    var rec = selectedSchedule(grid);
                    openScheduleDialog(node, grid, rec ? (rec.get('raw') || scheduleFromRecord(rec)) : null);
                }
            },
            {
                text: t('Disable'),
                itemId: 'schedToggle',
                cls: 'anas-btn-sched-toggle',
                iconCls: 'fa fa-pause',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    toggleSchedule(node, grid, selectedSchedule(grid));
                }
            },
            {
                text: t('Delete'),
                itemId: 'schedDelete',
                cls: 'anas-btn-sched-delete',
                iconCls: 'fa fa-trash',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    deleteSchedule(node, grid, selectedSchedule(grid));
                }
            }
        ];

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-snapshots',
            title: t('Snapshots'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'schedGrid',
                    cls: 'anas-grid-schedules',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No snapshot schedules defined'),
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'name',
                            width: 200,
                            renderer: function (v, meta, rec) {
                                var name = enc(v == null ? '' : v);
                                var id = rec.get('id');
                                // Never truncate the id — show it as muted context under the name.
                                var idLine = (id && id !== v)
                                    ? '<div style="color:var(--anas-muted,gray);font-size:0.82em;">'
                                        + enc(id) + '</div>'
                                    : '';
                                return '<div>' + name + '</div>' + idLine;
                            }
                        },
                        {
                            text: t('Target'),
                            dataIndex: 'targetPath',
                            flex: 1,
                            minWidth: 220,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderTarget
                        },
                        {
                            text: t('Cadence'),
                            dataIndex: 'cadence',
                            // The longest cell text is `monthly on the last
                            // day 01:00` — the bucket word alone no longer fits.
                            width: 200,
                            renderer: renderCadence
                        },
                        {
                            text: t('Retention'),
                            dataIndex: 'retention',
                            width: 150,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderRetention
                        },
                        {
                            text: t('Last run'),
                            dataIndex: 'lastRunResult',
                            width: 170,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderLastRun
                        },
                        {
                            text: t('Next run'),
                            dataIndex: 'nextRunAt',
                            width: 120,
                            sortable: false,
                            menuDisabled: true,
                            renderer: renderNextRun
                        },
                        {
                            text: t('Enabled'),
                            dataIndex: 'enabled',
                            width: 100,
                            align: 'center',
                            renderer: renderEnabled
                        }
                    ],
                    tbar: ANAS.tbar(tbar),
                    listeners: {
                        selectionchange: function () { updateButtons(this); },
                        itemdblclick: function (grid, rec) {
                            openScheduleDialog(node, grid, rec ? (rec.get('raw') || scheduleFromRecord(rec)) : null);
                        }
                    }
                }
            ],
            // Refresh + visibility-gated poll loop live in ANAS.sched (shared).
            listeners: sched.viewListeners(refresh)
        };
    }

    // Reconstruct a schedule object from a grid record when the raw form is absent.
    function scheduleFromRecord(rec) {
        var out = {
            id: rec.get('id'),
            name: rec.get('name') || rec.get('id'),
            target: targetFromRecord(rec),
            cadence: rec.get('cadence'),
            retention: rec.get('retention') || {},
            notify: rec.get('notify') || 'on-failure',
            enabled: !!rec.get('enabled')
        };
        if (rec.get('recursive')) {
            out.recursive = true;
            var exclude = rec.get('exclude') || [];
            if (exclude.length) {
                out.exclude = exclude.slice();
            }
        }
        return out;
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['snapshots'] = {
        itemId: 'anas-snapshots',
        text: t('Snapshots'),
        iconCls: 'fa fa-clock-o',
        factory: function (node) {
            try {
                return schedulesView(node);
            } catch (e) {
                ANAS.warn('snapshots view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        }
    };
})();
