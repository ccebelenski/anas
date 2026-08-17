/*
 * ANAS — Disk Health view (story 3.18).
 *
 * A ZFS-focused triage grid of physical disks. This is deliberately NOT a clone
 * of PVE's hardware inventory (PVE owns that, plus wipe/GPT/format). Our value
 * is disks *as ZFS storage*: health-in-context and cross-pool failure triage.
 * Failing disks bubble to the top across ALL pools via a default health sort.
 *
 * Consumes the enriched GET /disks foundation (packages/shared schemas):
 *   healthStatus  'healthy' | 'warning' | 'critical' | 'unknown'
 *                 (fuses SMART pass/fail with live ZFS error state)
 *   poolName / vdevName / vdevRole   — set when the disk is a pool member
 *   zfsErrors     { read, write, checksum } | null
 *   smartHealthy  true | false | null
 * plus size / model / modelFamily / serial / transport / status.
 * GET /disks/:id/smart returns full SmartData (attributes / temperature /
 * powerOnHours) on demand for the S.M.A.R.T. detail window.
 *
 * GROUPING (story 3.20): the grid is grouped by a computed `groupKey` derived
 * from each disk's pool → vdev association, so a large fleet stays scannable.
 * ZFS pool members group under "<pool> / <vdev>"; AHR (ANAS Hybrid RAID)
 * members group under "<pool> / <array>" (issue #3 — the same grouping shape,
 * a visible/honest divergence since AHR is not ZFS); Ceph OSD disks group under
 * "Ceph" (issue #29 — Ceph names no pool ANAS can see, so the heading is the
 * technology); disks in no pool group by
 * their usage status — "Available" (genuinely blank), "System" (boot/OS), or
 * "Other" (in use / partitioned) — so a boot disk never shows under an
 * Available heading. This is pure ExtJS grid grouping (a
 * `grouping` feature on a groupField), NOT a hand-rolled tree, and it degrades
 * to an ungrouped grid if the grouping feature cannot be built. Test hook on
 * the grid: `anas-grid-disks-grouped` (alongside the existing `anas-grid-disks`).
 *
 * FRAMEWORK CONTRACT: window.ANAS exists with ANAS.api.get (Promise-returning,
 * path relative to /v1, rejections carry .status/.body) plus the shared helpers
 * ANAS.t / ANAS.formatBytes / ANAS.errText / ANAS.warn / ANAS.errorPanel. The
 * framework wraps this view in the "not installed" probe — we do NOT probe here.
 * Fail open: any error renders an error panel and never breaks the PVE UI.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    // Guard: only register when the framework namespace is present. Our file is
    // concatenated after 00-core, so this is normally satisfied; the guard keeps
    // a standalone load (e.g. a test harness) from throwing.
    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    // Health status colors (inline, PVE-ish, so the script stays self-contained).
    var COLOR_CRITICAL = '#FF0000';
    var COLOR_WARNING = '#E68A00';
    var COLOR_HEALTHY = '#21BF4B';
    var COLOR_UNKNOWN = '#888888';

    // Per-level presentation for the Health column and legend.
    var HEALTH = {
        critical: { color: COLOR_CRITICAL, icon: 'times-circle', label: 'Critical', rank: 0 },
        warning: { color: COLOR_WARNING, icon: 'exclamation-triangle', label: 'Warning', rank: 1 },
        healthy: { color: COLOR_HEALTHY, icon: 'check-circle', label: 'Healthy', rank: 2 },
        unknown: { color: COLOR_UNKNOWN, icon: 'question-circle', label: 'Unknown', rank: 3 },
    };

    // Human labels for a member disk's vdev role.
    var ROLE_LABELS = {
        data: 'data',
        log: 'log',
        cache: 'cache',
        spare: 'spare',
        special: 'special',
        dedup: 'dedup',
    };

    function t(str) {
        return ANAS.t(str);
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function colored(text, color) {
        return '<span style="color:' + color + ';">' + enc(text) + '</span>';
    }

    // --- Grouping (story 3.20) -------------------------------------------

    // Compute the group a disk belongs to: primary by pool, secondary by vdev
    // ("<pool> / <vdev>"). A disk not in a pool groups by its actual usage
    // status — "Available" ONLY for genuinely blank disks the composer can
    // offer, "System" for boot/OS disks, "Other" for everything else in use —
    // so the boot disk never appears under an "Available" heading. Mirrors the
    // labels the Usage column already renders. Fail-open: any surprise → Other
    // (never "Available", which would misrepresent an unclassifiable disk as
    // free to use).
    function groupKeyFor(rec) {
        try {
            var status = rec.get('status');
            if (status === 'pool_member') {
                var pool = rec.get('poolName');
                if (pool) {
                    var vdev = rec.get('vdevName') || rec.get('vdevRole') || '';
                    return vdev ? (pool + ' / ' + vdev) : pool;
                }
            }
            // AHR members group under "<pool> / <array>", parallel to the ZFS
            // "<pool> / <vdev>" branch above (AHR is not ZFS — a visible, honest
            // divergence, but the grouping shape is the same).
            if (status === 'ahr_member') {
                var ahrPool = rec.get('poolName');
                if (ahrPool) {
                    var arr = rec.get('ahrArray') || '';
                    return arr ? (ahrPool + ' / ' + arr) : ahrPool;
                }
            }
            switch (status) {
                case 'available':
                    return t('Available');
                case 'system':
                    return t('System');
                // Ceph OSDs group under the technology: the OSD's cluster and
                // id are not in the disks payload, so there is no "<pool> /
                // <member>" pair to render honestly.
                case 'ceph_osd':
                    return t('Ceph');
                default:
                    return t('Other');
            }
        } catch (e) {
            return t('Other');
        }
    }

    // Build the grouping feature for the grid. Returns an empty array if the
    // feature cannot be constructed, so the grid still renders ungrouped —
    // graceful degradation per the story.
    function groupingFeatures() {
        try {
            return [{
                ftype: 'grouping',
                // Group header shows the pool/vdev label + a member count so a
                // vdev's disk count is visible at a glance.
                groupHeaderTpl: '{name} ({rows.length})',
                enableGroupingMenu: false,
                collapsible: true,
            }];
        } catch (e) {
            ANAS.warn('disk grouping disabled: ' + ANAS.errText(e));
            return [];
        }
    }

    // --- gfx disk objects (story 3.20 / epic 15.5) -----------------------
    //
    // Extend the ANAS.gfx visual language to the Disk Health grid: each row leads
    // with a skeuomorphic disk object (HDD platter / SSD / NVMe stick) coloured by
    // health, so a faulted drive reads as a dead grey disk at a glance instead of
    // living only in a text column. Purely additive — the object is prepended to
    // the existing Disk cell; every column and behaviour is unchanged. Fail open:
    // any gfx trouble degrades silently to the original text.

    // Map a disk record to a gfx object kind. NVMe wins on transport (or an nvmeN
    // kernel name); otherwise the rotational flag decides SSD vs HDD. Unknown
    // rotational falls back to 'hdd' (the safe, common default). Uses only fields
    // the store already carries: transport, name, rotational.
    function gfxKind(d) {
        var tran = ('' + (d.transport || '')).toLowerCase();
        var name = ('' + (d.name || '')).toLowerCase();
        if (tran === 'nvme' || name.indexOf('nvme') === 0) {
            return 'nvme';
        }
        if (d.rotational === false) {
            return 'ssd';
        }
        // rotational === true → HDD; unknown/undefined → HDD default.
        return 'hdd';
    }

    // Map the fused health signal to a gfx status state (drives the corner dot and
    // the faulted greyscale treatment). Reads the same healthStatus the Health
    // column and healthRank sort already use, so the object matches its row.
    //   critical → 'faulted'   spare role → 'spare'   warning → 'degraded'
    //   healthy  → 'online'    unknown    → null (plain object, no dot)
    // Returns null when there is no health to show — we do not invent a dot.
    function gfxState(d) {
        var health = d.healthStatus;
        if (health === 'critical') {
            return 'faulted';
        }
        if (d.vdevRole === 'spare') {
            return 'spare';
        }
        if (health === 'warning') {
            return 'degraded';
        }
        if (health === 'healthy') {
            return 'online';
        }
        return null;
    }

    // Build the leading gfx disk object markup for a disk record. Returns '' on any
    // failure or when gfx is unavailable, so renderDisk falls back to plain text.
    function diskObjHtml(d) {
        try {
            if (!ANAS.gfx || typeof ANAS.gfx.icon !== 'function') {
                return '';
            }
            var kind = gfxKind(d);
            var state = gfxState(d);
            var level = d.healthStatus || 'unknown';
            var healthLabel = (HEALTH[level] || HEALTH.unknown).label;
            var title = ANAS.gfx.kindLabel(kind) + ' — ' + t(healthLabel);
            var opts = { title: title, scale: 0.62 };
            if (state) {
                opts.state = state;
            }
            return ANAS.gfx.icon(kind, opts);
        } catch (e) {
            return '';
        }
    }

    // --- Renderers -------------------------------------------------------

    function renderSize(v) {
        if (typeof v !== 'number' || isNaN(v)) {
            return t('N/A');
        }
        return enc(ANAS.formatBytes(v));
    }

    // Health: the leftmost, most prominent column. Colored icon + label from the
    // fused healthStatus. Adds tdCls 'anas-health-<level>' for styling/tests.
    function renderHealthStatus(v, meta, rec) {
        var level = v || 'unknown';
        var info = HEALTH[level] || HEALTH.unknown;
        try {
            if (meta) {
                meta.tdCls = 'anas-health-' + level;
            }
        } catch (e) {
            // non-fatal — styling hook only
        }
        var icon = '<i class="fa fa-' + info.icon + '" style="color:' + info.color + ';"></i> ';
        return icon + colored(t(info.label), info.color);
    }

    // Disk identity: the STABLE by-id (emphasised) is the primary identifier —
    // kernel names (sdb) change across reboots and must never be identity. The
    // kernel name is kept as a small secondary hint since it's familiar and
    // short; model follows if present.
    function renderDisk(v, meta, rec) {
        var d = rec.data;
        var byId = d.id || d.name || '';
        var head = '<b>' + enc(byId) + '</b>';
        var sub = [];
        if (d.name && d.name !== byId) {
            sub.push(enc(d.name));
        }
        var model = d.model || d.modelFamily || '';
        if (model) {
            sub.push(enc(model));
        }
        var text = sub.length
            ? head + '<br><span style="color:gray;font-size:0.9em;">'
                + sub.join(' &middot; ') + '</span>'
            : head;
        // Lead with the skeuomorphic gfx disk object (epic 15.5). Fail open: if
        // the object cannot be built, render the identity text exactly as before.
        var obj = diskObjHtml(d);
        if (obj) {
            return '<span class="anas-disk-obj" style="display:inline-flex;'
                + 'align-items:center;gap:8px;">' + obj
                + '<span style="min-width:0;">' + text + '</span></span>';
        }
        return text;
    }

    // Usage in ZFS terms: for a pool member, "pool / vdev / role"; otherwise the
    // plain usage status (available / system / Ceph OSD / other).
    function renderUsage(v, meta, rec) {
        var d = rec.data;
        if (d.status === 'pool_member') {
            var parts = [];
            parts.push(d.poolName || '?');
            if (d.vdevName) {
                parts.push(d.vdevName);
            }
            if (d.vdevRole) {
                parts.push(t(ROLE_LABELS[d.vdevRole] || d.vdevRole));
            }
            return enc(parts.join(' / '));
        }
        // AHR member: "pool / array" — the AHR parallel to the ZFS pool/vdev
        // rendering above (never "Other").
        if (d.status === 'ahr_member') {
            var ahrParts = [];
            ahrParts.push(d.poolName || '?');
            if (d.ahrArray) {
                ahrParts.push(d.ahrArray);
            }
            return enc(ahrParts.join(' / '));
        }
        switch (d.status) {
            case 'available':
                return t('Available');
            case 'system':
                return t('System');
            case 'ceph_osd':
                return t('Ceph OSD');
            case 'other':
            default:
                if (d.partitions && d.partitions.length) {
                    return t('Partitioned');
                }
                return t('In use');
        }
    }

    // ZFS error counts "R/W/C" for a pool member; highlighted red when any are
    // non-zero (the triage signal). "—" when the disk is not a pool member.
    function renderZfsErrors(v, meta, rec) {
        var e = rec.data.zfsErrors;
        if (!e) {
            return '<span style="color:' + COLOR_UNKNOWN + ';">&mdash;</span>';
        }
        var r = e.read || 0;
        var w = e.write || 0;
        var c = e.checksum || 0;
        var text = r + '/' + w + '/' + c;
        if (r > 0 || w > 0 || c > 0) {
            return colored(text, COLOR_CRITICAL);
        }
        return enc(text);
    }

    // SMART overall pass/fail from smartHealthy (true / false / null).
    function renderSmart(v) {
        if (v === true) {
            return colored(t('PASSED'), COLOR_HEALTHY);
        }
        if (v === false) {
            return colored(t('FAILED'), COLOR_CRITICAL);
        }
        return colored(t('N/A'), COLOR_UNKNOWN);
    }

    // Small inline legend of the health colors for the toolbar.
    function legendHtml() {
        var keys = ['critical', 'warning', 'healthy', 'unknown'];
        var out = '<span style="color:gray;">' + enc(t('Health')) + ':</span> ';
        for (var i = 0; i < keys.length; i++) {
            var info = HEALTH[keys[i]];
            out += '<span style="margin:0 6px;white-space:nowrap;">'
                + '<i class="fa fa-' + info.icon + '" style="color:' + info.color + ';"></i> '
                + colored(t(info.label), info.color) + '</span>';
        }
        return out;
    }

    // --- S.M.A.R.T. detail window ---------------------------------------

    // Attributes grid store (ATA/SATA disks: attribute table present).
    function makeAttributeStore(attributes) {
        return Ext.create('Ext.data.Store', {
            fields: [
                { name: 'id', type: 'number' },
                { name: 'name', type: 'string' },
                { name: 'value', type: 'number' },
                { name: 'worst', type: 'number' },
                { name: 'threshold', type: 'number' },
                { name: 'rawValue', type: 'number' },
                { name: 'failing', type: 'boolean' },
            ],
            data: attributes || [],
        });
    }

    // Name/value summary store for the NVMe / device shape (no attribute table)
    // — used when SmartData.attributes is empty.
    function makeSummaryStore(smart) {
        var rows = [];
        function push(name, value) {
            rows.push({ name: name, value: '' + value });
        }
        push(t('Supported'), smart.supported ? t('Yes') : t('No'));
        push(t('Enabled'), smart.enabled ? t('Yes') : t('No'));
        push(t('Overall Health'), smart.overallHealth);
        if (smart.temperature !== null && smart.temperature !== undefined) {
            push(t('Temperature'), smart.temperature + ' °C');
        }
        if (smart.powerOnHours !== null && smart.powerOnHours !== undefined) {
            push(t('Power-On Hours'), smart.powerOnHours);
        }
        if (smart.nvmePercentageUsed !== null && smart.nvmePercentageUsed !== undefined) {
            push(t('Percentage Used'), smart.nvmePercentageUsed + '%');
        }
        if (smart.nvmeAvailableSpare !== null && smart.nvmeAvailableSpare !== undefined) {
            push(t('Available Spare'), smart.nvmeAvailableSpare + '%');
        }
        return Ext.create('Ext.data.Store', {
            fields: [{ name: 'name', type: 'string' }, { name: 'value', type: 'string' }],
            data: rows,
        });
    }

    function attributeColumns() {
        return [
            { text: t('ID'), dataIndex: 'id', width: 50, align: 'right' },
            {
                text: t('Attribute'),
                dataIndex: 'name',
                flex: 1,
                renderer: Ext.String.htmlEncode,
            },
            { text: t('Value'), dataIndex: 'value', width: 70, align: 'right' },
            { text: t('Worst'), dataIndex: 'worst', width: 70, align: 'right' },
            { text: t('Threshold'), dataIndex: 'threshold', width: 80, align: 'right' },
            { text: t('Raw'), dataIndex: 'rawValue', width: 100, align: 'right' },
            {
                text: t('Failing'),
                dataIndex: 'failing',
                width: 70,
                renderer: function (v) {
                    return v ? colored(t('Yes'), COLOR_CRITICAL) : t('No');
                },
            },
        ];
    }

    function summaryColumns() {
        return [
            {
                text: t('Field'),
                dataIndex: 'name',
                width: 200,
                renderer: Ext.String.htmlEncode,
            },
            {
                text: t('Value'),
                dataIndex: 'value',
                flex: 1,
                renderer: Ext.String.htmlEncode,
            },
        ];
    }

    // Open the S.M.A.R.T. window for one disk record. node is captured by the view.
    function openSmartWindow(node, rec) {
        if (!rec) {
            return;
        }
        var disk = rec.data;
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                title: t('S.M.A.R.T. Values') + ' (' + (disk.name || disk.id) + ')',
                modal: true,
                width: 820,
                height: 520,
                minWidth: 400,
                minHeight: 300,
                layout: 'fit',
                bodyPadding: 5,
                items: [{
                    xtype: 'panel',
                    itemId: 'smartContent',
                    layout: 'fit',
                    border: false,
                    html: '<div style="padding:20px;">' + enc(t('Loading...')) + '</div>',
                }],
                buttons: [
                    {
                        text: t('Reload'),
                        handler: function () {
                            loadSmart(node, disk, win);
                        },
                    },
                    {
                        text: t('Close'),
                        handler: function () {
                            win.close();
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('smart window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadSmart(node, disk, win);
    }

    function loadSmart(node, disk, win) {
        if (win.destroyed || win.destroying) {
            return;
        }
        var content = win.down('#smartContent');
        if (!content) {
            return;
        }
        content.removeAll();
        content.setLoading(true);
        ANAS.api.get(node, '/disks/' + encodeURIComponent(disk.id) + '/smart').then(
            function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                content.setLoading(false);
                var smart = (res && res.data) ? res.data : {};
                var hasAttrs = smart.attributes && smart.attributes.length > 0;
                content.add({
                    xtype: 'gridpanel',
                    border: false,
                    scrollable: true,
                    emptyText: t('No S.M.A.R.T. Values'),
                    store: hasAttrs ? makeAttributeStore(smart.attributes) : makeSummaryStore(smart),
                    columns: hasAttrs ? attributeColumns() : summaryColumns(),
                });
            },
            function (err) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                content.setLoading(false);
                content.removeAll();
                ANAS.warn('smart load failed: ' + ANAS.errText(err));
                content.add(ANAS.errorPanel(
                    t('Failed to load S.M.A.R.T. data') + ': ' + ANAS.errText(err)));
            },
        );
    }

    // --- Disk Health grid ------------------------------------------------

    function loadDisks(view, node) {
        var grid = view.down('#anasDisksGrid');
        if (!grid) {
            return;
        }
        grid.setLoading(true);
        ANAS.api.get(node, '/disks').then(
            function (res) {
                if (view.destroyed || view.destroying) {
                    return;
                }
                grid.setLoading(false);
                var disks = (res && res.data) ? res.data : [];
                grid.getStore().loadData(disks);
            },
            function (err) {
                if (view.destroyed || view.destroying) {
                    return;
                }
                grid.setLoading(false);
                ANAS.warn('disks load failed: ' + ANAS.errText(err));
                // Fail open: replace the whole view with an error panel.
                view.removeAll();
                view.add(ANAS.errorPanel(t('Failed to load disks') + ': ' + ANAS.errText(err)));
            },
        );
    }

    function selectedRecord(view) {
        var grid = view.down('#anasDisksGrid');
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function disksView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'id', 'name', 'path', 'model', 'modelFamily', 'serial',
                'transport', 'formFactor', 'status',
                'poolName', 'vdevName', 'vdevRole', 'ahrArray', 'healthStatus',
                { name: 'size', type: 'number' },
                { name: 'rotational', type: 'boolean' },
                { name: 'smartHealthy' },
                { name: 'zfsErrors' },
                { name: 'partitions' },
                // Derived triage rank: at-risk disks sort first (critical → warning
                // → healthy → unknown), across ALL pools. This is the whole point.
                {
                    name: 'healthRank',
                    type: 'int',
                    convert: function (v, rec) {
                        var info = HEALTH[rec.get('healthStatus')] || HEALTH.unknown;
                        return info.rank;
                    },
                },
                // Derived pool → vdev group key (story 3.20). Placed after the
                // pool/vdev/status fields so rec.get() sees populated values.
                {
                    name: 'groupKey',
                    type: 'string',
                    convert: function (v, rec) {
                        return groupKeyFor(rec);
                    },
                },
            ],
            data: [],
            // Group by pool → vdev; disks not in a pool share one group.
            groupField: 'groupKey',
            // Default sort within each group: at-risk first, stable tiebreak
            // by device name (the global triage order still holds per group).
            sorters: [
                { property: 'healthRank', direction: 'ASC' },
                { property: 'name', direction: 'ASC' },
            ],
        });

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-disks',
            title: t('Disk Health'),
            layout: 'fit',
            border: false,
            items: [{
                xtype: 'gridpanel',
                itemId: 'anasDisksGrid',
                cls: 'anas-grid-disks anas-grid-disks-grouped',
                border: false,
                store: store,
                // Group by pool → vdev (story 3.20); [] → ungrouped fallback.
                features: groupingFeatures(),
                emptyText: t('No disks found'),
                // The Disk cell renders the by-id over the kernel name/model on
                // two lines, so let row height grow to fit.
                variableRowHeight: true,
                selModel: { mode: 'SINGLE' },
                columns: [
                    {
                        text: t('Health'),
                        dataIndex: 'healthStatus',
                        width: 120,
                        renderer: renderHealthStatus,
                    },
                    {
                        text: t('Disk'),
                        dataIndex: 'name',
                        flex: 1,
                        renderer: renderDisk,
                    },
                    {
                        text: t('Size'),
                        dataIndex: 'size',
                        width: 100,
                        align: 'right',
                        renderer: renderSize,
                    },
                    {
                        text: t('Usage'),
                        dataIndex: 'status',
                        width: 220,
                        renderer: renderUsage,
                    },
                    {
                        text: t('ZFS Errors (R/W/C)'),
                        dataIndex: 'zfsErrors',
                        width: 140,
                        align: 'center',
                        renderer: renderZfsErrors,
                    },
                    {
                        text: t('S.M.A.R.T.'),
                        dataIndex: 'smartHealthy',
                        width: 100,
                        renderer: renderSmart,
                    },
                ],
                tbar: [
                    {
                        text: t('Reload'),
                        cls: 'anas-btn-refresh',
                        iconCls: 'fa fa-refresh',
                        handler: function (btn) {
                            loadDisks(btn.up('panel[cls~=anas-view-disks]'), node);
                        },
                    },
                    {
                        text: t('SMART Details'),
                        cls: 'anas-btn-smart',
                        itemId: 'anasBtnSmart',
                        iconCls: 'fa fa-heartbeat',
                        disabled: true,
                        handler: function (btn) {
                            var view = btn.up('panel[cls~=anas-view-disks]');
                            openSmartWindow(node, selectedRecord(view));
                        },
                    },
                    '->',
                    { xtype: 'tbtext', html: legendHtml() },
                ],
                listeners: {
                    selectionchange: function (sm, selected) {
                        var btn = this.down('#anasBtnSmart');
                        if (btn) {
                            btn.setDisabled(!selected || !selected.length);
                        }
                    },
                    itemdblclick: function (grid, rec) {
                        openSmartWindow(node, rec);
                    },
                },
            }],
            listeners: {
                afterrender: function (view) {
                    loadDisks(view, node);
                },
            },
        };
    }

    // --- View registration ----------------------------------------------

    ANAS.views['disks'] = {
        itemId: 'anas-disks',
        // Menu label stays "Disks" (integration tests open the item by this text);
        // the grid itself is titled "Disk Health".
        text: t('Disks'),
        iconCls: 'fa fa-heartbeat',
        factory: function (node) {
            try {
                return disksView(node);
            } catch (e) {
                ANAS.warn('disks view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
