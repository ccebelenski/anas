/*
 * ANAS — Dashboard view (story 13.12).
 *
 * Minimal landing panel for the ANAS section: gateway node name, pool count
 * with per-pool state tags, and running jobs. Placeholder until Epic 2 fills in
 * the full dashboard. Registered into the framework by assignment; the factory
 * runs at view-show time when Ext is fully available.
 *
 * FRAMEWORK CONTRACT: window.ANAS with ANAS.api.get (Promise-returning, path
 * relative to /v1, rejections carry .status/.body). The framework wraps this
 * view in the "not installed" probe — we do NOT probe health here. Fail open:
 * per-section errors render inline and never break the PVE UI.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    var COLOR_OK = '#21BF4B';
    var COLOR_BAD = '#FF0000';
    var COLOR_WARN = '#E6A100';
    var COLOR_MUTED = '#888888';

    function t(str) {
        return (typeof gettext === 'function') ? gettext(str) : str;
    }

    function enc(str) {
        return ANAS.enc(str);
    }

    function errText(e) {
        if (!e) {
            return t('Unknown error');
        }
        if (e.body && e.body.error && e.body.error.message) {
            return e.body.error.message;
        }
        return e.message ? e.message : ('' + e);
    }

    // Color for a ZFS pool state (ONLINE good; DEGRADED/OFFLINE/REMOVED warn;
    // FAULTED/UNAVAIL/SUSPENDED bad).
    function stateColor(state) {
        switch (state) {
            case 'ONLINE':
                return COLOR_OK;
            case 'DEGRADED':
            case 'OFFLINE':
            case 'REMOVED':
                return COLOR_WARN;
            default:
                return COLOR_BAD;
        }
    }

    // A small colored pill/tag for a pool state.
    function stateTag(state) {
        return '<span style="display:inline-block;padding:1px 6px;border-radius:3px;'
            + 'font-size:11px;color:#fff;background:' + stateColor(state) + ';">'
            + enc(state) + '</span>';
    }

    // --- Section renderers ----------------------------------------------

    function poolsHtml(pools) {
        if (!pools || !pools.length) {
            return '<div style="color:' + COLOR_MUTED + ';">' + t('No pools') + '</div>';
        }
        var html = '<div style="margin-bottom:4px;"><b>'
            + enc(t('Pools') + ': ' + pools.length) + '</b></div>';
        html += '<ul style="margin:0;padding-left:18px;">';
        for (var i = 0; i < pools.length; i++) {
            var p = pools[i];
            html += '<li style="margin:2px 0;">' + enc(p.name) + ' &nbsp;'
                + stateTag(p.state) + '</li>';
        }
        html += '</ul>';
        return html;
    }

    function jobsHtml(jobs) {
        if (!jobs || !jobs.length) {
            return '<div style="color:' + COLOR_MUTED + ';">'
                + t('No active jobs') + '</div>';
        }
        var html = '<div style="margin-bottom:4px;"><b>'
            + enc(t('Active jobs') + ': ' + jobs.length) + '</b></div>';
        html += '<ul style="margin:0;padding-left:18px;">';
        for (var i = 0; i < jobs.length; i++) {
            var j = jobs[i];
            var label = j.operation || j.id;
            if (j.progress) {
                label += ' (' + j.progress + ')';
            }
            html += '<li style="margin:2px 0;">' + enc(label) + '</li>';
        }
        html += '</ul>';
        return html;
    }

    function errHtml(prefix, err) {
        var status = (err && err.status) ? (' (HTTP ' + err.status + ')') : '';
        return '<div style="color:' + COLOR_BAD + ';">'
            + enc(prefix + errText(err) + status) + '</div>';
    }

    function setSection(view, itemId, html) {
        if (view.isDestroyed) {
            return;
        }
        var cmp = view.down('#' + itemId);
        if (cmp) {
            cmp.setHtml(html);
        }
    }

    function loadDashboard(view, node) {
        // Pools section.
        ANAS.api.get(node, '/pools').then(
            function (res) {
                setSection(view, 'anasDashPools',
                    poolsHtml((res && res.data) ? res.data : []));
            },
            function (err) {
                setSection(view, 'anasDashPools',
                    errHtml(t('Failed to load pools') + ': ', err));
            },
        );

        // Active jobs section (running only).
        ANAS.api.get(node, '/jobs?status=running').then(
            function (res) {
                setSection(view, 'anasDashJobs',
                    jobsHtml((res && res.data) ? res.data : []));
            },
            function (err) {
                setSection(view, 'anasDashJobs',
                    errHtml(t('Failed to load jobs') + ': ', err));
            },
        );
    }

    ANAS.views['dashboard'] = {
        itemId: 'anas-dashboard',
        text: 'Dashboard',
        iconCls: 'fa fa-tachometer',
        factory: function (node) {
            return {
                xtype: 'panel',
                cls: 'anas-view anas-view-dashboard',
                scrollable: true,
                bodyPadding: 16,
                border: false,
                defaults: {
                    xtype: 'component',
                    style: { 'margin-bottom': '16px' },
                },
                items: [
                    {
                        html: '<h2 style="margin:0 0 4px 0;">' + enc(t('ANAS Dashboard'))
                            + '</h2><div style="color:' + COLOR_MUTED + ';">'
                            + enc(t('Gateway node') + ': ' + node) + '</div>',
                    },
                    {
                        itemId: 'anasDashPools',
                        html: '<div style="color:' + COLOR_MUTED + ';">'
                            + t('Loading pools...') + '</div>',
                    },
                    {
                        itemId: 'anasDashJobs',
                        html: '<div style="color:' + COLOR_MUTED + ';">'
                            + t('Loading jobs...') + '</div>',
                    },
                ],
                listeners: {
                    afterrender: function (view) {
                        loadDashboard(view, node);
                    },
                },
            };
        },
    };
})();
