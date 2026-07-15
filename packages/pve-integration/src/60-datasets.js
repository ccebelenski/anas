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
 *   GET    /pools/:name/datasets/<path>/access → { data: DatasetAccess } (Epic 4.7.2)
 *   PUT    /pools/:name/datasets/<path>/access → 202 { job }  (SetAccessRequest)
 *   GET    /identity/users                     → { data: SystemUser[] }
 *   GET    /identity/groups                    → { data: SystemGroup[] }
 *
 * Test hooks: view panel cls 'anas-view anas-view-datasets', tree cls
 * 'anas-grid-datasets', action buttons 'anas-btn-ds-create' /
 * 'anas-btn-ds-detail' / 'anas-btn-ds-edit' / 'anas-btn-ds-perms' /
 * 'anas-btn-ds-destroy', the contextual 'anas-btn-ds-share' (submenu items
 * 'anas-btn-ds-share-smb' / 'anas-btn-ds-share-nfs', Epic 6/7 — opens the
 * Shares create flow pre-filled from the dataset), windows
 * 'anas-win-dataset-create' /
 * 'anas-win-dataset-detail'. The layered access editor (Epic 4.7.2) opens
 * 'anas-win-dataset-access' — its full test-hook list is documented in a
 * comment above openPermissions.
 *
 * Snapshots (Epic 5, GET/POST …/datasets/<path>/snapshots and
 * PUT/DELETE/…/rollback per snapshot): snapshots hang off their dataset as
 * flat leaf rows, lazy-loaded on first expand (top-5 inline, an 'anas-snap-more'
 * overflow row + 'anas-btn-snap-all' toolbar button open the 'anas-win-snapshots'
 * popup grid 'anas-grid-snapshots'). Snapshot rows carry cls 'anas-snap-row';
 * actions use buttons 'anas-btn-snap-create' / -rollback / -rename / -clone /
 * -destroy.
 *
 * Later enhancements (Epics 4.4 / 4.9 / 4.10 / 5.7 / 4.12) add these hooks:
 *   4.4  associated shares in the detail window — panel cls 'anas-detail-shares'
 *        (SMB/NFS protocol badges beside each share name; "None" when empty).
 *   4.9  achieved compression ratio in the detail Usage section, wrapped in a
 *        '<span class="anas-detail-compressratio">'. The Edit Properties
 *        compression combo already offers off/lz4/zstd/gzip (+on) and stays
 *        free-text so any current value survives.
 *   4.10 dedup control in Edit Properties — combobox cls 'anas-fld-dedup' behind
 *        a collapsed "Advanced" fieldset; a prominent inline warning (itemId
 *        'anasDedupWarn') appears whenever dedup != off. Sent via the existing
 *        properties PUT.
 *   4.12 sync=disabled inline caution (itemId 'anasSyncWarn') shown/hidden by a
 *        listener on the sync field.
 *   5.7  clone a snapshot into a new dataset — window 'anas-win-snap-clone',
 *        target field 'anas-fld-clone-target', submit 'anas-btn-snap-clone-submit';
 *        the Clone action is button 'anas-btn-snap-clone' (tree toolbar +
 *        snapshots popup). POST …/snapshots/:snap/clone { target }, then the tree
 *        reloads so the new dataset appears.
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

    // Default snapshot label: "snapshot-<local timestamp>", human-readable and
    // sortable. Recomputed each time the create dialog opens; fully overridable.
    function defaultSnapName() {
        try {
            if (typeof Ext !== 'undefined' && Ext.Date && typeof Ext.Date.format === 'function') {
                return 'snapshot-' + Ext.Date.format(new Date(), 'Y-m-d-His');
            }
        } catch (e) {
            // fall through
        }
        return 'snapshot-';
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

    function nodeFromDataset(ds, kind, poolSize) {
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
            // Total capacity of the owning pool (bytes) — feeds the "Space of
            // pool" gfx bar (Epic 15.4). Threaded from the GET /pools summary.
            poolSize: poolSize,
            // Suppress the default tree node glyph so the gfx object icon drawn
            // in the Name column is the only icon (see ensureDatasetStyles).
            iconCls: 'anas-tree-obj',
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
    function ensureParent(parentName, pool, byName, poolSize) {
        if (byName[parentName]) {
            return byName[parentName];
        }
        var node = {
            name: lastSegment(parentName),
            fullName: parentName,
            pool: pool,
            kind: 'dataset',
            type: 'filesystem',
            poolSize: poolSize,
            iconCls: 'anas-tree-obj',
            leaf: false,
            children: [],
        };
        byName[parentName] = node;
        var grandName = parentName.substring(0, parentName.lastIndexOf('/'));
        var grand = grandName ? ensureParent(grandName, pool, byName, poolSize) : byName[pool];
        if (grand) {
            grand.children.push(node);
            grand.leaf = false;
        }
        return node;
    }

    function buildPoolNode(pool, datasets) {
        var byName = {};
        var poolSize = Number(pool.size) || 0;
        var rootNode = {
            name: pool.name,
            fullName: pool.name,
            pool: pool.name,
            kind: 'pool',
            type: 'filesystem',
            poolSize: poolSize,
            iconCls: 'anas-tree-obj',
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
            var node = nodeFromDataset(ds, 'dataset', poolSize);
            byName[ds.name] = node;
            var parentName = ds.name.substring(0, ds.name.lastIndexOf('/'));
            var parent = byName[parentName] || ensureParent(parentName, pool.name, byName, poolSize);
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
                var poolMap = {};
                for (var j = 0; j < results.length; j++) {
                    children.push(buildPoolNode(results[j].pool, results[j].datasets));
                    if (results[j].pool && results[j].pool.name) {
                        poolMap[results[j].pool.name] = results[j].pool;
                    }
                }
                // Stash the pool summaries so the donut hero (Epic 15.4) can read
                // size/allocated/free without another round-trip.
                try {
                    tree.anasPools = poolMap;
                } catch (ePool) {
                    // non-fatal
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
                try {
                    refreshHero(tree);
                } catch (eHero) {
                    // Hero is a graceful enhancement — never let it break the tree.
                }
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
        // Contextual "Share…" is offered on filesystem datasets only — they
        // have a mountpoint path to share (DESIGN 5a/5d). zvols cannot.
        setDisabled(tree, 'dsShare', !fs);
        setDisabled(tree, 'dsDestroy', !ds);
        // Snapshot actions: create/list act on a selected dataset; the
        // rollback/rename/destroy trio act on a selected snapshot row.
        setDisabled(tree, 'snapCreate', !ds);
        setDisabled(tree, 'snapAll', !ds);
        setDisabled(tree, 'snapRollback', !snap);
        setDisabled(tree, 'snapRename', !snap);
        setDisabled(tree, 'snapClone', !snap);
        setDisabled(tree, 'snapDestroy', !snap);
    }

    // ---- Contextual "Share…" (Epic 6/7, DESIGN 5d) -------------------------
    //
    // Open the unified Shares create flow pre-filled from a filesystem dataset:
    // path = the dataset's mountpoint, SMB name suggested from its last path
    // segment (overridable in the dialog). The Shares view (70-shares.js) owns
    // the create windows and is resolved lazily — it loads after this file, so
    // ANAS.shares exists by the time a user clicks. Fail-open: if it is somehow
    // absent, warn rather than throw.

    function shareDatasetFromTree(node, tree, proto, rec) {
        // `rec` is optional — the toolbar submenu relies on the tree selection,
        // while the per-row action icon (Epic 15.4) passes the clicked record.
        rec = rec || selectedRecord(tree);
        if (!isFilesystem(rec)) {
            return;
        }
        if (!ANAS.shares || typeof ANAS.shares.openSmbCreate !== 'function'
            || typeof ANAS.shares.openNfsCreate !== 'function') {
            alertMsg('Shares unavailable', t('The Shares view is not available.'));
            return;
        }
        var mountpoint = rec.get('mountpoint');
        if (!mountpoint || mountpoint === 'none' || mountpoint === '-') {
            alertMsg('Cannot share', t('This dataset has no mountpoint to share.'));
            return;
        }
        var preset = {
            path: mountpoint,
            name: lastSegment(rec.get('fullName')),
        };
        var onDone = function () {
            // Nothing to refresh in the datasets tree; the share lives in the
            // Shares view. runJob already toasts success.
        };
        if (proto === 'nfs') {
            ANAS.shares.openNfsCreate(node, preset, onDone);
        } else {
            ANAS.shares.openSmbCreate(node, preset, onDone);
        }
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
                + (Number(d.compressratio) > 0
                    ? ' <span class="anas-detail-compressratio">('
                        + Number(d.compressratio).toFixed(2) + 'x)</span>'
                    : ''));
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

    // Small protocol pill matching the Shares view badge style (70-shares.js
    // renderProtocol): SMB blue, NFS violet.
    function shareBadge(proto) {
        var p = ('' + (proto || '')).toLowerCase();
        var color = p === 'smb' ? '#3468c0' : '#8a2be2';
        return '<span class="anas-badge anas-badge-' + enc(p) + '"'
            + ' style="display:inline-block;padding:1px 8px;border-radius:3px;'
            + 'color:#fff;font-size:0.85em;background:' + color + ';">'
            + enc(p.toUpperCase()) + '</span>';
    }

    // Associated shares (Epic 4.4): each entry is { protocol:'smb'|'nfs', name }
    // where name is the SMB share name or the NFS export path. Render a protocol
    // badge beside the name; show "None" when empty.
    function sharesHtml(shares) {
        if (!shares || !shares.length) {
            return '<p style="color:gray;">' + enc(t('None')) + '</p>';
        }
        var out = '<table style="border-collapse:collapse;">';
        for (var i = 0; i < shares.length; i++) {
            var s = shares[i] || {};
            out += '<tr><td style="padding:2px 8px 2px 0;white-space:nowrap;vertical-align:top;">'
                + shareBadge(s.protocol) + '</td>'
                + '<td style="padding:2px 0;vertical-align:top;">' + enc(s.name || '') + '</td></tr>';
        }
        return out + '</table>';
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
                cls: 'anas-detail-shares',
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

    // Show the sync=disabled caution (Epic 4.12) only when the field reads
    // 'disabled'. The note component lives as a sibling in the same form.
    function toggleSyncWarn(field) {
        try {
            var form = field.up('form');
            var cmp = form && form.down('#anasSyncWarn');
            if (cmp) {
                cmp.setHidden(('' + field.getValue()) !== 'disabled');
            }
        } catch (e) {
            // non-fatal — display hint only
        }
    }

    // Show the dedup caution (Epic 4.10) whenever dedup is set to anything other
    // than 'off'.
    function toggleDedupWarn(field) {
        try {
            var v = '' + (field.getValue() || '');
            var form = field.up('form');
            var cmp = form && form.down('#anasDedupWarn');
            if (cmp) {
                cmp.setHidden(!v || v === 'off');
            }
        } catch (e) {
            // non-fatal — display hint only
        }
    }

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
                listeners: {
                    change: function (f) { toggleSyncWarn(f); },
                    afterrender: function (f) { toggleSyncWarn(f); },
                },
            },
            {
                // Epic 4.12 — data-loss caution, shown only when sync=disabled.
                xtype: 'component',
                itemId: 'anasSyncWarn',
                hidden: true,
                margin: '0 0 8 0',
                style: 'color:#b35900;font-size:11px;',
                html: enc(t('sync=disabled risks losing the last few seconds of writes '
                    + 'on a crash — safe only for reproducible/scratch data.')),
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
            {
                // Epic 4.10 — dedup is a foot-gun: keep it collapsed by default.
                xtype: 'fieldset',
                title: t('Advanced'),
                collapsible: true,
                collapsed: true,
                margin: '4 0 0 0',
                items: [
                    {
                        xtype: 'combobox',
                        name: 'dedup',
                        cls: 'anas-fld-dedup',
                        fieldLabel: t('Deduplication'),
                        anchor: '100%',
                        labelWidth: 150,
                        store: ['off', 'on', 'verify'],
                        queryMode: 'local',
                        editable: false,
                        forceSelection: true,
                        listeners: {
                            change: function (f) { toggleDedupWarn(f); },
                            afterrender: function (f) { toggleDedupWarn(f); },
                        },
                    },
                    {
                        xtype: 'component',
                        itemId: 'anasDedupWarn',
                        hidden: true,
                        margin: '4 0 0 0',
                        style: 'color:#b35900;font-size:11px;',
                        html: enc(t('Deduplication is costly and hard to undo: budget roughly '
                            + '1–5 GB of RAM per TB of stored data, and it applies only to data '
                            + 'written AFTER it is enabled (it is sticky, not retroactive). '
                            + 'OpenZFS 2.3 "fast dedup" softens the cost but does not remove it. '
                            + 'Leave this off unless you understand the trade-offs.')),
                    },
                ],
            },
        ];
    }

    function openEdit(node, tree, rec) {
        // Accept a dataset OR the pool root: the pool root row carries the pool's
        // root filesystem data (merged in buildPoolNode) and the daemon addresses
        // it via the empty-relative-path detail endpoint, so its ZFS properties
        // are editable too (Epic 15.4 per-row "props" action on the pool root).
        if (!isDataset(rec) && !(rec && rec.get('kind') === 'pool')) {
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
                        dedup: p.dedup || 'off',
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
                    dedup: '' + (form.findField('dedup').getValue() || ''),
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
                if (current.dedup && current.dedup !== original.dedup) {
                    changed.dedup = current.dedup;
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

    // ---- Permissions: layered access editor (Epic 4.7.2) ------------------
    //
    // Replaces the story-4.7 octal editor (Owner/Group combos + Mode textfield +
    // Recursive checkbox). The base three principals (owner / owning-group /
    // everyone) map to POSIX mode bits; extra named users/groups map to POSIX
    // ACL entries. Data contract: packages/shared/src/schemas/access.ts
    // (DatasetAccess on GET, SetAccessRequest on PUT). The daemon does the
    // acltype=posixacl enable + default-ACL inheritance; the UI only informs.
    //
    // Access-level labels ↔ schema: "No access"↔none, "Read"↔read,
    // "Read-Write"↔read-write.
    //
    // Test hooks (stable selectors targeted by the integration agent):
    //   window            'anas-win-dataset-access'
    //   owner picker       'anas-fld-access-owner'
    //   owner level        'anas-fld-access-owner-level'
    //   group picker       'anas-fld-access-group'
    //   group level        'anas-fld-access-group-level'
    //   everyone level     'anas-fld-access-everyone-level'
    //   named grid         'anas-grid-access-named'
    //   add button         'anas-btn-access-add'
    //   per-row remove     'anas-btn-access-remove'
    //   apply-existing     'anas-fld-access-recursive'
    //   Advanced panel     'anas-panel-access-advanced'
    //   window submit      'anas-btn-dataset-access-submit'
    //   add-principal win  'anas-win-access-add'
    //     kind field        'anas-fld-access-add-kind'
    //     name field        'anas-fld-access-add-name'
    //     level field       'anas-fld-access-add-level'
    //     submit            'anas-btn-access-add-submit'
    //
    // acl-unsupported / not-enabled handling (from DatasetAccess flags):
    //   aclSupported === false — no setfacl on this node: the base three rows
    //     still edit (mode bits) and submit fine; "+ Add user or group" is
    //     DISABLED with an inline "install acl" note.
    //   aclEnabled === false (but supported) — adding a named principal is
    //     allowed and shows a subtle note that it will enable POSIX ACLs
    //     (acltype=posixacl) on the dataset; the daemon performs the enable.

    // Plain-language level dropdown options (label ↔ schema value).
    function accessLevelStore() {
        return Ext.create('Ext.data.Store', {
            fields: ['level', 'label'],
            data: [
                { level: 'none', label: t('No access') },
                { level: 'read', label: t('Read') },
                { level: 'read-write', label: t('Read-Write') },
            ],
        });
    }

    // Map a schema level to its display label (grid renderer / fallbacks).
    function accessLevelLabel(level) {
        if (level === 'read') { return t('Read'); }
        if (level === 'read-write') { return t('Read-Write'); }
        return t('No access');
    }

    // Level of the first entry matching `kind` in a DatasetAccess.entries list;
    // defaults to 'none' when absent (the daemon always sends the base three).
    function baseEntryLevel(entries, kind) {
        var list = entries || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].kind === kind) {
                return list[i].level || 'none';
            }
        }
        return 'none';
    }

    // Is the base owner/owning-group entry an orphan (uid/gid didn't resolve)?
    function baseEntryUnresolved(entries, kind) {
        var list = entries || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].kind === kind) {
                return !!list[i].unresolved;
            }
        }
        return false;
    }

    // Display label for a named/base principal, flagging orphans clearly so a
    // bare numeric id reads as "unknown (uid N)" / "unknown (gid N)" rather than
    // a real name. `isGroup` picks the right id kind (a group's number is a gid).
    function principalLabel(name, unresolved, isGroup) {
        var n = '' + (name == null ? '' : name);
        if (unresolved) {
            var idKind = isGroup ? 'gid' : 'uid';
            return t('unknown') + ' (' + idKind + ' ' + enc(n) + ')';
        }
        return enc(n);
    }

    // Tag an owner/group picker field as showing an orphaned id (tooltip + note).
    // `isGroup` picks user/uid vs group/gid wording.
    function markOrphanPicker(field, unresolved, isGroup) {
        if (!field) { return; }
        try {
            if (unresolved) {
                field.addCls('anas-fld-orphan');
                field.setFieldStyle('color:#b35900;');
                if (field.setTooltip) {
                    field.setTooltip(isGroup
                        ? t('This gid no longer resolves to a group — it was removed outside ANAS.')
                        : t('This uid no longer resolves to a user — the account was removed outside ANAS.'));
                }
            } else {
                field.removeCls('anas-fld-orphan');
                field.setFieldStyle('');
            }
        } catch (e) {
            // non-fatal — display hint only
        }
    }

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

    // Best-effort refresh of any open dataset-detail window (its Permissions
    // section reflects owner/group). Fail-open — the tree reload is the primary
    // refresh; this is a convenience so a visible detail view isn't stale.
    function reloadVisibleDetail() {
        try {
            var wins = Ext.ComponentQuery.query('.anas-win-dataset-detail');
            for (var i = 0; i < wins.length; i++) {
                var btn = wins[i].down('button');
                if (btn && typeof btn.handler === 'function') {
                    btn.handler(btn);
                }
            }
        } catch (e) {
            // non-fatal
        }
    }

    // Small window to add one named user/group grant. The name picker swaps its
    // store between users and groups as the kind toggles.
    function openAddPrincipal(parentWin, namedStore, userStore, groupStore, aclEnabled) {
        var addWin;
        try {
            addWin = Ext.create('Ext.window.Window', {
                cls: 'anas-win-access-add',
                title: t('Add user or group'),
                modal: true,
                width: 380,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 90 },
                    items: [
                        {
                            xtype: 'combobox',
                            itemId: 'kind',
                            cls: 'anas-fld-access-add-kind',
                            fieldLabel: t('Type'),
                            store: Ext.create('Ext.data.Store', {
                                fields: ['kind', 'label'],
                                data: [
                                    { kind: 'user', label: t('User') },
                                    { kind: 'group', label: t('Group') },
                                ],
                            }),
                            valueField: 'kind',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: 'user',
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'name',
                            cls: 'anas-fld-access-add-name',
                            fieldLabel: t('Name'),
                            store: userStore,
                            valueField: 'name',
                            displayField: 'name',
                            queryMode: 'local',
                            editable: true,
                            forceSelection: false,
                            allowBlank: false,
                            emptyText: t('pick a user'),
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'level',
                            cls: 'anas-fld-access-add-level',
                            fieldLabel: t('Access'),
                            store: accessLevelStore(),
                            valueField: 'level',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: 'read',
                        },
                        {
                            xtype: 'component',
                            hidden: !!aclEnabled,
                            style: 'margin-top:6px;color:#888;font-size:11px;',
                            html: enc(t('Adding a named user or group enables POSIX ACLs '
                                + '(acltype=posixacl) on this dataset.')),
                        },
                    ],
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () { addWin.close(); },
                    },
                    {
                        text: t('Add'),
                        cls: 'anas-btn-access-add-submit',
                        handler: function () {
                            try {
                                var kind = addWin.down('#kind').getValue() || 'user';
                                var name = (addWin.down('#name').getValue() || '').trim();
                                var level = addWin.down('#level').getValue() || 'read';
                                if (!name) {
                                    alertMsg('Invalid input',
                                        t('Pick a user or group name.'));
                                    return;
                                }
                                // Collapse duplicates: same kind+name updates level.
                                var dup = namedStore.findBy(function (r) {
                                    return r.get('kind') === kind && r.get('name') === name;
                                });
                                if (dup !== -1) {
                                    namedStore.getAt(dup).set('level', level);
                                } else {
                                    namedStore.add({ kind: kind, name: name, level: level });
                                }
                                addWin.close();
                            } catch (e) {
                                ANAS.warn('add principal failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('add principal window failed: ' + ANAS.errText(e));
            return;
        }

        // Swap the name picker's store when the kind toggles.
        var kindField = addWin.down('#kind');
        var nameField = addWin.down('#name');
        if (kindField && nameField) {
            kindField.on('change', function (f, v) {
                try {
                    nameField.bindStore(v === 'group' ? groupStore : userStore);
                    nameField.setValue('');
                    nameField.setEmptyText(v === 'group'
                        ? t('pick a group') : t('pick a user'));
                } catch (e) {
                    // non-fatal
                }
            });
        }
        addWin.show();
    }

    function openPermissions(node, tree, rec) {
        if (!isFilesystem(rec)) {
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        var userStore = identityStore();
        var groupStore = identityStore();
        var namedStore = Ext.create('Ext.data.Store', {
            fields: ['kind', 'name', 'level', 'unresolved'],
            data: [],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-dataset-access',
                title: t('Permissions') + ': ' + fullName,
                modal: true,
                width: 560,
                height: 620,
                minWidth: 460,
                minHeight: 480,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        // Base three principals (mode bits) + apply-existing.
                        xtype: 'form',
                        itemId: 'baseForm',
                        border: false,
                        bodyPadding: 12,
                        items: [
                            {
                                xtype: 'fieldcontainer',
                                fieldLabel: t('Owner'),
                                labelWidth: 120,
                                anchor: '100%',
                                layout: 'hbox',
                                items: [
                                    {
                                        xtype: 'combobox',
                                        itemId: 'owner',
                                        cls: 'anas-fld-access-owner',
                                        flex: 1,
                                        store: userStore,
                                        valueField: 'name',
                                        displayField: 'name',
                                        queryMode: 'local',
                                        editable: true,
                                        forceSelection: false,
                                        emptyText: t('user'),
                                    },
                                    {
                                        xtype: 'combobox',
                                        itemId: 'ownerLevel',
                                        cls: 'anas-fld-access-owner-level',
                                        width: 150,
                                        margin: '0 0 0 8',
                                        store: accessLevelStore(),
                                        valueField: 'level',
                                        displayField: 'label',
                                        queryMode: 'local',
                                        editable: false,
                                        forceSelection: true,
                                        value: 'read-write',
                                    },
                                ],
                            },
                            {
                                xtype: 'fieldcontainer',
                                fieldLabel: t('Owning group'),
                                labelWidth: 120,
                                anchor: '100%',
                                layout: 'hbox',
                                items: [
                                    {
                                        xtype: 'combobox',
                                        itemId: 'group',
                                        cls: 'anas-fld-access-group',
                                        flex: 1,
                                        store: groupStore,
                                        valueField: 'name',
                                        displayField: 'name',
                                        queryMode: 'local',
                                        editable: true,
                                        forceSelection: false,
                                        emptyText: t('group'),
                                    },
                                    {
                                        xtype: 'combobox',
                                        itemId: 'groupLevel',
                                        cls: 'anas-fld-access-group-level',
                                        width: 150,
                                        margin: '0 0 0 8',
                                        store: accessLevelStore(),
                                        valueField: 'level',
                                        displayField: 'label',
                                        queryMode: 'local',
                                        editable: false,
                                        forceSelection: true,
                                        value: 'read',
                                    },
                                ],
                            },
                            {
                                xtype: 'fieldcontainer',
                                fieldLabel: t('Everyone'),
                                labelWidth: 120,
                                anchor: '100%',
                                layout: 'hbox',
                                items: [
                                    {
                                        xtype: 'combobox',
                                        itemId: 'everyoneLevel',
                                        cls: 'anas-fld-access-everyone-level',
                                        width: 150,
                                        store: accessLevelStore(),
                                        valueField: 'level',
                                        displayField: 'label',
                                        queryMode: 'local',
                                        editable: false,
                                        forceSelection: true,
                                        value: 'none',
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        // Named users & groups (POSIX ACL entries).
                        xtype: 'grid',
                        itemId: 'named',
                        cls: 'anas-grid-access-named',
                        title: t('Named users & groups'),
                        flex: 1,
                        margin: '0 12 0 12',
                        border: true,
                        store: namedStore,
                        selModel: { mode: 'SINGLE' },
                        plugins: [{ ptype: 'cellediting', clicksToEdit: 1 }],
                        emptyText: t('No named users or groups.'),
                        columns: [
                            {
                                text: t('Type'),
                                dataIndex: 'kind',
                                width: 90,
                                renderer: function (v) {
                                    return v === 'group' ? t('Group') : t('User');
                                },
                            },
                            {
                                text: t('Name'),
                                dataIndex: 'name',
                                flex: 1,
                                renderer: function (v, meta, rec) {
                                    var isGroup = rec && rec.get('kind') === 'group';
                                    var orphan = rec && rec.get('unresolved');
                                    if (orphan) {
                                        meta.tdCls = 'anas-cell-orphan';
                                        meta.tdAttr = 'data-qtip="'
                                            + enc(t('This id no longer resolves to a user/group — removed outside ANAS. Remove this entry to clean it up.'))
                                            + '"';
                                        return '<span style="color:#b35900;">'
                                            + principalLabel(v, true, isGroup) + '</span>';
                                    }
                                    return principalLabel(v, false, isGroup);
                                },
                            },
                            {
                                text: t('Access'),
                                dataIndex: 'level',
                                width: 150,
                                renderer: function (v) {
                                    return enc(accessLevelLabel(v));
                                },
                                editor: {
                                    xtype: 'combobox',
                                    store: accessLevelStore(),
                                    valueField: 'level',
                                    displayField: 'label',
                                    queryMode: 'local',
                                    editable: false,
                                    forceSelection: true,
                                },
                            },
                            {
                                xtype: 'widgetcolumn',
                                width: 50,
                                sortable: false,
                                menuDisabled: true,
                                widget: {
                                    xtype: 'button',
                                    cls: 'anas-btn-access-remove',
                                    iconCls: 'fa fa-times',
                                    tooltip: t('Remove'),
                                    handler: function (btn) {
                                        try {
                                            var r = btn.getWidgetRecord();
                                            if (r) { namedStore.remove(r); }
                                        } catch (e) {
                                            ANAS.warn('remove principal failed: '
                                                + ANAS.errText(e));
                                        }
                                    },
                                },
                            },
                        ],
                        tbar: [
                            {
                                text: t('Add user or group'),
                                itemId: 'addBtn',
                                cls: 'anas-btn-access-add',
                                iconCls: 'fa fa-plus',
                                handler: function () {
                                    try {
                                        openAddPrincipal(win, namedStore,
                                            userStore, groupStore,
                                            win._aclEnabled);
                                    } catch (e) {
                                        ANAS.warn('open add principal failed: '
                                            + ANAS.errText(e));
                                    }
                                },
                            },
                        ],
                    },
                    {
                        // Inline note for acl-unsupported / not-enabled states.
                        xtype: 'component',
                        itemId: 'aclNote',
                        hidden: true,
                        margin: '6 12 0 12',
                        style: 'color:#888;font-size:11px;',
                        html: '',
                    },
                    {
                        // Apply-to-existing + helptext.
                        xtype: 'container',
                        margin: '8 12 0 12',
                        items: [
                            {
                                xtype: 'checkbox',
                                itemId: 'recursive',
                                cls: 'anas-fld-access-recursive',
                                boxLabel: t('Apply to existing files too'),
                            },
                            {
                                xtype: 'component',
                                style: 'color:#888;font-size:11px;margin:2px 0 0 18px;',
                                html: enc(t('New files always inherit these settings; '
                                    + 'tick this to also update files already in the folder.')),
                            },
                        ],
                    },
                    {
                        // Advanced: read-only raw getfacl view.
                        xtype: 'panel',
                        cls: 'anas-panel-access-advanced',
                        title: t('Advanced'),
                        collapsible: true,
                        collapsed: true,
                        titleCollapse: true,
                        margin: '8 12 8 12',
                        border: true,
                        bodyPadding: 8,
                        maxHeight: 200,
                        scrollable: true,
                        items: [{
                            xtype: 'component',
                            itemId: 'aclText',
                            style: 'font-family:monospace;white-space:pre;font-size:11px;',
                            html: enc(t('No ACL entries.')),
                        }],
                    },
                ],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () { win.close(); },
                    },
                    {
                        text: t('Apply'),
                        cls: 'anas-btn-dataset-access-submit',
                        handler: function () {
                            try {
                                submitAccess(win, node, tree, pool, fullName, namedStore);
                            } catch (e) {
                                ANAS.warn('dataset access submit failed: '
                                    + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('dataset access window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        try {
            win.setLoading(true);
        } catch (e) {
            // non-fatal
        }

        var accessCall = ANAS.api.get(node, datasetPath(pool, fullName, 'access')).then(
            function (res) {
                // Reads are wrapped in { data }; tolerate a bare object too.
                return (res && res.data) ? res.data : res;
            },
            function (err) {
                ANAS.warn('dataset access load failed: ' + ANAS.errText(err));
                return null;
            });

        Promise.all([
            loadIdentity(node, '/identity/users', userStore, 'users'),
            loadIdentity(node, '/identity/groups', groupStore, 'groups'),
            accessCall,
        ]).then(function (results) {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                win.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            var acc = results[2];
            if (!acc) {
                return;
            }
            try {
                populateAccess(win, namedStore, acc);
            } catch (e) {
                ANAS.warn('populate access failed: ' + ANAS.errText(e));
            }
        });
    }

    // Fill the window's fields from a DatasetAccess payload and reflect the
    // aclSupported / aclEnabled flags into the add button + inline note.
    function populateAccess(win, namedStore, acc) {
        var entries = acc.entries || [];
        var ownerField = win.down('#owner');
        var groupField = win.down('#group');
        if (ownerField && acc.owner) { ownerField.setValue(acc.owner); }
        if (groupField && acc.group) { groupField.setValue(acc.group); }

        var ownerLevel = win.down('#ownerLevel');
        var groupLevel = win.down('#groupLevel');
        var everyoneLevel = win.down('#everyoneLevel');
        if (ownerLevel) { ownerLevel.setValue(baseEntryLevel(entries, 'owner')); }
        if (groupLevel) { groupLevel.setValue(baseEntryLevel(entries, 'owning-group')); }
        if (everyoneLevel) { everyoneLevel.setValue(baseEntryLevel(entries, 'everyone')); }

        // Named entries → grid.
        var named = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e && (e.kind === 'user' || e.kind === 'group')) {
                named.push({ kind: e.kind, name: e.name || '', level: e.level || 'none', unresolved: !!e.unresolved });
            }
        }
        namedStore.loadData(named);

        // Surface an orphaned owner/group (uid/gid deleted outside ANAS) next to
        // the pickers so a bare number isn't mistaken for a real account.
        markOrphanPicker(win.down('#owner'), baseEntryUnresolved(entries, 'owner'), false);
        markOrphanPicker(win.down('#group'), baseEntryUnresolved(entries, 'owning-group'), true);

        // Advanced: raw getfacl text (view-only).
        var aclTextCmp = win.down('#aclText');
        if (aclTextCmp) {
            var raw = acc.aclText;
            aclTextCmp.setHtml(raw ? enc(raw) : enc(t('No ACL entries.')));
        }

        // Flag-driven states.
        var supported = acc.aclSupported !== false;
        var enabled = acc.aclEnabled === true;
        win._aclEnabled = enabled;
        var addBtn = win.down('#addBtn');
        var note = win.down('#aclNote');
        if (!supported) {
            if (addBtn) { addBtn.setDisabled(true); }
            if (note) {
                note.setHtml(enc(t('Named users/groups need the acl package '
                    + '(setfacl) installed on this node.')));
                note.setHidden(false);
            }
        } else if (!enabled) {
            if (addBtn) { addBtn.setDisabled(false); }
            if (note) {
                note.setHtml(enc(t('Adding a named user or group will enable POSIX ACLs '
                    + '(acltype=posixacl) on this dataset.')));
                note.setHidden(false);
            }
        } else {
            if (addBtn) { addBtn.setDisabled(false); }
            if (note) { note.setHidden(true); }
        }
    }

    function submitAccess(win, node, tree, pool, fullName, namedStore) {
        var owner = (win.down('#owner').getValue() || '').trim();
        var group = (win.down('#group').getValue() || '').trim();
        var ownerLevel = win.down('#ownerLevel').getValue() || 'none';
        var groupLevel = win.down('#groupLevel').getValue() || 'none';
        var everyoneLevel = win.down('#everyoneLevel').getValue() || 'none';
        var applyToExisting = !!win.down('#recursive').getValue();

        // Always send the base three, then any named principals.
        var entries = [
            { kind: 'owner', level: ownerLevel },
            { kind: 'owning-group', level: groupLevel },
            { kind: 'everyone', level: everyoneLevel },
        ];
        namedStore.each(function (r) {
            var name = (r.get('name') || '').trim();
            if (!name) { return; }
            entries.push({
                kind: r.get('kind') === 'group' ? 'group' : 'user',
                name: name,
                level: r.get('level') || 'none',
            });
        });

        var body = { entries: entries, applyToExisting: applyToExisting };
        if (owner) { body.owner = owner; }
        if (group) { body.group = group; }

        ANAS.runJob({
            node: node,
            method: 'put',
            path: datasetPath(pool, fullName, 'access'),
            body: body,
            view: win,
            failTitle: 'Set permissions failed',
            successMsg: t('Permissions updated') + ': ' + fullName,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadTree(tree, node);
                reloadVisibleDetail();
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
        if (!nodes.length) {
            return;
        }
        // List a dataset's own snapshots BEFORE its child datasets — snapshots
        // belong directly to the dataset, so keeping them adjacent (above the
        // child datasets) avoids reading them as nested under a child.
        var ref = dsNode.firstChild;
        if (ref) {
            for (var j = 0; j < nodes.length; j++) {
                dsNode.insertBefore(nodes[j], ref);
            }
        } else {
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
                            // Default to a human-readable, sortable timestamp so
                            // creating a snapshot is one click; fully overridable
                            // (selectOnFocus selects it all for quick replacement).
                            value: defaultSnapName(),
                            selectOnFocus: true,
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

    // ---- Clone (story 5.7) ------------------------------------------------
    //
    // Create a new writable dataset from a snapshot (POST …/snapshots/:snap/clone
    // with { target }). The clone appears as a brand-new dataset elsewhere in the
    // tree, so onDone reloads the whole tree rather than just this dataset's
    // snapshot rows.

    // Suggest "<pool>/<lastSegment>-clone" as a starting target name.
    function suggestCloneTarget(ctx) {
        return ctx.pool + '/' + lastSegment(ctx.dataset) + '-clone';
    }

    function openCloneSnapshot(node, ctx, onDone) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-snap-clone',
                title: t('Clone Snapshot') + ': ' + ctx.fullName,
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
                            xtype: 'displayfield',
                            fieldLabel: t('Source snapshot'),
                            value: enc(ctx.fullName),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'target',
                            cls: 'anas-fld-clone-target',
                            fieldLabel: t('Target dataset name'),
                            emptyText: ctx.pool + '/restored',
                            value: suggestCloneTarget(ctx),
                            selectOnFocus: true,
                            allowBlank: false,
                        },
                    ],
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () { win.close(); },
                    },
                    {
                        text: t('Clone'),
                        cls: 'anas-btn-snap-clone-submit',
                        handler: function () {
                            try {
                                submitCloneSnapshot(win, node, ctx, onDone);
                            } catch (e) {
                                ANAS.warn('snapshot clone submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('snapshot clone window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitCloneSnapshot(win, node, ctx, onDone) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var target = (win.down('#target').getValue() || '').trim();
        if (!target) {
            alertMsg('Invalid input', t('Enter a target dataset name.'));
            return;
        }
        // Mirror CloneSnapshotRequest's shape (pool/path) so obvious mistakes are
        // caught before the round-trip; the daemon revalidates.
        if (!/^[a-z0-9_][\w.:-]*(?:\/[\w.:-]+)*$/i.test(target)) {
            alertMsg('Invalid input', t('Invalid target dataset name.'));
            return;
        }
        ANAS.runJob({
            node: node,
            method: 'post',
            path: snapshotPath(ctx.pool, ctx.dataset, ctx.snapshotName, 'clone'),
            body: { target: target },
            view: win,
            failTitle: 'Clone failed',
            successMsg: t('Snapshot cloned to') + ' ' + target,
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
            var ids = ['snapRollback', 'snapRename', 'snapClone', 'snapDestroy'];
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
                            text: t('Clone'),
                            itemId: 'snapClone',
                            cls: 'anas-btn-snap-clone',
                            iconCls: 'fa fa-copy',
                            disabled: true,
                            handler: function () {
                                var ctx = selectedSnap();
                                if (ctx) {
                                    openCloneSnapshot(node, ctx, function () {
                                        loadTree(tree, node);
                                    });
                                }
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
        } else if (kind === 'clone') {
            // A clone materialises a new dataset — reload the whole tree.
            openCloneSnapshot(node, ctx, function () {
                loadTree(tree, node);
            });
        } else if (kind === 'destroy') {
            destroySnapshotConfirm(node, ctx, onDone);
        }
    }

    // ======================================================================
    //  Epic 15.4 — enriched-tree gfx retrofit
    //
    //  The datasets view stays a native ExtJS treepanel (hierarchy, lazy
    //  loading, selection, keyboard nav, a11y come for free). We reproduce the
    //  approved spike's VISUAL LANGUAGE inside it via column renderers that emit
    //  ANAS.gfx markup, a pool-space donut hero above the tree, a pool-root row
    //  band, and PERSISTENT per-row line-icon action buttons (never hover-
    //  reveal). Everything is fail-open: a gfx gap degrades to the prior plain
    //  rendering and never breaks the tree or PVE.
    // ======================================================================

    function gfxReady() {
        return !!(ANAS && ANAS.gfx);
    }

    function fmtBytes(v) {
        try {
            return ANAS.formatBytes(v);
        } catch (e) {
            return '' + v;
        }
    }

    // Name column: draw the gfx object icon (pool vs open/closed folder) ahead
    // of the label so pool roots and datasets read distinctly. Snapshot and
    // overflow rows keep their own fa iconCls and are just html-encoded.
    function renderName(v, meta, rec) {
        var label = enc(v == null ? '' : v);
        try {
            if (!gfxReady() || typeof ANAS.gfx.objectIcon !== 'function') {
                return label;
            }
            var kind = rec.get('kind');
            if (kind === 'pool') {
                return ANAS.gfx.objectIcon('pool', { title: t('Pool') })
                    + '<span class="anas-ds-nm">' + label + '</span>';
            }
            if (kind === 'dataset') {
                var open = false;
                try {
                    open = !!(rec.isExpanded && rec.isExpanded());
                } catch (e0) {
                    open = false;
                }
                var title = rec.get('type') === 'volume' ? t('Volume') : t('Filesystem');
                return ANAS.gfx.objectIcon('folder', { open: open, title: title })
                    + '<span class="anas-ds-nm">' + label + '</span>';
            }
            return label;
        } catch (e) {
            return label;
        }
    }

    // "Space of pool" column: fraction of the owning pool's TOTAL capacity this
    // dataset occupies (used ÷ pool size), drawn as a fullness-coloured gfx bar.
    function renderSpaceOfPool(v, meta, rec) {
        try {
            if (!gfxReady() || typeof ANAS.gfx.bar !== 'function') {
                return renderBytes(rec.get('used'));
            }
            var kind = rec.get('kind');
            if (kind !== 'pool' && kind !== 'dataset') {
                return '';
            }
            var used = Number(rec.get('used'));
            var poolSize = Number(rec.get('poolSize'));
            if (!poolSize || isNaN(poolSize) || isNaN(used)) {
                return '';
            }
            var frac = used / poolSize;
            var pct = Math.round(frac * 100);
            var title = rec.get('name') + ' ' + t('uses') + ' ' + fmtBytes(used)
                + ' — ' + pct + '% ' + t('of') + ' ' + rec.get('pool')
                + ' (' + fmtBytes(poolSize) + ')';
            return ANAS.gfx.bar(frac, { title: title });
        } catch (e) {
            return '';
        }
    }

    // Best-effort snapshot count for a dataset row: counts already-loaded
    // snapshot child rows (snapshots load lazily on first expand). Returns
    // { count, more } — `more` true when a "show all" overflow row is present.
    function snapCountForRecord(rec) {
        var out = { count: 0, more: false };
        try {
            var kids = rec && rec.childNodes;
            if (!kids) {
                return out;
            }
            for (var i = 0; i < kids.length; i++) {
                var k = kids[i].get('kind');
                if (k === 'snapshot') {
                    out.count++;
                } else if (k === 'snapshots-more') {
                    out.more = true;
                }
            }
        } catch (e) {
            // fail-open
        }
        return out;
    }

    // Properties column: compression + achieved-ratio chip (highlighted when the
    // ratio pays off), a best-effort snapshot-count chip, and SMB/NFS share
    // badges. Every piece is omitted when its data is absent. Pool roots show a
    // single capacity chip. Falls back to the plain compression renderer if gfx
    // is unavailable.
    function renderDsProps(v, meta, rec) {
        try {
            if (!gfxReady() || typeof ANAS.gfx.chip !== 'function') {
                return renderCompression(v, meta, rec);
            }
            var kind = rec.get('kind');
            if (kind === 'pool') {
                var pused = Number(rec.get('used'));
                var psize = Number(rec.get('poolSize'));
                if (psize && !isNaN(pused)) {
                    return ANAS.gfx.chip(fmtBytes(pused) + ' / ' + fmtBytes(psize),
                        { title: t('Pool capacity used / total') });
                }
                return '';
            }
            if (kind !== 'dataset') {
                return '';
            }
            var parts = [];
            var comp = rec.get('compression');
            if (comp) {
                var ratio = Number(rec.get('compressratio'));
                var text = '' + comp;
                var tip = t('Compression') + ': ' + comp;
                if (ratio && ratio > 0) {
                    text += ' ' + ratio.toFixed(1) + 'x';
                    tip += ' — ' + ratio.toFixed(2) + 'x ' + t('achieved ratio');
                }
                parts.push(ANAS.gfx.chip(text, { good: ratio >= 1.5, title: tip }));
            }
            // Snapshot count (best-effort; appears once snapshots are loaded).
            var sc = snapCountForRecord(rec);
            if (sc.count > 0 && typeof ANAS.gfx.chip === 'function') {
                var slabel = sc.count + (sc.more ? '+' : '');
                parts.push(ANAS.gfx.chip('◷ ' + slabel, {
                    title: slabel + ' ' + t('snapshots'),
                }));
            }
            // Share badges — only when the row actually carries share data. The
            // flat dataset list does not include shares today (data gap), so this
            // stays dormant until the field is populated; it degrades to nothing.
            var shares = rec.get('shares');
            if (shares && shares.length && typeof ANAS.gfx.badge === 'function') {
                for (var i = 0; i < shares.length; i++) {
                    var s = shares[i] || {};
                    var proto = ('' + (s.protocol || s)).toLowerCase();
                    if (proto === 'smb' || proto === 'nfs') {
                        parts.push(ANAS.gfx.badge(proto.toUpperCase(), {
                            kind: proto,
                            title: proto === 'smb'
                                ? t('Shared over SMB') : t('Exported over NFS'),
                        }));
                    }
                }
            }
            return parts.join(' ');
        } catch (e) {
            return '';
        }
    }

    // Actions column: persistent (always-visible) gfx line-icon buttons, each
    // with a tooltip. Pool root → add (new top-level dataset) + props (root
    // filesystem). Dataset → add (child) + snapshot + share/lock (filesystems
    // only) + props + trash. Wired to the existing handlers via the tree
    // cellclick delegate below.
    function renderDsActions(v, meta, rec) {
        try {
            if (!gfxReady() || typeof ANAS.gfx.ctl !== 'function') {
                return '';
            }
            var kind = rec.get('kind');
            if (kind === 'pool') {
                return ANAS.gfx.ctl('add', t('New top-level dataset'))
                    + ANAS.gfx.ctl('props', t('Root filesystem properties'));
            }
            if (kind !== 'dataset') {
                return '';
            }
            var isFs = rec.get('type') === 'filesystem';
            var out = ANAS.gfx.ctl('add', t('New child dataset'))
                + ANAS.gfx.ctl('snapshot', t('Take snapshot'));
            if (isFs) {
                out += ANAS.gfx.ctl('share', t('Share…'))
                    + ANAS.gfx.ctl('lock', t('Permissions'));
            }
            out += ANAS.gfx.ctl('props', t('Edit properties'))
                + ANAS.gfx.ctl('trash', t('Destroy…'), { danger: true });
            return out;
        } catch (e) {
            return '';
        }
    }

    // Small SMB/NFS chooser for the per-row Share icon (mirrors the toolbar
    // submenu). Anchored at the click point; reuses shareDatasetFromTree.
    function openShareMenu(node, tree, rec, ev) {
        try {
            var menu = Ext.create('Ext.menu.Menu', {
                cls: 'anas-menu-ds-share',
                items: [
                    {
                        text: t('SMB Share…'),
                        cls: 'anas-btn-ds-share-smb',
                        iconCls: 'fa fa-windows',
                        handler: function () {
                            shareDatasetFromTree(node, tree, 'smb', rec);
                        },
                    },
                    {
                        text: t('NFS Export…'),
                        cls: 'anas-btn-ds-share-nfs',
                        iconCls: 'fa fa-hdd-o',
                        handler: function () {
                            shareDatasetFromTree(node, tree, 'nfs', rec);
                        },
                    },
                ],
            });
            if (ev && typeof ev.getXY === 'function') {
                menu.showAt(ev.getXY());
            } else {
                menu.show();
            }
        } catch (e) {
            ANAS.warn('dataset share menu failed: ' + ANAS.errText(e));
        }
    }

    // Dispatch a per-row action-icon click to the EXISTING handler for the
    // clicked record. `name` is the gfx control name (add|snapshot|share|lock|
    // props|trash). Fail-open — an unknown name or a thrown handler is swallowed.
    function dispatchRowCtl(node, tree, rec, name, ev) {
        try {
            if (!rec) {
                return;
            }
            var kind = rec.get('kind');
            if (name === 'add') {
                // openCreate seeds the parent from the record: a dataset → child,
                // the pool root → a new top-level dataset in that pool.
                openCreate(node, tree, rec);
                return;
            }
            if (kind === 'pool') {
                if (name === 'props') {
                    openEdit(node, tree, rec);
                }
                return;
            }
            if (kind !== 'dataset') {
                return;
            }
            if (name === 'snapshot') {
                var pool = rec.get('pool');
                var fullName = rec.get('fullName');
                openCreateSnapshot(node, pool, fullName, function () {
                    refreshTreeSnapshots(node, tree, pool, fullName, true);
                });
            } else if (name === 'share') {
                openShareMenu(node, tree, rec, ev);
            } else if (name === 'lock') {
                openPermissions(node, tree, rec);
            } else if (name === 'props') {
                openEdit(node, tree, rec);
            } else if (name === 'trash') {
                openDestroy(node, tree, rec);
            }
        } catch (e) {
            ANAS.warn('dataset row action failed: ' + ANAS.errText(e));
        }
    }

    // ---- Pool-space donut hero (Epic 15.4 enhancement) --------------------
    //
    // A panel above the tree showing where a pool's space goes: a gfx donut of
    // used-space by top-level dataset (+ a Free segment) with a legend, for the
    // pool of the currently-selected node (defaulting to the first pool). Scoped
    // to a single pool and fully optional — any failure hides it and leaves the
    // tree untouched.

    function poolNodeByName(tree, poolName) {
        try {
            var root = tree.getRootNode();
            var kids = root && root.childNodes;
            if (!kids) {
                return null;
            }
            for (var i = 0; i < kids.length; i++) {
                if (kids[i].get('kind') === 'pool' && kids[i].get('name') === poolName) {
                    return kids[i];
                }
            }
        } catch (e) {
            // fail-open
        }
        return null;
    }

    function firstPoolName(tree) {
        try {
            var root = tree.getRootNode();
            var kids = root && root.childNodes;
            if (kids) {
                for (var i = 0; i < kids.length; i++) {
                    if (kids[i].get('kind') === 'pool') {
                        return kids[i].get('name');
                    }
                }
            }
        } catch (e) {
            // fail-open
        }
        return null;
    }

    function buildHeroHtml(tree, poolName) {
        if (!gfxReady() || typeof ANAS.gfx.donut !== 'function') {
            return '';
        }
        var pools = tree.anasPools || {};
        var ps = pools[poolName];
        if (!ps) {
            return '';
        }
        var size = Number(ps.size) || 0;
        if (!size) {
            return '';
        }
        var allocated = Number(ps.allocated) || 0;
        var free = Number(ps.free);
        if (isNaN(free)) {
            free = Math.max(0, size - allocated);
        }
        var segs = [];
        var poolNode = poolNodeByName(tree, poolName);
        if (poolNode && poolNode.childNodes) {
            for (var i = 0; i < poolNode.childNodes.length; i++) {
                var c = poolNode.childNodes[i];
                if (c.get('kind') === 'dataset') {
                    segs.push({ label: c.get('name'), value: Number(c.get('used')) || 0 });
                }
            }
        }
        segs.push({ label: t('Free'), value: free, free: true });
        var donut = ANAS.gfx.donut(segs, {
            total: size,
            size: 150,
            center: { big: fmtBytes(allocated), sm: t('of') + ' ' + fmtBytes(size) },
        });
        var legend = ANAS.gfx.legend(segs, { total: size, format: fmtBytes });
        return '<div class="anas-ds-hero-wrap">'
            + '<div class="anas-ds-hero-donut">' + donut + '</div>'
            + '<div class="anas-ds-hero-main">'
            + '<div class="anas-ds-hero-t">' + enc(t('Pool space') + ' — ') + '<b>' + enc(poolName) + '</b></div>'
            + '<div class="anas-ds-hero-s">'
            + enc(t('How the used space breaks down across top-level datasets.')) + '</div>'
            + legend + '</div></div>';
    }

    // Recompute + update the hero for the tree's current pool focus (a selected
    // node's pool, else the first pool). Hides the hero when there is nothing to
    // show. Never throws out to the caller.
    function refreshHero(tree) {
        try {
            if (!tree || tree.destroyed || tree.destroying) {
                return;
            }
            var view = tree.up('.anas-view-datasets') || tree.up('panel');
            var hero = view && view.down('#dsHero');
            if (!hero) {
                return;
            }
            var poolName = tree.anasHeroPool || firstPoolName(tree);
            var html = poolName ? buildHeroHtml(tree, poolName) : '';
            if (html) {
                hero.update(html);
                hero.setHidden(false);
            } else {
                hero.setHidden(true);
            }
        } catch (e) {
            // Graceful — hide on any trouble.
            try {
                var v2 = tree.up('.anas-view-datasets');
                var h2 = v2 && v2.down('#dsHero');
                if (h2) { h2.setHidden(true); }
            } catch (e2) {
                // give up silently
            }
        }
    }

    // ---- View-local style injection (Epic 15.4) ---------------------------
    //
    // View-scoped chrome that is NOT part of the shared gfx layer: the pool-root
    // row band, hiding the default tree node glyph (so the gfx object icon is the
    // only Name-column icon), and hero layout. Uses gfx's own --anas-* theme
    // tokens (published on :root) so it follows the PVE light/dark theme. Injected
    // once; fail-open.
    var dsStylesInjected = false;
    function ensureDatasetStyles() {
        if (dsStylesInjected) {
            return;
        }
        try {
            var STYLE_ID = 'anas-datasets-style';
            var head = document.head || document.getElementsByTagName('head')[0]
                || document.documentElement;
            if (!head || document.getElementById(STYLE_ID)) {
                dsStylesInjected = true;
                return;
            }
            var css = [];
            // Pool-root row band: distinct tinted background + accent left edge.
            css.push('.anas-grid-datasets .anas-ds-pool-row .x-grid-cell{'
                + 'background:var(--anas-accent-soft);'
                + 'border-top:1px solid color-mix(in srgb,var(--anas-accent) 22%,var(--anas-line));'
                + 'border-bottom:1px solid color-mix(in srgb,var(--anas-accent) 22%,var(--anas-line))}');
            css.push('.anas-grid-datasets .anas-ds-pool-row .x-grid-cell-first{'
                + 'box-shadow:inset 3px 0 0 var(--anas-accent)}');
            css.push('.anas-grid-datasets .anas-ds-pool-row .anas-ds-nm{font-weight:750}');
            // Bold-ish dataset names sit a touch above muted metadata.
            css.push('.anas-grid-datasets .anas-ds-nm{margin-left:5px;vertical-align:middle}');
            // Object icon aligns with the text baseline in the Name cell.
            css.push('.anas-grid-datasets .anas-gfx-obj{vertical-align:middle}');
            // Suppress the default tree node glyph for pool/dataset rows so only
            // the gfx object icon shows (snapshot rows keep their fa icon).
            css.push('.anas-grid-datasets .anas-tree-obj{display:none!important}');
            // Actions cell: keep the persistent buttons tight and right-aligned.
            css.push('.anas-grid-datasets .anas-ds-actions-cell .x-grid-cell-inner{'
                + 'padding-top:2px;padding-bottom:2px;white-space:nowrap;text-align:right}');
            css.push('.anas-grid-datasets .anas-ds-actions-cell .anas-gfx-ctl{'
                + 'vertical-align:middle}');
            // Space-of-pool cell lets the gfx bar fill the column width.
            css.push('.anas-grid-datasets .anas-ds-space-cell .x-grid-cell-inner{'
                + 'padding-top:4px;padding-bottom:4px}');
            // Properties cell: allow chips/badges to wrap gracefully.
            css.push('.anas-grid-datasets .anas-ds-props-cell .x-grid-cell-inner{'
                + 'white-space:normal;line-height:1.9}');
            // Hero panel above the tree.
            css.push('.anas-ds-hero{padding:14px 18px;border-bottom:1px solid var(--anas-line);'
                + 'background:var(--anas-panel)}');
            css.push('.anas-ds-hero-wrap{display:flex;align-items:center;gap:22px;flex-wrap:wrap}');
            css.push('.anas-ds-hero-donut{flex:0 0 auto}');
            css.push('.anas-ds-hero-main{flex:1;min-width:240px}');
            css.push('.anas-ds-hero-t{font-weight:650;margin:0 0 3px;color:var(--anas-ink)}');
            css.push('.anas-ds-hero-s{color:var(--anas-muted);font-size:12px;margin-bottom:10px}');

            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.type = 'text/css';
            style.appendChild(document.createTextNode(css.join('\n')));
            head.appendChild(style);
            dsStylesInjected = true;
        } catch (e) {
            ANAS.warn('dataset styles injection failed: ' + ANAS.errText(e));
        }
    }

    // ---- View --------------------------------------------------------------

    function datasetsView(node) {
        // Captured at afterrender so the "Share…" submenu items (which are not
        // in the tree's component hierarchy, so btn.up('treepanel') can't reach
        // it) can resolve the tree for the current selection.
        var treeRef = null;
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
                // Epic 15.4: owning pool's total capacity (bytes) for the
                // "Space of pool" bar; optional per-row share list for badges
                // (dormant until the flat dataset feed carries it).
                { name: 'poolSize', type: 'auto' },
                { name: 'shares', type: 'auto' },
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
                text: t('Share…'),
                itemId: 'dsShare',
                cls: 'anas-btn-ds-share',
                iconCls: 'fa fa-share-alt',
                disabled: true,
                menu: [
                    {
                        text: t('SMB Share…'),
                        cls: 'anas-btn-ds-share-smb',
                        iconCls: 'fa fa-windows',
                        handler: function () {
                            shareDatasetFromTree(node, treeRef, 'smb');
                        },
                    },
                    {
                        text: t('NFS Export…'),
                        cls: 'anas-btn-ds-share-nfs',
                        iconCls: 'fa fa-hdd-o',
                        handler: function () {
                            shareDatasetFromTree(node, treeRef, 'nfs');
                        },
                    },
                ],
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
                text: t('Clone Snapshot'),
                itemId: 'snapClone',
                cls: 'anas-btn-snap-clone',
                iconCls: 'fa fa-copy',
                disabled: true,
                handler: function (btn) {
                    snapActionFromTree(node, btn.up('treepanel'), 'clone');
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

        // Inject the view-local chrome (pool band, hero layout, icon hiding)
        // up front so first paint is styled. Fail-open inside.
        ensureDatasetStyles();

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-datasets',
            title: t('Datasets'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [{
                // Epic 15.4 pool-space donut hero — sits above the tree, hidden
                // until data arrives (refreshHero populates + reveals it).
                xtype: 'component',
                itemId: 'dsHero',
                cls: 'anas-ds-hero',
                hidden: true,
                html: '',
            }, {
                xtype: 'treepanel',
                itemId: 'dsTree',
                cls: 'anas-grid-datasets',
                flex: 1,
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
                        minWidth: 220,
                        // Epic 15.4: prepend the gfx pool/folder object icon.
                        renderer: renderName,
                    },
                    {
                        text: t('Used'),
                        dataIndex: 'used',
                        width: 110,
                        align: 'right',
                        renderer: renderBytes,
                    },
                    {
                        // Epic 15.4: fraction of the pool's total capacity, as a
                        // fullness-coloured gfx bar.
                        text: t('Space of pool'),
                        dataIndex: 'used',
                        width: 190,
                        sortable: false,
                        menuDisabled: true,
                        tdCls: 'anas-ds-space-cell',
                        renderer: renderSpaceOfPool,
                    },
                    {
                        // Epic 15.4: compression/ratio + snapshot-count chips and
                        // SMB/NFS share badges (replaces the plain Compression
                        // column; the chip conveys the compressor + achieved
                        // ratio).
                        text: t('Properties'),
                        dataIndex: 'compression',
                        width: 210,
                        sortable: false,
                        menuDisabled: true,
                        tdCls: 'anas-ds-props-cell',
                        renderer: renderDsProps,
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
                        text: t('Quota'),
                        dataIndex: 'quota',
                        width: 110,
                        align: 'right',
                        renderer: renderQuota,
                    },
                    {
                        // Epic 15.4: persistent per-row action icons (add /
                        // snapshot / share / lock / props / trash). Wired to the
                        // existing handlers via the cellclick delegate below.
                        text: t('Actions'),
                        dataIndex: 'kind',
                        width: 210,
                        sortable: false,
                        menuDisabled: true,
                        tdCls: 'anas-ds-actions-cell',
                        renderer: renderDsActions,
                    },
                ],
                tbar: tbar,
                // Tag pool-root / snapshot / overflow rows for styling + hooks.
                viewConfig: {
                    getRowClass: function (record) {
                        var kind = record.get('kind');
                        if (kind === 'pool') {
                            return 'anas-ds-pool-row';
                        }
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
                        treeRef = tree;
                        loadTree(tree, node);
                    },
                    selectionchange: function (selModel, selected) {
                        updateButtons(this);
                        // Focus the donut hero on the selected node's pool.
                        try {
                            var rec = (selected && selected.length) ? selected[0] : null;
                            if (rec && rec.get('pool')) {
                                this.anasHeroPool = rec.get('pool');
                                refreshHero(this);
                            }
                        } catch (e) {
                            // hero is optional
                        }
                    },
                    // Persistent per-row action icons: delegate a click on any
                    // gfx control button to its existing handler (Epic 15.4).
                    cellclick: function (view, td, cellIndex, record, tr, rowIndex, e) {
                        try {
                            var target = e && e.target;
                            var btn = (target && target.closest)
                                ? target.closest('[data-anas-ctl]') : null;
                            if (!btn) {
                                return;
                            }
                            if (e && e.stopEvent) {
                                e.stopEvent();
                            }
                            var name = btn.getAttribute('data-anas-ctl');
                            var tree = view.up('treepanel') || view;
                            dispatchRowCtl(node, tree, record, name, e);
                        } catch (err) {
                            ANAS.warn('dataset cellclick failed: ' + ANAS.errText(err));
                        }
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
