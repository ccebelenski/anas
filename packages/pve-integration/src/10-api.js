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
    // Error carrying .status and .body.
    function doFetch(method, url, body) {
        return new Promise(function (resolve, reject) {
            if (typeof fetch !== 'function') {
                var noFetch = new Error('fetch API unavailable');
                noFetch.status = 0;
                reject(noFetch);
                return;
            }

            var opts = {
                method: method,
                credentials: 'include',
                headers: { Accept: 'application/json' },
            };
            if (body !== undefined && body !== null) {
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(body);
            }

            fetch(url, opts).then(function (res) {
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
    api.request = function (method, node, path, body) {
        return doFetch(method, nodeBase(node) + path, body);
    };

    api.get = function (node, path) {
        return api.request('GET', node, path);
    };
    api.post = function (node, path, body) {
        return api.request('POST', node, path, body);
    };
    api.put = function (node, path, body) {
        return api.request('PUT', node, path, body);
    };
    api.del = function (node, path) {
        return api.request('DELETE', node, path);
    };

    // Health probe. NOTE: the health endpoint is gateway-level, not under
    // /nodes — https://<host>:3000/api/health. The `node` argument is accepted
    // for a future per-node route; today it always probes the local gateway.
    api.health = function (node) {
        void node;
        return doFetch('GET', gatewayOrigin() + '/api/health');
    };

    ANAS.api = api;
})();
