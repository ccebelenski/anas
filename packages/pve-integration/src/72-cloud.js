/*
 * ANAS — Cloud sync Remotes manager (rclone.1 — 72-cloud.js).
 *
 * The Remotes manager window, the Repositories manager's twin (68-backup.js):
 * the grid of remotes in ANAS's OWN /etc/anas/rclone.conf plus the Add/Edit
 * dialog that renders from rclone's provider schema. The Cloud Sync MENU
 * itself lands in rclone.3 — until then the window is opened programmatically
 * through ANAS.cloud.openRemotes(node), by the harness and the UI specs.
 *
 * The dialog is GENERIC on purpose (DESIGN "Cloud sync — rclone"): every
 * backend rclone supports renders from `GET /v1/cloud/providers`, no vendor
 * code. Fields come from the trimmed provider option:
 *
 *   { name, help, type, required, secret, password, default,
 *     examples[{value, help, provider}], provider, advanced }
 *
 *   - basic (non-`advanced`) options first, then the "Show advanced options"
 *     toggle and the advanced ones — EXCEPT an option named `token`, which
 *     always shows under the OAuth sentence (its home is the basic group even
 *     when rclone types it advanced).
 *   - an option with a non-empty `provider` filter shows only when the filter
 *     matches the current value of the backend's `provider` option (rclone's
 *     syntax: a comma list of provider values, or `!A,B` = all except) — so
 *     an S3 form shows ONE `region` row for the picked provider. Changing the
 *     provider option REBUILDS the rows, keeping what was typed.
 *   - `examples` → an editable combo (value + help); `type` `bool` → a
 *     checkbox; `int` → a number field; `secret` → a password field that is
 *     WRITE-ONLY: on edit it is blank with the emptyText "(unchanged)" and is
 *     sent only when typed. `required` marks the field and gates the buttons.
 *   - keys the remote carries but the provider schema does not know (rclone
 *     appends keys of its own on first connect — a newer rclone's keys) are
 *     KEPT: shown read-only under "Other keys", never editable, never sent —
 *     an untouched PUT body cannot drop them because only rendered fields are
 *     diffed.
 *
 * Submit: create → POST /v1/cloud/remotes {name, type, options} (non-empty
 * values only; an unchecked bool is sent as 'false' only when it overrides a
 * 'true' default); edit → PUT /v1/cloud/remotes/:name {options} (changed keys
 * only; a cleared non-secret field sends '' = remove; an absent secret =
 * unchanged). Both are jobs: the manager grid reloads on success AND failure
 * (the 0.3.3 lesson). Test runs in the dialog (inline, unsaved — the daemon
 * serves it from an env-defined remote, nothing is written) and on the grid
 * toolbar (the saved remote by name).
 *
 * The store is per node and read fresh on every load (Principle 11). An
 * encrypted configuration is reported as a fact in the footer and every
 * mutating button is disabled (the daemon refuses the mutation anyway); a
 * node without rclone answers 503 and its sentence takes the grid's place.
 *
 * DAEMON CONTRACT (packages/shared/src/schemas/cloud.ts):
 *
 *   GET  /v1/cloud/providers → { data: CloudProvider[] }
 *   GET  /v1/cloud/remotes   → { data: { rclone: {version, configFile,
 *                               encrypted}, remotes: [{name, type,
 *                               options, secretsSet[]}] } }  — never a secret
 *                               value
 *   POST /v1/cloud/remotes        {name, type, options}  → 202 { job }
 *   PUT  /v1/cloud/remotes/:name  {options}              → 202 { job }
 *   DEL  /v1/cloud/remotes/:name                        → 202 { job } / 409
 *        (referencing tasks named in the message / config-encrypted)
 *   POST /v1/cloud/remotes/test  {name} | {remote:{name,type,options}}
 *                               → { data: {verdict, message} }
 *
 * Test hooks: window 'anas-win-cloud-remotes' (grid 'anas-grid-cloud-remotes',
 * footer 'anas-cloud-footer', unavailable note 'anas-cloud-unavailable',
 * buttons 'anas-btn-cloud-remote-add' / '-edit' / '-test' / '-remove');
 * dialog 'anas-win-cloud-remote-edit' (name 'anas-fld-cloud-remote-name',
 * type 'anas-fld-cloud-remote-type', advanced toggle 'anas-fld-cloud-advanced',
 * per-option field 'anas-fld-cloud-opt-<name>', OAuth note 'anas-cloud-oauth',
 * other keys 'anas-cloud-other-keys', Test 'anas-btn-cloud-remote-testconn',
 * verdict area 'anas-cloud-test-result', save 'anas-btn-cloud-remote-save').
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 * Fail-open everywhere: a broken window warns and returns, never breaks PVE.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS) {
        return;
    }

    var ANAS = window.ANAS;

    // Remote names: the [name] section in rclone.conf and the `name:` of
    // `name:path`. The shared schema (CloudRemoteName) is the authority; this
    // is the same rule for the live field guard.
    var REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function trim(v) {
        return ('' + (v == null ? '' : v)).replace(/^\s+|\s+$/g, '');
    }

    // Value of a form field by itemId selector; undefined on any failure.
    function valOf(win, sel) {
        try {
            var f = win.down(sel);
            return f ? f.getValue() : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // ---- Provider-schema helpers -------------------------------------------

    function findProvider(providers, type) {
        var list = providers || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].name === type) {
                return list[i];
            }
        }
        return null;
    }

    // rclone's option `Provider` filter: '' = all backends' values; a comma
    // list = one of them; '!A,B' = anything EXCEPT those. `value` is the
    // current value of the backend's `provider` option in this dialog.
    function providerFilterMatches(filter, value) {
        filter = '' + (filter == null ? '' : filter);
        value = '' + (value == null ? '' : value);
        if (!filter) {
            return true;
        }
        var neg = filter.charAt(0) === '!';
        var names = (neg ? filter.substring(1) : filter).split(',');
        var hit = false;
        for (var i = 0; i < names.length; i++) {
            if (trim(names[i]) === value) {
                hit = true;
                break;
            }
        }
        return neg ? !hit : hit;
    }

    // The first sentence of an option's help text — the field's subtext. Help
    // strings carry newlines and long prose; one sentence keeps the form quiet.
    function helpFirstSentence(help) {
        var s = ('' + (help == null ? '' : help)).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        if (!s) {
            return '';
        }
        var cut = s.search(/[.!?](\s|$)/);
        if (cut >= 0) {
            s = s.substring(0, cut + 1);
        }
        return s.length > 160 ? (s.substring(0, 157) + '…') : s;
    }

    // ---- Verdict sentences (Test) -------------------------------------------

    // ok → "Reachable"; every other bucket names the diagnosis + rclone's
    // message. The classifier is the daemon's; the UI only words it.
    function verdictSentence(verdict, message) {
        verdict = '' + (verdict == null ? '' : verdict);
        if (verdict === 'ok') {
            return t('Reachable');
        }
        var label = verdict === 'unreachable' ? t('Unreachable')
            : verdict === 'auth' ? t('Authentication failed')
            : verdict === 'not-found' ? t('Not found')
            : t('Error');
        var msg = trim(message);
        return msg ? (label + ' — ' + msg) : label;
    }

    // ======================================================================
    //  Remotes manager — 'anas-win-cloud-remotes'
    // ======================================================================

    function selectedRemote(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    // The "set" column: the option keys the remote carries, the secret ones
    // rendered `key (secret)` — the value itself is never in the payload to
    // render (secretsSet only).
    function renderRemoteSet(v, meta, rec) {
        var raw = rec.get('raw') || {};
        var keys = [];
        var opts = raw.options || {};
        var k;
        for (k in opts) {
            if (Object.prototype.hasOwnProperty.call(opts, k)) {
                keys.push('' + k);
            }
        }
        var secrets = raw.secretsSet || [];
        for (var i = 0; i < secrets.length; i++) {
            keys.push(secrets[i] + ' (' + t('secret') + ')');
        }
        if (!keys.length) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        return '<span style="font-family:monospace;font-size:0.85em;" title="'
            + enc(keys.join(', ')) + '">' + enc(keys.join(', ')) + '</span>';
    }

    function updateRemoteButtons(grid) {
        if (!grid) {
            return;
        }
        var rec = selectedRemote(grid);
        var has = !!rec;
        var setBtn = function (id, disabled) {
            var btn = grid.down('#' + id);
            if (!btn) { return; }
            btn.setDisabled(disabled);
        };
        var locked = grid._anasEncrypted === true;
        // Encrypted configuration: the mutations go, the read-only Test stays.
        setBtn('cloudRemoteAdd', locked);
        setBtn('cloudRemoteEdit', !has || locked);
        setBtn('cloudRemoteRemove', !has || locked);
        setBtn('cloudRemoteTest', !has);
    }

    function remoteRow(r) {
        return {
            name: (r && r.name) || '',
            type: (r && r.type) || '',
            raw: r || {},
        };
    }

    function setFooter(win, info) {
        var footer = win.down('#cloudFooter');
        if (!footer) {
            return;
        }
        var file = (info && info.configFile) || '';
        var cmd = 'rclone --config ' + file + ' copy <remote>:<path> <directory>';
        var html = '<div style="color:var(--anas-muted,gray);font-size:11px;">'
            + enc(t('rclone') + ' ' + ((info && info.version) || '?') + ' · ' + file) + '</div>'
            + '<div style="color:var(--anas-muted,gray);font-size:11px;margin-top:2px;">'
            + enc(t('To copy data back, run on this node:')) + ' '
            + '<span style="font-family:monospace;">' + enc(cmd) + '</span></div>';
        if (info && info.encrypted) {
            html += '<div style="color:var(--anas-danger,#c23b2c);font-size:11px;margin-top:4px;">'
                + enc(t('rclone\'s configuration file is password-protected; '
                    + 'ANAS manages it only unencrypted')) + '</div>';
        }
        footer.setHtml(html);
    }

    function loadRemotes(win, node) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var grid = win.down('#cloudRemotesGrid');
        if (grid) {
            try { grid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        Promise.all([
            ANAS.api.get(node, '/cloud/providers'),
            ANAS.api.get(node, '/cloud/remotes'),
        ]).then(function (results) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            var provs = (results[0] && results[0].data) || [];
            var env = (results[1] && results[1].data) || {};
            win._providers = provs;
            grid._anasEncrypted = !!(env.rclone && env.rclone.encrypted);
            var rows = [];
            var remotes = env.remotes || [];
            for (var i = 0; i < remotes.length; i++) {
                rows.push(remoteRow(remotes[i]));
            }
            try {
                grid.getStore().loadData(rows);
            } catch (eLoad) {
                ANAS.warn('cloud remotes grid load failed: ' + ANAS.errText(eLoad));
            }
            setFooter(win, env.rclone || {});
            // The unavailable note is for the 503 path only.
            var unavail = win.down('#cloudUnavailable');
            if (unavail) { unavail.setHidden(true); }
            if (grid) { try { grid.setHidden(false); } catch (eG) { /* non-fatal */ } }
            updateRemoteButtons(grid);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            if (grid) {
                try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            // No rclone on this node (503): the daemon's sentence takes the
            // grid's place — the fix is named in one verb.
            if (err && err.status === 503) {
                if (grid) { try { grid.setHidden(true); } catch (eG) { /* non-fatal */ } }
                var unavail = win.down('#cloudUnavailable');
                if (unavail) {
                    unavail.setHidden(false);
                    unavail.setHtml('<div style="max-width:520px;margin:24px auto;'
                        + 'color:var(--anas-warn,#b06a12);font-size:13px;">'
                        + enc(ANAS.errText(err)) + '</div>');
                }
                return;
            }
            ANAS.warn('cloud remotes load failed: ' + ANAS.errText(err));
            ANAS.alertMsg('Load failed', t('Failed to load the rclone remotes') + ': ' + ANAS.errText(err));
        });
    }

    // Toolbar Test: the SAVED remote, by name (the daemon reads its stored
    // secret). The verdict sentence rides the toast — a pure read, no reload.
    function testRemoteRow(node, grid, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try { grid.setLoading(t('Testing') + ' ' + name + '…'); } catch (e) { /* non-fatal */ }
        ANAS.api.post(node, '/cloud/remotes/test', { name: name }).then(function (res) {
            try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            if (grid.destroyed || grid.destroying) {
                return;
            }
            var d = (res && res.data) || {};
            ANAS.toast(verdictSentence(d.verdict, d.message));
        }, function (err) {
            try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            if (grid.destroyed || grid.destroying) {
                return;
            }
            ANAS.warn('cloud remote test failed: ' + ANAS.errText(err));
            ANAS.alertMsg('Test failed', ANAS.errText(err));
        });
    }

    function removeRemote(node, win, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try {
            Ext.Msg.confirm(
                t('Remove Remote'),
                t('Remove the remote') + ' "' + enc(name) + '"? '
                    + t('This removes its section from this node\'s rclone.conf. '
                        + 'Data already copied to the remote is untouched.'),
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    ANAS.runJob({
                        node: node,
                        method: 'del',
                        path: '/cloud/remotes/' + encodeURIComponent(name),
                        view: win,
                        failTitle: 'Remove failed',
                        successMsg: t('Remote removed') + ': ' + name,
                        onComplete: function () { loadRemotes(win, node); },
                        // Timeliness: the grid reflects the file's real state
                        // even when the job fails — a referenced-remote refusal
                        // (the daemon's sentence naming the tasks) rides the
                        // failure alert.
                        onFailed: function () { loadRemotes(win, node); },
                    });
                }
            );
        } catch (e) {
            ANAS.warn('cloud remote remove confirm failed: ' + ANAS.errText(e));
        }
    }

    function openRemotesManager(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: ['name', 'type', { name: 'raw', type: 'auto' }],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-cloud-remotes',
                title: t('Cloud Remotes'),
                modal: true,
                width: 760,
                height: 480,
                resizable: true,
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'gridpanel',
                        itemId: 'cloudRemotesGrid',
                        cls: 'anas-grid-cloud-remotes',
                        flex: 1,
                        border: false,
                        store: store,
                        selModel: { mode: 'SINGLE' },
                        emptyText: t('No remotes configured'),
                        columns: [
                            { text: t('Name'), dataIndex: 'name', width: 160,
                                renderer: function (v) {
                                    return '<span title="' + enc(v) + '">' + enc(v) + '</span>';
                                } },
                            { text: t('Type'), dataIndex: 'type', width: 140,
                                sortable: false, menuDisabled: true },
                            { text: t('Set'), dataIndex: 'name', flex: 1, minWidth: 200,
                                sortable: false, menuDisabled: true, renderer: renderRemoteSet },
                        ],
                        tbar: ANAS.tbar([
                            {
                                text: t('Add…'),
                                cls: 'anas-btn-cloud-remote-add',
                                itemId: 'cloudRemoteAdd',
                                iconCls: 'fa fa-plus',
                                handler: function () {
                                    openRemoteEdit(node, win, null, win._providers || []);
                                },
                            },
                            {
                                text: t('Edit'),
                                itemId: 'cloudRemoteEdit',
                                cls: 'anas-btn-cloud-remote-edit',
                                iconCls: 'fa fa-pencil',
                                disabled: true,
                                handler: function (btn) {
                                    var grid = btn.up('grid');
                                    if (grid._anasEncrypted === true) {
                                        ANAS.toast(t('rclone\'s configuration file is '
                                            + 'password-protected; ANAS manages it only '
                                            + 'unencrypted'));
                                        return;
                                    }
                                    var rec = selectedRemote(grid);
                                    openRemoteEdit(node, win, rec ? rec.get('raw') : null,
                                        win._providers || []);
                                },
                            },
                            {
                                text: t('Test'),
                                itemId: 'cloudRemoteTest',
                                cls: 'anas-btn-cloud-remote-test',
                                iconCls: 'fa fa-plug',
                                disabled: true,
                                handler: function (btn) {
                                    var grid = btn.up('grid');
                                    testRemoteRow(node, grid, selectedRemote(grid));
                                },
                            },
                            {
                                text: t('Remove'),
                                itemId: 'cloudRemoteRemove',
                                cls: 'anas-btn-cloud-remote-remove',
                                iconCls: 'fa fa-trash',
                                disabled: true,
                                handler: function (btn) {
                                    removeRemote(node, win, selectedRemote(btn.up('grid')));
                                },
                            },
                        ]),
                        listeners: {
                            selectionchange: function () {
                                updateRemoteButtons(this);
                            },
                            itemdblclick: function (grid, rec) {
                                if (grid._anasEncrypted === true) {
                                    ANAS.toast(t('rclone\'s configuration file is '
                                        + 'password-protected; ANAS manages it only '
                                        + 'unencrypted'));
                                    return;
                                }
                                openRemoteEdit(node, win, rec ? rec.get('raw') : null,
                                    win._providers || []);
                            },
                        },
                    },
                    {
                        // 503 — the node has no rclone: the daemon's sentence
                        // takes the grid's place.
                        xtype: 'component',
                        itemId: 'cloudUnavailable',
                        cls: 'anas-cloud-unavailable',
                        hidden: true,
                    },
                    {
                        xtype: 'component',
                        itemId: 'cloudFooter',
                        cls: 'anas-cloud-footer',
                        padding: '8 12',
                        html: '<div style="color:var(--anas-muted,gray);font-size:11px;">…</div>',
                    },
                ],
                buttons: [
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
            });
        } catch (e) {
            ANAS.warn('cloud remotes manager window failed: ' + ANAS.errText(e));
            return;
        }

        win._reload = function () { loadRemotes(win, node); };
        win.show();
        loadRemotes(win, node);
    }

    // ======================================================================
    //  Add / edit remote dialog — 'anas-win-cloud-remote-edit'
    // ======================================================================

    // The OAuth sentence, verbatim from the design — shown when the backend
    // has a `token` option (the token field always shows beneath it).
    function oauthSentence(type) {
        return t('This backend authorises through a browser. On a machine with '
            + 'one, run') + ' `rclone authorize "' + type + '"` '
            + t('and paste its output into the token field.');
    }

    // Snapshot every rendered option field's EFFECTIVE value (a string, or
    // absent when the field represents "nothing set"), so a rebuild on a
    // type/provider change keeps what was typed. Effective rules:
    //   bool     → 'true' | 'false' (only when it overrides a 'true' default)
    //              | '' (unchecked, default already false — nothing set)
    //   int      → '' | String(number)
    //   secret   → '' (never typed) | the typed value
    //   string   → the trimmed value
    function effectiveValue(cmp, opt) {
        var type = '' + (opt.type || '');
        if (type === 'bool') {
            var checked = cmp.getValue() === true;
            if (checked) {
                return 'true';
            }
            return ('' + (opt.default || '')) === 'true' ? 'false' : '';
        }
        var v = cmp.getValue();
        if (type === 'int') {
            return (v === null || v === undefined || v === '') ? '' : String(v);
        }
        if (opt.secret) {
            // Write-only: blank means unchanged/absent, never "clear".
            return (v === null || v === undefined) ? '' : String(v);
        }
        return trim(v);
    }

    // The change listeners every option field carries: any change refreshes
    // the button gate; a change of the backend's `provider` option REBUILDS
    // the rows outright (its filter decides which filtered rows apply —
    // region, endpoint, storage_class…).
    function optionChangeListeners(opt) {
        return { change: function () {
            var w = this.up('window');
            if (!w) {
                return;
            }
            if (opt.name === 'provider' && w._cloudRebuild) {
                w._cloudRebuild();
                return;
            }
            if (w._cloudRefresh) {
                w._cloudRefresh();
            }
        } };
    }

    // Field config for one option row. The row is a fieldcontainer so the
    // help's first sentence rides beneath the field as muted subtext.
    function optionFieldCfg(opt, value, isEdit) {
        var type = '' + (opt.type || '');
        var required = opt.required === true;
        var label = opt.name + (required ? ' *' : '');
        var sub = helpFirstSentence(opt.help);
        var cls = 'anas-fld-cloud-opt anas-fld-cloud-opt-' + opt.name;
        var defaults = { anchor: '100%', labelWidth: 160 };

        if (type === 'bool') {
            return {
                xtype: 'fieldcontainer',
                layout: 'anchor',
                defaults: defaults,
                items: [
                    {
                        xtype: 'checkboxfield',
                        itemId: 'cloudOpt_' + opt.name,
                        cls: cls,
                        fieldLabel: label,
                        name: opt.name,
                        checked: value === 'true',
                        _anasOption: opt,
                        listeners: optionChangeListeners(opt),
                    },
                    subFieldCfg(sub),
                ],
            };
        }

        if (opt.examples && opt.examples.length) {
            var exRows = [];
            for (var i = 0; i < opt.examples.length; i++) {
                var ex = opt.examples[i] || {};
                if (ex.value === undefined || ex.value === null || ex.value === '') {
                    continue;
                }
                exRows.push({ value: '' + ex.value, help: '' + (ex.help || '') });
            }
            return {
                xtype: 'fieldcontainer',
                layout: 'anchor',
                defaults: defaults,
                items: [
                    {
                        xtype: 'combobox',
                        itemId: 'cloudOpt_' + opt.name,
                        cls: cls,
                        fieldLabel: label,
                        name: opt.name,
                        editable: true,
                        forceSelection: false,
                        queryMode: 'local',
                        displayField: 'value',
                        valueField: 'value',
                        allowBlank: !required,
                        store: { data: exRows, fields: ['value', 'help'] },
                        listConfig: {
                            tpl: '<tpl for="."><div class="x-boundlist-item">'
                                + '<b>{value}</b>'
                                + '<tpl if="help"> — {help}</tpl></div></tpl>',
                        },
                        value: value || '',
                        emptyText: opt.default || '',
                        _anasOption: opt,
                        listeners: optionChangeListeners(opt),
                    },
                    subFieldCfg(sub),
                ],
            };
        }

        return {
            xtype: 'fieldcontainer',
            layout: 'anchor',
            defaults: defaults,
            items: [
                {
                    xtype: type === 'int' ? 'numberfield' : 'textfield',
                    itemId: 'cloudOpt_' + opt.name,
                    cls: cls,
                    fieldLabel: label,
                    name: opt.name,
                    allowBlank: !required,
                    inputType: opt.secret ? 'password' : 'text',
                    inputAttrTpl: opt.secret
                        ? ANAS.noAutofill.secret.inputAttrTpl
                        : undefined,
                    emptyText: opt.secret
                        ? (isEdit ? t('(unchanged)') : '')
                        : (opt.default || ''),
                    value: value || '',
                    // An int's box stays empty unless typed/stored — the
                    // default rides rclone's side, never forced in.
                    _anasOption: opt,
                    listeners: optionChangeListeners(opt),
                },
                subFieldCfg(sub),
            ],
        };
    }

    function subFieldCfg(sub) {
        if (!sub) {
            return { xtype: 'component', hidden: true };
        }
        return {
            xtype: 'component',
            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-2px 0 6px 164px;',
            html: enc(sub),
        };
    }

    // Collect the values of every rendered option field, keyed by option name.
    // The walk is per option name of the chosen provider (win._cloudOptionByName,
    // maintained by the rebuild) through each field's itemId — a ComponentQuery
    // over class names would be the one place ExtJS's whitespace-separated cls
    // and this harness's stub disagree, and the wire body must not depend on it.
    // A filtered-out (not rendered) option is simply absent.
    function renderedValues(win) {
        var out = {};
        var map = win._cloudOptionByName || {};
        for (var name in map) {
            if (!Object.prototype.hasOwnProperty.call(map, name)) {
                continue;
            }
            var cmp = null;
            try { cmp = win.down('#cloudOpt_' + name); } catch (e) { cmp = null; }
            if (!cmp) {
                continue;
            }
            out[name] = effectiveValue(cmp, map[name]);
        }
        return out;
    }

    // The required fields currently rendered (the gate for Test and Save).
    function requiredMissing(win) {
        var vals = renderedValues(win);
        for (var i = 0; i < (win._cloudRequired || []).length; i++) {
            var name = win._cloudRequired[i];
            if (!vals[name]) {
                return name;
            }
        }
        return '';
    }

    // Live gate: Test and Save stay disabled until the name is a valid remote
    // name, a type is chosen, and every REQUIRED rendered field carries a
    // value. A hidden (provider-filtered) required field cannot block — it is
    // not part of this form.
    function refreshDialogButtons(win) {
        var name = trim(valOf(win, '#cloudRemoteName') || '');
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        var missing = requiredMissing(win);
        var ok = REMOTE_NAME_RE.test(name) && !!type && !missing;
        try {
            var testBtn = win.down('#cloudTestBtn');
            if (testBtn) { testBtn.setDisabled(!ok); }
            var submit = win.down('#submit');
            if (submit) { submit.setDisabled(!ok); }
        } catch (e) {
            // Cosmetic — submit re-checks the gate before it sends.
        }
    }

    // Rebuild BOTH option containers from the chosen provider's schema,
    // keeping the values currently on the fields (a provider change may
    // add/remove filtered rows — what was typed elsewhere survives).
    function rebuildOptionFields(win, providers, isEdit, storedOptions) {
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        var prov = findProvider(providers, type);
        var basic = win.down('#cloudOptionsBasic');
        var adv = win.down('#cloudOptionsAdvanced');
        var oauth = win.down('#cloudOAuthNote');
        var other = win.down('#cloudOtherKeys');
        if (!basic || !adv) {
            return;
        }

        // The option-name → option map for THIS backend: the wire builder's
        // secret rule and the value walk both read it. Rebuilt per type pick.
        win._cloudOptionByName = {};
        if (prov) {
            var mapOpts = prov.options || [];
            for (var m = 0; m < mapOpts.length; m++) {
                if (mapOpts[m] && mapOpts[m].name) {
                    win._cloudOptionByName[mapOpts[m].name] = mapOpts[m];
                }
            }
        }

        var prev = renderedValues(win);
        var showAdv = valOf(win, '#cloudAdvanced') === true;
        var providerValue = prev.provider !== undefined ? prev.provider
            : ((storedOptions && storedOptions.provider) || '');

        var hasToken = false;
        var hasAdvanced = false;
        var basicRows = [];
        var advRows = [];
        var required = [];
        var known = {};

        if (prov) {
            var opts = prov.options || [];
            for (var i = 0; i < opts.length; i++) {
                var opt = opts[i];
                if (!opt || !opt.name) {
                    continue;
                }
                known[opt.name] = true;
                if (opt.name === 'token') {
                    hasToken = true;
                }
                if (opt.advanced === true && opt.name !== 'token') {
                    hasAdvanced = true;
                }
                // Provider filter: the row applies to this dialog only when
                // the filter matches the current provider value.
                if (!providerFilterMatches(opt.provider, providerValue)) {
                    continue;
                }
                // The token field is always visible (it lives with the OAuth
                // sentence) even when rclone types it advanced. Other advanced
                // rows are NOT BUILT until the toggle asks for them — a hidden
                // required field must never sit in the gate, and a stale
                // hidden field must never reach the wire.
                var toAdvanced = opt.advanced === true && opt.name !== 'token' && !showAdv;
                var value = prev[opt.name];
                if (value === undefined || value === '') {
                    var storedVal = (storedOptions && storedOptions[opt.name]) || '';
                    if (prev[opt.name] !== undefined && !toAdvanced) {
                        value = prev[opt.name]; // an explicit empty stays empty
                    } else if (opt.type === 'bool') {
                        // A checkbox cannot show "the default": it renders the
                        // EFFECTIVE value — stored if present, else rclone's
                        // default — so an untouched edit diffs against the
                        // same effective value and sends nothing.
                        value = storedVal !== '' ? storedVal
                            : (opt.default === 'true' ? 'true' : '');
                    } else {
                        value = opt.secret ? '' : storedVal;
                    }
                }
                if (toAdvanced) {
                    continue; // not built until the toggle asks for it
                }
                var cfg = optionFieldCfg(opt, value, isEdit);
                if (opt.required === true) {
                    required.push(opt.name);
                }
                if (opt.advanced === true && opt.name !== 'token') {
                    advRows.push(cfg); // below the toggle
                } else {
                    basicRows.push(cfg);
                }
            }
        }

        if (oauth) {
            oauth.setHidden(!hasToken);
            if (hasToken) {
                oauth.setHtml('<div style="color:var(--anas-warn,#b06a12);font-size:11px;margin:2px 0 8px 0;">'
                    + enc(oauthSentence(type)) + '</div>');
            }
        }

        try {
            basic.removeAll();
            basic.add(basicRows);
            adv.removeAll();
            adv.add(advRows);
            adv.setHidden(advRows.length === 0);
            // A backend with no advanced options has no toggle to offer.
            var advToggle = win.down('#cloudAdvanced');
            if (advToggle) {
                advToggle.setHidden(!hasAdvanced);
            }
        } catch (e) {
            ANAS.warn('cloud option fields build failed: ' + ANAS.errText(e));
        }

        // Foreign keys: on the remote but unknown to the schema (rclone
        // appends shell_type etc. on first connect). Read-only, kept, never
        // sent — the PUT diff walks rendered fields only.
        if (other) {
            var foreign = [];
            var stored = storedOptions || {};
            var k;
            for (k in stored) {
                if (Object.prototype.hasOwnProperty.call(stored, k) && !known[k]) {
                    foreign.push(k + ' = ' + stored[k]);
                }
            }
            var raw = win._cloudExisting;
            var secrets = (raw && raw.secretsSet) || [];
            for (var s = 0; s < secrets.length; s++) {
                if (!known[secrets[s]]) {
                    foreign.push(secrets[s] + ' (' + t('secret') + ')');
                }
            }
            other.setHidden(foreign.length === 0);
            if (foreign.length) {
                other.setHtml('<div style="font-size:11px;margin:8px 0 2px 0;">'
                    + enc(t('Other keys (kept as stored — rclone manages these)')) + '</div>'
                    + '<div style="font-family:monospace;font-size:11px;'
                    + 'color:var(--anas-muted,gray);padding:4px 8px;'
                    + 'background:rgba(127,127,127,0.1);border-radius:4px;">'
                    + foreign.map(function (f) { return enc(f); }).join('<br>') + '</div>');
            }
        }

        win._cloudRequired = required;
        refreshDialogButtons(win);
    }

    // The stored value an untouched edit diffs against. A bool with NO stored
    // key diffs against rclone's default (the effective value the checkbox
    // rendered) — otherwise a default-'true' box would look "changed" on every
    // edit and the PUT would carry it forever. Every other type diffs against
    // the raw stored key.
    function storedValueOf(stored, opt) {
        var v = (stored && stored[opt.name]) || '';
        if (v === '' && opt.type === 'bool') {
            return opt.default === 'true' ? 'true' : '';
        }
        return v;
    }

    // The options object the wire carries. `isCreate` shapes the create body
    // (non-empty values only); an update diffs the rendered fields against the
    // stored keys — changed keys only, a cleared non-secret field sent as ''
    // (= remove), a typed secret sent, an untouched secret absent (= keep).
    function wireOptions(win, isCreate, storedOptions) {
        var vals = renderedValues(win);
        var out = {};
        var stored = storedOptions || {};
        var k;
        for (k in vals) {
            if (!Object.prototype.hasOwnProperty.call(vals, k)) {
                continue;
            }
            var v = vals[k];
            var opt = win._cloudOptionByName[k];
            var isSecret = !!(opt && opt.secret);
            if (isCreate) {
                if (v !== '') {
                    out[k] = v;
                }
            } else if (isSecret) {
                // Write-only: only a TYPED value rides; blank = unchanged.
                if (v !== '') {
                    out[k] = v;
                }
            } else if (v !== storedValueOf(stored, opt)) {
                out[k] = v; // '' = remove the key
            }
        }
        return out;
    }

    // --- Test inside the dialog (inline, UNSAVED) ----------------------------

    function renderCloudTestResult(win, data) {
        var area = win.down('#cloudTestResult');
        if (!area) {
            return;
        }
        data = data || {};
        var verdict = '' + (data.verdict || '');
        var text = verdictSentence(verdict, data.message);
        var color = verdict === 'ok' ? 'var(--anas-ok,#1f9c56)'
            : verdict === 'not-found' ? 'var(--anas-warn,#b06a12)'
            : 'var(--anas-danger,#c23b2c)';
        try {
            area.removeAll();
            area.add({
                xtype: 'component',
                cls: 'anas-cloud-test-verdict',
                html: '<span style="color:' + color + ';">' + enc(text) + '</span>',
            });
        } catch (e) {
            ANAS.warn('cloud test render failed: ' + ANAS.errText(e));
        }
    }

    function runDialogTest(win, node) {
        var name = trim(valOf(win, '#cloudRemoteName') || '');
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        if (!REMOTE_NAME_RE.test(name) || !type || requiredMissing(win)) {
            return;
        }
        var area = win.down('#cloudTestResult');
        if (area) {
            try {
                area.removeAll();
                area.add({
                    xtype: 'component',
                    html: '<span style="color:var(--anas-muted,gray);">'
                        + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
                        + enc(t('testing remote…')) + '</span>',
                });
            } catch (e) {
                // non-fatal
            }
        }
        // Inline, unsaved: the daemon serves it from an env-defined remote —
        // nothing is written before the user saves.
        ANAS.api.post(node, '/cloud/remotes/test', {
            remote: { name: name, type: type, options: wireOptions(win, true, {}) },
        }).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            renderCloudTestResult(win, (res && res.data) || {});
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.warn('cloud remote test failed: ' + ANAS.errText(err));
            renderCloudTestResult(win, { verdict: 'error', message: ANAS.errText(err) });
        });
    }

    // --- Submit ---------------------------------------------------------------

    function submitRemote(win, node, mgrWin, isEdit) {
        var name = trim(valOf(win, '#cloudRemoteName') || '');
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        if (!REMOTE_NAME_RE.test(name) || name.length > 64) {
            ANAS.alertMsg('Invalid input',
                t('Name must start with a letter or digit; letters, digits, '
                    + 'underscore, dot and dash after that (≤64 chars).'));
            return;
        }
        if (!type) {
            ANAS.alertMsg('Invalid input', t('Choose a backend type.'));
            return;
        }
        if (requiredMissing(win)) {
            ANAS.alertMsg('Invalid input',
                t('Fill every required field (marked *).'));
            return;
        }
        var body;
        if (isEdit) {
            body = { options: wireOptions(win, false, win._cloudStoredOptions || {}) };
        } else {
            body = { name: name, type: type, options: wireOptions(win, true, {}) };
        }
        ANAS.runJob({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/cloud/remotes/' + encodeURIComponent(name)) : '/cloud/remotes',
            body: body,
            view: win,
            failTitle: isEdit ? 'Save failed' : 'Add failed',
            successMsg: isEdit ? (t('Remote saved') + ': ' + name)
                : (t('Remote added') + ': ' + name),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                if (mgrWin && mgrWin._reload) {
                    mgrWin._reload();
                }
            },
            // The dialog stays open for a retry; the manager grid reflects the
            // file's real state even on failure (the 0.3.3 lesson).
            onFailed: function () {
                if (mgrWin && mgrWin._reload) {
                    mgrWin._reload();
                }
            },
        });
    }

    function openRemoteEdit(node, mgrWin, existing, providers) {
        var isEdit = !!existing;
        var r = existing || {};
        var provs = providers || [];
        if (!provs.length) {
            ANAS.alertMsg('Load failed',
                t('The backend catalogue could not be loaded — reload the window and retry.'));
            return;
        }

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-cloud-remote-edit',
                title: isEdit ? (t('Edit Remote') + ': ' + (r.name || '')) : t('Add Remote'),
                modal: true,
                width: 560,
                height: 680,
                resizable: true,
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
                            itemId: 'cloudRemoteName',
                            cls: 'anas-fld-cloud-remote-name',
                            fieldLabel: t('Name'),
                            emptyText: 'offsite-b2',
                            disabled: isEdit,
                            allowBlank: false,
                            value: r.name || '',
                            regex: REMOTE_NAME_RE,
                            maxLength: 64,
                            regexText: t('Start with a letter or digit; letters, digits, '
                                + 'underscore, dot and dash after that.'),
                            listeners: { change: function () {
                                var w = this.up('window');
                                if (w && w._cloudRefresh) { w._cloudRefresh(); }
                            } },
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'cloudRemoteType',
                            cls: 'anas-fld-cloud-remote-type',
                            fieldLabel: t('Type'),
                            disabled: isEdit,
                            editable: false,
                            forceSelection: true,
                            queryMode: 'local',
                            displayField: 'name',
                            valueField: 'name',
                            allowBlank: false,
                            store: {
                                data: provs,
                                fields: ['name', 'description'],
                            },
                            listConfig: {
                                tpl: '<tpl for="."><div class="x-boundlist-item">'
                                    + '<b>{name}</b> — {description}</div></tpl>',
                            },
                            value: r.type || '',
                            emptyText: t('choose a backend'),
                            listeners: { change: function () {
                                var w = this.up('window');
                                if (w && w._cloudRebuild) { w._cloudRebuild(); }
                                if (w && w._cloudRefresh) { w._cloudRefresh(); }
                            } },
                        },
                        {
                            // OAuth backends: the sentence + the always-visible
                            // token field (rendered with the basic options).
                            xtype: 'component',
                            itemId: 'cloudOAuthNote',
                            cls: 'anas-cloud-oauth',
                            hidden: true,
                        },
                        {
                            xtype: 'container',
                            itemId: 'cloudOptionsBasic',
                            layout: 'anchor',
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'cloudAdvanced',
                            cls: 'anas-fld-cloud-advanced',
                            fieldLabel: t('Show advanced options'),
                            labelWidth: 200,
                            listeners: { change: function () {
                                var w = this.up('window');
                                if (w && w._cloudRebuild) { w._cloudRebuild(); }
                            } },
                        },
                        {
                            xtype: 'container',
                            itemId: 'cloudOptionsAdvanced',
                            layout: 'anchor',
                            hidden: true,
                        },
                        {
                            xtype: 'component',
                            itemId: 'cloudOtherKeys',
                            cls: 'anas-cloud-other-keys',
                            hidden: true,
                        },
                        {
                            xtype: 'button',
                            itemId: 'cloudTestBtn',
                            cls: 'anas-btn-cloud-remote-testconn',
                            text: t('Test'),
                            iconCls: 'fa fa-plug',
                            width: 120,
                            margin: '4 0 0 0',
                            disabled: true,
                            handler: function () { runDialogTest(win, node); },
                        },
                        {
                            xtype: 'container',
                            itemId: 'cloudTestResult',
                            cls: 'anas-cloud-test-result',
                            margin: '8 0 0 0',
                            layout: { type: 'vbox', align: 'stretch' },
                            minHeight: 24,
                            items: [{
                                xtype: 'component',
                                html: '<span style="color:var(--anas-muted,gray);font-size:12px;">'
                                    + enc(t('Test lists the remote once — nothing is written '
                                        + 'before you save.')) + '</span>',
                            }],
                        },
                    ],
                }],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: isEdit ? t('Save') : t('Add'),
                        itemId: 'submit',
                        cls: 'anas-btn-cloud-remote-save',
                        disabled: true,
                        handler: function () {
                            try {
                                submitRemote(win, node, mgrWin, isEdit);
                            } catch (e) {
                                ANAS.warn('cloud remote save failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('cloud remote edit window failed: ' + ANAS.errText(e));
            return;
        }

        win._cloudExisting = r;
        win._cloudStoredOptions = r.options || {};
        win._cloudRebuild = function () {
            rebuildOptionFields(win, provs, isEdit, win._cloudStoredOptions || {});
        };
        win._cloudRefresh = function () { refreshDialogButtons(win); };

        win.show();
        // The type combo's change listener does not fire for the initial
        // value — the first build happens here (the map inside it follows the
        // same pick).
        win._cloudRebuild();
    }

    ANAS.cloud = {
        openRemotes: openRemotesManager,
    };
})();
