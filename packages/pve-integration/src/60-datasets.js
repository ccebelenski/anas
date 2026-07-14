/*
 * ANAS — Datasets view (Epic 4: stories 4.1–4.8).
 *
 * A native ExtJS tree of ZFS datasets grouped under their pools. Roots are
 * pools (GET /pools); each pool's datasets (GET /pools/:name/datasets, a flat
 * list) are folded into a hierarchy by splitting the ZFS name on '/'. The view
 * carries create / detail / edit-properties / permissions / destroy actions,
 * every mutation routed through the job API (ANAS.runJob / ANAS.confirmAndRun).
 *
 * PVE idioms throughout (tree panel + toolbar, Ext.window.Window for detail,
 * the ANAS.editWindow property-edit shape from 31-pool-props.js, the
 * challenge→dialog→confirmed-DELETE destroy flow from 37-pool-destroy.js).
 * Fail-open: a broken view renders an error panel, never breaks PVE.
 *
 * Data (paths relative to /v1):
 *   GET    /pools                              → { data: PoolSummary[] }
 *   GET    /pools/:name/datasets               → { data: Dataset[] } (flat)
 *   GET    /pools/:name/datasets/<path>        → { data: DatasetDetail }
 *   POST   /pools/:name/datasets               → 202 { job }  (CreateDatasetRequest)
 *   PUT    /pools/:name/datasets/<path>        → 202 { job }  (UpdateDatasetPropertiesRequest)
 *   DELETE /pools/:name/datasets/<path>[?recursive=true] → 409-confirm then 202
 *   PUT    /pools/:name/datasets/<path>/permissions → 202 { job }  (SetPermissionsRequest)
 *   GET    /identity/users                     → { data: SystemUser[] }
 *   GET    /identity/groups                    → { data: SystemGroup[] }
 *
 * Test hooks: view panel cls 'anas-view anas-view-datasets', tree cls
 * 'anas-grid-datasets', action buttons 'anas-btn-ds-create' /
 * 'anas-btn-ds-detail' / 'anas-btn-ds-edit' / 'anas-btn-ds-perms' /
 * 'anas-btn-ds-destroy', windows 'anas-win-dataset-create' /
 * 'anas-win-dataset-detail' / 'anas-win-dataset-perms'.
 *
 * Snapshots (Epic 5, GET/POST …/datasets/<path>/snapshots and
 * PUT/DELETE/…/rollback per snapshot): snapshots hang off their dataset as
 * flat leaf rows, lazy-loaded on first expand (top-5 inline, an 'anas-snap-more'
 * overflow row + 'anas-btn-snap-all' toolbar button open the 'anas-win-snapshots'
 * popup grid 'anas-grid-snapshots'). Snapshot rows carry cls 'anas-snap-row';
 * actions use buttons 'anas-btn-snap-create' / -rollback / -rename / -destroy.
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

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        try {
            return Ext.String.htmlEncode('' + s);
        } catch (e) {
            return '' + s;
        }
    }

    function alertMsg(title, msg) {
        try {
            Ext.Msg.alert(t(title), msg);
        } catch (e) {
            ANAS.warn(msg);
        }
    }

    // ---- Path helpers ------------------------------------------------------
    //
    // The daemon addresses a dataset by its path relative to the pool: the full
    // ZFS name minus the pool prefix, with each path segment URL-encoded.

    function relPath(fullName, pool) {
        if (fullName === pool) {
            return '';
        }
        var prefix = pool + '/';
        return fullName.indexOf(prefix) === 0 ? fullName.substring(prefix.length) : fullName;
    }

    function encPath(rel) {
        var parts = ('' + rel).split('/');
        for (var i = 0; i < parts.length; i++) {
            parts[i] = encodeURIComponent(parts[i]);
        }
        return parts.join('/');
    }

    // Build the /v1 path to a dataset resource (optionally with a sub-resource
    // like 'permissions'). fullName is the complete ZFS name (pool/…).
    function datasetPath(pool, fullName, sub) {
        var p = '/pools/' + encodeURIComponent(pool) + '/datasets/' + encPath(relPath(fullName, pool));
        if (sub) {
            p += '/' + sub;
        }
        return p;
    }

    // Build the /v1 path to a snapshot resource under its dataset. snapName is
    // the label after '@' (Snapshot.snapshotName); sub is an optional trailing
    // action such as 'rollback'.
    function snapshotsPath(pool, datasetFullName) {
        return datasetPath(pool, datasetFullName, 'snapshots');
    }

    function snapshotPath(pool, datasetFullName, snapName, sub) {
        var p = snapshotsPath(pool, datasetFullName) + '/' + encodeURIComponent(snapName);
        if (sub) {
            p += '/' + sub;
        }
        return p;
    }

    // ---- Renderers ---------------------------------------------------------

    function renderBytes(v) {
        if (v === undefined || v === null || v === '') {
            return '';
        }
        return enc(ANAS.formatBytes(v));
    }

    // Quota of 0 means "no quota" in ZFS — show a dash rather than "0 B".
    function renderQuota(v) {
        if (v === undefined || v === null || v === '') {
            return '';
        }
        if (Number(v) === 0) {
            return '&mdash;';
        }
        return enc(ANAS.formatBytes(v));
    }

    // Compression column: compressor plus the achieved ratio when known,
    // e.g. "lz4 (1.85x)".
    function renderCompression(v, meta, rec) {
        var c = rec.get('compression');
        if (!c) {
            return '';
        }
        var out = '' + c;
        var ratio = Number(rec.get('compressratio'));
        if (ratio && ratio > 0) {
            out += ' (' + ratio.toFixed(2) + 'x)';
        }
        return enc(out);
    }

    // Format a snapshot's ISO 8601 creation time as a compact local string.
    // Blank for non-snapshot rows (no 'created' value). Fail-open: on any parse
    // trouble, show the raw value rather than throwing in a cell renderer.
    function formatCreated(v) {
        if (v === undefined || v === null || v === '') {
            return '';
        }
        try {
            var d = new Date(v);
            if (isNaN(d.getTime())) {
                return enc(v);
            }
            if (typeof Ext !== 'undefined' && Ext.Date && typeof Ext.Date.format === 'function') {
                return enc(Ext.Date.format(d, 'Y-m-d H:i'));
            }
            return enc(d.toLocaleString());
        } catch (e) {
            return enc(v);
        }
    }

    // ---- Tree building -----------------------------------------------------
    //
    // Fold a pool's flat dataset list into a hierarchy. Nodes are keyed by full
    // ZFS name; parents (sorted first) already exist by the time a child is
    // processed. The pool root is a 'pool' node; a dataset row whose name equals
    // the pool name is the pool's root filesystem and is merged onto it.

    function lastSegment(name) {
        var idx = ('' + name).lastIndexOf('/');
        return idx >= 0 ? name.substring(idx + 1) : name;
    }

    function nodeFromDataset(ds, kind) {
        return {
            name: lastSegment(ds.name),
            fullName: ds.name,
            pool: ds.pool,
            kind: kind,
            type: ds.type,
            used: ds.used,
            available: ds.available,
            referenced: ds.referenced,
            mountpoint: ds.mountpoint,
            compression: ds.compression,
            compressratio: ds.compressratio,
            quota: ds.quota,
            leaf: true,
            children: [],
        };
    }

    function applyDatasetData(node, ds) {
        node.type = ds.type;
        node.used = ds.used;
        node.available = ds.available;
        node.referenced = ds.referenced;
        node.mountpoint = ds.mountpoint;
        node.compression = ds.compression;
        node.compressratio = ds.compressratio;
        node.quota = ds.quota;
    }

    // Ensure an intermediate parent node exists for parentName (defensive — in
    // practice every ZFS level is itself a dataset row, so this is rarely hit).
    function ensureParent(parentName, pool, byName) {
        if (byName[parentName]) {
            return byName[parentName];
        }
        var node = {
            name: lastSegment(parentName),
            fullName: parentName,
            pool: pool,
            kind: 'dataset',
            type: 'filesystem',
            leaf: false,
            children: [],
        };
        byName[parentName] = node;
        var grandName = parentName.substring(0, parentName.lastIndexOf('/'));
        var grand = grandName ? ensureParent(grandName, pool, byName) : byName[pool];
        if (grand) {
            grand.children.push(node);
            grand.leaf = false;
        }
        return node;
    }

    function buildPoolNode(pool, datasets) {
        var byName = {};
        var rootNode = {
            name: pool.name,
            fullName: pool.name,
            pool: pool.name,
            kind: 'pool',
            type: 'filesystem',
            expanded: true,
            leaf: true,
            children: [],
        };
        byName[pool.name] = rootNode;

        var rows = (datasets || []).slice();
        rows.sort(function (a, b) {
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });

        for (var i = 0; i < rows.length; i++) {
            var ds = rows[i];
            if (ds.name === pool.name) {
                applyDatasetData(rootNode, ds);
                continue;
            }
            var node = nodeFromDataset(ds, 'dataset');
            byName[ds.name] = node;
            var parentName = ds.name.substring(0, ds.name.lastIndexOf('/'));
            var parent = byName[parentName] || ensureParent(parentName, pool.name, byName);
            parent.children.push(node);
            parent.leaf = false;
        }

        finalizeNode(rootNode);
        return rootNode;
    }

    // Finalise a freshly-built pool subtree. Pools start expanded so their
    // top-level datasets are visible (Epic 4.1). Datasets are ALWAYS non-leaf
    // but start COLLAPSED: every dataset is a potential snapshot host, so it
    // must show an expander even with no child datasets, and its snapshots are
    // fetched lazily on the first expand (Epic 5) rather than upfront. An
    // explicit (possibly empty) children array marks the node "loaded" so
    // expanding fires itemexpand without triggering a store-proxy load.
    function finalizeNode(node) {
        var kids = node.children || [];
        if (node.kind === 'pool') {
            node.expanded = true;
            node.leaf = kids.length === 0;
            if (!kids.length && node.children) {
                delete node.children;
            }
        } else if (node.kind === 'dataset') {
            node.leaf = false;
            node.expanded = false;
            // Force the expander even when the dataset has no child datasets:
            // ExtJS would otherwise hide it for a loaded, childless, non-leaf
            // node, leaving no way to trigger the lazy snapshot load.
            node.expandable = true;
            if (!node.children) {
                node.children = [];
            }
        }
        for (var i = 0; i < kids.length; i++) {
            finalizeNode(kids[i]);
        }
    }

    // ---- Load --------------------------------------------------------------

    function poolNames(tree) {
        var names = [];
        try {
            var root = tree.getRootNode();
            if (root && root.childNodes) {
                for (var i = 0; i < root.childNodes.length; i++) {
                    var n = root.childNodes[i];
                    if (n.get('kind') === 'pool') {
                        names.push(n.get('name'));
                    }
                }
            }
        } catch (e) {
            // fail-open — empty list
        }
        return names;
    }

    function loadTree(tree, node) {
        if (!tree || tree.destroyed || tree.destroying) {
            return;
        }
        try {
            tree.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        ANAS.api.get(node, '/pools').then(function (res) {
            if (tree.destroyed || tree.destroying) {
                return;
            }
            var pools = (res && res.data) || [];
            var calls = [];
            for (var i = 0; i < pools.length; i++) {
                calls.push(loadPoolDatasets(node, pools[i]));
            }
            Promise.all(calls).then(function (results) {
                if (tree.destroyed || tree.destroying) {
                    return;
                }
                try {
                    tree.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
                var children = [];
                for (var j = 0; j < results.length; j++) {
                    children.push(buildPoolNode(results[j].pool, results[j].datasets));
                }
                try {
                    // Replace the whole root atomically. Incrementally mutating
                    // an already-rendered root (removeAll + appendChild) can leave
                    // a stale phantom row in the tree view; setRootNode forces a
                    // clean rebuild.
                    tree.setRootNode({
                        expanded: true,
                        children: children,
                    });
                } catch (e2) {
                    ANAS.warn('dataset tree build failed: ' + ANAS.errText(e2));
                }
                updateButtons(tree);
            });
        }, function (err) {
            if (tree.destroyed || tree.destroying) {
                return;
            }
            try {
                tree.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            ANAS.warn('pools load failed: ' + ANAS.errText(err));
            alertMsg('Error', t('Failed to load pools') + ': ' + ANAS.errText(err));
        });
    }

    // Resolve to { pool, datasets } and never reject — a single pool's failure
    // must not blank the whole tree.
    function loadPoolDatasets(node, pool) {
        return ANAS.api.get(node, '/pools/' + encodeURIComponent(pool.name) + '/datasets').then(
            function (res) {
                return { pool: pool, datasets: (res && res.data) || [] };
            },
            function (err) {
                ANAS.warn('datasets load failed for ' + pool.name + ': ' + ANAS.errText(err));
                return { pool: pool, datasets: [] };
            }
        );
    }

    ANAS.datasets = ANAS.datasets || {};
    ANAS.datasets.reload = loadTree;

    // ---- Selection + button state -----------------------------------------

    function selectedRecord(tree) {
        var sel = tree ? tree.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function isDataset(rec) {
        return !!(rec && rec.get('kind') === 'dataset');
    }

    function isFilesystem(rec) {
        return isDataset(rec) && rec.get('type') === 'filesystem';
    }

    function isSnapshot(rec) {
        return !!(rec && rec.get('kind') === 'snapshot');
    }

    function isSnapshotsMore(rec) {
        return !!(rec && rec.get('kind') === 'snapshots-more');
    }

    function setDisabled(tree, itemId, disabled) {
        var btn = tree.down('#' + itemId);
        if (btn) {
            btn.setDisabled(!!disabled);
        }
    }

    function updateButtons(tree) {
        var rec = selectedRecord(tree);
        var ds = isDataset(rec);
        var fs = isFilesystem(rec);
        var snap = isSnapshot(rec);
        setDisabled(tree, 'dsDetail', !ds);
        setDisabled(tree, 'dsEdit', !ds);
        setDisabled(tree, 'dsPerms', !fs);
        setDisabled(tree, 'dsDestroy', !ds);
        // Snapshot actions: create/list act on a selected dataset; the
        // rollback/rename/destroy trio act on a selected snapshot row.
        setDisabled(tree, 'snapCreate', !ds);
        setDisabled(tree, 'snapAll', !ds);
        setDisabled(tree, 'snapRollback', !snap);
        setDisabled(tree, 'snapRename', !snap);
        setDisabled(tree, 'snapDestroy', !snap);
    }

    // ---- Property field vocabularies ---------------------------------------

    function compressionStore() {
        return [
            { value: '', label: t('(inherit)') },
            { value: 'off', label: 'off' },
            { value: 'lz4', label: 'lz4' },
            { value: 'zstd', label: 'zstd' },
            { value: 'gzip', label: 'gzip' },
        ];
    }

    // Common record sizes as byte values; '' means inherit (send nothing).
    function recordsizeStore() {
        return [
            { value: '', label: t('(inherit)') },
            { value: 16384, label: '16K' },
            { value: 32768, label: '32K' },
            { value: 65536, label: '64K' },
            { value: 131072, label: '128K' },
            { value: 262144, label: '256K' },
            { value: 524288, label: '512K' },
            { value: 1048576, label: '1M' },
        ];
    }

    // ---- Create Dataset (story 4.5) ----------------------------------------

    function openCreate(node, tree, rec) {
        var pools = poolNames(tree);
        var defaultPool = rec ? rec.get('pool') : (pools.length ? pools[0] : '');
        // When a dataset (not a pool root) is selected, pre-seed its relative
        // path as the parent so a child is created under it.
        var parentRel = '';
        if (isDataset(rec)) {
            parentRel = relPath(rec.get('fullName'), rec.get('pool'));
            if (parentRel) {
                parentRel += '/';
            }
        }

        var poolData = [];
        for (var i = 0; i < pools.length; i++) {
            poolData.push({ name: pools[i] });
        }
        var poolStore = Ext.create('Ext.data.Store', {
            fields: ['name'],
            data: poolData,
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-dataset-create',
                title: t('Create Dataset'),
                modal: true,
                width: 480,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 170 },
                    items: [
                        {
                            xtype: 'combobox',
                            itemId: 'pool',
                            fieldLabel: t('Pool'),
                            store: poolStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            allowBlank: false,
                            value: defaultPool,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'path',
                            cls: 'anas-fld-ds-path',
                            fieldLabel: t('Path (relative to pool)'),
                            emptyText: 'media/movies',
                            allowBlank: false,
                            value: parentRel,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'compression',
                            fieldLabel: t('Compression'),
                            store: Ext.create('Ext.data.Store', {
                                fields: ['value', 'label'],
                                data: compressionStore(),
                            }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            value: '',
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'recordsize',
                            fieldLabel: t('Record size'),
                            store: Ext.create('Ext.data.Store', {
                                fields: ['value', 'label'],
                                data: recordsizeStore(),
                            }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            value: '',
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'quota',
                            fieldLabel: t('Quota (bytes, 0 = none)'),
                            minValue: 0,
                            value: 0,
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'reservation',
                            fieldLabel: t('Reservation (bytes, 0 = none)'),
                            minValue: 0,
                            value: 0,
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
                        cls: 'anas-btn-dataset-create-submit',
                        handler: function () {
                            try {
                                submitCreate(win, node, tree);
                            } catch (e) {
                                ANAS.warn('dataset create submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('dataset create window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitCreate(win, node, tree) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var pool = win.down('#pool').getValue();
        var rawPath = (win.down('#path').getValue() || '').trim();
        // Normalise: strip leading/trailing slashes and collapse doubles.
        var path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
        if (!pool) {
            alertMsg('Invalid input', t('Select a pool.'));
            return;
        }
        if (!path) {
            alertMsg('Invalid input', t('Enter a dataset path.'));
            return;
        }
        if (!/^[\w-]+(?:\/[\w-]+)*$/.test(path)) {
            alertMsg('Invalid input', t('Invalid dataset path.'));
            return;
        }

        var props = {};
        var compression = win.down('#compression').getValue();
        if (compression) {
            props.compression = compression;
        }
        var recordsize = win.down('#recordsize').getValue();
        if (recordsize) {
            props.recordsize = Number(recordsize);
        }
        var quota = Number(win.down('#quota').getValue()) || 0;
        if (quota > 0) {
            props.quota = quota;
        }
        var reservation = Number(win.down('#reservation').getValue()) || 0;
        if (reservation > 0) {
            props.reservation = reservation;
        }

        var body = { path: path };
        if (Object.keys(props).length) {
            body.properties = props;
        }

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools/' + encodeURIComponent(pool) + '/datasets',
            body: body,
            view: win,
            failTitle: 'Create failed',
            successMsg: t('Dataset created') + ': ' + pool + '/' + path,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadTree(tree, node);
            },
        });
    }

    // ---- Detail (stories 4.2 / 4.3 / 4.4 / 4.7 read) -----------------------

    function kv(label, value) {
        return '<tr><td style="padding:2px 12px 2px 0;color:gray;white-space:nowrap;vertical-align:top;">'
            + enc(label) + '</td><td style="padding:2px 0;">' + value + '</td></tr>';
    }

    function dashOrBytes(v) {
        return Number(v) === 0 ? '&mdash;' : enc(ANAS.formatBytes(v));
    }

    function usageHtml(d) {
        var rows = ''
            + kv(t('Name'), enc(d.name))
            + kv(t('Type'), enc(d.type))
            + kv(t('Mountpoint'), enc(d.mountpoint || '—'))
            + kv(t('Used'), enc(ANAS.formatBytes(d.used)))
            + kv(t('Available'), enc(ANAS.formatBytes(d.available)))
            + kv(t('Referenced'), enc(ANAS.formatBytes(d.referenced)))
            + kv(t('Quota'), dashOrBytes(d.quota))
            + kv(t('Compression'), enc(d.compression)
                + (Number(d.compressratio) > 0 ? ' (' + Number(d.compressratio).toFixed(2) + 'x)' : ''));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    function propsHtml(p) {
        p = p || {};
        var rows = ''
            + kv(t('compression'), enc(p.compression))
            + kv(t('recordsize'), enc(ANAS.formatBytes(p.recordsize)))
            + kv(t('quota'), dashOrBytes(p.quota))
            + kv(t('reservation'), dashOrBytes(p.reservation))
            + kv(t('refquota'), dashOrBytes(p.refquota))
            + kv(t('refreservation'), dashOrBytes(p.refreservation))
            + kv(t('atime'), enc(ANAS.formatBool(p.atime)))
            + kv(t('sync'), enc(p.sync))
            + kv(t('readonly'), enc(ANAS.formatBool(p.readonly)))
            + kv(t('dedup'), enc(p.dedup));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    function permsHtml(perms) {
        if (!perms) {
            return '<p style="color:gray;">' + enc(t('Not applicable (volume or unmounted dataset).')) + '</p>';
        }
        var rows = ''
            + kv(t('Owner'), enc(perms.owner))
            + kv(t('Group'), enc(perms.group))
            + kv(t('Mode'), enc(perms.mode));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    function sharesHtml(shares) {
        if (!shares || !shares.length) {
            return '<p style="color:gray;">' + enc(t('No shares associated with this dataset.')) + '</p>';
        }
        var out = '<ul style="margin:0;padding-left:18px;">';
        for (var i = 0; i < shares.length; i++) {
            out += '<li>' + enc(shares[i]) + '</li>';
        }
        return out + '</ul>';
    }

    function renderDetail(win, d) {
        var content = win.down('#content');
        if (!content) {
            return;
        }
        content.removeAll();
        if (!d) {
            content.add(ANAS.errorPanel(t('No dataset detail returned.')));
            return;
        }
        content.add([
            {
                xtype: 'panel',
                title: t('Usage'),
                bodyPadding: 10,
                border: false,
                html: usageHtml(d),
            },
            {
                xtype: 'panel',
                title: t('Properties'),
                bodyPadding: 10,
                border: false,
                html: propsHtml(d.properties),
            },
            {
                xtype: 'panel',
                title: t('Permissions'),
                bodyPadding: 10,
                border: false,
                html: permsHtml(d.permissions),
            },
            {
                xtype: 'panel',
                title: t('Associated Shares'),
                bodyPadding: 10,
                border: false,
                html: sharesHtml(d.associatedShares),
            },
        ]);
    }

    function openDetail(node, rec) {
        if (!isDataset(rec)) {
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-dataset-detail',
                title: t('Dataset') + ': ' + fullName,
                modal: true,
                width: 640,
                height: 560,
                resizable: true,
                layout: 'fit',
                tbar: [
                    {
                        text: t('Reload'),
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
            ANAS.warn('dataset detail window failed: ' + ANAS.errText(e));
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
            ANAS.api.get(node, datasetPath(pool, fullName)).then(function (res) {
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
                ANAS.warn('dataset detail load failed: ' + ANAS.errText(err));
                var content = win.down('#content');
                if (content) {
                    content.removeAll();
                    content.add(ANAS.errorPanel(
                        t('Failed to load dataset detail') + ': ' + ANAS.errText(err)));
                }
            });
        }

        win.show();
        loadDetail();
    }

    // ---- Edit Properties (story 4.6) ---------------------------------------

    function editableFields() {
        return [
            {
                xtype: 'combobox',
                name: 'compression',
                fieldLabel: t('Compression'),
                store: ['off', 'lz4', 'zstd', 'gzip', 'on'],
                queryMode: 'local',
                editable: true,
                forceSelection: false,
            },
            {
                xtype: 'numberfield',
                name: 'recordsize',
                fieldLabel: t('Record size (bytes)'),
                minValue: 0,
            },
            {
                xtype: 'numberfield',
                name: 'quota',
                fieldLabel: t('Quota (bytes, 0 = none)'),
                minValue: 0,
            },
            {
                xtype: 'numberfield',
                name: 'reservation',
                fieldLabel: t('Reservation (bytes, 0 = none)'),
                minValue: 0,
            },
            {
                xtype: 'numberfield',
                name: 'refquota',
                fieldLabel: t('Ref quota (bytes, 0 = none)'),
                minValue: 0,
            },
            {
                xtype: 'numberfield',
                name: 'refreservation',
                fieldLabel: t('Ref reservation (bytes, 0 = none)'),
                minValue: 0,
            },
            {
                xtype: 'combobox',
                name: 'sync',
                fieldLabel: t('Sync'),
                store: ['standard', 'always', 'disabled'],
                queryMode: 'local',
                editable: false,
                forceSelection: true,
            },
            {
                xtype: 'checkboxfield',
                name: 'atime',
                fieldLabel: t('atime'),
                boxLabel: t('Update access times'),
            },
            {
                xtype: 'checkboxfield',
                name: 'readonly',
                fieldLabel: t('Read-only'),
                boxLabel: t('Reject writes to this dataset'),
            },
        ];
    }

    function openEdit(node, tree, rec) {
        if (!isDataset(rec)) {
            return;
        }
        if (typeof ANAS.editWindow !== 'function') {
            ANAS.warn('ANAS.editWindow unavailable — cannot edit dataset properties');
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        var original = {};

        ANAS.editWindow({
            cls: 'anas-win-dataset-edit',
            title: t('Edit Dataset') + ': ' + fullName,
            submitText: 'Save',
            submitCls: 'anas-btn-dataset-edit-submit',
            width: 480,
            items: editableFields(),

            load: function (form, done) {
                if (!form) {
                    done(t('Form unavailable'));
                    return;
                }
                ANAS.api.get(node, datasetPath(pool, fullName)).then(function (res) {
                    var p = (res && res.data && res.data.properties) || {};
                    original = {
                        compression: p.compression || '',
                        recordsize: Number(p.recordsize) || 0,
                        quota: Number(p.quota) || 0,
                        reservation: Number(p.reservation) || 0,
                        refquota: Number(p.refquota) || 0,
                        refreservation: Number(p.refreservation) || 0,
                        sync: p.sync || 'standard',
                        atime: !!p.atime,
                        readonly: !!p.readonly,
                    };
                    form.setValues(original);
                    done();
                }, function (err) {
                    done(t('Failed to load dataset properties') + ': ' + ANAS.errText(err));
                });
            },

            submit: function (form, win) {
                var current = {
                    compression: '' + (form.findField('compression').getValue() || ''),
                    recordsize: Number(form.findField('recordsize').getValue()) || 0,
                    quota: Number(form.findField('quota').getValue()) || 0,
                    reservation: Number(form.findField('reservation').getValue()) || 0,
                    refquota: Number(form.findField('refquota').getValue()) || 0,
                    refreservation: Number(form.findField('refreservation').getValue()) || 0,
                    sync: '' + form.findField('sync').getValue(),
                    atime: !!form.findField('atime').getValue(),
                    readonly: !!form.findField('readonly').getValue(),
                };

                var changed = {};
                if (current.compression && current.compression !== original.compression) {
                    changed.compression = current.compression;
                }
                if (current.recordsize !== original.recordsize) {
                    changed.recordsize = current.recordsize;
                }
                if (current.quota !== original.quota) {
                    changed.quota = current.quota;
                }
                if (current.reservation !== original.reservation) {
                    changed.reservation = current.reservation;
                }
                if (current.refquota !== original.refquota) {
                    changed.refquota = current.refquota;
                }
                if (current.refreservation !== original.refreservation) {
                    changed.refreservation = current.refreservation;
                }
                if (current.sync !== original.sync) {
                    changed.sync = current.sync;
                }
                if (current.atime !== original.atime) {
                    changed.atime = current.atime;
                }
                if (current.readonly !== original.readonly) {
                    changed.readonly = current.readonly;
                }

                if (!Object.keys(changed).length) {
                    ANAS.toast(t('No changes to save'));
                    win.close();
                    return;
                }

                ANAS.runJob({
                    node: node,
                    method: 'put',
                    path: datasetPath(pool, fullName),
                    body: { properties: changed },
                    view: win,
                    failTitle: 'Update failed',
                    successMsg: t('Dataset properties updated') + ': ' + fullName,
                    onComplete: function () {
                        win.close();
                        loadTree(tree, node);
                    },
                });
            },
        });
    }

    // ---- Permissions (story 4.7 — MVP POSIX owner/group/mode) --------------

    function identityStore() {
        return Ext.create('Ext.data.Store', {
            fields: ['name'],
            data: [],
        });
    }

    function loadIdentity(node, path, store, key) {
        return ANAS.api.get(node, path).then(function (res) {
            var rows = (res && res.data) || [];
            var data = [];
            for (var i = 0; i < rows.length; i++) {
                data.push({ name: rows[i].name });
            }
            store.loadData(data);
        }, function (err) {
            ANAS.warn(key + ' load failed: ' + ANAS.errText(err));
        });
    }

    function openPermissions(node, tree, rec) {
        if (!isFilesystem(rec)) {
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        var userStore = identityStore();
        var groupStore = identityStore();

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-dataset-perms',
                title: t('Permissions') + ': ' + fullName,
                modal: true,
                width: 460,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'combobox',
                            itemId: 'owner',
                            fieldLabel: t('Owner'),
                            store: userStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: true,
                            forceSelection: false,
                            emptyText: t('(unchanged)'),
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'group',
                            fieldLabel: t('Group'),
                            store: groupStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: true,
                            forceSelection: false,
                            emptyText: t('(unchanged)'),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'mode',
                            fieldLabel: t('Mode (octal)'),
                            emptyText: '0755',
                            regex: /^[0-7]{3,4}$/,
                            regexText: t('Mode must be 3 or 4 octal digits.'),
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'recursive',
                            fieldLabel: t('Recursive'),
                            boxLabel: t('Apply to all descendants'),
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
                        text: t('Apply'),
                        cls: 'anas-btn-dataset-perms-submit',
                        handler: function () {
                            try {
                                submitPermissions(win, node, tree, pool, fullName);
                            } catch (e) {
                                ANAS.warn('dataset perms submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('dataset perms window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        try {
            win.setLoading(true);
        } catch (e) {
            // non-fatal
        }

        // Load pickers and current permissions in parallel; prefill from the
        // dataset's current mountpoint ownership when present.
        var detailCall = ANAS.api.get(node, datasetPath(pool, fullName)).then(function (res) {
            return (res && res.data && res.data.permissions) || null;
        }, function (err) {
            ANAS.warn('dataset perms detail load failed: ' + ANAS.errText(err));
            return null;
        });

        Promise.all([
            loadIdentity(node, '/identity/users', userStore, 'users'),
            loadIdentity(node, '/identity/groups', groupStore, 'groups'),
            detailCall,
        ]).then(function (results) {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                win.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            var perms = results[2];
            if (perms) {
                var ownerField = win.down('#owner');
                var groupField = win.down('#group');
                var modeField = win.down('#mode');
                if (ownerField && perms.owner) {
                    ownerField.setValue(perms.owner);
                }
                if (groupField && perms.group) {
                    groupField.setValue(perms.group);
                }
                if (modeField && perms.mode) {
                    modeField.setValue(perms.mode);
                }
            }
        });
    }

    function submitPermissions(win, node, tree, pool, fullName) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var owner = (win.down('#owner').getValue() || '').trim();
        var group = (win.down('#group').getValue() || '').trim();
        var mode = (win.down('#mode').getValue() || '').trim();
        var recursive = !!win.down('#recursive').getValue();

        var body = {};
        if (owner) {
            body.owner = owner;
        }
        if (group) {
            body.group = group;
        }
        if (mode) {
            if (!/^[0-7]{3,4}$/.test(mode)) {
                alertMsg('Invalid input', t('Mode must be 3 or 4 octal digits.'));
                return;
            }
            body.mode = mode;
        }
        if (body.owner === undefined && body.group === undefined && body.mode === undefined) {
            alertMsg('Invalid input', t('Set at least one of owner, group, or mode.'));
            return;
        }
        if (recursive) {
            body.recursive = true;
        }

        ANAS.runJob({
            node: node,
            method: 'put',
            path: datasetPath(pool, fullName, 'permissions'),
            body: body,
            view: win,
            failTitle: 'Set permissions failed',
            successMsg: t('Permissions updated') + ': ' + fullName,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadTree(tree, node);
            },
        });
    }

    // ---- Destroy (story 4.8) -----------------------------------------------
    //
    // Dangerous: the daemon confirmation-gates it (409 + X-Anas-Confirm-Code +
    // warnings). Mirror 37-pool-destroy's challenge → dialog-with-checkbox →
    // confirmed-DELETE flow. The recursive flag is chosen in the dialog and
    // appended to the confirmed request; the confirm code is not bound to it.

    function runDestroy(node, tree, pool, fullName, confirmCode, recursive) {
        var path = datasetPath(pool, fullName);
        if (recursive) {
            path += '?recursive=true';
        }
        ANAS.runJob({
            node: node,
            method: 'del',
            path: path,
            confirmCode: confirmCode,
            view: tree,
            failTitle: 'Destroy failed',
            successMsg: t('Destroyed') + ' ' + fullName,
            maxMs: 30000,
            onComplete: function () {
                loadTree(tree, node);
            },
        });
    }

    function showDestroyConfirm(node, tree, pool, fullName, confirmCode, warnings) {
        var items = [{
            xtype: 'component',
            html: '<b>' + enc(t('Destroy dataset') + ' "' + fullName + '"?') + '</b>'
                + '<ul><li>'
                + (warnings || []).map(function (w) { return enc(w); }).join('</li><li>')
                + '</li></ul>',
            margin: '0 0 8 0',
        }, {
            xtype: 'checkbox',
            itemId: 'recursive',
            cls: 'anas-chk-ds-recursive',
            boxLabel: t('Recursive (destroy children)'),
        }];
        var win = Ext.create('Ext.window.Window', {
            title: t('Destroy dataset'),
            cls: 'anas-win-dataset-destroy',
            modal: true,
            width: 460,
            bodyPadding: 12,
            layout: 'anchor',
            items: items,
            buttons: [{
                text: t('Cancel'),
                handler: function () { win.close(); },
            }, {
                text: t('Destroy'),
                cls: 'anas-btn-dataset-destroy-confirm',
                ui: 'default-toolbar',
                handler: function () {
                    var recursive = win.down('#recursive').getValue();
                    win.close();
                    runDestroy(node, tree, pool, fullName, confirmCode, recursive);
                },
            }],
        });
        win.show();
    }

    function openDestroy(node, tree, rec) {
        if (!isDataset(rec)) {
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        // Step 1: unconfirmed DELETE → 409 challenge (code + warnings), or a
        // hard error we surface directly.
        ANAS.api.del(node, datasetPath(pool, fullName)).then(function () {
            // Unexpected: destroy without confirmation should not succeed.
            loadTree(tree, node);
        }, function (err) {
            if (err && err.status === 409 && err.confirmCode) {
                var warnings = (err.body && err.body.error && err.body.error.warnings) || [];
                showDestroyConfirm(node, tree, pool, fullName, err.confirmCode, warnings);
                return;
            }
            alertMsg('Destroy failed', ANAS.errText(err));
        });
    }

    // ======================================================================
    //  Snapshots (Epic 5: stories 5.1–5.6)
    //
    //  Snapshots hang off their dataset as flat leaf rows. They are fetched
    //  lazily the first time a dataset node is expanded (never upfront), the
    //  five most-recent shown inline; a "Show all N…" overflow row and a
    //  "Snapshots" toolbar button both open a popup grid of the full list.
    //  Every action works from both the inline rows and the popup.
    // ======================================================================

    var MAX_INLINE_SNAPS = 5;

    // ---- Snapshot node builders -------------------------------------------

    function snapshotNode(snap) {
        return {
            name: '@' + snap.snapshotName,
            fullName: snap.name,
            pool: snap.pool,
            dataset: snap.dataset,
            snapshotName: snap.snapshotName,
            kind: 'snapshot',
            created: snap.created,
            used: snap.used,
            referenced: snap.referenced,
            iconCls: 'fa fa-clock-o',
            leaf: true,
        };
    }

    function overflowNode(pool, datasetFullName, total) {
        return {
            name: t('Show all') + ' ' + total + ' ' + t('snapshots') + '…',
            pool: pool,
            dataset: datasetFullName,
            kind: 'snapshots-more',
            iconCls: 'fa fa-ellipsis-h',
            leaf: true,
        };
    }

    // ---- Lazy load / refresh ----------------------------------------------

    function removeSnapshotChildren(dsNode) {
        if (!dsNode || !dsNode.childNodes) {
            return;
        }
        var kids = dsNode.childNodes.slice();
        for (var i = 0; i < kids.length; i++) {
            var k = kids[i].get('kind');
            if (k === 'snapshot' || k === 'snapshots-more') {
                dsNode.removeChild(kids[i], true);
            }
        }
    }

    function appendSnapshotChildren(dsNode, snaps) {
        if (!dsNode || dsNode.destroyed) {
            return;
        }
        var list = snaps || [];
        var nodes = [];
        var shown = list.slice(0, MAX_INLINE_SNAPS);
        for (var i = 0; i < shown.length; i++) {
            nodes.push(snapshotNode(shown[i]));
        }
        if (list.length > MAX_INLINE_SNAPS) {
            nodes.push(overflowNode(dsNode.get('pool'), dsNode.get('fullName'), list.length));
        }
        if (nodes.length) {
            dsNode.appendChild(nodes);
        }
    }

    // Fetch a dataset's snapshots and render them under the node. Guarded by a
    // per-record flag so re-expanding does not re-fetch; `force` bypasses it for
    // an explicit refresh. Fail-open: a failure leaves the dataset with no
    // snapshot children and never disturbs the rest of the tree.
    function loadSnapshotsForNode(node, tree, dsNode, force) {
        if (!dsNode || dsNode.destroyed) {
            return;
        }
        if (dsNode.anasSnapsLoaded && !force) {
            return;
        }
        dsNode.anasSnapsLoaded = true;
        var pool = dsNode.get('pool');
        var fullName = dsNode.get('fullName');
        ANAS.api.get(node, snapshotsPath(pool, fullName)).then(function (res) {
            if (dsNode.destroyed || (tree && (tree.destroyed || tree.destroying))) {
                return;
            }
            removeSnapshotChildren(dsNode);
            appendSnapshotChildren(dsNode, (res && res.data) || []);
        }, function (err) {
            // Fail-open: no snapshot children. Clear the guard so a later
            // collapse/expand can retry rather than staying permanently empty.
            if (!dsNode.destroyed) {
                dsNode.anasSnapsLoaded = false;
            }
            ANAS.warn('snapshots load failed for ' + fullName + ': ' + ANAS.errText(err));
        });
    }

    function findDatasetNode(tree, pool, datasetFullName) {
        var found = null;
        try {
            var root = tree.getRootNode();
            if (root && typeof root.cascadeBy === 'function') {
                root.cascadeBy(function (n) {
                    if (!found && n.get('kind') === 'dataset'
                        && n.get('fullName') === datasetFullName && n.get('pool') === pool) {
                        found = n;
                    }
                });
            }
        } catch (e) {
            // fail-open — no node
        }
        return found;
    }

    // Reload the inline snapshot rows for one dataset after a mutation. When the
    // node is collapsed we just drop stale rows (they reload on next expand);
    // `expandCollapsed` forces it open so a freshly-created snapshot is visible.
    function refreshTreeSnapshots(node, tree, pool, datasetFullName, expandCollapsed) {
        var dsNode = findDatasetNode(tree, pool, datasetFullName);
        if (!dsNode) {
            return;
        }
        dsNode.anasSnapsLoaded = false;
        removeSnapshotChildren(dsNode);
        if (dsNode.isExpanded && dsNode.isExpanded()) {
            loadSnapshotsForNode(node, tree, dsNode, true);
        } else if (expandCollapsed && dsNode.expand) {
            dsNode.expand();
        }
    }

    function ctxFromSnapshotRecord(rec, view) {
        var dataset = rec.get('dataset');
        var snapshotName = rec.get('snapshotName');
        return {
            pool: rec.get('pool'),
            dataset: dataset,
            snapshotName: snapshotName,
            fullName: rec.get('fullName') || (dataset + '@' + snapshotName),
            view: view,
        };
    }

    // Reusable validator for a ZFS snapshot label (no '@' or '/').
    function validSnapName(name) {
        return /^[\w][\w.:-]*$/.test(name);
    }

    // ---- Create snapshot (story 5.3) --------------------------------------

    function openCreateSnapshot(node, pool, fullName, onDone) {
        if (!pool || !fullName) {
            return;
        }
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-snap-create',
                title: t('Create Snapshot') + ': ' + fullName,
                modal: true,
                width: 460,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'snapName',
                            cls: 'anas-fld-snap-name',
                            fieldLabel: t('Snapshot name'),
                            emptyText: 'nightly-2026-07-14',
                            allowBlank: false,
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'recursive',
                            fieldLabel: t('Recursive'),
                            boxLabel: t('Also snapshot child datasets'),
                        },
                    ],
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () { win.close(); },
                    },
                    {
                        text: t('Create'),
                        cls: 'anas-btn-snap-create-submit',
                        handler: function () {
                            try {
                                submitCreateSnapshot(win, node, pool, fullName, onDone);
                            } catch (e) {
                                ANAS.warn('snapshot create submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('snapshot create window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitCreateSnapshot(win, node, pool, fullName, onDone) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var name = (win.down('#snapName').getValue() || '').trim();
        if (!name) {
            alertMsg('Invalid input', t('Enter a snapshot name.'));
            return;
        }
        if (!validSnapName(name)) {
            alertMsg('Invalid input', t('Invalid snapshot name.'));
            return;
        }
        var body = { name: name };
        if (win.down('#recursive').getValue()) {
            body.recursive = true;
        }
        ANAS.runJob({
            node: node,
            method: 'post',
            path: snapshotsPath(pool, fullName),
            body: body,
            view: win,
            failTitle: 'Create snapshot failed',
            successMsg: t('Snapshot created') + ': ' + fullName + '@' + name,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (onDone) { onDone(); }
            },
        });
    }

    // ---- Rollback (story 5.5 — DANGEROUS) ---------------------------------
    //
    // Confirmation-gated like dataset/pool destroy: an unconfirmed POST returns
    // 409 + code + warnings; we surface the warnings in a dialog carrying an
    // optional "force" checkbox and, on confirm, resend with the code. The code
    // is NOT bound to force — force is appended to the confirmed request.

    function runRollback(node, ctx, confirmCode, force, onDone) {
        var path = snapshotPath(ctx.pool, ctx.dataset, ctx.snapshotName, 'rollback');
        if (force) {
            path += '?force=true';
        }
        ANAS.runJob({
            node: node,
            method: 'post',
            path: path,
            confirmCode: confirmCode,
            view: ctx.view,
            failTitle: 'Rollback failed',
            successMsg: t('Rolled back to') + ' ' + ctx.fullName,
            maxMs: 30000,
            onComplete: function () { if (onDone) { onDone(); } },
        });
    }

    function showRollbackConfirm(node, ctx, confirmCode, warnings, onDone) {
        var items = [{
            xtype: 'component',
            html: '<b>' + enc(t('Roll back to snapshot') + ' "' + ctx.fullName + '"?') + '</b>'
                + '<ul><li>'
                + (warnings || []).map(function (w) { return enc(w); }).join('</li><li>')
                + '</li></ul>',
            margin: '0 0 8 0',
        }, {
            xtype: 'checkbox',
            itemId: 'force',
            cls: 'anas-chk-snap-force',
            boxLabel: t('Force (-r): destroy any more-recent snapshots and bookmarks'),
        }];
        var win = Ext.create('Ext.window.Window', {
            title: t('Rollback snapshot'),
            cls: 'anas-win-snap-rollback',
            modal: true,
            width: 480,
            bodyPadding: 12,
            layout: 'anchor',
            items: items,
            buttons: [{
                text: t('Cancel'),
                handler: function () { win.close(); },
            }, {
                text: t('Rollback'),
                cls: 'anas-btn-snap-rollback-confirm',
                ui: 'default-toolbar',
                handler: function () {
                    var force = win.down('#force').getValue();
                    win.close();
                    runRollback(node, ctx, confirmCode, force, onDone);
                },
            }],
        });
        win.show();
    }

    function openRollback(node, ctx, onDone) {
        ANAS.api.post(node, snapshotPath(ctx.pool, ctx.dataset, ctx.snapshotName, 'rollback'), null).then(
            function () {
                // Unexpected: rollback without confirmation should not succeed.
                if (onDone) { onDone(); }
            },
            function (err) {
                if (err && err.status === 409 && err.confirmCode) {
                    var warnings = (err.body && err.body.error && err.body.error.warnings) || [];
                    showRollbackConfirm(node, ctx, err.confirmCode, warnings, onDone);
                    return;
                }
                alertMsg('Rollback failed', ANAS.errText(err));
            }
        );
    }

    // ---- Rename (story 5.4) -----------------------------------------------

    function openRenameSnapshot(node, ctx, onDone) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-snap-rename',
                title: t('Rename Snapshot') + ': ' + ctx.fullName,
                modal: true,
                width: 460,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [{
                        xtype: 'textfield',
                        itemId: 'newName',
                        cls: 'anas-fld-snap-newname',
                        fieldLabel: t('New name'),
                        allowBlank: false,
                        value: ctx.snapshotName,
                    }],
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () { win.close(); },
                    },
                    {
                        text: t('Rename'),
                        cls: 'anas-btn-snap-rename-submit',
                        handler: function () {
                            try {
                                submitRenameSnapshot(win, node, ctx, onDone);
                            } catch (e) {
                                ANAS.warn('snapshot rename submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('snapshot rename window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitRenameSnapshot(win, node, ctx, onDone) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var newName = (win.down('#newName').getValue() || '').trim();
        if (!newName) {
            alertMsg('Invalid input', t('Enter a new snapshot name.'));
            return;
        }
        if (!validSnapName(newName)) {
            alertMsg('Invalid input', t('Invalid snapshot name.'));
            return;
        }
        if (newName === ctx.snapshotName) {
            win.close();
            return;
        }
        ANAS.runJob({
            node: node,
            method: 'put',
            path: snapshotPath(ctx.pool, ctx.dataset, ctx.snapshotName),
            body: { newName: newName },
            view: win,
            failTitle: 'Rename failed',
            successMsg: t('Snapshot renamed') + ': ' + ctx.dataset + '@' + newName,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (onDone) { onDone(); }
            },
        });
    }

    // ---- Destroy snapshot (story 5.6) -------------------------------------
    //
    // Not confirmation-gated by the daemon (removes a recovery point, not live
    // data): a plain Ext.Msg.confirm then a plain DELETE.

    function runDestroySnapshot(node, ctx, onDone) {
        ANAS.runJob({
            node: node,
            method: 'del',
            path: snapshotPath(ctx.pool, ctx.dataset, ctx.snapshotName),
            view: ctx.view,
            failTitle: 'Destroy failed',
            successMsg: t('Destroyed') + ' ' + ctx.fullName,
            onComplete: function () { if (onDone) { onDone(); } },
        });
    }

    function destroySnapshotConfirm(node, ctx, onDone) {
        var msg = enc(t('Destroy snapshot') + ' "' + ctx.fullName + '"? ')
            + enc(t('This permanently removes the recovery point.'));
        try {
            Ext.Msg.confirm(t('Destroy snapshot'), msg, function (btn) {
                if (btn === 'yes') {
                    runDestroySnapshot(node, ctx, onDone);
                }
            });
        } catch (e) {
            ANAS.warn('snapshot destroy confirm failed: ' + ANAS.errText(e));
        }
    }

    // ---- Snapshots popup (stories 5.1 / 5.2 + full action surface) --------

    function openSnapshotsPopup(node, tree, pool, datasetFullName) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'dataset', 'snapshotName', 'pool', 'created',
                { name: 'used', type: 'auto' },
                { name: 'referenced', type: 'auto' },
            ],
            data: [],
        });

        var grid;
        var win;

        function selectedSnap() {
            var sel = grid ? grid.getSelection() : [];
            var rec = (sel && sel.length) ? sel[0] : null;
            return rec ? ctxFromSnapshotRecord(rec, win) : null;
        }

        function updatePopupButtons() {
            var has = !!selectedSnap();
            var ids = ['snapRollback', 'snapRename', 'snapDestroy'];
            for (var i = 0; i < ids.length; i++) {
                var b = win.down('#' + ids[i]);
                if (b) { b.setDisabled(!has); }
            }
        }

        function reloadGrid() {
            if (win.destroyed || win.destroying) {
                return;
            }
            try { win.setLoading(true); } catch (e) { /* non-fatal */ }
            ANAS.api.get(node, snapshotsPath(pool, datasetFullName)).then(function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                try { win.setLoading(false); } catch (e) { /* non-fatal */ }
                store.loadData((res && res.data) || []);
                updatePopupButtons();
            }, function (err) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                try { win.setLoading(false); } catch (e) { /* non-fatal */ }
                ANAS.warn('snapshots popup load failed: ' + ANAS.errText(err));
                alertMsg('Error', t('Failed to load snapshots') + ': ' + ANAS.errText(err));
            });
        }

        // After any popup-driven mutation, reload the grid AND the inline rows.
        function afterMutation() {
            reloadGrid();
            refreshTreeSnapshots(node, tree, pool, datasetFullName, false);
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-snapshots',
                title: t('Snapshots') + ': ' + datasetFullName,
                modal: true,
                width: 760,
                height: 520,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'grid',
                    itemId: 'grid',
                    cls: 'anas-grid-snapshots',
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No snapshots'),
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'snapshotName',
                            flex: 1,
                            renderer: Ext.String.htmlEncode,
                        },
                        {
                            text: t('Created'),
                            dataIndex: 'created',
                            width: 150,
                            renderer: formatCreated,
                        },
                        {
                            text: t('Used'),
                            dataIndex: 'used',
                            width: 110,
                            align: 'right',
                            renderer: renderBytes,
                        },
                        {
                            text: t('Referenced'),
                            dataIndex: 'referenced',
                            width: 110,
                            align: 'right',
                            renderer: renderBytes,
                        },
                    ],
                    tbar: [
                        {
                            text: t('Reload'),
                            iconCls: 'fa fa-refresh',
                            handler: function () { reloadGrid(); },
                        },
                        {
                            text: t('Create Snapshot'),
                            cls: 'anas-btn-snap-create',
                            iconCls: 'fa fa-camera',
                            handler: function () {
                                openCreateSnapshot(node, pool, datasetFullName, afterMutation);
                            },
                        },
                        {
                            text: t('Rollback'),
                            itemId: 'snapRollback',
                            cls: 'anas-btn-snap-rollback',
                            iconCls: 'fa fa-history',
                            disabled: true,
                            handler: function () {
                                var ctx = selectedSnap();
                                if (ctx) { openRollback(node, ctx, afterMutation); }
                            },
                        },
                        {
                            text: t('Rename'),
                            itemId: 'snapRename',
                            cls: 'anas-btn-snap-rename',
                            iconCls: 'fa fa-pencil',
                            disabled: true,
                            handler: function () {
                                var ctx = selectedSnap();
                                if (ctx) { openRenameSnapshot(node, ctx, afterMutation); }
                            },
                        },
                        {
                            text: t('Destroy'),
                            itemId: 'snapDestroy',
                            cls: 'anas-btn-snap-destroy',
                            iconCls: 'fa fa-trash',
                            disabled: true,
                            handler: function () {
                                var ctx = selectedSnap();
                                if (ctx) { destroySnapshotConfirm(node, ctx, afterMutation); }
                            },
                        },
                    ],
                    listeners: {
                        selectionchange: function () { updatePopupButtons(); },
                        itemdblclick: function (g, rec) {
                            openRenameSnapshot(node, ctxFromSnapshotRecord(rec, win), afterMutation);
                        },
                    },
                }],
            });
        } catch (e) {
            ANAS.warn('snapshots popup window failed: ' + ANAS.errText(e));
            return;
        }
        grid = win.down('#grid');
        win.show();
        reloadGrid();
    }

    // ---- Snapshot toolbar-action dispatch (from the datasets tree) --------

    function snapCreateFromTree(node, tree) {
        var rec = selectedRecord(tree);
        if (!isDataset(rec)) {
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        openCreateSnapshot(node, pool, fullName, function () {
            refreshTreeSnapshots(node, tree, pool, fullName, true);
        });
    }

    function snapPopupFromTree(node, tree) {
        var rec = selectedRecord(tree);
        if (!isDataset(rec)) {
            return;
        }
        openSnapshotsPopup(node, tree, rec.get('pool'), rec.get('fullName'));
    }

    function snapActionFromTree(node, tree, kind) {
        var rec = selectedRecord(tree);
        if (!isSnapshot(rec)) {
            return;
        }
        var ctx = ctxFromSnapshotRecord(rec, tree);
        var onDone = function () {
            refreshTreeSnapshots(node, tree, ctx.pool, ctx.dataset, false);
        };
        if (kind === 'rollback') {
            openRollback(node, ctx, onDone);
        } else if (kind === 'rename') {
            openRenameSnapshot(node, ctx, onDone);
        } else if (kind === 'destroy') {
            destroySnapshotConfirm(node, ctx, onDone);
        }
    }

    // ---- View --------------------------------------------------------------

    function datasetsView(node) {
        var store = Ext.create('Ext.data.TreeStore', {
            fields: [
                'name', 'fullName', 'pool', 'kind', 'type', 'mountpoint',
                'compression',
                // Snapshot rows reuse the tree: 'dataset'/'snapshotName' carry
                // the parent + label; 'created' feeds the Created column.
                'dataset', 'snapshotName', 'created',
                { name: 'used', type: 'auto' },
                { name: 'available', type: 'auto' },
                { name: 'referenced', type: 'auto' },
                { name: 'compressratio', type: 'auto' },
                { name: 'quota', type: 'auto' },
            ],
            root: { expanded: true, children: [] },
        });

        var tbar = [
            {
                text: t('Reload'),
                cls: 'anas-btn-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    loadTree(btn.up('treepanel'), node);
                },
            },
            {
                text: t('Create Dataset'),
                itemId: 'dsCreate',
                cls: 'anas-btn-ds-create',
                iconCls: 'fa fa-plus',
                handler: function (btn) {
                    var tree = btn.up('treepanel');
                    openCreate(node, tree, selectedRecord(tree));
                },
            },
            {
                text: t('Detail'),
                itemId: 'dsDetail',
                cls: 'anas-btn-ds-detail',
                iconCls: 'fa fa-search',
                disabled: true,
                handler: function (btn) {
                    openDetail(node, selectedRecord(btn.up('treepanel')));
                },
            },
            {
                text: t('Edit Properties'),
                itemId: 'dsEdit',
                cls: 'anas-btn-ds-edit',
                iconCls: 'fa fa-cog',
                disabled: true,
                handler: function (btn) {
                    var tree = btn.up('treepanel');
                    openEdit(node, tree, selectedRecord(tree));
                },
            },
            {
                text: t('Permissions'),
                itemId: 'dsPerms',
                cls: 'anas-btn-ds-perms',
                iconCls: 'fa fa-lock',
                disabled: true,
                handler: function (btn) {
                    var tree = btn.up('treepanel');
                    openPermissions(node, tree, selectedRecord(tree));
                },
            },
            {
                text: t('Destroy'),
                itemId: 'dsDestroy',
                cls: 'anas-btn-ds-destroy',
                iconCls: 'fa fa-trash',
                disabled: true,
                handler: function (btn) {
                    var tree = btn.up('treepanel');
                    openDestroy(node, tree, selectedRecord(tree));
                },
            },
            '-',
            {
                text: t('Create Snapshot'),
                itemId: 'snapCreate',
                cls: 'anas-btn-snap-create',
                iconCls: 'fa fa-camera',
                disabled: true,
                handler: function (btn) {
                    snapCreateFromTree(node, btn.up('treepanel'));
                },
            },
            {
                text: t('Snapshots'),
                itemId: 'snapAll',
                cls: 'anas-btn-snap-all',
                iconCls: 'fa fa-clock-o',
                disabled: true,
                handler: function (btn) {
                    snapPopupFromTree(node, btn.up('treepanel'));
                },
            },
            {
                text: t('Rollback'),
                itemId: 'snapRollback',
                cls: 'anas-btn-snap-rollback',
                iconCls: 'fa fa-history',
                disabled: true,
                handler: function (btn) {
                    snapActionFromTree(node, btn.up('treepanel'), 'rollback');
                },
            },
            {
                text: t('Rename Snapshot'),
                itemId: 'snapRename',
                cls: 'anas-btn-snap-rename',
                iconCls: 'fa fa-pencil',
                disabled: true,
                handler: function (btn) {
                    snapActionFromTree(node, btn.up('treepanel'), 'rename');
                },
            },
            {
                text: t('Destroy Snapshot'),
                itemId: 'snapDestroy',
                cls: 'anas-btn-snap-destroy',
                iconCls: 'fa fa-trash-o',
                disabled: true,
                handler: function (btn) {
                    snapActionFromTree(node, btn.up('treepanel'), 'destroy');
                },
            },
        ];

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-datasets',
            title: t('Datasets'),
            layout: 'fit',
            border: false,
            items: [{
                xtype: 'treepanel',
                itemId: 'dsTree',
                cls: 'anas-grid-datasets',
                border: false,
                rootVisible: false,
                store: store,
                selModel: { mode: 'SINGLE' },
                emptyText: t('No datasets found'),
                columns: [
                    {
                        xtype: 'treecolumn',
                        text: t('Name'),
                        dataIndex: 'name',
                        flex: 1,
                        renderer: Ext.String.htmlEncode,
                    },
                    {
                        text: t('Used'),
                        dataIndex: 'used',
                        width: 110,
                        align: 'right',
                        renderer: renderBytes,
                    },
                    {
                        text: t('Available'),
                        dataIndex: 'available',
                        width: 110,
                        align: 'right',
                        renderer: renderBytes,
                    },
                    {
                        text: t('Referenced'),
                        dataIndex: 'referenced',
                        width: 110,
                        align: 'right',
                        renderer: renderBytes,
                    },
                    {
                        // New for snapshot rows; blank for datasets/pools.
                        text: t('Created'),
                        dataIndex: 'created',
                        width: 150,
                        renderer: formatCreated,
                    },
                    {
                        text: t('Compression'),
                        dataIndex: 'compression',
                        width: 150,
                        renderer: renderCompression,
                    },
                    {
                        text: t('Quota'),
                        dataIndex: 'quota',
                        width: 110,
                        align: 'right',
                        renderer: renderQuota,
                    },
                ],
                tbar: tbar,
                // Tag snapshot / overflow rows for styling + test hooks.
                viewConfig: {
                    getRowClass: function (record) {
                        var kind = record.get('kind');
                        if (kind === 'snapshot') {
                            return 'anas-snap-row';
                        }
                        if (kind === 'snapshots-more') {
                            return 'anas-snap-more';
                        }
                        return '';
                    },
                },
                listeners: {
                    afterrender: function (tree) {
                        loadTree(tree, node);
                    },
                    selectionchange: function () {
                        updateButtons(this);
                    },
                    // Lazy-load a dataset's snapshots the first time it expands.
                    itemexpand: function (record) {
                        try {
                            if (record && record.get && record.get('kind') === 'dataset') {
                                loadSnapshotsForNode(node, this, record, false);
                            }
                        } catch (e) {
                            ANAS.warn('snapshot lazy-load failed: ' + ANAS.errText(e));
                        }
                    },
                    itemclick: function (tree, record) {
                        // The "Show all N…" overflow row opens the full popup.
                        if (isSnapshotsMore(record)) {
                            openSnapshotsPopup(node, tree, record.get('pool'), record.get('dataset'));
                        }
                    },
                    itemdblclick: function (tree, record) {
                        if (isDataset(record)) {
                            openDetail(node, record);
                        } else if (isSnapshotsMore(record)) {
                            openSnapshotsPopup(node, tree, record.get('pool'), record.get('dataset'));
                        }
                    },
                },
            }],
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['datasets'] = {
        itemId: 'anas-datasets',
        text: t('Datasets'),
        iconCls: 'fa fa-sitemap',
        factory: function (node) {
            try {
                return datasetsView(node);
            } catch (e) {
                ANAS.warn('datasets view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
