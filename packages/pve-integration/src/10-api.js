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

    // The current PVE CSRF token, or null when the PVE global does not carry one
    // (not yet logged in, or a page outside the PVE UI). Never throws.
    function csrfToken() {
        var pve = window.Proxmox;
        var token = pve && pve.CSRFPreventionToken;
        return (typeof token === 'string' && token.length > 0) ? token : null;
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
            // PVE's CSRF token (cr.25a, docs/WAVE2-DESIGN.md §3), sent on every
            // request. Read from the PVE global at CALL time, never cached: PVE
            // replaces it on every ticket renewal and a kept copy expires after
            // 2 h. Absent global → header omitted, the request goes out as before.
            var csrf = csrfToken();
            if (csrf) {
                fetchOpts.headers.CSRFPreventionToken = csrf;
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
    //   maxMs      — the attention window (default 15000): past it a still-
    //                running job announces itself once (cr.45), polling continues
    //   what       — short noun phrase for the still-running / lost sentences;
    //                falls back to 'The job' (the daemon's operation id is an
    //                internal key, never shown to the operator)
    //   successMsg — toast on completion
    //   failTitle  — alert title on failure (default 'Operation failed')
    //   onComplete(job) / onFailed(job) / onConfirm(err) — callbacks.
    //                onComplete fires ONLY on `completed` (cr.45); a job whose
    //                outcome is unknown (the daemon lost it, contact lost) goes
    //                to onLost(err) if given, else onFailed(null) — the reload
    //                every panel's onFailed already does.
    //   onCancelled(job) — the job ended `cancelled` (rclone.5); without it a
    //                toast carries the daemon's reason
    //   onStillRunning(job) — once, when the job is still running past maxMs;
    //                without it a default toast points at Recent activity
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
            jobRejected(opts, err);
        });
    };

    // A mutation the daemon refused outright: onFailed, then the failure alert
    // carrying the daemon's own sentence.
    function jobRejected(opts, err) {
        if (opts.onFailed) { opts.onFailed(null); }
        try {
            // Encoded: daemon text can carry remote-controlled stderr (review M5).
            Ext.Msg.alert(ANAS.t(opts.failTitle || 'Operation failed'), ANAS.enc(ANAS.errText(err)));
        } catch (e) {
            ANAS.warn(ANAS.errText(err));
        }
    }

    // Poll one job to its end (cr.45, docs/WAVE3-DESIGN.md §7.2).
    //
    // Cadence: every 0.5 s for the first 5 s, then every 2 s. A job still
    // running past maxMs (the attention window) fires onStillRunning once —
    // default: a toast pointing at the Dashboard's Recent activity — and the
    // poll slows to every 5 s while the view lives. onComplete fires ONLY on
    // `completed`; the old "still running at the end of the budget → treat as
    // done" was the F9 defect (a completion reload while md was still working,
    // and a later failure never alerted).
    //
    // Poll errors: a 404 means the daemon restarted and the job is gone —
    // terminal "lost". Anything else (network, 502/503/504 from the proxy)
    // retries after 1, 2, 4, 8, 10, 10 … s; the first success resumes normal
    // polling. 60 s without any successful poll is terminal "lost contact".
    // Both terminals alert, then call onLost(err) if given, else onFailed(null)
    // — every panel's onFailed reloads/re-enables what onSubmitted disabled,
    // which is the right recovery when the outcome is unknown (jobRejected
    // already calls onFailed(null) the same way).
    //
    // Both windows are WALL-CLOCK (cr.45 review): elapsed() runs from the
    // moment polling began and sinceOk() from the last SUCCESSFUL poll's
    // arrival — a request that takes a long time to answer counts as time the
    // job was being watched / contact was missing, not just the scheduled
    // delays. Date.now() drives them, so a fake clock in a harness can too.
    ANAS.pollJob = function (node, jobId, opts) {
        var maxMs = opts.maxMs || 15000;
        var view = opts.view;
        var beganAt = Date.now();   // wall clock when the poll loop started
        var lastOkAt = beganAt;     // wall clock of the last SUCCESSFUL poll
        var retryIdx = 0;
        var announced = false;
        var subject = opts.what || '';
        var RETRY_MS = [1000, 2000, 4000, 8000, 10000]; // then 10000 forever
        var LOST_CONTACT_MS = 60000;
        function dead() {
            return view && (view.destroyed || view.destroying);
        }
        // The "<what>" of the still-running / lost-contact sentences: the
        // caller's label, else a generic noun.
        function what() {
            return subject || ANAS.t('The job');
        }
        // Terminal "lost": alert, then onLost(err) or onFailed(null).
        function lost(err, title, body) {
            try {
                Ext.Msg.alert(title, body);
            } catch (e) {
                ANAS.warn(ANAS.errText(err));
            }
            if (opts.onLost) { opts.onLost(err); }
            else if (opts.onFailed) { opts.onFailed(null); }
        }
        // Wall time since polling began — drives the cadence and maxMs
        // still-running announcement (a request in flight is time on it).
        function elapsed() {
            return Date.now() - beganAt;
        }
        // Wall time since the last SUCCESSFUL poll — drives lost-contact
        // (before the first success, since the loop began).
        function sinceOk() {
            return Date.now() - lastOkAt;
        }
        function nextDelay() {
            if (announced) { return 5000; }
            return elapsed() >= 5000 ? 2000 : 500;
        }
        function schedule(ms) {
            setTimeout(function () {
                if (dead()) { return; }
                tick();
            }, ms);
        }
        function tick() {
            if (dead()) { return; }
            api.get(node, '/jobs/' + encodeURIComponent(jobId)).then(function (res) {
                if (dead()) { return; }
                lastOkAt = Date.now();
                retryIdx = 0;
                var job = res && res.job;
                var status = job && job.status;
                if (status === 'completed') {
                    if (opts.successMsg) { ANAS.toast(opts.successMsg); }
                    if (opts.onComplete) { opts.onComplete(job); }
                    return;
                }
                // rclone.5: a job an operator cancelled. Not a failure (no
                // modal) and not a completion (no success toast) — its own
                // callback when the caller has one, else one toast carrying
                // the daemon's "cancelled by <user> at <time>".
                if (status === 'cancelled') {
                    if (opts.onCancelled) {
                        opts.onCancelled(job);
                    } else {
                        var why = job && job.result && job.result.reason;
                        ANAS.toast(ANAS.t('Cancelled') + (why ? ': ' + why : ''));
                    }
                    return;
                }
                if (status === 'failed') {
                    var msg = (job && job.error && job.error.message) || ANAS.t('unknown error');
                    try {
                        // Encoded: the job's error is daemon text (review M5).
                        Ext.Msg.alert(ANAS.t(opts.failTitle || 'Operation failed'), ANAS.enc(msg));
                    } catch (e) {
                        ANAS.warn(msg);
                    }
                    if (opts.onFailed) { opts.onFailed(job); }
                    return;
                }
                if (!announced && elapsed() >= maxMs) {
                    announced = true;
                    if (opts.onStillRunning) {
                        opts.onStillRunning(job);
                    } else {
                        // ANAS.toast encodes its body; the subject rides inside it.
                        ANAS.toast(what() + ' '
                            + ANAS.t('is still running — the Dashboard\'s Recent activity shows when it ends'));
                    }
                }
                schedule(nextDelay());
            }, function (err) {
                if (dead()) { return; }
                if (err && err.status === 404) {
                    // Jobs live in the daemon's memory: a 404 means it
                    // restarted and this job's outcome is unknowable here.
                    lost(err, ANAS.t('Job lost'),
                        ANAS.t('The node no longer knows this job (the ANAS daemon restarted). Check the object before retrying.'));
                    return;
                }
                ANAS.warn('job poll failed: ' + ANAS.errText(err));
                if (sinceOk() >= LOST_CONTACT_MS) {
                    lost(err, ANAS.t('Lost contact'),
                        ANAS.t('Lost contact with the node while') + ' ' + ANAS.enc(what()) + ' '
                        + ANAS.t('was running; it may still be running. Refresh to see the result.'));
                    return;
                }
                schedule(RETRY_MS[Math.min(retryIdx++, RETRY_MS.length - 1)]);
            });
        }
        schedule(500);
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
        if (extra.pathSuffix) {
            // A path that already carries a query (a bound option, cr.44)
            // takes the suffix's parameters after `&`, never a second `?`.
            var suffix = extra.pathSuffix;
            if (suffix.charAt(0) === '?' && opts.path.indexOf('?') >= 0) { suffix = '&' + suffix.slice(1); }
            retry.path = opts.path + suffix;
        }
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

    // ---- Bound options (cr.44, docs/WAVE3-DESIGN.md §5.3) -------------------
    //
    // An option that changes WHAT a confirmed request destroys (pool destroy
    // `cleanup`, dataset destroy `recursive`, rollback `force`) is part of the
    // request the code confirms, not a flag added to the resend after the
    // challenge. An extraItems entry declares that with
    //   confirmBind: { query: 'cleanup' }   (or { body: 'key' })
    // and then:
    //   * the FIRST, unconfirmed request already carries the option at the
    //     item's default, explicitly (`?cleanup=false`);
    //   * changing it in the confirm window disables OK, re-sends the
    //     UNCONFIRMED request with the new value, and swaps the daemon's new
    //     warnings and code into the same window — so the operator reads the
    //     wipe warning before confirming, and the code always matches what is
    //     shown;
    //   * the confirmed resend is that request plus the code.
    // Safe only because these verbs' daemon confirm is unconditional: an
    // unconfirmed request never acts (pinned per route by
    // packages/daemon/src/routes/__tests__/confirm-bound-options.test.ts).
    // The key is `confirmBind`, not `bind`: `bind` is ExtJS's own ViewModel
    // binding config, and a component created with it would look for one.
    // `mapConfirm` stays for an option that is NOT bound (none of the shipped flows since cr.40).

    var CHECKBOX_XTYPES = { checkbox: true, checkboxfield: true };

    function boundItems(opts) {
        var out = [];
        var extra = opts.extraItems || [];
        for (var i = 0; i < extra.length; i++) {
            var b = extra[i] && extra[i].confirmBind;
            if (b && (b.query || b.body) && extra[i].itemId) { out.push(extra[i]); }
        }
        return out;
    }

    function boundDefault(item) {
        if (CHECKBOX_XTYPES[item.xtype]) { return !!item.checked; }
        return (item.value === undefined) ? null : item.value;
    }

    // { itemId: value } for every bound item: the values a re-prompt carried
    // over from the request it re-asks about, else the items' defaults.
    function boundValues(opts) {
        var given = opts.boundValues || {};
        var items = boundItems(opts);
        var vals = {};
        for (var i = 0; i < items.length; i++) {
            var id = items[i].itemId;
            vals[id] = given.hasOwnProperty(id) ? given[id] : boundDefault(items[i]);
        }
        return vals;
    }

    // The request the bound values describe: opts with the query flags on the
    // path and the body keys on the body. No bound items → an unchanged copy.
    function boundRequest(opts, vals) {
        var req = shallowCopy(opts);
        var items = boundItems(opts);
        var qs = [];
        var body = null;
        for (var i = 0; i < items.length; i++) {
            var b = items[i].confirmBind;
            var v = vals[items[i].itemId];
            if (b.query) {
                qs.push(encodeURIComponent(b.query) + '=' + encodeURIComponent(String(v)));
            } else {
                body = body || shallowCopy(opts.body || {});
                body[b.body] = v;
            }
        }
        if (qs.length) {
            req.path = opts.path + (opts.path.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
        }
        if (body) { req.body = body; }
        return req;
    }

    // The opts a re-prompt is built from: the caller's, carrying the bound
    // values of the request that was just sent (its fresh code was minted for
    // THOSE values, so the next window must open on them, not the defaults).
    function withBoundValues(opts, vals) {
        var o = shallowCopy(opts);
        o.boundValues = vals;
        return o;
    }

    // An unconfirmed (no X-Anas-Confirm) request, as runJob would send it.
    function sendUnconfirmed(req) {
        var method = (req.method || 'post').toLowerCase();
        if (method === 'put') { return api.put(req.node, req.path, req.body); }
        if (method === 'del' || method === 'delete') { return api.del(req.node, req.path); }
        return api.post(req.node, req.path, req.body);
    }

    function confirmBodyHtml(opts, err, depth) {
        return confirmIntroFor(opts, err, depth)
            + ANAS.warningsHtml((err.body && err.body.error && err.body.error.warnings) || []);
    }

    // Read the bound fields of THIS window (win.down, never a global query —
    // several confirm windows can be open).
    function readBound(win, opts) {
        var items = boundItems(opts);
        var vals = {};
        for (var i = 0; i < items.length; i++) {
            var cmp = win.down('#' + items[i].itemId);
            var v = cmp ? cmp.getValue() : boundDefault(items[i]);
            vals[items[i].itemId] = CHECKBOX_XTYPES[items[i].xtype] ? !!v : v;
        }
        return vals;
    }

    // The window's busy/error line under the warnings. text '' hides it.
    function confirmStatus(win, html) {
        var st = win.down('#anasConfirmStatus');
        if (!st) { return; }
        st.setHtml(html || '');
        st.setHidden(!html);
    }

    // A bound option changed: re-challenge with the unconfirmed request. Only
    // the newest re-challenge may write the window (a box ticked and
    // un-ticked again leaves the first answer stale); OK is live again only
    // when a 409 with a code has been swapped in.
    function rechallenge(win, opts, state, depth) {
        var seq = (win._confirmSeq = (win._confirmSeq || 0) + 1);
        var vals = readBound(win, opts);
        var ok = win.down('#anasConfirmOkBtn');
        function stale() {
            return win.destroyed || win.destroying || win._confirmSeq !== seq;
        }
        function failed(text) {
            // OK stays disabled: the window holds no code for what it shows.
            confirmStatus(win, '<div class="anas-confirm-error" style="color:var(--anas-danger,#c23b2c);">'
                + ANAS.enc(text) + '</div>');
        }
        if (ok) { ok.setDisabled(true); }
        confirmStatus(win, '<i>' + ANAS.enc(ANAS.t('Checking what this changes…')) + '</i>');
        sendUnconfirmed(boundRequest(opts, vals)).then(function () {
            if (stale()) { return; }
            failed(ANAS.t('The server did not ask to confirm this change, so it cannot be confirmed here. Close this window and check the task log.'));
        }, function (e) {
            if (stale()) { return; }
            if (e && e.status === 409 && e.confirmCode) {
                state.vals = vals;
                state.err = e;
                var bodyCmp = win.down('#anasConfirmBody');
                if (bodyCmp) { bodyCmp.setHtml(confirmBodyHtml(opts, e, depth)); }
                confirmStatus(win, '');
                if (ok) { ok.setDisabled(false); }
                return;
            }
            failed(ANAS.errText(e));
        });
    }

    // Widget-hosting confirm window: an Ext.window.Window (Ext.Msg.confirm cannot
    // host a checkbox) with the warnings + any extraItems, a normal (non-flat)
    // primary button, and Cancel as the default (Enter = the safe choice for a
    // destructive op). On confirm, mapConfirm(win) may return
    // { pathSuffix, bodyPatch } folded into the resend; bound items
    // (`confirmBind`, above) re-challenge in place instead.
    function confirmWindow(opts, err, depth) {
        // The request the window currently holds a code for.
        var state = { vals: boundValues(opts), err: err };
        var items = [{
            xtype: 'component',
            itemId: 'anasConfirmBody',
            html: confirmBodyHtml(opts, err, depth),
            margin: '0 0 8 0',
        }];
        var extra = opts.extraItems || [];
        var bound = boundItems(opts);
        for (var i = 0; i < extra.length; i++) {
            var it = extra[i];
            if (bound.indexOf(it) >= 0) {
                // A copy opened on the value the held code was minted for,
                // without the marker key.
                it = shallowCopy(it);
                delete it.confirmBind;
                if (CHECKBOX_XTYPES[it.xtype]) {
                    it.checked = !!state.vals[it.itemId];
                } else {
                    it.value = state.vals[it.itemId];
                }
            }
            items.push(it);
        }
        if (bound.length) {
            items.push({
                xtype: 'component',
                itemId: 'anasConfirmStatus',
                hidden: true,
                margin: '8 0 0 0',
                html: '',
            });
        }
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
                // `cancelButtonText` renames the safe choice where "Cancel"
                // would read as the verb itself (rclone.5: "Keep running"
                // beside "Cancel run").
                text: ANAS.t(opts.cancelButtonText || 'Cancel'),
                itemId: 'anasConfirmCancelBtn',
                handler: function () { win.close(); },
            }, {
                text: ANAS.t(opts.confirmButtonText || 'OK'),
                itemId: 'anasConfirmOkBtn',
                cls: opts.confirmButtonCls,
                handler: function (btn) {
                    if (btn && btn.disabled) { return; }
                    var extraOut = (typeof opts.mapConfirm === 'function')
                        ? (opts.mapConfirm(win) || {}) : {};
                    win.close();
                    ANAS.runJob(withReprompt(
                        buildRetry(boundRequest(opts, state.vals), state.err, extraOut),
                        withBoundValues(opts, state.vals), depth));
                },
            }],
        });
        for (var j = 0; j < bound.length; j++) {
            var cmp = win.down('#' + bound[j].itemId);
            if (cmp) {
                cmp.on('change', function () { rechallenge(win, opts, state, depth); });
            }
        }
        win.show();
    }

    // Dangerous-operation wrapper (Principle 14): run a mutation; on a 409 with a
    // confirm code, show the server's warnings and, if the user confirms, resend
    // with the code. `opts` is a runJob opts object; `confirmTitle`/`confirmIntro`
    // customise the dialog, and `confirmHeadline: true` leads it with the
    // 409's own `error.message` instead of an intro.
    //
    // Two presentations:
    //   * default — Ext.Msg.confirm (Yes/No) for a plain confirmation.
    //   * widget window — set confirmWindow:true to render an Ext.window.Window
    //     that can host extraItems:[checkboxCfg,…]; mapConfirm(win) → optional
    //     { pathSuffix, bodyPatch } folds the widget values into the resend. Also
    //     honours confirmCls / confirmButtonText / confirmButtonCls / confirmWidth
    //     / cancelButtonText.
    //
    // Bound options (`confirmBind` on an extraItems entry, cr.44) ride the
    // FIRST request at their defaults and re-challenge in the window; see
    // "Bound options" above.
    ANAS.confirmAndRun = function (opts) {
        var vals = boundValues(opts);
        var base = boundRequest(opts, vals);
        base.onConfirm = function (err) { promptConfirm(withBoundValues(opts, vals), err, 0); };
        ANAS.runJob(base);
    };

    // A confirmed resend can itself answer 409 with a FRESH code: the object
    // changed between the challenge and the resend (IDENTITY_MISMATCH — the
    // message names both ids, story ident.1), or the code was stale
    // (CONFIRMATION_REQUIRED again). That is a new question for the user, not a
    // failure: prompt again with the daemon's new message. Capped so a daemon
    // that keeps answering 409 can never loop the user. CONFIRM_SCOPE_CHANGED
    // (WAVE3-DESIGN §5.2 rule 3, cr.32): the resend's bound options differ
    // from the ones the code was minted for — the same kind of new question.
    // A daemon that never sends it leaves this entry inert.
    var MAX_REPROMPTS = 2;
    var REPROMPT_CODES = { CONFIRMATION_REQUIRED: true, IDENTITY_MISMATCH: true, CONFIRM_SCOPE_CHANGED: true };

    function repromptable(err) {
        var code = err && err.body && err.body.error && err.body.error.code;
        return !!(err && err.status === 409 && err.confirmCode && REPROMPT_CODES[code]);
    }

    // The resend's runJob opts: a fresh-code 409 re-prompts while under the
    // cap; anything else is the ordinary failure alert.
    function withReprompt(retry, opts, depth) {
        retry.onConfirm = function (err) {
            if (depth < MAX_REPROMPTS && repromptable(err)) {
                promptConfirm(opts, err, depth + 1);
                return;
            }
            jobRejected(retry, err);
        };
        return retry;
    }

    // The first prompt leads with the caller's intro; a re-prompt leads with
    // the daemon's own sentence (it says what changed), then the warnings.
    // `confirmHeadline: true` makes the FIRST prompt lead with the daemon's
    // sentence too — the 409's headline, verbatim, in bold — for a flow whose
    // every word the daemon owns (the recursive permissions apply).
    function confirmIntroFor(opts, err, depth) {
        var msg = err && err.body && err.body.error && err.body.error.message;
        if (depth > 0 && msg) { return ANAS.enc(msg); }
        if (opts.confirmHeadline && msg) { return '<b>' + ANAS.enc(msg) + '</b>'; }
        return opts.confirmIntro || ANAS.t('This operation requires confirmation:');
    }

    function promptConfirm(opts, err, depth) {
        try {
            if (opts.confirmWindow) {
                confirmWindow(opts, err, depth);
                return;
            }
            var warnings = (err.body && err.body.error && err.body.error.warnings) || [];
            var msg = confirmIntroFor(opts, err, depth) + ANAS.warningsHtml(warnings);
            Ext.Msg.confirm(ANAS.t(opts.confirmTitle || 'Confirm'), msg, function (btn) {
                if (btn === 'yes') {
                    ANAS.runJob(withReprompt(buildRetry(boundRequest(opts, boundValues(opts)), err), opts, depth));
                }
            });
        } catch (e) {
            ANAS.warn('confirm dialog failed: ' + ANAS.errText(e));
        }
    }

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

    // ---- Shared SMB self-service rule (smbsvc.1) ---------------------------
    //
    // The browser bundle cannot import @anas/shared, so the custom-`vfs objects`
    // rule the daemon refuses on (packages/daemon/src/parsers/smb-conf.ts,
    // `hasCustomVfsObjects` + `composeVfsObjects`) is duplicated here — the same
    // ONE-permitted-duplicate situation as `GUEST_NAME_RE` above. It is pure over
    // the SmbShare read-model (the module list plus the feature states derived
    // from the stanza), so the dialog's greyed row and the daemon's 400 can
    // never disagree about WHICH shares carry a hand-made line.

    ANAS.smb = {
        // The `vfs objects` module list the composer writes for a feature set —
        // the ground-truthed order on Samba 4.22, mirrored from the daemon.
        // `null` = no feature on → the line is removed, never left empty.
        composeVfsObjects: function (features) {
            var modules = [];
            if (features.timeMachine) { modules.push('catia', 'fruit', 'streams_xattr'); }
            if (features.previousVersions) { modules.push('shadow_copy2'); }
            if (features.recycle) { modules.push('recycle'); }
            return modules.length > 0 ? modules.join(' ') : null;
        },

        // Is this share's `vfs objects` line CUSTOM — i.e. not composed the way
        // ANAS writes it, so no self-service feature may be enabled on the
        // share? A share with no such line is never custom. A line that is
        // exactly the composer's output for the features that read as on is
        // ANAS's (enabling another feature onto it is fine).
        hasCustomVfsObjects: function (share) {
            share = share || {};
            var vfs = share.vfsObjects;
            if (!vfs || !vfs.length) { return false; }
            var composed = ANAS.smb.composeVfsObjects({
                previousVersions: share.previousVersions != null,
                recycle: share.recycle != null,
                timeMachine: share.timeMachine != null,
            });
            if (composed === null) { return true; }
            return vfs.join(' ') !== composed;
        },
    };
})();
