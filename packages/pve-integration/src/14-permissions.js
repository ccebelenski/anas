/*
 * ANAS — the Permissions dialog (Epic 4.7.2; shared since access.1/access.2).
 *
 * ONE dialog for every place a directory's access is edited: a ZFS dataset or
 * pool root (60-datasets.js), a Hybrid RAID pool (39-ahr.js), and an SMB share
 * or NFS export path (70-shares.js). It lives in the shared layer — this file
 * sorts before every consumer in the lexical bundle — and every consumer opens
 * it with ANAS.permissions.open(opts):
 *
 *   opts.node        PVE node name
 *   opts.accessPath  the API path of the target's access resource, e.g.
 *                    '/pools/tank/datasets/media/access', '/ahr/ahr0/access',
 *                    '/shares/smb/media/access'
 *   opts.title       what the window title names ('tank/media', 'ahr0', …)
 *   opts.backing     'zfs' | 'ahr' | 'other' — the filesystem family; the GET
 *                    payload's own `backing` wins when it carries one (a share
 *                    path learns its home from the daemon)
 *   opts.onDone(job) / opts.onFailed(job) — after the job, success / failure
 *
 * The targets differ ONLY where the filesystem differs, and each difference is
 * stated in the dialog when it applies (parallel construction):
 *   - the acltype note ("adding a named user or group enables POSIX ACLs
 *     (acltype=posixacl)") is ZFS-only — btrfs and other Linux filesystems
 *     carry POSIX ACLs natively, so nothing is switched on;
 *   - the "Apply to existing files too" help says, on a Hybrid RAID pool, that
 *     the walk covers every subvolume under the pool's data as one tree and
 *     never its snapshots;
 *   - everything else — rows, levels, the named grid, the acl-package hint,
 *     the degraded lock, the explicit clear — is identical.
 *
 * Applying to existing files is always the user's explicit choice and is
 * confirmed (access.1 design ruling). The confirm is the daemon's (ruling
 * 2026-10-11): a recursive PUT answers 409 + X-Anas-Confirm-Code, and
 * ANAS.confirmAndRun shows the 409's headline and warnings — on ZFS the
 * child datasets the walk crosses and those whose ACLs it switches on first,
 * on a Hybrid RAID pool the subvolume sweep — then resends with the code.
 *
 * Base three principals (owner / owning-group / everyone) map to POSIX mode
 * bits; extra named users/groups map to POSIX ACL entries. Data contract:
 * packages/shared/src/schemas/access.ts (DatasetAccess on GET,
 * SetAccessRequest on PUT). The daemon does the acltype=posixacl enable (ZFS)
 * + default-ACL inheritance; the UI only informs.
 *
 * Access-level labels ↔ schema: "No access"↔none, "Read"↔read,
 * "Read-Write"↔read-write.
 *
 * Test hooks (stable selectors targeted by the integration agent):
 *   window            'anas-win-dataset-access' (every target — the selector
 *                     predates the shared dialog and stays stable)
 *   owner picker       'anas-fld-access-owner'
 *   owner level        'anas-fld-access-owner-level'
 *   group picker       'anas-fld-access-group'
 *   group level        'anas-fld-access-group-level'
 *   everyone level     'anas-fld-access-everyone-level'
 *   named grid         'anas-grid-access-named'
 *   add button         'anas-btn-access-add'
 *   per-row remove     'anas-btn-access-remove'
 *   apply-existing     'anas-fld-access-recursive'
 *   apply-existing help 'anas-note-access-recursive'
 *   Advanced panel     'anas-panel-access-advanced'
 *   window submit      'anas-btn-dataset-access-submit'
 *   add-principal win  'anas-win-access-add'
 *     kind field        'anas-fld-access-add-kind'
 *     name field        'anas-fld-access-add-name'
 *     level field       'anas-fld-access-add-level'
 *     submit            'anas-btn-access-add-submit'
 *
 * acl-unsupported / not-enabled handling (from DatasetAccess flags):
 *   aclSupported === false — no setfacl on this node: the base three rows
 *     still edit (mode bits) and submit fine; "+ Add user or group" is
 *     DISABLED with an inline "install acl" note (identical on every target).
 *   aclEnabled === false on ZFS (but supported) — adding a named principal is
 *     allowed and shows a subtle note that it will enable POSIX ACLs
 *     (acltype=posixacl) on the dataset; the daemon performs the enable.
 *   aclDegraded === true — POSIX ACLs are on but getfacl failed: the levels
 *     shown are mode-bit guesses and named grants are missing, so Apply and
 *     Add are DISABLED with a note. Same rule as the failed pre-fill below: a
 *     window that doesn't know the current state never offers to replace it
 *     (#37).
 *
 * Clearing named grants is EXPLICIT (schemas/access.ts): an entries list with
 * no named rows means "unchanged". Emptying the grid sends clearNamed:true,
 * and only when the pre-fill proved there was something there to remove.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS) {
        return;
    }

    var ANAS = window.ANAS;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    // The filesystem family, normalised: anything unknown reads as ZFS — the
    // datasets payload carries no `backing` at all (absent = zfs).
    function normBacking(b) {
        return (b === 'ahr' || b === 'other') ? b : 'zfs';
    }

    // The one sentence under "Apply to existing files too", per target.
    function recursiveHelp(backing) {
        var base = t('New files always inherit these settings; '
            + 'tick this to also update files already in the folder.');
        if (backing === 'ahr') {
            return base + ' ' + t('On a Hybrid RAID pool this walks every subvolume under the '
                + 'pool\'s data as one tree; its snapshots are never touched.');
        }
        return base;
    }

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

    // Small window to add one named user/group grant. The name picker swaps its
    // store between users and groups as the kind toggles. The acltype note is
    // ZFS-only: on any other filesystem there is nothing to enable.
    function openAddPrincipal(parentWin, namedStore, userStore, groupStore, aclEnabled, backing) {
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
                            itemId: 'acltypeNote',
                            hidden: !!aclEnabled || backing !== 'zfs',
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

    function open(opts) {
        opts = opts || {};
        var node = opts.node;
        var title = '' + (opts.title || '');
        var userStore = identityStore();
        var groupStore = identityStore();
        var namedStore = Ext.create('Ext.data.Store', {
            fields: ['kind', 'name', 'level', 'unresolved'],
            data: [],
        });
        var backing = normBacking(opts.backing);

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-dataset-access',
                title: t('Permissions') + ': ' + title,
                modal: true,
                width: 560,
                height: 620,
                minWidth: 460,
                minHeight: 480,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                // The filesystem family the dialog is stating differences for
                // (harness + Playwright read it; the payload may refine it).
                anasAccessBacking: backing,
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
                                            win._aclEnabled, win._backing);
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
                                itemId: 'recursiveNote',
                                cls: 'anas-note-access-recursive',
                                style: 'color:#888;font-size:11px;margin:2px 0 0 18px;',
                                html: enc(recursiveHelp(backing)),
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
                                submitAccess(win, opts, namedStore);
                            } catch (e) {
                                ANAS.warn('access submit failed: '
                                    + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('access window failed: ' + ANAS.errText(e));
            return null;
        }
        win._backing = backing;

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
        var accessCall = ANAS.api.get(node, opts.accessPath).then(
            function (res) {
                // Reads are wrapped in { data }; tolerate a bare object too.
                var data = (res && res.data) ? res.data : res;
                return data
                    ? { data: data }
                    : { error: t('The current permissions could not be read.') };
            },
            function (err) {
                ANAS.warn('access load failed: ' + ANAS.errText(err));
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
        return win;
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

        // The daemon knows the filesystem a share path sits on; its answer
        // refines what the opener assumed. Absent (the datasets payload, an
        // older daemon) keeps the opener's.
        if (acc.backing) {
            win._backing = normBacking(acc.backing);
            win.anasAccessBacking = win._backing;
            var recNote = win.down('#recursiveNote');
            if (recNote) { recNote.setHtml(enc(recursiveHelp(win._backing))); }
        }

        // Named entries → grid.
        var named = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e && (e.kind === 'user' || e.kind === 'group')) {
                named.push({ kind: e.kind, name: e.name || '', level: e.level || 'none', unresolved: !!e.unresolved });
            }
        }
        namedStore.loadData(named);
        // Remember what the target actually had: an empty grid at submit time
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

        // POSIX ACLs are on but the ACL itself could not be read: the levels
        // above are a mode-bit approximation and any named grants are NOT in
        // the grid. Editing from here would be editing a guess, so the window
        // becomes read-only rather than offering a destructive Apply.
        if (acc.aclDegraded === true) {
            var applyBtn = win.down('#applyBtn');
            if (applyBtn) { applyBtn.setDisabled(true); }
            if (addBtn) { addBtn.setDisabled(true); }
            if (note) {
                note.setHtml(enc((win._backing === 'zfs'
                    ? t('POSIX ACLs are enabled on this dataset but could not be ')
                    : t('POSIX ACLs on this folder could not be '))
                    + t('read, so any named users/groups are missing from this view. '
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
        } else if (!enabled && win._backing === 'zfs') {
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

    function submitAccess(win, opts, namedStore) {
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

        var title = '' + (opts.title || '');
        // Rewriting the files already there is the user's explicit choice —
        // ticked here AND confirmed. The daemon owns the confirm (ruling
        // 2026-10-11): a recursive PUT answers 409 + X-Anas-Confirm-Code, and
        // the standard flow shows its headline and warnings (the child
        // datasets it crosses, the subvolume sweep, a LUN image under the
        // path) and resends with the code on OK.
        ANAS.confirmAndRun({
            node: opts.node,
            method: 'put',
            path: opts.accessPath,
            body: body,
            view: win,
            confirmTitle: t('Apply to existing files'),
            confirmHeadline: true,
            failTitle: 'Set permissions failed',
            successMsg: t('Permissions updated') + ': ' + title,
            onComplete: function (job) {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                // ZFS: the child datasets whose POSIX ACLs the walk switched on.
                var kids = job && job.result && job.result.childAclEnabled;
                if (kids && kids.length) {
                    ANAS.toast(enc(t('POSIX ACLs switched on for child datasets') + ': ' + kids.join(', ')));
                }
                if (opts.onDone) { opts.onDone(job); }
            },
            onFailed: function (job) {
                if (opts.onFailed) { opts.onFailed(job); }
            },
        });
    }

    ANAS.permissions = {
        open: open,
    };
})();
