/*
 * ANAS — Replication view (Epic 5.5: stories 5.5.1–5.5.3).
 *
 * Off-box replication (story 5.5.2): a cluster-wide Remotes registry (the
 * corosync store at /etc/pve/anas/remotes.json) managed here, and a
 * Target-location picker in the task + Replicate-Once dialogs so a replication
 * target can be This node, a cluster peer, or a registered external remote.
 *
 *   Remotes registry (paths relative to /v1):
 *     GET    /replication/remotes            → { data:{ version, remotes:[
 *              {name,host,port,user,hostKeyFingerprint?} ], publicKey } }
 *     POST   /replication/remotes            body { remote, expectedVersion }  (CAS, 202 job)
 *     PUT    /replication/remotes/:name      body { remote, expectedVersion }  (CAS, 202 job)
 *     DELETE /replication/remotes/:name?expectedVersion=N                      (CAS, 202 job)
 *       A 409 CONFLICT on any write = the registry moved under us: reload +
 *       toast + re-prompt, NEVER blind-retry.
 *     POST   /replication/remotes/test       body {host,port?,user?}   (pre-registration)
 *     POST   /replication/remotes/:name/test  ?pin=true / ?retrust=true optional
 *       → { data:{ stage:'unreachable'|'hostkey-unknown'|'hostkey-changed'
 *                        |'auth-failed'|'no-zfs'|'ok',
 *                  zfsVersion?, fingerprint?, knownFingerprint?, detail? } }
 *       'hostkey-changed' = the host presents a key that is NOT the pinned one
 *       (rebuilt/rekeyed remote — or something else answering). It carries BOTH
 *       fingerprints and is repaired only through the deliberate re-trust:
 *       show pinned vs presented, confirm, then re-test with ?retrust=true,
 *       which REPLACES the pinned key. Never automatic.
 *   Target locations:
 *     GET    /replication/locations          → { data:{ peers:string[], remotes:string[] } }
 *     GET    /replication/peers/:name/pools   → { data:string[] }
 *     GET    /replication/remotes/:name/pools → { data:string[] }
 *   Task / once bodies carry target.location = { kind:'local'|'peer'|'remote', name? }
 *   (omitted for local); plan/run endpoints are otherwise unchanged.
 *
 * Remotes test hooks: toolbar 'anas-btn-repl-remotes'; manager window
 * 'anas-win-repl-remotes'; add/edit wizard 'anas-win-repl-remote-edit' with
 * staged-test result area 'anas-remote-test', trust button
 * 'anas-btn-remote-trust' and re-trust button 'anas-btn-remote-retrust';
 * location combo (both dialogs) 'anas-fld-repl-location'; the edit guard's
 * blocked-Save note 'anas-edit-guard'.
 *
 * A dedicated top-level "Replication" menu item (sibling of Pools / Datasets /
 * Shares). Replication is an ongoing, scheduled process with configuration and
 * history — not a point-in-time dataset action — so it lives in its own view,
 * NOT bleeding into the Datasets menu.
 *
 * A task grid (source → target, schedule, lag, last run, next run, enabled),
 * create/edit/enable-disable/delete, and Run Now. Plus the "Replicate Once…"
 * dialog — a local one-shot send|recv with an honest plan preview — whose
 * source is picked in the dialog (no dataset-row context).
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
 *              snapshotFirst, enabled,
 *              notify ('always'|'on-failure' — when a finished run notifies
 *              through PVE; 9.4. ABSENT = 'on-failure', the quiet default a task
 *              stored before the field reads back as) }
 *   POST   /replication/tasks            → ReplicationTask body (create)
 *   PUT    /replication/tasks/:name      → ReplicationTask body (edit / toggle);
 *                                          ?retarget=true when the edit MOVES the
 *                                          source or target (the daemon refuses an
 *                                          unflagged move — an edit dialog may
 *                                          never substitute a stored endpoint)
 *   DELETE /replication/tasks/:name      → removes the schedule (units) only
 *   POST   /replication/tasks/:name/run  → { started: true }
 *
 * One-shot (story 5.5.1):
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
    // A non-local target is prefixed with a location tag: "→ remote: nas pool/ds".
    function renderRoute(v, meta, rec) {
        var src = enc(routeSide(rec.get('sourcePool'), rec.get('sourceDataset')));
        var tgt = enc(routeSide(rec.get('targetPool'), rec.get('targetDataset')));
        var kind = rec.get('targetLocationKind');
        var lname = rec.get('targetLocationName');
        var locTag = '';
        if ((kind === 'peer' || kind === 'remote') && lname) {
            locTag = '<span class="anas-repl-loc-tag" title="' + enc(kind + ': ' + lname) + '"'
                + ' style="display:inline-block;padding:0 6px;margin-right:5px;border-radius:8px;'
                + 'font-size:0.8em;color:var(--anas-accent,#3468c0);'
                + 'background:color-mix(in srgb,var(--anas-accent,#3468c0) 14%,transparent);">'
                + enc(kind + ': ' + lname) + '</span>';
        }
        return src + ' <span style="color:var(--anas-muted,gray);">&rarr;</span> ' + locTag + tgt;
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

    // The one sentence a `disabled` result carries — same words as the backup
    // and snapshot grids; one hole, one explanation (F9).
    var DISABLED_RESULT_TIP = 'Disabled — systemd does not keep the run history of a task whose timer is off, so there is no last result to show. The recent journald output on the detail is the only record left.';

    // The one sentence a `never-run` result carries — the enabled twin of the
    // F9 hole: an enabled unit is kept loaded by its timer, so empty run
    // timestamps mean it has never fired. Same words as the backup and
    // snapshot grids.
    var NEVER_RUN_TIP = 'this task has not run yet';

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
        } else if (result === 'disabled') {
            // Live-proof F9 — a disabled task's unit is unreferenced, so systemd
            // collects its run history and `Result=success` is only a property
            // default. ZFS still answers what actually replicated, beside this.
            pill = '<span title="' + enc(t(DISABLED_RESULT_TIP)) + '"'
                + ' style="display:inline-block;padding:0 8px;border-radius:9px;font-size:0.85em;'
                + 'color:var(--anas-muted,gray);border:1px solid var(--anas-muted,gray);">'
                + enc(t('disabled')) + '</span>';
        } else if (result === 'never-run') {
            // The enabled twin of F9 — an enabled unit is kept loaded by its
            // timer, so empty run timestamps mean it has never fired and
            // `Result=success` is only a property default. ZFS still answers
            // what actually replicated, beside this.
            pill = '<span title="' + enc(t(NEVER_RUN_TIP)) + '"'
                + ' style="display:inline-block;padding:0 8px;border-radius:9px;font-size:0.85em;'
                + 'color:var(--anas-muted,gray);border:1px solid var(--anas-muted,gray);">'
                + enc(t('never run')) + '</span>';
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

    // `quiet` skips the loading mask so the timed poll refreshes in place with
    // no visible flash; the selected row is restored by task name so the poll
    // doesn't drop it (the mounts/backup pattern applied back here).
    function loadTasks(grid, node, quiet) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        if (!quiet) {
            try {
                grid.setLoading(true);
            } catch (e) {
                // non-fatal
            }
        }
        var priorName = null;
        try {
            var sel = grid.getSelectionModel().getSelection();
            priorName = (sel && sel.length) ? sel[0].get('name') : null;
        } catch (eS) {
            priorName = null;
        }
        ANAS.api.get(node, '/replication/tasks').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!quiet) {
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
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
            if (priorName) {
                try {
                    var idx = grid.getStore().findExact('name', priorName);
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
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
            }
            ANAS.warn('replication tasks load failed: ' + ANAS.errText(err));
        });
    }

    // ---- Notifications (9.4) -----------------------------------------------
    // When a finished run notifies through PVE — backup's own two modes, but with
    // the QUIET default. ABSENT means 'on-failure' (the daemon's schema default),
    // which is exactly what every task created before the field reads back as.
    function notifyOf(task) {
        return ANAS.notifyMode.of(task && task.notify, 'on-failure');
    }

    // Flatten a { task, ...runtime } entry into a grid record; keep the raw task
    // object under 'raw' so edit / enable-disable can round-trip it.
    function taskRow(entry) {
        entry = entry || {};
        var task = entry.task || {};
        var src = task.source || {};
        var tgt = task.target || {};
        var loc = tgt.location || {};
        return {
            name: task.name,
            sourcePool: src.pool,
            sourceDataset: src.dataset,
            targetPool: tgt.pool,
            targetDataset: tgt.dataset,
            targetLocationKind: loc.kind || 'local',
            targetLocationName: loc.name || '',
            schedule: task.schedule,
            snapshotFirst: !!task.snapshotFirst,
            notify: notifyOf(task),
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

    // A pool row for a combo store. `label` is what the operator reads, so a
    // value inventory no longer lists can say so instead of silently looking
    // like any other pick.
    function poolRow(name, unavailable) {
        return {
            name: name,
            label: unavailable ? (name + ' ' + UNAVAILABLE) : name,
            unavailable: !!unavailable,
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
    //  Edit guard — an edit dialog NEVER substitutes stored identity (#39)
    // ======================================================================
    //
    // A CREATE dialog may pick a sensible default. An EDIT dialog may not: when
    // a stored pool or target location is missing from freshly-loaded inventory
    // (a pool exported, a remote de-registered, an endpoint that answered with
    // an empty list), falling back to the first row silently rewrites where the
    // task reads from or writes to. So the stored value stays on screen marked
    // "(unavailable)" and Save is BLOCKED with a named reason until the operator
    // decides — and the daemon refuses an unflagged retarget regardless.
    //
    // The gate machinery itself is the shared ANAS.editGuard in 10-api.js —
    // the snapshot schedule dialog (69-snapshots.js, #40) runs the same one.

    var UNAVAILABLE = t('(unavailable)');

    // ======================================================================
    //  Stage-3 shared helpers — target locations + CAS registry writes
    // ======================================================================

    // A location value is a stable key: 'local' | 'peer:<name>' | 'remote:<name>'.
    function locKey(kind, name) {
        return (kind === 'peer' || kind === 'remote') && name ? (kind + ':' + name) : 'local';
    }

    // GET /replication/locations → { peers, remotes }. Never rejects (fail-open:
    // a locations failure just leaves 'This node' as the only option).
    function loadLocations(node) {
        return ANAS.api.get(node, '/replication/locations').then(function (res) {
            var d = (res && res.data) || {};
            return { peers: d.peers || [], remotes: d.remotes || [] };
        }, function (err) {
            ANAS.warn('replication locations load failed: ' + ANAS.errText(err));
            return { peers: [], remotes: [] };
        });
    }

    // Build the location combo's store rows: This node first, then peers, then
    // registered remotes.
    function locationRows(locs) {
        var rows = [{ value: 'local', label: t('This node'), kind: 'local', name: '' }];
        var i;
        var peers = (locs && locs.peers) || [];
        for (i = 0; i < peers.length; i++) {
            rows.push({ value: locKey('peer', peers[i]), label: 'peer: ' + peers[i], kind: 'peer', name: peers[i] });
        }
        var remotes = (locs && locs.remotes) || [];
        for (i = 0; i < remotes.length; i++) {
            rows.push({ value: locKey('remote', remotes[i]), label: 'remote: ' + remotes[i], kind: 'remote', name: remotes[i] });
        }
        return rows;
    }

    // Resolve the location currently selected in a dialog to { kind, name }.
    // A value with no row in the store is UNRESOLVED, not local: it is flagged
    // so a caller can refuse rather than quietly write a same-node target (the
    // stored location's row is re-asserted on edit, so this is the safety net
    // behind that, not the normal path).
    function selectedLocation(win) {
        var value = '';
        try {
            var combo = win.down('#targetLocation');
            if (!combo) {
                return { kind: 'local', name: '' };
            }
            value = combo.getValue();
            var rec = combo.getStore().findRecord('value', value, 0, false, false, true);
            if (rec) {
                return { kind: rec.get('kind'), name: rec.get('name') };
            }
        } catch (e) {
            return { kind: 'local', name: '' };
        }
        if (!value || value === 'local') {
            return { kind: 'local', name: '' };
        }
        return { kind: 'local', name: '', unresolved: '' + value };
    }

    // Resolve the target-pool candidates for a location. Local → ANAS pools;
    // peer/remote → that location's pools endpoint. Never rejects; on an error
    // or empty list the caller falls back to free-text entry.
    //   → { names:[...], freeText:bool }
    function loadLocationPools(node, loc) {
        if (!loc || loc.kind === 'local' || !loc.name) {
            return loadAnasPools(node).then(function (names) {
                return { names: names, freeText: false };
            });
        }
        var seg = loc.kind === 'peer' ? 'peers' : 'remotes';
        var path = '/replication/' + seg + '/' + encodeURIComponent(loc.name) + '/pools';
        return ANAS.api.get(node, path).then(function (res) {
            var names = (res && res.data) || [];
            return { names: names, freeText: !names.length };
        }, function (err) {
            ANAS.warn('replication location pools failed for ' + loc.name + ': ' + ANAS.errText(err));
            return { names: [], freeText: true };
        });
    }

    var LOC_HINT = t('could not list pools — enter the pool name');

    // setEmptyText is version-dependent on ExtJS combos; guard it so a missing
    // method can never abort the surrounding repopulation logic.
    function setEmpty(combo, txt) {
        try {
            if (typeof combo.setEmptyText === 'function') {
                combo.setEmptyText(txt);
            } else {
                combo.emptyText = txt;
            }
        } catch (e) {
            // non-fatal — the placeholder is cosmetic
        }
    }

    // Repopulate a dialog's '#targetPool' combo from the chosen location. A
    // known pool set stays a strict pick-list; an empty/failed list flips the
    // combo to free-text with a hint. Honours win._pendingTargetPool (an edit's
    // saved pool) as the preselection, once.
    //
    // The preselection is NEVER substituted (#39): a saved target pool the
    // location no longer lists is kept, marked "(unavailable)", and blocks Save.
    // Only when there is no preselection at all — a create, or the operator
    // actively switching location — does the first pool become the default.
    // Returns a promise that settles once the combo reflects the location.
    function applyLocationToPoolCombo(win, node, loc) {
        var combo = win.down('#targetPool');
        if (!combo) {
            return Promise.resolve();
        }
        var preselect = win._pendingTargetPool;
        win._pendingTargetPool = undefined;
        try {
            combo.setValue('');
        } catch (ePre) {
            // non-fatal
        }
        setEmpty(combo, t('(loading pools…)'));
        // Hold Save while the list is in flight — the combo is empty right now.
        ANAS.editGuard.block(win, 'targetPool', t('Loading target pools…'));
        return loadLocationPools(node, loc).then(function (r) {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                var store = combo.getStore();
                var data = [];
                for (var i = 0; i < r.names.length; i++) {
                    data.push(poolRow(r.names[i], false));
                }
                var missing = preselect && r.names.indexOf(preselect) < 0 ? preselect : '';
                if (missing && !r.freeText) {
                    data.push(poolRow(missing, true));
                }
                store.loadData(data);
                if (r.freeText) {
                    // Editable free-text: the operator names a pool we can't list.
                    combo.forceSelection = false;
                    combo.setEditable(true);
                    setEmpty(combo, LOC_HINT);
                    if (preselect) {
                        combo.setValue(preselect);
                    }
                } else {
                    combo.forceSelection = true;
                    combo.setEditable(false);
                    setEmpty(combo, '');
                    combo.setValue(missing || preselect || r.names[0] || '');
                }
                if (missing && !r.freeText) {
                    ANAS.editGuard.block(win, 'targetPool', t('Target pool') + ' "' + missing + '" '
                        + t('is not in this location\'s pool list any more. Saving now would '
                            + 'replicate somewhere else — pick a target deliberately, or cancel.'));
                } else {
                    ANAS.editGuard.unblock(win, 'targetPool');
                }
            } catch (e) {
                ANAS.warn('replication pool combo repopulate failed: ' + ANAS.errText(e));
                // The combo is in an unknown state — keep Save shut, and say so.
                ANAS.editGuard.block(win, 'targetPool', t('The target pool list could not be built')
                    + ': ' + ANAS.errText(e));
            }
        });
    }

    // Wire a location combo (already added to the form as '#targetLocation') and
    // load its rows. `onAfterApply` (optional) fires after each repopulation so
    // the once dialog can re-plan. On edit, pass preLoc/prePool to preselect.
    //
    // The picker is ASYNCHRONOUS, and that window used to be open: a Save issued
    // before the locations answered wrote a LOCAL target over a remote task.
    // Save is therefore blocked from the moment the dialog opens until the store
    // has resolved AND the stored location has been re-asserted (#39).
    function wireLocationPicker(win, node, opts) {
        opts = opts || {};
        var combo = win.down('#targetLocation');
        if (!combo) {
            return;
        }
        ANAS.editGuard.block(win, 'location', t('Loading target locations…'));
        var apply = function () {
            applyLocationToPoolCombo(win, node, selectedLocation(win));
            if (opts.onAfterApply) {
                opts.onAfterApply();
            }
        };
        try {
            combo.on('change', apply);
        } catch (eWire) {
            ANAS.warn('replication location wiring failed: ' + ANAS.errText(eWire));
        }
        loadLocations(node).then(function (locs) {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                var rows = locationRows(locs);
                var preKey = opts.preLoc && opts.preLoc.kind && opts.preLoc.kind !== 'local'
                    ? locKey(opts.preLoc.kind, opts.preLoc.name) : 'local';
                // A saved peer/remote that is no longer registered keeps its row
                // — marked "(unavailable)" — so the dialog shows the truth and
                // the value can never resolve to 'This node' behind the operator.
                var known = false;
                for (var i = 0; i < rows.length; i++) {
                    if (rows[i].value === preKey) { known = true; break; }
                }
                var lost = '';
                if (!known) {
                    lost = opts.preLoc.kind + ': ' + (opts.preLoc.name || '');
                    rows.push({ value: preKey, label: lost + ' ' + UNAVAILABLE,
                        kind: opts.preLoc.kind, name: opts.preLoc.name });
                }
                combo.getStore().loadData(rows);
                if (preKey !== 'local') {
                    // Preselect the saved remote/peer and its pool (edit path).
                    win._pendingTargetPool = opts.prePool;
                    combo.setValue(preKey); // fires change → applyLocationToPoolCombo
                } else {
                    combo.setValue('local');
                    // Local default: leave the pre-seeded ANAS pool list intact
                    // (the change handler above only re-applies on user action).
                }
                if (lost) {
                    ANAS.editGuard.block(win, 'location', t('Target location') + ' "' + lost + '" '
                        + t('is not registered on this node any more. Saving now would '
                            + 'replicate somewhere else — re-register it, pick another '
                            + 'location deliberately, or cancel.'));
                } else {
                    ANAS.editGuard.unblock(win, 'location');
                }
            } catch (e) {
                ANAS.warn('replication location load failed: ' + ANAS.errText(e));
                ANAS.editGuard.unblock(win, 'location');
            }
        });
    }

    // A location combo field config, shared by both dialogs.
    function locationComboCfg() {
        return {
            xtype: 'combobox',
            itemId: 'targetLocation',
            cls: 'anas-fld-repl-location',
            fieldLabel: t('Target location'),
            store: Ext.create('Ext.data.Store', { fields: ['value', 'label', 'kind', 'name'],
                data: [{ value: 'local', label: t('This node'), kind: 'local', name: '' }] }),
            valueField: 'value',
            displayField: 'label',
            queryMode: 'local',
            editable: false,
            forceSelection: true,
            value: 'local',
        };
    }

    // CAS-aware registry writes go through the shared ANAS.casWrite (10-api.js).

    // ======================================================================
    //  Remotes manager — 'anas-win-repl-remotes' (Build A)
    // ======================================================================

    function fpShort(fp) {
        var s = '' + (fp == null ? '' : fp);
        if (!s) {
            return '';
        }
        // Keep the algo prefix + a leading chunk of the digest, then ellipsize.
        return s.length > 26 ? (s.substring(0, 26) + '…') : s;
    }

    function endpointLabel(rec) {
        var user = rec.get('user') || 'root';
        var host = rec.get('host') || '';
        var port = rec.get('port') || 22;
        return user + '@' + host + ':' + port;
    }

    function renderEndpoint(v, meta, rec) {
        return enc(endpointLabel(rec));
    }

    function renderFingerprint(v, meta, rec) {
        var fp = rec.get('fingerprint');
        if (!fp) {
            return '<span style="color:gray;" title="' + enc(t('host key not pinned yet')) + '">'
                + enc(t('not pinned')) + '</span>';
        }
        return '<span style="font-family:monospace;font-size:0.85em;" title="' + enc(fp) + '">'
            + enc(fpShort(fp)) + '</span>';
    }

    // A test-result chip for the given stage (grid cell + wizard reuse the map).
    function stageChip(stage, detail, zfsVersion) {
        stage = '' + (stage || '');
        if (!stage) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var spec = {
            'ok': { good: true, label: zfsVersion ? ('ok — zfs ' + zfsVersion) : 'ok',
                title: zfsVersion ? (t('reachable; zfs') + ' ' + zfsVersion) : t('reachable') },
            'hostkey-unknown': { warn: true, label: t('host key?'), title: t('host key not confirmed') },
            'hostkey-changed': { bad: true, label: t('host key changed'),
                title: t('the host presents a different key than the one pinned') },
            'auth-failed': { bad: true, label: t('auth failed'), title: t('key not authorized on the remote yet') },
            'no-zfs': { warn: true, label: t('no zfs'), title: t('connected, but no zfs on the remote') },
            'unreachable': { bad: true, label: t('unreachable'), title: detail || t('unreachable') },
        };
        var s = spec[stage] || { label: stage };
        if (gfxReady() && ANAS.gfx) {
            if (s.good && typeof ANAS.gfx.chip === 'function') {
                return ANAS.gfx.chip(s.label, { good: true, title: s.title });
            }
            if (typeof ANAS.gfx.chip === 'function' && s.warn) {
                return '<span title="' + enc(s.title || '') + '">' + ANAS.gfx.chip(s.label) + '</span>';
            }
        }
        var color = s.bad ? 'var(--anas-danger,#c23b2c)'
            : s.warn ? 'var(--anas-warn,#b06a12)' : 'var(--anas-ok,#1f9c56)';
        return '<span title="' + enc(s.title || '') + '"'
            + ' style="display:inline-block;padding:1px 8px;border-radius:9px;font-size:0.82em;'
            + 'color:' + color + ';background:color-mix(in srgb,' + color + ' 15%,transparent);">'
            + enc(s.label) + '</span>';
    }

    function renderTestChip(v, meta, rec) {
        return stageChip(rec.get('testStage'), rec.get('testDetail'), rec.get('testZfs'));
    }

    function remoteRow(r) {
        r = r || {};
        return {
            name: r.name,
            host: r.host,
            port: r.port || 22,
            user: r.user || 'root',
            fingerprint: r.hostKeyFingerprint || '',
            testStage: '',
            testDetail: '',
            testZfs: '',
            raw: r,
        };
    }

    function selectedRemote(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    // Reload the registry into the manager window: grid rows, version (for CAS),
    // and the public-key textarea. Preserves each row's last test result.
    function reloadRemotes(win, node) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var grid = win.down('#remotesGrid');
        if (grid) {
            try { grid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        ANAS.api.get(node, '/replication/remotes').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            var data = (res && res.data) || {};
            win._registryVersion = (data.version === undefined || data.version === null) ? 0 : data.version;
            var list = data.remotes || [];
            // Preserve per-row test results across a reload by name.
            var prev = {};
            try {
                grid.getStore().each(function (r) {
                    if (r.get('testStage')) {
                        prev[r.get('name')] = { s: r.get('testStage'), d: r.get('testDetail'), z: r.get('testZfs') };
                    }
                });
            } catch (ePrev) {
                // best-effort
            }
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                var row = remoteRow(list[i]);
                var p = prev[row.name];
                if (p) { row.testStage = p.s; row.testDetail = p.d; row.testZfs = p.z; }
                rows.push(row);
            }
            try {
                grid.getStore().loadData(rows);
            } catch (eLoad) {
                ANAS.warn('remotes grid load failed: ' + ANAS.errText(eLoad));
            }
            var key = win.down('#publicKey');
            if (key) {
                key.setValue(data.publicKey || t('(no cluster key returned by the daemon)'));
            }
            updateRemoteButtons(grid);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            ANAS.warn('remotes load failed: ' + ANAS.errText(err));
            ANAS.alertMsg('Load failed', t('Failed to load the remotes registry') + ': ' + ANAS.errText(err));
        });
    }

    function updateRemoteButtons(grid) {
        if (!grid) {
            return;
        }
        var has = !!selectedRemote(grid);
        var ids = ['remoteEdit', 'remoteTest', 'remoteDelete'];
        for (var i = 0; i < ids.length; i++) {
            var btn = grid.down('#' + ids[i]);
            if (btn) { btn.setDisabled(!has); }
        }
    }

    // Test a REGISTERED remote from the manager (uses its stored host). Writes the
    // result chip onto the row.
    function testRemoteRow(node, grid, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try { grid.setLoading(t('Testing') + ' ' + name + '…'); } catch (e) { /* non-fatal */ }
        ANAS.api.post(node, '/replication/remotes/' + encodeURIComponent(name) + '/test', {}).then(
            function (res) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
                if (grid.destroyed || grid.destroying) {
                    return;
                }
                var d = (res && res.data) || {};
                rec.set('testStage', d.stage || 'unreachable');
                rec.set('testDetail', d.detail || '');
                rec.set('testZfs', d.zfsVersion || '');
                // The probe resolves what is actually PINNED (the daemon mirrors
                // it onto the registry row too) — show it now, not next reload.
                // A key the operator has not trusted yet is NOT a pinned key.
                if (d.fingerprint && d.stage !== 'hostkey-unknown' && d.stage !== 'hostkey-changed') {
                    rec.set('fingerprint', d.fingerprint);
                }
                if (d.stage === 'hostkey-changed') {
                    // The repair lives in the wizard, where both fingerprints fit.
                    ANAS.toast(t('Host key changed for') + ' ' + name + ' — '
                        + t('open Edit → Test connection to compare both fingerprints.'));
                }
            },
            function (err) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
                if (grid.destroyed || grid.destroying) {
                    return;
                }
                ANAS.warn('remote test failed: ' + ANAS.errText(err));
                rec.set('testStage', 'unreachable');
                rec.set('testDetail', ANAS.errText(err));
            }
        );
    }

    function deleteRemote(node, win, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try {
            Ext.Msg.confirm(
                t('Delete Remote'),
                t('Delete the remote') + ' "' + enc(name) + '"? '
                    + t('This removes it from the cluster registry.'),
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    var ver = win._registryVersion;
                    ANAS.casWrite({
                        node: node,
                        method: 'del',
                        path: '/replication/remotes/' + encodeURIComponent(name)
                            + '?expectedVersion=' + encodeURIComponent(ver),
                        view: win,
                        failTitle: 'Delete failed',
                        successMsg: t('Remote deleted') + ': ' + name,
                        onComplete: function () { reloadRemotes(win, node); },
                        onConflict: function () {
                            reloadRemotes(win, node);
                            ANAS.toast(t('registry changed on another node — reloaded, please retry'));
                        },
                        // A 400 "referenced by task" (or any non-409) surfaces the
                        // daemon's message verbatim.
                        onError: function (err) {
                            ANAS.alertMsg('Delete failed', ANAS.errText(err));
                        },
                    });
                }
            );
        } catch (e) {
            ANAS.warn('remote delete confirm failed: ' + ANAS.errText(e));
        }
    }

    function publicKeyPanel() {
        var pasteTrueNas = t('TrueNAS: Credentials → Users → root → Authorized Keys → paste.');
        var pasteLinux = t('Generic Linux: append the key to ~/.ssh/authorized_keys on the remote.');
        return {
            xtype: 'panel',
            itemId: 'pubkeyPanel',
            cls: 'anas-repl-pubkey',
            border: false,
            bodyPadding: '10 12',
            height: 210,
            scrollable: true,
            items: [
                {
                    xtype: 'component',
                    style: 'font-weight:600;margin-bottom:4px;',
                    html: enc(t('Cluster public key')),
                },
                {
                    xtype: 'component',
                    style: 'color:var(--anas-muted,gray);font-size:11px;margin-bottom:6px;',
                    html: enc(t('Authorize this key on the remote:')),
                },
                {
                    xtype: 'textareafield',
                    itemId: 'publicKey',
                    cls: 'anas-repl-pubkey-text',
                    readOnly: true,
                    selectOnFocus: true,
                    grow: false,
                    height: 66,
                    fieldStyle: 'font-family:monospace;font-size:11px;white-space:pre;',
                    anchor: '100%',
                    value: t('(loading…)'),
                },
                {
                    xtype: 'panel',
                    title: t('TrueNAS'),
                    collapsible: true,
                    collapsed: true,
                    titleCollapse: true,
                    border: false,
                    bodyPadding: '4 8',
                    margin: '8 0 0 0',
                    html: enc(pasteTrueNas),
                },
                {
                    xtype: 'panel',
                    title: t('Generic Linux'),
                    collapsible: true,
                    collapsed: true,
                    titleCollapse: true,
                    border: false,
                    bodyPadding: '4 8',
                    html: enc(pasteLinux),
                },
            ],
        };
    }

    function openRemotesManager(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: ['name', 'host', 'port', 'user', 'fingerprint',
                'testStage', 'testDetail', 'testZfs', { name: 'raw', type: 'auto' }],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-repl-remotes',
                title: t('Replication Remotes'),
                modal: true,
                width: 640,
                height: 560,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'gridpanel',
                        itemId: 'remotesGrid',
                        cls: 'anas-grid-repl-remotes',
                        flex: 1,
                        border: false,
                        store: store,
                        selModel: { mode: 'SINGLE' },
                        emptyText: t('No remotes registered'),
                        columns: [
                            { text: t('Name'), dataIndex: 'name', width: 130, renderer: Ext.String.htmlEncode },
                            { text: t('Connection'), dataIndex: 'host', flex: 1, minWidth: 180,
                                sortable: false, menuDisabled: true, renderer: renderEndpoint },
                            { text: t('Host key'), dataIndex: 'fingerprint', width: 150,
                                sortable: false, menuDisabled: true, renderer: renderFingerprint },
                            { text: t('Test'), dataIndex: 'testStage', width: 130, align: 'center',
                                sortable: false, menuDisabled: true, renderer: renderTestChip },
                        ],
                        tbar: [
                            {
                                text: t('Add…'),
                                cls: 'anas-btn-remote-add',
                                iconCls: 'fa fa-plus',
                                handler: function () { openRemoteEdit(node, win, null); },
                            },
                            {
                                text: t('Edit'),
                                itemId: 'remoteEdit',
                                cls: 'anas-btn-remote-edit',
                                iconCls: 'fa fa-pencil',
                                disabled: true,
                                handler: function (btn) {
                                    var rec = selectedRemote(btn.up('grid'));
                                    openRemoteEdit(node, win, rec ? (rec.get('raw') || {
                                        name: rec.get('name'), host: rec.get('host'),
                                        port: rec.get('port'), user: rec.get('user'),
                                    }) : null);
                                },
                            },
                            {
                                text: t('Test'),
                                itemId: 'remoteTest',
                                cls: 'anas-btn-remote-test',
                                iconCls: 'fa fa-plug',
                                disabled: true,
                                handler: function (btn) {
                                    var grid = btn.up('grid');
                                    testRemoteRow(node, grid, selectedRemote(grid));
                                },
                            },
                            {
                                text: t('Delete'),
                                itemId: 'remoteDelete',
                                cls: 'anas-btn-remote-delete',
                                iconCls: 'fa fa-trash',
                                disabled: true,
                                handler: function (btn) {
                                    deleteRemote(node, win, selectedRemote(btn.up('grid')));
                                },
                            },
                        ],
                        listeners: {
                            selectionchange: function () {
                                updateRemoteButtons(this);
                            },
                            itemdblclick: function (grid, rec) {
                                openRemoteEdit(node, win, rec ? (rec.get('raw') || null) : null);
                            },
                        },
                    },
                    publicKeyPanel(),
                ],
                buttons: [
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
            });
        } catch (e) {
            ANAS.warn('remotes manager window failed: ' + ANAS.errText(e));
            return;
        }

        // Expose a reload hook the wizard calls after a successful save.
        win._reload = function () { reloadRemotes(win, node); };
        win.show();
        reloadRemotes(win, node);
    }

    ANAS.replication = ANAS.replication || {};
    ANAS.replication.openRemotes = openRemotesManager;
    // The task dialog's entry point, exposed so the edit-guard harness
    // (test/edit-retarget.harness.mjs) can open a real edit against stubbed
    // inventory. The view's own toolbar calls the local function directly.
    ANAS.replication.openTaskDialog = openTaskDialog;

    // ======================================================================
    //  Add / edit remote wizard — 'anas-win-repl-remote-edit' (Build B)
    // ======================================================================

    // One fingerprint, shown whole and monospaced — never truncated: an operator
    // comparing it against the remote needs every character.
    function fingerprintBox(fp) {
        return '<div style="font-family:monospace;font-size:12px;margin:6px 0;padding:6px 8px;'
            + 'background:rgba(127,127,127,0.1);border-radius:6px;word-break:break-all;">'
            + enc(fp || t('(no fingerprint returned)')) + '</div>';
    }

    // The deliberate re-trust: a second, explicit yes that repeats BOTH
    // fingerprints. Pinning only means something if replacing a pinned key takes
    // a decision, so this is never folded into the ordinary Test button.
    function confirmRetrust(win, node, data) {
        try {
            Ext.Msg.confirm(
                t('Replace the pinned host key'),
                enc(t('Replace the pinned key for this host?')) + '<br><br>'
                    + enc(t('Pinned:')) + '<br><code>' + enc(data.knownFingerprint || '—') + '</code><br><br>'
                    + enc(t('Presented now:')) + '<br><code>' + enc(data.fingerprint || '—') + '</code><br><br>'
                    + enc(t('Only do this if you know the remote was rebuilt or rekeyed, and '
                        + 'the new fingerprint matches what the remote itself reports. '
                        + 'Afterwards ANAS trusts the new key for every replication to this host.')),
                function (btn) {
                    if (btn === 'yes') {
                        runRemoteTest(win, node, { retrust: true });
                    }
                }
            );
        } catch (e) {
            ANAS.warn('re-trust confirm failed: ' + ANAS.errText(e));
        }
    }

    // Render the staged Test-connection result into the '#testResult' area. On
    // 'hostkey-unknown' it shows the fingerprint prominently + a trust button
    // that re-tests with ?pin=true; on 'hostkey-changed' it shows the pinned AND
    // the presented fingerprint behind a separate, deliberate re-trust.
    function renderTestStage(win, node, data) {
        var area = win.down('#testResult');
        if (!area) {
            return;
        }
        data = data || {};
        var stage = data.stage || 'unreachable';
        win._tested = (stage === 'ok');
        // Remember what the probe found pinned, so a save can record it (the
        // Host key column reads this) — never a not-yet-trusted key.
        if (data.fingerprint && stage !== 'hostkey-unknown' && stage !== 'hostkey-changed') {
            win._fingerprint = data.fingerprint;
        }
        var items = [];
        if (stage === 'hostkey-unknown') {
            items.push({
                xtype: 'component',
                html: '<div style="color:var(--anas-warn,#b06a12);font-weight:600;">'
                    + enc(t('Unknown host key — confirm the fingerprint before trusting:')) + '</div>'
                    + fingerprintBox(data.fingerprint),
            });
            items.push({
                xtype: 'button',
                cls: 'anas-btn-remote-trust',
                text: t('Confirm & trust this host'),
                iconCls: 'fa fa-check',
                margin: '2 0 0 0',
                handler: function () { runRemoteTest(win, node, { pin: true }); },
            });
        } else if (stage === 'hostkey-changed') {
            // The remote answered with a key that is NOT the pinned one. Show
            // both keys and say plainly what the two explanations are — pinning
            // exists exactly for this moment, so the operator decides, not us.
            items.push({
                xtype: 'component',
                html: '<div style="color:var(--anas-danger,#c23b2c);font-weight:600;">'
                    + enc(t('The host key CHANGED — this connection is refused until you decide.')) + '</div>'
                    + '<div style="font-size:12px;margin-top:4px;">' + enc(t('Pinned:')) + '</div>'
                    + fingerprintBox(data.knownFingerprint)
                    + '<div style="font-size:12px;">' + enc(t('Presented now:')) + '</div>'
                    + fingerprintBox(data.fingerprint)
                    + '<div style="font-size:12px;color:var(--anas-muted,gray);">'
                    + enc(t('Expected if the remote was rebuilt or its SSH host keys were '
                        + 'regenerated. If nothing like that happened, something else is '
                        + 'answering on this address — verify the new fingerprint on the '
                        + 'remote itself (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) '
                        + 'before replacing the pinned key.')) + '</div>',
            });
            items.push({
                xtype: 'button',
                cls: 'anas-btn-remote-retrust',
                text: t('Replace the pinned key…'),
                iconCls: 'fa fa-exchange',
                margin: '6 0 0 0',
                handler: function () { confirmRetrust(win, node, data); },
            });
        } else if (stage === 'auth-failed') {
            items.push({
                xtype: 'component',
                html: ANAS.gfx && gfxReady() && ANAS.gfx.callout
                    ? ANAS.gfx.callout(enc(t('Connected, but the key is not authorized on the remote yet — '
                        + 'paste the cluster public key (Remotes window) into the remote, then re-test.')), { level: 'warn' })
                    : '<span style="color:var(--anas-warn,#b06a12);">' + enc(t('Connected, but the key is '
                        + 'not authorized on the remote yet — paste the cluster public key into the remote, then re-test.')) + '</span>',
            });
        } else if (stage === 'no-zfs') {
            items.push({
                xtype: 'component',
                html: '<span style="color:var(--anas-warn,#b06a12);">'
                    + enc(t('Connected, but no zfs on the remote.')) + '</span>',
            });
        } else if (stage === 'ok') {
            var okHtml = stageChip('ok', '', data.zfsVersion);
            items.push({
                xtype: 'component',
                html: '<div>' + okHtml + ' <span style="color:var(--anas-muted,gray);font-size:12px;">'
                    + enc(t('reachable — you can save this remote.')) + '</span></div>',
            });
        } else {
            // unreachable (or unknown stage)
            items.push({
                xtype: 'component',
                html: '<span style="color:var(--anas-danger,#c23b2c);">'
                    + enc(data.detail || t('Host is unreachable.')) + '</span>',
            });
        }
        try {
            area.removeAll();
            area.add(items);
        } catch (e) {
            ANAS.warn('test stage render failed: ' + ANAS.errText(e));
        }
    }

    function setTestBusy(win) {
        var area = win.down('#testResult');
        if (!area) {
            return;
        }
        try {
            area.removeAll();
            area.add({
                xtype: 'component',
                html: '<span style="color:var(--anas-muted,gray);">'
                    + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
                    + enc(t('testing connection…')) + '</span>',
            });
        } catch (e) {
            // non-fatal
        }
    }

    // Drive the pre-registration staged test with the values typed in the dialog.
    // opts.pin re-runs after the operator confirms an unknown host key;
    // opts.retrust after they confirm REPLACING a changed one.
    function runRemoteTest(win, node, opts) {
        opts = opts || {};
        var host = ('' + (valOf(win, '#host') || '')).trim();
        if (!host) {
            ANAS.alertMsg('Invalid input', t('Enter a host to test.'));
            return;
        }
        var port = parseInt(valOf(win, '#port'), 10);
        if (isNaN(port) || port <= 0) { port = 22; }
        var user = ('' + (valOf(win, '#user') || 'root')).trim() || 'root';
        var body = { host: host, port: port, user: user };
        var path = '/replication/remotes/test'
            + (opts.retrust ? '?retrust=true' : (opts.pin ? '?pin=true' : ''));
        setTestBusy(win);
        ANAS.api.post(node, path, body).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            renderTestStage(win, node, (res && res.data) || {});
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.warn('remote test failed: ' + ANAS.errText(err));
            renderTestStage(win, node, { stage: 'unreachable', detail: ANAS.errText(err) });
        });
    }

    function openRemoteEdit(node, mgrWin, existing) {
        var isEdit = !!existing;
        var r = existing || {};
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-repl-remote-edit',
                title: isEdit ? (t('Edit Remote') + ': ' + (r.name || '')) : t('Add Remote'),
                modal: true,
                width: 480,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    scrollable: true,
                    defaults: { anchor: '100%', labelWidth: 130 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'name',
                            cls: 'anas-fld-remote-name',
                            fieldLabel: t('Name'),
                            emptyText: 'offsite-nas',
                            disabled: isEdit,
                            allowBlank: false,
                            value: r.name || '',
                            regex: NAME_RE,
                            maxLength: 64,
                            regexText: t('Lowercase letters, digits and hyphens; must start with a letter or digit.'),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'host',
                            cls: 'anas-fld-remote-host',
                            fieldLabel: t('Host'),
                            emptyText: 'nas.example.com',
                            allowBlank: false,
                            value: r.host || '',
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'port',
                            cls: 'anas-fld-remote-port',
                            fieldLabel: t('SSH port'),
                            minValue: 1,
                            maxValue: 65535,
                            value: r.port || 22,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'user',
                            cls: 'anas-fld-remote-user',
                            fieldLabel: t('User'),
                            emptyText: 'root',
                            value: r.user || 'root',
                        },
                        {
                            xtype: 'button',
                            cls: 'anas-btn-remote-testconn',
                            text: t('Test connection'),
                            iconCls: 'fa fa-plug',
                            margin: '4 0 0 0',
                            width: 150,
                            handler: function () { runRemoteTest(win, node, {}); },
                        },
                        {
                            xtype: 'container',
                            itemId: 'testResult',
                            cls: 'anas-remote-test',
                            margin: '10 0 0 0',
                            layout: { type: 'vbox', align: 'stretch' },
                            minHeight: 24,
                            items: [{
                                xtype: 'component',
                                html: '<span style="color:var(--anas-muted,gray);font-size:12px;">'
                                    + enc(t('Test the connection to diagnose reachability, host key, auth and zfs.'))
                                    + '</span>',
                            }],
                        },
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin-top:12px;',
                            html: enc(t('You can save now and authorize the cluster key on the remote later — '
                                + 'the remote just needs sshd + zfs, no software installed.')),
                        },
                    ],
                }],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: isEdit ? t('Save') : t('Add'),
                        cls: 'anas-btn-remote-save',
                        handler: function () {
                            try {
                                submitRemote(win, node, mgrWin, isEdit);
                            } catch (e) {
                                ANAS.warn('remote save failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('remote edit window failed: ' + ANAS.errText(e));
            return;
        }
        // The row as stored — its pinned fingerprint survives an edit that never
        // re-tests (submitRemote re-sends it rather than dropping the field).
        win._existing = r;
        win.show();
    }

    function submitRemote(win, node, mgrWin, isEdit) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var name = ('' + (valOf(win, '#name') || '')).trim();
        if (!NAME_RE.test(name) || name.length > 64) {
            ANAS.alertMsg('Invalid input',
                t('Name must be lowercase letters, digits and hyphens (≤64 chars).'));
            return;
        }
        var host = ('' + (valOf(win, '#host') || '')).trim();
        if (!host) {
            ANAS.alertMsg('Invalid input', t('Enter a host.'));
            return;
        }
        var port = parseInt(valOf(win, '#port'), 10);
        if (isNaN(port) || port <= 0) { port = 22; }
        var user = ('' + (valOf(win, '#user') || 'root')).trim() || 'root';

        var remote = { name: name, host: host, port: port, user: user };
        // Carry the pinned fingerprint: the one this dialog's test just resolved,
        // else whatever the row already recorded. An edit must not blank it —
        // that is what made the Host key column read "not pinned" forever.
        var fingerprint = win._fingerprint || (win._existing && win._existing.hostKeyFingerprint);
        if (fingerprint) {
            remote.hostKeyFingerprint = fingerprint;
        }
        var expectedVersion = mgrWin && mgrWin._registryVersion !== undefined ? mgrWin._registryVersion : 0;
        var body = { remote: remote, expectedVersion: expectedVersion };

        ANAS.casWrite({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/replication/remotes/' + encodeURIComponent(name)) : '/replication/remotes',
            body: body,
            view: win,
            failTitle: isEdit ? 'Save failed' : 'Add failed',
            successMsg: isEdit ? (t('Remote saved') + ': ' + name) : (t('Remote added') + ': ' + name),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (mgrWin && mgrWin._reload) {
                    mgrWin._reload();
                }
            },
            // CAS conflict: the registry moved on another node. Reload the manager
            // (refreshing the version), toast, and KEEP this dialog open to retry.
            onConflict: function () {
                if (mgrWin && mgrWin._reload) {
                    mgrWin._reload();
                }
                ANAS.toast(t('registry changed on another node — reloaded, please retry'));
            },
        });
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
            // Nothing to point a NEW task at. An EDIT still opens: the task
            // already has its endpoints, and the dialog's job is then to say the
            // pool list is missing — not to disappear (mirrors 69-snapshots.js).
            if (!names.length && !isEdit) {
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

        // Seed a pool combo WITHOUT substituting on edit (#39). On create the
        // first pool is a fine default; on edit a stored pool the inventory no
        // longer lists is kept as an "(unavailable)" row and reported so the
        // caller can block Save.
        var seedPool = function (stored, store) {
            if (isEdit && stored) {
                if (names.indexOf(stored) < 0) {
                    store.add(poolRow(stored, true));
                    return { value: stored, missing: stored };
                }
                return { value: stored, missing: '' };
            }
            return { value: (stored && names.indexOf(stored) >= 0) ? stored : names[0], missing: '' };
        };
        var srcSeed = seedPool(src.pool, srcPoolStore);
        var tgtSeed = seedPool(tgt.pool, tgtPoolStore);
        var defaultSrcPool = srcSeed.value;
        var defaultTgtPool = tgtSeed.value;

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
                        ANAS.editGuard.noteCfg(),
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
                            displayField: 'label',
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
                        locationComboCfg(),
                        {
                            xtype: 'combobox',
                            itemId: 'targetPool',
                            cls: 'anas-fld-repl-tgt-pool',
                            fieldLabel: t('Target pool'),
                            store: tgtPoolStore,
                            valueField: 'name',
                            displayField: 'label',
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
                        // --- Notifications (9.4) — the same knob Backup has ---
                        ANAS.notifyMode.field({
                            itemId: 'notifyMode',
                            cls: 'anas-fld-repl-notify',
                            value: notifyOf(task),
                        }),
                        {
                            xtype: 'component',
                            style: 'margin:-4px 0 8px 152px;',
                            html: ANAS.notifyMode.hintHtml('run', 'anas-replication'),
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
                        itemId: 'submit',
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

        // What the task reads and writes TODAY — the yardstick submitTask uses to
        // notice a retarget (and the daemon re-checks against the stored unit).
        win._storedEndpoints = isEdit ? taskEndpoints(task) : null;

        win.show();
        // A stored pool the inventory no longer lists blocks Save by name (#39).
        if (srcSeed.missing) {
            ANAS.editGuard.block(win, 'sourcePool', t('Source pool') + ' "' + srcSeed.missing + '" '
                + t('is not in this node\'s pool list any more (exported, or the pool '
                    + 'list failed to load). Saving now would replicate a different '
                    + 'dataset — fix the pool, or cancel.'));
        }
        if (tgtSeed.missing) {
            ANAS.editGuard.block(win, 'targetPool', t('Target pool') + ' "' + tgtSeed.missing + '" '
                + t('is not in this node\'s pool list any more. Saving now would '
                    + 'replicate somewhere else — pick a target deliberately, or cancel.'));
        }
        // Initial dataset list — preselect the existing source dataset on edit.
        loadSrcDatasets(defaultSrcPool, isEdit ? (src.dataset || '') : undefined);
        // Target-location picker: default 'This node'; on edit, preselect the
        // saved peer/remote and repopulate the target-pool combo from it.
        wireLocationPicker(win, node, {
            preLoc: isEdit ? tgt.location : null,
            prePool: isEdit ? tgt.pool : undefined,
        });
    }

    // A task's data identity — where it reads from and where it writes — as two
    // comparable strings. Mirrors the daemon's own retarget check
    // (routes/replication-tasks.ts), so both ends agree on what "moved" means.
    function taskEndpoints(task) {
        task = task || {};
        var src = task.source || {};
        var tgt = task.target || {};
        var loc = tgt.location;
        var where = loc && loc.kind && loc.kind !== 'local' ? (loc.kind + ':' + (loc.name || '')) : 'local';
        var srcRel = src.dataset || '';
        // Absent and empty are the same instruction ("the source's own relative
        // path") — exactly the daemon's normalisation.
        var tgtRel = tgt.dataset || srcRel;
        return {
            source: (src.pool || '') + (srcRel ? '/' + srcRel : ''),
            target: where + ':' + (tgt.pool || '') + (tgtRel ? '/' + tgtRel : ''),
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

    function submitTask(win, node, grid, isEdit) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        // The edit guard has the last word: a blocked dialog sends NOTHING, even
        // if the disabled button was somehow reached (#39).
        var blocked = ANAS.editGuard.reason(win);
        if (blocked) {
            ANAS.alertMsg('Cannot save', blocked);
            return;
        }
        var name = ('' + (valOf(win, '#name') || '')).trim();
        if (!NAME_RE.test(name) || name.length > 64) {
            ANAS.alertMsg('Invalid input',
                t('Task name must be lowercase letters, digits and hyphens (≤64 chars).'));
            return;
        }
        var sourcePool = valOf(win, '#sourcePool');
        var targetPool = valOf(win, '#targetPool');
        if (!sourcePool || !targetPool) {
            ANAS.alertMsg('Invalid input', t('Select a source and target pool.'));
            return;
        }
        var schedule = ('' + (valOf(win, '#schedule') || '')).trim();
        if (!schedule) {
            ANAS.alertMsg('Invalid input', t('Enter a schedule.'));
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
            notify: ANAS.notifyMode.of(valOf(win, '#notifyMode'), 'on-failure'),
            enabled: !!valOf(win, '#enabled'),
        };
        if (targetDataset) {
            body.target.dataset = targetDataset;
        }
        var loc = selectedLocation(win);
        if (loc.unresolved) {
            // The combo holds a location with no row behind it — refuse rather
            // than send a same-node target the operator never chose.
            ANAS.alertMsg('Cannot save', t('The target location') + ' "' + loc.unresolved + '" '
                + t('could not be resolved. Reopen the task once the peer or remote is '
                    + 'reachable, or pick a location deliberately.'));
            return;
        }
        if (loc.kind === 'peer' || loc.kind === 'remote') {
            body.target.location = { kind: loc.kind, name: loc.name };
        }

        var send = function (retarget) {
            // Create → POST; edit → PUT :name. The daemon may answer with a job
            // (202 { job }) or a plain 200 — runJob handles both (a jobless
            // response resolves straight to onComplete).
            ANAS.runJob({
                node: node,
                method: isEdit ? 'put' : 'post',
                path: isEdit
                    ? ('/replication/tasks/' + encodeURIComponent(name) + (retarget ? '?retarget=true' : ''))
                    : '/replication/tasks',
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
        };

        // A DELIBERATE retarget is allowed; a silent one is not. When the edit
        // moves the source or the target, name the move and let the operator
        // confirm — the daemon refuses the write without ?retarget=true anyway.
        var moved = isEdit ? movedEndpoints(win._storedEndpoints, taskEndpoints(body)) : [];
        if (!moved.length) {
            send(false);
            return;
        }
        try {
            Ext.Msg.confirm(
                t('Retarget replication task'),
                t('This edit moves where the task replicates:') + '<br><br>'
                    + moved.join('<br>') + '<br><br>'
                    + t('Data already at the old target is left untouched; the next run '
                        + 'replicates to the new one. Continue?'),
                function (btn) {
                    if (btn === 'yes') {
                        send(true);
                    }
                }
            );
        } catch (e) {
            ANAS.warn('retarget confirm failed: ' + ANAS.errText(e));
        }
    }

    // Which endpoints an edit moves, as readable "was → now" lines ([] = none).
    function movedEndpoints(was, now) {
        if (!was || !now) {
            return [];
        }
        var lines = [];
        if (was.source !== now.source) {
            lines.push(enc(t('source') + ': ' + was.source + ' → ' + now.source));
        }
        if (was.target !== now.target) {
            lines.push(enc(t('target') + ': ' + was.target + ' → ' + now.target));
        }
        return lines;
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
                ANAS.alertMsg('Run failed', t('Failed to start replication') + ': ' + ANAS.errText(err));
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
            // 9.4: carry the notify mode through, or a toggle silently resets it
            // (the same trap the biweekly-cadence fix closed for backup tasks).
            notify: raw.notify || rec.get('notify') || 'on-failure',
            enabled: next,
        };
        if (!body.target.dataset && rec.get('targetDataset')) {
            body.target.dataset = rec.get('targetDataset');
        }
        // Preserve the target location when reconstructing from the record.
        if (!body.target.location) {
            var lk = rec.get('targetLocationKind');
            if (lk === 'peer' || lk === 'remote') {
                body.target.location = { kind: lk, name: rec.get('targetLocationName') };
            }
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
                            ANAS.alertMsg('Delete failed',
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
        var planLoc = selectedLocation(win);
        if (planLoc.kind === 'peer' || planLoc.kind === 'remote') {
            body.target.location = { kind: planLoc.kind, name: planLoc.name };
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
                        locationComboCfg(),
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
            // A remote/peer target is a different box, so a same-named pool is not
            // a self-collision — only the local same-pool case needs the suffix.
            var local = selectedLocation(win).kind === 'local';
            if (local && targetPool === srcPool) {
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
        // Target-location picker: switching location repopulates the target-pool
        // combo and re-plans (a remote plan is computed daemon-side).
        wireLocationPicker(win, node, {
            onAfterApply: function () {
                seedTargetDefault();
                replan();
            },
        });
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
            ANAS.alertMsg('Invalid input', t('Select a source and target pool.'));
            return;
        }
        var targetDs = ('' + (valOf(win, '#targetDataset') || '')).replace(/^\/+|\/+$/g, '');
        var snapFirst = !!valOf(win, '#snapshotFirst');
        var snap = snapFirst ? '' : valOf(win, '#snapshot');
        if (!snapFirst && !snap) {
            ANAS.alertMsg('Invalid input',
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
        var loc = selectedLocation(win);
        if (loc.kind === 'peer' || loc.kind === 'remote') {
            body.target.location = { kind: loc.kind, name: loc.name };
        }

        var srcLabel = routeSide(srcPool, srcRel);
        var locPrefix = (loc.kind === 'peer' || loc.kind === 'remote') ? (loc.kind + ':' + loc.name + ' ') : '';
        var targetLabel = locPrefix + targetPool + (targetDs ? ('/' + targetDs) : '');
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
                    loadTasks(grid, node, true);
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
                'targetLocationKind', 'targetLocationName',
                'schedule', 'notify', 'lastReplicatedSnapshot', 'lastReplicatedAt', 'lastRunResult', 'nextRunAt',
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
            {
                text: t('Remotes…'),
                cls: 'anas-btn-repl-remotes',
                iconCls: 'fa fa-server',
                handler: function () {
                    openRemotesManager(node);
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
        var lk = rec.get('targetLocationKind');
        if (lk === 'peer' || lk === 'remote') {
            target.location = { kind: lk, name: rec.get('targetLocationName') };
        }
        return {
            name: rec.get('name'),
            source: { pool: rec.get('sourcePool'), dataset: rec.get('sourceDataset') },
            target: target,
            schedule: rec.get('schedule'),
            snapshotFirst: !!rec.get('snapshotFirst'),
            notify: rec.get('notify') || 'on-failure',
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
