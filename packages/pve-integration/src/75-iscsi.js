/*
 * ANAS — iSCSI view (story iscsi.4: the iSCSI menu and every mutation).
 *
 * A native ExtJS grid over the node's iSCSI targets plus a toolbar (Create,
 * Edit, Enable/Disable, Delete, LUNs…, Repair) and a LUNs detail window that is
 * DISPLAY plus its own LUN toolbar (Add LUN, Resize, Delete). One menu per
 * feature; no row-icon action columns.
 *
 * `Repair` (story iscsi.5) is the node-level door out of a boot-restore hole.
 *
 * ANAS is the TARGET side only. PVE and guests are ordinary initiators; nothing
 * here writes storage.cfg or offers a pvesm snippet.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN HAS TO SAY OUT LOUD, because LIO will not
 *
 *  - **A portal on a non-existent address looks healthy.** LIO binds it, reports
 *    it OK, keeps it across a service restart and never logs a word. The daemon
 *    diffs the configured addresses against the node's own; the grid shows the
 *    result and the Create/Edit dialog offers only addresses this node carries.
 *  - **`Disable` does not close the door.** It refuses NEW logins and hides the
 *    target from discovery, but the portal socket stays open and an established
 *    session keeps running. The button says so.
 *  - **Removing an initiator ACL drops its session instantly** and destroys its
 *    CHAP credentials. That is a confirm-gated change, not a metadata edit.
 *  - **An image-file LUN cannot be resized in place.** Its size is fixed at
 *    creation, so a grow deletes and recreates the backstore, replaying the SAME
 *    unit serial and the SAME attributes and re-mapping at the same index. The
 *    Resize dialog states this rather than hiding it.
 *  - **PVE's `iscsi:` storage plugin has no CHAP field.** A CHAP-protected target
 *    cannot be consumed by a PVE storage without hand-editing
 *    /etc/iscsi/iscsid.conf on every PVE node. The auth section says so the
 *    moment auth is not "none".
 *  - **Thin reclaim on an image file depends on the initiator.** ANAS sets the
 *    correct target-side attributes; Linux's default discard path is rejected by
 *    LIO for fileio. The Add LUN summary says it plainly instead of promising
 *    "thin".
 *  - **A boot restore with a missing backing device reports SUCCESS.** systemd
 *    logs `Result=success` while the LUN silently vanishes; with a whole pool
 *    late the target comes up enabled with zero LUNs and an initiator logs in
 *    happily and sees nothing. `Repair` is fed by the saveconfig ⟷ configfs diff
 *    and is live only when a hole's backing object is BACK — the tooltip names
 *    what is still missing otherwise. The replay carries the stored serial and
 *    attributes, so a repaired LUN is the same disk.
 *  - **"Not on this node right now" is not "somebody else's".** A LUN whose pool
 *    is exported reads `Unresolved`, not `Foreign`, and its target stays ANAS's —
 *    otherwise the hands-off badge would take away the very tools that fix it.
 *  - **A backup image that is not EXACTLY the size of the LUN is destructive.**
 *    Nothing below ANAS checks it: a larger image writes until the device is
 *    full and leaves the LUN half-overwritten, a smaller one succeeds and leaves
 *    stale bytes past its end. `Restore from backup…` shows both numbers and
 *    keeps the button dead until they are equal (story backup2.7).
 *  - **A restore takes the WHOLE TARGET offline, not one LUN.** LIO's enable
 *    flag lives on the target portal group, so every other LUN on that target is
 *    unreachable for the duration too. The confirm text says so — and if the
 *    restore fails part-way the target stays disabled, because serving half an
 *    image is worse than serving nothing.
 *
 * ---------------------------------------------------------------------------
 * DAEMON CONTRACT (docs/DESIGN.md "iSCSI — block storage")
 *
 *   GET  /v1/iscsi/targets  → { data: { installed, configfsPresent,
 *        saveconfigPresent, reason?, targets: [ { iqn, name, ownership,
 *        ownershipReason, ownershipDetail, tpgTag, enabled, portals[], lunCount,
 *        aclCount, sessionCount, security{authentication, generateNodeAcls,
 *        demoModeDiscovery}, present, persisted, missingLunCount,
 *        portalsWithoutInterfaceCount } ] } }
 *   GET  /v1/iscsi/targets/:iqn → the same plus luns[], acls[], sessions[]
 *   POST /v1/iscsi/targets           { name, portals[], auth, acls[] } → 202
 *   PUT  /v1/iscsi/targets/:iqn      { portals?, acls?, auth? }        → 202
 *   POST /v1/iscsi/targets/:iqn/state { action:'enable'|'disable' }    → 202
 *   DELETE /v1/iscsi/targets/:iqn                                      → 202/409
 *   POST /v1/iscsi/targets/:iqn/luns { name, kind, backing, size?, blockSize? }
 *   PUT  /v1/iscsi/targets/:iqn/luns/:n { size?, writeBack? }          → 202/409
 *   DELETE /v1/iscsi/targets/:iqn/luns/:n[?destroyBacking=true]        → 202/409
 *   GET  /v1/iscsi/health   → { …envelope, missingLuns[], targetsServingNothing[],
 *        portalsWithoutInterface[], foreignChanges[], degraded, interfacesUnknown }
 *   POST /v1/iscsi/health/repair                                       → 202/409
 *
 *   backup2.7 — the whole-image restore lives on the LUN toolbar, because the
 *   LUN is the thing being restored:
 *   GET  /v1/backup/repos                → the two repository tiers
 *   GET  /v1/backup/repos/:name/groups?ns= → { groups: [ { group, snapshots: [
 *        { snapshot, backupTime, files: [ { filename, size } ] } ] } ] }
 *   POST /v1/backup/restore { kind:'image', repo, ns?, snapshot, archive,
 *        lun:{targetIqn, index} }                                     → 202/409
 *   The `snapshot` is ALWAYS the full `<type>/<id>/<RFC3339>`: a bare group path
 *   is not an error to the backup client, it silently restores the latest.
 *
 *   THE CLEAR CONTRACT: on an ACL, every credential field means set / clear /
 *   keep by value / null / OMITTED. A blank password box sends NO key, so the
 *   stored secret stands (the mounts precedent). An untouched target edit sends
 *   an empty body and rewrites nothing.
 *
 *   Secrets are WRITE-ONLY. A response never carries one; the dialog shows
 *   "credentials set" state and an empty box.
 * ---------------------------------------------------------------------------
 *
 * Test hooks: view 'anas-view anas-view-iscsi'; grid 'anas-grid-iscsi'; toolbar
 * 'anas-btn-iscsi-refresh' / '-create' / '-edit' / '-toggle' / '-delete' /
 * '-luns' / '-repair'; target dialog 'anas-win-iscsi-target' with submit
 * 'anas-btn-iscsi-target-submit'; LUNs window 'anas-win-iscsi-luns' with
 * 'anas-btn-lun-add' / 'anas-btn-lun-resize' / 'anas-btn-lun-restore' /
 * 'anas-btn-lun-delete'; Add LUN dialog 'anas-win-iscsi-lun' with
 * 'anas-btn-iscsi-lun-submit'; Resize dialog 'anas-win-iscsi-lun-resize' with
 * 'anas-btn-iscsi-lun-resize-submit'; Restore dialog 'anas-win-lun-restore' with
 * 'anas-fld-restore-repo' / '-ns' / '-group' / '-snapshot' / '-archive',
 * 'anas-btn-restore-load' and 'anas-btn-lun-restore-submit'.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 * Fail-open everywhere: a broken view renders an error panel, never breaks PVE.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    // Sessions are the one live thing on this screen, and they only matter while
    // the LUNs window is open — so the poll is scoped to that window and gated on
    // visibility, never a background timer on the grid.
    var SESSION_POLL_MS = 5000;

    var SIZE_UNITS = [
        { value: 1048576, label: 'MiB' },
        { value: 1073741824, label: 'GiB' },
        { value: 1099511627776, label: 'TiB' }
    ];

    // The block sizes LIO accepts. The blank row means "send nothing" and LIO
    // applies its own 512 — and the choice is CREATE-ONLY: once the LUN is
    // mapped, `set attribute block_size=` is refused by the kernel.
    var BLOCK_SIZES = [
        { value: '', label: '512 bytes (LIO default)' },
        { value: 512, label: '512 bytes' },
        { value: 1024, label: '1 KiB' },
        { value: 2048, label: '2 KiB' },
        { value: 4096, label: '4 KiB' }
    ];

    var CHAP_MIN = 12;
    var CHAP_MAX = 16;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function fmtBytes(v) {
        try {
            return ANAS.formatBytes(v);
        } catch (e) {
            return '' + v;
        }
    }

    // A target is keyed by its IQN, URL-encoded into a single path segment.
    function encIqn(iqn) {
        return encodeURIComponent('' + (iqn == null ? '' : iqn));
    }

    function valOf(win, sel) {
        try {
            var f = win.down(sel);
            return f ? f.getValue() : undefined;
        } catch (e) {
            return undefined;
        }
    }

    function textOf(win, sel) {
        var v = valOf(win, sel);
        return ('' + (v === undefined || v === null ? '' : v)).trim();
    }

    // UTF-8 byte length — the CHAP range the daemon enforces is in BYTES, and a
    // 16-character non-ASCII secret is longer than an initiator's 16-byte field.
    function byteLength(s) {
        try {
            return unescape(encodeURIComponent('' + s)).length;
        } catch (e) {
            return ('' + s).length;
        }
    }

    function isArray(v) {
        try {
            return Object.prototype.toString.call(v) === '[object Array]';
        } catch (e) {
            return false;
        }
    }

    function getf(rec, key) {
        try {
            if (rec && typeof rec.get === 'function') {
                return rec.get(key);
            }
            return rec ? rec[key] : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // ---- Renderers ---------------------------------------------------------

    function pill(cls, label, color, title) {
        return '<span class="' + enc(cls) + '" title="' + enc(title || '') + '"'
            + ' style="display:inline-block;padding:1px 9px;border-radius:9px;font-size:0.85em;'
            + 'color:' + color + ';background:color-mix(in srgb,' + color + ' 15%,transparent);">'
            + enc(label) + '</span>';
    }

    // The IQN is an identifier: never truncated, never decorated.
    function renderIqn(v) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        return '<span title="' + enc(s) + '" style="font-family:monospace;font-size:0.9em;">'
            + enc(s) + '</span>';
    }

    function renderName(v, meta, rec) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            // A foreign target has no ANAS name — say so rather than inventing one.
            return '<span style="color:gray;" title="'
                + enc(t('This target was not created by ANAS, so it has no ANAS name')) + '">&mdash;</span>';
        }
        return enc(s);
    }

    // Portals: address:port each, plus the honest "no interface carries this"
    // marker — the one thing LIO will never tell anyone.
    function renderPortals(v, meta, rec) {
        var list = isArray(v) ? v : [];
        if (!list.length) {
            return pill('anas-iscsi-portal-none', t('none'), 'var(--anas-warn,#b06a12)',
                t('A target with no portal listens nowhere'));
        }
        var parts = [];
        for (var i = 0; i < list.length; i++) {
            var p = list[i] || {};
            var addr = (p.family === 'inet6' ? '[' + p.address + ']' : p.address) + ':' + p.port;
            if (p.carriedByInterface === false) {
                parts.push('<span class="anas-iscsi-portal-orphan" title="'
                    + enc(t('No interface on this node carries this address. LIO binds it anyway, '
                        + 'reports it healthy, and will never tell you otherwise.'))
                    + '" style="color:var(--anas-warn,#b06a12);">'
                    + enc(addr) + ' <i class="fa fa-exclamation-triangle"></i></span>');
            } else {
                parts.push('<span class="anas-iscsi-portal">' + enc(addr) + '</span>');
            }
        }
        return parts.join(', ');
    }

    // A number with labeled context, never a bare digit in a column.
    function renderLunCount(v, meta, rec) {
        var n = Number(v) || 0;
        var missing = Number(getf(rec, 'missingLunCount')) || 0;
        var text = n + ' ' + (n === 1 ? t('LUN') : t('LUNs'));
        if (!missing) {
            return '<span class="anas-iscsi-luncount">' + enc(text) + '</span>';
        }
        return '<span class="anas-iscsi-luncount anas-iscsi-luncount-hole" style="color:var(--anas-danger,#c23b2c);" title="'
            + enc(t('The saved configuration has ' + missing + ' LUN(s) the kernel does not — a boot restore '
                + 'whose backing device was missing reports success and silently drops the LUN. '
                + 'Until that is healed, ANAS refuses every mutation on this node.'))
            + '">' + enc(text) + ' <i class="fa fa-exclamation-circle"></i> '
            + enc(missing + ' ' + t('missing')) + '</span>';
    }

    function renderSessions(v) {
        var n = Number(v) || 0;
        if (!n) {
            return '<span style="color:gray;" title="' + enc(t('No initiator is logged in')) + '">'
                + enc('0 ' + t('sessions')) + '</span>';
        }
        return pill('anas-iscsi-sessions', n + ' ' + (n === 1 ? t('session') : t('sessions')),
            'var(--anas-accent,#3468c0)', t('Initiators logged in right now'));
    }

    function renderEnabled(v, meta, rec) {
        if (v === true) {
            return pill('anas-iscsi-state anas-iscsi-state-enabled', t('Enabled'), 'var(--anas-ok,#1f9c56)',
                t('Accepting logins'));
        }
        return pill('anas-iscsi-state anas-iscsi-state-disabled', t('Disabled'), 'var(--anas-muted,gray)',
            t('Refusing new logins and hidden from discovery. The portal socket stays open and '
                + 'an established session keeps running.'));
    }

    function renderAuth(v, meta, rec) {
        var sec = getf(rec, 'security') || {};
        if (sec.authentication) {
            return pill('anas-iscsi-auth anas-iscsi-auth-chap', t('CHAP'), 'var(--anas-ok,#1f9c56)',
                t('CHAP is enforced; credentials live on each initiator ACL'));
        }
        return pill('anas-iscsi-auth anas-iscsi-auth-acl', t('ACL only'), 'var(--anas-muted,gray)',
            t('No CHAP. Only the listed initiator IQNs may log in — an IQN is asserted by the '
                + 'client, so this is a boundary, not proof of identity.'));
    }

    // The hands-off badge, the same idiom PVE-managed pools and mounts wear.
    function renderOwnership(v, meta, rec) {
        if (v === 'anas') {
            return '<span class="anas-iscsi-owner anas-iscsi-owner-anas">'
                + pill('anas-iscsi-owner-pill', 'ANAS', 'var(--anas-series-2,#7a3fb0)',
                    t('Created and managed by ANAS')) + '</span>';
        }
        var tip = ('' + (getf(rec, 'ownershipDetail') || t('Not managed by ANAS')));
        var badge = '';
        try {
            if (ANAS.gfx && typeof ANAS.gfx.badge === 'function') {
                badge = ANAS.gfx.badge('FOREIGN', { title: tip }) || '';
            }
        } catch (e) {
            badge = '';
        }
        if (!badge) {
            badge = '<span class="anas-gfx-badge" title="' + enc(tip) + '">' + enc('FOREIGN') + '</span>';
        }
        return '<span class="anas-iscsi-owner anas-iscsi-owner-foreign" title="' + enc(tip) + '">'
            + badge + '</span>';
    }

    // ---- Grid load ---------------------------------------------------------

    function gridOf(view) {
        try {
            return view ? view.down('#iscsiGrid') : null;
        } catch (e) {
            return null;
        }
    }

    function selectedTarget(grid) {
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function targetRow(tg) {
        tg = tg || {};
        return {
            iqn: tg.iqn,
            name: tg.name === undefined ? null : tg.name,
            ownership: tg.ownership || 'foreign',
            ownershipReason: tg.ownershipReason || '',
            ownershipDetail: tg.ownershipDetail || '',
            tpgTag: tg.tpgTag,
            enabled: tg.enabled === true,
            portals: isArray(tg.portals) ? tg.portals : [],
            lunCount: Number(tg.lunCount) || 0,
            aclCount: Number(tg.aclCount) || 0,
            sessionCount: Number(tg.sessionCount) || 0,
            security: tg.security || {},
            present: tg.present !== false,
            persisted: tg.persisted !== false,
            missingLunCount: Number(tg.missingLunCount) || 0,
            portalsWithoutInterfaceCount: Number(tg.portalsWithoutInterfaceCount) || 0,
            raw: tg
        };
    }

    // "LIO is not installed" is a first-class state, not an error: most PVE nodes
    // serve no block storage. The panel renders the envelope's own reason and the
    // toolbar goes flat — installing the packages belongs to another story, so
    // this says what is missing and stops.
    function applyEnvelope(view, env) {
        var banner = view ? view.down('#iscsiEnvelope') : null;
        var grid = gridOf(view);
        var installed = !!(env && env.installed);
        try {
            if (banner) {
                if (installed) {
                    banner.setHidden(true);
                } else {
                    banner.setHidden(false);
                    banner.update('<div class="anas-iscsi-notinstalled" style="padding:6px 2px;">'
                        + '<i class="fa fa-info-circle"></i> '
                        + enc((env && env.reason) || t('The LIO iSCSI target stack is not present on this node.'))
                        + '</div>');
                }
            }
        } catch (e) {
            // non-fatal
        }
        if (!grid) {
            return;
        }
        var ids = ['iscsiCreate', 'iscsiEdit', 'iscsiToggle', 'iscsiDelete', 'iscsiLuns', 'iscsiRepair'];
        for (var i = 0; i < ids.length; i++) {
            setDisabled(grid, ids[i], true);
        }
        if (installed) {
            setDisabled(grid, 'iscsiCreate', false);
            btnSetTip(grid, 'iscsiCreate', '');
        } else {
            btnSetTip(grid, 'iscsiCreate', t('Install targetcli-fb and python3-rtslib-fb on this node first'));
        }
        grid.anasInstalled = installed;
    }

    // ---- Restore holes: the health read behind the Repair button -----------
    //
    // A boot restore whose backing device was missing exits 0 and systemd calls
    // it a success, so the ONLY way anyone learns a LUN vanished is this diff of
    // the saved configuration against what the kernel actually has. The button
    // is live only when at least one hole's backing object is BACK — repairing
    // over an absent device is how the hole was made.

    function repairableHoles(health) {
        var missing = (health && isArray(health.missingLuns)) ? health.missingLuns : [];
        var out = [];
        for (var i = 0; i < missing.length; i++) {
            if (missing[i] && missing[i].backingExists === true) {
                out.push(missing[i]);
            }
        }
        return out;
    }

    function applyHealth(view, health) {
        var grid = gridOf(view);
        if (!grid) {
            return;
        }
        grid.anasHealth = health || null;
        if (grid.anasInstalled === false) {
            return;
        }
        var missing = (health && isArray(health.missingLuns)) ? health.missingLuns : [];
        var ready = repairableHoles(health);
        setDisabled(grid, 'iscsiRepair', ready.length === 0);
        var tip;
        if (!missing.length) {
            tip = t('Nothing to repair — the live configuration matches the saved one.');
        } else if (!ready.length) {
            var paths = [];
            for (var i = 0; i < missing.length; i++) {
                paths.push('' + (missing[i].backingPath || ''));
            }
            tip = t('Waiting on the backing storage: ') + paths.join(', ')
                + t('. Import the pool or restore the image, then Repair.');
        } else {
            tip = ready.length + ' ' + (ready.length === 1 ? t('LUN') : t('LUNs'))
                + ' ' + t('can be put back now — the same serial and attributes are replayed, '
                    + 'so the initiator sees the same disk.');
        }
        btnSetTip(grid, 'iscsiRepair', tip);
    }

    function loadHealth(view, node) {
        var grid = gridOf(view);
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        ANAS.api.get(node, '/iscsi/health').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            applyHealth(view, (res && res.data) || null);
        }, function () {
            // Fail-open: no health read means no Repair button, never a broken
            // screen. The grid itself has already loaded.
            if (!grid.destroyed && !grid.destroying) {
                applyHealth(view, null);
            }
        });
    }

    function repairHoles(view, node) {
        var grid = gridOf(view);
        var ready = repairableHoles(grid && grid.anasHealth);
        if (!ready.length) {
            return;
        }
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/iscsi/health/repair',
            body: {},
            view: view,
            failTitle: 'Repair failed',
            successMsg: t('Restore holes repaired') + ': ' + ready.length + ' '
                + (ready.length === 1 ? t('LUN') : t('LUNs')),
            onComplete: function () {
                loadTargets(view, node);
            }
        });
    }

    function loadTargets(view, node, quiet, onDone) {
        var grid = gridOf(view);
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        if (!quiet) {
            try {
                grid.setLoading(true);
            } catch (e) {
                // non-fatal
            }
        }
        var priorSel = selectedTarget(grid);
        var priorIqn = priorSel ? priorSel.get('iqn') : null;

        ANAS.api.get(node, '/iscsi/targets').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!quiet) {
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
            }
            var env = (res && res.data) || {};
            var list = isArray(env.targets) ? env.targets : [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(targetRow(list[i]));
            }
            grid.anasReloading = true;
            try {
                grid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('iscsi grid load failed: ' + ANAS.errText(e2));
            }
            applyEnvelope(view, env);
            if (priorIqn) {
                try {
                    var idx = grid.getStore().findExact('iqn', priorIqn);
                    if (idx >= 0) {
                        grid.getSelectionModel().select(idx, false, true);
                    }
                } catch (eSel) {
                    // non-fatal
                }
            }
            grid.anasReloading = false;
            updateButtons(grid);
            // The saveconfig ⟷ configfs diff behind the Repair button. A second
            // read, deliberately: it is the only source for a hole systemd
            // reported as a success, and it must never delay or break the grid.
            if (env.installed) {
                loadHealth(view, node);
            }
            if (onDone) {
                onDone(env);
            }
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.anasReloading = false;
            if (!quiet) {
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
            }
            ANAS.warn('iscsi load failed: ' + ANAS.errText(err));
        });
    }

    ANAS.iscsi = ANAS.iscsi || {};
    ANAS.iscsi.reload = loadTargets;
    // Story iscsi.6 — pure helpers, exposed so the dialog-contract harness can
    // assert on them directly rather than through a rendered cell.
    ANAS.iscsi.portalAddressWarning = portalAddressWarning;
    ANAS.iscsi.backingOwner = backingOwner;

    // ---- Toolbar state -----------------------------------------------------

    function setDisabled(grid, itemId, disabled) {
        try {
            var btn = grid.down('#' + itemId);
            if (btn) {
                btn.setDisabled(!!disabled);
            }
        } catch (e) {
            // non-fatal
        }
    }

    function btnSetTip(grid, itemId, msg) {
        try {
            var btn = grid.down('#' + itemId);
            if (btn) {
                btn.tooltip = msg || '';
                if (typeof btn.setTooltip === 'function') {
                    btn.setTooltip(msg || '');
                }
            }
        } catch (e) {
            // non-fatal
        }
    }

    // A foreign target is hands-off, exactly like a PVE-managed pool — and every
    // disabled control explains ITSELF, because a greyed button with no reason
    // reads as a bug rather than as a rule.
    function updateButtons(grid) {
        if (!grid) {
            return;
        }
        if (grid.anasInstalled === false) {
            return;
        }
        var rec = selectedTarget(grid);
        var has = !!rec;
        var foreign = has && rec.get('ownership') !== 'anas';
        var mutable = has && !foreign;

        setDisabled(grid, 'iscsiEdit', !mutable);
        setDisabled(grid, 'iscsiToggle', !mutable);
        setDisabled(grid, 'iscsiDelete', !mutable);
        // Looking at a foreign target's LUNs is READ — always allowed.
        setDisabled(grid, 'iscsiLuns', !has);

        var tip = foreign
            ? (t('View only — ') + ('' + (rec.get('ownershipDetail') || t('this target is not managed by ANAS'))))
            : '';
        btnSetTip(grid, 'iscsiEdit', tip);
        btnSetTip(grid, 'iscsiToggle', tip);
        btnSetTip(grid, 'iscsiDelete', tip);
        btnSetTip(grid, 'iscsiLuns', foreign ? t('Read-only: this target is not managed by ANAS') : '');

        try {
            var toggle = grid.down('#iscsiToggle');
            if (toggle) {
                var enabled = has && rec.get('enabled') === true;
                toggle.setText(enabled ? t('Disable') : t('Enable'));
                toggle.setIconCls(enabled ? 'fa fa-ban' : 'fa fa-check-circle-o');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // ---- Node addresses (PVE's own API — Don't Build Undifferentiated Code) --
    //
    // The portal picker needs the addresses this node actually carries. PVE
    // already publishes them at /nodes/<node>/network on the same origin and the
    // same session, which is exactly where the SMB Details "how to connect"
    // strings get theirs — so this reads the same endpoint rather than adding a
    // second one. Cached per node; any failure degrades to a free-text field.

    var netCache = {};

    function summarizeAddresses(list) {
        var out = [];
        var seen = {};
        for (var i = 0; i < (list || []).length; i++) {
            var n = list[i] || {};
            if (n.address && n.active && !seen[n.address]) {
                seen[n.address] = 1;
                out.push({ address: n.address, iface: n.iface || '' });
            }
            if (n.address6 && n.active && !seen[n.address6]) {
                seen[n.address6] = 1;
                out.push({ address: n.address6, iface: n.iface || '' });
            }
        }
        return out;
    }

    function loadNodeAddresses(node, cb) {
        if (netCache[node]) {
            cb(netCache[node]);
            return;
        }
        try {
            Ext.Ajax.request({
                url: '/api2/json/nodes/' + encodeURIComponent(node) + '/network',
                method: 'GET',
                timeout: 8000,
                success: function (resp) {
                    var info = [];
                    try {
                        var body = Ext.decode(resp.responseText);
                        info = summarizeAddresses(body && body.data);
                    } catch (e) {
                        info = [];
                    }
                    netCache[node] = info;
                    cb(info);
                },
                failure: function () {
                    netCache[node] = [];
                    cb([]);
                }
            });
        } catch (e) {
            cb([]);
        }
    }

    // ---- Create / Edit Target dialog ---------------------------------------

    // The ACL editor is a small list of rows; each row carries an initiator IQN
    // and its four credential fields, plus the "credentials set" state the read
    // layer reports (a secret is never returned, so the box is always empty and
    // the LABEL is what tells the operator one is stored).
    function aclRow(acl, index) {
        acl = acl || {};
        return {
            xtype: 'fieldset',
            itemId: 'aclRow',
            cls: 'anas-iscsi-acl-row',
            title: t('Initiator') + ' ' + (index + 1),
            collapsible: false,
            margin: '0 0 6 0',
            padding: '6 8 6 8',
            layout: 'anchor',
            defaults: { anchor: '100%', labelWidth: 180 },
            anasStored: acl,
            items: [
                {
                    xtype: 'textfield',
                    itemId: 'aclIqn',
                    cls: 'anas-fld-acl-iqn',
                    fieldLabel: t('Initiator IQN'),
                    emptyText: 'iqn.1993-08.org.debian:01:0123456789ab',
                    value: acl.initiatorIqn || ''
                },
                {
                    xtype: 'textfield',
                    itemId: 'aclUserid',
                    cls: 'anas-fld-acl-userid',
                    fieldLabel: t('CHAP username'),
                    value: acl.chapUserid || ''
                },
                {
                    xtype: 'textfield',
                    itemId: 'aclSecret',
                    cls: 'anas-fld-acl-secret',
                    inputType: 'password',
                    fieldLabel: acl.chapCredentialsSet
                        ? t('CHAP secret (stored — leave blank to keep)')
                        : t('CHAP secret'),
                    emptyText: acl.chapCredentialsSet ? t('unchanged') : ''
                },
                {
                    xtype: 'textfield',
                    itemId: 'aclMutualUserid',
                    cls: 'anas-fld-acl-mutual-userid',
                    fieldLabel: t('Mutual CHAP username'),
                    value: acl.mutualUserid || ''
                },
                {
                    xtype: 'textfield',
                    itemId: 'aclMutualSecret',
                    cls: 'anas-fld-acl-mutual-secret',
                    inputType: 'password',
                    fieldLabel: acl.mutualCredentialsSet
                        ? t('Mutual CHAP secret (stored — leave blank to keep)')
                        : t('Mutual CHAP secret'),
                    emptyText: acl.mutualCredentialsSet ? t('unchanged') : ''
                },
                {
                    xtype: 'button',
                    itemId: 'aclRemove',
                    cls: 'anas-btn-acl-remove',
                    text: t('Remove this initiator'),
                    iconCls: 'fa fa-trash',
                    margin: '4 0 0 0',
                    handler: function (btn) {
                        try {
                            var row = btn.up('#aclRow');
                            var cont = row && row.up('#aclsContainer');
                            if (cont && row) {
                                cont.remove(row);
                            }
                        } catch (e) {
                            ANAS.warn('acl row remove failed: ' + ANAS.errText(e));
                        }
                    }
                }
            ]
        };
    }

    function portalRow(portal) {
        portal = portal || {};
        return {
            xtype: 'fieldcontainer',
            itemId: 'portalRow',
            cls: 'anas-iscsi-portal-row',
            layout: 'hbox',
            margin: '0 0 4 0',
            items: [
                {
                    xtype: 'combobox',
                    itemId: 'portalAddress',
                    cls: 'anas-fld-portal-address',
                    flex: 1,
                    fieldLabel: t('Address'),
                    labelWidth: 120,
                    // Editable on purpose: an address that is about to exist is a
                    // legitimate thing to configure, and the store may be empty
                    // when PVE's network API could not be read.
                    editable: true,
                    queryMode: 'local',
                    displayField: 'label',
                    valueField: 'address',
                    value: portal.address || ''
                },
                {
                    xtype: 'numberfield',
                    itemId: 'portalPort',
                    cls: 'anas-fld-portal-port',
                    width: 150,
                    margin: '0 0 0 8',
                    fieldLabel: t('Port'),
                    labelWidth: 40,
                    minValue: 1,
                    maxValue: 65535,
                    value: portal.port || 3260
                },
                {
                    xtype: 'button',
                    itemId: 'portalRemove',
                    cls: 'anas-btn-portal-remove',
                    text: t('Remove'),
                    iconCls: 'fa fa-trash',
                    margin: '0 0 0 8',
                    handler: function (btn) {
                        try {
                            var row = btn.up('#portalRow');
                            var cont = row && row.up('#portalsContainer');
                            if (cont && row) {
                                cont.remove(row);
                            }
                        } catch (e) {
                            ANAS.warn('portal row remove failed: ' + ANAS.errText(e));
                        }
                    }
                }
            ]
        };
    }

    function rowsOf(win, containerId) {
        try {
            var cont = win.down('#' + containerId);
            return cont ? cont.items.getRange() : [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Open the Create / Edit Target dialog.
     *
     * `detail` is the FULL target detail (from GET /iscsi/targets/:iqn) on an
     * edit, or null on a create. Pre-fill reflects the entry exactly, never field
     * defaults: that is what makes an untouched edit send nothing.
     */
    function openTargetDialog(view, node, detail) {
        var isEdit = !!detail;
        var win;
        var storedAcls = (detail && isArray(detail.acls)) ? detail.acls : [];
        var storedPortals = (detail && isArray(detail.portals)) ? detail.portals : [];
        var storedAuth = detail
            ? (detail.security && detail.security.authentication
                ? (storedAcls.some(function (a) { return a.mutualCredentialsSet; }) ? 'mutual-chap' : 'chap')
                : 'none')
            : 'none';

        var portalItems = [];
        var i;
        if (isEdit) {
            for (i = 0; i < storedPortals.length; i++) {
                portalItems.push(portalRow(storedPortals[i]));
            }
        } else {
            portalItems.push(portalRow({}));
        }
        var aclItems = [];
        for (i = 0; i < storedAcls.length; i++) {
            aclItems.push(aclRow(storedAcls[i], i));
        }

        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-iscsi-target',
                title: isEdit ? (t('Edit iSCSI Target') + ': ' + (detail.name || detail.iqn)) : t('Create iSCSI Target'),
                modal: true,
                width: 720,
                maxHeight: 720,
                scrollable: true,
                layout: 'fit',
                anasEdit: isEdit,
                anasDetail: detail || null,
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    scrollable: true,
                    defaults: { anchor: '100%', labelWidth: 180 },
                    items: [
                        // --- identity -----------------------------------------
                        (isEdit
                            ? {
                                xtype: 'displayfield',
                                itemId: 'iqn',
                                cls: 'anas-fld-iscsi-iqn',
                                fieldLabel: t('IQN'),
                                value: enc(detail.iqn)
                            }
                            : {
                                xtype: 'textfield',
                                itemId: 'name',
                                cls: 'anas-fld-iscsi-name',
                                fieldLabel: t('Target name'),
                                allowBlank: false,
                                emptyText: 'vmstore',
                                value: ''
                            }),
                        {
                            xtype: 'component',
                            margin: '0 0 8 0',
                            style: 'color:gray;font-size:11px;',
                            html: enc(isEdit
                                ? t('The IQN is this target\'s identity for life. LIO has no rename — '
                                    + 'a different name means a different target, and every initiator '
                                    + 'configured against this one would have to be repointed.')
                                : t('ANAS generates the IQN from this name. It cannot be changed afterwards: '
                                    + 'LIO has no rename, so a "rename" is a new target.'))
                        },

                        // --- portals ------------------------------------------
                        {
                            xtype: 'fieldset',
                            title: t('Portals'),
                            padding: '6 8 6 8',
                            layout: 'anchor',
                            defaults: { anchor: '100%' },
                            items: [
                                {
                                    xtype: 'container',
                                    itemId: 'portalsContainer',
                                    layout: 'anchor',
                                    defaults: { anchor: '100%' },
                                    items: portalItems
                                },
                                {
                                    xtype: 'button',
                                    itemId: 'portalAdd',
                                    cls: 'anas-btn-portal-add',
                                    text: t('Add portal'),
                                    iconCls: 'fa fa-plus',
                                    margin: '4 0 0 0',
                                    handler: function (btn) {
                                        try {
                                            var cont = btn.up('#form').down('#portalsContainer');
                                            var added = cont.add(portalRow({}));
                                            applyAddressStore(btn.up('#form').up(), added);
                                        } catch (e) {
                                            ANAS.warn('portal add failed: ' + ANAS.errText(e));
                                        }
                                    }
                                },
                                {
                                    xtype: 'component',
                                    itemId: 'portalHint',
                                    margin: '4 0 0 0',
                                    style: 'color:gray;font-size:11px;',
                                    html: enc(t('A portal binds one address on this node. The wildcard is refused '
                                        + 'on purpose — an iSCSI target reachable on every interface is exposure '
                                        + 'nobody asked for. LIO will happily bind an address no interface carries, '
                                        + 'report it healthy and never say otherwise, so pick from the list where you can.'))
                                }
                            ]
                        },

                        // --- auth ---------------------------------------------
                        {
                            xtype: 'fieldset',
                            title: t('Authentication'),
                            padding: '6 8 6 8',
                            layout: 'anchor',
                            defaults: { anchor: '100%', labelWidth: 180 },
                            items: [
                                {
                                    xtype: 'radiogroup',
                                    itemId: 'authGroup',
                                    cls: 'anas-fld-iscsi-auth',
                                    fieldLabel: t('Mode'),
                                    columns: 1,
                                    vertical: true,
                                    items: [
                                        { boxLabel: t('ACL only (no CHAP)'), name: 'authMode', inputValue: 'none', checked: storedAuth === 'none' },
                                        { boxLabel: t('CHAP — the initiator proves itself to the target'), name: 'authMode', inputValue: 'chap', checked: storedAuth === 'chap' },
                                        { boxLabel: t('Mutual CHAP — both directions'), name: 'authMode', inputValue: 'mutual-chap', checked: storedAuth === 'mutual-chap' }
                                    ],
                                    listeners: {
                                        change: function (grp) {
                                            try {
                                                updateAuthNotes(grp.up('#form'));
                                            } catch (e) {
                                                // non-fatal
                                            }
                                        }
                                    }
                                },
                                {
                                    xtype: 'component',
                                    itemId: 'pveChapNote',
                                    cls: 'anas-iscsi-pve-chap-note',
                                    hidden: storedAuth === 'none',
                                    margin: '4 0 0 0',
                                    style: 'color:var(--anas-warn,#b06a12);font-size:11px;',
                                    html: enc(t('PVE\'s iscsi: storage plugin has no CHAP field. A PVE host that should '
                                        + 'consume this target needs /etc/iscsi/iscsid.conf hand-edited on every node — '
                                        + 'or leave this on "ACL only" and let the initiator IQN list be the boundary.'))
                                },
                                {
                                    xtype: 'component',
                                    itemId: 'chapLengthNote',
                                    hidden: storedAuth === 'none',
                                    margin: '4 0 0 0',
                                    style: 'color:gray;font-size:11px;',
                                    html: enc(t('A CHAP secret must be ' + CHAP_MIN + '–' + CHAP_MAX + ' bytes. LIO itself accepts '
                                        + 'a one-character secret without complaint; initiators do not, and a rejected '
                                        + 'login looks identical to a wrong password.'))
                                }
                            ]
                        },

                        // --- ACLs ---------------------------------------------
                        {
                            xtype: 'fieldset',
                            title: t('Initiator ACLs'),
                            padding: '6 8 6 8',
                            layout: 'anchor',
                            defaults: { anchor: '100%' },
                            items: [
                                {
                                    xtype: 'container',
                                    itemId: 'aclsContainer',
                                    layout: 'anchor',
                                    defaults: { anchor: '100%' },
                                    items: aclItems
                                },
                                {
                                    xtype: 'button',
                                    itemId: 'aclAdd',
                                    cls: 'anas-btn-acl-add',
                                    text: t('Add initiator'),
                                    iconCls: 'fa fa-plus',
                                    margin: '4 0 0 0',
                                    handler: function (btn) {
                                        try {
                                            var cont = btn.up('#form').down('#aclsContainer');
                                            cont.add(aclRow({}, cont.items.getCount()));
                                        } catch (e) {
                                            ANAS.warn('acl add failed: ' + ANAS.errText(e));
                                        }
                                    }
                                },
                                {
                                    xtype: 'component',
                                    margin: '4 0 0 0',
                                    style: 'color:gray;font-size:11px;',
                                    html: enc(t('Only the listed initiators may log in — LIO\'s demo mode, which would '
                                        + 'generate an ACL for anyone who asks, is never enabled. Removing an initiator '
                                        + 'drops its session immediately and destroys its CHAP credentials.'))
                                }
                            ]
                        }
                    ]
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        }
                    },
                    {
                        text: isEdit ? t('Save') : t('Create'),
                        cls: 'anas-btn-iscsi-target-submit',
                        handler: function () {
                            try {
                                submitTarget(win, view, node, detail);
                            } catch (e) {
                                ANAS.warn('iscsi target submit failed: ' + ANAS.errText(e));
                            }
                        }
                    }
                ]
            });
        } catch (e) {
            ANAS.warn('iscsi target window failed: ' + ANAS.errText(e));
            return;
        }

        // The address picker is filled asynchronously; the field works either way.
        loadNodeAddresses(node, function (addresses) {
            if (win.destroyed || win.destroying) {
                return;
            }
            win.anasAddresses = addresses;
            var rows = rowsOf(win, 'portalsContainer');
            for (var k = 0; k < rows.length; k++) {
                applyAddressStore(win, rows[k]);
            }
        });

        win.show();
        return win;
    }

    /**
     * Story iscsi.6 — the picker warns when the chosen address is not one this
     * node currently carries.
     *
     * LIO binds a portal to an address that does not exist, reports [OK], keeps
     * it across an interface deletion AND a service restart, and never writes a
     * single log line (GT-24). Nothing downstream will ever tell the operator.
     * The picker is the first and cheapest place to say it.
     *
     * A WARNING, never a block, for two reasons: an address that is about to
     * exist (a VLAN being built, a VIP that fails over) is a legitimate thing to
     * configure, and an EMPTY address list means PVE's network API could not be
     * read — in which case saying "no interface carries this" would be a lie.
     * Empty list ⇒ silence.
     *
     * Returns the warning sentence, or '' when there is nothing to say. Pure, so
     * the dialog-contract harness can assert on it directly.
     */
    function portalAddressWarning(addresses, address) {
        var addr = ('' + (address == null ? '' : address)).trim();
        var list = isArray(addresses) ? addresses : [];
        if (!addr || list.length === 0) {
            return '';
        }
        for (var i = 0; i < list.length; i++) {
            var known = '' + ((list[i] && list[i].address) || list[i] || '');
            if (known.toLowerCase() === addr.toLowerCase()) {
                return '';
            }
        }
        return t('No interface on this node currently carries ') + addr
            + t('. LIO will bind the portal anyway, report it as healthy, and never '
                + 'tell you it is unreachable — check the address, or create it first.');
    }

    // Attach the warning to one portal-address field (and evaluate it now).
    // Fail-open at every step: an explanation must never break a dialog.
    function applyPortalAddressWarning(win, field) {
        try {
            if (!field) {
                return;
            }
            var msg = portalAddressWarning((win && win.anasAddresses) || [],
                typeof field.getValue === 'function' ? field.getValue() : '');
            field.anasAddressWarning = msg;
            if (typeof field.setTooltip === 'function') {
                field.setTooltip(msg || '');
            }
            if (typeof field.setFieldStyle === 'function') {
                field.setFieldStyle(msg ? 'background-color:#fff8e1;' : '');
            }
        } catch (e) {
            // non-fatal
        }
    }

    function applyAddressStore(win, row) {
        try {
            var list = (win && win.anasAddresses) || [];
            var field = row && row.down ? row.down('#portalAddress') : null;
            if (!field || typeof field.setStore !== 'function') {
                return;
            }
            var data = [];
            for (var i = 0; i < list.length; i++) {
                data.push({
                    address: list[i].address,
                    label: list[i].address + (list[i].iface ? ' (' + list[i].iface + ')' : '')
                });
            }
            field.setStore(Ext.create('Ext.data.Store', { fields: ['address', 'label'], data: data }));
            // Story iscsi.6: evaluate the "no interface carries this" warning
            // now (a pre-filled edit) and on every later change.
            applyPortalAddressWarning(win, field);
            try {
                if (typeof field.on === 'function' && !field.anasAddressWarningWired) {
                    field.anasAddressWarningWired = true;
                    field.on('change', function () {
                        applyPortalAddressWarning(win, field);
                    });
                }
            } catch (eW) {
                // non-fatal
            }
        } catch (e) {
            // non-fatal — the field stays free-text
        }
    }

    function updateAuthNotes(form) {
        var mode = authModeOf(form);
        try {
            form.down('#pveChapNote').setHidden(mode === 'none');
            form.down('#chapLengthNote').setHidden(mode === 'none');
        } catch (e) {
            // non-fatal
        }
    }

    // The radiogroup is the ONE source of truth for the auth mode — a hidden
    // mirror is a Text-class field, so a mirrored value comes back as a string
    // and every save reads the same mode.
    function authModeOf(scope) {
        try {
            var g = scope.down('#authGroup');
            var v = g && g.getValue();
            var mode = v && v.authMode;
            return (mode === 'chap' || mode === 'mutual-chap') ? mode : 'none';
        } catch (e) {
            return 'none';
        }
    }

    /** Read the portal rows into the request array. */
    function readPortals(win) {
        var rows = rowsOf(win, 'portalsContainer');
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var address = ('' + (rows[i].down('#portalAddress').getValue() || '')).trim();
            if (!address) {
                continue;
            }
            var port = parseInt(rows[i].down('#portalPort').getValue(), 10);
            out.push({ address: address, port: (isNaN(port) || port < 1) ? 3260 : port });
        }
        return out;
    }

    /**
     * Read the ACL rows under the clear contract.
     *
     * A credential field that the operator LEFT BLANK on an ACL that already has
     * one sends NO key at all: omitted means keep, and that is what lets an edit
     * touch a portal without re-typing every secret. A field that was blanked on
     * an ACL that HAD a value sends null, which clears it.
     */
    function readAcls(win) {
        var rows = rowsOf(win, 'aclsContainer');
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var iqn = ('' + (row.down('#aclIqn').getValue() || '')).trim();
            if (!iqn) {
                continue;
            }
            var stored = row.anasStored || {};
            var acl = { initiatorIqn: iqn };

            applyClearContract(acl, 'chapUserid',
                ('' + (row.down('#aclUserid').getValue() || '')).trim(), stored.chapUserid || '');
            applyClearContract(acl, 'mutualUserid',
                ('' + (row.down('#aclMutualUserid').getValue() || '')).trim(), stored.mutualUserid || '');

            // A secret is WRITE-ONLY, so the box is always empty when the dialog
            // opens. Blank therefore cannot mean "clear" — it means "keep", the
            // mounts precedent. Clearing a stored secret is done by clearing its
            // USERNAME, which the daemon reads as "this ACL has no CHAP".
            var secret = '' + (row.down('#aclSecret').getValue() || '');
            if (secret) {
                acl.chapSecret = secret;
            } else if (stored.chapCredentialsSet && !acl.chapUserid && acl.chapUserid !== undefined) {
                acl.chapSecret = null;
            }
            var mutual = '' + (row.down('#aclMutualSecret').getValue() || '');
            if (mutual) {
                acl.mutualSecret = mutual;
            } else if (stored.mutualCredentialsSet && !acl.mutualUserid && acl.mutualUserid !== undefined) {
                acl.mutualSecret = null;
            }
            out.push(acl);
        }
        return out;
    }

    // value / null / omitted = set / clear / keep, for one text field.
    function applyClearContract(target, key, current, stored) {
        if (current === stored) {
            return; // untouched — omit, so the daemon keeps what it has
        }
        target[key] = current === '' ? null : current;
    }

    // The 12–16 byte rule, said EARLY. The daemon enforces it too (Principle 14
    // — the API is the authority); this is the same refusal said before the
    // round trip, because LIO itself accepts a one-character secret and the
    // resulting login failure is indistinguishable from a wrong password.
    function validateAcls(acls) {
        for (var i = 0; i < acls.length; i++) {
            var a = acls[i];
            if (a.chapSecret && (byteLength(a.chapSecret) < CHAP_MIN || byteLength(a.chapSecret) > CHAP_MAX)) {
                return t('The CHAP secret for') + ' ' + a.initiatorIqn + ' ' + t('must be')
                    + ' ' + CHAP_MIN + '–' + CHAP_MAX + ' ' + t('bytes.');
            }
            if (a.mutualSecret && (byteLength(a.mutualSecret) < CHAP_MIN || byteLength(a.mutualSecret) > CHAP_MAX)) {
                return t('The mutual CHAP secret for') + ' ' + a.initiatorIqn + ' ' + t('must be')
                    + ' ' + CHAP_MIN + '–' + CHAP_MAX + ' ' + t('bytes.');
            }
        }
        return null;
    }

    function submitTarget(win, view, node, detail) {
        var isEdit = !!detail;
        var portals = readPortals(win);
        if (!portals.length) {
            ANAS.alertMsg('Invalid input', t('A target needs at least one portal.'));
            return;
        }
        var mode = authModeOf(win);
        var acls = readAcls(win);
        var problem = validateAcls(acls);
        if (problem) {
            ANAS.alertMsg('Invalid input', problem);
            return;
        }

        if (!isEdit) {
            var name = textOf(win, '#name');
            if (!name) {
                ANAS.alertMsg('Invalid input', t('Enter a target name.'));
                return;
            }
            ANAS.runJob({
                node: node,
                method: 'post',
                path: '/iscsi/targets',
                body: { name: name, portals: portals, auth: mode, acls: acls },
                view: win,
                failTitle: 'Create failed',
                successMsg: t('iSCSI target created') + ': ' + name,
                onComplete: function () {
                    if (!win.destroyed && !win.destroying) {
                        win.close();
                    }
                    loadTargets(view, node);
                }
            });
            return;
        }

        // An EDIT sends only what changed. An untouched dialog therefore sends an
        // empty body and rewrites nothing — the dialog↔daemon contract.
        var body = {};
        if (mode !== storedAuthOf(detail)) {
            body.auth = mode;
        }
        if (portalsChanged(portals, detail.portals)) {
            body.portals = portals;
        }
        if (aclsChanged(acls, detail.acls)) {
            body.acls = acls;
        }
        if (!body.auth && !body.portals && !body.acls) {
            ANAS.toast(t('No changes to save'));
            win.close();
            return;
        }

        ANAS.confirmAndRun({
            node: node,
            method: 'put',
            path: '/iscsi/targets/' + encIqn(detail.iqn),
            body: body,
            view: win,
            confirmTitle: 'Confirm target change',
            confirmIntro: t('This change drops live sessions:'),
            failTitle: 'Save failed',
            successMsg: t('iSCSI target saved') + ': ' + (detail.name || detail.iqn),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadTargets(view, node);
            }
        });
    }

    function storedAuthOf(detail) {
        if (!detail || !detail.security || !detail.security.authentication) {
            return 'none';
        }
        var acls = isArray(detail.acls) ? detail.acls : [];
        for (var i = 0; i < acls.length; i++) {
            if (acls[i].mutualCredentialsSet) {
                return 'mutual-chap';
            }
        }
        return 'chap';
    }

    function portalsChanged(next, stored) {
        var have = isArray(stored) ? stored : [];
        if (next.length !== have.length) {
            return true;
        }
        var key = function (p) { return ('' + p.address).toLowerCase() + ':' + p.port; };
        var seen = {};
        var i;
        for (i = 0; i < have.length; i++) {
            seen[key(have[i])] = 1;
        }
        for (i = 0; i < next.length; i++) {
            if (!seen[key(next[i])]) {
                return true;
            }
        }
        return false;
    }

    function aclsChanged(next, stored) {
        var have = isArray(stored) ? stored : [];
        if (next.length !== have.length) {
            return true;
        }
        var byIqn = {};
        var i;
        for (i = 0; i < have.length; i++) {
            byIqn[have[i].initiatorIqn] = have[i];
        }
        for (i = 0; i < next.length; i++) {
            var a = next[i];
            if (!byIqn[a.initiatorIqn]) {
                return true;
            }
            // Any key beyond the IQN means something was set or cleared.
            for (var k in a) {
                if (a.hasOwnProperty(k) && k !== 'initiatorIqn') {
                    return true;
                }
            }
        }
        return false;
    }

    // ---- Enable / Disable / Delete -----------------------------------------

    function toggleTarget(view, node, rec) {
        if (!rec) {
            return;
        }
        var enabled = rec.get('enabled') === true;
        var action = enabled ? 'disable' : 'enable';
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/iscsi/targets/' + encIqn(rec.get('iqn')) + '/state',
            body: { action: action },
            view: view,
            failTitle: 'State change failed',
            successMsg: t('Target') + ' ' + (enabled ? t('disabled') : t('enabled')) + ': '
                + (rec.get('name') || rec.get('iqn')),
            onComplete: function () {
                loadTargets(view, node);
            }
        });
    }

    function deleteTarget(view, node, rec) {
        if (!rec) {
            return;
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'del',
            path: '/iscsi/targets/' + encIqn(rec.get('iqn')),
            view: view,
            confirmTitle: 'Delete iSCSI target',
            confirmIntro: t('Deleting') + ' <b>' + enc(rec.get('name') || rec.get('iqn')) + '</b>:',
            confirmButtonText: t('Delete'),
            confirmWindow: true,
            failTitle: 'Delete failed',
            successMsg: t('iSCSI target deleted') + ': ' + (rec.get('name') || rec.get('iqn')),
            onComplete: function () {
                loadTargets(view, node);
            }
        });
    }

    // ---- LUNs window (display + its own toolbar) ---------------------------

    function renderLunKind(v) {
        var s = '' + (v == null ? '' : v);
        if (s === 'zvol') {
            return pill('anas-lun-kind anas-lun-kind-zvol', t('ZFS volume'), 'var(--anas-series-3,#147d68)',
                t('A zvol. Grows live — the initiator rescans and sees the bigger disk.'));
        }
        if (s === 'file') {
            return pill('anas-lun-kind anas-lun-kind-file', t('Image file'), 'var(--anas-series-5,#2f6f8f)',
                t('A raw image on a dataset or an AHR pool. Its size is fixed at creation, so a grow '
                    + 'recreates the backstore with the same identity.'));
        }
        // `unresolved` is NOT `foreign` (story iscsi.5): the backing is not on
        // this node right now — an exported pool, a renamed dataset, a missing
        // image — which says nothing about who owns it. It is a hole to repair,
        // and the target stays ANAS's.
        if (s === 'unresolved') {
            return pill('anas-lun-kind anas-lun-kind-unresolved', t('Unresolved'), 'var(--anas-warn,#b7791f)',
                t('The backing object is not on this node right now — the pool is not imported, the '
                    + 'dataset is gone, or the image file is missing. This is a restore hole, not a '
                    + 'foreign disk: bring the storage back and use Repair.'));
        }
        return pill('anas-lun-kind anas-lun-kind-foreign', t('Foreign'), 'var(--anas-muted,gray)',
            t('Backed by something ANAS does not manage'));
    }

    // The serial is the whole identity contract — every initiator, ESXi, Windows
    // and every PVE volid keys on it. Never truncated.
    function renderSerial(v) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            return '<span style="color:gray;" title="'
                + enc(t('The unit serial could not be read')) + '">&mdash;</span>';
        }
        return '<span title="' + enc(t('SCSI unit serial — initiators and PVE volids identify this LUN by it'))
            + '" style="font-family:monospace;font-size:0.88em;">' + enc(s) + '</span>';
    }

    /**
     * Which ANAS screen owns a LUN's backing object, and what it is called
     * there (story iscsi.6).
     *
     * NAME ONLY — no navigation machinery, no cross-view router, no deep link.
     * The point is that an operator looking at a LUN can see where the thing it
     * serves lives, and go there by hand. Everything below is derived from what
     * the read layer already classified; nothing is guessed:
     *
     *   zvol, or a file on a ZFS dataset  → Datasets, by dataset name
     *   a file on an AHR pool (no dataset) → Hybrid RAID, by pool name
     *   any other resolvable file          → Mounts, by its directory
     *   a foreign/unresolved backing       → nothing (no ANAS screen owns it)
     */
    function backingOwner(rec) {
        try {
            var kind = getf(rec, 'kind');
            var pool = getf(rec, 'pool');
            var dataset = getf(rec, 'dataset');
            var path = '' + (getf(rec, 'backingPath') || '');
            if (kind === 'zvol') {
                return dataset ? { screen: t('Datasets'), name: dataset } : null;
            }
            if (kind !== 'file') {
                return null;
            }
            if (dataset) {
                return { screen: t('Datasets'), name: dataset };
            }
            if (pool) {
                return { screen: t('Hybrid RAID'), name: pool };
            }
            var cut = path.lastIndexOf('/');
            return cut > 0 ? { screen: t('Mounts'), name: path.substring(0, cut) } : null;
        } catch (e) {
            return null;
        }
    }

    function backingOwnerHtml(rec) {
        var owner = backingOwner(rec);
        if (!owner) {
            return '';
        }
        var tip = t('This object lives on the ') + owner.screen + t(' screen, as ') + owner.name;
        return ' <span class="anas-lun-owner" title="' + enc(tip) + '" style="color:gray;font-size:0.85em;">'
            + enc('→ ' + owner.screen + ': ' + owner.name) + '</span>';
    }

    function renderBacking(v, meta, rec) {
        var s = '' + (v == null ? '' : v);
        if (!s) {
            return '<span style="color:gray;">&mdash;</span>';
        }
        var exists = getf(rec, 'backingExists');
        if (exists === false) {
            return '<span class="anas-lun-backing anas-lun-backing-broken" style="color:var(--anas-danger,#c23b2c);" title="'
                + enc(t('This path does not resolve on this node. A rename under a live LUN succeeds '
                    + 'silently in ZFS and leaves exactly this — the LUN keeps serving from the open '
                    + 'device, and the next boot restore drops it.'))
                + '"><i class="fa fa-exclamation-circle"></i> ' + enc(s) + '</span>';
        }
        return '<span class="anas-lun-backing" title="' + enc(s)
            + '" style="font-family:monospace;font-size:0.88em;">' + enc(s) + '</span>'
            + backingOwnerHtml(rec);
    }

    function renderLunSessions(v) {
        var list = isArray(v) ? v : [];
        if (!list.length) {
            return '<span style="color:gray;">' + enc(t('none')) + '</span>';
        }
        return '<span class="anas-lun-connected" title="' + enc(list.join(', ')) + '">'
            + enc(list.length + ' ' + (list.length === 1 ? t('initiator') : t('initiators'))) + '</span>';
    }

    // The attribute summary an operator can act on, in words rather than flags.
    function lunAttributesHtml(attrs) {
        attrs = attrs || {};
        var bits = [];
        bits.push(t('Block size') + ': ' + (attrs.blockSize || 512) + ' ' + t('bytes')
            + ' (' + t('create-only') + ')');
        bits.push(t('Thin reclaim') + ': ' + (attrs.emulateTpu ? t('on') : t('off')));
        bits.push(t('Write cache') + ': '
            + (attrs.writeBack ? t('write-back — a crash loses acknowledged writes') : t('write-through')));
        if (attrs.maxUnmapLbaCount) {
            bits.push(t('Max UNMAP') + ': ' + attrs.maxUnmapLbaCount + ' ' + t('blocks'));
        }
        return enc(bits.join(' · '));
    }

    function lunRow(l) {
        l = l || {};
        return {
            index: l.index,
            name: l.name,
            kind: l.kind,
            plugin: l.plugin,
            backingPath: l.backingPath,
            size: l.size,
            serial: l.serial,
            attributes: l.attributes || {},
            connectedInitiators: isArray(l.connectedInitiators) ? l.connectedInitiators : [],
            present: l.present !== false,
            backingExists: l.backingExists,
            pool: l.pool,
            dataset: l.dataset,
            raw: l
        };
    }

    function lunsGridOf(win) {
        try {
            return win ? win.down('#lunsGrid') : null;
        } catch (e) {
            return null;
        }
    }

    function selectedLun(win) {
        var grid = lunsGridOf(win);
        var sel = grid ? grid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    function updateLunButtons(win) {
        var grid = lunsGridOf(win);
        if (!grid) {
            return;
        }
        var foreign = win.anasForeign === true;
        var rec = selectedLun(win);
        var has = !!rec;
        var live = has && (rec.get('connectedInitiators') || []).length > 0;
        // A resize needs a backing object ANAS manages AND one that is actually
        // there: an `unresolved` LUN's zvol or image is not on this node right
        // now, so there is nothing to grow (story iscsi.5).
        var kind = has ? rec.get('kind') : '';
        var unresolved = kind === 'unresolved';
        var kindOk = has && kind !== 'foreign' && !unresolved;

        // A whole-image restore needs the same things a resize does — a backing
        // object ANAS manages and one that is actually THERE — plus a known
        // size, because the size EQUALITY is the only guard against a
        // half-overwritten LUN (nothing below ANAS checks it, backup2.7).
        var missing = has && rec.get('backingExists') === false;
        var sizeKnown = has && Number(rec.get('size')) > 0;
        var restorable = has && kindOk && !missing && sizeKnown;

        // A ZVOL grows live under a session — the volume resizes, the initiator
        // rescans and sees the new size (story iscsi.3, live-proof F13). The
        // Datasets door has always allowed it on the same held volume; this one
        // used to refuse, and two doors disagreeing about one safe operation
        // reads as "it cannot be done". A FILE-backed LUN is still refused: its
        // size is fixed at creation, so a resize is a backstore recreate under
        // the initiator's feet.
        var zvol = kind === 'zvol';
        setDisabled(grid, 'lunAdd', foreign);
        setDisabled(grid, 'lunResize', foreign || !has || (live && !zvol) || !kindOk);
        setDisabled(grid, 'lunRestore', foreign || !has || live || !restorable);
        setDisabled(grid, 'lunDelete', foreign || !has || live);

        var foreignTip = t('This target is not managed by ANAS — hands-off');
        var liveTip = t('An initiator is logged in. Resizing or deleting a LUN under a live session is '
            + 'refused: LIO would do it anyway and leave a stale device on the other host with no '
            + 'kernel message. Log the initiator out first.');
        var restoreLiveTip = t('An initiator is logged in. A whole-image restore overwrites the block '
            + 'device under a mounted filesystem, and neither LIO nor the initiator would be told. '
            + 'Log the initiator out first.');
        btnSetTip(grid, 'lunRestore', foreign ? foreignTip
            : (live
                ? restoreLiveTip
                : (missing
                    ? t('The backing object is not on this node right now — bring the storage back, '
                        + 'then Repair, before restoring onto it.')
                    : (has && !kindOk
                        ? t('The backing object is not storage ANAS manages')
                        : (has && !sizeKnown
                            ? t('This LUN\'s size is unknown, so ANAS cannot prove a backup image is exactly '
                                + 'its size — and a mismatch is silently destructive.')
                            : '')))));
        btnSetTip(grid, 'lunAdd', foreign ? foreignTip : '');
        var resizeLiveTip = t('An initiator is logged in. A file-backed LUN\'s size is fixed at creation, so '
            + 'resizing it deletes and recreates the backstore under the initiator\'s feet, with no kernel '
            + 'message either side. Log the initiator out first. (A zvol-backed LUN grows live.)');
        btnSetTip(grid, 'lunResize', foreign ? foreignTip
            : (live && !zvol
                ? resizeLiveTip
                : (unresolved
                    ? t('The backing object is not on this node right now — bring the storage back, '
                        + 'then Repair, before resizing.')
                    : (has && !kindOk ? t('The backing object is not storage ANAS manages') : ''))));
        btnSetTip(grid, 'lunDelete', foreign ? foreignTip : (live ? liveTip : ''));
    }

    function loadLuns(win, node, iqn, quiet) {
        var grid = lunsGridOf(win);
        if (!grid || grid.destroyed || grid.destroying) {
            return;
        }
        if (!quiet) {
            try {
                grid.setLoading(true);
            } catch (e) {
                // non-fatal
            }
        }
        ANAS.api.get(node, '/iscsi/targets/' + encIqn(iqn)).then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!quiet) {
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
            }
            var detail = (res && res.data) || {};
            win.anasDetail = detail;
            win.anasForeign = detail.ownership !== 'anas';
            var list = isArray(detail.luns) ? detail.luns : [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(lunRow(list[i]));
            }
            var priorIdx = selectedLun(win);
            var priorN = priorIdx ? priorIdx.get('index') : null;
            try {
                grid.getStore().loadData(rows);
                if (priorN !== null) {
                    var at = grid.getStore().findExact('index', priorN);
                    if (at >= 0) {
                        grid.getSelectionModel().select(at, false, true);
                    }
                }
            } catch (e2) {
                ANAS.warn('luns load failed: ' + ANAS.errText(e2));
            }
            renderSessionPanel(win, detail);
            renderFirewallAdvisory(win, detail);
            updateLunButtons(win);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            if (!quiet) {
                try {
                    grid.setLoading(false);
                } catch (e) {
                    // non-fatal
                }
            }
            ANAS.warn('luns load failed: ' + ANAS.errText(err));
        });
    }

    /**
     * The PVE-firewall advisory (story iscsi.6).
     *
     * A portal can bind, listen, and be counted healthy everywhere in ANAS while
     * `pve-firewall` quietly drops every SYN to 3260. The daemon reads the
     * firewall (read-only, never a write) and hands over one sentence; this
     * shows it and nothing more.
     *
     * Shown ONLY on a positive verdict. The daemon nulls `advisory` when the
     * firewall is off, when it could not tell, and when a rule does admit the
     * port — and an older daemon sends no `firewall` object at all, in which case
     * this is silent too (version-skew ruling).
     */
    function renderFirewallAdvisory(win, detail) {
        var panel = win.down ? win.down('#lunFirewall') : null;
        if (!panel) {
            return;
        }
        var advisory = '';
        try {
            advisory = '' + ((detail && detail.firewall && detail.firewall.advisory) || '');
        } catch (e) {
            advisory = '';
        }
        try {
            if (!advisory) {
                panel.setHidden(true);
                panel.update('');
                return;
            }
            panel.update('<span class="anas-iscsi-firewall-advisory" style="color:var(--anas-warning,#b8860b);">'
                + '<i class="fa fa-exclamation-triangle"></i> ' + enc(advisory) + '</span>');
            panel.setHidden(false);
        } catch (e2) {
            // non-fatal — an advisory must never break the detail window
        }
    }

    // Sessions are the live half of the detail window: who is logged in, from
    // where, onto which LUNs. `(NOT AUTHENTICATED)` from targetcli is deliberately
    // never surfaced anywhere — it reflects mutual CHAP, not whether the
    // initiator authenticated, and a one-way-CHAP session prints it.
    function renderSessionPanel(win, detail) {
        var panel = win.down('#lunSessions');
        if (!panel) {
            return;
        }
        var sessions = isArray(detail && detail.sessions) ? detail.sessions : [];
        var html;
        if (!sessions.length) {
            html = '<div style="color:gray;padding:6px 2px;">'
                + enc(t('No initiator is logged in right now.')) + '</div>';
        } else {
            var rows = [];
            for (var i = 0; i < sessions.length; i++) {
                var s = sessions[i] || {};
                var conns = isArray(s.connections) ? s.connections : [];
                var addrs = [];
                for (var c = 0; c < conns.length; c++) {
                    if (conns[c].address) {
                        addrs.push(conns[c].address);
                    }
                }
                rows.push('<div class="anas-iscsi-session" style="padding:3px 2px;">'
                    + '<span style="font-family:monospace;font-size:0.88em;">' + enc(s.initiatorIqn) + '</span>'
                    + (s.initiatorAlias ? ' <span style="color:gray;">(' + enc(s.initiatorAlias) + ')</span>' : '')
                    + (addrs.length ? ' &mdash; ' + enc(addrs.join(', ')) : '')
                    + ' &mdash; ' + enc(t('LUNs') + ': ' + (isArray(s.mappedLuns) ? s.mappedLuns.join(', ') : ''))
                    + '</div>');
            }
            html = rows.join('');
        }
        try {
            panel.update('<div style="padding:4px 2px;"><b>' + enc(t('Live sessions')) + '</b></div>' + html);
        } catch (e) {
            // non-fatal
        }
    }

    function startSessionPoll(win, node, iqn) {
        stopSessionPoll(win);
        try {
            win._anasTimer = setInterval(function () {
                try {
                    if (win.destroyed || win.destroying) {
                        stopSessionPoll(win);
                        return;
                    }
                    if (typeof document !== 'undefined' && document.hidden) {
                        return;
                    }
                    if (typeof win.isVisible === 'function' && !win.isVisible()) {
                        return;
                    }
                    loadLuns(win, node, iqn, true);
                } catch (tickErr) {
                    ANAS.warn('iscsi session poll failed: ' + ANAS.errText(tickErr));
                }
            }, SESSION_POLL_MS);
        } catch (e) {
            ANAS.warn('iscsi session poll start failed: ' + ANAS.errText(e));
        }
    }

    function stopSessionPoll(win) {
        try {
            if (win && win._anasTimer) {
                clearInterval(win._anasTimer);
                win._anasTimer = null;
            }
        } catch (e) {
            // non-fatal
        }
    }

    function openLunsWindow(view, node, rec) {
        if (!rec) {
            return;
        }
        var iqn = rec.get('iqn');
        var label = rec.get('name') || iqn;
        var store = Ext.create('Ext.data.Store', {
            fields: [
                { name: 'index', type: 'auto' },
                'name', 'kind', 'plugin', 'backingPath',
                { name: 'size', type: 'auto' },
                'serial',
                { name: 'attributes', type: 'auto' },
                { name: 'connectedInitiators', type: 'auto' },
                { name: 'present', type: 'auto' },
                { name: 'backingExists', type: 'auto' },
                'pool', 'dataset',
                { name: 'raw', type: 'auto' }
            ],
            data: [],
            sorters: [{ property: 'index', direction: 'ASC' }]
        });

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-iscsi-luns',
                title: t('LUNs') + ': ' + label,
                modal: true,
                width: 1000,
                height: 560,
                layout: { type: 'vbox', align: 'stretch' },
                anasIqn: iqn,
                items: [
                    {
                        xtype: 'gridpanel',
                        itemId: 'lunsGrid',
                        cls: 'anas-grid-iscsi-luns',
                        flex: 1,
                        border: false,
                        store: store,
                        selModel: { mode: 'SINGLE' },
                        emptyText: t('This target has no LUNs'),
                        columns: [
                            { text: t('LUN'), dataIndex: 'index', width: 70, align: 'right' },
                            { text: t('Name (SCSI model)'), dataIndex: 'name', flex: 1, minWidth: 150 },
                            { text: t('Kind'), dataIndex: 'kind', width: 130, align: 'center', renderer: renderLunKind },
                            { text: t('Backing'), dataIndex: 'backingPath', flex: 2, minWidth: 220, sortable: false, renderer: renderBacking },
                            {
                                text: t('Size'), dataIndex: 'size', width: 110, align: 'right',
                                renderer: function (v) {
                                    return v === null || v === undefined
                                        ? '<span style="color:gray;">&mdash;</span>'
                                        : enc(fmtBytes(v));
                                }
                            },
                            { text: t('Serial'), dataIndex: 'serial', flex: 2, minWidth: 260, sortable: false, renderer: renderSerial },
                            { text: t('Connected now'), dataIndex: 'connectedInitiators', width: 140, align: 'center', sortable: false, renderer: renderLunSessions }
                        ],
                        tbar: ANAS.tbar([
                            {
                                text: t('Add LUN…'),
                                itemId: 'lunAdd',
                                cls: 'anas-btn-lun-add',
                                iconCls: 'fa fa-plus',
                                handler: function (btn) {
                                    openAddLunDialog(btn.up('#lunsGrid').up(), view, node, iqn);
                                }
                            },
                            {
                                text: t('Resize…'),
                                itemId: 'lunResize',
                                cls: 'anas-btn-lun-resize',
                                iconCls: 'fa fa-arrows-h',
                                disabled: true,
                                handler: function (btn) {
                                    var w = btn.up('#lunsGrid').up();
                                    openResizeLunDialog(w, view, node, iqn, selectedLun(w));
                                }
                            },
                            {
                                text: t('Restore from backup…'),
                                itemId: 'lunRestore',
                                cls: 'anas-btn-lun-restore',
                                iconCls: 'fa fa-undo',
                                disabled: true,
                                handler: function (btn) {
                                    var w = btn.up('#lunsGrid').up();
                                    openRestoreLunDialog(w, view, node, iqn, selectedLun(w));
                                }
                            },
                            {
                                text: t('Delete'),
                                itemId: 'lunDelete',
                                cls: 'anas-btn-lun-delete',
                                iconCls: 'fa fa-trash',
                                disabled: true,
                                handler: function (btn) {
                                    var w = btn.up('#lunsGrid').up();
                                    deleteLun(w, view, node, iqn, selectedLun(w));
                                }
                            }
                        ]),
                        listeners: {
                            selectionchange: function (selModel, selected) {
                                var w = this.up();
                                updateLunButtons(w);
                                try {
                                    var rec2 = (selected && selected.length) ? selected[0] : null;
                                    var attrs = w.down('#lunAttributes');
                                    if (attrs) {
                                        attrs.update(rec2
                                            ? '<div style="padding:4px 2px;"><b>' + enc(t('LUN')) + ' ' + enc(rec2.get('index'))
                                                + '</b> &mdash; ' + lunAttributesHtml(rec2.get('attributes')) + '</div>'
                                            : '');
                                    }
                                } catch (e) {
                                    // non-fatal
                                }
                            }
                        }
                    },
                    {
                        xtype: 'component',
                        itemId: 'lunAttributes',
                        cls: 'anas-iscsi-lun-attrs',
                        html: ''
                    },
                    {
                        // Story iscsi.6: the PVE-firewall advisory. One line,
                        // hidden unless the daemon positively reports "enabled
                        // and nothing admits 3260/tcp".
                        xtype: 'component',
                        itemId: 'lunFirewall',
                        cls: 'anas-iscsi-firewall-note',
                        hidden: true,
                        style: 'border-top:1px solid var(--anas-line,#dfe3e8);padding:5px 4px;',
                        html: ''
                    },
                    {
                        xtype: 'component',
                        itemId: 'lunSessions',
                        cls: 'anas-iscsi-lun-sessions',
                        height: 110,
                        scrollable: true,
                        style: 'border-top:1px solid var(--anas-line,#dfe3e8);',
                        html: ''
                    }
                ],
                buttons: [{
                    text: t('Close'),
                    handler: function () {
                        win.close();
                    }
                }],
                listeners: {
                    close: function (w) {
                        stopSessionPoll(w);
                        loadTargets(view, node, true);
                    },
                    destroy: function (w) {
                        stopSessionPoll(w);
                    }
                }
            });
        } catch (e) {
            ANAS.warn('iscsi LUNs window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        loadLuns(win, node, iqn);
        startSessionPoll(win, node, iqn);
        return win;
    }

    // ---- Add LUN dialog ----------------------------------------------------

    function openAddLunDialog(lunsWin, view, node, iqn) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-iscsi-lun',
                title: t('Add LUN'),
                modal: true,
                width: 640,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 190 },
                    items: [
                        {
                            xtype: 'textfield',
                            itemId: 'lunName',
                            cls: 'anas-fld-lun-name',
                            fieldLabel: t('LUN name'),
                            allowBlank: false,
                            emptyText: 'vmdisk1'
                        },
                        {
                            xtype: 'component',
                            margin: '0 0 8 0',
                            style: 'color:gray;font-size:11px;',
                            html: enc(t('This name is the SCSI model string the initiator sees — it shows up as '
                                + 'lsblk MODEL on the other host and is part of the disk\'s VPD identity. '
                                + 'A standard INQUIRY shows the first 16 characters. Pick something a person '
                                + 'reading it on the initiator would recognise.'))
                        },
                        {
                            xtype: 'radiogroup',
                            itemId: 'kindGroup',
                            cls: 'anas-fld-lun-kind',
                            fieldLabel: t('Backed by'),
                            columns: 1,
                            vertical: true,
                            items: [
                                { boxLabel: t('An existing ZFS volume (zvol)'), name: 'lunKind', inputValue: 'zvol', checked: true },
                                { boxLabel: t('A new raw image file on a dataset or AHR pool'), name: 'lunKind', inputValue: 'file' }
                            ],
                            listeners: {
                                change: function (grp) {
                                    try {
                                        applyKind(grp.up('#form'));
                                    } catch (e) {
                                        // non-fatal
                                    }
                                }
                            }
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'zvolPicker',
                            cls: 'anas-fld-lun-zvol',
                            fieldLabel: t('ZFS volume'),
                            queryMode: 'local',
                            editable: true,
                            displayField: 'label',
                            valueField: 'name',
                            store: Ext.create('Ext.data.Store', { fields: ['name', 'label'], data: [] }),
                            emptyText: t('pool/volume')
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'filePicker',
                            cls: 'anas-fld-lun-dataset',
                            fieldLabel: t('Dataset or AHR pool'),
                            hidden: true,
                            disabled: true,
                            queryMode: 'local',
                            editable: true,
                            displayField: 'label',
                            valueField: 'name',
                            store: Ext.create('Ext.data.Store', { fields: ['name', 'label'], data: [] }),
                            emptyText: t('pool/dataset')
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'size',
                            cls: 'anas-fld-lun-size',
                            fieldLabel: t('Image size'),
                            hidden: true,
                            disabled: true,
                            minValue: 1,
                            value: 32
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'unit',
                            cls: 'anas-fld-lun-unit',
                            fieldLabel: t('Size unit'),
                            hidden: true,
                            disabled: true,
                            store: Ext.create('Ext.data.Store', { fields: ['value', 'label'], data: SIZE_UNITS.slice() }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: 1073741824
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'blockSize',
                            cls: 'anas-fld-lun-blocksize',
                            fieldLabel: t('Logical block size'),
                            store: Ext.create('Ext.data.Store', { fields: ['value', 'label'], data: BLOCK_SIZES.slice() }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: ''
                        },
                        {
                            xtype: 'component',
                            itemId: 'lunAttrSummary',
                            margin: '8 0 0 0',
                            style: 'color:gray;font-size:11px;',
                            html: ''
                        }
                    ]
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        }
                    },
                    {
                        text: t('Add LUN'),
                        cls: 'anas-btn-iscsi-lun-submit',
                        handler: function () {
                            try {
                                submitAddLun(win, lunsWin, view, node, iqn);
                            } catch (e) {
                                ANAS.warn('add LUN submit failed: ' + ANAS.errText(e));
                            }
                        }
                    }
                ]
            });
        } catch (e) {
            ANAS.warn('add LUN window failed: ' + ANAS.errText(e));
            return;
        }

        applyKind(win.down('#form'));
        loadBackingChoices(node, win);
        win.show();
        return win;
    }

    // Show only the fields the chosen kind uses, and DISABLE the hidden ones so a
    // stale value cannot be read back on submit.
    function applyKind(form) {
        var kind = kindOf(form);
        var file = kind === 'file';
        var set = function (sel, visible) {
            var f = form.down(sel);
            if (!f) {
                return;
            }
            f.setHidden(!visible);
            f.setDisabled(!visible);
        };
        set('#zvolPicker', !file);
        set('#filePicker', file);
        set('#size', file);
        set('#unit', file);
        try {
            form.down('#lunAttrSummary').update(attrSummaryHtml(file));
        } catch (e) {
            // non-fatal
        }
    }

    function kindOf(scope) {
        try {
            var g = scope.down('#kindGroup');
            var v = g && g.getValue();
            return (v && v.lunKind === 'file') ? 'file' : 'zvol';
        } catch (e) {
            return 'zvol';
        }
    }

    // The attributes ANAS sets, stated rather than hidden — including the one
    // honest caveat about image-file reclaim.
    function attrSummaryHtml(isFile) {
        var lines = [
            t('ANAS sets on every LUN it creates:'),
            '• ' + t('Thin reclaim on (emulate_tpu, emulate_tpws) with a raised UNMAP limit — LIO ships both off.'),
            '• ' + t('Write-through, not write-back. LIO ships an image file write-back, which loses '
                + 'acknowledged writes on a crash.'),
            '• ' + t('A generated unit serial that survives every recreate — initiators and PVE volids key on it.')
        ];
        if (isFile) {
            lines.push('• ' + t('An image file only reclaims when the initiator issues a real UNMAP. '
                + 'Linux\'s default discard path is rejected by LIO for this backend, so plain blkdiscard '
                + 'will fail. A zvol reclaims out of the box.'));
            lines.push('• ' + t('The image size is fixed at creation: growing it later recreates the '
                + 'backstore with the same identity.'));
        }
        return enc(lines.join('\n')).replace(/\n/g, '<br>');
    }

    /**
     * Fill the two backing pickers.
     *
     * zvols come from `/v1/pools/:name/datasets` filtered to `type: volume` and
     * to volumes ANAS manages — PVE's own pools and its `vm-*`/`base-*`/`subvol-*`
     * guest volumes are never candidates, the same hands-off rule the Datasets
     * tree applies. The dataset/AHR list is the same read, filesystems only, plus
     * the AHR pools (a file on the btrfs volume is AHR's only block object).
     */
    function loadBackingChoices(node, win) {
        ANAS.api.get(node, '/pools').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var pools = (res && res.data) || [];
            var pending = 0;
            var zvols = [];
            var dirs = [];
            var i;
            for (i = 0; i < pools.length; i++) {
                var p = pools[i] || {};
                if (isArray(p.pveStorages) && p.pveStorages.length) {
                    continue; // PVE territory — hands-off
                }
                pending++;
                collectFromPool(node, win, p.name, zvols, dirs, function () {
                    pending--;
                    if (pending <= 0) {
                        applyBackingStores(win, zvols, dirs);
                    }
                });
            }
            // AHR pools are a second, independent source for the image-file list.
            ANAS.api.get(node, '/ahr/pools').then(function (ares) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                var apools = (ares && ares.data) || [];
                for (var k = 0; k < apools.length; k++) {
                    var a = apools[k] || {};
                    if (a.name) {
                        dirs.push({ name: a.name, label: a.name + ' (' + t('AHR pool') + ')' });
                    }
                }
                if (pending <= 0) {
                    applyBackingStores(win, zvols, dirs);
                }
            }, function () {
                if (pending <= 0) {
                    applyBackingStores(win, zvols, dirs);
                }
            });
            if (!pools.length) {
                applyBackingStores(win, zvols, dirs);
            }
        }, function (err) {
            ANAS.warn('iscsi backing choices failed: ' + ANAS.errText(err));
        });
    }

    // PVE's guest-volume naming, the same three prefixes the daemon refuses.
    var PVE_GUEST_RE = /^(?:vm|base|subvol)-\d+-disk-\d+$/;

    function collectFromPool(node, win, pool, zvols, dirs, done) {
        if (!pool) {
            done();
            return;
        }
        ANAS.api.get(node, '/pools/' + encodeURIComponent(pool) + '/datasets').then(function (res) {
            if (win.destroyed || win.destroying) {
                done();
                return;
            }
            var list = (res && res.data) || [];
            for (var i = 0; i < list.length; i++) {
                var d = list[i] || {};
                var leaf = ('' + (d.name || '')).split('/').pop();
                if (d.type === 'volume') {
                    if (PVE_GUEST_RE.test(leaf)) {
                        continue; // a PVE guest disk is never a candidate
                    }
                    zvols.push({
                        name: d.name,
                        label: d.name + (d.volsize ? ' (' + fmtBytes(d.volsize) + ')' : '')
                    });
                } else if (d.mountpoint && d.mountpoint !== 'none' && d.mountpoint !== '-') {
                    dirs.push({ name: d.name, label: d.name + ' → ' + d.mountpoint });
                }
            }
            done();
        }, function () {
            done();
        });
    }

    function applyBackingStores(win, zvols, dirs) {
        try {
            if (win.destroyed || win.destroying) {
                return;
            }
            win.down('#zvolPicker').setStore(Ext.create('Ext.data.Store', {
                fields: ['name', 'label'], data: zvols
            }));
            win.down('#filePicker').setStore(Ext.create('Ext.data.Store', {
                fields: ['name', 'label'], data: dirs
            }));
        } catch (e) {
            // non-fatal — both fields stay free-text
        }
    }

    function submitAddLun(win, lunsWin, view, node, iqn) {
        var name = textOf(win, '#lunName');
        if (!name) {
            ANAS.alertMsg('Invalid input', t('Enter a LUN name.'));
            return;
        }
        var kind = kindOf(win);
        var body = { name: name, kind: kind };

        if (kind === 'zvol') {
            var vol = textOf(win, '#zvolPicker');
            if (!vol) {
                ANAS.alertMsg('Invalid input', t('Pick the ZFS volume to export.'));
                return;
            }
            body.backing = vol;
        } else {
            var where = textOf(win, '#filePicker');
            if (!where) {
                ANAS.alertMsg('Invalid input', t('Pick the dataset or AHR pool the image will live on.'));
                return;
            }
            var amount = Number(valOf(win, '#size'));
            var unit = Number(valOf(win, '#unit')) || SIZE_UNITS[0].value;
            if (!amount || isNaN(amount) || amount <= 0) {
                ANAS.alertMsg('Invalid input', t('Enter the image size.'));
                return;
            }
            body.backing = where;
            body.size = Math.round(amount * unit);
        }

        // A blank block size sends NO key — LIO then applies its own 512, which
        // is the honest choice for a create-only property.
        var bs = valOf(win, '#blockSize');
        if (bs !== '' && bs !== undefined && bs !== null) {
            body.blockSize = Number(bs);
        }

        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/iscsi/targets/' + encIqn(iqn) + '/luns',
            body: body,
            view: win,
            failTitle: 'Add LUN failed',
            successMsg: t('LUN added') + ': ' + name,
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadLuns(lunsWin, node, iqn);
                loadTargets(view, node, true);
            }
        });
    }

    // ---- Resize LUN dialog -------------------------------------------------

    function splitSize(bytes) {
        var n = Number(bytes) || 0;
        for (var i = SIZE_UNITS.length - 1; i >= 0; i--) {
            var u = SIZE_UNITS[i].value;
            if (n >= u && n % u === 0) {
                return { amount: n / u, unit: u };
            }
        }
        return { amount: n / SIZE_UNITS[0].value, unit: SIZE_UNITS[0].value };
    }

    function openResizeLunDialog(lunsWin, view, node, iqn, rec) {
        if (!rec) {
            return;
        }
        var current = Number(rec.get('size')) || 0;
        if (!current) {
            ANAS.alertMsg('Cannot resize', t('This LUN\'s current size is unknown, so a grow cannot be checked against it.'));
            return;
        }
        var isFile = rec.get('kind') === 'file';
        var liveNow = (rec.get('connectedInitiators') || []).length;
        var split = splitSize(current);
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-iscsi-lun-resize',
                title: t('Resize LUN') + ': ' + rec.get('name'),
                modal: true,
                width: 560,
                layout: 'fit',
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 180 },
                    items: [
                        {
                            xtype: 'displayfield',
                            itemId: 'currentSize',
                            fieldLabel: t('Current size'),
                            value: enc(fmtBytes(current))
                        },
                        {
                            xtype: 'displayfield',
                            itemId: 'currentSerial',
                            fieldLabel: t('Unit serial'),
                            value: enc(rec.get('serial') || t('(unknown)'))
                        },
                        {
                            xtype: 'numberfield',
                            itemId: 'size',
                            cls: 'anas-fld-lun-resize-size',
                            fieldLabel: t('New size'),
                            minValue: 0,
                            value: split.amount
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'unit',
                            cls: 'anas-fld-lun-resize-unit',
                            fieldLabel: t('Size unit'),
                            store: Ext.create('Ext.data.Store', { fields: ['value', 'label'], data: SIZE_UNITS.slice() }),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            value: split.unit
                        },
                        {
                            xtype: 'component',
                            itemId: 'resizeNote',
                            margin: '6 0 0 0',
                            style: 'color:gray;font-size:11px;',
                            html: enc(isFile
                                ? t('An image-file LUN can only grow, and it cannot grow in place: its size is '
                                    + 'fixed at creation. ANAS deletes the backstore, grows the file and recreates '
                                    + 'it with the SAME unit serial and the SAME attributes, re-mapped at the same '
                                    + 'LUN number — so the initiator sees the same disk, larger. Without that '
                                    + 'replay it would see a different disk.')
                                : t('A ZFS volume grows live: nothing on the iSCSI side changes and the initiator '
                                    + 'sees the new size after a rescan. Shrinking is refused — ZFS truncates '
                                    + 'silently, even under a live session.')
                                + (liveNow
                                    ? ' ' + t('' + liveNow + (liveNow === 1 ? ' initiator is' : ' initiators are')
                                        + ' logged in now: the grow is allowed and safe, but each one keeps showing '
                                        + 'the OLD size until it rescans (open-iscsi: iscsiadm -m node -R), and the '
                                        + 'filesystem on top has to be grown separately.')
                                    : ''))
                        }
                    ]
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        }
                    },
                    {
                        text: t('Resize'),
                        cls: 'anas-btn-iscsi-lun-resize-submit',
                        handler: function () {
                            try {
                                submitResizeLun(win, lunsWin, view, node, iqn, rec, current);
                            } catch (e) {
                                ANAS.warn('resize LUN submit failed: ' + ANAS.errText(e));
                            }
                        }
                    }
                ]
            });
        } catch (e) {
            ANAS.warn('resize LUN window failed: ' + ANAS.errText(e));
            return;
        }
        win.show();
        return win;
    }

    function submitResizeLun(win, lunsWin, view, node, iqn, rec, current) {
        var amount = Number(valOf(win, '#size'));
        var unit = Number(valOf(win, '#unit')) || SIZE_UNITS[0].value;
        if (!amount || isNaN(amount) || amount <= 0) {
            ANAS.alertMsg('Invalid input', t('Enter a new size.'));
            return;
        }
        var next = Math.round(amount * unit);
        // An UNTOUCHED edit sends nothing and does not reach the daemon.
        if (next === current) {
            ANAS.toast(t('No changes to save'));
            win.close();
            return;
        }
        if (next < current) {
            ANAS.alertMsg('Cannot shrink', t('A LUN can only grow.') + ' '
                + rec.get('name') + ' ' + t('is') + ' ' + fmtBytes(current) + '; '
                + fmtBytes(next) + ' ' + t('is smaller — anything written past the new end would be gone, '
                    + 'and neither ZFS nor LIO would warn.'));
            return;
        }

        ANAS.runJob({
            node: node,
            method: 'put',
            path: '/iscsi/targets/' + encIqn(iqn) + '/luns/' + encodeURIComponent(rec.get('index')),
            body: { size: next },
            view: win,
            failTitle: 'Resize failed',
            successMsg: t('LUN resized') + ': ' + rec.get('name') + ' → ' + fmtBytes(next),
            onComplete: function () {
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
                loadLuns(lunsWin, node, iqn);
                loadTargets(view, node, true);
            }
        });
    }

    // ---- Restore a LUN from a PBS backup (story backup2.7) -----------------
    //
    // WHOLE-IMAGE, by nature: a block image has no "restore these files". The
    // dialog's whole job is to let the operator name a point in time and then
    // prove, before the button is live, that the image is EXACTLY the size of
    // the LUN — because a mismatch is silently destructive below ANAS (a larger
    // image writes until the device is full and leaves it half-overwritten; a
    // smaller one succeeds and leaves stale bytes past its end).
    //
    // The reads are backup2.5's, in its two-call shape: `GET /v1/backup/repos/
    // :name/groups?ns=` for the namespace's GROUPS, then the same endpoint with
    // `?group=` for that group's POINTS IN TIME. Nothing that is not an `.img`
    // archive is ever offered, and the filter keys on backup2.5's classified
    // `kind`, never on the filename.

    // Every stored file backup2.5 classified as a block image, keyed by the
    // ARCHIVE ARGUMENT pbc takes (`vol.img.fidx` → `vol.img`).
    //
    // The match is on the KIND, never the name: a tree archive that happens to
    // be called `something.img.pxar` is a pxar, and handing it to a block
    // restore would earn a refusal at best and a wrong disk at worst.
    function restoreArchivesOf(snapshot) {
        var out = [];
        var files = (snapshot && isArray(snapshot.files)) ? snapshot.files : [];
        for (var i = 0; i < files.length; i++) {
            if (files[i] && files[i].kind === 'img' && files[i].archive) {
                out.push({
                    archive: files[i].archive,
                    size: (typeof files[i].size === 'number') ? files[i].size : null
                });
            }
        }
        return out;
    }

    // A GROUP's `files` are the classified filenames it holds (backup2.5), so a
    // group with no image can be dropped before its snapshots are ever fetched.
    function groupHasImage(group) {
        var files = (group && isArray(group.files)) ? group.files : [];
        for (var i = 0; i < files.length; i++) {
            if (files[i] && files[i].kind === 'img') {
                return true;
            }
        }
        return false;
    }

    // backup2.5's reads answer 200 with a VERDICT: a local fault is a 4xx, but a
    // PBS-side one is a diagnosis the screen shows verbatim rather than a bare
    // failure. Returns the detail to show, or '' when the read succeeded.
    function readVerdictDetail(data) {
        if (!data || !data.verdict || data.verdict === 'ok') {
            return '';
        }
        return '' + (data.detail || data.verdict);
    }

    function comboStore(fields, rows) {
        return Ext.create('Ext.data.Store', { fields: fields, data: rows || [] });
    }

    function setComboRows(win, sel, rows, selectFirst) {
        var c;
        try {
            c = win.down(sel);
        } catch (e) {
            return;
        }
        if (!c) {
            return;
        }
        c.getStore().loadData(rows || []);
        if (selectFirst && rows && rows.length) {
            c.setValue(rows[0][c.valueField || 'value']);
        } else {
            c.setValue(null);
        }
    }

    function openRestoreLunDialog(lunsWin, view, node, iqn, rec) {
        if (!rec) {
            return;
        }
        var lunSize = Number(rec.get('size')) || 0;
        if (!lunSize) {
            ANAS.alertMsg('Cannot restore', t('This LUN\'s size is unknown, so ANAS cannot prove a backup image '
                + 'is exactly its size. A size mismatch is silently destructive, so the restore is refused.'));
            return;
        }
        var lunIndex = rec.get('index');
        var backing = '' + (rec.get('backingPath') || '');

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-win-lun-restore',
                title: t('Restore LUN from backup') + ': ' + rec.get('name'),
                modal: true,
                width: 720,
                layout: 'fit',
                anasSnapshots: [],
                items: [{
                    xtype: 'form',
                    itemId: 'form',
                    bodyPadding: 12,
                    border: false,
                    defaults: { anchor: '100%', labelWidth: 190 },
                    items: [
                        {
                            xtype: 'displayfield',
                            itemId: 'restoreTargetPath',
                            fieldLabel: t('Restoring onto'),
                            value: enc(backing) + ' (' + enc(t('LUN')) + ' ' + enc(lunIndex) + ')'
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'repo',
                            cls: 'anas-fld-restore-repo',
                            fieldLabel: t('Repository'),
                            store: comboStore(['value', 'label', 'namespace'], []),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            emptyText: t('(loading…)')
                        },
                        {
                            xtype: 'textfield',
                            itemId: 'ns',
                            cls: 'anas-fld-restore-ns',
                            fieldLabel: t('Namespace'),
                            emptyText: t('(the repository root)')
                        },
                        {
                            xtype: 'button',
                            itemId: 'loadGroups',
                            cls: 'anas-btn-restore-load',
                            text: t('List backups'),
                            width: 140,
                            margin: '0 0 8 0',
                            handler: function (btn) {
                                loadRestoreGroups(btn.up('window'), node, lunSize);
                            }
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'group',
                            cls: 'anas-fld-restore-group',
                            fieldLabel: t('Backup group'),
                            store: comboStore(['value', 'label'], []),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            emptyText: t('(list backups first)'),
                            listeners: {
                                change: function (c) {
                                    loadRestoreSnapshots(c.up('window'), node, lunSize);
                                }
                            }
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'snapshot',
                            cls: 'anas-fld-restore-snapshot',
                            fieldLabel: t('Point in time'),
                            store: comboStore(['value', 'label'], []),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            listeners: {
                                change: function (c) {
                                    onRestoreSnapshotChange(c.up('window'), lunSize);
                                }
                            }
                        },
                        {
                            xtype: 'combobox',
                            itemId: 'archive',
                            cls: 'anas-fld-restore-archive',
                            fieldLabel: t('Image archive'),
                            store: comboStore(['value', 'label', 'size'], []),
                            valueField: 'value',
                            displayField: 'label',
                            queryMode: 'local',
                            editable: false,
                            forceSelection: true,
                            emptyText: t('(no .img archive in this snapshot)'),
                            listeners: {
                                change: function (c) {
                                    updateRestoreSizes(c.up('window'), lunSize);
                                }
                            }
                        },
                        {
                            xtype: 'displayfield',
                            itemId: 'lunSize',
                            fieldLabel: t('LUN size'),
                            value: enc(fmtBytes(lunSize)) + ' (' + enc('' + lunSize) + ' ' + enc(t('bytes')) + ')'
                        },
                        {
                            xtype: 'displayfield',
                            itemId: 'imageSize',
                            cls: 'anas-fld-restore-image-size',
                            fieldLabel: t('Image size'),
                            value: '<span style="color:gray;">&mdash;</span>'
                        },
                        {
                            xtype: 'component',
                            itemId: 'sizeVerdict',
                            cls: 'anas-restore-size-verdict',
                            margin: '4 0 0 0',
                            html: ''
                        },
                        {
                            xtype: 'component',
                            itemId: 'restoreNote',
                            margin: '8 0 0 0',
                            style: 'color:gray;font-size:11px;',
                            html: enc(t('A block image is restored WHOLE — there is no "these files". '
                                + 'The whole target goes offline for the duration (LIO\'s enable flag lives on '
                                + 'the target portal group, not the LUN), every session drops and no initiator '
                                + 'can log back in until it finishes. The image is streamed straight onto ')) + enc(backing)
                                + enc(t('; the unit serial and the backstore attributes are untouched, so the '
                                    + 'initiator sees the same disk with the backed-up contents.'))
                        }
                    ]
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        handler: function () {
                            win.close();
                        }
                    },
                    {
                        text: t('Restore'),
                        itemId: 'restoreSubmit',
                        cls: 'anas-btn-lun-restore-submit',
                        disabled: true,
                        handler: function () {
                            try {
                                submitRestoreLun(win, lunsWin, view, node, iqn, rec, lunSize);
                            } catch (e) {
                                ANAS.warn('restore LUN submit failed: ' + ANAS.errText(e));
                            }
                        }
                    }
                ]
            });
        } catch (e) {
            ANAS.warn('restore LUN window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        loadRestoreRepos(win, node);
        return win;
    }

    // Both repository tiers, exactly as the backup wizard sees them: ANAS-
    // registered AND PVE-discovered (`pve:<id>`). A repo with no stored
    // credential is still listed — the daemon's refusal explains it better than
    // a silently missing row would.
    function loadRestoreRepos(win, node) {
        ANAS.api.get(node, '/backup/repos').then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var list = (res && res.data && isArray(res.data.repos)) ? res.data.repos : [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                var r = list[i];
                rows.push({
                    value: r.name,
                    label: r.name + ' — ' + (r.host || '') + ':' + (r.datastore || '')
                        + (r.source === 'pve' ? ' (' + t('from Proxmox storage') + ')' : ''),
                    namespace: r.namespace || ''
                });
            }
            var combo = win.down('#repo');
            combo.getStore().loadData(rows);
            if (rows.length) {
                combo.setValue(rows[0].value);
                // Zero re-entry: a repository that already carries a namespace
                // pre-fills it, the way the backup task path does.
                if (rows[0].namespace) {
                    win.down('#ns').setValue(rows[0].namespace);
                }
            }
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.warn('restore: repositories load failed: ' + ANAS.errText(err));
        });
    }

    // CALL 1 of 2: the namespace's groups. A group carries its classified
    // filenames, so the ones that hold no image are dropped here — before a
    // second call is ever made for their points in time.
    function loadRestoreGroups(win, node, lunSize) {
        var repo = textOf(win, '#repo');
        if (!repo) {
            ANAS.alertMsg('Pick a repository', t('Choose the repository holding the backup first.'));
            return;
        }
        var ns = textOf(win, '#ns');
        var path = '/backup/repos/' + encodeURIComponent(repo) + '/groups'
            + (ns ? '?ns=' + encodeURIComponent(ns) : '');
        win.anasSnapshots = [];
        setComboRows(win, '#snapshot', [], false);
        setComboRows(win, '#archive', [], false);
        ANAS.api.get(node, path).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var data = (res && res.data) || {};
            var detail = readVerdictDetail(data);
            if (detail) {
                setComboRows(win, '#group', [], false);
                updateRestoreSizes(win, lunSize);
                ANAS.alertMsg('Could not list backups', detail);
                return;
            }
            var groups = isArray(data.groups) ? data.groups : [];
            var rows = [];
            for (var i = 0; i < groups.length; i++) {
                // A pxar group cannot restore a block device, and offering it
                // would only earn a refusal three clicks later.
                if (!groupHasImage(groups[i])) {
                    continue;
                }
                rows.push({
                    value: groups[i].group,
                    label: groups[i].group
                        + (groups[i].lastBackupIso ? ' — ' + t('last') + ' ' + groups[i].lastBackupIso : '')
                });
            }
            setComboRows(win, '#group', rows, rows.length === 1);
            if (!rows.length) {
                ANAS.alertMsg('No image backups', t('No backup group in this repository and namespace holds an '
                    + '.img archive. A block image can only be restored from an image backup.'));
            }
            updateRestoreSizes(win, lunSize);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.alertMsg('Could not list backups', ANAS.errText(err));
        });
    }

    // CALL 2 of 2: the chosen group's points in time. Same endpoint, `?group=`,
    // and the snapshots come back in the SAME shape the task endpoint uses —
    // one picker, one parser, two doors.
    function loadRestoreSnapshots(win, node, lunSize) {
        var repo = textOf(win, '#repo');
        var group = textOf(win, '#group');
        win.anasSnapshots = [];
        setComboRows(win, '#snapshot', [], false);
        setComboRows(win, '#archive', [], false);
        if (!repo || !group) {
            updateRestoreSizes(win, lunSize);
            return;
        }
        var ns = textOf(win, '#ns');
        var path = '/backup/repos/' + encodeURIComponent(repo) + '/groups?group=' + encodeURIComponent(group)
            + (ns ? '&ns=' + encodeURIComponent(ns) : '');
        ANAS.api.get(node, path).then(function (res) {
            if (win.destroyed || win.destroying) {
                return;
            }
            var data = (res && res.data) || {};
            var detail = readVerdictDetail(data);
            if (detail) {
                updateRestoreSizes(win, lunSize);
                ANAS.alertMsg('Could not list points in time', detail);
                return;
            }
            var snaps = isArray(data.snapshots) ? data.snapshots : [];
            var keep = [];
            var rows = [];
            for (var i = 0; i < snaps.length; i++) {
                if (!restoreArchivesOf(snaps[i]).length) {
                    continue;
                }
                keep.push(snaps[i]);
                // The FULL <type>/<id>/<RFC3339> id is the value, ALWAYS: a bare
                // group path is not an error to the client, it silently restores
                // the LATEST snapshot — a different operation from the one picked.
                rows.push({
                    value: snaps[i].snapshot,
                    label: snaps[i].backupTimeIso || snaps[i].snapshot
                });
            }
            win.anasSnapshots = keep;
            setComboRows(win, '#snapshot', rows, rows.length > 0);
            updateRestoreSizes(win, lunSize);
        }, function (err) {
            if (win.destroyed || win.destroying) {
                return;
            }
            ANAS.alertMsg('Could not list points in time', ANAS.errText(err));
        });
    }

    function selectedSnapshot(win) {
        var path = textOf(win, '#snapshot');
        var snaps = isArray(win.anasSnapshots) ? win.anasSnapshots : [];
        for (var i = 0; i < snaps.length; i++) {
            if (snaps[i].snapshot === path) {
                return snaps[i];
            }
        }
        return null;
    }

    function onRestoreSnapshotChange(win, lunSize) {
        var snap = selectedSnapshot(win);
        var archives = snap ? restoreArchivesOf(snap) : [];
        var rows = [];
        for (var i = 0; i < archives.length; i++) {
            rows.push({
                value: archives[i].archive,
                label: archives[i].archive
                    + (archives[i].size === null ? '' : ' — ' + fmtBytes(archives[i].size)),
                size: archives[i].size
            });
        }
        setComboRows(win, '#archive', rows, rows.length === 1);
        updateRestoreSizes(win, lunSize);
    }

    function selectedArchiveSize(win) {
        var snap = selectedSnapshot(win);
        var name = textOf(win, '#archive');
        var archives = snap ? restoreArchivesOf(snap) : [];
        for (var i = 0; i < archives.length; i++) {
            if (archives[i].archive === name) {
                return archives[i].size;
            }
        }
        return null;
    }

    // THE gate. The daemon refuses a mismatch too (safety lives in the API), but
    // a red field and a dead button is the difference between a control that
    // works and one that lets you press it and then explains why not.
    function updateRestoreSizes(win, lunSize) {
        var submit;
        try {
            submit = win.down('#restoreSubmit');
        } catch (e) {
            submit = null;
        }
        var verdict = win.down('#sizeVerdict');
        var sizeField = win.down('#imageSize');
        var size = selectedArchiveSize(win);
        var chosen = textOf(win, '#snapshot') && textOf(win, '#archive');

        if (sizeField) {
            sizeField.setValue(size === null || size === undefined
                ? '<span style="color:gray;">&mdash;</span>'
                : enc(fmtBytes(size)) + ' (' + enc('' + size) + ' ' + enc(t('bytes')) + ')');
        }

        var ok = false;
        var html = '';
        if (!chosen) {
            html = '';
        } else if (size === null || size === undefined) {
            html = '<span style="color:var(--anas-bad,#c0392b);">'
                + enc(t('This archive\'s size is not in the snapshot manifest, so ANAS cannot prove it matches '
                    + 'the LUN. The restore is refused: a mismatch is silently destructive.')) + '</span>';
        } else if (size === lunSize) {
            ok = true;
            html = '<span style="color:var(--anas-good,#2e7d32);">'
                + enc(t('The image is exactly the size of this LUN.')) + '</span>';
        } else {
            html = '<span style="color:var(--anas-bad,#c0392b);">'
                + enc(size > lunSize
                    ? t('The image is LARGER than this LUN. Restoring it would write until the device is full '
                        + 'and leave it half-overwritten — the old contents gone, the new ones incomplete.')
                    : t('The image is SMALLER than this LUN. Restoring it would succeed and leave stale bytes '
                        + 'from the old contents past the end of the restored image.'))
                + ' ' + enc(fmtBytes(size)) + ' ' + enc(t('vs')) + ' ' + enc(fmtBytes(lunSize)) + '.</span>';
        }
        if (verdict) {
            verdict.update(html);
        }
        if (submit) {
            submit.setDisabled(!ok);
        }
    }

    function submitRestoreLun(win, lunsWin, view, node, iqn, rec, lunSize) {
        var repo = textOf(win, '#repo');
        var ns = textOf(win, '#ns');
        var snapshot = textOf(win, '#snapshot');
        var archive = textOf(win, '#archive');
        var size = selectedArchiveSize(win);
        if (!repo || !snapshot || !archive) {
            ANAS.alertMsg('Incomplete', t('Choose a repository, a point in time and an image archive.'));
            return;
        }
        // Belt and braces: the button is already dead on a mismatch, and the
        // daemon refuses one too. Nothing may reach the wire on a mismatch.
        if (size !== lunSize) {
            ANAS.alertMsg('Size mismatch', t('The image and the LUN are not the same size, so the restore is '
                + 'refused. Restore this image onto a target of exactly its own size.'));
            return;
        }

        var body = { kind: 'image', repo: repo, snapshot: snapshot, archive: archive,
            lun: { targetIqn: iqn, index: rec.get('index') } };
        if (ns) {
            body.ns = ns;
        }

        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/backup/restore',
            body: body,
            view: win,
            confirmWindow: true,
            confirmTitle: 'Restore LUN from backup',
            confirmIntro: enc(t('Restoring')) + ' ' + enc(archive) + ' ' + enc(t('from')) + ' ' + enc(snapshot)
                + ' ' + enc(t('onto')) + ' ' + enc(rec.get('backingPath') || '') + '.',
            confirmButtonText: t('Restore'),
            failTitle: 'Restore failed',
            successMsg: t('LUN restored') + ': ' + rec.get('name'),
            onSubmitted: function () {
                // A whole image can take hours; the dialog has nothing left to
                // do once the daemon has accepted the job.
                if (!win.destroyed && !win.destroying) {
                    win.close();
                }
            },
            onComplete: function () {
                loadLuns(lunsWin, node, iqn);
                loadTargets(view, node, true);
            },
            onFailed: function () {
                loadLuns(lunsWin, node, iqn);
                loadTargets(view, node, true);
            }
        });
    }

    // ---- Delete LUN --------------------------------------------------------

    function deleteLun(lunsWin, view, node, iqn, rec) {
        if (!rec) {
            return;
        }
        var backing = rec.get('backingPath');
        var kind = rec.get('kind');
        ANAS.confirmAndRun({
            node: node,
            method: 'del',
            path: '/iscsi/targets/' + encIqn(iqn) + '/luns/' + encodeURIComponent(rec.get('index')),
            view: lunsWin,
            confirmWindow: true,
            confirmTitle: 'Delete LUN',
            confirmIntro: t('Unmapping LUN') + ' ' + enc(rec.get('index')) + ' (' + enc(rec.get('name')) + '). '
                + t('The backing object is kept unless you tick the box:'),
            confirmButtonText: t('Delete'),
            // The destructive half is a deliberate second choice, not a default.
            extraItems: [{
                xtype: 'checkbox',
                itemId: 'destroyBacking',
                cls: 'anas-chk-destroy-backing',
                boxLabel: t('Also destroy') + ' ' + enc(backing || '')
                    + (kind === 'zvol' ? ' (' + t('the volume and all its snapshots') + ')' : ''),
                checked: false
            }],
            mapConfirm: function (w) {
                try {
                    return w.down('#destroyBacking').getValue()
                        ? { pathSuffix: '?destroyBacking=true' }
                        : {};
                } catch (e) {
                    return {};
                }
            },
            failTitle: 'Delete failed',
            successMsg: t('LUN deleted') + ': ' + rec.get('name'),
            onComplete: function () {
                loadLuns(lunsWin, node, iqn);
                loadTargets(view, node, true);
            }
        });
    }

    // ---- Target edit entry (needs the FULL detail) -------------------------

    function openTargetEdit(view, node, rec) {
        if (!rec) {
            return;
        }
        // Pre-fill must reflect the ENTRY exactly, so the edit dialog opens on
        // the detail read, never on the grid row's summary.
        ANAS.api.get(node, '/iscsi/targets/' + encIqn(rec.get('iqn'))).then(function (res) {
            var detail = res && res.data;
            if (!detail) {
                ANAS.alertMsg('Edit failed', t('Could not read this target.'));
                return;
            }
            openTargetDialog(view, node, detail);
        }, function (err) {
            // A dialog that cannot read what it is editing must not open on
            // defaults and then save them over the real entry.
            ANAS.alertMsg('Edit failed', ANAS.errText(err));
        });
    }

    // ---- View --------------------------------------------------------------

    function iscsiView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'iqn', 'name', 'ownership', 'ownershipReason', 'ownershipDetail',
                { name: 'tpgTag', type: 'auto' },
                { name: 'enabled', type: 'auto' },
                { name: 'portals', type: 'auto' },
                { name: 'lunCount', type: 'auto' },
                { name: 'aclCount', type: 'auto' },
                { name: 'sessionCount', type: 'auto' },
                { name: 'security', type: 'auto' },
                { name: 'present', type: 'auto' },
                { name: 'persisted', type: 'auto' },
                { name: 'missingLunCount', type: 'auto' },
                { name: 'portalsWithoutInterfaceCount', type: 'auto' },
                { name: 'raw', type: 'auto' }
            ],
            data: [],
            sorters: [{ property: 'iqn', direction: 'ASC' }]
        });

        var tbar = [
            {
                text: t('Reload'),
                cls: 'anas-btn-refresh anas-btn-iscsi-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    loadTargets(btn.up('#iscsiView'), node);
                }
            },
            {
                text: t('Create Target…'),
                itemId: 'iscsiCreate',
                cls: 'anas-btn-iscsi-create',
                iconCls: 'fa fa-plus',
                handler: function (btn) {
                    openTargetDialog(btn.up('#iscsiView'), node, null);
                }
            },
            '-',
            {
                text: t('Edit'),
                itemId: 'iscsiEdit',
                cls: 'anas-btn-iscsi-edit',
                iconCls: 'fa fa-pencil',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#iscsiView');
                    openTargetEdit(view, node, selectedTarget(gridOf(view)));
                }
            },
            {
                text: t('Disable'),
                itemId: 'iscsiToggle',
                cls: 'anas-btn-iscsi-toggle',
                iconCls: 'fa fa-ban',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#iscsiView');
                    toggleTarget(view, node, selectedTarget(gridOf(view)));
                }
            },
            {
                text: t('LUNs…'),
                itemId: 'iscsiLuns',
                cls: 'anas-btn-iscsi-luns',
                iconCls: 'fa fa-hdd-o',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#iscsiView');
                    openLunsWindow(view, node, selectedTarget(gridOf(view)));
                }
            },
            {
                text: t('Delete'),
                itemId: 'iscsiDelete',
                cls: 'anas-btn-iscsi-delete',
                iconCls: 'fa fa-trash',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#iscsiView');
                    deleteTarget(view, node, selectedTarget(gridOf(view)));
                }
            },
            '->',
            {
                // Node-level, not per-target: a restore hole is a property of
                // the boot, and one repair puts back every LUN whose backing
                // object is available again. Disabled — with the reason in the
                // tooltip — whenever there is nothing to do or the storage is
                // still missing.
                text: t('Repair'),
                itemId: 'iscsiRepair',
                cls: 'anas-btn-iscsi-repair',
                iconCls: 'fa fa-wrench',
                disabled: true,
                handler: function (btn) {
                    var view = btn.up('#iscsiView');
                    repairHoles(view, node);
                }
            }
        ];

        return {
            xtype: 'panel',
            itemId: 'iscsiView',
            cls: 'anas-view anas-view-iscsi',
            title: t('iSCSI'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    xtype: 'component',
                    itemId: 'iscsiEnvelope',
                    cls: 'anas-iscsi-envelope',
                    hidden: true,
                    html: ''
                },
                {
                    xtype: 'gridpanel',
                    itemId: 'iscsiGrid',
                    cls: 'anas-grid-iscsi',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No iSCSI targets on this node'),
                    viewConfig: {
                        getRowClass: function (record) {
                            try {
                                return record.get('ownership') === 'anas' ? '' : 'anas-iscsi-foreign-row';
                            } catch (e) {
                                return '';
                            }
                        }
                    },
                    columns: [
                        { text: t('Name'), dataIndex: 'name', width: 150, renderer: renderName },
                        { text: t('IQN'), dataIndex: 'iqn', flex: 2, minWidth: 260, renderer: renderIqn },
                        { text: t('Portals'), dataIndex: 'portals', flex: 1, minWidth: 170, sortable: false, menuDisabled: true, renderer: renderPortals },
                        { text: t('LUNs'), dataIndex: 'lunCount', width: 130, align: 'center', renderer: renderLunCount },
                        { text: t('Sessions'), dataIndex: 'sessionCount', width: 110, align: 'center', renderer: renderSessions },
                        { text: t('Auth'), dataIndex: 'security', width: 100, align: 'center', sortable: false, menuDisabled: true, renderer: renderAuth },
                        { text: t('State'), dataIndex: 'enabled', width: 110, align: 'center', renderer: renderEnabled },
                        { text: t('Managed by'), dataIndex: 'ownership', width: 110, align: 'center', menuDisabled: true, renderer: renderOwnership }
                    ],
                    tbar: ANAS.tbar(tbar),
                    listeners: {
                        selectionchange: function (selModel, selected) {
                            var grid = this;
                            if (grid.anasReloading && !(selected && selected.length)) {
                                return;
                            }
                            updateButtons(grid);
                        },
                        itemdblclick: function (grid, rec) {
                            if (!rec || rec.get('ownership') !== 'anas') {
                                return;
                            }
                            openTargetEdit(grid.up('#iscsiView'), node, rec);
                        }
                    }
                }
            ],
            listeners: {
                afterrender: function (view) {
                    loadTargets(view, node);
                },
                activate: function (view) {
                    loadTargets(view, node, true);
                }
            }
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['iscsi'] = {
        itemId: 'anas-iscsi',
        text: t('iSCSI'),
        iconCls: 'fa fa-hdd-o',
        factory: function (node) {
            try {
                return iscsiView(node);
            } catch (e) {
                ANAS.warn('iscsi view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        }
    };
})();
