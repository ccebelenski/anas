/*
 * ANAS — Modify pool properties (story 3.9).
 *
 * Registers an "Edit" action on the Pools grid toolbar (via the pools action
 * registry in 30-pools.js — this file never edits the grid) that opens a small
 * property-edit window pre-loaded from GET /pools/:name, and on submit issues
 * PUT /pools/:name through the shared job helper (202 → poll → refresh).
 *
 * This file also establishes ANAS.editWindow — a reusable edit-window shape for
 * property-edit forms. Later property-edit work (datasets, shares, …) copies
 * this pattern rather than re-implementing window/form/submit plumbing.
 *
 * We use a plain Ext.window.Window + form panel rather than Proxmox.window.Edit:
 * Proxmox.window.Edit owns its own synchronous AJAX submit to a URL, which does
 * not compose with ANAS's asynchronous job API (202 + polling via ANAS.runJob).
 *
 * Data:
 *   GET  /pools/:name  → { data: PoolDetail }   (PoolDetail.properties)
 *   PUT  /pools/:name  → 202 { job }            ({ properties: { … } })
 *
 * Test hooks: action button cls 'anas-btn-modify', window cls 'anas-win-modify',
 * submit button cls 'anas-btn-modify-submit'.
 */
(function () {
    'use strict';

    // Fail-open: if the foundation (ANAS + pools registry) isn't present, do
    // nothing rather than throw and break the PVE UI.
    if (!window.ANAS || !window.ANAS.pools) {
        return;
    }

    var ANAS = window.ANAS;

    // ---- Reusable edit-window shape ---------------------------------------
    //
    // ANAS.editWindow(cfg) opens a modal window wrapping a form panel with
    // Cancel + Save buttons, and returns the window. cfg:
    //   title      — window title (run through ANAS.t)
    //   cls        — window cls (test hook / styling)
    //   width      — window width (default 460)
    //   items      — Ext form field configs
    //   submitText — Save button text (default 'Save')
    //   submitCls  — Save button cls (test hook / styling)
    //   load(basicForm, done) — async preload; call done() on success or
    //                           done(errMsg) to show a load error.
    //   submit(basicForm, win) — invoked when Save is clicked and the form is
    //                            valid; caller runs the mutation and closes win.
    // Defined once (guarded) so multiple property-edit files can share it.
    if (!ANAS.editWindow) {
        ANAS.editWindow = function (cfg) {
            var win = Ext.create('Ext.window.Window', {
                cls: cfg.cls,
                title: ANAS.t(cfg.title),
                modal: true,
                width: cfg.width || 460,
                resizable: false,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 150 },
                    items: cfg.items || [],
                }],
                buttons: [
                    {
                        text: ANAS.t('Cancel'),
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: ANAS.t(cfg.submitText || 'Save'),
                        cls: cfg.submitCls,
                        handler: function () {
                            if (win.destroyed || win.destroying) {
                                return;
                            }
                            var panel = win.down('#form');
                            var basicForm = panel && panel.getForm();
                            if (!basicForm) {
                                return;
                            }
                            if (basicForm.isValid && !basicForm.isValid()) {
                                return;
                            }
                            try {
                                cfg.submit(basicForm, win);
                            } catch (e) {
                                ANAS.warn('edit submit failed: ' + ANAS.errText(e));
                            }
                        },
                    },
                ],
            });

            win.show();

            if (cfg.load) {
                var panel = win.down('#form');
                try {
                    win.setLoading(true);
                } catch (e) {
                    // non-fatal
                }
                cfg.load(panel && panel.getForm(), function (errMsg) {
                    if (win.destroyed || win.destroying) {
                        return;
                    }
                    try {
                        win.setLoading(false);
                    } catch (e2) {
                        // non-fatal
                    }
                    if (errMsg) {
                        try {
                            Ext.Msg.alert(ANAS.t('Error'), errMsg);
                        } catch (e3) {
                            ANAS.warn(errMsg);
                        }
                        win.close();
                    }
                });
            }

            return win;
        };
    }

    // ---- Pool property edit -----------------------------------------------

    // Editable pool properties. ashift is creation-only and is shown read-only
    // for context (the daemon rejects any attempt to change it).
    function editableFields() {
        return [
            {
                xtype: 'displayfield',
                name: 'ashift',
                fieldLabel: ANAS.t('ashift'),
                fieldStyle: 'color:gray;',
            },
            {
                xtype: 'checkboxfield',
                name: 'autoexpand',
                fieldLabel: ANAS.t('Auto-expand'),
                boxLabel: ANAS.t('Expand pool when devices grow'),
            },
            {
                xtype: 'checkboxfield',
                name: 'autoreplace',
                fieldLabel: ANAS.t('Auto-replace'),
                boxLabel: ANAS.t('Replace a device automatically'),
            },
            {
                xtype: 'checkboxfield',
                name: 'autotrim',
                fieldLabel: ANAS.t('Auto-trim'),
                boxLabel: ANAS.t('Issue TRIM/UNMAP automatically'),
            },
            {
                xtype: 'combobox',
                name: 'failmode',
                fieldLabel: ANAS.t('Fail mode'),
                store: ['wait', 'continue', 'panic'],
                queryMode: 'local',
                editable: false,
                forceSelection: true,
            },
        ];
    }

    function bool(v) {
        return v ? 'on' : 'off';
    }

    function openEdit(node, grid, poolName) {
        if (!poolName) {
            return;
        }
        // Snapshot of the properties as loaded, for change detection on submit.
        var original = {};

        ANAS.editWindow({
            cls: 'anas-win-modify',
            title: ANAS.t('Edit Pool') + ': ' + poolName,
            submitText: 'Save',
            submitCls: 'anas-btn-modify-submit',
            width: 480,
            items: editableFields(),

            load: function (form, done) {
                if (!form) {
                    done(ANAS.t('Form unavailable'));
                    return;
                }
                ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName)).then(function (res) {
                    var p = (res && res.data && res.data.properties) || {};
                    original = {
                        autoexpand: !!p.autoexpand,
                        autoreplace: !!p.autoreplace,
                        autotrim: !!p.autotrim,
                        failmode: p.failmode || 'wait',
                    };
                    form.setValues({
                        ashift: (p.ashift === undefined || p.ashift === null) ? '—' : p.ashift,
                        autoexpand: original.autoexpand,
                        autoreplace: original.autoreplace,
                        autotrim: original.autotrim,
                        failmode: original.failmode,
                    });
                    done();
                }, function (err) {
                    done(ANAS.t('Failed to load pool properties') + ': ' + ANAS.errText(err));
                });
            },

            submit: function (form, win) {
                var current = {
                    autoexpand: !!form.findField('autoexpand').getValue(),
                    autoreplace: !!form.findField('autoreplace').getValue(),
                    autotrim: !!form.findField('autotrim').getValue(),
                    failmode: '' + form.findField('failmode').getValue(),
                };

                // Only send properties whose value actually changed.
                var changed = {};
                if (current.autoexpand !== original.autoexpand) {
                    changed.autoexpand = bool(current.autoexpand);
                }
                if (current.autoreplace !== original.autoreplace) {
                    changed.autoreplace = bool(current.autoreplace);
                }
                if (current.autotrim !== original.autotrim) {
                    changed.autotrim = bool(current.autotrim);
                }
                if (current.failmode !== ('' + original.failmode)) {
                    changed.failmode = current.failmode;
                }

                if (!Object.keys(changed).length) {
                    ANAS.toast(ANAS.t('No changes to save'));
                    win.close();
                    return;
                }

                ANAS.runJob({
                    node: node,
                    method: 'put',
                    path: '/pools/' + encodeURIComponent(poolName),
                    body: { properties: changed },
                    view: win,
                    failTitle: 'Update failed',
                    successMsg: ANAS.t('Pool properties updated') + ': ' + poolName,
                    onComplete: function () {
                        win.close();
                        ANAS.pools.reload(grid, node);
                    },
                });
            },
        });
    }

    // ---- Action registration ----------------------------------------------

    ANAS.pools.registerAction({
        itemId: 'modifyProps',
        text: 'Edit',
        cls: 'anas-btn-modify',
        iconCls: 'fa fa-cog',
        needsSelection: true,
        disableWhileScanning: false,
        handler: function (node, grid, poolName) {
            openEdit(node, grid, poolName);
        },
    });
})();
