/*
 * ANAS — the shared path picker (story backup2.5) and point-in-time picker.
 *
 * ONE widget, TWO backends:
 *
 *   backend 'live'    → GET  /v1/fs/browse            (the node's filesystem)
 *   backend 'archive' → POST /v1/backup/restore/browse (inside a PBS archive,
 *                        driven by `catalog shell` over a pipe on the daemon —
 *                        never a FUSE mount)
 *
 * It replaces the flat listbox the backup wizard used to open. This is PVE's own
 * idiom: an expanding tree that loads a level at a time, a breadcrumb bar above
 * it, type-ahead that jumps or filters, keyboard navigation, and a single Select.
 *
 * It is a SELECTOR, not a content browser. No previews, no downloads, no file
 * actions — that boundary was ruled on and this does not reopen it.
 *
 * FREE-FORM TYPING IS AUTHORITATIVE. The path field is the value; the tree fills
 * it in. A path the tree has never shown (a directory that does not exist yet, a
 * mount that is not up) can still be typed and selected, exactly as before — the
 * picker never becomes the only way to name a path.
 *
 * ---------------------------------------------------------------------------
 * DAEMON CONTRACT (defensive on every read — an absent field degrades, never
 * throws):
 *
 *   GET /v1/fs/browse?path=<abs>[&files=1]
 *     → { path, exists, type:'dir'|'file'|'other'|'missing',
 *         dirs:[name], files?:[name] (ONLY when files=1 was sent — absent means
 *         "not asked", never "none there"), truncated? }
 *
 *   POST /v1/backup/restore/browse { repo, ns?, snapshot, archive, path }
 *     → { verdict:'ok'|'not-found'|'permission'|'unreachable'|'error', detail?,
 *         archiveKind:'pxar'|'img'|'other', path,
 *         entries:[{ name, path, type:'dir'|'file'|'symlink'|'hardlink'|'image'
 *                    |'other', size?, modified?, mtimeZone?:'node-local',
 *                    mode?, target? }],
 *         truncated?, warnings:[] }
 *
 *   GET /v1/backup/tasks/:name/snapshots
 *   GET /v1/backup/repos/:name/groups?ns=[&group=]
 *     → { verdict, detail?, group?, snapshots:[{ snapshot, backupId, backupTime,
 *         backupTimeIso, files:[{filename, archive?, kind, size?}], size? }] }
 *
 * HARDLINK GROUPS ARE ONE UNIT. The archive backend marks a hardlink and names
 * its group's primary. Picking either name yields BOTH paths, because restoring
 * a hardlink's second name alone fails the whole restore (ground truth GT-25).
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc ? ANAS.enc(s) : ('' + (s == null ? '' : s));
    }

    function trim(v) {
        return ('' + (v == null ? '' : v)).replace(/^\s+|\s+$/g, '');
    }

    function isArray(v) {
        try {
            return Object.prototype.toString.call(v) === '[object Array]';
        } catch (e) {
            return false;
        }
    }

    function warn(msg) {
        if (ANAS.warn) {
            ANAS.warn(msg);
        }
    }

    function errText(e) {
        return ANAS.errText ? ANAS.errText(e) : ('' + e);
    }

    // The archive backend's `modified` is whatever `catalog shell` printed, and
    // `catalog shell` renders `Modify:` in the READING process's local timezone
    // with no offset — so it is the NODE's clock, not yours and not UTC
    // (live-proof F11). Said once, used by the column header and every cell.
    function nodeLocalTimeTip() {
        return t(
            'Node local time \u2014 the backup client prints this timestamp with no timezone, '
            + 'in the timezone of the node that read the archive. It is not converted, and it is not UTC.',
        );
    }

    // ======================================================================
    //  Pure path helpers — no ExtJS, no network. Exported on ANAS.picker so
    //  the contract harness can drive them directly.
    // ======================================================================

    // Join a directory and a child name. The root is '/' in both backends (the
    // archive root is '/' too), so this is one function, not two.
    function joinPath(base, name) {
        var b = trim(base) || '/';
        if (b.charAt(b.length - 1) === '/') {
            return b + name;
        }
        return b + '/' + name;
    }

    // Parent of an absolute path ('/' is its own parent).
    function parentDir(p) {
        var s = trim(p);
        if (!s || s === '/') {
            return '/';
        }
        s = s.replace(/\/+$/, '');
        var idx = s.lastIndexOf('/');
        if (idx <= 0) {
            return '/';
        }
        return s.substring(0, idx);
    }

    // Last segment of a path ('/' → '/').
    function baseName(p) {
        var s = trim(p).replace(/\/+$/, '');
        if (!s || s === '/') {
            return '/';
        }
        return s.substring(s.lastIndexOf('/') + 1);
    }

    // Collapse duplicate slashes and drop a trailing one (root survives).
    function normalizePath(p) {
        var s = trim(p);
        if (!s) {
            return '/';
        }
        s = s.replace(/\/{2,}/g, '/');
        if (s.length > 1) {
            s = s.replace(/\/+$/, '');
        }
        return s.charAt(0) === '/' ? s : ('/' + s);
    }

    // The breadcrumb trail for a path: [{label, path}], root first. Ids are
    // never truncated — the label IS the segment, whatever its length.
    function crumbs(p) {
        var path = normalizePath(p);
        var out = [{ label: '/', path: '/' }];
        if (path === '/') {
            return out;
        }
        var parts = path.split('/');
        var acc = '';
        for (var i = 1; i < parts.length; i++) {
            if (!parts[i]) {
                continue;
            }
            acc = acc + '/' + parts[i];
            out.push({ label: parts[i], path: acc });
        }
        return out;
    }

    // ======================================================================
    //  Entry normalization — both backends produce the SAME row shape
    //
    //  { name, path, type, size?, modified?, mtimeZone?, target?,
    //    expandable, selectable }
    // ======================================================================

    // The live backend's answer → rows. Directories first, then files (each
    // already sorted by the daemon); a file appears only when it was asked for.
    function entriesFromLive(data, path, mode) {
        var d = data || {};
        var dir = normalizePath(d.path || path);
        var rows = [];
        var dirs = isArray(d.dirs) ? d.dirs : [];
        var i;
        for (i = 0; i < dirs.length; i++) {
            rows.push(makeRow('' + dirs[i], joinPath(dir, dirs[i]), 'dir', mode));
        }
        // A DIRECTORY picker does not ask for files and does not show them: an
        // unpickable, unexpandable row is clutter. The guard is here as well as
        // in the request so a daemon that volunteers them changes nothing.
        if (mode === 'dir') {
            return rows;
        }
        var files = isArray(d.files) ? d.files : [];
        for (i = 0; i < files.length; i++) {
            rows.push(makeRow('' + files[i], joinPath(dir, files[i]), 'file', mode));
        }
        return rows;
    }

    // The archive backend's answer → rows. The daemon already returns folders
    // first and carries the type, so this is a straight map plus the hardlink's
    // group partner.
    function entriesFromArchive(data, path, mode) {
        var d = data || {};
        var dir = normalizePath(d.path || path);
        var entries = isArray(d.entries) ? d.entries : [];
        var rows = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i] || {};
            var name = '' + (e.name === undefined ? '' : e.name);
            var row = makeRow(name, e.path || joinPath(dir, name), e.type || 'other', mode);
            if (typeof e.size === 'number') {
                row.size = e.size;
            }
            if (e.modified) {
                row.modified = '' + e.modified;
                // The daemon marks an archive mtime as the NODE's local time
                // (the backup client prints `Modify:` with no offset at all).
                // Carried so the Modified column can LABEL it instead of
                // leaving a reader to assume UTC — live-proof F11.
                if (e.mtimeZone) {
                    row.mtimeZone = '' + e.mtimeZone;
                }
            }
            if (e.target !== undefined && e.target !== null) {
                row.target = '' + e.target;
            }
            rows.push(row);
        }
        return rows;
    }

    function makeRow(name, path, type, mode) {
        return {
            name: name,
            path: normalizePath(path),
            type: type,
            // Only a directory has a level below it. A symlink to a directory is
            // NOT expanded: the archive backend cannot follow it, and following
            // one on the live filesystem would let a picker walk out of the tree
            // it is showing.
            expandable: type === 'dir',
            selectable: isSelectable(type, mode),
        };
    }

    // What may be picked, given the caller's mode. 'image' is the whole-image
    // pseudo-entry an .img archive returns — selectable, because selecting it IS
    // the block restore's answer.
    function isSelectable(type, mode) {
        var m = mode || 'dir';
        if (type === 'dir') {
            return m === 'dir' || m === 'any';
        }
        if (type === 'other') {
            return false;
        }
        return m === 'file' || m === 'any';
    }

    /**
     * The paths ONE picked row contributes. Normally its own; for a HARDLINK,
     * its own AND its group's primary — GT-25: a hardlink's second name picked
     * alone fails the entire restore, so the two are never separable.
     *
     * The primary comes back from pbc as it printed it. An absolute target is
     * archive-absolute; a bare one is a sibling of the picked name.
     */
    function selectionFor(row) {
        var r = row || {};
        var self = normalizePath(r.path || '/');
        if (r.type !== 'hardlink' || !r.target) {
            return [self];
        }
        var target = '' + r.target;
        var primary = target.charAt(0) === '/'
            ? normalizePath(target)
            : normalizePath(joinPath(parentDir(self), target));
        if (primary === self) {
            return [self];
        }
        return [self, primary];
    }

    // A set of selected rows → the flat, de-duplicated path list a caller gets.
    // Order is the order they were picked; a hardlink's partner follows it.
    function selectionPaths(rows) {
        var seen = {};
        var out = [];
        var list = isArray(rows) ? rows : [];
        for (var i = 0; i < list.length; i++) {
            var paths = selectionFor(list[i]);
            for (var j = 0; j < paths.length; j++) {
                if (!Object.prototype.hasOwnProperty.call(seen, paths[j])) {
                    seen[paths[j]] = true;
                    out.push(paths[j]);
                }
            }
        }
        return out;
    }

    // ======================================================================
    //  Backends — each turns a directory path into a Promise of rows
    // ======================================================================

    // The live URL, built once so the harness can assert on it.
    function liveBrowseUrl(path, wantFiles) {
        return '/fs/browse?path=' + encodeURIComponent(normalizePath(path))
            + (wantFiles ? '&files=1' : '');
    }

    // The archive body, built once so the harness can assert on it. `ns` is
    // omitted entirely when absent — absent means "the repository's own", and
    // sending an empty string would mean the datastore root instead.
    function archiveBrowseBody(ctx, path) {
        var c = ctx || {};
        var body = {
            repo: c.repo,
            snapshot: c.snapshot,
            archive: c.archive,
            path: normalizePath(path),
        };
        if (c.ns) {
            body.ns = c.ns;
        }
        return body;
    }

    function makeBackend(cfg) {
        var mode = cfg.mode || 'dir';
        // The live backend only pays for a file listing when files can be picked.
        var wantFiles = mode === 'file' || mode === 'any';
        if (cfg.backend === 'archive') {
            return {
                key: 'archive',
                load: function (path) {
                    return ANAS.api.post(cfg.node, '/backup/restore/browse',
                        archiveBrowseBody(cfg.archive, path)).then(function (res) {
                        var d = (res && res.data) || {};
                        if (d.verdict && d.verdict !== 'ok') {
                            var err = new Error(d.detail || t('The archive could not be read.'));
                            err.verdict = d.verdict;
                            throw err;
                        }
                        return {
                            path: normalizePath(d.path || path),
                            rows: entriesFromArchive(d, path, mode),
                            truncated: !!d.truncated,
                            warnings: isArray(d.warnings) ? d.warnings : [],
                            // An image archive has no navigable inside; the single
                            // pseudo-entry IS the answer.
                            flat: d.archiveKind === 'img',
                        };
                    });
                },
            };
        }
        return {
            key: 'live',
            load: function (path) {
                return ANAS.api.get(cfg.node, liveBrowseUrl(path, wantFiles)).then(function (res) {
                    var d = (res && res.data) || {};
                    if (d.type !== 'dir') {
                        var err = new Error(t('Not a directory.'));
                        err.verdict = d.exists === false ? 'not-found' : 'error';
                        throw err;
                    }
                    return {
                        path: normalizePath(d.path || path),
                        rows: entriesFromLive(d, path, mode),
                        truncated: !!d.truncated,
                        warnings: [],
                        flat: false,
                    };
                });
            },
        };
    }

    // ======================================================================
    //  The window
    // ======================================================================

    function ICONS() {
        return {
            dir: 'fa fa-folder',
            file: 'fa fa-file-o',
            symlink: 'fa fa-link',
            hardlink: 'fa fa-clone',
            image: 'fa fa-hdd-o',
            other: 'fa fa-question',
        };
    }

    function rowIcon(type) {
        var map = ICONS();
        return map[type] || map.other;
    }

    function setNote(win, msg, isWarn) {
        var c = win.down('#pickerNote');
        if (!c) {
            return;
        }
        var color = isWarn ? 'var(--anas-warn,#b06a12)' : 'var(--anas-muted,gray)';
        try {
            c.update(msg
                ? '<span style="color:' + color + ';font-size:12px;">' + enc(msg) + '</span>'
                : '');
        } catch (e) {
            // non-fatal
        }
    }

    function renderCrumbs(win, path) {
        var c = win.down('#pickerCrumbs');
        if (!c) {
            return;
        }
        var trail = crumbs(path);
        var html = '';
        for (var i = 0; i < trail.length; i++) {
            if (i > 0) {
                html += '<span style="color:var(--anas-muted,gray);margin:0 4px;">/</span>';
            }
            html += '<a href="#" class="anas-crumb" data-path="' + enc(trail[i].path) + '"'
                + ' style="color:var(--anas-accent,#3468c0);text-decoration:none;">'
                + enc(trail[i].label) + '</a>';
        }
        try {
            c.update(html);
        } catch (e) {
            // non-fatal
        }
    }

    // Clear the shared tree loading mask; every loadLevel exit path needs it.
    function clearPickerLoading(win) {
        try {
            win.down('#pickerTree').setLoading(false);
        } catch (e) {
            // tree not available (window closing)
        }
    }

    // Append one level's rows under a tree node, replacing whatever was there.
    function fillNode(node, rows) {
        try {
            node.removeAll(true);
        } catch (e) {
            // a fresh node has nothing to remove
        }
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            node.appendChild({
                name: r.name,
                path: r.path,
                kind: r.type,
                size: r.size,
                modified: r.modified,
                mtimeZone: r.mtimeZone,
                target: r.target,
                selectable: r.selectable,
                leaf: !r.expandable,
                expandable: r.expandable,
                iconCls: rowIcon(r.type),
                loaded: false,
            });
        }
        node.set('loaded', true);
    }

    /**
     * Load one level into a tree node. Every failure is reported in the note
     * line and leaves the node collapsed — a picker that says why beats a picker
     * that silently shows nothing.
     *
     * Each load stamps the window's monotonic navigation counter (win._nav, U6);
     * a response that lands after a NEWER load started is dropped — filling a
     * slow directory in would show rows the breadcrumb no longer names.
     */
    function loadLevel(win, node) {
        var backend = win._backend;
        var path = node.get('path') || '/';
        var stamp = (win._nav = (win._nav || 0) + 1);
        try {
            win.down('#pickerTree').setLoading(true);
        } catch (e) {
            // non-fatal
        }
        return backend.load(path).then(function (level) {
            if (win.destroyed || win.destroying || stamp !== win._nav) {
                clearPickerLoading(win);
                return;
            }
            clearPickerLoading(win);
            fillNode(node, level.rows);
            var notes = [];
            if (level.truncated) {
                notes.push(t('list truncated'));
            }
            for (var i = 0; i < level.warnings.length; i++) {
                notes.push(level.warnings[i]);
            }
            setNote(win, notes.join(' — '), !!level.truncated);
        }, function (err) {
            if (win.destroyed || win.destroying || stamp !== win._nav) {
                clearPickerLoading(win);
                return;
            }
            clearPickerLoading(win);
            node.set('loaded', false);
            setNote(win, t('Could not read') + ' ' + path + ': ' + errText(err), true);
        });
    }

    /** Point the picker at a directory: rebuild the root, breadcrumb and field. */
    function navigate(win, path) {
        var dir = normalizePath(path);
        win._dir = dir;
        renderCrumbs(win, dir);
        var tree = win.down('#pickerTree');
        if (!tree) {
            return Promise.resolve();
        }
        var root = tree.getRootNode();
        root.set('path', dir);
        return loadLevel(win, root).then(function () {
            try {
                root.expand();
            } catch (e) {
                // non-fatal
            }
        });
    }

    /**
     * Apply the type-ahead. The field is the authoritative value, so this never
     * rewrites it — it only moves the tree to match what has been typed:
     *
     *   - a typed path in ANOTHER directory JUMPS there, then filters
     *   - a typed tail inside the current directory FILTERS and selects the
     *     first match (prefix first, then anywhere in the name)
     */
    function applyTypeAhead(win, typed) {
        var value = trim(typed);
        if (!value) {
            return;
        }
        var dir = value.charAt(value.length - 1) === '/'
            ? normalizePath(value)
            : parentDir(normalizePath(value));
        var tail = value.charAt(value.length - 1) === '/' ? '' : baseName(normalizePath(value));
        if (dir !== win._dir) {
            navigate(win, dir).then(function () {
                highlightMatch(win, tail);
            });
            return;
        }
        highlightMatch(win, tail);
    }

    /** Select the first row matching `tail` (prefix beats substring). */
    function highlightMatch(win, tail) {
        var tree = win.down('#pickerTree');
        if (!tree || !tail) {
            return null;
        }
        var lower = ('' + tail).toLowerCase();
        var root = tree.getRootNode();
        var kids = root.childNodes || [];
        var prefix = null;
        var anywhere = null;
        for (var i = 0; i < kids.length; i++) {
            var name = ('' + (kids[i].get('name') || '')).toLowerCase();
            if (!prefix && name.indexOf(lower) === 0) {
                prefix = kids[i];
            }
            if (!anywhere && name.indexOf(lower) >= 0) {
                anywhere = kids[i];
            }
        }
        var hit = prefix || anywhere;
        if (hit) {
            try {
                // suppressEvent (the third argument) — the codebase's own idiom:
                // this is the picker moving its own cursor, not the user picking,
                // and letting it fire selectionchange would write the field, which
                // would run the type-ahead again.
                tree.getSelectionModel().select(hit, false, true);
                tree.ensureVisible(hit);
            } catch (e) {
                // non-fatal — the match is advisory
            }
        }
        return hit;
    }

    /**
     * The value the picker hands back.
     *
     * SINGLE select: the path FIELD wins. Typing is first-class, so a path the
     * tree never showed is still a legitimate answer; the tree merely fills the
     * field in as you click.
     *
     * MULTI select: the checked rows, hardlink groups expanded. A typed path is
     * meaningless there (there is nothing to add it to), so the field is the
     * navigation box only.
     */
    function currentValue(win, cfg) {
        if (cfg.multiSelect) {
            // A row the caller's mode cannot take is dropped, and the note says
            // how many — silently returning it would hand the restore a path it
            // never agreed to.
            var all = win._picked || [];
            var usable = [];
            for (var i = 0; i < all.length; i++) {
                if (all[i].selectable !== false) {
                    usable.push(all[i]);
                }
            }
            if (usable.length !== all.length) {
                setNote(win, t('Some selected entries cannot be picked here and were left out.'), true);
            }
            return selectionPaths(usable);
        }
        var typed = trim(fieldValue(win));
        if (typed) {
            return normalizePath(typed);
        }
        return win._dir || '/';
    }

    function fieldValue(win) {
        try {
            var f = win.down('#pickerPath');
            return f ? f.getValue() : '';
        } catch (e) {
            return '';
        }
    }

    /**
     * Write the path field WITHOUT waking the type-ahead.
     *
     * Selecting a row fills the field, and the field's `change` drives the
     * type-ahead, which selects a row — a loop with no exit. The flag breaks it:
     * only a HUMAN keystroke moves the tree.
     */
    function setFieldValue(win, value) {
        win._silent = true;
        try {
            var f = win.down('#pickerPath');
            if (f) {
                f.setValue(value);
            }
        } catch (e) {
            // non-fatal
        } finally {
            win._silent = false;
        }
    }

    /** Row → the plain object `selectionFor` understands. */
    function rowOf(record) {
        return {
            name: record.get('name'),
            path: record.get('path'),
            type: record.get('kind'),
            target: record.get('target'),
            size: record.get('size'),
            selectable: record.get('selectable'),
        };
    }

    /**
     * Hand the value back and close. ONE place decides what Select means, so the
     * button and the ENTER key can never drift apart.
     */
    function finishSelect(win, cfg) {
        var value = currentValue(win, cfg);
        if (cfg.onSelect) {
            try {
                // The ROWS ride along as a second argument. A caller that only
                // wants paths ignores it (every pre-backup2.6 caller does), but
                // a restore has to know whether a pick was a DIRECTORY: an
                // in-place restore of a tree is confirm-gated and a single file
                // is not, and that is decided from the type, never from the
                // shape of the path.
                cfg.onSelect(value, currentRows(win, cfg));
            } catch (e) {
                warn('picker select failed: ' + errText(e));
            }
        }
        win.close();
    }

    /**
     * The rows behind the value: the checked ones in multi-select, the single
     * highlighted one otherwise. Empty when the answer was typed rather than
     * picked — a typed path has no type, and pretending otherwise would be a
     * guess.
     */
    function currentRows(win, cfg) {
        var all = win._picked || [];
        var usable = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].selectable !== false) {
                usable.push(all[i]);
            }
        }
        if (!cfg.multiSelect) {
            // Single-select hands back the FIELD, so a row only counts when it
            // is the row the field is showing.
            var typed = normalizePath(trim(fieldValue(win)) || (win._dir || '/'));
            var hit = [];
            for (var j = 0; j < usable.length; j++) {
                if (normalizePath(usable[j].path || '') === typed) {
                    hit.push(usable[j]);
                }
            }
            return hit;
        }
        return usable;
    }

    function openPathPicker(cfg) {
        var conf = cfg || {};
        var mode = conf.mode || 'dir';
        var start = normalizePath(conf.value || (conf.backend === 'archive' ? '/' : '/'));
        // A picked FILE starts the tree in its own directory — the file itself is
        // not a level.
        var startDir = (mode !== 'dir' && conf.value && conf.startInParent !== false)
            ? parentDir(start)
            : start;
        var win;

        var store;
        try {
            store = Ext.create('Ext.data.TreeStore', {
                fields: [
                    'name', 'path', 'kind', 'target', 'modified', 'mtimeZone',
                    { name: 'size', type: 'auto' },
                    { name: 'selectable', type: 'auto' },
                ],
                root: { path: startDir, expanded: false, loaded: false, children: [] },
            });
        } catch (e) {
            warn('path picker store failed: ' + errText(e));
            return null;
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-path-picker',
                title: conf.title || (mode === 'dir' ? t('Choose a directory') : t('Choose a path')),
                modal: true,
                width: 620,
                height: 520,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        // The breadcrumb bar. Every segment is a jump target; ids
                        // are never truncated.
                        xtype: 'component',
                        itemId: 'pickerCrumbs',
                        cls: 'anas-picker-crumbs',
                        padding: '8 10 2 10',
                        html: '',
                        listeners: {
                            render: function (c) {
                                c.getEl().on('click', function (ev, target) {
                                    var el = target && target.getAttribute
                                        ? target
                                        : null;
                                    if (!el || !el.getAttribute('data-path')) {
                                        return;
                                    }
                                    ev.preventDefault();
                                    navigate(win, el.getAttribute('data-path'));
                                }, null, { delegate: 'a.anas-crumb' });
                            },
                        },
                    },
                    {
                        xtype: 'fieldcontainer',
                        layout: 'hbox',
                        padding: '2 8 4 8',
                        items: [
                            {
                                // The authoritative value. Typing here is always
                                // allowed and always wins on Select.
                                xtype: 'textfield',
                                itemId: 'pickerPath',
                                cls: 'anas-fld-picker-path',
                                flex: 1,
                                selectOnFocus: true,
                                value: conf.value ? normalizePath(conf.value) : startDir,
                                emptyText: conf.emptyText || '/',
                                listeners: {
                                    specialkey: function (f, e) {
                                        if (e.getKey() !== e.ENTER) {
                                            return;
                                        }
                                        var typed = trim(f.getValue());
                                        // ENTER on a directory-shaped value goes
                                        // there; anything else jumps to its parent
                                        // and points at the tail.
                                        applyTypeAhead(win, typed || '/');
                                    },
                                    change: function (f, value) {
                                        // Type-ahead: jump / filter as you type,
                                        // debounced so a fast typist is one call.
                                        // A programmatic write (a row click) is
                                        // silent — see setFieldValue.
                                        if (win._silent) {
                                            return;
                                        }
                                        if (win._typeTimer) {
                                            clearTimeout(win._typeTimer);
                                        }
                                        win._typeTimer = setTimeout(function () {
                                            if (!win.destroyed && !win.destroying) {
                                                applyTypeAhead(win, value);
                                            }
                                        }, 250);
                                    },
                                },
                            },
                            {
                                xtype: 'button',
                                text: t('Up'),
                                cls: 'anas-btn-picker-up',
                                iconCls: 'fa fa-level-up',
                                margin: '0 0 0 6',
                                handler: function () {
                                    var up = parentDir(win._dir || '/');
                                    setFieldValue(win, up);
                                    navigate(win, up);
                                },
                            },
                        ],
                    },
                    {
                        xtype: 'component',
                        itemId: 'pickerNote',
                        padding: '0 10',
                        html: '',
                    },
                    {
                        xtype: 'treepanel',
                        itemId: 'pickerTree',
                        cls: 'anas-tree-path-picker',
                        flex: 1,
                        border: false,
                        rootVisible: false,
                        useArrows: true,
                        store: store,
                        selModel: conf.multiSelect
                            ? { selType: 'checkboxmodel', mode: 'SIMPLE' }
                            : { mode: 'SINGLE' },
                        emptyText: t('Nothing here'),
                        columns: [
                            {
                                xtype: 'treecolumn',
                                text: t('Name'),
                                dataIndex: 'name',
                                flex: 1,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v, meta, rec) {
                                    var kind = rec.get('kind');
                                    var extra = '';
                                    if (kind === 'hardlink' && rec.get('target')) {
                                        // A hardlink group is one unit — say so
                                        // rather than letting it look like a
                                        // separate file that can be picked alone.
                                        extra = ' <span style="color:var(--anas-muted,gray);">'
                                            + enc(t('hardlink of') + ' ' + rec.get('target')) + '</span>';
                                    } else if (kind === 'symlink' && rec.get('target')) {
                                        extra = ' <span style="color:var(--anas-muted,gray);">→ '
                                            + enc(rec.get('target')) + '</span>';
                                    } else if (kind === 'image') {
                                        extra = ' <span style="color:var(--anas-muted,gray);">'
                                            + enc(t('whole image')) + '</span>';
                                    }
                                    return enc(v) + extra;
                                },
                            },
                            {
                                text: t('Size'),
                                dataIndex: 'size',
                                width: 110,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v) {
                                    if (typeof v !== 'number') {
                                        return '';
                                    }
                                    return ANAS.formatBytes ? ANAS.formatBytes(v) : ('' + v);
                                },
                            },
                            {
                                // pbc prints an archive mtime with NO timezone, so
                                // it is shown exactly as it came. Nothing here
                                // invents an offset. The daemon marks it
                                // `node-local` (the catalog shell renders it in
                                // the READING process's zone — live-proof F11),
                                // and that is said in the header tooltip and on
                                // every marked cell, never guessed as UTC.
                                text: t('Modified'),
                                dataIndex: 'modified',
                                width: 190,
                                sortable: false,
                                menuDisabled: true,
                                tooltip: nodeLocalTimeTip(),
                                renderer: function (v, meta, rec) {
                                    if (!v) {
                                        return '';
                                    }
                                    if (rec && rec.get('mtimeZone') === 'node-local') {
                                        return '<span data-qtip="' + enc(nodeLocalTimeTip()) + '">'
                                            + enc(v)
                                            + ' <span style="color:var(--anas-muted,gray);font-size:0.85em;">'
                                            + enc(t('node local time')) + '</span></span>';
                                    }
                                    return enc(v);
                                },
                            },
                        ],
                        listeners: {
                            beforeitemexpand: function (rec) {
                                if (rec.get('loaded')) {
                                    return;
                                }
                                loadLevel(win, rec);
                            },
                            selectionchange: function (sm, records) {
                                win._picked = [];
                                for (var i = 0; i < records.length; i++) {
                                    win._picked.push(rowOf(records[i]));
                                }
                                if (!conf.multiSelect && records.length === 1) {
                                    // Clicking a row fills the field — the field
                                    // stays the value, the tree just types into it.
                                    setFieldValue(win, records[0].get('path'));
                                }
                            },
                            itemdblclick: function (tree, rec) {
                                if (rec.get('kind') === 'dir') {
                                    setFieldValue(win, rec.get('path'));
                                    navigate(win, rec.get('path'));
                                }
                            },
                            // Keyboard navigation: the tree's own arrow keys move
                            // and expand; ENTER is the missing verb. On a folder
                            // it descends (the double-click), on anything else it
                            // IS the Select button — a keyboard user never has to
                            // reach for the mouse to finish.
                            itemkeydown: function (tree, rec, item, index, e) {
                                if (!e || e.getKey() !== e.ENTER) {
                                    return;
                                }
                                e.stopEvent();
                                if (rec.get('kind') === 'dir' && !conf.multiSelect && (conf.mode || 'dir') !== 'dir') {
                                    setFieldValue(win, rec.get('path'));
                                    navigate(win, rec.get('path'));
                                    return;
                                }
                                setFieldValue(win, rec.get('path'));
                                finishSelect(win, conf);
                            },
                        },
                    },
                ],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: t('Select'),
                        cls: 'anas-btn-picker-select',
                        handler: function () {
                            finishSelect(win, conf);
                        },
                    },
                ],
            });
        } catch (e2) {
            warn('path picker window failed: ' + errText(e2));
            return null;
        }

        win._backend = makeBackend(conf);
        win._picked = [];
        win.show();
        navigate(win, startDir);
        return win;
    }

    // ======================================================================
    //  The point-in-time picker (ANAS.snapshotPicker)
    //
    //  Lists a TASK's snapshots (GET /v1/backup/tasks/:name/snapshots) or a
    //  repository GROUP's (GET /v1/backup/repos/:name/groups?group=…) — the
    //  task-less door for archives whose task was renamed or deleted.
    //
    //  It ships as a widget with harness coverage and NO caller yet: backup2.6
    //  is the restore flow that uses it. Building it here keeps the two pickers
    //  a matched pair rather than two half-designs written weeks apart.
    // ======================================================================

    /** The read URL for a snapshot listing, task door or repository door. */
    function snapshotListUrl(cfg) {
        var c = cfg || {};
        if (c.task) {
            return '/backup/tasks/' + encodeURIComponent(c.task) + '/snapshots';
        }
        var url = '/backup/repos/' + encodeURIComponent(c.repo) + '/groups';
        var q = [];
        if (c.ns) {
            q.push('ns=' + encodeURIComponent(c.ns));
        }
        if (c.group) {
            q.push('group=' + encodeURIComponent(c.group));
        }
        return q.length ? (url + '?' + q.join('&')) : url;
    }

    /**
     * A snapshot listing → picker rows. The daemon already sorts newest-first
     * (the client's own array is unsorted), so this preserves its order rather
     * than re-deriving one.
     *
     * Each row carries the archives that snapshot holds, so choosing a point in
     * time and choosing an archive are one screen, not two round trips.
     */
    function snapshotRows(data) {
        var d = data || {};
        var list = isArray(d.snapshots) ? d.snapshots : [];
        var rows = [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i] || {};
            var archives = [];
            var files = isArray(s.files) ? s.files : [];
            var restorable = 0;
            for (var j = 0; j < files.length; j++) {
                var f = files[j] || {};
                if (!f.archive || f.kind === 'other') {
                    continue;
                }
                archives.push({
                    archive: f.archive,
                    kind: f.kind,
                    size: typeof f.size === 'number' ? f.size : undefined,
                });
                restorable += 1;
            }
            rows.push({
                snapshot: s.snapshot,
                backupId: s.backupId,
                backupTime: s.backupTime,
                backupTimeIso: s.backupTimeIso,
                size: typeof s.size === 'number' ? s.size : undefined,
                protectedFlag: s.protected === true,
                archives: archives,
                archiveCount: restorable,
            });
        }
        return rows;
    }

    function openSnapshotPicker(cfg) {
        var conf = cfg || {};
        var win;
        var store;
        try {
            store = Ext.create('Ext.data.Store', {
                fields: [
                    'snapshot', 'backupId', 'backupTimeIso',
                    { name: 'backupTime', type: 'auto' },
                    { name: 'size', type: 'auto' },
                    { name: 'archiveCount', type: 'auto' },
                    { name: 'archives', type: 'auto' },
                    { name: 'protectedFlag', type: 'auto' },
                ],
                data: [],
            });
        } catch (e) {
            warn('snapshot picker store failed: ' + errText(e));
            return null;
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-snapshot-picker',
                title: conf.title || t('Choose a point in time'),
                modal: true,
                width: 620,
                height: 420,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'component',
                        itemId: 'snapNote',
                        padding: '8 10 4 10',
                        html: '',
                    },
                    {
                        xtype: 'gridpanel',
                        itemId: 'snapGrid',
                        cls: 'anas-grid-snapshot-picker',
                        flex: 1,
                        border: false,
                        store: store,
                        emptyText: t('No backups in this group yet'),
                        columns: [
                            {
                                text: t('Point in time'),
                                dataIndex: 'backupTimeIso',
                                flex: 1,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v, meta, rec) {
                                    // The full composed id is the tooltip — ids
                                    // are never truncated, on screen or in a hint.
                                    meta.tdAttr = 'data-qtip="' + enc(rec.get('snapshot')) + '"';
                                    return enc(v);
                                },
                            },
                            {
                                text: t('Archives'),
                                dataIndex: 'archiveCount',
                                width: 100,
                                sortable: false,
                                menuDisabled: true,
                            },
                            {
                                text: t('Size'),
                                dataIndex: 'size',
                                width: 120,
                                sortable: false,
                                menuDisabled: true,
                                renderer: function (v) {
                                    if (typeof v !== 'number') {
                                        return '';
                                    }
                                    return ANAS.formatBytes ? ANAS.formatBytes(v) : ('' + v);
                                },
                            },
                        ],
                    },
                ],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: t('Select'),
                        cls: 'anas-btn-snap-select',
                        handler: function () {
                            var rec = null;
                            try {
                                rec = win.down('#snapGrid').getSelectionModel().getSelection()[0];
                            } catch (e) {
                                rec = null;
                            }
                            if (!rec) {
                                setSnapNote(win, t('Pick a point in time first.'), true);
                                return;
                            }
                            if (conf.onSelect) {
                                try {
                                    conf.onSelect({
                                        snapshot: rec.get('snapshot'),
                                        backupTimeIso: rec.get('backupTimeIso'),
                                        archives: rec.get('archives') || [],
                                        group: win._group || '',
                                    });
                                } catch (e2) {
                                    warn('snapshot select failed: ' + errText(e2));
                                }
                            }
                            win.close();
                        },
                    },
                ],
            });
        } catch (e3) {
            warn('snapshot picker window failed: ' + errText(e3));
            return null;
        }

        win.show();
        loadSnapshots(win, conf);
        return win;
    }

    function setSnapNote(win, msg, isWarn) {
        var c = win.down('#snapNote');
        if (!c) {
            return;
        }
        var color = isWarn ? 'var(--anas-warn,#b06a12)' : 'var(--anas-muted,gray)';
        try {
            c.update(msg
                ? '<span style="color:' + color + ';font-size:12px;">' + enc(msg) + '</span>'
                : '');
        } catch (e) {
            // non-fatal
        }
    }

    function loadSnapshots(win, cfg) {
        var grid = win.down('#snapGrid');
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        return ANAS.api.get(cfg.node, snapshotListUrl(cfg)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e2) {
                // non-fatal
            }
            var d = (res && res.data) || {};
            if (d.verdict && d.verdict !== 'ok') {
                setSnapNote(win, d.detail || t('The backup server could not be read.'), true);
                return;
            }
            var rows = snapshotRows(d);
            // The listing names the GROUP it read (`<type>/<id>` on the repository
            // form) — carried so a caller that needs the identity for the RESTORE
            // body (e.g. the `lun-<serial>` mapping the unified dialog keys on)
            // does not have to re-derive it or re-read it.
            win._group = '' + (d.group || '');
            try {
                grid.getStore().loadData(rows);
            } catch (e3) {
                // non-fatal
            }
            setSnapNote(win, rows.length ? '' : t('No backups in this group yet'), false);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e4) {
                // non-fatal
            }
            setSnapNote(win, t('Could not list backups') + ': ' + errText(err), true);
        });
    }

    // ======================================================================
    //  Exports
    // ======================================================================

    ANAS.pathPicker = openPathPicker;
    ANAS.snapshotPicker = openSnapshotPicker;

    // The pure parts, exported so the dialog-contract harness can drive them
    // without an ExtJS window — the same seam every other view's helpers use.
    ANAS.picker = {
        joinPath: joinPath,
        parentDir: parentDir,
        baseName: baseName,
        normalizePath: normalizePath,
        crumbs: crumbs,
        entriesFromLive: entriesFromLive,
        entriesFromArchive: entriesFromArchive,
        isSelectable: isSelectable,
        selectionFor: selectionFor,
        selectionPaths: selectionPaths,
        liveBrowseUrl: liveBrowseUrl,
        archiveBrowseBody: archiveBrowseBody,
        makeBackend: makeBackend,
        snapshotListUrl: snapshotListUrl,
        snapshotRows: snapshotRows,
    };
}());
