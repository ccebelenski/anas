/*
 * ANAS — Proxmox VE web UI integration: core.
 *
 * Namespace (window.ANAS), fail-open helpers, small formatters, and the menu
 * injection machinery. This is the foundation every per-view file builds on.
 *
 * The panels follow the Ceph model: native ExtJS injected into pve-manager,
 * talking to the ANAS gateway on the same host (PVEAuthCookie flows
 * automatically — same host, cookies ignore ports). No iframe, no handoff.
 *
 * DESIGN CONTRACT — this file must FAIL OPEN. The PVE UI must never break
 * because of ANAS. Everything is try/catch-guarded and every ExtJS / PVE /
 * Proxmox internal we touch is feature-detected. Worst case: the ANAS section
 * simply does not appear, plus one console.warn.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    // View registry: per-view files assign ANAS.views['pools'] = { ... };
    // 90-register wires these into the node menu in a fixed order.
    if (!ANAS.views) {
        ANAS.views = {};
    }

    // Credential fields opt out of password-manager autofill (issue #23: a
    // username/secret pair in a dialog is exactly the shape managers fill in).
    // Spread into every credential field config: 'user' for the name side,
    // 'secret' for the password side ('new-password' is the one hint browsers
    // reliably honour on password inputs; bare 'off' is routinely ignored).
    ANAS.noAutofill = {
        user: { inputAttrTpl: 'autocomplete="off"' },
        secret: { inputAttrTpl: 'autocomplete="new-password"' },
    };

    // ---- Fail-open helpers -------------------------------------------------

    ANAS.warn = function (msg) {
        try {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[ANAS] ' + msg);
            }
        } catch (e) {
            // Nothing we can do — stay silent rather than break the page.
        }
    };

    ANAS.errText = function (e) {
        return (e && e.message) ? e.message : ('' + e);
    };

    // gettext when PVE provides it, identity otherwise.
    ANAS.t = function (str) {
        try {
            if (typeof gettext === 'function') {
                return gettext(str);
            }
        } catch (e) {
            // fall through
        }
        return str;
    };

    // HTML-encode for safe interpolation into markup. Prefers ExtJS's encoder
    // (matches PVE); on any failure falls back to escaping the four dangerous
    // characters directly. Fail-open: always returns an escaped string.
    ANAS.enc = function (s) {
        try {
            return Ext.String.htmlEncode('' + s);
        } catch (e) {
            return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
    };

    // ---- Formatters --------------------------------------------------------

    // Human-readable byte size. Prefers Proxmox's own formatter (identical
    // units across the UI); falls back to a local IEC implementation.
    ANAS.formatBytes = function (bytes) {
        if (bytes === undefined || bytes === null || isNaN(bytes)) {
            return '';
        }
        try {
            if (typeof Proxmox !== 'undefined' && Proxmox.Utils
                && typeof Proxmox.Utils.format_size === 'function') {
                return Proxmox.Utils.format_size(bytes);
            }
        } catch (e) {
            // fall through to local implementation
        }
        var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
        var order = 0;
        var size = Number(bytes);
        while (size >= 1024 && order < units.length - 1) {
            size = size / 1024;
            order++;
        }
        return size.toFixed(order === 0 ? 0 : 2) + ' ' + units[order];
    };

    ANAS.formatPercent = function (value) {
        if (value === undefined || value === null || isNaN(value)) {
            return '';
        }
        return Number(value).toFixed(0) + '%';
    };

    ANAS.formatBool = function (value) {
        try {
            if (typeof Proxmox !== 'undefined' && Proxmox.Utils
                && typeof Proxmox.Utils.format_boolean === 'function') {
                return Proxmox.Utils.format_boolean(value);
            }
        } catch (e) {
            // fall through
        }
        return value ? ANAS.t('Yes') : ANAS.t('No');
    };

    // Translate a POSIX octal mode ("0644", "755", "0000") into a human-readable
    // form: the symbolic triad string ("rw-r--r--") plus a plain-English gloss
    // ("Owner: read & write · Group: read · Others: read"). Single source of
    // truth for every octal-mode display in the UI (CIFS file_mode/dir_mode today,
    // dataset POSIX perms tomorrow). Accepts 3- or 4-digit octal (the leading
    // special-bit digit of a 4-digit value is ignored for the rwx view); any
    // invalid input returns { valid:false } with empty strings so callers can
    // degrade gracefully as the operator types. Pure and side-effect-free.
    ANAS.fmtMode = function (octal) {
        var s = ('' + (octal === undefined || octal === null ? '' : octal)).trim();
        if (!/^[0-7]{3,4}$/.test(s)) {
            return { valid: false, octal: s, symbolic: '', plain: '' };
        }
        // Use the last three digits (owner/group/other); a 4-digit value's
        // leading setuid/setgid/sticky bit does not change the rwx triads.
        var triaDigits = s.slice(s.length - 3);
        var who = [ANAS.t('Owner'), ANAS.t('Group'), ANAS.t('Others')];
        var symbolic = '';
        var glossParts = [];
        for (var i = 0; i < 3; i++) {
            var d = parseInt(triaDigits.charAt(i), 8);
            symbolic += (d & 4 ? 'r' : '-') + (d & 2 ? 'w' : '-') + (d & 1 ? 'x' : '-');
            var perms = [];
            if (d & 4) { perms.push(ANAS.t('read')); }
            if (d & 2) { perms.push(ANAS.t('write')); }
            if (d & 1) { perms.push(ANAS.t('execute')); }
            var desc = perms.length ? perms.join(' & ') : ANAS.t('no access');
            glossParts.push(who[i] + ': ' + desc);
        }
        return { valid: true, octal: s, symbolic: symbolic, plain: glossParts.join(' · ') };
    };

    // ---- Notification mode (16.12 backup / 9.4 snapshots + replication) ----
    // Three views now offer the SAME per-task knob, so the combo and its
    // normalizer live here ONCE — the Backup, Snapshots and Replication dialogs
    // must read identically (parallel construction), and three copies of a
    // two-value enum would drift. The DEFAULT is per-family and passed in:
    // backup defaults to 'always' (vzdump parity), snapshots and replication to
    // 'on-failure' (a schedule can fire every 15 minutes).
    ANAS.notifyMode = {
        // Normalize whatever the daemon sent (or nothing at all) to a mode.
        // An ABSENT value is the family's default — which is exactly what a task
        // stored before the field existed reads back as.
        of: function (value, dflt) {
            var fallback = dflt === 'always' ? 'always' : 'on-failure';
            var s = ('' + (value === undefined || value === null ? '' : value)).toLowerCase();
            if (s === 'always') {
                return 'always';
            }
            if (s === 'on-failure') {
                return 'on-failure';
            }
            return fallback;
        },

        // The combo itself. `cfg` carries the per-view bits: itemId, cls, value.
        field: function (cfg) {
            cfg = cfg || {};
            return {
                xtype: 'combobox',
                itemId: cfg.itemId || 'notifyMode',
                cls: cfg.cls,
                fieldLabel: cfg.fieldLabel || ANAS.t('Notification mode'),
                store: [
                    ['always', ANAS.t('Always')],
                    ['on-failure', ANAS.t('On failure')]
                ],
                queryMode: 'local',
                editable: false,
                forceSelection: true,
                allowBlank: false,
                value: cfg.value
            };
        },

        // A detail view's "Notifications" row — the mode in the words the dialog
        // uses. (Backup's own detail says the same thing plus its off-week-skip
        // caveat, which no other family has, so it keeps its own sentence.)
        rowHtml: function (mode, what, type) {
            var text = mode === 'on-failure'
                ? ANAS.t('on failure — only a failed ' + what + ', or one that completed with warnings, notifies')
                : ANAS.t('always — every ' + what + ' notifies, including a successful one');
            return ANAS.enc(text) + ' <span style="color:var(--anas-muted,gray);font-size:0.9em;">'
                + ANAS.enc(ANAS.t('— delivered by the Proxmox notification system (type ' + type + ')'))
                + '</span>';
        },

        // The muted hint under the combo. `what` names the thing that runs
        // ("run", "fire") and `type` the PVE notification type it is delivered
        // as, so each view says the same sentence about its own events.
        hintHtml: function (what, type) {
            return '<span style="color:var(--anas-muted,gray);font-size:11px;">'
                + ANAS.enc(ANAS.t('A finished ' + what + ' notifies through the Proxmox notification system '
                    + '(type ' + type + ') — the same matchers and targets the rest of PVE uses. '
                    + '"Always" also mails a ' + what + ' that succeeded; "On failure" mails only a failed '
                    + what + ' or one that completed with warnings.'))
                + '</span>';
        }
    };

    // Render a ZFS pool/vdev state with a coloured Font Awesome icon, mirroring
    // PVE's own render_zfs_health column style. Extends it with SUSPENDED.
    ANAS.renderState = function (value) {
        if (value === undefined || value === null || value === '') {
            return '';
        }
        var iconCls = 'question-circle';
        switch (value) {
            case 'ONLINE':
            case 'AVAIL':
            case 'INUSE':
                iconCls = 'check-circle good';
                break;
            case 'DEGRADED':
            case 'REMOVED':
                iconCls = 'exclamation-circle warning';
                break;
            case 'FAULTED':
            case 'OFFLINE':
            case 'UNAVAIL':
            case 'SUSPENDED':
                iconCls = 'times-circle critical';
                break;
            default:
                // unknown → question mark
        }
        try {
            return '<i class="fa fa-' + iconCls + '"></i> ' + Ext.String.htmlEncode(value);
        } catch (e) {
            return '' + value;
        }
    };

    // Brief success notification: Ext.toast when available, else a msgbox.
    ANAS.toast = function (msg) {
        try {
            if (typeof Ext !== 'undefined' && typeof Ext.toast === 'function') {
                Ext.toast(msg);
                return;
            }
        } catch (e) {
            // fall through
        }
        try {
            Ext.Msg.alert(ANAS.t('Success'), msg);
        } catch (e2) {
            ANAS.warn(msg);
        }
    };

    // Fail-open error alert: translate the TITLE, pass the body verbatim, and if
    // Ext.Msg is unavailable fall back to a console warning rather than throw.
    // The single home for the `try { Ext.Msg.alert(t(title), msg) } catch`
    // idiom that every view used to redefine locally. Bodies are raw (callers
    // that want a translated body call ANAS.t themselves); only the title is t()'d.
    ANAS.alertMsg = function (title, msg) {
        try {
            Ext.Msg.alert(ANAS.t(title), msg);
        } catch (e) {
            ANAS.warn(msg);
        }
    };

    // A panel config that displays an error message — used as the fail-open
    // fallback when a view factory throws, so a broken view degrades to a
    // message instead of breaking the PVE content area.
    ANAS.errorPanel = function (msg) {
        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-error',
            bodyPadding: 20,
            border: false,
            scrollable: true,
            html: '<h2>' + Ext.String.htmlEncode(ANAS.t('ANAS view error'))
                + '</h2><p>' + Ext.String.htmlEncode(msg || '') + '</p>',
        };
    };

    // ---- Menu injection machinery -----------------------------------------

    // Inject the ANAS group + child items into an already-initialised
    // PVE.node.Config. We augment the finished menu structure (tree store +
    // savedItems) that PVE.panel.Config built in callParent, mirroring exactly
    // what PVE produces for a group (e.g. Ceph). `order` is the list of view
    // keys to render, in order; missing keys are skipped.
    ANAS.injectMenu = function (cfg, order) {
        var store = cfg && cfg.store;
        var savedItems = cfg && cfg.savedItems;
        if (!store || typeof store.getRoot !== 'function' || !savedItems) {
            throw new Error('config panel internals unavailable');
        }
        if (typeof Ext === 'undefined' || typeof Ext.create !== 'function') {
            throw new Error('Ext.create unavailable');
        }

        var nodename = cfg.pveSelNode && cfg.pveSelNode.data && cfg.pveSelNode.data.node;
        if (!nodename) {
            throw new Error('no node name');
        }

        var root = store.getRoot();
        if (typeof root.findChild !== 'function') {
            throw new Error('tree root unusable');
        }
        // Idempotent: never inject twice into the same panel.
        if (root.findChild('id', 'anas', false)) {
            return;
        }

        // Collect the registered views in the requested order, skipping any
        // that are not present (partial installs / merges still work).
        var entries = [];
        var i;
        for (i = 0; i < order.length; i++) {
            var view = ANAS.views[order[i]];
            if (view && view.itemId && typeof view.factory === 'function') {
                entries.push(view);
            }
        }
        if (!entries.length) {
            return;
        }

        var group = Ext.create('Ext.data.TreeModel', {
            id: 'anas',
            text: 'ANAS',
            iconCls: 'fa fa-database',
            leaf: false,
            // Expanded from the start: clicking a group with no card of its own
            // does not toggle expansion in PVE's config treelist (mirrors
            // Ceph's expandedOnInit behavior).
            expanded: true,
        });
        root.appendChild(group);

        for (i = 0; i < entries.length; i++) {
            var card = ANAS.makeCard(nodename, entries[i]);
            savedItems[card.itemId] = card;
            group.appendChild(Ext.create('Ext.data.TreeModel', {
                id: card.itemId,
                text: entries[i].text,
                iconCls: entries[i].iconCls,
                leaf: true,
            }));
        }
    };

    // Build the content-area card for one view: a fit panel wrapping the view's
    // factory in the not-installed probe. Its own function scope captures node
    // and view so the closure is correct regardless of loop iteration.
    ANAS.makeCard = function (node, view) {
        var factory = function () {
            return view.factory(node);
        };
        return {
            xtype: 'panel',
            itemId: view.itemId,
            // Marker so overlays (e.g. the Pool Composer) can find the ANAS
            // content-region card and size themselves to it, not the viewport.
            cls: 'anas-view-card',
            title: view.text,
            iconCls: view.iconCls,
            layout: 'fit',
            border: 0,
            items: [ANAS.withInstallCheck(node, factory)],
        };
    };

    // Install the prototype patch that injects our menu group whenever a node
    // Config panel initialises. Direct prototype patch with the original
    // captured in a closure — deliberately NOT Ext.override (callParent inside a
    // runtime override resolves against the override's absent class hierarchy
    // and crashes node panel construction with "null (reading 'apply')").
    // Calling the captured original directly has no resolution machinery to
    // fail, so PVE's own init path is untouched and only our guarded injection
    // can degrade. Idempotent — patches at most once.
    ANAS.installMenu = function (order) {
        if (typeof PVE === 'undefined' || !PVE.node || !PVE.node.Config
            || !PVE.node.Config.prototype
            || typeof PVE.node.Config.prototype.initComponent !== 'function') {
            throw new Error('PVE.node.Config unavailable');
        }
        var proto = PVE.node.Config.prototype;
        if (proto.anasMenuPatched) {
            return;
        }
        var origInitComponent = proto.initComponent;
        proto.initComponent = function () {
            origInitComponent.apply(this, arguments);
            try {
                ANAS.injectMenu(this, order);
            } catch (e) {
                ANAS.warn('menu injection failed: ' + ANAS.errText(e));
            }
        };
        proto.anasMenuPatched = true;
    };
})();
