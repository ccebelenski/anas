/*
 * ANAS — Pool Composer (Epic 15.2 / story 3.23, build-side).
 *
 * The flagship graphical pool builder, built entirely on the ANAS.gfx layer
 * (15-gfx.js): skeuomorphic disk objects, native pointer-drag, capacity gauges,
 * themed chrome. It supersedes the old simple Create-Pool form (32-pool-create.js
 * rewires its toolbar action to launch this).
 *
 * Two modes:
 *   - create  (empty draft): compose a whole topology, commit ONE POST /pools
 *              with a CreatePoolRequest (dataVdevs/logVdevs/cacheDisks/spareDisks).
 *   - expand  (seeded, stretch): the pool's existing vdevs render read-only; stage
 *              NEW data vdevs and commit one AddVdevRequest (POST /pools/:name/vdevs)
 *              per staged vdev. (The add-vdev API carries no role, so expand stages
 *              DATA vdevs only — see the TODO at ANAS.composer.open.)
 *
 * Draft model is 100% client-side (vdevs[] + an assigned map) — no server call
 * until commit. Drag an available disk into a bay to assign; drag it back to the
 * Available list (or click its remove) to unassign; change a bay's type inline;
 * remove a bay returns its disks. Live summary (usable capacity, redundancy,
 * survives-N-failures) + a rules-based advisor characterise the draft and suggest
 * improvements from the UNUSED disks.
 *
 * Validity gating: the Create button is DISABLED until the draft is valid —
 *   - a valid pool name,
 *   - >= 1 data vdev at/above its type minimum,
 *   - every non-empty vdev meets its min-disk count,
 *   - (hard rule, 3.22) log/special/dedup vdevs are redundant (mirror >=2 /
 *     raidzN at its min).
 * Mixed data-vdev types WARN but don't block. Blocking reasons are shown.
 *
 * SCHEMA NOTE: CreatePoolRequest has no special/dedup field and buildCreateArgs
 * (daemon) emits only data/log/cache/spare — so special/dedup vdevs cannot be
 * created through the current API. The composer still offers the role (grouping,
 * validity, advisor all reference it) but BLOCKS commit with a clear reason when
 * a special/dedup vdev holds disks, rather than silently dropping those disks.
 *
 * FRAMEWORK CONTRACT: window.ANAS with ANAS.gfx.*, ANAS.api.get, ANAS.runJob /
 * ANAS.confirmAndRun, ANAS.pools.reload, ANAS.t / ANAS.formatBytes / ANAS.warn /
 * ANAS.errText / ANAS.errorPanel. Fail open: guarded IIFE + guarded builders; a
 * failure warns and never breaks the PVE UI.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS) {
        return;
    }
    var ANAS = window.ANAS;

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }
    function enc(s) {
        try {
            return Ext.String.htmlEncode('' + s);
        } catch (e) {
            return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
    }
    function fmtBytes(n) {
        try {
            return ANAS.formatBytes(n);
        } catch (e) {
            return '' + n;
        }
    }
    function gfxReady() {
        return ANAS.gfx && typeof ANAS.gfx.icon === 'function'
            && typeof ANAS.gfx.drag === 'function';
    }

    // ---- vdev type + role metadata ----------------------------------------
    //
    // Composer type keys mirror the spike (raidz1/2/3); the schema's VdevSpec
    // uses 'raidz' for raidz1, so schemaType() maps on commit.
    var TYPES = {
        mirror: { label: 'mirror', min: 2 },
        raidz1: { label: 'raidz1', min: 3 },
        raidz2: { label: 'raidz2', min: 4 },
        raidz3: { label: 'raidz3', min: 5 },
        stripe: { label: 'stripe', min: 1 },
    };
    // Data-vdev type choices offered in the add-row + inline bay selector.
    var DATA_TYPES = ['mirror', 'raidz1', 'raidz2', 'raidz3', 'stripe'];
    // Redundant type choices for log/special/dedup (stripe excluded — must be
    // redundant per the hard rule).
    var REDUNDANT_TYPES = ['mirror', 'raidz1', 'raidz2', 'raidz3'];

    var ROLES = {
        data: { label: 'Data', individual: false, redundantRequired: false },
        log: { label: 'Log (SLOG)', individual: false, redundantRequired: true },
        cache: { label: 'Cache (L2ARC)', individual: true, redundantRequired: false },
        spare: { label: 'Spare', individual: true, redundantRequired: false },
        special: { label: 'Special (metadata)', individual: false, redundantRequired: true },
    };
    // Roles the create form offers, in presentation order.
    var CREATE_ROLE_ORDER = ['data', 'log', 'cache', 'spare', 'special'];

    function typeMin(type) {
        return (TYPES[type] && TYPES[type].min) || 1;
    }
    // Map a composer type to the shared VdevSpec type (raidz1 -> raidz).
    function schemaType(type) {
        return type === 'raidz1' ? 'raidz' : type;
    }
    function roleLabel(role) {
        return t((ROLES[role] && ROLES[role].label) || role);
    }
    function typeWord(type) {
        var words = {
            mirror: 'a mirror', raidz1: 'a raidz1', raidz2: 'a raidz2',
            raidz3: 'a raidz3', stripe: 'this stripe',
        };
        return t(words[type] || type);
    }

    // ---- per-vdev math (bytes) --------------------------------------------

    function minDiskSize(v, diskById) {
        var m = Infinity;
        for (var i = 0; i < v.diskIds.length; i++) {
            var d = diskById[v.diskIds[i]];
            if (d) {
                m = Math.min(m, d.size || 0);
            }
        }
        return m === Infinity ? 0 : m;
    }
    function sumDiskSize(v, diskById) {
        var s = 0;
        for (var i = 0; i < v.diskIds.length; i++) {
            var d = diskById[v.diskIds[i]];
            if (d) {
                s += d.size || 0;
            }
        }
        return s;
    }
    // Usable bytes for a data vdev of this type.
    function vdevUsable(v, diskById) {
        var n = v.diskIds.length;
        if (!n) {
            return 0;
        }
        var s = minDiskSize(v, diskById);
        if (v.type === 'mirror') {
            return s;
        }
        if (v.type === 'raidz1') {
            return Math.max(0, n - 1) * s;
        }
        if (v.type === 'raidz2') {
            return Math.max(0, n - 2) * s;
        }
        if (v.type === 'raidz3') {
            return Math.max(0, n - 3) * s;
        }
        return sumDiskSize(v, diskById); // stripe
    }
    // Disk failures this vdev tolerates.
    function vdevTol(v) {
        var n = v.diskIds.length;
        if (!n) {
            return 0;
        }
        if (v.type === 'mirror') {
            return n - 1;
        }
        if (v.type === 'raidz1') {
            return 1;
        }
        if (v.type === 'raidz2') {
            return 2;
        }
        if (v.type === 'raidz3') {
            return 3;
        }
        return 0; // stripe
    }
    function isRedundant(v) {
        var n = v.diskIds.length;
        if (v.type === 'mirror') {
            return n >= 2;
        }
        if (v.type === 'raidz1' || v.type === 'raidz2' || v.type === 'raidz3') {
            return n >= typeMin(v.type);
        }
        return false; // stripe
    }

    // ---- disk kind mapping -------------------------------------------------

    function diskKind(d) {
        if (d.rotational === true) {
            return 'hdd';
        }
        var tr = ('' + (d.transport || '')).toLowerCase();
        if (tr === 'nvme') {
            return 'nvme';
        }
        return 'ssd';
    }
    function kindBadge(kind) {
        var colors = { hdd: 'var(--anas-series-5)', ssd: 'var(--anas-series-2)', nvme: 'var(--anas-series-3)' };
        var label = ANAS.gfx && ANAS.gfx.kindLabel ? ANAS.gfx.kindLabel(kind)
            : (kind === 'nvme' ? 'NVMe' : kind === 'ssd' ? 'SSD' : 'HDD');
        return '<span style="font-size:10px;font-weight:800;letter-spacing:.3px;'
            + 'padding:1px 6px;border-radius:999px;color:#fff;background:'
            + colors[kind] + '">' + enc(label) + '</span>';
    }

    // ======================================================================
    // DRAFT STATE
    // ======================================================================

    function makeState(opts) {
        return {
            node: opts.node,
            grid: opts.grid,
            mode: opts.mode === 'expand' ? 'expand' : 'create',
            poolName: opts.poolName || '',
            name: opts.poolName || 'tank',
            disks: [],          // available Disk records
            diskById: {},       // id -> disk
            vdevs: [],          // staged/new vdevs (draft)
            existing: [],       // read-only vdevs (expand mode)
            assigned: {},       // diskId -> vdevId
            seq: 0,
            win: null,
            root: null,         // composer body DOM element
            createBtn: null,
        };
    }

    function addVdev(state, role, type) {
        if (ROLES[role] && ROLES[role].individual) {
            type = 'stripe';
        }
        state.vdevs.push({
            id: 'v' + (++state.seq),
            role: role,
            type: type,
            diskIds: [],
        });
    }
    function vdevById(state, id) {
        for (var i = 0; i < state.vdevs.length; i++) {
            if (state.vdevs[i].id === id) {
                return state.vdevs[i];
            }
        }
        return null;
    }
    // Move a disk to targetVdevId (or null to unassign back to Available).
    function moveDisk(state, diskId, targetVdevId) {
        var cur = state.assigned[diskId];
        if (cur) {
            var cv = vdevById(state, cur);
            if (cv) {
                var kept = [];
                for (var i = 0; i < cv.diskIds.length; i++) {
                    if (cv.diskIds[i] !== diskId) {
                        kept.push(cv.diskIds[i]);
                    }
                }
                cv.diskIds = kept;
            }
        }
        delete state.assigned[diskId];
        if (targetVdevId) {
            var tv = vdevById(state, targetVdevId);
            if (tv) {
                tv.diskIds.push(diskId);
                state.assigned[diskId] = targetVdevId;
            }
        }
    }
    function removeVdev(state, id) {
        var v = vdevById(state, id);
        if (!v) {
            return;
        }
        var ids = v.diskIds.slice();
        for (var i = 0; i < ids.length; i++) {
            moveDisk(state, ids[i], null);
        }
        var kept = [];
        for (var j = 0; j < state.vdevs.length; j++) {
            if (state.vdevs[j].id !== id) {
                kept.push(state.vdevs[j]);
            }
        }
        state.vdevs = kept;
    }

    // ======================================================================
    // VALIDITY
    // ======================================================================

    function dataVdevs(state) {
        var out = [];
        for (var i = 0; i < state.vdevs.length; i++) {
            if (state.vdevs[i].role === 'data') {
                out.push(state.vdevs[i]);
            }
        }
        return out;
    }

    function validate(state) {
        var blocking = [];
        var warnings = [];
        var v, i, n, min;

        var nameOk = /^[A-Za-z][\w.:-]*$/.test(state.name || '');
        if (!nameOk) {
            blocking.push(t('Enter a valid pool name (letter first; letters, digits, . : - _).'));
        }

        var hasCompleteData = false;
        for (i = 0; i < state.vdevs.length; i++) {
            v = state.vdevs[i];
            n = v.diskIds.length;
            min = typeMin(v.type);
            var word = roleLabel(v.role) + ' ' + (TYPES[v.type] ? TYPES[v.type].label : v.type);
            if (n < min) {
                blocking.push(word + ' ' + t('needs at least') + ' ' + min + ' '
                    + t(min === 1 ? 'disk' : 'disks') + ' (' + t('has') + ' ' + n + ').');
            }
            if (ROLES[v.role] && ROLES[v.role].redundantRequired && n > 0 && !isRedundant(v)) {
                blocking.push(roleLabel(v.role) + ' ' + t('vdev must be redundant (mirror ≥ 2, or a raidzN at its minimum) — losing it can lose the whole pool.'));
            }
            // Schema gap: special/dedup cannot be created through the current API.
            if ((v.role === 'special' || v.role === 'dedup') && n > 0 && state.mode === 'create') {
                blocking.push(roleLabel(v.role) + ' ' + t('vdevs cannot be created yet (the API supports data, log, cache and spare) — remove it to create the pool.'));
            }
            if (v.role === 'data' && n >= min) {
                hasCompleteData = true;
            }
        }

        if (state.mode === 'create' && !hasCompleteData) {
            blocking.push(t('A pool needs at least one complete data vdev.'));
        }
        if (state.mode === 'expand' && !state.vdevs.length) {
            blocking.push(t('Stage at least one new vdev to add.'));
        }
        if (state.mode === 'expand') {
            var anyStaged = false;
            for (i = 0; i < state.vdevs.length; i++) {
                if (state.vdevs[i].diskIds.length >= typeMin(state.vdevs[i].type)) {
                    anyStaged = true;
                }
            }
            if (state.vdevs.length && !anyStaged) {
                blocking.push(t('No staged vdev has enough disks yet.'));
            }
        }

        // Non-blocking warnings.
        var dv = dataVdevs(state);
        var types = {};
        var striped = false;
        for (i = 0; i < dv.length; i++) {
            if (dv[i].diskIds.length) {
                types[dv[i].type] = 1;
                if (dv[i].type === 'stripe') {
                    striped = true;
                }
            }
        }
        var typeKeys = [];
        for (var k in types) {
            if (types.hasOwnProperty(k)) {
                typeKeys.push(k);
            }
        }
        if (typeKeys.length > 1) {
            warnings.push(t('Data vdevs mix redundancy types') + ' (' + typeKeys.join(', ')
                + ') — ' + t('usually kept uniform so capacity and safety are even.'));
        }
        if (striped) {
            warnings.push(t('A striped data vdev has no redundancy — a single disk failure loses the pool.'));
        }

        return { valid: blocking.length === 0, blocking: blocking, warnings: warnings };
    }

    // ======================================================================
    // POOL ADVISOR (rules)
    // ======================================================================

    function advise(state) {
        var lines = [];   // { tone:'ok'|'info'|'warn'|'danger', text }
        var i, v, d;

        // Compose the data-vdev disk-kind profile.
        var dv = dataVdevs(state);
        var kinds = {};
        var dataDiskCount = 0;
        for (i = 0; i < dv.length; i++) {
            for (var j = 0; j < dv[i].diskIds.length; j++) {
                d = state.diskById[dv[i].diskIds[j]];
                if (d) {
                    kinds[diskKind(d)] = (kinds[diskKind(d)] || 0) + 1;
                    dataDiskCount++;
                }
            }
        }
        var hasHDD = !!kinds.hdd;
        var hasFlash = !!(kinds.ssd || kinds.nvme);

        // Free (unassigned) disks by kind.
        var freeFlash = 0;
        var freeHDD = 0;
        for (i = 0; i < state.disks.length; i++) {
            d = state.disks[i];
            if (state.assigned[d.id]) {
                continue;
            }
            if (diskKind(d) === 'hdd') {
                freeHDD++;
            } else {
                freeFlash++;
            }
        }

        // Roles already present.
        var hasSpecial = false;
        var hasCache = false;
        var hasLog = false;
        for (i = 0; i < state.vdevs.length; i++) {
            v = state.vdevs[i];
            if (v.role === 'special') {
                hasSpecial = true;
            }
            if (v.role === 'cache') {
                hasCache = true;
            }
            if (v.role === 'log') {
                hasLog = true;
            }
        }

        // (a) Characterise best-use.
        if (dataDiskCount > 0) {
            if (hasHDD && !hasFlash) {
                lines.push({ tone: 'info', text: t('Capacity pool, all-HDD — best for sequential, large-file workloads: media, backups, archives.') });
            } else if (hasFlash && !hasHDD) {
                lines.push({ tone: 'info', text: t('All-flash pool — best for random I/O and low latency: VMs, databases, active project files.') });
            } else if (hasFlash && hasHDD) {
                lines.push({ tone: 'warn', text: t('Data vdevs mix HDD and flash — ZFS sizes each vdev to its slowest member. Consider using flash as a cache/special vdev instead of in the data vdevs.') });
            }
        } else {
            lines.push({ tone: 'info', text: t('Drag disks into a data vdev to begin — the advisor characterises the pool as you build it.') });
        }

        // (b) Suggestions from the UNUSED disks.
        if (freeFlash >= 2 && hasHDD && !hasFlash && !hasSpecial) {
            lines.push({ tone: 'ok', text: freeFlash + ' ' + t('free SSD/NVMe could form a mirrored special vdev — metadata and small files move to flash, which noticeably speeds directory-heavy and small-file workloads on an HDD pool.') });
        }
        if (freeFlash >= 1 && !hasCache) {
            lines.push({ tone: 'info', text: t('A free SSD/NVMe could serve as an L2ARC cache device — but it only helps when your working set is larger than RAM yet fits the cache, and its headers consume RAM.') });
        }
        if (freeFlash >= 2 && !hasLog) {
            lines.push({ tone: 'info', text: t('Two free SSD/NVMe could form a mirrored SLOG — but a SLOG accelerates only synchronous writes (NFS, databases); it does nothing for async writes.') });
        }
        if (freeHDD > 0 && hasHDD && dv.length) {
            var refType = dv[0].type;
            if (freeHDD >= typeMin(refType)) {
                lines.push({ tone: 'info', text: freeHDD + ' ' + t('free HDDs match your data vdevs — you could add another data vdev to grow capacity (add capacity in whole vdevs, not single disks).') });
            }
        }

        // (c) Honest caveats.
        if (hasSpecial) {
            lines.push({ tone: 'danger', text: t('A special vdev is not optional storage — losing it loses the entire pool, so it must be at least as redundant as your data vdevs.') });
        }

        return lines;
    }

    // ======================================================================
    // RENDER
    // ======================================================================

    // A draggable disk card (mirrors the gfx-check convention: .anas-gfx-disk +
    // data-id). The title carries the FULL, clean by-id (no trailing ellipsis) —
    // the visible id is truncated with CSS, the tooltip is complete.
    function diskCardHtml(d, removable) {
        var kind = diskKind(d);
        var icon = ANAS.gfx.icon(kind, { scale: 0.62 });
        var model = d.model || d.modelFamily || '';
        var desc = kindBadge(kind) + ' ' + enc(fmtBytes(d.size))
            + (model ? ' · ' + enc(model) : '');
        var remove = removable
            ? '<button type="button" class="anas-composer-unassign" data-unassign="' + enc(d.id) + '"'
                + ' title="' + enc(t('Remove disk')) + '" aria-label="' + enc(t('Remove disk')) + '"'
                + ' style="margin-left:auto;border:0;background:transparent;color:var(--anas-muted);'
                + 'cursor:pointer;font-size:14px;line-height:1;padding:0 2px">✕</button>'
            : '';
        return '<div class="anas-gfx-disk anas-composer-disk" data-id="' + enc(d.id) + '"'
            + ' data-size="' + enc(String(d.size == null ? '' : d.size)) + '"'
            + ' title="' + enc(d.id) + '"'
            + ' style="width:216px;display:inline-flex;align-items:center;gap:9px;padding:7px 9px;'
            + 'margin:4px;border-radius:11px;cursor:grab;touch-action:none;box-sizing:border-box;'
            + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'border:1px solid var(--anas-card-edge);'
            + 'box-shadow:var(--anas-shadow),inset 0 1px 0 var(--anas-card-hi)">'
            + icon
            + '<span style="min-width:0;line-height:1.25;flex:1">'
            + '<span style="display:block;font-weight:650;font-size:12px;color:var(--anas-ink);'
            + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + enc(d.id) + '</span>'
            + '<span style="display:block;font-size:11px;color:var(--anas-muted)">' + desc + '</span>'
            + '</span>' + remove + '</div>';
    }

    // A read-only leaf disk (expand mode existing topology): no drag, shows state.
    function existingDiskHtml(disk) {
        var state = (disk.state || '').toLowerCase();
        var stKey = state === 'online' ? 'online'
            : (state === 'degraded' ? 'degraded'
                : (state === 'faulted' || state === 'unavail' || state === 'removed' ? 'faulted' : null));
        var icon = ANAS.gfx.icon('hdd', stKey ? { state: stKey, scale: 0.6 } : { scale: 0.6 });
        return '<div class="anas-composer-disk-ro" title="' + enc(disk.id) + '"'
            + ' style="width:216px;display:inline-flex;align-items:center;gap:9px;padding:7px 9px;margin:4px;'
            + 'border-radius:11px;box-sizing:border-box;opacity:.85;'
            + 'background:var(--anas-slot);border:1px dashed var(--anas-card-edge)">'
            + icon
            + '<span style="min-width:0;flex:1"><span style="display:block;font-weight:650;font-size:12px;'
            + 'color:var(--anas-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
            + enc(disk.id) + '</span>'
            + '<span style="display:block;font-size:11px;color:var(--anas-muted)">' + enc(disk.state || '') + '</span>'
            + '</span></div>';
    }

    var SEC = 'margin:0 0 8px;font-size:11px;font-weight:800;text-transform:uppercase;'
        + 'letter-spacing:.5px;color:var(--anas-muted)';
    var CARD = 'background:var(--anas-panel);border:1px solid var(--anas-panel-edge);'
        + 'border-radius:12px;padding:14px;box-shadow:var(--anas-shadow)';
    var PILL = 'font-size:11px;padding:1px 9px;border-radius:999px;border:1px solid var(--anas-line);'
        + 'color:var(--anas-muted);background:var(--anas-panel)';

    function pill(text, tone) {
        var color = tone === 'ok' ? 'var(--anas-ok)' : (tone === 'warn' ? 'var(--anas-warn)' : '');
        var extra = color ? ';color:' + color + ';border-color:' + color : '';
        return '<span style="' + PILL + extra + '">' + enc(text) + '</span>';
    }

    // Render one draft bay (a vdev enclosure) — a dropzone with data-anas-zone.
    function bayHtml(state, v, index, pulseFirst) {
        var role = ROLES[v.role] || { individual: false };
        var n = v.diskIds.length;
        var min = typeMin(v.type);
        var typeChoices = role.redundantRequired ? REDUNDANT_TYPES : DATA_TYPES;
        var typeSel = '';
        if (!role.individual) {
            var opts = '';
            for (var ti = 0; ti < typeChoices.length; ti++) {
                var tk = typeChoices[ti];
                opts += '<option value="' + tk + '"' + (tk === v.type ? ' selected' : '') + '>'
                    + enc(TYPES[tk].label) + '</option>';
            }
            typeSel = '<select class="anas-fld-composer-bay-type" data-vtype="' + enc(v.id) + '"'
                + ' title="' + enc(t('Change this vdev\'s redundancy layout')) + '"'
                + ' style="font:inherit;padding:2px 6px;border-radius:6px;'
                + 'border:1px solid var(--anas-card-edge);background:var(--anas-slot);color:var(--anas-ink)">'
                + opts + '</select>';
        }

        var body;
        if (n) {
            body = '';
            for (var di = 0; di < v.diskIds.length; di++) {
                var d = state.diskById[v.diskIds[di]];
                if (d) {
                    body += diskCardHtml(d, true);
                }
            }
        } else {
            var pulse = pulseFirst
                ? ';animation:anasComposerGlow 1.9s ease-in-out infinite'
                : '';
            body = '<div style="flex:1;min-width:210px;color:var(--anas-muted);font-size:12px;'
                + 'text-align:center;border:1.5px dashed var(--anas-card-edge);border-radius:10px;'
                + 'padding:16px 8px;background:var(--anas-bay-in)' + pulse + '">'
                + '<span style="display:block;font-size:13px;color:var(--anas-ink);font-weight:600;margin-bottom:2px">'
                + enc(t('Drop') + ' ' + min + ' ' + t(min === 1 ? 'disk' : 'disks') + ' ' + t('here')) + '</span>'
                + enc(t('to form') + ' ' + typeWord(v.type)) + '</div>';
        }

        var okCount = n >= min;
        var tol = vdevTol(v);
        var foot = pill(n + ' / ' + min + ' ' + t('min disks'), okCount ? 'ok' : 'warn');
        if (v.role === 'data' && n) {
            foot += ' ' + pill(t('usable') + ' ' + fmtBytes(vdevUsable(v, state.diskById)));
        }
        if (n && !role.individual) {
            foot += ' ' + pill(t('survives') + ' ' + tol + ' ' + t(tol === 1 ? 'failure' : 'failures'));
        }

        return '<div class="anas-composer-bay" data-vdev="' + enc(v.id) + '"'
            + ' style="border-radius:13px;overflow:hidden;border:1px solid var(--anas-panel-edge);'
            + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'box-shadow:var(--anas-shadow);margin-bottom:12px">'
            + '<div style="display:flex;align-items:center;gap:9px;padding:9px 12px;'
            + 'border-bottom:1px solid var(--anas-line)">'
            + '<span style="font-weight:700;background:var(--anas-slot);border:1px solid var(--anas-card-edge);'
            + 'border-radius:6px;padding:2px 9px;box-shadow:inset 0 1px 2px rgba(0,0,0,.12)">'
            + enc((TYPES[v.type] ? TYPES[v.type].label : v.type) + '-' + index) + '</span>'
            + '<span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
            + 'color:var(--anas-muted)">' + enc(roleLabel(v.role)) + '</span>'
            + typeSel + '<span style="flex:1"></span>'
            + '<button type="button" class="anas-composer-delvdev" data-delvdev="' + enc(v.id) + '"'
            + ' title="' + enc(t('Remove vdev')) + '" aria-label="' + enc(t('Remove vdev')) + '"'
            + ' style="border:0;background:transparent;color:var(--anas-muted);cursor:pointer;'
            + 'font-size:14px;padding:0 4px">✕</button></div>'
            + '<div class="anas-gfx-bay" data-anas-zone="vdev:' + enc(v.id) + '"'
            + ' style="display:flex;flex-wrap:wrap;gap:10px;padding:13px;min-height:78px;'
            + 'background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)">' + body + '</div>'
            + '<div style="padding:7px 12px 10px;display:flex;gap:8px;flex-wrap:wrap">' + foot + '</div></div>';
    }

    // Read-only existing vdev (expand mode).
    function existingBayHtml(role, v, index) {
        var body = '';
        for (var di = 0; di < (v.disks || []).length; di++) {
            body += existingDiskHtml(v.disks[di]);
        }
        return '<div class="anas-composer-bay-existing"'
            + ' style="border-radius:13px;overflow:hidden;border:1px solid var(--anas-panel-edge);'
            + 'background:var(--anas-slot);margin-bottom:12px;opacity:.9">'
            + '<div style="display:flex;align-items:center;gap:9px;padding:9px 12px;'
            + 'border-bottom:1px solid var(--anas-line)">'
            + '<span style="font-weight:700;background:var(--anas-panel);border:1px solid var(--anas-card-edge);'
            + 'border-radius:6px;padding:2px 9px">' + enc(v.name || (v.type + '-' + index)) + '</span>'
            + '<span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;'
            + 'color:var(--anas-muted)">' + enc(roleLabel(role)) + '</span>'
            + '<span style="flex:1"></span>'
            + '<span style="font-size:11px;color:var(--anas-muted)">' + enc(t('existing — read only')) + '</span></div>'
            + '<div style="display:flex;flex-wrap:wrap;gap:10px;padding:13px;min-height:60px;'
            + 'background:var(--anas-bay);box-shadow:inset 0 2px 6px rgba(0,0,0,.16)">' + body + '</div></div>';
    }

    function renderAvail(state) {
        var listEl = state.root.querySelector('#anasc-avail');
        var countEl = state.root.querySelector('#anasc-availcount');
        if (!listEl) {
            return;
        }
        var html = '';
        var free = 0;
        for (var i = 0; i < state.disks.length; i++) {
            var d = state.disks[i];
            if (!state.assigned[d.id]) {
                html += diskCardHtml(d, false);
                free++;
            }
        }
        listEl.innerHTML = html
            || '<div style="color:var(--anas-muted);font-size:12px;text-align:center;padding:20px 0">'
                + enc(state.disks.length ? t('All disks assigned') : t('No available disks found')) + '</div>';
        if (countEl) {
            countEl.textContent = free + ' ' + t('free');
        }
    }

    function renderRacks(state) {
        var racksEl = state.root.querySelector('#anasc-racks');
        if (!racksEl) {
            return;
        }
        var html = '';
        var i;
        // Existing (read-only) vdevs first in expand mode.
        for (i = 0; i < state.existing.length; i++) {
            html += existingBayHtml(state.existing[i].role, state.existing[i].vdev, i);
        }
        var pulseUsed = false;
        for (i = 0; i < state.vdevs.length; i++) {
            var pulse = !pulseUsed && state.vdevs[i].diskIds.length === 0;
            if (pulse) {
                pulseUsed = true;
            }
            html += bayHtml(state, state.vdevs[i], i, pulse);
        }
        if (!state.vdevs.length && !state.existing.length) {
            html = '<div style="min-height:60px;color:var(--anas-muted);font-size:12px;text-align:center;'
                + 'border:1.5px dashed var(--anas-card-edge);border-radius:11px;padding:20px 8px;'
                + 'background:var(--anas-bay-in)">'
                + '<span style="display:block;font-size:13px;color:var(--anas-ink);font-weight:600;margin-bottom:2px">'
                + enc(t('No vdevs yet')) + '</span>'
                + enc(t('Add one below, then drag disks into its bay.')) + '</div>';
        }
        racksEl.innerHTML = html;
    }

    function renderSummary(state, result) {
        var el = state.root.querySelector('#anasc-summary');
        if (!el) {
            return;
        }
        var dv = dataVdevs(state);
        var usable = 0;
        var raw = 0;
        var i;
        for (i = 0; i < dv.length; i++) {
            usable += vdevUsable(dv[i], state.diskById);
            raw += sumDiskSize(dv[i], state.diskById);
        }
        var tol = null;
        for (i = 0; i < dv.length; i++) {
            if (dv[i].diskIds.length) {
                var tv = vdevTol(dv[i]);
                tol = (tol === null) ? tv : Math.min(tol, tv);
            }
        }
        var frac = raw > 0 ? usable / raw : 0;
        var gauge = ANAS.gfx.gauge(frac, {
            label: fmtBytes(usable) + ' ' + t('usable of') + ' ' + fmtBytes(raw) + ' ' + t('raw'),
        });

        function stat(k, v) {
            return '<div style="display:flex;justify-content:space-between;padding:7px 0;'
                + 'border-bottom:1px dashed var(--anas-line)">'
                + '<span style="color:var(--anas-muted)">' + enc(k) + '</span>'
                + '<span style="font-weight:700;font-variant-numeric:tabular-nums">' + enc(v) + '</span></div>';
        }
        var tolText = tol === null ? '—'
            : (tol === 0 ? t('none (striped)') : tol + ' ' + t(tol === 1 ? 'disk / vdev' : 'disks / vdev'));

        var blocking = '';
        if (result.blocking.length) {
            var b = '';
            for (i = 0; i < result.blocking.length; i++) {
                b += '<div style="font-size:12px;padding:7px 9px;border-radius:9px;display:flex;gap:7px;'
                    + 'align-items:flex-start;background:color-mix(in srgb,var(--anas-danger) 14%,transparent);'
                    + 'color:var(--anas-danger)"><span>⛔</span><span>' + enc(result.blocking[i]) + '</span></div>';
            }
            blocking = '<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">'
                + '<div style="' + SEC + ';margin:2px 0 2px">' + enc(t('Blocking')) + '</div>' + b + '</div>';
        } else {
            blocking = '<div style="margin-top:10px;font-size:12px;padding:7px 9px;border-radius:9px;'
                + 'background:color-mix(in srgb,var(--anas-ok) 13%,transparent);color:var(--anas-ok)">'
                + '✓ ' + enc(t('Ready to create.')) + '</div>';
        }

        el.innerHTML = '<div style="' + SEC + '">' + enc(t('Summary')) + '</div>'
            + '<div style="margin-bottom:10px">' + gauge + '</div>'
            + stat(t('Usable'), usable ? fmtBytes(usable) : '—')
            + stat(t('Raw data'), raw ? fmtBytes(raw) : '—')
            + stat(t('Fault tolerance'), tolText)
            + stat(t('Vdevs'), '' + state.vdevs.length)
            + blocking;
    }

    function renderAdvisor(state, result) {
        var el = state.root.querySelector('#anasc-advisor');
        if (!el) {
            return;
        }
        var lines = advise(state);
        var i;
        var html = '<div style="' + SEC + '">' + enc(t('Pool advisor')) + '</div>';

        // Non-blocking warnings first.
        for (i = 0; i < result.warnings.length; i++) {
            html += '<div style="font-size:12px;padding:7px 9px;border-radius:9px;margin-bottom:6px;'
                + 'background:color-mix(in srgb,var(--anas-warn) 14%,transparent);color:var(--anas-warn);'
                + 'display:flex;gap:7px;align-items:flex-start"><span>⚠</span><span>'
                + enc(result.warnings[i]) + '</span></div>';
        }
        for (i = 0; i < lines.length; i++) {
            var tone = lines[i].tone;
            var bg = tone === 'ok' ? 'color-mix(in srgb,var(--anas-ok) 12%,transparent)'
                : (tone === 'warn' ? 'color-mix(in srgb,var(--anas-warn) 12%,transparent)'
                    : (tone === 'danger' ? 'color-mix(in srgb,var(--anas-danger) 12%,transparent)'
                        : 'var(--anas-slot)'));
            var fg = tone === 'ok' ? 'var(--anas-ok)'
                : (tone === 'warn' ? 'var(--anas-warn)'
                    : (tone === 'danger' ? 'var(--anas-danger)' : 'var(--anas-ink)'));
            var glyph = tone === 'ok' ? '✓'
                : (tone === 'warn' ? '⚠' : (tone === 'danger' ? '⛔' : 'ℹ'));
            html += '<div style="font-size:12px;padding:7px 9px;border-radius:9px;margin-bottom:6px;'
                + 'background:' + bg + ';color:' + fg + ';display:flex;gap:7px;align-items:flex-start">'
                + '<span>' + glyph + '</span><span>' + enc(lines[i].text) + '</span></div>';
        }
        el.innerHTML = html;
    }

    // Full re-render + rewire after any state change.
    function refresh(state) {
        try {
            var result = validate(state);
            renderAvail(state);
            renderRacks(state);
            renderSummary(state, result);
            renderAdvisor(state, result);
            if (state.createBtn) {
                state.createBtn.setDisabled(!result.valid);
            }
            wireDynamic(state);
        } catch (e) {
            ANAS.warn('composer refresh failed: ' + ANAS.errText(e));
        }
    }

    // Wire drag on every disk card + the click handlers on unassign / delvdev /
    // inline type selects. Re-run after every refresh (innerHTML replaced).
    function wireDynamic(state) {
        var root = state.root;
        // Drag: every draggable disk card (available list + inside bays).
        var cards = root.querySelectorAll('.anas-composer-disk');
        var c;
        for (c = 0; c < cards.length; c++) {
            ANAS.gfx.drag(cards[c], {
                zoneSelector: '[data-anas-zone]',
                getId: function (elm) { return elm.getAttribute('data-id'); },
                onDrop: function (id, zoneEl) {
                    var zone = zoneEl.getAttribute('data-anas-zone');
                    if (zone === 'available') {
                        moveDisk(state, id, null);
                    } else if (zone.indexOf('vdev:') === 0) {
                        moveDisk(state, id, zone.slice(5));
                    }
                    refresh(state);
                },
            });
        }
        // Unassign buttons (return a disk to Available).
        var unbtns = root.querySelectorAll('[data-unassign]');
        var u;
        for (u = 0; u < unbtns.length; u++) {
            (function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    moveDisk(state, btn.getAttribute('data-unassign'), null);
                    refresh(state);
                });
                // Don't let a click on the remove control start a drag.
                btn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
            })(unbtns[u]);
        }
        // Remove-vdev buttons.
        var del = root.querySelectorAll('[data-delvdev]');
        var dd;
        for (dd = 0; dd < del.length; dd++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    removeVdev(state, btn.getAttribute('data-delvdev'));
                    refresh(state);
                });
            })(del[dd]);
        }
        // Inline bay type selects.
        var sels = root.querySelectorAll('[data-vtype]');
        var s;
        for (s = 0; s < sels.length; s++) {
            (function (sel) {
                sel.addEventListener('change', function () {
                    var v = vdevById(state, sel.getAttribute('data-vtype'));
                    if (v) {
                        v.type = sel.value;
                    }
                    refresh(state);
                });
            })(sels[s]);
        }
    }

    // Build the (static-shell) composer HTML. Dynamic regions are filled by refresh.
    function composerHtml(state) {
        var poolField;
        if (state.mode === 'expand') {
            poolField = '<span style="font-weight:650;color:var(--anas-ink)">' + enc(state.poolName) + '</span>'
                + '<span style="color:var(--anas-muted);font-size:11px;margin-left:6px">'
                + enc(t('(expanding — add new vdevs)')) + '</span>';
        } else {
            poolField = '<input type="text" class="anas-fld-composer-poolname" id="anasc-poolname"'
                + ' value="' + enc(state.name) + '" spellcheck="false"'
                + ' style="font:inherit;color:var(--anas-ink);padding:5px 8px;border-radius:8px;'
                + 'border:1px solid var(--anas-card-edge);background:linear-gradient(var(--anas-card-top),'
                + 'var(--anas-card-bot));outline:none;width:180px">';
        }

        // Role options (create). Expand stages data vdevs only.
        var roleOpts = '';
        var ri;
        if (state.mode === 'expand') {
            roleOpts = '<option value="data">' + enc(roleLabel('data')) + '</option>';
        } else {
            for (ri = 0; ri < CREATE_ROLE_ORDER.length; ri++) {
                var rk = CREATE_ROLE_ORDER[ri];
                roleOpts += '<option value="' + rk + '">' + enc(roleLabel(rk)) + '</option>';
            }
        }
        var typeOpts = '';
        for (var i = 0; i < DATA_TYPES.length; i++) {
            typeOpts += '<option value="' + DATA_TYPES[i] + '">' + enc(TYPES[DATA_TYPES[i]].label) + '</option>';
        }
        var selStyle = 'font:inherit;padding:5px 7px;border-radius:8px;border:1px solid var(--anas-card-edge);'
            + 'background:var(--anas-slot);color:var(--anas-ink)';

        return '<div class="anas-composer" style="padding:16px;color:var(--anas-ink);'
            + 'font:13px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'

            + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">'
            + '<span style="' + SEC + ';margin:0">' + enc(t('Pool')) + '</span>' + poolField
            + '<span style="flex:1"></span>'
            + '<span style="' + PILL + '">' + enc(t('Draft — nothing is created until you commit.')) + '</span></div>'

            + '<div style="display:grid;grid-template-columns:280px minmax(360px,1fr) 272px;gap:14px;align-items:start">'

            // Available disks
            + '<div style="' + CARD + '">'
            + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
            + '<span style="' + SEC + ';margin:0">' + enc(t('Available disks')) + '</span>'
            + '<span id="anasc-availcount" style="color:var(--anas-muted);font-size:12px;margin-left:auto"></span></div>'
            + '<p style="color:var(--anas-muted);font-size:11.5px;margin:0 0 8px">'
            + enc(t('Drag a disk onto a vdev bay. Drop it back here to unassign.')) + '</p>'
            + '<div id="anasc-avail" class="anas-grid-composer-avail" data-anas-zone="available"'
            + ' style="display:flex;flex-direction:column;min-height:60px;border-radius:11px;padding:2px"></div></div>'

            // Topology (draft)
            + '<div style="' + CARD + '">'
            + '<span style="' + SEC + '">' + enc(t('Pool topology (draft)')) + '</span>'
            + '<div id="anasc-racks"></div>'
            + '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px;'
            + 'border:1px dashed var(--anas-card-edge);border-radius:11px;background:var(--anas-slot)">'
            + '<span style="color:var(--anas-muted);font-size:12px">' + enc(t('Add vdev:')) + '</span>'
            + '<select class="anas-fld-composer-role" id="anasc-role" title="' + enc(t('What this vdev does in the pool')) + '"'
            + ' style="' + selStyle + '">' + roleOpts + '</select>'
            + '<select class="anas-fld-composer-type" id="anasc-type" title="' + enc(t('Redundancy layout')) + '"'
            + ' style="' + selStyle + '">' + typeOpts + '</select>'
            + '<button type="button" class="anas-btn-composer-addvdev" id="anasc-addvdev"'
            + ' style="font:inherit;color:var(--anas-ink);cursor:pointer;padding:6px 12px;border-radius:8px;'
            + 'border:1px solid var(--anas-card-edge);'
            + 'background:linear-gradient(var(--anas-card-top),var(--anas-card-bot));'
            + 'box-shadow:var(--anas-shadow)">+ ' + enc(t('Add vdev')) + '</button></div></div>'

            // Summary + advisor
            + '<div style="display:flex;flex-direction:column;gap:14px">'
            + '<div id="anasc-summary" class="anas-composer-summary" style="' + CARD + '"></div>'
            + '<div id="anasc-advisor" class="anas-composer-advisor" style="' + CARD + '"></div></div>'

            + '</div></div>';
    }

    // One-time <style> for the empty-bay pulse (scoped; injected once).
    function ensureComposerStyle() {
        try {
            if (document.getElementById('anas-composer-style')) {
                return;
            }
            var css = '@keyframes anasComposerGlow{0%,100%{border-color:var(--anas-card-edge)}'
                + '50%{border-color:var(--anas-accent)}}';
            var style = document.createElement('style');
            style.id = 'anas-composer-style';
            style.type = 'text/css';
            style.appendChild(document.createTextNode(css));
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {
            // non-fatal — the pulse is cosmetic
        }
    }

    // Wire the static controls (poolname, role/type selects, add-vdev button).
    function wireStatic(state) {
        var root = state.root;
        var nameInput = root.querySelector('#anasc-poolname');
        if (nameInput) {
            nameInput.addEventListener('input', function () {
                state.name = nameInput.value;
                var r = validate(state);
                renderSummary(state, r);
                renderAdvisor(state, r);
                if (state.createBtn) {
                    state.createBtn.setDisabled(!r.valid);
                }
            });
        }
        var roleSel = root.querySelector('#anasc-role');
        var typeSel = root.querySelector('#anasc-type');
        // In create mode, cache/spare roles are individual disks — disable the
        // type selector for them; log/special constrain to redundant types.
        function syncTypeChoices() {
            if (!roleSel || !typeSel) {
                return;
            }
            var role = roleSel.value;
            var meta = ROLES[role] || {};
            var choices = meta.redundantRequired ? REDUNDANT_TYPES : DATA_TYPES;
            typeSel.disabled = !!meta.individual;
            if (meta.individual) {
                typeSel.innerHTML = '<option value="stripe">' + enc(t('individual disks')) + '</option>';
            } else {
                var html = '';
                for (var i = 0; i < choices.length; i++) {
                    html += '<option value="' + choices[i] + '">' + enc(TYPES[choices[i]].label) + '</option>';
                }
                typeSel.innerHTML = html;
            }
        }
        if (roleSel) {
            roleSel.addEventListener('change', syncTypeChoices);
        }
        var addBtn = root.querySelector('#anasc-addvdev');
        if (addBtn) {
            addBtn.addEventListener('click', function () {
                var role = roleSel ? roleSel.value : 'data';
                var type = (typeSel && !typeSel.disabled) ? typeSel.value : 'stripe';
                addVdev(state, role, type);
                refresh(state);
            });
        }
    }

    // ======================================================================
    // COMMIT
    // ======================================================================

    function toSpec(v) {
        var disks = [];
        for (var i = 0; i < v.diskIds.length; i++) {
            disks.push(v.diskIds[i]);
        }
        return { type: schemaType(v.type), disks: disks };
    }

    function buildCreateBody(state) {
        var body = { name: state.name, dataVdevs: [] };
        var logVdevs = [];
        var cacheDisks = [];
        var spareDisks = [];
        var i, j, v;
        for (i = 0; i < state.vdevs.length; i++) {
            v = state.vdevs[i];
            if (!v.diskIds.length) {
                continue;
            }
            if (v.role === 'data') {
                body.dataVdevs.push(toSpec(v));
            } else if (v.role === 'log') {
                logVdevs.push(toSpec(v));
            } else if (v.role === 'cache') {
                for (j = 0; j < v.diskIds.length; j++) {
                    cacheDisks.push(v.diskIds[j]);
                }
            } else if (v.role === 'spare') {
                for (j = 0; j < v.diskIds.length; j++) {
                    spareDisks.push(v.diskIds[j]);
                }
            }
            // special/dedup are blocked by validate() in create mode.
        }
        if (logVdevs.length) {
            body.logVdevs = logVdevs;
        }
        if (cacheDisks.length) {
            body.cacheDisks = cacheDisks;
        }
        if (spareDisks.length) {
            body.spareDisks = spareDisks;
        }
        return body;
    }

    function commitCreate(state) {
        var name = state.name;
        ANAS.confirmAndRun({
            node: state.node,
            method: 'post',
            path: '/pools',
            body: buildCreateBody(state),
            view: state.win,
            confirmTitle: 'Create pool',
            confirmIntro: t('Creating this pool needs confirmation:'),
            failTitle: 'Create failed',
            successMsg: t('Pool created') + ': ' + name,
            onComplete: function () {
                if (state.win && !state.win.destroyed && !state.win.destroying) {
                    state.win.close();
                }
                if (state.grid && ANAS.pools && ANAS.pools.reload) {
                    ANAS.pools.reload(state.grid, state.node);
                }
            },
        });
    }

    // Expand: add each staged vdev sequentially (one AddVdevRequest apiece).
    function commitExpand(state) {
        var staged = [];
        for (var i = 0; i < state.vdevs.length; i++) {
            if (state.vdevs[i].diskIds.length) {
                staged.push(state.vdevs[i]);
            }
        }
        var idx = 0;
        function next() {
            if (idx >= staged.length) {
                if (state.win && !state.win.destroyed && !state.win.destroying) {
                    state.win.close();
                }
                if (state.grid && ANAS.pools && ANAS.pools.reload) {
                    ANAS.pools.reload(state.grid, state.node);
                }
                return;
            }
            var v = staged[idx++];
            ANAS.confirmAndRun({
                node: state.node,
                method: 'post',
                path: '/pools/' + encodeURIComponent(state.poolName) + '/vdevs',
                body: { vdev: toSpec(v) },
                view: state.win,
                confirmTitle: 'Add vdev',
                failTitle: 'Add vdev failed',
                successMsg: t('Vdev added to') + ' ' + state.poolName,
                onComplete: next,
            });
        }
        next();
    }

    function commit(state) {
        try {
            if (state.mode === 'expand') {
                commitExpand(state);
            } else {
                commitCreate(state);
            }
        } catch (e) {
            ANAS.warn('composer commit failed: ' + ANAS.errText(e));
        }
    }

    // ======================================================================
    // DATA LOAD + WINDOW
    // ======================================================================

    function loadAvailableDisks(state, done) {
        ANAS.api.get(state.node, '/disks').then(function (res) {
            var all = (res && res.data) || [];
            var avail = [];
            state.diskById = {};
            for (var i = 0; i < all.length; i++) {
                if (all[i].status === 'available') {
                    avail.push(all[i]);
                    state.diskById[all[i].id] = all[i];
                }
            }
            state.disks = avail;
            if (done) {
                done(null);
            }
        }, function (err) {
            ANAS.warn('composer disk load failed: ' + ANAS.errText(err));
            if (done) {
                done(err);
            }
        });
    }

    // Expand: seed the pool's existing vdevs as read-only bays (best-effort).
    function loadExistingTopology(state, done) {
        ANAS.api.get(state.node, '/pools/' + encodeURIComponent(state.poolName)).then(function (res) {
            var d = res && res.data;
            state.existing = [];
            var groups = (d && d.vdevGroups) || [];
            for (var g = 0; g < groups.length; g++) {
                var vdevs = groups[g].vdevs || [];
                for (var v = 0; v < vdevs.length; v++) {
                    state.existing.push({ role: groups[g].role, vdev: vdevs[v] });
                }
            }
            if (done) {
                done(null);
            }
        }, function (err) {
            ANAS.warn('composer topology load failed: ' + ANAS.errText(err));
            if (done) {
                done(err);
            }
        });
    }

    function openComposer(opts) {
        opts = opts || {};
        if (!opts.node) {
            ANAS.warn('composer: no node');
            return;
        }
        if (!gfxReady()) {
            try {
                Ext.Msg.alert(t('Pool Composer'), t('The graphical layer is unavailable.'));
            } catch (e) {
                ANAS.warn('composer: gfx unavailable');
            }
            return;
        }
        ensureComposerStyle();
        var state = makeState(opts);

        // Bound the composer to the ANAS content region (the card our views
        // render into), not the whole viewport — so it fills the right-hand
        // section without covering the PVE node menu / leftmost view.
        // NOTE: must use the DOM element's up() (CSS selector), NOT the
        // component's up() — ComponentQuery has no '.class' selector, so the
        // component form returns null and the window falls back to a cramped
        // fixed width.
        var regionEl = null, rbox = null;
        try {
            var gridEl = opts.grid && opts.grid.getEl ? opts.grid.getEl() : null;
            var cardEl = gridEl && gridEl.up ? gridEl.up('.anas-view-card') : null;
            if (cardEl && cardEl.getBox) {
                regionEl = cardEl;               // an Ext.dom.Element
                rbox = cardEl.getBox();
            }
        } catch (eRegion) { regionEl = null; rbox = null; }

        var win;
        try {
            win = Ext.create('Ext.window.Window', {
                cls: 'anas-view-composer anas-win-composer',
                title: state.mode === 'expand'
                    ? (t('Expand Pool') + ': ' + state.poolName)
                    : t('Create Pool'),
                modal: true,
                // Fill the ANAS content region (right-hand section), not the
                // viewport — sized/positioned to the view card when found, else a
                // large centred fallback. constrain keeps it in bounds.
                x: rbox ? rbox.x : undefined,
                y: rbox ? rbox.y : undefined,
                width: rbox ? rbox.width : 1040,
                height: rbox ? rbox.height : 720,
                minWidth: 720,
                minHeight: 480,
                maximizable: true,
                resizable: true,
                layout: 'fit',
                items: [{
                    xtype: 'panel',
                    itemId: 'composerBody',
                    border: false,
                    scrollable: true,
                    bodyPadding: 0,
                    html: composerHtml(state),
                }],
                buttons: [
                    {
                        text: t('Cancel'),
                        cls: 'anas-btn-composer-cancel',
                        handler: function () {
                            win.close();
                        },
                    },
                    {
                        text: state.mode === 'expand' ? t('Add vdevs') : t('Create pool'),
                        cls: 'anas-btn-composer-create',
                        itemId: 'composerCreateBtn',
                        disabled: true,
                        handler: function () {
                            commit(state);
                        },
                    },
                ],
                listeners: {
                    afterrender: function (w) {
                        try {
                            var bodyPanel = w.down('#composerBody');
                            state.win = w;
                            state.createBtn = w.down('#composerCreateBtn');
                            state.root = bodyPanel && bodyPanel.getEl() ? bodyPanel.getEl().dom : null;
                            if (!state.root) {
                                return;
                            }
                            wireStatic(state);
                            refresh(state);
                        } catch (e) {
                            ANAS.warn('composer wiring failed: ' + ANAS.errText(e));
                        }
                    },
                },
            });
        } catch (e) {
            ANAS.warn('composer window failed: ' + ANAS.errText(e));
            return;
        }

        win.show();
        // Keep the composer filling the content region as the browser resizes.
        if (regionEl) {
            var refit = function () {
                try {
                    if (win.destroyed || win.destroying) { return; }
                    var b = regionEl.getBox();
                    win.setBox({ x: b.x, y: b.y, width: b.width, height: b.height });
                } catch (eFit) { /* non-fatal */ }
            };
            Ext.on('resize', refit);
            win.on('destroy', function () { try { Ext.un('resize', refit); } catch (eU) { /* non-fatal */ } });
        }
        try {
            win.setLoading(true);
        } catch (e2) {
            // non-fatal
        }

        function afterLoad() {
            if (win.destroyed || win.destroying) {
                return;
            }
            try {
                win.setLoading(false);
            } catch (e3) {
                // non-fatal
            }
            if (state.root) {
                refresh(state);
            }
        }

        if (state.mode === 'expand') {
            loadExistingTopology(state, function () {
                loadAvailableDisks(state, afterLoad);
            });
        } else {
            loadAvailableDisks(state, afterLoad);
        }
    }

    // Public surface. Launched from the Pools "Create" toolbar action (create),
    // or programmatically for expand:
    //   ANAS.composer.open({ node, grid, mode:'create' })
    //   ANAS.composer.open({ node, grid, mode:'expand', poolName })
    // TODO(expand): the Pools toolbar still uses the dedicated Add-Vdev window
    // (34-pool-addvdev.js). A future story can rewire an "Expand" action to
    // ANAS.composer.open({ mode:'expand', ... }); the code path is implemented
    // and functional here (add-vdev API carries no role, so it stages DATA vdevs).
    ANAS.composer = ANAS.composer || {};
    ANAS.composer.open = function (o) {
        try {
            openComposer(o);
        } catch (e) {
            ANAS.warn('composer open failed: ' + ANAS.errText(e));
        }
    };
})();
