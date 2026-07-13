/*
 * ANAS — Add Vdev action (story 3.11).
 *
 * Registers an "Add Vdev" toolbar action into the Pools grid (via the pools
 * action registry from 30-pools.js) and opens a window to pick available disks
 * and a vdev type, then submits POST /pools/<name>/vdevs through the shared job
 * helper. Expanding a pool adds a new top-level vdev — capacity, not redundancy
 * for existing data.
 *
 * FRAMEWORK CONTRACT: window.ANAS.pools.registerAction, ANAS.api.get,
 * ANAS.runJob, ANAS.pools.reload, ANAS.t / ANAS.warn / ANAS.errText.
 * Fail open: guarded IIFE; a throw never breaks PVE, at worst the action is
 * absent.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    // Fail open: only register when the pools framework is present. Our file is
    // concatenated after 30-pools.js, so this is normally satisfied.
    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.pools) {
        return;
    }

    var ANAS = window.ANAS;

    // Vdev types the API accepts (VdevSpec). 'stripe' is our synthetic type:
    // bare disks, no redundancy. Minimum disk counts mirror the shared schema.
    var VDEV_TYPES = [
        { value: 'stripe', text: 'Stripe (no redundancy)', min: 1 },
        { value: 'mirror', text: 'Mirror', min: 2 },
        { value: 'raidz', text: 'RAIDZ1', min: 3 },
        { value: 'raidz2', text: 'RAIDZ2', min: 4 },
        { value: 'raidz3', text: 'RAIDZ3', min: 5 },
    ];

    function minForType(type) {
        for (var i = 0; i < VDEV_TYPES.length; i++) {
            if (VDEV_TYPES[i].value === type) {
                return VDEV_TYPES[i].min;
            }
        }
        return 1;
    }

    function disksGrid() {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'id', 'name', 'model', 'serial',
                { name: 'size', type: 'number' },
            ],
            data: [],
        });
        return {
            xtype: 'gridpanel',
            itemId: 'availDisks',
            cls: 'anas-addvdev-disks',
            flex: 1,
            border: true,
            store: store,
            emptyText: ANAS.t('No available disks'),
            selModel: { type: 'checkboxmodel', mode: 'SIMPLE', checkOnly: true },
            columns: [
                {
                    text: ANAS.t('Device'),
                    dataIndex: 'name',
                    width: 100,
                    renderer: Ext.String.htmlEncode,
                },
                {
                    text: ANAS.t('ID'),
                    dataIndex: 'id',
                    flex: 1,
                    renderer: Ext.String.htmlEncode,
                },
                {
                    text: ANAS.t('Size'),
                    dataIndex: 'size',
                    width: 100,
                    align: 'right',
                    renderer: function (v) {
                        return Ext.String.htmlEncode(ANAS.formatBytes(v));
                    },
                },
            ],
        };
    }

    function loadAvailableDisks(win, node) {
        var grid = win.down('#availDisks');
        if (!grid) {
            return;
        }
        grid.setLoading(true);
        ANAS.api.get(node, '/disks').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            grid.setLoading(false);
            var disks = (res && res.data) ? res.data : [];
            var avail = [];
            for (var i = 0; i < disks.length; i++) {
                if (disks[i].status === 'available') {
                    avail.push(disks[i]);
                }
            }
            grid.getStore().loadData(avail);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            grid.setLoading(false);
            ANAS.warn('add-vdev disk load failed: ' + ANAS.errText(err));
            try {
                Ext.Msg.alert(ANAS.t('Error'),
                    ANAS.t('Failed to load disks') + ': ' + ANAS.errText(err));
            } catch (e) {
                // non-fatal
            }
        });
    }

    function submitAddVdev(win, node, poolName) {
        var typeField = win.down('#vdevType');
        var grid = win.down('#availDisks');
        if (!typeField || !grid) {
            return;
        }
        var type = typeField.getValue();
        var sel = grid.getSelection() || [];
        var ids = [];
        for (var i = 0; i < sel.length; i++) {
            ids.push(sel[i].get('id'));
        }
        var min = minForType(type);
        if (ids.length < min) {
            try {
                Ext.Msg.alert(ANAS.t('Add Vdev'),
                    ANAS.t('Selected type requires at least') + ' ' + min + ' '
                    + ANAS.t('disk(s).'));
            } catch (e) {
                // non-fatal
            }
            return;
        }
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools/' + encodeURIComponent(poolName) + '/vdevs',
            body: { vdev: { type: type, disks: ids } },
            view: win,
            failTitle: 'Add vdev failed',
            successMsg: ANAS.t('Vdev added to pool') + ' ' + poolName,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (ANAS.pools && ANAS.pools.reload) {
                    ANAS.pools.reload(win.anasGrid, node);
                }
            },
        });
    }

    function openAddVdevWindow(node, grid, poolName) {
        if (!poolName) {
            return;
        }
        var typeData = [];
        for (var i = 0; i < VDEV_TYPES.length; i++) {
            typeData.push([VDEV_TYPES[i].value, ANAS.t(VDEV_TYPES[i].text)]);
        }
        var win = Ext.create('Ext.window.Window', {
            cls: 'anas-win-addvdev',
            title: ANAS.t('Add Vdev') + ': ' + poolName,
            modal: true,
            width: 620,
            height: 520,
            layout: { type: 'vbox', align: 'stretch' },
            bodyPadding: 10,
            items: [
                {
                    xtype: 'combobox',
                    itemId: 'vdevType',
                    fieldLabel: ANAS.t('Vdev type'),
                    labelWidth: 90,
                    editable: false,
                    queryMode: 'local',
                    displayField: 'text',
                    valueField: 'value',
                    value: 'mirror',
                    store: Ext.create('Ext.data.ArrayStore', {
                        fields: ['value', 'text'],
                        data: typeData,
                    }),
                },
                {
                    xtype: 'component',
                    html: '<div style="color:gray;margin:6px 0;">'
                        + Ext.String.htmlEncode(ANAS.t(
                            'Select available disks to form the new vdev.'))
                        + '</div>',
                },
                disksGrid(),
            ],
            buttons: [
                {
                    text: ANAS.t('Add Vdev'),
                    cls: 'anas-btn-addvdev-submit',
                    handler: function () {
                        submitAddVdev(win, node, poolName);
                    },
                },
                {
                    text: ANAS.t('Cancel'),
                    handler: function () {
                        win.close();
                    },
                },
            ],
        });
        // Keep the pools grid so onComplete can trigger a reload.
        win.anasGrid = grid;
        win.show();
        loadAvailableDisks(win, node);
    }

    ANAS.pools.registerAction({
        itemId: 'addVdev',
        text: 'Add Vdev',
        cls: 'anas-btn-addvdev',
        iconCls: 'fa fa-plus-square',
        needsSelection: true,
        disableWhileScanning: false,
        handler: function (node, grid, poolName) {
            try {
                openAddVdevWindow(node, grid, poolName);
            } catch (e) {
                ANAS.warn('add-vdev window failed: ' + ANAS.errText(e));
            }
        },
    });
})();
