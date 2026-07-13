/*
 * ANAS — Attach / Replace disk action (story 3.12).
 *
 * Registers an "Attach / Replace" toolbar action into the Pools grid (via the
 * pools action registry from 30-pools.js). The window pairs an existing pool
 * device (from the pool topology) with a new available disk and a mode:
 *   attach  — add a mirror leg to an existing device (restore/add redundancy)
 *   replace — swap a failed/old device for a new one
 * and submits POST /pools/<name>/attach through the shared job helper.
 *
 * FRAMEWORK CONTRACT: window.ANAS.pools.registerAction, ANAS.api.get,
 * ANAS.runJob, ANAS.pools.reload, ANAS.t / ANAS.warn / ANAS.errText.
 * Fail open: guarded IIFE; a throw never breaks PVE.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    // Fail open: only register when the pools framework is present.
    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.pools) {
        return;
    }

    var ANAS = window.ANAS;

    // Flatten a PoolDetail's vdevGroups → vdevs → disks into a flat list of
    // { id, label } for the existing-device picker.
    function flattenPoolDisks(detail) {
        var out = [];
        var groups = (detail && detail.vdevGroups) || [];
        for (var gi = 0; gi < groups.length; gi++) {
            var vdevs = groups[gi].vdevs || [];
            for (var vi = 0; vi < vdevs.length; vi++) {
                var v = vdevs[vi];
                var disks = v.disks || [];
                for (var di = 0; di < disks.length; di++) {
                    var d = disks[di];
                    out.push({
                        id: d.id,
                        label: d.id + '  (' + (v.name || '?') + ', ' + d.state + ')',
                    });
                }
            }
        }
        return out;
    }

    function loadExistingDevices(win, node, poolName) {
        var combo = win.down('#existingDisk');
        if (!combo) {
            return;
        }
        combo.setLoading(true);
        ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            combo.setLoading(false);
            var rows = flattenPoolDisks(res && res.data);
            combo.getStore().loadData(rows);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            combo.setLoading(false);
            ANAS.warn('attach: pool topology load failed: ' + ANAS.errText(err));
            try {
                Ext.Msg.alert(ANAS.t('Error'),
                    ANAS.t('Failed to load pool detail') + ': ' + ANAS.errText(err));
            } catch (e) {
                // non-fatal
            }
        });
    }

    function loadNewDisks(win, node) {
        var combo = win.down('#newDisk');
        if (!combo) {
            return;
        }
        combo.setLoading(true);
        ANAS.api.get(node, '/disks').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            combo.setLoading(false);
            var disks = (res && res.data) ? res.data : [];
            var rows = [];
            for (var i = 0; i < disks.length; i++) {
                if (disks[i].status === 'available') {
                    var d = disks[i];
                    rows.push({
                        id: d.id,
                        label: d.id + '  (' + ANAS.formatBytes(d.size) + ')',
                    });
                }
            }
            combo.getStore().loadData(rows);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            combo.setLoading(false);
            ANAS.warn('attach: disk load failed: ' + ANAS.errText(err));
            try {
                Ext.Msg.alert(ANAS.t('Error'),
                    ANAS.t('Failed to load disks') + ': ' + ANAS.errText(err));
            } catch (e) {
                // non-fatal
            }
        });
    }

    function idCombo(itemId, label) {
        return {
            xtype: 'combobox',
            itemId: itemId,
            fieldLabel: label,
            labelWidth: 120,
            editable: false,
            queryMode: 'local',
            displayField: 'label',
            valueField: 'id',
            emptyText: ANAS.t('Select a disk'),
            store: Ext.create('Ext.data.Store', {
                fields: ['id', 'label'],
                data: [],
            }),
        };
    }

    function submitAttach(win, node, poolName) {
        var modeField = win.down('#attachMode');
        var existingField = win.down('#existingDisk');
        var newField = win.down('#newDisk');
        if (!modeField || !existingField || !newField) {
            return;
        }
        var existingDiskId = existingField.getValue();
        var newDiskId = newField.getValue();
        // The mode radio group maps to the schema's boolean `replace`.
        var modeVal = modeField.getValue();
        var replace = !!(modeVal && modeVal.mode === 'replace');
        if (!existingDiskId || !newDiskId) {
            try {
                Ext.Msg.alert(ANAS.t('Attach / Replace'),
                    ANAS.t('Select both an existing device and a new disk.'));
            } catch (e) {
                // non-fatal
            }
            return;
        }
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools/' + encodeURIComponent(poolName) + '/attach',
            body: {
                existingDiskId: existingDiskId,
                newDiskId: newDiskId,
                replace: replace,
            },
            view: win,
            failTitle: replace ? 'Replace failed' : 'Attach failed',
            successMsg: (replace
                ? ANAS.t('Replacing device in pool')
                : ANAS.t('Attaching device to pool')) + ' ' + poolName,
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

    function openAttachWindow(node, grid, poolName) {
        if (!poolName) {
            return;
        }
        var win = Ext.create('Ext.window.Window', {
            cls: 'anas-win-attach',
            title: ANAS.t('Attach / Replace') + ': ' + poolName,
            modal: true,
            width: 620,
            bodyPadding: 12,
            layout: { type: 'vbox', align: 'stretch' },
            items: [
                {
                    xtype: 'radiogroup',
                    itemId: 'attachMode',
                    fieldLabel: ANAS.t('Mode'),
                    labelWidth: 120,
                    columns: 1,
                    vertical: true,
                    items: [
                        {
                            boxLabel: ANAS.t('Attach (add a mirror leg to a device)'),
                            name: 'mode',
                            inputValue: 'attach',
                            checked: true,
                        },
                        {
                            boxLabel: ANAS.t('Replace (swap a failed/old device)'),
                            name: 'mode',
                            inputValue: 'replace',
                        },
                    ],
                },
                idCombo('existingDisk', ANAS.t('Existing device')),
                idCombo('newDisk', ANAS.t('New disk')),
            ],
            buttons: [
                {
                    text: ANAS.t('Submit'),
                    cls: 'anas-btn-attach-submit',
                    handler: function () {
                        submitAttach(win, node, poolName);
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
        win.anasGrid = grid;
        win.show();
        loadExistingDevices(win, node, poolName);
        loadNewDisks(win, node);
    }

    ANAS.pools.registerAction({
        itemId: 'attachDisk',
        text: 'Attach / Replace',
        cls: 'anas-btn-attach',
        iconCls: 'fa fa-exchange',
        needsSelection: true,
        disableWhileScanning: false,
        handler: function (node, grid, poolName) {
            try {
                openAttachWindow(node, grid, poolName);
            } catch (e) {
                ANAS.warn('attach window failed: ' + ANAS.errText(e));
            }
        },
    });
})();
