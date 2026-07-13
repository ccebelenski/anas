/*
 * ANAS — Proxmox VE web UI integration script.
 *
 * Adds a collapsible "ANAS" section to the PVE *node* menu, mirroring how PVE
 * presents Ceph: a group whose child items (Dashboard / Pools / Disks) render
 * in the content area. Each item is a panel containing an iframe that points at
 * the node's ANAS instance via the authenticated handoff page.
 *
 * It also implements the PVE-side (parent) half of the ticket-handoff protocol:
 * when an ANAS iframe posts `anas:handoff:ready`, we reply with the cluster-valid
 * PVEAuthCookie so the target node's ANAS can authenticate the browser.
 *
 * Loaded from /usr/share/pve-manager/js/anas.js, served at /pve2/js/anas.js,
 * injected into index.html.tpl immediately after pvemanagerlib.js.
 *
 * DESIGN CONTRACT — this file must FAIL OPEN. The PVE UI must never break
 * because of this script. Everything is wrapped in try/catch and every ExtJS /
 * PVE / Proxmox internal we touch is feature-detected. Worst case: the ANAS
 * section simply does not appear, and we log one console.warn.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    // ANAS is served over HTTPS on this port on every node (story 10.x).
    var ANAS_PORT = 3000;

    // Origins of ANAS iframes we have created. The handoff reply is only ever
    // sent to an origin in this set — this is the origin allow-list required by
    // the handoff protocol (never postMessage a ticket to an arbitrary origin).
    var anasOrigins = {};

    function warn(msg) {
        try {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[ANAS] ' + msg);
            }
        } catch (e) {
            // Nothing we can do — stay silent rather than break the page.
        }
    }

    function errText(e) {
        return (e && e.message) ? e.message : ('' + e);
    }

    // Read a cookie by name from document.cookie, URL-decoding the value the
    // same way Ext.util.Cookies.get does (PVE sets the ticket URL-encoded).
    function readCookie(name) {
        var raw = (typeof document !== 'undefined' && document.cookie) || '';
        var parts = raw.split(';');
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            var eq = part.indexOf('=');
            if (eq < 0) {
                continue;
            }
            var key = part.slice(0, eq).replace(/^\s+|\s+$/g, '');
            if (key === name) {
                var val = part.slice(eq + 1).replace(/^\s+|\s+$/g, '');
                try {
                    return decodeURIComponent(val);
                } catch (e) {
                    return val;
                }
            }
        }
        return '';
    }

    function authCookieName() {
        try {
            if (typeof Proxmox !== 'undefined' && Proxmox.Setup && Proxmox.Setup.auth_cookie_name) {
                return Proxmox.Setup.auth_cookie_name;
            }
        } catch (e) {
            // fall through to default
        }
        return 'PVEAuthCookie';
    }

    // Node addressing (DESIGN.md "PVE UI Integration"): when the selected tree
    // node is the one serving this PVE UI, use the browser's current hostname
    // (preserves IP-based access where the node name may not resolve). For any
    // other cluster node, use the node name.
    function anasHostForNode(nodename) {
        try {
            var self = (typeof Proxmox !== 'undefined') ? Proxmox.NodeName : undefined;
            if (self && nodename === self
                && typeof window !== 'undefined' && window.location && window.location.hostname) {
                return window.location.hostname;
            }
        } catch (e) {
            // fall through to node name
        }
        return nodename;
    }

    function anasOrigin(host) {
        return 'https://' + host + ':' + ANAS_PORT;
    }

    function handoffUrl(host, route) {
        return anasOrigin(host) + '/auth/handoff?to=' + encodeURIComponent(route);
    }

    function t(str) {
        return (typeof gettext === 'function') ? gettext(str) : str;
    }

    // Build a card panel that hosts the ANAS iframe for one menu item, and
    // record its origin so the handoff handler will trust it.
    function makeIframePanel(itemId, title, iconCls, host, route) {
        anasOrigins[anasOrigin(host)] = true;
        return {
            xtype: 'panel',
            itemId: itemId,
            title: title,
            iconCls: iconCls,
            layout: 'fit',
            border: 0,
            items: [{
                xtype: 'box',
                autoEl: {
                    tag: 'iframe',
                    src: handoffUrl(host, route),
                    style: 'border:0;width:100%;height:100%;background:#fff;',
                },
            }],
        };
    }

    // Inject the ANAS group + child items into an already-initialised
    // PVE.node.Config. We augment the finished menu structure (tree store +
    // savedItems) that PVE.panel.Config built in callParent, rather than fight
    // the items lifecycle — this mirrors exactly what PVE.panel.Config.insertNodes
    // produces for a group (e.g. Ceph).
    function injectMenu(cfg) {
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

        var host = anasHostForNode(nodename);

        var panels = [
            makeIframePanel('anas-dashboard', t('Dashboard'), 'fa fa-tachometer', host, '/'),
            makeIframePanel('anas-pools', t('Pools'), 'fa fa-th-large', host, '/storage/pools'),
            makeIframePanel('anas-disks', t('Disks'), 'fa fa-hdd-o', host, '/storage/disks'),
        ];

        var group = Ext.create('Ext.data.TreeModel', {
            id: 'anas',
            text: 'ANAS',
            iconCls: 'fa fa-database',
            leaf: false,
            expanded: false,
        });
        root.appendChild(group);

        for (var i = 0; i < panels.length; i++) {
            var panel = panels[i];
            savedItems[panel.itemId] = panel;
            group.appendChild(Ext.create('Ext.data.TreeModel', {
                id: panel.itemId,
                text: panel.title,
                iconCls: panel.iconCls,
                leaf: true,
            }));
        }
    }

    // Parent side of the handoff: hand the cluster-valid ticket to a trusted
    // ANAS iframe when it signals it is ready.
    function onMessage(event) {
        try {
            if (!event || !event.data || event.data.type !== 'anas:handoff:ready') {
                return;
            }
            // Only reply to origins we ourselves created an ANAS iframe for.
            if (!anasOrigins[event.origin]) {
                return;
            }
            var ticket = readCookie(authCookieName());
            if (!ticket) {
                return;
            }
            if (event.source && typeof event.source.postMessage === 'function') {
                event.source.postMessage(
                    { type: 'anas:handoff:ticket', ticket: ticket },
                    event.origin,
                );
            }
        } catch (e) {
            warn('handoff reply failed: ' + errText(e));
        }
    }

    function register() {
        if (typeof Ext === 'undefined' || typeof Ext.override !== 'function') {
            throw new Error('Ext.override unavailable');
        }
        if (typeof PVE === 'undefined' || !PVE.node || !PVE.node.Config) {
            throw new Error('PVE.node.Config unavailable');
        }

        // Extension mechanism: Ext.override on PVE.node.Config. We let the
        // original initComponent run (via callParent, which builds the menu),
        // then inject our group afterwards. The injection itself is guarded so a
        // failure there degrades to "no ANAS section" without disturbing PVE.
        Ext.override(PVE.node.Config, {
            initComponent: function () {
                var me = this;
                me.callParent(arguments);
                try {
                    injectMenu(me);
                } catch (e) {
                    warn('menu injection failed: ' + errText(e));
                }
            },
        });
    }

    try {
        register();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('message', onMessage, false);
        }
    } catch (e) {
        // Fail open: log once and do nothing. PVE UI stays intact.
        warn('integration disabled: ' + errText(e));
    }
})();
