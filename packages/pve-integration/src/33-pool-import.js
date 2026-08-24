/*
 * ANAS — Import Pool action (story 3.7).
 *
 * Registers an "Import" toolbar action into the Pools view's action registry
 * (30-pools.js). Opens a window listing importable pools discovered by a scan
 * (GET /pools/import), lets the user pick one, and imports it through the shared
 * job helper.
 *
 * Data:
 *   GET  /pools/import   → { data: [{ name, guid, state }] }  (scan, synchronous)
 *   POST /pools/import   → 202 { job }                        (ImportPoolRequest)
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

    function scan(win, node) {
        var poolGrid = win.down('#importGrid');
        if (!poolGrid) {
            return;
        }
        poolGrid.setLoading(true);
        ANAS.api.get(node, '/pools/import').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            poolGrid.setLoading(false);
            poolGrid.getStore().loadData((res && res.data) || []);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            poolGrid.setLoading(false);
            ANAS.warn('import scan failed: ' + ANAS.errText(err));
            ANAS.alertMsg('Error', t('Failed to scan for pools') + ': ' + ANAS.errText(err));
        });
    }

    function submit(win, node, grid) {
        var poolGrid = win.down('#importGrid');
        if (!poolGrid) {
            return;
        }
        var sel = poolGrid.getSelection() || [];
        if (!sel.length) {
            ANAS.alertMsg('Invalid input', 'Select a pool to import.');
            return;
        }
        var rec = sel[0];
        var name = rec.get('name');
        var guid = '' + (rec.get('guid') || '');

        // Import by GUID whenever the scan gave us one: the GUID identifies THIS
        // pool, the name does not — two exported pools may share a name, which is
        // the whole reason the scan reports a GUID and the column shows it. The
        // daemon accepts either (ImportPoolRequest), prefers `name` when both are
        // present, and derives the imported pool's name from the pool-list diff,
        // so a GUID import loses nothing. Name-only stays the fallback for a scan
        // row without a GUID.
        var body = guid ? { guid: guid } : { name: name };

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools/import',
            body: body,
            view: win,
            failTitle: 'Import failed',
            successMsg: t('Pool imported') + ': ' + name,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                ANAS.pools.reload(grid, node);
            },
        });
    }

    function openImportWindow(node, grid) {
        var importStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'guid', 'state'],
            data: [],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-import',
                title: t('Import Pool'),
                modal: true,
                width: 640,
                height: 440,
                minWidth: 420,
                minHeight: 300,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'grid',
                    itemId: 'importGrid',
                    cls: 'anas-grid-import',
                    border: false,
                    emptyText: t('No importable pools found'),
                    store: importStore,
                    selModel: { mode: 'SINGLE' },
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'name',
                            flex: 1,
                            renderer: Ext.String.htmlEncode,
                        },
                        {
                            text: t('State'),
                            dataIndex: 'state',
                            width: 130,
                            renderer: ANAS.renderState || Ext.String.htmlEncode,
                        },
                        {
                            text: t('GUID'),
                            dataIndex: 'guid',
                            width: 200,
                            renderer: Ext.String.htmlEncode,
                        },
                    ],
                    tbar: [
                        {
                            text: t('Rescan'),
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                scan(btn.up('window'), node);
                            },
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
                        text: t('Import'),
                        cls: 'anas-btn-import-submit',
                        handler: function () {
                            try {
                                submit(win, node, grid);
                            } catch (e) {
                                ANAS.warn('import submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('import window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        scan(win, node);
    }

    ANAS.pools.registerAction({
        itemId: 'importPool',
        text: 'Import',
        cls: 'anas-btn-import',
        iconCls: 'fa fa-download',
        needsSelection: false,
        handler: function (node, grid) {
            openImportWindow(node, grid);
        },
    });
})();
