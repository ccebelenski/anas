/*
 * ANAS — Create Pool action (story 3.8).
 *
 * Registers a "Create" toolbar action into the Pools view's action registry
 * (30-pools.js). Opens a window with a pool-name field, a redundancy selector,
 * and a checkbox grid of usable disks (GET /disks, filtered to available).
 * Submit builds a CreatePoolRequest and runs it through the shared job helper.
 *
 * Data:
 *   GET  /disks        → { data: Disk[] }   (status 'available' are usable)
 *   POST /pools        → 202 { job }        (CreatePoolRequest body)
 *
 * ES5, no build step. Fail open: guarded so a standalone load never throws, and
 * a broken handler warns instead of breaking PVE.
 */
(function () {
    'use strict';

    // Guard: only wire up when the Pools action registry is present.
    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.pools) {
        return;
    }

    var ANAS = window.ANAS;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    // Minimum disks per redundancy type — mirrors the shared VdevSpec .check().
    var MIN_DISKS = {
        stripe: 1,
        mirror: 2,
        raidz: 3,
        raidz2: 4,
        raidz3: 5,
    };

    function alertMsg(title, msg) {
        try {
            Ext.Msg.alert(t(title), t(msg));
        } catch (e) {
            ANAS.warn(msg);
        }
    }

    function loadDisks(win, node) {
        var diskGrid = win.down('#diskGrid');
        if (!diskGrid) {
            return;
        }
        diskGrid.setLoading(true);
        ANAS.api.get(node, '/disks').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            diskGrid.setLoading(false);
            var all = (res && res.data) || [];
            var usable = [];
            for (var i = 0; i < all.length; i++) {
                if (all[i].status === 'available') {
                    usable.push(all[i]);
                }
            }
            diskGrid.getStore().loadData(usable);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            diskGrid.setLoading(false);
            ANAS.warn('create-pool disk load failed: ' + ANAS.errText(err));
            alertMsg('Error', t('Failed to load disks') + ': ' + ANAS.errText(err));
        });
    }

    function submit(win, node, grid) {
        var nameField = win.down('#poolName');
        var redundancyField = win.down('#redundancy');
        var diskGrid = win.down('#diskGrid');
        if (!nameField || !redundancyField || !diskGrid) {
            return;
        }

        var name = (nameField.getValue() || '').trim();
        var type = redundancyField.getValue();
        var selection = diskGrid.getSelection() || [];
        var disks = [];
        for (var i = 0; i < selection.length; i++) {
            disks.push(selection[i].get('id'));
        }

        if (!name) {
            alertMsg('Invalid input', 'Enter a pool name.');
            return;
        }
        var min = MIN_DISKS[type] || 1;
        if (disks.length < min) {
            alertMsg('Invalid input',
                type + ' ' + t('requires at least') + ' ' + min + ' ' + t('disk(s).'));
            return;
        }

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools',
            body: {
                name: name,
                dataVdevs: [{ type: type, disks: disks }],
            },
            view: win,
            failTitle: 'Create failed',
            successMsg: t('Pool created') + ': ' + name,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                ANAS.pools.reload(grid, node);
            },
        });
    }

    function openCreateWindow(node, grid) {
        var diskStore = Ext.create('Ext.data.Store', {
            fields: [
                'id', 'name', 'model', 'modelFamily', 'poolName', 'status',
                { name: 'size', type: 'int' },
            ],
            data: [],
        });

        var redundancyStore = Ext.create('Ext.data.Store', {
            fields: ['value', 'label'],
            data: [
                { value: 'stripe', label: t('Stripe (no redundancy)') },
                { value: 'mirror', label: t('Mirror') },
                { value: 'raidz', label: t('RAIDZ') },
                { value: 'raidz2', label: t('RAIDZ2') },
                { value: 'raidz3', label: t('RAIDZ3') },
            ],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-create',
                title: t('Create Pool'),
                modal: true,
                width: 660,
                height: 540,
                minWidth: 420,
                minHeight: 360,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    border: false,
                    bodyPadding: 12,
                    layout: { type: 'vbox', align: 'stretch' },
                    defaults: { labelWidth: 120 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'poolName',
                            cls: 'anas-field-poolname',
                            fieldLabel: t('Pool Name'),
                            allowBlank: false,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'redundancy',
                            cls: 'anas-field-redundancy',
                            fieldLabel: t('Redundancy'),
                            store: redundancyStore,
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            value: 'mirror',
                        },
                        {
                            xtype: 'grid',
                            itemId: 'diskGrid',
                            cls: 'anas-grid-create-disks',
                            flex: 1,
                            margin: '8 0 0 0',
                            emptyText: t('No usable disks found'),
                            store: diskStore,
                            selModel: { type: 'checkboxmodel', mode: 'SIMPLE' },
                            columns: [
                                {
                                    text: t('Disk'),
                                    dataIndex: 'id',
                                    flex: 1,
                                    renderer: Ext.String.htmlEncode,
                                },
                                {
                                    text: t('Model'),
                                    dataIndex: 'model',
                                    width: 180,
                                    renderer: function (v, meta, rec) {
                                        var m = rec.get('model') || rec.get('modelFamily') || '';
                                        return Ext.String.htmlEncode(m);
                                    },
                                },
                                {
                                    text: t('Size'),
                                    dataIndex: 'size',
                                    width: 110,
                                    align: 'right',
                                    renderer: ANAS.formatBytes,
                                },
                            ],
                        },
                    ],
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Create'),
                        cls: 'anas-btn-create-submit',
                        handler: function () {
                            try {
                                submit(win, node, grid);
                            } catch (e) {
                                ANAS.warn('create-pool submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('create-pool window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        loadDisks(win, node);
    }

    ANAS.pools.registerAction({
        itemId: 'createPool',
        text: 'Create',
        cls: 'anas-btn-create',
        iconCls: 'fa fa-plus',
        needsSelection: false,
        handler: function (node, grid) {
            openCreateWindow(node, grid);
        },
    });
})();
