/*
 * ANAS — gateway API helper (ANAS.api).
 *
 * The browser only ever talks to the ANAS gateway on the host serving the PVE
 * UI (same host as :8006 — cookies ignore ports, so PVEAuthCookie flows on its
 * own with credentials: 'include'). The <node> path segment lets the gateway
 * route/forward per-node server-side; the browser never contacts another node.
 *
 *   https://<window.location.hostname>:3000/api/nodes/<node>/v1<path>
 *
 * All calls return a Promise. Non-2xx rejects with an Error carrying `.status`
 * and `.body` (the parsed ApiError body when available). 202 is 2xx, so it
 * resolves with the parsed body ({ job }).
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});
    var GATEWAY_PORT = 3000;

    function gatewayOrigin() {
        var host = (typeof window !== 'undefined' && window.location && window.location.hostname)
            ? window.location.hostname
            : 'localhost';
        return 'https://' + host + ':' + GATEWAY_PORT;
    }

    function nodeBase(node) {
        return gatewayOrigin() + '/api/nodes/' + encodeURIComponent(node) + '/v1';
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
    // ANAS the gateway can't reach its :3000 peer and returns 502, so this
    // rejects and the caller shows the clean "not installed on this node" panel.
    // The old form probed the LOCAL gateway's /api/health, which always passed
    // when connected through an ANAS node — so ANAS views on ANAS-less peer nodes
    // rendered and then errored with raw "node unreachable" messages.
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

    // Dangerous-operation wrapper (Principle 14): run a mutation; on a 409 with a
    // confirm code, show the server's warnings and, if the user confirms, resend
    // with the code. `opts` is a runJob opts object; `confirmTitle`/`confirmIntro`
    // customise the dialog.
    ANAS.confirmAndRun = function (opts) {
        var base = {};
        var k;
        for (k in opts) { if (opts.hasOwnProperty(k)) { base[k] = opts[k]; } }
        base.onConfirm = function (err) {
            var warnings = (err.body && err.body.error && err.body.error.warnings) || [];
            var intro = opts.confirmIntro || ANAS.t('This operation requires confirmation:');
            var msg = intro;
            if (warnings.length) {
                msg += '<ul><li>' + warnings.map(function (w) {
                    return Ext.String.htmlEncode(w);
                }).join('</li><li>') + '</li></ul>';
            }
            try {
                Ext.Msg.confirm(ANAS.t(opts.confirmTitle || 'Confirm'), msg, function (btn) {
                    if (btn === 'yes') {
                        var retry = {};
                        var j;
                        for (j in opts) { if (opts.hasOwnProperty(j)) { retry[j] = opts[j]; } }
                        retry.confirmCode = err.confirmCode;
                        ANAS.runJob(retry);
                    }
                });
            } catch (e) {
                ANAS.warn('confirm dialog failed: ' + ANAS.errText(e));
            }
        };
        ANAS.runJob(base);
    };
})();
