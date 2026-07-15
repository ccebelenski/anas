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
