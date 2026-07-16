/*
 * ANAS — Replication view (Epic 5.5: story 5.5.3, stage 2).
 *
 * A dedicated top-level "Replication" menu item (sibling of Pools / Datasets /
 * Shares). Replication is an ongoing, scheduled process with configuration and
 * history — not a point-in-time dataset action — so it lives in its own view,
 * NOT bleeding into the Datasets menu (stage-1's surfaces were removed from
 * 60-datasets.js when this shipped).
 *
 * A task grid (source → target, schedule, lag, last run, next run, enabled),
 * create/edit/enable-disable/delete, and Run Now. Plus a relocated "Replicate
 * Once…" dialog — the stage-1 local one-shot send|recv with an honest plan
 * preview — whose source is now PICKED in the dialog (no dataset-row context).
 *
 * Task store = the systemd units themselves (the daemon generates/parses/rewrites
 * anas-repl-<name>.service + .timer). The grid reads their derived state; ZFS
 * snapshot state on both ends is the authoritative last-success/lag record.
 *
 * Data (paths relative to /v1):
 *   GET    /replication/tasks            → { data: [ { task, lastReplicatedSnapshot,
 *                                            lastReplicatedAt, snapshotsBehind,
 *                                            lastRunResult, nextRunAt } ] }
 *     task = { name, source:{pool,dataset}, target:{pool,dataset?}, schedule,
 *              snapshotFirst, enabled }
 *   POST   /replication/tasks            → ReplicationTask body (create)
 *   PUT    /replication/tasks/:name      → ReplicationTask body (edit / toggle)
 *   DELETE /replication/tasks/:name      → removes the schedule (units) only
 *   POST   /replication/tasks/:name/run  → { started: true }
 *
 * One-shot (relocated stage 1, story 5.5.1) — KEEP USING:
 *   GET    /pools                                     → { data: PoolSummary[] }
 *   GET    /pools/:name/datasets                      → { data: Dataset[] } (flat)
 *   GET    /pools/:name/datasets/<path>/snapshots     → { data: Snapshot[] }
 *   POST   /pools/:name/datasets/<path>/replicate/plan → { data: plan }
 *   POST   /pools/:name/datasets/<path>/replicate     → 202 { job }
 *   (empty relative path = pool root)
 *
 * Test hooks: view panel cls 'anas-view anas-view-replication', grid cls
 * 'anas-grid-replication', toolbar buttons 'anas-btn-repl-new' /
 * 'anas-btn-repl-once' / 'anas-btn-repl-run' / 'anas-btn-repl-edit' /
 * 'anas-btn-repl-toggle' / 'anas-btn-repl-delete', task dialog window
 * 'anas-win-repl-task', once dialog window 'anas-win-replicate' with plan line
 * 'anas-repl-plan' (danger class 'anas-repl-diverged'), one-shot submit
 * 'anas-btn-replicate-submit'.
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

    // Reload cadence while the view is visible — lighter than the dashboard's.
    var POLL_MS = 10000;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function alertMsg(title, msg) {
        try {
            Ext.Msg.alert(t(title), msg);
        } catch (e) {
            ANAS.warn(msg);
        }
    }

    // ---- Path helpers (view-local; do NOT reference 60-datasets.js) --------
    //
    // The daemon addresses a dataset by its path relative to the pool. The pool
    // root is the empty relative path (mirrors the stage-1 datasets helpers).

    function encPath(rel) {
        var parts = ('' + rel).split('/');
        for (var i = 0; i < parts.length; i++) {
            parts[i] = encodeURIComponent(parts[i]);
        }
        return parts.join('/');
    }

    // Build the /v1 path to a dataset resource (pool + relative path), optionally
    // with a sub-resource like 'replicate/plan'. rel '' targets the pool root.
    function datasetPathRel(pool, rel, sub) {
        var p = '/pools/' + encodeURIComponent(pool) + '/datasets/' + encPath(rel);
        if (sub) {
            p += '/' + sub;
        }
        return p;
    }

    // Full ZFS name → relative path within its pool ('' for the pool root).
    function relOfFull(fullName, pool) {
        if (!fullName || fullName === pool) {
            return '';
        }
        var prefix = pool + '/';
        return fullName.indexOf(prefix) === 0 ? fullName.substring(prefix.length) : fullName;
    }

    // ---- Small formatters --------------------------------------------------

    function fmtBytes(v) {
        try {
            return ANAS.formatBytes(v);
        } catch (e) {
            return '' + v;
        }
    }

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

    function absTime(iso) {
        if (!iso) {
            return '';
        }
        try {
            var d = new Date(iso);
            if (isNaN(d.getTime())) {
                return '' + iso;
            }
            if (typeof Ext !== 'undefined' && Ext.Date && typeof Ext.Date.format === 'function') {
                return Ext.Date.format(d, 'Y-m-d H:i');
            }
            return d.toLocaleString();
        } catch (e) {
            return '' + iso;
        }
    }

    function gfxReady() {
        return ANAS.gfx && ANAS.gfx.ready ? ANAS.gfx.ready() : false;
    }

    // ---- Renderers ---------------------------------------------------------

    function routeSide(pool, dataset) {
        var p = '' + (pool == null ? '' : pool);
        var d = '' + (dataset == null ? '' : dataset);
        d = d.replace(/^\/+|\/+$/g, '');
        return d ? (p + '/' + d) : p;
    }

    // Source → Target: "pool/ds → pool/ds" (pool root shows the bare pool name).
    function renderRoute(v, meta, rec) {
        var src = enc(routeSide(rec.get('sourcePool'), rec.get('sourceDataset')));
        var tgt = enc(routeSide(rec.get('targetPool'), rec.get('targetDataset')));
        return src + ' <span style="color:var(--anas-muted,gray);">&rarr;</span> ' + tgt;
    }

    // Schedule: the raw OnCalendar expression, with the full value as a tooltip
    // (a long expression may be truncated in the cell).
    function renderSchedule(v) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        return '<span title="' + enc(s) + '" style="font-family:monospace;font-size:0.92em;">'
            + enc(s) + '</span>';
    }

    // Lag: snapshotsBehind → 0 current (green), N behind (amber), null muted dash.
    function renderLag(v, meta, rec) {
        var behind = rec.get('snapshotsBehind');
        if (behind === undefined || behind === null || behind === '') {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var n = Number(behind);
        if (isNaN(n)) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        if (n <= 0) {
            if (gfxReady() && typeof ANAS.gfx.chip === 'function') {
                return ANAS.gfx.chip(t('current'), { good: true, title: t('Target is up to date') });
            }
            return '<span style="color:var(--anas-ok,#1f9c56);font-weight:600;">' + enc(t('current')) + '</span>';
        }
        var label = n + ' ' + t('behind');
        return '<span class="anas-repl-lag-behind" title="'
            + enc(n + ' ' + t('snapshots behind the source')) + '"'
            + ' style="display:inline-block;padding:1px 8px;border-radius:9px;font-size:0.85em;'
            + 'color:var(--anas-warn,#b06a12);'
            + 'background:color-mix(in srgb,var(--anas-warn,#b06a12) 15%,transparent);">'
            + enc(label) + '</span>';
    }

    function pillHtml(label, color, title) {
        return '<span' + (title ? ' title="' + enc(title) + '"' : '')
            + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:#fff;background:' + color + ';">' + enc(label) + '</span>';
    }

    // Last run: a result pill + the relative time of the last replicated snapshot.
    function renderLastRun(v, meta, rec) {
        var result = '' + (rec.get('lastRunResult') || 'unknown');
        var at = rec.get('lastReplicatedAt');
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
            pill = pillHtml(t('unknown'), 'var(--anas-muted,gray)', '');
        }
        var rel = at ? relTime(at) : '';
        if (rel) {
            pill += ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">' + enc(rel) + '</span>';
        }
        return pill;
    }

    function renderNextRun(v, meta, rec) {
        var at = rec.get('nextRunAt');
        if (!at) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var rel = relTime(at);
        return '<span title="' + enc(absTime(at)) + '">' + enc(rel || absTime(at)) + '</span>';
    }

    function renderEnabled(v, meta, rec) {
        var on = !!rec.get('enabled');
        if (on) {
            return pillHtml(t('Enabled'), 'var(--anas-ok,#1f9c56)', '');
        }
        return '<span style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:var(--anas-muted,gray);'
            + 'background:color-mix(in srgb,var(--anas-muted,gray) 18%,transparent);">'
            + enc(t('Disabled')) + '</span>';
    }

    // ---- Load / reload the task grid ---------------------------------------

    function loadTasks(grid, node) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        ANAS.api.get(node, '/replication/tasks').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            var list = (res && res.data) || [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(taskRow(list[i]));
            }
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('replication grid load failed: ' + ANAS.errText(e2));
            }
            updateButtons(grid);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            ANAS.warn('replication tasks load failed: ' + ANAS.errText(err));
        });
    }

    // Flatten a { task, ...runtime } entry into a grid record; keep the raw task
    // object under 'raw' so edit / enable-disable can round-trip it.
    function taskRow(entry) {
        entry = entry || {};
        var task = entry.task || {};
        var src = task.source || {};
        var tgt = task.target || {};
        return {
            name: task.name,
            sourcePool: src.pool,
            sourceDataset: src.dataset,
            targetPool: tgt.pool,
            targetDataset: tgt.dataset,
            schedule: task.schedule,
            snapshotFirst: !!task.snapshotFirst,
            enabled: task.enabled !== false,
            lastReplicatedSnapshot: entry.lastReplicatedSnapshot,
            lastReplicatedAt: entry.lastReplicatedAt,
            snapshotsBehind: entry.snapshotsBehind,
            lastRunResult: entry.lastRunResult || 'unknown',
            nextRunAt: entry.nextRunAt,
            raw: task,
        };
    }

    ANAS.replication = ANAS.replication || {};
    ANAS.replication.reload = loadTasks;

    // ---- Selection + toolbar state -----------------------------------------

    function selectedTask(grid) {
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
        var rec = selectedTask(grid);
        var has = !!rec;
        setDisabled(grid, 'replRun', !has);
        setDisabled(grid, 'replEdit', !has);
        setDisabled(grid, 'replToggle', !has);
        setDisabled(grid, 'replDelete', !has);
        // The toggle label follows the selected task's state.
        try {
            var toggle = grid.down('#replToggle');
            if (toggle) {
                var on = has && rec.get('enabled');
                toggle.setText(on ? t('Disable') : t('Enable'));
                toggle.setIconCls(on ? 'fa fa-pause' : 'fa fa-play');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ---- ANAS pool + dataset pickers (exclude PVE-managed pools) ------------

    // A pool is PVE-managed iff its summary carries a non-empty pveStorages[].
    // Fail-open: missing/malformed ⇒ ANAS-managed.
    function isPveManaged(pool) {
        try {
            var ps = pool && pool.pveStorages;
            return !!(ps && ps.length);
        } catch (e) {
            return false;
        }
    }

    // Resolve to an array of ANAS-managed pool names; never rejects.
    function loadAnasPools(node) {
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
            ANAS.warn('replication pools load failed: ' + ANAS.errText(err));
            return [];
        });
    }

    // Resolve to a list of { rel, label } dataset options for a pool: the pool
    // root '(pool root)' first, then each dataset's relative path. Never rejects.
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
                        continue; // the pool root is already the first option
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
                ANAS.warn('replication datasets load failed for ' + pool + ': ' + ANAS.errText(err));
                return opts;
            }
        );
    }

    function poolComboStore(names) {
        var data = [];
        for (var i = 0; i < names.length; i++) {
            data.push({ name: names[i] });
        }
        return Ext.create('Ext.data.Store', { fields: ['name'], data: data });
    }

    // ======================================================================
    //  Task dialog (create / edit) — 'anas-win-repl-task'
    // ======================================================================

    var NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

    function openTaskDialog(node, grid, existing) {
        var isEdit = !!existing;
        var task = existing || {};
        var src = task.source || {};
        var tgt = task.target || {};

        loadAnasPools(node).then(function (names) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!names.length) {
                ANAS.toast(t('No ANAS-managed pool is available for replication.'));
                return;
            }
            buildTaskWindow(node, grid, isEdit, task, src, tgt, names);
        });
    }

    function buildTaskWindow(node, grid, isEdit, task, src, tgt, names) {
        var srcPoolStore = poolComboStore(names);
        var tgtPoolStore = poolComboStore(names);
        var srcDsStore = Ext.create('Ext.data.Store', { fields: ['rel', 'label'], data: [] });

        var defaultSrcPool = src.pool && names.indexOf(src.pool) >= 0 ? src.pool : names[0];
        var defaultTgtPool = tgt.pool && names.indexOf(tgt.pool) >= 0 ? tgt.pool : names[0];

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-repl-task',
                title: isEdit ? (t('Edit Replication Task') + ': ' + (task.name || ''))
                    : t('New Replication Task'),
                modal: true,
                width: 520,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'name',
                            cls: 'anas-fld-repl-name',
                            fieldLabel: t('Task name'),
                            emptyText: 'nightly-media',
                            disabled: isEdit,
                            allowBlank: false,
                            value: task.name || '',
                            regex: NAME_RE,
                            maxLength: 64,
                            regexText: t('Lowercase letters, digits and hyphens; must start with a letter or digit.'),
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'sourcePool',
                            cls: 'anas-fld-repl-src-pool',
                            fieldLabel: t('Source pool'),
                            store: srcPoolStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            allowBlank: false,
                            value: defaultSrcPool,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'sourceDataset',
                            cls: 'anas-fld-repl-src-dataset',
                            fieldLabel: t('Source dataset'),
                            store: srcDsStore,
                            valueField: 'rel',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            emptyText: t('(loading…)'),
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'targetPool',
                            cls: 'anas-fld-repl-tgt-pool',
                            fieldLabel: t('Target pool'),
                            store: tgtPoolStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            allowBlank: false,
                            value: defaultTgtPool,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'targetDataset',
                            cls: 'anas-fld-repl-tgt-dataset',
                            fieldLabel: t('Target dataset'),
                            emptyText: 'backup/media',
                            value: (tgt.dataset || ''),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'schedule',
                            cls: 'anas-fld-repl-schedule',
                            fieldLabel: t('Schedule'),
                            emptyText: 'daily',
                            allowBlank: false,
                            value: (task.schedule || ''),
                        },
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            html: enc(t('systemd OnCalendar — e.g. "daily", "02:00", '
                                + '"Mon *-*-* 03:00". Validated when saved.')),
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'snapshotFirst',
                            cls: 'anas-fld-repl-snapfirst',
                            fieldLabel: t('Snapshot first'),
                            boxLabel: t('Take a fresh snapshot before each run'),
                            checked: task.snapshotFirst !== false,
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'enabled',
                            cls: 'anas-fld-repl-enabled',
                            fieldLabel: t('Enabled'),
                            boxLabel: t('Run on the schedule'),
                            checked: task.enabled !== false,
                        },
                    ],
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () { win.close(); },
                    },
                    {
                        text: isEdit ? t('Save') : t('Create'),
                        cls: 'anas-btn-repl-task-submit',
                        handler: function () {
                            try {
                                submitTask(win, node, grid, isEdit);
                            } catch (e) {
                                ANAS.warn('replication task submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('replication task window failed: ' + ANAS.errText(e));
            return;
        }

        // Reload the source-dataset combo whenever the source pool changes.
        var loadSrcDatasets = function (pool, preselectRel) {
            loadDatasetOptions(node, pool).then(function (opts) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                srcDsStore.loadData(opts);
                var fld = win.down('#sourceDataset');
                if (fld) {
                    var want = preselectRel !== undefined ? preselectRel
                        : (opts.length ? opts[0].rel : '');
                    fld.setValue(want);
                }
            });
        };

        try {
            win.down('#sourcePool').on('change', function (f) {
                loadSrcDatasets(f.getValue(), undefined);
            });
        } catch (eWire) {
            ANAS.warn('replication task wiring failed: ' + ANAS.errText(eWire));
        }

        win.show();
        // Initial dataset list — preselect the existing source dataset on edit.
        loadSrcDatasets(defaultSrcPool, isEdit ? (src.dataset || '') : undefined);
    }

    function valOf(win, sel) {
        try {
            var f = win.down(sel);
            return f ? f.getValue() : undefined;
        } catch (e) {
            return undefined;
        }
    }

    function submitTask(win, node, grid, isEdit) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var name = ('' + (valOf(win, '#name') || '')).trim();
        if (!NAME_RE.test(name) || name.length > 64) {
            alertMsg('Invalid input',
                t('Task name must be lowercase letters, digits and hyphens (≤64 chars).'));
            return;
        }
        var sourcePool = valOf(win, '#sourcePool');
        var targetPool = valOf(win, '#targetPool');
        if (!sourcePool || !targetPool) {
            alertMsg('Invalid input', t('Select a source and target pool.'));
            return;
        }
        var schedule = ('' + (valOf(win, '#schedule') || '')).trim();
        if (!schedule) {
            alertMsg('Invalid input', t('Enter a schedule.'));
            return;
        }
        var sourceDataset = ('' + (valOf(win, '#sourceDataset') || '')).replace(/^\/+|\/+$/g, '');
        var targetDataset = ('' + (valOf(win, '#targetDataset') || '')).replace(/^\/+|\/+$/g, '');

        var body = {
            name: name,
            source: { pool: sourcePool, dataset: sourceDataset },
            target: { pool: targetPool },
            schedule: schedule,
            snapshotFirst: !!valOf(win, '#snapshotFirst'),
            enabled: !!valOf(win, '#enabled'),
        };
        if (targetDataset) {
            body.target.dataset = targetDataset;
        }

        // Create → POST; edit → PUT :name. The daemon may answer with a job
        // (202 { job }) or a plain 200 — runJob handles both (a jobless response
        // resolves straight to onComplete).
        ANAS.runJob({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/replication/tasks/' + encodeURIComponent(name)) : '/replication/tasks',
            body: body,
            view: win,
            failTitle: isEdit ? 'Save failed' : 'Create failed',
            successMsg: isEdit ? (t('Replication task saved') + ': ' + name)
                : (t('Replication task created') + ': ' + name),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadTasks(grid, node);
            },
        });
    }

    // ---- Run Now -----------------------------------------------------------

    function runTask(node, grid, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        ANAS.api.post(node, '/replication/tasks/' + encodeURIComponent(name) + '/run', {}).then(
            function () {
                ANAS.toast(t('Replication started') + ': ' + name);
                loadTasks(grid, node);
            },
            function (err) {
                ANAS.warn('replication run failed: ' + ANAS.errText(err));
                alertMsg('Run failed', t('Failed to start replication') + ': ' + ANAS.errText(err));
            }
        );
    }

    // ---- Enable / Disable (PUT the task with enabled flipped) --------------

    function toggleTask(node, grid, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        var raw = rec.get('raw') || {};
        var next = !rec.get('enabled');
        // Round-trip the full task with only `enabled` changed.
        var body = {
            name: name,
            source: raw.source || { pool: rec.get('sourcePool'), dataset: rec.get('sourceDataset') },
            target: raw.target || { pool: rec.get('targetPool') },
            schedule: raw.schedule || rec.get('schedule'),
            snapshotFirst: raw.snapshotFirst !== undefined ? !!raw.snapshotFirst : !!rec.get('snapshotFirst'),
            enabled: next,
        };
        if (!body.target.dataset && rec.get('targetDataset')) {
            body.target.dataset = rec.get('targetDataset');
        }
        ANAS.runJob({
            node: node,
            method: 'put',
            path: '/replication/tasks/' + encodeURIComponent(name),
            body: body,
            view: grid,
            failTitle: 'Update failed',
            successMsg: next ? (t('Task enabled') + ': ' + name) : (t('Task disabled') + ': ' + name),
            onComplete: function () {
                loadTasks(grid, node);
            },
        });
    }

    // ---- Delete (Ext.Msg confirm — removes the schedule only) --------------

    function deleteTask(node, grid, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try {
            Ext.Msg.confirm(
                t('Delete Replication Task'),
                t('Delete the replication task') + ' "' + enc(name) + '"? '
                    + t('This removes the schedule (its systemd units) only — '
                        + 'already-replicated snapshots on the target are kept.'),
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    ANAS.api.del(node, '/replication/tasks/' + encodeURIComponent(name)).then(
                        function () {
                            ANAS.toast(t('Replication task deleted') + ': ' + name);
                            loadTasks(grid, node);
                        },
                        function (err) {
                            ANAS.warn('replication delete failed: ' + ANAS.errText(err));
                            alertMsg('Delete failed',
                                t('Failed to delete task') + ': ' + ANAS.errText(err));
                        }
                    );
                }
            );
        } catch (e) {
            ANAS.warn('replication delete confirm failed: ' + ANAS.errText(e));
        }
    }

    // ======================================================================
    //  Replicate Once dialog (relocated stage 1, story 5.5.1)
    //  Window 'anas-win-replicate', plan line 'anas-repl-plan'. Source is PICKED
    //  here (no dataset-row context). Runs a LOCAL one-shot send|recv job after
    //  showing an honest plan (full / incremental / diverged) preview.
    // ======================================================================

    function atLabel(s) {
        s = '' + (s == null ? '' : s);
        var i = s.lastIndexOf('@');
        return i >= 0 ? s.substring(i) : ('@' + s);
    }

    function setOnceSubmit(win, enabled) {
        try {
            var btn = win.down('#onceSubmit');
            if (btn) {
                btn.setDisabled(!enabled);
            }
        } catch (e) {
            // non-fatal
        }
    }

    function updatePlanCmp(win, html, diverged) {
        try {
            var cmp = win.down('#planLine');
            if (!cmp) {
                return;
            }
            if (diverged) {
                cmp.addCls('anas-repl-diverged');
            } else {
                cmp.removeCls('anas-repl-diverged');
            }
            cmp.update(html == null ? '' : html);
        } catch (e) {
            // display hint only
        }
    }

    function renderCalculating(win) {
        updatePlanCmp(win, '<span style="color:gray;">' + enc(t('calculating…')) + '</span>', false);
    }

    function renderUnavailable(win) {
        updatePlanCmp(win, '<span style="color:gray;">' + enc(t('plan unavailable')) + '</span>', false);
        setOnceSubmit(win, true);
    }

    function renderPlan(win, plan) {
        if (!plan) {
            renderUnavailable(win);
            return;
        }
        win._lastPlan = plan;
        if (plan.targetDiverged) {
            var msg = t('Target exists with no common snapshot — replication cannot '
                + 'proceed; choose a different target');
            var html;
            if (ANAS.gfx && typeof ANAS.gfx.callout === 'function') {
                html = ANAS.gfx.callout(enc(msg), { level: 'bad' });
            } else {
                html = '<span style="color:#c23b2c;font-weight:600;">' + enc(msg) + '</span>';
            }
            updatePlanCmp(win, html, true);
            setOnceSubmit(win, false);
            return;
        }
        var bytes = fmtBytes(plan.estimatedBytes);
        var sizeText = bytes ? ('~' + bytes) : t('unknown size');
        var out;
        if (plan.mode === 'incremental') {
            var base = plan.baseSnapshot
                ? (' <span style="color:gray;">(' + enc(t('base')) + ' '
                    + enc(atLabel(plan.baseSnapshot)) + ')</span>')
                : '';
            out = '<span style="color:var(--anas-ok,#1f9c56);font-weight:600;">'
                + enc(t('Incremental')) + '</span> &mdash; ' + enc(sizeText) + base;
        } else {
            out = '<span style="color:var(--anas-warn,#b06a12);font-weight:700;">'
                + enc(t('FULL send')) + '</span> &mdash; '
                + '<span style="color:var(--anas-warn,#b06a12);">' + enc(sizeText) + '</span>';
        }
        updatePlanCmp(win, out, false);
        setOnceSubmit(win, true);
    }

    function fetchPlan(win, node) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var srcPool = valOf(win, '#srcPool');
        var srcRel = ('' + (valOf(win, '#srcDataset') || '')).replace(/^\/+|\/+$/g, '');
        var targetPool = valOf(win, '#targetPool');
        if (!srcPool || !targetPool) {
            renderUnavailable(win);
            return;
        }
        var body = { target: { pool: targetPool } };
        var targetDs = ('' + (valOf(win, '#targetDataset') || '')).replace(/^\/+|\/+$/g, '');
        if (targetDs) {
            body.target.dataset = targetDs;
        }
        if (!valOf(win, '#snapshotFirst')) {
            var snap = valOf(win, '#snapshot');
            if (snap) {
                body.snapshot = snap;
            }
        }
        var seq = (win._planSeq = (win._planSeq || 0) + 1);
        renderCalculating(win);
        ANAS.api.post(node, datasetPathRel(srcPool, srcRel, 'replicate/plan'), body).then(
            function (res) {
                if (win.destroyed || win.destroying || seq !== win._planSeq) {
                    return;
                }
                renderPlan(win, (res && res.data) || null);
            },
            function (err) {
                if (win.destroyed || win.destroying || seq !== win._planSeq) {
                    return;
                }
                ANAS.warn('replicate plan failed: ' + ANAS.errText(err));
                renderUnavailable(win);
            }
        );
    }

    // Load the picked source's snapshots into the combo; preselect the newest.
    function loadOnceSnapshots(win, node) {
        var srcPool = valOf(win, '#srcPool');
        var srcRel = ('' + (valOf(win, '#srcDataset') || '')).replace(/^\/+|\/+$/g, '');
        var snapFld = win.down('#snapshot');
        var store = snapFld && snapFld.getStore();
        if (!srcPool || !store) {
            return;
        }
        store.loadData([]);
        ANAS.api.get(node, datasetPathRel(srcPool, srcRel, 'snapshots')).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var snaps = ((res && res.data) || []).slice().sort(function (a, b) {
                var ca = new Date(a && a.created).getTime() || 0;
                var cb = new Date(b && b.created).getTime() || 0;
                return cb - ca;
            });
            var data = [];
            for (var j = 0; j < snaps.length; j++) {
                var s = snaps[j] || {};
                data.push({
                    snapshotName: s.snapshotName,
                    label: '@' + s.snapshotName + (s.created ? '  (' + absTime(s.created) + ')' : ''),
                });
            }
            store.loadData(data);
            if (data.length && !valOf(win, '#snapshotFirst')) {
                snapFld.setValue(data[0].snapshotName);
            }
            fetchPlan(win, node);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.warn('replicate snapshot list failed: ' + ANAS.errText(err));
            fetchPlan(win, node);
        });
    }

    function openReplicateOnce(node, grid) {
        loadAnasPools(node).then(function (names) {
            if (!names.length) {
                ANAS.toast(t('No ANAS-managed pool is available for replication.'));
                return;
            }
            buildOnceWindow(node, grid, names);
        });
    }

    function buildOnceWindow(node, grid, names) {
        var srcPoolStore = poolComboStore(names);
        var tgtPoolStore = poolComboStore(names);
        var srcDsStore = Ext.create('Ext.data.Store', { fields: ['rel', 'label'], data: [] });
        var snapStore = Ext.create('Ext.data.Store', { fields: ['snapshotName', 'label'], data: [] });
        var defaultPool = names[0];

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-replicate',
                title: t('Replicate Once'),
                modal: true,
                width: 540,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'combobox',
                            itemId: 'srcPool',
                            cls: 'anas-fld-repl-src-pool',
                            fieldLabel: t('Source pool'),
                            store: srcPoolStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            allowBlank: false,
                            value: defaultPool,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'srcDataset',
                            cls: 'anas-fld-repl-src-dataset',
                            fieldLabel: t('Source dataset'),
                            store: srcDsStore,
                            valueField: 'rel',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            emptyText: t('(loading…)'),
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'targetPool',
                            cls: 'anas-fld-repl-pool',
                            fieldLabel: t('Target pool'),
                            store: tgtPoolStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            allowBlank: false,
                            value: defaultPool,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'targetDataset',
                            cls: 'anas-fld-repl-dataset',
                            fieldLabel: t('Target dataset'),
                            emptyText: defaultPool + '/replica',
                            selectOnFocus: true,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'snapshot',
                            cls: 'anas-fld-repl-snapshot',
                            fieldLabel: t('Snapshot'),
                            store: snapStore,
                            valueField: 'snapshotName',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            emptyText: t('(loading snapshots…)'),
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'snapshotFirst',
                            cls: 'anas-fld-repl-snapfirst',
                            fieldLabel: t('Snapshot first'),
                            boxLabel: t('Snapshot now and replicate'),
                        },
                        {
                            xtype: 'component',
                            itemId: 'planLine',
                            cls: 'anas-repl-plan',
                            margin: '10 0 0 0',
                            style: 'padding:8px 10px;border-radius:8px;'
                                + 'background:rgba(127,127,127,0.08);font-size:12px;',
                            html: '',
                        },
                    ],
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () { win.close(); },
                    },
                    {
                        text: t('Replicate'),
                        itemId: 'onceSubmit',
                        cls: 'anas-btn-replicate-submit',
                        disabled: true,
                        handler: function () {
                            try {
                                submitOnce(win, node, grid);
                            } catch (e) {
                                ANAS.warn('replicate submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('replicate once window failed: ' + ANAS.errText(e));
            return;
        }

        // Default the target dataset to '<source-rel>-replica' so the dialog opens
        // onto a valid, non-self plan (matches stage-1 same-pool behaviour).
        var seedTargetDefault = function () {
            var fld = win.down('#targetDataset');
            if (!fld || (fld.getValue() || '').length) {
                return;
            }
            var srcPool = valOf(win, '#srcPool');
            var targetPool = valOf(win, '#targetPool');
            var srcRel = ('' + (valOf(win, '#srcDataset') || '')).replace(/^\/+|\/+$/g, '');
            var baseName = srcRel || srcPool;
            if (targetPool === srcPool) {
                fld.setValue(baseName + '-replica');
            } else {
                fld.setValue(baseName);
            }
        };

        var replan = function () { fetchPlan(win, node); };

        var loadSrc = function (pool) {
            loadDatasetOptions(node, pool).then(function (opts) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                srcDsStore.loadData(opts);
                var fld = win.down('#srcDataset');
                if (fld) {
                    fld.setValue(opts.length ? opts[0].rel : '');
                }
                seedTargetDefault();
                loadOnceSnapshots(win, node);
            });
        };

        try {
            win.down('#srcPool').on('change', function (f) { loadSrc(f.getValue()); });
            win.down('#srcDataset').on('change', function () {
                seedTargetDefault();
                loadOnceSnapshots(win, node);
            });
            win.down('#targetPool').on('change', replan);
            win.down('#targetDataset').on('change', replan, null, { buffer: 400 });
            win.down('#snapshot').on('change', replan);
            win.down('#snapshotFirst').on('change', function (f) {
                var snapFld = win.down('#snapshot');
                if (snapFld) {
                    snapFld.setDisabled(!!f.getValue());
                }
                replan();
            });
        } catch (eWire) {
            ANAS.warn('replicate once wiring failed: ' + ANAS.errText(eWire));
        }

        win.show();
        renderCalculating(win);
        loadSrc(defaultPool);
    }

    function submitOnce(win, node, grid) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var srcPool = valOf(win, '#srcPool');
        var srcRel = ('' + (valOf(win, '#srcDataset') || '')).replace(/^\/+|\/+$/g, '');
        var targetPool = valOf(win, '#targetPool');
        if (!srcPool || !targetPool) {
            alertMsg('Invalid input', t('Select a source and target pool.'));
            return;
        }
        var targetDs = ('' + (valOf(win, '#targetDataset') || '')).replace(/^\/+|\/+$/g, '');
        var snapFirst = !!valOf(win, '#snapshotFirst');
        var snap = snapFirst ? '' : valOf(win, '#snapshot');
        if (!snapFirst && !snap) {
            alertMsg('Invalid input',
                t('Choose a snapshot, or check "Snapshot now and replicate".'));
            return;
        }

        var body = { target: { pool: targetPool } };
        if (targetDs) {
            body.target.dataset = targetDs;
        }
        if (snapFirst) {
            body.snapshotFirst = true;
        } else {
            body.snapshot = snap;
        }

        var srcLabel = routeSide(srcPool, srcRel);
        var targetLabel = targetPool + (targetDs ? ('/' + targetDs) : '');
        var suffix = '';
        var plan = win._lastPlan;
        if (plan && plan.mode) {
            var b = fmtBytes(plan.estimatedBytes);
            suffix = ' (' + plan.mode + (b ? ', ' + b : '') + ')';
        }

        ANAS.runJob({
            node: node,
            method: 'post',
            path: datasetPathRel(srcPool, srcRel, 'replicate'),
            body: body,
            view: win,
            failTitle: 'Replication failed',
            successMsg: t('Replicated') + ' ' + srcLabel + ' → ' + targetLabel + suffix,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadTasks(grid, node);
            },
        });
    }

    // ---- Poll loop control (visibility-gated; no leaked intervals) ---------

    function startPolling(grid, node) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        stopPolling(grid);
        try {
            grid._anasTimer = setInterval(function () {
                try {
                    if (!grid || grid.destroyed || grid.destroying) {
                        stopPolling(grid);
                        return;
                    }
                    if (typeof document !== 'undefined' && document.hidden) {
                        return;
                    }
                    if (typeof grid.isVisible === 'function' && !grid.isVisible()) {
                        return;
                    }
                    loadTasks(grid, node);
                } catch (tickErr) {
                    ANAS.warn('replication poll tick failed: ' + ANAS.errText(tickErr));
                }
            }, POLL_MS);
        } catch (e) {
            ANAS.warn('replication interval start failed: ' + ANAS.errText(e));
        }
    }

    function stopPolling(grid) {
        try {
            if (grid && grid._anasTimer) {
                clearInterval(grid._anasTimer);
                grid._anasTimer = null;
            }
        } catch (e) {
            // non-fatal
        }
    }

    function cleanup(grid) {
        stopPolling(grid);
        try {
            if (grid && grid._anasVisHandler && typeof document !== 'undefined'
                && document.removeEventListener) {
                document.removeEventListener('visibilitychange', grid._anasVisHandler);
                grid._anasVisHandler = null;
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ---- View --------------------------------------------------------------

    function replicationView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'sourcePool', 'sourceDataset', 'targetPool', 'targetDataset',
                'schedule', 'lastReplicatedSnapshot', 'lastReplicatedAt', 'lastRunResult', 'nextRunAt',
                { name: 'snapshotFirst', type: 'auto' },
                { name: 'enabled', type: 'auto' },
                { name: 'snapshotsBehind', type: 'auto' },
                { name: 'raw', type: 'auto' },
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        var tbar = [
            {
                text: t('Reload'),
                cls: 'anas-btn-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    loadTasks(btn.up('grid'), node);
                },
            },
            {
                text: t('New Task…'),
                cls: 'anas-btn-repl-new',
                iconCls: 'fa fa-plus',
                handler: function (btn) {
                    openTaskDialog(node, btn.up('grid'), null);
                },
            },
            {
                text: t('Replicate Once…'),
                cls: 'anas-btn-repl-once',
                iconCls: 'fa fa-bolt',
                handler: function (btn) {
                    openReplicateOnce(node, btn.up('grid'));
                },
            },
            '-',
            {
                text: t('Run Now'),
                itemId: 'replRun',
                cls: 'anas-btn-repl-run',
                iconCls: 'fa fa-play-circle',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    runTask(node, grid, selectedTask(grid));
                },
            },
            {
                text: t('Edit'),
                itemId: 'replEdit',
                cls: 'anas-btn-repl-edit',
                iconCls: 'fa fa-pencil',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    var rec = selectedTask(grid);
                    openTaskDialog(node, grid, rec ? (rec.get('raw') || taskFromRecord(rec)) : null);
                },
            },
            {
                text: t('Disable'),
                itemId: 'replToggle',
                cls: 'anas-btn-repl-toggle',
                iconCls: 'fa fa-pause',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    toggleTask(node, grid, selectedTask(grid));
                },
            },
            {
                text: t('Delete'),
                itemId: 'replDelete',
                cls: 'anas-btn-repl-delete',
                iconCls: 'fa fa-trash',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    deleteTask(node, grid, selectedTask(grid));
                },
            },
        ];

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-replication',
            title: t('Replication'),
            layout: 'fit',
            border: false,
            items: [{
                xtype: 'gridpanel',
                itemId: 'replGrid',
                cls: 'anas-grid-replication',
                border: false,
                store: store,
                selModel: { mode: 'SINGLE' },
                emptyText: t('No replication tasks defined'),
                columns: [
                    {
                        text: t('Name'),
                        dataIndex: 'name',
                        width: 160,
                        renderer: Ext.String.htmlEncode,
                    },
                    {
                        text: t('Source → Target'),
                        dataIndex: 'sourcePool',
                        flex: 1,
                        minWidth: 240,
                        sortable: false,
                        menuDisabled: true,
                        renderer: renderRoute,
                    },
                    {
                        text: t('Schedule'),
                        dataIndex: 'schedule',
                        width: 150,
                        renderer: renderSchedule,
                    },
                    {
                        text: t('Lag'),
                        dataIndex: 'snapshotsBehind',
                        width: 100,
                        align: 'center',
                        renderer: renderLag,
                    },
                    {
                        text: t('Last run'),
                        dataIndex: 'lastRunResult',
                        width: 180,
                        sortable: false,
                        menuDisabled: true,
                        renderer: renderLastRun,
                    },
                    {
                        text: t('Next run'),
                        dataIndex: 'nextRunAt',
                        width: 110,
                        renderer: renderNextRun,
                    },
                    {
                        text: t('Enabled'),
                        dataIndex: 'enabled',
                        width: 100,
                        align: 'center',
                        renderer: renderEnabled,
                    },
                ],
                tbar: tbar,
                listeners: {
                    afterrender: function (grid) {
                        loadTasks(grid, node);
                        startPolling(grid, node);
                        try {
                            grid._anasVisHandler = function () {
                                try {
                                    if (document.hidden) {
                                        stopPolling(grid);
                                    } else if (typeof grid.isVisible === 'function' && grid.isVisible()) {
                                        startPolling(grid, node);
                                    }
                                } catch (e2) {
                                    // non-fatal
                                }
                            };
                            if (typeof document !== 'undefined' && document.addEventListener) {
                                document.addEventListener('visibilitychange', grid._anasVisHandler);
                            }
                        } catch (e3) {
                            // non-fatal
                        }
                    },
                    activate: function (grid) {
                        loadTasks(grid, node);
                        startPolling(grid, node);
                    },
                    deactivate: function (grid) {
                        stopPolling(grid);
                    },
                    show: function (grid) {
                        startPolling(grid, node);
                    },
                    hide: function (grid) {
                        stopPolling(grid);
                    },
                    selectionchange: function () {
                        updateButtons(this);
                    },
                    itemdblclick: function (grid, rec) {
                        openTaskDialog(node, grid, rec ? (rec.get('raw') || taskFromRecord(rec)) : null);
                    },
                    beforedestroy: function (grid) {
                        cleanup(grid);
                    },
                    destroy: function (grid) {
                        cleanup(grid);
                    },
                },
            }],
        };
    }

    // Reconstruct a task object from a grid record when the raw form is absent.
    function taskFromRecord(rec) {
        var target = { pool: rec.get('targetPool') };
        if (rec.get('targetDataset')) {
            target.dataset = rec.get('targetDataset');
        }
        return {
            name: rec.get('name'),
            source: { pool: rec.get('sourcePool'), dataset: rec.get('sourceDataset') },
            target: target,
            schedule: rec.get('schedule'),
            snapshotFirst: !!rec.get('snapshotFirst'),
            enabled: !!rec.get('enabled'),
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['replication'] = {
        itemId: 'anas-replication',
        text: t('Replication'),
        iconCls: 'fa fa-retweet',
        factory: function (node) {
            try {
                return replicationView(node);
            } catch (e) {
                ANAS.warn('replication view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
