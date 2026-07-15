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
                'The ANAS storage management gateway is not reachable on '
                + 'node "' + node + '". Install it, then reload this page.',
            )) + '</p>'
            + '<pre style="padding:10px;border-radius:3px;background:rgba(128,128,128,0.12);'
            + 'white-space:pre-wrap;">'
            + enc('npm install -g anas') + '\n'
            + enc('sudo anas setup') + '</pre>'
            + '<p>' + enc(ANAS.t(
                'Once the anas and anasd services are running, the ANAS views '
                + 'become available here.',
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
                    ANAS.api.health(node).then(function () {
                        if (panel.destroyed || panel.destroying) {
                            return;
                        }
                        try {
                            panel.setLoading(false);
                        } catch (e) {
                            // non-fatal
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
