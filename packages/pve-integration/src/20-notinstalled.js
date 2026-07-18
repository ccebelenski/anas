/*
 * ANAS — "not installed on this node" probe + panel (the Ceph pattern).
 *
 * Before rendering, every view probes the gateway health endpoint. On failure
 * (connection refused / gateway down / node has no ANAS), we render a friendly
 * install-hint panel instead — we cannot auto-install like Ceph (we don't ship
 * through PVE's packaging), so the hint shows the npm install path.
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    // A panel config telling the user ANAS is not installed here, with the
    // install commands. Styled as a simple hint block, mirroring how PVE shows
    // its Ceph "not installed" mask.
    ANAS.notInstalledPanel = function (node) {
        var enc = ANAS.enc;
        var html = ''
            + '<div style="max-width:640px;margin:0 auto;">'
            + '<h2><i class="fa fa-database"></i> '
            + enc(ANAS.t('ANAS is not installed on this node')) + '</h2>'
            + '<p>' + enc(ANAS.t(
                'The ANAS gateway is not running on node "' + node + '", so its '
                + 'storage cannot be managed from here. ANAS is installed per node.',
            )) + '</p>'
            + '<p>' + enc(ANAS.t(
                'To manage this node, install the ANAS release on it — copy the '
                + 'release tarball to the node, then as root:',
            )) + '</p>'
            + '<pre style="padding:10px;border-radius:3px;background:rgba(128,128,128,0.12);'
            + 'white-space:pre-wrap;">'
            + enc('tar xzf anas-<version>.tar.gz') + '\n'
            + enc('cd anas-<version> && ./install.sh') + '</pre>'
            + '<p>' + enc(ANAS.t(
                'Once the anas and anasd services are running there, reload this '
                + 'page and the ANAS views become available for this node.',
            )) + '</p>'
            + '</div>';

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-notinstalled',
            bodyPadding: 20,
            border: false,
            scrollable: true,
            html: html,
        };
    };

    // ---- Version-skew warning (12.1) ---------------------------------------
    //
    // Three versions can drift: the browser-cached UI bundle (stamped into
    // anas.js by the installer as ANAS.BUILD_VERSION), the local gateway
    // (X-Anas-Version on every response, captured by 10-api), and the target
    // node's daemon (the health probe's own body). Any difference gets a
    // warning banner docked onto the view — warn, never fail: a partially
    // upgraded cluster should tell the user, not break.
    //
    // Returns a docked-toolbar config, or null when everything matches (or the
    // bundle is unstamped — dev trees — in which case the check stays off).
    ANAS.versionSkewBanner = function (node, daemonVersion) {
        var ui = ANAS.BUILD_VERSION;
        if (!ui) {
            return null;
        }
        var gw = ANAS.gatewayVersion;
        var gwSkew = !!(gw && gw !== ui);
        var daemonSkew = !!(daemonVersion && daemonVersion !== ui);
        if (!gwSkew && !daemonSkew && !(gw && daemonVersion && gw !== daemonVersion)) {
            return null;
        }

        var enc = ANAS.enc;
        var parts = ['UI ' + ui];
        if (gw) {
            parts.push('gateway ' + gw);
        }
        if (daemonVersion) {
            parts.push('node "' + node + '" ' + daemonVersion);
        }
        var hint = gwSkew
            // The gateway serving us is newer/older than our cached bundle —
            // a reload refetches anas.js; otherwise the mismatch is on-node.
            ? ANAS.t('Reload the browser (Ctrl-Shift-R) to refresh the ANAS UI, or upgrade the older install.')
            : ANAS.t('Upgrade ANAS on the older node.');
        return {
            xtype: 'toolbar',
            dock: 'top',
            cls: 'anas-version-skew',
            items: [{
                xtype: 'tbtext',
                html: '<i class="fa fa-exclamation-triangle warning"></i> '
                    + enc(ANAS.t('ANAS version mismatch') + ': ' + parts.join(', ') + '. ' + hint),
            }],
        };
    };

    // Return a panel config that probes health on render, then swaps in either
    // the real view (panelFactory()) or the not-installed panel. Every
    // registered view is wrapped in this so a missing install degrades
    // gracefully, exactly like Ceph.
    ANAS.withInstallCheck = function (node, panelFactory) {
        return {
            xtype: 'panel',
            cls: 'anas-installcheck',
            layout: 'fit',
            border: false,
            listeners: {
                afterrender: function (panel) {
                    try {
                        panel.setLoading(ANAS.t('Loading...'));
                    } catch (e) {
                        // non-fatal
                    }
                    ANAS.api.health(node).then(function (health) {
                        if (panel.destroyed || panel.destroying) {
                            return;
                        }
                        try {
                            panel.setLoading(false);
                        } catch (e) {
                            // non-fatal
                        }
                        // Version-skew banner (12.1) — advisory, fail-open.
                        try {
                            var skew = ANAS.versionSkewBanner(node, health && health.version);
                            if (skew) {
                                panel.addDocked(skew);
                            }
                        } catch (vs) {
                            ANAS.warn('version-skew check failed: ' + ANAS.errText(vs));
                        }
                        var child;
                        try {
                            child = panelFactory();
                        } catch (factoryErr) {
                            ANAS.warn('view factory failed: ' + ANAS.errText(factoryErr));
                            child = ANAS.errorPanel(ANAS.errText(factoryErr));
                        }
                        try {
                            panel.add(child);
                        } catch (addErr) {
                            ANAS.warn('view render failed: ' + ANAS.errText(addErr));
                        }
                    }, function () {
                        if (panel.destroyed || panel.destroying) {
                            return;
                        }
                        try {
                            panel.setLoading(false);
                            panel.add(ANAS.notInstalledPanel(node));
                        } catch (e) {
                            ANAS.warn('not-installed render failed: ' + ANAS.errText(e));
                        }
                    });
                },
            },
        };
    };
})();
