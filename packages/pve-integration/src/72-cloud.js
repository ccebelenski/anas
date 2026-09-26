/*
 * ANAS — Cloud sync (rclone.1 + rclone.3 — 72-cloud.js).
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
 *     when rclone types it advanced). The toggle is a VIEW, not a filter:
 *     what was typed into an advanced row is kept when the toggle goes off
 *     (a per-dialog stash) and is sent with the rest — hiding a row the user
 *     filled must not silently discard it.
 *   - rclone.4 — a CURATED backend (the daemon's catalogue trim carries a
 *     `guide` sentence, from the ONE curation table in @anas/shared
 *     `cloud-guide.ts`) renders: the guide sentence, the essential fields in
 *     the primary section, the optional own-OAuth-client fields under a
 *     collapsed "Use your own OAuth client" fieldset (with its one sentence),
 *     and every other non-advanced option under a collapsed "More options"
 *     fieldset — the advanced toggle unchanged. The dialog stays a renderer:
 *     it holds no copy of the curation knowledge. An UNCURATED backend
 *     renders exactly as before (`essential` mirrors `!advanced`, no guide,
 *     both fieldsets empty and hidden).
 *   - an option with a non-empty `provider` filter shows only when the filter
 *     matches the current value of the backend's `provider` option (rclone's
 *     syntax: a comma list of provider values, or `!A,B` = all except) — so
 *     an S3 form shows ONE `region` row for the picked provider. Changing the
 *     provider option REBUILDS the rows, keeping what was typed — on the next
 *     tick, because the rebuild takes down the provider row itself and doing
 *     that inside ExtJS's own change flush kills the form (see
 *     optionChangeListeners). A backend that HAS a `provider` option requires
 *     one: with none picked the positive filters match nothing and only the
 *     `!A,B` rows survive, which is the wrong form — Save and Test wait for
 *     the pick.
 *   - `examples` → an editable combo (value + help); `type` `bool` → a
 *     checkbox; `int` → a number field; `secret` → a password field that is
 *     WRITE-ONLY: on edit it is blank with the emptyText "(unchanged)" and is
 *     sent only when typed. `required` marks the field and gates the buttons,
 *     EXCEPT a required secret the remote already stores (`secretsSet`): the
 *     blank "(unchanged)" box is not a missing value. A `bool` is NEVER a
 *     secret whatever rclone's name rule says (sftp/ftp `ask_password`): a
 *     checkbox has no "(unchanged)" state, so the write-only rule would pin
 *     it on forever.
 *   - keys the remote carries but the provider schema does not know (rclone
 *     appends keys of its own on first connect — a newer rclone's keys) are
 *     KEPT: shown read-only under "Other keys", never editable, never sent —
 *     an untouched PUT body cannot drop them because only rendered fields are
 *     diffed.
 *
 * Submit: create → POST /v1/cloud/remotes {name, type, options} (non-empty
 * values only, and a bool equal to rclone's own default is NOT a key — an
 * untouched form must not pin every default into the file); edit → PUT
 * /v1/cloud/remotes/:name {options} (changed keys only; a cleared non-secret
 * field sends '' = remove; an absent secret = unchanged). Both are jobs: the
 * manager grid reloads on success AND failure (the 0.3.3 lesson). Test runs
 * on the grid toolbar (the saved remote by name) and in the dialog: an ADD,
 * or an edit with a secret typed, rides inline (the daemon serves it from an
 * env-defined remote, nothing is written) — an edit with NO secret typed
 * tests the SAVED remote by name, because the inline envelope cannot carry
 * the stored secret and would read back a false "Authentication failed".
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
 * per-option field 'anas-fld-cloud-opt-<name>', guide note 'anas-cloud-guide',
 * OAuth note 'anas-cloud-oauth', own-client fieldset 'anas-fld-cloud-own-client',
 * more-options fieldset 'anas-fld-cloud-more',
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

    // Is this option a WRITE-ONLY secret? rclone's `IsPassword` and the
    // daemon's name rule both land on `opt.secret` — but a BOOL is never one.
    // A checkbox has no "(unchanged)" state: unticking it produces a value
    // like any other, and reading that as "keep what is stored" would make a
    // secret-by-NAME bool (sftp/ftp `ask_password` — the name ends in
    // `password`) impossible to turn off.
    function isSecretOption(opt) {
        return !!(opt && opt.secret && ('' + (opt.type || '')) !== 'bool');
    }

    // rclone's default for a bool, as the effective 'true' | 'false' string
    // the checkbox and the wire both speak.
    function boolDefault(opt) {
        return ('' + ((opt && opt.default) || '')) === 'true' ? 'true' : 'false';
    }

    // A shallow copy of an option with `required` forced on — the `provider`
    // row, which rclone does not flag required but the form cannot do without
    // (see the provider-filter note in the header).
    function requiredCopy(opt) {
        var out = {};
        var k;
        for (k in opt) {
            if (Object.prototype.hasOwnProperty.call(opt, k)) {
                out[k] = opt[k];
            }
        }
        out.required = true;
        return out;
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
            // Any OTHER failure is transient — the store was busy, a read
            // blew up. The window stays usable: the grid comes back and a
            // "not installed" note left over from an earlier 503 must not sit
            // there contradicting the alert the user is about to read.
            var stale = win.down('#cloudUnavailable');
            if (stale) { stale.setHidden(true); }
            if (grid) { try { grid.setHidden(false); } catch (eG) { /* non-fatal */ } }
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
        try { grid.setLoading(t('Testing') + ' ' + enc(name) + '…'); } catch (e) { /* non-fatal */ }
        ANAS.api.post(node, '/cloud/remotes/test', { name: name }).then(function (res) {
            try { grid.setLoading(false); } catch (e) { /* non-fatal */ }
            if (grid.destroyed || grid.destroying) {
                return;
            }
            var d = (res && res.data) || {};
            // The daemon's message is rclone's own text — encoded like the
            // in-dialog verdict (renderCloudTestResult), never raw markup.
            ANAS.toast(enc(verdictSentence(d.verdict, d.message)));
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
                        successMsg: t('Remote removed') + ': ' + enc(name),
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
                                sortable: false, menuDisabled: true,
                                renderer: function (v) { return enc(v); } },
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

    // The OAuth sentence — shown when the backend has a `token` option (the
    // token field always shows beneath it). Human-pass finding 2026-09-25:
    // `rclone authorize` prints THREE things — the `Paste the following …`
    // marker, the token JSON object, and `<---End paste` — and "paste its
    // output" sent users pasting all of it (or the object wrapped in the
    // quotes of a JSON-encoded string), which failed inside rclone with a Go
    // unmarshal error instead of a sentence. The sentence now names the block
    // and the two marker lines to leave out.
    function oauthSentence(type) {
        return t('This backend authorises through a browser. On a machine with '
            + 'one, run') + ' `rclone authorize "' + type + '"` '
            + t('and paste only the JSON block it prints, from the opening { to '
                + 'the closing }, into the token field. Leave out the "Paste the '
                + 'following" and "End paste" lines.');
    }

    // The inline refusal for a token field that never becomes a JSON object —
    // the field marks it, and Test and Save refuse with it.
    var OAUTH_TOKEN_ERROR = 'The token must be the JSON block rclone authorize '
        + 'prints, starting with { and ending with }';

    // Normalise a pasted `rclone authorize` output to the bare JSON object
    // text: trim; marker lines present → keep only what lies between them (in
    // practice the first { through the matching last }); one pair of double
    // quotes wrapping a JSON-encoded string → unwrapped ONCE; what remains
    // must JSON.parse to a PLAIN object (never a string, number or array —
    // the keys are the backend's business, not ours). An EMPTY value is
    // nothing to validate (the edit box's "(unchanged)"). Returns
    // { ok, value } — value is the text to send.
    function normalizeOAuthToken(text) {
        var s = trim(text == null ? '' : '' + text);
        if (!s) {
            return { ok: true, value: '' };
        }
        if (/Paste the following|End paste/.test(s)) {
            var start = s.indexOf('{');
            var end = s.lastIndexOf('}');
            if (start < 0 || end <= start) {
                return { ok: false, value: s };
            }
            s = trim(s.substring(start, end + 1));
        }
        if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
            var inner = null;
            try {
                inner = JSON.parse(s);
            } catch (eOuter) {
                inner = null;
            }
            if (typeof inner === 'string') {
                s = trim(inner);
            }
        }
        var obj = null;
        try {
            obj = JSON.parse(s);
        } catch (eParse) {
            obj = null;
        }
        var plain = obj !== null && typeof obj === 'object'
            && Object.prototype.toString.call(obj) !== '[object Array]';
        return { ok: plain, value: s };
    }

    // The token field's blur: normalise the paste IN PLACE — the field then
    // shows exactly what will be sent — and mark (or clear) the inline error.
    // Fail-open on the mark: the button gate and the send guards re-check the
    // value regardless of whether the field carries the mark API.
    function oauthTokenBlur(cmp) {
        var res = normalizeOAuthToken(cmp.getValue());
        try { cmp.setValue(res.value); } catch (eSet) { /* non-fatal */ }
        try {
            if (res.ok) {
                cmp.clearInvalid();
            } else {
                cmp.markInvalid(t(OAUTH_TOKEN_ERROR));
            }
        } catch (eMark) { /* non-fatal */ }
        var w = cmp.up('window');
        if (w && w._cloudRefresh) {
            w._cloudRefresh();
        }
        return res;
    }

    // The inline error for the token field's current value, '' when the field
    // is absent (a non-OAuth backend) or the value is absent / a JSON object.
    // The button gate reads it, so Test and Save wait for a valid paste.
    function oauthTokenProblem(win) {
        var cmp = null;
        try { cmp = win.down('#cloudOpt_token'); } catch (e) { cmp = null; }
        if (!cmp) {
            return '';
        }
        return normalizeOAuthToken(cmp.getValue()).ok ? '' : t(OAUTH_TOKEN_ERROR);
    }

    // Before Test and before Save: normalise the token paste in place and
    // refuse when it is not a JSON object — the inline error is the answer;
    // the send never happens with text the daemon would bounce.
    function normalizeTokenField(win) {
        var cmp = null;
        try { cmp = win.down('#cloudOpt_token'); } catch (e) { cmp = null; }
        if (!cmp) {
            return true;
        }
        return oauthTokenBlur(cmp).ok;
    }

    // ======================================================================
    //  The own-OAuth-client guard (rclone.4 rider, human-pass finding
    //  2026-09-26): a non-empty client_id silently overrides rclone's
    //  built-in client, and a refresh token issued by the built-in one can
    //  never be refreshed under a made-up one — the Test verdict cannot
    //  catch it (it does not refresh). The fields are validated HERE, on
    //  blur and before Test/Save, and the daemon re-checks at its doors.
    //  ES5 port of `validateOwnClient` in packages/shared/src/cloud-guide.ts
    //  — pinned to the shared vectors by the dialog-contracts harness.
    // ======================================================================

    // The pair refusal — the two fields are one decision, never either alone.
    var OWN_CLIENT_PAIR_ERROR = 'Client ID and client secret must be set together.';

    // The provider label a shape refusal names.
    var OWN_CLIENT_PROVIDERS = {
        drive: 'Google',
        onedrive: 'Microsoft',
        dropbox: 'Dropbox',
        box: 'Box',
        pcloud: 'pCloud',
    };

    // The client-id shape per provider; Dropbox, Box and pCloud publish no
    // stricter shape than this.
    function ownClientIdShape(backend, id) {
        if (backend === 'drive') {
            return /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id);
        }
        if (backend === 'onedrive') {
            return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        }
        return /^\S+$/.test(id);
    }

    function ownClientIdSentence(value, provider) {
        return t('The client ID \'' + value + '\' is not a ' + provider
            + ' OAuth client ID; leave both client fields empty to use rclone\'s '
            + 'built-in client, or paste the ID and secret of a client you created.');
    }

    // The shared rule: the fields must be empty (rclone's built-in client) or
    // name a real client of the provider — the id matches the provider's own
    // shape, and id and secret are set together. Returns { ok, message? }.
    function validateOwnClient(backend, options) {
        var provider = OWN_CLIENT_PROVIDERS[backend];
        if (!provider) {
            return { ok: true };
        }
        var id = trim((options && options.client_id == null) ? '' : '' + options.client_id);
        var secret = trim((options && options.client_secret == null) ? '' : '' + options.client_secret);
        if (id && !ownClientIdShape(backend, id)) {
            return { ok: false, message: ownClientIdSentence(id, provider) };
        }
        if (!!id !== !!secret) {
            return { ok: false, message: t(OWN_CLIENT_PAIR_ERROR) };
        }
        return { ok: true };
    }

    // The own-client values the dialog HOLDS (the stash + the rendered fields,
    // exactly what the wire body would carry) — the input the rule judges.
    function ownClientValues(win) {
        var vals = dialogValues(win);
        return { client_id: vals.client_id, client_secret: vals.client_secret };
    }

    // Mark (or clear) one option field's inline error. Fail-open on the mark:
    // the gate and the send guards re-check the values regardless of whether
    // the field carries the mark API.
    function markOptionField(win, name, message) {
        var cmp = null;
        try { cmp = win.down('#cloudOpt_' + name); } catch (e) { cmp = null; }
        if (!cmp) {
            return;
        }
        try {
            if (message) {
                cmp.markInvalid(message);
            } else {
                cmp.clearInvalid();
            }
        } catch (eMark) { /* non-fatal */ }
    }

    // Validate what the dialog holds against the chosen backend and mark the
    // offending field: the id on a shape refusal, the field that CARRIES the
    // value on a pair refusal. Returns the verdict.
    function ownClientMark(win) {
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        var vals = ownClientValues(win);
        var res = validateOwnClient(type, vals);
        var idMsg = '';
        var secretMsg = '';
        if (!res.ok) {
            if (trim(vals.client_id || '')) {
                idMsg = res.message;
            } else {
                secretMsg = res.message;
            }
        }
        markOptionField(win, 'client_id', idMsg);
        markOptionField(win, 'client_secret', secretMsg);
        return res.ok;
    }

    // The inline error for the current own-client values, '' when valid. The
    // button gate reads it, so Test and Save wait for a well-formed pair.
    function ownClientProblem(win) {
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        var res = validateOwnClient(type, ownClientValues(win));
        return res.ok ? '' : res.message;
    }

    // Snapshot every rendered option field's EFFECTIVE value (a string, or
    // '' when the field represents "nothing set"), so a rebuild on a
    // type/provider/advanced change keeps what was typed. Effective rules:
    //   bool     → 'true' | 'false' — ALWAYS the box's own state, never ''.
    //              A checkbox has no "nothing set": the wire builders decide
    //              whether that state is worth a key (create: only when it
    //              differs from rclone's default; update: only when it
    //              differs from what is stored).
    //   int      → '' | String(number)
    //   secret   → '' (never typed) | the typed value
    //   string   → the trimmed value
    function effectiveValue(cmp, opt) {
        var type = '' + (opt.type || '');
        if (type === 'bool') {
            return cmp.getValue() === true ? 'true' : 'false';
        }
        var v = cmp.getValue();
        if (type === 'int') {
            return (v === null || v === undefined || v === '') ? '' : String(v);
        }
        if (isSecretOption(opt)) {
            // Write-only: blank means unchanged/absent, never "clear".
            return (v === null || v === undefined) ? '' : String(v);
        }
        return trim(v);
    }

    // The change listeners every option field carries: any change refreshes
    // the button gate; a change of the backend's `provider` option REBUILDS
    // the rows outright (its filter decides which filtered rows apply —
    // region, endpoint, storage_class…).
    //
    // The provider rebuild is DEFERRED out of the change event, and that is
    // not a nicety: the `provider` row is one of the rows the rebuild's
    // removeAll() takes down, so a synchronous rebuild destroys the very
    // component ExtJS is still firing from. Its own post-change work then
    // reads the dead field — `checkDirty` → `getValue()` → "Cannot read
    // properties of null (reading 'isEmptyStore')" — and that throw escapes
    // mid-flush with Ext's global layout counter left suspended, so every row
    // added afterwards exists on the container and never renders. Live
    // symptom: the S3 form went blank the moment a provider was picked
    // (rclone.1; the sandbox harness has no layout engine and saw none of it).
    // A field's change handler must never tear its own field down.
    function optionChangeListeners(opt) {
        return { change: function () {
            var w = this.up('window');
            if (!w) {
                return;
            }
            if (opt.name === 'provider' && w._cloudRebuild) {
                deferRebuild(w);
                return;
            }
            if (w._cloudRefresh) {
                w._cloudRefresh();
            }
        } };
    }

    // Rebuild once ExtJS has finished firing the change that asked for it.
    // `Ext.defer` rather than setTimeout because this is ExtJS's own "leave
    // the event stack" verb, not a debounce. Coalesced — a burst of changes
    // rebuilds once — and a window closed in the meantime rebuilds nothing.
    function deferRebuild(win) {
        if (win._cloudRebuildPending) {
            return;
        }
        win._cloudRebuildPending = true;
        Ext.defer(function () {
            win._cloudRebuildPending = false;
            if (win.destroyed || win.destroying || !win._cloudRebuild) {
                return;
            }
            win._cloudRebuild();
        }, 1);
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

        // A secret that ALSO carries examples (s3 `sse_customer_key`) is a
        // password box first — a combo would put the value on screen.
        if (opt.examples && opt.examples.length && !isSecretOption(opt)) {
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
                    inputType: isSecretOption(opt) ? 'password' : 'text',
                    inputAttrTpl: isSecretOption(opt)
                        ? ANAS.noAutofill.secret.inputAttrTpl
                        : undefined,
                    emptyText: isSecretOption(opt)
                        ? (isEdit ? t('(unchanged)') : '')
                        : (opt.default || ''),
                    value: value || '',
                    // An int's box stays empty unless typed/stored — the
                    // default rides rclone's side, never forced in.
                    _anasOption: opt,
                    listeners: optionFieldListeners(opt),
                },
                subFieldCfg(sub),
            ],
        };
    }

    // The change listeners every option field carries — plus, on the token
    // field, the blur that normalises a pasted `rclone authorize` output in
    // place (the OAuth contract above). The token field is always a plain
    // text/password box (it is a secret, so the examples-combo branch above
    // never builds it) — this is its only home.
    function optionFieldListeners(opt) {
        var l = optionChangeListeners(opt);
        if (opt.name === 'token') {
            l.blur = function () { oauthTokenBlur(this); };
        }
        // The own-client pair (rclone.4 rider): the blur re-checks BOTH fields
        // and marks (or clears) the offender — the fields are one decision.
        if (opt.name === 'client_id' || opt.name === 'client_secret') {
            l.blur = function () {
                var w = this.up('window');
                if (w) {
                    ownClientMark(w);
                    if (w._cloudRefresh) {
                        w._cloudRefresh();
                    }
                }
            };
        }
        return l;
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

    // Every value the dialog HOLDS, rendered or not: the stash (what was typed
    // into an advanced row the toggle has since hidden) with the live fields
    // over it. The advanced toggle is a view, not a filter — a value the user
    // typed is kept and sent whether its row is on screen at submit or not.
    // The stash is pruned to the chosen backend's options on every rebuild, so
    // a key from a previously chosen type can never reach the wire.
    function dialogValues(win) {
        var out = {};
        var stash = win._cloudStash || {};
        var map = win._cloudOptionByName || {};
        var k;
        for (k in stash) {
            if (Object.prototype.hasOwnProperty.call(stash, k) && map[k]) {
                out[k] = stash[k];
            }
        }
        var rendered = renderedValues(win);
        for (k in rendered) {
            if (Object.prototype.hasOwnProperty.call(rendered, k)) {
                out[k] = rendered[k];
            }
        }
        return out;
    }

    // The required fields currently rendered (the gate for Test and Save).
    // A required SECRET the remote already stores is PRESENT, not missing: its
    // box is blank because the API never returns a secret value, and reading
    // that blank as "unfilled" would dead-lock Save and Test on every edit of
    // a backend whose required option is a secret (b2 `key`, koofr `password`).
    function requiredMissing(win) {
        var vals = dialogValues(win);
        var map = win._cloudOptionByName || {};
        var stored = (win._cloudExisting && win._cloudExisting.secretsSet) || [];
        for (var i = 0; i < (win._cloudRequired || []).length; i++) {
            var name = win._cloudRequired[i];
            if (vals[name]) {
                continue;
            }
            if (win._cloudIsEdit === true && isSecretOption(map[name])
                && indexOfName(stored, name) >= 0) {
                continue;
            }
            return name;
        }
        return '';
    }

    // Array#indexOf over strings — plain ES5, no Array.prototype assumptions.
    function indexOfName(list, name) {
        for (var i = 0; i < (list || []).length; i++) {
            if ('' + list[i] === '' + name) {
                return i;
            }
        }
        return -1;
    }

    // Live gate: Test and Save stay disabled until the name is a valid remote
    // name, a type is chosen, every REQUIRED rendered field carries a value,
    // the token field (an OAuth backend) is not sitting on a paste that never
    // becomes a JSON object, and the own-client pair is well formed (rclone.4
    // rider). A hidden (provider-filtered) required field cannot block — it is
    // not part of this form.
    function refreshDialogButtons(win) {
        var name = trim(valOf(win, '#cloudRemoteName') || '');
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        var missing = requiredMissing(win);
        var tokenErr = oauthTokenProblem(win);
        var ownClientErr = ownClientProblem(win);
        var ok = REMOTE_NAME_RE.test(name) && !!type && !missing && !tokenErr && !ownClientErr;
        try {
            var testBtn = win.down('#cloudTestBtn');
            if (testBtn) { testBtn.setDisabled(!ok); }
            var submit = win.down('#submit');
            if (submit) { submit.setDisabled(!ok); }
        } catch (e) {
            // Cosmetic — submit re-checks the gate before it sends.
        }
    }

    // The one sentence inside the own-OAuth-client group (rclone.4). Only a
    // curated backend with `ownClient` fields renders it.
    var OWN_CLIENT_SENTENCE = 'Optional. rclone\'s built-in client is shared '
        + 'by every rclone user and rate-limited; a client of your own avoids that.';

    // Rebuild BOTH option containers from the chosen provider's schema,
    // keeping the values currently on the fields (a provider change may
    // add/remove filtered rows — what was typed elsewhere survives).
    //
    // rclone.4 — on a CURATED backend (the daemon's catalogue trim carries
    // `guide`) the rows split four ways: the essential fields in the primary
    // container, the own-OAuth-client pair in its collapsed fieldset, every
    // other non-advanced option in the collapsed "More options" fieldset, and
    // the advanced ones behind the unchanged toggle. An UNCURATED backend
    // renders exactly as before — `essential` mirrors `!advanced`, so the
    // same routing lands every row where it always sat and both fieldsets
    // stay empty and hidden.
    function rebuildOptionFields(win, providers, isEdit, storedOptions) {
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        var prov = findProvider(providers, type);
        var basic = win.down('#cloudOptionsBasic');
        var adv = win.down('#cloudOptionsAdvanced');
        var oauth = win.down('#cloudOAuthNote');
        var other = win.down('#cloudOtherKeys');
        var guideNote = win.down('#cloudGuideNote');
        var ownGroup = win.down('#cloudOwnClientGroup');
        var moreGroup = win.down('#cloudMoreGroup');
        if (!basic || !adv) {
            return;
        }

        // Curation is what the daemon's trim MARKS (`curated: true`, review
        // batch B — an OAuth backend's guide sentence was dropped so the token
        // sentence stands alone, and `guide` can no longer be the marker);
        // `guide` stays in the check only for an older daemon's payload.
        var curated = !!(prov && (prov.curated || prov.guide));
        var isOwnClient = {};
        var ownClientList = (curated && prov.ownClient) || [];
        var iOwn;
        for (iOwn = 0; iOwn < ownClientList.length; iOwn++) {
            isOwnClient[ownClientList[iOwn]] = true;
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

        // The stash: everything the dialog holds. Merged from the LIVE fields
        // at the top of every rebuild, then pruned to this backend's options —
        // so a value typed into an advanced row survives the toggle going off
        // and on, while a key belonging to a type the user has moved away from
        // is dropped rather than carried to the wire.
        var stash = win._cloudStash || {};
        var fresh = renderedValues(win);
        var sk;
        for (sk in fresh) {
            if (Object.prototype.hasOwnProperty.call(fresh, sk)) {
                stash[sk] = fresh[sk];
            }
        }
        for (sk in stash) {
            if (Object.prototype.hasOwnProperty.call(stash, sk) && !win._cloudOptionByName[sk]) {
                delete stash[sk];
            }
        }
        win._cloudStash = stash;

        var showAdv = valOf(win, '#cloudAdvanced') === true;
        var providerValue = stash.provider !== undefined ? stash.provider
            : ((storedOptions && storedOptions.provider) || '');

        var hasToken = false;
        var hasAdvanced = false;
        var basicRows = [];
        var advRows = [];
        var ownRows = [];
        var moreRows = [];
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
                // required field must never sit in the gate. What was TYPED
                // into one stays in the stash and still reaches the wire: the
                // toggle hides a row, it does not discard its value.
                if (opt.advanced === true && opt.name !== 'token' && !showAdv) {
                    continue;
                }
                // The stash is the authority for a value this dialog already
                // holds — an explicit empty included (a cleared field stays
                // cleared). Only a key the dialog has never touched falls back
                // to the stored remote.
                var value = stash[opt.name];
                if (value === undefined) {
                    var storedVal = (storedOptions && storedOptions[opt.name]) || '';
                    if (opt.type === 'bool') {
                        // A checkbox cannot show "the default": it renders the
                        // EFFECTIVE value — stored if present, else rclone's
                        // default — so an untouched edit diffs against the
                        // same effective value and sends nothing.
                        value = storedVal !== '' ? storedVal : boolDefault(opt);
                    } else {
                        value = isSecretOption(opt) ? '' : storedVal;
                    }
                }
                // A backend that HAS a `provider` option cannot be configured
                // without one: with none picked every positive filter misses
                // and only the `!A,B` rows survive — the wrong form. Mark the
                // row required so Save and Test wait for the pick.
                var effOpt = opt.name === 'provider' ? requiredCopy(opt) : opt;
                var cfg = optionFieldCfg(effOpt, value, isEdit);
                if (effOpt.required === true) {
                    required.push(opt.name);
                }
                if (opt.advanced === true && opt.name !== 'token') {
                    advRows.push(cfg); // below the toggle
                } else if (opt.name === 'token') {
                    basicRows.push(cfg); // the token's home is with its sentence
                } else if (curated && isOwnClient[opt.name]) {
                    ownRows.push(cfg); // collapsed own-OAuth-client fieldset
                } else if (opt.essential === true) {
                    basicRows.push(cfg); // the primary section
                } else if (curated) {
                    moreRows.push(cfg); // collapsed "More options" fieldset
                } else {
                    basicRows.push(cfg); // uncurated fallback (a payload without essential)
                }
            }
        }

        if (guideNote) {
            // Only a curated backend WITH a sentence renders one (review batch
            // B: the OAuth backends are curated without a `guide` — the token
            // sentence below is their only instruction).
            guideNote.setHidden(!(curated && prov.guide));
            if (curated && prov.guide) {
                guideNote.setHtml('<div style="color:var(--anas-muted,gray);font-size:11px;margin:2px 0 8px 0;">'
                    + enc(prov.guide) + '</div>');
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
            // The two collapsed groups of a curated backend (rclone.4). The
            // own-client group opens with its one sentence; "More options"
            // holds every other non-advanced row. A fieldset holds its fields
            // even collapsed — a typed value is read at submit regardless of
            // the collapsed state, the same "a view, not a filter" rule the
            // advanced toggle follows.
            if (ownGroup) {
                ownGroup.removeAll();
                if (ownRows.length) {
                    ownGroup.add([{
                        xtype: 'component',
                        cls: 'anas-cloud-ownclient-note',
                        html: '<div style="color:var(--anas-muted,gray);font-size:11px;margin:2px 0 8px 0;">'
                            + enc(t(OWN_CLIENT_SENTENCE)) + '</div>',
                    }].concat(ownRows));
                }
                ownGroup.setHidden(ownRows.length === 0);
            }
            if (moreGroup) {
                moreGroup.removeAll();
                moreGroup.add(moreRows);
                moreGroup.setHidden(moreRows.length === 0);
            }
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
        if (opt.type === 'bool') {
            return v !== '' ? v : boolDefault(opt);
        }
        return v;
    }

    // The options object the wire carries. `isCreate` shapes the create body
    // (non-empty values only, and NO bool that already matches rclone's own
    // default — an untouched form must not pin every default into the file);
    // an update diffs what the dialog holds against the stored keys — changed
    // keys only, a cleared non-secret field sent as '' (= remove), a typed
    // secret sent, an untouched secret absent (= keep).
    function wireOptions(win, isCreate, storedOptions) {
        var vals = dialogValues(win);
        var out = {};
        var stored = storedOptions || {};
        var k;
        for (k in vals) {
            if (!Object.prototype.hasOwnProperty.call(vals, k)) {
                continue;
            }
            var v = vals[k];
            var opt = win._cloudOptionByName[k];
            if (isCreate) {
                if (opt && opt.type === 'bool') {
                    if (v !== boolDefault(opt)) {
                        out[k] = v;
                    }
                } else if (v !== '') {
                    out[k] = v;
                }
            } else if (isSecretOption(opt)) {
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

    // Has the user typed into ANY secret field of this dialog?
    function anySecretTyped(win) {
        var vals = dialogValues(win);
        var map = win._cloudOptionByName || {};
        var k;
        for (k in vals) {
            if (Object.prototype.hasOwnProperty.call(vals, k)
                && isSecretOption(map[k]) && vals[k] !== '') {
                return true;
            }
        }
        return false;
    }

    // What the dialog's Test sends.
    //
    // An ADD has no stored remote, so the whole dialog rides inline and the
    // daemon serves it from an env-defined remote — nothing is written before
    // the user saves.
    //
    // An EDIT is different: the dialog CANNOT read a stored secret back (the
    // API only names it), so an inline envelope would test a remote with no
    // password and report "Authentication failed" on a remote that is fine.
    // With nothing typed into a secret, Test names the SAVED remote and the
    // daemon reads the stored value. Once a secret IS typed, the point is to
    // try that value before saving it — so the inline envelope comes back,
    // carrying the typed values over the stored non-secret options.
    function testBody(win, name, type) {
        var inline = wireOptions(win, true, {});
        if (win._cloudIsEdit !== true) {
            return { remote: { name: name, type: type, options: inline } };
        }
        if (!anySecretTyped(win)) {
            return { name: name };
        }
        var merged = {};
        var stored = win._cloudStoredOptions || {};
        var k;
        for (k in stored) {
            if (Object.prototype.hasOwnProperty.call(stored, k)) {
                merged[k] = stored[k];
            }
        }
        for (k in inline) {
            if (Object.prototype.hasOwnProperty.call(inline, k)) {
                merged[k] = inline[k];
            }
        }
        return { remote: { name: name, type: type, options: merged } };
    }

    function runDialogTest(win, node) {
        var name = trim(valOf(win, '#cloudRemoteName') || '');
        var type = trim(valOf(win, '#cloudRemoteType') || '');
        if (!REMOTE_NAME_RE.test(name) || !type || requiredMissing(win)) {
            return;
        }
        if (!normalizeTokenField(win)) {
            return;
        }
        if (!ownClientMark(win)) {
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
        ANAS.api.post(node, '/cloud/remotes/test', testBody(win, name, type)).then(function (res) {
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
        if (!normalizeTokenField(win)) {
            return;
        }
        if (!ownClientMark(win)) {
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
            successMsg: isEdit ? (t('Remote saved') + ': ' + enc(name))
                : (t('Remote added') + ': ' + enc(name)),
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
                title: isEdit ? (t('Edit Remote') + ': ' + enc(r.name || '')) : t('Add Remote'),
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
                            // Curated backends (rclone.4): the one sentence
                            // naming where the essential values come from.
                            xtype: 'component',
                            itemId: 'cloudGuideNote',
                            cls: 'anas-cloud-guide',
                            hidden: true,
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
                            // Curated backends: the optional own-OAuth-client
                            // fields, collapsed (rclone.4).
                            xtype: 'fieldset',
                            itemId: 'cloudOwnClientGroup',
                            cls: 'anas-fld-cloud-own-client',
                            title: t('Use your own OAuth client'),
                            collapsible: true,
                            collapsed: true,
                            hidden: true,
                            layout: 'anchor',
                            defaults: { anchor: '100%', labelWidth: 160 },
                        },
                        {
                            // Curated backends: every other non-advanced
                            // option, collapsed (rclone.4).
                            xtype: 'fieldset',
                            itemId: 'cloudMoreGroup',
                            cls: 'anas-fld-cloud-more',
                            title: t('More options'),
                            collapsible: true,
                            collapsed: true,
                            hidden: true,
                            layout: 'anchor',
                            defaults: { anchor: '100%', labelWidth: 160 },
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
        win._cloudIsEdit = isEdit;
        win._cloudStoredOptions = r.options || {};
        win._cloudStash = {};
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

    // ======================================================================
    //  Cloud Sync tasks (rclone.3) — grid, wizard, detail, Run now
    // ======================================================================
    //
    // The Cloud Sync MENU, built as Backup is (DESIGN "Cloud sync — rclone" →
    // Workflow): the Tasks grid with the toolbar (Create, Edit, Remove, Run
    // now, Enable/Disable, Remotes…), the Remotes manager window behind the
    // Remotes… button, the task wizard and the display-only detail window.
    //
    // DAEMON CONTRACT (packages/shared/src/schemas/cloud.ts):
    //
    //   GET    /v1/cloud/tasks         → { data: [task + lastRunResult,
    //                                    lastRunAt, nextRunAt, overdue] }
    //   GET    /v1/cloud/tasks/:name   → { data: CloudSyncTaskDetail — task,
    //                                    consistency?, nested?, unit, timer,
    //                                    journal?, statusNote? }
    //   POST   /v1/cloud/tasks         → 202 { job } (remote must exist,
    //                                    schedule validated by
    //                                    systemd-analyze — the 400 sentences
    //                                    ride the job-failure alert)
    //   PUT    /v1/cloud/tasks/:name   → 202 { job } (update / enable / disable)
    //   DELETE /v1/cloud/tasks/:name   → 202 { job } (units only — nothing on
    //                                    the remote is touched)
    //   POST   /v1/cloud/tasks/:name/run → 202 { job } (Run now)
    //   POST   /v1/jobs/:id/cancel     → 409 + confirm code (the headline and
    //                                    what a stop leaves behind), then 202
    //                                    { job } (Cancel run — rclone.5; the
    //                                    shared ANAS.sched.cancelRun door)
    //   POST   /v1/cloud/tasks/preview → { data: CloudSyncPreviewResult } (the
    //                                    dry run — the unsaved form inline or
    //                                    {name}; a 400 guard refusal carries the
    //                                    run's own sentence)
    //
    // The grid derives everything from unit + timer state per load (no shadow
    // state) and RELOADS after every job of its own, success AND failure (the
    // 0.3.3 lesson). The one display-side exception is the failed Last run
    // cell's tooltip: the grid payload carries no error line, so the tooltip
    // holds the error of the run the user just watched from this grid
    // (session-only, keyed on the grid's store, never persisted).

    var TASK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

    // The one sentence under the Mode radios, verbatim from the design.
    var SYNC_SENTENCE = 'Sync deletes files at the destination that are no longer '
        + 'in the source. Copy never deletes.';

    // The guiding toast when a create is attempted with no remote saved (the
    // backup precedent: "Register a PBS repository first (Repositories…).").
    var EMPTY_REMOTES_TOAST = 'Add a remote first (Remotes…)';

    // The nested note's lead — the daemon's own run-time sentence, said BEFORE
    // the save: a snapshot captures one filesystem. Rendered as "Contains N
    // nested filesystems that will not be included: <paths>".
    function nestedNote(n) {
        return n + ' ' + (n === 1 ? t('nested filesystem') : t('nested filesystems'))
            + ' ' + t('that will not be included');
    }

    // Relative + absolute time. absTime delegates to the schedules common
    // module (one formatter everywhere a schedules view prints a timestamp);
    // relTime is the small per-file wrapper every screen carries.
    function relTime(iso) {
        if (iso === undefined || iso === null || iso === '') {
            return '';
        }
        try {
            var ms = new Date(iso).getTime();
            if (isNaN(ms)) {
                return '';
            }
            var diff = Date.now() - ms;
            var future = diff < 0;
            var s = Math.abs(diff) / 1000;
            var out;
            if (s < 60) {
                out = Math.round(s) + 's';
            } else if (s < 3600) {
                out = Math.round(s / 60) + 'm';
            } else if (s < 86400) {
                out = Math.round(s / 3600) + 'h';
            } else {
                out = Math.round(s / 86400) + 'd';
            }
            return future ? (t('in') + ' ' + out) : (out + ' ' + t('ago'));
        } catch (e) {
            return '';
        }
    }

    function absTime(iso) {
        try {
            return ANAS.sched.absTime(iso);
        } catch (e) {
            return '' + (iso == null ? '' : iso);
        }
    }

    // The state pills — the schedules common module's, so the Cloud Sync grid
    // reads exactly like the Backup grid's (parallel construction).
    function pillHtml(label, color, title) {
        return ANAS.sched.pillHtml(label, color, title);
    }

    function softPill(label, color, title) {
        return ANAS.sched.softPill(label, color, title);
    }

    // Split a multiline excludes blob into a trimmed, non-empty pattern array.
    function splitLines(v) {
        var out = [];
        var lines = ('' + (v == null ? '' : v)).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var s = trim(lines[i]);
            if (s) {
                out.push(s);
            }
        }
        return out;
    }

    function destinationOf(task) {
        task = task || {};
        return '' + (task.remote || '') + ':' + (task.path || '');
    }

    // Flatten a task (+ its LOCAL-ONLY runtime status) into a grid record; the
    // raw task rides under 'raw' so edit / toggle round-trip it.
    function taskRow(entry) {
        entry = entry || {};
        var task = entry.task || entry;
        return {
            name: task.name,
            source: task.source || '',
            remote: task.remote || '',
            path: task.path || '',
            destination: destinationOf(task),
            mode: task.mode === 'sync' ? 'sync' : 'copy',
            excludes: task.excludes || [],
            bwlimit: task.bwlimit || '',
            notify: task.notify === 'on-failure' ? 'on-failure' : 'always',
            schedule: task.schedule || '',
            cadence: ANAS.sched.cadence.of(task),
            enabled: task.enabled !== false,
            lastRunResult: entry.lastRunResult || 'unknown',
            lastRunAt: entry.lastRunAt,
            nextRunAt: entry.nextRunAt,
            overdue: entry.overdue === true,
            runningProgress: entry.runningProgress || '',
            // rclone.5: the running direct job Cancel run targets, and a
            // cancelled run's "cancelled by <user> at <time>".
            runningJobId: entry.runningJobId || '',
            lastRunNote: entry.lastRunNote || '',
            raw: task,
        };
    }

    // ---- Renderers ---------------------------------------------------------

    // A structured cadence reads in words (it says which weeks a biweekly task
    // runs — the thing the OnCalendar expression cannot); a raw schedule reads
    // as the expression itself. Either way the generated expression is in the
    // tooltip, never truncated.
    function renderSchedule(v, meta, rec) {
        var s = '' + (v == null ? '' : v);
        var text = ANAS.sched.cadence.text(rec ? rec.get('cadence') : null);
        if (!s && !text) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        if (text) {
            return '<span title="' + enc(text + (s ? ' — OnCalendar: ' + s : '')) + '">'
                + enc(text) + '</span>';
        }
        return '<span title="' + enc(s) + '" style="font-family:monospace;font-size:0.92em;">'
            + enc(s) + '</span>';
    }

    function renderName(v) {
        var s = '' + (v == null ? '' : v);
        return '<span title="' + enc(s) + '">' + enc(s) + '</span>';
    }

    function renderSource(v) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        return '<span title="' + enc(s) + '" style="font-family:monospace;font-size:0.9em;">'
            + enc(s) + '</span>';
    }

    // "remote:path", whole and monospace — never truncated.
    function renderDestination(v) {
        var d = '' + (v == null ? '' : v);
        if (!d || d === ':') {
            return '<span style="color:gray;">&mdash;</span>';
        }
        return '<span title="' + enc(d) + '" style="font-family:monospace;font-size:0.92em;">'
            + enc(d) + '</span>';
    }

    // copy is the default and the mode that cannot destroy anything — muted;
    // sync wears the accent (it deletes, and the sentence under the radios in
    // the wizard is the one thing to have read).
    function renderMode(v) {
        if (v === 'sync') {
            return pillHtml(t('sync'), 'var(--anas-accent,#3468c0)',
                t(SYNC_SENTENCE));
        }
        return '<span style="color:var(--anas-muted,gray);">' + enc(t('copy')) + '</span>';
    }

    // rclone.3 human-pass finding 2 — the running direct job's live stats line
    // is rendered by THE one helper, `ANAS.sched.runningProgressHtml` in
    // 69-schedules-common.js (rclone.6 review batch B: the Backup grid's copy
    // and this one could only drift; both grids delegate now).

    // rclone.6 — the row's tiny spark: beside the running progress text, from
    // the running job's detail the grid polls every 5 s while a running row is
    // on screen (one interval per grid). The detail is read from the GRID's
    // per-task map (`rowDetails`, review batch B) — NOT from the record: the
    // 10 s quiet reload replaces records and would blink the spark away. The
    // same stalled label the viewer and the jobs strip show — one helper
    // everywhere.
    function runningDetailSparkHtml(rec, rowDetails) {
        var d = (rowDetails && rec && rec.get) ? rowDetails[rec.get('name')] : null;
        if (!d || !d.speedSamples || !d.speedSamples.length) {
            return '';
        }
        return ' ' + ANAS.gfx.sparkFromSamples(d.speedSamples, {
            size: 'tiny',
            title: t('throughput, last 5 minutes'),
        })
            + ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
            + speedHtml(d.speed) + '</span> ' + ANAS.gfx.stalledHtml(d);
    }

    // Last run: a result pill + the relative time, as the Backup grid renders
    // it. A FAILED run's cell carries rclone's last error line as the tooltip —
    // the line the notification body shows. The grid payload names no error
    // line, so the tooltip reads the run this user started from this grid
    // (runTaskNow records it through the shared session store, keyed to the
    // run); a run started by the timer, or a later run than the one that
    // failed, shows the time and where the history is instead. `rowDetails` is
    // the grid's per-task map of polled run detail (rclone.6 review batch B).
    function renderLastRun(v, meta, rec, rowDetails) {
        var result = '' + (rec.get('lastRunResult') || 'unknown');
        var at = rec.get('lastRunAt');
        var overdue = rec.get('overdue') === true;
        var pill;
        if (result === 'success' && !overdue) {
            pill = pillHtml(t('success'), 'var(--anas-ok,#1f9c56)', absTime(at));
        } else if (result === 'skipped' && !overdue) {
            pill = pillHtml(t('skipped (off week)'), 'var(--anas-muted,gray)',
                t('An off-week fire of an every-other-week task — nothing was copied, '
                    + 'and nothing is wrong.') + (at ? ' ' + absTime(at) : ''));
        } else if (result === 'failure') {
            pill = pillHtml(t('failure'), 'var(--anas-danger,#c23b2c)',
                ANAS.sched.runErrorTip(rec.store, rec.get('name'), at));
        } else if (result === 'running') {
            var rp = ANAS.sched.runningProgressHtml(rec);
            // rclone.6: the running text IS the viewer door — the pill carries
            // the task name so the grid's cellclick can open the run viewer.
            var runView = rec.get('runningJobId')
                ? ' data-anas-run-view="' + enc(rec.get('name')) + '"'
                : '';
            pill = '<span' + runView + ' title="' + enc(rp.tip) + '"'
                + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
                + 'color:#fff;background:var(--anas-accent,#3468c0);cursor:pointer;">'
                + '<i class="fa fa-refresh fa-spin" aria-hidden="true" style="margin-right:4px;"></i>'
                + enc(t('running')) + '</span>' + rp.html + runningDetailSparkHtml(rec, rowDetails);
        } else if (result === 'cancelled' && !overdue) {
            // rclone.5: stopped from the toolbar — the shared neutral pill,
            // who and when in the tooltip.
            pill = ANAS.sched.cancelledPill(rec);
        } else if (result === 'disabled') {
            // A disabled task's run history is garbage-collected by systemd;
            // say there is none (the sentence the detail repeats).
            pill = softPill(t('disabled'), 'var(--anas-muted,gray)',
                t('run history is not retained while a task is disabled'));
        } else if (result === 'never-run') {
            pill = softPill(t('never run'), 'var(--anas-muted,gray)',
                t('this task has not run yet'));
        } else if (overdue) {
            pill = pillHtml(t('overdue'), 'var(--anas-danger,#c23b2c)',
                t('Past its schedule without a successful run — treated as failed.'));
        } else {
            pill = pillHtml(t('unknown'), 'var(--anas-muted,gray)', '');
        }
        var rel = at ? relTime(at) : '';
        if (rel) {
            pill += ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">' + enc(rel) + '</span>';
        }
        return pill;
    }

    function renderNextRun(v, meta, rec) {
        var at = rec.get('nextRunAt');
        var overdue = rec.get('overdue') === true;
        if (!at) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var rel = relTime(at);
        var color = overdue ? 'var(--anas-danger,#c23b2c)' : '';
        return '<span title="' + enc(absTime(at)) + '"'
            + (color ? ' style="color:' + color + ';font-weight:600;"' : '') + '>'
            + enc(rel || absTime(at)) + '</span>';
    }

    function renderEnabled(v) {
        return v !== false
            ? '<span style="color:var(--anas-ok,#1f9c56);">' + enc(t('yes')) + '</span>'
            : '<span style="color:var(--anas-muted,gray);">' + enc(t('no')) + '</span>';
    }

    // ---- Grid load / selection / buttons ------------------------------------

    function selectedTask(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function gridOf(view) {
        try {
            return view ? view.down('#cloudTasksGrid') : null;
        } catch (e) {
            return null;
        }
    }

    function setDisabled(grid, itemId, disabled) {
        try {
            var btn = grid.down('#' + itemId);
            if (btn) {
                btn.setDisabled(!!disabled);
            }
        } catch (e) {
            // non-fatal
        }
    }

    function updateTaskButtons(grid) {
        var rec = selectedTask(grid);
        var has = !!rec;
        // rclone.3 human-pass finding 1: a run already in flight refuses Run
        // now with a 409 naming it — the toolbar says so first (the gate stays
        // at the API; the button is the display, never the safety).
        var running = has && rec.get('lastRunResult') === 'running';
        setDisabled(grid, 'cloudTaskRun', !has || running);
        // rclone.6: View run on the running row while its direct job is named —
        // the same gate Cancel run reads (the pill on the row opens it too).
        setDisabled(grid, 'cloudTaskViewRun', !(running && rec.get('runningJobId')));
        // rclone.5: Cancel run is the running row's verb — and only while the
        // daemon names the direct job to stop (the API gate still decides).
        setDisabled(grid, 'cloudTaskCancel', !ANAS.sched.cancellable(rec));
        setDisabled(grid, 'cloudTaskPreview', !has);
        setDisabled(grid, 'cloudTaskDetails', !has);
        setDisabled(grid, 'cloudTaskEdit', !has);
        setDisabled(grid, 'cloudTaskToggle', !has);
        setDisabled(grid, 'cloudTaskRemove', !has);
        try {
            var toggle = grid.down('#cloudTaskToggle');
            if (toggle) {
                var on = has && rec.get('enabled');
                toggle.setText(on ? t('Disable') : t('Enable'));
                toggle.setIconCls(on ? 'fa fa-pause' : 'fa fa-play');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // `quiet` skips the loading mask — the timed poll refreshes in place.
    // `selName` (optional) selects that row after the load — the create's
    // "the new row selected" contract.
    function loadTasks(view, node, quiet, selName) {
        var grid = gridOf(view);
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        if (!quiet) {
            try {
                grid.setLoading(true);
            } catch (e) {
                // non-fatal
            }
        }
        var priorSel = selectedTask(grid);
        var priorName = selName || (priorSel ? priorSel.get('name') : null);

        ANAS.api.get(node, '/cloud/tasks').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!quiet) {
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
            }
            var list = (res && res.data) || [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(taskRow(list[i]));
            }
            // A 503 from an earlier load hid the grid — a working read brings
            // it back and clears the note that contradicts it.
            var unavail = view ? view.down('#cloudTasksUnavailable') : null;
            if (unavail) { unavail.setHidden(true); }
            try { grid.setHidden(false); } catch (eG) { /* non-fatal */ }
            // The run-error tooltips live on the STORE, which survives a
            // loadData — a reload must not forget what this user watched fail.
            var store = grid.getStore();
            grid.anasReloading = true;
            try {
                store.loadData(rows);
            } catch (e2) {
                ANAS.warn('cloud tasks grid load failed: ' + ANAS.errText(e2));
            }
            if (priorName) {
                try {
                    var idx = store.findExact('name', priorName);
                    if (idx >= 0) {
                        grid.getSelectionModel().select(idx, false, true);
                    }
                } catch (eSel) {
                    // non-fatal
                }
            }
            grid.anasReloading = false;
            updateTaskButtons(grid);
            // The row-detail poll reads the grid's per-task map (rclone.6
            // review batch B) — the view hands its own bag over on the first
            // load, so every reload path lands detail in the SAME object the
            // row renderer reads.
            grid._anasRowDetailBag = grid._anasRowDetailBag
                || (view && view._anasRowDetailBag) || {};
            // The row-detail timer stops with the view (hide, deactivate, tab
            // hidden — wherever sched.stopPolling stops) and restarts with the
            // grid's own polling, which this load is (review batch B).
            if (view && !view._anasRowTimerStop) {
                view._anasRowTimerStop = function () {
                    stopRowDetailPoll(gridOf(view));
                };
            }
            scheduleRowDetailPoll(grid, node, grid._anasRowDetailBag);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.anasReloading = false;
            if (!quiet) {
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
            }
            // No rclone on this node (503): the daemon's sentence takes the
            // grid's place; any other failure is transient — warn and keep the
            // last good rows.
            if (err && err.status === 503) {
                var unavail = view ? view.down('#cloudTasksUnavailable') : null;
                if (unavail) {
                    unavail.setHidden(false);
                    unavail.setHtml('<div style="max-width:520px;margin:24px auto;'
                        + 'color:var(--anas-warn,#b06a12);font-size:13px;">'
                        + enc(ANAS.errText(err)) + '</div>');
                }
                if (grid) {
                    try { grid.setHidden(true); } catch (eG) { /* non-fatal */ }
                }
                return;
            }
            ANAS.warn('cloud tasks load failed: ' + ANAS.errText(err));
        });
    }

    // ---- The running rows' live detail (rclone.6) ---------------------------

    var ROW_DETAIL_POLL_MS = 5000;

    // The polled detail lives on the GRID's per-task map (`rowDetails`: task
    // name → run detail), never on the store record — the 10 s quiet reload
    // replaces records and a record-held detail would blink the tiny spark
    // away on every one (review batch B). ONE bag per grid, in memory only.
    function stopRowDetailPoll(grid) {
        if (grid && grid._anasRowTimer) {
            clearInterval(grid._anasRowTimer);
            grid._anasRowTimer = null;
        }
    }

    // ONE interval per grid, started when a running row with a known job is on
    // screen and stopped the moment there is none (or the grid dies, or the
    // view hides/deactivates — sched.stopPolling's `_anasRowTimerStop` hook):
    // each tick polls the running rows' jobs and lands the detail in the map,
    // where the row renderer reads its tiny spark and the stalled label. A row
    // that stops running has its map entry DROPPED at the next tick — the
    // renderer only draws a spark while the pill says running.
    function scheduleRowDetailPoll(grid, node, rowDetails) {
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        var store = grid.getStore();
        var running = [];
        try {
            store.each(function (rec) {
                if (rec.get('lastRunResult') === 'running' && rec.get('runningJobId')) {
                    running.push(rec);
                }
            });
        } catch (e) {
            return;
        }
        if (!running.length) {
            stopRowDetailPoll(grid);
            return;
        }
        var started = !grid._anasRowTimer;
        if (started) {
            grid._anasRowTimer = setInterval(function () {
                if (grid.destroyed || grid.destroying) {
                    stopRowDetailPoll(grid);
                    return;
                }
                tickRowDetail(grid, node, rowDetails);
            }, ROW_DETAIL_POLL_MS);
        }
        // An immediate first tick, but ONLY when the interval is newly started
        // — a routine reload must not double-poll rows it just refreshed.
        if (started) {
            tickRowDetail(grid, node, rowDetails);
        }
    }

    function tickRowDetail(grid, node, rowDetails) {
        var store = grid.getStore();
        var jobs = [];
        try {
            store.each(function (rec) {
                if (rec.get('lastRunResult') === 'running' && rec.get('runningJobId')) {
                    jobs.push(rec);
                }
            });
        } catch (e) {
            return;
        }
        // A row that stopped running (the run ended while we watched) loses its
        // map entry — the map never outlives the running rows it feeds.
        try {
            for (var name in rowDetails) {
                if (Object.prototype.hasOwnProperty.call(rowDetails, name)) {
                    var still = false;
                    for (var j = 0; j < jobs.length; j++) {
                        if (jobs[j].get('name') === name) {
                            still = true;
                            break;
                        }
                    }
                    if (!still) {
                        delete rowDetails[name];
                    }
                }
            }
        } catch (ePrune) {
            // a stale entry is cosmetic; never break the tick for it
        }
        for (var i = 0; i < jobs.length; i++) {
            (function (rec) {
                ANAS.api.get(node, '/jobs/' + encodeURIComponent(rec.get('runningJobId')))
                    .then(function (res) {
                        if (grid.destroyed || grid.destroying) {
                            return;
                        }
                        var job = (res && res.job) || null;
                        if (job && job.detail && rowDetails) {
                            rowDetails[rec.get('name')] = job.detail;
                        }
                    }, function () {
                        // transient — the next tick retries
                    });
            }(jobs[i]));
        }
    }

    // ---- Run now ------------------------------------------------------------

    // The `lastRunAt` a row carries right now — the run the grid is still
    // showing when a failure is recorded against it.
    function lastRunAtOf(store, name) {
        try {
            var idx = store ? store.findExact('name', name) : -1;
            var rec = idx >= 0 ? store.getAt(idx) : null;
            return rec ? rec.get('lastRunAt') : null;
        } catch (e) {
            return null;
        }
    }

    // The ONE run path, as backup runs it: POST the task's /run, let the task's
    // own systemd unit do the work, supervise through the job — so a manual run
    // lands in systemd's last-result and the unit journal exactly like a
    // scheduled one (one history). The grid reloads when the job ends, success
    // AND failure, and a failed run's error line becomes the Last run tooltip.
    function runTaskNow(view, node, name) {
        if (!name) {
            return;
        }
        var grid = gridOf(view);
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/cloud/tasks/' + encodeURIComponent(name) + '/run',
            body: {},
            view: grid,
            maxMs: 600000, // a real sync can run for minutes — keep polling
            failTitle: 'Run failed',
            onComplete: function (job) {
                var msg = t('Cloud sync finished') + ': ' + name;
                try {
                    var result = (job && job.result) || {};
                    // The counters are rclone's own, only when rclone said any
                    // (a sub-second run reports none — say so, never zeros).
                    if (result.countersReported === true) {
                        msg += ' — ' + ANAS.formatBytes(result.bytes) + ' '
                            + t('of') + ' ' + ANAS.formatBytes(result.totalBytes)
                            + ', ' + result.transfers + ' '
                            + (result.transfers === 1 ? t('file') : t('files'));
                    } else {
                        msg += ' — ' + t('no counters reported');
                    }
                } catch (eSum) {
                    // best-effort summary
                }
                // A manual success retires the line the last failure left.
                ANAS.sched.runErrors.clear(grid && grid.getStore(), name);
                ANAS.toast(msg);
                loadTasks(view, node);
            },
            onFailed: function (job) {
                var message = (job && job.error && job.error.message) || '';
                if (message) {
                    // Keyed to the run: the timestamp the row carries NOW is
                    // the previous run's, and the reload that follows brings
                    // in this run's — which is the one the line belongs to.
                    var store = grid && grid.getStore();
                    ANAS.sched.runErrors.set(store, name, message, lastRunAtOf(store, name));
                }
                loadTasks(view, node);
            },
            // rclone.5: the run this Run Now watched was cancelled — neither
            // a failure nor a finish; the row says cancelled after the reload.
            onCancelled: function () {
                loadTasks(view, node);
            },
        });
        ANAS.toast(t('Cloud sync started') + ': ' + name);
    }

    // ---- Enable / Disable (PUT the task with enabled flipped) ---------------

    function toggleTask(view, node, rec) {
        if (!rec) {
            return;
        }
        var raw = rec.get('raw') || {};
        var name = rec.get('name');
        var next = !rec.get('enabled');
        // A toggle rewrites the whole task — carry every stored field through
        // it (the PUT replaces the task; a dropped field would be silently
        // reset to its schema default).
        var body = {
            name: name,
            source: raw.source || rec.get('source'),
            remote: raw.remote || rec.get('remote'),
            path: raw.path || '',
            mode: raw.mode === 'sync' ? 'sync' : 'copy',
            excludes: raw.excludes || [],
            notify: raw.notify === 'on-failure' ? 'on-failure' : 'always',
            schedule: raw.schedule || rec.get('schedule'),
            enabled: next,
        };
        var cad = ANAS.sched.cadence.of(raw);
        if (cad) {
            body.cadence = cad;
        }
        if (raw.bwlimit) {
            body.bwlimit = raw.bwlimit;
        }
        ANAS.runJob({
            node: node,
            method: 'put',
            path: '/cloud/tasks/' + encodeURIComponent(name),
            body: body,
            view: gridOf(view),
            failTitle: 'Update failed',
            successMsg: next ? (t('Task enabled') + ': ' + name) : (t('Task disabled') + ': ' + name),
            onComplete: function () {
                loadTasks(view, node);
            },
            onFailed: function () {
                loadTasks(view, node);
            },
        });
    }

    // ---- Remove (the units only; nothing on the remote is touched) ----------

    function removeTask(view, node, rec) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        try {
            Ext.Msg.confirm(
                t('Remove Cloud Sync Task'),
                t('Remove the cloud sync task') + ' "' + enc(name) + '"? '
                    + t('This removes its schedule (the systemd units) only — '
                        + 'data already at the remote is untouched.'),
                function (btn) {
                    if (btn !== 'yes') {
                        return;
                    }
                    ANAS.runJob({
                        node: node,
                        method: 'del',
                        path: '/cloud/tasks/' + encodeURIComponent(name),
                        view: gridOf(view),
                        failTitle: 'Remove failed',
                        successMsg: t('Cloud sync task removed') + ': ' + name,
                        onComplete: function () {
                            loadTasks(view, node);
                        },
                        onFailed: function () {
                            loadTasks(view, node);
                        },
                    });
                }
            );
        } catch (e) {
            ANAS.warn('cloud task remove confirm failed: ' + ANAS.errText(e));
        }
    }

    // ---- Detail (display-only, the Backup detail's twin) --------------------

    function kv(label, value) {
        return '<tr><td style="padding:2px 14px 2px 0;color:var(--anas-muted,gray);'
            + 'white-space:nowrap;vertical-align:top;">' + enc(label)
            + '</td><td style="padding:2px 0;">' + value + '</td></tr>';
    }

    function mono(s) {
        return '<span style="font-family:monospace;font-size:0.92em;word-break:break-all;">'
            + enc(s) + '</span>';
    }

    function unitBlock(title, text) {
        if (!text) {
            return '';
        }
        return '<div style="margin-top:10px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + enc(title) + '</div>'
            + '<pre style="margin:0;padding:8px 10px;border-radius:6px;overflow-x:auto;'
            + 'background:rgba(127,127,127,0.10);font-size:12px;white-space:pre;">'
            + enc(text) + '</pre></div>';
    }

    // The derived consistency as the detail shows it: the chip, with the
    // daemon's own reason as the tooltip (the wizard's line, repeated).
    function consistencyChipHtml(c) {
        if (!c || (c.consistency !== 'snapshot' && c.consistency !== 'live')) {
            return '<span style="color:var(--anas-muted,gray);">' + enc(t('not known')) + '</span>';
        }
        var snap = c.consistency === 'snapshot';
        return pillHtml(snap ? t('snapshot') : t('live'),
            snap ? 'var(--anas-ok,#1f9c56)' : 'var(--anas-muted,gray)',
            '' + (c.reason || ''));
    }

    // The schedule as the detail shows it: the cadence in words with the
    // generated OnCalendar underneath (config-is-the-API transparency), or the
    // expression for a raw-schedule task.
    function scheduleDetailHtml(task) {
        var expr = task && task.schedule
            ? '<span style="font-family:monospace;font-size:0.92em;">' + enc(task.schedule) + '</span>'
            : '<span style="color:gray;">&mdash;</span>';
        var c = ANAS.sched.cadence.of(task);
        var text = ANAS.sched.cadence.text(c);
        if (!text) {
            return expr;
        }
        var note = c.kind === 'biweekly'
            ? '<div style="color:var(--anas-muted,gray);font-size:0.85em;">'
                + enc(t('The timer fires weekly; ANAS skips the off weeks (systemd calendars '
                    + 'cannot express "every other week"). A missed period heals on the next fire.'))
                + '</div>'
            : '';
        return enc(text) + '<div style="color:var(--anas-muted,gray);font-size:0.85em;">'
            + 'OnCalendar: ' + expr + '</div>' + note;
    }

    function notificationsRowHtml(task) {
        var onFailure = task && task.notify === 'on-failure';
        return enc(onFailure
            ? t('on failure — only a failed run, or one that completed with warnings, notifies')
            : t('always — every run that happened notifies (a skipped off week never does)'))
            + ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
            + enc(t('— delivered by the Proxmox notification system (type anas-cloud)'))
            + '</span>';
    }

    function cloudTaskDetailHtml(d) {
        if (!d) {
            return '<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('No detail returned for this task.')) + '</div>';
        }
        var task = d.task || d;
        var excludes = (task.excludes && task.excludes.length)
            ? mono(task.excludes.join('  '))
            : '<span style="color:var(--anas-muted,gray);">' + enc(t('none')) + '</span>';
        var nested = (d.nested && d.nested.length)
            ? d.nested.map(function (n) {
                return '<div style="font-size:11px;margin-left:2px;color:var(--anas-warn,#c9820b);">'
                    + '<span style="font-family:monospace;">' + enc(n) + '</span> — '
                    + enc(t('not included (a snapshot captures one filesystem)')) + '</div>';
            }).join('')
            : '';
        var rows = ''
            + kv(t('Task'), mono(task.name))
            + kv(t('Source'), mono(task.source))
            + kv(t('Destination'), mono(destinationOf(task)))
            + kv(t('Mode'), renderMode(task.mode))
            + kv(t('Excludes'), excludes)
            + kv(t('Bandwidth limit'), task.bwlimit
                ? mono(task.bwlimit)
                : '<span style="color:var(--anas-muted,gray);">' + enc(t('none')) + '</span>')
            + kv(t('Notifications'), notificationsRowHtml(task))
            + kv(t('Schedule'), scheduleDetailHtml(task))
            + kv(t('Enabled'), renderEnabled(task.enabled))
            + kv(t('Consistency'), consistencyChipHtml(d.consistency));
        if (nested) {
            rows += kv(t('Nested filesystems'), nested);
        }
        // A disabled task has no last run to show — say so with the daemon's
        // own sentence (statusNote) when it carries one.
        var result = '' + (task.lastRunResult || '');
        if (result === 'disabled') {
            rows += kv(t('Last run'),
                softPill(t('disabled'), 'var(--anas-muted,gray)',
                    t('run history is not retained while a task is disabled'))
                + ' <span style="color:var(--anas-muted,gray);">'
                + enc('— ' + (d.statusNote || t('run history is not retained while a task is disabled')))
                + '</span>');
        } else if (result === 'never-run') {
            rows += kv(t('Last run'), softPill(t('never run'), 'var(--anas-muted,gray)',
                t('this task has not run yet')));
        } else {
            rows += kv(t('Last run'),
                renderLastRun(task.lastRunResult, null, { get: function (k) {
                    return k === 'lastRunResult' ? result
                        : k === 'lastRunAt' ? task.lastRunAt
                        : k === 'overdue' ? task.overdue
                        : k === 'runningProgress' ? task.runningProgress
                        : k === 'lastRunNote' ? task.lastRunNote
                        : k === 'name' ? task.name
                        : undefined;
                } }));
        }

        var html = '<div style="padding:10px 14px;">'
            + '<table style="border-collapse:collapse;width:100%;">' + rows + '</table>';
        // The unit + timer, verbatim — config-is-the-API transparency.
        html += unitBlock(t('systemd service unit (as written)'), d.unit);
        html += unitBlock(t('systemd timer (as written)'), d.timer);
        // Recent runs, labeled recent-only (journald is forensics, never
        // correctness — standing ruling).
        if (d.journal) {
            html += '<div style="margin-top:12px;">'
                + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
                + '<i class="fa fa-history" style="margin-right:5px;"></i>'
                + enc(t('Recent runs (journald) — older history is not retained')) + '</div>'
                + '<pre style="margin:0;padding:8px 10px;border-radius:6px;overflow-x:auto;'
                + 'background:rgba(127,127,127,0.10);font-size:11px;white-space:pre-wrap;">'
                + enc(d.journal) + '</pre></div>';
        }
        html += '</div>';
        return html;
    }

    function loadDetailInto(win, node, name) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var body = win.down('#detailBody');
        if (!body) {
            return;
        }
        body.update('<div style="padding:12px 14px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
            + enc(t('loading…')) + '</div>');
        ANAS.api.get(node, '/cloud/tasks/' + encodeURIComponent(name)).then(function (res) {
            if (body.destroyed || body.destroying) {
                return;
            }
            try {
                body.update(cloudTaskDetailHtml(res && res.data));
            } catch (e) {
                ANAS.warn('cloud task detail render failed: ' + ANAS.errText(e));
            }
        }, function (err) {
            if (body.destroyed || body.destroying) {
                return;
            }
            ANAS.warn('cloud task detail load failed: ' + ANAS.errText(err));
            body.update('<div style="padding:12px 14px;color:var(--anas-danger,#c23b2c);">'
                + enc(t('Failed to load detail') + ': ' + ANAS.errText(err)) + '</div>');
        });
    }

    function openTaskDetail(node, name) {
        if (!name) {
            return;
        }
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-cloud-task-detail',
                title: t('Cloud Sync Task') + ': ' + name,
                modal: false,
                width: 760,
                height: 520,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'detailBody',
                    cls: 'anas-cloud-detail',
                    border: false,
                    scrollable: true,
                    html: '',
                }],
                buttons: [
                    {
                        text: t('Reload'),
                        cls: 'anas-btn-cloud-detail-reload',
                        iconCls: 'fa fa-refresh',
                        handler: function () { loadDetailInto(win, node, name); },
                    },
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
            });
        } catch (e) {
            ANAS.warn('cloud task detail window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        loadDetailInto(win, node, name);
    }

    // ---- Run viewer (rclone.6) ----------------------------------------------
    //
    // A live dashboard over the running direct job's `detail` (CloudRunDetail),
    // NOT a log: the job is polled every 2 s while it runs, every figure moves
    // with the poll, and when the job ends the bars stand at their final values
    // behind a result banner. Nothing survives the job leaving the queue —
    // opening the viewer with no running job says so and shows the journal
    // summary the detail window already carries.

    var RUN_VIEW_POLL_MS = 2000;
    var RECENT_SHOWN = 10;

    // The header's task shape straight off a grid record.
    function rowShapeOf(rec) {
        if (!rec || !rec.get) {
            return null;
        }
        return {
            name: rec.get('name'),
            source: rec.get('source'),
            remote: rec.get('remote'),
            path: rec.get('path'),
            mode: rec.get('mode'),
        };
    }

    function runStatusPillHtml(status) {
        if (status === 'running') {
            return '<span title=""'
                + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
                + 'color:#fff;background:var(--anas-accent,#3468c0);">'
                + '<i class="fa fa-refresh fa-spin" aria-hidden="true" style="margin-right:4px;"></i>'
                + enc(t('running')) + '</span>';
        }
        if (status === 'completed') {
            return pillHtml(t('completed'), 'var(--anas-ok,#1f9c56)', '');
        }
        if (status === 'failed') {
            return pillHtml(t('failure'), 'var(--anas-danger,#c23b2c)', '');
        }
        if (status === 'cancelled') {
            return pillHtml(t('cancelled'), 'var(--anas-muted,gray)', '');
        }
        return pillHtml(t('unknown'), 'var(--anas-muted,gray)', '');
    }

    // One labeled figure — every number carries its label and unit (UI rule:
    // numbers need labeled context; no unlabeled tiles).
    function runFigure(label, value) {
        return '<span class="anas-run-figure" data-anas-run-figure="' + enc(label) + '"'
            + ' style="display:inline-block;margin-right:18px;">'
            + '<span style="display:block;color:var(--anas-muted,gray);font-size:0.82em;">'
            + enc(label) + '</span>'
            + '<span style="font-size:1.1em;">' + value + '</span></span>';
    }

    function speedHtml(bytesPerSec) {
        var n = Number(bytesPerSec);
        if (isNaN(n) || n <= 0) {
            return '<span style="color:var(--anas-muted,gray);">—</span>';
        }
        return enc(ANAS.formatBytes(n) + '/s');
    }

    function etaHtml(sec) {
        var n = Number(sec);
        if (sec === null || sec === undefined || isNaN(n) || n < 0) {
            return '<span style="color:var(--anas-muted,gray);">' + enc(t('—')) + '</span>';
        }
        return enc(ANAS.formatDuration(n * 1000));
    }

    // Recent event → one row. Errors first and in danger, with the message;
    // everything else reads "name — what happened, how long ago".
    function recentEventHtml(ev) {
        ev = ev || {};
        var isErr = ev.kind === 'error';
        var what = isErr
            ? '<span style="color:var(--anas-danger,#c23b2c);">' + enc(ev.message || t('error')) + '</span>'
            : enc(t(ev.kind || 'copied'));
        var ago = ev.at ? ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
            + enc(ANAS.ago(ev.at)) + '</span>' : '';
        return '<div class="anas-run-recent-row" data-anas-run-recent-kind="' + enc(ev.kind || '') + '"'
            + ' style="padding:1px 0;">'
            + '<span style="font-family:monospace;font-size:0.92em;word-break:break-all;">'
            + enc(ev.name || '') + '</span> — ' + what + ago + '</div>';
    }

    function kindSortKey(kind) {
        return kind === 'error' ? 0 : 1;
    }

    // The viewer body — PURE, so the harness can assert every section from a
    // fixture job. `task` is the row's shape ({name, source, remote, path,
    // mode}); `job` the polled Job (status + detail + result/error). opts:
    // { consistency:{consistency,reason}, showAllRecent:bool,
    //   vanished:bool } — `vanished` marks a job that answered 4xx and left
    // the queue, so a task row still reading `running` gets the no-detail
    // sentence, never the prepare line (review batch B).
    function runViewerBody(task, job, opts) {
        task = task || {};
        opts = opts || {};
        var detail = (job && job.detail) || null;
        var status = (job && job.status) || 'unknown';
        var running = status === 'running';

        // (1) header — task, source → remote:path, mode, live/snapshot, status.
        var header = '<div class="anas-run-header" style="margin-bottom:10px;">'
            + '<span style="font-weight:600;font-size:1.05em;">' + enc(task.name || '') + '</span> '
            + runStatusPillHtml(status)
            + '<div style="color:var(--anas-muted,gray);margin-top:2px;">'
            + mono(task.source || '') + ' <i class="fa fa-arrow-right" aria-hidden="true"></i> '
            + mono(destinationOf(task)) + ' — ' + renderMode(task.mode)
            + (opts.consistency ? ' ' + consistencyChipHtml(opts.consistency) : '')
            + '</div></div>';

        if (!detail) {
            if (running && !opts.vanished) {
                // The run IS in progress but its first stats object has not
                // landed yet — the first seconds and the snapshot prepare
                // phase (review batch B). Say so; the no-detail sentence
                // below is only for a job that has ended or vanished.
                return header
                    + '<div class="anas-run-preparing" style="padding:10px 12px;border-radius:8px;'
                    + 'background:rgba(127,127,127,0.10);">'
                    + '<i class="fa fa-refresh fa-spin" aria-hidden="true" style="margin-right:6px;"></i>'
                    + enc(t('Preparing the run…')) + '</div>';
            }
            // The job has left the queue (or an older daemon): per-file detail
            // is gone with it — the stateless rule. The sentence stands above
            // the journal summary the task already shows (the recent-runs
            // facts); nothing else is retained anywhere.
            return header
                + '<div class="anas-run-no-detail" style="padding:10px 12px;border-radius:8px;'
                + 'background:rgba(127,127,127,0.10);">'
                + enc(t('Per-file detail is shown only while a run is in progress.')) + ' '
                + '<span style="color:var(--anas-muted,gray);">'
                + enc(t('Finished runs keep their journal line and the recent-runs list '
                    + 'in the task\'s Details window.')) + '</span>'
                + (opts.journal
                    ? '<div style="color:var(--anas-muted,gray);font-size:0.85em;'
                        + 'margin:10px 0 3px;">'
                        + '<i class="fa fa-history" style="margin-right:5px;"></i>'
                        + enc(t('Recent runs (journald) — older history is not retained'))
                        + '</div><pre style="margin:0;padding:8px 10px;border-radius:6px;'
                        + 'overflow-x:auto;background:rgba(127,127,127,0.10);font-size:11px;'
                        + 'white-space:pre-wrap;">' + enc(opts.journal) + '</pre>'
                    : '')
                + '</div>';
        }

        var frac = detail.totalBytes > 0 ? detail.bytes / detail.totalBytes : 0;
        var fileFrac = detail.totalTransfers > 0
            ? detail.transfers / detail.totalTransfers : 0;
        var stalled = ANAS.gfx.stalledHtml(detail);

        // (2) overall progress — bytes bar with the percentage beside it, thin
        // files bar under it.
        var progress = '<div class="anas-run-progress" style="margin-bottom:10px;">'
            + ANAS.gfx.gauge(frac, {
                label: ANAS.formatBytes(detail.bytes) + ' ' + t('of') + ' '
                    + ANAS.formatBytes(detail.totalBytes),
                pct: true,
                title: t('bytes copied of the total'),
            })
            + '<div style="margin-top:4px;">'
            + ANAS.gfx.bar(fileFrac, { pct: false, color: 'var(--anas-series-1,#3468c0)',
                title: t('files transferred of the total') })
            + ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
            + enc(detail.transfers + ' ' + t('of') + ' ' + detail.totalTransfers + ' '
                + t('files')) + '</span></div></div>';

        // (3) throughput spark + current speed + the stalled label.
        var spark = '<div class="anas-run-spark" style="margin-bottom:10px;">'
            + ANAS.gfx.sparkFromSamples(detail.speedSamples || [], {
                size: 'full',
                title: t('throughput, last 5 minutes'),
            })
            + ' <span class="anas-run-speed" style="white-space:nowrap;">'
            + speedHtml(detail.speed) + '</span> ' + stalled + '</div>';

        // (4) labeled figures — every number with its label and unit.
        var figures = '<div class="anas-run-figures" style="margin-bottom:12px;">'
            + runFigure(t('speed'), speedHtml(detail.speed))
            + runFigure(t('ETA'), etaHtml(detail.eta))
            + runFigure(t('elapsed'), enc(ANAS.formatDuration(detail.elapsedMs)))
            + runFigure(t('files'), enc(detail.transfers + ' / ' + detail.totalTransfers))
            + runFigure(t('checks'), enc('' + detail.checks))
            + runFigure(t('deletes'), enc('' + detail.deletes))
            + runFigure(t('errors'), detail.errors > 0
                ? '<span style="color:var(--anas-danger,#c23b2c);">' + enc('' + detail.errors) + '</span>'
                : enc('0'))
            + '</div>';

        var html = header + progress + spark + figures;

        if (running) {
            // (5) Transferring now — at most a handful of rows (rclone's
            // --transfers default is 4).
            var tr = (detail.transferring || []);
            var rows = '';
            for (var i = 0; i < tr.length; i++) {
                var f = tr[i] || {};
                rows += '<div class="anas-run-transferring-row" style="padding:2px 0;'
                    + 'display:flex;align-items:center;gap:8px;">'
                    + '<span style="flex:1;font-family:monospace;font-size:0.92em;'
                    + 'word-break:break-all;">' + enc(f.name || '') + '</span>'
                    + '<span style="white-space:nowrap;color:var(--anas-muted,gray);">'
                    + enc(ANAS.formatBytes(Number(f.size) || 0)) + '</span>'
                    + ANAS.gfx.bar((Number(f.percentage) || 0) / 100,
                        { pct: true, color: 'var(--anas-series-1,#3468c0)' })
                    + '<span style="white-space:nowrap;">' + speedHtml(f.speed) + '</span>'
                    + '<span style="white-space:nowrap;color:var(--anas-muted,gray);">'
                    + etaHtml(f.eta) + '</span></div>';
            }
            html += '<div class="anas-run-transferring" style="margin-bottom:12px;">'
                + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
                + enc(t('Transferring now')) + '</div>'
                + (rows || '<div style="color:var(--anas-muted,gray);">'
                    + enc(t('nothing in flight')) + '</div>')
                + '</div>';
        } else {
            // The result banner stands where the in-flight section was; the
            // bars above hold their final values.
            html += '<div class="anas-run-result-banner" style="padding:8px 12px;'
                + 'border-radius:8px;background:rgba(127,127,127,0.10);margin-bottom:12px;">'
                + runResultBannerHtml(job) + '</div>';
        }

        // (6) Recent — newest events first, errors first in danger with the
        // message; a "show all 50" link when the ring holds more. The daemon's
        // ring is oldest → newest, and the errors-first sort put its HEAD in
        // view — the OLDEST completions (review batch B). The window is:
        // newest-first, errors floated ahead of the newest completions, so
        // what shows is what happened last. "Show all" renders the whole ring
        // under the same rule.
        var recent = (detail.recent || []).slice();
        recent.reverse(); // newest → oldest
        recent.sort(function (a, b) {
            return kindSortKey(a && a.kind) - kindSortKey(b && b.kind);
        });
        var shown = opts.showAllRecent ? recent : recent.slice(0, RECENT_SHOWN);
        var recentHtml = '';
        for (var r = 0; r < shown.length; r++) {
            recentHtml += recentEventHtml(shown[r]);
        }
        if (!opts.showAllRecent && recent.length > RECENT_SHOWN) {
            // The count is substituted into a TRANSLATED template, never the
            // other way round (review batch B) — a dynamic string through the
            // translator would freeze one language's word order.
            recentHtml += '<a href="#" data-anas-run-recent-all="1" class="anas-run-recent-all">'
                + enc(t('show all {n}').replace('{n}', '' + detail.recent.length)) + '</a>';
        }
        html += '<div class="anas-run-recent" style="margin-bottom:10px;">'
            + '<div style="color:var(--anas-muted,gray);font-size:0.85em;margin-bottom:3px;">'
            + enc(t('Recent')) + '</div>'
            + (recentHtml || '<div style="color:var(--anas-muted,gray);">'
                + enc(t('nothing finished yet')) + '</div>')
            + '</div>';

        // (7) the last error line, when there is one.
        if (detail.lastError) {
            html += '<div class="anas-run-last-error" style="color:var(--anas-danger,#c23b2c);'
                + 'font-size:0.95em;">' + enc(t('Last error') + ': ' + detail.lastError) + '</div>';
        }
        return html;
    }

    // The one-line result banner: files and bytes transferred, duration, and
    // the error count or its absence; a failed run leads with its last error,
    // a cancelled one with the cancellation reason.
    function runResultBannerHtml(job) {
        var d = (job && job.detail) || {};
        var status = job && job.status;
        var lead = '';
        if (status === 'cancelled') {
            var reason = job.result && job.result.reason
                ? job.result.reason : t('cancelled');
            lead = '<span style="color:var(--anas-muted,gray);">' + enc('' + reason) + ' — </span>';
        } else if (status === 'failed') {
            var msg = (job.error && job.error.message) || d.lastError || t('the run failed');
            lead = '<span style="color:var(--anas-danger,#c23b2c);">' + enc('' + msg) + ' — </span>';
        }
        var errors = Number(d.errors) || 0;
        return lead + enc(
            (Number(d.transfers) || 0) + ' ' + countWord(Number(d.transfers) || 0,
                t('file'), t('files'))
            + ', ' + ANAS.formatBytes(Number(d.bytes) || 0)
            + ', ' + (ANAS.formatDuration(d.elapsedMs) || t('unknown duration'))
            + ' — ' + (errors > 0
                ? errors + ' ' + t('errors')
                : t('no errors')));
    }

    // Open the viewer for a task row. Polls GET /v1/jobs/:id every 2 s while
    // the job runs (pull — no websocket), stops at the job's end; one task
    // fetch at open adds the live/snapshot label (fail-open). `grid` (the
    // tasks grid, optional) is where Cancel run's reload lands.
    function openRunViewer(node, name, jobId, grid, rowTask) {
        if (!name) {
            return;
        }
        // The row's shape for the header ({name, source, remote, path, mode}) —
        // the task fetch below completes it (or supplies it) when the grid row
        // did not hand one over.
        var task = rowTask || null;
        var job = null;
        var showAllRecent = false;

        // The task row's current last result — the pill a VANISHED job is
        // turned to (review batch B): the queue no longer holds the job, the
        // task's row is the state the user can still see.
        function taskResultOf() {
            try {
                var store = win._anasCloudGrid && win._anasCloudGrid.getStore();
                var idx = store ? store.findExact('name', name) : -1;
                var rec = idx >= 0 ? store.getAt(idx) : null;
                return rec ? ('' + (rec.get('lastRunResult') || 'unknown')) : 'unknown';
            } catch (e) {
                return 'unknown';
            }
        }

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-cloud-run',
                title: t('Run viewer') + ': ' + name,
                modal: false,
                width: 760,
                height: 560,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'runBody',
                    cls: 'anas-cloud-run',
                    border: false,
                    scrollable: true,
                    html: '',
                    listeners: {
                        // The "show all 50" link re-renders the same body with
                        // the whole ring.
                        el: {
                            click: function (e) {
                                var tgt = e.getTarget('[data-anas-run-recent-all]');
                                if (tgt) {
                                    e.preventDefault();
                                    showAllRecent = true;
                                    render();
                                }
                            },
                        },
                    },
                }],
                buttons: [
                    {
                        text: t('Cancel run'),
                        itemId: 'cloudRunCancel',
                        cls: 'anas-btn-cloud-run-cancel',
                        iconCls: 'fa fa-stop-circle',
                        disabled: true,
                        handler: function () {
                            var grid = win._anasCloudGrid;
                            ANAS.sched.cancelRun({
                                node: node,
                                jobId: jobId,
                                name: name,
                                view: grid || win,
                                reload: function () { poll(); },
                            });
                        },
                    },
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
                listeners: {
                    destroy: function () {
                        if (win._anasRunTimer) {
                            clearInterval(win._anasRunTimer);
                            win._anasRunTimer = null;
                        }
                    },
                },
            });
        } catch (e) {
            ANAS.warn('cloud run viewer failed: ' + ANAS.errText(e));
            return;
        }

        function render() {
            var body = win.down('#runBody');
            if (!body || body.destroyed || body.destroying) {
                return;
            }
            try {
                body.update(runViewerBody(task, job, {
                    consistency: win._anasConsistency,
                    showAllRecent: showAllRecent,
                    journal: win._anasJournal || null,
                    // The job answered 4xx — it has left the queue; the body
                    // reads the no-detail sentence even while the task's own
                    // row still says running (review batch B).
                    vanished: win._anasVanished === true,
                }));
            } catch (e) {
                ANAS.warn('cloud run viewer render failed: ' + ANAS.errText(e));
            }
            var cancelBtn = win.down('#cloudRunCancel');
            if (cancelBtn) {
                try {
                    cancelBtn.setDisabled(!job || job.status !== 'running');
                } catch (eB) {
                    // cosmetic
                }
            }
        }

        function poll() {
            if (!jobId || win.destroyed || win.destroying) {
                return;
            }
            ANAS.api.get(node, '/jobs/' + encodeURIComponent(jobId)).then(function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                job = (res && res.job) || job;
                render();
                if (job && job.status !== 'running') {
                    // The job ended: bars stand at their final values, polling
                    // stops, the pill turned with this very render.
                    if (win._anasRunTimer) {
                        clearInterval(win._anasRunTimer);
                        win._anasRunTimer = null;
                    }
                }
            }, function (err) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                // A 4xx is TERMINAL (review batch B): the job has left the
                // queue — a 404 after a daemon restart — and no tick will ever
                // bring it back. Stop the poll, turn the pill from the task's
                // own last result, and let the no-detail sentence stand above
                // the journal summary. Anything else is transient — keep the
                // last good body, warn, keep polling.
                var status = err && err.status;
                if (status >= 400 && status < 500) {
                    if (win._anasRunTimer) {
                        clearInterval(win._anasRunTimer);
                        win._anasRunTimer = null;
                    }
                    win._anasVanished = true;
                    job = { id: jobId, status: taskResultOf() };
                    render();
                    return;
                }
                // Transient failure — keep the last good body, warn, keep
                // polling; the next tick may simply confirm the job is gone.
                ANAS.warn('cloud run poll failed: ' + ANAS.errText(err));
            });
        }

        win._anasCloudGrid = grid || null;
        win.show();
        render();
        if (jobId) {
            win._anasRunTimer = setInterval(poll, RUN_VIEW_POLL_MS);
            poll();
        }
        // The live/snapshot label (fail-open — an older daemon or a failed
        // read just omits the chip) and the header's task shape when the row
        // did not carry it.
        ANAS.api.get(node, '/cloud/tasks/' + encodeURIComponent(name)).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var d = (res && res.data) || {};
            win._anasConsistency = d.consistency || null;
            if (!task && d.task) {
                task = d.task;
            }
            // No running job to poll: the journal summary is the facts the
            // viewer can still show (the stateless rule).
            if (!jobId && d.journal) {
                win._anasJournal = d.journal;
            }
            render();
        }, function () {
            // fail-open: the label is optional garnish
        });
        return win;
    }



    // ---- Preview (the rider — the dry run) ----------------------------------
    //
    // POST /cloud/tasks/preview is a USER-INITIATED, one-shot READ (the backup
    // wizard's prune-preview precedent): never polled, never automatic. The
    // wizard sends its UNSAVED form inline — the CloudSyncPreviewRequest shape,
    // the task's data fields WITHOUT the management keys a dry run never reads
    // (name, schedule, cadence, notify, enabled); the grid toolbar sends the
    // saved task's {name}. One renderer, two homes: the wizard's summary line
    // under the Mode field and the toolbar's display-only window.

    // The daemon's empty-source sentence shape, verbatim — the preview does NOT
    // refuse it (showing that a sync would delete everything is the point), so
    // the UI says it in red.
    var EMPTY_SOURCE_PREVIEW = 'an empty source in sync mode would delete '
        + 'everything at the destination';

    function previewPendingHtml() {
        return '<div style="color:var(--anas-muted,gray);font-size:11px;">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:6px;"></i>'
            + enc(t('asking the server…')) + '</div>';
    }

    function countWord(n, one, many) {
        return n === 1 ? one : many;
    }

    // The 120 s ceiling fired: what is on screen is a partial answer, and the
    // line says exactly what a partial answer is — the counters are rclone's
    // last periodic tick, the list is everything it logged, neither is whole.
    function previewTruncatedHtml() {
        return '<div style="color:var(--anas-warn,#b06a12);font-size:11px;">'
            + enc(t('stopped after 120 s — the counts are what rclone had reported '
                + 'by then, the list is everything it logged; the full run will do '
                + 'the rest')) + '</div>';
    }

    // The task-management keys a dry run never reads — ONE list, exported on
    // ANAS.cloud: the preview body is cloudTaskFields minus exactly these, and
    // a hand-copied field list would drift from the reader.
    var CLOUD_TASK_MANAGEMENT_KEYS = ['name', 'schedule', 'cadence', 'notify', 'enabled'];

    // The summary, from the daemon's OWN counters (CloudSyncPreviewResult).
    // Numbers carry their units (ANAS.formatBytes labels the bytes); names and
    // paths are rendered whole — a list capped by the daemon says how many more.
    function cloudPreviewHtml(result) {
        result = result || {};
        var transfers = Number(result.transfers) || 0;
        var checks = Number(result.checks) || 0;
        var deletes = Number(result.deletes) || 0;
        var deletedFiles = (result.deletedFiles && result.deletedFiles.length)
            ? result.deletedFiles : [];
        // The delete count is the READER's own (deletedTotal — counted from the
        // skipped-delete lines, independent of the stats object), falling back
        // to the stats count only when the answer carries neither.
        var deletedTotal = Number(result.deletedTotal) || deletes;
        var errors = (result.errors && result.errors.length) ? result.errors : [];
        var truncated = result.truncated === true;
        var hasDeletes = deletedFiles.length > 0 || deletedTotal > 0;
        var lines = [];

        // A FAILED preview never headlines a zero forecast: rclone's counters
        // from a run that died say only what it managed before dying, so when
        // errors ride the answer the counters lead does not — the sentence
        // carries rclone's own first error line instead.
        if (errors.length) {
            lines.push('<div style="color:var(--anas-danger,#c23b2c);">'
                + enc(t('The preview did not complete') + ' — ' + errors[0]) + '</div>');
            if (truncated) {
                lines.push(previewTruncatedHtml());
            }
            return lines.join('');
        }

        // The everything-deleted case is the one that repaints the whole line —
        // but only for a COMPLETE answer: a truncated one with zeros may be
        // part-way through a source that is not empty at all, and red here
        // would be the lie the ceiling exists to prevent.
        var danger = '';
        var lead;
        if (deletes > 0 && transfers === 0 && checks === 0 && !truncated) {
            danger = 'var(--anas-danger,#c23b2c)';
            lead = t(EMPTY_SOURCE_PREVIEW);
        } else if (transfers === 0 && !hasDeletes && !truncated) {
            lead = t('Nothing to do — the destination already matches the source');
        } else {
            lead = t('Would transfer') + ' ' + transfers + ' '
                + countWord(transfers, t('file'), t('files'))
                + ' / ' + ANAS.formatBytes(Number(result.bytes) || 0);
            // The delete clause and the list gate on the READER's count, never
            // on the stats one — the two disagree exactly when it matters.
            if (hasDeletes) {
                lead += ', ' + t('delete') + ' ' + deletedTotal + ' '
                    + countWord(deletedTotal, t('file'), t('files')) + ' '
                    + t('at the destination');
            }
        }
        lines.push('<div style="color:' + danger + ';">' + enc(lead) + '</div>');

        if (hasDeletes && deletedFiles.length) {
            var names = deletedFiles.join(', ');
            if (deletedTotal > deletedFiles.length) {
                names += ' ' + t('and') + ' ' + (deletedTotal - deletedFiles.length)
                    + ' ' + t('more');
            }
            lines.push('<div style="font-family:monospace;font-size:11px;color:'
                + danger + ';">' + enc(names) + '</div>');
        }
        if (truncated) {
            lines.push(previewTruncatedHtml());
        }
        return lines.join('');
    }

    // A guard refusal (the unmounted mount) is the answer the user came for —
    // the daemon's own sentence, in the line, in red. Everything else warns the
    // console as well.
    function previewErrorHtml(err) {
        if (!err || err.status !== 400) {
            ANAS.warn('cloud preview failed: ' + ANAS.errText(err));
        }
        return '<div style="color:var(--anas-danger,#c23b2c);font-size:11px;">'
            + enc(ANAS.errText(err)) + '</div>';
    }

    // The line both windows render into — the same itemId on purpose, so one
    // setter serves the wizard and the toolbar window.
    function setPreviewLine(win, html) {
        var line = win.down('#cloudPreviewLine');
        if (!line) {
            return;
        }
        try {
            line.update(html);
        } catch (e) {
            ANAS.warn('cloud preview render failed: ' + ANAS.errText(e));
        }
    }

    // The Preview gate AND the result's freshness in one place: enabled while
    // source and remote are filled (a radio always has a mode), cleared the
    // moment any field the dry run was computed from changes — a summary that
    // outlived its inputs would be a lie with numbers on it. Bumping the
    // sequence drops whatever answer is still in flight: its inputs are gone.
    function refreshCloudPreview(win) {
        win._previewSeq = (win._previewSeq || 0) + 1;
        var fields = cloudTaskFields(win);
        setPreviewEnabled(win, false, !fields.source || !fields.remote);
        setPreviewLine(win, '');
    }

    // The wizard Preview button's disabled state: hard-disabled while its own
    // request runs, otherwise whatever the gate says. Cosmetic failures (a
    // half-torn-down window) never break the request itself.
    function setPreviewEnabled(win, busy, disabled) {
        var btn = win.down('#cloudPreviewBtn');
        if (!btn) {
            return;
        }
        try {
            btn.setDisabled(busy === true || disabled === true);
        } catch (e) {
            // cosmetic — the handler re-checks the gate before it sends
        }
    }

    // The body the wizard's Preview sends: the form's data fields —
    // cloudTaskFields minus the management keys, never a hand-copied list to
    // drift from the reader. bwlimit rides only when set (absent = no limit).
    function cloudPreviewBody(win) {
        var fields = cloudTaskFields(win);
        var body = {};
        for (var k in fields) {
            if (Object.prototype.hasOwnProperty.call(fields, k)
                && CLOUD_TASK_MANAGEMENT_KEYS.indexOf(k) === -1) {
                body[k] = fields[k];
            }
        }
        return body;
    }

    // The wizard's Preview click: the form as it stands, inline. The excluded
    // keys never ride — there is nothing to save. The in-flight guard is a
    // sequence token per window: a second Preview, or a field change (which
    // clears through refreshCloudPreview), supersedes the first request's
    // answer — a summary that answers a question already withdrawn is a lie
    // with numbers on it.
    function previewCloudTaskForm(win, node) {
        var fields = cloudTaskFields(win);
        if (!fields.source || !fields.remote) {
            return; // the gate never enables the button without both
        }
        var body = cloudPreviewBody(win);
        var seq = (win._previewSeq = (win._previewSeq || 0) + 1);
        setPreviewEnabled(win, true);
        setPreviewLine(win, previewPendingHtml());
        ANAS.api.post(node, '/cloud/tasks/preview', body).then(function (res) {
            if (win.destroyed || win.destroying || win._previewSeq !== seq) {
                return;
            }
            setPreviewEnabled(win, false);
            setPreviewLine(win, cloudPreviewHtml((res && res.data) || {}));
        }, function (err) {
            if (win.destroyed || win.destroying || win._previewSeq !== seq) {
                return;
            }
            setPreviewEnabled(win, false);
            setPreviewLine(win, previewErrorHtml(err));
        });
    }

    // The grid toolbar's Preview: the SAVED task, by name, in a small
    // display-only window that reuses the wizard's renderer. The toolbar
    // button shares the wizard's in-flight posture — disabled while its
    // request runs, re-enabled by the answer whatever happened to the window
    // (a window closed mid-flight must not leave the toolbar dead).
    function previewTaskRow(node, rec, btn) {
        if (!rec) {
            return;
        }
        var name = rec.get('name');
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-cloud-preview',
                title: t('Preview') + ': ' + name,
                modal: true,
                width: 560,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'component',
                    itemId: 'cloudPreviewLine',
                    cls: 'anas-cloud-preview-line',
                    padding: 12,
                    html: previewPendingHtml(),
                }],
                buttons: [
                    { text: t('Close'), handler: function () { win.close(); } },
                ],
            });
        } catch (e) {
            ANAS.warn('cloud preview window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        var seq = (win._previewSeq = (win._previewSeq || 0) + 1);
        try {
            if (btn) {
                btn.setDisabled(true);
            }
        } catch (e) {
            // cosmetic
        }
        // Re-enables the toolbar button unless a NEWER request has taken it
        // over — that one owns the button now.
        var releaseBtn = function () {
            if (btn && win._previewSeq === seq) {
                try {
                    btn.setDisabled(false);
                } catch (e) {
                    // the grid may be gone — cosmetic
                }
            }
        };
        ANAS.api.post(node, '/cloud/tasks/preview', { name: name }).then(function (res) {
            releaseBtn();
            if (win.destroyed || win.destroying || win._previewSeq !== seq) {
                return;
            }
            setPreviewLine(win, cloudPreviewHtml((res && res.data) || {}));
        }, function (err) {
            releaseBtn();
            if (win.destroyed || win.destroying || win._previewSeq !== seq) {
                return;
            }
            setPreviewLine(win, previewErrorHtml(err));
        });
    }

    // ---- Task wizard (create / edit) — 'anas-win-cloud-task' ----------------

    // The source scan's two in-between states and its debounce mirror the
    // backup wizard's: one walk per pause, the last to resolve paints.
    var SOURCE_SCAN_DEBOUNCE_MS = 400;

    function setScanHtml(win, html) {
        var out = win.down('#cloudSourceScan');
        if (out) {
            try {
                out.update(html);
            } catch (e) {
                // non-fatal
            }
        }
    }

    // What a snapshot will NOT contain, plus the derived consistency — both
    // from the ONE preview-nested scan backup's wizard uses (the derived
    // consistency rides it). Cloud tasks have no nested choice: a snapshot
    // captures one filesystem, so every nested one is left out, and the note
    // says so BEFORE the save (the daemon's run-time sentence, up front).
    function scanCloudSource(win, node) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        var seq = (win._cloudScanSeq = (win._cloudScanSeq || 0) + 1);
        var stale = function () {
            return win.destroyed || win.destroying || win._cloudScanSeq !== seq;
        };
        var path = trim(valOf(win, '#cloudSource') || '');
        if (!path || path.charAt(0) !== '/') {
            setScanHtml(win, '');
            return;
        }
        setScanHtml(win, '<div style="font-size:11px;color:var(--anas-muted,gray);">'
            + '<i class="fa fa-refresh fa-spin" style="margin-right:5px;"></i>'
            + enc(t('checking the source…')) + '</div>');
        ANAS.api.post(node, '/backup/tasks/preview-nested', { path: path, includeNested: 'none' }).then(
            function (res) {
                if (stale()) {
                    return;
                }
                var d = (res && res.data) || {};
                var scans = (d && d.archives && d.archives.length) ? d.archives : [];
                var scan = scans[0] || {};
                var html = '';
                var c = scan.consistency;
                if (c && (c.consistency === 'snapshot' || c.consistency === 'live')) {
                    var snap = c.consistency === 'snapshot';
                    html += '<div style="font-size:11px;margin-bottom:3px;">'
                        + pillHtml(snap ? t('snapshot') : t('live'),
                            snap ? 'var(--anas-ok,#1f9c56)' : 'var(--anas-muted,gray)',
                            '' + (c.reason || ''))
                        + '</div>';
                }
                var nested = (scan.nested && scan.nested.length) ? scan.nested : [];
                if (nested.length) {
                    var paths = [];
                    for (var i = 0; i < nested.length; i++) {
                        paths.push('' + (nested[i] && nested[i].path || ''));
                    }
                    html += '<div style="font-size:11px;color:var(--anas-warn,#c9820b);">'
                        + '<i class="fa fa-exclamation-triangle" style="margin-right:5px;"></i>'
                        + enc(t('Contains') + ' ' + nestedNote(nested.length) + ': ' + paths.join(', '))
                        + '</div>';
                }
                if (scan.truncated === true) {
                    html += '<div style="font-size:11px;color:var(--anas-muted,gray);">'
                        + enc(t('The scan did not finish — there may be more than listed.')) + '</div>';
                }
                setScanHtml(win, html);
            },
            function (err) {
                if (stale()) {
                    return;
                }
                // Fail-open and HONEST: an unavailable scan says so, it never
                // renders as "nothing is nested".
                setScanHtml(win, '<div style="font-size:11px;color:var(--anas-muted,gray);">'
                    + enc(t('Could not check the source') + ': ' + ANAS.errText(err)) + '</div>');
            }
        );
    }

    function scheduleSourceScan(win, node) {
        if (!win || win.destroyed || win.destroying) {
            return;
        }
        try {
            if (win._cloudScanTimer) {
                clearTimeout(win._cloudScanTimer);
            }
            win._cloudScanTimer = setTimeout(function () {
                win._cloudScanTimer = null;
                scanCloudSource(win, node);
            }, SOURCE_SCAN_DEBOUNCE_MS);
        } catch (e) {
            scanCloudSource(win, node);
        }
    }

    function openPathFor(win, node) {
        var cur = trim(valOf(win, '#cloudSource') || '');
        if (!ANAS.pathPicker) {
            // Fail-open: an older bundle without the picker must not break the
            // wizard — the path field still takes a typed path.
            ANAS.warn('path picker unavailable; type the path instead');
            return;
        }
        ANAS.pathPicker({
            node: node,
            backend: 'live',
            mode: 'dir',
            value: cur || '/',
            title: t('Choose a directory'),
            onSelect: function (chosen) {
                // A SINGLE-select picker hands back the path STRING — the path
                // field is authoritative there, so a typed answer the tree
                // never showed is still a legitimate pick. The object form is
                // tolerated for an older picker, never relied on.
                var f = win.down('#cloudSource');
                if (!f) {
                    return;
                }
                var picked = (typeof chosen === 'string')
                    ? chosen
                    : ((chosen && chosen.path) || '');
                if (picked) {
                    f.setValue(picked);
                }
            },
        });
    }

    // The saved remotes, as the combo's store wants them.
    function remoteStoreData(names) {
        var out = [];
        for (var i = 0; i < names.length; i++) {
            out.push({ name: names[i] });
        }
        return out;
    }

    function openTaskWizard(view, node, existing) {
        var isEdit = !!existing;
        var task = existing || {};
        ANAS.api.get(node, '/cloud/remotes').then(function (res) {
            // The fetched names are what the combo offers — the read was
            // always made, and throwing the list away left the Remote field
            // with an empty store and nothing to pick.
            var names = ((res && res.data) && res.data.remotes || []).map(function (r) {
                return r && r.name;
            }).filter(function (n) {
                return !!n;
            });
            // The combo is the wizard's one precondition: with no remote saved
            // there is nothing to send to (the backup precedent — the toast
            // names the button that fixes it).
            if (!isEdit && !names.length) {
                ANAS.toast(t(EMPTY_REMOTES_TOAST));
                return;
            }
            buildTaskWizard(view, node, isEdit, task, names);
        }, function (err) {
            ANAS.warn('cloud task wizard load failed: ' + ANAS.errText(err));
            ANAS.alertMsg('Load failed',
                t('Failed to load the rclone remotes') + ': ' + ANAS.errText(err));
        });
    }

    function buildTaskWizard(view, node, isEdit, task, remoteNames) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-cloud-task',
                title: isEdit ? (t('Edit Cloud Sync Task') + ': ' + (task.name || '')) : t('New Cloud Sync Task'),
                modal: true,
                width: 620,
                height: 720,
                resizable: true,
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
                            itemId: 'cloudTaskName',
                            cls: 'anas-fld-cloud-task-name',
                            fieldLabel: t('Task name'),
                            emptyText: 'pictures-offsite',
                            disabled: isEdit,
                            allowBlank: false,
                            value: task.name || '',
                            regex: TASK_NAME_RE,
                            maxLength: 64,
                            regexText: t('Lowercase letters, digits and hyphens; must start with a letter or digit.'),
                        },
                        {
                            // The local tree to send. Free-form typing stays
                            // first-class; the picker only fills the field in.
                            xtype: 'fieldcontainer',
                            fieldLabel: t('Source'),
                            labelWidth: 150,
                            layout: 'hbox',
                            items: [
                                {
                                    xtype: 'textfield',
                                    itemId: 'cloudSource',
                                    cls: 'anas-fld-cloud-source',
                                    flex: 1,
                                    emptyText: '/tank/pictures',
                                    allowBlank: false,
                                    value: task.source || '',
                                    listeners: {
                                        change: function () {
                                            var w = this.up('window');
                                            if (w && w._cloudRefreshGate) {
                                                w._cloudRefreshGate();
                                            }
                                            scheduleSourceScan(w, node);
                                        },
                                    },
                                },
                                {
                                    xtype: 'button',
                                    itemId: 'cloudSourceBrowse',
                                    cls: 'anas-btn-cloud-source-browse',
                                    iconCls: 'fa fa-folder-open',
                                    tooltip: t('Browse for a directory'),
                                    margin: '0 0 0 6',
                                    handler: function () {
                                        openPathFor(win, node);
                                    },
                                },
                            ],
                        },
                        {
                            // The derived consistency + the nested note — from
                            // the ONE preview-nested scan, said before the save.
                            xtype: 'component',
                            itemId: 'cloudSourceScan',
                            cls: 'anas-cloud-source-scan',
                            style: 'margin:-2px 0 8px 152px;',
                            html: '',
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'cloudRemote',
                            cls: 'anas-fld-cloud-remote',
                            fieldLabel: t('Remote'),
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            allowBlank: false,
                            displayField: 'name',
                            valueField: 'name',
                            store: {
                                data: remoteStoreData(remoteNames || []),
                                fields: ['name'],
                            },
                            emptyText: t('(no remotes configured)'),
                            value: task.remote || '',
                            listeners: {
                                change: function () {
                                    var w = this.up('window');
                                    if (w && w._cloudRefreshGate) {
                                        w._cloudRefreshGate();
                                    }
                                },
                            },
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'cloudRemotePath',
                            cls: 'anas-fld-cloud-remote-path',
                            fieldLabel: t('Path on remote'),
                            emptyText: t('(the remote\'s own root)'),
                            value: task.path || '',
                            listeners: {
                                change: function () {
                                    var w = this.up('window');
                                    if (w && w._cloudRefreshGate) {
                                        w._cloudRefreshGate();
                                    }
                                },
                            },
                        },
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            html: enc(t('The path under the remote. Leave it empty to send to the '
                                + 'remote\'s own root; on some backends (sftp) a leading / '
                                + 'starts at the remote\'s absolute root.')),
                        },
                        {
                            xtype: 'radiogroup',
                            itemId: 'cloudMode',
                            cls: 'anas-fld-cloud-mode',
                            fieldLabel: t('Mode'),
                            columns: 2,
                            listeners: {
                                change: function () {
                                    var w = this.up('window');
                                    if (w && w._cloudRefreshGate) {
                                        w._cloudRefreshGate();
                                    }
                                },
                            },
                            items: [
                                {
                                    boxLabel: t('Copy'),
                                    name: 'cloudMode', inputValue: 'copy',
                                    checked: task.mode !== 'sync',
                                },
                                {
                                    boxLabel: t('Sync'),
                                    name: 'cloudMode', inputValue: 'sync',
                                    checked: task.mode === 'sync',
                                },
                            ],
                        },
                        {
                            // The one sentence, always visible, verbatim from
                            // the design — the deletion difference is the one
                            // thing to have read before choosing sync.
                            xtype: 'component',
                            itemId: 'cloudModeNote',
                            cls: 'anas-cloud-mode-note',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-2px 0 8px 152px;',
                            html: enc(t(SYNC_SENTENCE)),
                        },
                        {
                            // The dry-run Preview — the backup wizard's, pointed
                            // at the cloud door: user-initiated, one-shot,
                            // nothing is copied or deleted.
                            xtype: 'fieldcontainer',
                            layout: 'hbox',
                            margin: '0 0 4 152px',
                            items: [
                                {
                                    xtype: 'button',
                                    itemId: 'cloudPreviewBtn',
                                    cls: 'anas-btn-cloud-task-preview',
                                    text: t('Preview'),
                                    iconCls: 'fa fa-eye',
                                    disabled: true,
                                    handler: function () {
                                        previewCloudTaskForm(win, node);
                                    },
                                },
                                {
                                    xtype: 'component',
                                    flex: 1,
                                    margin: '4 0 0 8',
                                    style: 'color:var(--anas-muted,gray);font-size:11px;',
                                    html: enc(t('a dry run against the live source — '
                                        + 'nothing is copied or deleted')),
                                },
                            ],
                        },
                        {
                            // The dry-run summary. Empty until a Preview runs;
                            // cleared the moment a field it was computed from
                            // changes (refreshCloudPreview).
                            xtype: 'component',
                            itemId: 'cloudPreviewLine',
                            cls: 'anas-cloud-preview-line',
                            style: 'margin:-2px 0 8px 152px;',
                            html: '',
                        },
                        {
                            xtype: 'textareafield',
                            itemId: 'cloudExcludes',
                            cls: 'anas-fld-cloud-excludes',
                            fieldLabel: t('Excludes'),
                            height: 60,
                            emptyText: t('one per line — e.g. *.tmp'),
                            value: (task.excludes && task.excludes.length)
                                ? task.excludes.join('\n')
                                : '',
                            listeners: {
                                change: function () {
                                    var w = this.up('window');
                                    if (w && w._cloudRefreshGate) {
                                        w._cloudRefreshGate();
                                    }
                                },
                            },
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'cloudBwlimit',
                            cls: 'anas-fld-cloud-bwlimit',
                            fieldLabel: t('Bandwidth limit'),
                            emptyText: '8M',
                            value: task.bwlimit || '',
                            listeners: {
                                change: function () {
                                    var w = this.up('window');
                                    if (w && w._cloudRefreshGate) {
                                        w._cloudRefreshGate();
                                    }
                                },
                            },
                        },
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            html: enc(t('Optional — an rclone rate (digits, optionally suffixed '
                                + 'K, M or G). Empty = no limit.')),
                        },
                        ANAS.sched.cadence.fieldset(ANAS.sched.cadence.of(task), task, function () {
                            if (win) {
                                ANAS.sched.cadence.syncFields(win);
                            }
                        }, 'cloud'),
                        ANAS.notifyMode.field({
                            itemId: 'notifyMode',
                            cls: 'anas-fld-cloud-notify',
                            value: task.notify === 'on-failure' ? 'on-failure' : 'always',
                        }),
                        {
                            xtype: 'component',
                            style: 'color:var(--anas-muted,gray);font-size:11px;margin:-4px 0 8px 152px;',
                            html: enc(t('A finished run notifies through the Proxmox notification '
                                + 'system (type anas-cloud). "Always" mails every run that happened; '
                                + '"On failure" mails only a failed run. A skipped off week never notifies.')),
                        },
                        {
                            xtype: 'checkboxfield',
                            itemId: 'cloudEnabled',
                            cls: 'anas-fld-cloud-enabled',
                            fieldLabel: t('Enabled'),
                            boxLabel: t('Run on the schedule'),
                            checked: task.enabled !== false,
                        },
                    ],
                }],
                buttons: [
                    { text: t('Cancel'), handler: function () { win.close(); } },
                    {
                        text: isEdit ? t('Save') : t('Create'),
                        itemId: 'submit',
                        cls: 'anas-btn-cloud-task-submit',
                        handler: function () {
                            try {
                                submitCloudTask(win, view, node, isEdit, task);
                            } catch (e) {
                                ANAS.warn('cloud task submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            ANAS.warn('cloud task wizard failed: ' + ANAS.errText(e));
            return;
        }

        win._cloudRefreshGate = function () {
            // The remote combo, the mode radios and the remote path land here,
            // as does the source field directly: the Preview gate and its stale
            // summary have one place to go (the save re-checks every gate).
            refreshCloudPreview(win);
        };
        win.show();
        ANAS.sched.cadence.syncFields(win); // show only the fields the opening cadence uses
        scheduleSourceScan(win, node); // the consistency + nested note for the opening source
        refreshCloudPreview(win); // the Preview gate follows the opening form (an edit opens enabled)
    }

    // The task fields the wizard's form holds — ONE reader, shared by the save
    // body and the preview body (two field walks diverge into bugs). A cleared
    // bandwidth limit sends nothing (absent = no limit — the schema normalises
    // the empty string, but absent is what a cleared field means).
    function cloudTaskFields(win) {
        var fields = {
            source: trim(valOf(win, '#cloudSource') || ''),
            remote: trim(valOf(win, '#cloudRemote') || ''),
            path: trim(valOf(win, '#cloudRemotePath') || ''),
            mode: (valOf(win, '#cloudMode') || {}).cloudMode === 'sync' ? 'sync' : 'copy',
            excludes: splitLines(valOf(win, '#cloudExcludes')),
            notify: valOf(win, '#notifyMode') === 'on-failure' ? 'on-failure' : 'always',
            enabled: valOf(win, '#cloudEnabled') === true,
        };
        var bw = trim(valOf(win, '#cloudBwlimit') || '');
        if (bw) {
            fields.bwlimit = bw;
        }
        return fields;
    }

    // Build the request body the shared CloudSyncTaskRequest schema accepts —
    // or null after alerting. Excludes ride as the ARRAY the schema wants (the
    // textarea is one per line); a structured cadence rides ALONE and the
    // daemon generates the OnCalendar (one generator, in the shared schema —
    // never a second copy here).
    function cloudTaskBody(win) {
        var body = { name: trim(valOf(win, '#cloudTaskName') || '') };
        var fields = cloudTaskFields(win);
        var k;
        for (k in fields) {
            if (Object.prototype.hasOwnProperty.call(fields, k)) {
                body[k] = fields[k];
            }
        }
        // Custom = the raw OnCalendar the user typed; every other kind sends
        // the structured cadence (readCadence alerts what is wrong itself).
        var kind = ANAS.sched.cadence.kindOf(win);
        if (kind === 'custom') {
            body.schedule = trim(valOf(win, '#schedule') || '');
            if (!body.schedule) {
                ANAS.alertMsg('Invalid input', t('Enter a schedule.'));
                return null;
            }
        } else {
            var cad = ANAS.sched.cadence.read(win);
            if (!cad) {
                return null; // readCadence already said what is wrong
            }
            body.cadence = cad;
        }
        return body;
    }

    function submitCloudTask(win, view, node, isEdit, task) {
        var body = cloudTaskBody(win);
        if (!body) {
            return; // cloudTaskBody already said what is wrong
        }
        if (!TASK_NAME_RE.test(body.name) || body.name.length > 64) {
            ANAS.alertMsg('Invalid input',
                t('Task name must be lowercase letters, digits and hyphens (≤64 chars).'));
            return;
        }
        if (!body.source || body.source.charAt(0) !== '/') {
            ANAS.alertMsg('Invalid input', t('Enter an absolute source path.'));
            return;
        }
        if (!body.remote) {
            ANAS.alertMsg('Invalid input', t('Choose a remote.'));
            return;
        }
        // The daemon's save-time refusals (a remote the file does not carry, a
        // schedule systemd will not accept) answer 400 with the sentence — the
        // job-failure alert shows it under the field it belongs to.
        ANAS.runJob({
            node: node,
            method: isEdit ? 'put' : 'post',
            path: isEdit ? ('/cloud/tasks/' + encodeURIComponent(body.name)) : '/cloud/tasks',
            body: body,
            view: win,
            failTitle: isEdit ? 'Save failed' : 'Create failed',
            successMsg: isEdit ? (t('Cloud sync task saved') + ': ' + body.name)
                : (t('Cloud sync task created') + ': ' + body.name),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                // The grid reloads with the new row selected (create) — and
                // reloads on FAILURE too (the handler below).
                loadTasks(view, node, false, isEdit ? undefined : body.name);
            },
            onFailed: function () {
                loadTasks(view, node);
            },
        });
    }

    // ---- View ---------------------------------------------------------------

    function cloudView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'source', 'remote', 'path', 'destination', 'mode',
                'notify', 'bwlimit', 'schedule', 'lastRunResult', 'lastRunAt',
                'nextRunAt', 'runningProgress', 'runningJobId', 'lastRunNote',
                { name: 'excludes', type: 'auto' },
                { name: 'cadence', type: 'auto' },
                { name: 'enabled', type: 'auto' },
                { name: 'overdue', type: 'auto' },
                { name: 'raw', type: 'auto' },
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        // rclone.6 review batch B — THIS grid's per-task map of polled run
        // detail (task name → detail), in memory here and nowhere else: the
        // row renderer reads its tiny spark from it, the 5 s poll writes it,
        // and a 10 s quiet reload — which replaces the records — cannot blink
        // the spark away. Kept off the store: the run-errors bag rides the
        // store because it must survive the tab; a run detail is live display
        // state that dies with the view.
        var rowDetails = {};

        var tbar = [
            {
                text: t('Reload'),
                cls: 'anas-btn-refresh anas-btn-cloud-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    loadTasks(btn.up('#cloudView'), node);
                },
            },
            {
                text: t('Create…'),
                cls: 'anas-btn-cloud-task-create',
                iconCls: 'fa fa-plus',
                handler: function (btn) {
                    openTaskWizard(btn.up('#cloudView'), node, null);
                },
            },
            {
                text: t('Remotes…'),
                cls: 'anas-btn-cloud-remotes',
                iconCls: 'fa fa-server',
                handler: function () {
                    openRemotesManager(node);
                },
            },
            '-',
            {
                text: t('Run Now'),
                itemId: 'cloudTaskRun',
                cls: 'anas-btn-cloud-task-run',
                iconCls: 'fa fa-play-circle',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    var rec = selectedTask(gridOf(view));
                    if (rec) {
                        runTaskNow(view, node, rec.get('name'));
                    }
                },
            },
            {
                // rclone.6: the live run dashboard — enabled on the running row
                // while the daemon names its direct job to poll.
                text: t('View run'),
                itemId: 'cloudTaskViewRun',
                cls: 'anas-btn-cloud-task-view-run',
                iconCls: 'fa fa-tachometer',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    var rec = selectedTask(gridOf(view));
                    if (rec && rec.get('runningJobId')) {
                        openRunViewer(node, rec.get('name'), rec.get('runningJobId'),
                            gridOf(view), rowShapeOf(rec));
                    }
                },
            },
            {
                // rclone.5: stop the running run, behind the daemon's confirm
                // (elapsed time, progress, what the stop leaves behind).
                text: t('Cancel run'),
                itemId: 'cloudTaskCancel',
                cls: 'anas-btn-cloud-task-cancel',
                iconCls: 'fa fa-stop-circle',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    var grid = gridOf(view);
                    var rec = selectedTask(grid);
                    if (!rec) {
                        return;
                    }
                    ANAS.sched.cancelRun({
                        node: node,
                        jobId: rec.get('runningJobId'),
                        name: rec.get('name'),
                        view: grid,
                        reload: function () { loadTasks(view, node, true); },
                    });
                },
            },
            {
                text: t('Preview'),
                itemId: 'cloudTaskPreview',
                // Its OWN cls, deliberately not the wizard Preview button's:
                // two buttons on one page under one class would let a
                // page-scoped locator click the wrong one.
                cls: 'anas-btn-cloud-preview-task',
                iconCls: 'fa fa-eye',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    previewTaskRow(node, selectedTask(gridOf(view)), btn);
                },
            },
            {
                text: t('Details'),
                itemId: 'cloudTaskDetails',
                cls: 'anas-btn-cloud-task-details',
                iconCls: 'fa fa-info-circle',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    var rec = selectedTask(gridOf(view));
                    if (rec) {
                        openTaskDetail(node, rec.get('name'));
                    }
                },
            },
            {
                text: t('Edit'),
                itemId: 'cloudTaskEdit',
                cls: 'anas-btn-cloud-task-edit',
                iconCls: 'fa fa-pencil',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    var rec = selectedTask(gridOf(view));
                    // No stored task on the record = nothing to edit: open the
                    // wizard as a CREATE rather than as a blank Edit that would
                    // save an empty task under the row's name.
                    openTaskWizard(view, node, (rec && rec.get('raw')) || null);
                },
            },
            {
                text: t('Disable'),
                itemId: 'cloudTaskToggle',
                cls: 'anas-btn-cloud-task-toggle',
                iconCls: 'fa fa-pause',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    toggleTask(view, node, selectedTask(gridOf(view)));
                },
            },
            {
                text: t('Remove'),
                itemId: 'cloudTaskRemove',
                cls: 'anas-btn-cloud-task-remove',
                iconCls: 'fa fa-trash',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#cloudView');
                    removeTask(view, node, selectedTask(gridOf(view)));
                },
            },
        ];

        return {
            xtype: 'panel',
            itemId: 'cloudView',
            cls: 'anas-view anas-view-cloud',
            title: t('Cloud Sync'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'gridpanel',
                    itemId: 'cloudTasksGrid',
                    cls: 'anas-grid-cloud-tasks',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No cloud sync tasks defined'),
                    columns: [
                        {
                            // The tooltip carries the whole name: a column is a
                            // width, and an id is never shortened to fit one.
                            text: t('Name'), dataIndex: 'name', width: 150,
                            renderer: renderName,
                        },
                        {
                            text: t('Source'), dataIndex: 'source', flex: 1,
                            minWidth: 180, sortable: false, menuDisabled: true,
                            renderer: renderSource,
                        },
                        {
                            text: t('Destination'), dataIndex: 'destination',
                            width: 220, sortable: false, menuDisabled: true,
                            renderer: renderDestination,
                        },
                        {
                            text: t('Mode'), dataIndex: 'mode', width: 80,
                            align: 'center', renderer: renderMode,
                        },
                        {
                            // Wide enough for a spelled-out cadence ("Every
                            // other week · Tue · 02:00 · even ISO weeks") —
                            // never truncated (the Backup grid's own width).
                            text: t('Schedule'), dataIndex: 'schedule', width: 260,
                            renderer: renderSchedule,
                        },
                        {
                            text: t('Last run'), dataIndex: 'lastRunResult', width: 170,
                            sortable: false, menuDisabled: true,
                            // THIS grid's detail map rides along to the renderer
                            // (rclone.6 review batch B) — one closure per view.
                            renderer: function (v, meta, rec) {
                                return renderLastRun(v, meta, rec, rowDetails);
                            },
                        },
                        {
                            text: t('Next run'), dataIndex: 'nextRunAt', width: 110,
                            renderer: renderNextRun,
                        },
                        {
                            text: t('Enabled'), dataIndex: 'enabled', width: 90,
                            align: 'center', renderer: renderEnabled,
                        },
                    ],
                    tbar: ANAS.tbar(tbar),
                    listeners: {
                        selectionchange: function (selModel, selected) {
                            var grid = this;
                            if (grid.anasReloading && !(selected && selected.length)) {
                                return;
                            }
                            updateTaskButtons(grid);
                        },
                        itemdblclick: function (grid, rec) {
                            var view = grid.up('#cloudView');
                            openTaskWizard(view, node, (rec && rec.get('raw')) || null);
                        },
                        // rclone.6: the running text on the row opens the run
                        // viewer — the pill marks itself with the task name and
                        // the click only answers when that mark is in the cell.
                        cellclick: function (grid, td, cellIndex, rec) {
                            if (!rec || rec.get('lastRunResult') !== 'running'
                                || !rec.get('runningJobId')) {
                                return;
                            }
                            var html = td && td.innerHTML ? td.innerHTML : (td || '');
                            if (('' + html).indexOf('data-anas-run-view') >= 0) {
                                openRunViewer(node, rec.get('name'), rec.get('runningJobId'),
                                    grid, rowShapeOf(rec));
                            }
                        },
                        destroy: function (grid) {
                            if (grid._anasRowTimer) {
                                clearInterval(grid._anasRowTimer);
                                grid._anasRowTimer = null;
                            }
                        },
                    },
                },
                {
                    // 503 — the node has no rclone: the daemon's sentence takes
                    // the grid's place.
                    xtype: 'component',
                    itemId: 'cloudTasksUnavailable',
                    cls: 'anas-cloud-unavailable',
                    hidden: true,
                },
            ],
            listeners: ANAS.sched.viewListeners(function (v, quiet) {
                // The view carries THIS grid's detail map so every loadTasks
                // path — refresh, Run now, toggle — lands detail in the same
                // object the row renderer reads (rclone.6 review batch B).
                v._anasRowDetailBag = rowDetails;
                loadTasks(v, node, quiet);
            }),
        };
    }

    ANAS.cloud = {
        openRemotes: openRemotesManager,
        openTaskWizard: openTaskWizard,
        // rclone.6: the run viewer — the window and its PURE body renderer,
        // the latter so the harness asserts every section from a fixture job.
        openRunViewer: openRunViewer,
        runViewerBody: runViewerBody,
        // rclone.6 review batch B: `normalizeOAuthToken` is exported so the
        // dialog-contracts harness can run the shared test-vector file
        // (`packages/shared/test-vectors/oauth-token-normalisation.json`)
        // through the UI's OWN copy — the daemon's parser is pinned by the
        // same vectors, so the two cannot drift.
        normalizeOAuthToken: normalizeOAuthToken,
        // rclone.4 rider: `validateOwnClient` is exported for the same
        // harness pattern, over `packages/shared/test-vectors/own-client.json`
        // — the daemon's doors run the shared rule the port literalises.
        validateOwnClient: validateOwnClient,
        // The grid's per-task run-detail map (rclone.6 review batch B) —
        // exposed for the harness to seed and assert against.
        rowDetailBagOf: function (grid) {
            return (grid && grid._anasRowDetailBag) || null;
        },
        // The management keys the preview body never carries — exported so the
        // harness pins the body against the list instead of against a copy.
        taskManagementKeys: CLOUD_TASK_MANAGEMENT_KEYS,
    };

    // ---- View registration -------------------------------------------------

    ANAS.views['cloud'] = {
        itemId: 'anas-cloud',
        text: t('Cloud Sync'),
        iconCls: 'fa fa-cloud',
        factory: function (node) {
            try {
                return cloudView(node);
            } catch (e) {
                ANAS.warn('cloud view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
