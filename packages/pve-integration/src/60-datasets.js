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
 *   GET    /pools/:name/datasets               → { data: Dataset[], defaults? } (flat)
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
 * 'anas-btn-ds-resize' / 'anas-btn-ds-destroy', the contextual 'anas-btn-ds-share' (submenu items
 * 'anas-btn-ds-share-smb' / 'anas-btn-ds-share-nfs', Epic 6/7 — opens the
 * Shares create flow pre-filled from the dataset), windows
 * 'anas-win-dataset-create' /
 * 'anas-win-dataset-detail'. PVE-managed rows carry cls 'anas-ds-pve-row' plus
 * an 'anas-ds-pve-badge' PVE tag in the Name cell whose tooltip explains the
 * hands-off rule (story 3.25). The layered access editor (Epic 4.7.2) opens
 * 'anas-win-dataset-access' — its full test-hook list is documented in a
 * comment above openPermissions.
 *
 * Snapshots (Epic 5, GET/POST …/datasets/<path>/snapshots and
 * PUT/DELETE/…/rollback per snapshot): snapshots hang off their dataset as
 * flat leaf rows, lazy-loaded on first expand (top-5 inline; the 'anas-snap-more'
 * "show all N…" overflow row — present only past 5 — opens the 'anas-win-snapshots'
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
 * Volumes (story iscsi.3): a ZFS volume (zvol) is a dataset of another TYPE,
 * not another resource — same tree, same endpoints, same Create dialog. What
 * differs is what a block device HAS: no mountpoint, so no Share and no
 * Permissions; no recordsize/quota/atime, so no filesystem-property editor;
 * and a `volsize` that can grow but must never shrink. Hooks:
 *   tree      volume rows draw ANAS.gfx.objectIcon('volume', …) and carry
 *             labelled vol/blocks/sparse chips in the Properties cell.
 *   create    type picker 'anas-fld-ds-type' (itemId 'dsType') swaps the field
 *             set: 'anas-fld-vol-size' + 'anas-fld-vol-unit' +
 *             'anas-fld-volblocksize' + 'anas-fld-vol-sparse' for a volume,
 *             record size / quota / reservation for a filesystem. A filesystem
 *             body still carries NO `type` key, so it is byte-identical to what
 *             this dialog sent before the story (version skew).
 *   resize    toolbar 'anas-btn-ds-resize' (itemId 'dsResize') opens window
 *             'anas-win-volume-resize' — grow only, submit
 *             'anas-btn-volume-resize-submit'.
 *   gating    Edit Properties / Permissions / Share… are disabled on a volume
 *             row and each carries a tooltip saying why (VOLUME_TIPS).
 * Image-file LUNs are NOT created here — that is the iSCSI menu's job.
 *
 * Replication is NOT a Datasets-view function — it lives entirely in the
 * dedicated Replication view (65-replication.js, story 5.5.3). No replication
 * surface (toolbar button, row icon, dialog) exists in this file.
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
        return ANAS.enc(s);
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

    // Shared column definitions for the space/created fields, so the Datasets
    // tree and the snapshots popup declare them ONCE and cannot drift (same
    // dataIndex/width/renderer). Each returns a FRESH config object — ExtJS takes
    // ownership of a column config when a grid consumes it, so two grids must not
    // be handed the same instance.
    function colUsed() {
        return { text: t('Used'), dataIndex: 'used', width: 110, align: 'right', renderer: renderBytes };
    }
    function colReferenced() {
        return { text: t('Referenced'), dataIndex: 'referenced', width: 110, align: 'right', renderer: renderBytes };
    }
    function colCreated() {
        return { text: t('Created'), dataIndex: 'created', width: 150, renderer: formatCreated };
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

    function nodeFromDataset(ds, kind, poolSize, pveManaged) {
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
            // Epic 4.4 / 15.4: protocols sharing this dataset (['smb'|'nfs'])
            // and its snapshot count, from the enriched flat feed. Optional —
            // absent on older daemons, in which case the badges/chip degrade.
            sharedOver: ds.sharedOver,
            snapshotCount: ds.snapshotCount,
            // Story iscsi.3: zvol facts. Present only on `type === 'volume'`
            // rows and only from a daemon that knows about them — the renderers
            // and the toolbar all treat `undefined` as "unknown", never as 0.
            volsize: ds.volsize,
            volblocksize: ds.volblocksize,
            sparse: ds.sparse,
            // Story iscsi.6: the iSCSI LUN holding this row — the zvol itself,
            // an image file under a filesystem's mountpoint, or a child zvol.
            // Absent ⇒ undefined ⇒ nothing is gated (version-skew ruling).
            heldByLun: ds.heldByLun,
            // Total capacity of the owning pool (bytes) — feeds the "Space of
            // pool" gfx bar (Epic 15.4). Threaded from the GET /pools summary.
            poolSize: poolSize,
            // Story 3.25: does the OWNING pool have PVE storages? Threaded from
            // the pool summary so per-row renderers/handlers can gate structural
            // actions on PVE-managed datasets the same way as the pool root.
            pveManaged: !!pveManaged,
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
        node.sharedOver = ds.sharedOver;
        node.snapshotCount = ds.snapshotCount;
        node.volsize = ds.volsize;
        node.volblocksize = ds.volblocksize;
        node.sparse = ds.sparse;
    }

    // Ensure an intermediate parent node exists for parentName (defensive — in
    // practice every ZFS level is itself a dataset row, so this is rarely hit).
    function ensureParent(parentName, pool, byName, poolSize, pveManaged) {
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
            pveManaged: !!pveManaged,
            iconCls: 'anas-tree-obj',
            leaf: false,
            children: [],
        };
        byName[parentName] = node;
        var grandName = parentName.substring(0, parentName.lastIndexOf('/'));
        var grand = grandName ? ensureParent(grandName, pool, byName, poolSize, pveManaged) : byName[pool];
        if (grand) {
            grand.children.push(node);
            grand.leaf = false;
        }
        return node;
    }

    // Story 3.25: a pool is PVE-managed iff its summary carries a non-empty
    // pveStorages[] (VM/LXC/backup storages that PVE owns). Fail-open: a missing
    // or malformed field is treated as empty ⇒ ANAS-managed, keeping full
    // functionality rather than accidentally locking a pool down.
    function isPveManaged(pool) {
        try {
            var ps = pool && pool.pveStorages;
            return !!(ps && ps.length);
        } catch (e) {
            return false;
        }
    }

    function buildPoolNode(pool, datasets) {
        var byName = {};
        var poolSize = Number(pool.size) || 0;
        var pveManaged = isPveManaged(pool);
        var rootNode = {
            name: pool.name,
            fullName: pool.name,
            pool: pool.name,
            kind: 'pool',
            type: 'filesystem',
            poolSize: poolSize,
            // Story 3.25: whole-pool PVE ownership drives Thread 1 (hands-off)
            // vs Thread 2 (root fully manageable) in the row renderers/handlers.
            pveManaged: pveManaged,
            pveStorages: (pool && pool.pveStorages) || [],
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
            var node = nodeFromDataset(ds, 'dataset', poolSize, pveManaged);
            byName[ds.name] = node;
            var parentName = ds.name.substring(0, ds.name.lastIndexOf('/'));
            var parent = byName[parentName]
                || ensureParent(parentName, pool.name, byName, poolSize, pveManaged);
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

    // Pools eligible as a create target: ANAS-managed only. PVE-managed pools are
    // hands-off (story 3.25), so they must never be offered as a place to add a
    // dataset — not via the tree row (gated in openCreate) NOR via the create
    // dialog's pool picker (which would otherwise bypass the gate).
    function anasPoolNames(tree) {
        var names = [];
        try {
            var root = tree.getRootNode();
            if (root && root.childNodes) {
                for (var i = 0; i < root.childNodes.length; i++) {
                    var n = root.childNodes[i];
                    if (n.get('kind') === 'pool' && !n.get('pveManaged')) {
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
                // Story iscsi.3: the ZFS-observed default volblocksize, so the
                // Create dialog can STATE the default instead of hard-coding
                // one. Any pool that reports it answers for the node (it is a
                // ZFS-wide default, not a per-pool one); undefined when no pool
                // could attest to it, and the dialog then says so.
                try {
                    var vbd;
                    for (var d = 0; d < results.length; d++) {
                        var dflt = results[d] && results[d].defaults;
                        if (dflt && dflt.volblocksize) {
                            vbd = Number(dflt.volblocksize);
                            break;
                        }
                    }
                    tree.anasVolblocksizeDefault = vbd;
                } catch (eVbd) {
                    // non-fatal — the dialog degrades to "(ZFS default)"
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
            ANAS.alertMsg('Error', t('Failed to load pools') + ': ' + ANAS.errText(err));
        });
    }

    // Resolve to { pool, datasets } and never reject — a single pool's failure
    // must not blank the whole tree.
    function loadPoolDatasets(node, pool) {
        return ANAS.api.get(node, '/pools/' + encodeURIComponent(pool.name) + '/datasets').then(
            function (res) {
                // `defaults` (story iscsi.3) carries the ZFS-observed default
                // volblocksize. Optional and additive: an older daemon omits it
                // and the Create dialog says "(ZFS default)" with no number.
                return {
                    pool: pool,
                    datasets: (res && res.data) || [],
                    defaults: (res && res.defaults) || null,
                };
            },
            function (err) {
                ANAS.warn('datasets load failed for ' + pool.name + ': ' + ANAS.errText(err));
                return { pool: pool, datasets: [], defaults: null };
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

    // Story iscsi.3: a ZFS volume (zvol) — a dataset of another type, not
    // another kind of row. It has no mountpoint, so nothing that needs a path
    // (Share, Permissions) applies to it, and none of the filesystem
    // properties (recordsize/quota/atime) exist on it in ZFS at all.
    function isVolume(rec) {
        return isDataset(rec) && rec.get('type') === 'volume';
    }

    // Story 3.26: the pool ROOT is a first-class filesystem too. Share and
    // Permissions accept either a dataset OR the pool-root row when it is a
    // filesystem, so the root gets the full action set on ANAS-managed pools.
    function isFsShareable(rec) {
        if (!rec) {
            return false;
        }
        var kind = rec.get('kind');
        return (kind === 'dataset' || kind === 'pool') && rec.get('type') === 'filesystem';
    }

    // Story 3.25: is the row's owning pool PVE-managed? Read the boolean stamped
    // on every pool/dataset node in buildPoolNode. Fail-open ⇒ false (treat as
    // ANAS-managed, keep full functionality).
    function recPveManaged(rec) {
        try {
            return !!(rec && rec.get('pveManaged'));
        } catch (e) {
            return false;
        }
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
        // Story 3.26: the pool ROOT is a first-class dataset — some systems
        // store all data at pool level with no child datasets at all, so the
        // toolbar must work on a selected pool row too (detail, props, perms,
        // share, snapshot; NOT destroy — destroying the root ≈ the pool, a
        // Pools-view op). The root is always a filesystem (type stamped in
        // buildPoolNode).
        var root = !!(rec && rec.get('kind') === 'pool');
        var dsOrRoot = ds || root;
        var fs = isFilesystem(rec) || root;
        var snap = isSnapshot(rec);
        // Story 3.25: PVE-managed pools/datasets are hands-off. Structural
        // toolbar actions are gated alongside the primary per-row gate; only
        // read-only Detail / snapshot-listing stay enabled.
        var pve = recPveManaged(rec);
        // Story iscsi.3: a volume takes the filesystem-property editor and the
        // path-based actions OFF the toolbar and puts Resize Volume ON it. The
        // reason travels with the button as its tooltip, so a disabled control
        // still explains itself (never a dead grey button with no story).
        var vol = isVolume(rec);
        setDisabled(tree, 'dsCreate', pve);
        setDisabled(tree, 'dsDetail', !dsOrRoot);
        setDisabled(tree, 'dsEdit', !dsOrRoot || pve || vol);
        setDisabled(tree, 'dsPerms', !fs || pve);
        // Contextual "Share…" is offered on filesystem datasets only — they
        // have a mountpoint path to share (DESIGN 5a/5d). zvols cannot: a zvol
        // is a block device, and block export is the iSCSI menu's job.
        setDisabled(tree, 'dsShare', !fs || pve);
        // Story iscsi.6: an iSCSI LUN is serving this object — the daemon
        // refuses Destroy and Rollback outright (hard 409, no confirm bypass),
        // so the buttons say so instead of offering a click that cannot work.
        // A GROW is deliberately still offered: it is the supported live resize.
        var held = heldByLunOf(rec);
        var snapHeld = snap ? heldByLunOf(parentOfSnapshot(tree, rec)) : null;
        setDisabled(tree, 'dsDestroy', !ds || pve || !!held);
        // Grow — volumes only, and never on PVE's own zvols (3.25).
        setDisabled(tree, 'dsResize', !vol || pve);
        applyVolumeTips(tree, rec, vol, pve);
        applyLunHeldTips(tree, held, snapHeld);
        // Snapshot actions: create/list act on a selected dataset or the pool
        // root; the rollback/rename/destroy trio act on a selected snapshot row.
        setDisabled(tree, 'snapCreate', !dsOrRoot || pve);
        setDisabled(tree, 'snapRollback', !snap || !!snapHeld);
        setDisabled(tree, 'snapRename', !snap);
        setDisabled(tree, 'snapClone', !snap);
        setDisabled(tree, 'snapDestroy', !snap);
    }

    // Story iscsi.3 — say WHY a button is off on a volume row. The reason has
    // to ride the button itself: a toolbar that greys out three controls with no
    // explanation reads as a bug, and ExtJS keeps a disabled button's `title`
    // tooltip live. Restores each button's standing tooltip when the selection
    // moves off a volume, so the reason never lingers on a filesystem row.
    var VOLUME_TIPS = {
        dsEdit: 'Filesystem properties (record size, quota, atime) do not exist '
            + 'on a ZFS volume. Use Resize Volume to grow it.',
        dsPerms: 'A volume has no mountpoint, so it has no file permissions to edit.',
        dsShare: 'A volume is a block device with no path to share. Block export '
            + 'is the iSCSI menu, not a file share.',
    };

    // ---- Story iscsi.6: "a LUN is holding this" ---------------------------
    //
    // The daemon answers the question once, on the row (`heldByLun`), and the
    // toolbar reads the answer. It never asks per row and never re-derives the
    // rule: the field, its `detail` sentence and the 409 body all come from the
    // same `iscsiClaims()` read. ABSENT ⇒ nothing gated, which is what keeps
    // this screen working unchanged against a pre-iscsi.6 daemon.

    function heldByLunOf(rec) {
        try {
            var held = rec && rec.get ? rec.get('heldByLun') : null;
            return (held && held.targetIqn) ? held : null;
        } catch (e) {
            return null;
        }
    }

    // A snapshot row's subject is its PARENT dataset: rolling back rewrites the
    // dataset, not the snapshot, so the LUN that matters is the one holding the
    // parent.
    function parentOfSnapshot(tree, rec) {
        try {
            return (rec && rec.parentNode) ? rec.parentNode : null;
        } catch (e) {
            return null;
        }
    }

    function lunHeldTip(held, verb) {
        return ANAS.t('Disabled — ') + verb + ANAS.t(' is refused while this object is ')
            + held.detail + ANAS.t('. Delete the LUN from the iSCSI screen first, '
                + 'or delete it with "destroy the backing object" ticked.');
    }

    function applyLunHeldTips(tree, held, snapHeld) {
        try {
            setTip(tree, 'dsDestroy', held ? lunHeldTip(held, ANAS.t('Destroy')) : '');
            setTip(tree, 'snapRollback', snapHeld ? lunHeldTip(snapHeld, ANAS.t('Rollback')) : '');
        } catch (e) {
            // fail-open — a tooltip is an explanation, not a gate
        }
    }

    function setTip(tree, itemId, text) {
        try {
            var btn = tree.down('#' + itemId);
            if (!btn) {
                return;
            }
            if (typeof btn.setTooltip === 'function') {
                btn.setTooltip(text || undefined);
            }
            btn.tooltip = text || undefined;
        } catch (e) {
            // a missing tooltip never breaks the toolbar
        }
    }

    function applyVolumeTips(tree, rec, vol, pve) {
        try {
            for (var id in VOLUME_TIPS) {
                if (Object.prototype.hasOwnProperty.call(VOLUME_TIPS, id)) {
                    setTip(tree, id, vol ? t(VOLUME_TIPS[id]) : '');
                }
            }
            // Resize is the volume-only action: on any other row, say so.
            setTip(tree, 'dsResize',
                vol
                    ? (pve ? t('PVE manages this pool — its volumes are hands-off in ANAS.') : '')
                    : t('Select a ZFS volume to resize. Filesystem datasets grow '
                        + 'on demand and are bounded by their quota instead.'));
        } catch (e) {
            // fail-open — tooltips are an explanation, not a gate
        }
    }

    // ---- Contextual "Share…" (Epic 6/7, DESIGN 5d) -------------------------
    //
    // Open the unified Shares create flow pre-filled from a filesystem dataset:
    // path = the dataset's mountpoint, SMB name suggested from its last path
    // segment (overridable in the dialog). The Shares view (70-shares.js) owns
    // the create windows and is resolved lazily — it loads after this file, so
    // ANAS.shares exists by the time a user clicks. Fail-open: if it is somehow
    // absent, warn rather than throw.

    function shareDatasetFromTree(node, tree, proto) {
        // Driven by the toolbar's "Share…" submenu, so the tree selection is the
        // subject (the per-row Share icon that used to pass a record is gone —
        // toolbar-first, 2026-08-19).
        var rec = selectedRecord(tree);
        // Story 3.26: the pool root shares too (isFsShareable). Story 3.25: a
        // PVE-managed row is hands-off — soft-gate here as well as on the toolbar.
        if (!isFsShareable(rec)) {
            return;
        }
        if (recPveManaged(rec)) {
            ANAS.toast(t('PVE manages this pool — sharing is disabled in ANAS.'));
            return;
        }
        if (!ANAS.shares || typeof ANAS.shares.openSmbCreate !== 'function'
            || typeof ANAS.shares.openNfsCreate !== 'function') {
            ANAS.alertMsg('Shares unavailable', t('The Shares view is not available.'));
            return;
        }
        var mountpoint = rec.get('mountpoint');
        if (!mountpoint || mountpoint === 'none' || mountpoint === '-') {
            ANAS.alertMsg('Cannot share', t('This dataset has no mountpoint to share.'));
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

    // Common record sizes as byte values. The blank row means "send nothing":
    // on Create that is inherit-from-parent, on Edit it is leave-unchanged (ANAS
    // has no `zfs inherit` operation, so Edit must not promise one). The caller
    // supplies the label so each dialog says what its blank actually does.
    function recordsizeStore(blankLabel) {
        return [
            { value: '', label: blankLabel },
            { value: 16384, label: '16K' },
            { value: 32768, label: '32K' },
            { value: 65536, label: '64K' },
            { value: 131072, label: '128K' },
            { value: 262144, label: '256K' },
            { value: 524288, label: '512K' },
            { value: 1048576, label: '1M' },
        ];
    }

    // ---- Volume sizing (story iscsi.3) ------------------------------------
    //
    // A zvol's size is a byte COUNT on the wire (the shared VolSize schema), but
    // nobody types 2147483648. The dialogs pair a number with a unit picker and
    // do the arithmetic here, in one place, so Create and Resize can never
    // disagree about what "2 GiB" means.

    var SIZE_UNITS = [
        { value: 1048576, label: 'MiB' },
        { value: 1073741824, label: 'GiB' },
        { value: 1099511627776, label: 'TiB' },
    ];

    function sizeUnitStore() {
        return SIZE_UNITS.slice();
    }

    // Bytes → { amount, unit } using the largest unit that divides exactly, so
    // a size we round-trip comes back as the same number the user typed.
    function splitSize(bytes) {
        var n = Number(bytes) || 0;
        for (var i = SIZE_UNITS.length - 1; i >= 0; i--) {
            var u = SIZE_UNITS[i].value;
            if (n >= u && n % u === 0) {
                return { amount: n / u, unit: u };
            }
        }
        return { amount: n / SIZE_UNITS[0].value, unit: SIZE_UNITS[0].value };
    }

    // Read a #size + #unit pair back into bytes. Returns 0 on anything the
    // caller should refuse (blank, non-numeric, non-positive).
    function readSize(win) {
        try {
            var amount = Number(win.down('#size').getValue());
            var unit = Number(win.down('#unit').getValue()) || SIZE_UNITS[0].value;
            if (!amount || isNaN(amount) || amount <= 0) {
                return 0;
            }
            return Math.round(amount * unit);
        } catch (e) {
            return 0;
        }
    }

    // Volume block sizes ZFS accepts, as byte values. The blank row means "send
    // nothing" — ZFS then applies its OWN default, which is the honest choice
    // for a create-only property whose default has moved between OpenZFS
    // releases. `blankLabel` names that default when the daemon could observe
    // it, so the dialog states a fact rather than a hard-coded guess.
    function volblocksizeStore(blankLabel) {
        return [
            { value: '', label: blankLabel },
            { value: 4096, label: '4K' },
            { value: 8192, label: '8K' },
            { value: 16384, label: '16K' },
            { value: 32768, label: '32K' },
            { value: 65536, label: '64K' },
            { value: 131072, label: '128K' },
        ];
    }

    // The label for that blank row: "(ZFS default — 16K)" when the daemon told
    // us what the running ZFS actually defaults to, plain "(ZFS default)" when
    // it could not (no volume on the pool to read it from, or an older daemon
    // that does not send `defaults`). Never invents a number.
    function volblocksizeBlankLabel(bytes) {
        var n = Number(bytes);
        if (!n || isNaN(n)) {
            return t('(ZFS default)');
        }
        return t('(ZFS default') + ' — ' + ANAS.formatBytes(n) + ')';
    }

    // Make sure the Edit picker can display the dataset's CURRENT record size
    // even when it is not one of the common sizes we offer — otherwise an
    // unlisted value would render as the blank row and read as "unchanged".
    function ensureRecordsizeOption(form, bytes) {
        try {
            if (!form || !bytes) { return; }
            var field = form.findField('recordsize');
            var store = field && field.getStore && field.getStore();
            if (!store || store.findExact('value', bytes) !== -1) { return; }
            store.add({ value: bytes, label: ANAS.formatBytes(bytes) });
        } catch (e) {
            // non-fatal — the field simply shows the blank row
        }
    }

    // ---- Create Dataset (story 4.5) ----------------------------------------

    function openCreate(node, tree, rec) {
        // Story 3.25: never add a child dataset under a PVE-managed pool. Soft
        // gate — the affordance stays visible, the mutation is refused.
        if (recPveManaged(rec)) {
            ANAS.toast(t("PVE manages this pool — ANAS won't add datasets here."));
            return;
        }
        // Only ANAS-managed pools are valid create targets — a PVE pool selected
        // via the picker must not slip past the row-level gate above.
        var pools = anasPoolNames(tree);
        var defaultPool = rec ? rec.get('pool') : (pools.length ? pools[0] : '');
        if (!defaultPool) {
            ANAS.toast(t('No ANAS-managed pool is available to create a dataset.'));
            return;
        }
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

        // Story iscsi.3: the ZFS-observed default volblocksize, stashed on the
        // tree by loadTree from the dataset list's `defaults`. Undefined when
        // the daemon is older or the pool has no volume to read it from — the
        // dialog then says "(ZFS default)" with no number.
        var volblockDefault;
        try {
            volblockDefault = tree && tree.anasVolblocksizeDefault;
        } catch (eDef) {
            volblockDefault = undefined;
        }

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
                            // Story iscsi.3. A volume is a dataset of another
                            // TYPE — same endpoint, same dialog, a different
                            // field set below. Choosing it swaps the ZFS
                            // filesystem properties (which a zvol does not
                            // have) for the zvol ones.
                            xtype: 'combobox',
                            itemId: 'dsType',
                            cls: 'anas-fld-ds-type',
                            fieldLabel: t('Type'),
                            store: Ext.create('Ext.data.Store', {
                                fields: ['value', 'label'],
                                data: [
                                    { value: 'filesystem', label: t('Filesystem') },
                                    { value: 'volume', label: t('Volume (zvol — block device)') },
                                ],
                            }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: 'filesystem',
                            listeners: {
                                change: function (f) { syncCreateType(win); },
                                afterrender: function (f) { syncCreateType(win); },
                            },
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
                                data: recordsizeStore(t('(inherit)')),
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
                        // ---- Volume-only fields (hidden for a filesystem) ----
                        {
                            xtype: 'numberfield',
                            itemId: 'size',
                            cls: 'anas-fld-vol-size',
                            fieldLabel: t('Size'),
                            minValue: 0,
                            value: 8,
                            hidden: true,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'unit',
                            cls: 'anas-fld-vol-unit',
                            fieldLabel: t('Size unit'),
                            store: Ext.create('Ext.data.Store', {
                                fields: ['value', 'label'],
                                data: sizeUnitStore(),
                            }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: 1073741824,
                            hidden: true,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'volblocksize',
                            cls: 'anas-fld-volblocksize',
                            fieldLabel: t('Block size'),
                            store: Ext.create('Ext.data.Store', {
                                fields: ['value', 'label'],
                                data: volblocksizeStore(volblocksizeBlankLabel(volblockDefault)),
                            }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: '',
                            hidden: true,
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'sparse',
                            cls: 'anas-fld-vol-sparse',
                            fieldLabel: t('Sparse'),
                            boxLabel: t('Thin-provision (no reservation)'),
                            hidden: true,
                        },
                        {
                            // The honest caveat behind that checkbox: a THICK
                            // volume holds its whole size via the refreservation
                            // and never shows reclaim in `used`, so "thin" only
                            // means anything when this box is ticked.
                            xtype: 'component',
                            itemId: 'anasSparseNote',
                            hidden: true,
                            margin: '0 0 8 0',
                            style: 'color:gray;font-size:11px;',
                            html: enc(t('Block size cannot be changed after creation. '
                                + 'Without Sparse the volume reserves its full size up '
                                + 'front and never releases freed blocks back to the pool.')),
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

    // Story iscsi.3: swap the Create dialog's field set between the two dataset
    // types. Hidden AND disabled: hiding alone would leave a stale value that
    // submitCreate could still read, and the whole point is that a filesystem
    // body carries no zvol keys and a volume body carries no filesystem ones.
    var FS_ONLY_FIELDS = ['recordsize', 'quota', 'reservation'];
    var VOL_ONLY_FIELDS = ['size', 'unit', 'volblocksize', 'sparse', 'anasSparseNote'];

    function showFields(win, ids, show) {
        for (var i = 0; i < ids.length; i++) {
            var f = win.down('#' + ids[i]);
            if (!f) {
                continue;
            }
            try {
                f.setHidden(!show);
            } catch (eHide) {
                f.hidden = !show;
            }
            if (typeof f.setDisabled === 'function') {
                f.setDisabled(!show);
            }
        }
    }

    function createTypeOf(win) {
        try {
            var f = win && win.down('#dsType');
            return (f && f.getValue()) === 'volume' ? 'volume' : 'filesystem';
        } catch (e) {
            return 'filesystem';
        }
    }

    function syncCreateType(win) {
        try {
            if (!win) {
                return;
            }
            var isVol = createTypeOf(win) === 'volume';
            showFields(win, FS_ONLY_FIELDS, !isVol);
            showFields(win, VOL_ONLY_FIELDS, isVol);
        } catch (e) {
            ANAS.warn('dataset type switch failed: ' + ANAS.errText(e));
        }
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
            ANAS.alertMsg('Invalid input', t('Select a pool.'));
            return;
        }
        if (!path) {
            ANAS.alertMsg('Invalid input', t('Enter a dataset path.'));
            return;
        }
        if (!/^[\w-]+(?:\/[\w-]+)*$/.test(path)) {
            ANAS.alertMsg('Invalid input', t('Invalid dataset path.'));
            return;
        }

        var isVolume = createTypeOf(win) === 'volume';

        var props = {};
        var compression = win.down('#compression').getValue();
        if (compression) {
            props.compression = compression;
        }
        // Filesystem-only properties: ZFS does not carry recordsize or quota on
        // a zvol at all, and the shared schema refuses a body that sends them
        // with type 'volume'. Reading them only on the filesystem branch keeps
        // the two bodies disjoint by construction.
        if (!isVolume) {
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
        }

        var body = { path: path };

        if (isVolume) {
            var volsize = readSize(win);
            if (!volsize) {
                ANAS.alertMsg('Invalid input', t('Enter a volume size.'));
                return;
            }
            if (volsize < 1048576) {
                ANAS.alertMsg('Invalid input', t('A volume must be at least 1 MiB.'));
                return;
            }
            // `type` is sent ONLY for a volume, so a filesystem create is the
            // byte-identical body it was before this story — an older daemon
            // that has never heard of volumes still handles it (version skew).
            body.type = 'volume';
            body.volsize = volsize;
            var vbs = win.down('#volblocksize').getValue();
            if (vbs) {
                // Blank = send nothing = ZFS's own default. Never a hard-coded
                // number: volblocksize is create-only and the default has moved.
                body.volblocksize = Number(vbs);
            }
            if (win.down('#sparse').getValue()) {
                body.sparse = true;
            }
        }

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
            successMsg: (isVolume ? t('Volume created') : t('Dataset created'))
                + ': ' + pool + '/' + path,
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

    // Story iscsi.3: a value the daemon did not report is "unknown", which is a
    // different statement from zero. Say so rather than printing "0 B".
    function unknownOrBytes(v) {
        if (v === undefined || v === null) {
            return '<span style="color:gray;">' + enc(t('unknown')) + '</span>';
        }
        return enc(ANAS.formatBytes(v));
    }

    function usageHtml(d) {
        var isVol = d.type === 'volume';
        var rows = ''
            + kv(t('Name'), enc(d.name))
            + kv(t('Type'), enc(isVol ? t('volume (zvol)') : d.type));
        if (isVol) {
            // Story iscsi.3 — the three facts that define a zvol. `volsize` is
            // the exported size; `used` is what the pool actually spends on it,
            // which on a THICK volume is the refreservation rather than what has
            // been written, so the two are shown together and never conflated.
            rows += kv(t('Volume size (volsize)'), unknownOrBytes(d.volsize))
                + kv(t('Block size (volblocksize)'), unknownOrBytes(d.volblocksize))
                + kv(t('Provisioning'), d.sparse === undefined || d.sparse === null
                    ? '<span style="color:gray;">' + enc(t('unknown')) + '</span>'
                    : enc(d.sparse
                        ? t('sparse (thin — no refreservation)')
                        : t('thick (refreservation holds the full size)')));
        } else {
            rows += kv(t('Mountpoint'), enc(d.mountpoint || '—'));
        }
        rows += kv(t('Used'), enc(ANAS.formatBytes(d.used)))
            + kv(t('Available'), enc(ANAS.formatBytes(d.available)))
            + kv(t('Referenced'), enc(ANAS.formatBytes(d.referenced)));
        if (!isVol) {
            rows += kv(t('Quota'), dashOrBytes(d.quota));
        }
        rows += kv(t('Compression'), enc(d.compression)
            + (Number(d.compressratio) > 0
                ? ' <span class="anas-detail-compressratio">('
                    + Number(d.compressratio).toFixed(2) + 'x)</span>'
                : ''));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    // `type` decides which property rows are real: ZFS does not carry
    // recordsize, quota, refquota or atime on a volume AT ALL (verified against
    // a real zvol's `zfs get all`), so listing them there would print zeros for
    // properties that do not exist.
    function propsHtml(p, type) {
        p = p || {};
        var isVol = type === 'volume';
        var rows = '' + kv(t('compression'), enc(p.compression));
        if (!isVol) {
            rows += kv(t('recordsize'), enc(ANAS.formatBytes(p.recordsize)))
                + kv(t('quota'), dashOrBytes(p.quota))
                + kv(t('refquota'), dashOrBytes(p.refquota));
        }
        rows += kv(t('reservation'), dashOrBytes(p.reservation))
            + kv(t('refreservation'), dashOrBytes(p.refreservation));
        if (!isVol) {
            rows += kv(t('atime'), enc(ANAS.formatBool(p.atime)));
        }
        rows += kv(t('sync'), enc(p.sync))
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
        var panels = [
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
                html: propsHtml(d.properties, d.type),
            },
        ];
        // Story iscsi.3: a volume has no mountpoint, so it has neither POSIX
        // permissions nor shares. Those panels are dropped rather than shown
        // empty — an empty "Associated Shares" on a zvol invites the question
        // "how do I share it?", whose answer is the iSCSI menu, not this window.
        if (d.type !== 'volume') {
            panels.push({
                xtype: 'panel',
                title: t('Permissions'),
                bodyPadding: 10,
                border: false,
                html: permsHtml(d.permissions),
            });
            panels.push({
                xtype: 'panel',
                cls: 'anas-detail-shares',
                title: t('Associated Shares'),
                bodyPadding: 10,
                border: false,
                html: sharesHtml(d.associatedShares),
            });
        }
        content.add(panels);
    }

    function openDetail(node, rec) {
        // Accept a dataset OR the pool root: the root carries its filesystem data
        // (merged in buildPoolNode) and the daemon serves it via the empty-
        // relative-path detail endpoint — this is the read-only "View properties"
        // affordance offered on PVE-managed rows (story 3.25).
        if (!isDataset(rec) && !(rec && rec.get('kind') === 'pool')) {
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
                tbar: ANAS.tbar([
                    {
                        text: t('Reload'),
                        iconCls: 'fa fa-refresh',
                        handler: function () {
                            loadDetail();
                        },
                    },
                ]),
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
                // A picker, not a free numberfield: ZFS only accepts a power of
                // two in [512, 16M], and a BLANKED numberfield used to submit
                // recordsize=0 — which ZFS refuses, failing the edit partway
                // through (#43). The blank row is now an explicit "leave this
                // alone" choice that sends nothing at all.
                xtype: 'combobox',
                name: 'recordsize',
                cls: 'anas-fld-recordsize',
                fieldLabel: t('Record size'),
                store: Ext.create('Ext.data.Store', {
                    fields: ['value', 'label'],
                    data: recordsizeStore(t('(leave unchanged)')),
                }),
                valueField: 'value',
                displayField: 'label',
                queryMode: 'local',
                editable: false,
                forceSelection: true,
                value: '',
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
        // Story 3.25: property EDITING is disabled on PVE-managed rows (the
        // read-only Detail view is offered instead, via openDetail).
        if (recPveManaged(rec)) {
            ANAS.toast(t('PVE manages this pool — properties are read-only in ANAS.'));
            return;
        }
        // Story iscsi.3: this dialog edits FILESYSTEM properties — recordsize,
        // quota, atime — none of which ZFS carries on a zvol. Soft gate to
        // match the toolbar, pointing at the action that does apply.
        if (isVolume(rec)) {
            ANAS.toast(t('A volume has no filesystem properties — use Resize Volume to grow it.'));
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
                    // The live record size may not be one of the common sizes we
                    // offer — add a row for it so the picker shows the truth
                    // instead of falling back to a blank ("leave unchanged").
                    ensureRecordsizeOption(form, Number(p.recordsize) || 0);
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
                // '' (leave unchanged) → null, never 0: `recordsize=0` is not a
                // ZFS value, and sending it failed the edit AFTER earlier
                // properties had already been written (#43).
                var rsRaw = form.findField('recordsize').getValue();
                var recordsize = (rsRaw === '' || rsRaw === null
                    || rsRaw === undefined) ? null : Number(rsRaw);
                var current = {
                    compression: '' + (form.findField('compression').getValue() || ''),
                    recordsize: recordsize,
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
                if (current.recordsize !== null
                    && current.recordsize !== original.recordsize) {
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

    // ---- Resize Volume (story iscsi.3) ------------------------------------
    //
    // GROW only. `zfs set volsize=` is live — under an iSCSI LUN the initiator
    // simply rescans and sees the bigger disk — but ZFS will just as happily
    // SHRINK a volume, truncating it silently, with a live session and a
    // mounted filesystem on the other end. So the daemon refuses a shrink with
    // a Level 1 409 and this dialog refuses it first, saying why.
    //
    // Test hooks: window 'anas-win-volume-resize', size 'anas-fld-vol-size',
    // unit 'anas-fld-vol-unit', submit 'anas-btn-volume-resize-submit'.

    function openVolumeResize(node, tree, rec) {
        if (!isVolume(rec)) {
            return;
        }
        // Story 3.25: PVE's own zvols are hands-off, exactly like its datasets —
        // the same pool-level tag, not a second check.
        if (recPveManaged(rec)) {
            ANAS.toast(t('PVE manages this pool — its volumes are read-only in ANAS.'));
            return;
        }

        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        var current = Number(rec.get('volsize')) || 0;
        if (!current) {
            ANAS.alertMsg('Cannot resize', t('This volume\'s current size is unknown, so a grow cannot be checked against it.'));
            return;
        }
        var split = splitSize(current);

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-volume-resize',
                title: t('Resize Volume') + ': ' + fullName,
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
                            itemId: 'currentSize',
                            fieldLabel: t('Current size'),
                            value: enc(ANAS.formatBytes(current)),
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'size',
                            cls: 'anas-fld-vol-size',
                            fieldLabel: t('New size'),
                            minValue: 0,
                            value: split.amount,
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'unit',
                            cls: 'anas-fld-vol-unit',
                            fieldLabel: t('Size unit'),
                            store: Ext.create('Ext.data.Store', {
                                fields: ['value', 'label'],
                                data: sizeUnitStore(),
                            }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: split.unit,
                        },
                        {
                            xtype: 'component',
                            margin: '4 0 0 0',
                            style: 'color:gray;font-size:11px;',
                            html: enc(t('A volume can only grow. Shrinking truncates it — '
                                + 'ZFS does this silently, even while something is using the '
                                + 'device — so it is refused. Growth takes effect immediately; '
                                + 'anything using the volume has to rescan to see the new size.')),
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
                        text: t('Resize'),
                        cls: 'anas-btn-volume-resize-submit',
                        handler: function () {
                            try {
                                submitVolumeResize(win, node, tree, pool, fullName, current);
                            } catch (e) {
                                ANAS.warn('volume resize submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('volume resize window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitVolumeResize(win, node, tree, pool, fullName, current) {
        var next = readSize(win);
        if (!next) {
            ANAS.alertMsg('Invalid input', t('Enter a new size.'));
            return;
        }
        // An UNTOUCHED edit sends nothing at all — the dialog↔daemon contract:
        // reopening and saving without changing anything must not mutate the
        // volume (and must not even reach the daemon).
        if (next === current) {
            ANAS.toast(t('No changes to save'));
            win.close();
            return;
        }
        if (next < current) {
            // Refused here AND at the daemon (Principle 14 — the API is the
            // authority; this is the same refusal said early, not instead).
            ANAS.alertMsg('Cannot shrink', t('A volume can only grow.') + ' '
                + fullName + ' ' + t('is') + ' ' + ANAS.formatBytes(current) + '; '
                + ANAS.formatBytes(next) + ' ' + t('is smaller. Destroy and recreate '
                    + 'the volume to make it smaller.'));
            return;
        }

        ANAS.runJob({
            node: node,
            method: 'put',
            path: datasetPath(pool, fullName),
            body: { properties: { volsize: next } },
            view: win,
            failTitle: 'Resize failed',
            successMsg: t('Volume resized') + ': ' + fullName + ' → ' + ANAS.formatBytes(next),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadTree(tree, node);
            },
        });
    }

    // ---- Permissions: layered access editor (Epic 4.7.2) ------------------
    //
    // The base three principals (owner / owning-group / everyone) map to
    // POSIX mode bits; extra named users/groups map to POSIX
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
    //   aclDegraded === true — acltype is posixacl but getfacl failed: the
    //     levels shown are mode-bit guesses and named grants are missing, so
    //     Apply and Add are DISABLED with a note. Same rule as the failed
    //     pre-fill below: a window that doesn't know the current state never
    //     offers to replace it (#37).
    //
    // Clearing named grants is EXPLICIT (schemas/access.ts): an entries list
    // with no named rows means "unchanged". Emptying the grid sends
    // clearNamed:true, and only when the pre-fill proved there was something
    // there to remove.

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
                                    ANAS.alertMsg('Invalid input',
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
        // Story 3.26: accept the pool-root filesystem too (isFsShareable).
        if (!isFsShareable(rec)) {
            return;
        }
        // Story 3.25: PVE-managed rows are hands-off — soft-gate.
        if (recPveManaged(rec)) {
            ANAS.toast(t('PVE manages this pool — permissions are read-only in ANAS.'));
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
                                        // A blanked owner used to be accepted
                                        // and then silently dropped from the
                                        // request (#43) — refuse the gesture
                                        // instead of pretending to honour it.
                                        allowBlank: false,
                                        blankText: t('An owner is required — clear it and the '
                                            + 'change would be silently discarded.'),
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
                                        // Same as the owner picker above: blank
                                        // is refused, not quietly ignored (#43).
                                        allowBlank: false,
                                        blankText: t('An owning group is required — clear it and the '
                                            + 'change would be silently discarded.'),
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
                        tbar: ANAS.tbar([
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
                        ]),
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
                        itemId: 'applyBtn',
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

        // The pre-fill MUST fail closed. It used to warn and return null, which
        // left this window live showing hard-coded defaults over an empty named
        // grid; an Apply on that state wiped every named grant on the dataset
        // and the job reported success (#37). A window that does not know the
        // current state cannot offer to replace it.
        var accessCall = ANAS.api.get(node, datasetPath(pool, fullName, 'access')).then(
            function (res) {
                // Reads are wrapped in { data }; tolerate a bare object too.
                var data = (res && res.data) ? res.data : res;
                return data
                    ? { data: data }
                    : { error: t('The current permissions could not be read.') };
            },
            function (err) {
                ANAS.warn('dataset access load failed: ' + ANAS.errText(err));
                return { error: t('The current permissions could not be read')
                    + ': ' + ANAS.errText(err) };
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
            if (!acc || acc.error || !acc.data) {
                // Close rather than leave a live Apply over invented defaults —
                // the same shape ANAS.editWindow uses when its load fails.
                var msg = (acc && acc.error)
                    || t('The current permissions could not be read.');
                try {
                    Ext.Msg.alert(t('Error'), msg);
                } catch (e) {
                    ANAS.warn(msg);
                }
                win.close();
                return;
            }
            try {
                populateAccess(win, namedStore, acc.data);
            } catch (e) {
                ANAS.warn('populate access failed: ' + ANAS.errText(e));
                try {
                    Ext.Msg.alert(t('Error'), t('The current permissions could not be read.'));
                } catch (e2) {
                    ANAS.warn('populate access failed');
                }
                win.close();
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
        // Remember what the dataset actually had: an empty grid at submit time
        // means "remove these" ONLY if there was something here to remove. The
        // daemon never infers a clear from an empty list (#37), so the UI has to
        // say so explicitly — and can only say it because the pre-fill worked.
        win._loadedNamedCount = named.length;

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

        // The daemon read acltype=posixacl but could not read the ACL itself:
        // the levels above are a mode-bit approximation and any named grants are
        // NOT in the grid. Editing from here would be editing a guess, so the
        // window becomes read-only rather than offering a destructive Apply.
        if (acc.aclDegraded === true) {
            var applyBtn = win.down('#applyBtn');
            if (applyBtn) { applyBtn.setDisabled(true); }
            if (addBtn) { addBtn.setDisabled(true); }
            if (note) {
                note.setHtml(enc(t('POSIX ACLs are enabled on this dataset but could not be '
                    + 'read, so any named users/groups are missing from this view. '
                    + 'Permissions cannot be changed until the ACL is readable.')));
                note.setHidden(false);
            }
            return;
        }

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
        // Owner/group are allowBlank:false — a cleared picker is a refused
        // gesture, not a silently discarded one (#43).
        var baseForm = win.down('#baseForm');
        var basicForm = baseForm && baseForm.getForm && baseForm.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            ANAS.toast(t('An owner and an owning group are required.'));
            return;
        }
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
        var namedCount = 0;
        namedStore.each(function (r) {
            var name = (r.get('name') || '').trim();
            if (!name) { return; }
            namedCount++;
            entries.push({
                kind: r.get('kind') === 'group' ? 'group' : 'user',
                name: name,
                level: r.get('level') || 'none',
            });
        });

        var body = { entries: entries, applyToExisting: applyToExisting };
        if (owner) { body.owner = owner; }
        if (group) { body.group = group; }
        // Removing the last named grant is a real gesture — say it out loud.
        // The empty list alone means nothing to the daemon (#37), so only a grid
        // that we KNOW started non-empty asks for the clear.
        if (!namedCount && win._loadedNamedCount > 0) {
            body.clearNamed = true;
        }

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

    function openDestroy(node, tree, rec) {
        // Only child datasets are destroyable here. Story 3.26: the pool root is
        // NOT destroyable in the Datasets view (that ≈ destroying the pool — a
        // Pools-view op), so kind==='pool' never reaches here.
        if (!isDataset(rec)) {
            return;
        }
        // Story 3.25: PVE owns this pool — refuse destroy (soft gate).
        if (recPveManaged(rec)) {
            ANAS.toast(t('PVE manages this pool — ANAS will not destroy its datasets.'));
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        // confirmAndRun fires the unconfirmed DELETE, then on the 409 challenge
        // shows the warnings + a "Recursive" checkbox; the flag is appended to the
        // confirmed resend (the confirm code is not bound to it). A hard error
        // surfaces via failTitle.
        ANAS.confirmAndRun({
            node: node,
            method: 'del',
            path: datasetPath(pool, fullName),
            view: tree,
            failTitle: 'Destroy failed',
            successMsg: t('Destroyed') + ' ' + fullName,
            maxMs: 30000,
            onComplete: function () { loadTree(tree, node); },
            confirmWindow: true,
            confirmTitle: 'Destroy dataset',
            confirmIntro: '<b>' + enc(t('Destroy dataset') + ' "' + fullName + '"?') + '</b>',
            confirmButtonText: 'Destroy',
            confirmCls: 'anas-win-dataset-destroy',
            confirmButtonCls: 'anas-btn-dataset-destroy-confirm',
            extraItems: [{
                xtype: 'checkbox',
                itemId: 'recursive',
                cls: 'anas-chk-ds-recursive',
                boxLabel: t('Recursive (destroy children)'),
            }],
            mapConfirm: function (win) {
                return win.down('#recursive').getValue() ? { pathSuffix: '?recursive=true' } : {};
            },
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
                    // Story 3.26: the pool ROOT hosts snapshots too, so match it
                    // (kind 'pool', fullName === pool) as well as child datasets.
                    var k = n.get('kind');
                    if (!found && (k === 'dataset' || k === 'pool')
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
            ANAS.alertMsg('Invalid input', t('Enter a snapshot name.'));
            return;
        }
        if (!validSnapName(name)) {
            ANAS.alertMsg('Invalid input', t('Invalid snapshot name.'));
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

    function openRollback(node, ctx, onDone) {
        // confirmAndRun fires the unconfirmed POST, then on the 409 challenge
        // shows the warnings + an optional "force" checkbox; force is appended to
        // the confirmed resend (the code is NOT bound to it). A hard error
        // surfaces via failTitle.
        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: snapshotPath(ctx.pool, ctx.dataset, ctx.snapshotName, 'rollback'),
            body: null,
            view: ctx.view,
            failTitle: 'Rollback failed',
            successMsg: t('Rolled back to') + ' ' + ctx.fullName,
            maxMs: 30000,
            onComplete: function () { if (onDone) { onDone(); } },
            confirmWindow: true,
            confirmTitle: 'Rollback snapshot',
            confirmWidth: 480,
            confirmIntro: '<b>' + enc(t('Roll back to snapshot') + ' "' + ctx.fullName + '"?') + '</b>',
            confirmButtonText: 'Rollback',
            confirmCls: 'anas-win-snap-rollback',
            confirmButtonCls: 'anas-btn-snap-rollback-confirm',
            extraItems: [{
                xtype: 'checkbox',
                itemId: 'force',
                cls: 'anas-chk-snap-force',
                boxLabel: t('Force (-r): destroy any more-recent snapshots and bookmarks'),
            }],
            mapConfirm: function (win) {
                return win.down('#force').getValue() ? { pathSuffix: '?force=true' } : {};
            },
        });
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
            ANAS.alertMsg('Invalid input', t('Enter a new snapshot name.'));
            return;
        }
        if (!validSnapName(newName)) {
            ANAS.alertMsg('Invalid input', t('Invalid snapshot name.'));
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
            ANAS.alertMsg('Invalid input', t('Enter a target dataset name.'));
            return;
        }
        // Mirror CloneSnapshotRequest's shape (pool/path) so obvious mistakes are
        // caught before the round-trip; the daemon revalidates.
        if (!/^[a-z0-9_][\w.:-]*(?:\/[\w.:-]+)*$/i.test(target)) {
            ANAS.alertMsg('Invalid input', t('Invalid target dataset name.'));
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
                ANAS.alertMsg('Error', t('Failed to load snapshots') + ': ' + ANAS.errText(err));
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
                        colCreated(),
                        colUsed(),
                        colReferenced(),
                    ],
                    tbar: ANAS.tbar([
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
                    ]),
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
        // Story 3.26: the pool ROOT snapshots too (fullName === pool; the
        // daemon's root snapshot is non-recursive). Some systems keep all data
        // at pool level with no child datasets.
        if (!isDataset(rec) && !(rec && rec.get('kind') === 'pool')) {
            return;
        }
        if (recPveManaged(rec)) {
            ANAS.toast(t('PVE manages this pool — snapshots are PVE territory.'));
            return;
        }
        var pool = rec.get('pool');
        var fullName = rec.get('fullName');
        openCreateSnapshot(node, pool, fullName, function () {
            refreshTreeSnapshots(node, tree, pool, fullName, true);
        });
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
    //  loading, selection, keyboard nav, a11y come for free). The gfx VISUAL
    //  LANGUAGE lives inside it via column renderers that emit
    //  ANAS.gfx markup, a pool-space donut hero above the tree, and a pool-root
    //  row band. Everything is fail-open: a gfx gap degrades to the prior plain
    //  rendering and never breaks the tree or PVE.
    //
    //  Operator ruling 2026-08-19: the per-row line-icon ACTIONS COLUMN is gone.
    //  Every icon was verb-for-verb redundant with the toolbar (which already
    //  does the full PVE-managed gating in updateButtons), and this was the last
    //  row-icon surface in the UI — toolbar-first everywhere, and the column's
    //  width goes back to the Name column. The one thing the greyed icons
    //  uniquely carried, the EXPLANATION of why a PVE-managed row is hands-off,
    //  now lives in the PVE badge's tooltip in the Name cell.
    // ======================================================================

    function gfxReady() {
        return ANAS.gfx && ANAS.gfx.ready ? ANAS.gfx.ready() : false;
    }

    function fmtBytes(v) {
        try {
            return ANAS.formatBytes(v);
        } catch (e) {
            return '' + v;
        }
    }

    // Story 3.25 — the hands-off EXPLANATION. Until 2026-08-19 this lived on the
    // tooltips of the greyed per-row action icons; with that column gone (the
    // toolbar gates the same verbs), the PVE badge's tooltip is the ONE place
    // that tells the user WHY this row is untouchable. Strings are kept verbatim
    // from the removed gated controls.
    function pveHandsOffTip() {
        return t('PVE-managed storage — hands-off in ANAS.') + ' '
            + t("PVE manages this pool — ANAS won't add datasets here.") + ' '
            + t('Detail stays available, read-only.');
    }

    // The PVE tag for a managed row's Name cell — the standout hands-off marker,
    // mirroring the Mounts/Pools views' badge idiom (67-mounts.js renderMountpoint,
    // 30-pools.js renderPoolName): gfx.badge when the foundation is there, a plain
    // inline tag otherwise, and the explaining tooltip on both.
    function pveBadgeHtml() {
        var tip = pveHandsOffTip();
        var badge = '';
        try {
            if (ANAS.gfx && typeof ANAS.gfx.badge === 'function') {
                badge = ANAS.gfx.badge('PVE', { title: tip }) || '';
            }
        } catch (eB) {
            badge = '';
        }
        if (!badge) {
            badge = '<span class="anas-gfx-badge" title="' + enc(tip) + '">PVE</span>';
        }
        return ' <span class="anas-ds-pve-badge" title="' + enc(tip) + '">'
            + badge + '</span>';
    }

    // Name column: draw the gfx object icon (pool vs open/closed folder) ahead
    // of the label so pool roots and datasets read distinctly. Snapshot and
    // overflow rows keep their own fa iconCls and are just html-encoded.
    function renderName(v, meta, rec) {
        var label = enc(v == null ? '' : v);
        try {
            var kind = rec.get('kind');
            // Story 3.25: tag PVE-managed rows so they read as PVE's territory,
            // the tooltip carrying the hands-off "why". The badge survives a
            // missing gfx foundation (plain tag), so the explanation always shows.
            var pveBadge = '';
            if ((kind === 'pool' || kind === 'dataset') && recPveManaged(rec)) {
                pveBadge = pveBadgeHtml();
            }
            if (!gfxReady() || typeof ANAS.gfx.objectIcon !== 'function') {
                return label + pveBadge;
            }
            if (kind === 'pool') {
                return ANAS.gfx.objectIcon('pool', { title: t('Pool') })
                    + '<span class="anas-ds-nm">' + label + '</span>' + pveBadge;
            }
            if (kind === 'dataset') {
                // Story iscsi.3: a volume is a block device, not a container of
                // files — it gets the shared layer's own object glyph rather
                // than a folder that would misdescribe it.
                if (rec.get('type') === 'volume') {
                    return ANAS.gfx.objectIcon('volume', { title: t('Volume (zvol)') })
                        + '<span class="anas-ds-nm">' + label + '</span>' + pveBadge;
                }
                var open = false;
                try {
                    open = !!(rec.isExpanded && rec.isExpanded());
                } catch (e0) {
                    open = false;
                }
                return ANAS.gfx.objectIcon('folder', { open: open, title: t('Filesystem') })
                    + '<span class="anas-ds-nm">' + label + '</span>' + pveBadge;
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
    // ratio pays off), a snapshot-count chip (from the enriched feed's
    // snapshotCount, so it shows on collapsed rows), and SMB/NFS share badges
    // (from sharedOver). Every piece is omitted when its data is absent. Pool
    // roots show a single capacity chip. Falls back to the plain compression
    // renderer if gfx is unavailable.
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
            // Story iscsi.3: a volume's SIZE is its volsize — the number an
            // initiator sees — and it is not `used`, not `available` and not
            // `quota`, so it cannot ride any existing column. It goes here as a
            // labelled chip ("numbers carry labeled context"), together with the
            // create-only block size and whether the volume is thin or thick.
            if (rec.get('type') === 'volume') {
                var vsize = Number(rec.get('volsize'));
                if (vsize > 0) {
                    parts.push(ANAS.gfx.chip(t('vol') + ' ' + fmtBytes(vsize), {
                        title: t('Volume size (volsize) — what an initiator sees'),
                    }));
                }
                var vbs = Number(rec.get('volblocksize'));
                if (vbs > 0) {
                    parts.push(ANAS.gfx.chip(fmtBytes(vbs) + ' ' + t('blocks'), {
                        title: t('Volume block size (volblocksize) — fixed at creation'),
                    }));
                }
                var sparse = rec.get('sparse');
                if (sparse !== undefined && sparse !== null) {
                    parts.push(ANAS.gfx.chip(sparse ? t('sparse') : t('thick'), {
                        title: sparse
                            ? t('Thin-provisioned — no refreservation held')
                            : t('Thick — a refreservation holds the full size, so freed blocks never return to the pool'),
                    }));
                }
            }
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
            // Snapshot count — authoritative count from the enriched flat feed
            // (snapshotCount), so it shows even on COLLAPSED rows. Falls back to
            // the loaded-children tally on an older daemon that omits the field.
            var scount = rec.get('snapshotCount');
            var smore = false;
            if (scount === undefined || scount === null) {
                var sc = snapCountForRecord(rec);
                scount = sc.count;
                smore = sc.more;
            }
            if (Number(scount) > 0 && typeof ANAS.gfx.chip === 'function') {
                var slabel = Number(scount) + (smore ? '+' : '');
                parts.push(ANAS.gfx.chip('◷ ' + slabel, {
                    title: slabel + ' ' + t('snapshots'),
                }));
            }
            // Share badges — driven by the enriched flat feed's sharedOver list
            // (['smb'|'nfs']). Degrades to nothing when the field is absent.
            var sharedOver = rec.get('sharedOver');
            if (sharedOver && sharedOver.length && typeof ANAS.gfx.badge === 'function') {
                for (var i = 0; i < sharedOver.length; i++) {
                    var proto = ('' + (sharedOver[i] || '')).toLowerCase();
                    if (proto === 'smb' || proto === 'nfs') {
                        parts.push(ANAS.gfx.badge(proto.toUpperCase(), {
                            kind: proto,
                            title: proto === 'smb'
                                ? t('Shared over SMB') : t('Shared over NFS'),
                        }));
                    }
                }
            }
            return parts.join(' ');
        } catch (e) {
            return '';
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
            // PVE hands-off tag in the Name cell (story 3.25) — sits beside the
            // name without stretching the row.
            css.push('.anas-grid-datasets .anas-ds-pve-badge{vertical-align:middle;'
                + 'cursor:help}');
            // Space-of-pool cell lets the gfx bar fill the column width.
            css.push('.anas-grid-datasets .anas-ds-space-cell .x-grid-cell-inner{'
                + 'padding-top:4px;padding-bottom:4px}');
            // Properties cell: allow chips/badges to wrap gracefully.
            css.push('.anas-grid-datasets .anas-ds-props-cell .x-grid-cell-inner{'
                + 'white-space:normal;line-height:1.9}');
            // Story 5.8: snapshot rows read distinctly from child datasets —
            // muted italic text, a faint tinted band, and an inset accent rule
            // on the left edge so their nesting under a dataset is unambiguous.
            css.push('.anas-grid-datasets .anas-ds-snapshot-row .x-grid-cell{'
                + 'background:color-mix(in srgb,var(--anas-muted) 8%,transparent)}');
            css.push('.anas-grid-datasets .anas-ds-snapshot-row .anas-ds-nm,'
                + '.anas-grid-datasets .anas-ds-snapshot-row .x-tree-node-text{'
                + 'color:var(--anas-muted);font-style:italic}');
            // Inset accent rule on the name cell — visually tucks the snapshot
            // under its parent dataset without competing with the pool band.
            css.push('.anas-grid-datasets .anas-ds-snapshot-row .x-grid-cell-first{'
                + 'box-shadow:inset 2px 0 0 color-mix(in srgb,var(--anas-accent) 40%,transparent)}');
            // The snapshot glyph (fa clock) picks up the muted tone too.
            css.push('.anas-grid-datasets .anas-ds-snapshot-row .x-tree-icon{'
                + 'opacity:0.75}');
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
                // "Space of pool" bar.
                { name: 'poolSize', type: 'auto' },
                // Epic 4.4 / 15.4: enriched flat-feed fields — protocols sharing
                // the dataset (SMB/NFS badges) and its snapshot count (chip on
                // collapsed rows). Both optional; degrade to nothing if absent.
                { name: 'sharedOver', type: 'auto' },
                { name: 'snapshotCount', type: 'auto' },
                // Story iscsi.3: the zvol trio. 'auto' so an absent field stays
                // undefined instead of being coerced to 0/false — "this daemon
                // does not report it" and "it is zero" are different answers.
                { name: 'volsize', type: 'auto' },
                { name: 'volblocksize', type: 'auto' },
                { name: 'sparse', type: 'auto' },
                // Story 3.25: whole-pool PVE ownership, stamped on every pool +
                // dataset node so row renderers/handlers branch hands-off (PVE)
                // vs first-class-root (ANAS). pveStorages kept for future detail.
                { name: 'pveManaged', type: 'auto' },
                { name: 'pveStorages', type: 'auto' },
                // Story iscsi.6: the holding iSCSI LUN, when one is serving this
                // object. 'auto' so an old daemon's ABSENCE stays undefined and
                // gates nothing (version-skew ruling).
                { name: 'heldByLun', type: 'auto' },
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
                // Story iscsi.3 — the volume's own editor. It earns a button of
                // its own rather than overloading "Edit Properties", because it
                // is a different operation with a different gate: growth only,
                // live, and irreversible in the other direction.
                text: t('Resize Volume'),
                itemId: 'dsResize',
                cls: 'anas-btn-ds-resize',
                iconCls: 'fa fa-arrows-h',
                disabled: true,
                handler: function (btn) {
                    var tree = btn.up('treepanel');
                    openVolumeResize(node, tree, selectedRecord(tree));
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
                    colUsed(),
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
                    colReferenced(),
                    colCreated(),
                    {
                        text: t('Quota'),
                        dataIndex: 'quota',
                        width: 110,
                        align: 'right',
                        renderer: renderQuota,
                    },
                ],
                tbar: ANAS.tbar(tbar),
                // Tag pool-root / snapshot / overflow rows for styling + hooks.
                viewConfig: {
                    getRowClass: function (record) {
                        var kind = record.get('kind');
                        // Story 3.25: mark PVE-managed rows (pool + datasets) for
                        // styling and as a test hook.
                        var pve = '';
                        try {
                            if ((kind === 'pool' || kind === 'dataset')
                                && record.get('pveManaged')) {
                                pve = ' anas-ds-pve-row';
                            }
                        } catch (ePve) {
                            pve = '';
                        }
                        if (kind === 'pool') {
                            return 'anas-ds-pool-row' + pve;
                        }
                        if (kind === 'snapshot') {
                            // Story 5.8: a distinct row treatment (muted, inset,
                            // separator) so snapshots read clearly apart from
                            // child datasets. 'anas-ds-snapshot-row' is the
                            // stable test hook for that styling.
                            return 'anas-snap-row anas-ds-snapshot-row';
                        }
                        if (kind === 'snapshots-more') {
                            return 'anas-snap-more';
                        }
                        // Datasets: only a class when PVE-managed (trim leading space).
                        return pve ? pve.replace(/^\s+/, '') : '';
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
                    // Lazy-load a dataset's snapshots the first time it expands.
                    itemexpand: function (record) {
                        try {
                            // Story 3.26: the ANAS pool ROOT hosts snapshots too;
                            // lazy-load them on expand like a dataset. PVE-managed
                            // roots are hands-off, so skip them (view-only).
                            var k = record && record.get && record.get('kind');
                            if (k === 'dataset'
                                || (k === 'pool' && !recPveManaged(record))) {
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
                        // Datasets AND pool roots open detail (story 3.26 —
                        // openDetail accepts the root's empty-rel-path form).
                        if (isDataset(record) || (record && record.get('kind') === 'pool')) {
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
