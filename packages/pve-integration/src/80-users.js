/*
 * ANAS — Share Users view (Epic 8: user & group management for share access).
 *
 * One "Share Users" menu item under the ANAS section, presenting TWO grids in a
 * single view: share USERS on top and GROUPS below (vbox). These are system
 * identities resolved through getent/nsswitch (DESIGN "Identity"), so local,
 * LDAP, and AD users all surface the same way. Only `local:true` identities are
 * ones ANAS can manage; directory-provided identities (AD/LDAP, Epic 14) are
 * shown read-only — every mutating action is disabled unless the selected row
 * is local.
 *
 * SCOPE (EPICS Epic 8): share users, NOT PVE/login users. A user created here
 * has no login shell and no Unix password — it exists to own files (NFS) and
 * optionally hold an SMB passdb password. It cannot log into the box or PVE.
 *
 * Every mutation is a job (202 + { job }) routed through ANAS.runJob, exactly
 * like 70-shares.js. Enable/Disable is a plain UI confirm (Ext.Msg.confirm),
 * not a daemon confirm-code gate.
 *
 * Data (paths relative to /v1):
 *   GET  /identity/users                    → { data: ShareUser[] }
 *   GET  /identity/groups                   → { data: ShareGroup[] }
 *   POST /identity/users                    → 202 { job }  (CreateShareUserRequest)
 *   POST /identity/users/:name/smb-password → 202 { job }  (SetSmbPasswordRequest)
 *   PUT  /identity/users/:name              → 202 { job }  (SetUserEnabledRequest)
 *   POST /identity/groups                   → 202 { job }  (CreateGroupRequest)
 *   PUT  /identity/groups/:name/members     → 202 { job }  (UpdateGroupMembersRequest)
 *
 * Test hooks:
 *   view panel cls   'anas-view anas-view-users'
 *   grids            'anas-grid-users' / 'anas-grid-groups'
 *   toolbar buttons  'anas-btn-refresh' (shared reload),
 *                    'anas-btn-user-add' / 'anas-btn-user-smbpw' /
 *                    'anas-btn-user-toggle' / 'anas-btn-user-groups',
 *                    'anas-btn-group-add' / 'anas-btn-group-members'
 *   windows          'anas-win-user-create' / 'anas-win-smb-password' /
 *                    'anas-win-group-create' / 'anas-win-group-members'
 *   fields           'anas-fld-user-name' / 'anas-fld-user-fullname' /
 *                    'anas-fld-user-groups' / 'anas-fld-smb-password' /
 *                    'anas-fld-group-name' / 'anas-fld-group-members'
 *   submit buttons   'anas-btn-user-create-submit' / 'anas-btn-smb-password-submit' /
 *                    'anas-btn-group-create-submit' / 'anas-btn-group-members-submit'
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

    function alertMsg(title, msg) {
        try {
            Ext.Msg.alert(t(title), msg);
        } catch (e) {
            ANAS.warn(msg);
        }
    }

    function trim(v) {
        return ('' + (v == null ? '' : v)).replace(/^\s+|\s+$/g, '');
    }

    // Basic client-side mirror of the daemon's IdentityName validation
    // (identity.ts): lowercase/underscore start, then lowercase/digits/_/-, with
    // an optional trailing $ for machine accounts. The daemon is authoritative;
    // this only catches obvious typos before the round-trip.
    var NAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;

    // ---- Selection helpers -------------------------------------------------

    function selectedRow(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function isLocal(rec) {
        return !!(rec && rec.get('local'));
    }

    // ---- Renderers ---------------------------------------------------------

    function renderGroups(v) {
        var arr = v || [];
        if (!arr.length) {
            return '<span style="color:#888;">&mdash;</span>';
        }
        return enc(arr.join(', '));
    }

    function renderMembers(v) {
        var arr = v || [];
        if (!arr.length) {
            return '<span style="color:#888;">' + enc(t('(empty)')) + '</span>';
        }
        return enc(arr.join(', '));
    }

    function renderSmb(v) {
        if (v) {
            return '<span title="' + enc(t('SMB password set')) + '"'
                + ' style="color:#21BF4B;font-weight:bold;">&#10003;</span>';
        }
        return '<span title="' + enc(t('No SMB password')) + '"'
            + ' style="color:#999;">&#10007;</span>';
    }

    function renderStatus(v) {
        // v === locked
        if (v) {
            return '<span style="color:#c0392b;">' + enc(t('Disabled')) + '</span>';
        }
        return '<span style="color:#21BF4B;">' + enc(t('Active')) + '</span>';
    }

    function renderSource(v) {
        // v === local
        if (v) {
            return '<span class="anas-badge anas-badge-local"'
                + ' style="display:inline-block;padding:1px 8px;border-radius:3px;'
                + 'color:#fff;font-size:0.85em;background:#3468c0;">'
                + enc(t('Local')) + '</span>';
        }
        return '<span class="anas-badge anas-badge-directory"'
            + ' title="' + enc(t('managed in the directory')) + '"'
            + ' style="display:inline-block;padding:1px 8px;border-radius:3px;'
            + 'color:#fff;font-size:0.85em;background:#8a2be2;">'
            + enc(t('Directory')) + '</span>';
    }

    // ---- View lookup / load ------------------------------------------------

    function findView(cmp) {
        return cmp ? cmp.up('panel[anasUsersView]') : null;
    }

    function usersGridOf(view) {
        return view ? view.down('#usersGrid') : null;
    }

    function groupsGridOf(view) {
        return view ? view.down('#groupsGrid') : null;
    }

    function loadUsers(grid, node) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        ANAS.api.get(node, '/identity/users').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            var rows = (res && res.data) || [];
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('users store load failed: ' + ANAS.errText(e2));
            }
            updateUserButtons(grid);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            ANAS.warn('users load failed: ' + ANAS.errText(err));
        });
    }

    function loadGroups(grid, node) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        ANAS.api.get(node, '/identity/groups').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            var rows = (res && res.data) || [];
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('groups store load failed: ' + ANAS.errText(e2));
            }
            updateGroupButtons(grid);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            try {
                grid.setLoading(false);
            } catch (e) {
                // non-fatal
            }
            ANAS.warn('groups load failed: ' + ANAS.errText(err));
        });
    }

    function reloadAll(view, node) {
        loadUsers(usersGridOf(view), node);
        loadGroups(groupsGridOf(view), node);
    }

    // ---- getent-backed picker stores ---------------------------------------
    //
    // Groups picker (New User / Edit Groups) and users picker (group Members)
    // read the same /identity endpoints the grids do. Best-effort: a load
    // failure leaves an empty pick list, and the tagfields allow free entry.

    function loadGroupNames(node, store) {
        ANAS.api.get(node, '/identity/groups').then(function (res) {
            if (!store || store.destroyed) {
                return;
            }
            var rows = (res && res.data) || [];
            var data = [];
            for (var i = 0; i < rows.length; i++) {
                data.push({ name: rows[i].name });
            }
            store.loadData(data);
        }, function (err) {
            ANAS.warn('group names load failed: ' + ANAS.errText(err));
        });
    }

    function loadUserNames(node, store) {
        ANAS.api.get(node, '/identity/users').then(function (res) {
            if (!store || store.destroyed) {
                return;
            }
            var rows = (res && res.data) || [];
            var data = [];
            for (var i = 0; i < rows.length; i++) {
                data.push({ name: rows[i].name });
            }
            store.loadData(data);
        }, function (err) {
            ANAS.warn('user names load failed: ' + ANAS.errText(err));
        });
    }

    // ---- Button state ------------------------------------------------------

    function setDisabled(container, itemId, disabled) {
        var btn = container.down('#' + itemId);
        if (btn) {
            btn.setDisabled(!!disabled);
        }
    }

    function updateUserButtons(grid) {
        if (!grid) {
            return;
        }
        var rec = selectedRow(grid);
        var local = isLocal(rec);
        // Every mutating action requires a selected, LOCAL row. Directory users
        // are read-only (provisioned in AD/LDAP, Epic 14).
        setDisabled(grid, 'userSmbpw', !local);
        setDisabled(grid, 'userToggle', !local);
        setDisabled(grid, 'userGroups', !local);
        var toggle = grid.down('#userToggle');
        if (toggle) {
            // Label follows selection: a locked user is re-enabled, else disabled.
            toggle.setText(rec && rec.get('locked') ? t('Enable') : t('Disable'));
        }
    }

    function updateGroupButtons(grid) {
        if (!grid) {
            return;
        }
        setDisabled(grid, 'groupMembers', !isLocal(selectedRow(grid)));
    }

    // ---- New user window (anas-win-user-create) ----------------------------

    function openUserCreate(node, view) {
        var groupStore = Ext.create('Ext.data.Store', { fields: ['name'], data: [] });
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-user-create',
                title: t('New Share User'),
                modal: true,
                width: 520,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    scrollable: true,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'name',
                            cls: 'anas-fld-user-name',
                            fieldLabel: t('Username'),
                            emptyText: 'jsmith',
                            allowBlank: false,
                            regex: NAME_RE,
                            regexText: t('Lowercase letters, digits, underscore and hyphen only.'),
                            maxLength: 32,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'fullName',
                            cls: 'anas-fld-user-fullname',
                            fieldLabel: t('Full name'),
                            emptyText: t('(optional)'),
                        },
                        {
                            xtype: 'tagfield',
                            itemId: 'groups',
                            cls: 'anas-fld-user-groups',
                            fieldLabel: t('Groups'),
                            store: groupStore,
                            displayField: 'name',
                            valueField: 'name',
                            queryMode: 'local',
                            filterPickList: true,
                            forceSelection: false,
                            createNewOnEnter: true,
                            createNewOnBlur: true,
                            emptyText: t('(optional supplementary groups)'),
                            value: [],
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'smbPassword',
                            cls: 'anas-fld-smb-password',
                            inputType: 'password',
                            fieldLabel: t('SMB password'),
                            emptyText: t('(optional)'),
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'smbPasswordConfirm',
                            cls: 'anas-fld-smb-password-confirm',
                            inputType: 'password',
                            fieldLabel: t('Confirm password'),
                        },
                        {
                            xtype: 'component',
                            margin: '4 0 0 0',
                            html: '<div style="color:#888;font-size:0.9em;">'
                                + enc(t('No login access — this user can only use file shares.'))
                                + '</div>',
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
                        cls: 'anas-btn-user-create-submit',
                        handler: function () {
                            try {
                                submitUserCreate(win, node, view);
                            } catch (e) {
                                ANAS.warn('user create submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('user create window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadGroupNames(node, groupStore);
    }

    function submitUserCreate(win, node, view) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var name = trim(win.down('#name').getValue());
        if (!name || !NAME_RE.test(name)) {
            alertMsg('Invalid input', t('Enter a valid username (lowercase letters, digits, _ and -).'));
            return;
        }
        var pw = win.down('#smbPassword').getValue() || '';
        var pwc = win.down('#smbPasswordConfirm').getValue() || '';
        if (pw || pwc) {
            if (pw !== pwc) {
                alertMsg('Invalid input', t('The SMB passwords do not match.'));
                return;
            }
        }

        var body = { name: name };
        var fullName = trim(win.down('#fullName').getValue());
        if (fullName) {
            body.fullName = fullName;
        }
        var groups = win.down('#groups').getValue() || [];
        if (groups.length) {
            body.groups = groups;
        }
        if (pw) {
            body.smbPassword = pw;
        }

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/identity/users',
            body: body,
            view: win,
            failTitle: 'Create failed',
            successMsg: t('Share user created') + ': ' + name,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                reloadAll(view, node);
            },
        });
    }

    // ---- Set SMB password window (anas-win-smb-password) -------------------

    function openSmbPassword(node, view, rec) {
        if (!rec) {
            return;
        }
        var userName = rec.get('name');
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-smb-password',
                title: t('Set SMB Password') + ': ' + userName,
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
                            itemId: 'password',
                            cls: 'anas-fld-smb-password',
                            inputType: 'password',
                            fieldLabel: t('SMB password'),
                            allowBlank: false,
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'passwordConfirm',
                            cls: 'anas-fld-smb-password-confirm',
                            inputType: 'password',
                            fieldLabel: t('Confirm password'),
                            allowBlank: false,
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
                        text: t('Set Password'),
                        cls: 'anas-btn-smb-password-submit',
                        handler: function () {
                            try {
                                submitSmbPassword(win, node, view, userName);
                            } catch (e) {
                                ANAS.warn('smb password submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('smb password window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitSmbPassword(win, node, view, userName) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var pw = win.down('#password').getValue() || '';
        var pwc = win.down('#passwordConfirm').getValue() || '';
        if (!pw) {
            alertMsg('Invalid input', t('Enter a password.'));
            return;
        }
        if (pw !== pwc) {
            alertMsg('Invalid input', t('The passwords do not match.'));
            return;
        }

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/identity/users/' + encodeURIComponent(userName) + '/smb-password',
            body: { password: pw },
            view: win,
            failTitle: 'Update failed',
            successMsg: t('SMB password set') + ': ' + userName,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadUsers(usersGridOf(view), node);
            },
        });
    }

    // ---- Enable / disable (UI confirm, no daemon confirm-code) -------------

    function toggleUserEnabled(node, view, rec) {
        if (!rec) {
            return;
        }
        var userName = rec.get('name');
        var locked = !!rec.get('locked');
        // A locked user is being re-enabled; an active one is being disabled.
        var enabled = locked;
        var title = enabled ? t('Enable user') : t('Disable user');
        var msg = enabled
            ? t('Re-enable share access for') + ' "' + enc(userName) + '"?'
            : t('Disable share access for') + ' "' + enc(userName) + '"? '
                + t('The account is kept but SMB and login access are revoked.');
        try {
            Ext.Msg.confirm(title, msg, function (btn) {
                if (btn !== 'yes') {
                    return;
                }
                ANAS.runJob({
                    node: node,
                    method: 'put',
                    path: '/identity/users/' + encodeURIComponent(userName),
                    body: { enabled: enabled },
                    view: view,
                    failTitle: 'Update failed',
                    successMsg: (enabled ? t('User enabled') : t('User disabled')) + ': ' + userName,
                    onComplete: function () {
                        loadUsers(usersGridOf(view), node);
                    },
                });
            });
        } catch (e) {
            ANAS.warn('toggle confirm failed: ' + ANAS.errText(e));
        }
    }

    // ---- Edit groups for a user (reuses the members endpoint per group) -----
    //
    // A user's group membership is edited by diffing the user's `groups` against
    // a getent-backed group picker and issuing one PUT /identity/groups/:name/
    // members per changed group (add or remove this user).

    function openUserGroups(node, view, rec) {
        if (!rec) {
            return;
        }
        var userName = rec.get('name');
        var original = (rec.get('groups') || []).slice();
        // The user's `groups` list carries the primary group first (identity.ts).
        // The primary group is managed with the user, not via gpasswd on the
        // group's member list, so it must never reach a remove op — gpasswd -d
        // refuses to strip a user's primary group and would abort the chain.
        var primaryGroup = rec.get('primaryGroup') || null;
        var groupStore = Ext.create('Ext.data.Store', { fields: ['name'], data: [] });
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-user-groups',
                title: t('Edit Groups') + ': ' + userName,
                modal: true,
                width: 520,
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
                            xtype: 'tagfield',
                            itemId: 'groups',
                            cls: 'anas-fld-user-groups',
                            fieldLabel: t('Groups'),
                            store: groupStore,
                            displayField: 'name',
                            valueField: 'name',
                            queryMode: 'local',
                            filterPickList: true,
                            forceSelection: false,
                            createNewOnEnter: true,
                            createNewOnBlur: true,
                            emptyText: t('(no supplementary groups)'),
                            value: original,
                        },
                        {
                            xtype: 'component',
                            margin: '4 0 0 0',
                            html: '<div style="color:#888;font-size:0.9em;">'
                                + enc(primaryGroup
                                    ? t('The primary group') + ' (' + primaryGroup + ') '
                                        + t('is managed with the user and cannot be removed here.')
                                    : t('The primary group is managed with the user and is not changed here.'))
                                + '</div>',
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
                        text: t('Save'),
                        cls: 'anas-btn-user-groups-submit',
                        handler: function () {
                            try {
                                submitUserGroups(win, node, view, userName, original, primaryGroup);
                            } catch (e) {
                                ANAS.warn('user groups submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('user groups window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadGroupNames(node, groupStore);
    }

    function diffList(before, after) {
        var i;
        var beforeMap = {};
        var afterMap = {};
        for (i = 0; i < before.length; i++) {
            beforeMap[before[i]] = 1;
        }
        for (i = 0; i < after.length; i++) {
            afterMap[after[i]] = 1;
        }
        var added = [];
        var removed = [];
        for (i = 0; i < after.length; i++) {
            if (!beforeMap[after[i]]) {
                added.push(after[i]);
            }
        }
        for (i = 0; i < before.length; i++) {
            if (!afterMap[before[i]]) {
                removed.push(before[i]);
            }
        }
        return { added: added, removed: removed };
    }

    function submitUserGroups(win, node, view, userName, original, primaryGroup) {
        var after = win.down('#groups').getValue() || [];
        var d = diffList(original, after);
        // A user cannot be removed from their primary group (gpasswd -d refuses,
        // aborting the chain). If the operator cleared the primary-group tag, drop
        // it from the removals — it is a no-op the daemon can't honor, and leaving
        // the tag selected would have been a no-op too. Adds are unaffected.
        var removed = [];
        var i;
        for (i = 0; i < d.removed.length; i++) {
            if (primaryGroup && d.removed[i] === primaryGroup) {
                continue;
            }
            removed.push(d.removed[i]);
        }
        if (!d.added.length && !removed.length) {
            win.close();
            return;
        }
        // One PUT per changed group: add the user to newly-selected groups and
        // remove it from cleared ones. Chained so the grid refresh runs once at
        // the end; each call is its own job.
        var ops = [];
        for (i = 0; i < d.added.length; i++) {
            ops.push({ group: d.added[i], body: { add: [userName] } });
        }
        for (i = 0; i < removed.length; i++) {
            ops.push({ group: removed[i], body: { remove: [userName] } });
        }

        var idx = 0;
        function next() {
            if (idx >= ops.length) {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                reloadAll(view, node);
                return;
            }
            var op = ops[idx];
            idx += 1;
            ANAS.runJob({
                node: node,
                method: 'put',
                path: '/identity/groups/' + encodeURIComponent(op.group) + '/members',
                body: op.body,
                view: win,
                failTitle: 'Update failed',
                successMsg: t('Group membership updated') + ': ' + op.group,
                onComplete: next,
                onFailed: function () {
                    // Stop the chain on failure; refresh to reflect partial state.
                    reloadAll(view, node);
                },
            });
        }
        next();
    }

    // ---- New group window (anas-win-group-create) --------------------------

    function openGroupCreate(node, view) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-group-create',
                title: t('New Group'),
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
                            itemId: 'name',
                            cls: 'anas-fld-group-name',
                            fieldLabel: t('Group name'),
                            emptyText: 'media',
                            allowBlank: false,
                            regex: NAME_RE,
                            regexText: t('Lowercase letters, digits, underscore and hyphen only.'),
                            maxLength: 32,
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
                        cls: 'anas-btn-group-create-submit',
                        handler: function () {
                            try {
                                submitGroupCreate(win, node, view);
                            } catch (e) {
                                ANAS.warn('group create submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('group create window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
    }

    function submitGroupCreate(win, node, view) {
        var form = win.down('#form');
        var basicForm = form && form.getForm();
        if (basicForm && basicForm.isValid && !basicForm.isValid()) {
            return;
        }
        var name = trim(win.down('#name').getValue());
        if (!name || !NAME_RE.test(name)) {
            alertMsg('Invalid input', t('Enter a valid group name (lowercase letters, digits, _ and -).'));
            return;
        }

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/identity/groups',
            body: { name: name },
            view: win,
            failTitle: 'Create failed',
            successMsg: t('Group created') + ': ' + name,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadGroups(groupsGridOf(view), node);
            },
        });
    }

    // ---- Group members window (anas-win-group-members) ---------------------
    //
    // Shows the group's current members in a grid; add via a getent-backed user
    // tagfield, remove via selection. On submit the final membership is diffed
    // against the original and sent as { add, remove }.

    function openGroupMembers(node, view, rec) {
        if (!rec) {
            return;
        }
        var groupName = rec.get('name');
        var original = (rec.get('members') || []).slice();

        var memberStore = Ext.create('Ext.data.Store', {
            fields: ['name'],
            data: (function () {
                var d = [];
                for (var i = 0; i < original.length; i++) {
                    d.push({ name: original[i] });
                }
                return d;
            })(),
        });
        var userStore = Ext.create('Ext.data.Store', { fields: ['name'], data: [] });

        function addPicked() {
            var fld = win.down('#addUsers');
            if (!fld) {
                return;
            }
            var picked = fld.getValue() || [];
            for (var i = 0; i < picked.length; i++) {
                var nm = trim(picked[i]);
                if (nm && memberStore.findExact('name', nm) === -1) {
                    memberStore.add({ name: nm });
                }
            }
            fld.setValue([]);
        }

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-group-members',
                title: t('Group Members') + ': ' + groupName,
                modal: true,
                width: 520,
                height: 460,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'fieldcontainer',
                        layout: 'hbox',
                        margin: '12 12 6 12',
                        items: [
                            {
                                xtype: 'tagfield',
                                itemId: 'addUsers',
                                cls: 'anas-fld-group-members',
                                flex: 1,
                                store: userStore,
                                displayField: 'name',
                                valueField: 'name',
                                queryMode: 'local',
                                filterPickList: true,
                                forceSelection: false,
                                createNewOnEnter: true,
                                createNewOnBlur: true,
                                emptyText: t('Add users to this group…'),
                            },
                            {
                                xtype: 'button',
                                text: t('Add'),
                                cls: 'anas-btn-group-member-add',
                                iconCls: 'fa fa-plus',
                                margin: '0 0 0 6',
                                handler: addPicked,
                            },
                        ],
                    },
                    {
                        xtype: 'grid',
                        itemId: 'members',
                        cls: 'anas-grid-group-members',
                        flex: 1,
                        border: true,
                        margin: '0 12 12 12',
                        store: memberStore,
                        selModel: { mode: 'SINGLE' },
                        emptyText: t('No members'),
                        columns: [
                            {
                                text: t('Member'),
                                dataIndex: 'name',
                                flex: 1,
                                renderer: Ext.String.htmlEncode,
                            },
                        ],
                        tbar: [
                            {
                                text: t('Remove'),
                                cls: 'anas-btn-group-member-remove',
                                iconCls: 'fa fa-minus',
                                handler: function () {
                                    var g = win.down('#members');
                                    var sel = g ? g.getSelection() : [];
                                    if (sel && sel.length) {
                                        memberStore.remove(sel[0]);
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
                        text: t('Save'),
                        cls: 'anas-btn-group-members-submit',
                        handler: function () {
                            try {
                                submitGroupMembers(win, node, view, groupName, original, memberStore);
                            } catch (e) {
                                ANAS.warn('group members submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('group members window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadUserNames(node, userStore);
    }

    function submitGroupMembers(win, node, view, groupName, original, memberStore) {
        var after = [];
        memberStore.each(function (r) {
            var nm = trim(r.get('name'));
            if (nm) {
                after.push(nm);
            }
        });
        var d = diffList(original, after);
        if (!d.added.length && !d.removed.length) {
            win.close();
            return;
        }
        var body = {};
        if (d.added.length) {
            body.add = d.added;
        }
        if (d.removed.length) {
            body.remove = d.removed;
        }

        ANAS.runJob({
            node: node,
            method: 'put',
            path: '/identity/groups/' + encodeURIComponent(groupName) + '/members',
            body: body,
            view: win,
            failTitle: 'Update failed',
            successMsg: t('Group members updated') + ': ' + groupName,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                reloadAll(view, node);
            },
        });
    }

    // ---- View --------------------------------------------------------------

    function usersView(node) {
        var usersStore = Ext.create('Ext.data.Store', {
            fields: [
                'name',
                { name: 'uid', type: 'int' },
                'fullName', 'primaryGroup',
                { name: 'groups', type: 'auto' },
                { name: 'smbEnabled', type: 'bool' },
                { name: 'locked', type: 'bool' },
                { name: 'local', type: 'bool' },
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        var groupsStore = Ext.create('Ext.data.Store', {
            fields: [
                'name',
                { name: 'gid', type: 'int' },
                { name: 'members', type: 'auto' },
                { name: 'local', type: 'bool' },
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-users',
            anasUsersView: true,
            itemId: 'anasUsersView',
            title: t('Share Users'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'usersGrid',
                    cls: 'anas-grid-users',
                    title: t('Users'),
                    flex: 2,
                    border: false,
                    store: usersStore,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No share users'),
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'name',
                            width: 160,
                            renderer: Ext.String.htmlEncode,
                        },
                        {
                            text: t('UID'),
                            dataIndex: 'uid',
                            width: 90,
                        },
                        {
                            text: t('Full name'),
                            dataIndex: 'fullName',
                            width: 160,
                            renderer: Ext.String.htmlEncode,
                        },
                        {
                            text: t('Groups'),
                            dataIndex: 'groups',
                            flex: 1,
                            renderer: renderGroups,
                        },
                        {
                            text: t('SMB'),
                            dataIndex: 'smbEnabled',
                            width: 70,
                            align: 'center',
                            renderer: renderSmb,
                        },
                        {
                            text: t('Status'),
                            dataIndex: 'locked',
                            width: 90,
                            renderer: renderStatus,
                        },
                        {
                            text: t('Source'),
                            dataIndex: 'local',
                            width: 100,
                            renderer: renderSource,
                        },
                    ],
                    tbar: [
                        {
                            text: t('Reload'),
                            cls: 'anas-btn-refresh',
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                reloadAll(findView(btn), node);
                            },
                        },
                        {
                            text: t('New User'),
                            cls: 'anas-btn-user-add',
                            iconCls: 'fa fa-plus',
                            handler: function (btn) {
                                openUserCreate(node, findView(btn));
                            },
                        },
                        '-',
                        {
                            text: t('Set SMB Password'),
                            itemId: 'userSmbpw',
                            cls: 'anas-btn-user-smbpw',
                            iconCls: 'fa fa-key',
                            disabled: true,
                            handler: function (btn) {
                                var grid = btn.up('grid');
                                openSmbPassword(node, findView(btn), selectedRow(grid));
                            },
                        },
                        {
                            text: t('Disable'),
                            itemId: 'userToggle',
                            cls: 'anas-btn-user-toggle',
                            iconCls: 'fa fa-ban',
                            disabled: true,
                            handler: function (btn) {
                                var grid = btn.up('grid');
                                toggleUserEnabled(node, findView(btn), selectedRow(grid));
                            },
                        },
                        {
                            text: t('Edit Groups'),
                            itemId: 'userGroups',
                            cls: 'anas-btn-user-groups',
                            iconCls: 'fa fa-users',
                            disabled: true,
                            handler: function (btn) {
                                var grid = btn.up('grid');
                                openUserGroups(node, findView(btn), selectedRow(grid));
                            },
                        },
                    ],
                    listeners: {
                        afterrender: function (grid) {
                            loadUsers(grid, node);
                        },
                        selectionchange: function () {
                            updateUserButtons(this);
                        },
                    },
                },
                {
                    xtype: 'gridpanel',
                    itemId: 'groupsGrid',
                    cls: 'anas-grid-groups',
                    title: t('Groups'),
                    flex: 1,
                    border: false,
                    margin: '6 0 0 0',
                    store: groupsStore,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No groups'),
                    columns: [
                        {
                            text: t('Name'),
                            dataIndex: 'name',
                            width: 160,
                            renderer: Ext.String.htmlEncode,
                        },
                        {
                            text: t('GID'),
                            dataIndex: 'gid',
                            width: 90,
                        },
                        {
                            text: t('Members'),
                            dataIndex: 'members',
                            flex: 1,
                            renderer: renderMembers,
                        },
                        {
                            text: t('Source'),
                            dataIndex: 'local',
                            width: 100,
                            renderer: renderSource,
                        },
                    ],
                    tbar: [
                        {
                            text: t('New Group'),
                            cls: 'anas-btn-group-add',
                            iconCls: 'fa fa-plus',
                            handler: function (btn) {
                                openGroupCreate(node, findView(btn));
                            },
                        },
                        {
                            text: t('Members…'),
                            itemId: 'groupMembers',
                            cls: 'anas-btn-group-members',
                            iconCls: 'fa fa-users',
                            disabled: true,
                            handler: function (btn) {
                                var grid = btn.up('grid');
                                openGroupMembers(node, findView(btn), selectedRow(grid));
                            },
                        },
                    ],
                    listeners: {
                        afterrender: function (grid) {
                            loadGroups(grid, node);
                        },
                        selectionchange: function () {
                            updateGroupButtons(this);
                        },
                    },
                },
            ],
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['users'] = {
        itemId: 'anas-users',
        text: t('Share Users'),
        iconCls: 'fa fa-users',
        factory: function (node) {
            try {
                return usersView(node);
            } catch (e) {
                ANAS.warn('users view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
