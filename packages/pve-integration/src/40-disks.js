/*
 * ANAS — Disks view (story 13.11).
 *
 * Native ExtJS grid of physical disks with usage/health, plus a S.M.A.R.T.
 * detail window. Registered into the ANAS panel framework by assignment; the
 * factory is invoked at runtime (Ext fully available) when the view is shown.
 *
 * FRAMEWORK CONTRACT: window.ANAS exists with ANAS.api.get/post/put/del
 * (Promise-returning, path relative to /v1, rejections carry .status/.body) and
 * ANAS.formatBytes(n). The framework wraps this view in the "not installed"
 * probe — we do NOT probe health here. Fail open: any error renders an error
 * panel inside the view and never breaks the PVE UI.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    // Guard: only register when the framework namespace is present. Our file is
    // concatenated after the framework, so this is normally satisfied; the guard
    // keeps a standalone load (e.g. a test harness) from throwing.
    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    // PVE-style status colors (inline so the script stays self-contained).
    var COLOR_OK = '#21BF4B';
    var COLOR_BAD = '#FF0000';
    var COLOR_MUTED = '#888888';

    function t(str) {
        return (typeof gettext === 'function') ? gettext(str) : str;
    }

    function colored(text, color) {
        return '<span style="color:' + color + ';">'
            + Ext.String.htmlEncode(text) + '</span>';
    }

    function errText(e) {
        if (!e) {
            return t('Unknown error');
        }
        // ANAS.api rejections carry a structured .body ({ error: { message } }).
        if (e.body && e.body.error && e.body.error.message) {
            return e.body.error.message;
        }
        return e.message ? e.message : ('' + e);
    }

    // A simple centered error panel used as the fail-open surface for a view.
    function errorPanel(prefix, e) {
        var status = (e && e.status) ? (' (HTTP ' + e.status + ')') : '';
        return {
            xtype: 'panel',
            border: false,
            bodyPadding: 20,
            html: '<div style="color:' + COLOR_BAD + ';">'
                + Ext.String.htmlEncode(prefix + errText(e) + status)
                + '</div>',
        };
    }

    // --- Renderers -------------------------------------------------------

    function renderSize(v) {
        if (typeof v !== 'number') {
            return t('N/A');
        }
        return Ext.String.htmlEncode(ANAS.formatBytes(v));
    }

    function renderModel(v, meta, rec) {
        var d = rec.data;
        var model = d.model || d.modelFamily || '';
        return model ? Ext.String.htmlEncode(model) : t('Unknown');
    }

    // Usage status: available (unpartitioned), pool member (with pool name),
    // system, or other/partitioned.
    function renderUsage(v, meta, rec) {
        var d = rec.data;
        switch (d.status) {
            case 'pool_member':
                return Ext.String.htmlEncode(t('Pool') + ': ' + (d.poolName || '?'));
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

    // SMART health: true=passed, false=failed, null=unknown/unsupported.
    function renderHealth(v) {
        if (v === true) {
            return colored(t('PASSED'), COLOR_OK);
        }
        if (v === false) {
            return colored(t('FAILED'), COLOR_BAD);
        }
        return colored(t('N/A'), COLOR_MUTED);
    }

    // --- SMART detail window --------------------------------------------

    // Build the attributes grid store (ATA/SATA disks: attribute table present).
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

    // Build a name/value summary store for the device/NVMe shape (no attribute
    // table) — used when SmartData.attributes is empty.
    function makeSummaryStore(smart) {
        var rows = [];
        function push(name, value) {
            rows.push({ name: name, value: value });
        }
        push(t('Supported'), smart.supported ? t('Yes') : t('No'));
        push(t('Enabled'), smart.enabled ? t('Yes') : t('No'));
        push(t('Overall Health'), smart.overallHealth);
        if (smart.temperature !== null && smart.temperature !== undefined) {
            push(t('Temperature'), smart.temperature + ' °C');
        }
        if (smart.powerOnHours !== null && smart.powerOnHours !== undefined) {
            push(t('Power-On Hours'), '' + smart.powerOnHours);
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
                    return v ? colored(t('Yes'), COLOR_BAD) : t('No');
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

    // Open the SMART window for one disk record. node is captured by the view.
    function openSmartWindow(node, rec) {
        if (!rec) {
            return;
        }
        var disk = rec.data;
        var win = Ext.create('Ext.window.Window', {
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
                html: '<div style="padding:20px;">' + t('Loading...') + '</div>',
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
        win.show();
        loadSmart(node, disk, win);
    }

    function loadSmart(node, disk, win) {
        var content = win.down('#smartContent');
        if (!content) {
            return;
        }
        content.removeAll();
        content.setLoading(true);
        ANAS.api.get(node, '/disks/' + encodeURIComponent(disk.id) + '/smart').then(
            function (res) {
                if (win.isDestroyed) {
                    return;
                }
                content.setLoading(false);
                var smart = (res && res.data) ? res.data : {};
                var hasAttrs = smart.attributes && smart.attributes.length > 0;
                if (hasAttrs) {
                    content.add({
                        xtype: 'gridpanel',
                        border: false,
                        scrollable: true,
                        emptyText: t('No S.M.A.R.T. Values'),
                        store: makeAttributeStore(smart.attributes),
                        columns: attributeColumns(),
                    });
                } else {
                    content.add({
                        xtype: 'gridpanel',
                        border: false,
                        scrollable: true,
                        emptyText: t('No S.M.A.R.T. Values'),
                        store: makeSummaryStore(smart),
                        columns: summaryColumns(),
                    });
                }
            },
            function (err) {
                if (win.isDestroyed) {
                    return;
                }
                content.setLoading(false);
                content.removeAll();
                content.add(errorPanel(t('Failed to load S.M.A.R.T. data') + ': ', err));
            },
        );
    }

    // --- Disks grid view -------------------------------------------------

    function loadDisks(view, node) {
        var grid = view.down('#anasDisksGrid');
        if (!grid) {
            return;
        }
        grid.setLoading(true);
        ANAS.api.get(node, '/disks').then(
            function (res) {
                if (view.isDestroyed) {
                    return;
                }
                grid.setLoading(false);
                var disks = (res && res.data) ? res.data : [];
                grid.getStore().loadData(disks);
            },
            function (err) {
                if (view.isDestroyed) {
                    return;
                }
                grid.setLoading(false);
                // Fail open: replace the whole view with an error panel.
                view.removeAll();
                view.add(errorPanel(t('Failed to load disks') + ': ', err));
            },
        );
    }

    ANAS.views['disks'] = {
        itemId: 'anas-disks',
        text: 'Disks',
        iconCls: 'fa fa-hdd-o',
        factory: function (node) {
            var store = Ext.create('Ext.data.Store', {
                fields: [
                    'id', 'name', 'path', 'model', 'modelFamily', 'serial',
                    'poolName', 'status',
                    { name: 'size', type: 'number' },
                    { name: 'smartHealthy' },
                    { name: 'partitions' },
                ],
                data: [],
            });

            function selectedRecord(view) {
                var grid = view.down('#anasDisksGrid');
                var sel = grid ? grid.getSelection() : [];
                return (sel && sel.length) ? sel[0] : null;
            }

            return {
                xtype: 'panel',
                cls: 'anas-view anas-view-disks',
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
                            text: t('Device'),
                            dataIndex: 'name',
                            width: 110,
                            renderer: Ext.String.htmlEncode,
                        },
                        {
                            text: t('Model'),
                            dataIndex: 'model',
                            flex: 1,
                            renderer: renderModel,
                        },
                        {
                            text: t('Serial'),
                            dataIndex: 'serial',
                            width: 180,
                            renderer: Ext.String.htmlEncode,
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
                            width: 160,
                            renderer: renderUsage,
                        },
                        {
                            text: t('S.M.A.R.T.'),
                            dataIndex: 'smartHealthy',
                            width: 100,
                            renderer: renderHealth,
                        },
                    ],
                    tbar: [
                        {
                            text: t('Refresh'),
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                loadDisks(btn.up('panel[cls~=anas-view-disks]'), node);
                            },
                        },
                        {
                            text: t('SMART Details'),
                            cls: 'anas-btn-smart',
                            itemId: 'anasBtnSmart',
                            disabled: true,
                            handler: function (btn) {
                                var view = btn.up('panel[cls~=anas-view-disks]');
                                openSmartWindow(node, selectedRecord(view));
                            },
                        },
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
        },
    };
})();
