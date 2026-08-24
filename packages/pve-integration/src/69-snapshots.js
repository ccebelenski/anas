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
 *                  cadence, retention:{frequently?..yearly?}, recursive?, enabled,
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
 *                                  { taken, pruned[], skippedHeld[] })
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
        var rec2 = rec.get('recursive')
            ? ' <span title="' + enc(t('recursive (-r): includes child datasets')) + '"'
                + ' style="color:var(--anas-muted,gray);font-size:0.85em;">(-r)</span>'
            : '';
        return tag + '<span style="font-family:monospace;font-size:0.92em;">' + enc(path) + '</span>' + rec2;
    }

    // Cadence: the bucket a fired snapshot is taken into ("daily", "hourly", …).
    function renderCadence(v) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            return muted('&mdash;');
        }
        return '<span title="' + enc(t('a snapshot is taken into this period bucket')) + '">' + enc(s) + '</span>';
    }

    function renderRetention(v, meta, rec) {
        var summary = retentionSummary(rec.get('retention'));
        if (!summary) {
            return muted('&mdash;');
        }
        return '<span title="' + enc(t('keep N per period bucket (newest always kept)')) + '"'
            + ' style="font-family:monospace;font-size:0.9em;">' + enc(summary) + '</span>';
    }

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

    // `quiet` skips the loading mask so the timed poll refreshes in place; the
    // selected row is restored by schedule id (the replication pattern).
    function loadSchedules(grid, node, quiet) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        if (!quiet) {
            try { grid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        var priorId = null;
        try {
            var sel = grid.getSelectionModel().getSelection();
            priorId = (sel && sel.length) ? sel[0].get('id') : null;
        } catch (eS) {
            priorId = null;
        }
        ANAS.api.get(node, '/schedules').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!quiet) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
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
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!quiet) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
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
            retention: sched.retention || {},
            recursive: !!sched.recursive,
            notify: notifyOf(sched),
            enabled: sched.enabled !== false,
            lastRunResult: status.lastRunResult || 'unknown',
            lastRunAt: status.lastRunAt,
            nextRunAt: status.nextRunAt,
            overdue: !!status.overdue,
            raw: sched
        };
    }

    ANAS.schedules = ANAS.schedules || {};
    ANAS.schedules.reload = loadSchedules;
    // The schedule dialog's entry point, exposed so the edit-guard harness
    // (test/edit-retarget.harness.mjs) can open a real edit against stubbed
    // inventory. The view's own toolbar calls the local function directly.
    ANAS.schedules.openDialog = openScheduleDialog;

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

    // ---- Target pickers (ANAS-managed only; exclude PVE-managed pools) ------

    // A ZFS pool is PVE-managed iff its summary carries a non-empty pveStorages[].
    // Fail-open: missing/malformed ⇒ ANAS-managed.
    function isPveManaged(pool) {
        try {
            var ps = pool && pool.pveStorages;
            return !!(ps && ps.length);
        } catch (e) {
            return false;
        }
    }

    // ANAS-managed ZFS pool names; never rejects.
    function loadZfsPools(node) {
        return ANAS.api.get(node, '/pools').then(function (res) {
            var pools = (res && res.data) || [];
            var names = [];
            for (var i = 0; i < pools.length; i++) {
                if (!isPveManaged(pools[i])) {
                    names.push(pools[i].name);
                }
            }
            return names;
        }, function (err) {
            ANAS.warn('schedules ZFS pools load failed: ' + ANAS.errText(err));
            return [];
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
            return [];
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
    // dataset's relative path. `rel` '' is the pool root. Never rejects.
    function loadDatasetOptions(node, pool) {
        var opts = [{ rel: '', label: t('(pool root)') }];
        if (!pool) {
            return Promise.resolve(opts);
        }
        return ANAS.api.get(node, '/pools/' + encodeURIComponent(pool) + '/datasets').then(
            function (res) {
                var list = (res && res.data) || [];
                var rels = [];
                for (var i = 0; i < list.length; i++) {
                    var ds = list[i] || {};
                    if (ds.name === pool) {
                        continue;
                    }
                    var rel = relOfFull(ds.name, pool);
                    if (rel) {
                        rels.push(rel);
                    }
                }
                rels.sort();
                for (var j = 0; j < rels.length; j++) {
                    opts.push({ rel: rels[j], label: rels[j] });
                }
                return opts;
            },
            function (err) {
                ANAS.warn('schedules datasets load failed for ' + pool + ': ' + ANAS.errText(err));
                return opts;
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
    // NOTE: 65-replication.js carries these same edit-guard helpers for the
    // task dialog (#39) — deliberately identical, since the rule is one rule.
    // Their natural home is a shared ANAS.* helper in 10-api.js.

    var UNAVAILABLE = t('(unavailable)');

    function saveBlockReason(win) {
        var blocks = win._saveBlocks || {};
        var keys = Object.keys(blocks);
        for (var i = 0; i < keys.length; i++) {
            if (blocks[keys[i]]) {
                return blocks[keys[i]];
            }
        }
        return '';
    }

    // Disable Save and show WHY, in the dialog, in the operator's words.
    function refreshSaveGate(win) {
        var reason = saveBlockReason(win);
        try {
            var btn = win.down('#submit');
            if (btn) {
                btn.setDisabled(!!reason);
            }
            var note = win.down('#guardNote');
            if (note) {
                note.setHidden(!reason);
                note.setHtml(reason
                    ? '<div style="color:var(--anas-danger,#c23b2c);font-size:12px;">' + enc(reason) + '</div>'
                    : '');
            }
        } catch (e) {
            // Cosmetic only — submitSchedule re-checks the gate before it sends.
        }
    }

    function blockSave(win, key, reason) {
        win._saveBlocks = win._saveBlocks || {};
        win._saveBlocks[key] = reason;
        refreshSaveGate(win);
    }

    // The note the gate writes into, placed at the top of the dialog's form.
    function guardNoteCfg() {
        return {
            xtype: 'component',
            itemId: 'guardNote',
            cls: 'anas-edit-guard',
            hidden: true,
            margin: '0 0 8 0',
            html: ''
        };
    }

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
            var zfsPools = r[0] || [];
            var ahrPools = r[1] || [];
            // Nothing to point a NEW schedule at. An EDIT still opens: the
            // schedule already has a target, and the dialog's job is then to say
            // that the inventory is missing — not to disappear.
            if (!zfsPools.length && !ahrPools.length && !existing) {
                ANAS.toast(t('No ANAS-managed ZFS dataset or AHR pool is available to schedule.'));
                return;
            }
            buildScheduleWindow(node, grid, existing || null, zfsPools, ahrPools);
        });
    }

    function buildScheduleWindow(node, grid, existing, zfsPools, ahrPools) {
        var isEdit = !!existing;
        var sched = existing || {};
        var target = sched.target || {};
        var startKind = target.kind || (zfsPools.length ? 'zfs' : 'ahr');

        var zfsPoolStore = poolComboStore(zfsPools);
        var ahrPoolStore = poolComboStore(ahrPools);
        var zfsDsStore = Ext.create('Ext.data.Store', { fields: ['rel', 'label'], data: [] });

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
                title: isEdit ? (t('Edit Snapshot Schedule') + ': ' + (sched.name || sched.id || ''))
                    : t('New Snapshot Schedule'),
                modal: true,
                width: 540,
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
                        guardNoteCfg(),
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
                        {
                            xtype: 'checkboxfield',
                            itemId: 'recursive',
                            cls: 'anas-fld-sched-recursive',
                            fieldLabel: t('Recursive'),
                            boxLabel: t('Include child datasets (zfs -r)'),
                            hidden: startKind !== 'zfs',
                            checked: !!sched.recursive
                        },
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

        // Reveal the ZFS or AHR target fields as the filesystem kind changes.
        var applyKind = function (kind) {
            var zfs = kind === 'zfs';
            var setVis = function (sel, vis) {
                var f = win.down(sel);
                if (f) { f.setHidden(!vis); }
            };
            setVis('#zfsPool', zfs);
            setVis('#zfsDataset', zfs);
            setVis('#recursive', zfs);
            setVis('#ahrPool', !zfs);
        };

        // Reload the ZFS dataset combo when the ZFS pool changes.
        var loadZfsDatasets = function (pool, preselectRel) {
            loadDatasetOptions(node, pool).then(function (opts) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                zfsDsStore.loadData(opts);
                var fld = win.down('#zfsDataset');
                if (fld) {
                    var want = preselectRel !== undefined ? preselectRel
                        : (opts.length ? opts[0].rel : '');
                    fld.setValue(want);
                }
            });
        };

        try {
            win.down('#targetKind').on('change', function (f) { applyKind(f.getValue()); });
            win.down('#zfsPool').on('change', function (f) { loadZfsDatasets(f.getValue(), undefined); });
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
            blockSave(win, 'targetKind', t('This schedule targets')
                + ' ' + (kindMissing === 'ahr' ? t('an AHR pool') : t('a ZFS dataset'))
                + ', ' + t('but no such filesystem was listed just now (the inventory may '
                    + 'have failed to load). Saving is blocked so the schedule cannot be '
                    + 'moved to a different filesystem — reload the view, or cancel.'));
        }
        if (zfsMissing) {
            blockSave(win, 'zfsPool', t('ZFS pool') + ' "' + zfsMissing + '" '
                + t('was not listed just now. Saving is blocked so this schedule cannot '
                    + 'be moved to another pool — reload the view, or cancel.'));
        }
        if (ahrMissing) {
            blockSave(win, 'ahrPool', t('AHR pool') + ' "' + ahrMissing + '" '
                + t('was not listed just now. Saving is blocked so this schedule cannot '
                    + 'be moved to another pool — reload the view, or cancel.'));
        }
        applyKind(startKind);
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
        var blocked = saveBlockReason(win);
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
            var rel = ('' + (valOf(win, '#zfsDataset') || '')).replace(/^\/+|\/+$/g, '');
            target = { kind: 'zfs', dataset: rel ? (zfsPool + '/' + rel) : zfsPool };
        }

        var retention = retentionFromFields(win);
        var body = {
            id: id,
            name: name,
            target: target,
            cadence: valOf(win, '#cadence') || 'daily',
            retention: retention,
            notify: ANAS.notifyMode.of(valOf(win, '#notifyMode'), 'on-failure'),
            enabled: !!valOf(win, '#enabled')
        };
        if (kind === 'zfs' && valOf(win, '#recursive')) {
            body.recursive = true;
        }

        ANAS.runJob({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/schedules/' + encodeURIComponent(id)) : '/schedules',
            body: body,
            view: win,
            failTitle: isEdit ? 'Save failed' : 'Create failed',
            successMsg: isEdit ? (t('Schedule saved') + ': ' + name)
                : (t('Schedule created') + ': ' + name),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadSchedules(grid, node);
            }
        });
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
                        var pruned = (result.pruned || []).length;
                        var held = (result.skippedHeld || []).length;
                        var extra = [];
                        if (pruned) { extra.push(pruned + ' ' + t('pruned')); }
                        // Held snapshots are intentionally retained, NOT a failure (GT-7).
                        if (held) { extra.push(held + ' ' + t('held (kept)')); }
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
        // Round-trip the full schedule with only `enabled` changed.
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
                    ANAS.api.del(node, '/schedules/' + encodeURIComponent(id)).then(
                        function (res) {
                            // DELETE is a 202 job; if a job came back, poll it, else done.
                            var job = res && res.job;
                            if (job && job.id) {
                                ANAS.pollJob(node, job.id, {
                                    view: grid,
                                    successMsg: t('Schedule deleted') + ': ' + name,
                                    failTitle: 'Delete failed',
                                    onComplete: function () { loadSchedules(grid, node); }
                                });
                            } else {
                                ANAS.toast(t('Schedule deleted') + ': ' + name);
                                loadSchedules(grid, node);
                            }
                        },
                        function (err) {
                            ANAS.warn('schedule delete failed: ' + ANAS.errText(err));
                            ANAS.alertMsg('Delete failed',
                                t('Failed to delete schedule') + ': ' + ANAS.errText(err));
                        }
                    );
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
        return pill + code + when;
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
            + kv(t('Cadence'), enc('' + (s.cadence || '')))
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
                title: t('Snapshot Schedule') + ': ' + (name || id),
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
                'lastRunResult', 'lastRunAt', 'nextRunAt',
                { name: 'retention', type: 'auto' },
                { name: 'recursive', type: 'auto' },
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
                            width: 100,
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
                    tbar: tbar,
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
