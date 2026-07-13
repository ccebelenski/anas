/*
 * ANAS — Pools view (story 13.10).
 *
 * A native ExtJS grid of ZFS pools with a topology/properties/scan detail
 * window and a Start Scrub action that goes through the job API. PVE idioms
 * throughout (grid + toolbar, Ext.window.Window for detail, render_zfs_health
 * style state column). Fail-open: a broken view renders an error panel, never
 * breaks PVE.
 *
 * Data:
 *   GET  /pools                 → { data: PoolSummary[] }
 *   GET  /pools/:name           → { data: PoolDetail }
 *   POST /pools/:name/scrub     → 202 { job }
 *   GET  /jobs/:id              → { job }
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    // Human role labels for vdev groups.
    var ROLE_LABELS = {
        data: 'Data',
        log: 'Log',
        cache: 'Cache',
        spare: 'Spare',
        special: 'Special',
        dedup: 'Dedup',
    };

    function roleLabel(role) {
        return ANAS.t(ROLE_LABELS[role] || role);
    }

    // ---- Grid --------------------------------------------------------------

    function loadPools(grid, node) {
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        ANAS.api.get(node, '/pools').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            var rows = (res && res.data) || [];
            grid.getStore().loadData(rows);
            updateButtons(grid);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            ANAS.warn('pools load failed: ' + ANAS.errText(err));
            try {
                Ext.Msg.alert(ANAS.t('Error'),
                    ANAS.t('Failed to load pools') + ': ' + ANAS.errText(err));
            } catch (e) {
                // non-fatal
            }
        });
    }

    // Enable/disable the selection-dependent toolbar buttons. Start Scrub is
    // disabled when nothing is selected or when the selected pool is already
    // scrubbing.
    function updateButtons(grid) {
        var sel = grid.getSelection();
        var has = sel && sel.length > 0;
        var scrubBtn = grid.down('#scrub');
        var detailBtn = grid.down('#detail');
        if (detailBtn) {
            detailBtn.setDisabled(!has);
        }
        if (scrubBtn) {
            var scanning = has && sel[0].get('scanRunning');
            scrubBtn.setDisabled(!has || scanning);
        }
    }

    function selectedPool(grid) {
        var sel = grid.getSelection();
        return (sel && sel.length) ? sel[0].get('name') : null;
    }

    function startScrub(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        ANAS.api.post(node, '/pools/' + encodeURIComponent(pool) + '/scrub', { action: 'start' })
            .then(function (res) {
                var job = res && res.job;
                if (!job || !job.id) {
                    ANAS.warn('scrub: no job id in response');
                    loadPools(grid, node);
                    return;
                }
                pollScrubJob(grid, node, job.id, pool);
            }, function (err) {
                ANAS.warn('scrub start failed: ' + ANAS.errText(err));
                try {
                    Ext.Msg.alert(ANAS.t('Scrub failed'), ANAS.errText(err));
                } catch (e) {
                    // non-fatal
                }
            });
    }

    // Poll the job until completed/failed, every 500ms up to ~15s. A recursive
    // setTimeout guarded by grid.destroyed ensures a closed view stops polling.
    function pollScrubJob(grid, node, jobId, pool) {
        var interval = 500;
        var maxMs = 15000;
        var elapsed = 0;

        function tick() {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            ANAS.api.get(node, '/jobs/' + encodeURIComponent(jobId)).then(function (res) {
                if (grid.destroyed || grid.destroying) {
                    return;
                }
                var job = res && res.job;
                var status = job && job.status;
                if (status === 'completed') {
                    loadPools(grid, node);
                    ANAS.toast(ANAS.t('Scrub started on pool') + ' ' + pool);
                    return;
                }
                if (status === 'failed') {
                    var msg = (job && job.error && job.error.message) || ANAS.t('unknown error');
                    try {
                        Ext.Msg.alert(ANAS.t('Scrub failed'), msg);
                    } catch (e) {
                        ANAS.warn('scrub failed: ' + msg);
                    }
                    return;
                }
                elapsed += interval;
                if (elapsed >= maxMs) {
                    // Still running after the wait window — refresh the grid so
                    // the scan state shows, and stop polling.
                    loadPools(grid, node);
                    return;
                }
                setTimeout(tick, interval);
            }, function (err) {
                if (grid.destroyed || grid.destroying) {
                    return;
                }
                ANAS.warn('scrub poll failed: ' + ANAS.errText(err));
            });
        }

        setTimeout(tick, interval);
    }

    function poolsGrid(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'state',
                { name: 'size', type: 'int' },
                { name: 'allocated', type: 'int' },
                { name: 'free', type: 'int' },
                { name: 'capacity', type: 'float' },
                { name: 'fragmentation', type: 'float' },
                { name: 'dedupRatio', type: 'float' },
                { name: 'scanRunning', type: 'boolean' },
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        return {
            xtype: 'grid',
            cls: 'anas-view anas-view-pools anas-grid-pools',
            store: store,
            selModel: { mode: 'SINGLE' },
            columns: [
                { text: ANAS.t('Name'), dataIndex: 'name', flex: 1 },
                {
                    text: ANAS.t('State'),
                    dataIndex: 'state',
                    width: 130,
                    renderer: ANAS.renderState,
                },
                {
                    text: ANAS.t('Size'),
                    dataIndex: 'size',
                    width: 110,
                    renderer: ANAS.formatBytes,
                },
                {
                    text: ANAS.t('Allocated'),
                    dataIndex: 'allocated',
                    width: 110,
                    renderer: ANAS.formatBytes,
                },
                {
                    text: ANAS.t('Free'),
                    dataIndex: 'free',
                    width: 110,
                    renderer: ANAS.formatBytes,
                },
                {
                    text: ANAS.t('Capacity'),
                    dataIndex: 'capacity',
                    width: 100,
                    renderer: ANAS.formatPercent,
                },
                {
                    text: ANAS.t('Fragmentation'),
                    dataIndex: 'fragmentation',
                    width: 120,
                    renderer: ANAS.formatPercent,
                },
                {
                    text: ANAS.t('Scan'),
                    dataIndex: 'scanRunning',
                    width: 110,
                    renderer: function (value) {
                        return value ? ANAS.t('Scrubbing') : ANAS.t('Idle');
                    },
                },
            ],
            tbar: [
                {
                    text: ANAS.t('Reload'),
                    itemId: 'refresh',
                    cls: 'anas-btn-refresh',
                    iconCls: 'fa fa-refresh',
                    handler: function (btn) {
                        var grid = btn.up('grid');
                        loadPools(grid, node);
                    },
                },
                {
                    text: ANAS.t('Detail'),
                    itemId: 'detail',
                    cls: 'anas-btn-detail',
                    iconCls: 'fa fa-search',
                    disabled: true,
                    handler: function (btn) {
                        var grid = btn.up('grid');
                        var pool = selectedPool(grid);
                        if (pool) {
                            showPoolDetail(node, pool);
                        }
                    },
                },
                {
                    text: ANAS.t('Start Scrub'),
                    itemId: 'scrub',
                    cls: 'anas-btn-scrub',
                    iconCls: 'fa fa-check-circle',
                    disabled: true,
                    handler: function (btn) {
                        var grid = btn.up('grid');
                        startScrub(grid, node);
                    },
                },
            ],
            listeners: {
                afterrender: function (grid) {
                    loadPools(grid, node);
                },
                // ExtJS fires selectionchange with (selModel, selected, …) —
                // the first arg is the selection model, NOT the grid. Use `this`
                // (the grid, per listener scope) so updateButtons gets a real grid.
                selectionchange: function () {
                    updateButtons(this);
                },
                itemdblclick: function (grid, record) {
                    showPoolDetail(node, record.get('name'));
                },
            },
        };
    }

    // ---- Detail window -----------------------------------------------------

    function kv(label, value) {
        var enc = function (s) {
            try {
                return Ext.String.htmlEncode('' + s);
            } catch (e) {
                return '' + s;
            }
        };
        return '<tr><td style="padding:2px 12px 2px 0;color:gray;white-space:nowrap;">'
            + enc(label) + '</td><td style="padding:2px 0;">' + value + '</td></tr>';
    }

    function summaryHtml(d) {
        var enc = function (s) {
            try {
                return Ext.String.htmlEncode('' + s);
            } catch (e) {
                return '' + s;
            }
        };
        var rows = ''
            + kv(ANAS.t('State'), ANAS.renderState(d.state))
            + kv(ANAS.t('Size'), enc(ANAS.formatBytes(d.size)))
            + kv(ANAS.t('Allocated'), enc(ANAS.formatBytes(d.allocated)))
            + kv(ANAS.t('Free'), enc(ANAS.formatBytes(d.free)))
            + kv(ANAS.t('Capacity'), enc(ANAS.formatPercent(d.capacity)))
            + kv(ANAS.t('Fragmentation'), enc(ANAS.formatPercent(d.fragmentation)))
            + kv(ANAS.t('Dedup ratio'), enc((Number(d.dedupRatio || 0)).toFixed(2) + 'x'))
            + kv(ANAS.t('Errors'), enc(d.errorCount))
            + kv(ANAS.t('GUID'), enc(d.guid));
        if (d.health && (d.health.status || d.health.action)) {
            if (d.health.status) {
                rows += kv(ANAS.t('Status'), enc(d.health.status));
            }
            if (d.health.action) {
                rows += kv(ANAS.t('Action'), enc(d.health.action));
            }
        }
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    function propsHtml(p) {
        var enc = function (s) {
            try {
                return Ext.String.htmlEncode('' + s);
            } catch (e) {
                return '' + s;
            }
        };
        p = p || {};
        var rows = ''
            + kv(ANAS.t('ashift'), enc(p.ashift))
            + kv(ANAS.t('autoexpand'), enc(ANAS.formatBool(p.autoexpand)))
            + kv(ANAS.t('autoreplace'), enc(ANAS.formatBool(p.autoreplace)))
            + kv(ANAS.t('autotrim'), enc(ANAS.formatBool(p.autotrim)))
            + kv(ANAS.t('failmode'), enc(p.failmode));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    function scanHtml(scan) {
        var enc = function (s) {
            try {
                return Ext.String.htmlEncode('' + s);
            } catch (e) {
                return '' + s;
            }
        };
        if (!scan) {
            return '<p style="color:gray;">' + enc(ANAS.t('No scan has run on this pool.')) + '</p>';
        }
        var rows = ''
            + kv(ANAS.t('Type'), enc(scan.function))
            + kv(ANAS.t('State'), enc(scan.state))
            + kv(ANAS.t('Progress'), enc(ANAS.formatPercent(scan.percentComplete)))
            + kv(ANAS.t('Examined'), enc(ANAS.formatBytes(scan.examinedBytes)
                + ' / ' + ANAS.formatBytes(scan.totalBytes)))
            + kv(ANAS.t('Repaired'), enc(ANAS.formatBytes(scan.processedBytes)))
            + kv(ANAS.t('Errors'), enc(scan.errors))
            + kv(ANAS.t('Started'), enc(scan.startedAt || '—'))
            + kv(ANAS.t('Finished'), enc(scan.finishedAt || '—'));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    // Build the topology tree root from vdevGroups → vdevs → disks.
    function topologyRoot(vdevGroups) {
        var groups = [];
        var gi;
        vdevGroups = vdevGroups || [];
        for (gi = 0; gi < vdevGroups.length; gi++) {
            var g = vdevGroups[gi];
            var groupNode = {
                name: roleLabel(g.role),
                state: '',
                read: '',
                write: '',
                cksum: '',
                expanded: true,
                children: [],
            };
            var vi;
            var vdevs = g.vdevs || [];
            for (vi = 0; vi < vdevs.length; vi++) {
                var v = vdevs[vi];
                var vdevNode = {
                    name: v.name,
                    state: v.state,
                    read: v.readErrors,
                    write: v.writeErrors,
                    cksum: v.checksumErrors,
                    expanded: true,
                    children: [],
                };
                var di;
                var disks = v.disks || [];
                for (di = 0; di < disks.length; di++) {
                    var disk = disks[di];
                    vdevNode.children.push({
                        name: disk.id,
                        state: disk.state,
                        read: disk.readErrors,
                        write: disk.writeErrors,
                        cksum: disk.checksumErrors,
                        leaf: true,
                    });
                }
                if (!vdevNode.children.length) {
                    vdevNode.leaf = true;
                    delete vdevNode.children;
                }
                groupNode.children.push(vdevNode);
            }
            groups.push(groupNode);
        }
        return { expanded: true, children: groups };
    }

    function renderDetail(win, d) {
        var content = win.down('#content');
        if (!content) {
            return;
        }
        content.removeAll();
        if (!d) {
            content.add(ANAS.errorPanel(ANAS.t('No pool detail returned.')));
            return;
        }
        content.add([
            {
                xtype: 'panel',
                title: ANAS.t('Summary'),
                bodyPadding: 10,
                border: false,
                html: summaryHtml(d),
            },
            {
                xtype: 'treepanel',
                title: ANAS.t('Topology'),
                cls: 'anas-pool-topology',
                flex: 1,
                rootVisible: false,
                border: false,
                store: Ext.create('Ext.data.TreeStore', {
                    fields: ['name', 'state', 'read', 'write', 'cksum'],
                    root: topologyRoot(d.vdevGroups),
                }),
                columns: [
                    { xtype: 'treecolumn', text: ANAS.t('Name'), dataIndex: 'name', flex: 1 },
                    {
                        text: ANAS.t('State'),
                        dataIndex: 'state',
                        width: 130,
                        renderer: ANAS.renderState,
                    },
                    { text: 'READ', dataIndex: 'read', width: 80 },
                    { text: 'WRITE', dataIndex: 'write', width: 80 },
                    { text: 'CKSUM', dataIndex: 'cksum', width: 80 },
                ],
            },
            {
                xtype: 'panel',
                title: ANAS.t('Properties'),
                bodyPadding: 10,
                border: false,
                html: propsHtml(d.properties),
            },
            {
                xtype: 'panel',
                title: ANAS.t('Scan'),
                bodyPadding: 10,
                border: false,
                html: scanHtml(d.scan),
            },
        ]);
    }

    function showPoolDetail(node, poolName) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-view-pool-detail',
                title: ANAS.t('Pool') + ': ' + poolName,
                modal: true,
                width: 820,
                height: 640,
                resizable: true,
                layout: 'fit',
                tbar: [
                    {
                        text: ANAS.t('Reload'),
                        iconCls: 'fa fa-refresh',
                        handler: function () {
                            loadDetail();
                        },
                    },
                ],
                items: [{
                    xtype: 'panel',
                    itemId: 'content',
                    border: false,
                    scrollable: true,
                    layout: { type: 'vbox', align: 'stretch' },
                }],
            });
        } catch (e) {
            ANAS.warn('pool detail window failed: ' + ANAS.errText(e));
            return;
        }

        function loadDetail() {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                win.setLoading(true);
            } catch (e) {
                // non-fatal
            }
            ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName)).then(function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                renderDetail(win, res && res.data);
            }, function (err) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                ANAS.warn('pool detail load failed: ' + ANAS.errText(err));
                var content = win.down('#content');
                if (content) {
                    content.removeAll();
                    content.add(ANAS.errorPanel(
                        ANAS.t('Failed to load pool detail') + ': ' + ANAS.errText(err)));
                }
            });
        }

        win.show();
        loadDetail();
    }

    // ---- View registration -------------------------------------------------

    ANAS.views.pools = {
        itemId: 'anas-pools',
        text: ANAS.t('Pools'),
        iconCls: 'fa fa-th-large',
        factory: function (node) {
            try {
                return poolsGrid(node);
            } catch (e) {
                ANAS.warn('pools view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
