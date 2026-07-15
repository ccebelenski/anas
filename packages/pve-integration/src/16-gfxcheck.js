/*
 * ANAS — "GFX Check" proof view. Epic 15.1 de-risk checkpoint.
 *
 * *** TEMPORARY — REMOVE ONCE THE POOL COMPOSER (Epic 15.2) SHIPS. ***
 *
 * A minimal panel that exercises the ANAS.gfx foundation inside the REAL PVE
 * ExtJS page — the one thing the local HTML spikes could not prove: that CSP
 * permits our inline SVG/style, that ExtJS event handling doesn't fight our
 * native Pointer Events, that our chrome tokens inherit the PVE theme, and that
 * a Playwright hook can drive the whole thing. It renders, using ONLY ANAS.gfx:
 *   - an "Available disks" list of gfx disk objects (hdd/ssd/nvme; one faulted),
 *   - a "vdev bay" dropzone,
 *   - a capacity gauge,
 *   - a space donut with legend,
 *   - a row of control line-icons,
 * and wires ANAS.gfx.drag so a disk drags from the list into the bay. This is
 * PURELY client-side — it moves DOM/model only, no API calls.
 *
 * Fail open: any error renders an error panel and never breaks the PVE UI.
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }
    var ANAS = window.ANAS;

    function t(str) {
        return ANAS.t(str);
    }
    function enc(s) {
        try {
            return Ext.String.htmlEncode('' + s);
        } catch (e) {
            return '' + s;
        }
    }
    function gfxReady() {
        return ANAS.gfx && typeof ANAS.gfx.icon === 'function';
    }

    // Sample "available disks" — a mix of kinds with one faulted, so the panel
    // shows the health overlay + dead treatment alongside healthy objects.
    var DISKS = [
        { id: 'gc-d1', kind: 'hdd', label: 'wwn-…a1', desc: '4 TB HDD', state: 'online' },
        { id: 'gc-d2', kind: 'hdd', label: 'wwn-…b2', desc: '4 TB HDD', state: 'faulted' },
        { id: 'gc-d3', kind: 'ssd', label: 'ata-…e5', desc: '1 TB SSD', state: 'online' },
        { id: 'gc-d4', kind: 'nvme', label: 'nvme-…g7', desc: '500 GB NVMe', state: 'online' },
    ];

    // Client-side model: which disk ids currently live in the bay.
    function makeModel() {
        return { inBay: {} };
    }

    // One draggable disk card. Carries `.anas-gfx-disk` (the convention hook) and
    // `data-id` so ANAS.gfx.drag can identify it.
    function diskCardHtml(d) {
        var icon = ANAS.gfx.icon(d.kind, { state: d.state, scale: 0.7 });
        return '<div class="anas-gfx-disk gc-disk" data-id="' + enc(d.id) + '"'
            + ' title="' + enc(d.label + ' — ' + d.state) + '"'
            + ' style="display:inline-flex;align-items:center;gap:8px;padding:6px 9px;margin:4px;'
            + 'border-radius:10px;cursor:grab;touch-action:none;'
            + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'border:1px solid var(--anas-card-edge);'
            + 'box-shadow:var(--anas-shadow),inset 0 1px 0 var(--anas-card-hi);">'
            + icon
            + '<span style="min-width:0;line-height:1.25">'
            + '<span style="display:block;font-weight:650;font-size:12px;color:var(--anas-ink)">' + enc(d.label) + '</span>'
            + '<span style="display:block;font-size:11px;color:var(--anas-muted)">' + enc(d.desc) + '</span>'
            + '</span></div>';
    }

    function diskById(id) {
        for (var i = 0; i < DISKS.length; i++) {
            if (DISKS[i].id === id) { return DISKS[i]; }
        }
        return null;
    }

    // Render the disk list + bay from the model, then (re)wire drag on every
    // draggable. Called on first render and after each drop.
    function renderDraggables(root, model) {
        var listEl = root.querySelector('#gc-avail');
        var bayEl = root.querySelector('#gc-bay');
        if (!listEl || !bayEl) { return; }

        var availHtml = '';
        var bayHtml = '';
        for (var i = 0; i < DISKS.length; i++) {
            var d = DISKS[i];
            if (model.inBay[d.id]) {
                bayHtml += diskCardHtml(d);
            } else {
                availHtml += diskCardHtml(d);
            }
        }
        listEl.innerHTML = availHtml
            || '<span style="color:var(--anas-muted);font-size:12px">' + enc(t('All disks in the bay')) + '</span>';
        bayEl.innerHTML = bayHtml
            || '<span style="color:var(--anas-muted);font-size:12px">' + enc(t('Drop disks here to form a vdev')) + '</span>';

        // Wire drag on every disk card (list + bay), so disks move both ways.
        var cards = root.querySelectorAll('.anas-gfx-disk');
        for (var c = 0; c < cards.length; c++) {
            ANAS.gfx.drag(cards[c], {
                zoneSelector: '[data-anas-zone]',
                getId: function (elm) { return elm.getAttribute('data-id'); },
                onDrop: function (id, zoneEl) {
                    var zone = zoneEl.getAttribute('data-anas-zone');
                    if (zone === 'bay') {
                        model.inBay[id] = true;
                    } else {
                        delete model.inBay[id];
                    }
                    renderDraggables(root, model);
                },
            });
        }
    }

    // Build the static gfx showcase HTML (gauge, donut+legend, control row) plus
    // the drop targets. The draggable disks are injected by renderDraggables.
    function panelHtml() {
        var gauge = ANAS.gfx.gauge(0.82, { label: '8.9 / 10.9 TB' });

        var segs = [
            { label: 'media', value: 5.1 },
            { label: 'vm', value: 2.0 },
            { label: 'backups', value: 0.9 },
            { label: 'Free', value: 2.9, free: true },
        ];
        var donut = ANAS.gfx.donut(segs, { total: 10.9, size: 132, center: { big: '8.0 TB', sm: 'of 10.9 TB' } });
        var legend = ANAS.gfx.legend(segs, { total: 10.9, format: function (v) { return v + ' TB'; } });

        var ctls = ''
            + ANAS.gfx.ctl('add', t('New dataset'))
            + ANAS.gfx.ctl('snapshot', t('Take snapshot'))
            + ANAS.gfx.ctl('share', t('Share…'))
            + ANAS.gfx.ctl('lock', t('Permissions'))
            + ANAS.gfx.ctl('props', t('Properties'))
            + ANAS.gfx.ctl('trash', t('Destroy…'), { danger: true });

        var objs = ANAS.gfx.objectIcon('pool', { title: 'pool' })
            + ' ' + ANAS.gfx.objectIcon('folder', { open: true, title: 'open folder' })
            + ' ' + ANAS.gfx.objectIcon('folder', { open: false, title: 'closed folder' });

        var sec = 'margin:0 0 8px;font-size:11px;font-weight:800;text-transform:uppercase;'
            + 'letter-spacing:.5px;color:var(--anas-muted)';
        var card = 'background:var(--anas-panel);border:1px solid var(--anas-panel-edge);'
            + 'border-radius:12px;padding:14px;box-shadow:var(--anas-shadow)';

        return ''
            + '<div class="anas-gfxcheck" style="padding:16px;color:var(--anas-ink);'
            + 'font:13px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'

            + '<div style="' + card + ';margin-bottom:14px">'
            + '<p style="margin:0 0 4px;font-weight:650">' + enc(t('ANAS.gfx checkpoint (temporary)')) + '</p>'
            + '<p style="margin:0;color:var(--anas-muted);font-size:12px">'
            + enc(t('Proves the gfx layer renders, themes, and drags inside the real PVE page. Drag a disk into the bay.'))
            + '</p></div>'

            + '<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start">'

            // Available disks
            + '<div style="' + card + ';flex:1;min-width:240px">'
            + '<p style="' + sec + '">' + enc(t('Available disks')) + '</p>'
            + '<div id="gc-avail" style="display:flex;flex-wrap:wrap"></div></div>'

            // vdev bay dropzone
            + '<div style="' + card + ';flex:1;min-width:240px">'
            + '<p style="' + sec + '">' + enc(t('vdev bay')) + '</p>'
            + '<div id="gc-bay" class="anas-gfx-bay" data-anas-zone="bay"'
            + ' style="display:flex;flex-wrap:wrap;min-height:70px;border-radius:11px;padding:8px;'
            + 'background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)"></div></div>'

            + '</div>' // end row

            + '<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;margin-top:14px">'

            // Capacity gauge
            + '<div style="' + card + ';flex:1;min-width:240px">'
            + '<p style="' + sec + '">' + enc(t('Capacity gauge')) + '</p>'
            + gauge + '</div>'

            // Space donut + legend
            + '<div style="' + card + ';flex:2;min-width:300px;display:flex;gap:18px;align-items:center">'
            + '<div>' + donut + '</div>'
            + '<div style="flex:1">'
            + '<p style="' + sec + '">' + enc(t('Pool space')) + '</p>' + legend + '</div></div>'

            + '</div>' // end row

            // Controls + objects
            + '<div style="' + card + ';margin-top:14px">'
            + '<p style="' + sec + '">' + enc(t('Controls & objects')) + '</p>'
            + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
            + ctls
            + '<span style="width:1px;height:20px;background:var(--anas-line);margin:0 6px"></span>'
            + objs
            + '</div></div>'

            + '</div>';
    }

    function gfxCheckView() {
        if (!gfxReady()) {
            return ANAS.errorPanel(t('ANAS.gfx layer unavailable'));
        }
        var model = makeModel();
        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-gfxcheck',
            title: t('GFX Check'),
            border: false,
            scrollable: true,
            bodyPadding: 0,
            html: panelHtml(),
            listeners: {
                afterrender: function (view) {
                    try {
                        var root = view.getEl() ? view.getEl().dom : null;
                        if (root) {
                            renderDraggables(root, model);
                        }
                    } catch (e) {
                        ANAS.warn('gfxcheck wiring failed: ' + ANAS.errText(e));
                    }
                },
            },
        };
    }

    // --- View registration (TEMPORARY) ----------------------------------

    ANAS.views['gfxcheck'] = {
        itemId: 'anas-gfxcheck',
        text: t('GFX Check'),
        iconCls: 'fa fa-flask',
        factory: function (node) {
            void node;
            try {
                return gfxCheckView();
            } catch (e) {
                ANAS.warn('gfxcheck view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
