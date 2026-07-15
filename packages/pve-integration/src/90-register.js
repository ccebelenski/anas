/*
 * ANAS — menu registration (loads last).
 *
 * Wires the registered views (ANAS.views) into the PVE node menu in a fixed
 * order via the core prototype-patch injection. Missing keys are skipped so a
 * partial set of view files still produces a working menu. Fail-open: any
 * failure here leaves the PVE UI untouched (one console.warn).
 */
(function () {
    'use strict';

    var ANAS = window.ANAS;

    // Fixed presentation order for the ANAS group. Views not present in
    // ANAS.views are skipped by injectMenu.
    var ORDER = ['dashboard', 'pools', 'datasets', 'shares', 'users', 'disks'];

    try {
        if (!ANAS || typeof ANAS.installMenu !== 'function') {
            throw new Error('ANAS core unavailable');
        }
        ANAS.installMenu(ORDER);
    } catch (e) {
        try {
            if (ANAS && typeof ANAS.warn === 'function') {
                ANAS.warn('menu registration disabled: ' + ANAS.errText(e));
            } else if (typeof console !== 'undefined' && console.warn) {
                console.warn('[ANAS] menu registration disabled: ' + (e && e.message));
            }
        } catch (e2) {
            // stay silent rather than break the page
        }
    }
})();
