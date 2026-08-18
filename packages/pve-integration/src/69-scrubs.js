/*
 * ANAS — Scrubs view (Epic 17: story 17.5).
 *
 * The periodic-SCRUB surface — uniform across ZFS and AHR, filesystem-native
 * backend. Split from the former single "Schedules" screen: the sibling Snapshots
 * view (69-snapshots.js) owns snapshot schedules; this owns periodic scrubs. Menu
 * label "Scrubs". The guiding principle (SCHEDULES-DESIGN.md): the operator
 * enables/disables a periodic scrub on a ZFS pool and an AHR pool through IDENTICAL
 * controls; only the backend differs.
 *
 * VISIBLE DIVERGENCE (never hidden): AHR mdcheck is NODE-GLOBAL — one toggle
 * governs md checks for EVERY AHR pool on the host. Surfaced per-row (the Scope
 * column's note) and confirmed on toggle.
 *
 * SECOND VISIBLE DIVERGENCE — the "Last scrub" column. ZFS records the verdict of
 * the last completed pass and we say it in words ("repaired 0 B, 0 errors — <date>
 * (took 5h 23m)"). md records NOTHING of the kind: no completion time, no result.
 * An AHR row therefore says so out loud instead of showing an empty cell — ANAS
 * does not mine journald and does not keep a state file to manufacture a record
 * it was never given (stateless — the system is the source of truth).
 *
 * Data (paths relative to /v1 — see routes/scrub.ts):
 *   GET  /scrub                → { data: [ { target:{kind,pool}, enabled,
 *                                   cadence:'monthly', mechanism, note?,
 *                                   lastScrub: {function,state,finishedAt,
 *                                     durationSeconds,repairedBytes,errors}|null } ] }
 *   PUT  /scrub/zfs/:pool  {enabled}  → flip the ZFS periodic-scrub property
 *   PUT  /scrub/ahr/:pool  {enabled}  → flip the node's mdcheck timers (node-global)
 *
 * Shared with the Snapshots view via ANAS.sched.* (69-schedules-common.js): the
 * fs-tag chip, the state pills, and the visibility-gated poll loop — one place so
 * the two views read identically and never drift.
 *
 * Test hooks: view cls 'anas-view anas-view-scrubs', grid cls 'anas-grid-scrub',
 * scrub toggle 'anas-btn-scrub-toggle'.
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
    // 69-schedules-common.js, used by both this view and the Snapshots view.
    var sched = ANAS.sched || {};

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function pillHtml(label, color, title) {
        return sched.pillHtml(label, color, title);
    }

    function softPill(label, color, title) {
        return sched.softPill(label, color, title);
    }

    function muted(html) {
        return sched.muted(html);
    }

    // Absolute local timestamp — shared with the Snapshots view (one copy).
    function absTime(iso) {
        return sched.absTime ? sched.absTime(iso) : ('' + (iso || ''));
    }

    // A pass's wall-clock length, the "in 05:23:11" ZFS prints, said plainly:
    // "45s" / "12m" / "5h 23m" / "2d 3h". Empty for an unknown (0) duration so
    // the caller can drop the "(took …)" clause entirely rather than claim 0.
    function fmtDuration(seconds) {
        var s = Number(seconds);
        if (!isFinite(s) || s <= 0) {
            return '';
        }
        if (s < 60) {
            return Math.round(s) + 's';
        }
        var mins = Math.floor(s / 60);
        if (mins < 60) {
            return mins + 'm';
        }
        var hours = Math.floor(mins / 60);
        var restMins = mins % 60;
        if (hours < 24) {
            return hours + 'h' + (restMins ? ' ' + restMins + 'm' : '');
        }
        var days = Math.floor(hours / 24);
        var restHours = hours % 24;
        return days + 'd' + (restHours ? ' ' + restHours + 'h' : '');
    }

    // ---- Row shape + renderers ---------------------------------------------

    function scrubRow(state) {
        state = state || {};
        var target = state.target || {};
        return {
            pool: target.pool,
            kind: target.kind || 'zfs',
            enabled: !!state.enabled,
            cadence: state.cadence || 'monthly',
            mechanism: state.mechanism || '',
            note: state.note || '',
            // The last completed verify pass, or null when the filesystem keeps
            // no record of one (always so for AHR — see the header).
            lastScrub: state.lastScrub || null,
            // A stable per-row key (kind+pool) so selection survives a poll.
            rowKey: (target.kind || 'zfs') + ':' + (target.pool || '')
        };
    }

    // Pool: the shared fs-tag chip ("zfs"/"ahr") + the full pool name — reads
    // identically to the Snapshots target column (parallel construction).
    function renderScrubPool(v, meta, rec) {
        return sched.fsTag(rec.get('kind'))
            + '<span style="font-family:monospace;font-size:0.92em;">' + enc(rec.get('pool')) + '</span>';
    }

    function renderScrubEnabled(v, meta, rec) {
        if (rec.get('enabled')) {
            return pillHtml(t('On'), 'var(--anas-ok,#1f9c56)', t('periodic scrub is enabled'));
        }
        return softPill(t('Off'), 'var(--anas-muted,gray)', t('periodic scrub is disabled'));
    }

    // Last scrub: the VERDICT of the pool's last completed verify pass, in words
    // — "repaired 0 B, 0 errors — 2026-08-03 07:23 (took 5h 23m)". Anything
    // repaired or any error found is coloured warn: those are the rows an
    // operator should look at, and burying them in body text would hide them.
    //
    // Three honest absences, each said rather than left blank:
    //   AHR      — md keeps no completion record at all (nothing to report, ever).
    //   ZFS      — no pass on record yet (never scrubbed).
    //   canceled — a pass stopped early verified only PART of the pool, so its
    //              "0 errors" is not a clean bill of health and is never shown as one.
    function renderLastScrub(v, meta, rec) {
        var last = rec.get('lastScrub');
        if (!last) {
            if (rec.get('kind') === 'ahr') {
                return '<span title="' + enc(t('md records no completion time or result for a check; '
                    + 'ANAS reports only what the system records')) + '">'
                    + muted('&mdash; ' + enc(t('(md keeps no completion record)'))) + '</span>';
            }
            return '<span title="' + enc(t('ZFS reports no completed scrub or resilver for this pool')) + '">'
                + muted(enc(t('never scrubbed'))) + '</span>';
        }

        var when = absTime(last.finishedAt);
        if (last.state === 'CANCELED') {
            return '<span title="' + enc(t('the pass was stopped before it finished, so only part of the pool was verified'))
                + '" style="color:var(--anas-warn,#b06a12);">'
                + enc(t('canceled') + ' — ' + when) + '</span>';
        }

        // ZFS keeps ONE scan record per pool — a resilver overwrites the scrub's.
        // Name the pass that actually ran instead of calling a resilver a scrub.
        var resilver = last.function === 'RESILVER';
        var errors = Number(last.errors) || 0;
        var repaired = Number(last.repairedBytes) || 0;
        var verdict = (resilver ? t('resilvered') : t('repaired'))
            + ' ' + ANAS.formatBytes(repaired)
            + ', ' + errors + ' ' + (errors === 1 ? t('error') : t('errors'));
        var head = (repaired > 0 || errors > 0)
            ? '<span style="color:var(--anas-warn,#b06a12);">' + enc(verdict) + '</span>'
            : enc(verdict);

        var duration = fmtDuration(last.durationSeconds);
        var tail = '— ' + when + (duration ? ' (' + t('took') + ' ' + duration + ')' : '');
        var title = resilver
            ? t('the pool\'s last completed pass was a RESILVER, not a scrub — ZFS keeps one scan record per pool')
            : t('the pool\'s last completed scrub');
        return '<span title="' + enc(title) + '">' + head
            + ' <span style="color:var(--anas-muted,gray);">' + enc(tail) + '</span></span>';
    }

    function renderScrubScope(v, meta, rec) {
        var note = rec.get('note');
        if (note) {
            // The mdcheck node-global caveat (or any backend note) — surfaced, not hidden.
            return '<span title="' + enc(note) + '"'
                + ' style="color:var(--anas-warn,#b06a12);font-size:0.85em;">'
                + '<i class="fa fa-info-circle" aria-hidden="true" style="margin-right:4px;"></i>'
                + enc(note) + '</span>';
        }
        return muted(t('per-pool'));
    }

    // ---- Load / reload ------------------------------------------------------

    // `quiet` skips the loading mask so the timed poll refreshes in place; the
    // selected row is restored by rowKey (the replication pattern).
    function loadScrub(scrubGrid, node, quiet) {
        if (!scrubGrid || scrubGrid.destroyed || scrubGrid.destroying) {
            return;
        }
        if (!quiet) {
            try { scrubGrid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        var priorKey = null;
        try {
            var sel = scrubGrid.getSelectionModel().getSelection();
            priorKey = (sel && sel.length) ? sel[0].get('rowKey') : null;
        } catch (eS) {
            priorKey = null;
        }
        ANAS.api.get(node, '/scrub').then(function (res) {
            if (scrubGrid.destroyed || scrubGrid.destroying) {
                return;
            }
            if (!quiet) {
                try { scrubGrid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            var list = (res && res.data) || [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(scrubRow(list[i]));
            }
            try {
                scrubGrid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('scrub grid load failed: ' + ANAS.errText(e2));
            }
            if (priorKey) {
                try {
                    var idx = scrubGrid.getStore().findExact('rowKey', priorKey);
                    if (idx >= 0) {
                        scrubGrid.getSelectionModel().select(idx, false, true);
                    }
                } catch (eSel) {
                    // non-fatal
                }
            }
            updateScrubButton(scrubGrid);
        }, function (err) {
            if (scrubGrid.destroyed || scrubGrid.destroying) {
                return;
            }
            if (!quiet) {
                try { scrubGrid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            ANAS.warn('scrub load failed: ' + ANAS.errText(err));
        });
    }

    // ---- Selection + toggle -------------------------------------------------

    function selectedScrub(scrubGrid) {
        var sel = scrubGrid ? scrubGrid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function updateScrubButton(scrubGrid) {
        var rec = selectedScrub(scrubGrid);
        var btn = scrubGrid.down('#scrubToggle');
        if (!btn) {
            return;
        }
        btn.setDisabled(!rec);
        if (rec) {
            var on = rec.get('enabled');
            btn.setText(on ? t('Disable scrub') : t('Enable scrub'));
            btn.setIconCls(on ? 'fa fa-pause' : 'fa fa-play');
        }
    }

    function toggleScrub(node, scrubGrid, rec) {
        if (!rec) {
            return;
        }
        var kind = rec.get('kind');
        var pool = rec.get('pool');
        var next = !rec.get('enabled');
        var path = '/scrub/' + (kind === 'ahr' ? 'ahr' : 'zfs') + '/' + encodeURIComponent(pool);

        var doToggle = function () {
            ANAS.runJob({
                node: node,
                method: 'put',
                path: path,
                body: { enabled: next },
                view: scrubGrid,
                failTitle: 'Scrub toggle failed',
                successMsg: (next ? t('Periodic scrub enabled') : t('Periodic scrub disabled'))
                    + ': ' + pool,
                onComplete: function () { loadScrub(scrubGrid, node); }
            });
        };

        // AHR mdcheck is NODE-GLOBAL — confirm the scope before flipping it, so the
        // operator sees that this governs md checks for EVERY AHR pool on the host.
        if (kind === 'ahr') {
            try {
                Ext.Msg.confirm(
                    t('Periodic scrub (node-global)'),
                    (rec.get('note') ? (enc(rec.get('note')) + '<br><br>') : '')
                        + (next ? t('Enable') : t('Disable')) + ' '
                        + t('md periodic checks for ALL AHR pools on this node?'),
                    function (btn) {
                        if (btn === 'yes') { doToggle(); }
                    }
                );
            } catch (e) {
                ANAS.warn('scrub confirm failed: ' + ANAS.errText(e));
            }
            return;
        }
        doToggle();
    }

    // ---- View ---------------------------------------------------------------

    function scrubsView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: ['pool', 'kind', 'cadence', 'mechanism', 'note', 'rowKey',
                { name: 'enabled', type: 'auto' },
                { name: 'lastScrub', type: 'auto' }],
            data: [],
            sorters: [{ property: 'kind', direction: 'ASC' }, { property: 'pool', direction: 'ASC' }]
        });

        // Reload just this view's grid (the poll loop lives in ANAS.sched).
        var refresh = function (view, quiet) {
            try {
                var g = view.down('#scrubGrid');
                if (g) { loadScrub(g, node, quiet); }
            } catch (e) {
                ANAS.warn('scrubs refresh failed: ' + ANAS.errText(e));
            }
        };

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-scrubs',
            title: t('Scrubs'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'scrubGrid',
                    cls: 'anas-grid-scrub',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No pools found'),
                    columns: [
                        { text: t('Pool'), dataIndex: 'pool', flex: 1, minWidth: 160,
                            sortable: false, menuDisabled: true, renderer: renderScrubPool },
                        { text: t('Periodic scrub'), dataIndex: 'enabled', width: 120, align: 'center',
                            renderer: renderScrubEnabled },
                        { text: t('Cadence'), dataIndex: 'cadence', width: 110,
                            renderer: function (v) { return enc(v || 'monthly'); } },
                        { text: t('Last scrub'), dataIndex: 'lastScrub', flex: 1, minWidth: 280,
                            sortable: false, menuDisabled: true, renderer: renderLastScrub },
                        { text: t('Scope'), dataIndex: 'note', flex: 1, minWidth: 220,
                            sortable: false, menuDisabled: true, renderer: renderScrubScope }
                    ],
                    tbar: [
                        {
                            text: t('Reload'),
                            cls: 'anas-btn-refresh',
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                var g = btn.up('panel').down('#scrubGrid');
                                if (g) { loadScrub(g, node, false); }
                            }
                        },
                        '-',
                        {
                            xtype: 'component',
                            html: enc(t('Verify pools on a monthly cadence. ZFS: per-pool. '
                                + 'AHR: node-global (mdcheck covers every array).')),
                            style: 'color:var(--anas-muted,gray);font-size:11px;'
                        },
                        '->',
                        {
                            text: t('Enable scrub'),
                            itemId: 'scrubToggle',
                            cls: 'anas-btn-scrub-toggle',
                            iconCls: 'fa fa-play',
                            disabled: true,
                            handler: function (btn) {
                                var g = btn.up('grid');
                                toggleScrub(node, g, selectedScrub(g));
                            }
                        }
                    ],
                    listeners: {
                        selectionchange: function () { updateScrubButton(this); }
                    }
                }
            ],
            // Refresh + visibility-gated poll loop live in ANAS.sched (shared).
            listeners: sched.viewListeners(refresh)
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['scrubs'] = {
        itemId: 'anas-scrubs',
        text: t('Scrubs'),
        iconCls: 'fa fa-refresh',
        factory: function (node) {
            try {
                return scrubsView(node);
            } catch (e) {
                ANAS.warn('scrubs view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        }
    };
})();
