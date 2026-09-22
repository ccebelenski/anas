/*
 * ANAS — gateway API helper (ANAS.api).
 *
 * The browser talks to the ANAS gateway through PVE's own front door: every
 * call goes to the same :8006 origin that serves the PVE UI, under the `/anas`
 * base path (story 12.2 — docs/PROXY-TRANSPORT-DESIGN.md). pveproxy's additive
 * hook strips `/anas` and forwards to the loopback gateway. Same origin means
 * PVEAuthCookie flows on its own (credentials: 'include'), no CORS, and no
 * separate cert exception. The <node> path segment lets the gateway
 * route/forward per-node server-side; the browser never contacts another node.
 *
 *   /anas/api/nodes/<node>/v1<path>   (resolved against the :8006 UI origin)
 *
 * All calls return a Promise. Non-2xx rejects with an Error carrying `.status`
 * and `.body` (the parsed ApiError body when available). 202 is 2xx, so it
 * resolves with the parsed body ({ job }).
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    // Single base prefix for every gateway call. Relative, so it resolves
    // against the current (:8006) origin; pveproxy proxies /anas to the
    // loopback gateway, which strips the prefix — its route table is unchanged.
    var API_BASE = '/anas';

    function nodeBase(node) {
        return API_BASE + '/api/nodes/' + encodeURIComponent(node) + '/v1';
    }

    // Low-level fetch → Promise. Parses JSON when the response advertises it,
    // otherwise text. Resolves on 2xx (incl. 202), rejects otherwise with an
    // Error carrying .status, .body, and (for 409 confirmation) .confirmCode /
    // .confirmExpires read from the X-Anas-Confirm-* response headers.
    // `opts` may carry { confirmCode } — resent as the X-Anas-Confirm header to
    // proceed through a dangerous operation's confirmation gate.
    function doFetch(method, url, body, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            if (typeof fetch !== 'function') {
                var noFetch = new Error('fetch API unavailable');
                noFetch.status = 0;
                reject(noFetch);
                return;
            }

            var fetchOpts = {
                method: method,
                credentials: 'include',
                headers: { Accept: 'application/json' },
            };
            if (body !== undefined && body !== null) {
                fetchOpts.headers['Content-Type'] = 'application/json';
                fetchOpts.body = JSON.stringify(body);
            }
            if (opts.confirmCode) {
                fetchOpts.headers['X-Anas-Confirm'] = opts.confirmCode;
            }

            fetch(url, fetchOpts).then(function (res) {
                // Version-skew visibility (12.1): the gateway stamps every
                // response with its own version. Remember the latest sighting;
                // the health probe compares it against the UI build and the
                // node's daemon version.
                try {
                    var gwVersion = res.headers.get('x-anas-version');
                    if (gwVersion) {
                        ANAS.gatewayVersion = gwVersion;
                    }
                } catch (hv) {
                    // header unreadable — skew check simply has less to compare
                }
                // Read as text, then attempt JSON — the gateway always speaks
                // JSON, but reading text first keeps error bodies intact even
                // when a proxy strips or mangles the Content-Type header.
                res.text().then(function (text) {
                    var data = text;
                    if (text) {
                        try {
                            data = JSON.parse(text);
                        } catch (e) {
                            // leave as raw text if not JSON
                        }
                    }
                    if (res.status >= 200 && res.status < 300) {
                        resolve(data);
                        return;
                    }
                    var msg = 'HTTP ' + res.status;
                    if (data && data.error && data.error.message) {
                        msg = data.error.message;
                    } else if (res.statusText) {
                        msg = res.statusText;
                    }
                    var err = new Error(msg);
                    err.status = res.status;
                    err.body = data;
                    // Confirmation contract (409): surface the code + expiry so
                    // callers can prompt and resend. Headers are exposed via CORS.
                    try {
                        err.confirmCode = res.headers.get('x-anas-confirm-code') || null;
                        err.confirmExpires = res.headers.get('x-anas-confirm-expires') || null;
                    } catch (he) {
                        // headers unreadable — leave undefined
                    }
                    reject(err);
                }, function (bodyErr) {
                    var e2 = new Error('failed to read response body: ' + (bodyErr && bodyErr.message));
                    e2.status = res.status;
                    reject(e2);
                });
            }, function (networkErr) {
                // Connection refused / TLS / DNS — treated as "not reachable".
                var e = new Error((networkErr && networkErr.message) || 'network error');
                e.status = 0;
                reject(e);
            });
        });
    }

    var api = {};

    // Per-node request. `path` is relative to /v1 and must start with '/'.
    // `opts` (optional) may carry { confirmCode } for the confirmation flow.
    api.request = function (method, node, path, body, opts) {
        return doFetch(method, nodeBase(node) + path, body, opts);
    };

    api.get = function (node, path) {
        return api.request('GET', node, path);
    };
    api.post = function (node, path, body, opts) {
        return api.request('POST', node, path, body, opts);
    };
    api.put = function (node, path, body, opts) {
        return api.request('PUT', node, path, body, opts);
    };
    api.del = function (node, path, opts) {
        return api.request('DELETE', node, path, undefined, opts);
    };

    // Per-NODE availability probe (cluster-correct). Hits the node-scoped daemon
    // health through the gateway proxy: on the local node (or a peer that also
    // runs ANAS) the daemon answers 200 and the view renders; on a node WITHOUT
    // ANAS the gateway can't reach its peer and returns 502 (or the peer's :8006
    // 404s /anas), so this rejects and the caller shows the clean "not installed
    // on this node" panel.
    // (A LOCAL /api/health probe would always pass when connected through an
    // ANAS node — views on ANAS-less peers would render, then error raw.)
    api.health = function (node) {
        return doFetch('GET', nodeBase(node) + '/health');
    };

    ANAS.api = api;

    // ---- Shared mutation helpers ----
    //
    // Every ANAS mutation is a job (202 + { job }). runJob submits the mutation
    // and polls the job to completion, so views don't each re-implement polling.
    //
    // opts:
    //   node, method ('post'|'put'|'del'), path, body, confirmCode
    //   view       — a component; polling stops if it is destroyed
    //   maxMs      — poll budget (default 15000)
    //   successMsg — toast on completion
    //   failTitle  — alert title on failure (default 'Operation failed')
    //   onComplete(job) / onFailed(job) / onConfirm(err) — callbacks
    // onConfirm receives the rejected 409 Error (with .confirmCode) so callers
    // can prompt and retry with { confirmCode }. If absent, ANAS.confirmAndRun
    // wraps this for the standard prompt flow.
    ANAS.runJob = function (opts) {
        var node = opts.node;
        var method = (opts.method || 'post').toLowerCase();
        var reqOpts = opts.confirmCode ? { confirmCode: opts.confirmCode } : undefined;
        var call;
        if (method === 'put') {
            call = api.put(node, opts.path, opts.body, reqOpts);
        } else if (method === 'del' || method === 'delete') {
            call = api.del(node, opts.path, reqOpts);
        } else {
            call = api.post(node, opts.path, opts.body, reqOpts);
        }
        return call.then(function (res) {
            var job = res && res.job;
            if (!job || !job.id) {
                if (opts.onComplete) { opts.onComplete(null); }
                return;
            }
            // Fires the moment the daemon ACCEPTS the job (202) — long-job
            // dialogs close/disable here; onComplete still fires at the end.
            if (opts.onSubmitted) {
                try { opts.onSubmitted(job); } catch (eSub) { ANAS.warn('onSubmitted failed: ' + ANAS.errText(eSub)); }
            }
            ANAS.pollJob(node, job.id, opts);
        }, function (err) {
            if (err && err.status === 409 && err.confirmCode && opts.onConfirm) {
                opts.onConfirm(err);
                return;
            }
            if (opts.onFailed) { opts.onFailed(null); }
            try {
                Ext.Msg.alert(ANAS.t(opts.failTitle || 'Operation failed'), ANAS.errText(err));
            } catch (e) {
                ANAS.warn(ANAS.errText(err));
            }
        });
    };

    ANAS.pollJob = function (node, jobId, opts) {
        var interval = 500;
        var maxMs = opts.maxMs || 15000;
        var elapsed = 0;
        var view = opts.view;
        function dead() {
            return view && (view.destroyed || view.destroying);
        }
        function tick() {
            if (dead()) { return; }
            api.get(node, '/jobs/' + encodeURIComponent(jobId)).then(function (res) {
                if (dead()) { return; }
                var job = res && res.job;
                var status = job && job.status;
                if (status === 'completed') {
                    if (opts.successMsg) { ANAS.toast(opts.successMsg); }
                    if (opts.onComplete) { opts.onComplete(job); }
                    return;
                }
                if (status === 'failed') {
                    var msg = (job && job.error && job.error.message) || ANAS.t('unknown error');
                    try {
                        Ext.Msg.alert(ANAS.t(opts.failTitle || 'Operation failed'), msg);
                    } catch (e) {
                        ANAS.warn(msg);
                    }
                    if (opts.onFailed) { opts.onFailed(job); }
                    return;
                }
                elapsed += interval;
                if (elapsed >= maxMs) {
                    // Still running after the wait window — treat as "kicked off
                    // ok" and let the caller refresh; stop polling.
                    if (opts.onComplete) { opts.onComplete(job); }
                    return;
                }
                setTimeout(tick, interval);
            }, function (err) {
                if (dead()) { return; }
                ANAS.warn('job poll failed: ' + ANAS.errText(err));
            });
        }
        setTimeout(tick, interval);
    };

    // Server-warnings → HTML bullet list. Single source for the
    // '<ul><li>…</li></ul>' builder that confirmAndRun and every hand-rolled
    // destructive-confirm window used to copy. Empty/absent → '' (no stray list).
    ANAS.warningsHtml = function (warnings) {
        warnings = warnings || [];
        if (!warnings.length) { return ''; }
        return '<ul><li>' + warnings.map(function (w) {
            return ANAS.enc(w);
        }).join('</li><li>') + '</li></ul>';
    };

    // Shallow-copy an opts object (own enumerable keys only).
    function shallowCopy(o) {
        var out = {};
        var k;
        for (k in o) { if (o.hasOwnProperty(k)) { out[k] = o[k]; } }
        return out;
    }

    // Build the confirmed-resend runJob opts from the original opts + the 409's
    // confirm code, folding in an optional { pathSuffix, bodyPatch } from a
    // widget dialog's mapConfirm.
    function buildRetry(opts, err, extra) {
        var retry = shallowCopy(opts);
        retry.confirmCode = err.confirmCode;
        extra = extra || {};
        if (extra.pathSuffix) { retry.path = opts.path + extra.pathSuffix; }
        if (extra.bodyPatch) {
            var body = shallowCopy(opts.body || {});
            var pk;
            for (pk in extra.bodyPatch) {
                if (extra.bodyPatch.hasOwnProperty(pk)) { body[pk] = extra.bodyPatch[pk]; }
            }
            retry.body = body;
        }
        return retry;
    }

    // Widget-hosting confirm window: an Ext.window.Window (Ext.Msg.confirm cannot
    // host a checkbox) with the warnings + any extraItems, a normal (non-flat)
    // primary button, and Cancel as the default (Enter = the safe choice for a
    // destructive op). On confirm, mapConfirm(win) may return
    // { pathSuffix, bodyPatch } folded into the resend.
    function confirmWindow(opts, err) {
        var intro = opts.confirmIntro || ANAS.t('This operation requires confirmation:');
        var items = [{
            xtype: 'component',
            html: intro + ANAS.warningsHtml((err.body && err.body.error && err.body.error.warnings) || []),
            margin: '0 0 8 0',
        }];
        var extra = opts.extraItems || [];
        for (var i = 0; i < extra.length; i++) { items.push(extra[i]); }
        var win = Ext.create('Ext.window.Window', {
            title: ANAS.t(opts.confirmTitle || 'Confirm'),
            cls: opts.confirmCls || 'anas-win-confirm',
            modal: true,
            width: opts.confirmWidth || 460,
            bodyPadding: 12,
            layout: 'anchor',
            items: items,
            defaultButton: 'anasConfirmCancelBtn',
            buttons: [{
                text: ANAS.t('Cancel'),
                itemId: 'anasConfirmCancelBtn',
                handler: function () { win.close(); },
            }, {
                text: ANAS.t(opts.confirmButtonText || 'OK'),
                cls: opts.confirmButtonCls,
                handler: function () {
                    var extraOut = (typeof opts.mapConfirm === 'function')
                        ? (opts.mapConfirm(win) || {}) : {};
                    win.close();
                    ANAS.runJob(buildRetry(opts, err, extraOut));
                },
            }],
        });
        win.show();
    }

    // Dangerous-operation wrapper (Principle 14): run a mutation; on a 409 with a
    // confirm code, show the server's warnings and, if the user confirms, resend
    // with the code. `opts` is a runJob opts object; `confirmTitle`/`confirmIntro`
    // customise the dialog.
    //
    // Two presentations:
    //   * default — Ext.Msg.confirm (Yes/No) for a plain confirmation.
    //   * widget window — set confirmWindow:true to render an Ext.window.Window
    //     that can host extraItems:[checkboxCfg,…]; mapConfirm(win) → optional
    //     { pathSuffix, bodyPatch } folds the widget values into the resend. Also
    //     honours confirmCls / confirmButtonText / confirmButtonCls / confirmWidth.
    ANAS.confirmAndRun = function (opts) {
        var base = shallowCopy(opts);
        base.onConfirm = function (err) {
            try {
                if (opts.confirmWindow) {
                    confirmWindow(opts, err);
                    return;
                }
                var warnings = (err.body && err.body.error && err.body.error.warnings) || [];
                var intro = opts.confirmIntro || ANAS.t('This operation requires confirmation:');
                var msg = intro + ANAS.warningsHtml(warnings);
                Ext.Msg.confirm(ANAS.t(opts.confirmTitle || 'Confirm'), msg, function (btn) {
                    if (btn === 'yes') {
                        ANAS.runJob(buildRetry(opts, err));
                    }
                });
            } catch (e) {
                ANAS.warn('confirm dialog failed: ' + ANAS.errText(e));
            }
        };
        ANAS.runJob(base);
    };

    // CAS-aware mutation: POST/PUT/DELETE returning a 202 job. Success polls the
    // job; a 409 whose error code is 'CONFLICT' (the registry moved under us) is
    // routed to onConflict for a reload-and-retry — but any OTHER 409 (e.g.
    // IN_USE: a repo still referenced by tasks) is a refusal whose message must
    // surface, so it falls through to onError/alert and is never swallowed.
    // Distinct from runJob/confirmAndRun: the registry 409 is a stale-version
    // conflict, not an X-Anas-Confirm-Code challenge.
    //   o: node, method('post'|'put'|'del'), path, body, view, successMsg,
    //      failTitle, onComplete, onFailed, onConflict(err), onError(err)
    ANAS.casWrite = function (o) {
        var call;
        if (o.method === 'put') {
            call = api.put(o.node, o.path, o.body);
        } else if (o.method === 'del') {
            call = api.del(o.node, o.path);
        } else {
            call = api.post(o.node, o.path, o.body);
        }
        call.then(function (res) {
            var job = res && res.job;
            if (!job || !job.id) {
                if (o.successMsg) { ANAS.toast(o.successMsg); }
                if (o.onComplete) { o.onComplete(); }
                return;
            }
            ANAS.pollJob(o.node, job.id, {
                view: o.view,
                successMsg: o.successMsg,
                failTitle: o.failTitle,
                onComplete: function () { if (o.onComplete) { o.onComplete(); } },
                onFailed: o.onFailed,
            });
        }, function (err) {
            if (err && err.status === 409) {
                var code = err.body && err.body.error && err.body.error.code;
                if (code === 'CONFLICT' && o.onConflict) {
                    o.onConflict(err);
                    return;
                }
            }
            if (o.onError) {
                o.onError(err);
                return;
            }
            ANAS.alertMsg(o.failTitle || 'Operation failed', ANAS.errText(err));
        });
    };

    // Change-mountpoint flow (shared by Pools and AHR): prompt for a new
    // mountpoint prefilled with the current path, guard the value-unchanged case,
    // then confirmAndRun the PUT (the daemon validates + confirm-gates the
    // remount). Callers differ only in resourcePath, label, current, and onDone.
    //   o: node, resourcePath (e.g. '/pools/tank' — '/mountpoint' is appended),
    //      label (display name), current (prefill), view, onDone()
    ANAS.changeMountpointFlow = function (o) {
        var current = o.current || '';
        try {
            Ext.Msg.prompt(ANAS.t('Change mount'),
                ANAS.t('New mountpoint for') + ' <b>' + ANAS.enc(o.label) + '</b>:',
                function (btn, value) {
                    if (btn !== 'ok' || !value || value === current) {
                        return;
                    }
                    ANAS.confirmAndRun({
                        node: o.node,
                        method: 'put',
                        path: o.resourcePath + '/mountpoint',
                        body: { mountpoint: value },
                        view: o.view,
                        confirmTitle: 'Change mount',
                        confirmIntro: ANAS.t('Moving') + ' <b>' + ANAS.enc(o.label) + '</b> '
                            + ANAS.t('to') + ' <b>' + ANAS.enc(value) + '</b>:',
                        failTitle: 'Change mount failed',
                        successMsg: ANAS.t('Mountpoint changed') + ': ' + value,
                        onComplete: function () { if (o.onDone) { o.onDone(); } },
                    });
                }, null, false, current);
        } catch (e) {
            ANAS.warn('changeMountpointFlow failed: ' + ANAS.errText(e));
        }
    };

    // ---- Shared edit guard (save gate) -------------------------------------
    //
    // An edit dialog NEVER substitutes stored identity: when a stored pool or
    // target location is missing from freshly-loaded inventory (a pool
    // exported, a remote de-registered, an endpoint that answered with an
    // empty list), falling back to the first row silently rewrites where the
    // task reads from or writes to. So the stored value stays on screen marked
    // "(unavailable)" and Save is BLOCKED with a named reason until the
    // operator decides — and the daemon refuses an unflagged retarget
    // regardless. One rule, shared by the replication task dialog
    // (65-replication.js, #39) and the snapshot schedule dialog
    // (69-snapshots.js, #40).
    //
    // State lives on the window: win._saveBlocks = { key: reason }. reason()
    // reports the first live block (or '' when the gate is open); refresh()
    // mirrors it onto the #submit button and the #guardNote component (noteCfg
    // is that component's config); block/unblock update the map and re-run
    // refresh().
    ANAS.editGuard = {
        reason: function (win) {
            var blocks = win._saveBlocks || {};
            var keys = Object.keys(blocks);
            for (var i = 0; i < keys.length; i++) {
                if (blocks[keys[i]]) {
                    return blocks[keys[i]];
                }
            }
            return '';
        },
        // Disable Save and show WHY, in the dialog, in the operator's words.
        refresh: function (win) {
            var reason = ANAS.editGuard.reason(win);
            try {
                var btn = win.down('#submit');
                if (btn) {
                    btn.setDisabled(!!reason);
                }
                var note = win.down('#guardNote');
                if (note) {
                    note.setHidden(!reason);
                    note.setHtml(reason
                        ? '<div style="color:var(--anas-danger,#c23b2c);font-size:12px;">' + ANAS.enc(reason) + '</div>'
                        : '');
                }
            } catch (e) {
                // Cosmetic only — the dialog's submit handler re-checks the
                // gate before it sends.
            }
        },
        block: function (win, key, reason) {
            win._saveBlocks = win._saveBlocks || {};
            win._saveBlocks[key] = reason;
            ANAS.editGuard.refresh(win);
        },
        unblock: function (win, key) {
            if (win._saveBlocks) {
                delete win._saveBlocks[key];
            }
            ANAS.editGuard.refresh(win);
        },
        // The note the gate writes into, placed at the top of a dialog's form.
        noteCfg: function () {
            return {
                xtype: 'component',
                itemId: 'guardNote',
                cls: 'anas-edit-guard',
                hidden: true,
                margin: '0 0 8 0',
                html: '',
            };
        },
    };

    // ---- Shared PVE-footprint ownership helper (pvepool.2, U0) ------------
    //
    // The ONE client-side ownership helper. The daemon stamps each dataset
    // node with a per-node `pve` verdict (PveOwnership: { kind, storage?,
    // reason }); a dataset with NO verdict is outside PVE's footprint and ANAS
    // may manage it. Six UI files used to each carry their own `isPveManaged`
    // copy — they all delegate to this (DESIGN.md "PVE footprint ownership").
    //
    // Version skew (fail-safe direction — DESIGN §2 ruling): an OLD daemon
    // omits the per-node `pve` field entirely. A new UI that sees
    // `pveStorages[]` non-empty on the pool AND no per-node field keeps
    // TODAY'S whole-pool rule (the pool is PVE's). Skew may only ever TIGHTEN
    // a hands-off gate, never loosen it. `perNodeAvailable` tells the helper
    // which side of the skew we are on:
    //   true  — the payload came from a daemon that stamps `pve`; a missing
    //           `node.pve` then means NOT owned.
    //   false — old daemon (no per-node field); fall back to the whole-pool
    //           rule via `pool.pveStorages`.
    // The CALLER decides perNodeAvailable. The simplest reliable signal for a
    // dataset tree is whether the daemon returned the `pve` key on ANY node of
    // that payload (owned or not). A pool ROW (the Pools grid) carries no
    // per-node field by construction, so it is always passed `false` and rides
    // the whole-pool rule.

    // Read a field off an ExtJS record (.get) or a plain tree node, never
    // throwing — pool rows are records, dataset tree nodes are plain objects.
    function pveField(rec, name) {
        try {
            if (rec && typeof rec.get === 'function') {
                return rec.get(name);
            }
        } catch (e) {
            // getter threw — fall through to a property read
        }
        return rec ? rec[name] : undefined;
    }

    // The pool's PVE storages as a plain array (never null). Non-array /
    // malformed ⇒ []. Exported as ANAS.pve.storagesOf — the ONE copy.
    function pveStoragesList(pool) {
        try {
            var v = pveField(pool, 'pveStorages');
            if (v && Object.prototype.toString.call(v) === '[object Array]' && v.length) {
                return v;
            }
        } catch (e) {
            // malformed field — ANAS-managed (fail-open, never block)
        }
        return [];
    }

    // The per-kind badge label drawn beside a dataset name (the Datasets
    // tree). Raw (un-encoded) — the badge renderer encodes it. `<id>` is the
    // owning storage id; `system` carries no storage id. Unknown kinds (a
    // daemon newer than this UI) still read as hands-off — forward
    // compatibility, never a crash and never a row that looks manageable.
    function pveKindLabel(o) {
        var s = (o && o.storage) ? o.storage : '';
        switch (o && o.kind) {
            case 'storage-root':
                return ANAS.t('PVE storage root') + ': ' + s;
            case 'guest-volume':
                return ANAS.t('PVE guest volume') + ' (' + s + ')';
            case 'dir-storage':
                return ANAS.t('PVE storage') + ' (' + s + ')';
            case 'system':
                return ANAS.t('System pool') + ': ' + ANAS.t('boot filesystem');
            case 'config-unreadable':
                // storage.cfg could not be read — the daemon stamps EVERY
                // dataset on EVERY pool with it; the reason names storage.cfg.
                return ANAS.t('PVE config unreadable — hands-off');
            default:
                return ANAS.t('PVE — hands-off');
        }
    }

    ANAS.pve = {
        // The guest-volume name contract, verbatim from ZFSPoolPlugin.pm
        // `zfs_parse_zvol_list` (PVE 9.2.20). The ONE permitted duplicate —
        // the browser bundle cannot import @anas/shared; the source of truth
        // is packages/shared/src/pve-footprint.ts (PVE_GUEST_VOLUME_RE).
        GUEST_NAME_RE: /^(vm|base|subvol|basevol)-\d+-\S+$/,

        // ownership(node, pool, perNodeAvailable) → the PveOwnership object for
        // `node`, or null when ANAS may manage it.
        //   node   — the dataset record/row (may carry pve: { kind, storage?,
        //     reason } stamped by the daemon; kinds: 'storage-root' |
        //     'guest-volume' | 'dir-storage' | 'system').
        //   pool   — the pool record/summary (carries pveStorages: [PveStorageRef]).
        //   perNodeAvailable — see the section note above.
        ownership: function (node, pool, perNodeAvailable) {
            var pve = pveField(node, 'pve');
            if (pve && typeof pve === 'object') {
                return pve;
            }
            if (!perNodeAvailable) {
                // Old daemon — no per-node field. Whole-pool rule: a pool PVE
                // names is PVE's (tightens the gate, never loosens it).
                var storages = pveStoragesList(pool);
                if (storages.length) {
                    var first = storages[0] || {};
                    var id = first.storage || first.dataset || '';
                    var poolName = pveField(pool, 'name') || '';
                    return {
                        kind: 'storage-root',
                        storage: id,
                        reason: "PVE storage '" + id + "' manages pool '" + poolName
                            + "' (older daemon — per-dataset ownership unavailable)",
                    };
                }
            }
            // perNodeAvailable=true with no `pve`, or an empty pveStorages:
            // outside PVE's footprint — ANAS may manage it.
            return null;
        },

        // isOwned(node, pool, perNodeAvailable) → boolean convenience.
        isOwned: function (node, pool, perNodeAvailable) {
            return !!ANAS.pve.ownership(node, pool, perNodeAvailable);
        },

        // fieldOf(rec, name) → the field off an ExtJS record (.get) or a plain
        // node (.name), never throwing — pveField above, the ONE guarded
        // accessor, exported so the screens stop re-deriving it per file.
        fieldOf: pveField,

        // storagesOf(pool) → the pool's PVE storages as a plain array (never
        // null; non-array / malformed ⇒ []). The ONE copy — 30-pools and
        // 60-datasets each used to carry their own (pveStoragesOf /
        // poolPveStorages), and identical field-shape rules in two places
        // drift.
        storagesOf: function (pool) {
            return pveStoragesList(pool);
        },

        // badge(ownership) → { html, tip } for a dataset's PVE badge. `html`
        // is the INNER badge (gfx.badge when the gfx layer is up, a plain
        // .anas-gfx-badge span otherwise) so the look matches 30-pools.js's
        // existing PVE tag exactly; `tip` = ownership.reason (the tooltip).
        // The caller wraps `html` in its own outer span (e.g. .anas-ds-pve-
        // badge / .anas-pool-pve-badge) so each screen keeps its hook class.
        badge: function (ownership) {
            if (!ownership || typeof ownership !== 'object') {
                return { html: '', tip: '' };
            }
            var tip = ownership.reason || '';
            var label = pveKindLabel(ownership);
            var html = '';
            try {
                var gfx = ANAS.gfx;
                if (gfx && typeof gfx.badge === 'function') {
                    html = gfx.badge(label, { title: tip }) || '';
                }
            } catch (e) {
                // gfx unavailable — fall back to a plain badge (never break the row)
                html = '';
            }
            if (!html) {
                html = '<span class="anas-gfx-badge" title="' + ANAS.enc(tip)
                    + '">' + ANAS.enc(label) + '</span>';
            }
            return { html: html, tip: tip };
        },

        // wouldBeClaimed(parentName, baseName, pool) → { storage } or null: the
        // naming guard, client side. Non-null when PVE would inventory a new
        // dataset on its next `zfs list -d1` — its parent (parentName) IS a
        // zfspool storage's configured path (storage.dataset, falling back to
        // the pool name) AND baseName matches the guest-volume regex. Only the
        // zfspool DIRECT-child shape counts: a dir storage inventories plain
        // files, and deeper nesting is never listed. Mirrors the daemon's
        // wouldBeClaimedByPve (packages/shared/src/pve-footprint.ts).
        wouldBeClaimed: function (parentName, baseName, pool) {
            parentName = '' + (parentName || '');
            baseName = '' + (baseName || '');
            if (!baseName || !ANAS.pve.GUEST_NAME_RE.test(baseName)) {
                return null;
            }
            var storages = pveStoragesList(pool);
            var poolName = '' + (pveField(pool, 'name') || '');
            for (var i = 0; i < storages.length; i++) {
                var s = storages[i] || {};
                if (s.type !== 'zfspool') {
                    continue;
                }
                var path = s.dataset || poolName;
                if (path && path === parentName) {
                    return { storage: s.storage };
                }
            }
            return null;
        },
    };
})();
