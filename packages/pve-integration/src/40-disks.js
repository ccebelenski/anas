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
        try {
            return Ext.String.htmlEncode('' + s);
        } catch (e) {
            return '' + s;
        }
    }

    function colored(text, color) {
        return '<span style="color:' + color + ';">' + enc(text) + '</span>';
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

    // Disk identity: device name (emphasised) plus model / model family.
    function renderDisk(v, meta, rec) {
        var d = rec.data;
        var name = d.name || d.id || '';
        var model = d.model || d.modelFamily || '';
        var head = '<b>' + enc(name) + '</b>';
        if (model) {
            return head + ' <span style="color:gray;">' + enc(model) + '</span>';
        }
        return head;
    }

    // Usage in ZFS terms: for a pool member, "pool / vdev / role"; otherwise the
    // plain usage status (available / system / other).
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
        switch (d.status) {
            case 'available':
                return t('Available');
            case 'system':
                return t('System');
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
                'poolName', 'vdevName', 'vdevRole', 'healthStatus',
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
            ],
            data: [],
            // Default sort: at-risk first, stable tiebreak by device name.
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
                cls: 'anas-grid-disks',
                border: false,
                store: store,
                emptyText: t('No disks found'),
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
