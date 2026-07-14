/*
 * ANAS — unified Shares view (Epic 6/7: SMB + NFS).
 *
 * One "Shares" menu item under the ANAS section, one grid listing every share
 * across BOTH protocols. Rows are SMB shares ([name] stanzas in smb.conf) and
 * NFS exports (lines in /etc/exports), tagged by a Protocol column. A path
 * shared via SMB and NFS shows as two clearly-labeled rows (DESIGN 5d).
 *
 * Populated by merging GET /shares/smb and GET /shares/nfs client-side into
 * ShareEntry-shaped rows (packages/shared schemas/shares.ts). Toolbar:
 * + SMB Share, + NFS Export, SMB Settings (global config), plus Edit / Remove
 * dispatching on the selected row's protocol. Every mutation is a job
 * (202 + { job }) routed through ANAS.runJob; deletes go through the daemon's
 * confirmation gate (409 + X-Anas-Confirm-Code), reusing the exact challenge →
 * dialog → confirmed-DELETE flow from 60-datasets.js.
 *
 * Near-zero-typing SMB create defaults (DESIGN 5d): browseable=yes,
 * read-only=no, guest=no, a getent-backed user/@group picker for `valid users`.
 * NFS create seeds a client row with rw,sync,no_subtree_check,root_squash.
 * SMB Settings surfaces the 5c network-binding levers: interfaces +
 * bind interfaces only, alongside workgroup / server string.
 *
 * ANAS.shares.openSmbCreate / openNfsCreate are exported so 60-datasets.js can
 * offer a contextual "Share…" action pre-filled from a filesystem dataset's
 * mountpoint (this file loads after 60 in lexical concat order; the datasets
 * handler resolves ANAS.shares lazily at click time).
 *
 * Data (paths relative to /v1):
 *   GET    /shares/smb                 → { data: SmbShare[] | ShareEntry(smb)[] }
 *   GET    /shares/nfs                 → { data: NfsExport[] | ShareEntry(nfs)[] }
 *   POST   /shares/smb                 → 202 { job }  (CreateSmbShareRequest)
 *   PUT    /shares/smb/:name           → 202 { job }  (UpdateSmbShareRequest)
 *   DELETE /shares/smb/:name           → 409-confirm then 202
 *   GET    /shares/smb/global          → { data: SmbGlobalConfig }
 *   PUT    /shares/smb/global          → 202 { job }  (UpdateSmbGlobalConfigRequest)
 *   POST   /shares/nfs                 → 202 { job }  (CreateNfsExportRequest)
 *   PUT    /shares/nfs/:path           → 202 { job }  (UpdateNfsExportRequest)
 *   DELETE /shares/nfs/:path           → 409-confirm then 202
 *   GET    /identity/users             → { data: SystemUser[] }
 *   GET    /identity/groups            → { data: SystemGroup[] }
 *
 * Test hooks: view panel cls 'anas-view anas-view-shares', grid cls
 * 'anas-grid-shares', toolbar buttons 'anas-btn-smb-add' / 'anas-btn-nfs-add' /
 * 'anas-btn-smb-settings' / 'anas-btn-share-edit' / 'anas-btn-share-remove',
 * windows 'anas-win-smb-share' / 'anas-win-nfs-export' / 'anas-win-smb-settings'
 * / 'anas-win-share-remove', field hooks 'anas-fld-smb-name' /
 * 'anas-fld-smb-path' / 'anas-fld-valid-users' / 'anas-fld-hosts-allow' /
 * 'anas-fld-hosts-deny' / 'anas-fld-nfs-path' / 'anas-fld-client-spec' /
 * 'anas-fld-client-options' / 'anas-fld-workgroup' / 'anas-fld-server-string' /
 * 'anas-fld-interfaces'.
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

    // Split a free-text list (comma / whitespace separated) into a trimmed,
    // empty-filtered array — used for hosts allow/deny and NFS export options.
    function splitList(str) {
        var out = [];
        var parts = ('' + (str || '')).split(/[\s,]+/);
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].replace(/^\s+|\s+$/g, '');
            if (p) {
                out.push(p);
            }
        }
        return out;
    }

    // ---- Row normalisation -------------------------------------------------
    //
    // The daemon may return the raw schema types (SmbShare[] / NfsExport[]) or
    // the ShareEntry discriminated-union shape ({ protocol, share|export, … }).
    // Both are folded into flat grid rows carrying the original object as `raw`
    // for edit/remove dispatch.

    function normSmb(item) {
        var share;
        var active;
        if (item && item.share) {
            // ShareEntry(smb) or { share, activeConnections } wrapper.
            share = item.share;
            active = item.activeConnections;
        } else {
            // Raw SmbShare.
            share = item || {};
            active = item ? item.activeConnections : undefined;
        }
        if (active === undefined || active === null) {
            active = (share && share.connections) ? share.connections.length : 0;
        }
        return {
            protocol: 'smb',
            name: share.name,
            path: share.path,
            activeConnections: Number(active) || 0,
            raw: share,
        };
    }

    function normNfs(item) {
        var exp;
        if (item && item['export']) {
            // ShareEntry(nfs) shape.
            exp = item['export'];
        } else {
            // Raw NfsExport.
            exp = item || {};
        }
        return {
            protocol: 'nfs',
            name: exp.path,
            path: exp.path,
            activeConnections: null,
            raw: exp,
        };
    }

    // ---- Renderers ---------------------------------------------------------

    function renderProtocol(v) {
        var proto = ('' + v).toUpperCase();
        var color = v === 'smb' ? '#3468c0' : '#8a2be2';
        return '<span class="anas-badge anas-badge-' + enc(v) + '"'
            + ' style="display:inline-block;padding:1px 8px;border-radius:3px;'
            + 'color:#fff;font-size:0.85em;background:' + color + ';">'
            + enc(proto) + '</span>';
    }

    // Key attributes summary. SMB: read-only/guest/valid-users; NFS: client
    // count plus a preview of the client specs.
    function renderAttrs(v, meta, rec) {
        var proto = rec.get('protocol');
        var raw = rec.get('raw') || {};
        var parts = [];
        if (proto === 'smb') {
            parts.push(raw.readOnly ? t('read-only') : t('read-write'));
            if (raw.guestOk) {
                parts.push(t('guest'));
            }
            var vu = raw.validUsers || [];
            if (vu.length) {
                parts.push(t('users') + ': ' + vu.join(', '));
            } else if (!raw.guestOk) {
                parts.push(t('any authenticated'));
            }
            var ha = raw.hostsAllow || [];
            if (ha.length) {
                parts.push(t('allow') + ': ' + ha.join(', '));
            }
            return enc(parts.join(' · '));
        }
        var clients = raw.clients || [];
        var specs = [];
        for (var i = 0; i < clients.length; i++) {
            specs.push(clients[i].spec);
        }
        var n = clients.length;
        var label = n + ' ' + (n === 1 ? t('client') : t('clients'));
        if (specs.length) {
            label += ': ' + specs.join(', ');
        }
        return enc(label);
    }

    // Active SMB connection count (from smbstatus, via activeConnections). NFS
    // has no live per-export connection concept — show a dash.
    function renderActive(v, meta, rec) {
        if (rec.get('protocol') !== 'smb') {
            return '<span style="color:#888;">&mdash;</span>';
        }
        var n = Number(rec.get('activeConnections')) || 0;
        if (n > 0) {
            return '<b style="color:#21BF4B;">' + n + '</b>';
        }
        return enc('' + n);
    }

    // ---- Selection + button state -----------------------------------------

    function selectedShare(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function setDisabled(grid, itemId, disabled) {
        var btn = grid.down('#' + itemId);
        if (btn) {
            btn.setDisabled(!!disabled);
        }
    }

    function updateShareButtons(grid) {
        var has = !!selectedShare(grid);
        setDisabled(grid, 'shareEdit', !has);
        setDisabled(grid, 'shareRemove', !has);
    }

    // ---- Load --------------------------------------------------------------

    function loadShares(grid, node) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        var smbCall = ANAS.api.get(node, '/shares/smb').then(function (res) {
            return (res && res.data) || [];
        }, function (err) {
            ANAS.warn('smb shares load failed: ' + ANAS.errText(err));
            return [];
        });
        var nfsCall = ANAS.api.get(node, '/shares/nfs').then(function (res) {
            return (res && res.data) || [];
        }, function (err) {
            ANAS.warn('nfs exports load failed: ' + ANAS.errText(err));
            return [];
        });
        Promise.all([smbCall, nfsCall]).then(function (results) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            var rows = [];
            var smb = results[0] || [];
            var nfs = results[1] || [];
            var i;
            for (i = 0; i < smb.length; i++) {
                rows.push(normSmb(smb[i]));
            }
            for (i = 0; i < nfs.length; i++) {
                rows.push(normNfs(nfs[i]));
            }
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('shares store load failed: ' + ANAS.errText(e2));
            }
            updateShareButtons(grid);
        });
    }

    // ---- getent-backed user/@group picker ----------------------------------

    // Load system users (name) and groups (as '@name') into a single store so a
    // multi-value picker can offer both for SMB `valid users` (DESIGN 5d).
    function loadShareIdentity(node, store) {
        var data = [];
        var usersCall = ANAS.api.get(node, '/identity/users').then(function (res) {
            var rows = (res && res.data) || [];
            for (var i = 0; i < rows.length; i++) {
                data.push({ name: rows[i].name });
            }
        }, function (err) {
            ANAS.warn('users load failed: ' + ANAS.errText(err));
        });
        var groupsCall = ANAS.api.get(node, '/identity/groups').then(function (res) {
            var rows = (res && res.data) || [];
            for (var i = 0; i < rows.length; i++) {
                data.push({ name: '@' + rows[i].name });
            }
        }, function (err) {
            ANAS.warn('groups load failed: ' + ANAS.errText(err));
        });
        return Promise.all([usersCall, groupsCall]).then(function () {
            if (store && !store.destroyed) {
                store.loadData(data);
            }
        });
    }

    // ---- SMB share create / edit ------------------------------------------

    function openSmbShareWindow(node, existing, preset, onDone) {
        var isEdit = !!existing;
        preset = preset || {};
        var userGroupStore = Ext.create('Ext.data.Store', {
            fields: ['name'],
            data: [],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-smb-share',
                title: isEdit
                    ? t('Edit SMB Share') + ': ' + existing.name
                    : t('Add SMB Share'),
                modal: true,
                width: 540,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    scrollable: true,
                    defaults: { anchor: '100%', labelWidth: 160 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'name',
                            cls: 'anas-fld-smb-name',
                            fieldLabel: t('Share name'),
                            emptyText: 'media',
                            allowBlank: false,
                            readOnly: isEdit,
                            value: isEdit ? existing.name : (preset.name || ''),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'path',
                            cls: 'anas-fld-smb-path',
                            fieldLabel: t('Path'),
                            emptyText: '/tank/media',
                            allowBlank: false,
                            value: isEdit ? existing.path : (preset.path || ''),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'comment',
                            cls: 'anas-fld-smb-comment',
                            fieldLabel: t('Comment'),
                            value: isEdit ? (existing.comment || '') : '',
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'browseable',
                            fieldLabel: t('Browseable'),
                            boxLabel: t('Visible in network browse lists'),
                            checked: isEdit ? !!existing.browseable : true,
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'readOnly',
                            fieldLabel: t('Read-only'),
                            boxLabel: t('Reject writes to this share'),
                            checked: isEdit ? !!existing.readOnly : false,
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'guestOk',
                            fieldLabel: t('Guest access'),
                            boxLabel: t('Allow access without authentication'),
                            checked: isEdit ? !!existing.guestOk : false,
                        },
                        {
                            xtype: 'tagfield',
                            itemId: 'validUsers',
                            cls: 'anas-fld-valid-users',
                            fieldLabel: t('Valid users'),
                            store: userGroupStore,
                            displayField: 'name',
                            valueField: 'name',
                            queryMode: 'local',
                            filterPickList: true,
                            forceSelection: false,
                            createNewOnEnter: true,
                            createNewOnBlur: true,
                            emptyText: t('(any authenticated user; @group for a group)'),
                            value: isEdit ? (existing.validUsers || []) : [],
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'hostsAllow',
                            cls: 'anas-fld-hosts-allow',
                            fieldLabel: t('Hosts allow'),
                            emptyText: '10.0.0.0/24, 192.168.1.5',
                            value: isEdit ? (existing.hostsAllow || []).join(', ') : '',
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'hostsDeny',
                            cls: 'anas-fld-hosts-deny',
                            fieldLabel: t('Hosts deny'),
                            value: isEdit ? (existing.hostsDeny || []).join(', ') : '',
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
                        text: isEdit ? t('Save') : t('Create'),
                        cls: 'anas-btn-smb-share-submit',
                        handler: function () {
                            try {
                                submitSmbShare(win, node, isEdit, existing, onDone);
                            } catch (e) {
                                ANAS.warn('smb share submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('smb share window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadShareIdentity(node, userGroupStore);
    }

    function submitSmbShare(win, node, isEdit, existing, onDone) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var name = (win.down('#name').getValue() || '').replace(/^\s+|\s+$/g, '');
        var path = (win.down('#path').getValue() || '').replace(/^\s+|\s+$/g, '');
        if (!isEdit && !name) {
            alertMsg('Invalid input', t('Enter a share name.'));
            return;
        }
        if (!path || path.charAt(0) !== '/') {
            alertMsg('Invalid input', t('Enter an absolute path (starting with /).'));
            return;
        }

        var comment = (win.down('#comment').getValue() || '').replace(/^\s+|\s+$/g, '');
        var validUsers = win.down('#validUsers').getValue() || [];
        var hostsAllow = splitList(win.down('#hostsAllow').getValue());
        var hostsDeny = splitList(win.down('#hostsDeny').getValue());

        var body = {
            path: path,
            comment: comment,
            browseable: !!win.down('#browseable').getValue(),
            readOnly: !!win.down('#readOnly').getValue(),
            guestOk: !!win.down('#guestOk').getValue(),
            validUsers: validUsers,
            hostsAllow: hostsAllow,
            hostsDeny: hostsDeny,
        };

        var method;
        var url;
        var label;
        if (isEdit) {
            method = 'put';
            url = '/shares/smb/' + encodeURIComponent(existing.name);
            label = existing.name;
        } else {
            body.name = name;
            method = 'post';
            url = '/shares/smb';
            label = name;
        }

        ANAS.runJob({
            node: node,
            method: method,
            path: url,
            body: body,
            view: win,
            failTitle: isEdit ? 'Update failed' : 'Create failed',
            successMsg: (isEdit ? t('SMB share updated') : t('SMB share created')) + ': ' + label,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (onDone) {
                    onDone();
                }
            },
        });
    }

    // ---- NFS export create / edit -----------------------------------------

    var DEFAULT_NFS_OPTS = 'rw,sync,no_subtree_check,root_squash';

    function clientRowsFromExport(exp) {
        var rows = [];
        var clients = (exp && exp.clients) || [];
        for (var i = 0; i < clients.length; i++) {
            rows.push({
                spec: clients[i].spec || '',
                options: (clients[i].options || []).join(','),
            });
        }
        if (!rows.length) {
            rows.push({ spec: '', options: DEFAULT_NFS_OPTS });
        }
        return rows;
    }

    function openNfsExportWindow(node, existing, preset, onDone) {
        var isEdit = !!existing;
        preset = preset || {};

        var clientStore = Ext.create('Ext.data.Store', {
            fields: ['spec', 'options'],
            data: isEdit
                ? clientRowsFromExport(existing)
                : [{ spec: '', options: DEFAULT_NFS_OPTS }],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-nfs-export',
                title: isEdit
                    ? t('Edit NFS Export') + ': ' + existing.path
                    : t('Add NFS Export'),
                modal: true,
                width: 620,
                height: 440,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'form',
                        itemId: 'form',
                        border: false,
                        bodyPadding: 12,
                        items: [{
                            xtype: 'textfield',
                            itemId: 'path',
                            cls: 'anas-fld-nfs-path',
                            fieldLabel: t('Export path'),
                            labelWidth: 120,
                            anchor: '100%',
                            emptyText: '/tank/media',
                            allowBlank: false,
                            readOnly: isEdit,
                            value: isEdit ? existing.path : (preset.path || ''),
                        }],
                    },
                    {
                        xtype: 'grid',
                        itemId: 'clients',
                        cls: 'anas-grid-nfs-clients',
                        flex: 1,
                        border: true,
                        margin: '0 12 12 12',
                        store: clientStore,
                        selModel: { mode: 'SINGLE' },
                        plugins: [{ ptype: 'cellediting', clicksToEdit: 1 }],
                        emptyText: t('Add at least one client'),
                        columns: [
                            {
                                text: t('Client (host / subnet / *)'),
                                dataIndex: 'spec',
                                flex: 1,
                                renderer: Ext.String.htmlEncode,
                                editor: {
                                    xtype: 'textfield',
                                    cls: 'anas-fld-client-spec',
                                    allowBlank: false,
                                    emptyText: '10.0.0.0/24',
                                },
                            },
                            {
                                text: t('Options'),
                                dataIndex: 'options',
                                flex: 1,
                                renderer: Ext.String.htmlEncode,
                                editor: {
                                    xtype: 'textfield',
                                    cls: 'anas-fld-client-options',
                                    emptyText: DEFAULT_NFS_OPTS,
                                },
                            },
                        ],
                        tbar: [
                            {
                                text: t('Add Client'),
                                cls: 'anas-btn-nfs-client-add',
                                iconCls: 'fa fa-plus',
                                handler: function () {
                                    clientStore.add({ spec: '', options: DEFAULT_NFS_OPTS });
                                },
                            },
                            {
                                text: t('Remove Client'),
                                cls: 'anas-btn-nfs-client-remove',
                                iconCls: 'fa fa-minus',
                                handler: function () {
                                    var g = win.down('#clients');
                                    var sel = g ? g.getSelection() : [];
                                    if (sel && sel.length) {
                                        clientStore.remove(sel[0]);
                                    }
                                },
                            },
                        ],
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
                        text: isEdit ? t('Save') : t('Create'),
                        cls: 'anas-btn-nfs-export-submit',
                        handler: function () {
                            try {
                                submitNfsExport(win, node, isEdit, existing, onDone);
                            } catch (e) {
                                ANAS.warn('nfs export submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('nfs export window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitNfsExport(win, node, isEdit, existing, onDone) {
        var path = (win.down('#path').getValue() || '').replace(/^\s+|\s+$/g, '');
        if (!path || path.charAt(0) !== '/') {
            alertMsg('Invalid input', t('Enter an absolute export path (starting with /).'));
            return;
        }
        var grid = win.down('#clients');
        var store = grid && grid.getStore();
        var clients = [];
        if (store) {
            store.each(function (r) {
                var spec = ('' + (r.get('spec') || '')).replace(/^\s+|\s+$/g, '');
                if (!spec) {
                    return;
                }
                clients.push({ spec: spec, options: splitList(r.get('options')) });
            });
        }
        if (!clients.length) {
            alertMsg('Invalid input', t('At least one client (host/subnet) is required.'));
            return;
        }

        var method;
        var url;
        var body;
        if (isEdit) {
            method = 'put';
            url = '/shares/nfs/' + encodeURIComponent(existing.path);
            body = { clients: clients };
        } else {
            method = 'post';
            url = '/shares/nfs';
            body = { path: path, clients: clients };
        }

        ANAS.runJob({
            node: node,
            method: method,
            path: url,
            body: body,
            view: win,
            failTitle: isEdit ? 'Update failed' : 'Create failed',
            successMsg: (isEdit ? t('NFS export updated') : t('NFS export created')) + ': ' + path,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (onDone) {
                    onDone();
                }
            },
        });
    }

    // ---- SMB global settings (DESIGN 5c network binding) -------------------

    function openSmbSettings(node) {
        if (typeof ANAS.editWindow !== 'function') {
            ANAS.warn('ANAS.editWindow unavailable — cannot edit SMB settings');
            return;
        }
        ANAS.editWindow({
            cls: 'anas-win-smb-settings',
            title: t('SMB Settings'),
            submitText: 'Save',
            submitCls: 'anas-btn-smb-settings-submit',
            width: 540,
            items: [
                {
                    xtype: 'textfield',
                    name: 'workgroup',
                    cls: 'anas-fld-workgroup',
                    fieldLabel: t('Workgroup'),
                    emptyText: 'WORKGROUP',
                },
                {
                    xtype: 'textfield',
                    name: 'serverString',
                    cls: 'anas-fld-server-string',
                    fieldLabel: t('Server string'),
                    emptyText: '%h server (Samba)',
                },
                {
                    xtype: 'tagfield',
                    name: 'interfaces',
                    cls: 'anas-fld-interfaces',
                    fieldLabel: t('Interfaces'),
                    store: Ext.create('Ext.data.Store', { fields: ['name'], data: [] }),
                    displayField: 'name',
                    valueField: 'name',
                    queryMode: 'local',
                    forceSelection: false,
                    createNewOnEnter: true,
                    createNewOnBlur: true,
                    emptyText: t('(all interfaces) — e.g. lo, eth1, 10.0.0.0/24'),
                },
                {
                    xtype: 'checkboxfield',
                    name: 'bindInterfacesOnly',
                    cls: 'anas-fld-bind-interfaces-only',
                    fieldLabel: t('Bind interfaces only'),
                    boxLabel: t('Restrict smbd to the interfaces listed above'),
                },
            ],

            load: function (form, done) {
                if (!form) {
                    done(t('Form unavailable'));
                    return;
                }
                ANAS.api.get(node, '/shares/smb/global').then(function (res) {
                    var g = (res && res.data) || {};
                    form.setValues({
                        workgroup: g.workgroup || '',
                        serverString: g.serverString || '',
                        interfaces: g.interfaces || [],
                        bindInterfacesOnly: !!g.bindInterfacesOnly,
                    });
                    done();
                }, function (err) {
                    done(t('Failed to load SMB settings') + ': ' + ANAS.errText(err));
                });
            },

            submit: function (form, win) {
                var body = {
                    workgroup: '' + (form.findField('workgroup').getValue() || ''),
                    serverString: '' + (form.findField('serverString').getValue() || ''),
                    interfaces: form.findField('interfaces').getValue() || [],
                    bindInterfacesOnly: !!form.findField('bindInterfacesOnly').getValue(),
                };
                ANAS.runJob({
                    node: node,
                    method: 'put',
                    path: '/shares/smb/global',
                    body: body,
                    view: win,
                    failTitle: 'Update failed',
                    successMsg: t('SMB settings updated'),
                    onComplete: function () {
                        win.close();
                    },
                });
            },
        });
    }

    // ---- Remove (confirmation-gated) --------------------------------------
    //
    // Deletes are dangerous: the daemon returns 409 + X-Anas-Confirm-Code +
    // warnings (SMB warns on active connections; NFS warns it's a live export).
    // Mirror the datasets destroy flow: an unconfirmed DELETE surfaces the
    // warnings in a dialog; on confirm we resend with the code. The confirm code
    // is NOT bound to any modifier.

    function sharePath(proto, id) {
        if (proto === 'smb') {
            return '/shares/smb/' + encodeURIComponent(id);
        }
        return '/shares/nfs/' + encodeURIComponent(id);
    }

    function runRemove(node, grid, proto, id, label, confirmCode) {
        ANAS.runJob({
            node: node,
            method: 'del',
            path: sharePath(proto, id),
            confirmCode: confirmCode,
            view: grid,
            failTitle: 'Remove failed',
            successMsg: t('Removed') + ' ' + label,
            maxMs: 30000,
            onComplete: function () {
                loadShares(grid, node);
            },
        });
    }

    function showRemoveConfirm(node, grid, proto, id, label, confirmCode, warnings) {
        var heading = proto === 'smb'
            ? t('Remove SMB share') + ' "' + label + '"?'
            : t('Remove NFS export') + ' "' + label + '"?';
        var items = [{
            xtype: 'component',
            html: '<b>' + enc(heading) + '</b>'
                + '<ul><li>'
                + (warnings || []).map(function (w) { return enc(w); }).join('</li><li>')
                + '</li></ul>',
            margin: '0 0 8 0',
        }];
        var win = Ext.create('Ext.window.Window', {
            title: proto === 'smb' ? t('Remove SMB share') : t('Remove NFS export'),
            cls: 'anas-win-share-remove',
            modal: true,
            width: 480,
            bodyPadding: 12,
            layout: 'anchor',
            items: items,
            buttons: [{
                text: t('Cancel'),
                handler: function () { win.close(); },
            }, {
                text: t('Remove'),
                cls: 'anas-btn-share-remove-confirm',
                ui: 'default-toolbar',
                handler: function () {
                    win.close();
                    runRemove(node, grid, proto, id, label, confirmCode);
                },
            }],
        });
        win.show();
    }

    function openRemove(node, grid, rec) {
        if (!rec) {
            return;
        }
        var proto = rec.get('protocol');
        var raw = rec.get('raw') || {};
        var id = proto === 'smb' ? raw.name : raw.path;
        var label = rec.get('name');
        // Step 1: unconfirmed DELETE → 409 challenge (code + warnings), or a
        // hard error we surface directly.
        ANAS.api.del(node, sharePath(proto, id)).then(function () {
            // Unexpected: remove without confirmation should not succeed.
            loadShares(grid, node);
        }, function (err) {
            if (err && err.status === 409 && err.confirmCode) {
                var warnings = (err.body && err.body.error && err.body.error.warnings) || [];
                showRemoveConfirm(node, grid, proto, id, label, err.confirmCode, warnings);
                return;
            }
            alertMsg('Remove failed', ANAS.errText(err));
        });
    }

    // ---- Edit dispatch -----------------------------------------------------

    function openEdit(node, grid, rec) {
        if (!rec) {
            return;
        }
        var reload = function () {
            loadShares(grid, node);
        };
        if (rec.get('protocol') === 'smb') {
            openSmbShareWindow(node, rec.get('raw'), null, reload);
        } else {
            openNfsExportWindow(node, rec.get('raw'), null, reload);
        }
    }

    // ---- View --------------------------------------------------------------

    function sharesView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'protocol', 'name', 'path',
                { name: 'activeConnections', type: 'auto' },
                { name: 'raw', type: 'auto' },
            ],
            data: [],
            sorters: [
                { property: 'protocol', direction: 'ASC' },
                { property: 'name', direction: 'ASC' },
            ],
        });

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-shares',
            title: t('Shares'),
            layout: 'fit',
            border: false,
            items: [{
                xtype: 'gridpanel',
                itemId: 'sharesGrid',
                cls: 'anas-grid-shares',
                border: false,
                store: store,
                selModel: { mode: 'SINGLE' },
                emptyText: t('No shares defined'),
                columns: [
                    {
                        text: t('Protocol'),
                        dataIndex: 'protocol',
                        width: 90,
                        renderer: renderProtocol,
                    },
                    {
                        text: t('Name'),
                        dataIndex: 'name',
                        width: 180,
                        renderer: Ext.String.htmlEncode,
                    },
                    {
                        text: t('Path'),
                        dataIndex: 'path',
                        flex: 1,
                        renderer: Ext.String.htmlEncode,
                    },
                    {
                        text: t('Attributes'),
                        dataIndex: 'raw',
                        flex: 1,
                        renderer: renderAttrs,
                    },
                    {
                        text: t('Active'),
                        dataIndex: 'activeConnections',
                        width: 80,
                        align: 'center',
                        renderer: renderActive,
                    },
                ],
                tbar: [
                    {
                        text: t('Reload'),
                        cls: 'anas-btn-refresh',
                        iconCls: 'fa fa-refresh',
                        handler: function (btn) {
                            loadShares(btn.up('grid'), node);
                        },
                    },
                    {
                        text: t('SMB Share'),
                        cls: 'anas-btn-smb-add',
                        iconCls: 'fa fa-plus',
                        handler: function (btn) {
                            var grid = btn.up('grid');
                            openSmbShareWindow(node, null, null, function () {
                                loadShares(grid, node);
                            });
                        },
                    },
                    {
                        text: t('NFS Export'),
                        cls: 'anas-btn-nfs-add',
                        iconCls: 'fa fa-plus',
                        handler: function (btn) {
                            var grid = btn.up('grid');
                            openNfsExportWindow(node, null, null, function () {
                                loadShares(grid, node);
                            });
                        },
                    },
                    {
                        text: t('SMB Settings'),
                        cls: 'anas-btn-smb-settings',
                        iconCls: 'fa fa-cog',
                        handler: function () {
                            openSmbSettings(node);
                        },
                    },
                    '-',
                    {
                        text: t('Edit'),
                        itemId: 'shareEdit',
                        cls: 'anas-btn-share-edit',
                        iconCls: 'fa fa-pencil',
                        disabled: true,
                        handler: function (btn) {
                            var grid = btn.up('grid');
                            openEdit(node, grid, selectedShare(grid));
                        },
                    },
                    {
                        text: t('Remove'),
                        itemId: 'shareRemove',
                        cls: 'anas-btn-share-remove',
                        iconCls: 'fa fa-trash',
                        disabled: true,
                        handler: function (btn) {
                            var grid = btn.up('grid');
                            openRemove(node, grid, selectedShare(grid));
                        },
                    },
                ],
                listeners: {
                    afterrender: function (grid) {
                        loadShares(grid, node);
                    },
                    selectionchange: function () {
                        updateShareButtons(this);
                    },
                    itemdblclick: function (grid, rec) {
                        openEdit(node, grid, rec);
                    },
                },
            }],
        };
    }

    // ---- Exports for the contextual "Share…" action (60-datasets.js) -------
    //
    // 60 loads before this file; its handler resolves ANAS.shares lazily at
    // click time, so these entry points exist by the time a user acts.

    ANAS.shares = ANAS.shares || {};
    ANAS.shares.reload = loadShares;
    ANAS.shares.openSmbCreate = function (node, preset, onDone) {
        openSmbShareWindow(node, null, preset || {}, onDone);
    };
    ANAS.shares.openNfsCreate = function (node, preset, onDone) {
        openNfsExportWindow(node, null, preset || {}, onDone);
    };

    // ---- View registration -------------------------------------------------

    ANAS.views['shares'] = {
        itemId: 'anas-shares',
        text: t('Shares'),
        iconCls: 'fa fa-share-alt',
        factory: function (node) {
            try {
                return sharesView(node);
            } catch (e) {
                ANAS.warn('shares view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
