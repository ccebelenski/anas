/*
 * ANAS — Create Pool action (story 3.8 → Epic 15.2 / story 3.23).
 *
 * Registers the "Create" toolbar action into the Pools view's action registry
 * (30-pools.js): launches the pool composer (38-pool-composer.js), which
 * holds a client-side draft and commits ONE POST /pools (CreatePoolRequest)
 * on success, refreshing the Pools grid. The button carries both
 * .anas-btn-create and .anas-btn-composer-open so both test hooks resolve.
 *
 * ES5, no build step. Fail open: guarded so a standalone load never throws, and
 * a broken handler warns instead of breaking PVE.
 */
(function () {
    'use strict';

    // Guard: only wire up when the Pools action registry is present.
    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.pools) {
        return;
    }

    var ANAS = window.ANAS;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    // Open the composer (defined in 38-pool-composer.js, which concatenates after
    // this file — resolved lazily at click time, never at load).
    function launchComposer(node, grid) {
        if (ANAS.composer && typeof ANAS.composer.open === 'function') {
            ANAS.composer.open({ node: node, grid: grid, mode: 'create' });
            return;
        }
        // Fail open: the composer module is the only create path; if it is
        // absent, warn instead of breaking the toolbar.
        try {
            Ext.Msg.alert(t('Create Pool'), t('The Pool Composer is unavailable.'));
        } catch (e) {
            ANAS.warn('composer unavailable');
        }
    }

    ANAS.pools.registerAction({
        itemId: 'createPool',
        text: 'Create',
        cls: 'anas-btn-create anas-btn-composer-open',
        iconCls: 'fa fa-plus',
        needsSelection: false,
        handler: function (node, grid) {
            launchComposer(node, grid);
        },
    });
})();
