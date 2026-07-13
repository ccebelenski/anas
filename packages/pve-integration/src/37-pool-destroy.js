/*
 * ANAS — Destroy pool action (story 3.14).
 *
 * Registers a "Destroy" toolbar action on the pools grid. Destroy is the most
 * dangerous pool operation: the daemon blocks the root/boot pool outright (409
 * PROTECTED_RESOURCE, no override) and confirmation-gates everything else (409
 * + X-Anas-Confirm-Code + warnings). ANAS.confirmAndRun surfaces the warnings
 * and resends with the code on confirm. Fail-open: if the action registry is
 * unavailable, the pools view still works without this button.
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    try {
        if (!ANAS.pools || typeof ANAS.pools.registerAction !== 'function') {
            throw new Error('ANAS pools action registry unavailable');
        }

        ANAS.pools.registerAction({
            itemId: 'destroyPool',
            text: 'Destroy',
            cls: 'anas-btn-destroy',
            iconCls: 'fa fa-trash',
            needsSelection: true,
            handler: function (node, grid, poolName) {
                if (!poolName) {
                    return;
                }
                ANAS.confirmAndRun({
                    node: node,
                    method: 'del',
                    path: '/pools/' + encodeURIComponent(poolName),
                    view: grid,
                    confirmTitle: 'Destroy pool',
                    confirmIntro: ANAS.t('Permanently destroy pool')
                        + ' "' + poolName + '"? '
                        + ANAS.t('This erases all data in the pool and cannot be undone.'),
                    successMsg: ANAS.t('Destroyed') + ' ' + poolName,
                    failTitle: 'Destroy failed',
                    onComplete: function () {
                        ANAS.pools.reload(grid, node);
                    },
                });
            },
        });
    } catch (e) {
        try {
            if (ANAS && typeof ANAS.warn === 'function') {
                ANAS.warn('destroy action disabled: ' + ANAS.errText(e));
            } else if (typeof console !== 'undefined' && console.warn) {
                console.warn('[ANAS] destroy action disabled: ' + (e && e.message));
            }
        } catch (e2) {
            // stay silent rather than break the page
        }
    }
})();
