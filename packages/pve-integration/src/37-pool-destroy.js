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

        // Confirmed destroy: resend with the code and the chosen cleanup flag.
        function runDestroy(node, grid, poolName, confirmCode, cleanup) {
            var path = '/pools/' + encodeURIComponent(poolName);
            if (cleanup) {
                path += '?cleanup=true';
            }
            ANAS.runJob({
                node: node,
                method: 'del',
                path: path,
                confirmCode: confirmCode,
                view: grid,
                failTitle: 'Destroy failed',
                successMsg: ANAS.t('Destroyed') + ' ' + poolName,
                maxMs: 30000,
                onComplete: function () {
                    ANAS.pools.reload(grid, node);
                },
            });
        }

        // The confirmation dialog: server warnings + a "Clean Up Disks" checkbox
        // (mirrors PVE's destroy-pool cleanup option).
        function showConfirm(node, grid, poolName, confirmCode, warnings) {
            var items = [{
                xtype: 'component',
                html: '<b>' + Ext.String.htmlEncode(ANAS.t('Destroy pool') + ' "' + poolName + '"?')
                    + '</b><ul><li>'
                    + (warnings || []).map(function (w) { return Ext.String.htmlEncode(w); }).join('</li><li>')
                    + '</li></ul>',
                margin: '0 0 8 0',
            }, {
                xtype: 'checkbox',
                itemId: 'cleanup',
                cls: 'anas-chk-cleanup',
                boxLabel: ANAS.t('Clean up disks (wipe ZFS labels so they are reusable)'),
            }];
            var win = Ext.create('Ext.window.Window', {
                title: ANAS.t('Destroy pool'),
                cls: 'anas-win-destroy',
                modal: true,
                width: 460,
                bodyPadding: 12,
                layout: 'anchor',
                items: items,
                // Enter defaults to Cancel — the safe choice for a destructive op.
                defaultButton: 'destroyCancelBtn',
                buttons: [{
                    text: ANAS.t('Cancel'),
                    itemId: 'destroyCancelBtn',
                    handler: function () { win.close(); },
                }, {
                    text: ANAS.t('Destroy'),
                    cls: 'anas-btn-destroy-confirm',
                    handler: function () {
                        var cleanup = win.down('#cleanup').getValue();
                        win.close();
                        runDestroy(node, grid, poolName, confirmCode, cleanup);
                    },
                }],
            });
            win.show();
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
                // Step 1: fire the unconfirmed request to get the challenge
                // (409 + code + warnings), or a hard block (root pool).
                ANAS.api.del(node, '/pools/' + encodeURIComponent(poolName)).then(function () {
                    // Unexpected: destroy without confirmation should not succeed.
                    ANAS.pools.reload(grid, node);
                }, function (err) {
                    if (err && err.status === 409 && err.confirmCode) {
                        var warnings = (err.body && err.body.error && err.body.error.warnings) || [];
                        showConfirm(node, grid, poolName, err.confirmCode, warnings);
                        return;
                    }
                    // Root-pool block (PROTECTED_RESOURCE) or any other error.
                    try {
                        Ext.Msg.alert(ANAS.t('Destroy failed'), ANAS.errText(err));
                    } catch (e) {
                        ANAS.warn('destroy: ' + ANAS.errText(err));
                    }
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
