/*
 * ANAS — Import Pool action (story 3.7).
 *
 * Registers an "Import" toolbar action into the Pools view's action registry
 * (30-pools.js). Opens a window listing importable pools discovered by a scan
 * (GET /pools/import), lets the user pick one, and imports it through the shared
 * job helper.
 *
 * Data:
 *   GET  /pools/import   → { data: [{ name, guid, state }],    (scan, synchronous)
 *                             unreadableEntries?: string[] }    (cr3: scan entries
 *                             that could not be read; each is the daemon's sentence)
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

    // The scan entries the daemon could not read (`unreadableEntries`, cr3):
    // its own sentences, or [] when the answer carries none (an older daemon,
    // or a scan that read every entry).
    function unreadableEntriesOf(res) {
        var list = (res && res.unreadableEntries && res.unreadableEntries.length) ? res.unreadableEntries : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (typeof list[i] === 'string' && list[i]) {
                out.push(list[i]);
            }
        }
        return out;
    }

    // Show the unreadable scan entries above the grid, every one encoded, or
    // hide the notice when there are none (cr3.followup).
    function showUnreadable(win, entries) {
        var box = win.down('#importUnreadable');
        if (!box) {
            return;
        }
        try {
            if (!entries.length) {
                box.update('');
                box.setHidden(true);
                return;
            }
            var items = [];
            for (var i = 0; i < entries.length; i++) {
                items.push('<li>' + ANAS.enc(entries[i]) + '</li>');
            }
            box.update('<div style="color:var(--anas-warn,#b06a12);">'
                + ANAS.enc(t('Scan entries that could not be read') + ' (' + entries.length + ')') + ':</div>'
                + '<ul style="margin:4px 0 0 18px;padding:0;">' + items.join('') + '</ul>');
            box.setHidden(false);
        } catch (e) {
            // non-fatal — the grid's empty text still names them
        }
    }

    // What the grid says when it lists no pool (cr3.followup): the ZFS-absent
    // sentence; else, when entries could not be read, never "No importable
    // pools found" alone, since an entry nobody could read may be a pool;
    // else the honest empty.
    function importEmptyText(zfsNo, entries) {
        if (zfsNo) {
            return zfsNo;
        }
        if (entries.length) {
            return t('No pool in the scan can be imported from here') + ': ' + entries.length + ' '
                + t('scan entr(ies) could not be read (listed above)');
        }
        return t('No importable pools found');
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
            // cr3 daemon contract: ZFS not available on this node — the
            // node's sentence (encoded) in place of "No importable pools".
            var zfsNo = ANAS.pools.zfsUnavailableOf ? ANAS.pools.zfsUnavailableOf(res) : null;
            var entries = unreadableEntriesOf(res);
            showUnreadable(win, entries);
            if (ANAS.pools.setGridEmptyText) {
                ANAS.pools.setGridEmptyText(poolGrid, importEmptyText(zfsNo, entries));
            }
            poolGrid.getStore().loadData((res && res.data) || []);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            poolGrid.setLoading(false);
            // cr3.followup: a scan that could not be read leaves no earlier
            // scan's rows or notice standing, and never reads as "no pools".
            showUnreadable(win, []);
            if (ANAS.pools.setGridEmptyText) {
                ANAS.pools.setGridEmptyText(poolGrid, t('The scan could not be read') + ': ' + ANAS.errText(err));
            }
            poolGrid.getStore().loadData([]);
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
                    // Set by each scan (importEmptyText); nothing is claimed
                    // before the first one answers.
                    emptyText: '',
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
                    tbar: ANAS.tbar([
                        {
                            text: t('Rescan'),
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                scan(btn.up('window'), node);
                            },
                        },
                    ]),
                    // cr3.followup: the scan entries that could not be read.
                    dockedItems: [{
                        xtype: 'component',
                        dock: 'top',
                        itemId: 'importUnreadable',
                        cls: 'anas-import-unreadable',
                        hidden: true,
                        padding: '6 10',
                        html: '',
                    }],
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

    // cr3.followup: for cr3-followup.harness.mjs.
    ANAS.pools.importScan = scan;

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
