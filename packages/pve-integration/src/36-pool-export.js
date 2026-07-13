/*
 * ANAS — Export pool action (story 3.13).
 *
 * Registers an "Export" toolbar action on the pools grid. Export is a
 * confirmation-gated operation (Principle 14): the daemon answers the first
 * request with 409 + X-Anas-Confirm-Code and its warnings; ANAS.confirmAndRun
 * shows them and, on confirm, resends with the code. Fail-open: if the action
 * registry is unavailable, the pools view still works without this button.
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    try {
        if (!ANAS.pools || typeof ANAS.pools.registerAction !== 'function') {
            throw new Error('ANAS pools action registry unavailable');
        }

        ANAS.pools.registerAction({
            itemId: 'exportPool',
            text: 'Export',
            cls: 'anas-btn-export',
            iconCls: 'fa fa-sign-out',
            needsSelection: true,
            handler: function (node, grid, poolName) {
                if (!poolName) {
                    return;
                }
                ANAS.confirmAndRun({
                    node: node,
                    method: 'post',
                    path: '/pools/' + encodeURIComponent(poolName) + '/export',
                    body: {},
                    view: grid,
                    confirmTitle: 'Export pool',
                    confirmIntro: ANAS.t('Export') + ' ' + poolName + '?',
                    successMsg: ANAS.t('Exported') + ' ' + poolName,
                    failTitle: 'Export failed',
                    onComplete: function () {
                        ANAS.pools.reload(grid, node);
                    },
                });
            },
        });
    } catch (e) {
        try {
            if (ANAS && typeof ANAS.warn === 'function') {
                ANAS.warn('export action disabled: ' + ANAS.errText(e));
            } else if (typeof console !== 'undefined' && console.warn) {
                console.warn('[ANAS] export action disabled: ' + (e && e.message));
            }
        } catch (e2) {
            // stay silent rather than break the page
        }
    }
})();
