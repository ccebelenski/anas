/*
 * ANAS — Pools view (story 13.10).
 *
 * A native ExtJS grid of ZFS pools with a topology/properties/scan detail
 * window and a Start Scrub action that goes through the job API. PVE idioms
 * throughout (grid + toolbar, Ext.window.Window for detail, render_zfs_health
 * style state column). Fail-open: a broken view renders an error panel, never
 * breaks PVE.
 *
 * Data:
 *   GET  /pools                 → { data: PoolSummary[] }
 *   GET  /pools/:name           → { data: PoolDetail }
 *   POST /pools/:name/scrub     → 202 { job }
 *   POST /pools/:name/trim      → 202 { job }   (body { action:'start'|'cancel' })
 *   POST /pools/:name/upgrade   → 409 confirm → 202 { job }   (one-way, gated)
 *   GET  /jobs/:id              → { job }
 *
 * Toolbar actions (story 4.12): Trim is a safe online op run via ANAS.runJob
 * (plain 202, no confirm). Upgrade applies feature flags and is irreversible,
 * so the daemon confirmation-gates it (409 + warnings) and we route it through
 * ANAS.confirmAndRun — the same warnings-then-confirmed-retry flow as
 * export/destroy. Test hooks: anas-btn-pool-trim, anas-btn-pool-upgrade.
 */
(function () {
    'use strict';

    var ANAS = window.ANAS || (window.ANAS = {});

    // ---- Pools action registry --------------------------------------------
    //
    // Per-operation view files (31-*, 32-*, …) register toolbar actions here
    // instead of editing the grid's tbar array, so parallel work never collides
    // on one file. Each action:
    //   { itemId, text, cls, iconCls,
    //     needsSelection      — disabled until a pool row is selected,
    //     disableWhileScanning — also disabled while the selected pool scrubs,
    //     handler(node, grid, poolName) }
    // Helpers for action files: ANAS.pools.reload(grid, node),
    //   ANAS.pools.selectedPool(grid).
    ANAS.pools = ANAS.pools || {};
    if (!ANAS.pools.actions) {
        ANAS.pools.actions = [];
    }
    ANAS.pools.registerAction = function (spec) {
        ANAS.pools.actions.push(spec);
    };

    // Human role labels for vdev groups.
    var ROLE_LABELS = {
        data: 'Data',
        log: 'Log',
        cache: 'Cache',
        spare: 'Spare',
        special: 'Special',
        dedup: 'Dedup',
    };

    function roleLabel(role) {
        return ANAS.t(ROLE_LABELS[role] || role);
    }

    // ---- Per-disk health (story 3.19) --------------------------------------
    //
    // Derive a per-disk health level inline from what PoolDetail gives us —
    // vdev state + read/write/checksum error counts. Mirrors the daemon's
    // computeHealth (packages/daemon/src/routes/disks.ts) for the in-pool case:
    //   FAULTED/UNAVAIL/REMOVED or read>0 or write>0 → 'critical'
    //   OFFLINE/DEGRADED or checksum>0               → 'warning'
    //   ONLINE, no errors                            → 'healthy'
    // Deviation: computeHealth also returns 'critical' when SMART self-assessment
    // failed (smartHealthy === false) and 'unknown' for disks not in any pool.
    // PoolDetail carries neither SMART nor out-of-pool disks, so those branches
    // do not apply here — every topology disk is a live pool member.
    function diskHealthLevel(state, read, write, cksum) {
        var r = Number(read) || 0;
        var w = Number(write) || 0;
        var c = Number(cksum) || 0;
        if (state === 'FAULTED' || state === 'UNAVAIL' || state === 'REMOVED'
            || r > 0 || w > 0) {
            return 'critical';
        }
        if (state === 'OFFLINE' || state === 'DEGRADED' || c > 0) {
            return 'warning';
        }
        return 'healthy';
    }

    var HEALTH_LABELS = {
        healthy: 'Healthy',
        warning: 'Warning',
        critical: 'Critical',
    };

    var HEALTH_ICONS = {
        healthy: 'check-circle',
        warning: 'exclamation-circle',
        critical: 'times-circle',
    };

    // Colored dot + label for the topology Health column. Carries the
    // anas-topo-health-<level> class as a test hook. Fail-open: any failure
    // degrades to a bare (translated) label.
    function renderTopoHealth(value) {
        if (!value) {
            return '';
        }
        var level = value;
        var label = ANAS.t(HEALTH_LABELS[level] || level);
        var icon = HEALTH_ICONS[level] || 'question-circle';
        try {
            return '<i class="fa fa-' + icon + ' anas-topo-health-' + level
                + '"></i> ' + Ext.String.htmlEncode(label);
        } catch (e) {
            return label;
        }
    }

    // Error-count cell: nonzero values turn red + bold so a degrading disk's
    // counters visibly stand out. Blank for the group/vdev structural rows.
    function renderErrCount(value) {
        if (value === '' || value === undefined || value === null) {
            return '';
        }
        var txt;
        try {
            txt = Ext.String.htmlEncode('' + value);
        } catch (e) {
            txt = '' + value;
        }
        if ((Number(value) || 0) > 0) {
            return '<span style="color:#d9534f;font-weight:bold;">' + txt + '</span>';
        }
        return txt;
    }

    // Inject the topology health styles once (icon colors + subtle row tint).
    // No stylesheet ships with the integration bundle, so we add a single
    // guarded <style> element. Idempotent and fail-open.
    function ensureTopoStyles() {
        try {
            if (typeof document === 'undefined' || !document.getElementById) {
                return;
            }
            if (document.getElementById('anas-topo-styles')) {
                return;
            }
            var css = ''
                + '.anas-topo-health-healthy{color:#21BF13;}'
                + '.anas-topo-health-warning{color:#f0ad4e;}'
                + '.anas-topo-health-critical{color:#d9534f;}'
                + '.anas-topo-disk.anas-topo-row-warning .x-grid-cell'
                + '{background-color:rgba(240,173,78,0.14);}'
                + '.anas-topo-disk.anas-topo-row-critical .x-grid-cell'
                + '{background-color:rgba(217,83,79,0.16);}';
            var style = document.createElement('style');
            style.id = 'anas-topo-styles';
            style.type = 'text/css';
            if (style.styleSheet) {
                style.styleSheet.cssText = css;
            } else {
                style.appendChild(document.createTextNode(css));
            }
            var head = document.getElementsByTagName('head')[0] || document.documentElement;
            head.appendChild(style);
        } catch (e) {
            // non-fatal — indicators still render via inline icon classes
            ANAS.warn('topology style injection failed: ' + ANAS.errText(e));
        }
    }

    // ---- gfx retrofit (story 15.3) -----------------------------------------
    //
    // The graphical "monitor side" of the composer's visual language, built on
    // the frozen ANAS.gfx foundation (15-gfx.js). Every builder below is fully
    // fail-open: any throw / missing gfx / '' return degrades to the existing
    // text rendering (renderState / formatPercent) or an omitted graphic — the
    // native ExtJS grid and error-count tree always still render.

    function encHtml(s) {
        return ANAS.enc(s);
    }

    // Map a derived per-disk health level (diskHealthLevel) to a gfx icon state
    // token. gfx.icon/diskCard key their status dot + dead/greyscale material off
    // the lowercase tokens online|degraded|faulted; ZFS states are UPPERCASE, so
    // we route through the health derivation already used by the tree — a disk
    // that is ONLINE but throwing read/write errors still shows RED, which is the
    // whole point of colouring the topology by *live* health.
    function gfxDiskState(level) {
        if (level === 'critical') {
            return 'faulted';
        }
        if (level === 'warning') {
            return 'degraded';
        }
        return 'online';
    }

    // by-id identifiers can be long (scsi-0QEMU_QEMU_HARDDISK_ANAS_HOT1). Keep a
    // short trailing form for the card's top line; the full id stays in title.
    function shortDiskId(id) {
        id = '' + (id || '');
        if (id.length > 24) {
            return '…' + id.substring(id.length - 22);
        }
        return id;
    }

    // Card sub-line. PoolDetail carries no per-disk kind or size, so the honest
    // secondary descriptor is the live signal: a compact error summary when any
    // counter is nonzero, otherwise the raw ZFS state (lowercased).
    function diskSub(disk) {
        var r = Number(disk.readErrors) || 0;
        var w = Number(disk.writeErrors) || 0;
        var c = Number(disk.checksumErrors) || 0;
        if (r || w || c) {
            return 'R:' + r + ' W:' + w + ' C:' + c;
        }
        return ('' + (disk.state || '')).toLowerCase();
    }

    // Grid State column: render the pool state as a gfx status pill.
    // Fail-open to the FA-icon renderState.
    function renderStatePill(value) {
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.statePill === 'function' && value) {
                var html = gfx.statePill(value, { label: value });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return ANAS.renderState(value);
    }

    // Grid Capacity column: render capacity% (0–100) as a fullness-coloured gfx
    // bar; the numeric % stays legible in the bar's trailing label. Fail-open to
    // the plain formatPercent text.
    function renderCapacityBar(value) {
        try {
            var gfx = ANAS.gfx;
            if (gfx && typeof gfx.bar === 'function'
                && value !== null && value !== undefined && !isNaN(value)) {
                var html = gfx.bar(Number(value) / 100,
                    { title: ANAS.formatPercent(value) });
                if (html) {
                    return html;
                }
            }
        } catch (e) {
            // fall through
        }
        return ANAS.formatPercent(value);
    }

    // Build one skeuomorphic disk card from a PoolDisk. kind defaults to 'hdd'
    // (PoolDetail has no kind; gfx.icon also defaults unknown → hdd).
    function diskCardHtml(gfx, disk) {
        var level;
        try {
            level = diskHealthLevel(disk.state, disk.readErrors,
                disk.writeErrors, disk.checksumErrors);
        } catch (e) {
            level = '';
        }
        var card = gfx.diskCard({
            kind: 'hdd',
            state: gfxDiskState(level),
            id: shortDiskId(disk.id),
            sub: diskSub(disk),
            title: disk.id + ' — ' + disk.state,
        });
        return { html: card || '', level: level };
    }

    // The headline graphic: capacity gauge + state pill, an activity strip while
    // a scan runs, a bay per vdev (each member a health-coloured disk card so a
    // faulted drive shows RED right where it physically lives), and an advisory
    // callout naming any bad member. Returns '' on any failure → the caller omits
    // the panel and the error-count tree carries the detail alone.
    function topologyGfxHtml(d) {
        try {
            var gfx = ANAS.gfx;
            if (!gfx || typeof gfx.bay !== 'function'
                || typeof gfx.diskCard !== 'function') {
                return '';
            }

            // Header: state pill + capacity gauge (spike pool-header row).
            var pill = '';
            try {
                pill = gfx.statePill(d.state, { label: d.state }) || '';
            } catch (eP) {
                pill = '';
            }
            var gauge = '';
            var cap = Number(d.capacity);
            if (!isNaN(cap)) {
                try {
                    gauge = gfx.gauge(cap / 100, {
                        label: ANAS.formatBytes(d.allocated) + ' / '
                            + ANAS.formatBytes(d.size),
                        title: ANAS.t('Pool capacity'),
                    }) || '';
                } catch (eG) {
                    gauge = '';
                }
            }
            var head = '<div class="anas-pool-topo-head" style="display:flex;'
                + 'align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px;">'
                + pill + gauge + '</div>';

            // Activity strip while a scan is in progress.
            var activity = '';
            if (d.scan && d.scan.state === 'SCANNING') {
                var isResilver = d.scan.function === 'RESILVER';
                var pc = Number(d.scan.percentComplete);
                var frac = isNaN(pc) ? null : pc / 100;
                try {
                    activity = gfx.activity(frac, {
                        label: isResilver ? ANAS.t('Resilvering') : ANAS.t('Scrubbing'),
                    }) || '';
                } catch (eA) {
                    activity = '';
                }
                if (activity) {
                    activity = '<div style="margin-bottom:12px;">' + activity + '</div>';
                }
            }

            // Bays, grouped by vdev role. Collect bad members for the callout.
            var groups = d.vdevGroups || [];
            var faulted = [];
            var warned = [];
            var body = '';
            var gi;
            for (gi = 0; gi < groups.length; gi++) {
                var grp = groups[gi];
                var vdevs = grp.vdevs || [];
                var baysHtml = '';
                var vi;
                for (vi = 0; vi < vdevs.length; vi++) {
                    var v = vdevs[vi];
                    var disks = v.disks || [];
                    var cardsHtml = '';
                    var di;
                    for (di = 0; di < disks.length; di++) {
                        var disk = disks[di];
                        var res = diskCardHtml(gfx, disk);
                        cardsHtml += res.html;
                        if (res.level === 'critical') {
                            faulted.push(disk.id);
                        } else if (res.level === 'warning') {
                            warned.push(disk.id);
                        }
                    }
                    // Structural vdev with no leaf disks — render the vdev itself
                    // as a card so the bay is never empty.
                    if (!disks.length) {
                        var vlvl;
                        try {
                            vlvl = diskHealthLevel(v.state, v.readErrors,
                                v.writeErrors, v.checksumErrors);
                        } catch (eV) {
                            vlvl = '';
                        }
                        cardsHtml += gfx.diskCard({
                            kind: 'hdd',
                            state: gfxDiskState(vlvl),
                            id: v.name,
                            sub: ('' + (v.state || '')).toLowerCase(),
                            title: v.name + ' — ' + v.state,
                        }) || '';
                    }
                    var bay = gfx.bay(v.name || '', cardsHtml);
                    if (bay) {
                        baysHtml += '<div class="anas-pool-topo-bay">' + bay + '</div>';
                    }
                }
                // Role-group wrapper via the gfx primitive (story 15.3 gap).
                // Fail-open: if bayGroup degrades to '', keep the group's bays
                // rather than dropping the whole role silently.
                var groupHtml = '';
                if (typeof gfx.bayGroup === 'function') {
                    groupHtml = gfx.bayGroup(roleLabel(grp.role), baysHtml) || '';
                }
                body += groupHtml
                    || ('<div class="anas-gfx-baygroup">'
                        + '<div class="anas-gfx-baygroup-lbl">' + encHtml(roleLabel(grp.role)) + '</div>'
                        + '<div class="anas-gfx-baygroup-bays">' + baysHtml + '</div></div>');
            }

            // Advisory callout — reuse the derived health, name the bad members.
            var callout = '';
            var state = ('' + (d.state || '')).toUpperCase();
            try {
                if (faulted.length) {
                    var fnames = [];
                    var fi;
                    for (fi = 0; fi < faulted.length; fi++) {
                        fnames.push('<b>' + encHtml(shortDiskId(faulted[fi])) + '</b>');
                    }
                    var flvl = (state === 'FAULTED' || state === 'SUSPENDED'
                        || state === 'UNAVAIL' || state === 'DEGRADED') ? 'bad' : 'warn';
                    var fverb = faulted.length > 1
                        ? ANAS.t('have faulted') : ANAS.t('has faulted');
                    callout = gfx.callout(
                        '<b>' + encHtml(ANAS.t('Degraded')) + '</b> — '
                        + fnames.join(', ') + ' ' + encHtml(fverb) + '. '
                        + encHtml(ANAS.t('Replace the affected device; '
                            + 'a resilver rebuilds redundancy automatically.')),
                        { level: flvl });
                } else if (warned.length || state === 'DEGRADED') {
                    var wnames = [];
                    var wi;
                    for (wi = 0; wi < warned.length; wi++) {
                        wnames.push('<b>' + encHtml(shortDiskId(warned[wi])) + '</b>');
                    }
                    var wmsg = wnames.length
                        ? (encHtml(ANAS.t('Attention')) + ' — ' + wnames.join(', ')
                            + ' ' + encHtml(ANAS.t('reporting errors.')))
                        : encHtml(ANAS.t('Pool is degraded.'));
                    callout = gfx.callout(wmsg, { level: 'warn' });
                } else if (state === 'ONLINE') {
                    callout = gfx.callout(encHtml(ANAS.t('Pool is healthy.')),
                        { level: 'ok' });
                }
            } catch (eC) {
                callout = '';
            }
            if (callout) {
                callout = '<div style="margin-top:4px;">' + callout + '</div>';
            }

            return '<div class="anas-pool-topo">'
                + head + activity + body + callout + '</div>';
        } catch (e) {
            ANAS.warn('pool topology graphic failed: ' + ANAS.errText(e));
            return '';
        }
    }

    // ---- PVE-managed classification (story 3.25) ---------------------------
    //
    // A pool is PVE-managed iff its `pveStorages` is a *non-empty array*. That
    // field carries the /etc/pve/storage.cfg entries that name this pool
    // ([{ storage, type:'zfspool'|'dir'|'zfs', dataset?, content:[] }]). Older
    // daemon responses omit it — treat missing as [] (ANAS-managed). Fail-open
    // is deliberate: anything we cannot positively classify as PVE-managed
    // (malformed / non-array) stays ANAS-managed so we never silently block a
    // real ANAS pool's destructive actions.

    // Registered actions that PVE ownership makes hands-off. Scrub/Trim/Upgrade/
    // Detail (base toolbar) and Refresh stay enabled; Create/Import are not
    // selection-bound so they are untouched. Keyed by registered-action itemId.
    var PVE_HANDS_OFF = {
        exportPool: 1,
        destroyPool: 1,
        addVdevs: 1,
        attachDisk: 1,
        modifyProps: 1,
    };

    // Story iscsi.6: the verbs the daemon REFUSES outright while an iSCSI LUN
    // is serving something on the pool. Destroy would take the LUN's data with
    // it; Export would pull the block device out from under a live target. Both
    // are hard 409s with no confirm bypass, so the button is greyed and carries
    // the reason — a click that can only ever produce a refusal is not an
    // affordance.
    var LUN_HELD_BLOCKS = {
        exportPool: 1,
        destroyPool: 1,
    };

    function isArray(v) {
        try {
            return Object.prototype.toString.call(v) === '[object Array]';
        } catch (e) {
            return false;
        }
    }

    // The pool's PVE storages as a plain array (never null). Accepts an ExtJS
    // record or a raw object. Non-array / malformed ⇒ [] (ANAS-managed).
    function pveStoragesOf(rec) {
        try {
            var v = (rec && typeof rec.get === 'function')
                ? rec.get('pveStorages')
                : (rec && rec.pveStorages);
            return (isArray(v) && v.length) ? v : [];
        } catch (e) {
            return [];
        }
    }

    function isPveManaged(rec) {
        try {
            return pveStoragesOf(rec).length > 0;
        } catch (e) {
            return false;
        }
    }

    // Tooltip like "PVE storage: datapool (images, rootdir)". Joins multiple
    // storages with "; ". Fail-open to a bare label.
    function pveTooltip(storages) {
        try {
            var parts = [];
            for (var i = 0; i < storages.length; i++) {
                var s = storages[i] || {};
                var nm = s.storage || s.dataset || '';
                var content = isArray(s.content) ? s.content.join(', ') : '';
                parts.push(('' + nm) + (content ? ' (' + content + ')' : ''));
            }
            return ANAS.t('PVE storage') + ': ' + parts.join('; ');
        } catch (e) {
            return ANAS.t('PVE storage');
        }
    }

    // Name column: the pool name, plus a standout "PVE" badge for PVE-managed
    // pools (test hook: anas-pool-pve-badge; tooltip names storages + content).
    // ANAS-managed pools show the plain name. Fully fail-open — any throw or a
    // missing gfx foundation degrades to just the encoded name.
    function renderPoolName(value, meta, record) {
        var name = encHtml(value);
        try {
            var storages = pveStoragesOf(record);
            if (!storages.length) {
                return name;
            }
            var tip = pveTooltip(storages);
            var badge = '';
            try {
                var gfx = ANAS.gfx;
                if (gfx && typeof gfx.badge === 'function') {
                    badge = gfx.badge('PVE', { title: tip }) || '';
                }
            } catch (eB) {
                badge = '';
            }
            if (!badge) {
                // gfx unavailable — a plain inline tag still conveys PVE + tip.
                badge = '<span class="anas-gfx-badge" title="' + encHtml(tip)
                    + '">PVE</span>';
            }
            return name + ' <span class="anas-pool-pve-badge" title="'
                + encHtml(tip) + '">' + badge + '</span>';
        } catch (e) {
            return name;
        }
    }

    // The holding LUN on the selected pool, or null (story iscsi.6).
    //
    // ABSENT ⇒ null ⇒ no gating: an older daemon does not send the field at all,
    // and the version-skew ruling says today's screen must keep working against
    // it (the daemon still refuses — the UI just cannot pre-empt it).
    function heldByLun(rec) {
        try {
            var held = rec && rec.get ? rec.get('heldByLun') : null;
            return (held && held.targetIqn) ? held : null;
        } catch (e) {
            return null;
        }
    }

    // The one sentence a greyed button carries. Built from the daemon's own
    // `detail` so the tooltip and the 409 say the same thing.
    function lunHeldTip(held) {
        return ANAS.t('Disabled — this pool is ') + held.detail
            + ANAS.t('. Delete the LUN from the iSCSI screen first.');
    }

    // Set/clear the "why disabled" tooltip on a hands-off button. Guarded — a
    // toolbar button without setTooltip must never break updateButtons.
    function setPveTooltip(btn, blocked) {
        try {
            if (!btn || typeof btn.setTooltip !== 'function') {
                return;
            }
            btn.setTooltip(blocked
                ? ANAS.t('Disabled — PVE manages this pool')
                : '');
        } catch (e) {
            // non-fatal
        }
    }

    // Guarded button.setText — a toolbar button missing setText must never break
    // updateButtons (fail-open, story 4.12 scrub toggle).
    function btnSetText(btn, text) {
        try {
            if (btn && typeof btn.setText === 'function') {
                btn.setText(ANAS.t(text));
            }
        } catch (e) {
            // non-fatal
        }
    }

    // Guarded button.setTooltip with an explicit (already-translated) message.
    function btnSetTip(btn, msg) {
        try {
            if (btn && typeof btn.setTooltip === 'function') {
                btn.setTooltip(msg || '');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // A capability flag from the selected pool record, tri-state:
    //   true / false when the field is present, null when ABSENT (old daemon).
    // Callers must treat null as "unknown → do not gate" so an old daemon keeps
    // today's behavior (no gating regression).
    function capFlag(rec, field) {
        try {
            var v = rec.get(field);
            if (v === undefined || v === null) {
                return null;
            }
            return !!v;
        } catch (e) {
            return null;
        }
    }

    // ---- Grid --------------------------------------------------------------

    function loadPools(grid, node) {
        try {
            grid.setLoading(true);
        } catch (e) {
            // non-fatal
        }
        ANAS.api.get(node, '/pools').then(function (res) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            var rows = (res && res.data) || [];
            grid.getStore().loadData(rows);
            updateButtons(grid);
        }, function (err) {
            if (grid.destroyed || grid.destroying) {
                return;
            }
            grid.setLoading(false);
            ANAS.warn('pools load failed: ' + ANAS.errText(err));
            try {
                ANAS.alertMsg('Error',
                    ANAS.t('Failed to load pools') + ': ' + ANAS.errText(err));
            } catch (e) {
                // non-fatal
            }
        });
    }

    // Enable/disable the selection-dependent toolbar buttons. Start Scrub is
    // disabled when nothing is selected or when the selected pool is already
    // scrubbing.
    function updateButtons(grid) {
        var sel = grid.getSelection();
        var has = sel && sel.length > 0;
        var rec = has ? sel[0] : null;
        var scrubBtn = grid.down('#scrub');
        var detailBtn = grid.down('#detail');
        var trimBtn = grid.down('#trim');
        var upgradeBtn = grid.down('#upgrade');
        var pveManaged = has && isPveManaged(rec);
        if (detailBtn) {
            detailBtn.setDisabled(!has);
        }
        // Scrub is a start/stop TOGGLE (story 4.12). While a SCRUB runs the
        // button stays ENABLED but flips to "Stop Scrub" (its handler then posts
        // {action:'stop'} — see startScrub). While a RESILVER runs it is disabled
        // (you cannot scrub during a resilver, nor stop a resilver). Otherwise
        // it is the normal "Start Scrub". An old daemon omits scanFunction, so a
        // running scan of unknown type keeps today's behavior: disabled, no flip.
        if (scrubBtn) {
            var scanning = has && rec.get('scanRunning');
            var fn = has ? rec.get('scanFunction') : null;
            if (scanning && fn === 'SCRUB') {
                scrubBtn.setDisabled(!has);
                btnSetText(scrubBtn, 'Stop Scrub');
                btnSetTip(scrubBtn, '');
            } else if (scanning && fn === 'RESILVER') {
                scrubBtn.setDisabled(true);
                btnSetText(scrubBtn, 'Start Scrub');
                btnSetTip(scrubBtn, ANAS.t('Cannot scrub while the pool is resilvering'));
            } else if (scanning) {
                // Unknown scan type (old daemon) — preserve prior behavior.
                scrubBtn.setDisabled(true);
                btnSetText(scrubBtn, 'Start Scrub');
                btnSetTip(scrubBtn, '');
            } else {
                // Start Scrub only on a healthy (ONLINE) pool — parallel with the
                // AHR Expand/Scrub gate: scrubbing a degraded/faulted pool piles
                // load on already-vulnerable data; fix the fault first.
                var online = has && rec.get('state') === 'ONLINE';
                scrubBtn.setDisabled(!online);
                btnSetText(scrubBtn, 'Start Scrub');
                btnSetTip(scrubBtn, online ? '' : ANAS.t('Resolve the pool health before scrubbing (pool is not ONLINE)'));
            }
        }
        // Trim is capability-gated (story 4.12): disabled unless a member device
        // supports discard. Deliberately NOT composed with the PVE hands-off
        // gate — the 3.25 decision keeps maintenance ops (Scrub/Trim/Upgrade/
        // Detail) available on PVE-managed pools; only structural mutations are
        // hands-off. Absent trimSupported (old daemon ⇒ capFlag null) does NOT
        // gate, preserving today's behavior.
        if (trimBtn) {
            var trimCap = capFlag(rec, 'trimSupported');
            var noTrim = has && trimCap === false;
            trimBtn.setDisabled(!has || noTrim);
            if (noTrim) {
                btnSetTip(trimBtn, ANAS.t('No devices in this pool support TRIM'));
            } else {
                btnSetTip(trimBtn, '');
            }
        }
        // Upgrade is availability-gated (story 4.12): disabled unless the pool
        // has supported-but-disabled features. Like Trim, stays available on
        // PVE-managed pools (3.25 maintenance carve-out). Absent
        // upgradeAvailable (old daemon ⇒ null) does NOT gate.
        if (upgradeBtn) {
            var upgCap = capFlag(rec, 'upgradeAvailable');
            var noUpg = has && upgCap === false;
            upgradeBtn.setDisabled(!has || noUpg);
            if (noUpg) {
                btnSetTip(upgradeBtn, ANAS.t('All supported features are already enabled'));
            } else {
                btnSetTip(upgradeBtn, '');
            }
        }
        // Registered actions: toggle by their declared selection needs, plus
        // the story 3.25 hands-off gate. When the selected pool is PVE-managed,
        // the destructive/topology-mutating actions (Export/Destroy/Add-vdev/
        // Attach/Modify) are disabled with an explanatory tooltip; Scrub/Trim/
        // Upgrade/Detail (base toolbar) and Refresh stay enabled. Create/Import
        // are not selection-bound (needsSelection false) so the loop skips them.
        var scanningSel = has && rec.get('scanRunning');
        var held = has ? heldByLun(rec) : null;
        var actions = ANAS.pools.actions;
        for (var i = 0; i < actions.length; i++) {
            var a = actions[i];
            if (!a.needsSelection) {
                continue;
            }
            var btn = a.itemId ? grid.down('#' + a.itemId) : null;
            if (!btn) {
                continue;
            }
            var pveBlock = !!(pveManaged && PVE_HANDS_OFF[a.itemId]);
            var lunBlock = !!(held && LUN_HELD_BLOCKS[a.itemId]);
            btn.setDisabled(!has || (a.disableWhileScanning && scanningSel)
                || pveBlock || lunBlock);
            if (lunBlock) {
                btnSetTip(btn, lunHeldTip(held));
            } else {
                setPveTooltip(btn, pveBlock);
            }
        }
    }

    function selectedPool(grid) {
        var sel = grid.getSelection();
        return (sel && sel.length) ? sel[0].get('name') : null;
    }

    // Expose helpers for per-operation action files.
    ANAS.pools.selectedPool = selectedPool;
    ANAS.pools.reload = loadPools;

    // Scrub via the shared runJob helper (submit 202 → poll job → refresh).
    // This is the start/stop TOGGLE handler (story 4.12): if the selected pool
    // is mid-SCRUB it posts {action:'stop'} (→ `zpool scrub -s`), otherwise
    // {action:'start'}. The decision reads the live record rather than the
    // button label so it is correct regardless of render timing. After the job
    // completes, onComplete reloads /pools; the fresh scanRunning/scanFunction
    // flips the button text back via updateButtons (no manual relabel needed).
    function startScrub(grid, node) {
        var sel = grid.getSelection();
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        var rec = (sel && sel.length) ? sel[0] : null;
        var stopping = !!(rec && rec.get('scanRunning')
            && rec.get('scanFunction') === 'SCRUB');
        var action = stopping ? 'stop' : 'start';
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools/' + encodeURIComponent(pool) + '/scrub',
            body: { action: action },
            view: grid,
            failTitle: stopping ? 'Stop scrub failed' : 'Scrub failed',
            successMsg: stopping
                ? (ANAS.t('Stopping scrub on pool') + ' ' + pool)
                : (ANAS.t('Scrub started on pool') + ' ' + pool),
            onComplete: function () {
                loadPools(grid, node);
            },
        });
    }

    // Trim via the shared runJob helper (story 4.12). `zpool trim` is a safe,
    // online operation, so no confirmation gate — submit 202, poll, refresh.
    function startTrim(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        ANAS.runJob({
            node: node,
            method: 'post',
            path: '/pools/' + encodeURIComponent(pool) + '/trim',
            body: { action: 'start' },
            view: grid,
            failTitle: 'Trim failed',
            successMsg: ANAS.t('Trim started on') + ' ' + pool,
            onComplete: function () {
                loadPools(grid, node);
            },
        });
    }

    // Upgrade via confirmAndRun (story 4.12). Feature-flag upgrade is one-way,
    // so the daemon answers the first request with 409 + warnings;
    // confirmAndRun surfaces them and resends with the confirm code — exactly
    // like export/destroy. No request body.
    function upgradePool(grid, node) {
        var pool = selectedPool(grid);
        if (!pool) {
            return;
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/pools/' + encodeURIComponent(pool) + '/upgrade',
            view: grid,
            confirmTitle: 'Upgrade pool',
            confirmIntro: ANAS.t('Upgrade') + ' ' + pool + '?',
            successMsg: ANAS.t('Pool') + ' ' + pool + ' ' + ANAS.t('upgraded'),
            failTitle: 'Upgrade failed',
            onComplete: function () {
                loadPools(grid, node);
            },
        });
    }

    // Build a toolbar button config from a registered action spec.
    function actionButton(node, spec) {
        return {
            text: ANAS.t(spec.text),
            itemId: spec.itemId,
            cls: spec.cls,
            iconCls: spec.iconCls,
            disabled: !!spec.needsSelection,
            handler: function (btn) {
                var grid = btn.up('grid');
                try {
                    spec.handler(node, grid, selectedPool(grid));
                } catch (e) {
                    ANAS.warn('pool action "' + spec.itemId + '" failed: ' + ANAS.errText(e));
                }
            },
        };
    }

    function poolsGrid(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: [
                'name', 'state',
                { name: 'size', type: 'int' },
                { name: 'allocated', type: 'int' },
                { name: 'free', type: 'int' },
                { name: 'capacity', type: 'float' },
                { name: 'fragmentation', type: 'float' },
                { name: 'dedupRatio', type: 'float' },
                { name: 'scanRunning', type: 'boolean' },
                // story 4.12 gating: keep these as AUTO fields (no type coercion)
                // so an old daemon that omits them leaves get() === undefined —
                // the button logic then falls back to today's behavior (no
                // regression). A typed boolean would coerce absent → false and
                // wrongly disable Trim.
                //   scanFunction    — 'SCRUB'|'RESILVER', present only while scanning
                //   trimSupported   — any member device supports discard
                //   upgradeAvailable— pool has supported-but-disabled features
                'scanFunction', 'trimSupported', 'upgradeAvailable',
                // story 3.27: pool root mountpoint + mounted flag (the Mount
                // column). AUTO fields — absent on old daemons leaves get()
                // undefined and the renderer shows nothing (no regression).
                'mountpoint', 'mounted',
                // story 3.25: PVE-managed classification. Auto field keeps the
                // array verbatim; empty/absent ⇒ ANAS-managed (see isPveManaged).
                'pveStorages',
                // story iscsi.6: the holding iSCSI LUN, when one is serving
                // something on this pool. AUTO field — absent on old daemons
                // leaves get() undefined and nothing is gated (version skew).
                'heldByLun',
            ],
            data: [],
            sorters: [{ property: 'name', direction: 'ASC' }],
        });

        // Base toolbar (always present) + any actions registered by 31-*/32-*…
        var tbar = [
            {
                text: ANAS.t('Reload'),
                itemId: 'refresh',
                cls: 'anas-btn-refresh',
                iconCls: 'fa fa-refresh',
                handler: function (btn) {
                    loadPools(btn.up('grid'), node);
                },
            },
            {
                text: ANAS.t('Detail'),
                itemId: 'detail',
                cls: 'anas-btn-detail',
                iconCls: 'fa fa-search',
                disabled: true,
                handler: function (btn) {
                    var grid = btn.up('grid');
                    var pool = selectedPool(grid);
                    if (pool) {
                        showPoolDetail(node, pool);
                    }
                },
            },
            {
                text: ANAS.t('Start Scrub'),
                itemId: 'scrub',
                cls: 'anas-btn-scrub',
                iconCls: 'fa fa-check-circle',
                disabled: true,
                handler: function (btn) {
                    startScrub(btn.up('grid'), node);
                },
            },
            {
                text: ANAS.t('Trim'),
                itemId: 'trim',
                cls: 'anas-btn-pool-trim',
                iconCls: 'fa fa-eraser',
                disabled: true,
                handler: function (btn) {
                    startTrim(btn.up('grid'), node);
                },
            },
            {
                text: ANAS.t('Upgrade'),
                itemId: 'upgrade',
                cls: 'anas-btn-pool-upgrade',
                iconCls: 'fa fa-arrow-circle-up',
                disabled: true,
                handler: function (btn) {
                    upgradePool(btn.up('grid'), node);
                },
            },
        ];
        for (var ai = 0; ai < ANAS.pools.actions.length; ai++) {
            tbar.push(actionButton(node, ANAS.pools.actions[ai]));
        }

        return {
            xtype: 'grid',
            itemId: 'poolsGrid',
            cls: 'anas-view anas-view-pools anas-grid-pools',
            store: store,
            selModel: { mode: 'SINGLE' },
            // Tag PVE-managed rows (test hook: anas-pool-pve-row) so a test can
            // assert the hands-off classification at the row level. Fail-open.
            viewConfig: {
                getRowClass: function (record) {
                    try {
                        return isPveManaged(record) ? 'anas-pool-pve-row' : '';
                    } catch (e) {
                        return '';
                    }
                },
            },
            columns: [
                {
                    text: ANAS.t('Name'),
                    dataIndex: 'name',
                    flex: 1,
                    renderer: renderPoolName,
                },
                {
                    text: ANAS.t('State'),
                    dataIndex: 'state',
                    width: 130,
                    renderer: renderStatePill,
                },
                {
                    text: ANAS.t('Size'),
                    dataIndex: 'size',
                    width: 110,
                    renderer: ANAS.formatBytes,
                },
                {
                    text: ANAS.t('Allocated'),
                    dataIndex: 'allocated',
                    width: 110,
                    renderer: ANAS.formatBytes,
                },
                {
                    text: ANAS.t('Free'),
                    dataIndex: 'free',
                    width: 110,
                    renderer: ANAS.formatBytes,
                },
                {
                    text: ANAS.t('Capacity'),
                    dataIndex: 'capacity',
                    width: 150,
                    renderer: renderCapacityBar,
                },
                // story 3.27: shared Mount column — identical to the AHR grid's.
                ANAS.gfx.mountColumn(),
                {
                    text: ANAS.t('Fragmentation'),
                    dataIndex: 'fragmentation',
                    width: 120,
                    renderer: ANAS.formatPercent,
                },
                {
                    text: ANAS.t('Scan'),
                    dataIndex: 'scanRunning',
                    width: 110,
                    renderer: function (value) {
                        return value ? ANAS.t('Scrubbing') : ANAS.t('Idle');
                    },
                },
            ],
            tbar: tbar,
            listeners: {
                afterrender: function (grid) {
                    loadPools(grid, node);
                },
                // ExtJS fires selectionchange with (selModel, selected, …) —
                // the first arg is the selection model, NOT the grid. Use `this`
                // (the grid, per listener scope) so updateButtons gets a real grid.
                selectionchange: function () {
                    updateButtons(this);
                },
                itemdblclick: function (grid, record) {
                    showPoolDetail(node, record.get('name'));
                },
            },
        };
    }

    // ---- Detail window -----------------------------------------------------

    function kv(label, value) {
        var enc = ANAS.enc;
        return '<tr><td style="padding:2px 12px 2px 0;color:gray;white-space:nowrap;">'
            + enc(label) + '</td><td style="padding:2px 0;">' + value + '</td></tr>';
    }

    function summaryHtml(d) {
        var enc = ANAS.enc;
        var rows = ''
            + kv(ANAS.t('State'), ANAS.renderState(d.state));
        // story 3.27: the pool root's mountpoint (absent on old daemons).
        if (d.mountpoint) {
            var mountVal = enc(d.mountpoint);
            if (d.mounted === false) {
                mountVal += ' <span style="color:var(--anas-warn);font-size:11px">('
                    + enc(ANAS.t('not mounted')) + ')</span>';
            }
            rows += kv(ANAS.t('Mount'), mountVal);
        }
        rows += ''
            + kv(ANAS.t('Size'), enc(ANAS.formatBytes(d.size)))
            + kv(ANAS.t('Allocated'), enc(ANAS.formatBytes(d.allocated)))
            + kv(ANAS.t('Free'), enc(ANAS.formatBytes(d.free)))
            + kv(ANAS.t('Capacity'), enc(ANAS.formatPercent(d.capacity)))
            + kv(ANAS.t('Fragmentation'), enc(ANAS.formatPercent(d.fragmentation)))
            + kv(ANAS.t('Dedup ratio'), enc((Number(d.dedupRatio || 0)).toFixed(2) + 'x'))
            + kv(ANAS.t('Errors'), enc(d.errorCount))
            + kv(ANAS.t('GUID'), enc(d.guid));
        if (d.health && (d.health.status || d.health.action)) {
            if (d.health.status) {
                rows += kv(ANAS.t('Status'), enc(d.health.status));
            }
            if (d.health.action) {
                rows += kv(ANAS.t('Action'), enc(d.health.action));
            }
        }
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    function propsHtml(p) {
        var enc = ANAS.enc;
        p = p || {};
        var rows = ''
            + kv(ANAS.t('ashift'), enc(p.ashift))
            + kv(ANAS.t('autoexpand'), enc(ANAS.formatBool(p.autoexpand)))
            + kv(ANAS.t('autoreplace'), enc(ANAS.formatBool(p.autoreplace)))
            + kv(ANAS.t('autotrim'), enc(ANAS.formatBool(p.autotrim)))
            + kv(ANAS.t('failmode'), enc(p.failmode));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    function scanHtml(scan) {
        var enc = ANAS.enc;
        if (!scan) {
            return '<p style="color:gray;">' + enc(ANAS.t('No scan has run on this pool.')) + '</p>';
        }
        var rows = ''
            + kv(ANAS.t('Type'), enc(scan.function))
            + kv(ANAS.t('State'), enc(scan.state))
            + kv(ANAS.t('Progress'), enc(ANAS.formatPercent(scan.percentComplete)))
            + kv(ANAS.t('Examined'), enc(ANAS.formatBytes(scan.examinedBytes)
                + ' / ' + ANAS.formatBytes(scan.totalBytes)))
            + kv(ANAS.t('Repaired'), enc(ANAS.formatBytes(scan.processedBytes)))
            + kv(ANAS.t('Errors'), enc(scan.errors))
            + kv(ANAS.t('Started'), enc(scan.startedAt || '—'))
            + kv(ANAS.t('Finished'), enc(scan.finishedAt || '—'));
        return '<table style="border-collapse:collapse;">' + rows + '</table>';
    }

    // Build the topology tree root from vdevGroups → vdevs → disks.
    function topologyRoot(vdevGroups) {
        var groups = [];
        var gi;
        vdevGroups = vdevGroups || [];
        for (gi = 0; gi < vdevGroups.length; gi++) {
            var g = vdevGroups[gi];
            var groupNode = {
                name: roleLabel(g.role),
                state: '',
                read: '',
                write: '',
                cksum: '',
                expanded: true,
                children: [],
            };
            var vi;
            var vdevs = g.vdevs || [];
            for (vi = 0; vi < vdevs.length; vi++) {
                var v = vdevs[vi];
                var vdevNode = {
                    name: v.name,
                    state: v.state,
                    read: v.readErrors,
                    write: v.writeErrors,
                    cksum: v.checksumErrors,
                    expanded: true,
                    children: [],
                };
                var di;
                var disks = v.disks || [];
                for (di = 0; di < disks.length; di++) {
                    var disk = disks[di];
                    var diskNode = {
                        name: disk.id,
                        state: disk.state,
                        read: disk.readErrors,
                        write: disk.writeErrors,
                        cksum: disk.checksumErrors,
                        isDisk: true,
                        health: '',
                        leaf: true,
                    };
                    // Fail-open: if derivation throws, the row still renders
                    // with its existing state + error display, no health tag.
                    try {
                        diskNode.health = diskHealthLevel(
                            disk.state, disk.readErrors,
                            disk.writeErrors, disk.checksumErrors);
                    } catch (e) {
                        diskNode.health = '';
                    }
                    vdevNode.children.push(diskNode);
                }
                if (!vdevNode.children.length) {
                    vdevNode.leaf = true;
                    delete vdevNode.children;
                }
                groupNode.children.push(vdevNode);
            }
            groups.push(groupNode);
        }
        return { expanded: true, children: groups };
    }

    function renderDetail(win, d) {
        var content = win.down('#content');
        if (!content) {
            return;
        }
        content.removeAll();
        if (!d) {
            content.add(ANAS.errorPanel(ANAS.t('No pool detail returned.')));
            return;
        }
        ensureTopoStyles();

        // Headline skeuomorphic topology (story 15.3). Built as a fail-open HTML
        // string; when it degrades to '' the graphical panel is omitted entirely
        // and the error-count tree below carries the topology alone.
        var topoGfx = '';
        try {
            topoGfx = topologyGfxHtml(d);
        } catch (e) {
            topoGfx = '';
        }
        var items = [
            {
                xtype: 'panel',
                title: ANAS.t('Summary'),
                bodyPadding: 10,
                border: false,
                html: summaryHtml(d),
            },
        ];
        if (topoGfx) {
            items.push({
                xtype: 'panel',
                title: ANAS.t('Topology'),
                cls: 'anas-pool-topo-panel',
                bodyPadding: 12,
                border: false,
                html: topoGfx,
            });
        }
        items.push(
            {
                xtype: 'treepanel',
                // Secondary per-disk read/write/checksum error-count detail; the
                // graphical bays above are the headline (story 15.3). Titled to
                // reflect its role when the graphic is present.
                title: topoGfx ? ANAS.t('Device Errors') : ANAS.t('Topology'),
                cls: 'anas-pool-topology',
                // The detail body is a scrollable vbox. flex:1 collapses to 0px
                // once the graphical topology above fills the viewport (a flex
                // item can't take negative space), which hid this tree entirely.
                // With the graphic present, stack at a fixed height and let the
                // whole body scroll; without it, flex to fill as the sole view.
                flex: topoGfx ? undefined : 1,
                height: topoGfx ? 280 : undefined,
                rootVisible: false,
                border: false,
                store: Ext.create('Ext.data.TreeStore', {
                    fields: ['name', 'state', 'read', 'write', 'cksum',
                        'health', { name: 'isDisk', type: 'boolean' }],
                    root: topologyRoot(d.vdevGroups),
                }),
                // Tag each disk row (test hook: anas-topo-disk) and tint the row
                // for a disk in trouble so it visibly stands out. Fail-open.
                viewConfig: {
                    getRowClass: function (record) {
                        try {
                            if (!record.get('isDisk')) {
                                return '';
                            }
                            var cls = 'anas-topo-disk';
                            var h = record.get('health');
                            if (h === 'critical' || h === 'warning') {
                                cls += ' anas-topo-row-' + h;
                            }
                            return cls;
                        } catch (e) {
                            return '';
                        }
                    },
                },
                columns: [
                    { xtype: 'treecolumn', text: ANAS.t('Name'), dataIndex: 'name', flex: 1 },
                    {
                        text: ANAS.t('Health'),
                        dataIndex: 'health',
                        width: 110,
                        renderer: renderTopoHealth,
                    },
                    {
                        text: ANAS.t('State'),
                        dataIndex: 'state',
                        width: 130,
                        renderer: ANAS.renderState,
                    },
                    { text: 'READ', dataIndex: 'read', width: 80, renderer: renderErrCount },
                    { text: 'WRITE', dataIndex: 'write', width: 80, renderer: renderErrCount },
                    { text: 'CKSUM', dataIndex: 'cksum', width: 80, renderer: renderErrCount },
                ],
            },
            {
                xtype: 'panel',
                title: ANAS.t('Properties'),
                bodyPadding: 10,
                border: false,
                html: propsHtml(d.properties),
            },
            {
                xtype: 'panel',
                title: ANAS.t('Scan'),
                bodyPadding: 10,
                border: false,
                html: scanHtml(d.scan),
            }
        );
        content.add(items);
    }

    // Whether a mountpoint value is a real directory path the pool can move
    // (the mounted-pool flow — story 3.27). ZFS legacy/none, an empty value, or
    // an unmounted device path are out of scope, so Change mount stays disabled.
    function isMovableMountpoint(mp) {
        if (!mp) {
            return false;
        }
        if (mp === 'legacy' || mp === 'none' || mp === '-') {
            return false;
        }
        return mp.charAt(0) === '/' && mp.indexOf('/dev/') !== 0;
    }

    // Change the pool's mountpoint (story 3.27 — mirrors the AHR flow). Prompt
    // prefilled with the current path; the daemon validates (reserved paths,
    // collisions, PVE hands-off) and confirm-gates the ZFS-native remount.
    function changeMountpoint(win, node, poolName, current) {
        ANAS.changeMountpointFlow({
            node: node,
            resourcePath: '/pools/' + encodeURIComponent(poolName),
            label: poolName,
            current: current || '',
            view: win,
            onDone: function () {
                if (win && !win.destroyed && !win.destroying && win._reload) {
                    win._reload();
                }
                var grid = Ext.ComponentQuery.query('#poolsGrid')[0];
                if (grid) {
                    loadPools(grid, node);
                }
            },
        });
    }

    function showPoolDetail(node, poolName) {
        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-view-pool-detail',
                title: ANAS.t('Pool') + ': ' + poolName,
                modal: true,
                width: 820,
                height: 640,
                resizable: true,
                layout: 'fit',
                tbar: [
                    {
                        text: ANAS.t('Reload'),
                        iconCls: 'fa fa-refresh',
                        handler: function () {
                            loadDetail();
                        },
                    },
                    {
                        // story 3.27: confirm-gated mountpoint change. Enabled
                        // only for an ANAS-managed, movably-mounted pool once the
                        // detail loads (PVE-managed pools stay hands-off — 3.25).
                        text: ANAS.t('Change mount…'),
                        itemId: 'changeMount',
                        cls: 'anas-btn-pool-remount',
                        iconCls: 'fa fa-folder-open-o',
                        disabled: true,
                        handler: function () {
                            var d = win._poolDetail;
                            if (d) {
                                changeMountpoint(win, node, poolName, d.mountpoint);
                            }
                        },
                    },
                ],
                items: [{
                    xtype: 'panel',
                    itemId: 'content',
                    border: false,
                    scrollable: true,
                    layout: { type: 'vbox', align: 'stretch' },
                }],
            });
        } catch (e) {
            ANAS.warn('pool detail window failed: ' + ANAS.errText(e));
            return;
        }

        function loadDetail() {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                win.setLoading(true);
            } catch (e) {
                // non-fatal
            }
            ANAS.api.get(node, '/pools/' + encodeURIComponent(poolName)).then(function (res) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                var d = res && res.data;
                renderDetail(win, d);
                // story 3.27: gate Change mount. Enabled only for an ANAS-managed
                // pool (3.25 hands-off otherwise) whose root is movably mounted.
                win._poolDetail = d;
                try {
                    var mbtn = win.down('#changeMount');
                    if (mbtn) {
                        var canMove = !!d && !isPveManaged(d)
                            && isMovableMountpoint(d.mountpoint);
                        mbtn.setDisabled(!canMove);
                        mbtn.setTooltip(
                            (d && isPveManaged(d))
                                ? ANAS.t('Disabled — PVE manages this pool')
                                : (canMove ? '' : ANAS.t('The pool root is not mounted at a movable path')));
                    }
                } catch (eg) {
                    // non-fatal — the button simply stays disabled
                }
            }, function (err) {
                if (win.destroyed || win.destroying) {
                    return;
                }
                win.setLoading(false);
                ANAS.warn('pool detail load failed: ' + ANAS.errText(err));
                var content = win.down('#content');
                if (content) {
                    content.removeAll();
                    content.add(ANAS.errorPanel(
                        ANAS.t('Failed to load pool detail') + ': ' + ANAS.errText(err)));
                }
            });
        }

        // Expose the loader so the mountpoint-change flow can refresh the window.
        win._reload = loadDetail;

        win.show();
        loadDetail();
    }

    // ---- Add Vdevs action (stories 3.21 / 3.22 / 3.23) ---------------------
    //
    // Pool expansion is the Pool Composer's job (expand mode): stage new
    // Log/Cache/Spare/special/dedup/data vdevs against the selected pool and
    // commit each via POST /pools/:name/vdevs with the right role — the ONE
    // add-vdev path. Keeps the .anas-btn-addvdev test hook so toolbar specs
    // resolve.
    // PVE-managed pools must not be expandable → itemId is in PVE_HANDS_OFF.
    ANAS.pools.registerAction({
        itemId: 'addVdevs',
        text: 'Add Vdevs',
        cls: 'anas-btn-addvdev anas-btn-addvdevs',
        iconCls: 'fa fa-plus-square',
        needsSelection: true,
        disableWhileScanning: false,
        handler: function (node, grid, poolName) {
            try {
                if (poolName && ANAS.composer && typeof ANAS.composer.open === 'function') {
                    ANAS.composer.open({
                        node: node,
                        grid: grid,
                        mode: 'expand',
                        poolName: poolName,
                    });
                    return;
                }
                ANAS.alertMsg('Add Vdevs', ANAS.t('The Pool Composer is unavailable.'));
            } catch (e) {
                ANAS.warn('add-vdevs (composer expand) failed: ' + ANAS.errText(e));
            }
        },
    });

    // ---- View registration -------------------------------------------------

    ANAS.views.pools = {
        itemId: 'anas-pools',
        text: ANAS.t('Pools'),
        iconCls: 'fa fa-th-large',
        factory: function (node) {
            try {
                return poolsGrid(node);
            } catch (e) {
                ANAS.warn('pools view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        },
    };
})();
