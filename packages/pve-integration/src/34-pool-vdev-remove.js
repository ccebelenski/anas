/*
 * ANAS — Remove vdev action (story vdevs.2), the add-vdev composer's twin.
 *
 * One toolbar action on the Pools grid ("Remove vdev…") opens a small window
 * listing the selected pool's REMOVABLE vdevs — cache, log and spare, the three
 * classes `zpool remove` drops instantly — and removes the picked one through
 * POST /pools/:name/vdevs/remove. A plain job: nothing is destroyed, so there is
 * no confirm code.
 *
 * Data:
 *   GET  /pools/:name                → { data: PoolDetail }  (vdevGroups)
 *   POST /pools/:name/vdevs/remove   → 202 { job }           (RemoveVdevRequest)
 *
 * The daemon is the authority on what may come out (Principle 14): it resolves
 * the name against the pool's own `zpool status` and refuses data/special/dedup
 * with one sentence, which this dialog states up front rather than hiding.
 *
 * ES5, no build step. Fail open: guarded so a standalone load never throws.
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

    // The three roles the daemon lets `zpool remove` take out — the UI half of
    // the shared REMOVABLE_VDEV_ROLES. The API decides; this only keeps rows the
    // operator cannot act on out of the picker.
    var REMOVABLE_ROLES = { cache: 1, log: 1, spare: 1 };

    // Human role labels, matching the pool-detail topology's.
    var ROLE_LABELS = { cache: 'Cache', log: 'Log', spare: 'Spare' };

    // Vdev types that GROUP their leaves: a mirrored log comes out as the whole
    // mirror-N, never one leg, so the row is the mirror. Everything else (a bare
    // cache device, a spare, a single log device) is its own row.
    var GROUPING_TYPES = {
        mirror: 1,
        raidz: 1,
        raidz2: 1,
        raidz3: 1,
        draid: 1,
        draid2: 1,
        draid3: 1,
    };

    /**
     * The name a row sends and shows: the leaf's device-path basename, which is
     * what `zpool status` calls that leaf and the one spelling that names
     * exactly one of them (00-core.js, shared with the Replace dialog).
     */
    function leafName(disk) {
        return ANAS.vdevLeafName(disk);
    }

    /**
     * The removable rows of a PoolDetail: one per mirrored log vdev, one per
     * bare cache/spare/log leaf — a section's bare leaves arrive as ONE
     * container vdev (`cache`, `spares`, `logs`) holding all of them, and each
     * leaf is separately removable, so a container yields one row per leaf.
     * `vdev` is exactly what the request body sends.
     */
    function removableRows(detail) {
        var rows = [];
        var groups = (detail && detail.vdevGroups) || [];
        for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            if (!group || !REMOVABLE_ROLES[group.role]) {
                continue;
            }
            var vdevs = group.vdevs || [];
            for (var v = 0; v < vdevs.length; v++) {
                var vdev = vdevs[v] || {};
                var disks = vdev.disks || [];
                var names = [];
                var d;
                // A grouping vdev is ALWAYS one row named `mirror-N`, whatever
                // it currently shows: `zpool remove` takes the whole vdev out,
                // so a mirror with one leg left (the other faulted away) must
                // not be offered leg by leg.
                if (GROUPING_TYPES[vdev.type]) {
                    for (d = 0; d < disks.length; d++) {
                        names.push(leafName(disks[d]));
                    }
                    rows.push({
                        role: group.role,
                        roleLabel: t(ROLE_LABELS[group.role] || group.role),
                        vdev: vdev.name,
                        state: vdev.state || '',
                        leaves: names.join(', '),
                    });
                    continue;
                }
                for (d = 0; d < disks.length; d++) {
                    var name = leafName(disks[d]);
                    if (!name) {
                        continue;
                    }
                    rows.push({
                        role: group.role,
                        roleLabel: t(ROLE_LABELS[group.role] || group.role),
                        vdev: name,
                        state: (disks[d] && disks[d].state) || vdev.state || '',
                        leaves: name,
                    });
                }
            }
        }
        return rows;
    }

    /** Pools grid + the pool-detail window behind it, after a job either way. */
    function refreshViews(node, grid, poolName) {
        try {
            ANAS.pools.reload(grid, node);
        } catch (e) {
            ANAS.warn('pools reload failed: ' + ANAS.errText(e));
        }
        try {
            if (typeof ANAS.pools.reloadDetail === 'function') {
                ANAS.pools.reloadDetail(poolName);
            }
        } catch (e2) {
            ANAS.warn('pool detail reload failed: ' + ANAS.errText(e2));
        }
    }

    function load(win, node, poolName) {
        var vdevGrid = win.down('#removableVdevs');
        if (!vdevGrid) {
            return;
        }
        vdevGrid.setLoading(true);
        ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            vdevGrid.setLoading(false);
            vdevGrid.getStore().loadData(removableRows(res && res.data));
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            vdevGrid.setLoading(false);
            ANAS.warn('pool vdev read failed: ' + ANAS.errText(err));
            ANAS.alertMsg('Error', t('Failed to read the pool topology') + ': ' + ANAS.errText(err));
        });
    }

    function submit(win, node, grid, poolName) {
        var vdevGrid = win.down('#removableVdevs');
        if (!vdevGrid) {
            return;
        }
        var sel = vdevGrid.getSelection() || [];
        if (!sel.length) {
            ANAS.alertMsg('Invalid input', 'Select a vdev to remove.');
            return;
        }
        var vdev = sel[0].get('vdev');

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools/' + encodeURIComponent(poolName) + '/vdevs/remove',
            body: { vdev: vdev },
            // The POLL view is the grid, not this window: the window closes on
            // acceptance and a dead view would silence the failure alert.
            view: grid,
            failTitle: 'Remove vdev failed',
            successMsg: t('Removed') + ' ' + vdev + ' ' + t('from') + ' ' + poolName,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                refreshViews(node, grid, poolName);
            },
            onFailed: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                // A refused or failed removal still moves the ground under the
                // view (a partial state, a pool reimported elsewhere): reload on
                // failure too, so the screen is never stale on a refusal.
                refreshViews(node, grid, poolName);
            },
        });
    }

    function openRemoveWindow(node, grid, poolName) {
        var store = Ext.create('Ext.data.Store', {
            fields: ['role', 'roleLabel', 'vdev', 'state', 'leaves'],
            data: [],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-vdev-remove',
                title: t('Remove vdev') + ': ' + poolName,
                modal: true,
                width: 680,
                height: 380,
                minWidth: 460,
                minHeight: 260,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'grid',
                        itemId: 'removableVdevs',
                        cls: 'anas-grid-vdev-remove',
                        border: false,
                        flex: 1,
                        emptyText: t('This pool carries no cache, log or spare vdev to remove.'),
                        store: store,
                        selModel: { mode: 'SINGLE' },
                        columns: [
                            {
                                text: t('Role'),
                                dataIndex: 'roleLabel',
                                width: 100,
                                renderer: Ext.String.htmlEncode,
                            },
                            {
                                text: t('Vdev'),
                                dataIndex: 'vdev',
                                flex: 1,
                                renderer: Ext.String.htmlEncode,
                            },
                            {
                                text: t('State'),
                                dataIndex: 'state',
                                width: 110,
                                renderer: ANAS.renderState || Ext.String.htmlEncode,
                            },
                            {
                                text: t('Devices'),
                                dataIndex: 'leaves',
                                flex: 1,
                                renderer: Ext.String.htmlEncode,
                            },
                        ],
                    },
                    {
                        xtype: 'component',
                        itemId: 'vdevRemoveNote',
                        cls: 'anas-note anas-note-vdev-remove',
                        html: Ext.String.htmlEncode(
                            t('Data, special and dedup vdevs cannot be removed here.')),
                    },
                ],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: t('Remove'),
                        cls: 'anas-btn-vdev-remove-submit',
                        handler: function () {
                            try {
                                submit(win, node, grid, poolName);
                            } catch (e) {
                                ANAS.warn('vdev remove submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('vdev remove window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        load(win, node, poolName);
    }

    // PVE-managed pools must not be reshaped → itemId is in 30-pools' PVE_HANDS_OFF.
    ANAS.pools.registerAction({
        itemId: 'removeVdev',
        text: 'Remove vdev…',
        cls: 'anas-btn-vdev-remove',
        iconCls: 'fa fa-minus-square',
        needsSelection: true,
        disableWhileScanning: false,
        handler: function (node, grid, poolName) {
            if (!poolName) {
                return;
            }
            openRemoveWindow(node, grid, poolName);
        },
    });
})();
